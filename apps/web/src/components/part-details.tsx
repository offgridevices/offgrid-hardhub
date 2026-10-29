// One part, everything an engineer looks for: what it is and does, its
// package, where it sits in the circuit, what it costs and whether it can be
// bought. Shared by the parts list and the schematic.
import type { Design } from "@hardhub/protocol";
import { ExternalLinkIcon } from "lucide-react";
import { date, int, usd } from "../lib/format";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

export const LIFE = {
  active: { label: "In production", tone: "moss" },
  nrnd: { label: "Not for new designs", tone: "gold" },
  eol: { label: "End of life", tone: "clay" },
  unknown: { label: "Status unknown", tone: "neutral" },
} as const;
export const TIER: Record<string, string> = { basic: "Basic", preferred: "Preferred", extended: "Extended" };

const natural = (a: string, b: string) => a.localeCompare(b, "en", { numeric: true });

/** The footprint's own name, without its library: "SOT-23-5" from "Package_TO_SOT_SMD:SOT-23-5". */
export const footprintName = (fp: string) => fp.split(":")[1]?.replace(/_/g, " ") ?? fp;

export function PartDetails({ design, partKey, refName }: { design: Design; partKey: string; refName?: string }) {
  const p = design.parts[partKey];
  if (!p) return null;
  const refs = design.components.filter((c) => c.part === partKey).map((c) => c.ref).sort(natural);
  const comp = refName ? design.components.find((c) => c.ref === refName) : undefined;
  const block = comp ? design.blocks[comp.block] : undefined;
  const pins = comp ? Object.entries(comp.pins).sort(([a], [b]) => natural(a, b)) : [];
  const s = p.sourcing;
  const life = LIFE[p.lifecycle];
  return (
    <div className="flex flex-col gap-4 text-sm">
      <div className="flex flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          {refName && <span className="num rounded-md bg-ember/15 px-1.5 py-0.5 text-xs font-medium text-ember-text">{refName}</span>}
          <span className="text-base font-semibold">{p.value ?? p.mpn}</span>
        </div>
        <span className="text-muted-foreground">
          {p.mpn} · {p.maker}
        </span>
      </div>
      <p className="text-soft">{p.description}</p>
      {block && (
        <p className="text-xs text-muted-foreground">
          Part of <span className="text-foreground">{block.name}</span>: {block.purpose}
        </p>
      )}
      <dl className="grid grid-cols-[7rem_1fr] gap-x-3 gap-y-2 border-t pt-4">
        <dt className="text-muted-foreground">Package</dt>
        <dd className="num min-w-0 break-words">{footprintName(p.footprint)}</dd>
        <dt className="text-muted-foreground">Used as</dt>
        <dd className="num min-w-0 break-words">{refs.join(" ")}</dd>
        <dt className="text-muted-foreground">Status</dt>
        <dd>
          <Badge tone={life.tone}>{life.label}</Badge>
        </dd>
        {s?.lcsc && (
          <>
            <dt className="text-muted-foreground">LCSC</dt>
            <dd className="num">
              {s.lcsc}
              {s.tier && <span className="ml-2 font-sans text-xs text-muted-foreground">{TIER[s.tier]}</span>}
            </dd>
          </>
        )}
        {s?.stock !== undefined && (
          <>
            <dt className="text-muted-foreground">Stock</dt>
            <dd>
              <Badge tone={s.stock > 1000 ? "moss" : s.stock > 0 ? "gold" : "clay"}>{s.stock > 0 ? `${int(s.stock)} in stock` : "Out of stock"}</Badge>
            </dd>
          </>
        )}
        {!p.assembled && (
          <>
            <dt className="text-muted-foreground">Fitting</dt>
            <dd>By hand, not by the fab</dd>
          </>
        )}
      </dl>
      {s && s.prices.length > 0 && (
        <div className="flex flex-col gap-2 border-t pt-4">
          <span className="text-xs font-medium text-muted-foreground">Price each{s.checked_at ? ` · read ${date(s.checked_at)}` : ""}</span>
          <div className="flex flex-wrap gap-1.5">
            {s.prices.slice(0, 5).map((b) => (
              <span key={b.qty} className="num rounded-md bg-sunken px-2 py-1 text-xs">
                <span className="text-muted-foreground">{b.qty}+ </span>
                {usd(b.usd, b.usd < 0.1 ? 3 : 2)}
              </span>
            ))}
          </div>
        </div>
      )}
      {pins.length > 0 && (
        <div className="flex flex-col gap-2 border-t pt-4">
          <span className="text-xs font-medium text-muted-foreground">Pins · {pins.filter(([, n]) => n).length} of {pins.length} connected</span>
          <div className="grid max-h-56 grid-cols-[3rem_1fr] gap-x-3 gap-y-1 overflow-y-auto pr-1 text-xs">
            {pins.map(([pad, net]) => (
              <div key={pad} className="contents">
                <span className="num text-muted-foreground">{pad}</span>
                <span className={net ? "num" : "text-muted-foreground"}>{net ?? "not connected"}</span>
              </div>
            ))}
          </div>
        </div>
      )}
      {p.datasheet && (
        <Button variant="outline" size="sm" asChild className="self-start">
          <a href={p.datasheet} target="_blank" rel="noreferrer">
            Datasheet
            <ExternalLinkIcon />
          </a>
        </Button>
      )}
    </div>
  );
}
