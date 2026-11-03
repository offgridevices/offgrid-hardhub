# SPDX-License-Identifier: AGPL-3.0-or-later
"""Every test a board goes through before it is ordered, in one list.

The checklist an experienced electrical engineer works through on screen
before sending a board to the fab: connections, copper, holes, printing,
solder mask, assembly, power, heat, part ratings, signals, firmware, buying
the parts, manufacturing.  Each entry says, for someone who has never made a
board, what is tested (`plain`), why it matters (`why`), how it is tested
(`how`, `tool`) and where the rule comes from (`source`).  The code that
runs a test only adds the result: status, the measured number against its
limit, where on the board, and what to change.

    catalog.result('track-min', 'pass', measured=measure('narrowest track', 0.15, 'mm', 0.127, '>='))

A check that cannot run says so ("skip", with why); one that does not apply
to this board says that ("na").  Neither passes quietly.
"""

KICAD = 'KiCad 10 DRC'
RULES = 'HardHub rules'
SIM = 'HardHub solver (Rust)'
SPICE = 'ngspice'
GEOM = 'HardHub geometry (Rust)'
JLC = 'JLCPCB capabilities (2026)'

# group -> label, in display order (the web app keeps the same order and icons)
AREAS = [
    ('connections', 'Connections'),
    ('copper', 'Copper and tracks'),
    ('holes', 'Holes and vias'),
    ('silkscreen', 'Printed labels'),
    ('mask', 'Solder mask and paste'),
    ('placement', 'Parts and assembly'),
    ('power', 'Power'),
    ('thermal', 'Heat'),
    ('stress', 'Part ratings'),
    ('signals', 'Signals'),
    ('firmware', 'Firmware'),
    ('sourcing', 'Buying the parts'),
    ('fab', 'Manufacturing'),
]


def _c(id, group, name, plain, why, how, tool=RULES, source=None):
    return dict(id=id, group=group, name=name, plain=plain, why=why, how=how, tool=tool,
                **({'source': source} if source else {}))


CHECKS = [
    # ------------------------------------------------------------ connections
    _c('has-circuit', 'connections', 'The circuit has parts',
       'There is a circuit to test.', 'every other check passes trivially on an empty design',
       'Counts the parts in the design.'),
    _c('parts-exist', 'connections', 'Every component names a known part',
       'Each part on the drawing points at a real, buyable part.',
       'a component without a part has no footprint and cannot be bought',
       'Looks up each component in the parts list.'),
    _c('single-pin-nets', 'connections', 'No wire that goes to only one pin',
       'Every named connection joins at least two pins.',
       'a net on one pin connects nothing: usually a typo in a net name',
       'Counts the pins on every net of the circuit.'),
    _c('pins-pads', 'connections', 'Every pin is on its footprint, every pad is in the design',
       'Each pin of the drawing lands on a real pad of the part, and no pad is forgotten.',
       'a wrong or missing pad is a dead board', "Compares the design's pins with each footprint's pads in KiCad's library.",
       tool='KiCad 10 footprints'),
    _c('routed', 'connections', 'Every connection is routed',
       'Every wire in the circuit has copper on the board.', 'an unrouted connection is a wire that is not there',
       "KiCad's design-rule check lists every connection with no copper.", tool=KICAD),
    _c('nets-match', 'connections', 'Copper equals the circuit, pad for pad',
       'The copper connects exactly what the drawing connects, nothing more, nothing less.',
       'the board must carry exactly the connections the design has',
       "Reads every pad's net back from the routed board and compares it with the design.", tool='KiCad 10 board'),
    _c('shorts', 'connections', 'No shorts between different connections',
       'No two different wires touch anywhere in the copper.',
       'a short ties two signals (or power to ground) together: the board does not work, or burns',
       "KiCad's DRC looks for shorting items; HardHub's geometry check tests every pair of copper shapes of different nets for overlap.",
       tool=KICAD + ' + ' + GEOM),
    _c('dangling', 'connections', 'No loose track ends or useless vias',
       'Every track ends on a pad, a via or another track; every via joins something.',
       'a loose end is an antenna and a sign that a connection was meant but not made',
       'Follows every track end and via on every layer.', tool=GEOM),
    _c('isolated-copper', 'connections', 'No floating copper islands',
       'No patch of copper sits on its own, joined to nothing.',
       'floating copper picks up noise and can peel off during manufacturing',
       "KiCad's DRC reports zone islands left unconnected after the pour.", tool=KICAD),
    _c('parts-placed', 'connections', 'Every part is on the board',
       'Every part of the circuit has a place on the board.',
       'a part in the circuit but not on the board is missing from the build', 'Compares the board\'s parts with the design.'),
    _c('fanout', 'connections', 'Every ground or plane pad has its own via',
       'Pads on a ground or power layer drop straight down to it.',
       'a short via straight down is the best return path; the rest are routed', 'Counts the vias placed beside plane pads.'),

    # ------------------------------------------------------------ copper
    _c('track-min', 'copper', 'Narrowest track is within what the fab can make',
       'Every track is at least as wide as the factory can reliably etch.',
       'a track thinner than the fab can make comes out broken or costs extra',
       'Measures the width of every track on every layer.', tool=GEOM, source=JLC),
    _c('clearance-min', 'copper', 'Gaps between copper are wide enough',
       'Copper of different connections never comes closer than the factory can keep apart.',
       'a gap the fab cannot etch closes up into a short',
       'Measures the narrowest gap between every pair of copper shapes of different nets, layer by layer; KiCad\'s DRC checks the same against the rules.',
       tool=GEOM + ' + ' + KICAD, source=JLC),
    _c('edge-clearance', 'copper', 'Copper keeps away from the board edge',
       'No copper comes too close to where the board is cut out.',
       'the cutter can expose or tear copper at the edge, shorting layers together',
       'Measures the distance from every copper shape to the board outline.', tool=GEOM, source=JLC),
    _c('corners-45', 'copper', 'No sharp corners in the tracks',
       'Tracks turn in 45° steps, never in a right angle or tighter.',
       "house rule: sharp corners trap etching acid and look untidy; at very high speeds they also reflect signals",
       'Finds every place two tracks of one connection meet and measures the turn.', tool=GEOM),
    _c('acid-traps', 'copper', 'No narrow wedges where tracks meet',
       'Where tracks join, the angle between them is never tighter than a right angle.',
       'a narrow wedge traps etching acid, which keeps eating the copper and can cut the track later',
       'Measures the inside angle at every track junction, T-junctions included.', tool=GEOM),
    _c('current-width', 'copper', 'Tracks wide enough for their current',
       'Tracks that carry power are wide enough for the current through them.',
       'a track too narrow for its current runs hot',
       'Compares each power track with the IPC-2221 width for its current at a 10 °C rise.', source='IPC-2221'),
    _c('net-width', 'copper', 'Tracks at the width their net asks for',
       'Tracks are as wide as the design says they should be.', 'the design gave these nets a width',
       'Compares each track of a net with its width.'),
    _c('track-heating', 'copper', 'Power tracks stay cool on the hottest day',
       'Even on the hottest day you set, the busiest power track stays well below what the board material can take.',
       'hot copper ages the board and can lift tracks; FR4 softens around 130 °C',
       'Solves the current through every track of each power net (Rust resistor network), then the temperature rise of the narrowest, busiest track (IPC-2152 style), added to the hottest outside temperature.',
       tool=SIM, source='IPC-2152'),
    _c('copper-balance', 'copper', 'Copper spread evenly between layers',
       'Top and bottom have similar amounts of copper.',
       'a board with much more copper on one side bows when it is soldered',
       'Measures the share of each layer covered by copper.', tool=GEOM),
    _c('thermal-relief', 'copper', 'Pads in a copper pour have thermal spokes',
       'Pads joined to a large copper area are connected by thin spokes.',
       'a pad sunk in solid copper soaks up the heat and does not solder well',
       "KiCad's DRC checks each pad's thermal spokes.", tool=KICAD),

    # ------------------------------------------------------------ holes and vias
    _c('via-size', 'holes', 'Vias big enough for the fab',
       'Every via (a small plated hole joining layers) is at least the size the factory makes.',
       'a via too small costs extra or comes out without copper inside', 'Measures every via\'s copper ring and hole.',
       tool=GEOM, source=JLC),
    _c('drill-min', 'holes', 'Smallest hole is one the fab can drill',
       'No hole is smaller than the factory\'s smallest drill.', 'a hole under the minimum costs extra or is refused',
       'Measures every drilled hole.', tool=GEOM, source=JLC),
    _c('annular-ring', 'holes', 'Copper rings around holes are wide enough',
       'Each hole has enough copper around it to survive a slightly off-centre drill.',
       'a drill that wanders breaks out of a thin ring and the connection opens',
       'Measures (copper diameter - hole) / 2 for every via and plated pad.', tool=GEOM, source=JLC),
    _c('hole-to-hole', 'holes', 'Holes are far enough apart',
       'No two holes are so close that the board between them cracks.',
       'holes too close together crack the board or merge', 'Measures the gap between every pair of holes.',
       tool=GEOM, source=JLC),
    _c('hole-clearance', 'holes', 'Holes keep away from other copper',
       'Drilled holes keep a safe distance from tracks of other connections.',
       'a drill that wanders can touch a nearby track and short it', "KiCad's DRC checks hole-to-copper distances.",
       tool=KICAD, source=JLC),
    _c('aspect-ratio', 'holes', 'Holes not too deep for their width',
       'The board is not too thick for its smallest hole to be plated inside.',
       'plating cannot reach into a hole that is long and thin', 'Divides the board thickness by the smallest drill.',
       source=JLC),
    _c('via-in-pad', 'holes', 'No vias in pads',
       'Vias are beside pads, not inside them.',
       'a via in a pad wicks solder away unless the fab fills and caps it', 'Looks for vias inside pads.'),
    _c('via-current', 'holes', 'Vias carry their current comfortably',
       'Where power changes layers, the vias are enough for the current.',
       'a single small via carrying too much current heats up and can open',
       'Solves the current through every via of each power net (Rust resistor network) and compares the busiest with its IPC-2221 capacity.',
       tool=SIM, source='IPC-2221'),
    _c('mounting-holes', 'holes', 'Mounting holes have room for the screw',
       'There is free space around each mounting hole for a screw head and washer.',
       'a screw head on a track can short it or crush it', 'Measures from each mounting hole to the nearest copper of another net.',
       tool=GEOM),

    # ------------------------------------------------------------ silkscreen
    _c('silkscreen', 'silkscreen', 'Labels fit without covering pads',
       'Part names and the board\'s own text fit on the board, clear of pads and parts.',
       'printing on a pad stops it soldering; text that does not fit is dropped',
       'Places every label clear of pads, parts and the edge, and lists what did not fit.'),
    _c('silk-width', 'silkscreen', 'Printed lines thick enough to print',
       'Every printed line is thick enough for the factory\'s printer.',
       'thinner lines vanish or smear', 'Measures the stroke of every silkscreen line and letter.', tool=GEOM, source=JLC),
    _c('silk-height', 'silkscreen', 'Printed text tall enough to read',
       'Every printed word is tall enough to read on the finished board.',
       'small text prints as a blur', 'Measures the height of every text on the silkscreen.', tool=GEOM, source=JLC),
    _c('silk-on-pads', 'silkscreen', 'No printing on pads',
       'The white printing never lands on a pad that gets soldered.',
       'ink on a pad stops solder wetting it', 'Tests every silkscreen line against every solder mask opening.',
       tool=GEOM + ' + ' + KICAD),
    _c('silk-off-board', 'silkscreen', 'No printing past the board edge',
       'All printing sits on the board.', 'printing past the edge is cut off', "KiCad's DRC checks silkscreen against the outline.",
       tool=KICAD),
    _c('polarity-marks', 'silkscreen', 'Parts that only fit one way show which way',
       'Diodes, LEDs and chips have a mark showing which way round they go.',
       'a part fitted backwards can be destroyed at power-on; marks let a person check by eye',
       'Looks for polarised parts and whether outlines with pin-1 marks are printed.'),

    # ------------------------------------------------------------ mask and paste
    _c('mask-web', 'mask', 'Solder mask between close pads',
       'Between neighbouring pads there is a strip of solder mask (the coloured coating) wide enough to stay on.',
       'without that strip, solder can run between pads and bridge them',
       'Measures the gap between every pair of solder mask openings.', tool=GEOM + ' + ' + KICAD, source=JLC),

    # ------------------------------------------------------------ placement
    _c('courtyard', 'placement', 'Parts do not overlap',
       'Each part has its own space, with room for the machine that places it.',
       'overlapping parts cannot both be placed or soldered', "Tests every part's keep-clear outline (courtyard) against the others.",
       tool=GEOM + ' + ' + KICAD),
    _c('part-edge', 'placement', 'Parts are not too close to the edge',
       'Parts (other than connectors) keep a little distance from the board edge.',
       'parts at the edge get knocked off when boards are separated from the panel',
       'Measures each part\'s outline to the board edge.', tool=GEOM, source=JLC),
    _c('connectors-edge', 'placement', 'Connectors sit at the board edge',
       'Plugs and sockets are at the edge, where a cable can reach them.',
       'a socket in the middle of the board cannot take its plug', 'Measures each connector to the nearest edge.'),
    _c('decoupling-near', 'placement', 'Decoupling capacitors sit next to their chip',
       'The small capacitor that steadies each chip\'s power is right beside the chip\'s power pin.',
       'far away, the capacitor cannot supply the chip\'s fast current spikes, and the supply rings',
       'Measures from each chip\'s power pins to the nearest capacitor on the same supply.'),
    _c('crystal-near', 'placement', 'Crystals sit next to their chip',
       'A crystal (the clock) is close to the chip it drives.', 'long clock tracks pick up noise and may not start',
       'Measures from each crystal to the nearest chip it connects to.'),
    _c('antenna-keepout', 'placement', 'Nothing under or in front of the antenna',
       'The radio module\'s antenna has no copper or parts under it and faces off the board.',
       'copper near the antenna detunes it: Wi-Fi range drops a lot',
       "KiCad's DRC checks the module's keep-out area; HardHub checks the antenna sits at the board edge.", tool=KICAD),
    _c('two-sided', 'placement', 'Parts on one side only',
       'All assembled parts are on the top.', 'parts on both sides cost a second assembly pass',
       'Counts assembled parts on each side.'),

    # ------------------------------------------------------------ power
    _c('power-current', 'power', 'Every power net states its current',
       'Each supply says how much current it carries.', 'track widths are sized from the current; a guess makes hot tracks',
       'Reads the current of every power net in the design.'),
    _c('power-budget', 'power', 'Every supply can deliver what it feeds',
       'Each regulator, connector or battery can supply all the current its loads draw.',
       'an overloaded supply sags, resets the board, or overheats',
       'Builds the board\'s power tree (which supply feeds which), adds up the current each one delivers, and compares it with its rating.'),
    _c('regulator-headroom', 'power', 'Regulators get enough input voltage',
       'Each regulator\'s input is high enough above its output for it to work.',
       'below its dropout a regulator cannot hold its output and the board browns out',
       'Compares each regulator\'s input minus output with its dropout voltage.'),
    _c('regulator-input', 'power', 'Regulator inputs within their rating',
       'No regulator sees more input voltage than it is built for.', 'over its maximum input a regulator fails, often shorted',
       "Compares each regulator's input net voltage with its maximum."),
    _c('voltage-drop', 'power', 'Little voltage lost in the copper',
       'The copper between each supply and its loads loses only a little voltage.',
       'a long thin supply track drops voltage under load, so chips see less than they need',
       'Solves each power net as a resistor network from the real copper (tracks, pours, vias) with the load current at the hottest outside temperature.',
       tool=SIM),
    _c('decoupling', 'power', 'Every chip has a decoupling capacitor',
       'Each chip has a small capacitor between its supply and ground.',
       'without one, the chip\'s own switching makes its supply noisy and it misbehaves',
       'Looks for a capacitor between each chip\'s power net and ground.'),
    _c('bulk-caps', 'power', 'Regulators have input and output capacitors',
       'Each regulator has capacitors on its input and output, as its datasheet asks.',
       'without them many regulators oscillate or let the output sag', 'Looks for capacitors on each regulator\'s input and output nets.'),
    _c('pdn', 'power', 'Supplies stay steady across frequencies',
       'Each supply\'s capacitors keep its impedance low from slow changes up to fast spikes.',
       'a supply with a high-impedance gap rings at that frequency when the load changes',
       'Simulates each supply rail (regulator output, capacitors with their ESR and ESL by size, DC-bias derated) in ngspice from 1 kHz to 100 MHz and compares with the target impedance.',
       tool=SPICE),
    _c('load-step', 'power', 'Supplies hold up when the load jumps',
       'When the board suddenly draws more current (a radio transmitting), the supply stays within 5 %.',
       'a supply that dips too far resets the chip or corrupts a reading',
       'Simulates a load step from 10 % to 100 % of each rail\'s current in ngspice and measures the lowest voltage.',
       tool=SPICE),
    _c('input-protection', 'power', 'Power input is protected',
       'The power coming in from outside passes a fuse or protection part first.',
       'a short or a wrong adapter otherwise goes straight into the board', 'Looks for a fuse, polyfuse, TVS or diode on each power input.'),
    _c('usb-c-cc', 'power', 'USB-C power input has its CC resistors',
       'A USB-C socket used for power has a 5.1 kΩ resistor from each CC pin to ground.',
       'without them, USB-C chargers and laptops give the board no power at all',
       'Follows the CC1 and CC2 pins of each USB-C socket to their resistors.', source='USB Type-C spec, Rd = 5.1 kΩ'),
    _c('sim-power', 'power', 'Supply transients and regulator stability simulated',
       'Supply behaviour under load has been simulated.', 'a supply that rings or sags resets the board under load',
       'Runs the supply simulations.', tool=SPICE),

    # ------------------------------------------------------------ heat
    _c('heat-parts-hot', 'thermal', 'Every part stays inside its temperature rating on the hottest day',
       'With the board working flat out on the hottest day you set, no part gets hotter than it is rated for.',
       'a part past its rating fails early or shuts down',
       'Solves the heat in the whole board (Rust): each part\'s heat (regulator losses, resistors, chips), the copper\'s own heating, spreading through the copper layers, and cooling to the air by convection and radiation.',
       tool=SIM),
    _c('heat-junction', 'thermal', "Chips' insides stay in range",
       'The silicon inside each hot chip stays below its maximum.',
       'the inside of a chip is hotter than its case; past about 125 °C it shuts down or fails',
       'Adds each chip\'s junction-to-board rise (its power times θJB from the datasheet) to the board temperature under it.',
       tool=SIM),
    _c('heat-board', 'thermal', 'The board itself stays below 105 °C',
       'No spot of the board gets hotter than the board material is happy with.',
       'FR4 softens around 130 °C; staying under 105 °C keeps it stiff and long-lived',
       'Finds the hottest spot of the heat map at the hottest outside temperature.', tool=SIM),
    _c('heat-parts-cold', 'thermal', 'Every part is rated for the coldest day',
       'Each part works at the coldest outside temperature you set.',
       'below their rating, some parts (LCDs, batteries, cheap chips) stop working',
       'Compares each part\'s lowest rated temperature with the coldest outside temperature.'),
    _c('sim-thermal', 'thermal', 'Heat simulated on the routed board at worst-case load',
       'The board\'s heat has been simulated.', 'the routed board runs hotter than the same design before routing',
       'Runs the heat solver.', tool=SIM),

    # ------------------------------------------------------------ part ratings
    _c('stress-cap-voltage', 'stress', 'Capacitors rated well above their voltage',
       'Every capacitor is rated for clearly more voltage than it sees.',
       'a capacitor near its rated voltage ages fast; tantalums short when overstressed',
       'Compares the voltage across each capacitor (from the circuit simulation) with its rating: at most 80 % for ceramics, 50 % for tantalum.',
       tool=SPICE, source='common derating practice (NASA EEE-INST-002, makers\' guides)'),
    _c('stress-cap-dcbias', 'stress', 'Ceramic capacitors keep enough of their value',
       'Small ceramic capacitors lose capacitance at voltage and temperature; each one keeps enough.',
       'a 10 µF X5R capacitor in a small case can be 3 µF at its working voltage, too little to steady the supply',
       'Estimates each X5R/X7R capacitor\'s real value at its voltage and the hottest and coldest temperature.',
       source="makers' DC-bias curves (typical)"),
    _c('stress-resistor-power', 'stress', 'Resistors run below their power rating',
       'No resistor heats up more than its size can take, even on the hottest day.',
       'an overloaded resistor drifts, discolours the board, and can open',
       'Simulates the circuit\'s operating point in ngspice (pins idle, driven low, driven high) at each temperature, and compares each resistor\'s power with its rating, reduced above 70 °C.',
       tool=SPICE, source='resistor derating curve (IEC 60115)'),
    _c('stress-led-current', 'stress', 'LEDs run below their current rating',
       'Each LED gets a safe current through its resistor.', 'too much current burns an LED out or dims it fast',
       'Simulates each LED with its series resistor in ngspice and compares the current with the LED\'s rating.',
       tool=SPICE),
    _c('stress-ic-voltage', 'stress', "Chips' supplies within their maximum",
       'No chip is powered from more voltage than it can take.', 'over its absolute maximum a chip is damaged',
       "Compares each chip's supply net voltage with its maximum."),
    _c('stress-connector-current', 'stress', 'Connectors rated for their current',
       'Each connector carries no more current than its pins are rated for.', 'overloaded connector pins heat up and melt',
       'Compares each power net\'s current through a connector with the connector\'s rating.'),
    _c('stress-tolerance', 'stress', 'Voltage dividers stay in range across tolerances',
       'Resistor dividers (feedback, battery sensing) give the right voltage even with 1 % parts at the hot and cold extremes.',
       'a feedback divider off by a few percent sets the wrong supply voltage',
       'Simulates each divider at the worst corners of tolerance and temperature in ngspice.', tool=SPICE),

    # ------------------------------------------------------------ signals
    _c('return-path', 'signals', 'Signals have unbroken ground under them',
       'Every signal track on an outer layer runs over solid ground (or power) copper on the next layer.',
       'the return current flows under its signal; a gap forces a detour that radiates noise and picks it up',
       'Samples every signal track every 0.1 mm and looks for ground or power copper directly beneath it.',
       tool=GEOM),
    _c('usb-pair', 'signals', 'USB data pair is matched',
       'The two USB data tracks are the same length and the right width for 90 Ω.',
       'unequal or wrong-impedance USB lines cause dropped connections',
       'Measures both tracks\' lengths and estimates their impedance from width, gap and layer height (IPC-2141 formulas).',
       tool=GEOM, source='USB 2.0 spec, IPC-2141'),
    _c('i2c-pullups', 'signals', 'I2C lines have pull-up resistors',
       'The two I2C wires (SDA, SCL) each have a resistor to the supply.',
       'I2C cannot pull its lines high by itself: without pull-ups it does not work at all',
       'Looks for a resistor from each I2C line to a supply.'),
    _c('floating-inputs', 'signals', 'Enable and reset pins are not left floating',
       'Pins that start or reset a chip are tied to a defined level by a resistor.',
       'a floating enable or reset pin makes the board start randomly or not at all',
       'Looks for a pull resistor on every enable and reset net.'),
    _c('creepage', 'signals', 'High voltages keep wide enough gaps',
       'Copper at high voltage keeps the distance the safety standard asks from everything else.',
       'too small a gap at high voltage arcs over, a fire and shock risk',
       'Measures the narrowest gap between each high-voltage net and every other net and compares with IPC-2221B.',
       tool=GEOM, source='IPC-2221B table 6-1'),

    # ------------------------------------------------------------ sourcing
    _c('lcsc', 'sourcing', 'Every assembled part has an LCSC number',
       'Every part the factory fits has its catalogue number.',
       'the assembly house buys and places parts by this number', 'Checks each assembled part for an LCSC number.'),
    _c('stock', 'sourcing', 'Every assembled part is in stock at the assembler',
       'Every part is in stock right now.', 'an out-of-stock part holds the whole order', 'Reads the stock from the catalogue.'),
    _c('stock-qty', 'sourcing', 'Enough stock for 100 boards',
       'There is enough stock of each part to build 100 boards.', 'a part with a handful left runs out before your order is made',
       'Compares each part\'s stock with the number per board times 100.'),
    _c('lifecycle-eol', 'sourcing', 'No end-of-life parts',
       'No part has been discontinued.', 'an end-of-life part stops being made: the board cannot be built again',
       "Reads each part's lifecycle status."),
    _c('lifecycle-nrnd', 'sourcing', 'No parts marked not for new designs',
       'No part is one the maker says not to start new designs with.', 'the maker has said not to start new designs with these',
       "Reads each part's lifecycle status."),
    _c('extended-parts', 'sourcing', 'Few parts with an extra loading fee',
       'Most parts are the assembler\'s "basic" parts, which cost nothing extra to load.',
       'each "extended" part type adds about $3 to every order', "Counts the parts in JLCPCB's extended library."),
    _c('datasheets', 'sourcing', 'Every part has a datasheet',
       'Each part links to its datasheet.', 'the datasheet is where every rating used in these tests comes from',
       'Checks each part for a datasheet link.'),
    _c('ratings-known', 'sourcing', "Part ratings come from datasheets",
       'The temperature, voltage and power limits used in these tests were read from datasheets, not assumed.',
       'an assumed rating can be wrong: the tests are only as good as the numbers behind them',
       'Lists parts whose ratings were filled in from typical values.'),

    # ------------------------------------------------------------ manufacturing
    _c('drc-errors', 'fab', "Design rules with the fab's own limits: 0 errors",
       "KiCad's own full design-rule check, set to the factory's limits, finds nothing wrong.",
       'the fab rejects or mis-builds what breaks its rules', "Runs KiCad's DRC with JLCPCB's limits as the rules.",
       tool=KICAD, source=JLC),
    _c('drc-warnings', 'fab', 'Design rules: 0 warnings',
       'No rule is even bent.', 'a warning is a rule bent; HardHub ships boards with none', "Runs KiCad's DRC.", tool=KICAD),
    _c('board-size', 'fab', 'Board size within what the fab makes',
       'The board is not too small or too big for the factory and its assembly line.',
       'a board under the minimum needs a panel; over the maximum it cannot be made', 'Compares the board size with the fab\'s limits.',
       source=JLC),
    _c('stackup', 'fab', 'A standard layer stack',
       'The number of copper layers and the board thickness are a build the factory offers as standard.',
       'a non-standard stack costs more and takes longer', 'Compares the layer count, thickness and copper weights with the fab\'s standard builds.',
       source=JLC),
    _c('outline', 'fab', 'Board outline is one closed shape',
       'The board\'s edge is a single closed line.', 'an open or doubled outline cannot be cut', "KiCad's DRC checks the outline.",
       tool=KICAD),
    _c('bom-cpl', 'fab', 'Parts list and placement file list exactly the assembled parts',
       'The two files the assembler uses agree with the board, part for part.', 'nothing missing or extra on the assembly line',
       'Compares the BOM and placement file with the board.'),
]

BY_ID = {c['id']: c for c in CHECKS}
# checks made per part (esp32-strapping-U1): their family's entry
FAMILIES = {
    'esp32-strapping': _c('esp32-strapping', 'firmware', 'Strapping pins checked',
                          'Pins that set how the chip starts are not pulled the wrong way.',
                          'a strapping pin pulled the wrong way at power-up stops the chip booting',
                          "Compares the ESP32 module's strapping pins with what is wired to them.",
                          source='Espressif module datasheet'),
    'esp32-adc2': _c('esp32-adc2', 'firmware', 'Analogue inputs on ADC1',
                     'Analogue readings use pins that work while Wi-Fi is on.', 'ADC2 stops working while Wi-Fi is on',
                     'Looks up each analogue pin\'s ADC unit.', source='Espressif module datasheet'),
    'firmware-pins': _c('firmware-pins', 'firmware', 'Firmware pin map matches the circuit',
                        'The firmware uses the pins the circuit actually wires.',
                        'a pin mismatch is a port that never switches or a reading of the wrong sensor',
                        "Compares the firmware's pin map with the ESP32 module's pins in the circuit."),
}
# results made before this catalogue: where they belong now
OLD_GROUP = {'circuit': 'connections', 'layout': 'copper'}


def entry(id):
    if id in BY_ID:
        return BY_ID[id]
    for k, v in FAMILIES.items():
        if id.startswith(k + '-'):
            return v
    return None


def enrich(r):
    """A result from anywhere, with its catalogue fields filled in (the
    result's own name, why and detail win: they may be more specific)."""
    e = entry(r['id'])
    out = dict(r)
    if e:
        for k in ('plain', 'how', 'tool', 'source'):
            if k in e and not out.get(k):
                out[k] = e[k]
        out['group'] = e['group']
        out.setdefault('name', e['name'])
        out.setdefault('why', e['why'])
    elif out.get('group') in OLD_GROUP:
        out['group'] = OLD_GROUP[out['group']]
    return out


def result(id, status, detail=None, measured=None, where=None, fix=None, name=None, **extra):
    """A finished check from the catalogue. measured: from measure();
    where: [{x, y, layer?, refs?, net?, note?}], design frame, at most 20."""
    e = entry(id)
    if e is None:
        raise KeyError('no check %r in the catalogue' % id)
    r = dict(id=id, group=e['group'], name=name or e['name'], why=e['why'], status=status)
    for k in ('plain', 'how', 'tool', 'source'):
        if k in e:
            r[k] = e[k]
    if detail:
        r['detail'] = detail
    if measured:
        r['measured'] = measured
    if where:
        r['where'] = [_where(w) for w in where[:20]]
    if fix and status in ('fail', 'warn'):
        r['fix'] = fix
    r.update(extra)
    return r


def _where(w):
    out = dict(x=round(float(w['x']), 3), y=round(float(w['y']), 3))
    for k in ('layer', 'net', 'note'):
        if w.get(k):
            out[k] = str(w[k])
    if w.get('refs'):
        out['refs'] = [str(x) for x in w['refs']][:10]
    return out


def measure(label, value, unit, limit=None, op=None):
    m = dict(label=label, value=round(float(value), 4), unit=unit)
    if limit is not None:
        m['limit'] = round(float(limit), 4)
        m['op'] = op or '>='
    return m


def passes(value, limit, op='>='):
    return value >= limit - 1e-9 if op == '>=' else value <= limit + 1e-9


def plan(ids):
    """The checks a run will make, for the live view: id, group, name."""
    out = []
    for i in ids:
        e = entry(i)
        if e:
            out.append(dict(id=i, group=e['group'], name=e['name']))
    return out


def skip(id, why, **kw):
    return result(id, 'skip', detail=why, **kw)


def na(id, why, **kw):
    return result(id, 'na', detail=why, **kw)
