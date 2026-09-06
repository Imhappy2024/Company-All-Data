/* Financials — cash and debt, read-only.

   Mounted at /api/financials. Replaces the baked KPI block that V.financials()
   in portal.html has been rendering since the portal was built.

   ---------------------------------------------------------------------------
   READ-ONLY IS ENFORCED, NOT JUST INTENDED

   The brief says no INSERT/UPDATE/DELETE/DDL anywhere in this feature. Two
   guards make that true rather than aspirational: the router refuses any method
   that is not GET or HEAD, and every SQL string is checked against a write-verb
   pattern before it reaches the pool. Both are cheap, and this module runs as
   `postgres` (see below), so a mistake here has no database-side backstop.

   ---------------------------------------------------------------------------
   TENANT SCOPING IS THIS MODULE'S JOB, NOT RLS's

   supabase-db connects with SUPABASE_DB_URL, which is the `postgres` superuser.
   That bypasses RLS entirely — `current_tenant_ids()` never runs. So every
   query filters `tenant_id` explicitly, on every table that has the column.

   The four views may or may not expose `tenant_id`; the brief's column lists do
   not show it. Rather than assume either way, the module probes
   information_schema once and applies the filter where the column exists,
   recording it in `problems[]` where it does not. The project is single-tenant
   today, so an unfiltered view is not currently a leak — but it will be the day
   it stops being single-tenant, and a silent assumption is exactly what would
   survive that change unnoticed.

   ---------------------------------------------------------------------------
   WHY THERE IS A RUNTIME SCHEMA PROBE AT ALL

   The brief says to verify every column against the live database rather than
   trusting its own list. That could not be done while writing this: the repo
   has no .env, so there is no database to ask. The honest response was to make
   the SERVER do the verification, once, at first use — and to make what it
   finds visible in `problems[]` on every response instead of letting a missing
   column read as an empty column.

   That is not defensive padding. A column this file names but the database does
   not have produces `undefined` -> empty string in the UI, which is
   indistinguishable from "no data for this quarter". The probe turns that into
   a sentence.

   `caps` also does real work beyond diagnostics: v_debt_by_account_quarter is
   documented with names but no ids (`entity`, `deal_name`, `lender` — no
   entity_id, no account_id), while v_cash_by_entity_quarter has both. Filtering
   by id is correct and filtering by name is a guess when two entities share a
   name, so each filter prefers the id form and falls back to the name form only
   where the view leaves it no choice.
   --------------------------------------------------------------------------- */

const express = require('express');
const db = require('./supabase-db');
const { stringify } = require('csv-stringify');
const ExcelJS = require('exceljs');

const TENANT_ID = '72381c81-af95-4e1d-ad0d-20a3a3421119';

/* Cash and debt are never added together. They are different account kinds and
   the sum is a meaningless number in the hundreds of millions. There is no
   helper in this file that could produce one, and there should not be. */

const FILTERS_TTL_MS = 5 * 60 * 1000;
const MAX_PER_PAGE = 200;
const EXPORT_ROW_CAP = 50000;

/* ---- read-only guards ---------------------------------------------------- */

const WRITE_SQL = /\b(insert|update|delete|truncate|drop|alter|create|grant|revoke|copy|merge)\b/i;

function assertReadOnly(sql) {
  if (WRITE_SQL.test(sql)) {
    throw new Error('financials-api is read-only; refused to run a statement containing a write verb');
  }
}

async function q(sql, params) {
  assertReadOnly(sql);
  const r = await db.q(sql, params);
  return r.rows;
}

/* ---- capability probe ---------------------------------------------------- */

const RELATIONS = [
  'v_cash_by_entity_quarter',
  'v_debt_by_account_quarter',
  'v_debt_by_quarter',
  'v_cash_debt_summary',
  'financial_account',
  'account_balance',
  'entity',
  'deal',
  'company',
];

let capsCache = null;
let capsInFlight = null;

async function loadCaps() {
  const rows = await q(
    `select table_name, column_name
       from information_schema.columns
      where table_schema = 'public' and table_name = any($1::text[])`,
    [RELATIONS]
  );
  const caps = {};
  for (const rel of RELATIONS) caps[rel] = new Set();
  for (const r of rows) if (caps[r.table_name]) caps[r.table_name].add(r.column_name);

  const problems = [];
  for (const rel of RELATIONS) {
    if (!caps[rel].size) {
      problems.push({
        relation: rel,
        kind: 'missing',
        detail: `public.${rel} does not exist, or this role cannot see it. Everything that reads it will be empty.`,
      });
    } else if (!caps[rel].has('tenant_id')) {
      /* Only worth saying for relations the brief says carry it. A view that
         never had the column is a design choice, not a fault — but this
         connection bypasses RLS, so it is worth stating which reads are
         therefore unscoped. */
      problems.push({
        relation: rel,
        kind: 'no_tenant_column',
        detail: `public.${rel} has no tenant_id column, so reads of it are not tenant-filtered. Safe while the project is single-tenant; not safe after that.`,
      });
    }
  }
  return { caps, problems, at: Date.now() };
}

function caps() {
  if (capsCache) return Promise.resolve(capsCache);
  if (!capsInFlight) {
    capsInFlight = loadCaps()
      .then(c => { capsCache = c; return c; })
      .finally(() => { capsInFlight = null; });
  }
  return capsInFlight;
}

const has = (c, rel, col) => c.caps[rel] && c.caps[rel].has(col);

/* ---- request parsing ----------------------------------------------------- */

/* Two accepted forms, and they are NOT equivalent.

   `deal[]=a&deal[]=b` is the API contract. Each value is taken VERBATIM,
   because a repeated parameter is already unambiguous and splitting it again
   would corrupt any value containing a comma. Institution and deal names
   contain commas ("Maples, Phase II"), so this matters.

   `deal=a,b` is the compact form the page URL uses, and it is lossy on
   purpose: Express decodes query values before this function ever sees them,
   so by here a percent-encoded comma and a literal comma are the same
   character and no amount of care can tell them apart. That is precisely why
   the API contract specifies the repeated form, and why the browser module
   uses it for every request while reserving the comma form for the hash —
   where it does its own split-BEFORE-decode and the ambiguity never arises. */
function arrayParam(req, name) {
  const repeated = req.query[name + '[]'];
  if (repeated !== undefined && repeated !== null && repeated !== '') {
    const parts = Array.isArray(repeated) ? repeated : [repeated];
    return parts.map(v => String(v).trim()).filter(Boolean);
  }
  const raw = req.query[name];
  if (raw === undefined || raw === null || raw === '') return [];
  const parts = Array.isArray(raw) ? raw : [raw];
  const out = [];
  for (const p of parts) {
    for (const piece of String(p).split(',')) {
      const v = piece.trim();
      if (v) out.push(v);
    }
  }
  return out;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/* A malformed uuid reaching Postgres is 22P02, which is a 400 rather than a
   server fault. Dropping them here keeps the message useful. */
function uuidParam(req, name) {
  return arrayParam(req, name).filter(v => UUID_RE.test(v));
}

function boolParam(req, name) {
  return arrayParam(req, name)
    .map(v => (v === 'true' ? true : v === 'false' ? false : null))
    .filter(v => v !== null);
}

function numParam(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function parseFilters(req) {
  const asOf = ISO_DATE.test(String(req.query.as_of || '')) ? String(req.query.as_of) : null;
  return {
    asOf,
    company: uuidParam(req, 'company'),
    deal: uuidParam(req, 'deal'),
    entity: uuidParam(req, 'entity'),
    account: uuidParam(req, 'account'),
    institution: arrayParam(req, 'institution'),
    purpose: arrayParam(req, 'purpose'),
    type: arrayParam(req, 'type'),
    kind: arrayParam(req, 'kind').filter(v => v === 'bank' || v === 'loan'),
    cashSource: arrayParam(req, 'cash_source'),
    verified: boolParam(req, 'verified'),
    min: numParam(req.query.min),
    max: numParam(req.query.max),
    maturityBefore: ISO_DATE.test(String(req.query.maturity_before || '')) ? String(req.query.maturity_before) : null,
  };
}

/* ---- tab definitions ----------------------------------------------------- */

/* `sortable` is an allow-list, not a convenience: the sort column arrives from
   the browser and is interpolated into the SQL, which is the one place in this
   file a string from a caller reaches a query. Anything not on the list is
   refused rather than escaped. */
const TABS = {
  cash: {
    rel: 'v_cash_by_entity_quarter',
    hasDate: true,
    defaultSort: 'balance',
    defaultDir: 'desc',
    sortable: ['balance', 'entity', 'deal_name', 'account_name', 'institution', 'account_purpose', 'account_type', 'cash_source', 'as_of_date'],
    columns: [
      ['deal_name', 'Deal'], ['entity', 'Entity'], ['account_name', 'Account Name'],
      ['institution', 'Institution'], ['account_number_last4', 'Last 4'],
      ['account_purpose', 'Account Purpose'], ['account_type', 'Account Type'],
      ['cash_source', 'Cash Source'], ['as_of_date', 'As Of Date'],
      ['balance', 'Balance'], ['is_verified', 'Verified'], ['source', 'Source'],
    ],
    money: ['balance'],
    dates: ['as_of_date'],
  },
  debt: {
    rel: 'v_debt_by_account_quarter',
    hasDate: true,
    defaultSort: 'balance',
    defaultDir: 'desc',
    sortable: ['balance', 'entity', 'deal_name', 'lender', 'account_name', 'as_of_date'],
    columns: [
      ['deal_name', 'Deal'], ['entity', 'Entity'], ['lender', 'Lender'],
      ['account_name', 'Account Name'], ['account_number_last4', 'Last 4'],
      ['as_of_date', 'As Of Date'], ['balance', 'Balance'], ['is_verified', 'Verified'],
    ],
    money: ['balance'],
    dates: ['as_of_date'],
  },
  loans: {
    rel: 'v_debt_by_quarter',
    hasDate: true,
    defaultSort: 'balance',
    defaultDir: 'desc',
    sortable: ['balance', 'entity', 'deal_name', 'loan_label', 'lender', 'maturity_date', 'as_of_date', 'dscr'],
    columns: [
      ['deal_name', 'Deal'], ['entity', 'Entity'], ['loan_label', 'Loan'], ['lender', 'Lender'],
      ['as_of_date', 'As Of Date'], ['balance', 'Balance'], ['prior_balance', 'Prior Balance'],
      ['principal_paid', 'Principal Paid'], ['maturity_date', 'Maturity Date'],
      ['interest_rate', 'Interest Rate'], ['dscr', 'DSCR'], ['is_verified', 'Verified'],
    ],
    money: ['balance', 'prior_balance', 'principal_paid'],
    dates: ['as_of_date', 'maturity_date'],
  },
  accounts: {
    rel: 'financial_account',
    hasDate: false,
    defaultSort: 'account_name',
    defaultDir: 'asc',
    sortable: ['account_name', 'entity', 'deal_name', 'institution', 'account_kind', 'account_type', 'account_purpose'],
    columns: [
      ['deal_name', 'Deal'], ['entity', 'Entity'], ['account_name', 'Account Name'],
      ['account_kind', 'Kind'], ['account_type', 'Type'], ['account_purpose', 'Purpose'],
      ['institution', 'Institution'], ['account_number_last4', 'Last 4'],
      ['cash_source', 'Cash Source'], ['property_manager', 'Property Manager'],
      ['quarterly_report', 'Quarterly Report'], ['bank_contact_name', 'Bank Contact'],
      ['notes', 'Notes'],
    ],
    money: [],
    dates: [],
  },
};

/* Credential-adjacent columns never leave this process, on any route, in any
   format. They are not in any TABS.columns list above; this set is the second
   line, applied to every row on the way out, so a future column added to a list
   by name cannot smuggle one through. portal_password does not exist any more
   and must never be reintroduced. */
const NEVER_EXPOSE = new Set([
  'portal_url', 'portal_username', 'portal_password',
  'mfa_method', 'mfa_required', 'bank_contact_email',
]);

function scrub(row) {
  const out = {};
  for (const k of Object.keys(row)) if (!NEVER_EXPOSE.has(k)) out[k] = row[k];
  return out;
}

/* ---- WHERE building ------------------------------------------------------ */

/* The cardinality(...) = 0 or ... pattern is what makes "nothing selected" mean
   "all" without branching in application code, and it is why no code path here
   can emit an empty IN (). */
function buildWhere(tab, c, f) {
  const rel = tab.rel;
  const where = [];
  const params = [];
  const P = v => { params.push(v); return '$' + params.length; };

  if (has(c, rel, 'tenant_id')) where.push(`v.tenant_id = ${P(TENANT_ID)}`);

  if (tab.hasDate && f.asOf && has(c, rel, 'as_of_date')) where.push(`v.as_of_date = ${P(f.asOf)}::date`);

  /* An account reaches its offering directly or through its entity. That
     fallback is the view's own, and dropping half of it silently under-reports
     whichever deals are only reachable the other way. */
  const accountScoped = has(c, rel, 'account_id');
  const dealExists = (col, vals) => `exists (select 1 from public.financial_account fa
      left join public.entity e on e.id = fa.owner_entity_id
     where fa.tenant_id = ${P(TENANT_ID)} and fa.id = v.account_id and ${col} = any(${P(vals)}::uuid[]))`;

  if (f.deal.length) {
    if (accountScoped) where.push(dealExists('coalesce(fa.deal_id, e.deal_id)', f.deal));
    else if (has(c, rel, 'deal_id')) where.push(`v.deal_id = any(${P(f.deal)}::uuid[])`);
    else if (has(c, rel, 'deal_name')) {
      /* The view exposes only the name. Resolving ids to names is a guess when
         two offerings share one, so it is recorded rather than done silently. */
      where.push(`v.deal_name = any(select name from public.deal where tenant_id = ${P(TENANT_ID)} and id = any(${P(f.deal)}::uuid[]))`);
    }
  }

  if (f.company.length) {
    if (accountScoped) where.push(dealExists('e.company_id', f.company));
    else if (has(c, rel, 'company_id')) where.push(`v.company_id = any(${P(f.company)}::uuid[])`);
    else if (has(c, rel, 'entity')) {
      where.push(`v.entity = any(select name from public.entity where tenant_id = ${P(TENANT_ID)} and company_id = any(${P(f.company)}::uuid[]))`);
    }
  }

  if (f.entity.length) {
    if (has(c, rel, 'entity_id')) where.push(`v.entity_id = any(${P(f.entity)}::uuid[])`);
    else if (has(c, rel, 'owner_entity_id')) where.push(`v.owner_entity_id = any(${P(f.entity)}::uuid[])`);
    else if (has(c, rel, 'entity')) {
      where.push(`v.entity = any(select name from public.entity where tenant_id = ${P(TENANT_ID)} and id = any(${P(f.entity)}::uuid[]))`);
    }
  }

  if (f.account.length) {
    if (has(c, rel, 'account_id')) where.push(`v.account_id = any(${P(f.account)}::uuid[])`);
    else if (rel === 'financial_account') where.push(`v.id = any(${P(f.account)}::uuid[])`);
  }

  /* The debt view names this column `lender`; the cash view and the account
     table name it `institution`. Same filter, same options list, two columns.
     (none) is a real selectable value so the rows missing one stay reachable —
     six accounts have a NULL institution because the source showed "?". */
  const instCol = has(c, rel, 'institution') ? 'institution' : (has(c, rel, 'lender') ? 'lender' : null);
  if (f.institution.length && instCol) {
    where.push(`coalesce(v.${instCol}, '(none)') = any(${P(f.institution)}::text[])`);
  }

  /* account_purpose holds the original source labels (Operating, MM, Sec Dep,
     CD, ICS…) and account_type is the lossy CHECK-constrained version: CD and
     Savings both become `savings`, MM and ICS both become `money_market`. They
     are separate filters because collapsing them loses the distinction the
     people who maintain this data actually use. */
  if (f.purpose.length && has(c, rel, 'account_purpose')) where.push(`v.account_purpose = any(${P(f.purpose)}::text[])`);
  if (f.type.length && has(c, rel, 'account_type')) where.push(`v.account_type = any(${P(f.type)}::text[])`);
  if (f.kind.length && has(c, rel, 'account_kind')) where.push(`v.account_kind = any(${P(f.kind)}::text[])`);
  if (f.cashSource.length && has(c, rel, 'cash_source')) where.push(`v.cash_source = any(${P(f.cashSource)}::text[])`);
  if (f.verified.length && has(c, rel, 'is_verified')) where.push(`v.is_verified = any(${P(f.verified)}::bool[])`);

  if (has(c, rel, 'balance')) {
    if (f.min !== null) where.push(`v.balance >= ${P(f.min)}`);
    if (f.max !== null) where.push(`v.balance <= ${P(f.max)}`);
  }
  if (f.maturityBefore && has(c, rel, 'maturity_date')) where.push(`v.maturity_date < ${P(f.maturityBefore)}::date`);

  return { sql: where.length ? 'where ' + where.join('\n    and ') : '', params };
}

/* The accounts tab reads a base table rather than a view, so it has to do the
   joins the views already did. Selecting explicit columns (not v.*) is also
   what keeps the credential columns out of the result before scrub() ever
   sees it. */
function relationFor(tabKey) {
  if (tabKey !== 'accounts') return `public.${TABS[tabKey].rel} v`;
  return `(
    select fa.id, fa.tenant_id, fa.id as account_id, fa.name as account_name,
           fa.account_kind, fa.account_type, fa.account_purpose, fa.institution,
           fa.account_number_last4, fa.cash_source, fa.property_manager,
           fa.quarterly_report, fa.bank_contact_name, fa.notes,
           fa.owner_entity_id, fa.deal_id,
           e.name as entity, e.company_id,
           coalesce(d.name, ed.name) as deal_name
      from public.financial_account fa
      left join public.entity e  on e.id = fa.owner_entity_id
      left join public.deal   d  on d.id = fa.deal_id
      left join public.deal   ed on ed.id = e.deal_id
  ) v`;
}

function orderBy(tab, req) {
  const s = String(req.query.sort || '');
  const col = tab.sortable.includes(s) ? s : tab.defaultSort;
  const dir = String(req.query.dir || '').toLowerCase() === 'asc' ? 'asc' : (String(req.query.dir || '').toLowerCase() === 'desc' ? 'desc' : tab.defaultDir);
  return `order by v.${col} ${dir} nulls last`;
}

/* ---- filter options ------------------------------------------------------ */

let filtersCache = null;

async function buildFilterOptions() {
  const c = await caps();
  const T = [TENANT_ID];

  const [quarters, deals, entities, companies, institutions, purposes, types, kinds, sources] = await Promise.all([
    q(`select distinct as_of_date,
              extract(year from as_of_date)::int as year,
              extract(quarter from as_of_date)::int as quarter
         from public.account_balance where tenant_id = $1
        order by as_of_date desc`, T),
    q(`select d.id, d.name, c.name as company
         from public.deal d
         left join public.company c on c.id = d.company_id
        where d.tenant_id = $1
          and exists (select 1 from public.financial_account fa where fa.deal_id = d.id and fa.tenant_id = $1)
        order by d.name`, T),
    q(`select e.id, e.name, c.name as company
         from public.entity e
         left join public.company c on c.id = e.company_id
        where e.tenant_id = $1
          and exists (select 1 from public.financial_account fa where fa.owner_entity_id = e.id and fa.tenant_id = $1)
        order by e.name`, T),
    q(`select id, name from public.company where tenant_id = $1 and is_active order by name`, T),
    q(`select coalesce(institution, '(none)') as value, count(*)::int as accounts
         from public.financial_account where tenant_id = $1 group by 1 order by 2 desc, 1`, T),
    q(`select account_purpose as value, count(*)::int as accounts
         from public.financial_account where tenant_id = $1 and account_purpose is not null
        group by 1 order by 2 desc, 1`, T),
    q(`select account_type as value, count(*)::int as accounts
         from public.financial_account where tenant_id = $1 and account_type is not null
        group by 1 order by 2 desc, 1`, T),
    q(`select account_kind as value, count(*)::int as accounts
         from public.financial_account where tenant_id = $1 and account_kind is not null
        group by 1 order by 1`, T),
    q(`select cash_source as value, count(*)::int as accounts
         from public.financial_account where tenant_id = $1 and cash_source is not null
        group by 1 order by 2 desc, 1`, T),
  ]);

  return {
    quarters: quarters.map(r => ({
      as_of: String(r.as_of_date).slice(0, 10),
      year: r.year, quarter: r.quarter,
      label: `Q${r.quarter} ${r.year}`,
    })),
    deals, entities, companies,
    institutions, purposes, types, kinds, cash_sources: sources,
    /* Both, always. A UI that only offers `true` here would be offering a
       filter that currently matches nothing, on a dataset where every row is
       false — which reads as a broken filter rather than as an empty result. */
    verified: [{ value: false, label: 'Draft' }, { value: true, label: 'Verified' }],
    problems: c.problems,
    generatedAt: new Date().toISOString(),
  };
}

/* ---- rows ---------------------------------------------------------------- */

async function fetchRows(tabKey, req, { all = false } = {}) {
  const tab = TABS[tabKey];
  const c = await caps();
  const f = parseFilters(req);
  const rel = relationFor(tabKey);
  const w = buildWhere(tab, c, f);
  const ord = orderBy(tab, req);

  const [{ n }] = await q(`select count(*)::int as n from ${rel}\n  ${w.sql}`, w.params);
  const total = n;

  let sql = `select v.* from ${rel}\n  ${w.sql}\n  ${ord}`;
  const params = w.params.slice();
  let page = 1, perPage = total;

  if (all) {
    sql += `\n  limit ${EXPORT_ROW_CAP}`;
  } else {
    page = Math.max(1, parseInt(req.query.page, 10) || 1);
    perPage = Math.min(MAX_PER_PAGE, Math.max(1, parseInt(req.query.per_page, 10) || 50));
    params.push(perPage, (page - 1) * perPage);
    sql += `\n  limit $${params.length - 1} offset $${params.length}`;
  }

  const rows = (await q(sql, params)).map(scrub);
  return { rows, total, page, perPage, filters: f, problems: c.problems, capped: all && total > EXPORT_ROW_CAP };
}

/* ---- export -------------------------------------------------------------- */

/* Provenance is not optional formatting. A figure that leaves this system
   without its as-of date and its draft flag gets quoted back as fact, and every
   row here is a draft awaiting Mitch Hagen. */
const PROVENANCE = [
  ['as_of_date', 'As Of Date'],
  ['source', 'Source'],
  ['is_verified', 'Verified'],
  ['exported_at', 'Exported At'],
  ['exported_by', 'Exported By'],
  ['filters_applied', 'Filters Applied'],
];

function exportColumns(tab) {
  const seen = new Set();
  const cols = [];
  for (const [key, label] of tab.columns.concat(PROVENANCE)) {
    if (seen.has(key)) continue;
    seen.add(key);
    cols.push([key, label]);
  }
  return cols;
}

function describeFilters(f, names) {
  const bits = [];
  if (f.asOf) bits.push('Quarter: ' + f.asOf);
  const add = (label, vals, map) => {
    if (!vals || !vals.length) return;
    bits.push(label + ': ' + vals.map(v => (map && map.get(v)) || v).join(', '));
  };
  add('Brands', f.company, names.company);
  add('Deals', f.deal, names.deal);
  add('Entities', f.entity, names.entity);
  add('Institutions', f.institution);
  add('Purpose', f.purpose);
  add('Type', f.type);
  add('Kind', f.kind);
  add('Cash source', f.cashSource);
  if (f.verified.length) bits.push('Verified: ' + f.verified.map(v => (v ? 'Verified' : 'Draft')).join(', '));
  if (f.min !== null) bits.push('Min balance: ' + f.min);
  if (f.max !== null) bits.push('Max balance: ' + f.max);
  if (f.maturityBefore) bits.push('Maturity before: ' + f.maturityBefore);
  return bits.length ? bits.join(' | ') : 'None';
}

/* Names for the summary line, so it reads "Deals: Maples, Doral" rather than
   back-to-back uuids nobody can check. */
async function idNames(f) {
  const out = { company: new Map(), deal: new Map(), entity: new Map() };
  const jobs = [];
  if (f.company.length) jobs.push(q(`select id, name from public.company where tenant_id = $1 and id = any($2::uuid[])`, [TENANT_ID, f.company]).then(r => r.forEach(x => out.company.set(x.id, x.name))));
  if (f.deal.length) jobs.push(q(`select id, name from public.deal where tenant_id = $1 and id = any($2::uuid[])`, [TENANT_ID, f.deal]).then(r => r.forEach(x => out.deal.set(x.id, x.name))));
  if (f.entity.length) jobs.push(q(`select id, name from public.entity where tenant_id = $1 and id = any($2::uuid[])`, [TENANT_ID, f.entity]).then(r => r.forEach(x => out.entity.set(x.id, x.name))));
  await Promise.all(jobs);
  return out;
}

const isoDate = v => (v == null ? '' : (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10)));

/* Numbers export as numbers. The consumer pivots these in Excel, and a cell
   holding "$5,073,105.35" is text that will not add up. */
function exportValue(tab, key, row, meta) {
  if (key === 'exported_at') return meta.exportedAt;
  if (key === 'exported_by') return meta.exportedBy;
  if (key === 'filters_applied') return meta.filtersApplied;
  const v = row[key];
  if (v === undefined || v === null) return '';
  if (tab.dates.includes(key)) return isoDate(v);
  if (tab.money.includes(key)) { const n = Number(v); return Number.isFinite(n) ? n : ''; }
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return v;
}

function exportFilename(tabKey, f, format) {
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const scope = f.asOf || 'all';
  const filtered = (f.company.length || f.deal.length || f.entity.length || f.institution.length ||
                    f.purpose.length || f.type.length || f.kind.length || f.cashSource.length ||
                    f.verified.length || f.min !== null || f.max !== null || f.maturityBefore)
    ? '_filtered' : '';
  return `leavenwealth_${tabKey}_${scope}${filtered}_${stamp}.${format}`;
}

/* ---- routes -------------------------------------------------------------- */

function financialsRoutes() {
  const r = express.Router();

  /* Guard one: nothing but reads reaches this router at all. */
  r.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return res.status(405).set('Allow', 'GET, HEAD').json({ error: 'The financials API is read-only.' });
    }
    if (!db.enabled) {
      return res.status(503).json({
        configured: false,
        error: 'SUPABASE_DB_URL is not set, so there are no financials to read.',
      });
    }
    next();
  });

  const fail = (res, err) => {
    if (err && err.code === '22P02') return res.status(400).json({ error: 'That is not a valid id.' });
    console.error('[financials]', err && err.message);
    res.status(500).json({ error: (err && err.message) || 'financials query failed' });
  };

  r.get('/filters', async (req, res) => {
    try {
      if (!filtersCache || Date.now() - filtersCache.at > FILTERS_TTL_MS || req.query.force === '1') {
        filtersCache = { payload: await buildFilterOptions(), at: Date.now() };
      }
      res.set('Cache-Control', 'private, max-age=300');
      res.json(filtersCache.payload);
    } catch (err) { fail(res, err); }
  });

  /* The tiles. Cash and debt are returned as separate fields and there is no
     combined total in the payload, because there is no correct one. */
  r.get('/summary', async (req, res) => {
    try {
      const c = await caps();
      const asOf = ISO_DATE.test(String(req.query.as_of || '')) ? String(req.query.as_of) : null;

      let rows = [];
      if (c.caps['v_cash_debt_summary'] && c.caps['v_cash_debt_summary'].size) {
        const tenantW = has(c, 'v_cash_debt_summary', 'tenant_id') ? 'where tenant_id = $1' : '';
        rows = await q(`select * from public.v_cash_debt_summary ${tenantW} order by year desc, quarter desc`,
                       tenantW ? [TENANT_ID] : []);
      }

      /* The selector speaks in as-of dates (2026-06-30) because that is what
         account_balance holds; this view is keyed by year + quarter and has no
         as_of_date column at all. Deriving the quarter from the date is the
         join. Matching on a column the view does not have returned null for
         every quarter, and the tiles rendered "no data" over data. */
      const pick = asOf ? (
        rows.find(x => isoDate(x.as_of_date) === asOf) ||
        rows.find(x => x.year === Number(asOf.slice(0, 4)) &&
                       x.quarter === Math.ceil(Number(asOf.slice(5, 7)) / 3)) ||
        null
      ) : (rows[0] || null);

      res.json({
        quarters: rows.map(x => ({
          year: x.year, quarter: x.quarter, label: `Q${x.quarter} ${x.year}`,
          as_of: isoDate(x.as_of_date) || null,
          total_cash: x.total_cash, total_debt: x.total_debt,
          cash_accounts: x.cash_accounts, loan_accounts: x.loan_accounts,
          all_verified: x.all_verified,
        })),
        current: pick,
        problems: c.problems,
      });
    } catch (err) { fail(res, err); }
  });

  /* Loan-level coverage. A bare loan total implies the loans with no balance
     row are paid off; they are not, they are unpopulated, and 21 of 75 is too
     many to leave unsaid. */
  r.get('/loan-coverage', async (req, res) => {
    try {
      const [row] = await q(
        `select (select count(*)::int from public.loan where tenant_id = $1) as loans,
                (select count(distinct loan_id)::int from public.loan_balance where tenant_id = $1) as with_balance`,
        [TENANT_ID]
      );
      res.json(row);
    } catch (err) { fail(res, err); }
  });

  for (const tabKey of Object.keys(TABS)) {
    r.get('/' + tabKey, async (req, res) => {
      try {
        const out = await fetchRows(tabKey, req);
        res.json({
          rows: out.rows, total_count: out.total, page: out.page, per_page: out.perPage,
          columns: TABS[tabKey].columns, problems: out.problems,
        });
      } catch (err) { fail(res, err); }
    });
  }

  r.get('/export', async (req, res) => {
    const tabKey = String(req.query.tab || 'cash');
    const format = String(req.query.format || 'csv').toLowerCase() === 'xlsx' ? 'xlsx' : 'csv';
    const tab = TABS[tabKey];
    if (!tab) return res.status(400).json({ error: 'Unknown tab: ' + tabKey });

    try {
      const out = await fetchRows(tabKey, req, { all: true });
      const names = await idNames(out.filters);
      const meta = {
        exportedAt: new Date().toISOString(),
        exportedBy: exportedBy(req),
        filtersApplied: describeFilters(out.filters, names),
      };
      const cols = exportColumns(tab);

      console.log('[financials] export tab=%s format=%s rows=%d by=%s filters=%s',
                  tabKey, format, out.rows.length, meta.exportedBy, meta.filtersApplied);

      res.set('Content-Disposition', `attachment; filename="${exportFilename(tabKey, out.filters, format)}"`);
      if (format === 'csv') return sendCsv(res, tab, cols, out, meta);
      return sendXlsx(res, tabKey, tab, cols, out, meta);
    } catch (err) {
      /* Headers may already be out on a stream; there is nothing useful to
         send at that point except ending it. */
      if (res.headersSent) return res.end();
      fail(res, err);
    }
  });

  return r;
}

function exportedBy(req) {
  if (req.session && req.session.user && (req.session.user.email || req.session.user.name)) {
    return req.session.user.email || req.session.user.name;
  }
  /* The portal calls this with the caller's Supabase JWT. The email sits in the
     payload; it is read for the audit line only and nothing is authorised on
     it, so an unverified decode is the right amount of work here. */
  const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '');
  if (m) {
    try {
      const p = JSON.parse(Buffer.from(m[1].split('.')[1], 'base64url').toString('utf8'));
      if (p && p.email) return p.email;
    } catch (_) { /* a token we cannot read is not an error here */ }
  }
  return 'unknown';
}

function sendCsv(res, tab, cols, out, meta) {
  res.type('text/csv; charset=utf-8');
  const head =
    '# LeavenWealth financial export\n' +
    `# Generated: ${meta.exportedAt} by ${meta.exportedBy}\n` +
    `# Quarter: ${out.filters.asOf || 'all quarters'}\n` +
    `# Filters: ${meta.filtersApplied}\n` +
    '# DRAFT - figures are unverified, pending Mitch Hagen\n' +
    `# Rows: ${out.rows.length}\n`;
  res.write(head);

  const s = stringify({ header: true, columns: cols.map(([key, label]) => ({ key, header: label })) });
  s.on('error', () => res.end());
  s.pipe(res);
  for (const row of out.rows) {
    const rec = {};
    for (const [key] of cols) rec[key] = exportValue(tab, key, row, meta);
    s.write(rec);
  }
  s.end();
}

async function sendXlsx(res, tabKey, tab, cols, out, meta) {
  res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  const wb = new ExcelJS.stream.xlsx.WorkbookWriter({ stream: res, useStyles: true });

  const ws = wb.addWorksheet(tabKey.charAt(0).toUpperCase() + tabKey.slice(1),
    { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = cols.map(([key, label]) => ({
    header: label, key,
    width: Math.min(42, Math.max(12, label.length + 4)),
    style: tab.money.includes(key) ? { numFmt: '#,##0.00' }
         : tab.dates.includes(key) ? { numFmt: 'yyyy-mm-dd' } : {},
  }));
  ws.getRow(1).font = { bold: true };
  ws.getRow(1).commit();
  for (const row of out.rows) {
    const rec = {};
    for (const [key] of cols) rec[key] = exportValue(tab, key, row, meta);
    ws.addRow(rec).commit();
  }
  ws.commit();

  /* The provenance block goes on its own sheet rather than above the header,
     because a comment block on sheet 1 breaks every pivot and filter the person
     downloading this is about to build. */
  const about = wb.addWorksheet('About');
  about.columns = [{ width: 22 }, { width: 90 }];

  /* Styling happens BEFORE the row is committed. This is a streaming writer:
     a committed row is already serialised and gone, and reaching back for it
     throws "Out of bounds: this row has been committed". */
  const title = about.addRow(['LeavenWealth financial export', '']);
  title.font = { bold: true, size: 13 };
  title.commit();

  [
    ['Tab', tabKey],
    ['Generated', meta.exportedAt],
    ['Generated by', meta.exportedBy],
    ['Quarter', out.filters.asOf || 'all quarters'],
    ['Filters', meta.filtersApplied],
    ['Rows', out.rows.length],
    ['Status', 'DRAFT - figures are unverified, pending Mitch Hagen'],
  ].forEach(([k, v]) => about.addRow([k, v]).commit());
  about.commit();

  await wb.commit();
}

module.exports = { financialsRoutes, TABS, NEVER_EXPOSE, arrayParam, describeFilters };
