// The REST API over a real schema (D1 on sql.js) with in-memory rooms and files.
import { Me, ProjectDetail, ProjectSummary } from "@hardhub/protocol";
import { beforeEach, describe, expect, it } from "vitest";
import { b64, decryptSecret, encryptSecret, hashPassword, sha256, verifyPassword } from "../src/crypto";
import type { Env } from "../src/env";
import { app } from "../src/http";
import worker from "../src/index";
import { KEK, type TestEnv, asEnv, testEnv } from "./support/env";

let env: TestEnv;

beforeEach(() => {
  env = testEnv();
});

const call = (path: string, init: RequestInit & { token?: string } = {}) => {
  const headers = new Headers(init.headers);
  if (init.token) headers.set("authorization", `Bearer ${init.token}`);
  if (init.body) headers.set("content-type", "application/json");
  return app.request(path, { ...init, headers }, env);
};

const PASSWORD = "correct horse battery";
const post = (path: string, body: unknown) => call(path, { method: "POST", body: JSON.stringify(body) });

/** a new account (or, if the email has one, a sign-in) */
async function signIn(email = "maker@example.com") {
  let v = await post("/auth/signup", { email, password: PASSWORD });
  if (v.status === 409) v = await post("/auth/signin", { email, password: PASSWORD });
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
  it("hashes passwords with a salt and checks them", async () => {
    const h = await hashPassword("hunter2hunter2");
    expect(h).toMatch(/^pbkdf2-sha256\$100000\$[\w-]+\$[\w-]+$/);
    expect(await hashPassword("hunter2hunter2")).not.toBe(h);
    expect(await verifyPassword("hunter2hunter2", h)).toBe(true);
    expect(await verifyPassword("hunter2hunter3", h)).toBe(false);
    expect(await verifyPassword("anything", null)).toBe(false);
    expect(await verifyPassword("anything", "garbage")).toBe(false);
  });
  it("hashes tokens deterministically", async () => {
    expect(await sha256("a")).toBe(await sha256("a"));
    expect(await sha256("a")).not.toBe(await sha256("b"));
  });
});

describe("auth", () => {
  it("makes an account with a password, then signs in with it", async () => {
    const s = await signIn("A@Example.com");
    expect(Me.parse(s.me).email).toBe("a@example.com");
    // dev defaults applied to a new account
    expect(s.me.llm).toEqual({ provider: "ollama", model: "qwen3.5:0.8b" });
    const row = await env.DB.prepare("SELECT password_hash FROM users WHERE email = 'a@example.com'").first<{ password_hash: string }>();
    expect(row!.password_hash).not.toContain(PASSWORD);
    expect((await post("/auth/signin", { email: "a@example.com", password: PASSWORD })).status).toBe(200);
    expect(await (await post("/auth/signin", { email: "a@example.com", password: "wrong one" })).json()).toEqual({ error: "Wrong email or password." });
    expect((await post("/auth/signin", { email: "nobody@example.com", password: PASSWORD })).status).toBe(401);
    // an email cannot be taken twice
    expect((await post("/auth/signup", { email: "a@example.com", password: "another password" })).status).toBe(409);
    expect((await post("/auth/signup", { email: "b@example.com", password: "short" })).status).toBe(400);
  });

  it("lets only the first account in unless sign-ups are open", async () => {
    env.ALLOW_SIGNUP = undefined;
    expect(await (await call("/auth/status")).json()).toEqual({ has_account: false, signup_open: true });
    await signIn("owner@example.com");
    expect(await (await call("/auth/status")).json()).toEqual({ has_account: true, signup_open: false });
    const r = await post("/auth/signup", { email: "stranger@example.com", password: PASSWORD });
    expect(r.status).toBe(403);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM users").first<{ n: number }>())!.n).toBe(1);
    // the owner still signs in
    expect((await post("/auth/signin", { email: "owner@example.com", password: PASSWORD })).status).toBe(200);
  });

  it("gives an account from before passwords to the first person to set one, keeping its boards", async () => {
    env.ALLOW_SIGNUP = undefined;
    await env.DB.prepare("INSERT INTO users (id, email, created_at) VALUES ('u_old', 'old@example.com', '2026-10-01')").run();
    expect((await post("/auth/signin", { email: "old@example.com", password: PASSWORD })).status).toBe(401);
    const s = await signIn("old@example.com");
    expect(s.me.id).toBe("u_old");
    expect((await post("/auth/signup", { email: "old@example.com", password: "taking it over" })).status).toBe(403);
  });

  it("never hands an account from before passwords over on Cloudflare or with open sign-ups", async () => {
    await env.DB.prepare("INSERT INTO users (id, email, created_at) VALUES ('u_old', 'old@example.com', '2026-10-01')").run();
    // open sign-ups (the end-to-end tests): the email is taken
    expect((await post("/auth/signup", { email: "old@example.com", password: PASSWORD })).status).toBe(409);
    // Cloudflare (not this computer): taken too
    env.ALLOW_SIGNUP = undefined;
    env.DEV = "0";
    const r = await app.request("http://hardhub.example.com/auth/signup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "old@example.com", password: PASSWORD }) }, asEnv(env));
    expect(r.status).toBe(409);
    expect((await env.DB.prepare("SELECT password_hash FROM users WHERE id = 'u_old'").first<{ password_hash: string | null }>())!.password_hash).toBeNull();
  });

  it("lets only one of two sign-ups at once become the owner", async () => {
    env.ALLOW_SIGNUP = undefined;
    const rs = await Promise.all(["one@example.com", "two@example.com", "three@example.com"].map((email) => post("/auth/signup", { email, password: PASSWORD })));
    expect(rs.map((r) => r.status).sort()).toEqual([200, 403, 403]);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM users").first<{ n: number }>())!.n).toBe(1);
  });

  it("locks an email from one address for 15 minutes after 10 tries, and only from that address", async () => {
    await signIn("a@example.com");
    const from = (ip: string, password: string) =>
      call("/auth/signin", { method: "POST", headers: { "cf-connecting-ip": ip }, body: JSON.stringify({ email: "a@example.com", password }) });
    // many at once: the count is taken before each check, so none slip past
    const burst = await Promise.all(Array.from({ length: 30 }, (_, i) => from("203.0.113.9", `wrong ${i}`)));
    expect(burst.filter((r) => r.status === 401).length).toBe(10);
    expect(burst.filter((r) => r.status === 429).length).toBe(20);
    expect((await from("203.0.113.9", PASSWORD)).status).toBe(429);
    // the owner, somewhere else, still gets in
    expect((await from("198.51.100.7", PASSWORD)).status).toBe(200);
    for (let i = 0; i < 10; i++) expect((await post("/auth/signin", { email: "a@example.com", password: `wrong ${i}` })).status).toBe(401);
    const locked = await post("/auth/signin", { email: "a@example.com", password: PASSWORD });
    expect(locked.status).toBe(429);
    // after the window the right password works and the count starts over
    await env.DB.prepare("UPDATE login_failures SET first_at = '2026-01-01T00:00:00.000Z'").run();
    expect((await post("/auth/signin", { email: "a@example.com", password: PASSWORD })).status).toBe(200);
    expect(await env.DB.prepare("SELECT * FROM login_failures WHERE key = 'a@example.com|'").first()).toBeNull();
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

  it("answers only to this computer's names when local (no DNS rebinding)", async () => {
    expect((await app.request("http://evil.example/health", {}, asEnv(env))).status).toBe(421);
    for (const host of ["localhost:8787", "127.0.0.1:8787", "192.168.1.20:5173", "api:8787", "[::1]:8787"])
      expect((await app.request(`http://${host}/health`, {}, asEnv(env))).status).toBe(200);
    // Cloudflare has real sign-in: any host
    expect((await app.request("http://hardhub.example.com/health", {}, asEnv({ ...env, DEV: "0" } as TestEnv))).status).toBe(200);
  });

  it("serves the API under /api too (one Worker on Cloudflare)", async () => {
    const ctx = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;
    expect((await worker.fetch(new Request("http://x/api/health"), asEnv(env), ctx)).status).toBe(200);
    // with the web app bound, everything outside /api is the web app
    const assets = { fetch: async () => new Response("<!doctype html>app") } as unknown as Fetcher;
    const page = await worker.fetch(new Request("http://x/p/abc"), { ...asEnv(env), ASSETS: assets }, ctx);
    expect(await page.text()).toContain("app");
  });

  it("rejects bad input with a reason", async () => {
    const r = await post("/auth/signup", { email: "not-an-email", password: PASSWORD });
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
