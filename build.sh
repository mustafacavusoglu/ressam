#!/bin/sh
# Rebuild js/ressam.wasm from wasm/ for local runs (Docker builds it on its own).
set -e
cd "$(dirname "$0")/wasm"
cargo build --release --target wasm32-unknown-unknown
cp target/wasm32-unknown-unknown/release/ressam_core.wasm ../js/ressam.wasm
