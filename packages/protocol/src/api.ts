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
});
export type Me = z.infer<typeof Me>;

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
