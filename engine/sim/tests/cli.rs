// SPDX-License-Identifier: AGPL-3.0-or-later
//! End to end: the binary over stdin/stdout.

mod common;
use common::*;
use serde_json::{json, Value};
use std::io::Write;
use std::process::{Command, Stdio};

fn call(args: &[&str], stdin: &str) -> (i32, Value) {
    let mut child = Command::new(env!("CARGO_BIN_EXE_hardhub-sim"))
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .expect("spawn hardhub-sim");
    child.stdin.take().unwrap().write_all(stdin.as_bytes()).unwrap();
    let out = child.wait_with_output().unwrap();
    let v: Value = serde_json::from_slice(&out.stdout).expect("stdout is one JSON document");
    (out.status.code().unwrap_or(-1), v)
}

fn small_board() -> Value {
    let mut b = board(30.0, 20.0, 2);
    pad(&mut b, "J1", "1", "+3V3", "F.Cu", [-10.0, 0.0], 1.0, 1.0);
    pad(&mut b, "U1", "1", "+3V3", "F.Cu", [10.0, 0.0], 1.0, 1.0);
    track(&mut b, "F.Cu", "+3V3", 0.3, [-10.0, 0.0], [10.0, 0.0]);
    track(&mut b, "F.Cu", "SDA", 0.15, [-8.0, 0.5], [8.0, 0.5]);
    zone(&mut b, "B.Cu", "GND", json!([rect(-14.0, -9.0, 14.0, 9.0)]));
    b
}

#[test]
fn version() {
    let (code, v) = call(&["version"], "");
    assert_eq!(code, 0);
    assert_eq!(v["name"], "hardhub-sim");
    assert_eq!(v["version"], env!("CARGO_PKG_VERSION"));
}

#[test]
fn measure_irdrop_thermal_over_pipes() {
    let b = small_board();
    let (code, m) = call(&["measure"], &json!({"board": b, "signal_nets": ["SDA"], "ref_nets": ["GND"]}).to_string());
    assert_eq!(code, 0, "{m}");
    assert!((f(&m["clearance_min"]["value"]) - 0.275).abs() < 1e-9, "{}", m["clearance_min"]);
    assert_eq!(m["stats"]["tracks"], 2);

    let (code, d) = call(
        &["irdrop"],
        &json!({"board": b, "net": "+3V3", "temp_c": 50, "sources": [{"ref": "J1", "num": "1", "voltage": 3.3}],
                "sinks": [{"ref": "U1", "current": 0.4}]})
        .to_string(),
    );
    assert_eq!(code, 0, "{d}");
    assert!(f(&d["worst_mv"]) > 0.0);

    let (code, t) = call(
        &["thermal"],
        &json!({"board": b, "ambients": [25], "sources": [{"ref": "U1", "power": 0.3, "rect": [9, -1, 11, 1], "theta_jb": 20}],
                "extra_heat": d["heat"]})
        .to_string(),
    );
    assert_eq!(code, 0, "{t}");
    assert!(f(&t["maps"][0]["max"]) > 25.0);
}

#[test]
fn errors_are_json_with_exit_1() {
    let (code, v) = call(&["measure"], "not json");
    assert_eq!(code, 1);
    assert!(v["error"].as_str().unwrap().contains("not JSON"));
    let (code, v) = call(&["frobnicate"], "{}");
    assert_eq!(code, 1);
    assert!(v["error"].as_str().unwrap().contains("unknown command"));
    let (code, v) = call(&["irdrop"], &json!({"board": small_board(), "net": "+3V3", "sources": [{"ref": "Q9", "voltage": 1}], "sinks": []}).to_string());
    assert_eq!(code, 1);
    assert!(v["error"].as_str().unwrap().contains("Q9"));
}
