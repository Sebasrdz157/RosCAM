// Browser test of multi-part nesting on a sheet, with a stand-in for Supabase.
const { chromium } = require('playwright');
const fs = require('fs'), path = require('path');
const S = process.argv[2];
const SB = 'https://ugapgbvcnizrirzynhbw.supabase.co';
const startEmpty = process.argv[3] === 'empty';

function serve(route, file, type) {
  route.fulfill({ body: fs.readFileSync(file), contentType: type, headers: { 'access-control-allow-origin': '*' } });
}
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
let nextId = 1;
function json(route, status, body) {
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body), headers: { 'access-control-allow-origin': '*' } });
}
async function fakeSupabase(route) {
  const req = route.request(), url = new URL(req.url()), method = req.method();
  if (method === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' } });
  const body = req.postData() ? JSON.parse(req.postData()) : null;
  const table = url.pathname.replace('/rest/v1/', '');
  if (method === 'GET' && table === 'sheets') {
    return json(route, 200, db.sheets.map((s) => ({ ...s, sheet_regions: db.regions.filter((r) => r.sheet_id === s.id) })));
  }
  if (table === 'sheet_regions' && method === 'POST') {
    const row = { id: `r${nextId++}`, created_at: new Date().toISOString(), ...body };
    db.regions.push(row); return json(route, 201, [row]);
  }
  json(route, 400, { message: `unhandled ${method} ${url.pathname}` });
}

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
  await context.route(`${SB}/**`, fakeSupabase);

  const page = await context.newPage();
  page.on('pageerror', (e) => console.log('pageerror:', e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) console.log('console error:', m.text().slice(0, 200)); });
  page.on('dialog', (d) => d.accept());
  await page.goto('http://localhost:8765/');
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

  await page.selectOption('#stock', 'AL-250-01');
  await page.setInputFiles('#file', ['plate.dxf', 'small.dxf', 'bracket.dxf'].map((f) => path.join(S, 'parts', f)));
  await page.waitForFunction(() => document.querySelectorAll('#parts-list tr').length === 3);
  await page.waitForFunction(() => !document.querySelector('#parts-list .part-busy'), null, { timeout: 60000 });
  console.log('parts:', await page.$$eval('#parts-list tr', (r) => r.map((x) => x.textContent.replace(/\s+/g, ' ').trim())));
  const qty = await page.$$('#parts-list input.qty');
  await qty[0].fill('4'); await qty[0].dispatchEvent('change');
  await qty[1].fill('6'); await qty[1].dispatchEvent('change');
  await qty[2].fill('3'); await qty[2].dispatchEvent('change');
  await page.waitForFunction(() => /Tried \d+ layouts/.test(document.querySelector('#nest-status').textContent), null, { timeout: 60000 });
  console.log('while nesting:', await page.textContent('#nest-status'), '| stop visible:', await page.isVisible('#nest-stop'));
  await page.screenshot({ path: `${S}/nest_running.png`, fullPage: true });
  await page.waitForSelector('.status.ok, .status.err', { timeout: 90000 });
  console.log('status:', await page.textContent('#status'));
  console.log('nest:', await page.textContent('#nest-status'));
  console.log('errors:', await page.$$eval('#errors li', (l) => l.map((x) => x.textContent)));
  console.log('warnings:', await page.$$eval('#warnings li', (l) => l.map((x) => x.textContent)));
  console.log('holes:', await page.$$eval('#holes tr', (r) => r.map((x) => x.textContent.replace(/\s+/g, ' ').trim().slice(0, 60))));
  console.log('programs:', await page.$$eval('#programs .meta', (l) => l.map((x) => x.textContent)));
  const parts = await page.evaluate(() => state.result.parts.map((p) => p.label));
  console.log('placed copies:', parts.length, parts.slice(0, 4).join(', '), '...');
  await page.screenshot({ path: `${S}/nest_done.png`, fullPage: true });
  const prev = await page.$('#preview-wrap');
  await prev.screenshot({ path: `${S}/nest_preview.png` });

  // change a hole's tool: programs regenerate for the same layout (no re-nesting)
  const before = await page.evaluate(() => JSON.stringify(state.layout.placements));
  await page.selectOption('#holes tr:nth-child(2) select', 'drill_5_32');
  await page.waitForFunction(() => document.querySelector('#holes .changed'), null, { timeout: 60000 });
  await page.waitForSelector('.status.ok', { timeout: 60000 });
  console.log('after override, same layout:', before === await page.evaluate(() => JSON.stringify(state.layout.placements)),
              '| programs:', await page.$$eval('#programs .file', (l) => l.map((x) => x.textContent)));

  // try again for a better layout, then stop it early
  await page.click('#nest-again');
  await page.waitForFunction(() => /Tried \d+ layouts/.test(document.querySelector('#nest-status').textContent), null, { timeout: 30000 });
  await page.click('#nest-stop');
  await page.waitForSelector('.status.ok', { timeout: 60000 });
  console.log('after stop:', await page.textContent('#nest-status'));

  // zoom: buttons and wheel
  await (await page.$('#preview')).scrollIntoViewIfNeeded();
  await page.click('#zoom-in'); await page.click('#zoom-in');
  const z1 = await page.evaluate(() => state.view.zoom);
  const pv = await page.$eval('#preview', (c) => { const r = c.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height * 0.8 }; });
  await page.mouse.move(pv.x, pv.y); await page.mouse.wheel(0, -400);
  await page.waitForTimeout(200);
  const z2 = await page.evaluate(() => state.view.zoom);
  await page.mouse.move(pv.x, pv.y); await page.mouse.down(); await page.mouse.move(pv.x + 80, pv.y - 40, { steps: 4 }); await page.mouse.up();
  console.log('zoom after 2 clicks:', z1.toFixed(2), '| after wheel:', z2.toFixed(2), '| centre:', await page.evaluate(() => [state.view.cx.toFixed(2), state.view.cy.toFixed(2)].join(',')));
  await (await page.$('#preview-wrap')).screenshot({ path: `${S}/zoomed.png` });
  await page.click('#zoom-fit');
  console.log('after fit:', await page.evaluate(() => state.view.zoom));

  // simulation colors
  console.log('sim legend:', await page.$$eval('#sim-legend span', (l) => l.map((x) => x.textContent)));
  console.log('sim uses vertex colors:', await page.evaluate(() => !!(viewer && viewer.completedLine.geometry.getAttribute('color'))));
  const sim = await page.$('#sim-wrap'); await sim.scrollIntoViewIfNeeded();
  const max = Number(await page.getAttribute('#sim-scrubber', 'max'));
  await page.$eval('#sim-scrubber', (el, v) => { el.value = v; el.dispatchEvent(new Event('input')); }, Math.round(max * 0.55));
  await page.waitForTimeout(300);
  await sim.screenshot({ path: `${S}/sim_colors.png` });

  // one part only
  console.log('one-part choices:', (await page.$$eval('#one-part option', (o) => o.map((x) => x.textContent))).slice(0, 4));
  await page.selectOption('#one-part', '2');
  const [one] = await Promise.all([page.waitForEvent('download', { timeout: 60000 }), page.click('#one-part-zip')]);
  await one.saveAs(`${S}/one_part.zip`);
  console.log('one part:', one.suggestedFilename(), '|', await page.textContent('#one-part-msg'));

  // mark as cut: only the one part is pre-ticked
  await page.click('#mark-cut');
  const ticked = await page.$$eval('#cut-list input', (l) => l.filter((b) => b.checked).length);
  await page.click('#cut-save');
  await page.waitForFunction(() => /Saved/.test(document.querySelector('#cut-msg').textContent), null, { timeout: 30000 });
  console.log('pre-ticked:', ticked, '|', await page.textContent('#cut-msg'), '| button:', await page.textContent('#mark-cut'),
              '| cut regions:', db.regions.filter((r) => r.kind === 'cut').length);
  await page.click('#mark-cut'); await page.click('#cut-all'); await page.click('#cut-save');
  await page.waitForFunction(() => /^All recorded/.test(document.querySelector('#mark-cut').textContent), null, { timeout: 30000 });
  console.log('after all:', await page.textContent('#mark-cut'), '| cut regions:', db.regions.filter((r) => r.kind === 'cut').length);

  // phone width
  await page.setViewportSize({ width: 390, height: 900 });
  await page.waitForTimeout(400);
  console.log('phone overflow:', await page.evaluate(() => document.documentElement.scrollWidth > innerWidth));
  await page.screenshot({ path: `${S}/nest_phone.png`, fullPage: true });
  await browser.close();
})().catch((e) => { console.error('FAILED', e.message); process.exit(1); });
