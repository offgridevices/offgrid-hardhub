# SPDX-License-Identifier: AGPL-3.0-or-later
"""Autoroute a placed board with Freerouting.

  export Specctra DSN (KiCad) -> Freerouting -> import SES (KiCad)

Freerouting 2.5 runs headless and multi-threaded, so it is the default.
Offgrid-hardware routed with 1.9.0 because 2.1-2.4 stalled on some boards;
1.9 needs a display even in batch mode, so it runs under xvfb-run, and is
the fallback when 2.5 fails.  Plane layers are marked as power layers in
the copy Freerouting sees, and plane nets are emptied from its netlist, so
it routes signals on the signal layers only.

From offgrid-hardware print-hub/v1/src/route.py and pcb.py (tidy_tracks,
dedupe_vias).
"""
import os
import re
import itertools
import shutil
import subprocess
import time

import pcbnew

from . import kicad as K

JAR = os.environ.get('FREEROUTING_JAR', '/opt/freerouting-1.9.0.jar')
FR2 = os.environ.get('FREEROUTING2', '/opt/freerouting-2.5.0-linux-x64/bin/freerouting')
THREADS = max(1, (os.cpu_count() or 2) - 1)
TIMEOUT = int(os.environ.get('FREEROUTING_TIMEOUT', 900))     # seconds per Freerouting run


class RouteError(Exception):
    pass


def export_dsn(pcb_path, dsn_path, plane_layers=(), drop=()):
    b = pcbnew.LoadBoard(pcb_path)
    for name in plane_layers:
        b.SetLayerType(K.layer_id(name), pcbnew.LT_POWER)
    if not pcbnew.ExportSpecctraDSN(b, dsn_path):
        raise RouteError('DSN export failed')
    if drop:
        drop_nets(dsn_path, drop)


def drop_nets(dsn_path, nets):
    """Freerouting must not route `nets` at all: their pin lists are
    emptied, and every fixed wire and via of theirs gets a net of its own
    (one item, nothing to join), or Freerouting joins the plane vias."""
    txt = open(dsn_path).read()
    count = itertools.count()
    extra = []
    for n in nets:
        pat = r'(\(net ' + re.escape(n) + r'\s*\n\s*\(pins)[^)]*\)'
        if not re.search(pat, txt):
            pat = r'(\(net "' + re.escape(n) + r'"\s*\n\s*\(pins)[^)]*\)'
        txt, k = re.subn(pat, r'\1)', txt)
        if k != 1:
            continue                     # a net with no pads on the board
        j = txt.index('(wiring')

        def solo(m):
            name = '%s__fixed%d' % (re.sub(r'\W', '_', n), next(count))
            extra.append(name)
            return '(net %s)' % name
        txt = txt[:j] + re.sub(r'\(net "?' + re.escape(n) + r'"?\)', solo, txt[j:])
    if extra:
        j = txt.index('(network') + len('(network')
        txt = txt[:j] + ''.join('\n    (net %s\n      (pins)\n    )' % e for e in extra) + txt[j:]
    open(dsn_path, 'w').write(txt)


def freeroute(dsn_path, ses_path, passes=20, log=None, use_fr2=True):
    if use_fr2 and os.path.exists(FR2):
        # no usage analytics leave the machine
        # its escape-via stage (fanout) is off: it drops a via on most SMD
        # pins whether the route needs one or not; HardHub's own fanout has
        # already given plane and ground pads theirs
        cmd = [FR2, '-de', dsn_path, '-do', ses_path, '--router.autorouter.max_passes=%d' % passes,
               '-mt', str(THREADS), '--router.fanout.enabled=%s' % os.environ.get('HARDHUB_FR_FANOUT', 'false'),
               '--gui.enabled=false', '--usage_and_diagnostic_data.disable_analytics=true']
    else:
        cmd = ['xvfb-run', '-a', 'java', '-jar', JAR, '-de', dsn_path, '-do', ses_path, '-mp', str(passes)]
    with open(log or os.devnull, 'w') as f:
        p = subprocess.Popen(cmd, stdout=f, stderr=subprocess.STDOUT, start_new_session=True,
                             cwd=os.path.dirname(os.path.abspath(dsn_path)))
        try:
            rc = p.wait(timeout=TIMEOUT)
        except subprocess.TimeoutExpired:
            os.killpg(p.pid, 9)          # java and Xvfb too, not just the launcher
            p.wait()
            raise RouteError('Freerouting did not finish in %d s' % TIMEOUT)
    if rc != 0 or not os.path.exists(ses_path):
        raise RouteError('Freerouting failed (rc=%s), see %s' % (rc, log))


def import_ses(pcb_path, ses_path, out_path):
    b = pcbnew.LoadBoard(pcb_path)
    if not pcbnew.ImportSpecctraSES(b, ses_path):
        raise RouteError('SES import failed')
    b.Save(out_path)


def router_unrouted(log):
    """Connections Freerouting 2.x reports unrouted at the end of a run."""
    try:
        txt = open(log).read()
    except OSError:
        return None
    m = re.findall(r'Auto-routing stage completed:.*?\((\d+) unrouted', txt)
    if m:
        return int(m[-1])
    return 0 if 'Auto-routing stage completed' in txt else None


def unrouted(pcb_path):
    b = pcbnew.LoadBoard(pcb_path)
    pcbnew.ZONE_FILLER(b).Fill(b.Zones())
    b.BuildConnectivity()
    return b.GetConnectivity().GetUnconnectedCount(False)


def route(pcb_in, pcb_out, plane_layers=(), drop=(), passes=20, rounds=4, progress=None):
    """Route, then keep re-routing the partly routed board (Freerouting
    carries the existing wiring over and works on what is left) until every
    connection is made or `rounds` runs out.  Returns the unrouted count."""
    work = os.path.dirname(os.path.abspath(pcb_out))
    src = pcb_in
    best = None
    use_fr2 = True
    for r in range(rounds):
        dsn = os.path.join(work, 'route%d.dsn' % r)
        ses = os.path.join(work, 'route%d.ses' % r)
        if r > 0:
            # Freerouting hangs ("normalization of net ... failed") on its own
            # near-degenerate wiring when that is fed back to it
            tidy_tracks(src)
            dedupe_vias(src)
        export_dsn(src, dsn, plane_layers, drop)
        t = time.time()
        try:
            freeroute(dsn, ses, passes=passes, log=os.path.join(work, 'freerouting%d.log' % r), use_fr2=use_fr2)
        except RouteError:
            if not use_fr2 or not shutil.which('xvfb-run'):
                raise
            use_fr2 = False                   # 2.5 failed on this board: 1.9 from here on
            freeroute(dsn, ses, passes=passes, log=os.path.join(work, 'freerouting%d-1.9.log' % r), use_fr2=False)
        import_ses(src, ses, pcb_out)
        # Freerouting's own count: KiCad's would include the dropped plane
        # and ground nets, which the pours join later
        n = router_unrouted(os.path.join(work, 'freerouting%d.log' % r))
        if n is None:
            n = unrouted(pcb_out)
        if progress:
            progress('round %d: %d connections left (%.0f s)' % (r + 1, n, time.time() - t))
        if best is None or n < best[0]:
            best = (n, r)
            shutil.copy(pcb_out, pcb_out + '.best')
        if n == 0:
            break
        src = pcb_out
    shutil.copy(pcb_out + '.best', pcb_out)
    os.remove(pcb_out + '.best')
    return best[0]


def tidy_tracks(path, snap=0.005):
    """Track ends of one net on one layer within `snap` mm of each other (or
    of a via of the net) are joined at one point; zero-length segments and
    exact duplicates are dropped.  Freerouting fails to normalise a net
    with such geometry and hangs."""
    from collections import defaultdict
    b = pcbnew.LoadBoard(path)
    S = int(snap * 1e6)
    tracks = [t for t in b.GetTracks() if t.GetClass() == 'PCB_TRACK']
    vias = defaultdict(list)
    for t in b.GetTracks():
        if t.GetClass() == 'PCB_VIA':
            q = t.GetPosition(); vias[t.GetNetname()].append((q.x, q.y))
    ends = defaultdict(list)
    for t in tracks:
        ends[(t.GetNetname(), t.GetLayer())] += [(t, 's'), (t, 'e')]
    for (net, layer), items in ends.items():
        pts = [((t.GetStart() if k == 's' else t.GetEnd()).x, (t.GetStart() if k == 's' else t.GetEnd()).y)
               for t, k in items]
        anchors = vias.get(net, [])
        parent = list(range(len(pts)))

        def find(i):
            while parent[i] != i:
                parent[i] = parent[parent[i]]; i = parent[i]
            return i
        order = sorted(range(len(pts)), key=lambda i: pts[i])
        for a, i in enumerate(order):          # neighbours within snap, by sorted x
            for j in order[a + 1:]:
                if pts[j][0] - pts[i][0] > S:
                    break
                if pts[i] != pts[j] and abs(pts[i][1] - pts[j][1]) <= S:
                    parent[find(i)] = find(j)
        clusters = defaultdict(list)
        for i in range(len(pts)):
            clusters[find(i)].append(i)
        for members in clusters.values():
            cand = [a for a in anchors if any(abs(a[0] - pts[i][0]) <= S and abs(a[1] - pts[i][1]) <= S for i in members)]
            if len(set(pts[i] for i in members)) < 2 and not cand:
                continue
            target = cand[0] if cand else max(set(pts[i] for i in members), key=lambda q: sum(pts[i] == q for i in members))
            for i in members:
                if pts[i] != target:
                    t, k = items[i]
                    (t.SetStart if k == 's' else t.SetEnd)(pcbnew.VECTOR2I(int(target[0]), int(target[1])))
    seen = {}
    for t in tracks:
        a, e = t.GetStart(), t.GetEnd()
        if a.x == e.x and a.y == e.y:
            K.remove(b, t)
            continue
        key = (t.GetNetname(), t.GetLayer(), tuple(sorted(((a.x, a.y), (e.x, e.y)))))
        if key in seen:
            keep = seen[key]
            if t.GetWidth() > keep.GetWidth():
                keep.SetWidth(t.GetWidth())
            K.remove(b, t)
        else:
            seen[key] = t
    b.Save(path)


def dedupe_vias(path):
    """Freerouting sometimes drops a via on top of an existing via of the
    same net.  Keep one of any pair closer than the hole-to-hole rule and
    move every track end on the removed via onto the survivor."""
    b = pcbnew.LoadBoard(path)
    vias = [t for t in b.GetTracks() if t.GetClass() == 'PCB_VIA']
    tracks = [t for t in b.GetTracks() if t.GetClass() == 'PCB_TRACK']
    gone = {}
    for i, a in enumerate(vias):
        if i in gone:
            continue
        pa = a.GetPosition()
        for j in range(i + 1, len(vias)):
            if j in gone or vias[j].GetNetname() != a.GetNetname():
                continue
            pc = vias[j].GetPosition()
            d = ((pa.x - pc.x) ** 2 + (pa.y - pc.y) ** 2) ** 0.5 / 1e6
            if d < (a.GetDrillValue() + vias[j].GetDrillValue()) / 2e6 + 0.25:
                gone[j] = i
    for j, i in gone.items():
        pj, pi = vias[j].GetPosition(), vias[i].GetPosition()
        for t in tracks:
            if t.GetNetname() != vias[j].GetNetname():
                continue
            for get, put in ((t.GetStart, t.SetStart), (t.GetEnd, t.SetEnd)):
                q = get()
                if abs(q.x - pj.x) < 20000 and abs(q.y - pj.y) < 20000:
                    put(pcbnew.VECTOR2I(pi.x, pi.y))
    for j in sorted(gone, reverse=True):
        K.remove(b, vias[j])
    b.Save(path)
    return len(gone)


def cleanup(path, min_width, keep=()):
    """After the router: tracks it necked below the fab's minimum go back to
    that minimum (Freerouting 2.x necks to 75 % of the class width at pads),
    and vias or track stubs that lead nowhere are removed (DRC warns of
    dangling vias, and they are copper doing nothing).  Returns
    (tracks widened, vias removed, stubs removed).  Nets in `keep` (planes
    and pours, joined by copper areas the router never saw) are left alone."""
    from collections import defaultdict
    b = pcbnew.LoadBoard(path)
    MW = int(round(min_width * 1e6))
    widened = 0
    for t in b.GetTracks():
        if t.GetClass() == 'PCB_TRACK' and t.GetWidth() < MW:
            t.SetWidth(MW)
            widened += 1
    zone_nets = {z.GetNetname() for z in b.Zones() if not z.GetIsRuleArea()} | set(keep)
    pads = defaultdict(list)                 # net -> pads
    for fp in b.GetFootprints():
        for p in fp.Pads():
            if p.GetNetname():
                pads[p.GetNetname()].append(p)

    def on_pad(net, layer, pt):
        return any(p.IsOnLayer(layer) and p.HitTest(pt) for p in pads.get(net, []))

    def near(a, b_, r):
        return (a.x - b_.x) ** 2 + (a.y - b_.y) ** 2 <= r * r

    vias_gone = stubs = 0
    while True:
        tracks = [t for t in b.GetTracks() if t.GetClass() == 'PCB_TRACK']
        vias = [t for t in b.GetTracks() if t.GetClass() == 'PCB_VIA']
        ends = defaultdict(int)              # (net, layer, x, y) -> track ends there
        for t in tracks:
            for q in (t.GetStart(), t.GetEnd()):
                ends[(t.GetNetname(), t.GetLayer(), q.x, q.y)] += 1
        changed = False
        for v in vias:
            net = v.GetNetname()
            if net in zone_nets:
                continue
            q, r = v.GetPosition(), v.GetWidth(pcbnew.F_Cu) / 2
            layers = {t.GetLayer() for t in tracks if t.GetNetname() == net
                      and (near(t.GetStart(), q, r) or near(t.GetEnd(), q, r))}
            layers |= {l for l in K.copper_ids(b.GetCopperLayerCount()) if on_pad(net, l, q)}
            if len(layers) < 2:
                K.remove(b, v)
                vias_gone += 1
                changed = True
        if changed:
            continue
        vias = [t for t in b.GetTracks() if t.GetClass() == 'PCB_VIA']
        for t in tracks:
            net, layer = t.GetNetname(), t.GetLayer()
            if net in zone_nets:
                continue
            for e in (t.GetStart(), t.GetEnd()):
                if ends[(net, layer, e.x, e.y)] > 1 or on_pad(net, layer, e):
                    continue
                if any(v.GetNetname() == net and near(v.GetPosition(), e, v.GetWidth(pcbnew.F_Cu) / 2) for v in vias):
                    continue
                K.remove(b, t)
                stubs += 1
                changed = True
                break
        if not changed:
            break
    b.Save(path)
    return widened, vias_gone, stubs
