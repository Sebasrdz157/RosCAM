// RosCAM page logic: menus, hole overrides, toolpath preview, downloads.
// All CAM work happens in worker.js inside this browser tab.
'use strict';

const COLORS = ['#58a6ff', '#f0645b', '#d29922', '#a371f7', '#3fb950'];
const ENDMILL_COLOR = '#e8eaf0';
const MILL = 'mill';

const $ = (id) => document.getElementById(id);
const els = {
  engine: $('engine'), engineText: $('engine-text'), drop: $('drop'), file: $('file'),
  dropTitle: $('drop-title'), dropSub: $('drop-sub'),
  material: $('material'), thickness: $('thickness'), rotation: $('rotation'),
  result: $('result'), status: $('status'), errors: $('errors'), warnings: $('warnings'),
  holesWrap: $('holes-wrap'), holes: $('holes'), previewWrap: $('preview-wrap'), legend: $('legend'),
  preview: $('preview'), stockNote: $('stock-note'), programsWrap: $('programs-wrap'),
  programs: $('programs'), zip: $('zip'), sheetWrap: $('sheet-wrap'), sheet: $('sheet'),
};

const state = { options: null, file: null, bytes: null, overrides: {}, result: null, running: 0 };

// ---- worker plumbing ------------------------------------------------------------
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

// ---- startup --------------------------------------------------------------------
call('options').then((opts) => {
  state.options = opts;
  for (const m of opts.materials) els.material.add(new Option(m.name, m.id));
  fillThicknesses();
  restoreChoices();
  for (const el of [els.material, els.thickness, els.rotation]) el.disabled = false;
  els.engine.classList.add('ready');
  els.engineText.textContent = 'CAM engine ready. Files stay on this computer.';
  if (state.bytes) run();
}).catch((err) => {
  els.engine.classList.add('failed');
  els.engineText.textContent = `The CAM engine failed to load: ${err.message}. Check your internet connection and reload.`;
});

function fillThicknesses() {
  const mat = state.options.materials.find((m) => m.id === els.material.value);
  const prev = els.thickness.value;
  els.thickness.replaceChildren(...mat.thicknesses.map((t) => new Option(`${t}"`, t)));
  if (mat.thicknesses.includes(prev)) els.thickness.value = prev;
}

function restoreChoices() {
  try {
    const saved = JSON.parse(localStorage.getItem('roscam.choices') || '{}');
    if (saved.material && [...els.material.options].some((o) => o.value === saved.material)) {
      els.material.value = saved.material;
      fillThicknesses();
    }
    if (saved.thickness && [...els.thickness.options].some((o) => o.value === saved.thickness)) {
      els.thickness.value = saved.thickness;
    }
  } catch (_) { /* storage unavailable: defaults are fine */ }
}
function saveChoices() {
  try {
    localStorage.setItem('roscam.choices',
      JSON.stringify({ material: els.material.value, thickness: els.thickness.value }));
  } catch (_) { /* ignore */ }
}

els.material.addEventListener('change', () => { fillThicknesses(); saveChoices(); state.overrides = {}; run(); });
els.thickness.addEventListener('change', () => { saveChoices(); run(); });
els.rotation.addEventListener('change', run);

// ---- file input -----------------------------------------------------------------
els.file.addEventListener('change', () => { if (els.file.files[0]) takeFile(els.file.files[0]); });
els.drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); els.file.click(); } });
for (const ev of ['dragenter', 'dragover']) {
  els.drop.addEventListener(ev, (e) => { e.preventDefault(); els.drop.classList.add('over'); });
}
for (const ev of ['dragleave', 'drop']) {
  els.drop.addEventListener(ev, (e) => { e.preventDefault(); els.drop.classList.remove('over'); });
}
els.drop.addEventListener('drop', (e) => { if (e.dataTransfer.files[0]) takeFile(e.dataTransfer.files[0]); });

async function takeFile(file) {
  if (!/\.dxf$/i.test(file.name)) {
    showOnlyError(`${file.name} isn't a DXF. Export the plate's top face from Onshape as DXF.`);
    return;
  }
  state.file = file;
  state.bytes = await file.arrayBuffer();
  state.overrides = {};
  els.dropTitle.textContent = file.name;
  els.dropSub.textContent = 'Drop another DXF to replace it';
  run();
}

// ---- generate -------------------------------------------------------------------
async function run() {
  if (!state.bytes || !state.options) {
    if (state.bytes) setStatus('busy', 'Waiting for the CAM engine to finish loading...');
    return;
  }
  const ticket = ++state.running;
  els.result.classList.remove('hidden');
  els.drop.classList.add('busy');
  setStatus('busy', 'Generating toolpaths...');
  try {
    const res = await call('generate', {
      bytes: state.bytes.slice(0), filename: state.file.name,
      material: els.material.value, thickness: els.thickness.value,
      rotation: Number(els.rotation.value), overrides: state.overrides,
    });
    if (ticket !== state.running) return; // a newer run started meanwhile
    state.result = res;
    render(res);
  } catch (err) {
    if (ticket === state.running) showOnlyError(`Something went wrong: ${err.message}`);
  } finally {
    if (ticket === state.running) els.drop.classList.remove('busy');
  }
}

function setStatus(kind, text) {
  els.status.className = `status ${kind}`;
  els.status.textContent = text;
}

function showOnlyError(message) {
  els.result.classList.remove('hidden');
  setStatus('err', 'Could not make programs');
  fillList(els.errors, [message]);
  fillList(els.warnings, []);
  for (const el of [els.holesWrap, els.previewWrap, els.programsWrap, els.sheetWrap]) el.classList.add('hidden');
}

function fillList(ul, items) {
  ul.replaceChildren(...items.map((t) => Object.assign(document.createElement('li'), { textContent: t })));
}

function render(res) {
  const n = res.programs.length;
  if (res.success) {
    setStatus('ok', `${n} program${n === 1 ? '' : 's'} ready for ${res.part_name}`);
  } else {
    setStatus('err', 'Could not make programs. Fix the problems below.');
  }
  fillList(els.errors, res.errors);
  fillList(els.warnings, res.warnings);
  renderHoles(res.hole_groups);
  els.programsWrap.classList.toggle('hidden', !res.success);
  els.previewWrap.classList.toggle('hidden', !res.success);
  els.sheetWrap.classList.toggle('hidden', !res.success);
  if (res.success) {
    renderPrograms(res.programs);
    drawPreview(res);
    els.sheet.textContent = res.setup_sheet;
    const [sx, sy] = res.stock_size;
    els.stockNote.textContent = `Stock: at least ${sx.toFixed(2)}" x ${sy.toFixed(2)}". ` +
      'Zero X0 Y0 at the lower-left corner of the stock and Z0 on top of the stock.';
  }
}

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
      run();
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

function drawPreview(res) {
  const canvas = els.preview;
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth || 800;
  const [sx, sy] = res.stock_size;
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

  // Stock outline
  ctx.strokeStyle = '#2d3139';
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 4]);
  ctx.strokeRect(ox, oy - sy * scale, sx * scale, sy * scale);
  ctx.setLineDash([]);
  // Origin marker
  ctx.fillStyle = '#8b8fa8';
  ctx.beginPath(); ctx.arc(...P(0, 0), 3, 0, Math.PI * 2); ctx.fill();

  const legend = [];
  res.programs.forEach((p, idx) => {
    const color = programColor(p, idx);
    legend.push(`<span style="--swatch:${color}">${idx + 1}. ${escapeHtml(p.tool_name)}</span>`);
    const moves = parseMoves(p.gcode);
    if (p.tool_type === 'drill') {
      // A drill hole is drawn as a filled circle the size of the drill.
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
      return;
    }
    ctx.strokeStyle = color; ctx.lineWidth = 1.2;
    ctx.beginPath();
    for (const m of moves) {
      const cutting = Math.min(m.z, m.nz) < 0 && m.motion !== 0;
      if (!cutting) continue;
      if ((m.motion === 2 || m.motion === 3) && (m.i !== undefined || m.j !== undefined)) {
        const cx = m.x + (m.i || 0), cy = m.y + (m.j || 0);
        const r = Math.hypot(m.x - cx, m.y - cy);
        let a0 = Math.atan2(m.y - cy, m.x - cx), a1 = Math.atan2(m.ny - cy, m.nx - cx);
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
  });
  els.legend.innerHTML = legend.join('');
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

window.addEventListener('resize', () => { if (state.result && state.result.success) drawPreview(state.result); });
