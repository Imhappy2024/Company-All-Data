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
  /* See run-tests.js: default to the installed browser, CHROME_PATH to pin it. */
  const browser = await chromium.launch(
    process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();

  /* portal.html is gated on a Supabase session as of the login step: with no
     session it redirects to /login, so this harness - which serves static files
     and answers every /api/* with 503 - would never reach window.render.

     Replace portal-session.js with a stub that reports a signed-in owner. This
     test is about navigation, the ClickUp gate and the Property Tasks board; the
     Supabase session layer has its own coverage in test-login.js. Stubbing at the
     network layer keeps the product code free of test backdoors.

     The payload must be an owner holding EVERY scope at write, using the REAL
     company UUIDs from BRAND_COMPANY_ID. The permission gate refuses setBrand and
     setView for anything absent from it, so a partial payload makes this test fail
     as though navigation were broken - which is exactly what a placeholder company
     id did. The nav id lists below mirror MENUS, i.e. the 49 dashboard_module rows. */
  const FULL = (function () {
    const w = ids => ids.reduce((o, k) => { o[k] = 'write'; return o; }, {});
    return {
      user: { id: 's-test', email: 'owner@example.invalid', full_name: 'Test Owner',
              avatar_url: null, role: 'owner' },
      companies: {
        'c0000000-0000-4000-8000-000000000001': 'Leadli AI',
        'c0000000-0000-4000-8000-000000000002': 'Folio Excel',
        'c0000000-0000-4000-8000-000000000003': 'LeavenWealth',
        'c0000000-0000-4000-8000-000000000004': 'Liquid Lending Solutions',
      },
      access: {
        exec: w(['exec', 'orgdept', 'team', 'alltasks', 'financials', 'investors', 'integrations', 'access']),
        'c0000000-0000-4000-8000-000000000003': w(['overview', 'properties', 'loans', 'investors',
          'insurance', 'tasks', 'leads', 'team', 'departments', 'tools', 'financials', 'documents']),
        'c0000000-0000-4000-8000-000000000001': w(['overview', 'leads', 'appointments', 'ads',
          'tasks', 'team', 'departments', 'tools', 'financials', 'documents']),
        /* Folio has NO 'financials' here, and that mirrors the live catalog:
           dashboard_module carries a financials row for exec, LeavenWealth,
           Leadli and Liquid but not for Folio (verified 2026-09-07).

           That is no longer a gap to close - it is why Folio's one Financials
           item sits on the `reports` nav id, which IS granted. Do not add
           'financials' here to make something pass; it would grant a nav id
           Folio's menu no longer carries. */
        'c0000000-0000-4000-8000-000000000002': w(['overview', 'subscribers', 'plans', 'reports',
          'tasks', 'leads', 'team', 'departments', 'tools', 'documents']),
        'c0000000-0000-4000-8000-000000000004': w(['overview', 'pipeline', 'borrowers', 'tasks',
          'leads', 'team', 'tools', 'financials', 'documents']),
      },
    };
  })();

  await page.route('**/portal-session.js', route => route.fulfill({
    status: 200, contentType: 'application/javascript',
    body: `window.PortalSession = {
      enforceRememberWindow: function(){ return Promise.resolve(false); },
      getSession: function(){ return Promise.resolve({ user: { id: 'test-user' } }); },
      access: function(){ return Promise.resolve(${JSON.stringify(FULL)}); },
      client: function(){ return Promise.resolve({ auth: {
        onAuthStateChange: function(){}, getSession: function(){ return Promise.resolve({ data: { session: null } }); } } }); },
      signOut: function(){ return Promise.resolve(); },
      isRemembered: function(){ return false; },
      config: function(){ return Promise.resolve({ url: 'http://stub', anonKey: 'stub' }); },
    };`,
  }));

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
  /* Properties is NATIVE now - the /ops iframe is gone (see "Properties: the
     command-center port"). This asserts the absence deliberately: the check it
     replaced passed for as long as the embed existed, so leaving it would have
     failed on the port rather than on a regression. */
  check('Properties no longer embeds /ops', await page.locator('#embedHost iframe:visible').count(), 0);
  check('Properties renders its own container', await page.locator('#propertiesNative').count(), 1);
  check('Properties is not gated', await page.locator('.pa-gate-card').count(), 0);
  await page.evaluate(() => setView('financials'));
  check('Financials is not gated', await page.locator('.pa-gate-card').count(), 0);

  /* ---- Financials: one nav item everywhere, one BUILT screen ------------
     Every brand carries the item, because every brand is getting a view. Only
     the brands whose view exists get the built one — it reads LeavenWealth's
     accounts and excludes the other brands at the API level, so pointing
     Leadli at it put "Leadli AI / Financials" above $225.42M of LeavenWealth
     debt.

     These assert the promise rather than the current contents of
     FINANCIALS_BUILT: adding a brand there the day its view ships should make
     one of these fail and be updated deliberately. */
  console.log('\nFinancials is per-brand');
  check('LeavenWealth gets the built screen',
    await page.locator('#financialsNative').count(), 1);
  check('and no generic page header over it',
    await page.locator('.page-h .page-t').count(), 0);

  /* Folio is absent here on purpose, and for a second reason now: it HAS a
     screen (its own, reading Whop billing) so it would not show the
     placeholder anyway. Its `financials` dashboard_module row also does not
     exist, so the item cannot appear at all. Both are asserted below. */
  for (const b of ['leadli', 'liquid']) {
    await page.evaluate(brand => { setBrand(brand); setView('financials'); }, b);
    check(b + ' does NOT get the built screen',
      await page.locator('#financialsNative').count(), 0);
    check(b + ' says its financials are not set up',
      /not set up yet/.test(await page.locator('#content').textContent()), true);
    /* The placeholder keeps the generic header, so the brand is named. */
    check(b + ' keeps a header naming the screen',
      await page.locator('.page-h .page-t').count(), 1);
    /* The whole point: the screen that was wrong showed a real total under the
       wrong name, so the placeholder carries no figures at all. */
    check(b + ' placeholder carries no figures',
      /\$[\d,]/.test(await page.locator('#content').textContent()), false);
  }

  /* THE PER-BRAND OVERVIEW ITEMS ARE GONE, removed 2026-09-07 by instruction,
     along with V.overview() behind them. Every version was baked, and three of
     LeavenWealth's four KPIs were known to be wrong.

     The FULL fixture still GRANTS 'overview' for each brand - a
     dashboard_module row outliving a screen is normal here - so this also
     proves a live grant cannot put the item back. */
  for (const b of ['leavenwealth', 'leadli', 'folio', 'liquid']) {
    await page.evaluate((brand) => setBrand(brand), b);
    check(b + ' has no Overview item',
      await page.$$eval('#nav .nav-item span:first-of-type',
        els => els.map(e => e.textContent.trim()).filter(t => /^overview$/i.test(t))), []);
    check(b + ' has no Overview section label',
      await page.$$eval('#nav .nav-lbl',
        els => els.map(e => e.textContent.trim()).filter(t => /^overview$/i.test(t))), []);
  }
  check('and the view function went with them',
    await page.evaluate(() => typeof V.overview), 'undefined');

  /* EVERY BRAND HAS EXACTLY ONE FINANCIALS ITEM, AND IT IS CALLED "Financials".

     Folio had two: `reports` labelled "Reports & Financials" and `financials`
     labelled "Financials". Only the first could ever appear — verified live,
     Folio has a `reports` dashboard_module row and no `financials` one — so
     the label moved onto `reports` and the dead entry was deleted, which
     needs no migration.

     The id and the label therefore differ for this one brand, and that is
     the thing worth pinning: a future reader who "fixes" the id by pointing
     the menu at `financials` makes the screen disappear for Folio. */
  for (const b of ['leavenwealth', 'leadli', 'folio', 'liquid']) {
    await page.evaluate((brand) => setBrand(brand), b);
    const labels = await page.$$eval('#nav .nav-item span:first-of-type',
      els => els.map(e => e.textContent.trim()));
    check(b + ' has exactly one Financials item',
      labels.filter(l => /financial/i.test(l)), ['Financials']);
  }

  /* And Folio's is the `reports` id, so a stale link to it still resolves
     while a link to `financials` degrades rather than blanking. */
  await page.evaluate(() => { setBrand('folio'); setView('reports'); });
  check('Folio Financials is the reports id',
    await page.evaluate(() => [brand, view]), ['folio', 'reports']);
  await page.evaluate(() => { setBrand('folio'); setView('financials'); });
  check('and folio has no financials view to fall into',
    await page.evaluate(() => [brand, view]), ['folio', 'subscribers']);
  check('so it cannot borrow the LeavenWealth screen',
    await page.locator('#financialsNative').count(), 0);

  /* Plans & Pricing was removed from Folio on 2026-09-07, along with the
     baked PLANS array behind it. The FULL fixture still GRANTS `plans` — as it
     does `investors`, `insurance` and `integrations` — because a catalog row
     outliving a screen is the normal state of affairs here, and the thing worth
     pinning is that a live grant cannot put a removed item back in the nav. */
  await page.evaluate(() => { setBrand('folio'); });
  check('Folio no longer offers Plans & Pricing',
    await page.$$eval('#nav .nav-item span:first-of-type',
      els => els.map(e => e.textContent).filter(t => /plans|pricing/i.test(t))), []);
  /* Read from MENUS as well as from the rendered nav: the grant is live, so a
     re-added menu entry would render, and a check on the DOM alone would pass
     for a brand the user happened not to be looking at. */
  check('and no brand offers it',
    await page.evaluate(() => Object.keys(MENUS).filter(
      b => MENUS[b].some(i => i.id === 'plans'))), []);
  check('the view function went with it',
    await page.evaluate(() => typeof V.plans), 'undefined');
  /* A stale fragment pointing at it must degrade to the brand's first screen,
     not leave the page blank — the same guarantee as any unknown view. */
  await page.goto(`${BASE}/#brand=folio&view=plans`, { waitUntil: 'domcontentloaded' });
  await boot();
  check('a link to the old screen lands on the brand first screen',
    await page.evaluate(() => [brand, view]), ['folio', 'subscribers']);

  /* Folio's Reports & Financials, and App Users, are now LIVE - both painted
     by portal-folio-fin.js from /api/folio/financials. Between them they used
     to carry every invented figure in the brand: MRR $2,369, ARR $28.4K, NRR
     104%, "Active users 4", 774 units billed, six invented companies, and an
     Apr-Jul MRR trend whose only real payment is dated 17 Aug 2026.

     This harness answers every /api/* with 503, so the module renders its
     error state. That is exactly what makes the check strong: a screen with
     no data available must show NO figure at all, and any $ or % appearing
     here is a number that came from the file rather than the database. */
  for (const [v, id] of [['reports', 'folioReportsNative'], ['subscribers', 'folioUsersNative']]) {
    await page.evaluate((view) => { setBrand('folio'); setView(view); }, v);
    check('folio ' + v + ' renders the live container',
      await page.locator('#' + id).count(), 1);
    const text = await page.locator('#content').textContent();
    check('folio ' + v + ' bakes no figure',
      (text.match(/\$[\d,]+|\d+(\.\d+)?%/g) || []), []);
    check('folio ' + v + ' names no invented tier or metric',
      (text.match(/starter|growth|scale|\bARR\b|retention|MoM/gi) || []), []);
  }

  /* ICON NAMES ARE STRINGS, AND A MISSING ONE IS SILENT.
     The nav declares its icon as `ic:'card'`, but the views pass icon names as
     plain arguments - kpi('card', 'Past due', …). Removing the `card` glyph
     alongside the nav entry that named it therefore broke App Users, where
     `I['card']` became undefined and rendered as nothing at all. Grepping the
     nav form said "one use" and it was wrong.

     This reads the source rather than the screen because the wrong answer is
     an EMPTY STRING: nothing throws, nothing logs, and the tile just loses its
     glyph on a screen no assertion happened to visit. */
  const src = fs.readFileSync(path.join(ROOT, 'public', 'portal.html'), 'utf8');
  const defined = new Set([...src.matchAll(/^ {2}([a-z0-9]+):_svg\(/gm)].map(m => m[1]));
  const named = new Set([
    ...[...src.matchAll(/(?:kpi|card|pill)\('([a-z0-9]+)'/g)].map(m => m[1]),
    ...[...src.matchAll(/ic:'([a-z0-9]+)'/g)].map(m => m[1]),
    ...[...src.matchAll(/I\.([a-z0-9]+)/g)].map(m => m[1]),
  ]);
  check('every icon the app asks for by name exists',
    [...named].filter(n => !defined.has(n)).sort(), []);

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
  await page.evaluate(() => { setBrand('folio'); setView('subscribers'); });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await boot();
  check('the brand survives too', await page.evaluate(() => [brand, view]), ['folio', 'subscribers']);

  console.log('\nA fragment that no longer means anything degrades, never blanks');
  await page.goto('about:blank');
  await page.goto(`${BASE}/#brand=nope&view=nope&sub=nope`, { waitUntil: 'domcontentloaded' });
  await boot();
  check('falls back to the default screen', await page.evaluate(() => [brand, view]), ['all', 'exec']);
  check('and still paints', await page.evaluate(() => document.getElementById('content').children.length > 0), true);
  await page.goto('about:blank');
  await page.goto(`${BASE}/#brand=folio&view=properties`, { waitUntil: 'domcontentloaded' });
  await boot();
  check('a view the brand does not have is dropped', await page.evaluate(() => [brand, view]), ['folio', 'subscribers']);
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
