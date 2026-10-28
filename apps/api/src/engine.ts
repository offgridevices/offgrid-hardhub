// The engine: KiCad, Freerouting and the hardhub Python library behind HTTP
// (contract: packages/protocol/src/engine.ts). Locally it is a docker compose
// service at ENGINE_URL; on Cloudflare it is a Container behind a Durable Object.
import { DurableObject } from "cloudflare:workers";
import {
  CatalogPart,
  CheckResult,
  JobLine,
  Quote,
  type Design,
} from "@hardhub/protocol";
import { z } from "zod";
import type { Env } from "./env";

const ENGINE_PORT = 8080;

/** Owns the engine container on Cloudflare (GA `ctx.container` API): starts
 * it on first use and forwards requests to its port. */
export class EngineContainer extends DurableObject<Env> {
  override async fetch(req: Request): Promise<Response> {
    const c = this.ctx.container;
    if (!c) return new Response("no container bound to this Durable Object", { status: 500 });
    if (!c.running) {
      // the engine reads the JLCPCB/LCSC catalogue, so it needs the internet
      c.start({ enableInternet: true });
      // a board job can take minutes; keep the instance warm between turns
      await c.setInactivityTimeout(15 * 60_000);
    }
    const port = c.getTcpPort(ENGINE_PORT);
    // the server inside takes a few seconds to listen after a cold start
    for (let attempt = 0; ; attempt++) {
      try {
        return await port.fetch(req.clone());
      } catch (e) {
        if (attempt >= 30) throw e;
        await new Promise((r) => setTimeout(r, 500));
      }
    }
  }
}

export interface Engine {
  searchParts(query: string, limit?: number): Promise<CatalogPart[]>;
  getParts(lcsc: string[]): Promise<CatalogPart[]>;
  check(design: Design): Promise<CheckResult[]>;
  quote(design: Design, qty: number[]): Promise<Quote[]>;
  build(design: Design, job: string, signal?: AbortSignal, stopAfter?: string): AsyncIterable<JobLine>;
  file(job: string, name: string): Promise<Response>;
}

type Fetch = (path: string, init?: RequestInit) => Promise<Response>;

export class EngineError extends Error {}

export class HttpEngine implements Engine {
  constructor(private readonly fetch: Fetch) {}

  private async post<T>(path: string, body: unknown, schema: z.ZodType<T>, signal?: AbortSignal): Promise<T> {
    const r = await this.fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    });
    if (!r.ok) throw new EngineError(`engine ${path}: ${r.status} ${(await r.text()).slice(0, 500)}`);
    return schema.parse(await r.json());
  }

  async searchParts(query: string, limit = 10) {
    return (await this.post("/parts/search", { query, limit }, z.object({ parts: z.array(CatalogPart) }))).parts;
  }

  async getParts(lcsc: string[]) {
    return (await this.post("/parts/get", { lcsc }, z.object({ parts: z.array(CatalogPart) }))).parts;
  }

  async check(design: Design) {
    return (await this.post("/check", { design }, z.object({ results: z.array(CheckResult) }))).results;
  }

  async quote(design: Design, qty: number[]) {
    return (await this.post("/quote", { design, qty }, z.object({ quotes: z.array(Quote) }))).quotes;
  }

  async *build(design: Design, job: string, signal?: AbortSignal, stopAfter?: string): AsyncIterable<JobLine> {
    const r = await this.fetch("/build", {
      method: "POST",
      headers: { "content-type": "application/json" },
      // png renders too: the agent looks at its own layout through render
      body: JSON.stringify({ design, job, outputs: ["svg", "glb", "png"], ...(stopAfter ? { stop_after: stopAfter } : {}) }),
      ...(signal ? { signal } : {}),
    });
    if (!r.ok || !r.body) throw new EngineError(`engine /build: ${r.status} ${(await r.text()).slice(0, 500)}`);
    // newline-delimited JSON, one progress line per step, then the result
    const reader = r.body.pipeThrough(new TextDecoderStream()).getReader();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (value) buf += value;
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line) yield JobLine.parse(JSON.parse(line));
      }
      if (done) break;
    }
    if (buf.trim()) yield JobLine.parse(JSON.parse(buf));
  }

  file(job: string, name: string) {
    return this.fetch(`/jobs/${encodeURIComponent(job)}/files/${encodeURIComponent(name)}`);
  }
}

export function engineFor(env: Env): Engine {
  if (env.ENGINE_URL) {
    const base = env.ENGINE_URL.replace(/\/$/, "");
    return new HttpEngine((path, init) => fetch(base + path, init));
  }
  // one shared engine instance; jobs are stateless apart from their outputs
  const stub = env.ENGINE.get(env.ENGINE.idFromName("engine"));
  return new HttpEngine((path, init) => stub.fetch(new Request("http://engine" + path, init)));
}
