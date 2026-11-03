"""heat.py's own arithmetic, with the Rust solver stubbed: no KiCad needed."""
from hardhub.review import heat


def model():
    pad = lambda ref, num, net, x: dict(ref=ref, num=num, net=net, x=x, y=0, w=1, h=1, rot=0, shape='rect',
                                        layers=['F.Cu'], drill=0, plated=False, poly=[[x - .5, -.5], [x + .5, -.5], [x + .5, .5], [x - .5, .5]])
    return dict(outline=[[-10, -10], [10, -10], [10, 10], [-10, 10]], layers=['F.Cu', 'B.Cu'], copper_mm=[0.035, 0.035],
                dielectric_mm=[1.53], tracks=[], vias=[], zones=[], holes=[], silk=[], mask_openings=[],
                pads=[pad('U1', '1', 'VNEG', -5), pad('U2', '1', 'VNEG', 5)],
                parts=[dict(ref=r, x=x, y=0, side='top', bbox=[x - 1, -1, x + 1, 1], courtyard=[]) for r, x in (('U1', -5), ('U2', 5))])


def test_a_negative_rail_loses_its_drop_as_a_share_of_its_size(monkeypatch):
    """A −5 V rail that loses 500 mV has lost 10 %: a failure, not a pass at −10 %."""
    def fake(cmd, payload, timeout=120):
        if cmd == 'irdrop':
            return dict(worst_mv=500.0, worst=dict(ref='U2', num='1'), sinks=[dict(ref='U2', drop_mv=500.0)])
        raise heat.sim.SimError('no heat solver in this test')
    monkeypatch.setattr(heat.sim, 'run', fake)
    d = dict(components=[dict(ref='U1', part='P', pins={'1': 'VNEG'}), dict(ref='U2', part='P', pins={'1': 'VNEG'})],
             parts=dict(P=dict(kind='U')), nets=dict(VNEG=dict(kind='power', voltage=-5, current=0.1)))
    pm = dict(nets=dict(VNEG=dict(voltage=-5, source='U1', source_pads=['1'], sinks=[dict(ref='U2', pads=['1'], current=0.1)])))
    out, rep, _ = heat.run(d, dict(ambient_min=0, ambient_max=50), model(), pm, lambda ref: {})
    vd = next(r for r in out if r['id'] == 'voltage-drop')
    assert vd['status'] == 'fail' and vd['measured']['value'] == 10.0, vd
    assert rep['drop'][0]['pct'] == 10.0


def test_only_a_radio_counts_as_a_radio():
    """'BLE' is a radio; 'adjustable' and 'programmable' only contain the letters."""
    from hardhub.review.layout import _Shapes
    m = model()
    for desc, want in (('Adjustable LDO regulator, SOT-23-5', 'na'), ('Programmable clock generator', 'na'),
                       ('Wi-Fi + BLE module, ESP32-C3', None)):
        d = dict(components=[dict(ref='U1', part='P', pins={})], parts=dict(P=dict(kind='U', description=desc, mpn='X')))
        r = _Shapes(m).antenna(d, None)
        if want:
            assert r['status'] == want, (desc, r)
        else:
            assert r['status'] != 'na', (desc, r)
