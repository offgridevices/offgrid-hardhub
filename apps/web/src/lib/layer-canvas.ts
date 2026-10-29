// One board layer drawn flat onto a canvas, for the 3D view's layer plates:
// copper from the board's geometry in the app's layer colours, or any of
// KiCad's own layer plots (silkscreen) as they are. Board mm, y down, top-left
// at the canvas's top-left.
import type { BoardGeometry } from "@hardhub/protocol";

const MAX_PX = 2048;

export function cssColor(name: string, fallback: string) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

const LAYER_VAR: Record<string, [string, string]> = {
  "F.Cu": ["--layer-top", "#ff8a3d"],
  "B.Cu": ["--layer-bottom", "#6fa8e8"],
  "In1.Cu": ["--layer-in1", "#f0b84a"],
  "In2.Cu": ["--layer-in2", "#c39bd3"],
  "In3.Cu": ["--layer-in3", "#8cc084"],
  "In4.Cu": ["--layer-in4", "#4fd1c5"],
};
export const layerColor = (l: string) => cssColor(...(LAYER_VAR[l] ?? ["--layer-in3", "#8cc084"]));

function canvasFor(w: number, h: number) {
  const k = MAX_PX / Math.max(w, h);
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(w * k));
  c.height = Math.max(1, Math.round(h * k));
  const ctx = c.getContext("2d")!;
  ctx.scale(k, k);
  return { c, ctx };
}

export function copperCanvas(g: BoardGeometry, layer: string): HTMLCanvasElement {
  const { c, ctx } = canvasFor(g.size[0], g.size[1]);
  const color = layerColor(layer);
  ctx.fillStyle = color;
  ctx.strokeStyle = color;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.globalAlpha = 0.35;
  for (const z of g.zones) {
    if (z.layer !== layer) continue;
    ctx.beginPath();
    for (const ring of z.polygons) ring.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.fill("evenodd");
  }
  ctx.globalAlpha = 1;
  for (const t of g.tracks) {
    if (t.layer !== layer) continue;
    ctx.lineWidth = t.width;
    ctx.beginPath();
    ctx.moveTo(t.a[0], t.a[1]);
    if (t.mid) ctx.quadraticCurveTo(2 * t.mid[0] - (t.a[0] + t.b[0]) / 2, 2 * t.mid[1] - (t.a[1] + t.b[1]) / 2, t.b[0], t.b[1]);
    else ctx.lineTo(t.b[0], t.b[1]);
    ctx.stroke();
  }
  const side = layer === "F.Cu" ? "top" : layer === "B.Cu" ? "bottom" : null;
  for (const f of g.footprints)
    for (const p of f.pads) {
      if (!p.through && f.side !== side) continue;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate((-p.rot * Math.PI) / 180);
      ctx.fillStyle = p.through ? "#d9a35a" : color;
      ctx.beginPath();
      if (p.shape === "circle" || p.shape === "oval") ctx.ellipse(0, 0, p.w / 2, p.h / 2, 0, 0, Math.PI * 2);
      else ctx.rect(-p.w / 2, -p.h / 2, p.w, p.h);
      ctx.fill();
      ctx.restore();
    }
  for (const v of g.vias) {
    const at = g.layers.indexOf(layer);
    if (at < g.layers.indexOf(v.from) || at > g.layers.indexOf(v.to)) continue;
    ctx.fillStyle = "#d9a35a";
    ctx.beginPath();
    ctx.arc(v.x, v.y, v.d / 2, 0, Math.PI * 2);
    ctx.fill();
  }
  // drill holes go through every layer
  ctx.globalCompositeOperation = "destination-out";
  for (const v of g.vias) {
    ctx.beginPath();
    ctx.arc(v.x, v.y, v.drill / 2, 0, Math.PI * 2);
    ctx.fill();
  }
  for (const f of g.footprints)
    for (const p of f.pads)
      if (p.through) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, Math.min(p.w, p.h) * 0.25, 0, Math.PI * 2);
        ctx.fill();
      }
  ctx.globalCompositeOperation = "source-over";
  return c;
}

/** A KiCad layer plot (SVG, cropped to the board) as a canvas of the board's size. */
export async function plotCanvas(url: string, w: number, h: number): Promise<HTMLCanvasElement> {
  const img = new Image();
  img.decoding = "async";
  img.src = url;
  await img.decode();
  const { c, ctx } = canvasFor(w, h);
  ctx.drawImage(img, 0, 0, w, h);
  return c;
}
