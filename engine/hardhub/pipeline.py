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
DEFAULT_OUTPUTS = ('svg', 'glb')               # 'png' and 'step' only when asked: they are slow


class Stop(Exception):
    pass


class Job:
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
        i = STEPS.index(step)
        self.emit_line(dict(step=step, progress=round((i + frac) / len(STEPS), 3), message=message))

    def art(self, kind, path, **kw):
        name = os.path.basename(path)
        a = dict(kind=kind, name=name, url='/jobs/%s/files/%s' % (self.job, name), bytes=os.path.getsize(path))
        a.update(kw)
        self.artifacts.append(a)

    def check(self, r):
        self.checks.append(r)
        return r['status'] != 'fail'

    def final(self, ok, error=None):
        line = dict(done=True, ok=ok, checks=self.checks, artifacts=self.artifacts, stats=self.stats,
                    placement=self.placement)
        if error:
            line['error'] = error
        return line

    def run(self):
        for step in STEPS:
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
            done, failed = fanout.fanout(b, planes, self.d['board']['corner_radius'])
            b.Save(self.placed)
            self.stats['fanout_vias'] = done
            self.check(dict(id='fanout', group='layout', name='Every plane pad has a via to its plane',
                            why='a pad with no way down to its plane is not connected', status='fail' if failed else 'pass',
                            **({'detail': 'no room beside ' + ', '.join(failed[:10])} if failed else {})))
            if failed:
                raise Stop('no room for plane vias beside %s' % ', '.join(failed[:10]))

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
            n = route.route(self.routed, repaired, plane_layers=self.plane_layers(), drop=D.plane_nets(self.d),
                            passes=int(os.environ.get('HARDHUB_PASSES', 20)), rounds=2,
                            progress=lambda m: self.emit('pour', 'repair ' + m, 0.7))
            import shutil
            shutil.move(repaired, self.routed)
            route.cleanup(self.routed, rules.LIMITS[self.d['board']['layers']]['track'], keep=self.fanout_nets())
            self.s_miter()
            self.stats['unrouted_after_repair'] = n

    def s_drc(self):
        from . import kicad as K, rules
        bd = self.d['board']
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
        b = pcbnew.LoadBoard(self.routed)
        self.stats['tracks'] = sum(1 for t in b.GetTracks() if t.GetClass() == 'PCB_TRACK')
        self.stats['vias'] = sum(1 for t in b.GetTracks() if t.GetClass() == 'PCB_VIA')
        refs = {fp.GetReference() for fp in b.GetFootprints() if not fp.GetReference().startswith('MH')}
        want = {c['ref'] for c in self.d['components']}
        self.check(dict(id='parts-placed', group='layout', name='Every part is on the board',
                        why='a part in the circuit but not on the board is missing from the build',
                        status='pass' if refs == want else 'fail',
                        **({'detail': 'missing %s; extra %s' % (sorted(want - refs)[:8], sorted(refs - want)[:8])} if refs != want else {})))

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
        from . import fab
        if 'svg' in self.outputs:
            for layer, path in fab.svgs(self.routed, self.out, self.slug):
                self.art('board-svg', path, layers=[layer])
            self.emit('render', 'layer drawings done', 0.3)
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
