// The HardHub API over HTTP and WebSocket (contract: packages/protocol/src/api.ts).
// The session token goes in the Authorization header, so the API can live on
// another origin (localhost:8787 in dev, its own hostname on Cloudflare).
import {
  AuthStart,
  Me,
  ProjectDetail,
  ProjectSummary,
  ServerEvent,
  Session,
  type ClientMessage,
  type LlmProvider,
  type LlmSettings,
} from "@hardhub/protocol";
import type { z } from "zod";
import { ApiError, type Backend, type LinkStatus, type ProjectLink } from "./backend";

const TOKEN_KEY = "hh_token";

function readToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}
function writeToken(t: string | null) {
  try {
    if (t) localStorage.setItem(TOKEN_KEY, t);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* private mode: the session lasts as long as the tab */
  }
}

/** ws(s):// URL for a path on an http(s):// base. */
export function wsUrl(base: string, path: string, token: string | null, after: number): string {
  const u = new URL(path, base.endsWith("/") ? base : base + "/");
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  if (token) u.searchParams.set("token", token);
  u.searchParams.set("after", String(after));
  return u.toString();
}

type Fetch = typeof fetch;

export class ApiClient implements Backend {
  readonly kind = "api" as const;
  private tok: string | null;

  constructor(
    readonly base: string,
    private readonly fetchImpl: Fetch = (...a) => fetch(...a),
    private readonly WS: typeof WebSocket = globalThis.WebSocket,
  ) {
    this.base = base.replace(/\/+$/, "");
    this.tok = readToken();
  }

  token() {
    return this.tok;
  }
  adoptToken(t: string) {
    this.tok = t;
    writeToken(t);
  }

  private async req<T>(method: string, path: string, body?: unknown, schema?: z.ZodType<T>): Promise<T> {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers["content-type"] = "application/json";
    if (this.tok) headers.authorization = `Bearer ${this.tok}`;
    const res = await this.fetchImpl(this.base + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      let msg = res.statusText || `HTTP ${res.status}`;
      let detail: string | undefined;
      try {
        const j = (await res.json()) as { error?: string; detail?: string };
        msg = j.error ?? msg;
        detail = j.detail;
      } catch {
        /* not JSON */
      }
      if (res.status === 401) {
        this.tok = null;
        writeToken(null);
      }
      throw new ApiError(res.status, msg, detail);
    }
    if (res.status === 204 || !schema) return undefined as T;
    return schema.parse(await res.json());
  }

  async ping() {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 2500);
    try {
      await this.fetchImpl(this.base + "/health", { signal: ctl.signal });
      return true;
    } catch {
      return false;
    } finally {
      clearTimeout(t);
    }
  }

  async authStart(email: string) {
    return this.req("POST", "/auth/start", { email }, AuthStart);
  }
  async authVerify(token: string) {
    const s = await this.req("POST", "/auth/verify", { token }, Session);
    this.adoptToken(s.token);
    return s;
  }
  async logout() {
    try {
      await this.req("POST", "/auth/logout");
    } finally {
      this.tok = null;
      writeToken(null);
    }
  }
  me() {
    return this.req("GET", "/me", undefined, Me);
  }
  setLlm(llm: LlmSettings) {
    return this.req("PATCH", "/me/llm", llm, Me);
  }
  saveKey(provider: LlmProvider, key: string) {
    return this.req("PUT", `/me/keys/${provider}`, { key }, Me);
  }
  deleteKey(provider: LlmProvider) {
    return this.req("DELETE", `/me/keys/${provider}`, undefined, Me);
  }
  listProjects() {
    return this.req("GET", "/projects", undefined, ProjectSummary.array());
  }
  createProject(input: { name?: string; prompt?: string }) {
    return this.req("POST", "/projects", input, ProjectSummary);
  }
  getProject(id: string) {
    return this.req("GET", `/projects/${encodeURIComponent(id)}`, undefined, ProjectDetail);
  }
  renameProject(id: string, name: string) {
    return this.req("PATCH", `/projects/${encodeURIComponent(id)}`, { name }, ProjectSummary);
  }
  deleteProject(id: string) {
    return this.req<void>("DELETE", `/projects/${encodeURIComponent(id)}`);
  }
  fileUrl(_projectId: string, url: string) {
    // artifact urls are API-relative (/projects/:id/files/:name); <img> and
    // download links cannot send a header, so the token rides in the query
    if (/^(https?:|blob:|data:)/.test(url)) return url;
    const u = new URL(this.base + url);
    if (this.tok) u.searchParams.set("token", this.tok);
    return u.toString();
  }

  connect(
    projectId: string,
    after: number,
    onEvent: (e: ServerEvent) => void,
    onStatus: (s: LinkStatus) => void,
  ): ProjectLink {
    let ws: WebSocket | null = null;
    let closed = false;
    let last = after;
    let tries = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const queue: ClientMessage[] = [];

    const open = () => {
      onStatus("connecting");
      ws = new this.WS(wsUrl(this.base + "/", `projects/${encodeURIComponent(projectId)}/ws`, this.tok, last));
      ws.onopen = () => {
        tries = 0;
        onStatus("open");
        ws!.send(JSON.stringify({ type: "hello", after: last } satisfies ClientMessage));
        for (const m of queue.splice(0)) ws!.send(JSON.stringify(m));
      };
      ws.onmessage = (m) => {
        let parsed: ServerEvent;
        try {
          parsed = ServerEvent.parse(JSON.parse(String(m.data)));
        } catch {
          return; // a newer server may send event types this client doesn't know
        }
        if (parsed.seq <= last) return; // replay overlap
        last = parsed.seq;
        onEvent(parsed);
      };
      ws.onclose = () => {
        ws = null;
        onStatus("closed");
        if (closed) return;
        // reconnect with backoff; hello{after} replays what was missed
        const delay = Math.min(10000, 500 * 2 ** tries++);
        timer = setTimeout(open, delay);
      };
      ws.onerror = () => ws?.close();
    };
    open();

    return {
      send(msg) {
        if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
        else queue.push(msg);
      },
      close() {
        closed = true;
        clearTimeout(timer);
        ws?.close();
      },
    };
  }
}
