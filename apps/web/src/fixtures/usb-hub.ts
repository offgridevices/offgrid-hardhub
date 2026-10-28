// Demo project: a five-port switched USB hub, modelled on OffGrid's Print Hub
// v1 (offgridevices/offgrid-hardware). Parts, LCSC numbers and stock are the
// ones that board's docs/parts.md read on 17 Oct 2026. Used by demo mode only.
import { Design, type Part } from "@hardhub/protocol";

const checked = "2026-10-17";
const src = (lcsc: string, tier: "basic" | "preferred" | "extended", stock: number, usd: number) => ({
  lcsc,
  tier,
  stock,
  prices: [{ qty: 10, usd }],
  checked_at: checked,
});

const parts: Record<string, Part> = {
  ESP32S3: {
    mpn: "ESP32-S3-WROOM-1-N8", maker: "Espressif", kind: "MOD", value: "ESP32-S3",
    description: "Wi-Fi + BLE module, 8 MB flash, PCB antenna", footprint: "hh:ESP32-S3-WROOM-1",
    lifecycle: "active", assembled: true, sourcing: src("C2913198", "extended", 1696, 4.24),
  },
  HUSB238: {
    mpn: "HUSB238_002DD", maker: "Hynetek", kind: "U", value: "HUSB238",
    description: "USB-PD sink controller, asks the charger for 9 V", footprint: "hh:DFN-10_3x3",
    lifecycle: "active", assembled: true, sourcing: src("C7471904", "extended", 13752, 0.47),
  },
  SY8368A: {
    mpn: "SY8368AQQC", maker: "Silergy", kind: "U", value: "SY8368A",
    description: "Buck converter 4-28 V in, 8 A, makes the 5 V rail", footprint: "hh:QFN-12_3x3",
    lifecycle: "active", assembled: true, sourcing: src("C207642", "extended", 14077, 0.52),
  },
  AP2112K: {
    mpn: "AP2112K-3.3TRG1", maker: "Diodes Inc", kind: "U", value: "AP2112K-3.3",
    description: "3.3 V regulator, 600 mA", footprint: "Package_TO_SOT_SMD:SOT-23-5",
    lifecycle: "active", assembled: true, sourcing: src("C51118", "extended", 7685, 0.17),
  },
  USBLC6: {
    mpn: "USBLC6-2SC6", maker: "STMicroelectronics", kind: "U", value: "USBLC6-2SC6",
    description: "USB ESD protection", footprint: "Package_TO_SOT_SMD:SOT-23-6",
    lifecycle: "active", assembled: true, sourcing: src("C7519", "extended", 34727, 0.18),
  },
  TPS25200: {
    mpn: "TPS25200DRVR", maker: "Texas Instruments", kind: "U", value: "TPS25200",
    description: "USB power switch, 2 A limit, 5.4 V output clamp", footprint: "hh:WSON-6_2x2",
    lifecycle: "active", assembled: true, sourcing: src("C128401", "extended", 20531, 0.33),
  },
  INA180A2: {
    mpn: "INA180A2IDBVR", maker: "Texas Instruments", kind: "U", value: "INA180A2",
    description: "Current-sense amplifier, 50 V/V", footprint: "Package_TO_SOT_SMD:SOT-23-5",
    lifecycle: "active", assembled: true, sourcing: src("C192764", "extended", 100584, 0.19),
  },
  SHUNT: {
    mpn: "RLS12FTCR020", maker: "TA-I Tech", kind: "R", value: "20mR",
    description: "Current shunt 20 mOhm 1 W", footprint: "Resistor_SMD:R_1206_3216Metric",
    lifecycle: "active", assembled: true, sourcing: src("C163047", "extended", 25568, 0.035),
  },
  WS2812: {
    mpn: "WS2812B-2020-V6", maker: "Worldsemi", kind: "LED", value: "WS2812B-2020",
    description: "RGB status LED with driver", footprint: "hh:LED-2020-4P",
    lifecycle: "active", assembled: true, sourcing: src("C52917434", "extended", 932040, 0.09),
  },
  L2U2: {
    mpn: "FXL0630-2R2-M", maker: "Changjiang", kind: "L", value: "2.2uH",
    description: "Buck inductor, 9.5 A saturation", footprint: "hh:IND-7x6.6",
    lifecycle: "active", assembled: true, sourcing: src("C167218", "extended", 52956, 0.09),
  },
  SMAJ15A: {
    mpn: "SMAJ15A", maker: "hongjiacheng", kind: "D", value: "SMAJ15A",
    description: "Input surge protection, 15 V", footprint: "Diode_SMD:D_SMA",
    lifecycle: "active", assembled: true, sourcing: src("C19077535", "preferred", 102505, 0.04),
  },
  USBC: {
    mpn: "TYPE-C-31-M-12", maker: "Korean Hroparts", kind: "J", value: "USB-C",
    description: "USB-C receptacle, 5 A", footprint: "hh:USB-C-16P",
    lifecycle: "active", assembled: true, sourcing: src("C165948", "extended", 365608, 0.19),
  },
  USBA: {
    mpn: "902-131A1011D10100", maker: "Jing Extension", kind: "J", value: "USB-A",
    description: "USB-A receptacle, right angle, through-hole", footprint: "hh:USB-A-TH",
    lifecycle: "active", assembled: true, sourcing: src("C2345", "extended", 30391, 0.06),
  },
  R10K: {
    mpn: "0402WGF1002TCE", maker: "UNI-ROYAL", kind: "R", value: "10k",
    description: "Resistor 10k 1% 0402", footprint: "Resistor_SMD:R_0402_1005Metric",
    lifecycle: "active", assembled: true, sourcing: src("C25744", "basic", 4_200_000, 0.002),
  },
  R47K: {
    mpn: "0402WGF4702TCE", maker: "UNI-ROYAL", kind: "R", value: "47k",
    description: "Resistor 47k 1% 0402 (sets the port current limit)", footprint: "Resistor_SMD:R_0402_1005Metric",
    lifecycle: "active", assembled: true, sourcing: src("C25792", "basic", 1_850_000, 0.002),
  },
  C100N: {
    mpn: "CL05B104KO5NNNC", maker: "Samsung", kind: "C", value: "100nF",
    description: "Capacitor 100nF 16V X7R 0402", footprint: "Capacitor_SMD:C_0402_1005Metric",
    lifecycle: "active", assembled: true, sourcing: src("C1525", "basic", 28_000_000, 0.002),
  },
  C22U: {
    mpn: "CL31A226KAHNNNE", maker: "Samsung", kind: "C", value: "22uF",
    description: "Capacitor 22uF 25V X5R 1206", footprint: "Capacitor_SMD:C_1206_3216Metric",
    lifecycle: "active", assembled: true, sourcing: src("C12891", "basic", 3_100_000, 0.03),
  },
  OLDLDO: {
    mpn: "LM1117IMP-3.3", maker: "Texas Instruments", kind: "U", value: "LM1117-3.3",
    description: "Considered and rejected: older 3.3 V regulator", footprint: "Package_TO_SOT_SMD:SOT-223-3_TabPin2",
    lifecycle: "nrnd", assembled: false,
  },
};

const comps: Design["components"] = [];
const add = (ref: string, part: string, block: string, pins: Record<string, string | null>, note?: string) =>
  comps.push({ ref, part, block, pins, note });

// power in
add("J1", "USBC", "power", { A4: "VBUS_IN", B4: "VBUS_IN", A9: "VBUS_IN", B9: "VBUS_IN", A5: "CC1", B5: "CC2", A1: "GND", B1: "GND", A12: "GND", B12: "GND" }, "POWER IN, back left");
add("D1", "SMAJ15A", "power", { "1": "VBUS_IN", "2": "GND" }, "Clamps surges on the charger input");
add("U1", "HUSB238", "power", { "1": "VBUS_IN", "2": "CC1", "3": "CC2", "4": "I2C_SDA", "5": "I2C_SCL", "6": "GND", "7": null, "8": null, "9": "GND", "10": "GND" });
add("U2", "SY8368A", "power", { "1": "VBUS_IN", "2": "VBUS_IN", "3": "BUCK_LX", "4": "BUCK_LX", "5": "GND", "6": "GND", "7": "BUCK_FB", "8": "BUCK_BS", "9": "VCC5", "10": "GND", "11": "VBUS_IN", "12": "GND" });
add("L1", "L2U2", "power", { "1": "BUCK_LX", "2": "VRAIL" });
add("C1", "C22U", "power", { "1": "VBUS_IN", "2": "GND" });
add("C2", "C22U", "power", { "1": "VRAIL", "2": "GND" });
add("C3", "C22U", "power", { "1": "VRAIL", "2": "GND" });
add("C4", "C100N", "power", { "1": "BUCK_BS", "2": "BUCK_LX" });
// logic
add("U3", "ESP32S3", "logic", { "1": "GND", "2": "+3V3", "3": "EN", "4": "PORT1_I", "5": "PORT2_I", "6": "PORT3_I", "7": "PORT4_I", "8": "PORT5_I", "13": "USB_DN", "14": "USB_DP", "15": "PORT1_EN", "16": "PORT2_EN", "17": "PORT3_EN", "18": "PORT4_EN", "19": "PORT5_EN", "20": "LED_DATA", "21": "I2C_SDA", "22": "I2C_SCL", "40": "GND", "41": "GND" }, "Antenna at the board edge, no copper under it");
add("U4", "AP2112K", "logic", { "1": "VLOGIC", "2": "GND", "3": "VLOGIC", "4": null, "5": "+3V3" });
add("U5", "USBLC6", "logic", { "1": "USB_DP", "2": "GND", "3": "USB_DN", "4": "USB_DN_C", "5": "VBUS_DATA", "6": "USB_DP_C" });
add("J2", "USBC", "logic", { A4: "VBUS_DATA", B4: "VBUS_DATA", A6: "USB_DP_C", A7: "USB_DN_C", A1: "GND", B1: "GND" }, "DATA port to the print server");
add("R1", "R10K", "logic", { "1": "+3V3", "2": "EN" });
add("R2", "R10K", "logic", { "1": "+3V3", "2": "I2C_SDA" });
add("R3", "R10K", "logic", { "1": "+3V3", "2": "I2C_SCL" });
add("C5", "C100N", "logic", { "1": "+3V3", "2": "GND" });
add("C6", "C100N", "logic", { "1": "VLOGIC", "2": "GND" });
add("D2", "WS2812", "logic", { "1": "LED_CHAIN1", "2": "GND", "3": "LED_DATA", "4": "VRAIL" });
// five ports
for (let n = 1; n <= 5; n++) {
  const b = `port${n}`;
  const u = 5 + n * 2;
  add(`J${2 + n}`, "USBA", b, { "1": `VBUS${n}`, "2": `DCP${n}`, "3": `DCP${n}`, "4": "GND", "5": "GND", "6": "GND" });
  add(`U${u}`, "TPS25200", b, { "1": `PORT${n}_SW`, "2": `ILIM${n}`, "3": `FAULT${n}`, "4": `PORT${n}_EN`, "5": "GND", "6": "VRAIL", "7": "GND" });
  add(`U${u + 1}`, "INA180A2", b, { "1": `PORT${n}_I`, "2": "GND", "3": `PORT${n}_SW`, "4": `VBUS${n}`, "5": "+3V3" });
  add(`R${2 + n * 3}`, "SHUNT", b, { "1": `PORT${n}_SW`, "2": `VBUS${n}` });
  add(`R${3 + n * 3}`, "R47K", b, { "1": `ILIM${n}`, "2": "GND" });
  add(`R${4 + n * 3}`, "R10K", b, { "1": "+3V3", "2": `FAULT${n}` });
  add(`C${5 + n * 2}`, "C100N", b, { "1": `VBUS${n}`, "2": "GND" });
  add(`D${2 + n}`, "WS2812", b, { "1": n < 5 ? `LED_CHAIN${n + 1}` : null, "2": "GND", "3": `LED_CHAIN${n}`, "4": "VRAIL" });
}

// placement: power back left, logic back right, ports along the front
const placement: Design["placement"] = {};
const at = (ref: string, x: number, y: number, rot = 0) => (placement[ref] = { x, y, rot, side: "top", locked: false });
at("J1", -36, -21, 180); at("D1", -30, -17); at("U1", -24, -18); at("U2", -34, -10); at("L1", -26, -9);
at("C1", -38, -15, 90); at("C2", -20, -10, 90); at("C3", -18, -10, 90); at("C4", -30, -6);
at("U3", 30, -10); at("U4", 14, -16); at("U5", 4, -18); at("J2", 4, -21, 180);
at("R1", 18, -8); at("R2", 18, -5); at("R3", 18, -2); at("C5", 14, -11); at("C6", 10, -16); at("D2", 8, -6);
for (let n = 1; n <= 5; n++) {
  const x = -34 + (n - 1) * 17;
  const u = 5 + n * 2;
  at(`J${2 + n}`, x, 16);
  at(`U${u}`, x - 3, 4); at(`U${u + 1}`, x + 4, 4);
  at(`R${2 + n * 3}`, x, 8, 90); at(`R${3 + n * 3}`, x - 6, 6); at(`R${4 + n * 3}`, x - 6, 2);
  at(`C${5 + n * 2}`, x + 5, 8); at(`D${2 + n}`, x + 6, 0);
}

const nets: Design["nets"] = {
  GND: { kind: "ground" },
  VBUS_IN: { kind: "power", voltage: 9, current: 2 },
  VRAIL: { kind: "power", voltage: 5.16, current: 3 },
  BUCK_LX: { kind: "power", current: 3, note: "Switch node: keep it short" },
  "+3V3": { kind: "power", voltage: 3.3, current: 0.4 },
  VLOGIC: { kind: "power", voltage: 5, current: 0.4 },
  USB_DP: { kind: "signal", diff_pair: "USB_DN" },
  USB_DN: { kind: "signal", diff_pair: "USB_DP" },
};
for (let n = 1; n <= 5; n++) {
  nets[`VBUS${n}`] = { kind: "power", voltage: 5, current: 1.5 };
  nets[`PORT${n}_SW`] = { kind: "power", voltage: 5, current: 1.5 };
}

export const usbHubDesign: Design = Design.parse({
  name: "Print hub",
  revision: "v1",
  summary: "Five switched USB-A ports for a resin printer's accessories, controlled over Wi-Fi or USB.",
  stage: "order",
  requirements: [
    { id: "R1", text: "Five USB-A ports, each switched on and off by the print server", check: "circuit check", status: "met" },
    { id: "R2", text: "Controlled over Wi-Fi and over USB from the server", check: "firmware pin map", status: "met" },
    { id: "R3", text: "Never burns anything out: per-port current limit and 5.4 V clamp", check: "power budget, thermal estimate", status: "met" },
    { id: "R4", text: "A short on one port does not brown out the others", check: "simulation", status: "met", note: "Others hold above 4.75 V" },
    { id: "R5", text: "Powered from a USB-C charger, 20 W or more", check: "power budget", status: "limit", note: "The server's USB port alone cannot run the accessories (about 15 W needed)" },
    { id: "R6", text: "Under 100 mm a side, fully assembled by JLCPCB", check: "board size, BOM", status: "met" },
  ],
  decisions: [
    { id: "D1", stage: "parts", question: "Which microcontroller?", options: [{ id: "s3", label: "ESP32-S3 module" }, { id: "c3", label: "ESP32-C3 module" }, { id: "c6", label: "ESP32-C6 module" }], recommended: "s3", chosen: "s3", why: "Native USB for the server link, enough analogue inputs on ADC1 for five current readings while Wi-Fi is on.", at: "2026-10-17T15:02:00Z" },
    { id: "D2", stage: "parts", question: "How should ports switch?", options: [{ id: "sw", label: "Solid-state USB power switch" }, { id: "relay", label: "Relay" }], recommended: "sw", chosen: "sw", why: "Silent, no wear, current limit and fault signal built in.", at: "2026-10-17T15:04:00Z" },
    { id: "D3", stage: "board", question: "How many copper layers?", options: [{ id: "2", label: "2 layers" }, { id: "4", label: "4 layers" }], recommended: "4", chosen: "4", why: "An unbroken ground plane under the buck and the USB pair; JLCPCB's price for five 4-layer boards under 100 mm is still low.", at: "2026-10-17T16:20:00Z" },
  ],
  blocks: {
    power: { name: "Power in", purpose: "USB-C charger at 9 V, surge clamp, buck to a 5.16 V rail" },
    logic: { name: "Logic", purpose: "ESP32-S3 on Wi-Fi and USB, 3.3 V regulator, status LED" },
    port1: { name: "Port 1", purpose: "Switch, current sense and LED for one USB-A port" },
    port2: { name: "Port 2", purpose: "Switch, current sense and LED for one USB-A port" },
    port3: { name: "Port 3", purpose: "Switch, current sense and LED for one USB-A port" },
    port4: { name: "Port 4", purpose: "Switch, current sense and LED for one USB-A port" },
    port5: { name: "Port 5", purpose: "Switch, current sense and LED for one USB-A port" },
  },
  parts,
  components: comps,
  nets,
  board: {
    width: 86, height: 50, corner_radius: 2, layers: 4, fab: "jlcpcb", mask_color: "black", finish: "enig",
    holes: [{ x: -39.5, y: -21.5, d: 3.2 }, { x: 39.5, y: -21.5, d: 3.2 }, { x: -39.5, y: 21.5, d: 3.2 }, { x: 39.5, y: 21.5, d: 3.2 }],
    layer_roles: [
      { layer: "F.Cu", role: "mixed" },
      { layer: "In1.Cu", role: "plane", net: "GND" },
      { layer: "In2.Cu", role: "plane", net: "VRAIL" },
      { layer: "B.Cu", role: "mixed" },
    ],
    keepouts: [{ rect: [34, -25, 43, -14], layers: ["F.Cu", "In1.Cu", "In2.Cu", "B.Cu"], reason: "Wi-Fi antenna: no copper under it" }],
  },
  placement,
  firmware: {
    platform: "esphome",
    mcu: "U3",
    pins: [
      { name: "PORT1_EN", gpio: 15, net: "PORT1_EN", dir: "out" },
      { name: "PORT2_EN", gpio: 16, net: "PORT2_EN", dir: "out" },
      { name: "PORT3_EN", gpio: 17, net: "PORT3_EN", dir: "out" },
      { name: "PORT4_EN", gpio: 18, net: "PORT4_EN", dir: "out" },
      { name: "PORT5_EN", gpio: 8, net: "PORT5_EN", dir: "out" },
      { name: "PORT1_I", gpio: 4, net: "PORT1_I", dir: "analog" },
      { name: "LED_DATA", gpio: 3, net: "LED_DATA", dir: "out" },
      { name: "I2C_SDA", gpio: 21, net: "I2C_SDA", dir: "i2c" },
      { name: "I2C_SCL", gpio: 47, net: "I2C_SCL", dir: "i2c" },
    ],
    files: {
      "printhub.yaml": `esphome:
  name: printhub

esp32:
  board: esp32-s3-devkitc-1

wifi:
  ssid: !secret wifi_ssid
  password: !secret wifi_password

api:        # Home Assistant
ota:
  - platform: esphome

switch:
  - platform: gpio
    pin: GPIO15
    name: "Port 1"
  - platform: gpio
    pin: GPIO16
    name: "Port 2"
  - platform: gpio
    pin: GPIO17
    name: "Port 3"
  - platform: gpio
    pin: GPIO18
    name: "Port 4"
  - platform: gpio
    pin: GPIO8
    name: "Port 5"

sensor:
  - platform: adc
    pin: GPIO4
    name: "Port 1 current"
    unit_of_measurement: A
    filters:
      - multiply: 1.0   # INA180A2 x 20 mOhm shunt: 1 V per A
`,
    },
  },
});
