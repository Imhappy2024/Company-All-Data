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
  /* Resolved by name rather than hardcoded, so a renamed or re-seeded company
     still resolves. If it comes back empty the name test still applies on its
     own, and problems[] says the company test is doing nothing. */
  let excludedCompanyIds = [];
  try {
    const brands = await q('select id, name from public.company where tenant_id = $1 and name ~* $2',
                          [TENANT_ID, BRAND_EXCLUDE_RE]);
    excludedCompanyIds = brands.map(r => r.id);
    if (!excludedCompanyIds.length) {
      problems.push({
        relation: 'company', kind: 'no_excluded_brands',
        detail: 'No company matched leadli/folio, so brand exclusion is running on name matching alone.',
      });
    }
  } catch (err) {
    problems.push({ relation: 'company', kind: 'exclude_lookup_failed', detail: err.message });
  }

  return { caps, problems, excludedCompanyIds, at: Date.now() };
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

function numParam(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/* Three states, not two: "only entities with debt", "only entities without",
   and "do not filter on this at all". A plain boolean collapses the last two,
   so an untouched control would mean "hide everything that has debt". */
function triParam(req, name) {
  const v = req.query[name];
  if (v === 'true' || v === '1') return true;
  if (v === 'false' || v === '0') return false;
  return null;
}

function parseFilters(req) {
  const iso = v => (ISO_DATE.test(String(v || '')) ? String(v) : null);
  /* as_of is still accepted and means a single day (from = to = as_of), so an
     existing link or API caller keeps working. */
  const exact = iso(req.query.as_of);
  let from = exact || iso(req.query.from);
  let to   = exact || iso(req.query.to);
  /* A backwards range is a slip, not a request for nothing. Swapping is what
     every date picker does and is far less surprising than an empty table. */
  if (from && to && from > to) { const t = from; from = to; to = t; }
  return {
    from, to,
    /* No `company` (Brand) filter. Deal and Entity already scope to one
       brand, and their option lists name it beside each row. */
    deal: uuidParam(req, 'deal'),
    entity: uuidParam(req, 'entity'),
    account: uuidParam(req, 'account'),
    institution: arrayParam(req, 'institution'),
    purpose: arrayParam(req, 'purpose'),
    type: arrayParam(req, 'type'),
    kind: arrayParam(req, 'kind').filter(v => v === 'bank' || v === 'loan'),
    cashSource: arrayParam(req, 'cash_source'),
    /* Entity-rollup only. entityType carries a '(none)' bucket like every
       other nullable dimension, so entities with no type stay reachable. */
    entityType: arrayParam(req, 'entity_type'),
    hasCash: triParam(req, 'has_cash'),
    hasDebt: triParam(req, 'has_debt'),
    cashMin: numParam(req.query.cash_min), cashMax: numParam(req.query.cash_max),
    debtMin: numParam(req.query.debt_min), debtMax: numParam(req.query.debt_max),
    /* No `verified` filter. Every one of the 441 balance rows is
       is_verified = false, so the control had exactly one useful setting and
       one that matched nothing. The draft banner carries the caveat instead,
       and is_verified still rides on every export — see PROVENANCE. */
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
      ['balance', 'Balance'], ['source', 'Source'],
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
      ['as_of_date', 'As Of Date'], ['balance', 'Balance'],
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
      ['interest_rate', 'Interest Rate'], ['dscr', 'DSCR'],
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
/* ---- brand exclusion -----------------------------------------------------

   This screen is LeavenWealth's, so Leadli AI and Folio Excel are excluded
   everywhere: the tables, the tiles, the filter option lists and the exports.
   There is no toggle. A control that could put them back would make every
   figure on the page mean two different things depending on a checkbox nobody
   would remember setting.

   The match is on a WORD BOUNDARY, and that is the whole design decision here.
   A plain '%folio%' also matches "Portfolio Reserve" and "Portfolio Loan
   Escrow" — entirely plausible account names in a property company — and would
   drop real LeavenWealth money out of every total with nothing on screen to
   say it had happened. \y is Postgres's word boundary; ~* is case-insensitive.

   Two independent tests, because either one alone leaks:

     - by COMPANY, which catches a Leadli entity whose own name says nothing
       about Leadli. The ids are resolved by name at boot rather than
       hardcoded, so a renamed or re-seeded company still resolves.
     - by NAME, which catches a row hanging off a NULL company_id — and a row
       with no company is exactly the one the company test cannot see.

   A row is kept only if it passes both. */

const BRAND_EXCLUDE_RE = '\\y(leadli|folio)\\y';

/* Which columns the ALIASED relation exposes. For the views this is
   intersected with what information_schema actually reports; the accounts tab
   reads a subquery (see relationFor) whose aliases information_schema has
   never heard of, so its list stands on its own. */
const REL_TEXT_COLS = {
  v_cash_by_entity_quarter:  ['entity', 'deal_name', 'account_name', 'institution'],
  v_debt_by_account_quarter: ['entity', 'deal_name', 'account_name', 'lender'],
  v_debt_by_quarter:         ['entity', 'deal_name', 'loan_label', 'lender'],
  financial_account:         ['entity', 'deal_name', 'account_name', 'institution'],
};
const REL_IS_SUBQUERY = { financial_account: true };

function brandExclusion(rel, c, P) {
  const out = [];
  const ids = c.excludedCompanyIds || [];
  const sub = REL_IS_SUBQUERY[rel];
  const exposes = col => sub || has(c, rel, col);

  if (ids.length) {
    if (exposes('company_id')) {
      /* Written as "is null OR not in the list" rather than <>, because a NULL
         company_id has to survive. "Not one of these" and "has no value" are
         different claims, and SQL quietly turns the second into false. */
      out.push('(v.company_id is null or not (v.company_id = any(' + P(ids) + '::uuid[])))');
    } else if (exposes('account_id')) {
      out.push('not exists (select 1 from public.financial_account fa\n' +
               '        left join public.entity e on e.id = fa.owner_entity_id\n' +
               '        left join public.deal   d on d.id = coalesce(fa.deal_id, e.deal_id)\n' +
               '       where fa.id = v.account_id\n' +
               '         and coalesce(e.company_id, d.company_id) = any(' + P(ids) + '::uuid[]))');
    } else if (exposes('entity')) {
      /* v_debt_by_account_quarter carries names and no ids, so the company
         test has to go through the name. Imperfect if two entities share one;
         the name test below is what covers that gap. */
      out.push('not exists (select 1 from public.entity e\n' +
               '       where e.name = v.entity and e.company_id = any(' + P(ids) + '::uuid[]))');
    }
  }

  for (const col of (REL_TEXT_COLS[rel] || [])) {
    if (!exposes(col)) continue;
    out.push('coalesce(v.' + col + ", '') !~* " + P(BRAND_EXCLUDE_RE));
  }
  return out;
}

function buildWhere(tab, c, f) {
  const rel = tab.rel;
  const where = [];
  const params = [];
  const P = v => { params.push(v); return '$' + params.length; };

  if (has(c, rel, 'tenant_id')) where.push(`v.tenant_id = ${P(TENANT_ID)}`);

  for (const clause of brandExclusion(rel, c, P)) where.push(clause);

  /* A range, inclusive at both ends. The TABLE may legitimately span several
     snapshots — every row carries its own As Of Date, so reading Q1 against Q2
     side by side is a real thing to want. The TILES must not: summing across a
     range that covers two snapshots counts every account twice. The /summary
     route pins them to one date inside the range for exactly that reason. */
  if (tab.hasDate && has(c, rel, 'as_of_date')) {
    if (f.from) where.push(`v.as_of_date >= ${P(f.from)}::date`);
    if (f.to)   where.push(`v.as_of_date <= ${P(f.to)}::date`);
  }

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

/* The same exclusion the tables use, applied to `financial_account fa`.
   The option lists have to agree with the rows or the screen contradicts
   itself: a Deal offered in a dropdown that returns nothing when picked reads
   as a broken filter, not as an excluded brand.
   $1 tenant, $2 excluded company ids, $3 the word-boundary pattern. */
const ACCOUNT_ELIGIBLE = `
  and not exists (select 1 from public.entity e2
       left join public.deal d2 on d2.id = coalesce(fa.deal_id, e2.deal_id)
      where e2.id = fa.owner_entity_id
        and coalesce(e2.company_id, d2.company_id) = any($2::uuid[]))
  and coalesce(fa.name, '') !~* $3
  and coalesce(fa.institution, '') !~* $3
  and not exists (select 1 from public.entity e3 where e3.id = fa.owner_entity_id and e3.name ~* $3)
  and not exists (select 1 from public.deal   d3 where d3.id = fa.deal_id          and d3.name ~* $3)`;

let filtersCache = null;

async function buildFilterOptions() {
  const c = await caps();
  const T = [TENANT_ID];
  const X = [TENANT_ID, c.excludedCompanyIds || [], BRAND_EXCLUDE_RE];

  const [quarters, deals, entities, institutions, purposes, types, kinds, entityTypes, sources] = await Promise.all([
    /* Every snapshot date in the data. With the custom date control these are
       the pickable values rather than a list of quarters — see the /summary
       route for how an arbitrary date resolves onto one of them. */
    q(`select distinct as_of_date,
              extract(year from as_of_date)::int as year,
              extract(quarter from as_of_date)::int as quarter
         from public.account_balance where tenant_id = $1
        order by as_of_date desc`, T),

    q(`select d.id, d.name, c.name as company
         from public.deal d
         left join public.company c on c.id = d.company_id
        where d.tenant_id = $1
          and d.name !~* $3
          and (d.company_id is null or not (d.company_id = any($2::uuid[])))
          and exists (select 1 from public.financial_account fa
                       where fa.deal_id = d.id and fa.tenant_id = $1 ${ACCOUNT_ELIGIBLE})
        order by d.name`, X),

    q(`select e.id, e.name, c.name as company
         from public.entity e
         left join public.company c on c.id = e.company_id
        where e.tenant_id = $1
          and e.name !~* $3
          and (e.company_id is null or not (e.company_id = any($2::uuid[])))
          and exists (select 1 from public.financial_account fa
                       where fa.owner_entity_id = e.id and fa.tenant_id = $1 ${ACCOUNT_ELIGIBLE})
        order by e.name`, X),

    q(`select coalesce(fa.institution, '(none)') as value, count(*)::int as accounts
         from public.financial_account fa where fa.tenant_id = $1 ${ACCOUNT_ELIGIBLE}
        group by 1 order by 2 desc, 1`, X),
    q(`select fa.account_purpose as value, count(*)::int as accounts
         from public.financial_account fa
        where fa.tenant_id = $1 and fa.account_purpose is not null ${ACCOUNT_ELIGIBLE}
        group by 1 order by 2 desc, 1`, X),
    q(`select fa.account_type as value, count(*)::int as accounts
         from public.financial_account fa
        where fa.tenant_id = $1 and fa.account_type is not null ${ACCOUNT_ELIGIBLE}
        group by 1 order by 2 desc, 1`, X),
    q(`select fa.account_kind as value, count(*)::int as accounts
         from public.financial_account fa
        where fa.tenant_id = $1 and fa.account_kind is not null ${ACCOUNT_ELIGIBLE}
        group by 1 order by 1`, X),
    q(`select coalesce(e.entity_type, '(none)') as value, count(*)::int as entities
         from public.entity e
        where e.tenant_id = $1
          and e.name !~* $3
          and (e.company_id is null or not (e.company_id = any($2::uuid[])))
          and exists (select 1 from public.financial_account fa
                       where fa.owner_entity_id = e.id and fa.tenant_id = $1 ${ACCOUNT_ELIGIBLE})
        group by 1 order by 2 desc, 1`, X),
    q(`select fa.cash_source as value, count(*)::int as accounts
         from public.financial_account fa
        where fa.tenant_id = $1 and fa.cash_source is not null ${ACCOUNT_ELIGIBLE}
        group by 1 order by 2 desc, 1`, X),
  ]);

  const dates = quarters.map(r => ({
    as_of: String(r.as_of_date).slice(0, 10),
    year: r.year, quarter: r.quarter,
    label: `Q${r.quarter} ${r.year}`,
  }));

  return {
    quarters: dates,
    /* The bounds the date control clamps to. Offering a date outside the range
       the data covers invites a reading of "nothing that day" when the truth
       is "nothing was ever recorded that day". */
    date_range: dates.length
      ? { min: dates[dates.length - 1].as_of, max: dates[0].as_of }
      : null,
    deals, entities,
    institutions, purposes, types, kinds, entity_types: entityTypes, cash_sources: sources,
    excluded_brands: (c.excludedCompanyIds || []).length,
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
  if (f.from && f.to && f.from === f.to) bits.push('As of: ' + f.from);
  else if (f.from && f.to) bits.push('Dates: ' + f.from + ' to ' + f.to);
  else if (f.from) bits.push('Dates: from ' + f.from);
  else if (f.to) bits.push('Dates: up to ' + f.to);
  const add = (label, vals, map) => {
    if (!vals || !vals.length) return;
    bits.push(label + ': ' + vals.map(v => (map && map.get(v)) || v).join(', '));
  };
  add('Deals', f.deal, names.deal);
  add('Entities', f.entity, names.entity);
  add('Institutions', f.institution);
  add('Purpose', f.purpose);
  add('Type', f.type);
  add('Kind', f.kind);
  add('Cash source', f.cashSource);
  if (f.min !== null) bits.push('Min balance: ' + f.min);
  if (f.max !== null) bits.push('Max balance: ' + f.max);
  if (f.maturityBefore) bits.push('Maturity before: ' + f.maturityBefore);
  return bits.length ? bits.join(' | ') : 'None';
}

/* Names for the summary line, so it reads "Deals: Maples, Doral" rather than
   back-to-back uuids nobody can check. */
async function idNames(f) {
  const out = { deal: new Map(), entity: new Map() };
  const jobs = [];
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

function dateScope(f) {
  if (f.from && f.to) return f.from === f.to ? f.from : f.from + ' to ' + f.to;
  if (f.from) return 'from ' + f.from;
  if (f.to) return 'up to ' + f.to;
  return 'all dates';
}

function exportFilename(tabKey, f, format) {
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const scope = (f.from && f.to) ? (f.from === f.to ? f.from : f.from + '_to_' + f.to)
              : (f.from || f.to || 'all-dates');
  const filtered = (f.deal.length || f.entity.length || f.institution.length ||
                    f.purpose.length || f.type.length || f.kind.length || f.cashSource.length ||
                    f.min !== null || f.max !== null || f.maturityBefore)
    ? '_filtered' : '';
  return `leavenwealth_${tabKey}_${scope}${filtered}_${stamp}.${format}`;
}

/* ---- the entity rollup ---------------------------------------------------

   One row per entity: its cash position and its debt position side by side.
   The account-level tabs answer "what is in this account"; this answers
   "which LLCs are holding cash, and what do they owe".

   THE JOIN BETWEEN CASH AND DEBT IS A FULL OUTER JOIN, AND THAT IS THE WHOLE
   POINT. At Q2 2026, 45 entities have both, 15 have cash only, and ONE has
   debt only. A LEFT JOIN from cash silently drops that one: the row count
   reads 60 instead of 61, and an entity carrying debt with no operating
   account disappears from a debt report. Nobody notices until the entity
   totals fail to reconcile to the portfolio.

   coalesce(..., 0) is on the BALANCES but never on the entity join. An entity
   with no bank accounts genuinely holds zero cash — that is a fact. An entity
   that does not exist is a different problem and must not read as a zero.

   Debt here is loan-KIND ACCOUNTS out of account_balance ($225.4M / 55
   accounts), never loan_balance ($15.2M / 3 loans). loan_balance is sparse
   with ragged dates and quarter-filtering it drops nearly everything; it has
   its own tab. There is deliberately no toggle between them here.

   Cash CAN BE NEGATIVE — eight entities are at Q2 2026. Nothing here calls
   abs(), and the sort has to leave a -$40,000 entity at the bottom of a
   descending sort rather than dropping it off an end.

   Net position is a SUBTRACTION and it will be about -$220M. That is what a
   leveraged property portfolio looks like, not an error state. It is NOT
   equity: property values are nowhere in this calculation. */

/* Institution and purpose filter the UNDERLYING ACCOUNTS, before the rollup,
   so picking Dundee Bank shows each entity's Dundee-only cash rather than its
   full balance. That is deliberate, and the UI says so — otherwise the totals
   look wrong to anyone checking them against the account view. */
function entityRollupSql(c, f, opts) {
  const params = [];
  const P = v => { params.push(v); return '$' + params.length; };
  const T = P(TENANT_ID);
  const D = P(opts.asOf);

  const acct = [];
  if (f.institution.length) {
    acct.push(`coalesce(fa.institution, '(none)') = any(${P(f.institution)}::text[])`);
  }
  if (f.purpose.length) acct.push(`fa.account_purpose = any(${P(f.purpose)}::text[])`);
  const acctWhere = acct.length ? '\n     and ' + acct.join('\n     and ') : '';

  /* The same brand exclusion the rest of the screen uses. Leaving it off here
     would make this view disagree with every other tab about the same money. */
  const ids = c.excludedCompanyIds || [];
  const outer = [`e.tenant_id = ${T}`];
  if (ids.length) {
    outer.push(`(e.company_id is null or not (e.company_id = any(${P(ids)}::uuid[])))`);
  }
  outer.push(`coalesce(e.name, '') !~* ${P(BRAND_EXCLUDE_RE)}`);
  outer.push(`coalesce(co.name, '') !~* ${P(BRAND_EXCLUDE_RE)}`);
  outer.push(`coalesce(d.name, '') !~* ${P(BRAND_EXCLUDE_RE)}`);

  if (f.entity.length) outer.push(`e.id = any(${P(f.entity)}::uuid[])`);
  if (f.deal.length) outer.push(`e.deal_id = any(${P(f.deal)}::uuid[])`);
  if (f.entityType.length) {
    outer.push(`coalesce(e.entity_type, '(none)') = any(${P(f.entityType)}::text[])`);
  }

  /* Derived flags. "Has debt" is debt_accounts > 0, not debt_balance <> 0 — an
     entity with a loan account sitting at zero still has debt on file. */
  if (f.hasCash === true) outer.push('coalesce(c.cash_accounts, 0) > 0');
  if (f.hasCash === false) outer.push('coalesce(c.cash_accounts, 0) = 0');
  if (f.hasDebt === true) outer.push('coalesce(dt.debt_accounts, 0) > 0');
  if (f.hasDebt === false) outer.push('coalesce(dt.debt_accounts, 0) = 0');

  /* Ranges accept negatives; eight entities are below zero on cash. */
  if (f.cashMin !== null) outer.push(`coalesce(c.cash_balance, 0) >= ${P(f.cashMin)}`);
  if (f.cashMax !== null) outer.push(`coalesce(c.cash_balance, 0) <= ${P(f.cashMax)}`);
  if (f.debtMin !== null) outer.push(`coalesce(dt.debt_balance, 0) >= ${P(f.debtMin)}`);
  if (f.debtMax !== null) outer.push(`coalesce(dt.debt_balance, 0) <= ${P(f.debtMax)}`);

  const sql = `
with acct as (
  select fa.owner_entity_id as entity_id, fa.account_kind,
         ab.balance, ab.is_verified, ab.as_of_date, ab.source
    from public.account_balance ab
    join public.financial_account fa on fa.id = ab.account_id
   where ab.tenant_id = ${T} and fa.tenant_id = ${T}
     and ab.as_of_date = ${D}::date
     and fa.owner_entity_id is not null${acctWhere}
),
cash as (
  select entity_id,
         sum(balance) as cash_balance, count(*)::int as cash_accounts,
         bool_and(is_verified) as cash_verified, max(as_of_date) as cash_as_of,
         min(source) as cash_source
    from acct where account_kind = 'bank' group by entity_id
),
debt as (
  select entity_id,
         sum(balance) as debt_balance, count(*)::int as debt_accounts,
         bool_and(is_verified) as debt_verified, max(as_of_date) as debt_as_of
    from acct where account_kind = 'loan' group by entity_id
)
select e.id                            as entity_id,
       e.name                          as entity,
       e.entity_type,
       co.name                         as brand,
       d.name                          as deal_name,
       coalesce(c.cash_balance, 0)     as cash_balance,
       coalesce(c.cash_accounts, 0)    as cash_accounts,
       coalesce(dt.debt_balance, 0)    as debt_balance,
       coalesce(dt.debt_accounts, 0)   as debt_accounts,
       coalesce(c.cash_balance, 0) - coalesce(dt.debt_balance, 0) as net_position,
       coalesce(c.cash_verified, true) and coalesce(dt.debt_verified, true) as all_verified,
       coalesce(c.cash_as_of, dt.debt_as_of) as as_of_date,
       c.cash_source                   as source
  from cash c
  full outer join debt dt on dt.entity_id = c.entity_id
  join public.entity e on e.id = coalesce(c.entity_id, dt.entity_id)
  left join public.company co on co.id = e.company_id
  left join public.deal    d  on d.id = e.deal_id
 where ${outer.join('\n   and ')}`;

  return { sql, params };
}

const ENTITY_SORTS = {
  cash_balance: 'cash_balance', debt_balance: 'debt_balance', net_position: 'net_position',
  entity: 'entity', brand: 'brand', deal_name: 'deal_name', entity_type: 'entity_type',
  cash_accounts: 'cash_accounts', debt_accounts: 'debt_accounts', as_of_date: 'as_of_date',
};

/* Shown on screen. `Verified` is NOT a column here, for the same reason it is
   not one on the account tabs: it never varies. It IS in the export. */
const ENTITY_COLUMNS = [
  ['entity', 'Entity'], ['brand', 'Brand'], ['deal_name', 'Deal'],
  ['cash_balance', 'Cash Balance'], ['cash_accounts', 'Cash Accts'],
  ['debt_balance', 'Debt Balance'], ['debt_accounts', 'Debt Accts'],
  ['net_position', 'Net Position'], ['as_of_date', 'As Of'],
];

const ENTITY_EXPORT_COLUMNS = [
  ['entity', 'Entity'], ['brand', 'Brand'], ['deal_name', 'Deal'],
  ['cash_balance', 'Cash Balance'], ['cash_accounts', 'Cash Accounts'],
  ['debt_balance', 'Debt Balance'], ['debt_accounts', 'Debt Accounts'],
  ['net_position', 'Net Position'], ['as_of_date', 'As Of Date'],
  ['all_verified', 'Verified'], ['source', 'Source'],
];

const ENTITY_TAB = {
  money: ['cash_balance', 'debt_balance', 'net_position'],
  dates: ['as_of_date'],
};

async function fetchEntityRows(req, { all = false } = {}) {
  const c = await caps();
  const f = parseFilters(req);

  /* One row per entity means one snapshot, so this view pins the same way the
     tiles do: the latest snapshot inside the range. A range covering both
     dates would otherwise give every entity two rows and a totals line that
     counted every account twice. */
  const dates = (await q(
    `select distinct as_of_date from public.account_balance
      where tenant_id = $1 order by as_of_date desc`, [TENANT_ID]
  )).map(r => isoDate(r.as_of_date));
  const inRange = dates.filter(d => (!f.from || d >= f.from) && (!f.to || d <= f.to));
  const asOf = inRange.length ? inRange[0] : null;

  if (!asOf) {
    return { rows: [], total: 0, page: 1, perPage: 50, filters: f, asOf: null,
             snapshotsInRange: 0, totals: null, unattributed: null, problems: c.problems };
  }

  const base = entityRollupSql(c, f, { asOf });
  const [{ n }] = await q(`select count(*)::int as n from (${base.sql}) r`, base.params);

  const sortKey = ENTITY_SORTS[String(req.query.sort || '')] || 'cash_balance';
  const dir = String(req.query.dir || '').toLowerCase() === 'asc' ? 'asc' : 'desc';
  /* nulls last keeps a negative-cash entity at the bottom of a descending sort
     rather than dropping it off an end. */
  let sql = `select * from (${base.sql}) r order by r.${sortKey} ${dir} nulls last, r.entity asc`;
  const params = base.params.slice();

  let page = 1, perPage = n;
  if (all) {
    sql += `\n limit ${EXPORT_ROW_CAP}`;
  } else {
    page = Math.max(1, parseInt(req.query.page, 10) || 1);
    perPage = Math.min(MAX_PER_PAGE, Math.max(1, parseInt(req.query.per_page, 10) || 50));
    params.push(perPage, (page - 1) * perPage);
    sql += `\n limit $${params.length - 1} offset $${params.length}`;
  }

  const rows = (await q(sql, params)).map(scrub);

  /* Totals over the FILTERED set, not the portfolio, so the pinned totals row
     agrees with the rows above it. Computed in SQL across the whole filtered
     result rather than from `rows`, which is one page. */
  const [totals] = await q(
    `select coalesce(sum(r.cash_balance), 0)::numeric as cash,
            coalesce(sum(r.debt_balance), 0)::numeric as debt,
            coalesce(sum(r.net_position), 0)::numeric as net,
            count(*)::int as entities
       from (${base.sql}) r`, base.params);

  /* The reconciliation the acceptance checks turn on.

     financial_account.owner_entity_id is NULLABLE, and this rollup joins
     entity on coalesce(cash.entity_id, debt.entity_id) — so an account with no
     owner entity is dropped by that join. Silently. The Cash Balance column
     then cannot sum to the account-level Total Cash tile, and nothing on
     screen would say why.

     This measures the gap so the screen can state it, rather than leaving
     someone to find it with a calculator. Reported only when non-zero. */
  const [orphan] = await q(
    `select coalesce(sum(ab.balance) filter (where fa.account_kind = 'bank'), 0)::numeric as cash,
            coalesce(sum(ab.balance) filter (where fa.account_kind = 'loan'), 0)::numeric as debt,
            count(*)::int as accounts
       from public.account_balance ab
       join public.financial_account fa on fa.id = ab.account_id
      where ab.tenant_id = $1 and fa.tenant_id = $1
        and ab.as_of_date = $2::date
        and fa.owner_entity_id is null`, [TENANT_ID, asOf]);

  return {
    rows, total: n, page, perPage, filters: f, asOf,
    snapshotsInRange: inRange.length,
    totals, problems: c.problems,
    unattributed: (orphan && orphan.accounts > 0) ? orphan : null,
  };
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

  /* The tiles.

     They are computed from the SAME relations and the SAME brand exclusion the
     tables use, rather than read from v_cash_debt_summary. That view has no
     brand dimension, so reading it would put Leadli and Folio money in the
     tiles above a table that excludes them — two numbers on one screen, both
     labelled Total Cash, disagreeing. Expect these figures to sit BELOW the
     v_cash_debt_summary values in the brief for exactly that reason; that is
     the exclusion working, not a fault.

     Cash and debt are returned as separate fields. There is no combined total
     in the payload because there is no correct one. */
  r.get('/summary', async (req, res) => {
    try {
      const c = await caps();
      const f = parseFilters(req);

      const dates = (await q(
        `select distinct as_of_date from public.account_balance
          where tenant_id = $1 order by as_of_date desc`, [TENANT_ID]
      )).map(r2 => isoDate(r2.as_of_date));

      /* THE TILES PIN TO ONE DATE, even though the table shows a range.

         Summing a range that spans both snapshots counts every account twice
         and produces a number that is roughly double the truth while looking
         entirely plausible — the worst kind of wrong. So the tiles use the
         LATEST snapshot inside the range: the closest thing to "where things
         stand at the end of this window".

         A date before the first snapshot resolves to nothing rather than
         reaching back past the start of the range. "Nothing had been recorded
         by then" is true; borrowing an earlier balance is not.

         An account present in an earlier snapshot but absent from the pinned
         one is therefore not in the tiles. With two snapshots that is rare,
         and the alternative — a latest-per-account roll-up — cannot be done on
         v_debt_by_account_quarter, which carries no account id at all. */
      const inRange = dates.filter(d => (!f.from || d >= f.from) && (!f.to || d <= f.to));
      const asOf = inRange.length ? inRange[0] : null;   /* dates are newest first */

      const agg = async (tabKey) => {
        const tab = TABS[tabKey];
        /* from = to = the pinned date, so the aggregate is one snapshot even
           when the table beneath it spans several. */
        const w = buildWhere(tab, c, { from: asOf, to: asOf, deal: [], entity: [], account: [],
                                       institution: [], purpose: [], type: [], kind: [],
                                       cashSource: [], min: null, max: null, maturityBefore: null });
        const idCol = has(c, tab.rel, 'account_id') ? 'count(distinct v.account_id)::int' : 'count(*)::int';
        const rows = await q(
          `select coalesce(sum(v.balance), 0)::numeric as total,
                  ${idCol} as n,
                  coalesce(bool_and(v.is_verified), false) as all_verified
             from ${relationFor(tabKey)}
             ${w.sql}`, w.params);
        return rows[0] || { total: null, n: 0, all_verified: false };
      };

      let current = null;
      if (asOf) {
        const [cash, debt] = await Promise.all([agg('cash'), agg('debt')]);
        current = {
          as_of_date: asOf,
          year: Number(asOf.slice(0, 4)),
          quarter: Math.ceil(Number(asOf.slice(5, 7)) / 3),
          total_cash: cash.total,
          total_debt: debt.total,
          cash_accounts: cash.n,
          loan_accounts: debt.n,
          all_verified: cash.all_verified && debt.all_verified,
          /* So the screen can say which snapshot the tiles are pinned to,
             rather than quietly showing figures from a different day than the
             rows beneath them. */
          requested_from: f.from,
          requested_to: f.to,
          resolved: asOf,
          exact: !f.to || f.to === asOf,
          snapshots_in_range: inRange.length,
        };
      }

      res.json({
        quarters: dates.map(d => ({
          as_of: d, year: Number(d.slice(0, 4)), quarter: Math.ceil(Number(d.slice(5, 7)) / 3),
          label: 'Q' + Math.ceil(Number(d.slice(5, 7)) / 3) + ' ' + d.slice(0, 4),
        })),
        date_range: dates.length ? { min: dates[dates.length - 1], max: dates[0] } : null,
        current,
        requested_from: f.from,
        requested_to: f.to,
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

  /* The entity rollup: one row per entity, cash beside debt. */
  r.get('/summary/entities', async (req, res) => {
    try {
      const out = await fetchEntityRows(req);
      res.json({
        rows: out.rows,
        columns: ENTITY_COLUMNS,
        total_count: out.total,
        page: out.page,
        per_page: out.perPage,
        /* Over the FILTERED set, so the pinned totals row and the rows above
           it can never disagree. Cash and debt stay separate fields; `net` is
           a subtraction and is labelled Net Cash Position on screen, never
           equity — property values are not in this calculation. */
        totals: out.totals,
        as_of: out.asOf,
        snapshots_in_range: out.snapshotsInRange,
        /* Non-null when accounts exist with no owner entity. Those are dropped
           by the entity join, so without this the Cash Balance column cannot
           sum to the account-level tile and nothing says why. */
        unattributed: out.unattributed,
        problems: out.problems,
      });
    } catch (err) { fail(res, err); }
  });

  /* Each entity's own accounts, for the expanded row. Same shape the account
     tabs render, so the component is shared rather than rebuilt. */
  r.get('/summary/entities/:id/accounts', async (req, res) => {
    try {
      const c = await caps();
      const f = parseFilters(req);
      const dates = (await q(
        `select distinct as_of_date from public.account_balance
          where tenant_id = $1 order by as_of_date desc`, [TENANT_ID]
      )).map(x => isoDate(x.as_of_date));
      const inRange = dates.filter(d => (!f.from || d >= f.from) && (!f.to || d <= f.to));
      const asOf = inRange.length ? inRange[0] : null;
      if (!asOf) return res.json({ rows: [], as_of: null });

      const params = [TENANT_ID, req.params.id, asOf];
      const extra = [];
      /* The same account-level narrowing the rollup applied, so an expanded
         row adds up to the row it came from. */
      if (f.institution.length) {
        params.push(f.institution);
        extra.push(`and coalesce(fa.institution, '(none)') = any($${params.length}::text[])`);
      }
      if (f.purpose.length) {
        params.push(f.purpose);
        extra.push(`and fa.account_purpose = any($${params.length}::text[])`);
      }

      const rows = await q(
        `select fa.id as account_id, fa.name as account_name, fa.account_kind,
                fa.account_type, fa.account_purpose, fa.institution,
                fa.account_number_last4, fa.cash_source,
                ab.balance, ab.as_of_date, ab.is_verified, ab.source
           from public.financial_account fa
           join public.account_balance ab on ab.account_id = fa.id
          where fa.tenant_id = $1 and ab.tenant_id = $1
            and fa.owner_entity_id = $2::uuid
            and ab.as_of_date = $3::date
            ${extra.join('\n            ')}
          order by fa.account_kind, ab.balance desc nulls last`, params);
      res.json({ rows: rows.map(scrub), as_of: asOf });
    } catch (err) { fail(res, err); }
  });

  r.get('/summary/entities/export', async (req, res) => {
    const format = String(req.query.format || 'csv').toLowerCase() === 'xlsx' ? 'xlsx' : 'csv';
    try {
      const out = await fetchEntityRows(req, { all: true });
      const names = await idNames(out.filters);
      const meta = {
        exportedAt: new Date().toISOString(),
        exportedBy: exportedBy(req),
        filtersApplied: describeFilters(out.filters, names),
      };
      const cols = ENTITY_EXPORT_COLUMNS.concat(
        PROVENANCE.filter(([k]) => !ENTITY_EXPORT_COLUMNS.some(([e]) => e === k))
      );

      const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
      const name = `leavenwealth_cash_debt_summary_${out.asOf || 'no-snapshot'}_${stamp}.${format}`;

      console.log('[financials] export tab=entities format=%s rows=%d by=%s filters=%s',
                  format, out.rows.length, meta.exportedBy, meta.filtersApplied);

      res.set('Content-Disposition', `attachment; filename="${name}"`);

      /* The totals line travels with the file. This gets pasted into decks and
         emails, and a total carrying its own filter description is much harder
         to misread than a bare column of numbers. */
      const t = out.totals || { cash: 0, debt: 0, entities: 0 };
      const totalsLine = `Cash ${Number(t.cash).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` +
        ` | Debt ${Number(t.debt).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

      if (format === 'csv') {
        res.type('text/csv; charset=utf-8');
        res.write(
          '# LeavenWealth cash & debt summary\n' +
          `# Generated: ${meta.exportedAt} by ${meta.exportedBy}\n` +
          `# Dates: ${dateScope(out.filters)}${out.asOf ? ' (as at ' + out.asOf + ')' : ''}\n` +
          `# Filters: ${meta.filtersApplied}\n` +
          '# Figures unverified (is_verified = false on all source balances)\n' +
          `# Rows: ${out.rows.length}\n` +
          `# Totals: ${totalsLine}\n` +
          (out.unattributed
            ? `# NOTE: ${out.unattributed.accounts} account(s) have no owner entity and are NOT in these rows\n`
            : '')
        );
        const st = stringify({ header: true, columns: cols.map(([key, header]) => ({ key, header })) });
        st.on('error', () => res.end());
        st.pipe(res);
        for (const row of out.rows) {
          const rec = {};
          for (const [key] of cols) rec[key] = exportValue(ENTITY_TAB, key, row, meta);
          st.write(rec);
        }
        st.end();
        return;
      }

      res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      const wb = new ExcelJS.stream.xlsx.WorkbookWriter({ stream: res, useStyles: true });
      const ws = wb.addWorksheet('Cash & Debt', { views: [{ state: 'frozen', ySplit: 1 }] });
      ws.columns = cols.map(([key, header]) => ({
        header, key,
        width: Math.min(46, Math.max(12, header.length + 4)),
        style: ENTITY_TAB.money.includes(key) ? { numFmt: '#,##0.00;[Red](#,##0.00)' }
             : ENTITY_TAB.dates.includes(key) ? { numFmt: 'yyyy-mm-dd' } : {},
      }));
      ws.getRow(1).font = { bold: true };
      ws.getRow(1).commit();
      for (const row of out.rows) {
        const rec = {};
        for (const [key] of cols) rec[key] = exportValue(ENTITY_TAB, key, row, meta);
        ws.addRow(rec).commit();
      }
      ws.commit();

      const about = wb.addWorksheet('About');
      about.columns = [{ width: 22 }, { width: 96 }];
      /* Styled before commit: this is a streaming writer and a committed row
         is already serialised. */
      const title = about.addRow(['LeavenWealth cash & debt summary', '']);
      title.font = { bold: true, size: 13 };
      title.commit();
      [
        ['Generated', meta.exportedAt],
        ['Generated by', meta.exportedBy],
        ['Dates', dateScope(out.filters) + (out.asOf ? ' (as at ' + out.asOf + ')' : '')],
        ['Filters', meta.filtersApplied],
        ['Rows', out.rows.length],
        ['Totals', totalsLine],
        ['Status', 'Figures unverified (is_verified = false on all source balances)'],
      ].concat(out.unattributed
        ? [['Note', out.unattributed.accounts + ' account(s) have no owner entity and are NOT in these rows']]
        : []
      ).forEach(([k, v]) => about.addRow([k, v]).commit());
      about.commit();
      await wb.commit();
    } catch (err) {
      if (res.headersSent) return res.end();
      fail(res, err);
    }
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
    `# Dates: ${dateScope(out.filters)}\n` +
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
    ['Dates', dateScope(out.filters)],
    ['Filters', meta.filtersApplied],
    ['Rows', out.rows.length],
    ['Status', 'DRAFT - figures are unverified, pending Mitch Hagen'],
  ].forEach(([k, v]) => about.addRow([k, v]).commit());
  about.commit();

  await wb.commit();
}

module.exports = { financialsRoutes, TABS, NEVER_EXPOSE, arrayParam, describeFilters,
                   ENTITY_COLUMNS, ENTITY_EXPORT_COLUMNS, ENTITY_SORTS };
