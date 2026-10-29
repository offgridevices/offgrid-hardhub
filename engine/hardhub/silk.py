# SPDX-License-Identifier: AGPL-3.0-or-later
"""The silkscreen: what the design asks for, kept off pads, parts and edges.

    design.board.silkscreen = {outlines, refs, texts}

  outlines  each footprint's own silkscreen (body outline, pin-1 mark),
            item by item, where it stays clear of every pad
  refs      each part's name (R1, U2) beside the part, at the first spot
            around it that is clear of pads, other parts, holes, the edge
            and other text; a part with no room keeps its name on the
            assembly drawing only, and the check says which
  texts     the design's own words (board name, version, labels), where it
            put them; ones that would land on a pad, a part or off the board
            are left off and reported, so the AI can move them

Footprints arrive with their silkscreen parked on a spare user layer
(board.load_parts), so routing never sees it; apply() decides, at the end,
what goes on the silkscreen and what goes to the fab layer.  Nothing here
moves copper.
"""
import pcbnew
from shapely.geometry import box
from shapely.ops import unary_union

from . import kicad as K, rules

PARKED = pcbnew.User_9                  # footprint silkscreen until apply() places it
TEXT_H, TEXT_MIN_H = 1.0, 0.8           # mm: reference letter height, and the smallest a fab prints legibly
PAD_GAP = 0.2                           # mm between silkscreen and any pad
EDGE_GAP = 0.3                          # mm between silkscreen and the board edge
TEXT_GAP = 0.15                         # mm between two pieces of silkscreen text


def _bbox_poly(item, layer):
    ps = pcbnew.SHAPE_POLY_SET()
    item.TransformShapeToPolygon(ps, layer, 0, 5000, pcbnew.ERROR_INSIDE)
    if not ps.OutlineCount():
        return None
    bb = ps.BBox()
    x0, y0 = K.xy(pcbnew.VECTOR2I(bb.GetX(), bb.GetY()))
    x1, y1 = K.xy(pcbnew.VECTOR2I(bb.GetRight(), bb.GetBottom()))
    return box(x0, y0, x1, y1)


def _shape_poly(item, layer):
    from shapely.geometry import Polygon
    ps = pcbnew.SHAPE_POLY_SET()
    item.TransformShapeToPolygon(ps, layer, 0, 5000, pcbnew.ERROR_INSIDE)
    polys = []
    for i in range(ps.OutlineCount()):
        o = ps.Outline(i)
        pts = [K.xy(o.CPoint(j)) for j in range(o.PointCount())]
        if len(pts) >= 3:
            polys.append(Polygon(pts).buffer(0))
    return unary_union(polys) if polys else None


def _body(fp):
    """Where the part physically sits: its assembly-drawing outline, else its courtyard.
    (A radio module's courtyard also covers the bare board its antenna needs.)"""
    fab = pcbnew.B_Fab if fp.IsFlipped() else pcbnew.F_Fab
    boxes = []
    for g in fp.GraphicalItems():
        if g.GetLayer() == fab and g.GetClass() == 'PCB_SHAPE':
            bb = g.GetBoundingBox()
            x0, y0 = K.xy(pcbnew.VECTOR2I(bb.GetX(), bb.GetY()))
            x1, y1 = K.xy(pcbnew.VECTOR2I(bb.GetRight(), bb.GetBottom()))
            boxes.append((x0, y0, x1, y1))
    if boxes:
        return box(min(b[0] for b in boxes), min(b[1] for b in boxes), max(b[2] for b in boxes), max(b[3] for b in boxes))
    return K.courtyard(fp)


def _board_area(b):
    from shapely.geometry import Polygon
    ps = pcbnew.SHAPE_POLY_SET()
    try:
        ok = b.GetBoardPolygonOutlines(ps, True)
    except TypeError:
        ok = b.GetBoardPolygonOutlines(ps)
    if not ok or not ps.OutlineCount():
        return None
    o = ps.Outline(0)
    return Polygon([K.xy(o.CPoint(j)) for j in range(o.PointCount())]).buffer(-EDGE_GAP)


def apply(path, d):
    """Place the silkscreen on the routed board at path; returns the check result."""
    b = pcbnew.LoadBoard(path)
    # run again on a board it has done before (a hand-edited board is checked
    # again): the design's own text is placed afresh, not twice
    for t in list(b.GetDrawings()):
        if t.GetClass() == 'PCB_TEXT' and t.GetLayer() in (pcbnew.F_SilkS, pcbnew.B_SilkS):
            K.remove(b, t)
    want = (d.get('board') or {}).get('silkscreen') or {}
    outlines, refs, texts = bool(want.get('outlines')), bool(want.get('refs')), list(want.get('texts') or [])
    area = _board_area(b)
    side_of = lambda fp: 'bottom' if fp.IsFlipped() else 'top'

    pads = {'top': [], 'bottom': []}
    courtyards = {'top': {}, 'bottom': {}}
    holes = []
    for fp in b.GetFootprints():
        for p in fp.Pads():
            for side, lid in (('top', pcbnew.F_Cu), ('bottom', pcbnew.B_Cu)):
                if p.IsOnLayer(lid):
                    poly = _shape_poly(p, lid)
                    if poly is not None:
                        pads[side].append(poly.buffer(PAD_GAP))
            dr = p.GetDrillSize()
            if dr.x > 0:
                from shapely.geometry import Point
                holes.append(Point(*K.xy(p.GetPosition())).buffer(dr.x / 2e6 + PAD_GAP))
        if not fp.GetReference().startswith('MH'):
            courtyards[side_of(fp)][fp.GetReference()] = _body(fp)
    # vias are tented (covered by solder mask), so silkscreen may cross them
    blocked = {s: unary_union(pads[s] + holes) for s in ('top', 'bottom')}
    placed = {'top': [], 'bottom': []}
    dropped_outline = 0

    # 1. footprint outlines: on the silkscreen where clear of pads, else to the fab layer
    for fp in b.GetFootprints():
        side = side_of(fp)
        silk, fab = (pcbnew.B_SilkS, pcbnew.B_Fab) if side == 'bottom' else (pcbnew.F_SilkS, pcbnew.F_Fab)
        for it in fp.GraphicalItems():
            # parked by board.load_parts, or on the silkscreen from a run
            # before this one (a part since moved may now sit on a pad)
            if it.GetLayer() not in (PARKED, silk):
                continue
            it.SetLayer(silk)
            poly = _shape_poly(it, silk) if outlines else None
            ok = poly is not None and not poly.intersects(blocked[side]) and (area is None or area.contains(poly))
            if ok:
                placed[side].append(poly)
            else:
                it.SetLayer(fab)
                dropped_outline += int(outlines)

    # 2. the design's own text, where it asked
    bad_text = []
    for t in texts:
        side = t.get('side', 'top')
        size = max(TEXT_MIN_H, min(float(t.get('size', 1.2)), 5.0))
        layer = pcbnew.B_SilkS if side == 'bottom' else pcbnew.F_SilkS
        item = K.text(b, str(t['text'])[:60], float(t['x']), float(t['y']), size=size, layer=layer,
                      rot=float(t.get('rot', 0)), thick=max(rules.SILK_MIN, round(size * 0.15, 3)))
        poly = _bbox_poly(item, layer)
        if poly is None:
            continue
        why = []
        if area is not None and not area.contains(poly):
            why.append('off the board or too near its edge')
        if poly.intersects(blocked[side]):
            why.append('on a pad or hole')
        hit = [r for r, c in courtyards[side].items() if c is not None and poly.intersects(c)]
        if hit:
            why.append('over %s' % ', '.join(hit[:3]))
        if why:
            # left off the board, so the DRC stays clean; the check says where to move it
            K.remove(b, item)
            bad_text.append('"%s" at (%g, %g) not printed: %s' % (t['text'], t['x'], t['y'], '; '.join(why)))
            continue
        placed[side].append(poly)

    # 3. part names beside their parts
    no_room = []
    n_refs = 0
    for fp in sorted(b.GetFootprints(), key=lambda f: f.GetReference()):
        ref = fp.GetReference()
        if ref.startswith('MH'):
            fp.Reference().SetLayer(pcbnew.F_Fab)       # a mounting hole's name helps nobody on the board
            continue
        side = side_of(fp)
        silk = pcbnew.B_SilkS if side == 'bottom' else pcbnew.F_SilkS
        fab = pcbnew.B_Fab if side == 'bottom' else pcbnew.F_Fab
        r = fp.Reference()
        if not refs:
            r.SetLayer(fab)
            continue
        n_refs += 1
        court = courtyards[side].get(ref)
        others = unary_union([c for k, c in courtyards[side].items() if k != ref and c is not None])
        x0, y0, x1, y1 = court.bounds if court is not None else (*K.xy(fp.GetPosition()), *K.xy(fp.GetPosition()))
        cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
        r.SetLayer(silk)
        r.SetTextAngleDegrees(0)
        done = False
        for h in (TEXT_H, TEXT_MIN_H):
            r.SetTextSize(pcbnew.VECTOR2I(K.MM(h), K.MM(h)))
            r.SetTextThickness(K.MM(max(rules.SILK_MIN, round(h * 0.15, 3))))
            gap = 0.25 + h / 2
            w = len(ref) * h * 0.9
            for px, py in ((cx, y0 - gap), (cx, y1 + gap), (x1 + 0.25 + w / 2, cy), (x0 - 0.25 - w / 2, cy),
                           (x1 + 0.25 + w / 2, y0 - gap), (x0 - 0.25 - w / 2, y0 - gap),
                           (x1 + 0.25 + w / 2, y1 + gap), (x0 - 0.25 - w / 2, y1 + gap)):
                r.SetPosition(K.P(px, py))
                poly = _bbox_poly(r, silk)
                if poly is None:
                    continue
                if area is not None and not area.contains(poly):
                    continue
                if poly.intersects(blocked[side]) or (not others.is_empty and poly.intersects(others)):
                    continue
                if any(poly.buffer(TEXT_GAP).intersects(q) for q in placed[side]):
                    continue
                placed[side].append(poly)
                done = True
                break
            if done:
                break
        if not done:
            r.SetLayer(fab)
            no_room.append(ref)
    b.Save(path)

    detail = []
    if refs:
        detail.append('part names on the silkscreen: %d of %d' % (n_refs - len(no_room), n_refs))
    if no_room:
        detail.append('no room beside %s (named on the assembly drawing only)' % ', '.join(no_room[:12]))
    if dropped_outline:
        detail.append('%d outline pieces left off (they touched pads or the edge)' % dropped_outline)
    if bad_text:
        detail.append('text to move: ' + '; '.join(bad_text[:6]))
    if not (outlines or refs or texts):
        detail.append('no silkscreen asked for (design.board.silkscreen)')
    return dict(id='silkscreen', group='fab', name='Silkscreen clear of pads, parts and the edge',
                why='silkscreen on a pad stops solder; under a part or off the edge it is lost',
                status='warn' if (bad_text or no_room) else 'pass', detail='; '.join(detail))
