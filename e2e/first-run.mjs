// A first-time person on a fresh install, with no AI key on the server:
// they are asked for a key, add one in Settings, and when the AI cannot be
// reached (a wrong key, Ollama not running) they get a clear message instead
// of a spinner that never ends. Run against `./hardhub` (no stand-in AI).
//
//   node e2e/first-run.mjs [APP_URL] [SHOTS_DIR]
import { createRequire } from "node:module";
import path from "node:path";
const { chromium } = createRequire(import.meta.url)("playwright");

const APP = process.argv[2] ?? "http://localhost:5173";
const SHOTS = process.argv[3];
const results = [];
const ok = (n, d = "") => (results.push(true), console.log(`ok    ${n}${d ? ` (${d})` : ""}`));
const fail = (n, d) => (results.push(false), console.log(`FAIL  ${n}: ${d}`));

const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
const shot = async (n) => SHOTS && page.screenshot({ path: path.join(SHOTS, `first-run-${n}.png`) });
try {
  await page.goto(APP);
  await page.getByTestId("signin-email").fill(`first-${Date.now()}@example.com`);
  await page.getByTestId("signin-submit").click();
  await page.getByTestId("prompt-input").waitFor({ timeout: 20000 });
  (await page.getByTestId("no-key-bar").count()) ? ok("asked to add an AI key") : fail("asked to add an AI key", "no banner");
  await shot("no-key");

  // Claude with a key that is not real
  await page.getByTestId("nav-settings").click();
  await page.getByTestId("provider-anthropic").click();
  await page.getByTestId("key-input").fill("sk-ant-api03-not-a-real-key-000000000000");
  await page.getByTestId("save-key").click();
  await page.getByTestId("settings-msg").waitFor({ timeout: 10000 });
  await shot("key-saved");
  await page.goto(APP);
  await page.getByTestId("prompt-input").waitFor({ timeout: 20000 });
  (await page.getByTestId("no-key-bar").count()) ? fail("banner gone after adding a key", "still shown") : ok("banner gone after adding a key");

  await page.getByTestId("prompt-input").fill("A USB-C powered LED strip controller");
  await page.getByTestId("prompt-submit").click();
  const err = page.locator(".chat-error, [data-testid=chat-error], [role=alert]").first();
  await err.waitFor({ timeout: 90000 });
  const msg = (await err.textContent())?.trim() ?? "";
  msg.length > 10 ? ok("a clear error instead of a hang", msg.slice(0, 120)) : fail("a clear error", msg);
  await shot("bad-key");

  // Ollama, not running on this computer
  await page.getByTestId("nav-settings").click();
  await page.getByTestId("provider-ollama").click();
  await page.getByTestId("save-llm").click();
  await page.getByTestId("settings-msg").waitFor({ timeout: 10000 });
  await page.goto(APP);
  await page.getByTestId("prompt-input").fill("A tiny temperature logger");
  await page.getByTestId("prompt-submit").click();
  const err2 = page.locator(".chat-error, [data-testid=chat-error], [role=alert]").first();
  await err2.waitFor({ timeout: 90000 });
  const msg2 = (await err2.textContent())?.trim() ?? "";
  /ollama/i.test(msg2) ? ok("Ollama not running: says so", msg2.slice(0, 120)) : fail("Ollama not running: says so", msg2.slice(0, 160));
  await shot("ollama-down");
} catch (e) {
  fail("first run", e.message.split("\n")[0]);
  await shot("failure").catch(() => {});
}
await browser.close();
const bad = results.filter((r) => !r).length;
console.log(`\n${results.length - bad} passed, ${bad} failed`);
process.exit(bad ? 1 : 0);
