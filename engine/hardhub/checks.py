# SPDX-License-Identifier: AGPL-3.0-or-later
"""Circuit checks: what can be known before a board exists.

Each check returns a protocol CheckResult: what was checked, why it
matters, and the result.  A check that cannot run says "skip" and why,
rather than passing quietly (offgrid-hardware TESTS.md: "a check that
cannot fail is no check").
"""
import re

from . import design as D

# Espressif module pin -> GPIO (module datasheets, pin layout tables)
ESP32_MODULES = {
    'ESP32-S3-WROOM-1': dict(
        gpio={4: 4, 5: 5, 6: 6, 7: 7, 8: 15, 9: 16, 10: 17, 11: 18, 12: 8, 13: 19, 14: 20, 15: 3, 16: 46,
              17: 9, 18: 10, 19: 11, 20: 12, 21: 13, 22: 14, 23: 21, 24: 47, 25: 48, 26: 45, 27: 0,
              28: 35, 29: 36, 30: 37, 31: 38, 32: 39, 33: 40, 34: 41, 35: 42, 36: 44, 37: 43, 38: 2, 39: 1},
        strapping={0, 3, 45, 46}, adc2=set(range(11, 21)), usb={19, 20}),
    'ESP32-C3-WROOM-02': dict(
        gpio={3: 4, 4: 5, 5: 6, 6: 7, 7: 8, 8: 9, 10: 10, 11: 20, 12: 21, 13: 18, 14: 19, 15: 3, 16: 2, 17: 1, 18: 0},
        strapping={2, 8, 9}, adc2={5}, usb={18, 19}),
}


def result(id, group, name, why, ok, detail=None, warn=False):
    status = 'pass' if ok else ('warn' if warn else 'fail')
    r = dict(id=id, group=group, name=name, why=why, status=status)
    if detail:
        r['detail'] = detail
    return r


def skip(id, group, name, why, detail):
    return dict(id=id, group=group, name=name, why=why, status='skip', detail=detail)


def module_of(part):
    for k in ESP32_MODULES:
        if part['mpn'].upper().startswith(k):
            return k
    return None


def circuit(d, with_footprints=True):
    d = D.normalize(d)
    out = []
    comps = d['components']
    # a check that cannot fail is no check: with nothing drawn, say so
    out.append(result('has-circuit', 'circuit', 'The circuit has parts',
                      'every other circuit check passes trivially on an empty design', bool(comps),
                      None if comps else 'no components yet: draw the circuit first'))
    missing = [c['ref'] for c in comps if c['part'] not in d['parts']]
    out.append(result('parts-exist', 'circuit', 'Every component names a known part',
                      'a component without a part has no footprint and cannot be bought', not missing,
                      ', '.join(missing[:10])))
    nets = D.nets(d)
    single = sorted(n for n, m in nets.items() if len(m) < 2)
    out.append(result('single-pin-nets', 'circuit', 'No net with only one pin',
                      'a net on one pin connects nothing: usually a typo in a net name', not single,
                      ', '.join(single[:10])))
    if with_footprints:
        out.append(pins_on_footprints(d))
    asm = [(c['ref'], d['parts'][c['part']]) for c in comps if c['part'] in d['parts']
           and d['parts'][c['part']].get('assembled', True)]
    no_lcsc = sorted({r for r, p in asm if not (p.get('sourcing') or {}).get('lcsc')})
    out.append(result('lcsc', 'fab', 'Every assembled part has an LCSC number',
                      'the assembly house buys and places parts by this number', not no_lcsc,
                      ', '.join(no_lcsc[:10])))
    eol = sorted({k for k, p in d['parts'].items() if p.get('lifecycle') == 'eol'})
    nrnd = sorted({k for k, p in d['parts'].items() if p.get('lifecycle') == 'nrnd'})
    out.append(result('lifecycle-eol', 'circuit', 'No end-of-life parts',
                      'an end-of-life part stops being made: the board cannot be built again', not eol, ', '.join(eol)))
    out.append(result('lifecycle-nrnd', 'circuit', 'No parts marked not for new designs',
                      'the maker has said not to start new designs with these', not nrnd, ', '.join(nrnd), warn=True))
    out_of_stock = sorted(k for k, p in d['parts'].items()
                          if p.get('assembled', True) and (p.get('sourcing') or {}).get('stock') == 0)
    out.append(result('stock', 'fab', 'Every assembled part is in stock at the assembler',
                      'an out-of-stock part holds the whole order', not out_of_stock, ', '.join(out_of_stock),
                      warn=True))
    pw = sorted(n for n, x in d['nets'].items() if x.get('kind') == 'power' and not x.get('current')
                and not x.get('width') and n in nets)
    out.append(result('power-current', 'power', 'Every power net states its current',
                      'track widths are sized from the current; a guess makes hot tracks', not pw, ', '.join(pw[:10]),
                      warn=True))
    out += esp32(d)
    return out


def pins_on_footprints(d):
    from . import footprints
    bad = []
    seen = {}
    for c in d['components']:
        p = d['parts'].get(c['part'])
        if not p:
            continue
        try:
            pads = seen[p['footprint']] = seen.get(p['footprint']) or footprints.pads(p['footprint'])
        except Exception as e:                       # noqa: BLE001 -- a missing footprint is the finding
            bad.append('%s: %s' % (c['ref'], e))
            continue
        for pin in c['pins']:
            if pin not in pads:
                bad.append('%s pin %s is not a pad of %s' % (c['ref'], pin, p['footprint']))
        for pad in sorted(pads):
            if pad not in c['pins']:
                bad.append('%s pad %s is not in the design (give it a net or null)' % (c['ref'], pad))
    return result('pins-pads', 'circuit', 'Every pin is on its footprint, every pad is in the design',
                  'a wrong or missing pad is a dead board', not bad, '; '.join(bad[:8]) + (' ...' if len(bad) > 8 else ''))


def esp32(d):
    out = []
    fw = d.get('firmware') or {}
    for c in d['components']:
        p = d['parts'].get(c['part'])
        mod = module_of(p) if p else None
        if not mod:
            continue
        m = ESP32_MODULES[mod]
        gpio_net = {m['gpio'][int(pad)]: net for pad, net in c['pins'].items()
                    if re.fullmatch(r'\d+', pad) and int(pad) in m['gpio']}
        nets = D.nets(d)
        used_strap = sorted(g for g in m['strapping'] if gpio_net.get(g) and len(nets.get(gpio_net[g], [])) > 1)
        out.append(result('esp32-strapping-%s' % c['ref'], 'firmware', '%s strapping pins checked' % c['ref'],
                          'a strapping pin pulled the wrong way at power-up stops the chip booting',
                          not used_strap, used_strap and 'GPIO %s connected: check each one\'s level at boot'
                          % ', '.join(map(str, used_strap)), warn=True))
        analog = [x for x in fw.get('pins', []) if x.get('dir') == 'analog']
        adc2 = sorted(x['gpio'] for x in analog if x['gpio'] in m['adc2'])
        out.append(result('esp32-adc2-%s' % c['ref'], 'firmware', '%s analogue inputs on ADC1' % c['ref'],
                          'ADC2 stops working while Wi-Fi is on', not adc2, adc2 and 'GPIO %s' % adc2))
        if fw.get('pins') and fw.get('mcu', c['ref']) == c['ref']:
            wrong = ['%s: GPIO%d is %s, firmware says %s' % (x['name'], x['gpio'], gpio_net.get(x['gpio']), x['net'])
                     for x in fw['pins'] if gpio_net.get(x['gpio']) != x['net']]
            out.append(result('firmware-pins-%s' % c['ref'], 'firmware', 'Firmware pin map matches the circuit',
                              'a pin mismatch is a port that never switches or a reading of the wrong sensor',
                              not wrong, '; '.join(wrong[:8])))
        else:
            out.append(skip('firmware-pins-%s' % c['ref'], 'firmware', 'Firmware pin map matches the circuit',
                            'a pin mismatch is a feature that never works', 'no firmware pin map yet'))
    return out
