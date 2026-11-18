// Browser test of choosing a machine: the Avid PRO4848 gets its own bits and one .cnc file
// with every bit in it; the shop's machine is unchanged.
const { chromium } = require('playwright');
const fs = require('fs'), path = require('path');
const S = process.argv[2];
const { fakeParts } = require('./fakeparts');
const startEmpty = false;
// A bit saved before machines existed (no machine field): the shop's.
const shopBits = [{ id: 'endmill_1_8', name: 'Shop 1/8 end mill', type: 'endmill', diameter: 0.125, flute_length: 0.5,
  spindle_speed: 18000, feed_rate: 40, plunge_rate: 5, ramp_feed_rate: 15, stepdown: 0.02, active: true }];

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
  const parts = await fakeParts(context, { db, tools: shopBits });

  const page = await context.newPage();
  page.on('pageerror', (e) => console.log('pageerror:', e.message));
  page.on('dialog', (d) => d.accept());
  await page.goto(process.env.ROSCAM_URL || 'http://localhost:8765/');
  await page.waitForSelector('#engine.ready', { timeout: 180000 });
  await page.waitForFunction(() => !document.querySelector('#machine').disabled);
  console.log('machines:', await page.$$eval('#machine option', (o) => o.map((x) => `${x.value}=${x.textContent}`)),
              '| chosen:', await page.inputValue('#machine'));

  await page.selectOption('#machine', 'avid');
  await page.waitForFunction(() => state.options.machine.id === 'avid' && !document.querySelector('#machine').disabled);
  await page.click('.view-tab[data-view="tools"]');
  await page.waitForSelector('.tool-card');
  console.log('tools heading:', (await page.textContent('#view-tools h2')).trim());
  console.log('avid bits:', await page.$$eval('.tool-card strong', (l) => l.map((x) => x.textContent)));
  await page.click('.tool-card');
  console.log('tool number shown:', await page.$$eval('#tool-view-list dt', (l) => l.map((x) => x.textContent)).then((l) => l[0]));

  // a new bit for the Avid needs its T number and is saved as the Avid's
  await page.click('#new-tool');
  await page.fill('#t-name', '1/16" end mill');
  await page.fill('#t-fields input[data-key="diameter"]', '1/16');
  await page.fill('#t-fields input[data-key="flute_length"]', '1/4');
  await page.click('#tool-form button[type=submit]');
  console.log('without T number: blocked =', await page.$eval('#t-fields input[data-key="tool_number"]', (i) => !i.checkValidity()),
              '| saved =', parts.tools.some((t) => t.name === '1/16" end mill'));
  await page.fill('#t-fields input[data-key="tool_number"]', '7');
  await page.click('#tool-form button[type=submit]');
  await page.waitForFunction(() => /Added/.test(document.querySelector('#tools-msg').textContent));
  const saved = parts.tools.find((t) => t.name === '1/16" end mill');
  console.log('saved:', saved.id, saved.machine, 'T' + saved.tool_number);
  console.log('avid bits now:', await page.$$eval('.tool-card strong', (l) => l.map((x) => x.textContent)));

  // a job on the Avid: one .cnc with every bit
  await page.click('.view-tab[data-view="programs"]');
  await page.selectOption('#stock', 'AL-250-01');
  await page.setInputFiles('#file', ['plate.dxf', 'small.dxf'].map((f) => path.join(S, 'parts', f)));
  await page.waitForFunction(() => /Tried \d+ layouts/.test(document.querySelector('#nest-status').textContent), null, { timeout: 90000 });
  await page.click('#nest-stop');
  await page.waitForSelector('.status.ok', { timeout: 120000 });
  console.log('status:', await page.textContent('#status'));
  console.log('program rows:', await page.$$eval('#programs li', (l) => l.map((x) => x.querySelector('.file').textContent + (x.querySelector('.btn') ? ' [btn]' : ''))));
  console.log('files menu:', await page.$$eval('#out-format option', (o) => o.map((x) => x.textContent)));
  console.log('buttons:', await page.textContent('#combined-dl'), '|', await page.textContent('#zip'));
  const [cnc] = await Promise.all([page.waitForEvent('download'), page.click('#combined-dl')]);
  await cnc.saveAs(`${S}/job.cnc`);
  const text = fs.readFileSync(`${S}/job.cnc`, 'utf8');
  console.log('download:', cnc.suggestedFilename(), '| CRLF:', text.includes('\r\n'), '| first:', text.split('\r\n')[0],
              '| tool changes:', (text.match(/N\d+ T\d+ M6/g) || []).map((l) => l.split(' ')[1]).join(','),
              '| ends:', text.trimEnd().split('\r\n').pop());
  console.log('setup sheet says:', (await page.textContent('#sheet')).split('\n').filter((l) => /one file|T\d /.test(l)).join(' / '));
  const [z] = await Promise.all([page.waitForEvent('download'), page.click('#zip')]);
  await z.saveAs(`${S}/job.zip`);
  console.log('zip:', require('child_process').execFileSync('python3', ['-c',
    'import sys,zipfile; print(sorted(zipfile.ZipFile(sys.argv[1]).namelist()))', `${S}/job.zip`]).toString().trim());
  await page.screenshot({ path: `${S}/avid_job.png` });

  // plain G-code still possible: one .nc per bit
  await page.selectOption('#out-format', 'nc');
  console.log('nc rows:', await page.$$eval('#programs li', (l) => l.map((x) => x.querySelector('.file').textContent + (x.querySelector('.btn') ? ' [btn]' : ''))));
  await page.selectOption('#out-format', 'mmg');

  // remembered after a reload
  await page.reload();
  await page.waitForSelector('#engine.ready', { timeout: 180000 });
  await page.waitForFunction(() => !document.querySelector('#machine').disabled);
  console.log('after reload:', await page.inputValue('#machine'));

  // back to the shop: its own bits and .mmg files again
  await page.selectOption('#machine', 'shop');
  await page.waitForFunction(() => state.options.machine.id === 'shop' && !document.querySelector('#machine').disabled);
  await page.click('.view-tab[data-view="tools"]');
  console.log('shop bits:', await page.$$eval('.tool-card strong', (l) => l.map((x) => x.textContent)));
  await page.click('.view-tab[data-view="programs"]');
  await page.selectOption('#stock', 'AL-250-01');
  await page.setInputFiles('#file', [path.join(S, 'parts', 'small.dxf')]);
  await page.waitForSelector('.status.ok', { timeout: 120000 });
  await page.waitForFunction(() => /\.mmg$/.test(document.querySelector('#programs .file').textContent), null, { timeout: 60000 });
  console.log('shop rows:', await page.$$eval('#programs .file', (l) => l.map((x) => x.textContent)),
              '| one-file button hidden:', await page.isHidden('#combined-dl'));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(300);
  console.log('phone overflow:', await page.evaluate(() => document.documentElement.scrollWidth > innerWidth));
  await browser.close();
})().catch((e) => { console.error('FAILED', e.message); process.exit(1); });
