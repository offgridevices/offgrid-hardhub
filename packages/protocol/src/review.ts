// The board test report: <slug>-tests.json (artifact kind "report"), written by
// the engine's test step on every build, hand edit and test run. The checks
// themselves travel as CheckResults (events.ts); this file holds what does not
// fit a check: the stackup, the heat maps, the power tree, the supply
// simulations and the part stress table, for clients to draw.
//
// Frame: board mm from the centre, y down (the design's frame).
import { z } from "zod";

export const StackLayer = z.object({
  name: z.string(), // "F.Cu", "Core", "F.Mask"
  kind: z.enum(["silk", "mask", "paste", "copper", "dielectric"]),
  thickness: z.number().optional(), // mm
  material: z.string().optional(),
  role: z.string().optional(), // copper: "signal", "plane GND", "mixed"
});
export type StackLayer = z.infer<typeof StackLayer>;

export const Grid = z.object({ x0: z.number(), y0: z.number(), dx: z.number(), dy: z.number(), nx: z.number().int(), ny: z.number().int() });
export type Grid = z.infer<typeof Grid>;

export const HeatMap = z.object({
  ambient: z.number(),
  min: z.number(),
  max: z.number(),
  max_at: z.tuple([z.number(), z.number()]).optional(),
  // nx*ny bytes, base64, row-major from y0: 0 = min, 255 = max (mask says which cells are board)
  u8: z.string(),
});
export type HeatMap = z.infer<typeof HeatMap>;

export const PartHeat = z.object({
  ref: z.string(),
  power: z.number(), // W
  temps: z.array(z.object({ ambient: z.number(), board: z.number(), junction: z.number().optional() })),
  temp_max: z.number().optional(),
  temp_min: z.number().optional(),
  assumed: z.boolean().optional(), // the rating or the power was a typical value, not from the datasheet
  how: z.string().optional(), // how its heat was worked out ("LDO: (5 V - 3.3 V) x 0.5 A")
});
export type PartHeat = z.infer<typeof PartHeat>;

export const PowerNode = z.object({
  net: z.string(),
  voltage: z.number().optional(),
  source: z.string().optional(), // the ref feeding it
  from: z.string().optional(), // the net that source takes power from
  load: z.number().optional(), // A drawn
  capacity: z.number().optional(), // A the source can give
});

export const PowerDrop = z.object({
  net: z.string(),
  source: z.string().optional(),
  sinks: z.array(z.object({ ref: z.string(), drop_mv: z.number() })).default([]),
  worst_mv: z.number(),
  pct: z.number(),
  resistance_mohm: z.number().optional(),
});

export const Curve = z.object({ net: z.string() }).catchall(z.unknown());

export const Stress = z.object({
  ref: z.string(),
  what: z.string(), // "voltage", "power", "current"
  value: z.number(),
  rating: z.number(),
  pct: z.number(),
  limit_pct: z.number().optional(),
  ambient: z.number().optional(),
  note: z.string().optional(),
});
export type Stress = z.infer<typeof Stress>;

export const TestReport = z.object({
  version: z.literal(1),
  made_at: z.string(),
  tools: z.record(z.string(), z.string()).default({}),
  ambient: z.object({ min: z.number(), max: z.number(), points: z.array(z.number()) }),
  board: z.object({
    width: z.number(),
    height: z.number(),
    layers: z.number().int(),
    thickness: z.number(),
    stackup: z.array(StackLayer).default([]),
  }),
  summary: z.object({
    pass: z.number(),
    fail: z.number(),
    warn: z.number(),
    skip: z.number(),
    na: z.number(),
    verdict: z.enum(["ready", "check", "fix"]), // ready: nothing to do; check: warnings to look at; fix: failures
  }),
  thermal: z
    .object({ grid: Grid, mask: z.string(), maps: z.array(HeatMap), parts: z.array(PartHeat) })
    .nullable()
    .default(null),
  power: z
    .object({
      tree: z.array(PowerNode).default([]),
      drop: z.array(PowerDrop).default([]),
      pdn: z.array(Curve).default([]), // { net, target_ohm, f: Hz[], z: Ω[], caps: ref[] }
      step: z.array(Curve).default([]), // { net, t_us: µs[], v: V[], min_v, nominal }
    })
    .default({ tree: [], drop: [], pdn: [], step: [] }),
  stress: z.array(Stress).default([]),
  timings: z.record(z.string(), z.number()).default({}),
});
export type TestReport = z.infer<typeof TestReport>;
