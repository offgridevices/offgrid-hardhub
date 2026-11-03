# Done means

Every build runs the board tests: about 80 checks an experienced engineer makes
before ordering, each with what it found, the number it measured against its
limit, where on the board, and how to fix it. They cover connections and
shorts, copper widths and gaps, holes and vias, printing, solder mask,
placement, power (the power tree, voltage drop in the real copper, supply
impedance and a load step simulated in ngspice), heat (the whole board solved
at each outside temperature), every part against its ratings, signals,
sourcing and manufacturing. The person watches them finish live in the Tests
tab.

- Read what fails and needs a look in the build result; `test_report` gives
  them all (or one area). Fix every failure, rebuild, and repeat until none
  fails. A warning is fixed or explained to the person in one plain sentence.
- `run_tests` runs them again without rebuilding: after the person's hand
  edits, or at other outside temperatures.
- The tests are only as good as the numbers in the design: set
  `environment` from what the person told you (where the board lives), each
  power net's `current` and `source`, and each part's `ratings` from its
  datasheet. "ratings-known" lists what was assumed.

A board is ready to order only when all of these hold. Report them as a
checklist: what was tested, how, the result. A check that cannot fail is no check.

- DRC with the fab's own limits: 0 errors, 0 warnings, 0 unconnected.
- The copper equals the circuit, pad for pad.
- The BOM and pick-and-place list exactly the assembled parts, each with stock.
- Every track corner 45 degrees or less.
- Power budget: every regulator, switch and connector within its rating with
  margin, at the worst case (hottest room, full load, stalled load).
- Heat: no part past its rating at the hottest outside temperature, in its
  enclosure; say what was assumed.
- Every board test passes, or each one left is explained to the person.
- Firmware pin map matches the circuit, if firmware was written.
- Every requirement marked met, unmet, or written down as a limit.
- The board's name and revision printed on it, and every part named on the
  silkscreen where there is room.
- You have looked at the finished board yourself (`view_board`: each copper
  layer, the silkscreen, and 3D) and said what you saw.

Anything not verified is said plainly: "designed, not yet built" until a board
has been assembled and measured.

When the board is ready, tell the person what to choose on JLCPCB: layers,
thickness, surface finish, solder mask colour, "PCB Assembly" on the top side,
then upload the BOM and CPL files.
