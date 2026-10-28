# SPDX-License-Identifier: AGPL-3.0-or-later
"""Fab limits, design rules and stackups.

The fab's own limits are the DRC rules (offgrid-hardware docs/lessons.md:
"use the fab's limits as the DRC rules, not looser defaults").  HardHub
designs a notch inside them so a board never needs a fine-line or small-via
surcharge: 0.15 mm track and gap, 0.6 / 0.3 mm vias.

Numbers are JLCPCB's standard tier as published on its capabilities page
(read for Print Hub, Oct 2026).  PCBWay's standard tier is the same or
looser on every number used here.
"""
import re

# design defaults (what HardHub draws)
TRACK, CLEAR = 0.15, 0.15
VIA = (0.6, 0.3)
EDGE = 0.3                       # copper to board edge

# fab floors (what DRC enforces), by copper layer count
LIMITS = {
    2: dict(track=0.127, clear=0.127, via_d=0.5, drill=0.3, ring=0.13, edge=0.3, hole_clear=0.2, hole_hole=0.25),
    4: dict(track=0.127, clear=0.127, via_d=0.5, drill=0.3, ring=0.13, edge=0.3, hole_clear=0.2, hole_hole=0.25),
}
for _n in (6, 8, 10, 12, 14, 16):
    LIMITS[_n] = LIMITS[4]

SILK_MIN = 0.15                  # thinner silkscreen strokes are dropped by the fab

RULES = """(version 1)
# JLCPCB limits the board-setup numbers cannot express on their own:
# plated hole to track 0.28 mm.
(rule "plated component hole to track"
  (condition "A.Type == 'Pad' && A.isPlated() && A.Pad_Type == 'Through-hole' && B.Type == 'Track'")
  (constraint hole_clearance (min 0.28mm)))
# Plane pads join their pours by at least one thermal spoke.
(rule "one spoke is enough"
  (constraint min_resolved_spokes 1))
"""


def apply_limits(b, n):
    import pcbnew
    MM = pcbnew.FromMM
    L = LIMITS[n]
    ds = b.GetDesignSettings()
    ds.m_TrackMinWidth = MM(L['track'])
    ds.m_MinClearance = MM(L['clear'])
    ds.m_ViasMinSize = MM(L['via_d'])
    ds.m_MinThroughDrill = MM(L['drill'])
    ds.m_CopperEdgeClearance = MM(L['edge'])
    ds.m_HoleClearance = MM(L['hole_clear'])
    ds.m_HoleToHoleMin = MM(L['hole_hole'])
    ds.m_ViasMinAnnularWidth = MM(L['ring'])
    ds.m_SolderMaskExpansion = MM(0.0)
    ds.m_SolderMaskMinWidth = MM(0.1)
    nc = ds.m_NetSettings.GetDefaultNetclass()
    nc.SetClearance(MM(CLEAR)); nc.SetTrackWidth(MM(TRACK))
    nc.SetViaDiameter(MM(VIA[0])); nc.SetViaDrill(MM(VIA[1]))


# DRC checks HardHub turns off, and why: footprints are edited on purpose when
# placed (silkscreen to the fab layer, thermal vias out), so they differ from
# their libraries; and the engine has no project library table to compare with
IGNORE = ('lib_footprint_issues', 'lib_footprint_mismatch')


def write_rules(board_path, extra=''):
    import json, os
    base = os.path.splitext(board_path)[0]
    open(base + '.kicad_dru', 'w').write(RULES + extra)
    pro = base + '.kicad_pro'
    p = json.load(open(pro)) if os.path.exists(pro) else {}
    sev = p.setdefault('board', {}).setdefault('design_settings', {}).setdefault('rule_severities', {})
    for k in IGNORE:
        sev[k] = 'ignore'
    p.setdefault('meta', {'filename': os.path.basename(pro), 'version': 3})
    json.dump(p, open(pro, 'w'), indent=2)


# ---------------------------------------------------------------- width
def track_width(current, outer=True, oz=1.0, rise=10.0):
    """IPC-2221 track width (mm) for `current` amps at `rise` C over ambient:
    I = k * dT^0.44 * A^0.725, A in square mils, k 0.048 outside, 0.024
    inside.  Rounded up to 0.05 mm, never under the design default."""
    if not current:
        return TRACK
    k = 0.048 if outer else 0.024
    area = (current / (k * rise ** 0.44)) ** (1 / 0.725)       # mil^2
    w_mil = area / (1.378 * oz)
    w = w_mil * 0.0254
    return max(TRACK, round(-(-w // 0.05) * 0.05, 2))


# ---------------------------------------------------------------- stackups
MASK = {'green': 'Green', 'black': 'Black', 'white': 'White', 'blue': 'Blue', 'red': 'Red',
        'purple': 'Purple', 'yellow': 'Yellow'}
FINISH = {'hasl': 'HAL SnPb', 'lead-free-hasl': 'HAL lead-free', 'enig': 'ENIG'}

# JLCPCB's standard 1.6 mm builds.  2 layers: one FR4 core.  4 layers:
# JLC04161H-7628.  6 layers and up: JLCPCB publishes several; HardHub uses
# an even split (prepreg / core alternating), close enough for the 3D
# model and track-width maths, not for controlled impedance (read the fab's
# impedance calculator for that).
STACK4 = [0.2104, 1.065, 0.2104]


def dielectrics(n, thickness=1.6, outer_cu=0.035, inner_cu=0.0152):
    if n == 2:
        return [round(thickness - 2 * outer_cu, 4)]
    if n == 4 and abs(thickness - 1.6) < 1e-6:
        return STACK4
    left = thickness - 2 * outer_cu - (n - 2) * inner_cu
    return [round(left / (n - 1), 4)] * (n - 1)


def stackup_block(n, mask='green', finish='lead-free-hasl', thickness=1.6, oz_outer=1.0, oz_inner=0.5):
    oc, ic = round(0.035 * oz_outer, 4), round(0.035 * oz_inner, 4)
    mc = MASK.get(mask, 'Green')
    silk = 'Black' if mask == 'white' else 'White'
    d = dielectrics(n, thickness, oc, ic)
    rows = ['\t\t\t(layer "F.SilkS" (type "Top Silk Screen") (color "%s"))' % silk,
            '\t\t\t(layer "F.Paste" (type "Top Solder Paste"))',
            '\t\t\t(layer "F.Mask" (type "Top Solder Mask") (color "%s") (thickness 0.01))' % mc]
    names = ['F.Cu'] + ['In%d.Cu' % i for i in range(1, n - 1)] + ['B.Cu']
    for i, name in enumerate(names):
        rows.append('\t\t\t(layer "%s" (type "copper") (thickness %s))' % (name, oc if i in (0, n - 1) else ic))
        if i < n - 1:
            kind = 'core' if (n == 2 or i % 2 == 1) else 'prepreg'
            mat = 'FR4' if kind == 'core' else '7628'
            rows.append('\t\t\t(layer "dielectric %d" (type "%s") (color "FR4 natural") (thickness %s) '
                        '(material "%s") (epsilon_r %s) (loss_tangent 0.02))'
                        % (i + 1, kind, d[i], mat, '4.6' if kind == 'core' else '4.4'))
    rows += ['\t\t\t(layer "B.Mask" (type "Bottom Solder Mask") (color "%s") (thickness 0.01))' % mc,
             '\t\t\t(layer "B.Paste" (type "Bottom Solder Paste"))',
             '\t\t\t(layer "B.SilkS" (type "Bottom Silk Screen") (color "%s"))' % silk,
             '\t\t\t(copper_finish "%s")' % FINISH.get(finish, 'HAL lead-free'),
             '\t\t\t(dielectric_constraints no)']
    return '\t\t(stackup\n' + '\n'.join(rows) + '\n\t\t)\n'


def set_stackup(path, n, **kw):
    """KiCad's Python API does not reach BOARD_STACKUP, so this edits the
    saved file; KiCad keeps the block on every later load and save."""
    s = open(path).read()
    s = re.sub(r'\t\t\(stackup\n.*?\n\t\t\)\n', '', s, flags=re.S)
    s = s.replace('\t(setup\n', '\t(setup\n' + stackup_block(n, **kw), 1)
    open(path, 'w').write(s)
