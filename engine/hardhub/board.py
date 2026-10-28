# SPDX-License-Identifier: AGPL-3.0-or-later
"""Build the placed, unrouted board from a design: outline, stackup, rules,
parts with their nets, mounting holes, net classes, planes and keepouts.
Routing, the outer ground pours and the checks come after (pipeline.py).

Generalised from offgrid-hardware print-hub/v1/src/board.py and pcb.py.
"""
import os

import pcbnew

from . import design as D, footprints, kicad as K, place, rules, silk

MM = pcbnew.FromMM


def flip(fp):
    try:
        fp.Flip(fp.GetPosition(), pcbnew.FLIP_DIRECTION_TOP_BOTTOM)
    except (AttributeError, TypeError):
        fp.Flip(fp.GetPosition(), False)


def net_width(name, net, oz):
    if net.get('width'):
        return float(net['width'])
    if net.get('current'):
        return rules.track_width(net['current'], outer=True, oz=oz)
    if net.get('kind') == 'power':
        return 0.4
    if net.get('kind') == 'ground':
        return 0.3
    return rules.TRACK


def thermal_vias(fp):
    """Drop plated holes finer than the fab's standard drill that sit inside
    an SMD pad of the same number: a module's thermal vias in its ground
    pad (the ESP32 modules carry 0.2 mm ones).  They would need the fab's
    small-drill surcharge; the board's own ground vias replace them."""
    smd = [p for p in fp.Pads() if p.GetAttribute() == pcbnew.PAD_ATTRIB_SMD]
    for p in list(fp.Pads()):
        if p.GetAttribute() != pcbnew.PAD_ATTRIB_PTH or p.GetDrillSize().x >= MM(rules.LIMITS[2]['drill']):
            continue
        if any(q.GetNumber() == p.GetNumber() and q.HitTest(p.GetPosition()) for q in smd):
            fp.Remove(p)
            K._REMOVED.append(p)


def open_keepouts(fp):
    """A footprint keepout that covers its own pads (a sensor's "no copper
    under the part", drawn over the pad row) would forbid the very tracks
    that reach those pads.  Cut the pads, plus a clearance, out of it: the
    copper under the body stays forbidden, the pads become reachable."""
    from shapely.geometry import Polygon
    from shapely.ops import unary_union
    pads = []
    for p in fp.Pads():
        if p.GetAttribute() == pcbnew.PAD_ATTRIB_NPTH:
            continue
        sh = p.GetEffectivePolygon(pcbnew.F_Cu if p.IsOnLayer(pcbnew.F_Cu) else pcbnew.B_Cu, pcbnew.ERROR_INSIDE)
        for i in range(sh.OutlineCount()):
            o = sh.Outline(i)
            pads.append(Polygon([(o.CPoint(k).x, o.CPoint(k).y) for k in range(o.PointCount())]))
    if not pads:
        return
    cut = unary_union(pads).buffer(MM(rules.CLEAR + 0.1))
    for z in fp.Zones():
        if not z.GetIsRuleArea():
            continue
        ol = z.Outline()
        if ol.OutlineCount() != 1 or ol.HoleCount(0):
            continue
        o = ol.Outline(0)
        area = Polygon([(o.CPoint(k).x, o.CPoint(k).y) for k in range(o.PointCount())])
        if not area.intersects(cut):
            continue
        left = area.difference(cut)
        polys = [left] if left.geom_type == 'Polygon' else list(getattr(left, 'geoms', []))
        polys = [q for q in polys if q.area > MM(0.05) ** 2]
        ol.RemoveAllContours()
        for q in polys:
            k = ol.NewOutline()
            for x, y in list(q.exterior.coords)[:-1]:
                ol.Append(int(x), int(y), k)
            for ring in q.interiors:
                h = ol.NewHole(k)
                for x, y in list(ring.coords)[:-1]:
                    ol.Append(int(x), int(y), k, h)
        if not polys:
            fp.Remove(z)
            K._REMOVED.append(z)


def load_parts(b, d):
    """Every component's footprint on the board (at the origin until placed),
    plus the mounting holes.  Returns ref -> footprint."""
    fps = {}
    for c in d['components']:
        p = d['parts'][c['part']]
        fp = footprints.load(p['footprint'])
        fp.SetReference(c['ref'])
        fp.SetValue(p.get('value') or p['mpn'])
        lcsc = (p.get('sourcing') or {}).get('lcsc')
        if lcsc:
            fp.SetField('LCSC', lcsc)
        fp.SetField('MPN', p['mpn'])
        for fld in fp.GetFields():
            if not (fld.IsReference() or fld.IsValue()):
                fld.SetVisible(False)
                fld.SetLayer(pcbnew.F_Fab)
        fp.Value().SetLayer(pcbnew.F_Fab); fp.Value().SetVisible(False)
        # the reference starts on the assembly drawing (fab layer), and the
        # footprint's own silkscreen waits on a spare layer: silk.apply() puts
        # on the silkscreen what the design asks for, clear of pads and parts
        fp.Reference().SetLayer(pcbnew.F_Fab)
        for it in fp.GraphicalItems():
            if it.GetLayer() == pcbnew.F_SilkS:
                it.SetLayer(silk.PARKED)
        thermal_vias(fp)
        open_keepouts(fp)
        if not p.get('assembled', True):
            fp.SetAttributes(fp.GetAttributes() | pcbnew.FP_EXCLUDE_FROM_BOM | pcbnew.FP_EXCLUDE_FROM_POS_FILES)
        for pad in fp.Pads():
            net = c['pins'].get(pad.GetNumber())
            if net:
                pad.SetNet(K.add_net(b, net))
        fp.SetPosition(K.P(0, 0))
        b.Add(fp)
        fps[c['ref']] = fp
    for i, h in enumerate(d['board']['holes'], 1):
        fp = footprints.load('hh:MOUNT_M3')
        fp.SetReference('MH%d' % i)
        fp.SetPosition(K.P(h['x'], h['y']))
        fp.SetLocked(True)
        b.Add(fp)
    return fps


def apply_placement(fps, placement):
    for ref, pl in placement.items():
        fp = fps.get(ref)
        if fp is None:
            continue
        fp.SetPosition(K.P(pl['x'], pl['y']))
        fp.SetOrientationDegrees(pl.get('rot', 0))
        if pl.get('side') == 'bottom' and not fp.IsFlipped():
            flip(fp)


def build(d, path):
    """Write the placed board to `path`.  Returns the placement the engine
    chose for parts the design left unplaced: ref -> {x, y, rot, side}."""
    d = D.normalize(d)
    bd = d['board']
    n = bd['layers']
    K.set_board(bd['width'], bd['height'])
    pcbnew.KIID.SeedGenerator(7)                 # same design, same file
    # a board with its project: the fab limits and net classes live in the
    # .kicad_pro, and from KiCad 10.0.7 saving a bare BOARD() no longer writes
    # one.  A project left by an earlier build here would carry its settings
    # over, so start from KiCad's defaults as a bare board does.
    base = os.path.splitext(os.path.abspath(path))[0]
    for ext in ('.kicad_pro', '.kicad_prl'):
        if os.path.exists(base + ext):
            os.remove(base + ext)
    b = pcbnew.NewBoard(base + '.kicad_pcb')
    b.SetCopperLayerCount(n)
    rules.apply_limits(b, n)
    K.outline(b, bd['corner_radius'])
    fps = load_parts(b, d)
    apply_placement(fps, d['placement'])
    chosen = place.auto(b, d, fps)
    oz = bd['copper_oz']['outer']
    classes = {}
    for name, net in d['nets'].items():
        if b.FindNet(name) is None:
            continue
        w = net_width(name, net, oz)
        if abs(w - rules.TRACK) > 1e-6:
            classes.setdefault(w, []).append(name)
    for w, names in sorted(classes.items()):
        K.netclass(b, ('W%g' % w).replace('.', '_'), names, w, rules.CLEAR, *rules.VIA)
    planes(b, d)
    keepouts(b, d)
    b.Save(path)
    rules.write_rules(path)
    rules.set_stackup(path, n, mask=bd['mask_color'], finish=bd['finish'], thickness=bd['thickness'],
                      oz_outer=bd['copper_oz']['outer'], oz_inner=bd['copper_oz']['inner'])
    return chosen


def planes(b, d):
    bd = d['board']
    full = K.rounded_rect(K.G.hx - 0.5, K.G.hy - 0.5, max(0.0, bd['corner_radius'] - 0.5))
    for r in bd['layer_roles']:
        if r['role'] == 'plane' and r.get('net'):
            K.zone(b, r['net'], K.layer_id(r['layer']), full, name='%s plane' % r['net'], thermal=False)


def keepouts(b, d):
    n = d['board']['layers']
    for k in d['board']['keepouts']:
        x0, y0, x1, y1 = k['rect']
        layers = [K.layer_id(l) for l in k['layers']] or K.copper_ids(n)
        K.rule_area(b, K.rect(min(x0, x1), min(y0, y1), max(x0, x1), max(y0, y1)), layers, tracks=True, vias=True,
                    pads=True, pours=True, footprints=False, name=k['reason'][:60])
