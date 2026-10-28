# SPDX-License-Identifier: AGPL-3.0-or-later
"""A via for every SMD pad on a plane net, beside the pad (on the side away
from its part's centre where there is room), joined by a short track.  The
router never sees these nets; the planes and the pours join them.

From offgrid-hardware print-hub/v1/src/power.py fanout(), with the board
outline, the via size and the plane nets taken from the design.
"""
import math

import pcbnew
from shapely.geometry import LineString, Point, Polygon
from shapely.ops import unary_union

from . import kicad as K, rules

CLR = 0.2                      # fanout clearance: a little over the 0.15 mm rule


def _pad_poly(p, layer):
    sh = p.GetEffectivePolygon(layer, pcbnew.ERROR_INSIDE)
    polys = []
    for i in range(sh.OutlineCount()):
        o = sh.Outline(i)
        polys.append(Polygon([K.xy(o.CPoint(k)) for k in range(o.PointCount())]))
    return unary_union(polys)


def _zone_poly(z):
    o = z.Outline().Outline(0)
    return Polygon([K.xy(o.CPoint(k)) for k in range(o.PointCount())])


def rule_areas(b, layer=None):
    """Every keepout on the board, the footprints' own included (an RF
    module's antenna, a sensor's no-copper area)."""
    zs = [z for z in b.Zones() if z.GetIsRuleArea()]
    for fp in b.GetFootprints():
        zs += [z for z in fp.Zones() if z.GetIsRuleArea()]
    return [z for z in zs if z.Outline().OutlineCount() and (layer is None or z.IsOnLayer(layer))]


def fanout(b, nets, corner_radius=0.0):
    """Returns (vias placed, pads that found no spot, pads given a via in the pad)."""
    via_r = rules.VIA[0] / 2
    done, failed, in_pad = 0, [], []
    for side in (pcbnew.F_Cu, pcbnew.B_Cu):
        d, f, i = _fanout_side(b, set(nets), side, via_r, corner_radius)
        done += d; failed += f; in_pad += i
    return done, failed, in_pad


def _fanout_side(b, nets, F, via_r, corner_radius):
    pads, holes = [], []           # every copper pad on this side (THT included); every drilled hole
    for fp in b.GetFootprints():
        for p in fp.Pads():
            if p.IsOnLayer(F) and p.GetAttribute() != pcbnew.PAD_ATTRIB_NPTH:
                pads.append((fp, p, _pad_poly(p, F)))
            if p.GetDrillSize().x > 0:
                holes.append(Point(K.xy(p.GetPosition())).buffer(p.GetDrillSize().x / 2e6))
    edge = K.board_polygon(r=corner_radius).buffer(-(rules.EDGE + via_r))
    keep = [_zone_poly(z) for z in rule_areas(b)]        # a via crosses every layer
    crt_layer = pcbnew.F_CrtYd if F == pcbnew.F_Cu else pcbnew.B_CrtYd
    crts = {}
    for fp in b.GetFootprints():
        c = fp.GetCourtyard(crt_layer)
        if c.OutlineCount():
            o = c.Outline(0)
            if o.PointCount() >= 3:
                crts[fp.GetReference()] = Polygon([K.xy(o.CPoint(k)) for k in range(o.PointCount())]).buffer(0)
    vias, tracks = [], []                     # (geom, net)
    for t in b.GetTracks():
        if t.GetClass() == 'PCB_VIA':
            vias.append((Point(K.xy(t.GetPosition())), t.GetNetname()))
        elif t.GetLayer() == F:
            tracks.append((LineString([K.xy(t.GetStart()), K.xy(t.GetEnd())]).buffer(t.GetWidth() / 2e6),
                           t.GetNetname()))
    zones = [(_zone_poly(z), z.GetNetname()) for z in b.Zones() if not z.GetIsRuleArea() and z.GetLayer() == F]

    def clear(pt, seg, net, ref, strict):
        v = Point(pt).buffer(via_r)
        if not edge.contains(Point(pt)) or any(k.intersects(v) or k.intersects(seg) for k in keep):
            return False
        if any(h.distance(v) < 0.3 for h in holes):
            return False
        for fp2, p2, poly in pads:
            if p2.GetNetname() != net and (poly.distance(v) < CLR or poly.distance(seg) < CLR):
                return False
        for g, n in tracks:
            if n != net and (g.distance(v) < CLR or g.distance(seg) < CLR):
                return False
        for g, n in vias:
            if g.distance(Point(pt)) < 2 * via_r + max(CLR, 0.3 if n == net else CLR):
                return False
        if strict:
            for r, c in crts.items():
                if r != ref and c.intersects(v):
                    return False
        elif any(r != ref and c.buffer(-0.2).contains(Point(pt)) for r, c in crts.items()):
            return False
        return True

    failed, in_pad, done = [], [], 0
    for fp, p, poly in pads:
        net = p.GetNetname()
        if net not in nets or p.GetAttribute() != pcbnew.PAD_ATTRIB_SMD:
            continue
        if any(g.intersects(poly) and n == net for g, n in zones):
            continue                          # in its own net's pour already
        cx, cy = poly.centroid.x, poly.centroid.y
        fx, fy = K.xy(fp.GetPosition())
        away = math.atan2(cy - fy, cx - fx) if (abs(cx - fx) + abs(cy - fy)) > 0.05 else -math.pi / 2
        angs = sorted((away + k * math.pi / 8 for k in range(16)),
                      key=lambda a: abs(math.atan2(math.sin(a - away), math.cos(a - away))))
        w = min(0.4, poly.bounds[2] - poly.bounds[0], poly.bounds[3] - poly.bounds[1])
        spot = None
        for strict in (True, False):
            for a in angs:
                ray = LineString([(cx, cy), (cx + 10 * math.cos(a), cy + 10 * math.sin(a))])
                hit = ray.intersection(poly.exterior)
                r0 = Point(cx, cy).distance(hit) if not hit.is_empty else 0.3
                for extra in (0.1, 0.3, 0.5, 0.8, 1.2):
                    r = r0 + via_r + extra
                    pt = (cx + r * math.cos(a), cy + r * math.sin(a))
                    seg = LineString([(cx, cy), pt]).buffer(w / 2)
                    seg_out = seg.difference(poly.buffer(0.01))
                    if clear(pt, seg_out if not seg_out.is_empty else Point(pt), net, fp.GetReference(), strict):
                        spot = pt
                        break
                if spot:
                    break
            if spot:
                break
        if not spot:
            # no room beside it (an inner ground pad of a QFN, between the
            # switch-node pads): the via goes in the pad when the pad can
            # hold it.  Vias in pads want filling and capping (JLCPCB's POFV
            # option); the build reports each one
            inner = poly.buffer(-(via_r + 0.05))
            q = Point(cx, cy)
            if not inner.is_empty and inner.contains(q) and clear((cx, cy), q, net, fp.GetReference(), False):
                K.via(b, cx, cy, net, *rules.VIA)
                vias.append((q, net))
                in_pad.append('%s.%s' % (fp.GetReference(), p.GetNumber()))
                done += 1
            else:
                failed.append('%s.%s' % (fp.GetReference(), p.GetNumber()))
            continue
        K.track(b, [(cx, cy), spot], w, F, net)
        K.via(b, spot[0], spot[1], net, *rules.VIA)
        vias.append((Point(spot), net))
        tracks.append((LineString([(cx, cy), spot]).buffer(w / 2), net))
        done += 1
    return done, failed, in_pad
