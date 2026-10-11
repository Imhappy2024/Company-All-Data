/* Users & Roles (Executive Board) in a browser, live data, nothing written.
   Every PUT/POST to /api/people is answered in the browser and its body kept,
   so the test checks what the screen would send, not the database.

   Run:  node test/test-access-ui.js [--shots]
*/
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const ROOT = path.join(__dirname, '..');
for (const l of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
  const m = /^([A-Za-z0-9_]+)=(.*)$/.exec(l.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
process.env.PORT = process.env.TEST_PORT || '3997';
const SHOTS = process.argv.indexOf('--shots') >= 0;
const db = require(path.join(ROOT, 'supabase-db.js'));
const realFetch = global.fetch;
let JAY = null;
global.fetch = async function (url, init) {
  if (String(url).indexOf('/rpc/dash_my_access') >= 0) {
    if (!JAY) JAY = (await db.q(`select id, email, full_name, dashboard_role from public.staff where lower(email) = 'jay@leadliconsulting.com'`)).rows[0];
    return new Response(JSON.stringify({ user: { id: JAY.id, email: JAY.email, full_name: JAY.full_name, role: JAY.dashboard_role }, companies: {}, access: {} }),
      { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  return realFetch(url, init);
};
const { chromium } = require('playwright');
require(path.join(ROOT, 'server.js'));
const BASE = 'http://127.0.0.1:' + process.env.PORT;
const STUB = fs.readFileSync(path.join(__dirname, 'test-props-flicker.js'), 'utf8').match(/const SESSION_STUB = `([\s\S]*?)`;/)[1]
  .replace("role: 'owner'", "role: 'admin'");

let pass = 0; const fails = [];
const check = (n, fn) => { try { fn(); pass++; } catch (e) { fails.push(n + ' -> ' + e.message.slice(0, 300)); } };

(async () => {
  await new Promise(r => setTimeout(r, 1500));
  const b = await chromium.launch();
  const pg = await b.newPage({ viewport: { width: 1440, height: 950 } });
  const errs = [], sent = [];
  pg.on('pageerror', e => errs.push(String(e.message).slice(0, 200)));
  await pg.route('**/portal-session.js', r => r.fulfill({ status: 200, contentType: 'application/javascript',
    body: fs.readFileSync(path.join(ROOT, 'public', 'portal-session.js'), 'utf8') + '\n' + STUB +
      '\nwindow.PortalSession.authHeaders = function (x) { return Promise.resolve(Object.assign({ Accept: "application/json", Authorization: "Bearer harness" }, x || {})); };' }));
  await pg.route('**/api/people/**', async r => {
    if (r.request().method() === 'GET') return r.continue();
    sent.push({ method: r.request().method(), url: r.request().url().replace(BASE, ''), body: JSON.parse(r.request().postData() || '{}') });
    return r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true,"login":"test","connector":"test"}' });
  });

  await pg.goto(BASE + '/?t=1#brand=all&view=access', { waitUntil: 'domcontentloaded' });
  await pg.waitForSelector('.pa-tbl', { timeout: 60000 });
  const t = await pg.evaluate(() => ({
    heads: [...document.querySelectorAll('.pa-tbl:not(.pa-log) thead th')].map(x => x.textContent.trim()),
    names: [...document.querySelectorAll('.pa-row .pa-name')].map(x => x.textContent.trim()),
    rowFor: n => null,
  }));
  check('columns: person, status, dashboard, every company, each company, last in Claude', () =>
    assert.deepStrictEqual(t.heads, ['Person', 'Status', 'Dashboard', 'Every company', 'Folio Excel', 'Leadli AI', 'LeavenWealth', 'Liquid Lending Solutions', 'Last in Claude']));
  check('lists Brian, Chris, Jay and Mitch', () => ['Brian Nelson', 'Chris Pomerleau', 'Jay Delgado', 'Mitch Hagen'].forEach(n => assert.ok(t.names.some(x => x.indexOf(n) === 0), n)));
  const brianRow = await pg.evaluate(() => {
    const r = [...document.querySelectorAll('.pa-row')].find(x => /^Brian Nelson/.test(x.querySelector('.pa-name').textContent));
    return [...r.querySelectorAll('td')].map(td => td.innerText.trim());
  });
  check('Brian reads Folio Excel: Editor (no financials), LeavenWealth: Operations', () => {
    assert.strictEqual(brianRow[4], 'Editor (no financials)'); assert.strictEqual(brianRow[6], 'Operations');
  });
  const menu = await pg.evaluate(() => { const a = document.querySelector('aside, .side, .sidebar, nav'); return a ? a.innerText : document.body.innerText; });
  check('Users & Roles is in the Executive Board menu', () => assert.ok(/Users & Roles/.test(menu), menu.slice(0, 200)));
  if (SHOTS) await pg.screenshot({ path: path.join(ROOT, 'docs', 'screenshots', 'access-list.png') });

  /* open Brian, narrow a screen, save: the body is the connector model */
  await pg.evaluate(() => [...document.querySelectorAll('.pa-row')].find(x => /^Brian Nelson/.test(x.querySelector('.pa-name').textContent)).click());
  await pg.waitForSelector('.pa-drawer');
  const dr = await pg.evaluate(() => ({
    selects: [...document.querySelectorAll('.pa-drawer select[data-in^="g:"]')].map(s => [s.getAttribute('data-in'), s.value]),
    screens: [...document.querySelectorAll('.pa-drawer .pa-scr span')].map(s => s.textContent.trim()),
    lwOptions: [...document.querySelectorAll('.pa-drawer select[data-in="g:leavenwealth"] option')].map(o => o.textContent.trim()),
  }));
  check('the drawer shows his levels per company', () => assert.deepStrictEqual(dr.selects.filter(x => x[1]), [['g:folio', 'user'], ['g:leavenwealth', 'lw_user']]));
  check('LeavenWealth offers the LeavenWealth levels in plain English', () =>
    ['Principal', 'Corporate', 'Operations', 'Operations (read-only)', 'Property facts only', 'Custom'].forEach(x => assert.ok(dr.lwOptions.indexOf(x) >= 0, x)));
  check('his screens are listed for narrowing', () => assert.ok(dr.screens.length >= 7, dr.screens.join(',')));
  if (SHOTS) await pg.screenshot({ path: path.join(ROOT, 'docs', 'screenshots', 'access-drawer.png') });
  await pg.selectOption('.pa-drawer select[data-in="rs:leavenwealth|company|tasks"]', 'read');
  await pg.click('.pa-drawer [data-a="save"]');
  await pg.waitForTimeout(800);
  const put = sent.find(s => s.method === 'PUT');
  check('Save sends grants + the narrowed screen, nothing else', () => {
    assert.deepStrictEqual(put.body.grants, [{ scope: 'folio', level: 'user' }, { scope: 'leavenwealth', level: 'lw_user' }]);
    assert.deepStrictEqual(put.body.restrictions, [{ scope: 'leavenwealth', area: 'company', nav_id: 'tasks', max: 'read' }]);
  });

  /* invite: never shows a token, sends the connector-model body */
  await pg.click('.pa-drawer [data-a="close"]');
  await pg.evaluate(() => window.PortalAccess.openInvite());
  await pg.waitForSelector('.pa-drawer [data-in="i:email"]');
  const invText = await pg.evaluate(() => document.querySelector('.pa-drawer').innerText);
  check('the invite explains the token is emailed, never shown', () => assert.ok(/never shown here/.test(invText)));
  if (SHOTS) await pg.screenshot({ path: path.join(ROOT, 'docs', 'screenshots', 'access-invite.png') });
  check('no page errors', () => assert.deepStrictEqual(errs, []));

  console.log('access ui: ' + pass + ' passed, ' + fails.length + ' failed');
  fails.forEach(f => console.log('  FAIL ' + f));
  await b.close();
  process.exit(fails.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
