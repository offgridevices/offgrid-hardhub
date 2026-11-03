// SPDX-License-Identifier: AGPL-3.0-or-later
//! Voltage-drop solver against closed-form resistances.

mod common;
use common::*;
use hardhub_sim::irdrop::rho_mm;
use serde_json::{json, Value};

fn drop_case(b: Value, temp: f64, current: f64) -> Value {
    run(
        "irdrop",
        json!({"board": b, "net": "+3V3", "temp_c": temp,
               "sources": [{"ref": "U1", "num": "1", "voltage": 3.3}],
               "sinks": [{"ref": "U2", "num": "1", "current": current}]}),
    )
}

fn two_pads(len: f64, pad_h: f64) -> Value {
    let mut b = board(60.0, 40.0, 2);
    pad(&mut b, "U1", "1", "+3V3", "F.Cu", [-len / 2.0, 0.0], 0.2, pad_h);
    pad(&mut b, "U2", "1", "+3V3", "F.Cu", [len / 2.0, 0.0], 0.2, pad_h);
    b
}

#[test]
fn straight_track_matches_rho_l_over_wt() {
    let (len, w, t) = (20.0, 0.5, 0.035);
    let mut b = two_pads(len, 1.0);
    track(&mut b, "F.Cu", "+3V3", w, [-len / 2.0, 0.0], [len / 2.0, 0.0]);
    let out = drop_case(b, 20.0, 1.0);
    let want = rho_mm(20.0) * len / (w * t); // Ω
    let got = f(&out["resistance_mohm"]) / 1e3;
    assert!((got - want).abs() / want < 0.01, "R {got} vs {want}");
    assert!((f(&out["worst_mv"]) / 1e3 - want).abs() / want < 0.01);
    assert_eq!(out["worst"]["ref"], "U2");
    let tm = &out["track_max"];
    assert!((f(&tm["current"]) - 1.0).abs() < 1e-6 && f(&tm["w"]) == w);
    let md = f(&out["max_density"]["value"]);
    assert!((md - 1.0 / (w * t)).abs() / md < 1e-3, "density {md}");
    // Joule heat I²R comes back as heat points summing to the dissipation
    let heat: f64 = out["heat"].as_array().unwrap().iter().map(|h| f(&h["w"])).sum();
    assert!((heat - want).abs() / want < 1e-3, "heat {heat} vs {want}");
}

#[test]
fn two_parallel_paths_halve_resistance() {
    let len = 20.0;
    let mut one = two_pads(len, 3.0);
    track(&mut one, "F.Cu", "+3V3", 0.3, [-len / 2.0, -1.0], [len / 2.0, -1.0]);
    let mut two = one.clone();
    track(&mut two, "F.Cu", "+3V3", 0.3, [-len / 2.0, 1.0], [len / 2.0, 1.0]);
    let r1 = f(&drop_case(one, 25.0, 0.5)["resistance_mohm"]);
    let r2 = f(&drop_case(two, 25.0, 0.5)["resistance_mohm"]);
    assert!((r2 / r1 - 0.5).abs() < 0.005, "{r1} {r2}");
}

#[test]
fn track_with_t_join_and_bend() {
    // source -> 10 mm -> junction -> 10 mm -> sink, with a dead-end branch at
    // the junction (carries no current) and the main run split by it.
    let mut b = two_pads(20.0, 1.0);
    track(&mut b, "F.Cu", "+3V3", 0.25, [-10.0, 0.0], [10.0, 0.0]);
    track(&mut b, "F.Cu", "+3V3", 0.25, [0.0, 0.0], [0.0, 8.0]); // T on the middle
    let out = drop_case(b, 20.0, 1.0);
    let want = rho_mm(20.0) * 20.0 / (0.25 * 0.035);
    let got = f(&out["resistance_mohm"]) / 1e3;
    assert!((got - want).abs() / want < 0.01, "{got} {want}");
}

#[test]
fn temperature_coefficient_applied() {
    let mk = || {
        let mut b = two_pads(20.0, 1.0);
        track(&mut b, "F.Cu", "+3V3", 0.4, [-10.0, 0.0], [10.0, 0.0]);
        b
    };
    let r20 = f(&drop_case(mk(), 20.0, 1.0)["resistance_mohm"]);
    let r70 = f(&drop_case(mk(), 70.0, 1.0)["resistance_mohm"]);
    let want = 1.0 + 0.00393 * 50.0;
    assert!((r70 / r20 - want).abs() < 1e-3, "{} vs {want}", r70 / r20);
}

#[test]
fn zone_square_edge_to_edge_is_sheet_resistance_times_squares() {
    // 20 × 10 mm pour, fed along its whole left edge, drawn along its right.
    let (l, w) = (20.0, 10.0);
    let mut b = board(60.0, 40.0, 2);
    zone(&mut b, "F.Cu", "+3V3", json!([rect(-l / 2.0, -w / 2.0, l / 2.0, w / 2.0)]));
    pad(&mut b, "U1", "1", "+3V3", "F.Cu", [-l / 2.0 - 0.5, 0.0], 1.0, w);
    pad(&mut b, "U2", "1", "+3V3", "F.Cu", [l / 2.0 + 0.5, 0.0], 1.0, w);
    let out = drop_case(b, 20.0, 1.0);
    let rs = rho_mm(20.0) / 0.035;
    let want = rs * l / w;
    let got = f(&out["resistance_mohm"]) / 1e3;
    assert!((got - want).abs() / want < 0.03, "zone R {got} vs {want}");
}

#[test]
fn via_barrel_resistance_and_via_current() {
    let mut b = board(30.0, 30.0, 2);
    pad(&mut b, "U1", "1", "+3V3", "F.Cu", [-5.0, 0.0], 1.0, 1.0);
    pad(&mut b, "U2", "1", "+3V3", "B.Cu", [5.0, 0.0], 1.0, 1.0);
    track(&mut b, "F.Cu", "+3V3", 1.0, [-5.0, 0.0], [0.0, 0.0]);
    via(&mut b, "+3V3", 0.0, 0.0, 0.6, 0.3);
    track(&mut b, "B.Cu", "+3V3", 1.0, [0.0, 0.0], [5.0, 0.0]);
    let out = drop_case(b, 20.0, 2.0);
    let rho = rho_mm(20.0);
    let r_tracks = 2.0 * rho * 5.0 / (1.0 * 0.035);
    let h = 1.5 + 0.035;
    let r_via = rho * h / (std::f64::consts::PI * 0.025 * (0.3 + 0.025));
    let got = f(&out["resistance_mohm"]) / 1e3;
    let want = r_tracks + r_via;
    assert!((got - want).abs() / want < 0.01, "{got} vs {want}");
    assert!((f(&out["via_max"]["current"]) - 2.0).abs() < 1e-6);
}

#[test]
fn unconnected_sink_is_an_island() {
    let mut b = two_pads(20.0, 1.0);
    track(&mut b, "F.Cu", "+3V3", 0.3, [-10.0, 0.0], [10.0, 0.0]);
    pad(&mut b, "U5", "3", "+3V3", "F.Cu", [0.0, 10.0], 0.5, 0.5);
    let out = run(
        "irdrop",
        json!({"board": b, "net": "+3V3", "temp_c": 25,
               "sources": [{"ref": "U1", "num": "1", "voltage": 3.3}],
               "sinks": [{"ref": "U2", "current": 0.3}, {"ref": "U5", "current": 0.1}, {"ref": "U9", "current": 0.1}]}),
    );
    assert_eq!(out["islands"], json!([{"refs": ["U5"]}]));
    assert_eq!(out["sinks"].as_array().unwrap().len(), 1);
    assert_eq!(out["missing"][0]["ref"], "U9");
}

#[test]
fn sink_current_splits_over_its_pads() {
    // U2 has two pads on the net, each at the end of its own identical track:
    // half the current each, so the drop is that of 0.5 A through one track.
    let mut b = board(60.0, 40.0, 2);
    pad(&mut b, "U1", "1", "+3V3", "F.Cu", [-10.0, 0.0], 0.5, 4.0);
    pad(&mut b, "U2", "1", "+3V3", "F.Cu", [10.0, -1.0], 0.5, 0.5);
    pad(&mut b, "U2", "2", "+3V3", "F.Cu", [10.0, 1.0], 0.5, 0.5);
    track(&mut b, "F.Cu", "+3V3", 0.3, [-10.0, -1.0], [10.0, -1.0]);
    track(&mut b, "F.Cu", "+3V3", 0.3, [-10.0, 1.0], [10.0, 1.0]);
    let out = run(
        "irdrop",
        json!({"board": b, "net": "+3V3", "temp_c": 20,
               "sources": [{"ref": "U1", "voltage": 3.3}], "sinks": [{"ref": "U2", "current": 1.0}]}),
    );
    let r = rho_mm(20.0) * 20.0 / (0.3 * 0.035);
    assert!((f(&out["worst_mv"]) / 1e3 - 0.5 * r).abs() / r < 0.01);
}
