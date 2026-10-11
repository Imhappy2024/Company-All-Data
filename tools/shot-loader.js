/* Screenshots of the loading states, live data, API slowed down so they can
   be seen: docs/screenshots/loader/*.png. Same harness as test-props-ui.js.

   Run:  node tools/shot-loader.js
*/
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
for (const l of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
  const m = /^([A-Za-z0-9_]+)=(.*)$/.exec(l.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
process.env.PORT = '3993';
const OUT = path.join(ROOT, 'docs', 'screenshots', 'loader');
fs.mkdirSync(OUT, { recursive: true });
const db = require(path.join(ROOT, 'supabase-db.js'));
const realFetch = global.fetch;
let STAFF = null;
global.fetch = async function (url, init) {
  if (String(url).indexOf('/rpc/dash_my_access') >= 0) {
    if (!STAFF) STAFF = (await db.q(`select id, email, full_name, dashboard_role from public.staff where lower(email) = 'jay@leadliconsulting.com'`)).rows[0];
    return new Response(JSON.stringify({ user: { id: STAFF.id, email: STAFF.email, full_name: STAFF.full_name, role: STAFF.dashboard_role },
      companies: {}, access: { exec: { properties: 'edit', views: 'edit' } } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  return realFetch(url, init);
};
const { chromium } = require('playwright');
require(path.join(ROOT, 'server.js'));
const BASE = 'http://127.0.0.1:3993';
const STUB = fs.readFileSync(path.join(ROOT, 'test', 'test-props-flicker.js'), 'utf8').match(/const SESSION_STUB = `([\s\S]*?)`;/)[1];

(async () => {
  await new Promise(r => setTimeout(r, 1500));
  const FC = (await db.q(`select id from reporting.property_summary_mv where name = 'Franklin Court'`)).rows[0].id;
  const b = await chromium.launch();
  for (const theme of ['dark', 'light']) {
    const pg = await b.newPage({ viewport: { width: 1440, height: 860 } });
    await pg.route('**/portal-session.js', r => r.fulfill({ status: 200, contentType: 'application/javascript', body: STUB }));
    await pg.addInitScript(t => { try { localStorage.setItem('portalTheme', t); } catch (e) {} document.documentElement.setAttribute('data-theme', t); }, theme);
    let slow = true;
    await pg.route('**/api/props/**', async r => { if (slow) await new Promise(x => setTimeout(x, 2500)); r.continue(); });
    await pg.goto(BASE + '/?s=' + theme + '#brand=leavenwealth&view=properties&lvl=property&prop=' + FC + '&ptab=monthly', { waitUntil: 'domcontentloaded' });
    await pg.waitForSelector('.ld-full .lw-mark', { state: 'visible', timeout: 20000 });
    await pg.evaluate(t => document.documentElement.setAttribute('data-theme', t), theme);
    await pg.waitForTimeout(700);
    await pg.screenshot({ path: path.join(OUT, theme + '-full-section.png') });
    slow = false;
    await pg.waitForFunction(() => !document.querySelector('.ld-full'), null, { timeout: 60000 });
    slow = true;
    const cur = await pg.$eval('[data-in="fm"]', s => s.value);
    await pg.selectOption('[data-in="fm"]', cur === '3' ? '4' : '3');
    await pg.waitForSelector('.ld-small .lw-mark', { state: 'visible', timeout: 20000 });
    await pg.waitForTimeout(600);
    await pg.screenshot({ path: path.join(OUT, theme + '-partial-refresh.png') });
    await pg.close();
  }
  await b.close();
  console.log('wrote ' + fs.readdirSync(OUT).join(', '));
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
