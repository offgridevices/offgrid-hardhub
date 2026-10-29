"""Hand edits to a routed board, and the board as geometry for the client that
makes them: the ESP32-C3 fixture built once, then edited many ways."""
import copy
import io
import json
import math
import os
import re
import zipfile

import pytest

from conftest import fixture, kicad

pytestmark = kicad


@pytest.fixture(scope='module')
def built(tmp_path_factory):
    """The fixture board, built with SVGs and a STEP model (for the order package)."""
    from hardhub import pipeline
    out = tmp_path_factory.mktemp('built')
    final = pipeline.build(fixture('esp32c3-sensor.json'), str(out / 'work'), str(out / 'files'), lambda x: None,
                           job='t', outputs=('svg', 'step'))
    assert final['ok'], final.get('error')
    return out / 'files', final


def art(final, kind, suffix=''):
    return next(a for a in final['artifacts'] if a['kind'] == kind and a['name'].endswith(suffix))


def geometry_of(files, final):
    return json.loads((files / art(final, 'board-json')['name']).read_text())


def edit(built, edits, tmp_path, design=None):
    from hardhub import pipeline
    files, final = built
    zp = (files / art(final, 'kicad')['name']).read_bytes()
    lines = []
    res = pipeline.edit(design or fixture('esp32c3-sensor.json'), io.BytesIO(zp), edits, str(tmp_path / 'work'),
                        str(tmp_path / 'files'), lines.append, job='e', outputs=('svg',))
    return res, lines


def status(final):
    return {c['id']: c for c in final['checks']}


# ---------------------------------------------------------------- geometry

def test_board_json_is_in_the_svgs_frame(built):
    """board.json's frame is the SVG crop: same size, and every via, track end
    and mounting hole sits where the SVGs draw it."""
    from hardhub import pipeline
    files, final = built
    g = geometry_of(files, final)
    # the shape packages/protocol/src/board.ts gives it
    assert set(g) == {'units', 'origin', 'size', 'layers', 'tracks', 'vias', 'footprints', 'zones', 'rules'}
    assert all(set(t) <= {'id', 'layer', 'net', 'width', 'a', 'b', 'mid'} for t in g['tracks'])
    assert all(set(v) == {'id', 'x', 'y', 'd', 'drill', 'net', 'from', 'to'} for v in g['vias'])
    assert all(set(f) == {'ref', 'x', 'y', 'rot', 'side', 'locked', 'bbox', 'pads'} for f in g['footprints'])
    assert all(set(p) == {'num', 'net', 'x', 'y', 'w', 'h', 'rot', 'shape', 'through'} for f in g['footprints'] for p in f['pads'])
    assert g['units'] == 'mm' and g['layers'] == ['F.Cu', 'B.Cu']
    # the fixture is a 50 x 40 mm board centred at KiCad's (100, 100)
    assert g['origin'] == [75.0, 80.0]
    for a in final['artifacts']:
        if a['kind'] == 'board-svg':
            head = (files / a['name']).read_text()[:1000]
            w, h = re.search(r'viewBox="0\.0000 0\.0000 ([\d.]+) ([\d.]+)"', head).groups()
            assert g['size'] == [float(w), float(h)], a['name']
    svg = {l: (files / art(final, 'board-svg', '-%s.svg' % l)['name']).read_text() for l in ('F_Cu', 'B_Cu', 'Edge_Cuts')}
    circles = {l: {(float(x), float(y), float(r)) for x, y, r in re.findall(r'<circle cx="([-\d.]+)" cy="([-\d.]+)" r="([\d.]+)"', s)}
               for l, s in svg.items()}
    near = lambda pts, x, y, r=None: any(abs(px - x) < 2e-3 and abs(py - y) < 2e-3 and (r is None or abs(pr - r) < 2e-3)
                                          for px, py, pr in pts)
    assert g['vias'] and all(near(circles['F_Cu'], v['x'], v['y'], v['d'] / 2) for v in g['vias'])
    # every track end is where a path in its layer's SVG starts or ends
    for t in g['tracks'][:40]:
        s = svg[t['layer'].replace('.', '_')]
        for x, y in (t['a'], t['b']):
            assert re.search(r'[ML]%.4f %.4f\b' % (x, y), s), (t, x, y)
    # the board outline starts at the frame's corner and fills the crop
    xs = [float(x) for x, _ in re.findall(r'([-\d.]+) ([-\d.]+)', ' '.join(re.findall(r'<path d="([^"]+)"', svg['Edge_Cuts'])))]
    assert min(xs) == 0 and abs(max(xs) - 50) < 1e-6
    holes = [f for f in g['footprints'] if f['ref'].startswith('MH')]
    assert len(holes) == 4 and all(near(circles['Edge_Cuts'], f['x'], f['y']) for f in holes)
    # parts, pads and the rules a new track starts from
    u1 = next(f for f in g['footprints'] if f['ref'] == 'U1')
    assert u1['side'] == 'top' and len(u1['pads']) > 10 and all(p['shape'] for p in u1['pads'])
    bx0, by0, bx1, by1 = u1['bbox']
    assert all(bx0 - 1e-3 <= p['x'] <= bx1 + 1e-3 and by0 - 1e-3 <= p['y'] <= by1 + 1e-3 for p in u1['pads'])
    assert g['rules'] == dict(track_min=0.127, clearance=0.15, via_d=0.6, via_drill=0.3)
    # the ground pours, simplified
    gnd = [z for z in g['zones'] if z['net'] == 'GND']
    assert {z['layer'] for z in gnd} == {'F.Cu', 'B.Cu'}
    assert all(3 <= len(r) <= 300 for z in gnd for r in z['polygons'])
    assert pipeline.EDIT_STEPS[-1] == 'render'


def test_order_package(built):
    files, final = built
    pk = art(final, 'package')
    assert pk['name'] == 'c3-sensor-package.zip'
    z = zipfile.ZipFile(files / pk['name'])
    assert sorted(z.namelist()) == sorted([
        'README.txt', 'board/c3-sensor-gerbers.zip',
        'assembly/jlcpcb/c3-sensor-bom-jlcpcb.csv', 'assembly/jlcpcb/c3-sensor-cpl-jlcpcb.csv',
        'assembly/pcbway/c3-sensor-bom-pcbway.csv', 'assembly/pcbway/c3-sensor-cpl-jlcpcb.csv',
        'netlist/c3-sensor.ipc', '3d/c3-sensor-step.zip'])
    # the Gerber zip unchanged, and flat: no folders, no CSVs
    assert z.read('board/c3-sensor-gerbers.zip') == (files / 'c3-sensor-gerbers.zip').read_bytes()
    inner = zipfile.ZipFile(io.BytesIO(z.read('board/c3-sensor-gerbers.zip'))).namelist()
    assert inner and not any('/' in n or n.endswith('.csv') for n in inner)
    readme = z.read('README.txt').decode()
    for want in ('Copper layers:   2', 'Size:            50 x 40 mm', 'Thickness:       1.6 mm', 'Solder mask:     black',
                 'lead-free HASL', 'top side, %d parts' % final['stats']['assembled_parts'], 'AT JLCPCB', 'AT PCBWAY',
                 'board/c3-sensor-gerbers.zip', 'assembly/pcbway/c3-sensor-bom-pcbway.csv'):
        assert want in readme, want


# ---------------------------------------------------------------- edits

def test_each_edit(built, tmp_path):
    files, final = built
    g = geometry_of(files, final)
    signal = [t for t in g['tracks'] if t['net'] not in ('GND',) and t['layer'] == 'F.Cu']
    t = max(signal, key=lambda t: math.dist(t['a'], t['b']))
    gone = next(x for x in g['tracks'] if x['id'] != t['id'])
    via = next(v for v in g['vias'] if v['net'] != 'GND')
    gvia = next(v for v in g['vias'] if v['net'] == 'GND')
    pad = next(p for f in g['footprints'] if f['ref'] == 'R5' for p in f['pads'] if p['net'] == '+3V3')
    r1 = next(f for f in g['footprints'] if f['ref'] == 'R1')
    mid = [(t['a'][0] + t['b'][0]) / 2, (t['a'][1] + t['b'][1]) / 2]
    edits = [
        dict(op='set_track', id=t['id'], a=t['a'], b=mid, width=0.2),
        dict(op='delete', id=gone['id']),
        dict(op='set_via', id=via['id'], x=via['x'] + 0.1, y=via['y']),
        dict(op='add_track', layer='F.Cu', a=[pad['x'], pad['y']], b=[pad['x'], pad['y'] + 0.8]),
        dict(op='add_via', x=gvia['x'] + 1.0, y=gvia['y'], net='GND'),
        dict(op='move_part', ref='R1', x=r1['x'] + 0.5, y=r1['y'], rot=90),
        dict(op='move_part', ref='R2', x=10, y=10, rot=30, side='bottom'),
    ]
    res, lines = edit(built, edits, tmp_path)
    assert not res.get('rejected'), res.get('error')
    assert [l['step'] for l in lines if 'step' in l][0] == 'validate' and lines[-1]['progress'] == 1.0
    assert res['stats']['edits_move_part'] == 2 and res['stats']['edits_add_track'] == 1
    assert res['stats']['edits_delete_track'] == 1 and 'edits_delete' not in res['stats']
    after = json.loads((tmp_path / 'files' / art(res, 'board-json')['name']).read_text())
    tracks = {x['id']: x for x in after['tracks']}
    vias = {v['id']: v for v in after['vias']}
    # ids are KiCad's, kept across the save: the edited track is the same track
    assert math.dist(tracks[t['id']]['b'], mid) < 1e-3 and tracks[t['id']]['width'] == 0.2
    assert gone['id'] not in tracks
    assert abs(vias[via['id']]['x'] - (via['x'] + 0.1)) < 1e-3
    new = [x for i, x in tracks.items() if i not in {y['id'] for y in g['tracks']}]
    assert len(new) == 1 and new[0]['net'] == '+3V3'                      # net from the pad it starts on
    added = [v for i, v in vias.items() if i not in {y['id'] for y in g['vias']}]
    assert len(added) == 1 and added[0]['net'] == 'GND' and added[0]['d'] == 0.6 and added[0]['drill'] == 0.3
    fps = {f['ref']: f for f in after['footprints']}
    assert abs(fps['R1']['x'] - (r1['x'] + 0.5)) < 1e-3 and fps['R1']['rot'] == 90
    assert fps['R2']['side'] == 'bottom' and fps['R2']['rot'] == 30 and [fps['R2']['x'], fps['R2']['y']] == [10, 10]
    assert all(p['x'] != q['x'] or p['y'] != q['y'] for p, q in zip(fps['R1']['pads'], r1['pads']))
    # placement in the design's frame (mm from the board centre), as design.placement takes it
    assert res['placement']['R2'] == dict(x=-15.0, y=-10.0, rot=30, side='bottom')
    assert res['placement']['R1']['rot'] == 90 and set(res['placement']) == {'R1', 'R2'}
    # the checks ran on the edited board: the deleted track left a connection open
    st = status(res)
    assert st['routed']['status'] == 'fail' and not res['ok']
    assert {'gerbers', 'bom', 'cpl', 'kicad', 'board-svg', 'board-json', 'package'} <= {a['kind'] for a in res['artifacts']}


def test_edits_are_kept_by_the_next_edit(built, tmp_path):
    """The edited board's KiCad zip is the next edit's input; a part moved
    back to where it was ends up exactly there again."""
    from hardhub import pipeline
    files, final = built
    g = geometry_of(files, final)
    r1 = next(f for f in g['footprints'] if f['ref'] == 'R1')
    res, _ = edit(built, [dict(op='move_part', ref='R1', x=r1['x'] + 1, y=r1['y'], rot=r1['rot'])], tmp_path / 'one')
    zp = (tmp_path / 'one' / 'files' / art(res, 'kicad')['name']).read_bytes()
    res2 = pipeline.edit(fixture('esp32c3-sensor.json'), io.BytesIO(zp),
                         [dict(op='move_part', ref='R1', x=r1['x'], y=r1['y'], rot=r1['rot'])],
                         str(tmp_path / 'two' / 'w'), str(tmp_path / 'two' / 'f'), lambda x: None, job='e2', outputs=())
    back = json.loads((tmp_path / 'two' / 'f' / art(res2, 'board-json')['name']).read_text())
    f = next(f for f in back['footprints'] if f['ref'] == 'R1')
    assert [f['x'], f['y'], f['rot']] == [r1['x'], r1['y'], r1['rot']]
    assert [p['x'] for p in f['pads']] == [p['x'] for p in r1['pads']]
    assert status(res2)['drc-errors']['status'] == 'pass'


@pytest.mark.parametrize('bad, says', [
    (dict(op='delete', id='00000000-0000-0000-0000-000000000000'), 'no track or via with id 00000000-0000-0000-0000-000000000000'),
    (dict(op='set_via', id='TRACK'), 'no via with id'),
    (dict(op='add_track', layer='In1.Cu', a=[1, 1], b=[2, 2], net='GND'), 'no copper layer In1.Cu'),
    (dict(op='add_via', x=60, y=5, net='GND'), 'off the board'),
    (dict(op='add_track', layer='F.Cu', a=[1, 1], b=[2, 1], net='NOPE'), 'no net NOPE'),
    (dict(op='move_part', ref='MH1', x=5, y=5, rot=0), 'mounting holes'),
    (dict(op='move_part', ref='Q9', x=5, y=5, rot=0), 'no part Q9'),
    (dict(op='explode'), "unknown op 'explode'"),
])
def test_a_bad_edit_changes_nothing(built, tmp_path, bad, says):
    files, final = built
    g = geometry_of(files, final)
    bad = dict(bad)
    if bad.get('id') == 'TRACK':
        bad.update(id=g['tracks'][0]['id'], x=1, y=1)
    good = dict(op='delete', id=g['vias'][0]['id'])
    res, _ = edit(built, [good, bad], tmp_path)
    assert res['rejected'] and not res['ok'] and res['artifacts'] == []
    assert res['error'].startswith('edit 2') and says in res['error'], res['error']


def test_a_track_that_would_short_two_nets_needs_its_net_named(built, tmp_path):
    files, final = built
    g = geometry_of(files, final)
    a = next(t for t in g['tracks'] if t['net'] not in ('GND',) and t['layer'] == 'F.Cu')
    b = next(t for t in g['tracks'] if t['net'] not in ('GND', a['net']) and t['layer'] == 'F.Cu')
    res, _ = edit(built, [dict(op='add_track', layer='F.Cu', a=a['a'], b=b['a'])], tmp_path)
    assert res['rejected'] and 'short' in res['error'] and a['net'] in res['error'] and b['net'] in res['error']


def test_drc_sees_a_clearance_error_made_by_hand(built, tmp_path):
    """A track drawn too close to another net's track: kept, and the DRC says so."""
    files, final = built
    g = geometry_of(files, final)
    other = max((t for t in g['tracks'] if t['layer'] == 'F.Cu' and t['net'] not in ('GND',)),
                key=lambda t: math.dist(t['a'], t['b']))
    net = next(t['net'] for t in g['tracks'] if t['net'] not in ('GND', other['net']))
    (ax, ay), (bx, by) = other['a'], other['b']
    L = math.dist(other['a'], other['b'])
    dx, dy = (bx - ax) / L, (by - ay) / L
    gap = other['width'] / 2 + 0.15 / 2 + 0.05                    # 0.05 mm apart, the rule is 0.15
    p = [(ax + bx) / 2 - dy * gap, (ay + by) / 2 + dx * gap]
    q = [p[0] + dx * min(1.0, L / 3), p[1] + dy * min(1.0, L / 3)]
    res, _ = edit(built, [dict(op='add_track', layer='F.Cu', a=p, b=q, width=0.15, net=net)], tmp_path)
    assert not res.get('rejected'), res.get('error')
    drc = status(res)['drc-errors']
    assert drc['status'] == 'fail' and 'clearance' in drc['detail'], drc
    assert res['stats']['drc_errors'] >= 1 and not res['ok']


def test_silkscreen_is_placed_again_not_twice(tmp_path):
    """A board with silkscreen text, edited: the text is printed once, and the
    moved part's name follows it."""
    import pcbnew
    from hardhub import pipeline, view
    d = fixture('esp32c3-sensor.json')
    d['board']['silkscreen'] = dict(outlines=True, refs=True, texts=[dict(text='ROOM SENSOR v1', x=0, y=-18.5, size=1.2)])
    final = pipeline.build(copy.deepcopy(d), str(tmp_path / 'w'), str(tmp_path / 'f'), lambda x: None, outputs=())
    assert final['ok'], final.get('error')
    g = json.loads((tmp_path / 'f' / art(final, 'board-json')['name']).read_text())
    r1 = next(f for f in g['footprints'] if f['ref'] == 'R1')
    zp = (tmp_path / 'f' / art(final, 'kicad')['name']).read_bytes()
    res = pipeline.edit(d, io.BytesIO(zp), [dict(op='move_part', ref='R1', x=r1['x'], y=r1['y'] + 0.2, rot=r1['rot'])],
                        str(tmp_path / 'ew'), str(tmp_path / 'ef'), lambda x: None, outputs=())
    b = pcbnew.LoadBoard(view.board_path(str(tmp_path / 'e'), str(tmp_path / 'ef' / art(res, 'kicad')['name'])))
    texts = [t.GetText() for t in b.GetDrawings() if t.GetLayer() == pcbnew.F_SilkS]
    assert texts.count('ROOM SENSOR v1') == 1
    assert status(res)['silkscreen']['status'] in ('pass', 'warn')
