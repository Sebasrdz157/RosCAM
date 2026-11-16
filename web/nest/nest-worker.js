// Runs the nesting search in the background so the page stays responsive.
// Messages in:  {type: 'start', bin, obstacles, parts, angles, timeLimitMs, patienceGenerations}
//               {type: 'stop'}
// Messages out: {type: 'progress', best, generation, evaluated, utilization}  (on every improvement)
//               {type: 'done', best, generation, evaluated, utilization, reason}
'use strict';
importScripts('clipper.js', 'geometryutil.js', 'nester.js');

let nester = null;
let running = false;
let deadline = 0;
let lastImprovedGen = 0;
let patience = 25;

function snapshot() {
  return {
    best: nester.best, generation: nester.generationCount, evaluated: nester.evaluated,
    utilization: nester.utilization(),
  };
}

function finish(reason) {
  if (!running) return;
  running = false;
  self.postMessage({ type: 'done', reason, ...snapshot() });
}

function loop() {
  if (!running) return;
  const sliceEnd = Date.now() + 40;
  try {
    while (Date.now() < sliceEnd) {
      if (nester.step()) {
        lastImprovedGen = nester.generationCount;
        self.postMessage({ type: 'progress', ...snapshot() });
      }
      if (nester.best && nester.best.unplaced.length === 0 && nester.items.length === 1) return finish('only one part');
      if (nester.generationCount - lastImprovedGen >= patience) return finish('no further improvement');
      if (Date.now() > deadline) return finish('time limit');
    }
  } catch (err) {
    running = false;
    self.postMessage({ type: 'error', message: String(err && err.message || err) });
    return;
  }
  setTimeout(loop, 0);
}

self.onmessage = (e) => {
  const msg = e.data;
  if (msg.type === 'start') {
    try {
      nester = new RosNester({ bin: msg.bin, obstacles: msg.obstacles, parts: msg.parts, angles: msg.angles });
    } catch (err) {
      self.postMessage({ type: 'error', message: String(err && err.message || err) });
      return;
    }
    running = true;
    lastImprovedGen = 0;
    patience = msg.patienceGenerations || 25;
    deadline = Date.now() + (msg.timeLimitMs || 20000);
    loop();
  } else if (msg.type === 'stop') {
    finish('stopped');
  }
};
