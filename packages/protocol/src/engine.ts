// The engine's HTTP contract (engine/hardhub/server.py implements it).
//
//   GET  /health                               -> { ok, kicad, freerouting }
//   POST /parts/search   { query, limit? }     -> { parts: CatalogPart[] }
//   POST /parts/get      { lcsc: string[] }    -> { parts: CatalogPart[] }
//   POST /check          { design }            -> { results: CheckResult[] }
//   POST /quote          { design, qty[] }     -> { quotes: Quote[] }
//   POST /build          { design, job, stop_after? }
//        -> application/x-ndjson stream of JobLine, last line { done: true, ... }
//   GET  /jobs/:job/files/:name                -> an output file
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

export const BuildSteps = ["validate", "footprints", "place", "route", "miter", "pour", "drc", "verify", "fab", "render"] as const;

export const JobLine = z.union([
  z.object({ step: z.enum(BuildSteps), progress: z.number(), message: z.string() }),
  z.object({
    done: z.literal(true),
    ok: z.boolean(),
    error: z.string().optional(),
    checks: z.array(CheckResult),
    artifacts: z.array(Artifact),
    stats: z.record(z.string(), z.number()).default({}),
    // placement the engine chose for parts the design left unplaced
    placement: z.record(z.string(), z.object({ x: z.number(), y: z.number(), rot: z.number(), side: z.enum(["top", "bottom"]) })).default({}),
  }),
]);
export type JobLine = z.infer<typeof JobLine>;
