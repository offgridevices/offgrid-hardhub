// REST shapes shared by the API and every client (web now, iOS/Android later).
//
//   POST   /auth/start            { email }                 -> 204 (sign-in link sent)
//                                                              dev only: 200 DevSignIn
//   POST   /auth/verify           { token }                 -> Session
//   POST   /auth/logout                                     -> 204
//   GET    /me                                              -> Me
//   PUT    /me/keys/:provider     { key }                   -> Me (key stored encrypted, never returned)
//   DELETE /me/keys/:provider                               -> Me
//   PATCH  /me/llm                LlmSettings               -> Me
//   GET    /projects                                        -> ProjectSummary[]
//   POST   /projects              { name?, prompt? }        -> ProjectSummary
//   GET    /projects/:id                                    -> ProjectDetail
//   PATCH  /projects/:id          { name }                  -> ProjectSummary
//   DELETE /projects/:id                                    -> 204
//   GET    /projects/:id/events   ?after=SEQ&limit=N        -> EventPage (stored events, oldest first)
//   GET    /projects/:id/files/:name                        -> the file
//   GET    /projects/:id/ws       (WebSocket: ClientMessage up, ServerEvent down)
//
// Auth: "Authorization: Bearer <session token>" on every request; browsers
// may use the hh_session cookie instead. WebSockets pass ?token=.
import { z } from "zod";
import { Design, Stage } from "./design";
import { ServerEvent } from "./events";

// Who runs the AI. Every option is kept on US servers: Anthropic with
// inference_geo "us", OpenAI through its US data-residency endpoint,
// OpenRouter restricted to US-hosted providers, Ollama on your own machine,
// "custom" any OpenAI-compatible endpoint you vouch for.
export const LlmProvider = z.enum(["anthropic", "openrouter", "openai", "ollama", "custom"]);
export type LlmProvider = z.infer<typeof LlmProvider>;
/** @deprecated use LlmProvider */
export const Provider = LlmProvider;
export type Provider = LlmProvider;

export const LlmSettings = z.object({
  provider: LlmProvider.default("anthropic"),
  model: z.string().min(1).default("claude-opus-5-5"),
  base_url: z.string().url().optional(), // custom and ollama; others use their preset
});
export type LlmSettings = z.infer<typeof LlmSettings>;

export const Me = z.object({
  id: z.string(),
  email: z.string().email(),
  keys: z.partialRecord(LlmProvider, z.object({ last4: z.string(), added_at: z.string() })).default({}),
  llm: LlmSettings.default({ provider: "anthropic", model: "claude-opus-5-5" }),
  // the server can run the chosen provider now: a stored key, a provider that
  // needs none (Ollama), or a key the server itself supplies (local dev)
  llm_ready: z.boolean().default(false),
});
export type Me = z.infer<typeof Me>;

// Local dev only: the sign-in link instead of an email. `token` is the
// one-time login token from that link (redeem it with POST /auth/verify),
// not a session token.
export const DevSignIn = z.object({ dev_link: z.string(), token: z.string() });
export type DevSignIn = z.infer<typeof DevSignIn>;

export const EventPage = z.object({ events: z.array(ServerEvent), more: z.boolean() });
export type EventPage = z.infer<typeof EventPage>;

export const Session = z.object({ token: z.string(), me: Me });
export type Session = z.infer<typeof Session>;

export const ProjectSummary = z.object({
  id: z.string(),
  name: z.string(),
  stage: Stage,
  updated_at: z.string(),
  created_at: z.string(),
  thumbnail: z.string().optional(),
});
export type ProjectSummary = z.infer<typeof ProjectSummary>;

export const ProjectDetail = ProjectSummary.extend({
  design: Design,
  design_version: z.number().int(),
  last_seq: z.number().int(),
  busy: z.boolean(),
});
export type ProjectDetail = z.infer<typeof ProjectDetail>;

export const ApiError = z.object({ error: z.string(), detail: z.string().optional() });
export type ApiError = z.infer<typeof ApiError>;

// Agents connected over MCP (Claude, ChatGPT, Codex...): the address to give
// them, and the ones this account has allowed. Settings lists and revokes them.
export const Connection = z.object({
  client_id: z.string(),
  name: z.string(),
  connected_at: z.string(),
  renewed_at: z.string(), // when its token was last issued or refreshed
});
export type Connection = z.infer<typeof Connection>;

export const Connections = z.object({ mcp_url: z.string(), connections: z.array(Connection) });
export type Connections = z.infer<typeof Connections>;

// The consent page (/connect) sends back what the agent asked for, after the
// person allowed or refused it. The server checks it all again.
export const OAuthApprove = z.object({
  client_id: z.string().min(1).max(2000),
  redirect_uri: z.string().min(1).max(2000),
  code_challenge: z.string().min(43).max(128),
  state: z.string().max(2000).optional(),
  resource: z.string().max(2000).optional(),
  scope: z.string().max(500).optional(),
  allow: z.boolean(),
});
export type OAuthApprove = z.infer<typeof OAuthApprove>;

// What the consent page shows: who is asking. GET /oauth/client?client_id=&redirect_uri=
// client_host: for an app named by a metadata URL, that URL's host, which its chosen name cannot fake
export const OAuthClientInfo = z.object({ client_id: z.string(), name: z.string(), redirect_host: z.string(), client_host: z.string().optional() });
export type OAuthClientInfo = z.infer<typeof OAuthClientInfo>;

export const OAuthRedirect = z.object({ redirect: z.string() });
export type OAuthRedirect = z.infer<typeof OAuthRedirect>;
