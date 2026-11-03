// Every test the board went through before it is ordered: a verdict first,
// then each area of the board with its checks, then the simulations behind
// them (heat, power, part ratings) and the board's layers. While tests run,
// the whole plan is listed and each row turns into its result as it lands.
// The report and its charts load after the list has painted, in their own
// chunk.
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { TestReport, type Artifact, type CheckResult, type CheckWhere, type Design } from "@hardhub/protocol";
import { ArrowDownIcon, CircleAlertIcon, CircleCheckIcon, CircleXIcon, FlaskConicalIcon, LoaderCircleIcon, PlayIcon } from "lucide-react";
import type { TestRun } from "../lib/project-state";
import {
  byArea,
  counts,
  DEFAULT_RANGE,
  defaultFilter,
  FILTERS,
  matches,
  planRows,
  presetOf,
  PRESETS,
  rangeText,
  verdict,
  verdictTitle,
  type Counts,
  type Filter,
  type Range,
} from "../lib/tests";
import { AREA_ICON, CheckRow, PendingRow, STATUS } from "../components/tests/check-row";
import { Empty } from "../components/pane";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";

const Simulations = lazy(() => import("../components/tests/simulations"));

export interface TestsProps {
  design: Design;
  checks: CheckResult[];
  testRun: TestRun | null;
  artifacts: Artifact[];
  fileUrl(u: string): string;
  /** the AI or a build is working: tests cannot start */
  busy: boolean;
  onRun(r: Range): Promise<unknown>;
  onShow(w: CheckWhere): void;
  onOpen3d(): void;
}

/** the newest test report, fetched once the list is on screen */
function useReport(artifacts: Artifact[], fileUrl: (u: string) => string) {
  const art = useMemo(() => artifacts.find((a) => a.kind === "report" && a.name.endsWith("-tests.json")), [artifacts]);
  const [state, setState] = useState<{ url: string; report: TestReport | null; failed: boolean } | null>(null);
  useEffect(() => {
    if (!art || art.url.startsWith("mock:")) return;
    let live = true;
    fetch(fileUrl(art.url), { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((j) => live && setState({ url: art.url, report: TestReport.parse(j), failed: false }))
      .catch(() => live && setState({ url: art.url, report: null, failed: true }));
    return () => {
      live = false;
    };
  }, [art, fileUrl]);
  // a newer report keeps the old one on screen until it has loaded: no flash
  return { has: !!art && !art.url.startsWith("mock:"), report: state?.report ?? null, failed: !!state?.failed && state.url === art?.url, loading: !!art && state?.url !== art.url };
}

export default function Tests({ design, checks, testRun, artifacts, fileUrl, busy, onRun, onShow, onOpen3d }: TestsProps) {
  const live = !!testRun && testRun.phase !== "done";
  const { has, report, failed, loading } = useReport(artifacts, fileUrl);
  const results = useMemo(() => (live ? Object.values(testRun!.results) : checks), [live, testRun, checks]);
  const n = useMemo(() => counts(results), [results]);
  const [picked, setPicked] = useState<Filter | null>(null);
  const filter = picked ?? defaultFilter(n);
  const hasBoard = artifacts.some((a) => a.kind === "board-svg" || a.kind === "board-json");
  const env = design.environment;
  const tested: Range = report ? { min: report.ambient.min, max: report.ambient.max } : env ? { min: env.ambient_min, max: env.ambient_max } : DEFAULT_RANGE;
  const sims = useRef<HTMLDivElement>(null);

  const groups = useMemo(() => byArea(results), [results]);
  const shown = useMemo(() => byArea(results.filter((c) => matches(c, filter))), [results, filter]);
  const rows = useMemo(() => (live ? byArea(planRows(testRun!.plan, testRun!.results)) : []), [live, testRun]);
  const running = live ? testRun!.plan.find((p) => !testRun!.results[p.id])?.id : undefined;

  if (!checks.length && !live)
    return (
      <div className="flex flex-col">
        <Empty title="Not tested yet">
          Once the board is laid out, HardHub tests it the way an experienced engineer would before ordering: every connection, the copper against the
          factory's limits, holes, printing, power, heat, part ratings, signals, firmware and the parts' stock.
        </Empty>
        {hasBoard && (
          <div className="flex justify-center pb-12">
            <RunControl range={tested} place={env?.place} disabled={busy} onRun={onRun} />
          </div>
        )}
      </div>
    );

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-3 py-4 sm:px-6 sm:py-6" data-testid="tests">
      <VerdictCard n={n} run={live ? testRun : null} tested={tested} place={env?.place ?? null} hasSims={has} onJump={() => sims.current?.scrollIntoView({ behavior: "smooth", block: "start" })}>
        <RunControl range={tested} place={env?.place} disabled={busy || live || !hasBoard} running={live} onRun={onRun} />
      </VerdictCard>

      {!live && (
        <div className="-mx-3 flex gap-1.5 overflow-x-auto px-3 [scrollbar-width:none] sm:mx-0 sm:flex-wrap sm:px-0" role="radiogroup" aria-label="Show">
          {FILTERS.map((f) => {
            const count = f.id === "all" ? n.total : n[f.id];
            const on = filter === f.id;
            return (
              <button
                key={f.id}
                type="button"
                role="radio"
                aria-checked={on}
                disabled={!count && f.id !== "all"}
                onClick={() => setPicked(f.id)}
                data-testid={`filter-${f.id}`}
                className={cn(
                  "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full border px-3 text-sm font-medium outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-40",
                  on ? "border-transparent bg-foreground text-background" : "bg-card text-soft hover:bg-accent",
                )}
              >
                {f.label}
                <span className={cn("num text-xs", on ? "opacity-70" : "text-muted-foreground")}>{count}</span>
              </button>
            );
          })}
        </div>
      )}

      <div className="flex flex-col gap-6">
        {live
          ? rows.map(({ area, items }) => {
              const Icon = AREA_ICON[area.id];
              const done = items.filter((i) => i.result).length;
              return (
                <AreaSection key={area.id} icon={<Icon />} title={area.label} aside={`${done} of ${items.length}`}>
                  {items.map((p) => (p.result ? <CheckRow key={p.id} c={p.result} onShow={onShow} /> : <PendingRow key={p.id} p={p} running={p.id === running} />))}
                </AreaSection>
              );
            })
          : shown.map(({ area, items }) => {
              const Icon = AREA_ICON[area.id];
              const all = groups.find((g) => g.area.id === area.id)!.items;
              const counted = all.filter((c) => c.status !== "na");
              return (
                <AreaSection key={area.id} icon={<Icon />} title={area.label} aside={`${counted.filter((c) => c.status === "pass").length} of ${counted.length} pass`}>
                  {items.map((c) => (
                    <CheckRow key={c.id} c={c} onShow={onShow} />
                  ))}
                </AreaSection>
              );
            })}
        {!live && !shown.length && <p className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">Nothing here.</p>}
      </div>

      <div ref={sims} className="scroll-mt-4" id="simulations">
        {has ? (
          report ? (
            <Suspense fallback={<SimsPlaceholder />}>
              <div className={cn("transition-opacity", loading && "opacity-60")}>
                <Simulations report={report} design={design} artifacts={artifacts} fileUrl={fileUrl} onOpen3d={onOpen3d} />
              </div>
            </Suspense>
          ) : failed ? (
            <p className="rounded-xl border p-6 text-sm text-muted-foreground">The simulation report could not be loaded. Run the tests again to make a new one.</p>
          ) : (
            <SimsPlaceholder />
          )
        ) : (
          !live && (
            <div className="flex items-start gap-3 rounded-xl border border-dashed p-5 text-sm text-muted-foreground">
              <FlaskConicalIcon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
              The heat map, the power simulations and the part ratings appear here after the next test run.
            </div>
          )
        )}
      </div>
    </div>
  );
}

function AreaSection({ icon, title, aside, children }: { icon: React.ReactNode; title: string; aside: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2" aria-label={title}>
      <div className="flex items-center gap-2 px-1">
        <span className="text-muted-foreground [&_svg]:size-4" aria-hidden="true">
          {icon}
        </span>
        <h3 className="text-sm font-semibold">{title}</h3>
        <span className="num ml-auto text-xs text-muted-foreground">{aside}</span>
      </div>
      <ul className="divide-y overflow-hidden rounded-xl border bg-card">{children}</ul>
    </section>
  );
}

function SimsPlaceholder() {
  return (
    <div className="flex flex-col gap-3" aria-hidden="true">
      <div className="h-4 w-32 rounded bg-foreground/[0.06]" />
      <div className="h-64 rounded-xl border bg-foreground/[0.02]" />
    </div>
  );
}

/* ---------- the verdict ---------- */

const PARTS: { s: keyof Omit<Counts, "total">; label: (n: number) => string }[] = [
  { s: "pass", label: () => "passed" },
  { s: "fail", label: () => "to fix" },
  { s: "warn", label: () => "to look at" },
  { s: "skip", label: () => "not run" },
  { s: "na", label: (n) => (n === 1 ? "doesn't apply" : "don't apply") },
];

function VerdictCard({
  n,
  run,
  tested,
  place,
  hasSims,
  onJump,
  children,
}: {
  n: Counts;
  run: TestRun | null;
  tested: Range;
  place: Parameters<typeof rangeText>[1];
  hasSims: boolean;
  onJump(): void;
  children: React.ReactNode;
}) {
  const v = verdict(n);
  const tone = run ? "ember" : v === "fix" ? "clay" : v === "check" ? "gold" : v === "ready" ? "moss" : "neutral";
  const Icon = run ? LoaderCircleIcon : v === "fix" ? CircleXIcon : v === "check" ? CircleAlertIcon : CircleCheckIcon;
  const total = run ? run.plan.length : n.total;
  const done = run ? Object.keys(run.results).length : n.total;
  const sub = run
    ? null
    : [v === "fix" && n.warn ? `and ${n.warn} to look at` : null, v === "ready" ? "Every test passed" : null].filter(Boolean).join(" · ");
  return (
    <section className="flex flex-col gap-4 rounded-2xl border bg-card p-4 sm:p-5" aria-label="Result" data-testid="verdict" data-verdict={run ? "running" : v}>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 items-start gap-3">
          <span
            className={cn(
              "grid size-11 shrink-0 place-items-center rounded-full [&_svg]:size-6",
              tone === "clay" && "bg-clay/15 text-clay-text",
              tone === "gold" && "bg-gold/15 text-gold-text",
              tone === "moss" && "bg-moss/15 text-moss-text",
              tone === "ember" && "bg-ember/15 text-ember-text",
              tone === "neutral" && "bg-foreground/[0.07] text-muted-foreground",
            )}
            aria-hidden="true"
          >
            <Icon className={cn(run && "animate-spin [animation-duration:1.6s]")} />
          </span>
          <div className="flex min-w-0 flex-col gap-0.5">
            <h2 className="text-xl font-semibold tracking-tight sm:text-2xl" aria-live="polite">
              {run ? "Testing the board" : verdictTitle(n)}
            </h2>
            <p className="min-h-5 text-sm text-soft" aria-live="off">
              {run ? (
                <span className="flex min-w-0 gap-1">
                  <span className="shrink-0 text-muted-foreground">Now:</span>
                  <span className="truncate" data-testid="run-label">
                    {run.label}
                  </span>
                </span>
              ) : (
                <>
                  {sub && <span>{sub} · </span>}
                  <span className="text-muted-foreground">Tested at {rangeText(tested, place)} outside</span>
                </>
              )}
            </p>
          </div>
        </div>
        {children}
      </div>

      {run ? (
        <div className="flex flex-col gap-1.5">
          <div className="h-2 overflow-hidden rounded-full bg-foreground/10" role="progressbar" aria-label="Tests done" aria-valuemin={0} aria-valuemax={total} aria-valuenow={done}>
            <span className="block h-full rounded-full bg-ember transition-[width] duration-300 ease-out" style={{ width: `${Math.round(run.progress * 100)}%` }} />
          </div>
        </div>
      ) : (
        n.total > 0 && (
          // one whole split into its parts: thin, rounded, no text; the legend says what each part is
          <div className="flex h-2 gap-0.5 overflow-hidden rounded-full" aria-hidden="true">
            {PARTS.filter((p) => n[p.s]).map((p) => (
              <span key={p.s} className={cn("h-full first:rounded-l-full last:rounded-r-full", STATUS[p.s].fill, p.s === "na" && "opacity-50")} style={{ flexGrow: n[p.s] }} />
            ))}
          </div>
        )
      )}

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-sm">
        {run && (
          <span className="num font-medium">
            {done} of {total}
          </span>
        )}
        {PARTS.map((p) => (
          <span key={p.s} className={cn("inline-flex items-center gap-1.5", !n[p.s] && "text-muted-foreground/60")}>
            <span className={cn("size-2 rounded-full", STATUS[p.s].fill, p.s === "na" && "opacity-50")} aria-hidden="true" />
            <span className="num font-medium">{n[p.s]}</span>
            <span className="text-muted-foreground">{p.label(n[p.s])}</span>
          </span>
        ))}
        {hasSims && !run && (
          <button type="button" onClick={onJump} className="ml-auto inline-flex items-center gap-1 rounded text-sm font-medium text-ember-text outline-none hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50">
            Heat, power and layers
            <ArrowDownIcon className="size-3.5" aria-hidden="true" />
          </button>
        )}
      </div>
    </section>
  );
}

/* ---------- run again, at a temperature range ---------- */

function RunControl({ range, place, disabled, running, onRun }: { range: Range; place?: string; disabled: boolean; running?: boolean; onRun(r: Range): Promise<unknown> }) {
  const initial = (place && PRESETS.find((p) => p.id === place && p.min === range.min && p.max === range.max)?.id) || presetOf(range)?.id || "custom";
  const [choice, setChoice] = useState<string>(initial);
  const [custom, setCustom] = useState({ min: String(range.min), max: String(range.max) });
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // the run's own events take over once it starts
  useEffect(() => {
    if (running) setStarting(false);
  }, [running]);
  const preset = PRESETS.find((p) => p.id === choice);
  const want: Range | null = preset ? { min: preset.min, max: preset.max } : validRange(custom.min, custom.max);
  const go = useCallback(async () => {
    if (!want) return;
    setStarting(true);
    setError(null);
    try {
      await onRun(want);
    } catch (e) {
      setError(e instanceof Error ? e.message : "The tests could not start");
    } finally {
      setStarting(false);
    }
  }, [want, onRun]);
  const busy = starting || !!running;
  return (
    <div className="flex w-full flex-col gap-2 sm:w-auto sm:items-end">
      <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto sm:flex-nowrap">
        <Select value={choice} onValueChange={setChoice} disabled={busy}>
          <SelectTrigger className="h-9 min-w-0 flex-1 sm:w-56 sm:flex-none" aria-label="Where the board will live" data-testid="range">
            <SelectValue />
          </SelectTrigger>
          <SelectContent align="end">
            {PRESETS.map((p) => (
              <SelectItem key={p.id} value={p.id}>
                <span className="flex flex-col">
                  <span>
                    {p.label} <span className="num text-muted-foreground">· {rangeText(p, null).replace(/,.*$/, "")}</span>
                  </span>
                </span>
              </SelectItem>
            ))}
            <SelectItem value="custom">Custom range</SelectItem>
          </SelectContent>
        </Select>
        <Button onClick={go} disabled={disabled || busy || !want} data-testid="run-tests" className="shrink-0">
          {busy ? <LoaderCircleIcon className="animate-spin" /> : <PlayIcon />}
          {busy ? "Testing…" : "Run tests again"}
        </Button>
      </div>
      {choice === "custom" && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <label className="flex items-center gap-1.5">
            From
            <Input className="num h-8 w-16" inputMode="numeric" value={custom.min} onChange={(e) => setCustom({ ...custom, min: e.target.value })} aria-label="Coldest, °C" disabled={busy} />
          </label>
          <label className="flex items-center gap-1.5">
            to
            <Input className="num h-8 w-16" inputMode="numeric" value={custom.max} onChange={(e) => setCustom({ ...custom, max: e.target.value })} aria-label="Hottest, °C" disabled={busy} />
            °C
          </label>
        </div>
      )}
      {error && (
        <p className="max-w-xs text-xs text-clay-text" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

function validRange(a: string, b: string): Range | null {
  const min = Number(a.replace("−", "-"));
  const max = Number(b.replace("−", "-"));
  return Number.isFinite(min) && Number.isFinite(max) && a.trim() !== "" && b.trim() !== "" && min < max && min >= -60 && max <= 150 ? { min, max } : null;
}
