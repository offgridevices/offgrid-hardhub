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
| `apps/api` | Cloudflare Worker, a Durable Object per project, D1, R2, and the AI agent loop |
| `packages/protocol` | the shared contract: the design document, events, REST, engine |
| `engine` | KiCad 10 + Freerouting in Docker: design → placed, routed, checked board → fab files |
| `e2e` | end-to-end tests and the scripted stand-in for Claude |
| `docs/PLAN.md` | the plan of record and the decisions behind it |
| `docs/STATUS.md` | what is verified, how, and what is not yet |

Every iOS or Android app later talks to the same API as the web app.

## Licence

[AGPL-3.0-or-later](LICENSE). Boards you design with HardHub are yours.
