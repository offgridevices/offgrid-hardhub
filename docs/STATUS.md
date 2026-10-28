# Status

Phase 1, as of 28 Oct 2026. What works, how it was checked, and what has not
been checked yet. Every figure below was measured on the commit that adds this
file, in a Linux cloud container (Docker, no GPU).

## Verified

| What | How | Result |
|---|---|---|
| The whole journey in a browser | `./hardhub test` (`e2e/full.mjs`): the real web app, API and KiCad engine, with a scripted stand-in for Claude that speaks the real API's streaming format | **19 of 19 pass.** The AI asks first, compares chips in a table, draws the circuit, sets the board; KiCad places and routes it (about 25 s); every tab renders; the 3D view shows the board; 22 checks, none failing, DRC 0 errors; Gerber zip, BOM and CPL download; every AI request asked for US-only inference |
| Every screen, every size | the same run: boards, chat, 7 tabs and settings on a phone (390), a tablet (768) and a desktop (1440), light and dark | 60 screens, none scrolls sideways, no console errors; reviewed by eye against the brand rules |
| A first-time person | `e2e/first-run.mjs` against `./hardhub` with no server key | 4 of 4: asked for a key; banner gone once saved; a wrong Claude key (sent to Anthropic's real API) and an Ollama that is not running each give a clear message |
| One-command start | `./hardhub` from nothing | up and healthy in about 17 s with images built; opens the app |
| The engine | `engine/tests` inside the engine image | 20 of 20 pass, including Print Hub (13 min) |
| Print Hub, the benchmark | offgrid-hardware's Print Hub v1 (137 parts, 4 layers) converted to a HardHub design and built by the generic pipeline | **DRC 0 errors, 0 warnings, 0 unconnected; nets match pad for pad**, in 5 min alone (12 min with other builds running alongside). Warnings left: some power tracks narrower than their current asks (Print Hub draws that copper by hand); the ESP32's GPIO0 strapping pin |
| API and web units | `pnpm -r test` | API 36, web 18, all pass |
| Cloudflare config | `wrangler deploy --dry-run --env production` | one Worker (app + API), D1, R2 (us), Durable Objects; 1020 KiB, 244 KiB gzipped |
| The engine image | `engine/Dockerfile` built here (only its first line swapped for a copy of the KiCad image carrying this container's network certificate) | every download checksum-verified; 1.5 min |

## Not verified yet

| What | Why | How to check |
|---|---|---|
| A real AI designing a board | no API key in the build container; the stand-in replays a scripted design | add your key in Settings and describe a board |
| Ollama with `qwen3.5:0.8b` | the model sites were blocked from the build container | `./hardhub ollama`, then Settings → Ollama |
| `./hardhub deploy` against Cloudflare | Cloudflare's API was blocked from the build container | run it once you have a Workers Paid account |
| The engine's optional fallback router (Freerouting 1.9) | it needs a display package from Debian, whose servers were blocked; the image builds without it and routes with 2.5 | on your Mac the build installs it; `curl localhost:8080/health` shows `"freerouting_fallback": true` |
| Live part prices and stock (JLCPCB / LCSC) | those sites were blocked; tests use recorded part data | ask the AI to look up a part |
| Docker on Apple Silicon | built and run on Linux (amd64); on a Mac the engine runs under Rosetta | `./hardhub` |

## Known limits

- The engine routes 2- and 4-layer boards well. 6+ layers, impedance-controlled
  and length-matched nets are not handled yet.
- Simulations (supply transients, heat) are listed as "not run".
- Sign-in email in production needs a Resend key (`./hardhub deploy` asks).
