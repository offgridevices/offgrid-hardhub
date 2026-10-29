// A schematic sheet laid out from the design: one framed area per block,
// each part drawn with its usual symbol, and every pin ending in what it
// connects to: a power or ground symbol, a net label (pins with the same
// label are connected, as on any schematic), or a cross when it is left
// open. Pure, so it can be tested and memoised.
import type { Component, Design, Net, Part } from "@hardhub/protocol";

export const GRID = 20; // pin pitch
const STUB = 20; // pin length outside a box
const PAD = 30; // inside a block's frame
const GAP = 40; // between symbols
const ROW = 1100; // a block's row width before it wraps
const SHEET_ROW = 2600; // the sheet's row width before blocks wrap
const MARGIN = 60; // sheet border to content
const TITLE_H = 70; // the title block

export type Dir = "l" | "r" | "u" | "d";
export type PinEnd = "power" | "ground" | "label" | "open";

export interface SPin {
  pad: string;
  net: string | null;
  end: PinEnd;
  /** where the pin's free end is, in sheet units */
  x: number;
  y: number;
  /** which way the pin points, away from its symbol */
  dir: Dir;
  /** where the pin meets the body */
  bx: number;
  by: number;
}

export type Shape = "res" | "cap" | "ind" | "diode" | "led" | "xtal" | "fuse" | "box";

export interface SSym {
  ref: string;
  part: string;
  value: string;
  shape: Shape;
  /** the body: a box's rectangle, or a two-pin symbol's span (x is its axis) */
  x: number;
  y: number;
  w: number;
  h: number;
  /** the whole symbol with its labels, for hit tests and framing */
  bounds: [number, number, number, number];
  pins: SPin[];
}

export interface SBlock {
  id: string;
  name: string;
  purpose: string;
  x: number;
  y: number;
  w: number;
  h: number;
  syms: SSym[];
}

export interface Sheet {
  w: number;
  h: number;
  blocks: SBlock[];
  /** each net's pins, for highlighting */
  nets: Map<string, { ref: string; pad: string }[]>;
}

const TWO_PIN: Partial<Record<Part["kind"], Shape>> = { R: "res", C: "cap", L: "ind", FB: "ind", D: "diode", LED: "led", Y: "xtal", F: "fuse" };

const natural = (a: string, b: string) => a.localeCompare(b, "en", { numeric: true });

/** a label's width: mono 10 px letters plus its flag */
export const labelWidth = (net: string) => net.length * 6 + 16;

export function netEnd(name: string | null, nets: Record<string, Net>): PinEnd {
  if (!name) return "open";
  const k = nets[name]?.kind;
  if (k === "ground" || (!k && /^(A|D|P)?GND|^VSS/i.test(name))) return "ground";
  if (k === "power" || (!k && /^(\+?\d+V\d*|VCC|VDD|VBUS|VIN|VBAT|V\d)/i.test(name))) return "power";
  return "label";
}

interface Placed {
  sym: Omit<SSym, "bounds"> & { bounds: [number, number, number, number] };
}

/** A two-pin part, standing up: pin 1 at the top unless that puts ground above power. */
function twoPin(c: Component, value: string, shape: Shape, nets: Record<string, Net>): Placed["sym"] {
  let pads = Object.entries(c.pins).sort(([a], [b]) => natural(a, b));
  const ends = pads.map(([, n]) => netEnd(n, nets));
  if (ends[0] === "ground" || (ends[1] === "power" && ends[0] !== "power")) pads = pads.reverse();
  const [top, bottom] = pads as [[string, string | null], [string, string | null]];
  const lw = (n: string | null) => (n && netEnd(n, nets) !== "ground" ? labelWidth(n) : 30);
  const half = Math.max(30, lw(top[1]) / 2, lw(bottom[1]) / 2);
  const text = Math.max(c.ref.length, value.length) * 6.5 + 20;
  const pins: SPin[] = [
    { pad: top[0], net: top[1], end: netEnd(top[1], nets), x: 0, y: 0, dir: "u", bx: 0, by: 20 },
    { pad: bottom[0], net: bottom[1], end: netEnd(bottom[1], nets), x: 0, y: 80, dir: "d", bx: 0, by: 60 },
  ];
  return { ref: c.ref, part: c.part, value, shape, x: 0, y: 20, w: 0, h: 40, pins, bounds: [-half, -44, Math.max(half, text), 124] };
}

/** Anything else: a box, power pins on top, ground below, the rest down its sides. */
function box(c: Component, value: string, nets: Record<string, Net>): Placed["sym"] {
  const pads = Object.entries(c.pins).sort(([a], [b]) => natural(a, b));
  const top = pads.filter(([, n]) => netEnd(n, nets) === "power");
  const bottom = pads.filter(([, n]) => netEnd(n, nets) === "ground");
  const side = pads.filter(([, n]) => {
    const e = netEnd(n, nets);
    return e === "label" || e === "open";
  });
  const half = Math.ceil(side.length / 2);
  const left = side.slice(0, half);
  const right = side.slice(half);
  const rows = Math.max(left.length, right.length, 1);
  const name = Math.max(c.ref.length * 7.5, value.length * 6.5) + 24;
  const w = Math.max(100, name, (Math.max(top.length, bottom.length) + 1) * GRID);
  const h = Math.max(60, (rows + 1) * GRID + 20);
  const pins: SPin[] = [];
  left.forEach(([pad, net], i) => {
    const y = 30 + i * GRID;
    pins.push({ pad, net, end: netEnd(net, nets), x: -STUB, y, dir: "l", bx: 0, by: y });
  });
  right.forEach(([pad, net], i) => {
    const y = 30 + i * GRID;
    pins.push({ pad, net, end: netEnd(net, nets), x: w + STUB, y, dir: "r", bx: w, by: y });
  });
  const across = (list: [string, string | null][], y: number, by: number, dir: Dir) => {
    const x0 = (w - (list.length - 1) * GRID) / 2;
    list.forEach(([pad, net], i) => pins.push({ pad, net, end: netEnd(net, nets), x: x0 + i * GRID, y, dir, bx: x0 + i * GRID, by }));
  };
  across(top, -STUB, 0, "u");
  across(bottom, h + STUB, h, "d");
  const lw = Math.max(0, ...left.map(([, n]) => (n ? labelWidth(n) : 12)));
  const rw = Math.max(0, ...right.map(([, n]) => (n ? labelWidth(n) : 12)));
  // power symbols carry their net's name above them
  const tw = Math.max(0, ...top.map(([, n]) => labelWidth(n ?? "")));
  return {
    ref: c.ref,
    part: c.part,
    value,
    shape: "box",
    x: 0,
    y: 0,
    w,
    h,
    pins,
    bounds: [-STUB - lw - 4, top.length ? -STUB - 40 : -10, w + STUB + rw + 4, h + (bottom.length ? STUB + 30 : 10)].map((v, i) =>
      i === 0 ? Math.min(v, (w - tw) / 2) : i === 2 ? Math.max(v, (w + tw) / 2) : v,
    ) as [number, number, number, number],
  };
}

function moved(s: Placed["sym"], dx: number, dy: number): SSym {
  return {
    ...s,
    x: s.x + dx,
    y: s.y + dy,
    pins: s.pins.map((p) => ({ ...p, x: p.x + dx, y: p.y + dy, bx: p.bx + dx, by: p.by + dy })),
    bounds: [s.bounds[0] + dx, s.bounds[1] + dy, s.bounds[2] + dx, s.bounds[3] + dy],
  };
}

/** Lay items out left to right, wrapping at `width`; returns their offsets and the size used. */
function flow(sizes: { w: number; h: number }[], width: number, gap: number) {
  const at: { x: number; y: number }[] = [];
  let x = 0;
  let y = 0;
  let rowH = 0;
  let usedW = 0;
  for (const s of sizes) {
    if (x > 0 && x + s.w > width) {
      x = 0;
      y += rowH + gap;
      rowH = 0;
    }
    at.push({ x, y });
    x += s.w + gap;
    rowH = Math.max(rowH, s.h);
    usedW = Math.max(usedW, x - gap);
  }
  return { at, w: usedW, h: y + rowH };
}

export function layoutSheet(design: Design): Sheet {
  const byBlock = new Map<string, Component[]>();
  for (const c of design.components) byBlock.set(c.block, [...(byBlock.get(c.block) ?? []), c]);

  const blocks: SBlock[] = [];
  for (const [id, comps] of byBlock) {
    // boxes first (the chips and connectors), then the small parts by kind
    const syms = comps
      .map((c) => {
        const p = design.parts[c.part];
        const value = p?.value ?? p?.mpn ?? c.part;
        const shape = p ? TWO_PIN[p.kind] : undefined;
        return shape && Object.keys(c.pins).length === 2 ? twoPin(c, value, shape, design.nets) : box(c, value, design.nets);
      })
      .sort((a, b) => Number(a.shape !== "box") - Number(b.shape !== "box") || (a.shape === "box" ? b.pins.length - a.pins.length : a.shape.localeCompare(b.shape)) || natural(a.ref, b.ref));
    const sizes = syms.map((s) => ({ w: s.bounds[2] - s.bounds[0], h: s.bounds[3] - s.bounds[1] }));
    const f = flow(sizes, ROW, GAP);
    const placed = syms.map((s, i) => moved(s, PAD + f.at[i]!.x - s.bounds[0], PAD + 34 + f.at[i]!.y - s.bounds[1]));
    blocks.push({
      id,
      name: design.blocks[id]?.name ?? id,
      purpose: design.blocks[id]?.purpose ?? "",
      x: 0,
      y: 0,
      w: Math.max(f.w + PAD * 2, 260),
      h: f.h + PAD * 2 + 34,
      syms: placed,
    });
  }

  const f = flow(blocks, SHEET_ROW, GAP * 1.5);
  const out = blocks.map((b, i) => {
    const dx = MARGIN + f.at[i]!.x;
    const dy = MARGIN + f.at[i]!.y;
    return { ...b, x: dx, y: dy, syms: b.syms.map((s) => moved(s, dx, dy)) };
  });

  const nets = new Map<string, { ref: string; pad: string }[]>();
  for (const c of design.components)
    for (const [pad, n] of Object.entries(c.pins)) if (n) nets.set(n, [...(nets.get(n) ?? []), { ref: c.ref, pad }]);

  return { w: Math.max(f.w + MARGIN * 2, 900), h: f.h + MARGIN * 2 + TITLE_H + 20, blocks: out, nets };
}
