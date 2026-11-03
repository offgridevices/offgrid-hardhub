import { describe, expect, it } from "vitest";
import { decades, linear, linePath, log, nearest, niceDomain, niceTicks, si } from "../src/lib/scales";

describe("chart scales", () => {
  it("map linearly both ways", () => {
    const x = linear([0, 10], [100, 200]);
    expect(x(5)).toBe(150);
    expect(x.invert(175)).toBe(7.5);
    const flat = linear([3, 3], [0, 10]);
    expect(flat(3)).toBe(0);
  });

  it("map log scales by decade", () => {
    const x = log([1e3, 1e8], [0, 500]);
    expect(x(1e3)).toBeCloseTo(0);
    expect(x(1e5)).toBeCloseTo(200);
    expect(x.invert(300)).toBeCloseTo(1e6);
    expect(decades(1e3, 1e8)).toEqual([1e3, 1e4, 1e5, 1e6, 1e7, 1e8]);
    expect(decades(0.004, 0.9)).toEqual([0.01, 0.1]);
  });

  it("put ticks on round numbers", () => {
    expect(niceTicks(0, 100, 5)).toEqual([0, 20, 40, 60, 80, 100]);
    expect(niceTicks(3.13, 3.31, 4)).toEqual([3.15, 3.2, 3.25, 3.3]);
    expect(niceTicks(0.1, 0.35, 5)).toEqual([0.1, 0.15, 0.2, 0.25, 0.3, 0.35]);
    expect(niceDomain(3.13, 3.31, 4)).toEqual([3.1, 3.35]);
  });

  it("find the nearest sample and draw a path", () => {
    expect(nearest([1, 2, 4, 8], 5)).toBe(2);
    expect(nearest([1, 2, 4, 8], 7)).toBe(3);
    expect(nearest([], 1)).toBe(-1);
    const s = linear([0, 1], [0, 10]);
    expect(linePath([0, 1], [0, 1], s, s)).toBe("M0.0 0.0L10.0 10.0");
  });

  it("write SI prefixes", () => {
    expect(si(1000, "Hz")).toBe("1 kHz");
    expect(si(1e8, "Hz")).toBe("100 MHz");
    expect(si(0.33, "Ω")).toBe("330 mΩ");
    expect(si(2.5, "Ω")).toBe("2.5 Ω");
    expect(si(0.0036, "W")).toBe("3.6 mW");
  });
});
