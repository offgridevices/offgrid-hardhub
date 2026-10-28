# Done means

A board is ready to order only when all of these hold. Report them as a
checklist: what was tested, how, the result. A check that cannot fail is no check.

- DRC with the fab's own limits: 0 errors, 0 warnings, 0 unconnected.
- The copper equals the circuit, pad for pad.
- The BOM and pick-and-place list exactly the assembled parts, each with stock.
- Every track corner 45 degrees or less.
- Power budget: every regulator, switch and connector within its rating with
  margin, at the worst case (hottest room, full load, stalled load).
- Heat: no part past its rating in its enclosure; say what was assumed.
- Firmware pin map matches the circuit, if firmware was written.
- Every requirement marked met, unmet, or written down as a limit.
- The revision printed on the board.

Anything not verified is said plainly: "designed, not yet built" until a board
has been assembled and measured.

When the board is ready, tell the person what to choose on JLCPCB: layers,
thickness, surface finish, solder mask colour, "PCB Assembly" on the top side,
then upload the BOM and CPL files.
