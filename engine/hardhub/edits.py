# SPDX-License-Identifier: AGPL-3.0-or-later
"""A person's hand edits to a routed board, as KiCad's own editor makes them
(packages/protocol/src/board.ts, BoardEdit):

    set_track   move a track's ends, change its width or layer
    add_track   draw a straight track; its net from what its ends touch
    set_via     move a via
    add_via     a through via; its net from what it touches
    delete      a track or a via
    move_part   a part's position, rotation and side; its pads move with it

Coordinates are the client's frame (geometry.py): mm from the SVG crop's
corner, y down.  Only the item named moves: tracks are never dragged along,
so a client sends a set_track for each track that should follow.  Every
edit is checked before the board is touched, in order, against the board as
the edits before it left it; one bad edit (an id the board lacks, a layer
it does not have, a point off the board) rejects them all.  What breaks a
design rule is not refused: the DRC that follows reports it.
"""
import os

import pcbnew

from . import geometry, kicad as K


class EditError(ValueError):
    """An edit that cannot be applied; nothing has changed."""


def _num(v, what):
    try:
        v = float(v)
    except (TypeError, ValueError):
        raise EditError('%s must be a number' % what)
    if v != v or v in (float('inf'), float('-inf')):
        raise EditError('%s must be a number' % what)
    return v


class Editor:
    def __init__(self, b, design):
        self.b, self.d = b, design
        origin, _ = geometry.crop(b)
        self.f = geometry.Frame(origin)
        self.area = geometry.outline(b)
        self.copper = K.copper_names(b.GetCopperLayerCount())
        self.refs = {c['ref'] for c in design.get('components', [])}
        self.moved = {}
        self.counts = {}

    # ------------------------------------------------------------ lookups
    def item(self, id_, kinds=('PCB_TRACK', 'PCB_ARC', 'PCB_VIA')):
        for t in self.b.GetTracks():
            if t.m_Uuid.AsString() == id_ and t.GetClass() in kinds:
                return t
        what = 'via' if kinds == ('PCB_VIA',) else 'track' if 'PCB_VIA' not in kinds else 'track or via'
        raise EditError('no %s with id %s on the board' % (what, id_))

    def layer(self, name):
        if name not in self.copper:
            raise EditError('no copper layer %s on this board (it has %s)' % (name, ', '.join(self.copper)))
        return self.b.GetLayerID(name)

    def point(self, p, what):
        if not isinstance(p, (list, tuple)) or len(p) != 2:
            raise EditError('%s must be [x, y]' % what)
        x, y = _num(p[0], what + ' x'), _num(p[1], what + ' y')
        if self.area is not None:
            from shapely.geometry import Point
            if not self.area.covers(Point(self.f.ox + x, self.f.oy + y)):
                raise EditError('%s (%g, %g) is off the board' % (what, x, y))
        return self.f.kicad(x, y)

    def net(self, name):
        n = self.b.FindNet(name)
        if n is None or not name:
            raise EditError('no net %s on the board' % name)
        return n

    def size(self, v, what, lo=0.05, hi=20.0):
        v = _num(v, what)
        if not lo <= v <= hi:
            raise EditError('%s must be %g to %g mm' % (what, lo, hi))
        return pcbnew.FromMM(v)

    def touching(self, pos, lid=None, zones=False):
        """Nets of the copper at a point on a layer (None: any copper layer):
        pads, tracks and vias; or, with zones, the filled pours there."""
        layers = [lid] if lid is not None else [self.b.GetLayerID(n) for n in self.copper]
        found = set()
        if zones:
            for z in self.b.Zones():
                if not z.GetIsRuleArea() and z.GetNetname():
                    found |= {z.GetNetname() for l in layers if z.IsOnLayer(l) and z.GetFilledPolysList(l).Contains(pos)}
            return found
        for fp in self.b.GetFootprints():
            for p in fp.Pads():
                if p.GetNetname() and any(p.IsOnLayer(l) for l in layers) and p.HitTest(pos):
                    found.add(p.GetNetname())
        for t in self.b.GetTracks():
            if t.GetNetname() and any(t.IsOnLayer(l) for l in layers) and t.HitTest(pos, 0):
                found.add(t.GetNetname())
        return found

    def infer(self, ends, given, what):
        if given:
            return self.net(given)
        nets = set()
        for pos, lid in ends:
            nets |= self.touching(pos, lid)
        if not nets:
            # a pour is refilled round whatever is drawn in it, so it names
            # the net only when nothing else is touched
            for pos, lid in ends:
                nets |= self.touching(pos, lid, zones=True)
            if len(nets) > 1:
                nets = set()
        if len(nets) > 1:
            raise EditError('%s would join %s: that is a short' % (what, ' and '.join(sorted(nets))))
        if not nets:
            raise EditError('%s touches no pad, track or via: say which net it is' % what)
        return self.net(nets.pop())

    def track_width(self, net, lid, ends):
        """A new track takes the width of a track of its net it joins, else its net class's."""
        widths = [t.GetWidth() for t in self.b.GetTracks()
                  if t.GetClass() in ('PCB_TRACK', 'PCB_ARC') and t.GetNetCode() == net.GetNetCode()
                  and t.IsOnLayer(lid) and any(t.HitTest(p, 0) for p in ends)]
        if widths:
            return max(widths)
        ns = self.b.GetDesignSettings().m_NetSettings
        try:
            return ns.GetEffectiveNetClass(net.GetNetname()).GetTrackWidth()
        except Exception:                                    # noqa: BLE001 -- older bindings
            return ns.GetDefaultNetclass().GetTrackWidth()

    # ------------------------------------------------------------ edits
    def apply(self, edits):
        if not isinstance(edits, list) or not 1 <= len(edits) <= 500:
            raise EditError('edits must be a list of 1 to 500 edits')
        for i, e in enumerate(edits, 1):
            op = e.get('op') if isinstance(e, dict) else None
            fn = getattr(self, 'op_' + str(op), None)
            if fn is None:
                raise EditError('edit %d: unknown op %r' % (i, op))
            try:
                kind = fn(e) or op
            except EditError as err:
                raise EditError('edit %d (%s): %s' % (i, op, err))
            except KeyError as err:
                raise EditError('edit %d (%s): missing %s' % (i, op, err))
            self.counts[kind] = self.counts.get(kind, 0) + 1
        return self.counts

    def op_set_track(self, e):
        t = self.item(str(e['id']), ('PCB_TRACK', 'PCB_ARC'))
        a, b = self.point(e['a'], 'end a'), self.point(e['b'], 'end b')
        if e.get('layer') is not None:
            t.SetLayer(self.layer(e['layer']))
        if e.get('width') is not None:
            t.SetWidth(self.size(e['width'], 'width'))
        if t.GetClass() == 'PCB_ARC':
            # an arc keeps its shape: its middle moves as its two ends do on average
            t = t.Cast() if hasattr(t, 'Cast') else t
            s0, e0, m = t.GetStart(), t.GetEnd(), t.GetMid()
            t.SetMid(pcbnew.VECTOR2I(m.x + ((a.x - s0.x) + (b.x - e0.x)) // 2, m.y + ((a.y - s0.y) + (b.y - e0.y)) // 2))
        t.SetStart(a)
        t.SetEnd(b)

    def op_add_track(self, e):
        lid = self.layer(e['layer'])
        a, b = self.point(e['a'], 'end a'), self.point(e['b'], 'end b')
        if a.x == b.x and a.y == b.y:
            raise EditError('the track has no length')
        net = self.infer([(a, lid), (b, lid)], e.get('net'), 'the new track')
        t = pcbnew.PCB_TRACK(self.b)
        t.SetStart(a); t.SetEnd(b); t.SetLayer(lid); t.SetNet(net)
        t.SetWidth(self.size(e['width'], 'width') if e.get('width') is not None else self.track_width(net, lid, (a, b)))
        self.b.Add(t)

    def op_set_via(self, e):
        v = self.item(str(e['id']), ('PCB_VIA',))
        v.SetPosition(self.point([e['x'], e['y']], 'the via'))

    def op_add_via(self, e):
        pos = self.point([e['x'], e['y']], 'the via')
        net = self.infer([(pos, None)], e.get('net'), 'the new via')
        r = geometry.board_rules(self.b)
        v = pcbnew.PCB_VIA(self.b)
        if hasattr(pcbnew, 'VIATYPE_THROUGH'):
            v.SetViaType(pcbnew.VIATYPE_THROUGH)
        v.SetLayerPair(pcbnew.F_Cu, pcbnew.B_Cu)
        v.SetPosition(pos)
        v.SetWidth(self.size(e['d'], 'd') if e.get('d') is not None else pcbnew.FromMM(r['via_d']))
        v.SetDrill(self.size(e['drill'], 'drill') if e.get('drill') is not None else pcbnew.FromMM(r['via_drill']))
        if v.GetDrillValue() >= v.GetWidth(pcbnew.F_Cu):
            raise EditError('the drill must be smaller than the via')
        v.SetNet(net)
        self.b.Add(v)

    def op_delete(self, e):
        t = self.item(str(e['id']))
        K.remove(self.b, t)
        return 'delete_via' if t.GetClass() == 'PCB_VIA' else 'delete_track'      # counted apart

    def op_move_part(self, e):
        from . import board
        ref = str(e['ref'])
        fp = self.b.FindFootprintByReference(ref)
        if fp is None:
            raise EditError('no part %s on the board' % ref)
        if ref not in self.refs:
            raise EditError('%s is not a part of the design (mounting holes are set in design.board.holes)' % ref)
        pos = self.point([e['x'], e['y']], ref)
        rot = _num(e['rot'], 'rot') % 360
        side = e.get('side') or ('bottom' if fp.IsFlipped() else 'top')
        if side not in ('top', 'bottom'):
            raise EditError('side must be top or bottom')
        # as board.apply_placement places it: on top at its angle, then flipped
        if fp.IsFlipped():
            board.flip(fp)
        fp.SetPosition(pos)
        fp.SetOrientationDegrees(rot)
        if side == 'bottom':
            board.flip(fp)
        x, y = self.f.design(fp.GetPosition())
        self.moved[ref] = dict(x=x, y=y, rot=round(rot, 4), side=side)


def apply(path, edits, design):
    """Applies the edits to the board file at path, refills its zones and
    saves it. Returns (counts by op, with delete_track and delete_via apart;
    placement of the parts moved, in the design's frame)."""
    # new items need KIIDs of their own: every job is forked from one warm
    # process, whose random generator each fork would otherwise repeat
    pcbnew.KIID.SeedGenerator(int.from_bytes(os.urandom(4), 'little'))
    b = pcbnew.LoadBoard(path)
    ed = Editor(b, design)
    counts = ed.apply(edits)
    pcbnew.ZONE_FILLER(b).Fill(b.Zones())
    b.Save(path)
    return counts, ed.moved
