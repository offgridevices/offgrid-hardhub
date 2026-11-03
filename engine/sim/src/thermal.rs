// SPDX-License-Identifier: AGPL-3.0-or-later
//! `thermal`: steady-state board temperature as a thin plate.
//!
//! Each grid cell is one temperature.  Heat spreads in-plane through the
//! copper on every layer (390 W/m·K times thickness times how much of the cell
//! is copper) plus the glass-epoxy core (0.8 W/m·K in-plane for woven FR4),
//! and leaves through both faces by natural convection and radiation.  Those
//! face losses grow faster than linearly with temperature (convection
//! ∝ ΔT^1.25, radiation ∝ T⁴), so the nonlinear balance is solved by Newton's
//! method: each step is one linear plate solve with the loss linearised
//! around the last temperatures.  A step converges the T-dependent h in 3–5
//! solves where fixed-point iteration on h needs about twice as many.

use crate::model::{ring, Board};
use crate::raster::Raster;
use crate::solve::{pcg, Csr, Laplacian};
use base64::Engine;
use serde::Deserialize;
use serde_json::{json, Value};
use std::time::Instant;

pub const K_CU: f64 = 390.0;
pub const K_FR4_INPLANE: f64 = 0.8;
pub const SIGMA: f64 = 5.670_374_419e-8;
/// Natural convection from a horizontal plate in air, h = C·(ΔT/L)^¼:
/// hot face up, hot face down (the board is assumed lying flat, parts up;
/// the weaker underside is the cautious choice for a "will it be OK" check).
pub const C_UP: f64 = 1.32;
pub const C_DOWN: f64 = 0.59;
/// A closed box cools worse: computed h is scaled by this.
pub const ENCLOSED: f64 = 0.6;
/// ΔT below this uses the h of this ΔT (h ∝ ΔT^¼ has an infinite slope at 0).
const DT_FLOOR: f64 = 0.5;

#[derive(Deserialize, Debug, Clone, Default)]
#[serde(default)]
pub struct Source {
    #[serde(rename = "ref")]
    pub reference: String,
    pub power: f64,
    pub rect: [f64; 4],
    pub side: String,
    pub theta_jb: Option<f64>,
}

#[derive(Deserialize, Debug, Clone, Default)]
#[serde(default)]
pub struct Heat {
    pub x: f64,
    pub y: f64,
    pub w: f64,
}

#[derive(Deserialize, Debug)]
#[serde(default)]
pub struct Input {
    pub board: Board,
    pub ambients: Vec<f64>,
    pub cell: f64,
    pub sources: Vec<Source>,
    pub extra_heat: Vec<Heat>,
    pub h_top: Option<f64>,
    pub h_bottom: Option<f64>,
    pub enclosed: bool,
    pub emissivity: f64,
}

impl Default for Input {
    fn default() -> Self {
        Input {
            board: Board::default(),
            ambients: vec![25.0],
            cell: 0.5,
            sources: vec![],
            extra_heat: vec![],
            h_top: None,
            h_bottom: None,
            enclosed: false,
            emissivity: 0.9,
        }
    }
}

/// One face's heat loss per area, q(θ) in W/m², and dq/dθ.
#[derive(Clone, Copy)]
struct Face {
    fixed_h: Option<f64>,
    c_conv: f64,
    scale: f64,
}

impl Face {
    fn q(&self, theta: f64, ta_k: f64, l: f64, eps: f64) -> (f64, f64) {
        if let Some(h) = self.fixed_h {
            return (h * theta, h);
        }
        let th = theta.max(0.0);
        let (hc, dhc) = if th > DT_FLOOR {
            let h = self.c_conv * (th / l).powf(0.25);
            (h, 1.25 * h) // d(hθ)/dθ = h + θ·h' = 1.25 h
        } else {
            let h = self.c_conv * (DT_FLOOR / l).powf(0.25);
            (h, h)
        };
        let t = ta_k + th;
        let q_rad = eps * SIGMA * (t.powi(4) - ta_k.powi(4));
        let dq_rad = 4.0 * eps * SIGMA * t.powi(3);
        (self.scale * (hc * th + q_rad), self.scale * (dhc + dq_rad))
    }
}

fn r3(v: f64) -> f64 {
    (v * 1e3).round() / 1e3
}

pub fn run(input: Value) -> Result<Value, String> {
    let t0 = Instant::now();
    let inp: Input = serde_json::from_value(input).map_err(|e| format!("thermal input: {e}"))?;
    let b = &inp.board;
    let dx = if inp.cell > 0.0 { inp.cell } else { 0.5 };
    let bb = b.outline_bbox();
    let rings = b.board_rings();
    if rings.is_empty() {
        return Err("thermal: board outline missing".into());
    }
    let mut mask = Raster::covering(bb, dx);
    mask.fill_rings(&rings, 1);
    let (nx, ny) = (mask.nx, mask.ny);
    let ncell = nx * ny;

    // Copper coverage per cell, all layers, from a 4×4 sub-raster.
    const SUB: usize = 4;
    let mut kt = vec![K_FR4_INPLANE * b.total_dielectric() * 1e-3; ncell];
    for l in 0..b.n_layers() {
        let mut sub = Raster { x0: mask.x0, y0: mask.y0, d: dx / SUB as f64, nx: nx * SUB, ny: ny * SUB, v: vec![0; ncell * SUB * SUB] };
        let name = &b.layers[l];
        for t in b.tracks.iter().filter(|t| &t.layer == name) {
            sub.fill_shape(&t.shape(), 1);
        }
        for v in b.vias.iter().filter(|v| b.via_layers(v).contains(&l)) {
            sub.fill_shape(&v.shape(), 1);
        }
        for p in b.pads.iter().filter(|p| b.pad_layers(p).contains(&l)) {
            sub.fill_shape(&p.shape(), 1);
        }
        for z in b.zones.iter().filter(|z| &z.layer == name) {
            for poly in &z.polygons {
                let rs: Vec<_> = poly.iter().map(|r| ring(r)).filter(|r| r.len() >= 3).collect();
                sub.fill_rings(&rs, 1);
            }
        }
        let kcu = K_CU * b.copper_t(l) * 1e-3;
        for j in 0..ny {
            for i in 0..nx {
                let mut c = 0;
                for sj in 0..SUB {
                    let row = (j * SUB + sj) * sub.nx + i * SUB;
                    c += sub.v[row..row + SUB].iter().filter(|&&v| v != 0).count();
                }
                kt[j * nx + i] += kcu * c as f64 / (SUB * SUB) as f64;
            }
        }
    }

    // Unknowns: cells inside the board.
    let mut unk = vec![u32::MAX; ncell];
    let mut cells: Vec<usize> = Vec::new();
    for k in 0..ncell {
        if mask.v[k] != 0 {
            unk[k] = cells.len() as u32;
            cells.push(k);
        }
    }
    let nu = cells.len();
    if nu == 0 {
        return Err("thermal: no grid cell inside the board (cell too big?)".into());
    }
    // In-plane conduction: two half cells in series between neighbours.
    let mut lap = Laplacian::new(nu);
    for (u, &k) in cells.iter().enumerate() {
        lap.to_fixed(u, 0.0); // keep a diagonal slot for the face losses
        let (i, j) = (k % nx, k / nx);
        for (ni, nj) in [(i + 1, j), (i, j + 1)] {
            if ni < nx && nj < ny {
                let m = nj * nx + ni;
                if unk[m] != u32::MAX {
                    let g = 2.0 * kt[k] * kt[m] / (kt[k] + kt[m]);
                    lap.link(u, unk[m] as usize, g);
                }
            }
        }
    }
    let base = lap.finish();
    let diag_pos: Vec<usize> = (0..nu).map(|i| (base.rowptr[i]..base.rowptr[i + 1]).find(|&p| base.col[p] as usize == i).unwrap()).collect();

    // Heat in, W per cell.
    let mut q = vec![0.0; nu];
    let cell_area_mm = dx * dx;
    let nearest = |x: f64, y: f64| -> usize {
        let mut best = (f64::INFINITY, 0usize);
        for (u, &k) in cells.iter().enumerate() {
            let c = mask.centre(k % nx, k / nx);
            let d = (c.x - x).hypot(c.y - y);
            if d < best.0 {
                best = (d, u);
            }
        }
        best.1
    };
    // Overlap of each source rect with the cells, so a part's power lands
    // where its body is (and only on the board).
    let rect_cells = |r: [f64; 4]| -> Vec<(usize, f64)> {
        let (x0, x1) = (r[0].min(r[2]), r[0].max(r[2]));
        let (y0, y1) = (r[1].min(r[3]), r[1].max(r[3]));
        let mut out = Vec::new();
        let i0 = (((x0 - mask.x0) / dx).floor().max(0.0) as usize).min(nx - 1);
        let i1 = (((x1 - mask.x0) / dx).floor().max(0.0) as usize).min(nx - 1);
        let j0 = (((y0 - mask.y0) / dx).floor().max(0.0) as usize).min(ny - 1);
        let j1 = (((y1 - mask.y0) / dx).floor().max(0.0) as usize).min(ny - 1);
        for j in j0..=j1 {
            for i in i0..=i1 {
                let k = j * nx + i;
                if unk[k] == u32::MAX {
                    continue;
                }
                let cx0 = mask.x0 + i as f64 * dx;
                let cy0 = mask.y0 + j as f64 * dx;
                let ox = (x1.min(cx0 + dx) - x0.max(cx0)).max(0.0);
                let oy = (y1.min(cy0 + dx) - y0.max(cy0)).max(0.0);
                if ox * oy > 0.0 {
                    out.push((unk[k] as usize, ox * oy));
                }
            }
        }
        if out.is_empty() {
            out.push((nearest(0.5 * (x0 + x1), 0.5 * (y0 + y1)), 1.0));
        }
        out
    };
    let src_cells: Vec<Vec<(usize, f64)>> = inp.sources.iter().map(|s| rect_cells(s.rect)).collect();
    for (s, cs) in inp.sources.iter().zip(&src_cells) {
        let tot: f64 = cs.iter().map(|c| c.1).sum();
        for &(u, a) in cs {
            q[u] += s.power.max(0.0) * a / tot;
        }
    }
    for h in &inp.extra_heat {
        let u = mask.cell_of(crate::geom::p(h.x, h.y)).map(|(i, j)| unk[j * nx + i]).filter(|&u| u != u32::MAX);
        let u = u.map(|u| u as usize).unwrap_or_else(|| nearest(h.x, h.y));
        q[u] += h.w.max(0.0);
    }
    let q_total: f64 = q.iter().sum();

    // Faces.
    let a_cell = cell_area_mm * 1e-6;
    let board_area = nu as f64 * a_cell;
    let perim: f64 = crate::geom::ring_perimeter(&rings[0]) * 1e-3;
    let l_char = (board_area / perim.max(1e-6)).max(1e-3);
    let scale = if inp.enclosed { ENCLOSED } else { 1.0 };
    let top = Face { fixed_h: inp.h_top, c_conv: C_UP, scale };
    let bot = Face { fixed_h: inp.h_bottom, c_conv: C_DOWN, scale };
    let eps = inp.emissivity.clamp(0.0, 1.0);

    let mut ambients = inp.ambients.clone();
    if ambients.is_empty() {
        ambients.push(25.0);
    }
    let mut theta = vec![0.0; nu];
    let mut have_guess = false;
    let mut iterations = 0usize;
    let mut newton_steps = 0usize;
    let mut maps = Vec::new();
    let mut temps_per_source: Vec<Vec<Value>> = vec![Vec::new(); inp.sources.len()];
    let enc = base64::engine::general_purpose::STANDARD;
    for &ta in &ambients {
        let ta_k = ta + 273.15;
        if !have_guess {
            // Uniform first guess from the board-wide balance.
            let total = |th: f64| board_area * (top.q(th, ta_k, l_char, eps).0 + bot.q(th, ta_k, l_char, eps).0);
            let (mut lo, mut hi) = (0.0, 1.0);
            while total(hi) < q_total && hi < 1e5 {
                hi *= 2.0;
            }
            for _ in 0..60 {
                let mid = 0.5 * (lo + hi);
                if total(mid) < q_total {
                    lo = mid;
                } else {
                    hi = mid;
                }
            }
            theta.iter_mut().for_each(|t| *t = 0.5 * (lo + hi));
            have_guess = true;
        }
        let mut a: Csr = base.clone();
        let mut rhs = vec![0.0; nu];
        for _step in 0..30 {
            a.val.copy_from_slice(&base.val);
            for u in 0..nu {
                let (qt, dt) = top.q(theta[u], ta_k, l_char, eps);
                let (qb, db) = bot.q(theta[u], ta_k, l_char, eps);
                let df = (dt + db) * a_cell;
                a.val[diag_pos[u]] += df;
                rhs[u] = q[u] - (qt + qb) * a_cell + df * theta[u];
            }
            let prev = theta.clone();
            let st = pcg(&a, &rhs, &mut theta, 1e-9, 5000);
            iterations += st.iterations;
            newton_steps += 1;
            let change = theta.iter().zip(&prev).map(|(x, y)| (x - y).abs()).fold(0.0, f64::max);
            if change < 2e-3 {
                break;
            }
        }
        // Report.
        let heat_out: f64 = theta.iter().map(|&t| (top.q(t, ta_k, l_char, eps).0 + bot.q(t, ta_k, l_char, eps).0) * a_cell).sum();
        let (mut tmin, mut tmax, mut kmax) = (f64::INFINITY, f64::NEG_INFINITY, 0usize);
        for (u, &t) in theta.iter().enumerate() {
            if t < tmin {
                tmin = t;
            }
            if t > tmax {
                tmax = t;
                kmax = cells[u];
            }
        }
        let span = (tmax - tmin).max(1e-12);
        let mut u8s = vec![0u8; ncell];
        for (u, &k) in cells.iter().enumerate() {
            u8s[k] = (((theta[u] - tmin) / span) * 255.0).round().clamp(0.0, 255.0) as u8;
        }
        let c = mask.centre(kmax % nx, kmax / nx);
        maps.push(json!({"ambient": ta, "min": r3(ta + tmin), "max": r3(ta + tmax), "u8_b64": enc.encode(&u8s),
                         "max_at": [r3(c.x), r3(c.y)], "heat_in_w": r3(q_total * 1e3) / 1e3, "heat_out_w": r3(heat_out * 1e3) / 1e3}));
        for (si, cs) in src_cells.iter().enumerate() {
            let tot: f64 = cs.iter().map(|c| c.1).sum();
            let board_t = ta + cs.iter().map(|&(u, a)| theta[u] * a).sum::<f64>() / tot;
            let s = &inp.sources[si];
            let junction = board_t + s.power.max(0.0) * s.theta_jb.unwrap_or(0.0);
            temps_per_source[si].push(json!({"ambient": ta, "board": r3(board_t), "junction": r3(junction)}));
        }
    }
    let parts: Vec<Value> = inp
        .sources
        .iter()
        .zip(temps_per_source)
        .map(|(s, t)| json!({"ref": s.reference, "power": s.power, "theta_jb": s.theta_jb, "temps": t}))
        .collect();
    Ok(json!({
        "grid": {"x0": mask.x0, "y0": mask.y0, "dx": dx, "dy": dx, "nx": nx, "ny": ny},
        "mask_b64": enc.encode(&mask.v),
        "maps": maps,
        "parts": parts,
        "stats": {"cells": nu, "iterations": iterations, "newton_steps": newton_steps, "l_char_mm": r3(l_char * 1e3),
                  "ms": r3(t0.elapsed().as_secs_f64() * 1e3)},
    }))
}
