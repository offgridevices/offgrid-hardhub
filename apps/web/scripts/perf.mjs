// Local performance numbers on a demo build: first paint and first
// contentful paint of the boards screen, and frame times while orbiting the
// 3D board.   node scripts/perf.mjs http://127.0.0.1:4173
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const base = process.argv[2] ?? "http://127.0.0.1:4173";
const browser = await chromium.launch();

for (const [name, vp, mobile] of [
  ["desktop", { width: 1440, height: 900 }, false],
  ["phone", { width: 390, height: 844 }, true],
]) {
  const ctx = await browser.newContext({ viewport: vp, isMobile: mobile, hasTouch: mobile, deviceScaleFactor: mobile ? 3 : 1 });
  const page = await ctx.newPage();
  const runs = [];
  for (let i = 0; i < 5; i++) {
    await page.goto(base + "/", { waitUntil: "load" });
    await page.getByTestId("prompt-input").waitFor();
    runs.push(
      await page.evaluate(() => {
        const p = Object.fromEntries(performance.getEntriesByType("paint").map((e) => [e.name, e.startTime]));
        const nav = performance.getEntriesByType("navigation")[0];
        return { fp: p["first-paint"], fcp: p["first-contentful-paint"], dcl: nav.domContentLoadedEventEnd };
      }),
    );
  }
  const med = (k) => runs.map((r) => r[k]).sort((a, b) => a - b)[2].toFixed(0);
  console.log(`${name}: first contentful paint ${med("fcp")} ms (median of 5), DOM ready ${med("dcl")} ms`);

  await page.goto(base + "/p/demo-hub?tab=3d");
  if (mobile) await page.getByTestId("pane-board").click();
  await page.locator('[data-testid="viewer-3d"][data-status="ready"]').waitFor({ timeout: 20000 });
  const box = await page.getByTestId("viewer-3d-canvas").boundingBox();
  const idle0 = await page.evaluate(() => window.__hh3d.frames);
  await page.waitForTimeout(1000);
  const idle1 = await page.evaluate(() => window.__hh3d.frames);
  await page.evaluate(() => {
    window.__frames = [];
    let last = performance.now();
    const tick = (t) => {
      window.__frames.push(t - last);
      last = t;
      if (window.__frames.length < 400) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  const before = await page.evaluate(() => ({ ...window.__hh3d }));
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  for (let i = 0; i < 120; i++) await page.mouse.move(cx + Math.sin(i / 10) * box.width * 0.3, cy + Math.cos(i / 14) * 60, { steps: 1 });
  await page.mouse.up();
  await page.waitForTimeout(600);
  const after = await page.evaluate(() => ({ ...window.__hh3d }));
  const frames = await page.evaluate(() => window.__frames.slice(1));
  frames.sort((a, b) => a - b);
  const pct = (q) => frames[Math.floor(frames.length * q)].toFixed(1);
  const renders = after.frames - before.frames;
  console.log(
    `${name} 3D: ${after.meshes} meshes, ${after.triangles} triangles; while orbiting ${renders} renders, ` +
      `GPU-submit time ${((after.renderMs - before.renderMs) / renders).toFixed(2)} ms per render; ` +
      `frame interval median ${pct(0.5)} ms, p95 ${pct(0.95)} ms; renders while idle for 1 s: ${idle1 - idle0}`,
  );
  await ctx.close();
}
await browser.close();
