// Screenshots of every screen at phone, tablet and desktop sizes, light and
// dark, from a demo build (VITE_MOCK=1). Reports console errors and any
// sideways page scroll.   node scripts/shots.mjs http://127.0.0.1:4173 OUTDIR
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const base = process.argv[2] ?? "http://127.0.0.1:4173";
const out = process.argv[3] ?? "shots";
const only = process.argv[4]; // optional: phone | tablet | desktop
mkdirSync(out, { recursive: true });

const sizes = { phone: [390, 844], tablet: [768, 1024], desktop: [1440, 900] };
const tabs = ["overview", "parts", "circuit", "board", "3d", "checks", "order"];
const problems = [];

const browser = await chromium.launch();
for (const [sizeName, [w, h]] of Object.entries(sizes)) {
  if (only && only !== sizeName) continue;
  for (const theme of ["dark", "light"]) {
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
    const narrow = w < 900;

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
