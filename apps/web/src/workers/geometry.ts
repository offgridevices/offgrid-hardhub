// Board geometry that does not depend on three.js: the demo layer drawings
// and the demo 3D boxes, built from a design. Shared by the worker and tests.
import type { Design } from "@hardhub/protocol";

export interface MeshData {
  key: string;
  group: "board" | "top" | "bottom";
  color: [number, number, number];
  positions: Float32Array;
  normals: Float32Array;
  index: Uint32Array;
}

export interface SceneData {
  meshes: MeshData[];
  /** axis that points out of the board's top face: 0 x, 1 y, 2 z */
  up: 0 | 1 | 2;
  thickness: number;
  size: [number, number, number];
  center: [number, number, number];
}

/* ---------- footprint sizes (mm) for demo drawings ---------- */

export function footprintSize(fp: string, kind: string): [number, number, number] {
  const m = /(\d{4})_(\d{4})Metric/.exec(fp);
  if (m) return [Number(m[2]!.slice(0, 2)) / 10, Number(m[2]!.slice(2)) / 10, kind === "C" ? 0.6 : 0.4];
  if (/ESP32|WROOM/i.test(fp)) return [18, 25.5, 3.1];
  if (/USB-A/i.test(fp)) return [14.5, 13.8, 7];
  if (/USB-C/i.test(fp)) return [8.9, 7.3, 3.2];
  if (/IND/i.test(fp)) return [7, 6.6, 3];
  if (/SOT-23/i.test(fp)) return [2.9, 1.6, 1.1];
  if (/SOT-223/i.test(fp)) return [6.5, 3.5, 1.6];
  if (/D_SMA/i.test(fp)) return [4.3, 2.6, 2.1];
  if (/QFN|DFN|WSON/i.test(fp)) return [3, 3, 0.8];
  if (/LED-2020/i.test(fp)) return [2, 2, 0.9];
  if (/1206/.test(fp)) return [3.2, 1.6, 0.6];
  return [2, 2, 1];
}

function rotated(w: number, h: number, rot: number): [number, number] {
  return Math.round(rot / 90) % 2 ? [h, w] : [w, h];
}

/* ---------- demo layer SVGs ---------- */

export const LAYER_COLORS: Record<string, string> = {
  "F.Cu": "#c9a25c",
  "In1.Cu": "#7f9460",
  "In2.Cu": "#9c7468",
  "B.Cu": "#6d8db2",
  "F.Silkscreen": "#f1ece0",
  "B.Silkscreen": "#b9b0a0",
  "Edge.Cuts": "#d9c9a8",
};

interface Pad {
  x: number;
  y: number;
  ref: string;
}

/** Pad positions spread along each part's long edges, for the drawings. */
function pads(d: Design): Map<string, Pad[]> {
  const byNet = new Map<string, Pad[]>();
  for (const c of d.components) {
    const pl = d.placement[c.ref];
    const part = d.parts[c.part];
    if (!pl || !part) continue;
    const [w, h] = rotated(...(footprintSize(part.footprint, part.kind).slice(0, 2) as [number, number]), pl.rot);
    const pins = Object.entries(c.pins);
    pins.forEach(([, net], i) => {
      if (!net) return;
      const side = i % 2 ? 1 : -1;
      const along = pins.length > 2 ? (Math.floor(i / 2) / Math.max(1, Math.ceil(pins.length / 2) - 1) - 0.5) * 0.8 : 0;
      const p = w >= h ? { x: pl.x + side * w * 0.45, y: pl.y + along * h } : { x: pl.x + along * w, y: pl.y + side * h * 0.45 };
      byNet.set(net, [...(byNet.get(net) ?? []), { ...p, ref: c.ref }]);
    });
  }
  return byNet;
}

/** A track from a to b: straight, then one 45° leg (never a right angle). */
function route45(a: Pad, b: Pad): string {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const d = Math.min(Math.abs(dx), Math.abs(dy));
  const mx = Math.abs(dx) > Math.abs(dy) ? b.x - Math.sign(dx) * d : a.x;
  const my = Math.abs(dx) > Math.abs(dy) ? a.y : b.y - Math.sign(dy) * d;
  return `M${a.x.toFixed(2)} ${a.y.toFixed(2)}L${mx.toFixed(2)} ${my.toFixed(2)}L${b.x.toFixed(2)} ${b.y.toFixed(2)}`;
}

export function demoLayers(d: Design): Record<string, string> {
  const b = d.board ?? { width: 60, height: 40, corner_radius: 1, layers: 2, holes: [], layer_roles: [], keepouts: [] };
  const W = b.width;
  const H = b.height;
  const vb = `${-W / 2} ${-H / 2} ${W} ${H}`;
  const wrap = (body: string) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}" width="${W}mm" height="${H}mm">${body}</svg>`;
  const outline = `<rect x="${-W / 2}" y="${-H / 2}" width="${W}" height="${H}" rx="${b.corner_radius}"/>`;
  const nets = pads(d);
  const planes = new Map(b.layer_roles.filter((r) => r.role === "plane").map((r) => [r.net, r.layer]));
  const out: Record<string, string> = {};
  const tracks: Record<string, string[]> = { "F.Cu": [], "B.Cu": [] };
  let i = 0;
  for (const [net, ps] of nets) {
    if (planes.has(net) || ps.length < 2) continue;
    const layer = i++ % 3 === 2 ? "B.Cu" : "F.Cu";
    const width = d.nets[net]?.current ? Math.max(0.25, d.nets[net]!.current! * 0.5) : 0.2;
    const sorted = [...ps].sort((p, q) => p.x - q.x);
    const path = sorted.slice(1).map((p, k) => route45(sorted[k]!, p)).join("");
    tracks[layer]!.push(`<path d="${path}" stroke-width="${width.toFixed(2)}"/>`);
  }
  const padRects = (filter: (s: string) => boolean) =>
    d.components
      .filter((c) => filter(d.placement[c.ref]?.side ?? "top"))
      .map((c) => {
        const pl = d.placement[c.ref]!;
        const part = d.parts[c.part];
        if (!pl || !part) return "";
        const [w, h] = rotated(...(footprintSize(part.footprint, part.kind).slice(0, 2) as [number, number]), pl.rot);
        return `<rect x="${(pl.x - w / 2).toFixed(2)}" y="${(pl.y - h / 2).toFixed(2)}" width="${w}" height="${h}" fill-opacity="0.35"/>`;
      })
      .join("");
  const holes = b.holes.map((h) => `<circle cx="${h.x}" cy="${h.y}" r="${h.d / 2}"/>`).join("");
  const copper = (layer: string) => {
    const col = LAYER_COLORS[layer]!;
    const plane = [...planes.entries()].find(([, l]) => l === layer);
    const fill = plane ? `<rect x="${-W / 2 + 0.5}" y="${-H / 2 + 0.5}" width="${W - 1}" height="${H - 1}" rx="${b.corner_radius}" fill="${col}" fill-opacity="0.32"/>` : "";
    const t = (tracks[layer] ?? []).join("");
    return wrap(`${fill}<g fill="none" stroke="${col}" stroke-linecap="round" stroke-linejoin="round">${t}</g><g fill="${col}">${layer === "F.Cu" ? padRects((s) => s === "top") : layer === "B.Cu" ? padRects((s) => s === "bottom") : ""}</g><g fill="#100d09">${holes}</g>`);
  };
  for (const r of b.layer_roles.length ? b.layer_roles.map((r) => r.layer) : ["F.Cu", "B.Cu"]) out[r] = copper(r);
  const labels = d.components
    .map((c) => {
      const pl = d.placement[c.ref];
      const part = d.parts[c.part];
      if (!pl || !part || pl.side !== "top") return "";
      const [w, h] = rotated(...(footprintSize(part.footprint, part.kind).slice(0, 2) as [number, number]), pl.rot);
      const big = w * h > 20;
      return `<rect x="${(pl.x - w / 2 - 0.3).toFixed(2)}" y="${(pl.y - h / 2 - 0.3).toFixed(2)}" width="${(w + 0.6).toFixed(2)}" height="${(h + 0.6).toFixed(2)}" fill="none" stroke-width="0.15"/>${big ? `<text x="${pl.x}" y="${(pl.y + 0.5).toFixed(2)}" font-size="1.4" text-anchor="middle" stroke="none">${c.ref}</text>` : ""}`;
    })
    .join("");
  out["F.Silkscreen"] = wrap(`<g stroke="${LAYER_COLORS["F.Silkscreen"]}" fill="${LAYER_COLORS["F.Silkscreen"]}" font-family="sans-serif">${labels}<text x="${-W / 2 + 3}" y="${H / 2 - 3}" font-size="2.2" stroke="none">${escapeXml(d.name)} ${escapeXml(d.revision.toUpperCase())}</text></g>`);
  out["B.Silkscreen"] = wrap("");
  out["Edge.Cuts"] = wrap(`<g fill="none" stroke="${LAYER_COLORS["Edge.Cuts"]}" stroke-width="0.25">${outline}${holes}</g>`);
  return out;
}

function escapeXml(s: string) {
  return s.replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" })[c]!);
}

/* ---------- demo 3D: boxes merged by colour ---------- */

const KIND_COLOR: Record<string, [number, number, number]> = {
  MOD: [0.75, 0.76, 0.78],
  U: [0.09, 0.09, 0.1],
  J: [0.72, 0.72, 0.74],
  L: [0.2, 0.2, 0.21],
  D: [0.12, 0.12, 0.13],
  LED: [0.92, 0.92, 0.9],
  R: [0.1, 0.1, 0.1],
  C: [0.62, 0.5, 0.35],
};
const MASK: Record<string, [number, number, number]> = {
  black: [0.06, 0.06, 0.06],
  green: [0.05, 0.3, 0.12],
  white: [0.9, 0.9, 0.88],
  blue: [0.05, 0.15, 0.4],
  red: [0.5, 0.06, 0.05],
  purple: [0.3, 0.1, 0.4],
  yellow: [0.8, 0.7, 0.1],
};

class Builder {
  pos: number[] = [];
  nrm: number[] = [];
  idx: number[] = [];
  /** axis-aligned box; z is up */
  box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number) {
    const faces: [number[], number[][]][] = [
      [[0, 0, 1], [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]]],
      [[0, 0, -1], [[x0, y1, z0], [x1, y1, z0], [x1, y0, z0], [x0, y0, z0]]],
      [[1, 0, 0], [[x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]]],
      [[-1, 0, 0], [[x0, y1, z0], [x0, y0, z0], [x0, y0, z1], [x0, y1, z1]]],
      [[0, 1, 0], [[x1, y1, z0], [x0, y1, z0], [x0, y1, z1], [x1, y1, z1]]],
      [[0, -1, 0], [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]]],
    ];
    for (const [n, vs] of faces) {
      const base = this.pos.length / 3;
      for (const v of vs) {
        this.pos.push(...v);
        this.nrm.push(...n);
      }
      this.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
  }
  data(key: string, group: MeshData["group"], color: [number, number, number]): MeshData {
    return { key, group, color, positions: new Float32Array(this.pos), normals: new Float32Array(this.nrm), index: new Uint32Array(this.idx) };
  }
}

export function demoScene(d: Design): SceneData {
  const b = d.board ?? { width: 60, height: 40, thickness: 1.6, mask_color: "black" as const };
  const T = b.thickness ?? 1.6;
  const board = new Builder();
  // y is flipped: board coordinates are y-down, the 3D scene is y-up on screen
  board.box(-b.width / 2, -b.height / 2, 0, b.width / 2, b.height / 2, T);
  const meshes: MeshData[] = [board.data("board", "board", MASK[b.mask_color] ?? MASK.black!)];
  const groups = new Map<string, { b: Builder; group: MeshData["group"]; color: [number, number, number] }>();
  for (const c of d.components) {
    const pl = d.placement[c.ref];
    const part = d.parts[c.part];
    if (!pl || !part) continue;
    const [sw, sh, sz] = footprintSize(part.footprint, part.kind);
    const [w, h] = rotated(sw, sh, pl.rot);
    const top = pl.side !== "bottom";
    const color = KIND_COLOR[part.kind] ?? [0.3, 0.3, 0.3];
    const key = `${top ? "t" : "b"}:${color.join(",")}`;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { b: new Builder(), group: top ? "top" : "bottom", color }));
    const y = -pl.y;
    if (top) g.b.box(pl.x - w / 2, y - h / 2, T, pl.x + w / 2, y + h / 2, T + sz);
    else g.b.box(pl.x - w / 2, y - h / 2, -sz, pl.x + w / 2, y + h / 2, 0);
  }
  for (const [key, g] of groups) meshes.push(g.b.data(key, g.group, g.color));
  return { meshes, up: 2, thickness: T, size: [b.width, b.height, T], center: [0, 0, T / 2] };
}
