// The REST API over a real schema (D1 on sql.js) with in-memory rooms and files.
import { Me, ProjectDetail, ProjectSummary } from "@hardhub/protocol";
import { beforeEach, describe, expect, it } from "vitest";
import { CONVERTERS } from "../src/agent/llm";
import { b64, decryptSecret, encryptSecret, sha256 } from "../src/crypto";
import type { Env } from "../src/env";
import { app } from "../src/http";
import { RoomCore } from "../src/room/core";
import { FakeEngine } from "./support/room";
import { d1, doSql } from "./support/sqlite";

const KEK = b64(new Uint8Array(32).fill(7));

function fakeR2() {
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

function fakeRooms(env: Env) {
  const rooms = new Map<string, RoomCore>();
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
          engine: new FakeEngine(),
          putFile: async () => {},
          getFile: async () => null,
          touch: async () => {},
        })),
      );
    return r;
  };
  void env;
  return {
    rooms,
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
    }),
  };
}

let env: Env & { FILES: ReturnType<typeof fakeR2> };

beforeEach(() => {
  env = {
    DB: d1(),
    FILES: fakeR2(),
    DEV: "1",
    APP_URL: "http://localhost:5173",
    WEB_ORIGINS: "http://localhost:5173",
    ENGINE_URL: "http://engine:8080",
    US_ONLY: "0",
    KEY_ENCRYPTION_KEY: KEK,
    DEV_LLM_PROVIDER: "ollama",
  } as unknown as typeof env;
  (env as unknown as { ROOMS: unknown }).ROOMS = fakeRooms(env);
});

const call = (path: string, init: RequestInit & { token?: string } = {}) => {
  const headers = new Headers(init.headers);
  if (init.token) headers.set("authorization", `Bearer ${init.token}`);
  if (init.body) headers.set("content-type", "application/json");
  return app.request(path, { ...init, headers }, env);
};

async function signIn(email = "maker@example.com") {
  const start = await call("/auth/start", { method: "POST", body: JSON.stringify({ email }) });
  expect(start.status).toBe(200);
  const { token, dev_link } = (await start.json()) as { token: string; dev_link: string };
  expect(dev_link).toContain("/auth/verify?token=");
  const v = await call("/auth/verify", { method: "POST", body: JSON.stringify({ token }) });
  expect(v.status).toBe(200);
  expect(v.headers.get("set-cookie")).toContain("hh_session=");
  return (await v.json()) as { token: string; me: Me };
}

describe("crypto", () => {
  it("encrypts keys so only the same user can read them", async () => {
    const { ciphertext, iv } = await encryptSecret(KEK, "sk-ant-secret-1234", "u1");
    expect(ciphertext).not.toContain("secret");
    expect(await decryptSecret(KEK, ciphertext, iv, "u1")).toBe("sk-ant-secret-1234");
    await expect(decryptSecret(KEK, ciphertext, iv, "u2")).rejects.toThrow();
  });
  it("hashes tokens deterministically", async () => {
    expect(await sha256("a")).toBe(await sha256("a"));
    expect(await sha256("a")).not.toBe(await sha256("b"));
  });
});

describe("auth", () => {
  it("signs in with a dev link, once", async () => {
    const start = await call("/auth/start", { method: "POST", body: JSON.stringify({ email: "A@Example.com" }) });
    const { token } = (await start.json()) as { token: string };
    const s = (await (await call("/auth/verify", { method: "POST", body: JSON.stringify({ token }) })).json()) as { token: string; me: Me };
    expect(Me.parse(s.me).email).toBe("a@example.com");
    // dev defaults applied to a new account
    expect(s.me.llm).toEqual({ provider: "ollama", model: "qwen3.5:0.8b" });
    const again = await call("/auth/verify", { method: "POST", body: JSON.stringify({ token }) });
    expect(again.status).toBe(401);
  });

  it("needs a session for everything else", async () => {
    expect((await call("/me")).status).toBe(401);
    expect((await call("/projects", { token: "nonsense-token" })).status).toBe(401);
    const { token } = await signIn();
    expect((await call("/me", { token })).status).toBe(200);
    expect((await call("/me", { headers: { cookie: `hh_session=${token}` } })).status).toBe(200);
    expect((await call("/auth/logout", { method: "POST", token })).status).toBe(204);
    expect((await call("/me", { token })).status).toBe(401);
  });

  it("does not hand out links outside development without a mail sender", async () => {
    env.DEV = "0";
    const r = await call("/auth/start", { method: "POST", body: JSON.stringify({ email: "x@example.com" }) });
    expect(r.status).toBe(500);
  });

  it("rejects bad input with a reason", async () => {
    const r = await call("/auth/start", { method: "POST", body: JSON.stringify({ email: "not-an-email" }) });
    expect(r.status).toBe(400);
  });
});

describe("me", () => {
  it("stores keys encrypted and shows only the last four characters", async () => {
    const { token } = await signIn();
    const r = await call("/me/keys/anthropic", { method: "PUT", token, body: JSON.stringify({ key: "sk-ant-api03-abcdefWXYZ" }) });
    const me = Me.parse(await r.json());
    expect(me.keys.anthropic?.last4).toBe("WXYZ");
    expect(JSON.stringify(me)).not.toContain("abcdef");
    const row = await env.DB.prepare("SELECT ciphertext FROM api_keys").first<{ ciphertext: string }>();
    expect(row!.ciphertext).not.toContain("sk-ant");
    const del = Me.parse(await (await call("/me/keys/anthropic", { method: "DELETE", token })).json());
    expect(del.keys.anthropic).toBeUndefined();
    expect((await call("/me/keys/somebody", { method: "PUT", token, body: JSON.stringify({ key: "12345678" }) })).status).toBe(400);
  });

  it("switches LLM provider and model", async () => {
    const { token } = await signIn();
    const r = await call("/me/llm", { method: "PATCH", token, body: JSON.stringify({ provider: "openrouter", model: "anthropic/claude-opus-5.5" }) });
    expect(Me.parse(await r.json()).llm).toEqual({ provider: "openrouter", model: "anthropic/claude-opus-5.5" });
    env.DEV = "0";
    const plain = await call("/me/llm", { method: "PATCH", token, body: JSON.stringify({ provider: "custom", model: "m", base_url: "http://10.0.0.1/v1" }) });
    expect(plain.status).toBe(400);
  });
});

describe("projects", () => {
  it("creates, lists, reads, renames, pages events, serves files, deletes", async () => {
    const { token } = await signIn();
    const created = ProjectSummary.parse(await (await call("/projects", { method: "POST", token, body: JSON.stringify({ prompt: "A hub with five USB ports. It talks to Home Assistant." }) })).json());
    expect(created.name).toBe("A hub with five USB ports");
    const list = (await (await call("/projects", { token })).json()) as ProjectSummary[];
    expect(list.map((p) => p.id)).toEqual([created.id]);

    const detail = ProjectDetail.parse(await (await call(`/projects/${created.id}`, { token })).json());
    expect(detail.design_version).toBe(1);
    expect(detail.design.name).toBe("A hub with five USB ports");
    expect(detail.busy).toBe(false);

    const renamed = (await (await call(`/projects/${created.id}`, { method: "PATCH", token, body: JSON.stringify({ name: "Print Hub" }) })).json()) as ProjectSummary;
    expect(renamed.name).toBe("Print Hub");

    const page = await (await call(`/projects/${created.id}/events?after=-1&limit=50`, { token })).json();
    expect(page).toEqual({ events: [], more: false });

    await env.FILES.put(`projects/${created.id}/b1-top.png`, new Uint8Array([1, 2]).buffer, { httpMetadata: { contentType: "image/png" } });
    const f = await call(`/projects/${created.id}/files/b1-top.png`, { token });
    expect(f.status).toBe(200);
    expect(f.headers.get("content-type")).toBe("image/png");
    expect(f.headers.get("cache-control")).toContain("immutable");
    expect((await call(`/projects/${created.id}/files/nope.png`, { token })).status).toBe(404);

    expect((await call(`/projects/${created.id}/ws`, { token })).status).toBe(426);

    expect((await call(`/projects/${created.id}`, { method: "DELETE", token })).status).toBe(204);
    expect(env.FILES.objs.size).toBe(0);
    expect((await call(`/projects/${created.id}`, { token })).status).toBe(404);
  });

  it("keeps people out of each other's projects", async () => {
    const a = await signIn("a@example.com");
    const b = await signIn("b@example.com");
    const p = ProjectSummary.parse(await (await call("/projects", { method: "POST", token: a.token, body: "{}" })).json());
    expect(p.name).toBe("Untitled board");
    for (const path of [`/projects/${p.id}`, `/projects/${p.id}/events`, `/projects/${p.id}/files/x.png`])
      expect((await call(path, { token: b.token })).status).toBe(404);
    expect((await call(`/projects/${p.id}`, { method: "DELETE", token: b.token })).status).toBe(404);
    expect(await (await call("/projects", { token: b.token })).json()).toEqual([]);
  });

  it("allows the web app's origin only", async () => {
    const ok = await call("/health", { headers: { origin: "http://localhost:5173" } });
    expect(ok.headers.get("access-control-allow-origin")).toBe("http://localhost:5173");
    const no = await call("/health", { headers: { origin: "https://evil.example" } });
    expect(no.headers.get("access-control-allow-origin")).toBeNull();
  });
});
