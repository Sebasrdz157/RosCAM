// Reproduce the browser's GEOS crash with the same Pyodide build, in node.
const path = require('path'), fs = require('fs');
const S = process.argv[2] || __dirname;   // the setup folder from tests/browser/README.md
const DIR = path.join(S, 'pyodide', 'pyodide');
const { loadPyodide } = require(path.join(DIR, 'pyodide.js'));

(async () => {
  const py = await loadPyodide({ indexURL: DIR + '/' });
  await py.loadPackage(['numpy', 'shapely', 'pyclipper', 'pyyaml', 'micropip', 'typing-extensions', 'pyparsing', 'fonttools']);
  py.FS.writeFile('/tmp/ezdxf-1.4.5-py3-none-any.whl', fs.readFileSync(path.join(S, 'pyodide', 'wheels', 'ezdxf-1.4.5-py3-none-any.whl')));
  await py.pyimport('micropip').install('emfs:/tmp/ezdxf-1.4.5-py3-none-any.whl');
  py.FS.mkdirTree('/w');
  for (const f of ['roscam.py', 'frc_cam_postprocessor.py', 'team_config.py', 'gcode_hygiene.py', 'dxf_geometry.py', 'roscam_config.yaml']) {
    py.FS.writeFile('/w/' + f, fs.readFileSync(path.join(require('path').resolve(__dirname, '../..'), f), 'utf8'));
  }
  py.FS.writeFile('/w/rack.dxf', fs.readFileSync(path.join(S, 'parts', 'rack.dxf')));
  py.setStdout({ batched: () => {} });
  py.setStderr({ batched: (s) => process.stderr.write(s + '\n') });
  try {
    py.runPython(`
import sys, io, contextlib, traceback
sys.path.insert(0, '/w')
import shapely, shapely.geometry.base as base
# Log every geometry operation before it runs, so a fatal crash shows which one did it.
def wrap(owner, name):
    orig = getattr(owner, name)
    def f(*a, **k):
        g = a[0] if a else None
        n = len(getattr(getattr(g, 'exterior', None), 'coords', [])) if g is not None else 0
        if name == 'buffer' and g is not None and not g.is_empty and abs(g.bounds[0] - 0.703) < 0.002 and a[1:2] == (0.125,):
            print('WKT ' + shapely.to_wkt(g, rounding_precision=12), file=sys.stderr, flush=True)
        print(f'OP {name} bounds={tuple(round(v, 3) for v in g.bounds) if g is not None and not g.is_empty else None} pts={n} args={[x for x in a[1:] if isinstance(x, (int, float))]}', file=sys.stderr, flush=True)
        return orig(*a, **k)
    setattr(owner, name, f)
pass
import roscam
lib = [dict(id='endmill_1_8', name='1/8 end mill', type='endmill', diameter=0.125, flute_length=0.5,
            spindle_speed=18000, feed_rate=40, plunge_rate=5, ramp_feed_rate=15, stepdown=0.02)]
cfg, _ = roscam.config_with_tools(lib)
import random
random.seed(5)
ok = 0
cases = [(rot, round(random.uniform(0.6, 16), 4), round(random.uniform(0.6, 40), 4)) for rot in (0, 90, 180, 270) for _ in range(6)]
for rot, x, y in cases:
    if rot in (90,):
        x += 1.5
    if rot in (180,):
        x += 6.2; y += 1.4
    if rot == 270:
        y += 6.2
    with contextlib.redirect_stdout(io.StringIO()):
        res = roscam.generate_sheet_job([roscam.PartFile('/w/rack.dxf', 'rack')],
            [dict(part=0, x=x, y=y, rotation=rot)], 'aluminum', '1/4', roscam.Sheet('A', 24, 48), cfg)
    ok += res.success
    if not res.success:
        print('NOT OK', rot, x, y, res.errors[:1], file=sys.stderr)
print('RESULT', ok, 'of', len(cases), 'layouts made programs', file=sys.stderr)
`);
  } catch (e) {
    console.error('JS caught:', String(e).slice(0, 300));
  }
})();
