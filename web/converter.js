// The PartsTracker G-code -> Richauto (.mmg) converter, running in the browser.
// converter.wasm is built from converter/ (a verbatim copy of PartsTracker's src/gcode/), so
// a file converted here is byte-for-byte what the PartsTracker /cnc page gives back.
// Exposes window.RosConvert (also works under node for the tests: module.exports).
'use strict';

(function (root) {
  let ready = null;

  function load(source) {
    // source: a URL (browser) or the wasm bytes (node tests)
    if (!ready) {
      ready = (async () => {
        const bytes = typeof source === 'string' ? await (await fetch(source)).arrayBuffer() : source;
        const { instance } = await WebAssembly.instantiate(bytes, {});
        return instance.exports;
      })();
      ready.catch(() => { ready = null; });      // let a later call try again
    }
    return ready;
  }

  // -> { name, text, report } like POST /cnc/convert with Accept: application/json,
  //    or throws with the converter's error message.
  async function convert(gcode, fileName, { stripComments = false, wasm } = {}) {
    const x = await load(wasm || root.ROSCAM_CONVERTER_URL || 'converter.wasm?v=dev');
    const enc = new TextEncoder();
    const src = enc.encode(gcode), name = enc.encode(fileName);
    const sp = x.alloc(src.length), np = x.alloc(name.length);
    try {
      new Uint8Array(x.memory.buffer, sp, src.length).set(src);
      new Uint8Array(x.memory.buffer, np, name.length).set(name);
      x.convert(sp, src.length, np, name.length, stripComments ? 1 : 0);
      const out = new Uint8Array(x.memory.buffer, x.result_ptr(), x.result_len());
      const answer = JSON.parse(new TextDecoder().decode(out));
      if (answer.error) throw new Error(answer.error);
      return answer;
    } finally {
      x.dealloc(sp, src.length);
      x.dealloc(np, name.length);
    }
  }

  const api = { convert, load };
  root.RosConvert = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
