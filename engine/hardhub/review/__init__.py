# SPDX-License-Identifier: AGPL-3.0-or-later
"""The board tests: everything checked before a board is ordered.

    results, files = review.run(board, design, work, out, slug, emit)

Runs on the routed board, after every build, every hand edit and on
request (POST /test), in this order, each result streamed the moment it is
known so a person watches the checklist fill in:

    read the board -> KiCad DRC -> measure the copper (Rust) -> layout tests
    -> power tree -> circuit simulations (ngspice) -> electrical tests
    -> voltage drop and heat (Rust) -> report

A stage that cannot run turns its tests into "skip" with the reason; it
never stops the others or the build.  The report (<slug>-tests.json for
clients to draw, <slug>-tests.md for people and AIs to read) holds the
stackup, heat maps, power tree, supply simulations and part stress.
"""
import datetime
import json
import os
import sys
import time
import traceback

from . import catalog as C

# the tests each stage makes, in the order they are shown while running
LAYOUT_IDS = ['shorts', 'dangling', 'isolated-copper', 'track-min', 'clearance-min', 'edge-clearance', 'corners-45',
              'acid-traps', 'copper-balance', 'thermal-relief', 'via-size', 'drill-min', 'annular-ring', 'hole-to-hole',
              'hole-clearance', 'aspect-ratio', 'via-in-pad', 'mounting-holes', 'silk-width', 'silk-height', 'silk-on-pads',
              'silk-off-board', 'mask-web', 'courtyard', 'part-edge', 'connectors-edge', 'decoupling-near', 'crystal-near',
              'antenna-keepout', 'return-path', 'usb-pair', 'creepage']
DRC_IDS = ['routed', 'drc-errors', 'drc-warnings', 'outline']
SPICE_IDS = ['pdn', 'load-step', 'stress-resistor-power', 'stress-led-current', 'stress-tolerance']
ELECTRICAL_IDS = ['power-budget', 'regulator-headroom', 'regulator-input', 'decoupling', 'bulk-caps', 'input-protection',
                  'usb-c-cc', 'heat-parts-cold', 'stress-cap-voltage', 'stress-cap-dcbias', 'stress-ic-voltage',
                  'stress-connector-current', 'i2c-pullups', 'floating-inputs', 'stock-qty', 'extended-parts', 'datasheets',
                  'ratings-known', 'polarity-marks', 'two-sided', 'board-size', 'stackup']
HEAT_IDS = ['voltage-drop', 'track-heating', 'via-current', 'heat-parts-hot', 'heat-junction', 'heat-board']


def environment(d, options=None):
    env = dict(ambient_min=0.0, ambient_max=50.0, enclosed=False)
    env.update({k: v for k, v in (d.get('environment') or {}).items() if v is not None})
    for k in ('ambient_min', 'ambient_max'):
        if options and options.get(k) is not None:
            env[k] = float(options[k])
    if env['ambient_min'] > env['ambient_max']:
        env['ambient_min'], env['ambient_max'] = env['ambient_max'], env['ambient_min']
    return env


class Run:
    def __init__(self, emit, total):
        self.emit, self.total, self.done = emit, max(1, total), 0
        self.results, self.timings = [], {}
        self.label = ''

    def say(self, label):
        self.label = label
        self.emit(label, self.done / self.total)

    def add(self, r):
        r = C.enrich(r)
        # a later result for the same test replaces the earlier one
        self.results = [x for x in self.results if x['id'] != r['id']] + [r]
        self.done += 1
        self.emit(self.label, min(1.0, self.done / self.total), result=r)

    def stage(self, name, ids, fn):
        """Runs fn() -> results; on an exception every test of the stage is
        skipped with the reason (and the traceback goes to the log)."""
        t = time.time()
        try:
            got = fn() or []
        except Exception as e:                                # noqa: BLE001 -- reported as skipped tests
            traceback.print_exc(file=sys.stderr)
            got = [C.skip(i, '%s could not run: %s: %s' % (name, type(e).__name__, str(e)[:200])) for i in ids]
        self.timings[name] = round(time.time() - t, 2)
        for r in got:
            self.add(r)
        return got


def run(board_path, d, work, out, slug, emit=lambda message, frac, **kw: None, options=None, drc_json=None):
    """Every board test on the routed board at board_path. emit(message,
    frac, plan=..., result=...) reports progress. Returns (results, [report
    file paths])."""
    from .. import design as D
    d = D.normalize(d)
    env = environment(d, options)
    os.makedirs(work, exist_ok=True)
    os.makedirs(out, exist_ok=True)
    plan_ids = (DRC_IDS if drc_json is None else []) + LAYOUT_IDS + ELECTRICAL_IDS + SPICE_IDS + HEAT_IDS
    emit('Planning %d tests' % len(plan_ids), 0.0, plan=C.plan(plan_ids))
    run = Run(emit, len(plan_ids))
    state = {}

    run.say('Reading the board from KiCad')
    t = time.time()
    from . import model as MODEL
    model = state['model'] = MODEL.export(board_path, d)
    run.timings['model'] = round(time.time() - t, 2)
    # where each part really is: the routed board, not what the design asked
    # (the engine placed the parts the design left unplaced)
    d = dict(d, placement=dict(d.get('placement') or {}))
    for p in model['parts']:
        cur = d['placement'].get(p['ref'], {})
        d['placement'][p['ref']] = dict(cur, x=p['x'], y=p['y'], side=p['side'], rot=cur.get('rot', p.get('rot', 0)))

    # KiCad's own DRC: the build's report when there is one, else a fresh run
    from . import drc as DRC
    if drc_json is None:
        run.say("Running KiCad's design-rule check")

        def fresh():
            path, e, w, u = DRC.run(board_path, os.path.join(work, 'drc'))
            state['drc_json'] = path
            desc = lambda vs: '; '.join('%s: %s' % (v.get('type'), v.get('description')) for v in vs[:6])
            return [
                C.result('routed', 'pass' if not u else 'fail', detail='%d left' % len(u) if u else 'every connection has copper',
                         measured=C.measure('connections left', len(u), 'count', 0, '<='),
                         fix='Route the connections left (build_board again, or draw them in the Layout tab).'),
                C.result('drc-errors', 'pass' if not e else 'fail', detail=desc(e) if e else None,
                         measured=C.measure('errors', len(e), 'count', 0, '<='),
                         fix='Each error is listed under the test it belongs to, with where it is.'),
                C.result('drc-warnings', 'pass' if not w else 'warn', detail=desc(w) if w else None,
                         measured=C.measure('warnings', len(w), 'count', 0, '<=')),
                outline_check(DRC.read(path)),
            ]
        run.stage('drc', DRC_IDS, fresh)
    else:
        state['drc_json'] = drc_json
        state['outline'] = True
    drc = DRC.read(state.get('drc_json'))

    run.say('Measuring copper, holes, printing and mask')
    from . import layout, sim
    t = time.time()
    try:
        L = layout.limits(d)
        m = sim.run('measure', dict(board=model, limits=L, hv_nets=layout.hv_nets(d),
                                    signal_nets=[n for n in _signal_nets(d, model)],
                                    ref_nets=[n for n, x in d['nets'].items() if x.get('kind') in ('ground', 'power')]))
    except Exception as e:                                    # noqa: BLE001 -- the tests say they could not measure
        traceback.print_exc(file=sys.stderr)
        m = None
        state['measure_error'] = str(e)
    run.timings['measure'] = round(time.time() - t, 2)
    run.stage('layout', LAYOUT_IDS, lambda: layout.checks(d, model, m, drc))
    if drc_json is not None and drc is not None:
        run.add(outline_check(drc))

    run.say('Working out the power tree')
    from . import electrical, power, ratings as RT, spice
    pm = state['pm'] = _safe(lambda: power.power_model(d, env), {'nets': {}, 'regulators': [], 'dissipation': {}})
    comps = {c['ref']: c for c in d['components']}

    def rate(ref):
        c = comps.get(ref)
        p = d['parts'].get(c['part']) if c else None
        return RT.ratings(p, c) if p else {}

    report = dict(power=dict(tree=[], drop=[], pdn=[], step=[]), stress=[], thermal=None)

    run.say('Simulating the circuit in ngspice')

    def do_spice():
        res, rep, op = spice.run(d, env, pm, os.path.join(work, 'spice'))
        state['op'] = op or {}
        report['power']['pdn'] = rep.get('pdn', [])
        report['power']['step'] = rep.get('step', [])
        report['stress'] += rep.get('stress', [])
        if rep.get('ngspice'):
            state['ngspice'] = rep['ngspice']
        # LEDs and transistors on a supply draw what the simulation says they do
        for n in pm.get('nets', {}).values():
            for sk in n.get('sinks', []):
                if sk.get('current') is None and (op or {}).get(sk['ref'], {}).get('current') is not None:
                    sk['current'] = abs(float(op[sk['ref']]['current']))
        # resistors and LEDs heat the board too: their simulated power
        diss = pm.setdefault('dissipation', {})
        for ref, x in (op or {}).items():
            if ref not in diss and (x.get('power') or 0) > 0.001:
                diss[ref] = dict(power=x['power'], how='simulated: %.1f mW' % (1000 * x['power']), assumed=False)
        return res
    run.stage('spice', SPICE_IDS, do_spice)

    run.say('Checking power, part ratings and sourcing')

    def do_electrical():
        res, rep = electrical.checks(d, env, pm, state.get('op'))
        report['power']['tree'] = rep.get('tree', [])
        report['stress'] += rep.get('stress', [])
        return res
    run.stage('electrical', ELECTRICAL_IDS, do_electrical)

    run.say('Solving voltage drop and heat')
    from . import heat

    def do_heat():
        res, rep, tm = heat.run(d, env, model, pm, rate, emit=run.say)
        report['power']['drop'] = rep['drop']
        report['thermal'] = rep['thermal']
        run.timings.update(tm)
        return res
    run.stage('heat', HEAT_IDS, do_heat)

    run.say('Writing the report')
    files = write_report(run.results, report, d, env, model, out, slug, run.timings, state)
    emit('Tests done', 1.0)
    return run.results, files


def outline_check(drc):
    from .drc import describe, where
    if drc is None:
        return C.skip('outline', "KiCad's DRC report is not available")
    f = drc.get('outline', [])
    if f:
        return C.result('outline', 'fail', detail=describe(f), where=where(f),
                        fix='Redraw the board outline as one closed shape.')
    return C.result('outline', 'pass', detail='one closed outline')


def _safe(fn, default):
    try:
        return fn()
    except Exception:                                         # noqa: BLE001 -- the stages using it say so
        traceback.print_exc(file=sys.stderr)
        return default


def _signal_nets(d, model):
    kinds = {n: x.get('kind', 'signal') for n, x in d['nets'].items()}
    return sorted({t['net'] for t in model['tracks'] if t['net'] and kinds.get(t['net'], 'signal') == 'signal'})


# ---------------------------------------------------------------- report
def stackup(d, model):
    from .. import rules
    bd = d['board']
    roles = {r['layer']: r for r in bd.get('layer_roles', [])}
    rows = [dict(name='F.Silkscreen', kind='silk'), dict(name='F.Mask', kind='mask', thickness=0.01)]
    for i, name in enumerate(model['layers']):
        role = roles.get(name)
        rows.append(dict(name=name, kind='copper', thickness=model['copper_mm'][i],
                         role=('plane %s' % role.get('net', '')).strip() if role and role['role'] == 'plane' else (role['role'] if role else 'signal')))
        if i < len(model['layers']) - 1:
            core = len(model['layers']) == 2 or i % 2 == 1
            rows.append(dict(name='Core' if core else 'Prepreg', kind='dielectric', thickness=model['dielectric_mm'][i],
                             material='FR4' if core else 'FR4 prepreg (7628)'))
    rows += [dict(name='B.Mask', kind='mask', thickness=0.01), dict(name='B.Silkscreen', kind='silk')]
    return rows


def summary(results):
    n = {s: sum(1 for r in results if r['status'] == s) for s in ('pass', 'fail', 'warn', 'skip', 'na')}
    n['verdict'] = 'fix' if n['fail'] else 'check' if n['warn'] else 'ready'
    return n


def write_report(results, report, d, env, model, out, slug, timings, state):
    import subprocess
    from . import heat
    tools = {}
    try:
        tools['kicad'] = subprocess.run(['kicad-cli', 'version'], capture_output=True, text=True, timeout=30).stdout.strip()
    except Exception:                                         # noqa: BLE001 -- a version is nice to have
        pass
    if state.get('ngspice'):
        tools['ngspice'] = state['ngspice']
    try:
        from . import sim
        v = sim.version()
        tools['hardhub-sim'] = str(v.get('version', v)) if isinstance(v, dict) else str(v)
    except Exception:                                         # noqa: BLE001
        pass
    bd = d['board']
    rep = dict(version=1, made_at=datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='seconds'),
               tools=tools, ambient=dict(min=env['ambient_min'], max=env['ambient_max'], points=heat.ambients(env)),
               board=dict(width=bd['width'], height=bd['height'], layers=bd['layers'], thickness=bd.get('thickness', 1.6),
                          stackup=stackup(d, model)),
               summary=summary(results), thermal=report.get('thermal'), power=report['power'],
               stress=report.get('stress', []), timings=timings)
    js = os.path.join(out, slug + '-tests.json')
    with open(js, 'w') as f:
        json.dump(_no_nulls(rep), f, separators=(',', ':'))
    md = os.path.join(out, slug + '-tests.md')
    with open(md, 'w') as f:
        f.write(markdown(results, rep, d))
    return [js, md]


def _no_nulls(x):
    """A field with no value is left out, not written as null (the report's
    schema, packages/protocol/src/review.ts, has optional fields, not nullable
    ones); thermal stays null when the heat solver did not run."""
    if isinstance(x, dict):
        return {k: _no_nulls(v) for k, v in x.items() if v is not None or k == 'thermal'}
    if isinstance(x, list):
        return [_no_nulls(v) for v in x]
    return x


def markdown(results, rep, d):
    """The report for people and AIs: what to fix first, with where and how."""
    s = rep['summary']
    areas = dict(C.AREAS)
    lines = ['# Board tests: %s %s' % (d.get('name', 'board'), d.get('revision', '')), '',
             '%d tests: %d pass, %d to fix, %d to look at, %d not run, %d do not apply. Outside temperature %g to %g °C.' % (
                 len(results), s['pass'], s['fail'], s['warn'], s['skip'], s['na'], rep['ambient']['min'], rep['ambient']['max']),
             '', 'Board: %g x %g mm, %d copper layers, %g mm thick.' % (rep['board']['width'], rep['board']['height'],
                                                                      rep['board']['layers'], rep['board']['thickness']), '']

    def block(r):
        out = ['### %s (%s, `%s`)' % (r['name'], areas.get(r['group'], r['group']), r['id'])]
        if r.get('detail'):
            out.append('- Found: %s' % r['detail'])
        if r.get('measured'):
            mm = r['measured']
            out.append('- Measured: %s %g %s%s' % (mm['label'], mm['value'], mm['unit'],
                                                   ' (needs %s %g)' % (mm['op'], mm['limit']) if 'limit' in mm else ''))
        if r.get('where'):
            out.append('- Where (mm from the board centre): ' + '; '.join(
                '(%.1f, %.1f)%s%s' % (w['x'], w['y'], ' ' + w['layer'] if w.get('layer') else '',
                                       ' ' + ', '.join(w['refs']) if w.get('refs') else '') for w in r['where'][:8]))
        if r.get('fix'):
            out.append('- Fix: %s' % r['fix'])
        out.append('- Why: %s. Tested by: %s' % (r['why'], r.get('tool', 'HardHub rules')))
        return out + ['']
    for title, st in (('To fix before ordering', 'fail'), ('To look at', 'warn'), ('Not run', 'skip')):
        rs = [r for r in results if r['status'] == st]
        if rs:
            lines += ['## %s (%d)' % (title, len(rs)), '']
            for r in rs:
                lines += block(r)
    rs = [r for r in results if r['status'] == 'pass']
    if rs:
        lines += ['## Passed (%d)' % len(rs), '']
        # each line tagged with its area and id, like the blocks above, so one area can be read alone
        lines += ['- %s (%s, `%s`)%s' % (r['name'], areas.get(r['group'], r['group']), r['id'], ': ' + r['detail'] if r.get('detail') else '') for r in rs]
        lines.append('')
    rs = [r for r in results if r['status'] == 'na']
    if rs:
        lines += ['## Does not apply (%d)' % len(rs), ''] + ['- %s (%s, `%s`): %s' % (r['name'], areas.get(r['group'], r['group']), r['id'], r.get('detail', '')) for r in rs] + ['']
    th = rep.get('thermal')
    if th and th.get('parts'):
        lines += ['## Heat', '', '| Part | Power | Board temperature by outside temperature | Rated |', '|---|---|---|---|']
        for p in th['parts'][:15]:
            lines.append('| %s | %.2f W | %s | %s |' % (p['ref'], p['power'], ', '.join('%g °C: %.0f °C%s' % (
                t['ambient'], t['board'], ' (inside %.0f)' % t['junction'] if t.get('junction') else '') for t in p['temps']),
                ('%g °C' % p['temp_max']) if p.get('temp_max') is not None else '?'))
        lines.append('')
    return '\n'.join(lines)
