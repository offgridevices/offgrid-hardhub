# SPDX-License-Identifier: AGPL-3.0-or-later
"""The Rust solver, hardhub-sim: one command per call, JSON in on stdin, JSON
out on stdout (contract: engine/sim/src, spec section 6).

    from hardhub.review import sim
    m = sim.run('measure', dict(board=model, limits=...))
    sim.version()        # {'name': 'hardhub-sim', 'version': '0.1.0', ...}

The binary is $HARDHUB_SIM, else `hardhub-sim` on PATH (the engine image puts
it in /usr/local/bin).  Any failure (missing binary, timeout, crash, an
{"error": ...} answer) raises SimError with the reason, so callers can turn
it into a skipped check instead of a crashed test run.
"""
import json
import os
import subprocess

COMMANDS = ('measure', 'irdrop', 'thermal', 'version')


class SimError(RuntimeError):
    """hardhub-sim could not answer; str(e) says why."""


def binary():
    return os.environ.get('HARDHUB_SIM') or 'hardhub-sim'


def run(command, payload, timeout=120):
    """Run one hardhub-sim command on `payload` (a dict) and return its answer."""
    if command not in COMMANDS:
        raise SimError('unknown hardhub-sim command %r' % command)
    try:
        data = json.dumps(payload, separators=(',', ':'), allow_nan=False)
    except (TypeError, ValueError) as e:
        raise SimError('%s input is not plain JSON: %s' % (command, e)) from e
    try:
        p = subprocess.run([binary(), command], input=data, capture_output=True, text=True, timeout=timeout)
    except FileNotFoundError as e:
        raise SimError('hardhub-sim not found (%s); set HARDHUB_SIM or put it on PATH' % binary()) from e
    except subprocess.TimeoutExpired as e:
        raise SimError('hardhub-sim %s took longer than %ss' % (command, timeout)) from e
    out = p.stdout.strip()
    try:
        answer = json.loads(out) if out else None
    except ValueError:
        answer = None
    if isinstance(answer, dict) and 'error' in answer:
        raise SimError('hardhub-sim %s: %s' % (command, answer['error']))
    if p.returncode != 0 or not isinstance(answer, dict):
        why = (p.stderr or out or '').strip().splitlines()
        raise SimError('hardhub-sim %s failed (exit %s): %s' % (command, p.returncode, why[-1][:300] if why else 'no output'))
    return answer


def version(timeout=10):
    """The solver's name, version and commands, e.g. {'version': '0.1.0', ...}."""
    return run('version', {}, timeout=timeout)
