// Browser test of multi-part nesting on a sheet, with a stand-in for the Parts Tracker API (fakeparts.js).
const { chromium } = require('playwright');
const fs = require('fs'), path = require('path');
const S = process.argv[2];
const { fakeParts } = require('./fakeparts');
const startEmpty = process.argv[3] === 'empty';

function serve(route, file, type) {
  route.fulfill({ body: fs.readFileSync(file), contentType: type, headers: { 'access-control-allow-origin': '*' } });
}
const tools = [];
const db = {
  sheets: startEmpty ? [] : [
    { id: 'AL-250-01', material: 'aluminum', thickness: '1/4', width: 24, height: 48, status: 'active', notes: '', created_at: '2026-01-01' },
    { id: 'PC-125-01', material: 'polycarbonate', thickness: '1/8', width: 24, height: 48, status: 'active', notes: '', created_at: '2026-01-01' },
  ],
  regions: startEmpty ? [] : [
    { id: 'r0', sheet_id: 'AL-250-01', kind: 'blocked', label: 'old cuts', created_at: '2026-01-01',
      polygon: [[0, 0], [24, 0], [24, 6], [0, 6]] },
  ],
};
(async () => {
  const browser = await chromium.launch({ proxy: { server: process.env.HTTPS_PROXY, bypass: 'localhost,127.0.0.1' } });
  const context = await browser.newContext({ viewport: { width: 1100, height: 1000 } });
  await context.route('https://cdn.jsdelivr.net/pyodide/v0.27.2/full/**', (route) => {
    const name = path.basename(new URL(route.request().url()).pathname);
    const type = name.endsWith('.wasm') ? 'application/wasm' : name.endsWith('.json') ? 'application/json'
      : name.endsWith('.js') || name.endsWith('.mjs') ? 'text/javascript' : 'application/octet-stream';
    serve(route, path.join(S, 'pyodide', 'pyodide', name), type);
  });
  await context.route('https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js',
    (r) => serve(r, path.join(S, 'three/package/build/three.min.js'), 'text/javascript'));
  await context.route('https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/controls/OrbitControls.js',
    (r) => serve(r, path.join(S, 'three/package/examples/js/controls/OrbitControls.js'), 'text/javascript'));
  await fakeParts(context, { db, tools: tools });

  const page = await context.newPage();
  page.on('pageerror', (e) => console.log('pageerror:', e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) console.log('console error:', m.text().slice(0, 200)); });
  page.on('dialog', (d) => d.accept());
  await page.goto(process.env.ROSCAM_URL || 'http://localhost:8765/');
  await page.waitForSelector('#engine.ready', { timeout: 180000 });
  await page.waitForTimeout(500);
  console.log('material/thickness fields gone:', !(await page.$('#material')) && !(await page.$('#thickness')));
  console.log('sheet options:', await page.$$eval('#stock option', (o) => o.map((x) => x.textContent)));
  console.log('no-sheets message visible:', await page.isVisible('#no-sheets'));
  if (startEmpty) {
    await page.screenshot({ path: `${S}/nest_nosheets.png` });
    await browser.close();
    return;
  }

  // --- Tools screen
  await page.click('.view-tab[data-view="tools"]');
  await page.waitForTimeout(300);
  console.log('tool cards:', await page.$$eval('.tool-card', (l) => l.map((x) => x.querySelector('strong').textContent + ' [' + x.querySelector('.tool-badge').textContent + ']')));
  await page.click('.tool-card');
  console.log('built-in view:', await page.textContent('#tool-view-meta'));
  await page.click('#new-tool');
  await page.fill('#t-name', '1/8" 2-flute end mill');
  await page.fill('#t-fields input[data-key="diameter"]', '1/8');
  await page.fill('#t-fields input[data-key="flute_length"]', '1/2');
  await page.click('#tool-form button[type=submit]');
  await page.waitForSelector('#tool-view:not(.hidden)');
  console.log('added:', await page.textContent('#tools-msg'), '| saved row:', JSON.stringify(tools[0]).slice(0, 220));
  await page.click('#new-tool');
  await page.selectOption('#t-type', 'drill');
  await page.fill('#t-name', '1/8" drill');
  await page.fill('#t-fields input[data-key="diameter"]', '0.125');
  await page.fill('#t-fields input[data-key="flute_length"]', '1');
  await page.click('#tool-form button[type=submit]');
  await page.waitForSelector('#tool-view:not(.hidden)');
  console.log('second:', await page.textContent('#tools-msg'), '| ids:', tools.map((t) => t.id));
  // missing name is caught
  await page.click('#new-tool');
  await page.fill('#t-fields input[data-key="diameter"]', '1/8');
  await page.click('#tool-form button[type=submit]');
  console.log('validation:', await page.textContent('#tools-msg'));
  await page.click('#t-cancel');
  await page.screenshot({ path: `${S}/tools_view.png`, fullPage: true });

  // --- the rack: teeth too tight for the 1/4" end mill go to the 1/8" one
  await page.click('.view-tab[data-view="programs"]');
  await page.selectOption('#stock', 'AL-250-01');
  await page.setInputFiles('#file', [path.join(S, 'parts', 'rack.dxf')]);
  await page.waitForSelector('.status.ok, .status.err', { timeout: 120000 });
  console.log('LAYOUT', JSON.stringify(await page.evaluate(() => state.layout && state.layout.placements)));
  console.log('rack:', await page.textContent('#status'), '|', await page.$$eval('#errors li', (l) => l.map((x) => x.textContent)));
  console.log('warnings:', await page.$$eval('#warnings li', (l) => l.map((x) => x.textContent)));
  console.log('programs:', await page.$$eval('#programs .meta', (l) => l.map((x) => x.textContent)));
  console.log('hole choices for 0.18:', await page.$$eval('#holes tr', (rows) => rows.map((r) => [...r.querySelectorAll('option')].map((o) => o.textContent))));
  console.log('swatches:', await page.$$eval('#programs li', (l) => l.map((x) => x.style.getPropertyValue('--swatch'))));
  console.log('sim legend:', await page.$$eval('#sim-legend span', (l) => l.map((x) => x.textContent)));
  await (await page.$('#preview')).scrollIntoViewIfNeeded();
  for (let i = 0; i < 4; i++) await page.click('#zoom-in');
  const pv = await page.$eval('#preview', (c) => { const r = c.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
  await page.evaluate(() => { state.view.cx = 4.2; state.view.cy = 1.9; drawPreview(state.result); });
  await (await page.$('#preview-wrap')).screenshot({ path: `${S}/rack_zoom.png` });
  const sim = await page.$('#sim-wrap'); await sim.scrollIntoViewIfNeeded();
  const max = Number(await page.getAttribute('#sim-scrubber', 'max'));
  await page.$eval('#sim-scrubber', (el, v) => { el.value = v; el.dispatchEvent(new Event('input')); }, Math.round(max * 0.93));
  await page.waitForTimeout(300);
  await sim.screenshot({ path: `${S}/rack_sim.png` });
  await browser.close();
})().catch((e) => { console.error('FAILED', e.message); process.exit(1); });
