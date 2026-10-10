/* The dataset registry is the allowlist standing between a user-authored
   saved-view config and generated SQL. These checks are about that boundary,
   not about the field list being pretty.

   Run: node test/test-datasets.js
*/
/* strict mode on purpose: a write to a frozen object THROWS in strict mode
   and is a silent no-op in sloppy mode. Without this the mutation check below
   passes whether or not anything is actually frozen. */
'use strict';
const assert = require('assert');
const D = require('../config/datasets');

let pass = 0; const fails = [];
const check = (n, fn) => { try { fn(); pass++; } catch (e) { fails.push(n + ' -> ' + e.message); } };

check('requiring the file at all proves every self-check passed', () => {
  /* the loop in datasets.js throws at require time on a duplicate field, an
     unusable column, a missing tenant scope or a defaultSort naming a field
     that does not exist. Getting here means none of those are true. */
  assert.ok(Object.keys(D.DATASETS).length >= 6);
});

check('every dataset declares a tenant scope, and tenantColumn THROWS without one', () => {
  for (const k of Object.keys(D.DATASETS)) assert.ok(D.tenantColumn(k), k);
  assert.throws(() => D.tenantColumn('no_such_dataset'), /no tenant scope/);
});

check('a field outside the registry never yields a column', () => {
  assert.strictEqual(D.safeColumn('property_month', 'drop_table'), null);
  assert.strictEqual(D.safeColumn('property_month', 'amount; drop table x'), null);
  assert.strictEqual(D.safeColumn('no_such_dataset', 'month'), null);
  assert.ok(D.safeColumn('property_month', 'noi'));
});

check('prototype keys resolve to nothing, on both lookups', () => {
  for (const bad of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
    assert.strictEqual(D.getDataset(bad), null, 'getDataset ' + bad);
    assert.strictEqual(D.safeColumn('property_month', bad), null, 'safeColumn ' + bad);
    assert.strictEqual(D.safeColumn(bad, 'noi'), null, 'dataset ' + bad);
  }
});

check('the relation name is vetted too - it cannot go through safeColumn', () => {
  /* 'reporting.property_month' has a dot, so safeColumn rejects it. Without
     safeView the FROM clause is the one part of a generated query with no
     allowlist behind it. */
  assert.strictEqual(D.safeView('property_month'), '"reporting"."property_month"');
  assert.strictEqual(D.safeView('no_such_dataset'), null);
});

check('operators, aggregates and sort direction are allowlisted', () => {
  assert.strictEqual(D.safeOp('eq'), 'eq');
  assert.strictEqual(D.safeOp('; drop table x'), null);
  assert.strictEqual(D.safeAggregate('sum'), 'SUM');
  assert.strictEqual(D.safeAggregate('exec'), null);
  /* direction has no null branch on purpose: anything that is not desc is
     asc, so a malformed value cannot remove the ORDER BY. */
  assert.strictEqual(D.safeDir('desc'), 'DESC');
  assert.strictEqual(D.safeDir('DESC'), 'DESC');
  assert.strictEqual(D.safeDir('; drop'), 'ASC');
});

check('the registry cannot be mutated by a careless consumer', () => {
  /* getField hands back the live object. If a consumer ever merged a stored
     config onto it, the allowlist would be rewritten process-wide and
     safeColumn would then validate the attacker's column. */
  const f = D.getField('property_month', 'noi');
  assert.throws(() => { f.column = 'noi"; drop table x --'; }, TypeError);
  assert.throws(() => { D.DATASETS.property_month.view = 'evil'; }, TypeError);
  assert.strictEqual(D.safeColumn('property_month', 'noi'), '"noi"');
});

check('every field a dataset offers actually resolves', () => {
  for (const [k, ds] of Object.entries(D.DATASETS)) {
    for (const f of ds.fields) {
      assert.ok(D.safeColumn(k, f.key), k + '.' + f.key + ' does not resolve');
    }
  }
});

check('rent_roll_unit.tenant is declared but marked unavailable', () => {
  /* rent_roll_line has no tenant/resident name column. The field stays in the
     contract so it renders as the not-available dash instead of vanishing. */
  const f = D.getField('rent_roll_unit', 'tenant');
  assert.ok(f, 'the field is gone - the brief asks for it');
  assert.ok(f.unavailable, 'it must say why it is always null');
});

console.log('\ndataset registry: ' + pass + ' passed, ' + fails.length + ' failed');
if (fails.length) { fails.forEach(f => console.log('  FAIL  ' + f)); process.exit(1); }
