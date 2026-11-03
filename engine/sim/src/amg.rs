// SPDX-License-Identifier: AGPL-3.0-or-later
//! Smoothed-aggregation algebraic multigrid, used as a CG preconditioner for
//! the big systems (a board-sized heat grid, a ground pour's cell network).
//!
//! Why: both matrices are "diffusion with a weak leak".  Heat spreads tens of
//! millimetres through copper before the faces lose it, and a pour is all
//! conduction with the only anchor at the source pads.  Single-level
//! preconditioners (Jacobi, IC(0)) need iterations growing with the grid
//! width — hundreds here.  Multigrid fixes the smooth, board-wide error on
//! coarse grids where it is cheap, so CG converges in a few dozen iterations
//! whatever the grid size.
//!
//! Recipe (Vaněk, Mandel & Brezina 1996): group strongly coupled unknowns
//! into aggregates, prolong by piecewise constants smoothed with one damped
//! Jacobi step, coarse operator PᵀAP; V-cycle with one forward Gauss–Seidel
//! sweep before and one backward after, so the cycle is symmetric and CG can
//! use it.  Coarsest level: dense Cholesky.

use crate::solve::Csr;

const STRENGTH: f64 = 0.08;
const COARSEST: usize = 400;
const MAX_LEVELS: usize = 16;

struct Level {
    a: Csr,
    dinv: Vec<f64>,
    p: Csr, // n_fine × n_coarse
    r: Csr, // Pᵀ
}

pub struct Amg {
    levels: Vec<Level>,
    /// Dense Cholesky factor of the coarsest matrix, row-major lower.
    chol: Vec<f64>,
    nc: usize,
}

fn diag_inv(a: &Csr) -> Vec<f64> {
    a.diag().iter().map(|&d| if d > 0.0 { 1.0 / d } else { 0.0 }).collect()
}

/// Greedy aggregation over the strong-coupling graph.
fn aggregate(a: &Csr) -> (Vec<u32>, usize) {
    let n = a.n;
    let d = a.diag();
    let strong = |i: usize, k: usize| {
        let j = a.col[k] as usize;
        j != i && a.val[k].abs() >= STRENGTH * (d[i] * d[j]).abs().sqrt()
    };
    const NONE: u32 = u32::MAX;
    let mut agg = vec![NONE; n];
    let mut nagg = 0u32;
    // 1: roots whose whole strong neighbourhood is free
    for i in 0..n {
        if agg[i] != NONE {
            continue;
        }
        let free = (a.rowptr[i]..a.rowptr[i + 1]).all(|k| !strong(i, k) || agg[a.col[k] as usize] == NONE);
        let has = (a.rowptr[i]..a.rowptr[i + 1]).any(|k| strong(i, k));
        if free && has {
            agg[i] = nagg;
            for k in a.rowptr[i]..a.rowptr[i + 1] {
                if strong(i, k) {
                    agg[a.col[k] as usize] = nagg;
                }
            }
            nagg += 1;
        }
    }
    // 2: leftovers join their strongest aggregated neighbour
    let snapshot = agg.clone();
    for i in 0..n {
        if agg[i] != NONE {
            continue;
        }
        let mut best = (0.0, NONE);
        for k in a.rowptr[i]..a.rowptr[i + 1] {
            let j = a.col[k] as usize;
            if strong(i, k) && snapshot[j] != NONE && a.val[k].abs() > best.0 {
                best = (a.val[k].abs(), snapshot[j]);
            }
        }
        agg[i] = best.1;
    }
    // 3: still alone (no strong neighbours at all): own aggregate
    for g in agg.iter_mut() {
        if *g == NONE {
            *g = nagg;
            nagg += 1;
        }
    }
    (agg, nagg as usize)
}

fn transpose(a: &Csr) -> Csr {
    let mut cnt = vec![0usize; a.m + 1];
    for &c in &a.col {
        cnt[c as usize + 1] += 1;
    }
    for i in 0..a.m {
        cnt[i + 1] += cnt[i];
    }
    let mut fill = cnt.clone();
    let mut col = vec![0u32; a.col.len()];
    let mut val = vec![0.0; a.col.len()];
    for i in 0..a.n {
        for k in a.rowptr[i]..a.rowptr[i + 1] {
            let c = a.col[k] as usize;
            col[fill[c]] = i as u32;
            val[fill[c]] = a.val[k];
            fill[c] += 1;
        }
    }
    Csr { n: a.m, m: a.n, rowptr: cnt, col, val }
}

/// C = A·B (Gustavson, dense marker per row), columns sorted.
fn matmul(a: &Csr, b: &Csr) -> Csr {
    let mut rowptr = vec![0usize; a.n + 1];
    let mut col: Vec<u32> = Vec::new();
    let mut val: Vec<f64> = Vec::new();
    let mut acc = vec![0.0f64; b.m];
    let mut mark = vec![u32::MAX; b.m];
    let mut cols: Vec<u32> = Vec::new();
    for i in 0..a.n {
        cols.clear();
        for ka in a.rowptr[i]..a.rowptr[i + 1] {
            let j = a.col[ka] as usize;
            let av = a.val[ka];
            for kb in b.rowptr[j]..b.rowptr[j + 1] {
                let c = b.col[kb];
                if mark[c as usize] != i as u32 {
                    mark[c as usize] = i as u32;
                    acc[c as usize] = 0.0;
                    cols.push(c);
                }
                acc[c as usize] += av * b.val[kb];
            }
        }
        cols.sort_unstable();
        for &c in &cols {
            let v = acc[c as usize];
            if v != 0.0 {
                col.push(c);
                val.push(v);
            }
        }
        rowptr[i + 1] = col.len();
    }
    Csr { n: a.n, m: b.m, rowptr, col, val }
}

fn dense_cholesky(a: &Csr) -> Vec<f64> {
    let n = a.n;
    let mut l = vec![0.0; n * n];
    for i in 0..n {
        for k in a.rowptr[i]..a.rowptr[i + 1] {
            l[i * n + a.col[k] as usize] = a.val[k];
        }
    }
    for j in 0..n {
        let mut d = l[j * n + j];
        for k in 0..j {
            d -= l[j * n + k] * l[j * n + k];
        }
        // A coarse operator can be (nearly) singular in a floating island;
        // a tiny floor keeps the preconditioner finite and SPD.
        let d = d.max(1e-14 * l[j * n + j].abs()).max(1e-300).sqrt();
        l[j * n + j] = d;
        for i in j + 1..n {
            let mut s = l[i * n + j];
            for k in 0..j {
                s -= l[i * n + k] * l[j * n + k];
            }
            l[i * n + j] = s / d;
        }
    }
    l
}

impl Amg {
    pub fn new(a: &Csr) -> Amg {
        let mut levels = Vec::new();
        let mut cur = a.clone();
        while cur.n > COARSEST && levels.len() < MAX_LEVELS {
            let (agg, nc) = aggregate(&cur);
            if nc as f64 > 0.85 * cur.n as f64 {
                break; // not coarsening any more
            }
            let dinv = diag_inv(&cur);
            // Jacobi-smoothed prolongator P = (I − ω D⁻¹A) P_tent, with ω from
            // a Gershgorin bound on ρ(D⁻¹A).
            let mut rho: f64 = 0.0;
            for i in 0..cur.n {
                let s: f64 = (cur.rowptr[i]..cur.rowptr[i + 1]).map(|k| cur.val[k].abs()).sum();
                rho = rho.max(s * dinv[i]);
            }
            let omega = 4.0 / (3.0 * rho.max(1.0));
            let mut s = cur.clone();
            for i in 0..s.n {
                for k in s.rowptr[i]..s.rowptr[i + 1] {
                    let delta = if s.col[k] as usize == i { 1.0 } else { 0.0 };
                    s.val[k] = delta - omega * dinv[i] * s.val[k];
                }
            }
            let pt = Csr { n: cur.n, m: nc, rowptr: (0..=cur.n).collect(), col: agg, val: vec![1.0; cur.n] };
            let p = matmul(&s, &pt);
            let r = transpose(&p);
            let ac = matmul(&r, &matmul(&cur, &p));
            levels.push(Level { a: cur, dinv, p, r });
            cur = ac;
        }
        let chol = dense_cholesky(&cur);
        let nc = cur.n;
        Amg { levels, chol, nc }
    }

    pub fn levels(&self) -> usize {
        self.levels.len() + 1
    }

    fn coarse_solve(&self, b: &[f64], x: &mut [f64]) {
        let n = self.nc;
        let l = &self.chol;
        for i in 0..n {
            let mut s = b[i];
            for k in 0..i {
                s -= l[i * n + k] * x[k];
            }
            x[i] = s / l[i * n + i];
        }
        for i in (0..n).rev() {
            let mut s = x[i];
            for k in i + 1..n {
                s -= l[k * n + i] * x[k];
            }
            x[i] = s / l[i * n + i];
        }
    }

    fn cycle(&self, lv: usize, b: &[f64], x: &mut [f64]) {
        if lv == self.levels.len() {
            self.coarse_solve(b, x);
            return;
        }
        let lvl = &self.levels[lv];
        let a = &lvl.a;
        let n = a.n;
        x.iter_mut().for_each(|v| *v = 0.0);
        // forward Gauss–Seidel
        for i in 0..n {
            let mut s = b[i];
            for k in a.rowptr[i]..a.rowptr[i + 1] {
                let j = a.col[k] as usize;
                if j != i {
                    s -= a.val[k] * x[j];
                }
            }
            x[i] = s * lvl.dinv[i];
        }
        let mut r = vec![0.0; n];
        a.mul(x, &mut r);
        for i in 0..n {
            r[i] = b[i] - r[i];
        }
        let mut bc = vec![0.0; lvl.r.n];
        lvl.r.mul(&r, &mut bc);
        let mut xc = vec![0.0; lvl.r.n];
        self.cycle(lv + 1, &bc, &mut xc);
        let mut corr = vec![0.0; n];
        lvl.p.mul(&xc, &mut corr);
        for i in 0..n {
            x[i] += corr[i];
        }
        // backward Gauss–Seidel (keeps the cycle symmetric)
        for i in (0..n).rev() {
            let mut s = b[i];
            for k in a.rowptr[i]..a.rowptr[i + 1] {
                let j = a.col[k] as usize;
                if j != i {
                    s -= a.val[k] * x[j];
                }
            }
            x[i] = s * lvl.dinv[i];
        }
    }

    /// z ≈ A⁻¹ r by one V-cycle.
    pub fn apply(&self, r: &[f64], z: &mut [f64]) {
        if self.levels.is_empty() {
            self.coarse_solve(r, z);
        } else {
            self.cycle(0, r, z);
        }
    }
}
