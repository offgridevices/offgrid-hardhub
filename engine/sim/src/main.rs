// SPDX-License-Identifier: AGPL-3.0-or-later
//! `hardhub-sim <command>`: JSON on stdin, JSON on stdout.  On any error the
//! process prints {"error": "..."} and exits 1, so the caller only ever has to
//! parse one JSON document.

use std::io::{Read, Write};

fn fail(msg: String) -> ! {
    let _ = writeln!(std::io::stdout(), "{}", serde_json::json!({ "error": msg }));
    std::process::exit(1);
}

fn main() {
    let cmd = std::env::args().nth(1).unwrap_or_default();
    if cmd.is_empty() || cmd == "--help" || cmd == "-h" {
        fail("usage: hardhub-sim <measure|irdrop|thermal|version>  (JSON input on stdin)".into());
    }
    if cmd == "version" || cmd == "--version" {
        println!("{}", hardhub_sim::version());
        return;
    }
    let mut buf = String::new();
    if let Err(e) = std::io::stdin().read_to_string(&mut buf) {
        fail(format!("reading stdin: {e}"));
    }
    let input: serde_json::Value = match serde_json::from_str(&buf) {
        Ok(v) => v,
        Err(e) => fail(format!("input is not JSON: {e}")),
    };
    match hardhub_sim::dispatch(&cmd, input) {
        Ok(out) => {
            let mut so = std::io::stdout().lock();
            let _ = serde_json::to_writer(&mut so, &out);
            let _ = writeln!(so);
        }
        Err(e) => fail(e),
    }
}
