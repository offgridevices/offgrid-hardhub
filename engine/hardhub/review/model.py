# SPDX-License-Identifier: AGPL-3.0-or-later
"""A routed KiCad board as plain data, for the Rust solver (hardhub-sim).

Everything the board tests measure, in the design's frame (mm from the
board centre, y down): the outline, copper by layer (tracks, vias, pads with
their real outlines, filled zones at full resolution), holes, silkscreen
strokes and texts, solder mask openings and each part's courtyard.  Arcs are
split into short segments, so the solver only meets straight lines.
"""
import math

import pcbnew

from .. import kicad as K, rules

ARC_STEP = 0.25            # mm of arc per segment
MAX_ERR = pcbnew.FromMM(0.005)


def _pt(v):
    x, y = K.xy(v)
    return [round(x, 4), round(y, 4)]


def _rings(ps):
    """SHAPE_POLY_SET -> [[outer ring, hole, ...], ...]"""
    out = []
    for i in range(ps.OutlineCount()):
        chains = [ps.Outline(i)] + [ps.Hole(i, j) for j in range(ps.HoleCount(i))]
        poly = []
        for c in chains:
            pts = [_pt(c.CPoint(k)) for k in range(c.PointCount())]
            if len(pts) >= 3:
                poly.append(pts)
        if poly:
            out.append(poly)
    return out


def _poly_of(item, layer, grow=0):
    ps = pcbnew.SHAPE_POLY_SET()
    try:
        item.TransformShapeToPolygon(ps, layer, int(grow), MAX_ERR, pcbnew.ERROR_INSIDE)
    except TypeError:
        item.TransformShapeToPolygon(ps, layer, int(grow), MAX_ERR, pcbnew.ERROR_INSIDE, False)
    try:
        ps.Simplify()
    except TypeError:
        ps.Simplify(pcbnew.SHAPE_POLY_SET.PM_FAST)
    return _rings(ps)


def arc_points(a, m, b):
    """Points along the circular arc a -> m -> b (design mm)."""
    (ax, ay), (mx, my), (bx, by) = a, m, b
    d = 2 * (ax * (my - by) + mx * (by - ay) + bx * (ay - my))
    if abs(d) < 1e-12:
        return [a, b]
    ux = ((ax * ax + ay * ay) * (my - by) + (mx * mx + my * my) * (by - ay) + (bx * bx + by * by) * (ay - my)) / d
    uy = ((ax * ax + ay * ay) * (bx - mx) + (mx * mx + my * my) * (ax - bx) + (bx * bx + by * by) * (mx - ax)) / d
    r = math.hypot(ax - ux, ay - uy)
    t0, tm, t1 = (math.atan2(p[1] - uy, p[0] - ux) for p in (a, m, b))

    def ccw(s, e):
        return (e - s) % (2 * math.pi)
    sweep = ccw(t0, t1)
    if ccw(t0, tm) > sweep:                     # the mid point is on the other way round
        sweep -= 2 * math.pi
    n = max(2, int(math.ceil(abs(sweep) * r / ARC_STEP)))
    return [[round(ux + r * math.cos(t0 + sweep * i / n), 4), round(uy + r * math.sin(t0 + sweep * i / n), 4)]
            for i in range(n + 1)]


SILK = {pcbnew.F_SilkS: 'F.Silkscreen', pcbnew.B_SilkS: 'B.Silkscreen'}
MASK = {pcbnew.F_Mask: 'F.Mask', pcbnew.B_Mask: 'B.Mask'}


def _shape_lines(sh):
    """A graphic shape as straight strokes (its width is the stroke)."""
    kind = sh.GetShape()
    s, e = _pt(sh.GetStart()), _pt(sh.GetEnd())
    if kind == pcbnew.SHAPE_T_SEGMENT:
        return [(s, e)]
    if kind == pcbnew.SHAPE_T_RECTANGLE if hasattr(pcbnew, 'SHAPE_T_RECTANGLE') else kind == pcbnew.SHAPE_T_RECT:
        c = [s, [e[0], s[1]], e, [s[0], e[1]]]
        return [(c[i], c[(i + 1) % 4]) for i in range(4)]
    if kind == pcbnew.SHAPE_T_CIRCLE:
        cx, cy = _pt(sh.GetCenter())
        r = sh.GetRadius() / 1e6
        n = max(12, int(2 * math.pi * r / ARC_STEP))
        pts = [[cx + r * math.cos(2 * math.pi * i / n), cy + r * math.sin(2 * math.pi * i / n)] for i in range(n)]
        return [(pts[i], pts[(i + 1) % n]) for i in range(n)]
    if kind == pcbnew.SHAPE_T_ARC:
        pts = arc_points(s, _pt(sh.GetArcMid()), e)
        return list(zip(pts, pts[1:]))
    if kind == pcbnew.SHAPE_T_POLY:
        out = []
        for poly in _rings(sh.GetPolyShape()):
            for ring in poly:
                out += [(ring[i], ring[(i + 1) % len(ring)]) for i in range(len(ring))]
        return out
    return []


def _silk(b):
    out = []
    items = list(b.GetDrawings())
    for fp in b.GetFootprints():
        items += list(fp.GraphicalItems())
        items += [f for f in (fp.Reference(), fp.Value()) if f.IsVisible()]
    for it in items:
        layer = SILK.get(it.GetLayer())
        if not layer:
            continue
        cls = it.GetClass()
        if cls in ('PCB_TEXT', 'PCB_FIELD'):
            if cls == 'PCB_FIELD' and not it.IsVisible():
                continue
            bb = it.GetBoundingBox()
            x0, y0 = _pt(bb.GetOrigin())
            x1, y1 = _pt(bb.GetEnd())
            out.append(dict(layer=layer, kind='text', text=it.GetShownText(False)[:60] if hasattr(it, 'GetShownText') else '',
                            w=round(it.GetTextThickness() / 1e6, 4), height=round(it.GetTextHeight() / 1e6, 4),
                            bbox=[min(x0, x1), min(y0, y1), max(x0, x1), max(y0, y1)]))
        elif cls == 'PCB_SHAPE':
            w = it.GetWidth() / 1e6
            if w <= 0:                              # a filled shape has no stroke to measure
                continue
            for a, c in _shape_lines(it):
                out.append(dict(layer=layer, kind='line', w=round(w, 4), a=a, b=c))
    return out


def _mask_margin(p, layer):
    for args in ((layer,), ()):
        try:
            return p.GetSolderMaskExpansion(*args)
        except TypeError:
            continue
    return 0


def export(path_or_board, d=None):
    """The board model hardhub-sim reads (contract: engine/sim/src/model.rs)."""
    b = pcbnew.LoadBoard(path_or_board) if isinstance(path_or_board, str) else path_or_board
    n = b.GetCopperLayerCount()
    names = K.copper_names(n)
    ids = K.copper_ids(n)
    lname = {i: nm for i, nm in zip(ids, names)}
    bd = (d or {}).get('board') or {}
    oz = bd.get('copper_oz') or {'outer': 1, 'inner': 0.5}
    copper = [round(0.035 * (oz.get('outer', 1) if i in (0, n - 1) else oz.get('inner', 0.5)), 4) for i in range(n)]
    diel = rules.dielectrics(n, bd.get('thickness', 1.6), copper[0], copper[1] if n > 2 else copper[0])

    ps = pcbnew.SHAPE_POLY_SET()
    try:
        ok = b.GetBoardPolygonOutlines(ps, True)
    except TypeError:
        ok = b.GetBoardPolygonOutlines(ps)
    rings = _rings(ps) if ok else []
    outline = rings[0][0] if rings else []
    cutouts = [r for poly in rings for r in poly[1:]] + [poly[0] for poly in rings[1:]]

    tracks, vias = [], []
    for t in b.GetTracks():
        cls = t.GetClass()
        if cls == 'PCB_VIA':
            x, y = _pt(t.GetPosition())
            vias.append(dict(x=x, y=y, d=round(t.GetWidth(pcbnew.F_Cu) / 1e6, 4), drill=round(t.GetDrillValue() / 1e6, 4),
                             net=t.GetNetname(), **{'from': b.GetLayerName(t.TopLayer()), 'to': b.GetLayerName(t.BottomLayer())}))
            continue
        layer = lname.get(t.GetLayer())
        if not layer:
            continue
        w = round(t.GetWidth() / 1e6, 4)
        pts = [_pt(t.GetStart()), _pt(t.GetEnd())]
        if cls == 'PCB_ARC':
            pts = arc_points(pts[0], _pt(t.GetMid()), pts[1])
        for a, c in zip(pts, pts[1:]):
            tracks.append(dict(layer=layer, net=t.GetNetname(), w=w, a=a, b=c))

    pads, holes, openings, parts = [], [], [], []
    for fp in b.GetFootprints():
        ref = fp.GetReference()
        for p in fp.Pads():
            on = [lname[i] for i in ids if p.IsOnLayer(i)]
            attr = p.GetAttribute()
            drill = p.GetDrillSize().x / 1e6 if attr in (pcbnew.PAD_ATTRIB_PTH, pcbnew.PAD_ATTRIB_NPTH) else 0.0
            x, y = _pt(p.GetPosition())
            if attr == pcbnew.PAD_ATTRIB_NPTH:
                holes.append(dict(x=x, y=y, d=round(drill, 4), plated=False, ref=ref))
            if on:
                s = p.GetSize()
                poly = _poly_of(p, next(i for i in ids if p.IsOnLayer(i)))
                pads.append(dict(ref=ref, num=str(p.GetNumber()), net=p.GetNetname(), x=x, y=y,
                                 w=round(s.x / 1e6, 4), h=round(s.y / 1e6, 4), rot=round(p.GetOrientationDegrees() % 360, 3),
                                 shape=_shape_name(p), layers=on, drill=round(drill, 4),
                                 plated=attr == pcbnew.PAD_ATTRIB_PTH, poly=poly[0][0] if poly else []))
            for lid, lnm in MASK.items():
                if p.IsOnLayer(lid):
                    cu = pcbnew.F_Cu if lid == pcbnew.F_Mask else pcbnew.B_Cu
                    mp = _poly_of(p, cu if p.IsOnLayer(cu) else lid, _mask_margin(p, lid))
                    if mp:
                        openings.append(dict(layer=lnm, ref=ref, num=str(p.GetNumber()), poly=mp[0][0]))
        bb = _bbox(fp)
        x0, y0 = _pt(bb.GetOrigin())
        x1, y1 = _pt(bb.GetEnd())
        cy = K.courtyard(fp)
        court = [[round(x, 4), round(y, 4)] for x, y in (list(cy.exterior.coords)[:-1] if cy.geom_type == 'Polygon'
                                                       else list(cy.convex_hull.exterior.coords)[:-1])]
        x, y = _pt(fp.GetPosition())
        parts.append(dict(ref=ref, x=x, y=y, side='bottom' if fp.IsFlipped() else 'top', rot=round(fp.GetOrientationDegrees(), 2),
                          bbox=[min(x0, x1), min(y0, y1), max(x0, x1), max(y0, y1)], courtyard=court,
                          footprint='%s:%s' % (fp.GetFPID().GetLibNickname(), fp.GetFPID().GetLibItemName()),
                          keepouts=_keepouts(fp)))

    zones = []
    for z in b.Zones():
        if z.GetIsRuleArea():
            continue
        for lid in z.GetLayerSet().Seq():
            if lid in lname:
                polys = _rings(z.GetFilledPolysList(lid))
                if polys:
                    zones.append(dict(layer=lname[lid], net=z.GetNetname(), polygons=polys))

    return dict(outline=outline, cutouts=cutouts, layers=names, copper_mm=copper, dielectric_mm=diel,
                tracks=tracks, vias=vias, pads=pads, zones=zones, holes=holes, silk=_silk(b),
                mask_openings=openings, parts=parts, thickness=bd.get('thickness', 1.6))


def _keepouts(fp):
    """A footprint's own keep-out areas (a radio module's antenna), as rings."""
    out = []
    for z in fp.Zones():
        if z.GetIsRuleArea():
            for poly in _rings(z.Outline()):
                out.append(poly[0])
    return out


def _bbox(fp):
    try:
        return fp.GetBoundingBox(False, False)
    except TypeError:
        return fp.GetBoundingBox(False)


def _shape_name(p):
    from ..geometry import SHAPES
    return SHAPES.get(p.GetShape(), 'other')
