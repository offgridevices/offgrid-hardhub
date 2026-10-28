// What the AI can do. It never touches files or a shell: every action is one
// of these tools, each with a schema that its input is checked against before
// it runs. A bad call comes back as a plain error the model can fix.
import {
  type Artifact,
  type CheckResult,
  Comparison,
  Design,
  Firmware,
  Question,
  Stage,
  type ServerEvent,
  netMembers,
} from "@hardhub/protocol";
import jsonpatch, { type Operation } from "fast-json-patch";
import { z } from "zod";
import { type Engine, EngineError, type NeedBoard, type ViewOptions } from "../engine";
import type { ToolCall, ToolImage, ToolOutcome, ToolSpec } from "./llm/types";
import type { ToolRun } from "./loop";

/** a ServerEvent before the room gives it a seq and a time */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type EventInput = DistributiveOmit<ServerEvent, "seq" | "at">;

export interface ToolContext {
  projectId: string;
  engine: Engine;
  design(): { design: Design; version: number };
  /** stores a new design version and tells every client */
  saveDesign(design: Design, summary: string): number;
  emit(e: EventInput): void;
  putFile(name: string, body: ReadableStream | ArrayBuffer, contentType: string): Promise<void>;
  getFile(name: string): Promise<ArrayBuffer | null>;
  nextJob(): string;
  /** names of the board renders from the last build */
  renders(): string[];
  setRenders(names: string[]): void;
  /** the last build that made files: its engine job and its KiCad zip in the file store */
  lastBuild(): { job: string; kicad: string } | null;
  setLastBuild(b: { job: string; kicad: string }): void;
  /** the model can look at images */
  vision: boolean;
}

interface Tool<S extends z.ZodType> {
  description: string;
  schema: S;
  label(input: z.infer<S>): string;
  run(input: z.infer<S>, ctx: ToolContext, call: ToolCall, signal: AbortSignal): Promise<Omit<ToolRun, "outcome"> & { content: string; images?: ToolImage[]; isError?: boolean }>;
}

const tool = <S extends z.ZodType>(t: Tool<S>) => t;
const json = (v: unknown) => JSON.stringify(v, null, 1);

// ------------------------------------------------------------------ schemas

const AskInput = z.object({
  questions: z.array(Question).min(1).max(4).describe("1-4 questions shown together; put the recommended option first and mark it recommended"),
});

const PatchOp = z.object({
  op: z.enum(["add", "remove", "replace", "move", "copy", "test"]),
  path: z.string().describe('JSON pointer into the design, e.g. "/parts/ESP32S3" or "/components/-"'),
  value: z.unknown().optional(),
  from: z.string().optional(),
});

const UpdateInput = z.object({
  summary: z.string().min(3).max(200).describe("one plain sentence saying what changed, shown to the person"),
  patch: z.array(PatchOp).min(1).max(200),
});

const BUILD_STEPS = ["validate", "footprints", "place", "route", "miter", "pour", "drc", "verify", "fab", "render"] as const;

const FIRMWARE_PATH = /^(?!.*\.\.)[\w][\w./-]{0,119}$/;

const LAYER = z.string().regex(/^((F|B)\.(Cu|Silkscreen|Mask|Paste|Fab|Courtyard)|In\d{1,2}\.Cu|Edge\.Cuts)$/, "a KiCad layer name like F.Cu, In1.Cu, F.Silkscreen, B.Mask, Edge.Cuts");

const ViewInput = z.object({
  mode: z.enum(["2d", "3d"]).default("2d").describe("2d: a drawing of chosen layers with a millimetre grid; 3d: KiCad's render"),
  layers: z.array(LAYER).min(1).max(12).optional().describe("2d: which layers, e.g. [\"F.Cu\", \"F.Silkscreen\", \"Edge.Cuts\"]; default the side's copper, silkscreen and outline"),
  side: z.enum(["top", "bottom", "left", "right", "front", "back"]).default("top").describe("2d: top or bottom (bottom is seen from below, x mirrored). 3d: the camera's side"),
  region: z.tuple([z.number(), z.number(), z.number(), z.number()]).optional().describe("2d: zoom to [x0, y0, x1, y1], board mm from the centre"),
  net: z.string().max(100).optional().describe("2d: highlight this net's copper"),
  parts: z.array(z.string().regex(/^[A-Z]+\d+$/)).max(20).optional().describe("2d: outline these parts (refs)"),
  labels: z.boolean().optional().describe("2d: write each part's ref at its centre (default: unless the silkscreen is shown)"),
  rotate: z.tuple([z.number(), z.number(), z.number()]).optional().describe("3d: rotate the board [x, y, z] degrees; [-45, 0, 45] is an isometric view"),
  zoom: z.number().min(0.2).max(10).default(1).describe("3d: camera zoom"),
  perspective: z.boolean().default(false).describe("3d: perspective instead of orthographic"),
  quality: z.enum(["basic", "high"]).default("basic").describe("3d: high is ray-traced and slower"),
  width: z.number().int().min(400).max(2000).default(1400).describe("image width in pixels"),
});

const MoveInput = z.object({
  summary: z.string().min(3).max(200).describe("one plain sentence saying what moved and why"),
  moves: z
    .array(
      z.object({
        ref: z.string().regex(/^[A-Z]+\d+$/),
        x: z.number().optional(),
        y: z.number().optional(),
        rot: z.number().optional().describe("degrees, counter-clockwise"),
        side: z.enum(["top", "bottom"]).optional(),
        locked: z.boolean().optional().describe("true: the automatic placement must not move it"),
      }),
    )
    .min(1)
    .max(100),
});

// ------------------------------------------------------------------ tools

export const TOOLS = {
  ask_user: tool({
    description:
      "Ask the person 1-4 multiple-choice questions and wait for their answers. Plain words, no jargon. The recommended option goes first, marked recommended, with its reason in detail. Ends your turn: the answers arrive as this tool's result.",
    schema: AskInput,
    label: (i) => `Asking ${i.questions.length} question${i.questions.length > 1 ? "s" : ""}`,
    async run(i, ctx, call) {
      ctx.emit({ type: "questions", id: call.id, questions: i.questions });
      return { content: "Shown to the person; waiting for their answer.", waitForUser: true };
    },
  }),

  get_design: tool({
    description: "Read the current design document (all of it, or only the named top-level sections).",
    schema: z.object({ sections: z.array(z.string()).optional().describe('e.g. ["requirements", "parts"]; omit for everything') }),
    label: () => "Reading the design",
    async run(i, ctx) {
      const { design, version } = ctx.design();
      const out = i.sections?.length ? Object.fromEntries(i.sections.map((s) => [s, (design as Record<string, unknown>)[s]])) : design;
      return { content: `version ${version}\n${json(out)}` };
    },
  }),

  update_design: tool({
    description:
      "Change the design with an RFC 6902 JSON Patch. The result must still be a valid design; if not, nothing changes and you get the errors. Use it for requirements, decisions, blocks, parts, components (pin-by-pin nets), nets, board, placement.",
    schema: UpdateInput,
    label: (i) => i.summary,
    async run(i, ctx) {
      const { design } = ctx.design();
      let next: unknown;
      try {
        next = jsonpatch.applyPatch(structuredClone(design), i.patch as Operation[], true, false).newDocument;
      } catch (e) {
        // fast-json-patch's message carries the whole document ("tree: ..."):
        // keep the reason and the failing operation, not the design again
        const err = e as { name?: string; index?: number; operation?: unknown; message?: string };
        const why = String(err.message ?? e).split("\n")[0];
        const op = err.operation ? ` at operation ${err.index ?? "?"}: ${JSON.stringify(err.operation).slice(0, 300)}` : "";
        const hint = err.name === "OPERATION_PATH_UNRESOLVABLE" ? " (use \"add\" for a field that is not there yet)" : "";
        return { content: `Patch not applied: ${why}${op}${hint}`, isError: true };
      }
      const parsed = Design.safeParse(next);
      if (!parsed.success) {
        const issues = parsed.error.issues.slice(0, 12).map((x) => `${x.path.join("/") || "(root)"}: ${x.message}`);
        return { content: `Patch not applied, the design would be invalid:\n${issues.join("\n")}`, isError: true };
      }
      const version = ctx.saveDesign(parsed.data, i.summary);
      return { content: `Saved as version ${version}.${warnings(parsed.data)}` };
    },
  }),

  search_parts: tool({
    description: "Search the JLCPCB/LCSC catalogue: live price breaks, stock, basic/extended tier, package, lifecycle.",
    schema: z.object({ query: z.string().min(2).max(120), limit: z.number().int().min(1).max(20).optional() }),
    label: (i) => `Searching parts: ${i.query}`,
    async run(i, ctx) {
      const parts = await ctx.engine.searchParts(i.query, i.limit ?? 8);
      return { content: parts.length ? json(parts) : "No parts found. Try the manufacturer part number or a broader term." };
    },
  }),

  get_part: tool({
    description: "Look up exact LCSC part numbers (C123456): price, stock, tier, lifecycle, datasheet.",
    schema: z.object({ lcsc: z.array(z.string().regex(/^C\d+$/)).min(1).max(20) }),
    label: (i) => `Checking ${i.lcsc.join(", ")}`,
    async run(i, ctx) {
      return { content: json(await ctx.engine.getParts(i.lcsc)) };
    },
  }),

  propose_options: tool({
    description:
      "Show the person a comparison table (part candidates, layer counts, board sizes). Mark the recommended row. Cite sources and dates in note. Follow with ask_user to let them pick.",
    schema: Comparison.omit({ id: true }),
    label: (i) => `Comparing: ${i.title}`,
    async run(i, ctx, call) {
      ctx.emit({ type: "comparison", comparison: { ...i, id: call.id } });
      return { content: "Shown to the person." };
    },
  }),

  check_circuit: tool({
    description: "Run the circuit checks on the current design (every pin wired or marked open, no one-pin nets, footprints match, LCSC numbers, MCU pin rules).",
    schema: z.object({}),
    label: () => "Checking the circuit",
    async run(_i, ctx) {
      const results = await ctx.engine.check(ctx.design().design);
      ctx.emit({ type: "checks", results });
      return { content: summarizeChecks(results) };
    },
  }),

  build_board: tool({
    description:
      "Lay out, route and check the board in KiCad: place parts (yours, plus automatic placement for unplaced ones), route, 45-degree corners, ground pour, DRC with the fab's limits, net check, fab files, renders. Takes minutes. Needs design.board.",
    schema: z.object({ stop_after: z.enum(BUILD_STEPS).optional().describe("stop early, e.g. after place to review placement") }),
    label: (i) => (i.stop_after ? `Building the board (up to ${i.stop_after})` : "Building the board"),
    async run(i, ctx, _call, signal) {
      const { design } = ctx.design();
      if (!design.board) return { content: "The design has no board yet: set /board (size, layers) first.", isError: true };
      const job = ctx.nextJob();
      for await (const line of ctx.engine.build(design, job, signal, i.stop_after)) {
        if (!("done" in line)) {
          ctx.emit({ type: "job", job, step: line.step, progress: line.progress, done: false });
          continue;
        }
        ctx.emit({ type: "job", job, step: "done", progress: 1, done: true, ok: line.ok });
        if (line.checks.length) ctx.emit({ type: "checks", results: line.checks });
        const stored = await storeArtifacts(ctx, job, line.artifacts);
        if (stored.length) ctx.emit({ type: "artifacts", artifacts: stored });
        const renders = stored.filter((a) => a.kind === "board-png").map((a) => a.name);
        if (renders.length) ctx.setRenders(renders);
        const kicad = stored.find((a) => a.kind === "kicad");
        if (kicad) ctx.setLastBuild({ job, kicad: kicad.name });
        // keep the engine's placement for parts the design left unplaced
        const added = Object.entries(line.placement).filter(([ref]) => !(ref in design.placement));
        if (added.length) {
          const cur = ctx.design().design;
          const next = { ...cur, placement: { ...cur.placement } };
          for (const [ref, p] of added) next.placement[ref] = { ...p, locked: false };
          ctx.saveDesign(next, `Placed ${added.length} parts automatically`);
        }
        const stats = Object.entries(line.stats).map(([k, v]) => `${k} ${v}`).join(", ");
        return {
          content: [
            line.ok ? "Build finished." : `Build failed${line.error ? `: ${line.error}` : "."}`,
            stats && `Stats: ${stats}.`,
            summarizeChecks(line.checks),
            stored.length ? `Files: ${stored.map((a) => a.name).join(", ")}.` : "",
            renders.length ? "Call render to look at the board." : "",
          ]
            .filter(Boolean)
            .join("\n"),
          isError: !line.ok,
        };
      }
      return { content: "The engine stopped without a result.", isError: true };
    },
  }),

  render: tool({
    description: "Look at the board renders from the last build_board, to judge placement and routing yourself.",
    schema: z.object({ name: z.string().optional().describe("one render's file name; omit for all (at most 2)") }),
    label: () => "Looking at the board",
    async run(i, ctx) {
      const names = ctx.renders().filter((n) => !i.name || n === i.name).slice(0, 2);
      if (!names.length) return { content: "No renders yet: run build_board first.", isError: true };
      if (!ctx.vision) return { content: `This model cannot look at images. Renders exist: ${names.join(", ")}.` };
      const images: ToolImage[] = [];
      for (const n of names) {
        const buf = await ctx.getFile(n);
        if (buf) images.push({ mediaType: "image/png", data: base64(buf) });
      }
      return { content: `Renders: ${names.join(", ")}`, images };
    },
  }),

  view_board: tool({
    description:
      "Look at the built board as an image, to check your own work: any layers (copper, silkscreen, solder mask, paste, fab drawing, courtyard, outline), top or bottom, zoomed into a region, with a net highlighted or parts outlined, on a millimetre grid in board coordinates (from the centre, x right, y down). Or a 3D render from any side and angle. Shows the last build_board result: rebuild after changes.",
    schema: ViewInput,
    label: (i) => (i.mode === "3d" ? "Looking at the board in 3D" : `Looking at ${i.layers?.join(", ") ?? `the ${i.side} side`}${i.net ? `, net ${i.net}` : ""}`),
    async run(i, ctx) {
      if (!ctx.vision) return { content: "This model cannot look at images; use inspect_board for the same facts as data.", isError: true };
      const opts: ViewOptions =
        i.mode === "3d"
          ? { mode: "3d", side: i.side, zoom: i.zoom, perspective: i.perspective, quality: i.quality, width: Math.min(i.width, 1600), height: Math.round(Math.min(i.width, 1600) * 0.75), ...(i.rotate ? { rotate: i.rotate } : {}) }
          : {
              mode: "2d",
              side: i.side === "bottom" ? "bottom" : "top",
              width: i.width,
              ...(i.labels !== undefined ? { labels: i.labels } : {}),
              ...(i.layers ? { layers: i.layers } : {}),
              ...(i.region ? { region: i.region } : {}),
              ...(i.net ? { net: i.net } : {}),
              ...(i.parts ? { refs: i.parts } : {}),
            };
      const png = await fromLastBuild(ctx, (job, zip) => ctx.engine.view(job, opts, zip));
      if (typeof png === "string") return { content: png, isError: true };
      const caption =
        i.mode === "3d"
          ? `3D view from ${i.side}${i.rotate ? `, rotated ${i.rotate.join(", ")} degrees` : ""}.`
          : `2D view: ${i.side} side${i.layers ? `, layers ${i.layers.join(", ")}` : ""}${i.region ? `, region ${i.region.join(", ")} mm` : ""}${i.net ? `, net ${i.net} highlighted` : ""}${i.parts ? `, ${i.parts.join(", ")} outlined` : ""}. Grid in mm from the board centre.`;
      return { content: caption, images: [{ mediaType: "image/png", data: base64(png) }] };
    },
  }),

  inspect_board: tool({
    description:
      "The built board as data: every part's position, rotation, side and size; every net's pads, track length, vias and layers; and a fresh DRC with each finding's location (board mm from the centre). Use it to find what view_board shows, or to check a change. Shows the last build_board result.",
    schema: z.object({
      what: z.array(z.enum(["parts", "nets", "drc"])).min(1).default(["parts", "nets", "drc"]),
      parts: z.array(z.string().regex(/^[A-Z]+\d+$/)).max(50).optional().describe("only these parts"),
      nets: z.array(z.string().max(100)).max(50).optional().describe("only these nets"),
    }),
    label: (i) => `Inspecting the board (${i.what.join(", ")})`,
    async run(i, ctx) {
      const info = await fromLastBuild(ctx, (job, zip) =>
        ctx.engine.inspect(job, { what: i.what, ...(i.parts ? { refs: i.parts } : {}), ...(i.nets ? { nets: i.nets } : {}) }, zip),
      );
      if (typeof info === "string") return { content: info, isError: true };
      const text = JSON.stringify(info);
      return { content: text.length > 60_000 ? `${text.slice(0, 60_000)}… (cut: ask for fewer parts or nets)` : text };
    },
  }),

  move_parts: tool({
    description:
      "Move, rotate, flip or lock parts: sets their placement in the design (board mm from the centre, rotation in degrees). Parts you do not lock may still be nudged by automatic placement. Run build_board afterwards to lay out and route again, then view_board to look.",
    schema: MoveInput,
    label: (i) => i.summary,
    async run(i, ctx) {
      const { design } = ctx.design();
      const known = new Set(design.components.map((c) => c.ref));
      const unknown = i.moves.filter((m) => !known.has(m.ref)).map((m) => m.ref);
      if (unknown.length) return { content: `No part ${unknown.join(", ")} in the design.`, isError: true };
      const placement = { ...design.placement };
      for (const m of i.moves) {
        const cur = placement[m.ref];
        if (!cur && (m.x === undefined || m.y === undefined))
          return { content: `${m.ref} has no position yet: give x and y (inspect_board shows where the last build put it).`, isError: true };
        placement[m.ref] = {
          x: m.x ?? cur!.x,
          y: m.y ?? cur!.y,
          rot: m.rot ?? cur?.rot ?? 0,
          side: m.side ?? cur?.side ?? "top",
          locked: m.locked ?? cur?.locked ?? false,
        };
      }
      const b = design.board;
      const outside = b
        ? i.moves.filter((m) => Math.abs(placement[m.ref]!.x) > b.width / 2 || Math.abs(placement[m.ref]!.y) > b.height / 2).map((m) => m.ref)
        : [];
      if (outside.length) return { content: `${outside.join(", ")} would be off the ${b!.width} x ${b!.height} mm board.`, isError: true };
      const version = ctx.saveDesign({ ...design, placement }, i.summary);
      return { content: `Saved as version ${version}. Run build_board to lay out and route the board again.` };
    },
  }),

  quote: tool({
    description: "Estimate board, assembly and parts cost for quantities (JLCPCB), for the current design. Dated, with its basis.",
    schema: z.object({ qty: z.array(z.number().int().min(1).max(100000)).min(1).max(5) }),
    label: (i) => `Pricing ${i.qty.join(" / ")} boards`,
    async run(i, ctx) {
      return { content: json(await ctx.engine.quote(ctx.design().design, i.qty)) };
    },
  }),

  set_stage: tool({
    description: "Move the journey to a stage once the person has approved the current one (idea, parts, circuit, board, layout, checks, view, order).",
    schema: z.object({ stage: Stage }),
    label: (i) => `Moving on to ${i.stage}`,
    async run(i, ctx) {
      const { design } = ctx.design();
      if (design.stage === i.stage) return { content: `Already at ${i.stage}.` };
      ctx.saveDesign({ ...design, stage: i.stage }, `Stage: ${i.stage}`);
      ctx.emit({ type: "stage", stage: i.stage });
      return { content: `Stage is now ${i.stage}.` };
    },
  }),

  write_firmware: tool({
    description: "Write one firmware file (ESPHome YAML, Arduino sketch, header) into the design, and set the platform.",
    schema: z.object({
      platform: Firmware.shape.platform,
      path: z.string().regex(FIRMWARE_PATH, "a relative path like src/main.cpp or printhub.yaml"),
      contents: z.string().max(200_000),
    }),
    label: (i) => `Writing ${i.path}`,
    async run(i, ctx) {
      const { design } = ctx.design();
      const firmware = { ...design.firmware, platform: i.platform, files: { ...design.firmware.files, [i.path]: i.contents } };
      const version = ctx.saveDesign({ ...design, firmware }, `Firmware: ${i.path}`);
      return { content: `Saved ${i.path} (${i.contents.length} characters), design version ${version}.` };
    },
  }),
} as const;

export type ToolName = keyof typeof TOOLS;

/** Tool definitions in a fixed order, so the request prefix (and its cache) never changes. */
export function toolSpecs(): ToolSpec[] {
  return Object.entries(TOOLS).map(([name, t]) => {
    const { $schema: _drop, ...schema } = z.toJSONSchema(t.schema, { io: "input" }) as Record<string, unknown>;
    return { name, description: t.description, input_schema: { ...schema, type: "object" } };
  });
}

/** Validates a call and runs it. Never throws for a bad call: the model gets an error it can act on. */
export async function runTool(call: ToolCall, ctx: ToolContext, signal: AbortSignal): Promise<ToolRun> {
  const fail = (content: string): ToolRun => ({ outcome: { id: call.id, name: call.name, content, isError: true } });
  const t = (TOOLS as Record<string, Tool<z.ZodType>>)[call.name];
  if (!t) return fail(`There is no tool called "${call.name}". Tools: ${Object.keys(TOOLS).join(", ")}.`);
  if (call.badJson !== undefined) return fail(`The arguments were not valid JSON. Send ${call.name} again with a JSON object.`);
  const parsed = t.schema.safeParse(call.input);
  if (!parsed.success) {
    const issues = parsed.error.issues.slice(0, 8).map((x) => `${x.path.join(".") || "(input)"}: ${x.message}`);
    return fail(`Invalid input for ${call.name}:\n${issues.join("\n")}`);
  }
  const label = t.label(parsed.data);
  ctx.emit({ type: "tool", id: call.id, name: call.name, label, status: "running" });
  try {
    const r = await t.run(parsed.data, ctx, call, signal);
    // a failed tool shows its reason to the person too, not only to the model
    ctx.emit({ type: "tool", id: call.id, name: call.name, label, status: r.isError ? "error" : "done", ...(r.isError ? { detail: r.content.slice(0, 300) } : {}) });
    const outcome: ToolOutcome = { id: call.id, name: call.name, content: r.content, ...(r.images ? { images: r.images } : {}), ...(r.isError ? { isError: true } : {}) };
    return { outcome, ...(r.waitForUser ? { waitForUser: true } : {}) };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    ctx.emit({ type: "tool", id: call.id, name: call.name, label, status: "error", detail: msg.slice(0, 300) });
    return fail(`${call.name} failed: ${msg}`);
  }
}

// ------------------------------------------------------------------ helpers

function warnings(d: Design): string {
  const w: string[] = [];
  for (const [net, pins] of netMembers(d)) if (pins.length < 2) w.push(`net ${net} has one pin (${pins[0]!.ref}.${pins[0]!.pad})`);
  for (const c of d.components) {
    if (!(c.part in d.parts)) w.push(`${c.ref} uses unknown part ${c.part}`);
    if (!(c.block in d.blocks)) w.push(`${c.ref} is in unknown block ${c.block}`);
  }
  return w.length ? `\nWarnings:\n${w.slice(0, 15).join("\n")}` : "";
}

function summarizeChecks(results: CheckResult[]): string {
  if (!results.length) return "No checks ran.";
  const count = (s: CheckResult["status"]) => results.filter((r) => r.status === s).length;
  const notPass = results.filter((r) => r.status === "fail" || r.status === "warn");
  return [
    `Checks: ${count("pass")} pass, ${count("fail")} fail, ${count("warn")} warn, ${count("skip")} skipped.`,
    ...notPass.slice(0, 20).map((r) => `${r.status.toUpperCase()} ${r.name}${r.detail ? `: ${r.detail}` : ""}`),
  ].join("\n");
}

async function storeArtifacts(ctx: ToolContext, job: string, artifacts: Artifact[]): Promise<Artifact[]> {
  const out: Artifact[] = [];
  for (const a of artifacts) {
    const r = await ctx.engine.file(job, a.name);
    if (!r.ok || !r.body) continue;
    const name = `${job}-${a.name}`;
    await ctx.putFile(name, r.body, r.headers.get("content-type") ?? contentType(a.name));
    out.push({ ...a, name, url: `/projects/${ctx.projectId}/files/${encodeURIComponent(name)}` });
  }
  return out;
}

export function contentType(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  return (
    {
      svg: "image/svg+xml",
      png: "image/png",
      glb: "model/gltf-binary",
      zip: "application/zip",
      csv: "text/csv; charset=utf-8",
      json: "application/json",
      step: "model/step",
      stp: "model/step",
      txt: "text/plain; charset=utf-8",
      d356: "text/plain; charset=utf-8",
      ipc: "text/plain; charset=utf-8",
    }[ext] ?? "application/octet-stream"
  );
}

/** Runs a look at the last build; when the engine has lost that build (a
 * restarted container), sends it the board from the file store and tries
 * again. A string is a reason it could not. */
async function fromLastBuild<T>(ctx: ToolContext, look: (job: string, zip?: ArrayBuffer) => Promise<T | NeedBoard>): Promise<T | string> {
  const last = ctx.lastBuild();
  if (!last) return "No built board yet: run build_board first.";
  try {
    let r = await look(last.job);
    if (isNeedBoard(r)) {
      const zip = await ctx.getFile(last.kicad);
      if (!zip) return "The last build's board file is missing: run build_board again.";
      r = await look(last.job, zip);
      if (isNeedBoard(r)) return "The engine could not open the last build's board: run build_board again.";
    }
    return r;
  } catch (e) {
    if (e instanceof EngineError) return e.message;
    throw e;
  }
}

const isNeedBoard = (r: unknown): r is NeedBoard => !!r && typeof r === "object" && (r as { needBoard?: boolean }).needBoard === true;

function base64(buf: ArrayBuffer): string {
  const u = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(s);
}
