# HardHub

*HardHub by OffGrid* — describe the hardware you want; HardHub's AI asks the
right questions, picks parts with you, designs and routes the circuit board in
KiCad, checks it, shows it in 3D, and hands you the files JLCPCB needs to build
and assemble it.

> The model proposes. It doesn't decide.

## Run it on your computer

You need [Docker Desktop](https://www.docker.com/products/docker-desktop/). Then:

```bash
./hardhub
```

The first run downloads KiCad and builds everything (about 10 minutes on a Mac);
later runs start in seconds. Your browser opens http://localhost:5173. Sign in
with any email (local mode needs no email), open **Settings**, and pick the AI:

| AI | What you need |
|---|---|
| Claude (recommended) | an [Anthropic API key](https://console.anthropic.com/). Max plans include monthly API credit. Runs on US servers only. |
| Ollama on your computer | [Ollama](https://ollama.com/download), then `./hardhub ollama` to fetch the small model. Nothing leaves your computer; fine for trying HardHub, too small for real boards. |
| OpenRouter, OpenAI, any OpenAI-compatible API | that provider's key |

### Use your Claude subscription in HardHub's own chat

If [Claude Code](https://code.claude.com/docs/en/setup) is installed and signed
in on your Mac (and Node.js 20+), `./hardhub` finds it and starts a small helper
(`bridge/`). Pick **Settings → Claude Code on this computer**: HardHub's chat then
runs on your own Claude Code and your Claude plan, with no API key. Each turn
runs the official, unmodified `claude` program with only HardHub's board tools
(no shell, no files, none of your other MCP servers), as Anthropic's terms ask.
Subscriptions can't be pinned to US servers the way the API can.

### Or use the Claude or ChatGPT you already pay for

HardHub is also an MCP server: connect your own AI app and it designs boards
on your own plan, with no API key. HardHub does the parts, the checks and the
KiCad builds, and the project shows up live in the HardHub app. Settings →
"Use your own Claude or ChatGPT" has the address and the steps; on your Mac:

```bash
claude mcp add --transport http hardhub http://localhost:8787/mcp   # Claude Code
codex mcp add hardhub --url http://localhost:8787/mcp               # Codex, then: codex mcp login hardhub
```

The first time, a HardHub page opens and asks you to allow it. Claude (website,
desktop, phone) and ChatGPT connect from their own servers, so they need
HardHub on Cloudflare: add `https://<your HardHub>/mcp` as a custom connector
(Claude: Settings → Connectors; ChatGPT: Settings → Apps → Developer mode).
Your Claude or ChatGPT login stays there: HardHub only sees the tool calls.

| Command | Does |
|---|---|
| `./hardhub` | start, and open the app |
| `./hardhub stop` | stop (projects are kept) |
| `./hardhub logs` | follow the logs |
| `./hardhub test` | end-to-end test: a scripted AI designs a board through the real app and engine |
| `./hardhub reset` | stop and delete local data |
| `./hardhub deploy` | put it on Cloudflare (below) |

On Apple Silicon the KiCad engine runs under Rosetta (KiCad publishes Intel
Linux images only): turn on Docker Desktop → Settings → General → "Use Rosetta
for x86_64/amd64 emulation".

## Put it on Cloudflare

You need a Cloudflare account on the Workers Paid plan (Containers need it),
Node.js 22+ and Docker. Then:

```bash
./hardhub deploy
```

It signs you in to Cloudflare, creates the database and file storage in the US
jurisdiction, and deploys one Worker that serves the app and the API, with the
KiCad engine as a Cloudflare Container (US placement). It asks once for a
[Resend](https://resend.com) key so sign-in links can be emailed. Run it again
to ship an update.

## What is inside

| Folder | What |
|---|---|
| `apps/web` | the web app: React, Vite, three.js; works from phone to desktop |
| `apps/api` | Cloudflare Worker, a Durable Object per project, D1, R2, the AI agent loop, and the MCP server with its OAuth sign-in |
| `packages/protocol` | the shared contract: the design document, events, REST, engine |
| `engine` | KiCad 10 + Freerouting in Docker: design → placed, routed, checked board → fab files |
| `bridge` | the helper that runs your own Claude Code for HardHub's chat (local only) |
| `e2e` | end-to-end tests and the scripted stand-in for Claude |
| `docs/PLAN.md` | the plan of record and the decisions behind it |
| `docs/STATUS.md` | what is verified, how, and what is not yet |

Every iOS or Android app later talks to the same API as the web app.

## Licence

[AGPL-3.0-or-later](LICENSE). Boards you design with HardHub are yours.
