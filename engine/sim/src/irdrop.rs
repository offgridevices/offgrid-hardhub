// SPDX-License-Identifier: AGPL-3.0-or-later
//! `irdrop`: DC voltage drop on one power net, as a resistor network.
//!
//! Nodes are pads (one each: a pad is a near-perfect conductor next to the
//! copper feeding it), via barrels at each layer they reach, zone grid cells,
//! and track ends.  Resistors are track pieces (ρL/(w·t)), via barrels
//! (ρh/(π·t_plate·(drill + t_plate))) and links between neighbouring zone
//! cells (the sheet resistance ρ/t per square).  Things that touch are merged
//! into one node with a union-find, which is how "a track ending inside a pad"
//! or "a via in a pour" become connections without any zero-ohm resistors
//! that would wreck the matrix's conditioning.
//!
//! Unknowns are drops u = V_ref − V, with V_ref the highest source voltage, so
//! the solve works directly in the small numbers that are reported (no
//! 3.3 V − 3.2999 V cancellation).

use crate::geom::{seg_closest, BBox, Shape, P};
use crate::index::Grid;
use crate::model::{ring, Board};
use crate::raster::Raster;
use crate::solve::{pcg_with, Laplacian, Precond};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::time::Instant;

/// Copper resistivity at 20 °C, Ω·m, and its temperature coefficient.
pub const RHO_20: f64 = 1.72e-8;
pub const ALPHA_CU: f64 = 0.00393;
/// Via barrel plating thickness, mm.
pub const PLATING_MM: f64 = 0.025;
/// Zone cells above this count make the grid coarser (keeps big pours fast).
const MAX_ZONE_CELLS: usize = 400_000;

#[derive(Deserialize, Debug, Clone, Default)]
#[serde(default)]
pub struct Terminal {
    #[serde(rename = "ref")]
    pub reference: String,
    pub num: Option<String>,
    pub voltage: f64,
    pub current: f64,
}

#[derive(Deserialize, Debug, Default)]
#[serde(default)]
pub struct Input {
    pub board: Board,
    pub net: String,
    pub temp_c: Option<f64>,
    pub sources: Vec<Terminal>,
    pub sinks: Vec<Terminal>,
    pub cell: Option<f64>,
}

/// Resistivity in Ω·mm at temperature t (°C): R = rho_mm · L / A with L in mm
/// and A in mm².
pub fn rho_mm(t: f64) -> f64 {
    RHO_20 * (1.0 + ALPHA_CU * (t - 20.0)) * 1e3
}

struct Uf(Vec<u32>);

impl Uf {
    fn add(&mut self) -> u32 {
        self.0.push(self.0.len() as u32);
        (self.0.len() - 1) as u32
    }
    fn find(&mut self, mut x: u32) -> u32 {
        while self.0[x as usize] != x {
            let p = self.0[self.0[x as usize] as usize];
            self.0[x as usize] = p;
            x = p;
        }
        x
    }
    fn union(&mut self, a: u32, b: u32) {
        let (ra, rb) = (self.find(a), self.find(b));
        if ra != rb {
            self.0[ra.max(rb) as usize] = ra.min(rb);
        }
    }
}

#[derive(Clone, Copy)]
enum Elem {
    /// Track `t` piece from param s0 to s1.
    Track { t: usize, s0: f64, s1: f64 },
    Via { v: usize },
    /// Zone link between two cells on a layer, at its midpoint.
    Zone { layer: usize, at: P },
}

struct Res {
    a: u32,
    b: u32,
    g: f64,
    what: Elem,
}

/// What a track end, pad or via can be found by on one layer.
#[derive(Clone, Copy)]
enum Thing {
    Track(usize),
    Pad(usize),
    Via(usize),
}

fn r4(v: f64) -> f64 {
    (v * 1e4).round() / 1e4
}

fn r6(v: f64) -> f64 {
    if v == 0.0 {
        return 0.0;
    }
    let m = 10f64.powi(5 - v.abs().log10().floor() as i32);
    (v * m).round() / m
}

pub fn run(input: Value) -> Result<Value, String> {
    let t0 = Instant::now();
    let inp: Input = serde_json::from_value(input).map_err(|e| format!("irdrop input: {e}"))?;
    let b = &inp.board;
    let net = &inp.net;
    let temp = inp.temp_c.unwrap_or(25.0);
    let rho = rho_mm(temp);
    let nl = b.n_layers();
    if nl == 0 {
        return Err("irdrop: board has no copper layers".into());
    }

    let tracks: Vec<usize> = (0..b.tracks.len()).filter(|&i| &b.tracks[i].net == net && b.layer_index(&b.tracks[i].layer).is_some()).collect();
    let vias: Vec<usize> = (0..b.vias.len()).filter(|&i| &b.vias[i].net == net).collect();
    let pads: Vec<usize> = (0..b.pads.len()).filter(|&i| &b.pads[i].net == net && !b.pad_layers(&b.pads[i]).is_empty()).collect();

    let mut uf = Uf(Vec::new());
    let pad_node: HashMap<usize, u32> = pads.iter().map(|&k| (k, uf.add())).collect();
    let pad_shape: HashMap<usize, Shape> = pads.iter().map(|&k| (k, b.pads[k].shape())).collect();
    // via node per layer it spans
    let mut via_node: HashMap<(usize, usize), u32> = HashMap::new();
    for &v in &vias {
        for l in b.via_layers(&b.vias[v]) {
            via_node.insert((v, l), uf.add());
        }
    }
    let track_end: Vec<[u32; 2]> = tracks.iter().map(|_| [uf.add(), uf.add()]).collect();
    let track_pos: HashMap<usize, usize> = tracks.iter().enumerate().map(|(k, &t)| (t, k)).collect();

    // Zone cells: one raster per layer over this net's fills.
    let mut zone_bbox = vec![BBox::EMPTY; nl];
    let mut zone_rings: Vec<Vec<Vec<Vec<P>>>> = vec![Vec::new(); nl];
    for z in b.zones.iter().filter(|z| &z.net == net) {
        let Some(l) = b.layer_index(&z.layer) else { continue };
        for poly in &z.polygons {
            let rings: Vec<Vec<P>> = poly.iter().map(|r| ring(r)).filter(|r| r.len() >= 3).collect();
            if rings.is_empty() {
                continue;
            }
            zone_bbox[l] = zone_bbox[l].union(BBox::of_points(rings.iter().flatten()));
            zone_rings[l].push(rings);
        }
    }
    let mut cell = inp.cell.unwrap_or(0.2).max(0.02);
    let zone_area: f64 = zone_bbox.iter().filter(|bb| !bb.is_empty()).map(|bb| bb.width() * bb.height()).sum();
    while zone_area / (cell * cell) > MAX_ZONE_CELLS as f64 {
        cell *= 1.25;
    }
    let mut rasters: Vec<Option<Raster>> = vec![None; nl];
    let mut cell_node: Vec<Vec<u32>> = vec![Vec::new(); nl];
    for l in 0..nl {
        if zone_rings[l].is_empty() {
            continue;
        }
        let mut r = Raster::covering(zone_bbox[l], cell);
        for rings in &zone_rings[l] {
            r.fill_rings(rings, 1);
        }
        cell_node[l] = r.v.iter().map(|&v| if v != 0 { uf.add() } else { u32::MAX }).collect();
        rasters[l] = Some(r);
    }
    let cell_at = |l: usize, q: P| -> Option<u32> {
        let r = rasters[l].as_ref()?;
        let (i, j) = r.cell_of(q)?;
        let n = cell_node[l][r.idx(i, j)];
        (n != u32::MAX).then_some(n)
    };

    // Per-layer index of this net's tracks, pads and vias.
    let mut things: Vec<Vec<(Thing, Shape)>> = vec![Vec::new(); nl];
    for &t in &tracks {
        let l = b.layer_index(&b.tracks[t].layer).unwrap();
        things[l].push((Thing::Track(t), b.tracks[t].shape()));
    }
    for &k in &pads {
        for l in b.pad_layers(&b.pads[k]) {
            things[l].push((Thing::Pad(k), pad_shape[&k].clone()));
        }
    }
    for &v in &vias {
        for l in b.via_layers(&b.vias[v]) {
            things[l].push((Thing::Via(v), b.vias[v].shape()));
        }
    }
    let area = things.iter().flatten().fold(b.outline_bbox(), |a, t| a.union(t.1.bbox)).grow(1.0);
    let grids: Vec<Grid> = things.iter().map(|ts| Grid::build(area, 1.0, ts.iter().map(|t| &t.1))).collect();

    // Track ends join whatever copper of the net they land in; an end on the
    // middle of another track splits it there (a T-join).
    let mut splits: Vec<Vec<(f64, u32)>> = vec![Vec::new(); tracks.len()];
    for (k, &t) in tracks.iter().enumerate() {
        let tr = &b.tracks[t];
        let l = b.layer_index(&tr.layer).unwrap();
        for (e, q) in [P::from(tr.a), P::from(tr.b)].into_iter().enumerate() {
            let me = track_end[k][e];
            let mut hits: Vec<(u32, Thing)> = Vec::new();
            grids[l].query(BBox::of_points(&[q]).grow(1e-3), |id| {
                let (th, ref s) = things[l][id as usize];
                if !matches!(th, Thing::Track(o) if o == t) && s.point_dist(q) <= 1e-6 {
                    hits.push((id, th));
                }
            });
            // a point on a cell corner comes back from four cells
            hits.sort_unstable_by_key(|h| h.0);
            hits.dedup_by_key(|h| h.0);
            for (_, th) in hits {
                match th {
                    Thing::Pad(pk) => uf.union(me, pad_node[&pk]),
                    Thing::Via(v) => uf.union(me, via_node[&(v, l)]),
                    Thing::Track(o) => {
                        let ot = &b.tracks[o];
                        let (oa, ob) = (P::from(ot.a), P::from(ot.b));
                        let ok = track_pos[&o];
                        let (cp, s) = seg_closest(oa, ob, q);
                        let len = oa.dist(ob);
                        let r = 0.5 * ot.w;
                        if cp.dist(oa) <= r.max(1e-3) {
                            uf.union(me, track_end[ok][0]);
                        } else if cp.dist(ob) <= r.max(1e-3) || len <= 0.0 {
                            uf.union(me, track_end[ok][1]);
                        } else {
                            let n = uf.add();
                            uf.union(me, n);
                            splits[ok].push((s, n));
                        }
                    }
                }
            }
            if let Some(c) = cell_at(l, q) {
                uf.union(me, c);
            }
        }
    }

    // Pads and vias join the zone cells they overlap, and vias join pads they
    // sit in.
    let join_cells = |uf: &mut Uf, l: usize, s: &Shape, node: u32| {
        let Some(r) = rasters[l].as_ref() else { return };
        let mut any = false;
        let half = 0.5 * r.d;
        r.rect_spans(s.bbox.grow(1.5 * half), |j, i0, i1| {
            for i in i0..=i1 {
                let n = cell_node[l][r.idx(i, j)];
                // + a hair: a pad drawn exactly against the pour's edge
                if n != u32::MAX && s.point_dist(r.centre(i, j)) <= half * (1.0 + 1e-6) + 1e-9 {
                    uf.union(node, n);
                    any = true;
                }
            }
        });
        if !any {
            let c = crate::geom::p(0.5 * (s.bbox.x0 + s.bbox.x1), 0.5 * (s.bbox.y0 + s.bbox.y1));
            if let Some((i, j)) = r.cell_of(c) {
                let n = cell_node[l][r.idx(i, j)];
                if n != u32::MAX && s.point_dist(r.centre(i, j)) <= r.d {
                    uf.union(node, n);
                }
            }
        }
    };
    for &k in &pads {
        for l in b.pad_layers(&b.pads[k]) {
            join_cells(&mut uf, l, &pad_shape[&k], pad_node[&k]);
        }
    }
    for &v in &vias {
        let vs = b.vias[v].shape();
        for l in b.via_layers(&b.vias[v]) {
            let node = via_node[&(v, l)];
            join_cells(&mut uf, l, &vs, node);
            for &k in &pads {
                if b.pad_layers(&b.pads[k]).contains(&l) && pad_shape[&k].contains(vs.rep()) {
                    uf.union(node, pad_node[&k]);
                }
            }
        }
    }

    // Resistors.
    let mut res: Vec<Res> = Vec::new();
    for (k, &t) in tracks.iter().enumerate() {
        let tr = &b.tracks[t];
        let l = b.layer_index(&tr.layer).unwrap();
        let (a, bb) = (P::from(tr.a), P::from(tr.b));
        let len = a.dist(bb);
        let mut pts = vec![(0.0, track_end[k][0])];
        let mut sp = splits[k].clone();
        sp.sort_by(|x, y| x.0.total_cmp(&y.0));
        pts.extend(sp);
        pts.push((1.0, track_end[k][1]));
        for w in pts.windows(2) {
            let piece = (w[1].0 - w[0].0) * len;
            if piece <= 1e-6 {
                uf.union(w[0].1, w[1].1);
            } else if tr.w > 0.0 {
                let g = tr.w * b.copper_t(l) / (rho * piece);
                res.push(Res { a: w[0].1, b: w[1].1, g, what: Elem::Track { t, s0: w[0].0, s1: w[1].0 } });
            }
        }
    }
    for &v in &vias {
        let via = &b.vias[v];
        let ls = b.via_layers(via);
        let area = std::f64::consts::PI * PLATING_MM * (via.drill.max(0.05) + PLATING_MM);
        for w in ls.windows(2) {
            let h = b.dielectric_t(w[0]) + 0.5 * (b.copper_t(w[0]) + b.copper_t(w[1]));
            res.push(Res { a: via_node[&(v, w[0])], b: via_node[&(v, w[1])], g: area / (rho * h), what: Elem::Via { v } });
        }
    }
    for l in 0..nl {
        let Some(r) = rasters[l].as_ref() else { continue };
        let g = b.copper_t(l) / rho; // one square: (t/ρ)·(c/c)
        for j in 0..r.ny {
            for i in 0..r.nx {
                let n = cell_node[l][r.idx(i, j)];
                if n == u32::MAX {
                    continue;
                }
                if i + 1 < r.nx {
                    let m = cell_node[l][r.idx(i + 1, j)];
                    if m != u32::MAX {
                        res.push(Res { a: n, b: m, g, what: Elem::Zone { layer: l, at: r.centre(i, j).mid(r.centre(i + 1, j)) } });
                    }
                }
                if j + 1 < r.ny {
                    let m = cell_node[l][r.idx(i, j + 1)];
                    if m != u32::MAX {
                        res.push(Res { a: n, b: m, g, what: Elem::Zone { layer: l, at: r.centre(i, j).mid(r.centre(i, j + 1)) } });
                    }
                }
            }
        }
    }

    // Compress merged nodes.
    let nraw = uf.0.len();
    let mut dense = vec![u32::MAX; nraw];
    let mut n = 0u32;
    for x in 0..nraw as u32 {
        let r = uf.find(x);
        if dense[r as usize] == u32::MAX {
            dense[r as usize] = n;
            n += 1;
        }
        dense[x as usize] = dense[r as usize];
    }
    let n = n as usize;
    for e in res.iter_mut() {
        e.a = dense[e.a as usize];
        e.b = dense[e.b as usize];
    }
    res.retain(|e| e.a != e.b);
    let node_of_pad = |k: usize| dense[pad_node[&k] as usize] as usize;

    // Terminals.
    let pads_of = |t: &Terminal| -> Vec<usize> {
        pads.iter().copied().filter(|&k| b.pads[k].reference == t.reference && t.num.as_ref().is_none_or(|nm| &b.pads[k].num == nm)).collect()
    };
    let vref = inp.sources.iter().map(|s| s.voltage).fold(f64::NEG_INFINITY, f64::max);
    let mut fixed: Vec<Option<f64>> = vec![None; n];
    for s in &inp.sources {
        let ps = pads_of(s);
        if ps.is_empty() {
            return Err(format!("irdrop: source {}{} has no pad on net {net}", s.reference, s.num.as_ref().map(|n| format!(".{n}")).unwrap_or_default()));
        }
        for k in ps {
            fixed[node_of_pad(k)] = Some(vref - s.voltage);
        }
    }
    if inp.sources.is_empty() {
        return Err("irdrop: no sources".into());
    }

    // Components that reach a source.
    let mut cuf = Uf((0..n as u32).collect());
    for e in &res {
        cuf.union(e.a, e.b);
    }
    let mut live = vec![false; n];
    for i in 0..n {
        if fixed[i].is_some() {
            let r = cuf.find(i as u32) as usize;
            live[r] = true;
        }
    }
    let is_live = |cuf: &mut Uf, i: usize| live[cuf.find(i as u32) as usize];

    struct SinkPads {
        t: Terminal,
        nodes: Vec<(u32, String)>, // connected pad nodes and pad numbers
    }
    let mut sinks: Vec<SinkPads> = Vec::new();
    let mut missing = Vec::new();
    let mut islands: HashMap<u32, Vec<String>> = HashMap::new();
    for s in &inp.sinks {
        let ps = pads_of(s);
        if ps.is_empty() {
            missing.push(json!({"ref": s.reference, "num": s.num}));
            continue;
        }
        let nodes: Vec<(u32, String)> = ps.iter().map(|&k| (node_of_pad(k) as u32, b.pads[k].num.clone())).filter(|(nd, _)| is_live(&mut cuf, *nd as usize)).collect();
        if nodes.is_empty() {
            let comp = cuf.find(node_of_pad(ps[0]) as u32);
            let e = islands.entry(comp).or_default();
            if !e.contains(&s.reference) {
                e.push(s.reference.clone());
            }
            continue;
        }
        sinks.push(SinkPads { t: s.clone(), nodes });
    }

    // Unknowns: live, not held.
    let mut unk = vec![u32::MAX; n];
    let mut nu = 0usize;
    for i in 0..n {
        if fixed[i].is_none() && is_live(&mut cuf, i) {
            unk[i] = nu as u32;
            nu += 1;
        }
    }
    let mut lap = Laplacian::new(nu);
    let mut rhs_fixed = vec![0.0; nu];
    for e in &res {
        let (a, bn) = (e.a as usize, e.b as usize);
        match (unk[a] != u32::MAX, unk[bn] != u32::MAX) {
            (true, true) => lap.link(unk[a] as usize, unk[bn] as usize, e.g),
            (true, false) => {
                if let Some(u) = fixed[bn] {
                    lap.to_fixed(unk[a] as usize, e.g);
                    rhs_fixed[unk[a] as usize] += e.g * u;
                }
            }
            (false, true) => {
                if let Some(u) = fixed[a] {
                    lap.to_fixed(unk[bn] as usize, e.g);
                    rhs_fixed[unk[bn] as usize] += e.g * u;
                }
            }
            _ => {}
        }
    }
    let a = lap.finish();
    let mut rhs = rhs_fixed.clone();
    let inject = |rhs: &mut Vec<f64>, s: &SinkPads, amps: f64| {
        let share = amps / s.nodes.len() as f64;
        for (nd, _) in &s.nodes {
            let u = unk[*nd as usize];
            if u != u32::MAX {
                rhs[u as usize] += share;
            }
        }
    };
    for s in &sinks {
        inject(&mut rhs, s, s.t.current);
    }
    let mut x = vec![0.0; nu];
    // One preconditioner for both solves (same matrix).  1e-10 relative
    // residual leaves the drops exact to far below a microvolt.
    let pc = Precond::for_matrix(&a);
    let st = pcg_with(&a, &rhs, &mut x, 1e-10, 20_000, &pc);
    let mut iterations = st.iterations;
    let u_of = |x: &[f64], i: usize| -> Option<f64> {
        if let Some(f) = fixed[i] {
            Some(f)
        } else if unk[i] != u32::MAX {
            Some(x[unk[i] as usize])
        } else {
            None
        }
    };

    // Drops per sink (worst pad of each).
    let mut sink_out = Vec::new();
    let mut worst: Option<(f64, usize, String)> = None;
    for (si, s) in sinks.iter().enumerate() {
        let mut d = f64::NEG_INFINITY;
        let mut num = String::new();
        for (nd, pn) in &s.nodes {
            let u = u_of(&x, *nd as usize).unwrap_or(0.0);
            if u > d {
                d = u;
                num = pn.clone();
            }
        }
        sink_out.push(json!({"ref": s.t.reference, "num": num, "current": s.t.current, "drop_mv": r4(d * 1e3)}));
        if worst.as_ref().is_none_or(|w| d > w.0) {
            worst = Some((d, si, num));
        }
    }

    // Effective resistance source -> worst sink: 1 A into that sink alone,
    // sources held at 0.
    let mut r_eff = None;
    if let Some((_, wi, _)) = &worst {
        let mut rhs1 = vec![0.0; nu];
        inject(&mut rhs1, &sinks[*wi], 1.0);
        let mut x1 = vec![0.0; nu];
        let st1 = pcg_with(&a, &rhs1, &mut x1, 1e-10, 20_000, &pc);
        iterations += st1.iterations;
        let s = &sinks[*wi];
        let share = 1.0 / s.nodes.len() as f64;
        let mut r = 0.0;
        for (nd, _) in &s.nodes {
            let u = unk[*nd as usize];
            if u != u32::MAX {
                r += share * x1[u as usize];
            }
        }
        r_eff = Some(r);
    }

    // Currents, densities, heat.
    let mut heat: HashMap<(i64, i64), (f64, f64, f64)> = HashMap::new();
    let bin = 0.5;
    let mut add_heat = |q: P, w: f64| {
        if w <= 0.0 {
            return;
        }
        let k = ((q.x / bin).floor() as i64, (q.y / bin).floor() as i64);
        let e = heat.entry(k).or_insert((0.0, 0.0, 0.0));
        e.0 += w;
        e.1 += w * q.x;
        e.2 += w * q.y;
    };
    let mut max_density: Option<(f64, P, usize)> = None;
    let mut track_max: Option<(f64, f64, f64, P, usize)> = None; // density, current, w, at, layer
    let mut via_cur: HashMap<usize, f64> = HashMap::new();
    let mut total_heat = 0.0;
    for e in &res {
        let (Some(ua), Some(ub)) = (u_of(&x, e.a as usize), u_of(&x, e.b as usize)) else { continue };
        let i = (ub - ua) * e.g;
        let w = i * i / e.g;
        total_heat += w;
        match e.what {
            Elem::Track { t, s0, s1 } => {
                let tr = &b.tracks[t];
                let l = b.layer_index(&tr.layer).unwrap();
                let (a0, a1) = (P::from(tr.a), P::from(tr.b));
                let (p0, p1) = (a0.add(a1.sub(a0).mul(s0)), a0.add(a1.sub(a0).mul(s1)));
                let dens = i.abs() / (tr.w * b.copper_t(l));
                let mid = p0.mid(p1);
                if max_density.is_none_or(|m| dens > m.0) {
                    max_density = Some((dens, mid, l));
                }
                if track_max.is_none_or(|m| dens > m.0) {
                    track_max = Some((dens, i.abs(), tr.w, mid, l));
                }
                let k = (p0.dist(p1) / bin).ceil().max(1.0) as usize;
                for s in 0..k {
                    add_heat(p0.add(p1.sub(p0).mul((s as f64 + 0.5) / k as f64)), w / k as f64);
                }
            }
            Elem::Via { v } => {
                let c = via_cur.entry(v).or_insert(0.0);
                *c = c.max(i.abs());
                add_heat(b.vias[v].c(), w);
            }
            Elem::Zone { layer, at } => {
                let dens = i.abs() / (cell * b.copper_t(layer));
                if max_density.is_none_or(|m| dens > m.0) {
                    max_density = Some((dens, at, layer));
                }
                add_heat(at, w);
            }
        }
    }
    let via_max = via_cur.iter().max_by(|a, b| a.1.total_cmp(b.1)).map(|(&v, &c)| {
        let via = &b.vias[v];
        json!({"current": r6(c), "at": [r4(via.x), r4(via.y)], "d": via.d, "drill": via.drill})
    });
    let mut heat_out: Vec<(f64, f64, f64)> = heat.values().filter(|h| h.0 > 1e-9).map(|h| (h.1 / h.0, h.2 / h.0, h.0)).collect();
    heat_out.sort_by(|a, b| b.2.total_cmp(&a.2));

    let mut isl: Vec<Value> = islands.into_values().map(|refs| json!({"refs": refs})).collect();
    isl.sort_by_key(|v| v.to_string());
    let out = json!({
        "net": net,
        "temp_c": temp,
        "worst_mv": worst.as_ref().map(|w| r4(w.0 * 1e3)),
        "worst": worst.as_ref().map(|w| json!({"ref": sinks[w.1].t.reference, "num": w.2})),
        "sinks": sink_out,
        "resistance_mohm": r_eff.map(|r| r4(r * 1e3)),
        "max_density": max_density.map(|(d, q, l)| json!({"value": r4(d), "unit": "A/mm2", "at": [r4(q.x), r4(q.y)], "layer": b.layers[l]})),
        "track_max": track_max.map(|(d, i, w, q, l)| json!({"current": r6(i), "w": w, "density": r4(d), "at": [r4(q.x), r4(q.y)], "layer": b.layers[l]})),
        "via_max": via_max,
        "heat": heat_out.iter().map(|h| json!({"x": r4(h.0), "y": r4(h.1), "w": r6(h.2)})).collect::<Vec<_>>(),
        "heat_total_w": r6(total_heat),
        "islands": isl,
        "missing": missing,
        "stats": {"nodes": n, "unknowns": nu, "resistors": res.len(), "zone_cell": cell, "iterations": iterations,
                  "converged": st.converged, "ms": r4(t0.elapsed().as_secs_f64() * 1e3)},
    });
    Ok(out)
}
