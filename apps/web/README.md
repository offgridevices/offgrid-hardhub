# HardHub web app

Static files (React, Vite) that talk to the HardHub API.

| Command | What it does |
|---|---|
| `pnpm --filter @hardhub/web dev` | dev server on `0.0.0.0:5173`, API at `VITE_API_URL` (default `http://localhost:8787`) |
| `VITE_MOCK=1 pnpm --filter @hardhub/web dev` | demo mode: the whole interface on scripted data, no server |
| `pnpm --filter @hardhub/web build` | static files in `apps/web/dist` |
| `pnpm --filter @hardhub/web preview` | serve `dist` on `0.0.0.0:5173` |
| `pnpm --filter @hardhub/web test` | unit tests (event folding, API client, demo geometry) |
| `docker build -f apps/web/Dockerfile -t hardhub-web .` | the same, as an image (build from the repository root) |
| `npx wrangler deploy --config apps/web/wrangler.jsonc` | to Cloudflare as static assets, after a build |

Checks that run against a demo build served on `:4173`
(`VITE_MOCK=1 pnpm --filter @hardhub/web build -- --outDir dist-mock`, then
`vite preview --outDir dist-mock --port 4173`):

* `node scripts/shots.mjs http://127.0.0.1:4173 OUT [phone|tablet|desktop]` —
  every screen at 390×844, 768×1024 and 1440×900, light and dark; reports
  console errors and sideways scroll.
* `node scripts/perf.mjs http://127.0.0.1:4173` — first contentful paint and
  3D frame times.
* `node scripts/perf-glb.mjs http://127.0.0.1:4173 /board.glb` — the 3D view
  on a real KiCad GLB copied into `dist-mock/` (demo mode shows it with
  `/p/demo-hub?tab=3d&glb=/board.glb`).

## How it stays fast

* Every screen and every workspace tab is its own chunk; light tabs are
  fetched while the browser is idle, 3D (three.js) only when opened.
* The event stream is folded once per animation frame, never per token.
* Chat renders its last 120 items, and items off screen skip layout
  (`content-visibility`).
* The GLB is fetched, parsed, merged into one mesh per colour and side, and
  simplified for phones in a Web Worker; the main thread only uploads buffers.
* The 3D view draws only when something moves, caps the pixel ratio on phones
  and drops to 1× while a finger turns the board.
* Board layers are SVG images, decoded off the main thread; pan and zoom move
  one transformed element without React.
* Latin font subsets only, the body faces preloaded.
