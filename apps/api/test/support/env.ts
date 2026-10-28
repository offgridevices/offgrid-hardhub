// A test Env for the Worker: D1 on sql.js with the real migrations, an
// in-memory R2, and rooms that are RoomCores called directly (as the Durable
// Object's RPC would), with a fake engine.
import { CONVERTERS } from "../../src/agent/llm";
import { b64 } from "../../src/crypto";
import type { Env } from "../../src/env";
import { type ChatRunner, RoomCore } from "../../src/room/core";
import { FakeEngine } from "./room";
import { d1, doSql } from "./sqlite";

export const KEK = b64(new Uint8Array(32).fill(7));

export function fakeR2() {
  const objs = new Map<string, { bytes: Uint8Array; type: string }>();
  return {
    objs,
    async put(key: string, body: ArrayBuffer | string, opts?: { httpMetadata?: { contentType?: string } }) {
      objs.set(key, { bytes: new Uint8Array(typeof body === "string" ? new TextEncoder().encode(body) : body), type: opts?.httpMetadata?.contentType ?? "" });
    },
    async get(key: string) {
      const o = objs.get(key);
      if (!o) return null;
      return { body: new Blob([o.bytes]).stream(), httpMetadata: { contentType: o.type }, httpEtag: '"e"', arrayBuffer: async () => o.bytes.buffer };
    },
    async list({ prefix }: { prefix: string }) {
      return { objects: [...objs.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })), truncated: false };
    },
    async delete(keys: string[]) {
      for (const k of keys) objs.delete(k);
    },
  };
}

export function fakeRooms(env: { FILES: ReturnType<typeof fakeR2> }, engine: FakeEngine = new FakeEngine()) {
  const rooms = new Map<string, RoomCore>();
  // the person's own Claude Code, for chat-turn tests (null: the built-in AI)
  let chat: (owner: string) => Promise<ChatRunner | null> = async () => null;
  const core = (id: string) => {
    let r = rooms.get(id);
    if (!r)
      rooms.set(
        id,
        (r = new RoomCore({
          sql: doSql(),
          broadcast: () => {},
          llm: async () => {
            throw new Error("no llm in http tests");
          },
          converters: CONVERTERS,
          engine,
          putFile: async (key, body, contentType) => {
            await env.FILES.put(key, body instanceof ArrayBuffer ? body : await new Response(body).arrayBuffer(), { httpMetadata: { contentType } });
          },
          getFile: async (key) => {
            const o = env.FILES.objs.get(key);
            return o ? (o.bytes.slice().buffer as ArrayBuffer) : null;
          },
          touch: async () => {},
          chat: (owner) => chat(owner),
        })),
      );
    return r;
  };
  return {
    rooms,
    core,
    engine,
    setChat: (fn: typeof chat) => {
      chat = fn;
    },
    idFromName: (n: string) => n,
    get: (id: string) => ({
      init: async (p: string, o: string, n: string) => core(id).init(p, o, n),
      detail: async () => {
        const { design, version } = core(id).design();
        return { design, design_version: version, last_seq: core(id).lastSeq(), busy: core(id).busy };
      },
      events: async (after: number, limit: number) => core(id).events(after, limit),
      start: async (input: { text: string }) => core(id).queue(input),
      destroy: async () => void rooms.delete(id),
      // the alarm a build sets runs right after the call, as it would on Cloudflare
      agentTool: async (name: string, input: unknown, fromChat = false) => {
        const r = await core(id).agentTool(name, input, fromChat);
        if (name === "build_board" && !r.isError) await core(id).runAgentBuild();
        return r;
      },
      agentBuild: async () => core(id).agentBuild(),
      agentRequest: async (t: string) => core(id).agentRequest(t),
      agentAsk: async (q: unknown) => core(id).agentAsk(q),
      agentNote: async (t: string) => core(id).agentNote(t),
      agentResults: async () => ({ artifacts: core(id).latestArtifacts(), checks: core(id).latestChecks() }),
      agentFile: async (name: string) => core(id).file(name),
    }),
  };
}

export type TestEnv = Omit<Env, "FILES" | "ROOMS"> & { FILES: ReturnType<typeof fakeR2>; ROOMS: ReturnType<typeof fakeRooms> };
/** the same object, typed as the Worker sees it */
export const asEnv = (e: TestEnv) => e as unknown as Env;

export function testEnv(engine?: FakeEngine): TestEnv {
  const env = {
    DB: d1(),
    FILES: fakeR2(),
    DEV: "1",
    APP_URL: "http://localhost:5173",
    WEB_ORIGINS: "http://localhost:5173",
    ENGINE_URL: "http://engine:8080",
    US_ONLY: "0",
    KEY_ENCRYPTION_KEY: KEK,
    DEV_LLM_PROVIDER: "ollama",
  } as unknown as TestEnv;
  env.ROOMS = fakeRooms(env, engine);
  return env;
}
