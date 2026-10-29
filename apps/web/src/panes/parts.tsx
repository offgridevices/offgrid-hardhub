// Bill of materials: one line per part, with what it costs and whether it can
// be bought. Every price and stock figure carries the date it was read.
import { useMemo, useState } from "react";
import type { Design } from "@hardhub/protocol";
import { date, int, usd } from "../lib/format";
import { Empty, Pane, PaneHead, Section } from "../components/pane";
import { LIFE, PartDetails, TIER, footprintName } from "../components/part-details";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";

export default function Parts({ design }: { design: Design }) {
  const lines = useMemo(() => {
    const byPart = new Map<string, string[]>();
    for (const c of design.components) byPart.set(c.part, [...(byPart.get(c.part) ?? []), c.ref]);
    return [...byPart.entries()]
      .map(([key, refs]) => {
        const p = design.parts[key];
        const unit = p?.sourcing?.prices[0]?.usd ?? null;
        return { key, refs: refs.sort((a, b) => a.localeCompare(b, "en", { numeric: true })), p, unit, total: unit === null ? null : unit * refs.length };
      })
      .sort((a, b) => (b.total ?? 0) - (a.total ?? 0));
  }, [design]);

  const rejected = useMemo(() => {
    const used = new Set(design.components.map((c) => c.part));
    return Object.entries(design.parts).filter(([k]) => !used.has(k));
  }, [design]);

  const count = design.components.length;
  const cost = lines.reduce((s, l) => s + (l.total ?? 0), 0);
  const extended = lines.filter((l) => l.p?.sourcing?.tier === "extended").length;
  const dates = lines.map((l) => l.p?.sourcing?.checked_at).filter(Boolean).sort() as string[];
  const risky = lines.filter((l) => l.p && (l.p.lifecycle === "nrnd" || l.p.lifecycle === "eol"));

  const [open, setOpen] = useState<string | null>(null);
  const openLine = lines.find((l) => l.key === open);

  if (lines.length === 0)
    return <Empty title="No parts yet">Parts appear here once you and HardHub have chosen them, with price, stock and whether they are still made.</Empty>;

  const stats = [
    { n: int(count), m: "parts on the board", tone: "text-sky-text", bg: "bg-sky/10" },
    { n: usd(cost), m: "parts per board, at 10", tone: "text-ember-text", bg: "bg-ember/10" },
    { n: extended, m: "extended types (≈$3 setup each)", tone: "text-plum-text", bg: "bg-plum/10" },
    { n: risky.length, m: "at end of life", tone: risky.length ? "text-clay-text" : "text-moss-text", bg: risky.length ? "bg-clay/10" : "bg-moss/10" },
  ];

  return (
    <Pane>
      <PaneHead title="Parts">Every part on the board, what it does, what it costs and whether it can be bought. Click one for its details.</PaneHead>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {stats.map((x) => (
          <div key={x.m} className={cn("flex flex-col gap-0.5 rounded-xl p-4", x.bg)}>
            <span className={cn("num text-2xl font-medium", x.tone)}>{x.n}</span>
            <span className="text-sm text-soft">{x.m}</span>
          </div>
        ))}
      </div>

      <Section title="Bill of materials" aside={`${lines.length} different parts`}>
        <div className="rounded-xl border">
          <Table data-testid="bom">
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Part</TableHead>
                <TableHead className="hidden lg:table-cell">What it does</TableHead>
                <TableHead className="text-right">Qty</TableHead>
                <TableHead className="hidden md:table-cell">Package</TableHead>
                <TableHead className="hidden md:table-cell">Stock</TableHead>
                <TableHead className="hidden text-right sm:table-cell">Each</TableHead>
                <TableHead className="text-right">Line</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {lines.map(({ key, refs, p, unit, total }) => (
                <TableRow
                  key={key}
                  className="cursor-pointer"
                  onClick={() => setOpen(key)}
                  style={{ contentVisibility: "auto", containIntrinsicSize: "auto 56px" }}
                >
                  <TableCell className="min-w-40 align-top">
                    <button type="button" className="text-left font-medium outline-none hover:text-ember-text focus-visible:text-ember-text" onClick={() => setOpen(key)}>
                      {p?.value ?? p?.mpn ?? key}
                    </button>
                    <div className="text-xs text-muted-foreground">
                      {p?.mpn} · {p?.maker}
                    </div>
                    <div className="num mt-0.5 text-xs text-muted-foreground [overflow-wrap:anywhere]" title={refs.join(", ")}>
                      {refs.length > 6 ? `${refs.slice(0, 6).join(" ")} +${refs.length - 6}` : refs.join(" ")}
                    </div>
                    {p && p.lifecycle !== "active" && (
                      <Badge tone={LIFE[p.lifecycle].tone} className="mt-1.5">
                        {LIFE[p.lifecycle].label}
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell className="hidden max-w-72 align-top text-soft lg:table-cell">{p?.description}</TableCell>
                  <TableCell className="num text-right align-top">{refs.length}</TableCell>
                  <TableCell className="num hidden align-top text-xs text-soft md:table-cell">{p ? footprintName(p.footprint) : "—"}</TableCell>
                  <TableCell className="hidden align-top md:table-cell">
                    {p?.sourcing?.stock !== undefined ? (
                      <Badge tone={p.sourcing.stock > 1000 ? "moss" : p.sourcing.stock > 0 ? "gold" : "clay"}>{p.sourcing.stock > 0 ? int(p.sourcing.stock) : "None"}</Badge>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                    {p?.sourcing?.tier && <div className="mt-1 text-xs text-muted-foreground">{TIER[p.sourcing.tier]}</div>}
                  </TableCell>
                  <TableCell className="num hidden text-right align-top sm:table-cell">{unit === null ? "—" : usd(unit, unit < 0.1 ? 3 : 2)}</TableCell>
                  <TableCell className="num text-right align-top">{total === null ? "—" : usd(total)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
        <p className="text-xs text-muted-foreground">
          {dates.length ? `Prices and stock from the JLCPCB catalogue, read ${date(dates[0]!)}${dates.at(-1) !== dates[0] ? ` to ${date(dates.at(-1)!)}` : ""}. ` : ""}
          Price at 10 pieces. Read them again before ordering: stock moves.
        </p>
      </Section>

      {rejected.length > 0 && (
        <Section title="Considered, not used">
          <div className="divide-y rounded-xl border">
            {rejected.map(([k, p]) => (
              <div key={k} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                <span>
                  {p.mpn} <span className="text-sm text-muted-foreground">· {p.maker}</span>
                </span>
                <Badge tone={LIFE[p.lifecycle].tone}>{LIFE[p.lifecycle].label}</Badge>
              </div>
            ))}
          </div>
        </Section>
      )}

      <Dialog open={!!openLine} onOpenChange={(o) => !o && setOpen(null)}>
        <DialogContent className="max-h-[85dvh] overflow-y-auto">
          <DialogTitle className="sr-only">Part details</DialogTitle>
          {openLine && <PartDetails design={design} partKey={openLine.key} refName={openLine.refs.length === 1 ? openLine.refs[0] : undefined} />}
        </DialogContent>
      </Dialog>
    </Pane>
  );
}
