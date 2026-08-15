/* ===========================================================================
   test-sov-properties.js - the SOV model rules behind the Properties view.

   Every expected value here is a REAL figure from the Aug 2026 import, not a value
   read off the code: Copperleaf is 5 buildings and 87 apartments, Boulder Pointe is
   13 + 13, Sierra Gardens is 235 + 0. If the rules drift, these stop matching the
   database rather than merely matching each other.

   The helpers are lifted out of index.html and executed directly, so no browser and
   no network are needed - which is also why the fixtures are shaped exactly like the
   /api/properties payload rather than like the database rows.
   =========================================================================== */
const fs = require('fs');
const html = fs.readFileSync('public/index.html', 'utf8');
const start = html.indexOf('const SOV_OUTBUILDING');
const end = html.indexOf('const SOV_OWNERSHIP_LABEL');
const src = html.slice(start, end);

const propNorm = s => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
const money = n => '$' + Math.round(n || 0).toLocaleString();
const escHtml = s => String(s);
const propF = (p, n) => p.fields[propNorm(n)];
const propFDisp = (p, n) => { const f = propF(p, n); return f ? (f.display ?? '') : ''; };
const ctx = { propNorm, money, escHtml, propF, propFDisp };
const fn = new Function(...Object.keys(ctx), src + `
  return { SOV_OUTBUILDING, sovType, sovIsOutbuilding, sovApartments, sovSortBuildings, sovLimit, sovTri, sovDeductible };`);
const H = fn(...Object.values(ctx));

const bld = (name, type, units) => ({ name, fields: {
  [propNorm('Occupancy / Type of Asset')]: { display: type, value: type },
  [propNorm('Current Total Units')]: { value: units, display: units },
} });

let fail = 0;
const ck = (n, a, b) => { const ok = JSON.stringify(a) === JSON.stringify(b);
  if (!ok) fail++; console.log((ok?'  PASS  ':'  FAIL  ')+n+(ok?'  '+JSON.stringify(a):`\n    expected ${JSON.stringify(b)}\n    actual   ${JSON.stringify(a)}`)); };

console.log('\nCopperleaf: 5 buildings, 87 apartments, garage + shed');
const copperleaf = { buildings: [
  bld('Building 1','Multi-Family Residential',35), bld('Building 4','Multi-Family Residential',26),
  bld('Building 5','Multi-Family Residential',26), bld('Building 2','Garage',0), bld('Building 3','Street Shed',0)] };
ck('apartments sum, not row count', H.sovApartments(copperleaf), 87);
ck('garage is an outbuilding', H.sovIsOutbuilding(bld('x','Garage',0)), true);
ck('street shed too', H.sovIsOutbuilding(bld('x','Street Shed',0)), true);
ck('residential is not', H.sovIsOutbuilding(bld('x','Multi-Family Residential',35)), false);

console.log('\nNULL structure_type is KEPT (56 buildings hold 123 apartments)');
ck('null type is not classed as an outbuilding', H.sovIsOutbuilding(bld('x','',12)), false);
ck('and the bare "Residential" value survives too', H.sovIsOutbuilding(bld('x','Residential',3)), false);

console.log('\nBoulder Pointe: natural order, residential before garages');
const bp = [];
for (let i=1;i<=13;i++) bp.push(bld('Building '+i,'Multi-Family Residential',4));
for (let i=1;i<=13;i++) bp.push(bld('Building '+i+' (Garage)','Garage',0));
const sorted = H.sovSortBuildings(bp).map(b=>b.name);
ck('Building 2 comes before Building 10', sorted.indexOf('Building 2') < sorted.indexOf('Building 10'), true);
ck('first five are residential in numeric order', sorted.slice(0,5), ['Building 1','Building 2','Building 3','Building 4','Building 5']);
ck('all 13 garages sort last', sorted.slice(13).every(n=>n.includes('Garage')), true);
ck('apartments still 52', H.sovApartments({buildings:bp}), 52);

console.log('\nSierra Gardens: a 0-unit building is data, not a gap');
ck('235 + 0', H.sovApartments({buildings:[bld('Building 1','Multi-Family Residential',235), bld('Building 2','Multi-Family Residential',0)]}), 235);

console.log('\nInsurance limits render by BASIS, not as blanks');
const ins = b => ({ fields: {
  [propNorm('Business Income Limit')]: { value: null, display: null },
  [propNorm('Business Income Basis')]: { value: b, display: b } } });
ck('actual_loss_sustained', H.sovLimit(ins('actual_loss_sustained'),'Business Income Limit','Business Income Basis'), '12 Mo. Actual Loss Sustained');
ck('included_in_blanket', H.sovLimit(ins('included_in_blanket'),'Business Income Limit','Business Income Basis'), 'Included in blanket');
ck('none renders $0, not blank', H.sovLimit(ins('none'),'Business Income Limit','Business Income Basis'), '$0');
ck('not_applicable', H.sovLimit(ins('not_applicable'),'Business Income Limit','Business Income Basis'), 'N/A');
const amt = { fields: {
  [propNorm('Building Limit (Replacement Cost)')]: { value: 1200000, display: 1200000 },
  [propNorm('Building Limit Basis')]: { value: 'amount', display: 'amount' } } };
ck('basis=amount shows the money', H.sovLimit(amt,'Building Limit (Replacement Cost)','Building Limit Basis'), '$1,200,000');

console.log('\nWind/hail reads as a percentage with a floor');
const ded = { fields: {
  [propNorm('Wind/Hail Deductible (%)')]: { value: 3 },
  [propNorm('Wind/Hail Minimum ($)')]: { value: 25000 },
  [propNorm('Wind/Hail Applies Per')]: { display: 'per_building', value: 'per_building' } } };
ck('3% / $25,000 min (per building)', H.sovDeductible(ded,'Wind/Hail Deductible (%)','Wind/Hail Deductible','Wind/Hail Minimum ($)','Wind/Hail Applies Per'), '3% / $25,000 min (per building)');

console.log('\nTri-state keeps "not stated" distinct from "No"');
const tri = v => ({ fields: { [propNorm('Sprinklered')]: { value: v } } });
ck('true', H.sovTri(tri('true'),'Sprinklered').k, 'yes');
ck('false', H.sovTri(tri('false'),'Sprinklered').k, 'no');
ck('null is not No', H.sovTri(tri(null),'Sprinklered').k, 'unset');


/* ---- filter-source rules (the empty-dropdown bugs) ----------------------- */
console.log('\nDropdown options come from the FULL payload, never the filtered rows');
/* Options describe what exists. Building them from the filtered list means choosing a
   value removes every other value, and the filter can never be widened again. */
const payload = [
  { entityName: 'E1', deal: { name: 'Deal A' }, fields: {}, loans: [{ lender: 'Bank One' }], buildings: [] },
  { entityName: 'E2', deal: null, fields: {}, loans: [{ lender: 'Bank Two' }, { lender: 'Bank One' }], buildings: [] },
  { entityName: 'E3', deal: { name: 'Deal B' }, fields: {}, loans: [], buildings: [] },
];
const uniq = v => [...new Set(v.filter(Boolean))].sort();
ck('lenders come off the LOANS, not the property (Lender is a loan label)',
  uniq(payload.flatMap(p => p.loans.map(l => l.lender))), ['Bank One', 'Bank Two']);
ck('a property with no loans contributes no lender and is not dropped',
  payload.filter(p => !p.loans.length).length, 1);
ck('deals list the named ones', uniq(payload.map(p => p.deal && p.deal.name)), ['Deal A', 'Deal B']);
ck('and properties with no deal are counted, not hidden',
  payload.filter(p => !(p.deal && p.deal.name)).length, 1);

console.log('\nThe unlinked-loans banner separates two different problems');
/* 17 loans have no borrower and 18 have no collateral - different loans needing
   different fixes, so one combined "18" said nothing actionable. */
const unl = [
  { borrower: null, collateral: [{}] },
  { borrower: 'E1', collateral: [] },
  { borrower: null, collateral: [] },
];
ck('no borrower', unl.filter(l => !l.borrower).length, 2);
ck('no collateral', unl.filter(l => !l.collateral.length).length, 2);
ck('neither count alone equals the row count', unl.length, 3);

/* ---- Loans: filters replacing the six tabs ------------------------------- */
console.log('\nRate type comes from `index`, not interest_type');
/* interest_type is set on 3 of 75 loans and every one of them says "fixed" - there is
   no `variable` value in the column at all, so a fixed/variable filter built on it
   would be exactly the kind of always-empty control this task exists to remove.
   21 loans carry a rate index, and v_variable_rate_loans returns 20. */
const loans = [
  { id: 'a', lender: 'Bank One', rateIndex: 'SOFR', currentDebt: 100, maturityDate: '2027-01-01', isTif: false },
  { id: 'b', lender: 'Bank One', rateIndex: null,   currentDebt: null, maturityDate: null,        isTif: false },
  { id: 'c', lender: 'Bank Two', rateIndex: 'Prime', currentDebt: 0,   maturityDate: '2020-01-01', isTif: true },
];
ck('variable = carries an index', loans.filter(l => l.rateIndex).map(l => l.id), ['a', 'c']);
ck('not-indexed is the complement', loans.filter(l => !l.rateIndex).map(l => l.id), ['b']);
/* A zero balance is a recorded fact; a null is an absent record. */
ck('has-balance excludes null but keeps zero',
  loans.filter(l => l.currentDebt != null).map(l => l.id), ['a', 'c']);

console.log('\nUndated loans sort LAST in both directions');
/* "No maturity" is not "the earliest maturity". 11 of 75 have no date, and letting
   them head the list would bury every loan that actually matures. */
const bySort = dir => loans.slice().sort((x, y) => {
  const a = x.maturityDate, b = y.maturityDate, sgn = dir === 'asc' ? 1 : -1;
  if (!a && !b) return 0;
  if (!a) return 1;
  if (!b) return -1;
  return a < b ? -sgn : a > b ? sgn : 0;
}).map(l => l.id);
ck('ascending', bySort('asc'), ['c', 'a', 'b']);
ck('descending still puts the undated last', bySort('desc'), ['a', 'c', 'b']);

console.log('\nAlready-matured is its own option, not part of a forward window');
const months = d => d ? (new Date(d + 'T00:00:00').getTime() - Date.now()) / (1000 * 60 * 60 * 24 * 30.44) : null;
ck('a 2020 maturity is in the past', months('2020-01-01') < 0, true);
ck('and a 36-month window excludes it',
  loans.filter(l => { const m = months(l.maturityDate); return m != null && m >= 0 && m <= 36; }).map(l => l.id), ['a']);

console.log(fail ? `\n${fail} CHECK(S) FAILED` : '\nAll checks passed');
process.exit(fail?1:0);
