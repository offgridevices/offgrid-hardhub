# SPDX-License-Identifier: AGPL-3.0-or-later
"""The board's power tree, from the design alone.

Which part supplies each power net (a regulator, a connector or battery, or
a fuse/ferrite/diode passing another net through), which parts draw from it
and how much, and how much heat each power part makes.  Every later power
check (budget, headroom, voltage drop, heat, PDN) starts from this.

    pm = power_model(d, env)
    pm['nets']['+3V3'] = {voltage, v_max, stated_current, load, source, source_kind, source_pads,
                          from_net, sinks: [{ref, pads, current, kind}], capacity, ...}
    pm['regulators'] = [{ref, kind, in_net, out_net, vin, vout, iout, iin, dropout, efficiency,
                         current_max, vin_max, ...}]
    pm['dissipation'] = {ref: {power, how, assumed}}

Current shares: a net's stated `current` is the total it carries.  What the
regulators and pass-through parts fed from it draw is worked out from their
own outputs; the rest is shared among the chips on the net, a module or
microcontroller counting 5 to every other chip's 1, and a sensor, memory or
logic chip 0.2 (a radio module draws hundreds of mA, a sensor a few).  These
shares are estimates; `component.power` (heat stated from the datasheet)
always wins.
"""
import re

from .. import design as D
from . import ratings as RT

ENV_DEFAULTS = dict(ambient_min=0.0, ambient_max=50.0, enclosed=False, place=None)

# parts that only pass a supply through (fuse, ferrite, inductor, diode, low-value resistor, load switch)
LINK_KINDS = ('F', 'FB', 'L', 'D', 'R', 'Q')
LINK_R_MAX = 1.0          # ohms: a resistor at or below this between two supplies is a link (0 Ω, current sense)

_MCU = re.compile(r'ESP32|ESP8266|STM32|RP2040|RP2350|nRF5|ATSAM|ATMEGA|PIC\d|GD32|CH32|EFR32|CC26', re.I)
_BATTERY = re.compile(r'batter|\bcell\b|CR\d{4}|18650|LiPo|Li-?ion', re.I)


def environment(d, env=None):
    """design.environment with its defaults, overridden by `env` (the run's options)."""
    out = dict(ENV_DEFAULTS)
    out.update({k: v for k, v in ((d or {}).get('environment') or {}).items() if v is not None})
    out.update({k: v for k, v in (env or {}).items() if v is not None})
    out['ambient_min'] = float(out['ambient_min'])
    out['ambient_max'] = float(out['ambient_max'])
    return out


class Board:
    """The design indexed for the checks: parts per component, nets with their pins."""

    def __init__(self, d):
        self.d = d = D.normalize(d)
        self.comps = {c['ref']: c for c in d['components']}
        self.parts = {c['ref']: d['parts'].get(c['part']) or {} for c in d['components']}
        self.members = D.nets(d)                          # net -> [(ref, pad)]
        self.nets = d['nets']
        self.ground = {n for n, x in self.nets.items() if x.get('kind') == 'ground'}
        if not self.ground and 'GND' in self.members:
            self.ground = {'GND'}
        self.power = {n for n, x in self.nets.items() if x.get('kind') == 'power' and n in self.members}
        self._rat = {}

    def kind(self, ref):
        return self.parts[ref].get('kind')

    def rating(self, ref):
        if ref not in self._rat:
            self._rat[ref] = RT.ratings(self.parts[ref], self.comps[ref])
        return self._rat[ref]

    def nets_of(self, ref):
        """{net: [pads]} of one component (open pins left out)."""
        out = {}
        for pad, net in self.comps[ref]['pins'].items():
            if net:
                out.setdefault(net, []).append(pad)
        return out

    def refs_on(self, net):
        seen = []
        for r, _ in self.members.get(net, []):
            if r not in seen:
                seen.append(r)
        return seen

    def voltage(self, net):
        """A net's nominal voltage: ground 0, a power net its stated voltage, else None."""
        if net in self.ground:
            return 0.0
        v = self.nets.get(net, {}).get('voltage')
        return float(v) if v is not None else None

    def is_chip(self, ref):
        return self.kind(ref) in ('U', 'MOD')

    def is_mcu(self, ref):
        p = self.parts[ref]
        return self.kind(ref) == 'MOD' or bool(_MCU.search(p.get('mpn', '') + ' ' + p.get('description', '')))

    def two_pin(self, ref):
        """(net a, net b) of a two-pad part, or None."""
        pins = [n for n in self.comps[ref]['pins'].values()]
        if len(pins) != 2 or not all(pins):
            return None
        return pins[0], pins[1]

    def resistance(self, ref):
        p = self.parts[ref]
        r = RT.parse_resistance(p.get('value'))
        if r is None:
            r = RT.parse_resistance(p.get('description'))
        return r

    def is_connector_source(self, ref):
        p = self.parts[ref]
        return self.kind(ref) == 'J' or bool(_BATTERY.search(p.get('description', '') + ' ' + p.get('mpn', '')))

    def is_usb(self, ref):
        p = self.parts[ref]
        return self.kind(ref) == 'J' and bool(re.search(r'USB', RT.text(p) + p.get('footprint', ''), re.I))

    def is_usb_c(self, ref):
        p = self.parts[ref]
        return self.kind(ref) == 'J' and bool(re.search(r'USB[-_ ]?C|TYPE-?C', RT.text(p) + ' ' + p.get('footprint', ''), re.I))


def _regulator_nets(b, ref, reg):
    """(in_net, out_net) of a regulator: the power nets on its own pins (LDO and buck: the higher one is
    the input; boost: the lower one), and for a switcher whose output sits beyond its inductor, the
    power net one inductor or diode away from one of its pins."""
    direct = [n for n in b.nets_of(ref) if n in b.power]
    # a net that names this part as its source is its output whatever its voltage says
    named_out = [n for n in b.power if b.nets[n].get('source') == ref]
    beyond = []
    for n in b.nets_of(ref):
        if n in b.power or n in b.ground:
            continue
        for r in b.refs_on(n):
            if r != ref and b.kind(r) in ('L', 'D'):
                for m in b.nets_of(r):
                    if m in b.power and m not in direct and m not in beyond:
                        beyond.append(m)
    cands = direct + beyond
    with_v = [n for n in cands if b.voltage(n) is not None]
    out_net = named_out[0] if named_out else None
    in_net = None
    pins = b.comps[ref]['pins']
    if reg.get('pin_out') and pins.get(reg['pin_out']) in b.power and pins.get(reg['pin_in']) in b.power:
        # the family's datasheet pinout settles it, whatever the voltages say
        return pins[reg['pin_in']], named_out[0] if named_out else pins[reg['pin_out']]
    if reg.get('vout') is not None and not out_net:
        match = [n for n in with_v if abs(b.voltage(n) - reg['vout']) < 0.05]
        # two nets at the output voltage: the output is the one without a connector bringing power in
        match.sort(key=lambda n: any(b.is_connector_source(r) for r in b.refs_on(n)))
        if match:
            out_net = match[0]
    rest = [n for n in with_v if n != out_net]
    if out_net is None and len(with_v) >= 2:
        hi = max(with_v, key=b.voltage)
        lo = min(with_v, key=b.voltage)
        in_net, out_net = (lo, hi) if reg['kind'] == 'boost' else (hi, lo)
    elif rest:
        pick = min if reg['kind'] == 'boost' else max
        in_net = pick([n for n in rest if n in direct] or rest, key=b.voltage)
    if out_net is None and beyond:
        out_net = beyond[0]
    if in_net is None:
        others = [n for n in direct if n != out_net]
        in_net = others[0] if others else None
    return in_net, out_net


# chips that draw little (sensors, memories, logic): a fifth of an ordinary chip's share, so a 0.5 A
# budget for a radio module and a humidity sensor does not credit the sensor with 80 mA
_LIGHT = re.compile(r'sensor|EEPROM|\bflash\b|FRAM|logic|buffer|level.?shift|\bRTC\b|real.?time clock|'
                    r'multiplexer|\bmux\b|ESD|TVS', re.I)


def _weight(b, ref):
    p = b.parts[ref]
    if b.is_mcu(ref):
        return 5.0
    if _LIGHT.search(p.get('description', '')):
        return 0.2
    return 1.0


def power_model(d, env=None):
    b = d if isinstance(d, Board) else Board(d)
    env = environment(b.d, env)
    regs = {}
    for ref in b.comps:
        info = RT.regulator(b.parts[ref])
        if info and b.parts[ref].get('assembled', True) is not False:
            regs[ref] = info
    reg_nets = {ref: _regulator_nets(b, ref, info) for ref, info in regs.items()}

    # ---- links: a two-sided part between two power nets passes one through to the other
    links = []                          # (ref, upstream, downstream)
    for ref in b.comps:
        if ref in regs or b.kind(ref) not in LINK_KINDS:
            continue
        on = [n for n in b.nets_of(ref) if n in b.power]
        if len(on) != 2:
            continue
        if b.kind(ref) == 'R' and (b.resistance(ref) or 0) > LINK_R_MAX:
            continue
        a, c = on
        if b.kind(ref) == 'D':
            # current flows anode -> cathode; KiCad diode footprints: pad 1 = cathode, 2 = anode (or A/K)
            pins = b.comps[ref]['pins']
            anode = pins.get('A') or pins.get('2')
            a, c = (anode, c if anode == a else a)
        links.append((ref, a, c))

    # ---- the source of every power net
    nets = {}
    for n in sorted(b.power):
        x = b.nets[n]
        e = dict(voltage=b.voltage(n), stated_current=x.get('current'), source=None, source_kind=None,
                 source_pads=[], from_net=None, sinks=[], load=None, capacity=None, note=None)
        named = x.get('source')
        if named and named in b.comps:
            e['source'] = named
        else:
            for ref, (i, o) in reg_nets.items():
                if o == n:
                    e['source'] = ref
                    break
        if not e['source']:
            for ref, up, down in links:
                if down == n:
                    e['source'] = ref
                    e['from_net'] = up
                    break
        if not e['source']:
            ext = [r for r in b.refs_on(n) if b.is_connector_source(r)]
            # prefer a soldered-on connector or battery over a hand-fitted header
            ext.sort(key=lambda r: (b.parts[r].get('assembled', True) is False, not b.is_usb(r)))
            if ext:
                e['source'] = ext[0]
        src = e['source']
        if src:
            if src in regs:
                e['source_kind'] = 'regulator'
                e['from_net'] = reg_nets[src][0]
            elif any(r == src for r, _, _ in links):
                e['source_kind'] = 'link'
                e['from_net'] = e['from_net'] or next(u for r, u, dn in links if r == src)
            elif b.is_connector_source(src):
                e['source_kind'] = 'usb' if b.is_usb(src) else 'external'
            else:
                e['source_kind'] = 'other'
            e['source_pads'] = b.nets_of(src).get(n, [])
        nets[n] = e

    def vmax(n, seen=()):
        """The highest the net's voltage goes: outside supplies ±5 % (USB 2.0: 4.75-5.25 V), regulator
        outputs ±2 % (typical output accuracy over temperature), pass-throughs follow their source."""
        e = nets[n]
        if e['voltage'] is None:
            return None
        if e['source_kind'] == 'regulator':
            return e['voltage'] * 1.02
        if e['source_kind'] == 'link' and e['from_net'] in nets and n not in seen:
            up = vmax(e['from_net'], seen + (n,))
            return max(e['voltage'], up) if up is not None else e['voltage']
        return e['voltage'] * 1.05

    def vmin(n):
        e = nets[n]
        if e['voltage'] is None:
            return None
        return e['voltage'] * (0.98 if e['source_kind'] == 'regulator' else 0.95)

    for n, e in nets.items():
        e['v_max'] = vmax(n)
        e['v_min'] = vmin(n)

    # ---- loads, from the leaves up
    reg_out = {}
    memo = {}

    def load(n, stack=()):
        if n in memo:
            return memo[n]
        if n in stack:                    # a loop in the tree: stop rather than recurse forever
            return 0.0
        e = nets[n]
        sinks, downstream = [], 0.0
        src = e['source']
        for ref, (i, o) in reg_nets.items():
            if i == n and ref != src and o in nets:
                iout = load(o, stack + (n,))
                info = regs[ref]
                vin, vout = b.voltage(n), b.voltage(o)
                if info['kind'] == 'ldo' or not (vin and vout and info.get('efficiency')):
                    iin = iout                                   # a linear regulator passes its load current
                else:
                    iin = vout * iout / (info['efficiency'] * vin)
                reg_out[ref] = (iout, iin)
                sinks.append(dict(ref=ref, pads=b.nets_of(ref).get(n, []), current=iin, kind='regulator'))
                downstream += iin
        for ref, up, down in links:
            if up == n and ref != src and down in nets:
                i = load(down, stack + (n,))
                sinks.append(dict(ref=ref, pads=b.nets_of(ref).get(n, []), current=i, kind='link', to=down))
                downstream += i
        chips = [r for r in b.refs_on(n) if r != src and r not in regs and b.is_chip(r)
                 and not any(r == lr for lr, _, _ in links)]
        stated = e['stated_current']
        rest = None if stated is None else max(0.0, float(stated) - downstream)
        weights = {r: _weight(b, r) for r in chips}
        total_w = sum(weights.values())
        for r in chips:
            share = rest * weights[r] / total_w if rest is not None and total_w else None
            sinks.append(dict(ref=r, pads=b.nets_of(r).get(n, []), current=share, kind='chip'))
        # LEDs and transistors drawing straight from the net: their current comes from the circuit
        # simulation (spice.py fills it in), not from the stated current
        for r in b.refs_on(n):
            if r != src and b.kind(r) in ('LED', 'Q') and not any(s['ref'] == r for s in sinks) \
                    and not any(r == lr for lr, _, _ in links):
                sinks.append(dict(ref=r, pads=b.nets_of(r).get(n, []), current=None, kind=b.kind(r).lower()))
        e['sinks'] = sinks
        e['chip_current'] = rest if chips else 0.0
        e['downstream'] = downstream
        tot = downstream + ((rest or 0.0) if chips else 0.0)
        if stated is not None and not chips and not downstream:
            tot = float(stated)            # nothing we can name draws from it: trust the stated figure
        e['load'] = tot
        if stated is not None and downstream > float(stated) + 1e-9:
            e['note'] = ('the net is said to carry %.0f mA, but what it feeds draws %.0f mA'
                         % (float(stated) * 1e3, downstream * 1e3))
        memo[n] = tot
        return tot

    for n in nets:
        load(n)

    # ---- regulators
    regulators = []
    for ref, info in regs.items():
        i, o = reg_nets[ref]
        iout = nets[o]['load'] if o in nets else None
        iin = reg_out.get(ref, (iout, iout))[1] if iout is not None else None
        regulators.append(dict(
            ref=ref, kind=info['kind'], in_net=i, out_net=o, vin=b.voltage(i) if i else None,
            vout=b.voltage(o) if o else info.get('vout'), iout=iout, iin=iin,
            dropout=b.rating(ref).get('dropout') if info['kind'] == 'ldo' else None,
            efficiency=b.rating(ref).get('efficiency') if info['kind'] != 'ldo' else None,
            current_max=b.rating(ref).get('current_max'), vin_max=b.rating(ref).get('voltage_max'),
            vin_min=info.get('vin_min'), cin=info.get('cin'), cout=info.get('cout'),
            family=info.get('family'), source=info.get('source'),
            assumed=sorted(set(info['assumed']) & {'current_max', 'dropout', 'voltage_max', 'efficiency'})))

    # ---- what each supply can deliver
    for n, e in nets.items():
        src = e['source']
        if not src:
            continue
        if e['source_kind'] == 'regulator':
            e['capacity'] = b.rating(src).get('current_max')
            e['capacity_assumed'] = 'current_max' in b.rating(src)['assumed']
            e['capacity_why'] = 'regulator rating'
        elif e['source_kind'] in ('usb', 'external'):
            per = b.rating(src).get('current_max')
            pins = len(e['source_pads']) or 1
            e['capacity'] = per * pins if per else None
            e['capacity_assumed'] = 'current_max' in b.rating(src)['assumed']
            e['capacity_why'] = '%s × %d contacts' % (b.rating(src).get('_current_why') or 'connector rating', pins)
            if e['source_kind'] == 'usb':
                # a USB port only promises 500 mA (USB 2.0) unless the far end offers more on CC
                # (USB Type-C 1.5 A / 3 A) or by Power Delivery
                e['usb_default'] = 0.5
        elif e['source_kind'] == 'link':
            r = b.rating(src)
            e['capacity'] = r.get('current_max')
            e['capacity_assumed'] = 'current_max' in r['assumed']
            e['capacity_why'] = 'pass-through part rating'

    # ---- heat: from the average current where the design gives one (a radio
    # transmits in bursts; tracks are sized for the peak, heat comes from the average)
    def avg(n):
        x = d['nets'].get(n) or {}
        if x.get('average') is not None and x.get('current'):
            return min(1.0, float(x['average']) / float(x['current']))
        return 1.0
    diss = {}
    for g in regulators:
        if g['iout'] is None or g['vin'] is None or g['vout'] is None:
            continue
        if g['kind'] == 'ldo':
            iout = g['iout'] * avg(g['out_net'])
            p = max(0.0, (g['vin'] - g['vout']) * iout)
            how = '(%.2f V in − %.2f V out) × %.0f mA%s' % (g['vin'], g['vout'], iout * 1e3,
                                                         ' average' if avg(g['out_net']) < 1 else '')
            assumed = nets[g['out_net']]['stated_current'] is None
        else:
            eff = g['efficiency'] or 0.85
            pout = g['vout'] * g['iout'] * avg(g['out_net'])
            p = pout * (1 / eff - 1)
            how = '%.2f W out × (1 / %.0f %% − 1)' % (pout, eff * 100)
            assumed = 'efficiency' in g['assumed']
        diss[g['ref']] = dict(power=p, how=how, assumed=bool(assumed))
    for n, e in nets.items():
        for s in e['sinks']:
            if s['kind'] != 'chip' or s['current'] is None or e['voltage'] is None:
                continue
            x = diss.setdefault(s['ref'], dict(power=0.0, how='', assumed=True))
            i = s['current'] * avg(n)
            x['power'] += e['voltage'] * i
            x['how'] = (x['how'] + ' + ' if x['how'] else '') + '%.2f V × %.0f mA (its share of %s%s)' % (
                e['voltage'], i * 1e3, n, "'s average" if avg(n) < 1 else '')
    for ref, c in b.comps.items():
        if c.get('power') is not None:
            diss[ref] = dict(power=float(c['power']), how='stated in the design', assumed=False)
    return dict(nets=nets, regulators=regulators, dissipation=diss, env=env, links=links,
                ground=sorted(b.ground))
