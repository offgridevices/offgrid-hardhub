# SPDX-License-Identifier: AGPL-3.0-or-later
"""From a design to a routed, checked board and its fab files.

    validate -> footprints -> place -> route -> miter -> pour -> drc
             -> verify -> fab -> render

Every step reports progress through `emit` (protocol JobLine) and its time
in the final stats (t_<step>, seconds).  A gate that fails stops the build
with ok=false and every check gathered so far, so the AI can read what
went wrong and change the design.

    python3 -m hardhub.pipeline design.json OUTDIR      (prints NDJSON)
"""
import json
import os
import shutil
import sys
import time

STEPS = ['validate', 'footprints', 'place', 'route', 'miter', 'pour', 'drc', 'verify', 'fab', 'render']
# a hand-edited board: the edits, the zones refilled, then the end of a build
EDIT_STEPS = ['validate', 'pour', 'drc', 'verify', 'fab', 'render']
DEFAULT_OUTPUTS = ('svg', 'glb')               # 'png' and 'step' only when asked: they are slow


class Stop(Exception):
    pass


class Job:
    steps = STEPS

    def __init__(self, d, work, out, emit, job='local', outputs=DEFAULT_OUTPUTS, stop_after=None):
        from . import design as D
        self.d = D.normalize(d)
        self.work, self.out, self.emit_line = work, out, emit
        self.job, self.outputs, self.stop_after = job, set(outputs or ()), stop_after
        self.checks, self.artifacts, self.stats, self.placement = [], [], {}, {}
        self.slug = None
        os.makedirs(work, exist_ok=True)
        os.makedirs(out, exist_ok=True)

    # ------------------------------------------------------------ plumbing
    def emit(self, step, message, frac=0.0):
        i = self.steps.index(step)
        self.emit_line(dict(step=step, progress=round((i + frac) / len(self.steps), 3), message=message))

    def art(self, kind, path, **kw):
        name = os.path.basename(path)
        a = dict(kind=kind, name=name, url='/jobs/%s/files/%s' % (self.job, name), bytes=os.path.getsize(path))
        a.update(kw)
        self.artifacts.append(a)

    def check(self, r):
        self.checks.append(r)
        return r['status'] != 'fail'

    def final(self, ok, error=None, rejected=False):
        line = dict(done=True, ok=ok, checks=self.checks, artifacts=self.artifacts, stats=self.stats,
                    placement=self.placement)
        if error:
            line['error'] = error
        if rejected:
            line['rejected'] = True
        return line

    def run(self):
        for step in self.steps:
            t = time.time()
            self.emit(step, 'starting')
            try:
                getattr(self, 's_' + step)()
            finally:
                self.stats['t_' + step] = round(time.time() - t, 2)
            self.emit(step, 'done in %.1f s' % self.stats['t_' + step], 1.0)
            if step == self.stop_after:
                break
        return self.final(all(c['status'] != 'fail' for c in self.checks))

    # ------------------------------------------------------------ steps
    def s_validate(self):
        from . import design as D, fab
        errs = D.require_board(self.d)
        if errs:
            raise Stop('; '.join(errs))
        self.slug = fab.slug(self.d['name'])
        self.placed = os.path.join(self.work, self.slug + '-placed.kicad_pcb')
        self.routed = os.path.join(self.work, self.slug + '.kicad_pcb')

    def s_footprints(self):
        from . import checks, footprints
        ids = sorted({p['footprint'] for p in self.d['parts'].values()})
        for i, fpid in enumerate(ids):
            if not footprints.exists(fpid) or fpid.startswith('hh:'):
                self.emit('footprints', 'loading %s' % fpid, i / max(1, len(ids)))
            try:
                footprints.load(fpid)
            except Exception as e:                            # noqa: BLE001 -- reported as a check below
                self.emit('footprints', 'no footprint %s: %s' % (fpid, e), i / max(1, len(ids)))
        ok = True
        for r in checks.circuit(self.d):
            ok = self.check(r) and ok
        if not ok:
            raise Stop('circuit checks failed')

    def s_place(self):
        import pcbnew
        from . import board, design as D, fanout
        self.placement = board.build(self.d, self.placed)
        if self.placement:
            self.emit('place', 'placed %d parts automatically' % len(self.placement), 0.5)
        # plane nets, and ground even without a plane: ground is poured on
        # both outer layers, so every SMD ground pad gets its own via into
        # the pours rather than a track the router must find room for
        planes = self.fanout_nets()
        if planes:
            b = pcbnew.LoadBoard(self.placed)
            done, failed, in_pad = fanout.fanout(b, planes, self.d['board']['corner_radius'])
            if in_pad:
                self.check(dict(id='via-in-pad', group='fab', name='No vias in pads',
                                why='a via in a pad wicks solder away unless the fab fills and caps it',
                                status='warn', detail='in %s: order filled, capped vias (JLCPCB: POFV) or move parts'
                                % ', '.join(in_pad[:10])))
            b.Save(self.placed)
            self.stats['fanout_vias'] = done
            # a pad with no room for its via is left to the repair route after
            # the pours, which may reach the plane from further away
            self.check(dict(id='fanout', group='layout', name='Every plane pad has its own via to its plane',
                            why='a short via straight down is the best return path; the rest are routed',
                            status='warn' if failed else 'pass',
                            **({'detail': 'no room beside ' + ', '.join(failed[:10])} if failed else {})))

    def fanout_nets(self):
        from . import design as D
        nets = set(D.plane_nets(self.d))
        g = D.ground_net(self.d)
        if g:
            nets.add(g)
        return sorted(nets)

    def plane_layers(self):
        return [r['layer'] for r in self.d['board']['layer_roles'] if r['role'] == 'plane']

    def s_route(self):
        from . import route, rules
        bd = self.d['board']
        left = route.route(self.placed, self.routed, plane_layers=self.plane_layers(), drop=self.fanout_nets(),
                           passes=int(os.environ.get('HARDHUB_PASSES', 20)),
                           rounds=int(os.environ.get('HARDHUB_ROUNDS', 3)),
                           progress=lambda m: self.emit('route', m, 0.5))
        self.stats['unrouted_after_router'] = left
        w, v, t = route.cleanup(self.routed, rules.LIMITS[bd['layers']]['track'], keep=self.fanout_nets())
        self.stats.update(tracks_widened=w, dangling_vias_removed=v, stubs_removed=t)

    def s_miter(self):
        from . import design as D, miter, rules
        done, failed, left = miter.miter(self.routed, rules.CLEAR, D.ground_net(self.d) or '')
        self.stats['corners_cut'] = self.stats.get('corners_cut', 0) + done
        self.stats['corners_left'] = failed

    def s_pour(self):
        from . import design as D, route, rules, stitch
        rules.write_rules(self.routed)
        g = D.ground_net(self.d)
        if not g:
            return
        r = self.d['board']['corner_radius']
        self.stats['stitch_vias'] = stitch.pour_and_stitch(self.routed, g, r)
        left = route.unrouted(self.routed)
        if left:
            # what the pours left unjoined (a ground pad cut off by tracks, a
            # connection the router gave up on): route again with the pours
            # in place, which Freerouting reads as copper areas of their net
            self.emit('pour', '%d connections left after the pours: routing them' % left, 0.5)
            repaired = self.routed + '.repair.kicad_pcb'
            # one short run, no optimiser: the rest of the board is done
            n = route.route(self.routed, repaired, plane_layers=self.plane_layers(), drop=(),
                            passes=max(5, int(os.environ.get('HARDHUB_PASSES', 20)) // 2), rounds=1, opt_passes=0,
                            progress=lambda m: self.emit('pour', 'repair ' + m, 0.7))
            after = route.unrouted(repaired)
            self.stats['unrouted_after_repair'] = after
            if after < left:                          # keep the repair only if it helped
                import shutil
                shutil.move(repaired, self.routed)
                route.cleanup(self.routed, rules.LIMITS[self.d['board']['layers']]['track'], keep=self.fanout_nets())
                self.s_miter()

    def s_drc(self):
        from . import kicad as K, rules, silk
        bd = self.d['board']
        # silkscreen last, on the finished copper, so the DRC below checks it too
        self.check(silk.apply(self.routed, self.d))
        rules.write_rules(self.routed)
        rules.set_stackup(self.routed, bd['layers'], mask=bd['mask_color'], finish=bd['finish'],
                          thickness=bd['thickness'], oz_outer=bd['copper_oz']['outer'], oz_inner=bd['copper_oz']['inner'])
        e, w, u = K.drc(self.routed, os.path.join(self.work, 'drc.json'))
        self.stats.update(drc_errors=len(e), drc_warnings=len(w), unconnected=len(u))
        desc = lambda vs: '; '.join('%s: %s' % (v.get('type'), v.get('description')) for v in vs[:6])
        self.check(dict(id='routed', group='layout', name='Every connection is routed',
                        why='an unrouted connection is a wire that is not there',
                        status='pass' if not u else 'fail', **({'detail': '%d left' % len(u)} if u else {})))
        self.check(dict(id='drc-errors', group='fab', name="DRC with the fab's own limits: 0 errors",
                        why='the fab rejects or mis-builds what breaks its rules',
                        status='pass' if not e else 'fail', **({'detail': desc(e)} if e else {})))
        self.check(dict(id='drc-warnings', group='fab', name='DRC: 0 warnings',
                        why='a warning is a rule bent; HardHub ships boards with none',
                        status='pass' if not w else 'warn', **({'detail': desc(w)} if w else {})))

    def s_verify(self):
        import pcbnew
        from . import fab, miter
        bad = fab.check_netlist(self.routed, self.d)
        self.check(dict(id='nets-match', group='layout', name='Copper equals the circuit, pad for pad',
                        why='the board must carry exactly the connections the design has',
                        status='pass' if not bad else 'fail',
                        **({'detail': '; '.join('%s.%s wants %s, has %s' % x for x in bad[:6])} if bad else {})))
        sharp = [c for c in miter.corners(self.routed) if c[0] > miter.LIMIT]
        self.stats['sharp_corners'] = len(sharp)
        self.check(dict(id='corners-45', group='layout', name='Every track corner 45 degrees or less',
                        why='house rule; no acid traps in the etch, and tidy copper',
                        status='pass' if not sharp else 'warn',
                        **({'detail': '%d left, first at %s' % (len(sharp), ', '.join('(%.1f, %.1f) %s' % (c[3], c[4], c[2]) for c in sharp[:3]))} if sharp else {})))
        self.check_widths()
        for id_, group, name, why in (
                ('sim-power', 'power', 'Supply transients and regulator stability simulated',
                 'a supply that rings or sags resets the board under load'),
                ('sim-thermal', 'thermal', 'Heat simulated on the routed board at worst-case load',
                 'the routed board runs hotter than the same design before routing')):
            self.check(dict(id=id_, group=group, name=name, why=why, status='skip',
                            detail='not run: the engine does not simulate yet'))
        b = pcbnew.LoadBoard(self.routed)
        self.stats['tracks'] = sum(1 for t in b.GetTracks() if t.GetClass() == 'PCB_TRACK')
        self.stats['vias'] = sum(1 for t in b.GetTracks() if t.GetClass() == 'PCB_VIA')
        refs = {fp.GetReference() for fp in b.GetFootprints() if not fp.GetReference().startswith('MH')}
        want = {c['ref'] for c in self.d['components']}
        self.check(dict(id='parts-placed', group='layout', name='Every part is on the board',
                        why='a part in the circuit but not on the board is missing from the build',
                        status='pass' if refs == want else 'fail',
                        **({'detail': 'missing %s; extra %s' % (sorted(want - refs)[:8], sorted(refs - want)[:8])} if refs != want else {})))

    NECK = 0.5          # mm: a narrower stretch this short, into a pad, is a neck, not the track

    def check_widths(self):
        """Every track of a net that states its current is wide enough for
        it (IPC-2221, 10 C rise).  The router narrows a track to get into a
        fine-pitch pad, and on a crowded board may route a whole net narrow:
        the first is fine, the second is a hot track."""
        import pcbnew
        from . import rules
        b = pcbnew.LoadBoard(self.routed)
        oz_out, oz_in = self.d['board']['copper_oz']['outer'], self.d['board']['copper_oz']['inner']
        bad, thin = [], []
        poured = set(self.fanout_nets())          # their current flows in the plane or pour, not the via stubs
        for name, net in self.d['nets'].items():
            if name in poured or (not net.get('current') and not net.get('width')):
                continue
            narrow = 0.0
            need_min = None
            for t in b.GetTracks():
                if t.GetClass() != 'PCB_TRACK' or t.GetNetname() != name:
                    continue
                outer = t.GetLayer() in (pcbnew.F_Cu, pcbnew.B_Cu)
                need = rules.track_width(net['current'], outer=outer, oz=oz_out if outer else oz_in, floor=0) \
                    if net.get('current') else float(net['width'])
                if t.GetWidth() / 1e6 < need - 0.005:
                    narrow = max(narrow, t.GetLength() / 1e6)      # the longest narrow segment
                    need_min = need
            if narrow > self.NECK:
                (bad if net.get('current') else thin).append('%s: a %.1f mm stretch under %.2f mm'
                                                             % (name, narrow, need_min))
        self.check(dict(id='current-width', group='power', name='Tracks wide enough for their current',
                        why='a track too narrow for its current runs hot', status='fail' if bad else 'pass',
                        **({'detail': '; '.join(bad[:6])} if bad else {})))
        if thin:
            self.check(dict(id='net-width', group='layout', name='Tracks at the width their net asks for',
                            why='the design gave these nets a width', status='warn', detail='; '.join(thin[:6])))

    def s_fab(self):
        import csv
        import pcbnew
        from . import fab
        zp = fab.gerbers(self.routed, self.out, self.slug)
        self.art('gerbers', zp)
        files, n_parts, n_lines = fab.bom_cpl(self.routed, self.d, self.out, self.slug)
        self.art('bom', files['bom']); self.art('bom', files['bom_pcbway']); self.art('cpl', files['cpl'])
        net_csv, ipc, n_pads = fab.netlist(self.routed, self.out, self.slug)
        self.art('netlist', net_csv); self.art('netlist', ipc)
        self.stats.update(assembled_parts=n_parts, bom_lines=n_lines, netlist_pads=n_pads)
        asm = sorted(fp.GetReference() for fp, p in fab.assembled(pcbnew.LoadBoard(self.routed), self.d))
        with open(files['cpl']) as f:
            cpl = sorted(r['Designator'] for r in csv.DictReader(f))
        with open(files['bom']) as f:
            bom = sorted(x for r in csv.DictReader(f) for x in r['Designator'].split(','))
        ok = cpl == asm and bom == asm
        self.check(dict(id='bom-cpl', group='fab', name='BOM and CPL list exactly the assembled parts',
                        why='nothing missing or extra on the assembly line', status='pass' if ok else 'fail',
                        detail='%d parts in %d BOM lines' % (n_parts, n_lines)))
        # the routed board itself, for anyone who wants to open it in KiCad
        import zipfile
        kz = os.path.join(self.out, self.slug + '-kicad.zip')
        with zipfile.ZipFile(kz, 'w', zipfile.ZIP_DEFLATED) as z:
            for ext in ('.kicad_pcb', '.kicad_pro', '.kicad_dru'):
                p = os.path.splitext(self.routed)[0] + ext
                if os.path.exists(p):
                    z.write(p, self.slug + ext)
        self.art('kicad', kz)

    def s_render(self):
        from . import fab, geometry
        svg = None
        if 'svg' in self.outputs:
            for layer, path in fab.svgs(self.routed, self.out, self.slug):
                self.art('board-svg', path, layers=[layer])
                svg = svg or path
            self.emit('render', 'layer drawings done', 0.3)
        # the board as vector geometry, in the SVGs' own frame, for editing by hand
        self.art('board-json', geometry.write(self.routed, os.path.join(self.out, self.slug + '-board.json'), svg))
        if 'glb' in self.outputs:
            path, raw = fab.glb(self.routed, self.out, self.slug)
            self.stats.update(glb_bytes=os.path.getsize(path), glb_raw_bytes=raw)
            self.art('glb', path)
            self.emit('render', '3D model done', 0.7)
        if 'png' in self.outputs:
            try:
                self.art('board-png', fab.render(self.routed, self.out, self.slug))
            except Exception as e:                            # noqa: BLE001 -- a picture is optional
                self.emit('render', 'render skipped: %s' % str(e)[:200], 0.8)
        if 'step' in self.outputs:
            self.art('step', fab.step(self.routed, self.out, self.slug))
        # last: everything to order the board, in one zip sorted by upload slot
        self.art('package', fab.package(self.d, self.out, self.slug, self.artifacts))


class EditJob(Job):
    """A routed board from a build's KiCad zip, edited by hand: the edits,
    the zones refilled, then the build's own drc, verify, fab and render
    steps. Nothing is placed or routed again; placement holds the parts the
    edits moved, in the design's frame."""
    steps = EDIT_STEPS

    def __init__(self, d, kicad_zip, edits, work, out, emit, job='local', outputs=DEFAULT_OUTPUTS):
        super().__init__(d, work, out, emit, job, outputs)
        self.kicad_zip, self.edits = kicad_zip, edits

    def s_validate(self):
        from . import design as D, edits, fab, view
        errs = D.require_board(self.d)
        if errs:
            raise Stop('; '.join(errs))
        self.slug = fab.slug(self.d['name'])
        src = view.board_path(os.path.join(self.work, 'in'), self.kicad_zip)
        if src is None:
            raise Stop('the KiCad zip holds no board')
        # the board under the name a build gives it, with its rules and project
        self.routed = os.path.join(self.work, self.slug + '.kicad_pcb')
        for ext in ('.kicad_pcb', '.kicad_pro', '.kicad_dru'):
            p = os.path.splitext(src)[0] + ext
            if os.path.exists(p):
                shutil.copy(p, os.path.splitext(self.routed)[0] + ext)
        counts, self.placement = edits.apply(self.routed, self.edits, self.d)
        self.stats.update({'edits_' + k: v for k, v in counts.items()})
        self.emit('validate', 'applied %d edits' % sum(counts.values()), 0.9)

    def s_pour(self):
        # edits.apply refilled the zones; the DRC refills them again as it checks
        pass


def edit(d, kicad_zip, edit_list, work, out, emit, job='local', outputs=DEFAULT_OUTPUTS):
    """Apply hand edits to a built board and redo its checks and files; returns the
    final JobLine. An edit that cannot be applied comes back rejected, nothing changed."""
    from .edits import EditError
    j = EditJob(d, kicad_zip, edit_list, work, out, emit, job, outputs)
    try:
        return j.run()
    except EditError as e:
        return j.final(False, str(e), rejected=True)
    except Stop as e:
        return j.final(False, str(e))
    except Exception as e:                                   # noqa: BLE001 -- the client must hear about it
        import traceback
        traceback.print_exc(file=sys.stderr)
        return j.final(False, '%s: %s' % (type(e).__name__, e))


def build(d, work, out, emit, job='local', outputs=DEFAULT_OUTPUTS, stop_after=None):
    """Run a build; returns the final JobLine (also on failure)."""
    j = Job(d, work, out, emit, job, outputs, stop_after)
    try:
        return j.run()
    except Stop as e:
        return j.final(False, str(e))
    except Exception as e:                                   # noqa: BLE001 -- the client must hear about it
        import traceback
        traceback.print_exc(file=sys.stderr)
        return j.final(False, '%s: %s' % (type(e).__name__, e))


if __name__ == '__main__':
    d = json.load(open(sys.argv[1]))
    out = sys.argv[2]
    shutil.rmtree(out, ignore_errors=True)
    outputs = sys.argv[3].split(',') if len(sys.argv) > 3 else DEFAULT_OUTPUTS
    line = build(d, os.path.join(out, 'work'), os.path.join(out, 'files'),
                 lambda x: print(json.dumps(x), flush=True), outputs=outputs)
    print(json.dumps(line), flush=True)
    sys.exit(0 if line['ok'] else 1)
