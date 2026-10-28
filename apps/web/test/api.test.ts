import { beforeEach, describe, expect, it } from "vitest";
import type { ServerEvent } from "@hardhub/protocol";
import { ApiClient, wsUrl } from "../src/lib/api";
import { ApiError } from "../src/lib/backend";

type Call = { url: string; init?: RequestInit };

function fakeFetch(responses: Record<string, { status?: number; body?: unknown }>) {
  const calls: Call[] = [];
  const f = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const key = `${init?.method ?? "GET"} ${new URL(url).pathname}`;
    const r = responses[key];
    if (!r) throw new TypeError("network error");
    return new Response(r.body === undefined ? null : JSON.stringify(r.body), { status: r.status ?? 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { f, calls };
}

const me = { id: "u1", email: "a@b.co", keys: {}, llm: { provider: "anthropic", model: "claude-opus-5-5" } };

class FakeWS {
  static last: FakeWS | null = null;
  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((m: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {
    FakeWS.last = this;
  }
  send(s: string) {
    this.sent.push(s);
  }
  close() {
    this.readyState = 3;
    this.onclose?.();
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
}

beforeEach(() => localStorage.clear());

describe("ApiClient", () => {
  it("signs in with a password and sends the token afterwards", async () => {
    const { f, calls } = fakeFetch({
      "GET /auth/status": { body: { has_account: true, signup_open: false } },
      "POST /auth/signin": { body: { token: "tok", me } },
      "GET /me": { body: me },
    });
    const api = new ApiClient("http://localhost:8787/", f);
    expect(await api.authStatus()).toEqual({ has_account: true, signup_open: false });
    const s = await api.signIn("a@b.co", "correct horse");
    expect(s.token).toBe("tok");
    expect(JSON.parse(String(calls[1]!.init!.body))).toEqual({ email: "a@b.co", password: "correct horse" });
    const m = await api.me();
    expect(m.llm.provider).toBe("anthropic");
    expect((calls[2]!.init!.headers as Record<string, string>).authorization).toBe("Bearer tok");
    expect(localStorage.getItem("hh_token")).toBe("tok");
  });

  it("explains a closed sign-up", async () => {
    const { f } = fakeFetch({ "POST /auth/signup": { status: 403, body: { error: "This HardHub already has its owner. New accounts are not open." } } });
    await expect(new ApiClient("http://h", f).signUp("a@b.co", "correct horse")).rejects.toMatchObject({ status: 403, message: expect.stringContaining("owner") });
  });

  it("turns an error body into an ApiError and forgets a rejected token", async () => {
    const { f } = fakeFetch({ "GET /me": { status: 401, body: { error: "Not signed in" } } });
    const api = new ApiClient("http://localhost:8787", f);
    api.adoptToken("old");
    await expect(api.me()).rejects.toMatchObject({ status: 401, message: "Not signed in" });
    await expect(api.me()).rejects.toBeInstanceOf(ApiError);
    expect(api.token()).toBeNull();
  });

  it("pings: any HTTP answer is reachable, a network error is not", async () => {
    const up = new ApiClient("http://h", fakeFetch({ "GET /health": { status: 404 } }).f);
    const down = new ApiClient("http://h", fakeFetch({}).f);
    expect(await up.ping()).toBe(true);
    expect(await down.ping()).toBe(false);
  });

  it("saves LLM settings and keys on the documented routes", async () => {
    const { f, calls } = fakeFetch({
      "PATCH /me/llm": { body: { ...me, llm: { provider: "ollama", model: "qwen3.5:0.8b", base_url: "http://host.docker.internal:11434/v1" } } },
      "PUT /me/keys/anthropic": { body: { ...me, keys: { anthropic: { last4: "abcd", added_at: "2026-10-28T00:00:00Z" } } } },
    });
    const api = new ApiClient("http://h", f);
    const a = await api.setLlm({ provider: "ollama", model: "qwen3.5:0.8b", base_url: "http://host.docker.internal:11434/v1" });
    expect(a.llm.provider).toBe("ollama");
    const b = await api.saveKey("anthropic", "sk-ant-xyzabcd");
    expect(b.keys.anthropic?.last4).toBe("abcd");
    expect(JSON.parse(String(calls[1]!.init!.body))).toEqual({ key: "sk-ant-xyzabcd" });
  });

  it("derives the WebSocket URL from the API base", () => {
    expect(wsUrl("http://localhost:8787/", "projects/p1/ws", "t", 4)).toBe("ws://localhost:8787/projects/p1/ws?token=t&after=4");
    expect(wsUrl("https://api.hardhub.dev/", "projects/p1/ws", null, -1)).toBe("wss://api.hardhub.dev/projects/p1/ws?after=-1");
  });

  it("puts the token on file URLs and leaves absolute ones alone", () => {
    const api = new ApiClient("http://h", fakeFetch({}).f);
    api.adoptToken("t");
    expect(api.fileUrl("p", "/projects/p/files/board.glb")).toBe("http://h/projects/p/files/board.glb?token=t");
    expect(api.fileUrl("p", "blob:abc")).toBe("blob:abc");
  });

  it("streams events, says hello with the last seq, drops duplicates, and resumes after a drop", async () => {
    const api = new ApiClient("http://h", fakeFetch({}).f, FakeWS as unknown as typeof WebSocket);
    const got: ServerEvent[] = [];
    const link = api.connect("p1", -1, (e) => got.push(e), () => {});
    const ws1 = FakeWS.last!;
    link.send({ type: "message", text: "hi" }); // queued until open
    ws1.open();
    expect(JSON.parse(ws1.sent[0]!)).toEqual({ type: "hello", after: -1 });
    expect(JSON.parse(ws1.sent[1]!)).toMatchObject({ type: "message", text: "hi" });
    const ev = (seq: number) => JSON.stringify({ type: "stage", stage: "parts", seq, at: "2026-10-28T00:00:00Z" });
    ws1.onmessage!({ data: ev(0) });
    ws1.onmessage!({ data: ev(1) });
    ws1.onmessage!({ data: ev(1) });
    // live deltas repeat the last stored seq and must still get through
    const delta = JSON.stringify({ type: "assistant_text", id: "a", text: "Hi", done: false, seq: 1, at: "2026-10-28T00:00:00Z" });
    ws1.onmessage!({ data: delta });
    ws1.onmessage!({ data: delta });
    ws1.onmessage!({ data: "{not json" });
    expect(got.map((e) => `${e.type}:${e.seq}`)).toEqual(["stage:0", "stage:1", "assistant_text:1", "assistant_text:1"]);
    ws1.close(); // server drop: reconnects after a backoff
    await new Promise((r) => setTimeout(r, 600));
    const ws2 = FakeWS.last!;
    expect(ws2).not.toBe(ws1);
    expect(ws2.url).toContain("after=1");
    ws2.open();
    expect(JSON.parse(ws2.sent[0]!)).toEqual({ type: "hello", after: 1 });
    link.close();
  });
});
