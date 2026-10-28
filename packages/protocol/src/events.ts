// What the server sends every open client of a project, over the WebSocket.
// The same stream is stored, so a client that connects late (or a phone app
// opened tomorrow) replays the conversation from it.
import { z } from "zod";
import { Stage } from "./design";

export const QuestionOption = z.object({
  id: z.string(),
  label: z.string(),
  detail: z.string().optional(),
  recommended: z.boolean().optional(),
});

export const Question = z.object({
  id: z.string(),
  header: z.string().max(24), // short chip label: "Power", "Ports"
  text: z.string(),
  options: z.array(QuestionOption).min(2).max(6),
  multi: z.boolean().default(false),
});
export type Question = z.infer<typeof Question>;

// A comparison the AI lays out for the person: parts, layer counts, sizes.
export const Comparison = z.object({
  id: z.string(),
  title: z.string(),
  columns: z.array(z.string()), // row labels go in the first column
  rows: z.array(
    z.object({
      id: z.string(),
      cells: z.array(z.string()),
      recommended: z.boolean().optional(),
      warning: z.string().optional(), // "End of life: do not use in new designs"
    }),
  ),
  note: z.string().optional(), // sources and dates
});
export type Comparison = z.infer<typeof Comparison>;

export const CheckResult = z.object({
  id: z.string(),
  group: z.enum(["circuit", "layout", "fab", "power", "thermal", "firmware"]),
  name: z.string(),
  why: z.string(),
  status: z.enum(["pass", "fail", "warn", "skip"]),
  detail: z.string().optional(),
});
export type CheckResult = z.infer<typeof CheckResult>;

export const Artifact = z.object({
  kind: z.enum(["board-svg", "board-png", "glb", "gerbers", "bom", "cpl", "netlist", "step", "firmware", "report"]),
  name: z.string(),
  url: z.string(), // relative to the API: /projects/:id/files/:name
  bytes: z.number().int().nonnegative().optional(),
  layers: z.array(z.string()).optional(), // for board-svg: layer names in draw order
});
export type Artifact = z.infer<typeof Artifact>;

const base = { seq: z.number().int().nonnegative(), at: z.string() };

// Streaming text: `assistant_text` with done:false is a live delta (append it
// to the message with the same id). Deltas are not stored and carry the seq
// of the last stored event. The closing done:true event carries the whole
// text, is stored, and replaces whatever the deltas built.
export const ServerEvent = z.discriminatedUnion("type", [
  z.object({ ...base, type: z.literal("user_message"), id: z.string(), text: z.string(), answers: z.record(z.string(), z.array(z.string())).optional() }),
  z.object({ ...base, type: z.literal("assistant_text"), id: z.string(), text: z.string(), done: z.boolean() }),
  z.object({ ...base, type: z.literal("thinking"), id: z.string(), text: z.string() }),
  z.object({ ...base, type: z.literal("tool"), id: z.string(), name: z.string(), label: z.string(), status: z.enum(["running", "done", "error"]), detail: z.string().optional() }),
  z.object({ ...base, type: z.literal("questions"), id: z.string(), questions: z.array(Question) }),
  z.object({ ...base, type: z.literal("comparison"), comparison: Comparison }),
  z.object({ ...base, type: z.literal("design"), version: z.number().int(), summary: z.string() }),
  z.object({ ...base, type: z.literal("stage"), stage: Stage }),
  z.object({ ...base, type: z.literal("job"), job: z.string(), step: z.string(), progress: z.number().min(0).max(1), done: z.boolean(), ok: z.boolean().optional() }),
  z.object({ ...base, type: z.literal("checks"), results: z.array(CheckResult) }),
  z.object({ ...base, type: z.literal("artifacts"), artifacts: z.array(Artifact) }),
  z.object({ ...base, type: z.literal("usage"), input_tokens: z.number(), output_tokens: z.number(), cost_usd: z.number() }),
  z.object({ ...base, type: z.literal("error"), message: z.string(), retryable: z.boolean() }),
  z.object({ ...base, type: z.literal("turn_end"), reason: z.enum(["waiting_for_user", "done", "stopped", "error"]) }),
]);
export type ServerEvent = z.infer<typeof ServerEvent>;
export type ServerEventType = ServerEvent["type"];

// Client -> server over the same WebSocket.
export const ClientMessage = z.discriminatedUnion("type", [
  z.object({ type: z.literal("hello"), after: z.number().int().default(-1) }), // replay events with seq > after
  z.object({ type: z.literal("message"), text: z.string().max(20000), answers: z.record(z.string(), z.array(z.string())).optional() }),
  z.object({ type: z.literal("stop") }),
]);
export type ClientMessage = z.infer<typeof ClientMessage>;
