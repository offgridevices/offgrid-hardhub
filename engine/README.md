# HardHub engine

Turns a design document (`packages/protocol/src/design.ts`) into a routed,
checked circuit board and the files a fab builds it from. KiCad 10 does the
board work, Freerouting the routing; the `hardhub` Python package drives
both. It runs as an HTTP service on port 8080 inside one Docker image, the
same on a Mac and as a Cloudflare Container.

```
validate -> footprints -> place -> route -> miter -> pour -> drc -> verify -> fab -> render
```

| Step | What happens |
|---|---|
| validate | board size and layer count, references, parts |
| footprints | every footprint found or fetched; circuit checks (pins on pads, single-pin nets, LCSC numbers, lifecycle, stock, ESP32 strapping / ADC2 / firmware pin map) |
| place | outline, stackup, JLCPCB limits as DRC rules, net classes from each net's current (IPC-2221), planes, keepouts; parts the design leaves unplaced are placed automatically and returned; a via beside every SMD pad on a plane or ground net |
| route | Freerouting 2.5 headless (1.9 under xvfb if 2.5 fails), plane and ground nets left to the planes and pours; tracks back to the fab's minimum width, dangling vias and stubs removed |
| miter | every track corner cut to 45 degrees or less |
| pour | ground on both outer layers, stitching vias every 3 mm; whatever the pours leave unjoined is routed again with the pours in place |
| drc | KiCad DRC: errors, warnings and unconnected items must all be 0 |
| verify | copper equals the design pad for pad; corners; every part on the board |
| fab | Gerber zip, JLCPCB BOM + CPL, PCBWay BOM, netlist CSV, IPC-D-356, the KiCad files |
| render | per-layer SVG, a meshopt-compressed GLB; PNG and STEP when asked |

The code generalises offgrid-hardware's Print Hub v1 library (`pcb.py`,
`route.py`, `miter.py`, `stitch.py`, `fab.py`, `footprints.py`, the power
fanout); the source of each part says where it came from.

## Run it on a Mac

Docker Desktop, then from the repository root:

```bash
docker compose -f engine/docker-compose.yml up --build
curl localhost:8080/health
```

KiCad publishes its Docker images for `linux/amd64` only, so on Apple
Silicon the engine runs under Rosetta (Docker Desktop → Settings → General →
"Use Rosetta for x86_64/amd64 emulation"). Expect builds to take longer
than on an x86 server; time one before judging the router.

The first build of the image downloads about 1.5 GB (KiCad, its 3D models,
Freerouting, Node for gltf-transform).

## HTTP API

The contract is `packages/protocol/src/engine.ts`.

| Call | Does |
|---|---|
| `GET /health` | 200 when `kicad-cli` and a Freerouting actually run, else 503; also builds running |
| `POST /parts/search {query, limit}` | JLCPCB catalogue search: price ladder, stock, basic / preferred / extended |
| `POST /parts/get {lcsc: [...]}` | LCSC detail for part numbers |
| `POST /check {design}` | circuit checks |
| `POST /quote {design, qty: [5, 100]}` | estimated price for 2, 4, 6, 8 layers (and the design's own), dated basis |
| `POST /build {design, job, stop_after?, outputs?}` | NDJSON stream: one line per step, then `{done, ok, checks, artifacts, stats, placement}` |
| `GET /jobs/:job/files/:name` | an output file |
| `DELETE /jobs/:job` | forget a job's files |

`outputs` picks the slow extras: `svg` and `glb` by default, `png` and
`step` only when asked. `stats` carries every step's time (`t_route`, ...)
and counts (vias, DRC, GLB size before and after compression).

| Environment | Default | |
|---|---|---|
| `PORT` | 8080 | |
| `HARDHUB_JOBS` | `/var/lib/hardhub/jobs` | job outputs; mount a volume |
| `HARDHUB_FP_CACHE` | `/var/cache/hardhub` | fetched footprints and catalogue answers |
| `HARDHUB_MAX_BUILDS` | 1 | builds at once; more get 429 |
| `HARDHUB_BUILD_TIMEOUT` | 1800 | seconds for a whole build |
| `FREEROUTING_TIMEOUT` | 900 | seconds for one Freerouting run |
| `HARDHUB_PASSES` / `HARDHUB_ROUNDS` | 20 / 3 | router passes per run, runs per build |
| `HARDHUB_FR_OPT_PASSES` | 2 | Freerouting optimiser passes |
| `HARDHUB_PARTS_TTL` | 21600 | seconds a catalogue answer is reused |

### Performance

The server imports KiCad's `pcbnew` once, in a multiprocessing forkserver;
every build and check is forked from that warm process, so none pays the
import, each gets a clean KiCad (pcbnew keeps global state between boards),
and a build past its time is killed together with Freerouting. Freerouting
runs with one thread fewer than the machine has. Footprints fetched from
EasyEDA and catalogue answers are cached on disk.

## Footprints

| Id | Comes from |
|---|---|
| `hh:C2913198` | JLCPCB/EasyEDA's own footprint for LCSC part C2913198, fetched once (easyeda2kicad) and cleaned: courtyard rebuilt, silkscreen dropped, plain custom pads made rectangles. The fab's own entry means its pad numbers and 0-degree orientation match the assembly line's, so the CPL needs no rotation table. |
| `hh:MOUNT_M3`, `hh:PAD_TP` | generated: M3 hole with a screw-head courtyard, plated test pad |
| `Library:Name` | KiCad's standard libraries, or `HARDHUB_FP_PATHS="lib=/path/lib.pretty;..."` |

Placing a footprint also: moves its silkscreen to the fab layer (the
assembly drawing carries outlines; silk over pads is a fab nuisance),
removes thermal vias finer than the fab's standard drill from inside its
pads (ESP32 modules carry 0.2 mm ones), and cuts its pads out of its own
keepouts (a sensor's "no copper under the part" drawn over its pad row
would otherwise forbid the tracks to its pads).

## Tests

```bash
docker compose -f engine/docker-compose.yml run --rm engine python3 -m pytest -q tests
# Print Hub too (mount the offgrid-hardware clone):
docker compose -f engine/docker-compose.yml run --rm -v /path/to/offgrid-hardware:/w:ro \
  -e OFFGRID_HARDWARE=/w engine python3 -m pytest -q -s tests/test_build.py -k print_hub
```

* `test_quote_parts.py` — quotes, IPC-2221 widths, catalogue mapping and
  cache. The catalogue answers in `tests/fixtures/catalog/` are written by
  hand in the shape of the live services' answers (the session that wrote
  them could not reach jlcpcb.com or lcsc.com); the live endpoints are not
  exercised by the tests.
* `test_build.py` — circuit checks, including that they catch three planted
  mistakes; the 2-layer ESP32-C3 fixture built end to end and required fully
  green; Print Hub converted from offgrid-hardware and built (opt-in).
* `test_server.py` — the HTTP service: health, quote, check, a streamed
  build, file serving, the build limit.

## Dependencies

Exact stable releases, each published at least two weeks before it was
pinned; downloads are checked against their published sha256.

| What | Version | Why this one |
|---|---|---|
| KiCad (`kicad/kicad` image) | 10.0.6, by digest | newest stable with an image |
| Freerouting | 2.5.0 (primary), 1.9.0 (fallback) | 2.5: headless and multi-threaded; 1.9: what offgrid-hardware's boards were routed with |
| OpenJDK | 21 (Debian) | runs Freerouting 1.9 |
| Node.js | 22.23.3 LTS | runs gltf-transform |
| @gltf-transform/cli | 4.5.1, lockfile `tools/gltf/package-lock.json` | meshopt-compresses the GLB (Print Hub's 3D file shrinks about 10x) |
| shapely | 2.2.0 | geometry |
| numpy | 2.5.4 | shapely's arrays |
| easyeda2kicad | 1.0.1 (AGPL-3.0) | the fab's footprints for LCSC parts |
| pytest (tests only) | 9.1.1 | |

No web framework: the service is the standard library's
`ThreadingHTTPServer` and `multiprocessing`, so there is no 0.x dependency.

## Limits

* Auto-placement is a first draft: connectors to the edges, each block
  round its biggest part, passives beside the pins they serve. It knows
  nothing of heat, antennas or where the case opens; the design (the AI, a
  person) should place and lock what matters — connectors, modules with
  antennas, power parts — and let the engine place the rest.
* Planes are whole layers. Print Hub's split plane (5 V under the ports,
  ground under the input stage) and its hand-drawn power copper do not
  carry over; power nets get width from their current instead.
* No simulations yet (ngspice, thermal): offgrid-hardware runs them per
  board; the engine reports them as not run rather than passed.
