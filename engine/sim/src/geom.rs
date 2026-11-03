// SPDX-License-Identifier: AGPL-3.0-or-later
//! Plane geometry in millimetres: points, segment distances, polygons, and the
//! "core + radius" shapes every piece of copper is reduced to.
//!
//! A track is a capsule (its centre segment grown by half its width), a via or
//! round pad a disc (a zero-length segment grown by its radius), any other pad
//! its outline polygon.  Distances between shapes are distances between cores
//! minus both radii, so one segment–segment routine does almost all the work.

#[derive(Clone, Copy, Debug, PartialEq, Default)]
pub struct P {
    pub x: f64,
    pub y: f64,
}

pub const fn p(x: f64, y: f64) -> P {
    P { x, y }
}

impl P {
    pub fn from(a: [f64; 2]) -> P {
        P { x: a[0], y: a[1] }
    }
    pub fn arr(self) -> [f64; 2] {
        [self.x, self.y]
    }
    pub fn add(self, o: P) -> P {
        p(self.x + o.x, self.y + o.y)
    }
    pub fn sub(self, o: P) -> P {
        p(self.x - o.x, self.y - o.y)
    }
    pub fn mul(self, k: f64) -> P {
        p(self.x * k, self.y * k)
    }
    pub fn dot(self, o: P) -> f64 {
        self.x * o.x + self.y * o.y
    }
    pub fn cross(self, o: P) -> f64 {
        self.x * o.y - self.y * o.x
    }
    pub fn len(self) -> f64 {
        self.x.hypot(self.y)
    }
    pub fn dist(self, o: P) -> f64 {
        self.sub(o).len()
    }
    pub fn mid(self, o: P) -> P {
        p(0.5 * (self.x + o.x), 0.5 * (self.y + o.y))
    }
    pub fn unit(self) -> P {
        let l = self.len();
        if l > 0.0 {
            self.mul(1.0 / l)
        } else {
            p(0.0, 0.0)
        }
    }
}

/// Axis-aligned box [x0, y0, x1, y1].
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct BBox {
    pub x0: f64,
    pub y0: f64,
    pub x1: f64,
    pub y1: f64,
}

impl BBox {
    pub const EMPTY: BBox = BBox { x0: f64::INFINITY, y0: f64::INFINITY, x1: f64::NEG_INFINITY, y1: f64::NEG_INFINITY };
    pub fn of_points<'a>(pts: impl IntoIterator<Item = &'a P>) -> BBox {
        let mut b = BBox::EMPTY;
        for q in pts {
            b.add(*q);
        }
        b
    }
    pub fn add(&mut self, q: P) {
        self.x0 = self.x0.min(q.x);
        self.y0 = self.y0.min(q.y);
        self.x1 = self.x1.max(q.x);
        self.y1 = self.y1.max(q.y);
    }
    pub fn grow(self, r: f64) -> BBox {
        BBox { x0: self.x0 - r, y0: self.y0 - r, x1: self.x1 + r, y1: self.y1 + r }
    }
    pub fn union(self, o: BBox) -> BBox {
        BBox { x0: self.x0.min(o.x0), y0: self.y0.min(o.y0), x1: self.x1.max(o.x1), y1: self.y1.max(o.y1) }
    }
    pub fn is_empty(&self) -> bool {
        !(self.x0 <= self.x1 && self.y0 <= self.y1)
    }
    pub fn overlaps(&self, o: &BBox) -> bool {
        self.x0 <= o.x1 && o.x0 <= self.x1 && self.y0 <= o.y1 && o.y0 <= self.y1
    }
    pub fn contains(&self, q: P) -> bool {
        q.x >= self.x0 && q.x <= self.x1 && q.y >= self.y0 && q.y <= self.y1
    }
    /// Gap between two boxes (0 when they overlap): a cheap lower bound on the
    /// distance between anything inside them.
    pub fn gap(&self, o: &BBox) -> f64 {
        let dx = (o.x0 - self.x1).max(self.x0 - o.x1).max(0.0);
        let dy = (o.y0 - self.y1).max(self.y0 - o.y1).max(0.0);
        dx.hypot(dy)
    }
    pub fn width(&self) -> f64 {
        self.x1 - self.x0
    }
    pub fn height(&self) -> f64 {
        self.y1 - self.y0
    }
}

/// Closest point on segment ab to q, and its parameter t in [0, 1].
pub fn seg_closest(a: P, b: P, q: P) -> (P, f64) {
    let ab = b.sub(a);
    let l2 = ab.dot(ab);
    if l2 <= 0.0 {
        return (a, 0.0);
    }
    let t = (q.sub(a).dot(ab) / l2).clamp(0.0, 1.0);
    (a.add(ab.mul(t)), t)
}

pub fn seg_point_dist(a: P, b: P, q: P) -> f64 {
    seg_closest(a, b, q).0.dist(q)
}

/// Where segments ab and cd cross, if they do (touching counts).
pub fn seg_intersection(a: P, b: P, c: P, d: P) -> Option<P> {
    let r = b.sub(a);
    let s = d.sub(c);
    let den = r.cross(s);
    if den.abs() < 1e-18 {
        return None; // parallel: the endpoint distances below find any touch
    }
    let t = c.sub(a).cross(s) / den;
    let u = c.sub(a).cross(r) / den;
    if (-1e-12..=1.0 + 1e-12).contains(&t) && (-1e-12..=1.0 + 1e-12).contains(&u) {
        Some(a.add(r.mul(t)))
    } else {
        None
    }
}

/// Distance between segments ab and cd, with the closest point on each.
pub fn seg_seg(a: P, b: P, c: P, d: P) -> (f64, P, P) {
    if let Some(x) = seg_intersection(a, b, c, d) {
        return (0.0, x, x);
    }
    let mut best = (f64::INFINITY, a, c);
    for (q, on_ab) in [(a, false), (b, false), (c, true), (d, true)] {
        let (cp, _) = if on_ab { seg_closest(a, b, q) } else { seg_closest(c, d, q) };
        let dd = cp.dist(q);
        if dd < best.0 {
            best = if on_ab { (dd, cp, q) } else { (dd, q, cp) };
        }
    }
    best
}

/// Even-odd point-in-ring test (ring closed implicitly).
pub fn in_ring(q: P, ring: &[P]) -> bool {
    let n = ring.len();
    if n < 3 {
        return false;
    }
    let mut inside = false;
    let mut j = n - 1;
    for i in 0..n {
        let (a, b) = (ring[i], ring[j]);
        if (a.y > q.y) != (b.y > q.y) {
            let x = a.x + (q.y - a.y) / (b.y - a.y) * (b.x - a.x);
            if q.x < x {
                inside = !inside;
            }
        }
        j = i;
    }
    inside
}

/// Point inside a polygon with holes (ring 0 outer, the rest holes); even-odd
/// over all rings, which is what filled zone data means.
pub fn in_rings(q: P, rings: &[Vec<P>]) -> bool {
    rings.iter().filter(|r| in_ring(q, r)).count() % 2 == 1
}

pub fn ring_area(ring: &[P]) -> f64 {
    let n = ring.len();
    let mut a = 0.0;
    for i in 0..n {
        a += ring[i].cross(ring[(i + 1) % n]);
    }
    0.5 * a
}

pub fn ring_perimeter(ring: &[P]) -> f64 {
    let n = ring.len();
    (0..n).map(|i| ring[i].dist(ring[(i + 1) % n])).sum()
}

/// Edges of a closed ring as (start, end) pairs.
pub fn ring_edges(ring: &[P]) -> impl Iterator<Item = (P, P)> + '_ {
    let n = ring.len();
    (0..n).map(move |i| (ring[i], ring[(i + 1) % n]))
}

/// Angle between two directions in degrees, 0..=180.
pub fn angle_between(u: P, v: P) -> f64 {
    let c = (u.dot(v) / (u.len() * v.len()).max(1e-300)).clamp(-1.0, 1.0);
    c.acos().to_degrees()
}

/// The core of a copper (or silk, or mask) shape; the full shape is the core
/// grown by a radius.
#[derive(Clone, Debug)]
pub enum Core {
    /// A segment; a = b for a disc.
    Seg(P, P),
    /// A filled simple polygon.
    Poly(Vec<P>),
}

#[derive(Clone, Debug)]
pub struct Shape {
    pub core: Core,
    pub r: f64,
    pub bbox: BBox,
}

impl Shape {
    pub fn capsule(a: P, b: P, r: f64) -> Shape {
        Shape { core: Core::Seg(a, b), r, bbox: BBox::of_points(&[a, b]).grow(r) }
    }
    pub fn disc(c: P, r: f64) -> Shape {
        Shape::capsule(c, c, r)
    }
    pub fn poly(pts: Vec<P>) -> Shape {
        let bbox = BBox::of_points(&pts);
        Shape { core: Core::Poly(pts), r: 0.0, bbox }
    }
    pub fn rect(b: BBox) -> Shape {
        Shape::poly(vec![p(b.x0, b.y0), p(b.x1, b.y0), p(b.x1, b.y1), p(b.x0, b.y1)])
    }
    /// Some point of the shape (for containment tests).
    pub fn rep(&self) -> P {
        match &self.core {
            Core::Seg(a, _) => *a,
            Core::Poly(v) => v.first().copied().unwrap_or_default(),
        }
    }
    pub fn contains(&self, q: P) -> bool {
        match &self.core {
            Core::Seg(a, b) => seg_point_dist(*a, *b, q) <= self.r,
            Core::Poly(v) => in_ring(q, v) || (self.r > 0.0 && poly_point_dist(v, q) <= self.r),
        }
    }
    /// Distance from q to the shape (0 inside).
    pub fn point_dist(&self, q: P) -> f64 {
        match &self.core {
            Core::Seg(a, b) => (seg_point_dist(*a, *b, q) - self.r).max(0.0),
            Core::Poly(v) => {
                if in_ring(q, v) {
                    0.0
                } else {
                    (poly_point_dist(v, q) - self.r).max(0.0)
                }
            }
        }
    }
}

fn poly_point_dist(v: &[P], q: P) -> f64 {
    ring_edges(v).map(|(a, b)| seg_point_dist(a, b, q)).fold(f64::INFINITY, f64::min)
}

/// Distance from a polygon's boundary to a segment, with closest points,
/// skipping edges that cannot beat `best` (bbox pruning keeps many-vertex
/// round pads cheap).
fn poly_seg(v: &[P], a: P, b: P, mut best: (f64, P, P)) -> (f64, P, P) {
    let sb = BBox::of_points(&[a, b]);
    for (c, d) in ring_edges(v) {
        if BBox::of_points(&[c, d]).gap(&sb) >= best.0 {
            continue;
        }
        let (dd, pc, ps) = seg_seg(c, d, a, b);
        if dd < best.0 {
            best = (dd, pc, ps);
        }
    }
    best
}

/// Core-to-core distance (0 when the cores overlap) with the closest points on
/// a and b.  For polygons, "overlap" includes one lying inside the other.
pub fn core_dist(a: &Core, b: &Core) -> (f64, P, P) {
    let far = (f64::INFINITY, P::default(), P::default());
    match (a, b) {
        (Core::Seg(a0, a1), Core::Seg(b0, b1)) => seg_seg(*a0, *a1, *b0, *b1),
        (Core::Poly(v), Core::Seg(s0, s1)) => {
            if in_ring(*s0, v) {
                return (0.0, *s0, *s0);
            }
            poly_seg(v, *s0, *s1, far)
        }
        (Core::Seg(..), Core::Poly(_)) => {
            let (d, pb, pa) = core_dist(b, a);
            (d, pa, pb)
        }
        (Core::Poly(u), Core::Poly(v)) => {
            if let Some(&q) = u.first() {
                if in_ring(q, v) {
                    return (0.0, q, q);
                }
            }
            if let Some(&q) = v.first() {
                if in_ring(q, u) {
                    return (0.0, q, q);
                }
            }
            let mut best = far;
            let vb = BBox::of_points(v);
            for (c, d) in ring_edges(u) {
                if BBox::of_points(&[c, d]).gap(&vb) >= best.0 {
                    continue;
                }
                let (dd, pv, pu) = poly_seg(v, c, d, best);
                if dd < best.0 {
                    best = (dd, pu, pv);
                }
            }
            best
        }
    }
}

/// Gap between two shapes: negative or zero when they overlap.  `at` is the
/// middle of the gap (or the contact point), which is what a reviewer wants
/// pointed at.
pub fn shape_gap(a: &Shape, b: &Shape) -> (f64, P) {
    let (d, pa, pb) = core_dist(&a.core, &b.core);
    let gap = d - a.r - b.r;
    if d <= 1e-12 {
        return (gap, pa);
    }
    let n = pb.sub(pa).mul(1.0 / d);
    let sa = pa.add(n.mul(a.r));
    let sb = pb.sub(n.mul(b.r));
    (gap, sa.mid(sb))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn segment_distances() {
        let (d, _, _) = seg_seg(p(0.0, 0.0), p(10.0, 0.0), p(0.0, 1.0), p(10.0, 1.0));
        assert!((d - 1.0).abs() < 1e-12);
        let (d, x, _) = seg_seg(p(0.0, 0.0), p(2.0, 2.0), p(0.0, 2.0), p(2.0, 0.0));
        assert!(d == 0.0 && (x.x - 1.0).abs() < 1e-12);
        let (d, _, _) = seg_seg(p(0.0, 0.0), p(1.0, 0.0), p(3.0, 4.0), p(3.0, 4.0));
        assert!((d - (8.0f64).hypot(4.0).min(2.0f64.hypot(4.0))).abs() < 1e-9);
    }

    #[test]
    fn polygon_tests() {
        let sq = vec![p(0.0, 0.0), p(2.0, 0.0), p(2.0, 2.0), p(0.0, 2.0)];
        assert!(in_ring(p(1.0, 1.0), &sq));
        assert!(!in_ring(p(3.0, 1.0), &sq));
        let hole = vec![p(0.5, 0.5), p(1.5, 0.5), p(1.5, 1.5), p(0.5, 1.5)];
        assert!(!in_rings(p(1.0, 1.0), &[sq.clone(), hole.clone()]));
        assert!(in_rings(p(0.2, 1.0), &[sq.clone(), hole]));
        assert!((ring_area(&sq) - 4.0).abs() < 1e-12);
        let (g, _) = shape_gap(&Shape::poly(sq.clone()), &Shape::disc(p(4.0, 1.0), 0.5));
        assert!((g - 1.5).abs() < 1e-12);
        let (g, _) = shape_gap(&Shape::poly(sq), &Shape::disc(p(1.0, 1.0), 0.1));
        assert!(g < 0.0);
    }
}
