/* Screenshots of portal pages, live data, as Jay (admin). Used for the shell
   rebuild's before/after set in docs/screenshots/shell/.

   node tools/shot-pages.js --root <checkout> --out <dir> --prefix before --port 4011 --pages <file.json>
     pages: [{ "name": "lw-team", "hash": "brand=leavenwealth&view=team", "wait": 2500 }, ...]
   Optional --theme light|dark (default dark).

   Only the identity call (/rpc/dash_my_access) is answered here; every query
   and figure is the real server against the live database. */
/* Production runs in UTC. Postgres DATEs become JS Dates at local midnight, so a
   harness east of UTC renders 2026-06-30 as 2026-06-29 and every as-of filter
   misses. Pin the zone before anything parses a date. */
process.env.TZ = 'UTC';
const fs = require('fs');
const path = require('path');
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const ROOT = path.resolve(arg('root', path.join(__dirname, '..')));
const OUT = path.resolve(arg('out', path.join(__dirname, '..', 'docs', 'screenshots', 'shell')));
const PREFIX = arg('prefix', 'shot');
const THEME = arg('theme', 'dark');
const PAGES = JSON.parse(fs.readFileSync(arg('pages'), 'utf8'));
for (const l of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
  const m = /^([A-Za-z0-9_]+)=(.*)$/.exec(l.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
process.env.PORT = arg('port', '4011');
const db = require(path.join(ROOT, 'supabase-db.js'));
const realFetch = global.fetch;
let JAY = null;
async function jay() {
  if (!JAY) JAY = (await db.q(`select id, email, full_name, dashboard_role from public.staff where lower(email) = 'jay@leadliconsulting.com'`)).rows[0];
  return JAY;
}
global.fetch = async function (url, init) {
  if (String(url).indexOf('/rpc/dash_my_access') >= 0) {
    const s = await jay();
    return new Response(JSON.stringify({ user: { id: s.id, email: s.email, full_name: s.full_name, role: s.dashboard_role }, companies: {}, access: {} }),
      { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  return realFetch(url, init);
};
const { chromium } = require(path.join(__dirname, '..', 'node_modules', 'playwright'));
require(path.join(ROOT, 'server.js'));
const BASE = 'http://127.0.0.1:' + process.env.PORT;

(async () => {
  await new Promise(r => setTimeout(r, 1500));
  const s = await jay();
  /* the browser's own dash_my_access() result, as the database computes it for Jay */
  const acc = {};
  (await db.q(`select coalesce(m.company_id::text, 'exec') scope, m.nav_id from public.dashboard_module m`)).rows
    .forEach(r => { (acc[r.scope] = acc[r.scope] || {})[r.nav_id] = 'write'; });
  const companies = Object.fromEntries((await db.q(`select id::text, name from public.company`)).rows.map(r => [r.id, r.name]));
  const STUB = `
    window.PortalSession.client = function () { return Promise.resolve({ auth: { getSession: function () {
      return Promise.resolve({ data: { session: { access_token: 'harness' } } }); }, onAuthStateChange: function () {} }, rpc: function () { return Promise.resolve({ data: null }); } }); };
    window.PortalSession.getSession = function () { return Promise.resolve({ access_token: 'harness' }); };
    window.PortalSession.access = function () { return Promise.resolve(${JSON.stringify({ user: { id: s.id, email: s.email, full_name: s.full_name, role: s.dashboard_role }, companies, access: acc })}); };
    window.PortalSession.enforceRememberWindow = function () { return Promise.resolve(false); };
    window.PortalSession.config = function () { return Promise.resolve({ url: 'https://x.supabase.co', anonKey: 'k' }); };
    window.PortalSession.authHeaders = function (x) { return Promise.resolve(Object.assign({ Accept: 'application/json', Authorization: 'Bearer harness' }, x || {})); };
    window.PortalSession.getJson = function (u) { return fetch(u, { headers: { Accept: 'application/json', Authorization: 'Bearer harness' } })
      .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status)); return j; }); }); };`;
  const sess = fs.readFileSync(path.join(ROOT, 'public', 'portal-session.js'), 'utf8');
  fs.mkdirSync(OUT, { recursive: true });
  const b = await chromium.launch();
  const pg = await b.newPage({ viewport: { width: 1440, height: 900 } });
  await pg.addInitScript(t => { try { localStorage.setItem('portalTheme', t); localStorage.setItem('lwTheme', t); } catch (e) { /* */ } }, THEME);
  await pg.route('**/portal-session.js', r => r.fulfill({ status: 200, contentType: 'application/javascript', body: sess + '\n' + STUB }));
  /* --clickup <fixture.json>: Home with a signed-in ClickUp person. The harness
     holds no ClickUp token, so /auth/me and /api/home/tasks answer from the
     fixture (real tasks, captured for the mockup) instead of ClickUp. */
  const CU = arg('clickup', null);
  if (CU) {
    const fx = fs.readFileSync(path.resolve(CU), 'utf8');
    const me = JSON.parse(fx).me;
    await pg.addInitScript(u => { try { localStorage.setItem('du_auth_token', 'harness'); localStorage.setItem('du_auth_user', JSON.stringify(u)); } catch (e) { /* */ } }, { id: me.id, username: me.name });
    await pg.route('**/auth/me', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ user: { id: me.id, username: me.name } }) }));
    await pg.route('**/api/home/tasks*', r => r.fulfill({ status: 200, contentType: 'application/json', body: fx }));
  }
  let n = 0;
  for (const p of PAGES) {
    await pg.goto(BASE + '/?s=' + (n++) + '#' + p.hash, { waitUntil: 'domcontentloaded' });
    await pg.evaluate(t => { document.documentElement.setAttribute('data-theme', t); }, THEME);
    await pg.waitForTimeout(p.wait || 2500);
    try { await pg.waitForFunction(() => !document.querySelector('.ld-full'), null, { timeout: 30000 }); } catch (e) { /* screenshot anyway */ }
    await pg.waitForTimeout(400);
    await pg.screenshot({ path: path.join(OUT, PREFIX + '-' + p.name + '.png') });
    console.log('shot ' + PREFIX + '-' + p.name);
  }
  await b.close();
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
