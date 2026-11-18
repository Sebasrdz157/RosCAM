// Browser test of signing in (fake Auth0) and of the view-only role.
const { chromium } = require('playwright');
const fs = require('fs'), path = require('path');
const S = process.argv[2];
const { fakeParts } = require('./fakeparts');

const db = {
  sheets: [{ id: 'AL-250-01', material: 'aluminum', thickness: '1/4', width: 24, height: 48, status: 'active',
             notes: '', created_at: '2026-01-01' }],
  regions: [],
};

function serve(route, file, type) {
  if (!fs.existsSync(file)) { console.log('missing', file); return route.abort(); }
  route.fulfill({ body: fs.readFileSync(file), contentType: type, headers: { 'access-control-allow-origin': '*' } });
}

(async () => {
  const browser = await chromium.launch({ proxy: { server: process.env.HTTPS_PROXY, bypass: 'localhost,127.0.0.1' } });
  const context = await browser.newContext({ viewport: { width: 1000, height: 1000 } });
  // Sandbox only: the CDNs are blocked here, so serve the same releases from local copies.
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

  const parts = await fakeParts(context, { db, tools: [], signedIn: false, canEdit: false });

  const page = await context.newPage();
  page.on('pageerror', (e) => console.log('pageerror:', e.message));
  page.on('dialog', (d) => d.accept());
  await page.goto(process.env.ROSCAM_URL || 'http://localhost:8765/');
  await page.waitForSelector('#signin-gate:not(.hidden)', { timeout: 30000 });
  console.log('signed out: gate shown =', await page.isVisible('#signin-gate'), '| user box =', await page.isVisible('#user-box'));
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${S}/auth_gate.png` });

  await page.click('#signin-btn');
  await page.waitForSelector('#signin-gate', { state: 'hidden' });
  await page.waitForFunction(() => document.querySelectorAll('#stock option').length > 0, null, { timeout: 180000 });
  console.log('signed in as:', await page.textContent('#user-name'), '| view-only pill =', await page.isVisible('#user-role'));
  console.log('sheet menu:', await page.$$eval('#stock option', (o) => o.map((x) => x.textContent)));

  // view-only: buttons greyed out, and the server refuses anyway
  await page.click('.view-tab[data-view="sheets"]');
  await page.waitForSelector('.sheet-card');
  console.log('add sheet disabled =', await page.isDisabled('#new-sheet'));
  const refused = await page.evaluate(() => RosDB.addSheet({ id: 'X-1', material: 'aluminum', thickness: '1/4' }).then(() => 'saved', (e) => e.message));
  console.log('write as view-only:', refused);
  await page.click('.view-tab[data-view="tools"]');
  console.log('add bit disabled =', await page.isDisabled('#new-tool'));

  // promoted to Assignee: sign in again and it can edit
  parts.user.canEdit = true;
  await page.reload();
  await page.waitForSelector('#user-box:not(.hidden)', { timeout: 30000 });
  await page.click('.view-tab[data-view="sheets"]');
  await page.waitForFunction(() => !document.querySelector('#new-sheet').disabled);
  console.log('editor: pill =', await page.isVisible('#user-role'), '| add sheet enabled =', !(await page.isDisabled('#new-sheet')));
  await page.screenshot({ path: `${S}/auth_editor.png`, clip: { x: 0, y: 0, width: 1000, height: 60 } });

  await page.click('#signout-btn');
  await page.waitForSelector('#signin-gate:not(.hidden)', { timeout: 30000 });
  console.log('after sign out: gate shown =', await page.isVisible('#signin-gate'));
  await browser.close();
})().catch((e) => { console.error('FAILED', e.message); process.exit(1); });
