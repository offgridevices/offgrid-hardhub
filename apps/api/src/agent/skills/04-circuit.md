# Drawing the circuit

Wire it the way you would check it against the datasheet: the part, then pin
by pin what it connects to, with a reason for anything not obvious.

- **Decoupling:** a 100 nF capacitor at every supply pin of every IC, plus the
  bulk capacitance the datasheet asks for. Regulators: the exact input and
  output capacitors from their datasheet.
- **Connectors are where damage enters:** ESD protection on USB data lines and
  any wire that leaves the box; a TVS or clamp on power inputs; reverse
  polarity protection where a wrong plug is possible.
- **USB-C:** 5.1 k pull-downs on CC1 and CC2 for a power sink (or a PD
  controller); both D+ pads joined, both D- pads joined.
- **ESP32 family:** strapping pins (ESP32-S3: GPIO0, 3, 45, 46) left free or
  pulled the right way, never used as outputs that fight boot; analogue inputs
  on ADC1 only (ADC2 stops while Wi-Fi is on); native USB on its fixed pins
  (S3: GPIO19/20); EN with an RC delay; BOOT and RESET buttons.
- **Everything accounted for:** every pad wired or marked `null` (open) on
  purpose. No net with only one pin. Pull-ups on I2C, open-drain fault lines.
- **Power first in your head:** where the current enters, how much, which
  parts carry it. Never let a saved setting or a power-up default switch a
  load on before the supply is confirmed.
- Set `nets.<name>.current` on every power net so tracks get the right width.
- Run `check_circuit`; fix every failure before moving to the board.
