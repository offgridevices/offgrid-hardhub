# SPDX-License-Identifier: AGPL-3.0-or-later
"""Circuit simulations in ngspice: operating point, supply impedance, load step.

    results, report, op = run(d, env, pm, work)

Three kinds of run, each a plain netlist written into `work` (so a test or a
person can read exactly what was simulated) and run with `ngspice -b`:

1. Operating point of the whole circuit (DC), in three scenarios (chip pins
   idle, every chip signal pin driven low through 25 Ω, every one driven high
   to its chip's supply through 25 Ω) at the coldest, 25 °C and the hottest
   temperature.  Resistors at their value with 100 ppm/°C (thick film),
   capacitors open, inductors / ferrites / fuses 0.05 Ω, LEDs and diodes as
   diode models, power nets as ideal sources, every node 1 GΩ to ground so
   nothing floats, chips high-impedance.  The worst case of each part over
   all nine runs is `op` = {ref: {current, power, voltage, ...}}.
   -> stress-resistor-power, stress-led-current; and op feeds the capacitor
   voltage check and the heat map (pm['dissipation'] gets resistors and LEDs).
2. Resistor dividers feeding a chip pin at their tolerance and temperature
   corners -> stress-tolerance.
3. Each supply rail that feeds a chip: its source (regulator or cable) as a
   resistance and inductance, its capacitors with their real value (DC bias
   and temperature), resistance (ESR) and inductance (ESL by size, plus
   mounting); AC impedance 1 kHz-100 MHz -> pdn; a load step from 10 % to
   100 % of the rail's current in 1 µs -> load-step.

If ngspice is not installed, every check here is a "skip" that says so.
"""
import math
import os
import re
import shutil
import subprocess

from . import catalog as K
from . import ratings as RT
from .power import Board, environment

IDS = ['stress-resistor-power', 'stress-led-current', 'stress-tolerance', 'pdn', 'load-step']

TIMEOUT = 60                 # seconds per ngspice run
R_DRIVE = 25.0               # Ω: a chip output pin's on-resistance, driven low or high (CMOS GPIO, typical)
R_LINK = 0.05                # Ω: inductor, ferrite bead, fuse at DC
R_LEAK = 1e9                 # Ω: every node to ground, so a node held only by capacitors still solves
TC_THICK = 100e-6            # /°C: thick-film chip resistor tempco (±100 ppm/°C, Yageo RC / UNI-ROYAL)
DIVIDER_SPREAD = 3.0         # %: a divider worse than ±3 % warns

# supply source models for the PDN and load step (deliberately simple; see the module docstring):
# an LDO's output impedance is low up to its loop bandwidth (~100 kHz) then rises like an inductor:
# R_out 0.05 Ω + 0.5 µH; a switcher's loop is slower: 0.02 Ω + 1 µH; power from a cable
# (USB, DC jack): about 1 m of cable and its contacts, 0.1 Ω + 1 µH round trip
SOURCE_MODEL = {'ldo': (0.05, 0.5e-6), 'buck': (0.02, 1e-6), 'boost': (0.02, 1e-6), 'usb': (0.1, 1e-6),
                'external': (0.1, 1e-6), 'other': (0.1, 1e-6)}
# capacitor parasitics: ESL of the part by case size (makers' typical: 0402 ~0.4 nH ... 1206 ~1 nH)
# plus 0.5 nH for its pads and vias
ESL = {'01005': 0.25e-9, '0201': 0.3e-9, '0402': 0.4e-9, '0603': 0.6e-9, '0805': 0.8e-9, '1206': 1.0e-9,
       '1210': 1.2e-9, '1812': 1.5e-9}
ESL_OTHER = 2.0e-9           # tantalum / electrolytic cases
L_MOUNT = 0.5e-9
PDN_PASS_TO = 10e6           # Hz: above this the chip's own package capacitors take over
STEP_LIMIT = 5.0             # %: a load step may pull the rail down this far
TARGET_RIPPLE = 0.05         # target impedance: 5 % of the rail voltage ...
TARGET_STEP = 0.5            # ... for a current change of half the rail's current


class SpiceError(RuntimeError):
    pass


# ------------------------------------------------------------------ running ngspice

def available():
    return shutil.which('ngspice') is not None


def version():
    """'ngspice-42' (the first line naming the version), or None."""
    if not available():
        return None
    try:
        p = subprocess.run(['ngspice', '-v'], capture_output=True, text=True, timeout=20)
    except (OSError, subprocess.SubprocessError):
        return None
    m = re.search(r'ngspice-(\S+)', p.stdout + p.stderr)
    return 'ngspice-%s' % m.group(1) if m else None


def ngspice(path, timeout=TIMEOUT):
    """Run one netlist in batch mode in its own folder; the output text.  Raises SpiceError."""
    try:
        p = subprocess.run(['ngspice', '-b', os.path.basename(path)], cwd=os.path.dirname(path) or '.',
                           capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        raise SpiceError('ngspice took longer than %d s on %s' % (timeout, os.path.basename(path)))
    except OSError as e:
        raise SpiceError('ngspice could not start: %s' % e)
    out = p.stdout + '\n' + p.stderr
    with open(path + '.log', 'w') as f:
        f.write(out)
    bad = [l.strip() for l in out.splitlines()
           if re.search(r'^\s*(Error|error):|singular matrix|Timestep too small|simulation\(s\) aborted|'
                        r'no such vector|Unknown model|unknown parameter', l)]
    if p.returncode != 0 or bad:
        raise SpiceError('ngspice failed on %s: %s' % (os.path.basename(path), '; '.join(bad[:3]) or 'exit %d' % p.returncode))
    return out


def _values(text):
    """'name = value' lines after each '@@ <label>' marker: {label: {name: value}}."""
    out, cur = {}, None
    for line in text.splitlines():
        m = re.match(r'^@@\s*(.+?)\s*$', line)
        if m:
            cur = out.setdefault(m.group(1), {})
            continue
        m = re.match(r'^\s*(\S+)\s*=\s*([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)\s*$', line)
        if m and cur is not None:
            cur[m.group(1).lower()] = float(m.group(2))
    return out


def _table(path):
    """A wrdata file (wr_singlescale, wr_vecnames): [[x, y...], ...]."""
    rows = []
    with open(path) as f:
        for line in f:
            parts = line.split()
            try:
                rows.append([float(x) for x in parts])
            except ValueError:
                continue                    # the header line
    if not rows:
        raise SpiceError('ngspice wrote no data to %s' % os.path.basename(path))
    return rows


def _num(x):
    return '%.6g' % x


# ------------------------------------------------------------------ device models

def _thermal_v(t_c=25.0):
    return 1.380649e-23 * (t_c + 273.15) / 1.602176634e-19


def led_model(name, vf, i_ref=5e-3, n=2.0, rs=2.0):
    """A diode model with forward voltage vf at i_ref (25 °C).  N = 2 (typical for LEDs), RS = 2 Ω
    (dynamic resistance of a small SMD LED); EG = vf + 0.6 gives about -1.5 mV/°C, as LEDs do."""
    vj = vf - i_ref * rs
    is_ = i_ref / (math.exp(vj / (n * _thermal_v())) - 1)
    return '.model %s D(IS=%.4g N=%g RS=%g EG=%.3g XTI=3 BV=5 IBV=10u)' % (name, is_, n, rs, vf + 0.6)


DIODE_MODELS = {
    # small-signal silicon (1N4148 class, generic parameters from its widely used SPICE model)
    'si': '.model DSI D(IS=2.52n N=1.752 RS=0.568 BV=75 IBV=1u CJO=4p)',
    # Schottky (about 0.35-0.45 V at 0.1-1 A, SS14 / B5819 class)
    'schottky': '.model DSCH D(IS=10u N=1.1 RS=0.05 BV=40 IBV=1m EG=0.69 XTI=2)',
}


def _diode_kind(part):
    s = RT.text(part)
    if re.search(r'schottky|SS1\d|B5819|BAT\d|SB\d{3}|MBR', s, re.I):
        return 'schottky'
    if re.search(r'TVS|transient|zener|SMAJ|SMBJ|SMF\d|PESD|ESD', s, re.I):
        return 'clamp'
    return 'si'


def _clamp_bv(part):
    """Breakdown of a zener (its voltage) or TVS (stand-off × 1.11, the SMAJ-series breakdown minimum)."""
    s = RT.text(part)
    m = re.search(r'(?:SMAJ|SMBJ|SMF|SMCJ|P6KE)(\d+(?:\.\d+)?)', s, re.I)
    if m:
        return float(m.group(1)) * 1.11
    v = RT.parse_voltage(part.get('value')) or RT.parse_voltage(part.get('description'))
    return v or 5.6


def _anode_cathode(comp):
    pins = comp['pins']
    if 'A' in pins and 'K' in pins:
        return pins['A'], pins['K']
    if len(pins) == 2 and '1' in pins and '2' in pins:
        return pins['2'], pins['1']               # KiCad LED_SMD / Diode_SMD: pad 1 = cathode
    return None, None


# ------------------------------------------------------------------ 1. operating point

class Netlist:
    def __init__(self, title):
        self.lines = ['* ' + title, '.options tnom=25']
        self.nodes = {}
        self.models = {}

    def node(self, b, net):
        if net is None:
            return None
        if net in b.ground:
            return '0'
        if net not in self.nodes:
            self.nodes[net] = 'n%d' % (len(self.nodes) + 1)
        return self.nodes[net]

    def add(self, line):
        self.lines.append(line)

    def model(self, name, text):
        self.models.setdefault(name, text)


def _resistor_value(b, ref):
    r = b.resistance(ref)
    if r is None:
        return None
    return max(r, 1e-3)                            # 0 Ω links: 1 mΩ, so the matrix stays solvable


def build_op(b, pm, scenario):
    """The whole circuit for one scenario: 'idle', 'low' or 'high'.  Returns (Netlist, elements)
    where elements maps ref -> (kind, a node, b node, value) for reading the results back."""
    nl = Netlist('operating point, chips %s' % scenario)
    el, skipped = {}, []
    regs = {g['ref'] for g in pm['regulators']}
    for ref, c in sorted(b.comps.items()):
        k = b.kind(ref)
        p = b.parts[ref]
        if k == 'R':
            pins = b.two_pin(ref)
            val = _resistor_value(b, ref)
            if not pins or val is None:
                skipped.append(ref)
                continue
            a, z = nl.node(b, pins[0]), nl.node(b, pins[1])
            if a == z:
                continue
            nl.add('R_%s %s %s %s tc1=%g' % (ref, a, z, _num(val), TC_THICK))
            el[ref] = ('R', a, z, val)
        elif k in ('L', 'FB', 'F'):
            pins = b.two_pin(ref)
            if pins and nl.node(b, pins[0]) != nl.node(b, pins[1]):
                nl.add('R_%s %s %s %g' % (ref, nl.node(b, pins[0]), nl.node(b, pins[1]), R_LINK))
                el[ref] = ('L', nl.node(b, pins[0]), nl.node(b, pins[1]), R_LINK)
        elif k in ('LED', 'D'):
            an, ca = _anode_cathode(c)
            if not an or not ca:
                skipped.append(ref)
                continue
            if k == 'LED':
                col = RT.led_colour(p) or 'red'
                vf = RT.LED_VF.get(col, 2.0)
                name = 'DLED_%s' % col
                nl.model(name, led_model(name, vf))
            else:
                dk = _diode_kind(p)
                if dk == 'clamp':
                    bv = _clamp_bv(p)
                    name = 'DZ_%s' % ref
                    nl.model(name, '.model %s D(IS=1n N=1.5 RS=0.5 BV=%g IBV=1m)' % (name, bv))
                else:
                    name = 'DSI' if dk == 'si' else 'DSCH'
                    nl.model(name, DIODE_MODELS[dk])
            a, z = nl.node(b, an), nl.node(b, ca)
            if a == z:
                continue
            nl.add('D_%s %s %s %s' % (ref, a, z, name))
            el[ref] = (k, a, z, name)
        elif k == 'C':
            pins = b.two_pin(ref)
            if pins:
                el[ref] = ('C', nl.node(b, pins[0]), nl.node(b, pins[1]), None)    # open at DC: read its voltage
    # power nets: the roots are ideal sources; nets passed through a fuse, ferrite or diode follow it
    for n, e in sorted(pm['nets'].items()):
        if e['voltage'] is None or n in b.ground:
            continue
        if e['source_kind'] == 'link' and e['from_net'] in pm['nets']:
            continue
        nl.add('V_%s %s 0 DC %s' % (nl.node(b, n), nl.node(b, n), _num(e['voltage'])))
    # loads on the nets: chips' shares and regulators' input current, so a pass-through part carries them
    for n, e in sorted(pm['nets'].items()):
        if e['voltage'] is None:
            continue                      # a load on an undriven net would only pull it to nonsense
        for s in e['sinks']:
            if s['kind'] in ('chip', 'regulator') and s.get('current'):
                nl.add('I_%s_%s %s 0 DC %s' % (s['ref'], nl.node(b, n), nl.node(b, n), _num(s['current'])))
    # chip pins driven low or high through their output resistance; never a pin on a supply in all but
    # name (VDDA, VBAT, a net fed from a supply through a ferrite or a filter resistor): that is a chip's
    # power input, and "driving" it would load the filter with an imaginary short
    if scenario in ('low', 'high'):
        rails = {}
        fed = _supply_like(b)
        for ref in sorted(b.comps):
            if not b.is_chip(ref) or ref in regs:
                continue
            sup = [b.voltage(n) for n in b.nets_of(ref) if n in b.power and (b.voltage(n) or 0) > 0]
            if scenario == 'high' and not sup:
                continue
            vdd = min(sup) if sup else 0.0
            for pad, net in sorted(b.comps[ref]['pins'].items()):
                if not net or net in b.power or net in b.ground or net in fed:
                    continue
                if scenario == 'low':
                    nl.add('R_drv_%s_%s %s 0 %g' % (ref, _safe(pad), nl.node(b, net), R_DRIVE))
                else:
                    if vdd not in rails:
                        rails[vdd] = 'vdrv%d' % len(rails)
                        nl.add('V_%s %s 0 DC %s' % (rails[vdd], rails[vdd], _num(vdd)))
                    nl.add('R_drv_%s_%s %s %s %g' % (ref, _safe(pad), nl.node(b, net), rails[vdd], R_DRIVE))
    for net, node in sorted(nl.nodes.items(), key=lambda x: x[1]):
        nl.add('R_leak_%s %s 0 %g' % (node, node, R_LEAK))
    return nl, el, skipped


_SUPPLY_NAME = re.compile(r'^[+]|^(A|D|P)?V(DD|CC|BAT|IN|SYS|BUS|IO|REF)|^\d+V\d*$|^\d+V\d+|_?3V3|_?5V0?$|VDD|VCC',
                          re.I)
R_FILTER_MAX = 10.0          # Ω: a resistor this small from a supply feeds a filtered supply, not a signal


def _supply_like(b):
    out = set()
    for n in b.members:
        if n in b.power or n in b.ground:
            continue
        if _SUPPLY_NAME.search(n):
            out.add(n)
            continue
        for r in b.refs_on(n):
            pins = b.two_pin(r)
            if not pins:
                continue
            other = pins[1] if pins[0] == n else pins[0]
            if other in b.power and (b.kind(r) in ('L', 'FB', 'F') or
                                     (b.kind(r) == 'R' and (b.resistance(r) or 1e9) <= R_FILTER_MAX)):
                out.add(n)
                break
    return out


def _safe(s):
    return re.sub(r'[^A-Za-z0-9]', '_', str(s))


def _write_op(nl, el, temps, path):
    probes = sorted({'v(%s)' % n for n in nl.nodes.values()})
    probes += ['@d_%s[id]' % ref.lower() for ref, x in sorted(el.items()) if x[0] in ('LED', 'D')]
    lines = list(nl.lines) + sorted(nl.models.values())
    lines += ['.control', 'set noaskquit', 'foreach t %s' % ' '.join(_num(t) for t in temps),
              '  option temp=$t', '  op', '  echo "@@ $t"']
    for i in range(0, len(probes), 8):
        lines.append('  print ' + ' '.join(probes[i:i + 8]))
    lines += ['end', 'quit', '.endc', '.end', '']
    with open(path, 'w') as f:
        f.write('\n'.join(lines))


def operating_point(b, pm, env, work):
    """Worst case per part over scenarios and temperatures: {ref: {current, power, voltage, scenario, temp}},
    plus the raw node voltages per run."""
    temps = sorted({env['ambient_min'], 25.0, env['ambient_max']})
    op, runs, skipped = {}, {}, set()
    for sc in ('idle', 'low', 'high'):
        nl, el, sk = build_op(b, pm, sc)
        skipped |= set(sk)
        path = os.path.join(work, 'op-%s.cir' % sc)
        _write_op(nl, el, temps, path)
        vals = _values(ngspice(path))
        if not vals:
            raise SpiceError('ngspice printed no operating point for %s' % os.path.basename(path))
        for label, v in vals.items():
            t = float(label)
            runs[(sc, t)] = v

            def volt(node):
                return 0.0 if node == '0' else v.get('v(%s)' % node)
            for ref, (k, a, z, val) in el.items():
                va, vz = volt(a), volt(z)
                if va is None or vz is None:
                    continue
                vd = va - vz
                if k == 'R':
                    r_t = val * (1 + TC_THICK * (t - 25))
                    i, pw = abs(vd) / r_t, vd * vd / r_t
                elif k in ('LED', 'D'):
                    i = v.get('@d_%s[id]' % ref.lower())
                    if i is None:
                        continue
                    pw = max(0.0, vd * i)
                    i = abs(i)
                elif k == 'L':
                    i, pw = abs(vd) / val, vd * vd / val
                else:
                    i, pw = 0.0, 0.0
                w = op.setdefault(ref, dict(current=0.0, power=0.0, voltage=0.0, scenario=sc, temp=t, kind=k))
                if pw > w['power'] or (pw == w['power'] and i > w['current']):
                    w.update(power=pw, scenario=sc, temp=t)
                w['current'] = max(w['current'], i)
                w['voltage'] = max(w['voltage'], abs(vd))
                if t == max(temps):
                    w['power_hot'] = max(w.get('power_hot', 0.0), pw)
    return op, runs, sorted(skipped), nl.nodes


# ------------------------------------------------------------------ 2. dividers

def dividers(b):
    """Two resistors in series from a supply to ground whose midpoint goes to a chip pin:
    [(top R, bottom R, top net, mid net)]."""
    out = []
    for mid, members in b.members.items():
        if mid in b.power or mid in b.ground:
            continue
        refs = b.refs_on(mid)
        rs = [r for r in refs if b.kind(r) == 'R' and b.two_pin(r)]
        if len(rs) != 2 or not any(b.is_chip(r) for r in refs):
            continue
        if any(b.kind(r) not in ('R', 'C', 'U', 'MOD') for r in refs):
            continue
        other = {r: [n for n in b.two_pin(r) if n != mid][0] for r in rs}
        top = [r for r in rs if other[r] in b.power and b.voltage(other[r])]
        bot = [r for r in rs if other[r] in b.ground]
        if len(top) == 1 and len(bot) == 1:
            out.append((top[0], bot[0], other[top[0]], mid))
    return out


def divider_corners(b, divs, env, work):
    """ngspice at the tolerance and tempco corners at the coldest and hottest temperature:
    [{top, bottom, mid, vnom, vmin, vmax, spread_pct, tol, assumed}]."""
    lines = ['* resistor dividers at tolerance and temperature corners', '.options tnom=25']
    meta = []
    for i, (rt, rb, top, mid) in enumerate(divs):
        vt = b.voltage(top)
        ra, rbv = b.resistance(rt), b.resistance(rb)
        tols = [RT.parse_tolerance(b.parts[r]) for r in (rt, rb)]
        assumed = any(t is None for t in tols)
        ta, tb = [t if t is not None else 0.01 for t in tols]
        lines.append('V%d t%d 0 DC %s' % (i, i, _num(vt)))
        # nominal (no tempco), and the two worst corners: top high / bottom low and the reverse,
        # with tempcos of opposite sign so temperature pushes the same way
        lines.append('R%dna t%d m%dn %s' % (i, i, i, _num(ra)))
        lines.append('R%dnb m%dn 0 %s' % (i, i, _num(rbv)))
        lines.append('R%dha t%d m%dh %s tc1=%g' % (i, i, i, _num(ra * (1 + ta)), TC_THICK))
        lines.append('R%dhb m%dh 0 %s tc1=%g' % (i, i, _num(rbv * (1 - tb)), -TC_THICK))
        lines.append('R%dla t%d m%dl %s tc1=%g' % (i, i, i, _num(ra * (1 - ta)), -TC_THICK))
        lines.append('R%dlb m%dl 0 %s tc1=%g' % (i, i, _num(rbv * (1 + tb)), TC_THICK))
        meta.append(dict(top=rt, bottom=rb, net=mid, supply=top, tol=max(ta, tb), assumed=assumed))
    temps = sorted({env['ambient_min'], env['ambient_max']})
    lines += ['.control', 'set noaskquit', 'foreach t %s' % ' '.join(_num(t) for t in temps),
              '  option temp=$t', '  op', '  echo "@@ $t"']
    for i in range(len(divs)):
        lines.append('  print v(m%dn) v(m%dh) v(m%dl)' % (i, i, i))
    lines += ['end', 'quit', '.endc', '.end', '']
    path = os.path.join(work, 'dividers.cir')
    with open(path, 'w') as f:
        f.write('\n'.join(lines))
    vals = _values(ngspice(path))
    for i, m in enumerate(meta):
        vs = [x for run in vals.values() for x in (run.get('v(m%dh)' % i), run.get('v(m%dl)' % i)) if x is not None]
        vn = next((run.get('v(m%dn)' % i) for run in vals.values()), None)
        if vn is None or not vs:
            raise SpiceError('no divider result for %s/%s' % (m['top'], m['bottom']))
        m.update(vnom=vn, vmin=min(vs), vmax=max(vs), spread_pct=100 * max(abs(x - vn) for x in vs) / vn)
    return meta


# ------------------------------------------------------------------ 3. rails: impedance and load step

def _cap_model(b, ref, volts, temp):
    """(C effective, ESR, ESL, why) of a capacitor on a rail."""
    p = b.parts[ref]
    c = RT.parse_capacitance(p.get('value')) or RT.parse_capacitance(p.get('description'))
    if not c:
        return None
    ct = RT.cap_type(p)
    left = RT.mlcc_remaining(p, volts, temp) if ct == 'ceramic' else 1.0
    if left is None:
        left = 1.0
    if ct == 'ceramic':
        esr = 0.01 if c >= 10e-6 else (0.02 if c >= 1e-6 else 0.04)      # typical MLCC ESR near resonance
        esl = ESL.get(RT.package(p), ESL['0805'])
    elif ct == 'tantalum':
        esr, esl = (0.3 if re.search(r'low.?ESR', RT.text(p), re.I) else 1.0), ESL_OTHER
    elif ct == 'polymer':
        esr, esl = 0.05, ESL_OTHER
    else:
        esr, esl = 0.5, ESL_OTHER
    return c * left, esr, esl + L_MOUNT, '%s: %s → %s' % (ref, _uf(c), _uf(c * left))


def _uf(f):
    if f >= 1e-6:
        return ('%.1f µF' % (f * 1e6)).replace('.0 µF', ' µF')
    return '%.0f nF' % (f * 1e9)


def rails(b, pm):
    """Power nets that feed at least one chip, with a voltage and a load."""
    out = []
    for n, e in sorted(pm['nets'].items()):
        if e['voltage'] and any(s['kind'] == 'chip' for s in e['sinks']):
            out.append(n)
    return out


def _source_chain(b, pm, net, depth=0):
    """[(R, L, net)] from the ideal source to `net`: the regulator or cable model, then any
    pass-through parts (ferrite, inductor, fuse), each with the capacitors on its upstream net."""
    e = pm['nets'][net]
    if e['source_kind'] == 'link' and e['from_net'] in pm['nets'] and depth < 4:
        up = _source_chain(b, pm, e['from_net'], depth + 1)
        k = b.kind(e['source'])
        p = b.parts[e['source']]
        lval = None
        if k in ('L', 'FB'):
            m = re.search(r'(\d+(?:\.\d+)?)\s*([nuµ])H', RT.text(p))
            lval = float(m.group(1)) * (1e-9 if m.group(2) == 'n' else 1e-6) if m else 1e-6
        return up + [(R_LINK if k != 'D' else 0.1, lval, net, '%s (%s)' % (e['source'], k))]
    kind = 'other'
    if e['source_kind'] == 'regulator':
        g = next((g for g in pm['regulators'] if g['ref'] == e['source']), None)
        kind = g['kind'] if g else 'ldo'
    elif e['source_kind'] in ('usb', 'external'):
        kind = e['source_kind']
    r, l = SOURCE_MODEL[kind]
    return [(r, l, net, '%s (%s model: %g Ω + %g µH)' % (e['source'] or 'unknown source', kind, r, l * 1e6))]


def _rail_netlist(b, pm, net, env, analysis):
    chain = _source_chain(b, pm, net)
    lines = ['* %s on %s' % (analysis, net)]
    v = pm['nets'][chain[0][2]]['voltage'] if chain else pm['nets'][net]['voltage']
    lines.append('V1 s0 0 DC %s%s' % (_num(v), ' AC 0' if analysis == 'pdn' else ''))
    prev, caps, notes = 's0', [], []
    for i, (r, l, n, why) in enumerate(chain):
        node = 'r%d' % i
        if l:
            lines.append('R%d %s x%d %g' % (i, prev, i, r))
            lines.append('L%d x%d %s %g' % (i, i, node, l))
        else:
            lines.append('R%d %s %s %g' % (i, prev, node, r))
        notes.append(why)
        for c in _caps_between(b, n):
            m = _cap_model(b, c, pm['nets'][n]['voltage'] or 0, env['ambient_max'])
            if not m:
                continue
            ce, esr, esl, cwhy = m
            lines += ['C_%s %s %s_a %s' % (c, node, c, _num(ce)), 'R_%s %s_a %s_b %g' % (c, c, c, esr),
                      'L_%s %s_b 0 %s' % (c, c, _num(esl))]
            caps.append(c)
            notes.append(cwhy)
        prev = node
    return lines, prev, caps, notes, chain


def _caps_between(b, net):
    out = []
    for r in b.refs_on(net):
        if b.kind(r) == 'C':
            nets = set(b.nets_of(r))
            if net in nets and len(nets) == 2 and (nets - {net}) <= b.ground:
                out.append(r)
    return sorted(out)


def pdn(b, pm, env, work, net):
    load = pm['nets'][net]['load'] or pm['nets'][net]['stated_current']
    v = pm['nets'][net]['voltage']
    lines, node, caps, notes, chain = _rail_netlist(b, pm, net, env, 'pdn')
    lines.append('I1 %s 0 DC 0 AC 1' % node)
    lines += ['.control', 'set noaskquit', 'set wr_singlescale', 'set wr_vecnames', 'ac dec 12 1k 100meg',
              'let z = mag(v(%s))' % node, 'wrdata pdn-%s.out z' % _safe(net), 'quit', '.endc', '.end', '']
    path = os.path.join(work, 'pdn-%s.cir' % _safe(net))
    with open(path, 'w') as f:
        f.write('\n'.join(lines))
    ngspice(path)
    rows = _table(os.path.join(work, 'pdn-%s.out' % _safe(net)))
    f = [r[0] for r in rows]
    z = [r[1] for r in rows]
    target = v * TARGET_RIPPLE / (TARGET_STEP * load)
    band = [(fi, zi) for fi, zi in zip(f, z) if fi <= PDN_PASS_TO * 1.0001]
    fw, zw = max(band, key=lambda x: x[1])
    return dict(net=net, target_ohm=round(target, 5), f=[round(x, 1) for x in f], z=[round(x, 6) for x in z],
                caps=caps, worst_f=fw, worst_ohm=zw, model=notes)


def load_step(b, pm, env, work, net):
    load = pm['nets'][net]['load'] or pm['nets'][net]['stated_current']
    v = pm['nets'][net]['voltage']
    lines, node, caps, notes, chain = _rail_netlist(b, pm, net, env, 'load step')
    ctot = sum(_cap_model(b, c, v, env['ambient_max'])[0] for c in caps) or 1e-9
    ltot = sum(l or 0 for _, l, _, _ in chain) or 1e-7
    f_res = 1 / (2 * math.pi * math.sqrt(ltot * ctot))
    t0, rise = 10e-6, 1e-6
    tstop = min(2e-3, max(100e-6, t0 + 6 / f_res))
    lo, hi = 0.1 * load, load
    lines.append('I1 %s 0 PWL(0 %s %s %s %s %s)' % (node, _num(lo), _num(t0), _num(lo), _num(t0 + rise), _num(hi)))
    lines += ['.control', 'set noaskquit', 'set wr_singlescale', 'set wr_vecnames',
              'tran %s %s' % (_num(tstop / 4000), _num(tstop)),
              'wrdata step-%s.out v(%s)' % (_safe(net), node), 'quit', '.endc', '.end', '']
    path = os.path.join(work, 'step-%s.cir' % _safe(net))
    with open(path, 'w') as f:
        f.write('\n'.join(lines))
    ngspice(path)
    rows = _table(os.path.join(work, 'step-%s.out' % _safe(net)))
    ts, vs = [r[0] for r in rows], [r[1] for r in rows]
    vmin = min(vs)
    # 200 evenly spaced points for the report
    out_t, out_v, j = [], [], 0
    for k in range(200):
        t = tstop * k / 199
        while j < len(ts) - 2 and ts[j + 1] < t:
            j += 1
        t1, t2 = ts[j], ts[j + 1] if j + 1 < len(ts) else ts[j]
        y = vs[j] if t2 == t1 else vs[j] + (vs[j + 1] - vs[j]) * (t - t1) / (t2 - t1)
        out_t.append(round(t * 1e6, 3))
        out_v.append(round(y, 5))
    return dict(net=net, t_us=out_t, v=out_v, min_v=round(vmin, 5), nominal=v, caps=caps,
                droop_pct=100 * (v - vmin) / v, step=(lo, hi), model=notes)


# ------------------------------------------------------------------ checks

def run(d, env=None, pm=None, work='.'):
    from .power import power_model
    b = Board(d)
    env = environment(b.d, env)
    pm = pm or power_model(b.d, env)
    report = dict(pdn=[], step=[], stress=[], ngspice=None)
    if not available():
        why = 'ngspice is not installed here (the engine image has it), so the circuit was not simulated'
        return [K.skip(i, why) for i in IDS], report, None
    ver = version()
    report['ngspice'] = ver
    tool = dict(tool='ngspice %s' % ver.split('-', 1)[1]) if ver else {}
    os.makedirs(work, exist_ok=True)
    results = []
    op = None
    try:
        op, runs, skipped, _ = operating_point(b, pm, env, work)
    except SpiceError as e:
        results += [K.skip(i, 'the operating-point simulation did not run: %s' % e, **tool)
                    for i in ('stress-resistor-power', 'stress-led-current')]
    if op is not None:
        results.append(_resistor_power(b, env, op, skipped, report, tool))
        results.append(_led_current(b, env, op, report, tool))
        for ref, w in op.items():
            if w['kind'] in ('R', 'LED', 'D') and w['power'] > 0:
                pm['dissipation'][ref] = dict(power=w['power'], assumed=False,
                                              how='circuit simulation, worst case (chips %s, %g °C)' % (w['scenario'], w['temp']))
    divs = dividers(b)
    if not divs:
        results.append(K.na('stress-tolerance', 'no resistor divider feeds a chip pin', **tool))
    else:
        try:
            results.append(_tolerance(b, env, divider_corners(b, divs, env, work), report, tool))
        except SpiceError as e:
            results.append(K.skip('stress-tolerance', 'the divider simulation did not run: %s' % e, **tool))
    results += _rails(b, pm, env, work, report, tool)
    return results, report, op


def _ref_where(b, refs, note=None):
    out = []
    for r in refs:
        pl = b.d.get('placement', {}).get(r)
        if pl and pl.get('x') is not None:
            out.append(dict(x=pl['x'], y=pl['y'], refs=[r], **({'note': note} if note else {})))
    return out or None


def _derate(t):
    """Thick-film chip resistor power derating: 100 % up to 70 °C, linear to 0 at 155 °C (IEC 60115-8)."""
    return 1.0 if t <= 70 else max(0.0, (155.0 - t) / 85.0)


def _resistor_power(b, env, op, skipped, report, tool):
    rs = [r for r in b.comps if b.kind(r) == 'R']
    if not rs:
        return K.na('stress-resistor-power', 'the board has no resistors', **tool)
    fails, warns, worst, bad = [], [], None, []
    hot = env['ambient_max']
    for r in rs:
        if r not in op:
            continue
        p = max(op[r]['power'], op[r].get('power_hot', 0.0))
        rt = b.rating(r)
        prated = rt['power_max']
        theta = RT.RES_THETA.get(rt.get('package'), 400.0)
        # the resistor's own temperature: the hottest ambient plus its own rise (power × θ).  The
        # derating curve already allows for self-heating, so this is deliberately on the safe side
        t_body = hot + p * theta
        allowed = prated * _derate(t_body)
        pct = 100 * p / allowed if allowed > 0 else float('inf')
        assumed = 'power_max' in rt['assumed']
        report['stress'].append(dict(ref=r, what='power', value=round(p, 6), rating=round(prated, 5),
                                     pct=round(min(pct, 9999), 1), limit_pct=50, ambient=hot,
                                     note='%.0f °C on the part, rating there %.0f mW%s' % (
                                         t_body, allowed * 1e3, ', rating assumed' if assumed else '')))
        if worst is None or pct > worst[0]:
            worst = (pct, r, p, allowed)
        msg = '%s (%s, %s) turns %s into heat%s; at %.0f °C it is good for %s (%.0f %%)' % (
            r, b.parts[r].get('value') or '?', rt.get('package') or 'size unknown', _mw(p),
            ' with chips ' + op[r]['scenario'] if op[r]['scenario'] != 'idle' else '', t_body, _mw(allowed), pct)
        top = RT.RES_POWER_ANY.get(rt.get('package'))
        beyond_any = top is not None and p > top * _derate(t_body)
        if pct > 100:
            (warns if assumed and not beyond_any else fails).append(
                msg + (' (rating assumed from its size)' if assumed and not beyond_any else ''))
            bad.append(r)
        elif pct > 50:
            warns.append(msg + ': above the 50 % that keeps it cool and stable')
            bad.append(r)
    st = 'fail' if fails else ('warn' if warns else 'pass')
    if worst is None:
        return K.skip('stress-resistor-power', 'no resistor could be simulated', **tool)
    detail = '; '.join(fails + warns) if st != 'pass' else (
        'every resistor runs below half its derated rating at %.0f °C (busiest: %s, %s of %s)' % (
            hot, worst[1], _mw(worst[2]), _mw(worst[3])))
    if skipped:
        detail += '; not simulated: %s (value or pins not understood)' % ', '.join(skipped[:6])
    fix = None
    if st != 'pass':
        fix = 'Use a bigger resistor for each one listed (0603 takes 0.1 W, 0805 0.125 W, 1206 0.25 W), or raise its ' \
              'value so less current flows.'
    return K.result('stress-resistor-power', st, detail=detail,
                    measured=K.measure('busiest resistor, share of its derated rating', min(worst[0], 9999), '%', 100, '<='),
                    fix=fix, where=_ref_where(b, bad or [worst[1]]), **tool)


def _mw(p):
    return '%.1f mW' % (p * 1e3) if p < 1 else '%.2f W' % p


def _led_current(b, env, op, report, tool):
    leds = [r for r in b.comps if b.kind(r) == 'LED']
    if not leds:
        return K.na('stress-led-current', 'the board has no LEDs', **tool)
    fails, warns, oks, dark, worst, bad = [], [], [], [], None, []
    for r in leds:
        if r not in op:
            dark.append(r)
            continue
        i = op[r]['current']
        if i < 1e-5:
            dark.append(r)
            continue
        rt = b.rating(r)
        imax = rt['current_max'] or 0.02
        pct = 100 * i / imax
        assumed = 'current_max' in rt['assumed']
        report['stress'].append(dict(ref=r, what='current', value=round(i, 6), rating=imax, pct=round(pct, 1),
                                     limit_pct=80, ambient=env['ambient_max'],
                                     note='chips %s%s' % (op[r]['scenario'], ', rating assumed' if assumed else '')))
        if worst is None or pct > worst[0]:
            worst = (pct, r)
        msg = '%s gets %.1f mA (rated %.0f mA%s)' % (r, i * 1e3, imax * 1e3, ', assumed' if assumed else '')
        if pct > 100:
            # an assumed 20 mA rating: small SMD LEDs are rated 20-30 mA, so up to 150 % only warns
            (warns if assumed and pct <= 150 else fails).append(msg)
            bad.append(r)
        elif pct > 80:
            warns.append(msg + ': little margin')
            bad.append(r)
        else:
            oks.append(msg)
    if worst is None:
        return K.result('stress-led-current', 'warn', detail='%s never lit in the simulation (driven through a transistor '
                        'or a part it cannot model), so the current is not checked' % ', '.join(dark), **tool)
    st = 'fail' if fails else ('warn' if warns else 'pass')
    detail = '; '.join(fails + warns + oks)
    if dark:
        detail += '; not lit in any scenario, so not checked: %s' % ', '.join(dark)
        if st == 'pass':
            st = 'warn'
    fix = None
    if fails or warns:
        fix = 'Raise the series resistor of each LED listed: R = (supply − LED voltage) / current, for example ' \
              '(3.3 V − 2.0 V) / 2 mA = 680 Ω for a red LED.'
    elif dark:
        fix = 'Check the LED current by hand: (supply − LED voltage) / resistor.'
    return K.result('stress-led-current', st, detail=detail,
                    measured=K.measure('busiest LED, share of its current rating', worst[0], '%', 80, '<='),
                    fix=fix, where=_ref_where(b, bad or [worst[1]]), **tool)


def _tolerance(b, env, meta, report, tool):
    warns, oks = [], []
    for m in meta:
        say = '%s/%s on %s: %.3f V nominal, %.3f to %.3f V (±%.1f %%) with ±%g %% parts%s at %g and %g °C' % (
            m['top'], m['bottom'], m['net'], m['vnom'], m['vmin'], m['vmax'], m['spread_pct'], m['tol'] * 100,
            ' (assumed)' if m['assumed'] else '', env['ambient_min'], env['ambient_max'])
        report['stress'].append(dict(ref='%s/%s' % (m['top'], m['bottom']), what='divider spread',
                                     value=round(m['spread_pct'], 3), rating=DIVIDER_SPREAD,
                                     pct=round(100 * m['spread_pct'] / DIVIDER_SPREAD, 1), limit_pct=100,
                                     ambient=env['ambient_max'], note=m['net']))
        (warns if m['spread_pct'] > DIVIDER_SPREAD else oks).append(say)
    worst = max(meta, key=lambda m: m['spread_pct'])
    st = 'warn' if warns else 'pass'
    return K.result('stress-tolerance', st, detail='; '.join(warns + oks),
                    measured=K.measure('widest divider spread', worst['spread_pct'], '%', DIVIDER_SPREAD, '<='),
                    fix='Use 1 % (or 0.5 %) resistors with a low temperature coefficient for the dividers listed.'
                    if warns else None, where=_ref_where(b, [worst['top'], worst['bottom']]), **tool)


def _rails(b, pm, env, work, report, tool):
    names = rails(b, pm)
    if not names:
        why = 'no supply rail feeds a chip'
        return [K.na('pdn', why, **tool), K.na('load-step', why, **tool)]
    no_load = [n for n in names if not (pm['nets'][n]['load'] or pm['nets'][n]['stated_current'])]
    names = [n for n in names if n not in no_load]
    if not names:
        why = 'no supply rail states its current (%s), so there is no target to test against' % ', '.join(no_load)
        return [K.skip('pdn', why, **tool), K.skip('load-step', why, **tool)]
    zs, steps, errs = [], [], []
    for n in names:
        try:
            zs.append(pdn(b, pm, env, work, n))
            steps.append(load_step(b, pm, env, work, n))
        except SpiceError as e:
            errs.append('%s: %s' % (n, e))
    out = []
    # ---- pdn
    if zs:
        bad = [z for z in zs if z['worst_ohm'] > z['target_ohm']]
        for z in zs:
            report['pdn'].append({k: z[k] for k in ('net', 'target_ohm', 'f', 'z', 'caps')})
        say = ['%s: highest %s at %s against a target of %s (caps %s)' % (
            z['net'], _ohm(z['worst_ohm']), _hz(z['worst_f']), _ohm(z['target_ohm']), ', '.join(z['caps']) or 'none')
            for z in (bad or zs)]
        worst = max(zs, key=lambda z: z['worst_ohm'] / z['target_ohm'])
        detail = '; '.join(say) + '. Regulators are modelled simply (an LDO as 0.05 Ω + 0.5 µH, a switcher as ' \
                                  '0.02 Ω + 1 µH), so a peak where the regulator hands over to the capacitors is ' \
                                  'an estimate. Above 10 MHz the chips\' own package capacitors take over, so ' \
                                  'the curve past that is shown but not judged'
        if errs:
            detail += '; not simulated: ' + '; '.join(errs)
        if no_load:
            detail += '; no current stated, so not tested: %s' % ', '.join(no_load)
        out.append(K.result('pdn', 'warn' if bad or errs else 'pass', detail=detail,
                            measured=K.measure('highest supply impedance (%s, %s)' % (worst['net'], _hz(worst['worst_f'])),
                                               worst['worst_ohm'], 'Ω', worst['target_ohm'], '<='),
                            fix=('Add capacitance on %s: a 10-22 µF ceramic near the regulator for the low end, and a '
                                 '100 nF beside each chip for the high end (more small ones lower the peak).'
                                 % ', '.join(z['net'] for z in bad)) if bad else None, **tool))
    else:
        out.append(K.skip('pdn', 'the impedance simulation did not run: ' + '; '.join(errs), **tool))
    # ---- load step
    if steps:
        bad = [s for s in steps if s['droop_pct'] > STEP_LIMIT]
        for s in steps:
            report['step'].append({k: s[k] for k in ('net', 't_us', 'v', 'min_v', 'nominal')})
        say = ['%s: %s → %s step, lowest %.3f V (%.1f %% below %s)' % (
            s['net'], _ma(s['step'][0]), _ma(s['step'][1]), s['min_v'], s['droop_pct'], _vv(s['nominal']))
            for s in (bad or steps)]
        worst = max(steps, key=lambda s: s['droop_pct'])
        detail = '; '.join(say)
        if errs:
            detail += '; not simulated: ' + '; '.join(errs)
        if no_load:
            detail += '; no current stated, so not tested: %s' % ', '.join(no_load)
        out.append(K.result('load-step', 'warn' if bad or errs else 'pass', detail=detail,
                            measured=K.measure('largest dip (%s)' % worst['net'], worst['droop_pct'], '%', STEP_LIMIT, '<='),
                            fix=('Add bulk capacitance on %s (for example another 22 µF ceramic, or a 100 µF '
                                 'polymer for large steps) close to the load.' % ', '.join(s['net'] for s in bad))
                            if bad else None, **tool))
    else:
        out.append(K.skip('load-step', 'the load-step simulation did not run: ' + '; '.join(errs), **tool))
    return out


def _ohm(x):
    return '%.0f mΩ' % (x * 1e3) if x < 1 else '%.2f Ω' % x


def _hz(f):
    if f >= 1e6:
        return '%.3g MHz' % (f / 1e6)
    if f >= 1e3:
        return '%.3g kHz' % (f / 1e3)
    return '%.3g Hz' % f


def _ma(a):
    return '%.0f mA' % (a * 1e3) if a < 1 else '%.2f A' % a


def _vv(v):
    return ('%.2f' % v).rstrip('0').rstrip('.') + ' V'
