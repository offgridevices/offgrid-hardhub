// A report exactly as the engine wrote it (the ESP32-C3 sensor board, built in
// KiCad with the board tests): the web app must be able to read it. Remake it
// with the engine's test step when the report changes shape.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { TestReport } from "../src/review";

const raw = JSON.parse(readFileSync(new URL("./fixtures/sensor-tests.json", import.meta.url), "utf8"));

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
