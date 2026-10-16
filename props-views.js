// ===========================================================================
// props-views.js — the Custom view engine (PROPERTIES_SPEC section 4).
//
// A custom view stores a QUESTION: which properties (groups, minus per-view
// exclusions, or a hand-picked list), which fields, which cards and in what
// layout. The answer is computed here, fresh, every time it is read.
//
// The rules themselves (fields, periods, formulas, validation) live in
// public/props-views-core.js, which the browser loads too: the builder's
// preview runs that same code on data from GET /api/props/views/dataset, so
// typing in the builder never waits for a request and can never disagree
// with the saved view. This file adds only the database reads.
// ===========================================================================
'use strict';

const db = require('./supabase-db');
const core = require('./public/props-views-core');

const num = v => (v === null || v === undefined || v === '' ? null : Number(v));

async function through(tenantId) {
  const r = await db.q(`select to_char(max(period_end), 'YYYY-MM') m from public.t12_report where tenant_id = $1`, [tenantId]);
  return r.rows[0].m;
}

async function periodOptions(tenantId) {
  return core.periodOptionsFor(await through(tenantId));
}

/* every group in the tenant that a config names (a shared view can name its
   owner's groups), members in property-id order, as /api/props/groups returns */
async function groupsFor(gids, tenantId) {
  if (!gids.length) return [];
  const r = await db.q(`
    select g.id::text id, g.name, coalesce(array_agg(m.property_id::text order by m.property_id) filter (where m.property_id is not null), '{}') property_ids
      from public.property_group g left join public.property_group_member m on m.group_id = g.id
     where g.tenant_id = $1 and g.id = any($2::uuid[])
     group by g.id`, [tenantId, gids]);
  return r.rows;
}

const RR_SQL = `
  with l as (
    select u.*, coalesce(u.unit, u.unit_id::text) as ukey from public.rpt_rent_roll_unit u
     where u.tenant_id = $1 and ($2::uuid[] is null or u.property_id = any($2::uuid[])) and u.is_current and u.is_latest),
  per_unit as (
    select property_id, ukey, max(as_of_date) as_of,
      case when bool_or(occupancy_status = 'current') then 'current' when bool_or(occupancy_status = 'notice') then 'notice'
           when bool_or(occupancy_status = 'vacant_rented') then 'vacant_rented' else 'vacant_unrented' end as st,
      bool_or(occupancy_status = 'notice') has_notice,
      sum(rent) filter (where occupancy_status in ('current', 'notice')) rent, max(market_rent) mkt, sum(balance_due) bal,
      max(lease_end) filter (where occupancy_status in ('current', 'notice')) lease_end,
      bool_or(occupancy_status in ('current', 'notice') and (lease_end is null or lease_end < as_of_date)) mtm
    from l group by 1, 2)
  select property_id::text pid, count(*) units, count(*) filter (where st in ('current', 'notice')) occ,
    count(*) filter (where has_notice) notice, count(*) filter (where st = 'vacant_rented') vr,
    count(*) filter (where st = 'vacant_unrented') vu, sum(rent) rent,
    sum(mkt) filter (where st in ('current', 'notice')) mkt_occ, sum(mkt) mkt_all,
    sum(bal) filter (where bal > 0) delinq, count(*) filter (where bal > 0) delinq_n, -sum(bal) filter (where bal < 0) prepaid,
    count(*) filter (where st in ('current', 'notice') and lease_end > as_of and lease_end <= as_of + 90) exp90,
    count(*) filter (where mtm) mtm
  from per_unit group by 1`;

/* Plain (JSON-safe) data for a set of properties, or for every property in
   the tenant when ids is null. Read once per evaluation. */
async function loadPlain(ids, tenantId) {
  const t = await through(tenantId);
  if (ids && !ids.length) return { props: [], through: t };
  const idArg = ids || null;
  const ps = (await db.q(`
    select s.id::text id, coalesce(p.display_name, s.name) as name, s.units, s.latest_occupancy, s.t12_income, s.t12_expense, s.t12_noi,
           s.cash_flow_after_debt_and_capex, s.optimized_noi, s.annual_debt_service, s.annual_debt_service_paid,
           s.debt, s.value_on_file, s.pm_company, s.managing_entity_name, s.street, s.city, s.state, s.zip
      from public.rpt_property_summary s join public.property p on p.id = s.id
     where s.tenant_id = $1 and ($2::uuid[] is null or s.id = any($2::uuid[]))`, [tenantId, idArg])).rows;
  const from = core.ymAdd(t, -23);
  const pm = (await db.q(`
    select property_id::text pid, to_char(month, 'YYYY-MM') m, total_operating_income inc, total_operating_expense opx,
           noi, capex, debt_service ds, cash_flow cf
      from public.rpt_property_month
     where tenant_id = $1 and ($2::uuid[] is null or property_id = any($2::uuid[])) and has_data and lower(accounting_basis) = 'cash'
       and month >= $3::date`, [tenantId, idArg, from + '-01'])).rows;
  /* a fee row covering several properties is shared equally between them */
  const fees = (await db.q(`
    select l.property_id::text pid, to_char(f.fee_month, 'YYYY-MM') m,
           f.expected / n.n expected, f.received / n.n received, f.variance / n.n variance
      from public.rpt_am_fee_month f
      join public.am_fee_schedule_property l on l.schedule_id = f.schedule_id
      join (select schedule_id, count(*) n from public.am_fee_schedule_property group by 1) n on n.schedule_id = f.schedule_id
     where f.tenant_id = $1 and ($2::uuid[] is null or l.property_id = any($2::uuid[])) and f.fee_month >= $3::date`, [tenantId, idArg, from + '-01'])).rows;
  const rrs = (await db.q(RR_SQL, [tenantId, idArg])).rows;

  const series = {};
  const put = (pid, m, k, v) => { ((series[pid] = series[pid] || {})[m] = series[pid][m] || {})[k] = num(v); };
  for (const r of pm) for (const k of ['inc', 'opx', 'noi', 'capex', 'ds', 'cf']) put(r.pid, r.m, k, r[k]);
  for (const r of fees) { put(r.pid, r.m, 'amExp', r.expected); put(r.pid, r.m, 'amRec', r.received); put(r.pid, r.m, 'amVar', r.variance); }
  const rrBy = Object.fromEntries(rrs.map(r => [r.pid, [Number(r.units), Number(r.occ), Number(r.notice), Number(r.vr), Number(r.vu), num(r.rent),
    num(r.mkt_occ), num(r.mkt_all), num(r.delinq), Number(r.delinq_n), num(r.prepaid), Number(r.exp90), Number(r.mtm)]]));
  const { cleanAddr } = require('./props-api');

  const props = ps.map(s => {
    const paid = num(s.annual_debt_service_paid), rec = num(s.annual_debt_service);
    return {
      id: s.id, name: s.name, units: num(s.units), occ: num(s.latest_occupancy), inc: num(s.t12_income), opx: num(s.t12_expense),
      noi: num(s.t12_noi), cf: num(s.cash_flow_after_debt_and_capex), opt: null,
      ds: paid > 0 ? paid : rec > 0 ? rec : null, debt: num(s.debt), value: num(s.value_on_file),
      pm: s.pm_company, mgr: s.managing_entity_name,
      address: cleanAddr([s.street, s.city, [s.state, s.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ')),
      rr: rrBy[s.id] || null,
      series: series[s.id] || {},
    };
  });
  /* Optimized NOI (stabilized, else lender view) by the shared rule the tab uses */
  await require('./props-api').data.attachOptimized(tenantId, props, t);
  return { props, through: t };
}

/* period: the dates picked on screen (validated by the core), or null for the view's own */
async function evaluate(cfg, tenantId, period) {
  const sel = core.resolve(cfg, await groupsFor(cfg.groups, tenantId));
  return core.evaluateData(cfg, sel, await loadPlain(sel.ids, tenantId), period || null);
}

module.exports = { FIELDS: core.FIELDS, FIELD_LIST: core.FIELD_LIST, FIELD_GROUPS: core.FIELD_GROUPS,
                   validateConfig: core.validateConfig, evaluate, periodOptions, loadPlain,
                   _internal: { evalFormula: core.evalFormula, termVal: core.termVal, cleanPeriod: core.cleanPeriod, loadPlain, groupsFor } };
