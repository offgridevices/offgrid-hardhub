# HardHub — plan

*HardHub by OffGrid.* Describe the hardware you want; HardHub's AI asks the
right questions, picks parts with you, draws the circuit, lays out and routes
the board, checks everything, shows it in 3D, and hands you files JLCPCB or
PCBWay can build and assemble.

> The model proposes. It doesn't decide.
> Every recommendation comes with options, costs and a reason; the person picks.

This file is the plan of record. Decisions the owner made are marked **(owner)**.

---

## 1. Who it is for

Someone building a product or a tool for themselves that might become one.
They know what an ESP32 is; they do not want to learn ground planes, stackups
or routing. HardHub keeps the language plain and does the engineering, but
never hides a trade-off: cost, availability, size, layers.

## 2. Decisions so far

| Topic | Decision |
|---|---|
| Product name and brand | **HardHub by OffGrid** (owner). OffGrid design language v3.2.2: Pitch/Bone, one Ember accent per surface, square corners, no shadows, Instrument Sans / Newsreader / JetBrains Mono. |
| First build | **A simple board, fully real** (owner): chat → questions and part picks → circuit → real KiCad layout and routing on the server → checks → 3D → Gerber, BOM, CPL. |
| Benchmark board | **Print Hub, from one prompt** (owner). `offgridevices/offgrid-hardware/print-hub/v1` is the answer key. |
| Also in scope | **Firmware** (ESPHome / Arduino starter + pin-map check), **accounts and saved projects**, **open source** (owner). Enclosure later. |
| AI access | **User pastes their own API key** (owner). Claude first; OpenAI later. Max-plan users can use the API credit their plan includes. |
| Why not "log in with Claude/ChatGPT" | Anthropic does not allow third-party apps to use claude.ai subscription login. OpenAI's "Sign in with ChatGPT" is waitlist-only for hosted apps. Neither can be pinned to US servers. We apply to OpenAI's waitlist and revisit. |
| US-only AI | Every Claude request sends `inference_geo: "us"`. OpenAI (later) uses `us.api.openai.com`, which needs a US-residency project on the user's side. |
| License | **AGPL-3.0** (owner). Compatible with KiCad (GPL-3.0-or-later). Board designs users make are theirs. |
| Hosting | **Cloudflare in the end, Docker on a Mac first** (owner). |

## 3. Architecture

```
 phone / desktop browser            (later: iOS, Android — same API)
          │  HTTPS + WebSocket
          ▼
 apps/api  ─ Cloudflare Worker (Hono)
   ├─ auth, projects, API keys (encrypted)           D1 (us)
   ├─ ProjectRoom Durable Object (one per project)   DO (us)
   │    · the conversation and design state
   │    · the agent loop: Claude Messages API, tool use, inference_geo "us"
   │    · streams every event to every open client over WebSocket
   └─ files: designs, Gerbers, renders, GLB         R2 (us)
          │  HTTP (tools)
          ▼
 engine/  ─ Docker image: KiCad 10 + Freerouting + ngspice + Python
   · the `hardhub` library: design → board → route → check → fab files
   · stateless HTTP service; each job gets a design and returns outputs
   · Cloudflare Container in production (amd64, jurisdiction "us")
```

* **One API for every client.** The web app has no privileged path: the iOS
  and Android apps later talk to the same REST + WebSocket API. The wire
  format lives in `packages/protocol` (Zod schemas → JSON Schema / OpenAPI).
* **The agent loop runs in the Durable Object, not in the container.**
  The Claude Agent SDK needs a container per user and cannot set US-only
  inference for a user's own key; the plain Anthropic SDK can, per request.
  The container only does deterministic engineering work, so it can be
  stateless, cached and scaled independently.
* **The design is data, not code.** The AI edits one structured document,
  `design.json` (requirements, decisions, parts, components with pin-by-pin
  nets, board, placement, firmware pin map). The engine turns it into KiCad
  files. This keeps a hosted multi-tenant service from running AI-written
  code, makes every change reviewable as a diff, and gives the UI real data
  to draw (circuit view, BOM, cost tables) without parsing KiCad files.
* **Local = production shape.** `docker compose up` runs the engine;
  `wrangler dev` runs the Worker, Durable Objects, D1 and R2 locally;
  Vite serves the web app. On Cloudflare the same code runs with the engine as
  a Container behind the Durable Object.

### Repository layout

```
apps/web            React + Vite + TypeScript, brand tokens, three.js viewer
apps/api            Cloudflare Worker: Hono routes, ProjectRoom DO, agent loop
packages/protocol   shared types and schemas (design.json, events, REST)
engine/             Dockerfile, hardhub Python library, HTTP server, tests
apps/api/src/agent/skills/  what the AI knows: workflow, rules, lessons (from offgrid-hardware/docs)
docs/               this plan, decisions, how to run
```

## 4. The journey (stages the user sees)

Each stage ends with the person approving it. The AI can go back.

| # | Stage | What the AI does | What the person sees and decides |
|---|---|---|---|
| 1 | **Idea** | Interviews: what it does, where it lives, power, size, budget, quantity, how it talks (Wi-Fi, Home Assistant…). Writes the requirements list. | Short multiple-choice questions, recommended option first. A requirements card. |
| 2 | **Parts** | Proposes the architecture (blocks) and, for each key part, 2–3 candidates with live price, stock, JLCPCB basic/extended, lifecycle (active / not for new designs / end of life). | Comparison cards with a recommendation and why. Picks. |
| 3 | **Circuit** | Wires every pin from datasheets; supporting parts (decoupling, pull-ups, protection). Runs circuit checks (no single-pin nets, every pad accounted for, ESP32 strapping and ADC rules…). | Circuit view by block, BOM with cost, check results. |
| 4 | **Board** | Proposes size (with real-object comparison), connector edges, mounting holes, layer count. Layer table: 2 / 4 / 6 / 8 with price for 5 and 100 boards, what each buys (signal quality, size, heat). | Picks size and layers. |
| 5 | **Layout** | Places parts (power entry, antenna at the edge, connectors on edges), power copper first, ground planes, autoroutes the rest, cuts every corner to 45°, pours and stitches ground. | 2D board with layer toggles; progress while routing. |
| 6 | **Checks** | DRC with the fab's own limits (0 errors / 0 warnings / 0 unconnected), copper equals circuit pad for pad, BOM/CPL equal placed parts, 45° corners, current per track width, power budget, thermal estimate, firmware pin map. | A checklist: what was tested, how, result. Misses written the same way as passes. |
| 7 | **3D** | Exports the board with parts and silkscreen. | Smooth 3D on phone and desktop: orbit, explode, layers. |
| 8 | **Order** | Gerber zip, JLCPCB BOM + CPL, fab settings, firmware starter. | Download, JLCPCB/PCBWay links with the settings to pick. |

A note on "45° turns": they are the house rule and HardHub enforces them, but
at the speeds these boards run the things that actually prevent noise and
radiated fields are an unbroken ground plane under signals, short return
paths, small current loops and controlled impedance where needed. The checks
cover those too, and say which rule each check comes from.

## 5. What the AI can do (tools)

The agent never touches files or a shell directly. It calls tools:

| Tool | Does |
|---|---|
| `ask_user` | One or more multiple-choice questions, recommended option first, free text allowed. Ends the turn. |
| `update_design` | JSON-patch the design (requirements, parts, components, board, placement…), validated against the schema. |
| `search_parts` / `get_part` | JLCPCB/LCSC catalog: price ladder, stock, basic/extended, package, datasheet link. |
| `propose_options` | A comparison card (parts, layer counts, sizes) with a recommendation. |
| `check_circuit` | Circuit gates. |
| `build_board` | Engine job: place → route → miter → pour → DRC → fab files. Streams progress. |
| `render` | PNG of the board (layers, zoom) for the AI to look at its own layout. |
| `quote` | Board + assembly price estimate by layer count and quantity, dated, with its source. |
| `set_stage` | Moves the journey forward when the person approves. |

Skills (system knowledge) come from `offgrid-hardware/docs`: the workflow and
"done means", lessons (power copper, congestion sets layer count, pre-route
obvious paths, fab limits as DRC rules), and the brand-on-board rules.

## 6. Performance targets

* First paint under 1 s on a mid phone; app shell under 150 KB gzipped;
  three.js and the viewers load only when opened.
* 3D: GLB from KiCad, compressed (meshopt), instanced parts, layers as
  separate meshes, demand-driven rendering (no frame loop when idle),
  adaptive resolution on phones. Target 60 fps for an 8-layer, 500-part board
  on a recent phone.
* 2D: per-layer SVG from KiCad, drawn on a canvas tile cache for large boards.

## 7. Phases

| Phase | Contents |
|---|---|
| **1 (now)** | Everything in §4 for 2–4 layer boards on JLCPCB; Claude with the user's key; accounts; web only; runs locally in Docker; Print Hub benchmark. |
| 2 | Deploy to Cloudflare (Containers, D1, R2, DO, all `us`); OpenAI provider; PCBWay; 6–8 layers; ngspice and thermal simulations surfaced in the UI; KiCad schematic file export. |
| 3 | Enclosure (build123d, 3D-printable), product renders, iOS/Android apps on the same API, ordering APIs (JLCPCB/PCBWay partner programs). |

## 8. Things the owner needs to do (none block phase 1 code)

* Anthropic API key for testing (Console; Max plans include monthly API credit).
* Later, for live part data in production: nothing required (JLCPCB/LCSC public catalog), optional DigiKey API key for lifecycle status.
* Later: Cloudflare account on Workers Paid (Containers need it).
* Optional: apply to OpenAI's "Sign in with ChatGPT" waitlist.
