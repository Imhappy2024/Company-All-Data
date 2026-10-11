// ===========================================================================
// props-api.js — the Properties section, v2 (docs/PROPERTIES_SPEC.md).
//
// Every data method of the approved mockup (docs/mockup/properties-mockup.dc.html)
// is an endpoint here, returning the same shape the mockup's method returned,
// built from the live reporting views for every property:
//
//   mockup method        endpoint
//   liveProps()          GET /api/props/list
//   (flags, details)     GET /api/props/:id
//   monthlyAll()         GET /api/props/:id/monthly?from=YYYY-MM&to=YYYY-MM
//   statements()           (same response: income statement + cash flow)
//   noi12()              GET /api/props/:id/optimized
//   feeGroups()/receivedSeed()  GET /api/props/:id/fee?year=YYYY
//   rentRolls()          GET /api/props/:id/rent-roll?as_of=YYYY-MM-DD
//   buildings()          GET /api/props/:id/buildings
//   capexData()          GET /api/props/:id/capex?from=YYYY-MM&to=YYYY-MM
//   addresses(), incomeData()   folded into /list and the custom-view engine
//
//   custom views:        /api/props/views[...], /api/props/groups, /api/props/people
//   exports:             POST /api/props/export
//
// PROPERTY DATA IS READ-ONLY. The only writes in this file are to a person's
// own property groups, their own (or shared-for-edit) custom views, and the
// shares of views they own. Every statement that is not one of those goes
// through q(), which refuses a write verb before it reaches the pool.
//
// supabase-db connects as the postgres SUPERUSER, so RLS does not run here.
// Tenant scoping and ownership are this module's job: every statement filters
// tenant_id from the verified identity, never from anything the caller sent.
// ===========================================================================
'use strict';

const express = require('express');
const db = require('./supabase-db');
const { guard, isAdmin } = require('./portal-identity');
const { buildExport } = require('./props-export');

const WRITE_VERB = /\b(insert|update|delete|truncate|drop|alter|create|grant|revoke|copy)\b/i;
async function q(sql, params) {
  if (WRITE_VERB.test(sql)) throw new Error('props-api issued a non-read statement through the read path; refused.');
  return (await db.q(sql, params)).rows;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuidOrNull = v => (typeof v === 'string' && UUID.test(v.trim()) ? v.trim() : null);
const YM = /^(\d{4})-(0[1-9]|1[0-2])$/;
const num = v => (v === null || v === undefined || v === '' ? null : Number(v));
const MN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/* 'YYYY-MM' arithmetic. Months travel as text end to end: a pg DATE becomes a
   JS Date at local midnight and toISOString() moves it a month back for any
   reader east of UTC, which is where this is read. */
function ymAdd(ym, n) {
  const m = YM.exec(ym); const k = Number(m[1]) * 12 + Number(m[2]) - 1 + n;
  return Math.floor(k / 12) + '-' + String((k % 12) + 1).padStart(2, '0');
}
function ymSpan(a, b) {
  const out = []; let x = a;
  for (let i = 0; i < 48 && x <= b; i++) { out.push(x); x = ymAdd(x, 1); }
  return out;
}
const ymLong = ym => { const m = YM.exec(ym); return m ? MN[Number(m[2]) - 1] + ' ' + m[1] : ''; };
const ymShort = ym => { const m = YM.exec(ym); return m ? MN[Number(m[2]) - 1] + ' ' + m[1].slice(2) : ''; };
const dayLong = d => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d || ''); return m ? MN[Number(m[2]) - 1] + ' ' + Number(m[3]) + ', ' + m[1] : ''; };

function money(v) {
  if (v === null || v === undefined || Number.isNaN(v)) return '–';
  const s = Math.abs(v).toLocaleString('en-US', { maximumFractionDigits: 0 });
  return v < 0 ? '($' + s + ')' : '$' + s;
}
const pct = v => (v === null || v === undefined || Number.isNaN(v) ? '–' : (v * 100).toFixed(1) + '%');
/* A gap quoted in a sentence is taken between the ROUNDED figures that sit
   beside it, so the numbers a reader sees add up: "$712,716 x 1.25 =
   $890,895, so NOI must rise by $113,621 from $777,274". */
const gap = (a, b) => Math.round(a) - Math.round(b);
/* the mockup's cleanAddr: the street column often repeats the city and state
   the other columns carry, and ", USA" adds nothing */
function cleanAddr(a) {
  if (!a) return '';
  const seen = new Set();
  return a.replace(/, USA/g, '').split(',').map(x => x.trim()).filter(x => x && !seen.has(x.toLowerCase()) && seen.add(x.toLowerCase())).join(', ');
}

/* The end of the latest LOADED T12 period. Screens say "data through" this
   month and default their periods to the twelve ending here. */
async function dataThrough(tenantId) {
  const r = await q(`select to_char(max(period_end), 'YYYY-MM') m from public.t12_report where tenant_id = $1`, [tenantId]);
  return (r[0] && r[0].m) || null;
}

/* The monthly sync runs on the third Thursday of each month at 9:00 AM in
   Chicago. Worked out in Chicago's own calendar, so a reader in Manila sees
   the date the sync will actually run. */
function nextSync(now) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', hourCycle: 'h23' })
    .formatToParts(now || new Date()).map(x => [x.type, x.value]));
  const y = Number(parts.year), m = Number(parts.month) - 1, d = Number(parts.day), h = Number(parts.hour);
  for (let i = 0; i < 3; i++) {
    const yy = y + Math.floor((m + i) / 12), mm = (m + i) % 12;
    const wd = new Date(Date.UTC(yy, mm, 1)).getUTCDay();
    const day = 1 + ((4 - wd + 7) % 7) + 14;
    if (i > 0 || day > d || (day === d && h < 9)) {
      return { date: yy + '-' + String(mm + 1).padStart(2, '0') + '-' + String(day).padStart(2, '0'), label: MN[mm] + ' ' + day, time: '9:00 AM CT' };
    }
  }
  return null;
}

/* Debt service the property actually pays, annualised from the books where
   the books carry it; otherwise the loan record. DSCR divides by this, and so
   does every sentence on Needs attention that quotes a payment. */
function debtServiceOf(s) {
  const paid = num(s.annual_debt_service_paid);
  if (paid > 0) return { annual: paid, source: 'books' };
  const rec = num(s.annual_debt_service);
  if (rec > 0) return { annual: rec, source: 'loan_record' };
  return { annual: null, source: null };
}

/* ---------------------------------------------------------------------------
   liveProps(): one row per held property with an income statement.
--------------------------------------------------------------------------- */
const LIST_SQL = `
  select s.id, coalesce(p.display_name, s.name) as name, s.source_system, s.units, s.units_source, s.units_disagree,
         s.units_rent_roll, s.latest_occupancy, s.t12_income, s.t12_expense, s.t12_noi,
         s.cash_flow_after_debt_and_capex, s.optimized_noi, s.trailing_dscr,
         s.annual_debt_service, s.annual_debt_service_paid, s.debt,
         s.value_on_file, to_char(s.value_as_of, 'YYYY-MM-DD') as value_as_of,
         s.pm_company, s.managing_entity_id, s.managing_entity_name,
         s.street, s.city, s.state, s.zip, s.entity_name
    from public.rpt_property_summary s
    join public.property p on p.id = s.id
   where s.tenant_id = $1 and s.ownership_status = 'held' and s.t12_income is not null`;

function shapeProp(s) {
  const ds = debtServiceOf(s);
  const noi = num(s.t12_noi);
  return {
    id: s.id, name: s.name,
    src: s.source_system === 'appfolio' ? 'AppFolio' : s.source_system === 'buildium' ? 'Buildium' : (s.source_system || ''),
    units: num(s.units), unitsSource: s.units_source, unitsDisagree: !!s.units_disagree, unitsRentRoll: num(s.units_rent_roll),
    occ: num(s.latest_occupancy), inc: num(s.t12_income), opx: num(s.t12_expense), noi,
    cf: num(s.cash_flow_after_debt_and_capex), opt: num(s.optimized_noi),
    ds: ds.annual, dsSource: ds.source,
    dscr: ds.annual && noi !== null ? noi / ds.annual : null,
    debt: num(s.debt), value: num(s.value_on_file), valueAsOf: s.value_as_of,
    pm: s.pm_company || '', mgrId: s.managing_entity_id, mgr: s.managing_entity_name || null,
    owner: s.entity_name || null,
    address: cleanAddr([s.street, s.city, [s.state, s.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ')),
  };
}

async function list(req, res, who) {
  const rows = await q(LIST_SQL + ' order by s.t12_noi desc nulls last, s.name', [who.tenantId]);
  res.json({ ok: true, dataThrough: await dataThrough(who.tenantId), nextSync: nextSync(), properties: rows.map(shapeProp) });
}

async function propRow(tenantId, id) {
  const r = await q(LIST_SQL + ' and s.id = $2::uuid', [tenantId, id]);
  return r[0] ? shapeProp(r[0]) : null;
}

/* ---------------------------------------------------------------------------
   rentRolls(): per-unit aggregation of one rent roll.

   A rent_roll_line is a LEASE: roommates each get a line and expired leases
   stay on file. Fold to one row per unit first. Occupied = current or notice.
   [units, occupied, notice, vacant rented, vacant unrented, monthly rent,
    market rent occupied, market rent all, delinquency, delinquent tenants,
    prepaid, expiring in 90 days, month-to-month, mix, expirations x13]
--------------------------------------------------------------------------- */
async function rentRollAgg(tenantId, propertyId, asOf) {
  const base = `
    with l as (
      select u.*, coalesce(u.unit, u.unit_id::text) as ukey
        from public.rpt_rent_roll_unit u
       where u.tenant_id = $1 and u.property_id = $2::uuid and u.is_current
         and (case when $3::date is null then u.is_latest else u.as_of_date = $3::date end)),
    per_unit as (
      select ukey, max(as_of_date) as_of,
        case when bool_or(occupancy_status = 'current') then 'current'
             when bool_or(occupancy_status = 'notice') then 'notice'
             when bool_or(occupancy_status = 'vacant_rented') then 'vacant_rented'
             else 'vacant_unrented' end as st,
        bool_or(occupancy_status = 'notice') as has_notice,
        sum(rent) filter (where occupancy_status in ('current', 'notice')) as rent,
        max(market_rent) as mkt,
        sum(balance_due) as bal,
        max(lease_end) filter (where occupancy_status in ('current', 'notice')) as lease_end,
        bool_or(occupancy_status in ('current', 'notice') and (lease_end is null or lease_end < as_of_date)) as mtm,
        max(beds) beds, max(baths) baths
      from l group by 1)`;
  const agg = (await q(base + `
    select count(*) units,
      count(*) filter (where st in ('current', 'notice')) occ,
      count(*) filter (where has_notice) notice,
      count(*) filter (where st = 'vacant_rented') vr,
      count(*) filter (where st = 'vacant_unrented') vu,
      sum(rent) rent,
      sum(mkt) filter (where st in ('current', 'notice')) mkt_occ,
      sum(mkt) mkt_all,
      sum(bal) filter (where bal > 0) delinq,
      count(*) filter (where bal > 0) delinq_n,
      -sum(bal) filter (where bal < 0) prepaid,
      count(*) filter (where st in ('current', 'notice') and lease_end > as_of and lease_end <= as_of + 90) exp90,
      count(*) filter (where mtm) mtm,
      to_char(max(as_of), 'YYYY-MM-DD') as_of
    from per_unit`, [tenantId, propertyId, asOf]))[0];
  if (!agg || !Number(agg.units)) return null;

  const mix = (await q(base + `
    select beds, baths, count(*) n, count(*) filter (where st in ('current', 'notice')) o,
           avg(rent) filter (where st in ('current', 'notice') and rent > 0) ar, avg(mkt) filter (where mkt > 0) am
      from per_unit group by 1, 2 order by beds nulls first, baths nulls first`, [tenantId, propertyId, asOf]))
    .map(m => [num(m.beds), num(m.baths), Number(m.n), Number(m.o), num(m.ar), num(m.am)]);

  /* thirteen buckets from the as-of month, by the month the lease ends */
  const asOfYm = agg.as_of.slice(0, 7);
  const ends = await q(base + `
    select to_char(lease_end, 'YYYY-MM') m, count(*) n from per_unit
     where st in ('current', 'notice') and lease_end is not null group by 1`, [tenantId, propertyId, asOf]);
  const byM = Object.fromEntries(ends.map(e => [e.m, Number(e.n)]));
  const expMonths = Array.from({ length: 13 }, (_, i) => ymAdd(asOfYm, i));

  return {
    asOf: agg.as_of,
    R: [Number(agg.units), Number(agg.occ), Number(agg.notice), Number(agg.vr), Number(agg.vu), num(agg.rent),
        num(agg.mkt_occ), num(agg.mkt_all), num(agg.delinq), Number(agg.delinq_n), num(agg.prepaid),
        Number(agg.exp90), Number(agg.mtm), mix, expMonths.map(m => byM[m] || 0)],
    expMonths: expMonths.map(ymShort),
  };
}

/* the twelve months ending at the property's latest month with data */
async function trailingWindow(tenantId, propertyId) {
  const r = await q(`select to_char(month, 'YYYY-MM') m from public.rpt_property_month
                      where tenant_id = $1 and property_id = $2::uuid and has_data
                      order by month desc limit 12`, [tenantId, propertyId]);
  if (!r.length) return null;
  return { from: r[r.length - 1].m, to: r[0].m, months: r.length };
}

/* ---------------------------------------------------------------------------
   One property: the record, the key figures, and Needs attention.

   The rules are the mockup's, run here so the badge count and the sentences
   are the same for every screen that shows them. Each flag names the actual
   numbers, says what they mean, the next step and the source.
--------------------------------------------------------------------------- */
async function property(req, res, who) {
  const id = uuidOrNull(req.params.id);
  if (!id) return res.status(400).json({ error: 'A property id is required.' });
  const p = await propRow(who.tenantId, id);
  if (!p) return res.status(404).json({ error: 'No such property.' });

  const win = await trailingWindow(who.tenantId, id);
  const rr = await rentRollAgg(who.tenantId, id, null);
  const flags = needsAttention(p, win, rr);
  res.json({ ok: true, dataThrough: await dataThrough(who.tenantId), property: p, window: win,
             rentRollAsOf: rr ? rr.asOf : null, flags });
}

function needsAttention(p, win, rr) {
  const flags = [];
  const per12 = win ? ymLong(win.from) + ' to ' + ymLong(win.to) : 'the last 12 months';
  const dsY = p.ds;
  const rrDay = rr ? dayLong(rr.asOf) : '';
  if (p.noi !== null && p.noi < 0) {
    flags.push({ sev: 3, title: 'Operating loss of ' + money(-p.noi) + ' over the last 12 months',
      detail: 'Operating expenses of ' + money(p.opx) + ' were higher than total income of ' + money(p.inc) + ' (' + per12 + '). The property is not covering its own operating costs, before any debt payments or capex.',
      next: 'Next step: check which expense accounts grew in Monthly financials and whether income dropped from vacancy.',
      source: 'Source: monthly income statements, ' + per12 + '.' });
  }
  if (p.dscr !== null && p.dscr < 1 && p.noi > 0) {
    flags.push({ sev: 3, title: 'Not covering its mortgage: DSCR ' + p.dscr.toFixed(2),
      detail: 'NOI of ' + money(p.noi) + ' (' + per12 + ') covers annual mortgage payments of ' + money(dsY) + ' only ' + p.dscr.toFixed(2) + ' times, a shortfall of ' + money(gap(dsY, p.noi)) + ' a year that has to be funded from outside the property. To reach the 1.25 lenders usually require, NOI would need to rise to ' + money(dsY * 1.25) + ' (+' + money(gap(dsY * 1.25, p.noi)) + ').',
      next: 'Next step: review the loan covenant and options in the Optimized NOI tab (what it earns at its best and the maximum loan it supports).',
      source: 'Source: income statements and loan payments, ' + per12 + '.' });
  } else if (p.dscr !== null && p.dscr < 1.25 && p.noi > 0) {
    flags.push({ sev: 2, title: 'Mortgage coverage DSCR ' + p.dscr.toFixed(2) + ', below the 1.25 lenders usually require',
      detail: 'NOI of ' + money(p.noi) + ' (' + per12 + ') divided by annual mortgage payments of ' + money(dsY) + ' = ' + p.dscr.toFixed(2) + '. The property pays its loan, but with little room: to reach 1.25, NOI needs to rise by ' + money(gap(dsY * 1.25, p.noi)) + ' to ' + money(dsY * 1.25) + ', or annual payments fall to ' + money(p.noi / 1.25) + '.',
      next: 'Next step: confirm the actual covenant in the loan agreement; see the Optimized NOI tab for whether its best months clear 1.25.',
      source: 'Source: income statements and loan payments, ' + per12 + '.' });
  }
  if (rr) {
    const R = rr.R;
    const vac = R[3] + R[4], vacP = vac / R[0], avgR = R[1] && R[5] ? R[5] / R[1] : null;
    if (vacP >= 0.15) {
      flags.push({ sev: 2, title: vac + ' of ' + R[0] + ' units vacant (' + pct(vacP) + ')',
        detail: 'The ' + rrDay + ' rent roll shows ' + R[3] + ' vacant units already leased and ' + R[4] + ' not leased. ' + (avgR ? 'At the current average rent of ' + money(avgR) + ', the unleased units represent about ' + money(R[4] * avgR) + ' a month (' + money(R[4] * avgR * 12) + ' a year) of missing rent.' : ''),
        next: 'Next step: check leasing activity with the manager; unit details are in the Rent roll tab.',
        source: 'Source: rent roll as of ' + rrDay + '.' });
    }
    if (R[8] && R[5] && R[8] / R[5] >= 0.05) {
      flags.push({ sev: 2, title: 'Delinquency of ' + money(R[8]) + ' (' + pct(R[8] / R[5]) + ' of monthly rent)',
        detail: R[9] + (R[9] === 1 ? ' tenant owes' : ' tenants owe') + ' a combined ' + money(R[8]) + ' as of ' + rrDay + ', against monthly rent of ' + money(R[5]) + '.',
        next: 'Next step: ask the manager for the collection plan on the largest balances (Rent roll tab, Balance column).',
        source: 'Source: rent roll as of ' + rrDay + '.' });
    }
    if (R[1] && R[11] / R[1] >= 0.1) {
      flags.push({ sev: 1, title: R[11] + ' leases expire in the next 90 days (' + pct(R[11] / R[1]) + ' of occupied units)',
        detail: 'Leases ending within 90 days of ' + rrDay + ', plus ' + R[12] + ' already month-to-month. Renewals in this window decide occupancy going into next year.',
        next: 'Next step: confirm the renewal plan with the manager; month-by-month expirations are in the Rent roll tab.',
        source: 'Source: rent roll as of ' + rrDay + '.' });
    }
  }
  if (!p.mgr) {
    flags.push({ sev: 1, title: 'No managing entity is assigned to this property',
      detail: 'The property record has no managing entity, so it does not roll up under any entity on the Portfolio page and appears under "No managing entity".',
      next: 'Next step: set the managing entity on the property record.',
      source: 'Source: property record in the database.' });
  }
  if (p.value && !p.valueAsOf) {
    flags.push({ sev: 1, title: 'Market value of ' + money(p.value) + ' has no valuation date',
      detail: 'The value on file has no date or source (appraisal, broker opinion, purchase price), so it is unclear how current it is. ' + (p.debt ? 'Loan-to-value (' + pct(p.debt / p.value) + ') and estimated equity (' + money(gap(p.value, p.debt)) + ') are calculated from it.' : ''),
      next: 'Next step: add the date and source of the valuation to the property record, or order an updated valuation.',
      source: 'Source: property record in the database.' });
  }
  if (p.value && p.valueAsOf && monthsOld(p.valueAsOf) > 12) {
    flags.push({ sev: 1, title: 'Market value of ' + money(p.value) + ' is more than 12 months old',
      detail: 'The value on file is dated ' + dayLong(p.valueAsOf) + '. ' + (p.debt ? 'Loan-to-value (' + pct(p.debt / p.value) + ') and estimated equity are based on it.' : ''),
      next: 'Next step: update the valuation before using it for a refinance or investor report.',
      source: 'Source: property record in the database.' });
  }
  if (p.dscr === null && p.debt) {
    flags.push({ sev: 1, title: 'Mortgage coverage cannot be calculated',
      detail: 'There is ' + money(p.debt) + ' of debt on file, but no loan payments in the books and not every loan has its annual payment recorded, so DSCR is left blank rather than guessed.',
      next: 'Next step: add the annual debt service to each loan record (QuickBooks balance sheets will also fill this in once connected).',
      source: 'Source: loan records in the database.' });
  }
  const LEVEL = { 3: 'Critical', 2: 'Watch', 1: 'Data' };
  return flags.sort((a, b) => b.sev - a.sev).map(f => Object.assign(f, { level: LEVEL[f.sev] }));
}

function monthsOld(day) {
  const m = /^(\d{4})-(\d{2})/.exec(day); if (!m) return null;
  const now = new Date();
  return (now.getFullYear() - Number(m[1])) * 12 + (now.getMonth() + 1 - Number(m[2]));
}

/* a from/to pair, at most 24 months, swapped if backwards; defaults to the
   twelve months ending at `through` */
function period(query, through) {
  let a = YM.test(String(query.from || '')) ? String(query.from) : null;
  let b = YM.test(String(query.to || '')) ? String(query.to) : null;
  if (!b) b = through || new Date().toISOString().slice(0, 7);
  if (!a) a = ymAdd(b, -11);
  if (a > b) { const x = a; a = b; b = x; }
  if (ymSpan(a, b).length > 24) a = ymAdd(b, -23);
  return { from: a, to: b, months: ymSpan(a, b) };
}

/* ---------------------------------------------------------------------------
   monthlyAll() + statements(): the Monthly financials tab.
--------------------------------------------------------------------------- */
async function monthly(req, res, who) {
  const id = uuidOrNull(req.params.id);
  if (!id) return res.status(400).json({ error: 'A property id is required.' });
  const p = await propRow(who.tenantId, id);
  if (!p) return res.status(404).json({ error: 'No such property.' });
  const per = period(req.query, await dataThrough(who.tenantId));
  res.json(Object.assign({ ok: true, property: p }, await monthlyData(who.tenantId, id, per)));
}

/* the monthly figures and both statements for one property and period; the
   Monthly financials tab and the Reports tab read the same thing */
async function monthlyData(tenantId, id, per) {
  const args = [tenantId, id, per.from + '-01', per.to + '-01'];

  const pm = await q(`
    select to_char(month, 'YYYY-MM') m, has_data, total_operating_income inc, total_operating_expense opx, noi,
           rent_income, recurring_fee_income, non_recurring_fee_income, total_expected_income,
           capex, am_fee_booked, debt_service, debt_service_source, delinquency, loss_to_lease,
           physical_occupancy, economic_occupancy, units, cash_flow
      from public.rpt_property_month
     where tenant_id = $1 and property_id = $2::uuid and lower(accounting_basis) = 'cash'
       and month between $3::date and $4::date`, args);
  const byM = Object.fromEntries(pm.map(r => [r.m, r]));
  const col = k => per.months.map(m => (byM[m] && byM[m].has_data ? num(byM[m][k]) : null));

  const lines = await q(`
    select section, line_label, to_char(month, 'YYYY-MM') m, sum(amount) amount, min(sort_order) so
      from public.rpt_income_statement_month
     where tenant_id = $1 and property_id = $2::uuid and lower(accounting_basis) = 'cash'
       and month between $3::date and $4::date
     group by 1, 2, 3`, args);
  const cash = await q(`
    select activity, line_label, to_char(month, 'YYYY-MM') m, sum(amount) amount, min(sort_order) so
      from public.rpt_cash_flow_line
     where tenant_id = $1 and property_id = $2::uuid and lower(accounting_basis) = 'cash'
       and month between $3::date and $4::date
     group by 1, 2, 3`, args);

  const pivot = (rows, keyField) => {
    const out = {};
    for (const r of rows) {
      const sec = r[keyField];
      out[sec] = out[sec] || new Map();
      if (!out[sec].has(r.line_label)) out[sec].set(r.line_label, { so: Number(r.so), v: {} });
      out[sec].get(r.line_label).v[r.m] = num(r.amount);
    }
    const res2 = {};
    for (const sec of Object.keys(out)) {
      res2[sec] = [...out[sec].entries()].sort((a, b) => a[1].so - b[1].so)
        .map(([label, x]) => [label, per.months.map(m => (m in x.v ? x.v[m] : null))]);
    }
    return res2;
  };
  const st = pivot(lines, 'section');
  const cf = pivot(cash, 'activity');
  const src = pm.find(r => r.debt_service_source);
  return {
    from: per.from, to: per.to, months: per.months, labels: per.months.map(ymShort),
    series: {
      inc: col('inc'), opx: col('opx'), noi: col('noi'), rent: col('rent_income'),
      recurringFee: col('recurring_fee_income'), nonRecurringFee: col('non_recurring_fee_income'),
      expected: col('total_expected_income'), capex: col('capex'), am: col('am_fee_booked'),
      ds: col('debt_service'), delinq: col('delinquency'), ltl: col('loss_to_lease'),
      occ: col('physical_occupancy'), econOcc: col('economic_occupancy'), units: col('units'), cashFlow: col('cash_flow'),
    },
    dsSource: src ? dsSourceText(src.debt_service_source) : 'Not on file',
    statements: {
      income: st.income || [], expense: st.operating_expense || [],
      nonopIncome: st.non_operating_income || [], nonopExpense: st.non_operating_expense || [],
      operating: cf.operating || [], financing: cf.financing || [], investing: cf.investing || [],
    },
  };
}

function dsSourceText(s) {
  return ({ income_statement: 'From the books: interest plus principal paid',
            loan_record: 'Loan record, annual debt service divided by 12',
            interest_only_books: 'Interest only, from the books (no principal recorded)' })[s] || 'From the books where paid, otherwise the loan record';
}

/* ---------------------------------------------------------------------------
   noi12(): twelve months of NOI and the standard what-if values.
--------------------------------------------------------------------------- */
async function optimized(req, res, who) {
  const id = uuidOrNull(req.params.id);
  if (!id) return res.status(400).json({ error: 'A property id is required.' });
  const p = await propRow(who.tenantId, id);
  if (!p) return res.status(404).json({ error: 'No such property.' });
  res.json(Object.assign({ ok: true, property: p }, await optimizedData(who.tenantId, id, p)));
}

/* twelve months of NOI ending at the latest loaded month, and the standard
   debt service; shared with the Reports tab */
async function optimizedData(tenantId, id, p, knownThrough) {
  const through = knownThrough || await dataThrough(tenantId);
  const months = ymSpan(ymAdd(through, -11), through);
  const rows = await q(`
    select to_char(month, 'YYYY-MM') m, noi from public.rpt_property_month
     where tenant_id = $1 and property_id = $2::uuid and lower(accounting_basis) = 'cash' and has_data
       and month between $3::date and $4::date`, [tenantId, id, months[0] + '-01', through + '-01']);
  const byM = Object.fromEntries(rows.map(r => [r.m, num(r.noi)]));
  const s = (await q(`select annual_debt_service, annual_debt_service_paid from public.rpt_property_summary
                       where tenant_id = $1 and id = $2::uuid`, [tenantId, id]))[0] || {};
  /* the loan record first, then the books, as the mockup's standard values */
  let ds = null, dsSrc = 'Not on file';
  if (num(s.annual_debt_service) > 0) { ds = num(s.annual_debt_service); dsSrc = 'Loan record'; }
  else if (num(s.annual_debt_service_paid) > 0) { ds = num(s.annual_debt_service_paid); dsSrc = 'Paid in the books, annualized'; }
  return { months, labels: months.map(ymShort), noi: months.map(m => (m in byM ? byM[m] : null)),
           debtService: ds, debtServiceSource: dsSrc, loan: p.debt };
}

/* ---------------------------------------------------------------------------
   feeGroups() + receivedSeed() for one property: Expected / Received /
   Variance by month, from public.rpt_am_fee_month (which already applies each
   manager's same-month or following-month timing).
--------------------------------------------------------------------------- */
async function fee(req, res, who) {
  const id = uuidOrNull(req.params.id);
  if (!id) return res.status(400).json({ error: 'A property id is required.' });
  const year = Number(req.query.year) >= 2000 && Number(req.query.year) <= 2100 ? Number(req.query.year) : Number((await dataThrough(who.tenantId) || '2026').slice(0, 4));
  const sched = await q(`
    select s.id, s.label, s.manager_group, s.payment_timing, s.fee_type, s.fee_pct, s.fixed_amount, s.fee_note
      from public.am_fee_schedule s
      join public.am_fee_schedule_property l on l.schedule_id = s.id
     where s.tenant_id = $1 and l.property_id = $2::uuid
     order by s.sort_order`, [who.tenantId, id]);
  if (!sched.length) return res.json({ ok: true, year, schedule: null });
  const sc = sched[0];
  const rows = await q(`
    select extract(month from fee_month)::int mo, expected, received, received_source, variance
      from public.rpt_am_fee_month
     where tenant_id = $1 and schedule_id = $2::uuid
       and fee_month >= make_date($3, 1, 1) and fee_month < make_date($3 + 1, 1, 1)`, [who.tenantId, sc.id, year]);
  const byMo = Object.fromEntries(rows.map(r => [r.mo, r]));
  const arr = k => Array.from({ length: 12 }, (_, i) => (byMo[i + 1] ? num(byMo[i + 1][k]) : null));
  const feeText = sc.fee_type === 'fixed' || num(sc.fixed_amount)
    ? (sc.fee_note && !/timing/i.test(sc.fee_note) ? sc.fee_note : money(num(sc.fixed_amount)) + ' a month')
    : (num(sc.fee_pct) || 0).toFixed(2).replace(/\.?0+$/, '') + '% of gross income';
  res.json({
    ok: true, year,
    schedule: { label: sc.label, group: sc.manager_group, timing: sc.payment_timing, feeText,
                following: /follow/i.test(sc.payment_timing || '') },
    expected: arr('expected'), received: arr('received'), variance: arr('variance'),
    fromBooks: Array.from({ length: 12 }, (_, i) => !!(byMo[i + 1] && byMo[i + 1].received_source === 'books')),
  });
}

/* ---------------------------------------------------------------------------
   Rent roll: cards, unit mix, expirations, and the FULL unit list.
--------------------------------------------------------------------------- */
async function rentRoll(req, res, who) {
  const id = uuidOrNull(req.params.id);
  if (!id) return res.status(400).json({ error: 'A property id is required.' });
  const dates = (await q(`select distinct to_char(as_of_date, 'YYYY-MM-DD') d from public.rpt_rent_roll_unit
                           where tenant_id = $1 and property_id = $2::uuid order by 1 desc`, [who.tenantId, id])).map(r => r.d);
  const asked = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.as_of || '')) && dates.includes(String(req.query.as_of)) ? String(req.query.as_of) : null;
  const rr = await rentRollAgg(who.tenantId, id, asked);
  if (!rr) return res.json({ ok: true, asOfDates: dates, rentRoll: null });
  const units = await q(`
    select coalesce(unit, '–') unit, beds, baths, tenant, occupancy_status, status, rent, market_rent, balance_due,
           to_char(lease_end, 'YYYY-MM-DD') lease_end
      from public.rpt_rent_roll_unit
     where tenant_id = $1 and property_id = $2::uuid and is_current
       and (case when $3::date is null then is_latest else as_of_date = $3::date end)
     order by sort_order nulls last, unit`, [who.tenantId, id, asked]);
  res.json({ ok: true, asOfDates: dates, asOf: rr.asOf, rentRoll: rr.R, expMonths: rr.expMonths,
    units: units.map(u => ({ unit: u.unit, beds: num(u.beds), baths: num(u.baths), tenant: u.tenant || '',
      status: u.occupancy_status || u.status || '', rawStatus: u.status || '', rent: num(u.rent), market: num(u.market_rent),
      balance: num(u.balance_due), leaseEnd: u.lease_end })) });
}

/* ---------------------------------------------------------------------------
   buildings(): the unit table (badly named; a row is a BUILDING).
   [no., name, address, units, year built, construction, stories, sq ft,
    roof year, sprinklered, fire alarm, parcel]
--------------------------------------------------------------------------- */
async function buildings(req, res, who) {
  const id = uuidOrNull(req.params.id);
  if (!id) return res.status(400).json({ error: 'A property id is required.' });
  const rows = await q(`
    select u.building_number, u.unit_identifier, u.location_street, u.location_city, u.location_state, u.location_zip,
           u.current_total_units, u.year_built, u.construction_type, u.stories, u.square_feet, u.roof_year,
           u.sprinklered, u.fire_alarm, u.parcel_id as parcel_number
      from public.unit u
     where u.tenant_id = $1 and u.property_id = $2::uuid`, [who.tenantId, id]);
  const nat = (a, b) => String(a || '').localeCompare(String(b || ''), 'en', { numeric: true });
  rows.sort((a, b) => nat(a.building_number, b.building_number) || nat(a.unit_identifier, b.unit_identifier));
  const B = rows.map(r => [
    r.building_number === null ? '' : String(r.building_number), r.unit_identifier || '',
    r.location_street ? cleanAddr([r.location_street, r.location_city, [r.location_state, r.location_zip].filter(Boolean).join(' ')].filter(Boolean).join(', ')) : null,
    num(r.current_total_units), r.year_built ? String(r.year_built) : null, r.construction_type || null,
    r.stories ? String(r.stories) : null, num(r.square_feet), r.roof_year ? String(r.roof_year) : null,
    r.sprinklered === null || r.sprinklered === undefined ? null : !!r.sprinklered,
    r.fire_alarm === null || r.fire_alarm === undefined ? null : !!r.fire_alarm, r.parcel_number || null]);
  const rr = await rentRollAgg(who.tenantId, id, null);
  res.json({ ok: true, buildings: B, rentRollUnits: rr ? rr.R[0] : null, rentRollAsOf: rr ? rr.asOf : null });
}

/* ---------------------------------------------------------------------------
   capexData(): monthly totals and categories for the selected period.
   Categories come from public.capex_category_map via public.rpt_capex_line.
--------------------------------------------------------------------------- */
async function capex(req, res, who) {
  const id = uuidOrNull(req.params.id);
  if (!id) return res.status(400).json({ error: 'A property id is required.' });
  const p = await propRow(who.tenantId, id);
  if (!p) return res.status(404).json({ error: 'No such property.' });
  const per = period(req.query, await dataThrough(who.tenantId));
  const args = [who.tenantId, id, per.from + '-01', per.to + '-01'];
  const pm = await q(`
    select to_char(month, 'YYYY-MM') m, capex, total_operating_income inc, noi
      from public.rpt_property_month
     where tenant_id = $1 and property_id = $2::uuid and lower(accounting_basis) = 'cash' and has_data
       and month between $3::date and $4::date order by month`, args);
  const cats = await q(`
    select category, sum(amount) total from public.rpt_capex_line
     where tenant_id = $1 and property_id = $2::uuid and lower(accounting_basis) = 'cash'
       and month between $3::date and $4::date
     group by 1 having sum(amount) <> 0 order by 2 desc`, args);
  const rr = await rentRollAgg(who.tenantId, id, null);
  res.json({ ok: true, property: p, from: per.from, to: per.to,
    months: pm.filter(r => r.capex !== null).map(r => ({ m: r.m, label: ymShort(r.m), capex: num(r.capex), inc: num(r.inc), noi: num(r.noi) })),
    categories: cats.map(c => [c.category, num(c.total)]),
    units: rr ? rr.R[0] : p.units });
}

/* ===========================================================================
   CUSTOM VIEWS (spec section 4)
   =========================================================================== */
const V = require('./props-views');

async function listGroups(req, res, who) {
  const rows = await q(`
    select g.id, g.name, coalesce(array_agg(m.property_id::text order by m.property_id) filter (where m.property_id is not null), '{}') as property_ids
      from public.property_group g
      left join public.property_group_member m on m.group_id = g.id
     where g.tenant_id = $1 and g.owner_staff_id = $2
     group by g.id order by g.name`, [who.tenantId, who.staffId]);
  res.json({ ok: true, groups: rows });
}

async function createGroup(req, res, who) {
  const b = req.body || {};
  const name = String(b.name || '').trim().slice(0, 120);
  if (!name) return res.status(400).json({ error: 'Name the group.' });
  const ids = [...new Set((Array.isArray(b.property_ids) ? b.property_ids : []).map(uuidOrNull).filter(Boolean))].slice(0, 500);
  if (!ids.length) return res.status(400).json({ error: 'Select at least one property.' });
  try {
    const out = await db.tx(async client => {
      const g = (await client.query(
        `insert into public.property_group (tenant_id, owner_staff_id, name) values ($1, $2, $3) returning id, name`,
        [who.tenantId, who.staffId, name])).rows[0];
      /* only properties in the caller's own tenant can be members */
      await client.query(
        `insert into public.property_group_member (group_id, property_id)
         select $1::uuid, p.id from public.property p where p.tenant_id = $2 and p.id = any($3::uuid[])`,
        [g.id, who.tenantId, ids]);
      return g;
    });
    res.status(201).json({ ok: true, group: Object.assign(out, { property_ids: ids }) });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'You already have a group with that name.' });
    throw e;
  }
}

async function deleteGroup(req, res, who) {
  const id = uuidOrNull(req.params.id);
  if (!id) return res.status(400).json({ error: 'Bad group id.' });
  const r = await db.q(`delete from public.property_group where id = $1::uuid and tenant_id = $2 and owner_staff_id = $3 returning id`,
    [id, who.tenantId, who.staffId]);
  if (!r.rows.length) return res.status(404).json({ error: 'No such group.' });
  res.json({ ok: true, deleted: id });
}

async function loadView(id, who) {
  await deptsOf(who);
  const r = await db.q(`
    select v.*, s.full_name as owner_name,
           (select coalesce(json_agg(json_build_object('principal_type', sh.principal_type, 'principal_id', sh.principal_id,
                    'permission', sh.permission,
                    'name', coalesce(st.full_name, dp.name, case sh.principal_id when 'owner' then 'Owners' when 'admin' then 'Admins' when 'user' then 'All users' end, sh.principal_id))), '[]'::json)
              from public.saved_view_share sh
              left join public.staff st on sh.principal_type = 'user' and st.id::text = sh.principal_id
              left join public.department dp on sh.principal_type = 'department' and dp.id::text = sh.principal_id
             where sh.view_id = v.id) as shares
      from public.saved_view v left join public.staff s on s.id = v.owner_staff_id
     where v.id = $1::uuid and v.tenant_id = $2 and v.deleted_at is null and v.display_type = 'custom'`, [id, who.tenantId]);
  return r.rows[0] || null;
}

/* the caller's current departments, for department shares */
async function deptsOf(who) {
  if (who._depts) return who._depts;
  const r = await q(`select department_id::text d from public.department_member
                      where tenant_id = $1 and staff_id = $2::uuid and (end_date is null or end_date >= current_date)`, [who.tenantId, who.staffId]);
  who._depts = r.map(x => x.d);
  return who._depts;
}

/* owner > editor > viewer > null. Private by default: only the creator, and
   whoever they shared it with: a person, a role, or a department. */
function permissionFor(view, who) {
  if (!view) return null;
  if (view.owner_staff_id === who.staffId) return 'owner';
  let best = null;
  for (const s of view.shares || []) {
    const match = (s.principal_type === 'user' && s.principal_id === who.staffId)
      || (s.principal_type === 'role' && s.principal_id === who.role)
      || (s.principal_type === 'department' && (who._depts || []).indexOf(s.principal_id) >= 0);
    if (!match) continue;
    if (s.permission === 'editor') best = 'editor'; else if (best !== 'editor') best = 'viewer';
  }
  return best;
}

async function listViews(req, res, who) {
  const depts = await deptsOf(who);
  const r = await db.q(`
    select v.id, v.name, v.owner_staff_id, v.updated_at, (v.owner_staff_id = $2) as is_mine
      from public.saved_view v
     where v.tenant_id = $1 and v.deleted_at is null and v.display_type = 'custom'
       and (v.owner_staff_id = $2 or exists (
             select 1 from public.saved_view_share sh where sh.view_id = v.id
                and ((sh.principal_type = 'user' and sh.principal_id = $2::text) or (sh.principal_type = 'role' and sh.principal_id = $3)
                     or (sh.principal_type = 'department' and sh.principal_id = any($4::text[])))))
     order by v.created_at`, [who.tenantId, who.staffId, who.role, depts]);
  res.json({ ok: true, views: r.rows });
}

async function getView(req, res, who) {
  const id = uuidOrNull(req.params.id);
  if (!id) return res.status(400).json({ error: 'Bad view id.' });
  const v = await loadView(id, who);
  const perm = permissionFor(v, who);
  if (!perm) return res.status(404).json({ error: 'No such view.' });
  const config = V.validateConfig(v.config);
  const result = await V.evaluate(config, who.tenantId);
  res.json({ ok: true, permission: perm,
    view: { id: v.id, name: v.name, owner_name: v.owner_name, is_mine: v.owner_staff_id === who.staffId, config,
            shares: perm === 'owner' ? v.shares : v.shares.map(s => ({ name: s.name, permission: s.permission, principal_type: s.principal_type })) },
    result });
}

/* the builder's live preview: a draft config, the caller's own tenant scope,
   nothing written */
async function preview(req, res, who) {
  const config = V.validateConfig((req.body || {}).config);
  res.json({ ok: true, config, result: await V.evaluate(config, who.tenantId) });
}

/* every property's plain figures, read once per session so the builder can
   evaluate drafts in the browser (public/props-views-core.js) with no request
   per keystroke. The same tenant scope as preview; nothing written. */
async function dataset(req, res, who) {
  res.json(Object.assign({ ok: true }, await V.loadPlain(null, who.tenantId)));
}

async function createView(req, res, who) {
  const b = req.body || {};
  const name = String(b.name || '').trim().slice(0, 160);
  if (!name) return res.status(400).json({ error: 'A name is required.' });
  const config = V.validateConfig(b.config);
  const r = await db.q(`
    insert into public.saved_view (tenant_id, owner_staff_id, name, dataset_key, display_type, config)
    values ($1, $2, $3, 'property_custom', 'custom', $4::jsonb) returning id, name`,
    [who.tenantId, who.staffId, name, JSON.stringify(config)]);
  if (Array.isArray(b.shares)) await writeShares(r.rows[0].id, b.shares, who, who.staffId);
  res.status(201).json({ ok: true, view: r.rows[0] });
}

async function updateView(req, res, who) {
  const id = uuidOrNull(req.params.id);
  if (!id) return res.status(400).json({ error: 'Bad view id.' });
  const v = await loadView(id, who);
  const perm = permissionFor(v, who);
  if (!perm) return res.status(404).json({ error: 'No such view.' });
  if (perm === 'viewer') return res.status(403).json({ error: 'You can view this view but not edit it.' });
  const b = req.body || {};
  const name = b.name === undefined ? v.name : String(b.name || '').trim().slice(0, 160);
  if (!name) return res.status(400).json({ error: 'A name is required.' });
  const config = V.validateConfig(b.config === undefined ? v.config : b.config);
  await db.q(`update public.saved_view set name = $3, config = $4::jsonb, updated_at = now()
               where id = $1::uuid and tenant_id = $2 and deleted_at is null`, [id, who.tenantId, name, JSON.stringify(config)]);
  /* only the creator changes who can see it */
  if (Array.isArray(b.shares) && perm === 'owner') await writeShares(id, b.shares, who, v.owner_staff_id);
  res.json({ ok: true });
}

async function deleteView(req, res, who) {
  const id = uuidOrNull(req.params.id);
  if (!id) return res.status(400).json({ error: 'Bad view id.' });
  const v = await loadView(id, who);
  if (permissionFor(v, who) !== 'owner') return res.status(v ? 403 : 404).json({ error: v ? 'Only the creator can delete a view.' : 'No such view.' });
  await db.q(`update public.saved_view set deleted_at = now() where id = $1::uuid and tenant_id = $2`, [id, who.tenantId]);
  res.json({ ok: true, deleted: id });
}

async function writeShares(viewId, list, who, ownerId) {
  const clean = [];
  for (const s of list.slice(0, 50)) {
    if (!s || ['user', 'role', 'department'].indexOf(s.principal_type) < 0) continue;
    if (s.permission !== 'viewer' && s.permission !== 'editor') continue;
    const pid = String(s.principal_id || '').trim();
    if (s.principal_type === 'user' && (!uuidOrNull(pid) || pid === ownerId)) continue;
    if (s.principal_type === 'role' && ['owner', 'admin', 'user'].indexOf(pid) < 0) continue;
    if (s.principal_type === 'department' && !uuidOrNull(pid)) continue;
    clean.push([pid, s.principal_type, s.permission]);
  }
  await db.tx(async client => {
    await client.query('delete from public.saved_view_share where view_id = $1::uuid', [viewId]);
    for (const [pid, t, perm] of clean) {
      /* a user share must name a person in this tenant */
      if (t === 'user' || t === 'department') {
        const table = t === 'user' ? 'public.staff' : 'public.department';
        const ok = (await client.query('select 1 from ' + table + ' where id = $1::uuid and tenant_id = $2', [pid, who.tenantId])).rows.length;
        if (!ok) continue;
      }
      await client.query(`insert into public.saved_view_share (view_id, principal_type, principal_id, permission, granted_by)
                          values ($1::uuid, $2, $3, $4, $5) on conflict (view_id, principal_type, principal_id) do update set permission = excluded.permission`,
        [viewId, t, pid, perm, who.staffId]);
    }
  });
}

async function people(req, res, who) {
  const r = await q(`select id, full_name, email from public.staff
                      where tenant_id = $1 and is_active and dashboard_access and id <> $2 order by full_name`, [who.tenantId, who.staffId]);
  const depts = await q(`select id::text id, name from public.department where tenant_id = $1 order by name`, [who.tenantId]);
  res.json({ ok: true, people: r,
             teams: depts.map(d => ({ type: 'department', id: d.id, name: d.name }))
               .concat([{ type: 'role', id: 'owner', name: 'Owners' }, { type: 'role', id: 'admin', name: 'Admins' }, { type: 'role', id: 'user', name: 'All users' }]),
             fields: V.FIELD_LIST, periods: await V.periodOptions(who.tenantId) });
}

/* ---------------------------------------------------------------------------
   Export. The browser sends the tables exactly as they are on screen
   (title, period, cards, tables); this turns them into a file. Nothing is
   read from the database here, so an export can never show more than the
   screen it came from.
--------------------------------------------------------------------------- */
async function exportFile(req, res, who) {
  const b = req.body || {};
  const fmt = String(b.format || '');
  if (['xlsx', 'pdf', 'csv'].indexOf(fmt) < 0) return res.status(400).json({ error: 'Unknown export format.' });
  const out = await buildExport(fmt, b, who);
  res.set('Content-Type', out.type);
  res.set('Content-Disposition', 'attachment; filename="' + out.filename.replace(/["\\\r\n]/g, '') + '"; filename*=UTF-8\'\'' + encodeURIComponent(out.filename));
  res.send(out.buffer);
}

/* ------------------------------------------------------------------------ */

function propsRoutes() {
  const r = express.Router();
  r.use(express.json({ limit: '2mb' }));
  const g = h => guard(h, { nav: 'properties' });
  r.get('/list', g(list));
  r.get('/groups', g(listGroups));
  r.post('/groups', g(createGroup));
  r.delete('/groups/:id', g(deleteGroup));
  r.get('/people', g(people));
  r.get('/views', g(listViews));
  r.post('/views', g(createView));
  r.post('/views/preview', g(preview));
  r.get('/views/dataset', g(dataset));
  r.get('/views/:id', g(getView));
  r.put('/views/:id', g(updateView));
  r.delete('/views/:id', g(deleteView));
  r.post('/export', g(exportFile));
  r.get('/:id', g(property));
  r.get('/:id/monthly', g(monthly));
  r.get('/:id/optimized', g(optimized));
  r.get('/:id/fee', g(fee));
  r.get('/:id/rent-roll', g(rentRoll));
  r.get('/:id/buildings', g(buildings));
  r.get('/:id/capex', g(capex));
  return r;
}

module.exports = { propsRoutes, cleanAddr,
  data: { q, LIST_SQL, shapeProp, propRow, dataThrough, monthlyData, optimizedData, rentRollAgg, ymAdd, ymSpan, ymShort, ymLong, money },
  _internal: { nextSync, q, needsAttention, rentRollAgg, period, ymSpan, ymAdd, permissionFor, shapeProp, debtServiceOf } };
