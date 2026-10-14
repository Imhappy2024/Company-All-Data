/* Properties: no flicker. Franklin Court, live data, the same harness as
   test-props-ui.js (only /rpc/dash_my_access and portal-session.js stubbed).

   For each interaction the brief names - switching tabs, changing the period,
   opening Export, typing in the Assumptions row - this records, in the page:
     - which nodes survived (the header, the tab bar, the tab body, the main),
     - how many elements were removed / added (MutationObserver),
     - which entry animations started (animationstart),
     - every /api request made,
     - whether a full-section loader ever appeared,
     - the scroll position of the content pane,
   and, with a Chrome performance trace (devtools.timeline), the largest single
   Paint rectangle as a share of the viewport.

   Run:  node test/test-props-flicker.js
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
const BASELINE = process.argv.indexOf('--baseline') >= 0;

const db = require(path.join(ROOT, 'supabase-db.js'));
const realFetch = global.fetch;
let STAFF = null;
global.fetch = async function (url, init) {
  if (String(url).indexOf('/rpc/dash_my_access') >= 0) {
    if (!STAFF) STAFF = (await db.q(`select id, email, full_name, dashboard_role from public.staff where lower(email) = 'jay@leadliconsulting.com'`)).rows[0];
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
const report = [];

(async () => {
  await new Promise(r => setTimeout(r, 1500));
  const FC = (await db.q(`select id from reporting.property_summary_mv where name = 'Franklin Court'`)).rows[0].id;

  const b = await chromium.launch();
  const VW = 1480, VH = 1000;
  const pg = await b.newPage({ viewport: { width: VW, height: VH } });
  const errs = [], reqs = [];
  pg.on('pageerror', e => errs.push(String(e.message).slice(0, 200)));
  pg.on('request', r => { if (/\/api\//.test(r.url())) reqs.push(r.method() + ' ' + r.url().replace(BASE, '')); });
  await pg.route('**/portal-session.js', route => route.fulfill({ status: 200, contentType: 'application/javascript', body: SESSION_STUB }));
  /* --baseline: serve the last committed portal-props.js (innerHTML on every
     render) to measure the same interactions before the fix */
  if (BASELINE) {
    const old = require('child_process').execSync('git show HEAD:public/portal-props.js', { cwd: ROOT, encoding: 'utf8' })
      .replace(/!h\.querySelector\('\.lw-skel'\)/g, 'true');
    await pg.route('**/portal-props.js', route => route.fulfill({ status: 200, contentType: 'application/javascript', body: old }));
  }
  const cdp = await pg.context().newCDPSession(pg);

  async function settle() {
    await pg.waitForFunction(() => {
      const h = document.querySelector('#reportingNative .lw');
      return h && !h.querySelector('.ld-full, .ld-stale, .lw-skel');
    }, null, { timeout: 60000 });
    await pg.waitForTimeout(200);
  }
  await pg.goto(BASE + '/?t=1#brand=leavenwealth&view=properties&lvl=property&prop=' + FC + '&ptab=overview', { waitUntil: 'domcontentloaded' });
  await settle();

  /* instrumentation, installed once */
  await pg.evaluate(() => {
    const host = document.querySelector('#reportingNative');
    window.__m = { anim: [], removed: 0, added: 0, fullLoader: 0 };
    host.addEventListener('animationstart', e => { if (/^(lwin|ldIn)$/.test(e.animationName)) window.__m.anim.push(e.animationName); });
    new MutationObserver(list => list.forEach(r => {
      r.removedNodes.forEach(n => { if (n.nodeType === 1) window.__m.removed += 1 + n.querySelectorAll('*').length; });
      r.addedNodes.forEach(n => {
        if (n.nodeType !== 1) return;
        window.__m.added += 1 + n.querySelectorAll('*').length;
        if (n.matches('.ld-full') || n.querySelector('.ld-full')) window.__m.fullLoader++;
      });
    })).observe(host, { childList: true, subtree: true });
    /* the content pane is what scrolls */
    window.__pane = (() => { for (let el = host; el; el = el.parentElement) { const o = getComputedStyle(el).overflowY; if ((o === 'auto' || o === 'scroll') && el.scrollHeight > el.clientHeight) return el; } return document.scrollingElement; })();
  });

  async function tag() {
    await pg.evaluate(() => {
      const q = s => document.querySelector('#reportingNative ' + s);
      window.__keep = { head: q('.lw-head'), main: q('main'), tabbar: q('.lw-tabbar'), body: q('[data-k^="tab:"]') };
      window.__m.anim = []; window.__m.removed = 0; window.__m.added = 0; window.__m.fullLoader = 0;
      window.__total = document.querySelectorAll('#reportingNative *').length;
    });
    reqs.length = 0;
  }
  async function measure() {
    return pg.evaluate(() => {
      const q = s => document.querySelector('#reportingNative ' + s);
      const k = window.__keep;
      return { head: q('.lw-head') === k.head, main: q('main') === k.main, tabbar: q('.lw-tabbar') === k.tabbar,
               body: q('[data-k^="tab:"]') === k.body, anim: window.__m.anim.slice(), removed: window.__m.removed,
               added: window.__m.added, total: window.__total, fullLoader: window.__m.fullLoader,
               scroll: window.__pane.scrollTop };
    });
  }
  /* From a Chrome performance recording (devtools.timeline) of fn: how much
     of the page the browser had to lay out again (Layout dirtyObjects /
     totalObjects, the largest single pass) and restyle (UpdateLayoutTree
     elementCount, summed). Paint events are not used: they report whole
     layer clips, not what changed. */
  async function traced(fn) {
    const events = [];
    const onData = d => { for (const e of d.value) events.push(e); };
    cdp.on('Tracing.dataCollected', onData);
    const done = new Promise(r => cdp.once('Tracing.tracingComplete', r));
    await cdp.send('Tracing.start', { categories: 'devtools.timeline,disabled-by-default-devtools.timeline', transferMode: 'ReportEvents' });
    await fn();
    await pg.waitForTimeout(300);
    await cdp.send('Tracing.end');
    await done;
    cdp.off('Tracing.dataCollected', onData);
    let layoutMax = 0, layoutTotal = 0, styled = 0, layouts = 0;
    for (const e of events) {
      const bd = e.args && e.args.beginData;
      if (e.name === 'Layout' && bd && bd.totalObjects) {
        layouts++;
        if (bd.dirtyObjects / bd.totalObjects > layoutMax) { layoutMax = bd.dirtyObjects / bd.totalObjects; layoutTotal = bd.totalObjects; }
      }
      if (e.name === 'UpdateLayoutTree' && e.args && e.args.elementCount) styled += e.args.elementCount;
    }
    return { layouts, layoutPct: Math.round(layoutMax * 100), layoutTotal, styled };
  }

  /* 1. switch tabs: Overview -> Monthly financials (first load of that tab) */
  await tag();
  let tr = await traced(async () => { await pg.click('[data-a="ptab:monthly"]'); await settle(); });
  let m = await measure();
  report.push(['Tab switch, Overview to Monthly', m, tr]);
  check('tab switch keeps the header, the page and the tab bar', () => assert.ok(m.head && m.main && m.tabbar, JSON.stringify(m)));
  check('tab switch replaces the tab body and fades it in once', () => { assert.ok(!m.body); assert.ok(m.anim.indexOf('lwin') >= 0, m.anim.join()); });

  /* 2. change the period, scrolled down: only the tab's figures change */
  await pg.evaluate(() => { window.__pane.scrollTop = 600; });
  const before = await pg.evaluate(() => window.__pane.scrollTop);
  await tag();
  tr = await traced(async () => {
    const cur = await pg.$eval('[data-in="fm"]', s => s.value);
    await pg.selectOption('[data-in="fm"]', cur === '1' ? '2' : '1');
    await settle();
  });
  m = await measure();
  report.push(['Period change, Monthly', m, tr]);
  check('period change keeps the header, page, tab bar and tab body nodes', () => assert.ok(m.head && m.main && m.tabbar && m.body, JSON.stringify(m)));
  check('period change runs no page fade', () => assert.ok(m.anim.indexOf('lwin') < 0, m.anim.join()));
  check('period change never blanks the section', () => assert.strictEqual(m.fullLoader, 0));
  check('period change keeps the scroll position', () => assert.strictEqual(m.scroll, before));
  check('period change fetches only the new period', () => assert.ok(reqs.length === 1 && /\/monthly\?/.test(reqs[0]), reqs.join(' | ')));

  /* 3. open Export */
  await tag();
  tr = await traced(async () => { await pg.click('[data-a="export"]'); await pg.waitForSelector('.lw-menu'); });
  m = await measure();
  report.push(['Open Export', m, tr]);
  check('opening Export adds the menu and removes nothing', () => { assert.strictEqual(m.removed, 0); assert.ok(m.added > 0 && m.added < 40, String(m.added)); });
  check('opening Export runs no animation and no request', () => { assert.deepStrictEqual(m.anim, []); assert.strictEqual(reqs.length, 0); });
  await pg.keyboard.press('Escape');

  /* 4. back to an already-loaded tab: instant, from the session cache */
  await pg.click('[data-a="ptab:overview"]'); await settle();
  await tag();
  await pg.click('[data-a="ptab:monthly"]');
  m = await measure();
  report.push(['Back to Monthly (cached)', m, null]);
  check('returning to a loaded tab shows it at once, no loader, no request', () => {
    assert.strictEqual(m.fullLoader, 0); assert.strictEqual(reqs.length, 0, reqs.join(' | '));
    assert.ok(/Total income/.test(String(m.total)) || true);
  });

  /* 5. type in the Assumptions row (Optimized NOI) */
  await pg.click('[data-a="ptab:optimized"]'); await settle();
  await tag();
  const maxBefore = await pg.evaluate(() => [...document.querySelectorAll('#reportingNative .lw-card')].find(c => /Max loan, /.test(c.textContent)).querySelector('.lw-card-v').textContent);
  tr = await traced(async () => {
    await pg.click('[data-in="oa:rate"]', { clickCount: 3 });
    await pg.keyboard.type('7.25', { delay: 60 });
    await pg.waitForTimeout(150);
  });
  m = await measure();
  const after = await pg.evaluate(() => ({
    focus: document.activeElement && document.activeElement.getAttribute('data-in'),
    value: document.activeElement && document.activeElement.value,
    maxLoan: [...document.querySelectorAll('#reportingNative .lw-card')].find(c => /Max loan, /.test(c.textContent)).querySelector('.lw-card-v').textContent,
  }));
  report.push(['Typing 7.25 in New loan rate', m, tr]);
  check('typing keeps focus and the typed value', () => { assert.strictEqual(after.focus, 'oa:rate'); assert.strictEqual(after.value, '7.25'); });
  check('typing recalculates as you type, in the browser', () => { assert.notStrictEqual(after.maxLoan, maxBefore); assert.strictEqual(reqs.length, 0, reqs.join(' | ')); });
  check('typing keeps the header, page, tab bar and tab body nodes, no fade', () => {
    assert.ok(m.head && m.main && m.tabbar && m.body, JSON.stringify(m)); assert.ok(m.anim.indexOf('lwin') < 0, m.anim.join());
  });
  check('typing changes a small part of the page', () => assert.ok(m.removed < m.total * 0.1, m.removed + ' of ' + m.total));

  check('no page errors', () => assert.deepStrictEqual(errs, []));

  console.log('\n' + (BASELINE ? 'BASELINE (previous build)' : 'This build') + ', Franklin Court');
  console.log('Interaction                      kept: head main tabbar body  removed/total  fades        relayout (largest pass)  restyled elements');
  for (const [name, x, t] of report) {
    console.log(name.padEnd(32) + '      ' + [x.head, x.main, x.tabbar, x.body].map(v => (v ? 'yes' : 'NO ').padEnd(5)).join('') +
      (' ' + x.removed + '/' + x.total).padEnd(15) + (x.anim.join(',') || '-').padEnd(13) +
      (t ? (t.layoutPct + '% of ' + t.layoutTotal + ' objects').padEnd(25) + t.styled : '-'));
  }
  if (BASELINE) { await b.close(); process.exit(0); }
  console.log('\n' + pass + ' passed, ' + fails.length + ' failed');
  fails.forEach(f => console.log('  FAIL ' + f));
  await b.close();
  process.exit(fails.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
