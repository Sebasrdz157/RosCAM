"""Assemble the static RosCAM web app into dist/.

    uv run python web/build.py          # writes dist/
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
             'sheets.js', 'tools.js', 'logo.png']
NEST_FILES = ['nest-worker.js', 'nester.js', 'clipper.js', 'geometryutil.js', 'LICENSE-SVGnest.txt']
PY_FILES = ['roscam.py', 'frc_cam_postprocessor.py', 'team_config.py', 'gcode_hygiene.py',
            'dxf_geometry.py', 'roscam_config.yaml']


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
VERSIONED = ['index.html', 'app.js', 'worker.js', os.path.join('nest', 'nest-worker.js')]


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
    stamp(dest, build_version())
    return dest


if __name__ == '__main__':
    print(f'Built {build()}')
