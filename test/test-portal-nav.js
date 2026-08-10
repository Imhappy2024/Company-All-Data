/* Navigation + Property Tasks board checks, run against the real files in a real
   browser (same shape as run-tests.js: static server, Chromium, no mocking of the
   code under test).

   Covers the three things that were wrong:
     1. Every ClickUp-backed Tasks screen shows the sign-in gate when signed out.
        Property Tasks and Tasks > Overview are /ops embeds rather than native, so
        they used to render off the server's shared token with no gate at all.
     2. A reload lands on the screen you were on, not Overview - and the screen
        survives the ClickUp OAuth round trip, which consumes the fragment.
     3. The Property Tasks board has one column per canonical bucket. The list
        carries both ClickUp spellings ("To Do", "in progress") and
        Supabase-originated ones ("OPEN", "IN_PROGRESS") for the same states, and
        grouping on the raw string gave each spelling its own column.

   The expectations below are written from the intended behaviour, not read back
   off the implementation - same rule as test/expected.json. */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
/* .svg matters: served as text/plain an <img> refuses to decode it, the brand
   marks fall back to initials, and the test looks like a product bug. */
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
};
const PORT = 4174;
const BASE = `http://localhost:${PORT}`;

/* Mirrors the two routes server.js exposes for the front ends. /api/* answers
   with an error object, which is what the portal already tolerates offline. */
const server = http.createServer((req, res) => {
  let p = req.url.split('?')[0];
  if (p === '/') p = '/portal.html';
  if (p === '/ops') p = '/index.html';
  if (p.startsWith('/api/')) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    return res.end('{"error":"offline in tests"}');
  }
  for (const f of [path.join(ROOT, 'public', p), path.join(ROOT, p), path.join(ROOT, 'test', p)]) {
    if (fs.existsSync(f) && fs.statSync(f).isFile()) {
      res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'text/plain' });
      return res.end(fs.readFileSync(f));
    }
  }
  res.writeHead(404); res.end('not found ' + p);
});

let failures = 0;
function check(name, actual, want) {
  const a = JSON.stringify(actual), w = JSON.stringify(want);
  const ok = a === w;
  if (!ok) failures++;
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (ok ? '  ' + a : '\n          expected ' + w + '\n          actual   ' + a));
}

/* A Property Tasks list as it actually looks: ClickUp's own statuses, plus rows
   that came in from Supabase with a different spelling of the same state, plus
   the two states the board reports as counters instead of columns. */
const BOARD = {
  statuses: [
    { status: 'To Do', color: '#87909e', type: 'open', orderindex: 0 },
    { status: 'in progress', color: '#4194f6', type: 'custom', orderindex: 1 },
    { status: 'blocked', color: '#e50000', type: 'custom', orderindex: 2 },
    { status: 'in review', color: '#f9d900', type: 'custom', orderindex: 3 },
    { status: 'Complete', color: '#6bc950', type: 'closed', orderindex: 4 },
  ],
  tasks: [
    ptask('T1', 'Test', 'To Do'),
    ptask('T2', 'fix window', 'To Do'),
    ptask('T3', 'Building task test', 'in progress'),
    ptask('T4', 'Q2 investor distributions', 'OPEN', 'error'),
    ptask('T5', 'June close - Folio client A', 'OPEN', 'error'),
    ptask('T6', 'Loan 7a18 rate review', 'OPEN', 'error'),
    ptask('T7', 'Turn unit 4B - Lincoln', 'IN_PROGRESS', 'error'),
    ptask('T8', 'Awaiting sign-off', 'IN_REVIEW'),
    ptask('T9', 'Old thing', 'Complete'),
  ],
};
function ptask(id, name, status, sync) {
  return {
    id, name, status,
    statusType: status === 'Complete' ? 'closed' : null,
    assignees: [], due_date: null, sync_state: sync || 'synced',
    fields: { property: { display: ['Building 1'] }, category: { display: 'Other' } },
  };
}

(async () => {
  await new Promise(r => server.listen(PORT, r));
  /* Use whatever `playwright install chromium` put in place; CHROME_PATH pins it
     for sandboxes. A hardcoded Linux path here made this unrunnable on Windows. */
  const browser = await chromium.launch(
    process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  const boot = () => page.waitForFunction(() => typeof window.render === 'function');

  // ---------------------------------------------------------------- gating
  console.log('\nThe portal lands on Executive Board');
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await boot();
  check('default workspace and screen', await page.evaluate(() => [brand, view]), ['all', 'exec']);
  check('and it is a real screen, not a placeholder',
    await page.evaluate(() => !!document.querySelector('#content .kpi')), true);

  console.log('\nClickUp gate on the Tasks screens (signed out)');
  /* Property Tasks only exists under LeavenWealth. */
  await page.evaluate(() => { setBrand('leavenwealth'); setView('tasks'); setTasksTab('ptasks'); });
  check('Property Tasks shows the gate', await page.locator('.pa-gate-card').count(), 1);
  check('Property Tasks embeds nothing', await page.locator('#embedHost iframe:visible').count(), 0);
  check('the tab strip stays usable', await page.locator('.segbtn.on').textContent(), 'Property Tasks');
  await page.evaluate(() => setTasksTab('overview'));
  check('Tasks > Overview shows the gate', await page.locator('.pa-gate-card').count(), 1);
  await page.evaluate(() => { setBrand('all'); setView('alltasks'); });
  check('Executive All Tasks shows the gate', await page.locator('.pa-gate-card').count(), 1);

  console.log('\nThe gate is scoped to Tasks, not the app');
  await page.evaluate(() => { setBrand('leavenwealth'); setView('properties'); });
  check('Properties still embeds /ops', await page.locator('#embedHost iframe:visible').count(), 1);
  check('Properties is not gated', await page.locator('.pa-gate-card').count(), 0);
  await page.evaluate(() => setView('financials'));
  check('Financials is not gated', await page.locator('.pa-gate-card').count(), 0);

  // ------------------------------------------------------------ brand marks
  console.log('\nBrand marks');
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await boot();
  await page.click('.bp-btn');
  const marks = await page.$$eval('#bpMenu .bp-dot', els => els.map(e => ({
    brand: e.getAttribute('data-brand'),
    src: e.querySelector('img') ? new URL(e.querySelector('img').src).pathname : null,
    fallback: e.querySelector('img') ? null : e.textContent,
  })));
  check('every brand in the menu has a mark', marks.map(m => m.brand),
    ['all', 'leavenwealth', 'leadli', 'folio', 'liquid']);
  check('and it is the brand\'s own artwork', marks.map(m => m.src), [
    '/icons/exec-mark.svg', '/icons/leavenwealth-mark.svg',
    '/icons/leadli-mark.svg', '/icons/folio-mark.svg', '/icons/liquid-mark.svg']);
  /* Every referenced file must exist, or the chip silently falls back to
     initials in production and nobody notices until someone looks. */
  const missing = [];
  for (const m of new Set(marks.map(v => v.src))) {
    const r = await page.request.get(BASE + m);
    if (!r.ok()) missing.push(m);
  }
  check('every mark file resolves', missing, []);
  check('the marks actually decode', await page.$$eval('#bpMenu .bp-dot img',
    els => els.every(i => i.complete && i.naturalWidth > 0)), true);
  check('the switcher button follows the brand', await page.evaluate(() => {
    setBrand('liquid');
    return new URL(document.querySelector('#bpGlyph img').src).pathname;
  }), '/icons/liquid-mark.svg');
  check('and it keeps its id across brands', await page.evaluate(() => {
    setBrand('leadli');
    return !!document.getElementById('bpGlyph');
  }), true);
  /* A brand with no artwork, or artwork that 404s, must still show something. */
  check('a broken mark degrades to initials', await page.evaluate(() => {
    BRANDS.liquid.logo = '/icons/does-not-exist.svg';
    setBrand('liquid');
    return new Promise(res => setTimeout(() => {
      const g = document.getElementById('bpGlyph');
      res([g.textContent, g.classList.contains('has-logo')]);
    }, 250));
  }), ['LL', false]);
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await boot();

  // ------------------------------------------------------- state in the URL
  console.log('\nThe screen survives a reload');
  await page.evaluate(() => { setBrand('leavenwealth'); setView('loans'); setLoansTab('views'); });
  check('written to the fragment', await page.evaluate(() => location.hash), '#brand=leavenwealth&view=loans&sub=views');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await boot();
  check('still on Loans > Loan Views', await page.evaluate(() => [brand, view, loansTab]), ['leavenwealth', 'loans', 'views']);
  await page.evaluate(() => { setBrand('folio'); setView('plans'); });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await boot();
  check('the brand survives too', await page.evaluate(() => [brand, view]), ['folio', 'plans']);

  console.log('\nA fragment that no longer means anything degrades, never blanks');
  await page.goto('about:blank');
  await page.goto(`${BASE}/#brand=nope&view=nope&sub=nope`, { waitUntil: 'domcontentloaded' });
  await boot();
  check('falls back to the default screen', await page.evaluate(() => [brand, view]), ['all', 'exec']);
  check('and still paints', await page.evaluate(() => document.getElementById('content').children.length > 0), true);
  await page.goto('about:blank');
  await page.goto(`${BASE}/#brand=folio&view=properties`, { waitUntil: 'domcontentloaded' });
  await boot();
  check('a view the brand does not have is dropped', await page.evaluate(() => [brand, view]), ['folio', 'overview']);
  await page.evaluate(() => { location.hash = '#brand=leadli&view=ads'; });
  await page.waitForTimeout(150);
  check('pasting a link into an open tab navigates', await page.evaluate(() => [brand, view]), ['leadli', 'ads']);

  console.log('\nThe screen survives the ClickUp round trip');
  /* /auth/callback appends #auth=<token>, so the return path cannot carry a
     fragment of its own - the screen rides back in ?v= instead. */
  await page.goto('about:blank');
  await page.goto(`${BASE}/#brand=leavenwealth&view=tasks&sub=ptasks`, { waitUntil: 'domcontentloaded' });
  await boot();
  const state = await page.evaluate(() => new URL(document.querySelector('.pa-gate-btn').href).searchParams.get('state'));
  check('the return path has no fragment', state.includes('#'), false);
  const v = new URLSearchParams(state.split('?')[1]).get('v');
  check('it carries the screen', Object.fromEntries(new URLSearchParams(v)), { brand: 'leavenwealth', view: 'tasks', sub: 'ptasks' });
  await page.goto(`${BASE}/?v=${encodeURIComponent(v)}`, { waitUntil: 'domcontentloaded' });
  await boot();
  check('and lands back on Property Tasks', await page.evaluate(() => [view, tasksTab]), ['tasks', 'ptasks']);
  check('the hand-back param is consumed', await page.evaluate(() => location.search), '');

  // ------------------------------------------------------ the /ops PT board
  console.log('\nProperty Tasks board: one column per canonical bucket');
  await page.goto(`${BASE}/ops`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof window.renderPTBoard === 'function');
  await page.evaluate((fx) => {
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.getElementById('view-properties').classList.add('active');
    document.getElementById('prop-sub-properties').hidden = true;
    document.getElementById('prop-sub-tasks').hidden = false;
    propTasksData = fx;              /* the page's script-scoped binding */
    propTasksLoaded = true;
    ptApply();                       /* the real entry point: filters, metrics, board */
  }, BOARD);

  const cols = await page.$$eval('#ptasks-board .card', els => els.map(e => ({
    title: e.querySelector('.card-title').textContent,
    desc: e.querySelector('.card-desc').textContent,
    count: e.querySelector('.card-count').textContent,
    rows: [...e.querySelectorAll('.task-row .task-link')].map(a => a.textContent).sort(),
  })));
  check('columns', cols.map(c => c.title), ['To Do', 'In Progress', 'Blocked']);
  check('To Do absorbs OPEN', cols[0].rows,
    ['June close - Folio client A', 'Loan 7a18 rate review', 'Q2 investor distributions', 'Test', 'fix window']);
  check('In Progress absorbs IN_PROGRESS', cols[1].rows, ['Building task test', 'Turn unit 4B - Lincoln']);
  check('counts match the rows', cols.map(c => c.count), ['5', '2', '0']);
  check('Blocked stays visible while empty', cols[2].desc, 'Stuck on a dependency');
  check('In Review and Complete are counters, not columns',
    cols.flatMap(c => c.rows).filter(n => n === 'Awaiting sign-off' || n === 'Old thing'), []);
  /* Both of those must still be reachable somewhere, or hiding them from the
     columns would simply lose them. */
  check('and they are still counted', await page.evaluate(() => [ptDrillList('inreview').length, ptDrillList('complete').length]), [1, 1]);

  console.log('\nSeparators are not part of a status name');
  check('status key', await page.evaluate(() => ['IN_PROGRESS', 'in progress', 'in_review', 'to-do'].map(getStatusKey)),
    ['inprogress', 'inprogress', 'inreview', 'todo']);
  check('canonical bucket', await page.evaluate(() => ['IN_PROGRESS', 'OPEN', 'in_review', 'long-term'].map(toCanonicalFallback)),
    ['In Progress', 'To Do', 'In Review', 'Long Term']);

  console.log('\nThe sync chip is a chip, not a full-width bar');
  const geo = await page.evaluate(() => {
    const row = [...document.querySelectorAll('#ptasks-board .task-row')].find(r => r.querySelector('.pt-sync-error'));
    const b = row.querySelector('.pt-sync-error').getBoundingClientRect();
    const a = row.querySelector('.task-link').getBoundingClientRect();
    return { onNameLine: Math.abs(b.top - a.top) < 6, narrow: b.width < row.getBoundingClientRect().width * 0.3 };
  });
  check('it sits on the name line', geo.onNameLine, true);
  check('it does not span the row', geo.narrow, true);

  await page.screenshot({ path: path.join(__dirname, 'shot-ptasks-board.png'), fullPage: false });
  console.log('  wrote shot-ptasks-board.png');

  await browser.close();
  server.close();
  console.log(failures ? `\n${failures} FAILURE(S)` : '\nAll checks passed');
  process.exit(failures ? 1 : 0);
})();
