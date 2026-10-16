/* Custom view: dates, resizable blocks and the spreadsheet, in a real browser
   against the real server and database. Same harness as test-props-ui.js
   (the access RPC and portal-session.js are stubbed). The view is a fixture
   served through the real evaluation (POST /api/props/views/preview); saves
   are captured, not written: nothing in the database changes.

   Run:  node test/test-custom-sheet-ui.js [--shots <dir>]
*/
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
for (const l of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
  const m = /^([A-Za-z0-9_]+)=(.*)$/.exec(l.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
process.env.PORT = process.env.TEST_PORT || '3991';
const SHOT_AT = process.argv.indexOf('--shots');
const SHOT_DIR = SHOT_AT >= 0 ? process.argv[SHOT_AT + 1] : null;

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
const SESSION_STUB = `
  window.PortalSession = {
    client: function () { return Promise.resolve({ auth: { getSession: function () { return Promise.resolve({ data: { session: { access_token: 'harness' } } }); } } }); },
    getSession: function () { return Promise.resolve({ access_token: 'harness' }); },
    access: function () {
      var LW = 'c0000000-0000-4000-8000-000000000003';
      var mods = { properties: 'edit', views: 'edit', loans: 'edit', financials: 'edit', tasks: 'edit', team: 'edit', documents: 'edit', tools: 'edit', departments: 'edit', exec: 'edit', orgdept: 'edit' };
      var a = { exec: mods }; a[LW] = mods;
      return Promise.resolve({ user: { id: 'harness', email: 'jay@leadliconsulting.com', full_name: 'Jay Delgado', role: 'owner' }, access: a, companies: { 'c0000000-0000-4000-8000-000000000003': 'LeavenWealth' } });
    },
    enforceRememberWindow: function () { return Promise.resolve(false); },
    signOut: function () { return Promise.resolve(); },
    config: function () { return Promise.resolve({ url: 'https://x.supabase.co', anonKey: 'k' }); },
  };`;

let pass = 0; const fails = [];
const check = (n, fn) => { try { fn(); pass++; } catch (e) { fails.push(n + ' -> ' + e.message.slice(0, 400)); } };
const money = s => Number(String(s).replace(/[$,()]/g, '')) * (/^\(/.test(s) ? -1 : 1);

(async () => {
  await new Promise(r => setTimeout(r, 1500));
  const props = (await db.q(`select s.id::text id from reporting.property_summary_mv s
      where s.ownership_status = 'held' and s.t12_income is not null and s.units_rent_roll > 0 order by s.name limit 5`)).rows.map(r => r.id);
  const FIXTURE_ID = '00000000-0000-4000-8000-000000000f02';
  let PERM = 'owner';
  let config = { mode: 'advanced', quickCards: false, groups: [], excl: [], props, fields: ['address', 'units', 'occ', 'inc', 'noi', 'debt'],
    styles: ['table'], chartField: 'inc', period: { t: 'ttm' }, layout: ['card:c1', 'card:c2', 'table'],
    cards: [{ id: 'c1', label: 'Units', kind: 'value', field: 'units', agg: 'total', size: 'S' },
            { id: 'c2', label: 'Income', kind: 'value', field: 'inc', period: { t: 'view' }, agg: 'total', size: 'M' }] };
  const saves = [];

  const b = await chromium.launch();
  const pg = await b.newPage({ viewport: { width: 1480, height: 1000 } });
  const errs = [];
  pg.on('pageerror', e => errs.push(String(e.message).slice(0, 300)));
  await pg.route('**/portal-session.js', route => route.fulfill({ status: 200, contentType: 'application/javascript', body: SESSION_STUB }));
  await pg.route(/\/api\/props\/views$/, async route => {
    if (route.request().method() !== 'GET') return route.continue();
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, views: [{ id: FIXTURE_ID, name: 'Sheet test', is_mine: PERM === 'owner', owner_staff_id: null, updated_at: null }] }) });
  });
  await pg.route(new RegExp('/api/props/views/' + FIXTURE_ID), async route => {
    const req = route.request();
    if (req.method() === 'PUT') { const body = JSON.parse(req.postData()); saves.push(body); config = body.config; return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }); }
    const u = new URL(req.url()), period = u.searchParams.get('period');
    const ev = await (await route.fetch({ url: BASE + '/api/props/views/preview', method: 'POST',
      headers: Object.assign({}, req.headers(), { 'content-type': 'application/json' }), postData: JSON.stringify({ config, period: period ? JSON.parse(period) : null }) })).json();
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, permission: PERM,
      view: { id: FIXTURE_ID, name: 'Sheet test', is_mine: PERM === 'owner', config: ev.config, shares: [] }, result: ev.result }) });
  });

  async function settle() {
    await pg.waitForFunction(() => { const h = document.querySelector('#reportingNative .lw'); return h && !h.querySelector('.ld-full, .ld-stale'); }, null, { timeout: 60000 });
    await pg.waitForTimeout(250);
  }
  async function shot(n) { if (SHOT_DIR) await pg.screenshot({ path: path.join(SHOT_DIR, n + '.png'), fullPage: false }); }
  const cell = (r, c) => pg.locator('td[data-sx="' + r + ':' + c + '"]');
  const txt = async (r, c) => (await cell(r, c).innerText()).trim();
  const T = props.length + 1;   /* the Total row */

  await pg.goto(BASE + '/?t=1#brand=leavenwealth&view=properties&lvl=portfolio&l1=custom&cv=' + FIXTURE_ID, { waitUntil: 'domcontentloaded' });
  await pg.waitForSelector('table.sx', { timeout: 60000 });
  await settle();
  await shot('01-sheet');

  /* the grid */
  const head = await pg.evaluate(() => [...document.querySelectorAll('table.sx thead th.sx-cl')].slice(0, 3).map(t => t.innerText.trim()));
  check('column letters A B C', () => assert.deepStrictEqual(head, ['A', 'B', 'C']));
  const a1 = await txt(0, 0); check('A1 reads Property', () => assert.strictEqual(a1, 'Property'));
  const totLbl = await txt(T, 0); check('the Total row sits under the properties', () => assert.strictEqual(totLbl, 'Total'));

  /* dates: pick "Last 3 months"; income changes, units do not */
  const incTTM = money(await txt(T, 4)), unitsTTM = await txt(T, 2);
  await pg.selectOption('select[data-in="vp"]', 'last:3'); await settle();
  await pg.waitForFunction(() => /last 3 months/i.test(document.querySelector('#reportingNative').innerText), null, { timeout: 30000 }).catch(() => {});
  const inc3 = money(await txt(T, 4)), units3 = await txt(T, 2);
  check('dates: last 3 months income is less than trailing 12', () => assert.ok(inc3 > 0 && inc3 < incTTM, inc3 + ' vs ' + incTTM));
  check('dates: units (rent roll) do not move with the dates', () => assert.strictEqual(units3, unitsTTM));
  const note = await pg.locator('#reportingNative').innerText();
  check('dates: the view says which months it shows', () => assert.ok(/Showing last 3 months/.test(note)));
  const card2 = await pg.evaluate(() => [...document.querySelectorAll('.lw-grid12 .frame')].map(f => f.innerText.split('\n')).find(x => x[0] === 'Income'));
  check('dates: a card set to the view\'s dates follows them', () => assert.strictEqual(money(card2[1]), Math.round(inc3)));
  await shot('02-dates');
  await pg.selectOption('select[data-in="vp"]', ''); await settle();
  const incBack = money(await txt(T, 4)); check('dates: back to trailing 12', () => assert.strictEqual(incBack, incTTM));

  /* a formula column: NOI per unit, typed once, filled down, total over totals */
  await pg.click('[data-sxa="addf"]'); await settle();
  await cell(1, 7).dblclick(); await pg.keyboard.type('=F2/C2'); await pg.keyboard.press('Enter'); await settle();
  const r1 = { noi: money(await txt(1, 5)), units: Number((await txt(1, 2)).replace(/,/g, '')), v: money(await txt(1, 7)) };
  const tt = { noi: money(await txt(T, 5)), units: Number((await txt(T, 2)).replace(/,/g, '')), v: money(await txt(T, 7)) };
  check('formula column: row 1 is NOI / units', () => assert.ok(Math.abs(r1.v - r1.noi / r1.units) <= 1, JSON.stringify(r1)));
  const filled = await pg.evaluate(n => [...Array(n).keys()].map(i => document.querySelector('td[data-sx="' + (i + 1) + ':7"]').innerText.trim()).filter(Boolean).length, props.length);
  check('formula column: all ' + props.length + ' rows filled', () => assert.strictEqual(filled, props.length));
  check('formula column: Total is total NOI / total units', () => assert.ok(Math.abs(tt.v - tt.noi / tt.units) <= 1, JSON.stringify(tt)));
  await cell(3, 7).click(); await settle();
  const bar = await pg.inputValue('[data-sxbar]');
  check('formula bar shows the row\'s own formula', () => assert.strictEqual(bar, '=F4/C4'));

  /* the calculation area: whole column, weighted occupancy, point-and-click */
  await cell(T + 1, 0).click(); await pg.keyboard.type('=SUM(C:C)'); await pg.keyboard.press('Enter'); await settle();
  const sumC = await txt(T + 1, 0);
  check('free cell: SUM(C:C) equals the units Total', () => assert.strictEqual(sumC.replace(/,/g, ''), String(tt.units)));
  await cell(T + 2, 0).click(); await pg.keyboard.type('=SUMPRODUCT(C2:C' + (props.length + 1) + ',D2:D' + (props.length + 1) + ')/SUM(C:C)'); await pg.keyboard.press('Enter'); await settle();
  const occCalc = Number(await pg.evaluate(k => window.PortalSheet._state[k].grid.value(window.PortalSheet._state[k].grid.T + 2, 0), FIXTURE_ID));
  const occTot = Number(await pg.evaluate(k => window.PortalSheet._state[k].grid.value(window.PortalSheet._state[k].grid.T, 3), FIXTURE_ID));
  check('free cell: unit-weighted occupancy matches the Total row', () => assert.ok(Math.abs(occCalc - occTot) < 1e-9, occCalc + ' vs ' + occTot));
  /* type "=", click C2, type "*2" */
  await cell(T + 3, 1).click(); await pg.keyboard.type('='); await settle();
  await cell(1, 2).click();
  await pg.keyboard.type('*2'); await pg.keyboard.press('Enter'); await settle();
  await cell(T + 3, 1).click(); await settle();
  const picked = await pg.inputValue('[data-sxbar]');
  check('clicking a cell while typing a formula writes its address', () => assert.strictEqual(picked, '=C2*2'));
  const pickedV = await txt(T + 3, 1);
  check('… =C2*2 is twice the first property\'s units', () => assert.strictEqual(Number(pickedV.replace(/,/g, '')), r1.units * 2));

  /* selection statistics, read-only data, undo */
  await cell(1, 2).click(); await cell(props.length, 2).click({ modifiers: ['Shift'] }); await settle();
  const status = await pg.locator('.sx-status').innerText();
  check('selecting a range shows its sum', () => assert.ok(new RegExp('Sum ' + tt.units.toLocaleString('en-US')).test(status), status));
  await cell(1, 4).click(); await pg.keyboard.type('5'); await settle();
  const ro = await pg.locator('.sx-status').innerText();
  check('a data cell cannot be typed over, and says why', () => assert.ok(/comes from the data/.test(ro), ro));
  await cell(T + 3, 1).click(); await pg.keyboard.press('Delete'); await settle();
  const cleared = await txt(T + 3, 1); check('Delete clears it', () => assert.strictEqual(cleared, ''));
  await pg.keyboard.press('Control+z'); await settle();
  const undone = await txt(T + 3, 1); check('Ctrl+Z brings it back', () => assert.strictEqual(Number(undone.replace(/,/g, '')), r1.units * 2));

  /* resize a column and a row by dragging their edges */
  const wB0 = await pg.evaluate(() => document.querySelector('col[data-sxw="1"]').getBoundingClientRect().width || parseFloat(document.querySelector('col[data-sxw="1"]').style.width));
  const hB = await pg.locator('[data-sxcol="1"]').boundingBox();
  await pg.mouse.move(hB.x + 3, hB.y + 8); await pg.mouse.down(); await pg.mouse.move(hB.x + 93, hB.y + 8, { steps: 6 }); await pg.mouse.up(); await settle();
  const wB1 = await pg.evaluate(() => parseFloat(document.querySelector('col[data-sxw="1"]').style.width));
  check('dragging a column edge widens it by the drag', () => assert.ok(Math.abs(wB1 - (wB0 + 90)) <= 2, wB0 + ' -> ' + wB1));
  const rB = await pg.locator('[data-sxrow="2"]').boundingBox();
  await pg.mouse.move(rB.x + 10, rB.y + 3); await pg.mouse.down(); await pg.mouse.move(rB.x + 10, rB.y + 43, { steps: 5 }); await pg.mouse.up(); await settle();
  const h2 = await pg.evaluate(() => document.querySelector('td[data-sx="2:0"]').closest('tr').getBoundingClientRect().height);
  check('dragging a row edge makes it taller', () => assert.ok(h2 >= 66, 'row height ' + h2));

  /* resize a card by its corner: two columns wider, one row taller */
  const box0 = await pg.locator('[data-rsbox="card:c1"]').boundingBox();
  await pg.hover('[data-rsbox="card:c1"]');
  const hd = await pg.locator('[data-rsbox="card:c1"] [data-rs]').boundingBox();
  const grid = await pg.locator('.lw-grid12').first().boundingBox();
  const step = (grid.width - 110) / 12 + 10;
  await pg.mouse.move(hd.x + 8, hd.y + 8); await pg.mouse.down(); await pg.mouse.move(hd.x + 8 + step * 2, hd.y + 8 + 54, { steps: 8 }); await pg.mouse.up(); await settle();
  const box1 = await pg.locator('[data-rsbox="card:c1"]').boundingBox();
  check('a card corner drag: two columns wider', () => assert.ok(Math.abs(box1.width - (box0.width + 2 * step)) <= 4, box0.width + ' -> ' + box1.width));
  check('a card corner drag: one row taller', () => assert.ok(Math.abs(box1.height - (box0.height + 54)) <= 2, box0.height + ' -> ' + box1.height));
  /* keyboard: focus the handle, arrow left */
  await pg.focus('[data-rsbox="card:c1"] [data-rs]'); await pg.keyboard.press('ArrowLeft'); await settle();
  const box2 = await pg.locator('[data-rsbox="card:c1"]').boundingBox();
  check('a card handle with the keyboard: one column narrower', () => assert.ok(Math.abs(box2.width - (box1.width - step)) <= 4, box1.width + ' -> ' + box2.width));

  /* everything above was saved with the view (captured, not written) */
  await pg.waitForTimeout(1200);
  const last = saves[saves.length - 1] || { config: {} };
  const sh = last.config.sheet || {};
  check('changes are saved automatically', () => assert.ok(saves.length >= 1, 'saves ' + saves.length));
  check('saved: the formula column, by column key', () => assert.strictEqual((sh.cols || [])[0] && sh.cols[0].f, '={noi|d1}/{units|d1}'));
  check('saved: the calculation cells, by column key', () => assert.strictEqual(sh.cells && sh.cells['1|name'] && sh.cells['1|name'].v, '=SUM({units}:{units})'));
  check('saved: the column width', () => assert.ok(sh.colW && Math.abs(sh.colW.address - wB1) <= 1, JSON.stringify(sh.colW)));
  check('saved: the card size', () => assert.deepStrictEqual((last.config.cards || []).filter(c => c.id === 'c1').map(c => [c.w, c.h]), [[4, 3]]));
  check('saved: the row count, for ranges to follow new properties', () => assert.strictEqual(sh.n, props.length));
  await shot('03-edited');

  /* reload: everything comes back from the saved config */
  await pg.reload({ waitUntil: 'domcontentloaded' }); await pg.waitForSelector('table.sx', { timeout: 60000 }); await settle();
  const after = await txt(1, 7);
  check('after a reload the formula column is still there', () => assert.strictEqual(money(after), r1.v));

  /* the builder: dates, width/height, resizable layout tiles */
  await pg.click('[data-a="cvedit"]'); await settle();
  await pg.click('[data-a="bmode:advanced"]').catch(() => {}); await settle();
  const bt = await pg.locator('#reportingNative').innerText();
  const dSel = await pg.locator('select[data-in="d:period"]').count();
  check('builder: a Dates setting for the view', () => assert.ok(/\bDates\b/.test(bt) && dSel === 1));
  const tiles = await pg.locator('[data-rsctx="b"]').count();
  check('builder: one size handle per block', () => assert.strictEqual(tiles, 3));
  check('builder: "Spreadsheet" is a display choice', () => assert.ok(/Spreadsheet/.test(bt)));
  await shot('04-builder');
  await pg.click('[data-a="cvcancel"]'); await settle();

  /* someone who can only view: no toolbar, nothing saved */
  PERM = 'viewer';
  const n0 = saves.length;
  await pg.reload({ waitUntil: 'domcontentloaded' }); await pg.waitForSelector('table.sx', { timeout: 60000 }); await settle();
  const tb = await pg.locator('[data-sxa="addf"]').count(); check('view only: no "+ Formula column"', () => assert.strictEqual(tb, 0));
  const rs = await pg.locator('[data-rs]').count(); check('view only: no size handles', () => assert.strictEqual(rs, 0));
  await cell(T + 4, 0).click(); await pg.keyboard.type('7'); await settle();
  const vo = await pg.locator('.sx-status').innerText();
  check('view only: typing says it cannot be changed', () => assert.ok(/view this sheet but not change it/.test(vo), vo));
  check('view only: nothing saved', () => assert.strictEqual(saves.length, n0));

  /* phone width: blocks stack, no sideways page scroll */
  await pg.setViewportSize({ width: 390, height: 844 }); await settle();
  const sideways = await pg.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  check('phone: no sideways page scroll', () => assert.ok(!sideways));
  const clipped = await pg.evaluate(() => { const f = document.querySelector('#reportingNative section.frame'); return f.scrollWidth - f.clientWidth; });
  check('phone: nothing clipped inside the view', () => assert.ok(clipped <= 1, 'overflow ' + clipped + 'px'));
  await shot('05-phone');
  await pg.setViewportSize({ width: 1480, height: 1000 });
  await pg.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark')); await settle();
  await shot('06-dark');

  check('no script errors', () => assert.deepStrictEqual(errs, []));
  await b.close();
  console.log('custom view sheet ui: ' + pass + ' passed, ' + fails.length + ' failed');
  fails.forEach(f => console.log('  FAIL ' + f));
  process.exit(fails.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
