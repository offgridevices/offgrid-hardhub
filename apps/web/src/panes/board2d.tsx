// The routed board, editable by hand like KiCad: drag a track's end or the
// whole track, move a via, move or turn a part, draw a track, add a via,
// delete. Copper is drawn as vectors from the board's geometry (the engine's
// board.json); silkscreen and outline are KiCad's own plots, layered over it.
// Edits wait as a draft until "Save and check": then KiCad applies them,
// refills the copper pours and runs every check again.
//
// Pan and zoom move one transformed element directly, never through React
// state. While something is dragged, only what moves is redrawn.
import { memo, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent as RPointerEvent } from "react";
import type { Artifact, BoardEdit, BoardEditRequest, BoardEditResult, BoardFootprint, BoardGeometry, BoardTrack, BoardVia, CheckResult, Design, Pt } from "@hardhub/protocol";
import { CircleCheckIcon, CircleXIcon, LayersIcon, LoaderCircleIcon, MousePointer2Icon, Redo2Icon, RotateCwIcon, SplineIcon, Trash2Icon, Undo2Icon, XIcon } from "lucide-react";
import { demoLayerSvgs } from "../workers/client";
import { usePanZoom } from "../lib/pan-zoom";
import { useGeometry } from "../lib/use-geometry";
import { applyEdits, compact, describe, dragEnd, dragTrack, dragVia, netAt, placeEdits, pt, trackLength } from "../lib/board-edit";
import { Empty } from "../components/pane";
import { BarRule, ViewBar, ZoomControls } from "../components/viewer-ui";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

const BASE = 10; // px per mm at scale 1
const COPPER_COLOR: Record<string, string> = {
  "F.Cu": "var(--layer-top)",
  "B.Cu": "var(--layer-bottom)",
  "In1.Cu": "var(--layer-in1)",
  "In2.Cu": "var(--layer-in2)",
  "In3.Cu": "var(--layer-in3)",
  "In4.Cu": "var(--layer-in4)",
};
const copperColor = (l: string) => COPPER_COLOR[l] ?? "var(--layer-in3)";
const NAMES: Record<string, string> = {
  "F.Cu": "Top copper",
  "B.Cu": "Bottom copper",
  "F.Silkscreen": "Top print",
  "B.Silkscreen": "Bottom print",
  "Edge.Cuts": "Outline",
  "F.Fab": "Top part outlines",
  "B.Fab": "Bottom part outlines",
};
export const layerName = (l: string) => NAMES[l] ?? l.replace(/^In(\d+)\.Cu$/, "Inner $1");
// plots drawn under the copper, and over it
const UNDER = ["B.Fab", "B.Silkscreen"];
const OVER = ["F.Silkscreen", "F.Fab", "Edge.Cuts"];
const ORDER = ["B.Fab", "B.Silkscreen", "B.Cu", "In4.Cu", "In3.Cu", "In2.Cu", "In1.Cu", "F.Cu", "F.Silkscreen", "F.Fab", "Edge.Cuts"];
const rank = (l: string) => (ORDER.indexOf(l) < 0 ? 4 : ORDER.indexOf(l));

type Tool = "select" | "track" | "via";
type Sel = { kind: "track" | "via"; id: string } | { kind: "part"; ref: string } | null;
type Drag =
  | { kind: "end"; track: BoardTrack; end: "a" | "b" }
  | { kind: "track"; track: BoardTrack; from: Pt }
  | { kind: "via"; via: BoardVia }
  | { kind: "part"; f: BoardFootprint; from: Pt };

/** KiCad's layer plots as images: the demo draws its own. */
function useLayerImages(design: Design, artifacts: Artifact[], fileUrl: (u: string) => string) {
  const svgs = useMemo(() => artifacts.filter((a) => a.kind === "board-svg"), [artifacts]);
  const isMock = svgs.some((a) => a.url.startsWith("mock:"));
  const [demo, setDemo] = useState<Record<string, string> | null>(null);
  useEffect(() => {
    if (!isMock) return;
    let urls: string[] = [];
    let live = true;
    demoLayerSvgs(design).then((layers) => {
      if (!live) return;
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(layers)) {
        const u = URL.createObjectURL(new Blob([v], { type: "image/svg+xml" }));
        urls.push(u);
        out[k] = u;
      }
      setDemo(out);
    });
    return () => {
      live = false;
      urls.forEach((u) => URL.revokeObjectURL(u));
      urls = [];
    };
  }, [isMock, design]);
  return useMemo(
    () =>
      svgs
        .map((a) => {
          const layer = a.layers?.[0] ?? a.name;
          return { layer, src: isMock ? demo?.[layer] : fileUrl(a.url) };
        })
        .filter((x): x is { layer: string; src: string } => !!x.src)
        .sort((a, b) => rank(a.layer) - rank(b.layer)),
    [svgs, isMock, demo, fileUrl],
  );
}

/* ---------- copper, drawn once per change, not per frame ---------- */

const Copper = memo(function Copper({
  geo,
  shown,
  active,
  hide,
  tool,
  onTrack,
  onVia,
  onPart,
}: {
  geo: BoardGeometry;
  shown: Set<string>;
  active: string;
  hide: Set<string>;
  tool: Tool;
  onTrack(t: BoardTrack, e: RPointerEvent): void;
  onVia(v: BoardVia, e: RPointerEvent): void;
  onPart(f: BoardFootprint, e: RPointerEvent): void;
}) {
  // the active layer on top; the others under it, a little dimmer
  const layers = [...geo.layers].reverse().filter((l) => shown.has(l));
  layers.sort((a, b) => Number(a === active) - Number(b === active));
  const pick = tool === "select";
  return (
    <g>
      {pick &&
        geo.footprints.map((f) => (
          <rect
            key={f.ref}
            data-hit
            x={f.bbox[0]}
            y={f.bbox[1]}
            width={f.bbox[2] - f.bbox[0]}
            height={f.bbox[3] - f.bbox[1]}
            fill="transparent"
            className="cursor-move"
            onPointerDown={(e) => onPart(f, e)}
          />
        ))}
      {layers.map((l) => {
        const dim = l !== active;
        const color = copperColor(l);
        return (
          <g key={l} opacity={dim ? 0.55 : 1}>
            {geo.zones
              .filter((z) => z.layer === l)
              .map((z, i) => (
                <path key={i} d={z.polygons.map((ring) => "M" + ring.map((p) => `${p[0]} ${p[1]}`).join("L") + "Z").join("")} fill={color} fillRule="evenodd" opacity={0.22} pointerEvents="none" />
              ))}
            {geo.tracks
              .filter((t) => t.layer === l && !hide.has(t.id))
              .map((t) => (
                <g key={t.id}>
                  <path d={t.mid ? arcPath(t) : `M${t.a[0]} ${t.a[1]}L${t.b[0]} ${t.b[1]}`} stroke={color} strokeWidth={t.width} strokeLinecap="round" fill="none" pointerEvents="none" />
                  {pick && (
                    <path
                      data-hit
                      d={`M${t.a[0]} ${t.a[1]}L${t.b[0]} ${t.b[1]}`}
                      stroke="transparent"
                      strokeWidth={10}
                      vectorEffect="non-scaling-stroke"
                      fill="none"
                      className="cursor-pointer"
                      onPointerDown={(e) => onTrack(t, e)}
                    />
                  )}
                </g>
              ))}
          </g>
        );
      })}
      {geo.footprints.map((f) =>
        f.pads.map((p) => {
          const side = f.side === "top" ? "F.Cu" : "B.Cu";
          if (!p.through && !shown.has(side)) return null;
          const w = p.w;
          const h = p.h;
          const r = p.shape === "circle" || p.shape === "oval" ? Math.min(w, h) / 2 : p.shape === "roundrect" ? Math.min(w, h) * 0.25 : 0;
          return (
            <rect
              key={`${f.ref}.${p.num}`}
              x={-w / 2}
              y={-h / 2}
              width={w}
              height={h}
              rx={r}
              transform={`translate(${p.x} ${p.y}) rotate(${-p.rot})`}
              fill={p.through ? "#d9a35a" : copperColor(side)}
              opacity={p.through || side === active ? 0.95 : 0.6}
              pointerEvents="none"
            />
          );
        }),
      )}
      {geo.vias
        .filter((v) => !hide.has(v.id))
        .map((v) => (
          <g key={v.id}>
            <circle cx={v.x} cy={v.y} r={v.d / 2} fill="#d9a35a" pointerEvents="none" />
            <circle cx={v.x} cy={v.y} r={v.drill / 2} fill="var(--board-bg)" pointerEvents="none" />
            {pick && <circle data-hit cx={v.x} cy={v.y} r={Math.max(v.d / 2, 0.4)} fill="transparent" className="cursor-move" onPointerDown={(e) => onVia(v, e)} />}
          </g>
        ))}
      {geo.footprints
        .flatMap((f) => f.pads.filter((p) => p.through))
        .map((p, i) => (
          <circle key={i} cx={p.x} cy={p.y} r={Math.min(p.w, p.h) * 0.22} fill="var(--board-bg)" pointerEvents="none" />
        ))}
    </g>
  );
});

function arcPath(t: BoardTrack) {
  // a circle through three points: start, middle, end
  const [ax, ay] = t.a;
  const [mx, my] = t.mid!;
  const [bx, by] = t.b;
  const d = 2 * (ax * (my - by) + mx * (by - ay) + bx * (ay - my));
  if (Math.abs(d) < 1e-9) return `M${ax} ${ay}L${bx} ${by}`;
  const ux = ((ax * ax + ay * ay) * (my - by) + (mx * mx + my * my) * (by - ay) + (bx * bx + by * by) * (ay - my)) / d;
  const uy = ((ax * ax + ay * ay) * (bx - mx) + (mx * mx + my * my) * (ax - bx) + (bx * bx + by * by) * (mx - ax)) / d;
  const r = Math.hypot(ax - ux, ay - uy);
  const cross = (mx - ax) * (by - ay) - (my - ay) * (bx - ax);
  const large = Math.hypot(bx - ax, by - ay) < 2 * r && cross * ((bx - ax) * (uy - ay) - (by - ay) * (ux - ax)) > 0 ? 1 : 0;
  return `M${ax} ${ay}A${r} ${r} 0 ${large} ${cross > 0 ? 1 : 0} ${bx} ${by}`;
}

/* ---------- the view ---------- */

export default function Board2D({
  design,
  artifacts,
  checks,
  fileUrl,
  save,
}: {
  design: Design;
  artifacts: Artifact[];
  checks: CheckResult[];
  fileUrl(url: string): string;
  save?: (req: BoardEditRequest) => Promise<BoardEditResult>;
}) {
  const images = useLayerImages(design, artifacts, fileUrl);
  const jsonArt = useMemo(() => artifacts.find((a) => a.kind === "board-json"), [artifacts]);
  const { geo: base, from, failed } = useGeometry(jsonArt, fileUrl);

  const [tool, setTool] = useState<Tool>("select");
  const [actions, setActions] = useState<BoardEdit[][]>([]);
  const [redo, setRedo] = useState<BoardEdit[][]>([]);
  const [sel, setSel] = useState<Sel>(null);
  const [hiddenLayers, setHiddenLayers] = useState<Set<string>>(() => new Set(["B.Silkscreen", "F.Fab", "B.Fab"]));
  const [active, setActive] = useState("F.Cu");
  const [width, setWidth] = useState<number | null>(null);
  const [drag, setDrag] = useState<{ ids: Set<string>; edits: BoardEdit[] } | null>(null);
  const [route, setRoute] = useState<{ pts: Pt[]; cursor: Pt | null } | null>(null);
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [scale, setScale] = useState(1);
  // the board file a saved draft was made on: the draft goes once a newer one has loaded
  const savedFrom = useRef<string | null>(null);
  const fromNow = useRef(from);
  fromNow.current = from;

  const edits = useMemo(() => actions.flat(), [actions]);
  const actionsRef = useRef(actions);
  actionsRef.current = actions;
  const geo = useMemo(() => (base ? applyEdits(base, edits) : null), [base, edits]);
  // a saved draft is cleared only when the board it made has arrived, so the
  // view never flashes back to the board before the edit
  const lastFrom = useRef(from);
  useEffect(() => {
    const before = lastFrom.current;
    lastFrom.current = from;
    if (!from || from === before) return;
    if (savedFrom.current) {
      savedFrom.current = null;
      setActions([]);
      setRedo([]);
    } else if (before && actionsRef.current.length) {
      // a rebuild replaced the board: the draft's tracks and vias are gone
      setActions([]);
      setRedo([]);
      setNote({ ok: false, text: "The board was rebuilt, so your unsaved edits were dropped." });
    }
  }, [from]);

  const W = geo?.size[0] ?? design.board?.width ?? 100;
  const H = geo?.size[1] ?? design.board?.height ?? 60;
  const box = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const raf = useRef(0);
  const hasBoard = artifacts.some((a) => a.kind === "board-svg" || a.kind === "board-json");
  const pz = usePanZoom({
    box,
    stage,
    enabled: hasBoard,
    width: W * BASE,
    height: H * BASE,
    pad: 32,
    max: 80,
    canPan: (e) => !(e.target as Element).closest("[data-hit]") && !(tool !== "select" && e.button === 0),
    onView: (v) => {
      cancelAnimationFrame(raf.current);
      raf.current = requestAnimationFrame(() => setScale(v.s));
    },
  });
  /** px on screen, in mm at the current zoom */
  const px = (n: number) => n / (BASE * scale);

  const copperLayers = geo?.layers ?? images.filter((i) => i.layer.endsWith(".Cu")).map((i) => i.layer);
  const shown = useMemo(() => new Set(copperLayers.filter((l) => !hiddenLayers.has(l))), [copperLayers, hiddenLayers]);
  // DRC lives with the fab checks; layout has the rest of the board's
  const drcFails = checks.filter((c) => (c.group === "layout" || c.group === "fab") && c.status === "fail").length;

  // a point under the pointer, kept on the board: KiCad refuses copper off it
  const mm = (e: { clientX: number; clientY: number }) => {
    const w = pz.toWorld(e.clientX, e.clientY);
    const m = 0.2;
    return pt(Math.min(W - m, Math.max(m, w.x / BASE)), Math.min(H - m, Math.max(m, w.y / BASE)));
  };
  // the nearest pad, via or track end within a few px, else the 0.05 mm grid
  const snap = useCallback(
    (p: Pt, skip?: Set<string>): Pt => {
      if (!geo) return p;
      const r = px(9);
      let best: Pt | null = null;
      let bd = r;
      const near = (q: Pt) => {
        const d = Math.hypot(q[0] - p[0], q[1] - p[1]);
        if (d < bd) (bd = d), (best = q);
      };
      for (const f of geo.footprints) for (const pad of f.pads) near([pad.x, pad.y]);
      for (const v of geo.vias) if (!skip?.has(v.id)) near([v.x, v.y]);
      for (const t of geo.tracks) if (!skip?.has(t.id)) near(t.a), near(t.b);
      return best ?? pt(Math.round(p[0] / 0.05) * 0.05, Math.round(p[1] / 0.05) * 0.05);
    },
    [geo, scale],
  );

  const commit = (group: BoardEdit[]) => {
    if (!group.length) return;
    setActions((a) => [...a, group]);
    setRedo([]);
    setNote(null);
  };

  /* ----- dragging what is selected ----- */
  // the drag in progress; its latest edits live here, not in state, so a
  // release that beats the next render still commits where it ended
  const dragRef = useRef<{ d: Drag; moved: boolean; ids: Set<string>; edits: BoardEdit[] } | null>(null);
  // the click that ends a press on an item must not clear what it selected
  const pressed = useRef(false);
  const editsFor = (d: Drag, to: Pt): BoardEdit[] => {
    if (!geo) return [];
    if (d.kind === "end") return dragEnd(geo, d.track, d.end, to);
    if (d.kind === "via") return dragVia(geo, d.via, to);
    if (d.kind === "track") return dragTrack(geo, d.track, to[0] - d.from[0], to[1] - d.from[1]);
    const at = pt(d.f.x + to[0] - d.from[0], d.f.y + to[1] - d.from[1]);
    return placeEdits(geo, d.f, at[0], at[1], d.f.rot);
  };
  const begin = (d: Drag, e: RPointerEvent) => {
    if (!geo || tool !== "select") return;
    e.stopPropagation();
    box.current?.focus({ preventScroll: true });
    (e.currentTarget as SVGElement).ownerSVGElement?.setPointerCapture(e.pointerId);
    // what moves with it is known from where it starts
    const start: Pt = d.kind === "end" ? d.track[d.end] : d.kind === "via" ? [d.via.x, d.via.y] : d.from;
    const ids = new Set(editsFor(d, start).map((x) => ("id" in x ? x.id : "")));
    dragRef.current = { d, moved: false, ids, edits: [] };
    pressed.current = true;
  };
  const onMove = (e: RPointerEvent) => {
    const cur = dragRef.current;
    if (cur && geo) {
      let to = mm(e);
      // a part or a whole track moves freely on the grid; an end or a via snaps
      to = cur.d.kind === "end" || cur.d.kind === "via" ? snap(to, cur.ids) : pt(Math.round(to[0] / 0.05) * 0.05, Math.round(to[1] / 0.05) * 0.05);
      cur.moved = true;
      cur.edits = editsFor(cur.d, to);
      setDrag({ ids: cur.ids, edits: cur.edits });
      return;
    }
    if (route) setRoute({ ...route, cursor: angled(route.pts.at(-1) ?? null, snap(mm(e)), e.shiftKey) });
  };
  const onUp = () => {
    const cur = dragRef.current;
    dragRef.current = null;
    if (cur?.moved && cur.edits.length) commit(cur.edits);
    setDrag(null);
  };

  /* ----- drawing tracks, placing vias ----- */
  const onCanvasClick = (e: React.MouseEvent) => {
    if (pressed.current) {
      pressed.current = false;
      return;
    }
    if (!geo) return;
    if (tool === "via") {
      const at = snap(mm(e));
      commit([{ op: "add_via", x: at[0], y: at[1], ...(netAt(geo, null, at) ? { net: netAt(geo, null, at)! } : {}) }]);
      return;
    }
    if (tool === "track") {
      const at = route?.cursor ?? snap(mm(e));
      if (!route) return setRoute({ pts: [at], cursor: at });
      const last = route.pts.at(-1)!;
      if (Math.hypot(at[0] - last[0], at[1] - last[1]) < 0.01) return finishRoute();
      const net = netAt(geo, active, route.pts[0]!) ?? netAt(geo, active, at);
      commit([{ op: "add_track", layer: active, a: last, b: at, width: width ?? Math.max(0.25, geo.rules.track_min), ...(net ? { net } : {}) }]);
      // a click on copper ends the track there
      if (netAt(geo, active, at)) return setRoute(null);
      setRoute({ pts: [...route.pts, at], cursor: at });
      return;
    }
    setSel(null);
  };
  const finishRoute = () => setRoute(null);

  const undo = () => {
    setActions((a) => {
      if (!a.length) return a;
      setRedo((r) => [...r, a.at(-1)!]);
      return a.slice(0, -1);
    });
  };
  const redoOne = () => {
    setRedo((r) => {
      if (!r.length) return r;
      setActions((a) => [...a, r.at(-1)!]);
      return r.slice(0, -1);
    });
  };

  const selected = useMemo(() => {
    if (!geo || !sel) return null;
    if (sel.kind === "part") return geo.footprints.find((f) => f.ref === sel.ref) ?? null;
    const id = sel.id;
    return sel.kind === "track" ? (geo.tracks.find((t) => t.id === id) ?? null) : (geo.vias.find((v) => v.id === id) ?? null);
  }, [geo, sel]);
  useEffect(() => {
    if (sel && !selected) setSel(null);
  }, [sel, selected]);

  const del = () => {
    if (!sel || sel.kind === "part") return;
    commit([{ op: "delete", id: sel.id }]);
    setSel(null);
  };
  const rotate = (f: BoardFootprint) => geo && commit(placeEdits(geo, f, f.x, f.y, f.rot + 90));

  const onKey = (e: KeyboardEvent) => {
    if ((e.target as HTMLElement).closest("input, textarea, [role=listbox], [role=combobox]")) return;
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === "z") return e.preventDefault(), e.shiftKey ? redoOne() : undo();
    if (mod) return;
    if (e.key === "Escape") return setRoute(null), setSel(null), setTool("select");
    if (e.key === "Delete" || e.key === "Backspace") return e.preventDefault(), del();
    if (e.key === "r" && selected && sel?.kind === "part") return rotate(selected as BoardFootprint);
    if (e.key === "s") return setTool("select");
    if (e.key === "t") return setTool("track");
    if (e.key === "v") return setTool("via");
    if (e.key === "Enter") return finishRoute();
  };

  // Copper redraws only when the board changes: its handlers never change
  const handlers = useRef({ track: (_t: BoardTrack, _e: RPointerEvent) => {}, via: (_v: BoardVia, _e: RPointerEvent) => {}, part: (_f: BoardFootprint, _e: RPointerEvent) => {} });
  handlers.current = {
    track: (t, e) => {
      setSel({ kind: "track", id: t.id });
      setActive(t.layer);
      // grab near an end: move that end; elsewhere: the whole track
      const p = mm(e);
      const near = (q: Pt) => Math.hypot(q[0] - p[0], q[1] - p[1]) < Math.max(px(10), t.width);
      begin(near(t.a) ? { kind: "end", track: t, end: "a" } : near(t.b) ? { kind: "end", track: t, end: "b" } : { kind: "track", track: t, from: p }, e);
    },
    via: (v, e) => {
      setSel({ kind: "via", id: v.id });
      begin({ kind: "via", via: v }, e);
    },
    part: (f, e) => {
      setSel({ kind: "part", ref: f.ref });
      begin({ kind: "part", f, from: mm(e) }, e);
    },
  };
  const onTrack = useCallback((t: BoardTrack, e: RPointerEvent) => handlers.current.track(t, e), []);
  const onVia = useCallback((v: BoardVia, e: RPointerEvent) => handlers.current.via(v, e), []);
  const onPart = useCallback((f: BoardFootprint, e: RPointerEvent) => handlers.current.part(f, e), []);

  const draft = compact(edits);
  const onSave = async () => {
    if (!save || !draft.length) return;
    setSaving(true);
    setNote(null);
    const was = from;
    try {
      const r = await save({ edits: draft, note: `You ${describe(draft)} by hand` });
      setNote({ ok: r.ok, text: r.summary });
      // the new board may already be here (its event can beat this answer)
      if (fromNow.current !== was) {
        setActions([]);
        setRedo([]);
      } else savedFrom.current = was;
    } catch (err) {
      setNote({ ok: false, text: err instanceof Error ? err.message : "Could not save the edits" });
    } finally {
      setSaving(false);
    }
  };

  if (!hasBoard)
    return (
      <Empty title="No layout yet">
        After the board size and layers are decided, HardHub places the parts, routes every connection and draws each copper layer here.
      </Empty>
    );

  const editable = !!geo && !!save;
  const live = drag && geo ? applyEdits(geo, drag.edits) : null;
  const liveTracks = live ? live.tracks.filter((t) => drag!.ids.has(t.id)) : [];
  const liveVias = live ? live.vias.filter((v) => drag!.ids.has(v.id)) : [];
  const livePart = live && dragRef.current?.d.kind === "part" ? live.footprints.find((f) => f.ref === (dragRef.current!.d as { f: BoardFootprint }).f.ref) : null;
  const hide = drag?.ids ?? EMPTY;
  // with the geometry, copper is drawn as vectors; without it, KiCad's copper plots stand in
  const plots = (which: "under" | "over") =>
    images
      .filter((i) => (which === "over" ? OVER.includes(i.layer) : UNDER.includes(i.layer) || (!geo && i.layer.endsWith(".Cu"))))
      .map((l) => (
        <img
          key={l.layer}
          src={l.src}
          alt=""
          decoding="async"
          draggable={false}
          className="pointer-events-none absolute inset-0 size-full"
          style={{ visibility: hiddenLayers.has(l.layer) ? "hidden" : "visible", opacity: l.layer.endsWith(".Cu") && !l.layer.startsWith("F.") ? 0.75 : 1 }}
        />
      ));
  const allLayers = [...new Set([...images.map((i) => i.layer), ...copperLayers])].sort((a, b) => rank(b) - rank(a));
  const sTrack = sel?.kind === "track" ? (selected as BoardTrack | null) : null;
  const sVia = sel?.kind === "via" ? (selected as BoardVia | null) : null;
  const sPart = sel?.kind === "part" ? (selected as BoardFootprint | null) : null;

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-testid="board-2d">
      <ViewBar>
        <ToggleGroup type="single" value={tool} onValueChange={(v) => v && (setTool(v as Tool), setRoute(null))} aria-label="Tool" className="h-8">
          {[
            { v: "select", icon: <MousePointer2Icon />, label: "Select and drag", key: "S" },
            { v: "track", icon: <SplineIcon />, label: "Draw a track", key: "T" },
            { v: "via", icon: <ViaIcon />, label: "Add a via", key: "V" },
          ].map((t) => (
            <Tooltip key={t.v}>
              <TooltipTrigger asChild>
                <ToggleGroupItem value={t.v} aria-label={t.label} disabled={!editable && t.v !== "select"} className="px-2.5">
                  {t.icon}
                </ToggleGroupItem>
              </TooltipTrigger>
              <TooltipContent>
                {t.label} <span className="num opacity-60">{t.key}</span>
              </TooltipContent>
            </Tooltip>
          ))}
        </ToggleGroup>
        {tool === "track" && geo && (
          <>
            <Select value={active} onValueChange={setActive}>
              <SelectTrigger className="h-8 w-auto gap-2" aria-label="Layer to draw on">
                <span className="size-2.5 rounded-[3px]" style={{ background: copperColor(active) }} />
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {geo.layers.map((l) => (
                  <SelectItem key={l} value={l}>
                    {layerName(l)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Input
              className="num h-8 w-24"
              aria-label="Track width in mm"
              defaultValue={(width ?? Math.max(0.25, geo.rules.track_min)).toFixed(2)}
              onBlur={(e) => {
                const v = Number(e.target.value);
                if (v >= geo.rules.track_min && v <= 10) setWidth(v);
              }}
            />
          </>
        )}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon-sm" onClick={undo} disabled={!actions.length} aria-label="Undo">
              <Undo2Icon />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Undo</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon-sm" onClick={redoOne} disabled={!redo.length} aria-label="Redo">
              <Redo2Icon />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Redo</TooltipContent>
        </Tooltip>
        <BarRule />
        <Popover>
          <PopoverTrigger asChild>
            <Button variant="outline" size="sm">
              <LayersIcon />
              Layers
            </Button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-64 p-2">
            {allLayers.map((l) => (
              <label key={l} className="flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 text-sm hover:bg-accent">
                <span className="size-2.5 shrink-0 rounded-[3px]" style={{ background: l.endsWith(".Cu") ? copperColor(l) : l.includes("Silk") ? "var(--silk)" : "var(--muted-foreground)" }} />
                <span className="flex-1">{layerName(l)}</span>
                <Switch
                  checked={!hiddenLayers.has(l)}
                  onCheckedChange={() =>
                    setHiddenLayers((h) => {
                      const n = new Set(h);
                      if (n.has(l)) n.delete(l);
                      else n.add(l);
                      return n;
                    })
                  }
                  data-testid={`layer-${l}`}
                  aria-label={layerName(l)}
                />
              </label>
            ))}
          </PopoverContent>
        </Popover>
        <span className="grow" />
        {checks.length > 0 &&
          (drcFails ? (
            <Badge tone="clay">
              <CircleXIcon />
              {drcFails} {drcFails === 1 ? "problem" : "problems"} on the board
            </Badge>
          ) : (
            <Badge tone="moss">
              <CircleCheckIcon />
              Board checks pass
            </Badge>
          ))}
        {draft.length > 0 && (
          <>
            <span className="hidden text-xs text-muted-foreground lg:inline">Not saved: {describe(draft)}</span>
            <Button variant="ghost" size="sm" onClick={() => (setActions([]), setRedo([]))} disabled={saving}>
              Discard
            </Button>
            <Button size="sm" onClick={onSave} disabled={saving} data-testid="save-edits">
              {saving && <LoaderCircleIcon className="animate-spin" />}
              {saving ? "Checking…" : "Save and check"}
            </Button>
          </>
        )}
      </ViewBar>

      <div
        ref={box}
        tabIndex={0}
        onKeyDown={onKey}
        className={cn(
          "relative min-h-[420px] flex-1 touch-none overflow-hidden bg-board outline-none",
          tool === "select" ? "cursor-grab active:cursor-grabbing" : "cursor-crosshair",
        )}
        aria-label={`The board, ${W.toFixed(1)} by ${H.toFixed(1)} mm${editable ? ". S: select, T: draw a track, V: add a via, Delete: remove, R: turn a part, Escape: stop." : ""}`}
      >
        <div ref={stage} className="absolute left-0 top-0 origin-top-left" style={{ width: W * BASE, height: H * BASE }}>
          <div className="absolute inset-0 rounded-[2px] bg-[#0f1410] shadow-[0_0_0_1px_rgba(240,184,74,.35)]" />
          {plots("under")}
          {geo && (
            <svg
              className="absolute inset-0 size-full overflow-visible"
              viewBox={`0 0 ${W} ${H}`}
              onPointerMove={onMove}
              onPointerUp={onUp}
              onPointerCancel={onUp}
              onClick={onCanvasClick}
              onDoubleClick={finishRoute}
            >
              <rect width={W} height={H} fill="transparent" />
              <Copper
                geo={geo}
                shown={shown}
                active={active}
                hide={hide}
                tool={editable ? tool : "track"}
                onTrack={onTrack}
                onVia={onVia}
                onPart={onPart}
              />
            </svg>
          )}
          {plots("over")}
          {geo && (
            <svg className="pointer-events-none absolute inset-0 size-full overflow-visible" viewBox={`0 0 ${W} ${H}`} aria-hidden="true">
              {liveTracks.map((t) => (
                <path key={t.id} d={`M${t.a[0]} ${t.a[1]}L${t.b[0]} ${t.b[1]}`} stroke={copperColor(t.layer)} strokeWidth={t.width} strokeLinecap="round" opacity={0.9} />
              ))}
              {liveVias.map((v) => (
                <circle key={v.id} cx={v.x} cy={v.y} r={v.d / 2} fill="#d9a35a" />
              ))}
              {livePart && (
                <rect x={livePart.bbox[0]} y={livePart.bbox[1]} width={livePart.bbox[2] - livePart.bbox[0]} height={livePart.bbox[3] - livePart.bbox[1]} fill="rgba(255,138,61,.12)" stroke="var(--ember)" strokeWidth={px(1.5)} strokeDasharray={`${px(5)} ${px(3)}`} />
              )}
              {sTrack && !drag && (
                <>
                  <path d={`M${sTrack.a[0]} ${sTrack.a[1]}L${sTrack.b[0]} ${sTrack.b[1]}`} stroke="#fff" strokeOpacity={0.35} strokeWidth={sTrack.width + px(6)} strokeLinecap="round" fill="none" />
                  {[sTrack.a, sTrack.b].map((q, i) => (
                    <rect key={i} x={q[0] - px(5)} y={q[1] - px(5)} width={px(10)} height={px(10)} fill="#f1ece0" stroke="#1b1813" strokeWidth={px(1.5)} />
                  ))}
                </>
              )}
              {sVia && !drag && <circle cx={sVia.x} cy={sVia.y} r={sVia.d / 2 + px(4)} fill="none" stroke="#f1ece0" strokeWidth={px(2)} />}
              {sPart && !drag && (
                <rect x={sPart.bbox[0] - px(3)} y={sPart.bbox[1] - px(3)} width={sPart.bbox[2] - sPart.bbox[0] + px(6)} height={sPart.bbox[3] - sPart.bbox[1] + px(6)} fill="rgba(255,138,61,.08)" stroke="var(--ember)" strokeWidth={px(1.5)} strokeDasharray={`${px(5)} ${px(3)}`} />
              )}
              {route && (
                <>
                  {route.pts.length > 0 && route.cursor && (
                    <path
                      d={`M${route.pts.at(-1)![0]} ${route.pts.at(-1)![1]}L${route.cursor[0]} ${route.cursor[1]}`}
                      stroke={copperColor(active)}
                      strokeWidth={width ?? Math.max(0.25, geo.rules.track_min)}
                      strokeLinecap="round"
                      opacity={0.7}
                    />
                  )}
                  {route.cursor && <circle cx={route.cursor[0]} cy={route.cursor[1]} r={px(4)} fill="none" stroke="#f1ece0" strokeWidth={px(1.5)} />}
                </>
              )}
            </svg>
          )}
        </div>

        {sel && selected && !drag && (
          <aside data-nopan className="absolute right-3 top-3 flex w-64 max-w-[calc(100%-1.5rem)] flex-col gap-3 rounded-xl border bg-popover p-4 text-sm shadow-2xl shadow-black/40" aria-label="Selected">
            <div className="flex items-center gap-2">
              <span className="size-2.5 rounded-[3px]" style={{ background: sTrack ? copperColor(sTrack.layer) : sVia ? "#d9a35a" : "var(--ember)" }} />
              <strong className="min-w-0 flex-1 truncate font-semibold">
                {sTrack ? `Track · ${sTrack.net || "no net"}` : sVia ? `Via · ${sVia.net || "no net"}` : `${sPart!.ref} · ${valueOf(design, sPart!.ref)}`}
              </strong>
              <Button variant="ghost" size="icon-sm" className="-mr-2 size-7" onClick={() => setSel(null)} aria-label="Close">
                <XIcon />
              </Button>
            </div>
            {sTrack && geo && (
              <div className="grid grid-cols-[4.5rem_1fr] items-center gap-2">
                <span className="text-muted-foreground">Layer</span>
                <Select value={sTrack.layer} onValueChange={(l) => editable && commit([{ op: "set_track", id: sTrack.id, a: sTrack.a, b: sTrack.b, layer: l }])} disabled={!editable}>
                  <SelectTrigger className="h-8" aria-label="Layer">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {geo.layers.map((l) => (
                      <SelectItem key={l} value={l}>
                        {layerName(l)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <span className="text-muted-foreground">Width</span>
                <Input
                  key={`${sTrack.id}:${sTrack.width}`}
                  className="num h-8"
                  defaultValue={`${sTrack.width.toFixed(2)}`}
                  aria-label="Width in mm"
                  disabled={!editable}
                  onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
                  onBlur={(e) => {
                    const v = Number(e.target.value);
                    if (v >= geo.rules.track_min && v <= 10 && Math.abs(v - sTrack.width) > 1e-4) commit([{ op: "set_track", id: sTrack.id, a: sTrack.a, b: sTrack.b, width: v }]);
                  }}
                />
                <span className="text-muted-foreground">Length</span>
                <span className="num">{trackLength(sTrack).toFixed(2)} mm</span>
              </div>
            )}
            {sVia && (
              <div className="grid grid-cols-[4.5rem_1fr] gap-2">
                <span className="text-muted-foreground">Size</span>
                <span className="num">
                  {sVia.d.toFixed(2)} mm, drill {sVia.drill.toFixed(2)}
                </span>
                <span className="text-muted-foreground">Layers</span>
                <span>
                  {layerName(sVia.from)} to {layerName(sVia.to).toLowerCase()}
                </span>
              </div>
            )}
            {sPart && (
              <div className="grid grid-cols-[4.5rem_1fr] gap-2">
                <span className="text-muted-foreground">Position</span>
                <span className="num">
                  {sPart.x.toFixed(2)}, {sPart.y.toFixed(2)}
                </span>
                <span className="text-muted-foreground">Turned</span>
                <span className="num">{Math.round(sPart.rot)}°</span>
                <span className="text-muted-foreground">Side</span>
                <span>{sPart.side === "top" ? "Top" : "Bottom"}</span>
              </div>
            )}
            {editable && (
              <div className="flex flex-wrap gap-2">
                {sPart ? (
                  <Button variant="outline" size="sm" onClick={() => rotate(sPart)}>
                    <RotateCwIcon />
                    Turn 90°
                  </Button>
                ) : (
                  <Button variant="outline" size="sm" onClick={del}>
                    <Trash2Icon />
                    Delete
                  </Button>
                )}
              </div>
            )}
            <p className="text-xs text-muted-foreground">
              {sPart ? "Drag to move it. Its tracks stretch to follow; re-route or redraw them after." : sTrack ? "Drag an end to bend it, or the middle to move it. Tracks that meet it follow." : "Drag to move it. Its tracks follow."}
            </p>
          </aside>
        )}

        <div data-nopan className="absolute bottom-3 left-3 flex max-w-[calc(100%-9rem)] flex-wrap items-center gap-2">
          {note && (
            <Badge tone={note.ok ? "moss" : "clay"} className="h-auto max-w-full whitespace-normal py-1" role="status">
              {note.text}
            </Badge>
          )}
          {!note && route && <Badge tone="ember">Click to add a corner · double-click or Enter to finish · Shift for any angle</Badge>}
          {!note && !route && !geo && (jsonArt ? failed : true) && images.length > 0 && (
            <Badge>{design.board ? `${W.toFixed(0)} × ${H.toFixed(0)} mm` : ""} · hand editing arrives with the next board build</Badge>
          )}
          {!note && !route && geo && <span className="num hidden rounded-md bg-card/80 px-2 py-1 text-xs text-muted-foreground backdrop-blur sm:inline">{W.toFixed(1)} × {H.toFixed(1)} mm · {geo.layers.length} layers</span>}
        </div>
        <ZoomControls className="absolute bottom-3 right-3" onIn={() => pz.zoomBy(1.4)} onOut={() => pz.zoomBy(1 / 1.4)} onFit={pz.fit} />
      </div>
    </div>
  );
}

const EMPTY = new Set<string>();

function valueOf(design: Design, ref: string) {
  const c = design.components.find((x) => x.ref === ref);
  const p = c ? design.parts[c.part] : undefined;
  return p?.value ?? p?.mpn ?? "";
}

/** A track's next corner: straight, or at 45°, unless any angle is asked for. */
function angled(from: Pt | null, to: Pt, free: boolean): Pt {
  if (!from || free) return to;
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const a = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
  const len = Math.hypot(dx, dy);
  return pt(from[0] + Math.cos(a) * len, from[1] + Math.sin(a) * len);
}

function ViaIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
      <circle cx="12" cy="12" r="7" />
      <circle cx="12" cy="12" r="2.5" />
    </svg>
  );
}

