// Browser test of the Sheets feature with an in-memory stand-in for the Parts Tracker API (fakeparts.js)'s REST API.
const { chromium } = require('playwright');
const fs = require('fs'), path = require('path');
const S = process.argv[2];
const { fakeParts } = require('./fakeparts');

function serve(route, file, type) {
  route.fulfill({ body: fs.readFileSync(file), contentType: type, headers: { 'access-control-allow-origin': '*' } });
}

const db = { sheets: [], regions: [] };

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
  await fakeParts(context, { db, tools: [] });

  const page = await context.newPage();
  page.on('pageerror', (e) => console.log('pageerror:', e.message));
  page.on('console', (m) => { if (m.type() === 'error') console.log('console error:', m.text().slice(0, 200)); });
  page.on('dialog', (d) => d.accept());
  await page.goto(process.env.ROSCAM_URL || 'http://localhost:8765/');
  await page.waitForSelector('#engine.ready', { timeout: 180000 });

  // --- Sheets screen (open editing, no sign-in)
  await page.click('.view-tab[data-view="sheets"]');
  await page.waitForTimeout(300);
  console.log('signed in, gate hidden:', await page.isHidden('#signin-gate'));
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
  console.log('fresh sheet:', await page.textContent('.sheet-card .sheet-cond'), '|', await page.textContent('#ed-condition'));
  await page.selectOption('#f-cond', 'started');
  console.log('partly-used filter (fresh) ->', await page.textContent('#sheet-count'));
  await page.selectOption('#f-cond', '');
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
  console.log('condition now:', await page.textContent('#ed-condition'));
  await page.selectOption('#f-cond', 'started');
  console.log('partly-used filter ->', await page.textContent('#sheet-count'));
  await page.selectOption('#f-cond', 'full');
  console.log('full-sheet filter ->', await page.textContent('#sheet-count'));
  await page.selectOption('#f-cond', '');
  await page.selectOption('#ed-status', 'used_up');
  await page.waitForTimeout(400);
  console.log('finished:', await page.textContent('#sheets-msg'), '| listed:', await page.textContent('#sheet-count'));
  await page.check('#f-used');
  console.log('with finished shown:', await page.textContent('.sheet-card .sheet-free'));
  await page.click('.sheet-card');
  await page.selectOption('#ed-status', 'active');
  await page.waitForTimeout(400);
  await page.uncheck('#f-used');
  await page.screenshot({ path: `${S}/sheets_view.png`, fullPage: true });

  // --- Programs on that sheet (picked from the sheet list; parts are placed by nesting)
  await page.click('.view-tab[data-view="programs"]');
  console.log('stock options:', await page.$$eval('#stock option', (o) => o.map((x) => x.textContent)));
  await page.selectOption('#stock', 'AL-250-01');
  await page.setInputFiles('#file', require('path').resolve(__dirname, '../fixtures/roscam_plate.dxf'));
  await page.waitForSelector('.status.ok, .status.err', { timeout: 180000 });
  await page.waitForFunction(() => !document.querySelector('#drop').classList.contains('busy'));
  console.log('status:', await page.textContent('#status'), '|', await page.textContent('#stock-note'));
  const prev = await page.$('#preview-wrap');
  await prev.scrollIntoViewIfNeeded();
  await prev.screenshot({ path: `${S}/sheet_place_auto.png` });
  const place = await page.evaluate(() => state.result.parts.map((p) => p.label));
  console.log('placed:', place.join(', '));
  await page.screenshot({ path: `${S}/programs_view.png` });

  // mark as cut: pick the parts, record them, and the sheet gets a cut region
  console.log('cut button:', await page.textContent('#mark-cut'), 'disabled =', await page.isDisabled('#mark-cut'));
  await page.click('#mark-cut');
  await page.waitForSelector('#cut-pick:not(.hidden)');
  await page.click('#cut-all');
  await page.click('#cut-save');
  await page.waitForFunction(() => /recorded/i.test(document.querySelector('#mark-cut').textContent), null, { timeout: 30000 });
  console.log('after mark:', await page.textContent('#mark-cut'), '|', await page.textContent('#cut-msg'));
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
