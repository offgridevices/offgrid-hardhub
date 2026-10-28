# SPDX-License-Identifier: AGPL-3.0-or-later
"""Board primitives on top of KiCad's pcbnew: coordinates, nets, zones,
rule areas, tracks, vias, net classes, DRC.

Coordinates are millimetres from the board centre, x to the right, y down
(KiCad's own direction), as in the design document.  KiCad itself gets the
board centred at (100, 100) mm on its page.

Generalised from offgrid-hardware print-hub/v1/src/pcb.py: the board size
is no longer a constant but set once per process by set_board().
"""
import json
import os
import subprocess

import pcbnew

MM = pcbnew.FromMM
CX, CY = 100.0, 100.0


class _Geo:
    w = h = 0.0

    @property
    def hx(self):
        return self.w / 2

    @property
    def hy(self):
        return self.h / 2


G = _Geo()


def set_board(w, h):
    G.w, G.h = float(w), float(h)


def P(x, y):
    return pcbnew.VECTOR2I(MM(CX + x), MM(CY + y))


def xy(v):
    """KiCad position -> board mm."""
    return v.x / 1e6 - CX, v.y / 1e6 - CY


def copper_ids(n):
    """KiCad layer ids of an n-layer board, top to bottom."""
    return [pcbnew.F_Cu] + [getattr(pcbnew, 'In%d_Cu' % i) for i in range(1, n - 1)] + [pcbnew.B_Cu]


def copper_names(n):
    return ['F.Cu'] + ['In%d.Cu' % i for i in range(1, n - 1)] + ['B.Cu']


def layer_id(name):
    return getattr(pcbnew, name.replace('.', '_'))


# KiCad 10's Python bindings: keep a reference to anything removed from a
# board, or a later LoadBoard() in the same process returns broken objects
# (offgrid-hardware docs/lessons.md).
_REMOVED = []


def remove(b, item):
    b.Remove(item)
    _REMOVED.append(item)


def add_net(b, name):
    n = b.FindNet(name)
    if n is None:
        n = pcbnew.NETINFO_ITEM(b, name)
        b.Add(n)
    return n


def rect(x0, y0, x1, y1):
    return [(x0, y0), (x1, y0), (x1, y1), (x0, y1)]


def rounded_rect(hx, hy, r, steps=8):
    """Outline points of a centred rectangle with corner radius r."""
    import math
    if r <= 0:
        return rect(-hx, -hy, hx, hy)
    pts = []
    for cx, cy, a0 in ((hx - r, -hy + r, -90), (hx - r, hy - r, 0), (-hx + r, hy - r, 90), (-hx + r, -hy + r, 180)):
        for k in range(steps + 1):
            a = math.radians(a0 + 90 * k / steps)
            pts.append((cx + r * math.cos(a), cy + r * math.sin(a)))
    return pts


def outline(b, r=0.0):
    """Edge.Cuts: straight edges and true arcs at the corners."""
    hx, hy = G.hx, G.hy
    r = min(r, hx, hy)

    def seg(a, c):
        s = pcbnew.PCB_SHAPE(b, pcbnew.SHAPE_T_SEGMENT)
        s.SetStart(P(*a)); s.SetEnd(P(*c))
        s.SetLayer(pcbnew.Edge_Cuts); s.SetWidth(MM(0.1))
        b.Add(s)

    if r <= 0:
        pts = rect(-hx, -hy, hx, hy)
        for a, c in zip(pts, pts[1:] + pts[:1]):
            seg(a, c)
        return
    seg((-hx + r, -hy), (hx - r, -hy)); seg((hx, -hy + r), (hx, hy - r))
    seg((hx - r, hy), (-hx + r, hy)); seg((-hx, hy - r), (-hx, -hy + r))
    for cx, cy, sx, sy in ((hx - r, -hy + r, hx - r, -hy), (hx - r, hy - r, hx, hy - r),
                           (-hx + r, hy - r, -hx + r, hy), (-hx + r, -hy + r, -hx, -hy + r)):
        a = pcbnew.PCB_SHAPE(b, pcbnew.SHAPE_T_ARC)
        a.SetCenter(P(cx, cy)); a.SetStart(P(sx, sy)); a.SetArcAngleAndEnd(pcbnew.EDA_ANGLE(90, pcbnew.DEGREES_T))
        a.SetLayer(pcbnew.Edge_Cuts); a.SetWidth(MM(0.1))
        b.Add(a)


def board_polygon(inset=0.0, r=0.0):
    from shapely.geometry import Polygon
    return Polygon(rounded_rect(G.hx, G.hy, r)).buffer(-inset) if inset else Polygon(rounded_rect(G.hx, G.hy, r))


def zone(b, net, layer, poly, clearance=0.25, min_width=0.2, priority=0, thermal=True, name=None,
         spoke=0.4, gap=0.3):
    z = pcbnew.ZONE(b)
    z.SetLayer(layer)
    if net:
        z.SetNet(add_net(b, net))
    ol = z.Outline(); ol.NewOutline()
    for (x, y) in poly:
        ol.Append(MM(CX + x), MM(CY + y))
    z.SetLocalClearance(MM(clearance))
    z.SetMinThickness(MM(min_width))
    z.SetAssignedPriority(priority)
    z.SetPadConnection(pcbnew.ZONE_CONNECTION_THERMAL if thermal else pcbnew.ZONE_CONNECTION_FULL)
    z.SetThermalReliefSpokeWidth(MM(spoke)); z.SetThermalReliefGap(MM(gap))
    z.SetIslandRemovalMode(pcbnew.ISLAND_REMOVAL_MODE_ALWAYS)
    if name:
        z.SetZoneName(name)
    b.Add(z)
    return z


def rule_area(b, poly, layers, tracks=True, vias=True, pads=False, pours=True, footprints=False, name=None):
    z = pcbnew.ZONE(b)
    z.SetIsRuleArea(True)
    ls = pcbnew.LSET()
    for l in layers:
        ls.AddLayer(l)
    z.SetLayerSet(ls)
    ol = z.Outline(); ol.NewOutline()
    for (x, y) in poly:
        ol.Append(MM(CX + x), MM(CY + y))
    z.SetDoNotAllowTracks(tracks); z.SetDoNotAllowVias(vias)
    z.SetDoNotAllowPads(pads); z.SetDoNotAllowZoneFills(pours)
    z.SetDoNotAllowFootprints(footprints)
    if name:
        z.SetZoneName(name)
    b.Add(z)
    return z


def via(b, x, y, net, d, drill, locked=True):
    v = pcbnew.PCB_VIA(b)
    v.SetPosition(P(x, y)); v.SetWidth(MM(d)); v.SetDrill(MM(drill))
    v.SetNet(add_net(b, net))
    v.SetLocked(locked)
    b.Add(v)
    return v


def track(b, pts, width, layer, net, locked=True):
    for a, c in zip(pts, pts[1:]):
        t = pcbnew.PCB_TRACK(b)
        t.SetStart(P(*a)); t.SetEnd(P(*c)); t.SetWidth(MM(width))
        t.SetLayer(layer); t.SetNet(add_net(b, net))
        t.SetLocked(locked)
        b.Add(t)


def netclass(b, name, nets, width, clearance, via_d, via_drill):
    ns = b.GetDesignSettings().m_NetSettings
    nc = pcbnew.NETCLASS(name)
    nc.SetTrackWidth(MM(width)); nc.SetClearance(MM(clearance))
    nc.SetViaDiameter(MM(via_d)); nc.SetViaDrill(MM(via_drill))
    ns.SetNetclass(name, nc)
    for n in nets:
        ns.SetNetclassPatternAssignment(n, name)
        ni = b.FindNet(n)
        if ni is not None:
            ni.SetNetClass(ns.GetNetClassByName(name))
    return nc


def drc(path, out_json):
    """KiCad DRC with zones refilled; returns (errors, warnings, unconnected)."""
    subprocess.run(['kicad-cli', 'pcb', 'drc', '--refill-zones', '--save-board', '--severity-all',
                    '--format', 'json', '-o', out_json, path], capture_output=True)
    r = json.load(open(out_json))
    errs = [v for v in r['violations'] if v['severity'] == 'error']
    warns = [v for v in r['violations'] if v['severity'] != 'error']
    return errs, warns, r['unconnected_items']


def text(b, s, x, y, size=1.0, layer=pcbnew.F_SilkS, rot=0, thick=0.15):
    t = pcbnew.PCB_TEXT(b)
    t.SetText(s); t.SetPosition(P(x, y)); t.SetLayer(layer)
    t.SetTextSize(pcbnew.VECTOR2I(MM(size), MM(size))); t.SetTextThickness(MM(thick))
    t.SetTextAngleDegrees(rot)
    if layer in (pcbnew.B_SilkS, pcbnew.B_Cu):
        t.SetMirrored(True)
    b.Add(t)
    return t


def courtyard(fp, side_layer=None):
    """A footprint's courtyard as a shapely polygon in board mm (its pad
    box grown by 0.25 mm when the footprint has none)."""
    from shapely.geometry import Polygon, box
    from shapely.ops import unary_union
    layer = side_layer if side_layer is not None else (pcbnew.B_CrtYd if fp.IsFlipped() else pcbnew.F_CrtYd)
    c = fp.GetCourtyard(layer)
    polys = []
    for i in range(c.OutlineCount()):
        o = c.Outline(i)
        if o.PointCount() >= 3:
            polys.append(Polygon([xy(o.CPoint(k)) for k in range(o.PointCount())]).buffer(0))
    if polys:
        return unary_union(polys)
    bb = fp.GetBoundingBox(False)
    x0, y0 = xy(bb.GetOrigin()); x1, y1 = xy(bb.GetEnd())
    return box(x0, y0, x1, y1).buffer(0.25, join_style=2)
