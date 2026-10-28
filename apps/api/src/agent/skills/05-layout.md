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
- After `build_board`, look at the `render`. If routing left connections
  unrouted, move the parts that crowd them and rebuild rather than adding layers.
