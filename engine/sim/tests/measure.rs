// SPDX-License-Identifier: AGPL-3.0-or-later
//! Geometry measurements on small hand-built boards.

mod common;
use common::*;
use serde_json::{json, Value};

fn measure(b: Value) -> Value {
    run("measure", json!({"board": b}))
}

fn close(v: &Value, want: f64, tol: f64) -> bool {
    (f(v) - want).abs() <= tol
}

#[test]
fn two_tracks_two_tenths_apart() {
    let mut b = board(30.0, 20.0, 2);
    // centre lines 0.45 apart, widths 0.25: edges 0.2 apart
    track(&mut b, "F.Cu", "A", 0.25, [-5.0, 0.0], [5.0, 0.0]);
    track(&mut b, "F.Cu", "B", 0.25, [-5.0, 0.45], [5.0, 0.45]);
    let out = measure(b);
    let c = &out["clearance_min"];
    assert!(close(&c["value"], 0.2, 1e-9), "{c}");
    assert_eq!(c["layer"], "F.Cu");
    assert!(close(&c["at"][1], 0.225, 1e-6));
    assert_eq!(out["shorts"], json!([]));
    assert_eq!(out["clearance_violations"], json!([]));
    assert!(close(&out["track_min"]["value"], 0.25, 1e-12));
}

#[test]
fn violation_reported_below_limit_and_layers_kept_apart() {
    let mut b = board(30.0, 20.0, 2);
    track(&mut b, "F.Cu", "A", 0.2, [-5.0, 0.0], [5.0, 0.0]);
    track(&mut b, "F.Cu", "B", 0.2, [-5.0, 0.3], [5.0, 0.3]); // 0.1 gap
    track(&mut b, "B.Cu", "C", 0.2, [-5.0, 0.0], [5.0, 0.0]); // under A: other layer
    let out = run("measure", json!({"board": b, "limits": {"clear": 0.127}}));
    let v = out["clearance_violations"].as_array().unwrap();
    assert_eq!(v.len(), 1);
    assert!(close(&v[0]["value"], 0.1, 1e-9));
    assert_eq!(out["shorts"], json!([]));
}

#[test]
fn same_net_touching_is_not_a_clearance() {
    let mut b = board(30.0, 20.0, 2);
    track(&mut b, "F.Cu", "GND", 0.25, [-5.0, 0.0], [5.0, 0.0]);
    track(&mut b, "F.Cu", "GND", 0.25, [0.0, -5.0], [0.0, 5.0]); // crossing
    pad(&mut b, "R1", "2", "GND", "F.Cu", [5.0, 0.0], 1.0, 1.0);
    // a GND pour right up against (and around) a GND pad
    zone(&mut b, "B.Cu", "GND", json!([rect(-10.0, -8.0, 10.0, 8.0)]));
    pad(&mut b, "R2", "1", "GND", "B.Cu", [0.0, 0.0], 1.0, 1.0);
    let out = measure(b);
    assert_eq!(out["clearance_min"], Value::Null);
    assert_eq!(out["shorts"], json!([]));
}

#[test]
fn overlapping_different_nets_short() {
    let mut b = board(30.0, 20.0, 2);
    track(&mut b, "F.Cu", "A", 0.25, [-5.0, 0.0], [5.0, 0.0]);
    track(&mut b, "F.Cu", "B", 0.25, [0.0, -5.0], [0.0, 5.0]);
    let out = measure(b);
    let s = out["shorts"].as_array().unwrap();
    assert_eq!(s.len(), 1);
    assert!(close(&s[0]["at"][0], 0.0, 1e-9) && close(&s[0]["at"][1], 0.0, 1e-9));
    let mut nets = vec![s[0]["nets"][0].as_str().unwrap(), s[0]["nets"][1].as_str().unwrap()];
    nets.sort();
    assert_eq!(nets, ["A", "B"]);
    assert!(close(&out["clearance_min"]["value"], 0.0, 0.0));
}

#[test]
fn zone_hole_clearance_and_buried_short() {
    let mut b = board(40.0, 30.0, 2);
    // GND pour with a 2 × 2 mm hole around a 1 × 1 mm +3V3 pad: 0.5 mm gap
    zone(&mut b, "F.Cu", "GND", json!([rect(-15.0, -10.0, 15.0, 10.0), rect(-1.0, -1.0, 1.0, 1.0)]));
    pad(&mut b, "U1", "1", "+3V3", "F.Cu", [0.0, 0.0], 1.0, 1.0);
    let out = measure(b.clone());
    assert!(close(&out["clearance_min"]["value"], 0.5, 1e-9), "{}", out["clearance_min"]);
    assert_eq!(out["shorts"], json!([]));
    // a SIG track deep inside the pour, nowhere near an edge: a short
    track(&mut b, "F.Cu", "SIG", 0.2, [5.0, 5.0], [8.0, 5.0]);
    let out = measure(b);
    let s = out["shorts"].as_array().unwrap();
    assert_eq!(s.len(), 1, "{s:?}");
    assert!(s[0]["nets"].as_array().unwrap().contains(&json!("SIG")));
}

#[test]
fn zones_of_two_nets_side_by_side() {
    let mut b = board(40.0, 30.0, 2);
    zone(&mut b, "F.Cu", "GND", json!([rect(-15.0, -10.0, -0.15, 10.0)]));
    zone(&mut b, "F.Cu", "+5V", json!([rect(0.15, -10.0, 15.0, 10.0)]));
    let out = measure(b);
    assert!(close(&out["clearance_min"]["value"], 0.3, 1e-9));
}

#[test]
fn corners_and_acid_traps() {
    let mut b = board(40.0, 30.0, 2);
    // 90° turn
    track(&mut b, "F.Cu", "A", 0.2, [-10.0, 0.0], [-5.0, 0.0]);
    track(&mut b, "F.Cu", "A", 0.2, [-5.0, 0.0], [-5.0, 5.0]);
    // 45° turn: not reported
    track(&mut b, "F.Cu", "B", 0.2, [0.0, 0.0], [5.0, 0.0]);
    track(&mut b, "F.Cu", "B", 0.2, [5.0, 0.0], [8.0, 3.0]);
    // T-join with a branch 30° off the main run
    track(&mut b, "F.Cu", "C", 0.2, [-10.0, -8.0], [10.0, -8.0]);
    let a30 = 30f64.to_radians();
    track(&mut b, "F.Cu", "C", 0.2, [0.0, -8.0], [5.0 * a30.cos(), -8.0 - 5.0 * a30.sin()]);
    let out = measure(b);
    let corners = out["corners"].as_array().unwrap();
    assert_eq!(corners.len(), 1, "{corners:?}");
    assert!(close(&corners[0]["angle"], 90.0, 1e-6));
    assert_eq!(corners[0]["net"], "A");
    let acute = out["acute"].as_array().unwrap();
    assert_eq!(acute.len(), 1, "{acute:?}");
    assert!(close(&acute[0]["angle"], 30.0, 1e-3));
    assert_eq!(acute[0]["net"], "C");
}

#[test]
fn acute_shared_endpoint_and_pad_covered_joint() {
    let mut b = board(40.0, 30.0, 2);
    track(&mut b, "F.Cu", "A", 0.2, [0.0, 0.0], [5.0, 0.0]);
    track(&mut b, "F.Cu", "A", 0.2, [0.0, 0.0], [5.0, 2.0]); // ~21.8°
    // the same wedge but rooted inside a big pad: not a trap
    track(&mut b, "F.Cu", "B", 0.2, [0.0, 10.0], [5.0, 10.0]);
    track(&mut b, "F.Cu", "B", 0.2, [0.0, 10.0], [5.0, 12.0]);
    pad(&mut b, "U1", "1", "B", "F.Cu", [0.0, 10.0], 2.0, 2.0);
    let out = measure(b);
    let acute = out["acute"].as_array().unwrap();
    assert_eq!(acute.len(), 1, "{acute:?}");
    assert_eq!(acute[0]["net"], "A");
    assert!(close(&acute[0]["angle"], 2f64.atan2(5.0).to_degrees(), 1e-3));
}

#[test]
fn dangling_ends_and_vias() {
    let mut b = board(40.0, 30.0, 2);
    pad(&mut b, "R1", "1", "A", "F.Cu", [0.0, 0.0], 1.0, 1.0);
    track(&mut b, "F.Cu", "A", 0.2, [0.0, 0.0], [5.0, 0.0]); // far end dangles
    via(&mut b, "A", 10.0, 0.0, 0.6, 0.3); // touches nothing
    via(&mut b, "G", -10.0, 0.0, 0.6, 0.3);
    zone(&mut b, "F.Cu", "G", json!([rect(-12.0, -2.0, -8.0, 2.0)]));
    zone(&mut b, "B.Cu", "G", json!([rect(-12.0, -2.0, -8.0, 2.0)])); // stitches two pours: fine
    let out = measure(b);
    let d = out["dangling"].as_array().unwrap();
    assert_eq!(d.len(), 2, "{d:?}");
    assert!(d.iter().any(|x| x["kind"] == "track" && close(&x["at"][0], 5.0, 1e-9)));
    assert!(d.iter().any(|x| x["kind"] == "via" && close(&x["at"][0], 10.0, 1e-9)));
}

#[test]
fn edges_holes_rings() {
    let mut b = board(40.0, 30.0, 2);
    track(&mut b, "F.Cu", "A", 0.2, [0.0, 14.0], [5.0, 14.0]); // edge at y=15: 0.9 mm
    via(&mut b, "A", 0.0, 0.0, 0.6, 0.3);
    via(&mut b, "B", 1.0, 0.0, 0.5, 0.3); // drills 1.0 apart: 0.7 edge to edge
    b["holes"] = json!([{"x": -10.0, "y": 0.0, "d": 3.2, "plated": false}]);
    let out = measure(b);
    assert!(close(&out["edge_min"]["value"], 0.9, 1e-9), "{}", out["edge_min"]);
    assert!(close(&out["hole_to_hole_min"]["value"], 0.7, 1e-9));
    assert!(close(&out["ring_min"]["value"], 0.1, 1e-9));
    assert!(close(&out["via_min_d"]["value"], 0.5, 1e-12));
    assert!(close(&out["drill_min"]["value"], 0.3, 1e-12));
    // via copper (r 0.3 / 0.25) gap = 1.0 - 0.55 = 0.45
    assert!(close(&out["clearance_min"]["value"], 0.45, 1e-9));
    // drill of via B to copper of via A: 1.0 - 0.15 - 0.3
    assert!(close(&out["hole_clear_min"]["value"], 0.55, 1e-9));
}

#[test]
fn high_voltage_pair_min() {
    let mut b = board(40.0, 30.0, 2);
    track(&mut b, "F.Cu", "HV", 0.5, [-5.0, 0.0], [5.0, 0.0]);
    track(&mut b, "F.Cu", "LV", 0.5, [-5.0, 4.5], [5.0, 4.5]); // 4.0 apart: past 2 mm, inside 5 mm
    track(&mut b, "F.Cu", "X", 0.5, [-5.0, -9.0], [5.0, -9.0]); // 8.5 from HV: not listed
    track(&mut b, "F.Cu", "Y", 0.5, [-5.0, -10.0], [5.0, -10.0]); // X–Y 0.5 apart, neither HV
    let out = run("measure", json!({"board": b, "hv_nets": ["HV"]}));
    let pm = out["pair_min"].as_array().unwrap();
    assert_eq!(pm.len(), 1, "{pm:?}");
    assert!(close(&pm[0]["value"], 4.0, 1e-9));
    assert!(close(&out["clearance_min"]["value"], 0.5, 1e-9));
}

#[test]
fn silk_mask_courtyards_area_return_path() {
    let mut b = board(40.0, 20.0, 2);
    pad(&mut b, "R1", "1", "A", "F.Cu", [0.0, 0.0], 1.0, 1.0);
    pad(&mut b, "R1", "2", "B", "F.Cu", [1.5, 0.0], 1.0, 1.0);
    b["mask_openings"] = json!([
        {"layer": "F.Mask", "poly": rect(-0.55, -0.55, 0.55, 0.55), "ref": "R1", "num": "1"},
        {"layer": "F.Mask", "poly": rect(0.95, -0.55, 2.05, 0.55), "ref": "R1", "num": "2"}]);
    b["silk"] = json!([
        {"layer": "F.Silkscreen", "kind": "line", "w": 0.12, "a": [-1.0, 0.0], "b": [0.0, 0.0]},
        {"layer": "F.Silkscreen", "kind": "text", "w": 0.15, "height": 0.8, "text": "R1", "bbox": [5, 5, 7, 6]}]);
    b["parts"] = json!([
        {"ref": "R1", "x": 0.75, "y": 0, "side": "top", "courtyard": rect(-1.0, -1.0, 2.5, 1.0)},
        {"ref": "C1", "x": 3, "y": 0, "side": "top", "courtyard": rect(2.0, -1.0, 4.0, 1.0)},
        {"ref": "C2", "x": 3, "y": 0, "side": "bottom", "courtyard": rect(2.0, -1.0, 4.0, 1.0)},
        {"ref": "J1", "x": 19, "y": 0, "side": "top", "courtyard": rect(18.0, -2.0, 19.8, 2.0)}]);
    // half of B.Cu is ground; a signal on F.Cu runs over both halves
    zone(&mut b, "B.Cu", "GND", json!([rect(-20.0, -10.0, 0.0, 10.0)]));
    track(&mut b, "F.Cu", "SDA", 0.2, [-10.0, 5.0], [10.0, 5.0]);
    let out = run("measure", json!({"board": b, "signal_nets": ["SDA"], "ref_nets": ["GND"]}));
    assert!(close(&out["silk_w_min"]["value"], 0.12, 1e-12));
    assert!(close(&out["silk_h_min"]["value"], 0.8, 1e-12));
    let sp = out["silk_on_pads"].as_array().unwrap();
    assert_eq!(sp.len(), 1);
    assert_eq!(sp[0]["num"], "1");
    assert!(close(&out["mask_web_min"]["value"], 0.4, 1e-9));
    let co = out["courtyard_overlaps"].as_array().unwrap();
    assert_eq!(co.len(), 1, "{co:?}");
    assert_eq!(co[0]["refs"], json!(["R1", "C1"]));
    assert!(close(&out["part_edge_min"]["value"], 0.2, 1e-9));
    assert_eq!(out["part_edge_min"]["ref"], "J1");
    assert!(close(&out["copper_area"]["B.Cu"], 0.5, 0.01));
    let rp = &out["return_path"][0];
    assert!(close(&rp["length"], 20.0, 1e-9));
    assert!(close(&rp["uncovered"], 10.0, 0.15), "{rp}");
    assert!(f(&rp["worst_at"][0]) > 0.0);
}

#[test]
#[ignore = "timing; run with: cargo test --release -- --ignored --nocapture"]
fn timing_synthetic() {
    for n in [2000, 10000] {
        let b = synthetic(100.0, 80.0, n);
        let t = std::time::Instant::now();
        let out = run("measure", json!({"board": b.clone(), "signal_nets": ["SDA", "SCL"], "ref_nets": ["GND"], "hv_nets": ["+3V3"]}));
        println!("measure {n} tracks: {:.1} ms wall, stats {}", t.elapsed().as_secs_f64() * 1e3, out["stats"]);
        let t = std::time::Instant::now();
        let gnd: Vec<String> = b["pads"].as_array().unwrap().iter().filter(|p| p["net"] == "GND").map(|p| p["ref"].as_str().unwrap().to_string()).collect();
        let sinks: Vec<Value> = gnd[1..].iter().step_by(5).map(|r| json!({"ref": r, "current": 0.05})).collect();
        let out = run("irdrop", json!({"board": b, "net": "GND", "temp_c": 50,
            "sources": [{"ref": gnd[0], "voltage": 0.0}], "sinks": sinks}));
        println!("irdrop GND {n}: {:.1} ms wall, stats {}", t.elapsed().as_secs_f64() * 1e3, out["stats"]);
    }
}
