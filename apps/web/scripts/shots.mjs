// Screenshots of every screen at phone, tablet and desktop sizes, light and
// dark, from a demo build (VITE_MOCK=1). Reports console errors and any
// sideways page scroll.   node scripts/shots.mjs http://127.0.0.1:4173 OUTDIR [phone|tablet|desktop] [light|dark]
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const base = process.argv[2] ?? "http://127.0.0.1:4173";
const out = process.argv[3] ?? "shots";
const only = process.argv[4]; // optional: phone | tablet | desktop
const onlyTheme = process.argv[5]; // optional: light | dark
mkdirSync(out, { recursive: true });

const sizes = { phone: [390, 844], tablet: [768, 1024], desktop: [1440, 900] };
const tabs = ["overview", "parts", "circuit", "board", "3d", "checks", "order"];
const problems = [];

const browser = await chromium.launch();
for (const [sizeName, [w, h]] of Object.entries(sizes)) {
  if (only && only !== sizeName) continue;
  for (const theme of ["dark", "light"]) {
    if (onlyTheme && onlyTheme !== theme) continue;
    const phone = sizeName === "phone";
    const ctx = await browser.newContext({
      viewport: { width: w, height: h },
      deviceScaleFactor: sizeName === "desktop" ? 1 : 2,
      colorScheme: theme,
      hasTouch: phone,
      isMobile: phone,
    });
    const page = await ctx.newPage();
    page.on("console", (m) => m.type() === "error" && problems.push(`${sizeName}/${theme} console: ${m.text()}`));
    page.on("pageerror", (e) => problems.push(`${sizeName}/${theme} pageerror: ${e.message}`));
    const shot = async (name) => {
      await page.waitForTimeout(250);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      if (overflow > 0) problems.push(`${sizeName}/${theme}/${name}: page scrolls sideways by ${overflow}px`);
      await page.screenshot({ path: `${out}/${sizeName}-${theme}-${name}.png` });
    };
    // below 700 px the workspace shows chat or design, switched at the bottom
    const narrow = w < 700;

    await page.goto(base + "/");
    await page.getByTestId("prompt-input").waitFor();
    await shot("projects");

    await page.goto(base + "/p/demo-garden");
    await page.getByTestId("questions").waitFor();
    await shot("chat-questions");

    await page.goto(base + "/p/demo-hub");
    await page.getByTestId("chat-log").waitFor();
    await page.waitForTimeout(400);
    await shot("chat-history");
    if (narrow) await page.getByTestId("pane-board").click();
    for (const t of tabs) {
      await page.getByTestId(`tab-${t}`).click();
      if (t === "3d") await page.locator('[data-testid="viewer-3d"][data-status="ready"]').waitFor({ timeout: 20000 });
      if (t === "board") await page.waitForTimeout(600);
      await shot(`tab-${t}`);
    }

    // the board tests on the room sensor: the verdict and the list, one row
    // opened, the heat map, power and ratings, a live run, a spot shown on
    // the board, and the layers pulled apart in 3D
    await page.goto(base + "/p/demo-sensor?tab=checks");
    if (narrow) await page.getByTestId("pane-board").click();
    await page.getByTestId("verdict").waitFor();
    await page.getByTestId("simulations").waitFor({ timeout: 10000 });
    await shot("tests");
    const row = page.getByTestId("check-row").first();
    await row.locator("button").first().click();
    await row.scrollIntoViewIfNeeded();
    await shot("tests-row");
    await page.getByTestId("filter-all").click();
    await shot("tests-all");
    await page.getByTestId("board-summary").scrollIntoViewIfNeeded();
    await shot("tests-board");
    await page.getByTestId("heat").scrollIntoViewIfNeeded();
    const map = page.getByTestId("heat-map");
    const mb = await map.boundingBox();
    if (mb) await page.mouse.move(mb.x + mb.width * 0.3, mb.y + mb.height * 0.35);
    await shot("tests-heat");
    await page.getByTestId("power").scrollIntoViewIfNeeded();
    await shot("tests-power");
    await page.getByTestId("ratings").scrollIntoViewIfNeeded();
    await shot("tests-ratings");
    // a live run: half-way through
    await page.evaluate(() => document.querySelector('[data-testid="tests"]')?.parentElement?.scrollTo(0, 0));
    await page.getByTestId("run-tests").click();
    await page.getByTestId("check-pending").first().waitFor();
    await page.waitForTimeout(2600);
    await shot("tests-live");
    await page.locator('[data-testid="verdict"]:not([data-verdict="running"])').waitFor({ timeout: 30000 });
    // "Show on board" from the first thing to fix
    await page.getByTestId("filter-fail").click();
    await page.getByTestId("check-row").first().locator("button").first().click();
    await page.getByTestId("show-on-board").first().click();
    await page.getByTestId("board-focus").waitFor();
    await page.waitForTimeout(500);
    await shot("board-focus");
    await page.goto(base + "/p/demo-sensor?tab=3d&view=layers");
    if (narrow) await page.getByTestId("pane-board").click();
    await page.locator('[data-testid="viewer-3d"][data-status="ready"]').waitFor({ timeout: 20000 });
    await page.waitForTimeout(1200);
    await shot("3d-layers");

    await page.goto(base + "/settings");
    await page.getByTestId("provider-anthropic").waitFor();
    await shot("settings");
    await page.getByTestId("provider-ollama").click();
    await shot("settings-ollama");
    await page.getByTestId("signout").click();
    await page.getByTestId("signin-email").waitFor();
    await shot("signin");
    await ctx.close();
  }
}
await browser.close();
console.log(problems.length ? "PROBLEMS:\n" + problems.join("\n") : "no console errors, no sideways scroll");
