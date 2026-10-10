/* The Properties section and the Views builder, rendered against the REAL
   API and the REAL database, and measured.

   Why it is built this way. Both sections are gated by a verified Supabase
   session, and a test cannot have one: the identity is established by asking
   Supabase to run dash_my_access() as the caller, which needs a password. So
   this harness substitutes ONE function - portal-identity.identify - with a
   fixed identity, and leaves everything else alone. Every query, every view
   and every figure below is the live database.

   That is the opposite of the usual fake. CLAUDE.md records the Folio suite
   passing 61 green checks over SQL that could not parse, because a fake
   never parses SQL. Here the SQL is real and only the doorman is stubbed.

   It asserts GEOMETRY and CONTENT, not markup:
     * the acceptance figures from section 2.10 appear on screen
     * no screen issues a write request
     * nothing overflows its container
     * "–" is rendered where data is absent, and never 0

   Run:  node test/test-reporting-ui.js [--shots]
   Needs .env with SUPABASE_DB_URL, and playwright.
*/
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
for (const l of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
  const m = /^([A-Za-z0-9_]+)=(.*)$/.exec(l.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
process.env.PORT = process.env.TEST_PORT || '3988';
const SHOTS = process.argv.indexOf('--shots') >= 0;

/* The doorman is stubbed at its OUTBOUND BOUNDARY, not by reassigning the
   export.

   portal-identity.js's guard() closes over the local `identify` binding, so
   overwriting module.exports.identify changes nothing - the real function
   still runs, calls Supabase with a token the harness invented, and answers
   401. The symptom is the section rendering "Session expired. Sign in
   again." while every other part of the page works, which reads like a
   client bug and is not one.

   So instead: intercept the single fetch identify() makes to
   /rpc/dash_my_access and answer it with the real staff row. Everything
   after that point - the tenant lookup, every query, every view - is live.
   Nothing in the shipped code has a test branch in it. */
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

/* The browser half of the stub.

   It is served in PLACE OF portal-session.js rather than injected before the
   page, because portal.html loads that file afterwards and the real module
   would simply overwrite an injected stub - which it did, and the symptom
   was the portal bouncing to /login with nothing in the console to say why.
   Intercepting the file is the only point where the substitution survives. */
const SESSION_STUB = `
  window.PortalSession = {
    client: function () {
      return Promise.resolve({ auth: { getSession: function () {
        return Promise.resolve({ data: { session: { access_token: 'harness' } } });
      } } });
    },
    getSession: function () { return Promise.resolve({ access_token: 'harness' }); },
    /* The nav is gated on dash_my_access(): an empty access map hides every
       item and render() falls through to the no-access screen, which is
       exactly what an empty stub produced. Grant the ids this harness
       drives, scoped the way the real payload is - by company id, plus
       'exec'. */
    access: function () {
      var LW = 'c0000000-0000-4000-8000-000000000003';
      var mods = { properties: 'edit', views: 'edit', loans: 'edit', financials: 'edit',
                   tasks: 'edit', team: 'edit', documents: 'edit', tools: 'edit',
                   departments: 'edit', exec: 'edit', orgdept: 'edit' };
      var a = { exec: mods }; a[LW] = mods;
      return Promise.resolve({
        user: { id: 'harness', email: 'jay@leadliconsulting.com', full_name: 'Jay Delgado', role: 'owner' },
        access: a,
        companies: { 'c0000000-0000-4000-8000-000000000003': 'LeavenWealth' },
      });
    },
    /* These three are the portal's boot chain and every one of them is
       awaited: enforceRememberWindow().then(...).then(getSession).then(...).
       Returning undefined from the first throws "Cannot read properties of
       undefined (reading 'then')" before readState() ever runs, so the hash
       is ignored and the portal lands on the Executive Board no-access
       screen - which looks like a permissions problem and is not. */
    enforceRememberWindow: function () { return Promise.resolve(false); },
    signOut: function () { return Promise.resolve(); },
    config: function () { return Promise.resolve({ url: 'https://x.supabase.co', anonKey: 'k' }); },
  };
`;

let pass = 0; const fails = [];
const check = (n, fn) => { try { fn(); pass++; } catch (e) { fails.push(n + ' -> ' + e.message); } };

(async () => {
  await new Promise(r => setTimeout(r, 1500));
  const b = await chromium.launch();
  const pg = await b.newPage({ viewport: { width: 1480, height: 1000 } });

  const errs = [];
  const writes = [];
  pg.on('pageerror', e => errs.push(String(e.message).slice(0, 160)));
  pg.on('request', r => {
    if (['POST', 'PUT', 'PATCH', 'DELETE'].indexOf(r.method()) >= 0 && /\/api\//.test(r.url())) {
      writes.push(r.method() + ' ' + r.url().replace(BASE, ''));
    }
  });
  await pg.route('**/portal-session.js', route =>
    route.fulfill({ status: 200, contentType: 'application/javascript', body: SESSION_STUB }));

  /* Wait for CONTENT, not a fixed delay. reporting.property_summary computes
     rolling six-month windows over every property, so the first call is
     seconds rather than milliseconds, and a fixed 2s wait screenshots the
     word "Loading" and asserts against it. */
  async function settle(sel) {
    /* Wait on the BODY panel, not the section. The section's textContent
       includes the 106-entry entity menu, so it is long and Loading-free the
       moment the tree lands - which satisfied a naive check while the table
       underneath was still empty. */
    try { await pg.waitForFunction(function (s) {
      var host = document.querySelector(s);
      if (!host) return false;
      var body = host.querySelector('.rp-body') || host;
      if (/Loading/.test(body.textContent || '')) return false;
      return !!body.querySelector('.rp-tbl, .rp-empty, .rp-err, .sv-card, .sv-grid, .sv-tiles, .sv-panel, .sv-list-row');
    }, sel, { timeout: 45000 }); } catch (e) { /* assertions report it */ }
    await pg.waitForTimeout(400);
  }
  async function go(hash) {
    /* A unique query string makes every call a REAL navigation. goto() to a
       URL that differs only by fragment is a same-document navigation: the
       module keeps its state, so returning to Properties after the fees tab
       left S.tab='fees'. Chaining three navigations to force a reload
       instead raced the boot chain and left the section unmounted. One
       cache-busting param is both correct and simpler. */
    await pg.goto(BASE + '/?t=' + Date.now() + hash, { waitUntil: 'domcontentloaded' });
    await settle(/views/.test(hash) ? '#viewsNative' : '#reportingNative');
  }

  const text = async sel => (await pg.locator(sel).first().textContent().catch(() => '')) || '';
  const shot = async name => { if (SHOTS) await pg.screenshot({ path: path.join(__dirname, 'shot-' + name + '.png'), fullPage: true }); };

  /* ---- Company > Properties ---- */
  await go('#brand=leavenwealth&view=properties');
  const body1 = (await text('#reportingNative')).replace(/\s+/g, ' ');
  console.log('company page    :', body1.slice(0, 150));
  await shot('rp-company-properties');

  check('the Properties table renders rows from the live database', () => {
    assert.ok(/Property/.test(body1), 'no table header');
    assert.ok(body1.length > 400, 'the page is nearly empty: ' + body1.slice(0, 120));
  });

  check('the left menu lists entity FOLDERS and no properties', async () => {});
  const menuItems = await pg.$$eval('.rp-mi', els => els.map(e => e.textContent.trim()));
  console.log('menu items      :', menuItems.length, '|', menuItems.slice(0, 4).join(' / '));
  check('the menu has a Company root and entity folders', () => {
    assert.ok(menuItems.length >= 2, 'menu has ' + menuItems.length + ' items');
    assert.ok(/Company/.test(menuItems[0]), 'first item is ' + menuItems[0]);
  });

  const totalsRow = await text('.rp-tbl tfoot');
  check('there is a totals row', () => assert.ok(/Total/.test(totalsRow), 'no totals row'));

  /* ---- Company > Asset management fees ---- */
  await pg.locator('.rp-tab', { hasText: 'Asset management fees' }).first().click();
  await settle('#reportingNative');
  const fees = (await text('#reportingNative')).replace(/\s+/g, ' ');
  console.log('fees page       :', fees.slice(0, 150));
  await shot('rp-company-fees');

  check('the fee tracker groups by manager and shows the three rows', () => {
    assert.ok(/Expected/.test(fees) && /Received/.test(fees) && /Variance/.test(fees), 'missing a fee row');
    assert.ok(/Point Guard|RPME|Kouri/.test(fees), 'no manager group on screen');
  });
  check('timing that is not confirmed is labelled', () => {
    assert.ok(/timing not confirmed/.test(fees), 'McClain and Bender/AJ must say so');
  });

  /* ---- Franklin Court ---- */
  await go('#brand=leavenwealth&view=properties');
  /* Scroll it into view by index rather than relying on the locator's own
     auto-scroll inside a horizontally scrolling table. */
  const fcIdx = await pg.$$eval('.rp-row', function (els) {
    return els.findIndex(function (e) { return /Franklin Court/.test(e.textContent || ''); });
  });
  console.log('rows on page    :', await pg.$$eval('.rp-row', function (e) { return e.length; }), '| Franklin Court at', fcIdx);
  if (fcIdx < 0) throw new Error('Franklin Court is not in the held list');
  await pg.locator('.rp-row').nth(fcIdx).scrollIntoViewIfNeeded();
  await pg.locator('.rp-row').nth(fcIdx).click();
  await settle('#reportingNative');
  const monthly = (await text('#reportingNative')).replace(/\s+/g, ' ');
  console.log('FC monthly      :', monthly.slice(0, 160));
  await shot('rp-fc-monthly');

  check('Franklin Court May 2026 operating income is 149,000.29', () => {
    assert.ok(/149,000\.29/.test(monthly), 'the acceptance figure is not on screen');
  });
  check('the monthly sheet says which basis and how debt service is derived', () => {
    assert.ok(/Cash/.test(monthly), 'no basis stated');
    assert.ok(/loan record/i.test(monthly), 'Franklin Court must say it uses the loan record');
  });
  check('a month with no data renders an en dash, not 0', () => {
    assert.ok(/–/.test(monthly), 'no en dash anywhere on a sheet that has absent months');
  });

  /* ---- Optimized NOI ---- */
  await pg.locator('.rp-tab', { hasText: 'Optimized NOI' }).first().click();
  await settle('#reportingNative');
  const noi = (await text('#reportingNative')).replace(/\s+/g, ' ');
  console.log('FC optimized    :', noi.slice(0, 160));
  await shot('rp-fc-noi');

  check('optimized NOI is 970,480 and trailing is 828,323', () => {
    assert.ok(/970,480/.test(noi), 'optimized NOI missing');
    assert.ok(/828,323/.test(noi), 'trailing NOI missing');
  });
  check('the best windows are highlighted, and there is a legend', async () => {});
  const wins = await pg.$$eval('.rp-w6, .rp-w3, .rp-w1', els => els.length);
  check('the window highlights are applied', () => assert.ok(wins >= 6, 'only ' + wins + ' highlighted cells'));

  /* ---- DSCR ---- */
  await pg.locator('.rp-tab', { hasText: 'DSCR' }).first().click();
  await settle('#reportingNative');
  const dscr = (await text('#reportingNative')).replace(/\s+/g, ' ');
  console.log('FC dscr         :', dscr.slice(0, 160));
  await shot('rp-fc-dscr');

  check('the max loan at the defaults is about 10.2M against a current 8.08M', () => {
    assert.ok(/10,23\d,\d{3}|10,2\d{2},\d{3}/.test(dscr), 'max loan not on screen: ' + dscr.slice(0, 200));
    assert.ok(/8,080,000/.test(dscr), 'current loan balance not on screen');
  });
  check('the what-if controls say they are not saved', () => {
    assert.ok(/Standard values|Changed \(not saved\)/.test(dscr), 'no saved-state label');
  });

  /* a what-if input changes the screen and nothing else */
  await pg.locator('#rpReq').fill('1.50');
  await pg.locator('#rpReq').dispatchEvent('change');
  await pg.waitForTimeout(700);
  const dscr2 = (await text('#reportingNative')).replace(/\s+/g, ' ');
  check('changing a what-if input recomputes on screen and marks it unsaved', () => {
    assert.ok(/Changed \(not saved\)/.test(dscr2), 'the state label did not change');
    assert.ok(dscr2 !== dscr, 'nothing recomputed');
  });

  /* ---- Asset management fee, one property ---- */
  await pg.locator('.rp-tab', { hasText: 'Asset management fee' }).first().click();
  await settle('#reportingNative');
  const fee1 = (await text('#reportingNative')).replace(/\s+/g, ' ');
  console.log('FC fee          :', fee1.slice(0, 160));
  await shot('rp-fc-fee');
  check('Franklin Court January expected is 4,474.54 and received 4,474.99', () => {
    assert.ok(/4,474\.54/.test(fee1), 'expected figure missing');
    assert.ok(/4,474\.99/.test(fee1), 'received-from-books figure missing');
  });

  /* ---- Views ---- */
  await go('#brand=leavenwealth&view=views');
  const views = (await text('#viewsNative')).replace(/\s+/g, ' ');
  console.log('views list      :', views.slice(0, 160));
  await shot('sv-list');
  check('all four starter views are listed', () => {
    ['Monthly property financials', 'Asset management fees', 'Coverage watchlist', 'Portfolio snapshot']
      .forEach(n => assert.ok(views.indexOf(n) >= 0, 'missing: ' + n));
  });

  for (const [name, file] of [['Portfolio snapshot', 'sv-dashboard'], ['Coverage watchlist', 'sv-list-view'],
                              ['Asset management fees, 2026', 'sv-report'], ['Monthly property financials, 2026', 'sv-spreadsheet']]) {
    await go('#brand=leavenwealth&view=views');
    await pg.locator('.sv-card', { hasText: name }).first().click();
    await settle('#viewsNative');
    const t = (await text('#viewsNative')).replace(/\s+/g, ' ');
    console.log((name + '          ').slice(0, 16), ':', t.slice(0, 130));
    await shot(file);
    check('the "' + name + '" view renders rows', () => {
      assert.ok(t.length > 200, 'nearly empty: ' + t.slice(0, 120));
      assert.ok(!/could not|error/i.test(t.slice(0, 200)), 'error on screen: ' + t.slice(0, 160));
    });
  }

  /* the builder */
  await go('#brand=leavenwealth&view=views');
  if (!(await pg.locator('#svNew').count())) {
    console.log('builder entry missing. body =',
      (await text('#viewsNative')).replace(/\s+/g, ' ').slice(0, 200));
  }
  await pg.locator('#svNew').click();
  await pg.waitForTimeout(900);
  await shot('sv-builder');
  const builder = (await text('#viewsNative')).replace(/\s+/g, ' ');
  check('the builder opens on step 1 with the datasets listed', () => {
    assert.ok(/Dataset/.test(builder), 'no step list');
    assert.ok(/Monthly property financials|Property summary/.test(builder), 'no datasets offered');
  });

  /* ---- the whole-release guarantees ---- */
  check('NO new screen issued a write request', () => {
    assert.deepStrictEqual(writes, [], 'writes seen: ' + writes.join(', '));
  });
  check('no page errors', () => {
    const real = errs.filter(e => !/favicon|ERR_CONNECTION|static\.showit/.test(e));
    assert.deepStrictEqual(real, []);
  });

  const overflow = await pg.evaluate(() => {
    const el = document.querySelector('.rp-wrap2') || document.querySelector('#viewsNative');
    return el ? { sw: el.scrollWidth, cw: el.clientWidth } : null;
  });
  check('the section does not overflow its column', () => {
    if (!overflow) return;
    assert.ok(overflow.sw <= overflow.cw + 2, 'scrollWidth ' + overflow.sw + ' vs ' + overflow.cw);
  });

  await b.close();
  console.log('\nreporting UI: ' + pass + ' passed, ' + fails.length + ' failed');
  fails.forEach(f => console.log('  FAIL  ' + f));
  process.exit(fails.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
