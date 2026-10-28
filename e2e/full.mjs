// The whole journey in a real browser against the real stack: the API, the
// KiCad engine and the scripted stand-in for Claude (e2e/scripts/room-sensor.json).
// Sign in, describe a board, answer the AI's questions, pick a chip, let it
// draw the circuit, build and route the board in KiCad, then check every tab:
// requirements, parts, circuit, board layers, 3D, checks and the order files.
//
//   node e2e/full.mjs [APP_URL] [SHOTS_DIR]
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
const { chromium } = createRequire(import.meta.url)("playwright");

const APP = process.argv[2] ?? "http://localhost:5173";
const SHOTS = process.argv[3];
const API = process.env.API_URL ?? "http://localhost:8787";
const FAKE = process.env.FAKE_URL ?? "http://localhost:8788";
const BUILD_TIMEOUT = Number(process.env.BUILD_TIMEOUT_MS ?? 20 * 60_000);

const t0 = Date.now();
const secs = () => ((Date.now() - t0) / 1000).toFixed(0).padStart(4) + "s";
const log = (s) => console.log(`${secs()}  ${s}`);
const errors = [];
const results = [];
const ok = (name, detail = "") => (results.push({ name, ok: true }), log(`ok    ${name}${detail ? ` (${detail})` : ""}`));
const fail = (name, detail) => (results.push({ name, ok: false, detail }), log(`FAIL  ${name}: ${detail}`));

await fetch(`${FAKE}/__fake/reload`, { method: "POST" });
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
const page = await ctx.newPage();
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
page.on("pageerror", (e) => errors.push(e.message));
const shot = async (n) => SHOTS && page.screenshot({ path: path.join(SHOTS, `full-${n}.png`) });

try {
  // ---------------------------------------------------------------- start
  await page.goto(APP);
  await page.getByTestId("signin-email").fill(`full-${Date.now()}@example.com`);
  await page.getByTestId("signin-submit").click();
  await page.getByTestId("prompt-input").waitFor({ timeout: 20000 });
  ok("sign in (local mode)");

  await page.getByTestId("prompt-input").fill("A small Wi-Fi room sensor for temperature and humidity that shows up in Home Assistant");
  await page.getByTestId("prompt-submit").click();
  await page.getByTestId("questions").last().waitFor({ timeout: 60000 });
  ok("the AI asks questions first");
  await page.getByTestId("option-power-usbc").click();
  await page.getByTestId("option-home-esphome").click();
  await page.getByTestId("submit-answers").click();

  await page.getByTestId("comparison").waitFor({ timeout: 60000 });
  ok("the AI compares chips in a table");
  await page.getByTestId("option-chip-c3").waitFor({ timeout: 30000 });
  await shot("comparison");
  await page.getByTestId("option-chip-c3").click();
  await page.getByTestId("submit-answers").last().click();

  // ---------------------------------------------------------------- build
  await page.getByTestId("job").first().waitFor({ timeout: 120000 });
  ok("circuit drawn, board set, build started");
  const deadline = Date.now() + BUILD_TIMEOUT;
  let lastStep = "";
  while (Date.now() < deadline) {
    if (await page.getByText("The board is routed and checked", { exact: false }).count()) break;
    const step = (await page.getByTestId("job").last().textContent())?.trim() ?? "";
    if (step && step !== lastStep) log(`      build: ${step.slice(0, 90)}`), (lastStep = step);
    await page.waitForTimeout(3000);
  }
  if (!(await page.getByText("The board is routed and checked", { exact: false }).count())) throw new Error(`build did not finish in ${BUILD_TIMEOUT / 60000} min`);
  ok("KiCad laid out and routed the board", `${secs().trim()} in`);
  await shot("chat-done");

  // ---------------------------------------------------------------- tabs
  const tab = async (id) => {
    await page.getByTestId(`tab-${id}`).click();
    await page.waitForTimeout(400);
  };
  await tab("overview");
  (await page.getByText("Measures temperature and humidity").count()) ? ok("requirements listed") : fail("requirements listed", "R2 missing");

  await tab("parts");
  const bom = await page.getByTestId("bom").textContent();
  /ESP32-C3/.test(bom ?? "") && /SHT4/.test(bom ?? "") ? ok("parts list has the chip and the sensor") : fail("parts list", (bom ?? "").slice(0, 120));
  await shot("parts");

  await tab("circuit");
  (await page.locator("svg").count()) > 2 ? ok("circuit drawn") : fail("circuit drawn", "no diagrams");
  await shot("circuit");

  await tab("board");
  await page.getByTestId("board-2d").waitFor({ timeout: 20000 });
  const layers = await page.locator('[data-testid^="layer-"]').count();
  layers >= 4 ? ok("board layers shown", `${layers} toggles`) : fail("board layers shown", `${layers} toggles`);
  await page.waitForTimeout(1500);
  await shot("board");

  await tab("3d");
  const canvas = page.getByTestId("viewer-3d").locator("canvas");
  await canvas.waitFor({ timeout: 60000 });
  await page.waitForTimeout(4000);
  // the canvas must actually show the board: a WebGL canvas reads back blank
  // without preserveDrawingBuffer, so look at a real screenshot of it instead
  const png = (await canvas.screenshot()).toString("base64");
  const lit = await page.evaluate(async (b64) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const g = document.createElement("canvas");
    g.width = 96; g.height = 96;
    const x = g.getContext("2d");
    x.drawImage(img, 0, 0, 96, 96);
    const d = x.getImageData(0, 0, 96, 96).data;
    const bg = [d[0], d[1], d[2]];
    let n = 0;
    for (let i = 0; i < d.length; i += 4) if (Math.abs(d[i] - bg[0]) + Math.abs(d[i + 1] - bg[1]) + Math.abs(d[i + 2] - bg[2]) > 30) n++;
    return n / (96 * 96);
  }, png);
  lit > 0.03 ? ok("3D view shows the board", `${(lit * 100).toFixed(0)}% of the view`) : fail("3D view shows the board", `only ${(lit * 100).toFixed(1)}% lit`);
  await shot("3d");

  await tab("checks");
  const rows = page.getByTestId("check-row");
  const n = await rows.count();
  const texts = await rows.allTextContents();
  const failed = texts.filter((t) => /\bfail/i.test(t));
  n >= 5 ? ok("checks listed", `${n} checks`) : fail("checks listed", `${n}`);
  failed.length === 0 ? ok("no check failed") : fail("no check failed", failed.join(" | ").slice(0, 400));
  const drc = texts.find((t) => /DRC/i.test(t));
  drc && /pass/i.test(drc) ? ok("DRC passes", drc.replace(/\s+/g, " ").slice(0, 100)) : fail("DRC passes", drc ?? "no DRC row");
  await shot("checks");

  await tab("order");
  const dl = page.getByTestId("download-gerbers");
  await dl.waitFor({ timeout: 20000 });
  const [download] = await Promise.all([page.waitForEvent("download"), dl.click()]);
  const zip = path.join(os.tmpdir(), `hh-gerbers-${Date.now()}.zip`);
  await download.saveAs(zip);
  const buf = fs.readFileSync(zip);
  const names = (buf.toString("latin1").match(/[\w.-]+\.(gbr|gtl|gbl|gto|gbo|gts|gbs|gm1|drl|g[tb][lops]|gko)/gi) ?? []);
  buf.subarray(0, 2).toString() === "PK" && names.length >= 6
    ? ok("Gerber zip downloads", `${(buf.length / 1024).toFixed(0)} KB, ${new Set(names).size} files`)
    : fail("Gerber zip downloads", `${buf.length} bytes, ${names.length} layer files`);
  for (const kind of ["bom", "cpl"]) {
    // the first is JLCPCB's format; a PCBWay BOM follows it
    const el = page.getByTestId(`download-${kind}`).first();
    if (!(await el.count())) { fail(`${kind.toUpperCase()} downloads`, "no button"); continue; }
    const [d] = await Promise.all([page.waitForEvent("download"), el.click()]);
    const p = path.join(os.tmpdir(), `hh-${kind}-${Date.now()}.csv`);
    await d.saveAs(p);
    const lines = fs.readFileSync(p, "utf8").trim().split("\n");
    lines.length > 5 ? ok(`${kind.toUpperCase()} downloads`, `${lines.length - 1} rows`) : fail(`${kind.toUpperCase()} downloads`, `${lines.length} lines`);
  }
  await shot("order");

  // ---------------------------------------------------------------- the rest
  const status = await (await fetch(`${FAKE}/__fake/status`)).json();
  status.problems.length ? fail("every AI request stayed US-only and in order", status.problems.join("; ")) : ok("every AI request stayed US-only and in order");
  // ---------------------------------------------------------------- every size
  // the finished project on a phone, a tablet and a desktop, light and dark:
  // every tab renders, nothing scrolls sideways
  const projectUrl = page.url();
  const state = await ctx.storageState();
  const tabs = ["overview", "parts", "circuit", "board", "3d", "checks", "order"];
  const sizes = { phone: { width: 390, height: 844 }, tablet: { width: 768, height: 1024 }, desktop: { width: 1440, height: 900 } };
  const wide = [];
  for (const [size, viewport] of Object.entries(sizes))
    for (const scheme of ["light", "dark"]) {
      const c = await browser.newContext({ viewport, colorScheme: scheme, storageState: state, deviceScaleFactor: size === "phone" ? 2 : 1 });
      const p = await c.newPage();
      p.on("pageerror", (e) => errors.push(`${size}/${scheme}: ${e.message}`));
      const snap = async (n) => SHOTS && p.screenshot({ path: path.join(SHOTS, `size-${size}-${scheme}-${n}.png`) });
      const sideways = async (n) => (await p.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)) && wide.push(`${size}/${scheme}/${n}`);
      await p.goto(new URL("/", projectUrl).href);
      await p.getByTestId("project-row").first().waitFor({ timeout: 20000 });
      await snap("boards"), await sideways("boards");
      await p.goto(projectUrl);
      await p.getByTestId("chat-log").waitFor({ timeout: 20000 });
      await p.waitForTimeout(600);
      await snap("chat"), await sideways("chat");
      // phones and tablets switch between chat and board with a bottom control
      if (await p.getByTestId("pane-board").isVisible()) await p.getByTestId("pane-board").click();
      for (const t of tabs) {
        await p.getByTestId(`tab-${t}`).click();
        await p.waitForTimeout(t === "3d" ? 3500 : t === "board" ? 1200 : 500);
        await snap(t), await sideways(t);
      }
      await p.goto(new URL("/settings", projectUrl).href);
      await p.waitForTimeout(600);
      await snap("settings"), await sideways("settings");
      await c.close();
    }
  wide.length ? fail("no screen scrolls sideways (3 sizes x light/dark x 10 screens)", wide.join(", ")) : ok("no screen scrolls sideways", "3 sizes x light/dark x 10 screens");
} catch (e) {
  fail("journey", e.message.split("\n")[0]);
  await shot("failure").catch(() => {});
}

errors.length ? fail("no browser console errors", errors.slice(0, 5).join(" | ")) : ok("no browser console errors");
await browser.close();
const bad = results.filter((r) => !r.ok);
console.log(`\n${results.length - bad.length} passed, ${bad.length} failed, ${secs().trim()}`);
process.exit(bad.length ? 1 : 0);
