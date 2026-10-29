// Hand edits to the routed board, before they are saved: applied to the
// board's geometry for the preview, worked out the way KiCad drags things
// (the tracks meeting a moved end or via follow it; a moved part's tracks
// stretch to its new pads), and folded into the fewest edits to send.
// Pure: no React, no DOM.
import type { BoardEdit, BoardFootprint, BoardGeometry, BoardTrack, BoardVia, Pt } from "@hardhub/protocol";

export const NEW = "new:"; // ids of tracks and vias drawn here, not yet saved
const EPS = 0.005; // mm: two ends this close are joined

const same = (a: Pt, b: Pt) => Math.abs(a[0] - b[0]) < EPS && Math.abs(a[1] - b[1]) < EPS;
const round = (v: number) => Math.round(v * 1e4) / 1e4;
export const pt = (x: number, y: number): Pt => [round(x), round(y)];

function rotate([x, y]: Pt, [cx, cy]: Pt, deg: number): Pt {
  // KiCad angles turn counter-clockwise as seen; y points down here
  const r = (-deg * Math.PI) / 180;
  const dx = x - cx;
  const dy = y - cy;
  return pt(cx + dx * Math.cos(r) - dy * Math.sin(r), cy + dx * Math.sin(r) + dy * Math.cos(r));
}

function placePart(f: BoardFootprint, x: number, y: number, rot: number): BoardFootprint {
  // a bottom part is seen from the top through the board: KiCad mirrors it,
  // so turning it counter-clockwise turns it clockwise as seen here
  const turn = (rot - f.rot) * (f.side === "bottom" ? -1 : 1);
  const move = (p: Pt): Pt => {
    const r = rotate(p, [f.x, f.y], turn);
    return pt(r[0] + x - f.x, r[1] + y - f.y);
  };
  const corners = [move([f.bbox[0], f.bbox[1]]), move([f.bbox[2], f.bbox[1]]), move([f.bbox[2], f.bbox[3]]), move([f.bbox[0], f.bbox[3]])];
  return {
    ...f,
    x,
    y,
    rot,
    bbox: [Math.min(...corners.map((c) => c[0])), Math.min(...corners.map((c) => c[1])), Math.max(...corners.map((c) => c[0])), Math.max(...corners.map((c) => c[1]))],
    pads: f.pads.map((p) => {
      const [px, py] = move([p.x, p.y]);
      return { ...p, x: px, y: py, rot: p.rot + turn };
    }),
  };
}

/** The board as it looks with these edits made, in order. */
export function applyEdits(g: BoardGeometry, edits: BoardEdit[]): BoardGeometry {
  if (!edits.length) return g;
  let tracks = g.tracks;
  let vias = g.vias;
  let footprints = g.footprints;
  let n = 0;
  for (const e of edits) {
    switch (e.op) {
      case "set_track":
        tracks = tracks.map((t) => {
          if (t.id !== e.id) return t;
          // an arc keeps its shape: its middle moves as its ends do on average (as the engine does)
          const mid: Pt | undefined = t.mid && pt(t.mid[0] + (e.a[0] - t.a[0] + e.b[0] - t.b[0]) / 2, t.mid[1] + (e.a[1] - t.a[1] + e.b[1] - t.b[1]) / 2);
          return { ...t, a: e.a, b: e.b, mid, width: e.width ?? t.width, layer: e.layer ?? t.layer };
        });
        break;
      case "add_track": {
        const id = `${NEW}${n++}`;
        tracks = [...tracks, { id, layer: e.layer, net: e.net ?? netAt(g, e.layer, e.a) ?? netAt(g, e.layer, e.b) ?? "", width: e.width ?? g.rules.track_min, a: e.a, b: e.b }];
        break;
      }
      case "set_via":
        vias = vias.map((v) => (v.id === e.id ? { ...v, x: e.x, y: e.y } : v));
        break;
      case "add_via": {
        const id = `${NEW}${n++}`;
        vias = [...vias, { id, x: e.x, y: e.y, d: e.d ?? g.rules.via_d, drill: e.drill ?? g.rules.via_drill, net: e.net ?? netAt(g, null, [e.x, e.y]) ?? "", from: g.layers[0]!, to: g.layers.at(-1)! }];
        break;
      }
      case "delete":
        tracks = tracks.filter((t) => t.id !== e.id);
        vias = vias.filter((v) => v.id !== e.id);
        break;
      case "move_part":
        footprints = footprints.map((f) => (f.ref === e.ref ? placePart(f, e.x, e.y, e.rot) : f));
        break;
    }
  }
  return { ...g, tracks, vias, footprints };
}

/** The net of whatever copper sits at a point: a pad, a via, a track end. layer null: any layer. */
export function netAt(g: BoardGeometry, layer: string | null, p: Pt): string | null {
  for (const v of g.vias) if (Math.hypot(v.x - p[0], v.y - p[1]) <= v.d / 2) return v.net || null;
  for (const t of g.tracks) if ((!layer || t.layer === layer) && (same(t.a, p) || same(t.b, p) || distToSeg(p, t.a, t.b) <= t.width / 2)) return t.net || null;
  for (const f of g.footprints)
    for (const pad of f.pads) {
      if (!pad.net) continue;
      const onLayer = !layer || pad.through || (f.side === "top" ? layer === "F.Cu" : layer === "B.Cu");
      if (onLayer && Math.abs(pad.x - p[0]) <= Math.max(pad.w, pad.h) / 2 && Math.abs(pad.y - p[1]) <= Math.max(pad.w, pad.h) / 2) return pad.net;
    }
  return null;
}

export function distToSeg(p: Pt, a: Pt, b: Pt): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2)) : 0;
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

export const trackLength = (t: BoardTrack) => Math.hypot(t.b[0] - t.a[0], t.b[1] - t.a[1]);

/** Every track end at a point: on one layer, or on any layer when a via joins them there. */
function endsAt(g: BoardGeometry, p: Pt, layer: string | null): { id: string; end: "a" | "b" }[] {
  const out: { id: string; end: "a" | "b" }[] = [];
  for (const t of g.tracks) {
    if (layer && t.layer !== layer) continue;
    if (same(t.a, p)) out.push({ id: t.id, end: "a" });
    if (same(t.b, p)) out.push({ id: t.id, end: "b" });
  }
  return out;
}

function follow(g: BoardGeometry, from: Pt, to: Pt, layer: string | null, skip?: string): BoardEdit[] {
  const out: BoardEdit[] = [];
  for (const { id, end } of endsAt(g, from, layer)) {
    if (id === skip) continue;
    const t = g.tracks.find((x) => x.id === id)!;
    out.push({ op: "set_track", id, a: end === "a" ? to : t.a, b: end === "b" ? to : t.b });
  }
  return out;
}

/** Drag one end of a track: tracks meeting it there follow, and so does a via sitting on it. */
export function dragEnd(g: BoardGeometry, track: BoardTrack, end: "a" | "b", to: Pt): BoardEdit[] {
  const from = track[end];
  const via = g.vias.find((v) => same([v.x, v.y], from));
  const edits: BoardEdit[] = [{ op: "set_track", id: track.id, a: end === "a" ? to : track.a, b: end === "b" ? to : track.b }];
  edits.push(...follow(g, from, to, via ? null : track.layer, track.id));
  if (via) edits.push({ op: "set_via", id: via.id, x: to[0], y: to[1] });
  return edits;
}

/** Move a whole track: both its ends, and whatever meets them. */
export function dragTrack(g: BoardGeometry, track: BoardTrack, dx: number, dy: number): BoardEdit[] {
  const a = pt(track.a[0] + dx, track.a[1] + dy);
  const b = pt(track.b[0] + dx, track.b[1] + dy);
  const out: BoardEdit[] = [{ op: "set_track", id: track.id, a, b }];
  for (const [from, to] of [
    [track.a, a],
    [track.b, b],
  ] as const) {
    const via = g.vias.find((v) => same([v.x, v.y], from));
    out.push(...follow(g, from, to, via ? null : track.layer, track.id));
    if (via) out.push({ op: "set_via", id: via.id, x: to[0], y: to[1] });
  }
  return out;
}

/** Drag a via: the tracks on every layer that end on it follow. */
export function dragVia(g: BoardGeometry, via: BoardVia, to: Pt): BoardEdit[] {
  return [{ op: "set_via", id: via.id, x: to[0], y: to[1] }, ...follow(g, [via.x, via.y], to, null)];
}

/** Move or turn a part: the tracks ending on its pads stretch to where the pads go. */
export function placeEdits(g: BoardGeometry, f: BoardFootprint, x: number, y: number, rot: number): BoardEdit[] {
  const moved = placePart(f, x, y, rot);
  const out: BoardEdit[] = [{ op: "move_part", ref: f.ref, x: round(x), y: round(y), rot: ((rot % 360) + 360) % 360 }];
  f.pads.forEach((pad, i) => {
    const to = moved.pads[i]!;
    const layer = pad.through ? null : f.side === "top" ? "F.Cu" : "B.Cu";
    out.push(...follow(g, [pad.x, pad.y], [to.x, to.y], layer));
  });
  return out;
}

/**
 * The fewest edits that make the same board: the last set of an item wins,
 * an item drawn here and changed later is sent as drawn, one drawn and
 * deleted is not sent at all.
 */
export function compact(edits: BoardEdit[]): BoardEdit[] {
  const out: (BoardEdit | null)[] = [];
  const last = new Map<string, number>();
  let n = 0;
  const newIdx = new Map<string, number>(); // temp id -> index of its add in out
  for (const e of edits) {
    if (e.op === "add_track" || e.op === "add_via") {
      newIdx.set(`${NEW}${n++}`, out.length);
      out.push(e);
      continue;
    }
    const key = e.op === "move_part" ? `part:${e.ref}` : e.id;
    if (e.op !== "move_part" && e.id.startsWith(NEW)) {
      const i = newIdx.get(e.id);
      if (i === undefined) continue;
      const add = out[i];
      if (!add) continue;
      if (e.op === "delete") out[i] = null;
      else if (e.op === "set_track" && add.op === "add_track") out[i] = { ...add, a: e.a, b: e.b, width: e.width ?? add.width, layer: e.layer ?? add.layer };
      else if (e.op === "set_via" && add.op === "add_via") out[i] = { ...add, x: e.x, y: e.y };
      continue;
    }
    const prev = last.get(key);
    let next = e;
    if (prev !== undefined) {
      const p = out[prev];
      out[prev] = null;
      // a later move keeps an earlier width or layer change it does not repeat
      if (p?.op === "set_track" && e.op === "set_track") next = { ...e, width: e.width ?? p.width, layer: e.layer ?? p.layer };
    }
    last.set(key, out.length);
    out.push(next);
  }
  return out.filter((e): e is BoardEdit => !!e);
}

/** What the edits did, in plain words, for the chat. */
export function describe(edits: BoardEdit[]): string {
  const ids = (op: BoardEdit["op"]) => new Set(edits.filter((e) => e.op === op).map((e) => ("id" in e ? e.id : "ref" in e ? e.ref : "")));
  const parts: string[] = [];
  const say = (n: number, one: string, many: string, verb: string) => n && parts.push(`${verb} ${n === 1 ? one : `${n} ${many}`}`);
  say(ids("move_part").size, "a part", "parts", "moved");
  say(ids("set_track").size, "a track", "tracks", "changed");
  say(ids("set_via").size, "a via", "vias", "moved");
  say(edits.filter((e) => e.op === "add_track").length, "a track", "tracks", "drew");
  say(edits.filter((e) => e.op === "add_via").length, "a via", "vias", "added");
  say(ids("delete").size, "an item", "items", "deleted");
  return parts.length ? parts.join(", ") : "no changes";
}
