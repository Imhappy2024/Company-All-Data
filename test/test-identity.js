/* ===========================================================================
   test-identity.js - Step 6: the account chip, its menu, and the profile panel.

   The chip REPLACED a static "Chris Pomerleau / Owner · Admin" block, so one check
   here is that there is exactly ONE identity control - a second one is the specific
   mistake this step was told to avoid, and it is invisible in a screenshot.

   The profile panel is read-only by decision, so the checks are about it saying so
   and about it rendering catalog LABELS rather than nav ids.
   =========================================================================== */
const http = require('http');
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const { chromium } = require(path.join(ROOT, 'node_modules', 'playwright'));

const PORT = 4411;
const BASE = `http://localhost:${PORT}`;
const LW = 'c0000000-0000-4000-8000-000000000003';

const MODULES = [
  { id: 'm1', company_id: null, module_key: 'executive', nav_id: 'exec', label: 'Executive', sort: 10 },
  { id: 'm2', company_id: LW, module_key: 'overview', nav_id: 'overview', label: 'Overview', sort: 5 },
  { id: 'm3', company_id: LW, module_key: 'properties', nav_id: 'properties', label: 'Properties', sort: 10 },
];

const MIME = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css',
               '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };
const server = http.createServer((req, res) => {
  let p = req.url.split('?')[0];
  if (p === '/api/access/modules') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ modules: MODULES }));
  }
  if (p === '/login') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end('<h1>login</h1>'); }
  if (p.startsWith('/api/')) { res.writeHead(503, { 'Content-Type': 'application/json' }); return res.end('{}'); }
  if (p === '/') p = '/portal.html';
  if (p === '/ops') p = '/index.html';
  for (const f of [path.join(ROOT, 'public', p), path.join(ROOT, p), path.join(ROOT, 'test', p)]) {
    if (fs.existsSync(f) && fs.statSync(f).isFile()) {
      res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'text/plain' });
      return res.end(fs.readFileSync(f));
    }
  }
  res.writeHead(404); res.end('nope');
});

let failures = 0;
function check(name, actual, want) {
  const a = JSON.stringify(actual), w = JSON.stringify(want);
  const ok = a === w;
  if (!ok) failures++;
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name +
    (ok ? '  ' + a : '\n          expected ' + w + '\n          actual   ' + a));
}

const OWNER = {
  user: { id: 's-o', email: 'chris@leavenwealth.com', full_name: 'Chris Pomerleau',
          avatar_url: null, role: 'owner' },
  companies: { [LW]: 'LeavenWealth' },
  access: { exec: { exec: 'write' }, [LW]: { overview: 'write', properties: 'write' } },
};
const READER = {
  user: { id: 's-r', email: 'ute@x.invalid', full_name: 'Ute User', avatar_url: null, role: 'user' },
  companies: { [LW]: 'LeavenWealth' },
  access: { [LW]: { overview: 'read', properties: 'write' } },
};

function stub(payload) {
  return `window.__signedOut = 0;
  window.PortalSession = {
    enforceRememberWindow: function(){ return Promise.resolve(false); },
    getSession: function(){ return Promise.resolve({ user: { id: 'u' } }); },
    access: function(){ return Promise.resolve(${JSON.stringify(payload)}); },
    client: function(){ return Promise.resolve({ auth: {
      onAuthStateChange: function(){},
      getSession: function(){ return Promise.resolve({ data: { session: { access_token: 'jwt' } } }); } } }); },
    /* Recorded in sessionStorage, not on window: logging out navigates to /login and
       destroys the page that would have held the counter. */
    signOut: function(){
      try { sessionStorage.setItem('__signedOut',
        String(Number(sessionStorage.getItem('__signedOut') || 0) + 1)); } catch (e) {}
      return Promise.resolve();
    },
    isRemembered: function(){ return false; },
    config: function(){ return Promise.resolve({ url: 'http://stub', anonKey: 'stub' }); },
  };`;
}

(async () => {
  await new Promise(r => server.listen(PORT, r));
  const browser = await chromium.launch(
    process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
  const errors = [];
  async function open(payload) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await ctx.newPage();
    page.on('pageerror', e => errors.push(String(e)));
    await page.route('**/portal-session.js', r => r.fulfill({
      status: 200, contentType: 'application/javascript', body: stub(payload) }));
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.dashAccess !== null, { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(250);
    return { ctx, page };
  }

  try {
    console.log('\nOne identity control, painted from the access payload');
    let { ctx, page } = await open(OWNER);
    check('exactly one', await page.locator('#idChip').count(), 1);
    check('name from dash_my_access, not hard-coded',
      await page.$eval('#idName', e => e.textContent), 'Chris Pomerleau');
    check('role spelled out', await page.$eval('#idRole', e => e.textContent), 'Owner');
    check('initials', await page.$eval('#idAvatar', e => e.textContent), 'CP');
    /* The old static block said "Owner · Admin" for everyone. If it survived
       anywhere, this finds it. */
    check('the old static chip is gone',
      await page.evaluate(() => /Owner\s*·\s*Admin/.test(document.body.textContent)), false);
    check('it is a button, so the menu cannot open on hover',
      await page.$eval('#idChip', e => e.tagName), 'BUTTON');

    console.log('\nThe menu');
    check('closed to begin with', await page.$eval('#idMenu', e => e.hidden), true);
    await page.click('#idChip');
    check('opens on click', await page.$eval('#idMenu', e => e.hidden), false);
    check('aria-expanded tracks it', await page.$eval('#idChip', e => e.getAttribute('aria-expanded')), 'true');
    check('shows name, email and role',
      await page.evaluate(() => {
        const m = document.getElementById('idMenu').textContent;
        return [/Chris Pomerleau/.test(m), /chris@leavenwealth\.com/.test(m), /Role: Owner/.test(m)];
      }), [true, true, true]);
    check('and the two actions', await page.$$eval('#idMenu .idmenu-i', b => b.map(x => x.textContent.trim())),
      ['Profile settings', 'Log out']);

    console.log('\nIt closes the three ways it must');
    await page.click('#content');
    check('outside click', await page.$eval('#idMenu', e => e.hidden), true);
    await page.click('#idChip');
    await page.keyboard.press('Escape');
    check('Escape', await page.$eval('#idMenu', e => e.hidden), true);
    check('and focus goes back to the chip',
      await page.evaluate(() => document.activeElement && document.activeElement.id), 'idChip');
    await page.click('#idChip');
    /* A real route change. setView('overview') would NOT do it here: the owner's exec
       scope holds only `exec`, so the permission gate refuses it and nothing
       re-renders - which is correct, and would have made this check pass for the
       wrong reason. Switching workspace is a change the owner can actually make. */
    await page.evaluate(() => setBrand('leavenwealth'));
    await page.waitForTimeout(200);
    check('route change', await page.$eval('#idMenu', e => e.hidden), true);
    check('and the route really did change', await page.evaluate(() => brand), 'leavenwealth');

    console.log('\nProfile settings is read-only, and says who to ask');
    await page.click('#idChip');
    await page.click('#idMenu .idmenu-i');
    await page.waitForTimeout(400);
    check('panel open', await page.$eval('#profileDrawer', e => e.classList.contains('open')), true);
    check('menu closed behind it', await page.$eval('#idMenu', e => e.hidden), true);
    check('name, email and role shown',
      await page.$$eval('#profileDrawer .pf-v', e => e.map(x => x.textContent)),
      ['Chris Pomerleau', 'chris@leavenwealth.com', 'Owner']);
    check('no editable field anywhere in it',
      await page.locator('#profileDrawer input, #profileDrawer textarea, #profileDrawer select').count(), 0);
    check('it points at an administrator',
      await page.$eval('#profileDrawer .pf-note', e => /contact an administrator/i.test(e.textContent)), true);
    check('an owner is not given 49 identical rows',
      await page.$eval('#profileDrawer .pf-full', e => e.textContent.trim()), 'Full access to all workspaces.');
    await page.click('#profileDrawer .pf-x');
    await page.waitForTimeout(300);
    check('closes', await page.$eval('#profileDrawer', e => e.classList.contains('open')), false);
    await ctx.close();

    console.log('\nA non-owner sees their actual access, by catalog label');
    ({ ctx, page } = await open(READER));
    check('role reads User', await page.$eval('#idRole', e => e.textContent), 'User');
    await page.click('#idChip');
    await page.click('#idMenu .idmenu-i');
    await page.waitForTimeout(500);
    check('the workspace is named',
      await page.$eval('#profileDrawer .pf-scope-n', e => e.textContent), 'LeavenWealth');
    check('modules by LABEL and level in words, not nav ids',
      await page.$$eval('#profileDrawer .pf-scope li', e => e.map(x => x.textContent).sort()),
      ['Overview: Read', 'Properties: Read & Write']);
    check('and nothing they do not hold',
      await page.evaluate(() => /Executive/.test(document.getElementById('profileDrawer').textContent)), false);

    console.log('\nLog out runs the one teardown');
    await page.click('#profileDrawer .pf-x');
    await page.click('#idChip');
    await page.click('#idMenu .idmenu-i.danger');
    await page.waitForTimeout(600);
    check('PortalSession.signOut was called exactly once',
      await page.evaluate(() => sessionStorage.getItem('__signedOut')), '1');
    check('and it landed on /login', new URL(page.url()).pathname, '/login');
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
