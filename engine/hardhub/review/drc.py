# SPDX-License-Identifier: AGPL-3.0-or-later
"""KiCad's design-rule check, sorted into the checklist.

KiCad 10's DRC (kicad-cli pcb drc --format json) reports violations by type
(pcbnew/drc/drc_item.cpp); each lands on the test it belongs to, so a person
sees "Gaps between copper are wide enough: 2 places too narrow" rather than
a raw list.  Positions come back in the design's frame.
"""
import json
import os

from .. import kicad as K

# KiCad violation type -> catalogue id
TYPE = {
    'shorting_items': 'shorts', 'tracks_crossing': 'shorts', 'net_conflict': 'shorts',
    'clearance': 'clearance-min', 'creepage': 'creepage',
    'copper_edge_clearance': 'edge-clearance',
    'track_width': 'track-min', 'connection_width': 'track-min',
    'track_angle': 'corners-45', 'copper_sliver': 'acid-traps',
    'starved_thermal': 'thermal-relief', 'isolated_copper': 'isolated-copper',
    'via_dangling': 'dangling', 'track_dangling': 'dangling',
    'via_diameter': 'via-size', 'annular_width': 'annular-ring',
    'drill_out_of_range': 'drill-min', 'microvia_drill_out_of_range': 'drill-min',
    'hole_clearance': 'hole-clearance', 'hole_to_hole': 'hole-to-hole', 'holes_co_located': 'hole-to-hole',
    'courtyards_overlap': 'courtyard', 'missing_courtyard': 'courtyard', 'malformed_courtyard': 'courtyard',
    'pth_inside_courtyard': 'courtyard', 'npth_inside_courtyard': 'courtyard',
    'silk_over_copper': 'silk-on-pads', 'silk_overlap': 'silkscreen', 'silk_edge_clearance': 'silk-off-board',
    'text_height': 'silk-height', 'text_thickness': 'silk-width',
    'solder_mask_bridge': 'mask-web',
    'items_not_allowed': 'antenna-keepout',
    'invalid_outline': 'outline', 'text_on_edge_cuts': 'outline',
    'unconnected_items': 'routed',
}


def _at(v):
    for it in v.get('items', []):
        p = it.get('pos')
        if p:
            return round(p['x'] - K.CX, 3), round(p['y'] - K.CY, 3)
    return None


def read(drc_json):
    """{catalogue id: [finding]} from a DRC report, finding =
    {type, severity, what, x, y, items}. Unconnected items under 'routed'."""
    if not drc_json or not os.path.exists(drc_json):
        return None
    r = json.load(open(drc_json))
    out = {}
    for v in r.get('violations', []) + [dict(u, severity='error', type='unconnected_items') for u in r.get('unconnected_items', [])]:
        if v.get('excluded'):
            continue
        cid = TYPE.get(v.get('type'), 'drc-other')
        at = _at(v)
        f = dict(type=v.get('type'), severity=v.get('severity'), what=v.get('description', ''),
                 items=[i.get('description', '')[:120] for i in v.get('items', [])][:3])
        if at:
            f['x'], f['y'] = at
        out.setdefault(cid, []).append(f)
    return out


def where(findings, n=20):
    out = []
    for f in findings[:n]:
        if 'x' in f:
            out.append(dict(x=f['x'], y=f['y'], note=(f['what'] + (': ' + '; '.join(f['items'][:2]) if f['items'] else ''))[:200]))
    return out


def describe(findings, n=3):
    return '; '.join('%s%s' % (f['what'], ' (%s)' % ', '.join(f['items'][:2]) if f['items'] else '') for f in findings[:n])


def run(board_path, work):
    """A fresh DRC on a copy of the board (the copy's zones are refilled and
    saved, the original is left alone). Returns (path of the JSON, errors,
    warnings, unconnected)."""
    import shutil
    os.makedirs(work, exist_ok=True)
    base = os.path.splitext(board_path)[0]
    copy = os.path.join(work, 'drc-copy.kicad_pcb')
    shutil.copy(board_path, copy)
    for ext in ('.kicad_pro', '.kicad_dru'):
        if os.path.exists(base + ext):
            shutil.copy(base + ext, os.path.splitext(copy)[0] + ext)
    out = os.path.join(work, 'drc.json')
    e, w, u = K.drc(copy, out)
    return out, e, w, u
