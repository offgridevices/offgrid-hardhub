// The REST API (packages/protocol/src/api.ts) and the WebSocket entry.
import { LlmProvider, LlmSettings, type ProjectDetail } from "@hardhub/protocol";
import { Hono, type Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { cors } from "hono/cors";
import { z } from "zod";
import { devLlmDefaults } from "./agent/llm";
import { contentType } from "./agent/tools";
import * as db from "./db";
import { type Env, isDev } from "./env";
import { mailer } from "./mail";

type Ctx = { Bindings: Env; Variables: { userId: string; token: string } };
type C = Context<Ctx>;

const COOKIE = "hh_session";

export const app = new Hono<Ctx>();

app.use("*", async (c, next) => {
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
