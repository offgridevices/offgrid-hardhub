// A RoomCore on in-memory SQLite with a fake engine and file store, recording
// every frame it broadcasts.
import type { BoardEdit, CheckResult, Design, JobLine, ServerEvent } from "@hardhub/protocol";
import { CONVERTERS } from "../../src/agent/llm";
import type { Llm } from "../../src/agent/llm/types";
import { type Engine, type InspectOptions, NEED_BOARD, type ViewOptions } from "../../src/engine";
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
  async *build(design: Design, job: string, _signal?: AbortSignal, stopAfter?: string): AsyncIterable<JobLine> {
    this.builds.push(design);
    // a build stopped before the fab files makes no KiCad zip
    const files = !stopAfter || stopAfter === "fab" || stopAfter === "render";
    yield { step: "place", progress: 0.2, message: "placing" };
    yield { step: "route", progress: 0.6, message: "routing" };
    yield {
      done: true,
      ok: true,
      checks: [{ id: "drc", group: "layout", name: "DRC 0/0/0", why: "the fab rejects what breaks its rules", status: "pass" }],
      artifacts: [
        { kind: "board-png", name: "top.png", url: `/jobs/${job}/files/top.png` },
        { kind: "glb", name: "board.glb", url: `/jobs/${job}/files/board.glb` },
        ...(files ? [{ kind: "kicad" as const, name: "board-kicad.zip", url: `/jobs/${job}/files/board-kicad.zip` }] : []),
      ],
      stats: { tracks: 120, vias: 30 },
      placement: { U1: { x: 1, y: 2, rot: 0, side: "top" } },
    };
  }
  /** hand edits sent, with the zip they were applied to; reject: the engine refuses them */
  edits: { design: Design; job: string; zip: number; edits: BoardEdit[] }[] = [];
  reject = "";
  /** held edits wait here, as a slow engine would */
  hold: Promise<void> | null = null;
  async *edit(design: Design, job: string, zip: ArrayBuffer, edits: BoardEdit[]): AsyncIterable<JobLine> {
    this.edits.push({ design, job, zip: zip.byteLength, edits });
    yield { step: "validate", progress: 0.1, message: "applying" };
    if (this.hold) await this.hold;
    if (this.reject) {
      yield { done: true, ok: false, rejected: true, error: this.reject, checks: [], artifacts: [], stats: {}, placement: {} };
      return;
    }
    yield { step: "drc", progress: 0.5, message: "checking" };
    const moved = edits.filter((e) => e.op === "move_part");
    const stats: Record<string, number> = {};
    for (const e of edits) {
      const k = `edits_${e.op === "delete" ? "delete_track" : e.op}`;
      stats[k] = (stats[k] ?? 0) + 1;
    }
    yield {
      done: true,
      ok: true,
      checks: [{ id: "drc-errors", group: "fab", name: "DRC 0 errors", why: "the fab rejects what breaks its rules", status: "pass" }],
      artifacts: [
        { kind: "board-json", name: "board-board.json", url: `/jobs/${job}/files/board-board.json` },
        { kind: "kicad", name: "board-kicad.zip", url: `/jobs/${job}/files/board-kicad.zip` },
        { kind: "package", name: "board-package.zip", url: `/jobs/${job}/files/board-package.zip` },
      ],
      stats,
      // the engine answers in the design's frame (mm from the centre); this fake shifts by 25 mm
      placement: Object.fromEntries(moved.map((e) => [e.ref, { x: e.x - 25, y: e.y - 20, rot: e.rot, side: e.side ?? "top" }])),
    };
  }
  /** views asked for, and whether the engine has "lost" its jobs (a restarted container) */
  views: { job: string; opts: ViewOptions; zip: boolean }[] = [];
  lost = false;
  async view(job: string, opts: ViewOptions, zip?: ArrayBuffer) {
    if (this.lost && !zip) return NEED_BOARD;
    if (opts.net === "NOPE") throw new (await import("../../src/engine")).EngineError("no net NOPE on the board");
    this.views.push({ job, opts, zip: !!zip });
    return PNG.slice().buffer as ArrayBuffer;
  }
  async inspect(job: string, opts: InspectOptions, zip?: ArrayBuffer) {
    if (this.lost && !zip) return NEED_BOARD;
    return { board: { width: 30, height: 20 }, parts: [{ ref: "U1", x: 1, y: 2, rot: 0, side: "top" }], asked: opts.what ?? [], job };
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
