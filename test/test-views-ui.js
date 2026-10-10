/* The Views builder: styling options (spec G2) and calculated columns (G3),
   driven in a real browser against the REAL API and the REAL database.

   Nothing is saved. A saved view is a row in a shared production table, so
   the config is checked by running it through the same validateConfig a
   save uses, in process, rather than by leaving test views behind. The
   identity harness is the one test-reporting-ui.js documents.

   Run:  node test/test-views-ui.js [--shots]
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

/* The doorman is stubbed at its OUTBOUND BOUNDARY, not by reassigning the
   export: portal-identity's guard() closes over the local `identify` binding,
   so overwriting module.exports.identify changes nothing - the real function
   still runs, calls Supabase with a token the harness invented, and answers
   401. The symptom is the section rendering "Session expired" while every
   other part of the page works, which reads like a client bug and is not. */
const db = require(path.join(ROOT, 'supabase-db.js'));
const realFetch = global.fetch;
let STAFF = null;
global.fetch = async function (url, init) {
  if (String(url).indexOf('/rpc/dash_my_access') >= 0) {
    if (!STAFF) {
      const r = await db.q(
        `select id, email, full_name, dashboard_role from public.staff
          where lower(email) = 'jay@leadliconsulting.com'`);
      STAFF = r.rows[0];
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

/* Served in PLACE OF portal-session.js rather than injected before the page:
   portal.html loads that file afterwards and the real module would simply
   overwrite an injected stub - the symptom being the portal bouncing to
   /login with nothing in the console to say why.

   enforceRememberWindow/getSession/access are the boot chain and every one is
   awaited; returning undefined from the first throws before readState() runs,
   so the hash is ignored and the portal lands on the no-access screen. */
const SESSION_STUB = `
  window.PortalSession = {
    client: function () {
      return Promise.resolve({ auth: { getSession: function () {
        return Promise.resolve({ data: { session: { access_token: 'harness' } } });
      } } });
    },
    getSession: function () { return Promise.resolve({ access_token: 'harness' }); },
    access: function () {
      var LW = 'c0000000-0000-4000-8000-000000000003';
      var mods = { properties: 'edit', views: 'edit', loans: 'edit', financials: 'edit',
                   tasks: 'edit', team: 'edit', documents: 'edit', tools: 'edit',
                   departments: 'edit', exec: 'edit', orgdept: 'edit' };
      var a = { exec: mods }; a[LW] = mods;
      return Promise.resolve({
        user: { id: 'harness', email: 'jay@leadliconsulting.com', full_name: 'Jay Delgado', role: 'owner' },
        access: a, companies: { 'c0000000-0000-4000-8000-000000000003': 'LeavenWealth' },
      });
    },
    enforceRememberWindow: function () { return Promise.resolve(false); },
    signOut: function () { return Promise.resolve(); },
    config: function () { return Promise.resolve({ url: 'https://x.supabase.co', anonKey: 'k' }); },
  };
`;

let pass = 0; const fails = [];
const check = (n, fn) => { try { fn(); pass++; } catch (e) { fails.push(n + ' -> ' + e.message); } };

const V = require(path.join(ROOT, 'views-api.js'))._internal;

/* A drag the way a hand does it: press, nudge past the drag threshold, then
   travel. locator.dragTo() jumps straight to the target, and Chromium does
   not always start a native drag from a single move. */
async function dragBy(pg, from, to) {
  /* centre the list first: near the top edge the pointer ends up under the
     sticky top bar and the drop lands there */
  await pg.locator(to).evaluate(el => el.parentNode.scrollIntoView({ block: 'center' }));
  const a = await pg.locator(from).boundingBox();
  const b = await pg.locator(to).boundingBox();
  await pg.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await pg.mouse.down();
  await pg.mouse.move(a.x + a.width / 2 + 6, a.y + a.height / 2 + 6, { steps: 3 });
  await pg.mouse.move(b.x + 40, b.y + b.height / 2, { steps: 12 });
  await pg.mouse.up();
  await pg.waitForTimeout(200);
}

(async () => {
  await new Promise(r => setTimeout(r, 1500));
  const b = await chromium.launch();
  const pg = await b.newPage({ viewport: { width: 1480, height: 1000 } });

  const errs = [], writes = [];
  pg.on('pageerror', e => errs.push(String(e.message).slice(0, 160)));
  pg.on('request', r => {
    if (['POST', 'PUT', 'PATCH', 'DELETE'].indexOf(r.method()) >= 0 && /\/api\//.test(r.url())) {
      writes.push(r.method() + ' ' + r.url().replace(BASE, ''));
    }
  });
  await pg.route('**/portal-session.js', route =>
    route.fulfill({ status: 200, contentType: 'application/javascript', body: SESSION_STUB }));

  const host = '#reportingNative';
  const state = () => pg.evaluate(() => JSON.parse(JSON.stringify(window.PortalViews._state.draft)));
  const step = async n => { await pg.click('[data-step="' + n + '"]'); await pg.waitForTimeout(250); };

  await pg.goto(BASE + '/?t=' + Date.now() + '#brand=leavenwealth&view=properties', { waitUntil: 'domcontentloaded' });
  await pg.waitForSelector('.rp-tab', { timeout: 45000 });
  await pg.locator('.rp-tab', { hasText: /^Views$/ }).first().click();
  await pg.waitForSelector('#svNew', { timeout: 30000 });
  await pg.click('#svNew');

  /* ---- Fields: choose, then build a calculated column by typing ---- */
  await step(3);
  for (const k of ['name', 't12_noi', 'units']) await pg.click('[data-f="' + k + '"]');
  await pg.click('#svAddCalc');
  const ta = pg.locator('[data-cf="0"]');
  await ta.click();
  await pg.keyboard.type('t12_noi / un', { delay: 15 });
  const acOpen = await pg.locator('#svAc0.open').count();
  const acText = await pg.locator('#svAc0').textContent();
  await pg.keyboard.press('Enter');
  const afterAc = await ta.inputValue();
  check('G3 autocomplete offers fields as you type', () => {
    assert.strictEqual(acOpen, 1);
    assert.ok(/units/.test(acText), acText);
  });
  check('G3 Enter inserts the suggestion', () => assert.strictEqual(afterAc, 't12_noi / units'));

  await pg.waitForSelector('[data-cs="0"] .sv-fok', { timeout: 20000 }).catch(() => {});
  const sampleRows = await pg.locator('[data-cs="0"] .sv-sample tr').count();
  check('G3 a valid formula previews on real rows', () => assert.ok(sampleRows >= 1, 'sample rows ' + sampleRows));

  await pg.click('#svAddCalc');
  await pg.locator('[data-cf="1"]').click();
  await pg.keyboard.type('1; drop table staff', { delay: 5 });
  await pg.waitForSelector('[data-cs="1"] .sv-ferr', { timeout: 20000 }).catch(() => {});
  const errText = await pg.locator('[data-cs="1"]').textContent();
  check('G3 SQL in a formula is refused with a reason', () => assert.ok(/Unexpected character ";"/.test(errText), errText));
  await pg.locator('[data-cf="1"]').fill('');
  await pg.locator('[data-cf="1"]').type('ROUND(t12_noi / units, 0) / 0', { delay: 2 });
  await pg.waitForSelector('[data-cs="1"] .sv-fok', { timeout: 20000 }).catch(() => {});
  const divText = await pg.locator('[data-cs="1"]').textContent();
  check('G3 divide by zero shows the not-available dash', () => assert.ok(/–/.test(divText), divText));
  await pg.click('[data-cx="1"]');

  /* ---- reorder, rename, number format ---- */
  let d = await state();
  const before = d.config.fields.map(f => f.key);
  await pg.click('[data-up="1"]');
  d = await state();
  check('G2 arrows reorder columns', () =>
    assert.deepStrictEqual(d.config.fields.map(f => f.key).slice(0, 2), [before[1], before[0]]));
  await pg.locator('[data-rn="1"]').fill('Asset');
  const noiIdx = (await state()).config.fields.findIndex(f => f.key === 't12_noi');
  await pg.selectOption('[data-nf="' + noiIdx + '"]', 'millions');

  /* drag reorder: move the calculated column to the top */
  const calcIdx = (await state()).config.fields.findIndex(f => f.key === 'calc_1');
  await dragBy(pg, '[data-ord="' + calcIdx + '"] .sv-grip', '[data-ord="0"]');
  await pg.waitForTimeout(200);
  d = await state();
  check('G2 drag reorders columns', () => assert.strictEqual(d.config.fields[0].key, 'calc_1',
    'order after drag from ' + calcIdx + ': ' + d.config.fields.map(f => f.key).join(',')));

  if (SHOTS) await pg.screenshot({ path: path.join(__dirname, 'shot-sv-fields.png'), fullPage: true });

  /* ---- Sort by the calculated column, largest first ---- */
  await step(5);
  await pg.selectOption('#svSortF', 'calc_1');
  await pg.selectOption('#svSortD', 'desc');
  d = await state();
  check('G3 a calculated column can be the sort', () =>
    assert.deepStrictEqual(d.config.sort, [{ field: 'calc_1', dir: 'desc' }]));

  /* ---- Style ---- */
  await step(6);
  await pg.click('[data-st="density:compact"]');
  await pg.click('[data-st="text_size:lg"]');
  await pg.click('[data-st="accent:jade"]');
  await pg.click('#svAddRule');
  await pg.selectOption('[data-rf="0"]', 'calc_1');
  await pg.selectOption('[data-ro="0"]', 'gt');
  await pg.locator('[data-rv="0"]').fill('5000');
  await pg.selectOption('[data-rt="0"]', 'good');
  await pg.locator('[data-hd="title"]').fill('NOI per unit, held portfolio');
  await pg.locator('[data-hd="subtitle"]').fill('Trailing 12 months');
  await pg.locator('[data-hd="period_from"]').fill('2026-01-01');
  await pg.locator('[data-hd="period_to"]').fill('2026-09-30');

  if (SHOTS) await pg.screenshot({ path: path.join(__dirname, 'shot-sv-style.png'), fullPage: true });

  /* ---- Preview ---- */
  await step(7);
  await pg.waitForSelector('#svPreview .sv-tbl tbody tr', { timeout: 45000 }).catch(() => {});
  const prev = await pg.evaluate(() => {
    const w = document.querySelector('#svPreview .sv-styled');
    const ths = [...document.querySelectorAll('#svPreview .sv-tbl thead th')];
    return {
      cls: w ? w.className : '',
      heads: ths.map(t => t.textContent.trim()),
      fxTitle: (ths.find(t => t.querySelector('.sv-fx')) || {}).title || '',
      good: document.querySelectorAll('#svPreview td.sv-tone-good').length,
      millions: [...document.querySelectorAll('#svPreview tbody td')].some(td => /^\(?\$[\d.]+M\)?$/.test(td.textContent.trim())),
      rows: document.querySelectorAll('#svPreview .sv-tbl tbody tr').length,
      firstCalc: [...document.querySelectorAll('#svPreview .sv-tbl tbody tr')].slice(0, 3).map(tr => tr.cells[0].textContent.trim()),
    };
  });
  console.log('top by calc     :', prev.firstCalc.join(' | '));
  check('G3 sorted by the calculated column, largest first', () => {
    const n = prev.firstCalc.map(x => Number(x.replace(/[^\d.-]/g, '')));
    assert.ok(n.every(isFinite) && n[0] >= n[1] && n[1] >= n[2], prev.firstCalc.join('|'));
  });
  if (SHOTS) await pg.screenshot({ path: path.join(__dirname, 'shot-sv-preview.png'), fullPage: true });
  console.log('preview heads   :', prev.heads.join(' | '));
  check('G2 density, text size and accent apply', () => assert.ok(/sv-d-compact/.test(prev.cls) && /sv-t-lg/.test(prev.cls) && /sv-acc-jade/.test(prev.cls), prev.cls));
  check('G2 a renamed header shows', () => assert.ok(prev.heads.some(h => /^Asset/.test(h)), prev.heads.join('|')));
  check('G3 the calculated column is first and shows its formula on hover', () => {
    assert.ok(/^Calculated 1/.test(prev.heads[0]), prev.heads[0]);
    assert.ok(/= t12_noi \/ units/.test(prev.fxTitle), prev.fxTitle);
  });
  check('G2 colour rule tints matching cells', () => assert.ok(prev.good > 0, 'none tinted'));
  check('G2 number format writes NOI in millions', () => assert.ok(prev.millions));

  /* resize the first column by dragging its edge */
  const h0 = await pg.locator('#svPreview .sv-rsz').first().boundingBox();
  const w0 = (await pg.locator('#svPreview thead th').first().boundingBox()).width;
  await pg.mouse.move(h0.x + 3, h0.y + h0.height / 2);
  await pg.mouse.down();
  await pg.mouse.move(h0.x + 93, h0.y + h0.height / 2, { steps: 6 });
  await pg.mouse.up();
  d = await state();
  check('G2 dragging a header edge resizes and stores the width', () => {
    const w = d.config.fields[0].width;
    assert.ok(w && Math.abs(w - (w0 + 90)) <= 12, 'width ' + w + ' from ' + w0);
  });

  /* print header: hidden on screen for a spreadsheet, present on paper */
  await pg.emulateMedia({ media: 'print' });
  const printed = await pg.evaluate(() => {
    const h = document.querySelector('#svPreview .sv-rhead');
    return h ? { shown: getComputedStyle(h).display !== 'none', text: h.textContent, logo: !!h.querySelector('img') } : null;
  });
  await pg.emulateMedia({ media: 'screen' });
  check('G2 the printed header carries title, subtitle, logo, period and run date', () => {
    assert.ok(printed && printed.shown);
    assert.ok(printed.logo, 'no logo');
    assert.ok(/Period 1 Jan 2026 to 30 Sep 2026/.test(printed.text), printed.text);
    assert.ok(/NOI per unit, held portfolio/.test(printed.text) && /Trailing 12 months/.test(printed.text) && /Run \d+ \w{3} \d{4}/.test(printed.text), printed.text);
  });

  /* what the builder would save survives the server's own validation */
  d = await state();
  const v = V.validateConfig(d.dataset_key, d.config);
  check('G2/G3 the draft passes server validation with nothing dropped', () => {
    assert.deepStrictEqual(v.problems, []);
    assert.strictEqual(v.config.calculated.length, 1);
    assert.strictEqual(v.config.style.accent, 'jade');
    assert.strictEqual(v.config.style.rules.length, 1);
    assert.ok(v.config.fields.find(f => f.key === 't12_noi').format === 'millions');
    assert.ok(v.config.fields[0].width > 0);
  });

  /* ---- light theme preset ---- */
  await step(6);
  await pg.click('[data-st="theme:light"]');
  await step(7);
  await pg.waitForSelector('#svPreview .sv-styled', { timeout: 45000 }).catch(() => {});
  const theme = await pg.evaluate(() => {
    const w = document.querySelector('#svPreview .sv-styled');
    return w ? { attr: w.getAttribute('data-theme'), bg: getComputedStyle(w).backgroundColor, page: getComputedStyle(document.body).backgroundColor } : null;
  });
  check('G2 a light preset re-themes the view inside a dark portal', () => {
    assert.strictEqual(theme.attr, 'light');
    assert.notStrictEqual(theme.bg, theme.page);
  });

  /* ---- dashboard tiles: size and accent ---- */
  await step(2);
  await pg.click('[data-dt="dashboard"]');
  await step(6);
  await pg.click('#svAddTile');
  await pg.selectOption('[data-tf="0"]', 't12_noi');
  await pg.locator('[data-tt="0"]').fill('Portfolio NOI');
  await pg.click('[data-st="tsize0:L"]');
  await pg.selectOption('[data-tc="0"]', 'amber');
  await pg.click('#svAddTile');
  await pg.selectOption('[data-tf="1"]', 'calc_1');
  await pg.selectOption('[data-ta="1"]', 'avg');
  await dragBy(pg, '[data-tord="1"] .sv-grip', '[data-tord="0"]');
  await pg.waitForTimeout(200);
  d = await state();
  check('G2 tiles reorder by drag', () => assert.strictEqual(d.config.layout[0].fields[0], 'calc_1'));
  await step(7);
  await pg.waitForSelector('#svPreview .sv-tile', { timeout: 45000 }).catch(() => {});
  const tiles = await pg.evaluate(() => [...document.querySelectorAll('#svPreview .sv-tile')].map(t => ({
    cls: t.className, k: t.querySelector('.k').textContent, v: t.querySelector('.v').textContent, w: t.getBoundingClientRect().width,
  })));
  console.log('tiles           :', JSON.stringify(tiles.map(t => [t.k, t.v, Math.round(t.w)])));
  check('G2 an L tile is wider than an M tile and carries its accent', () => {
    const L = tiles.find(t => /sv-sz-L/.test(t.cls)), M = tiles.find(t => /sv-sz-M/.test(t.cls));
    assert.ok(L && M && L.w > M.w * 1.3, JSON.stringify(tiles));
    assert.ok(/sv-acc-amber/.test(L.cls));
    assert.ok(/^\$/.test(L.v), L.v);
  });

  /* ---- report: a calculated column's subtotal is its formula over the
     totals (total NOI / total units), never a sum of per-row ratios ---- */
  await step(2);
  await pg.click('[data-dt="report"]');
  await step(5);
  await pg.selectOption('#svGroup', 'entity_name');
  await step(7);
  await pg.waitForSelector('#svPreview tfoot tr', { timeout: 45000 }).catch(() => {});
  const tot = await pg.evaluate(() => {
    const rows = window.PortalViews._state.data.rows;
    const s = k => rows.map(r => r[k]).filter(v => v !== null && v !== '' && isFinite(Number(v))).reduce((a, b) => a + Number(b), 0);
    const rowSum = s('calc_1');
    const heads = [...document.querySelectorAll('#svPreview thead th')].map(t => t.textContent.trim());
    const ci = heads.findIndex(h => /^Calculated 1/.test(h));
    const cell = document.querySelector('#svPreview tfoot tr').cells[ci].textContent.trim();
    return { expected: s('t12_noi') / s('units'), rowSum, cell, subs: document.querySelectorAll('#svPreview tr.rp-strong').length };
  });
  console.log('report total    :', tot.cell, 'expected', tot.expected.toFixed(3), 'sum of rows would be', tot.rowSum.toFixed(0));
  check('G3 a calculated subtotal is the formula over the totals', () => {
    assert.ok(tot.subs > 1, 'no subtotal rows');
    assert.ok(Math.abs(Number(tot.cell.replace(/[^\d.-]/g, '')) - tot.expected) < 0.01, tot.cell + ' vs ' + tot.expected);
  });

  /* ---- phone width: the builder does not scroll sideways ---- */
  await pg.setViewportSize({ width: 390, height: 844 });
  await step(3);
  const hscroll = await pg.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  if (SHOTS) await pg.screenshot({ path: path.join(__dirname, 'shot-sv-fields-mobile.png'), fullPage: true });
  check('builder has no horizontal scroll at 390px', () => assert.ok(hscroll <= 1, 'overflow ' + hscroll + 'px'));
  await pg.setViewportSize({ width: 1480, height: 1000 });

  check('only the formula check POSTs; nothing is saved or written', () => {
    const other = writes.filter(w => !/^POST \/api\/views\/formula$/.test(w));
    assert.deepStrictEqual(other, []);
  });
  check('no page errors', () => {
    const real = errs.filter(e => !/favicon|ERR_CONNECTION|static\.showit/.test(e));
    assert.deepStrictEqual(real, []);
  });

  await b.close();
  console.log('\nviews UI: ' + pass + ' passed, ' + fails.length + ' failed');
  fails.forEach(f => console.log('  FAIL  ' + f));
  process.exit(fails.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });

