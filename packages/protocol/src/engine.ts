// The engine's HTTP contract (engine/hardhub/server.py implements it).
//
//   GET  /health                               -> { ok, kicad, freerouting }
//   POST /parts/search   { query, limit? }     -> { parts: CatalogPart[] }
//   POST /parts/get      { lcsc: string[] }    -> { parts: CatalogPart[] }
//   POST /check          { design }            -> { results: CheckResult[] }
//   POST /quote          { design, qty[] }     -> { quotes: Quote[] }
//   POST /build          { design, job, stop_after?, outputs? }
//        -> application/x-ndjson stream of JobLine, last line { done: true, ... }
//        outputs: extras to make, ["svg", "glb"] by default; "png", "step" on request
//        429 { error, retryable: true } while the engine is at its build limit
//   POST /edit   { job, design, kicad_zip_b64, edits: BoardEdit[], outputs? }
//        the routed board in the KiCad zip (a build's "kicad" artifact) with the
//        person's hand edits applied in order, zones refilled, then the end of a
//        build (drc, verify, fab, render) without placing or routing again.
//        Streamed like /build; the last line's placement holds the parts it
//        moved, in the design's frame. An edit that names no item, a layer the
//        board lacks or a point off the board changes nothing: ok false,
//        rejected true, error naming it.
//   GET  /jobs/:job/files/:name                -> an output file
//   DELETE /jobs/:job                          -> 204, the job's files forgotten
//
// Artifact urls in a JobLine are the engine's own (/jobs/:job/files/:name);
// the API stores the files and rewrites them to /projects/:id/files/:name.
// JobLine stats carry each step's time in seconds as t_<step>.
//
// The engine is stateless between jobs apart from its cache of fetched
// footprints and finished job outputs (which the API copies to R2).
import { z } from "zod";
import { CheckResult, Artifact } from "./events";

export const CatalogPart = z.object({
  lcsc: z.string(),
  mpn: z.string(),
  maker: z.string().optional(),
  package: z.string().optional(),
  description: z.string().optional(),
  tier: z.enum(["basic", "preferred", "extended"]).optional(),
  stock: z.number().int().optional(),
  prices: z.array(z.object({ qty: z.number(), usd: z.number() })).default([]),
  datasheet: z.string().optional(),
  lifecycle: z.enum(["active", "nrnd", "eol", "unknown"]).default("unknown"),
});
export type CatalogPart = z.infer<typeof CatalogPart>;

export const Quote = z.object({
  layers: z.number().int(),
  qty: z.number().int(),
  pcb_usd: z.number(),
  assembly_usd: z.number(),
  parts_usd: z.number(),
  total_usd: z.number(),
  per_board_usd: z.number(),
  basis: z.string(), // where the numbers come from, dated
});
export type Quote = z.infer<typeof Quote>;

export const BuildOutputs = z.array(z.enum(["svg", "glb", "png", "step"]));

export const BuildSteps =["validate", "footprints", "place", "route", "miter", "pour", "drc", "verify", "fab", "render"] as const;

export const JobLine = z.union([
  z.object({ step: z.enum(BuildSteps), progress: z.number(), message: z.string() }),
  z.object({
    done: z.literal(true),
    ok: z.boolean(),
    error: z.string().optional(),
    rejected: z.boolean().optional(), // /edit: refused before anything changed (error says why)
    checks: z.array(CheckResult),
    artifacts: z.array(Artifact),
    stats: z.record(z.string(), z.number()).default({}),
    // placement the engine chose for parts the design left unplaced
    placement: z.record(z.string(), z.object({ x: z.number(), y: z.number(), rot: z.number(), side: z.enum(["top", "bottom"]) })).default({}),
  }),
]);
export type JobLine = z.infer<typeof JobLine>;
