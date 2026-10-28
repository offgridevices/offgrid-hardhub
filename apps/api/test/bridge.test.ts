// HardHub's chat on the person's own Claude Code: the bridge program (run for
// real, against a stand-in `claude` that speaks Claude Code's stream-json),
// and a whole chat turn in a room, with Claude Code's tool calls coming back
// through /mcp on a token minted for that turn.
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { CHAT_CLIENT, bridgeFor } from "../src/bridge";
import * as db from "../src/db";
import { app } from "../src/http";
import type { ChatRunner } from "../src/room/core";
import { type TestEnv, asEnv, testEnv } from "./support/env";

const HERE = fileURLToPath(String(new URL(".", import.meta.url)));
const BRIDGE = join(HERE, "../../../bridge/bridge.mjs");
const FAKE = join(HERE, "support/fake-claude.mjs");
const TOKEN = "t".repeat(40);
const PORT = 18789 + Math.floor(Math.random() * 500);

describe("the bridge program", () => {
  let proc: ChildProcess;
  const log = join(mkdtempSync(join(tmpdir(), "hh-bridge-")), "args.ndjson");
  const env = () => asEnv({ ...testEnv(), BRIDGE_URL: `http://127.0.0.1:${PORT}`, BRIDGE_TOKEN: TOKEN } as TestEnv);

  beforeAll(async () => {
    proc = spawn(process.execPath, [BRIDGE], {
      env: { ...process.env, BRIDGE_TOKEN: TOKEN, BRIDGE_PORT: String(PORT), CLAUDE_BIN: FAKE, FAKE_CLAUDE_LOG: log },
      stdio: "ignore",
    });
    for (let i = 0; i < 50; i++) {
      try {
        await fetch(`http://127.0.0.1:${PORT}/health`);
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    throw new Error("bridge did not start");
  });
  afterAll(() => {
    proc.kill();
  });

  it("refuses anyone without the token", async () => {
    expect((await fetch(`http://127.0.0.1:${PORT}/health`)).status).toBe(401);
    expect((await fetch(`http://127.0.0.1:${PORT}/turn`, { method: "POST", headers: { authorization: "Bearer wrong" } })).status).toBe(401);
  });

  it("says whether Claude Code is installed and signed in to a subscription", async () => {
    expect(await bridgeFor(env())!.health()).toEqual({ available: true, claude: "2.1.300", signed_in: true, auth: "claude.ai" });
  });

  it("runs the unmodified claude program with only HardHub's tools, and streams its reply", async () => {
    const events = [];
    for await (const e of bridgeFor(env())!.turn(
      { project: "p_abc", prompt: "Look at my board", system: "You are HardHub.", mcp: { url: "http://localhost:8787/mcp", token: "tok123" }, model: "opus" },
      new AbortController().signal,
    ))
      events.push(e);
    expect(events).toEqual([
      { type: "session", id: "6f1c2b9e-0d4e-4a51-9a7e-2c3b4d5e6f70" },
      { type: "text_delta", index: 0, text: "I'll look " },
      { type: "text_delta", index: 0, text: "at your board." },
      { type: "text", text: "I'll look at your board." },
      { type: "done", ok: true, stopped: false, session: "6f1c2b9e-0d4e-4a51-9a7e-2c3b4d5e6f70" },
    ]);
    const { args, cwd } = JSON.parse(readFileSync(log, "utf8").trim().split("\n").at(-1)!);
    const flag = (f: string) => args[args.indexOf(f) + 1];
    expect(flag("-p")).toBe("Look at my board");
    expect(flag("--output-format")).toBe("stream-json");
    expect(flag("--tools")).toBe(""); // no shell, no files
    expect(args).toContain("--strict-mcp-config"); // none of the person's other MCP servers
    expect(args).not.toContain("--bare"); // bare mode skips the subscription login
    expect(flag("--allowedTools")).toBe("mcp__hardhub");
    expect(flag("--permission-prompts")).toBe("none");
    expect(flag("--model")).toBe("opus");
    expect(JSON.parse(flag("--mcp-config"))).toEqual({ mcpServers: { hardhub: { type: "http", url: "http://localhost:8787/mcp", headers: { Authorization: "Bearer tok123" } } } });
    expect(cwd).toMatch(/hardhub-bridge[/\\]p_abc$/); // an empty folder of its own
  });

  it("resumes the conversation, and reports Claude Code's own failure", async () => {
    const sid = "11111111-2222-3333-4444-555555555555";
    const events = [];
    for await (const e of bridgeFor(env())!.turn({ project: "p_abc", prompt: "fail", system: "", mcp: { url: "http://x/mcp", token: "t" }, session: sid }, new AbortController().signal))
      events.push(e);
    expect(events.at(-1)).toEqual({ type: "done", ok: false, stopped: false, session: sid, error: "Not logged in · Please run /login" });
    const { args } = JSON.parse(readFileSync(log, "utf8").trim().split("\n").at(-1)!);
    expect(args[args.indexOf("--resume") + 1]).toBe(sid);
  });

  it("stops Claude Code when the person presses Stop", async () => {
    const ctl = new AbortController();
    const it = bridgeFor(env())!.turn({ project: "p_abc", prompt: "slow", system: "", mcp: { url: "http://x/mcp", token: "t" } }, ctl.signal);
    const first = await it[Symbol.asyncIterator]().next();
    expect(first.value).toMatchObject({ type: "session" });
    ctl.abort();
    // the request ends; Claude Code got SIGINT (its documented way to end a turn)
    await new Promise((r) => setTimeout(r, 300));
  });

  it("rejects bad input before running anything", async () => {
    const r = await fetch(`http://127.0.0.1:${PORT}/turn`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}` }, body: JSON.stringify({ project: "../x", prompt: "hi", mcp: { url: "u", token: "t" } }) });
    expect(r.status).toBe(400);
  });
});

describe("a chat turn on Claude Code", () => {
  let env: TestEnv;
  beforeEach(() => {
    env = testEnv();
  });

  const call = (path: string, init: RequestInit & { token?: string } = {}) => {
    const headers = new Headers(init.headers);
    if (init.token) headers.set("authorization", `Bearer ${init.token}`);
    if (init.body) headers.set("content-type", "application/json");
    return app.request("http://hardhub.test" + path, { ...init, headers }, asEnv(env));
  };

  async function setup() {
    const start = (await (await call("/auth/start", { method: "POST", body: JSON.stringify({ email: "maker@example.com" }) })).json()) as { token: string };
    const s = (await (await call("/auth/verify", { method: "POST", body: JSON.stringify({ token: start.token }) })).json()) as { token: string; me: { id: string } };
    await call("/me/llm", { method: "PATCH", token: s.token, body: JSON.stringify({ provider: "claude-code", model: "default" }) });
    const p = (await (await call("/projects", { method: "POST", token: s.token, body: JSON.stringify({ name: "Chat" }) })).json()) as { id: string };
    return { browser: s.token, userId: s.me.id, project: p.id };
  }

  /** an MCP client with the turn's token, as the bridge's Claude Code would have */
  async function claudeCode(token: string) {
    const client = new Client({ name: "claude-code", version: "2.1.300" });
    const net = async (input: string | URL | Request, init?: RequestInit) => app.request(new Request(input, init), undefined, asEnv(env));
    await client.connect(new StreamableHTTPClientTransport(new URL("http://hardhub.test/mcp"), { fetch: net, requestInit: { headers: { authorization: `Bearer ${token}` } } }));
    return client;
  }

  it("streams Claude Code's reply, runs its board tools in the turn, asks with cards and resumes with the answers", async () => {
    const { userId, project, browser } = await setup();
    const runs: { prompt: string; session?: string; system: string }[] = [];
    let tokenUsed = "";
    const runner: ChatRunner = {
      async *run(req) {
        runs.push(req);
        yield { type: "session", id: "6f1c2b9e-0d4e-4a51-9a7e-2c3b4d5e6f70" };
        yield { type: "text_delta", index: 0, text: "Let me check." };
        yield { type: "text", text: "Let me check." };
        tokenUsed = await db.createChatToken(asEnv(env), userId, CHAT_CLIENT);
        const cc = await claudeCode(tokenUsed);
        const tools = (await cc.listTools()).tools.map((t) => t.name);
        expect(tools).toContain("ask_user");
        const d = await cc.callTool({ name: "get_design", arguments: { project } });
        expect(d.isError).toBeFalsy();
        if (runs.length === 1) {
          const asked = await cc.callTool({
            name: "ask_user",
            arguments: { project, questions: [{ id: "power", header: "Power", text: "How is it powered?", options: [{ id: "usb", label: "USB-C", recommended: true }, { id: "bat", label: "Battery" }] }] },
          });
          expect(asked.isError).toBeFalsy();
        }
        yield { type: "done", ok: true, session: "6f1c2b9e-0d4e-4a51-9a7e-2c3b4d5e6f70" };
      },
    };
    env.ROOMS.setChat(async () => runner);
    const core = env.ROOMS.core(project);
    await core.message({ text: "A garden sensor" });
    const evs = core.events(-1, 1000).events;
    expect(evs.filter((e) => e.type === "assistant_text").map((e) => e.type === "assistant_text" && e.text)).toEqual(["Let me check."]);
    expect(evs.some((e) => e.type === "tool" && e.name === "get_design" && e.status === "done")).toBe(true);
    expect(evs.some((e) => e.type === "questions")).toBe(true);
    // one turn: one end, waiting for the answers (tool calls inside it end nothing)
    expect(evs.filter((e) => e.type === "turn_end")).toEqual([expect.objectContaining({ reason: "waiting_for_user" })]);
    expect(runs[0]!.system).toContain(`pass project "${project}"`);
    expect(runs[0]!.session).toBeUndefined();

    // the turn is over: its token no longer works for the board
    const late = await claudeCode(tokenUsed);
    const refused = await late.callTool({ name: "get_design", arguments: { project } });
    expect(refused.isError).toBe(true);

    // as the web app sends them: the question's header, the option's label
    await core.message({ text: "Answers", answers: { Power: ["USB-C"] } });
    expect(runs[1]!.prompt).toContain("How is it powered?: USB-C");
    expect(runs[1]!.session).toBe("6f1c2b9e-0d4e-4a51-9a7e-2c3b4d5e6f70");
    expect(core.events(-1, 1000).events.at(-1)).toMatchObject({ type: "turn_end", reason: "done" });
    void browser;
  });

  it("says plainly when Claude Code fails", async () => {
    const { project } = await setup();
    env.ROOMS.setChat(async () => ({
      async *run() {
        yield { type: "done", ok: false, error: "Not logged in · Please run /login" };
      },
    }));
    const core = env.ROOMS.core(project);
    await core.message({ text: "hi" });
    const evs = core.events(-1, 1000).events;
    expect(evs.find((e) => e.type === "error")).toMatchObject({ message: "Claude Code: Not logged in · Please run /login" });
    expect(evs.at(-1)).toMatchObject({ type: "turn_end", reason: "error" });
  });

  it("shows Claude Code as unavailable where there is no bridge (the cloud)", async () => {
    const { browser } = await setup();
    const r = (await (await call("/bridge", { token: browser })).json()) as { available: boolean };
    expect(r.available).toBe(false);
    const me = (await (await call("/me", { token: browser })).json()) as { llm_ready: boolean };
    expect(me.llm_ready).toBe(false);
  });
});
