# Status

## Board tests (3 Nov 2026)

Every build, hand edit and test run now runs the board test suite
(`engine/hardhub/review`, the Rust solver `engine/sim`, ngspice): about 90
tests in 13 areas, listed in [board-tests.md](board-tests.md). Measured in a
Linux cloud container on the ESP32-C3 sensor fixture (2 layers, 25 parts),
with KiCad 10.0.7 from KiCad's own Docker image (this container could not
reach KiCad's Ubuntu package site; CI builds the engine from the real recipe).

| What | How | Result |
|---|---|---|
| The whole suite on a real build | `engine/tests/test_review.py` | 87 tests in **0.6 s** of an 18 s build (routing is 11 s); every planned test reports; nothing "not run" for want of a tool |
| Flaws drawn on purpose are caught where they are | the same file: a track 0.05 mm from another net, a 0.1 mm track, a loose right-angle L | gap **fail** with the place within 1.5 mm of where it was drawn; track width **fail** at 0.1 mm; corner **warn** at the corner; loose end **warn**; DRC **fail** |
| A heavy load on a hot day | the board at 1 A on a 70 °C day | the regulator's silicon past 125 °C: **fail**, with the reason ((5 − 3.3) V × 1 A) and the fix |
| The heat is physical | the fixture at 0 / 25 / 50 °C | regulator board 68 °C on a 50 °C day at its 0.2 W average; 25 °C cooler outside gives ~25 °C cooler on the board |
| The Rust solver against physics | `cargo test` in `engine/sim` (34 tests) | one track = ρL/(wt) within 1 %; parallel paths halve; a copper pour = sheet resistance × L/W within 3 %; uniform heating = q/(h_top + h_bottom); a point source matches the analytic K0 decay within 5 %; heat in = heat out within 1 %; clearance, corners, acid traps, shorts on hand-made geometry |
| The Rust solver against KiCad | four real KiCad boards exported and compared with `kicad-cli pcb drc` | dangling vias identical; no false shorts |
| Electrical rules and ngspice | `engine/tests/test_review_electrical.py` (30 tests, ngspice 42 and 44) | a 6.3 V capacitor on 12 V, a 100 Ω 0402 across 5 V, an LED on 10 Ω, missing USB-C CC resistors, no decoupling, an LDO without headroom, 2 A from a 1 A LDO, 12 V into an AP2112, no I2C pull-ups, a floating EN: each caught; a 1k/1k divider simulates to 1.65 V and 2.72 mW |
| The test runs, live | API tests (`apps/api/test/tests.test.ts`), web reducer tests | each finished test goes out live (not stored), the run's start and end are stored; a run always ends (a stopped build, an engine error, a restart); results replace the list only when they follow the run |
| The engine's report reads in the app | `packages/protocol/test/review.test.ts` on a report the engine wrote | parses; older reports with empty fields too |
| Unit tests | `pnpm -r test`, engine tests in the image | protocol 3, API 98, web 61; engine 75 pass, 1 skipped (Print Hub board not in the container) |

What the fixture's own tests found (a real board's findings, left as they are):
the module's 3.3 V capacitor 21.5 mm from its pin; the sensor at the board
edge; a via in the regulator's small ground pad; 3.5 % lost in the 3.3 V copper
at the 0.5 A peak; no fuse or surge protection on USB power; the 22 µF and 10 µF
ceramics keep about a third of their value at their voltage.

Not verified: arm64 build of the Rust stage (no emulation here; no
architecture-specific code); part ratings and JLCPCB limits checked against
the makers' own pages (those sites were blocked: values from memory and search
results are marked "assumed" in the tests); the tests on boards of 4+ layers
beyond one 4-layer build of the fixture.

Phase 1, as of 28 Oct 2026. What works, how it was checked, and what has not
been checked yet. Every figure below was measured on the commit that adds this
file, in a Linux cloud container (Docker, no GPU), with the earlier amd64-only
engine (KiCad 10.0.6); the Mac run after it is in its own section below.

## Verified

| What | How | Result |
|---|---|---|
| The whole journey in a browser | `./hardhub test` (`e2e/full.mjs`): the real web app, API and KiCad engine, with a scripted stand-in for Claude that speaks the real API's streaming format | **19 of 19 pass.** The AI asks first, compares chips in a table, draws the circuit, sets the board; KiCad places and routes it (about 25 s); every tab renders; the 3D view shows the board; 22 checks, none failing, DRC 0 errors; Gerber zip, BOM and CPL download; every AI request asked for US-only inference |
| Designing from your own AI app (MCP) | `e2e/mcp.mjs` in the same Docker run: the official MCP client (as Claude Code and Codex use it) signs in through a real browser, then designs and builds a board | **24 of 24 pass.** Sent to sign in, registers itself, the consent page names it (phone and desktop), Allow returns a code, it connects; it saves the ESP32-C3 sensor circuit, checks it, builds it in real KiCad (**20 checks pass, 0 fail**), sees the render, reads the BOM, leaves a note; the web app shows all of it live and goes idle after; Settings lists it, and Disconnect locks it out |
| An AI sees its own board | `e2e/mcp.mjs` with real KiCad, every image looked at | `view_board`: top copper with silkscreen, ground highlighted on both layers, silkscreen with a part outlined, a zoomed region with solder mask, the bottom seen from below, 3D isometric and from below; `inspect_board`: 25 parts, 15 nets, DRC 0/0/0; `move_parts` saves a position. Silkscreen (part names, outlines, the board's name) on with DRC still 0/0/0, and Print Hub still builds |
| HardHub's chat on your own Claude Code | `e2e/bridge.mjs`: in Docker, and again against `./hardhub` itself with a stand-in `claude` on the PATH (the real bridge runs it exactly as it would run Claude Code; it calls HardHub's tools over HTTP with the turn's token) | **10 of 10 both times.** Settings finds Claude Code and sees a subscription sign-in; no key needed; the reply streams in; its board work shows as steps; its question shows as cards; the answer resumes the same Claude Code session; the chat goes idle after; `./hardhub stop` stops the bridge. Unit tests check the exact `claude` arguments (no tools, HardHub's MCP only, not `--bare`) and SIGINT on Stop |
| MCP sign-in rules | `apps/api/test/mcp.test.ts` (19 tests), after an independent security review | PKCE required and checked; a code works once, and using it twice ends the connection made from it; refresh tokens rotate, and an old one turning up later ends the connection; Disconnect also voids unredeemed codes; bad requests are never bounced to an app's address; only safe redirect addresses; app descriptions fetched by URL never reach private networks; MCP takes agent tokens only; other people's projects unreachable; agent actions never close a question HardHub's own AI asked, and never change a design mid-build |
| Every screen, every size | the same run: boards, chat, 7 tabs and settings on a phone (390), a tablet (768) and a desktop (1440), light and dark | 60 screens, none scrolls sideways, no console errors; reviewed by eye against the brand rules |
| A first-time person | `e2e/first-run.mjs` against `./hardhub` with no server key | 6 of 6: asked for a key; a closed note stays closed after a reload, on the boards page and above the chat; banner gone once saved; a wrong Claude key (sent to Anthropic's real API) and an Ollama that is not running each give a clear message |
| One-command start | `./hardhub` from nothing | up and healthy in about 17 s with images built; opens the app |
| The engine | `engine/tests` inside the engine image | 20 of 20 pass, including Print Hub (13 min) |
| Print Hub, the benchmark | offgrid-hardware's Print Hub v1 (137 parts, 4 layers) converted to a HardHub design and built by the generic pipeline | **DRC 0 errors, 0 warnings, 0 unconnected; nets match pad for pad**, in 5 min alone (12 min with other builds running alongside). Warnings left: some power tracks narrower than their current asks (Print Hub draws that copper by hand); the ESP32's GPIO0 strapping pin |
| An unscripted design by a live model | `e2e/fake-anthropic` relay mode: each real request (HardHub's own system prompt, tools and history) answered live by a Claude model in another session, from a new prompt: a 12 V LED strip dimmer for Home Assistant | Through every stage: questions, a supply comparison, a 27-part circuit (the checks caught the model's own wrong jack pin; it fixed it), a 2 vs 4 layer quote, a **4-layer KiCad build: DRC 0/0/0, 20 of 23 checks pass, 0 fail**, a look at its own render, ESPHome firmware whose pin map the checks verify, and the order files. Found and fixed 5 bugs on the way |
| `./hardhub deploy` | run against a recording stand-in for wrangler: a fresh account, a repeat deploy, and one with no answers typed | creates D1/R2 in the US, migrates, uploads secrets from a 0600 file that is then deleted, builds the app for `/api`, deploys; repeat deploys create nothing; works on a Node with no corepack (Node 25+ dropped it). Found and fixed: piped answers were lost; Node 25+ had no corepack |
| Apple Silicon readiness | the exact install a Mac's containers do (`pnpm install --frozen-lockfile` for linux/arm64), each native file inspected; the Node image's manifest | every native program (workerd, esbuild, rolldown, lightningcss, sharp) installs as an ARM64 build, none Intel; workerd needs glibc 2.35 and the image has 2.36; `node:22.22.0-bookworm-slim` is published for arm64. Run on a Mac since: see below |
| Launcher scripts | shellcheck | clean; no bash 4 features (macOS ships bash 3.2) |
| API and web units | `pnpm -r test` | API 68, web 18, all pass; engine 21 |
| Cloudflare config | `wrangler deploy --dry-run --env production` | one Worker (app + API), D1, R2 (us), Durable Objects; 1020 KiB, 244 KiB gzipped |
| The engine image | `engine/Dockerfile` built here (only its first line swapped for a copy of the KiCad image carrying this container's network certificate) | every download checksum-verified; 1.5 min |

## On an Apple Silicon Mac (28 Oct 2026)

Run on an M-series Mac with Colima (Docker without the Compose add-on, no
Docker Desktop), after the engine moved to a native arm64 build.

| What | Result |
|---|---|
| Engine image, native arm64 | builds in 1.5 min, 870 MB; KiCad 10.0.7, Freerouting 2.5.0, and the 1.9 fallback all present (`/health`) |
| Engine tests | **22 of 22**, Print Hub included: **DRC clean in 83 s** (5 min on the cloud container) |
| `./hardhub test` | **63 of 63**: the journey 19/19 (layout and routing in about 12 s), MCP 33/33, Claude Code bridge 11/11; 60 screens at 3 sizes in light and dark, none scrolls sideways, no console errors |
| `./hardhub` from Colima | up in 18 s, Compose run from Docker's CLI image, nothing installed on the Mac |
| Engine image, amd64 (Cloudflare's) | the same recipe built under emulation: 880 MB, engine tests 21 of 21 (Print Hub not mounted there) |
| API and web units | API 73, web 18 |
| Ollama with `gemma4:e4b-mlx` | asked HardHub's real first request 5 times: **no tool calls at all** (it writes them as text). The same model on Ollama's other runner, `gemma4:e4b`, calls tools but sends malformed design edits and gives up; HardHub stops it with "pick a more capable model". Too small for real boards |

Found and fixed on the way: KiCad 10.0.7 no longer writes the project file
when a script saves a new board, so the fab limits and net classes were lost
and DRC fell back to KiCad's defaults (KiCad's own 10.0.7 image does the
same; the board is now made with `pcbnew.NewBoard`); the view tool needed
librsvg, which the old KiCad image happened to carry; an empty reply from
the model left a chat stuck for good.

## Not verified yet

| What | Why | How to check |
|---|---|---|
| Claude's real API answering a whole design | no API key in the build container. A live model answered through the real wire format (above), and a wrong key reached Anthropic's real API and was handled | add your key in Settings and describe a board |
| Ollama with `qwen3.5:0.8b` | not downloaded on the Mac (the owner chose Gemma instead, above) | `./hardhub ollama`, then Settings → Ollama |
| `./hardhub deploy` against real Cloudflare | Cloudflare's API was blocked from the build container; the script's whole flow ran against a stand-in, and the Worker config passed wrangler's dry run. On a Mac without Docker's buildx add-on (Colima), wrangler's image build needs it | run it once you have a Workers Paid account |
| Live part prices and stock (JLCPCB / LCSC) | those sites were blocked; tests use recorded part data | ask the AI to look up a part |
| Claude (website, phone, desktop) and ChatGPT connecting over MCP | they connect from their own servers, so HardHub must be online; this container could not reach them. The same sign-in passed with the official MCP client | after `./hardhub deploy`, add `https://<your HardHub>/mcp` as a custom connector |
| Claude Code and Codex connecting on your Mac | not installed in the build container with your accounts | `claude mcp add --transport http hardhub http://localhost:8787/mcp` |
| The real Claude Code designing through the bridge | Claude Code can't run here on your account | `./hardhub`, then Settings → Claude Code on this computer, and describe a board |

## Known limits

- The engine routes 2- and 4-layer boards well. 6+ layers, impedance-controlled
  and length-matched nets are not handled yet.
- Simulations are first-order: the thermal model is a thin plate (no air flow, no enclosure beyond a factor); regulators in the supply simulations are simple models, said so in each result.
- Sign-in is email and password, with no email service; only the first account (the owner's) can be made unless `ALLOW_SIGNUP=1`. A lost password is set with `./hardhub reset-password`.
