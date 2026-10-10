/* Section H in the browser: the add buttons, the guided + Property form,
   + Building, the setup checklist, and the rent roll As-of selector.

   Every POST is intercepted IN THE BROWSER and answered by the test, so no
   record reaches the shared database; test-portfolio-setup.js covers the
   server half against the real database with every write rolled back. The
   checklist and the rent roll are read live.

   Run:  node test/test-setup-ui.js [--shots]
*/
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
for (const l of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
  const m = /^([A-Za-z0-9_]+)=(.*)$/.exec(l.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
process.env.PORT = process.env.TEST_PORT || '3990';
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
      user: { id: STAFF.id, email: STAFF.email, full_name: STAFF.full_name, role: global.__ROLE || STAFF.dashboard_role },
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

(async () => {
  await new Promise(r => setTimeout(r, 1500));
  const COPPER = (await db.q(`select id, dba_name from public.property where dba_name ilike 'Copperleaf%' limit 1`)).rows[0];
  const b = await chromium.launch();
  const pg = await b.newPage({ viewport: { width: 1480, height: 1000 } });
  const errs = [], posts = [];
  pg.on('pageerror', e => errs.push(String(e.message).slice(0, 160)));
  await pg.route('**/portal-session.js', route =>
    route.fulfill({ status: 200, contentType: 'application/javascript', body: SESSION_STUB }));

  /* the first + Property save is refused on a field, the second succeeds and
     names a REAL property so the landing page is the live Copperleaf */
  let propertyPosts = 0;
  await pg.route('**/api/portfolio-setup/**', async route => {
    const req = route.request();
    if (req.method() !== 'POST') return route.continue();
    const body = JSON.parse(req.postData() || '{}');
    posts.push({ url: req.url().replace(BASE, ''), body });
    if (/\/property$/.test(req.url())) {
      propertyPosts++;
      if (propertyPosts === 1) {
        return route.fulfill({ status: 409, contentType: 'application/json',
          body: JSON.stringify({ error: 'That name is already matched to Sierra Gardens.', field: 'source_label' }) });
      }
      return route.fulfill({ status: 201, contentType: 'application/json',
        body: JSON.stringify({ ok: true, property: { id: COPPER.id, name: 'Test Court', owner: { id: 'x', name: 'Test Court LLC' } } }) });
    }
    if (/\/building$/.test(req.url())) {
      return route.fulfill({ status: 201, contentType: 'application/json',
        body: JSON.stringify({ ok: true, building: { id: 'x', unit_identifier: 'Building 99' } }) });
    }
    return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ ok: true, entity: { id: 'x', name: 'Test LLC' } }) });
  });

  const go = async hash => {
    await pg.goto(BASE + '/?t=' + Date.now() + hash, { waitUntil: 'domcontentloaded' });
    await pg.waitForFunction(() => {
      const h = document.querySelector('#reportingNative');
      return h && !h.querySelector('.rp-skel') && h.querySelector('.rp-tbl, .rp-empty, .rp-flags, .rp-ok-box');
    }, null, { timeout: 45000 }).catch(() => {});
    await pg.waitForTimeout(600);
  };
  const PROPS = '#brand=leavenwealth&view=properties';

  /* ---- a plain user is offered nothing ---- */
  global.__ROLE = 'user';
  await go(PROPS + '&lvl=portfolio&ptab=properties');
  await pg.waitForTimeout(800);
  const userButtons = await pg.locator('#rpAddEntity, #rpAddProperty').count();
  check('H a plain user sees no add buttons', () => assert.strictEqual(userButtons, 0));

  /* ---- an owner ---- */
  global.__ROLE = 'owner';
  await go(PROPS + '&lvl=portfolio&ptab=properties');
  await pg.waitForSelector('#rpAddProperty', { timeout: 15000 }).catch(() => {});
  const ownerButtons = await pg.locator('#rpAddEntity, #rpAddProperty').count();
  check('H1 an owner sees + Entity and + Property', () => assert.strictEqual(ownerButtons, 2));

  await pg.click('#rpAddProperty');
  await pg.waitForSelector('#rpSetupRoot .rp-dialog', { timeout: 10000 }).catch(() => {});
  const dlg = await pg.evaluate(() => {
    const d = document.querySelector('#rpSetupRoot .rp-dialog');
    return d ? { role: d.getAttribute('role'), modal: d.getAttribute('aria-modal'),
      sections: [...d.querySelectorAll('.rp-fsec h4')].map(h => h.textContent.trim()),
      focused: document.activeElement && document.activeElement.getAttribute('data-v') } : null;
  });
  console.log('form sections   :', dlg && dlg.sections.join(' | '));
  check('H1 + Property opens a modal dialog with focus in the first field', () => {
    assert.strictEqual(dlg.role, 'dialog'); assert.strictEqual(dlg.modal, 'true');
    assert.strictEqual(dlg.focused, 'name');
  });
  check('H2 the guided form covers property, owner, report source, Dropbox, fee and loan', () =>
    assert.deepStrictEqual(dlg.sections.map(s => s.replace(/^\d/, '')),
      ['The property', 'Owner LLC', 'Report source', 'Dropbox', 'Asset management fee', 'Loan']));

  await pg.fill('[data-v="name"]', 'Test Court');
  await pg.fill('[data-v="units"]', '24');
  await pg.check('input[data-v="owner_mode"][value="new"]');
  await pg.waitForSelector('[data-v="new_owner.name"]');
  const keptName = await pg.inputValue('[data-v="name"]');
  check('typed values survive a change to the form\'s shape', () => assert.strictEqual(keptName, 'Test Court'));
  await pg.fill('[data-v="new_owner.name"]', 'Test Court LLC');
  await pg.selectOption('[data-v="source_system"]', 'buildium');
  await pg.fill('[data-v="source_label"]', 'Sierra Gardens');
  await pg.fill('[data-v="dropbox_url"]', 'https://www.dropbox.com/scl/fo/abc/def?dl=0');
  await pg.check('[data-v="fee.enabled"]');
  await pg.waitForSelector('[data-v="fee.manager_group"]');
  await pg.fill('[data-v="fee.manager_group"]', 'Point Guard NE');
  await pg.fill('[data-v="fee.fee_pct"]', '3');
  await pg.check('[data-v="loan.enabled"]');
  await pg.waitForSelector('[data-v="loan.lender"]');
  await pg.fill('[data-v="loan.lender"]', 'Test Bank');
  await pg.fill('[data-v="loan.origination_amount"]', '1500000');
  await pg.fill('[data-v="loan.interest_rate_pct"]', '6.5');
  if (SHOTS) await pg.screenshot({ path: path.join(__dirname, 'shot-setup-form.png'), fullPage: false });

  await pg.click('#rpSetupSave');
  await pg.waitForSelector('[data-v="source_label"][aria-invalid="true"]', { timeout: 10000 }).catch(() => {});
  const refused = await pg.evaluate(() => {
    const el = document.querySelector('[data-v="source_label"]');
    return { invalid: el && el.getAttribute('aria-invalid'), msg: (el && el.parentNode.querySelector('.rp-ferr') || {}).textContent,
      focused: document.activeElement === el, open: !!document.querySelector('#rpSetupRoot .rp-dialog') };
  });
  check('a refusal stays in the form, marks the field, says why and focuses it', () => {
    assert.ok(refused.open);
    assert.strictEqual(refused.invalid, 'true');
    assert.ok(/Sierra Gardens/.test(refused.msg), refused.msg);
    assert.ok(refused.focused);
  });
  check('H2 the payload nests fee and loan and sends the new owner, not a picker value', () => {
    const p = posts[0].body;
    assert.strictEqual(p.name, 'Test Court');
    assert.deepStrictEqual(p.new_owner, { name: 'Test Court LLC' });
    assert.ok(!('owner_entity_id' in p) && !('owner_mode' in p));
    assert.strictEqual(p.fee.enabled, true); assert.strictEqual(p.fee.fee_pct, '3'); assert.strictEqual(p.fee.fee_type, 'pct_gross');
    assert.strictEqual(p.loan.lender, 'Test Bank'); assert.strictEqual(p.loan.interest_rate_pct, '6.5');
    assert.strictEqual(p.source_system, 'buildium');
  });

  await pg.fill('[data-v="source_label"]', 'Test Court (Buildium)');
  await pg.click('#rpSetupSave');
  await pg.waitForSelector('.rp-setup, .rp-setup-ok', { timeout: 45000 }).catch(() => {});
  await pg.waitForTimeout(500);
  const landed = await pg.evaluate(() => ({
    dialog: !!document.querySelector('#rpSetupRoot .rp-dialog'),
    notice: (document.querySelector('.rp-notice') || {}).textContent || '',
    level: window.PortalReporting._state.level, ptab: window.PortalReporting._state.ptab,
    items: [...document.querySelectorAll('.rp-setup li')].map(li => li.className + ':' + li.querySelector('b').textContent),
    ok: (document.querySelector('.rp-setup-ok') || {}).textContent || '',
    crumb: (document.querySelector('.rp-crumb') || {}).textContent || '',
    hash: location.hash,
  }));
  console.log('landed          :', JSON.stringify(landed.items));
  if (SHOTS) await pg.screenshot({ path: path.join(__dirname, 'shot-setup-checklist.png'), fullPage: false });
  check('after saving, the dialog closes and the property opens on Overview', () => {
    assert.strictEqual(landed.dialog, false);
    assert.strictEqual(landed.level, 'property'); assert.strictEqual(landed.ptab, 'overview');
    assert.ok(landed.hash.indexOf(COPPER.id) >= 0, landed.hash);
    assert.ok(/Test Court added\. New owner LLC: Test Court LLC\./.test(landed.notice), landed.notice);
  });
  check('H3 a fully set-up property says so in one line naming all four items', () => {
    assert.deepStrictEqual(landed.items, []);
    assert.strictEqual(landed.ok, 'Set up: sync name matched, Dropbox folder set, fee set, loan on file.');
  });
  check('the breadcrumb names the property\'s own managing entity, not "No managing entity"', () => {
    assert.ok(/Park Ave Capital LLC/.test(landed.crumb), landed.crumb);
  });

  /* ---- a property that is NOT fully set up lists all four, gaps marked ---- */
  const gap = (await db.q(`select p.id from reporting.property_summary_mv p
     where p.ownership_status = 'held'
       and not exists (select 1 from public.am_fee_schedule_property l where l.property_id = p.id)
     order by p.name limit 1`)).rows[0];
  await go(PROPS + '&lvl=property&prop=' + gap.id + '&ptab=overview');
  await pg.waitForSelector('.rp-setup, .rp-setup-ok', { timeout: 45000 }).catch(() => {});
  const partial = await pg.evaluate(() => [...document.querySelectorAll('.rp-setup li')].map(li => ({
    cls: li.className, label: li.querySelector('b').textContent, sr: li.querySelector('.sr-only').textContent })));
  console.log('partial setup   :', JSON.stringify(partial.map(p => p.cls + ':' + p.label)));
  check('H3 a property missing its fee lists all four items with the fee marked not done', () => {
    assert.deepStrictEqual(partial.map(p => p.label), ['Sync name matched', 'Dropbox folder set', 'Fee set', 'Loan on file']);
    const fee = partial.find(p => p.label === 'Fee set');
    assert.strictEqual(fee.cls, 'todo');
    assert.strictEqual(fee.sr, ', not done', 'state must not be colour alone');
  });
  if (SHOTS) await pg.screenshot({ path: path.join(__dirname, 'shot-setup-partial.png'), fullPage: false });
  await go(PROPS + '&lvl=property&prop=' + COPPER.id + '&ptab=overview');

  /* ---- + Building on the Buildings tab ---- */
  await pg.locator('.rp-tab', { hasText: /^Buildings & units$/ }).click();
  await pg.waitForSelector('#rpAddBuilding', { timeout: 30000 }).catch(() => {});
  await pg.click('#rpAddBuilding');
  await pg.waitForSelector('#rpSetupRoot .rp-dialog');
  const bsub = await pg.locator('#rpSetupRoot header .rp-dim').textContent();
  check('H1 + Building names the property it is adding to', () => assert.strictEqual(bsub, COPPER.dba_name));
  await pg.keyboard.press('Escape');
  const closed = await pg.locator('#rpSetupRoot .rp-dialog').count();
  const back = await pg.evaluate(() => document.activeElement && document.activeElement.id);
  check('Escape closes the dialog and returns focus to the button', () => {
    assert.strictEqual(closed, 0); assert.strictEqual(back, 'rpAddBuilding');
  });
  await pg.click('#rpAddBuilding');
  await pg.fill('[data-v="name"]', 'Building 99');
  await pg.fill('[data-v="units"]', '0');
  await pg.selectOption('[data-v="building_type"]', 'garage');
  await pg.click('#rpSetupSave');
  await pg.waitForSelector('.rp-notice', { timeout: 30000 }).catch(() => {});
  const bpost = posts.filter(p => /\/building$/.test(p.url))[0];
  check('H1 + Building posts name, apartments and kind to that property', () => {
    assert.ok(bpost && bpost.url.indexOf(COPPER.id) >= 0);
    assert.deepStrictEqual({ name: bpost.body.name, units: bpost.body.units, building_type: bpost.body.building_type },
      { name: 'Building 99', units: '0', building_type: 'garage' });
  });

  /* ---- A4: rent roll as-of ---- */
  await pg.locator('.rp-tab', { hasText: /^Rent roll$/ }).click();
  await pg.waitForSelector('#rpAsOf', { timeout: 45000 }).catch(() => {});
  const asof = await pg.evaluate(() => {
    const s = document.querySelector('#rpAsOf');
    return s ? { opts: [...s.options].map(o => o.value), cur: s.value, rows: document.querySelectorAll('.rp-body .rp-tbl tbody tr').length } : null;
  });
  console.log('rent roll dates :', asof && asof.opts.join(', '), 'rows', asof && asof.rows);
  check('A4 the rent roll offers every date on file, newest first', () => {
    assert.ok(asof && asof.opts.length >= 2, JSON.stringify(asof));
    assert.strictEqual(asof.cur, asof.opts[0]);
  });
  await pg.selectOption('#rpAsOf', asof.opts[1]);
  await pg.waitForFunction(v => { const s = document.querySelector('#rpAsOf'); return s && s.value === v && !document.querySelector('.rp-skel'); }, asof.opts[1], { timeout: 45000 }).catch(() => {});
  const older = await pg.evaluate(() => ({ note: document.querySelector('.rp-body .rp-note').textContent, rows: document.querySelectorAll('.rp-body .rp-tbl tbody tr').length }));
  console.log('older rent roll :', older.note.slice(0, 60), 'rows', older.rows);
  check('A4 picking an earlier date shows that rent roll', () => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(asof.opts[1]);
    const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    assert.ok(older.note.indexOf(Number(m[3]) + ' ' + MON[Number(m[2]) - 1] + ' ' + m[1]) >= 0, older.note);
    assert.ok(older.rows > 0);
  });

  /* ---- phone: the dialog is a full-width sheet with no sideways scroll ---- */
  await pg.setViewportSize({ width: 390, height: 844 });
  await go(PROPS + '&lvl=portfolio&ptab=properties');
  await pg.waitForSelector('#rpAddProperty', { timeout: 15000 }).catch(() => {});
  await pg.click('#rpAddProperty');
  await pg.waitForSelector('#rpSetupRoot .rp-dialog');
  await pg.check('[data-v="fee.enabled"]');
  const phone = await pg.evaluate(() => {
    const d = document.querySelector('#rpSetupRoot .rp-dialog').getBoundingClientRect();
    const f = document.querySelector('#rpSetupRoot .rp-form');
    return { w: Math.round(d.width), left: Math.round(d.left), hs: f.scrollWidth - f.clientWidth };
  });
  if (SHOTS) await pg.screenshot({ path: path.join(__dirname, 'shot-setup-mobile.png') });
  check('the form fits a 390px phone with no sideways scroll', () => {
    assert.ok(phone.left >= 0 && phone.w <= 390, JSON.stringify(phone));
    assert.ok(phone.hs <= 1, 'form scrolls sideways by ' + phone.hs);
  });

  check('no page errors', () => {
    const real = errs.filter(e => !/favicon|ERR_CONNECTION|static\.showit/.test(e));
    assert.deepStrictEqual(real, []);
  });
  await b.close();
  console.log('\nsetup UI: ' + pass + ' passed, ' + fails.length + ' failed');
  fails.forEach(f => console.log('  FAIL  ' + f));
  process.exit(fails.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
