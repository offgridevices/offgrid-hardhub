// The engine client: request shapes, and the NDJSON build stream however the
// network happens to split it.
import { describe, expect, it } from "vitest";
import { emptyDesign } from "@hardhub/protocol";
import { EngineError, HttpEngine } from "../src/engine";

const lines = [
  { step: "place", progress: 0.1, message: "placing 12 parts" },
  { step: "route", progress: 0.5, message: "routing" },
  { done: true, ok: true, checks: [], artifacts: [{ kind: "glb", name: "board.glb", url: "/jobs/b1/files/board.glb" }], stats: { vias: 3 }, placement: {} },
];

function chunked(text: string, size: number) {
  const enc = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(c) {
      for (let i = 0; i < text.length; i += size) c.enqueue(enc.encode(text.slice(i, i + size)));
      c.close();
    },
  });
}

describe("HttpEngine", () => {
  it.each([1, 7, 1000])("reads a build stream split every %i bytes", async (size) => {
    const seen: { path: string; body: unknown }[] = [];
    const engine = new HttpEngine(async (path, init) => {
      seen.push({ path, body: JSON.parse(String(init?.body)) });
      return new Response(chunked(lines.map((l) => JSON.stringify(l)).join("\n"), size));
    });
    const out = [];
    for await (const l of engine.build(emptyDesign("x"), "b1", undefined, "place")) out.push(l);
    expect(out).toHaveLength(3);
    expect(out[2]).toMatchObject({ done: true, ok: true, stats: { vias: 3 } });
    expect(seen[0]).toMatchObject({ path: "/build", body: { job: "b1", stop_after: "place" } });
  });

  it("sends hand edits with the board's KiCad zip, and reads the same stream back", async () => {
    const seen: { path: string; body: Record<string, unknown> }[] = [];
    const engine = new HttpEngine(async (path, init) => {
      seen.push({ path, body: JSON.parse(String(init?.body)) });
      const done = { done: true, ok: false, rejected: true, error: "edit 1 (delete): no track or via with id x on the board", checks: [], artifacts: [] };
      return new Response(chunked([lines[0], done].map((l) => JSON.stringify(l)).join("\n"), 5));
    });
    const zip = new Uint8Array([80, 75, 3, 4, 255]).buffer;
    const out = [];
    for await (const l of engine.edit(emptyDesign("x"), "p-b2", zip, [{ op: "delete", id: "x" }])) out.push(l);
    expect(out.at(-1)).toMatchObject({ done: true, rejected: true, error: expect.stringContaining("no track or via") });
    expect(seen[0]!.path).toBe("/edit");
    expect(seen[0]!.body).toMatchObject({ job: "p-b2", kicad_zip_b64: "UEsDBP8=", edits: [{ op: "delete", id: "x" }], outputs: ["svg", "glb", "png"] });
    expect((seen[0]!.body.design as { name: string }).name).toBe("x");
  });

  it("reports engine failures with their status", async () => {
    const engine = new HttpEngine(async () => new Response("kicad crashed", { status: 500 }));
    await expect(engine.check(emptyDesign())).rejects.toThrow(EngineError);
    await expect(engine.searchParts("esp32")).rejects.toThrow(/500 kicad crashed/);
  });

  it("validates what the engine returns", async () => {
    const engine = new HttpEngine(async () => Response.json({ parts: [{ lcsc: "C1", mpn: "X", prices: [{ qty: 1, usd: 0.1 }] }] }));
    expect(await engine.getParts(["C1"])).toEqual([{ lcsc: "C1", mpn: "X", prices: [{ qty: 1, usd: 0.1 }], lifecycle: "unknown" }]);
  });
});
