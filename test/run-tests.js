/* Verifies portal-tasks.js against dev/fixtures.js using the real browser code
   path: a static server, Chromium, the actual module. Asserts the four card
   counts and their exact membership, click-to-filter, scope exclusion, subtask
   nesting, then screenshots light and dark. */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };

const server = http.createServer((req, res) => {
  let p = req.url.split('?')[0];
  if (p === '/') p = '/test/harness.html';
  const candidates = [path.join(ROOT, 'public', p), path.join(ROOT, p), path.join(ROOT, 'test', p)];
  for (const f of candidates) {
    if (fs.existsSync(f) && fs.statSync(f).isFile()) {
      res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'text/plain' });
      return res.end(fs.readFileSync(f));
    }
  }
  res.writeHead(404); res.end('not found ' + p);
});

const expected = JSON.parse(fs.readFileSync(path.join(__dirname, 'expected.json'), 'utf8'));
let failures = 0;
function check(name, actual, want) {
  const a = JSON.stringify(actual), w = JSON.stringify(want);
  const ok = a === w;
  if (!ok) failures++;
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (ok ? '  ' + a : '\n          expected ' + w + '\n          actual   ' + a));
}

(async () => {
  await new Promise(r => server.listen(4173, r));
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  /* The sandbox has no access to fonts.googleapis.com and there is no favicon,
     so those two network failures are harness artefacts, not code faults. */
  const IGNORE = /fonts\.googleapis|favicon|ERR_TUNNEL_CONNECTION_FAILED|404 \(Not Found\)/;
  page.on('console', m => { if (m.type() === 'error' && !IGNORE.test(m.text())) errors.push(m.text()); });

  await page.goto('http://localhost:4173/', { waitUntil: 'networkidle' });
  await page.waitForSelector('.nt-card');

  console.log('\nCard counts');
  const counts = await page.$$eval('.nt-card', els => {
    const o = {};
    els.forEach(e => { o[e.getAttribute('data-card')] = Number(e.querySelector('.nt-card-v').textContent); });
    return o;
  });
  check('open', counts.open, expected.cards.open);
  check('overdue', counts.overdue, expected.cards.overdue);
  check('dueweek', counts.dueweek, expected.cards.dueweek);
  check('completed', counts.completed, expected.cards.completed);

  console.log('\nCard membership and click-to-filter');
  for (const key of ['open', 'overdue', 'dueweek', 'completed']) {
    await page.click(`.nt-card[data-card="${key}"]`);
    await page.waitForTimeout(120);
    const ids = await page.$$eval('#ntBody .nt-row', rs => rs.map(r => r.getAttribute('data-id')));
    check(key + ' rows', ids.slice().sort(), expected.members[key].slice().sort());
    const active = await page.$$eval('.nt-card.on', e => e.map(x => x.getAttribute('data-card')));
    check(key + ' exactly one card active', active, [key]);
  }

  console.log('\nScope and nesting');
  await page.click('.nt-card[data-card="open"]');
  await page.waitForTimeout(120);
  const html = await page.content();
  check('Leadli task T13 absent', /data-id="T13"/.test(html), false);
  const order = await page.$$eval('#ntBody .nt-row', rs => rs.map(r => ({
    id: r.getAttribute('data-id'),
    indent: r.querySelector('.nt-c-name').getAttribute('style') || '',
  })));
  const iT1 = order.findIndex(r => r.id === 'T1');
  const iT12 = order.findIndex(r => r.id === 'T12');
  check('subtask T12 immediately follows parent T1', iT12 === iT1 + 1, true);
  check('subtask T12 is indented', /padding-left/.test(order[iT12] ? order[iT12].indent : ''), true);

  console.log('\nFilters');
  await page.fill('#ntQ', 'brent');
  await page.waitForTimeout(320);
  const qCounts = await page.$$eval('.nt-card', els => {
    const o = {}; els.forEach(e => { o[e.getAttribute('data-card')] = Number(e.querySelector('.nt-card-v').textContent); }); return o;
  });
  check('search narrows the counters too', qCounts.open < expected.cards.open, true);
  await page.fill('#ntQ', '');
  await page.waitForTimeout(320);

  console.log('\nRuntime errors');
  check('no page errors', errors, []);

  console.log('\nScreenshots');
  for (const theme of ['dark', 'light']) {
    await page.evaluate(t => window.__setTheme(t), theme);
    await page.waitForTimeout(200);
    const f = path.join(__dirname, `shot-${theme}.png`);
    await page.screenshot({ path: f, fullPage: true });
    console.log('  wrote ' + path.basename(f));
  }
  await page.click('.nt-row[data-id="T2"] [data-act="open"]');
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(__dirname, 'shot-drawer.png') });
  console.log('  wrote shot-drawer.png');

  await browser.close();
  server.close();
  console.log('\n' + (failures ? failures + ' FAILURE(S)' : 'All checks passed'));
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
