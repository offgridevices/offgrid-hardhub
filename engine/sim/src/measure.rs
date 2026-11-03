// SPDX-License-Identifier: AGPL-3.0-or-later
//! `measure`: the DFM geometry numbers a board reviewer looks at — narrowest
//! track, closest copper of different nets, shorts, drills and rings, copper
//! to edge, silk and mask, track corners and acid traps, dangling copper,
//! copper balance, return paths under signals, courtyards.
//!
//! Copper is split per layer into "items" (tracks, vias, pads, each a core +
//! radius shape) and zone polygons.  A zone is never compared as one huge
//! polygon: its boundary edges go into their own spatial grid, and "is this
//! point inside the fill" is answered by a per-polygon cell raster (see
//! [`Pip`]).  So the cost follows the copper near each item, not the size of
//! the pours.

use crate::geom::{angle_between, ring_edges, seg_closest, shape_gap, BBox, Shape, P};
use crate::index::{Grid, Seen};
use crate::model::{ring, Board};
use crate::raster::Raster;
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::time::Instant;

/// Different-net copper further apart than this is never a clearance
/// question (limits are ~0.1–0.5 mm; 2 mm leaves room for "closest" to mean
/// something on sparse boards).
const R_NEAR: f64 = 2.0;
/// High-voltage pairs are reported out to this distance (creepage scale).
const R_HV: f64 = 5.0;
/// Endpoints closer than this are the same point.
const TOUCH: f64 = 1e-3;
const MAX_LIST: usize = 50;
const MAX_GEOM_LIST: usize = 200;

#[derive(Deserialize, Debug, Clone)]
#[serde(default)]
pub struct Limits {
    pub track: f64,
    pub clear: f64,
    pub via_d: f64,
    pub drill: f64,
    pub ring: f64,
    pub edge: f64,
    pub hole_clear: f64,
    pub hole_hole: f64,
    pub silk_w: f64,
    pub silk_h: f64,
    pub mask_web: f64,
}

impl Default for Limits {
    fn default() -> Self {
        Limits {
            track: 0.127,
            clear: 0.127,
            via_d: 0.5,
            drill: 0.3,
            ring: 0.13,
            edge: 0.3,
            hole_clear: 0.2,
            hole_hole: 0.25,
            silk_w: 0.15,
            silk_h: 0.8,
            mask_web: 0.1,
        }
    }
}

#[derive(Deserialize, Default, Debug)]
#[serde(default)]
pub struct Input {
    pub board: Board,
    pub limits: Limits,
    pub signal_nets: Vec<String>,
    pub ref_nets: Vec<String>,
    pub hv_nets: Vec<String>,
}

fn r4(v: f64) -> f64 {
    (v * 1e4).round() / 1e4
}

fn at(q: P) -> Value {
    json!([r4(q.x), r4(q.y)])
}

// ---------------------------------------------------------------- copper model

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Kind {
    Track,
    Via,
    Pad,
    Zone,
}

struct Obj {
    kind: Kind,
    idx: usize,
    net: u32,
}

struct Item {
    obj: u32,
    shape: Shape,
}

/// Point-in-filled-polygon in O(local edges): a raster records whether each
/// cell's centre is inside; for a query point, the parity of edge crossings
/// on the short hop from the point to its cell centre flips that answer.
struct Pip {
    bbox: BBox,
    cells: Raster,
    grid: Grid,
    edges: Vec<(P, P)>,
}

impl Pip {
    fn new(rings: &[Vec<P>], bbox: BBox) -> Pip {
        let area = bbox.width().max(1e-3) * bbox.height().max(1e-3);
        let g = (area / 40_000.0).sqrt().max(0.2);
        let mut cells = Raster::covering(bbox, g);
        cells.fill_rings(rings, 1);
        let edges: Vec<(P, P)> = rings.iter().flat_map(|r| ring_edges(r)).collect();
        let shapes: Vec<Shape> = edges.iter().map(|&(a, b)| Shape::capsule(a, b, 0.0)).collect();
        let grid = Grid::build(bbox, g, shapes.iter());
        Pip { bbox, cells, grid, edges }
    }

    fn inside(&self, q: P) -> bool {
        if !self.bbox.contains(q) {
            return false;
        }
        let Some((i, j)) = self.cells.cell_of(q) else { return false };
        let c = self.cells.centre(i, j);
        let mut inside = self.cells.v[self.cells.idx(i, j)] != 0;
        let mut ids = Vec::new();
        self.grid.query(BBox::of_points(&[q, c]), |id| ids.push(id));
        ids.sort_unstable();
        ids.dedup();
        for id in ids {
            let (a, b) = self.edges[id as usize];
            if hop_crosses(q, c, a, b) {
                inside = !inside;
            }
        }
        inside
    }
}

/// Does the hop q→c cross edge ab?  Half-open on the edge so a vertex shared
/// by two edges counts once.
fn hop_crosses(q: P, c: P, a: P, b: P) -> bool {
    let r = c.sub(q);
    let s = b.sub(a);
    let den = r.cross(s);
    if den.abs() < 1e-18 {
        return false;
    }
    let t = a.sub(q).cross(s) / den;
    let u = a.sub(q).cross(r) / den;
    (0.0..=1.0).contains(&t) && (0.0..1.0).contains(&u)
}

struct ZPoly {
    obj: u32,
    net: u32,
    bbox: BBox,
    rings: Vec<Vec<P>>,
    pip: Pip,
}

struct LayerCu {
    items: Vec<Item>,
    grid: Grid,
    zps: Vec<ZPoly>,
    /// Zone boundary edges: (index into zps, edge shape).
    edges: Vec<(u32, Shape)>,
    egrid: Grid,
    has_hv_zone: bool,
}

struct Copper<'a> {
    b: &'a Board,
    net_names: Vec<String>,
    hv: Vec<bool>,
    objs: Vec<Obj>,
    layers: Vec<LayerCu>,
    area: BBox,
}

impl<'a> Copper<'a> {
    fn build(b: &'a Board, hv_nets: &[String]) -> Copper<'a> {
        let mut ids: HashMap<String, u32> = HashMap::new();
        let mut net_names: Vec<String> = Vec::new();
        // Copper with no net is its own island: give each object (each pad
        // ref+num) a private id so it never reads as "same net" as another.
        let mut intern = |name: &str, private: Option<String>| -> u32 {
            let key = if name.is_empty() { format!("\u{0}{}", private.unwrap_or_else(|| net_names.len().to_string())) } else { name.to_string() };
            if let Some(&id) = ids.get(&key) {
                return id;
            }
            let id = net_names.len() as u32;
            net_names.push(name.to_string());
            ids.insert(key, id);
            id
        };
        let n = b.n_layers();
        let mut objs = Vec::new();
        let mut items: Vec<Vec<Item>> = (0..n).map(|_| Vec::new()).collect();
        let mut zps: Vec<Vec<ZPoly>> = (0..n).map(|_| Vec::new()).collect();
        let mut area = b.outline_bbox();
        for (i, t) in b.tracks.iter().enumerate() {
            let Some(l) = b.layer_index(&t.layer) else { continue };
            let net = intern(&t.net, None);
            let obj = objs.len() as u32;
            objs.push(Obj { kind: Kind::Track, idx: i, net });
            let shape = t.shape();
            area = area.union(shape.bbox);
            items[l].push(Item { obj, shape });
        }
        for (i, v) in b.vias.iter().enumerate() {
            let net = intern(&v.net, None);
            let obj = objs.len() as u32;
            objs.push(Obj { kind: Kind::Via, idx: i, net });
            let shape = v.shape();
            area = area.union(shape.bbox);
            for l in b.via_layers(v) {
                items[l].push(Item { obj, shape: shape.clone() });
            }
        }
        for (i, pd) in b.pads.iter().enumerate() {
            let layers = b.pad_layers(pd);
            if layers.is_empty() {
                continue;
            }
            let net = intern(&pd.net, Some(format!("{}:{}", pd.reference, pd.num)));
            let obj = objs.len() as u32;
            objs.push(Obj { kind: Kind::Pad, idx: i, net });
            let shape = pd.shape();
            area = area.union(shape.bbox);
            for l in layers {
                items[l].push(Item { obj, shape: shape.clone() });
            }
        }
        for (i, z) in b.zones.iter().enumerate() {
            let Some(l) = b.layer_index(&z.layer) else { continue };
            let net = intern(&z.net, None);
            for poly in &z.polygons {
                let rings: Vec<Vec<P>> = poly.iter().map(|r| ring(r)).filter(|r| r.len() >= 3).collect();
                if rings.is_empty() {
                    continue;
                }
                let obj = objs.len() as u32;
                objs.push(Obj { kind: Kind::Zone, idx: i, net });
                let bbox = BBox::of_points(rings.iter().flatten());
                area = area.union(bbox);
                let pip = Pip::new(&rings, bbox);
                zps[l].push(ZPoly { obj, net, bbox, rings, pip });
            }
        }
        let hv: Vec<bool> = net_names.iter().map(|nm| !nm.is_empty() && hv_nets.iter().any(|h| h == nm)).collect();
        let area = area.grow(1.0);
        let layers = items
            .into_iter()
            .zip(zps)
            .map(|(items, zps)| {
                let grid = Grid::build(area, 1.0, items.iter().map(|it| &it.shape));
                let mut edges = Vec::new();
                for (k, zp) in zps.iter().enumerate() {
                    for &(a, b) in &zp.pip.edges {
                        edges.push((k as u32, Shape::capsule(a, b, 0.0)));
                    }
                }
                let egrid = Grid::build(area, 1.0, edges.iter().map(|e| &e.1));
                let has_hv_zone = zps.iter().any(|z| hv[z.net as usize]);
                LayerCu { items, grid, zps, edges, egrid, has_hv_zone }
            })
            .collect();
        Copper { b, net_names, hv, objs, layers, area }
    }

    fn net_of(&self, obj: u32) -> u32 {
        self.objs[obj as usize].net
    }

    fn name(&self, net: u32) -> &str {
        &self.net_names[net as usize]
    }

    fn layer_name(&self, l: usize) -> &str {
        &self.b.layers[l]
    }

    /// Is q on a pad or via of `net` on layer l (within tol)?
    fn on_pad_or_via(&self, l: usize, net: u32, q: P, tol: f64) -> bool {
        let lc = &self.layers[l];
        let mut hit = false;
        lc.grid.query(BBox::of_points(&[q]).grow(tol), |id| {
            let it = &lc.items[id as usize];
            let o = &self.objs[it.obj as usize];
            if !hit && o.net == net && matches!(o.kind, Kind::Pad | Kind::Via) && it.shape.point_dist(q) <= tol {
                hit = true;
            }
        });
        hit
    }

    fn in_zone_of(&self, l: usize, net: u32, q: P) -> bool {
        self.layers[l].zps.iter().any(|z| z.net == net && z.pip.inside(q))
    }
}

// ---------------------------------------------------------------- clearance

#[derive(Clone, Copy)]
struct Hit {
    gap: f64,
    at: P,
    layer: usize,
    na: u32,
    nb: u32,
}

struct Clear {
    limit: f64,
    min: Option<Hit>,
    viol: HashMap<(u32, u32, usize), Hit>,
    shorts: HashMap<(u32, u32, usize), Hit>,
    pairs: HashMap<(u32, u32), Hit>,
}

impl Clear {
    fn add(&mut self, cu: &Copper, oa: u32, ob: u32, layer: usize, gap: f64, at: P) {
        let (na, nb) = (cu.net_of(oa), cu.net_of(ob));
        if na == nb {
            return;
        }
        let hv = cu.hv[na as usize] || cu.hv[nb as usize];
        if gap > if hv { R_HV } else { R_NEAR } {
            return;
        }
        let g = gap.max(0.0);
        let hit = Hit { gap: g, at, layer, na, nb };
        if self.min.map_or(true, |m| g < m.gap) {
            self.min = Some(hit);
        }
        let key = (oa.min(ob), oa.max(ob), layer);
        if gap <= 1e-9 {
            self.shorts.entry(key).or_insert(hit);
        } else if gap < self.limit {
            let e = self.viol.entry(key).or_insert(hit);
            if g < e.gap {
                *e = hit;
            }
        }
        if hv {
            let k = (na.min(nb), na.max(nb));
            let e = self.pairs.entry(k).or_insert(hit);
            if g < e.gap {
                *e = hit;
            }
        }
    }
}

fn clearances(cu: &Copper, limit: f64) -> Clear {
    let mut c = Clear { limit, min: None, viol: HashMap::new(), shorts: HashMap::new(), pairs: HashMap::new() };
    for (l, lc) in cu.layers.iter().enumerate() {
        let mut seen = Seen::new(lc.items.len().max(lc.edges.len()).max(lc.zps.len()));
        // items against items
        for (ia, a) in lc.items.iter().enumerate() {
            let hva = cu.hv[cu.net_of(a.obj) as usize];
            let rad = if hva { R_HV } else { R_NEAR };
            seen.next();
            lc.grid.query(a.shape.bbox.grow(rad), |ib| {
                if !seen.first(ib) {
                    return;
                }
                let b = &lc.items[ib as usize];
                let (na, nb) = (cu.net_of(a.obj), cu.net_of(b.obj));
                if na == nb {
                    return;
                }
                let hvb = cu.hv[nb as usize];
                // Each pair once: by the high-voltage side when only one is
                // (it searched further), else by the lower index.
                let mine = if hva != hvb { hva } else { (ia as u32) < ib };
                if !mine || a.shape.bbox.gap(&b.shape.bbox) > rad {
                    return;
                }
                let (g, p) = shape_gap(&a.shape, &b.shape);
                c.add(cu, a.obj, b.obj, l, g, p);
            });
        }
        // items against zone fills
        let mut best: Vec<Option<(f64, P)>> = vec![None; lc.zps.len()];
        let mut touched: Vec<usize> = Vec::new();
        for a in &lc.items {
            let na = cu.net_of(a.obj);
            let rad = if cu.hv[na as usize] || lc.has_hv_zone { R_HV } else { R_NEAR };
            seen.next();
            touched.clear();
            lc.egrid.query(a.shape.bbox.grow(rad), |ie| {
                if !seen.first(ie) {
                    return;
                }
                let (zk, ref es) = lc.edges[ie as usize];
                let zk = zk as usize;
                if lc.zps[zk].net == na || a.shape.bbox.gap(&es.bbox) > rad {
                    return;
                }
                let (g, p) = shape_gap(&a.shape, es);
                match best[zk] {
                    Some((bg, _)) if bg <= g => {}
                    _ => {
                        if best[zk].is_none() {
                            touched.push(zk);
                        }
                        best[zk] = Some((g, p));
                    }
                }
            });
            let rep = a.shape.rep();
            for (zk, z) in lc.zps.iter().enumerate() {
                if z.net == na || !z.bbox.grow(rad).overlaps(&a.shape.bbox) {
                    continue;
                }
                let edge = best[zk];
                if edge.is_some_and(|(g, _)| g <= 1e-9) {
                    continue; // crossing an edge: recorded below as a short
                }
                if z.pip.inside(rep) {
                    // wholly inside another net's fill
                    c.add(cu, a.obj, z.obj, l, 0.0, rep);
                    best[zk] = None;
                }
            }
            for &zk in &touched {
                if let Some((g, p)) = best[zk].take() {
                    c.add(cu, a.obj, lc.zps[zk].obj, l, g, p);
                }
            }
        }
        // zone fills against zone fills
        let rad = if lc.has_hv_zone { R_HV } else { R_NEAR };
        let mut zz: HashMap<(usize, usize), (f64, P)> = HashMap::new();
        for (ie, (za, ea)) in lc.edges.iter().enumerate() {
            let za = *za as usize;
            seen.next();
            lc.egrid.query(ea.bbox.grow(rad), |je| {
                if (je as usize) <= ie || !seen.first(je) {
                    return;
                }
                let (zb, ref eb) = lc.edges[je as usize];
                let zb = zb as usize;
                if zb == za || lc.zps[za].net == lc.zps[zb].net || ea.bbox.gap(&eb.bbox) > rad {
                    return;
                }
                let (g, p) = shape_gap(ea, eb);
                let key = (za.min(zb), za.max(zb));
                let e = zz.entry(key).or_insert((g, p));
                if g < e.0 {
                    *e = (g, p);
                }
            });
        }
        for i in 0..lc.zps.len() {
            for j in i + 1..lc.zps.len() {
                let (a, b) = (&lc.zps[i], &lc.zps[j]);
                if a.net == b.net || !a.bbox.overlaps(&b.bbox) || zz.contains_key(&(i, j)) {
                    continue;
                }
                let (ra, rb) = (a.pip.edges[0].0, b.pip.edges[0].0);
                if b.pip.inside(ra) {
                    zz.insert((i, j), (0.0, ra));
                } else if a.pip.inside(rb) {
                    zz.insert((i, j), (0.0, rb));
                }
            }
        }
        for ((i, j), (g, p)) in zz {
            c.add(cu, lc.zps[i].obj, lc.zps[j].obj, l, g, p);
        }
    }
    c
}

fn clear_json(cu: &Copper, h: &Hit, with_value: bool) -> Value {
    let mut v = json!({"at": at(h.at), "layer": cu.layer_name(h.layer), "nets": [cu.name(h.na), cu.name(h.nb)]});
    if with_value {
        v["value"] = json!(r4(h.gap));
    }
    v
}

// ---------------------------------------------------------------- edges, holes

struct Edges {
    segs: Vec<Shape>,
    grid: Grid,
    rings: Vec<Vec<P>>,
}

impl Edges {
    fn new(b: &Board, area: BBox) -> Edges {
        let rings = b.board_rings();
        let segs: Vec<Shape> = rings.iter().flat_map(|r| ring_edges(r)).map(|(a, b)| Shape::capsule(a, b, 0.0)).collect();
        let grid = Grid::build(area, 1.0, segs.iter());
        Edges { segs, grid, rings }
    }
    fn inside_board(&self, q: P) -> bool {
        self.rings.is_empty() || crate::geom::in_rings(q, &self.rings)
    }
    /// Gap from a shape to the nearest board edge within `rad` (0 if the
    /// shape crosses the edge or lies outside the board).
    fn gap(&self, s: &Shape, rad: f64, seen: &mut Seen) -> Option<(f64, P)> {
        if self.segs.is_empty() {
            return None;
        }
        let mut best: Option<(f64, P)> = None;
        seen.next();
        self.grid.query(s.bbox.grow(rad), |id| {
            if !seen.first(id) {
                return;
            }
            let (g, p) = shape_gap(s, &self.segs[id as usize]);
            if best.map_or(true, |b| g < b.0) {
                best = Some((g, p));
            }
        });
        if !self.inside_board(s.rep()) {
            return Some((0.0, s.rep()));
        }
        best.filter(|b| b.0 <= rad).map(|(g, p)| (g.max(0.0), p))
    }
}

struct Drill {
    c: P,
    d: f64,
    owner: Option<u32>,
    net: Option<u32>,
    kind: &'static str,
    label: String,
}

fn drills(cu: &Copper) -> Vec<Drill> {
    let b = cu.b;
    let mut out: Vec<Drill> = Vec::new();
    let pad_obj: HashMap<usize, u32> = cu.objs.iter().enumerate().filter(|(_, o)| o.kind == Kind::Pad).map(|(i, o)| (o.idx, i as u32)).collect();
    let via_obj: HashMap<usize, u32> = cu.objs.iter().enumerate().filter(|(_, o)| o.kind == Kind::Via).map(|(i, o)| (o.idx, i as u32)).collect();
    for (i, v) in b.vias.iter().enumerate() {
        if v.drill > 0.0 {
            let owner = via_obj.get(&i).copied();
            out.push(Drill { c: v.c(), d: v.drill, owner, net: owner.map(|o| cu.net_of(o)), kind: "via", label: v.net.clone() });
        }
    }
    for (i, pd) in b.pads.iter().enumerate() {
        if pd.drill > 0.0 {
            let owner = pad_obj.get(&i).copied();
            let net = if pd.plated() { owner.map(|o| cu.net_of(o)) } else { None };
            out.push(Drill { c: pd.c(), d: pd.drill, owner, net, kind: "pad", label: format!("{}.{}", pd.reference, pd.num) });
        }
    }
    for h in &b.holes {
        if h.d <= 0.0 {
            continue;
        }
        let c = P { x: h.x, y: h.y };
        // The holes list may repeat a pad's drill: keep each hole once.
        if out.iter().any(|o| o.c.dist(c) < TOUCH && (o.d - h.d).abs() < TOUCH) {
            continue;
        }
        out.push(Drill { c, d: h.d, owner: None, net: None, kind: "hole", label: String::new() });
    }
    out
}

// ---------------------------------------------------------------- track joints

struct Cluster {
    pos: P,
    layer: usize,
    net: u32,
    ends: Vec<(usize, usize)>, // (track index into board.tracks, end 0=a 1=b)
}

fn track_end(b: &Board, t: usize, e: usize) -> (P, P) {
    let tr = &b.tracks[t];
    let (a, bb) = (P::from(tr.a), P::from(tr.b));
    if e == 0 {
        (a, bb)
    } else {
        (bb, a)
    }
}

/// Group track endpoints that coincide (same layer and net, within TOUCH).
fn clusters(cu: &Copper) -> Vec<Cluster> {
    let b = cu.b;
    let mut out: Vec<Cluster> = Vec::new();
    let mut buckets: HashMap<(usize, u32, i64, i64), Vec<usize>> = HashMap::new();
    let q = |v: f64| (v / TOUCH).floor() as i64;
    for o in cu.objs.iter().filter(|o| o.kind == Kind::Track) {
        let t = &b.tracks[o.idx];
        let Some(l) = b.layer_index(&t.layer) else { continue };
        if P::from(t.a).dist(P::from(t.b)) < 1e-9 {
            continue; // zero-length stub: no direction
        }
        for e in 0..2 {
            let (pt, _) = track_end(b, o.idx, e);
            let (qx, qy) = (q(pt.x), q(pt.y));
            let mut found = None;
            'search: for dy in -1..=1 {
                for dx in -1..=1 {
                    if let Some(list) = buckets.get(&(l, o.net, qx + dx, qy + dy)) {
                        for &ci in list {
                            if out[ci].pos.dist(pt) <= TOUCH {
                                found = Some(ci);
                                break 'search;
                            }
                        }
                    }
                }
            }
            match found {
                Some(ci) => out[ci].ends.push((o.idx, e)),
                None => {
                    buckets.entry((l, o.net, qx, qy)).or_default().push(out.len());
                    out.push(Cluster { pos: pt, layer: l, net: o.net, ends: vec![(o.idx, e)] });
                }
            }
        }
    }
    out
}

/// Where the inner copper edges of two tracks leaving a joint at angle θ
/// meet: the root of the wedge an etchant would pool in.
fn wedge_root(joint: P, u: P, v: P, half_w: f64, theta_deg: f64) -> P {
    let bis = u.unit().add(v.unit()).unit();
    let s = half_w / (0.5 * theta_deg.to_radians()).sin().max(1e-6);
    joint.add(bis.mul(s.min(50.0)))
}

struct Joints {
    corners: Vec<Value>,
    acute: Vec<Value>,
    dangling: Vec<Value>,
    n_corners: usize,
    n_acute: usize,
    n_dangling: usize,
}

fn joints(cu: &Copper) -> Joints {
    let b = cu.b;
    let cls = clusters(cu);
    let mut j = Joints { corners: vec![], acute: vec![], dangling: vec![], n_corners: 0, n_acute: 0, n_dangling: 0 };
    let track_obj: HashMap<usize, u32> = cu.objs.iter().enumerate().filter(|(_, o)| o.kind == Kind::Track).map(|(i, o)| (o.idx, i as u32)).collect();
    let covered = |l: usize, net: u32, q: P| cu.on_pad_or_via(l, net, q, 0.0) || cu.in_zone_of(l, net, q);
    let push_acute = |j: &mut Joints, angle: f64, q: P, l: usize, net: u32| {
        j.n_acute += 1;
        if j.acute.len() < MAX_GEOM_LIST {
            j.acute.push(json!({"angle": r4(angle), "at": at(q), "layer": cu.layer_name(l), "net": cu.name(net)}));
        }
    };
    for c in &cls {
        let half_w = |t: usize| 0.5 * b.tracks[t].w;
        let pad_here = cu.on_pad_or_via(c.layer, c.net, c.pos, TOUCH);
        if c.ends.len() == 2 && !pad_here {
            let (t1, e1) = c.ends[0];
            let (t2, e2) = c.ends[1];
            let (j1, f1) = track_end(b, t1, e1);
            let (_, f2) = track_end(b, t2, e2);
            let inside = angle_between(f1.sub(j1), f2.sub(c.pos));
            let turn = 180.0 - inside;
            if turn > 45.5 {
                j.n_corners += 1;
                if j.corners.len() < MAX_GEOM_LIST {
                    j.corners.push(json!({"angle": r4(turn), "at": at(c.pos), "layer": cu.layer_name(c.layer), "net": cu.name(c.net)}));
                }
            }
        }
        for x in 0..c.ends.len() {
            for y in x + 1..c.ends.len() {
                let (t1, e1) = c.ends[x];
                let (t2, e2) = c.ends[y];
                let (_, f1) = track_end(b, t1, e1);
                let (_, f2) = track_end(b, t2, e2);
                let (u, v) = (f1.sub(c.pos), f2.sub(c.pos));
                let th = angle_between(u, v);
                if th < 89.5 {
                    let root = wedge_root(c.pos, u, v, half_w(t1).max(half_w(t2)), th);
                    if !covered(c.layer, c.net, root) {
                        push_acute(&mut j, th, c.pos, c.layer, c.net);
                    }
                }
            }
        }
        // T-joins and dangling ends: what else does each end touch?
        let lc = &cu.layers[c.layer];
        for &(t, e) in &c.ends {
            let (pt, far) = track_end(b, t, e);
            let me = track_obj[&t];
            let mut touches = c.ends.len() > 1;
            let mut tjoins: Vec<(P, P, f64)> = Vec::new();
            // A point on a cell corner is in four cells: dedupe the hits.
            let mut ids = Vec::new();
            lc.grid.query(BBox::of_points(&[pt]).grow(TOUCH), |id| ids.push(id));
            ids.sort_unstable();
            ids.dedup();
            for id in ids {
                let it = &lc.items[id as usize];
                if it.obj == me || cu.net_of(it.obj) != c.net {
                    continue;
                }
                if it.shape.point_dist(pt) > TOUCH {
                    continue;
                }
                touches = true;
                let o = &cu.objs[it.obj as usize];
                if o.kind == Kind::Track {
                    let tr = &b.tracks[o.idx];
                    let (a2, b2) = (P::from(tr.a), P::from(tr.b));
                    let (cp, _) = seg_closest(a2, b2, pt);
                    if cp.dist(pt) <= 2.0 * TOUCH && cp.dist(a2) > TOUCH && cp.dist(b2) > TOUCH {
                        tjoins.push((a2, b2, 0.5 * tr.w));
                    }
                }
            }
            if !touches && cu.in_zone_of(c.layer, c.net, pt) {
                touches = true;
            }
            if !touches {
                j.n_dangling += 1;
                if j.dangling.len() < MAX_GEOM_LIST {
                    j.dangling.push(json!({"at": at(pt), "layer": cu.layer_name(c.layer), "net": cu.name(c.net), "kind": "track"}));
                }
            }
            for (a2, b2, hw2) in tjoins {
                let u = far.sub(pt);
                let (d1, d2) = (b2.sub(a2), a2.sub(b2));
                let (th1, th2) = (angle_between(u, d1), angle_between(u, d2));
                let (th, v) = if th1 <= th2 { (th1, d1) } else { (th2, d2) };
                if th < 89.5 {
                    let root = wedge_root(pt, u, v, half_w(t).max(hw2), th);
                    if !covered(c.layer, c.net, root) {
                        push_acute(&mut j, th, pt, c.layer, c.net);
                    }
                }
            }
        }
    }
    // Vias: count the distinct same-net things each one joins.
    for (oi, o) in cu.objs.iter().enumerate().filter(|(_, o)| o.kind == Kind::Via) {
        let v = &b.vias[o.idx];
        let vs = v.shape();
        let mut joined: Vec<u32> = Vec::new();
        let layers = b.via_layers(v);
        for &l in &layers {
            let lc = &cu.layers[l];
            lc.grid.query(vs.bbox.grow(TOUCH), |id| {
                let it = &lc.items[id as usize];
                if it.obj as usize == oi || cu.net_of(it.obj) != o.net {
                    return;
                }
                if shape_gap(&vs, &it.shape).0 <= TOUCH {
                    joined.push(it.obj);
                }
            });
            for z in &lc.zps {
                if z.net == o.net && z.bbox.contains(vs.rep()) && z.pip.inside(vs.rep()) {
                    joined.push(z.obj);
                }
            }
        }
        joined.sort_unstable();
        joined.dedup();
        if joined.len() < 2 {
            j.n_dangling += 1;
            if j.dangling.len() < MAX_GEOM_LIST {
                let l0 = layers.first().copied().unwrap_or(0);
                j.dangling.push(json!({"at": at(v.c()), "layer": cu.layer_name(l0), "net": cu.name(o.net), "kind": "via", "joins": joined.len()}));
            }
        }
    }
    j
}

// ---------------------------------------------------------------- rasters

fn raster_res(area: BBox) -> f64 {
    let mut d = 0.1;
    while (area.width() / d) * (area.height() / d) > 2.5e6 {
        d *= 1.25;
    }
    d
}

fn paint_copper(r: &mut Raster, cu: &Copper, l: usize, keep: impl Fn(u32) -> bool) {
    let lc = &cu.layers[l];
    for it in &lc.items {
        if keep(cu.net_of(it.obj)) {
            r.fill_shape(&it.shape, 1);
        }
    }
    for zp in &lc.zps {
        if keep(zp.net) {
            r.fill_rings(&zp.rings, 1);
        }
    }
}

// ---------------------------------------------------------------- run

pub fn run(input: Value) -> Result<Value, String> {
    let t0 = Instant::now();
    let inp: Input = serde_json::from_value(input).map_err(|e| format!("measure input: {e}"))?;
    let b = &inp.board;
    let lim = &inp.limits;
    let cu = Copper::build(b, &inp.hv_nets);
    let n = b.n_layers();
    let mut out = serde_json::Map::new();

    // narrowest track
    let tmin = b
        .tracks
        .iter()
        .filter(|t| b.layer_index(&t.layer).is_some())
        .min_by(|x, y| x.w.total_cmp(&y.w))
        .map(|t| json!({"value": r4(t.w), "at": at(P::from(t.a).mid(P::from(t.b))), "layer": t.layer, "net": t.net}));
    out.insert("track_min".into(), tmin.unwrap_or(Value::Null));

    // clearances and shorts
    let cl = clearances(&cu, lim.clear);
    out.insert("clearance_min".into(), cl.min.map(|h| clear_json(&cu, &h, true)).unwrap_or(Value::Null));
    let mut viol: Vec<Hit> = cl.viol.values().copied().collect();
    viol.sort_by(|a, b| a.gap.total_cmp(&b.gap));
    out.insert("clearance_violation_count".into(), json!(viol.len()));
    out.insert("clearance_violations".into(), Value::Array(viol.iter().take(MAX_LIST).map(|h| clear_json(&cu, h, true)).collect()));
    let mut shorts: Vec<Hit> = cl.shorts.values().copied().collect();
    shorts.sort_by(|a, b| (a.layer, a.at.x, a.at.y).partial_cmp(&(b.layer, b.at.x, b.at.y)).unwrap_or(std::cmp::Ordering::Equal));
    out.insert("short_count".into(), json!(shorts.len()));
    out.insert("shorts".into(), Value::Array(shorts.iter().take(MAX_LIST).map(|h| clear_json(&cu, h, false)).collect()));
    let mut pairs: Vec<Hit> = cl.pairs.values().copied().collect();
    pairs.sort_by(|a, b| a.gap.total_cmp(&b.gap));
    out.insert("pair_min".into(), Value::Array(pairs.iter().map(|h| clear_json(&cu, h, true)).collect()));

    // vias, drills, rings
    let via_min = b.vias.iter().min_by(|x, y| x.d.total_cmp(&y.d)).map(|v| json!({"value": r4(v.d), "at": at(v.c()), "net": v.net}));
    out.insert("via_min_d".into(), via_min.unwrap_or(Value::Null));
    let dr = drills(&cu);
    let dmin = dr.iter().min_by(|x, y| x.d.total_cmp(&y.d)).map(|d| json!({"value": r4(d.d), "at": at(d.c), "kind": d.kind, "label": d.label}));
    out.insert("drill_min".into(), dmin.unwrap_or(Value::Null));
    let mut rings: Vec<(f64, P, &'static str, String)> = Vec::new();
    for v in &b.vias {
        if v.drill > 0.0 && v.d > 0.0 {
            rings.push(((v.d - v.drill) / 2.0, v.c(), "via", v.net.clone()));
        }
    }
    for pd in &b.pads {
        if pd.drill > 0.0 && pd.plated() && !b.pad_layers(pd).is_empty() {
            rings.push(((pd.w.min(pd.h) - pd.drill) / 2.0, pd.c(), "pad", format!("{}.{}", pd.reference, pd.num)));
        }
    }
    let rmin = rings.iter().min_by(|x, y| x.0.total_cmp(&y.0)).map(|(v, q, k, lab)| json!({"value": r4(*v), "at": at(*q), "kind": k, "label": lab}));
    out.insert("ring_min".into(), rmin.unwrap_or(Value::Null));

    // hole to hole, edge to edge
    let dshapes: Vec<Shape> = dr.iter().map(|d| Shape::disc(d.c, d.d / 2.0)).collect();
    let dgrid = Grid::build(cu.area, 2.0, dshapes.iter());
    let mut seen = Seen::new(dshapes.len().max(1));
    let mut hh: Option<(f64, P)> = None;
    for (i, s) in dshapes.iter().enumerate() {
        seen.next();
        dgrid.query(s.bbox.grow(3.0), |jd| {
            if jd as usize <= i || !seen.first(jd) {
                return;
            }
            let (g, q) = shape_gap(s, &dshapes[jd as usize]);
            if g <= 3.0 && hh.map_or(true, |h| g < h.0) {
                hh = Some((g.max(0.0), q));
            }
        });
    }
    out.insert("hole_to_hole_min".into(), hh.map(|(v, q)| json!({"value": r4(v), "at": at(q)})).unwrap_or(Value::Null));

    // drill to other copper (extra: the limit is in the input)
    let mut hc: Option<(f64, P, usize, String)> = None;
    for (di, d) in dr.iter().enumerate() {
        let s = &dshapes[di];
        for l in 0..n {
            let lc = &cu.layers[l];
            let mut best: Option<(f64, P, u32)> = None;
            lc.grid.query(s.bbox.grow(R_NEAR), |id| {
                let it = &lc.items[id as usize];
                if Some(it.obj) == d.owner || Some(cu.net_of(it.obj)) == d.net {
                    return;
                }
                let (g, q) = shape_gap(s, &it.shape);
                if best.map_or(true, |bb| g < bb.0) {
                    best = Some((g, q, cu.net_of(it.obj)));
                }
            });
            lc.egrid.query(s.bbox.grow(R_NEAR), |ie| {
                let (zk, ref es) = lc.edges[ie as usize];
                let znet = lc.zps[zk as usize].net;
                if Some(znet) == d.net {
                    return;
                }
                let (g, q) = shape_gap(s, es);
                if best.map_or(true, |bb| g < bb.0) {
                    best = Some((g, q, znet));
                }
            });
            for z in &lc.zps {
                if Some(z.net) != d.net && z.pip.inside(d.c) {
                    best = Some((0.0, d.c, z.net));
                }
            }
            if let Some((g, q, net)) = best {
                if g <= R_NEAR && hc.as_ref().map_or(true, |h| g < h.0) {
                    hc = Some((g.max(0.0), q, l, cu.name(net).to_string()));
                }
            }
        }
    }
    out.insert(
        "hole_clear_min".into(),
        hc.map(|(v, q, l, net)| json!({"value": r4(v), "at": at(q), "layer": cu.layer_name(l), "net": net})).unwrap_or(Value::Null),
    );

    // copper to board edge
    let edges = Edges::new(b, cu.area);
    let mut eseen = Seen::new(edges.segs.len().max(1));
    let mut emin: Option<(f64, P, usize, u32)> = None;
    let consider = |g: Option<(f64, P)>, l: usize, net: u32, emin: &mut Option<(f64, P, usize, u32)>| {
        if let Some((g, q)) = g {
            if emin.map_or(true, |e| g < e.0) {
                *emin = Some((g, q, l, net));
            }
        }
    };
    for (l, lc) in cu.layers.iter().enumerate() {
        for it in &lc.items {
            let g = edges.gap(&it.shape, R_HV, &mut eseen);
            consider(g, l, cu.net_of(it.obj), &mut emin);
        }
        for (zk, es) in &lc.edges {
            let g = edges.gap(es, R_HV, &mut eseen);
            consider(g, l, lc.zps[*zk as usize].net, &mut emin);
        }
    }
    out.insert(
        "edge_min".into(),
        emin.map(|(v, q, l, net)| json!({"value": r4(v), "at": at(q), "layer": cu.layer_name(l), "net": cu.name(net)})).unwrap_or(Value::Null),
    );

    // silkscreen
    silk(b, &mut out);

    // mask web
    out.insert("mask_web_min".into(), mask_web(b, cu.area));

    // joints
    let jt = joints(&cu);
    out.insert("corners".into(), Value::Array(jt.corners));
    out.insert("acute".into(), Value::Array(jt.acute));
    out.insert("dangling".into(), Value::Array(jt.dangling));
    out.insert("joint_counts".into(), json!({"corners": jt.n_corners, "acute": jt.n_acute, "dangling": jt.n_dangling}));

    // copper balance and return paths
    let board_area = b.outline_bbox();
    let res = raster_res(board_area);
    let mut board_r = Raster::covering(board_area, res);
    board_r.fill_rings(&b.board_rings(), 1);
    let board_cells = board_r.count_nonzero().max(1);
    let mut area_map = serde_json::Map::new();
    for l in 0..n {
        let mut r = board_r.same_grid();
        paint_copper(&mut r, &cu, l, |_| true);
        let covered = r.v.iter().zip(&board_r.v).filter(|(c, bb)| **c != 0 && **bb != 0).count();
        area_map.insert(b.layers[l].clone(), json!(r4(covered as f64 / board_cells as f64)));
    }
    out.insert("copper_area".into(), Value::Object(area_map));
    out.insert("return_path".into(), return_paths(&cu, &inp, &board_r));

    // courtyards
    let (overlaps, pe_min, pe_all) = courtyards(b, &edges);
    out.insert("courtyard_overlaps".into(), Value::Array(overlaps));
    out.insert("part_edge_min".into(), pe_min);
    out.insert("part_edge".into(), Value::Array(pe_all));

    out.insert(
        "stats".into(),
        json!({"tracks": b.tracks.len(), "vias": b.vias.len(), "pads": b.pads.len(),
               "zone_edges": cu.layers.iter().map(|l| l.edges.len()).sum::<usize>(),
               "ms": r4(t0.elapsed().as_secs_f64() * 1e3)}),
    );
    Ok(Value::Object(out))
}

fn silk(b: &Board, out: &mut serde_json::Map<String, Value>) {
    let mut wmin: Option<(f64, P, &str)> = None;
    let mut hmin: Option<(f64, P, &str, &str)> = None;
    let mut shapes: Vec<(usize, Shape)> = Vec::new();
    for (i, s) in b.silk.iter().enumerate() {
        let shape = if s.kind == "text" {
            s.bbox.map(|[x0, y0, x1, y1]| Shape::rect(BBox { x0: x0.min(x1), y0: y0.min(y1), x1: x0.max(x1), y1: y0.max(y1) }))
        } else {
            match (s.a, s.b) {
                (Some(a), Some(bb)) => Some(Shape::capsule(P::from(a), P::from(bb), 0.5 * s.w.max(0.0))),
                _ => s.bbox.map(|[x0, y0, x1, y1]| Shape::rect(BBox { x0, y0, x1, y1 })),
            }
        };
        let Some(shape) = shape else { continue };
        let centre = P { x: 0.5 * (shape.bbox.x0 + shape.bbox.x1), y: 0.5 * (shape.bbox.y0 + shape.bbox.y1) };
        if s.w > 0.0 && wmin.map_or(true, |w| s.w < w.0) {
            wmin = Some((s.w, centre, &s.layer));
        }
        if s.kind == "text" && s.height > 0.0 && hmin.map_or(true, |h| s.height < h.0) {
            hmin = Some((s.height, centre, &s.layer, &s.text));
        }
        shapes.push((i, shape));
    }
    out.insert("silk_w_min".into(), wmin.map(|(v, q, l)| json!({"value": r4(v), "at": at(q), "layer": l})).unwrap_or(Value::Null));
    out.insert(
        "silk_h_min".into(),
        hmin.map(|(v, q, l, t)| json!({"value": r4(v), "at": at(q), "layer": l, "text": t})).unwrap_or(Value::Null),
    );
    // silk over mask openings, matched by side ("F.Silkscreen" ↔ "F.Mask")
    let side = |name: &str| name.split('.').next().unwrap_or("").to_string();
    let open: Vec<Shape> = b.mask_openings.iter().map(|m| Shape::poly(ring(&m.poly))).collect();
    let area = open.iter().fold(BBox::EMPTY, |a, s| a.union(s.bbox)).grow(1.0);
    let grid = Grid::build(area, 1.0, open.iter());
    let mut seen = Seen::new(open.len().max(1));
    let mut hits = Vec::new();
    for (i, s) in &shapes {
        let sl = &b.silk[*i];
        seen.next();
        grid.query(s.bbox, |k| {
            if !seen.first(k) || hits.len() >= MAX_LIST {
                return;
            }
            let m = &b.mask_openings[k as usize];
            if side(&m.layer) != side(&sl.layer) || open[k as usize].bbox.gap(&s.bbox) > 0.0 {
                return;
            }
            let (g, q) = shape_gap(s, &open[k as usize]);
            if g < 0.0 {
                let mut v = json!({"at": at(q), "layer": sl.layer, "ref": m.reference, "num": m.num});
                if sl.kind == "text" {
                    v["text"] = json!(sl.text);
                }
                hits.push(v);
            }
        });
    }
    out.insert("silk_on_pads".into(), Value::Array(hits));
}

fn mask_web(b: &Board, area: BBox) -> Value {
    let open: Vec<Shape> = b.mask_openings.iter().map(|m| Shape::poly(ring(&m.poly))).collect();
    let grid = Grid::build(area.union(open.iter().fold(BBox::EMPTY, |a, s| a.union(s.bbox))), 1.0, open.iter());
    let mut seen = Seen::new(open.len().max(1));
    let mut best: Option<(f64, P, &str)> = None;
    for (i, s) in open.iter().enumerate() {
        let mi = &b.mask_openings[i];
        seen.next();
        grid.query(s.bbox.grow(1.0), |k| {
            let k = k as usize;
            if k <= i || !seen.first(k as u32) {
                return;
            }
            let mk = &b.mask_openings[k];
            if mk.layer != mi.layer || (mk.reference == mi.reference && mk.num == mi.num) {
                return;
            }
            let (g, q) = shape_gap(s, &open[k]);
            if g <= 1.0 && best.map_or(true, |bb| g < bb.0) {
                best = Some((g.max(0.0), q, &mi.layer));
            }
        });
    }
    best.map(|(v, q, l)| json!({"value": r4(v), "at": at(q), "layer": l})).unwrap_or(Value::Null)
}

fn return_paths(cu: &Copper, inp: &Input, grid: &Raster) -> Value {
    let b = cu.b;
    let n = b.n_layers();
    if n == 0 || inp.signal_nets.is_empty() {
        return json!([]);
    }
    let ref_ids: Vec<u32> = (0..cu.net_names.len() as u32).filter(|&i| inp.ref_nets.iter().any(|r| r == cu.name(i))).collect();
    let adj = |l: usize| -> Option<usize> {
        if n < 2 {
            None
        } else if l == 0 {
            Some(1)
        } else if l == n - 1 {
            Some(n - 2)
        } else {
            None
        }
    };
    let mut refr: HashMap<usize, Raster> = HashMap::new();
    for l in [0, n - 1] {
        if let Some(a) = adj(l) {
            refr.entry(a).or_insert_with(|| {
                let mut r = grid.same_grid();
                paint_copper(&mut r, cu, a, |net| ref_ids.contains(&net));
                r
            });
        }
    }
    let mut out = Vec::new();
    for net in &inp.signal_nets {
        let (mut length, mut uncovered) = (0.0, 0.0);
        let mut worst: Option<(f64, P)> = None;
        for t in b.tracks.iter().filter(|t| &t.net == net) {
            let Some(l) = b.layer_index(&t.layer) else { continue };
            if l != 0 && l != n - 1 {
                continue;
            }
            let (a, bb) = (P::from(t.a), P::from(t.b));
            let len = a.dist(bb);
            length += len;
            let k = (len / 0.1).ceil().max(1.0) as usize;
            let step = len / k as f64;
            let mut run = 0usize;
            let flush = |run: usize, end: usize, worst: &mut Option<(f64, P)>| {
                let rl = run as f64 * step;
                if run > 0 && worst.map_or(true, |w| rl > w.0) {
                    let mid = (end as f64 - run as f64 * 0.5) / k as f64;
                    *worst = Some((rl, a.add(bb.sub(a).mul(mid))));
                }
            };
            for s in 0..k {
                let q = a.add(bb.sub(a).mul((s as f64 + 0.5) / k as f64));
                let ok = adj(l).and_then(|al| refr.get(&al)).map_or(false, |r| r.get(q) != 0);
                if ok {
                    flush(run, s, &mut worst);
                    run = 0;
                } else {
                    uncovered += step;
                    run += 1;
                }
            }
            flush(run, k, &mut worst);
        }
        if length > 0.0 {
            out.push(json!({"net": net, "layer": "outer", "length": r4(length), "uncovered": r4(uncovered),
                            "worst_at": worst.map(|w| at(w.1)).unwrap_or(Value::Null),
                            "worst_run": worst.map(|w| r4(w.0)).unwrap_or(0.0)}));
        }
    }
    Value::Array(out)
}

fn courtyards(b: &Board, edges: &Edges) -> (Vec<Value>, Value, Vec<Value>) {
    let polys: Vec<Vec<P>> = b.parts.iter().map(|pt| pt.outline()).collect();
    let boxes: Vec<BBox> = polys.iter().map(|p| BBox::of_points(p)).collect();
    let mut overlaps = Vec::new();
    for i in 0..polys.len() {
        for j in i + 1..polys.len() {
            if polys[i].len() < 3 || polys[j].len() < 3 || b.parts[i].side != b.parts[j].side || !boxes[i].overlaps(&boxes[j]) {
                continue;
            }
            let hit = overlap(&polys[i], &polys[j], boxes[i], boxes[j]);
            if let Some(q) = hit {
                if overlaps.len() < MAX_LIST {
                    overlaps.push(json!({"refs": [b.parts[i].reference, b.parts[j].reference], "at": at(q)}));
                }
            }
        }
    }
    let mut seen = Seen::new(edges.segs.len().max(1));
    let mut all: Vec<(f64, P, &str)> = Vec::new();
    for (i, poly) in polys.iter().enumerate() {
        if poly.len() < 3 {
            continue;
        }
        let s = Shape::poly(poly.clone());
        // A courtyard is an outline, not filled copper: measure its edges.
        let mut best: Option<(f64, P)> = None;
        for (a, bb) in ring_edges(poly) {
            if let Some((g, q)) = edges.gap(&Shape::capsule(a, bb, 0.0), 50.0, &mut seen) {
                if best.map_or(true, |x| g < x.0) {
                    best = Some((g, q));
                }
            }
        }
        if poly.iter().any(|&q| !edges.inside_board(q)) {
            best = Some((0.0, poly.iter().copied().find(|&q| !edges.inside_board(q)).unwrap_or(s.rep())));
        }
        if let Some((g, q)) = best {
            all.push((g, q, &b.parts[i].reference));
        }
    }
    all.sort_by(|a, b| a.0.total_cmp(&b.0));
    let min = all.first().map(|(g, q, r)| json!({"value": r4(*g), "ref": r, "at": at(*q)})).unwrap_or(Value::Null);
    let list = all.iter().map(|(g, q, r)| json!({"value": r4(*g), "ref": r, "at": at(*q)})).collect();
    (overlaps, min, list)
}

/// Do two courtyards overlap by a real area (not just share an edge, which
/// is how parts are meant to be packed)?  Rasterised over the overlap of
/// their boxes, so any simple polygon works, convex or not.  Returns a point
/// in the shared area.
fn overlap(u: &[P], v: &[P], bu: BBox, bv: BBox) -> Option<P> {
    let ib = BBox { x0: bu.x0.max(bv.x0), y0: bu.y0.max(bv.y0), x1: bu.x1.min(bv.x1), y1: bu.y1.min(bv.y1) };
    if ib.width() <= 1e-6 || ib.height() <= 1e-6 {
        return None;
    }
    let d = (ib.width() * ib.height() / 40_000.0).sqrt().clamp(0.005, 0.1);
    let mut r = Raster::covering(ib, d);
    r.fill_rings(&[u.to_vec()], 1);
    let mut n = 0usize;
    let mut sum = P::default();
    let nx = r.nx;
    let mut spans = Vec::new();
    r.rings_spans(&[v.to_vec()], |j, i0, i1| spans.push((j, i0, i1)));
    for (j, i0, i1) in spans {
        for i in i0..=i1 {
            if r.v[j * nx + i] != 0 {
                n += 1;
                sum = sum.add(r.centre(i, j));
            }
        }
    }
    // 0.01 mm² of shared area: well above rounding, well below a real clash.
    (n as f64 * d * d >= 0.01).then(|| sum.mul(1.0 / n as f64))
}

#[allow(dead_code)]
fn centroid(v: &[P]) -> P {
    let n = v.len().max(1) as f64;
    let s = v.iter().fold(P::default(), |a, &b| a.add(b));
    s.mul(1.0 / n)
}
