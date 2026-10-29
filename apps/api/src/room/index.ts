// ProjectRoom: the Durable Object for one project. Holds the RoomCore on the
// object's own SQLite storage and the project's WebSockets (hibernatable: an
// idle project costs nothing, and wakes on the next message).
import { DurableObject } from "cloudflare:workers";
import { type BoardEditRequest, ClientMessage } from "@hardhub/protocol";
import { CONVERTERS, llmFor } from "../agent/llm";
import type { TurnInput } from "../agent/loop";
import { touchProject } from "../db";
import { engineFor } from "../engine";
import type { Env } from "../env";
import { CHAT_CLIENT, bridgeFor } from "../bridge";
import { createChatToken, deleteSession, getMe } from "../db";
import { RoomCore } from "./core";

export class ProjectRoom extends DurableObject<Env> {
  private readonly core: RoomCore;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.core = new RoomCore({
      sql: ctx.storage.sql,
      broadcast: (frame) => {
        for (const ws of ctx.getWebSockets()) {
          // a socket gets live frames only after its replay, so it sees every event once, in order
          if (!(ws.deserializeAttachment() as { ready?: boolean } | null)?.ready) continue;
          try {
            ws.send(frame);
          } catch {
            // a socket closing as we send: the client replays on reconnect
          }
        }
      },
      llm: (ownerId) => llmFor(env, ownerId),
      converters: CONVERTERS,
      engine: engineFor(env),
      putFile: async (key, body, contentType) => {
        await env.FILES.put(key, body, { httpMetadata: { contentType } });
      },
      getFile: async (key) => (await env.FILES.get(key))?.arrayBuffer() ?? null,
      touch: (projectId, fields) => touchProject(env, projectId, fields),
      chat: async (ownerId) => {
        const bridge = bridgeFor(env);
        const me = bridge ? await getMe(env, ownerId) : null;
        if (!bridge || me?.llm.provider !== "claude-code") return null;
        const mcpUrl = env.MCP_URL;
        const model = me.llm.model && me.llm.model !== "default" ? me.llm.model : undefined;
        const project = () => this.core.projectId;
        return {
          async *run(req, signal) {
            if (!mcpUrl) throw new Error("MCP_URL is not set, so Claude Code cannot reach HardHub's tools.");
            // a token for this turn only: Claude Code reaches the board through /mcp with it
            const token = await createChatToken(env, ownerId, CHAT_CLIENT);
            try {
              yield* bridge.turn({ ...req, project: project(), mcp: { url: mcpUrl, token }, ...(model ? { model } : {}) }, signal);
            } finally {
              await deleteSession(env, token);
            }
          },
        };
      },
    });
  }

  // ------------------------------------------------------------- RPC

  init(projectId: string, ownerId: string, name: string) {
    this.core.init(projectId, ownerId, name);
  }

  detail() {
    const { design, version } = this.core.design();
    return { design, design_version: version, last_seq: this.core.lastSeq(), busy: this.core.busy || this.core.editing };
  }

  /** the person's hand edits to the routed board; answers when they are checked */
  editBoard(req: BoardEditRequest) {
    return this.core.editBoard(req);
  }

  events(after: number, limit: number) {
    return this.core.events(after, limit);
  }

  /** the first prompt of a new project: runs right away, from an alarm */
  async start(input: TurnInput) {
    this.core.queue(input);
    await this.ctx.storage.setAlarm(Date.now());
  }

  // ------------------------------------------------------------- agents over MCP

  /** One tool call from a connected agent. A build starts in the background. */
  async agentTool(name: string, input: unknown, fromChat = false) {
    const r = await this.core.agentTool(name, input, fromChat);
    if (name === "build_board" && !r.isError) {
      // a chat turn is itself running in this room's alarm, and a second alarm
      // waits for the first to finish: its build starts right away instead
      if (fromChat) this.ctx.waitUntil(this.core.runAgentBuild());
      else await this.ctx.storage.setAlarm(Date.now());
    }
    return r;
  }

  agentBuild() {
    return this.core.agentBuild();
  }

  agentAsk(questions: unknown) {
    return this.core.agentAsk(questions);
  }

  agentRequest(text: string) {
    return this.core.agentRequest(text);
  }

  agentNote(text: string, fromChat = false) {
    return this.core.agentNote(text, fromChat);
  }

  agentResults() {
    return { artifacts: this.core.latestArtifacts(), checks: this.core.latestChecks() };
  }

  agentFile(name: string) {
    return this.core.file(name);
  }

  async destroy() {
    for (const ws of this.ctx.getWebSockets()) ws.close(1000, "project deleted");
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }

  override async alarm() {
    await this.core.runQueued();
    await this.core.runAgentBuild();
  }

  // ------------------------------------------------------------- WebSocket

  override async fetch(req: Request): Promise<Response> {
    if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") return new Response("expected a WebSocket", { status: 426 });
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  override async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer) {
    let msg: ClientMessage;
    try {
      msg = ClientMessage.parse(JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw)));
    } catch {
      ws.send(JSON.stringify({ type: "error", message: "Unreadable message.", retryable: false, seq: this.core.lastSeq(), at: new Date().toISOString() }));
      return;
    }
    if (msg.type === "hello") {
      // synchronous: no live frame can slip in between the replay and "ready"
      for (const frame of this.core.replay(msg.after)) ws.send(frame);
      ws.serializeAttachment({ ready: true });
    } else if (msg.type === "stop") {
      this.core.stop();
    } else if (this.core.accept({ text: msg.text, ...(msg.answers ? { answers: msg.answers } : {}) })) {
      // the turn runs from the alarm, outside this socket's event
      await this.ctx.storage.setAlarm(Date.now());
    }
  }

  override async webSocketClose(ws: WebSocket, code: number) {
    try {
      ws.close(code === 1005 ? 1000 : code, "closing");
    } catch {
      // already closed
    }
  }
}
