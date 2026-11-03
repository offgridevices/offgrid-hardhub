// The demo's board tests on the room climate sensor: every check of the
// engine's catalogue with a result written the way the engine writes them,
// and the report (stackup, heat maps, power, part stress). The heat is a
// smooth made-up field around the warm parts, shifted by the outside
// temperature, so a hotter range really does fail more. Demo mode only.
import type { CheckMeasure, CheckPlan, CheckResult, CheckWhere, TestReport } from "@hardhub/protocol";
import { CATALOG } from "./catalog";
import { sensorDesign, SENSOR_BOARD } from "./sensor";
import { counts, num, verdict, type Range } from "../lib/tests";
import { encodeU8 } from "../lib/heat";

const W = SENSOR_BOARD.width;
const H = SENSOR_BOARD.height;
const pl = (ref: string) => sensorDesign.placement[ref]!;
const at = (ref: string, note?: string, extra: Partial<CheckWhere> = {}): CheckWhere => ({ x: pl(ref).x, y: pl(ref).y, refs: [ref], ...(note ? { note } : {}), ...extra });
const m = (label: string, value: number, unit: string, limit?: number, op: ">=" | "<=" = ">="): CheckMeasure =>
  limit === undefined ? { label, value, unit } : { label, value, unit, limit, op };

/* ---------- heat: a smooth field around the warm parts ---------- */

const GRID = { x0: -W / 2, y0: -H / 2, dx: 0.5, dy: 0.5, nx: W * 2, ny: H * 2 };
// [x, y, peak °C, spread mm]: the regulator is small and sharp, the module wide
const BUMPS: [number, number, number, number][] = [
  [pl("U2").x, pl("U2").y, 14, 3.5],
  [pl("U2").x, pl("U2").y, 10, 10],
  [pl("U1").x, pl("U1").y + 3, 12, 6],
  [pl("U1").x, pl("U1").y + 3, 5, 14],
  [pl("R3").x, pl("R3").y, 1.5, 2],
];
/** how far above the outside temperature the board is at (x, y); a hotter day cools a little better */
function rise(x: number, y: number, ambient: number) {
  let r = 2.5;
  for (const [bx, by, a, s] of BUMPS) r += a * Math.exp(-((x - bx) ** 2 + (y - by) ** 2) / (2 * s * s));
  // the edges lose heat from their sides too
  const edge = Math.min(x + W / 2, W / 2 - x, y + H / 2, H / 2 - y);
  r *= 0.9 + 0.1 * Math.min(1, edge / 4);
  return r * (1 - 0.0015 * (ambient - 25));
}
function inside(x: number, y: number) {
  const r = 2;
  const dx = Math.max(0, Math.abs(x) - (W / 2 - r));
  const dy = Math.max(0, Math.abs(y) - (H / 2 - r));
  if (dx * dx + dy * dy > r * r) return false;
  return !(sensorDesign.board?.holes ?? []).some((h) => (x - h.x) ** 2 + (y - h.y) ** 2 < (h.d / 2) ** 2);
}

interface HeatPart {
  ref: string;
  power: number;
  half: [number, number];
  theta?: number;
  tmax?: number;
  tmin?: number;
  assumed?: boolean;
  how?: string;
}
const HEAT_PARTS: HeatPart[] = [
  { ref: "U2", power: 0.31, half: [1.45, 0.8], theta: 95, tmax: 85, tmin: -40, how: "Regulator: (5 V − 3.3 V) × 0.18 A" },
  { ref: "U1", power: 0.6, half: [6.6, 8.3], tmax: 105, tmin: -40, how: "Module at full Wi-Fi: 3.3 V × 0.18 A" },
  { ref: "C2", power: 0, half: [0.8, 0.4], tmax: 85, tmin: -55 },
  { ref: "C1", power: 0, half: [0.8, 0.4], tmax: 85, tmin: -55 },
  { ref: "C4", power: 0, half: [0.8, 0.4], tmax: 85, tmin: -55 },
  { ref: "J1", power: 0, half: [3.65, 4.45], tmax: 80, tmin: -30 },
  { ref: "D1", power: 0.0057, half: [0.8, 0.4], tmax: 85, tmin: -40, how: "LED: 1.9 V × 3 mA" },
  { ref: "R3", power: 0.0036, half: [0.5, 0.25], tmax: 155, tmin: -55, assumed: true, how: "1.1 V across 1 kΩ" },
  { ref: "U3", power: 0.0004, half: [0.75, 0.75], tmax: 125, tmin: -40 },
];
function partBoard(p: HeatPart, ambient: number) {
  const { x, y } = pl(p.ref);
  let s = 0;
  let n = 0;
  for (let i = -2; i <= 2; i++)
    for (let j = -2; j <= 2; j++) {
      s += rise(x + (i / 2) * p.half[0], y + (j / 2) * p.half[1], ambient);
      n++;
    }
  return ambient + s / n;
}
const round1 = (v: number) => Math.round(v * 10) / 10;

function thermal(points: number[]): NonNullable<TestReport["thermal"]> {
  const { nx, ny, x0, y0, dx, dy } = GRID;
  const mask = new Uint8Array(nx * ny);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) mask[j * nx + i] = inside(x0 + (i + 0.5) * dx, y0 + (j + 0.5) * dy) ? 1 : 0;
  const maps = points.map((a) => {
    const t = new Float32Array(nx * ny);
    let lo = Infinity;
    let hi = -Infinity;
    let hot: [number, number] = [0, 0];
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        const k = j * nx + i;
        if (!mask[k]) continue;
        const x = x0 + (i + 0.5) * dx;
        const y = y0 + (j + 0.5) * dy;
        const v = a + rise(x, y, a);
        t[k] = v;
        if (v < lo) lo = v;
        if (v > hi) (hi = v), (hot = [x, y]);
      }
    const u = new Uint8Array(nx * ny);
    for (let k = 0; k < u.length; k++) u[k] = mask[k] ? Math.round(((t[k]! - lo) / (hi - lo)) * 255) : 0;
    return { ambient: a, min: round1(lo), max: round1(hi), max_at: hot, u8: encodeU8(u) };
  });
  const parts = HEAT_PARTS.map((p) => ({
    ref: p.ref,
    power: p.power,
    temps: points.map((a) => {
      const board = round1(partBoard(p, a));
      return p.theta ? { ambient: a, board, junction: round1(board + p.power * p.theta) } : { ambient: a, board };
    }),
    ...(p.tmax !== undefined ? { temp_max: p.tmax } : {}),
    ...(p.tmin !== undefined ? { temp_min: p.tmin } : {}),
    ...(p.assumed ? { assumed: true } : {}),
    ...(p.how ? { how: p.how } : {}),
  }));
  return { grid: GRID, mask: encodeU8(mask), maps, parts };
}

/* ---------- power: supply impedance and a load step ---------- */

function pdn() {
  const f: number[] = [];
  const z: number[] = [];
  // regulator: low resistance, rising with frequency as its loop runs out of gain;
  // capacitors with their ESR and ESL, 10 µF derated to 6 µF at 3.3 V
  const caps = [
    { c: 6e-6, esr: 0.008, esl: 0.6e-9 },
    { c: 6e-6, esr: 0.008, esl: 0.6e-9 },
    { c: 100e-9, esr: 0.03, esl: 0.4e-9 },
    { c: 100e-9, esr: 0.03, esl: 0.4e-9 },
  ];
  for (let k = 0; k <= 80; k++) {
    const hz = 10 ** (3 + (5 * k) / 80);
    const w = 2 * Math.PI * hz;
    // admittances add: 1/Z = Σ 1/Zi (complex: [re, im])
    let yr = 0;
    let yi = 0;
    const addZ = (r: number, x: number) => {
      const d = r * r + x * x;
      yr += r / d;
      yi += -x / d;
    };
    addZ(0.04, w * 0.05e-6); // regulator output
    for (const c of caps) addZ(c.esr, w * (c.esl + 0.8e-9) - 1 / (w * c.c)); // + 0.8 nH of track and via to each
    const d = yr * yr + yi * yi;
    f.push(Number(hz.toPrecision(4)));
    z.push(Number((Math.hypot(yr / d, -yi / d)).toPrecision(4)));
  }
  return { net: "+3V3", target_ohm: 0.33, f, z, caps: ["C2", "C4", "C3", "C5"] };
}

function step() {
  const t: number[] = [];
  const v: number[] = [];
  for (let k = 0; k <= 200; k++) {
    const us = k * 0.5;
    const s = us - 10;
    const dip = s < 0 ? 0 : 0.072 * Math.exp(-s / 9) * Math.cos((2 * Math.PI * s) / 14 - 0.35) + 0.006 * (1 - Math.exp(-s / 3));
    t.push(us);
    v.push(Number((3.3 - (s < 0 ? 0 : dip)).toFixed(4)));
  }
  return { net: "+3V3", t_us: t, v, min_v: Math.min(...v), nominal: 3.3, step_a: [0.018, 0.18] };
}

/* ---------- every check ---------- */

type Result = Pick<CheckResult, "status"> & Partial<Pick<CheckResult, "detail" | "measured" | "where" | "fix" | "name">>;

export function sensorChecks(r: Range): CheckResult[] {
  const hot = r.max;
  const cold = r.min;
  const heat = HEAT_PARTS.filter((p) => p.tmax !== undefined).map((p) => ({ p, t: round1(partBoard(p, hot)) }));
  const worstHot = heat.reduce((a, b) => (b.p.tmax! - b.t < a.p.tmax! - a.t ? b : a));
  const over = heat.filter((h) => h.t > h.p.tmax!);
  const close = heat.filter((h) => h.t <= h.p.tmax! && h.t > h.p.tmax! - 5);
  const u2 = HEAT_PARTS[0]!;
  const tj = round1(partBoard(u2, hot) + u2.power * u2.theta!);
  const boardMax = round1(hot + rise(pl("U2").x, pl("U2").y, hot));
  const coldOut = HEAT_PARTS.filter((p) => p.tmin !== undefined && cold < p.tmin);
  const step1 = step();
  const z = pdn();
  const zMax = Math.max(...z.z);

  const res: Record<string, Result> = {
    // connections
    "has-circuit": { status: "pass", detail: "19 parts on 14 nets." },
    "parts-exist": { status: "pass", detail: "Every component points at one of the 13 parts in the list." },
    "single-pin-nets": { status: "pass", detail: "Every net joins at least two pins." },
    "pins-pads": { status: "pass", detail: "All 74 pins land on a pad; no pad is left out." },
    routed: { status: "pass", measured: m("connections with no copper", 0, "count", 0, "<="), detail: "KiCad: 0 unconnected items." },
    "nets-match": { status: "pass", detail: "74 of 74 pads carry the net the design gives them." },
    shorts: { status: "pass", measured: m("shorts", 0, "count", 0, "<="), detail: "1,218 pairs of copper shapes tested; none overlap." },
    dangling: { status: "pass", measured: m("loose ends", 0, "count", 0, "<="), detail: "Every track end and via joins something." },
    "isolated-copper": { status: "pass", detail: "No zone islands after the pour." },
    "parts-placed": { status: "pass", detail: "19 of 19 parts are on the board." },
    fanout: { status: "pass", detail: "Each of the 9 ground pads has its own via to the bottom ground." },
    // copper
    "track-min": { status: "pass", measured: m("narrowest track", 0.2, "mm", 0.127), where: [at("U1", "the I2C tracks at the module", { layer: "F.Cu", net: "I2C_SDA" })] },
    "clearance-min": { status: "pass", measured: m("narrowest gap", 0.2, "mm", 0.127), where: [{ x: 6.2, y: -4.1, layer: "F.Cu", net: "+3V3", note: "+3V3 beside I2C_SCL" }] },
    "edge-clearance": { status: "pass", measured: m("closest copper to the edge", 0.42, "mm", 0.3), where: [{ x: -24.6, y: -0.8, layer: "B.Cu", net: "GND", note: "the ground pour by the USB socket" }] },
    "corners-45": { status: "pass", measured: m("right-angle corners", 0, "count", 0, "<="), detail: "41 corners, all at 45°." },
    "acid-traps": { status: "pass", measured: m("tightest angle where tracks meet", 135, "°", 90) },
    "current-width": { status: "pass", measured: m("VBUS track for 0.4 A", 0.5, "mm", 0.25), detail: "VBUS 0.5 mm for 0.4 A (IPC-2221 asks 0.25 mm); +3V3 0.4 mm for 0.35 A (asks 0.2 mm)." },
    "net-width": { status: "pass", detail: "Every net is at the width the design gives it." },
    "track-heating": { status: "pass", measured: m(`busiest power track at ${num(hot)} °C outside`, round1(hot + 4.2), "°C", 105, "<="), detail: "VBUS between J1 and U2 carries 0.2 A and runs 4.2 °C above the board around it.", where: [{ x: -16.5, y: -2, layer: "F.Cu", net: "VBUS" }] },
    "copper-balance": {
      status: "warn",
      measured: m("difference in copper between the layers", 52, "%", 40, "<="),
      detail: "Top 36 % copper, bottom 88 % (one ground pour).",
      fix: "Pour ground on the top layer too, in the free space around the parts (HardHub can add it on the next build). The board stays flat when it is soldered.",
    },
    "thermal-relief": { status: "pass", detail: "Every pad in the ground pour has 4 spokes, 0.3 mm wide." },
    // holes
    "via-size": { status: "pass", measured: m("smallest via", 0.6, "mm", 0.45) },
    "drill-min": { status: "pass", measured: m("smallest hole", 0.3, "mm", 0.3) },
    "annular-ring": { status: "pass", measured: m("thinnest ring", 0.15, "mm", 0.13), where: [{ x: 3.9, y: -2.6, net: "GND", note: "vias 0.6 mm, holes 0.3 mm" }] },
    "hole-to-hole": { status: "pass", measured: m("closest holes, edge to edge", 0.55, "mm", 0.25), where: [{ x: 1.2, y: 6.4, net: "GND" }] },
    "hole-clearance": { status: "pass", measured: m("closest hole to other copper", 0.33, "mm", 0.2) },
    "aspect-ratio": { status: "pass", measured: m("board thickness ÷ smallest hole", 5.3, ":1", 10, "<="), detail: "1.6 mm board, 0.3 mm holes." },
    "via-in-pad": { status: "pass", measured: m("vias inside pads", 0, "count", 0, "<=") },
    "via-current": { status: "pass", measured: m("busiest via", 0.1, "A", 1.0, "<="), detail: "Two vias carry +3V3 to the sensor side; 0.1 A at most through one." },
    "mounting-holes": { status: "pass", measured: m("free space around the screw", 1.9, "mm", 1.0), detail: "M3 holes, top left and bottom right." },
    // silkscreen
    silkscreen: { status: "pass", detail: "All 20 labels fit: 19 part names and the board's name." },
    "silk-width": { status: "pass", measured: m("thinnest printed line", 0.15, "mm", 0.15) },
    "silk-height": { status: "pass", measured: m("smallest text", 1.0, "mm", 0.8) },
    "silk-on-pads": { status: "pass", measured: m("printing on pads", 0, "count", 0, "<=") },
    "silk-off-board": { status: "pass" },
    "polarity-marks": { status: "pass", detail: "D1, U1, U2 and U3 have pin-1 or cathode marks printed." },
    // mask
    "mask-web": { status: "pass", measured: m("narrowest mask strip", 0.11, "mm", 0.1), where: [at("U1", "between the module's pins")], detail: "Close to the limit at the module's pins, but within it." },
    // placement
    courtyard: { status: "pass", measured: m("overlapping parts", 0, "count", 0, "<=") },
    "part-edge": { status: "pass", measured: m("closest part to the edge (not connectors)", 0.6, "mm", 0.3), where: [at("U1", "the antenna end, as it should be")] },
    "connectors-edge": { status: "pass", detail: "J1 overhangs the left edge by 0.4 mm, so a cable plugs straight in." },
    "decoupling-near": {
      status: "fail",
      measured: m("C3 to U1's power pin", 7.4, "mm", 3, "<="),
      detail: "C3 (100 nF) is 7.4 mm from U1 pin 3 (3V3), with a via and a 9 mm track between them. C4 (10 µF) is close enough.",
      fix: "Move C3 next to U1's 3V3 pin (pin 3, on the module's left side), within 3 mm, and route the pin to C3 first, then C3 to ground through its own via.",
      where: [at("C3", "the capacitor"), { x: 6.4, y: -12.4, refs: ["U1"], net: "+3V3", note: "U1 pin 3, where it should sit" }],
    },
    "crystal-near": { status: "na", detail: "No crystal on the board: the module has its own inside." },
    "antenna-keepout": { status: "pass", detail: "No copper under the antenna on either layer; it sits at the top edge, facing out." },
    "two-sided": { status: "pass", detail: "All 19 assembled parts are on the top." },
    // power
    "power-current": { status: "pass", detail: "VBUS 0.4 A, +3V3 0.35 A." },
    "power-budget": { status: "pass", measured: m("U2's load", 0.18, "A", 0.6, "<="), detail: "U2 gives +3V3 0.18 A at full Wi-Fi of its 0.6 A; J1 gives 0.2 A of the 0.5 A any USB port offers." },
    "regulator-headroom": { status: "pass", measured: m("U2 input minus output", 1.7, "V", 0.25), detail: "5 V in, 3.3 V out; it needs 0.25 V at 0.18 A." },
    "regulator-input": { status: "pass", measured: m("highest input to U2", 5.25, "V", 6.5, "<="), detail: "USB allows up to 5.25 V." },
    "voltage-drop": { status: "pass", measured: m("worst drop on +3V3", 17.8, "mV", 99, "<="), detail: `+3V3: 17.8 mV (0.54 %) to U1 at ${num(hot)} °C. VBUS: 6.1 mV to U2.`, where: [at("U1", "the furthest load on +3V3", { net: "+3V3" })] },
    decoupling: { status: "pass", detail: "U1: C3 and C4. U2: C1 and C2. U3: C5." },
    "bulk-caps": { status: "pass", detail: "U2 has 10 µF in (C1) and 10 µF out (C2), as its datasheet asks." },
    pdn: { status: zMax <= z.target_ohm ? "pass" : "warn", measured: m("highest impedance of +3V3, 1 kHz to 100 MHz", Number(zMax.toFixed(3)), "Ω", z.target_ohm, "<=") },
    "load-step": { status: "pass", measured: m("lowest +3V3 when the load jumps 18 to 180 mA", Number(step1.min_v.toFixed(3)), "V", 3.135), detail: "Dips 75 mV for 12 µs, settles in 40 µs." },
    "input-protection": {
      status: "warn",
      detail: "VBUS goes from J1 to U2 with nothing in between.",
      fix: "Add a 0.5 A polyfuse or a 5 V TVS diode (SMF5.0A, basic part) right after J1. A shorted cable or a faulty charger then cannot reach the board.",
      where: [at("J1", "the power input", { net: "VBUS" })],
    },
    "usb-c-cc": { status: "pass", detail: "R1 and R2, 5.1 kΩ, from CC1 and CC2 to ground." },
    // heat
    "heat-parts-hot": {
      status: over.length ? "fail" : close.length ? "warn" : "pass",
      measured: m(`${worstHot.p.ref}, closest to its rating`, worstHot.t, "°C", worstHot.p.tmax!, "<="),
      detail: over.length
        ? `At ${num(hot)} °C outside: ${over.map((h) => `${h.p.ref} reaches ${num(h.t)} °C of its ${num(h.p.tmax!)} °C`).join("; ")}.`
        : `At ${num(hot)} °C outside every part stays inside its rating; ${worstHot.p.ref} comes closest at ${num(worstHot.t)} °C of ${num(worstHot.p.tmax!)} °C.`,
      ...(over.length || close.length
        ? { fix: "Spread the heat: give U2 a larger copper pad with vias to the bottom ground, or swap it for a small buck regulator, which wastes far less. A box with vents helps too." }
        : {}),
      where: (over.length ? over : [worstHot]).map((h) => at(h.p.ref, `${num(h.t)} °C`)),
    },
    "heat-junction": {
      status: tj > 125 ? "fail" : tj > 105 ? "warn" : "pass",
      measured: m(`inside U2 at ${num(hot)} °C outside`, tj, "°C", 125, "<="),
      detail: `U2 turns 0.31 W into heat; its silicon sits ${num(round1(u2.power * u2.theta!))} °C above the board under it (95 °C/W).`,
      ...(tj > 105 ? { fix: "U2 in its small SOT-23-5 case runs close to its limit. Use the same regulator in SOT-89 (AP2112R5, C460339), which sheds heat into the board three times better, or a buck converter." } : {}),
      where: [at("U2", `${num(tj)} °C inside`)],
    },
    "heat-board": { status: boardMax > 105 ? "fail" : "pass", measured: m("hottest spot of the board", boardMax, "°C", 105, "<="), where: [at("U2", "under the regulator")] },
    "heat-parts-cold": {
      status: coldOut.length ? "fail" : "pass",
      measured: m("coldest outside temperature", cold, "°C", Math.max(...HEAT_PARTS.map((p) => p.tmin ?? -60)), ">="),
      detail: coldOut.length ? `${coldOut.map((p) => `${p.ref} is rated down to ${num(p.tmin!)} °C`).join("; ")}.` : `Every part is rated for ${num(cold)} °C; the least hardy, J1, works down to −30 °C.`,
      ...(coldOut.length ? { fix: "Pick an industrial-grade USB-C socket rated to −40 °C (for example TYPE-C-31-M-17), or keep the board indoors." } : {}),
      where: coldOut.map((p) => at(p.ref)),
    },
    // part ratings
    "stress-cap-voltage": { status: "pass", measured: m("highest share of a capacitor's rated voltage", 53, "%", 80, "<="), detail: "C1: 5.25 V on a 10 V capacitor." },
    "stress-cap-dcbias": {
      status: "warn",
      measured: m("C1 keeps of its 10 µF at 5 V", 46, "%", 50),
      detail: `C1 (10 µF, 0603, X5R) is about 4.6 µF at 5 V and ${num(hot)} °C. C2 and C4 keep 60 % at 3.3 V.`,
      fix: "Use a 10 µF capacitor in a larger 0805 case (CL21A106KAYNNNE, C15850, basic part): it keeps about 70 % at 5 V.",
      where: [at("C1")],
    },
    "stress-resistor-power": { status: "pass", measured: m("highest resistor power", 3.6, "mW", 62.5, "<="), detail: "R3 (the LED's resistor): 3.6 mW of 62.5 mW.", where: [at("R3")] },
    "stress-led-current": { status: "skip", detail: "D1's datasheet entry has no current rating, so there is nothing to compare its 3 mA with." },
    "stress-ic-voltage": { status: "pass", measured: m("U1's supply", 3.3, "V", 3.6, "<="), detail: "Every chip runs at 3.3 V; the module's maximum is 3.6 V." },
    "stress-connector-current": { status: "pass", measured: m("current through J1", 0.2, "A", 5, "<=") },
    "stress-tolerance": { status: "na", detail: "No voltage dividers on this board." },
    // signals
    "return-path": {
      status: "fail",
      measured: m("longest stretch with no ground under it", 4.2, "mm", 1, "<="),
      detail: "I2C_SCL runs 4.2 mm and I2C_SDA 2.1 mm over a cut in the bottom ground, where the USB tracks cross under them.",
      fix: "Move the USB tracks at that spot to the top layer, or route SCL and SDA around the cut, so solid ground runs under them the whole way.",
      where: [
        { x: 0.4, y: 7.6, layer: "F.Cu", net: "I2C_SCL", note: "4.2 mm over the cut" },
        { x: 0.4, y: 9.2, layer: "F.Cu", net: "I2C_SDA", note: "2.1 mm over the cut" },
      ],
    },
    "usb-pair": { status: "pass", measured: m("difference in length", 0.12, "mm", 1.5, "<="), detail: "D+ 18.4 mm, D− 18.3 mm; about 88 Ω, inside 90 Ω ± 15 %." },
    "i2c-pullups": { status: "pass", detail: "R4 and R5, 4.7 kΩ to +3V3." },
    "floating-inputs": { status: "pass", detail: "EN: R6 to +3V3 with C6 for a clean start." },
    creepage: { status: "na", detail: "Nothing on this board is above 30 V." },
    // firmware
    "esp32-strapping-U1": { status: "pass", detail: "GPIO9 goes to the boot button only; GPIO2 and GPIO8 are left free." },
    "esp32-adc2-U1": { status: "na", detail: "The board reads no analogue inputs." },
    "firmware-pins": { status: "pass", detail: "GPIO4 SDA, GPIO5 SCL, GPIO10 LED, GPIO9 boot: as wired." },
    // sourcing
    lcsc: { status: "pass", detail: "13 of 13 parts have an LCSC number." },
    stock: { status: "pass", detail: "Every part is in stock at JLCPCB." },
    "stock-qty": { status: "pass", measured: m("fewest in stock (U2)", 7685, "count", 100), detail: "U2: 7,685 in stock; 100 boards need 100." },
    "lifecycle-eol": { status: "pass" },
    "lifecycle-nrnd": { status: "pass" },
    "extended-parts": {
      status: "warn",
      measured: m("extended part types", 4, "count", 3, "<="),
      detail: "U1, U2, U3 and J1 are extended parts: about $12 extra per order.",
      fix: "U1, U3 and J1 have no basic alternative. U2 could be the basic ME6211C33M5G-N (C82942), the same pins and package, to save $3 an order.",
      where: [at("U2")],
    },
    datasheets: { status: "pass" },
    "ratings-known": { status: "pass", detail: "The 6 resistors' power ratings are typical 0402 values (62.5 mW); every other rating is from a datasheet." },
    // manufacturing
    "drc-errors": { status: "pass", measured: m("errors", 0, "count", 0, "<=") },
    "drc-warnings": { status: "pass", measured: m("warnings", 0, "count", 0, "<=") },
    "board-size": { status: "pass", detail: "50 × 40 mm: within JLCPCB's 10 × 10 to 500 × 500 mm for assembly." },
    stackup: { status: "pass", detail: "2 layers, 1.6 mm, 1 oz copper: JLCPCB's standard build." },
    outline: { status: "pass", detail: "One closed outline, 2 mm corners." },
    "bom-cpl": { status: "pass", detail: "19 parts in 13 lines; the placement file lists the same 19." },
  };

  return CATALOG.flatMap((e) => {
    const id = e.id === "esp32-strapping" || e.id === "esp32-adc2" ? `${e.id}-U1` : e.id;
    const r = res[id];
    if (!r) return [];
    const out: CheckResult = { ...e, id, status: r.status };
    if (r.detail) out.detail = r.detail;
    if (r.measured) out.measured = r.measured;
    if (r.where?.length) out.where = r.where;
    if (r.fix && (r.status === "fail" || r.status === "warn")) out.fix = r.fix;
    return [out];
  });
}

export const planOf = (checks: CheckResult[]): CheckPlan[] => checks.map(({ id, group, name }) => ({ id, group, name }));

/** what the engine says it is doing while a check runs */
export function runLabel(c: Pick<CheckResult, "id" | "group">, r: Range): string {
  switch (c.group) {
    case "connections":
    case "circuit":
      return "Comparing the copper with the circuit, pad for pad";
    case "copper":
    case "layout":
      return c.id === "track-heating" ? "Solving the current in every power track" : "Measuring every track and gap";
    case "holes":
      return c.id === "via-current" ? "Solving the current through every via" : "Measuring holes and vias";
    case "silkscreen":
      return "Checking the printed labels";
    case "mask":
      return "Checking the solder mask";
    case "placement":
      return "Checking where each part sits";
    case "power":
      return c.id === "voltage-drop" ? "Solving voltage drop in the copper" : ["pdn", "load-step"].includes(c.id) ? "Simulating the supplies in ngspice" : "Adding up the power budget";
    case "thermal":
      return c.id === "heat-parts-cold" ? `Checking every part for ${num(r.min)} °C` : `Simulating heat at ${num(r.max)} °C`;
    case "stress":
      return `Simulating each part's stress at ${num(r.min)} and ${num(r.max)} °C`;
    case "signals":
      return "Following ground under every signal";
    case "firmware":
      return "Checking the firmware's pins";
    case "sourcing":
      return "Reading stock and prices at JLCPCB";
    case "fab":
      return "Running KiCad's design-rule check with JLCPCB's limits";
  }
}

/** a short sentence for the end of a run: "2 to fix, 5 to look at" */
export function runSummary(checks: CheckResult[]): string {
  const n = counts(checks);
  const parts = [n.fail && `${n.fail} to fix`, n.warn && `${n.warn} to look at`, `${n.pass} passed`].filter(Boolean);
  return `${n.total} tests: ${parts.join(", ")}`;
}

export function sensorReport(r: Range, checks: CheckResult[], madeAt = new Date().toISOString()): TestReport {
  const n = counts(checks);
  const mid = Math.round((r.min + r.max) / 2);
  const points = [...new Set([r.min, mid, r.max])];
  const v = verdict(n);
  return {
    version: 1,
    made_at: madeAt,
    tools: { kicad: "10.0.7", ngspice: "42", sim: "0.1.0" },
    ambient: { min: r.min, max: r.max, points },
    board: {
      width: W,
      height: H,
      layers: 2,
      thickness: 1.6,
      stackup: [
        { name: "F.Silkscreen", kind: "silk", material: "white ink" },
        { name: "F.Mask", kind: "mask", thickness: 0.01, material: "green solder mask" },
        { name: "F.Cu", kind: "copper", thickness: 0.035, role: "signal" },
        { name: "Core", kind: "dielectric", thickness: 1.51, material: "FR4" },
        { name: "B.Cu", kind: "copper", thickness: 0.035, role: "plane GND" },
        { name: "B.Mask", kind: "mask", thickness: 0.01, material: "green solder mask" },
        { name: "B.Silkscreen", kind: "silk", material: "white ink" },
      ],
    },
    summary: { pass: n.pass, fail: n.fail, warn: n.warn, skip: n.skip, na: n.na, verdict: v === "none" ? "ready" : v },
    thermal: thermal(points),
    power: {
      tree: [
        { net: "VBUS", voltage: 5, source: "J1", load: 0.2, capacity: 0.5 },
        { net: "+3V3", voltage: 3.3, source: "U2", from: "VBUS", load: 0.18, capacity: 0.6 },
      ],
      drop: [
        { net: "VBUS", source: "J1", sinks: [{ ref: "U2", drop_mv: 6.1 }], worst_mv: 6.1, pct: 0.12, resistance_mohm: 30 },
        { net: "+3V3", source: "U2", sinks: [{ ref: "U1", drop_mv: 17.8 }, { ref: "U3", drop_mv: 4.2 }], worst_mv: 17.8, pct: 0.54, resistance_mohm: 99 },
      ],
      pdn: [pdn()],
      step: [step()],
    },
    stress: [
      { ref: "U1", what: "voltage", value: 3.3, rating: 3.6, pct: 92, limit_pct: 100, note: "Its normal supply; 3.6 V is the absolute maximum" },
      { ref: "C1", what: "voltage", value: 5.25, rating: 10, pct: 53, limit_pct: 80, ambient: r.max, note: "X5R keeps about 46 % of its value here" },
      { ref: "C2", what: "voltage", value: 3.3, rating: 10, pct: 33, limit_pct: 80 },
      { ref: "C4", what: "voltage", value: 3.3, rating: 10, pct: 33, limit_pct: 80 },
      { ref: "U2", what: "current", value: 0.18, rating: 0.6, pct: 30, limit_pct: 80 },
      { ref: "C3", what: "voltage", value: 3.3, rating: 16, pct: 21, limit_pct: 80 },
      { ref: "C6", what: "voltage", value: 3.3, rating: 25, pct: 13, limit_pct: 80 },
      { ref: "R3", what: "power", value: 0.0036, rating: 0.0625, pct: 6, limit_pct: 50, ambient: r.max, note: "Rating assumed: a typical 0402 resistor" },
      { ref: "J1", what: "current", value: 0.2, rating: 5, pct: 4, limit_pct: 80 },
    ],
    timings: { drc: 2.1, measure: 0.3, spice: 1.2, thermal: 0.4 },
  };
}
