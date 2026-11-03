"""The board tests (hardhub.review) on a real KiCad build: the ESP32-C3 sensor
board must come out clean where it is clean and caught where it is not; then
the same board broken on purpose, one flaw at a time, must be caught by the
test that owns the flaw, at the place it was made."""
import copy
import io
import json
import math

import pytest

from conftest import fixture, kicad

pytestmark = kicad


@pytest.fixture(scope='module')
def built(tmp_path_factory):
    from hardhub import pipeline
    out = tmp_path_factory.mktemp('review')
    lines = []
    final = pipeline.build(fixture('esp32c3-sensor.json'), str(out / 'work'), str(out / 'files'), lines.append,
                           job='r', outputs=('svg',))
    assert final['checks'], final.get('error')
    return out / 'files', final, lines


def by_id(final):
    return {c['id']: c for c in final['checks']}


def art(final, suffix):
    return next(a for a in final['artifacts'] if a['name'].endswith(suffix))


def test_every_planned_test_reports(built):
    """The live plan comes first, then one result per test; every planned test
    ends with a result, and none is left 'skip' for want of a tool."""
    from hardhub.review import catalog
    files, final, lines = built
    test_lines = [x for x in lines if x.get('step') == 'test']
    plan = next(x['plan'] for x in test_lines if x.get('plan'))
    streamed = [x['result']['id'] for x in test_lines if x.get('result')]
    assert len(plan) > 60
    got = by_id(final)
    missing = [p['id'] for p in plan if p['id'] not in got]
    assert not missing, missing
    assert set(p['id'] for p in plan) <= set(streamed)
    # 'not run' only for want of data in the design (no stock looked up), never a tool that failed
    skipped = {i: c['detail'] for i, c in got.items() if c['status'] == 'skip' and 'could not run' in c['detail']}
    assert not skipped, skipped
    assert {i for i, c in got.items() if c['status'] == 'skip'} <= {'stock-qty'}
    for c in final['checks']:
        assert c['group'] in dict(catalog.AREAS), c
        assert c.get('plain') and c.get('how'), c['id']
        if c['status'] in ('fail', 'warn'):
            assert c.get('detail'), c['id']


def test_the_clean_board_is_clean(built):
    files, final, _ = built
    c = by_id(final)
    for i in ('shorts', 'routed', 'nets-match', 'drc-errors', 'track-min', 'clearance-min', 'edge-clearance',
              'via-size', 'drill-min', 'annular-ring', 'hole-to-hole', 'courtyard', 'usb-c-cc',
              'i2c-pullups', 'heat-board', 'heat-junction', 'track-heating'):
        assert c[i]['status'] == 'pass', (i, c[i].get('detail'))
    # the router draws +3V3 at the width its 0.5 A needs and no wider: a few
    # percent lost on the way to the module at the peak, worth a look, not a failure
    vd = c['voltage-drop']
    assert vd['status'] in ('pass', 'warn') and vd['measured']['value'] < 5, vd
    # the measured numbers are HardHub's own drawing rules, inside the fab's
    assert c['track-min']['measured']['value'] >= 0.127 - 1e-6           # necks into small pads, at the fab's floor
    assert c['clearance-min']['measured']['value'] >= 0.15 - 0.01
    assert c['via-size']['measured']['value'] == pytest.approx(0.6, abs=0.01)
    # not applicable here, and said so
    for i in ('usb-pair', 'creepage', 'crystal-near'):
        assert c[i]['status'] == 'na', (i, c[i])


def test_the_regulator_heat_is_physical(built):
    """AMS1117: (5 - 3.3) V x 0.12 A average = 0.2 W in a SOT-223 on a small
    two-layer board (with the module's own 0.4 W nearby). It should sit some
    degrees above a 50 °C day, never below the air and never absurdly hot."""
    files, final, _ = built
    rep = json.loads((files / art(final, '-tests.json')['name']).read_text())
    assert rep['ambient'] == dict(min=0, max=50, points=[0, 25, 50])
    th = rep['thermal']
    u2 = next(p for p in th['parts'] if p['ref'] == 'U2')
    assert u2['power'] == pytest.approx(1.7 * 0.12, rel=0.05)
    hot = u2['temps'][-1]
    assert hot['ambient'] == 50
    assert 52 < hot['board'] < 90, hot
    assert hot['junction'] > hot['board']
    # 25 °C cooler outside: about 25 °C cooler on the board (h depends a little on temperature)
    mid = next(t for t in u2['temps'] if t['ambient'] == 25)
    assert hot['board'] - mid['board'] == pytest.approx(25, abs=6)
    assert th['grid']['nx'] * th['grid']['ny'] > 1000
    assert rep['board']['layers'] == 2 and any(s['kind'] == 'dielectric' for s in rep['board']['stackup'])
    md = (files / art(final, '-tests.md')['name']).read_text()
    assert '# Board tests' in md and '## Passed' in md


def edit(built, edits, tmp_path, design=None):
    from hardhub import pipeline
    files, final, _ = built
    zp = (files / art(final, '-kicad.zip')['name']).read_bytes()
    return pipeline.edit(design or fixture('esp32c3-sensor.json'), io.BytesIO(zp), edits, str(tmp_path / 'work'),
                         str(tmp_path / 'files'), lambda x: None, job='e', outputs=('svg',))


def geometry(built):
    files, final, _ = built
    return json.loads((files / art(final, '-board.json')['name']).read_text())


def test_flaws_drawn_by_hand_are_caught_where_they_are(built, tmp_path):
    """Three flaws in one edit: a track 0.05 mm from another net, a 0.1 mm track
    (under the fab's 0.127), and a loose L of track with a right-angle corner."""
    g = geometry(built)
    ox, oy = g['size'][0] / 2, g['size'][1] / 2                   # client frame -> design frame
    other = max((t for t in g['tracks'] if t['layer'] == 'F.Cu' and t['net'] not in ('GND',)),
                key=lambda t: math.dist(t['a'], t['b']))
    net = next(t['net'] for t in g['tracks'] if t['net'] not in ('GND', other['net']))
    (ax, ay), (bx, by) = other['a'], other['b']
    L = math.dist(other['a'], other['b'])
    dx, dy = (bx - ax) / L, (by - ay) / L
    gap = other['width'] / 2 + 0.15 / 2 + 0.05
    p = [(ax + bx) / 2 - dy * gap, (ay + by) / 2 + dx * gap]
    q = [p[0] + dx * min(1.0, L / 3), p[1] + dy * min(1.0, L / 3)]
    # a free L in an empty spot of the bottom layer: find room away from copper
    corner = [g['size'][0] * 0.5, g['size'][1] * 0.5]
    res = edit(built, [
        dict(op='add_track', layer='F.Cu', a=p, b=q, width=0.15, net=net),
        dict(op='add_track', layer='B.Cu', a=[corner[0] - 2, corner[1]], b=corner, width=0.1, net=net),
        dict(op='add_track', layer='B.Cu', a=corner, b=[corner[0], corner[1] - 2], width=0.1, net=net),
    ], tmp_path)
    assert not res.get('rejected'), res.get('error')
    c = by_id(res)
    cm = c['clearance-min']
    assert cm['status'] == 'fail' and cm['measured']['value'] < 0.1
    near = min(math.dist((w['x'], w['y']), (p[0] - ox, p[1] - oy)) for w in cm['where'])
    assert near < 1.5, cm['where']
    tm = c['track-min']
    assert tm['status'] == 'fail' and tm['measured']['value'] == pytest.approx(0.1, abs=0.005)
    assert c['corners-45']['status'] == 'warn'
    assert any(math.dist((w['x'], w['y']), (corner[0] - ox, corner[1] - oy)) < 0.3 for w in c['corners-45']['where'])
    assert c['dangling']['status'] == 'warn'
    assert c['drc-errors']['status'] == 'fail'


def test_a_hot_day_and_a_heavy_load_overheat_the_regulator(built, tmp_path):
    """The same board asked to give 1 A on a 70 °C day: the linear regulator
    makes 1.7 W, its silicon goes past 125 °C, and the tests say so and why."""
    from hardhub import pipeline
    files, final, _ = built
    d = copy.deepcopy(fixture('esp32c3-sensor.json'))
    d['nets']['+3V3'].update(current=1.0, average=1.0)
    d['nets']['VBUS'].update(current=1.0, average=1.0)
    zp = (files / art(final, '-kicad.zip')['name']).read_bytes()
    lines = []
    res = pipeline.test(d, io.BytesIO(zp), str(tmp_path / 'work'), str(tmp_path / 'files'), lines.append, job='t',
                        options=dict(ambient_min=-10, ambient_max=70))
    c = by_id(res)
    hj = c['heat-junction']
    assert hj['status'] == 'fail' and 'U2' in hj['detail'] and hj['measured']['value'] > 125, hj
    assert hj.get('fix')
    rep = json.loads((tmp_path / 'files' / art(res, '-tests.json')['name']).read_text())
    assert rep['ambient']['max'] == 70 and rep['ambient']['points'] == [-10, 25, 70]
    # nothing was rebuilt: the test run's own steps only
    assert {x['step'] for x in lines if 'step' in x} <= {'validate', 'verify', 'test'}
