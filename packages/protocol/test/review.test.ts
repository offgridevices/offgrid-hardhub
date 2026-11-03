// A report exactly as the engine wrote it (the ESP32-C3 sensor board, built in
// KiCad with the board tests): the web app must be able to read it. Remake it
// with the engine's test step when the report changes shape.
import { describe, expect, it } from "vitest";
import { TestReport } from "../src/review";
import raw from "./fixtures/sensor-tests.json";

describe("the engine's test report", () => {
  it("parses with the schema the clients use", () => {
    const r = TestReport.safeParse(raw);
    expect(r.success ? [] : r.error.issues.slice(0, 5)).toEqual([]);
  });

  it("holds the heat maps, the power tree and the stackup", () => {
    const r = TestReport.parse(raw);
    expect(r.thermal?.maps.map((m) => m.ambient)).toEqual([0, 25, 50]);
    const { nx, ny } = r.thermal!.grid;
    expect(atob(r.thermal!.maps[0]!.u8).length).toBe(nx * ny);
    expect(r.power.tree.map((n) => n.net).sort()).toEqual(["+3V3", "VBUS"]);
    expect(r.board.stackup.filter((s) => s.kind === "copper")).toHaveLength(2);
  });
});

describe("an older report, with empty fields written as null", () => {
  it("still parses, the empty fields read as missing", () => {
    const old = structuredClone(raw) as { thermal: { parts: Record<string, unknown>[] }; power: { tree: Record<string, unknown>[] }; tools: Record<string, unknown> };
    old.thermal.parts[0]!.how = null;
    old.power.tree[0]!.from = null;
    old.tools["hardhub-sim"] = { name: "hardhub-sim", version: "0.1.0" };
    const r = TestReport.parse(old);
    expect(r.thermal!.parts[0]!.how).toBeUndefined();
    expect(r.power.tree[0]!.from).toBeUndefined();
  });
});

describe("what a newer engine may send", () => {
  it("reads unknown steps, check groups and statuses instead of failing", async () => {
    const { JobLine, CheckResult } = await import("../src/index");
    expect(JobLine.safeParse({ step: "simulate-emc", progress: 0.5, message: "new step" }).success).toBe(true);
    const c = CheckResult.parse({ id: "x", group: "emc", name: "n", why: "w", status: "info" });
    expect([c.group, c.status]).toEqual(["fab", "skip"]);
  });
});
