// SPDX-License-Identifier: AGPL-3.0-or-later
//! Uniform cell rasters: which cells of a grid have their centre inside a
//! shape.  Copper coverage, the thermal grid, irdrop's zone cells and the
//! measure command's point-in-zone acceleration all sit on this.
//!
//! Filling is by scanline spans (never per-cell point tests), so a zone with
//! 100k vertices over a million cells costs one pass over its edges plus the
//! spans, not vertices × cells.

use crate::geom::{p, BBox, Core, Shape, P};

#[derive(Clone, Debug)]
pub struct Raster {
    pub x0: f64,
    pub y0: f64,
    pub d: f64,
    pub nx: usize,
    pub ny: usize,
    pub v: Vec<u8>,
}

impl Raster {
    /// A grid of cell size d whose cells cover `b` (the last row/column may
    /// stick out past it).
    pub fn covering(b: BBox, d: f64) -> Raster {
        let nx = (((b.x1 - b.x0) / d) - 1e-9).ceil().max(1.0) as usize;
        let ny = (((b.y1 - b.y0) / d) - 1e-9).ceil().max(1.0) as usize;
        Raster { x0: b.x0, y0: b.y0, d, nx, ny, v: vec![0; nx * ny] }
    }

    pub fn same_grid(&self) -> Raster {
        Raster { v: vec![0; self.nx * self.ny], ..*self }
    }

    #[inline]
    pub fn idx(&self, i: usize, j: usize) -> usize {
        j * self.nx + i
    }

    #[inline]
    pub fn centre(&self, i: usize, j: usize) -> P {
        p(self.x0 + (i as f64 + 0.5) * self.d, self.y0 + (j as f64 + 0.5) * self.d)
    }

    /// The cell containing q, if q is on the grid.
    pub fn cell_of(&self, q: P) -> Option<(usize, usize)> {
        let fi = ((q.x - self.x0) / self.d).floor();
        let fj = ((q.y - self.y0) / self.d).floor();
        if fi < 0.0 || fj < 0.0 || fi >= self.nx as f64 || fj >= self.ny as f64 {
            return None;
        }
        Some((fi as usize, fj as usize))
    }

    pub fn get(&self, q: P) -> u8 {
        self.cell_of(q).map(|(i, j)| self.v[self.idx(i, j)]).unwrap_or(0)
    }

    /// Range of cell indices along one axis whose centres lie in [a, b].
    fn centre_range(&self, a: f64, b: f64, origin: f64, n: usize) -> Option<(usize, usize)> {
        let lo = ((a - origin) / self.d - 0.5).ceil().max(0.0);
        let hi = ((b - origin) / self.d - 0.5).floor().min(n as f64 - 1.0);
        if hi < lo {
            None
        } else {
            Some((lo as usize, hi as usize))
        }
    }

    /// Calls f(j, i0, i1) for each run of cells (inclusive) whose centre is
    /// inside the rings (even-odd over all of them: holes cut out).
    pub fn rings_spans(&self, rings: &[Vec<P>], mut f: impl FnMut(usize, usize, usize)) {
        let mut xs: Vec<(u32, f64)> = Vec::new();
        for ring in rings {
            let n = ring.len();
            if n < 3 {
                continue;
            }
            for k in 0..n {
                let (a, b) = (ring[k], ring[(k + 1) % n]);
                if a.y == b.y {
                    continue;
                }
                let (lo, hi) = if a.y < b.y { (a, b) } else { (b, a) };
                // Half-open in y so a vertex shared by two edges counts once.
                let j0 = ((lo.y - self.y0) / self.d - 0.5).ceil().max(0.0);
                let j1 = ((hi.y - self.y0) / self.d - 0.5).ceil().min(self.ny as f64);
                let (j0, j1) = (j0 as usize, j1 as usize);
                for j in j0..j1 {
                    let y = self.y0 + (j as f64 + 0.5) * self.d;
                    let x = lo.x + (y - lo.y) / (hi.y - lo.y) * (hi.x - lo.x);
                    xs.push((j as u32, x));
                }
            }
        }
        xs.sort_unstable_by(|a, b| a.0.cmp(&b.0).then(a.1.total_cmp(&b.1)));
        let mut k = 0;
        while k + 1 < xs.len() {
            if xs[k].0 != xs[k + 1].0 {
                k += 1;
                continue;
            }
            let j = xs[k].0 as usize;
            // cells with centre x in [xa, xb)
            let lo = ((xs[k].1 - self.x0) / self.d - 0.5).ceil().max(0.0);
            let hi = ((xs[k + 1].1 - self.x0) / self.d - 0.5).ceil().min(self.nx as f64) - 1.0;
            if hi >= lo {
                f(j, lo as usize, hi as usize);
            }
            k += 2;
        }
    }

    /// Spans of a shape (capsule, disc or polygon).
    pub fn shape_spans(&self, s: &Shape, mut f: impl FnMut(usize, usize, usize)) {
        match &s.core {
            Core::Poly(v) if s.r <= 0.0 => self.rings_spans(std::slice::from_ref(v), f),
            Core::Poly(v) => {
                // Grown polygons only come from callers that want a rough
                // footprint; its bbox is close enough there.
                let _ = v;
                self.rect_spans(s.bbox, f)
            }
            Core::Seg(a, b) => {
                let Some((j0, j1)) = self.centre_range(s.bbox.y0, s.bbox.y1, self.y0, self.ny) else { return };
                for j in j0..=j1 {
                    let y = self.y0 + (j as f64 + 0.5) * self.d;
                    if let Some((xl, xr)) = capsule_slice(*a, *b, s.r, y) {
                        if let Some((i0, i1)) = self.centre_range(xl, xr, self.x0, self.nx) {
                            f(j, i0, i1);
                        }
                    }
                }
            }
        }
    }

    pub fn rect_spans(&self, b: BBox, mut f: impl FnMut(usize, usize, usize)) {
        let Some((j0, j1)) = self.centre_range(b.y0, b.y1, self.y0, self.ny) else { return };
        let Some((i0, i1)) = self.centre_range(b.x0, b.x1, self.x0, self.nx) else { return };
        for j in j0..=j1 {
            f(j, i0, i1);
        }
    }

    pub fn fill_rings(&mut self, rings: &[Vec<P>], val: u8) {
        let nx = self.nx;
        let mut spans = Vec::new();
        self.rings_spans(rings, |j, i0, i1| spans.push((j, i0, i1)));
        for (j, i0, i1) in spans {
            self.v[j * nx + i0..=j * nx + i1].fill(val);
        }
    }

    pub fn fill_shape(&mut self, s: &Shape, val: u8) {
        let nx = self.nx;
        let mut spans = Vec::new();
        self.shape_spans(s, |j, i0, i1| spans.push((j, i0, i1)));
        for (j, i0, i1) in spans {
            self.v[j * nx + i0..=j * nx + i1].fill(val);
        }
    }

    pub fn count_nonzero(&self) -> usize {
        self.v.iter().filter(|&&x| x != 0).count()
    }
}

/// The x-interval where a horizontal line at y cuts a capsule (segment ab
/// grown by r).  The capsule is convex, so its slice is one interval: the hull
/// of the slices of its two end discs and its middle rectangle.
fn capsule_slice(a: P, b: P, r: f64, y: f64) -> Option<(f64, f64)> {
    let mut lo = f64::INFINITY;
    let mut hi = f64::NEG_INFINITY;
    for c in [a, b] {
        let dy = y - c.y;
        if dy.abs() <= r {
            let h = (r * r - dy * dy).sqrt();
            lo = lo.min(c.x - h);
            hi = hi.max(c.x + h);
        }
    }
    let dir = b.sub(a);
    if dir.len() > 0.0 {
        let n = p(-dir.y, dir.x).unit().mul(r);
        let quad = [a.add(n), b.add(n), b.sub(n), a.sub(n)];
        for k in 0..4 {
            let (u, v) = (quad[k], quad[(k + 1) % 4]);
            if (u.y <= y && v.y >= y) || (v.y <= y && u.y >= y) {
                if (v.y - u.y).abs() < 1e-15 {
                    lo = lo.min(u.x.min(v.x));
                    hi = hi.max(u.x.max(v.x));
                } else {
                    let x = u.x + (y - u.y) / (v.y - u.y) * (v.x - u.x);
                    lo = lo.min(x);
                    hi = hi.max(x);
                }
            }
        }
    }
    if hi >= lo {
        Some((lo, hi))
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fills_match_areas() {
        let mut r = Raster::covering(BBox { x0: 0.0, y0: 0.0, x1: 10.0, y1: 10.0 }, 0.05);
        let outer = vec![p(1.0, 1.0), p(9.0, 1.0), p(9.0, 9.0), p(1.0, 9.0)];
        let hole = vec![p(3.0, 3.0), p(5.0, 3.0), p(5.0, 5.0), p(3.0, 5.0)];
        r.fill_rings(&[outer, hole], 1);
        let area = r.count_nonzero() as f64 * 0.05 * 0.05;
        assert!((area - 60.0).abs() < 0.2, "{area}");
        let mut c = r.same_grid();
        c.fill_shape(&Shape::capsule(p(2.0, 2.0), p(8.0, 7.0), 0.5), 1);
        let area = c.count_nonzero() as f64 * 0.0025;
        let want = (6.0f64).hypot(5.0) * 1.0 + std::f64::consts::PI * 0.25;
        assert!((area - want).abs() / want < 0.02, "{area} vs {want}");
    }
}
