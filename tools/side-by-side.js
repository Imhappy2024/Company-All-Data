// ===========================================================================
// tools/side-by-side.js — screenshots of every Properties screen next to the
// approved mockup, for the v2 report.
//
//   node tools/side-by-side.js        -> docs/screenshots/compare/*.png
//
// Left: the live portal against the live database (same identity stub as the
// UI tests: only the /rpc/dash_my_access call is answered locally).
// Right: docs/mockup/properties-mockup-standalone.html, opened directly.
// Nothing is written to the database.
// ===========================================================================
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
for (const l of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
  const m = /^([A-Za-z0-9_]+)=(.*)$/.exec(l.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
process.env.PORT = process.env.TEST_PORT || '3991';
const OUT = path.join(ROOT, 'docs', 'screenshots', 'compare');
const MOCK = 'file:///' + path.join(ROOT, 'docs', 'mockup', 'properties-mockup-standalone.html').replace(/\\/g, '/');

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
const BASE = 'http://127.0.0.1:' + process.env.PORT;
const SESSION_STUB = fs.readFileSync(path.join(ROOT, 'test', 'test-props-ui.js'), 'utf8').match(/const SESSION_STUB = `([\s\S]*?)`;/)[1];

(async () => {
  await new Promise(r => setTimeout(r, 1500));
  fs.mkdirSync(OUT, { recursive: true });
  const ids = Object.fromEntries((await db.q(`select name, id from reporting.property_summary_mv
    where name in ('Champion Villas','Franklin Court','Dakota Bend','Bancroft Place Apartments')`)).rows.map(r => [r.name, r.id]));
  const mgr = Object.fromEntries((await db.q(`select name, managing_entity_id from reporting.property_summary_mv where name in ('Champion Villas','Bancroft Place Apartments')`)).rows.map(r => [r.name, r.managing_entity_id]));

  const b = await chromium.launch();
  const live = await b.newPage({ viewport: { width: 1480, height: 1000 } });
  await live.route('**/portal-session.js', r => r.fulfill({ status: 200, contentType: 'application/javascript', body: SESSION_STUB }));
  const mock = await b.newPage({ viewport: { width: 1440, height: 1000 } });

  let n = 0;
  async function liveShot(hash, file, before) {
    await live.setViewportSize({ width: 1480, height: 1000 });
    await live.goto(BASE + '/?s=' + (n++) + '#brand=leavenwealth&view=properties&' + hash, { waitUntil: 'domcontentloaded' });
    const ready = () => live.waitForFunction(() => { const h = document.querySelector('#reportingNative .lw'); return h && !h.querySelector('.lw-skel'); }, null, { timeout: 60000 });
    await ready();
    if (before) { await before(live); await ready(); }
    await live.waitForTimeout(600);
    /* grow the viewport to the content, so the shot is the whole screen and
       no fixed overlay is un-clipped */
    const h = await live.evaluate(() => { const el = document.querySelector('#reportingNative'); let s = el; while (s && s.scrollHeight <= s.clientHeight) s = s.parentElement; return Math.min(6000, el.getBoundingClientRect().top + el.scrollHeight + 80); });
    await live.setViewportSize({ width: 1480, height: Math.max(1000, Math.ceil(h)) });
    await live.waitForTimeout(300);
    await live.screenshot({ path: file });
  }
  async function mockShot(steps, file) {
    await mock.setViewportSize({ width: 1440, height: 1000 });
    await mock.goto(MOCK, { waitUntil: 'load' });
    await mock.waitForSelector('.lw', { timeout: 60000 });
    for (const s of steps) {
      if (s.tab) await mock.getByRole('tab', { name: s.tab }).first().click();
      else if (s.text) await mock.getByRole('button', { name: s.text, exact: true }).first().click();
      await mock.waitForTimeout(250);
    }
    const h = await mock.evaluate(() => document.documentElement.scrollHeight);
    await mock.setViewportSize({ width: 1440, height: Math.min(6000, Math.max(1000, h)) });
    await mock.waitForTimeout(250);
    await mock.screenshot({ path: file });
  }
  async function compose(name, title) {
    const a = 'data:image/png;base64,' + fs.readFileSync(path.join(OUT, '_l.png')).toString('base64');
    const m = 'data:image/png;base64,' + fs.readFileSync(path.join(OUT, '_m.png')).toString('base64');
    const pg = await b.newPage({ viewport: { width: 2960, height: 1000 } });
    await pg.setContent(`<html><body style="margin:0;background:#fff;font:600 22px system-ui">
      <div style="display:flex;gap:0;align-items:flex-start">
        <div style="width:1480px"><div style="padding:10px 16px;background:#e8f2ef">Live: ${title}</div><img src="${a}" style="width:1480px;display:block"></div>
        <div style="width:1480px;border-left:4px solid #999"><div style="padding:10px 16px;background:#eee">Mockup</div><img src="${m}" style="width:1440px;display:block"></div>
      </div></body></html>`);
    await pg.waitForTimeout(200);
    const h = await pg.evaluate(() => document.body.scrollHeight);
    await pg.setViewportSize({ width: 2960, height: Math.min(8000, h) });
    await pg.screenshot({ path: path.join(OUT, name + '.png') });
    await pg.close();
    console.log('wrote ' + name);
  }

  const L = path.join(OUT, '_l.png'), M = path.join(OUT, '_m.png');
  const P = (name, tab) => 'lvl=property&prop=' + ids[name] + '&ptab=' + tab + '&from=2025-10&to=2026-09';
  const toProp = (ent, prop, tab) => [{ text: ent }, { text: prop }].concat(tab ? [{ tab: tab }] : []);
  const cases = [
    ['01-portfolio-entities', 'Portfolio, Entities', 'lvl=portfolio&l1=entities', []],
    ['02-entity', 'Entity page (BG Champion Managers LLC)', 'lvl=entity&ent=' + mgr['Champion Villas'], [{ text: 'BG Champion Managers LLC' }]],
    ['03-overview', 'Champion Villas, Overview', P('Champion Villas', 'overview'), toProp('BG Champion Managers LLC', 'Champion Villas', /^Overview/)],
    ['04-attention', 'Champion Villas, Needs attention', P('Champion Villas', 'attention'), toProp('BG Champion Managers LLC', 'Champion Villas', /^Needs attention/)],
    ['05-buildings', 'Bancroft Place, Buildings & units', P('Bancroft Place Apartments', 'buildings'), toProp('Boulder Bancroft Managers LLC', 'Bancroft Place Apartments', /^Buildings/)],
    ['06-monthly', 'Dakota Bend, Monthly financials', P('Dakota Bend', 'monthly'), toProp('Midwest Portfolio Managers 3 LLC', 'Dakota Bend', /^Monthly/)],
    ['07-optimized', 'Franklin Court, Optimized NOI', P('Franklin Court', 'optimized'), toProp('No managing entity', 'Franklin Court', /^Optimized/)],
    ['08-fee', 'Dakota Bend, Asset management fee', P('Dakota Bend', 'fee'), toProp('Midwest Portfolio Managers 3 LLC', 'Dakota Bend', /^Asset management/)],
    ['09-rent', 'Franklin Court, Rent roll', P('Franklin Court', 'rent'), toProp('No managing entity', 'Franklin Court', /^Rent roll/)],
    ['10-capex', 'Franklin Court, Capex', P('Franklin Court', 'capex'), toProp('No managing entity', 'Franklin Court', /^Capex/)],
    ['11-custom-view', 'Custom view: Sioux Falls townhomes overview', 'lvl=portfolio&l1=custom', [{ tab: /^Custom view/ }]],
  ];
  for (const [name, title, hash, steps] of cases) {
    try {
      await liveShot(hash, L);
      await mockShot(steps, M);
      await compose(name, title);
    } catch (e) { console.log('FAILED ' + name + ': ' + e.message.split('\n')[0]); }
  }
  try {
    await liveShot('lvl=portfolio&l1=custom', L, async pg => { await pg.click('[data-a="cvedit"]'); await pg.waitForTimeout(2500); });
    await mockShot([{ tab: /^Custom view/ }, { text: 'Edit' }], M);
    await compose('12-custom-builder', 'Custom view builder (Edit)');
  } catch (e) { console.log('FAILED builder: ' + e.message.split('\n')[0]); }
  fs.rmSync(L, { force: true }); fs.rmSync(M, { force: true });
  await b.close();
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
