# SPDX-License-Identifier: AGPL-3.0-or-later
"""Ground fill on the outer layers after routing, and stitching vias.

The fills on F.Cu and B.Cu take every bit of free copper; a via every few
millimetres wherever both fills are ground ties them (and any ground plane
between them) together, so no fill is an island and every return path is
short.  From offgrid-hardware print-hub/v1/src/stitch.py.
"""
import pcbnew
from shapely.geometry import Point, Polygon
from shapely.ops import unary_union

from . import kicad as K, rules

PITCH = 3.0          # stitching grid, mm


def _filled(z, layer):
    sh = z.GetFilledPolysList(layer)
    polys = []
    for i in range(sh.OutlineCount()):
        o = sh.Outline(i)
        holes = [[K.xy(sh.Hole(i, h).CPoint(k)) for k in range(sh.Hole(i, h).PointCount())]
                 for h in range(sh.HoleCount(i))]
        polys.append(Polygon([K.xy(o.CPoint(k)) for k in range(o.PointCount())], holes))
    return unary_union(polys) if polys else Polygon()


def pour_and_stitch(path, net, corner_radius=0.0):
    """Returns the number of stitching vias placed."""
    b = pcbnew.LoadBoard(path)
    e = 0.5
    full = K.rounded_rect(K.G.hx - e, K.G.hy - e, max(0.0, corner_radius - e))
    zs = []
    for l in (pcbnew.F_Cu, pcbnew.B_Cu):
        z = K.zone(b, net, l, full, clearance=0.25, name='%s fill' % net, priority=0)
        # reflowed board: SMD pads solid into the fill, plated holes on spokes
        z.SetPadConnection(pcbnew.ZONE_CONNECTION_THT_THERMAL)
        zs.append(z)
    pcbnew.ZONE_FILLER(b).Fill(b.Zones())
    both = _filled(zs[0], pcbnew.F_Cu).intersection(_filled(zs[1], pcbnew.B_Cu)).buffer(-(rules.VIA[0] / 2 + 0.25))
    rule_areas = [z for z in b.Zones() if z.GetIsRuleArea()]
    keep = unary_union([Polygon([K.xy(z.Outline().Outline(0).CPoint(k))
                                 for k in range(z.Outline().Outline(0).PointCount())])
                        for z in rule_areas]).buffer(0.5) if rule_areas else Polygon()
    vias = [Point(K.xy(t.GetPosition())) for t in b.GetTracks() if t.GetClass() == 'PCB_VIA']
    holes = [Point(K.xy(p.GetPosition())).buffer(p.GetDrillSize().x / 2e6 + 0.5)
             for fp in b.GetFootprints() for p in fp.Pads() if p.GetDrillSize().x > 0]
    n = 0
    y = -K.G.hy + 1.5
    while y < K.G.hy - 1.0:
        x = -K.G.hx + 1.5
        while x < K.G.hx - 1.0:
            q = Point(x, y)
            if both.contains(q) and not keep.contains(q) and all(v.distance(q) > 1.5 for v in vias) \
                    and not any(h.contains(q) for h in holes):
                K.via(b, x, y, net, *rules.VIA)
                vias.append(q)
                n += 1
            x += PITCH
        y += PITCH
    pcbnew.ZONE_FILLER(b).Fill(b.Zones())
    b.Save(path)
    return n
