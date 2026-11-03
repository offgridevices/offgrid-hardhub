// SPDX-License-Identifier: AGPL-3.0-or-later
//! Thin-plate heat solver against closed-form results.

mod common;
use common::*;
use serde_json::{json, Value};

fn temp_of(out: &Value, r: &str, k: usize) -> f64 {
    let p = out["parts"].as_array().unwrap().iter().find(|p| p["ref"] == r).unwrap();
    f(&p["temps"][k]["board"])
}

#[test]
fn uniform_heating_with_fixed_h_gives_q_over_h_sum() {
    let (w, h) = (40.0, 30.0);
    let b = board(w, h, 2);
    let p = 2.0; // W over the whole board
    let out = run(
        "thermal",
        json!({"board": b, "ambients": [25], "cell": 0.5, "h_top": 12.0, "h_bottom": 8.0,
               "sources": [{"ref": "H", "power": p, "rect": [-w/2.0, -h/2.0, w/2.0, h/2.0]}]}),
    );
    let q = p / (w * h * 1e-6);
    let want = 25.0 + q / 20.0;
    let m = &out["maps"][0];
    assert!((f(&m["max"]) - want).abs() < 0.01 * (want - 25.0), "{} vs {want}", m["max"]);
    assert!((f(&m["min"]) - want).abs() < 0.01 * (want - 25.0), "{} vs {want}", m["min"]);
    assert!((temp_of(&out, "H", 0) - want).abs() < 0.01 * (want - 25.0));
}

/// Modified Bessel K0 (Abramowitz & Stegun 9.8.5–9.8.6), for the point-source
/// solution of a plate losing heat through its faces.
fn bessel_k0(x: f64) -> f64 {
    if x <= 2.0 {
        let t = x / 3.75;
        let t2 = t * t;
        let i0 = 1.0 + t2 * (3.5156229 + t2 * (3.0899424 + t2 * (1.2067492 + t2 * (0.2659732 + t2 * (0.0360768 + t2 * 0.0045813)))));
        let y = x * x / 4.0;
        -(x / 2.0).ln() * i0 - 0.57721566
            + y * (0.42278420 + y * (0.23069756 + y * (0.03488590 + y * (0.00262698 + y * (0.00010750 + y * 0.0000074)))))
    } else {
        let y = 2.0 / x;
        (-x).exp() / x.sqrt()
            * (1.25331414 + y * (-0.07832358 + y * (0.02189568 + y * (-0.01062446 + y * (0.00587872 + y * (-0.00251540 + y * 0.00053208))))))
    }
}

fn point_source(h_fixed: Option<f64>) -> Value {
    let size = 120.0;
    let b = board(size, size, 2); // no copper: FR4 only, k·t = 0.8 × 1.5 mm
    let mut sources = vec![json!({"ref": "Q", "power": 0.5, "rect": [-0.5, -0.5, 0.5, 0.5], "theta_jb": 20})];
    for r in [4.0, 8.0, 16.0, 24.0] {
        sources.push(json!({"ref": format!("S{r}"), "power": 0.0, "rect": [r - 0.25, -0.25, r + 0.25, 0.25]}));
    }
    let mut inp = json!({"board": b, "ambients": [25, 50], "cell": 0.5, "sources": sources});
    if let Some(h) = h_fixed {
        inp["h_top"] = json!(h);
        inp["h_bottom"] = json!(h);
    }
    run("thermal", inp)
}

#[test]
fn point_source_decays_like_k0_and_balances_heat() {
    let out = point_source(Some(10.0));
    let kt = 0.8 * 1.5e-3;
    let lambda_mm = (kt / 20.0f64).sqrt() * 1e3;
    let th = |r: f64| temp_of(&out, &format!("S{r}"), 0) - 25.0;
    let (t4, t8, t16, t24) = (th(4.0), th(8.0), th(16.0), th(24.0));
    assert!(t4 > t8 && t8 > t16 && t16 > t24 && t24 > 0.0, "{t4} {t8} {t16} {t24}");
    for (a, bb) in [(4.0, 8.0), (8.0, 16.0), (8.0, 24.0)] {
        let want = bessel_k0(a / lambda_mm) / bessel_k0(bb / lambda_mm);
        let got = th(a) / th(bb);
        assert!((got / want - 1.0).abs() < 0.05, "θ({a})/θ({bb}) = {got}, K0 says {want}");
    }
    // absolute: θ(r) = P/(2π k t) K0(r/λ)
    let want8 = 0.5 / (2.0 * std::f64::consts::PI * kt) * bessel_k0(8.0 / lambda_mm);
    assert!((t8 / want8 - 1.0).abs() < 0.05, "{t8} vs {want8}");
    for m in out["maps"].as_array().unwrap() {
        let (qi, qo) = (f(&m["heat_in_w"]), f(&m["heat_out_w"]));
        assert!((qi - qo).abs() / qi < 0.01, "{qi} in, {qo} out");
    }
    // junction = board + P θjb
    let p = out["parts"].as_array().unwrap().iter().find(|p| p["ref"] == "Q").unwrap();
    assert!((f(&p["temps"][0]["junction"]) - f(&p["temps"][0]["board"]) - 10.0).abs() < 2e-3);
    // fixed h: the rise does not depend on ambient
    let rise0 = f(&out["maps"][0]["max"]) - 25.0;
    let rise1 = f(&out["maps"][1]["max"]) - 50.0;
    assert!((rise0 - rise1).abs() < 1e-3);
}

#[test]
fn computed_h_converges_balances_and_runs_hotter_when_enclosed() {
    let out = point_source(None);
    for m in out["maps"].as_array().unwrap() {
        let (qi, qo) = (f(&m["heat_in_w"]), f(&m["heat_out_w"]));
        assert!((qi - qo).abs() / qi < 0.01, "{qi} in, {qo} out");
    }
    // radiation strengthens with absolute temperature: same power, smaller
    // rise at the hotter ambient
    let rise0 = f(&out["maps"][0]["max"]) - 25.0;
    let rise1 = f(&out["maps"][1]["max"]) - 50.0;
    assert!(rise1 < rise0, "{rise0} {rise1}");
    let b = board(50.0, 40.0, 2);
    let mk = |enclosed: bool| {
        run(
            "thermal",
            json!({"board": b, "ambients": [25], "enclosed": enclosed,
                   "sources": [{"ref": "U", "power": 1.0, "rect": [-2, -2, 2, 2]}]}),
        )
    };
    let open = f(&mk(false)["maps"][0]["max"]);
    let closed = f(&mk(true)["maps"][0]["max"]);
    assert!(closed > open + 1.0, "{open} {closed}");
}

#[test]
fn copper_spreads_heat() {
    let b0 = board(50.0, 40.0, 2);
    let mut b1 = b0.clone();
    zone(&mut b1, "B.Cu", "GND", json!([rect(-25.0, -20.0, 25.0, 20.0)]));
    let mk = |b: &Value| {
        let out = run(
            "thermal",
            json!({"board": b, "ambients": [25], "sources": [{"ref": "U", "power": 0.5, "rect": [-1, -1, 1, 1]}]}),
        );
        f(&out["maps"][0]["max"])
    };
    let (bare, poured) = (mk(&b0), mk(&b1));
    assert!(poured < bare - 5.0, "bare {bare}, with plane {poured}");
}

#[test]
fn output_shape() {
    let b = board(20.0, 10.0, 2);
    let out = run("thermal", json!({"board": b, "ambients": [0, 50], "cell": 0.5, "sources": [{"ref": "U", "power": 0.2, "rect": [-1, -1, 1, 1]}]}));
    let g = &out["grid"];
    assert_eq!((g["nx"].as_u64(), g["ny"].as_u64()), (Some(40), Some(20)));
    use base64::Engine;
    let dec = |v: &Value| base64::engine::general_purpose::STANDARD.decode(v.as_str().unwrap()).unwrap();
    let mask = dec(&out["mask_b64"]);
    assert_eq!(mask.len(), 800);
    assert!(mask.iter().all(|&m| m == 1));
    let m = dec(&out["maps"][1]["u8_b64"]);
    assert_eq!(m.len(), 800);
    assert_eq!(*m.iter().max().unwrap(), 255);
    let at = &out["maps"][0]["max_at"];
    assert!(f(&at[0]).abs() < 1.0 && f(&at[1]).abs() < 1.0);
    assert_eq!(out["parts"][0]["temps"].as_array().unwrap().len(), 2);
}

#[test]
#[ignore = "timing; run with: cargo test --release -- --ignored --nocapture"]
fn timing_100x80() {
    let b = synthetic(100.0, 80.0, 2000);
    let inp = json!({"board": b, "ambients": [0, 25, 50], "cell": 0.5,
        "sources": [{"ref": "U1", "power": 0.8, "rect": [-3, -3, 3, 3], "theta_jb": 15},
                    {"ref": "U2", "power": 0.3, "rect": [20, 10, 24, 14]}]});
    let t = std::time::Instant::now();
    let out = run("thermal", inp);
    println!("thermal 100x80 @0.5: {:.1} ms wall, stats {}", t.elapsed().as_secs_f64() * 1e3, out["stats"]);
}
