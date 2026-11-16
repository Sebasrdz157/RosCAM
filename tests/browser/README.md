# Browser tests

End-to-end tests of the RosCAM web app in headless Chromium (Playwright), against an
in-script stand-in for Supabase. Not part of `make test`; run them after changing `web/`.

## One-time setup (a scratch folder, e.g. `$S`)

The tests load Pyodide and three.js from local copies, because some environments (the
Claude cloud sandbox) block the CDNs. Put these under `$S`:

```bash
# Pyodide 0.27.2 runtime + the packages RosCAM uses (from the GitHub release tarball)
mkdir -p $S/pyodide && cd $S/pyodide
curl -sSL https://github.com/pyodide/pyodide/releases/download/0.27.2/pyodide-0.27.2.tar.bz2 \
  | tar -xjf - --wildcards 'pyodide/pyodide*' 'pyodide/python_stdlib.zip' 'pyodide/numpy-*' \
    'pyodide/shapely-*' 'pyodide/PyYAML-*' 'pyodide/micropip-*' 'pyodide/packaging-*' \
    'pyodide/pyclipper-*' 'pyodide/typing_extensions-*' 'pyodide/pyparsing-*' 'pyodide/fonttools-*'
# ezdxf wheel for pyodide_repro.js / pyodide_stress.js (the browser gets it from PyPI via micropip)
mkdir -p $S/pyodide/wheels && (cd $S/pyodide/wheels && pip download ezdxf==1.4.5 --no-deps --only-binary=:all: \
  --python-version 3.12 --platform any)
# three.js r128 + OrbitControls
mkdir -p $S/three && cd $S/three && npm pack three@0.128.0 && tar -xzf three-0.128.0.tgz
# test DXFs used by nesttest/toolstest
uv run python tests/browser/make_parts.py $S/parts   # plate.dxf, small.dxf, bracket.dxf, rack.dxf
```

## Run

```bash
uv run python web/build.py && (cd dist && python3 -m http.server 8765 &)
node tests/browser/nesttest.js $S      # nesting, programs, zoom, one-part download, mark as cut
node tests/browser/nesttest.js $S empty  # no sheets yet: the 'add one' hint
node tests/browser/toolstest.js $S     # Tools screen + a rack that needs a 1/8" end mill
node tests/browser/sheettest.js $S     # Sheets screen
node tests/browser/simtest.js $S       # 3D simulation
node tests/browser/pyodide_repro.js $S # browser Python engine in node (crash reproduction)
# Same tests against RosCAM as PartsTracker serves it (after web/build.py --partstracker and cargo run):
ROSCAM_URL=http://localhost:5572/cnc/roscam/ node tests/browser/nesttest.js $S
```
