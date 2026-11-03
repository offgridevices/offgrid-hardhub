# SPDX-License-Identifier: AGPL-3.0-or-later
"""Design-level electrical checks: what an experienced engineer checks on the
schematic before a board is ordered.

    results, report = checks(d, env, pm, op=None)

d    the design; env the run's environment (power.environment); pm the power
     model (power.power_model); op the circuit simulation's worst cases per part
     ({ref: {current, power, voltage}}, from spice.run), when it ran.
report = {"tree": [...], "stress": [...]}  (spec §5: power.tree and stress)

Every result is made from the catalogue (catalog.result).  Where a number
came from a typical value instead of the datasheet, a result that would fail
only warns, and says the value was assumed.
"""
import re

from . import catalog as K
from . import ratings as RT
from .power import Board, environment

IDS = ['power-budget', 'regulator-headroom', 'regulator-input', 'decoupling', 'bulk-caps', 'input-protection',
       'usb-c-cc', 'heat-parts-cold', 'stress-cap-voltage', 'stress-cap-dcbias', 'stress-ic-voltage',
       'stress-connector-current', 'i2c-pullups', 'floating-inputs', 'stock-qty', 'extended-parts', 'datasheets',
       'ratings-known', 'polarity-marks', 'two-sided', 'board-size', 'stackup']

# JLCPCB limits (research report of 2026-11-03, from JLCPCB's help pages and the kicad-druid capability
# file that tracks https://jlcpcb.com/capabilities/pcb-capabilities; re-check there):
# board 3 x 3 mm minimum (5 x 5 mm under 0.8 mm thick); maximum 670 x 600 mm (2 layers),
# 663 x 593 (4), 656 x 586 (6 and up).  Assembly: 10 x 10 mm minimum; single boards up to
# 480 x 320 mm (2 layers) and 350 x 320 mm (4-6 layers) in JLCPCB's assembly capability table.
FAB_MIN = 3.0
FAB_MIN_THIN = 5.0
FAB_MAX = {1: (606, 510), 2: (670, 600), 4: (663, 593)}
FAB_MAX_MANY = (656, 586)
ASM_MIN = 10.0
ASM_MAX = {2: (480, 320)}
ASM_MAX_MANY = (350, 320)
STD_THICKNESS = (0.4, 0.6, 0.8, 1.0, 1.2, 1.6, 2.0)      # JLCPCB's standard thickness options (mm)
# a ceramic capacitor keeping under 40 % of its marked value is doing less than half its job even
# allowing for the estimate's spread (about ±10 points against makers' curves)
DCBIAS_MIN_PCT = 40
STD_CAP_V = (6.3, 10.0, 16.0, 25.0, 35.0, 50.0, 100.0)
EXTENDED_FEE = 3.0                                     # US$ loading fee per extended part type (JLCPCB)

GROUND_ONLY_PADS = re.compile(r'^(S\d*|SH\d*|MP\d*|EH\d*)$')   # connector shield / mounting pads


# ------------------------------------------------------------------ small helpers

def _v(x):
    return ('%.2f' % x).rstrip('0').rstrip('.') + ' V' if x is not None else '? V'


def _ma(a):
    if a is None:
        return '? mA'
    return '%.0f mA' % (a * 1e3) if a < 1 else '%.2f A' % a


def _uf(f):
    if f >= 1e-6:
        return ('%.1f µF' % (f * 1e6)).replace('.0 µF', ' µF')
    if f >= 1e-9:
        return '%.0f nF' % (f * 1e9)
    return '%.0f pF' % (f * 1e12)


def _list(xs, n=8):
    xs = list(xs)
    return ', '.join(xs[:n]) + (' and %d more' % (len(xs) - n) if len(xs) > n else '')


def _where(b, refs, note=None, net=None):
    """Board positions of these parts, from the design's placement (the runner fills it from the
    routed board).  Parts with no position are left out; None if none has one."""
    out = []
    for r in refs:
        pl = b.d.get('placement', {}).get(r)
        if pl and pl.get('x') is not None:
            w = dict(x=pl['x'], y=pl['y'], refs=[r])
            if note:
                w['note'] = note
            if net:
                w['net'] = net
            out.append(w)
    return out or None


def _caps_between(b, net, others):
    """Capacitors with one pin on `net` and the other on one of `others`."""
    out = []
    for r in b.refs_on(net):
        if b.kind(r) != 'C':
            continue
        nets = set(b.nets_of(r))
        if net in nets and nets & set(others) and len(nets) == 2:
            out.append(r)
    return out


def _cap_value(b, r):
    p = b.parts[r]
    return RT.parse_capacitance(p.get('value')) or RT.parse_capacitance(p.get('description'))


def _status(bad_fail, bad_warn):
    return 'fail' if bad_fail else ('warn' if bad_warn else 'pass')


def _assembled(b, r):
    return b.parts[r].get('assembled', True) is not False


def _chips(b, pm):
    regs = {g['ref'] for g in pm['regulators']}
    return [r for r in b.comps if b.is_chip(r) and r not in regs and _assembled(b, r)]


# ------------------------------------------------------------------ the checks

def checks(d, env=None, pm=None, op=None):
    from .power import power_model
    b = Board(d)
    env = environment(b.d, env)
    pm = pm or power_model(b.d, env)
    report = dict(tree=[], stress=[])
    out = []
    for fn in (power_budget, regulator_headroom, regulator_input, decoupling, bulk_caps, input_protection,
               usb_c_cc, heat_parts_cold, stress_cap_voltage, stress_cap_dcbias, stress_ic_voltage,
               stress_connector_current, i2c_pullups, floating_inputs, stock_qty, extended_parts, datasheets,
               ratings_known, polarity_marks, two_sided, board_size, stackup):
        out.append(fn(b, env, pm, op, report))
    return out, report


def power_budget(b, env, pm, op, report):
    if not pm['nets']:
        return K.na('power-budget', 'the design has no power nets')
    fails, warns, lines, worst = [], [], [], None
    for n, e in sorted(pm['nets'].items()):
        src, load, cap = e['source'], e['load'], e['capacity']
        row = dict(net=n, voltage=e['voltage'], source=src, source_kind=e['source_kind'], load=load,
                   capacity=cap, **{'from': e['from_net']})
        if cap and load is not None:
            row['pct'] = round(100 * load / cap, 1)
        row['assumed'] = bool(e.get('capacity_assumed')) or e['stated_current'] is None
        report['tree'].append(row)
        if not src:
            warns.append('nothing on the board supplies %s (no regulator output, connector or battery on it)' % n)
            continue
        if e['stated_current'] is None and any(s['kind'] == 'chip' for s in e['sinks']):
            warns.append('%s does not say how much current it carries, so its load is unknown' % n)
        if e.get('note'):
            warns.append('%s: %s' % (n, e['note']))
        if e['source_kind'] == 'usb' and load is not None:
            if load > 3.0 + 1e-9:
                fails.append('%s draws %s from USB: more than USB-C gives without Power Delivery (3 A)' % (n, _ma(load)))
            elif load > e['usb_default'] + 1e-9:
                warns.append('%s draws %s from USB; a USB port only promises 500 mA unless the charger offers more '
                             '(USB-C 1.5 A or 3 A): fine on most USB-C chargers, not on a computer\'s USB 2.0 port'
                             % (n, _ma(load)))
        if cap is None or load is None:
            if load:
                warns.append("%s's supply %s has no known current rating" % (n, src))
            continue
        pct = 100 * load / cap
        if worst is None or pct > worst[0]:
            worst = (pct, n, src)
        what = '%s from %s: %s of %s (%.0f %%)' % (n, src, _ma(load), _ma(cap), pct)
        lines.append(what)
        if pct > 100:
            (warns if e.get('capacity_assumed') else fails).append(
                '%s needs %s but %s can deliver only %s%s' % (n, _ma(load), src, _ma(cap),
                                                             ' (rating assumed)' if e.get('capacity_assumed') else ''))
        elif pct > 80:
            warns.append('%s runs %s at %.0f %% of its %s rating: little margin for a busy moment' % (n, src, pct, _ma(cap)))
    st = _status(fails, warns)
    detail = '; '.join(fails + warns) if st != 'pass' else 'every supply has room: ' + '; '.join(lines)
    fix = None
    if st != 'pass':
        fix = ('Use a regulator or connector rated for the current its loads draw (or split the loads over two '
               'supplies), and give every power net its supplying part and its current.')
    m = K.measure('busiest supply, share of its rating', worst[0], '%', 100, '<=') if worst else None
    return K.result('power-budget', st, detail=detail, measured=m, fix=fix,
                    where=_where(b, [worst[2]] if worst else []))


def regulator_headroom(b, env, pm, op, report):
    regs = pm['regulators']
    if not regs:
        return K.na('regulator-headroom', 'the board has no voltage regulator')
    fails, warns, oks, worst, fixes = [], [], [], None, []
    for g in regs:
        r, vin, vout = g['ref'], g['vin'], g['vout']
        if vin is None or vout is None:
            warns.append("could not tell %s's input and output voltages (give its nets a voltage)" % r)
            continue
        vin_low = pm['nets'].get(g['in_net'], {}).get('v_min') or vin
        if g['kind'] == 'ldo':
            need = g['dropout']
            assumed = 'dropout' in g['assumed']
            margin, margin_low = vin - vout - need, vin_low - vout - need
            if worst is None or margin_low < worst[0]:
                worst = (margin_low, r)
            say = ('%s makes %s from %s; it needs its input at least %s above its output (its dropout%s)'
                   % (r, _v(vout), _v(vin), _v(need), ', assumed' if assumed else ''))
            if margin < 0:
                (warns if assumed and vin > vout else fails).append(say + ', but has only %s' % _v(vin - vout))
                fixes.append('feed %s from a higher supply (at least %s), or use a low-dropout regulator '
                             '(e.g. AP2112, 0.4 V dropout)' % (r, _v(vout + need)))
            elif margin_low < 0:
                warns.append(say + ': fine at %s, but at the supply\'s low end (%s) it has only %s'
                             % (_v(vin), _v(vin_low), _v(vin_low - vout)))
                fixes.append('use a lower-dropout regulator for %s or a higher input' % r)
            else:
                oks.append('%s: %s spare above its %s dropout even at %s in' % (r, _v(margin_low), _v(need), _v(vin_low)))
        elif g['kind'] == 'buck':
            vmin = g.get('vin_min')
            assumed = vmin is None
            need = vmin if vmin is not None else vout + 1.0         # a buck tops out near 90 % duty: ~1 V spare
            margin_low = vin_low - max(need, vout)
            if worst is None or margin_low < worst[0]:
                worst = (margin_low, r)
            if vin <= vout:
                fails.append('%s steps down, but its input (%s) is not above its output (%s)' % (r, _v(vin), _v(vout)))
                fixes.append('a buck regulator needs a higher input than output: use a boost or buck-boost for %s' % r)
            elif vin_low < need:
                (warns if assumed else fails).append('%s needs at least %s in%s, its input can be %s'
                                                     % (r, _v(need), ' (assumed)' if assumed else '', _v(vin_low)))
                fixes.append('feed %s from a higher supply' % r)
            else:
                oks.append('%s: %s in for %s out' % (r, _v(vin), _v(vout)))
        else:
            margin_low = vout - (pm['nets'].get(g['in_net'], {}).get('v_max') or vin)
            if worst is None or margin_low < worst[0]:
                worst = (margin_low, r)
            if margin_low <= 0:
                fails.append('%s steps up, but its input (%s) is not below its output (%s)' % (r, _v(vin), _v(vout)))
                fixes.append('use a buck or buck-boost regulator for %s' % r)
            else:
                oks.append('%s: steps %s up to %s' % (r, _v(vin), _v(vout)))
    st = _status(fails, warns)
    detail = '; '.join(fails + warns) if st != 'pass' else '; '.join(oks)
    m = K.measure('smallest spare input voltage', worst[0], 'V', 0, '>=') if worst else None
    return K.result('regulator-headroom', st, detail=detail, measured=m, fix='; '.join(fixes) or None,
                    where=_where(b, [worst[1]] if worst else []))


def regulator_input(b, env, pm, op, report):
    regs = pm['regulators']
    if not regs:
        return K.na('regulator-input', 'the board has no voltage regulator')
    fails, warns, oks, worst = [], [], [], None
    for g in regs:
        r = g['ref']
        vin = pm['nets'].get(g['in_net'], {}).get('v_max') if g['in_net'] else None
        vmax, assumed = g['vin_max'], 'voltage_max' in g['assumed']
        if vin is None:
            warns.append("could not tell %s's input voltage" % r)
            continue
        if vmax is None:
            warns.append("%s's maximum input voltage is not known: add it from the datasheet" % r)
            continue
        pct = 100 * vin / vmax
        if worst is None or pct > worst[0]:
            worst = (pct, r)
        if vin > vmax:
            (warns if assumed else fails).append('%s sees up to %s but is rated for %s%s' % (
                r, _v(vin), _v(vmax), ' (rating assumed: check the datasheet)' if assumed else ''))
        else:
            oks.append('%s: up to %s in, rated %s%s' % (r, _v(vin), _v(vmax), ' (assumed)' if assumed else ''))
    st = _status(fails, warns)
    return K.result('regulator-input', st, detail='; '.join(fails + warns) if st != 'pass' else '; '.join(oks),
                    measured=K.measure('highest input, share of the maximum', worst[0], '%', 100, '<=') if worst else None,
                    fix='Use a regulator rated for the highest input voltage it will see, with some margin.'
                    if st != 'pass' else None, where=_where(b, [worst[1]] if worst else []))


def decoupling(b, env, pm, op, report):
    chips = _chips(b, pm)
    if not chips:
        return K.na('decoupling', 'the board has no chips besides regulators')
    gnd = b.ground
    fails, warns, oks, fixes, bad_refs, none_refs = [], [], [], [], [], []
    per_net = {}
    for r in chips:
        for n in b.nets_of(r):
            if n in b.power:
                per_net.setdefault(n, []).append(r)
    no_supply = [r for r in chips if not any(n in b.power for n in b.nets_of(r))]
    for n, users in sorted(per_net.items()):
        caps = _caps_between(b, n, gnd)
        small = [c for c in caps if (_cap_value(b, c) or 1) <= 1.0001e-6]
        if not caps:
            fails.append('%s on %s %s no capacitor to ground at all' % (_list(users), n, 'has' if len(users) == 1 else 'have'))
            fixes.append('add a 100 nF ceramic capacitor (0402, X7R, 16 V) from %s to ground next to each of %s'
                         % (n, _list(users)))
            bad_refs += users
            none_refs += users
        elif not small:
            warns.append('%s on %s only %s large capacitors (%s); fast spikes need a small one right at each chip'
                         % (_list(users), n, 'has' if len(users) == 1 else 'have', _list(caps)))
            fixes.append('add a 100 nF capacitor from %s to ground beside each of %s' % (n, _list(users)))
            bad_refs += users
        elif len(small) < len(users):
            warns.append('%d chips on %s (%s) share %d small capacitor%s (%s): one each is the rule'
                         % (len(users), n, _list(users), len(small), '' if len(small) == 1 else 's', _list(small)))
            fixes.append('add a 100 nF capacitor from %s to ground beside each chip that lacks one' % n)
            bad_refs += users
        else:
            oks.append('%s: %s for %s' % (n, _list(small), _list(users)))
    detail = '; '.join(fails + warns) if (fails or warns) else '; '.join(oks)
    if no_supply:
        detail += '%s%s %s no pin on a power net, so %s not checked' % (
            '; ' if detail else '', _list(no_supply), 'has' if len(no_supply) == 1 else 'have',
            'it was' if len(no_supply) == 1 else 'they were')
    return K.result('decoupling', _status(fails, warns), detail=detail, fix='; '.join(fixes) or None,
                    where=_where(b, bad_refs, note='needs a decoupling capacitor'),
                    measured=K.measure('chips without a capacitor on their supply', len(set(none_refs)), 'count', 0, '<='))


def bulk_caps(b, env, pm, op, report):
    regs = pm['regulators']
    if not regs:
        return K.na('bulk-caps', 'the board has no voltage regulator')
    fails, warns, oks, fixes, notes = [], [], [], [], []
    for g in regs:
        r = g['ref']
        for side, net, need in (('input', g['in_net'], g.get('cin') or 1e-6), ('output', g['out_net'], g.get('cout') or 1e-6)):
            if not net:
                warns.append('could not find the %s net of %s' % (side, r))
                continue
            caps = _caps_between(b, net, b.ground)
            total = sum(_cap_value(b, c) or 0 for c in caps)
            if not caps:
                fails.append('%s has no capacitor on its %s (%s)' % (r, side, net))
                fixes.append('add a %s ceramic capacitor from %s to ground right at %s\'s %s pin'
                             % (_uf(need), net, r, side))
            elif total < need * 0.999:
                warns.append("%s's %s (%s) has %s, its datasheet asks for %s" % (r, side, net, _uf(total), _uf(need)))
                fixes.append('raise the capacitance on %s to at least %s' % (net, _uf(need)))
            else:
                oks.append('%s %s %s: %s (%s)' % (r, side, net, _uf(total), _list(caps)))
        if g.get('family') in ('AMS1117', 'LM1117') and g['out_net']:
            caps = _caps_between(b, g['out_net'], b.ground)
            if caps and all(RT.cap_type(b.parts[c]) == 'ceramic' for c in caps):
                notes.append('%s: its datasheet shows a tantalum output capacitor (a little resistance in the '
                             'capacitor keeps older 1117 designs stable); most boards run it on 22 µF ceramic '
                             'without trouble' % r)
    st = _status(fails, warns)
    detail = '; '.join(fails + warns) if st != 'pass' else '; '.join(oks)
    if notes:
        detail += '. Note: ' + '; '.join(notes)
    return K.result('bulk-caps', st, detail=detail, fix='; '.join(fixes) or None,
                    where=_where(b, [g['ref'] for g in regs]))


_PROTECT = re.compile(r'fuse|polyfuse|PTC|resettable|TVS|transient|ESD|ideal diode|reverse|eFuse|load switch|'
                      r'SMAJ|SMBJ|SMF\d|PESD|USBLC', re.I)


def input_protection(b, env, pm, op, report):
    inputs = [(n, e) for n, e in sorted(pm['nets'].items()) if e['source_kind'] in ('usb', 'external')]
    if not inputs:
        return K.na('input-protection', 'no power comes in from outside the board')
    found, missing, fixes = [], [], []
    for n, e in inputs:
        prot = []
        for r in b.refs_on(n):
            if r == e['source']:
                continue
            p = b.parts[r]
            if b.kind(r) == 'F' or _PROTECT.search(p.get('description', '') + ' ' + p.get('mpn', '')):
                prot.append(r)
            elif b.kind(r) == 'D' and any(lr == r for lr, up, dn in pm['links'] if up == n):
                prot.append(r)                                     # a series diode: reverse-polarity protection
        if prot:
            found.append('%s (from %s): %s' % (n, e['source'], _list(prot)))
        else:
            missing.append(n)
            if e['source_kind'] == 'usb':
                fixes.append('on %s, add a 5 V TVS diode to ground (e.g. SMF5.0A or SMAJ5.0A) and a 0.5-1 A '
                             'polyfuse in series after %s' % (n, e['source']))
            else:
                fixes.append('on %s, add a fuse or polyfuse after %s, a TVS diode rated just above %s to ground, '
                             'and a series Schottky diode or P-MOSFET against a reversed plug'
                             % (n, e['source'], _v(e['voltage'])))
    if missing:
        usb_only = all(pm['nets'][n]['source_kind'] == 'usb' for n in missing)
        detail = ('%s %s straight into the board with no fuse or protection part' %
                  (_list(missing), 'comes' if len(missing) == 1 else 'come'))
        if usb_only:
            detail += ('. Common on small USB boards (USB ports limit their own current), but a faulty charger '
                       'or a static zap then reaches the parts directly')
        if found:
            detail += '; protected: ' + '; '.join(found)
        return K.result('input-protection', 'warn', detail=detail, fix='; '.join(fixes),
                        where=_where(b, [pm['nets'][n]['source'] for n in missing]))
    return K.result('input-protection', 'pass', detail='; '.join(found))


_PD = re.compile(r'CH224|CH221|FUSB30|STUSB|IP2721|HUSB23|TPS2575|TPS6598|AP3310|SW35|PD controller|'
                 r'power delivery|USB-C controller|CC logic|CYPD', re.I)


def _cc_pads(b, ref):
    """The CC1 and CC2 pads of a USB-C receptacle: by pad name (A5/B5, USB-C pinout), else by net name."""
    pins = b.comps[ref]['pins']
    found = {}
    for pad, cc in (('A5', 'CC1'), ('B5', 'CC2')):
        if pad in pins:
            found[cc] = (pad, pins[pad])
    if len(found) < 2:
        for pad, net in pins.items():
            if net and re.search(r'CC1', net, re.I):
                found.setdefault('CC1', (pad, net))
            elif net and re.search(r'CC2', net, re.I):
                found.setdefault('CC2', (pad, net))
    return found


def usb_c_cc(b, env, pm, op, report):
    ports = [r for r in b.comps if b.is_usb_c(r)]
    if not ports:
        return K.na('usb-c-cc', 'the board has no USB-C socket')
    fails, warns, oks, fixes = [], [], [], []
    for j in ports:
        cc = _cc_pads(b, j)
        if len(cc) < 2:
            warns.append('could not find both CC pins of %s (pads A5 and B5, or nets named CC1/CC2)' % j)
            continue
        (p1, n1), (p2, n2) = cc['CC1'], cc['CC2']
        if not n1 or not n2:
            fails.append('%s has a CC pin left unconnected (%s)' % (j, 'CC1' if not n1 else 'CC2'))
            fixes.append('connect %s CC1 (A5) and CC2 (B5) each to its own 5.1 kΩ resistor to ground' % j)
            continue
        if n1 == n2:
            fails.append('%s has CC1 and CC2 joined on one net (%s): each needs its own resistor, or some '
                         'chargers give no power' % (j, n1))
            fixes.append('split %s into two nets, each with its own 5.1 kΩ resistor to ground' % n1)
            continue
        for name, net in (('CC1', n1), ('CC2', n2)):
            pd = [r for r in b.refs_on(net) if r != j and b.is_chip(r)
                  and _PD.search(b.parts[r].get('mpn', '') + ' ' + b.parts[r].get('description', ''))]
            if pd:
                oks.append('%s %s goes to the USB-C controller %s' % (j, name, pd[0]))
                continue
            rd, rp = [], []
            for r in b.refs_on(net):
                if b.kind(r) != 'R':
                    continue
                other = [m for m in b.nets_of(r) if m != net]
                if other and other[0] in b.ground:
                    rd.append(r)
                elif other and other[0] in b.power:
                    rp.append(r)
            good = [r for r in rd if b.resistance(r) is not None and 4080 <= b.resistance(r) <= 6120]
            if good:
                oks.append('%s %s: %s %s to ground' % (j, name, good[0], _ohm(b.resistance(good[0]))))
            elif rd:
                warns.append('%s %s has %s to ground, but Rd must be 5.1 kΩ' % (j, name, _list('%s %s' % (r, _ohm(b.resistance(r))) for r in rd)))
                fixes.append('make %s 5.1 kΩ' % _list(rd))
            elif rp:
                warns.append('%s %s is pulled up to a supply (%s): that makes the board act as a power source, '
                             'not a power sink' % (j, name, _list(rp)))
                fixes.append('for a board powered from USB-C, replace %s with 5.1 kΩ to ground' % _list(rp))
            elif not any(b.is_chip(r) for r in b.refs_on(net) if r != j):
                fails.append('%s %s has no 5.1 kΩ resistor to ground' % (j, name))
                fixes.append('add a 5.1 kΩ resistor from %s (%s pad %s) to ground' % (net, j, cc[name][0]))
            else:
                warns.append('%s %s goes to %s, not a USB-C controller HardHub knows' % (
                    j, name, _list(r for r in b.refs_on(net) if r != j)))
    st = _status(fails, warns)
    return K.result('usb-c-cc', st, detail='; '.join(fails + warns) if st != 'pass' else '; '.join(oks),
                    fix='; '.join(fixes) or None, where=_where(b, ports))


def _ohm(r):
    if r is None:
        return '? Ω'
    if r >= 1e6:
        return '%g MΩ' % (r / 1e6)
    if r >= 1e3:
        return '%g kΩ' % (r / 1e3)
    return '%g Ω' % r


def heat_parts_cold(b, env, pm, op, report):
    cold = env['ambient_min']
    fails, warns, worst = [], [], None
    for r in b.comps:
        if b.kind(r) in ('TP', 'H'):
            continue
        rt = b.rating(r)
        t = rt.get('temp_min')
        if t is None:
            continue
        if worst is None or t > worst[0]:
            worst = (t, r)
        if t > cold + 1e-9:
            msg = '%s is rated down to %.0f °C only%s' % (r, t, ' (assumed)' if 'temp_min' in rt['assumed'] else '')
            (warns if 'temp_min' in rt['assumed'] else fails).append(msg)
    if worst is None:
        return K.skip('heat-parts-cold', 'no part has a temperature rating')
    st = _status(fails, warns)
    detail = ('; '.join(fails + warns) + ', but the coldest day is set to %.0f °C' % cold) if st != 'pass' else \
        'every part is rated to %.0f °C or colder; the coldest day is set to %.0f °C (%s is the closest, rated to %.0f °C)' % (
            worst[0], cold, worst[1], worst[0])
    return K.result('heat-parts-cold', st, detail=detail,
                    measured=K.measure('warmest lowest-rated temperature', worst[0], '°C', cold, '<='),
                    fix='Choose industrial-grade (-40 °C) versions of the parts listed, or raise the coldest temperature '
                        'if the board never sees it.' if st != 'pass' else None,
                    where=_where(b, [worst[1]]))


def _across(b, pm, op, r, key='v_max'):
    """Highest voltage across a two-pin part: from the nets' voltages (power nets at their highest,
    or nominal with key='voltage'), and from the circuit simulation when it ran.  None if neither knows."""
    pins = b.two_pin(r)
    if not pins:
        return None, None
    vs = []
    for n in pins:
        if n in b.ground:
            vs.append(0.0)
        elif n in pm['nets'] and pm['nets'][n].get(key) is not None:
            vs.append(pm['nets'][n][key])
        else:
            vs.append(None)
    v = abs(vs[0] - vs[1]) if None not in vs else None
    how = 'supply'
    if op and r in op and op[r].get('voltage') is not None:
        if v is None or op[r]['voltage'] > v:
            v, how = op[r]['voltage'], 'simulation'
    return v, how


def stress_cap_voltage(b, env, pm, op, report):
    caps = [r for r in b.comps if b.kind(r) == 'C']
    if not caps:
        return K.na('stress-cap-voltage', 'the board has no capacitors')
    fails, warns, unknown, worst, bad = [], [], [], None, []
    for r in caps:
        v, how = _across(b, pm, op, r)
        rt = b.rating(r)
        rated = rt.get('voltage_max')
        if v is None:
            unknown.append(r)
            continue
        ct = RT.cap_type(b.parts[r])
        limit = 50 if ct == 'tantalum' else 80
        pct = 100 * v / rated
        assumed = 'voltage_max' in rt['assumed']
        report['stress'].append(dict(ref=r, what='voltage', value=round(v, 3), rating=rated, pct=round(pct, 1),
                                     limit_pct=limit, ambient=env['ambient_max'],
                                     note=('rating assumed' if assumed else ct) + ('' if how == 'supply' else ', from the simulation')))
        if worst is None or pct / limit > worst[0] / worst[2]:
            worst = (pct, r, limit)
        msg = 'the %s capacitor %s sees up to %s and is rated %s%s (%.0f %%)' % (
            _uf(_cap_value(b, r)) if _cap_value(b, r) else '', r, _v(v), _v(rated), ' (assumed)' if assumed else '', pct)
        hard = 100 if ct != 'tantalum' else 80                # tantalums short when pushed past ~80 %
        if pct > hard:
            (warns if assumed else fails).append(msg)
            bad.append(r)
        elif pct > limit:
            warns.append(msg + ', above the %d %% a long life asks for' % limit)
            bad.append(r)
    st = _status(fails, warns)
    if worst is None:
        return K.skip('stress-cap-voltage', 'no capacitor sits between nets of known voltage')
    detail = '; '.join(fails + warns) if st != 'pass' else (
        'every capacitor is within %d %% of its rating (busiest: %s at %.0f %%)' % (worst[2], worst[1], worst[0]))
    if unknown:
        detail += '; %s not checked (signal nets of unknown voltage)' % _list(unknown, 5)
    extra = {} if op else dict(tool=K.RULES, how="Compares the highest supply voltage across each capacitor with its "
                                                 "rating: at most 80 % for ceramics, 50 % for tantalum.")
    return K.result('stress-cap-voltage', st, detail=detail,
                    measured=K.measure('busiest capacitor, share of its rated voltage', worst[0], '%', worst[2], '<='),
                    fix='Use capacitors rated at least 1.25 times the voltage they see (for ceramics), twice for tantalum: '
                        'for example a 25 V part on a 12 V supply.' if st != 'pass' else None,
                    where=_where(b, bad or [worst[1]]),
                    **extra)


def stress_cap_dcbias(b, env, pm, op, report):
    fails, warns, oks, fixes = [], [], [], []
    lo, hi = env['ambient_min'], env['ambient_max']
    seen, worst = 0, None
    for r in b.comps:
        if b.kind(r) != 'C':
            continue
        v, how = _across(b, pm, op, r, key='voltage')         # the working voltage, for a typical value
        if v is None:
            continue
        p = b.parts[r]
        left = [RT.mlcc_remaining(p, v, t) for t in (lo, hi)]
        if left[0] is None:
            continue
        seen += 1
        frac = min(left)
        c = _cap_value(b, r)
        report['stress'].append(dict(ref=r, what='capacitance', value=round(c * frac * 1e6, 3), rating=round(c * 1e6, 3),
                                     pct=round(100 * frac, 1), limit_pct=DCBIAS_MIN_PCT, ambient=hi if left[1] <= left[0] else lo,
                                     note='%s keeps ~%.0f %% at %s (typical curve)' % (RT.parse_dielectric(p), 100 * frac, _v(v))))
        if worst is None or frac < worst[0]:
            worst = (frac, r)
        size = RT.package(p)
        msg = ('the %s capacitor %s (%s %s, %s) keeps only about %.0f %% of its value at %s: about %s'
               % (_uf(c), r, RT.parse_dielectric(p), _v(b.rating(r)['voltage_max']), size, 100 * frac, _v(v), _uf(c * frac)))
        if frac < DCBIAS_MIN_PCT / 100:
            warns.append(msg)
            fixes.append('for %s use a larger case and a higher voltage rating (e.g. %s %s in %s), or add a second one'
                         % (r, _uf(c), _v(next(x for x in STD_CAP_V + (2 * v,) if x >= 2 * v)), _bigger(size)))
        else:
            oks.append('%s keeps %.0f %%' % (r, 100 * frac))
    if not seen:
        return K.na('stress-cap-dcbias', 'no X5R/X7R ceramic capacitor on a known voltage')
    st = _status(fails, warns)
    detail = '; '.join(warns) + '. These are typical figures from makers\' curves: check the exact part on its maker\'s ' \
             'DC-bias chart' if warns else 'every ceramic capacitor keeps at least %d %% of its value (%s)' % (
                 DCBIAS_MIN_PCT, _list(oks, 6))
    return K.result('stress-cap-dcbias', st, detail=detail,
                    measured=K.measure('least capacitance kept', 100 * worst[0], '%', DCBIAS_MIN_PCT, '>='),
                    fix='; '.join(fixes) or None, where=_where(b, [worst[1]]))


def _bigger(size):
    order = ['0201', '0402', '0603', '0805', '1206', '1210']
    return order[min(order.index(size) + 1, len(order) - 1)] if size in order else 'a larger case'


def stress_ic_voltage(b, env, pm, op, report):
    chips = _chips(b, pm)
    if not chips:
        return K.na('stress-ic-voltage', 'the board has no chips besides regulators')
    fails, warns, oks, unknown, worst = [], [], [], [], None
    for r in chips:
        sup = [n for n in b.nets_of(r) if n in pm['nets'] and pm['nets'][n].get('v_max') is not None]
        if not sup:
            continue
        v = max(pm['nets'][n]['v_max'] for n in sup)
        n = max(sup, key=lambda x: pm['nets'][x]['v_max'])
        rt = b.rating(r)
        vmax = rt.get('voltage_max')
        if vmax is None:
            unknown.append(r)
            continue
        assumed = 'voltage_max' in rt['assumed']
        pct = 100 * v / vmax
        report['stress'].append(dict(ref=r, what='supply voltage', value=round(v, 3), rating=vmax, pct=round(pct, 1),
                                     limit_pct=100, ambient=env['ambient_max'], note='from %s' % n))
        if worst is None or pct > worst[0]:
            worst = (pct, r)
        if v > vmax + 1e-9:
            (warns if assumed else fails).append('%s is powered from %s (up to %s) but takes at most %s' % (r, n, _v(v), _v(vmax)))
        else:
            oks.append('%s: up to %s on %s, max %s' % (r, _v(v), n, _v(vmax)))
    if unknown:
        warns.append('%s: maximum supply voltage not known (add ratings.voltage_max from the datasheet)' % _list(unknown))
    st = _status(fails, warns)
    if worst is None and not unknown:
        return K.skip('stress-ic-voltage', 'no chip sits on a power net of known voltage')
    return K.result('stress-ic-voltage', st, detail='; '.join(fails + warns) if st != 'pass' else '; '.join(oks),
                    measured=K.measure('highest supply, share of the maximum', worst[0], '%', 100, '<=') if worst else None,
                    fix='Power each chip listed from a supply within its datasheet range (add a regulator if needed).'
                    if fails else ('Look up the maximum supply voltage of the chips listed and add it to the design.'
                                   if st != 'pass' else None),
                    where=_where(b, [worst[1]] if worst else unknown))


def stress_connector_current(b, env, pm, op, report):
    feeds = {}
    for n, e in pm['nets'].items():
        if e['source_kind'] in ('usb', 'external') and e['source']:
            feeds.setdefault(e['source'], []).append(n)
    if not feeds:
        return K.na('stress-connector-current', 'no connector brings power onto the board')
    fails, warns, oks, worst = [], [], [], None
    for j, nets in sorted(feeds.items()):
        rt = b.rating(j)
        per = rt.get('current_max')
        assumed = 'current_max' in rt['assumed']
        flows = [(n, pm['nets'][n]['load'] or 0.0, pm['nets'][n]['source_pads']) for n in nets]
        ret = sum(f[1] for f in flows)
        gpads = [p for n in b.nets_of(j) if n in b.ground for p in b.nets_of(j)[n] if not GROUND_ONLY_PADS.match(p)]
        if gpads:
            flows.append(('ground', ret, gpads))
        for n, i, pads in flows:
            if not i:
                continue
            ipin = i / max(1, len(pads))
            if per is None:
                warns.append('%s: no current rating known' % j)
                continue
            pct = 100 * ipin / per
            report['stress'].append(dict(ref=j, what='current per contact', value=round(ipin, 4), rating=per,
                                         pct=round(pct, 1), limit_pct=80, ambient=env['ambient_max'],
                                         note='%s over %d contact%s%s' % (n, len(pads), '' if len(pads) == 1 else 's',
                                                                          ', rating assumed' if assumed else '')))
            if worst is None or pct > worst[0]:
                worst = (pct, j)
            msg = '%s carries %s on %s over %d contact%s: %s each, rated %s%s' % (
                j, _ma(i), n, len(pads), '' if len(pads) == 1 else 's', _ma(ipin), _ma(per), ' (assumed)' if assumed else '')
            if pct > 100:
                (warns if assumed else fails).append(msg)
            elif pct > 80:
                warns.append(msg + ': little margin')
            else:
                oks.append(msg)
    st = _status(fails, warns)
    return K.result('stress-connector-current', st, detail='; '.join(fails + warns) if st != 'pass' else '; '.join(oks),
                    measured=K.measure('busiest contact, share of its rating', worst[0], '%', 80, '<=') if worst else None,
                    fix='Use a connector rated for the current, or spread it over more contacts.' if st != 'pass' else None,
                    where=_where(b, list(feeds)))


_I2C = re.compile(r'(^|[_\-./])(I2C\d?_)?(SDA|SCL)\d*($|[_\-./])', re.I)


def i2c_pullups(b, env, pm, op, report):
    fw = {p['net'] for p in (b.d.get('firmware') or {}).get('pins', []) if p.get('dir') == 'i2c'}
    lines = sorted(n for n in b.members if (_I2C.search(n) or n in fw) and n not in b.power and n not in b.ground)
    if not lines:
        return K.na('i2c-pullups', 'the board has no I2C bus')
    fails, warns, oks, fixes = [], [], [], []
    for n in lines:
        ups = []
        for r in b.refs_on(n):
            if b.kind(r) != 'R':
                continue
            other = [m for m in b.nets_of(r) if m != n]
            if other and other[0] in b.power and b.resistance(r):
                ups.append((r, b.resistance(r), other[0]))
        if not ups:
            fails.append('%s has no pull-up resistor' % n)
            fixes.append('add a 4.7 kΩ resistor from %s to the 3.3 V supply of the chips on it' % n)
            continue
        rp = 1.0 / sum(1.0 / u[1] for u in ups)
        vpull = max(b.voltage(u[2]) or 0 for u in ups)
        i_sink = vpull / rp
        chips = [r for r in b.refs_on(n) if b.is_chip(r)]
        # chips on the bus powered from a lower supply than the pull-ups would see their pins pulled too high
        low = [r for r in chips if all((b.voltage(m) or 99) < vpull - 0.3 for m in b.nets_of(r) if m in b.power)
               and any(m in b.power for m in b.nets_of(r))]
        say = '%s pulled up by %s (%s to %s)' % (n, _list(u[0] for u in ups), _ohm(rp), ' / '.join(sorted({u[2] for u in ups})))
        if i_sink > 3.0e-3 + 1e-9:
            warns.append(say + ': %.1f mA when pulled low, over the 3 mA an I2C chip must sink' % (i_sink * 1e3))
            fixes.append('raise the pull-up on %s to 2.2-4.7 kΩ' % n)
        elif rp > 10e3:
            warns.append(say + ': weak, the line rises slowly at 400 kHz')
            fixes.append('lower the pull-up on %s to 4.7 kΩ (2.2 kΩ for long wires or many chips)' % n)
        elif low:
            warns.append(say + ', above the supply of %s' % _list(low))
            fixes.append('pull %s up to the lower supply, or add a level shifter' % n)
        else:
            oks.append(say)
    st = _status(fails, warns)
    return K.result('i2c-pullups', st, detail='; '.join(fails + warns) if st != 'pass' else '; '.join(oks),
                    fix='; '.join(fixes) or None)


_ENRST = re.compile(r'(^|[_\-./~!])(N|n)?(EN|ENABLE|CHIP_?EN|CE|RST|RESET|NRST|nRESET|RESETN|RSTN|SHDN|nSHDN|PWR_?EN|'
                    r'[A-Z0-9]+_EN)($|[_\-./])', re.I)


def floating_inputs(b, env, pm, op, report):
    nets = sorted(n for n in b.members if _ENRST.search(n) and n not in b.power and n not in b.ground
                  and any(b.is_chip(r) for r in b.refs_on(n)))
    if not nets:
        return K.na('floating-inputs', 'no enable or reset nets found on the chips')
    warns, oks, fixes = [], [], []
    for n in nets:
        refs = b.refs_on(n)
        pulls = []
        for r in refs:
            if b.kind(r) != 'R':
                continue
            other = [m for m in b.nets_of(r) if m != n]
            if other and (other[0] in b.power or other[0] in b.ground):
                pulls.append('%s to %s' % (r, other[0]))
        chips = [r for r in refs if b.is_chip(r)]
        if pulls:
            oks.append('%s: %s' % (n, _list(pulls)))
        elif len(chips) >= 2:
            warns.append('%s is only driven by a chip pin (%s); while that chip starts up it floats' % (n, _list(chips)))
            fixes.append('add a 100 kΩ resistor from %s to the level it should rest at while starting' % n)
        else:
            warns.append('%s (on %s) has no pull resistor: it floats' % (n, _list(chips)))
            fixes.append('add a 10 kΩ resistor from %s to the supply (to enable) or to ground (to hold off), as the '
                         "chip's datasheet asks" % n)
    st = 'warn' if warns else 'pass'
    return K.result('floating-inputs', st, detail='; '.join(warns) if warns else '; '.join(oks),
                    fix='; '.join(fixes) or None,
                    measured=K.measure('floating enable or reset nets', len(warns), 'count', 0, '<='))


def _assembled_types(b):
    types = {}
    for c in b.d['components']:
        p = b.d['parts'].get(c['part'])
        if p and p.get('assembled', True) is not False and p.get('kind') not in ('TP', 'H'):
            types.setdefault(c['part'], []).append(c['ref'])
    return types


def stock_qty(b, env, pm, op, report, boards=100):
    types = _assembled_types(b)
    if not types:
        return K.na('stock-qty', 'no parts are assembled by the factory')
    short, unknown = [], []
    for k, refs in sorted(types.items()):
        stock = (b.d['parts'][k].get('sourcing') or {}).get('stock')
        need = len(refs) * boards
        if stock is None:
            unknown.append(k)
        elif stock < need:
            short.append('%s (%s): %d in stock, %d needed' % (k, _list(refs, 3), stock, need))
    if len(unknown) == len(types):
        return K.skip('stock-qty', 'stock was not looked up for any part (no catalogue data in the design)')
    if short:
        return K.result('stock-qty', 'warn', detail='not enough for %d boards: %s' % (boards, '; '.join(short)),
                        fix='Pick an alternative with more stock for each part listed, or order fewer boards.',
                        measured=K.measure('parts short for 100 boards', len(short), 'count', 0, '<='))
    detail = 'every part with stock data has enough for %d boards' % boards
    if unknown:
        detail += '; stock unknown for %s' % _list(unknown)
    return K.result('stock-qty', 'warn' if unknown else 'pass', detail=detail,
                    fix='Look up the parts with unknown stock.' if unknown else None)


def extended_parts(b, env, pm, op, report, warn_over=5):
    types = _assembled_types(b)
    if not types:
        return K.na('extended-parts', 'no parts are assembled by the factory')
    ext = sorted(k for k in types if (b.d['parts'][k].get('sourcing') or {}).get('tier') == 'extended')
    unknown = sorted(k for k in types if not (b.d['parts'][k].get('sourcing') or {}).get('tier'))
    fee = EXTENDED_FEE * len(ext)
    detail = ('%d of %d part types are "extended" (%s): about $%.0f loading fee per order' % (len(ext), len(types), _list(ext), fee)
              if ext else 'every assembled part is a basic or preferred part: no loading fee')
    if unknown:
        detail += '; library tier unknown for %s' % _list(unknown)
    st = 'warn' if len(ext) > warn_over else 'pass'
    return K.result('extended-parts', st, detail=detail,
                    measured=K.measure('extended part types', len(ext), 'count', warn_over, '<='),
                    fix='Swap extended parts for basic ones where one exists (resistors, capacitors, LEDs and common '
                        'regulators usually do).' if st != 'pass' else None)


def datasheets(b, env, pm, op, report):
    # plain resistors and capacitors are fully described by their value, size and rating
    need = sorted(k for k, p in b.d['parts'].items() if p.get('kind') not in ('R', 'C', 'TP', 'H')
                  and any(c['part'] == k for c in b.d['components']))
    if not need:
        return K.na('datasheets', 'the board only has resistors and capacitors')
    missing = [k for k in need if not b.d['parts'][k].get('datasheet')]
    if missing:
        return K.result('datasheets', 'warn', detail='no datasheet link for %s' % _list(missing),
                        measured=K.measure('parts without a datasheet', len(missing), 'count', 0, '<='),
                        fix='Add each part\'s datasheet link (the LCSC or maker page has it).')
    return K.result('datasheets', 'pass', detail='all %d parts other than resistors and capacitors link a datasheet' % len(need))


# the ratings each kind of part is tested on
_USED = {'R': ('power_max', 'temp_min', 'temp_max'), 'C': ('voltage_max', 'temp_min', 'temp_max'),
         'LED': ('current_max', 'temp_min', 'temp_max'), 'J': ('current_max', 'temp_min', 'temp_max'),
         'U': ('voltage_max', 'temp_min', 'temp_max'), 'MOD': ('voltage_max', 'temp_min', 'temp_max')}


def ratings_known(b, env, pm, op, report):
    rows = []
    for k, p in sorted(b.d['parts'].items()):
        refs = [c['ref'] for c in b.d['components'] if c['part'] == k]
        if not refs:
            continue
        rt = b.rating(refs[0])
        used = _USED.get(p.get('kind'), ('temp_min', 'temp_max'))
        if p.get('kind') in ('U', 'MOD') and RT.regulator(p):
            used = ('current_max', 'voltage_max', 'temp_min', 'temp_max') + (('dropout',) if RT.regulator(p)['kind'] == 'ldo' else ('efficiency',))
        guessed = [f for f in used if f in rt['assumed']]
        if guessed:
            rows.append('%s (%s): %s' % (k, _list(refs, 3), ', '.join(_FIELD_WORDS.get(f, f) for f in guessed)))
    if not rows:
        return K.result('ratings-known', 'pass', detail="every rating the tests use comes from the design or the part's datasheet")
    return K.result('ratings-known', 'warn', detail='typical values used for %s' % '; '.join(rows[:12]),
                    measured=K.measure('parts with assumed ratings', len(rows), 'count', 0, '<='),
                    fix="Add each listed rating to the part from its datasheet (part.ratings), so the tests use the real number.")


_FIELD_WORDS = dict(temp_min='lowest temperature', temp_max='highest temperature', voltage_max='voltage rating',
                    current_max='current rating', power_max='power rating', dropout='dropout', efficiency='efficiency',
                    theta_jb='heat path to the board')


def polarity_marks(b, env, pm, op, report):
    pol = [r for r in b.comps if b.kind(r) in ('LED', 'D', 'U', 'MOD', 'Q')
           or (b.kind(r) == 'C' and RT.cap_type(b.parts[r]) != 'ceramic')]
    if not pol:
        return K.na('polarity-marks', 'no part on the board has to go one way round')
    brd = b.d.get('board')
    if not brd:
        return K.skip('polarity-marks', 'the design has no board yet')
    if (brd.get('silkscreen') or {}).get('outlines'):
        return K.result('polarity-marks', 'pass', detail='part outlines with pin-1 and polarity marks are printed for %d '
                        'polarised parts (%s); the silkscreen check lists any that did not fit' % (len(pol), _list(pol, 6)))
    return K.result('polarity-marks', 'warn',
                    detail='%d parts only fit one way (%s) but no part outlines are printed, so nobody can check by eye '
                           'which way round they went' % (len(pol), _list(pol, 6)),
                    fix='Turn on printed part outlines (board.silkscreen.outlines = true): each gets its pin-1 or '
                        'polarity mark.')


def two_sided(b, env, pm, op, report):
    refs = [c['ref'] for c in b.d['components'] if _assembled(b, c['ref']) and b.kind(c['ref']) not in ('TP', 'H')]
    if not refs:
        return K.na('two-sided', 'no parts are assembled by the factory')
    bottom = [r for r in refs if (b.d.get('placement', {}).get(r) or {}).get('side') == 'bottom']
    if bottom:
        return K.result('two-sided', 'warn', detail='%d assembled parts on the bottom (%s)' % (len(bottom), _list(bottom)),
                        measured=K.measure('assembled parts on the bottom', len(bottom), 'count', 0, '<='),
                        fix='Move %s to the top if they fit: one-sided assembly is cheaper and quicker.' % _list(bottom),
                        where=_where(b, bottom))
    return K.result('two-sided', 'pass', detail='all %d assembled parts are on the top' % len(refs))


def board_size(b, env, pm, op, report):
    brd = b.d.get('board')
    if not brd:
        return K.skip('board-size', 'the design has no board yet')
    w, h, n = float(brd['width']), float(brd['height']), int(brd.get('layers', 2))
    thick = float(brd.get('thickness', 1.6))
    lo, hi = min(w, h), max(w, h)
    fmin = FAB_MIN if thick >= 0.8 else FAB_MIN_THIN
    fmax = FAB_MAX.get(n, FAB_MAX_MANY)
    amax = ASM_MAX.get(n, ASM_MAX_MANY)
    assembled = bool(_assembled_types(b))
    size = '%g x %g mm' % (w, h)
    if lo < fmin or hi > max(fmax) or lo > min(fmax):
        return K.result('board-size', 'fail', detail='%s is outside what JLCPCB makes (%g mm to %g x %g mm)' % (size, fmin, *fmax),
                        measured=K.measure('board size (long side)', hi, 'mm', max(fmax), '<='),
                        fix='Resize the board to fit JLCPCB\'s range.')
    if assembled and lo < ASM_MIN:
        return K.result('board-size', 'fail', detail='%s is smaller than the 10 x 10 mm JLCPCB can assemble' % size,
                        measured=K.measure('board size (short side)', lo, 'mm', ASM_MIN, '>='),
                        fix='Make the board at least 10 x 10 mm, or have it assembled as a panel of several boards.')
    if assembled and (hi > max(amax) or lo > min(amax)):
        return K.result('board-size', 'warn', detail='%s is larger than JLCPCB\'s assembly table lists for %d layers (%g x %g mm)'
                        % (size, n, *amax), measured=K.measure('board size (long side)', hi, 'mm', max(amax), '<='),
                        fix='Check the size in JLCPCB\'s assembly quote, or make the board smaller.')
    note = '' if lo >= 70 else '; boards under 70 mm get edge rails added for the assembly line (a little extra cost)' \
        if assembled else ''
    return K.result('board-size', 'pass', detail='%s, within what JLCPCB makes%s%s' % (
        size, ' and assembles' if assembled else '', note),
        measured=K.measure('board size (long side)', hi, 'mm', max(amax) if assembled else max(fmax), '<='))


def stackup(b, env, pm, op, report):
    brd = b.d.get('board')
    if not brd:
        return K.skip('stackup', 'the design has no board yet')
    n, t = int(brd.get('layers', 2)), float(brd.get('thickness', 1.6))
    oz = brd.get('copper_oz') or {}
    outer, inner = float(oz.get('outer', 1)), float(oz.get('inner', 0.5))
    warns, fixes = [], []
    if n > 6:
        warns.append('%d copper layers: JLCPCB makes them, but they cost several times a 4-layer board' % n)
        fixes.append('see whether the board routes on 4 or 6 layers')
    if not any(abs(t - s) < 1e-6 for s in STD_THICKNESS):
        warns.append('%g mm is not one of JLCPCB\'s standard thicknesses (%s mm)' % (t, ', '.join('%g' % s for s in STD_THICKNESS)))
        fixes.append('use 1.6 mm unless the enclosure needs another standard thickness')
    elif abs(t - 1.6) > 1e-6:
        warns.append('%g mm is a standard option but not the default 1.6 mm: it can cost a little more' % t)
        fixes.append('use 1.6 mm unless something needs %g mm' % t)
    if outer not in (1, 2):
        warns.append('%g oz outer copper is not standard (1 or 2 oz)' % outer)
        fixes.append('use 1 oz outer copper')
    elif outer == 2:
        warns.append('2 oz outer copper costs extra and needs wider gaps (0.15 mm)')
        fixes.append('use 1 oz unless the current needs 2 oz')
    if n >= 4 and inner not in (0.5, 1):
        warns.append('%g oz inner copper is not standard (0.5 or 1 oz)' % inner)
        fixes.append('use 0.5 oz inner copper')
    desc = '%d layers, %g mm, %g oz outer%s' % (n, t, outer, (', %g oz inner' % inner) if n >= 4 else '')
    if warns:
        return K.result('stackup', 'warn', detail=desc + ': ' + '; '.join(warns), fix='; '.join(fixes))
    return K.result('stackup', 'pass', detail=desc + ': a standard JLCPCB build')
