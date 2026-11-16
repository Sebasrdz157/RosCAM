const { chromium } = require('playwright');
const fs = require('fs'), path = require('path');
const S = process.argv[2];

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

  const page = await context.newPage();
  page.on('pageerror', (e) => console.log('pageerror:', e.message));
  page.on('console', (m) => { if (m.type() === 'error') console.log('console error:', m.text().slice(0, 200)); });
  await page.goto('http://localhost:8765/');
  await page.waitForSelector('#engine.ready, #engine.failed', { timeout: 180000 });
  await page.selectOption('#thickness', '1/4');
  await page.setInputFiles('#file', require('path').resolve(__dirname, '../fixtures/roscam_plate.dxf'));
  await page.waitForSelector('.status.ok, .status.err', { timeout: 120000 });
  console.log('status:', await page.textContent('#status'));
  console.log('sim options:', await page.$$eval('#sim-program option', (o) => o.map((x) => x.textContent)));
  console.log('fallback shown:', await page.isVisible('#sim-fallback'));
  console.log('moves (all):', await page.getAttribute('#sim-scrubber', 'max'));

  // Jump partway into the end mill program by scrubbing.
  const max = Number(await page.getAttribute('#sim-scrubber', 'max'));
  await page.$eval('#sim-scrubber', (el, v) => { el.value = v; el.dispatchEvent(new Event('input')); }, Math.round(max * 0.8));
  await page.waitForTimeout(400);
  console.log('label:', await page.textContent('#sim-label'));
  console.log('op:', await page.textContent('#sim-op'));
  const sim = await page.$('#sim-wrap');
  await sim.scrollIntoViewIfNeeded();
  await sim.screenshot({ path: `${S}/sim_scrub.png` });

  // Play one drill program and confirm the scrubber advances.
  await page.selectOption('#sim-program', '1');
  await page.selectOption('#sim-speed', '600');
  await page.click('#sim-play');
  await page.waitForTimeout(1500);
  const v1 = Number(await page.inputValue('#sim-scrubber'));
  console.log('play advanced to move', v1, 'of', await page.getAttribute('#sim-scrubber', 'max'),
    '| button:', await page.textContent('#sim-play'));
  await page.waitForTimeout(800);
  await sim.screenshot({ path: `${S}/sim_drill.png` });
  await browser.close();
})().catch((e) => { console.error('FAILED', e.message); process.exit(1); });
