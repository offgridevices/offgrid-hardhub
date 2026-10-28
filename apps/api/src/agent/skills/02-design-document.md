# The design document

Everything about the board lives in one JSON document. Read it with
`get_design`, change it with `update_design` (RFC 6902 JSON Patch). A patch
that would make it invalid is refused with the reasons; fix and resend.

- Units: millimetres, volts, amps, US dollars. Board origin at its centre,
  x right, y down (KiCad).
- `parts`: keyed by a short name ("ESP32S3", "R10K"). One entry per orderable
  line: `mpn`, `maker`, `kind`, `value`, `description`, KiCad `footprint`
  ("Library:Name"; standard KiCad libraries, or "hh:<name>" for the fab's own
  footprint of that LCSC part), `lifecycle`, `sourcing` (`lcsc`, `tier`,
  `stock`, `prices`, `checked_at`), `assembled`.
- `components`: one per placed part: `ref` (U1, R3, C12, J1...), `part`,
  `block`, and `pins`: footprint pad number -> net name, or null for a pin left
  open on purpose. Every copper pad of the footprint must appear.
- `nets`: only for nets that need more than a name: `kind` (power, ground),
  `voltage`, `current` (sets track width), `width`, `diff_pair`.
- `board`: `width`, `height`, `layers`, `holes`, `layer_roles` (which inner
  layers are planes, and of which net), `keepouts` (antenna area), fab options.,
  `silkscreen`: `outlines` (each part's outline and pin-1 mark), `refs` (each
  part's name beside it), `texts` (board name, revision, connector labels:
  `text`, `x`, `y`, `size` in mm, `side`, `rot`).
- `placement`: ref -> `x`, `y`, `rot`, `side`, `locked`. Parts you leave out
  are placed automatically by `build_board`.
- `firmware`: `platform`, `mcu`, `pins` (name, gpio, net, dir), `files`.

Patch tips: add a whole part with one `add` at `/parts/NAME`; append a
component with `/components/-`; change one pin with
`replace /components/<index>/pins/<pad>`. Keep patches focused, with a
one-sentence `summary` the person will read.
