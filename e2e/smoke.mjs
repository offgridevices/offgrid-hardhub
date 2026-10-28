// Drives the real web app against the real API (with the scripted stand-in
// for Claude): sign in, start a board from a prompt, answer the AI's
// questions, and see the design update and the stage move on.
//
//   node e2e/smoke.mjs [APP_URL] [SHOTS_DIR]
import { createRequire } from "node:module";
const { chromium } = createRequire(import.meta.url)("playwright");
import fs from "node:fs";
import path from "node:path";
import { signUp } from "./signup.mjs";

const APP = process.argv[2] ?? "http://localhost:5173";
const SHOTS = process.argv[3];
const FAKE = process.env.FAKE_URL ?? "http://localhost:8788";

const browser = await chromium.launch();
const errors = [];
let failed = false;

async function run(name, viewport) {
  const ctx = await browser.newContext({ viewport });
  const page = await ctx.newPage();
  page.on("console", (m) => m.type() === "error" && errors.push(`${name}: ${m.text()}`));
  page.on("pageerror", (e) => errors.push(`${name}: ${e.message}`));
  const shot = async (n) => SHOTS && (await page.screenshot({ path: path.join(SHOTS, `${name}-${n}.png`), fullPage: false }));
  const step = (s) => console.log(`  ${name}: ${s}`);

  await page.goto(APP);
  await signUp(page, `smoke-${name}@example.com`);
  await page.getByTestId("prompt-input").waitFor({ timeout: 15000 });
  step("signed in");
  // the server supplies a working key here, so no "add a key" banner
  if (await page.getByTestId("no-key-bar").count()) throw new Error("'add your key' banner shown although the AI is ready");
  await shot("home");

  await page.getByTestId("prompt-input").fill("A small Wi-Fi room sensor that shows up in Home Assistant");
  await page.getByTestId("prompt-submit").click();
  await page.getByTestId("questions").waitFor({ timeout: 30000 });
  step("AI asked its questions");
  await shot("questions");

  await page.getByTestId("option-power-usbc").click();
  await page.getByTestId("option-home-esphome").click();
  await page.getByTestId("submit-answers").click();
  await page.getByTestId("questions-answered").waitFor({ timeout: 15000 });
  step("answers sent");

  // the AI writes requirements and moves to Parts
  await page.getByText("Requirements are written down", { exact: false }).waitFor({ timeout: 30000 });
  await page.getByTestId("project-name").filter({ hasText: "Room sensor" }).waitFor({ timeout: 10000 })
    .catch(async () => { throw new Error(`project name not updated: ${await page.getByTestId("project-name").textContent()}`); });
  step("design updated (name, requirements) and the AI finished its turn");
  if (viewport.width < 700) await page.getByTestId("pane-board").click();
  await page.getByTestId("tab-overview").click();
  await page.getByText("Powered from USB-C, 5 V").waitFor({ timeout: 10000 });
  step("requirements visible in the Requirements tab");
  await shot("requirements");

  // reload: everything replays from the server
  await page.reload();
  if (viewport.width < 700) await page.getByTestId("pane-chat").click();
  await page.getByText("Requirements are written down", { exact: false }).waitFor({ timeout: 15000 });
  step("conversation replays after a reload");

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  if (overflow) throw new Error("page scrolls sideways");
  await ctx.close();
}

for (const [name, viewport] of [
  ["phone", { width: 390, height: 844 }],
  ["desktop", { width: 1440, height: 900 }],
]) {
  try {
    await fetch(`${FAKE}/__fake/reload`, { method: "POST" });
    console.log(`${name}:`);
    await run(name, viewport);
  } catch (e) {
    failed = true;
    console.log(`  FAIL ${name}: ${e.message}`);
  }
}
const status = await (await fetch(`${FAKE}/__fake/status`)).json();
await browser.close();
if (status.problems.length) {
  failed = true;
  console.log("stand-in Claude saw problems:", status.problems);
}
if (errors.length) {
  failed = true;
  console.log("console errors:", errors);
}
console.log(failed ? "SMOKE FAILED" : "SMOKE PASSED");
process.exit(failed ? 1 : 0);
