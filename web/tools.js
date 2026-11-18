// Tools screen: the bits RosCAM can use on the machine picked in the top bar. Built-in ones
// come from that machine's roscam_config*.yaml; more can be added to the tool library
// (Firestore, through db.js), e.g. a 1/8" end mill for details the 1/4" end mill can't reach.
// Every library bit belongs to one machine (rows saved before machines existed: the shop's),
// so one machine's bits never end up in another's programs. Exposes window.RosTools.
'use strict';

(function () {
  const $ = (id) => document.getElementById(id);
  const T = { builtin: [], all: [], library: [], selected: null, mode: 'empty', listeners: new Set(), loaded: false,
              machine: { id: 'shop', label: '', tool_changes: 'per_file' } };
  const machineOf = (row) => row.machine || 'shop';
  function filterLibrary() { T.library = T.all.filter((r) => machineOf(r) === T.machine.id); }
  const el = {};

  // ---------------------------------------------------------------- formatting
  function inches(v) {
    if (v === null || v === undefined || v === '') return '';
    const n = Number(v);
    const s64 = Math.round(n * 64);
    if (Math.abs(n * 64 - s64) < 1e-6 && s64 > 0 && n < 4) {
      let num = s64, den = 64;
      while (num % 2 === 0 && den > 1) { num /= 2; den /= 2; }
      const whole = Math.floor(num / den), rest = num % den;
      return whole ? (rest ? `${whole} ${rest}/${den}"` : `${whole}"`) : `${rest}/${den}"`;
    }
    return `${Math.round(n * 1e6) / 1e6}"`;
  }
  const parseInches = (t) => (window.RosSheets ? RosSheets.parseInches(t) : Number(t));
  const show = (node, on) => node.classList.toggle('hidden', !on);
  function msg(text, kind) { el.msg.textContent = text || ''; el.msg.className = `sheets-msg ${kind || ''}`; }

  // Every tool by id, library rows replacing built-in ones with the same id.
  function merged() {
    const byId = new Map(T.builtin.map((t) => [t.id, { ...t, builtin: true }]));
    for (const t of T.library) byId.set(t.id, { ...t, builtin: false, overrides: byId.has(t.id) });
    return [...byId.values()].sort((a, b) => (a.type === b.type ? b.diameter - a.diameter : a.type.localeCompare(b.type)));
  }

  function suggestId(type, diameter) {
    const s64 = Math.round(diameter * 64);
    let part;
    if (Math.abs(diameter * 64 - s64) < 1e-6 && s64 > 0) {
      let num = s64, den = 64;
      while (num % 2 === 0 && den > 1) { num /= 2; den /= 2; }
      part = `${num}_${den}`;
    } else {
      part = String(Math.round(diameter * 10000)).padStart(4, '0');
    }
    const base = `${type}_${part}`;
    const taken = new Set(merged().map((t) => t.id));
    let id = base;
    for (let n = 2; taken.has(id); n++) id = `${base}_${n}`;
    return id;
  }

  // ---------------------------------------------------------------- data
  async function reload() {
    try {
      T.all = await RosDB.listTools();
      filterLibrary();
      T.loaded = true;
      if (T.loadError) msg('');
      T.loadError = false;
    } catch (err) {
      T.all = [];
      T.library = [];
      T.loadError = true;
      msg(`Could not load the tool library: ${err.message}`, 'err');
    }
    if (T.selected) T.selected = merged().find((t) => t.id === T.selected.id) || null;
    render();
    T.listeners.forEach((fn) => fn(T.library));
  }

  async function guarded(action, okText) {
    try {
      await action();
      msg(okText, 'ok');
      await reload();
      return true;
    } catch (err) {
      msg(err.message, 'err');
      return false;
    }
  }

  // ---------------------------------------------------------------- list
  function render() {
    const tools = merged();
    const groups = [['endmill', 'End mills'], ['drill', 'Drills']];
    el.list.replaceChildren(...groups.flatMap(([type, title]) => {
      const items = tools.filter((t) => t.type === type);
      const h = Object.assign(document.createElement('h3'), { textContent: title });
      const wrap = document.createElement('div');
      wrap.className = 'tool-list';
      wrap.append(...items.map((t) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'tool-card' + (T.selected && T.selected.id === t.id ? ' selected' : '') + (t.active === false ? ' inactive' : '');
        const name = Object.assign(document.createElement('strong'), { textContent: t.name });
        const meta = Object.assign(document.createElement('span'), {
          textContent: `${inches(t.diameter)} ${type === 'drill' ? 'drill' : 'end mill'}, ${t.spindle_speed} RPM`,
        });
        const badge = Object.assign(document.createElement('span'), {
          className: 'tool-badge', textContent: t.builtin ? 'built in' : (t.active === false ? 'not in use' : (t.overrides ? 'library, replaces built-in' : 'library')),
        });
        b.append(name, meta, badge);
        b.addEventListener('click', () => { T.selected = t; setMode('view'); render(); });
        return b;
      }));
      return [h, wrap];
    }));
  }

  // ---------------------------------------------------------------- panel
  function setMode(mode) {
    T.mode = mode;
    show(el.empty, mode === 'empty');
    show(el.view, mode === 'view');
    show(el.form, mode === 'add' || mode === 'edit' || mode === 'edit-copy');
    if (mode === 'empty') { T.selected = null; render(); }
    if (mode === 'view') renderView();
    if (window.matchMedia('(max-width: 640px)').matches && mode !== 'empty') {
      el.panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }

  const FIELDS = {
    endmill: [['tool_number', 'Tool number', ''], ['diameter', 'Diameter', 'in'], ['flute_length', 'Cutting length', 'in'], ['overall_length', 'Overall length', 'in'],
              ['flutes', 'Flutes', ''], ['spindle_speed', 'Spindle', 'RPM'], ['feed_rate', 'Cutting feed', 'in/min'],
              ['plunge_rate', 'Plunge feed', 'in/min'], ['ramp_feed_rate', 'Ramp-in feed', 'in/min'], ['stepdown', 'Depth per pass', 'in']],
    drill: [['tool_number', 'Tool number', ''], ['diameter', 'Diameter', 'in'], ['flute_length', 'Cutting length', 'in'], ['overall_length', 'Overall length', 'in'],
            ['flutes', 'Flutes', ''], ['spindle_speed', 'Spindle', 'RPM'], ['plunge_rate', 'Feed', 'in/min'],
            ['tip_angle', 'Tip angle', 'deg'], ['peck', 'Peck depth', 'in'], ['peck_retract', 'Lift between pecks', 'in']],
  };
  // Tool numbers only matter on machines that change bits inside one file (T# M6).
  const visibleFields = (type) => FIELDS[type].filter(([k]) => k !== 'tool_number' || T.machine.tool_changes === 'in_file');
  const LENGTH_FIELDS = new Set(['diameter', 'flute_length', 'overall_length', 'stepdown', 'peck', 'peck_retract']);
  // Starting values for a new bit; the form says to check them.
  const DEFAULTS = {
    endmill: { spindle_speed: 18000, feed_rate: 40, plunge_rate: 5, ramp_feed_rate: 15, stepdown: 0.02, flutes: 2 },
    drill: { spindle_speed: 6900, plunge_rate: 30, tip_angle: 118, peck: 0.047, peck_retract: 0.015, flutes: 2 },
  };

  function renderView() {
    const t = T.selected;
    if (!t) return setMode('empty');
    el.viewTitle.textContent = t.name;
    el.viewMeta.textContent = `For ${T.machine.label}. ` + (t.builtin
      ? "Built into this machine's settings. To change its numbers, copy it to the library: the library copy replaces it."
      : (t.overrides ? 'In the tool library, replacing the built-in bit with the same ID.' : 'In the tool library.'));
    el.viewList.replaceChildren(...visibleFields(t.type).map(([k, label, unit]) => {
      const dt = Object.assign(document.createElement('dt'), { textContent: label });
      const v = t[k];
      const dd = Object.assign(document.createElement('dd'), {
        textContent: v === null || v === undefined || v === '' ? '-' : (LENGTH_FIELDS.has(k) ? inches(v) : `${v}${unit && unit !== 'in' ? ` ${unit}` : ''}`),
      });
      return [dt, dd];
    }).flat());
    show(el.copy, t.builtin);
    show(el.edit, !t.builtin);
    el.copy.disabled = el.edit.disabled = !RosSheets.canEdit();
  }

  function fillForm(tool, mode) {
    T.formMode = mode;
    el.fTitle.textContent = mode === 'add' ? 'Add a bit' : `Edit ${tool.name}`;
    el.fType.value = tool.type || 'endmill';
    el.fType.disabled = mode !== 'add';
    el.fName.value = tool.name || '';
    el.fActive.checked = tool.active !== false;
    el.fNotes.value = tool.notes || '';
    T.formId = mode === 'add' ? null : tool.id;
    renderFields(tool);
    el.fDelete.classList.toggle('hidden', mode !== 'edit');
    setMode(mode);
  }

  function renderFields(tool) {
    const type = el.fType.value;
    el.fFields.replaceChildren(...visibleFields(type).map(([k, label, unit]) => {
      const wrap = Object.assign(document.createElement('label'), { className: 'field' });
      wrap.append(Object.assign(document.createElement('span'), { textContent: unit ? `${label}, ${unit}` : label }));
      const input = Object.assign(document.createElement('input'), { type: 'text', autocomplete: 'off' });
      input.dataset.key = k;
      input.inputMode = 'decimal';
      const v = tool[k] !== undefined && tool[k] !== null ? tool[k] : (T.formMode === 'add' ? DEFAULTS[type][k] : undefined);
      input.value = v === undefined || v === null ? '' : (LENGTH_FIELDS.has(k) ? String(Math.round(v * 1e6) / 1e6) : String(v));
      if (k === 'diameter' || k === 'flute_length') input.required = true;
      if (k === 'diameter') input.placeholder = 'e.g. 1/8';
      if (k === 'tool_number') { input.required = true; input.inputMode = 'numeric'; input.placeholder = 'T number, e.g. 5'; }
      wrap.append(input);
      return wrap;
    }));
  }

  function readForm() {
    const type = el.fType.value;
    const row = { type, name: el.fName.value.trim(), active: el.fActive.checked, notes: el.fNotes.value.trim() };
    if (!row.name) throw new Error('Give the bit a name, e.g. 1/8" 2-flute end mill.');
    for (const input of el.fFields.querySelectorAll('input')) {
      const k = input.dataset.key, raw = input.value.trim();
      if (!raw) { row[k] = null; continue; }
      const v = LENGTH_FIELDS.has(k) ? parseInches(raw) : Number(raw);
      if (!Number.isFinite(v) || v < 0) throw new Error(`Check "${input.previousSibling.textContent}": "${raw}" isn't a number.`);
      row[k] = k === 'spindle_speed' || k === 'flutes' || k === 'tool_number' ? Math.round(v) : v;
    }
    if (T.machine.tool_changes === 'in_file' && !row.tool_number) {
      throw new Error(`Give the bit its tool number: the T number ${T.machine.label} uses for it.`);
    }
    row.machine = T.machine.id;
    const need = type === 'endmill'
      ? ['diameter', 'flute_length', 'spindle_speed', 'plunge_rate', 'feed_rate', 'ramp_feed_rate', 'stepdown']
      : ['diameter', 'flute_length', 'spindle_speed', 'plunge_rate'];
    const missing = need.filter((k) => !row[k]);
    if (missing.length) {
      const names = Object.fromEntries(FIELDS[type].map(([k, l]) => [k, l]));
      throw new Error(`Fill in: ${missing.map((k) => names[k]).join(', ')}.`);
    }
    if (row.diameter > 1) throw new Error('Diameter is in inches; 1" or less.');
    if (type === 'drill') { row.peck = row.peck || 0; row.peck_retract = row.peck_retract || 0; }
    return row;
  }

  // ---------------------------------------------------------------- setup
  // The machine changed (or its options were reloaded): show its bits.
  function setMachine(options) {
    const changed = options.machine.id !== T.machine.id;
    T.machine = options.machine;
    T.builtin = options.tools.filter((t) => t.builtin);
    if (el.machineName) el.machineName.textContent = T.machine.label;
    if (!changed) return;
    filterLibrary();
    T.selected = null;
    if (el.list) { setMode('empty'); render(); }
    T.listeners.forEach((fn) => fn(T.library));
  }

  function init(options) {
    T.machine = options.machine;
    T.builtin = options.tools.filter((t) => t.builtin);
    Object.assign(el, {
      msg: $('tools-msg'), list: $('tools-groups'), panel: $('tool-panel'), empty: $('tool-empty'),
      view: $('tool-view'), viewTitle: $('tool-view-title'), viewMeta: $('tool-view-meta'), viewList: $('tool-view-list'),
      copy: $('tool-copy'), edit: $('tool-edit'), newTool: $('new-tool'),
      form: $('tool-form'), fTitle: $('tool-form-title'), fType: $('t-type'), fName: $('t-name'), fFields: $('t-fields'),
      fActive: $('t-active'), fNotes: $('t-notes'), fCancel: $('t-cancel'), fDelete: $('t-delete'),
      machineName: $('tools-machine'),
    });
    el.machineName.textContent = T.machine.label;
    el.newTool.addEventListener('click', () => fillForm({ type: 'endmill' }, 'add'));
    el.fType.addEventListener('change', () => renderFields({}));
    el.fCancel.addEventListener('click', () => setMode(T.selected ? 'view' : 'empty'));
    el.copy.addEventListener('click', () => fillForm({ ...T.selected, active: true }, 'edit-copy'));
    el.edit.addEventListener('click', () => fillForm(T.selected, 'edit'));
    el.fDelete.addEventListener('click', () => {
      const t = T.selected;
      if (!t || !confirm(`Delete ${t.name} from the tool library?${t.overrides ? ' The built-in bit with the same ID comes back.' : ''}`)) return;
      guarded(() => RosDB.deleteTool(t.id, T.machine.id), `Deleted ${t.name}.`).then((ok) => { if (ok) setMode('empty'); });
    });
    el.form.addEventListener('submit', async (e) => {
      e.preventDefault();
      let row;
      try { row = readForm(); } catch (err) { msg(err.message, 'err'); return; }
      if (T.formMode === 'add') {
        row.id = suggestId(row.type, row.diameter);
        const ok = await guarded(() => RosDB.addTool(row), `Added ${row.name}.`);
        if (ok) { T.selected = merged().find((t) => t.id === row.id) || null; setMode(T.selected ? 'view' : 'empty'); render(); }
      } else if (T.formMode === 'edit-copy') {
        row.id = T.selected.id;
        const ok = await guarded(() => RosDB.addTool(row), `Saved ${row.name} to the library; it replaces the built-in one.`);
        if (ok) setMode('view');
      } else {
        const ok = await guarded(() => RosDB.updateTool(T.formId, row), `Saved ${row.name}.`);
        if (ok) setMode('view');
      }
    });
    let loadedFor = RosDB.user() ? RosDB.user().email : null;
    RosDB.onAuthChange((u) => {
      if (T.mode === 'view') renderView();
      const who = u ? u.email : null;
      if (who && who !== loadedFor) { loadedFor = who; reload(); }
      if (!who) loadedFor = null;
    });
    setMode('empty');
    if (loadedFor) reload();
  }

  window.RosTools = {
    init, reload, inches, setMachine,
    // Every machine's library rows (each says its machine); the engine keeps the chosen one's.
    tools: () => T.all.map((t) => ({ ...t })),
    onChange(fn) { T.listeners.add(fn); },
  };
})();
