// The REST API (packages/protocol/src/api.ts) and the WebSocket entry.
import { type Connections, LlmProvider, LlmSettings, OAuthApprove, type ProjectDetail } from "@hardhub/protocol";
import { Hono, type Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { cors } from "hono/cors";
import { z } from "zod";
import { devLlmDefaults } from "./agent/llm";
import { contentType } from "./agent/tools";
import * as db from "./db";
import { type Env, isDev } from "./env";
import { mailer } from "./mail";
import { CHAT_CLIENT, bridgeFor } from "./bridge";
import { appUrlFor, handleMcp } from "./mcp";
import { checkRequest, createCode, listConnections, oauth, redirectLabel, resourceMetadataUrl, revokeConnection, SCOPE } from "./oauth";

type Ctx = { Bindings: Env; Variables: { userId: string; token: string } };
type C = Context<Ctx>;

const COOKIE = "hh_session";

export const app = new Hono<Ctx>();

// MCP and the agent sign-in endpoints answer any origin (agents call them
// from their own servers and apps) and never read cookies. The rest of the
// API answers only the web app's origins.
const PUBLIC = /^\/(mcp$|oauth\/(register|token|authorize)$|\.well-known\/)/;
const publicCors = cors({
  origin: "*",
  allowHeaders: ["authorization", "content-type", "mcp-protocol-version", "mcp-session-id", "last-event-id"],
  exposeHeaders: ["mcp-session-id", "mcp-protocol-version", "www-authenticate"],
  allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
  maxAge: 600,
});

app.use("*", async (c, next) => {
  if (PUBLIC.test(c.req.path)) return publicCors(c, next);
  const origins = c.env.WEB_ORIGINS.split(",").map((s) => s.trim());
  return cors({ origin: (o) => (origins.includes(o) ? o : null), credentials: true, maxAge: 600 })(c, next);
});

class NotFound extends Error {}

app.onError((err, c) => {
  if (err instanceof NotFound) return c.json({ error: "no such project" }, 404);
  if (err instanceof SyntaxError) return c.json({ error: "invalid JSON" }, 400);
  if (err instanceof z.ZodError) return c.json({ error: "invalid request", detail: err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") }, 400);
  console.error(err);
  return c.json({ error: "internal error" }, 500);
});

app.get("/health", (c) => c.json({ ok: true }));

// ------------------------------------------------------------------ MCP

app.route("/", oauth);

app.all("/mcp", async (c) => {
  const token = c.req.header("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  const owner = token ? await db.agentTokenOwner(c.env, token) : null;
  if (!owner) {
    // tells the agent where to sign in (RFC 9728)
    const challenge = `Bearer resource_metadata="${resourceMetadataUrl(c.req.raw)}", scope="${SCOPE}"${token ? ', error="invalid_token"' : ""}`;
    return c.json({ error: "invalid_token", error_description: "Sign in to HardHub first." }, 401, { "WWW-Authenticate": challenge });
  }
  return handleMcp(c.req.raw, {
    env: c.env,
    userId: owner.userId,
    appUrl: appUrlFor(c.env, c.req.raw),
    room: (id) => room(c.env, id),
    fromChat: owner.clientId === CHAT_CLIENT,
  });
});

// ------------------------------------------------------------------ auth

const tokenFrom = (c: C) =>
  c.req.header("authorization")?.replace(/^Bearer\s+/i, "") || getCookie(c, COOKIE) || c.req.query("token") || "";

const auth = async (c: C, next: () => Promise<void>) => {
  const token = tokenFrom(c);
  const userId = token ? await db.sessionUser(c.env, token) : null;
  if (!userId) return c.json({ error: "sign in first" }, 401);
  c.set("userId", userId);
  c.set("token", token);
  await next();
};

const Email = z.object({ email: z.string().trim().toLowerCase().email().max(254) });

app.post("/auth/start", async (c) => {
  const { email } = Email.parse(await c.req.json());
  const token = await db.createLoginToken(c.env, email);
  const link = `${c.env.APP_URL || new URL(c.req.url).origin}/auth/verify?token=${encodeURIComponent(token)}`;
  if (isDev(c.env)) {
    // local development: no email; the app signs straight in with this
    console.log(`sign-in link for ${email}: ${link}`);
    return c.json({ dev_link: link, token });
  }
  try {
    await mailer(c.env).sendSignInLink(email, link);
  } catch (e) {
    console.error(e);
    return c.json({ error: e instanceof Error ? e.message : "the sign-in email could not be sent" }, 503);
  }
  return c.body(null, 204);
});

app.post("/auth/verify", async (c) => {
  const { token } = z.object({ token: z.string().min(10).max(200) }).parse(await c.req.json());
  const s = await db.redeemLoginToken(c.env, token, devLlmDefaults(c.env));
  if (!s) return c.json({ error: "this sign-in link is invalid or used" }, 401);
  setCookie(c, COOKIE, s.token, {
    httpOnly: true,
    secure: !isDev(c.env),
    // the web app and the API share one origin on Cloudflare
    sameSite: "Lax",
    path: "/",
    maxAge: 30 * 86400,
  });
  return c.json({ token: s.token, me: await db.getMe(c.env, s.userId) });
});

app.post("/auth/logout", auth, async (c) => {
  await db.deleteSession(c.env, c.get("token"));
  deleteCookie(c, COOKIE, { path: "/" });
  return c.body(null, 204);
});

// ------------------------------------------------------------------ me

app.get("/me", auth, async (c) => c.json(await db.getMe(c.env, c.get("userId"))));

// can HardHub's chat run on the person's own Claude Code? (local only)
app.get("/bridge", auth, async (c) => {
  const b = bridgeFor(c.env);
  return c.json(b ? await b.health() : { available: false, error: "Only when HardHub runs on your computer with ./hardhub and Claude Code is installed." });
});

// ------------------------------------------------------------------ connected agents

app.get("/connections", auth, async (c) => {
  const mcp_url = c.env.MCP_URL || `${appUrlFor(c.env, c.req.raw)}/mcp`;
  return c.json({ mcp_url, connections: await listConnections(c.env, c.get("userId")) } satisfies Connections);
});

app.delete("/connections/:client", auth, async (c) => {
  await revokeConnection(c.env, c.get("userId"), c.req.param("client") ?? "");
  return c.body(null, 204);
});

// the consent page: who is asking, then the person's answer
app.get("/oauth/client", auth, async (c) => {
  const r = await checkRequest(c.env, c.req.query("client_id") ?? "", c.req.query("redirect_uri") ?? "");
  if (typeof r === "string") return c.json({ error: r }, 400);
  return c.json({ client_id: r.client_id, name: r.name, redirect_host: redirectLabel(c.req.query("redirect_uri")!), ...(r.host ? { client_host: r.host } : {}) });
});

app.post("/oauth/approve", auth, async (c) => {
  const a = OAuthApprove.parse(await c.req.json());
  const r = await checkRequest(c.env, a.client_id, a.redirect_uri);
  if (typeof r === "string") return c.json({ error: r }, 400);
  if (!/^[A-Za-z0-9\-_]{43,128}$/.test(a.code_challenge)) return c.json({ error: "invalid code_challenge" }, 400);
  const u = new URL(a.redirect_uri);
  if (a.allow) u.searchParams.set("code", await createCode(c.env, c.get("userId"), r.client_id, a.redirect_uri, a.code_challenge));
  else {
    u.searchParams.set("error", "access_denied");
    u.searchParams.set("error_description", "The person did not allow access.");
  }
  if (a.state) u.searchParams.set("state", a.state);
  return c.json({ redirect: u.toString() });
});

app.put("/me/keys/:provider", auth, async (c) => {
  const provider = LlmProvider.parse(c.req.param("provider"));
  const { key } = z.object({ key: z.string().trim().min(8).max(500) }).parse(await c.req.json());
  await db.putKey(c.env, c.get("userId"), provider, key);
  return c.json(await db.getMe(c.env, c.get("userId")));
});

app.delete("/me/keys/:provider", auth, async (c) => {
  await db.deleteKey(c.env, c.get("userId"), LlmProvider.parse(c.req.param("provider")));
  return c.json(await db.getMe(c.env, c.get("userId")));
});

app.patch("/me/llm", auth, async (c) => {
  const llm = LlmSettings.parse(await c.req.json());
  // a cloud deployment talks to known US endpoints only, over https
  if (llm.base_url && !isDev(c.env) && !llm.base_url.startsWith("https://"))
    return c.json({ error: "the endpoint must use https" }, 400);
  await db.setLlm(c.env, c.get("userId"), llm);
  return c.json(await db.getMe(c.env, c.get("userId")));
});

// ------------------------------------------------------------------ projects

const room = (env: Env, id: string) => {
  const ns = env.US_ONLY === "1" ? env.ROOMS.jurisdiction("us") : env.ROOMS;
  return ns.get(ns.idFromName(id));
};

const owned = async (c: C) => {
  const p = await db.getProject(c.env, c.get("userId"), c.req.param("id")!);
  if (!p) throw new NotFound();
  return p;
};

app.get("/projects", auth, async (c) => c.json(await db.listProjects(c.env, c.get("userId"))));

app.post("/projects", auth, async (c) => {
  const body = z
    .object({ name: z.string().trim().min(1).max(80).optional(), prompt: z.string().trim().min(1).max(20000).optional() })
    .parse(await c.req.json().catch(() => ({})));
  const name = body.name ?? (body.prompt ? titleFrom(body.prompt) : "Untitled board");
  const p = await db.createProject(c.env, c.get("userId"), name);
  const r = room(c.env, p.id);
  await r.init(p.id, c.get("userId"), name);
  if (body.prompt) await r.start({ text: body.prompt });
  return c.json(p, 201);
});

app.get("/projects/:id", auth, async (c) => {
  const p = await owned(c);
  // RPC returns plain JSON; the room built it from a parsed Design
  const d = (await room(c.env, p.id).detail()) as unknown as Omit<ProjectDetail, keyof typeof p>;
  return c.json({ ...p, ...d } satisfies ProjectDetail);
});

app.patch("/projects/:id", auth, async (c) => {
  const p = await owned(c);
  const { name } = z.object({ name: z.string().trim().min(1).max(80) }).parse(await c.req.json());
  return c.json(await db.renameProject(c.env, c.get("userId"), p.id, name));
});

app.delete("/projects/:id", auth, async (c) => {
  const p = await owned(c);
  await room(c.env, p.id).destroy();
  // its files: designs, Gerbers, renders
  let cursor: string | undefined;
  do {
    const list = await c.env.FILES.list({ prefix: `projects/${p.id}/`, ...(cursor ? { cursor } : {}) });
    if (list.objects.length) await c.env.FILES.delete(list.objects.map((o) => o.key));
    cursor = list.truncated ? list.cursor : undefined;
  } while (cursor);
  await db.deleteProject(c.env, c.get("userId"), p.id);
  return c.body(null, 204);
});

app.get("/projects/:id/events", auth, async (c) => {
  const p = await owned(c);
  const after = Number(c.req.query("after") ?? -1);
  const limit = Number(c.req.query("limit") ?? 200);
  return c.json(await room(c.env, p.id).events(Number.isFinite(after) ? after : -1, Number.isFinite(limit) ? limit : 200));
});

app.get("/projects/:id/files/:name", auth, async (c) => {
  const p = await owned(c);
  const name = c.req.param("name") ?? "";
  const obj = await c.env.FILES.get(`projects/${p.id}/${name}`);
  if (!obj) return c.json({ error: "no such file" }, 404);
  return new Response(obj.body, {
    headers: {
      "content-type": obj.httpMetadata?.contentType ?? contentType(name),
      // names are unique per build, so a file never changes
      "cache-control": "private, max-age=31536000, immutable",
      etag: obj.httpEtag,
    },
  });
});

app.get("/projects/:id/ws", auth, async (c) => {
  if (c.req.header("upgrade")?.toLowerCase() !== "websocket") return c.json({ error: "expected a WebSocket" }, 426);
  const p = await owned(c);
  return room(c.env, p.id).fetch(c.req.raw);
});

function titleFrom(prompt: string): string {
  const first = prompt.split(/[.\n]/)[0]!.trim();
  return first.length > 60 ? first.slice(0, 57).trimEnd() + "..." : first || "Untitled board";
}
