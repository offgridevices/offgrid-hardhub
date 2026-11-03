// SPDX-License-Identifier: AGPL-3.0-or-later
//! Uniform-grid spatial hash.  Board copper is spread fairly evenly and the
//! questions are all "what is within r of this", so a flat grid beats a tree:
//! build is one counting sort, a query touches a handful of cells.

use crate::geom::{seg_point_dist, BBox, Core, Shape};

pub struct Grid {
    x0: f64,
    y0: f64,
    cell: f64,
    nx: usize,
    ny: usize,
    start: Vec<u32>,
    items: Vec<u32>,
}

impl Grid {
    /// Index `shapes` (item id = position) over `area` with roughly `cell` mm
    /// cells.  The cell grows if the area would need more than ~4M cells.
    pub fn build<'a>(area: BBox, cell: f64, shapes: impl Iterator<Item = &'a Shape>) -> Grid {
        let area = if area.is_empty() { BBox { x0: 0.0, y0: 0.0, x1: 1.0, y1: 1.0 } } else { area };
        let mut cell = cell.max(1e-3);
        while ((area.width() / cell).ceil() + 1.0) * ((area.height() / cell).ceil() + 1.0) > 4e6 {
            cell *= 1.5;
        }
        let nx = (area.width() / cell).ceil() as usize + 1;
        let ny = (area.height() / cell).ceil() as usize + 1;
        let mut g = Grid { x0: area.x0, y0: area.y0, cell, nx, ny, start: vec![], items: vec![] };
        let mut pairs: Vec<(u32, u32)> = Vec::new();
        let half_diag = cell * std::f64::consts::FRAC_1_SQRT_2;
        for (id, s) in shapes.enumerate() {
            let (i0, j0, i1, j1) = g.cell_range(s.bbox);
            for j in j0..=j1 {
                for i in i0..=i1 {
                    // A long diagonal track only goes in the cells it passes
                    // through, not its whole bounding box.
                    if let Core::Seg(a, b) = &s.core {
                        if i1 > i0 + 1 || j1 > j0 + 1 {
                            let c = crate::geom::p(g.x0 + (i as f64 + 0.5) * cell, g.y0 + (j as f64 + 0.5) * cell);
                            if seg_point_dist(*a, *b, c) > s.r + half_diag {
                                continue;
                            }
                        }
                    }
                    pairs.push(((j * nx + i) as u32, id as u32));
                }
            }
        }
        let mut count = vec![0u32; nx * ny + 1];
        for &(c, _) in &pairs {
            count[c as usize + 1] += 1;
        }
        for k in 1..count.len() {
            count[k] += count[k - 1];
        }
        let mut fill = count.clone();
        let mut items = vec![0u32; pairs.len()];
        for &(c, id) in &pairs {
            items[fill[c as usize] as usize] = id;
            fill[c as usize] += 1;
        }
        g.start = count;
        g.items = items;
        g
    }

    fn cell_range(&self, b: BBox) -> (usize, usize, usize, usize) {
        let cl = |v: f64, n: usize| (v.floor().max(0.0) as usize).min(n - 1);
        (
            cl((b.x0 - self.x0) / self.cell, self.nx),
            cl((b.y0 - self.y0) / self.cell, self.ny),
            cl((b.x1 - self.x0) / self.cell, self.nx),
            cl((b.y1 - self.y0) / self.cell, self.ny),
        )
    }

    /// Every item whose cells meet `b`.  Items can come back more than once;
    /// pair with [`Seen`] to dedupe.
    pub fn query(&self, b: BBox, mut f: impl FnMut(u32)) {
        if self.items.is_empty() {
            return;
        }
        let (i0, j0, i1, j1) = self.cell_range(b);
        for j in j0..=j1 {
            for i in i0..=i1 {
                let c = j * self.nx + i;
                for &id in &self.items[self.start[c] as usize..self.start[c + 1] as usize] {
                    f(id);
                }
            }
        }
    }
}

/// Stamp-based dedupe for grid queries: O(1) per hit, no clearing.
pub struct Seen {
    stamp: Vec<u32>,
    cur: u32,
}

impl Seen {
    pub fn new(n: usize) -> Seen {
        Seen { stamp: vec![0; n], cur: 1 }
    }
    pub fn next(&mut self) {
        self.cur += 1;
    }
    /// True the first time `id` is seen since the last `next()`.
    pub fn first(&mut self, id: u32) -> bool {
        let s = &mut self.stamp[id as usize];
        if *s == self.cur {
            false
        } else {
            *s = self.cur;
            true
        }
    }
}
