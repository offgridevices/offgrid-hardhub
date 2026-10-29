// Requirements and decisions: what the board must do, and every choice made.
import type { Design } from "@hardhub/protocol";
import { date, keepHyphens } from "../lib/format";
import { Pane, PaneHead, Section } from "../components/pane";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

const STATUS = {
  open: { label: "Open", tone: "neutral" },
  met: { label: "Met", tone: "moss" },
  unmet: { label: "Not met", tone: "clay" },
  limit: { label: "Limit", tone: "gold" },
} as const;

export default function Overview({ design }: { design: Design }) {
  const reqs = design.requirements;
  const decs = design.decisions;
  return (
    <Pane>
      <PaneHead title={design.name}>{design.summary && keepHyphens(design.summary)}</PaneHead>

      <Section title="Requirements" aside={reqs.length ? `${reqs.filter((r) => r.status === "met").length} of ${reqs.length} met` : undefined}>
        {reqs.length === 0 ? (
          <p className="text-sm text-muted-foreground">None yet. They are written as the conversation settles what the board must do.</p>
        ) : (
          <div className="rounded-xl border">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="w-12">#</TableHead>
                  <TableHead>Requirement</TableHead>
                  <TableHead className="hidden md:table-cell">How it is checked</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {reqs.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell className="num align-top text-muted-foreground">{r.id}</TableCell>
                    <TableCell className="align-top">
                      {keepHyphens(r.text)}
                      {r.note && <div className="mt-1 text-xs text-muted-foreground">{r.note}</div>}
                    </TableCell>
                    <TableCell className="hidden align-top text-soft md:table-cell">{r.check ?? "—"}</TableCell>
                    <TableCell className="align-top">
                      <Badge tone={STATUS[r.status].tone}>{STATUS[r.status].label}</Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </Section>

      <Section title="Decisions">
        {decs.length === 0 ? (
          <p className="text-sm text-muted-foreground">Each choice you make is recorded here with the options and the reason.</p>
        ) : (
          <div className="grid gap-3 md:grid-cols-2">
            {decs.map((d) => {
              const chosen = d.options.find((o) => o.id === d.chosen);
              const others = d.options.filter((o) => o.id !== d.chosen);
              return (
                <div key={d.id} className="flex flex-col gap-1.5 rounded-xl border bg-card p-4">
                  <div className="flex flex-wrap justify-between gap-3">
                    <span className="text-xs font-medium text-muted-foreground">{d.question}</span>
                    {d.at && <span className="num text-xs text-muted-foreground">{date(d.at)}</span>}
                  </div>
                  <div className="font-medium">{chosen ? chosen.label : <span className="text-gold-text">Not decided yet</span>}</div>
                  {d.why && <div className="text-sm text-soft">{d.why}</div>}
                  {others.length > 0 && <div className="text-xs text-muted-foreground">Also considered: {others.map((o) => o.label).join(", ")}</div>}
                </div>
              );
            })}
          </div>
        )}
      </Section>
    </Pane>
  );
}
