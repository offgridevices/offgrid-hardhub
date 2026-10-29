// Pan and zoom for a drawing in a box: drag to move, pinch or scroll to zoom.
// The transform is written straight onto the stage element, never through
// React state, so it stays smooth however big the drawing is.
import { useCallback, useEffect, useLayoutEffect, useRef, type RefObject } from "react";

export interface View {
  x: number;
  y: number;
  s: number;
}

export interface PanZoom {
  view: RefObject<View>;
  /** fit the whole drawing in the box, inside `pad` px */
  fit(): void;
  /** zoom about the box's centre */
  zoomBy(f: number): void;
  /** fit one part of the drawing (its own units) in the box */
  fitTo(x: number, y: number, w: number, h: number): void;
  /** a point on screen, in the drawing's own units */
  toWorld(clientX: number, clientY: number): { x: number; y: number };
}

export function usePanZoom({
  box,
  stage,
  width,
  height,
  pad = 24,
  min = 0.05,
  max = 60,
  canPan,
  onView,
  enabled = true,
}: {
  box: RefObject<HTMLElement | null>;
  stage: RefObject<HTMLElement | SVGGElement | null>;
  /** the drawing's size in its own units (px at scale 1) */
  width: number;
  height: number;
  pad?: number;
  min?: number;
  max?: number;
  /** a pointer that starts on something the caller handles (a handle being dragged) does not pan */
  canPan?: (e: PointerEvent) => boolean;
  /** told after every change, for things drawn at a constant screen size */
  onView?: (v: View) => void;
  /** false while the box is not on screen (an empty state shows instead) */
  enabled?: boolean;
}): PanZoom {
  const view = useRef<View>({ x: 0, y: 0, s: 1 });
  const canPanRef = useRef(canPan);
  canPanRef.current = canPan;
  const onViewRef = useRef(onView);
  onViewRef.current = onView;

  const apply = useCallback(() => {
    const v = view.current;
    const el = stage.current;
    if (el) {
      if (el instanceof SVGGElement) el.setAttribute("transform", `translate(${v.x} ${v.y}) scale(${v.s})`);
      else el.style.transform = `translate3d(${v.x}px, ${v.y}px, 0) scale(${v.s})`;
    }
    onViewRef.current?.(v);
  }, [stage]);

  const fit = useCallback(() => {
    const el = box.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const w = Math.max(40, r.width - pad * 2);
    const h = Math.max(40, r.height - pad * 2);
    const s = Math.min(w / width, h / height);
    view.current = { s, x: (r.width - width * s) / 2, y: (r.height - height * s) / 2 };
    apply();
  }, [box, width, height, pad, apply]);

  const fitTo = useCallback(
    (x: number, y: number, w: number, h: number) => {
      const el = box.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const s = Math.min(max, Math.max(min, Math.min((r.width - pad * 2) / w, (r.height - pad * 2) / h)));
      view.current = { s, x: r.width / 2 - (x + w / 2) * s, y: r.height / 2 - (y + h / 2) * s };
      apply();
    },
    [box, pad, min, max, apply],
  );

  const zoomAt = useCallback(
    (px: number, py: number, f: number) => {
      const v = view.current;
      const s = Math.min(max, Math.max(min, v.s * f));
      const k = s / v.s;
      view.current = { s, x: px - (px - v.x) * k, y: py - (py - v.y) * k };
      apply();
    },
    [min, max, apply],
  );

  const zoomBy = useCallback(
    (f: number) => {
      const r = box.current?.getBoundingClientRect();
      if (r) zoomAt(r.width / 2, r.height / 2, f);
    },
    [box, zoomAt],
  );

  const toWorld = useCallback(
    (cx: number, cy: number) => {
      const r = box.current!.getBoundingClientRect();
      const v = view.current;
      return { x: (cx - r.left - v.x) / v.s, y: (cy - r.top - v.y) / v.s };
    },
    [box],
  );

  useLayoutEffect(fit, [fit, enabled]);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    // a resized box keeps the drawing fitted only until the person zooms;
    // after that it keeps their view
    let touched = false;
    const ro = new ResizeObserver(() => !touched && fit());
    ro.observe(el);
    const pts = new Map<number, { x: number; y: number }>();
    let pinch: { d: number; s: number; cx: number; cy: number } | null = null;
    // the pointer is captured only once it has moved, so a plain click still
    // reaches whatever was clicked (a part, a label)
    let start: { x: number; y: number } | null = null;
    let dragging = false;
    let quietUntil = 0;
    const click = (c: MouseEvent) => {
      if (performance.now() < quietUntil) c.stopPropagation();
    };
    const local = (e: PointerEvent | WheelEvent) => {
      const r = el.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    const down = (e: PointerEvent) => {
      if ((e.target as Element).closest("[data-nopan]")) return;
      if (e.button !== 0 && e.button !== 1) return;
      if (canPanRef.current && !canPanRef.current(e)) return;
      pts.set(e.pointerId, local(e));
      if (pts.size === 1) {
        start = local(e);
        dragging = false;
      }
      if (pts.size === 2) {
        const [a, b] = [...pts.values()];
        pinch = { d: Math.hypot(a!.x - b!.x, a!.y - b!.y), s: view.current.s, cx: (a!.x + b!.x) / 2, cy: (a!.y + b!.y) / 2 };
      }
    };
    const move = (e: PointerEvent) => {
      const prev = pts.get(e.pointerId);
      if (!prev) return;
      const p = local(e);
      if (!dragging) {
        if (pts.size < 2 && start && Math.hypot(p.x - start.x, p.y - start.y) < 4) return;
        dragging = true;
        for (const id of pts.keys()) if (el.hasPointerCapture?.(id) === false) el.setPointerCapture(id);
      }
      pts.set(e.pointerId, p);
      touched = true;
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
      if (pts.size === 0) {
        start = null;
        // a drag that just ended is not a click on what lies under it
        if (dragging) quietUntil = performance.now() + 80;
        dragging = false;
      }
    };
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      touched = true;
      const p = local(e);
      zoomAt(p.x, p.y, Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)));
    };
    el.addEventListener("click", click, { capture: true });
    el.addEventListener("pointerdown", down);
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
    el.addEventListener("wheel", wheel, { passive: false });
    return () => {
      ro.disconnect();
      el.removeEventListener("click", click, { capture: true });
      el.removeEventListener("pointerdown", down);
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      el.removeEventListener("wheel", wheel);
    };
  }, [box, fit, zoomAt, apply, enabled]);

  return { view, fit, zoomBy, fitTo, toWorld };
}
