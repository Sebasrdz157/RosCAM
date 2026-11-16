// RosCAM page logic: parts list, nesting on a sheet, hole overrides, preview, downloads.
// CAM work happens in worker.js (Python in the browser); nesting in nest/nest-worker.js.
'use strict';

const COLORS = ['#58a6ff', '#f0645b', '#d29922', '#a371f7', '#3fb950'];
const ENDMILL_COLOR = '#e8eaf0';
const PART_FILL = 'rgba(88,166,255,.22)';
const MILL = 'mill';
const NEST_TIME_LIMIT_MS = 20000;

const $ = (id) => document.getElementById(id);
const els = {
  engine: $('engine'), engineText: $('engine-text'), drop: $('drop'), file: $('file'),
  dropTitle: $('drop-title'), dropSub: $('drop-sub'),
  stock: $('stock'), rotation: $('rotation'), noSheets: $('no-sheets'), goSheets: $('go-sheets'),
  partsWrap: $('parts-wrap'), partsList: $('parts-list'),
  nestBar: $('nest-bar'), nestStatus: $('nest-status'), nestStop: $('nest-stop'), nestAgain: $('nest-again'),
  result: $('result'), status: $('status'), errors: $('errors'), warnings: $('warnings'),
  holesWrap: $('holes-wrap'), holes: $('holes'), previewWrap: $('preview-wrap'), legend: $('legend'),
  preview: $('preview'), stockNote: $('stock-note'), programsWrap: $('programs-wrap'),
  programs: $('programs'), zip: $('zip'), sheetWrap: $('sheet-wrap'), sheet: $('sheet'),
  simWrap: $('sim-wrap'), simProgram: $('sim-program'), simPlay: $('sim-play'), simRestart: $('sim-restart'),
  simSpeed: $('sim-speed'), simReset: $('sim-reset'), simStage: $('sim-stage'), simCanvas: $('sim-canvas'),
  simFallback: $('sim-fallback'), simScrubber: $('sim-scrubber'), simLabel: $('sim-label'), simOp: $('sim-op'),
  cutActions: $('cut-actions'), markCut: $('mark-cut'), cutMsg: $('cut-msg'),
};

const state = {
  options: null,
  parts: [],            // {id, name, bytes, quantity, info, infoKey}
  nextPartId: 1,
  overrides: {},        // hole size -> tool, for every part on the sheet
  layout: null,         // best nesting result so far: {placements, unplaced, top}
  nestRun: 0,           // id of the nesting search the page is listening to
  nesting: false,
  result: null,         // programs for the current layout
  job: 0,               // bumps whenever the inputs change, so stale work is ignored
  markedFor: null,      // the result already recorded as cut (prevents double-recording)
};

// ---- CAM worker (Python) ---------------------------------------------------------
const worker = new Worker('worker.js');
let nextId = 1;
const pending = new Map();
worker.onmessage = (e) => {
  const { id, ok, result, error } = e.data;
  const p = pending.get(id);
  if (!p) return;
  pending.delete(id);
  ok ? p.resolve(result) : p.reject(new Error(error));
};
// If the worker itself dies (e.g. the Pyodide CDN is unreachable), fail every waiting
// request instead of leaving the page spinning forever.
worker.onerror = (e) => {
  e.preventDefault();
  const msg = e.message || 'the CAM engine stopped unexpectedly';
  for (const p of pending.values()) p.reject(new Error(msg));
  pending.clear();
};
function call(type, args) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    worker.postMessage({ id, type, args });
  });
}

// ---- nesting worker (adapted from SVGnest) ------------------------------------------
const nestWorker = new Worker('nest/nest-worker.js');
nestWorker.onmessage = (e) => {
  let m = e.data;
  if (m.run !== state.nestRun) return;            // an older search
  if (m.type === 'error') {
    state.nesting = false;
    showOnlyError(`Arranging the parts failed: ${m.message}`);
    return;
  }
  state.layout = m.best;
  if (m.type === 'done' && state.prevBest && m.best && state.prevBest.fitness <= m.best.fitness) {
    state.layout = state.prevBest;          // the retry didn't beat the earlier layout: keep that one
    m = { ...m, best: state.prevBest, kept: true };
  }
  showNestProgress(m);
  if (m.type === 'done') {
    state.nesting = false;
    state.prevBest = null;
    generatePrograms();
  } else {
    drawPreview(null);
  }
};
nestWorker.onerror = (e) => {
  e.preventDefault();
  state.nesting = false;
  showOnlyError('The nesting engine could not start. Reload the page to try again.');
};

// ---- startup --------------------------------------------------------------------
call('options').then((opts) => {
  state.options = opts;
  RosSheets.init(opts);
  RosSheets.onChange(() => { fillStock(); refreshCutButton(); });
  restoreChoices();
  els.rotation.disabled = false;
  els.engine.classList.add('ready');
  els.engineText.textContent = 'CAM engine ready. Files stay on this computer.';
  refresh();
}).catch((err) => {
  els.engine.classList.add('failed');
  els.engineText.textContent = `The CAM engine failed to load: ${err.message}. Check your internet connection and reload.`;
});

function restoreChoices() {
  try {
    const saved = JSON.parse(localStorage.getItem('roscam.choices') || '{}');
    if (saved.rotation) els.rotation.value = saved.rotation;
    state.savedSheet = saved.sheet || '';
  } catch (_) { /* storage unavailable: defaults are fine */ }
}
function saveChoices() {
  try {
    localStorage.setItem('roscam.choices', JSON.stringify({ rotation: els.rotation.value, sheet: els.stock.value }));
  } catch (_) { /* ignore */ }
}

els.stock.addEventListener('change', () => { saveChoices(); state.markedFor = null; refresh(); });
els.rotation.addEventListener('change', () => { saveChoices(); refresh(); });
els.goSheets.addEventListener('click', () => document.querySelector('.view-tab[data-view="sheets"]').click());

// ---- screens --------------------------------------------------------------------
document.querySelectorAll('.view-tab').forEach((tab) => tab.addEventListener('click', () => {
  document.querySelectorAll('.view-tab').forEach((t) => t.setAttribute('aria-pressed', String(t === tab)));
  for (const v of ['programs', 'sheets']) $(`view-${v}`).classList.toggle('hidden', v !== tab.dataset.view);
  if (tab.dataset.view === 'sheets') RosSheets.redraw();
  else if (state.result || state.layout) drawPreview(state.result);
}));

// ---- sheet choice ---------------------------------------------------------------
function materialName(id) {
  const m = state.options && state.options.materials.find((x) => x.id === id);
  return m ? m.name : id;
}

function fillStock() {
  const prev = els.stock.value || state.savedSheet || '';
  const sheets = RosSheets.sheets().filter((s) => s.status === 'active');
  els.stock.replaceChildren(...sheets.map((s) => new Option(
    `${s.id}: ${materialName(s.material)} ${s.thickness}", ${Math.round(RosSheets.freeFraction(s) * 100)}% free`, s.id)));
  els.noSheets.classList.toggle('hidden', sheets.length > 0);
  els.stock.disabled = sheets.length === 0;
  const keep = sheets.some((s) => s.id === prev);
  els.stock.value = keep ? prev : (sheets[0] ? sheets[0].id : '');
  state.savedSheet = '';
  if (!state.layout && !state.nesting) refresh();
  else if (!keep && prev) refresh();      // the chosen sheet is gone
}

function currentSheet() {
  const s = els.stock.value ? RosSheets.get(els.stock.value) : null;
  if (!s) return null;
  return { id: s.id, width: Number(s.width), height: Number(s.height), material: s.material,
           thickness: s.thickness, regions: (s.sheet_regions || []).map((r) => r.polygon) };
}

// ---- parts ------------------------------------------------------------------------
els.file.addEventListener('change', () => { addFiles(els.file.files); els.file.value = ''; });
els.drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); els.file.click(); } });
for (const ev of ['dragenter', 'dragover']) {
  els.drop.addEventListener(ev, (e) => { e.preventDefault(); els.drop.classList.add('over'); });
}
for (const ev of ['dragleave', 'drop']) {
  els.drop.addEventListener(ev, (e) => { e.preventDefault(); els.drop.classList.remove('over'); });
}
els.drop.addEventListener('drop', (e) => addFiles(e.dataTransfer.files));

async function addFiles(fileList) {
  const files = [...fileList];
  const bad = files.filter((f) => !/\.dxf$/i.test(f.name));
  for (const f of files.filter((f) => /\.dxf$/i.test(f.name))) {
    let name = f.name.replace(/\.dxf$/i, '').replace(/[/\\:*?"<>|]+/g, '-').trim() || 'part';
    const base = name;
    for (let n = 2; state.parts.some((p) => p.name === name); n++) name = `${base}-${n}`;
    state.parts.push({ id: state.nextPartId++, name, bytes: await f.arrayBuffer(), quantity: 1, info: null, infoKey: '' });
  }
  els.dropTitle.textContent = state.parts.length ? `${state.parts.length} part${state.parts.length === 1 ? '' : 's'} added` : 'Drop DXF files here';
  els.dropSub.textContent = state.parts.length ? 'Drop more DXFs to add them' : 'one file per part, or click to choose them';
  if (bad.length) {
    els.result.classList.remove('hidden');
    fillList(els.warnings, bad.map((f) => `${f.name} isn't a DXF, so it was skipped. Export the part's top face from Onshape as DXF.`));
  }
  refresh();
}

function renderParts() {
  els.partsWrap.classList.toggle('hidden', state.parts.length === 0);
  els.partsList.replaceChildren(...state.parts.map((p) => {
    const tr = document.createElement('tr');
    const name = Object.assign(document.createElement('td'), { className: 'name', textContent: p.name });
    if (p.info && p.info.errors.length) {
      for (const e of p.info.errors) name.append(Object.assign(document.createElement('span'), { className: 'part-err', textContent: e }));
    }
    const size = document.createElement('td');
    if (p.info && p.info.width) size.textContent = `${p.info.width.toFixed(2)}" x ${p.info.height.toFixed(2)}"`;
    else size.append(Object.assign(document.createElement('span'), { className: 'part-busy', textContent: 'reading...' }));
    const qtyCell = document.createElement('td');
    const qty = Object.assign(document.createElement('input'), {
      type: 'number', min: '0', max: '200', step: '1', value: String(p.quantity), className: 'qty',
    });
    qty.setAttribute('aria-label', `How many ${p.name}`);
    qty.addEventListener('change', () => {
      const v = Math.max(0, Math.min(200, Math.round(Number(qty.value) || 0)));
      qty.value = String(v);
      if (v !== p.quantity) { p.quantity = v; refresh(); }
    });
    qtyCell.append(qty);
    const rm = Object.assign(document.createElement('button'), { type: 'button', className: 'btn small', textContent: 'Remove' });
    rm.addEventListener('click', () => { state.parts = state.parts.filter((x) => x !== p); refresh(); });
    const rmCell = document.createElement('td');
    rmCell.append(rm);
    tr.append(name, size, qtyCell, rmCell);
    return tr;
  }));
}

// ---- main flow: read parts -> arrange on the sheet -> make programs -----------------
let refreshTimer = null;
function refresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(doRefresh, 250);
}

function stopNesting() {
  state.nestRun++;                      // ignore anything the old search still sends
  if (state.nesting) nestWorker.postMessage({ type: 'stop' });
  state.nesting = false;
}

async function doRefresh() {
  const job = ++state.job;
  stopNesting();
  state.layout = null;
  state.prevBest = null;
  state.result = null;
  state.markedFor = null;
  renderParts();
  if (!state.options) return;
  const sheet = currentSheet();
  const active = state.parts.filter((p) => p.quantity > 0);
  if (!state.parts.length || !sheet) {
    hideResults();
    if (state.parts.length && !sheet) showOnlyError('Pick a sheet to put the parts on (add one on the Sheets screen).');
    return;
  }
  const material = sheet.material, thickness = sheet.thickness;
  const mat = state.options.materials.find((m) => m.id === material);
  if (!mat || !mat.thicknesses.includes(thickness)) {
    showOnlyError(`Sheet ${sheet.id} is ${materialName(material)} ${thickness}", which isn't set up in roscam_config.yaml.`);
    return;
  }

  els.result.classList.remove('hidden');
  setStatus('busy', 'Reading parts...');
  hideOutputs();
  const key = `${material}|${thickness}`;
  try {
    for (const p of state.parts) {
      if (p.infoKey !== key) {
        p.info = await call('part_info', { bytes: p.bytes.slice(0), filename: `${p.name}.dxf`, material, thickness });
        p.infoKey = key;
        if (job !== state.job) return;
        renderParts();
      }
    }
  } catch (err) {
    if (job === state.job) showOnlyError(`Could not read a part: ${err.message}`);
    return;
  }
  const problems = state.parts.flatMap((p) => p.info.errors);
  fillList(els.warnings, state.parts.flatMap((p) => p.info.warnings));
  renderHoles(combinedHoles());
  if (problems.length) {
    setStatus('err', 'Fix the parts below before they can be arranged.');
    fillList(els.errors, problems);
    return;
  }
  if (!active.length) {
    setStatus('err', 'Every part is set to 0. Set how many you need.');
    fillList(els.errors, []);
    return;
  }
  fillList(els.errors, []);

  let setup;
  try {
    setup = await call('nest_setup', { sheet });
  } catch (err) {
    if (job === state.job) showOnlyError(`Could not prepare sheet ${sheet.id}: ${err.message}`);
    return;
  }
  if (job !== state.job) return;
  startNesting(setup);
}

function startNesting(setup) {
  state.nestRun++;
  state.nesting = true;
  state.layout = null;
  state.setup = setup;
  setStatus('busy', `Arranging parts on sheet ${els.stock.value}...`);
  els.nestBar.classList.remove('hidden');
  els.nestStop.classList.remove('hidden');
  els.nestAgain.classList.add('hidden');
  els.nestStatus.textContent = 'Trying layouts...';
  nestWorker.postMessage({
    type: 'start', run: state.nestRun, bin: setup.bin, obstacles: setup.obstacles,
    parts: state.parts.map((p) => ({ shape: p.info.nest_shape, quantity: p.quantity })),
    angles: els.rotation.value === 'none' ? [0] : [0, 90, 180, 270],
    timeLimitMs: NEST_TIME_LIMIT_MS, patienceGenerations: 25,
  });
}

function unplacedNames(layout) {
  const counts = {};
  for (const src of layout.unplaced || []) counts[src] = (counts[src] || 0) + 1;
  return Object.entries(counts).map(([src, n]) => `${state.parts[src].name}${n > 1 ? ` x${n}` : ''}`);
}

function showNestProgress(m) {
  const best = m.best;
  if (!best) return;
  const total = best.placements.length + best.unplaced.length;
  const fit = best.unplaced.length ? `${best.placements.length} of ${total} parts fit` : `all ${total} parts fit`;
  const top = best.top !== null ? `, using the bottom ${best.top.toFixed(1)}" of the sheet` : '';
  const prefix = m.type === 'done' ? `Done after ${m.evaluated} layouts` : `Tried ${m.evaluated} layouts`;
  els.nestStatus.textContent = `${prefix}: ${fit}${top}.`
    + (m.kept ? ' The earlier layout was better, so it was kept.' : '');
  if (m.type === 'done') {
    els.nestStop.classList.add('hidden');
    els.nestAgain.classList.remove('hidden');
  }
}

els.nestStop.addEventListener('click', () => { if (state.nesting) nestWorker.postMessage({ type: 'stop' }); });
els.nestAgain.addEventListener('click', () => {
  if (!state.setup || state.nesting) return;
  state.prevBest = state.layout;            // a new search only replaces this if it does better
  startNesting(state.setup);
});

async function generatePrograms() {
  const layout = state.layout;
  const sheet = currentSheet();
  if (!layout || !sheet) return;
  const job = state.job, run = state.nestRun;
  if (!layout.placements.length) {
    showOnlyError(`None of the parts fit on sheet ${sheet.id}. Try another sheet.`);
    return;
  }
  setStatus('busy', 'Making programs...');
  try {
    const res = await call('generate_sheet', {
      files: state.parts.map((p) => ({ name: p.name, bytes: p.bytes.slice(0) })),
      material: sheet.material, thickness: sheet.thickness, sheet,
      placements: layout.placements.map((p) => ({ part: p.part, x: p.x, y: p.y, rotation: p.rotation })),
      overrides: state.overrides, unplaced: unplacedNames(layout),
    });
    if (job !== state.job || run !== state.nestRun) return;
    state.result = res;
    render(res);
  } catch (err) {
    if (job === state.job) showOnlyError(`Something went wrong: ${err.message}`);
  }
}

function setStatus(kind, text) {
  els.status.className = `status ${kind}`;
  els.status.textContent = text;
}

function hideOutputs() {
  for (const el of [els.programsWrap, els.sheetWrap, els.simWrap, els.cutActions]) el.classList.add('hidden');
}
function hideResults() {
  els.result.classList.add('hidden');
  els.nestBar.classList.add('hidden');
  hideOutputs();
}

function showOnlyError(message) {
  stopNesting();
  els.result.classList.remove('hidden');
  els.nestBar.classList.add('hidden');
  setStatus('err', 'Could not make programs');
  fillList(els.errors, [message]);
  for (const el of [els.holesWrap, els.previewWrap]) el.classList.add('hidden');
  hideOutputs();
}

function fillList(ul, items) {
  ul.replaceChildren(...items.map((t) => Object.assign(document.createElement('li'), { textContent: t })));
}

// Hole sizes across every part (times how many of each), for the table before programs exist.
function combinedHoles() {
  const byKey = {};
  for (const p of state.parts) {
    if (!p.info) continue;
    for (const g of p.info.hole_groups) {
      const tool = state.overrides[g.key] || g.auto_tool;
      const e = byKey[g.key] || (byKey[g.key] = { ...g, count: 0, tool, auto_tool: g.auto_tool });
      e.count += g.count * p.quantity;
    }
  }
  return Object.values(byKey).filter((g) => g.count > 0).sort((a, b) => a.diameter - b.diameter);
}

function render(res) {
  const n = res.programs.length;
  if (res.success) {
    const copies = res.parts.length;
    setStatus('ok', `${n} program${n === 1 ? '' : 's'} ready: ${copies} part${copies === 1 ? '' : 's'} on sheet ${res.sheet_id}`);
  } else {
    setStatus('err', 'Could not make programs. Fix the problems below.');
  }
  fillList(els.errors, res.errors);
  const warnings = res.unplaced && res.unplaced.length
    ? [`Did not fit on sheet ${res.sheet_id}: ${res.unplaced.join(', ')}. Cut them on another sheet.`, ...res.warnings]
    : res.warnings;
  fillList(els.warnings, warnings);
  renderHoles(res.hole_groups);
  els.programsWrap.classList.toggle('hidden', !res.success);
  els.sheetWrap.classList.toggle('hidden', !res.success);
  els.simWrap.classList.toggle('hidden', !res.success);
  drawPreview(res);
  els.stockNote.textContent = `Sheet ${res.sheet_id}: zero X0 Y0 at the lower-left corner of the sheet and Z0 on top.`;
  refreshCutButton();
  if (res.success) {
    renderPrograms(res.programs);
    renderSimulation(res);
    els.sheet.textContent = res.setup_sheet;
  }
}

// ---- mark as cut ------------------------------------------------------------------
function refreshCutButton() {
  const res = state.result;
  const show = !!(res && res.success && res.sheet_id);
  els.cutActions.classList.toggle('hidden', !show);
  if (!show) return;
  const done = state.markedFor === res;
  els.markCut.textContent = done ? `Recorded on ${res.sheet_id}` : `Mark as cut on ${res.sheet_id}`;
  els.markCut.disabled = done || !RosSheets.canEdit();
  if (!done) els.cutMsg.textContent = RosSheets.canEdit() ? 'Do this after the job has run.' : 'Sign in on the Sheets screen to record cuts.';
}
RosDB.onAuthChange(refreshCutButton);

els.markCut.addEventListener('click', async () => {
  const res = state.result;
  if (!res || !res.sheet_id || state.markedFor === res) return;
  const n = res.parts.length;
  if (!confirm(`Record ${n} part${n === 1 ? '' : 's'} as cut on sheet ${res.sheet_id}? Those areas will be off limits from now on.`)) return;
  els.markCut.disabled = true;
  let saved = 0;
  try {
    for (const p of res.parts) {
      await RosDB.addRegion({ sheet_id: res.sheet_id, kind: 'cut', label: p.label, polygon: p.cut_region });
      saved++;
    }
    state.markedFor = res;
    els.cutMsg.textContent = `Saved. ${res.sheet_id} now shows ${n === 1 ? 'this part' : `these ${n} parts`} as used.`;
  } catch (err) {
    els.cutMsg.textContent = `${err.message}${saved ? ` (${saved} of ${n} were saved before this.)` : ''}`;
  }
  await RosSheets.reload();
  drawPreview(res);
  refreshCutButton();
});

// ---- hole table -----------------------------------------------------------------
function toolLabel(id) {
  if (id === MILL) return `Mill with the ${state.options.endmill.name}`;
  const d = state.options.drills.find((x) => x.id === id);
  return d ? d.name : 'Cannot be made';
}

function renderHoles(groups) {
  els.holesWrap.classList.toggle('hidden', groups.length === 0);
  const rows = groups.map((g) => {
    const tr = document.createElement('tr');
    const size = document.createElement('td');
    size.textContent = `${g.diameter.toFixed(4)}"`;
    const count = document.createElement('td');
    count.textContent = g.count;
    const how = document.createElement('td');
    const sel = document.createElement('select');
    sel.setAttribute('aria-label', `Tool for ${g.diameter.toFixed(4)} inch holes`);
    const choices = [...state.options.drills.map((d) => d.id)];
    if (g.diameter >= state.options.endmill.diameter - 0.002) choices.push(MILL);
    if (!g.tool) sel.add(new Option('Cannot be made - pick a tool', ''));
    for (const id of choices) {
      const auto = id === g.auto_tool ? ' (auto)' : '';
      sel.add(new Option(toolLabel(id) + auto, id));
    }
    sel.value = g.tool || '';
    sel.addEventListener('change', () => {
      if (sel.value === g.auto_tool || !sel.value) delete state.overrides[g.key];
      else state.overrides[g.key] = sel.value;
      if (state.layout && !state.nesting) generatePrograms();   // same layout, new tools
      else renderHoles(combinedHoles());
    });
    how.append(sel);
    if (g.tool && g.tool !== g.auto_tool) {
      how.append(Object.assign(document.createElement('span'), { className: 'changed', textContent: 'changed' }));
    }
    if (!g.tool) size.classList.add('bad');
    tr.append(size, count, how);
    return tr;
  });
  els.holes.replaceChildren(...rows);
}

// ---- programs + downloads -------------------------------------------------------
function programColor(p, i) {
  return p.tool_type === 'drill' ? COLORS[i % COLORS.length] : ENDMILL_COLOR;
}

function renderPrograms(programs) {
  els.programs.replaceChildren(...programs.map((p, i) => {
    const li = document.createElement('li');
    li.style.setProperty('--swatch', programColor(p, i));
    const num = Object.assign(document.createElement('span'), { className: 'num', textContent: p.index });
    const file = Object.assign(document.createElement('span'), { className: 'file', textContent: p.filename });
    const meta = Object.assign(document.createElement('span'), {
      className: 'meta', textContent: `${p.tool_name}, ${p.spindle_speed} RPM: ${p.features}`,
    });
    const btn = Object.assign(document.createElement('button'), { className: 'btn', type: 'button', textContent: 'Download' });
    btn.addEventListener('click', () => download(new Blob([p.gcode], { type: 'text/plain' }), p.filename));
    li.append(num, file, btn, meta);
    return li;
  }));
}

els.zip.addEventListener('click', () => {
  const res = state.result;
  if (!res || !res.zip_base64) return;
  const raw = atob(res.zip_base64);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  download(new Blob([bytes], { type: 'application/zip' }), res.zip_name);
});

function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---- preview --------------------------------------------------------------------
// A small G-code reader: enough for RosCAM's own output (G0/G1/G2/G3, absolute XY, IJ arcs).
function parseMoves(gcode) {
  const moves = [];
  let x = 0, y = 0, z = 1, motion = 0;
  for (const raw of gcode.split('\n')) {
    const code = raw.replace(/\(.*?\)/g, '').split(';')[0].toUpperCase();
    if (!code.trim()) continue;
    const words = {};
    for (const [, k, v] of code.matchAll(/([A-Z])\s*([-+]?(?:\d+\.?\d*|\.\d+))/g)) {
      if (k === 'G') { const g = Number(v); if ([0, 1, 2, 3].includes(g)) motion = g; } else words[k] = Number(v);
    }
    if (!('X' in words || 'Y' in words || 'Z' in words)) continue;
    const nx = words.X ?? x, ny = words.Y ?? y, nz = words.Z ?? z;
    moves.push({ motion, x, y, z, nx, ny, nz, i: words.I, j: words.J });
    x = nx; y = ny; z = nz;
  }
  return moves;
}

// The sheet, its used areas, and the parts: the nesting layout while it is being searched
// (res is null), then the programs' toolpaths once they exist.
function placedOutline(part, pl) {
  const c = Math.cos(pl.rotation * Math.PI / 180), s = Math.sin(pl.rotation * Math.PI / 180);
  return part.info.outline.map(([x, y]) => [x * c - y * s + pl.x, x * s + y * c + pl.y]);
}

function drawPreview(res) {
  const sheetData = currentSheet();
  if (!sheetData && !res) return;
  els.previewWrap.classList.remove('hidden');
  const canvas = els.preview;
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth || 800;
  const [sx, sy] = res ? res.stock_size : [sheetData.width, sheetData.height];
  const cssH = Math.max(220, Math.min(cssW * (sy / sx), 640));
  canvas.style.aspectRatio = 'auto';
  canvas.style.height = `${cssH}px`;
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);

  const pad = 16;
  const scale = Math.min((cssW - 2 * pad) / sx, (cssH - 2 * pad) / sy);
  const ox = (cssW - sx * scale) / 2, oy = (cssH + sy * scale) / 2;
  const P = (px, py) => [ox + px * scale, oy - py * scale];
  const poly = (pts) => {
    ctx.beginPath();
    pts.forEach(([x, y], i) => (i ? ctx.lineTo(...P(x, y)) : ctx.moveTo(...P(x, y))));
    ctx.closePath();
  };

  // Sheet and its used areas
  const sheet = RosSheets.get(res ? res.sheet_id : sheetData.id);
  ctx.fillStyle = '#1a1d23';
  ctx.fillRect(ox, oy - sy * scale, sx * scale, sy * scale);
  for (const r of (sheet && sheet.sheet_regions) || []) {
    poly(r.polygon);
    ctx.fillStyle = r.kind === 'cut' ? 'rgba(240,100,91,.28)' : 'rgba(139,143,168,.35)';
    ctx.fill();
  }
  ctx.strokeStyle = '#8b8fa8';
  ctx.lineWidth = 1;
  ctx.strokeRect(ox, oy - sy * scale, sx * scale, sy * scale);
  ctx.fillStyle = '#8b8fa8';
  ctx.beginPath(); ctx.arc(...P(0, 0), 3, 0, Math.PI * 2); ctx.fill();

  // Parts: from the programs if they exist, else from the layout being searched
  const outlines = res && res.parts && res.parts.length
    ? res.parts.map((p) => p.outline)
    : (state.layout ? state.layout.placements.map((pl) => placedOutline(state.parts[pl.part], pl)) : []);
  for (const o of outlines) {
    poly(o);
    ctx.fillStyle = PART_FILL;
    ctx.fill();
    ctx.strokeStyle = 'rgba(88,166,255,.8)';
    ctx.stroke();
  }

  const legend = [];
  for (const [idx, p] of ((res && res.success) ? res.programs : []).entries()) {
    const color = programColor(p, idx);
    legend.push(`<span style="--swatch:${color}">${idx + 1}. ${escapeHtml(p.tool_name)}</span>`);
    const moves = parseMoves(p.gcode);
    if (p.tool_type === 'drill') {
      ctx.strokeStyle = color; ctx.lineWidth = 2;
      const seen = new Set();
      for (const m of moves) {
        if (m.nz < 0 && m.nx === m.x && m.ny === m.y) {
          const key = `${m.nx.toFixed(3)},${m.ny.toFixed(3)}`;
          if (seen.has(key)) continue;
          seen.add(key);
          ctx.beginPath();
          ctx.arc(...P(m.nx, m.ny), Math.max(2, (p.tool_diameter / 2) * scale), 0, Math.PI * 2);
          ctx.stroke();
        }
      }
      continue;
    }
    ctx.strokeStyle = color; ctx.lineWidth = 1.2;
    ctx.beginPath();
    for (const m of moves) {
      const cutting = Math.min(m.z, m.nz) < 0 && m.motion !== 0;
      if (!cutting) continue;
      if ((m.motion === 2 || m.motion === 3) && (m.i !== undefined || m.j !== undefined)) {
        const cx = m.x + (m.i || 0), cy = m.y + (m.j || 0);
        const r = Math.hypot(m.x - cx, m.y - cy);
        const a0 = Math.atan2(m.y - cy, m.x - cx);
        let a1 = Math.atan2(m.ny - cy, m.nx - cx);
        const ccw = m.motion === 3;
        if (Math.abs(m.nx - m.x) < 1e-9 && Math.abs(m.ny - m.y) < 1e-9) a1 = a0 + (ccw ? 2 * Math.PI : -2 * Math.PI);
        const [pcx, pcy] = P(cx, cy);
        ctx.moveTo(...P(m.x, m.y));
        // canvas y is flipped, so a CCW arc in G-code is clockwise on screen
        ctx.arc(pcx, pcy, r * scale, -a0, -a1, ccw);
      } else {
        ctx.moveTo(...P(m.x, m.y));
        ctx.lineTo(...P(m.nx, m.ny));
      }
    }
    ctx.stroke();
  }
  els.legend.innerHTML = legend.join('');
  if (!res) els.stockNote.textContent = `Sheet ${sheetData.id}: blue shapes are the parts as arranged so far.`;
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

window.addEventListener('resize', () => { if (state.result || state.layout) drawPreview(state.result); });

// ---- 3D simulation (viewer.js, adapted from PenguinCAM) ---------------------------
let viewer = null;

function ensureViewer() {
  if (viewer) return viewer;
  const why = !window.THREE || !window.THREE.OrbitControls || !window.GcodeViewer
    ? 'The 3D viewer could not load (it needs cdnjs.cloudflare.com and cdn.jsdelivr.net).'
    : null;
  if (why) return simUnavailable(why);
  try {
    viewer = new GcodeViewer({
      canvas: els.simCanvas, container: els.simStage, scrubber: els.simScrubber,
      scrubberLabel: els.simLabel, scrubberOp: els.simOp, playButton: els.simPlay,
      restartButton: els.simRestart, speedSelect: els.simSpeed, resetButton: els.simReset,
    });
    viewer.speed = Number(els.simSpeed.value);
  } catch (err) {
    return simUnavailable('3D graphics (WebGL) are not available in this browser.');
  }
  return viewer;
}

function simUnavailable(message) {
  els.simCanvas.classList.add('hidden');
  els.simFallback.textContent = message;
  els.simFallback.classList.remove('hidden');
  return null;
}

function renderSimulation(res) {
  const prev = els.simProgram.value;
  const opts = [new Option('All programs, in order', 'all')];
  res.programs.forEach((p, i) => opts.push(new Option(`${p.index}. ${p.tool_name}`, String(i))));
  els.simProgram.replaceChildren(...opts);
  if ([...els.simProgram.options].some((o) => o.value === prev)) els.simProgram.value = prev;
  loadSimulation();
}

function loadSimulation() {
  const res = state.result;
  if (!res || !res.success || !ensureViewer()) return;
  viewer._stop();
  const choice = els.simProgram.value;
  const progs = choice === 'all' ? res.programs : [res.programs[Number(choice)]];
  const [sx, sy] = res.stock_size;
  viewer.load(progs.map((p) => p.gcode).join('\n'), {
    stockWidth: sx, stockDepth: sy, stockHeight: res.thickness, stockTop: 0,
    toolDiameter: progs[progs.length - 1].tool_diameter,
  });
}

els.simProgram.addEventListener('change', loadSimulation);
