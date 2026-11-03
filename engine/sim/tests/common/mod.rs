// SPDX-License-Identifier: AGPL-3.0-or-later
//! Small board builders shared by the integration tests.
#![allow(dead_code)]

use serde_json::{json, Value};

pub fn rect(x0: f64, y0: f64, x1: f64, y1: f64) -> Value {
    json!([[x0, y0], [x1, y0], [x1, y1], [x0, y1]])
}

/// An empty board w × h mm centred on the origin with `layers` copper layers.
pub fn board(w: f64, h: f64, layers: usize) -> Value {
    let names: Vec<String> = match layers {
        1 => vec!["F.Cu".into()],
        2 => vec!["F.Cu".into(), "B.Cu".into()],
        n => {
            let mut v = vec!["F.Cu".to_string()];
            for i in 1..n - 1 {
                v.push(format!("In{i}.Cu"));
            }
            v.push("B.Cu".into());
            v
        }
    };
    let cu: Vec<f64> = (0..layers).map(|i| if i == 0 || i == layers - 1 { 0.035 } else { 0.0152 }).collect();
    let diel: Vec<f64> = (0..layers.saturating_sub(1)).map(|_| 1.5 / (layers.max(2) - 1) as f64).collect();
    json!({
        "outline": rect(-w / 2.0, -h / 2.0, w / 2.0, h / 2.0),
        "layers": names, "copper_mm": cu, "dielectric_mm": diel,
        "tracks": [], "vias": [], "pads": [], "zones": [], "holes": [], "silk": [], "mask_openings": [], "parts": []
    })
}

pub fn track(b: &mut Value, layer: &str, net: &str, w: f64, a: [f64; 2], bb: [f64; 2]) {
    b["tracks"].as_array_mut().unwrap().push(json!({"layer": layer, "net": net, "w": w, "a": a, "b": bb}));
}

pub fn via(b: &mut Value, net: &str, x: f64, y: f64, d: f64, drill: f64) {
    b["vias"].as_array_mut().unwrap().push(json!({"x": x, "y": y, "d": d, "drill": drill, "net": net, "from": "F.Cu", "to": "B.Cu"}));
}

/// A rectangular SMD pad (centre, size) on one layer.
pub fn pad(b: &mut Value, r: &str, num: &str, net: &str, layer: &str, c: [f64; 2], w: f64, h: f64) {
    let poly = rect(c[0] - w / 2.0, c[1] - h / 2.0, c[0] + w / 2.0, c[1] + h / 2.0);
    b["pads"].as_array_mut().unwrap().push(json!({
        "ref": r, "num": num, "net": net, "x": c[0], "y": c[1], "w": w, "h": h, "rot": 0,
        "shape": "rect", "layers": [layer], "drill": 0.0, "plated": true, "poly": poly}));
}

pub fn zone(b: &mut Value, layer: &str, net: &str, rings: Value) {
    b["zones"].as_array_mut().unwrap().push(json!({"layer": layer, "net": net, "polygons": [rings]}));
}

pub fn run(cmd: &str, v: Value) -> Value {
    hardhub_sim::dispatch(cmd, v).unwrap_or_else(|e| panic!("{cmd} failed: {e}"))
}

pub fn f(v: &Value) -> f64 {
    v.as_f64().unwrap_or_else(|| panic!("not a number: {v}"))
}

/// A busy synthetic board for timings: 4 layers, ground pours on the inner
/// layers with clearance holes, `n_tracks` short tracks in a routing pattern,
/// vias and pads.  Returns the board model.
pub fn synthetic(w: f64, h: f64, n_tracks: usize) -> Value {
    let mut b = board(w, h, 4);
    let nets = ["SDA", "SCL", "+3V3", "GND", "MISO", "MOSI", "SCK", "CS", "TX", "RX"];
    let cols = ((n_tracks as f64).sqrt() * w / h).sqrt().ceil().max(1.0) as usize * 4;
    let pitch_x = (w - 10.0) / cols as f64;
    let rows = n_tracks.div_ceil(cols);
    let pitch_y = (h - 10.0) / rows as f64;
    let mut k = 0;
    'outer: for r in 0..rows {
        for c in 0..cols {
            if k >= n_tracks {
                break 'outer;
            }
            let x = -w / 2.0 + 5.0 + c as f64 * pitch_x;
            let y = -h / 2.0 + 5.0 + r as f64 * pitch_y;
            let layer = if k % 2 == 0 { "F.Cu" } else { "B.Cu" };
            let net = nets[(r * 7 + c) % nets.len()];
            // an L: horizontal then 45° segment
            let a = [x, y];
            let m = [x + pitch_x * 0.5, y];
            let e = [x + pitch_x * 0.8, y + pitch_y * 0.3];
            track(&mut b, layer, net, 0.2, a, m);
            track(&mut b, layer, net, 0.2, m, e);
            if k % 5 == 0 || net == "GND" {
                via(&mut b, net, e[0], e[1], 0.6, 0.3);
            }
            if k % 3 == 0 {
                pad(&mut b, &format!("R{k}"), "1", net, layer, a, 0.6, 0.5);
            }
            k += 2;
        }
    }
    // inner ground planes with a clearance hole per via (many ring vertices)
    let mut rings = vec![rect(-w / 2.0 + 0.3, -h / 2.0 + 0.3, w / 2.0 - 0.3, h / 2.0 - 0.3)];
    for v in b["vias"].as_array().unwrap().clone() {
        if v["net"] == "GND" {
            continue;
        }
        let (cx, cy) = (f(&v["x"]), f(&v["y"]));
        let ring: Vec<Value> = (0..24)
            .map(|i| {
                let t = i as f64 / 24.0 * std::f64::consts::TAU;
                json!([cx + 0.6 * t.cos(), cy - 0.6 * t.sin()])
            })
            .collect();
        rings.push(Value::Array(ring));
    }
    zone(&mut b, "In1.Cu", "GND", Value::Array(rings.clone()));
    zone(&mut b, "In2.Cu", "GND", Value::Array(rings));
    b
}
