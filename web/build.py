"""Assemble the static RosCAM web app into dist/.

    uv run python web/build.py          # writes dist/
    python -m http.server -d dist 8000  # then open http://localhost:8000

dist/ is what gets hosted (GitHub Pages / Cloudflare Pages / any static host):
the page, its JS/CSS, and the Python sources under py/ that the browser runs.
"""
import os
import shutil

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WEB = os.path.join(ROOT, 'web')
DIST = os.path.join(ROOT, 'dist')

WEB_FILES = ['index.html', 'roscam.css', 'app.js', 'worker.js']
PY_FILES = ['roscam.py', 'frc_cam_postprocessor.py', 'team_config.py', 'gcode_hygiene.py',
            'dxf_geometry.py', 'roscam_config.yaml']


def build(dest=DIST):
    if os.path.isdir(dest):
        shutil.rmtree(dest)
    os.makedirs(os.path.join(dest, 'py'))
    for name in WEB_FILES:
        shutil.copy2(os.path.join(WEB, name), os.path.join(dest, name))
    for name in PY_FILES:
        shutil.copy2(os.path.join(ROOT, name), os.path.join(dest, 'py', name))
    return dest


if __name__ == '__main__':
    print(f'Built {build()}')
