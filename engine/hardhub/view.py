# SPDX-License-Identifier: AGPL-3.0-or-later
"""Looking at a built board, for an AI (or a person) checking its work.

    view_2d(pcb, ...)   any layers, top or bottom, a region, a net or parts
                        highlighted, millimetre axes in board coordinates
    view_3d(pcb, ...)   KiCad's 3D render from any angle
    inspect(pcb, ...)   parts, nets and DRC findings as data

The 2D view is drawn here from KiCad's own shapes (every pad, track, zone
fill, silkscreen line and letter as polygons), so it can be cropped,
highlighted and labelled exactly; librsvg turns the SVG into a PNG.
Coordinates everywhere are the design's: millimetres from the board centre,
x right, y down.
"""
import ctypes
import glob
import json
import math
import os
import shutil
import subprocess
import tempfile
import zipfile
from xml.sax.saxutils import escape

import pcbnew

from . import kicad as K

# ---------------------------------------------------------------- the board

def board_path(job_dir, kicad_zip=None):
    """The routed .kicad_pcb of a job: unpacked once from its KiCad zip (the
    one the build made, or one the caller sends when the engine has lost the
    job, as a Cloudflare container does on restart)."""
    dst = os.path.join(job_dir, 'board')
    found = glob.glob(os.path.join(dst, '*.kicad_pcb'))
    if found:
        return found[0]
    src = kicad_zip
    if src is None:
        zips = glob.glob(os.path.join(job_dir, 'files', '*-kicad.zip'))
        if not zips:
            return None
        src = zips[0]
    tmp = tempfile.mkdtemp(dir=job_dir if os.path.isdir(job_dir) else None)
    with zipfile.ZipFile(src) as z:
        for n in z.namelist():
            # only the board's own files, flat: nothing outside the folder
            if os.path.basename(n) == n and n.endswith(('.kicad_pcb', '.kicad_pro', '.kicad_dru')):
                z.extract(n, tmp)
    if not glob.glob(os.path.join(tmp, '*.kicad_pcb')):
        shutil.rmtree(tmp, ignore_errors=True)
        return None
    os.makedirs(job_dir, exist_ok=True)
    shutil.rmtree(dst, ignore_errors=True)
    os.rename(tmp, dst)
    return glob.glob(os.path.join(dst, '*.kicad_pcb'))[0]


# ---------------------------------------------------------------- layers

LAYER_ORDER_TOP = ['B.Fab', 'B.Courtyard', 'B.Silkscreen', 'B.Mask', 'B.Paste', 'B.Cu', 'INNER', 'F.Cu', 'F.Paste', 'F.Mask',
                   'F.Silkscreen', 'F.Courtyard', 'F.Fab', 'Edge.Cuts']
OTHER_LAYERS = {'F.Silkscreen', 'B.Silkscreen', 'F.Mask', 'B.Mask', 'F.Paste', 'B.Paste', 'F.Fab', 'B.Fab',
                'F.Courtyard', 'B.Courtyard', 'Edge.Cuts'}
COLORS = {'F.Cu': '#c9a25c', 'B.Cu': '#6d8db2', 'F.Silkscreen': '#f1ece0', 'B.Silkscreen': '#cfc6b4',
          'F.Mask': '#3d6b4f', 'B.Mask': '#3d5a6b', 'F.Paste': '#9aa3ad', 'B.Paste': '#8a939d',
          'F.Fab': '#b3a58c', 'B.Fab': '#8f8470', 'F.Courtyard': '#d08ac0', 'B.Courtyard': '#a07ab0',
          'Edge.Cuts': '#e8d9b0'}
INNER = ['#7f9460', '#9c7468', '#8a7fa8', '#5f9a94', '#a8925f', '#7d8a9c', '#9c8a70', '#6f9a7a',
         '#a07890', '#7f8f5f', '#8f7f6f', '#6f8fa0', '#9f8f9f', '#7f9f8f']
BG, BOARD_BG, GRID, AXIS, ACCENT = '#16130f', '#221e18', '#3a342b', '#a89f8e', '#ff6a1a'
MAX_ERR = 5000                                              # nm: 5 um curve error


def copper_names(b):
    return K.copper_names(b.GetCopperLayerCount())


def color(layer):
    if layer in COLORS:
        return COLORS[layer]
    if layer.startswith('In') and layer.endswith('.Cu'):
        return INNER[(int(layer[2:-3]) - 1) % len(INNER)]
    return '#9a9082'


def valid_layers(b):
    return copper_names(b) + sorted(OTHER_LAYERS)


def draw_order(b, layers, side):
    """Back to front for the side being looked at."""
    order = []
    inner = [l for l in copper_names(b)[1:-1]]
    for l in LAYER_ORDER_TOP:
        if l == 'INNER':
            order += list(reversed(inner))
        else:
            order.append(l)
    if side == 'bottom':
        # seen from below: the stack reversed, the outline still on top
        order = list(reversed(order[:-1])) + ['Edge.Cuts']
    return [l for l in order if l in layers]


# ---------------------------------------------------------------- geometry

def _poly_path(ps, flip):
    """SHAPE_POLY_SET -> SVG path data in board mm (y down; x mirrored for a bottom view)."""
    out = []

    def chain(c):
        n = c.PointCount()
        if n < 2:
            return
        pts = []
        for i in range(n):
            p = c.CPoint(i)
            x, y = p.x / 1e6 - K.CX, p.y / 1e6 - K.CY
            pts.append('%.4f %.4f' % (-x if flip else x, y))
        out.append('M' + ' L'.join(pts) + 'Z')

    for i in range(ps.OutlineCount()):
        chain(ps.Outline(i))
        for j in range(ps.HoleCount(i)):
            chain(ps.Hole(i, j))
    return ' '.join(out)


def _shape(item, layer_id):
    ps = pcbnew.SHAPE_POLY_SET()
    if hasattr(item, 'TransformTextToPolySet'):
        # text: its letters, not the box round them
        item.TransformTextToPolySet(ps, 0, MAX_ERR, pcbnew.ERROR_INSIDE)
        return ps
    try:
        item.TransformShapeToPolygon(ps, layer_id, 0, MAX_ERR, pcbnew.ERROR_INSIDE)
    except TypeError:
        item.TransformShapeToPolygon(ps, layer_id, 0, MAX_ERR, pcbnew.ERROR_INSIDE, False)
    return ps


def _items_on(b, layer, layer_id):
    """(net, item kind, polygon set) for everything drawn on one layer."""
    is_cu = layer.endswith('.Cu')
    for z in b.Zones():
        if is_cu and z.IsOnLayer(layer_id) and not z.GetIsRuleArea():
            yield z.GetNetname(), 'zone', z.GetFilledPolysList(layer_id)
    for t in b.GetTracks():
        if t.IsOnLayer(layer_id):
            yield t.GetNetname(), ('via' if t.GetClass() == 'PCB_VIA' else 'track'), _shape(t, layer_id)
    for fp in b.GetFootprints():
        for p in fp.Pads():
            if p.IsOnLayer(layer_id):
                yield p.GetNetname(), 'pad', _shape(p, layer_id)
        if not is_cu:
            for it in list(fp.GraphicalItems()) + [fp.Reference(), fp.Value()]:
                if it.GetLayer() == layer_id and (not hasattr(it, 'IsVisible') or it.IsVisible()):
                    yield '', 'graphic', _shape(it, layer_id)
    for d in b.GetDrawings():
        if d.GetLayer() == layer_id:
            yield '', 'graphic', _shape(d, layer_id)


def _holes(b):
    """(x, y, radius) of every drilled hole, board mm."""
    out = []
    for t in b.GetTracks():
        if t.GetClass() == 'PCB_VIA':
            x, y = K.xy(t.GetPosition())
            out.append((x, y, t.GetDrillValue() / 2e6))
    for fp in b.GetFootprints():
        for p in fp.Pads():
            d = p.GetDrillSize()
            if d.x > 0:
                x, y = K.xy(p.GetPosition())
                out.append((x, y, min(d.x, d.y) / 2e6))
    return out


def _bounds(b):
    bb = b.GetBoardEdgesBoundingBox()
    if bb.GetWidth() == 0:
        bb = b.ComputeBoundingBox(False)
    return (bb.GetX() / 1e6 - K.CX, bb.GetY() / 1e6 - K.CY,
            bb.GetRight() / 1e6 - K.CX, bb.GetBottom() / 1e6 - K.CY)


def _nice_step(span):
    for s in (0.5, 1, 2, 5, 10, 20, 50, 100):
        if span / s <= 12:
            return s
    return 200


# ---------------------------------------------------------------- 2D

def view_2d(pcb, layers=None, side='top', region=None, net=None, refs=None, labels=None, width=1400):
    """PNG of the chosen layers. region: [x0, y0, x1, y1] board mm. labels: part names
    drawn over the view; by default only when that side's silkscreen is not shown."""
    b = pcbnew.LoadBoard(pcb)
    allowed = valid_layers(b)
    side = 'bottom' if side == 'bottom' else 'top'
    if not layers:
        layers = (['F.Cu', 'F.Silkscreen', 'Edge.Cuts'] if side == 'top' else ['B.Cu', 'B.Silkscreen', 'Edge.Cuts'])
    bad = [l for l in layers if l not in allowed]
    if bad:
        raise ValueError('unknown layer(s) %s; this board has %s' % (', '.join(bad), ', '.join(allowed)))
    refs = [r for r in (refs or [])]
    fps = {fp.GetReference(): fp for fp in b.GetFootprints()}
    missing = [r for r in refs if r not in fps]
    if missing:
        raise ValueError('no part %s on the board' % ', '.join(missing))
    if net and net not in {str(k) for k in b.GetNetsByName().keys()}:
        raise ValueError('no net %s on the board' % net)
    flip = side == 'bottom'
    if labels is None:
        labels = ('B.Silkscreen' if flip else 'F.Silkscreen') not in layers

    bx0, by0, bx1, by1 = _bounds(b)
    if region:
        x0, y0, x1, y1 = [float(v) for v in region]
        x0, x1 = sorted((x0, x1))
        y0, y1 = sorted((y0, y1))
        if x1 - x0 < 0.5 or y1 - y0 < 0.5:
            raise ValueError('region must be at least 0.5 mm wide and tall')
    else:
        x0, y0, x1, y1 = bx0 - 2, by0 - 2, bx1 + 2, by1 + 2
    if flip:
        x0, x1 = -x1, -x0
    span_x, span_y = x1 - x0, y1 - y0
    width = max(400, min(int(width), 2000))
    scale = width / span_x
    height = int(span_y * scale)
    if height > 2000:
        scale = 2000 / span_y
        height, width = 2000, int(span_x * scale)
    ml, mt, mb = 56, 30, 34                                  # margins (px) for axes and the caption
    W, H = width + ml + 12, height + mt + mb

    def sx(x):
        return ml + (x - x0) * scale

    def sy(y):
        return mt + (y - y0) * scale

    svg = ['<svg xmlns="http://www.w3.org/2000/svg" width="%d" height="%d" viewBox="0 0 %d %d">' % (W, H, W, H),
           '<rect width="100%%" height="100%%" fill="%s"/>' % BG,
           '<defs><clipPath id="v"><rect x="%d" y="%d" width="%d" height="%d"/></clipPath></defs>' % (ml, mt, width, height)]
    # everything in board mm inside one transform: the view region mapped to pixels
    g = '<g clip-path="url(#v)"><g transform="translate(%.3f %.3f) scale(%.5f) translate(%.4f %.4f)">' % (ml, mt, scale, -x0, -y0)
    svg.append(g)
    outline = pcbnew.SHAPE_POLY_SET()
    try:
        ok = b.GetBoardPolygonOutlines(outline, True)
    except TypeError:
        ok = b.GetBoardPolygonOutlines(outline)
    if ok and outline.OutlineCount():
        svg.append('<path d="%s" fill="%s" fill-rule="evenodd"/>' % (_poly_path(outline, flip), BOARD_BG))

    order = draw_order(b, layers, side)
    front = 'F.Cu' if side == 'top' else 'B.Cu'
    dim = bool(net or refs)
    for layer in order:
        lid = b.GetLayerID(layer)
        col = color(layer)
        is_cu = layer.endswith('.Cu')
        if layer == 'Edge.Cuts':
            paths = [_poly_path(ps, flip) for _, _, ps in _items_on(b, layer, lid)]
            svg.append('<path d="%s" fill="%s" fill-rule="nonzero"/>' % (' '.join(paths), col))
            continue
        # copper on the far side shows through faintly, as in KiCad
        op = 1.0 if (not is_cu or layer == front or len([l for l in order if l.endswith('.Cu')]) == 1) else 0.45
        if dim:
            op *= 0.4
        groups = {'zone': [], 'other': []}
        hl = []
        for n, kind, ps in _items_on(b, layer, lid):
            d = _poly_path(ps, flip)
            if not d:
                continue
            if net and is_cu and n == net:
                hl.append(d)
            groups['zone' if kind == 'zone' else 'other'].append(d)
        if groups['zone']:
            svg.append('<path d="%s" fill="%s" fill-opacity="%.2f" fill-rule="evenodd"/>' % (' '.join(groups['zone']), col, op * 0.55))
        if groups['other']:
            svg.append('<path d="%s" fill="%s" fill-opacity="%.2f" fill-rule="nonzero"/>' % (' '.join(groups['other']), col, op))
        if hl:
            svg.append('<path d="%s" fill="%s" fill-rule="nonzero" stroke="#fff3e0" stroke-width="%.4f"/>' % (' '.join(hl), ACCENT, 1.2 / scale))
    if any(l.endswith('.Cu') for l in order):
        holes = ''.join('<circle cx="%.4f" cy="%.4f" r="%.4f"/>' % ((-x if flip else x), y, r) for x, y, r in _holes(b))
        svg.append('<g fill="%s">%s</g>' % (BG, holes))
    # parts asked about: their outline, bright
    for r in refs:
        fp = fps[r]
        bb = fp.GetBoundingBox(False, False) if _takes_two(fp) else fp.GetBoundingBox(False)
        ax0, ay0 = bb.GetX() / 1e6 - K.CX, bb.GetY() / 1e6 - K.CY
        ax1, ay1 = bb.GetRight() / 1e6 - K.CX, bb.GetBottom() / 1e6 - K.CY
        if flip:
            ax0, ax1 = -ax1, -ax0
        svg.append('<rect x="%.4f" y="%.4f" width="%.4f" height="%.4f" fill="%s" fill-opacity="0.18" stroke="%s" stroke-width="%.4f"/>'
                   % (ax0, ay0, ax1 - ax0, ay1 - ay0, ACCENT, ACCENT, 2 / scale))
    svg.append('</g></g>')

    # part names, in pixels so they stay readable at any zoom
    if labels:
        size = 11
        for ref, fp in fps.items():
            if (side == 'top') == fp.IsFlipped() and ref not in refs:
                continue                                   # parts on the far side are not labelled
            x, y = K.xy(fp.GetPosition())
            px, py = sx(-x if flip else x), sy(y)
            if ml <= px <= ml + width and mt <= py <= mt + height:
                hot = ref in refs
                svg.append('<text x="%.1f" y="%.1f" font-family="DejaVu Sans Mono" font-size="%d" font-weight="bold" text-anchor="middle" '
                           'dominant-baseline="middle" fill="%s" stroke="%s" stroke-width="3" paint-order="stroke">%s</text>'
                           % (px, py, size + (2 if hot else 0), ACCENT if hot else '#ffffff', BG, escape(ref)))

    # millimetre grid and axes (board coordinates; the bottom view's x runs mirrored)
    step = _nice_step(max(span_x, span_y))
    gx = math.ceil(x0 / step) * step
    while gx <= x1 + 1e-9:
        X = sx(gx)
        svg.append('<line x1="%.1f" y1="%d" x2="%.1f" y2="%d" stroke="%s" stroke-width="1" stroke-opacity="0.55"/>' % (X, mt, X, mt + height, GRID))
        svg.append('<text x="%.1f" y="%d" font-family="DejaVu Sans Mono" font-size="11" fill="%s" text-anchor="middle">%g</text>'
                   % (X, mt - 9, AXIS, round(-gx if flip else gx, 3)))
        gx += step
    gy = math.ceil(y0 / step) * step
    while gy <= y1 + 1e-9:
        Y = sy(gy)
        svg.append('<line x1="%d" y1="%.1f" x2="%d" y2="%.1f" stroke="%s" stroke-width="1" stroke-opacity="0.55"/>' % (ml, Y, ml + width, Y, GRID))
        svg.append('<text x="%d" y="%.1f" font-family="DejaVu Sans Mono" font-size="11" fill="%s" text-anchor="end" dominant-baseline="middle">%g</text>'
                   % (ml - 6, Y, AXIS, round(gy, 3)))
        gy += step
    caption = '%s view (%s) | %s | mm from board centre, grid %g mm%s%s' % (
        side.capitalize(), 'seen from below, x mirrored' if flip else 'seen from above', ', '.join(order), step,
        ' | net %s highlighted' % net if net else '', ' | %s outlined' % ', '.join(refs) if refs else '')
    svg.append('<text x="%d" y="%d" font-family="DejaVu Sans Mono" font-size="12" fill="%s">%s</text>' % (ml, H - 12, AXIS, escape(caption)))
    svg.append('</svg>')
    return rasterize('\n'.join(svg), W, H)


def _takes_two(fp):
    try:
        fp.GetBoundingBox(False, False)
        return True
    except TypeError:
        return False


# ---------------------------------------------------------------- SVG -> PNG (librsvg + cairo, no Python package)

class _Rect(ctypes.Structure):
    _fields_ = [('x', ctypes.c_double), ('y', ctypes.c_double), ('width', ctypes.c_double), ('height', ctypes.c_double)]


def rasterize(svg, w, h):
    rsvg = ctypes.CDLL('librsvg-2.so.2')
    cairo = ctypes.CDLL('libcairo.so.2')
    rsvg.rsvg_handle_new_from_data.restype = ctypes.c_void_p
    rsvg.rsvg_handle_new_from_data.argtypes = [ctypes.c_char_p, ctypes.c_size_t, ctypes.POINTER(ctypes.c_void_p)]
    rsvg.rsvg_handle_render_document.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.POINTER(_Rect), ctypes.POINTER(ctypes.c_void_p)]
    rsvg.rsvg_handle_render_document.restype = ctypes.c_int
    cairo.cairo_image_surface_create.restype = ctypes.c_void_p
    cairo.cairo_image_surface_create.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_int]
    cairo.cairo_create.restype = ctypes.c_void_p
    cairo.cairo_create.argtypes = [ctypes.c_void_p]
    cairo.cairo_surface_write_to_png.argtypes = [ctypes.c_void_p, ctypes.c_char_p]
    cairo.cairo_destroy.argtypes = [ctypes.c_void_p]
    cairo.cairo_surface_destroy.argtypes = [ctypes.c_void_p]
    gobj = ctypes.CDLL('libgobject-2.0.so.0')
    gobj.g_object_unref.argtypes = [ctypes.c_void_p]

    data = svg.encode()
    err = ctypes.c_void_p()
    handle = rsvg.rsvg_handle_new_from_data(data, len(data), ctypes.byref(err))
    if not handle:
        raise RuntimeError('the view could not be drawn (SVG rejected)')
    surface = cairo.cairo_image_surface_create(0, int(w), int(h))   # CAIRO_FORMAT_ARGB32
    cr = cairo.cairo_create(surface)
    try:
        if not rsvg.rsvg_handle_render_document(handle, cr, ctypes.byref(_Rect(0, 0, w, h)), ctypes.byref(err)):
            raise RuntimeError('the view could not be drawn')
        fd, path = tempfile.mkstemp(suffix='.png')
        os.close(fd)
        try:
            if cairo.cairo_surface_write_to_png(surface, path.encode()) != 0:
                raise RuntimeError('the view could not be saved')
            with open(path, 'rb') as f:
                return f.read()
        finally:
            os.remove(path)
    finally:
        cairo.cairo_destroy(cr)
        cairo.cairo_surface_destroy(surface)
        gobj.g_object_unref(handle)


# ---------------------------------------------------------------- 3D

SIDES_3D = ('top', 'bottom', 'left', 'right', 'front', 'back')


def view_3d(pcb, side='top', rotate=None, zoom=1.0, pan=None, perspective=False, width=1200, height=900, quality='basic'):
    """KiCad's 3D render, PNG. rotate: [x, y, z] degrees, e.g. [-45, 0, 45] for isometric."""
    if side not in SIDES_3D:
        raise ValueError('side must be one of %s' % ', '.join(SIDES_3D))
    width, height = max(200, min(int(width), 1600)), max(200, min(int(height), 1600))
    zoom = max(0.2, min(float(zoom), 10.0))
    fd, out = tempfile.mkstemp(suffix='.png')
    os.close(fd)
    cmd = ['kicad-cli', 'pcb', 'render', '--side', side, '--width', str(width), '--height', str(height),
           '--quality', 'high' if quality == 'high' else 'basic', '--use-board-stackup-colors', '--background', 'opaque',
           '--zoom', '%g' % zoom, '--output', out]
    if rotate:
        cmd += ['--rotate', ','.join('%g' % max(-360, min(360, float(a))) for a in list(rotate)[:3])]
    if pan:
        cmd += ['--pan', ','.join('%g' % max(-100, min(100, float(a))) for a in list(pan)[:3])]
    if perspective:
        cmd.append('--perspective')
    try:
        r = subprocess.run(cmd + [pcb], capture_output=True, text=True, timeout=300)
        if r.returncode != 0 or not os.path.getsize(out):
            raise RuntimeError('KiCad could not render the board: %s' % (r.stderr or r.stdout)[-300:])
        with open(out, 'rb') as f:
            return f.read()
    finally:
        os.remove(out)


# ---------------------------------------------------------------- data

def inspect(pcb, what=('parts', 'nets', 'drc'), refs=None, nets=None):
    b = pcbnew.LoadBoard(pcb)
    out = {}
    x0, y0, x1, y1 = _bounds(b)
    out['board'] = dict(width=round(x1 - x0, 3), height=round(y1 - y0, 3), copper_layers=b.GetCopperLayerCount(),
                        layers=valid_layers(b))
    if 'parts' in what:
        parts = []
        for fp in b.GetFootprints():
            if refs and fp.GetReference() not in refs:
                continue
            x, y = K.xy(fp.GetPosition())
            bb = fp.GetBoundingBox(False, False) if _takes_two(fp) else fp.GetBoundingBox(False)
            parts.append(dict(ref=fp.GetReference(), value=fp.GetValue(), footprint='%s:%s' % (fp.GetFPID().GetLibNickname(), fp.GetFPID().GetLibItemName()),
                              x=round(x, 3), y=round(y, 3), rot=round(fp.GetOrientationDegrees(), 2),
                              side='bottom' if fp.IsFlipped() else 'top',
                              size=[round(bb.GetWidth() / 1e6, 2), round(bb.GetHeight() / 1e6, 2)],
                              pads=len(fp.Pads())))
        out['parts'] = sorted(parts, key=lambda p: (p['ref'].rstrip('0123456789'), int(''.join(c for c in p['ref'] if c.isdigit()) or 0)))
    if 'nets' in what:
        stats = {}
        for name in b.GetNetsByName().keys():
            name = str(name)
            if name and (not nets or name in nets):
                stats[name] = dict(name=name, pads=[], track_mm=0.0, vias=0, layers=set())
        for fp in b.GetFootprints():
            for p in fp.Pads():
                s = stats.get(p.GetNetname())
                if s is not None:
                    s['pads'].append('%s.%s' % (fp.GetReference(), p.GetNumber()))
        for t in b.GetTracks():
            s = stats.get(t.GetNetname())
            if s is None:
                continue
            if t.GetClass() == 'PCB_VIA':
                s['vias'] += 1
            else:
                s['track_mm'] += t.GetLength() / 1e6
                s['layers'].add(b.GetLayerName(t.GetLayer()))
        for z in b.Zones():
            s = stats.get(z.GetNetname())
            if s is not None and not z.GetIsRuleArea():
                s['layers'] |= {b.GetLayerName(l) + ' (pour)' for l in z.GetLayerSet().Seq()}
        out['nets'] = [dict(s, track_mm=round(s['track_mm'], 2), layers=sorted(s['layers'])) for s in
                       sorted(stats.values(), key=lambda s: s['name'])]
    if 'drc' in what:
        tmp = tempfile.mkdtemp()
        try:
            copy = os.path.join(tmp, os.path.basename(pcb))
            shutil.copy(pcb, copy)
            for ext in ('.kicad_pro', '.kicad_dru'):
                src = pcb[:-len('.kicad_pcb')] + ext
                if os.path.exists(src):
                    shutil.copy(src, copy[:-len('.kicad_pcb')] + ext)
            errs, warns, unconnected = K.drc(copy, os.path.join(tmp, 'drc.json'))
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

        def item(v):
            pos = [it.get('pos') for it in v.get('items', []) if it.get('pos')]
            p = pos[0] if pos else None
            return dict(type=v.get('type'), severity=v.get('severity'), what=v.get('description'),
                        at=[round(p['x'] - K.CX, 3), round(p['y'] - K.CY, 3)] if p else None,
                        items=[it.get('description', '')[:120] for it in v.get('items', [])][:3])
        out['drc'] = dict(errors=len(errs), warnings=len(warns), unconnected=len(unconnected),
                          findings=[item(v) for v in (errs + [dict(u, severity='unconnected') for u in unconnected] + warns)][:100])
    return out
