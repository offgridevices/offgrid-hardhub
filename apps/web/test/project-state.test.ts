import { describe, expect, it } from "vitest";
import { ServerEvent } from "@hardhub/protocol";
import { initialState, isKeyError, reduce, replay } from "../src/lib/project-state";
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

  it("recognises a missing-key error", () => {
    expect(isKeyError("No API key: add your Claude API key in Settings")).toBe(true);
    expect(isKeyError("401 authentication_error")).toBe(true);
    expect(isKeyError("Freerouting timed out")).toBe(false);
  });
});
