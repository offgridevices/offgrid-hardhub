"""The HTTP service, started in-process on a free port."""
import json
import threading
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer

import pytest

from conftest import kicad


@pytest.fixture(scope='module')
def url(tmp_path_factory):
    import os
    os.environ['HARDHUB_JOBS'] = str(tmp_path_factory.mktemp('jobs'))
    from hardhub import server
    server.JOBS = os.environ['HARDHUB_JOBS']
    srv = ThreadingHTTPServer(('127.0.0.1', 0), server.Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    yield 'http://127.0.0.1:%d' % srv.server_address[1]
    srv.shutdown()


LOCAL = urllib.request.build_opener(urllib.request.ProxyHandler({}))     # never through an HTTP proxy


def call(url, path, body=None, method=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url + path, data, {'Content-Type': 'application/json'}, method=method)
    try:
        with LOCAL.open(req, timeout=1800) as r:
            return r.status, r.headers.get('Content-Type'), r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.headers.get('Content-Type'), e.read()


@kicad
def test_health_is_honest(url):
    code, _, body = call(url, '/health')
    h = json.loads(body)
    assert h['kicad'] and h['kicad'].startswith('10.')
    assert code == (200 if h['freerouting'] else 503)


def test_quote(url, c3):
    code, _, body = call(url, '/quote', dict(design=c3, qty=[5, 100]))
    assert code == 200 and len(json.loads(body)['quotes']) == 8


def test_bad_requests(url, c3):
    assert call(url, '/build', dict(design=c3, job='../etc'))[0] == 400
    assert call(url, '/quote', dict())[0] == 400
    assert call(url, '/nope', dict())[0] == 404
    assert call(url, '/jobs/x/files/..%2Fsecret')[0] == 404


@kicad
def test_check(url, c3):
    code, _, body = call(url, '/check', dict(design=c3))
    rs = {r['id']: r['status'] for r in json.loads(body)['results']}
    assert code == 200 and rs['pins-pads'] == 'pass'


@kicad
def test_build_streams_and_serves_files(url, c3):
    code, ctype, body = call(url, '/build', dict(design=c3, job='srvtest', outputs=['svg']))
    assert code == 200 and ctype == 'application/x-ndjson'
    lines = [json.loads(l) for l in body.splitlines()]
    assert lines[0]['step'] == 'validate' and lines[-1]['done'] and lines[-1]['ok']
    gerbers = next(a for a in lines[-1]['artifacts'] if a['kind'] == 'gerbers')
    code, ctype, data = call(url, gerbers['url'])
    assert code == 200 and len(data) == gerbers['bytes'] and data[:2] == b'PK'
    assert call(url, '/jobs/srvtest', method='DELETE')[0] == 204
    assert call(url, gerbers['url'])[0] == 404


@kicad
def test_one_build_at_a_time(url, c3):
    from hardhub import server
    assert server._builds.acquire(blocking=False)          # as if a build were running
    try:
        code, _, body = call(url, '/build', dict(design=c3, job='busy'))
        assert code == 429 and 'busy' in json.loads(body)['error']
    finally:
        server._builds.release()
