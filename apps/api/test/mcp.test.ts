// HardHub over MCP, driven by the official MCP client: an agent discovers the
// sign-in, registers itself, the person allows it on the consent page, and
// the agent designs and builds a board in a project the web app shows.
import type { Design, JobLine } from "@hardhub/protocol";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { type OAuthClientProvider, UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { OAuthClientInformationMixed, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { beforeEach, describe, expect, it } from "vitest";
import { sha256 } from "../src/crypto";
import { app } from "../src/http";
import worker from "../src/index";
import { redirectAllowed, redirectMatches } from "../src/oauth";
import { type TestEnv, asEnv, testEnv } from "./support/env";
import { FakeEngine } from "./support/room";

const BASE = "http://hardhub.test";
const CALLBACK = "http://127.0.0.1:33418/callback";

/** a fake engine whose builds also make a BOM, so read_file has text to read */
class BomEngine extends FakeEngine {
  override async *build(design: Design, job: string): AsyncIterable<JobLine> {
    for await (const line of super.build(design, job)) {
      if ("done" in line) yield { ...line, artifacts: [...line.artifacts, { kind: "bom", name: "bom.csv", url: `/jobs/${job}/files/bom.csv` }] };
      else yield line;
    }
  }
  override async file(job: string, name: string) {
    if (name.endsWith(".csv")) return new Response("Comment,Designator,Footprint,LCSC\n10k,R1,R_0603,C25804\n", { headers: { "content-type": "text/csv" } });
    return super.file(job, name);
  }
}

class Agent implements OAuthClientProvider {
  info?: OAuthClientInformationMixed;
  toks?: OAuthTokens;
  verifier = "";
  authUrl: URL | null = null;
  readonly redirectUrl = CALLBACK;
  get clientMetadata() {
    return { client_name: "Test agent", redirect_uris: [CALLBACK], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" };
  }
  clientInformation() {
    return this.info;
  }
  saveClientInformation(i: OAuthClientInformationMixed) {
    this.info = i;
  }
  tokens() {
    return this.toks;
  }
  saveTokens(t: OAuthTokens) {
    this.toks = t;
  }
  redirectToAuthorization(u: URL) {
    this.authUrl = u;
  }
  saveCodeVerifier(v: string) {
    this.verifier = v;
  }
  codeVerifier() {
    return this.verifier;
  }
}

let env: TestEnv;
beforeEach(() => {
  env = testEnv(new BomEngine());
});

/** the Worker as the network: every request the client makes lands here */
const net = async (input: string | URL | Request, init?: RequestInit) => app.request(new Request(input, init), undefined, asEnv(env));

const call = (path: string, init: RequestInit & { token?: string } = {}) => {
  const headers = new Headers(init.headers);
  if (init.token) headers.set("authorization", `Bearer ${init.token}`);
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  return app.request(BASE + path, { ...init, headers }, asEnv(env));
};

async function browserSession(email = "maker@example.com") {
  const start = (await (await call("/auth/start", { method: "POST", body: JSON.stringify({ email }) })).json()) as { token: string };
  return ((await (await call("/auth/verify", { method: "POST", body: JSON.stringify({ token: start.token }) })).json()) as { token: string }).token;
}

/** The whole sign-in: the client is refused, the person allows it, the client connects. */
async function connect(email = "maker@example.com") {
  const agent = new Agent();
  const first = new Client({ name: "test-agent", version: "1.0.0" });
  await expect(first.connect(new StreamableHTTPClientTransport(new URL(BASE + "/mcp"), { authProvider: agent, fetch: net }))).rejects.toBeInstanceOf(UnauthorizedError);
  expect(agent.authUrl).toBeTruthy();

  // the person's browser follows the link: HardHub checks it and sends them to the consent page
  const authorize = await net(agent.authUrl!.toString());
  expect(authorize.status).toBe(302);
  const consent = new URL(authorize.headers.get("location")!);
  expect(consent.origin + consent.pathname).toBe("http://localhost:5173/connect");
  const q = Object.fromEntries(consent.searchParams);

  // signed in, the page asks who this is, then sends the answer
  const browser = await browserSession(email);
  const info = (await (await call(`/oauth/client?client_id=${encodeURIComponent(q.client_id!)}&redirect_uri=${encodeURIComponent(q.redirect_uri!)}`, { token: browser })).json()) as { name: string; redirect_host: string };
  expect(info).toMatchObject({ name: "Test agent", redirect_host: "127.0.0.1:33418" });
  const approved = (await (await call("/oauth/approve", { method: "POST", token: browser, body: JSON.stringify({ ...q, allow: true }) })).json()) as { redirect: string };
  const back = new URL(approved.redirect);
  expect(back.origin + back.pathname).toBe(CALLBACK);
  expect(back.searchParams.get("state")).toBe(q.state ?? null);

  const transport = new StreamableHTTPClientTransport(new URL(BASE + "/mcp"), { authProvider: agent, fetch: net });
  await transport.finishAuth(back.searchParams.get("code")!);
  const client = new Client({ name: "test-agent", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(BASE + "/mcp"), { authProvider: agent, fetch: net }));
  return { client, agent, browser };
}

const textOf = (r: unknown) => ((r as { content: { type: string; text?: string }[] }).content.find((c) => c.type === "text")?.text ?? "");

const SENSOR: Design = {
  schema: 1,
  name: "Soil sensor",
  revision: "v1",
  summary: "",
  stage: "circuit",
  requirements: [],
  decisions: [],
  blocks: { main: { name: "Main", purpose: "everything" } },
  parts: { R10K: { mpn: "0603WAF1002T5E", maker: "UNI-ROYAL", kind: "R", value: "10k", description: "10k resistor", footprint: "Resistor_SMD:R_0603_1608Metric", lifecycle: "active", assembled: true } },
  components: [
    { ref: "R1", part: "R10K", block: "main", pins: { "1": "VCC", "2": "SENSE" } },
    { ref: "R2", part: "R10K", block: "main", pins: { "1": "SENSE", "2": "GND" } },
  ],
  nets: {},
  placement: {},
  firmware: { platform: "none", pins: [], files: {} },
};

describe("agent sign-in (OAuth 2.1)", () => {
  it("publishes where to sign in", async () => {
    const challenge = await call("/mcp", { method: "POST", body: "{}" });
    expect(challenge.status).toBe(401);
    expect(challenge.headers.get("www-authenticate")).toContain(`resource_metadata="${BASE}/.well-known/oauth-protected-resource/mcp"`);
    const pr = (await (await call("/.well-known/oauth-protected-resource/mcp")).json()) as Record<string, unknown>;
    expect(pr).toMatchObject({ resource: `${BASE}/mcp`, authorization_servers: [BASE] });
    const as = (await (await call("/.well-known/oauth-authorization-server")).json()) as Record<string, unknown>;
    expect(as).toMatchObject({ issuer: BASE, code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["none"] });
  });

  it("answers agents from any origin, the rest of the API only the web app", async () => {
    const pre = await call("/mcp", { method: "OPTIONS", headers: { origin: "https://claude.ai", "access-control-request-method": "POST" } });
    expect(pre.headers.get("access-control-allow-origin")).toBe("*");
    const rest = await call("/me", { method: "OPTIONS", headers: { origin: "https://claude.ai", "access-control-request-method": "GET" } });
    expect(rest.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("reaches MCP and sign-in at the root on Cloudflare too", async () => {
    const ctx = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;
    const assets = { fetch: async () => new Response("app") } as unknown as Fetcher;
    const e = { ...asEnv(env), ASSETS: assets };
    expect((await worker.fetch(new Request(`${BASE}/mcp`, { method: "POST" }), e, ctx)).status).toBe(401);
    expect((await worker.fetch(new Request(`${BASE}/.well-known/oauth-authorization-server`), e, ctx)).status).toBe(200);
    expect(await (await worker.fetch(new Request(`${BASE}/connect?x=1`), e, ctx)).text()).toBe("app");
  });

  it("allows only safe redirect addresses", () => {
    expect(redirectAllowed("https://claude.ai/api/mcp/auth_callback")).toBe(true);
    expect(redirectAllowed("http://127.0.0.1:5555/cb")).toBe(true);
    expect(redirectAllowed("http://localhost/cb")).toBe(true);
    expect(redirectAllowed("cursor://anysphere.cursor-retrieval/oauth/callback")).toBe(true);
    expect(redirectAllowed("http://evil.example/cb")).toBe(false);
    expect(redirectAllowed("javascript:alert(1)")).toBe(false);
    expect(redirectAllowed("https://x.example/cb#frag")).toBe(false);
    // a loopback redirect may change port, nothing else may change
    expect(redirectMatches(["http://127.0.0.1:1/cb"], "http://127.0.0.1:9999/cb")).toBe(true);
    expect(redirectMatches(["http://127.0.0.1:1/cb"], "http://127.0.0.1:9999/other")).toBe(false);
    expect(redirectMatches(["https://a.example/cb"], "https://a.example/cb2")).toBe(false);
  });

  it("refuses registrations and requests it cannot trust", async () => {
    expect((await call("/oauth/register", { method: "POST", body: JSON.stringify({ redirect_uris: ["http://evil.example/cb"] }) })).status).toBe(400);
    expect((await call("/oauth/register", { method: "POST", body: JSON.stringify({}) })).status).toBe(400);
    const reg = (await (await call("/oauth/register", { method: "POST", body: JSON.stringify({ client_name: "X", redirect_uris: [CALLBACK] }) })).json()) as { client_id: string };
    // unknown client or unregistered redirect: an error page, never a redirect
    expect((await call(`/oauth/authorize?client_id=nope&redirect_uri=${CALLBACK}`)).status).toBe(400);
    expect((await call(`/oauth/authorize?client_id=${reg.client_id}&redirect_uri=https://evil.example/cb`)).status).toBe(400);
    // no PKCE: back to the agent with an error
    const noPkce = await call(`/oauth/authorize?response_type=code&client_id=${reg.client_id}&redirect_uri=${CALLBACK}&state=s1`);
    expect(noPkce.status).toBe(302);
    expect(noPkce.headers.get("location")).toContain("error=invalid_request");
    expect(noPkce.headers.get("location")).toContain("state=s1");
  });

  it("checks PKCE, spends a code once, rotates refresh tokens, and keeps agent tokens off the rest of the API", async () => {
    const reg = (await (await call("/oauth/register", { method: "POST", body: JSON.stringify({ client_name: "X", redirect_uris: [CALLBACK] }) })).json()) as { client_id: string };
    const browser = await browserSession();
    const verifier = "v".repeat(50);
    const challenge = await sha256(verifier);
    const code = async () => {
      const r = (await (await call("/oauth/approve", { method: "POST", token: browser, body: JSON.stringify({ client_id: reg.client_id, redirect_uri: CALLBACK, code_challenge: challenge, allow: true }) })).json()) as { redirect: string };
      return new URL(r.redirect).searchParams.get("code")!;
    };
    const token = (p: Record<string, string>) =>
      call("/oauth/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(p).toString() });

    const c1 = await code();
    expect((await token({ grant_type: "authorization_code", code: c1, client_id: reg.client_id, redirect_uri: CALLBACK, code_verifier: "w".repeat(50) })).status).toBe(400);
    // the wrong verifier spent it: a code works once, whatever happened
    expect((await token({ grant_type: "authorization_code", code: c1, client_id: reg.client_id, redirect_uri: CALLBACK, code_verifier: verifier })).status).toBe(400);

    const ok = await token({ grant_type: "authorization_code", code: await code(), client_id: reg.client_id, redirect_uri: CALLBACK, code_verifier: verifier });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("cache-control")).toBe("no-store");
    const t1 = (await ok.json()) as { access_token: string; refresh_token: string; expires_in: number };
    expect(t1.expires_in).toBe(86400);

    // an agent's token opens MCP, not the rest of the API
    expect((await call("/me", { token: t1.access_token })).status).toBe(401);
    const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } };
    const mcp = await call("/mcp", { method: "POST", token: t1.access_token, headers: { accept: "application/json, text/event-stream" }, body: JSON.stringify(init) });
    expect(mcp.status).toBe(200);

    const r = await token({ grant_type: "refresh_token", refresh_token: t1.refresh_token, client_id: reg.client_id });
    expect(r.status).toBe(200);
    const t2 = (await r.json()) as { access_token: string; refresh_token: string };
    expect((await token({ grant_type: "refresh_token", refresh_token: t1.refresh_token })).status).toBe(400);
    // the refreshed-away access token stops working
    expect((await call("/mcp", { method: "POST", token: t1.access_token, headers: { accept: "application/json, text/event-stream" }, body: JSON.stringify(init) })).status).toBe(401);

    // the person sees the connection, and can end it
    const list = (await (await call("/connections", { token: browser })).json()) as { mcp_url: string; connections: { client_id: string; name: string }[] };
    expect(list.mcp_url).toBe("http://localhost:5173/mcp");
    expect(list.connections).toMatchObject([{ client_id: reg.client_id, name: "X" }]);
    expect((await call(`/connections/${reg.client_id}`, { method: "DELETE", token: browser })).status).toBe(204);
    expect((await call("/mcp", { method: "POST", token: t2.access_token, headers: { accept: "application/json, text/event-stream" }, body: JSON.stringify(init) })).status).toBe(401);
    expect((await token({ grant_type: "refresh_token", refresh_token: t2.refresh_token })).status).toBe(400);
  });

  it("sends a refusal back to the agent", async () => {
    const reg = (await (await call("/oauth/register", { method: "POST", body: JSON.stringify({ redirect_uris: [CALLBACK] }) })).json()) as { client_id: string };
    const browser = await browserSession();
    const r = (await (await call("/oauth/approve", { method: "POST", token: browser, body: JSON.stringify({ client_id: reg.client_id, redirect_uri: CALLBACK, code_challenge: "c".repeat(43), state: "xyz", allow: false }) })).json()) as { redirect: string };
    const u = new URL(r.redirect);
    expect(u.searchParams.get("error")).toBe("access_denied");
    expect(u.searchParams.get("code")).toBeNull();
    expect(u.searchParams.get("state")).toBe("xyz");
  });
});

describe("designing over MCP", () => {
  it("signs in like a real client and designs, builds and reads a board", async () => {
    const { client, browser } = await connect();
    const tools = (await client.listTools()).tools.map((t) => t.name);
    expect(tools).toEqual(expect.arrayContaining(["guide", "list_projects", "create_project", "get_design", "update_design", "check_circuit", "build_board", "wait_for_build", "render", "note", "get_files", "read_file"]));
    expect(tools).not.toContain("ask_user");
    expect(client.getInstructions()).toContain("guide");

    const guide = textOf(await client.callTool({ name: "guide", arguments: {} }));
    expect(guide).toContain("Working through MCP");
    expect(guide).toContain("The design document");

    const created = textOf(await client.callTool({ name: "create_project", arguments: { name: "Soil sensor", request: "A soil moisture sensor for my garden" } }));
    const id = /project (p_[\w-]+)/.exec(created)![1]!;
    expect(created).toContain(`http://localhost:5173/p/${id}`);

    const bad = await client.callTool({ name: "update_design", arguments: { project: id, summary: "Bad patch", patch: [{ op: "replace", path: "/board/width", value: 10 }] } });
    expect(bad.isError).toBe(true);

    const patch = [
      { op: "replace", path: "/blocks", value: SENSOR.blocks },
      { op: "replace", path: "/parts", value: SENSOR.parts },
      { op: "replace", path: "/components", value: SENSOR.components },
      { op: "add", path: "/board", value: { width: 30, height: 20, layers: 2 } },
    ];
    const saved = await client.callTool({ name: "update_design", arguments: { project: id, summary: "Two resistors on a 30 x 20 mm board", patch } });
    expect(saved.isError).toBeFalsy();
    expect(textOf(await client.callTool({ name: "check_circuit", arguments: { project: id } }))).toContain("Checks:");

    const build = await client.callTool({ name: "build_board", arguments: { project: id } });
    expect(build.isError).toBeFalsy();
    expect(textOf(build)).toContain("Build finished.");
    expect(textOf(await client.callTool({ name: "wait_for_build", arguments: { project: id } }))).toContain("Build finished.");

    const render = await client.callTool({ name: "render", arguments: { project: id } });
    expect((render.content as { type: string; mimeType?: string }[]).some((c) => c.type === "image" && c.mimeType === "image/png")).toBe(true);

    const files = textOf(await client.callTool({ name: "get_files", arguments: { project: id } }));
    expect(files).toContain("b1-bom.csv");
    expect(textOf(await client.callTool({ name: "read_file", arguments: { project: id, name: "b1-bom.csv" } }))).toContain("C25804");
    expect((await client.callTool({ name: "read_file", arguments: { project: id, name: "b1-board.glb" } })).isError).toBe(true);

    await client.callTool({ name: "note", arguments: { project: id, text: "Two 10k resistors make a divider for the probe." } });

    // the web app sees all of it, in order
    const page = (await (await call(`/projects/${id}/events?after=-1&limit=1000`, { token: browser })).json()) as { events: { type: string; text?: string; name?: string; status?: string }[] };
    const types = page.events.map((e) => e.type);
    expect(page.events[0]).toMatchObject({ type: "user_message", text: "A soil moisture sensor for my garden" });
    expect(types).toEqual(expect.arrayContaining(["design", "checks", "job", "artifacts"]));
    expect(page.events.some((e) => e.type === "tool" && e.name === "build_board" && e.status === "done")).toBe(true);
    expect(page.events.at(-2)).toMatchObject({ type: "assistant_text", text: "Two 10k resistors make a divider for the probe." });
    // every agent action ends like a reply does, so the app is never left "working"
    expect(page.events.at(-1)).toMatchObject({ type: "turn_end", reason: "done" });
    const buildEnd = page.events.findIndex((e) => e.type === "tool" && e.name === "build_board" && e.status === "done");
    expect(page.events[buildEnd + 1]?.type === "turn_end" || page.events.slice(buildEnd).some((e) => e.type === "turn_end")).toBe(true);
    const detail = (await (await call(`/projects/${id}`, { token: browser })).json()) as { design: Design };
    expect(Object.keys(detail.design.placement)).toContain("U1"); // the engine's automatic placement, kept

    const list = textOf(await client.callTool({ name: "list_projects", arguments: {} }));
    expect(list).toContain(id);
  });

  it("keeps an agent out of other people's projects", async () => {
    const { client } = await connect("a@example.com");
    const other = await browserSession("b@example.com");
    const theirs = (await (await call("/projects", { method: "POST", token: other, body: JSON.stringify({ name: "Theirs" }) })).json()) as { id: string };
    const r = await client.callTool({ name: "get_design", arguments: { project: theirs.id } });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("no project");
  });

  it("hands back progress when a build takes longer than one call", async () => {
    const { client } = await connect();
    const id = /project (p_[\w-]+)/.exec(textOf(await client.callTool({ name: "create_project", arguments: { name: "Slow" } })))![1]!;
    await client.callTool({ name: "update_design", arguments: { project: id, summary: "Board", patch: [{ op: "add", path: "/board", value: { width: 30, height: 20, layers: 2 } }] } });
    // a build that is still running when the call's wait runs out
    const core = env.ROOMS.core(id);
    (core as unknown as { setMeta(k: string, v: string): void }).setMeta("agent_build", JSON.stringify({ id: "x1", input: {}, state: "running", step: "route", progress: 0.6 }));
    const { buildServer } = await import("../src/mcp");
    const server = buildServer({ env: asEnv(env), userId: (await env.DB.prepare("SELECT id FROM users").first<{ id: string }>())!.id, appUrl: "http://localhost:5173", room: (p) => env.ROOMS.get(p) as never, waitMs: 0, sleep: async () => {} });
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    const direct = new Client({ name: "t", version: "1" });
    await direct.connect(b);
    const r = await direct.callTool({ name: "wait_for_build", arguments: { project: id } });
    expect(textOf(r)).toBe("Still building: route (60%). Call wait_for_build to keep waiting.");
    // and a second build is refused while one runs
    expect(textOf(await client.callTool({ name: "build_board", arguments: { project: id } }))).toContain("already running");
  });

  it("waits while HardHub's own AI is answering in the same project", async () => {
    const { client } = await connect();
    const id = /project (p_[\w-]+)/.exec(textOf(await client.callTool({ name: "create_project", arguments: { name: "Busy" } })))![1]!;
    env.ROOMS.core(id).queue({ text: "hello" });
    const r = await client.callTool({ name: "get_design", arguments: { project: id } });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("own AI");
  });
});
