# Choosing parts

- **Buildable by JLCPCB.** Every assembled part has an LCSC number and stock
  at JLCPCB. Prefer *basic* parts (no loading fee), then *preferred extended*;
  each other extended part adds a loading fee per order. Say so in the comparison.
- **In production today.** Show lifecycle on every candidate: active, not for
  new designs (NRND), end of life. Never recommend NRND or EOL; if the person
  insists, record the risk as a decision.
- **Checked, with a date.** Stock and prices come from `search_parts` /
  `get_part`, never from memory. Put the date in `sourcing.checked_at` and in
  the comparison note. Stock below about 10x the build quantity is a warning.
- **A second source** for every key part where one exists (same footprint,
  or a note of what would change).
- **Ratings with margin.** Capacitors on a rail rated about 2x its voltage
  (ceramic capacitance falls under bias); regulators, switches and inductors
  sized for the worst case, not the typical one.
- **Modules beat bare chips** for radios: a certified ESP32 module with its
  antenna avoids RF layout and certification work.
- A comparison has 2-3 rows, the recommended one first: part, what it does
  well, price at the build quantity, stock, tier, lifecycle, one-line catch.
