# HardHub

*HardHub by OffGrid* — describe the hardware you want; HardHub's AI asks the
right questions, picks parts with you, designs and routes the circuit board,
checks it, shows it in 3D, and hands you files a fab can build and assemble.

> The model proposes. It doesn't decide.

Status: phase 1 in progress. The plan of record is [`docs/PLAN.md`](docs/PLAN.md).

| Folder | What |
|---|---|
| `apps/web` | the web app (React, Vite) |
| `apps/api` | the API: Cloudflare Worker, Durable Objects, the AI agent loop |
| `packages/protocol` | shared types: the design document, events, REST |
| `engine` | KiCad 10 + Freerouting in Docker: design → routed board → fab files |

## Licence

[AGPL-3.0-or-later](LICENSE). Boards you design with HardHub are yours.
