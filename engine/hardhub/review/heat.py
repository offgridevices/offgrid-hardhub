# SPDX-License-Identifier: AGPL-3.0-or-later
"""Current and heat on the real copper: voltage drop, track and via
heating, and the board's temperature at each outside temperature.

The power model (power.py) says which part feeds each supply and how much
current each load draws; the Rust solver (hardhub-sim) turns the copper of
each supply into a resistor network and solves it at the hottest outside
temperature (copper resists more when hot), then solves the heat in the
whole board with every part's losses and the copper's own heating.
"""
import base64
import math

from . import catalog as C, sim

R, M = C.result, C.measure
BOARD_MAX = 105.0          # °C: FR4 (Tg ~130-140 °C) kept comfortably below its glass transition
TJ_MAX = 125.0             # °C: most chips' junction limit unless the datasheet says otherwise


def ambients(env):
    pts = sorted({float(env['ambient_min']), 25.0, float(env['ambient_max'])})
    return [p for p in pts if env['ambient_min'] <= p <= env['ambient_max']] or [float(env['ambient_max'])]


def ipc_rise(current, w_mm, t_mm, outer=True):
    """IPC-2221: the temperature rise (°C) of a track of width w and copper
    thickness t carrying `current` (inverse of I = k dT^0.44 A^0.725)."""
    k = 0.048 if outer else 0.024
    area = (w_mm / 0.0254) * (t_mm / 0.0254)            # mil^2
    if area <= 0 or current <= 0:
        return 0.0
    return (current / (k * area ** 0.725)) ** (1 / 0.44)


def via_capacity(drill, plating=0.025, rise=10.0):
    """IPC-2221 external formula on the via barrel (what KiCad's calculator
    does), capped at the 1 A per 0.3 mm via rule of thumb, scaled by drill."""
    area = math.pi * (drill + plating) * plating / 0.0254 ** 2
    ipc = 0.048 * rise ** 0.44 * area ** 0.725
    return min(ipc, 1.0 * drill / 0.3)


def decode(m, grid):
    raw = base64.b64decode(m['u8'] if 'u8' in m else m['u8_b64'])
    lo, hi = m['min'], m['max']
    return [lo + b / 255.0 * (hi - lo) for b in raw]


def sample(vals, grid, rect):
    """Hottest cell of a map inside rect [x0, y0, x1, y1] (design mm)."""
    x0, y0, dx, dy, nx, ny = grid['x0'], grid['y0'], grid['dx'], grid['dy'], grid['nx'], grid['ny']
    i0 = max(0, int((rect[0] - x0) / dx)); i1 = min(nx - 1, int((rect[2] - x0) / dx))
    j0 = max(0, int((rect[1] - y0) / dy)); j1 = min(ny - 1, int((rect[3] - y0) / dy))
    best = None
    for j in range(j0, j1 + 1):
        for i in range(i0, i1 + 1):
            v = vals[j * nx + i]
            best = v if best is None else max(best, v)
    return best


def run(d, env, model, pm, rate, emit=lambda label: None):
    """-> (results, report: {"drop": [...], "thermal": {...} | None}, timings)
    pm: power.power_model(); rate(ref) -> ratings dict for that part."""
    out, report, t = [], {'drop': [], 'thermal': None}, {}
    tmax = float(env['ambient_max'])
    nets = pm.get('nets', {})
    comp = {c['ref']: c for c in d['components']}
    have_pads = {(p['ref'], p['num']) for p in model['pads']}
    drops, heat_pts, tracks_hot, vias_hot, islands = [], [], [], [], []
    import time
    t0 = time.time()
    for name, n in sorted(nets.items()):
        if not n.get('source') or not n.get('sinks') or not n.get('voltage'):
            continue
        src_pads = [p for p in n.get('source_pads') or [] if (n['source'], p) in have_pads]
        sinks = [dict(ref=s['ref'], num=p, current=s['current'] / max(1, len(s['pads'])))
                 for s in n['sinks'] for p in s['pads'] if (s['ref'], p) in have_pads and s['current'] > 0]
        if not src_pads or not sinks:
            continue
        emit('Solving voltage drop on %s' % name)
        try:
            r = sim.run('irdrop', dict(board=model, net=name, temp_c=tmax,
                                       sources=[dict(ref=n['source'], num=p, voltage=n['voltage']) for p in src_pads],
                                       sinks=sinks))
        except sim.SimError as e:
            drops.append(dict(net=name, error=str(e)))
            continue
        pct = 100 * r['worst_mv'] / 1000 / n['voltage']
        drops.append(dict(net=name, source=n['source'], voltage=n['voltage'], current=sum(s['current'] for s in sinks),
                          worst_mv=r['worst_mv'], pct=pct, worst=r.get('worst'), sinks=r.get('sinks', []),
                          resistance_mohm=r.get('resistance_mohm')))
        heat_pts += r.get('heat', [])
        if r.get('track_max'):
            tracks_hot.append(dict(r['track_max'], net=name))
        if r.get('via_max'):
            vias_hot.append(dict(r['via_max'], net=name))
        islands += [dict(i, net=name) for i in r.get('islands', [])]
    t['irdrop'] = round(time.time() - t0, 2)
    report['drop'] = [dict(net=x['net'], source=x.get('source'), sinks=[dict(ref=s['ref'], drop_mv=s['drop_mv']) for s in x.get('sinks', [])],
                           worst_mv=round(x['worst_mv'], 2), pct=round(x['pct'], 3), resistance_mohm=x.get('resistance_mohm'))
                      for x in drops if 'error' not in x]

    # -------------------------------------------------------- voltage drop
    solved = [x for x in drops if 'error' not in x]
    if not nets:
        out.append(C.na('voltage-drop', 'no power nets with a voltage'))
    elif not solved:
        why = '; '.join('%s: %s' % (x['net'], x['error']) for x in drops if 'error' in x) or \
            'no supply has both a known source and loads on the board (set the net\'s source in the design)'
        out.append(C.skip('voltage-drop', why))
    else:
        w = max(solved, key=lambda x: x['pct'])
        st = 'pass' if w['pct'] <= 2 else 'warn' if w['pct'] <= 5 else 'fail'
        rows = ', '.join('%s %.1f mV (%.2f %%)' % (x['net'], x['worst_mv'], x['pct']) for x in sorted(solved, key=lambda x: -x['pct']))
        wh = []
        if w.get('worst'):
            p = next((p for p in model['pads'] if p['ref'] == w['worst'].get('ref') and p['num'] == w['worst'].get('num')), None)
            if p:
                wh.append(dict(x=p['x'], y=p['y'], refs=[p['ref']], net=w['net'], note='the farthest load'))
        if islands:
            st = 'fail'
            rows += '; no copper path from the supply to %s' % ', '.join('%s (%s)' % (','.join(i['refs']), i['net']) for i in islands[:4])
        out.append(R('voltage-drop', st, detail='at %g °C: %s' % (tmax, rows), where=wh,
                     measured=M('worst drop', w['pct'], '%', 2, '<='),
                     fix='Widen the supply track to %s, add a second track or a pour, or move the load closer to its supply.' % (w['worst'] or {}).get('ref', 'the load')))

    # -------------------------------------------------------- track heating
    if not tracks_hot:
        out.append(C.na('track-heating', 'no supply current solved on the copper') if not solved else
                   R('track-heating', 'pass', detail='the supply current flows in pours, not narrow tracks'))
    else:
        rows = []
        for tr in tracks_hot:
            outer = tr.get('layer') in (model['layers'][0], model['layers'][-1])
            i = model['layers'].index(tr['layer']) if tr.get('layer') in model['layers'] else 0
            rise = ipc_rise(tr['current'], tr['w'], model['copper_mm'][i], outer)
            rows.append(dict(tr, rise=rise, temp=tmax + rise))
        w = max(rows, key=lambda r: r['temp'])
        st = 'fail' if w['temp'] > BOARD_MAX else 'warn' if w['rise'] > 20 else 'pass'
        out.append(R('track-heating', st,
                     detail='busiest track: %s, %.2f A in %.2f mm on %s, %.1f °C above the air: %.0f °C on a %g °C day' % (
                         w['net'], w['current'], w['w'], w.get('layer', '?'), w['rise'], w['temp'], tmax),
                     measured=M('hottest track', w['temp'], '°C', BOARD_MAX, '<='),
                     where=[dict(x=w['at'][0], y=w['at'][1], net=w['net'], layer=w.get('layer'), note='busiest track')] if w.get('at') else None,
                     fix='Widen the %s track (or give the net a width or a pour) so it carries %.2f A with under a 20 °C rise.' % (w['net'], w['current'])))

    # -------------------------------------------------------- via current
    if not vias_hot:
        out.append(C.na('via-current', 'no supply current passes through a via') if solved else
                   C.na('via-current', 'no supply current solved on the copper'))
    else:
        drills = {(round(v['x'], 2), round(v['y'], 2)): v['drill'] for v in model['vias']}
        rows = []
        for v in vias_hot:
            drill = drills.get((round(v['at'][0], 2), round(v['at'][1], 2)), 0.3)
            rows.append(dict(v, cap=via_capacity(drill), drill=drill))
        w = max(rows, key=lambda r: r['current'] / r['cap'])
        st = 'pass' if w['current'] <= w['cap'] else 'warn'
        out.append(R('via-current', st, detail='busiest via: %.2f A on %s (%.2f mm hole carries about %.1f A)' % (w['current'], w['net'], w['drill'], w['cap']),
                     measured=M('busiest via', w['current'], 'A', round(w['cap'], 2), '<='),
                     where=[dict(x=w['at'][0], y=w['at'][1], net=w['net'], note='busiest via')],
                     fix='Put two or more vias side by side where %s changes layer.' % w['net']))

    # -------------------------------------------------------- heat
    sources = []
    parts = {p['ref']: p for p in model['parts']}
    for ref, x in (pm.get('dissipation') or {}).items():
        if x.get('power', 0) <= 0 or ref not in parts:
            continue
        rt = rate(ref) or {}
        sources.append(dict(ref=ref, power=float(x['power']), rect=parts[ref]['bbox'], side=parts[ref]['side'],
                            theta_jb=float(rt.get('theta_jb') or 0)))
    pts = ambients(env)
    emit('Simulating heat at %s °C' % ', '.join('%g' % a for a in pts))
    t0 = time.time()
    try:
        th = sim.run('thermal', dict(board=model, ambients=pts, cell=_cell(model), sources=sources, extra_heat=heat_pts,
                                     enclosed=bool(env.get('enclosed'))))
    except sim.SimError as e:
        th = None
        err = str(e)
    t['thermal'] = round(time.time() - t0, 2)
    if th is None:
        for cid in ('heat-parts-hot', 'heat-junction', 'heat-board'):
            out.append(C.skip(cid, 'the heat solver could not run: %s' % err[:200]))
        return out, report, t
    grid = th['grid']
    maps = {m['ambient']: m for m in th['maps']}
    hot = maps[max(maps)]
    vals = decode(hot, grid)
    by_ref = {p['ref']: p for p in th.get('parts', [])}
    diss = pm.get('dissipation') or {}
    rows = []
    decoded = {a: decode(m, grid) for a, m in maps.items()}
    for ref, part in parts.items():
        if ref.startswith('MH') or ref not in comp:
            continue
        rt = rate(ref) or {}
        temps = []
        for a in sorted(maps):
            board_t = sample(decoded[a], grid, part['bbox'])
            if board_t is None:
                continue
            j = None
            sp = by_ref.get(ref)
            if sp:
                tt = next((x for x in sp['temps'] if abs(x['ambient'] - a) < 1e-6), None)
                if tt:
                    board_t = max(board_t, tt['board'])
                    j = tt.get('junction')
            temps.append(dict(ambient=a, board=round(board_t, 2), **({'junction': round(j, 2)} if j is not None else {})))
        if not temps:
            continue
        rows.append(dict(ref=ref, power=round(float(diss.get(ref, {}).get('power', 0)), 4), temps=temps,
                         temp_max=rt.get('temp_max'), temp_min=rt.get('temp_min'),
                         assumed=bool(set(rt.get('assumed') or []) & {'temp_max', 'temp_min'}) or bool(diss.get(ref, {}).get('assumed')),
                         how=diss.get(ref, {}).get('how')))
    report['thermal'] = dict(grid=grid, mask=th['mask_b64'],
                             maps=[dict(ambient=m['ambient'], min=round(m['min'], 2), max=round(m['max'], 2), u8=m['u8_b64'],
                                        **({'max_at': m['max_at']} if m.get('max_at') else {})) for m in th['maps']],
                             parts=sorted(rows, key=lambda r: -max(x['board'] for x in r['temps'])))

    # every part's case against its rating, on the hottest day
    over, close, worst = [], [], None
    for r in rows:
        if r['temp_max'] is None:
            continue
        tb = r['temps'][-1]['board']
        margin = r['temp_max'] - tb
        if worst is None or margin < worst[0]:
            worst = (margin, r, tb)
        if margin < 0:
            over.append((r, tb))
        elif margin < 10:
            close.append((r, tb))
    if worst is None:
        out.append(C.skip('heat-parts-hot', 'no part has a temperature rating'))
    else:
        margin, r, tb = worst
        meas = M('least margin to a rating', margin, '°C', 0, '>=')
        wh = lambda lst: [dict(x=parts[x['ref']]['x'], y=parts[x['ref']]['y'], refs=[x['ref']], note='%.0f °C, rated %g °C' % (t_, x['temp_max'])) for x, t_ in lst]
        if over:
            out.append(R('heat-parts-hot', 'fail', detail='on a %g °C day: %s' % (tmax, ', '.join('%s %.0f °C (rated %g)' % (x['ref'], t_, x['temp_max']) for x, t_ in over[:6])),
                         measured=meas, where=wh(over),
                         fix='Spread the heat: more copper (a pour) under and around %s, thermal vias to the other side, a part rated hotter, or less power in it.' % over[0][0]['ref']))
        elif close:
            out.append(R('heat-parts-hot', 'warn', detail='within 10 °C of the rating on a %g °C day: %s' % (tmax, ', '.join('%s %.0f °C (rated %g)' % (x['ref'], t_, x['temp_max']) for x, t_ in close[:6])),
                         measured=meas, where=wh(close),
                         fix='Give %s more copper to spread its heat, or choose a part rated for a higher temperature.' % close[0][0]['ref']))
        else:
            out.append(R('heat-parts-hot', 'pass', detail='hottest against its rating: %s %.0f °C of %g °C on a %g °C day' % (r['ref'], tb, r['temp_max'], tmax),
                         measured=meas))

    # junctions of the chips that make heat
    js = []
    for r in rows:
        j = r['temps'][-1].get('junction')
        if j is not None and r['power'] >= 0.05:
            rt = rate(r['ref']) or {}
            lim = max(TJ_MAX, float(rt.get('temp_max') or 0)) if (rt.get('temp_max') or 0) >= 100 else TJ_MAX
            js.append((r, j, lim))
    if not js:
        out.append(C.na('heat-junction', 'no chip turns more than 50 mW into heat'))
    else:
        r, j, lim = max(js, key=lambda x: x[1] - x[2])
        st = 'fail' if j > lim else 'warn' if j > lim - 15 else 'pass'
        out.append(R('heat-junction', st, detail='%s: %.2f W, its silicon at %.0f °C on a %g °C day (limit %g °C)%s' % (
            r['ref'], r['power'], j, tmax, lim, ('; ' + r['how']) if r.get('how') else ''),
            measured=M('hottest chip inside', j, '°C', lim, '<='),
            where=[dict(x=parts[r['ref']]['x'], y=parts[r['ref']]['y'], refs=[r['ref']])],
            fix='Cut %s\'s losses (a switching regulator instead of a linear one, or a lower input voltage), or add copper and thermal vias under its tab.' % r['ref']))

    hmax = hot['max']
    at = hot.get('max_at')
    out.append(R('heat-board', 'pass' if hmax <= BOARD_MAX - 20 else 'warn' if hmax <= BOARD_MAX else 'fail',
                 detail='hottest spot %.0f °C on a %g °C day (%.0f °C on a %g °C day)' % (hmax, tmax, maps[min(maps)]['max'], min(maps)),
                 measured=M('hottest spot', hmax, '°C', BOARD_MAX, '<='),
                 where=[dict(x=at[0], y=at[1], note='hottest spot')] if at else None,
                 fix='Spread the hottest part\'s heat into more copper, or lower its losses.'))
    return out, report, t


def _cell(model):
    xs = [p[0] for p in model['outline']] or [0]
    ys = [p[1] for p in model['outline']] or [0]
    span = max(max(xs) - min(xs), max(ys) - min(ys), 1)
    return 0.5 if span <= 120 else round(span / 240, 2)
