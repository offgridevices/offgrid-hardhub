import { describe, expect, it } from "vitest";
import { demoLayers, demoScene } from "../src/workers/geometry";
import { usbHubDesign } from "../src/fixtures/usb-hub";

describe("demo geometry", () => {
  it("draws one SVG per copper layer plus print and outline, all on the board's own frame", () => {
    const l = demoLayers(usbHubDesign);
    expect(Object.keys(l).sort()).toEqual(["B.Cu", "B.Silkscreen", "Edge.Cuts", "F.Cu", "F.Silkscreen", "In1.Cu", "In2.Cu"]);
    for (const svg of Object.values(l)) expect(svg).toContain('viewBox="-43 -25 86 50"');
    // planes are drawn as fills on their inner layers, not as tracks
    expect(l["In1.Cu"]).toContain("fill-opacity");
  });

  it("merges parts into one mesh per colour and side", () => {
    const s = demoScene(usbHubDesign);
    expect(s.meshes.length).toBeLessThan(12);
    expect(s.meshes.filter((m) => m.group === "board")).toHaveLength(1);
    const boxes = s.meshes.filter((m) => m.group !== "board").reduce((n, m) => n + m.index.length / 36, 0);
    expect(boxes).toBe(usbHubDesign.components.length);
    for (const m of s.meshes) expect(m.positions.length).toBe(m.normals.length);
  });
});
