# HardHub

*HardHub by OffGrid* — describe the hardware you want; HardHub's AI asks the
right questions, picks parts with you, designs and routes the circuit board in
KiCad, checks it, shows it in 3D, and hands you the files JLCPCB needs to build
and assemble it.

> The model proposes. It doesn't decide.

## Run it on your computer

You need Docker: [Docker Desktop](https://www.docker.com/products/docker-desktop/),
or [Colima](https://github.com/abiosoft/colima) on a Mac. Then:

```bash
./hardhub
```

The first run downloads KiCad and builds everything (a few minutes); later runs
start in seconds. Docker without the Compose add-on (a plain Colima install) is
fine: `./hardhub` then runs Compose from Docker's own image, installing nothing.
Your browser opens http://localhost:5173. The first time, create your account
with an email and a password: the first account is the owner's, and new
accounts close after it. Then open **Settings** and pick the AI:

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
| `./hardhub reset-password` | set a new password here; `--live` for the Cloudflare site (there is no email to reset it with) |

HardHub on your computer answers only to this computer. To open it from a phone
or another computer on your network, start it with `HARDHUB_BIND=0.0.0.0 ./hardhub`.
Make your account first, so nobody else on the network can take the owner's;
HardHub's chat then won't use your Claude Code.

The KiCad engine runs natively on Apple Silicon (arm64) and on Intel (amd64):
one recipe, built from the KiCad team's own Ubuntu packages, so nothing needs
Rosetta. Cloudflare gets the amd64 build of the same recipe.

## Put it on Cloudflare

You need a Cloudflare account on the Workers Paid plan (Containers need it)
and Docker. With Node.js 22+ and Docker's buildx add-on the deploy runs here;
without them (Colima, say) it runs in a container, installing nothing, and
prints a Cloudflare sign-in link to open. Then:

```bash
./hardhub deploy
```

It signs you in to Cloudflare, creates the database and file storage in the US
jurisdiction, and deploys one Worker that serves the app and the API, with the
KiCad engine as a Cloudflare Container (US placement). The Worker answers on
the custom domain in `apps/api/wrangler.jsonc` (OffGrid's is
`hardhub.offgridevices.com`; a fork puts its own, on a domain in the same
Cloudflare account). Cloudflare adds that hostname's DNS record and
certificate and changes nothing else on the domain. Run it again to ship an
update.

Sign-in is email and password, with no email service: open the site and
create your account; after that first account, new ones are closed. A lost
password is set again with `./hardhub reset-password --live`.

### Remove it all

Everything HardHub puts on Cloudflare is named `offgrid-hardhub*`, so it can
be found and deleted without touching anything else on the account:

| On Cloudflare | Name | Remove with |
|---|---|---|
| Worker (the app, the API, the Durable Objects with every board's history) and its custom domain `hardhub.offgridevices.com` | `offgrid-hardhub` | `npx wrangler delete --env production` in `apps/api`; then check Dashboard → offgridevices.com → DNS that the `hardhub` record is gone |
| Engine container and its images | `offgrid-hardhub-engine` | Dashboard → Workers & Pages → Containers, or `npx wrangler containers delete` |
| Database (accounts, board list, encrypted keys) | `offgrid-hardhub-db` | `npx wrangler d1 delete offgrid-hardhub-db` |
| File storage (Gerbers, renders, 3D models) | `offgrid-hardhub-files` (US jurisdiction) | empty it, then `npx wrangler r2 bucket delete offgrid-hardhub-files --jurisdiction us` |

On this computer, everything is named `hardhub`: the Docker volumes
`hardhub_*` (your local boards: `./hardhub reset` deletes them) and
`hardhub-dockercli`, `hardhub-deploy-*` (the deploy's tools; `docker volume rm`),
and the `.hardhub/` folder here (the Claude Code bridge's token, the
Cloudflare sign-in for deploys).

## What is inside

| Folder | What |
|---|---|
| `apps/web` | the web app: React, Vite, three.js; works from phone to desktop |
| `apps/api` | Cloudflare Worker, a Durable Object per project, D1, R2, the AI agent loop, and the MCP server with its OAuth sign-in |
| `packages/protocol` | the shared contract: the design document, events, REST, engine |
| `engine` | KiCad 10 + Freerouting in Docker (arm64 and amd64): design → placed, routed, checked board → fab files |
| `bridge` | the helper that runs your own Claude Code for HardHub's chat (local only) |
| `e2e` | end-to-end tests and the scripted stand-in for Claude |
| `docs/PLAN.md` | the plan of record and the decisions behind it |
| `docs/STATUS.md` | what is verified, how, and what is not yet |

Every iOS or Android app later talks to the same API as the web app.

## Licence

[AGPL-3.0-or-later](LICENSE). Boards you design with HardHub are yours.
