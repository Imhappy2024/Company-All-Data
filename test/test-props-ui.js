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
  const props = (await db.q(`select id, name from reporting.property_summary_mv where name in ('Champion Villas','Franklin Court','Dakota Bend','Sonesta The Cass Apartments')`)).rows;
  const ID = Object.fromEntries(props.map(r => [r.name, r.id]));
  /* the Portfolio groups by OWNER entity (property.entity_id), Jay 2026-10-13 */
  const own = (await db.q(`select count(distinct entity_id) n,
      (select entity_id from reporting.property_summary_mv where name = 'Sonesta The Cass Apartments') cass
      from reporting.property_summary_mv where ownership_status = 'held' and t12_income is not null`)).rows[0];

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

  /* The custom-view checks bring their OWN view. They used to read the live
     "Sioux Falls townhomes overview", a real person's view that was deleted in
     the app on 2026-10-13, after which the first view on screen was another
     one and three checks failed. This is that view's exact config, with its
     group's five properties listed directly, served through the real
     evaluation (POST /api/props/views/preview). Nothing is written. */
  const FIXTURE_ID = '00000000-0000-4000-8000-000000000f01';
  const fixtureProps = (await db.q(`select id from reporting.property_summary_mv where name in
      ('Bancroft Place Apartments', 'Boulder Pointe Townhomes', 'Cleveland Park Townhomes', 'Town Park Townhomes', 'The Maples Townhomes')`)).rows.map(r => r.id);
  const FIXTURE = { name: 'Sioux Falls townhomes overview', config: { mode: 'advanced', quickCards: false, groups: [], excl: [], props: fixtureProps,
    fields: ['address', 'units', 'occ', 'inc', 'noi', 'debt'], styles: ['chart', 'table'], chartField: 'inc',
    layout: ['card:c1', 'card:c2', 'card:c3', 'card:c4', 'card:c5', 'chart', 'table'],
    cards: [
      { id: 'c1', label: 'Units', kind: 'value', field: 'units', period: { t: 'ttm' }, agg: 'total', size: 'S' },
      { id: 'c2', label: 'Total operating income, last 12 months', kind: 'value', field: 'inc', period: { t: 'ttm' }, agg: 'total', size: 'M' },
      { id: 'c3', label: 'Income, Aug + Sep 2026', kind: 'formula', fmt: 'money', size: 'M', terms: [
        { kind: 'field', field: 'inc', period: { t: 'month', a: '2026-08' }, agg: 'total' }, { op: '+', kind: 'field', field: 'inc', period: { t: 'month', a: '2026-09' }, agg: 'total' }] },
      { id: 'c4', label: 'NOI per unit', kind: 'formula', fmt: 'money', size: 'S', terms: [
        { kind: 'field', field: 'noi', period: { t: 'ttm' }, agg: 'total' }, { op: '/', kind: 'field', field: 'units', period: { t: 'ttm' }, agg: 'total' }] },
      { id: 'c5', label: 'NOI, Sep 2026', kind: 'value', field: 'noi', period: { t: 'month', a: '2026-09' }, agg: 'total', size: 'L' }] } };
  await pg.route(/\/api\/props\/views$/, async route => {
    if (route.request().method() !== 'GET') return route.continue();
    const real = await (await route.fetch()).json();
    real.views = [{ id: FIXTURE_ID, name: FIXTURE.name, is_mine: true, owner_staff_id: null, updated_at: null }].concat(real.views || []);
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(real) });
  });
  await pg.route('**/api/props/views/' + FIXTURE_ID, async route => {
    const ev = await (await route.fetch({ url: BASE + '/api/props/views/preview', method: 'POST',
      headers: Object.assign({}, route.request().headers(), { 'content-type': 'application/json' }), postData: JSON.stringify({ config: FIXTURE.config }) })).json();
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, permission: 'owner',
      view: { id: FIXTURE_ID, name: FIXTURE.name, is_mine: true, config: ev.config, shares: [] }, result: ev.result }) });
  });

  async function settle() {
    await pg.waitForFunction(() => {
      const h = document.querySelector('#reportingNative .lw');
      return h && !h.querySelector('.ld-full, .ld-stale');
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
  check('portfolio tabs are Entities | Custom view | Reports', () => assert.deepStrictEqual(ent.tabs, ['Entities', 'Custom view', 'Reports']));
  check('entities table columns are the spec\'s', () => assert.deepStrictEqual(ent.heads,
    ['Owner entity', 'Properties', 'Units', 'Physical occupancy', 'Economic occupancy', 'NOI', 'Market value', 'Cash flow after debt and capex', 'Debt']));
  check('one row per owner entity, and no "No managing entity" bucket', () => {
    assert.strictEqual(ent.rows.length, Number(own.n));
    assert.ok(ent.rows.indexOf('No managing entity') < 0);
  });
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
  await pg.click('[data-a="ent:' + own.cass + '"]'); await settle();
  const names = await text();
  check('display_name shown where set (The Cass, not Sonesta The Cass Apartments)', () => assert.ok(/The Cass/.test(names) && !/Sonesta/.test(names), names.slice(0, 600)));

  /* ---- Champion Villas: badge 2 and the DSCR sentence ------------------- */
  await open('lvl=property&prop=' + ID['Champion Villas'] + '&ptab=attention');
  await shot('03-champion-attention');
  const ch = await pg.evaluate(() => ({ badge: (document.querySelector('.lw-badge') || {}).textContent, txt: document.querySelector('#reportingNative').innerText }));
  /* 3 since 2026-10-14: the Optimized NOI status (At risk, lender view 1.05) is a flag too */
  check('Champion Villas: Needs attention badge 3', () => assert.strictEqual(ch.badge, '3'));
  check('Champion Villas: refinance status flag', () => assert.ok(/Refinance status At risk: lender view DSCR 1.05 against 1.25 required/.test(ch.txt), ch.txt.slice(0, 900)));
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
  /* Acceptance (Jay, 2026-10-14, docs/mockup/optimized-noi.dc.html): every
     window ends at the latest month. T12 $828,323; T3 x 4 $1,021,044
     (Improving); lender view $915,997; stabilized $908,262; max loan at
     stabilized $9,579,792 in the brief, which rounded its inputs to dollars:
     with cents it is $9,579,795 (+$1,499,795 against $8,080,000). At risk. */
  const fopt = await pg.evaluate(() => {
    const cards = Object.fromEntries([...document.querySelectorAll('#reportingNative .lw-card')].map(c => [c.querySelector('.lw-card-l').textContent, [c.querySelector('.lw-card-v').textContent, c.querySelector('.lw-card-s').textContent]]));
    const rows = [...document.querySelectorAll('#reportingNative tr')].map(r => [...r.cells].map(c => c.innerText.trim().replace(/\s*\n\s*/g, ' | ')));
    return { cards, rows, txt: document.querySelector('#reportingNative').innerText };
  });
  const rowStarting = re => fopt.rows.find(r => re.test(r[0] || '')) || [];
  check('Franklin Court status At risk', () => assert.strictEqual(fopt.cards.Status[0], 'At risk', JSON.stringify(fopt.cards)));
  check('Franklin Court cards: T12 $828,323, T3 x 4 $1,021,044 Improving, lender $915,997, stabilized $908,262', () => {
    assert.strictEqual(fopt.cards['NOI, trailing 12 mo'][0], '$828,323');
    assert.deepStrictEqual([fopt.cards['NOI, last 3 mo × 4'][0], /^Improving/.test(fopt.cards['NOI, last 3 mo × 4'][1])], ['$1,021,044', true]);
    assert.strictEqual(fopt.cards['Lender view NOI'][0], '$915,997');
    assert.strictEqual(fopt.cards['Stabilized NOI'][0], '$908,262');
  });
  check('max loan at stabilized $9,579,795, +$1,499,795 against the $8,080,000 loan', () => {
    assert.strictEqual(fopt.cards['Max loan, stabilized'][0], '$9,579,795');
    assert.deepStrictEqual(fopt.cards['Compared with current loan'], ['+$1,499,795', 'Current $8,080,000']);
  });
  check('eight cards, no best-months-anywhere figure', () => {
    assert.strictEqual(Object.keys(fopt.cards).length, 8);
    assert.ok(!/best 6|best 3|Best NOI|best month/i.test(fopt.txt), 'old wording still on the page');
  });
  check('NOI ladder rows in order, all ending Sep 26', () => {
    const names = ['Trailing 12 months', 'Trailing 6 months × 2', 'Trailing 3 months × 4', 'Lender view', 'Stabilized', 'What-if'];
    const got = names.map(n => rowStarting(new RegExp('^' + n.replace(/[×()]/g, '.'))));
    got.forEach((r, i) => assert.ok(r.length, 'missing ' + names[i]));
    assert.deepStrictEqual(got.slice(0, 3).map(r => r[1]), ['Oct 25 to Sep 26', 'Apr 26 to Sep 26', 'Jul 26 to Sep 26']);
    assert.strictEqual(got[3][1], 'Income Jul to Sep × 4, expenses T12');
  });
  check('assumptions grid: actual DSCR 1.07, 7.50% rate, interest only, $8,080,000, $774,392', () => {
    const act = rowStarting(/^Actual$/).join(' ');
    assert.ok(/1\.07/.test(act) && /7\.50%/.test(act) && /Interest only/.test(act) && /\$8,080,000/.test(act) && /\$774,392/.test(act), act);
  });
  /* other income is 1,821,712.17 - 1,579,878.50 = 241,833.67: the brief's $241,833 rounded first */
  check('stabilized line by line: GPR $1,792,440, other income $241,834, reserves $43,000', () => {
    assert.strictEqual(rowStarting(/^Gross potential rent/)[1], '$1,792,440');
    assert.strictEqual(rowStarting(/^\+ Other income/)[1], '$241,834');
    assert.strictEqual(rowStarting(/^− Replacement reserves/)[1], '($43,000)');
  });
  /* an assumption recomputes and marks itself unsaved */
  await pg.fill('[data-in="oa:w"]', '1200000'); await pg.press('[data-in="oa:w"]', 'Tab'); await pg.waitForTimeout(200);
  const wi = await text();
  check('what-if NOI recomputes and says "Changed, not saved"', () => assert.ok(/Changed, not saved/.test(wi) && /\$1,200,000/.test(wi)));

  await open('lvl=property&prop=' + ID['Sonesta The Cass Apartments'] + '&ptab=optimized');
  const cass = await pg.evaluate(() => document.querySelector('#reportingNative .lw-card .lw-card-v').textContent);
  check('The Cass status Critical', () => assert.strictEqual(cass, 'Critical'));
  await open('lvl=property&prop=' + ID['Champion Villas'] + '&ptab=optimized');
  const champ = await text();
  check('Champion Villas: rent is base rent now, so no rent-data warning and a stabilized NOI', () =>
    assert.ok(!/Rent collected over the last 12 months/.test(champ) && /Stabilized NOI\n\$763,531/.test(champ), champ.slice(0, 500)));

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

  /* ---- the custom view (the fixture above) ------------------------------------------- */
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

  /* LeavenWealth's default page (Jay, 2026-10-13): a reload stays on the page,
     but leaving the business and coming back opens Properties > Portfolio */
  await open('lvl=property&prop=' + ID['Franklin Court'] + '&ptab=monthly');
  await pg.reload({ waitUntil: 'domcontentloaded' }); await settle();
  const afterReload = await pg.evaluate(() => document.querySelector('#reportingNative main').getAttribute('data-k'));
  check('reload stays on the property page', () => assert.strictEqual(afterReload, 'property:' + ID['Franklin Court']));
  await pg.evaluate(() => goHome());
  await pg.waitForTimeout(300);
  await pg.evaluate(() => setBrand('leavenwealth'));
  await settle();
  const back = await pg.evaluate(() => ({ k: document.querySelector('#reportingNative main').getAttribute('data-k'), hash: location.hash }));
  check('leaving LeavenWealth and coming back opens Properties > Portfolio', () => {
    assert.strictEqual(back.k, 'portfolio:entities');
    assert.ok(/view=properties/.test(back.hash) && /lvl=portfolio/.test(back.hash) && !/prop=/.test(back.hash), back.hash);
  });

  check('no page errors', () => assert.deepStrictEqual(errs, []));
  /* the only non-GET the screens sent were the builder's preview and the export */
  check('no writes to property data', () => assert.ok(writes.every(w => /\/api\/props\/(views\/preview|export)$/.test(w)), writes.join(', ')));

  await b.close();
  console.log(pass + ' passed, ' + fails.length + ' failed');
  fails.forEach(f => console.log('  FAIL ' + f));
  process.exit(fails.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
