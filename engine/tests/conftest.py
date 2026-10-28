import json
import os
import sys

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
FIX = os.path.join(HERE, 'fixtures')


def fixture(name):
    return json.load(open(os.path.join(FIX, name)))


def have_kicad():
    try:
        import pcbnew  # noqa: F401
        return True
    except ImportError:
        return False


kicad = pytest.mark.skipif(not have_kicad(), reason='needs KiCad (run inside the engine image)')


@pytest.fixture
def c3():
    return fixture('esp32c3-sensor.json')


@pytest.fixture(autouse=True)
def cache(tmp_path, monkeypatch):
    monkeypatch.setenv('HARDHUB_FP_CACHE', str(tmp_path / 'cache'))
    from hardhub import parts
    monkeypatch.setattr(parts, 'CACHE', str(tmp_path / 'cache' / 'parts'))
    return tmp_path
