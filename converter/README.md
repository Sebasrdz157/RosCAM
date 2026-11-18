# Converter (WebAssembly)

PartsTracker's G-code to Richauto `.mmg` converter, compiled to WebAssembly so RosCAM hands
out router-ready files without a trip through the Converter page.

- `src/gcode/` is a **verbatim copy** of `Frc5572/PartsTracker` `src/gcode/`. Never edit it here:
  change it in PartsTracker, then run `converter/sync.sh <PartsTracker checkout>`.
- `src/lib.rs` is RosCAM's: the same file-name cleanup as PartsTracker's `POST /cnc/convert`,
  plus a tiny wasm interface used by `web/converter.js`.
- `web/build.py` compiles it (`cargo build --release --target wasm32-unknown-unknown`; needs
  `rustup target add wasm32-unknown-unknown` once) and ships it as `converter.wasm`.
- `web/build.py --partstracker <checkout>` refuses to export if this copy and PartsTracker's
  differ, so the two can never convert differently.
