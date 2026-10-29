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
  <slug>-board.json       the board as vector geometry, in the SVGs' frame (geometry.py)
  <slug>-top.png          rendered view
  <slug>-package.zip      all of the order files, sorted by where each is uploaded, with a README

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
            # centred on the origin (KiCad exports at its page position, 100 mm
            # out), then meshopt: quantised, compressed geometry the viewer
            # decodes with meshopt's small WASM decoder; dedup/instance/weld first
            centred = raw[:-4] + '-c.glb'
            run([GLTF, 'center', raw, centred, '--pivot', 'center'], timeout=300)
            # no palette: each part keeps its own material colour, which the
            # viewer reads (a palette moves colours into a texture)
            run([GLTF, 'optimize', centred, out, '--compress', 'meshopt', '--texture-compress', 'false',
                 '--simplify', 'false', '--palette', 'false'], timeout=600)
            os.remove(raw)
            os.remove(centred)
            return out, raw_size
        except (RuntimeError, subprocess.TimeoutExpired):
            pass
    os.replace(raw, out)
    return out, raw_size


# Drawn colours, the same the web viewer shows in its layer list. KiCad plots
# every layer black; each is recoloured here so any client can stack them as
# they are. Solder mask is left out: a mask plot is the openings in a filled
# sheet, which only hides the copper in a viewer.
SVG_COLORS = {
    'F.Cu': '#ff8a3d', 'B.Cu': '#6fa8e8',
    'F.Silkscreen': '#f1ece0', 'B.Silkscreen': '#b9b0a0',
    'F.Fab': '#9a9082', 'B.Fab': '#6f675c', 'Edge.Cuts': '#d9c9a8',
}
INNER_COLORS = ['#f0b84a', '#c39bd3', '#8cc084', '#4fd1c5', '#7f9460', '#9c7468', '#8a7fa8', '#5f9a94', '#a8925f',
                '#7d8a9c', '#9c8a70', '#6f9a7a', '#a07890', '#7f8f5f', '#8f7f6f', '#6f8fa0', '#9f8f9f', '#7f9f8f']


def svg_color(layer):
    if layer in SVG_COLORS:
        return SVG_COLORS[layer]
    m = re.match(r'In(\d+)\.Cu$', layer)
    return INNER_COLORS[(int(m.group(1)) - 1) % len(INNER_COLORS)] if m else '#9a9082'


def svgs(board, out_dir, name):
    """One SVG per layer, board area only, in its viewer colour, drawn in draw
    order: back first."""
    n = pcbnew.LoadBoard(board).GetCopperLayerCount()
    layers = ['B.Fab', 'B.Silkscreen', 'B.Cu'] + ['In%d.Cu' % i for i in range(n - 2, 0, -1)] + \
             ['F.Cu', 'F.Silkscreen', 'F.Fab', 'Edge.Cuts']
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
            with open(os.path.join(tmp, src[0])) as f:
                txt = f.read()
            with open(dst, 'w') as f:
                f.write(re.sub(r'#000000', svg_color(l), txt, flags=re.I))
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


FINISH_NAMES = {'hasl': 'HASL (with lead)', 'lead-free-hasl': 'lead-free HASL', 'enig': 'ENIG'}


def package(d, out_dir, name, artifacts):
    """The order package: every file a fab asks for, in the folder of the
    upload it goes to, and a README saying which is which and the board
    settings to pick.  The Gerber zip goes in unchanged: the fabs read it flat.

      README.txt
      board/<slug>-gerbers.zip
      assembly/jlcpcb/   BOM + CPL
      assembly/pcbway/   BOM + the same CPL
      netlist/<slug>.ipc
      3d/<slug>-step.zip  when a STEP model was made
    """
    f = lambda suffix: os.path.join(out_dir, name + suffix)
    gerb, bom, bom_pw, cpl, ipc = (f('-gerbers.zip'), f('-bom-jlcpcb.csv'), f('-bom-pcbway.csv'),
                                   f('-cpl-jlcpcb.csv'), f('.ipc'))
    step = [os.path.join(out_dir, a['name']) for a in artifacts if a['kind'] == 'step']
    files = [('board/', gerb), ('assembly/jlcpcb/', bom), ('assembly/jlcpcb/', cpl), ('assembly/pcbway/', bom_pw),
             ('assembly/pcbway/', cpl), ('netlist/', ipc)] + [('3d/', p) for p in step]
    with open(cpl) as fh:
        rows = list(csv.DictReader(fh))
    sides = sorted({r['Layer'].lower() for r in rows})
    bd = d['board']
    oz = bd.get('copper_oz') or {'outer': 1, 'inner': 0.5}
    with open(bom) as fh:
        lines = sum(1 for _ in csv.DictReader(fh))
    assembly = ('%s side%s, %d parts (%d different)' % (' and '.join(sides), 's' if len(sides) > 1 else '', len(rows), lines)
                if rows else 'none: no part is marked for assembly')
    g = lambda p: os.path.basename(p)
    readme = [
        '%s %s: order files from HardHub' % (d.get('name', 'Board'), d.get('revision', '')),
        '',
        'BOARD SETTINGS TO PICK WHEN YOU ORDER',
        '  Copper layers:   %d' % bd['layers'],
        '  Size:            %g x %g mm' % (bd['width'], bd['height']),
        '  Thickness:       %g mm' % bd.get('thickness', 1.6),
        '  Solder mask:     %s' % bd.get('mask_color', 'green'),
        '  Surface finish:  %s' % FINISH_NAMES.get(bd.get('finish'), bd.get('finish', 'lead-free HASL')),
        '  Copper weight:   %g oz outside%s' % (oz['outer'], (', %g oz inside' % oz['inner']) if bd['layers'] > 2 else ''),
        '  Assembly:        %s' % assembly,
        '',
        'WHAT EACH FILE IS FOR',
        '  board/%s' % g(gerb),
        '      The board itself: copper, solder mask, silkscreen, outline and drill holes.',
        '      Upload this zip as it is; do not unzip it.',
        '  assembly/jlcpcb/%s' % g(bom),
        '      The parts list (BOM) for JLCPCB assembly, with LCSC part numbers.',
        '  assembly/jlcpcb/%s' % g(cpl),
        '      Where each part goes and how it is turned (CPL, pick and place).',
        '  assembly/pcbway/%s' % g(bom_pw),
        '      The parts list in PCBWay\'s columns (maker part number and LCSC number).',
        '  assembly/pcbway/%s' % g(cpl),
        '      The same placement file, for PCBWay\'s centroid (pick and place) upload.',
        '  netlist/%s' % g(ipc),
        '      IPC-D-356 netlist: the fab tests every connection against it. Optional.',
    ] + sum((['  3d/%s' % g(p), '      The board and its parts as a STEP model, for a case design. Not for the fab.'] for p in step), []) + [
        '',
        'AT JLCPCB',
        '  1. Add the Gerber file: board/%s' % g(gerb),
        '  2. Set the board settings above.',
        '  3. Turn on PCB Assembly and pick the %s side; add the BOM file' % (' and '.join(sides) or 'top'),
        '     assembly/jlcpcb/%s and the CPL file assembly/jlcpcb/%s.' % (g(bom), g(cpl)),
        '',
        'AT PCBWAY',
        '  1. Upload the Gerber file: board/%s' % g(gerb),
        '  2. Set the board settings above.',
        '  3. Add assembly; upload the BOM assembly/pcbway/%s' % g(bom_pw),
        '     and the centroid file assembly/pcbway/%s.' % g(cpl),
        '  4. For their netlist test, add netlist/%s if they ask for one.' % g(ipc),
        '',
    ]
    zp = os.path.join(out_dir, '%s-package.zip' % name)
    with zipfile.ZipFile(zp, 'w', zipfile.ZIP_DEFLATED) as z:
        z.writestr('README.txt', '\n'.join(readme))
        for folder, path in files:
            z.write(path, folder + os.path.basename(path))
    return zp
