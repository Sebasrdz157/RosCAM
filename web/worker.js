// Runs the RosCAM Python engine (roscam.py + PenguinCAM) in the browser with Pyodide.
// Lives in a Web Worker so the page stays responsive while toolpaths are computed.
// Nothing is sent to any server: the DXF goes from the page to this worker and back.

const PYODIDE_VERSION = '0.27.2';
const EZDXF_VERSION = '1.4.5';
// Python sources, copied next to this file under py/ by web/build.py.
const PY_FILES = [
  'roscam.py', 'frc_cam_postprocessor.py', 'team_config.py', 'gcode_hygiene.py',
  'dxf_geometry.py', 'roscam_config.yaml',
];

const PYODIDE_URL = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`;

let ready = null;

async function boot() {
  try {
    importScripts(`${PYODIDE_URL}pyodide.js`);
  } catch (err) {
    throw new Error('could not download the Python runtime from cdn.jsdelivr.net');
  }
  const pyodide = await loadPyodide({ indexURL: PYODIDE_URL });
  // PenguinCAM prints progress to stdout; keep the console quiet.
  pyodide.setStdout({ batched: () => {} });
  // ezdxf's dependencies all ship with Pyodide; load them from there, then ezdxf itself
  // (a pure-Python wheel) from PyPI.
  await pyodide.loadPackage(['numpy', 'shapely', 'pyyaml', 'micropip',
                             'typing-extensions', 'pyparsing', 'fonttools']);
  const micropip = pyodide.pyimport('micropip');
  await micropip.install(`ezdxf==${EZDXF_VERSION}`);

  const dir = '/home/pyodide/roscam';
  pyodide.FS.mkdirTree(dir);
  for (const name of PY_FILES) {
    const res = await fetch(`py/${name}?v=dev`, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`Could not load ${name} (${res.status})`);
    pyodide.FS.writeFile(`${dir}/${name}`, await res.text());
  }
  pyodide.runPython(`import sys; sys.path.insert(0, ${JSON.stringify(dir)}); import roscam`);
  return pyodide;
}

function toJs(proxy) {
  const value = proxy.toJs({ dict_converter: Object.fromEntries });
  proxy.destroy();
  return value;
}

self.onmessage = async (event) => {
  const { id, type, args } = event.data;
  try {
    if (!ready) ready = boot();
    let pyodide;
    try {
      pyodide = await ready;
    } catch (err) {
      ready = null; // allow a retry on the next request
      throw err;
    }
    const roscam = pyodide.pyimport('roscam');
    let result;
    if (type === 'options') {
      result = toJs(roscam.web_options());
    } else if (type === 'generate') {
      const bytes = pyodide.toPy(new Uint8Array(args.bytes));
      const overrides = pyodide.toPy(args.overrides || {});
      const sheet = args.sheet ? pyodide.toPy(args.sheet) : null;
      const placement = args.placement ? pyodide.toPy(args.placement) : null;
      result = toJs(roscam.web_generate.callKwargs(bytes, args.filename, args.material, args.thickness,
                                                   overrides, args.rotation, { sheet, placement }));
      for (const p of [bytes, overrides, sheet, placement]) if (p) p.destroy();
    } else if (type === 'part_info') {
      const bytes = pyodide.toPy(new Uint8Array(args.bytes));
      result = toJs(roscam.web_part_info(bytes, args.filename, args.material, args.thickness));
      bytes.destroy();
    } else if (type === 'nest_setup') {
      const sheet = pyodide.toPy(args.sheet);
      result = toJs(roscam.web_nest_setup(sheet));
      sheet.destroy();
    } else if (type === 'generate_sheet') {
      const files = pyodide.toPy(args.files.map((f) => ({ name: f.name, bytes: new Uint8Array(f.bytes) })));
      const sheet = pyodide.toPy(args.sheet);
      const placements = pyodide.toPy(args.placements);
      const overrides = pyodide.toPy(args.overrides || {});
      const unplaced = pyodide.toPy(args.unplaced || []);
      result = toJs(roscam.web_generate_sheet.callKwargs(files, args.material, args.thickness, sheet, placements,
                                                         overrides, unplaced, { job_name: args.jobName || null }));
      for (const p of [files, sheet, placements, overrides, unplaced]) p.destroy();
    } else {
      throw new Error(`Unknown request ${type}`);
    }
    self.postMessage({ id, ok: true, result });
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err && err.message || err) });
  }
};
