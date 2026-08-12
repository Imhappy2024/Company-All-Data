/* ===========================================================================
   test-permission-gate.js - Step 3: the switcher, the nav, and the ROUTE.

   Drives the real portal.html in a real browser with a stubbed portal-session.js,
   so the whole gate runs: allowedBrands, visibleMenu, readState, setBrand/setView
   and canWrite. Only the Supabase session layer is replaced, and only because
   this harness has no Supabase; the gate itself is the code under test.

   The check that matters most is fragment tampering. Filtering buildNav() gates
   the MENU, not the ROUTE - before this step, #brand=leadli&view=leads reached
   Leadli whether or not the user held it. Every persona below is therefore also
   pointed at a screen it must not reach.

   nav ids are NOT unique across scopes: team, financials and investors appear
   under both `exec` and company scopes with independent grants. So the personas
   include one where the same id is held in one scope and not another.

   Expectations are written from the intended behaviour, not read off the code.
   =========================================================================== */
const http = require('http');
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const { chromium } = require(path.join(ROOT, 'node_modules', 'playwright'));

const PORT = 4371;
const BASE = `http://localhost:${PORT}`;
const LW = 'c0000000-0000-4000-8000-000000000003';
const LEADLI = 'c0000000-0000-4000-8000-000000000001';

const MIME = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css',
               '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };
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
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name +
    (ok ? '  ' + a : '\n          expected ' + w + '\n          actual   ' + a));
}

/* ---- personas, written by hand -------------------------------------------
   Each is a dash_my_access() payload plus what the UI should do with it. */
const OWNER = {
  user: { id: 's-o', email: 'owner@x.invalid', full_name: 'Owner', avatar_url: null, role: 'owner' },
  companies: { [LW]: 'LeavenWealth', [LEADLI]: 'Leadli AI' },
  access: {
    exec: { exec: 'write', orgdept: 'write', team: 'write', alltasks: 'write',
            financials: 'write', investors: 'write', integrations: 'write', access: 'write' },
    [LW]: { overview: 'write', properties: 'write', loans: 'write', tasks: 'write' },
    [LEADLI]: { overview: 'write', leads: 'write' },
  },
};
/* One brand, two modules, both read. No Exec at all. */
const READER = {
  user: { id: 's-r', email: 'reader@x.invalid', full_name: 'Reader', avatar_url: null, role: 'user' },
  companies: { [LW]: 'LeavenWealth' },
  access: { [LW]: { overview: 'read', properties: 'read' } },
};
/* Holds `financials` under LeavenWealth but NOT under exec, and holds no exec at
   all - the collision case. */
const SCOPED = {
  user: { id: 's-s', email: 'scoped@x.invalid', full_name: 'Scoped', avatar_url: null, role: 'user' },
  companies: { [LW]: 'LeavenWealth' },
  access: { [LW]: { overview: 'read', financials: 'write' } },
};
/* Authenticated, recognised, granted nothing. */
const EMPTY = {
  user: { id: 's-e', email: 'empty@x.invalid', full_name: 'Empty', avatar_url: null, role: 'user' },
  companies: {}, access: {},
};

function sessionStub(payload) {
  return `window.PortalSession = {
    enforceRememberWindow: function(){ return Promise.resolve(false); },
    getSession: function(){ return Promise.resolve({ user: { id: 'u' } }); },
    access: function(){ return Promise.resolve(${JSON.stringify(payload)}); },
    client: function(){ return Promise.resolve({ auth: { onAuthStateChange: function(){},
      getSession: function(){ return Promise.resolve({ data: { session: null } }); } } }); },
    signOut: function(){ return Promise.resolve(); },
    isRemembered: function(){ return false; },
    config: function(){ return Promise.resolve({ url: 'http://stub', anonKey: 'stub' }); },
  };`;
}

(async () => {
  await new Promise(r => server.listen(PORT, r));
  const browser = await chromium.launch(
    process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
  const errors = [];

  async function open(payload, hash) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await ctx.newPage();
    page.on('pageerror', e => errors.push(String(e)));
    await page.route('**/portal-session.js', r => r.fulfill({
      status: 200, contentType: 'application/javascript', body: sessionStub(payload) }));
    await page.goto(BASE + (hash || ''), { waitUntil: 'domcontentloaded' });
    /* The gate reveals only once the payload has been applied. */
    await page.waitForFunction(() => window.dashAccess !== null, { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(250);
    return { ctx, page };
  }
  /* :not(.badge) because a nav item is icon + label span + an optional badge span,
     and the badge would otherwise read as an extra menu entry. */
  const nav = p => p.$$eval('#nav .nav-item > span:not(.badge)', e => e.map(x => x.textContent));
  const labels = p => p.$$eval('#nav .nav-lbl', e => e.map(x => x.textContent));
  const brands = p => p.$$eval('#bpMenu .bp-item', e => e.map(x => x.textContent.trim()));
  const where = p => p.evaluate(() => [brand, view]);

  try {
    /* ------------------------------------------------------------ owner */
    console.log('\nOwner sees everything');
    let { ctx, page } = await open(OWNER);
    check('lands on Executive Board', await where(page), ['all', 'exec']);
    check('both granted workspaces in the switcher', await brands(page), ['Executive Board', 'LeavenWealth', 'Leadli AI']);
    check('New button shown where the level is write',
      await page.locator('.page-h .btn').count(), 1);
    await ctx.close();

    /* ----------------------------------------------------------- reader */
    console.log('\nA user with read on LeavenWealth > Overview + Properties only');
    ({ ctx, page } = await open(READER));
    check('only their one workspace', await brands(page), ['LeavenWealth']);
    check('Executive Board is absent', (await brands(page)).indexOf('Executive Board'), -1);
    check('lands in that workspace, not on an empty Exec', await where(page), ['leavenwealth', 'overview']);
    check('nav is exactly what they hold', await nav(page), ['Overview', 'Properties']);
    check('no empty section headings', await labels(page), ['Overview', 'Real estate']);
    check('no New button at read level', await page.locator('.page-h .btn').count(), 0);
    check('canWrite is false, canRead true',
      await page.evaluate(() => [canWrite('properties'), canRead('properties')]), [false, true]);

    console.log('\nFragment tampering does not reach an ungranted screen');
    /* The route, not the menu. This is the hole that filtering buildNav leaves. */
    await page.evaluate(() => { location.hash = '#brand=leadli&view=leads'; });
    await page.waitForTimeout(300);
    check('a brand they do not hold is refused', (await where(page))[0], 'leavenwealth');
    await page.evaluate(() => { location.hash = '#brand=leavenwealth&view=loans'; });
    await page.waitForTimeout(300);
    check('a module they do not hold is refused', (await where(page))[1] === 'loans', false);
    check('and it falls back to something they DO hold',
      await page.evaluate(() => navLevel(brand, view) !== null), true);
    await page.evaluate(() => { location.hash = '#brand=all&view=exec'; });
    await page.waitForTimeout(300);
    check('Executive Board is refused without an exec grant', (await where(page))[0], 'leavenwealth');

    console.log('\nThe setters refuse too, not just the fragment');
    check('setBrand to an unheld brand is a no-op',
      await page.evaluate(() => { setBrand('leadli'); return brand; }), 'leavenwealth');
    check('setView to an unheld module is a no-op',
      await page.evaluate(() => { setView('loans'); return view; }), 'overview');
    await ctx.close();

    /* ----------------------------------------------------------- scoped */
    console.log('\nSame nav id, different scopes (team/financials/investors collide)');
    ({ ctx, page } = await open(SCOPED));
    check('financials is held under LeavenWealth', await page.evaluate(() => navLevel('leavenwealth', 'financials')), 'write');
    check('but NOT under exec', await page.evaluate(() => navLevel('all', 'financials')), null);
    check('so exec stays out of the switcher', (await brands(page)).indexOf('Executive Board'), -1);
    check('and the id alone cannot answer it: scope decides',
      await page.evaluate(() => [accessScope('all'), accessScope('leavenwealth')]),
      ['exec', 'c0000000-0000-4000-8000-000000000003']);
    check('New button IS shown for the module held at write',
      await page.evaluate(() => { setView('financials'); return document.querySelectorAll('.page-h .btn').length; }), 1);
    await ctx.close();

    /* ------------------------------------------------------------ empty */
    console.log('\nGranted nothing gets a plain page, not an empty shell');
    ({ ctx, page } = await open(EMPTY));
    check('no access page shown', await page.evaluate(() => /No access yet/.test(document.body.textContent)), true);
    check('the shell is not rendered', await page.locator('#nav .nav-item').count(), 0);
    check('and it is visible rather than stuck behind the gate',
      await page.evaluate(() => getComputedStyle(document.body).visibility), 'visible');
    await ctx.close();

    /* ------------------------------------------------- deep link honoured */
    console.log('\nAn allowed deep link still works');
    ({ ctx, page } = await open(OWNER, '#brand=leavenwealth&view=loans'));
    check('honoured when the user holds it', await where(page), ['leavenwealth', 'loans']);
    await ctx.close();

    console.log('\nRuntime errors');
    check('no page errors', errors, []);
  } catch (e) {
    console.error('\nTEST ERROR:', e.message);
    failures++;
  } finally {
    await browser.close().catch(() => {});
    server.close();
  }

  console.log(failures ? `\n${failures} CHECK(S) FAILED` : '\nAll checks passed');
  process.exit(failures ? 1 : 0);
})();
