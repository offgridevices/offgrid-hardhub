// What the board tests simulated, drawn from the test report: the board and
// its layers, the heat map at each outside temperature, the power tree and
// the supply simulations, and each part's stress against its rating. Its own
// chunk, loaded after the checklist has painted.
import { memo, useEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import type { Artifact, BoardGeometry, Design, TestReport } from "@hardhub/protocol";
import { BoxIcon, GaugeIcon, ThermometerIcon, ZapIcon } from "lucide-react";
import { useGeometry } from "../../lib/use-geometry";
import { useResolvedTheme } from "../../lib/theme";
import { cellAt, heatField, heatGradient, heatLut, paint } from "../../lib/heat";
import { layerName } from "../../lib/layers";
import { num, withUnit } from "../../lib/tests";
import { si } from "../../lib/scales";
import { footprintSize } from "../../workers/geometry";
import { LineChart, Meter, useWidth } from "./charts";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/utils";

type Thermal = NonNullable<TestReport["thermal"]>;

export default function Simulations({
  report,
  design,
  artifacts,
  fileUrl,
  onOpen3d,
}: {
  report: TestReport;
  design: Design;
  artifacts: Artifact[];
  fileUrl(u: string): string;
  onOpen3d(): void;
}) {
  const { geo } = useGeometry(
    artifacts.find((a) => a.kind === "board-json"),
    fileUrl,
  );
  const pdn = report.power.pdn.map(asPdn).filter((c): c is Pdn => !!c);
  const step = report.power.step.map(asStep).filter((c): c is Step => !!c);
  return (
    <div className="flex flex-col gap-6" data-testid="simulations">
      <h2 className="px-1 text-lg font-semibold tracking-tight">What we simulated</h2>
      <BoardCard board={report.board} onOpen3d={onOpen3d} />
      {report.thermal && <HeatCard thermal={report.thermal} design={design} geo={geo} board={report.board} />}
      {(report.power.tree.length > 0 || report.power.drop.length > 0 || pdn.length > 0 || step.length > 0) && (
        <Card title="Power" icon={<ZapIcon />} testId="power" sub="Which supply feeds what, how much it carries, and how steady it stays.">
          <PowerTree tree={report.power.tree} />
          {report.power.drop.length > 0 && <Drops drop={report.power.drop} />}
          <div className="grid gap-6 lg:grid-cols-2">
            {pdn.length > 0 && <PdnChart curves={pdn} />}
            {step.length > 0 && <StepChart curves={step} />}
          </div>
        </Card>
      )}
      {report.stress.length > 0 && <Ratings stress={report.stress} design={design} />}
      <p className="px-1 text-xs text-muted-foreground">
        Made {new Date(report.made_at).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })}
        {Object.keys(report.tools).length > 0 && ` with ${Object.entries(report.tools).map(([k, v]) => `${TOOL[k] ?? k} ${v}`).join(", ")}`}.
      </p>
    </div>
  );
}

const TOOL: Record<string, string> = { kicad: "KiCad", ngspice: "ngspice", sim: "HardHub solver" };

function Card({ title, sub, icon, aside, children, testId }: { title: string; sub?: string; icon: React.ReactNode; aside?: React.ReactNode; children: React.ReactNode; testId?: string }) {
  return (
    <section className="flex min-w-0 flex-col gap-4 rounded-2xl border bg-card p-4 sm:p-5" aria-label={title} data-testid={testId}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-0.5">
          <h3 className="flex items-center gap-2 font-semibold [&_svg]:size-4 [&_svg]:text-muted-foreground">
            {icon}
            {title}
          </h3>
          {sub && <p className="text-sm text-muted-foreground">{sub}</p>}
        </div>
        {aside}
      </div>
      {children}
    </section>
  );
}

/* ---------- the board and its layers ---------- */

const STACK_STYLE: Record<string, { h: number; bg: string }> = {
  silk: { h: 4, bg: "var(--silk)" },
  mask: { h: 6, bg: "color-mix(in oklab, var(--moss) 70%, var(--card))" },
  paste: { h: 4, bg: "#b9b0a0" },
  copper: { h: 8, bg: "var(--layer-top)" },
  dielectric: { h: 30, bg: "color-mix(in oklab, #c9a86a 55%, var(--card))" },
};
const thick = (mm?: number) => (mm === undefined ? "" : mm < 0.1 ? `${num(mm * 1000)} µm` : `${num(mm)} mm`);

function BoardCard({ board, onOpen3d }: { board: TestReport["board"]; onOpen3d(): void }) {
  const copper = board.stackup.filter((l) => l.kind === "copper");
  const layers = board.layers || copper.length;
  return (
    <section className="grid gap-5 rounded-2xl border bg-card p-4 sm:grid-cols-[minmax(0,13rem)_1fr] sm:p-5" aria-label="The board" data-testid="board-summary">
      <div className="flex flex-col gap-3">
        <div className="flex items-baseline gap-2">
          <span className="text-5xl font-semibold tracking-tight">{layers}</span>
          <span className="text-lg font-medium">copper layers</span>
        </div>
        <p className="text-sm text-soft">
          <span className="num">
            {num(board.width)} × {num(board.height)}&nbsp;mm
          </span>
          , <span className="num">{num(board.thickness)}&nbsp;mm</span> thick
        </p>
        <p className="text-sm text-muted-foreground">
          {layers === 2
            ? "Copper on the top and the bottom, with the board material between them."
            : `Copper on the top, the bottom and ${layers - 2} layers inside, each separated by board material.`}
        </p>
        <Button variant="outline" size="sm" className="mt-auto w-fit" onClick={onOpen3d} data-testid="open-layers-3d">
          <BoxIcon />
          See the layers pulled apart in 3D
        </Button>
      </div>
      {board.stackup.length > 0 && (
        <ol className="flex flex-col" aria-label="Layers, top to bottom">
          {board.stackup.map((l, i) => {
            const st = STACK_STYLE[l.kind] ?? STACK_STYLE.dielectric!;
            const bg = l.kind === "copper" ? (l.name.startsWith("B.") ? "var(--layer-bottom)" : l.name.startsWith("F.") ? "var(--layer-top)" : "var(--layer-in1)") : st.bg;
            return (
              <li key={i} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 sm:grid-cols-[8rem_minmax(0,1fr)]">
                <span className="order-2 block rounded-[3px] sm:order-1" style={{ height: st.h, background: bg, marginBlock: 1 }} aria-hidden="true" />
                <span className="order-1 flex min-w-0 items-baseline gap-2 py-0.5 text-sm sm:order-2">
                  <span className={cn("truncate", l.kind === "copper" ? "font-medium" : "text-soft")}>{l.kind === "dielectric" ? `${l.material ?? "Board material"} core` : layerName(l.name)}</span>
                  <span className="num shrink-0 text-xs text-muted-foreground">{thick(l.thickness)}</span>
                  {l.role && l.kind === "copper" && <span className="hidden truncate text-xs text-muted-foreground sm:inline">{roleText(l.role)}</span>}
                </span>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
// "plane GND" -> "GND plane"
const roleText = (r: string) => (r.startsWith("plane") ? `${r.slice(5).trim()} plane`.trim() : r === "signal" ? "tracks" : r === "mixed" ? "tracks and pours" : r);

/* ---------- heat ---------- */

interface PartBox {
  ref: string;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}
/** part outlines in the report's frame (mm from the board centre): from the routed board, else from the design */
function partBoxes(design: Design, geo: BoardGeometry | null): PartBox[] {
  if (geo) {
    const cx = geo.size[0] / 2;
    const cy = geo.size[1] / 2;
    return geo.footprints.map((f) => ({ ref: f.ref, x0: f.bbox[0] - cx, y0: f.bbox[1] - cy, x1: f.bbox[2] - cx, y1: f.bbox[3] - cy }));
  }
  return design.components.flatMap((c) => {
    const p = design.placement[c.ref];
    const part = design.parts[c.part];
    if (!p || !part || p.side === "bottom") return [];
    const [w0, h0] = footprintSize(part.footprint, part.kind);
    const [w, h] = Math.round(p.rot / 90) % 2 ? [h0, w0] : [w0, h0];
    return [{ ref: c.ref, x0: p.x - w / 2, y0: p.y - h / 2, x1: p.x + w / 2, y1: p.y + h / 2 }];
  });
}
const describe = (design: Design, ref: string) => {
  const c = design.components.find((x) => x.ref === ref);
  const p = c ? design.parts[c.part] : undefined;
  return p?.value ?? p?.mpn ?? "";
};

function HeatCard({ thermal, design, geo, board }: { thermal: Thermal; design: Design; geo: BoardGeometry | null; board: TestReport["board"] }) {
  const mode = useResolvedTheme();
  const field = useMemo(() => heatField(thermal), [thermal]);
  const [mapIx, setMapIx] = useState(() => thermal.maps.length - 1);
  const ix = Math.min(mapIx, thermal.maps.length - 1);
  const map = thermal.maps[ix]!;
  const boxes = useMemo(() => partBoxes(design, geo), [design, geo]);
  return (
    <Card
      title={`Heat at ${num(map.ambient)} °C outside`}
      icon={<ThermometerIcon />}
      sub="The board working flat out: each part's own heat spreading through the copper and into the air."
      testId="heat"
      aside={
        thermal.maps.length > 1 && (
          <ToggleGroup type="single" value={String(ix)} onValueChange={(v) => v && setMapIx(Number(v))} aria-label="Outside temperature" className="h-8">
            {thermal.maps.map((m, i) => (
              <ToggleGroupItem key={i} value={String(i)} className="num px-2.5 text-xs" data-testid={`heat-ambient-${m.ambient}`}>
                {num(m.ambient)}&nbsp;°C
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        )
      }
    >
      <HeatMap field={field} ix={ix} map={map} boxes={boxes} design={design} mode={mode} labelled={thermal.parts.map((p) => p.ref)} board={board} />
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span className="num">{num(field.lo)}&nbsp;°C</span>
        <span className="h-2 w-40 rounded-full sm:w-56" style={{ background: heatGradient(mode) }} aria-hidden="true" />
        <span className="num">{num(field.hi)}&nbsp;°C</span>
        <span>· one scale for every outside temperature, so switching shows the board warm up</span>
      </div>
      <HotParts parts={thermal.parts} ambient={map.ambient} design={design} />
    </Card>
  );
}

const HeatMap = memo(function HeatMap({
  field,
  ix,
  map,
  boxes,
  design,
  mode,
  labelled,
  board,
}: {
  field: ReturnType<typeof heatField>;
  ix: number;
  map: Thermal["maps"][number];
  boxes: PartBox[];
  design: Design;
  mode: "light" | "dark";
  labelled: string[];
  board: TestReport["board"];
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [wrap, w] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<{ px: number; py: number; t: number; part: PartBox | null } | null>(null);
  const g = field.grid;
  const gw = g.nx * g.dx;
  const gh = g.ny * g.dy;
  // one pixel per cell; the browser smooths it as it scales up
  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    c.width = g.nx;
    c.height = g.ny;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    ctx.putImageData(new ImageData(paint(field, ix, heatLut(mode)) as Uint8ClampedArray<ArrayBuffer>, g.nx, g.ny), 0, 0);
  }, [field, ix, mode, g.nx, g.ny]);
  const show = new Set(labelled);
  const pxPerMm = w / gw || 1;
  const font = 10.5 / pxPerMm;
  const r = design.board?.corner_radius ?? 1;

  const point = (e: PointerEvent) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    const x = g.x0 + (px / rect.width) * gw;
    const y = g.y0 + (py / rect.height) * gh;
    const k = cellAt(g, x, y);
    const t = k >= 0 ? field.temps[ix]![k]! : NaN;
    if (Number.isNaN(t)) return setHover(null);
    // the smallest part under the pointer: a capacitor beside a module, not the module
    const under = boxes.filter((b) => x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1).sort((a, b) => (a.x1 - a.x0) * (a.y1 - a.y0) - (b.x1 - b.x0) * (b.y1 - b.y0))[0];
    setHover({ px, py, t, part: under ?? null });
  };

  return (
    <div className="mx-auto w-full max-w-2xl">
      <div
        ref={wrap}
        className="relative w-full touch-pan-y"
        style={{ aspectRatio: `${gw} / ${gh}` }}
        onPointerMove={point}
        onPointerDown={point}
        onPointerLeave={() => setHover(null)}
        data-testid="heat-map"
      >
        <canvas ref={canvas} className="absolute inset-0 size-full" role="img" aria-label={`Heat map at ${num(map.ambient)} °C outside: ${num(map.min)} to ${num(map.max)} °C on the board`} />
        <svg className="pointer-events-none absolute inset-0 size-full" viewBox={`${g.x0} ${g.y0} ${gw} ${gh}`} aria-hidden="true">
          <rect x={-board.width / 2} y={-board.height / 2} width={board.width} height={board.height} rx={r} fill="none" stroke="var(--foreground)" strokeOpacity={0.5} strokeWidth={1.2 / pxPerMm} />
          {boxes.map((b) => (
            <rect
              key={b.ref}
              x={b.x0}
              y={b.y0}
              width={b.x1 - b.x0}
              height={b.y1 - b.y0}
              rx={0.2}
              fill="none"
              stroke="var(--foreground)"
              strokeOpacity={hover?.part?.ref === b.ref ? 0.95 : 0.4}
              strokeWidth={(hover?.part?.ref === b.ref ? 1.6 : 1) / pxPerMm}
            />
          ))}
          {w > 0 &&
            boxes
              .filter((b) => show.has(b.ref) && (b.x1 - b.x0) * pxPerMm > 14)
              .map((b) => (
                <text
                  key={b.ref}
                  x={(b.x0 + b.x1) / 2}
                  y={(b.y0 + b.y1) / 2}
                  dy="0.35em"
                  textAnchor="middle"
                  fontSize={font}
                  className="fill-foreground font-medium [paint-order:stroke]"
                  stroke="var(--card)"
                  strokeOpacity={0.85}
                  strokeWidth={3 / pxPerMm}
                >
                  {b.ref}
                </text>
              ))}
          {map.max_at && w > 0 && (
            <g>
              <circle cx={map.max_at[0]} cy={map.max_at[1]} r={5 / pxPerMm} fill="none" stroke="var(--foreground)" strokeWidth={2 / pxPerMm} />
              <text
                x={map.max_at[0] + 8 / pxPerMm}
                y={map.max_at[1] - 8 / pxPerMm}
                fontSize={font * 1.05}
                className="num fill-foreground font-semibold [paint-order:stroke]"
                stroke="var(--card)"
                strokeWidth={3 / pxPerMm}
              >
                {num(map.max)} °C
              </text>
            </g>
          )}
        </svg>
        {hover && (
          <div
            className={cn(
              "pointer-events-none absolute z-10 rounded-md border bg-popover px-2.5 py-1.5 text-xs shadow-lg shadow-black/25",
              hover.px > w * 0.6 ? "-translate-x-[calc(100%+12px)]" : "translate-x-3",
              "-translate-y-1/2",
            )}
            style={{ left: hover.px, top: hover.py }}
            role="status"
          >
            <div className="num font-semibold text-foreground">{num(hover.t)}&nbsp;°C</div>
            {hover.part && (
              <div className="text-muted-foreground">
                {hover.part.ref}
                {describe(design, hover.part.ref) && ` · ${describe(design, hover.part.ref)}`}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
});

function HotParts({ parts, ambient, design }: { parts: Thermal["parts"]; ambient: number; design: Design }) {
  const rows = parts
    .map((p) => {
      const t = p.temps.find((x) => x.ambient === ambient) ?? p.temps.at(-1);
      const temp = t?.junction ?? t?.board ?? ambient;
      return { p, t, temp, spare: p.temp_max !== undefined ? p.temp_max - (t?.board ?? temp) : null };
    })
    .sort((a, b) => (a.spare ?? 999) - (b.spare ?? 999))
    .slice(0, 8);
  return (
    <div className="flex flex-col gap-2">
      <h4 className="text-sm font-semibold">The warmest parts against their rating</h4>
      <ul className="divide-y rounded-xl border">
        {rows.map(({ p, t, spare }) => {
          const board = t?.board ?? ambient;
          const tone = spare === null ? "sky" : spare < 0 ? "clay" : spare < 5 ? "gold" : "sky";
          return (
            <li key={p.ref} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1.5 px-3 py-2.5 text-sm sm:grid-cols-[minmax(0,12rem)_minmax(0,1fr)_auto]">
              <span className="flex min-w-0 items-baseline gap-2">
                <span className="font-medium">{p.ref}</span>
                <span className="truncate text-muted-foreground">{describe(design, p.ref)}</span>
                {p.assumed && (
                  <Badge tone="outline" className="shrink-0" title="The rating or the heat is a typical value, not from the datasheet">
                    assumed
                  </Badge>
                )}
              </span>
              <span className="num text-right text-xs text-soft sm:order-3">
                <span className="font-medium text-foreground">{num(board)}&nbsp;°C</span>
                {p.temp_max !== undefined && <span className="text-muted-foreground"> of {num(p.temp_max)}</span>}
                {t?.junction !== undefined && <span className="block text-muted-foreground">inside {num(t.junction)}&nbsp;°C</span>}
              </span>
              <span className="col-span-2 flex items-center gap-3 sm:order-2 sm:col-span-1">
                <Meter value={p.temp_max ? board / Math.max(p.temp_max * 1.15, board) : 0.5} limit={p.temp_max ? p.temp_max / Math.max(p.temp_max * 1.15, board) : undefined} tone={tone} />
                <span className={cn("num w-24 shrink-0 text-xs", spare !== null && spare < 0 ? "text-clay-text" : "text-muted-foreground")}>
                  {spare === null ? (p.power > 0 ? `${si(p.power, "W")}` : "") : spare < 0 ? `${num(-spare)} °C over` : `${num(spare)} °C to spare`}
                </span>
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/* ---------- power ---------- */

function PowerTree({ tree }: { tree: TestReport["power"]["tree"] }) {
  if (!tree.length) return null;
  const nets = new Set(tree.map((n) => n.net));
  const roots = tree.filter((n) => !n.from || !nets.has(n.from));
  const kids = (net: string) => tree.filter((n) => n.from === net);
  const row = (n: (typeof tree)[number], depth: number): React.ReactNode => {
    const share = n.load !== undefined && n.capacity ? n.load / n.capacity : null;
    const tone = share === null ? "sky" : share > 1 ? "clay" : share > 0.8 ? "gold" : "sky";
    return (
      <li key={n.net} className="flex flex-col">
        <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1.5 py-2 sm:grid-cols-[minmax(0,14rem)_minmax(0,1fr)_auto]" style={{ paddingLeft: depth * 20 }}>
          <span className="flex min-w-0 items-baseline gap-2">
            {depth > 0 && <span className="text-muted-foreground" aria-hidden="true">└</span>}
            <span className="font-medium">{n.net}</span>
            {n.voltage !== undefined && <span className="num text-soft">{num(n.voltage)}&nbsp;V</span>}
            {n.source && <span className="truncate text-xs text-muted-foreground">from {n.source}</span>}
          </span>
          <span className="num text-right text-xs text-soft sm:order-3">
            {n.load !== undefined && <span className="font-medium text-foreground">{num(n.load)}&nbsp;A</span>}
            {n.capacity !== undefined && <span className="text-muted-foreground"> of {num(n.capacity)}</span>}
          </span>
          {share !== null && (
            <span className="col-span-2 flex items-center gap-3 sm:order-2 sm:col-span-1">
              <Meter value={share} tone={tone} />
              <span className="num w-10 shrink-0 text-right text-xs text-muted-foreground">{Math.round(share * 100)}&nbsp;%</span>
            </span>
          )}
        </div>
        {kids(n.net).length > 0 && <ul>{kids(n.net).map((k) => row(k, depth + 1))}</ul>}
      </li>
    );
  };
  return (
    <div className="flex flex-col gap-1">
      <h4 className="text-sm font-semibold">Power tree</h4>
      <p className="text-xs text-muted-foreground">Each supply, what feeds it, and how much of what it can give is used.</p>
      <ul className="mt-1 divide-y border-y">{roots.map((r) => row(r, 0))}</ul>
    </div>
  );
}

function Drops({ drop }: { drop: TestReport["power"]["drop"] }) {
  return (
    <div className="flex flex-col gap-2">
      <h4 className="text-sm font-semibold">Voltage lost in the copper</h4>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[22rem] text-sm">
          <thead className="text-left text-xs text-muted-foreground">
            <tr className="border-b">
              <th className="py-1.5 pr-3 font-medium">Supply</th>
              <th className="py-1.5 pr-3 font-medium">Furthest load</th>
              <th className="py-1.5 pr-3 text-right font-medium">Lost</th>
              <th className="py-1.5 text-right font-medium">Copper</th>
            </tr>
          </thead>
          <tbody className="num">
            {drop.map((d) => {
              const worst = [...d.sinks].sort((a, b) => b.drop_mv - a.drop_mv)[0];
              return (
                <tr key={d.net} className="border-b last:border-0">
                  <td className="py-2 pr-3 font-sans font-medium">
                    {d.net}
                    {d.source && <span className="font-normal text-muted-foreground"> from {d.source}</span>}
                  </td>
                  <td className="py-2 pr-3 font-sans">{worst?.ref ?? "–"}</td>
                  <td className="py-2 pr-3 text-right">
                    {num(d.worst_mv)}&nbsp;mV <span className="text-muted-foreground">({num(d.pct)}&nbsp;%)</span>
                  </td>
                  <td className="py-2 text-right text-muted-foreground">{d.resistance_mohm !== undefined ? `${num(d.resistance_mohm)} mΩ` : "–"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

interface Pdn {
  net: string;
  target: number;
  f: number[];
  z: number[];
  caps: string[];
}
interface Step {
  net: string;
  t: number[];
  v: number[];
  min: number;
  nominal: number;
}
const nums = (v: unknown): number[] | null => (Array.isArray(v) && v.every((x) => typeof x === "number") ? (v as number[]) : null);
function asPdn(c: TestReport["power"]["pdn"][number]): Pdn | null {
  const f = nums(c.f);
  const z = nums(c.z);
  if (!f || !z || f.length < 2 || f.length !== z.length) return null;
  return { net: c.net, target: Number(c.target_ohm) || 0, f, z, caps: Array.isArray(c.caps) ? (c.caps as string[]) : [] };
}
function asStep(c: TestReport["power"]["step"][number]): Step | null {
  const t = nums(c.t_us);
  const v = nums(c.v);
  if (!t || !v || t.length < 2 || t.length !== v.length) return null;
  return { net: c.net, t, v, min: Number(c.min_v ?? Math.min(...v)), nominal: Number(c.nominal ?? v[0]) };
}

function NetPicker({ nets, value, onChange, label }: { nets: string[]; value: number; onChange(i: number): void; label: string }) {
  if (nets.length < 2) return null;
  return (
    <ToggleGroup type="single" value={String(value)} onValueChange={(v) => v && onChange(Number(v))} aria-label={label} className="h-7">
      {nets.map((n, i) => (
        <ToggleGroupItem key={n} value={String(i)} className="px-2 text-xs">
          {n}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}

function PdnChart({ curves }: { curves: Pdn[] }) {
  const [i, setI] = useState(0);
  const c = curves[Math.min(i, curves.length - 1)]!;
  const peak = c.z.indexOf(Math.max(...c.z));
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-sm font-semibold">How steady {c.net} stays, slow to fast</h4>
        <NetPicker nets={curves.map((x) => x.net)} value={i} onChange={setI} label="Supply" />
      </div>
      <p className="text-xs text-muted-foreground">
        Impedance from 1&nbsp;kHz to 100&nbsp;MHz: lower is steadier. It should stay under the target line{c.caps.length ? `; capacitors ${c.caps.join(", ")}` : ""}.
      </p>
      <LineChart
        xs={c.f}
        ys={c.z}
        xLog
        yLog
        fmtX={(v) => si(v, "Hz")}
        fmtY={(v) => si(v, "Ω")}
        refs={c.target ? [{ y: c.target, label: `target ${si(c.target, "Ω")}` }] : []}
        mark={{ x: c.f[peak]!, y: c.z[peak]!, label: `highest ${si(c.z[peak]!, "Ω")}` }}
        label={`Impedance of ${c.net} against frequency; highest ${si(c.z[peak]!, "Ω")} at ${si(c.f[peak]!, "Hz")}, target ${si(c.target, "Ω")}`}
      />
    </div>
  );
}

function StepChart({ curves }: { curves: Step[] }) {
  const [i, setI] = useState(0);
  const c = curves[Math.min(i, curves.length - 1)]!;
  const lowest = c.v.indexOf(Math.min(...c.v));
  const floor = c.nominal * 0.95;
  const lo = Math.min(floor, c.min) - c.nominal * 0.01;
  const hi = c.nominal + c.nominal * 0.015;
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-sm font-semibold">When the load jumps</h4>
        <NetPicker nets={curves.map((x) => x.net)} value={i} onChange={setI} label="Supply" />
      </div>
      <p className="text-xs text-muted-foreground">
        {c.net} as the board suddenly draws ten times more (the radio starting to send). It must stay above the −5&nbsp;% line.
      </p>
      <LineChart
        xs={c.t}
        ys={c.v}
        yDomain={[lo, hi]}
        fmtX={(v) => `${num(v)} µs`}
        fmtY={(v) => `${num(v)} V`}
        refs={[
          { y: c.nominal, label: `${num(c.nominal)} V` },
          { y: floor, label: `−5 % · ${num(floor)} V` },
        ]}
        mark={{ x: c.t[lowest]!, y: c.v[lowest]!, label: `lowest ${num(c.v[lowest]!)} V` }}
        label={`${c.net} during a load step; lowest ${num(c.min)} V, limit ${num(floor)} V`}
      />
    </div>
  );
}

/* ---------- part ratings ---------- */

const WHAT: Record<string, { label: string; unit: string }> = {
  voltage: { label: "Voltage", unit: "V" },
  power: { label: "Power", unit: "W" },
  current: { label: "Current", unit: "A" },
};

function Ratings({ stress, design }: { stress: TestReport["stress"]; design: Design }) {
  const rows = [...stress].sort((a, b) => b.pct / (b.limit_pct ?? 100) - a.pct / (a.limit_pct ?? 100));
  // one scale for every bar: 0 to a little past the largest share or limit
  const top = Math.max(100, ...rows.map((r) => Math.max(r.pct, r.limit_pct ?? 0))) * 1.05;
  return (
    <Card title="Part ratings" icon={<GaugeIcon />} sub="How hard each part works, as a share of what its datasheet allows. The mark is the most we allow, with room to spare." testId="ratings">
      <ul className="divide-y rounded-xl border">
        {rows.map((r, i) => {
          const w = WHAT[r.what] ?? { label: r.what, unit: "" };
          const limit = r.limit_pct ?? 100;
          const tone = r.pct > 100 ? "clay" : r.pct > limit ? "gold" : "sky";
          const fmt = (v: number) => (w.unit === "W" || (w.unit === "A" && v < 0.1) ? si(v, w.unit) : withUnit(v, w.unit));
          return (
            <li key={`${r.ref}-${r.what}-${i}`} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1.5 px-3 py-2.5 text-sm sm:grid-cols-[minmax(0,13rem)_minmax(0,1fr)_auto]">
              <span className="flex min-w-0 flex-col">
                <span className="flex min-w-0 items-baseline gap-2">
                  <span className="font-medium">{r.ref}</span>
                  <span className="truncate text-muted-foreground">
                    {w.label.toLowerCase()} · {describe(design, r.ref)}
                  </span>
                </span>
                {r.note && <span className="text-xs text-muted-foreground">{r.note}</span>}
              </span>
              <span className="num text-right text-xs sm:order-3">
                <span className="font-medium text-foreground">{fmt(r.value)}</span>
                <span className="text-muted-foreground"> of {fmt(r.rating)}</span>
              </span>
              <span className="col-span-2 flex items-center gap-3 sm:order-2 sm:col-span-1">
                <Meter value={r.pct / top} limit={limit / top} tone={tone} />
                <span className={cn("num w-10 shrink-0 text-right text-xs", r.pct > limit ? "text-gold-text" : "text-muted-foreground")}>{num(r.pct)}&nbsp;%</span>
              </span>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
