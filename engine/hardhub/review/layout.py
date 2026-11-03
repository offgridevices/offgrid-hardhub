# SPDX-License-Identifier: AGPL-3.0-or-later
"""The routed board's own tests: connections, copper, holes, printing,
solder mask, placement and signals.

Two independent sources answer most of them: KiCad's DRC with the fab's
limits (a rule broken somewhere) and HardHub's geometry measurement in Rust
(the actual narrowest track, gap, ring... and where it is), so a pass says by
how much it passes.  Placement and signal tests that need the circuit
(which pads are a chip's power pins, which nets are fast) are worked out
here with shapely on the exported board model.
"""
import math
import re

from . import catalog as C
from .. import rules

R, M = C.result, C.measure
FAST = re.compile(r'(^|[_/-])(USB_?)?D[PMN+-]$|^D[+-]$|CLK|SCK|SCLK|XTAL|XIN|XOUT|OSC|MOSI|MISO|_P$|_N$|ETH|RMII|SDIO|QSPI', re.I)
EN = re.compile(r'(^|_)(EN|CHIP_?PU|RST|RESET|NRST|N?RESET|PWR_?EN)$', re.I)


def limits(d):
    n = d['board']['layers']
    L = dict(rules.LIMITS[n])
    # printing: JLCPCB prints lines from 0.15 mm and text from 1.0 mm high
    # (research: JLCPCB help pages, kicad-druid rules); mask dam 0.1 mm (green)
    L.update(silk_w=rules.SILK_MIN, silk_h=1.0, mask_web=0.1)
    return L


def _w(x, at=None, **kw):
    if at is None:
        at = x.get('at') if isinstance(x, dict) else None
    if not at:
        return None
    w = dict(x=at[0], y=at[1])
    for k in ('layer', 'net', 'note'):
        if kw.get(k) or (isinstance(x, dict) and x.get(k)):
            w[k] = kw.get(k) or x.get(k)
    if kw.get('refs') or (isinstance(x, dict) and x.get('refs')):
        w['refs'] = kw.get('refs') or x.get('refs')
    if isinstance(x, dict) and x.get('nets') and 'net' not in w:
        w['note'] = (w.get('note', '') + ' between %s and %s' % tuple(x['nets'][:2])).strip()
    return w


def _ws(items, **kw):
    return [w for w in (_w(i, **kw) for i in items) if w]


def from_drc(drc, cid):
    return (drc or {}).get(cid, [])


def worst(drc_f):
    if not drc_f:
        return None
    return 'fail' if any(f['severity'] == 'error' for f in drc_f) else 'warn'


def minimum(id, m, key, label, limit, unit='mm', drc=None, fix=None, fail='fail', none_ok=None):
    """A test of a measured minimum against the fab's limit, with KiCad's own
    findings for the same rule."""
    from .drc import describe, where
    v = (m or {}).get(key)
    df = from_drc(drc, id)
    if v is None and not df:
        if m is None:
            return C.skip(id, 'the geometry measurement could not run')
        return C.na(id, none_ok or 'nothing of this kind on the board')
    status, detail, wh, meas = 'pass', None, [], None
    if v is not None:
        meas = M(label, v['value'], unit, limit, '>=')
        ok = C.passes(v['value'], limit)
        if not ok:
            status = fail
            wh.append(_w(v))
            detail = '%s is %.3g %s, under the %.3g %s minimum' % (label.capitalize(), v['value'], unit, limit, unit)
        else:
            detail = '%s: %.3g %s (minimum %.3g %s)' % (label.capitalize(), v['value'], unit, limit, unit)
    if df:
        s2 = worst(df)
        status = 'fail' if 'fail' in (status, s2) else 'warn'
        detail = ((detail + '. ') if detail else '') + 'KiCad DRC: %d finding%s: %s' % (len(df), '' if len(df) == 1 else 's', describe(df))
        wh += where(df)
    return R(id, status, detail=detail, measured=meas, where=[w for w in wh if w], fix=fix)


def drc_only(id, drc, ok_detail=None, fix=None, na_if=None):
    from .drc import describe, where
    if drc is None:
        return C.skip(id, "KiCad's DRC report is not available")
    if na_if:
        return C.na(id, na_if)
    df = from_drc(drc, id)
    if not df:
        return R(id, 'pass', detail=ok_detail)
    return R(id, worst(df), detail='%d place%s: %s' % (len(df), '' if len(df) == 1 else 's', describe(df)),
             where=where(df), fix=fix, measured=M('places found', len(df), 'count', 0, '<='))


# ---------------------------------------------------------------- the tests
def checks(d, model, m, drc, report=None):
    """Every layout test. model: review.model.export(); m: hardhub-sim
    measure output (None if it could not run); drc: drc.read() (None if
    unavailable)."""
    L = limits(d)
    out = []
    add = out.append
    nets = d['nets']
    shapes = _Shapes(model)

    # -------------------------------------------------------- connections
    shorts = (m or {}).get('shorts', [])
    df = from_drc(drc, 'shorts')
    if m is None and drc is None:
        add(C.skip('shorts', 'neither the DRC nor the geometry measurement could run'))
    elif shorts or df:
        from .drc import describe, where
        wh = _ws(shorts, note='copper of two nets overlaps') + where(df)
        pairs = sorted({' and '.join(s['nets'][:2]) for s in shorts})
        add(R('shorts', 'fail', detail='%d short%s%s%s' % (len(shorts) + len(df), '' if len(shorts) + len(df) == 1 else 's',
                                                            (': ' + ', '.join(pairs[:5])) if pairs else '',
                                                            ('; KiCad: ' + describe(df)) if df else ''),
              where=wh, measured=M('shorts', len(shorts) + len(df), 'count', 0, '<='),
              fix='Move or re-route the track or via where the two nets touch, then build again. A short is never acceptable.'))
    else:
        add(R('shorts', 'pass', detail='no two nets touch on any layer',
              measured=M('shorts', 0, 'count', 0, '<=')))
    dang = (m or {}).get('dangling', []) + [dict(at=[f['x'], f['y']], note=f['what']) for f in from_drc(drc, 'dangling') if 'x' in f]
    if m is None and drc is None:
        add(C.skip('dangling', 'the geometry measurement could not run'))
    elif dang:
        add(R('dangling', 'warn', detail='%d loose end%s' % (len(dang), '' if len(dang) == 1 else 's'), where=_ws(dang),
              measured=M('loose ends', len(dang), 'count', 0, '<='),
              fix='Delete the loose track or via (Layout tab: select it, Delete), or finish the connection it was meant to make.'))
    else:
        add(R('dangling', 'pass', detail='every track end and via joins something'))
    add(drc_only('isolated-copper', drc, 'no floating copper',
                 fix="Remove the island: give the pour a minimum island size, or join it with a via to its net."))

    # -------------------------------------------------------- copper
    add(minimum('track-min', m, 'track_min', 'narrowest track', L['track'], drc=drc,
                fix='Widen the track to at least %.3g mm (HardHub draws 0.15 mm), or route it where there is room.' % L['track']))
    cm = minimum('clearance-min', m, 'clearance_min', 'narrowest gap', L['clear'], drc=drc,
                 fix='Move the track or via apart to at least %.3g mm from the other net, or re-route.' % L['clear'])
    viol = (m or {}).get('clearance_violations', [])
    if viol and cm['status'] == 'pass':
        cm = dict(cm, status='fail')
    if viol:
        cm['where'] = (cm.get('where') or []) + _ws(viol[:19])
        cm['where'] = cm['where'][:20]
    out.append(cm)
    add(minimum('edge-clearance', m, 'edge_min', 'closest copper to the edge', L['edge'], drc=drc,
                fix='Pull the copper at least %.3g mm in from the board edge.' % L['edge']))
    corners = [c for c in (m or {}).get('corners', []) if c['angle'] > 45.5 and not _jog(model, c)]
    sharp = [c for c in corners if c['angle'] >= 89.5]
    if m is None:
        add(C.skip('corners-45', 'the geometry measurement could not run'))
    elif corners:
        add(R('corners-45', 'warn', detail='%d corner%s sharper than 45° (%d of them 90° or more)' % (
            len(corners), '' if len(corners) == 1 else 's', len(sharp)),
            where=_ws(sorted(corners, key=lambda c: -c['angle']), note='sharp corner'),
            measured=M('sharpest turn', max(c['angle'] for c in corners), '°', 45, '<='),
            fix='Cut each corner into two 45° bends (KiCad: Route > Interactive Router in 45° mode, or drag the corner).'))
    else:
        add(R('corners-45', 'pass', detail='every turn is 45° or gentler', measured=M('sharpest turn', 45 if (m or {}).get('corners') else 0, '°', 45, '<=')))
    acute = (m or {}).get('acute', []) + [dict(at=[f['x'], f['y']], note=f['what']) for f in from_drc(drc, 'acid-traps') if 'x' in f]
    if m is None:
        add(C.skip('acid-traps', 'the geometry measurement could not run'))
    elif acute:
        add(R('acid-traps', 'warn', detail='%d narrow junction%s' % (len(acute), '' if len(acute) == 1 else 's'), where=_ws(acute),
              measured=M('narrowest junction', min((a.get('angle', 0) for a in acute), default=0), '°', 90, '>='),
              fix='Re-route the joining track so it meets at 90° or wider, or fill the wedge with copper.'))
    else:
        add(R('acid-traps', 'pass', detail='every junction is 90° or wider'))
    area = (m or {}).get('copper_area') or {}
    lay = model['layers']
    if area and len(lay) >= 2 and lay[0] in area and lay[-1] in area:
        top, bot = area[lay[0]] * 100, area[lay[-1]] * 100
        diff = abs(top - bot)
        st = 'pass' if diff <= 40 else 'warn'
        add(R('copper-balance', st, detail='top %.0f %% copper, bottom %.0f %%' % (top, bot),
              measured=M('difference', diff, '%', 40, '<='),
              fix='Pour ground on the side with less copper (or add a copper fill) so both sides are similar.'))
    else:
        add(C.skip('copper-balance', 'the geometry measurement could not run'))
    has_zones = bool(model['zones'])
    add(drc_only('thermal-relief', drc, 'every pad in a pour has its spokes', na_if=None if has_zones else 'no copper pours on this board',
                 fix='Let the pour reach the pad with at least two spokes: clear the tracks or vias that block them.'))

    # -------------------------------------------------------- holes
    vias = model['vias']
    add(minimum('via-size', m, 'via_min_d', 'smallest via', L['via_d'], drc=drc, none_ok='no vias on this board',
                fix='Use vias of at least %.3g mm with a %.3g mm hole (HardHub uses 0.6 / 0.3 mm).' % (L['via_d'], L['drill'])))
    add(minimum('drill-min', m, 'drill_min', 'smallest hole', L['drill'], drc=drc, none_ok='no drilled holes',
                fix='Use a hole of at least %.3g mm.' % L['drill']))
    add(minimum('annular-ring', m, 'ring_min', 'thinnest ring', L['ring'], drc=drc, none_ok='no plated holes',
                fix='Make the via or pad copper bigger, or the hole smaller, so the ring is at least %.3g mm.' % L['ring']))
    nholes = len(model['vias']) + len(model['holes']) + sum(1 for p in model['pads'] if p.get('drill'))
    if m is not None and m.get('hole_to_hole_min') is None and not from_drc(drc, 'hole-to-hole') and nholes >= 2:
        add(R('hole-to-hole', 'pass', detail='no two holes within 3 mm of each other'))
    else:
        add(minimum('hole-to-hole', m, 'hole_to_hole_min', 'closest holes', L['hole_hole'], drc=drc, none_ok='fewer than two holes',
                    fix='Move the holes at least %.3g mm apart (edge to edge).' % L['hole_hole']))
    add(drc_only('hole-clearance', drc, 'every hole clear of other copper',
                 fix='Move the track away from the hole, or move the via.'))
    dmin = (m or {}).get('drill_min')
    th = d['board'].get('thickness', 1.6)
    if dmin:
        ar = th / max(dmin['value'], 1e-3)
        add(R('aspect-ratio', 'pass' if ar <= 8 else 'warn', detail='%.2g mm board / %.3g mm smallest hole' % (th, dmin['value']),
              measured=M('depth to width', ar, ':1', 8, '<='), fix='Use a larger smallest hole or a thinner board.'))
    else:
        add(C.na('aspect-ratio', 'no drilled holes'))
    inpad = shapes.vias_in_pads()
    if inpad:
        add(R('via-in-pad', 'warn', detail='vias inside pads of %s' % ', '.join(sorted({r for r, _ in inpad})[:10]),
              where=[dict(x=v['x'], y=v['y'], refs=[r], note='via in pad') for r, v in inpad],
              fix='Move the via just outside the pad, or order filled and capped vias (JLCPCB: "via in pad, POFV").'))
    else:
        tv = getattr(shapes, 'thermal_vias', 0)
        add(R('via-in-pad', 'pass' if vias else 'na',
              detail=('no via sits inside a small pad' + ('; %d thermal vias in heat pads, as intended' % tv if tv else ''))
              if vias else 'no vias on this board'))
    add(shapes.mounting_holes(d))

    # -------------------------------------------------------- printing
    add(minimum('silk-width', m, 'silk_w_min', 'thinnest printed line', L['silk_w'], drc=drc, fail='warn',
                none_ok='nothing printed on this board',
                fix='Make printed lines at least %.2g mm thick; thinner ones may not print.' % L['silk_w']))
    add(minimum('silk-height', m, 'silk_h_min', 'smallest text', L['silk_h'], drc=drc, fail='warn', none_ok='no printed text',
                fix='Make text at least %.2g mm tall (letters 0.15 mm thick).' % L['silk_h']))
    sop = (m or {}).get('silk_on_pads', []) + [dict(at=[f['x'], f['y']], note=f['what']) for f in from_drc(drc, 'silk-on-pads') if 'x' in f]
    if m is None and drc is None:
        add(C.skip('silk-on-pads', 'the measurement could not run'))
    elif sop:
        add(R('silk-on-pads', 'warn', detail='%d place%s where printing meets a pad (the fab clips it, so the label may be cut)' % (
            len(sop), '' if len(sop) == 1 else 's'), where=_ws(sop),
            fix='Move the label or outline off the pad.'))
    else:
        add(R('silk-on-pads', 'pass', detail='no printing on any pad'))
    add(drc_only('silk-off-board', drc, 'all printing is on the board', fix='Move the text onto the board, clear of the edge.'))

    # -------------------------------------------------------- mask
    mw = (m or {}).get('mask_web_min')
    df = from_drc(drc, 'mask-web')
    if m is None and drc is None:
        add(C.skip('mask-web', 'the measurement could not run'))
    elif mw is None and not df:
        add(C.na('mask-web', 'no pads close together'))
    else:
        from .drc import describe, where
        st, det, wh = 'pass', None, []
        meas = None
        if mw:
            meas = M('narrowest mask strip', mw['value'], 'mm', L['mask_web'], '>=')
            if mw['value'] < L['mask_web'] - 1e-9:
                st = 'warn'
                det = 'between some pads the mask strip is %.3g mm: the fab drops strips under %.2g mm there, so those pads have no mask between them' % (mw['value'], L['mask_web'])
                wh.append(_w(mw))
            else:
                det = 'narrowest strip %.3g mm' % mw['value']
        if df:
            st = 'fail'
            det = ((det + '. ') if det else '') + 'KiCad: an opening joins pads of different nets: ' + describe(df)
            wh += where(df)
        add(R('mask-web', st, detail=det, measured=meas, where=wh,
              fix='For fine-pitch chips this is normal (the fab gangs the pads); otherwise space the pads or shrink the mask openings.'))

    # -------------------------------------------------------- placement
    co = (m or {}).get('courtyard_overlaps', [])
    df = from_drc(drc, 'courtyard')
    if co or df:
        from .drc import describe, where
        add(R('courtyard', 'fail', detail='%s%s' % (', '.join(' and '.join(x['refs']) for x in co[:6]),
                                                    ('; KiCad: ' + describe(df)) if df else ''),
              where=_ws(co) + where(df), measured=M('overlaps', len(co) + len(df), 'count', 0, '<='),
              fix='Move the parts apart (move_parts, or drag them in the Layout tab) and build again.'))
    else:
        add(R('courtyard', 'pass' if (m is not None or drc is not None) else 'skip', detail='every part has its own space'))
    add(shapes.part_edge(d))
    add(shapes.connectors_edge(d))
    add(shapes.decoupling_near(d))
    add(shapes.crystal_near(d))
    add(shapes.antenna(d, drc))

    # -------------------------------------------------------- signals
    add(return_path(d, m))
    add(shapes.usb_pair(d))
    add(creepage(d, m))
    return out


def _jog(model, c):
    """A turn at the end of a stub shorter than the track is wide: in the
    copper it is no corner at all (the router's sliver between two 45° bends)."""
    at = c.get('at')
    if not at:
        return False
    for t in model['tracks']:
        if t['layer'] != c.get('layer') or t['net'] != c.get('net'):
            continue
        if min(math.dist(t['a'], at), math.dist(t['b'], at)) < 1e-3 and math.dist(t['a'], t['b']) < t['w']:
            return True
    return False


# ---------------------------------------------------------------- signals
def return_path(d, m):
    if m is None:
        return C.skip('return-path', 'the geometry measurement could not run')
    rp = m.get('return_path') or []
    if d['board']['layers'] < 2 or not rp:
        return C.na('return-path', 'no signal tracks on the outer layers')
    fast = [r for r in rp if FAST.search(r['net'])]
    bad = [r for r in fast if r['uncovered'] > max(1.0, 0.1 * r['length'])]
    slow_bad = [r for r in rp if r not in fast and r['uncovered'] > max(2.0, 0.25 * r['length'])]
    total = sum(r['length'] for r in rp)
    unc = sum(r['uncovered'] for r in rp)
    pct = 100 * (1 - unc / total) if total else 100
    detail = '%.0f %% of signal track length runs over ground or power copper' % pct
    if slow_bad:
        detail += '; slow signals with long gaps under them: %s' % ', '.join('%s (%.1f mm)' % (r['net'], r['uncovered']) for r in slow_bad[:5])
    if bad:
        return R('return-path', 'warn', detail='fast signals over a gap: %s. %s' % (
            ', '.join('%s (%.1f mm of %.1f)' % (r['net'], r['uncovered'], r['length']) for r in bad[:6]), detail),
            where=[dict(x=r['worst_at'][0], y=r['worst_at'][1], net=r['net'], layer=r['layer'], note='no ground under the track here') for r in bad if r.get('worst_at')],
            measured=M('signal length over solid copper', pct, '%', 90, '>='),
            fix='Fill the gap in the ground pour under these tracks (move the track that splits it), or route them over solid ground.')
    return R('return-path', 'pass', detail=detail, measured=M('signal length over solid copper', pct, '%', 90, '>=') if not slow_bad else None)


IPC_B2 = [(15, 0.1), (30, 0.1), (50, 0.6), (100, 0.6), (150, 0.6), (170, 1.25), (250, 1.25), (300, 1.25), (500, 2.5)]


def ipc_b2(v):
    """IPC-2221B table 6-1, B2 (external, uncoated, up to 3050 m): minimum gap, mm."""
    for top, gap in IPC_B2:
        if v <= top:
            return gap
    return 2.5 + 0.005 * (v - 500)


def hv_nets(d):
    return sorted(n for n, x in d['nets'].items() if abs(x.get('voltage') or 0) > 30)


def creepage(d, m):
    hv = hv_nets(d)
    if not hv:
        return C.na('creepage', 'no net above 30 V: the fab\'s normal gaps are already enough')
    if m is None:
        return C.skip('creepage', 'the geometry measurement could not run')
    volt = {n: (x.get('voltage') or 0) for n, x in d['nets'].items()}
    bad, worst_margin = [], None
    for p in m.get('pair_min', []):
        a, b = p['nets'][:2]
        dv = abs(volt.get(a, 0) - volt.get(b, 0))
        need = ipc_b2(dv)
        margin = p['value'] - need
        if worst_margin is None or margin < worst_margin[0]:
            worst_margin = (margin, p, need, dv)
        if p['value'] < need - 1e-9:
            bad.append((p, need, dv))
    if not worst_margin:
        return R('creepage', 'pass', detail='no other copper within 5 mm of the high-voltage nets')
    margin, p, need, dv = worst_margin
    meas = M('narrowest high-voltage gap', p['value'], 'mm', need, '>=')
    if bad:
        return R('creepage', 'fail', detail='; '.join('%s to %s: %.2f mm, %.0f V needs %.2f mm' % (x['nets'][0], x['nets'][1], x['value'], v, n)
                                                     for x, n, v in bad[:5]),
                 measured=meas, where=[_w(x) for x, _, _ in bad[:20]],
                 fix='Widen the gaps around the high-voltage copper (or cut a slot in the board between them).')
    return R('creepage', 'pass', detail='%s to %s: %.2f mm, %.0f V needs %.2f mm' % (p['nets'][0], p['nets'][1], p['value'], dv, need), measured=meas)


# ---------------------------------------------------------------- shapes
class _Shapes:
    """Shapely views of the board model, for placement tests."""

    def __init__(self, model):
        from shapely.geometry import Polygon
        self.model = model
        self.outline = Polygon(model['outline']).buffer(0) if len(model['outline']) >= 3 else None
        self.edge = self.outline.exterior if self.outline is not None else None
        self.parts = {p['ref']: p for p in model['parts']}
        self.pads = {}
        for p in model['pads']:
            self.pads.setdefault(p['ref'], []).append(p)

    def poly(self, ring):
        from shapely.geometry import Polygon
        return Polygon(ring).buffer(0) if len(ring) >= 3 else None

    def part_poly(self, ref):
        from shapely.geometry import box
        p = self.parts.get(ref)
        if not p:
            return None
        if p.get('courtyard') and len(p['courtyard']) >= 3:
            return self.poly(p['courtyard'])
        return box(*p['bbox'])

    def to_edge(self, geom):
        if self.edge is None or geom is None:
            return None
        return geom.distance(self.edge) if self.outline.contains(geom) else 0.0

    def vias_in_pads(self):
        """Vias inside SMD pads: (ref, via) that matter, and the count of
        thermal vias (in a big pad of their own net, a chip's heat pad or a
        regulator's tab, where they are wanted: they carry heat away)."""
        from shapely.geometry import Point
        out, thermal = [], 0
        smd = [(p, self.poly(p['poly'])) for p in self.model['pads'] if not p.get('drill') and p.get('poly')]
        for v in self.model['vias']:
            pt = Point(v['x'], v['y'])
            for p, poly in smd:
                if poly is not None and poly.buffer(-0.02).contains(pt):
                    if p['net'] == v['net'] and min(p['w'], p['h']) >= 2.0:
                        thermal += 1
                    else:
                        out.append((p['ref'], v))
                    break
        self.thermal_vias = thermal
        return out

    def mounting_holes(self, d):
        """Room for a screw head: no copper of a signal or power net within
        about 0.9 x the hole's diameter of its centre on the outer layers
        (M3, 3.2 mm hole: 2.9 mm, a 5.5 mm head with a washer's margin).
        Ground is allowed: many boards tie their holes to it on purpose."""
        from shapely.geometry import LineString, Point
        holes = [h for h in self.model['holes'] if h['d'] >= 2.0]
        if not holes:
            return C.na('mounting-holes', 'no mounting holes')
        g = {n for n, x in d['nets'].items() if x.get('kind') == 'ground'} | {'GND', ''}
        outer = (self.model['layers'][0], self.model['layers'][-1])
        bad, worst = [], None
        for h in holes:
            keep = 0.9 * h['d']
            c = Point(h['x'], h['y'])
            near = None
            for t in self.model['tracks']:
                if t['layer'] in outer and t['net'] not in g:
                    dist = LineString([t['a'], t['b']]).distance(c) - t['w'] / 2
                    near = dist if near is None else min(near, dist)
            for p in self.model['pads']:
                if p['net'] not in g and p.get('poly') and set(p['layers']) & set(outer) and p.get('ref') != h.get('ref'):
                    dist = self.poly(p['poly']).distance(c)
                    near = dist if near is None else min(near, dist)
            for v in self.model['vias']:
                if v['net'] not in g:
                    dist = c.distance(Point(v['x'], v['y'])) - v['d'] / 2
                    near = dist if near is None else min(near, dist)
            if near is not None and (worst is None or near - keep < worst[0] - worst[1]):
                worst = (near, keep, h)
            if near is not None and near < keep:
                bad.append((h, near, keep))
        if bad:
            return R('mounting-holes', 'warn', detail='; '.join('hole at (%.1f, %.1f): copper %.1f mm from its centre, a screw head needs %.1f' % (h['x'], h['y'], n, k) for h, n, k in bad[:4]),
                     where=[dict(x=h['x'], y=h['y'], note='copper near the screw head') for h, _, _ in bad],
                     measured=M('closest copper to a hole centre', bad[0][1], 'mm', bad[0][2], '>='),
                     fix='Keep tracks and parts out of a circle about twice the hole\'s size around each mounting hole, or use nylon washers.')
        if worst:
            return R('mounting-holes', 'pass', detail='%d hole%s, closest copper %.1f mm from a centre' % (len(holes), '' if len(holes) == 1 else 's', worst[0]),
                     measured=M('closest copper to a hole centre', worst[0], 'mm', worst[1], '>='))
        return R('mounting-holes', 'pass', detail='%d holes, no copper nearby' % len(holes))

    def _kind(self, d, ref):
        c = next((c for c in d['components'] if c['ref'] == ref), None)
        p = d['parts'].get(c['part']) if c else None
        return (p or {}).get('kind', ''), p, c

    def part_edge(self, d):
        if self.edge is None:
            return C.skip('part-edge', 'no board outline')
        worst, bad = None, []
        for ref in self.parts:
            kind, p, _ = self._kind(d, ref)
            if kind in ('J', 'H', 'TP') or ref.startswith('MH') or p is None:
                continue
            if re.search(r'antenna', p.get('description', ''), re.I) or p.get('footprint', '').startswith('RF_Module'):
                continue                                         # a radio module belongs at the edge
            dist = self.to_edge(self.part_poly(ref))
            if dist is None:
                continue
            if worst is None or dist < worst[0]:
                worst = (dist, ref)
            if dist < 0.5:
                bad.append((ref, dist))
        if worst is None:
            return C.na('part-edge', 'no parts apart from connectors')
        meas = M('closest part to the edge', worst[0], 'mm', 0.5, '>=')
        if bad:
            return R('part-edge', 'warn', detail=', '.join('%s %.2f mm' % b for b in bad[:8]), measured=meas,
                     where=[dict(x=self.parts[r]['x'], y=self.parts[r]['y'], refs=[r]) for r, _ in bad],
                     fix='Move these parts at least 0.5 mm in from the edge (move_parts), so separating the boards cannot knock them.')
        return R('part-edge', 'pass', detail='closest: %s, %.2f mm' % (worst[1], worst[0]), measured=meas)

    def connectors_edge(self, d):
        if self.edge is None:
            return C.skip('connectors-edge', 'no board outline')
        rows, bad = [], []
        for ref in self.parts:
            kind, p, _ = self._kind(d, ref)
            if kind != 'J' or p is None:
                continue
            fp = p.get('footprint', '')
            if re.search(r'PinHeader|PinSocket|TestPoint|IDC|Pin_?Header|SolderJumper', fp, re.I):
                continue                                        # headers live anywhere on purpose
            dist = self.to_edge(self.part_poly(ref))
            if dist is None:
                continue
            rows.append((ref, dist))
            if dist > 1.5:
                bad.append((ref, dist))
        if not rows:
            return C.na('connectors-edge', 'no cable connectors (pin headers can sit anywhere)')
        if bad:
            return R('connectors-edge', 'warn', detail=', '.join('%s is %.1f mm from the edge' % b for b in bad),
                     where=[dict(x=self.parts[r]['x'], y=self.parts[r]['y'], refs=[r]) for r, _ in bad],
                     measured=M('farthest connector from the edge', max(b[1] for b in bad), 'mm', 1.5, '<='),
                     fix='Move each connector to the board edge with its opening facing out.')
        return R('connectors-edge', 'pass', detail=', '.join('%s %.1f mm' % r for r in rows[:6]) + ' from the edge')

    def _power_pads(self, d, ref):
        power = {n for n, x in d['nets'].items() if x.get('kind') == 'power'}
        return [p for p in self.pads.get(ref, []) if p['net'] in power]

    def decoupling_near(self, d):
        from shapely.geometry import Point
        caps = [c['ref'] for c in d['components'] if d['parts'].get(c['part'], {}).get('kind') == 'C']
        chips = [c['ref'] for c in d['components'] if d['parts'].get(c['part'], {}).get('kind') in ('U', 'MOD')]
        rows, bad, missing = [], [], []
        for ref in chips:
            kind = d['parts'][next(c['part'] for c in d['components'] if c['ref'] == ref)]['kind']
            desc = d['parts'][next(c['part'] for c in d['components'] if c['ref'] == ref)].get('description', '')
            if re.search(r'LDO|regulator|buck|boost|DC-?DC', desc, re.I):
                continue                                         # their capacitors are the bulk-caps test
            limit = 6.0 if kind == 'MOD' else 3.0                # a module has its own on board
            for pad in self._power_pads(d, ref):
                best = None
                for cref in caps:
                    for cp in self.pads.get(cref, []):
                        if cp['net'] == pad['net']:
                            dist = Point(pad['x'], pad['y']).distance(Point(cp['x'], cp['y']))
                            if best is None or dist < best[0]:
                                best = (dist, cref)
                if best is None:
                    missing.append((ref, pad))
                    continue
                rows.append((ref, pad['net'], best[1], best[0], limit))
                if best[0] > limit:
                    bad.append((ref, pad, best, limit))
        if not chips or (not rows and not missing):
            return C.na('decoupling-near', 'no chips with power pins')
        worst = max(rows, key=lambda r: r[3] / r[4]) if rows else None
        meas = M('farthest decoupling capacitor', worst[3], 'mm', worst[4], '<=') if worst else None
        if bad:
            return R('decoupling-near', 'warn', detail='; '.join('%s pin %s (%s): nearest capacitor %s is %.1f mm away, aim for %g mm' % (
                r, p['num'], p['net'], b[1], b[0], lim) for r, p, b, lim in bad[:6]),
                where=[dict(x=p['x'], y=p['y'], refs=[r, b[1]], net=p['net']) for r, p, b, _ in bad], measured=meas,
                fix='Move each capacitor next to the chip pin it serves (move_parts), on the same side, and build again.')
        detail = 'every chip power pin has a capacitor within reach'
        if worst:
            detail += '; farthest: %s %s, %.1f mm from %s' % (worst[0], worst[1], worst[3], worst[2])
        return R('decoupling-near', 'pass', detail=detail, measured=meas)

    def crystal_near(self, d):
        from shapely.geometry import Point
        ys = [c for c in d['components'] if d['parts'].get(c['part'], {}).get('kind') == 'Y']
        if not ys:
            return C.na('crystal-near', 'no crystals on this board')
        chips = {c['ref'] for c in d['components'] if d['parts'].get(c['part'], {}).get('kind') in ('U', 'MOD')}
        rows = []
        for y in ys:
            best = None
            for yp in self.pads.get(y['ref'], []):
                if not yp['net'] or yp['net'] in ('GND',):
                    continue
                for ref in chips:
                    for p in self.pads.get(ref, []):
                        if p['net'] == yp['net']:
                            dist = Point(yp['x'], yp['y']).distance(Point(p['x'], p['y']))
                            best = dist if best is None else max(best, dist)
            if best is not None:
                rows.append((y['ref'], best))
        if not rows:
            return C.na('crystal-near', 'no crystal wired to a chip')
        worst = max(rows, key=lambda r: r[1])
        meas = M('longest crystal connection', worst[1], 'mm', 8.0, '<=')
        if worst[1] > 8:
            return R('crystal-near', 'warn', detail='%s pins are up to %.1f mm from their chip' % worst, measured=meas,
                     where=[dict(x=self.parts[worst[0]]['x'], y=self.parts[worst[0]]['y'], refs=[worst[0]])],
                     fix='Move the crystal and its two capacitors right beside the chip\'s clock pins.')
        return R('crystal-near', 'pass', detail=', '.join('%s %.1f mm' % r for r in rows), measured=meas)

    def antenna(self, d, drc):
        from .drc import describe, where
        mods = []
        for c in d['components']:
            p = d['parts'].get(c['part'], {})
            if re.search(r'antenna|wi-?fi|ble|bluetooth|lora|zigbee|thread', p.get('description', '') + ' ' + p.get('mpn', ''), re.I) \
                    and p.get('kind') in ('MOD', 'U'):
                mods.append(c['ref'])
        if not mods:
            return C.na('antenna-keepout', 'no radio module on this board')
        df = from_drc(drc, 'antenna-keepout')
        notes, wh, status = [], [], 'pass'
        for ref in mods:
            part = self.parts.get(ref)
            if not part:
                continue
            ko = [self.poly(r) for r in part.get('keepouts') or [] if len(r) >= 3]
            if not ko:
                notes.append('%s: its footprint has no keep-out area to check' % ref)
                status = 'warn' if status == 'pass' else status
                continue
            for k in ko:
                dist = self.to_edge(k) if self.outline.intersects(k) and self.outline.contains(k) else 0.0
                if dist is not None and dist > 1.0:
                    status = 'warn'
                    notes.append('%s antenna is %.1f mm inside the board edge' % (ref, dist))
                    c = k.centroid
                    wh.append(dict(x=c.x, y=c.y, refs=[ref], note='antenna not at the edge'))
                else:
                    notes.append('%s antenna at the board edge' % ref)
        if df:
            status = 'fail'
            notes.append('copper or parts in the keep-out: ' + describe(df))
            wh += where(df)
        return R('antenna-keepout', status, detail='; '.join(notes), where=wh,
                 fix='Put the module at the board edge with its antenna end over or at the edge, and keep every track, pour and part out of the area under and beside the antenna.')

    def usb_pair(self, d):
        pairs = []
        names = set(d['nets'])
        for n, x in d['nets'].items():
            if x.get('diff_pair') and x['diff_pair'] in names and n < x['diff_pair']:
                pairs.append((n, x['diff_pair']))
        for p, m_ in (('USB_DP', 'USB_DM'), ('D+', 'D-'), ('USB_D+', 'USB_D-'), ('DP', 'DM'), ('USBDP', 'USBDM'), ('USB_P', 'USB_N')):
            if p in names and m_ in names and (p, m_) not in pairs and (m_, p) not in pairs:
                pairs.append((p, m_))
        if not pairs:
            return C.na('usb-pair', 'no USB data lines on this board')
        length = {}
        width = {}
        for t in self.model['tracks']:
            length[t['net']] = length.get(t['net'], 0) + math.dist(t['a'], t['b'])
            width.setdefault(t['net'], []).append(t['w'])
        h = (self.model['dielectric_mm'] or [1.5])[0]
        tcu = self.model['copper_mm'][0]
        rows, bad = [], []
        for a, b in pairs:
            la, lb = length.get(a, 0), length.get(b, 0)
            if not la or not lb:
                continue
            w = sorted(width.get(a, [0.2]))[len(width.get(a, [0.2])) // 2]
            z = diff_impedance(w, 0.2, h, tcu)
            mm = abs(la - lb)
            rows.append('%s/%s: %.1f and %.1f mm, %.1f mm apart in length; about %.0f Ω differential' % (a, b, la, lb, mm, z))
            if mm > 2.5:
                bad.append(mm)
        if not rows:
            return C.na('usb-pair', 'the USB lines have no tracks yet')
        note = '. Full-speed USB (12 Mbit/s, what most microcontrollers use) does not need 90 Ω; high-speed USB needs a 4-layer board with matched 90 Ω lines'
        if bad:
            return R('usb-pair', 'warn', detail='; '.join(rows) + note, measured=M('length difference', max(bad), 'mm', 2.5, '<='),
                     fix='Route the two USB tracks side by side, the same length, with no other track between them.')
        return R('usb-pair', 'pass', detail='; '.join(rows) + note)


def microstrip_z0(w, h, t, er=4.5):
    """IPC-2141 surface microstrip, ohms (valid for 0.1 < w/h < 2)."""
    return 87 / math.sqrt(er + 1.41) * math.log(5.98 * h / (0.8 * w + t))


def diff_impedance(w, s, h, t, er=4.5):
    """Edge-coupled surface microstrip pair (IPC-2141 approximation), ohms."""
    return 2 * microstrip_z0(w, h, t, er) * (1 - 0.48 * math.exp(-0.96 * s / h))
