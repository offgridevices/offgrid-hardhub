// One test as a row: what it checks in plain words, its result at a glance,
// and, opened, why it matters, how it was tested, what was found, how to fix
// it and where on the board. A miss is written exactly like a pass.
import { memo, useId, useState, type ComponentType } from "react";
import type { CheckPlan, CheckResult, CheckWhere } from "@hardhub/protocol";
import {
  ActivityIcon,
  CableIcon,
  ChevronDownIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  CircleDotIcon,
  CircleMinusIcon,
  CircleXIcon,
  CodeIcon,
  CpuIcon,
  FactoryIcon,
  GaugeIcon,
  LayersIcon,
  LoaderCircleIcon,
  MapPinIcon,
  ShoppingCartIcon,
  SplineIcon,
  ThermometerIcon,
  TypeIcon,
  WrenchIcon,
  ZapIcon,
  type LucideProps,
} from "lucide-react";
import { margin, measureText, STATUS_LABEL, withUnit, type Area, type Status } from "../../lib/tests";
import { layerName } from "../../lib/layers";
import { cn } from "@/lib/utils";

export const AREA_ICON: Record<Area, ComponentType<LucideProps>> = {
  connections: CableIcon,
  copper: SplineIcon,
  holes: CircleDotIcon,
  silkscreen: TypeIcon,
  mask: LayersIcon,
  placement: CpuIcon,
  power: ZapIcon,
  thermal: ThermometerIcon,
  stress: GaugeIcon,
  signals: ActivityIcon,
  firmware: CodeIcon,
  sourcing: ShoppingCartIcon,
  fab: FactoryIcon,
};

// the icon's shape says the result as much as its colour does
export const STATUS: Record<Status, { icon: ComponentType<LucideProps>; text: string; fill: string; tint: string }> = {
  pass: { icon: CircleCheckIcon, text: "text-moss-text", fill: "bg-moss", tint: "bg-moss/10" },
  fail: { icon: CircleXIcon, text: "text-clay-text", fill: "bg-clay", tint: "bg-clay/10" },
  warn: { icon: CircleAlertIcon, text: "text-gold-text", fill: "bg-gold", tint: "bg-gold/10" },
  skip: { icon: CircleMinusIcon, text: "text-muted-foreground", fill: "bg-muted-foreground", tint: "bg-foreground/5" },
  na: { icon: CircleDashedIcon, text: "text-muted-foreground/70", fill: "bg-muted-foreground/60", tint: "bg-foreground/[0.03]" },
};
// for screen readers (and the end-to-end tests): the result in words
const SPOKEN: Record<Status, string> = { pass: "Passed", fail: "Failed, to fix", warn: "To look at", skip: "Not run", na: "Doesn't apply" };

export function StatusIcon({ status, className }: { status: Status; className?: string }) {
  const s = STATUS[status];
  const Icon = s.icon;
  return <Icon className={cn("size-[18px] shrink-0", s.text, className)} aria-hidden="true" />;
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const sentence = (s: string) => {
  const t = cap(s.trim());
  return /[.!?]$/.test(t) ? t : `${t}.`;
};

/** "0.15 mm · needs ≥ 0.127" with a small bar: how far the value is from its limit */
export function MeasurePill({ m, status, className }: { m: NonNullable<CheckResult["measured"]>; status: Status; className?: string }) {
  const t = measureText(m);
  const g = margin(m);
  return (
    <span className={cn("inline-flex h-6 w-fit max-w-full shrink-0 items-center gap-2 rounded-full bg-foreground/[0.06] px-2.5 text-xs", className)} title={m.label}>
      <span className="num truncate">
        <span className="font-medium text-foreground">{t.value}</span>
        {t.need && <span className="text-muted-foreground"> · {t.need}</span>}
      </span>
      {g && (
        <span className="relative h-1 w-7 shrink-0 rounded-full bg-foreground/15" aria-hidden="true">
          <span className={cn("absolute inset-y-0 left-0 rounded-full", STATUS[status].fill)} style={{ width: `${Math.max(4, g.fill * 100)}%` }} />
          <span className="absolute -inset-y-[3px] w-px bg-foreground/80" style={{ left: `${g.mark * 100}%` }} />
        </span>
      )}
    </span>
  );
}

export const CheckRow = memo(function CheckRow({ c, onShow, open: openInit = false }: { c: CheckResult; onShow?: (w: CheckWhere) => void; open?: boolean }) {
  const [open, setOpen] = useState(openInit);
  const id = useId();
  const st = STATUS[c.status];
  return (
    <li className={cn("flex flex-col", c.status === "na" && "text-muted-foreground")} data-testid="check-row" data-status={c.status} data-check-id={c.id}>
      <button
        type="button"
        className="group flex w-full items-start gap-3 px-4 py-3 text-left outline-none transition-colors hover:bg-foreground/[0.03] focus-visible:bg-foreground/[0.04] focus-visible:ring-[3px] focus-visible:ring-inset focus-visible:ring-ring/50"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((o) => !o)}
      >
        <StatusIcon status={c.status} className="mt-px" />
        <span className="flex min-w-0 flex-1 flex-col gap-1 sm:flex-row sm:items-start sm:gap-4">
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className={cn("font-medium", c.status === "na" ? "text-soft" : "text-foreground")}>
              {c.name}
              <span className="sr-only"> · {SPOKEN[c.status]}</span>
            </span>
            {c.plain && <span className="text-sm text-muted-foreground">{c.plain}</span>}
          </span>
          {c.measured && <MeasurePill m={c.measured} status={c.status} className="sm:mt-px" />}
        </span>
        <ChevronDownIcon className={cn("mt-0.5 size-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-180")} aria-hidden="true" />
      </button>
      {open && (
        <div id={id} className={cn("mx-4 mb-4 grid gap-4 rounded-lg p-4 text-sm sm:ml-[2.875rem]", st.tint)}>
          <Detail title="Why it matters">{sentence(c.why)}</Detail>
          {(c.how || c.tool || c.source) && (
            <Detail title="How we tested">
              {c.how && <p>{c.how}</p>}
              {(c.tool || c.source) && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {c.tool && <span className="rounded-full bg-sky/15 px-2 py-0.5 text-xs font-medium text-sky-text">{c.tool}</span>}
                  {c.source && <span className="rounded-full bg-foreground/[0.07] px-2 py-0.5 text-xs text-soft">Rule: {c.source}</span>}
                </div>
              )}
            </Detail>
          )}
          {(c.detail || c.measured) && (
            <Detail title={c.status === "skip" ? "Why it did not run" : c.status === "na" ? "Why it doesn't apply" : "What we found"}>
              {c.measured && (
                <p>
                  {cap(c.measured.label)}: <span className="num font-medium text-foreground">{withUnit(c.measured.value, c.measured.unit)}</span>
                  {c.measured.limit !== undefined && (
                    <span className="text-muted-foreground">
                      {" "}
                      (needs {c.measured.op === "<=" ? "at most" : "at least"} <span className="num">{withUnit(c.measured.limit, c.measured.unit)}</span>)
                    </span>
                  )}
                </p>
              )}
              {c.detail && <p className={cn(c.measured && "mt-1")}>{c.detail}</p>}
            </Detail>
          )}
          {c.fix && (
            <div className="flex gap-3 rounded-lg border border-ember/30 bg-card p-3">
              <WrenchIcon className="mt-0.5 size-4 shrink-0 text-ember-text" aria-hidden="true" />
              <div className="flex flex-col gap-1">
                <h4 className="text-xs font-semibold text-ember-text">How to fix</h4>
                <p className="text-foreground">{c.fix}</p>
              </div>
            </div>
          )}
          {c.where && c.where.length > 0 && (
            <Detail title="Where">
              <ul className="flex flex-col gap-1.5">
                {c.where.map((w, i) => (
                  <li key={i} className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <span className="min-w-0">
                      <span className="font-medium text-foreground">{whereTitle(w)}</span>
                      {w.note && <span className="text-muted-foreground"> · {w.note}</span>}
                    </span>
                    {onShow && (
                      <button
                        type="button"
                        className="inline-flex items-center gap-1 rounded text-xs font-medium text-ember-text underline-offset-4 outline-none hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50"
                        onClick={() => onShow(w)}
                        data-testid="show-on-board"
                      >
                        <MapPinIcon className="size-3.5" aria-hidden="true" />
                        Show on board
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </Detail>
          )}
        </div>
      )}
    </li>
  );
});

function whereTitle(w: CheckWhere): string {
  const bits = [w.refs?.join(", "), w.net, w.layer && layerName(w.layer)].filter(Boolean);
  return bits.length ? bits.join(" · ") : `${withUnit(w.x, "mm")}, ${withUnit(w.y, "mm")}`;
}

function Detail({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <h4 className="text-xs font-semibold text-muted-foreground">{title}</h4>
      <div className="text-soft">{children}</div>
    </div>
  );
}

/** a check the running tests have not reached yet; the one running now turns quietly */
export function PendingRow({ p, running }: { p: CheckPlan; running: boolean }) {
  return (
    <li className="flex items-start gap-3 px-4 py-3" data-testid="check-pending" aria-busy={running}>
      {running ? (
        <LoaderCircleIcon className="mt-px size-[18px] shrink-0 animate-spin text-ember-text [animation-duration:1.4s]" aria-hidden="true" />
      ) : (
        <span className="mt-px grid size-[18px] shrink-0 place-items-center" aria-hidden="true">
          <span className="size-1.5 rounded-full bg-foreground/20" />
        </span>
      )}
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className={cn("font-medium", running ? "text-foreground" : "text-muted-foreground")}>{p.name}</span>
        <span className="text-sm text-muted-foreground/70">{running ? "Testing now" : "Waiting"}</span>
      </span>
    </li>
  );
}

export { STATUS_LABEL };
