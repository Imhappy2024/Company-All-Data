// ===========================================================================
// reports-api.js — Properties > Reports, at /api/reports.
//
//   GET    /options                  periods on offer + the property list
//   POST   /preview  {config}        the document, built now
//   POST   /export   {config, format, name?}   the document as a file
//   POST   /send     {config, to, cc, bcc, subject, body, format, name?}
//   GET    /saved | POST /saved | DELETE /saved/:id
//   GET    /schedules | POST /schedules | PATCH /schedules/:id {active} | DELETE /schedules/:id
//
// Every route needs the Properties screen. Report DATA is read as the
// caller's own connector role (guard), so it can only contain properties
// they can see. The definitions (report_definition, report_schedule,
// report_send_log) are server-only tables: read and written here on the
// privileged connection, always filtered by the verified tenant and staff id.
//
// Saved reports and schedules are listed to everyone with Properties access;
// only the creator or an admin may delete, pause or resume one. Saving,
// sending and scheduling need write access to Properties; read-only levels
// can still build, preview and export.
// ===========================================================================
'use strict';

const express = require('express');
const db = require('./supabase-db');
const { guard, isAdmin } = require('./portal-identity');
const R = require('./reports-core');
const { buildReportFile } = require('./reports-export');
const mailer = require('./report-mailer');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^@\s,;]+@[^@\s,;]+\.[^@\s,;]+$/;
const FORMATS = ['pdf', 'xlsx', 'csv'];
const REPEATS = ['daily', 'weekly', 'monthly', 'yearly'];

const priv = fn => db.privileged(fn);
const P = require('./props-api').data;

function canWrite(who) {
  if (isAdmin(who)) return true;
  const a = who.access || {};
  return Object.keys(a).some(s => a[s] && a[s].properties === 'write');
}
function needWrite(who, res) {
  if (canWrite(who)) return true;
  res.status(403).json({ error: 'Your access to Properties is read-only, so you can preview and export reports but not save, send or schedule them.' });
  return false;
}
function emails(v, max, label) {
  const raw = Array.isArray(v) ? v : String(v || '').split(/[,;\s]+/);
  const out = [...new Set(raw.map(x => String(x || '').trim().toLowerCase()).filter(Boolean))];
  const bad = out.filter(x => !EMAIL.test(x));
  if (bad.length) throw Object.assign(new Error(label + ': "' + bad[0] + '" is not an email address.'), { status: 400 });
  if (out.length > max) throw Object.assign(new Error(label + ' takes at most ' + max + ' addresses.'), { status: 400 });
  return out;
}
const fail = (res, e) => res.status(e.status || 500).json({ error: e.message || 'Server error.' });

async function options(req, res, who) {
  const through = await P.dataThrough(who.tenantId);
  const e = (await P.q(`select to_char(min(month), 'YYYY-MM') m from public.rpt_property_month where tenant_id = $1 and has_data`, [who.tenantId]))[0];
  const props = (await P.q(P.LIST_SQL + ' order by s.name', [who.tenantId])).map(P.shapeProp)
    .map(p => ({ id: p.id, name: p.name, mgr: p.mgr, pm: p.pm, src: p.src }));
  res.json({ ok: true, periods: R.periodOptions(through, e && e.m), properties: props, canWrite: canWrite(who), maxProps: R.MAX_PROPS });
}

function configOf(body) {
  const cfg = R.validateConfig(body && body.config);
  const problem = R.problemOf(cfg);
  if (problem) throw Object.assign(new Error(problem), { status: 400 });
  return cfg;
}

async function preview(req, res, who) {
  try {
    const cfg = configOf(req.body);
    res.json({ ok: true, config: cfg, doc: await R.buildDoc(who.tenantId, cfg, { by: who.fullName || who.email }) });
  } catch (e) { if (e.status) return fail(res, e); throw e; }
}

async function exportFile(req, res, who) {
  try {
    const cfg = configOf(req.body);
    const fmt = FORMATS.indexOf(req.body.format) >= 0 ? req.body.format : 'pdf';
    const name = String(req.body.name || '').trim().slice(0, 160) || undefined;
    const doc = await R.buildDoc(who.tenantId, cfg, { by: who.fullName || who.email, name });
    const out = await buildReportFile(fmt, doc);
    res.set('Content-Type', out.type);
    res.set('Content-Disposition', 'attachment; filename="' + out.filename.replace(/["\\\r\n]/g, '') + '"; filename*=UTF-8\'\'' + encodeURIComponent(out.filename));
    res.send(out.buffer);
  } catch (e) { if (e.status) return fail(res, e); throw e; }
}

async function logSend(row) {
  await priv(() => db.q(`insert into public.report_send_log (tenant_id, schedule_id, sent_by_staff_id, report_name, period_label,
      to_emails, cc_emails, bcc_emails, format, property_count, status, error)
    values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [row.tenantId, row.scheduleId || null, row.staffId || null, row.name, row.period || null, row.to, row.cc || [], row.bcc || [],
     row.format, row.count === undefined ? null : row.count, row.status, row.error ? String(row.error).slice(0, 500) : null]));
}

async function send(req, res, who) {
  if (!needWrite(who, res)) return;
  let cfg, to, cc, bcc;
  try {
    cfg = configOf(req.body);
    to = emails(req.body.to, 4, 'To'); cc = emails(req.body.cc, 3, 'Cc'); bcc = emails(req.body.bcc, 3, 'Bcc');
    if (!to.length) throw Object.assign(new Error('Add at least one address in To.'), { status: 400 });
  } catch (e) { return fail(res, e); }
  const fmt = FORMATS.indexOf(req.body.format) >= 0 ? req.body.format : 'pdf';
  const name = String(req.body.name || '').trim().slice(0, 160) || undefined;
  const doc = await R.buildDoc(who.tenantId, cfg, { by: who.fullName || who.email, name });
  const subject = String(req.body.subject || doc.name).slice(0, 250);
  try {
    const file = await buildReportFile(fmt, doc);
    await mailer.sendReport({ to, cc, bcc, subject, body: String(req.body.body || ''), file, senderName: who.fullName || who.email });
    await logSend({ tenantId: who.tenantId, staffId: who.staffId, name: doc.name, period: doc.period, to, cc, bcc, format: fmt, count: doc.docs.length, status: 'sent' });
    res.json({ ok: true, sent: true, filename: file.filename, properties: doc.docs.length });
  } catch (e) {
    await logSend({ tenantId: who.tenantId, staffId: who.staffId, name: doc.name, period: doc.period, to, cc, bcc, format: fmt, count: doc.docs.length, status: 'failed', error: e.message }).catch(() => {});
    res.status(502).json({ error: 'The email was not sent: ' + e.message });
  }
}

/* ---- saved reports ------------------------------------------------------ */
async function listSaved(req, res, who) {
  const r = await priv(() => db.q(`
    select d.id, d.name, d.config, d.owner_staff_id, s.full_name owner_name, to_char(d.created_at at time zone 'America/Chicago', 'Mon FMDD, YYYY') created
      from public.report_definition d left join public.staff s on s.id = d.owner_staff_id
     where d.tenant_id = $1 and d.deleted_at is null order by d.created_at desc`, [who.tenantId]));
  const through = await P.dataThrough(who.tenantId);
  res.json({ ok: true, saved: r.rows.map(x => {
    const cfg = R.validateConfig(x.config);
    return { id: x.id, name: x.name, config: cfg, includes: R.describe(cfg), properties: cfg.props.length,
             period: cfg.reports.income ? R.resolvePeriod(cfg, through).label : 'Latest data',
             when: x.created, by: x.owner_name || '', mine: x.owner_staff_id === who.staffId,
             canDelete: x.owner_staff_id === who.staffId || isAdmin(who) };
  }) });
}
async function createSaved(req, res, who) {
  if (!needWrite(who, res)) return;
  let cfg; try { cfg = configOf(req.body); } catch (e) { return fail(res, e); }
  const name = String(req.body.name || '').trim().slice(0, 160);
  if (!name) return res.status(400).json({ error: 'Give the report a name.' });
  const r = await priv(() => db.q(`insert into public.report_definition (tenant_id, owner_staff_id, name, config)
                                   values ($1, $2, $3, $4::jsonb) returning id`, [who.tenantId, who.staffId, name, JSON.stringify(cfg)]));
  res.status(201).json({ ok: true, id: r.rows[0].id });
}
async function deleteSaved(req, res, who) {
  if (!UUID.test(req.params.id)) return res.status(400).json({ error: 'Bad report id.' });
  const r = await priv(() => db.q(`update public.report_definition set deleted_at = now()
     where id = $1::uuid and tenant_id = $2 and deleted_at is null and (owner_staff_id = $3 or $4) returning id`,
    [req.params.id, who.tenantId, who.staffId, isAdmin(who)]));
  if (!r.rows.length) return res.status(404).json({ error: 'No such report, or it is not yours to delete.' });
  res.json({ ok: true });
}

/* ---- schedules ---------------------------------------------------------- */
function shapeSchedule(x, who) {
  const next = x.active && x.next_run_at ? R.runLabel(new Date(x.next_run_at)) : null;
  return {
    id: x.id, name: x.name, config: R.validateConfig(x.config), to: x.to_emails, cc: x.cc_emails, bcc: x.bcc_emails,
    subject: x.subject, repeat: x.repeat, format: x.format, active: x.active,
    next: next ? next + ' CT' : 'Paused', last: x.last_sent_at ? R.runLabel(new Date(x.last_sent_at)) : 'Not sent yet',
    lastStatus: x.last_status, lastError: x.last_error, failures: x.failure_count, by: x.owner_name || '',
    canChange: x.owner_staff_id === who.staffId || isAdmin(who),
  };
}
async function listSchedules(req, res, who) {
  const r = await priv(() => db.q(`
    select c.*, s.full_name owner_name from public.report_schedule c left join public.staff s on s.id = c.owner_staff_id
     where c.tenant_id = $1 and c.deleted_at is null order by c.created_at desc`, [who.tenantId]));
  res.json({ ok: true, schedules: r.rows.map(x => shapeSchedule(x, who)) });
}
async function createSchedule(req, res, who) {
  if (!needWrite(who, res)) return;
  let cfg, to, cc, bcc;
  try {
    cfg = configOf(req.body);
    to = emails(req.body.to, 4, 'To'); cc = emails(req.body.cc, 3, 'Cc'); bcc = emails(req.body.bcc, 3, 'Bcc');
    if (!to.length) throw Object.assign(new Error('Add at least one address in To.'), { status: 400 });
  } catch (e) { return fail(res, e); }
  const b = req.body;
  const name = String(b.name || '').trim().slice(0, 160);
  if (!name) return res.status(400).json({ error: 'Give the schedule a name.' });
  const start = /^\d{4}-\d{2}-\d{2}$/.test(b.start || '') ? b.start : null;
  if (!start) return res.status(400).json({ error: 'Choose the first send date.' });
  if (start < R.chicagoToday()) return res.status(400).json({ error: 'The first send date is in the past.' });
  const repeat = REPEATS.indexOf(b.repeat) >= 0 ? b.repeat : 'monthly';
  const fmt = FORMATS.indexOf(b.format) >= 0 ? b.format : 'pdf';
  const next = R.nextRun(start, repeat, new Date());
  const reportId = UUID.test(b.reportId || '') ? b.reportId : null;
  const r = await priv(() => db.q(`
    insert into public.report_schedule (tenant_id, owner_staff_id, report_id, name, config, to_emails, cc_emails, bcc_emails,
                                        subject, body, format, start_date, repeat, next_run_at)
    values ($1, $2, (select id from public.report_definition where id = $3::uuid and tenant_id = $1), $4, $5::jsonb, $6, $7, $8, $9, $10, $11, $12, $13, $14)
    returning *`,
    [who.tenantId, who.staffId, reportId, name, JSON.stringify(cfg), to, cc, bcc, String(b.subject || name).slice(0, 250),
     String(b.body || '').slice(0, 5000), fmt, start, repeat, next]));
  res.status(201).json({ ok: true, schedule: shapeSchedule(Object.assign(r.rows[0], { owner_name: who.fullName }), who) });
}
async function patchSchedule(req, res, who) {
  if (!UUID.test(req.params.id)) return res.status(400).json({ error: 'Bad schedule id.' });
  const active = !!(req.body && req.body.active);
  /* pausing is always allowed; resuming sends email again, so it needs write */
  if (active && !needWrite(who, res)) return;
  const cur = (await priv(() => db.q(`select *, to_char(start_date, 'YYYY-MM-DD') start_day from public.report_schedule where id = $1::uuid and tenant_id = $2 and deleted_at is null
                                        and (owner_staff_id = $3 or $4)`, [req.params.id, who.tenantId, who.staffId, isAdmin(who)]))).rows[0];
  if (!cur) return res.status(404).json({ error: 'No such schedule, or it is not yours to change.' });
  /* resuming picks the next due date from now; nothing missed while paused is sent */
  const next = active ? R.nextRun(cur.start_day, cur.repeat, new Date()) : null;
  await priv(() => db.q(`update public.report_schedule set active = $2, next_run_at = $3, failure_count = case when $2 then 0 else failure_count end,
                          updated_at = now() where id = $1::uuid`, [cur.id, active, next]));
  res.json({ ok: true });
}
async function deleteSchedule(req, res, who) {
  if (!UUID.test(req.params.id)) return res.status(400).json({ error: 'Bad schedule id.' });
  const r = await priv(() => db.q(`update public.report_schedule set deleted_at = now(), active = false, next_run_at = null
     where id = $1::uuid and tenant_id = $2 and deleted_at is null and (owner_staff_id = $3 or $4) returning id`,
    [req.params.id, who.tenantId, who.staffId, isAdmin(who)]));
  if (!r.rows.length) return res.status(404).json({ error: 'No such schedule, or it is not yours to delete.' });
  res.json({ ok: true });
}

function reportsRoutes() {
  const r = express.Router();
  r.use(express.json({ limit: '256kb' }));
  const g = h => guard(h, { nav: 'properties' });
  r.get('/options', g(options));
  r.post('/preview', g(preview));
  r.post('/export', g(exportFile));
  r.post('/send', g(send));
  r.get('/saved', g(listSaved));
  r.post('/saved', g(createSaved));
  r.delete('/saved/:id', g(deleteSaved));
  r.get('/schedules', g(listSchedules));
  r.post('/schedules', g(createSchedule));
  r.patch('/schedules/:id', g(patchSchedule));
  r.delete('/schedules/:id', g(deleteSchedule));
  return r;
}

module.exports = { reportsRoutes, _internal: { emails, canWrite, logSend } };
