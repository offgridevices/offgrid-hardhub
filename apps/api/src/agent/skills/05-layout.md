# Laying out the board

- **Size:** start from the connectors and the enclosure. Boards up to 100 x 100 mm
  get JLCPCB's lowest prices.
- **Layers:** congestion, not area, sets the layer count; a bigger board does
  not fix a crowded MCU. 2 layers for simple boards; 4 (signal, ground plane,
  power plane, signal) when there is a radio, USB, a switching regulator or
  dense routing: an unbroken ground plane under every signal is what keeps
  noise and emissions down. 6-8 for fine-pitch BGAs or many fast signals.
  Use `quote` to show the cost difference before asking.
- **Placement, in this order:** connectors on the edges they must reach; the
  antenna of a radio module at a board edge with no copper under or beside it
  (add a keepout on every layer); the power entry, regulator and its inductor
  and capacitors tight together; then each block around its main chip, small
  parts on the side nearest their pins. Leave room for vias next to dense pins.
- **Power copper first:** give the supply as much parallel copper as the
  return; current enters at the power input, so the most robust parts go
  nearest it.
- **The fab's limits are the design rules** (JLCPCB: 0.127 mm track and gap,
  0.3 mm drill, 0.6 mm via for standard pricing). Finer rules cost more.
- **Every track corner is 45 degrees or less** (the house rule; the engine
  enforces it). What actually keeps a board quiet is the unbroken ground plane,
  short return paths and small current loops.
- **Silkscreen:** turn on `refs` and `outlines`, and print the board's name and
  revision (`texts`) where there is bare board. The engine keeps silkscreen off
  pads, parts and the edge; the "silkscreen" check names what did not fit, so
  move it and rebuild.
- **Look at your work after every `build_board`.** `view_board` draws any
  layers on a millimetre grid in board coordinates: the copper of each side,
  one net highlighted (is ground continuous? does the supply take a short,
  wide path?), the silkscreen (readable, nothing on a pad?), a region zoomed
  in, the bottom seen from below, and 3D from any angle. `inspect_board` gives
  the same board as data: each part's position, each net's length and vias,
  and every DRC finding with its location.
- **Fix by moving, then rebuild.** `move_parts` sets positions and rotations
  (lock the ones you placed on purpose). If routing left connections unrouted,
  move the parts that crowd them rather than adding layers.
- **The person can edit the routed board by hand** in the app, as in KiCad:
  drag a track's ends, move or delete a via, draw a track, add a via, move or
  rotate a part. HardHub applies the edits to the KiCad board, refills the
  pours, runs the DRC and every check again and makes every file again,
  without re-routing. You hear of it as a note before their next message
  ("The person edited the board by hand: ..."). Their edits live in the board
  until it is routed again: look at it with `inspect_board` and `view_board`
  rather than rebuilding, and never call `build_board` on a hand-edited board
  without asking them first, because a build places and routes it again and
  loses their tracks and vias (it refuses until you pass
  `discard_hand_edits: true`, which you do only once they agree). Parts they
  moved are kept in `design.placement`, locked.
