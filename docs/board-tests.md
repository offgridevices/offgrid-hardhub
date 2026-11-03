# The board tests

Every board HardHub builds goes through these tests before it is ordered: on every build, every hand
edit, and whenever the person or their AI runs them again (at other outside temperatures, say). Each
result says what it found, the number it measured against its limit, where on the board, and how to
fix it. A test that cannot run says why ("not run"); one that does not apply to the board says so.

Made from `engine/hardhub/review/catalog.py`; do not edit by hand.

## Connections (11)

| Test | What it means | How it is tested | Tool |
|---|---|---|---|
| The circuit has parts | There is a circuit to test. Why: every other check passes trivially on an empty design. | Counts the parts in the design. | HardHub rules |
| Every component names a known part | Each part on the drawing points at a real, buyable part. Why: a component without a part has no footprint and cannot be bought. | Looks up each component in the parts list. | HardHub rules |
| No wire that goes to only one pin | Every named connection joins at least two pins. Why: a net on one pin connects nothing: usually a typo in a net name. | Counts the pins on every net of the circuit. | HardHub rules |
| Every pin is on its footprint, every pad is in the design | Each pin of the drawing lands on a real pad of the part, and no pad is forgotten. Why: a wrong or missing pad is a dead board. | Compares the design's pins with each footprint's pads in KiCad's library. | KiCad 10 footprints |
| Every connection is routed | Every wire in the circuit has copper on the board. Why: an unrouted connection is a wire that is not there. | KiCad's design-rule check lists every connection with no copper. | KiCad 10 DRC |
| Copper equals the circuit, pad for pad | The copper connects exactly what the drawing connects, nothing more, nothing less. Why: the board must carry exactly the connections the design has. | Reads every pad's net back from the routed board and compares it with the design. | KiCad 10 board |
| No shorts between different connections | No two different wires touch anywhere in the copper. Why: a short ties two signals (or power to ground) together: the board does not work, or burns. | KiCad's DRC looks for shorting items; HardHub's geometry check tests every pair of copper shapes of different nets for overlap. | KiCad 10 DRC + HardHub geometry (Rust) |
| No loose track ends or useless vias | Every track ends on a pad, a via or another track; every via joins something. Why: a loose end is an antenna and a sign that a connection was meant but not made. | Follows every track end and via on every layer. | HardHub geometry (Rust) |
| No floating copper islands | No patch of copper sits on its own, joined to nothing. Why: floating copper picks up noise and can peel off during manufacturing. | KiCad's DRC reports zone islands left unconnected after the pour. | KiCad 10 DRC |
| Every part is on the board | Every part of the circuit has a place on the board. Why: a part in the circuit but not on the board is missing from the build. | Compares the board's parts with the design. | HardHub rules |
| Every ground or plane pad has its own via | Pads on a ground or power layer drop straight down to it. Why: a short via straight down is the best return path; the rest are routed. | Counts the vias placed beside plane pads. | HardHub rules |

## Copper and tracks (10)

| Test | What it means | How it is tested | Tool |
|---|---|---|---|
| Narrowest track is within what the fab can make | Every track is at least as wide as the factory can reliably etch. Why: a track thinner than the fab can make comes out broken or costs extra. | Measures the width of every track on every layer. Rule: JLCPCB capabilities (2026). | HardHub geometry (Rust) |
| Gaps between copper are wide enough | Copper of different connections never comes closer than the factory can keep apart. Why: a gap the fab cannot etch closes up into a short. | Measures the narrowest gap between every pair of copper shapes of different nets, layer by layer; KiCad's DRC checks the same against the rules. Rule: JLCPCB capabilities (2026). | HardHub geometry (Rust) + KiCad 10 DRC |
| Copper keeps away from the board edge | No copper comes too close to where the board is cut out. Why: the cutter can expose or tear copper at the edge, shorting layers together. | Measures the distance from every copper shape to the board outline. Rule: JLCPCB capabilities (2026). | HardHub geometry (Rust) |
| No sharp corners in the tracks | Tracks turn in 45° steps, never in a right angle or tighter. Why: house rule: sharp corners trap etching acid and look untidy; at very high speeds they also reflect signals. | Finds every place two tracks of one connection meet and measures the turn. | HardHub geometry (Rust) |
| No narrow wedges where tracks meet | Where tracks join, the angle between them is never tighter than a right angle. Why: a narrow wedge traps etching acid, which keeps eating the copper and can cut the track later. | Measures the inside angle at every track junction, T-junctions included. | HardHub geometry (Rust) |
| Tracks wide enough for their current | Tracks that carry power are wide enough for the current through them. Why: a track too narrow for its current runs hot. | Compares each power track with the IPC-2221 width for its current at a 10 °C rise. Rule: IPC-2221. | HardHub rules |
| Tracks at the width their net asks for | Tracks are as wide as the design says they should be. Why: the design gave these nets a width. | Compares each track of a net with its width. | HardHub rules |
| Power tracks stay cool on the hottest day | Even on the hottest day you set, the busiest power track stays well below what the board material can take. Why: hot copper ages the board and can lift tracks; FR4 softens around 130 °C. | Solves the current through every track of each power net (Rust resistor network), then the temperature rise of the busiest track from the IPC-2221 formula, added to the hottest outside temperature. Rule: IPC-2221. | HardHub solver (Rust) |
| Copper spread evenly between layers | Top and bottom have similar amounts of copper. Why: a board with much more copper on one side bows when it is soldered. | Measures the share of each layer covered by copper. | HardHub geometry (Rust) |
| Pads in a copper pour have thermal spokes | Pads joined to a large copper area are connected by thin spokes. Why: a pad sunk in solid copper soaks up the heat and does not solder well. | KiCad's DRC checks each pad's thermal spokes. | KiCad 10 DRC |

## Holes and vias (9)

| Test | What it means | How it is tested | Tool |
|---|---|---|---|
| Vias big enough for the fab | Every via (a small plated hole joining layers) is at least the size the factory makes. Why: a via too small costs extra or comes out without copper inside. | Measures every via's copper ring and hole. Rule: JLCPCB capabilities (2026). | HardHub geometry (Rust) |
| Smallest hole is one the fab can drill | No hole is smaller than the factory's smallest drill. Why: a hole under the minimum costs extra or is refused. | Measures every drilled hole. Rule: JLCPCB capabilities (2026). | HardHub geometry (Rust) |
| Copper rings around holes are wide enough | Each hole has enough copper around it to survive a slightly off-centre drill. Why: a drill that wanders breaks out of a thin ring and the connection opens. | Measures (copper diameter - hole) / 2 for every via and plated pad. Rule: JLCPCB capabilities (2026). | HardHub geometry (Rust) |
| Holes are far enough apart | No two holes are so close that the board between them cracks. Why: holes too close together crack the board or merge. | Measures the gap between every pair of holes. Rule: JLCPCB capabilities (2026). | HardHub geometry (Rust) |
| Holes keep away from other copper | Drilled holes keep a safe distance from tracks of other connections. Why: a drill that wanders can touch a nearby track and short it. | KiCad's DRC checks hole-to-copper distances. Rule: JLCPCB capabilities (2026). | KiCad 10 DRC |
| Holes not too deep for their width | The board is not too thick for its smallest hole to be plated inside. Why: plating cannot reach into a hole that is long and thin. | Divides the board thickness by the smallest drill. Rule: JLCPCB capabilities (2026). | HardHub rules |
| No vias in pads | Vias are beside pads, not inside them. Why: a via in a pad wicks solder away unless the fab fills and caps it. | Looks for vias inside pads. | HardHub rules |
| Vias carry their current comfortably | Where power changes layers, the vias are enough for the current. Why: a single small via carrying too much current heats up and can open. | Solves the current through every via of each power net (Rust resistor network) and compares the busiest with its IPC-2221 capacity. Rule: IPC-2221. | HardHub solver (Rust) |
| Mounting holes have room for the screw | There is free space around each mounting hole for a screw head and washer. Why: a screw head on a track can short it or crush it. | Measures from each mounting hole to the nearest copper of another net. | HardHub geometry (Rust) |

## Printed labels (6)

| Test | What it means | How it is tested | Tool |
|---|---|---|---|
| Labels fit without covering pads | Part names and the board's own text fit on the board, clear of pads and parts. Why: printing on a pad stops it soldering; text that does not fit is dropped. | Places every label clear of pads, parts and the edge, and lists what did not fit. | HardHub rules |
| Printed lines thick enough to print | Every printed line is thick enough for the factory's printer. Why: thinner lines vanish or smear. | Measures the stroke of every silkscreen line and letter. Rule: JLCPCB capabilities (2026). | HardHub geometry (Rust) |
| Printed text tall enough to read | Every printed word is tall enough to read on the finished board. Why: small text prints as a blur. | Measures the height of every text on the silkscreen. Rule: JLCPCB capabilities (2026). | HardHub geometry (Rust) |
| No printing on pads | The white printing never lands on a pad that gets soldered. Why: ink on a pad stops solder wetting it. | Tests every silkscreen line against every solder mask opening. | HardHub geometry (Rust) + KiCad 10 DRC |
| No printing past the board edge | All printing sits on the board. Why: printing past the edge is cut off. | KiCad's DRC checks silkscreen against the outline. | KiCad 10 DRC |
| Parts that only fit one way show which way | Diodes, LEDs and chips have a mark showing which way round they go. Why: a part fitted backwards can be destroyed at power-on; marks let a person check by eye. | Looks for polarised parts and whether outlines with pin-1 marks are printed. | HardHub rules |

## Solder mask and paste (1)

| Test | What it means | How it is tested | Tool |
|---|---|---|---|
| Solder mask between close pads | Between neighbouring pads there is a strip of solder mask (the coloured coating) wide enough to stay on. Why: without that strip, solder can run between pads and bridge them. | Measures the gap between every pair of solder mask openings. Rule: JLCPCB capabilities (2026). | HardHub geometry (Rust) + KiCad 10 DRC |

## Parts and assembly (7)

| Test | What it means | How it is tested | Tool |
|---|---|---|---|
| Parts do not overlap | Each part has its own space, with room for the machine that places it. Why: overlapping parts cannot both be placed or soldered. | Tests every part's keep-clear outline (courtyard) against the others. | HardHub geometry (Rust) + KiCad 10 DRC |
| Parts are not too close to the edge | Parts (other than connectors) keep a little distance from the board edge. Why: parts at the edge get knocked off when boards are separated from the panel. | Measures each part's outline to the board edge. Rule: JLCPCB capabilities (2026). | HardHub geometry (Rust) |
| Connectors sit at the board edge | Plugs and sockets are at the edge, where a cable can reach them. Why: a socket in the middle of the board cannot take its plug. | Measures each connector to the nearest edge. | HardHub rules |
| Decoupling capacitors sit next to their chip | The small capacitor that steadies each chip's power is right beside the chip's power pin. Why: far away, the capacitor cannot supply the chip's fast current spikes, and the supply rings. | Measures from each chip's power pins to the nearest capacitor on the same supply. | HardHub rules |
| Crystals sit next to their chip | A crystal (the clock) is close to the chip it drives. Why: long clock tracks pick up noise and may not start. | Measures from each crystal to the nearest chip it connects to. | HardHub rules |
| Nothing under or in front of the antenna | The radio module's antenna has no copper or parts under it and faces off the board. Why: copper near the antenna detunes it: Wi-Fi range drops a lot. | KiCad's DRC checks the module's keep-out area; HardHub checks the antenna sits at the board edge. | KiCad 10 DRC |
| Parts on one side only | All assembled parts are on the top. Why: parts on both sides cost a second assembly pass. | Counts assembled parts on each side. | HardHub rules |

## Power (12)

| Test | What it means | How it is tested | Tool |
|---|---|---|---|
| Every power net states its current | Each supply says how much current it carries. Why: track widths are sized from the current; a guess makes hot tracks. | Reads the current of every power net in the design. | HardHub rules |
| Every supply can deliver what it feeds | Each regulator, connector or battery can supply all the current its loads draw. Why: an overloaded supply sags, resets the board, or overheats. | Builds the board's power tree (which supply feeds which), adds up the current each one delivers, and compares it with its rating. | HardHub rules |
| Regulators get enough input voltage | Each regulator's input is high enough above its output for it to work. Why: below its dropout a regulator cannot hold its output and the board browns out. | Compares each regulator's input minus output with its dropout voltage. | HardHub rules |
| Regulator inputs within their rating | No regulator sees more input voltage than it is built for. Why: over its maximum input a regulator fails, often shorted. | Compares each regulator's input net voltage with its maximum. | HardHub rules |
| Little voltage lost in the copper | The copper between each supply and its loads loses only a little voltage. Why: a long thin supply track drops voltage under load, so chips see less than they need. | Solves each power net as a resistor network from the real copper (tracks, pours, vias) with the load current at the hottest outside temperature. | HardHub solver (Rust) |
| Every chip has a decoupling capacitor | Each chip has a small capacitor between its supply and ground. Why: without one, the chip's own switching makes its supply noisy and it misbehaves. | Looks for a capacitor between each chip's power net and ground. | HardHub rules |
| Regulators have input and output capacitors | Each regulator has capacitors on its input and output, as its datasheet asks. Why: without them many regulators oscillate or let the output sag. | Looks for capacitors on each regulator's input and output nets. | HardHub rules |
| Supplies stay steady across frequencies | Each supply's capacitors keep its impedance low from slow changes up to fast spikes. Why: a supply with a high-impedance gap rings at that frequency when the load changes. | Simulates each supply rail (regulator output, capacitors with their ESR and ESL by size, DC-bias derated) in ngspice from 1 kHz to 100 MHz and compares with the target impedance. | ngspice |
| Supplies hold up when the load jumps | When the board suddenly draws more current (a radio transmitting), the supply stays within 5 %. Why: a supply that dips too far resets the chip or corrupts a reading. | Simulates a load step from 10 % to 100 % of each rail's current in ngspice and measures the lowest voltage. | ngspice |
| Power input is protected | The power coming in from outside passes a fuse or protection part first. Why: a short or a wrong adapter otherwise goes straight into the board. | Looks for a fuse, polyfuse, TVS or diode on each power input. | HardHub rules |
| USB-C power input has its CC resistors | A USB-C socket used for power has a 5.1 kΩ resistor from each CC pin to ground. Why: without them, USB-C chargers and laptops give the board no power at all. | Follows the CC1 and CC2 pins of each USB-C socket to their resistors. Rule: USB Type-C spec, Rd = 5.1 kΩ. | HardHub rules |
| Supply transients and regulator stability simulated | Supply behaviour under load has been simulated. Why: a supply that rings or sags resets the board under load. | Runs the supply simulations. | ngspice |

## Heat (5)

| Test | What it means | How it is tested | Tool |
|---|---|---|---|
| Every part stays inside its temperature rating on the hottest day | With the board working flat out on the hottest day you set, no part gets hotter than it is rated for. Why: a part past its rating fails early or shuts down. | Solves the heat in the whole board (Rust): each part's heat (regulator losses, resistors, chips), the copper's own heating, spreading through the copper layers, and cooling to the air by convection and radiation. | HardHub solver (Rust) |
| Chips' insides stay in range | The silicon inside each hot chip stays below its maximum. Why: the inside of a chip is hotter than its case; past about 125 °C it shuts down or fails. | Adds each chip's junction-to-board rise (its power times θJB from the datasheet) to the board temperature under it. | HardHub solver (Rust) |
| The board itself stays below 105 °C | No spot of the board gets hotter than the board material is happy with. Why: FR4 softens around 130 °C; staying under 105 °C keeps it stiff and long-lived. | Finds the hottest spot of the heat map at the hottest outside temperature. | HardHub solver (Rust) |
| Every part is rated for the coldest day | Each part works at the coldest outside temperature you set. Why: below their rating, some parts (LCDs, batteries, cheap chips) stop working. | Compares each part's lowest rated temperature with the coldest outside temperature. | HardHub rules |
| Heat simulated on the routed board at worst-case load | The board's heat has been simulated. Why: the routed board runs hotter than the same design before routing. | Runs the heat solver. | HardHub solver (Rust) |

## Part ratings (7)

| Test | What it means | How it is tested | Tool |
|---|---|---|---|
| Capacitors rated well above their voltage | Every capacitor is rated for clearly more voltage than it sees. Why: a capacitor near its rated voltage ages fast; tantalums short when overstressed. | Compares the voltage across each capacitor (from the circuit simulation) with its rating: at most 80 % for ceramics, 50 % for tantalum. Rule: common derating practice (NASA EEE-INST-002, makers' guides). | ngspice |
| Ceramic capacitors keep enough of their value | Small ceramic capacitors lose capacitance at voltage and temperature; each one keeps enough. Why: a 10 µF X5R capacitor in a small case can be 3 µF at its working voltage, too little to steady the supply. | Estimates each X5R/X7R capacitor's real value at its voltage and the hottest and coldest temperature. Rule: makers' DC-bias curves (typical). | HardHub rules |
| Resistors run below their power rating | No resistor heats up more than its size can take, even on the hottest day. Why: an overloaded resistor drifts, discolours the board, and can open. | Simulates the circuit's operating point in ngspice (pins idle, driven low, driven high) at each temperature, and compares each resistor's power with its rating, reduced above 70 °C. Rule: resistor derating curve (IEC 60115). | ngspice |
| LEDs run below their current rating | Each LED gets a safe current through its resistor. Why: too much current burns an LED out or dims it fast. | Simulates each LED with its series resistor in ngspice and compares the current with the LED's rating. | ngspice |
| Chips' supplies within their maximum | No chip is powered from more voltage than it can take. Why: over its absolute maximum a chip is damaged. | Compares each chip's supply net voltage with its maximum. | HardHub rules |
| Connectors rated for their current | Each connector carries no more current than its pins are rated for. Why: overloaded connector pins heat up and melt. | Compares each power net's current through a connector with the connector's rating. | HardHub rules |
| Voltage dividers stay in range across tolerances | Resistor dividers (feedback, battery sensing) give the right voltage even with 1 % parts at the hot and cold extremes. Why: a feedback divider off by a few percent sets the wrong supply voltage. | Simulates each divider at the worst corners of tolerance and temperature in ngspice. | ngspice |

## Signals (5)

| Test | What it means | How it is tested | Tool |
|---|---|---|---|
| Signals have unbroken ground under them | Every signal track on an outer layer runs over solid ground (or power) copper on the next layer. Why: the return current flows under its signal; a gap forces a detour that radiates noise and picks it up. | Samples every signal track every 0.1 mm and looks for ground or power copper directly beneath it. | HardHub geometry (Rust) |
| USB data pair is matched | The two USB data tracks are the same length and the right width for 90 Ω. Why: unequal or wrong-impedance USB lines cause dropped connections. | Measures both tracks' lengths and estimates their impedance from width, gap and layer height (IPC-2141 formulas). Rule: USB 2.0 spec, IPC-2141. | HardHub geometry (Rust) |
| I2C lines have pull-up resistors | The two I2C wires (SDA, SCL) each have a resistor to the supply. Why: I2C cannot pull its lines high by itself: without pull-ups it does not work at all. | Looks for a resistor from each I2C line to a supply. | HardHub rules |
| Enable and reset pins are not left floating | Pins that start or reset a chip are tied to a defined level by a resistor. Why: a floating enable or reset pin makes the board start randomly or not at all. | Looks for a pull resistor on every enable and reset net. | HardHub rules |
| High voltages keep wide enough gaps | Copper at high voltage keeps the distance the safety standard asks from everything else. Why: too small a gap at high voltage arcs over, a fire and shock risk. | Measures the narrowest gap between each high-voltage net and every other net and compares with IPC-2221B. Rule: IPC-2221B table 6-1. | HardHub geometry (Rust) |

## Firmware (3)

| Test | What it means | How it is tested | Tool |
|---|---|---|---|
| Strapping pins checked | Pins that set how the chip starts are not pulled the wrong way. Why: a strapping pin pulled the wrong way at power-up stops the chip booting. | Compares the ESP32 module's strapping pins with what is wired to them. Rule: Espressif module datasheet. | HardHub rules |
| Analogue inputs on ADC1 | Analogue readings use pins that work while Wi-Fi is on. Why: ADC2 stops working while Wi-Fi is on. | Looks up each analogue pin's ADC unit. Rule: Espressif module datasheet. | HardHub rules |
| Firmware pin map matches the circuit | The firmware uses the pins the circuit actually wires. Why: a pin mismatch is a port that never switches or a reading of the wrong sensor. | Compares the firmware's pin map with the ESP32 module's pins in the circuit. | HardHub rules |

## Buying the parts (8)

| Test | What it means | How it is tested | Tool |
|---|---|---|---|
| Every assembled part has an LCSC number | Every part the factory fits has its catalogue number. Why: the assembly house buys and places parts by this number. | Checks each assembled part for an LCSC number. | HardHub rules |
| Every assembled part is in stock at the assembler | Every part is in stock right now. Why: an out-of-stock part holds the whole order. | Reads the stock from the catalogue. | HardHub rules |
| Enough stock for 100 boards | There is enough stock of each part to build 100 boards. Why: a part with a handful left runs out before your order is made. | Compares each part's stock with the number per board times 100. | HardHub rules |
| No end-of-life parts | No part has been discontinued. Why: an end-of-life part stops being made: the board cannot be built again. | Reads each part's lifecycle status. | HardHub rules |
| No parts marked not for new designs | No part is one the maker says not to start new designs with. Why: the maker has said not to start new designs with these. | Reads each part's lifecycle status. | HardHub rules |
| Few parts with an extra loading fee | Most parts are the assembler's "basic" parts, which cost nothing extra to load. Why: each "extended" part type adds about $3 to every order. | Counts the parts in JLCPCB's extended library. | HardHub rules |
| Every part has a datasheet | Each part links to its datasheet. Why: the datasheet is where every rating used in these tests comes from. | Checks each part for a datasheet link. | HardHub rules |
| Part ratings come from datasheets | The temperature, voltage and power limits used in these tests were read from datasheets, not assumed. Why: an assumed rating can be wrong: the tests are only as good as the numbers behind them. | Lists parts whose ratings were filled in from typical values. | HardHub rules |

## Manufacturing (6)

| Test | What it means | How it is tested | Tool |
|---|---|---|---|
| Design rules with the fab's own limits: 0 errors | KiCad's own full design-rule check, set to the factory's limits, finds nothing wrong. Why: the fab rejects or mis-builds what breaks its rules. | Runs KiCad's DRC with JLCPCB's limits as the rules. Rule: JLCPCB capabilities (2026). | KiCad 10 DRC |
| Design rules: 0 warnings | No rule is even bent. Why: a warning is a rule bent; HardHub ships boards with none. | Runs KiCad's DRC. | KiCad 10 DRC |
| Board size within what the fab makes | The board is not too small or too big for the factory and its assembly line. Why: a board under the minimum needs a panel; over the maximum it cannot be made. | Compares the board size with the fab's limits. Rule: JLCPCB capabilities (2026). | HardHub rules |
| A standard layer stack | The number of copper layers and the board thickness are a build the factory offers as standard. Why: a non-standard stack costs more and takes longer. | Compares the layer count, thickness and copper weights with the fab's standard builds. Rule: JLCPCB capabilities (2026). | HardHub rules |
| Board outline is one closed shape | The board's edge is a single closed line. Why: an open or doubled outline cannot be cut. | KiCad's DRC checks the outline. | KiCad 10 DRC |
| Parts list and placement file list exactly the assembled parts | The two files the assembler uses agree with the board, part for part. Why: nothing missing or extra on the assembly line. | Compares the BOM and placement file with the board. | HardHub rules |

