// 3D viewer on a real KiCad GLB, in a demo build: load time, main-thread
// long tasks while it loads, and frame times while orbiting.
//   node scripts/perf-glb.mjs http://127.0.0.1:4173 /board.glb OUT.png
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const [base = "http://127.0.0.1:4173", glb = "/print-hub.glb", png] = process.argv.slice(2);
const browser = await chromium.launch();
for (const [name, vp, mobile] of [
  ["desktop", { width: 1440, height: 900 }, false],
  ["phone", { width: 390, height: 844 }, true],
]) {
  const ctx = await browser.newContext({ viewport: vp, isMobile: mobile, hasTouch: mobile, deviceScaleFactor: mobile ? 3 : 1 });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log("pageerror", e.message));
  await page.goto(`${base}/p/demo-hub?glb=${encodeURIComponent(glb)}`);
  await page.getByTestId("chat-log").waitFor();
  if (mobile) await page.getByTestId("pane-board").click();
  await page.evaluate(() => {
    window.__long = [];
    new PerformanceObserver((l) => l.getEntries().forEach((e) => window.__long.push(e.duration))).observe({ type: "longtask", buffered: false });
  });
  const t0 = Date.now();
  await page.getByTestId("tab-3d").click();
  await page.locator('[data-testid="viewer-3d"][data-status="ready"]').waitFor({ timeout: 120000 });
  const loadMs = Date.now() - t0;
  await page.waitForTimeout(500);
  const long = await page.evaluate(() => window.__long.slice());
  const box = await page.getByTestId("viewer-3d-canvas").boundingBox();
  await page.evaluate(() => {
    window.__frames = [];
    let last = performance.now();
    const tick = (t) => {
      window.__frames.push(t - last);
      last = t;
      if (window.__frames.length < 300) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  const before = await page.evaluate(() => ({ ...window.__hh3d }));
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  for (let i = 0; i < 100; i++) await page.mouse.move(cx + Math.sin(i / 10) * box.width * 0.3, cy + Math.cos(i / 14) * 60);
  await page.mouse.up();
  await page.waitForTimeout(500);
  const after = await page.evaluate(() => ({ ...window.__hh3d }));
  const frames = (await page.evaluate(() => window.__frames.slice(1))).sort((a, b) => a - b);
  const pct = (q) => frames[Math.floor(frames.length * q)].toFixed(1);
  const n = after.frames - before.frames;
  console.log(
    `${name} ${glb}: ready in ${loadMs} ms; main-thread long tasks while loading: ${long.length} (longest ${Math.max(0, ...long).toFixed(0)} ms); ` +
      `${after.meshes} meshes, ${after.triangles.toLocaleString()} triangles; orbit: ${n} renders, ` +
      `${((after.renderMs - before.renderMs) / n).toFixed(2)} ms submit per render, frame interval median ${pct(0.5)} ms, p95 ${pct(0.95)} ms`,
  );
  if (png) await page.screenshot({ path: png.replace(".png", `-${name}.png`) });
  await ctx.close();
}
await browser.close();
