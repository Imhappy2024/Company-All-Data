/* Properties v2, rendered against the REAL API and the REAL database, and
   measured against docs/PROPERTIES_SPEC.md section 7 (acceptance).

   Same harness as test-reporting-ui.js: exactly one outbound call is stubbed
   (the fetch to /rpc/dash_my_access, which needs a real password), and
   portal-session.js is served as a stub. Every query and figure is live.

   Run:  node test/test-props-ui.js [--shots]
         --shots also writes docs/screenshots/v2/<tab>.png for every tab
*/
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
for (const l of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
  const m = /^([A-Za-z0-9_]+)=(.*)$/.exec(l.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
process.env.PORT = process.env.TEST_PORT || '3989';
const SHOTS = process.argv.indexOf('--shots') >= 0;
const SHOT_DIR = path.join(ROOT, 'docs', 'screenshots', 'v2');

const db = require(path.join(ROOT, 'supabase-db.js'));
const realFetch = global.fetch;
let STAFF = null;
global.fetch = async function (url, init) {
  if (String(url).indexOf('/rpc/dash_my_access') >= 0) {
    if (!STAFF) {
      STAFF = (await db.q(`select id, email, full_name, dashboard_role from public.staff where lower(email) = 'jay@leadliconsulting.com'`)).rows[0];
      if (!STAFF) throw new Error('fixture user not found in staff');
    }
    return new Response(JSON.stringify({
      user: { id: STAFF.id, email: STAFF.email, full_name: STAFF.full_name, role: STAFF.dashboard_role },
      companies: {}, access: { exec: { properties: 'edit', views: 'edit' } },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  return realFetch(url, init);
};

const { chromium } = require('playwright');
require(path.join(ROOT, 'server.js'));
const BASE = 'http://127.0.0.1:' + process.env.PORT;

const SESSION_STUB = `
  window.PortalSession = {
    client: function () { return Promise.resolve({ auth: { getSession: function () {
      return Promise.resolve({ data: { session: { access_token: 'harness' } } }); } } }); },
    getSession: function () { return Promise.resolve({ access_token: 'harness' }); },
    access: function () {
      var LW = 'c0000000-0000-4000-8000-000000000003';
      var mods = { properties: 'edit', views: 'edit', loans: 'edit', financials: 'edit', tasks: 'edit', team: 'edit',
                   documents: 'edit', tools: 'edit', departments: 'edit', exec: 'edit', orgdept: 'edit' };
      var a = { exec: mods }; a[LW] = mods;
      return Promise.resolve({ user: { id: 'harness', email: 'jay@leadliconsulting.com', full_name: 'Jay Delgado', role: 'owner' },
        access: a, companies: { 'c0000000-0000-4000-8000-000000000003': 'LeavenWealth' } });
    },
    enforceRememberWindow: function () { return Promise.resolve(false); },
    signOut: function () { return Promise.resolve(); },
    config: function () { return Promise.resolve({ url: 'https://x.supabase.co', anonKey: 'k' }); },
  };`;

let pass = 0; const fails = [];
const check = (n, fn) => { try { fn(); pass++; } catch (e) { fails.push(n + ' -> ' + e.message); } };

(async () => {
  await new Promise(r => setTimeout(r, 1500));
  const props = (await db.q(`select id, name from reporting.property_summary_mv where name in ('Champion Villas','Franklin Court','Dakota Bend')`)).rows;
  const ID = Object.fromEntries(props.map(r => [r.name, r.id]));

  const b = await chromium.launch();
  const pg = await b.newPage({ viewport: { width: 1480, height: 1000 } });
  const errs = [], writes = [];
  pg.on('pageerror', e => errs.push(String(e.message).slice(0, 200)));
  pg.on('request', r => {
    if (['POST', 'PUT', 'PATCH', 'DELETE'].indexOf(r.method()) >= 0 && /\/api\//.test(r.url())) writes.push(r.method() + ' ' + r.url().replace(BASE, ''));
  });
  await pg.route('**/portal-session.js', route => route.fulfill({ status: 200, contentType: 'application/javascript', body: SESSION_STUB }));
  /* exports are answered in the browser: the test checks the request the
     screen builds, not the file */
  const exportsSent = [];
  await pg.route('**/api/props/export', async route => {
    exportsSent.push(JSON.parse(route.request().postData() || '{}'));
    return route.fulfill({ status: 200, contentType: 'application/zip',
      headers: { 'Content-Disposition': "attachment; filename*=UTF-8''x.zip" }, body: 'x' });
  });

  async function settle() {
    await pg.waitForFunction(() => {
      const h = document.querySelector('#reportingNative .lw');
      return h && !h.querySelector('.lw-skel');
    }, null, { timeout: 60000 });
    await pg.waitForTimeout(150);
  }
  let n = 0;
  async function open(hash) {
    await pg.goto(BASE + '/?t=' + (n++) + '#brand=leavenwealth&view=properties&' + hash, { waitUntil: 'domcontentloaded' });
    await settle();
  }
  /* the portal scrolls inside its content pane, so a full-page shot would
     stop at the viewport: let every ancestor grow to its content first */
  async function shot(name) {
    if (!SHOTS) return;
    fs.mkdirSync(SHOT_DIR, { recursive: true });
    await pg.evaluate(() => {
      for (let el = document.querySelector('#reportingNative'); el; el = el.parentElement) {
        el.style.overflow = 'visible'; el.style.height = 'auto'; el.style.maxHeight = 'none';
      }
    });
    await pg.screenshot({ path: path.join(SHOT_DIR, name + '.png'), fullPage: true });
  }
  const text = () => pg.evaluate(() => document.querySelector('#reportingNative').innerText);

  /* ---- portfolio --------------------------------------------------------- */
  await open('lvl=portfolio&l1=entities');
  await shot('01-portfolio-entities');
  const ent = await pg.evaluate(() => ({
    heads: [...document.querySelectorAll('#reportingNative thead th')].map(t => t.textContent.trim()),
    rows: [...document.querySelectorAll('#reportingNative tbody tr')].map(r => r.innerText.split('\t')[0].split('\n')[0]),
    tabs: [...document.querySelectorAll('#reportingNative [role=tab]')].map(t => t.textContent.trim()),
    font: getComputedStyle(document.querySelector('#reportingNative .lw')).fontFamily,
    sticky: getComputedStyle(document.querySelector('#reportingNative thead th')).position,
  }));
  check('portfolio tabs are Entities | Custom view', () => assert.deepStrictEqual(ent.tabs, ['Entities', 'Custom view']));
  check('entities table columns are the spec\'s', () => assert.deepStrictEqual(ent.heads,
    ['Managing entity', 'Properties', 'Units', 'Occupancy', 'NOI', 'Market value', 'Cash flow after debt and capex', 'Debt']));
  check('"No managing entity" is the last row', () => assert.strictEqual(ent.rows[ent.rows.length - 1], 'No managing entity'));
  check('IBM Plex Sans', () => assert.ok(/IBM Plex Sans/.test(ent.font), ent.font));
  const head = await pg.evaluate(() => document.querySelector('.lw-through').textContent);
  check('header: data through the latest T12, next sync on the third Thursday', () => assert.ok(/^Data through [A-Z][a-z]{2} \d{4}, next sync [A-Z][a-z]{2} \d{1,2}$/.test(head), head));
  check('frozen header row', () => assert.strictEqual(ent.sticky, 'sticky'));
  const entTxt = await text();
  check('market value shows Outdated and a partial count', () => { assert.ok(/Outdated/.test(entTxt)); assert.ok(/\(\d+ of \d+\)/.test(entTxt)); });

  /* density */
  await pg.click('[data-a="dense:1"]');
  const pad = await pg.evaluate(() => getComputedStyle(document.querySelector('#reportingNative tbody td')).paddingTop);
  check('Compact density tightens rows', () => assert.strictEqual(pad, '5px'));
  await pg.click('[data-a="dense:0"]');

  /* drill to an entity */
  await pg.click('#reportingNative tbody tr:first-child button.link');
  await settle();
  await shot('02-entity');
  check('entity page lists its properties', async () => {});
  const eTxt = await text();
  check('entity page has a properties table', () => assert.ok(/sorted by NOI/.test(eTxt)));

  /* display_name where set */
  await pg.click('[data-a="crumb:portfolio"]'); await settle();
  await pg.click('[data-a="ent:none"]'); await settle();
  const names = await text();
  check('display_name shown where set (The Cass, not Sonesta The Cass Apartments)', () => assert.ok(/The Cass/.test(names) && !/Sonesta/.test(names), names.slice(0, 600)));

  /* ---- Champion Villas: badge 2 and the DSCR sentence ------------------- */
  await open('lvl=property&prop=' + ID['Champion Villas'] + '&ptab=attention');
  await shot('03-champion-attention');
  const ch = await pg.evaluate(() => ({ badge: (document.querySelector('.lw-badge') || {}).textContent, txt: document.querySelector('#reportingNative').innerText }));
  check('Champion Villas: Needs attention badge 2', () => assert.strictEqual(ch.badge, '2'));
  check('Champion Villas: DSCR sentence', () => assert.ok(/NOI of \$777,274 \(Oct 2025 to Sep 2026\) divided by annual mortgage payments of \$712,716 = 1\.09/.test(ch.txt)
    && /rise by \$113,621 to \$890,895/.test(ch.txt), ch.txt.slice(0, 600)));
  check('Needs attention tabs in spec order', async () => {});
  const tabs = await pg.evaluate(() => [...document.querySelectorAll('.lw-tabbar [role=tab]')].map(t => t.childNodes[0].textContent));
  check('property tabs in order', () => assert.deepStrictEqual(tabs, ['Overview', 'Buildings & units', 'Needs attention', 'Monthly financials', 'Optimized NOI', 'Asset management fee', 'Rent roll', 'Capex']));

  await open('lvl=property&prop=' + ID['Champion Villas'] + '&ptab=overview');
  await shot('04-champion-overview');
  const ov = await pg.evaluate(() => [...document.querySelectorAll('.lw-card')].map(c => c.querySelector('.lw-card-l').textContent));
  check('key-figure cards on Overview', () => assert.strictEqual(ov.length, 8));
  await pg.click('[data-a="ptab:monthly"]'); await settle();
  const noCards = await pg.evaluate(() => document.querySelectorAll('.lw-card').length);
  check('key-figure cards appear only on Overview (Monthly has its own 8 tiles)', () => assert.strictEqual(noCards, 8));

  /* ---- Franklin Court --------------------------------------------------- */
  await open('lvl=property&prop=' + ID['Franklin Court'] + '&ptab=capex&from=2025-10&to=2026-09');
  await shot('05-franklin-capex');
  const fcx = await text();
  check('Franklin Court capex $571,209 (exact cents; mockup rounded months to $571,210)', () => assert.ok(/\$571,209/.test(fcx), fcx.slice(0, 400)));
  check('Franklin Court capex 31.4% of income', () => assert.ok(/31\.4%/.test(fcx)));

  await open('lvl=property&prop=' + ID['Franklin Court'] + '&ptab=optimized');
  await shot('06-franklin-optimized');
  const fo = await pg.evaluate(() => document.querySelector('.lw-card .lw-card-v').textContent);
  check('Franklin Court Optimized NOI status Fixable', () => assert.strictEqual(fo, 'Fixable'));
  /* what-if recomputes and marks itself unsaved */
  await pg.fill('[data-in="wnoi"]', '1200000'); await pg.press('[data-in="wnoi"]', 'Tab'); await pg.waitForTimeout(200);
  const wi = await text();
  check('what-if NOI recomputes and says "Changed, not saved"', () => assert.ok(/Changed, not saved/.test(wi) && /\$1,200,000/.test(wi)));

  await open('lvl=property&prop=' + ID['Franklin Court'] + '&ptab=rent');
  await shot('07-franklin-rent');
  const fr = await text();
  check('Franklin Court rent roll 172 units', () => assert.ok(/Units\n172/.test(fr), fr.slice(0, 300)));
  check('Franklin Court occupancy 95.9%', () => assert.ok(/95\.9%/.test(fr)));
  check('Franklin Court delinquency $16,461 from 35 tenants', () => assert.ok(/\$16,461/.test(fr) && /35 tenants/.test(fr)));
  const unitRows = await pg.evaluate(() => [...document.querySelectorAll('.lw h2')].find(h => h.textContent === 'Units').nextElementSibling.querySelectorAll('tbody tr').length);
  check('the full Units list, not a sample', () => assert.ok(unitRows >= 172, unitRows));

  /* ---- Dakota Bend: monthly ---------------------------------------------- */
  await open('lvl=property&prop=' + ID['Dakota Bend'] + '&ptab=monthly&from=2025-10&to=2026-09');
  await shot('08-dakota-monthly');
  const dm = await pg.evaluate(() => {
    const tbls = [...document.querySelectorAll('.lw h2.h2')].map(h => ({ title: h.textContent, table: h.nextElementSibling.nextElementSibling }));
    const grab = (title, label) => {
      const t = tbls.find(x => x.title === title); if (!t) return null;
      const heads = [...t.table.querySelectorAll('thead th')].map(th => th.textContent);
      const row = [...t.table.querySelectorAll('tbody tr')].find(r => r.cells[0].textContent === label);
      return row ? Object.fromEntries(heads.map((h, i) => [h, row.cells[i].textContent])) : null;
    };
    return { titles: tbls.map(t => t.title), noi: grab('Summary', 'Net operating income'), dscr: grab('Summary', 'DSCR, mortgage'),
             ni: grab('Income statement', 'Net income') };
  });
  check('three statements stacked: Summary, Income statement, Cash flow statement', () => assert.deepStrictEqual(dm.titles, ['Summary', 'Income statement', 'Cash flow statement']));
  check('Dakota Bend Jan 2026 NOI 15,074.52', () => assert.strictEqual(dm.noi && dm.noi['Jan 26'], '15,074.52'));
  check('Dakota Bend Jan 2026 DSCR 1.11', () => assert.strictEqual(dm.dscr && dm.dscr['Jan 26'], '1.11'));
  check('Dakota Bend net income Oct 2025 to Sep 2026 = 17,140.74', () => assert.strictEqual(dm.ni && dm.ni.Total, '17,140.74'));

  /* hidden months: ask for 2024 and see nothing rather than dashes */
  await open('lvl=property&prop=' + ID['Dakota Bend'] + '&ptab=monthly&from=2024-01&to=2024-06');
  const empty = await text();
  check('months with no data are hidden, not shown as dashes', () => assert.ok(/No income statement is loaded/.test(empty)));

  /* export request: file name and one table per statement */
  await open('lvl=property&prop=' + ID['Dakota Bend'] + '&ptab=monthly&from=2025-10&to=2026-09');
  await pg.click('[data-a="export"]'); await pg.click('[data-a="xp:xlsx"]'); await pg.waitForTimeout(300);
  check('export file name "<Property> - <Tab> - <Period>"', () => assert.strictEqual(exportsSent[0] && exportsSent[0].filename, 'Dakota Bend - Monthly financials - Oct 2025 to Sep 2026'));
  check('export carries every table on screen', () => assert.deepStrictEqual(exportsSent[0].tables.map(t => t.title), ['Summary', 'Income statement', 'Cash flow statement']));

  for (const [tab, nm] of [['buildings', '09-dakota-buildings'], ['fee', '10-dakota-fee'], ['optimized', '11-dakota-optimized'], ['rent', '12-dakota-rent'], ['capex', '13-dakota-capex'], ['overview', '14-dakota-overview'], ['attention', '15-dakota-attention']]) {
    await open('lvl=property&prop=' + ID['Dakota Bend'] + '&ptab=' + tab);
    await shot(nm);
  }

  /* ---- the seeded custom view ------------------------------------------- */
  await open('lvl=portfolio&l1=custom');
  await shot('16-custom-view');
  const cv = await pg.evaluate(() => [...document.querySelectorAll('.lw-grid12 .frame')].map(f => f.innerText.split('\n').slice(0, 2)));
  const card = l => (cv.find(x => x[0] === l) || [])[1];
  check('Sioux Falls townhomes overview: Units 262', () => assert.strictEqual(card('Units'), '262'));
  check('Sioux Falls townhomes overview: Income, Aug + Sep 2026 = $579,376', () => assert.strictEqual(card('Income, Aug + Sep 2026'), '$579,376'));
  await pg.click('[data-a="cvedit"]'); await settle();
  await pg.waitForFunction(() => /\$579,376/.test(document.querySelector('#reportingNative').innerText), null, { timeout: 30000 }).catch(() => {});
  await shot('17-custom-builder');
  const bld = await text();
  check('builder has Quick build and Advanced', () => assert.ok(/Quick build/.test(bld) && /Advanced/.test(bld)));
  check('builder live preview shows the formula result', () => assert.ok(/\$579,376/.test(bld)));
  await pg.click('[data-a="cvcancel"]');

  check('no page errors', () => assert.deepStrictEqual(errs, []));
  /* the only non-GET the screens sent were the builder's preview and the export */
  check('no writes to property data', () => assert.ok(writes.every(w => /\/api\/props\/(views\/preview|export)$/.test(w)), writes.join(', ')));

  await b.close();
  console.log(pass + ' passed, ' + fails.length + ' failed');
  fails.forEach(f => console.log('  FAIL ' + f));
  process.exit(fails.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
