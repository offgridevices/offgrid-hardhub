// ProjectRoom: the Durable Object for one project. Holds the RoomCore on the
// object's own SQLite storage and the project's WebSockets (hibernatable: an
// idle project costs nothing, and wakes on the next message).
import { DurableObject } from "cloudflare:workers";
import { ClientMessage } from "@hardhub/protocol";
import { CONVERTERS, llmFor } from "../agent/llm";
import type { TurnInput } from "../agent/loop";
import { touchProject } from "../db";
import { engineFor } from "../engine";
import type { Env } from "../env";
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
    });
  }

  // ------------------------------------------------------------- RPC

  init(projectId: string, ownerId: string, name: string) {
    this.core.init(projectId, ownerId, name);
  }

  detail() {
    const { design, version } = this.core.design();
    return { design, design_version: version, last_seq: this.core.lastSeq(), busy: this.core.busy };
  }

  events(after: number, limit: number) {
    return this.core.events(after, limit);
  }

  /** the first prompt of a new project: runs right away, from an alarm */
  async start(input: TurnInput) {
    this.core.queue(input);
    await this.ctx.storage.setAlarm(Date.now());
  }

  async destroy() {
    for (const ws of this.ctx.getWebSockets()) ws.close(1000, "project deleted");
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }

  override async alarm() {
    await this.core.runQueued();
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
