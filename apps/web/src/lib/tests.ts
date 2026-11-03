// The board tests, as the Tests view reads them: areas in the engine's order,
// what each status is called, the verdict, the filters, and a measured number
// against its limit. Pure, so it is easy to test and shared by the view, the
// chat and the tab bar.
import type { CheckGroup, CheckMeasure, CheckPlan, CheckResult, Design } from "@hardhub/protocol";

export type Status = CheckResult["status"];
export type Area = Exclude<CheckGroup, "circuit" | "layout">;

// the engine's AREAS (engine/hardhub/review/catalog.py), in display order
export const AREAS: { id: Area; label: string }[] = [
  { id: "connections", label: "Connections" },
  { id: "copper", label: "Copper and tracks" },
  { id: "holes", label: "Holes and vias" },
  { id: "silkscreen", label: "Printed labels" },
  { id: "mask", label: "Solder mask and paste" },
  { id: "placement", label: "Parts and assembly" },
  { id: "power", label: "Power" },
  { id: "thermal", label: "Heat" },
  { id: "stress", label: "Part ratings" },
  { id: "signals", label: "Signals" },
  { id: "firmware", label: "Firmware" },
  { id: "sourcing", label: "Buying the parts" },
  { id: "fab", label: "Manufacturing" },
];

/** results made before the full test suite used two groups that are now split */
export function areaOf(group: CheckGroup): Area {
  return group === "circuit" ? "connections" : group === "layout" ? "copper" : group;
}

// sentence case, plain words: what a person would call each result
export const STATUS_LABEL: Record<Status, string> = {
  pass: "Passed",
  fail: "To fix",
  warn: "To look at",
  skip: "Not run",
  na: "Doesn't apply",
};

export type Filter = "fail" | "warn" | "pass" | "skip" | "all";
export const FILTERS: { id: Filter; label: string }[] = [
  { id: "fail", label: "To fix" },
  { id: "warn", label: "To look at" },
  { id: "pass", label: "Passed" },
  { id: "skip", label: "Not run" },
  { id: "all", label: "All" },
];

export interface Counts {
  pass: number;
  fail: number;
  warn: number;
  skip: number;
  na: number;
  total: number;
}

export function counts(checks: Iterable<CheckResult>): Counts {
  const n: Counts = { pass: 0, fail: 0, warn: 0, skip: 0, na: 0, total: 0 };
  for (const c of checks) {
    n[c.status]++;
    n.total++;
  }
  return n;
}

export type Verdict = "fix" | "check" | "ready" | "none";
export function verdict(n: Counts): Verdict {
  if (!n.total) return "none";
  return n.fail ? "fix" : n.warn ? "check" : "ready";
}

/** the verdict as a heading: "Ready to order", "2 things to fix" */
export function verdictTitle(n: Counts): string {
  const v = verdict(n);
  if (v === "none") return "Not tested yet";
  if (v === "ready") return "Ready to order";
  if (v === "fix") return n.fail === 1 ? "1 thing to fix" : `${n.fail} things to fix`;
  return `${n.warn} to look at`;
}

/** what the person sees first: what needs doing, else everything */
export const defaultFilter = (n: Counts): Filter => (n.fail ? "fail" : "all");

export function matches(c: Pick<CheckResult, "status">, f: Filter): boolean {
  return f === "all" || c.status === f;
}

/** checks by area, in the engine's order; areas with nothing to show are left out */
export function byArea<T extends { group: CheckGroup }>(items: T[]): { area: (typeof AREAS)[number]; items: T[] }[] {
  const m = new Map<Area, T[]>();
  for (const it of items) {
    const a = areaOf(it.group);
    m.set(a, [...(m.get(a) ?? []), it]);
  }
  return AREAS.filter((a) => m.has(a.id)).map((area) => ({ area, items: m.get(area.id)! }));
}

/** the plan's checks, each with its result once it has one (the live view) */
export function planRows(plan: CheckPlan[], results: Record<string, CheckResult>): (CheckPlan & { result?: CheckResult })[] {
  return plan.map((p) => ({ ...p, result: results[p.id] }));
}

/* ---------- a measured number against its limit ---------- */

// numbers as an engineer writes them: at most 3 significant decimals, no trailing zeros
export function num(v: number): string {
  if (!Number.isFinite(v)) return String(v);
  const a = Math.abs(v);
  if (a >= 1000) return Math.round(v).toLocaleString("en-US").replace(/^-/, "\u2212");
  const d = a >= 100 ? 0 : a >= 10 ? 1 : a >= 1 ? 2 : 3;
  return v
    .toFixed(d)
    .replace(/(\.\d*?)0+$/, "$1")
    .replace(/\.$/, "")
    .replace(/^-/, "−");
}

const NBSP = " ";
/** a value with its unit, the unit never on its own line: "0.15 mm", "42 %", "3 parts" */
export function withUnit(v: number, unit: string): string {
  if (unit === "count") return num(v);
  // an angle or a ratio sits right against its number
  if (unit === "°" || unit.startsWith(":")) return `${num(v)}${unit}`;
  return `${num(v)}${NBSP}${unit}`;
}

/** "0.15 mm · needs ≥ 0.127" */
export function measureText(m: CheckMeasure): { value: string; need: string | null } {
  // "none allowed" counts read as words: "None found", "3 found · needs none"
  if (zeroCount(m)) return m.value ? { value: `${num(m.value)} found`, need: "needs none" } : { value: "None found", need: null };
  const value = withUnit(m.value, m.unit);
  if (m.limit === undefined) return { value, need: null };
  return { value, need: `needs ${m.op === "<=" ? "≤" : "≥"}${NBSP}${num(m.limit)}` };
}

/** a count that must be zero (shorts, loose ends, DRC errors) */
export const zeroCount = (m: CheckMeasure) => m.unit === "count" && m.limit === 0 && m.op === "<=";

/**
 * How a measured value sits against its limit, for a small bar: the bar's
 * length is value / scale, the mark is the limit. ok: the value meets it.
 * The scale leaves a little room past the larger of the two, so a value right
 * at its limit is visibly at the mark and not at the end of the bar.
 */
export function margin(m: CheckMeasure): { fill: number; mark: number; ok: boolean } | null {
  if (m.limit === undefined || zeroCount(m) || !Number.isFinite(m.value) || !Number.isFinite(m.limit)) return null;
  const lo = Math.min(0, m.value, m.limit);
  const hi = Math.max(m.value, m.limit) * 1.2 - lo * 0.2 || 1;
  const span = hi - lo || 1;
  const ok = m.op === "<=" ? m.value <= m.limit + 1e-9 : m.value >= m.limit - 1e-9;
  return { fill: (m.value - lo) / span, mark: (m.limit - lo) / span, ok };
}

/* ---------- where the board lives ---------- */

export type Place = NonNullable<NonNullable<Design["environment"]>["place"]>;
export interface Range {
  min: number;
  max: number;
}
// ranges a part's datasheet usually names: commercial, extended, industrial, automotive grade 2
export const PRESETS: { id: Place; label: string; min: number; max: number; hint: string }[] = [
  { id: "indoor", label: "Indoor", min: 0, max: 50, hint: "A room, a shelf, a desk" },
  { id: "outdoor", label: "Outdoor", min: -20, max: 60, hint: "A garden, a shed, a wall in the sun" },
  { id: "industrial", label: "Industrial", min: -40, max: 85, hint: "A factory, a cabinet, a machine" },
  { id: "vehicle", label: "In a car", min: -40, max: 105, hint: "Behind a windscreen in summer" },
];

export const DEFAULT_RANGE: Range = { min: 0, max: 50 };

/** the preset a range is, if any */
export const presetOf = (r: Range) => PRESETS.find((p) => p.min === r.min && p.max === r.max) ?? null;

const deg = (n: number) => `${num(n)}${NBSP}°C`;
/** "0 to 50 °C, indoor" */
export function rangeText(r: Range, place?: Place | null): string {
  const p = place ? PRESETS.find((x) => x.id === place) : presetOf(r);
  const span = `${num(r.min)} to ${deg(r.max)}`;
  return p && p.min === r.min && p.max === r.max ? `${span}, ${p.label.toLowerCase()}` : span;
}
export { deg };
