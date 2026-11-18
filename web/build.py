"""Assemble the static RosCAM web app into dist/.

    uv run python web/build.py          # writes dist/
    uv run python web/build.py --partstracker ../PartsTracker   # copy the app into PartsTracker
    python -m http.server -d dist 8000  # then open http://localhost:8000

dist/ is what gets hosted (GitHub Pages / Cloudflare Pages / any static host):
the page, its JS/CSS, and the Python sources under py/ that the browser runs.
"""
import os
import re
import shutil
import subprocess
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WEB = os.path.join(ROOT, 'web')
DIST = os.path.join(ROOT, 'dist')

WEB_FILES = ['index.html', 'roscam.css', 'app.js', 'worker.js', 'viewer.js', 'config.js', 'db.js',
             'sheets.js', 'tools.js', 'logo.png', 'converter.js']
NEST_FILES = ['nest-worker.js', 'nester.js', 'clipper.js', 'geometryutil.js', 'LICENSE-SVGnest.txt']
PY_FILES = ['roscam.py', 'frc_cam_postprocessor.py', 'team_config.py', 'gcode_hygiene.py',
            'dxf_geometry.py', 'roscam_post.py', 'roscam_config.yaml', 'roscam_config_avid.yaml']


def build_version():
    """A different value for every publish: the git commit, plus the time for local builds."""
    try:
        sha = subprocess.run(['git', 'rev-parse', '--short', 'HEAD'], cwd=ROOT, capture_output=True,
                             text=True, check=True).stdout.strip()
    except (OSError, subprocess.CalledProcessError):
        sha = 'local'
    return f'{sha}-{int(time.time())}'


# Files that refer to other files with "?v=dev". The build swaps in the build version, so
# every publish has new URLs and a browser can never mix cached old files with new ones
# (e.g. a new app.js talking to an old worker.js).
VERSIONED = ['index.html', 'app.js', 'worker.js', 'converter.js', os.path.join('nest', 'nest-worker.js')]


CONVERTER = os.path.join(ROOT, 'converter')
WASM = os.path.join(CONVERTER, 'target', 'wasm32-unknown-unknown', 'release', 'roscam_converter.wasm')


def build_converter():
    """Compile the G-code -> .mmg converter (converter/, Rust) to WebAssembly.

    Needs Rust with the wasm target: `rustup target add wasm32-unknown-unknown`.
    """
    try:
        subprocess.run(['cargo', 'build', '--release', '--target', 'wasm32-unknown-unknown', '--quiet'],
                       cwd=CONVERTER, check=True)
    except FileNotFoundError:
        if not os.path.exists(WASM):
            raise SystemExit('Building RosCAM needs Rust (cargo) to compile the converter: install it from '
                             'https://rustup.rs, then run: rustup target add wasm32-unknown-unknown')
        print('cargo not found: using the converter built earlier')
    return WASM


def stamp(dest, version):
    for rel in VERSIONED:
        path = os.path.join(dest, rel)
        with open(path, encoding='utf-8') as fh:
            text = fh.read()
        text = re.sub(r'\?v=dev\b', f'?v={version}', text)
        with open(path, 'w', encoding='utf-8') as fh:
            fh.write(text)


def build(dest=DIST):
    if os.path.isdir(dest):
        shutil.rmtree(dest)
    os.makedirs(os.path.join(dest, 'py'))
    for name in WEB_FILES:
        shutil.copy2(os.path.join(WEB, name), os.path.join(dest, name))
    os.makedirs(os.path.join(dest, 'nest'))
    for name in NEST_FILES:
        shutil.copy2(os.path.join(WEB, 'nest', name), os.path.join(dest, 'nest', name))
    for name in PY_FILES:
        shutil.copy2(os.path.join(ROOT, name), os.path.join(dest, 'py', name))
    shutil.copy2(build_converter(), os.path.join(dest, 'converter.wasm'))
    stamp(dest, build_version())
    return dest


MIME = {'.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
        '.js': 'text/javascript; charset=utf-8', '.py': 'text/plain; charset=utf-8',
        '.yaml': 'text/plain; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
        '.png': 'image/png', '.wasm': 'application/wasm'}


def export_to_partstracker(checkout):
    """Copy the built app into a PartsTracker checkout, which serves it at /cnc/roscam/.

    Writes <checkout>/src/routes/roscam/ (the files plus a generated files.rs that embeds them
    in the PartsTracker binary). Refuses if RosCAM's copy of the converter (converter/src/gcode)
    differs from PartsTracker's src/gcode, so the two can never convert differently.
    """
    theirs = os.path.join(checkout, 'src', 'gcode')
    ours = os.path.join(CONVERTER, 'src', 'gcode')
    if not os.path.isdir(theirs):
        raise SystemExit(f'{checkout} does not look like a PartsTracker checkout (no src/gcode).')
    names = sorted(set(os.listdir(theirs)) | set(os.listdir(ours)))
    differ = [n for n in names if not (os.path.isfile(os.path.join(theirs, n)) and os.path.isfile(os.path.join(ours, n))
                                      and open(os.path.join(theirs, n), 'rb').read() == open(os.path.join(ours, n), 'rb').read())]
    if differ:
        raise SystemExit('The converter in PartsTracker changed (' + ', '.join(differ) + '). Run converter/sync.sh '
                         f'{checkout} to copy it into RosCAM, run the tests, then export again.')

    dist = build()
    version = open(os.path.join(dist, 'index.html'), encoding='utf-8').read().split('?v=')[1].split('"')[0]
    dest = os.path.join(checkout, 'src', 'routes', 'roscam')
    if os.path.isdir(dest):
        shutil.rmtree(dest)
    shutil.copytree(dist, dest)
    if os.path.exists(os.path.join(ROOT, 'LICENSE.txt')):     # MIT (PenguinCAM + RosCAM): travels with the code
        shutil.copy2(os.path.join(ROOT, 'LICENSE.txt'), os.path.join(dest, 'LICENSE-RosCAM.txt'))
    files = sorted(os.path.relpath(os.path.join(d, f), dest).replace(os.sep, '/')
                   for d, _, fs in os.walk(dest) for f in fs)
    unknown = [f for f in files if os.path.splitext(f)[1] not in MIME]
    if unknown:
        raise SystemExit(f'No content type for {unknown}: add it to MIME in web/build.py')
    rows = '\n'.join(f'    ("{f}", "{MIME[os.path.splitext(f)[1]]}", include_bytes!("{f}")),' for f in files)
    with open(os.path.join(dest, 'files.rs'), 'w', encoding='utf-8') as fh:
        fh.write(f"""// Generated by RosCAM's web/build.py --partstracker; do not edit by hand.
// The RosCAM web app (https://github.com/Sebasrdz157/RosCAM), served at /cnc/roscam/.
// To update it, run that command from a RosCAM checkout and commit the result.

/// RosCAM build these files came from; also the ETag every file is served with.
pub const VERSION: &str = "{version}";

/// (path under /cnc/roscam/, content type, bytes)
pub static FILES: &[(&str, &str, &[u8])] = &[
{rows}
];
""")
    return dest, len(files), version


if __name__ == '__main__':
    import sys
    if len(sys.argv) == 3 and sys.argv[1] == '--partstracker':
        dest, n, version = export_to_partstracker(sys.argv[2])
        print(f'Copied RosCAM {version} ({n} files) into {dest}')
    else:
        print(f'Built {build()}')
