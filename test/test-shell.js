/* ===========================================================================
   test-shell.js - the dashboard shell (docs/mockup/shell.dc.html) in a browser.

   Replaces test-portal-nav.js and test-permission-gate.js, which drove the old
   brand switcher, the Tasks tabs and the /ops embeds - all gone with the shell.

   Drives the real portal.html with a stubbed portal-session.js; every /api call
   answers 503, so this is the shell's own logic: the rail, the menus each
   person may see, the route gate, per-person memory, the shortcuts, Home's
   connect state, and the design rules that are checkable (no all-caps, no
   search box, no bell).

   Expectations are written from the brief, not read off the code.
   =========================================================================== */
const http = require('http');
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const { chromium } = require(path.join(ROOT, 'node_modules', 'playwright'));

const PORT = 4381;
const BASE = `http://localhost:${PORT}`;
const C = { leadli: 'c0000000-0000-4000-8000-000000000001', folio: 'c0000000-0000-4000-8000-000000000002',
            lw: 'c0000000-0000-4000-8000-000000000003', liquid: 'c0000000-0000-4000-8000-000000000004' };
const MIME = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };
const server = http.createServer((req, res) => {
  let p = req.url.split('?')[0];
  if (p === '/') p = '/portal.html';
  if (p === '/login') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end('<h1>login</h1>'); }
  if (p.startsWith('/api/') || p.startsWith('/auth/')) { res.writeHead(503, { 'Content-Type': 'application/json' }); return res.end('{"error":"offline in tests"}'); }
  for (const f of [path.join(ROOT, 'public', p), path.join(ROOT, p)]) {
    if (fs.existsSync(f) && fs.statSync(f).isFile()) { res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'text/plain' }); return res.end(fs.readFileSync(f)); }
  }
  res.writeHead(404); res.end('not found');
});

let failures = 0;
function check(name, actual, want) {
  const a = JSON.stringify(actual), w = JSON.stringify(want), ok = a === w;
  if (!ok) failures++;
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (ok ? '' : '\n          expected ' + w + '\n          actual   ' + a));
}

const all = ['overview', 'financials', 'plans', 'reports', 'subscribers', 'leads', 'loans', 'tasks', 'properties', 'team', 'departments', 'tools', 'documents'];
const grant = ids => Object.fromEntries(ids.map(i => [i, 'write']));
/* Everything in the catalog, as the live catalog has it: Folio has no financials
   row, Liquid has no departments row. */
const ADMIN = {
  user: { id: 's-admin', email: 'jay@x.invalid', full_name: 'Jay Delgado', avatar_url: null, role: 'admin' },
  companies: { [C.lw]: 'LeavenWealth', [C.folio]: 'Folio Excel', [C.leadli]: 'Leadli AI', [C.liquid]: 'Liquid Lending Solutions' },
  access: {
    exec: grant(['exec', 'orgdept', 'financials', 'team', 'alltasks', 'access']),
    [C.lw]: grant(['properties', 'team', 'departments', 'tools', 'documents', 'loans', 'leads', 'tasks', 'financials', 'overview']),
    [C.folio]: grant(['overview', 'reports', 'plans', 'subscribers', 'team', 'departments', 'tools', 'documents', 'leads', 'tasks']),
    [C.leadli]: grant(['overview', 'financials', 'team', 'departments', 'tools', 'documents', 'leads', 'tasks', 'ads', 'appointments']),
    [C.liquid]: grant(['overview', 'financials', 'team', 'tools', 'documents', 'leads', 'tasks', 'pipeline', 'borrowers']),
  },
};
/* One business, two pages, plain user. */
const SOLO = {
  user: { id: 's-solo', email: 'ute@x.invalid', full_name: 'Ute User', avatar_url: null, role: 'user' },
  companies: { [C.lw]: 'LeavenWealth' },
  access: { exec: grant(['exec']), [C.lw]: grant(['properties', 'team']) },
};
void all;

function stub(payload) {
  return `window.PortalSession = {
    enforceRememberWindow: function(){ return Promise.resolve(false); },
    getSession: function(){ return Promise.resolve({ access_token: 'jwt' }); },
    access: function(){ return Promise.resolve(${JSON.stringify(payload)}); },
    client: function(){ return Promise.resolve({ auth: { onAuthStateChange: function(){}, getSession: function(){ return Promise.resolve({ data: { session: { access_token: 'jwt' } } }); } } }); },
    authHeaders: function(x){ return Promise.resolve(Object.assign({ Authorization: 'Bearer jwt' }, x || {})); },
    getJson: function(u){ return fetch(u).then(function(r){ return r.json().then(function(j){ if(!r.ok) throw new Error(j.error||('HTTP '+r.status)); return j; }); }); },
    signOut: function(){ return Promise.resolve(); },
    config: function(){ return Promise.resolve({ url: 'http://stub', anonKey: 'stub' }); },
  };`;
}

(async () => {
  await new Promise(r => server.listen(PORT, r));
  const browser = await chromium.launch();
  const errors = [];
  async function open(payload, hash, ctx) {
    ctx = ctx || await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    page.on('pageerror', e => errors.push(String(e)));
    await page.route('**/portal-session.js', r => r.fulfill({ status: 200, contentType: 'application/javascript', body: stub(payload) }));
    await page.goto(BASE + '/' + (hash ? '#' + hash : ''), { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.dashAccess !== null && !document.getElementById('authGate'), { timeout: 8000 });
    await page.waitForTimeout(150);
    return { ctx, page };
  }
  const state = page => page.evaluate(() => ({ brand, view }));
  const navLabels = page => page.$$eval('#nav .nav-item span:not(.nav-count)', e => e.map(x => x.textContent));
  const rail = page => page.$$eval('#rail .biz', e => e.map(x => x.getAttribute('aria-label')));

  try {
    console.log('\nAn admin with every business');
    let { ctx, page } = await open(ADMIN);
    check('an admin lands on the Executive board, L10 agenda', await state(page), { brand: 'home', view: 'l10' });
    check('rail: Executive board, then the four businesses in order', await rail(page), ['Executive board', 'LeavenWealth', 'Folio Excel', 'Leadli AI', 'Liquid Lending Solutions']);
    check('tooltips name the shortcut', await page.$$eval('#rail .tip', e => e.map(x => x.textContent)),
      ['Executive boardCtrl 0', 'LeavenWealthCtrl 1', 'Folio ExcelCtrl 2', 'Leadli AICtrl 3', 'Liquid Lending SolutionsCtrl 4']);
    check('Executive board sidebar: L10 agenda, All tasks, Personal tasks, then Users & roles', await navLabels(page), ['L10 agenda', 'All tasks', 'Personal tasks', 'Users & roles']);
    check('sidebar title', await page.$eval('#sideTitle', e => e.textContent), 'Executive board');
    await page.evaluate(() => goHome('mine'));
    check('not connected: one Connect ClickUp button and nothing else to click',
      await page.$$eval('#content a, #content button', e => e.map(x => x.textContent.trim())), ['Connect ClickUp']);
    check('header: menu button, breadcrumb, then full screen and theme icons at the right; no search, no bell',
      await page.evaluate(() => { const b = [...document.querySelectorAll('.sh-head button, .sh-head input')]; const h = document.querySelector('.sh-head').getBoundingClientRect();
        const t = document.getElementById('themeBtn');
        return [b.map(x => x.id), t.textContent.trim(), !!t.getAttribute('aria-label'), Math.round(h.right - t.getBoundingClientRect().right) <= 28, /Search or jump/.test(document.body.textContent)]; }),
      [['sideBtn', 'fullBtn', 'themeBtn'], '', true, true, false]);
    check('crumb reads Executive board > Personal tasks', await page.$eval('#crumb', e => e.innerText.replace(/\s+/g, ' ').trim()), 'Executive board Personal tasks');

    console.log('\nThe left menu hides and comes back');
    await page.click('#sideBtn');
    check('hidden: no sidebar, content takes the space', await page.evaluate(() => [getComputedStyle(document.getElementById('side')).display,
      Math.round(document.querySelector('.sh-main').getBoundingClientRect().left)]), ['none', 64]);
    await page.click('#sideBtn');
    check('shown again', await page.evaluate(() => getComputedStyle(document.getElementById('side')).display), 'flex');
    check('full screen button is labelled', await page.$eval('#fullBtn', b => b.getAttribute('aria-label')), 'Full screen');

    console.log('\nMenus, exactly as the brief lists them');
    await page.keyboard.press('Control+1');
    check('Ctrl+1 opens LeavenWealth', (await state(page)).brand, 'leavenwealth');
    check('LeavenWealth (no Executive board item: it is the first rail button now)', await navLabels(page), ['Properties', 'Team', 'Departments', 'Tools & apps', 'Documents']);
    await page.keyboard.press('Control+2');
    check('Folio Excel (Financials rides on the reports catalog row)', await navLabels(page),
      ['Overview', 'Financials', 'Plans', 'Reports', 'Team', 'Departments', 'Tools & apps', 'Documents']);
    await page.keyboard.press('Control+3');
    check('Leadli AI', await navLabels(page), ['Overview', 'Financials', 'Team', 'Departments', 'Tools & apps', 'Documents']);
    await page.keyboard.press('Control+4');
    check('Liquid Lending Solutions (Departments rides on the team row)', await navLabels(page),
      ['Overview', 'Financials', 'Team', 'Departments', 'Tools & apps', 'Documents']);
    check('sidebar title is the business', await page.$eval('#sideTitle', e => e.textContent), 'Liquid Lending Solutions');
    check('no Leads, Loans, Tasks or Users & roles item anywhere', await page.evaluate(() =>
      ['leavenwealth', 'folio', 'leadli', 'liquid'].flatMap(b => visibleMenu(b).map(x => x[1])).filter(l => /Leads|Loans|Tasks|Users/.test(l))), []);
    await page.keyboard.press('Control+0');
    check('Ctrl+0 is the Executive board', (await state(page)).brand, 'home');

    console.log('\nUsers & roles lives in the Executive board');
    await page.evaluate(() => goHome('access'));
    check('in the URL', new URLSearchParams(new URL(page.url()).hash.slice(1)).get('view'), 'access');
    check('crumb', await page.$eval('#crumb', e => e.innerText.replace(/\s+/g, ' ').trim()), 'Executive board Users & roles');
    await page.goto(BASE + '/?r=0#brand=leavenwealth&view=exec&sub=access', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.dashAccess !== null && !document.getElementById('authGate'));
    check('an old Executive board link still lands on it', await state(page), { brand: 'home', view: 'access' });

    console.log('\nMemory: last business and last page within each, per person');
    await page.evaluate(() => { setBrand('folio'); setView('plans'); setBrand('leadli'); setView('team'); });
    await page.evaluate(() => setBrand('folio'));
    check('returning to a business opens its last page', await state(page), { brand: 'folio', view: 'plans' });
    await page.evaluate(() => setBrand('leadli'));
    await page.goto(BASE + '/?r=1', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.dashAccess !== null && !document.getElementById('authGate'));
    check('a fresh visit with no link reopens the last business and page', await state(page), { brand: 'leadli', view: 'team' });
    check('memory is keyed by the person', await page.evaluate(() => Object.keys(localStorage).filter(k => k.indexOf('lwShell:') === 0)), ['lwShell:s-admin']);
    await page.goto(BASE + '/?r=2#brand=folio&view=reports', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.dashAccess !== null && !document.getElementById('authGate'));
    check('a link wins over memory', await state(page), { brand: 'folio', view: 'reports' });

    console.log('\nDesign rules that can be measured');
    for (const v of ['team', 'tools', 'documents', 'departments']) {
      await page.evaluate(x => { setBrand('leavenwealth'); setView(x); }, v);
      await page.waitForTimeout(80);
    }
    check('nothing in the shell is set in capitals', await page.evaluate(() =>
      [...document.querySelectorAll('#app *')].filter(e => e.offsetParent && getComputedStyle(e).textTransform === 'uppercase').map(e => e.className)), []);
    check('IBM Plex Sans is the face', await page.evaluate(() => getComputedStyle(document.body).fontFamily.split(',')[0].replace(/['"]/g, '')), 'IBM Plex Sans');
    check('with nothing saved, the device setting decides (this browser: light)', await page.evaluate(() => document.documentElement.getAttribute('data-theme')), 'light');
    check('Light stone page colour', await page.evaluate(() => getComputedStyle(document.body).backgroundColor), 'rgb(245, 244, 241)');
    check('the icon switch says what it does', await page.$eval('#themeBtn', b => [b.textContent.trim(), b.getAttribute('aria-label')]), ['', 'Switch to dark mode']);
    await page.click('#themeBtn');
    check('it flips and is remembered for this person', await page.evaluate(() => [document.documentElement.getAttribute('data-theme'), localStorage.getItem('lwTheme:s-admin')]), ['dark', 'dark']);
    await page.goto(BASE + '/?r=4', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.dashAccess !== null && !document.getElementById('authGate'));
    check('and comes back on the next visit', await page.evaluate(() => document.documentElement.getAttribute('data-theme')), 'dark');
    await ctx.close();

    console.log('\nOne business, plain user');
    ({ ctx, page } = await open(SOLO, 'brand=folio&view=overview', await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' })));
    check('another person on a dark device starts dark (not the last person\'s choice)', await page.evaluate(() => document.documentElement.getAttribute('data-theme')), 'dark');
    check('a link to a business they cannot reach falls back to Home', await state(page), { brand: 'home', view: 'mine' });
    check('the rail is not shown', await page.$eval('#rail', e => getComputedStyle(e).display), 'none');
    await page.evaluate(() => setBrand('leavenwealth'));
    check('their business sidebar carries Home\'s task lists first, and no Executive board', await navLabels(page), ['My tasks', 'All tasks', 'Properties', 'Team']);
    await page.goto(BASE + '/?r=3#brand=leavenwealth&view=departments', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.dashAccess !== null && !document.getElementById('authGate'));
    check('a page they were not granted falls back to one they were', await state(page), { brand: 'leavenwealth', view: 'properties' });
    check('setView refuses an ungranted page', await page.evaluate(() => { setView('exec'); return view; }), 'properties');
    check('Ctrl+0 still reaches Home', await page.evaluate(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: '0', ctrlKey: true })); return brand; }), 'home');
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
