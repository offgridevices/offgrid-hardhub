# SPDX-License-Identifier: AGPL-3.0-or-later
"""Everything a board house needs, and what the clients draw, from one
finished .kicad_pcb.

  <slug>-gerbers.zip      copper, mask, paste, silk, outline + Excellon drills
  <slug>-bom-jlcpcb.csv   Comment, Designator, Footprint, LCSC Part #
  <slug>-cpl-jlcpcb.csv   Designator, Mid X, Mid Y, Layer, Rotation
  <slug>-bom-pcbway.csv   PCBWay's assembly BOM columns (MPN + LCSC number)
  <slug>-netlist.csv      every pad and its net
  <slug>.ipc              IPC-D-356 netlist (the fab's electrical test)
  <slug>.glb              3D board with parts, meshopt-compressed
  <slug>-<layer>.svg      one SVG per layer, board area only
  <slug>-top.png          rendered view

Pick-and-place coordinates are the Gerbers' own (KiCad absolute, y up), so
the two line up without any origin setting.  Rotation: 0 degrees is the
footprint's native orientation; HardHub's hh: footprints are JLCPCB's own
library entries and the rest are KiCad standard chip parts, whose 0 degrees
match JLCPCB's.  Bottom parts are given as seen from the bottom: 180 - the
angle seen from the top.  From offgrid-hardware print-hub/v1/src/fab.py.
"""
import collections
import csv
import os
import re
import shutil
import subprocess
import zipfile

import pcbnew

from . import kicad as K

LAYERS = ['F.Paste', 'B.Paste', 'F.Silkscreen', 'B.Silkscreen', 'F.Mask', 'B.Mask', 'Edge.Cuts']
GLTF = os.environ.get('GLTF_TRANSFORM', 'gltf-transform')


def slug(name):
    return re.sub(r'[^a-z0-9]+', '-', name.lower()).strip('-') or 'board'


def run(cmd, timeout=600):
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    if r.returncode != 0:
        raise RuntimeError('failed: %s\n%s\n%s' % (' '.join(cmd), r.stdout[-2000:], r.stderr[-2000:]))
    return r.stdout


def gerbers(board, out_dir, name):
    gdir = os.path.join(out_dir, 'gerbers')
    shutil.rmtree(gdir, ignore_errors=True)
    os.makedirs(gdir)
    n = pcbnew.LoadBoard(board).GetCopperLayerCount()
    run(['kicad-cli', 'pcb', 'export', 'gerbers', '--layers', ','.join(K.copper_names(n) + LAYERS),
         '--subtract-soldermask', '--output', gdir + '/', board])
    run(['kicad-cli', 'pcb', 'export', 'drill', '--format', 'excellon', '--excellon-units', 'mm',
         '--excellon-separate-th', '--generate-map', '--map-format', 'gerberx2', '--output', gdir + '/', board])
    zp = os.path.join(out_dir, '%s-gerbers.zip' % name)
    with zipfile.ZipFile(zp, 'w', zipfile.ZIP_DEFLATED) as z:
        for f in sorted(os.listdir(gdir)):
            z.write(os.path.join(gdir, f), f)
    shutil.rmtree(gdir)
    return zp


def _natural(ref):
    return tuple((0, int(t)) if t.isdigit() else (1, t) for t in re.findall(r'\d+|\D+', ref))


def assembled(b, d):
    """(footprint, part) for every part the assembler places."""
    comps = {c['ref']: c for c in d['components']}
    out = []
    for fp in b.GetFootprints():
        c = comps.get(fp.GetReference())
        if c is None:
            continue                         # mounting holes
        p = d['parts'][c['part']]
        if p.get('assembled', True):
            out.append((fp, p))
    return out


def bom_cpl(board, d, out_dir, name):
    b = pcbnew.LoadBoard(board)
    asm = assembled(b, d)
    key = lambda p: (p.get('sourcing') or {}).get('lcsc') or p['mpn']
    groups = collections.OrderedDict()
    for fp, p in sorted(asm, key=lambda a: (key(a[1]), _natural(a[0].GetReference()))):
        groups.setdefault(key(p), (p, []))[1].append(fp)
    fpname = lambda p: p['footprint'].split(':')[1]
    files = {}
    path = files['bom'] = os.path.join(out_dir, '%s-bom-jlcpcb.csv' % name)
    with open(path, 'w', newline='') as f:
        w = csv.writer(f)
        w.writerow(['Comment', 'Designator', 'Footprint', 'LCSC Part #'])
        for k, (p, fps) in groups.items():
            w.writerow([p.get('value') or p['mpn'], ','.join(sorted((x.GetReference() for x in fps), key=_natural)),
                        fpname(p), (p.get('sourcing') or {}).get('lcsc', '')])
    path = files['bom_pcbway'] = os.path.join(out_dir, '%s-bom-pcbway.csv' % name)
    with open(path, 'w', newline='') as f:
        w = csv.writer(f)
        w.writerow(['Item #', 'Designator', 'Qty', 'Manufacturer Part Number', 'Manufacturer', 'Description', 'Value',
                    'Package/Footprint', 'Type', 'LCSC Part #', 'Side'])
        for i, (k, (p, fps)) in enumerate(groups.items(), 1):
            sides = sorted(set('Bottom' if x.IsFlipped() else 'Top' for x in fps))
            tht = any(pd.GetAttribute() == pcbnew.PAD_ATTRIB_PTH for x in fps for pd in x.Pads())
            w.writerow([i, ','.join(sorted((x.GetReference() for x in fps), key=_natural)), len(fps), p['mpn'],
                        p.get('maker', ''), p.get('description', ''), p.get('value', ''), fpname(p),
                        'THT' if tht else 'SMD', (p.get('sourcing') or {}).get('lcsc', ''), '+'.join(sides)])
    path = files['cpl'] = os.path.join(out_dir, '%s-cpl-jlcpcb.csv' % name)
    with open(path, 'w', newline='') as f:
        w = csv.writer(f)
        w.writerow(['Designator', 'Mid X', 'Mid Y', 'Layer', 'Rotation'])
        for fp, p in sorted(asm, key=lambda a: _natural(a[0].GetReference())):
            q = fp.GetPosition()
            rot = fp.GetOrientationDegrees()
            bottom = fp.IsFlipped()
            if bottom:
                rot = 180 - rot
            rot = round(rot % 360, 2) % 360
            w.writerow([fp.GetReference(), '%.4fmm' % (q.x / 1e6), '%.4fmm' % (-q.y / 1e6),
                        'Bottom' if bottom else 'Top', '%g' % rot])
    return files, len(asm), len(groups)


def netlist(board, out_dir, name):
    b = pcbnew.LoadBoard(board)
    rows = []
    for fp in b.GetFootprints():
        for p in fp.Pads():
            if p.GetNetname():
                rows.append((p.GetNetname(), fp.GetReference(), p.GetNumber()))
    rows.sort(key=lambda r: (r[0], _natural(r[1]), r[2]))
    path = os.path.join(out_dir, '%s-netlist.csv' % name)
    with open(path, 'w', newline='') as f:
        w = csv.writer(f)
        w.writerow(['Net', 'Reference', 'Pad'])
        w.writerows(rows)
    ipc = os.path.join(out_dir, '%s.ipc' % name)
    run(['kicad-cli', 'pcb', 'export', 'ipcd356', '--output', ipc, board])
    return path, ipc, len(rows)


def check_netlist(board, d):
    """The routed board must carry exactly the design's connections, pad
    for pad.  Returns [(ref, pad, wanted, found)]."""
    b = pcbnew.LoadBoard(board)
    want = {}
    for c in d['components']:
        for pad, net in c['pins'].items():
            if net:
                want[(c['ref'], pad)] = net
    got = {}
    for fp in b.GetFootprints():
        for p in fp.Pads():
            if p.GetNetname():
                got.setdefault((fp.GetReference(), p.GetNumber()), p.GetNetname())
    bad = [(k[0], k[1], want.get(k), got.get(k)) for k in set(want) | set(got) if want.get(k) != got.get(k)]
    # footprints may carry extra pads of a numbered pad's net (an exposed pad
    # drawn in pieces); only a pad the design names, wired wrong, counts
    return sorted(x for x in bad if x[2] is not None)


def glb(board, out_dir, name):
    raw = os.path.join(out_dir, '%s-raw.glb' % name)
    out = os.path.join(out_dir, '%s.glb' % name)
    run(['kicad-cli', 'pcb', 'export', 'glb', '--force', '--subst-models', '--include-tracks', '--include-pads',
         '--include-zones', '--include-silkscreen', '--include-soldermask', '--output', raw, board], timeout=900)
    raw_size = os.path.getsize(raw)
    if shutil.which(GLTF):
        try:
            # meshopt: quantised, compressed geometry the web viewer decodes
            # with meshopt's small WASM decoder; dedup/instance/weld first
            run([GLTF, 'optimize', raw, out, '--compress', 'meshopt', '--texture-compress', 'false',
                 '--simplify', 'false'], timeout=600)
            os.remove(raw)
            return out, raw_size
        except (RuntimeError, subprocess.TimeoutExpired):
            pass
    os.replace(raw, out)
    return out, raw_size


SVG_LAYERS = ['F.Cu', 'B.Cu', 'F.Silkscreen', 'B.Silkscreen', 'F.Mask', 'B.Mask', 'Edge.Cuts', 'F.Fab', 'B.Fab']


def svgs(board, out_dir, name):
    """One SVG per layer, board area only, drawn in draw order: back first."""
    n = pcbnew.LoadBoard(board).GetCopperLayerCount()
    layers = ['B.Fab', 'B.Silkscreen', 'B.Mask', 'B.Cu'] + ['In%d.Cu' % i for i in range(n - 2, 0, -1)] + \
             ['F.Cu', 'F.Mask', 'F.Silkscreen', 'F.Fab', 'Edge.Cuts']
    tmp = os.path.join(out_dir, 'svg-tmp')
    shutil.rmtree(tmp, ignore_errors=True)
    os.makedirs(tmp)
    run(['kicad-cli', 'pcb', 'export', 'svg', '--layers', ','.join(layers), '--mode-multi', '--page-size-mode', '2',
         '--exclude-drawing-sheet', '--black-and-white', '--drill-shape-opt', '2', '--output', tmp + '/', board])
    out = []
    for l in layers:
        src = [f for f in os.listdir(tmp) if f.endswith('-%s.svg' % l.replace('.', '_'))]
        if src:
            dst = os.path.join(out_dir, '%s-%s.svg' % (name, l.replace('.', '_')))
            os.replace(os.path.join(tmp, src[0]), dst)
            out.append((l, dst))
    shutil.rmtree(tmp)
    return out


def render(board, out_dir, name, side='top'):
    o = os.path.join(out_dir, '%s-%s.png' % (name, side))
    run(['kicad-cli', 'pcb', 'render', '--side', side, '--width', '1600', '--height', '1600', '--quality', 'basic',
         '--use-board-stackup-colors', '--output', o, board], timeout=600)
    return o


def step(board, out_dir, name):
    raw = os.path.join(out_dir, '%s.step' % name)
    run(['kicad-cli', 'pcb', 'export', 'step', '--subst-models', '--force', '--output', raw, board], timeout=900)
    zp = os.path.join(out_dir, '%s-step.zip' % name)
    with zipfile.ZipFile(zp, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        z.write(raw, os.path.basename(raw))
    os.remove(raw)
    return zp
