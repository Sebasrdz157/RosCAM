// Compare RosCAM's in-browser converter (converter.wasm via web/converter.js) with .mmg files
// made by PartsTracker's converter for the same .nc files (its /cnc/convert endpoint, or the
// harness in this folder):  node tests/converter/compare_wasm.js <dir with .nc + .mmg> ...
const fs = require('fs'), path = require('path');
const conv = require(path.join(__dirname, '../../web/converter.js'));
const wasm = fs.readFileSync(path.join(__dirname, '../../converter/target/wasm32-unknown-unknown/release/roscam_converter.wasm'));
(async () => {
  let same = 0, diff = 0;
  for (const dir of process.argv.slice(2)) for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.nc'))) {
    const out = await conv.convert(fs.readFileSync(path.join(dir, f), 'utf8'), f, { wasm });
    const native = fs.readFileSync(path.join(dir, f.replace(/\.nc$/, '.mmg')), 'utf8');
    if (out.text === native) same++; else { diff++; console.log('DIFF', f); }
    console.log(out.name, out.text.length, 'bytes, warnings:', JSON.stringify(out.report.warnings.map((w) => w.message)));
  }
  console.log(`identical: ${same}, different: ${diff}`);
})();
