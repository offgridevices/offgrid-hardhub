// D1 queries: users, passwords, sessions, projects, API keys.
import type { LlmProvider, LlmSettings, Me, ProjectSummary, Stage } from "@hardhub/protocol";
import { isDev, type Env } from "./env";
import { PRESETS } from "./agent/llm/presets";
import { decryptSecret, encryptSecret, hashPassword, newId, randomToken, sha256, verifyPassword } from "./crypto";

const SESSION_DAYS = 30;
// ten sign-in attempts for one email from one visitor address within 15
// minutes, and that pair is locked for the rest of those 15 minutes
const MAX_ATTEMPTS = 10;
const FAILURE_WINDOW_MS = 15 * 60_000;

const now = () => new Date().toISOString();
const later = (ms: number) => new Date(Date.now() + ms).toISOString();

interface UserRow { id: string; email: string; llm_provider: LlmProvider; llm_model: string; llm_base_url: string | null; created_at: string }
interface ProjectRow { id: string; user_id: string; name: string; stage: Stage; thumbnail: string | null; created_at: string; updated_at: string }

export async function getMe(env: Env, userId: string): Promise<Me | null> {
  const u = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(userId).first<UserRow>();
  if (!u) return null;
  const { results } = await env.DB.prepare("SELECT provider, last4, added_at FROM api_keys WHERE user_id = ?")
    .bind(userId)
    .all<{ provider: LlmProvider; last4: string; added_at: string }>();
  const keys: Me["keys"] = {};
  for (const k of results) keys[k.provider] = { last4: k.last4, added_at: k.added_at };
  const llm: LlmSettings = { provider: u.llm_provider, model: u.llm_model, ...(u.llm_base_url ? { base_url: u.llm_base_url } : {}) };
  const llm_ready =
    llm.provider === "claude-code" ? !!env.BRIDGE_URL : !!keys[llm.provider] || !PRESETS[llm.provider].needsKey || (isDev(env) && !!env.DEV_LLM_KEY);
  return { id: u.id, email: u.email, keys, llm, llm_ready };
}

export async function setLlm(env: Env, userId: string, llm: LlmSettings) {
  await env.DB.prepare("UPDATE users SET llm_provider = ?, llm_model = ?, llm_base_url = ? WHERE id = ?")
    .bind(llm.provider, llm.model, llm.base_url ?? null, userId)
    .run();
}

// ------------------------------------------------------------- sign-in

/** Is there an account yet, and may a new one be made? Without allowSignup
 *  ($ALLOW_SIGNUP) only the first account can be created: the owner's. */
export async function authStatus(env: Env, allowSignup: boolean): Promise<{ has_account: boolean; signup_open: boolean }> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE password_hash IS NOT NULL").first<{ n: number }>();
  const has_account = (row?.n ?? 0) > 0;
  return { has_account, signup_open: allowSignup || !has_account };
}

export type SignUp = { token: string; userId: string } | "closed" | "taken";

/** A new account with a password, made only while sign-ups are open: the
 *  check and the insert are one statement, so two at once cannot both get in.
 *  With claimOld (this computer only), the first sign-up may also take over an
 *  account from before passwords with that email, keeping its boards. */
export async function signUp(
  env: Env,
  email: string,
  password: string,
  allowSignup: boolean,
  claimOld: boolean,
  llm?: LlmSettings | null,
): Promise<SignUp> {
  const hash = await hashPassword(password);
  const userId = newId("u");
  const made = await env.DB.prepare(
    `INSERT INTO users (id, email, password_hash, created_at) SELECT ?1, ?2, ?3, ?4
       WHERE ?5 = 1 OR NOT EXISTS (SELECT 1 FROM users WHERE password_hash IS NOT NULL)
     ON CONFLICT(email) DO NOTHING RETURNING id`,
  )
    .bind(userId, email, hash, now(), allowSignup ? 1 : 0)
    .first();
  if (made) {
    if (llm) await setLlm(env, userId, llm);
    return { token: await createSession(env, userId), userId };
  }
  // closed says nothing about which emails have accounts
  if (!(await authStatus(env, allowSignup)).signup_open) return "closed";
  if (claimOld) {
    const old = await env.DB.prepare(
      `UPDATE users SET password_hash = ?1 WHERE email = ?2 AND password_hash IS NULL
         AND NOT EXISTS (SELECT 1 FROM users WHERE password_hash IS NOT NULL) RETURNING id`,
    )
      .bind(hash, email)
      .first<{ id: string }>();
    if (old) return { token: await createSession(env, old.id), userId: old.id };
  }
  return "taken";
}

export type SignIn = { token: string; userId: string } | "wrong" | "locked";

/** visitor: the caller's address (Cloudflare's CF-Connecting-IP; empty locally).
 *  The attempt is counted before the password is checked, in one statement,
 *  so many requests at once cannot all slip under the limit. */
export async function signIn(env: Env, email: string, password: string, visitor: string): Promise<SignIn> {
  const key = `${email}|${visitor}`;
  const tries = await env.DB.prepare(
    `INSERT INTO login_failures (key, count, first_at) VALUES (?1, 1, ?2)
     ON CONFLICT(key) DO UPDATE SET
       count = CASE WHEN first_at < ?3 THEN 1 ELSE count + 1 END,
       first_at = CASE WHEN first_at < ?3 THEN ?2 ELSE first_at END
     RETURNING count`,
  )
    .bind(key, now(), new Date(Date.now() - FAILURE_WINDOW_MS).toISOString())
    .first<{ count: number }>();
  if ((tries?.count ?? 0) > MAX_ATTEMPTS) return "locked";
  const u = await env.DB.prepare("SELECT id, password_hash FROM users WHERE email = ?").bind(email).first<{ id: string; password_hash: string | null }>();
  if (!(await verifyPassword(password, u?.password_hash ?? null)) || !u) return "wrong";
  await env.DB.prepare("DELETE FROM login_failures WHERE key = ?").bind(key).run();
  return { token: await createSession(env, u.id), userId: u.id };
}

export async function createSession(env: Env, userId: string): Promise<string> {
  const token = randomToken();
  await env.DB.prepare("INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)")
    .bind(await sha256(token), userId, now(), later(SESSION_DAYS * 86_400_000))
    .run();
  return token;
}

/** The person signed in with a browser session (not an agent's access token). */
export async function sessionUser(env: Env, token: string): Promise<string | null> {
  const row = await env.DB.prepare("SELECT user_id FROM sessions WHERE token_hash = ? AND expires_at > ? AND client_id IS NULL")
    .bind(await sha256(token), now())
    .first<{ user_id: string }>();
  return row?.user_id ?? null;
}

/** A short-lived MCP token for one chat turn run by the person's own Claude Code (bridge.ts). */
export async function createChatToken(env: Env, userId: string, clientId: string): Promise<string> {
  const token = randomToken();
  await env.DB.prepare("INSERT INTO sessions (token_hash, user_id, created_at, expires_at, client_id) VALUES (?, ?, ?, ?, ?)")
    .bind(await sha256(token), userId, now(), later(2 * 3_600_000), clientId)
    .run();
  return token;
}

/** An agent's access token, issued by HardHub's sign-in for MCP (never a browser session). */
export async function agentTokenOwner(env: Env, token: string): Promise<{ userId: string; clientId: string } | null> {
  const row = await env.DB.prepare("SELECT user_id, client_id FROM sessions WHERE token_hash = ? AND expires_at > ? AND client_id IS NOT NULL")
    .bind(await sha256(token), now())
    .first<{ user_id: string; client_id: string }>();
  return row ? { userId: row.user_id, clientId: row.client_id } : null;
}

export async function deleteSession(env: Env, token: string) {
  await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(await sha256(token)).run();
}

// ------------------------------------------------------------- API keys

export async function putKey(env: Env, userId: string, provider: LlmProvider, key: string) {
  const { ciphertext, iv } = await encryptSecret(env.KEY_ENCRYPTION_KEY, key, userId);
  await env.DB.prepare(
    `INSERT INTO api_keys (user_id, provider, ciphertext, iv, last4, added_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (user_id, provider) DO UPDATE SET ciphertext = excluded.ciphertext, iv = excluded.iv,
       last4 = excluded.last4, added_at = excluded.added_at`,
  )
    .bind(userId, provider, ciphertext, iv, key.slice(-4), now())
    .run();
}

export async function deleteKey(env: Env, userId: string, provider: LlmProvider) {
  await env.DB.prepare("DELETE FROM api_keys WHERE user_id = ? AND provider = ?").bind(userId, provider).run();
}

/** The decrypted key, for one turn. Never log or return it. */
export async function getKey(env: Env, userId: string, provider: LlmProvider): Promise<string | null> {
  const row = await env.DB.prepare("SELECT ciphertext, iv FROM api_keys WHERE user_id = ? AND provider = ?")
    .bind(userId, provider)
    .first<{ ciphertext: string; iv: string }>();
  if (!row) return null;
  return decryptSecret(env.KEY_ENCRYPTION_KEY, row.ciphertext, row.iv, userId);
}

// ------------------------------------------------------------- projects

const summary = (r: ProjectRow): ProjectSummary => ({
  id: r.id,
  name: r.name,
  stage: r.stage,
  created_at: r.created_at,
  updated_at: r.updated_at,
  ...(r.thumbnail ? { thumbnail: r.thumbnail } : {}),
});

export async function listProjects(env: Env, userId: string): Promise<ProjectSummary[]> {
  const { results } = await env.DB.prepare("SELECT * FROM projects WHERE user_id = ? ORDER BY updated_at DESC")
    .bind(userId)
    .all<ProjectRow>();
  return results.map(summary);
}

export async function getProject(env: Env, userId: string, id: string): Promise<ProjectSummary | null> {
  const r = await env.DB.prepare("SELECT * FROM projects WHERE id = ? AND user_id = ?").bind(id, userId).first<ProjectRow>();
  return r ? summary(r) : null;
}

export async function createProject(env: Env, userId: string, name: string): Promise<ProjectSummary> {
  const t = now();
  const id = newId("p");
  await env.DB.prepare("INSERT INTO projects (id, user_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
    .bind(id, userId, name, t, t)
    .run();
  return { id, name, stage: "idea", created_at: t, updated_at: t };
}

export async function renameProject(env: Env, userId: string, id: string, name: string) {
  await env.DB.prepare("UPDATE projects SET name = ?, updated_at = ? WHERE id = ? AND user_id = ?").bind(name, now(), id, userId).run();
  return getProject(env, userId, id);
}

export async function deleteProject(env: Env, userId: string, id: string) {
  await env.DB.prepare("DELETE FROM projects WHERE id = ? AND user_id = ?").bind(id, userId).run();
}

/** Called by the project's room when its stage or content changes. */
export async function touchProject(env: Env, id: string, fields: { stage?: Stage; name?: string; thumbnail?: string }) {
  await env.DB.prepare(
    "UPDATE projects SET stage = COALESCE(?, stage), name = COALESCE(?, name), thumbnail = COALESCE(?, thumbnail), updated_at = ? WHERE id = ?",
  )
    .bind(fields.stage ?? null, fields.name ?? null, fields.thumbnail ?? null, now(), id)
    .run();
}
