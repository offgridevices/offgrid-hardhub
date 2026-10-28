// The design document: everything HardHub knows about one board.
//
// The AI edits it through tools, the engine turns it into KiCad files, and
// every client draws from it. Units are millimetres, volts, amps and US
// dollars unless a field says otherwise. Board coordinates have their origin
// at the board's centre, x to the right and y down (KiCad's convention).
import { z } from "zod";

export const STAGES = ["idea", "parts", "circuit", "board", "layout", "checks", "view", "order"] as const;
export const Stage = z.enum(STAGES);
export type Stage = z.infer<typeof Stage>;

export const Requirement = z.object({
  id: z.string().regex(/^R\d+$/),
  text: z.string().min(1),
  // how the requirement is checked, in words ("DRC", "power budget at 45 C", "bench test")
  check: z.string().optional(),
  status: z.enum(["open", "met", "unmet", "limit"]).default("open"),
  note: z.string().optional(),
});
export type Requirement = z.infer<typeof Requirement>;

export const Option = z.object({
  id: z.string(),
  label: z.string(),
  detail: z.string().optional(),
});

export const Decision = z.object({
  id: z.string().regex(/^D\d+$/),
  stage: Stage,
  question: z.string(),
  options: z.array(Option).min(1),
  recommended: z.string().optional(),
  chosen: z.string().optional(),
  why: z.string().optional(),
  at: z.string().optional(), // ISO time the person chose
});
export type Decision = z.infer<typeof Decision>;

export const PriceBreak = z.object({ qty: z.number().int().positive(), usd: z.number().nonnegative() });

export const Sourcing = z.object({
  lcsc: z.string().regex(/^C\d+$/),
  // JLCPCB assembly library tier: basic parts carry no loading fee
  tier: z.enum(["basic", "preferred", "extended"]).optional(),
  stock: z.number().int().nonnegative().optional(),
  prices: z.array(PriceBreak).default([]),
  checked_at: z.string().optional(), // ISO date the catalogue was read
});

export const PartKind = z.enum(["U", "R", "C", "L", "D", "LED", "Q", "J", "SW", "Y", "F", "FB", "TP", "H", "MOD", "other"]);

export const Part = z.object({
  mpn: z.string(),
  maker: z.string(),
  kind: PartKind,
  value: z.string().optional(), // "10k", "100nF 50V X7R"
  description: z.string(),
  // KiCad footprint id: "Library:Footprint". "hh:*" footprints come from the
  // fab's own library for that LCSC part, fetched and cleaned by the engine.
  footprint: z.string().regex(/^[\w.+-]+:[\w.+\-]+$/),
  datasheet: z.string().url().optional(),
  lifecycle: z.enum(["active", "nrnd", "eol", "unknown"]).default("unknown"),
  // false: fitted by hand or not fitted (test points, mounting holes)
  assembled: z.boolean().default(true),
  sourcing: Sourcing.optional(),
});
export type Part = z.infer<typeof Part>;

export const Component = z.object({
  ref: z.string().regex(/^[A-Z]+\d+$/),
  part: z.string(), // key into design.parts
  block: z.string(), // key into design.blocks
  // footprint pad number -> net name; null = deliberately left open
  pins: z.record(z.string(), z.string().nullable()),
  note: z.string().optional(),
});
export type Component = z.infer<typeof Component>;

export const Net = z.object({
  kind: z.enum(["signal", "power", "ground"]).default("signal"),
  voltage: z.number().optional(),
  current: z.number().nonnegative().optional(), // continuous amps, sets track width
  width: z.number().positive().optional(), // explicit track width, mm
  diff_pair: z.string().optional(), // the other half's net name
  note: z.string().optional(),
});
export type Net = z.infer<typeof Net>;

export const Block = z.object({
  name: z.string(),
  purpose: z.string(),
});

export const COPPER_COUNTS = [2, 4, 6, 8, 10, 12, 14, 16] as const;
export const CopperLayer = z.string().regex(/^(F|B|In\d{1,2})\.Cu$/);

export const LayerRole = z.object({
  layer: CopperLayer,
  role: z.enum(["signal", "plane", "mixed"]),
  net: z.string().optional(), // for planes
});

export const Rect = z.tuple([z.number(), z.number(), z.number(), z.number()]); // x0 y0 x1 y1

export const Board = z.object({
  width: z.number().min(5).max(500),
  height: z.number().min(5).max(500),
  corner_radius: z.number().min(0).default(1),
  layers: z
    .number()
    .int()
    .refine((n) => (COPPER_COUNTS as readonly number[]).includes(n), "2, 4, 6, 8, 10, 12, 14 or 16 copper layers"),
  thickness: z.number().default(1.6),
  copper_oz: z.object({ outer: z.number().default(1), inner: z.number().default(0.5) }).default({ outer: 1, inner: 0.5 }),
  fab: z.enum(["jlcpcb", "pcbway"]).default("jlcpcb"),
  mask_color: z.enum(["green", "black", "white", "blue", "red", "purple", "yellow"]).default("black"),
  finish: z.enum(["hasl", "lead-free-hasl", "enig"]).default("lead-free-hasl"),
  holes: z.array(z.object({ x: z.number(), y: z.number(), d: z.number().default(3.2) })).default([]),
  layer_roles: z.array(LayerRole).default([]),
  keepouts: z
    .array(z.object({ rect: Rect, layers: z.array(CopperLayer).default([]), reason: z.string() }))
    .default([]),
});
export type Board = z.infer<typeof Board>;

export const Placement = z.object({
  x: z.number(),
  y: z.number(),
  rot: z.number().default(0),
  side: z.enum(["top", "bottom"]).default("top"),
  locked: z.boolean().default(false),
});
export type Placement = z.infer<typeof Placement>;

export const FirmwarePin = z.object({
  name: z.string(), // "PORT1_EN"
  gpio: z.number().int().nonnegative(),
  net: z.string(),
  dir: z.enum(["in", "out", "analog", "i2c", "spi", "uart", "usb", "other"]),
});

export const Firmware = z.object({
  platform: z.enum(["esphome", "arduino", "esp-idf", "none"]).default("none"),
  mcu: z.string().optional(), // component ref of the main MCU
  pins: z.array(FirmwarePin).default([]),
  files: z.record(z.string(), z.string()).default({}), // path -> contents
});

export const Design = z.object({
  schema: z.literal(1).default(1),
  name: z.string().default("Untitled board"),
  revision: z.string().default("v1"),
  summary: z.string().default(""),
  stage: Stage.default("idea"),
  requirements: z.array(Requirement).default([]),
  decisions: z.array(Decision).default([]),
  blocks: z.record(z.string(), Block).default({}),
  parts: z.record(z.string(), Part).default({}),
  components: z.array(Component).default([]),
  nets: z.record(z.string(), Net).default({}),
  board: Board.optional(),
  placement: z.record(z.string(), Placement).default({}),
  firmware: Firmware.default({ platform: "none", pins: [], files: {} }),
});
export type Design = z.infer<typeof Design>;

export function emptyDesign(name = "Untitled board"): Design {
  return Design.parse({ name });
}

/** Every net named by any component pin, with the pins on it. */
export function netMembers(d: Design): Map<string, { ref: string; pad: string }[]> {
  const out = new Map<string, { ref: string; pad: string }[]>();
  for (const c of d.components)
    for (const [pad, net] of Object.entries(c.pins)) {
      if (!net) continue;
      const list = out.get(net) ?? [];
      list.push({ ref: c.ref, pad });
      out.set(net, list);
    }
  return out;
}
