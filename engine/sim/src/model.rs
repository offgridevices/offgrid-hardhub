// SPDX-License-Identifier: AGPL-3.0-or-later
//! The common board model every command reads (spec section 6), plus the
//! helpers that turn its records into shapes on copper layers.
//!
//! Everything is optional with sensible defaults, so the Python side can send
//! only what a command needs and old payloads keep working.

use crate::geom::{BBox, Shape, P};
use serde::Deserialize;

pub type Pt = [f64; 2];

#[derive(Deserialize, Default, Debug, Clone)]
#[serde(default)]
pub struct Board {
    pub outline: Vec<Pt>,
    pub cutouts: Vec<Vec<Pt>>,
    pub layers: Vec<String>,
    pub copper_mm: Vec<f64>,
    pub dielectric_mm: Vec<f64>,
    pub tracks: Vec<Track>,
    pub vias: Vec<Via>,
    pub pads: Vec<Pad>,
    pub zones: Vec<Zone>,
    pub holes: Vec<Hole>,
    pub silk: Vec<Silk>,
    pub mask_openings: Vec<MaskOpening>,
    pub parts: Vec<Part>,
}

#[derive(Deserialize, Default, Debug, Clone)]
#[serde(default)]
pub struct Track {
    pub layer: String,
    pub net: String,
    pub w: f64,
    pub a: Pt,
    pub b: Pt,
}

#[derive(Deserialize, Default, Debug, Clone)]
#[serde(default)]
pub struct Via {
    pub x: f64,
    pub y: f64,
    pub d: f64,
    pub drill: f64,
    pub net: String,
    pub from: String,
    pub to: String,
}

#[derive(Deserialize, Default, Debug, Clone)]
#[serde(default)]
pub struct Pad {
    #[serde(rename = "ref")]
    pub reference: String,
    pub num: String,
    pub net: String,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    pub rot: f64,
    pub shape: String,
    pub layers: Vec<String>,
    pub drill: f64,
    pub plated: Option<bool>,
    pub poly: Vec<Pt>,
}

#[derive(Deserialize, Default, Debug, Clone)]
#[serde(default)]
pub struct Zone {
    pub layer: String,
    pub net: String,
    /// Each polygon is a list of rings: ring 0 outer, the rest holes.
    pub polygons: Vec<Vec<Vec<Pt>>>,
}

#[derive(Deserialize, Default, Debug, Clone)]
#[serde(default)]
pub struct Hole {
    pub x: f64,
    pub y: f64,
    pub d: f64,
    pub plated: bool,
}

#[derive(Deserialize, Default, Debug, Clone)]
#[serde(default)]
pub struct Silk {
    pub layer: String,
    pub kind: String,
    pub w: f64,
    pub height: f64,
    pub text: String,
    pub a: Option<Pt>,
    pub b: Option<Pt>,
    pub bbox: Option<[f64; 4]>,
}

#[derive(Deserialize, Default, Debug, Clone)]
#[serde(default)]
pub struct MaskOpening {
    pub layer: String,
    pub poly: Vec<Pt>,
    #[serde(rename = "ref")]
    pub reference: String,
    pub num: String,
}

#[derive(Deserialize, Default, Debug, Clone)]
#[serde(default)]
pub struct Part {
    #[serde(rename = "ref")]
    pub reference: String,
    pub x: f64,
    pub y: f64,
    pub side: String,
    pub bbox: Option<[f64; 4]>,
    pub courtyard: Vec<Pt>,
}

pub fn pts(v: &[Pt]) -> Vec<P> {
    v.iter().map(|&a| P::from(a)).collect()
}

/// Drop a repeated closing vertex: the model says first != last, but a
/// duplicate costs nothing to tolerate.
pub fn ring(v: &[Pt]) -> Vec<P> {
    let mut r = pts(v);
    if r.len() > 1 && r[0].dist(r[r.len() - 1]) < 1e-9 {
        r.pop();
    }
    r
}

pub const DEFAULT_CU_MM: f64 = 0.035;

impl Board {
    pub fn layer_index(&self, name: &str) -> Option<usize> {
        self.layers.iter().position(|l| l == name)
    }

    pub fn n_layers(&self) -> usize {
        self.layers.len()
    }

    pub fn copper_t(&self, li: usize) -> f64 {
        self.copper_mm.get(li).copied().filter(|t| *t > 0.0).unwrap_or(DEFAULT_CU_MM)
    }

    /// Thickness of the dielectric between copper layers li and li+1.
    pub fn dielectric_t(&self, li: usize) -> f64 {
        if let Some(t) = self.dielectric_mm.get(li).copied().filter(|t| *t > 0.0) {
            return t;
        }
        // Not given: share a 1.6 mm board evenly.
        1.6 / (self.n_layers().max(2) - 1) as f64
    }

    pub fn total_dielectric(&self) -> f64 {
        (0..self.n_layers().saturating_sub(1)).map(|i| self.dielectric_t(i)).sum::<f64>().max(0.1)
    }

    /// Copper layers a pad is on.  Accepts KiCad's wildcards too ("*.Cu",
    /// "F&B.Cu") in case a caller passes the raw layer set.
    pub fn pad_layers(&self, pad: &Pad) -> Vec<usize> {
        let n = self.n_layers();
        let mut out = Vec::new();
        for l in &pad.layers {
            if l == "*.Cu" {
                return (0..n).collect();
            }
            if l == "F&B.Cu" {
                if n > 0 {
                    out.push(0);
                    out.push(n - 1);
                }
                continue;
            }
            if let Some(i) = self.layer_index(l) {
                out.push(i);
            }
        }
        out.sort_unstable();
        out.dedup();
        out
    }

    /// Copper layers a via spans, inclusive (blind/buried vias use from/to).
    pub fn via_layers(&self, v: &Via) -> Vec<usize> {
        let n = self.n_layers();
        if n == 0 {
            return vec![];
        }
        let a = self.layer_index(&v.from).unwrap_or(0);
        let b = self.layer_index(&v.to).unwrap_or(n - 1);
        let (a, b) = if a <= b { (a, b) } else { (b, a) };
        (a..=b).collect()
    }

    /// The board outline with its cutouts, as rings for even-odd tests.
    pub fn board_rings(&self) -> Vec<Vec<P>> {
        let mut rings = vec![ring(&self.outline)];
        for c in &self.cutouts {
            rings.push(ring(c));
        }
        rings.retain(|r| r.len() >= 3);
        rings
    }

    pub fn outline_bbox(&self) -> BBox {
        let b = BBox::of_points(&pts(&self.outline));
        if b.is_empty() {
            BBox { x0: -1.0, y0: -1.0, x1: 1.0, y1: 1.0 }
        } else {
            b
        }
    }
}

impl Track {
    pub fn shape(&self) -> Shape {
        Shape::capsule(P::from(self.a), P::from(self.b), 0.5 * self.w.max(0.0))
    }
}

impl Via {
    pub fn c(&self) -> P {
        P { x: self.x, y: self.y }
    }
    pub fn shape(&self) -> Shape {
        Shape::disc(self.c(), 0.5 * self.d.max(self.drill).max(0.0))
    }
}

impl Pad {
    pub fn c(&self) -> P {
        P { x: self.x, y: self.y }
    }
    pub fn is_round(&self) -> bool {
        self.shape == "circle" || (self.shape == "oval" && (self.w - self.h).abs() < 1e-9)
    }
    /// Pad copper as a shape.  Circles and ovals become exact discs and
    /// capsules (their polygon outlines carry dozens of arc vertices that only
    /// slow the distance math down); everything else uses the outline polygon.
    /// The oval's axis comes from its outline rather than `rot`, so no
    /// rotation convention has to be guessed.
    pub fn shape(&self) -> Shape {
        let c = self.c();
        if self.is_round() && self.w > 0.0 {
            return Shape::disc(c, 0.5 * self.w);
        }
        let poly = ring(&self.poly);
        if self.shape == "oval" && self.w > 0.0 && self.h > 0.0 && poly.len() >= 3 {
            let r = 0.5 * self.w.min(self.h);
            let half = 0.5 * self.w.max(self.h) - r;
            let far = poly.iter().copied().max_by(|a, b| a.dist(c).total_cmp(&b.dist(c))).unwrap_or(c);
            let dir = far.sub(c).unit();
            return Shape::capsule(c.sub(dir.mul(half)), c.add(dir.mul(half)), r);
        }
        if poly.len() >= 3 {
            return Shape::poly(poly);
        }
        // No outline given: fall back to an axis-aligned rectangle.
        let (hw, hh) = (0.5 * self.w, 0.5 * self.h);
        Shape::rect(BBox { x0: c.x - hw, y0: c.y - hh, x1: c.x + hw, y1: c.y + hh })
    }
    pub fn plated(&self) -> bool {
        self.plated.unwrap_or(!self.layers.is_empty())
    }
}

impl Part {
    /// The courtyard polygon, or the bbox when the footprint has none.
    pub fn outline(&self) -> Vec<P> {
        let c = ring(&self.courtyard);
        if c.len() >= 3 {
            return c;
        }
        match self.bbox {
            Some([x0, y0, x1, y1]) => vec![P { x: x0, y: y0 }, P { x: x1, y: y0 }, P { x: x1, y: y1 }, P { x: x0, y: y1 }],
            None => vec![],
        }
    }
}
