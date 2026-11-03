// SPDX-License-Identifier: AGPL-3.0-or-later
//! Sparse symmetric positive-definite solves: CSR matrices and conjugate
//! gradients, preconditioned with an incomplete Cholesky factor IC(0) for
//! small systems and algebraic multigrid (see `amg`) for big ones.
//!
//! Both physical problems here (a resistor network with fixed source
//! voltages, a plate losing heat through its faces) give symmetric M-matrices,
//! for which IC(0) always exists in exact arithmetic; if rounding still breaks
//! it, the solver falls back to plain Jacobi scaling.

/// Compressed sparse rows with sorted columns.
#[derive(Clone, Debug)]
pub struct Csr {
    /// rows
    pub n: usize,
    /// columns
    pub m: usize,
    pub rowptr: Vec<usize>,
    pub col: Vec<u32>,
    pub val: Vec<f64>,
}

impl Csr {
    /// Build from (row, col, value) triplets, summing duplicates.
    pub fn from_triplets(n: usize, mut t: Vec<(u32, u32, f64)>) -> Csr {
        t.sort_unstable_by(|a, b| a.0.cmp(&b.0).then(a.1.cmp(&b.1)));
        let mut rowptr = vec![0usize; n + 1];
        let mut col = Vec::with_capacity(t.len());
        let mut val: Vec<f64> = Vec::with_capacity(t.len());
        let mut last: Option<(u32, u32)> = None;
        for (r, c, v) in t {
            if last == Some((r, c)) {
                *val.last_mut().unwrap() += v;
                continue;
            }
            last = Some((r, c));
            col.push(c);
            val.push(v);
            rowptr[r as usize + 1] += 1;
        }
        for i in 0..n {
            rowptr[i + 1] += rowptr[i];
        }
        Csr { n, m: n, rowptr, col, val }
    }

    pub fn mul(&self, x: &[f64], y: &mut [f64]) {
        for i in 0..self.n {
            let mut s = 0.0;
            for k in self.rowptr[i]..self.rowptr[i + 1] {
                s += self.val[k] * x[self.col[k] as usize];
            }
            y[i] = s;
        }
    }

    pub fn diag(&self) -> Vec<f64> {
        let mut d = vec![0.0; self.n];
        for (i, di) in d.iter_mut().enumerate() {
            for k in self.rowptr[i]..self.rowptr[i + 1] {
                if self.col[k] as usize == i {
                    *di = self.val[k];
                }
            }
        }
        d
    }
}

/// Assembles a conductance (graph Laplacian plus diagonal) matrix.
pub struct Laplacian {
    pub n: usize,
    t: Vec<(u32, u32, f64)>,
}

impl Laplacian {
    pub fn new(n: usize) -> Laplacian {
        Laplacian { n, t: Vec::new() }
    }
    /// A conductance g between unknowns i and j.
    pub fn link(&mut self, i: usize, j: usize, g: f64) {
        let (i, j) = (i as u32, j as u32);
        self.t.push((i, i, g));
        self.t.push((j, j, g));
        self.t.push((i, j, -g));
        self.t.push((j, i, -g));
    }
    /// A conductance g from unknown i to a fixed potential (ground,
    /// ambient, a held source).
    pub fn to_fixed(&mut self, i: usize, g: f64) {
        self.t.push((i as u32, i as u32, g));
    }
    pub fn finish(self) -> Csr {
        Csr::from_triplets(self.n, self.t)
    }
}

pub enum Precond {
    Jacobi(Vec<f64>),
    /// Lower factor L (sorted rows, diagonal last in each row).
    Ic(Csr),
    Amg(crate::amg::Amg),
}

/// Above this many unknowns multigrid wins over IC(0).
const AMG_FROM: usize = 3000;

fn ic0(a: &Csr) -> Option<Csr> {
    let n = a.n;
    let mut rowptr = vec![0usize; n + 1];
    let mut col = Vec::new();
    let mut val = Vec::new();
    for i in 0..n {
        for k in a.rowptr[i]..a.rowptr[i + 1] {
            if a.col[k] as usize <= i {
                col.push(a.col[k]);
                val.push(a.val[k]);
            }
        }
        rowptr[i + 1] = col.len();
        if col.last().map(|&c| c as usize) != Some(i) {
            return None; // no diagonal: not a matrix this solver expects
        }
    }
    // Dense scatter of the current row: w[j] = L[i, j].
    let mut w = vec![0.0f64; n];
    for i in 0..n {
        let (s, e) = (rowptr[i], rowptr[i + 1]);
        for p in s..e - 1 {
            let k = col[p] as usize;
            let mut dot = 0.0;
            for q in rowptr[k]..rowptr[k + 1] - 1 {
                dot += val[q] * w[col[q] as usize];
            }
            let lik = (val[p] - dot) / val[rowptr[k + 1] - 1];
            val[p] = lik;
            w[k] = lik;
        }
        let mut d = val[e - 1];
        for p in s..e - 1 {
            d -= val[p] * val[p];
        }
        for p in s..e - 1 {
            w[col[p] as usize] = 0.0;
        }
        if d <= 0.0 || !d.is_finite() {
            return None;
        }
        val[e - 1] = d.sqrt();
    }
    Some(Csr { n, m: n, rowptr, col, val })
}

impl Precond {
    /// The preconditioner suited to `a`.  Build it once and pass it to
    /// [`pcg_with`] when solving several systems with (nearly) the same matrix.
    pub fn for_matrix(a: &Csr) -> Precond {
        if a.n >= AMG_FROM {
            return Precond::Amg(crate::amg::Amg::new(a));
        }
        match ic0(a) {
            Some(l) => Precond::Ic(l),
            None => Precond::Jacobi(a.diag().iter().map(|d| if *d > 0.0 { 1.0 / d } else { 1.0 }).collect()),
        }
    }

    fn apply(&self, r: &[f64], z: &mut [f64]) {
        match self {
            Precond::Amg(m) => m.apply(r, z),
            Precond::Jacobi(inv) => {
                for i in 0..r.len() {
                    z[i] = r[i] * inv[i];
                }
            }
            Precond::Ic(l) => {
                // L y = r
                for i in 0..l.n {
                    let (s, e) = (l.rowptr[i], l.rowptr[i + 1]);
                    let mut v = r[i];
                    for k in s..e - 1 {
                        v -= l.val[k] * z[l.col[k] as usize];
                    }
                    z[i] = v / l.val[e - 1];
                }
                // Lᵀ x = y, column sweep over L's rows
                for i in (0..l.n).rev() {
                    let (s, e) = (l.rowptr[i], l.rowptr[i + 1]);
                    let xi = z[i] / l.val[e - 1];
                    z[i] = xi;
                    for k in s..e - 1 {
                        z[l.col[k] as usize] -= l.val[k] * xi;
                    }
                }
            }
        }
    }
}

#[derive(Clone, Copy, Debug, Default)]
pub struct SolveStats {
    pub iterations: usize,
    pub rel_residual: f64,
    pub converged: bool,
}

/// Solve A x = b by preconditioned CG, starting from the x passed in (a warm
/// start from a previous, similar solve saves most of the iterations).
pub fn pcg(a: &Csr, b: &[f64], x: &mut [f64], tol: f64, max_it: usize) -> SolveStats {
    if a.n == 0 {
        return SolveStats { iterations: 0, rel_residual: 0.0, converged: true };
    }
    let pc = Precond::for_matrix(a);
    pcg_with(a, b, x, tol, max_it, &pc)
}

/// [`pcg`] with a preconditioner built earlier (it only has to approximate
/// A: one built for a previous Newton step still works).
pub fn pcg_with(a: &Csr, b: &[f64], x: &mut [f64], tol: f64, max_it: usize, pc: &Precond) -> SolveStats {
    let n = a.n;
    let bnorm = b.iter().map(|v| v * v).sum::<f64>().sqrt();
    if n == 0 || bnorm == 0.0 {
        x.iter_mut().for_each(|v| *v = 0.0);
        return SolveStats { iterations: 0, rel_residual: 0.0, converged: true };
    }
    let mut r = vec![0.0; n];
    a.mul(x, &mut r);
    for i in 0..n {
        r[i] = b[i] - r[i];
    }
    let mut z = vec![0.0; n];
    pc.apply(&r, &mut z);
    let mut pdir = z.clone();
    let mut rz: f64 = r.iter().zip(&z).map(|(a, b)| a * b).sum();
    let mut ap = vec![0.0; n];
    let mut it = 0;
    let mut rel = r.iter().map(|v| v * v).sum::<f64>().sqrt() / bnorm;
    while rel > tol && it < max_it {
        a.mul(&pdir, &mut ap);
        let pap: f64 = pdir.iter().zip(&ap).map(|(a, b)| a * b).sum();
        if pap <= 0.0 || !pap.is_finite() {
            break;
        }
        let alpha = rz / pap;
        for i in 0..n {
            x[i] += alpha * pdir[i];
            r[i] -= alpha * ap[i];
        }
        it += 1;
        rel = r.iter().map(|v| v * v).sum::<f64>().sqrt() / bnorm;
        if rel <= tol {
            break;
        }
        pc.apply(&r, &mut z);
        let rz_new: f64 = r.iter().zip(&z).map(|(a, b)| a * b).sum();
        let beta = rz_new / rz;
        rz = rz_new;
        for i in 0..n {
            pdir[i] = z[i] + beta * pdir[i];
        }
    }
    SolveStats { iterations: it, rel_residual: rel, converged: rel <= tol }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn solves_a_chain() {
        // 1 V source -> 1 Ω -> node0 -> 1 Ω -> node1 -> 1 Ω -> ground
        let mut l = Laplacian::new(2);
        l.to_fixed(0, 1.0);
        l.link(0, 1, 1.0);
        l.to_fixed(1, 1.0);
        let a = l.finish();
        let b = vec![1.0, 0.0];
        let mut x = vec![0.0; 2];
        let s = pcg(&a, &b, &mut x, 1e-12, 100);
        assert!(s.converged);
        assert!((x[0] - 2.0 / 3.0).abs() < 1e-10 && (x[1] - 1.0 / 3.0).abs() < 1e-10);
    }

    #[test]
    fn multigrid_on_a_big_weakly_anchored_grid() {
        // 300 × 300 diffusion with a weak leak: hundreds of IC(0) iterations,
        // a few dozen with multigrid.
        let m = 300;
        let mut l = Laplacian::new(m * m);
        for j in 0..m {
            for i in 0..m {
                let k = j * m + i;
                if i + 1 < m {
                    l.link(k, k + 1, 1.0);
                }
                if j + 1 < m {
                    l.link(k, k + m, 1.0);
                }
                l.to_fixed(k, 1e-5);
            }
        }
        let a = l.finish();
        let mut b = vec![0.0; m * m];
        b[150 * m + 150] = 1.0;
        let mut x = vec![0.0; m * m];
        let s = pcg(&a, &b, &mut x, 1e-10, 500);
        assert!(s.converged && s.iterations < 60, "{s:?}");
        let mut r = vec![0.0; m * m];
        a.mul(&x, &mut r);
        let res: f64 = r.iter().zip(&b).map(|(p, q)| (p - q).powi(2)).sum::<f64>().sqrt();
        assert!(res < 1e-9);
        // total leak equals the injection
        let leak: f64 = x.iter().map(|v| v * 1e-5).sum();
        assert!((leak - 1.0).abs() < 1e-6, "{leak}");
    }

    #[test]
    fn solves_a_grid_poisson() {
        let m = 60;
        let mut l = Laplacian::new(m * m);
        for j in 0..m {
            for i in 0..m {
                let k = j * m + i;
                if i + 1 < m {
                    l.link(k, k + 1, 1.0);
                }
                if j + 1 < m {
                    l.link(k, k + m, 1.0);
                }
                l.to_fixed(k, 1e-3);
            }
        }
        let a = l.finish();
        let b = vec![1.0; m * m];
        let mut x = vec![0.0; m * m];
        let s = pcg(&a, &b, &mut x, 1e-10, 2000);
        assert!(s.converged, "{s:?}");
        // uniform load, uniform leak: x = 1 / 1e-3 everywhere
        assert!(x.iter().all(|v| (v - 1000.0).abs() < 1e-4));
    }
}
