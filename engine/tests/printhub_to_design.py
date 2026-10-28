# SPDX-License-Identifier: AGPL-3.0-or-later
"""Turn offgrid-hardware's Print Hub v1 (circuit.py, parts.py, layout.py)
into a HardHub design document, so the generic pipeline can be measured
against a board that was routed by hand-tuned scripts.

    OFFGRID_HARDWARE=/path/to/offgrid-hardware python3 printhub_to_design.py OUT.json

Run inside the engine image (layout.py imports KiCad's pcbnew).  The output
is generated at test time and never committed: Print Hub's files stay in
their own repository.  Its footprints are referenced in place, as library
"ph" (HARDHUB_FP_PATHS=ph=<repo>/print-hub/v1/ph.pretty).

What does not carry over: Print Hub's hand-drawn power copper (power.py:
the input bar, the buck's switch-node pour, the 5 V pour) and its split
In2 plane (5 V under the ports, ground under the input stage).  The
generic pipeline gets the nets' widths and a whole-layer 5 V plane instead.
"""
import json
import os
import sys

ROOT = os.environ.get('OFFGRID_HARDWARE', '/w')
SRC = os.path.join(ROOT, 'print-hub', 'v1', 'src')
sys.path.insert(0, SRC)

import board as ph_board   # noqa: E402
import circuit             # noqa: E402
import layout              # noqa: E402
import parts               # noqa: E402
import pcb                 # noqa: E402

KIND = {'U': 'U', 'LED': 'LED', 'D': 'D', 'L': 'L', 'R': 'R', 'C': 'C', 'J': 'J', 'SW': 'SW'}


def convert():
    comps = circuit.build()
    place = layout.placement(comps)
    d = dict(schema=1, name='Print Hub', revision='v1', stage='layout',
             summary='Five switched USB ports for a resin printer\'s accessories (from offgrid-hardware).',
             requirements=[], decisions=[], blocks={}, parts={}, components=[], nets={}, placement={},
             firmware=dict(platform='arduino', pins=[], files={}))
    used = {c.part for c in comps}
    for key, p in parts.PARTS.items():
        if key not in used:
            continue
        d['parts'][key] = dict(mpn=p['mpn'], maker=p.get('maker', ''), kind=KIND.get(p.get('kind'), 'other'),
                               value=p.get('value'), description=p.get('desc', ''), footprint=p['fp'],
                               lifecycle='active', assembled=True,
                               sourcing=dict(lcsc=p['lcsc'], prices=[]))
    if 'TP' in used:
        d['parts']['TP'] = dict(mpn='test pad', maker='', kind='TP', description='Plated test pad',
                                footprint='ph:PAD_TP', assembled=False, lifecycle='active')
    holes = []
    for c in comps:
        x, y, rot = place[c.ref]
        if c.part == 'HOLE':
            holes.append(dict(x=x, y=y, d=3.2))
            continue
        d['blocks'].setdefault(c.block.replace(' ', '-'), dict(name=c.block, purpose=c.block))
        d['components'].append(dict(ref=c.ref, part=c.part, block=c.block.replace(' ', '-'),
                                    pins=dict(c.pins), note=c.note or None))
        d['placement'][c.ref] = dict(x=x, y=y, rot=rot, side='top', locked=True)
    for c in d['components']:
        if c['note'] is None:
            del c['note']
    for n, w in {**ph_board.POWER_NETS, **ph_board.LOGIC_NETS}.items():
        d['nets'][n] = dict(kind='power', width=w)
    d['nets']['GND'] = dict(kind='ground')
    d['nets']['VRAIL'] = dict(kind='power', width=1.0, current=3.0, voltage=5.16)
    ex, ey = layout.ESP
    d['board'] = dict(width=pcb.W, height=pcb.H, corner_radius=0, layers=4, mask_color='green',
                      finish='lead-free-hasl', fab='jlcpcb', holes=holes,
                      layer_roles=[dict(layer='F.Cu', role='signal'), dict(layer='In1.Cu', role='plane', net='GND'),
                                   dict(layer='In2.Cu', role='plane', net='VRAIL'), dict(layer='B.Cu', role='signal')],
                      keepouts=[dict(rect=[ex - 10.5, -pcb.HY, ex + 10.5, ey - 10.0], layers=[],
                                     reason='ESP32 antenna: no copper under or beside it')])
    return d


if __name__ == '__main__':
    json.dump(convert(), open(sys.argv[1], 'w'), indent=1)
    print('wrote', sys.argv[1])
