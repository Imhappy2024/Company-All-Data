// ===========================================================================
// reporting-api.js — the curated-dataset read API (Phase 2.9).
//
//   GET /api/portfolio/summary?entity=<id>
//   GET /api/portfolio/:id/monthly?year=YYYY
//   GET /api/portfolio/:id/income-statement?end=YYYY-MM
//   GET /api/portfolio/:id/noi-analysis
//   GET /api/am-fees?year=YYYY[&entity=<id>]
//
// Everything reads from the `reporting` views, never from t12_monthly or
// rent_roll_line directly. That is the whole point of Phase 1: the data rules
// live in one place and no screen can disagree with another about them.
//
// READ-ONLY, enforced twice, exactly as financials-api.js argues for:
//   1. the router refuses any method that is not GET or HEAD (405), and
//   2. every SQL string is checked for a write verb before it reaches the
//      pool.
// The second is not paranoia. supabase-db connects with SUPABASE_DB_URL,
// which is the postgres SUPERUSER, so a stray write would simply succeed.
//
// TENANT SCOPING IS THIS MODULE'S JOB for the same reason: RLS never runs on
// that connection, so every statement filters tenant_id explicitly from the
// verified identity, never from anything the caller sent.
// ===========================================================================
'use strict';

const express = require('express');
const db = require('./supabase-db');
const { guard } = require('./portal-identity');
const N = require('./noi-analysis');

const WRITE_VERB = /\b(insert|update|delete|truncate|drop|alter|create|grant|revoke|copy)\b/i;

async function q(sql, params) {
  if (WRITE_VERB.test(sql)) {
    throw new Error('reporting-api issued a non-read statement; refused before it reached the pool.');
  }
  const r = await db.q(sql, params);
  return r.rows;
}

/* Reads go to the MATERIALISED copies. reporting.property_summary is four
   passes over the monthly spine plus the six-month windows - 1.1s in Postgres
   for the 170 rows this section opens on. The data behind it arrives in batch
   syncs (a T12 export, a rent roll import) rather than continuously, so a
   refresh-bounded read matches how it actually changes rather than trading
   correctness for speed.

   Refresh after a sync:  node tools/refresh-reporting.js
   or in SQL:             select reporting.refresh_reporting(); */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuidOrNull = v => (typeof v === 'string' && UUID.test(v.trim()) ? v.trim() : null);

/* A year is four digits in a sane range, or the current one. A caller-supplied
   year reaches a date literal, so it is never interpolated unchecked. */
function yearOf(v) {
  const n = Number(v);
  if (Number.isInteger(n) && n >= 2000 && n <= 2100) return n;
  return new Date().getUTCFullYear();
}

function monthKey(d) {
  // d is a pg DATE -> a Date at LOCAL midnight. Read the local parts; never
  // toISOString, which shifts the month back for any reader east of UTC.
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
}

const num = v => (v === null || v === undefined ? null : Number(v));

/* ---------------------------------------------------------------------------
   The property list, with the roll-up the Company and Entity pages show.
--------------------------------------------------------------------------- */
async function summary(req, res, who) {
  const entity = uuidOrNull(req.query.entity);
  /* `managing` is the drill-down level: a MANAGING entity, or the literal
     'none' for the 35 held properties with no manager on file. Those are a
     real group - a gap to close - so they get a page rather than being
     unreachable. */
  const managingRaw = String(req.query.managing || '');
  const managingNone = managingRaw === 'none';
  const managing = managingNone ? null : uuidOrNull(managingRaw);
  const byManaging = managingNone || !!managing;

  const rows = await q(
    `select s.*
       from reporting.property_summary_mv s
      where s.tenant_id = $1
        and ($2::uuid is null or s.entity_id = $2::uuid)
        and (not $3::boolean
             or ($4::uuid is null and s.managing_entity_id is null)
             or s.managing_entity_id = $4::uuid)
      order by s.t12_noi desc nulls last, s.name`,
    [who.tenantId, entity, byManaging, managing]
  );

  /* the Phase 2 screens read t12_net_income; the column is now
     cash_flow_after_debt_and_capex */
  for (const r of rows) r.t12_net_income = r.cash_flow_after_debt_and_capex;
  const held = rows.filter(r => r.ownership_status === 'held');
  const sum = (list, k) => {
    const vals = list.map(r => num(r[k])).filter(v => v !== null);
    return vals.length ? vals.reduce((a, b) => a + b, 0) : null;
  };
  /* The roll-up counts each property ONCE. CLAUDE.md records co-ownership
     otherwise counting one property per owner, $124M against a real $31M;
     property_summary is already one row per property, and this stays a
     deliberate note so nobody reintroduces a join that breaks it. */
  const totals = {
    properties: held.length,
    units: sum(held, 'units'),
    t12_income: sum(held, 't12_income'),
    t12_expense: sum(held, 't12_expense'),
    t12_noi: sum(held, 't12_noi'),
    t12_net_income: sum(held, 't12_net_income'),
    optimized_noi: sum(held, 'optimized_noi'),
    debt: sum(held, 'debt'),
    annual_debt_service: sum(held, 'annual_debt_service'),
  };
  totals.expense_ratio = totals.t12_income > 0 ? totals.t12_expense / totals.t12_income : null;
  totals.dscr = totals.annual_debt_service > 0 ? totals.t12_noi / totals.annual_debt_service : null;

  res.json({ ok: true, entity, managing: managingRaw || null, rows, totals, generatedAt: new Date().toISOString() });
}

/* ---------------------------------------------------------------------------
   Level 1: one row per MANAGING entity.

   Not one per legal entity. `property.entity_id` is the owner LLC and there
   are 130 of those; `entity.manager_entity_id` groups them into 17 managing
   entities, which is the level the portfolio actually drills through.

   35 held properties have no managing entity on file. They are bucketed under
   a null id rather than dropped: a property with no manager recorded is a gap
   to close, not a property to hide from the navigation.
--------------------------------------------------------------------------- */
async function entities(req, res, who) {
  const rows = await q(
    `select s.managing_entity_id, s.managing_entity_name,
            count(*)                        as properties,
            sum(s.units)                    as units,
            sum(s.t12_noi)                  as t12_noi,
            sum(s.optimized_noi)            as optimized_noi,
            sum(s.cash_flow_after_debt_and_capex) as t12_net_income,
            sum(s.value_on_file)            as value_on_file,
            sum(s.debt)                     as debt,
            sum(s.t12_debt_service)         as t12_debt_service,
            sum(s.t12_other_interest)       as t12_other_interest,
            count(*) filter (where s.trailing_dscr_mortgage < 1)  as flag_dscr,
            count(*) filter (where s.latest_occupancy < 0.85)     as flag_occ,
            count(*) filter (where s.t12_noi < 0)                 as flag_noi,
            count(*) filter (where s.next_maturity < current_date + interval '12 months') as flag_maturity,
            count(*) filter (where not s.t12_in_dropbox)          as flag_no_t12,
            mode() within group (order by s.city)                 as main_city,
            bool_or(s.t12_other_interest > 0)                     as any_other_debt
       from reporting.property_summary_mv s
      where s.tenant_id = $1 and s.ownership_status = 'held'
      group by 1, 2
      order by sum(s.t12_noi) desc nulls last`,
    [who.tenantId]
  );

  const out = rows.map(r => {
    const ds = num(r.t12_debt_service);
    const oi = num(r.t12_other_interest) || 0;
    return Object.assign({}, r, {
      ltv: num(r.value_on_file) > 0 ? num(r.debt) / num(r.value_on_file) : null,
      dscr_mortgage: ds > 0 ? num(r.t12_noi) / ds : null,
      dscr_all_debt: (ds || 0) + oi > 0 ? num(r.t12_noi) / ((ds || 0) + oi) : null,
      flags: Number(r.flag_dscr) + Number(r.flag_occ) + Number(r.flag_noi) +
             Number(r.flag_maturity) + Number(r.flag_no_t12),
    });
  });

  const sum = k => {
    const v = out.map(r => num(r[k])).filter(x => x !== null);
    return v.length ? v.reduce((a, b) => a + b, 0) : null;
  };
  const totalDs = sum('t12_debt_service');
  res.json({
    ok: true,
    rows: out,
    anyOtherDebt: out.some(r => r.any_other_debt),
    totals: {
      entities: out.length,
      properties: sum('properties'), units: sum('units'),
      t12_noi: sum('t12_noi'), optimized_noi: sum('optimized_noi'),
      t12_net_income: sum('t12_net_income'),
      value_on_file: sum('value_on_file'), debt: sum('debt'),
      ltv: sum('value_on_file') > 0 ? sum('debt') / sum('value_on_file') : null,
      dscr_mortgage: totalDs > 0 ? sum('t12_noi') / totalDs : null,
      flags: out.reduce((a, r) => a + r.flags, 0),
    },
  });
}

/* ---------------------------------------------------------------------------
   D1 Overview: what needs attention, and the record itself.

   A flag is a SENTENCE naming the thing and its date, not a coloured dot.
   "Loan from Lincoln Savings matured 2026-03-01" can be acted on; a red
   square cannot.
--------------------------------------------------------------------------- */
async function overview(req, res, who) {
  const id = uuidOrNull(req.params.id);
  if (!id) return res.status(400).json({ error: 'A property id is required.' });

  const s = (await q(
    `select * from reporting.property_summary_mv where tenant_id = $1 and id = $2::uuid`,
    [who.tenantId, id]))[0];
  if (!s) return res.status(404).json({ error: 'No such property.' });

  const loans = await q(
    `select l.lender, l.latest_balance, l.balance_as_of, l.maturity_date,
            l.interest_rate_pct, l.annual_debt_service, l.status, l.purpose
       from reporting.loan l where l.tenant_id = $1 and l.property_id = $2::uuid
      order by l.maturity_date nulls last`, [who.tenantId, id]);

  let ins = [];
  try {
    ins = await q(
      `select carrier, policy_type, effective_date, expiration_date
         from public.insurance_policy
        where tenant_id = $1 and property_id = $2::uuid
        order by expiration_date nulls last limit 12`, [who.tenantId, id]);
  } catch (e) { ins = []; }

  const flags = [];
  const today = new Date();
  const within = (d, months) => {
    if (!d) return false;
    const lim = new Date(today); lim.setMonth(lim.getMonth() + months);
    return new Date(d) <= lim;
  };
  /* pg returns a DATE as a JS Date at LOCAL midnight, and String() of that is
     "Wed Sep 30 2026 00:00:00 GMT...", so slicing it printed "Wed Sep 30" in
     a flag. Read the local parts - never toISOString(), which shifts the day
     back for any reader east of UTC - and write the date the way the rest of
     the screen does. */
  const MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const day = d => {
    if (!d) return '';
    if (d instanceof Date) return d.getDate() + ' ' + MON[d.getMonth()] + ' ' + d.getFullYear();
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(d));
    return m ? Number(m[3]) + ' ' + MON[Number(m[2]) - 1] + ' ' + m[1] : String(d);
  };

  for (const l of loans) {
    if (l.maturity_date && new Date(l.maturity_date) < today) {
      flags.push({ kind: 'maturity', level: 'bad',
        text: 'Loan from ' + (l.lender || 'an unnamed lender') + ' matured ' + day(l.maturity_date) + '.' });
    } else if (within(l.maturity_date, 12)) {
      flags.push({ kind: 'maturity', level: 'warn',
        text: 'Loan from ' + (l.lender || 'an unnamed lender') + ' matures ' + day(l.maturity_date) + '.' });
    }
  }

  const dscr = num(s.trailing_dscr_mortgage) !== null ? num(s.trailing_dscr_mortgage) : num(s.trailing_dscr);
  if (dscr !== null && dscr < 1) {
    flags.push({ kind: 'dscr', level: 'bad', text: 'DSCR is below 1.00 (' + dscr.toFixed(2) + ').' });
  } else if (dscr !== null && dscr < 1.25) {
    flags.push({ kind: 'dscr', level: 'warn', text: 'DSCR is below 1.25 (' + dscr.toFixed(2) + ').' });
  }
  const allDebt = num(s.trailing_dscr_all_debt);
  if (allDebt !== null && allDebt < 1 && (dscr === null || dscr >= 1)) {
    flags.push({ kind: 'dscr', level: 'bad',
      text: 'Coverage falls below 1.00 once other debt is counted (' + allDebt.toFixed(2) + ').' });
  }

  const occ = num(s.latest_occupancy);
  if (occ !== null && occ < 0.85) {
    flags.push({ kind: 'vacancy', level: 'bad', text: 'Occupancy is ' + (occ * 100).toFixed(1) + '%.' });
  } else if (occ !== null && occ <= 0.90) {
    flags.push({ kind: 'vacancy', level: 'warn', text: 'Occupancy is ' + (occ * 100).toFixed(1) + '%.' });
  }

  if (num(s.t12_noi) !== null && num(s.t12_noi) < 0) {
    flags.push({ kind: 'noi', level: 'bad', text: 'NOI over the trailing 12 months is negative.' });
  }

  const delinq = (await q(
    `select pm.delinquency, pm.rent_roll_as_of from reporting.property_month_mv pm
      where pm.tenant_id = $1 and pm.property_id = $2::uuid and pm.delinquency is not null
      order by pm.month desc limit 1`, [who.tenantId, id]))[0];
  if (delinq && Number(delinq.delinquency) > 0) {
    flags.push({ kind: 'receivables', level: 'warn',
      text: 'Receivables of $' + Number(delinq.delinquency).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) +
            ' on the rent roll of ' + day(delinq.rent_roll_as_of) + '.' });
  }

  for (const i of ins) {
    if (i.expiration_date && new Date(i.expiration_date) < today) {
      flags.push({ kind: 'insurance', level: 'bad',
        text: (i.policy_type || 'A policy') + ' from ' + (i.carrier || 'an unnamed carrier') + ' expired ' + day(i.expiration_date) + '.' });
    } else if (within(i.expiration_date, 2)) {
      flags.push({ kind: 'insurance', level: 'warn',
        text: (i.policy_type || 'A policy') + ' from ' + (i.carrier || 'an unnamed carrier') + ' expires ' + day(i.expiration_date) + '.' });
    }
  }

  if (!s.t12_in_dropbox) {
    flags.push({ kind: 'reports', level: 'warn', text: 'No T12 is filed in Dropbox for this property.' });
  }

  res.json({ ok: true, property: s, flags, loans, insurance: ins });
}

/* D11 Documents. The T12 and rent roll files sort first, because those are
   the two anyone opens this tab looking for. */
async function documents(req, res, who) {
  const id = uuidOrNull(req.params.id);
  if (!id) return res.status(400).json({ error: 'A property id is required.' });
  const rows = await q(
    `with kind as (
       select d.id,
              case when exists (select 1 from public.t12_report r where r.document_id = d.id) then 'T12'
                   when exists (select 1 from public.rent_roll_report r where r.document_id = d.id) then 'Rent roll'
              end as report_kind
         from public.document d
        where d.tenant_id = $1 and d.property_id = $2::uuid
     )
     select d.id, d.file_name, d.storage_path, d.file_extension,
            d.file_size_bytes, d.created_at, k.report_kind
       from public.document d
       join kind k on k.id = d.id
      where d.tenant_id = $1 and d.property_id = $2::uuid
      order by case k.report_kind when 'T12' then 0 when 'Rent roll' then 1 else 2 end,
               d.created_at desc
      limit 300`,
    [who.tenantId, id]
  );
  res.json({ ok: true, documents: rows });
}

/* ---------------------------------------------------------------------------
   One property, twelve months. The Monthly financials sheet.
--------------------------------------------------------------------------- */
async function monthly(req, res, who) {
  const id = uuidOrNull(req.params.id);
  if (!id) return res.status(400).json({ error: 'A property id is required.' });
  const year = yearOf(req.query.year);

  const rows = await q(
    `select pm.*
       from reporting.property_month_mv pm
      where pm.tenant_id = $1 and pm.property_id = $2::uuid
        and lower(pm.accounting_basis) = 'cash'
        and pm.month >= make_date($3, 1, 1) and pm.month < make_date($3 + 1, 1, 1)
      order by pm.month`,
    [who.tenantId, id, year]
  );

  const prop = (await q(
    `select s.* from reporting.property_summary_mv s
      where s.tenant_id = $1 and s.id = $2::uuid`,
    [who.tenantId, id]
  ))[0] || null;
  if (!prop) return res.status(404).json({ error: 'No such property.' });

  /* Which years have anything at all, so the selector offers only those. A
     year rendered as twelve dashes states nothing. */
  const years = (await q(
    `select distinct extract(year from pm.month)::int as y
       from reporting.property_month_mv pm
      where pm.tenant_id = $1 and pm.property_id = $2::uuid and pm.has_data
      order by 1`,
    [who.tenantId, id]
  )).map(r => r.y);

  const byMonth = {};
  for (const r of rows) byMonth[monthKey(r.month)] = r;

  res.json({
    ok: true, year, years, property: prop,
    months: rows.map(r => Object.assign({}, r, { month: monthKey(r.month) })),
    byMonth: Object.keys(byMonth).reduce((o, k) => {
      o[k] = Object.assign({}, byMonth[k], { month: k }); return o;
    }, {}),
    /* the note the screen prints under the title */
    basis: 'Cash',
    debtServiceSource: rows.length ? rows[0].debt_service_source : null,
  });
}

/* ---------------------------------------------------------------------------
   Account-by-account income statement, twelve months back from `end`.
--------------------------------------------------------------------------- */
async function incomeStatement(req, res, who) {
  const id = uuidOrNull(req.params.id);
  if (!id) return res.status(400).json({ error: 'A property id is required.' });

  const m = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(String(req.query.end || ''));
  const endSql = m
    ? `make_date(${Number(m[1])}, ${Number(m[2])}, 1)`
    : `(select max(month) from reporting.income_statement_line
         where tenant_id = $1 and property_id = $2::uuid)`;

  const rows = await q(
    `with bounds as (select ${endSql} as e)
     select l.section, l.account_path, l.depth, l.line_label, l.is_total,
            l.sort_order, l.month, l.amount
       from reporting.income_statement_line l, bounds b
      where l.tenant_id = $1 and l.property_id = $2::uuid
        and lower(l.accounting_basis) = 'cash'
        and l.month > (b.e - interval '12 months') and l.month <= b.e
      order by l.section, l.sort_order, l.depth, l.line_label, l.month`,
    [who.tenantId, id]
  );

  /* Pivot in the server: one row per account, months across. The browser
     should not have to know the account tree to lay out a table. */
  const months = [...new Set(rows.map(r => monthKey(r.month)))].sort();
  const keyOf = r => r.section + '\u0000' + (r.account_path || []).join(' > ') + '\u0000' + r.line_label;
  const lines = new Map();
  for (const r of rows) {
    const k = keyOf(r);
    if (!lines.has(k)) {
      lines.set(k, {
        section: r.section, account_path: r.account_path, depth: r.depth,
        line_label: r.line_label, is_total: r.is_total, sort_order: r.sort_order,
        values: {}, total: 0,
      });
    }
    const line = lines.get(k);
    const v = num(r.amount);
    line.values[monthKey(r.month)] = v;
    if (v !== null) line.total += v;
  }

  res.json({
    ok: true, months, end: months[months.length - 1] || null,
    lines: [...lines.values()],
  });
}

/* ---------------------------------------------------------------------------
   Monthly NOI, the best windows, and the scenarios at DEFAULT assumptions.
   The what-if maths runs in the browser against noi-analysis.js; this returns
   the standard values so the screen has something before anyone touches a
   control.
--------------------------------------------------------------------------- */
async function noiAnalysis(req, res, who) {
  const id = uuidOrNull(req.params.id);
  if (!id) return res.status(400).json({ error: 'A property id is required.' });

  const rows = await q(
    `select pm.month, pm.total_operating_income, pm.total_operating_expense,
            pm.noi, pm.debt_service, pm.debt_service_source,
            pm.recurring_other_interest, pm.other_interest_is_debt_service
       from reporting.property_month_mv pm
      where pm.tenant_id = $1 and pm.property_id = $2::uuid
        and lower(pm.accounting_basis) = 'cash' and pm.has_data
      order by pm.month desc
      limit 12`,
    [who.tenantId, id]
  );
  rows.reverse();

  const series = rows.map(r => ({
    month: monthKey(r.month),
    income: num(r.total_operating_income),
    expense: num(r.total_operating_expense),
    noi: num(r.noi),
    debt_service: num(r.debt_service),
    recurring_other_interest: num(r.recurring_other_interest),
  }));

  const loans = await q(
    `select l.loan_id, l.lender, l.latest_balance, l.balance_as_of,
            l.interest_rate_pct, l.maturity_date, l.annual_debt_service, l.status
       from reporting.loan l
      where l.tenant_id = $1 and l.property_id = $2::uuid
      order by l.maturity_date nulls last`,
    [who.tenantId, id]
  );

  const balance = loans.reduce((a, l) => a + (num(l.latest_balance) || 0), 0) || null;
  /* debt service only when EVERY loan states one, or a partial total is
     presented as whole. */
  const allHaveDs = loans.length > 0 && loans.every(l => l.annual_debt_service !== null);
  const annualDebtService = allHaveDs
    ? loans.reduce((a, l) => a + Number(l.annual_debt_service), 0) : null;

  const trailing = series.map(s => s.noi).filter(v => v !== null)
    .reduce((a, b) => a + b, 0) || null;
  const best1 = N.bestWindow(series, 1);
  const best3 = N.bestWindow(series, 3);
  const optimized = N.optimizedNoi(series);

  res.json({
    ok: true,
    series,
    loans,
    other_interest_counted: rows.some(r => r.other_interest_is_debt_service),
    facts: {
      balance,
      annual_debt_service: annualDebtService,
      debt_service_on_file: allHaveDs,
      interest_rate_pct: loans.length ? num(loans[0].interest_rate_pct) : null,
      maturity_date: loans.length ? loans[0].maturity_date : null,
      debt_service_source: rows.length ? rows[rows.length - 1].debt_service_source : null,
      /* What the BOOKS say, which is a different question from what the loan
         record says. A property can have a full debt service in its income
         statement and no annual figure on its loan - Cedar Haven is exactly
         that - and a screen that only reads the loan record tells it there is
         no debt service on file. */
      books_annual_debt_service: series.reduce(
        (a, x) => a + (x.debt_service === null ? 0 : x.debt_service), 0) || null,
      books_months: series.filter(x => x.debt_service !== null).length,
    },
    windows: {
      best1: best1 ? { total: best1.total, from: best1.from, to: best1.to, annual: best1.total * 12 } : null,
      best3: best3 ? { total: best3.total, from: best3.from, to: best3.to, annual: best3.total * 4 } : null,
      best6: optimized ? { annual: optimized.annual, from: optimized.from, to: optimized.to } : null,
    },
    trailing_noi: trailing,
    optimized_noi: optimized ? optimized.annual : null,
    /* the defaults the screen opens on; every one of them is overridable in
       the browser and none of it is ever saved */
    defaults: { capRatePct: 7, requiredDscr: 1.25, newRatePct: 6.5, amortYears: 30 },
  });
}

/* ---------------------------------------------------------------------------
   The latest rent roll for one property, plus its summary line.
--------------------------------------------------------------------------- */
async function rentRoll(req, res, who) {
  const id = uuidOrNull(req.params.id);
  if (!id) return res.status(400).json({ error: 'A property id is required.' });

  /* A4: every rent roll on file can be read, newest by default. Dates go
     out as text so no timezone can move them a day. */
  const dates = (await q(
    `select distinct to_char(u.as_of_date, 'YYYY-MM-DD') as d
       from reporting.rent_roll_unit u
      where u.tenant_id = $1 and u.property_id = $2::uuid
      order by 1 desc`,
    [who.tenantId, id]
  )).map(r => r.d);
  const asked = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.as_of || '')) ? String(req.query.as_of) : null;
  const asOf = asked && dates.indexOf(asked) >= 0 ? asked : null;

  const units = await q(
    `select u.unit, u.beds, u.baths, u.tenant, u.status, u.rent, u.market_rent,
            u.balance_due, u.lease_start, u.lease_end, u.square_feet, u.as_of_date
       from reporting.rent_roll_unit u
      where u.tenant_id = $1 and u.property_id = $2::uuid
        and (case when $3::date is null then u.is_latest else u.as_of_date = $3::date end)
        and u.is_current
      order by u.sort_order nulls last, u.unit`,
    [who.tenantId, id, asOf]
  );

  /* the summary comes from property_month so the figures on this tab cannot
     disagree with the ones on Monthly financials */
  const s = (await q(
    `select pm.rent_roll_as_of as as_of_date, pm.units, pm.occupied, pm.vacant,
            pm.market_rent_total, pm.rent_total, pm.loss_to_lease, pm.delinquency
       from reporting.property_month_mv pm
      where pm.tenant_id = $1 and pm.property_id = $2::uuid
        and pm.rent_roll_as_of is not null
        and ($3::date is null or pm.rent_roll_as_of = $3::date)
      order by pm.month desc limit 1`,
    [who.tenantId, id, asOf]
  ))[0] || null;

  res.json({ ok: true, units, rentSummary: s, asOfDates: dates, asOf: asOf || dates[0] || null });
}

/* ---------------------------------------------------------------------------
   The asset management fee tracker.
--------------------------------------------------------------------------- */
async function amFees(req, res, who) {
  const year = yearOf(req.query.year);
  const entity = uuidOrNull(req.query.entity);
  const managing = uuidOrNull(req.query.managing);

  const rows = await q(
    `select f.schedule_id, f.label, f.manager_group, f.payment_timing, f.fee_month,
            f.expected, f.received, f.received_source, f.variance,
            s.fee_type, s.fee_pct, s.fixed_amount, s.fee_note, s.sort_order
       from reporting.am_fee_month f
       join public.am_fee_schedule s on s.id = f.schedule_id
      where f.tenant_id = $1
        and f.fee_month >= make_date($2, 1, 1) and f.fee_month < make_date($2 + 1, 1, 1)
        and ($3::uuid is null or exists (
              select 1 from public.am_fee_schedule_property l
                join public.property p on p.id = l.property_id
               where l.schedule_id = f.schedule_id and p.entity_id = $3::uuid))
        and ($4::uuid is null or exists (
              select 1 from public.am_fee_schedule_property l
                join reporting.property_summary_mv ps on ps.id = l.property_id
               where l.schedule_id = f.schedule_id and ps.managing_entity_id = $4::uuid))
      order by s.sort_order, f.fee_month`,
    [who.tenantId, year, entity, managing]
  );

  const props = await q(
    `select l.schedule_id, p.id as property_id,
            coalesce(p.dba_name, p.trade_name) as property_name
       from public.am_fee_schedule_property l
       join public.am_fee_schedule s on s.id = l.schedule_id
       join public.property p on p.id = l.property_id
      where s.tenant_id = $1
      order by 3`,
    [who.tenantId]
  );
  const bySchedule = {};
  for (const p of props) (bySchedule[p.schedule_id] = bySchedule[p.schedule_id] || []).push(p);

  /* one object per fee row, months keyed 1..12 */
  const sched = new Map();
  for (const r of rows) {
    if (!sched.has(r.schedule_id)) {
      sched.set(r.schedule_id, {
        schedule_id: r.schedule_id, label: r.label, manager_group: r.manager_group,
        payment_timing: r.payment_timing, fee_type: r.fee_type,
        fee_pct: num(r.fee_pct), fixed_amount: num(r.fixed_amount),
        fee_note: r.fee_note, sort_order: r.sort_order,
        properties: bySchedule[r.schedule_id] || [],
        expected: {}, received: {}, received_source: {}, variance: {},
      });
    }
    const s = sched.get(r.schedule_id);
    const m = r.fee_month.getMonth() + 1;
    s.expected[m] = num(r.expected);
    s.received[m] = num(r.received);
    s.received_source[m] = r.received_source;
    s.variance[m] = num(r.variance);
  }

  const list = [...sched.values()];
  const groups = {};
  for (const s of list) (groups[s.manager_group] = groups[s.manager_group] || []).push(s);

  res.json({
    ok: true, year, entity, managing: managing || null,
    groups: Object.keys(groups).map(g => ({
      manager_group: g,
      payment_timing: groups[g][0].payment_timing,
      timing_confirmed: !groups[g].some(x => (x.fee_note || '').includes('timing not confirmed')),
      rows: groups[g],
    })),
    rows: list,
  });
}

/* ------------------------------------------------------------------------ */
function reportingRoutes() {
  const r = express.Router();

  /* Read-only, first of the two guards. Everything here is a GET; anything
     else is refused before a handler can run. */
  r.use((req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD') return next();
    res.set('Allow', 'GET, HEAD');
    return res.status(405).json({ error: 'This API is read-only.' });
  });

  r.get('/entities', guard(entities, { nav: 'properties' }));
  r.get('/summary', guard(summary, { nav: 'properties' }));
  r.get('/:id/overview', guard(overview, { nav: 'properties' }));
  r.get('/:id/documents', guard(documents, { nav: 'properties' }));
  r.get('/:id/monthly', guard(monthly, { nav: 'properties' }));
  r.get('/:id/income-statement', guard(incomeStatement, { nav: 'properties' }));
  r.get('/:id/noi-analysis', guard(noiAnalysis, { nav: 'properties' }));
  r.get('/:id/rent-roll', guard(rentRoll, { nav: 'properties' }));
  return r;
}

function amFeeRoutes() {
  const r = express.Router();
  r.use((req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD') return next();
    res.set('Allow', 'GET, HEAD');
    return res.status(405).json({ error: 'This API is read-only.' });
  });
  r.get('/', guard(amFees, { nav: 'properties' }));
  return r;
}

module.exports = { reportingRoutes, amFeeRoutes, _internal: { q, yearOf, uuidOrNull, monthKey } };
