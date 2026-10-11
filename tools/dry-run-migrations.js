// ===========================================================================
// tools/dry-run-migrations.js — run migration files against the LIVE
// database inside one transaction, check the result, and ROLL BACK.
//
//   node tools/dry-run-migrations.js migrations/a.sql migrations/b.sql
//
// Nothing is committed, ever: the transaction ends in ROLLBACK whether the
// checks pass or fail. This is how a migration is shown to work before
// anyone approves applying it.
// ===========================================================================
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
process.loadEnvFile(path.join(ROOT, '.env'));
const db = require(path.join(ROOT, 'supabase-db.js'));

const files = process.argv.slice(2);
const T = '72381c81-af95-4e1d-ad0d-20a3a3421119';

const CHECKS = [
  ['Franklin Court rent roll: 172 units, 165 occupied (95.9%), delinquency 16,461',
   `select units, round(latest_occupancy * 100, 1) occ_pct, units_source
      from reporting.property_summary_mv where name = 'Franklin Court'`,
   r => +r.units === 172 && +r.occ_pct === 95.9 && r.units_source === 'rent_roll'],
  ['Franklin Court latest delinquency 16,461',
   `select round(pm.delinquency) d from reporting.property_month_mv pm
      join property p on p.id = pm.property_id
     where p.dba_name = 'Franklin Court' and pm.delinquency is not null order by pm.month desc limit 1`,
   r => +r.d === 16461],
  ['Grandview occupancy 73.3%',
   `select round(latest_occupancy * 100, 1) occ from reporting.property_summary_mv where name = 'Grandview Apartments'`,
   r => +r.occ === 73.3],
  ['Champion Villas: NOI 777,274, debt service paid 712,716, DSCR 1.09',
   `select round(t12_noi) noi, round(annual_debt_service_paid) ds, round(t12_noi / annual_debt_service_paid, 2) dscr
      from reporting.property_summary_mv where name = 'Champion Villas'`,
   r => +r.noi === 777274 && +r.ds === 712716 && +r.dscr === 1.09],
  ['Dakota Bend Jan 2026 NOI 15,074.52, DSCR 1.11',
   `select round(noi, 2) noi, round(dscr, 2) dscr from reporting.property_month_mv pm
      join property p on p.id = pm.property_id where p.dba_name = 'Dakota Bend' and month = '2026-01-01'`,
   r => +r.noi === 15074.52 && +r.dscr === 1.11],
  ['Dakota Bend income-statement net income Oct 2025 - Sep 2026 = 17,140.74',
   `select round(sum(case when section in ('income','non_operating_income') then amount else -amount end), 2) ni
      from reporting.income_statement_month s join property p on p.id = s.property_id
     where p.dba_name = 'Dakota Bend' and month between '2025-10-01' and '2026-09-01'`,
   r => +r.ni === 17140.74],
  // The spec says $571,210. The exact figure is 571,208.76; the mockup's
  // 571,210 is the sum of its twelve monthly figures each rounded to whole
  // dollars first. The live screen shows $571,209.
  ['Franklin Court capex Oct 2025 - Sep 2026 = 571,208.76 from capex_line (mockup: 571,210 from rounded months)',
   `select round(sum(amount), 2) c from reporting.capex_line c join property p on p.id = c.property_id
     where p.dba_name = 'Franklin Court' and month between '2025-10-01' and '2026-09-01'`,
   r => +r.c === 571208.76],
  ['capex_line sums to property_month.capex, every property and month',
   `select count(*) n from (
      select pm.property_id, pm.month, pm.capex, sum(c.amount) lines
        from reporting.property_month_mv pm
        left join reporting.capex_line c on c.property_id = pm.property_id and c.month = pm.month
                                        and c.accounting_basis = pm.accounting_basis
       where pm.capex is not null
       group by 1, 2, 3
      having abs(pm.capex - coalesce(sum(c.amount), 0)) > 0.01) x`,
   r => +r.n === 0],
  ['every other_cash_items line is classified',
   `select activity, count(*) n from reporting.cash_flow_line group by 1 order by 1`, null],
  ['capex categories in use',
   `select category, round(sum(amount)) total from reporting.capex_line
     where month between '2025-10-01' and '2026-09-01' group by 1 order by 2 desc`, null],
  ['Sioux Falls townhomes: Units 262',
   `select sum(s.units) u from reporting.property_summary_mv s
      join property_group_member m on m.property_id = s.id
      join property_group g on g.id = m.group_id where g.name = 'Sioux Falls townhomes'`,
   r => +r.u === 262],
  ['Sioux Falls townhomes: Income, Aug + Sep 2026 = 579,376',
   `select round(sum(pm.total_operating_income)) inc from reporting.property_month_mv pm
      join property_group_member m on m.property_id = pm.property_id
      join property_group g on g.id = m.group_id
     where g.name = 'Sioux Falls townhomes' and pm.month in ('2026-08-01', '2026-09-01')`,
   r => +r.inc === 579376],
  ['seeded custom view exists',
   `select name, display_type, jsonb_array_length(config->'cards') cards from saved_view where display_type = 'custom'`,
   r => r && r.cards === 5],
];

(async () => {
  const client = await db.getPool().connect();
  let failed = 0;
  try {
    await client.query('BEGIN');
    for (const f of files) {
      const t0 = Date.now();
      await client.query(fs.readFileSync(path.resolve(f), 'utf8'));
      console.log('applied (inside the transaction): ' + f + ' in ' + (Date.now() - t0) + 'ms');
    }
    for (const [label, sql, ok] of CHECKS) {
      try {
        const r = await client.query(sql);
        if (!ok) { console.log('  INFO  ' + label + '\n        ' + r.rows.map(x => Object.values(x).join(' ')).join(' | ')); continue; }
        const pass = ok(r.rows[0]);
        if (!pass) failed++;
        console.log('  ' + (pass ? 'PASS' : 'FAIL') + '  ' + label + (pass ? '' : '   got ' + JSON.stringify(r.rows[0])));
      } catch (e) { failed++; console.log('  FAIL  ' + label + '  ' + e.message); }
    }
  } catch (e) {
    failed++;
    console.log('MIGRATION ERROR: ' + e.message + (e.position ? ' at ' + e.position : ''));
  } finally {
    await client.query('ROLLBACK');
    client.release();
    console.log('rolled back; nothing was committed. ' + (failed ? failed + ' failed' : 'all checks passed'));
    process.exit(failed ? 1 : 0);
  }
})();
