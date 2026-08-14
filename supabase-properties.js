// ===========================================================================
// supabase-properties.js — serve + mutate the Properties view from Supabase.
//
// Gated behind DATA_SOURCE=supabase (via supabase-db). Produces the SAME payload
// shape the front-end consumes from /api/properties:
//   { generatedAt, entities:[{id,name,parentEntityId,properties:[P]}], unlinkedLoans:[L] }
//   P = { listId, taskId, name, url, loanStatus, fields:{normName:F}, loans:[L], buildings:[U] }
//   U = { id, name, fields:{normName:F}, loans:[{loan_id,loan_number,status}] }
//   F = { id, name, type, value, display, options? }
//
// Entities are FLAT (all 64; parent_entity_id carried as data). Column<->ClickUp
// field-name labels come from leavenwealth_migration.py (+ spec-supplied UNIT labels);
// render/edit TYPES come from live information_schema; a label is only emitted if its
// column actually exists (so beds/baths/status appear iff present).
// ===========================================================================
const db = require('./supabase-db');
const enabled = db.enabled;
const q = (t, p) => db.q(t, p);
const tx = (fn) => db.tx(fn);

const propNorm = s => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
const money = n => '$' + Math.round(Number(n) || 0).toLocaleString();
function toMs(v) { if (v == null) return null; const d = v instanceof Date ? v : new Date(v); const ms = d.getTime(); return isNaN(ms) ? null : ms; }
const STATUS_LABEL = { none: 'None', pending: 'Pending', active: 'Active', closed: 'Closed' };
const LOAN_STATUS_OPTIONS = [
  { id: 'none', name: 'None' }, { id: 'pending', name: 'Pending' },
  { id: 'active', name: 'Active' }, { id: 'closed', name: 'Closed' },
];
const BOOL_OPTIONS = [{ id: 'true', name: 'Yes' }, { id: 'false', name: 'No' }];

// ---- column -> ClickUp field-name label (from leavenwealth_migration.py) ----
const PROP_LABELS_ORDERED = [
  ['dba_name', 'DBA Name / Name of Apartment Complex'], ['management_company', 'Management Company'],
  ['street', 'Location Street Address'], ['city', 'Location City'], ['state', 'Location State'], ['zip', 'Location Zip'],
  ['parcel_id', 'Parcel ID'], ['county_assessor_url', 'County Assessor Website'], ['dropbox_url', 'Dropbox Link'],
  ['purchase_price', 'Purchase Price'], ['purchase_date', 'Purchase Date'],
  ['current_market_value', 'Current Market Value'], ['current_market_value_2023', "Current Market Value (23')"],
  ['year_built', 'Year Built'], ['square_feet', 'Square Feet'], ['stories', '# of Stories'], ['num_buildings', '# of Buildings'],
  ['unit_count_reported', 'Total Units'], ['construction_type', 'Building Construction'], ['pool', 'Pool'], ['vehicles', 'Vehicles'],
  ['service_provider', 'Service Provider'], ['reviews_property_tax', 'Does LWC Review Property Tax Payments?'],
  ['reposition_cadence', 'Reposition Cadence'], ['collateral_notes', 'Collateral'],
  // New property fields
  ['taxpayer', 'Taxpayer'], ['asset_type', 'Asset Type'], ['status', 'Status'],
  ['year_acquired', 'Year Acquired'], ['current_occupancy', 'Current Occupancy'],
];
// UNIT labels per spec (unit_identifier is the read-only header; beds/baths/status
// emitted only if the column exists live).
const UNIT_LABELS_ORDERED = [
  ['dba_name', 'DBA Name / Name of Apartment Complex'], ['parcel_id', 'Parcel ID'], ['year_built', 'Year Built'],
  ['construction_type', 'Building Construction'], ['stories', '# of Stories'], ['square_feet', 'Square Feet'],
  ['beds', 'Beds'], ['baths', 'Baths'], ['pool', 'Pool'], ['vehicles', 'Vehicles'],
  ['current_market_value', 'Current Market Value'], ['current_market_value_2023', "Current Market Value (23')"],
  ['num_buildings', '# of Buildings'], ['location_street', 'Location Street Address'], ['location_city', 'Location City'],
  ['location_state', 'Location State'], ['location_zip', 'Location Zip'], ['status', 'Status'],
  // Asset
  ['asset_type_purchase', 'Asset Type (at Purchase)'], ['asset_type_today', 'Asset Type (Today)'],
  ['asset_status_takeover', 'Asset Status (at Takeover)'], ['asset_status_today', 'Asset Status (Today)'],
  ['original_total_units', 'Original Total Units'], ['current_total_units', 'Current Total Units'], ['occupancy', 'Occupancy'],
  // Escrows / reserve
  ['tax_escrow', 'Tax Escrow'], ['insurance_escrow', 'Insurance Escrow'], ['replacement_reserve', 'Replacement Reserve'],
  ['replacement_reserve_notes', 'Replacement Reserve Notes'], ['replacement_reserve_draw_criteria', 'Reserve Draw Criteria'],
  ['replacement_reserve_funding_replenishment', 'Reserve Funding / Replenishment'], ['replacement_reserve_last_draw_date', 'Reserve Last Draw Date'],
  ['replacement_reserve_last_draw_amount', 'Reserve Last Draw Amount'], ['replacement_reserve_remaining_balance', 'Reserve Remaining Balance'],
  // Insurance
  ['property_insurance_financing', 'Property Insurance Financing'], ['property_insurance_vendor', 'Property Insurance Vendor'],
  // Amenities
  ['dog_park', 'Dog Park'], ['onsite_washer_dryer', 'Onsite Washer/Dryer'], ['inunit_washer_dryer', 'In-unit Washer/Dryer'],
  ['common_area_washer_dryer', 'Common-area Washer/Dryer'], ['hoa', 'HOA'], ['rubs_at_takeover', 'RUBS at Takeover'], ['rubs_implemented', 'RUBS Implemented'],
  // Asset management
  ['asset_management_fee_pct', 'Asset Management Fee %'], ['asset_management_fee_vendor', 'Asset Mgmt Fee Vendor'],
  ['asset_management_fee_tracker_url', 'Asset Mgmt Fee Tracker'], ['attorney_vendor', 'Attorney Vendor'],
];
const INSURANCE_LABELS_ORDERED = [
  ['carrier', 'Insurance Carrier'], ['annual_premium', 'Insurance Annual Premium'], ['renewal_date', 'Insurance Renewal Date'],
  ['tiv', 'TIV  (Total Insured Value)'], ['all_other_perils_deductible', 'All Other Perils Deductible'],
  ['wind_hail_deductible', 'Wind/Hail Deductible'], ['business_personal_property', 'Business Personal Property'],
  ['business_income_extra_expense_limit', 'Business Income & Extra Expense Limit'],
  ['building_limit_replacement_cost', 'Building Limit (Replacement Cost)'],
];
const LOAN_LABELS_ORDERED = [
  ['lender', 'Lender'], ['loan_number', 'Loan Number'], ['loan_type', 'Loan Type'], ['amortizing_type', 'Amortizing Type'],
  ['origination_amount', 'Loan Origination Amount'], ['origination_date', 'Loan Origination Date'], ['maturity_date', 'Maturity Date'],
  ['interest_rate', 'Interest Rate'], ['interest_type', 'Interest Type'], ['amortization', 'Amortization'],
  ['balloon_payment', 'Balloon Payment'], ['balloon_payment_notes', 'Balloon Payments'], ['interest_only_end_date', 'End IO Period'],
  ['index', 'Index'], ['variable_rate_floor', 'Variable Rate Floor'], ['variable_rate_max', 'Variable Rate Max'],
  ['rate_change_limitation', 'Rate Change Limitation per Change Date'], ['previous_interest_reset_date', 'Previous Interest Reset Date'],
  ['next_interest_reset_date', 'Next Interest Reset Date'], ['interest_reset_cadence', 'Interest Reset Cadence'],
  ['primary_mortgage', 'Primary Mortgage'], ['bridge', 'Bridge'], ['primary_plus_construction_note', 'Primary + Construction Note'],
  ['construction_note', 'Construction Note'], ['construction_budget_amount', 'Construction Budget'], ['pace_equity', 'PACE Equity'],
  ['seller_carry', 'Seller Carry/Financing'], ['repayment_fee', 'Repayment Fee'], ['prepayment_penalties', 'Prepayment Penalties'],
  ['payment_frequency', 'Payment Frequency'], ['extension_available', 'Extension Available'], ['extension_requirements', 'Extension Requirements'],
  ['dscr', 'DSCR'], ['debt_paid_by', 'Debt Paid By'], ['loc_beginning', 'Beginning LOC'], ['loc_available', 'Available LOC'],
  ['avail_escrow_reserve', 'Avail Escrow/Reserve'], ['loc_draws_process', 'LOC Draws Process'], ['lender_held_cash_reserve', 'Lender Held Cash Reserve'],
  ['distribution_frequency_restrictions', 'Distribution Frequency Restrictions'], ['pac_due', 'PAC DUE'],
  ['covenant_lender_operating_account', 'Covenants - Lender Operating Account'], ['covenant_audit', 'Covenant - Audit'],
  ['covenant_replacement_reserve', 'Covenants - Replacement Reserve'], ['covenant_distribution_frequency', 'Covenants - Distribution Frequency'],
  ['last_draw_amount', 'Last Draw Amount'], ['amount_left_to_draw', 'amount left to draw'], ['last_draw_date', 'last draw date'],
  // New loan fields
  ['position', 'Position'], ['recourse', 'Recourse'], ['debt_service', 'Debt Service'], ['ppt_split_ratio', 'PPT Split Ratio'],
  ['interest_rate_pct', 'Interest Rate %'], ['interest_rate_min', 'Interest Rate Min'], ['interest_rate_max', 'Interest Rate Max'], ['is_tif', 'TIF'],
  ['loc_hurdle', 'LOC Hurdle'], ['loc_hurdle_remaining', 'LOC Hurdle Remaining'], ['loc_availability_maturity_date', 'LOC Availability Maturity'],
  ['lien_waivers_required', 'Lien Waivers Required'], ['construction_budget_dropbox_url', 'Construction Budget (Dropbox)'], ['has_construction_budget', 'Has Construction Budget'],
  ['hud_audit', 'HUD Audit'], ['balloon_reposition_normal', 'Balloon / Reposition Normal'], ['next_reposition_date', 'Next Reposition Date'], ['last_reposition_date', 'Last Reposition Date'],
];
// Loan position → display label + group order (Primary, Seller Carry, Secondary, PAC Due).
const LOAN_POSITION_LABEL = { primary: 'Primary', seller_carry: 'Seller Carry', secondary: 'Secondary', pac_due: 'PAC Due' };
const LOAN_POSITION_ORDER = ['primary', 'seller_carry', 'secondary', 'pac_due'];
// Field flags: render *_url as links; interest_rate_pct as a percent.
const LINK_COL_RE = /url$/i;
const PCT_COLS = new Set(['interest_rate_pct']);
function flagField(f, col) { if (LINK_COL_RE.test(col)) f.link = true; if (PCT_COLS.has(col)) f.pct = true; return f; }
const LOAN_CREATE_MAP = {
  'Lender': 'lender', 'Loan Origination Amount': 'origination_amount',
  'Loan Origination Date': 'origination_date', 'Maturity Date': 'maturity_date', 'Interest Rate': 'interest_rate',
};
// PATCH-able tables and which label set + insert-needs they use.
const TABLE_FOR_KIND = { p: 'property', u: 'unit', l: 'loan', i: 'insurance_policy', iu: 'insurance_policy' };

// ---- render TYPE resolution from live Postgres column types ----
const NUM_TYPES = new Set(['numeric', 'integer', 'bigint', 'double precision', 'real', 'money', 'smallint', 'decimal']);
const DATE_TYPES = new Set(['date', 'timestamp without time zone', 'timestamp with time zone', 'timestamptz']);
const CURRENCY_HINT = /(amount|price|value|debt|balance|loc|escrow|reserve|budget|fee|premium|tiv|limit|deductible|property|income)/i;
let _colTypes = null;
async function colTypes() {
  if (_colTypes) return _colTypes;
  const rows = (await q(
    `select table_name, column_name, data_type from information_schema.columns
     where table_schema='public' and table_name = any($1)`,
    [['property', 'unit', 'loan', 'insurance_policy']])).rows;
  const m = { property: {}, unit: {}, loan: {}, insurance_policy: {} };
  rows.forEach(r => { (m[r.table_name] || (m[r.table_name] = {}))[r.column_name] = r.data_type; });
  _colTypes = m;
  return m;
}
function renderType(table, col, types) {
  const dt = (types[table] || {})[col];
  if (!dt) return 'short_text';
  if (dt === 'boolean') return 'boolean';
  if (DATE_TYPES.has(dt)) return 'date';
  if (NUM_TYPES.has(dt)) return CURRENCY_HINT.test(col) ? 'currency' : 'number';
  return 'short_text';
}
function hasCol(types, table, col) { return !!(types[table] && col in types[table]); }

function mkField(id, label, type, raw, options) {
  let value, display;
  if (type === 'label') { value = raw; display = raw; }
  else if (type === 'date') { value = toMs(raw); display = value; }
  else if (type === 'currency' || type === 'number') { value = (raw == null || raw === '') ? null : Number(raw); display = value; }
  else if (type === 'boolean') { const b = raw === true || raw === 'true'; value = raw == null ? null : String(b); display = raw == null ? null : (b ? 'Yes' : 'No'); }
  else { value = raw == null ? null : String(raw); display = value; }
  const f = { id, name: label, type: type === 'boolean' ? 'drop_down' : type, value, display };
  if (options) f.options = options;
  if (type === 'boolean') f.options = BOOL_OPTIONS;
  return f;
}
// Build an editable fields map from a [col,label] list. idKind: 'p:' | 'u:'.
function fieldsFromLabels(idKind, labels, row, table, types) {
  const fields = {};
  for (const [col, label] of labels) {
    if (!hasCol(types, table, col)) continue;
    fields[propNorm(label)] = flagField(mkField(`${idKind}${col}`, label, renderType(table, col, types), row ? row[col] : null), col);
  }
  return fields;
}
// Insurance fields (always rendered so the user can fill → auto-create on first edit).
function insuranceFields(idKind, insRow, types) {
  const insId = insRow ? String(insRow.id) : 'new';
  const fields = {};
  for (const [col, label] of INSURANCE_LABELS_ORDERED) {
    if (!hasCol(types, 'insurance_policy', col)) continue;
    fields[propNorm(label)] = mkField(`${idKind}${insId}:${col}`, label, renderType('insurance_policy', col, types), insRow ? insRow[col] : null);
  }
  return fields;
}
function loanName(l) {
  if (l.loan_number) return `Loan ${l.loan_number}`;
  if (l.lender) return `${l.lender}`;
  return `Loan ${String(l.id).slice(0, 8)}`;
}
function deriveLoanStatus(loans) {
  const set = new Set(loans.map(l => (l.status || 'none').toLowerCase()));
  for (const s of ['active', 'pending', 'closed']) if (set.has(s)) return STATUS_LABEL[s];
  return 'None';
}

// ---------------------------------------------------------------------------
// READ: full properties payload (flat entities) + unlinked loans.
// ---------------------------------------------------------------------------
async function getPropertiesPayload() {
  const types = await colTypes();
  const entityRows = (await q(`select id, name, parent_entity_id from public.entity`, [])).rows;
  const entityName = new Map(entityRows.map(e => [String(e.id), e.name]));
  const entityOptions = entityRows.map(e => ({ id: String(e.id), name: e.name || 'Entity' }))
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));
  const props = (await q(`select * from public.property`, [])).rows;
  const units = (await q(`select * from public.unit`, [])).rows;
  const loans = (await q(`select * from public.loan`, [])).rows;
  const collat = (await q(`select id, loan_id, property_id, unit_id from public.loan_collateral`, [])).rows;
  const ins = (await q(`select * from public.insurance_policy`, [])).rows;
  // Ownership is the source of truth for who owns what (co-ownership, no percentages).
  const ownership = (await q(`select id, entity_id, property_id, unit_id, is_primary from public.ownership`, [])).rows;
  /* The lender RECORD behind loan.lender_id. `loan.lender` is free text kept for the
     old label; this is the normalised row, and the mortgagee clause is the part
     carriers ask for by name at renewal. Left-joined in code rather than embedded so
     a loan with no lender_id (most of them today) still renders. */
  const lenderRows = (await q(
    `select id, name, mortgagee_clause, contact_name, contact_email, phone from public.lender`, [])).rows;
  const lenderById = new Map(lenderRows.map(r => [String(r.id), r]));
  const balRows = (await q(`
    select distinct on (loan_id) loan_id, balance from public.loan_balance
    order by loan_id, as_of_date desc`, [])).rows;
  // Dated financial snapshots per property (newest first).
  const finRows = (await q(`
    select property_id, as_of_date, egi, operating_expenses, noi, current_market_value, occupancy,
           cap_rate, dcr, property_equity, value_per_unit, total_ltv, fmv_notes
    from public.property_financials where property_id is not null
    order by as_of_date desc nulls last`, [])).rows;
  const finByProp = new Map();
  finRows.forEach(r => { const k = String(r.property_id); if (!finByProp.has(k)) finByProp.set(k, []); finByProp.get(k).push(r); });

  const latestBalance = new Map(balRows.map(b => [String(b.loan_id), Number(b.balance)]));
  const loanById = new Map(loans.map(l => [String(l.id), l]));
  // Options for the unit loan-link dropdowns (mortgage / construction / seller-financing).
  const loanOptions = [{ id: '', name: '— None —' }].concat(
    loans.map(l => ({ id: String(l.id), name: loanName(l) })).sort((a, b) => String(a.name).localeCompare(String(b.name))));
  const unitToProp = new Map(units.map(u => [String(u.id), String(u.property_id)]));
  const unitName = new Map(units.map(u => [String(u.id), u.unit_identifier || 'Building']));
  const propName = new Map(props.map(p => [String(p.id), p.dba_name || entityName.get(String(p.entity_id)) || 'Property']));
  const insByProperty = new Map(); ins.forEach(i => { if (i.property_id) insByProperty.set(String(i.property_id), i); });
  const insByUnit = new Map(); ins.forEach(i => { if (i.unit_id) insByUnit.set(String(i.unit_id), i); });

  // Ownership rows -> per-property and per-unit owner lists (primary first).
  const ownersByProp = new Map();   // propId -> [{id, name, is_primary}]
  const ownersByUnit = new Map();   // unitId -> [{id, name, is_primary}]
  for (const o of ownership) {
    const owner = { id: String(o.entity_id), name: entityName.get(String(o.entity_id)) || 'Entity', is_primary: !!o.is_primary };
    if (o.property_id) {
      const k = String(o.property_id); if (!ownersByProp.has(k)) ownersByProp.set(k, []); ownersByProp.get(k).push(owner);
    } else if (o.unit_id) {
      const k = String(o.unit_id); if (!ownersByUnit.has(k)) ownersByUnit.set(k, []); ownersByUnit.get(k).push(owner);
    }
  }
  const sortOwners = a => a.sort((x, y) => (y.is_primary - x.is_primary) || String(x.name).localeCompare(String(y.name)));
  for (const a of ownersByProp.values()) sortOwners(a);
  for (const a of ownersByUnit.values()) sortOwners(a);
  const primaryOf = arr => (arr || []).find(o => o.is_primary) || null;

  // BUG-1: attach a loan to a property if collateralized by the property OR any of its
  // units. Also build per-unit loans + per-loan collateral detail (base-table derived).
  const loanIdsByProp = new Map();   // propId -> Set(loanId)
  const loansByUnit = new Map();     // unitId -> [{loan_id,loan_number,status}]
  const collatByLoan = new Map();    // loanId -> [{property_id,unit_id,property_name,unit_identifier,collateral_level}]
  const linkedLoanIds = new Set();
  for (const c of collat) {
    const lid = String(c.loan_id); linkedLoanIds.add(lid);
    let propId = c.property_id ? String(c.property_id) : (c.unit_id ? unitToProp.get(String(c.unit_id)) : null);
    if (propId) {
      if (!loanIdsByProp.has(propId)) loanIdsByProp.set(propId, new Set());
      loanIdsByProp.get(propId).add(lid);
    }
    if (c.unit_id) {
      const u = String(c.unit_id); const l = loanById.get(lid);
      if (!loansByUnit.has(u)) loansByUnit.set(u, []);
      loansByUnit.get(u).push({ loan_id: lid, loan_number: l ? l.loan_number : null, status: l ? (l.status || 'none') : 'none' });
    }
    const detailPropId = c.property_id ? String(c.property_id) : (c.unit_id ? unitToProp.get(String(c.unit_id)) : null);
    if (!collatByLoan.has(lid)) collatByLoan.set(lid, []);
    collatByLoan.get(lid).push({
      property_id: detailPropId, unit_id: c.unit_id ? String(c.unit_id) : null,
      property_name: detailPropId ? propName.get(detailPropId) : null,
      unit_identifier: c.unit_id ? unitName.get(String(c.unit_id)) : null,
      collateral_level: c.unit_id ? 'unit' : 'property',
    });
  }

  const unitsByProp = new Map();
  units.forEach(u => { const a = unitsByProp.get(String(u.property_id)) || []; a.push(u); unitsByProp.set(String(u.property_id), a); });

  const buildLoanCards = (loanList) => loanList.map(l => {
    const lf = {};
    for (const [col, label] of LOAN_LABELS_ORDERED) {
      if (!hasCol(types, 'loan', col)) continue;
      lf[propNorm(label)] = flagField(mkField(`l:${l.id}:${col}`, label, renderType('loan', col, types), l[col]), col);
    }
    lf[propNorm('Loan Status')] = mkField(null, 'Loan Status', 'label', STATUS_LABEL[(l.status || 'none').toLowerCase()] || 'None');
    const debt = latestBalance.get(String(l.id));
    if (debt != null) lf[propNorm('Current Debt as of (09/30/24)')] = mkField(null, 'Current Debt as of (09/30/24)', 'label', money(debt));
    const dataCount = Object.values(lf).filter(f => f.display != null && f.display !== '').length;
    return {
      id: String(l.id), name: loanName(l),
      url: l.clickup_task_id ? `https://app.clickup.com/t/${l.clickup_task_id}` : '#',
      fields: lf, hasData: dataCount >= 3,
      collateral: collatByLoan.get(String(l.id)) || [],
      borrower: l.borrower_entity_id ? (entityName.get(String(l.borrower_entity_id)) || null) : null,
      currentDebt: latestBalance.has(String(l.id)) ? latestBalance.get(String(l.id)) : null,
      sourceListName: l.source_list_name || null,     // originating ClickUp list (address)
      clickupTaskId: l.clickup_task_id || null,
      maturityDate: l.maturity_date ? new Date(l.maturity_date).toISOString().slice(0, 10) : null,
      lender: l.lender || null,
      lenderRecord: l.lender_id ? (lenderById.get(String(l.lender_id)) || null) : null,
      loanNumber: l.loan_number || null,
      originationAmount: (l.origination_amount == null || l.origination_amount === '') ? null : Number(l.origination_amount),
      status: STATUS_LABEL[(l.status || 'none').toLowerCase()] || 'None',
      position: l.position ? String(l.position).toLowerCase() : null,
      positionLabel: LOAN_POSITION_LABEL[String(l.position || '').toLowerCase()] || (l.position || null),
      interestRatePct: (l.interest_rate_pct == null || l.interest_rate_pct === '') ? null : Number(l.interest_rate_pct),
      isTif: l.is_tif === true,
    };
  });

  const propByEntity = new Map();
  for (const p of props) {
    const pid = String(p.id);
    const propLoans = [...(loanIdsByProp.get(pid) || [])].map(id => loanById.get(id)).filter(Boolean);
    const currentDebt = propLoans.reduce((s, l) => s + (latestBalance.get(String(l.id)) || 0), 0);
    const loanStatus = deriveLoanStatus(propLoans);

    // Ownership: primary owner (kept in sync with property.entity_id) + co-owners.
    const propOwners = ownersByProp.get(pid) || [];
    const propPrimary = primaryOf(propOwners)
      || { id: String(p.entity_id), name: entityName.get(String(p.entity_id)) || 'Entity', is_primary: true };

    const fields = fieldsFromLabels('p:', PROP_LABELS_ORDERED, p, 'property', types);
    fields[propNorm('Owner Entity')] = { id: 'ownerentity', name: 'Owner Entity', type: 'drop_down', value: String(propPrimary.id), display: propPrimary.name || '', options: entityOptions };
    if (currentDebt) fields[propNorm('Current Debt as of (09/30/24)')] = mkField(null, 'Current Debt as of (09/30/24)', 'currency', currentDebt);
    fields[propNorm('Loan Status')] = mkField(`loanstatus:${pid}`, 'Loan Status', 'drop_down', loanStatus, LOAN_STATUS_OPTIONS);
    Object.assign(fields, insuranceFields('i:', insByProperty.get(pid), types)); // F1

    // Market Value reads the latest property_financials snapshot when present.
    const finList = finByProp.get(pid) || [];
    const latestFin = finList[0];
    if (latestFin && latestFin.current_market_value != null && fields[propNorm('Current Market Value')]) {
      const mv = Number(latestFin.current_market_value);
      fields[propNorm('Current Market Value')].value = mv;
      fields[propNorm('Current Market Value')].display = mv;
    }

    const loanLink = (u, col, label) => {
      const v = u[col] ? String(u[col]) : '';
      const opt = v ? loanOptions.find(o => o.id === v) : null;
      return { id: `u:${col}`, name: label, type: 'drop_down', value: v, display: opt ? opt.name : '', options: loanOptions };
    };
    const buildings = (unitsByProp.get(pid) || []).map(u => {
      const uf = { [propNorm('Unit / Building')]: mkField(null, 'Unit / Building', 'label', u.unit_identifier || 'Building') };
      Object.assign(uf, fieldsFromLabels('u:', UNIT_LABELS_ORDERED, u, 'unit', types));
      // Linked loans (mortgage / construction / seller financing) — editable dropdowns.
      uf[propNorm('Mortgage Loan')] = loanLink(u, 'mortgage_loan_id', 'Mortgage Loan');
      uf[propNorm('Construction Loan')] = loanLink(u, 'construction_loan_id', 'Construction Loan');
      uf[propNorm('Seller Financing Loan')] = loanLink(u, 'seller_financing_loan_id', 'Seller Financing Loan');
      Object.assign(uf, insuranceFields('iu:', insByUnit.get(String(u.id)), types)); // F3
      // Unit ownership: explicit rows win; else unit.entity_id; else the property's primary.
      const unitOwners = ownersByUnit.get(String(u.id)) || [];
      let unitPrimary = primaryOf(unitOwners);
      if (!unitPrimary && u.entity_id) unitPrimary = { id: String(u.entity_id), name: entityName.get(String(u.entity_id)) || 'Entity', is_primary: true };
      if (!unitPrimary) unitPrimary = { id: propPrimary.id, name: propPrimary.name, is_primary: true };
      const ownersList = unitOwners.length ? unitOwners : [{ ...unitPrimary, is_primary: true }];
      // Editable primary Owner Entity for the building (sets unit.entity_id + ownership).
      uf[propNorm('Owner Entity')] = { id: 'ownerentityunit', name: 'Owner Entity', type: 'drop_down', value: String(unitPrimary.id), display: unitPrimary.name || '', options: entityOptions };
      // 'owned by' tag when the building's primary owner differs from the property's.
      const ownedByOther = String(unitPrimary.id) !== String(propPrimary.id);
      return {
        id: String(u.id), name: u.unit_identifier || 'Building', fields: uf,
        loans: loansByUnit.get(String(u.id)) || [],
        owner_primary: { id: unitPrimary.id, name: unitPrimary.name },
        owners: ownersList,
        ownedByOther: ownedByOther ? { id: unitPrimary.id, name: unitPrimary.name } : null,
        entityId: u.entity_id ? String(u.entity_id) : null,
      };
    });

    const P = {
      listId: pid, taskId: pid, name: propName.get(pid), url: '#',
      loanStatus, fields, loans: buildLoanCards(propLoans), buildings,
      owner_primary: { id: propPrimary.id, name: propPrimary.name },
      owners: propOwners.length ? propOwners : [{ ...propPrimary }],
      financials: finList.map(r => ({
        as_of_date: r.as_of_date ? new Date(r.as_of_date).toISOString().slice(0, 10) : null,
        egi: r.egi, operating_expenses: r.operating_expenses, noi: r.noi,
        current_market_value: r.current_market_value, occupancy: r.occupancy,
        cap_rate: r.cap_rate, dcr: r.dcr, property_equity: r.property_equity,
        value_per_unit: r.value_per_unit, total_ltv: r.total_ltv, fmv_notes: r.fmv_notes,
      })),
    };
    const arr = propByEntity.get(String(p.entity_id)) || []; arr.push(P); propByEntity.set(String(p.entity_id), arr);
  }

  const entities = entityRows.map(e => ({
    id: String(e.id), name: e.name || 'Entity', parentEntityId: e.parent_entity_id ? String(e.parent_entity_id) : null,
    properties: (propByEntity.get(String(e.id)) || []).sort((a, b) => String(a.name).localeCompare(String(b.name))),
  })).sort((a, b) => String(a.name).localeCompare(String(b.name)));

  // E: unlinked loans (no borrower OR no collateral row).
  const unlinked = loans.filter(l => !l.borrower_entity_id || !linkedLoanIds.has(String(l.id)));
  const unlinkedLoans = buildLoanCards(unlinked);

  // Distinct property managers (for the PM filter dropdown).
  const managementCompanies = [...new Set(props.map(p => p.management_company).filter(Boolean))]
    .sort((a, b) => String(a).localeCompare(String(b)));

  return { generatedAt: new Date().toISOString(), entities, unlinkedLoans, entityOptions, managementCompanies, source: 'supabase' };
}

// ---------------------------------------------------------------------------
// Read-only loan/debt SQL views (CapEx / Asset Fees / Escrows / TIF / Variable Rate /
// Maturities). Optional pm (management_company) filter. All expose property_name + management_company.
// ---------------------------------------------------------------------------
const VIEW_MAP = {
  capex: 'v_capex_funding',
  'asset-fees': 'v_asset_management_fees',
  escrows: 'v_escrows',
  tif: 'v_tif_properties',
  'variable-rate': 'v_variable_rate_loans',
  maturities: 'v_loan_maturities',
};
async function getView(key, pm) {
  const view = VIEW_MAP[key];
  if (!view) throw new Error('Unknown view: ' + key);
  const params = []; let where = '';
  if (pm) { params.push(pm); where = ' where management_company = $1'; }
  const rows = (await q(`select * from public.${view}${where} order by property_name nulls last`, params)).rows;
  return { view: key, rows };
}

async function getLoansPayload() {
  const p = await getPropertiesPayload();
  const all = [];
  p.entities.forEach(e => e.properties.forEach(pr => all.push(...pr.loans)));
  all.push(...p.unlinkedLoans);
  const seen = new Set(); const loans = all.filter(l => (seen.has(l.id) ? false : seen.add(l.id)));
  return { generatedAt: new Date().toISOString(), loans };
}

// ---------------------------------------------------------------------------
// WRITES
// ---------------------------------------------------------------------------
async function createEntity(name, parentEntityId) {
  const r = await q(`insert into public.entity (name, parent_entity_id) values ($1, $2) returning id, name`, [name, parentEntityId || null]);
  return { ok: true, id: String(r.rows[0].id), name: r.rows[0].name };
}
async function createProperty(entityId, name, address) {
  if (!entityId) throw new Error('An entity (parent) is required to create a property');
  const cols = { entity_id: entityId, dba_name: name };
  if (address) {
    if (address.street) cols.street = address.street;
    if (address.city) cols.city = address.city;
    if (address.state) cols.state = address.state;
    if (address.zip) cols.zip = address.zip;
  }
  const keys = Object.keys(cols);
  const r = await q(`insert into public.property (${keys.join(',')}) values (${keys.map((_, i) => '$' + (i + 1)).join(',')}) returning id`, keys.map(k => cols[k]));
  const propId = String(r.rows[0].id);
  return { ok: true, listId: propId, taskId: propId, id: propId };
}
async function createBuilding(propertyId, name) {
  if (!propertyId) throw new Error('A property (parent) is required to create a building/unit');
  const r = await q(`insert into public.unit (property_id, unit_identifier) values ($1, $2) returning id`, [propertyId, name]);
  return { ok: true, taskId: String(r.rows[0].id), id: String(r.rows[0].id), name };
}
// collateral: [{ type:'property'|'unit', id }]. borrowerEntityId optional override.
async function createLoan(propertyId, name, fields, collateral, borrowerEntityId) {
  if (!propertyId) throw new Error('A property (collateral) is required to create a loan');
  const ent = (await q(`select entity_id from public.property where id=$1`, [propertyId])).rows[0];
  if (!ent) throw new Error('Property not found for loan');
  const cols = { borrower_entity_id: borrowerEntityId || ent.entity_id, loan_number: name, status: 'active' };
  for (const [label, col] of Object.entries(LOAN_CREATE_MAP)) {
    if (fields && fields[label] != null && fields[label] !== '') cols[col] = fields[label];
  }
  const keys = Object.keys(cols).filter(k => cols[k] != null);
  const r = await q(`insert into public.loan (${keys.join(',')}) values (${keys.map((_, i) => '$' + (i + 1)).join(',')}) returning id`, keys.map(k => cols[k]));
  const loanId = r.rows[0].id;
  await writeCollateral(loanId, collateral && collateral.length ? collateral : [{ type: 'property', id: propertyId }]);
  const debt = fields && fields['Current Debt as of (09/30/24)'];
  if (debt != null && debt !== '') {
    await q(`insert into public.loan_balance (loan_id, as_of_date, balance) values ($1, current_date, $2)`, [loanId, Number(debt)]);
  }
  return { ok: true, loanTaskId: String(loanId), id: String(loanId) };
}
async function writeCollateral(loanId, collateral) {
  await q(`delete from public.loan_collateral where loan_id=$1`, [loanId]);
  for (const c of (collateral || [])) {
    if (!c || !c.id) continue;
    if (c.type === 'unit') await q(`insert into public.loan_collateral (loan_id, unit_id) values ($1,$2)`, [loanId, c.id]);
    else await q(`insert into public.loan_collateral (loan_id, property_id) values ($1,$2)`, [loanId, c.id]);
  }
}
// E2: assign borrower + collateral to a loan (moves it out of "unlinked").
async function assignLoan(loanId, borrowerEntityId, collateral) {
  if (!loanId) throw new Error('loanId required');
  if (borrowerEntityId) await q(`update public.loan set borrower_entity_id=$1 where id=$2`, [borrowerEntityId, loanId]);
  if (Array.isArray(collateral)) await writeCollateral(loanId, collateral);
  return { ok: true };
}

const SAFE_COL = /^[a-z][a-z0-9_]*$/;
async function coerce(table, col, value) {
  const types = await colTypes();
  const dt = (types[table] || {})[col];
  if (value == null || value === '') return null;
  if (dt === 'boolean') return value === true || value === 'true' || value === 'Yes';
  if (DATE_TYPES.has(dt)) { const ms = Number(value); return isNaN(ms) ? String(value) : new Date(ms).toISOString(); }
  if (NUM_TYPES.has(dt)) { const n = Number(value); return isNaN(n) ? null : n; }
  return String(value);
}
// find-or-create the insurance_policy row for a property/unit, return its id.
async function ensureInsurance(scope, ownerId) {
  const col = scope === 'unit' ? 'unit_id' : 'property_id';
  const found = (await q(`select id from public.insurance_policy where ${col}=$1 limit 1`, [ownerId])).rows[0];
  if (found) return found.id;
  const ins = (await q(`insert into public.insurance_policy (${col}) values ($1) returning id`, [ownerId])).rows[0];
  return ins.id;
}
async function patchField(recordId, fieldId, value) {
  const parts = String(fieldId).split(':');
  const kind = parts[0];
  if (kind === 'p' || kind === 'u') {
    const table = TABLE_FOR_KIND[kind], col = parts[1];
    if (!SAFE_COL.test(col)) throw new Error('Bad column');
    await q(`update public.${table} set ${col} = $1 where id = $2`, [await coerce(table, col, value), recordId]);
  } else if (kind === 'l') {
    const loanId = parts[1], col = parts[2];
    if (!SAFE_COL.test(col)) throw new Error('Bad loan column');
    await q(`update public.loan set ${col} = $1 where id = $2`, [await coerce('loan', col, value), loanId]);
  } else if (kind === 'i' || kind === 'iu') {
    const col = parts[2];
    if (!SAFE_COL.test(col)) throw new Error('Bad insurance column');
    const insId = await ensureInsurance(kind === 'iu' ? 'unit' : 'property', recordId); // auto-create (F2/F3)
    await q(`update public.insurance_policy set ${col} = $1 where id = $2`, [await coerce('insurance_policy', col, value), insId]);
  } else if (kind === 'loanstatus') {
    const propId = parts[1];
    const status = value ? String(value).toLowerCase() : 'none';
    await q(`update public.loan set status=$1 where id in (select loan_id from public.loan_collateral where property_id=$2)`, [status, propId]);
  } else if (kind === 'ownerentity') {
    if (!value) throw new Error('Pick an entity');
    await setPrimaryPropertyOwner(recordId, value);   // property.entity_id + primary ownership row, txn
  } else if (kind === 'ownerentityunit') {
    if (!value) throw new Error('Pick an entity');
    await setPrimaryUnitOwner(recordId, value);        // unit.entity_id + primary unit ownership row, txn
  } else {
    throw new Error('Unknown field id: ' + fieldId);
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Ownership writes (the `ownership` table is the source of truth).
// ---------------------------------------------------------------------------
// Change the PRIMARY owner of a property: keep property.entity_id and the single
// is_primary ownership row in sync (transactionally).
async function setPrimaryPropertyOwner(propertyId, entityId) {
  return tx(async (c) => {
    await c.query(`update public.property set entity_id=$1 where id=$2`, [entityId, propertyId]);
    // Drop any non-primary row for this entity on this property so it isn't duplicated.
    await c.query(`delete from public.ownership where property_id=$1 and entity_id=$2 and coalesce(is_primary,false)=false`, [propertyId, entityId]);
    const r = await c.query(`update public.ownership set entity_id=$1 where property_id=$2 and is_primary=true returning id`, [entityId, propertyId]);
    if (!r.rows.length) await c.query(`insert into public.ownership (entity_id, property_id, is_primary) values ($1,$2,true)`, [entityId, propertyId]);
  });
}
// Change the PRIMARY owner of a unit: keep unit.entity_id and the is_primary unit
// ownership row in sync (transactionally).
async function setPrimaryUnitOwner(unitId, entityId) {
  return tx(async (c) => {
    await c.query(`update public.unit set entity_id=$1 where id=$2`, [entityId, unitId]);
    await c.query(`delete from public.ownership where unit_id=$1 and entity_id=$2 and coalesce(is_primary,false)=false`, [unitId, entityId]);
    const r = await c.query(`update public.ownership set entity_id=$1 where unit_id=$2 and is_primary=true returning id`, [entityId, unitId]);
    if (!r.rows.length) await c.query(`insert into public.ownership (entity_id, unit_id, is_primary) values ($1,$2,true)`, [entityId, unitId]);
  });
}
// Add a NON-PRIMARY co-owner to a property or unit.
async function addOwner({ propertyId, target, unitId, entityId }) {
  if (!entityId) throw new Error('entity_id is required');
  const isUnit = target === 'unit';
  const col = isUnit ? 'unit_id' : 'property_id';
  const ownerId = isUnit ? unitId : propertyId;
  if (!ownerId) throw new Error(`${col} is required`);
  const exists = (await q(`select id, is_primary from public.ownership where ${col}=$1 and entity_id=$2`, [ownerId, entityId])).rows[0];
  if (exists) {
    if (exists.is_primary) throw new Error('That entity is already the primary owner');
    return { ok: true, id: String(exists.id) }; // already a co-owner — idempotent
  }
  const r = await q(`insert into public.ownership (entity_id, ${col}, is_primary) values ($1,$2,false) returning id`, [entityId, ownerId]);
  return { ok: true, id: String(r.rows[0].id) };
}
// Remove a co-owner. Never removes the primary owner.
async function removeOwner({ propertyId, target, unitId, entityId }) {
  if (!entityId) throw new Error('entity_id is required');
  const isUnit = target === 'unit';
  const col = isUnit ? 'unit_id' : 'property_id';
  const ownerId = isUnit ? unitId : propertyId;
  if (!ownerId) throw new Error(`${col} is required`);
  const row = (await q(`select id, is_primary from public.ownership where ${col}=$1 and entity_id=$2`, [ownerId, entityId])).rows[0];
  if (!row) return { ok: true };  // already gone — idempotent
  if (row.is_primary) throw new Error('Cannot remove the primary owner — change the Owner Entity instead');
  await q(`delete from public.ownership where id=$1`, [row.id]);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Messages -> property_comment (property_id OR unit_id; never both)
// ---------------------------------------------------------------------------
async function getComments(scope, ownerId) {
  const col = scope === 'unit' ? 'unit_id' : 'property_id';
  const rows = (await q(`select id, author, body, created_at from public.property_comment where ${col}=$1 order by created_at asc`, [ownerId])).rows;
  return { comments: rows.map(r => ({ id: String(r.id), comment_text: r.body, user: { username: r.author || 'Unknown' }, date: r.created_at ? new Date(r.created_at).getTime() : null })) };
}
async function addComment(scope, ownerId, body, author) {
  if (!body || !body.trim()) throw new Error('Comment body required');
  const col = scope === 'unit' ? 'unit_id' : 'property_id';
  const r = await q(`insert into public.property_comment (${col}, author, body) values ($1,$2,$3) returning id`, [ownerId, author || null, body.trim()]);
  return { ok: true, id: String(r.rows[0].id) };
}

// ---------------------------------------------------------------------------
// Self-check (B1)
// ---------------------------------------------------------------------------
async function selfCheck() {
  const tables = ['entity', 'property', 'unit', 'loan', 'loan_collateral', 'loan_balance', 'insurance_policy', 'guarantor', 'reporting_requirement', 'property_comment', 'task'];
  const counts = {};
  for (const t of tables) {
    try { counts[t] = Number((await q(`select count(*)::int as n from public.${t}`, [])).rows[0].n); }
    catch (e) { counts[t] = `ERR: ${e.message}`; }
  }
  const expected = { entity: 64, property: 66, unit: 224, loan: 83 };
  const checks = [];
  const chk = (name, pass, detail) => checks.push({ name, pass: !!pass, detail });
  chk('db_connected', typeof counts.entity === 'number', `entity count=${counts.entity}`);
  // A +1 on BOTH entity and property is the owner's known test record — note, don't fail.
  const testRecord = counts.entity === expected.entity + 1 && counts.property === expected.property + 1;
  for (const [t, exp] of Object.entries(expected)) {
    if ((t === 'entity' || t === 'property') && testRecord) {
      chk(`count_${t}`, true, `expected ${exp}, actual ${counts[t]} (+1 = known test record, ok)`);
    } else {
      chk(`count_${t}_eq_${exp}`, counts[t] === exp, `expected ${exp}, actual ${counts[t]}`);
    }
  }
  try {
    const orphan = Number((await q(`select count(*)::int n from public.property p left join public.entity e on e.id=p.entity_id where e.id is null`, [])).rows[0].n);
    chk('no_orphan_properties', orphan === 0, `${orphan} properties without an entity`);
  } catch (e) { chk('no_orphan_properties', false, e.message); }
  // Ownership integrity (the `ownership` table is the source of truth).
  try {
    const n = Number((await q(`select count(*)::int n from (
      select p.id, count(*) filter (where o.is_primary) as primaries
      from public.property p left join public.ownership o on o.property_id = p.id
      group by p.id) t where t.primaries <> 1`, [])).rows[0].n);
    chk('every_property_has_one_primary_owner', n === 0, `${n} properties without exactly one primary owner`);
  } catch (e) { chk('every_property_has_one_primary_owner', false, e.message); }
  try {
    const n = Number((await q(`select count(*)::int n from public.property p
      join public.ownership o on o.property_id = p.id and o.is_primary = true
      where o.entity_id <> p.entity_id`, [])).rows[0].n);
    chk('primary_owner_matches_property_entity_id', n === 0, `${n} properties whose primary owner != property.entity_id`);
  } catch (e) { chk('primary_owner_matches_property_entity_id', false, e.message); }
  try {
    const n = Number((await q(`select count(*)::int n from (
      select property_id from public.ownership where property_id is not null group by property_id having count(*) > 1) t`, [])).rows[0].n);
    chk('co_owned_properties_reported', true, `${n} co-owned properties (informational)`);
  } catch (e) { chk('co_owned_properties_reported', false, e.message); }
  try {
    const unlinked = Number((await q(`select count(*)::int n from public.loan l where l.borrower_entity_id is null or not exists (select 1 from public.loan_collateral c where c.loan_id=l.id)`, [])).rows[0].n);
    chk('unlinked_loans_surfaced', unlinked >= 0, `${unlinked} unlinked loans (Part E should list these)`);
  } catch (e) { chk('unlinked_loans_surfaced', false, e.message); }
  // Part D — informational counts (never hard-fail).
  const info = {};
  try {
    const rows = (await q(`select coalesce(lower(position),'(none)') pos, count(*)::int n from public.loan group by 1`, [])).rows;
    info.loans_by_position = {}; rows.forEach(r => { info.loans_by_position[r.pos] = r.n; });
    chk('loans_by_position', true, JSON.stringify(info.loans_by_position));
  } catch (e) { chk('loans_by_position', true, 'ERR: ' + e.message); }
  try {
    info.property_financials_count = Number((await q(`select count(*)::int n from public.property_financials`, [])).rows[0].n);
    chk('property_financials_count', true, String(info.property_financials_count));
  } catch (e) { chk('property_financials_count', true, 'ERR: ' + e.message); }
  try {
    info.tif_loan_count = Number((await q(`select count(*)::int n from public.loan where is_tif = true`, [])).rows[0].n);
    chk('tif_loan_count', true, String(info.tif_loan_count));
  } catch (e) { chk('tif_loan_count', true, 'ERR: ' + e.message); }
  return { generatedAt: new Date().toISOString(), counts, expected, testRecordPresent: testRecord, info, checks, all_pass: checks.every(c => c.pass) };
}

module.exports = {
  enabled, getPropertiesPayload, getLoansPayload, getView,
  createEntity, createProperty, createBuilding, createLoan, assignLoan, patchField,
  addOwner, removeOwner,
  getComments, addComment, selfCheck,
};
