# SPDX-License-Identifier: AGPL-3.0-or-later
"""The routed board as vector geometry, for a client that edits it by hand
(packages/protocol/src/board.ts, BoardGeometry).

    <slug>-board.json   tracks, vias, parts with their pads, filled zones,
                        the rules a new track or via starts from

Frame: millimetres, y down, from `origin`, the KiCad position of the top-left
corner of the board outline's bounding box.  That is the crop kicad-cli uses
for the per-layer SVGs (`--page-size-mode 2`, board area only): their (0, 0)
is the outline's corner, without its line width, and their viewBox is that
box in whole mils, rounded down.  So a point here is the same point in every
SVG.  Ids are each item's KIID, which KiCad keeps across loads and saves.
"""
import json
import math
import re

import pcbnew

from . import kicad as K, rules

MIL = 0.0254
MAX_POINTS = 300                     # per ring of a filled zone


def outline_box(b):
    """(x0, y0, x1, y1) of the board outline, KiCad absolute mm."""
    ps = pcbnew.SHAPE_POLY_SET()
    try:
        ok = b.GetBoardPolygonOutlines(ps, True)
    except TypeError:
        ok = b.GetBoardPolygonOutlines(ps)
    if ok and ps.OutlineCount():
        bb = ps.BBox()
    else:
        bb = b.GetBoardEdgesBoundingBox()
    return bb.GetX() / 1e6, bb.GetY() / 1e6, bb.GetRight() / 1e6, bb.GetBottom() / 1e6


def outline(b):
    """The board outline as a shapely polygon, absolute mm (None without one)."""
    from shapely.geometry import Polygon
    ps = pcbnew.SHAPE_POLY_SET()
    try:
        ok = b.GetBoardPolygonOutlines(ps, True)
    except TypeError:
        ok = b.GetBoardPolygonOutlines(ps)
    if not ok or not ps.OutlineCount():
        return None
    o = ps.Outline(0)
    return Polygon([(o.CPoint(i).x / 1e6, o.CPoint(i).y / 1e6) for i in range(o.PointCount())]).buffer(0)


def svg_size(svg_path):
    """An SVG artifact's viewBox width and height."""
    with open(svg_path) as f:
        head = f.read(4000)
    m = re.search(r'viewBox="\s*[-\d.]+\s+[-\d.]+\s+([\d.]+)\s+([\d.]+)"', head)
    return (float(m.group(1)), float(m.group(2))) if m else None


def crop(b, svg_path=None):
    """origin (absolute mm) and size of the SVG crop: read from an SVG made
    from this board when there is one, else worked out the way kicad-cli does."""
    x0, y0, x1, y1 = outline_box(b)
    size = svg_size(svg_path) if svg_path else None
    if size is None:
        size = (math.floor((x1 - x0) / MIL + 1e-6) * MIL, math.floor((y1 - y0) / MIL + 1e-6) * MIL)
    return (x0, y0), (round(size[0], 4), round(size[1], 4))


class Frame:
    """Board positions <-> the client's frame (origin-relative mm) <-> the design's (mm from the centre)."""

    def __init__(self, origin):
        self.ox, self.oy = origin

    def rel(self, v):
        return [round(v.x / 1e6 - self.ox, 4), round(v.y / 1e6 - self.oy, 4)]

    def kicad(self, x, y):
        return pcbnew.VECTOR2I(pcbnew.FromMM(self.ox + float(x)), pcbnew.FromMM(self.oy + float(y)))

    def design(self, v):
        x, y = K.xy(v)
        return round(x, 4), round(y, 4)


def design_rot(fp):
    """A part's rotation as design.placement has it: board.apply_placement sets
    it, then flips a bottom part, which turns the angle round (r -> -r)."""
    r = fp.GetOrientationDegrees()
    return round((-r if fp.IsFlipped() else r) % 360, 4) % 360


SHAPES = {}
for _k, _v in (('PAD_SHAPE_RECT', 'rect'), ('PAD_SHAPE_RECTANGLE', 'rect'), ('PAD_SHAPE_CIRCLE', 'circle'),
               ('PAD_SHAPE_OVAL', 'oval'), ('PAD_SHAPE_ROUNDRECT', 'roundrect')):
    if hasattr(pcbnew, _k):
        SHAPES[getattr(pcbnew, _k)] = _v


def _bbox(fp):
    try:
        return fp.GetBoundingBox(False, False)
    except TypeError:
        return fp.GetBoundingBox(False)


def _rings(polyset, f):
    """Filled copper as rings in the client's frame, each simplified to at most
    MAX_POINTS points (KiCad's fills are fractured: outlines only)."""
    from shapely.geometry import LineString
    out = []
    for i in range(polyset.OutlineCount()):
        chains = [polyset.Outline(i)] + [polyset.Hole(i, j) for j in range(polyset.HoleCount(i))]
        for c in chains:
            pts = [(c.CPoint(k).x / 1e6 - f.ox, c.CPoint(k).y / 1e6 - f.oy) for k in range(c.PointCount())]
            if len(pts) < 3:
                continue
            # the ring as a line (a fractured fill touches itself, which a
            # polygon simplify mishandles), coarser until it is small enough
            ring = LineString(pts + pts[:1])
            tol = 0.01
            while len(pts) > MAX_POINTS:
                pts = list(ring.simplify(tol, preserve_topology=False).coords)[:-1]
                tol *= 1.5
            if len(pts) >= 3:
                out.append([[round(x, 4), round(y, 4)] for x, y in pts])
    return out


def geometry(b, svg_path=None):
    """BoardGeometry of a loaded board."""
    origin, size = crop(b, svg_path)
    f = Frame(origin)
    name = b.GetLayerName
    tracks, vias = [], []
    for t in b.GetTracks():
        cls = t.GetClass()
        if cls == 'PCB_VIA':
            x, y = f.rel(t.GetPosition())
            vias.append(dict(id=t.m_Uuid.AsString(), x=x, y=y, d=round(t.GetWidth(pcbnew.F_Cu) / 1e6, 4),
                             drill=round(t.GetDrillValue() / 1e6, 4), net=t.GetNetname(),
                             **{'from': name(t.TopLayer()), 'to': name(t.BottomLayer())}))
        elif cls in ('PCB_TRACK', 'PCB_ARC'):
            tr = dict(id=t.m_Uuid.AsString(), layer=name(t.GetLayer()), net=t.GetNetname(),
                      width=round(t.GetWidth() / 1e6, 4), a=f.rel(t.GetStart()), b=f.rel(t.GetEnd()))
            if cls == 'PCB_ARC':
                tr['mid'] = f.rel(t.GetMid())
            tracks.append(tr)
    footprints = []
    for fp in b.GetFootprints():
        bb = _bbox(fp)
        pads = []
        for p in fp.Pads():
            x, y = f.rel(p.GetPosition())
            s = p.GetSize()
            pads.append(dict(num=str(p.GetNumber()), net=p.GetNetname(), x=x, y=y, w=round(s.x / 1e6, 4),
                             h=round(s.y / 1e6, 4), rot=round(p.GetOrientationDegrees() % 360, 4),
                             shape=SHAPES.get(p.GetShape(), 'other'),
                             through=p.GetAttribute() in (pcbnew.PAD_ATTRIB_PTH, pcbnew.PAD_ATTRIB_NPTH)))
        x, y = f.rel(fp.GetPosition())
        footprints.append(dict(ref=fp.GetReference(), x=x, y=y, rot=design_rot(fp),
                               side='bottom' if fp.IsFlipped() else 'top', locked=bool(fp.IsLocked()),
                               bbox=f.rel(bb.GetOrigin()) + f.rel(bb.GetEnd()), pads=pads))
    zones = []
    for z in b.Zones():
        if z.GetIsRuleArea():
            continue
        for lid in z.GetLayerSet().Seq():
            if not pcbnew.IsCopperLayer(lid):
                continue
            rings = _rings(z.GetFilledPolysList(lid), f)
            if rings:
                zones.append(dict(layer=name(lid), net=z.GetNetname(), polygons=rings))
    return dict(units='mm', origin=[round(origin[0], 4), round(origin[1], 4)], size=list(size),
                layers=K.copper_names(b.GetCopperLayerCount()), tracks=tracks, vias=vias, footprints=footprints,
                zones=zones, rules=board_rules(b))


def board_rules(b):
    ds = b.GetDesignSettings()
    nc = ds.m_NetSettings.GetDefaultNetclass()
    mm = lambda v, d: round(v / 1e6, 4) if v and v > 0 else d
    return dict(track_min=mm(ds.m_TrackMinWidth, rules.LIMITS[2]['track']), clearance=mm(nc.GetClearance(), rules.CLEAR),
                via_d=mm(nc.GetViaDiameter(), rules.VIA[0]), via_drill=mm(nc.GetViaDrill(), rules.VIA[1]))


def write(board_path, out_path, svg_path=None):
    with open(out_path, 'w') as fh:
        json.dump(geometry(pcbnew.LoadBoard(board_path), svg_path), fh, separators=(',', ':'))
    return out_path
