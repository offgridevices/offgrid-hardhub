import { describe, expect, it } from "vitest";
import { usbHubDesign } from "../src/fixtures/usb-hub";
import { layoutSheet, netEnd } from "../src/lib/schematic";

describe("schematic sheet", () => {
  const sheet = layoutSheet(usbHubDesign);

  it("draws every part once, in its block", () => {
    const refs = sheet.blocks.flatMap((b) => b.syms.map((s) => s.ref));
    expect(refs.sort()).toEqual(usbHubDesign.components.map((c) => c.ref).sort());
  });

  it("ends every pin in what it connects to", () => {
    for (const s of sheet.blocks.flatMap((b) => b.syms))
      for (const p of s.pins) expect(p.end).toBe(netEnd(p.net, usbHubDesign.nets));
  });

  it("stands two-pin parts with ground at the bottom", () => {
    const twoPin = sheet.blocks.flatMap((b) => b.syms).filter((s) => s.shape !== "box");
    expect(twoPin.length).toBeGreaterThan(0);
    for (const s of twoPin) expect(s.pins[0]!.end).not.toBe("ground");
  });

  it("keeps blocks apart on the sheet", () => {
    const bs = sheet.blocks;
    for (let i = 0; i < bs.length; i++)
      for (let j = i + 1; j < bs.length; j++) {
        const a = bs[i]!;
        const b = bs[j]!;
        const apart = a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y;
        expect(apart).toBe(true);
      }
  });
});
