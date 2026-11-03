// The board tests: run from the app (POST /projects/:id/tests) and by the AI
// (run_tests, test_report), streamed live as test_run events, over the real
// routes and rooms with the engine faked.
import { Design, ServerEvent, TestRunResult } from "@hardhub/protocol";
import { beforeEach, describe, expect, it } from "vitest";
import { app } from "../src/http";
import { TOOLS, filterReport, summarizeChecks } from "../src/agent/tools";
import { type TestEnv, testEnv } from "./support/env";
import { FakeEngine } from "./support/room";

let env: TestEnv;
let engine: FakeEngine;

beforeEach(() => {
  engine = new FakeEngine();
  env = testEnv(engine);
});

const call = (path: string, init: RequestInit & { token?: string } = {}) => {
  const headers = new Headers(init.headers);
  if (init.token) headers.set("authorization", `Bearer ${init.token}`);
  if (init.body) headers.set("content-type", "application/json");
  return app.request(path, { ...init, headers }, env);
};

async function signIn(email = "maker@example.com") {
  const r = await call("/auth/signup", { method: "POST", body: JSON.stringify({ email, password: "correct horse battery" }) });
  return ((await r.json()) as { token: string }).token;
}

async function project(token: string, build = true) {
  const p = (await (await call("/projects", { method: "POST", token, body: JSON.stringify({ name: "Sensor" }) })).json()) as { id: string };
  const core = env.ROOMS.core(p.id);
  const d = core.design().design;
  core.saveDesign(Design.parse({ ...d, board: { width: 50, height: 40, layers: 2 } }), "Board set");
  if (build) expect((await env.ROOMS.get(p.id).agentTool("build_board", {})).isError).toBeFalsy();
  return { id: p.id, core };
}

const run = (id: string, body: unknown, token?: string) => call(`/projects/${id}/tests`, { method: "POST", body: JSON.stringify(body), ...(token ? { token } : {}) });

describe("POST /projects/:id/tests", () => {
  it("runs the tests on the last built board, live, and stores the results and report", async () => {
    const token = await signIn();
    const { id, core } = await project(token);
    const before = core.lastSeq();
    const r = await run(id, { ambient_min: -20, ambient_max: 60 }, token);
    expect(r.status).toBe(200);
    const body = TestRunResult.parse(await r.json());
    expect(body.ok).toBe(false);
    expect(body.summary).toBe("1 pass, 1 to fix, 0 to look at");
    // the engine got the board's KiCad zip and the temperatures
    expect(engine.tests).toHaveLength(1);
    expect(engine.tests[0]!.zip).toBeGreaterThan(0);
    expect(engine.tests[0]!.options).toEqual({ ambient_min: -20, ambient_max: 60 });

    const stored = core.events(before, 1000).events;
    const runs = stored.filter((e) => e.type === "test_run");
    expect(runs.map((e) => e.type === "test_run" && e.phase)).toEqual(["start", "done"]);
    const start = runs[0]!;
    expect(start.type === "test_run" && start.plan?.map((p) => p.id)).toEqual(["shorts", "heat-board"]);
    expect(stored.find((e) => e.type === "checks")).toBeTruthy();
    expect(stored.some((e) => e.type === "artifacts" && e.artifacts.some((a) => a.kind === "report"))).toBe(true);

    // each finished test went out live, not stored, carrying the last stored seq
    const live = env.ROOMS.frames(id)
      .map((f) => ServerEvent.parse(JSON.parse(f)))
      .filter((e) => e.type === "test_run" && e.phase === "check");
    expect(live.map((e) => e.type === "test_run" && e.result?.id).filter(Boolean)).toEqual(["shorts", "heat-board"]);
    expect(live.every((e) => e.type === "test_run" && e.live)).toBe(true);
    expect(stored.some((e) => e.type === "test_run" && e.phase === "check")).toBe(false);
  });

  it("is refused before there is a board, and for someone else's project", async () => {
    const a = await signIn("a@example.com");
    const b = await signIn("b@example.com");
    const { id } = await project(a, false);
    expect((await run(id, {}, a)).status).toBe(409);
    expect((await run(id, {}, b)).status).toBe(404);
    expect((await run(id, {})).status).toBe(401);
    expect((await run(id, { ambient_max: 900 }, a)).status).toBe(400);
  });
});

describe("run_tests and test_report (the AI's tools)", () => {
  it("runs the tests for a connected agent and reads back the report", async () => {
    const token = await signIn();
    const { id } = await project(token);
    const room = env.ROOMS.get(id);
    const r = await room.agentTool("run_tests", { ambient_max: 40 });
    expect(r.content).toMatch(/Board tests at the design's to 40 °C: 1 pass, 1 to fix/);
    expect(r.content).toMatch(/FAIL Board below 105 °C \[heat-board\]: 118 °C\. Fix: spread the heat/);
    // the build placed U1 itself and saved that: the board is still current
    expect(r.content).not.toMatch(/design changed/);
    const rep = await room.agentTool("test_report", {});
    expect(rep.isError).toBeFalsy();
    expect(rep.content).toMatch(/To fix before ordering/);
    expect(rep.content).not.toMatch(/## Passed/);
    const heat = await room.agentTool("test_report", { only: "thermal" });
    expect(heat.content).toMatch(/heat-board/);
    // the build's files are still there for get_files, with the report beside them
    const { artifacts } = await room.agentResults();
    expect(artifacts.map((a) => a.kind).sort()).toEqual(["board-png", "glb", "kicad", "report", "report"]);
  });

  it("a build relays its test step as a live test run", async () => {
    const token = await signIn();
    const { id, core } = await project(token, false);
    // a fake build whose engine streams a test step like the real one
    engine.build = async function* (_d, job) {
      yield { step: "test", progress: 0.7, message: "Planning 1 test", plan: [{ id: "shorts", group: "connections", name: "No shorts" }] };
      yield { step: "test", progress: 0.8, message: "Measuring", result: { id: "shorts", group: "connections", name: "No shorts", why: "w", status: "pass" } };
      yield {
        done: true, ok: true, stats: {}, placement: {},
        checks: [{ id: "shorts", group: "connections", name: "No shorts", why: "w", status: "pass" }],
        artifacts: [{ kind: "kicad", name: "b-kicad.zip", url: `/jobs/${job}/files/b-kicad.zip` }, { kind: "report", name: "b-tests.md", url: `/jobs/${job}/files/b-tests.md` }],
      };
    };
    expect((await env.ROOMS.get(id).agentTool("build_board", {})).isError).toBeFalsy();
    const runs = core.events(-1, 1000).events.filter((e) => e.type === "test_run");
    expect(runs.map((e) => e.type === "test_run" && e.phase)).toEqual(["start", "done"]);
    expect(runs[1]!.type === "test_run" && runs[1]!.ok).toBe(true);
    // the test step is not shown as a build step
    expect(core.events(-1, 1000).events.some((e) => e.type === "job" && e.step === "test")).toBe(false);
  });

  it("are offered to connected agents", () => {
    expect(TOOLS.run_tests.schema.safeParse({ ambient_min: -40, ambient_max: 85 }).success).toBe(true);
    expect(TOOLS.run_tests.schema.safeParse({ ambient_max: 500 }).success).toBe(false);
  });
});

describe("what the AI reads", () => {
  it("lists failures first with where and the fix", () => {
    const s = summarizeChecks([
      { id: "a", group: "copper", name: "Corners", why: "w", status: "warn", detail: "2 sharp" },
      { id: "b", group: "connections", name: "No shorts", why: "w", status: "fail", detail: "GND and +3V3", fix: "move the via", where: [{ x: 1.25, y: -3, refs: ["U1"] }] },
      { id: "c", group: "fab", name: "DRC", why: "w", status: "pass" },
      { id: "d", group: "signals", name: "USB", why: "w", status: "na" },
    ]);
    expect(s.split("\n")).toEqual([
      "Checks: 1 pass, 1 fail, 1 warn, 0 skipped, 1 do not apply.",
      "FAIL No shorts [b]: GND and +3V3. At (1.3, -3.0) U1. Fix: move the via",
      "WARN Corners [a]: 2 sharp.",
    ]);
  });

  it("cuts the report to an area", () => {
    const md = "# T\n\nhead\n\n## To fix before ordering (1)\n\n### Shorts (Connections, `shorts`)\n- Found: x\n\n### Hot (Heat, `heat-board`)\n- Found: y\n\n## Passed (1)\n\n- ok";
    expect(filterReport(md, "thermal")).toMatch(/Hot \(Heat/);
    expect(filterReport(md, "thermal")).not.toMatch(/Shorts/);
    expect(filterReport(md, "problems")).not.toMatch(/Passed/);
    expect(filterReport(md, "nope")).toMatch(/No area/);
  });
});

describe("a test run always ends", () => {
  it("when the build stops half way, the run is closed for every client", async () => {
    const token = await signIn();
    const { id, core } = await project(token, false);
    engine.build = async function* () {
      yield { step: "test", progress: 0.7, message: "Planning 1 test", plan: [{ id: "shorts", group: "connections", name: "No shorts" }] };
      throw new Error("engine went away");
    };
    await env.ROOMS.get(id).agentTool("build_board", {});
    const runs = core.events(-1, 1000).events.filter((e) => e.type === "test_run");
    expect(runs.map((e) => e.type === "test_run" && e.phase)).toEqual(["start", "done"]);
    expect(runs[1]!.type === "test_run" && runs[1]!.ok).toBe(false);
  });

  it("a connected agent cannot test the old board while its new build runs", async () => {
    const token = await signIn();
    const { id, core } = await project(token);
    // a build queued for the alarm, not yet run
    expect((await core.agentTool("build_board", {})).isError).toBeFalsy();
    const r = await core.agentTool("run_tests", {});
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/wait_for_build/);
    expect(engine.tests).toHaveLength(0);
    void id;
  });
});

describe("a board older than its design", () => {
  it("run_tests says the copper is from an earlier design", async () => {
    const token = await signIn();
    const { id, core } = await project(token);
    const d = core.design().design;
    core.saveDesign({ ...d, summary: "changed after the build" }, "Changed the summary");
    const r = await env.ROOMS.get(id).agentTool("run_tests", {});
    expect(r.content).toMatch(/the design changed after this board was built/);
  });
});

describe("the order files", () => {
  it("are still listed after many test runs", async () => {
    const token = await signIn();
    const { id } = await project(token, false);
    const real = engine.build.bind(engine);
    engine.build = async function* (d, job, signal, stop) {
      for await (const line of real(d, job, signal, stop)) {
        // a full build also makes the Gerbers, as the real engine does
        if ("done" in line) yield { ...line, artifacts: [...line.artifacts, { kind: "gerbers" as const, name: "board-gerbers.zip", url: `/jobs/${job}/files/board-gerbers.zip` }] };
        else yield line;
      }
    };
    expect((await env.ROOMS.get(id).agentTool("build_board", {})).isError).toBeFalsy();
    for (let i = 0; i < 21; i++) expect((await run(id, {}, token)).status).toBe(200);
    const kinds = (await env.ROOMS.get(id).agentResults()).artifacts.map((a) => a.kind);
    expect(kinds).toContain("gerbers");
    expect(kinds).toContain("kicad");
    expect(kinds.filter((k) => k === "report")).toHaveLength(2);
  });
});
