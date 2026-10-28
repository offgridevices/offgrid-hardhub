// REST shapes shared by the API and every client (web now, iOS/Android later).
//
//   POST   /auth/start            { email }                 -> 204 (sign-in link sent)
//   POST   /auth/verify           { token }                 -> Session
//   POST   /auth/logout                                     -> 204
//   GET    /me                                              -> Me
//   PUT    /me/keys/:provider     { key }                   -> Me (key stored encrypted, never returned)
//   DELETE /me/keys/:provider                               -> Me
//   GET    /projects                                        -> ProjectSummary[]
//   POST   /projects              { name?, prompt? }        -> ProjectSummary
//   GET    /projects/:id                                    -> ProjectDetail
//   PATCH  /projects/:id          { name }                  -> ProjectSummary
//   DELETE /projects/:id                                    -> 204
//   GET    /projects/:id/files/:name                        -> the file
//   GET    /projects/:id/ws       (WebSocket: ClientMessage up, ServerEvent down)
//
// Auth: "Authorization: Bearer <session token>" on every request; browsers
// may use the hh_session cookie instead. WebSockets pass ?token=.
import { z } from "zod";
import { Design, Stage } from "./design";

export const Provider = z.enum(["anthropic", "openai"]);
export type Provider = z.infer<typeof Provider>;

export const ModelChoice = z.enum(["claude-opus-5-5", "claude-sonnet-5-5"]);
export type ModelChoice = z.infer<typeof ModelChoice>;

export const Me = z.object({
  id: z.string(),
  email: z.string().email(),
  keys: z.partialRecord(Provider, z.object({ last4: z.string(), added_at: z.string() })).default({}),
  model: ModelChoice.default("claude-opus-5-5"),
});
export type Me = z.infer<typeof Me>;

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
