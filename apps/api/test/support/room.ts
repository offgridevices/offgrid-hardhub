// A RoomCore on in-memory SQLite with a fake engine and file store, recording
// every frame it broadcasts.
import type { CheckResult, Design, JobLine, ServerEvent } from "@hardhub/protocol";
import { CONVERTERS } from "../../src/agent/llm";
import type { Llm } from "../../src/agent/llm/types";
import type { Engine } from "../../src/engine";
import { RoomCore } from "../../src/room/core";
import { doSql } from "./sqlite";

export const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

export class FakeEngine implements Engine {
  builds: Design[] = [];
  checks: CheckResult[] = [{ id: "nets", group: "circuit", name: "No one-pin nets", why: "a one-pin net is a broken wire", status: "pass" }];
  async searchParts(query: string) {
    return [{ lcsc: "C2913198", mpn: `ESP32-S3-WROOM-1-N8 (${query})`, tier: "extended" as const, stock: 5000, prices: [{ qty: 1, usd: 3.5 }], lifecycle: "active" as const }];
  }
  async getParts(lcsc: string[]) {
    return lcsc.map((c) => ({ lcsc: c, mpn: "X", prices: [], lifecycle: "active" as const }));
  }
  async check() {
    return this.checks;
  }
  async quote() {
    return [];
  }
  async *build(design: Design, job: string): AsyncIterable<JobLine> {
    this.builds.push(design);
    yield { step: "place", progress: 0.2, message: "placing" };
    yield { step: "route", progress: 0.6, message: "routing" };
    yield {
      done: true,
      ok: true,
      checks: [{ id: "drc", group: "layout", name: "DRC 0/0/0", why: "the fab rejects what breaks its rules", status: "pass" }],
      artifacts: [
        { kind: "board-png", name: "top.png", url: `/jobs/${job}/files/top.png` },
        { kind: "glb", name: "board.glb", url: `/jobs/${job}/files/board.glb` },
      ],
      stats: { tracks: 120, vias: 30 },
      placement: { U1: { x: 1, y: 2, rot: 0, side: "top" } },
    };
  }
  async file(_job: string, name: string) {
    return new Response(name.endsWith(".png") ? PNG : new Uint8Array([1, 2, 3]), { headers: { "content-type": name.endsWith(".png") ? "image/png" : "model/gltf-binary" } });
  }
}

export function makeRoom(llm: Llm | (() => Promise<Llm>), engine: Engine = new FakeEngine()) {
  const frames: string[] = [];
  const files = new Map<string, Uint8Array>();
  const sql = doSql();
  const touched: unknown[] = [];
  const deps = {
    sql,
    broadcast: (f: string) => frames.push(f),
    llm: typeof llm === "function" ? llm : async () => llm,
    converters: CONVERTERS,
    engine,
    putFile: async (key: string, body: ReadableStream | ArrayBuffer) => {
      files.set(key, new Uint8Array(body instanceof ArrayBuffer ? body : await new Response(body).arrayBuffer()));
    },
    getFile: async (key: string) => {
      const f = files.get(key);
      return f ? (f.slice().buffer as ArrayBuffer) : null;
    },
    touch: async (_id: string, fields: unknown) => {
      touched.push(fields);
    },
  };
  const core = new RoomCore(deps);
  core.init("p_test", "u_test", "Test board");
  const events = () => frames.map((f) => JSON.parse(f) as ServerEvent);
  const stored = () => core.events(-1, 1000).events;
  return { core, frames, events, stored, files, touched, sql, deps };
}
