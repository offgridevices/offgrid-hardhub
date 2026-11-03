// Demo project: a two-layer room climate sensor (ESP32-C3 module, SHT40
// temperature and humidity sensor, powered from USB-C through a 3.3 V
// regulator). The board the demo's tests run on. Used by demo mode only.
import { Design, type Part, type Ratings } from "@hardhub/protocol";

const checked = "2026-11-02";
const src = (lcsc: string, tier: "basic" | "preferred" | "extended", stock: number, usd: number) => ({
  lcsc,
  tier,
  stock,
  prices: [{ qty: 10, usd }],
  checked_at: checked,
});
const rate = (r: Ratings): Ratings => r;

const parts: Record<string, Part> = {
  C3MINI: {
    mpn: "ESP32-C3-MINI-1-N4", maker: "Espressif", kind: "MOD", value: "ESP32-C3-MINI-1",
    description: "Wi-Fi + BLE module, 4 MB flash, PCB antenna", footprint: "hh:ESP32-C3-MINI-1",
    lifecycle: "active", assembled: true, sourcing: src("C2838502", "extended", 41_020, 1.98),
    ratings: rate({ temp_min: -40, temp_max: 105, voltage_max: 3.6, source: "datasheet p. 31" }),
  },
  LDO: {
    mpn: "AP2112K-3.3TRG1", maker: "Diodes Inc", kind: "U", value: "AP2112K-3.3",
    description: "3.3 V regulator, 600 mA", footprint: "Package_TO_SOT_SMD:SOT-23-5",
    lifecycle: "active", assembled: true, sourcing: src("C51118", "extended", 7_685, 0.17),
    ratings: rate({ temp_min: -40, temp_max: 85, voltage_max: 6.5, current_max: 0.6, theta_jb: 95, dropout: 0.25, source: "datasheet p. 3" }),
  },
  SHT40: {
    mpn: "SHT40-AD1B-R2", maker: "Sensirion", kind: "U", value: "SHT40",
    description: "Temperature and humidity sensor, I2C", footprint: "hh:DFN-4_1.5x1.5",
    lifecycle: "active", assembled: true, sourcing: src("C2846150", "extended", 12_430, 1.31),
    ratings: rate({ temp_min: -40, temp_max: 125, voltage_max: 3.6, source: "datasheet p. 2" }),
  },
  USBC: {
    mpn: "TYPE-C-31-M-12", maker: "Korean Hroparts", kind: "J", value: "USB-C",
    description: "USB-C receptacle, 16 pins", footprint: "hh:USB-C-16P",
    lifecycle: "active", assembled: true, sourcing: src("C165948", "extended", 365_608, 0.19),
    ratings: rate({ temp_min: -30, temp_max: 80, current_max: 5, source: "datasheet p. 1" }),
  },
  LED: {
    mpn: "KT-0603G", maker: "Hubei KENTO", kind: "LED", value: "green",
    description: "Status LED, green, 0603", footprint: "LED_SMD:LED_0603_1608Metric",
    lifecycle: "active", assembled: true, sourcing: src("C72043", "basic", 2_110_400, 0.004),
    ratings: rate({ temp_min: -40, temp_max: 85, source: "datasheet p. 2" }),
  },
  BTN: {
    mpn: "TS-1187A-B-A-B", maker: "XKB", kind: "SW", value: "BOOT",
    description: "Tactile switch 5.1 × 5.1 mm", footprint: "hh:SW-SMD-5.1x5.1",
    lifecycle: "active", assembled: true, sourcing: src("C318884", "basic", 1_284_000, 0.03),
  },
  R5K1: {
    mpn: "0402WGF5101TCE", maker: "UNI-ROYAL", kind: "R", value: "5.1k",
    description: "Resistor 5.1 kΩ 1% 0402", footprint: "Resistor_SMD:R_0402_1005Metric",
    lifecycle: "active", assembled: true, sourcing: src("C25905", "basic", 5_910_000, 0.001),
    ratings: rate({ power_max: 0.0625, source: "assumed" }),
  },
  R10K: {
    mpn: "0402WGF1002TCE", maker: "UNI-ROYAL", kind: "R", value: "10k",
    description: "Resistor 10 kΩ 1% 0402", footprint: "Resistor_SMD:R_0402_1005Metric",
    lifecycle: "active", assembled: true, sourcing: src("C25744", "basic", 18_520_000, 0.001),
    ratings: rate({ power_max: 0.0625, source: "assumed" }),
  },
  R4K7: {
    mpn: "0402WGF4701TCE", maker: "UNI-ROYAL", kind: "R", value: "4.7k",
    description: "Resistor 4.7 kΩ 1% 0402", footprint: "Resistor_SMD:R_0402_1005Metric",
    lifecycle: "active", assembled: true, sourcing: src("C25900", "basic", 7_420_000, 0.001),
    ratings: rate({ power_max: 0.0625, source: "assumed" }),
  },
  R1K: {
    mpn: "0402WGF1001TCE", maker: "UNI-ROYAL", kind: "R", value: "1k",
    description: "Resistor 1 kΩ 1% 0402", footprint: "Resistor_SMD:R_0402_1005Metric",
    lifecycle: "active", assembled: true, sourcing: src("C11702", "basic", 9_800_000, 0.001),
    ratings: rate({ power_max: 0.0625, source: "assumed" }),
  },
  C100N: {
    mpn: "CL05B104KO5NNNC", maker: "Samsung", kind: "C", value: "100nF",
    description: "Capacitor 100 nF 16 V X7R 0402", footprint: "Capacitor_SMD:C_0402_1005Metric",
    lifecycle: "active", assembled: true, sourcing: src("C1525", "basic", 32_440_000, 0.001),
    ratings: rate({ voltage_max: 16, temp_min: -55, temp_max: 125, source: "datasheet" }),
  },
  C1U: {
    mpn: "CL05A105KA5NQNC", maker: "Samsung", kind: "C", value: "1uF",
    description: "Capacitor 1 µF 25 V X5R 0402", footprint: "Capacitor_SMD:C_0402_1005Metric",
    lifecycle: "active", assembled: true, sourcing: src("C52923", "basic", 11_020_000, 0.002),
    ratings: rate({ voltage_max: 25, temp_min: -55, temp_max: 85, source: "datasheet" }),
  },
  C10U: {
    mpn: "CL10A106KP8NNNC", maker: "Samsung", kind: "C", value: "10uF",
    description: "Capacitor 10 µF 10 V X5R 0603", footprint: "Capacitor_SMD:C_0603_1608Metric",
    lifecycle: "active", assembled: true, sourcing: src("C19702", "basic", 9_170_000, 0.006),
    ratings: rate({ voltage_max: 10, temp_min: -55, temp_max: 85, source: "datasheet" }),
  },
};

const comps: Design["components"] = [];
const add = (ref: string, part: string, block: string, pins: Record<string, string | null>, note?: string, power?: number) =>
  comps.push({ ref, part, block, pins, note, ...(power !== undefined ? { power } : {}) });

// power in: USB-C, 5.1 kΩ on each CC pin, 3.3 V regulator
add("J1", "USBC", "power", { A4: "VBUS", B4: "VBUS", A9: "VBUS", B9: "VBUS", A5: "CC1", B5: "CC2", A6: "USB_DP", A7: "USB_DN", B6: "USB_DP", B7: "USB_DN", A1: "GND", B1: "GND", A12: "GND", B12: "GND" }, "Power and USB, left edge");
add("R1", "R5K1", "power", { "1": "CC1", "2": "GND" });
add("R2", "R5K1", "power", { "1": "CC2", "2": "GND" });
add("U2", "LDO", "power", { "1": "VBUS", "2": "GND", "3": "VBUS", "4": null, "5": "+3V3" }, undefined, 0.29);
add("C1", "C10U", "power", { "1": "VBUS", "2": "GND" });
add("C2", "C10U", "power", { "1": "+3V3", "2": "GND" });
// logic: the module, its enable and boot, status LED
add("U1", "C3MINI", "logic", { "1": "GND", "3": "+3V3", "8": "EN", "13": "I2C_SDA", "14": "I2C_SCL", "16": "LED", "18": "BOOT", "26": "USB_DN", "27": "USB_DP", "53": "GND" }, "Antenna at the top edge, no copper under it", 0.35);
add("C3", "C100N", "logic", { "1": "+3V3", "2": "GND" });
add("C4", "C10U", "logic", { "1": "+3V3", "2": "GND" });
add("R6", "R10K", "logic", { "1": "+3V3", "2": "EN" });
add("C6", "C1U", "logic", { "1": "EN", "2": "GND" });
add("SW1", "BTN", "logic", { "1": "BOOT", "2": "GND" }, "Hold while plugging in to load firmware over USB");
add("R3", "R1K", "logic", { "1": "LED", "2": "LED_A" });
add("D1", "LED", "logic", { "1": "GND", "2": "LED_A" });
// sensor: away from the regulator and the module, so it reads the room
add("U3", "SHT40", "sensor", { "1": "I2C_SDA", "2": "I2C_SCL", "3": "+3V3", "4": "GND" }, "Far corner, away from the warm parts");
add("C5", "C100N", "sensor", { "1": "+3V3", "2": "GND" });
add("R4", "R4K7", "sensor", { "1": "+3V3", "2": "I2C_SDA" });
add("R5", "R4K7", "sensor", { "1": "+3V3", "2": "I2C_SCL" });

// design frame: mm from the board's centre, y down
const placement: Design["placement"] = {};
const at = (ref: string, x: number, y: number, rot = 0) => (placement[ref] = { x, y, rot, side: "top", locked: false });
at("J1", -21.3, 2, 90); at("R1", -15.5, 6.5, 90); at("R2", -14, 6.5, 90);
at("U2", -12, -7); at("C1", -16, -7, 90); at("C2", -8, -7, 90);
at("U1", 13, -11.2); at("C4", 4.6, -8, 90); at("C3", 2.4, 3.6); at("R6", 4.6, -14.5); at("C6", 4.6, -12.2);
at("SW1", -3, 12); at("R3", -10, 14); at("D1", -13, 14);
at("U3", 16, 13); at("C5", 13, 13, 90); at("R4", 8, 11); at("R5", 8, 13.5);

export const SENSOR_BOARD = { width: 50, height: 40, thickness: 1.6 };

export const sensorDesign: Design = Design.parse({
  name: "Room climate sensor",
  revision: "v1",
  summary: "Temperature and humidity in one room, on Wi-Fi, reporting to Home Assistant. Powered from any USB-C charger.",
  stage: "order",
  requirements: [
    { id: "R1", text: "Reads temperature to ±0.2 °C and humidity to ±2 %", check: "sensor choice, heat map", status: "met", note: "The sensor sits 30 mm from the regulator: about 4 °C above the room at full load, which the firmware takes off" },
    { id: "R2", text: "Shows up in Home Assistant over Wi-Fi", check: "firmware pin map", status: "met" },
    { id: "R3", text: "Powered from a USB-C charger or a computer", check: "USB-C CC resistors, power budget", status: "met" },
    { id: "R4", text: "Smaller than a matchbox, fully assembled by JLCPCB", check: "board size, BOM", status: "met" },
  ],
  decisions: [
    { id: "D1", stage: "parts", question: "Which microcontroller?", options: [{ id: "c3", label: "ESP32-C3 module" }, { id: "s3", label: "ESP32-S3 module" }], recommended: "c3", chosen: "c3", why: "Enough for one sensor, USB built in, the cheapest Wi-Fi module JLCPCB stocks.", at: "2026-11-02T10:04:00Z" },
    { id: "D2", stage: "board", question: "How many copper layers?", options: [{ id: "2", label: "2 layers" }, { id: "4", label: "4 layers" }], recommended: "2", chosen: "2", why: "Few parts and slow signals: two layers with a ground pour on the bottom are plenty.", at: "2026-11-02T10:20:00Z" },
  ],
  blocks: {
    power: { name: "Power in", purpose: "USB-C, CC resistors, 3.3 V regulator" },
    logic: { name: "Logic", purpose: "ESP32-C3 module, enable, boot button, status LED" },
    sensor: { name: "Sensor", purpose: "SHT40 on I2C, with its pull-ups, in the coolest corner" },
  },
  parts,
  components: comps,
  nets: {
    GND: { kind: "ground" },
    VBUS: { kind: "power", voltage: 5, current: 0.4, source: "J1" },
    "+3V3": { kind: "power", voltage: 3.3, current: 0.35, source: "U2" },
    USB_DP: { kind: "signal", diff_pair: "USB_DN" },
    USB_DN: { kind: "signal", diff_pair: "USB_DP" },
  },
  board: {
    width: SENSOR_BOARD.width, height: SENSOR_BOARD.height, corner_radius: 2, layers: 2, thickness: 1.6, fab: "jlcpcb", mask_color: "green", finish: "lead-free-hasl",
    holes: [{ x: -21.5, y: -16.5, d: 3.2 }, { x: 21.5, y: 16.5, d: 3.2 }],
    layer_roles: [
      { layer: "F.Cu", role: "mixed" },
      { layer: "B.Cu", role: "plane", net: "GND" },
    ],
    keepouts: [{ rect: [6.4, -20, 19.6, -15], layers: ["F.Cu", "B.Cu"], reason: "Wi-Fi antenna: no copper under it" }],
    silkscreen: { outlines: true, refs: true, texts: [{ text: "Room climate v1", x: -10, y: 18, size: 1.2 }] },
  },
  placement,
  environment: { ambient_min: 0, ambient_max: 50, place: "indoor", enclosed: false },
  firmware: {
    platform: "esphome",
    mcu: "U1",
    pins: [
      { name: "I2C_SDA", gpio: 4, net: "I2C_SDA", dir: "i2c" },
      { name: "I2C_SCL", gpio: 5, net: "I2C_SCL", dir: "i2c" },
      { name: "LED", gpio: 10, net: "LED", dir: "out" },
      { name: "BOOT", gpio: 9, net: "BOOT", dir: "in" },
    ],
    files: {
      "room-climate.yaml": `esphome:
  name: room-climate

esp32:
  board: esp32-c3-devkitm-1

wifi:
  ssid: !secret wifi_ssid
  password: !secret wifi_password

api:        # Home Assistant
ota:
  - platform: esphome

i2c:
  sda: GPIO4
  scl: GPIO5

sensor:
  - platform: sht4x
    temperature:
      name: "Temperature"
    humidity:
      name: "Humidity"
    update_interval: 60s

status_led:
  pin: GPIO10
`,
    },
  },
});
