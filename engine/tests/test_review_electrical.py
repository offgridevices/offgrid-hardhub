# SPDX-License-Identifier: AGPL-3.0-or-later
"""The electrical brain of the board tests: part ratings, the power tree,
design-level electrical checks, and the ngspice simulations.

No KiCad needed.  Tests marked `spice` need ngspice on the PATH (the engine
image has it); without it they are skipped, and one test checks that the
checks then say "skip" instead of passing.
"""
import copy
import json
import os
import shutil

import pytest

from hardhub.review import catalog, electrical, power, ratings, spice

spice_only = pytest.mark.skipif(shutil.which('ngspice') is None, reason='needs ngspice (run inside the engine image)')


def by_id(results):
    return {r['id']: r for r in results}


def run_checks(d, env=None, op=None):
    env = power.environment(d, env)
    pm = power.power_model(d, env)
    res, rep = electrical.checks(d, env, pm, op)
    return by_id(res), rep, pm


def run_spice(d, tmp_path, env=None):
    env = power.environment(d, env)
    pm = power.power_model(d, env)
    res, rep, op = spice.run(d, env, pm, str(tmp_path))
    return by_id(res), rep, op, pm


# ---- small hand-made designs

def P(kind, value, desc, fp, mpn=None, **kw):
    return dict(mpn=mpn or ('X-' + value), maker='test', kind=kind, value=value, description=desc, footprint=fp, **kw)


JACK = P('J', 'DC jack', 'DC barrel jack 5.5 x 2.1 mm', 'Connector_BarrelJack:BarrelJack_Horizontal', mpn='DC-005')


def design(parts, comps, nets, **extra):
    d = dict(name='t', parts=parts, nets=nets,
             components=[dict(ref=r, part=p, block='b', pins=pins) for r, p, pins in comps],
             board=dict(width=30, height=30, layers=2))
    d.update(extra)
    return d


def supply(volts, amps=0.1, net='VIN'):
    """A jack bringing `volts` onto `net`."""
    return ({'JACK': JACK}, [('J1', 'JACK', {'1': net, '2': 'GND'})],
            {net: dict(kind='power', voltage=volts, current=amps), 'GND': dict(kind='ground')})


# ------------------------------------------------------------------ parsers and ratings

def test_parsers():
    cap = ratings.parse_capacitance
    assert cap('100nF') == pytest.approx(100e-9) and cap('10uF') == pytest.approx(10e-6)
    assert cap('4.7µF') == pytest.approx(4.7e-6) and cap('4u7') == pytest.approx(4.7e-6) and cap('100n') == pytest.approx(1e-7)
    assert cap('Capacitor 22uF 6.3V X5R 0603') == pytest.approx(22e-6)
    v = ratings.parse_voltage
    assert v('16V') == 16 and v('6.3 V') == 6.3 and v('6V3') == 6.3 and v('Capacitor 100nF 50VDC X7R') == 50
    r = ratings.parse_resistance
    assert r('4.7k') == 4700 and r('10K') == 10000 and r('1R') == 1 and r('0R') == 0 and r('1M') == 1e6
    assert r('4k7') == 4700 and r('2R2') == pytest.approx(2.2) and r('100m') == pytest.approx(0.1)
    assert r('Resistor 10k 1% 0402') == 10000 and r('100') == 100
    assert ratings.parse_dielectric('Capacitor 1uF 25V X5R 0402') == 'X5R'
    assert ratings.parse_dielectric({'mpn': 'CL05B104KO5NNNC'}) == 'X7R'           # Samsung code B
    assert ratings.parse_dielectric('22pF NP0') == 'C0G'
    pk = lambda fp, desc='': ratings.package(dict(footprint=fp, description=desc))
    assert pk('Resistor_SMD:R_0402_1005Metric') == '0402'
    assert pk('Capacitor_SMD:C_0201_0603Metric') == '0201'          # imperial code first, not the metric one
    assert pk('Package_TO_SOT_SMD:SOT-223-3_TabPin2') == 'SOT-223'
    assert pk('Package_TO_SOT_SMD:SOT-23-5') == 'SOT-23-5'
    assert pk('Package_TO_SOT_SMD:TO-252-2') == 'TO-252'
    assert pk('hh:R2512') == '2512'
    assert ratings.parse_tolerance(dict(description='Resistor 1k 1% 0402')) == 0.01
    assert ratings.parse_tolerance(dict(mpn='0402WGJ1001TCE')) == 0.05


def test_ratings_from_datasheet_family_and_defaults(c3):
    parts = c3['parts']
    ams = ratings.ratings(parts['AMS1117'])
    assert (ams['dropout'], ams['current_max'], ams['voltage_max'], ams['temp_min']) == (1.3, 1.0, 15.0, -40)
    assert ams['assumed'] == []
    assert ratings.regulator(parts['AMS1117'])['kind'] == 'ldo'
    assert ratings.regulator(parts['ESP32C3']) is None and ratings.regulator(parts['SHT40']) is None
    c22 = ratings.ratings(parts['C22U'])
    assert c22['voltage_max'] == 6.3 and (c22['temp_min'], c22['temp_max']) == (-55, 85) and not c22['assumed']
    assert ratings.ratings(parts['C100N'])['temp_max'] == 125                       # X7R
    r = ratings.ratings(parts['R10K'])
    assert r['power_max'] == pytest.approx(1 / 16) and r['temp_max'] == 155
    esp = ratings.ratings(parts['ESP32C3'])
    assert (esp['temp_min'], esp['temp_max'], esp['voltage_max']) == (-40, 85, 3.6)
    # S3-WROOM-1 with octal PSRAM is a 65 °C part (Espressif ordering table)
    assert ratings.ratings(dict(mpn='ESP32-S3-WROOM-1-N16R8', kind='MOD', description='', footprint='x:y'))['temp_max'] == 65
    # an unknown chip: commercial 0..70 °C, assumed
    u = ratings.ratings(P('U', 'X', 'some chip', 'Package_SO:SOIC-8'))
    assert (u['temp_min'], u['temp_max']) == (0, 70) and 'temp_min' in u['assumed']
    # the design's own ratings win
    own = ratings.ratings(dict(parts['C22U'], ratings=dict(voltage_max=10)))
    assert own['voltage_max'] == 10 and own['source']['voltage_max'] == 'design'
    # regulator detection by words
    assert ratings.regulator(P('U', 'X', 'Step-down DC-DC converter 2 A', 'x:y'))['kind'] == 'buck'
    assert ratings.regulator(P('U', 'X', 'Boost converter 5 V', 'x:y'))['kind'] == 'boost'
    assert ratings.regulator(P('U', 'X', 'Li-ion battery charger', 'x:y')) is None


def test_dc_bias_estimate_tracks_makers_curves(c3):
    left = lambda k, v: ratings.mlcc_remaining(c3['parts'][k], v, 25)
    assert 0.25 < left('C22U', 3.3) < 0.45          # Samsung CL10A226MQ8: ~35 % at 3.3 V
    assert 0.3 < left('C10U', 5.0) < 0.5            # CL10A106: ~40 % at 5 V
    assert left('C100N', 3.3) > 0.85                # 100 nF X7R 0402: under 10 % lost
    assert ratings.mlcc_remaining(P('C', '22pF', 'Capacitor 22pF 50V C0G 0402', 'Capacitor_SMD:C_0402_1005Metric'), 5, 85) == 1.0


# ------------------------------------------------------------------ power tree

def test_power_tree_of_the_fixture(c3):
    pm = power.power_model(c3)
    v3, vb = pm['nets']['+3V3'], pm['nets']['VBUS']
    assert (v3['source'], v3['source_kind'], v3['from_net'], v3['source_pads']) == ('U2', 'regulator', 'VBUS', ['2'])
    assert (vb['source'], vb['source_kind'], sorted(vb['source_pads'])) == ('J1', 'usb', ['A9', 'B9'])
    sinks = {s['ref']: s for s in v3['sinks']}
    assert set(sinks) == {'U1', 'U3'} and sinks['U1']['pads'] == ['1'] and sinks['U3']['pads'] == ['3']
    assert sum(s['current'] for s in v3['sinks']) == pytest.approx(0.5)
    assert sinks['U1']['current'] > 10 * sinks['U3']['current']        # the radio module draws most
    assert [s['ref'] for s in vb['sinks']] == ['U2'] and vb['load'] == pytest.approx(0.5)
    g = pm['regulators'][0]
    assert (g['ref'], g['in_net'], g['out_net'], g['vin'], g['vout'], g['iout']) == ('U2', 'VBUS', '+3V3', 5, 3.3, 0.5)
    # heat from the average: (5 − 3.3) V × 0.12 A; tracks and the budget use the 0.5 A peak
    assert pm['dissipation']['U2']['power'] == pytest.approx(1.7 * 0.12)
    assert pm['dissipation']['U2']['assumed'] is False
    assert 'average' in pm['dissipation']['U2']['how']


def test_heat_uses_the_peak_when_no_average_is_given(c3):
    for n in ('+3V3', 'VBUS'):
        c3['nets'][n].pop('average', None)
    from hardhub.review import power
    pm = power.power_model(c3)
    # (5 − 3.3) V × 0.5 A
    assert pm['dissipation']['U2']['power'] == pytest.approx(0.85)


def test_switcher_input_current_and_pass_through():
    parts, comps, nets = supply(12, 0.5, 'VIN')
    parts.update(BUCK=P('U', 'buck', 'Step-down converter 3 A', 'Package_TO_SOT_SMD:SOT-23-6', mpn='TPS563200DDCR'),
                 L=P('L', '4.7uH', 'Inductor 4.7uH 3A', 'Inductor_SMD:L_1210_3225Metric'),
                 FB=P('FB', '600R', 'Ferrite bead 600R@100MHz', 'Inductor_SMD:L_0603_1608Metric'),
                 MCU=P('U', 'STM32', 'STM32 microcontroller', 'Package_QFP:LQFP-48', mpn='STM32F103C8T6'))
    comps += [('U1', 'BUCK', {'1': 'GND', '2': 'SW', '3': 'VIN', '4': 'FBK', '5': 'EN', '6': 'VBST'}),
              ('L1', 'L', {'1': 'SW', '2': '+3V3'}),
              ('FB1', 'FB', {'1': '+3V3', '2': '+3V3A'}),
              ('U2', 'MCU', {'1': '+3V3A', '2': 'GND'})]
    nets.update({'+3V3': dict(kind='power', voltage=3.3, current=1.0), '+3V3A': dict(kind='power', voltage=3.3, current=1.0)})
    pm = power.power_model(design(parts, comps, nets))
    g = pm['regulators'][0]
    assert (g['kind'], g['in_net'], g['out_net']) == ('buck', 'VIN', '+3V3')
    a = pm['nets']['+3V3A']
    assert (a['source'], a['source_kind'], a['from_net']) == ('FB1', 'link', '+3V3')
    # 3.3 V × 1 A / (90 % × 12 V)
    assert g['iin'] == pytest.approx(3.3 * 1.0 / (0.9 * 12))
    assert pm['dissipation']['U1']['power'] == pytest.approx(3.3 * (1 / 0.9 - 1))


def test_a_ferrite_wired_either_way_round_passes_power_downstream(c3):
    """Pin order means nothing for a ferrite: power flows from the side with a
    source (the USB socket) to the other, however its pads were numbered."""
    c3['parts']['FB'] = P('FB', '600R', 'Ferrite bead 600R@100MHz 1A', 'Inductor_SMD:L_0603_1608Metric')
    c3['nets']['VIN'] = dict(kind='power', voltage=5, current=0.5)
    for comp in c3['components']:
        if comp['ref'] == 'U2':
            comp['pins']['3'] = 'VIN'                    # the LDO now takes its input after the ferrite
    for pins in ({'1': 'VIN', '2': 'VBUS'}, {'1': 'VBUS', '2': 'VIN'}):
        d = copy.deepcopy(c3)
        d['components'].append(dict(ref='FB1', part='FB', block=d['components'][0]['block'], pins=dict(pins)))
        pm = power.power_model(d)
        v, b = pm['nets']['VIN'], pm['nets']['VBUS']
        assert (v['source'], v['from_net']) == ('FB1', 'VBUS'), pins
        assert b['source'] == 'J1', pins
        res, _, _ = run_checks(d)
        assert res['input-protection']['status'] != 'na', pins


def test_supplies_with_no_stated_current_do_not_break_the_power_model(c3):
    for n in ('+3V3', 'VBUS'):
        c3['nets'][n].pop('current', None)
        c3['nets'][n].pop('average', None)
    pm = power.power_model(c3)
    assert all((s.get('current') or 0) >= 0 for n in pm['nets'].values() for s in n['sinks'])
    res, _, _ = run_checks(c3)
    assert res['power-budget']['status'] in ('pass', 'warn', 'skip', 'na')


# ------------------------------------------------------------------ the fixture, design-level

EXPECTED = {
    'power-budget': 'pass', 'regulator-headroom': 'pass', 'regulator-input': 'pass', 'decoupling': 'pass',
    'bulk-caps': 'pass', 'input-protection': 'warn', 'usb-c-cc': 'pass', 'heat-parts-cold': 'pass',
    'stress-cap-voltage': 'pass', 'stress-cap-dcbias': 'warn', 'stress-ic-voltage': 'pass',
    'stress-connector-current': 'pass', 'i2c-pullups': 'pass', 'floating-inputs': 'pass', 'stock-qty': 'skip',
    'extended-parts': 'pass', 'datasheets': 'warn', 'ratings-known': 'warn', 'polarity-marks': 'warn',
    'two-sided': 'pass', 'board-size': 'pass', 'stackup': 'pass',
}


def test_fixture_results(c3):
    res, rep, pm = run_checks(c3)
    assert set(res) == set(electrical.IDS)
    assert {k: r['status'] for k, r in res.items()} == EXPECTED
    for r in res.values():                          # every result is a catalogue entry, with its words
        assert r['group'] == catalog.entry(r['id'])['group'] and r['plain'] and r['how']
        if r['status'] in ('fail', 'warn'):
            assert r.get('fix'), r['id']
    # the 22 µF 6.3 V X5R 0603 on 3.3 V is the one that loses most
    assert 'C2' in res['stress-cap-dcbias']['detail'] and '22 µF' in res['stress-cap-dcbias']['detail']
    assert 'C3' not in res['stress-cap-dcbias']['detail']
    tree = {t['net']: t for t in rep['tree']}
    assert tree['+3V3'] == dict(net='+3V3', voltage=3.3, source='U2', source_kind='regulator', load=0.5, capacity=1.0,
                                pct=50.0, assumed=False, **{'from': 'VBUS'})
    assert any(s['ref'] == 'C2' and s['what'] == 'voltage' and s['rating'] == 6.3 for s in rep['stress'])
    json.dumps(rep)                                 # the report is plain JSON


def test_cold_day_finds_commercial_parts(c3):
    res, _, _ = run_checks(c3, env=dict(ambient_min=-30))
    # the tactile switch is only assumed to be a -20 °C part: a warning, not a failure
    assert res['heat-parts-cold']['status'] == 'warn' and 'SW1' in res['heat-parts-cold']['detail']
    c3['parts']['BUTTON']['ratings'] = dict(temp_min=-20)          # now from its datasheet: a failure
    res, _, _ = run_checks(c3, env=dict(ambient_min=-30))
    assert res['heat-parts-cold']['status'] == 'fail'


# ------------------------------------------------------------------ broken designs that must be caught

def test_low_voltage_cap_on_12v_fails():
    parts, comps, nets = supply(12)
    parts['C'] = P('C', '10uF', 'Capacitor 10uF 6.3V X5R 0805', 'Capacitor_SMD:C_0805_2012Metric')
    comps.append(('C1', 'C', {'1': 'VIN', '2': 'GND'}))
    res, rep, _ = run_checks(design(parts, comps, nets))
    r = res['stress-cap-voltage']
    assert r['status'] == 'fail' and 'C1' in r['detail'] and r['measured']['value'] > 100 and r['fix']
    parts['C'] = P('C', '10uF', 'Capacitor 10uF 25V X5R 0805', 'Capacitor_SMD:C_0805_2012Metric')
    assert run_checks(design(parts, comps, nets))[0]['stress-cap-voltage']['status'] == 'pass'
    # with no voltage in its text the rating is assumed (6.3 V): a warning, not a failure
    parts['C'] = P('C', '10uF', 'Capacitor 10uF X5R 0805', 'Capacitor_SMD:C_0805_2012Metric')
    assert run_checks(design(parts, comps, nets))[0]['stress-cap-voltage']['status'] == 'warn'


def test_usb_c_without_cc_resistors_fails(c3):
    c3['components'] = [c for c in c3['components'] if c['ref'] not in ('R1', 'R2')]
    r = run_checks(c3)[0]['usb-c-cc']
    assert r['status'] == 'fail' and '5.1 kΩ' in r['fix']
    # CC1 and CC2 joined on one resistor is just as bad
    d = copy.deepcopy(c3)
    for c in d['components']:
        if c['ref'] == 'J1':
            c['pins']['B5'] = 'CC1'
    d['components'].append(dict(ref='R1', part='R5K1', block='power', pins={'1': 'CC1', '2': 'GND'}))
    assert run_checks(d)[0]['usb-c-cc']['status'] == 'fail'


def test_chip_without_decoupling(c3):
    # only the regulator's big capacitors left on 3.3 V: a warning
    c3['components'] = [c for c in c3['components'] if c['ref'] not in ('C3', 'C6')]
    r = run_checks(c3)[0]['decoupling']
    assert r['status'] == 'warn' and 'U1' in r['detail'] and '100 nF' in r['fix']
    # nothing at all: a failure
    c3['components'] = [c for c in c3['components'] if c['ref'] not in ('C2', 'C4')]
    r = run_checks(c3)[0]['decoupling']
    assert r['status'] == 'fail' and r['measured']['value'] == 2
    assert run_checks(c3)[0]['bulk-caps']['status'] == 'fail'           # and the LDO has no output capacitor


def test_ldo_without_headroom_fails(c3):
    c3['nets']['VBUS']['voltage'] = 3.3              # an LDO fed 3.3 V to make 3.3 V
    r = run_checks(c3)[0]['regulator-headroom']
    assert r['status'] == 'fail' and 'U2' in r['detail'] and r['measured']['value'] < 0


def test_overloaded_ldo_fails(c3):
    c3['nets']['+3V3'].update(current=2.0, average=2.0)
    c3['nets']['VBUS'].update(current=2.0, average=2.0)
    res, rep, pm = run_checks(c3)
    assert res['power-budget']['status'] == 'fail' and 'U2' in res['power-budget']['detail']
    assert res['power-budget']['measured']['value'] == pytest.approx(200)
    assert pm['dissipation']['U2']['power'] == pytest.approx(1.7 * 2.0)


def test_regulator_input_over_its_rating_fails():
    parts, comps, nets = supply(12)
    parts['LDO'] = P('U', 'AP2112K-3.3', 'LDO 3.3 V 600 mA', 'Package_TO_SOT_SMD:SOT-23-5', mpn='AP2112K-3.3TRG1')
    comps.append(('U1', 'LDO', {'1': 'VIN', '2': 'GND', '3': 'VIN', '5': '+3V3'}))
    nets['+3V3'] = dict(kind='power', voltage=3.3, current=0.1)
    r = run_checks(design(parts, comps, nets))[0]['regulator-input']
    assert r['status'] == 'fail' and '6 V' in r['detail']


def test_i2c_without_pullups_fails(c3):
    c3['components'] = [c for c in c3['components'] if c['ref'] not in ('R6', 'R7')]
    r = run_checks(c3)[0]['i2c-pullups']
    assert r['status'] == 'fail' and 'SDA' in r['detail'] and 'SCL' in r['detail']


def test_strong_i2c_pullups_warn(c3):
    for c in c3['components']:
        if c['ref'] in ('R6', 'R7'):
            c['part'] = 'R1K'                        # 1 kΩ from 3.3 V: 3.3 mA, over I2C's 3 mA
    assert run_checks(c3)[0]['i2c-pullups']['status'] == 'warn'


def test_floating_enable_warns(c3):
    c3['components'] = [c for c in c3['components'] if c['ref'] != 'R3']
    r = run_checks(c3)[0]['floating-inputs']
    assert r['status'] == 'warn' and 'EN' in r['detail']


def test_checks_that_do_not_apply_say_na():
    parts, comps, nets = supply(5)
    parts['R'] = P('R', '10k', 'Resistor 10k 1% 0402', 'Resistor_SMD:R_0402_1005Metric')
    comps.append(('R1', 'R', {'1': 'VIN', '2': 'GND'}))
    res = run_checks(design(parts, comps, nets))[0]
    for i in ('regulator-headroom', 'regulator-input', 'bulk-caps', 'usb-c-cc', 'i2c-pullups', 'floating-inputs',
              'decoupling', 'stress-ic-voltage'):
        assert res[i]['status'] == 'na', i
    assert res['input-protection']['status'] == 'warn'            # a DC jack straight in
    assert 'reversed plug' in res['input-protection']['fix']


def test_board_size_and_stackup(c3):
    c3['board'].update(width=8, height=8)
    assert run_checks(c3)[0]['board-size']['status'] == 'fail'     # under 10 x 10 mm cannot be assembled
    c3['board'].update(width=50, height=40, layers=8, thickness=1.0)
    st = run_checks(c3)[0]['stackup']
    assert st['status'] == 'warn' and '8 copper layers' in st['detail']


def test_where_comes_from_placement(c3):
    c3['components'] = [c for c in c3['components'] if c['ref'] not in ('C3', 'C6', 'C2', 'C4')]
    r = run_checks(c3)[0]['decoupling']
    assert r['where'] == [dict(x=0.0, y=-1.4, refs=['U1'], note='needs a decoupling capacitor')]


def test_without_ngspice_the_simulations_skip(c3, tmp_path, monkeypatch):
    monkeypatch.setattr(spice.shutil, 'which', lambda name: None)
    res, rep, op, _ = run_spice(c3, tmp_path)
    assert op is None and set(res) == set(spice.IDS)
    assert all(r['status'] == 'skip' and 'ngspice is not installed' in r['detail'] for r in res.values())
    assert 'sim-power' not in res


# ------------------------------------------------------------------ ngspice

def divider(r_top='1k', r_bottom='1k', desc='Resistor {} 1% 0402'):
    parts, comps, nets = supply(3.3, 0.01, '+3V3')
    parts.update(RT=P('R', r_top, desc.format(r_top), 'Resistor_SMD:R_0402_1005Metric'),
                 RB=P('R', r_bottom, desc.format(r_bottom), 'Resistor_SMD:R_0402_1005Metric'),
                 ADC=P('U', 'ADC', 'ADC 12-bit, I2C', 'Package_TO_SOT_SMD:SOT-23-6'))
    comps += [('R1', 'RT', {'1': '+3V3', '2': 'MID'}), ('R2', 'RB', {'1': 'MID', '2': 'GND'}),
              ('U1', 'ADC', {'1': '+3V3', '2': 'GND', '3': 'MID'})]
    return design(parts, comps, nets)


@spice_only
def test_divider_operating_point_is_physics(tmp_path):
    d = divider()
    b = power.Board(d)
    pm = power.power_model(d)
    op, runs, skipped, nodes = spice.operating_point(b, pm, power.environment(d), str(tmp_path))
    assert not skipped
    mid = nodes['MID']
    idle = runs[('idle', 25.0)]
    assert idle['v(%s)' % mid] == pytest.approx(1.65, abs=1e-4)
    # chips idle: 1.65 V across each 1 kΩ, 1.65 mA, 2.72 mW each (V² / R)
    assert op['R1']['voltage'] >= 1.65 - 1e-4
    # worst case: the ADC pin driven low through its 25 Ω, at 0 °C (1 kΩ − 100 ppm/°C × 25 °C = 997.5 Ω):
    # the midpoint then sits on 25 Ω ∥ R2 (24.39 Ω), so R1 carries 3.3 V × 997.5 / 1021.9: about 10.4 mW
    r_cold = 1000 * (1 - 100e-6 * 25)
    low = 25 * r_cold / (25 + r_cold)
    assert op['R1']['power'] == pytest.approx((3.3 * r_cold / (r_cold + low)) ** 2 / r_cold, rel=1e-4)
    assert (op['R1']['scenario'], op['R1']['temp']) == ('low', 0.0)
    p_idle = (idle['v(%s)' % nodes['+3V3']] - idle['v(%s)' % mid]) ** 2 / 1000
    assert p_idle == pytest.approx(2.7225e-3, rel=1e-3)
    # the netlists are kept for inspection
    for sc in ('idle', 'low', 'high'):
        text = open(os.path.join(tmp_path, 'op-%s.cir' % sc)).read()
        assert 'R_R1 ' in text and 'tc1=0.0001' in text and '.control' in text
    assert 'R_drv_U1_3' in open(os.path.join(tmp_path, 'op-low.cir')).read()


@spice_only
def test_divider_tolerance_corners(tmp_path):
    res = run_spice(divider(), tmp_path)[0]
    r = res['stress-tolerance']
    # ±1 % parts with ±100 ppm/°C over 0..50 °C: about ±1.25 %
    assert r['status'] == 'pass' and 1.0 < r['measured']['value'] < 1.5
    res = run_spice(divider(desc='Resistor {} 5% 0402'), tmp_path / 'b')[0]
    assert res['stress-tolerance']['status'] == 'warn' and res['stress-tolerance']['measured']['value'] > 5


@spice_only
def test_resistor_overloaded_fails(tmp_path):
    parts, comps, nets = supply(5, 0.1, 'V5')
    parts['R'] = P('R', '100', 'Resistor 100R 1% 0402', 'Resistor_SMD:R_0402_1005Metric')
    comps.append(('R1', 'R', {'1': 'V5', '2': 'GND'}))
    res, rep, op, pm = run_spice(design(parts, comps, nets), tmp_path)
    r = res['stress-resistor-power']
    assert r['status'] == 'fail' and 'R1' in r['detail']
    assert op['R1']['power'] == pytest.approx(0.25, rel=0.01)             # 5² / 100
    assert pm['dissipation']['R1']['power'] == pytest.approx(0.25, rel=0.01)
    assert any(s['ref'] == 'R1' and s['what'] == 'power' for s in rep['stress'])


@spice_only
def test_led_with_tiny_resistor_fails(tmp_path):
    parts, comps, nets = supply(5, 0.1, 'V5')
    parts.update(R=P('R', '10', 'Resistor 10R 1% 0603', 'Resistor_SMD:R_0603_1608Metric'),
                 LED=P('LED', 'red', 'LED red 0603', 'LED_SMD:LED_0603_1608Metric'))
    comps += [('R1', 'R', {'1': 'V5', '2': 'LED_A'}), ('D1', 'LED', {'1': 'GND', '2': 'LED_A'})]
    res, rep, op, _ = run_spice(design(parts, comps, nets), tmp_path)
    assert res['stress-led-current']['status'] == 'fail'
    # (5 V − about 2.1 V) / (10 Ω + the LED's own 2 Ω): about 0.24 A
    assert 0.15 < op['D1']['current'] < 0.3
    # a proper 1.5 kΩ: about 2 mA, fine
    parts['R'] = P('R', '1.5k', 'Resistor 1.5k 1% 0603', 'Resistor_SMD:R_0603_1608Metric')
    res, rep, op, _ = run_spice(design(parts, comps, nets), tmp_path / 'b')
    assert res['stress-led-current']['status'] == 'pass'
    assert op['D1']['current'] == pytest.approx((5 - 1.95) / 1500, rel=0.1)


@spice_only
def test_fixture_simulations(c3, tmp_path):
    res, rep, op, pm = run_spice(c3, tmp_path)
    assert set(res) == set(spice.IDS) and 'sim-power' not in res
    assert res['stress-resistor-power']['status'] == 'pass'
    assert res['stress-led-current']['status'] == 'pass'
    assert res['stress-tolerance']['status'] == 'na'
    assert res['load-step']['status'] == 'pass'
    assert res['pdn']['status'] in ('pass', 'warn')                     # the LDO model's hand-over peak is close
    assert rep['ngspice'].startswith('ngspice-') and res['pdn']['tool'].startswith('ngspice ')
    # the LED: green (3.0 V class) from a 3.3 V pin through 1 kΩ: well under a milliamp
    assert 0.1e-3 < op['D1']['current'] < 1e-3
    # I2C pull-up with the line held low: 3.3² / 4.7 kΩ
    assert op['R6']['power'] == pytest.approx(3.3 ** 2 / 4700, rel=0.02)
    (z,) = rep['pdn']
    assert z['net'] == '+3V3' and len(z['f']) == len(z['z']) == 61 and z['f'][0] == pytest.approx(1e3)
    assert z['target_ohm'] == pytest.approx(3.3 * 0.05 / (0.5 * 0.5))
    assert set(z['caps']) == {'C2', 'C3', 'C4', 'C6'}
    (s,) = rep['step']
    assert len(s['t_us']) == len(s['v']) == 200 and s['nominal'] == 3.3 and 3.1 < s['min_v'] < 3.3
    for name in ('op-idle.cir', 'op-low.cir', 'op-high.cir', 'pdn-_3V3.cir', 'step-_3V3.cir'):
        assert os.path.exists(os.path.join(tmp_path, name)), name
    # the electrical checks take the simulation's capacitor voltages and the resistor heat
    res2, rep2 = electrical.checks(c3, None, pm, op)
    assert by_id(res2)['stress-cap-voltage']['status'] == 'pass'
    assert pm['dissipation']['R6']['power'] == pytest.approx(op['R6']['power'])


@spice_only
def test_rail_without_capacitors_rings(tmp_path):
    parts, comps, nets = supply(5, 0.5, 'VBUS')
    parts.update(LDO=dict(c3_ams()), MCU=P('MOD', 'ESP32', 'Wi-Fi module', 'RF_Module:ESP32-C3-WROOM-02',
                                            mpn='ESP32-C3-WROOM-02-N4'))
    comps += [('U1', 'LDO', {'1': 'GND', '2': '+3V3', '3': 'VBUS'}), ('U2', 'MCU', {'1': '+3V3', '9': 'GND'})]
    nets['+3V3'] = dict(kind='power', voltage=3.3, current=0.5)
    res, rep, op, _ = run_spice(design(parts, comps, nets), tmp_path)
    assert res['pdn']['status'] == 'warn' and res['load-step']['status'] == 'warn'
    assert rep['step'][0]['min_v'] < 3.3 * 0.95


def c3_ams():
    return P('U', 'AMS1117-3.3', 'LDO 3.3 V 1 A, SOT-223', 'Package_TO_SOT_SMD:SOT-223-3_TabPin2', mpn='AMS1117-3.3')


@spice_only
def test_filtered_supply_pin_is_not_driven(tmp_path):
    """A chip's analogue supply fed from 3.3 V through 10 Ω (the net named as a signal) is its power input:
    the driven scenarios must not short it through the filter resistor."""
    parts, comps, nets = supply(3.3, 0.05, '+3V3')
    parts.update(R=P('R', '10', 'Resistor 10R 1% 0402', 'Resistor_SMD:R_0402_1005Metric'),
                 C=P('C', '1uF', 'Capacitor 1uF 16V X7R 0402', 'Capacitor_SMD:C_0402_1005Metric'),
                 ADC=P('U', 'ADC', 'ADC 12-bit, I2C', 'Package_TO_SOT_SMD:SOT-23-6'))
    comps += [('R1', 'R', {'1': '+3V3', '2': 'AFILT'}), ('C1', 'C', {'1': 'AFILT', '2': 'GND'}),
              ('U1', 'ADC', {'1': '+3V3', '2': 'GND', '3': 'AFILT'})]
    res, rep, op, _ = run_spice(design(parts, comps, nets), tmp_path)
    assert res['stress-resistor-power']['status'] == 'pass' and op['R1']['power'] < 1e-6
    assert 'R_drv_U1_3' not in open(os.path.join(tmp_path, 'op-low.cir')).read()
