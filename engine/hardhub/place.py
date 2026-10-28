# SPDX-License-Identifier: AGPL-3.0-or-later
"""Automatic placement for the parts a design leaves unplaced.

A first placement good enough to route and to look at, not a finished one:
the AI (or a person) then moves what matters and locks it.  The order:

  1. connectors go to the board edges, mouth outward; identical connectors
     share an edge, the biggest group the longest free edge
  2. each block's biggest part (its anchor) goes where its connections to
     already placed parts pull it, else towards the board centre
  3. every other part goes as near as it can to the pads it connects to
     (signal nets count fully, power nets half, ground and planes not at
     all: they connect everything, so they say nothing about where)

Every candidate spot keeps the courtyard inside the board and clear of
every other courtyard, the mounting holes and the keepouts.  Courtyards are
worked out once per part at the origin and moved with shapely, which is
far faster than asking KiCad for each candidate.
"""
import math

import pcbnew
from shapely import affinity
from shapely.geometry import Point, box
from shapely.ops import unary_union
from shapely.strtree import STRtree

from . import design as D, kicad as K

GAP = 0.4              # between courtyards (they carry 0.25 mm round the body): a routing channel
IC_RING = 1.0          # extra room round ICs and modules: their pins need escape tracks and vias
EDGE_IN = 0.3          # courtyard to board edge (copper-to-edge rule)
STEP = 0.5             # search grid, mm
ROTS = (0, 90, 180, 270)


def _local(fp):
    """Courtyard polygon and pad offsets of fp at the origin, rotation 0,
    top side.  KiCad keeps courtyards in board coordinates, so the part is
    put at the origin first."""
    pos, rot, flipped = fp.GetPosition(), fp.GetOrientationDegrees(), fp.IsFlipped()
    fp.SetOrientationDegrees(0)
    fp.SetPosition(K.P(0, 0))
    fp.BuildCourtyardCaches()
    cy = K.courtyard(fp, pcbnew.B_CrtYd if flipped else pcbnew.F_CrtYd)
    pads = {}
    for p in fp.Pads():
        if p.GetNumber():
            pads.setdefault(p.GetNumber(), K.xy(p.GetPosition()))
    fp.SetPosition(pos); fp.SetOrientationDegrees(rot)
    return cy, pads


def _rot(geom, deg):
    # KiCad's positive orientation turns a part counter-clockwise as seen on
    # screen (y down), which is clockwise in shapely's y-up sense
    return affinity.rotate(geom, -deg, origin=(0, 0)) if deg else geom


def _rotpt(p, deg):
    a = math.radians(-deg)
    # y down: screen-counter-clockwise rotation by deg
    a = math.radians(deg)
    x, y = p
    return (x * math.cos(a) + y * math.sin(a), -x * math.sin(a) + y * math.cos(a))


class Placer:
    def __init__(self, b, d, fps):
        self.d = d
        bd = d['board']
        self.edge = K.board_polygon(r=bd['corner_radius'])
        self.inner = self.edge.buffer(-EDGE_IN)
        self.fps = fps
        self.local = {r: _local(fp) for r, fp in fps.items()}
        self.comp = {c['ref']: c for c in d['components']}
        self.blocked = []
        for fp in b.GetFootprints():                       # mounting holes
            if fp.GetReference().startswith('MH'):
                self.blocked.append(K.courtyard(fp))
        for k in bd.get('keepouts', []):
            x0, y0, x1, y1 = k['rect']
            self.blocked.append(box(min(x0, x1), min(y0, y1), max(x0, x1), max(y0, y1)))
        self.pos = {}                                       # ref -> (x, y, rot)
        self.shapes = []
        for ref, pl in d['placement'].items():
            if ref in fps:
                self._commit(ref, pl['x'], pl['y'], pl.get('rot', 0), pl.get('side', 'top'))
        skip = set(D.plane_nets(d))
        g = D.ground_net(d)
        if g:
            skip.add(g)
        self.weight = {}
        for name in D.nets(d):
            kind = d['nets'].get(name, {}).get('kind', 'signal')
            self.weight[name] = 0.0 if (name in skip or kind == 'ground') else (0.5 if kind == 'power' else 1.0)

    # ------------------------------------------------------------ geometry
    def shape(self, ref, x, y, rot):
        cy = _rot(self.local[ref][0], rot)
        kind = self.kind(ref)
        grow = GAP / 2 + (IC_RING if kind in ('U', 'MOD') else 0.0)
        return affinity.translate(cy, x, y).buffer(grow, join_style=2)

    def pad_xy(self, ref, num):
        if ref in self.pos:
            x, y, rot, *_ = self.pos[ref]
            px, py = _rotpt(self.local[ref][1][num], rot)
            return (x + px, y + py)
        return None

    def kind(self, ref):
        return self.d['parts'][self.comp[ref]['part']]['kind'] if ref in self.comp else 'H'

    def area(self, ref):
        return self.local[ref][0].area

    def free(self, ref, x, y, rot, tree, edge_ok=False):
        s = self.shape(ref, x, y, rot)
        core = affinity.translate(_rot(self.local[ref][0], rot), x, y)
        if not (self.edge if edge_ok else self.inner).contains(core):
            return None
        if any(bk.intersects(s) for bk in self.blocked):
            return None
        if tree is not None:
            for i in tree.query(s):
                if self.shapes[int(i)].intersects(s):
                    return None
        return s

    def tree(self):
        return STRtree(self.shapes) if self.shapes else None

    def _commit(self, ref, x, y, rot, side='top'):
        self.pos[ref] = (x, y, rot, side)
        self.shapes.append(self.shape(ref, x, y, rot))

    # ------------------------------------------------------------ targets
    def target(self, ref):
        """Weighted centroid of placed pads this part connects to."""
        sx = sy = w = 0.0
        for pad, net in self.comp[ref]['pins'].items():
            if not net or self.weight.get(net, 0) == 0:
                continue
            for r2, p2 in D.nets(self.d).get(net, []):
                if r2 == ref or r2 not in self.pos:
                    continue
                q = self.pad_xy(r2, p2)
                if q:
                    k = self.weight[net]
                    sx += q[0] * k; sy += q[1] * k; w += k
        return (sx / w, sy / w) if w else None

    def links(self, ref):
        return sum(self.weight.get(n, 0) for n in self.comp[ref]['pins'].values() if n)

    def search(self, ref, tx, ty, rots=ROTS, rmax=None):
        """Nearest free spot to (tx, ty), ring by ring; within a ring the
        rotation that brings the part's connected pads closest wins."""
        tree = self.tree()
        rmax = rmax or math.hypot(K.G.w, K.G.h)
        r = 0.0
        while r <= rmax:
            n = 1 if r == 0 else max(8, int(2 * math.pi * r / STEP))
            best = None
            for i in range(n):
                a = 2 * math.pi * i / n
                x, y = round((tx + r * math.cos(a)) / 0.05) * 0.05, round((ty + r * math.sin(a)) / 0.05) * 0.05
                for rot in rots:
                    if self.free(ref, x, y, rot, tree) is None:
                        continue
                    score = math.hypot(x - tx, y - ty) + self.wire(ref, x, y, rot)
                    if best is None or score < best[0]:
                        best = (score, x, y, rot)
            if best:
                return best[1:]
            r += STEP
        return None

    def wire(self, ref, x, y, rot):
        """Rough wire length from this part's pads to placed pads on the same nets."""
        tot = 0.0
        for pad, net in self.comp[ref]['pins'].items():
            k = self.weight.get(net, 0) if net else 0
            if not k or pad not in self.local[ref][1]:
                continue
            px, py = _rotpt(self.local[ref][1][pad], rot)
            px += x; py += y
            ds = [math.hypot(px - q[0], py - q[1]) for r2, p2 in D.nets(self.d)[net]
                  if r2 != ref and r2 in self.pos for q in [self.pad_xy(r2, p2)] if q]
            if ds:
                tot += k * min(ds)
        return tot * 0.5

    # ------------------------------------------------------------ steps
    def connectors(self, todo):
        groups = {}
        for ref in todo:
            if self.kind(ref) == 'J':
                groups.setdefault(self.comp[ref]['part'], []).append(ref)
        if not groups:
            return
        hx, hy = K.G.hx, K.G.hy
        edges = {'bottom': (0, 1), 'top': (0, -1), 'left': (-1, 0), 'right': (1, 0)}
        length = {'bottom': K.G.w, 'top': K.G.w, 'left': K.G.h, 'right': K.G.h}
        used = {e: 0.0 for e in edges}
        for part, refs in sorted(groups.items(), key=lambda g: -len(g[1]) * self.local[g[1][0]][0].length):
            cy, pads = self.local[refs[0]]
            pc = (sum(p[0] for p in pads.values()) / len(pads), sum(p[1] for p in pads.values()) / len(pads)) \
                if pads else (0, 0)
            mouth = (cy.centroid.x - pc[0], cy.centroid.y - pc[1])
            if math.hypot(*mouth) < 0.2:
                mouth = (0, -1)
            for e in sorted(edges, key=lambda e: used[e] / length[e]):
                n = edges[e]
                rot = max(ROTS, key=lambda r: (lambda m: m[0] * n[0] + m[1] * n[1])(_rotpt(mouth, r)))
                s = _rot(cy, rot)
                minx, miny, maxx, maxy = s.bounds
                along = (maxx - minx) if n[1] else (maxy - miny)
                pitch = along + 1.0
                if used[e] + pitch * len(refs) > length[e] - 4:
                    continue
                # flush with the edge, the group centred along it
                if e == 'bottom':
                    fixed = hy - maxy
                elif e == 'top':
                    fixed = -hy - miny
                elif e == 'left':
                    fixed = -hx - minx
                else:
                    fixed = hx - maxx
                start = -pitch * (len(refs) - 1) / 2
                ok = True
                spots = []
                tree = self.tree()
                for i, ref in enumerate(refs):
                    t = start + i * pitch
                    x, y = (t, fixed) if n[1] else (fixed, t)
                    if self.free(ref, x, y, rot, tree, edge_ok=True) is None:
                        ok = False
                        break
                    spots.append((ref, x, y))
                if not ok:
                    # slide along the edge one by one instead
                    spots = []
                    for ref in refs:
                        found = None
                        for k in range(0, int(length[e] / STEP)):
                            t = (k // 2 + 1) * STEP * (1 if k % 2 else -1) if k else 0.0
                            x, y = (t, fixed) if n[1] else (fixed, t)
                            if self.free(ref, x, y, rot, self.tree(), edge_ok=True) is not None:
                                found = (ref, x, y)
                                break
                        if not found:
                            break
                        self._commit(found[0], found[1], found[2], rot)
                        spots.append(found)
                    if len(spots) == len(refs):
                        used[e] += pitch * len(refs)
                        break
                    for ref, *_ in spots:                     # undo a partial group
                        del self.pos[ref]
                    self.shapes = [self.shape(r, *self.pos[r][:3]) for r in self.pos]
                    continue
                for ref, x, y in spots:
                    self._commit(ref, x, y, rot)
                used[e] += pitch * len(refs)
                break

    def run(self):
        todo = [r for r in self.fps if r not in self.pos]
        self.connectors(todo)
        todo = [r for r in todo if r not in self.pos]
        blocks = {}
        for r in todo:
            blocks.setdefault(self.comp[r]['block'], []).append(r)
        anchors = []
        for blk, refs in sorted(blocks.items(), key=lambda kv: -sum(self.area(r) for r in kv[1])):
            big = max(refs, key=self.area)
            if self.kind(big) in ('U', 'MOD', 'L', 'Q', 'D', 'SW', 'J', 'other') or len(refs) == 1:
                anchors.append(big)
        for ref in anchors:
            t = self.target(ref) or (0.0, 0.0)
            spot = self.search(ref, *t)
            if spot is None:
                raise PlacementError('no room on the board for %s' % ref)
            self._commit(ref, *spot)
        rest = [r for r in todo if r not in self.pos]
        while rest:
            # the part most tied to what is already placed goes next
            rest.sort(key=lambda r: (-(self.target(r) is not None), -self.links(r), -self.area(r)))
            ref = rest.pop(0)
            t = self.target(ref)
            if t is None:
                mates = [self.pos[r][:2] for r in self.pos if r in self.comp and self.comp[r]['block'] == self.comp[ref]['block']]
                t = (sum(m[0] for m in mates) / len(mates), sum(m[1] for m in mates) / len(mates)) if mates else (0.0, 0.0)
            spot = self.search(ref, *t)
            if spot is None:
                raise PlacementError('no room on the board for %s' % ref)
            self._commit(ref, *spot)


class PlacementError(Exception):
    pass


def auto(b, d, fps):
    """Place every unplaced part; returns ref -> {x, y, rot, side} for them."""
    todo = [r for r in fps if r not in d['placement']]
    if not todo:
        return {}
    p = Placer(b, d, fps)
    p.run()
    out = {}
    for ref in todo:
        x, y, rot, side = p.pos[ref]
        fps[ref].SetPosition(K.P(x, y))
        fps[ref].SetOrientationDegrees(rot)
        out[ref] = dict(x=round(x, 3), y=round(y, 3), rot=rot, side=side)
    return out
