# RosCAM handoff

Everything a new session needs to keep working on RosCAM without the original chat.
Read this and `CLAUDE.md` first. Keep this file current when things change.

## Who it's for and how they work

- FRC team 5572's manufacturing subteam. The user is a student lead; explain things in
  plain words, give numbered steps for anything they must click.
- **Be non-destructive.** Work on a feature branch and open a pull request; never push to
  `main` of either repo. The user merges.
- **PartsTracker (`Frc5572/PartsTracker`) deploys to production on every push to `main`**
  (Google Cloud Run, someone else's paid account). Only additive changes, on a branch, and
  never put RosCAM data or compute on Google Cloud.
- RosCAM data lives in the user's own Supabase project; RosCAM runs entirely in the browser.

## The shop (verified from their VCarve output; see `roscam_config.yaml`)

| | |
|---|---|
| Machine | Axiom router, Richauto DSP controller, 24" (X) x 48" (Y), stock up to 2" |
| Tool changer | None: **one program per tool**, operator swaps the bit and re-zeros Z |
| Zero | X0 Y0 lower-left corner of the stock/sheet, **Z0 on top of the stock** |
| Overcut | 1 mm into the spoilboard |
| 1/4" flat end mill | 1 flute, 3/4" cut length; 17820 RPM, 144 in/min, plunge 10, ~1 mm per pass (profiles only) |
| 13/64" and 5/32" drills | 118 deg; 6900 RPM, 30 in/min, 1.2 mm pecks with 0.38 mm chip-break lift (from `1364.mmg`) |
| Tabs | from `out.mmg`: ~0.5" long, 0.026" thick in 1/8" sheet; 4" spacing |
| Materials | aluminum and polycarbonate, 1/16", 1/8", 1/4"; sheets are 24" x 48" |
| Cut gap | 1/4" of solid material between any two cuts (`setup.cut_gap`), so parts end up 0.75" apart |

Open questions for the user: which material each VCarve end mill setting belongs to
(17820 RPM / 144 in/min vs 20978 RPM / 33 in/min seen in `In.mmg`/`out.mmg`); confirm drill
numbers (an earlier chat had 7200 RPM / 45 in/min).

**Output path:** RosCAM writes plain G0-G3 `.nc` in inches. The team converts each file to
Richauto `.mmg` with PartsTracker's `/cnc` page (Rust, `src/gcode/`). That converter keeps
comments up to 60 chars and drops quotes, drops `G4`, and warns on helical arcs (RosCAM
linearizes them). It reproduces the shop's VCarve files byte-for-byte.

## What exists

- **CAM engine** `roscam.py` on top of PenguinCAM (`frc_cam_postprocessor.py`, MIT, Team 6238):
  hole-to-drill matching, per-tool programs, stock-top Z, G83 expansion, preflight checks,
  sheet placement, multi-part sheet jobs (`generate_sheet_job`), smaller end mills for details
  the 1/4" can't reach (rack teeth, narrow slots; cut in layers before the 1/4"), tool library
  merge (`config_with_tools`).
- **Web app** `web/` (static; GitHub Pages via `.github/workflows/pages.yml`):
  `index.html`, `roscam.css`, `app.js` (Make programs), `sheets.js` (Sheets), `tools.js` (Tools),
  `db.js` (Supabase REST), `worker.js` (Pyodide 0.27.2 runs the Python), `viewer.js` (3D sim,
  from PenguinCAM), `nest/` (nesting engine adapted from SVGnest, MIT). `web/build.py` builds
  `dist/` and stamps `?v=<commit>-<time>` on every file URL (cache busting).
- **Supabase** (`supabase/schema.sql`, `lock_down.sql`): tables `sheets`, `sheet_regions`,
  `tools`, `editors`. Editing is currently **open** (no sign-in, `requireSignIn: false` in
  `web/config.js`). Project URL and publishable key are in `web/config.js` (public by design).
- **PartsTracker** branch `cnc-roscam-tab`: adds Converter | RosCAM tabs to `/cnc` and a
  `/cnc/roscam` page that frames `https://sebasrdz157.github.io/RosCAM/`. Additive only.
  Not merged (user decides; merging deploys production).

## Branch state (update when it changes)

- `main`: through nesting + cut-gap spacing (PR #6).
- `cache-bust`: version-stamped URLs. Included in `tools-zoom`.
- `tools-zoom`: preview zoom, colors per bit, one-part download, pick-what-was-cut, tool library
  (Tools screen + `tools` table), smaller end mills for details, Clipper geometry, worker auto-restart.
  **User must re-run `supabase/schema.sql`** to create the `tools` table.

## Testing

- `make test`: all Python tests (~343). Strict G-code hygiene is on in tests.
- `tests/browser/*.js`: Playwright end-to-end tests against a **stand-in Supabase** (in the
  script). See `tests/browser/README.md` for setup. The cloud sandbox blocks cdn.jsdelivr.net,
  cdnjs and github.io, so the tests serve a local copy of the Pyodide 0.27.2 release and of
  three.js r128 (paths under the scratch dir passed as argv[2]).
- `tests/browser/pyodide_repro.js` / `pyodide_stress.js`: run the browser's exact Python
  engine in node to reproduce browser-only crashes.
- `tests/converter/`: tiny Rust harness around PartsTracker's converter
  (edit the `#[path]` in `src/main.rs` to your PartsTracker checkout).

## Gotchas learned the hard way

- **GEOS 3.12 in Pyodide crashes fatally** (uncatchable C++ TopologyException) when buffering
  cutter-shaped outlines (an arc offset by exactly its radius, near-collinear points). New
  geometry that grows/shrinks shapes should use Clipper (`pyclipper`, `_c_*` helpers in
  `roscam.py`), orient outer rings CCW for Clipper, and be stress-tested with
  `pyodide_stress.js`. Desktop shapely does NOT reproduce it.
- Clipper treats clockwise rings as holes (offset shrinks them): always `orient(..., 1.0)`.
- A 1/4" cut is a slot one *diameter* wide; spacing must count the whole slot plus `cut_gap`.
- PenguinCAM clears pockets at full depth; small end mills get `_layered_pocket` instead.
- Browsers cache `worker.js` separately; never ship a new message type without the
  version stamp (`?v=dev` placeholders replaced by `web/build.py`).
- Supabase row rules make refused UPDATE/DELETE return `[]`, not an error; `db.js` treats an
  empty result as a failure.
- Pyodide's pure wheels (typing-extensions, pyparsing, fonttools) must come from
  `loadPackage`, not micropip; `micropip` installs ezdxf from PyPI.

## Next task: professional UI redesign (requested, not started)

The user wants the web app on par with professional technical UIs, **dark theme kept, accent
`#c80000`**. Research summary and brief:

**Principles** (Material dark theme guidance and common dark-UI practice):
dark gray base, not pure black; show elevation with lighter surfaces, not shadows; restrained
accent use; WCAG AA contrast (4.5:1 text) on every surface tier; visible focus rings on every
tier; semantic color tokens. Professional CAD/CAM layouts (FreeCAD, SOLIDWORKS, PureCut CNC):
top bar + left panel (inputs/feature list) + central canvas + right panel (operations/properties),
collapsible sections for advanced settings, most-used action first, compact density.

**Measured contrast for the accent** (WCAG):
- `#c80000` on background `#0e1015`: 3.1:1, on surface `#171a21`: 2.9:1, so **not for text**.
  Use it for fills, the selected tab underline, focus rings, primary buttons, the selection outline.
- White on `#c80000`: 6.1:1, so primary buttons are white-on-accent.
- Red *text* (errors, links on dark): use the tint `#ff5a52` (6.2:1 on `#0e1015`, 5.7:1 on `#171a21`).
- Body text `#e6e8ee` (15.5:1); secondary text `#9aa0ae` (6.6:1 on `#171a21`).

**Proposed tokens:** `--bg #0e1015`, `--surface-1 #14171d`, `--surface-2 #1a1e25`,
`--surface-3 #222731`, `--border #2a2f3a`, `--border-strong #3a404c`, `--text #e6e8ee`,
`--text-2 #9aa0ae`, `--accent #c80000`, `--accent-hover #e00000`, `--accent-text #ff5a52`,
`--success #3fb950`, `--warn #d29922`, `--info #58a6ff`; spacing scale 4/8/12/16/24;
radius 6px; one font stack (system UI) with tabular numbers for measurements; 13px base
for dense panels, 15-16px headings.

**Layout brief for Make programs (desktop):** a top app bar (RosCAM name, screen tabs
Make programs / Sheets / Tools, engine status pill on the right); a left panel (parts list
with quantities, sheet picker, turning-parts option, holes table in a collapsible section);
the sheet preview as the main canvas with a floating zoom toolbar and legend; a right panel
for the result (status, nest progress with Stop / Try again, programs list with downloads,
one-part download, mark as cut, setup sheet). The simulation opens as a full-width section
or tab under the canvas. Stack to one column on phones. Sheets and Tools screens: list on
the left, inspector panel on the right (they already follow this). Keep every existing
element id or update `app.js`/`sheets.js`/`tools.js` with it; re-run `tests/browser/*`.

Sources: Material Design dark theme guidance as summarized by
https://blog.logrocket.com/ux-design/dark-mode-ui-design-best-practices-and-examples/,
https://atmos.style/blog/dark-mode-ui-best-practices,
https://www.toptal.com/designers/ui/dark-ui-design,
https://cieden.com/book/sub-atomic/shadows/colors-instead-of-shadows;
CAD layouts: https://wiki.freecad.org/Interface/en, https://purecutcnc.github.io/guide/interface.html,
https://github.com/obelisk79/DevelopersHandbook/blob/main/designguide/elements.md,
https://help.solidworks.com/2018/English/SolidWorks/acadhelp/r_User_Interface_Overview.htm.
