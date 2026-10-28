// D1 queries: users, sessions, sign-in links, projects, API keys.
import type { LlmProvider, LlmSettings, Me, ProjectSummary, Stage } from "@hardhub/protocol";
import { isDev, type Env } from "./env";
import { PRESETS } from "./agent/llm/presets";
import { decryptSecret, encryptSecret, newId, randomToken, sha256 } from "./crypto";

const SESSION_DAYS = 30;
const LINK_MINUTES = 15;

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
  const llm_ready = !!keys[llm.provider] || !PRESETS[llm.provider].needsKey || (isDev(env) && !!env.DEV_LLM_KEY);
  return { id: u.id, email: u.email, keys, llm, llm_ready };
}

export async function setLlm(env: Env, userId: string, llm: LlmSettings) {
  await env.DB.prepare("UPDATE users SET llm_provider = ?, llm_model = ?, llm_base_url = ? WHERE id = ?")
    .bind(llm.provider, llm.model, llm.base_url ?? null, userId)
    .run();
}

// ------------------------------------------------------------- sign-in

export async function createLoginToken(env: Env, email: string): Promise<string> {
  const token = randomToken();
  await env.DB.prepare("INSERT INTO login_tokens (token_hash, email, created_at, expires_at) VALUES (?, ?, ?, ?)")
    .bind(await sha256(token), email, now(), later(LINK_MINUTES * 60_000))
    .run();
  return token;
}

/** Spends a sign-in link: returns a new session, creating the user on first sign-in. */
export async function redeemLoginToken(
  env: Env,
  token: string,
  llm?: LlmSettings | null,
): Promise<{ token: string; userId: string } | null> {
  const hash = await sha256(token);
  // single statement, so a link cannot be spent twice by racing requests
  const row = await env.DB.prepare(
    "UPDATE login_tokens SET used_at = ? WHERE token_hash = ? AND used_at IS NULL AND expires_at > ? RETURNING email",
  )
    .bind(now(), hash, now())
    .first<{ email: string }>();
  if (!row) return null;
  let user = await env.DB.prepare("SELECT id FROM users WHERE email = ?").bind(row.email).first<{ id: string }>();
  if (!user) {
    user = { id: newId("u") };
    await env.DB.prepare("INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)").bind(user.id, row.email, now()).run();
    if (llm) await setLlm(env, user.id, llm);
  }
  return { token: await createSession(env, user.id), userId: user.id };
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

/** Any live token: an agent's access token (clientId set) or a browser session. */
export async function tokenOwner(env: Env, token: string): Promise<{ userId: string; clientId: string | null } | null> {
  const row = await env.DB.prepare("SELECT user_id, client_id FROM sessions WHERE token_hash = ? AND expires_at > ?")
    .bind(await sha256(token), now())
    .first<{ user_id: string; client_id: string | null }>();
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
