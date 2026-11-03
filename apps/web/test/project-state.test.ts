import { describe, expect, it } from "vitest";
import { ServerEvent } from "@hardhub/protocol";
import { initialState, isKeyError, reduce, replay, testsRunning } from "../src/lib/project-state";
import { isLive } from "../src/lib/api";
import { gardenHistory, hubHistory, type ScriptStep } from "../src/fixtures/script";

const at = "2026-10-28T00:00:00Z";
const stamp = (steps: ScriptStep[]): ServerEvent[] =>
  steps.map(({ delay: _d, ...e }, seq) => ServerEvent.parse({ ...e, seq, at }));

describe("project state", () => {
  it("every scripted demo event is a valid ServerEvent and every type is exercised", () => {
    const events = [...stamp(hubHistory), ...stamp(gardenHistory)];
    const types = new Set(events.map((e) => e.type));
    for (const t of ["user_message", "assistant_text", "thinking", "tool", "questions", "comparison", "design", "stage", "job", "checks", "artifacts", "usage", "turn_end"])
      expect(types, t).toContain(t);
  });

  it("folds a streamed message into one item, finished on its last delta", () => {
    const s = replay(stamp(hubHistory));
    const msgs = s.items.filter((i) => i.kind === "assistant");
    expect(msgs.map((m) => m.id)).toEqual(["a1", "a2"]);
    expect(msgs.every((m) => m.kind === "assistant" && m.done)).toBe(true);
    expect(s.stage).toBe("order");
    expect(s.busy).toBe(false);
    expect(s.usage.cost).toBeCloseTo(1.16);
  });

  it("keeps questions open until the person answers", () => {
    const g = replay(stamp(gardenHistory));
    expect(g.openQuestions).toBe("gq1");
    const answered = reduce(g, ServerEvent.parse({ type: "user_message", id: "x", text: "Answers", answers: { Battery: ["Two AA batteries"] }, seq: 999, at }));
    expect(answered.openQuestions).toBeNull();
    expect(answered.busy).toBe(true);
  });

  it("updates a tool row in place and ignores replayed events", () => {
    let s = reduce(initialState, ServerEvent.parse({ type: "tool", id: "t", name: "x", label: "Searching", status: "running", seq: 0, at }));
    s = reduce(s, ServerEvent.parse({ type: "tool", id: "t", name: "x", label: "Searched", status: "done", seq: 1, at }));
    const again = reduce(s, ServerEvent.parse({ type: "tool", id: "t", name: "x", label: "Old", status: "running", seq: 1, at }));
    expect(again).toBe(s);
    expect(s.items).toHaveLength(1);
    expect(s.items[0]).toMatchObject({ label: "Searched", status: "done" });
  });

  it("merges checks by id and artifacts by name", () => {
    const c = (status: "pass" | "fail", seq: number) =>
      ServerEvent.parse({ type: "checks", results: [{ id: "drc", group: "layout", name: "DRC", why: "fab", status }], seq, at });
    let s = reduce(initialState, c("fail", 0));
    s = reduce(s, c("pass", 1));
    expect(s.checks).toHaveLength(1);
    expect(s.checks[0]!.status).toBe("pass");
  });

  it("lets a newer build's files replace the older ones of the same name", () => {
    const art = (name: string, seq: number) => ServerEvent.parse({ type: "artifacts", artifacts: [{ kind: "board-json", name, url: `/projects/p/files/${name}` }], seq, at });
    let s = reduce(initialState, art("b1-hub-board.json", 0));
    s = reduce(s, art("b2-hub-board.json", 1));
    expect(s.artifacts.map((a) => a.name)).toEqual(["b2-hub-board.json"]);
  });

  it("appends live deltas without advancing seq, then takes the stored whole text", () => {
    let s = reduce(initialState, ServerEvent.parse({ type: "stage", stage: "idea", seq: 0, at }));
    s = reduce(s, ServerEvent.parse({ type: "assistant_text", id: "a", text: "Hel", done: false, seq: 0, at }));
    s = reduce(s, ServerEvent.parse({ type: "assistant_text", id: "a", text: "lo", done: false, seq: 0, at }));
    expect(s.items).toEqual([{ kind: "assistant", id: "a", text: "Hello", done: false }]);
    expect(s.lastSeq).toBe(0);
    s = reduce(s, ServerEvent.parse({ type: "assistant_text", id: "a", text: "Hello.", done: true, seq: 1, at }));
    expect(s.items).toEqual([{ kind: "assistant", id: "a", text: "Hello.", done: true }]);
    // a late delta after the whole text changes nothing
    expect(reduce(s, ServerEvent.parse({ type: "assistant_text", id: "a", text: "x", done: false, seq: 1, at }))).toBe(s);
  });

  it("closes an unfinished stream when the turn ends", () => {
    let s = reduce(initialState, ServerEvent.parse({ type: "assistant_text", id: "a", text: "Half", done: false, seq: 0, at }));
    s = reduce(s, ServerEvent.parse({ type: "turn_end", reason: "stopped", seq: 1, at }));
    expect(s.items[0]).toMatchObject({ done: true });
    expect(s.busy).toBe(false);
  });

  describe("a test run", () => {
    const plan = [
      { id: "track-min", group: "copper", name: "Narrowest track" },
      { id: "heat-board", group: "thermal", name: "Board below 105 °C" },
    ];
    const result = (id: string, status: "pass" | "fail") => ({ id, group: plan.find((p) => p.id === id)!.group, name: id, why: "w", status });
    const ev = (e: Record<string, unknown>, seq: number) => ServerEvent.parse({ type: "test_run", run: "r1", ...e, seq, at });

    it("opens with its plan, folds live results without storing them, and ends", () => {
      let s = reduce(initialState, ServerEvent.parse({ type: "stage", stage: "checks", seq: 0, at }));
      s = reduce(s, ev({ phase: "start", label: "Measuring every track", progress: 0, plan }, 1));
      expect(testsRunning(s)).toBe(true);
      expect(s.testRun).toMatchObject({ run: "r1", phase: "start", plan, results: {} });
      expect(s.items.at(-1)).toMatchObject({ kind: "tests", id: "r1", total: 2, done: false });

      // a live result carries the last stored seq: it must not be dropped as a duplicate
      const live = ev({ phase: "check", live: true, result: result("track-min", "pass"), progress: 0.5, label: "Simulating heat at 50 °C" }, 1);
      expect(isLive(live)).toBe(true);
      s = reduce(s, live);
      expect(s.lastSeq).toBe(1);
      expect(Object.keys(s.testRun!.results)).toEqual(["track-min"]);
      expect(s.testRun!.label).toBe("Simulating heat at 50 °C");
      expect(s.items.at(-1)).toMatchObject({ kind: "tests", progress: 0.5, label: "Simulating heat at 50 °C" });

      s = reduce(s, ev({ phase: "check", live: true, result: result("heat-board", "fail"), progress: 1 }, 1));
      s = reduce(s, ev({ phase: "done", ok: false, summary: "2 tests: 1 to fix, 1 passed" }, 2));
      expect(testsRunning(s)).toBe(false);
      expect(s.testRun).toMatchObject({ phase: "done", ok: false, progress: 1 });
      expect(s.items.at(-1)).toMatchObject({ kind: "tests", done: true, ok: false, summary: "2 tests: 1 to fix, 1 passed" });
      // a late live line changes nothing once the run is done
      expect(reduce(s, ev({ phase: "check", live: true, result: result("track-min", "fail") }, 2))).toBe(s);
    });

    it("replaces the checks with the run's full results, then merges again", () => {
      let s = reduce(initialState, ServerEvent.parse({ type: "checks", results: [{ id: "drc", group: "layout", name: "DRC", why: "fab", status: "pass" }], seq: 0, at }));
      s = reduce(s, ev({ phase: "start", plan }, 1));
      s = reduce(s, ev({ phase: "done", ok: true }, 2));
      s = reduce(s, ServerEvent.parse({ type: "checks", results: plan.map((p) => result(p.id, "pass")), seq: 3, at }));
      expect(s.checks.map((c) => c.id)).toEqual(["track-min", "heat-board"]);
      // a later build's results merge as before
      s = reduce(s, ServerEvent.parse({ type: "checks", results: [result("track-min", "fail")], seq: 4, at }));
      expect(s.checks).toHaveLength(2);
      expect(s.checks[0]!.status).toBe("fail");
    });

    it("ignores live results for a run it never saw start, and replays a stored run as done", () => {
      expect(reduce(initialState, ev({ phase: "check", live: true, result: result("track-min", "pass") }, 0))).toBe(initialState);
      const s = replay([ev({ phase: "start", plan }, 0), ev({ phase: "done", ok: true, summary: "ok" }, 1)]);
      expect(testsRunning(s)).toBe(false);
      expect(s.items.filter((i) => i.kind === "tests")).toHaveLength(1);
    });
  });

  it("recognises a missing-key error", () => {
    expect(isKeyError("No API key: add your Claude API key in Settings")).toBe(true);
    expect(isKeyError("401 authentication_error")).toBe(true);
    expect(isKeyError("Freerouting timed out")).toBe(false);
  });
});
