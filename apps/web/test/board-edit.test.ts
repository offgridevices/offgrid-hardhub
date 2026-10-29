import { describe, expect, it } from "vitest";
import type { BoardGeometry } from "@hardhub/protocol";
import { applyEdits, compact, describe as say, dragEnd, dragVia, placeEdits } from "../src/lib/board-edit";

// two tracks meeting at a via, and a part with one pad at the far end
const g: BoardGeometry = {
  units: "mm",
  origin: [100, 50],
  size: [40, 30],
  layers: ["F.Cu", "B.Cu"],
  tracks: [
    { id: "t1", layer: "F.Cu", net: "SIG", width: 0.25, a: [5, 5], b: [10, 5] },
    { id: "t2", layer: "B.Cu", net: "SIG", width: 0.25, a: [10, 5], b: [20, 5] },
    { id: "t3", layer: "F.Cu", net: "SIG", width: 0.25, a: [30, 5], b: [30, 10] },
  ],
  vias: [{ id: "v1", x: 10, y: 5, d: 0.6, drill: 0.3, net: "SIG", from: "F.Cu", to: "B.Cu" }],
  footprints: [
    {
      ref: "R1",
      x: 30,
      y: 12,
      rot: 0,
      side: "top",
      locked: false,
      bbox: [28, 9, 32, 15],
      pads: [
        { num: "1", net: "SIG", x: 30, y: 10, w: 1, h: 1, rot: 0, shape: "rect", through: false },
        { num: "2", net: "GND", x: 30, y: 14, w: 1, h: 1, rot: 0, shape: "rect", through: false },
      ],
    },
  ],
  zones: [],
  rules: { track_min: 0.127, clearance: 0.127, via_d: 0.6, via_drill: 0.3 },
};

describe("hand edits", () => {
  it("drags a via with the tracks on both layers that end on it", () => {
    const e = dragVia(g, g.vias[0]!, [12, 7]);
    const b = applyEdits(g, e);
    expect(b.vias[0]).toMatchObject({ x: 12, y: 7 });
    expect(b.tracks.find((t) => t.id === "t1")!.b).toEqual([12, 7]);
    expect(b.tracks.find((t) => t.id === "t2")!.a).toEqual([12, 7]);
  });

  it("drags a track's end and the via sitting on it", () => {
    const b = applyEdits(g, dragEnd(g, g.tracks[0]!, "b", [11, 6]));
    expect(b.vias[0]).toMatchObject({ x: 11, y: 6 });
    expect(b.tracks.find((t) => t.id === "t2")!.a).toEqual([11, 6]);
  });

  it("moves a part and stretches the tracks ending on its pads", () => {
    const b = applyEdits(g, placeEdits(g, g.footprints[0]!, 33, 12, 0));
    expect(b.footprints[0]!.pads[0]).toMatchObject({ x: 33, y: 10 });
    expect(b.tracks.find((t) => t.id === "t3")!.b).toEqual([33, 10]);
  });

  it("turns a part about its anchor", () => {
    const b = applyEdits(g, placeEdits(g, g.footprints[0]!, 30, 12, 90));
    // pad 1 was 2 mm above the anchor; a quarter turn counter-clockwise puts it 2 mm left
    expect(b.footprints[0]!.pads[0]!.x).toBeCloseTo(28);
    expect(b.footprints[0]!.pads[0]!.y).toBeCloseTo(12);
  });

  it("turns a bottom part the other way, as KiCad mirrors it", () => {
    const bottom = { ...g.footprints[0]!, side: "bottom" as const };
    const b = applyEdits({ ...g, footprints: [bottom] }, placeEdits({ ...g, footprints: [bottom] }, bottom, 30, 12, 90));
    // seen from the top, a quarter turn of a bottom part goes clockwise: pad 1 ends up right of the anchor
    expect(b.footprints[0]!.pads[0]!.x).toBeCloseTo(32);
    expect(b.footprints[0]!.pads[0]!.y).toBeCloseTo(12);
  });

  it("keeps an arc's shape when it is moved", () => {
    const arc = { id: "a1", layer: "F.Cu", net: "SIG", width: 0.2, a: [0, 0] as [number, number], b: [4, 0] as [number, number], mid: [2, 2] as [number, number] };
    const b = applyEdits({ ...g, tracks: [arc] }, [{ op: "set_track", id: "a1", a: [1, 1], b: [5, 1] }]);
    expect(b.tracks[0]!.mid).toEqual([3, 3]);
  });

  it("sends the fewest edits: the last move wins, a drawn-then-deleted track is not sent", () => {
    const edits = [
      ...dragVia(g, g.vias[0]!, [11, 5]),
      ...dragVia(applyEdits(g, dragVia(g, g.vias[0]!, [11, 5])), g.vias[0]!, [12, 5]),
      { op: "add_track" as const, layer: "F.Cu", a: [1, 1] as [number, number], b: [2, 2] as [number, number] },
      { op: "delete" as const, id: "new:0" },
    ];
    const c = compact(edits);
    expect(c.filter((e) => e.op === "set_via")).toHaveLength(1);
    expect(c.some((e) => e.op === "add_track")).toBe(false);
    expect(applyEdits(g, c).vias[0]).toMatchObject(applyEdits(g, edits).vias[0]!);
  });

  it("says what was done in plain words", () => {
    expect(say(dragVia(g, g.vias[0]!, [12, 7]))).toBe("changed 2 tracks, moved a via");
  });
});
