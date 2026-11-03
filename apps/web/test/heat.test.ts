import { describe, expect, it } from "vitest";
import { cellAt, decodeU8, encodeU8, heatColor, heatField, heatLut, lightness, oklchToRgb, paint } from "../src/lib/heat";

describe("heat colours", () => {
  it("convert OKLCH to sRGB the standard way", () => {
    expect(oklchToRgb(1, 0, 0)).toEqual([255, 255, 255]);
    expect(oklchToRgb(0, 0, 0)).toEqual([0, 0, 0]);
    // a mid grey: L 0.6 is about #848484
    const [r, g, b] = oklchToRgb(0.6, 0, 0);
    expect(r).toBe(g);
    expect(g).toBe(b);
    expect(Math.abs(lightness([r, g, b]) - 0.6)).toBeLessThan(0.01);
  });

  it("step lightness steadily from cool to hot: pale to dark on light, dark to bright on dark", () => {
    for (const mode of ["light", "dark"] as const) {
      const L = Array.from({ length: 33 }, (_, i) => lightness(heatColor(i / 32, mode)));
      const steps = L.slice(1).map((v, i) => v - L[i]!);
      if (mode === "light") expect(steps.every((d) => d < 0)).toBe(true);
      else expect(steps.every((d) => d > 0)).toBe(true);
      // enough spread to read, end to end
      expect(Math.abs(L[32]! - L[0]!)).toBeGreaterThan(0.4);
    }
  });

  it("make a 256-colour table", () => {
    const lut = heatLut("dark");
    expect(lut.length).toBe(1024);
    expect(lut[3]).toBe(255);
  });
});

describe("heat maps", () => {
  const grid = { x0: -2, y0: -1, dx: 1, dy: 1, nx: 4, ny: 2 };
  const mask = encodeU8(new Uint8Array([0, 1, 1, 1, 1, 1, 1, 0]));
  const thermal = {
    grid,
    mask,
    parts: [],
    maps: [
      { ambient: 0, min: 10, max: 20, u8: encodeU8(new Uint8Array([0, 0, 255, 128, 0, 0, 0, 0])) },
      { ambient: 50, min: 60, max: 70, u8: encodeU8(new Uint8Array([0, 0, 255, 0, 0, 0, 0, 0])) },
    ],
  };

  it("round-trip bytes through base64", () => {
    const u = new Uint8Array([0, 1, 254, 255]);
    expect([...decodeU8(encodeU8(u))]).toEqual([0, 1, 254, 255]);
  });

  it("turn bytes back into degrees, with one scale over every map", () => {
    const f = heatField(thermal);
    expect(f.temps[0]![2]).toBeCloseTo(20);
    expect(f.temps[0]![3]).toBeCloseTo(10 + (128 / 255) * 10);
    expect(Number.isNaN(f.temps[0]![0]!)).toBe(true);
    expect(f.lo).toBe(10);
    expect(f.hi).toBe(70);
  });

  it("find the cell under a point, from the grid's corner", () => {
    expect(cellAt(grid, -2, -1)).toBe(0);
    expect(cellAt(grid, 0.5, -0.5)).toBe(2);
    expect(cellAt(grid, 1.5, 0.5)).toBe(7);
    expect(cellAt(grid, 2.5, 0)).toBe(-1);
  });

  it("paint off the board transparent", () => {
    const px = paint(heatField(thermal), 0, heatLut("light"));
    expect(px[3]).toBe(0);
    expect(px[7]).toBe(255);
  });
});
