import { describe, expect, it } from "vitest";
import { CheckResult, ServerEvent, TestReport } from "@hardhub/protocol";
import { sensorHistory } from "../src/fixtures/script";
import { replay } from "../src/lib/project-state";
import {
  AREAS,
  areaOf,
  byArea,
  counts,
  defaultFilter,
  margin,
  matches,
  measureText,
  num,
  planRows,
  presetOf,
  rangeText,
  verdict,
  verdictTitle,
  withUnit,
} from "../src/lib/tests";
import { CATALOG } from "../src/fixtures/catalog";
import { planOf, runLabel, sensorChecks, sensorReport } from "../src/fixtures/sensor-tests";

const c = (id: string, status: CheckResult["status"], group: CheckResult["group"] = "copper"): CheckResult => ({ id, group, name: id, why: "", status });

describe("the verdict", () => {
  it("says what needs doing first: fixes, then things to look at, then ready", () => {
    expect(verdictTitle(counts([]))).toBe("Not tested yet");
    expect(verdictTitle(counts([c("a", "pass"), c("b", "na")]))).toBe("Ready to order");
    expect(verdictTitle(counts([c("a", "warn"), c("b", "warn"), c("c", "pass")]))).toBe("2 to look at");
    expect(verdictTitle(counts([c("a", "fail"), c("b", "warn")]))).toBe("1 thing to fix");
    expect(verdictTitle(counts([c("a", "fail"), c("b", "fail")]))).toBe("2 things to fix");
    expect(verdict(counts([c("a", "skip")]))).toBe("ready");
  });

  it("opens on what to fix when there is any, else on everything", () => {
    expect(defaultFilter(counts([c("a", "fail"), c("b", "pass")]))).toBe("fail");
    expect(defaultFilter(counts([c("a", "warn")]))).toBe("all");
    expect(matches(c("a", "warn"), "warn")).toBe(true);
    expect(matches(c("a", "warn"), "fail")).toBe(false);
    expect(matches(c("a", "na"), "all")).toBe(true);
  });
});

describe("areas", () => {
  it("keeps the engine's order and moves old groups to their new areas", () => {
    expect(AREAS.map((a) => a.id)).toEqual([
      "connections",
      "copper",
      "holes",
      "silkscreen",
      "mask",
      "placement",
      "power",
      "thermal",
      "stress",
      "signals",
      "firmware",
      "sourcing",
      "fab",
    ]);
    expect(areaOf("circuit")).toBe("connections");
    expect(areaOf("layout")).toBe("copper");
    const g = byArea([c("x", "pass", "fab"), c("y", "pass", "circuit"), c("z", "fail", "layout"), c("w", "pass", "connections")]);
    expect(g.map((x) => x.area.id)).toEqual(["connections", "copper", "fab"]);
    expect(g[0]!.items.map((i) => i.id)).toEqual(["y", "w"]);
  });

  it("pairs each planned check with its result once it lands", () => {
    const rows = planRows(
      [
        { id: "a", group: "copper", name: "A" },
        { id: "b", group: "copper", name: "B" },
      ],
      { b: c("b", "pass") },
    );
    expect(rows.map((r) => !!r.result)).toEqual([false, true]);
  });
});

describe("a measured number", () => {
  it("is written the way an engineer writes it", () => {
    expect(num(0.15)).toBe("0.15");
    expect(num(0.127)).toBe("0.127");
    expect(num(1.5)).toBe("1.5");
    expect(num(88.44)).toBe("88.4");
    expect(num(120)).toBe("120");
    expect(num(7685)).toBe("7,685");
    expect(num(-20)).toBe("−20");
    expect(withUnit(0.15, "mm")).toBe("0.15 mm");
    expect(withUnit(3, "count")).toBe("3");
    expect(withUnit(135, "°")).toBe("135°");
    expect(measureText({ label: "narrowest track", value: 0.15, unit: "mm", limit: 0.127, op: ">=" })).toEqual({ value: "0.15 mm", need: "needs ≥ 0.127" });
    expect(measureText({ label: "x", value: 2, unit: "V" }).need).toBeNull();
  });

  it("sits against its limit on a small bar, either way round", () => {
    const at = margin({ label: "", value: 0.15, unit: "mm", limit: 0.127, op: ">=" })!;
    expect(at.ok).toBe(true);
    expect(at.fill).toBeGreaterThan(at.mark);
    expect(at.fill).toBeLessThan(1);
    const over = margin({ label: "", value: 7.4, unit: "mm", limit: 3, op: "<=" })!;
    expect(over.ok).toBe(false);
    expect(over.fill).toBeGreaterThan(over.mark);
    const under = margin({ label: "", value: 52, unit: "°C", limit: 105, op: "<=" })!;
    expect(under.ok).toBe(true);
    expect(under.fill).toBeLessThan(under.mark);
    // negative values (a cold day) still land inside the bar
    const cold = margin({ label: "", value: -40, unit: "°C", limit: -30, op: ">=" })!;
    expect(cold.ok).toBe(false);
    expect(cold.fill).toBeGreaterThanOrEqual(0);
    expect(cold.mark).toBeLessThanOrEqual(1);
    expect(margin({ label: "", value: 1, unit: "V" })).toBeNull();
  });
});

describe("temperature ranges", () => {
  it("names a preset range and leaves others as numbers", () => {
    expect(rangeText({ min: 0, max: 50 })).toBe("0 to 50 °C, indoor");
    expect(rangeText({ min: -20, max: 60 }, "outdoor")).toBe("−20 to 60 °C, outdoor");
    expect(rangeText({ min: 5, max: 40 })).toBe("5 to 40 °C");
    expect(rangeText({ min: 5, max: 40 }, "indoor")).toBe("5 to 40 °C");
    expect(presetOf({ min: -40, max: 85 })?.id).toBe("industrial");
  });
});

describe("demo tests", () => {
  it("run every check of the catalogue, as valid results, with a few to fix and to look at", () => {
    const checks = sensorChecks({ min: 0, max: 50 });
    expect(checks.length).toBe(CATALOG.length);
    for (const x of checks) CheckResult.parse(x);
    const n = counts(checks);
    expect(n.fail).toBe(2);
    expect(n.warn).toBeGreaterThanOrEqual(3);
    expect(n.na).toBeGreaterThan(0);
    // a fix is only given for what needs one
    for (const x of checks) if (x.fix) expect(["fail", "warn"]).toContain(x.status);
    expect(planOf(checks).every((p) => typeof p.name === "string")).toBe(true);
    expect(runLabel({ id: "heat-board", group: "thermal" }, { min: 0, max: 50 })).toBe("Simulating heat at 50 °C");
  });

  it("fail more on a hotter, colder range", () => {
    const indoor = counts(sensorChecks({ min: 0, max: 50 }));
    const car = sensorChecks({ min: -40, max: 105 });
    expect(counts(car).fail).toBeGreaterThan(indoor.fail);
    expect(car.find((x) => x.id === "heat-parts-cold")?.status).toBe("fail");
  });

  it("make a report the protocol accepts, with a heat map for each outside temperature", () => {
    const checks = sensorChecks({ min: 0, max: 50 });
    const r = TestReport.parse(sensorReport({ min: 0, max: 50 }, checks, "2026-11-02T11:00:00Z"));
    expect(r.ambient.points).toEqual([0, 25, 50]);
    expect(r.thermal!.maps).toHaveLength(3);
    expect(r.board.layers).toBe(2);
    expect(r.summary.verdict).toBe("fix");
    const z = r.power.pdn[0]!.z as number[];
    expect(Math.max(...z)).toBeLessThan(r.power.pdn[0]!.target_ohm as number);
  });

  it("tell the sensor's story as valid events: built, tested, checks and report", () => {
    const checks = sensorChecks({ min: 0, max: 50 });
    const steps = sensorHistory({ plan: planOf(checks), checks, summary: "s", label: "l", reportUrl: "blob:x" });
    const events = steps.map(({ delay: _d, ...e }, seq) => ServerEvent.parse({ ...e, seq, at: "2026-11-02T11:00:00Z" }));
    const s = replay(events);
    expect(s.testRun).toMatchObject({ phase: "done", settled: true });
    expect(s.checks).toHaveLength(checks.length);
    expect(s.artifacts.some((a) => a.kind === "report" && a.name.endsWith("-tests.json"))).toBe(true);
  });
});

describe("a finished run's results", () => {
  const at = "2026-11-03T00:00:00Z";
  const ev = (seq: number, e: Record<string, unknown>) => ServerEvent.parse({ seq, at, ...e });
  const old = [c("lcsc", "warn", "sourcing"), c("shorts", "pass", "connections")];

  it("replace the list when they come straight after the run", () => {
    const s = replay([
      ev(0, { type: "checks", results: old }),
      ev(1, { type: "test_run", run: "b2", phase: "start", plan: [{ id: "shorts", group: "connections", name: "x" }] }),
      ev(2, { type: "test_run", run: "b2", phase: "done", ok: true }),
      ev(3, { type: "checks", results: [c("shorts", "fail", "connections")] }),
    ]);
    expect(s.checks.map((x) => `${x.id}:${x.status}`)).toEqual(["shorts:fail"]);
  });

  it("a run that ended in an error replaces nothing, and later checks merge as before", () => {
    const s = replay([
      ev(0, { type: "checks", results: old }),
      ev(1, { type: "test_run", run: "b2", phase: "start", plan: [] }),
      ev(2, { type: "test_run", run: "b2", phase: "done", ok: false, summary: "the engine stopped" }),
      ev(3, { type: "error", message: "the engine stopped", retryable: true }),
      ev(4, { type: "checks", results: [c("pins-pads", "pass", "connections")] }),
    ]);
    expect(s.checks.map((x) => x.id).sort()).toEqual(["lcsc", "pins-pads", "shorts"]);
  });
});
