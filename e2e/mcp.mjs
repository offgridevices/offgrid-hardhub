// HardHub over MCP, end to end against the real stack: an agent (the official
// MCP client, as Claude Code and Codex use it) connects, the person allows it
// in a real browser, and the agent designs a board, builds it in KiCad, looks
// at it, reads the order files and leaves a note, while the web app shows the
// project live. Then the person disconnects it from Settings.
//
//   node e2e/mcp.mjs [APP_URL] [SHOTS_DIR]     (API_URL: the API, default http://localhost:8787)
import { createRequire } from "node:module";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StreamableHTTPClientTransport } = require("@modelcontextprotocol/sdk/client/streamableHttp.js");
const { UnauthorizedError } = require("@modelcontextprotocol/sdk/client/auth.js");

const APP = process.argv[2] ?? "http://localhost:5173";
const SHOTS = process.argv[3];
const API = process.env.API_URL ?? "http://localhost:8787";
const MCP = new URL(`${API}/mcp`);
const BUILD_TIMEOUT = Number(process.env.BUILD_TIMEOUT_MS ?? 20 * 60_000);
const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), "../engine/tests/fixtures/esp32c3-sensor.json");

const t0 = Date.now();
const log = (s) => console.log(`${((Date.now() - t0) / 1000).toFixed(0).padStart(4)}s  ${s}`);
const results = [];
const ok = (name, detail = "") => (results.push({ name, ok: true }), log(`ok    ${name}${detail ? ` (${detail})` : ""}`));
const fail = (name, detail) => (results.push({ name, ok: false, detail }), log(`FAIL  ${name}: ${detail}`));
const check = (cond, name, detail = "") => (cond ? ok(name, typeof detail === "string" ? detail : "") : fail(name, typeof detail === "string" ? detail : JSON.stringify(detail)));
const textOf = (r) => r.content?.find((c) => c.type === "text")?.text ?? "";

// the agent's sign-in callback: where the browser lands after Allow
let gotCode;
const codeArrived = new Promise((r) => (gotCode = r));
const callback = http.createServer((req, res) => {
  const u = new URL(req.url, "http://127.0.0.1");
  res.writeHead(200, { "content-type": "text/plain" });
  res.end("Connected. You can close this tab.");
  if (u.pathname === "/callback") gotCode(u.searchParams);
});
await new Promise((r) => callback.listen(0, "127.0.0.1", r));
const CALLBACK = `http://127.0.0.1:${callback.address().port}/callback`;

class Agent {
  info;
  toks;
  verifier = "";
  authUrl = null;
  redirectUrl = CALLBACK;
  get clientMetadata() {
    return { client_name: "HardHub e2e agent", redirect_uris: [CALLBACK], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" };
  }
  clientInformation() { return this.info; }
  saveClientInformation(i) { this.info = i; }
  tokens() { return this.toks; }
  saveTokens(t) { this.toks = t; }
  redirectToAuthorization(u) { this.authUrl = u; }
  saveCodeVerifier(v) { this.verifier = v; }
  codeVerifier() { return this.verifier; }
}

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
const shot = async (n) => SHOTS && page.screenshot({ path: path.join(SHOTS, `mcp-${n}.png`) });
const phoneShot = async (n) => {
  if (!SHOTS) return;
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: path.join(SHOTS, `mcp-${n}-phone.png`) });
  const wide = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  check(!wide, `${n}: nothing scrolls sideways on a phone`);
  await page.setViewportSize({ width: 1440, height: 900 });
};

const agent = new Agent();
let client;
let project;
try {
  // ---------------------------------------------------------------- sign in
  const first = new Client({ name: "hardhub-e2e", version: "1.0.0" });
  try {
    await first.connect(new StreamableHTTPClientTransport(MCP, { authProvider: agent }));
    fail("an agent without a token is sent to sign in", "connected without signing in");
  } catch (e) {
    check(e instanceof UnauthorizedError && !!agent.authUrl, "an agent without a token is sent to sign in", agent.authUrl ? new URL(agent.authUrl).pathname : String(e));
  }
  check(!!agent.info?.client_id, "the agent registered itself", agent.info?.client_id);

  await page.goto(agent.authUrl.toString());
  await page.getByTestId("signin-email").fill(`mcp-${Date.now()}@example.com`);
  await page.getByTestId("signin-submit").click();
  await page.getByTestId("connect-title").waitFor({ timeout: 20000 });
  const title = await page.getByTestId("connect-title").textContent();
  check(title?.includes("HardHub e2e agent"), "after sign-in, the consent page names the app", title);
  await shot("consent");
  await phoneShot("consent");
  await page.getByTestId("connect-allow").click();
  const params = await Promise.race([codeArrived, new Promise((_, no) => setTimeout(() => no(new Error("no callback in 20 s")), 20000))]);
  check(!!params.get("code"), "Allow sends the browser back to the agent with a code");

  const transport = new StreamableHTTPClientTransport(MCP, { authProvider: agent });
  await transport.finishAuth(params.get("code"));
  client = new Client({ name: "hardhub-e2e", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(MCP, { authProvider: agent }));
  ok("the agent connects with its token");

  // ---------------------------------------------------------------- design
  const tools = (await client.listTools()).tools.map((t) => t.name);
  check(["guide", "create_project", "update_design", "build_board", "wait_for_build", "render", "get_files", "read_file", "note"].every((t) => tools.includes(t)), "the agent sees HardHub's tools", `${tools.length} tools`);
  check(textOf(await client.callTool({ name: "guide", arguments: {} })).includes("Working through MCP"), "guide explains how to work");

  const created = textOf(await client.callTool({ name: "create_project", arguments: { name: "Room sensor (MCP)", request: "A small Wi-Fi room sensor for temperature and humidity that shows up in Home Assistant" } }));
  project = /project (p_[\w-]+)/.exec(created)?.[1];
  check(!!project, "create_project", project);

  const fixture = JSON.parse(fs.readFileSync(FIXTURE, "utf8"));
  const patch = ["requirements", "blocks", "parts", "components", "nets", "placement", "firmware"].map((k) => ({ op: "replace", path: `/${k}`, value: fixture[k] }));
  // silkscreen: part names, outlines, and the board's name where the antenna leaves bare board
  const board = { ...fixture.board, silkscreen: { outlines: true, refs: true, texts: [{ text: "ROOM SENSOR v1", x: 0, y: -17, size: 1.5 }] } };
  patch.push({ op: "add", path: "/board", value: board }, { op: "replace", path: "/name", value: "Room sensor (MCP)" });
  const saved = await client.callTool({ name: "update_design", arguments: { project, summary: "ESP32-C3 room sensor: circuit and a 50 x 40 mm board", patch } });
  check(!saved.isError, "update_design saves the circuit", textOf(saved).split("\n")[0]);
  const checks = textOf(await client.callTool({ name: "check_circuit", arguments: { project } }));
  check(/Checks: \d+ pass, 0 fail/.test(checks), "check_circuit passes", checks.split("\n")[0]);

  // the person watches it happen in the app
  await page.goto(`${APP}/p/${project}`);
  await page.getByText("ESP32-C3 room sensor: circuit and a 50 x 40 mm board").first().waitFor({ timeout: 20000 });
  ok("the web app shows the agent's work");

  // ---------------------------------------------------------------- build
  let build = await client.callTool({ name: "build_board", arguments: { project } });
  const until = Date.now() + BUILD_TIMEOUT;
  let waits = 0;
  while (textOf(build).startsWith("Still building") && Date.now() < until) {
    waits++;
    build = await client.callTool({ name: "wait_for_build", arguments: { project } });
  }
  const bt = textOf(build);
  check(!build.isError && bt.startsWith("Build finished."), "build_board runs KiCad to the end", `${waits} waits; ${bt.split("\n").find((l) => l.startsWith("Checks:")) ?? bt.slice(0, 120)}`);
  check(/Checks: \d+ pass, 0 fail/.test(bt), "the built board passes its checks", bt.split("\n").filter((l) => /^(FAIL|Checks)/.test(l)).join(" | "));

  const render = await client.callTool({ name: "render", arguments: { project } });
  const images = (render.content ?? []).filter((c) => c.type === "image");
  check(images.length > 0, "render gives the agent the board as images", `${images.length} PNG`);
  if (SHOTS) images.forEach((img, i) => fs.writeFileSync(path.join(SHOTS, `mcp-render-${i}.png`), Buffer.from(img.data, "base64")));

  // ---------------------------------------------------------------- looking at its own work
  const look = async (name, args, label) => {
    const r = await client.callTool({ name: "view_board", arguments: { project, ...args } });
    const img = (r.content ?? []).find((c) => c.type === "image");
    check(!r.isError && !!img && img.data.length > 20000, `view_board: ${label}`, r.isError ? textOf(r).slice(0, 160) : `${Math.round(img.data.length * 0.75 / 1024)} KB`);
    if (SHOTS && img) fs.writeFileSync(path.join(SHOTS, `mcp-view-${name}.png`), Buffer.from(img.data, "base64"));
  };
  await look("top", { layers: ["F.Cu", "F.Silkscreen", "Edge.Cuts"] }, "top copper and silkscreen");
  await look("gnd", { layers: ["F.Cu", "B.Cu", "Edge.Cuts"], net: "GND" }, "ground highlighted on both layers");
  await look("silk", { layers: ["F.Silkscreen", "F.Fab", "Edge.Cuts"], parts: ["U1"], labels: false }, "silkscreen with U1 outlined");
  await look("zoom", { layers: ["F.Cu", "F.Mask", "F.Silkscreen"], region: [-10, -2, 10, 12] }, "a region zoomed in");
  await look("bottom", { side: "bottom" }, "the bottom, seen from below");
  await look("iso", { mode: "3d", rotate: [-45, 0, 45], width: 1200 }, "3D, isometric");
  await look("back", { mode: "3d", side: "bottom", width: 1000 }, "3D, from below");
  const info = JSON.parse(textOf(await client.callTool({ name: "inspect_board", arguments: { project } })));
  check(info.parts?.length >= 21 && info.drc?.errors === 0 && info.drc?.unconnected === 0, "inspect_board: parts, nets and a clean DRC", `${info.parts?.length} parts, ${info.nets?.length} nets, DRC ${info.drc?.errors}/${info.drc?.warnings}/${info.drc?.unconnected}`);
  const silk = bt.split("\n").find((l) => /silkscreen/i.test(l));
  log(`      silkscreen check: ${silk ?? "passed"}`);
  const r8 = info.parts.find((p) => p.ref === "R8");
  const moved = await client.callTool({ name: "move_parts", arguments: { project, summary: "Turn R8 to line up with D1", moves: [{ ref: "R8", x: r8.x, y: r8.y, rot: (r8.rot + 90) % 360, locked: true }] } });
  check(!moved.isError, "move_parts saves a new position", textOf(moved).split(".")[0]);

  const files = textOf(await client.callTool({ name: "get_files", arguments: { project } }));
  const bomName = /- (\S*bom\S*\.csv)/i.exec(files)?.[1];
  check(files.includes("gerbers") && !!bomName, "get_files lists the order files", bomName);
  const bom = textOf(await client.callTool({ name: "read_file", arguments: { project, name: bomName } }));
  check(/LCSC/i.test(bom) && bom.split("\n").length > 5, "read_file reads the BOM", `${bom.split("\n").length} lines`);

  await client.callTool({ name: "note", arguments: { project, text: "Built and checked: 2 layers, 50 x 40 mm. The order files are ready." } });

  // ---------------------------------------------------------------- the app
  await page.reload();
  await page.getByText("Built and checked: 2 layers, 50 x 40 mm.").first().waitFor({ timeout: 20000 });
  ok("the agent's note shows in the project");
  await shot("project");
  await phoneShot("project");
  await page.goto(`${APP}/p/${project}?tab=3d`);
  await page.waitForTimeout(4000);
  await shot("project-3d");

  await page.goto(`${APP}/settings`);
  const row = page.getByTestId("connection").filter({ hasText: "HardHub e2e agent" });
  await row.waitFor({ timeout: 10000 });
  ok("Settings lists the connected app");
  check((await page.getByTestId("mcp-url").textContent())?.endsWith("/mcp"), "Settings shows the MCP address", await page.getByTestId("mcp-url").textContent());
  await page.getByTestId("app-claude-code").click();
  await page.waitForTimeout(400); // the buttons' colour fade
  await shot("settings");
  await phoneShot("settings");
  await row.getByTestId("disconnect").click();
  await row.waitFor({ state: "detached", timeout: 10000 });
  try {
    await client.callTool({ name: "list_projects", arguments: {} });
    fail("a disconnected agent is locked out", "the call still worked");
  } catch (e) {
    // its token is gone and refreshing is refused: the client must sign in again
    check(e instanceof UnauthorizedError || /401|unauthori|invalid_grant|InvalidGrant/i.test(String(e)), "a disconnected agent is locked out", String(e).slice(0, 80));
  }
} catch (e) {
  fail("unexpected error", e?.stack ?? String(e));
  await shot("error");
} finally {
  await browser.close();
  callback.close();
}

const pageErrors = errors.filter((e) => !/Failed to load resource/.test(e));
check(pageErrors.length === 0, "no errors in the browser", pageErrors.slice(0, 3).join(" | "));
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} of ${results.length} passed`);
process.exit(failed.length ? 1 : 0);
