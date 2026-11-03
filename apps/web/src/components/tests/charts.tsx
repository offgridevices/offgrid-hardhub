// Small hand-drawn charts for the simulations: one line, its axes, reference
// lines and a crosshair that follows the pointer or the arrow keys. No chart
// library: the Tests view stays light. Lines are 2 px, grid and axes are
// hairlines, text is in the text colours, never the line's.
import { useCallback, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type RefObject } from "react";
import { decades, linear, linePath, log, nearest, niceDomain, niceTicks, type Scale } from "../../lib/scales";
import { cn } from "@/lib/utils";

/** the element's width, kept current */
export function useWidth<T extends HTMLElement>(): [RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setW(el.getBoundingClientRect().width);
    const ro = new ResizeObserver(([e]) => setW(e!.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

export interface RefLine {
  y: number;
  label: string;
}

const M = { l: 48, r: 14, t: 12, b: 26 };

export function LineChart({
  xs,
  ys,
  xLog,
  yLog,
  height = 200,
  fmtX,
  fmtY,
  refs = [],
  mark,
  yDomain,
  label,
}: {
  xs: number[];
  ys: number[];
  xLog?: boolean;
  yLog?: boolean;
  height?: number;
  fmtX(v: number): string;
  fmtY(v: number): string;
  refs?: RefLine[];
  /** one point worth naming (the lowest dip): a dot and its value */
  mark?: { x: number; y: number; label: string };
  yDomain?: [number, number];
  label: string;
}) {
  const [box, w] = useWidth<HTMLDivElement>();
  const [at, setAt] = useState<number | null>(null);
  const svg = useRef<SVGSVGElement>(null);
  const W = Math.max(200, w);
  const x0 = Math.min(...xs);
  const x1 = Math.max(...xs);
  const all = [...ys, ...refs.map((r) => r.y)];
  let lo = Math.min(...all);
  let hi = Math.max(...all);
  let x: Scale;
  let y: Scale;
  let yt: number[];
  if (yLog) {
    lo = 10 ** Math.floor(Math.log10(lo));
    hi = 10 ** Math.ceil(Math.log10(hi));
    y = log(yDomain ?? [lo, hi], [height - M.b, M.t]);
    yt = decades(...y.domain);
  } else {
    const d = yDomain ?? niceDomain(lo - (hi - lo) * 0.05, hi + (hi - lo) * 0.05, 4);
    y = linear(d, [height - M.b, M.t]);
    yt = niceTicks(d[0], d[1], 4);
  }
  if (xLog) x = log([x0, x1], [M.l, W - M.r]);
  else x = linear([x0, x1], [M.l, W - M.r]);
  const xt = xLog ? decades(x0, x1) : niceTicks(x0, x1, Math.max(3, Math.floor(W / 90)));

  const move = useCallback(
    (e: PointerEvent) => {
      const r = svg.current!.getBoundingClientRect();
      setAt(nearest(xs, x.invert(((e.clientX - r.left) / r.width) * W)));
    },
    [xs, x, W],
  );
  const key = (e: KeyboardEvent) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const step = e.shiftKey ? 10 : 1;
    setAt((i) => Math.min(xs.length - 1, Math.max(0, (i ?? (e.key === "ArrowLeft" ? xs.length : -1)) + (e.key === "ArrowLeft" ? -step : step))));
  };
  const cur = at !== null ? { x: x(xs[at]!), y: y(ys[at]!) } : null;

  return (
    <div ref={box} className="relative w-full select-none">
      <svg
        ref={svg}
        width="100%"
        height={height}
        viewBox={`0 0 ${W} ${height}`}
        className="block max-w-full touch-pan-y overflow-visible outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 rounded-md"
        role="img"
        aria-label={label}
        tabIndex={0}
        onPointerMove={move}
        onPointerDown={move}
        onPointerLeave={() => setAt(null)}
        onKeyDown={key}
        onBlur={() => setAt(null)}
      >
        {yt.map((t) => (
          <g key={t}>
            <line x1={M.l} x2={W - M.r} y1={y(t)} y2={y(t)} stroke="var(--border)" />
            <text x={M.l - 6} y={y(t)} dy="0.32em" textAnchor="end" className="tabular-nums fill-muted-foreground text-[10px]">
              {fmtY(t)}
            </text>
          </g>
        ))}
        <line x1={M.l} x2={W - M.r} y1={height - M.b} y2={height - M.b} stroke="var(--input)" />
        {xt.map((t) => (
          <text key={t} x={x(t)} y={height - M.b + 15} textAnchor="middle" className="tabular-nums fill-muted-foreground text-[10px]">
            {fmtX(t)}
          </text>
        ))}
        {refs.map((r) => (
          <g key={r.label}>
            <line x1={M.l} x2={W - M.r} y1={y(r.y)} y2={y(r.y)} stroke="var(--muted-foreground)" strokeDasharray="4 3" />
            <text
              x={W - M.r}
              y={y(r.y) - 5}
              textAnchor="end"
              className="fill-soft text-[10px] font-medium [paint-order:stroke] [stroke:var(--card)] [stroke-width:3px]"
            >
              {r.label}
            </text>
          </g>
        ))}
        <path d={linePath(xs, ys, x, y)} fill="none" stroke="var(--sky)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        {mark && (
          <g>
            <circle cx={x(mark.x)} cy={y(mark.y)} r={4.5} fill="var(--sky)" stroke="var(--card)" strokeWidth={2} />
            <text
              x={x(mark.x) + (x(mark.x) > W * 0.7 ? -8 : 8)}
              y={y(mark.y) + (y(mark.y) > height * 0.6 ? -10 : 4)}
              dy={y(mark.y) > height * 0.6 ? "0" : "0.6em"}
              textAnchor={x(mark.x) > W * 0.7 ? "end" : "start"}
              className="tabular-nums fill-foreground text-[11px] font-medium [paint-order:stroke] [stroke:var(--card)] [stroke-width:3px]"
            >
              {mark.label}
            </text>
          </g>
        )}
        {cur && (
          <g pointerEvents="none">
            <line x1={cur.x} x2={cur.x} y1={M.t} y2={height - M.b} stroke="var(--muted-foreground)" strokeOpacity={0.6} />
            <circle cx={cur.x} cy={cur.y} r={4.5} fill="var(--sky)" stroke="var(--card)" strokeWidth={2} />
          </g>
        )}
        {/* the hit area: the whole plot, so the pointer only has to be near the line */}
        <rect x={M.l} y={M.t} width={W - M.l - M.r} height={height - M.t - M.b} fill="transparent" />
      </svg>
      {cur && at !== null && (
        <div
          className={cn(
            "pointer-events-none absolute top-1 z-10 rounded-md border bg-popover px-2.5 py-1.5 text-xs shadow-lg shadow-black/20",
            cur.x > W * 0.6 ? "-translate-x-[calc(100%+10px)]" : "translate-x-[10px]",
          )}
          style={{ left: `${(cur.x / W) * 100}%` }}
          role="status"
        >
          <div className="tabular-nums font-semibold text-foreground">{fmtY(ys[at]!)}</div>
          <div className="tabular-nums text-muted-foreground">{fmtX(xs[at]!)}</div>
        </div>
      )}
    </div>
  );
}

/** a meter: how much of something is used, the limit marked */
export function Meter({
  value,
  limit,
  tone = "sky",
  className,
}: {
  value: number;
  limit?: number;
  tone?: "sky" | "gold" | "clay" | "moss";
  className?: string;
}) {
  const fill = { sky: "bg-sky", gold: "bg-gold", clay: "bg-clay", moss: "bg-moss" }[tone];
  const track = { sky: "bg-sky/15", gold: "bg-gold/15", clay: "bg-clay/15", moss: "bg-moss/15" }[tone];
  return (
    <span className={cn("relative block h-1.5 w-full rounded-full", track, className)} aria-hidden="true">
      <span className={cn("absolute inset-y-0 left-0 rounded-full", fill)} style={{ width: `${Math.max(2, Math.min(1, value) * 100)}%` }} />
      {limit !== undefined && limit < 1 && (
        <span className="absolute -inset-y-1 w-0.5 rounded-full bg-foreground/70" style={{ left: `calc(${limit * 100}% - 1px)` }} />
      )}
    </span>
  );
}
