"""Quotes and catalogue lookups: plain Python, no KiCad needed.

The catalogue answers are recorded fixtures shaped like the live services'
(tests/fixtures/catalog/*.json say how they were made); the live hosts are
not reached by these tests."""
import os

from conftest import FIX, fixture
from hardhub import parts, quote


def test_quote_covers_layers_and_quantities(c3):
    qs = quote.quote(c3, qtys=(5, 100))
    assert {(q['layers'], q['qty']) for q in qs} == {(n, q) for n in (2, 4, 6, 8) for q in (5, 100)}
    by = {(q['layers'], q['qty']): q for q in qs}
    # more layers never cheaper; more boards never dearer per board
    for q in (5, 100):
        assert by[(2, q)]['pcb_usd'] < by[(4, q)]['pcb_usd'] < by[(6, q)]['pcb_usd'] < by[(8, q)]['pcb_usd']
    for n in (2, 4, 6, 8):
        assert by[(n, 100)]['per_board_usd'] < by[(n, 5)]['per_board_usd']
    assert all('Oct 2026' in q['basis'] for q in qs)
    # Print Hub's live quote: five 4-layer boards under 100 mm a side, $8 (+$8 black mask)
    assert by[(4, 5)]['pcb_usd'] == 16.0


def test_quote_charges_extended_parts():
    d = fixture('esp32c3-sensor.json')
    _, ext, joints = quote.parts_cost(d, 5)
    assert ext == 4                     # USB-C, ESP32-C3, SHT40, button
    assert joints > 60


def test_track_width_from_current():
    from hardhub import rules
    assert rules.track_width(0) == rules.TRACK
    assert 0.25 <= rules.track_width(1.0) <= 0.35      # IPC-2221, 1 oz outer, 10 C rise
    assert rules.track_width(3.0) > rules.track_width(1.0)


def recorded(monkeypatch):
    calls = []

    def fetch(url, body=None, timeout=20):
        calls.append(url)
        if 'selectSmtComponentList' in url:
            return fixture('catalog/jlc-search.json')
        if url.endswith('C6186'):
            return fixture('catalog/lcsc-C6186.json')
        return {'result': None}
    monkeypatch.setattr(parts, 'fetch', fetch)
    return calls


def test_search_maps_jlc_fields(monkeypatch):
    calls = recorded(monkeypatch)
    rs = parts.search('esp32', 10)
    by = {r['lcsc']: r for r in rs}
    assert by['C2913198']['tier'] == 'preferred'
    assert by['C6186']['tier'] == 'basic'
    assert by['C6186']['prices'] == [{'qty': 1, 'usd': 0.1121}]
    assert by['C99999']['lifecycle'] == 'eol' and by['C99999']['stock'] == 0
    assert by['C2913198']['datasheet'].endswith('.pdf')
    parts.search('esp32', 10)
    assert len(calls) == 1              # the second search came from the disk cache


def test_get_merges_tier(monkeypatch):
    recorded(monkeypatch)
    (p,) = parts.get(['C6186'])
    assert p['mpn'] == 'AMS1117-3.3' and p['package'] == 'SOT-223'
    assert p['tier'] == 'basic' and p['stock'] == 812345
    assert parts.get(['C1']) == []


def test_unreachable_catalogue_is_an_error(monkeypatch):
    def down(*a, **k):
        raise OSError('blocked')
    monkeypatch.setattr(parts, 'fetch', down)
    try:
        parts.search('anything')
    except parts.CatalogError as e:
        assert 'unreachable' in str(e)
    else:
        raise AssertionError('no error')


def test_fixture_notes_say_how_they_were_made():
    for f in os.listdir(os.path.join(FIX, 'catalog')):
        assert 'by hand' in fixture('catalog/' + f)['_note']
