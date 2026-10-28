// The agent loop, end to end inside one room, run through both providers
// (real SDKs, scripted network): events, tools, design versions, artifacts,
// and the promises about history and US-only inference.
import Anthropic from "@anthropic-ai/sdk";
import type { ServerEvent } from "@hardhub/protocol";
import { describe, expect, it } from "vitest";
import { AnthropicLlm } from "../src/agent/llm/anthropic";
import { LIMITS } from "../src/agent/loop";
import { type Block, type Recorder, type Script, scriptedAnthropic, scriptedOpenAi } from "./support/fake-llm";
import { FakeEngine, makeRoom } from "./support/room";

const ask: Block = {
  tool: "ask_user",
  input: {
    questions: [
      {
        id: "q1",
        header: "Ports",
        text: "How many USB ports?",
        options: [
          { id: "5", label: "Five", recommended: true, detail: "fits 86 mm" },
          { id: "4", label: "Four" },
        ],
      },
    ],
  },
};

const SCRIPT: Script = [
  [{ thinking: "They want a USB hub; ask how many ports." }, { text: "Hi! A few questions first." }, ask],
  [
    { tool: "update_design", input: { summary: "Add the ports requirement", patch: [{ op: "add", path: "/requirements/-", value: { id: "R1", text: "Five switched USB ports" } }] } },
    { tool: "update_design", input: { summary: "Set the board size", patch: [{ op: "add", path: "/board", value: { width: 86, height: 50, layers: 4 } }] } },
  ],
  [{ tool: "build_board", input: {} }],
  [{ tool: "render", input: {} }],
  [{ text: "The board is built and routed." }],
];

/** each request must start with the previous request's messages, unchanged */
function expectAppendOnly(rec: Recorder) {
  for (let i = 1; i < rec.bodies.length; i++) {
    const prev = rec.bodies[i - 1]!.messages as unknown[];
    const next = rec.bodies[i]!.messages as unknown[];
    expect(next.slice(0, prev.length)).toEqual(prev);
  }
}

const types = (evs: ServerEvent[]) => evs.map((e) => (e.type === "tool" ? `tool:${e.name}:${e.status}` : e.type));

const providers = [
  ["anthropic", () => scriptedAnthropic(SCRIPT)],
  ["openai-compatible", () => scriptedOpenAi(SCRIPT)],
] as const;

describe.each(providers)("full design turn via %s", (kind, make) => {
  it("asks, waits, patches the design, builds, looks at the board, answers", async () => {
    const { llm, rec } = make();
    const room = makeRoom(llm);

    expect(await room.core.message({ text: "I want a hub with five USB ports for Home Assistant" })).toBe("waiting_for_user");
    const first = room.stored();
    expect(types(first)).toEqual(["user_message", "thinking", "assistant_text", "usage", "tool:ask_user:running", "questions", "tool:ask_user:done", "turn_end"]);
    expect(first.at(-1)).toMatchObject({ type: "turn_end", reason: "waiting_for_user" });
    const said = first.find((e) => e.type === "assistant_text");
    expect(said).toMatchObject({ text: "Hi! A few questions first.", done: true });
    expect(first.find((e) => e.type === "thinking")).toMatchObject({ text: "They want a USB hub; ask how many ports." });
    // live text went out as deltas that add up to the stored text
    const deltas = room.events().filter((e) => e.type === "assistant_text" && !e.done) as { text: string }[];
    expect(deltas.map((d) => d.text).join("")).toBe("Hi! A few questions first.");
    expect(room.core.busy).toBe(false);

    expect(await room.core.message({ text: "", answers: { q1: ["5"] } })).toBe("done");
    const all = room.stored();
    expect(all.at(-1)).toMatchObject({ type: "turn_end", reason: "done" });
    // design versions: 1 new project, 2 requirement, 3 board, 4 automatic placement
    const designs = all.filter((e) => e.type === "design");
    expect(designs.map((e) => e.type === "design" && e.version)).toEqual([2, 3, 4]);
    const { design, version } = room.core.design();
    expect(version).toBe(4);
    expect(design.requirements[0]).toMatchObject({ id: "R1", status: "open" });
    expect(design.board).toMatchObject({ width: 86, height: 50, layers: 4, fab: "jlcpcb" });
    expect(design.placement.U1).toMatchObject({ x: 1, y: 2, locked: false });
    // the build: progress, checks, files copied into the project's store
    expect(all.filter((e) => e.type === "job").map((e) => e.type === "job" && e.step)).toEqual(["place", "route", "done"]);
    const arts = all.find((e) => e.type === "artifacts");
    expect(arts?.type === "artifacts" && arts.artifacts.map((a) => a.url)).toEqual(["/projects/p_test/files/b1-top.png", "/projects/p_test/files/b1-board.glb", "/projects/p_test/files/b1-board-kicad.zip"]);
    expect(room.files.has("projects/p_test/b1-top.png")).toBe(true);
    expect(all.filter((e) => e.type === "checks")).toHaveLength(1);
    expect(all.filter((e) => e.type === "usage").length).toBe(5);
    expect(all.find((e) => e.type === "assistant_text" && e.text.includes("built"))).toBeTruthy();

    // the person's answer reached the model as the ask_user result
    const afterAnswer = JSON.stringify(rec.bodies[1]!.messages);
    expect(afterAnswer).toContain("q1: 5");
    expectAppendOnly(rec);

    // the render reached the model as an image
    const lastBody = JSON.stringify(rec.bodies.at(-1)!.messages);
    if (kind === "anthropic") expect(lastBody).toContain('"media_type":"image/png"');
    else expect(lastBody).toContain("data:image/png;base64,");
  });
});

describe("anthropic requests", () => {
  it("run on US servers, think with summaries, stream tool input, cache, and keep thinking blocks", async () => {
    const { llm, rec } = scriptedAnthropic(SCRIPT);
    const room = makeRoom(llm);
    await room.core.message({ text: "hub" });
    await room.core.message({ text: "", answers: { q1: ["5"] } });
    expect(rec.bodies.length).toBe(5);
    for (const b of rec.bodies) {
      expect(b.inference_geo).toBe("us");
      expect(b.stream).toBe(true);
      expect(b.thinking).toEqual({ type: "adaptive", display: "summarized" });
      expect(b.output_config).toEqual({ effort: "high" });
      expect(b.cache_control).toEqual({ type: "ephemeral" });
      expect((b.system as { cache_control?: unknown }[])[0]!.cache_control).toEqual({ type: "ephemeral" });
      expect((b.tools as { eager_input_streaming?: boolean }[]).every((t) => t.eager_input_streaming)).toBe(true);
      expect(b).not.toHaveProperty("fallbacks");
      expect(b).not.toHaveProperty("betas");
    }
    for (const h of rec.headers) expect(h.get("anthropic-beta")).toBeNull();
    // the thinking block (with its signature) went back exactly as it came
    const assistant = (rec.bodies[1]!.messages as { role: string; content: { type: string; signature?: string }[] }[]).find((m) => m.role === "assistant")!;
    expect(assistant.content[0]).toMatchObject({ type: "thinking", signature: "sig_0" });
    // the tool list and system prompt are identical on every request (cacheable)
    const prefix = (b: Record<string, unknown>) => JSON.stringify([b.tools, b.system]);
    expect(new Set(rec.bodies.map(prefix)).size).toBe(1);
  });

  it("explains a rejected key plainly", async () => {
    const client = new Anthropic({
      apiKey: "bad",
      maxRetries: 0,
      fetch: async () => new Response(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }), { status: 401, headers: { "content-type": "application/json" } }),
    });
    const room = makeRoom(new AnthropicLlm({ apiKey: "bad", model: "claude-opus-5-5", client }));
    expect(await room.core.message({ text: "hi" })).toBe("error");
    const err = room.stored().find((e) => e.type === "error");
    expect(err).toMatchObject({ message: expect.stringContaining("API key"), retryable: false });
    expect(room.stored().at(-1)).toMatchObject({ type: "turn_end", reason: "error" });
  });
});

describe.each(providers.map(([k]) => k))("graceful with weak models (%s)", (kind) => {
  const make = (s: Script) => (kind === "anthropic" ? scriptedAnthropic(s) : scriptedOpenAi(s));

  it("answers a bad call with an error the model can fix, then carries on", async () => {
    const { llm, rec } = make([
      [{ tool: "update_design", input: { summary: "x", patch: "not a patch" } }],
      [{ tool: "no_such_tool", input: {} }],
      [{ tool: "get_design", input: { sections: ["board"] } }],
      [{ tool: "update_design", input: { summary: "Board", patch: [{ op: "add", path: "/board", value: { width: 50, height: 50, layers: 3 } }] } }],
      [{ text: "Done." }],
    ]);
    const room = makeRoom(llm);
    expect(await room.core.message({ text: "go" })).toBe("done");
    const bodies = rec.bodies.map((b) => JSON.stringify(b.messages));
    expect(bodies[1]).toContain("Invalid input for update_design");
    expect(bodies[2]).toContain('There is no tool called \\"no_such_tool\\"');
    // layers 3 is not a copper count: the patch is refused, nothing saved
    expect(bodies[4]).toContain("would be invalid");
    expect(room.core.design().version).toBe(1);
    expectAppendOnly(rec);
  });

  it("gives up after repeated broken steps without corrupting history", async () => {
    const bad: Block[] = [{ tool: "nope", input: {} }];
    const { llm, rec } = make(Array.from({ length: 10 }, () => bad));
    const room = makeRoom(llm);
    expect(await room.core.message({ text: "go" })).toBe("error");
    expect(rec.bodies.length).toBe(LIMITS.badSteps);
    expect(room.stored().find((e) => e.type === "error")).toMatchObject({ message: expect.stringContaining("more capable model") });
    // the next turn still works: every tool call got its result
    const { llm: next } = make([[{ text: "ok" }]]);
    room.deps.llm = async () => next;
    expect(await room.core.message({ text: "again" })).toBe("done");
  });

  it("ends the turn when the model never calls a tool", async () => {
    const { llm } = make([[{ text: "I would use an ESP32." }]]);
    const room = makeRoom(llm);
    expect(await room.core.message({ text: "go" })).toBe("done");
  });

  it("carries on after a reply with nothing in it", async () => {
    // a small local model answered a tool error with an empty reply; the
    // next message then failed for good ("invalid message content type")
    const { llm, rec } = make([[{ tool: "nope", input: {} }], [], [{ text: "ok" }]]);
    const room = makeRoom(llm);
    expect(await room.core.message({ text: "go" })).toBe("done");
    expect(await room.core.message({ text: "go on" })).toBe("done");
    const sent = rec.bodies.at(-1)!.messages as { role: string; content: unknown; tool_calls?: unknown[] }[];
    for (const m of sent.filter((m) => m.role === "assistant")) {
      if (kind === "anthropic") expect(m.content).not.toEqual([]);
      else if (!m.tool_calls?.length) expect(typeof m.content).toBe("string");
    }
    expectAppendOnly(rec);
  });

  it("stops mid-tool when asked and closes every open call", async () => {
    let started!: () => void;
    const running = new Promise<void>((r) => (started = r));
    const engine = new FakeEngine();
    engine.build = async function* (_d: unknown, _j: string, signal?: AbortSignal) {
      started();
      await new Promise((_, reject) => signal?.addEventListener("abort", () => reject(new Error("aborted"))));
    } as unknown as FakeEngine["build"];
    const { llm, rec } = make([
      [{ tool: "update_design", input: { summary: "Board", patch: [{ op: "add", path: "/board", value: { width: 50, height: 50, layers: 2 } }] } }],
      [{ tool: "build_board", input: {} }, { tool: "check_circuit", input: {} }],
      [{ text: "after stop" }],
    ]);
    const room = makeRoom(llm, engine);
    const turn = room.core.message({ text: "build it" });
    await running;
    room.core.stop();
    expect(await turn).toBe("stopped");
    expect(room.stored().at(-1)).toMatchObject({ type: "turn_end", reason: "stopped" });
    // the next turn's request carries a result for both calls of the stopped step
    expect(await room.core.message({ text: "continue" })).toBe("done");
    const last = JSON.stringify(rec.bodies.at(-1)!.messages);
    expect(last).toContain("Stopped by the person");
    expectAppendOnly(rec);
  });
});

describe("Ollama quirks", () => {
  it("accepts object arguments, missing indexes and ids, no usage, reasoning_content; no images", async () => {
    const script: Script = [
      [{ thinking: "small model thinking" }, { tool: "update_design", input: { summary: "Name", patch: [{ op: "replace", path: "/name", value: "Hub" }] } }],
      [{ tool: "render", input: {} }],
      [{ text: "ok" }],
    ];
    const { llm, rec } = scriptedOpenAi(script, { argsAsObject: true, noIndex: true, noUsage: true, reasoningField: "reasoning_content" }, false);
    const room = makeRoom(llm);
    expect(await room.core.message({ text: "go" })).toBe("done");
    expect(room.core.design().design.name).toBe("Hub");
    expect(room.stored().find((e) => e.type === "thinking")).toMatchObject({ text: "small model thinking" });
    expect(room.stored().find((e) => e.type === "usage")).toMatchObject({ input_tokens: 0, cost_usd: 0 });
    expect(JSON.stringify(rec.bodies.at(-1))).not.toContain("image_url");
  });

  it("turns unparseable arguments into a retryable error", async () => {
    const { llm, rec } = scriptedOpenAi([[{ name: "get_design", toolRaw: '{"sections": [' }], [{ text: "ok" }]]);
    const room = makeRoom(llm);
    expect(await room.core.message({ text: "go" })).toBe("done");
    expect(JSON.stringify(rec.bodies[1]!.messages)).toContain("not valid JSON");
  });
});

describe("room", () => {
  it("moves the conversation when the person switches provider", async () => {
    const a = scriptedAnthropic([[{ text: "Hello from Claude." }]]);
    const room = makeRoom(a.llm);
    await room.core.message({ text: "first" });
    const o = scriptedOpenAi([[{ text: "x" }], [{ text: "Hello from the other model." }]]);
    room.deps.llm = async () => o.llm;
    expect(await room.core.message({ text: "second" })).toBe("done");
    const msgs = o.rec.bodies[0]!.messages as { role: string; content: unknown }[];
    expect(msgs.map((m) => m.role)).toEqual(["system", "user", "assistant", "user"]);
    expect(msgs[2]!.content).toBe("Hello from Claude.");
  });

  it("refuses a second message while a turn runs", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { llm } = scriptedAnthropic([[{ text: "slow" }]]);
    const room = makeRoom(async () => {
      await gate;
      return llm;
    });
    const t1 = room.core.message({ text: "one" });
    expect(await room.core.message({ text: "two" })).toBe("busy");
    release();
    expect(await t1).toBe("done");
  });

  it("reports a missing key without starting a turn", async () => {
    const { LlmError } = await import("../src/agent/llm/types");
    const room = makeRoom(async () => {
      throw new LlmError("Add your Claude API key in Settings to start designing.", false);
    });
    expect(await room.core.message({ text: "hi" })).toBe("error");
    expect(room.stored().map((e) => e.type)).toEqual(["user_message", "error", "turn_end"]);
  });

  it("pages and replays stored events", async () => {
    const room = makeRoom(scriptedAnthropic([[{ text: "a" }], [{ text: "b" }], [{ text: "c" }]]).llm);
    for (const t of ["1", "2", "3"]) await room.core.message({ text: t });
    const all = room.core.events(-1, 1000).events;
    const p1 = room.core.events(-1, 4);
    expect(p1.events).toHaveLength(4);
    expect(p1.more).toBe(true);
    const p2 = room.core.events(p1.events.at(-1)!.seq, 1000);
    expect([...p1.events, ...p2.events]).toEqual(all);
    expect(p2.more).toBe(false);
    expect([...room.core.replay(-1)].map((f) => JSON.parse(f))).toEqual(all);
    expect(all.map((e) => e.seq)).toEqual(all.map((_, i) => i));
  });

  it("clears a busy flag left by an interrupted turn", async () => {
    const { RoomCore } = await import("../src/room/core");
    const room = makeRoom(scriptedAnthropic([]).llm);
    room.sql.exec("INSERT OR REPLACE INTO meta (k, v) VALUES ('busy', '1')");
    const again = new RoomCore(room.deps);
    expect(again.busy).toBe(false);
    expect(again.events(-1, 100).events.at(-1)).toMatchObject({ type: "turn_end", reason: "error" });
  });
});

describe("messages from a client", () => {
  it("are queued for the alarm, not run inside the socket event, and a second one waits its turn", async () => {
    const room = makeRoom(async () => {
      throw new Error("the model must not be called while only queuing");
    });
    expect(room.core.accept({ text: "first" })).toBe(true);
    expect(room.stored().some((e) => e.type === "user_message")).toBe(false);
    expect(room.core.accept({ text: "second" })).toBe(false);
    const busy = room.events().find((e) => e.type === "error");
    expect(busy && "message" in busy ? busy.message : "").toMatch(/still working/);
  });
});

describe("a room that restarts mid-turn", () => {
  it("tells the person the reply was interrupted", async () => {
    const room = makeRoom(async () => {
      throw new Error("not called");
    });
    room.sql.exec("INSERT OR REPLACE INTO meta (k, v) VALUES ('busy', '1')");
    const { RoomCore } = await import("../src/room/core");
    new RoomCore(room.deps);
    const kinds = room.stored().slice(-2).map((e) => e.type);
    expect(kinds).toEqual(["error", "turn_end"]);
  });
});

describe("update_design errors", () => {
  it("name the failing operation without echoing the whole design", async () => {
    const { TOOLS } = await import("../src/agent/tools");
    const room = makeRoom(async () => {
      throw new Error("not called");
    });
    const design = room.core.design().design;
    const ctx = { design: () => ({ design, version: 1 }), saveDesign: () => 2 } as never;
    const r = await TOOLS.update_design.run({ summary: "set the MCU", patch: [{ op: "replace", path: "/firmware/mcu", value: "U1" }] }, ctx, { id: "t", name: "update_design", input: {} } as never, new AbortController().signal);
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/firmware\/mcu/);
    expect(r.content).toMatch(/use "add"/);
    expect(r.content.length).toBeLessThan(600);
  });
});
