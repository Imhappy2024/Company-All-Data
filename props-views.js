// ===========================================================================
// props-views.js — the Custom view engine (PROPERTIES_SPEC section 4).
//
// A custom view stores a QUESTION: which properties (groups, minus per-view
// exclusions, or a hand-picked list), which fields, which cards and in what
// layout. The answer is computed here, fresh, every time it is read.
//
// Nothing a user types is ever executed. The config is rebuilt from scratch
// against fixed lists on every save AND every read: a field key must be in
// FIELDS, an operator one of + - * /, a number a finite number, a period one
// of the shapes below. A formula is a list of terms, evaluated by a small
// precedence routine over numbers - there is no expression string, no eval,
// and no SQL built from anything in the config.
// ===========================================================================
'use strict';

const db = require('./supabase-db');

const YM = /^(\d{4})-(0[1-9]|1[0-2])$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const num = v => (v === null || v === undefined || v === '' ? null : Number(v));
const ymAdd = (ym, n) => { const m = YM.exec(ym); const k = Number(m[1]) * 12 + Number(m[2]) - 1 + n; return Math.floor(k / 12) + '-' + String((k % 12) + 1).padStart(2, '0'); };
const ymShort = ym => { const m = YM.exec(ym); return MN[Number(m[2]) - 1] + ' ' + m[1].slice(2); };
const ymSpan = (a, b) => { const o = []; let x = a; for (let i = 0; i < 36 && x <= b; i++) { o.push(x); x = ymAdd(x, 1); } return o; };
const sumA = a => { const f = a.filter(v => v !== null && v !== undefined && !Number.isNaN(v)); return f.length ? f.reduce((x, y) => x + y, 0) : null; };

/* ---------------------------------------------------------------------------
   The mockup's FIELDS list:
   [key, label, group, type, value(q), monthly series key or null, combine(ps) or null]
   `combine` is the group-total rule for a ratio: computed from the totals,
   never the sum or average of each property's ratio.
--------------------------------------------------------------------------- */
const rr = q => q.rr || null;
const FIELDS = [
  ['address', 'Address', 'Location', 'text', q => q.address || null],
  ['manager', 'Property manager', 'Management', 'text', q => q.pm || null],
  ['entity', 'Managing entity', 'Management', 'text', q => q.mgr || 'Not on file'],
  ['units', 'Units', 'Rent roll', 'count', q => q.units],
  ['occ', 'Occupancy', 'Rent roll', 'pct', q => (rr(q) && rr(q)[0] ? rr(q)[1] / rr(q)[0] : q.occ), null,
    ps => { const u = sumA(ps.map(q => (rr(q) ? rr(q)[0] : null))); const o = sumA(ps.map(q => (rr(q) ? rr(q)[1] : null))); return u ? o / u : null; }],
  ['vacant', 'Vacant units', 'Rent roll', 'count', q => (rr(q) ? rr(q)[3] + rr(q)[4] : null)],
  ['notice', 'On notice', 'Rent roll', 'count', q => (rr(q) ? rr(q)[2] : null)],
  ['rentRoll', 'Monthly rent', 'Rent roll', 'money', q => (rr(q) ? rr(q)[5] : null)],
  ['ltl', 'Loss to lease', 'Rent roll', 'money', q => (rr(q) && rr(q)[6] !== null && rr(q)[5] ? rr(q)[6] - rr(q)[5] : null)],
  ['delinq', 'Delinquency', 'Rent roll', 'money', q => (rr(q) ? rr(q)[8] || 0 : null)],
  ['prepaid', 'Prepaid rent', 'Rent roll', 'money', q => (rr(q) ? rr(q)[10] || 0 : null)],
  ['exp90', 'Leases expiring in 90 days', 'Rent roll', 'count', q => (rr(q) ? rr(q)[11] : null)],
  ['mtm', 'Month-to-month leases', 'Rent roll', 'count', q => (rr(q) ? rr(q)[12] : null)],
  ['avgRent', 'Average rent', 'Rent roll', 'money', q => (rr(q) && rr(q)[1] && rr(q)[5] ? rr(q)[5] / rr(q)[1] : null), null,
    ps => { const r = sumA(ps.map(q => (rr(q) ? rr(q)[5] : null))); const o = sumA(ps.map(q => (rr(q) && rr(q)[5] ? rr(q)[1] : null))); return o ? r / o : null; }],
  ['mktRent', 'Average market rent', 'Rent roll', 'money', q => (rr(q) && rr(q)[7] ? rr(q)[7] / rr(q)[0] : null), null,
    ps => { const m = sumA(ps.map(q => (rr(q) && rr(q)[7] ? rr(q)[7] : null))); const u = sumA(ps.map(q => (rr(q) && rr(q)[7] ? rr(q)[0] : null))); return u ? m / u : null; }],
  ['inc', 'Total operating income', 'Income and NOI', 'money', q => q.inc, 'inc'],
  ['opx', 'Total operating expense', 'Income and NOI', 'money', q => q.opx, 'opx'],
  ['noi', 'NOI', 'Income and NOI', 'money', q => q.noi, 'noi'],
  ['er', 'Expense ratio', 'Income and NOI', 'pct', q => (q.inc ? q.opx / q.inc : null), null,
    ps => { const i = sumA(ps.map(q => q.inc)); return i ? sumA(ps.map(q => q.opx)) / i : null; }],
  ['opt', 'Optimized NOI', 'Income and NOI', 'money', q => q.opt],
  ['capex', 'Capital expense', 'Expenses and capex', 'money', q => sumA(q.ttm('capex')), 'capex'],
  ['capexRatio', 'Capex ratio', 'Expenses and capex', 'pct', q => { const c = sumA(q.ttm('capex')); return q.inc && c !== null ? c / q.inc : null; }, null,
    ps => { const i = sumA(ps.map(q => q.inc)); return i ? sumA(ps.map(q => sumA(q.ttm('capex')))) / i : null; }],
  ['amExp', 'Asset management fee, expected', 'Asset management fee', 'money', q => sumA(q.ttm('amExp')), 'amExp'],
  ['amRec', 'Asset management fee, received', 'Asset management fee', 'money', q => sumA(q.ttm('amRec')), 'amRec'],
  ['amVar', 'Asset management fee, variance', 'Asset management fee', 'money', q => sumA(q.ttm('amVar')), 'amVar'],
  ['ds', 'Debt service', 'Debt and value', 'money', q => q.ds, 'ds'],
  ['dscr', 'DSCR', 'Debt and value', 'ratio', q => (q.ds && q.noi > 0 ? q.noi / q.ds : null), null,
    ps => { const pp = ps.filter(q => q.ds); const d = sumA(pp.map(q => q.ds)); return d ? sumA(pp.map(q => q.noi)) / d : null; }],
  ['cf', 'Cash flow after debt and capex', 'Debt and value', 'money', q => q.cf, 'cf'],
  ['debt', 'Debt', 'Debt and value', 'money', q => q.debt],
  ['value', 'Value on file', 'Debt and value', 'money', q => q.value],
];
const FMAP = Object.fromEntries(FIELDS.map(f => [f[0], f]));
const FIELD_LIST = FIELDS.map(f => ({ key: f[0], label: f[1], group: f[2], type: f[3], monthly: !!f[5] }));
const FIELD_GROUPS = ['Location', 'Rent roll', 'Income and NOI', 'Expenses and capex', 'Asset management fee', 'Debt and value', 'Management'];

/* ---------------------------------------------------------------------------
   Config validation: rebuilt from scratch, unknown keys dropped.
--------------------------------------------------------------------------- */
const str = (v, n) => String(v === null || v === undefined ? '' : v).slice(0, n);
const ID = /^[A-Za-z0-9_-]{1,40}$/;

function cleanPeriod(p) {
  if (!p || typeof p !== 'object') return { t: 'ttm' };
  if (p.t === 'ttm' || p.t === 'ytd') return { t: p.t };
  if (p.t === 'month' && YM.test(p.a)) return { t: 'month', a: p.a };
  if (p.t === 'range' && YM.test(p.a) && YM.test(p.b)) return { t: 'range', a: p.a <= p.b ? p.a : p.b, b: p.a <= p.b ? p.b : p.a };
  return { t: 'ttm' };
}
function cleanTerm(t, first) {
  const out = {};
  if (!first) out.op = ['+', '-', '*', '/'].indexOf(t && t.op) >= 0 ? t.op : '+';
  if (t && t.kind === 'num') { out.kind = 'num'; const n = Number(t.num); out.num = Number.isFinite(n) ? n : 0; return out; }
  out.kind = 'field';
  out.field = t && FMAP[t.field] && FMAP[t.field][3] !== 'text' ? t.field : 'inc';
  out.period = cleanPeriod(t && t.period);
  out.agg = t && t.agg === 'avg' ? 'avg' : 'total';
  return out;
}
function validateConfig(raw) {
  const c = raw && typeof raw === 'object' ? raw : {};
  const ids = a => (Array.isArray(a) ? a : []).map(String).filter(x => UUID.test(x)).slice(0, 500);
  const cfg = {
    mode: c.mode === 'quick' ? 'quick' : 'advanced',
    quickCards: !!c.quickCards,
    groups: [...new Set(ids(c.groups))].slice(0, 20),
    excl: (Array.isArray(c.excl) ? c.excl : []).map(String).filter(x => /^[0-9a-f-]{36}\|[0-9a-f-]{36}$/i.test(x)).slice(0, 500),
    props: c.props === null || c.props === undefined ? null : [...new Set(ids(c.props))],
    fields: (Array.isArray(c.fields) ? c.fields : []).filter(k => FMAP[k]).filter((k, i, a) => a.indexOf(k) === i).slice(0, 30),
    styles: (Array.isArray(c.styles) ? c.styles : []).filter(s => ['table', 'list', 'chart'].indexOf(s) >= 0).filter((k, i, a) => a.indexOf(k) === i),
    chartField: FMAP[c.chartField] && FMAP[c.chartField][3] !== 'text' ? c.chartField : 'inc',
    cards: [],
  };
  for (const k of (Array.isArray(c.cards) ? c.cards : []).slice(0, 24)) {
    if (!k || !ID.test(String(k.id || ''))) continue;
    const card = { id: String(k.id), label: str(k.label, 120), size: ['S', 'M', 'L'].indexOf(k.size) >= 0 ? k.size : 'M',
                   kind: k.kind === 'formula' ? 'formula' : 'value' };
    if (card.kind === 'formula') {
      card.fmt = ['money', 'number', 'pct', 'ratio'].indexOf(k.fmt) >= 0 ? k.fmt : 'money';
      card.terms = (Array.isArray(k.terms) ? k.terms : []).slice(0, 12).map((t, i) => cleanTerm(t, i === 0));
      if (!card.terms.length) card.terms = [cleanTerm(null, true)];
    } else {
      const t = cleanTerm(k, true);
      Object.assign(card, { field: t.field, period: t.period, agg: t.agg });
    }
    cfg.cards.push(card);
  }
  const want = cfg.cards.map(x => 'card:' + x.id).concat(cfg.styles);
  const kept = (Array.isArray(c.layout) ? c.layout : []).map(String).filter((k, i, a) => want.indexOf(k) >= 0 && a.indexOf(k) === i);
  cfg.layout = kept.concat(want.filter(k => kept.indexOf(k) < 0));
  return cfg;
}

/* ---------------------------------------------------------------------------
   Data for a set of properties, read once per evaluation.
--------------------------------------------------------------------------- */
async function through(tenantId) {
  const r = await db.q(`select to_char(max(month), 'YYYY-MM') m from reporting.property_month_mv where tenant_id = $1 and has_data`, [tenantId]);
  return r.rows[0].m;
}

async function periodOptions(tenantId) {
  const t = await through(tenantId);
  const months = ymSpan(ymAdd(t, -11), ymAdd(t, 3));
  return { through: t, ytdLabel: 'Jan to ' + MN[Number(t.slice(5)) - 1] + ' ' + t.slice(0, 4),
           months: months.map(m => ({ value: m, label: ymShort(m) })) };
}

async function resolveProperties(cfg, tenantId) {
  if (cfg.groups.length) {
    const r = await db.q(`
      select m.group_id::text gid, m.property_id::text pid, g.name
        from public.property_group_member m join public.property_group g on g.id = m.group_id
       where g.tenant_id = $1 and g.id = any($2::uuid[])`, [tenantId, cfg.groups]);
    const ex = new Set(cfg.excl);
    const out = [], names = {};
    for (const gid of cfg.groups) {
      for (const row of r.rows.filter(x => x.gid === gid)) {
        names[gid] = row.name;
        if (!ex.has(gid + '|' + row.pid) && out.indexOf(row.pid) < 0) out.push(row.pid);
      }
    }
    return { ids: out, groupNames: cfg.groups.map(g => names[g]).filter(Boolean) };
  }
  return { ids: cfg.props || [], groupNames: [] };
}

const RR_SQL = `
  with l as (
    select u.*, coalesce(u.unit, u.unit_id::text) as ukey from reporting.rent_roll_unit u
     where u.tenant_id = $1 and u.property_id = any($2::uuid[]) and u.is_current and u.is_latest),
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

async function loadData(ids, tenantId) {
  const t = await through(tenantId);
  if (!ids.length) return { props: [], through: t };
  const ps = (await db.q(`
    select s.id::text id, s.name, s.units, s.latest_occupancy, s.t12_income, s.t12_expense, s.t12_noi,
           s.cash_flow_after_debt_and_capex, s.optimized_noi, s.annual_debt_service, s.annual_debt_service_paid,
           s.debt, s.value_on_file, s.pm_company, s.managing_entity_name, s.street, s.city, s.state, s.zip
      from reporting.property_summary_mv s where s.tenant_id = $1 and s.id = any($2::uuid[])`, [tenantId, ids])).rows;
  const from = ymAdd(t, -23);
  const pm = (await db.q(`
    select property_id::text pid, to_char(month, 'YYYY-MM') m, total_operating_income inc, total_operating_expense opx,
           noi, capex, debt_service ds, cash_flow cf
      from reporting.property_month_mv
     where tenant_id = $1 and property_id = any($2::uuid[]) and has_data and lower(accounting_basis) = 'cash'
       and month >= $3::date`, [tenantId, ids, from + '-01'])).rows;
  /* a fee row covering several properties is shared equally between them */
  const fees = (await db.q(`
    select l.property_id::text pid, to_char(f.fee_month, 'YYYY-MM') m,
           f.expected / n.n expected, f.received / n.n received, f.variance / n.n variance
      from reporting.am_fee_month f
      join public.am_fee_schedule_property l on l.schedule_id = f.schedule_id
      join (select schedule_id, count(*) n from public.am_fee_schedule_property group by 1) n on n.schedule_id = f.schedule_id
     where f.tenant_id = $1 and l.property_id = any($2::uuid[]) and f.fee_month >= $3::date`, [tenantId, ids, from + '-01'])).rows;
  const rrs = (await db.q(RR_SQL, [tenantId, ids])).rows;

  const series = {};
  const put = (pid, m, k, v) => { ((series[pid] = series[pid] || {})[m] = series[pid][m] || {})[k] = num(v); };
  for (const r of pm) for (const k of ['inc', 'opx', 'noi', 'capex', 'ds', 'cf']) put(r.pid, r.m, k, r[k]);
  for (const r of fees) { put(r.pid, r.m, 'amExp', r.expected); put(r.pid, r.m, 'amRec', r.received); put(r.pid, r.m, 'amVar', r.variance); }
  const rrBy = Object.fromEntries(rrs.map(r => [r.pid, [Number(r.units), Number(r.occ), Number(r.notice), Number(r.vr), Number(r.vu), num(r.rent),
    num(r.mkt_occ), num(r.mkt_all), num(r.delinq), Number(r.delinq_n), num(r.prepaid), Number(r.exp90), Number(r.mtm)]]));
  const ttmMonths = ymSpan(ymAdd(t, -11), t);
  const order = Object.fromEntries(ids.map((id, i) => [id, i]));

  const props = ps.map(s => {
    const paid = num(s.annual_debt_service_paid), rec = num(s.annual_debt_service);
    const q = {
      id: s.id, name: s.name, units: num(s.units), occ: num(s.latest_occupancy), inc: num(s.t12_income), opx: num(s.t12_expense),
      noi: num(s.t12_noi), cf: num(s.cash_flow_after_debt_and_capex), opt: num(s.optimized_noi),
      ds: paid > 0 ? paid : rec > 0 ? rec : null, debt: num(s.debt), value: num(s.value_on_file),
      pm: s.pm_company, mgr: s.managing_entity_name,
      address: require('./props-api').cleanAddr([s.street, s.city, [s.state, s.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ')),
      rr: rrBy[s.id] || null,
      month: (m, k) => (series[s.id] && series[s.id][m] && k in series[s.id][m] ? series[s.id][m][k] : null),
    };
    q.ttm = k => ttmMonths.map(m => q.month(m, k));
    return q;
  }).sort((a, b) => order[a.id] - order[b.id]);
  return { props, through: t };
}

/* ---------------------------------------------------------------------------
   Evaluation: the mockup's propVal / termVal / evalFormula, unchanged in
   meaning.
--------------------------------------------------------------------------- */
function monthsOf(pd, t) {
  if (pd.t === 'ytd') return ymSpan(t.slice(0, 4) + '-01', t);
  if (pd.t === 'month') return [pd.a];
  if (pd.t === 'range') return ymSpan(pd.a, pd.b);
  return null;
}
function periodText(pd, t) {
  if (pd.t === 'ttm') return 'trailing 12 months';
  if (pd.t === 'ytd') return 'Jan to ' + MN[Number(t.slice(5)) - 1] + ' ' + t.slice(0, 4);
  if (pd.t === 'month') return ymShort(pd.a);
  return ymShort(pd.a) + ' to ' + ymShort(pd.b);
}
function propVal(f, q, pd, t) {
  if (!f[5] || !pd || pd.t === 'ttm') return f[4](q);
  const ms = monthsOf(pd, t);
  /* a month after the latest data is not loaded yet: say so with "–" rather
     than total what is there */
  if (ms.some(m => m > t)) return null;
  return sumA(ms.map(m => q.month(m, f[5])));
}
function termVal(ps, tm, t) {
  const f = FMAP[tm.field]; if (!f) return null;
  if (f[6] && (!f[5] || !tm.period || tm.period.t === 'ttm')) return f[6](ps);
  const vals = ps.map(q => propVal(f, q, f[5] ? tm.period : null, t)).filter(v => v !== null && v !== undefined && !Number.isNaN(v));
  if (!vals.length) return null;
  if (f[3] === 'pct' || f[3] === 'ratio' || tm.agg === 'avg') return vals.reduce((a, b) => a + b, 0) / vals.length;
  return vals.reduce((a, b) => a + b, 0);
}
function termText(tm, t) {
  const f = FMAP[tm.field]; if (!f) return '?';
  return f[1] + (f[5] ? ', ' + periodText(tm.period || { t: 'ttm' }, t) : '') + (tm.agg === 'avg' && f[3] !== 'pct' && f[3] !== 'ratio' ? ' (average)' : '');
}
/* standard precedence over a flat list: × and ÷ bind first, then + and −,
   left to right. Division by zero is no answer, not infinity. */
function evalFormula(ps, terms, t) {
  const vals = terms.map(tm => (tm.kind === 'num' ? tm.num : termVal(ps, tm, t)));
  if (vals.some(v => v === null || v === undefined || Number.isNaN(v))) return null;
  const st = [vals[0]], ops = [];
  for (let i = 1; i < terms.length; i++) {
    const op = terms[i].op;
    if (op === '*' || op === '/') {
      const a = st.pop();
      if (op === '/' && vals[i] === 0) return null;
      st.push(op === '*' ? a * vals[i] : a / vals[i]);
    } else { ops.push(op); st.push(vals[i]); }
  }
  let r = st[0];
  ops.forEach((op, i) => { r = op === '-' ? r - st[i + 1] : r + st[i + 1]; });
  return Number.isFinite(r) ? r : null;
}
const OPN = { '+': '+', '-': '−', '*': '×', '/': '÷' };
const formulaText = (terms, t) => terms.map((tm, i) => (i ? OPN[tm.op] + ' ' : '') + (tm.kind === 'num' ? String(tm.num) : termText(tm, t))).join(' ');

function cardResult(ps, c, t) {
  if (c.kind === 'formula') return { value: evalFormula(ps, c.terms, t), type: c.fmt, sub: formulaText(c.terms, t) };
  const f = FMAP[c.field];
  return { value: termVal(ps, c, t), type: f[3],
           sub: termText(c, t) + (f[3] === 'pct' || f[3] === 'ratio' || f[6] ? '' : c.agg === 'avg' ? '' : ', total') };
}

async function evaluate(cfg, tenantId) {
  const sel = await resolveProperties(cfg, tenantId);
  const { props: ps, through: t } = await loadData(sel.ids, tenantId);
  const fs = cfg.fields.map(k => FMAP[k]);
  const numF = fs.filter(f => f[3] !== 'text');
  const cf = FMAP[cfg.chartField] || numF[0] || FMAP.inc;
  return {
    through: t,
    count: ps.length, groupNames: sel.groupNames, excluded: cfg.excl.length,
    properties: ps.map(q => ({ id: q.id, name: q.name, address: q.address, mgr: q.mgr })),
    cards: cfg.cards.map(c => Object.assign({ id: c.id }, cardResult(ps, c, t))),
    heads: fs.map(f => ({ key: f[0], label: f[1], type: f[3] })),
    rows: ps.map(q => ({ id: q.id, name: q.name, mgr: q.mgr, cells: fs.map(f => f[4](q)) })),
    totals: fs.map(f => (f[3] === 'text' ? null : termVal(ps, { field: f[0], period: { t: 'ttm' }, agg: 'total' }, t))),
    list: ps.map(q => ({ id: q.id, name: q.name, address: q.address, kv: numF.map(f => ({ k: f[1], type: f[3], v: f[4](q) })) })),
    chart: { title: cf[1] + ' by property', type: cf[3],
             bars: ps.map(q => ({ id: q.id, name: q.name, v: cf[4](q) })).filter(b => b.v !== null && b.v !== undefined).sort((a, b) => b.v - a.v) },
  };
}

module.exports = { FIELDS, FIELD_LIST, FIELD_GROUPS, validateConfig, evaluate, periodOptions,
                   _internal: { evalFormula, termVal, cleanPeriod, loadData, resolveProperties } };
