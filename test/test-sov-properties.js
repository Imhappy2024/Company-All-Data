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

console.log(fail ? `\n${fail} CHECK(S) FAILED` : '\nAll checks passed');
process.exit(fail?1:0);
