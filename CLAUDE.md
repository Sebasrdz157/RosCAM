# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## RosCAM (this fork)

**Start with `docs/HANDOFF.md`**: the shop's setup, decisions, branch state, how to test
(including the browser tests in `tests/browser/`), hard-won gotchas, and the next task.

RosCAM is a fork of PenguinCAM for a shop with an Axiom router, a Richauto controller, and
**no tool changer**. It writes **one program per tool** (drills first, then the 1/4" end mill
for milled holes, pockets and the outline with tabs) plus a setup sheet.

- `roscam.py` - the RosCAM job builder and CLI. Uses `FRCPostProcessor` for geometry,
  pocketing and tabs; adds the tool library, hole-to-drill matching, per-tool programs,
  stock-top Z zero, G83 expansion, and preflight checks.
- `roscam_config.yaml` - machine, tool library, materials/thicknesses and tab sizes.
- `tests/test_roscam.py` - RosCAM tests; `tests/fixtures/make_roscam_plate.py` builds the test plate.
- `web/` - the static web app (runs roscam.py in the browser via Pyodide); `web/nest/` - nesting
  engine adapted from SVGnest (MIT; keep its license file and headers); `web/db.js` - sheet
  inventory and tool library through the Parts Tracker's `/api/roscam/` (Auth0 sign-in, Firestore). `uv run python web/build.py` assembles `dist/`.

RosCAM conventions (differ from upstream PenguinCAM):
- **Z0 is the TOP of the stock** (PenguinCAM's internal frame is Z0 at the spoilboard;
  `roscam.shift_z` converts the end mill body). X0 Y0 is the lower-left corner of the stock,
  with the part placed `setup.stock_margin` in from it.
- The engine writes plain G0/G1/G2/G3 in inches: no canned cycles (G83 is expanded), no G53.
  The web app converts each program to Richauto `.mmg` in the browser (`converter/`, the same
  code as the PartsTracker `/cnc` page) before download.

```bash
uv run python roscam.py part.dxf -m aluminum -t 1/4 -o out/
```

Keep changes to upstream files minimal so PenguinCAM fixes can still be merged from the
`upstream` remote.

## Project Overview

PenguinCAM is a web-based CAM post-processor that generates CNC G-code from DXF files exported from Onshape. Built for FRC Team 6238, it automates the CAD-to-CNC workflow for flat plates without requiring CAM software.

**Live deployment:** https://penguincam.popcornpenguins.com

## Development Commands

**Important**: This project uses `uv` for Python environment management locally. All Python commands should be run with `uv run`:

```bash
# Install dependencies
make install

# Run development server (opens http://localhost:6238)
uv run python frc_cam_gui_app.py

# Run G-code comparison tests
make test

# Run postprocessor directly (CLI)
uv run python frc_cam_postprocessor.py INPUT.dxf OUTPUT.nc \
  --material plywood \
  --thickness 0.25 \
  --tool-diameter 0.157

# Test any Python module import
uv run python -c "from frc_cam_gui_app import app; print('OK')"
```

## Dependency Management

**CRITICAL**: This project uses `requirements.txt` for dependency specification (NOT `pyproject.toml`).

- **Local development**: Uses `uv` with `requirements.txt` (run `make install` or `uv pip install -r requirements.txt`)
- **Deployment**: Railway reads `requirements.txt` to install dependencies
- **Adding dependencies**: Edit `requirements.txt` directly, then run `uv pip install -r requirements.txt`
- **DO NOT** create or use `pyproject.toml` - it will cause confusion with Railway deployment

```bash
# Add a new dependency
echo "new-package>=1.0.0" >> requirements.txt
uv pip install -r requirements.txt
```

## Development Rules

**Always run `make test` after making any code changes.** If tests fail, fix the errors before proceeding with other work. Do not commit or consider a change complete until all tests pass.

## G-code Generation Rules

**CRITICAL**: The CNC machines that run our G-code have strict requirements. Violating these rules will cause machine failures:

### Nested Comments - FORBIDDEN
- **NEVER use nested parenthesis comments** in G-code output
- ❌ Bad: `(Outer comment (nested comment) more text)`
- ✅ Good: `(Outer comment, nested text, more text)`
- A controller ends the comment at the first `)` and tries to execute the rest of the line

### Unicode Characters - FORBIDDEN
- **All G-code must be pure ASCII** - no unicode characters
- ❌ Bad: `(Cut depth: 0.25″)` (curly quotes), `(Feedrate → 75 IPM)` (arrows)
- ✅ Good: `(Cut depth: 0.25")` (straight quotes), `(Feedrate: 75 IPM)` (colon)

### Square Brackets in Comments - FORBIDDEN
- **No `[` or `]` inside a parenthesis comment** - some controllers read them as expressions
- ❌ Bad: `(Z offset: +1.875" [tube_height - wall_thickness])`
- ✅ Good: `(Z offset: +1.875", tube_height - wall_thickness)`

### How these rules are enforced

Three layers, because no single one is sufficient (`gcode_hygiene.py`):

1. **Runtime gate.** Every generated program is assembled by `finalize_gcode()`, which
   scrubs each line: nested parens flatten to commas, unicode transliterates to ASCII
   (`°` → ` deg`, `″` → `"`), brackets are dropped, unclosed comments are closed. A bad
   comment can never reach a machine, whichever branch produced it. **Any new place that
   builds a G-code program must go through `finalize_gcode()`, not `'\n'.join(...)`.**
2. **Strict mode in tests.** `tests/__init__.py` sets `gcode_hygiene.STRICT = True`, so
   during `make test` `finalize_gcode()` *raises* instead of repairing. Any generation
   test that produces a bad line fails, naming the line. (`make test` runs discovery with
   `-t .` so the `tests` package init actually loads - don't drop that flag.)
3. **Source lint.** `tests/test_gcode_hygiene.py` parses the emitting modules with `ast`
   and checks every G-code comment *literal*, including ones inside conditional branches
   that no test executes. This is what layers 1 and 2 cannot see on their own.

Add new G-code-emitting modules to `GCODE_SOURCES` in `tests/test_gcode_hygiene.py`.

### Best Practices
When generating G-code comments:
1. Use commas or semicolons instead of nested parentheses
2. Use straight ASCII quotes and standard punctuation
3. Be especially careful with f-strings that include measurements or user data - an
   interpolated value or a conditional fragment is the usual way a stray `(` gets in
4. Note that the runtime scrubber *repairs* rather than rejects, so a mistake shows up as
   a mangled comment in production; fix it at the source when strict mode flags it

## Git Operations

Work on a feature branch and open a pull request into `main`; don't push straight to `main`.
(Upstream PenguinCAM's "no git commands" rule does not apply to RosCAM.)

## Architecture

```
Browser (wizard.html + Three.js)
    ↓ HTTP POST /process, /process-job
Flask Server (frc_cam_gui_app.py)
    ↓ subprocess
G-code Generator (frc_cam_postprocessor.py)
    ↓
.nc file → 3D visualization / download / Drive upload
```

**Key files:**
- `frc_cam_gui_app.py` - Flask routes, Onshape OAuth, Drive integration
- `frc_cam_postprocessor.py` - Core G-code generation (`FRCPostProcessor` class)
- `templates/wizard.html` - Multi-part wizard UI (the whole app; served at `/`, `/app`, and the Onshape panel), with `static/wizard.js` + `static/gcode_viewer.js` (Three.js 3D visualization)
- `onshape_integration.py` - Onshape API client for one-click export
- `penguincam_auth.py` - Google Workspace OAuth (optional)
- `google_drive_integration.py` - Drive upload (optional)

## Documentation

Detailed documentation lives in the `docs/` directory. **Read these before modifying related code:**

| File | When to Read |
|------|--------------|
| `Z_COORDINATE_SYSTEM.md` | Modifying Z-axis calculations, safe heights, cut depths, or plunge moves |
| `TOOL_COMPENSATION_GUIDE.md` | Changing offset logic for perimeters, pockets, or holes |
| `ASSUMPTIONS.md` | Adding/changing G-code output; lists controller compatibility requirements |
| `MACHINE_CHECKLIST.md` | Updating G-code header comments or safety checks |
| `DEPLOYMENT_GUIDE.md` | Changing environment variables, Railway config, or OAuth redirect URIs |
| `AUTHENTICATION_GUIDE.md` | Modifying Google OAuth flow, session handling, or domain restrictions |
| `INTEGRATIONS_GUIDE.md` | Changing Onshape API calls or Google Drive upload logic |
| `ONSHAPE_SETUP.md` | Updating the Onshape browser extension or import URL format |
| `quick-reference-card.md` | Changing UI workflows or default settings that affect end users |

## Testing

Tests compare PenguinCAM output against Fusion 360 CAM output using the `pygcode` library. Test fixtures are DXF files with known expected G-code.

```bash
make test  # Runs all comparison tests
```
