/* Properties > Reports in a browser, live data. The identity is stubbed (as
   test-access-ui.js does); every figure, period and property comes from the
   live database through /api/reports.

   - Send is answered in the browser (no email leaves), its body kept.
   - Saved reports and schedules go to the real server, and every row this
     test creates is removed at the end (checked).
   - The email workflow itself is not called: REPORT_EMAIL_SECRET is unset here.

   Run:  node test/test-reports-ui.js [--shots]
*/
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const ROOT = path.join(__dirname, '..');
for (const l of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
  const m = /^([A-Za-z0-9_]+)=(.*)$/.exec(l.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
process.env.PORT = process.env.TEST_PORT || '3996';
process.env.REPORT_SCHEDULER = 'off';
delete process.env.REPORT_EMAIL_SECRET;
const SHOTS = process.argv.indexOf('--shots') >= 0;
const db = require(path.join(ROOT, 'supabase-db.js'));
const R = require(path.join(ROOT, 'reports-core.js'));
const realFetch = global.fetch;
let JAY = null;
global.fetch = async function (url, init) {
  if (String(url).indexOf('/rpc/dash_my_access') >= 0) {
    if (!JAY) JAY = (await db.q(`select id, email, full_name, dashboard_role from public.staff where lower(email) = 'jay@leadliconsulting.com'`)).rows[0];
    return new Response(JSON.stringify({ user: { id: JAY.id, email: JAY.email, full_name: JAY.full_name, role: JAY.dashboard_role }, companies: {},
      access: { 'c0000000-0000-4000-8000-000000000003': { properties: 'write' } } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  return realFetch(url, init);
};
const { chromium } = require('playwright');
require(path.join(ROOT, 'server.js'));
const BASE = 'http://127.0.0.1:' + process.env.PORT;
const STUB = fs.readFileSync(path.join(__dirname, 'test-props-flicker.js'), 'utf8').match(/const SESSION_STUB = `([\s\S]*?)`;/)[1];

let pass = 0; const fails = [];
const check = (n, fn) => { try { fn(); pass++; } catch (e) { fails.push(n + ' -> ' + e.message.slice(0, 300)); } };
const SHOT = n => path.join(ROOT, 'docs', 'screenshots', 'reports', n + '.png');

(async () => {
  await new Promise(r => setTimeout(r, 1500));
  /* pure rules first: rolling forward and 9:00 AM Chicago */
  check('quarterly rolls to the latest COMPLETED quarter', () => {
    assert.strictEqual(R.rollForward(R.validateConfig({ reports: { income: true }, incType: 'quarter', quarter: '2025Q1' }), '2026-09').quarter, '2026Q3');
    assert.strictEqual(R.rollForward(R.validateConfig({ reports: { income: true }, incType: 'quarter', quarter: '2025Q1' }), '2026-08').quarter, '2026Q2');
  });
  check('bi-annual and annual roll the same way', () => {
    assert.strictEqual(R.rollForward(R.validateConfig({ reports: { income: true }, incType: 'half', half: '2025H1' }), '2026-09').half, '2026H1');
    assert.strictEqual(R.rollForward(R.validateConfig({ reports: { income: true }, incType: 'annual', annual: '2024' }), '2026-09').annual, '2025');
    assert.strictEqual(R.rollForward(R.validateConfig({ reports: { income: true }, incType: 'annual', annual: '2024' }), '2026-12').annual, '2026');
  });
  check('a regular range keeps its length and ends at the latest month', () => {
    const c = R.rollForward(R.validateConfig({ reports: { income: true }, incType: 'regular', from: '2026-01', to: '2026-03' }), '2026-09');
    assert.deepStrictEqual([c.from, c.to], ['2026-07', '2026-09']);
  });
  check('sends at 9:00 AM Chicago in daylight time and in standard time', () => {
    assert.strictEqual(R.chicagoNine('2026-11-01').toISOString(), '2026-11-01T15:00:00.000Z');
    assert.strictEqual(R.chicagoNine('2026-07-01').toISOString(), '2026-07-01T14:00:00.000Z');
  });
  check('monthly on the 31st falls back to the last day of a short month', () => assert.strictEqual(R.occurrence('2026-01-31', 'monthly', 1), '2026-02-28'));

  const FC = (await db.q(`select id from reporting.property_summary_mv where name = 'Franklin Court'`)).rows[0].id;
  const b = await chromium.launch();
  const pg = await b.newPage({ viewport: { width: 1440, height: 950 } });
  const errs = [], sent = [];
  pg.on('pageerror', e => errs.push(String(e.message).slice(0, 200)));
  await pg.route('**/portal-session.js', r => r.fulfill({ status: 200, contentType: 'application/javascript',
    body: fs.readFileSync(path.join(ROOT, 'public', 'portal-session.js'), 'utf8') + '\n' + STUB +
      '\nwindow.PortalSession.authHeaders = function (x) { return Promise.resolve(Object.assign({ Accept: "application/json", Authorization: "Bearer harness" }, x || {})); };' }));
  await pg.route('**/api/reports/send', async r => {
    sent.push(JSON.parse(r.request().postData() || '{}'));
    return r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true,"sent":true}' });
  });

  await pg.goto(BASE + '/?t=1#brand=leavenwealth&view=properties&lvl=portfolio&l1=reports', { waitUntil: 'domcontentloaded' });
  await pg.waitForSelector('[data-a="rptab:build"]', { timeout: 90000 });
  await pg.waitForSelector('[data-a="rprep:income"]', { timeout: 60000 });
  const tabs = await pg.evaluate(() => [...document.querySelectorAll('.lw-tabs')[0].querySelectorAll('button')].map(x => x.textContent.trim()));
  check('Portfolio tabs are Entities | Custom view | Reports', () => assert.deepStrictEqual(tabs, ['Entities', 'Custom view', 'Reports']));
  const build = await pg.evaluate(() => ({
    inc: [...document.querySelectorAll('[data-a^="rpinc:"]')].map(x => x.textContent.trim()),
    quarter: (document.querySelector('[data-in="rpper:quarter"]') || {}).value,
    props: document.querySelectorAll('[data-a^="rpprop:"]').length,
    disabled: document.querySelector('[data-a="rppreview"]').disabled,
  }));
  check('period types: Regular, Quarterly, Bi-annual, Annual', () => assert.deepStrictEqual(build.inc, ['Regular', 'Quarterly', 'Bi-annual', 'Annual']));
  check('quarter defaults to the latest one with data', () => assert.strictEqual(build.quarter, '2026Q3'));
  check('the property picker lists the held properties', () => assert.ok(build.props >= 40, String(build.props)));
  check('Preview is disabled until a property is chosen', () => assert.strictEqual(build.disabled, true));

  await pg.fill('[data-in="rpq"]', 'frank');
  const filtered = await pg.evaluate(() => [...document.querySelectorAll('[data-a^="rpprop:"]')].map(x => x.parentElement.textContent));
  check('search narrows the list', () => assert.ok(filtered.length >= 1 && filtered.every(t => /frank/i.test(t)), JSON.stringify(filtered)));
  await pg.click('[data-a="rpprop:' + FC + '"]');
  await pg.click('[data-a="rprep:rr"]');
  await pg.click('[data-a="rprep:opt"]');
  await pg.click('[data-a="rpstmt:cf"]');
  if (SHOTS) await pg.screenshot({ path: SHOT('build') });
  await pg.click('[data-a="rppreview"]');
  await pg.waitForSelector('.lw-rp-paper', { timeout: 90000 });
  const doc = await pg.evaluate(() => {
    const paper = document.querySelector('.lw-rp-paper');
    const rows = [...paper.querySelectorAll('tr')].map(r => [...r.cells].map(c => c.textContent.trim()));
    return { text: paper.innerText, rows };
  });
  check('preview: the document header names the report', () => assert.ok(/Income report \+ Rent roll \+ Optimized NOI - Franklin Court - Q3 2026/.test(doc.text), doc.text.slice(0, 200)));
  check('preview: income statement months are Jul to Sep 2026', () => assert.ok(doc.rows.some(r => r.join('|') === '|Jul 26|Aug 26|Sep 26|Total'), JSON.stringify(doc.rows.slice(0, 3))));
  const noi = doc.rows.find(r => r[0] === 'Net operating income');
  check('preview: Franklin Court NOI 84,177.43 / 78,217.93 / 92,865.54', () => assert.deepStrictEqual(noi.slice(1, 4), ['84,177.43', '78,217.93', '92,865.54']));
  check('preview: the cash flow statement is included', () => assert.ok(doc.rows.some(r => r[0] === 'Net cash flow')));
  check('preview: rent roll cards (172 units)', () => assert.ok(/Units\s*172/.test(doc.text), doc.text.slice(0, 600)));
  check('preview: optimized NOI rows', () => assert.ok(doc.rows.some(r => r[0] === 'Optimized NOI, best 6 months x 2')));
  if (SHOTS) await pg.screenshot({ path: SHOT('preview'), fullPage: false });

  /* a regular range reaching before the data: those months are left out, with a note */
  const early = await pg.evaluate(async fc => {
    const r = await fetch('/api/reports/preview', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer harness' },
      body: JSON.stringify({ config: { reports: { income: true }, incType: 'regular', from: '2026-08', to: '2026-12', stmt: { is: true }, props: [fc] } }) });
    return r.json();
  }, FC);
  const sec = early.doc.docs[0].sections[0];
  check('months with no data are left out, and the sub-line says so', () => {
    assert.deepStrictEqual(sec.table.heads, ['Aug 26', 'Sep 26']);
    assert.ok(/3 of 5 months have no data yet/.test(sec.sub), sec.sub);
  });

  /* export: each format downloads */
  for (const fmt of ['pdf', 'xlsx', 'csv']) {
    await pg.click('[data-a="rpexport"]');
    const [dl] = await Promise.all([pg.waitForEvent('download', { timeout: 60000 }), pg.click('[data-a="rpx:' + fmt + '"]')]);
    const name = dl.suggestedFilename();
    const p2 = await dl.path();
    const size = fs.statSync(p2).size;
    check('export ' + fmt + ' downloads a file', () => assert.ok(size > 1000 && name.indexOf('Franklin Court') >= 0, name + ' ' + size));
  }

  /* send */
  await pg.click('[data-a="rpdlg:send"]');
  await pg.waitForSelector('.lw-rp-dlg');
  const dlg = await pg.evaluate(() => [...document.querySelectorAll('.lw-rp-dlg label')].map(l => l.firstChild.textContent.trim()));
  check('Send asks for To, Cc, Bcc, Subject, Message and format', () => assert.deepStrictEqual(dlg.slice(0, 6), ['To', 'Cc (optional)', 'Bcc (optional)', 'Subject', 'Message', 'Attach as']));
  const dis = await pg.evaluate(() => document.querySelector('[data-a="rpsubmit"]').disabled);
  check('Send stays disabled until To has an address', () => assert.strictEqual(dis, true));
  await pg.fill('[data-in="rpf:to"]', 'someone@example.com');
  await pg.fill('[data-in="rpf:cc"]', 'other@example.com');
  await pg.selectOption('[data-in="rpf:fmt"]', 'xlsx');
  if (SHOTS) await pg.screenshot({ path: SHOT('send') });
  await pg.click('[data-a="rpsubmit"]');
  await pg.waitForSelector('.lw-rp-msg');
  check('Send posts the definition, recipients and format', () => {
    const s = sent[0];
    assert.strictEqual(s.to, 'someone@example.com'); assert.strictEqual(s.cc, 'other@example.com'); assert.strictEqual(s.format, 'xlsx');
    assert.deepStrictEqual(s.config.props, [FC]); assert.strictEqual(s.config.quarter, '2026Q3');
  });

  /* save, then schedule, against the real server */
  await pg.click('[data-a="rpdlg:save"]');
  await pg.fill('[data-in="rpf:name"]', 'zz test report (delete me)');
  await pg.click('[data-a="rpsubmit"]');
  await pg.waitForFunction(() => /Saved "zz test report/.test((document.querySelector('.lw-rp-msg') || {}).textContent || ''), null, { timeout: 30000 });
  await pg.click('[data-a="rpdlg:schedule"]');
  await pg.fill('[data-in="rpf:name"]', 'zz test schedule (delete me)');
  await pg.fill('[data-in="rpf:to"]', 'someone@example.com');
  await pg.click('[data-a="rprepeat:weekly"]');
  const note = await pg.evaluate(() => document.querySelector('.lw-rp-dlg').innerText);
  check('Schedule says it sends at 9:00 AM Central and rolls the period', () => assert.ok(/9:00 AM \(Central time\)/.test(note) && /latest completed quarter/.test(note), note));
  if (SHOTS) await pg.screenshot({ path: SHOT('schedule') });
  await pg.click('[data-a="rpsubmit"]');
  await pg.waitForFunction(() => /Scheduled "zz test schedule/.test((document.querySelector('.lw-rp-msg') || {}).textContent || ''), null, { timeout: 30000 });

  await pg.click('[data-a="rptab:saved"]');
  await pg.waitForFunction(() => [...document.querySelectorAll('tr')].some(r => /zz test report/.test(r.textContent)), null, { timeout: 30000 });
  const savedRow = await pg.evaluate(() => [...document.querySelectorAll('tr')].find(r => /zz test report/.test(r.textContent)).innerText);
  check('Saved reports lists it with what it includes and its period', () => assert.ok(/Income report, Rent roll, Optimized NOI/.test(savedRow) && /Q3 2026/.test(savedRow), savedRow));
  if (SHOTS) await pg.screenshot({ path: SHOT('saved') });
  await pg.click('[data-a="rptab:scheduled"]');
  await pg.waitForFunction(() => [...document.querySelectorAll('tr')].some(r => /zz test schedule/.test(r.textContent)), null, { timeout: 30000 });
  const schedRow = await pg.evaluate(() => [...document.querySelectorAll('tr')].find(r => /zz test schedule/.test(r.textContent)).innerText);
  check('Scheduled lists it: weekly, next send at 9:00 AM CT, active', () => assert.ok(/Weekly/.test(schedRow) && /9:00\s?AM CT/.test(schedRow) && /Active/.test(schedRow), schedRow));
  if (SHOTS) await pg.screenshot({ path: SHOT('scheduled') });
  const sid = await pg.evaluate(() => [...document.querySelectorAll('[data-a^="rppause:"]')].map(x => x.getAttribute('data-a')).find(Boolean));
  await pg.click('[data-a="' + sid + '"]');
  await pg.waitForFunction(() => { const r = [...document.querySelectorAll('tr')].find(x => /zz test schedule/.test(x.textContent)); return r && /Paused/.test(r.innerText); }, null, { timeout: 30000 });
  const row = (await db.q(`select active, next_run_at from public.report_schedule where name = 'zz test schedule (delete me)' and deleted_at is null`)).rows[0];
  check('paused in the database: inactive, no next run', () => assert.ok(row && row.active === false && row.next_run_at === null, JSON.stringify(row)));
  check('no page errors', () => assert.deepStrictEqual(errs, []));

  /* clean up, and prove it */
  await db.q(`delete from public.report_schedule where name = 'zz test schedule (delete me)'`);
  await db.q(`delete from public.report_definition where name = 'zz test report (delete me)'`);
  const left = (await db.q(`select (select count(*) from public.report_schedule where name like 'zz test%') + (select count(*) from public.report_definition where name like 'zz test%') n`)).rows[0].n;
  check('nothing left behind', () => assert.strictEqual(Number(left), 0));

  console.log('reports ui: ' + pass + ' passed, ' + fails.length + ' failed');
  fails.forEach(f => console.log('  FAIL ' + f));
  await b.close();
  process.exit(fails.length ? 1 : 0);
})().catch(async e => {
  console.error(e);
  /* a failed run still removes what it created */
  await db.q(`delete from public.report_schedule where name like 'zz test%'`).catch(() => {});
  await db.q(`delete from public.report_definition where name like 'zz test%'`).catch(() => {});
  process.exit(1);
});
