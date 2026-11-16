// Browser test of the Sheets feature with an in-memory stand-in for Supabase's REST API.
const { chromium } = require('playwright');
const fs = require('fs'), path = require('path');
const S = process.argv[2];
const SB = 'https://ugapgbvcnizrirzynhbw.supabase.co';

function serve(route, file, type) {
  route.fulfill({ body: fs.readFileSync(file), contentType: type, headers: { 'access-control-allow-origin': '*' } });
}

// ---- fake Supabase ------------------------------------------------------------------
const db = { sheets: [], regions: [] };
let nextId = 1;
function json(route, status, body) {
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body),
                  headers: { 'access-control-allow-origin': '*' } });
}
async function fakeSupabase(route) {
  const req = route.request();
  const url = new URL(req.url());
  const method = req.method();
  if (method === 'OPTIONS') return route.fulfill({ status: 204, headers: {
    'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' } });
  const authed = true;  // database re-run with open editing
  const body = req.postData() ? JSON.parse(req.postData()) : null;
  if (url.pathname === '/auth/v1/token') {
    if (body.password === 'teampw') return json(route, 200, { access_token: 'team-token', refresh_token: 'r', expires_in: 3600, user: { email: body.email } });
    return json(route, 400, { error_description: 'Invalid login credentials' });
  }
  if (url.pathname === '/auth/v1/logout') return json(route, 204, {});
  const table = url.pathname.replace('/rest/v1/', '');
  const eq = url.searchParams.get('id');
  const idv = eq ? decodeURIComponent(eq.replace(/^eq\./, '')) : null;
  if (method === 'GET' && table === 'sheets') {
    return json(route, 200, db.sheets.map((s) => ({ ...s, sheet_regions: db.regions.filter((r) => r.sheet_id === s.id) })));
  }
  if (!authed) return json(route, 401, { code: '42501', message: 'permission denied' });
  if (table === 'sheets' && method === 'POST') {
    if (db.sheets.some((s) => s.id === body.id)) return json(route, 409, { code: '23505', message: 'duplicate key' });
    const row = { status: 'active', notes: '', created_at: new Date().toISOString(), ...body };
    db.sheets.push(row); return json(route, 201, [row]);
  }
  if (table === 'sheets' && method === 'PATCH') {
    const s = db.sheets.find((x) => x.id === idv); if (!s) return json(route, 200, []);
    Object.assign(s, body); return json(route, 200, [s]);
  }
  if (table === 'sheets' && method === 'DELETE') {
    const s = db.sheets.find((x) => x.id === idv); if (!s) return json(route, 200, []);
    db.sheets = db.sheets.filter((x) => x !== s); db.regions = db.regions.filter((r) => r.sheet_id !== idv);
    return json(route, 200, [s]);
  }
  if (table === 'sheet_regions' && method === 'POST') {
    const row = { id: `r${nextId++}`, created_at: new Date(Date.now() + nextId).toISOString(), ...body };
    db.regions.push(row); return json(route, 201, [row]);
  }
  if (table === 'sheet_regions' && method === 'DELETE') {
    const r = db.regions.find((x) => x.id === idv); if (!r) return json(route, 200, []);
    db.regions = db.regions.filter((x) => x !== r); return json(route, 200, [r]);
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
  page.on('console', (m) => { if (m.type() === 'error') console.log('console error:', m.text().slice(0, 200)); });
  page.on('dialog', (d) => d.accept());
  await page.goto('http://localhost:8765/');
  await page.waitForSelector('#engine.ready', { timeout: 180000 });

  // --- Sheets screen (open editing, no sign-in)
  await page.click('.view-tab[data-view="sheets"]');
  await page.waitForTimeout(300);
  console.log('account box visible:', await page.isVisible('#account-card'));
  console.log('empty list says:', await page.textContent('#sheet-empty'));
  console.log('panel says:', (await page.textContent('#panel-empty h2')).trim());
  await page.screenshot({ path: `${S}/sheets_empty.png`, fullPage: true });
  await page.click('#new-sheet');
  await page.selectOption('#a-material', 'aluminum');
  await page.selectOption('#a-thickness', '1/4');
  console.log('suggested ID:', await page.inputValue('#a-id'));
  await page.fill('#a-notes', 'rack 2');
  await page.click('#add-sheet button[type=submit]');
  await page.waitForSelector('#sheet-editor:not(.hidden)');
  console.log('added:', await page.textContent('#sheets-msg'), '| editor:', await page.textContent('#ed-title'));
  await page.click('#new-sheet');
  await page.selectOption('#a-material', 'aluminum');
  await page.selectOption('#a-thickness', '1/4');
  console.log('next suggested ID:', await page.inputValue('#a-id'));
  await page.selectOption('#a-material', 'polycarbonate');
  await page.selectOption('#a-thickness', '1/16');
  console.log('poly 1/16 suggestion:', await page.inputValue('#a-id'));
  await page.fill('#a-id', 'AL-250-01');
  await page.click('#add-sheet button[type=submit]');
  await page.waitForTimeout(300);
  console.log('duplicate msg:', await page.textContent('#sheets-msg'));
  await page.click('#add-cancel');
  await page.click('.sheet-card');
  await page.waitForSelector('#sheet-editor:not(.hidden)');
  await page.selectOption('#f-material', 'polycarbonate');
  console.log('filter poly ->', await page.textContent('#sheet-count'), '|', await page.textContent('#sheet-empty'));
  await page.selectOption('#f-material', '');
  await page.click('.sheet-card');
  // used area by measurement: bottom 10"
  await page.fill('#r-x', '0'); await page.fill('#r-y', '0'); await page.fill('#r-w', '23 63/64'); await page.fill('#r-h', '10.015625');
  await page.fill('#r-label', 'old cuts');
  await page.click('#add-region button[type=submit]');
  await page.waitForTimeout(400);
  // used area by dragging on the drawing (a block on the left above it)
  const box = await page.$eval('#ed-canvas', (c) => { const r = c.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
  // map inches to pixels the same way drawSheet does (pad 12)
  const scale = Math.min((box.w - 24) / 24, (box.h - 24) / 48);
  const ox = box.x + (box.w - 24 * scale) / 2, oy = box.y + (box.h + 48 * scale) / 2;
  const px = (x, y) => [ox + x * scale, oy - y * scale];
  await page.mouse.move(...px(0, 10)); await page.mouse.down();
  await page.mouse.move(...px(4, 14), { steps: 5 }); await page.mouse.move(...px(8, 20), { steps: 5 }); await page.mouse.up();
  console.log('drag filled form:', ['#r-x', '#r-y', '#r-w', '#r-h'].map(() => 0) && await Promise.all(['#r-x', '#r-y', '#r-w', '#r-h'].map((s) => page.inputValue(s))));
  await page.click('#add-region button[type=submit]');
  await page.waitForTimeout(400);
  console.log('regions:', await page.$$eval('#region-list li span', (l) => l.map((x) => x.textContent)));
  console.log('card:', await page.textContent('.sheet-card'));
  await page.screenshot({ path: `${S}/sheets_view.png`, fullPage: true });

  // --- Programs on that sheet
  await page.click('.view-tab[data-view="programs"]');
  await page.selectOption('#material', 'aluminum');
  await page.selectOption('#thickness', '1/4');
  console.log('stock options:', await page.$$eval('#stock option', (o) => o.map((x) => x.textContent)));
  await page.selectOption('#stock', 'AL-250-01');
  await page.setInputFiles('#file', require('path').resolve(__dirname, '../fixtures/roscam_plate.dxf'));
  await page.waitForSelector('.status.ok, .status.err', { timeout: 120000 });
  await page.waitForFunction(() => !document.querySelector('#drop').classList.contains('busy'));
  console.log('status:', await page.textContent('#status'), '|', await page.textContent('#stock-note'));
  const prev = await page.$('#preview-wrap');
  await prev.scrollIntoViewIfNeeded();
  await prev.screenshot({ path: `${S}/sheet_place_auto.png` });

  // drag the part up the sheet
  const pb = await page.$eval('#preview', (c) => { const r = c.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
  const ps = Math.min((pb.w - 32) / 24, (pb.h - 32) / 48);
  const pox = pb.x + (pb.w - 24 * ps) / 2, poy = pb.y + (pb.h + 48 * ps) / 2;
  const pp = (x, y) => [pox + x * ps, poy - y * ps];
  const place = JSON.parse(await page.evaluate(() => JSON.stringify(state.result.placement)));
  const grab = [place[0] + 3, place[1] + 2];
  await page.mouse.move(...pp(...grab)); await page.mouse.down();
  await page.mouse.move(...pp(grab[0] + 8, grab[1] + 15), { steps: 8 }); await page.mouse.up();
  await page.waitForFunction((old) => state.result && JSON.stringify(state.result.placement) !== old, JSON.stringify(place), { timeout: 60000 });
  await page.waitForFunction(() => !document.querySelector('#drop').classList.contains('busy'));
  console.log('after drag:', await page.textContent('#status'), '| placement', await page.evaluate(() => JSON.stringify(state.result.placement)));
  // drag into the used area -> should be refused with a message
  const place2 = JSON.parse(await page.evaluate(() => JSON.stringify(state.result.placement)));
  const g2 = [place2[0] + 3, place2[1] + 2];
  await page.mouse.move(...pp(...g2)); await page.mouse.down();
  await page.mouse.move(...pp(g2[0], 3), { steps: 8 }); await page.mouse.up();
  await page.waitForSelector('.status.err', { timeout: 60000 });
  console.log('into used area:', await page.$$eval('#errors li', (l) => l.map((x) => x.textContent)));
  await prev.screenshot({ path: `${S}/sheet_place_bad.png` });
  // put it back somewhere valid, then mark as cut
  await page.selectOption('#stock', '');
  await page.selectOption('#stock', 'AL-250-01');
  await page.waitForSelector('.status.ok', { timeout: 60000 });
  await page.waitForFunction(() => !document.querySelector('#drop').classList.contains('busy'));
  console.log('cut button:', await page.textContent('#mark-cut'), 'disabled =', await page.isDisabled('#mark-cut'));
  await page.click('#mark-cut');
  await page.waitForFunction(() => document.querySelector('#mark-cut').textContent.startsWith('Recorded'), null, { timeout: 30000 });
  console.log('after mark:', await page.textContent('#cut-msg'));
  console.log('fake db regions:', db.regions.map((r) => `${r.kind}:${r.label}:${r.polygon.length}pts`));
  await page.waitForTimeout(300);
  await prev.screenshot({ path: `${S}/sheet_after_cut.png` });

  await page.click('.view-tab[data-view="sheets"]');
  await page.click('.sheet-card');
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${S}/sheets_view.png`, fullPage: true });
  await page.setViewportSize({ width: 390, height: 900 });
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${S}/sheets_phone.png`, fullPage: true });
  console.log('phone overflow:', await page.evaluate(() => document.documentElement.scrollWidth > innerWidth));
  await browser.close();
})().catch((e) => { console.error('FAILED', e.message); process.exit(1); });
