#!/bin/sh
# Copy PartsTracker's G-code converter (src/gcode/) into RosCAM's converter/ crate, unchanged.
#   converter/sync.sh ../PartsTracker
# Then run `cargo test --manifest-path converter/Cargo.toml` and the browser tests.
set -e
src="${1:?usage: converter/sync.sh <PartsTracker checkout>}/src/gcode"
here="$(dirname "$0")/src/gcode"
rm -rf "$here" && mkdir -p "$here" && cp "$src"/*.rs "$here"/
echo "Copied $(ls "$here" | wc -l) files from $src"
