// The schematic: the whole circuit on one sheet, block by block, drawn the
// way engineers draw them. Every pin ends in a power or ground symbol, a net
// label (the same label means the same wire), or a cross when it is left
// open. Click a part for its details, a label to light up its whole net.
import { memo, useMemo, useRef, useState, type FormEvent } from "react";
import type { Design } from "@hardhub/protocol";
import { DownloadIcon, SearchIcon, XIcon } from "lucide-react";
import { layoutSheet, labelWidth, type SPin, type SSym } from "../lib/schematic";
import { usePanZoom } from "../lib/pan-zoom";
import { Empty } from "../components/pane";
import { PartDetails } from "../components/part-details";
import { BarRule, ViewBar, ZoomControls } from "../components/viewer-ui";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

// paper colours: a schematic is printed on light paper in either theme
const C = {
  paper: "#f4efe3",
  frame: "#c9bda6",
  ink: "#3a2e22",
  body: "#8a3a00",
  bodyFill: "#fdf3e1",
  wire: "#2f5a28",
  label: "#234a7a",
  labelFill: "#e6edf6",
  hot: "#ff6a00",
  hotFill: "#ffe0c4",
  muted: "#7a705f",
};

function PinEnd({ p, hot, onNet }: { p: SPin; hot: boolean; onNet(n: string): void }) {
  const { x, y, dir } = p;
  if (p.end === "open")
    return <path d={`M${x - 4} ${y - 4}L${x + 4} ${y + 4}M${x + 4} ${y - 4}L${x - 4} ${y + 4}`} stroke={C.muted} strokeWidth={1.4} />;
  if (p.end === "ground") {
    const s = dir === "u" ? -1 : 1;
    return (
      <g stroke={hot ? C.hot : C.ink} strokeWidth={1.6} className="cursor-pointer" onClick={() => onNet(p.net!)}>
        <path d={`M${x - 10} ${y}H${x + 10}M${x - 6} ${y + 4 * s}H${x + 6}M${x - 2} ${y + 8 * s}H${x + 2}`} />
        <rect x={x - 12} y={Math.min(y, y + 10 * s)} width={24} height={10} fill="transparent" stroke="none" />
      </g>
    );
  }
  if (p.end === "power") {
    const up = dir !== "d";
    return (
      <g className="cursor-pointer" onClick={() => onNet(p.net!)}>
        <path d={`M${x - 10} ${y}H${x + 10}`} stroke={hot ? C.hot : C.ink} strokeWidth={1.8} />
        <text x={x} y={up ? y - 6 : y + 14} textAnchor="middle" fontSize={10} fontWeight={600} fill={hot ? C.hot : C.ink}>
          {p.net}
        </text>
      </g>
    );
  }
  const n = p.net!;
  const w = labelWidth(n);
  const fill = hot ? C.hotFill : C.labelFill;
  const stroke = hot ? C.hot : C.label;
  let shape: string;
  let tx: number;
  let ty = y + 3.5;
  if (dir === "l") {
    shape = `M${x} ${y}L${x - 6} ${y - 7}H${x - w}V${y + 7}H${x - 6}Z`;
    tx = x - w / 2 - 3;
  } else if (dir === "r") {
    shape = `M${x} ${y}L${x + 6} ${y - 7}H${x + w}V${y + 7}H${x + 6}Z`;
    tx = x + w / 2 + 3;
  } else if (dir === "u") {
    shape = `M${x} ${y}V${y - 2}M${x - w / 2} ${y - 16}H${x + w / 2}V${y - 2}H${x - w / 2}Z`;
    tx = x;
    ty = y - 6;
  } else {
    shape = `M${x} ${y}V${y + 2}M${x - w / 2} ${y + 2}H${x + w / 2}V${y + 16}H${x - w / 2}Z`;
    tx = x;
    ty = y + 12.5;
  }
  return (
    <g className="cursor-pointer" onClick={() => onNet(n)} data-net={n}>
      <path d={shape} fill={fill} stroke={stroke} strokeWidth={1.2} />
      <text x={tx} y={ty} textAnchor="middle" fontSize={10} fill={stroke} fontWeight={hot ? 600 : 500}>
        {n}
      </text>
    </g>
  );
}

function Body({ s }: { s: SSym }) {
  const { x, y } = s;
  const sw = 1.6;
  switch (s.shape) {
    case "box":
      return <rect x={x} y={y} width={s.w} height={s.h} fill={C.bodyFill} stroke={C.body} strokeWidth={sw} />;
    case "res":
      return <path d={`M${x} ${y}v4l6 4-12 6 12 6-12 6 12 6-6 4v4`} fill="none" stroke={C.body} strokeWidth={sw} strokeLinejoin="round" />;
    case "cap":
      return <path d={`M${x} ${y}v16M${x - 11} ${y + 16}h22M${x - 11} ${y + 24}h22M${x} ${y + 24}v16`} fill="none" stroke={C.body} strokeWidth={sw} />;
    case "ind":
      return <path d={`M${x} ${y}v4a4 4 0 0 1 0 8a4 4 0 0 1 0 8a4 4 0 0 1 0 8a4 4 0 0 1 0 8v4`} fill="none" stroke={C.body} strokeWidth={sw} />;
    case "fuse":
      return (
        <g fill="none" stroke={C.body} strokeWidth={sw}>
          <rect x={x - 5} y={y + 6} width={10} height={28} fill={C.bodyFill} />
          <path d={`M${x} ${y}V${y + 40}`} />
        </g>
      );
    case "xtal":
      return (
        <g fill="none" stroke={C.body} strokeWidth={sw}>
          <path d={`M${x} ${y}v8M${x - 10} ${y + 8}h20M${x - 10} ${y + 32}h20M${x} ${y + 32}v8`} />
          <rect x={x - 7} y={y + 13} width={14} height={14} fill={C.bodyFill} />
        </g>
      );
    case "diode":
    case "led":
      return (
        <g stroke={C.body} strokeWidth={sw} fill="none" strokeLinejoin="round">
          <path d={`M${x} ${y}v12M${x} ${y + 26}v14M${x - 9} ${y + 26}h18`} />
          <path d={`M${x - 9} ${y + 12}h18l-9 14z`} fill={C.bodyFill} />
          {s.shape === "led" && <path d={`M${x + 11} ${y + 14}l7 -5m-3 0h3v3M${x + 11} ${y + 21}l7 -5m-3 0h3v3`} strokeWidth={1.2} />}
        </g>
      );
  }
}

const Symbol = memo(function Symbol({
  s,
  selected,
  net,
  onPick,
  onNet,
}: {
  s: SSym;
  selected: boolean;
  net: string | null;
  onPick(ref: string): void;
  onNet(n: string): void;
}) {
  const box = s.shape === "box";
  return (
    <g data-ref={s.ref}>
      {selected && (
        <rect
          x={s.bounds[0] - 6}
          y={s.bounds[1] - 6}
          width={s.bounds[2] - s.bounds[0] + 12}
          height={s.bounds[3] - s.bounds[1] + 12}
          rx={8}
          fill="rgba(255,106,0,0.07)"
          stroke={C.hot}
          strokeWidth={1.2}
          strokeDasharray="4 3"
        />
      )}
      {s.pins.map((p) => (
        <g key={p.pad}>
          <path d={`M${p.bx} ${p.by}L${p.x} ${p.y}`} stroke={p.end === "label" || p.end === "open" ? C.wire : C.body} strokeWidth={1.4} />
          {box && (
            <text
              x={p.dir === "l" ? p.bx + 4 : p.dir === "r" ? p.bx - 4 : p.bx}
              y={p.dir === "u" ? p.by + 12 : p.dir === "d" ? p.by - 5 : p.by + 3.5}
              textAnchor={p.dir === "l" ? "start" : p.dir === "r" ? "end" : "middle"}
              fontSize={8.5}
              fill={C.muted}
            >
              {p.pad}
            </text>
          )}
          <PinEnd p={p} hot={!!net && p.net === net} onNet={onNet} />
        </g>
      ))}
      <g
        className="cursor-pointer outline-none focus-visible:[&>*]:stroke-[#ff6a00]"
        role="button"
        tabIndex={0}
        aria-label={`${s.ref}, ${s.value}`}
        onClick={() => onPick(s.ref)}
        onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), onPick(s.ref))}
      >
        <Body s={s} />
        {box ? (
          <>
            <text x={s.x + s.w / 2} y={s.y + s.h / 2 - 2} textAnchor="middle" fontSize={12} fontWeight={700} fill={C.ink}>
              {s.ref}
            </text>
            <text x={s.x + s.w / 2} y={s.y + s.h / 2 + 12} textAnchor="middle" fontSize={9.5} fill={C.muted}>
              {s.value.length > 22 ? s.value.slice(0, 21) + "…" : s.value}
            </text>
          </>
        ) : (
          <>
            <rect x={s.x - 12} y={s.y} width={24} height={40} fill="transparent" />
            <text x={s.x + 14} y={s.y + 17} fontSize={11} fontWeight={700} fill={C.ink}>
              {s.ref}
            </text>
            <text x={s.x + 14} y={s.y + 30} fontSize={9.5} fill={C.muted}>
              {s.value.length > 16 ? s.value.slice(0, 15) + "…" : s.value}
            </text>
          </>
        )}
      </g>
    </g>
  );
});

export default function Circuit({ design }: { design: Design }) {
  const sheet = useMemo(() => layoutSheet(design), [design]);
  const box = useRef<HTMLDivElement>(null);
  const stage = useRef<SVGGElement>(null);
  const svg = useRef<SVGSVGElement>(null);
  const pz = usePanZoom({ box, stage, width: sheet.w, height: sheet.h, pad: 16, max: 8, enabled: sheet.blocks.length > 0 });
  const [picked, setPicked] = useState<string | null>(null);
  const [net, setNet] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [block, setBlock] = useState("all");
  const [miss, setMiss] = useState(false);

  const comp = picked ? design.components.find((c) => c.ref === picked) : undefined;
  const syms = useMemo(() => new Map(sheet.blocks.flatMap((b) => b.syms.map((s) => [s.ref, s] as const))), [sheet]);
  const netCount = sheet.nets.size;

  const pick = (ref: string) => {
    setPicked(ref);
    setNet(null);
  };
  const onNet = (n: string) => {
    setNet((cur) => (cur === n ? null : n));
  };
  const find = (e: FormEvent) => {
    e.preventDefault();
    const q = query.trim().toUpperCase();
    if (!q) return;
    const s = syms.get(q) ?? [...syms.values()].find((x) => x.value.toUpperCase().includes(q));
    if (s) {
      pick(s.ref);
      setMiss(false);
      const [x0, y0, x1, y1] = s.bounds;
      pz.fitTo(x0 - 360, y0 - 200, x1 - x0 + 720, y1 - y0 + 400);
    } else if (sheet.nets.has(q) || [...sheet.nets.keys()].some((k) => k.toUpperCase() === q)) {
      setNet([...sheet.nets.keys()].find((k) => k.toUpperCase() === q)!);
      setMiss(false);
    } else setMiss(true);
  };
  const showBlock = (id: string) => {
    setBlock(id);
    const b = sheet.blocks.find((x) => x.id === id);
    if (b) pz.fitTo(b.x - 20, b.y - 20, b.w + 40, b.h + 40);
    else pz.fit();
  };
  const download = () => {
    const el = svg.current;
    const g = stage.current;
    if (!el || !g) return;
    const copy = el.cloneNode(true) as SVGSVGElement;
    copy.setAttribute("viewBox", `0 0 ${sheet.w} ${sheet.h}`);
    copy.setAttribute("width", String(sheet.w));
    copy.setAttribute("height", String(sheet.h));
    copy.querySelector("g[data-stage]")?.removeAttribute("transform");
    const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(copy)], { type: "image/svg+xml" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `${design.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-schematic.svg`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  if (sheet.blocks.length === 0)
    return <Empty title="No circuit yet">Once the parts are chosen, HardHub wires every pin from the datasheets and draws the schematic here, block by block.</Empty>;

  const members = net ? sheet.nets.get(net) ?? [] : [];

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-testid="schematic">
      <ViewBar>
        <Select value={block} onValueChange={showBlock}>
          <SelectTrigger className="h-8 w-auto min-w-40 max-w-64" aria-label="Show">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Whole board</SelectItem>
            {sheet.blocks.map((b) => (
              <SelectItem key={b.id} value={b.id}>
                {b.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <form onSubmit={find} className="relative">
          <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
          <Input
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setMiss(false);
            }}
            placeholder="Find U2, a value or a net"
            aria-label="Find a part or a net"
            aria-invalid={miss || undefined}
            className="h-8 w-52 pl-8"
          />
        </form>
        <BarRule />
        <span className="hidden text-xs text-muted-foreground md:inline">
          {design.components.length} parts · {netCount} nets · click a part for details, a label for its net
        </span>
        <span className="grow" />
        <Button variant="outline" size="sm" onClick={download}>
          <DownloadIcon />
          <span className="hidden sm:inline">Download</span>
        </Button>
      </ViewBar>

      <div ref={box} className="relative min-h-[420px] flex-1 cursor-grab touch-none overflow-hidden bg-[#2a251f] active:cursor-grabbing">
        <svg ref={svg} className="absolute inset-0 size-full select-none" role="img" aria-label={`Schematic of ${design.name}`} style={{ fontFamily: "'Geist Mono Variable', ui-monospace, monospace" }}>
          <g ref={stage} data-stage>
            <rect width={sheet.w} height={sheet.h} fill={C.paper} rx={4} />
            <rect x={14} y={14} width={sheet.w - 28} height={sheet.h - 28} fill="none" stroke={C.frame} />
            <rect x={24} y={24} width={sheet.w - 48} height={sheet.h - 48} fill="none" stroke={C.frame} />
            {Array.from({ length: Math.floor((sheet.w - 48) / 300) }, (_, i) => (
              <text key={i} x={24 + 150 + i * 300} y={21} textAnchor="middle" fontSize={8} fill={C.muted}>
                {i + 1}
              </text>
            ))}
            {Array.from({ length: Math.floor((sheet.h - 48) / 300) }, (_, i) => (
              <text key={i} x={19} y={24 + 150 + i * 300} textAnchor="middle" fontSize={8} fill={C.muted}>
                {String.fromCharCode(65 + i)}
              </text>
            ))}
            {sheet.blocks.map((b) => (
              <g key={b.id}>
                <rect x={b.x} y={b.y} width={b.w} height={b.h} rx={6} fill="none" stroke={block === b.id ? C.hot : "#b9ad97"} strokeDasharray="6 4" />
                <text x={b.x + 16} y={b.y + 24} fontSize={13} fontWeight={700} fill={C.ink} style={{ fontFamily: "'Geist Variable', sans-serif" }}>
                  {b.name}
                </text>
                <text x={b.x + 16} y={b.y + 39} fontSize={10} fill={C.muted} style={{ fontFamily: "'Geist Variable', sans-serif" }}>
                  {b.purpose.length > 110 ? b.purpose.slice(0, 109) + "…" : b.purpose}
                </text>
                {b.syms.map((s) => (
                  <Symbol key={s.ref} s={s} selected={picked === s.ref} net={net} onPick={pick} onNet={onNet} />
                ))}
              </g>
            ))}
            <g transform={`translate(${sheet.w - 24 - 300} ${sheet.h - 24 - 70})`}>
              <rect width={300} height={70} fill={C.paper} stroke={C.frame} />
              <path d="M0 34H300M190 34V70" stroke={C.frame} />
              <text x={12} y={23} fontSize={13} fontWeight={700} fill={C.ink} style={{ fontFamily: "'Geist Variable', sans-serif" }}>
                {design.name}
              </text>
              <text x={12} y={56} fontSize={9.5} fill={C.muted}>
                HardHub · sheet 1 of 1
              </text>
              <text x={202} y={56} fontSize={9.5} fill={C.muted}>
                {design.revision}
              </text>
            </g>
          </g>
        </svg>

        {comp && (
          <aside data-nopan className="absolute right-3 top-3 flex max-h-[calc(100%-1.5rem)] w-80 max-w-[calc(100%-1.5rem)] flex-col overflow-hidden rounded-xl border bg-popover shadow-2xl shadow-black/40" aria-label={`${comp.ref} details`} data-testid="part-details">
            <div className="flex items-center justify-between border-b px-4 py-2">
              <span className="text-xs font-medium text-muted-foreground">Part details</span>
              <Button variant="ghost" size="icon-sm" onClick={() => setPicked(null)} aria-label="Close">
                <XIcon />
              </Button>
            </div>
            <div className="overflow-y-auto p-4">
              <PartDetails design={design} partKey={comp.part} refName={comp.ref} />
            </div>
          </aside>
        )}

        {net && (
          <div data-nopan className="absolute bottom-3 left-3 flex max-w-[calc(100%-8rem)] items-center gap-2 rounded-lg border bg-popover px-3 py-2 text-sm shadow-xl shadow-black/30">
            <Badge tone="ember" className="num">
              {net}
            </Badge>
            <span className="min-w-0 truncate text-muted-foreground">
              {members.length} pins: {members.map((m) => `${m.ref}.${m.pad}`).join(", ")}
            </span>
            <Button variant="ghost" size="icon-sm" onClick={() => setNet(null)} aria-label="Clear the net">
              <XIcon />
            </Button>
          </div>
        )}

        <ZoomControls className="absolute bottom-3 right-3" onIn={() => pz.zoomBy(1.4)} onOut={() => pz.zoomBy(1 / 1.4)} onFit={() => showBlock("all")} />
      </div>
    </div>
  );
}
