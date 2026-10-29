// The person's hand edits to a routed board: POST /projects/:id/board/edits over
// the real routes and rooms, with the engine faked; and what the AI hears of them.
import { BoardEditResult, Design, type ServerEvent } from "@hardhub/protocol";
import { beforeEach, describe, expect, it } from "vitest";
import { app } from "../src/http";
import { describeEdits } from "../src/room/core";
import { scriptedAnthropic } from "./support/fake-llm";
import { type TestEnv, testEnv } from "./support/env";
import { FakeEngine, makeRoom } from "./support/room";

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

const EDITS = {
  edits: [
    { op: "set_track", id: "t-1", a: [10, 10], b: [12, 10] },
    { op: "set_track", id: "t-2", a: [12, 10], b: [12, 14], width: 0.3 },
    { op: "set_via", id: "v-1", x: 12, y: 14 },
    { op: "move_part", ref: "R1", x: 30, y: 25, rot: 90 },
  ],
  note: "Shortened the LED track",
};

/** a project with a board built once, as build_board leaves it */
async function builtProject(token: string) {
  const p = (await (await call("/projects", { method: "POST", token, body: JSON.stringify({ name: "Sensor" }) })).json()) as { id: string };
  const core = env.ROOMS.core(p.id);
  const d = core.design().design;
  core.saveDesign(Design.parse({ ...d, board: { width: 50, height: 40, layers: 2 } }), "Board set");
  const r = await env.ROOMS.get(p.id).agentTool("build_board", {});
  expect(r.isError).toBeFalsy();
  return { id: p.id, core };
}

const post = (id: string, body: unknown, token?: string) => call(`/projects/${id}/board/edits`, { method: "POST", body: JSON.stringify(body), ...(token ? { token } : {}) });
const stored = (core: ReturnType<TestEnv["ROOMS"]["core"]>) => core.events(-1, 1000).events;

describe("POST /projects/:id/board/edits", () => {
  it("is for the signed-in owner only", async () => {
    const a = await signIn("a@example.com");
    const b = await signIn("b@example.com");
    const { id } = await builtProject(a);
    expect((await post(id, EDITS)).status).toBe(401);
    expect((await post(id, EDITS, b)).status).toBe(404);
    expect(engine.edits).toEqual([]);
  });

  it("applies the edits to the last build, stores everything a build would, and says what changed", async () => {
    const token = await signIn();
    const { id, core } = await builtProject(token);
    const before = stored(core).length;
    const r = await post(id, EDITS, token);
    expect(r.status).toBe(200);
    const res = BoardEditResult.parse(await r.json());
    expect(res.ok).toBe(true);
    expect(res.summary).toBe("You moved 2 tracks, 1 via and 1 part by hand · checks: 0 problems");
    expect(res.checks.map((c) => c.id)).toEqual(["drc-errors"]);

    // the engine got the last build's KiCad zip, under a job of this project's own
    expect(engine.edits).toHaveLength(1);
    expect(engine.edits[0]!.job).toBe(`${id}-b2`);
    expect(engine.edits[0]!.zip).toBe(3);
    expect(engine.edits[0]!.edits).toEqual(EDITS.edits);

    const evs = stored(core).slice(before);
    expect(evs.map((e) => (e.type === "job" ? `job:${e.step}` : e.type))).toEqual(["job:validate", "job:drc", "job:done", "checks", "artifacts", "design", "board_edit"]);
    const arts = evs.find((e) => e.type === "artifacts") as Extract<ServerEvent, { type: "artifacts" }>;
    expect(arts.artifacts.map((a) => [a.kind, a.url])).toEqual([
      ["board-json", `/projects/${id}/files/b2-board-board.json`],
      ["kicad", `/projects/${id}/files/b2-board-kicad.zip`],
      ["package", `/projects/${id}/files/b2-board-package.zip`],
    ]);
    expect(env.FILES.objs.has(`projects/${id}/b2-board-board.json`)).toBe(true);
    const edit = evs.at(-1) as Extract<ServerEvent, { type: "board_edit" }>;
    expect(edit).toMatchObject({ type: "board_edit", summary: res.summary, edits: 4, ok: true });

    // the moved part is in the design now, locked, in the design's own frame
    expect(core.design().design.placement.R1).toEqual({ x: 5, y: 5, rot: 90, side: "top", locked: true });

    // the next look at the board is at the edited one
    await env.ROOMS.get(id).agentTool("inspect_board", { what: ["parts"] });
    const second = await post(id, { edits: [{ op: "delete", id: "t-9" }] }, token);
    expect(((await second.json()) as { summary: string }).summary).toBe("You deleted 1 track by hand · checks: 0 problems");
    expect(engine.edits[1]!.job).toBe(`${id}-b3`);
  });

  it("refuses while the AI or a build is working, and before there is a board", async () => {
    const token = await signIn();
    const p = (await (await call("/projects", { method: "POST", token, body: "{}" })).json()) as { id: string };
    const none = await post(p.id, EDITS, token);
    expect(none.status).toBe(409);
    expect(((await none.json()) as { error: string }).error).toContain("build it first");

    const { id, core } = await builtProject(token);
    core.queue({ text: "make it smaller" }); // a turn waiting to run
    const busy = await post(id, EDITS, token);
    expect(busy.status).toBe(409);
    expect(((await busy.json()) as { error: string }).error).toContain("AI is working");
    await env.ROOMS.core(id).runQueued(); // the turn ends (no AI in these tests)

    // while an edit is being checked, a second edit, the chat and connected agents wait
    let release!: () => void;
    engine.hold = new Promise((r) => (release = r));
    const first = post(id, EDITS, token);
    while (!core.editing) await new Promise((r) => setTimeout(r, 1));
    const second = await post(id, EDITS, token);
    expect(second.status).toBe(409);
    expect(((await second.json()) as { error: string }).error).toContain("still being checked");
    expect(core.accept({ text: "hello" })).toBe(false);
    expect((await env.ROOMS.get(id).agentTool("get_design", {})).content).toContain("editing the board by hand");
    expect(((await (await call(`/projects/${id}`, { token })).json()) as { busy: boolean }).busy).toBe(true);
    release();
    expect((await first).status).toBe(200);
    expect(core.editing).toBe(false);
    expect(engine.edits).toHaveLength(1);
  });

  it("says plainly what the engine could not apply, and keeps nothing", async () => {
    const token = await signIn();
    const { id, core } = await builtProject(token);
    const before = stored(core).length;
    engine.reject = "edit 1 (set_track): no track with id t-1 on the board";
    const r = await post(id, EDITS, token);
    expect(r.status).toBe(422);
    expect(await r.json()).toEqual({ error: "edit 1 (set_track): no track with id t-1 on the board" });
    expect(stored(core).slice(before).map((e) => e.type)).toEqual(["job", "job"]);
    expect(core.design().design.placement.R1).toBeUndefined();
    // a later build is not held back by edits that never happened
    expect((await env.ROOMS.get(id).agentTool("build_board", {})).isError).toBeFalsy();
  });

  it("checks the request", async () => {
    const token = await signIn();
    const { id } = await builtProject(token);
    for (const bad of [{ edits: [] }, { edits: [{ op: "explode" }] }, { edits: [{ op: "add_track", layer: "F.Silkscreen", a: [0, 0], b: [1, 1] }] }, { ...EDITS, note: "x".repeat(301) }])
      expect((await post(id, bad, token)).status).toBe(400);
    expect(engine.edits).toEqual([]);
  });
});

describe("the AI and hand edits", () => {
  it("a connected agent hears of them on its next call, and must ask before re-routing", async () => {
    const token = await signIn();
    const { id } = await builtProject(token);
    expect((await post(id, EDITS, token)).status).toBe(200);
    const room = env.ROOMS.get(id);
    const look = await room.agentTool("get_design", { sections: ["name"] });
    expect(look.content).toMatch(/^The person edited the board by hand: moved 2 tracks, 1 via and 1 part \(checks after: 0 problems\)\. They said: "Shortened the LED track"/);
    expect((await room.agentTool("get_design", { sections: ["name"] })).content).not.toContain("by hand"); // told once

    const builds = engine.builds.length;
    const refused = await room.agentTool("build_board", {});
    expect(refused.isError).toBe(true);
    expect(refused.content).toContain("discard_hand_edits: true");
    expect(engine.builds.length).toBe(builds);
    // a placement check that stops before the files leaves the edited board alone
    expect((await room.agentTool("build_board", { stop_after: "place" })).isError).toBeFalsy();
    expect((await room.agentTool("build_board", { discard_hand_edits: true })).isError).toBeFalsy();
    // the new build replaced the edited board: nothing left to lose
    expect((await room.agentTool("build_board", {})).isError).toBeFalsy();
  });

  it("the built-in AI gets them as a note before the person's next message", async () => {
    const fake = scriptedAnthropic([[{ tool: "build_board", input: {} }], [{ text: "Asking first." }], [{ text: "You're welcome." }]]);
    const room = makeRoom(fake.llm);
    room.core.saveDesign(Design.parse({ ...room.core.design().design, board: { width: 50, height: 40, layers: 2 } }), "Board set");
    expect((await room.core.agentTool("build_board", {})).isError).toBeFalsy();
    await room.core.runAgentBuild();
    const r = await room.core.editBoard({ edits: [{ op: "add_via", x: 3, y: 4, net: "GND" }] });
    expect(r.status).toBe(200);
    await room.core.message({ text: "Looks good, order it" });
    const first = fake.rec.bodies[0]!.messages as { role: string; content: { type: string; text?: string }[] | string }[];
    const said = JSON.stringify(first.at(-1)!.content);
    expect(said).toContain("The person edited the board by hand: added 1 via");
    expect(said).toContain("Looks good, order it");
    // the person's own message shows as they wrote it
    const msg = room.stored().filter((e) => e.type === "user_message").at(-1) as Extract<ServerEvent, { type: "user_message" }>;
    expect(msg.text).toBe("Looks good, order it");
    // the model's build_board was refused with the reason, so it asks
    const second = JSON.stringify(fake.rec.bodies[1]!.messages);
    expect(second).toContain("Not built: the person edited this board by hand");
    // told once
    await room.core.message({ text: "thanks" });
    expect(JSON.stringify((fake.rec.bodies.at(-1)!.messages as unknown[]).at(-1))).not.toContain("by hand");
  });

  it("are said in plain words", () => {
    expect(describeEdits({ edits_add_track: 2, edits_delete_via: 1 }, 3)).toBe("drew 2 tracks and deleted 1 via");
    expect(describeEdits({ edits_set_track: 1, edits_add_via: 1, edits_move_part: 2, edits_delete_track: 3 }, 7)).toBe("moved 1 track and 2 parts, added 1 via and deleted 3 tracks");
    expect(describeEdits({}, 2)).toBe("made 2 edits");
  });
});
