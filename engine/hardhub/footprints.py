# SPDX-License-Identifier: AGPL-3.0-or-later
"""Footprints: find one by its KiCad id ("Library:Name"), fetching the fab's
own land pattern when it is an LCSC part HardHub has not seen yet.

Libraries, in the order they are searched:

  hh:<LCSC id>   e.g. hh:C2913198 -- JLCPCB/EasyEDA's footprint for that exact
                 part, converted with easyeda2kicad and cleaned (below), cached
                 in $HARDHUB_FP_CACHE/hh.pretty.  Using the fab's own entry
                 gives the pad numbering and 0-degree orientation the assembly
                 line uses, so the CPL needs no per-part rotation.
  hh:MOUNT_M3, hh:PAD_TP
                 generated here (mounting hole, plated test pad)
  <lib>:<name>   $HARDHUB_FP_PATHS ("lib=/path/lib.pretty;...") then KiCad's
                 standard libraries in /usr/share/kicad/footprints

The cleaner comes from offgrid-hardware print-hub/v1/src/footprints.py: the
courtyard is rebuilt as the box round pads and body + 0.10 mm, silkscreen is
dropped (the assembly drawing carries outlines), plain-rectangle custom pads
become rect pads, unnumbered plated holes become non-plated pegs.
"""
import os
import re

import pcbnew

MM = pcbnew.FromMM
STD = os.environ.get('KICAD_FOOTPRINTS', '/usr/share/kicad/footprints')
CACHE = os.environ.get('HARDHUB_FP_CACHE', os.path.expanduser('~/.cache/hardhub'))
HH = os.path.join(CACHE, 'hh.pretty')
HH3D = os.path.join(CACHE, 'hh.3dshapes')

HOLE_D, HOLE_KEEP = 3.2, 3.5          # M3 clearance hole; no part under the screw head


class FootprintError(Exception):
    pass


def _save(lib, fp):
    # pcbnew.FootprintSave() guesses the plugin from the library's files and
    # finds none in an empty .pretty folder; ask for KiCad's own format
    pcbnew.PCB_IO_MGR.FindPlugin(pcbnew.PCB_IO_MGR.KICAD_SEXP).FootprintSave(lib, fp)


def extra_libs():
    out = {}
    for item in os.environ.get('HARDHUB_FP_PATHS', '').split(';'):
        if '=' in item:
            k, v = item.split('=', 1)
            out[k.strip()] = v.strip()
    return out


def lib_path(lib):
    if lib == 'hh':
        return HH
    x = extra_libs()
    if lib in x:
        return x[lib]
    return os.path.join(STD, lib + '.pretty')


def exists(fpid):
    lib, name = fpid.split(':', 1)
    if lib == 'hh' and name in GENERATED:
        return True
    return os.path.exists(os.path.join(lib_path(lib), name + '.kicad_mod'))


def load(fpid, fetch=True):
    """A fresh FOOTPRINT for fpid; fetches hh:C<n> parts on first use."""
    lib, name = fpid.split(':', 1)
    if lib == 'hh':
        os.makedirs(HH, exist_ok=True)
        if not os.path.exists(os.path.join(HH, name + '.kicad_mod')):
            if name in GENERATED:
                _save(HH, GENERATED[name]())
            elif re.fullmatch(r'C\d+', name) and fetch:
                fetch_lcsc(name)
            else:
                raise FootprintError('footprint %s is not in the cache' % fpid)
    path = lib_path(lib)
    if not os.path.exists(os.path.join(path, name + '.kicad_mod')):
        raise FootprintError('no footprint %s (looked in %s)' % (fpid, path))
    fp = pcbnew.FootprintLoad(path, name)
    if fp is None:
        raise FootprintError('KiCad could not read footprint %s' % fpid)
    fp.SetFPID(pcbnew.LIB_ID(lib, name))
    return fp


def pads(fpid):
    """Copper pad numbers of a footprint (numbered pads only)."""
    fp = load(fpid)
    return {p.GetNumber() for p in fp.Pads() if p.GetNumber() and p.GetAttribute() != pcbnew.PAD_ATTRIB_NPTH}


# ---------------------------------------------------------------- EasyEDA
def fetch_lcsc(lcsc):
    """Fetch, convert and clean the fab's footprint (and 3D model) for one
    LCSC part into the hh cache.  Needs easyeda.com and modules.easyeda.com."""
    try:
        from easyeda2kicad.easyeda.easyeda_api import EasyedaApi
        from easyeda2kicad.easyeda.easyeda_importer import EasyedaFootprintImporter, Easyeda3dModelImporter
        from easyeda2kicad.kicad.export_kicad_footprint import ExporterFootprintKicad
        from easyeda2kicad.kicad.export_kicad_3d_model import Exporter3dModelKicad
    except ImportError as e:
        raise FootprintError('easyeda2kicad is not installed: %s' % e)
    api = EasyedaApi()
    data = api.get_cad_data_of_component(lcsc_id=lcsc)
    if not data:
        raise FootprintError('EasyEDA has no CAD data for %s' % lcsc)
    raw_dir = os.path.join(CACHE, 'raw')
    os.makedirs(raw_dir, exist_ok=True)
    os.makedirs(HH3D, exist_ok=True)
    ee = EasyedaFootprintImporter(easyeda_cp_cad_data=data).get_footprint()
    raw = os.path.join(raw_dir, lcsc + '.kicad_mod')
    ExporterFootprintKicad(footprint=ee).export(footprint_full_path=raw, model_3d_path=HH3D)
    model = None
    try:
        m = Exporter3dModelKicad(model_3d=Easyeda3dModelImporter(easyeda_cp_cad_data=data, download_raw_3d_model=True,
                                                                  api=api).output)
        if m.output and m.export(output_dir=HH3D, overwrite=True):
            model = m.output.name
    except Exception:                 # a part without a model still gets its land
        model = None
    clean(raw, lcsc, model)
    return 'hh:' + lcsc


# a minimal s-expression reader/writer, so the EasyEDA files can be edited
# as data (pcbnew's Remove() leaves the SWIG pad list unusable)
def _parse(s):
    toks = re.findall(r'\(|\)|"(?:[^"\\]|\\.)*"|[^\s()]+', s)
    st = [[]]
    for t in toks:
        if t == '(':
            st.append([])
        elif t == ')':
            x = st.pop(); st[-1].append(x)
        else:
            st[-1].append(t)
    return st[0][0]


def _emit(n, ind=0):
    if not isinstance(n, list):
        return n
    if all(not isinstance(c, list) for c in n):
        return '(' + ' '.join(n) + ')'
    out = '(' + n[0]
    for c in n[1:]:
        out += ('\n' + '\t' * (ind + 1) + _emit(c, ind + 1)) if isinstance(c, list) else ' ' + c
    return out + '\n' + '\t' * ind + ')'


def _get(n, key):
    for c in n:
        if isinstance(c, list) and c and c[0] == key:
            return c
    return None


def _poly_pts(p):
    g = _get(_get(p, 'primitives'), 'gr_poly')
    return [(float(q[1]), float(q[2])) for q in _get(g, 'pts')[1:]]


def _area(pts):
    return abs(sum(a[0] * b[1] - b[0] * a[1] for a, b in zip(pts, pts[1:] + pts[:1]))) / 2


def _pad_box(p):
    at, size = _get(p, 'at'), _get(p, 'size')
    x, y = float(at[1]), float(at[2])
    w, h = float(size[1]), float(size[2])
    if len(at) > 3 and round(float(at[3])) % 180 == 90:
        w, h = h, w
    if p[3] == 'custom':
        pts = _poly_pts(p)
        return (x + min(q[0] for q in pts), y + min(q[1] for q in pts),
                x + max(q[0] for q in pts), y + max(q[1] for q in pts))
    return (x - w / 2, y - h / 2, x + w / 2, y + h / 2)


def _item_box(it):
    xs, ys = [], []
    for k in ('start', 'end', 'center', 'mid'):
        c = _get(it, k)
        if c:
            xs.append(float(c[1])); ys.append(float(c[2]))
    return (min(xs), min(ys), max(xs), max(ys)) if xs else None


def _line(x0, y0, x1, y1, layer, w):
    return ['fp_line', ['start', '%.3f' % x0, '%.3f' % y0], ['end', '%.3f' % x1, '%.3f' % y1],
            ['layer', layer], ['width', '%.3f' % w]]


def clean(path, name, model=None):
    """Clean an easyeda2kicad footprint into hh.pretty as <name>."""
    t = _parse(open(path).read())
    out = ['footprint', '"%s"' % name]
    boxes = []
    for c in t[2:]:
        if not isinstance(c, list):
            continue
        k = c[0]
        if k in ('fp_line', 'fp_circle', 'fp_arc', 'fp_poly'):
            lay = _get(c, 'layer')[1]
            if lay in ('F.SilkS', 'Cmts.User'):
                continue
            if lay == 'F.CrtYd':            # EasyEDA's body outline -> fab layer
                _get(c, 'layer')[1] = 'F.Fab'
                w = _get(c, 'width')
                if w:
                    w[1] = '0.100'
            b = _item_box(c)
            if b:
                boxes.append(b)
            out.append(c)
        elif k == 'pad':
            if c[3] == 'custom':
                pts = _poly_pts(c)
                px = [q[0] for q in pts]; py = [q[1] for q in pts]
                bw, bh = max(px) - min(px), max(py) - min(py)
                if _area(pts) > 0.98 * bw * bh:
                    c = [x for x in c if not (isinstance(x, list) and x[0] == 'primitives')]
                    c[3] = 'rect'
                    _get(c, 'size')[1:] = ['%.3f' % bw, '%.3f' % bh]
                    cx, cy = (max(px) + min(px)) / 2, (max(py) + min(py)) / 2
                    if abs(cx) > 0.001 or abs(cy) > 0.001:
                        at = _get(c, 'at')
                        at[1] = '%.3f' % (float(at[1]) + cx); at[2] = '%.3f' % (float(at[2]) + cy)
                else:
                    # chamfered QFN corner pads: keep the polygon with no
                    # outline width (EasyEDA's 0.1 mm grows every edge)
                    w = _get(_get(_get(c, 'primitives'), 'gr_poly'), 'width')
                    if w:
                        w[1] = '0'
            if c[1] == '""' and c[2] == 'thru_hole':
                # locating pegs are drawn as plated holes with no ring;
                # they are plastic posts
                c[2] = 'np_thru_hole'
            if c[2] != 'np_thru_hole' and c[1] != '""':
                boxes.append(_pad_box(c))
            out.append(c)
        elif k == 'fp_text':
            if c[1] == 'reference':
                c[2] = 'REF**'
                _get(c, 'at')[1:] = ['0', '0']
                _get(c, 'layer')[1] = 'F.Fab'
                out.append(c)
            elif c[1] == 'value':
                out.append(c)
        elif k in ('descr', 'attr', 'property', 'layer'):
            out.append(c)
    if not boxes:
        raise FootprintError('%s: footprint has no pads' % name)
    x0 = min(b[0] for b in boxes) - 0.10; y0 = min(b[1] for b in boxes) - 0.10
    x1 = max(b[2] for b in boxes) + 0.10; y1 = max(b[3] for b in boxes) + 0.10
    for a, b in (((x0, y0), (x1, y0)), ((x1, y0), (x1, y1)), ((x1, y1), (x0, y1)), ((x0, y1), (x0, y0))):
        out.append(_line(a[0], a[1], b[0], b[1], 'F.CrtYd', 0.05))
    if model:
        step = os.path.join(HH3D, model + '.step')
        wrl = os.path.join(HH3D, model + '.wrl')
        src = step if os.path.exists(step) else wrl
        if os.path.exists(src):
            out.append(['model', '"%s"' % src, ['offset', ['xyz', '0', '0', '0']],
                        ['scale', ['xyz', '1', '1', '1']], ['rotate', ['xyz', '0', '0', '0']]])
    os.makedirs(HH, exist_ok=True)
    open(os.path.join(HH, name + '.kicad_mod'), 'w').write(_emit(out) + '\n')
    # round-trip through KiCad so the file is in its native format
    fp = pcbnew.FootprintLoad(HH, name)
    if fp is None:
        raise FootprintError('%s: KiCad could not read the cleaned footprint' % name)
    fp.SetFPID(pcbnew.LIB_ID('hh', name))
    _save(HH, fp)
    return fp


# ---------------------------------------------------------------- generated
def _rect(fp, layer, x0, y0, x1, y1, w):
    pts = [(x0, y0), (x1, y0), (x1, y1), (x0, y1)]
    for i in range(4):
        s = pcbnew.PCB_SHAPE(fp, pcbnew.SHAPE_T_SEGMENT)
        a, b = pts[i], pts[(i + 1) % 4]
        s.SetStart(pcbnew.VECTOR2I(int(a[0]), int(a[1]))); s.SetEnd(pcbnew.VECTOR2I(int(b[0]), int(b[1])))
        s.SetLayer(layer); s.SetWidth(MM(w))
        fp.Add(s)


def test_pad(d=1.6, drill=0.9):
    """Plated test pad, round on both sides: a probe or a wire reaches it
    from either side."""
    fp = pcbnew.FOOTPRINT(None)
    fp.SetFPID(pcbnew.LIB_ID('hh', 'PAD_TP'))
    fp.SetAttributes(pcbnew.FP_THROUGH_HOLE | pcbnew.FP_EXCLUDE_FROM_BOM | pcbnew.FP_EXCLUDE_FROM_POS_FILES)
    fp.SetLibDescription('Test pad, plated, %.1f mm' % d)
    p = pcbnew.PAD(fp)
    p.SetNumber('1'); p.SetAttribute(pcbnew.PAD_ATTRIB_PTH); p.SetShape(pcbnew.PAD_SHAPE_CIRCLE)
    p.SetSize(pcbnew.VECTOR2I(MM(d), MM(d))); p.SetDrillSize(pcbnew.VECTOR2I(MM(drill), MM(drill)))
    ls = pcbnew.LSET.AllCuMask(); ls.AddLayer(pcbnew.F_Mask); ls.AddLayer(pcbnew.B_Mask)
    p.SetLayerSet(ls)
    fp.Add(p)
    for lay in (pcbnew.F_CrtYd, pcbnew.B_CrtYd):
        _rect(fp, lay, -MM(d / 2 + 0.1), -MM(d / 2 + 0.1), MM(d / 2 + 0.1), MM(d / 2 + 0.1), 0.05)
    fp.Reference().SetLayer(pcbnew.F_Fab)
    fp.Value().SetVisible(False)
    return fp


def mount_m3():
    """Mounting hole for an M3 screw: 3.2 mm unplated, with a round
    courtyard on both sides the size of the head and its clearance."""
    fp = pcbnew.FOOTPRINT(None)
    fp.SetFPID(pcbnew.LIB_ID('hh', 'MOUNT_M3'))
    fp.SetAttributes(pcbnew.FP_EXCLUDE_FROM_BOM | pcbnew.FP_EXCLUDE_FROM_POS_FILES)
    fp.SetLibDescription('Mounting hole: 3.2 mm unplated, for an M3 screw; courtyard r 3.5 mm')
    p = pcbnew.PAD(fp)
    p.SetNumber(''); p.SetAttribute(pcbnew.PAD_ATTRIB_NPTH); p.SetShape(pcbnew.PAD_SHAPE_CIRCLE)
    p.SetSize(pcbnew.VECTOR2I(MM(HOLE_D), MM(HOLE_D))); p.SetDrillSize(pcbnew.VECTOR2I(MM(HOLE_D), MM(HOLE_D)))
    ls = pcbnew.LSET(); ls.AddLayer(pcbnew.F_Mask); ls.AddLayer(pcbnew.B_Mask)
    p.SetLayerSet(ls)
    fp.Add(p)
    for lay in (pcbnew.F_CrtYd, pcbnew.B_CrtYd):
        c = pcbnew.PCB_SHAPE(fp, pcbnew.SHAPE_T_CIRCLE)
        c.SetCenter(pcbnew.VECTOR2I(0, 0)); c.SetEnd(pcbnew.VECTOR2I(MM(HOLE_KEEP), 0))
        c.SetLayer(lay); c.SetWidth(MM(0.05)); fp.Add(c)
    fp.Reference().SetVisible(False); fp.Value().SetVisible(False)
    return fp


GENERATED = {'MOUNT_M3': mount_m3, 'PAD_TP': test_pad}
