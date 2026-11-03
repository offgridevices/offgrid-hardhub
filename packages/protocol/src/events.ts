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

// Where on the board a check found something: board mm from the centre, y
// down (the design's frame, as view_board and move_parts use it)
export const CheckWhere = z.object({
  x: z.number(),
  y: z.number(),
  layer: z.string().optional(),
  refs: z.array(z.string()).optional(),
  net: z.string().optional(),
  note: z.string().optional(),
});
export type CheckWhere = z.infer<typeof CheckWhere>;

// The number a check measured, against its limit: passes when value op limit
export const CheckMeasure = z.object({
  label: z.string(), // "narrowest track"
  value: z.number(),
  unit: z.string(), // "mm", "°C", "V", "A", "W", "%", "mV", "Ω"
  limit: z.number().optional(),
  op: z.enum([">=", "<="]).optional(),
});
export type CheckMeasure = z.infer<typeof CheckMeasure>;

// The area of the board a check belongs to, in display order. "circuit" and
// "layout" are from before the full test suite (old results still parse).
export const CHECK_GROUPS = [
  "connections", "copper", "holes", "silkscreen", "mask", "placement", "power", "thermal", "stress", "signals", "firmware", "sourcing", "fab",
  "circuit", "layout",
] as const;
export const CheckGroup = z.enum(CHECK_GROUPS);
export type CheckGroup = z.infer<typeof CheckGroup>;

// One test the board went through. A miss is written exactly like a pass.
// status na: the test does not apply to this board (no USB, no high voltage);
// skip: it could not run, and detail says why.
export const CheckResult = z.object({
  id: z.string(),
  group: CheckGroup,
  name: z.string(),
  why: z.string(),
  status: z.enum(["pass", "fail", "warn", "skip", "na"]),
  detail: z.string().optional(),
  plain: z.string().optional(), // what is tested, for someone who has never made a board
  how: z.string().optional(), // how it was tested
  tool: z.string().optional(), // "KiCad 10 DRC", "ngspice", "HardHub solver (Rust)"
  source: z.string().optional(), // where the rule comes from ("IPC-2221", "JLCPCB capabilities (2026)")
  fix: z.string().optional(), // what to change (fail and warn)
  measured: CheckMeasure.optional(),
  where: z.array(CheckWhere).max(20).optional(),
});
export type CheckResult = z.infer<typeof CheckResult>;

/** a check a test run will make, before it has run (the live view lists them all) */
export const CheckPlan = z.object({ id: z.string(), group: CheckGroup, name: z.string() });
export type CheckPlan = z.infer<typeof CheckPlan>;

export const Artifact = z.object({
  // board-json: the routed board's vector geometry (BoardGeometry, board.ts), for editing it by hand
  // package: one zip with everything to order the board, sorted by where each file is uploaded
  kind: z.enum(["board-svg", "board-png", "board-json", "glb", "gerbers", "bom", "cpl", "netlist", "step", "kicad", "package", "firmware", "report"]),
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
  // a run of the board tests, live: "start" (stored) lists every check in
  // plan; "check" (live, not stored, like a text delta: it carries the seq of
  // the last stored event) is one finished check and what runs next; "done"
  // (stored) ends it. The full results follow as a stored "checks" event and
  // the report files as "artifacts".
  z.object({
    ...base,
    type: z.literal("test_run"),
    run: z.string(),
    phase: z.enum(["start", "check", "done"]),
    live: z.boolean().optional(),
    label: z.string().optional(), // what is running now, in plain words
    progress: z.number().min(0).max(1).optional(),
    plan: z.array(CheckPlan).optional(),
    result: CheckResult.optional(),
    ok: z.boolean().optional(),
    summary: z.string().optional(),
    // done: something the person should know about this run, in plain words
    // ("the board was built from an earlier design: build it again")
    note: z.string().optional(),
  }),
  z.object({ ...base, type: z.literal("artifacts"), artifacts: z.array(Artifact) }),
  // the person edited the routed board by hand (POST /projects/:id/board/edits); summary is plain words
  z.object({ ...base, type: z.literal("board_edit"), id: z.string(), summary: z.string(), edits: z.number().int().nonnegative(), ok: z.boolean() }),
  z.object({ ...base, type: z.literal("usage"), input_tokens: z.number(), output_tokens: z.number(), cost_usd: z.number() }),
  z.object({ ...base, type: z.literal("error"), message: z.string(), retryable: z.boolean() }),
  z.object({ ...base, type: z.literal("turn_end"), reason: z.enum(["waiting_for_user", "done", "stopped", "error"]) }),
]);
export type ServerEvent = z.infer<typeof ServerEvent>;
export type ServerEventType = ServerEvent["type"];

// Client -> server over the same WebSocket.
export const ClientMessage = z.discriminatedUnion("type", [
  // send first: the server replays events with seq > after, then streams live ones (nothing before hello)
  z.object({ type: z.literal("hello"), after: z.number().int().default(-1) }),
  z.object({ type: z.literal("message"), text: z.string().max(20000), answers: z.record(z.string(), z.array(z.string())).optional() }),
  z.object({ type: z.literal("stop") }),
]);
export type ClientMessage = z.infer<typeof ClientMessage>;
