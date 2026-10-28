// HardHub over MCP: the person's own AI app (Claude, ChatGPT, Codex...) does
// the thinking on their own plan, and calls these tools. They are the tools
// HardHub's built-in AI uses, run inside the project's room, so the web app
// shows every step live. No ask_user: the agent asks in its own chat.
//
// Stateless Streamable HTTP: every request builds a server for the signed-in
// person and answers with JSON. Board builds outlive the request: they run
// from the room's alarm, and build_board / wait_for_build wait on them.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { jsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/types.js";
import { z } from "zod";
import { SYSTEM_PROMPT } from "./agent/prompt";
import { TOOLS, contentType } from "./agent/tools";
import * as db from "./db";
import type { Env } from "./env";
import { issuer } from "./oauth";
import type { AgentResult } from "./room/core";

/** how long one call waits on a build before handing back a progress note */
export const BUILD_WAIT_MS = 45_000;
const POLL_MS = 1500;
const TEXT_FILE_LIMIT = 200_000;

export const INSTRUCTIONS = `HardHub designs circuit boards that JLCPCB can build and assemble: parts with live stock and prices, the circuit pin by pin, the board laid out and routed in KiCad, checked (DRC, nets, power), shown in 3D, with Gerber, BOM and placement files.

Call \`guide\` once before you start: it explains the journey, the design document and the rules. You propose; the person decides. Ask them each decision in your own chat as multiple-choice questions, your recommendation first. Everything you do shows up live in their HardHub project; leave a short \`note\` there after each stage.`;

const PREFACE = `# Working through MCP

You are connected to HardHub from the person's own AI app. The guide below was written for HardHub's built-in AI, so read it with these differences:

- There is no \`ask_user\` tool. Ask in your own chat: 1-4 multiple-choice questions at a time, your recommendation first with its reason, and wait for the answers.
- \`propose_options\` puts the comparison table in the HardHub app. Show the same table in your chat too.
- Every tool takes \`project\`: the id from \`create_project\` or \`list_projects\`.
- \`build_board\` runs KiCad in the background. If it comes back before the build has finished, call \`wait_for_build\` until it has.
- After each stage, \`note\` a few plain sentences into the project: what was decided and why. The person (or anyone they share it with) follows the project in the app.
- Look at your own work after every build: \`view_board\` (any layers, a net highlighted, a region zoomed, the bottom, or 3D from any angle) and \`inspect_board\` (positions, nets, DRC findings with locations). Move parts with \`move_parts\` and rebuild.
- \`get_files\` lists the order files of the last build; \`read_file\` reads the text ones (BOM, placement, checks).

`;

// the person's tools, as HardHub's own AI has them, minus asking (done in chat)
const ROOM_TOOLS = [
  "get_design", "update_design", "move_parts", "search_parts", "get_part", "propose_options", "check_circuit",
  "build_board", "view_board", "inspect_board", "render", "quote", "set_stage", "write_firmware",
] as const;
const READ_ONLY = new Set(["get_design", "search_parts", "get_part", "render", "view_board", "inspect_board", "quote"]);

const DESCRIPTIONS: Partial<Record<(typeof ROOM_TOOLS)[number], string>> = {
  propose_options:
    "Put a comparison table (part candidates, layer counts, board sizes) in the person's HardHub project. Mark the recommended row; cite sources and dates in note. Show the same table in your own chat, then ask the person to pick.",
  build_board:
    "Lay out, route and check the board in KiCad: placement (yours, plus automatic placement for unplaced parts), routing, 45-degree corners, ground pour, DRC with the fab's limits, net check, fab files, renders. Runs in the background and takes from half a minute to several minutes: this call waits up to 45 seconds, then returns progress; call wait_for_build until it reports the result. Needs design.board.",
  render: "Look at the board renders (PNG) from the last build, to judge placement and routing yourself.",
};

const ProjectId = z.string().min(3).max(64).describe("the project's id, from create_project or list_projects");

// the server never asks the client for structured input (elicitation), so it
// never validates a JSON schema; this keeps the default validator (which
// compiles code at run time, as Workers do not allow) from being built
const NO_VALIDATOR: jsonSchemaValidator = {
  getValidator() {
    throw new Error("HardHub's MCP server does not validate JSON schemas");
  },
};

type Room = DurableObjectStub<import("./room").ProjectRoom>;

export interface McpDeps {
  env: Env;
  userId: string;
  /** the web app's address, for links to a project */
  appUrl: string;
  room(projectId: string): Room;
  /** the caller is HardHub's own chat, run by the person's Claude Code (bridge.ts) */
  fromChat?: boolean;
  sleep?(ms: number): Promise<void>;
  waitMs?: number;
}

const text = (t: string, isError = false): CallToolResult => ({ content: [{ type: "text", text: t }], ...(isError ? { isError: true } : {}) });

const toResult = (r: AgentResult): CallToolResult => ({
  content: [{ type: "text", text: r.content }, ...(r.images ?? []).map((i) => ({ type: "image" as const, data: i.data, mimeType: i.mediaType }))],
  ...(r.isError ? { isError: true } : {}),
});

export function buildServer(deps: McpDeps): McpServer {
  const { env, userId, appUrl } = deps;
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const waitMs = deps.waitMs ?? BUILD_WAIT_MS;
  const link = (id: string) => `${appUrl}/p/${id}`;
  const server = new McpServer(
    { name: "hardhub", title: "HardHub", version: "0.1.0", websiteUrl: appUrl },
    { instructions: INSTRUCTIONS, jsonSchemaValidator: NO_VALIDATOR, capabilities: { tools: {} } },
  );

  /** the project, if it is this person's */
  const owned = async (id: string) => (await db.getProject(env, userId, id)) ?? null;
  const noProject = (id: string) => text(`There is no project "${id}" in this HardHub account. list_projects shows them.`, true);

  server.registerTool(
    "guide",
    {
      title: "How HardHub works",
      description: "Read this first: the design journey, the design document, how to choose parts, draw the circuit and lay out the board, and when a board is done.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => text(PREFACE + SYSTEM_PROMPT),
  );

  server.registerTool(
    "list_projects",
    {
      title: "List projects",
      description: "The person's HardHub projects, newest first: id, name, stage, last change, and a link to open each in the app.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      const list = await db.listProjects(env, userId);
      if (!list.length) return text("No projects yet. create_project starts one.");
      return text(JSON.stringify(list.map((p) => ({ id: p.id, name: p.name, stage: p.stage, updated_at: p.updated_at, url: link(p.id) })), null, 1));
    },
  );

  server.registerTool(
    "create_project",
    {
      title: "Create a project",
      description:
        "Start a new board project. `request` is what the person asked for, in their words: it opens the project's conversation in the HardHub app. Returns the project id and a link the person can open to watch the design take shape.",
      inputSchema: {
        name: z.string().trim().min(1).max(80).describe('a short name, e.g. "Garden soil sensor"'),
        request: z.string().trim().min(1).max(20000).optional().describe("the person's own description of the board"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ name, request }) => {
      const p = await db.createProject(env, userId, name);
      const r = deps.room(p.id);
      await r.init(p.id, userId, name);
      if (request) await r.agentRequest(request);
      return text(`Created project ${p.id} ("${name}"). The person can follow it at ${link(p.id)}\nNext: read guide if you have not, then work through the idea stage with them.`);
    },
  );

  for (const name of ROOM_TOOLS) {
    const t = TOOLS[name];
    const schema = (t.schema as z.ZodObject).extend({ project: ProjectId });
    server.registerTool(
      name,
      {
        description: DESCRIPTIONS[name] ?? t.description,
        inputSchema: schema,
        annotations: { readOnlyHint: READ_ONLY.has(name), destructiveHint: false, openWorldHint: name === "search_parts" || name === "get_part" },
      },
      async (input: Record<string, unknown>) => {
        const { project, ...args } = input as { project: string } & Record<string, unknown>;
        if (!(await owned(project))) return noProject(project);
        const r = await deps.room(project).agentTool(name, args, !!deps.fromChat);
        if (name !== "build_board" || r.isError) return toResult(r);
        return waitForBuild(project);
      },
    );
  }

  /** waits on the background build, up to waitMs */
  const waitForBuild = async (project: string): Promise<CallToolResult> => {
    const room = deps.room(project);
    const until = Date.now() + waitMs;
    for (;;) {
      const b = await room.agentBuild();
      if (!b) return text("No build has been started in this project. Call build_board.", true);
      if (b.state === "done") return toResult(b.result ?? { content: "The build finished without a result.", isError: true });
      if (Date.now() >= until) {
        const pct = Math.round((b.progress ?? 0) * 100);
        return text(`Still building: ${b.step ?? "starting"} (${pct}%). Call wait_for_build to keep waiting.`);
      }
      await sleep(POLL_MS);
    }
  };

  if (deps.fromChat)
    server.registerTool(
      "ask_user",
      {
        title: "Ask the person",
        description: TOOLS.ask_user.description,
        inputSchema: (TOOLS.ask_user.schema as z.ZodObject).extend({ project: ProjectId }),
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      },
      async (input: Record<string, unknown>) => {
        const { project, questions } = input as { project: string; questions: unknown };
        if (!(await owned(project))) return noProject(project);
        return toResult(await deps.room(project).agentAsk(questions));
      },
    );

  server.registerTool(
    "wait_for_build",
    {
      title: "Wait for the board build",
      description: "Wait (up to 45 seconds) for the build that build_board started, then return its result, or its progress if it is still going.",
      inputSchema: { project: ProjectId },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ project }) => ((await owned(project)) ? waitForBuild(project) : noProject(project)),
  );

  server.registerTool(
    "note",
    {
      title: "Note in the project",
      description:
        "Write a short message into the project's conversation in the HardHub app: what you did, what the person decided and why. Plain words, a few sentences. Use after each stage.",
      inputSchema: { project: ProjectId, text: z.string().trim().min(1).max(4000) },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ project, text: t }) => {
      if (!(await owned(project))) return noProject(project);
      const refused = await deps.room(project).agentNote(t);
      return refused ? toResult(refused) : text("Noted in the project.");
    },
  );

  server.registerTool(
    "get_files",
    {
      title: "Order files and checks",
      description:
        "The files from the last build (Gerber zip, BOM, placement, 3D model, renders, KiCad project) and the latest checks. Text files can be read with read_file; the person downloads the rest from the project's Order tab.",
      inputSchema: { project: ProjectId },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ project }) => {
      if (!(await owned(project))) return noProject(project);
      const { artifacts, checks } = await deps.room(project).agentResults();
      if (!artifacts.length) return text("No files yet: build_board makes them.");
      const count = (s: string) => checks.filter((c) => c.status === s).length;
      return text(
        [
          `Files (download from ${link(project)}, Order tab):`,
          ...artifacts.map((a) => `- ${a.name} (${a.kind}${a.bytes ? `, ${Math.round(a.bytes / 1024)} KB` : ""})`),
          "",
          checks.length ? `Latest checks: ${count("pass")} pass, ${count("fail")} fail, ${count("warn")} warn, ${count("skip")} skipped.` : "No checks yet.",
          ...checks.filter((c) => c.status === "fail" || c.status === "warn").map((c) => `${c.status.toUpperCase()} ${c.name}${c.detail ? `: ${c.detail}` : ""}`),
        ].join("\n"),
      );
    },
  );

  server.registerTool(
    "read_file",
    {
      title: "Read a build file",
      description: "Read one text file from the last build (BOM or placement CSV, netlist, report), by the name get_files gives.",
      inputSchema: { project: ProjectId, name: z.string().min(1).max(200) },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ project, name }) => {
      if (!(await owned(project))) return noProject(project);
      const r = deps.room(project);
      const { artifacts } = await r.agentResults();
      if (!artifacts.some((a) => a.name === name)) return text(`No file "${name}" in the last build. get_files lists them.`, true);
      const type = contentType(name);
      if (!/^(text\/|application\/json)/.test(type)) return text(`${name} is not a text file. The person can download it from ${link(project)} (Order tab).`, true);
      const buf = await r.agentFile(name);
      if (!buf) return text(`${name} is missing from storage.`, true);
      if (buf.byteLength > TEXT_FILE_LIMIT) return text(`${name} is ${Math.round(buf.byteLength / 1024)} KB, too big to read here. Download it from ${link(project)}.`, true);
      return text(new TextDecoder().decode(buf));
    },
  );

  return server;
}

/** Answers one MCP request for a signed-in person. */
export async function handleMcp(req: Request, deps: McpDeps): Promise<Response> {
  const server = buildServer(deps);
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  try {
    return await transport.handleRequest(req);
  } finally {
    // stateless: nothing outlives the request (a build lives in the room)
    void server.close();
  }
}

export const appUrlFor = (env: Env, req: Request) => (env.APP_URL || issuer(req)).replace(/\/$/, "");
