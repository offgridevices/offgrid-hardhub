# SPDX-License-Identifier: AGPL-3.0-or-later
"""The engine's HTTP service (contract: packages/protocol/src/engine.ts).

    python3 -m hardhub.server            listens on 0.0.0.0:$PORT (8080)

Standard library only: ThreadingHTTPServer for the requests, and a
multiprocessing "forkserver" that imports KiCad's pcbnew once at start-up.
Every build or footprint check is forked from that warm process, so it
pays no import cost, gets a clean KiCad (pcbnew keeps global state between
boards), and can be killed outright with Freerouting and anything else it
started when it runs past its time.

Environment:
  PORT                   8080
  HARDHUB_JOBS           where job outputs live (volume-mountable)
  HARDHUB_MAX_BUILDS     builds at once (1); more get 429 with a reason
  HARDHUB_BUILD_TIMEOUT  seconds a whole build may take (1800)
  FREEROUTING_TIMEOUT    seconds one Freerouting run may take (900)
  HARDHUB_KEEP_WORK      1 keeps intermediate files beside the outputs
"""
import json
import mimetypes
import multiprocessing as mp
import os
import queue
import re
import shutil
import signal
import socketserver
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

JOBS = os.environ.get('HARDHUB_JOBS', '/var/lib/hardhub/jobs')
MAX_BUILDS = int(os.environ.get('HARDHUB_MAX_BUILDS', 1))
BUILD_TIMEOUT = int(os.environ.get('HARDHUB_BUILD_TIMEOUT', 1800))
JOB_RE = re.compile(r'^[A-Za-z0-9_-]{1,64}$')
NAME_RE = re.compile(r'^[A-Za-z0-9_.-]{1,128}$')

_ctx = None
_builds = threading.BoundedSemaphore(MAX_BUILDS)
_running = [0]
_lock = threading.Lock()
_health = {}


def ctx():
    global _ctx
    if _ctx is None:
        _ctx = mp.get_context('forkserver')
        _ctx.set_forkserver_preload(['pcbnew', 'shapely', 'hardhub.pipeline', 'hardhub.board', 'hardhub.checks',
                                     'hardhub.route', 'hardhub.fab', 'hardhub.place', 'hardhub.miter', 'hardhub.view'])
    return _ctx


# ---------------------------------------------------------------- children
def _child(fn, args, q):
    """Runs in a process forked from the warm server: its own process group,
    so a timeout kills Freerouting and kicad-cli with it."""
    os.setsid()
    try:
        fn(q, *args)
    except Exception as e:                                  # noqa: BLE001 -- reported to the client
        q.put(dict(done=True, ok=False, error='%s: %s' % (type(e).__name__, e), checks=[], artifacts=[],
                   stats={}, placement={}))
    finally:
        q.put(None)


def _build(q, design, job, outputs, stop_after):
    from . import pipeline
    base = os.path.join(JOBS, job)
    shutil.rmtree(base, ignore_errors=True)
    work, out = os.path.join(base, 'work'), os.path.join(base, 'files')
    line = pipeline.build(design, work, out, q.put, job=job, outputs=outputs, stop_after=stop_after)
    if os.environ.get('HARDHUB_KEEP_WORK') != '1':
        shutil.rmtree(work, ignore_errors=True)
    q.put(line)


def _check(q, design):
    from . import checks
    q.put(dict(results=checks.circuit(design)))


def _board(job, kicad_zip_b64):
    """The job's routed board file, from its own files or from a KiCad zip the caller sent."""
    from . import view
    import base64
    import io
    zf = io.BytesIO(base64.b64decode(kicad_zip_b64)) if kicad_zip_b64 else None
    return view.board_path(os.path.join(JOBS, job), zf)


def _view(q, job, kicad_zip_b64, opts):
    import base64
    from . import view
    pcb = _board(job, kicad_zip_b64)
    if pcb is None:
        return q.put(dict(error='board not found', need_board=True))
    if opts.get('mode') == '3d':
        png = view.view_3d(pcb, side=opts.get('side', 'top'), rotate=opts.get('rotate'), zoom=opts.get('zoom', 1),
                           pan=opts.get('pan'), perspective=bool(opts.get('perspective')),
                           width=opts.get('width', 1200), height=opts.get('height', 900), quality=opts.get('quality', 'basic'))
    else:
        png = view.view_2d(pcb, layers=opts.get('layers'), side=opts.get('side', 'top'), region=opts.get('region'),
                           net=opts.get('net'), refs=opts.get('refs'), labels=opts.get('labels'),
                           width=opts.get('width', 1400))
    q.put(dict(png=base64.b64encode(png).decode()))


def _inspect(q, job, kicad_zip_b64, what, refs, nets):
    from . import view
    pcb = _board(job, kicad_zip_b64)
    if pcb is None:
        return q.put(dict(error='board not found', need_board=True))
    q.put(dict(result=view.inspect(pcb, what=what, refs=refs, nets=nets)))


def _plain_child(fn, args, q):
    """Like _child, for calls whose failure is a plain error, not a build result."""
    os.setsid()
    try:
        fn(q, *args)
    except Exception as e:                                  # noqa: BLE001 -- reported to the client
        q.put(dict(error='%s: %s' % (type(e).__name__, e), user_error=isinstance(e, ValueError)))
    finally:
        q.put(None)


def run_child(fn, args, timeout, on_line):
    """Fork fn from the warm process; pass each line it emits to on_line.
    Returns the last line, or raises TimeoutError."""
    c = ctx()
    q = c.Queue()
    target = _plain_child if fn in (_view, _inspect) else _child
    p = c.Process(target=target, args=(fn, args, q), daemon=True)
    p.start()
    last, deadline = None, time.time() + timeout
    try:
        while True:
            left = deadline - time.time()
            if left <= 0:
                raise TimeoutError('took longer than %d s' % timeout)
            try:
                item = q.get(timeout=min(left, 5))
            except queue.Empty:
                if not p.is_alive() and q.empty():
                    break
                continue
            if item is None:
                break
            last = item
            on_line(item)
    finally:
        if p.is_alive():
            try:
                os.killpg(p.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        p.join(5)
    return last


# ---------------------------------------------------------------- health
def health():
    if not _health:
        try:
            v = subprocess.run(['kicad-cli', 'version'], capture_output=True, text=True, timeout=60).stdout.strip()
        except (OSError, subprocess.TimeoutExpired):
            v = ''
        from . import route
        fr2 = None
        if os.access(route.FR2, os.X_OK):
            # start it for real: it must get as far as printing its version
            try:
                out = subprocess.run([route.FR2, '--gui.enabled=false', '--usage_and_diagnostic_data.disable_analytics=true',
                                      '-de', '/nonexistent.dsn'], capture_output=True, text=True, timeout=90)
                m = re.search(r'Freerouting v(\d+\.\d+\.\d+)', out.stdout + out.stderr)
                fr2 = m.group(1) if m else None
            except (OSError, subprocess.TimeoutExpired):
                fr2 = None
        fr19 = os.path.exists(route.JAR) and shutil.which('java') is not None and shutil.which('xvfb-run') is not None
        _health.update(kicad=v or None, freerouting=fr2 or ('1.9.0' if fr19 else None),
                       freerouting_fallback=fr19,
                       gltf_transform=shutil.which(os.environ.get('GLTF_TRANSFORM', 'gltf-transform')) is not None)
    h = dict(_health)
    h['ok'] = bool(h['kicad'] and h['freerouting'])
    with _lock:
        h['builds_running'] = _running[0]
    h['max_builds'] = MAX_BUILDS
    return h


# ---------------------------------------------------------------- handler
class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'
    server_version = 'hardhub-engine'

    def log_message(self, fmt, *args):
        sys.stderr.write('%s %s\n' % (time.strftime('%H:%M:%S'), fmt % args))

    def send_json(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def body(self):
        n = int(self.headers.get('Content-Length') or 0)
        if n > 20 * 1024 * 1024:
            raise ValueError('request too large')
        return json.loads(self.rfile.read(n) or b'{}')

    def do_GET(self):
        if self.path == '/health':
            h = health()
            return self.send_json(200 if h['ok'] else 503, h)
        m = re.fullmatch(r'/jobs/([^/]+)/files/([^/?]+)', self.path.split('?')[0])
        if m and JOB_RE.match(m.group(1)) and NAME_RE.match(m.group(2)):
            path = os.path.join(JOBS, m.group(1), 'files', m.group(2))
            if os.path.isfile(path):
                ctype = {'.glb': 'model/gltf-binary', '.svg': 'image/svg+xml', '.csv': 'text/csv',
                         '.ipc': 'text/plain'}.get(os.path.splitext(path)[1]) or \
                    mimetypes.guess_type(path)[0] or 'application/octet-stream'
                self.send_response(200)
                self.send_header('Content-Type', ctype)
                self.send_header('Content-Length', str(os.path.getsize(path)))
                self.end_headers()
                with open(path, 'rb') as f:
                    shutil.copyfileobj(f, self.wfile)
                return
        self.send_json(404, dict(error='not found'))

    def do_DELETE(self):
        m = re.fullmatch(r'/jobs/([^/]+)', self.path)
        if m and JOB_RE.match(m.group(1)):
            shutil.rmtree(os.path.join(JOBS, m.group(1)), ignore_errors=True)
            self.send_response(204)
            self.send_header('Content-Length', '0')
            self.end_headers()
            return
        self.send_json(404, dict(error='not found'))

    def do_POST(self):
        try:
            req = self.body()
        except (ValueError, json.JSONDecodeError) as e:
            return self.send_json(400, dict(error='bad request', detail=str(e)))
        try:
            if self.path == '/parts/search':
                from . import parts
                return self.send_json(200, dict(parts=parts.search(str(req.get('query', '')), req.get('limit', 10))))
            if self.path == '/parts/get':
                from . import parts
                codes = [c for c in req.get('lcsc', []) if re.fullmatch(r'C\d+', str(c))][:50]
                return self.send_json(200, dict(parts=parts.get(codes)))
            if self.path == '/quote':
                from . import design as D, quote
                d = D.normalize(req['design'])
                if not d.get('board'):
                    return self.send_json(400, dict(error='the design has no board yet'))
                qty = [int(q) for q in req.get('qty', [5, 100]) if 0 < int(q) <= 100000][:6] or [5]
                return self.send_json(200, dict(quotes=quote.quote(d, qty)))
            if self.path == '/check':
                res = run_child(_check, (req['design'],), 300, lambda x: None)
                if res is None or 'results' not in res:
                    return self.send_json(500, dict(error=(res or {}).get('error', 'check failed')))
                return self.send_json(200, res)
            if self.path == '/build':
                return self.build(req)
            if self.path in ('/view', '/inspect'):
                return self.look(req)
        except KeyError as e:
            return self.send_json(400, dict(error='missing field %s' % e))
        except Exception as e:                              # noqa: BLE001 -- the caller must hear about it
            from .parts import CatalogError
            code = 502 if isinstance(e, CatalogError) else 500
            return self.send_json(code, dict(error='%s: %s' % (type(e).__name__, e)))
        self.send_json(404, dict(error='not found'))

    def look(self, req):
        """POST /view -> image/png; POST /inspect -> JSON. 404 with need_board when the
        engine no longer has the job's board: send it back as kicad_zip (base64)."""
        job = str(req.get('job', ''))
        if not JOB_RE.match(job):
            return self.send_json(400, dict(error='job must be 1-64 letters, digits, - or _'))
        z = req.get('kicad_zip')
        if self.path == '/view':
            res = run_child(_view, (job, z, req), 300, lambda x: None)
        else:
            what = [w for w in (req.get('what') or ['parts', 'nets', 'drc']) if w in ('parts', 'nets', 'drc')]
            res = run_child(_inspect, (job, z, what, req.get('refs'), req.get('nets')), 300, lambda x: None)
        if not res:
            return self.send_json(500, dict(error='the engine stopped without a result'))
        if res.get('need_board'):
            return self.send_json(404, dict(error=res['error'], need_board=True))
        if 'error' in res:
            return self.send_json(400 if res.get('user_error') else 500, dict(error=res['error']))
        if self.path == '/inspect':
            return self.send_json(200, res['result'])
        import base64
        png = base64.b64decode(res['png'])
        self.send_response(200)
        self.send_header('Content-Type', 'image/png')
        self.send_header('Content-Length', str(len(png)))
        self.end_headers()
        self.wfile.write(png)

    def build(self, req):
        job = str(req.get('job', ''))
        if not JOB_RE.match(job):
            return self.send_json(400, dict(error='job must be 1-64 letters, digits, - or _'))
        if not _builds.acquire(blocking=False):
            return self.send_json(429, dict(error='engine busy: %d build(s) running, at most %d at once'
                                            % (MAX_BUILDS, MAX_BUILDS), retryable=True))
        with _lock:
            _running[0] += 1
        try:
            self.send_response(200)
            self.send_header('Content-Type', 'application/x-ndjson')
            self.send_header('Transfer-Encoding', 'chunked')
            self.send_header('Cache-Control', 'no-store')
            self.end_headers()

            def chunk(obj):
                data = (json.dumps(obj) + '\n').encode()
                self.wfile.write(b'%x\r\n%s\r\n' % (len(data), data))
                self.wfile.flush()

            outputs = req.get('outputs') or ['svg', 'glb']
            sent_done = [False]

            def on_line(x):
                if x.get('done'):
                    sent_done[0] = True
                chunk(x)
            try:
                run_child(_build, (req['design'], job, outputs, req.get('stop_after')), BUILD_TIMEOUT, on_line)
            except TimeoutError as e:
                chunk(dict(done=True, ok=False, error='build %s' % e, checks=[], artifacts=[], stats={}, placement={}))
                sent_done[0] = True
            if not sent_done[0]:
                chunk(dict(done=True, ok=False, error='the build stopped without a result', checks=[], artifacts=[],
                           stats={}, placement={}))
            self.wfile.write(b'0\r\n\r\n')
        except (BrokenPipeError, ConnectionResetError):
            pass
        finally:
            with _lock:
                _running[0] -= 1
            _builds.release()


class Server(ThreadingHTTPServer):
    """The standard threading server, minus its look-up of this machine's
    name: a Cloudflare Container's host name has a label longer than DNS
    allows (63), so socket.getfqdn() raises UnicodeError ("label too
    long") and the engine exited before it listened."""

    def server_bind(self):
        socketserver.TCPServer.server_bind(self)
        host, port = self.server_address[:2]
        self.server_name = host
        self.server_port = port


def main():
    os.makedirs(JOBS, exist_ok=True)
    ctx()
    h = health()
    sys.stderr.write('hardhub engine: kicad %s, freerouting %s, %d build(s) at once, jobs in %s\n'
                     % (h['kicad'], h['freerouting'], MAX_BUILDS, JOBS))
    srv = Server(('0.0.0.0', int(os.environ.get('PORT', 8080))), Handler)
    srv.daemon_threads = True
    signal.signal(signal.SIGTERM, lambda *a: threading.Thread(target=srv.shutdown).start())
    srv.serve_forever()


if __name__ == '__main__':
    main()
