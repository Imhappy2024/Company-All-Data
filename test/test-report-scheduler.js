/* The report scheduler against the live database, email stubbed.

   A schedule made due now is claimed and sent ONCE: next_run_at moves to the
   next due date at 9:00 AM Chicago, last status / send log are recorded, a
   second tick sends nothing, and a failed send is recorded and notifies the
   owner. Every row it creates is removed at the end (checked).

   Run:  node test/test-report-scheduler.js
*/
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const ROOT = path.join(__dirname, '..');
for (const l of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
  const m = /^([A-Za-z0-9_]+)=(.*)$/.exec(l.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
const db = require(path.join(ROOT, 'supabase-db.js'));
const mailer = require(path.join(ROOT, 'report-mailer.js'));
const sent = [], notices = [];
let failNext = false;
mailer.sendReport = async m => { if (failNext) { failNext = false; throw new Error('stubbed failure'); } sent.push(m); };
mailer.sendFailureNotice = async m => { notices.push(m); };
const S = require(path.join(ROOT, 'report-scheduler.js'));

let pass = 0; const fails = [];
const check = (n, fn) => { try { fn(); pass++; } catch (e) { fails.push(n + ' -> ' + e.message.slice(0, 300)); } };
const NAME = 'zz scheduler test (delete me)';
const cleanup = () => db.q(`delete from public.report_schedule where name = $1`, [NAME]).then(() => db.q(`delete from public.report_send_log where report_name = $1`, [NAME]));

(async () => {
  const T = '72381c81-af95-4e1d-ad0d-20a3a3421119';
  const owner = (await db.q(`select id, email from public.staff where lower(email) = 'jay@leadliconsulting.com'`)).rows[0];
  const fc = (await db.q(`select id from public.rpt_property_summary where tenant_id = $1 and name = 'Franklin Court'`, [T])).rows[0].id;
  const cfg = { reports: { income: true, rr: false, opt: false }, incType: 'quarter', quarter: '2025Q1', stmt: { is: true, cf: false }, props: [fc] };
  const ins = await db.q(`insert into public.report_schedule (tenant_id, owner_staff_id, name, config, to_emails, subject, format, start_date, repeat, next_run_at)
    values ($1, $2, $3, $4::jsonb, '{someone@example.com}', 'Test', 'pdf', '2026-01-01', 'monthly', now() - interval '1 minute') returning id`,
    [T, owner.id, NAME, JSON.stringify(cfg)]);
  const id = ins.rows[0].id;

  await S.tick();
  const r1 = (await db.q(`select last_status, last_error, next_run_at, failure_count from public.report_schedule where id = $1`, [id])).rows[0];
  check('a due schedule is sent once', () => assert.strictEqual(sent.length, 1, JSON.stringify(r1)));
  check('it is recorded as sent', () => assert.strictEqual(r1.last_status, 'sent', r1.last_error));
  check('next run moves to the 1st of next month, 9:00 AM Chicago', () => {
    const n = new Date(r1.next_run_at);
    const p = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', day: 'numeric', hour: 'numeric', minute: '2-digit', hourCycle: 'h23' }).format(n);
    assert.ok(/^1, 09:00$/.test(p) && n > new Date(), p + ' ' + n.toISOString());
  });
  const per = (await db.q(`select period_label from public.report_send_log where schedule_id = $1`, [id])).rows[0];
  check('the quarter rolled forward from Q1 2025 to the latest completed one', () => assert.strictEqual(per && per.period_label, 'Q3 2026 (Jul to Sep)'));
  check('it went to the schedule\'s recipients as a PDF', () => { assert.deepStrictEqual(sent[0].to, ['someone@example.com']); assert.ok(/\.pdf$/.test(sent[0].file.filename)); });

  await S.tick();
  check('a second tick sends nothing', () => assert.strictEqual(sent.length, 1));

  await db.q(`update public.report_schedule set next_run_at = now() - interval '1 minute' where id = $1`, [id]);
  failNext = true;
  await S.tick();
  const r2 = (await db.q(`select last_status, last_error, failure_count from public.report_schedule where id = $1`, [id])).rows[0];
  check('a failed send is recorded with its reason', () => { assert.strictEqual(r2.last_status, 'failed'); assert.ok(/stubbed failure/.test(r2.last_error)); assert.strictEqual(r2.failure_count, 1); });
  check('and the owner is told', () => assert.ok(notices.length === 1 && notices[0].to === owner.email, JSON.stringify(notices)));
  const logs = (await db.q(`select status from public.report_send_log where schedule_id = $1 order by created_at`, [id])).rows.map(x => x.status);
  check('the send log has one sent and one failed', () => assert.deepStrictEqual(logs, ['sent', 'failed']));

  await cleanup();
  const left = (await db.q(`select count(*) n from public.report_schedule where name = $1`, [NAME])).rows[0].n;
  check('nothing left behind', () => assert.strictEqual(Number(left), 0));
  console.log('report scheduler: ' + pass + ' passed, ' + fails.length + ' failed');
  fails.forEach(f => console.log('  FAIL ' + f));
  process.exit(fails.length ? 1 : 0);
})().catch(async e => { console.error(e); await cleanup().catch(() => {}); process.exit(1); });
