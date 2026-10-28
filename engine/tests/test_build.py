"""Whole builds, inside the engine image.  The 2-layer ESP32-C3 fixture uses
KiCad's standard footprints only and must come out fully green."""
import copy
import json
import os
import subprocess
import sys
import time

import pytest

from conftest import fixture, kicad

pytestmark = kicad


def build(d, tmp_path, outputs=('svg',)):
    from hardhub import pipeline
    lines = []
    final = pipeline.build(d, str(tmp_path / 'work'), str(tmp_path / 'files'), lines.append, job='t',
                           outputs=outputs)
    return final, lines


def status(final):
    return {c['id']: c['status'] for c in final['checks']}


def test_circuit_checks(c3):
    from hardhub import checks
    rs = {r['id']: r for r in checks.circuit(c3)}
    for k in ('parts-exist', 'single-pin-nets', 'pins-pads', 'lcsc', 'firmware-pins-U1', 'esp32-adc2-U1'):
        assert rs[k]['status'] == 'pass', rs[k]
    assert rs['esp32-strapping-U1']['status'] == 'warn'       # GPIO 2, 8, 9 carry pull-ups and BOOT


def test_circuit_checks_catch_mistakes(c3):
    """A check that cannot fail is no check: break the fixture three ways."""
    from hardhub import checks
    d = copy.deepcopy(c3)
    u1 = next(c for c in d['components'] if c['ref'] == 'U1')
    u1['pins']['3'], u1['pins']['4'] = u1['pins']['4'], u1['pins']['3']   # SDA and SCL swapped at the module
    del u1['pins']['19']                                                    # ground pad left out
    d['components'].append(dict(ref='R99', part='R10K', block='mcu', pins={'1': 'TYPO_NET', '2': 'GND'}))
    d['firmware']['pins'].append(dict(name='SENSE', gpio=5, net='SCL', dir='analog'))
    rs = {r['id']: r['status'] for r in checks.circuit(d)}
    assert rs['firmware-pins-U1'] == 'fail'
    assert rs['pins-pads'] == 'fail'
    assert rs['single-pin-nets'] == 'fail'
    assert rs['esp32-adc2-U1'] == 'fail'


def test_small_board_is_green(c3, tmp_path):
    t = time.time()
    final, lines = build(c3, tmp_path, outputs=('svg', 'glb'))
    took = time.time() - t
    st = status(final)
    assert final['ok'], final.get('error')
    for k in ('routed', 'drc-errors', 'drc-warnings', 'nets-match', 'corners-45', 'parts-placed', 'bom-cpl'):
        assert st[k] == 'pass', (k, [c for c in final['checks'] if c['id'] == k])
    s = final['stats']
    assert s['drc_errors'] == 0 and s['drc_warnings'] == 0 and s['unconnected'] == 0
    kinds = {a['kind'] for a in final['artifacts']}
    assert {'gerbers', 'bom', 'cpl', 'netlist', 'kicad', 'board-svg', 'glb'} <= kinds
    assert all(os.path.getsize(tmp_path / 'files' / a['name']) == a['bytes'] for a in final['artifacts'])
    # the engine placed what the design left unplaced, and says where
    assert set(final['placement']) == {c['ref'] for c in c3['components']} - set(c3['placement'])
    # every step reported, with its time
    assert all('t_' + s_ in s for s_ in ('validate', 'place', 'route', 'drc', 'fab', 'render'))
    assert any(l.get('step') == 'route' for l in lines)
    print('small board: %.0f s, %d vias, glb %d -> %d bytes' % (took, s['vias'], s.get('glb_raw_bytes', 0),
                                                                 s.get('glb_bytes', 0)))


@kicad
def test_silkscreen(c3, tmp_path):
    """Part names, outlines and the design's own words on the silkscreen, with
    the DRC still clean, and what did not fit said plainly."""
    import pcbnew
    from hardhub import view
    c3['board']['silkscreen'] = dict(outlines=True, refs=True, texts=[
        dict(text='ROOM SENSOR v1', x=0, y=-18.5, size=1.2),
        dict(text='ON A PAD', x=-21, y=-3.2, size=1.0)])
    final, _ = build(c3, tmp_path, outputs=())
    st = {c['id']: c for c in final['checks']}
    assert final['ok'] and st['drc-errors']['status'] == 'pass' and st['drc-warnings']['status'] == 'pass', st['drc-warnings']
    silk = st['silkscreen']
    assert silk['status'] == 'warn' and '"ON A PAD"' in silk['detail'] and 'part names on the silkscreen' in silk['detail']
    b = pcbnew.LoadBoard(view.board_path(str(tmp_path)))
    on_silk = [fp.GetReference() for fp in b.GetFootprints() if fp.Reference().GetLayer() == pcbnew.F_SilkS]
    assert len(on_silk) >= 10
    texts = [d.GetText() for d in b.GetDrawings() if d.GetLayer() == pcbnew.F_SilkS]
    assert 'ROOM SENSOR v1' in texts, silk['detail']
    # no silkscreen asked for: none made, as before
    final, _ = build(fixture('esp32c3-sensor.json'), tmp_path / 'plain', outputs=())
    b = pcbnew.LoadBoard(view.board_path(str(tmp_path / 'plain')))
    assert [fp.GetReference() for fp in b.GetFootprints() if fp.Reference().GetLayer() == pcbnew.F_SilkS] == []
    assert not any(g.GetLayer() in (pcbnew.F_SilkS, pcbnew.User_9) for fp in b.GetFootprints() for g in fp.GraphicalItems())


def test_bad_design_stops_early(c3, tmp_path):
    d = copy.deepcopy(c3)
    d['board']['layers'] = 3
    final, _ = build(d, tmp_path)
    assert not final['ok'] and 'layers' in final['error']


def test_stop_after_place(c3, tmp_path):
    from hardhub import pipeline
    final = pipeline.build(c3, str(tmp_path / 'w'), str(tmp_path / 'f'), lambda x: None, stop_after='place')
    assert final['ok'] and 't_route' not in final['stats'] and final['placement']


def test_cli_prints_ndjson(c3, tmp_path):
    p = tmp_path / 'd.json'
    p.write_text(json.dumps(c3))
    r = subprocess.run([sys.executable, '-m', 'hardhub.pipeline', str(p), str(tmp_path / 'out'), 'svg'],
                       capture_output=True, text=True, timeout=1200,
                       cwd=os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    lines = [json.loads(l) for l in r.stdout.splitlines() if l.startswith('{')]
    assert lines[-1]['done'] and lines[-1]['ok'], r.stderr[-2000:]


@pytest.mark.skipif(not os.environ.get('OFFGRID_HARDWARE'), reason='set OFFGRID_HARDWARE to the offgrid-hardware clone')
def test_print_hub(tmp_path):
    """Print Hub, converted from offgrid-hardware and built by the generic
    pipeline.  Reports how close it gets rather than demanding green:
    Print Hub's hand-drawn power copper does not carry over."""
    root = os.environ['OFFGRID_HARDWARE']
    os.environ['HARDHUB_FP_PATHS'] = 'ph=%s/print-hub/v1/ph.pretty' % root
    out = tmp_path / 'ph.json'
    subprocess.run([sys.executable, os.path.join(os.path.dirname(__file__), 'printhub_to_design.py'), str(out)],
                   check=True, env=dict(os.environ, OFFGRID_HARDWARE=root), capture_output=True)
    d = json.loads(out.read_text())
    t = time.time()
    final, _ = build(d, tmp_path, outputs=('svg', 'glb'))
    s = final['stats']
    print('Print Hub: %.0f s; unconnected %s, DRC %s errors / %s warnings; nets %s; glb %s bytes'
          % (time.time() - t, s.get('unconnected'), s.get('drc_errors'), s.get('drc_warnings'),
             status(final).get('nets-match'), s.get('glb_bytes')))
    assert status(final).get('nets-match') == 'pass'
