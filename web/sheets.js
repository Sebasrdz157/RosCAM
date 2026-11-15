// Sheet inventory screen: list sheets by their sharpie ID, mark used areas by measurement
// or by dragging, and share sheet data/drawing with the Programs screen.
// Exposes window.RosSheets. Data lives in Supabase (see db.js / supabase/schema.sql).
'use strict';

(function () {
  const $ = (id) => document.getElementById(id);
  const S = {
    options: null, sheets: [], selected: null, loaded: false, drag: null, draft: null,
    listeners: new Set(),
  };
  const el = {};

  // ---------------------------------------------------------------- helpers
  const fmt = (n) => (Math.round(n * 1000) / 1000).toString();
  const matName = (id) => (S.options.materials.find((m) => m.id === id) || { name: id }).name;
  function show(node, on) { node.classList.toggle('hidden', !on); }
  function msg(text, kind) {
    el.msg.textContent = text || '';
    el.msg.className = `sheets-msg ${kind || ''}`;
  }

  // Fraction of the sheet still free, estimated on a 0.5" grid (good enough for a label).
  function freeFraction(sheet) {
    const regions = sheet.sheet_regions || [];
    if (!regions.length) return 1;
    const step = 0.5;
    let free = 0, total = 0;
    for (let y = step / 2; y < sheet.height; y += step) {
      for (let x = step / 2; x < sheet.width; x += step) {
        total++;
        if (!regions.some((r) => inside(x, y, r.polygon))) free++;
      }
    }
    return total ? free / total : 1;
  }
  function inside(x, y, poly) {
    let hit = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xi, yi] = poly[i], [xj, yj] = poly[j];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
    }
    return hit;
  }

  // Draw a sheet into ctx inside the given CSS-pixel box. Returns the mapping so callers
  // can draw on top and convert pointer positions back to inches.
  function drawSheet(ctx, sheet, boxW, boxH, opts = {}) {
    const pad = opts.pad ?? 12;
    const scale = Math.min((boxW - 2 * pad) / sheet.width, (boxH - 2 * pad) / sheet.height);
    const ox = (boxW - sheet.width * scale) / 2, oy = (boxH + sheet.height * scale) / 2;
    const P = (x, y) => [ox + x * scale, oy - y * scale];
    const toIn = (px, py) => [(px - ox) / scale, (oy - py) / scale];

    ctx.fillStyle = '#1a1d23';
    ctx.fillRect(ox, oy - sheet.height * scale, sheet.width * scale, sheet.height * scale);
    ctx.strokeStyle = '#8b8fa8'; ctx.lineWidth = 1;
    ctx.strokeRect(ox, oy - sheet.height * scale, sheet.width * scale, sheet.height * scale);

    for (const r of sheet.sheet_regions || []) {
      ctx.beginPath();
      r.polygon.forEach(([x, y], i) => (i ? ctx.lineTo(...P(x, y)) : ctx.moveTo(...P(x, y))));
      ctx.closePath();
      ctx.fillStyle = r.kind === 'cut' ? 'rgba(240,100,91,.28)' : 'rgba(139,143,168,.35)';
      ctx.fill();
      ctx.strokeStyle = r.kind === 'cut' ? '#f0645b' : '#8b8fa8';
      ctx.stroke();
      if (opts.labels && r.label) {
        const xs = r.polygon.map((p) => p[0]), ys = r.polygon.map((p) => p[1]);
        const [cx, cy] = P((Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2);
        ctx.fillStyle = '#e8eaf0'; ctx.font = '11px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(r.label.slice(0, 18), cx, cy);
      }
    }
    if (opts.origin !== false) {
      ctx.fillStyle = '#e8eaf0';
      ctx.beginPath(); ctx.arc(...P(0, 0), 3, 0, Math.PI * 2); ctx.fill();
    }
    return { P, toIn, scale };
  }

  function prepCanvas(canvas, cssW, cssH) {
    const dpr = window.devicePixelRatio || 1;
    canvas.style.width = `${cssW}px`; canvas.style.height = `${cssH}px`;
    canvas.width = Math.round(cssW * dpr); canvas.height = Math.round(cssH * dpr);
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);
    return ctx;
  }

  // ---------------------------------------------------------------- data
  async function reload(keepSelected = true) {
    try {
      S.sheets = await RosDB.listSheets();
      S.loaded = true;
      if (S.loadError) msg('');   // clear an old load error, but keep "Added sheet ..." etc.
      S.loadError = false;
    } catch (err) {
      S.loaded = false;
      S.loadError = true;
      msg(`Could not load sheets: ${err.message}`, 'err');
    }
    if (keepSelected && S.selected) S.selected = S.sheets.find((s) => s.id === S.selected.id) || null;
    renderList();
    renderEditor();
    S.listeners.forEach((fn) => fn(S.sheets));
  }

  async function guarded(action, okText) {
    try {
      await action();
      if (okText) msg(okText, 'ok');
      await reload();
      return true;
    } catch (err) {
      msg(err.message, 'err');
      return false;
    }
  }

  // ---------------------------------------------------------------- account
  function renderAccount() {
    const u = RosDB.user();
    show(el.signinForm, !u);
    show(el.signedIn, !!u);
    el.who.textContent = u ? u.email : '';
    document.querySelectorAll('.needs-editor').forEach((n) => { n.disabled = !u; });
  }

  // ---------------------------------------------------------------- list
  function renderList() {
    const mat = el.fMaterial.value, thk = el.fThickness.value, showUsed = el.fUsed.checked;
    const list = S.sheets.filter((s) => (!mat || s.material === mat) && (!thk || s.thickness === thk)
                                      && (showUsed || s.status === 'active'));
    el.count.textContent = S.loaded ? `${list.length} sheet${list.length === 1 ? '' : 's'}` : '';
    el.list.replaceChildren(...list.map((s) => {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'sheet-card' + (S.selected && S.selected.id === s.id ? ' selected' : '');
      card.setAttribute('aria-pressed', S.selected && S.selected.id === s.id ? 'true' : 'false');
      const canvas = document.createElement('canvas');
      const info = document.createElement('div');
      info.className = 'sheet-card-info';
      const free = Math.round(freeFraction(s) * 100);
      info.innerHTML = '';
      const id = Object.assign(document.createElement('strong'), { textContent: s.id });
      const meta = Object.assign(document.createElement('span'), {
        textContent: `${matName(s.material)} ${s.thickness}", ${fmt(s.width)} x ${fmt(s.height)}`,
      });
      const freeEl = Object.assign(document.createElement('span'), {
        className: 'sheet-free', textContent: s.status === 'used_up' ? 'Used up' : `${free}% free`,
      });
      info.append(id, meta, freeEl);
      card.append(canvas, info);
      card.addEventListener('click', () => { S.selected = s; S.draft = null; renderList(); renderEditor(); });
      requestAnimationFrame(() => drawSheet(prepCanvas(canvas, 60, 110), s, 60, 110, { pad: 4, origin: false }));
      return card;
    }));
    show(el.empty, S.loaded && list.length === 0);
  }

  // ---------------------------------------------------------------- editor
  function renderEditor() {
    const s = S.selected;
    show(el.editor, !!s);
    if (!s) return;
    el.edTitle.textContent = s.id;
    el.edMeta.textContent = `${matName(s.material)}, ${s.thickness}" thick, ${fmt(s.width)}" x ${fmt(s.height)}"`;
    el.edStatus.value = s.status;
    el.edNotes.value = s.notes || '';
    drawEditor();
    const regions = (s.sheet_regions || []).slice().sort((a, b) => a.created_at.localeCompare(b.created_at));
    el.regions.replaceChildren(...regions.map((r) => {
      const li = document.createElement('li');
      const xs = r.polygon.map((p) => p[0]), ys = r.polygon.map((p) => p[1]);
      const x0 = Math.min(...xs), y0 = Math.min(...ys);
      const text = Object.assign(document.createElement('span'), {
        textContent: `${r.kind === 'cut' ? 'Cut' : 'Used'}${r.label ? `: ${r.label}` : ''} at X ${fmt(x0)} Y ${fmt(y0)}, `
          + `${fmt(Math.max(...xs) - x0)} x ${fmt(Math.max(...ys) - y0)}`,
      });
      const del = Object.assign(document.createElement('button'), {
        type: 'button', className: 'btn small needs-editor', textContent: 'Remove',
      });
      del.disabled = !RosDB.user();
      del.addEventListener('click', () => {
        if (confirm(`Remove this area from ${s.id}? It will count as free stock again.`)) {
          guarded(() => RosDB.deleteRegion(r.id), 'Area removed.');
        }
      });
      li.append(text, del);
      return li;
    }));
    show(el.noRegions, regions.length === 0);
  }

  function drawEditor() {
    const s = S.selected;
    if (!s) return;
    const w = el.edCanvas.parentElement.clientWidth || 300;
    const h = Math.min(Math.max(320, w * (s.height / s.width)), 640);
    const ctx = prepCanvas(el.edCanvas, w, h);
    S.map = drawSheet(ctx, s, w, h, { labels: true });
    const d = S.draft;
    if (d) {
      const [x0, y0] = S.map.P(d.x, d.y + d.h);
      ctx.strokeStyle = '#d29922'; ctx.lineWidth = 2; ctx.setLineDash([5, 4]);
      ctx.strokeRect(x0, y0, d.w * S.map.scale, d.h * S.map.scale);
      ctx.setLineDash([]);
    }
  }

  function snap(v) { return Math.round(v * 8) / 8; }   // 1/8"
  function clampDraft(d) {
    const s = S.selected;
    const x = Math.max(0, Math.min(d.x, s.width)), y = Math.max(0, Math.min(d.y, s.height));
    return { x, y, w: Math.max(0, Math.min(d.w, s.width - x)), h: Math.max(0, Math.min(d.h, s.height - y)) };
  }
  function draftToForm() {
    const d = S.draft;
    el.rx.value = fmt(d.x); el.ry.value = fmt(d.y); el.rw.value = fmt(d.w); el.rh.value = fmt(d.h);
  }

  function bindEditorCanvas() {
    const c = el.edCanvas;
    const pos = (e) => {
      const r = c.getBoundingClientRect();
      return S.map.toIn(e.clientX - r.left, e.clientY - r.top);
    };
    c.addEventListener('pointerdown', (e) => {
      if (!S.selected || !S.map) return;
      c.setPointerCapture(e.pointerId);
      const [x, y] = pos(e);
      S.drag = { x: snap(x), y: snap(y) };
    });
    c.addEventListener('pointermove', (e) => {
      if (!S.drag) return;
      const [x, y] = pos(e);
      const x1 = snap(x), y1 = snap(y);
      S.draft = clampDraft({ x: Math.min(S.drag.x, x1), y: Math.min(S.drag.y, y1),
                             w: Math.abs(x1 - S.drag.x), h: Math.abs(y1 - S.drag.y) });
      drawEditor();
    });
    const end = () => {
      if (!S.drag) return;
      S.drag = null;
      if (S.draft && S.draft.w > 0 && S.draft.h > 0) draftToForm();
      else S.draft = null;
      drawEditor();
    };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
  }

  function readRegionForm() {
    const vals = [el.rx, el.ry, el.rw, el.rh].map((i) => Number(i.value));
    if (vals.some((v) => !Number.isFinite(v)) || vals[2] <= 0 || vals[3] <= 0) {
      throw new Error('Enter X, Y, width and height in inches (width and height above 0).');
    }
    const [x, y, w, h] = vals;
    const s = S.selected;
    if (x < 0 || y < 0 || x + w > s.width + 1e-6 || y + h > s.height + 1e-6) {
      throw new Error(`That area goes off the ${fmt(s.width)}" x ${fmt(s.height)}" sheet.`);
    }
    return [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
  }

  // ---------------------------------------------------------------- setup
  function init(options) {
    S.options = options;
    Object.assign(el, {
      msg: $('sheets-msg'), signinForm: $('signin-form'), email: $('signin-email'), password: $('signin-password'),
      signedIn: $('signed-in'), who: $('signed-in-who'), signout: $('signout'),
      fMaterial: $('f-material'), fThickness: $('f-thickness'), fUsed: $('f-used'),
      list: $('sheet-list'), count: $('sheet-count'), empty: $('sheet-empty'),
      addForm: $('add-sheet'), aId: $('a-id'), aMaterial: $('a-material'), aThickness: $('a-thickness'),
      aW: $('a-width'), aH: $('a-height'), aNotes: $('a-notes'),
      editor: $('sheet-editor'), edTitle: $('ed-title'), edMeta: $('ed-meta'), edStatus: $('ed-status'),
      edNotes: $('ed-notes'), edSaveNotes: $('ed-save-notes'), edDelete: $('ed-delete'), edCanvas: $('ed-canvas'),
      regions: $('region-list'), noRegions: $('no-regions'), regionForm: $('add-region'),
      rx: $('r-x'), ry: $('r-y'), rw: $('r-w'), rh: $('r-h'), rLabel: $('r-label'),
    });

    el.email.value = window.ROSCAM_CONFIG.teamEmail || '';
    for (const m of options.materials) {
      el.fMaterial.add(new Option(m.name, m.id));
      el.aMaterial.add(new Option(m.name, m.id));
    }
    const fillThk = (matSel, thkSel, any) => {
      const m = options.materials.find((x) => x.id === matSel.value);
      const list = m ? m.thicknesses : [...new Set(options.materials.flatMap((x) => x.thicknesses))];
      thkSel.replaceChildren(...(any ? [new Option('Any thickness', '')] : []),
                             ...list.map((t) => new Option(`${t}"`, t)));
    };
    fillThk(el.fMaterial, el.fThickness, true);
    fillThk(el.aMaterial, el.aThickness, false);
    el.fMaterial.addEventListener('change', () => { fillThk(el.fMaterial, el.fThickness, true); renderList(); });
    el.fThickness.addEventListener('change', renderList);
    el.fUsed.addEventListener('change', renderList);
    el.aMaterial.addEventListener('change', () => fillThk(el.aMaterial, el.aThickness, false));

    el.signinForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        await RosDB.signIn(el.email.value.trim(), el.password.value);
        el.password.value = '';
        msg('Signed in. You can add and change sheets.', 'ok');
      } catch (err) {
        msg(err.message, 'err');
      }
    });
    el.signout.addEventListener('click', () => { RosDB.signOut(); msg('Signed out.', ''); });
    RosDB.onAuthChange(() => { renderAccount(); renderEditor(); });

    el.addForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const id = el.aId.value.trim();
      if (!id) { msg('Enter the ID written on the sheet.', 'err'); return; }
      const ok = await guarded(() => RosDB.addSheet({
        id, material: el.aMaterial.value, thickness: el.aThickness.value,
        width: Number(el.aW.value) || 24, height: Number(el.aH.value) || 48, notes: el.aNotes.value.trim(),
      }), `Added sheet ${id}.`);
      if (ok) {
        el.aId.value = ''; el.aNotes.value = '';
        S.selected = S.sheets.find((s) => s.id === id) || null;
        renderList(); renderEditor();
      }
    });

    el.edStatus.addEventListener('change', () => {
      const s = S.selected;
      guarded(() => RosDB.updateSheet(s.id, { status: el.edStatus.value }),
              el.edStatus.value === 'used_up' ? `${s.id} marked as used up.` : `${s.id} is active again.`);
    });
    el.edSaveNotes.addEventListener('click', () => {
      const s = S.selected;
      guarded(() => RosDB.updateSheet(s.id, { notes: el.edNotes.value.trim() }), 'Notes saved.');
    });
    el.edDelete.addEventListener('click', () => {
      const s = S.selected;
      if (!confirm(`Delete sheet ${s.id} and all of its recorded areas? This cannot be undone.`)) return;
      guarded(() => RosDB.deleteSheet(s.id), `Deleted ${s.id}.`).then((ok) => { if (ok) { S.selected = null; renderEditor(); } });
    });
    el.regionForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      let polygon;
      try { polygon = readRegionForm(); } catch (err) { msg(err.message, 'err'); return; }
      const ok = await guarded(() => RosDB.addRegion({
        sheet_id: S.selected.id, kind: 'blocked', label: el.rLabel.value.trim(), polygon,
      }), 'Area marked as used.');
      if (ok) { S.draft = null; el.regionForm.reset(); drawEditor(); }
    });

    bindEditorCanvas();
    window.addEventListener('resize', () => drawEditor());
    renderAccount();
    reload(false);
  }

  window.RosSheets = {
    init, reload, drawSheet, prepCanvas, freeFraction,
    sheets: () => S.sheets,
    get: (id) => S.sheets.find((s) => s.id === id) || null,
    onChange(fn) { S.listeners.add(fn); },
    redraw: () => drawEditor(),
  };
})();
