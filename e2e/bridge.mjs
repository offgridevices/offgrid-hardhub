// HardHub's chat on the person's own Claude Code, end to end: Settings finds
// Claude Code through the bridge, the person picks it, describes a board, and
// the reply streams in while Claude Code works on the board through HardHub's
// tools, asks a question with cards, and carries on with the answer. The
// `claude` here is e2e/fake-claude/claude.mjs, run by the real bridge.
//
//   node e2e/bridge.mjs [APP_URL] [SHOTS_DIR]
import { createRequire } from "node:module";
import path from "node:path";
import { openOwnChat, signUp } from "./signup.mjs";
const { chromium } = createRequire(import.meta.url)("playwright");

const APP = process.argv[2] ?? "http://localhost:5173";
const SHOTS = process.argv[3];
const t0 = Date.now();
const log = (s) => console.log(`${((Date.now() - t0) / 1000).toFixed(0).padStart(4)}s  ${s}`);
const results = [];
const check = (cond, name, detail = "") => {
  results.push({ name, ok: !!cond });
  log(`${cond ? "ok  " : "FAIL"}  ${name}${detail ? ` (${detail})` : ""}`);
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
const shot = async (n) => SHOTS && page.screenshot({ path: path.join(SHOTS, `bridge-${n}.png`) });
try {
  await page.goto(APP);
  await signUp(page, `bridge-${Date.now()}@example.com`);
  await page.getByTestId("prompt-input").waitFor({ timeout: 20000 });

  await page.goto(`${APP}/settings`);
  await openOwnChat(page);
  await page.getByTestId("provider-claude-code").click();
  const status = page.getByTestId("bridge-status");
  await status.waitFor({ timeout: 30000 });
  const st = await status.textContent();
  check(/2\.1\.300 found.*subscription/.test(st ?? ""), "Settings finds Claude Code, signed in to a subscription", st?.trim());
  await page.getByTestId("model-opus").click();
  await page.getByTestId("save-llm").click();
  await page.getByTestId("settings-msg").waitFor({ timeout: 10000 });
  await shot("settings");

  await page.goto(APP);
  await page.getByTestId("prompt-input").waitFor({ timeout: 10000 });
  check((await page.getByTestId("no-key-bar").count()) === 0, "no 'add a key' banner: Claude Code needs none");
  await page.getByTestId("prompt-input").fill("A garden soil sensor");
  await page.getByTestId("prompt-submit").click();
  await page.getByText("Hello from your own Claude Code.").first().waitFor({ timeout: 60000 });
  check(true, "Claude Code's reply streams into HardHub's chat");
  await page.getByTestId("option-power-usbc").waitFor({ timeout: 30000 });
  check(true, "its question shows as multiple-choice cards");
  check((await page.getByText("Named the board").count()) > 0, "its board work shows as steps in the chat");
  await page.getByText("Bridge sensor").first().waitFor({ timeout: 10000 });
  check(true, "the board's new name shows");
  await shot("question");

  await page.getByTestId("option-power-usbc").click();
  await page.getByTestId("submit-answers").click();
  await page.getByText("Noted: powered by USB-C.").first().waitFor({ timeout: 60000 });
  check(true, "the answer goes back to the same Claude Code conversation");
  // a KiCad build started inside a chat turn runs then, not after the turn;
  // Enter while the last turn is still closing is ignored, so wait for idle
  await page.waitForFunction(() => !document.querySelector('[data-testid="chat-input"]')?.getAttribute("placeholder")?.includes("working"), null, { timeout: 60000 });
  await page.getByTestId("chat-input").fill("Load the sensor circuit and build it");
  await page.getByTestId("chat-input").press("Enter");
  const built = page.getByText(/^Built it: Checks: \d+ pass, 0 fail/).first();
  const notBuilt = page.getByText(/The build did not finish/).first();
  await built.or(notBuilt).waitFor({ timeout: 15 * 60_000 });
  check(await built.isVisible(), "a board build started in a chat turn finishes within that turn", (await built.or(notBuilt).textContent())?.slice(0, 90));
  await page.waitForTimeout(500);
  const input = page.getByTestId("chat-input").or(page.locator("textarea")).first();
  check(!(await input.getAttribute("placeholder"))?.includes("working"), "the chat is idle again after the turn");
  await shot("answered");

  // the chat column, on the right, is the person's to size: dragged by its
  // left edge, and with the arrow keys
  const chatWidth = () => page.locator(".ws-chat").evaluate((e) => e.getBoundingClientRect().width);
  const before = await chatWidth();
  const handle = await page.getByTestId("chat-resize").boundingBox();
  await page.mouse.move(handle.x + handle.width / 2, handle.y + 200);
  await page.mouse.down();
  await page.mouse.move(handle.x - 160, handle.y + 200, { steps: 8 });
  await page.mouse.up();
  const dragged = await chatWidth();
  await page.getByTestId("chat-resize").focus();
  await page.keyboard.press("ArrowRight");
  const nudged = await chatWidth();
  await page.reload();
  await page.getByTestId("chat-log").waitFor({ timeout: 20000 });
  const kept = await chatWidth();
  check(dragged > before + 100 && nudged < dragged && Math.abs(kept - nudged) < 2, "the chat resizes by dragging and by keyboard, and keeps its width", `${before} -> ${dragged} -> ${nudged}, after reload ${kept}`);

  // a board is deleted from the list, after a second click to confirm
  await page.goto(APP);
  const rows = page.getByTestId("project-row");
  await rows.first().waitFor({ timeout: 20000 });
  const n = await rows.count();
  await rows.first().getByTestId("delete-board").click();
  await rows.first().getByTestId("delete-confirm").click();
  await page.waitForFunction((k) => document.querySelectorAll('[data-testid="project-row"]').length === k, n - 1, { timeout: 15000 });
  check(true, "a board is deleted from the list after confirming", `${n} -> ${n - 1}`);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(300);
  check(!(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)), "nothing scrolls sideways on a phone");
  await shot("answered-phone");
} catch (e) {
  check(false, "unexpected error", e?.stack ?? String(e));
  await shot("error");
} finally {
  await browser.close();
}
const pageErrors = errors.filter((e) => !/Failed to load resource/.test(e));
check(pageErrors.length === 0, "no errors in the browser", pageErrors.slice(0, 3).join(" | "));
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} of ${results.length} passed`);
process.exit(failed.length ? 1 : 0);
