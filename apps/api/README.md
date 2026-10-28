# HardHub API

The Cloudflare Worker behind every HardHub client: accounts, projects, the
AI agent loop and the link to the engine. Contract: [`packages/protocol`](../../packages/protocol).

| Piece | Where |
|---|---|
| REST routes, auth, CORS | `src/http.ts` |
| Accounts, sessions, projects, encrypted API keys (D1) | `src/db.ts`, `migrations/` |
| One project's live state: design versions, event log, WebSockets, turns | `src/room/` (Durable Object `ProjectRoom`) |
| The agent loop and its tools | `src/agent/loop.ts`, `src/agent/tools.ts` |
| LLM providers (Anthropic, OpenAI-compatible) | `src/agent/llm/`; every preset in `presets.ts` |
| What the AI knows (system prompt) | `src/agent/skills/*.md` |
| The engine client (HTTP locally, Cloudflare Container in production) | `src/engine.ts` |

## Run it locally

```bash
pnpm install
pnpm --filter @hardhub/api dev        # http://localhost:8787
```

`scripts/dev.mjs` applies the D1 migrations and starts `wrangler dev` on
0.0.0.0 with local D1, R2 and Durable Objects kept in `.wrangler/state`
(`HH_STATE` moves it). Settings come from the environment:

| Variable | Default | |
|---|---|---|
| `ENGINE_URL` | `http://localhost:8080` | the engine service |
| `APP_URL` | `http://localhost:5173` | the web app, for the MCP consent page |
| `ALLOW_SIGNUP` | none | `1`: anyone may make an account (the end-to-end tests); otherwise only the first, the owner's |
| `KEY_ENCRYPTION_KEY` | generated once into the state folder | base64 of 32 bytes |
| `DEV_LLM_PROVIDER` / `DEV_LLM_MODEL` / `DEV_LLM_BASE_URL` | none | LLM settings new accounts start with |
| `DEV_LLM_KEY` | none | used when the person stored no key |

Sign-in is email and password everywhere (`/auth/signup`, `/auth/signin`),
with no email service; `scripts/reset-password.mjs` sets a lost one. All
`DEV_*` settings are ignored
unless `DEV=1` (the dev script sets it; production does not).

To try it with no API key, run the scripted fake Claude from the repository
root and point new accounts at it:

```bash
node e2e/fake-anthropic/server.mjs SCRIPT.json 8788 &
DEV_LLM_PROVIDER=anthropic DEV_LLM_BASE_URL=http://127.0.0.1:8788 DEV_LLM_KEY=fake pnpm --filter @hardhub/api dev
```

Or with a local Ollama (no key): `DEV_LLM_PROVIDER=ollama DEV_LLM_BASE_URL=http://localhost:11434/v1`.

### In Docker

`Dockerfile.dev` runs the same thing in a container (build from the repository
root). Mount a volume at `/data` to keep accounts and projects, and set
`ENGINE_URL=http://engine:8080` on the compose network.

```bash
docker build -f apps/api/Dockerfile.dev -t hardhub-api-dev .
docker run -p 8787:8787 -v hardhub-data:/data -e ENGINE_URL=http://host.docker.internal:8080 hardhub-api-dev
```

## Test

```bash
pnpm --filter @hardhub/api test        # vitest: routes, crypto, engine client, agent loop
pnpm --filter @hardhub/api typecheck
pnpm --filter @hardhub/api build:check # production bundle, dry run
```

The agent-loop tests run the real Anthropic and OpenAI SDKs against scripted
network replies, through both providers, and check that history is
append-only, every Claude request carries `inference_geo: "us"`, broken tool
calls come back as errors the model can fix, and a stopped turn closes every
open tool call.

## AI providers

Each person picks a provider and model in Settings (`PATCH /me/llm`) and
stores their own key (`PUT /me/keys/:provider`, AES-GCM encrypted, only the
last four characters ever shown). All presets keep inference in the US:

| Provider | How it stays in the US |
|---|---|
| `anthropic` (default, `claude-opus-5-5`) | `inference_geo: "us"` on every request |
| `openai` | `https://us.api.openai.com/v1`; the key's project must be a US data-residency project |
| `openrouter` | routing limited to `OPENROUTER_US_PROVIDERS`, no fallbacks, no data collection (review that list before launch) |
| `ollama` (`qwen3.5:0.8b`) | runs on your own machine |
| `custom` | any OpenAI-compatible URL you vouch for (https in production) |

## Deploy to Cloudflare

Needs a Cloudflare account on Workers Paid (Containers) and Docker running.

```bash
pnpm --filter @hardhub/api run deploy
```

`scripts/deploy.mjs` signs in, creates the D1 database and R2 bucket in the
US jurisdiction if they are missing (all named `offgrid-hardhub*`),
applies migrations, creates `KEY_ENCRYPTION_KEY`, and deploys the Worker,
both Durable Objects (created in the US jurisdiction by the code) and the
engine container (`constraints.jurisdiction = "us"`), on the custom domain in
`wrangler.jsonc`. It is safe to run again.

