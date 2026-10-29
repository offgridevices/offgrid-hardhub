// Every check that ran: what it tested, why it matters, the result. A miss is
// written exactly like a pass.
import type { CheckResult } from "@hardhub/protocol";
import { CircleAlertIcon, CircleCheckIcon, CircleDashedIcon, CircleXIcon } from "lucide-react";
import { Empty, Pane, PaneHead, Section } from "../components/pane";
import { cn } from "@/lib/utils";

const GROUPS: { id: CheckResult["group"]; name: string }[] = [
  { id: "circuit", name: "Circuit" },
  { id: "layout", name: "Layout" },
  { id: "power", name: "Power" },
  { id: "thermal", name: "Heat" },
  { id: "firmware", name: "Firmware" },
  { id: "fab", name: "Manufacturing" },
];
// sentence case, like every other label
const ST = {
  pass: { label: "Pass", icon: CircleCheckIcon, text: "text-moss-text", bg: "bg-moss/10" },
  fail: { label: "Fail", icon: CircleXIcon, text: "text-clay-text", bg: "bg-clay/10" },
  warn: { label: "Warning", icon: CircleAlertIcon, text: "text-gold-text", bg: "bg-gold/10" },
  skip: { label: "Not run", icon: CircleDashedIcon, text: "text-muted-foreground", bg: "bg-foreground/5" },
} as const;
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export default function Checks({ checks }: { checks: CheckResult[] }) {
  if (checks.length === 0)
    return (
      <Empty title="Nothing checked yet">
        Checks run on the circuit as soon as it is wired, and on the routed board after layout: design rules with the fab's own limits, copper against the
        circuit pad for pad, track widths for their current, heat, and the firmware's pin map.
      </Empty>
    );
  const n = (s: CheckResult["status"]) => checks.filter((c) => c.status === s).length;
  const stats = [
    { n: `${n("pass")} of ${checks.length}`, m: "checks pass", s: "pass" },
    { n: n("fail"), m: "fail", s: "fail" },
    { n: n("warn"), m: "need a look", s: "warn" },
    { n: n("skip"), m: "after hardware", s: "skip" },
  ] as const;
  return (
    <Pane>
      <PaneHead title="Checks">Every rule the board was tested against, why it matters, and what came back.</PaneHead>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {stats.map((x) => (
          <div key={x.m} className={cn("flex flex-col gap-0.5 rounded-xl p-4", ST[x.s].bg)}>
            <span className={cn("num text-2xl font-medium", ST[x.s].text)}>{x.n}</span>
            <span className="text-sm text-soft">{x.m}</span>
          </div>
        ))}
      </div>
      {GROUPS.map((g) => {
        const rows = checks.filter((c) => c.group === g.id);
        if (!rows.length) return null;
        return (
          <Section key={g.id} title={g.name} aside={`${rows.filter((r) => r.status === "pass").length} of ${rows.length} pass`}>
            <div className="divide-y overflow-hidden rounded-xl border">
              {rows.map((c) => {
                const st = ST[c.status];
                const Icon = st.icon;
                return (
                  <div key={c.id} className="flex gap-3 px-4 py-3" data-testid="check-row" data-status={c.status}>
                    <Icon className={cn("mt-0.5 size-4 shrink-0", st.text)} aria-hidden="true" />
                    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <div className="flex flex-wrap items-baseline gap-x-3">
                        <span className="font-medium">{c.name}</span>
                        <span className={cn("text-xs font-medium", st.text)}>{st.label}</span>
                      </div>
                      <span className="text-sm text-muted-foreground">{cap(c.why)}</span>
                      {c.detail && <span className="mt-1 whitespace-pre-wrap rounded-md bg-sunken px-2.5 py-1.5 font-mono text-xs text-soft">{c.detail}</span>}
                    </div>
                  </div>
                );
              })}
            </div>
          </Section>
        );
      })}
    </Pane>
  );
}
