// Scripted conversations for demo mode. Each entry is a ServerEvent without
// seq/at (the mock backend stamps them) plus an optional delay before it.
import type { ServerEvent } from "@hardhub/protocol";

type Bare<T> = T extends unknown ? Omit<T, "seq" | "at"> : never;
export type ScriptStep = Bare<ServerEvent> & { delay?: number };

const LAYERS = ["F.Cu", "In1.Cu", "In2.Cu", "B.Cu", "F.Silkscreen", "B.Silkscreen", "Edge.Cuts"];

/** A live message: the deltas a streaming server sends, then the whole text. */
function stream(id: string, text: string, chunk = 18, delay = 28): ScriptStep[] {
  const out: ScriptStep[] = [];
  for (let i = 0; i < text.length; i += chunk) out.push({ type: "assistant_text", id, text: text.slice(i, i + chunk), done: false, delay });
  out.push({ type: "assistant_text", id, text, done: true, delay });
  return out;
}

/** A finished message as history stores it: deltas are never stored. */
function said(id: string, text: string): ScriptStep[] {
  return [{ type: "assistant_text", id, text, done: true }];
}

const hubPrompt =
  "I want a box behind my resin printer with five USB ports I can switch on and off, so the fan, the light and the air filters come on when a print starts. It should talk to Home Assistant over Wi-Fi.";

export const hubHistory: ScriptStep[] = [
  { type: "stage", stage: "idea" },
  { type: "user_message", id: "u1", text: hubPrompt },
  { type: "thinking", id: "th1", text: "Five switched ports, Wi-Fi, Home Assistant. Unknowns: power source, current per port, whether the server should control it over USB too, size, budget." },
  ...said("a1", "A five-port switched USB box is a good fit for a small board. Three questions before I propose anything — each changes the parts or the board size."),
  {
    type: "questions",
    id: "q1",
    questions: [
      { id: "power", header: "Power", text: "How will the box be powered?", multi: false, options: [
        { id: "pd", label: "USB-C charger, 20 W or more", detail: "One cable. Enough for a fan, a light and two filters at once.", recommended: true },
        { id: "pc", label: "The printer's computer USB port", detail: "Only about 4.5 W: not enough for the accessories." },
        { id: "barrel", label: "12 V barrel adapter", detail: "Needs a bigger converter on the board." },
      ] },
      { id: "control", header: "Control", text: "How should it be told what to do?", multi: true, options: [
        { id: "wifi", label: "Wi-Fi, Home Assistant", detail: "ESPHome: shows up in Home Assistant by itself.", recommended: true },
        { id: "usb", label: "USB cable from the print server", detail: "Works with Wi-Fi off. Adds a second USB-C port.", recommended: true },
        { id: "buttons", label: "Buttons on the box" },
      ] },
      { id: "current", header: "Current", text: "What is the most one accessory draws?", multi: false, options: [
        { id: "1a", label: "Up to 1 A", detail: "Fans and LED strips." },
        { id: "15a", label: "Up to 1.5 A", detail: "Covers most USB air filters.", recommended: true },
        { id: "unsure", label: "Not sure", detail: "I'll size for 1.5 A and limit each port safely." },
      ] },
    ],
  },
  { type: "turn_end", reason: "waiting_for_user" },
  { type: "user_message", id: "u2", text: "Answers", answers: { power: ["USB-C charger, 20 W or more"], control: ["Wi-Fi, Home Assistant", "USB cable from the print server"], current: ["Up to 1.5 A"] } },
  { type: "tool", id: "t1", name: "update_design", label: "Wrote 6 requirements", status: "done" },
  { type: "stage", stage: "parts" },
  { type: "tool", id: "t2", name: "search_parts", label: "Searched JLCPCB for ESP32 modules", status: "done", detail: "23 results" },
  {
    type: "comparison",
    comparison: {
      id: "cmp-mcu",
      title: "Microcontroller",
      columns: ["Part", "Why", "Price", "Stock", "JLCPCB"],
      rows: [
        { id: "s3", cells: ["ESP32-S3-WROOM-1-N8", "Native USB for the server link; enough ADC1 inputs for five current readings with Wi-Fi on", "$4.24", "1,696", "Extended"], recommended: true },
        { id: "c3", cells: ["ESP32-C3-WROOM-02", "Cheaper, but only 5 analogue inputs and one is on ADC2", "$2.18", "41,020", "Extended"] },
        { id: "esp8266", cells: ["ESP-12F (ESP8266)", "One analogue input, no native USB", "$1.95", "8,300", "Extended"], warning: "Not recommended for new designs" },
      ],
      note: "JLCPCB catalogue, read 17 Oct 2026. Price at 10 pieces.",
    },
  },
  { type: "tool", id: "t3", name: "search_parts", label: "Compared 3 USB power switches", status: "done" },
  { type: "design", version: 4, summary: "Parts chosen: ESP32-S3, TPS25200 switches, INA180A2 sensing" },
  { type: "stage", stage: "circuit" },
  { type: "tool", id: "t4", name: "update_design", label: "Wired 59 components", status: "done" },
  { type: "tool", id: "t5", name: "check_circuit", label: "Circuit checks: 9 of 9 pass", status: "done" },
  { type: "stage", stage: "board" },
  {
    type: "comparison",
    comparison: {
      id: "cmp-layers",
      title: "Copper layers for an 86 × 50 mm board",
      columns: ["Layers", "What it buys", "5 boards", "100 boards"],
      rows: [
        { id: "2", cells: ["2", "Cheapest. Ground is broken up by tracks under the buck and USB pair.", "$4", "$62"] },
        { id: "4", cells: ["4", "Unbroken ground plane and a 5 V plane. Quieter, cooler, easier to route.", "$8", "$118"], recommended: true },
        { id: "6", cells: ["6", "Not needed at this density.", "$58", "$640"] },
      ],
      note: "JLCPCB price list, Oct 2026, board only, before assembly. Estimate: check the live quote.",
    },
  },
  { type: "user_message", id: "u3", text: "4 layers is fine." },
  { type: "design", version: 7, summary: "Board 86 × 50 mm, 4 layers, black mask, ENIG" },
  { type: "stage", stage: "layout" },
  { type: "job", job: "build-1", step: "place", progress: 0.15, done: false },
  { type: "job", job: "build-1", step: "route", progress: 0.55, done: false },
  { type: "job", job: "build-1", step: "drc", progress: 0.85, done: false },
  { type: "job", job: "build-1", step: "fab", progress: 1, done: true, ok: true },
  { type: "stage", stage: "checks" },
  {
    type: "checks",
    results: [
      { id: "drc", group: "layout", name: "Design rules: 0 errors, 0 warnings, 0 unconnected", why: "The fab rejects or mis-builds a board that breaks its rules. Rules are JLCPCB's own limits.", status: "pass" },
      { id: "nets", group: "layout", name: "Copper matches the circuit, pad for pad", why: "The copper is the circuit; a missing link is a dead board.", status: "pass", },
      { id: "corners", group: "layout", name: "Every track corner 45° or less", why: "House rule; also no acid traps in the etch.", status: "pass", detail: "34 corners cut" },
      { id: "ground", group: "layout", name: "Unbroken ground plane under the USB pair and the buck", why: "Return current runs under its signal; a gap makes a loop that radiates.", status: "pass" },
      { id: "pins", group: "circuit", name: "Every pin on its footprint, every pad accounted for", why: "A wrong or missing pad cannot be fixed after assembly.", status: "pass", detail: "59 parts" },
      { id: "adc2", group: "circuit", name: "Analogue inputs on ADC1 only", why: "ESP32 ADC2 stops working while Wi-Fi is on.", status: "pass" },
      { id: "strap", group: "circuit", name: "Strapping pins left alone", why: "A strapping pin pulled the wrong way stops the ESP32 booting.", status: "pass" },
      { id: "bom", group: "fab", name: "BOM and placement file list exactly the assembled parts", why: "Nothing missing or extra on the assembly line.", status: "pass", detail: "59 parts in 16 lines" },
      { id: "width", group: "power", name: "Track widths carry their current", why: "Narrow power tracks heat up and drop voltage.", status: "pass", detail: "Ports 0.8 mm for 1.5 A, rail as a plane" },
      { id: "budget", group: "power", name: "Power budget: 3 A total at 5.16 V", why: "Know before ordering that the charger and converter can supply every port.", status: "pass" },
      { id: "thermal", group: "thermal", name: "Hottest part in a closed case, 35 °C room", why: "A part past its rating fails early.", status: "warn", detail: "Buck capacitor 81 °C of 85 °C: the firmware turns ports down from 74 °C on the thermistor" },
      { id: "fw", group: "firmware", name: "Firmware pin map matches the circuit", why: "A swapped pin is a port that never switches.", status: "pass" },
      { id: "bench", group: "fab", name: "Measured on a built board", why: "Simulation is not hardware.", status: "skip", detail: "After the first boards arrive" },
    ],
  },
  { type: "stage", stage: "view" },
  {
    type: "artifacts",
    artifacts: [
      ...LAYERS.map((l) => ({ kind: "board-svg" as const, name: `layer-${l}.svg`, url: `mock:svg/${l}`, layers: [l] })),
      { kind: "glb", name: "board.glb", url: "mock:glb", bytes: 1_840_000 },
      { kind: "gerbers", name: "print-hub-gerbers.zip", url: "mock:file/gerbers", bytes: 412_000 },
      { kind: "bom", name: "print-hub-bom-jlcpcb.csv", url: "mock:file/bom", bytes: 4_100 },
      { kind: "cpl", name: "print-hub-cpl-jlcpcb.csv", url: "mock:file/cpl", bytes: 7_300 },
      { kind: "netlist", name: "print-hub.ipc", url: "mock:file/netlist", bytes: 61_000 },
      { kind: "firmware", name: "printhub.yaml", url: "mock:file/firmware", bytes: 1_200 },
    ],
  },
  { type: "stage", stage: "order" },
  ...said("a2", "The board is ready to order. Every check passes except one warning I want you to see: in a closed case at 35 °C the capacitor by the converter reaches 81 °C of its 85 °C rating at full load. The firmware turns the ports down before that. If the box will sit somewhere hot, I can add vents to the case or a larger capacitor."),
  { type: "usage", input_tokens: 182_400, output_tokens: 21_700, cost_usd: 1.16 },
  { type: "turn_end", reason: "done" },
];

const gardenPrompt = "A soil moisture sensor for my vegetable bed that runs on a battery for a whole season and reports to Home Assistant.";

export const gardenHistory: ScriptStep[] = [
  { type: "stage", stage: "idea" },
  { type: "user_message", id: "g1", text: gardenPrompt },
  ...said("ga1", "Battery life decides almost everything here, so I'll start there. Three questions."),
  {
    type: "questions",
    id: "gq1",
    questions: [
      { id: "battery", header: "Battery", text: "What should power it?", multi: false, options: [
        { id: "aa", label: "Two AA batteries", detail: "Easy to replace. About a season at one reading every 15 minutes.", recommended: true },
        { id: "lipo", label: "Rechargeable LiPo with a small solar panel", detail: "No battery swaps, but more parts and a charger chip." },
        { id: "coin", label: "Coin cell", detail: "Too little energy for Wi-Fi." },
      ] },
      { id: "radio", header: "Radio", text: "How far is the bed from your Wi-Fi?", multi: false, options: [
        { id: "near", label: "Within 20 m, good signal", recommended: true },
        { id: "far", label: "Further, or behind walls", detail: "I'd suggest Zigbee or LoRa instead of Wi-Fi." },
      ] },
      { id: "how-often", header: "Readings", text: "How often should it report?", multi: false, options: [
        { id: "15", label: "Every 15 minutes", recommended: true },
        { id: "60", label: "Every hour", detail: "Roughly doubles battery life." },
        { id: "5", label: "Every 5 minutes" },
      ] },
    ],
  },
  { type: "usage", input_tokens: 9_800, output_tokens: 1_150, cost_usd: 0.07 },
  { type: "turn_end", reason: "waiting_for_user" },
];

/** What demo mode does after any message: a short, complete turn. */
export function replyScript(text: string, answered: boolean): ScriptStep[] {
  const id = `r${Math.random().toString(36).slice(2, 8)}`;
  return [
    { type: "thinking", id: `${id}-th`, text: answered ? "The answers settle power and radio. Next: candidate parts with live stock." : `The person said: ${text.slice(0, 120)}` , delay: 400 },
    { type: "tool", id: `${id}-t1`, name: "search_parts", label: "Searching JLCPCB for parts", status: "running", delay: 300 },
    { type: "tool", id: `${id}-t1`, name: "search_parts", label: "Searched JLCPCB for parts", status: "done", detail: "18 results", delay: 900 },
    ...stream(
      id,
      answered
        ? "Thanks — that's enough to choose parts. This is demo mode, so the parts and board here are examples. Connect HardHub to its server and add an AI key in Settings to design a real board."
        : "This is demo mode: HardHub isn't connected to its server, so I can't design for real yet. Connect it and add an AI key in Settings, and I'll take it from here.",
      14,
      22,
    ),
    { type: "usage", input_tokens: 4200, output_tokens: 380, cost_usd: 0.03, delay: 50 },
    { type: "turn_end", reason: "done", delay: 50 },
  ];
}
