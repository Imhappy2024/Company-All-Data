// ===========================================================================
// config/datasets.js — the curated dataset registry.
//
// One entry per reporting view. Screens and saved views may use ONLY the
// fields listed here, and the server builds every query from this file rather
// than from anything the browser sends.
//
// This is the allowlist that makes Phase 3 safe. A saved view stores field
// KEYS; the server looks each one up here to get the real column name and its
// type. A key that is not in this file never reaches a query, so there is no
// path from a stored config to arbitrary SQL — which is the whole reason the
// builder can let people compose filters at all.
//
// `column` is kept separate from `key` on purpose. The key is the contract
// with saved configs and must never change; the column underneath it can be
// renamed in the view without invalidating every view anyone saved. CLAUDE.md
// records what happens when a rename moves only one side of that line.
//
// Types drive formatting everywhere (Properties section and saved views share
// these), so a figure cannot be a currency on one screen and a bare number on
// another:
//   text | number | currency | percent | date | ratio
//
// A `percent` field holds a FRACTION (0.689 renders 68.9%). reporting.loan
// already multiplies interest_rate_pct by 100, so it is declared `number`
// with a % suffix rather than `percent` — declaring it percent would render
// 6.5% as 650%.
// ===========================================================================
'use strict';

// extra (all optional):
//   hidden      true -> filterable and sortable, not offered as a column.
//               A UI hint ONLY. A hidden field is still selectable by a
//               hand-edited config; anything that must not leave the server
//               belongs out of `fields` entirely, not behind `hidden`.
//   format      a date pattern, e.g. 'YYYY-MM'
//   suffix      appended after the formatted value, e.g. '%'
//   decimals    fixed decimal places for a number
//   unavailable why this field is always null; rendered in place of a value
const F = (key, label, type, extra) => Object.assign({ key, label, type, column: key }, extra || {});

// There is deliberately no boolean type. Flags (has_data, is_total, is_latest)
// are declared `text` so they render and filter as their stored value instead
// of becoming a checkbox that cannot express "not filtering".

const DATASETS = {
  property_month: {
    key: 'property_month',
    label: 'Monthly property financials',
    description: 'One row per property per month: income, expenses, NOI, debt service, occupancy and delinquency.',
    view: 'reporting.property_month',
    scope: { tenantColumn: 'tenant_id' },
    grain: 'property + month',
    defaultSort: [{ field: 'month', dir: 'desc' }],
    fields: [
      F('property_id', 'Property', 'text', { hidden: true }),
      F('month', 'Month', 'date', { format: 'YYYY-MM' }),
      F('accounting_basis', 'Basis', 'text'),
      F('has_data', 'Has data', 'text'),
      F('total_operating_income', 'Total operating income', 'currency'),
      F('total_operating_expense', 'Total operating expense', 'currency'),
      F('noi', 'Net operating income', 'currency'),
      F('rent_income', 'Rent income', 'currency'),
      F('capex', 'Capital expense', 'currency'),
      F('am_fee_booked', 'Asset management fee', 'currency'),
      F('interest', 'Interest', 'currency'),
      F('principal', 'Principal', 'currency'),
      F('debt_service', 'Debt service', 'currency'),
      F('debt_service_source', 'Debt service source', 'text'),
      F('unsplit_payment', 'Unsplit mortgage payment', 'currency'),
      F('dscr', 'DSCR', 'ratio'),
      // Interest on other debt - a line of credit or similar. Deliberately
      // NOT part of debt_service: every property carrying one also carries a
      // real Mortgage Interest line, so adding it would inflate debt service
      // and depress DSCR. Exposed so it can be looked at, never summed in.
      F('other_interest', 'Other interest (not in debt service)', 'currency'),
      F('loan_proceeds', 'Loan proceeds', 'currency'),
      F('loan_proceeds_note', 'Loan proceeds line', 'text'),
      F('cash_flow', 'Cash flow', 'currency'),
      F('units', 'Units', 'number'),
      F('occupied', 'Occupied', 'number'),
      F('vacant', 'Vacant', 'number'),
      F('physical_occupancy', 'Physical occupancy', 'percent'),
      F('economic_occupancy', 'Economic occupancy', 'percent'),
      F('market_rent_total', 'Market rent', 'currency'),
      F('rent_total', 'Rent', 'currency'),
      F('loss_to_lease', 'Loss to lease', 'currency'),
      F('delinquency', 'Delinquency', 'currency'),
      F('recurring_fee_income', 'Recurring fee income', 'currency'),
      F('non_recurring_fee_income', 'Non-recurring fee income', 'currency'),
      F('total_expected_income', 'Total expected income', 'currency'),
    ],
  },

  income_statement_line: {
    key: 'income_statement_line',
    label: 'Income statement lines',
    description: 'Account-by-account income statement, one row per account per month.',
    view: 'reporting.income_statement_line',
    scope: { tenantColumn: 'tenant_id' },
    grain: 'property + month + account',
    defaultSort: [{ field: 'month', dir: 'desc' }, { field: 'sort_order', dir: 'asc' }],
    fields: [
      F('property_id', 'Property', 'text', { hidden: true }),
      F('month', 'Month', 'date', { format: 'YYYY-MM' }),
      F('accounting_basis', 'Basis', 'text'),
      F('section', 'Section', 'text'),
      F('account_path', 'Account path', 'text'),
      F('depth', 'Depth', 'number'),
      F('line_label', 'Account', 'text'),
      F('is_total', 'Is total', 'text'),
      F('amount', 'Amount', 'currency'),
      F('sort_order', 'Order', 'number', { hidden: true }),
    ],
  },

  rent_roll_unit: {
    key: 'rent_roll_unit',
    label: 'Rent roll units',
    description: 'One row per unit on a rent roll.',
    view: 'reporting.rent_roll_unit',
    scope: { tenantColumn: 'tenant_id' },
    grain: 'property + as-of date + unit',
    defaultSort: [{ field: 'sort_order', dir: 'asc' }],
    fields: [
      F('property_id', 'Property', 'text', { hidden: true }),
      F('as_of_date', 'As of', 'date'),
      F('is_latest', 'Latest', 'text'),
      F('unit', 'Unit', 'text'),
      F('beds', 'Beds', 'number'),
      F('baths', 'Baths', 'number'),
      F('tenant', 'Tenant', 'text'),
      F('status', 'Status', 'text'),
      F('rent', 'Rent', 'currency'),
      F('market_rent', 'Market rent', 'currency'),
      F('balance_due', 'Balance due', 'currency'),
      F('lease_start', 'Lease start', 'date'),
      F('lease_end', 'Lease end', 'date'),
      F('square_feet', 'Sq ft', 'number'),
      F('sort_order', 'Order', 'number', { hidden: true }),
    ],
  },

  loan: {
    key: 'loan',
    label: 'Loans',
    description: 'One row per loan with its latest balance, rate, maturity and annual debt service.',
    view: 'reporting.loan',
    scope: { tenantColumn: 'tenant_id' },
    grain: 'loan (+ the property it secures)',
    defaultSort: [{ field: 'maturity_date', dir: 'asc' }],
    fields: [
      F('loan_id', 'Loan', 'text', { hidden: true }),
      F('property_id', 'Property', 'text', { hidden: true }),
      F('lender', 'Lender', 'text'),
      F('latest_balance', 'Balance', 'currency'),
      F('balance_as_of', 'Balance as of', 'date'),
      F('interest_rate_pct', 'Interest rate', 'number', { suffix: '%', decimals: 2 }),
      F('maturity_date', 'Maturity', 'date'),
      F('annual_debt_service', 'Annual debt service', 'currency'),
      F('status', 'Status', 'text'),
      F('purpose', 'Purpose', 'text'),
    ],
  },

  property_summary: {
    key: 'property_summary',
    label: 'Property summary',
    description: 'One row per property: units, occupancy, trailing twelve months, debt, DSCR and value.',
    view: 'reporting.property_summary',
    scope: { tenantColumn: 'tenant_id' },
    grain: 'property',
    defaultSort: [{ field: 'name', dir: 'asc' }],
    fields: [
      F('id', 'Property id', 'text', { hidden: true }),
      F('name', 'Property', 'text'),
      F('entity_name', 'Entity', 'text'),
      F('pm_company', 'PM company', 'text'),
      F('source_system', 'Source', 'text'),
      F('city', 'City', 'text'),
      F('state', 'State', 'text'),
      F('ownership_status', 'Ownership', 'text'),
      F('units', 'Units', 'number'),
      F('latest_occupancy', 'Occupancy', 'percent'),
      F('occupancy_as_of', 'Occupancy as of', 'date'),
      F('t12_income', 'Total income, T12', 'currency'),
      F('t12_expense', 'Total expenses, T12', 'currency'),
      F('t12_noi', 'NOI, T12', 'currency'),
      F('t12_net_income', 'Net income, T12', 'currency'),
      F('optimized_noi', 'Optimized NOI', 'currency'),
      F('expense_ratio', 'Expense ratio', 'percent'),
      F('debt', 'Debt', 'currency'),
      F('annual_debt_service', 'Annual debt service', 'currency'),
      F('trailing_dscr', 'DSCR, trailing', 'ratio'),
      F('value_on_file', 'Value on file', 'currency'),
      F('value_as_of', 'Value as of', 'date'),
      F('ltv', 'LTV', 'percent'),
      F('next_maturity', 'Next maturity', 'date'),
      F('t12_in_dropbox', 'T12 filed', 'text'),
      F('t12_file_name', 'T12 file', 'text'),
      F('t12_period_end', 'T12 period end', 'date'),
      F('rent_roll_in_dropbox', 'Rent roll filed', 'text'),
      F('rent_roll_file_name', 'Rent roll file', 'text'),
      F('rent_roll_as_of', 'Rent roll as of', 'date'),
    ],
  },

  am_fee_month: {
    key: 'am_fee_month',
    label: 'Asset management fees',
    description: 'Expected, received and variance per fee row per month.',
    view: 'reporting.am_fee_month',
    scope: { tenantColumn: 'tenant_id' },
    grain: 'fee row + month',
    defaultSort: [{ field: 'fee_month', dir: 'asc' }],
    fields: [
      F('schedule_id', 'Fee row id', 'text', { hidden: true }),
      F('label', 'Fee row', 'text'),
      F('manager_group', 'Manager', 'text'),
      F('payment_timing', 'Timing', 'text'),
      F('fee_month', 'Month', 'date', { format: 'YYYY-MM' }),
      F('expected', 'Expected', 'currency'),
      F('received', 'Received', 'currency'),
      F('received_source', 'Received source', 'text'),
      F('variance', 'Variance', 'currency'),
    ],
  },
};

const FILTER_OPS = ['eq', 'ne', 'in', 'gt', 'gte', 'lt', 'lte', 'between', 'contains', 'is_empty', 'not_empty'];
const AGGREGATES = ['sum', 'avg', 'min', 'max', 'count'];
const DISPLAY_TYPES = ['dashboard', 'spreadsheet', 'list', 'report'];

// A bare lowercase identifier: no quote, backslash, semicolon, space, dot or
// comment token can survive this. Anchored with no `m` flag, so a trailing
// newline is rejected too.
const SAFE_IDENTIFIER = /^[a-z_][a-z0-9_]*$/;
const SAFE_QUALIFIED = /^[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*$/;

function getDataset(key) { return Object.prototype.hasOwnProperty.call(DATASETS, key) ? DATASETS[key] : null; }

function getField(datasetKey, fieldKey) {
  const ds = getDataset(datasetKey);
  if (!ds) return null;
  return ds.fields.find(f => f.key === fieldKey) || null;
}

// The choke point between a stored config and a query. Returns the quoted
// column, or null — callers must treat null as "drop this field and tell the
// reader it is missing", never as "pass it through".
function safeColumn(datasetKey, fieldKey) {
  const f = getField(datasetKey, fieldKey);
  if (!f) return null;
  if (!SAFE_IDENTIFIER.test(f.column)) return null;  // belt and braces
  return '"' + f.column + '"';
}

// safeColumn cannot vet the relation: 'reporting.property_month' has a dot in
// it and would be rejected. Without this the FROM clause is the one piece of
// a generated query with no allowlist behind it.
function safeView(datasetKey) {
  const ds = getDataset(datasetKey);
  if (!ds || !SAFE_QUALIFIED.test(ds.view)) return null;
  const [schema, view] = ds.view.split('.');
  return '"' + schema + '"."' + view + '"';
}

// The server reads with SUPABASE_DB_URL, which is the postgres superuser, so
// RLS never runs and current_tenant_ids() is never called. Tenant scoping is
// this layer's job exactly as it is financials-api.js's. This THROWS rather
// than returning null: a missing scope must never degrade into "no filter".
function tenantColumn(datasetKey) {
  const ds = getDataset(datasetKey);
  if (!ds || !ds.scope || !ds.scope.tenantColumn) {
    throw new Error('dataset ' + datasetKey + ' declares no tenant scope');
  }
  if (!SAFE_IDENTIFIER.test(ds.scope.tenantColumn)) {
    throw new Error('dataset ' + datasetKey + ' has an unusable tenant column');
  }
  return '"' + ds.scope.tenantColumn + '"';
}

// Operators, aggregates and sort direction are identifiers too, and they get
// concatenated into SQL. Filter VALUES are always bound parameters and are
// never concatenated; this allowlist covers identifiers only.
const safeOp = op => (FILTER_OPS.indexOf(op) >= 0 ? op : null);
const safeAggregate = fn => (AGGREGATES.indexOf(fn) >= 0 ? fn.toUpperCase() : null);
const safeDir = dir => (String(dir).toLowerCase() === 'desc' ? 'DESC' : 'ASC');

// ---------------------------------------------------------------------------
// Load-time self-check. Every one of these failures is silent at runtime: a
// defaultSort naming a field that does not exist yields a dropped ORDER BY,
// which surfaces as rows in the wrong order rather than as an error. Throwing
// at require time means the process will not start wrong.
// ---------------------------------------------------------------------------
for (const [key, ds] of Object.entries(DATASETS)) {
  if (ds.key !== key) throw new Error('dataset ' + key + ' disagrees with its own key: ' + ds.key);
  if (!SAFE_QUALIFIED.test(ds.view)) throw new Error('dataset ' + key + ' has an unusable view name');
  if (!ds.scope || !ds.scope.tenantColumn) throw new Error('dataset ' + key + ' declares no tenant scope');
  const seen = new Set();
  for (const f of ds.fields) {
    if (seen.has(f.key)) throw new Error('dataset ' + key + ' declares ' + f.key + ' twice');
    seen.add(f.key);
    if (!SAFE_IDENTIFIER.test(f.column)) throw new Error(key + '.' + f.key + ' has an unusable column');
  }
  for (const s of ds.defaultSort || []) {
    if (!seen.has(s.field)) throw new Error('dataset ' + key + ' sorts by unknown field ' + s.field);
  }
}

// Frozen because getDataset and getField hand back the live objects. Anything
// that merged a user-authored config onto a field record would otherwise
// rewrite the allowlist process-wide, and safeColumn would then validate the
// mutated column. 'use strict' makes an attempted write throw.
const deepFreeze = o => {
  for (const k of Object.getOwnPropertyNames(o)) {
    const v = o[k];
    if (v && typeof v === 'object') deepFreeze(v);
  }
  return Object.freeze(o);
};
deepFreeze(DATASETS);
Object.freeze(FILTER_OPS); Object.freeze(AGGREGATES); Object.freeze(DISPLAY_TYPES);

module.exports = {
  DATASETS, FILTER_OPS, AGGREGATES, DISPLAY_TYPES,
  getDataset, getField, safeColumn, safeView, tenantColumn, safeOp, safeAggregate, safeDir,
};
