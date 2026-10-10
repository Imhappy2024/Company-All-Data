/* The Properties section, rendered against the REAL API and the REAL
   database, and measured against docs/PROPERTIES_SPEC.md.

   Why it is built this way. The section is gated by a verified Supabase
   session and a test cannot have one: the identity is established by asking
   Supabase to run dash_my_access() as the caller, which needs a password. So
   this harness intercepts exactly ONE outbound call - the fetch to
   /rpc/dash_my_access - and leaves everything else alone. Every query, view
   and figure below is the live database.

   That is the opposite of the usual fake. CLAUDE.md records the Folio suite
   passing 61 green checks over SQL that could not parse, because a fake never
   parses SQL. Here the SQL is real and only the doorman is stubbed.

   Run:  node test/test-reporting-ui.js [--shots]
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

  /* Wait for CONTENT. The skeleton renders a real <table class="rp-tbl">, so
     a check for that class alone settles on the PLACEHOLDER and anything
     looked up afterwards is detached when the real table replaces it. */
  async function settle(sel) {
    sel = sel || '#reportingNative';
    try {
      await pg.waitForFunction(function (s) {
        var host = document.querySelector(s);
        if (!host) return false;
        if (host.querySelector('.rp-skel')) return false;
        var body = host.querySelector('.rp-body') || host;
        if (/Loading/.test(body.textContent || '')) return false;
        return !!body.querySelector('.rp-tbl, .rp-empty, .rp-err, .rp-flags, .rp-ok-box, .sv-card, .sv-grid, .rp-cols');
      }, sel, { timeout: 45000 });
    } catch (e) { /* assertions report it */ }
    await pg.waitForTimeout(350);
  }

  /* A unique query string makes every call a REAL navigation: goto() to a URL
     differing only by fragment is a same-document navigation and the module
     keeps its state. */
  async function go(hash) {
    await pg.goto(BASE + '/?t=' + Date.now() + hash, { waitUntil: 'domcontentloaded' });
    await settle(/view=views/.test(hash) ? '#viewsNative' : '#reportingNative');
  }
  const text = async sel => (await pg.locator(sel).first().textContent().catch(() => '')) || '';
  const SHOT_CSS = '.rp-scroll{max-height:none}';
  const shot = async name => {
    if (!SHOTS) return;
    await pg.addStyleTag({ content: SHOT_CSS }).catch(() => {});
    await pg.evaluate(() => window.scrollTo(0, 0));
    await pg.waitForTimeout(120);
    await pg.screenshot({ path: path.join(__dirname, 'shot-' + name + '.png'), fullPage: true });
  };
  const tab = async label => {
    await pg.locator('.rp-tab', { hasText: new RegExp('^' + label + '$') }).first().click();
    await settle();
  };

  const PROPS = '#brand=leavenwealth&view=properties';

  /* ===================================================================
     A1  Portfolio landing
     =================================================================== */
  await go(PROPS);
  const portfolio = (await text('#reportingNative')).replace(/\s+/g, ' ');
  console.log('portfolio       :', portfolio.slice(0, 110));
  await shot('rp-portfolio-entities');

  const tabNames = await pg.$$eval('.rp-tabs .rp-tab', e => e.map(x => x.textContent.trim()));
  check('A1 the portfolio has four tabs in order', () => {
    assert.deepStrictEqual(tabNames,
      ['Entities', 'Properties', 'Asset management fees', 'Views'], 'got ' + JSON.stringify(tabNames));
  });

  const sidebars = await pg.$$eval('.rp-side, .rp-mi', e => e.length);
  check('A no sidebar and no Company label', () => {
    assert.strictEqual(sidebars, 0, sidebars + ' sidebar elements remain');
    assert.ok(!/^Company/.test(portfolio.trim()), 'the Company label is still there');
  });

  const entRows = await pg.$$eval('.rp-row', e => e.length);
  console.log('managing ents   :', entRows);
  check('A1 Entities lists managing entities, not every legal entity', () => {
    assert.ok(entRows >= 10 && entRows <= 30, entRows + ' rows - expected about 17 managing entities');
  });
  check('A1 the Entities table has a totals row', () => {
    assert.ok(/Total/.test(portfolio), 'no totals row');
  });

  /* ===================================================================
     A2  drill down to an entity, A6 stale responses
     =================================================================== */
  const firstEnt = (await pg.locator('.rp-row .rp-link').first().textContent()).trim();
  await pg.locator('.rp-row .rp-link').first().click();
  await settle();
  const entPage = (await text('#reportingNative')).replace(/\s+/g, ' ');
  console.log('entity          :', firstEnt, '->', entPage.slice(0, 90));
  await shot('rp-entity');

  check('A2 the breadcrumb shows Portfolio / Entity', () => {
    assert.ok(/Portfolio/.test(entPage), 'no Portfolio crumb');
  });
  const entTabs = await pg.$$eval('.rp-tabs .rp-tab', e => e.map(x => x.textContent.trim()));
  check('A2 an entity has exactly Properties and Asset management fees', () => {
    assert.deepStrictEqual(entTabs, ['Properties', 'Asset management fees'], 'got ' + JSON.stringify(entTabs));
  });

  /* A6: open one entity, and while its request may still be in flight, open
     another. The screen must show the one asked for LAST. */
  await go(PROPS);
  const links = pg.locator('.rp-row .rp-link');
  const nameA = (await links.nth(0).textContent()).trim();
  const nameB = (await links.nth(1).textContent()).trim();
  await links.nth(0).click();
  await pg.waitForTimeout(40);          /* deliberately mid-flight */
  await pg.goBack();
  await pg.waitForTimeout(60);
  await pg.locator('.rp-row .rp-link').nth(1).click().catch(() => {});
  await settle();
  await tab('Asset management fees');
  const crumbNow = (await text('.rp-crumb')).replace(/\s+/g, ' ');
  console.log('A6 switched     :', nameA, '->', nameB, '| crumb:', crumbNow);
  check('A6 a slower earlier response cannot repaint the newer selection', () => {
    assert.ok(crumbNow.indexOf(nameB) >= 0, 'crumb shows "' + crumbNow + '", expected ' + nameB);
    if (nameA !== nameB) assert.ok(crumbNow.indexOf(nameA) < 0, 'the previous entity is still on screen');
  });

  /* ===================================================================
     A3  the property page
     =================================================================== */
  await go(PROPS);
  await tab('Properties');
  const propRows = await pg.$$eval('.rp-row', e => e.length);
  console.log('held properties :', propRows);
  check('C1 the Properties tab lists held properties', () => assert.ok(propRows > 40, propRows + ' rows'));

  const hdr = (await text('.rp-tbl thead')).replace(/\s+/g, ' ');
  check('C1 the columns are the spec list', () => {
    ['Property', 'Units', 'Occupancy', 'Total income', 'Total expenses',
     'NOI, trailing 12 mo', 'Optimized NOI', 'Expense ratio', 'Net income',
     'DSCR, mortgage', 'PM company', 'In Dropbox'].forEach(c =>
      assert.ok(hdr.indexOf(c) >= 0, 'missing column: ' + c + ' in ' + hdr));
  });
  check('B3 the label T12 never appears in a column header', () => {
    assert.ok(!/\bT12\b/.test(hdr), 'header still says T12: ' + hdr);
  });

  const fcIdx = await pg.$$eval('.rp-row', els =>
    els.findIndex(e => /Franklin Court/.test(e.textContent || '')));
  check('Franklin Court is listed', () => assert.ok(fcIdx >= 0));
  await pg.locator('.rp-row').nth(fcIdx).scrollIntoViewIfNeeded();
  await pg.locator('.rp-row .rp-link').nth(fcIdx).click();
  await settle();

  const ptabs = await pg.$$eval('.rp-tabs .rp-tab', e => e.map(x => x.textContent.trim()));
  check('A3 the property tabs are in the spec order', () => {
    assert.deepStrictEqual(ptabs, ['Overview', 'Monthly financials', 'Income & expenses',
      'Optimized NOI', 'DSCR', 'Asset management fee', 'Rent roll', 'Buildings & units',
      'Capex', 'Valuation', 'Documents'], 'got ' + JSON.stringify(ptabs));
  });

  const keys = await pg.$$eval('.rp-key .k', e => e.map(x => x.textContent.trim()));
  const keySubs = await pg.$$eval('.rp-key .s', e => e.map(x => x.textContent.trim()));
  console.log('key figures     :', keys.join(' | '));
  check('A3 the key-figure row carries a source line under each figure', () => {
    assert.ok(keys.length >= 8, 'only ' + keys.length + ' key figures');
    assert.ok(keySubs.filter(s => s && s !== ' ').length >= 4, 'almost no source lines');
  });
  const overview = (await text('#reportingNative')).replace(/\s+/g, ' ');
  await shot('rp-property-overview');
  check('D1 Overview shows flags or says nothing needs attention', () => {
    assert.ok(/Nothing needs attention|Needs attention/.test(overview), 'no flags block');
  });

  /* ---- D2 Monthly financials ---- */
  await tab('Monthly financials');
  const monthly = (await text('#reportingNative')).replace(/\s+/g, ' ');
  await shot('rp-property-monthly');
  check('2.10 Franklin Court May 2026 operating income is 149,000.29', () => {
    assert.ok(/149,000\.29/.test(monthly), 'the acceptance figure is not on screen');
  });
  check('D2 the sheet names its source, basis and how cash flow is derived', () => {
    assert.ok(/Cash/.test(monthly), 'no basis');
    assert.ok(/loan record/i.test(monthly), 'Franklin Court must say it uses the loan record');
    assert.ok(/Cash flow is NOI less/.test(monthly), 'cash flow is not explained');
  });
  const periodCtl = await pg.$$eval('.rp-period select', e => e.length);
  check('A4 the period filter sits on the tab bar', () => {
    assert.strictEqual(periodCtl, 3, 'expected Year + From + To, got ' + periodCtl);
  });
  check('D2 unavailable rows are hidden behind a toggle', () => {
    assert.ok(/Show unavailable rows/.test(monthly), 'no toggle offered');
  });

  /* ---- D4 / D5 ---- */
  await tab('Optimized NOI');
  const noi = (await text('#reportingNative')).replace(/\s+/g, ' ');
  await shot('rp-property-noi');
  check('2.10 optimized 970,480 against trailing 828,323', () => {
    assert.ok(/970,480/.test(noi), 'optimized missing');
    assert.ok(/828,323/.test(noi), 'trailing missing');
  });
  check('D4 the cap-rate value is labelled an estimate', () => {
    assert.ok(/estimate/i.test(noi), 'nothing labelled estimate');
  });

  await tab('DSCR');
  const dscr = (await text('#reportingNative')).replace(/\s+/g, ' ');
  await shot('rp-property-dscr');
  check('2.10 max loan about 10.2M against the current 8,080,000', () => {
    assert.ok(/10,2\d{2},\d{3}/.test(dscr), 'max loan missing');
    assert.ok(/8,080,000/.test(dscr), 'current balance missing');
  });
  check('D5 coverage is labelled by measure', () => {
    assert.ok(/DSCR, mortgage/.test(dscr), 'mortgage measure missing');
  });

  /* ---- D6 ---- */
  await tab('Asset management fee');
  const fee1 = (await text('#reportingNative')).replace(/\s+/g, ' ');
  check('2.10 Franklin Court Jan expected 4,474.54, received 4,474.99', () => {
    assert.ok(/4,474\.54/.test(fee1) && /4,474\.99/.test(fee1), 'fee figures missing');
  });

  /* ---- D7 / D11 ---- */
  await tab('Rent roll');
  const rent = (await text('#reportingNative')).replace(/\s+/g, ' ');
  check('D7 the rent roll shows a summary and a unit list', () => {
    assert.ok(/occupied|vacant|No rent roll/i.test(rent), 'no rent roll content');
  });
  await tab('Documents');
  const docs = (await text('#reportingNative')).replace(/\s+/g, ' ');
  await shot('rp-property-docs');
  check('D11 Documents lists linked files', () => {
    assert.ok(/\.xlsx|\.pdf|\.csv|No documents/i.test(docs), 'no documents content: ' + docs.slice(0, 120));
  });

  /* ===================================================================
     A5  links, URL state and Back
     =================================================================== */
  const urlNow = pg.url();
  check('A5 level, property and tab are in the URL', () => {
    assert.ok(/lvl=property/.test(urlNow), 'no level: ' + urlNow);
    assert.ok(/prop=/.test(urlNow), 'no property id');
    assert.ok(/ptab=docs/.test(urlNow), 'no tab');
  });
  await pg.goBack();
  await settle();
  const afterBack = pg.url();
  console.log('back            :', afterBack.slice(afterBack.indexOf('#')));
  check('A5 browser Back steps back through the drill-down', () => {
    assert.ok(afterBack !== urlNow, 'the URL did not change');
    assert.ok(!/ptab=docs/.test(afterBack), 'Back did not leave the Documents tab');
  });

  /* A5, cold. Every test above reached a property by CLICKING, which sets
     state before the URL is written - so none of them could see that a
     bookmarked link was being rewritten to the portfolio landing before the
     module read it. Load the URL directly and the property must open. */
  const coldUrl = urlNow.slice(urlNow.indexOf('#'));
  await go(coldUrl.replace('ptab=docs', 'ptab=overview'));
  const coldHead = (await text('.rp-phead')).replace(/\s+/g, ' ');
  const coldTiles = await pg.$$eval('.rp-key', e => e.length);
  console.log('cold deep link  :', coldHead.slice(0, 60), '|', coldTiles, 'key figures');
  check('A5 a bookmarked property URL opens that property when loaded cold', () => {
    assert.ok(/Franklin Court/.test(coldHead), 'opened: "' + coldHead.slice(0, 80) + '"');
    assert.strictEqual(coldTiles, 9, 'key figures: ' + coldTiles);
  });

  await go(PROPS);
  await tab('Properties');
  const linkStyle = await pg.$eval('.rp-row .rp-link', el => ({
    cursor: getComputedStyle(el.closest('tr')).cursor,
    href: !!el.getAttribute('href'),
  }));
  check('A5 property names look clickable', () => {
    assert.strictEqual(linkStyle.cursor, 'pointer');
    assert.ok(linkStyle.href, 'no href, so it cannot be opened in a new tab');
  });

  /* ===================================================================
     B5  frozen panes and density
     =================================================================== */
  const frozen = await pg.$eval('.rp-frozen thead th', el => getComputedStyle(el).position);
  const frozenCol = await pg.$eval('.rp-frozen tbody td:first-child', el => getComputedStyle(el).position);
  check('B5 the header row and first column are frozen', () => {
    assert.strictEqual(frozen, 'sticky', 'header is ' + frozen);
    assert.strictEqual(frozenCol, 'sticky', 'first column is ' + frozenCol);
  });
  const padBefore = await pg.$eval('.rp-tbl tbody td', el => getComputedStyle(el).paddingTop);
  await pg.locator('[data-density="compact"]').first().click();
  await pg.waitForTimeout(250);
  const padAfter = await pg.$eval('.rp-tbl tbody td', el => getComputedStyle(el).paddingTop);
  check('B5 the density switch actually changes density', () => {
    assert.notStrictEqual(padBefore, padAfter, 'padding stayed ' + padBefore);
  });

  /* ===================================================================
     E1  units, B6 tags
     =================================================================== */
  await go(PROPS);
  await tab('Properties');
  const unitRows = await pg.$$eval('.rp-row', els => els.map(e => {
    const td = e.querySelectorAll('td');
    return { name: (td[0] || {}).textContent || '', units: ((td[1] || {}).textContent || '').trim() };
  }));
  ['Modern Heights', '500 S Dakota', 'Adventureland', 'Aksarben', 'BG Flats'].forEach(n => {
    const row = unitRows.filter(r => r.name.indexOf(n) >= 0)[0];
    check('E1 units are populated for ' + n, () => {
      assert.ok(row, n + ' is not listed');
      assert.ok(!/^–/.test(row.units), n + ' shows a dash: "' + row.units + '"');
    });
  });
  const tags = await pg.$$eval('.rp-tag', e => e.map(x => x.textContent.trim()));
  check('B6 interest-only coverage is tagged', () => {
    assert.ok(tags.indexOf('interest only') >= 0, 'tags seen: ' + tags.slice(0, 6).join(','));
  });

  /* ===================================================================
     F  the fee tracker
     =================================================================== */
  await go(PROPS);
  await tab('Asset management fees');
  const fees = (await text('#reportingNative')).replace(/\s+/g, ' ');
  await shot('rp-fees');
  check('F1 the tracker groups by manager with its timing', () => {
    assert.ok(/Expected/.test(fees) && /Received/.test(fees) && /Variance/.test(fees), 'missing a fee row');
    assert.ok(/timing not confirmed/.test(fees), 'McClain and Bender/AJ must say so');
  });
  check('F4 a sub-dollar variance reads 0.00 and never (0.00)', () => {
    assert.ok(!/\(0\.0[01]\)/.test(fees), 'a (0.00) or (0.01) is on screen');
  });
  const totalCol = await pg.$eval('.rp-fees .rp-total-col', el => getComputedStyle(el).position).catch(() => null);
  check('F1 the Total column is frozen', () => assert.strictEqual(totalCol, 'sticky'));
  const groupsBefore = await pg.$$eval('.rp-feehead', e => e.length);
  await pg.locator('.rp-collapse').first().click();
  await pg.waitForTimeout(250);
  const groupsAfter = await pg.$$eval('.rp-feehead', e => e.length);
  check('F1 fee groups collapse', () => {
    assert.ok(groupsAfter < groupsBefore, 'still ' + groupsAfter + ' of ' + groupsBefore);
  });

  /* ===================================================================
     G1  Views reachable from the Views tab
     =================================================================== */
  await go(PROPS);
  await tab('Views');
  await pg.waitForTimeout(2500);
  const views = (await text('#reportingNative')).replace(/\s+/g, ' ');
  await shot('rp-views');
  check('G1 saved views are reachable from the Views tab', () => {
    assert.ok(/Portfolio snapshot|Coverage watchlist|New view/.test(views),
      'the views module did not mount: ' + views.slice(0, 140));
  });

  /* ===================================================================
     whole-release guarantees
     =================================================================== */
  check('B1 NO new screen issued a write request', () => {
    assert.deepStrictEqual(writes, [], 'writes seen: ' + writes.join(', '));
  });
  check('no page errors', () => {
    const real = errs.filter(e => !/favicon|ERR_CONNECTION|static\.showit/.test(e));
    assert.deepStrictEqual(real, []);
  });

  await b.close();
  console.log('\nproperties UI: ' + pass + ' passed, ' + fails.length + ' failed');
  fails.forEach(f => console.log('  FAIL  ' + f));
  process.exit(fails.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
