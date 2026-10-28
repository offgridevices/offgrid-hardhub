# SPDX-License-Identifier: AGPL-3.0-or-later
"""Every track corner at 45 degrees or less.

The router leaves 90-degree corners (and a few sharper ones).  Each one is
cut back along both of its tracks and bridged by one short track (a corner
of up to 90 degrees: two turns of half the angle each) or two or three (a
sharper corner: every turn 45 degrees or less).  A bridge is only added
where it keeps the board's clearance to every other net's copper (tracks,
vias, pads, fixed pours); otherwise it is tried shorter, and a corner that
cannot be cut at all is reported.  Corners inside a pad, or at a via or a
junction of three or more tracks, are left alone: the copper there is a
pad, a via ring or a tee, not a bend.

    miter(path)                             cuts the corners in place
    corners(path)                           what corners the board has

From offgrid-hardware print-hub/v1/src/miter.py; vias block every copper
layer of the board, and the ground pour's net is a parameter.
"""
import math
import sys
from collections import defaultdict

import pcbnew
from shapely.geometry import LineString, Point, Polygon
from shapely.strtree import STRtree

from . import kicad as K, rules

CU = [pcbnew.F_Cu, pcbnew.B_Cu]   # set per board in miter() and corners()
LIMIT = 45.0 + 0.5       # degrees: the largest turn left as it is
MAX_CUT = 1.0            # mm: the longest bridge track
SHARE = 0.45             # a corner may use at most this much of a track that bends at both ends
SHARE_FREE = 0.9         # ... and this much of one whose other end is a pad, a via, a tee or straight


def _polys(item, layer):
    ps = pcbnew.SHAPE_POLY_SET()
    item.TransformShapeToPolygon(ps, layer, 0, 2000, pcbnew.ERROR_OUTSIDE)
    out = []
    for i in range(ps.OutlineCount()):
        ol = ps.Outline(i)
        pts = [(ol.CPoint(k).x / 1e6, ol.CPoint(k).y / 1e6) for k in range(ol.PointCount())]
        if len(pts) >= 3:
            out.append(Polygon(pts).buffer(0))
    return out


def _graph(b):
    """(net, layer) -> {point: [(track, which end)]} for every track."""
    g = defaultdict(lambda: defaultdict(list))
    for t in b.GetTracks():
        if t.GetClass() != 'PCB_TRACK':
            continue
        for k, p in (('s', t.GetStart()), ('e', t.GetEnd())):
            g[(t.GetNetname(), t.GetLayer())][(p.x, p.y)].append((t, k))
    return g


def _dir(t, k):
    """Unit vector pointing away from end k of track t, and the track length (mm)."""
    a, e = (t.GetStart(), t.GetEnd()) if k == 's' else (t.GetEnd(), t.GetStart())
    dx, dy = (e.x - a.x) / 1e6, (e.y - a.y) / 1e6
    L = math.hypot(dx, dy)
    return (dx / L, dy / L) if L else (0.0, 0.0), L


def _turn(u, v):
    """Turn, degrees, between arriving along -u and leaving along v."""
    c = max(-1.0, min(1.0, -(u[0] * v[0] + u[1] * v[1])))
    return math.degrees(math.acos(c))


def _blocked_points(b):
    """Points where a corner is not a bend: vias, and inside pads (per net, layer)."""
    vias = defaultdict(list)
    for t in b.GetTracks():
        if t.GetClass() == 'PCB_VIA':
            q = t.GetPosition()
            vias[t.GetNetname()].append(Point(q.x / 1e6, q.y / 1e6).buffer(t.GetWidth(pcbnew.F_Cu) / 2e6))
    pads = defaultdict(list)
    for fp in b.GetFootprints():
        for p in fp.Pads():
            for layer in CU:
                if p.IsOnLayer(layer):
                    pads[(p.GetNetname(), layer)] += _polys(p, layer)
    return vias, pads


def corners(path_or_board):
    """Every bend: list of (turn degrees, net, layer name, x, y) in board mm
    (centre origin).  Bends inside a pad, at a via or where a third track
    joins are not counted."""
    b = pcbnew.LoadBoard(path_or_board) if isinstance(path_or_board, str) else path_or_board
    global CU
    CU = K.copper_ids(b.GetCopperLayerCount())
    vias, pads = _blocked_points(b)
    out = []
    for (net, layer), pts in _graph(b).items():
        lines = {}
        for ends in pts.values():
            for t, _ in ends:
                lines[id(t)] = (t, LineString([(t.GetStart().x / 1e6, t.GetStart().y / 1e6),
                                               (t.GetEnd().x / 1e6, t.GetEnd().y / 1e6)]))
        for (x, y), ends in pts.items():
            if len(ends) != 2:
                continue
            P_ = Point(x / 1e6, y / 1e6)
            if any(s.contains(P_) for s in pads.get((net, layer), [])) or any(v.contains(P_) for v in vias.get(net, [])):
                continue
            w = max(t.GetWidth() for t, _ in ends) / 1e6
            mine = {id(t) for t, _ in ends}
            if any(k not in mine and ln.distance(P_) < (w + t.GetWidth() / 1e6) / 2 for k, (t, ln) in lines.items()):
                continue                         # a third track joins here: a tee, not a bend
            (u, _), (v, _) = _dir(*ends[0]), _dir(*ends[1])
            out.append((_turn(u, v), net, b.GetLayerName(layer), x / 1e6 - K.CX, y / 1e6 - K.CY))
    return out


def _bridge(node, u, v, ang, sign, s):
    """Points from the cut on the first track to the cut on the second: k
    bridge tracks of length s, every turn ang / (k + 1)."""
    k = max(1, math.ceil(ang / 45.0 - 1e-6) - 1)
    step = math.radians(ang) / (k + 1) * sign
    d0 = (-u[0], -u[1])                        # direction of travel arriving at the corner
    dirs = []
    for i in range(1, k + 1):
        c, s_ = math.cos(step * i), math.sin(step * i)
        dirs.append((d0[0] * c - d0[1] * s_, d0[0] * s_ + d0[1] * c))
    sx, sy = sum(d[0] for d in dirs) * s, sum(d[1] for d in dirs) * s
    # node - a*d0 + (sx, sy) = node + c2*v  ->  a*d0 + c2*v = (sx, sy)
    det = d0[0] * v[1] - d0[1] * v[0]
    if abs(det) < 1e-9:
        return None
    a = (sx * v[1] - sy * v[0]) / det
    c2 = (d0[0] * sy - d0[1] * sx) / det
    if a <= 0 or c2 <= 0:
        return None
    p = (node[0] - a * d0[0], node[1] - a * d0[1])
    pts = [p]
    for d in dirs:
        p = (p[0] + d[0] * s, p[1] + d[1] * s)
        pts.append(p)
    return pts, a, c2


def miter(path, clearance=rules.CLEAR, ground='GND'):
    b = pcbnew.LoadBoard(path)
    global CU
    CU = K.copper_ids(b.GetCopperLayerCount())
    vias, pads = _blocked_points(b)
    # other nets' copper per layer, as shapes with their net
    obst = defaultdict(list)
    for t in b.GetTracks():
        lays = CU if t.GetClass() == 'PCB_VIA' else [t.GetLayer()]
        for layer in lays:
            for s in _polys(t, layer):
                obst[layer].append((s, t.GetNetname()))
    for (net, layer), ss in pads.items():
        for s in ss:
            obst[layer].append((s, net))
    for z in b.Zones():
        if z.GetIsRuleArea() or z.GetNetname() == ground:
            continue                            # the ground fill is poured afterwards, around the tracks
        for layer in CU:
            if z.IsOnLayer(layer):
                ol = z.Outline()
                for i in range(ol.OutlineCount()):
                    o = ol.Outline(i)
                    obst[layer].append((Polygon([(o.CPoint(k).x / 1e6, o.CPoint(k).y / 1e6)
                                                 for k in range(o.PointCount())]).buffer(0), z.GetNetname()))
    trees = {l: (STRtree([s for s, _ in v]), v) for l, v in obst.items()}

    def clear(line, width, net, layer):
        if layer not in trees:
            return True
        tree, items = trees[layer]
        g = line.buffer(width / 2 + clearance + 0.005, cap_style=1)
        for i in tree.query(g):
            s, n = items[int(i)]
            if n != net and s.intersects(g):
                return False
        return True

    graph = _graph(b)

    def tee(t1, k1, a, t2, k2, c2):
        """Does other copper of the net join either track on the part a
        corner cut would remove (a track ending mid-way along it)?"""
        net, layer = t1.GetNetname(), t1.GetLayer()
        cut = []
        for t, k, L in ((t1, k1, a), (t2, k2, c2)):
            (u, _), p = _dir(t, k), (t.GetStart() if k == 's' else t.GetEnd())
            p = (p.x / 1e6, p.y / 1e6)
            cut.append(LineString([p, (p[0] + u[0] * (L + 0.01), p[1] + u[1] * (L + 0.01))]).buffer(t.GetWidth() / 2e6))
        node = t1.GetStart() if k1 == 's' else t1.GetEnd()
        for (x, y), ends in graph[(net, layer)].items():
            if (x, y) == (node.x, node.y) or all(t in (t1, t2) for t, _ in ends):
                continue
            if any(c.contains(Point(x / 1e6, y / 1e6)) for c in cut):
                return True
        return any(c.intersects(v) for c in cut for v in vias.get(net, []))

    def share(t, k, pts):
        """How much of track t a corner at its end k may use: less when its
        other end is a bend that needs cutting too."""
        o = t.GetEnd() if k == 's' else t.GetStart()
        ends = pts.get((o.x, o.y), [])
        if len(ends) != 2:
            return SHARE_FREE
        q = Point(o.x / 1e6, o.y / 1e6)
        if any(sh.contains(q) for sh in pads.get((t.GetNetname(), t.GetLayer()), [])) or \
                any(v_.contains(q) for v_ in vias.get(t.GetNetname(), [])):
            return SHARE_FREE
        (ua, _), (ub, _) = _dir(*ends[0]), _dir(*ends[1])
        return SHARE if _turn(ua, ub) > LIMIT else SHARE_FREE

    done = failed = 0
    left = []
    for (net, layer), pts in graph.items():
        for (x, y), ends in list(pts.items()):
            if len(ends) != 2:
                continue
            (t1, k1), (t2, k2) = ends
            node = (x / 1e6, y / 1e6)
            P_ = Point(node)
            if any(s.contains(P_) for s in pads.get((net, layer), [])) or any(v.contains(P_) for v in vias.get(net, [])):
                continue
            (u, L1), (v, L2) = _dir(t1, k1), _dir(t2, k2)
            ang = _turn(u, v)
            if ang <= LIMIT:
                continue
            wide = max((t1, t2), key=lambda t: t.GetWidth())
            w = wide.GetWidth() / 1e6
            why = 'too short'
            sign = 1 if (-u[0]) * v[1] - (-u[1]) * v[0] > 0 else -1
            ok = False
            s = MAX_CUT
            f1, f2 = share(t1, k1, pts), share(t2, k2, pts)
            while s >= 0.02:
                r = _bridge(node, u, v, ang, sign, s)
                if r is None:
                    break
                bpts, a, c2 = r
                if a > f1 * L1 or c2 > f2 * L2:
                    s *= min(f1 * L1 / a, f2 * L2 / c2) * 0.999
                    continue
                if tee(t1, k1, a, t2, k2, c2):
                    why = 'joint'
                elif not clear(LineString(bpts), w, net, layer):
                    why = 'clearance'
                else:
                    ok = True
                    break
                s *= 0.7
            if not ok:
                failed += 1
                left.append((why, round(ang), net, b.GetLayerName(layer), round(node[0] - K.CX, 2), round(node[1] - K.CY, 2)))
                continue
            V = lambda q: pcbnew.VECTOR2I(int(round(q[0] * 1e6)), int(round(q[1] * 1e6)))
            (t1.SetStart if k1 == 's' else t1.SetEnd)(V(bpts[0]))
            (t2.SetStart if k2 == 's' else t2.SetEnd)(V(bpts[-1]))
            chain = bpts
            for a_, e_ in zip(chain, chain[1:]):
                t = pcbnew.PCB_TRACK(b)
                t.SetStart(V(a_)); t.SetEnd(V(e_))
                t.SetWidth(wide.GetWidth()); t.SetLayer(layer); t.SetNet(t1.GetNet())
                t.SetLocked(t1.IsLocked())
                b.Add(t)
            done += 1
    b.Save(path)
    return done, failed, left


