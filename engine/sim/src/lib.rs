// SPDX-License-Identifier: AGPL-3.0-or-later
//! hardhub-sim: the numeric half of HardHub's board tests.  The Python engine
//! sends one board model as JSON and gets measurements or a field solution
//! back; see `dispatch` for the commands.

pub mod geom;
pub mod index;
pub mod irdrop;
pub mod measure;
pub mod model;
pub mod raster;
pub mod solve;
pub mod thermal;

use serde_json::{json, Value};

pub const VERSION: &str = env!("CARGO_PKG_VERSION");

pub fn version() -> Value {
    json!({"name": "hardhub-sim", "version": VERSION, "commands": ["measure", "irdrop", "thermal", "version"]})
}

/// Run one command on its JSON input.
pub fn dispatch(command: &str, input: Value) -> Result<Value, String> {
    match command {
        "measure" => measure::run(input),
        "irdrop" => irdrop::run(input),
        "thermal" => thermal::run(input),
        "version" => Ok(version()),
        other => Err(format!("unknown command '{other}' (expected measure, irdrop, thermal or version)")),
    }
}
