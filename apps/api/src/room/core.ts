// One project's live state: its design (every version), its event log, the
// AI conversation, and the turn that is running. Storage is SQLite (the
// Durable Object's own database in production, sql.js in tests), so this
// class has no Cloudflare dependency and is tested directly.
import { Design, type EventPage, type ServerEvent, emptyDesign } from "@hardhub/protocol";
import type { Engine } from "../engine";
import { type Llm, LlmError, type StreamSink, type ToolImage } from "../agent/llm/types";
import { type Pending, type TurnEnd, type TurnInput, runTurn } from "../agent/loop";
import { SYSTEM_PROMPT } from "../agent/prompt";
import { type EventInput, type ToolContext, TOOLS, runTool, toolSpecs } from "../agent/tools";

export interface SqlCursor {
  toArray(): Record<string, unknown>[];
}
export interface Sql {
  exec(query: string, ...bindings: unknown[]): SqlCursor;
}

export interface RoomDeps {
  sql: Sql;
  /** send one frame to every connected client */
  broadcast(frame: string): void;
  /** the owner's LLM for this turn; throws LlmError when it cannot be used */
  llm(ownerId: string): Promise<Llm>;
  /** converters for moving a conversation between wire formats */
  converters: Record<Llm["format"], Pick<Llm, "toNeutral" | "fromNeutral">>;
  engine: Engine;
  putFile(key: string, body: ReadableStream | ArrayBuffer, contentType: string): Promise<void>;
  getFile(key: string): Promise<ArrayBuffer | null>;
  /** update the project list row (stage, time) */
  touch(projectId: string, fields: { stage?: Design["stage"] }): Promise<void>;
}

const SCHEMA = [
  "CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY, json TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS history (i INTEGER PRIMARY KEY AUTOINCREMENT, json TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS designs (version INTEGER PRIMARY KEY, json TEXT NOT NULL, summary TEXT NOT NULL, at TEXT NOT NULL)",
];

/** text deltas are sent at most this often, batched */
export const DELTA_MS = 50;
export const PAGE = 200;

/** what a tool call from a connected agent (MCP) gets back */
export interface AgentResult {
  content: string;
  images?: ToolImage[];
  isError?: boolean;
}

/** a board build an agent started; it runs from the room's alarm, so it
 * outlives the request that asked for it */
export interface AgentBuild {
  id: string;
  input: { stop_after?: string };
  state: "queued" | "running" | "done";
  step?: string;
  progress?: number;
  result?: AgentResult;
}

/** agent tools that change the design: not while an agent's build runs from it */
const CHANGES_DESIGN = new Set(["update_design", "set_stage", "write_firmware"]);

let counter = 0;
const shortId = (p: string) => `${p}_${Date.now().toString(36)}${(counter++ % 1296).toString(36)}`;

export class RoomCore {
  private abort: AbortController | null = null;
  private buildAbort: AbortController | null = null;
  /** agent tool calls running now (MCP); the person's own chat waits for them */
  private agentCalls = 0;
  private delta: { id: string; text: string; timer: ReturnType<typeof setTimeout> | null } | null = null;

  constructor(private readonly d: RoomDeps) {
    for (const s of SCHEMA) d.sql.exec(s);
    // a turn cut off by an eviction or a crash leaves the busy flag behind
    if (this.meta("busy") === "1") {
      this.setMeta("busy", "0");
      if (this.meta("project")) {
        // say why, or the reply just stops with no word to the person
        this.emit({ type: "error", message: "The last reply was interrupted (the server restarted). Send your message again to carry on.", retryable: true });
        this.emit({ type: "turn_end", reason: "error" });
      }
    }
    // the same for an agent's build: queued ones still run from the alarm
    const b = this.agentBuild();
    if (b?.state === "running") {
      this.setAgentBuild({ ...b, state: "done", result: { content: "The build was interrupted (the server restarted). Call build_board again.", isError: true } });
      this.emit({ type: "tool", id: b.id, name: "build_board", label: "Building the board", status: "error", detail: "interrupted by a server restart" });
      this.emit({ type: "turn_end", reason: "error" });
    }
  }

  // ---------------------------------------------------------------- meta

  private meta(k: string): string | null {
    return (this.d.sql.exec("SELECT v FROM meta WHERE k = ?", k).toArray()[0]?.v as string | undefined) ?? null;
  }
  private setMeta(k: string, v: string | null) {
    if (v === null) this.d.sql.exec("DELETE FROM meta WHERE k = ?", k);
    else this.d.sql.exec("INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v", k, v);
  }

  get projectId() {
    return this.meta("project") ?? "";
  }
  get ownerId() {
    return this.meta("owner") ?? "";
  }
  get busy() {
    return this.meta("busy") === "1";
  }

  init(projectId: string, ownerId: string, name: string) {
    if (this.meta("project")) return;
    this.setMeta("project", projectId);
    this.setMeta("owner", ownerId);
    this.insertDesign(emptyDesign(name), "New project");
  }

  // ---------------------------------------------------------------- design

  design(): { design: Design; version: number } {
    const row = this.d.sql.exec("SELECT version, json FROM designs ORDER BY version DESC LIMIT 1").toArray()[0];
    if (!row) return { design: emptyDesign(), version: 0 };
    return { design: Design.parse(JSON.parse(row.json as string)), version: row.version as number };
  }

  private insertDesign(design: Design, summary: string): number {
    const version = this.design().version + 1;
    this.d.sql.exec("INSERT INTO designs (version, json, summary, at) VALUES (?, ?, ?, ?)", version, JSON.stringify(design), summary, new Date().toISOString());
    return version;
  }

  saveDesign(design: Design, summary: string): number {
    const before = this.design().design;
    const version = this.insertDesign(design, summary);
    this.emit({ type: "design", version, summary });
    // the project list shows the design's name and stage
    void this.d.touch(this.projectId, {
      ...(design.stage !== before.stage ? { stage: design.stage } : {}),
      ...(design.name !== before.name ? { name: design.name } : {}),
    });
    return version;
  }

  // ---------------------------------------------------------------- events

  lastSeq(): number {
    return (this.d.sql.exec("SELECT MAX(seq) AS s FROM events").toArray()[0]?.s as number | null) ?? -1;
  }

  /** store an event and send it to every client */
  emit(e: EventInput): ServerEvent {
    this.flushDelta();
    const ev = { ...e, seq: this.lastSeq() + 1, at: new Date().toISOString() } as ServerEvent;
    const frame = JSON.stringify(ev);
    this.d.sql.exec("INSERT INTO events (seq, json) VALUES (?, ?)", ev.seq, frame);
    this.d.broadcast(frame);
    return ev;
  }

  events(after: number, limit = PAGE): EventPage {
    const n = Math.max(1, Math.min(limit, 1000));
    const rows = this.d.sql.exec("SELECT json FROM events WHERE seq > ? ORDER BY seq LIMIT ?", after, n + 1).toArray();
    return { events: rows.slice(0, n).map((r) => JSON.parse(r.json as string) as ServerEvent), more: rows.length > n };
  }

  /** stored frames after a seq, page by page, for a client that (re)connects */
  *replay(after: number): Generator<string> {
    let cursor = after;
    for (;;) {
      const rows = this.d.sql.exec("SELECT seq, json FROM events WHERE seq > ? ORDER BY seq LIMIT ?", cursor, PAGE).toArray();
      for (const r of rows) yield r.json as string;
      if (rows.length < PAGE) return;
      cursor = rows.at(-1)!.seq as number;
    }
  }

  // live text: batched deltas, not stored
  private sendDelta(id: string, text: string) {
    if (this.delta && this.delta.id !== id) this.flushDelta();
    if (!this.delta) this.delta = { id, text: "", timer: null };
    this.delta.text += text;
    this.delta.timer ??= setTimeout(() => this.flushDelta(), DELTA_MS);
  }

  private flushDelta() {
    const d = this.delta;
    if (!d) return;
    this.delta = null;
    if (d.timer) clearTimeout(d.timer);
    if (!d.text) return;
    this.d.broadcast(JSON.stringify({ type: "assistant_text", id: d.id, text: d.text, done: false, seq: this.lastSeq(), at: new Date().toISOString() }));
  }

  // ---------------------------------------------------------------- history

  private history(): unknown[] {
    return this.d.sql.exec("SELECT json FROM history ORDER BY i").toArray().map((r) => JSON.parse(r.json as string));
  }

  private append(messages: unknown[]) {
    for (const m of messages) this.d.sql.exec("INSERT INTO history (json) VALUES (?)", JSON.stringify(m));
  }

  /** a provider switch: carry the conversation over in the new wire format */
  private adoptFormat(llm: Llm) {
    const was = this.meta("format") as Llm["format"] | null;
    if (was && was !== llm.format) {
      const moved = this.d.converters[llm.format].fromNeutral(this.d.converters[was].toNeutral(this.history()));
      this.d.sql.exec("DELETE FROM history");
      this.append(moved);
    }
    this.setMeta("format", llm.format);
  }

  // ---------------------------------------------------------------- turns

  /** Runs one turn for a message from the person. */
  async message(input: TurnInput): Promise<TurnEnd | "busy"> {
    if (this.busy) {
      this.d.broadcast(JSON.stringify({ type: "error", message: "HardHub is still working on the last message.", retryable: true, seq: this.lastSeq(), at: new Date().toISOString() }));
      return "busy";
    }
    this.setMeta("busy", "1");
    const abort = (this.abort = new AbortController());
    let end: TurnEnd = "error";
    try {
      this.emit({ type: "user_message", id: shortId("m"), text: input.text, ...(input.answers ? { answers: input.answers } : {}) });
      let llm: Llm;
      try {
        llm = await this.d.llm(this.ownerId);
      } catch (e) {
        this.emit({ type: "error", message: e instanceof LlmError ? e.message : "Could not start the AI.", retryable: false });
        return (end = "error");
      }
      this.adoptFormat(llm);
      end = await runTurn(
        {
          llm,
          system: SYSTEM_PROMPT,
          tools: toolSpecs(),
          history: () => this.history(),
          append: (m) => this.append(m),
          sink: this.sink(),
          error: (message, retryable) => this.emit({ type: "error", message, retryable }),
          usage: (u) => this.emit({ type: "usage", input_tokens: u.input, output_tokens: u.output, cost_usd: Math.round(u.costUsd * 1e6) / 1e6 }),
          runTool: (call, signal) => runTool(call, this.toolContext(llm.vision), signal),
          getPending: () => {
            const p = this.meta("pending");
            return p ? (JSON.parse(p) as Pending) : null;
          },
          setPending: (p) => this.setMeta("pending", p ? JSON.stringify(p) : null),
          signal: abort.signal,
        },
        input,
      );
      return end;
    } catch (e) {
      this.emit({ type: "error", message: `Something went wrong: ${e instanceof Error ? e.message : String(e)}`, retryable: true });
      return (end = "error");
    } finally {
      this.flushDelta();
      this.abort = null;
      this.setMeta("busy", "0");
      this.emit({ type: "turn_end", reason: end });
    }
  }

  stop() {
    this.abort?.abort();
    this.buildAbort?.abort();
  }

  /** queue a message to run later (the first prompt, run from an alarm) */
  queue(input: TurnInput) {
    this.setMeta("queued", JSON.stringify(input));
  }

  /** A message from a client: queued for the room's alarm, never run inside
   * the WebSocket event that brought it, so a closed tab or a dropped phone
   * connection cannot cancel the turn half way. False when one is already
   * running or waiting. */
  accept(input: TurnInput): boolean {
    if (this.busy || this.meta("queued")) {
      this.d.broadcast(JSON.stringify({ type: "error", message: "HardHub is still working on the last message.", retryable: true, seq: this.lastSeq(), at: new Date().toISOString() }));
      return false;
    }
    if (this.buildingForAgent() || this.agentCalls > 0) {
      this.d.broadcast(JSON.stringify({ type: "error", message: "A connected AI is working on this board. Send your message when it has finished.", retryable: true, seq: this.lastSeq(), at: new Date().toISOString() }));
      return false;
    }
    this.queue(input);
    return true;
  }

  async runQueued(): Promise<void> {
    const q = this.meta("queued");
    if (!q) return;
    this.setMeta("queued", null);
    await this.message(JSON.parse(q) as TurnInput);
  }

  private sink(): StreamSink {
    let id = "";
    return {
      textStart: () => {
        id = shortId("t");
      },
      text: (delta) => this.sendDelta(id, delta),
      textDone: (full) => {
        if (full.trim()) this.emit({ type: "assistant_text", id, text: full, done: true });
        else this.flushDelta();
      },
      thinking: (full) => {
        this.emit({ type: "thinking", id: shortId("th"), text: full });
      },
    };
  }

  /** The engine keeps each job's files under the job's name, shared by every
   * project: give this project's jobs names no other project can have. */
  private scopedEngine(): Engine {
    const e = this.d.engine;
    const scoped = (job: string) => `${this.projectId}-${job}`;
    return {
      searchParts: (q, n) => e.searchParts(q, n),
      getParts: (l) => e.getParts(l),
      check: (d) => e.check(d),
      quote: (d, q) => e.quote(d, q),
      build: (d, job, signal, stopAfter) => e.build(d, scoped(job), signal, stopAfter),
      file: (job, name) => e.file(scoped(job), name),
      view: (job, opts, zip) => e.view(scoped(job), opts, zip),
      inspect: (job, opts, zip) => e.inspect(scoped(job), opts, zip),
    };
  }

  private toolContext(vision: boolean): ToolContext {
    const key = (name: string) => `projects/${this.projectId}/${name}`;
    return {
      projectId: this.projectId,
      engine: this.scopedEngine(),
      design: () => this.design(),
      saveDesign: (design, summary) => this.saveDesign(design, summary),
      emit: (e) => {
        this.emit(e);
      },
      putFile: (name, body, ct) => this.d.putFile(key(name), body, ct),
      getFile: (name) => this.d.getFile(key(name)),
      nextJob: () => {
        const n = Number(this.meta("jobs") ?? "0") + 1;
        this.setMeta("jobs", String(n));
        return `b${n}`;
      },
      renders: () => JSON.parse(this.meta("renders") ?? "[]") as string[],
      setRenders: (names) => this.setMeta("renders", JSON.stringify(names)),
      lastBuild: () => JSON.parse(this.meta("last_build") ?? "null") as { job: string; kicad: string } | null,
      setLastBuild: (b) => this.setMeta("last_build", JSON.stringify(b)),
      vision,
    };
  }

  // ---------------------------------------------------------------- agents over MCP

  /** A tool call from an agent connected over MCP: the same tools the built-in
   * AI has, run here so every open client sees it happen. build_board starts a
   * background build instead (agentBuild tells how it is going). */
  async agentTool(name: string, input: unknown): Promise<AgentResult> {
    const refused = this.agentRefusal();
    if (refused) return refused;
    if (name === "build_board") return this.startAgentBuild(input);
    // the build works from the design as it was when it started
    if (CHANGES_DESIGN.has(name) && this.buildingForAgent())
      return { content: "A board build is running from the current design. Call wait_for_build, then make the change.", isError: true };
    this.agentCalls++;
    try {
      const r = await runTool({ id: shortId("x"), name, input }, this.toolContext(true), new AbortController().signal);
      return { content: r.outcome.content, ...(r.outcome.images ? { images: r.outcome.images } : {}), ...(r.outcome.isError ? { isError: true } : {}) };
    } finally {
      this.agentCalls--;
      this.agentDone();
    }
  }

  /** Agents wait while HardHub's own AI is answering in this project. */
  private agentRefusal(): AgentResult | null {
    return this.busy || this.meta("queued")
      ? { content: "HardHub's own AI is answering a message in this project. Try again when it has finished.", isError: true }
      : null;
  }

  /** Each agent action is a short turn of its own: clients show "working"
   * while it runs and are idle again after, as with a reply. A question the
   * built-in AI asked stays open (its turn ended waiting for the person). */
  private agentDone(reason: "done" | "error" | "stopped" = "done") {
    if (this.agentCalls > 0 || this.buildingForAgent()) return; // still working
    this.emit({ type: "turn_end", reason: this.meta("pending") ? "waiting_for_user" : reason });
  }

  agentBuild(): AgentBuild | null {
    const v = this.meta("agent_build");
    return v ? (JSON.parse(v) as AgentBuild) : null;
  }
  private setAgentBuild(b: AgentBuild) {
    this.setMeta("agent_build", JSON.stringify(b));
  }
  private buildingForAgent() {
    const b = this.agentBuild();
    return !!b && b.state !== "done";
  }

  /** Queues the build for the alarm; the caller sets the alarm. */
  private startAgentBuild(input: unknown): AgentResult {
    const cur = this.agentBuild();
    if (cur && cur.state !== "done") return { content: `A build is already running (${cur.step ?? "starting"}). Call wait_for_build.`, isError: true };
    const parsed = TOOLS.build_board.schema.safeParse(input ?? {});
    if (!parsed.success) return { content: `Invalid input for build_board: ${parsed.error.issues.map((i) => i.message).join("; ")}`, isError: true };
    if (!this.design().design.board) return { content: "The design has no board yet: set /board (size, layers) first.", isError: true };
    this.setAgentBuild({ id: shortId("x"), input: parsed.data, state: "queued" });
    return { content: "started" };
  }

  /** Runs a queued agent build (from the alarm). */
  async runAgentBuild(): Promise<void> {
    const b = this.agentBuild();
    if (!b || b.state !== "queued") return;
    this.setAgentBuild({ ...b, state: "running", step: "starting", progress: 0 });
    const abort = (this.buildAbort = new AbortController());
    const base = this.toolContext(true);
    const ctx: ToolContext = {
      ...base,
      emit: (e) => {
        if (e.type === "job" && !e.done) this.setAgentBuild({ ...b, state: "running", step: e.step, progress: e.progress });
        base.emit(e);
      },
    };
    let end: "done" | "error" | "stopped" = "error";
    try {
      const r = await runTool({ id: b.id, name: "build_board", input: b.input }, ctx, abort.signal);
      this.setAgentBuild({ ...b, state: "done", progress: 1, result: { content: r.outcome.content, ...(r.outcome.isError ? { isError: true } : {}) } });
      end = abort.signal.aborted ? "stopped" : r.outcome.isError ? "error" : "done";
    } catch (e) {
      this.setAgentBuild({ ...b, state: "done", result: { content: `build_board failed: ${e instanceof Error ? e.message : String(e)}`, isError: true } });
    } finally {
      this.buildAbort = null;
      this.agentDone(end);
    }
  }

  /** What the person asked their agent for, shown as their message. */
  agentRequest(text: string): AgentResult | null {
    const refused = this.agentRefusal();
    if (refused) return refused;
    this.emit({ type: "user_message", id: shortId("m"), text });
    this.agentDone();
    return null;
  }

  /** A short message from the agent, shown in the project's conversation. */
  agentNote(text: string): AgentResult | null {
    const refused = this.agentRefusal();
    if (refused) return refused;
    this.emit({ type: "assistant_text", id: shortId("t"), text, done: true });
    this.agentDone();
    return null;
  }

  /** The files of the last build that made any. */
  latestArtifacts(): { kind: string; name: string; url: string; bytes?: number }[] {
    const row = this.d.sql.exec(`SELECT json FROM events WHERE json LIKE '%"type":"artifacts"%' ORDER BY seq DESC LIMIT 1`).toArray()[0];
    if (!row) return [];
    const ev = JSON.parse(row.json as string) as ServerEvent;
    return ev.type === "artifacts" ? ev.artifacts : [];
  }

  /** The latest circuit or board checks. */
  latestChecks() {
    const row = this.d.sql.exec(`SELECT json FROM events WHERE json LIKE '%"type":"checks"%' ORDER BY seq DESC LIMIT 1`).toArray()[0];
    const ev = row ? (JSON.parse(row.json as string) as ServerEvent) : null;
    return ev?.type === "checks" ? ev.results : [];
  }

  file(name: string): Promise<ArrayBuffer | null> {
    return this.d.getFile(`projects/${this.projectId}/${name}`);
  }
}

