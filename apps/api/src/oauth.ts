// Sign-in for agents that connect over MCP: OAuth 2.1 as the MCP spec asks
// for it. The agent finds this server from /.well-known (RFC 9728, RFC 8414),
// registers itself (RFC 7591) or names itself with a metadata URL, sends the
// person here to allow it (the web app's /connect page), and trades the code
// for tokens with PKCE (S256 only). Public clients only: no client secrets.
//
// The endpoints here are public and answer any origin (agents call them from
// their own servers or apps). The consent step itself (/oauth/client,
// /oauth/approve) needs the person's browser session and lives in http.ts.
import { Hono } from "hono";
import { z } from "zod";
import { newId, randomToken, sha256 } from "./crypto";
import type { Env } from "./env";

const CODE_MINUTES = 10;
/** access tokens live a day; agents refresh them */
export const ACCESS_SECONDS = 86_400;
const REFRESH_DAYS = 90;
export const SCOPE = "hardhub";

const now = () => new Date().toISOString();
const later = (ms: number) => new Date(Date.now() + ms).toISOString();

/** Where this server is, as the agent reached it. */
export const issuer = (req: Request) => new URL(req.url).origin;
export const resourceUrl = (req: Request) => `${issuer(req)}/mcp`;
export const resourceMetadataUrl = (req: Request) => `${issuer(req)}/.well-known/oauth-protected-resource/mcp`;

// ------------------------------------------------------------------ clients

export interface Client {
  client_id: string;
  name: string;
  redirect_uris: string[];
  /** a client named by a metadata URL: that URL's host, which the name cannot fake */
  host?: string;
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);
// desktop AI apps that return to their own scheme without a dot in it; any
// other app scheme must be a reverse domain name (com.example.app:), as RFC 8252 asks
const APP_SCHEMES = new Set(["claude:", "cursor:", "vscode:", "vscode-insiders:", "windsurf:", "zed:", "codex:", "chatgpt:"]);

/** A redirect an agent may register: https, http to this computer, or an app's own scheme. */
export function redirectAllowed(uri: string): boolean {
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return false;
  }
  if (u.hash || u.username || u.password) return false;
  if (u.protocol === "https:") return !!u.hostname;
  if (u.protocol === "http:") return LOOPBACK.has(u.hostname);
  return APP_SCHEMES.has(u.protocol) || /^[a-z][a-z0-9-]*(\.[a-z0-9-]+)+:$/.test(u.protocol);
}

/** What the consent page shows as where the person goes back to: the host, or the app's scheme too. */
export function redirectLabel(uri: string): string {
  const u = new URL(uri);
  return u.protocol === "https:" || u.protocol === "http:" ? u.host : `${u.protocol}//${u.host}`;
}

/** Exact match, except that a loopback redirect may use any port (RFC 8252 7.3). */
export function redirectMatches(registered: string[], uri: string): boolean {
  if (registered.includes(uri)) return true;
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return false;
  }
  if (u.protocol !== "http:" || !LOOPBACK.has(u.hostname)) return false;
  return registered.some((r) => {
    try {
      const v = new URL(r);
      return v.protocol === "http:" && v.hostname === u.hostname && v.pathname === u.pathname && v.search === u.search;
    } catch {
      return false;
    }
  });
}

const ClientMetadata = z.object({
  redirect_uris: z.array(z.string().max(2000)).min(1).max(10),
  client_name: z.string().max(200).optional(),
  token_endpoint_auth_method: z.string().optional(),
  grant_types: z.array(z.string()).optional(),
  response_types: z.array(z.string()).optional(),
});

const cleanName = (s: string | undefined) => (s ?? "").replace(/[\u0000-\u001f]/g, "").trim().slice(0, 80) || "An AI app";

/** A client by id: registered here, or an https URL whose JSON describes it
 * (MCP's client ID metadata documents), fetched and cached. */
export async function getClient(env: Env, clientId: string, fetcher: typeof fetch = fetch): Promise<Client | null> {
  if (/^https:\/\//.test(clientId)) return metadataClient(env, clientId, fetcher);
  if (!/^c_[\w-]{8,40}$/.test(clientId)) return null;
  const row = await env.DB.prepare("SELECT client_id, name, redirect_uris FROM oauth_clients WHERE client_id = ?")
    .bind(clientId)
    .first<{ client_id: string; name: string; redirect_uris: string }>();
  return row ? { client_id: row.client_id, name: row.name, redirect_uris: JSON.parse(row.redirect_uris) as string[] } : null;
}

const METADATA_LIMIT = 64_000;
const METADATA_HOURS = 24;

async function metadataClient(env: Env, url: string, fetcher: typeof fetch): Promise<Client | null> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const host = u.hostname.replace(/\.$/, "");
  // a public name, not an address: no fetching this server's own network
  if (u.pathname === "/" || u.port || u.username || /^[\d.]+$|^\[/.test(host) || !host.includes(".") || host === "localhost" || /\.(localhost|local|internal|lan|home|arpa)$/.test(host))
    return null;
  // fetched once a day at most
  const cached = await env.DB.prepare("SELECT name, redirect_uris, created_at FROM oauth_clients WHERE client_id = ?")
    .bind(url)
    .first<{ name: string; redirect_uris: string; created_at: string }>();
  if (cached && Date.parse(cached.created_at) > Date.now() - METADATA_HOURS * 3_600_000)
    return { client_id: url, name: cached.name, redirect_uris: JSON.parse(cached.redirect_uris) as string[], host };
  try {
    const res = await fetcher(url, { headers: { accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(5000) });
    if (!res.ok || !res.body || Number(res.headers.get("content-length") ?? 0) > METADATA_LIMIT) return null;
    // read at most the limit, whatever the server claims
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > METADATA_LIMIT) {
        void reader.cancel();
        return null;
      }
      chunks.push(value);
    }
    const text = new TextDecoder().decode(await new Blob(chunks).arrayBuffer());
    const doc = ClientMetadata.extend({ client_id: z.string() }).parse(JSON.parse(text));
    if (doc.client_id !== url || !doc.redirect_uris.every(redirectAllowed)) return null;
    const client = { client_id: url, name: cleanName(doc.client_name ?? host), redirect_uris: doc.redirect_uris, host };
    await env.DB.prepare(
      `INSERT INTO oauth_clients (client_id, name, redirect_uris, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (client_id) DO UPDATE SET name = excluded.name, redirect_uris = excluded.redirect_uris, created_at = excluded.created_at`,
    )
      .bind(client.client_id, client.name, JSON.stringify(client.redirect_uris), now())
      .run();
    return client;
  } catch {
    return null;
  }
}

/** The client and its redirect, both checked: what the consent page may act on. */
export async function checkRequest(env: Env, clientId: string, redirectUri: string): Promise<Client | string> {
  const client = await getClient(env, clientId);
  if (!client) return "This app is not registered with HardHub. Try connecting it again.";
  if (!redirectMatches(client.redirect_uris, redirectUri)) return "This app asked to return to an address it did not register.";
  return client;
}

// ------------------------------------------------------------------ codes and tokens

export async function createCode(env: Env, userId: string, clientId: string, redirectUri: string, challenge: string): Promise<string> {
  const code = randomToken();
  await env.DB.prepare(
    "INSERT INTO oauth_codes (code_hash, client_id, user_id, redirect_uri, code_challenge, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(await sha256(code), clientId, userId, redirectUri, challenge, now(), later(CODE_MINUTES * 60_000))
    .run();
  return code;
}

interface Tokens {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token: string;
  scope: string;
}

const tokens = (access: string, refresh: string): Tokens => ({
  access_token: access,
  token_type: "Bearer",
  expires_in: ACCESS_SECONDS,
  refresh_token: refresh,
  scope: SCOPE,
});

class OAuthError extends Error {
  constructor(
    readonly error: string,
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

const VERIFIER = /^[A-Za-z0-9\-._~]{43,128}$/;
/** two refreshes with one token this close together are one client racing itself, not a thief */
const REUSE_GRACE_MS = 60_000;

/** Ends one connection: its refresh token, its access tokens, any codes it was made from. */
async function revokeGrant(env: Env, grantId: string) {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM oauth_grants WHERE grant_id = ?").bind(grantId),
    env.DB.prepare("DELETE FROM sessions WHERE grant_id = ?").bind(grantId),
  ]);
}

/** A new access token for a grant, replacing the grant's old ones. Fails if
 * the grant was revoked meanwhile, so a Disconnect racing a refresh wins. */
async function issueAccess(env: Env, grantId: string, userId: string, clientId: string): Promise<string> {
  const token = randomToken();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM sessions WHERE grant_id = ?").bind(grantId),
    env.DB.prepare("INSERT INTO sessions (token_hash, user_id, created_at, expires_at, client_id, grant_id) VALUES (?, ?, ?, ?, ?, ?)").bind(
      await sha256(token),
      userId,
      now(),
      later(ACCESS_SECONDS * 1000),
      clientId,
      grantId,
    ),
  ]);
  const alive = await env.DB.prepare("SELECT 1 AS ok FROM oauth_grants WHERE grant_id = ?").bind(grantId).first();
  if (!alive) {
    await env.DB.prepare("DELETE FROM sessions WHERE grant_id = ?").bind(grantId).run();
    throw new OAuthError("invalid_grant", "this connection was ended");
  }
  return token;
}

async function redeemCode(env: Env, p: Record<string, string>): Promise<Tokens> {
  const { code = "", code_verifier = "", client_id = "", redirect_uri = "" } = p;
  if (!code || !client_id) throw new OAuthError("invalid_request", "code and client_id are required");
  const codeHash = await sha256(code);
  // single statement: a code cannot be spent twice by racing requests
  const row = await env.DB.prepare(
    "UPDATE oauth_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL AND expires_at > ? RETURNING client_id, user_id, redirect_uri, code_challenge",
  )
    .bind(now(), codeHash, now())
    .first<{ client_id: string; user_id: string; redirect_uri: string; code_challenge: string }>();
  if (!row) {
    // a code used twice: whoever holds it, the connection made from it ends (RFC 6749 4.1.2)
    const spent = await env.DB.prepare("SELECT grant_id FROM oauth_codes WHERE code_hash = ? AND used_at IS NOT NULL").bind(codeHash).first<{ grant_id: string | null }>();
    if (spent?.grant_id) await revokeGrant(env, spent.grant_id);
    throw new OAuthError("invalid_grant", "the code is invalid, expired or used");
  }
  if (row.client_id !== client_id) throw new OAuthError("invalid_grant", "the code was issued to another client");
  if (redirect_uri && redirect_uri !== row.redirect_uri) throw new OAuthError("invalid_grant", "redirect_uri does not match");
  if (!VERIFIER.test(code_verifier) || (await sha256(code_verifier)) !== row.code_challenge) throw new OAuthError("invalid_grant", "code_verifier does not match");
  const grantId = newId("g");
  const refresh = randomToken();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO oauth_grants (refresh_hash, access_hash, client_id, user_id, connected_at, refreshed_at, expires_at, grant_id) VALUES (?, '', ?, ?, ?, ?, ?, ?)",
    ).bind(await sha256(refresh), client_id, row.user_id, now(), now(), later(REFRESH_DAYS * 86_400_000), grantId),
    env.DB.prepare("UPDATE oauth_codes SET grant_id = ? WHERE code_hash = ?").bind(grantId, codeHash),
  ]);
  return tokens(await issueAccess(env, grantId, row.user_id, client_id), refresh);
}

async function refresh(env: Env, p: Record<string, string>): Promise<Tokens> {
  const { refresh_token = "", client_id = "" } = p;
  if (!refresh_token) throw new OAuthError("invalid_request", "refresh_token is required");
  const oldHash = await sha256(refresh_token);
  const next = randomToken();
  // rotate in place, in one statement: the old token is spent, and a grant
  // that Disconnect removed has no row left to rotate
  const row = await env.DB.prepare(
    `UPDATE oauth_grants SET refresh_hash = ?, prev_hash = refresh_hash, rotated_at = ?, refreshed_at = ?, expires_at = ?
     WHERE refresh_hash = ? AND expires_at > ? AND (? = '' OR client_id = ?) RETURNING grant_id, client_id, user_id`,
  )
    .bind(await sha256(next), now(), now(), later(REFRESH_DAYS * 86_400_000), oldHash, now(), client_id, client_id)
    .first<{ grant_id: string; client_id: string; user_id: string }>();
  if (!row) {
    // the token before the current one, used again: two copies exist. A
    // client racing itself gets a plain refusal; later, the connection ends.
    const reused = await env.DB.prepare("SELECT grant_id, rotated_at FROM oauth_grants WHERE prev_hash = ?").bind(oldHash).first<{ grant_id: string; rotated_at: string }>();
    if (reused && Date.parse(reused.rotated_at) < Date.now() - REUSE_GRACE_MS) await revokeGrant(env, reused.grant_id);
    throw new OAuthError("invalid_grant", "the refresh token is invalid, expired or already used");
  }
  return tokens(await issueAccess(env, row.grant_id, row.user_id, row.client_id), next);
}

// ------------------------------------------------------------------ the person's connections

export async function listConnections(env: Env, userId: string) {
  const { results } = await env.DB.prepare(
    `SELECT g.client_id, COALESCE(c.name, g.client_id) AS name, MIN(g.connected_at) AS connected_at, MAX(g.refreshed_at) AS renewed_at
     FROM oauth_grants g LEFT JOIN oauth_clients c ON c.client_id = g.client_id
     WHERE g.user_id = ? AND g.expires_at > ? GROUP BY g.client_id ORDER BY renewed_at DESC`,
  )
    .bind(userId, now())
    .all<{ client_id: string; name: string; connected_at: string; renewed_at: string }>();
  return results;
}

/** Signs an agent out everywhere: its refresh tokens, its access tokens, and
 * any code the person allowed that it has not redeemed yet. */
export async function revokeConnection(env: Env, userId: string, clientId: string) {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM oauth_grants WHERE user_id = ? AND client_id = ?").bind(userId, clientId),
    env.DB.prepare("DELETE FROM sessions WHERE user_id = ? AND client_id = ?").bind(userId, clientId),
    env.DB.prepare("DELETE FROM oauth_codes WHERE user_id = ? AND client_id = ? AND used_at IS NULL").bind(userId, clientId),
  ]);
}

// ------------------------------------------------------------------ public endpoints

export const oauth = new Hono<{ Bindings: Env }>();

const protectedResource = (req: Request) => ({
  resource: resourceUrl(req),
  authorization_servers: [issuer(req)],
  scopes_supported: [SCOPE],
  bearer_methods_supported: ["header"],
  resource_name: "HardHub",
});

oauth.get("/.well-known/oauth-protected-resource", (c) => c.json(protectedResource(c.req.raw)));
oauth.get("/.well-known/oauth-protected-resource/mcp", (c) => c.json(protectedResource(c.req.raw)));

oauth.get("/.well-known/oauth-authorization-server", (c) => {
  const iss = issuer(c.req.raw);
  return c.json({
    issuer: iss,
    authorization_endpoint: `${iss}/oauth/authorize`,
    token_endpoint: `${iss}/oauth/token`,
    registration_endpoint: `${iss}/oauth/register`,
    scopes_supported: [SCOPE],
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: ["none"],
    code_challenge_methods_supported: ["S256"],
    client_id_metadata_document_supported: true,
  });
});

oauth.post("/oauth/register", async (c) => {
  let meta: z.infer<typeof ClientMetadata>;
  try {
    meta = ClientMetadata.parse(await c.req.json());
  } catch {
    return c.json({ error: "invalid_client_metadata", error_description: "redirect_uris (1-10 addresses) is required" }, 400);
  }
  const bad = meta.redirect_uris.find((u) => !redirectAllowed(u));
  if (bad) return c.json({ error: "invalid_redirect_uri", error_description: `not allowed: ${bad.slice(0, 200)}` }, 400);
  const client: Client = { client_id: newId("c"), name: cleanName(meta.client_name), redirect_uris: meta.redirect_uris };
  await c.env.DB.prepare("INSERT INTO oauth_clients (client_id, name, redirect_uris, created_at) VALUES (?, ?, ?, ?)")
    .bind(client.client_id, client.name, JSON.stringify(client.redirect_uris), now())
    .run();
  return c.json(
    {
      client_id: client.client_id,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      client_name: client.name,
      redirect_uris: client.redirect_uris,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: SCOPE,
    },
    201,
  );
});

// The agent sends the person here. Checked, then handed to the web app's
// consent page, which needs the person signed in.
oauth.get("/oauth/authorize", async (c) => {
  const q = c.req.query();
  const client = q.client_id ? await getClient(c.env, q.client_id) : null;
  // without a trusted redirect, errors are shown here, never redirected
  if (!client) return c.text("HardHub doesn't know this app. Remove it from your AI app and connect it again.", 400);
  const redirectUri = q.redirect_uri ?? (client.redirect_uris.length === 1 ? client.redirect_uris[0]! : "");
  if (!redirectMatches(client.redirect_uris, redirectUri)) return c.text("This app asked to return to an address it did not register.", 400);

  // Anyone can register a client and its redirect, so before the person has
  // said yes, a bad request is shown here and never sent on to that address
  // (sending it would make HardHub a link that bounces people anywhere).
  const refuse = (why: string) => c.text(`This app's sign-in request is not valid: ${why}. Try connecting it again.`, 400);
  if (q.response_type !== "code") return refuse("only response_type=code is supported");
  if (!q.code_challenge || q.code_challenge_method !== "S256" || !/^[A-Za-z0-9\-_]{43,128}$/.test(q.code_challenge))
    return refuse("PKCE with code_challenge_method=S256 is required");
  if (q.resource && q.resource.replace(/\/$/, "") !== resourceUrl(c.req.raw)) return refuse(`this server is ${resourceUrl(c.req.raw)}`);

  const consent = new URL("/connect", c.env.APP_URL || issuer(c.req.raw));
  for (const k of ["client_id", "code_challenge", "state", "resource", "scope"] as const) if (q[k]) consent.searchParams.set(k, q[k]);
  consent.searchParams.set("redirect_uri", redirectUri);
  return c.redirect(consent.toString(), 302);
});

oauth.post("/oauth/token", async (c) => {
  const type = c.req.header("content-type") ?? "";
  let p: Record<string, string> = {};
  try {
    if (type.includes("application/json")) p = (await c.req.json()) as Record<string, string>;
    else for (const [k, v] of new URLSearchParams(await c.req.text())) p[k] = v;
  } catch {
    return c.json({ error: "invalid_request", error_description: "unreadable body" }, 400);
  }
  c.header("cache-control", "no-store");
  try {
    if (p.grant_type === "authorization_code") return c.json(await redeemCode(c.env, p));
    if (p.grant_type === "refresh_token") return c.json(await refresh(c.env, p));
    return c.json({ error: "unsupported_grant_type", error_description: "authorization_code or refresh_token" }, 400);
  } catch (e) {
    if (e instanceof OAuthError) return c.json({ error: e.error, error_description: e.message }, e.status as 400);
    throw e;
  }
});
