# SPDX-License-Identifier: AGPL-3.0-or-later
"""The design document (packages/protocol/src/design.ts) as plain dicts.

The API validates designs with the protocol's Zod schema before they reach
the engine; this module fills the same defaults and checks only what the
engine's own steps rely on, so a hand-written fixture behaves like one that
came through the API.
"""
import re

COPPER_COUNTS = (2, 4, 6, 8, 10, 12, 14, 16)


class DesignError(ValueError):
    pass


def normalize(d):
    d = dict(d)
    d.setdefault('name', 'Untitled board')
    d.setdefault('revision', 'v1')
    for k, v in (('requirements', []), ('decisions', []), ('blocks', {}), ('parts', {}), ('components', []),
                 ('nets', {}), ('placement', {})):
        d.setdefault(k, v)
    d.setdefault('firmware', {'platform': 'none', 'pins': [], 'files': {}})
    for p in d['parts'].values():
        p.setdefault('assembled', True)
        p.setdefault('lifecycle', 'unknown')
    for n in d['nets'].values():
        n.setdefault('kind', 'signal')
    for pl in d['placement'].values():
        pl.setdefault('rot', 0); pl.setdefault('side', 'top'); pl.setdefault('locked', False)
    b = d.get('board')
    if b:
        b = d['board'] = dict(b)
        b.setdefault('corner_radius', 1.0)
        b.setdefault('thickness', 1.6)
        b.setdefault('copper_oz', {'outer': 1, 'inner': 0.5})
        b.setdefault('fab', 'jlcpcb')
        b.setdefault('mask_color', 'black')
        b.setdefault('finish', 'lead-free-hasl')
        b.setdefault('holes', [])
        b.setdefault('layer_roles', [])
        b.setdefault('keepouts', [])
        b['silkscreen'] = dict(b.get('silkscreen') or {})
        b['silkscreen'].setdefault('outlines', False)
        b['silkscreen'].setdefault('refs', False)
        b['silkscreen'].setdefault('texts', [])
        for h in b['holes']:
            h.setdefault('d', 3.2)
        for k in b['keepouts']:
            k.setdefault('layers', [])
    return d


def require_board(d):
    """Errors that stop a build before KiCad is started."""
    errs = []
    b = d.get('board')
    if not b:
        return ['the design has no board yet (size and layers)']
    if b.get('layers') not in COPPER_COUNTS:
        errs.append('board.layers must be one of %s' % (COPPER_COUNTS,))
    for k in ('width', 'height'):
        if not isinstance(b.get(k), (int, float)) or not 5 <= b[k] <= 500:
            errs.append('board.%s must be 5-500 mm' % k)
    n = b.get('layers', 2)
    names = {'F.Cu', 'B.Cu'} | {'In%d.Cu' % i for i in range(1, n - 1)}
    for r in b.get('layer_roles', []):
        if r['layer'] not in names:
            errs.append('layer_roles: %s is not a layer of a %d-layer board' % (r['layer'], n))
        if r['role'] == 'plane' and not r.get('net'):
            errs.append('layer_roles: plane on %s has no net' % r['layer'])
    refs = set()
    for c in d['components']:
        if not re.fullmatch(r'[A-Z]+\d+', c['ref']):
            errs.append('bad reference %r' % c['ref'])
        if c['ref'] in refs:
            errs.append('reference %s used twice' % c['ref'])
        refs.add(c['ref'])
        if c['part'] not in d['parts']:
            errs.append('%s: part %r is not in design.parts' % (c['ref'], c['part']))
    return errs


def plane_nets(d):
    """Nets that own a whole copper layer (a plane): the router leaves them
    alone and every SMD pad on them gets a via down to the plane."""
    return sorted({r['net'] for r in d['board'].get('layer_roles', []) if r['role'] == 'plane' and r.get('net')})


def ground_net(d):
    for name, n in d['nets'].items():
        if n.get('kind') == 'ground':
            return name
    return 'GND' if any('GND' in c['pins'].values() for c in d['components']) else None


def nets(d):
    out = {}
    for c in d['components']:
        for pad, net in c['pins'].items():
            if net:
                out.setdefault(net, []).append((c['ref'], pad))
    return out
