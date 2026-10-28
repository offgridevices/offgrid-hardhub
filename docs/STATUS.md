# Status

Phase 1, as of 28 Oct 2026. What works, how it was checked, and what has not
been checked yet. Every figure below was measured on the commit that adds this
file, in a Linux cloud container (Docker, no GPU).

## Verified

| What | How | Result |
|---|---|---|
| The whole journey in a browser | `./hardhub test` (`e2e/full.mjs`): the real web app, API and KiCad engine, with a scripted stand-in for Claude that speaks the real API's streaming format | **19 of 19 pass.** The AI asks first, compares chips in a table, draws the circuit, sets the board; KiCad places and routes it (about 25 s); every tab renders; the 3D view shows the board; 22 checks, none failing, DRC 0 errors; Gerber zip, BOM and CPL download; every AI request asked for US-only inference |
| Designing from your own AI app (MCP) | `e2e/mcp.mjs` in the same Docker run: the official MCP client (as Claude Code and Codex use it) signs in through a real browser, then designs and builds a board | **24 of 24 pass.** Sent to sign in, registers itself, the consent page names it (phone and desktop), Allow returns a code, it connects; it saves the ESP32-C3 sensor circuit, checks it, builds it in real KiCad (**20 checks pass, 0 fail**), sees the render, reads the BOM, leaves a note; the web app shows all of it live and goes idle after; Settings lists it, and Disconnect locks it out |
| An AI sees its own board | `e2e/mcp.mjs` with real KiCad, every image looked at | `view_board`: top copper with silkscreen, ground highlighted on both layers, silkscreen with a part outlined, a zoomed region with solder mask, the bottom seen from below, 3D isometric and from below; `inspect_board`: 25 parts, 15 nets, DRC 0/0/0; `move_parts` saves a position. Silkscreen (part names, outlines, the board's name) on with DRC still 0/0/0, and Print Hub still builds |
| HardHub's chat on your own Claude Code | `e2e/bridge.mjs`: in Docker, and again against `./hardhub` itself with a stand-in `claude` on the PATH (the real bridge runs it exactly as it would run Claude Code; it calls HardHub's tools over HTTP with the turn's token) | **10 of 10 both times.** Settings finds Claude Code and sees a subscription sign-in; no key needed; the reply streams in; its board work shows as steps; its question shows as cards; the answer resumes the same Claude Code session; the chat goes idle after; `./hardhub stop` stops the bridge. Unit tests check the exact `claude` arguments (no tools, HardHub's MCP only, not `--bare`) and SIGINT on Stop |
| MCP sign-in rules | `apps/api/test/mcp.test.ts` (19 tests), after an independent security review | PKCE required and checked; a code works once, and using it twice ends the connection made from it; refresh tokens rotate, and an old one turning up later ends the connection; Disconnect also voids unredeemed codes; bad requests are never bounced to an app's address; only safe redirect addresses; app descriptions fetched by URL never reach private networks; MCP takes agent tokens only; other people's projects unreachable; agent actions never close a question HardHub's own AI asked, and never change a design mid-build |
| Every screen, every size | the same run: boards, chat, 7 tabs and settings on a phone (390), a tablet (768) and a desktop (1440), light and dark | 60 screens, none scrolls sideways, no console errors; reviewed by eye against the brand rules |
| A first-time person | `e2e/first-run.mjs` against `./hardhub` with no server key | 4 of 4: asked for a key; banner gone once saved; a wrong Claude key (sent to Anthropic's real API) and an Ollama that is not running each give a clear message |
| One-command start | `./hardhub` from nothing | up and healthy in about 17 s with images built; opens the app |
| The engine | `engine/tests` inside the engine image | 20 of 20 pass, including Print Hub (13 min) |
| Print Hub, the benchmark | offgrid-hardware's Print Hub v1 (137 parts, 4 layers) converted to a HardHub design and built by the generic pipeline | **DRC 0 errors, 0 warnings, 0 unconnected; nets match pad for pad**, in 5 min alone (12 min with other builds running alongside). Warnings left: some power tracks narrower than their current asks (Print Hub draws that copper by hand); the ESP32's GPIO0 strapping pin |
| An unscripted design by a live model | `e2e/fake-anthropic` relay mode: each real request (HardHub's own system prompt, tools and history) answered live by a Claude model in another session, from a new prompt: a 12 V LED strip dimmer for Home Assistant | Through every stage: questions, a supply comparison, a 27-part circuit (the checks caught the model's own wrong jack pin; it fixed it), a 2 vs 4 layer quote, a **4-layer KiCad build: DRC 0/0/0, 20 of 23 checks pass, 0 fail**, a look at its own render, ESPHome firmware whose pin map the checks verify, and the order files. Found and fixed 5 bugs on the way |
| `./hardhub deploy` | run against a recording stand-in for wrangler: a fresh account, a repeat deploy, and one with no answers typed | creates D1/R2 in the US, migrates, uploads secrets from a 0600 file that is then deleted, builds the app for `/api`, deploys; repeat deploys create nothing; works on a Node with no corepack (Node 25+ dropped it). Found and fixed: piped answers were lost; Node 25+ had no corepack |
| Apple Silicon readiness | the exact install a Mac's containers do (`pnpm install --frozen-lockfile` for linux/arm64), each native file inspected; the Node image's manifest | every native program (workerd, esbuild, rolldown, lightningcss, sharp) installs as an ARM64 build, none Intel; workerd needs glibc 2.35 and the image has 2.36; `node:22.22.0-bookworm-slim` is published for arm64. Not run: emulating ARM64 here was not allowed. The KiCad engine is amd64 by design (Rosetta) |
| Launcher scripts | shellcheck | clean; no bash 4 features (macOS ships bash 3.2) |
| API and web units | `pnpm -r test` | API 68, web 18, all pass; engine 21 |
| Cloudflare config | `wrangler deploy --dry-run --env production` | one Worker (app + API), D1, R2 (us), Durable Objects; 1020 KiB, 244 KiB gzipped |
| The engine image | `engine/Dockerfile` built here (only its first line swapped for a copy of the KiCad image carrying this container's network certificate) | every download checksum-verified; 1.5 min |

## Not verified yet

| What | Why | How to check |
|---|---|---|
| Claude's real API answering a whole design | no API key in the build container. A live model answered through the real wire format (above), and a wrong key reached Anthropic's real API and was handled | add your key in Settings and describe a board |
| Ollama with `qwen3.5:0.8b` | the model sites were blocked from the build container | `./hardhub ollama`, then Settings → Ollama |
| `./hardhub deploy` against real Cloudflare | Cloudflare's API was blocked from the build container; the script's whole flow ran against a stand-in, and the Worker config passed wrangler's dry run | run it once you have a Workers Paid account |
| The engine's optional fallback router (Freerouting 1.9) | it needs a display package from Debian, whose servers were blocked; the image builds without it and routes with 2.5 | on your Mac the build installs it; `curl localhost:8080/health` shows `"freerouting_fallback": true` |
| Live part prices and stock (JLCPCB / LCSC) | those sites were blocked; tests use recorded part data | ask the AI to look up a part |
| Claude (website, phone, desktop) and ChatGPT connecting over MCP | they connect from their own servers, so HardHub must be online; this container could not reach them. The same sign-in passed with the official MCP client | after `./hardhub deploy`, add `https://<your HardHub>/mcp` as a custom connector |
| Claude Code and Codex connecting on your Mac | not installed in the build container with your accounts | `claude mcp add --transport http hardhub http://localhost:8787/mcp` |
| The real Claude Code designing through the bridge | Claude Code can't run here on your account | `./hardhub`, then Settings → Claude Code on this computer, and describe a board |
| Docker on Apple Silicon | built and run on Linux (amd64); on a Mac the engine runs under Rosetta | `./hardhub` |

## Known limits

- The engine routes 2- and 4-layer boards well. 6+ layers, impedance-controlled
  and length-matched nets are not handled yet.
- Simulations (supply transients, heat) are listed as "not run".
- Sign-in email in production needs a Resend key (`./hardhub deploy` asks).
