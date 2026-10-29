// The routed board as vector geometry, and the hand edits a person makes to it
// in a client (drag a track's end, move or delete a via, draw a track, add a
// via, move or rotate a part), as KiCad lets them.
//
// Frame: millimetres, y down, relative to `origin`, the KiCad position of the
// top-left corner of the board outline's bounding box. That is the exact crop
// of the per-layer SVG artifacts, so an overlay drawn in this frame lines up
// with them: a point (x, y) here is (x, y) in every SVG's viewBox. Edits use
// the same frame. (The design document's own frame is mm from the board
// centre; the engine converts.)
//
// The engine writes <slug>-board.json (artifact kind "board-json") on every
// build and every edit; POST /projects/:id/board/edits takes a BoardEditRequest.
import { z } from "zod";
import { CheckResult } from "./events";

export const Pt = z.tuple([z.number(), z.number()]);
export type Pt = z.infer<typeof Pt>;

/** a KiCad copper layer: F.Cu, In1.Cu .. In30.Cu, B.Cu */
const CopperLayer = z.string().regex(/^(F\.Cu|B\.Cu|In\d{1,2}\.Cu)$/, "a copper layer: F.Cu, In1.Cu, ..., B.Cu");
/** an item's KiCad KIID (a uuid), stable across loads and saves of the board */
const ItemId = z.string().min(1).max(64);
const Mm = z.number().finite();
const Size = z.number().positive().max(20);

export const BoardTrack = z.object({
  id: ItemId,
  layer: z.string(),
  net: z.string(),
  width: z.number(),
  a: Pt,
  b: Pt,
  mid: Pt.optional(), // arcs only: a point on the arc between a and b
});
export type BoardTrack = z.infer<typeof BoardTrack>;

export const BoardVia = z.object({
  id: ItemId,
  x: z.number(),
  y: z.number(),
  d: z.number(), // copper diameter
  drill: z.number(),
  net: z.string(),
  from: z.string(), // top layer of the via, e.g. F.Cu
  to: z.string(), // bottom layer, e.g. B.Cu
});
export type BoardVia = z.infer<typeof BoardVia>;

export const BoardPad = z.object({
  num: z.string(),
  net: z.string(),
  x: z.number(),
  y: z.number(),
  w: z.number(),
  h: z.number(),
  rot: z.number(), // degrees, the pad's own orientation on the board
  shape: z.enum(["rect", "circle", "oval", "roundrect", "other"]),
  through: z.boolean(), // a drilled pad, on every copper layer
});
export type BoardPad = z.infer<typeof BoardPad>;

export const BoardFootprint = z.object({
  ref: z.string(),
  x: z.number(), // the footprint's anchor, as design.placement has it
  y: z.number(),
  rot: z.number(), // degrees counter-clockwise, as design.placement has it (a bottom part: before it is flipped)
  side: z.enum(["top", "bottom"]),
  locked: z.boolean(),
  bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]), // [x0, y0, x1, y1]: pads and body, no text
  pads: z.array(BoardPad),
});
export type BoardFootprint = z.infer<typeof BoardFootprint>;

export const BoardZone = z.object({
  layer: z.string(),
  net: z.string(),
  // filled copper, simplified (at most a few hundred points each); a ring
  // inside another is a hole: draw them together with fill-rule evenodd
  polygons: z.array(z.array(Pt)),
});
export type BoardZone = z.infer<typeof BoardZone>;

export const BoardGeometry = z.object({
  units: z.literal("mm"),
  origin: Pt, // KiCad absolute position of the crop's top-left corner
  size: Pt, // width, height of the crop: the SVG artifacts' viewBox size
  layers: z.array(z.string()), // copper layers, top to bottom
  tracks: z.array(BoardTrack),
  vias: z.array(BoardVia),
  footprints: z.array(BoardFootprint),
  zones: z.array(BoardZone),
  rules: z.object({
    track_min: z.number(), // the fab's narrowest track
    clearance: z.number(), // copper to copper
    via_d: z.number(), // a new via's diameter and drill
    via_drill: z.number(),
  }),
});
export type BoardGeometry = z.infer<typeof BoardGeometry>;

// Each edit is applied in order to the board as the last one left it. Moving a
// via or a track end moves only that item: send a set_track for each track
// that should follow. Tracks never follow a moved part either.
export const BoardEdit = z.discriminatedUnion("op", [
  z.object({ op: z.literal("set_track"), id: ItemId, a: Pt, b: Pt, width: Size.optional(), layer: CopperLayer.optional() }),
  // net: taken from the pads, tracks and vias an end touches when left out
  z.object({ op: z.literal("add_track"), layer: CopperLayer, a: Pt, b: Pt, width: Size.optional(), net: z.string().min(1).max(100).optional() }),
  z.object({ op: z.literal("set_via"), id: ItemId, x: Mm, y: Mm }),
  // net: taken from what it touches when left out; d and drill: the board's via by default
  z.object({ op: z.literal("add_via"), x: Mm, y: Mm, net: z.string().min(1).max(100).optional(), d: Size.optional(), drill: Size.optional() }),
  z.object({ op: z.literal("delete"), id: ItemId }), // a track or a via
  // the part's pads move with it; its tracks do not (re-route or redraw them)
  z.object({ op: z.literal("move_part"), ref: z.string().regex(/^[A-Z]+\d+$/), x: Mm, y: Mm, rot: Mm, side: z.enum(["top", "bottom"]).optional() }),
]);
export type BoardEdit = z.infer<typeof BoardEdit>;

export const BoardEditRequest = z.object({
  edits: z.array(BoardEdit).min(1).max(500),
  note: z.string().max(300).optional(), // what the person did, in plain words
});
export type BoardEditRequest = z.infer<typeof BoardEditRequest>;

// POST /projects/:id/board/edits -> 200 BoardEditResult. ok: every check passes
// on the edited board (an edit that breaks a rule is still kept, and the checks
// say what is wrong, as KiCad's DRC would)
export const BoardEditResult = z.object({ ok: z.boolean(), summary: z.string(), checks: z.array(CheckResult) });
export type BoardEditResult = z.infer<typeof BoardEditResult>;
