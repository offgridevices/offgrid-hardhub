// The board, layer by layer. Each layer is an SVG from the engine (KiCad's own
// plot, cropped to the board) shown as an <img>, so the browser decodes and
// rasterises it off the main thread. Pan and zoom move one transformed
// element directly, never through React state, so they stay smooth.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Artifact, Design } from "@hardhub/protocol";
import { LAYER_COLORS } from "../workers/geometry";
import { demoLayerSvgs } from "../workers/client";

const ORDER = ["B.Silkscreen", "B.Cu", "In4.Cu", "In3.Cu", "In2.Cu", "In1.Cu", "F.Cu", "F.Silkscreen", "Edge.Cuts"];
const NAMES: Record<string, string> = {
  "F.Cu": "Top copper",
  "B.Cu": "Bottom copper",
  "F.Silkscreen": "Top print",
  "B.Silkscreen": "Bottom print",
  "Edge.Cuts": "Outline",
};
const layerName = (l: string) => NAMES[l] ?? l.replace(/^In(\d+)\.Cu$/, "Inner $1");
const rank = (l: string) => {
  const i = ORDER.indexOf(l);
  return i < 0 ? 4 : i;
};

interface View {
  x: number;
  y: number;
  s: number;
}

export default function Board2D({
  design,
  artifacts,
  fileUrl,
}: {
  design: Design;
  artifacts: Artifact[];
  fileUrl(url: string): string;
}) {
  const svgs = useMemo(() => artifacts.filter((a) => a.kind === "board-svg"), [artifacts]);
  const isMock = svgs.some((a) => a.url.startsWith("mock:"));
  const [demo, setDemo] = useState<Record<string, string> | null>(null);

  // demo mode draws its layers in the worker and hands them over as blob URLs
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

  const layers = useMemo(
    () =>
      svgs
        .map((a) => {
          const l = a.layers?.[0] ?? a.name;
          const src = isMock ? demo?.[l] : fileUrl(a.url);
          return { layer: l, src };
        })
        .filter((x): x is { layer: string; src: string } => !!x.src)
        .sort((a, b) => rank(a.layer) - rank(b.layer)),
    [svgs, isMock, demo, fileUrl],
  );

  const [hidden, setHidden] = useState<Set<string>>(() => new Set(["B.Silkscreen"]));
  const viewer = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const view = useRef<View>({ x: 0, y: 0, s: 1 });
  const W = design.board?.width ?? 100;
  const H = design.board?.height ?? 60;
  const BASE = 8; // px per mm at scale 1

  const apply = () => {
    const v = view.current;
    if (stage.current) stage.current.style.transform = `translate3d(${v.x}px, ${v.y}px, 0) scale(${v.s})`;
  };
  const fit = () => {
    const el = viewer.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const s = Math.min((r.width - 32) / (W * BASE), (r.height - 96) / (H * BASE));
    view.current = { s, x: (r.width - W * BASE * s) / 2, y: Math.max(16, (r.height - 64 - H * BASE * s) / 2) };
    apply();
  };
  useLayoutEffect(fit, [W, H]);
  useEffect(() => {
    const el = viewer.current;
    if (!el) return;
    const ro = new ResizeObserver(() => fit());
    ro.observe(el);
    return () => ro.disconnect();
  }, [W, H]);

  // pointer pan, pinch and wheel zoom
  useEffect(() => {
    const el = viewer.current;
    if (!el) return;
    const pts = new Map<number, { x: number; y: number }>();
    let pinch: { d: number; s: number; cx: number; cy: number } | null = null;
    const zoomAt = (px: number, py: number, f: number) => {
      const v = view.current;
      const s = Math.min(40, Math.max(0.1, v.s * f));
      const k = s / v.s;
      view.current = { s, x: px - (px - v.x) * k, y: py - (py - v.y) * k };
      apply();
    };
    const local = (e: PointerEvent | WheelEvent) => {
      const r = el.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    const down = (e: PointerEvent) => {
      if ((e.target as HTMLElement).closest(".viewer-tools")) return;
      el.setPointerCapture(e.pointerId);
      pts.set(e.pointerId, local(e));
      if (pts.size === 2) {
        const [a, b] = [...pts.values()];
        pinch = { d: Math.hypot(a!.x - b!.x, a!.y - b!.y), s: view.current.s, cx: (a!.x + b!.x) / 2, cy: (a!.y + b!.y) / 2 };
      }
    };
    const move = (e: PointerEvent) => {
      const prev = pts.get(e.pointerId);
      if (!prev) return;
      const p = local(e);
      pts.set(e.pointerId, p);
      if (pts.size === 2 && pinch) {
        const [a, b] = [...pts.values()];
        const d = Math.hypot(a!.x - b!.x, a!.y - b!.y);
        zoomAt(pinch.cx, pinch.cy, (pinch.s * (d / pinch.d)) / view.current.s);
      } else if (pts.size === 1) {
        view.current.x += p.x - prev.x;
        view.current.y += p.y - prev.y;
        apply();
      }
    };
    const up = (e: PointerEvent) => {
      pts.delete(e.pointerId);
      if (pts.size < 2) pinch = null;
    };
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      const p = local(e);
      zoomAt(p.x, p.y, Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)));
    };
    el.addEventListener("pointerdown", down);
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
    el.addEventListener("wheel", wheel, { passive: false });
    return () => {
      el.removeEventListener("pointerdown", down);
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      el.removeEventListener("wheel", wheel);
    };
  }, []);

  const zoomButton = (f: number) => {
    const r = viewer.current!.getBoundingClientRect();
    const v = view.current;
    const s = Math.min(40, Math.max(0.1, v.s * f));
    const k = s / v.s;
    const px = r.width / 2;
    const py = r.height / 2;
    view.current = { s, x: px - (px - v.x) * k, y: py - (py - v.y) * k };
    apply();
  };

  if (svgs.length === 0)
    return (
      <div className="pane-inner">
        <div className="empty">
          <h2 className="d4">No layout yet</h2>
          <p>After the board size and layers are decided, HardHub places the parts, routes every connection and draws each copper layer here.</p>
        </div>
      </div>
    );

  return (
    <div className="viewer" ref={viewer} data-testid="board-2d" style={{ background: "var(--coal)" }}>
      <div className="viewer-hint">
        {W} × {H} mm · drag to move, pinch or scroll to zoom
      </div>
      <div className="viewer-stage" ref={stage} style={{ width: W * BASE, height: H * BASE }}>
        {layers.map((l) => (
          <img
            key={l.layer}
            src={l.src}
            alt=""
            decoding="async"
            draggable={false}
            style={{ visibility: hidden.has(l.layer) ? "hidden" : "visible", opacity: l.layer.endsWith(".Cu") && !l.layer.startsWith("F.") ? 0.75 : 1 }}
          />
        ))}
      </div>
      <div className="viewer-tools">
        <div className="layer-panel" role="group" aria-label="Layers">
          {[...layers].reverse().map((l) => (
            <label key={l.layer} className="chk">
              <input
                type="checkbox"
                checked={!hidden.has(l.layer)}
                onChange={() =>
                  setHidden((h) => {
                    const n = new Set(h);
                    if (n.has(l.layer)) n.delete(l.layer);
                    else n.add(l.layer);
                    return n;
                  })
                }
                data-testid={`layer-${l.layer}`}
              />
              <span className="swatch" style={{ background: LAYER_COLORS[l.layer] ?? "var(--fg-3)" }} />
              {layerName(l.layer)}
            </label>
          ))}
        </div>
        <div className="zoom">
          <button onClick={() => zoomButton(1 / 1.4)} aria-label="Zoom out">
            −
          </button>
          <button onClick={fit} aria-label="Fit board" style={{ width: 48, fontSize: 12 }}>
            Fit
          </button>
          <button onClick={() => zoomButton(1.4)} aria-label="Zoom in">
            +
          </button>
        </div>
      </div>
    </div>
  );
}
