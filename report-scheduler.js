// ===========================================================================
// report-scheduler.js — sends scheduled Properties reports.
//
// Every five minutes: claim each active schedule whose next_run_at has passed
// by moving next_run_at to its next due date first (one UPDATE ... RETURNING,
// so a slow send or a restart can never send the same occurrence twice),
// then, for each claimed one:
//
//   1. check the OWNER still has dashboard access, Properties, and a Claude
//      connector account; if not, skip and log it (nothing is sent)
//   2. roll the period forward to the latest completed period of its type
//   3. build the report AS THE OWNER's database role, so it holds only the
//      properties the owner can see today
//   4. email it; record last sent / status / error, and the send log
//   5. on failure, email the owner a notice
//
// Due dates are 9:00 AM America/Chicago (reports-core nextRun). Missed
// occurrences (server down) are not replayed: the next run is always the next
// due date after now.
// ===========================================================================
'use strict';

const db = require('./supabase-db');
const R = require('./reports-core');
const { buildReportFile } = require('./reports-export');
const mailer = require('./report-mailer');
const { connectorRole } = require('./portal-identity');

const TICK_MS = 5 * 60 * 1000;
let running = false;

async function ownerProblem(s) {
  const r = await db.privileged(() => db.q(`
    select st.id, st.email, st.full_name, st.is_active and st.dashboard_access as ok,
           st.dashboard_role in ('owner', 'admin') or exists (
             select 1 from public.dashboard_permission p
               join public.dashboard_module m on m.module_key = p.module and m.company_id is not distinct from p.company_id
              where p.staff_id = st.id and m.nav_id = 'properties' and p.level = 'write') as props
      from public.staff st where st.id = $1`, [s.owner_staff_id]));
  const o = r.rows[0];
  if (!o || !o.ok) return { owner: o, reason: 'the schedule owner no longer has dashboard access' };
  /* sending and scheduling need write access, checked again at every send */
  if (!o.props) return { owner: o, reason: 'the schedule owner no longer has write access to Properties' };
  return { owner: o, reason: null };
}

async function runOne(s, now) {
  const when = R.runLabel(now);
  const { owner, reason } = await ownerProblem(s);
  const base = { tenantId: s.tenant_id, scheduleId: s.id, staffId: s.owner_staff_id, to: s.to_emails, cc: s.cc_emails, bcc: s.bcc_emails, format: s.format };
  const record = (status, error) => db.privileged(() => db.q(`
    update public.report_schedule set last_sent_at = $2, last_status = $3, last_error = $4,
           failure_count = case when $3 = 'sent' then 0 else failure_count + 1 end, updated_at = now()
     where id = $1`, [s.id, now, status, error ? String(error).slice(0, 500) : null]));
  const log = row => db.privileged(() => db.q(`insert into public.report_send_log (tenant_id, schedule_id, sent_by_staff_id, report_name, period_label,
      to_emails, cc_emails, bcc_emails, format, property_count, status, error) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [base.tenantId, base.scheduleId, base.staffId, row.name, row.period || null, base.to, base.cc, base.bcc, base.format,
     row.count === undefined ? null : row.count, row.status, row.error ? String(row.error).slice(0, 500) : null]));

  if (reason) {
    await record('skipped', reason);
    await log({ name: s.name, status: 'skipped', error: reason });
    return;
  }
  let doc = null;
  try {
    const role = await connectorRole(s.owner_staff_id);
    const cfg = R.validateConfig(s.config);
    doc = await db.runAs(role, async () => {
      const through = await require('./props-api').data.dataThrough(s.tenant_id);
      return R.buildDoc(s.tenant_id, R.rollForward(cfg, through), { by: owner.full_name || owner.email, name: s.name, now });
    });
    if (!doc.docs.length) throw new Error('none of the report\'s properties are visible to the schedule owner any more');
    const file = await buildReportFile(s.format, doc);
    await mailer.sendReport({ to: s.to_emails, cc: s.cc_emails, bcc: s.bcc_emails, subject: s.subject, body: s.body, file,
      footer: 'Scheduled report from the LeavenWealth dashboard, set up by ' + (owner.full_name || owner.email) + '.' });
    await record('sent', null);
    await log({ name: s.name, period: doc.period, count: doc.docs.length, status: 'sent' });
  } catch (e) {
    const msg = e.message || String(e);
    console.error('[report-scheduler] ' + s.id + ': ' + msg);
    await record('failed', msg).catch(() => {});
    await log({ name: s.name, period: doc && doc.period, count: doc ? doc.docs.length : undefined, status: 'failed', error: msg }).catch(() => {});
    if (owner && owner.email) {
      await mailer.sendFailureNotice({ to: owner.email, scheduleName: s.name, error: msg, when })
        .catch(err => console.error('[report-scheduler] failure notice not sent: ' + err.message));
    }
  }
}

async function tick() {
  if (running) return;
  running = true;
  try {
    const now = new Date();
    const due = (await db.privileged(() => db.q(`
      select *, to_char(start_date, 'YYYY-MM-DD') start_day from public.report_schedule
       where active and deleted_at is null and next_run_at is not null and next_run_at <= now()
       order by next_run_at limit 20`))).rows;
    for (const s of due) {
      /* start_date travels as text (a pg DATE becomes local midnight and shifts a
         day east of UTC); and the next run is strictly after the claimed one even
         if this clock trails the database's, so an occurrence cannot send twice */
      const next = R.nextRun(s.start_day, s.repeat, new Date(Math.max(now.getTime(), new Date(s.next_run_at).getTime())));
      const claimed = await db.privileged(() => db.q(`update public.report_schedule set next_run_at = $2, updated_at = now()
                                                       where id = $1 and active and deleted_at is null and next_run_at <= now()
                                                       returning id`, [s.id, next]));
      if (!claimed.rows.length) continue;
      await runOne(s, now);
    }
  } catch (e) {
    console.error('[report-scheduler] tick failed: ' + e.message);
  } finally { running = false; }
}

function start() {
  if (process.env.REPORT_SCHEDULER === 'off') { console.log('[report-scheduler] off'); return; }
  setTimeout(tick, 30 * 1000);
  setInterval(tick, TICK_MS).unref();
  console.log('[report-scheduler] checking every 5 minutes');
}

module.exports = { start, tick, _internal: { runOne, ownerProblem } };
