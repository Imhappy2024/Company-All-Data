/* End-to-end smoke test against the REAL server (node server.js on :3000).
   Proves the wiring, not just the modules: that portal.html loads the three
   scripts, that the Tasks tab shows the sign-in gate when signed out, that the
   native screen renders inside the real portal shell once signed in, and that
   the SSE connection actually opens. */
const path = require('path');
const { chromium } = require('playwright');

const BASE = process.env.SMOKE_BASE || 'http://localhost:3000';
/* Undefined means "use the browser playwright installed", which is what any
   normal machine wants; CHROME_PATH pins it for sandboxes. */
const CHROME = process.env.CHROME_PATH || undefined;

let failures = 0;
function check(name, actual, want) {
  const a = JSON.stringify(actual), w = JSON.stringify(want);
  const ok = a === w;
  if (!ok) failures++;
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (ok ? '  ' + a : '\n          expected ' + w + '\n          actual   ' + a));
}

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME });
  const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
  const errors = [];
  const IGNORE = /fonts\.googleapis|favicon|jsdelivr|ERR_TUNNEL|ERR_NAME|Failed to load resource/;
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error' && !IGNORE.test(m.text())) errors.push(m.text()); });

  console.log('\nPortal boot');
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(900);
  check('the three modules are present', await page.evaluate(() =>
    [!!window.PortalAuth, !!window.PortalTasks, !!window.PortalRealtime]), [true, true, true]);
  check('sidebar rendered', await page.$$eval('.nav-item', n => n.length > 0), true);

  console.log('\nSSE connected to the live server');
  const health = await page.evaluate(b => fetch(b + '/api/events/health').then(r => r.json()), BASE);
  check('server sees a listener', health.listeners >= 1, true);
  check('secret reported unset (fails closed)', health.secretConfigured, false);

  console.log('\nTasks, signed out');
  await page.evaluate(() => { localStorage.removeItem('du_auth_token'); localStorage.removeItem('du_auth_user'); });
  await page.evaluate(() => { setView('tasks'); setTasksTab('all'); });
  await page.waitForTimeout(500);
  check('sign-in gate shown', await page.$$eval('.pa-gate', n => n.length), 1);
  check('gate points at /auth/clickup with a state', await page.$eval('.pa-gate-btn', a =>
    /\/auth\/clickup\?state=/.test(a.getAttribute('href'))), true);
  check('sidebar still usable behind the gate', await page.$$eval('.nav-item', n => n.length > 0), true);
  check('no iframe for the All Tasks tab', await page.$$eval('#embedHost iframe', f =>
    f.filter(x => x.style.display !== 'none').length), 0);
  await page.screenshot({ path: path.join(__dirname, 'smoke-gate.png') });

  console.log('\nTasks, signed in (fixture payload, real shell)');
  const fixture = require('fs').readFileSync(path.join(__dirname, 'fixtures.js'), 'utf8');
  await page.route('**/api/tasks*', route => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify(page.__fx),
  }));
  await page.evaluate(fx => {
    const w = {}; new Function('window', fx)(w);
    window.__FX = w.__FIXTURE;
    localStorage.setItem('du_auth_token', 'fake');
    localStorage.setItem('du_auth_user', JSON.stringify({ id: 1, username: 'Smoke Test' }));
  }, fixture);
  page.__fx = await page.evaluate(() => window.__FX);
  await page.unroute('**/api/tasks*');
  await page.route('**/api/tasks*', route => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify(page.__fx) }));
  await page.route('**/auth/me', route => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ user: { id: 1, username: 'Smoke Test' } }) }));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(700);
  await page.evaluate(() => { setView('tasks'); setTasksTab('all'); });
  await page.waitForSelector('.nt-card', { timeout: 8000 });

  const counts = await page.$$eval('.nt-card', els => {
    const o = {}; els.forEach(e => { o[e.getAttribute('data-card')] = Number(e.querySelector('.nt-card-v').textContent); }); return o;
  });
  check('counters render in the real shell', counts, { open: 12, overdue: 1, dueweek: 6, completed: 2 });
  check('no space filter on this screen', await page.$$eval('.nt-bar .nt-dd', d =>
    d.map(x => x.getAttribute('data-field')).sort()), ['assignee', 'priority', 'status']);
  await page.click('.nt-card[data-card="overdue"]');
  await page.waitForTimeout(250);
  check('clicking Overdue swaps the list', await page.$$eval('#ntBody .nt-row', r => r.length), 1);
  await page.screenshot({ path: path.join(__dirname, 'smoke-tasks-dark.png'), fullPage: true });
  await page.evaluate(() => toggleTheme());
  await page.waitForTimeout(250);
  await page.screenshot({ path: path.join(__dirname, 'smoke-tasks-light.png'), fullPage: true });
  await page.evaluate(() => toggleTheme());

  console.log('\nOther views still work');
  for (const [b, v] of [['leavenwealth', 'properties'], ['leavenwealth', 'loans'], ['all', 'alltasks']]) {
    await page.evaluate(([bb, vv]) => { setBrand(bb); setView(vv); }, [b, v]);
    await page.waitForTimeout(400);
  }
  check('embeds still mount for Properties / Loan Views / Executive Board',
    await page.$$eval('#embedHost iframe', f => f.length >= 1), true);

  console.log('\nRuntime errors');
  check('no page errors', errors, []);

  await browser.close();
  console.log('\n' + (failures ? failures + ' FAILURE(S)' : 'All checks passed'));
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
