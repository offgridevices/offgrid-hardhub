// The heat map's colours and numbers. One sequential scale (analogous warm
// hues, lightness changing steadily from cool to hot) built in OKLCH so equal
// steps of temperature look like equal steps of colour. Each mode gets its
// own direction: on a light page cool is pale and hot is dark; on a dark page
// cool recedes into the dark and hot is bright. Pure, so it is easy to test.
import type { TestReport } from "@hardhub/protocol";

export type Mode = "light" | "dark";
type RGB = [number, number, number];

/* ---------- OKLab / OKLCH <-> sRGB (Björn Ottosson's matrices) ---------- */

const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toGamma = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

export function oklchToRgb(L: number, C: number, hDeg: number): RGB {
  const h = (hDeg * Math.PI) / 180;
  const a = C * Math.cos(h);
  const b = C * Math.sin(h);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const lin = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
  return lin.map((c) => Math.round(Math.min(1, Math.max(0, toGamma(Math.min(1, Math.max(0, c))))) * 255)) as RGB;
}

/** OKLab lightness of an sRGB colour (0-1), to check a scale stays monotone */
export function lightness([r, g, b]: RGB): number {
  const [R, G, B] = [r, g, b].map((c) => toLinear(c / 255)) as RGB;
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
  return 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
}

/* ---------- the scale ---------- */

// cool -> hot: lightness, chroma and hue at each end. Hue moves only between
// warm neighbours (yellow to red-orange), never round the wheel.
const ENDS: Record<Mode, { L: [number, number]; C: [number, number]; h: [number, number] }> = {
  light: { L: [0.95, 0.43], C: [0.06, 0.15], h: [95, 32] },
  dark: { L: [0.3, 0.92], C: [0.07, 0.13], h: [28, 92] },
};

/** the colour for t in 0 (coolest) .. 1 (hottest) */
export function heatColor(t: number, mode: Mode): RGB {
  const k = Math.min(1, Math.max(0, t));
  const e = ENDS[mode];
  const lerp = ([a, b]: [number, number]) => a + (b - a) * k;
  // chroma peaks in the middle of the scale, where it carries the most
  const C = lerp(e.C) + 0.05 * Math.sin(Math.PI * k);
  return oklchToRgb(lerp(e.L), C, lerp(e.h));
}

/** 256 colours, RGBA, for painting a map one cell at a time */
export function heatLut(mode: Mode): Uint8ClampedArray {
  const out = new Uint8ClampedArray(256 * 4);
  for (let i = 0; i < 256; i++) {
    const [r, g, b] = heatColor(i / 255, mode);
    out.set([r, g, b, 255], i * 4);
  }
  return out;
}

/** a CSS gradient of the same scale, for the legend */
export function heatGradient(mode: Mode, stops = 9): string {
  const cs = Array.from({ length: stops }, (_, i) => {
    const [r, g, b] = heatColor(i / (stops - 1), mode);
    return `rgb(${r} ${g} ${b}) ${((i / (stops - 1)) * 100).toFixed(0)}%`;
  });
  return `linear-gradient(to right, ${cs.join(", ")})`;
}

/* ---------- the report's maps ---------- */

export function decodeU8(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export function encodeU8(u: Uint8Array): string {
  let s = "";
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(s);
}

type Thermal = NonNullable<TestReport["thermal"]>;
export interface HeatField {
  grid: Thermal["grid"];
  inside: Uint8Array;
  /** per map: the temperature of each cell, °C (NaN off the board) */
  temps: Float32Array[];
  /** each map's coolest and hottest cell: each map is drawn on its own scale, so its hot spots show */
  ranges: { lo: number; hi: number }[];
  /** the coolest and hottest cell over every map */
  lo: number;
  hi: number;
}

export function heatField(t: Thermal): HeatField {
  const n = t.grid.nx * t.grid.ny;
  const inside = decodeU8(t.mask);
  const ranges: { lo: number; hi: number }[] = [];
  const temps = t.maps.map((m) => {
    const u = decodeU8(m.u8);
    const out = new Float32Array(n);
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < n; i++) {
      if (!inside[i]) {
        out[i] = NaN;
        continue;
      }
      const v = m.min + ((u[i] ?? 0) / 255) * (m.max - m.min);
      out[i] = v;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    ranges.push(Number.isFinite(lo) ? { lo, hi } : { lo: m.min, hi: m.max });
    return out;
  });
  const lo = Math.min(...ranges.map((r) => r.lo));
  const hi = Math.max(...ranges.map((r) => r.hi));
  return { grid: t.grid, inside, temps, ranges, lo: Number.isFinite(lo) ? lo : 0, hi: Number.isFinite(hi) ? hi : 1 };
}

/** the cell under a point (design frame, mm), or -1 off the grid */
export function cellAt(g: Thermal["grid"], x: number, y: number): number {
  const i = Math.floor((x - g.x0) / g.dx);
  const j = Math.floor((y - g.y0) / g.dy);
  if (i < 0 || j < 0 || i >= g.nx || j >= g.ny) return -1;
  return j * g.nx + i;
}

/** paint one map into RGBA pixels, one per cell, on its own scale; off the board is transparent */
export function paint(f: HeatField, map: number, lut: Uint8ClampedArray): Uint8ClampedArray {
  const t = f.temps[map]!;
  const out = new Uint8ClampedArray(t.length * 4);
  const { lo, hi } = f.ranges[map]!;
  const span = hi - lo || 1;
  for (let i = 0; i < t.length; i++) {
    const v = t[i]!;
    if (Number.isNaN(v)) continue;
    const k = Math.min(255, Math.max(0, Math.round(((v - lo) / span) * 255))) * 4;
    out[i * 4] = lut[k]!;
    out[i * 4 + 1] = lut[k + 1]!;
    out[i * 4 + 2] = lut[k + 2]!;
    out[i * 4 + 3] = 255;
  }
  return out;
}
