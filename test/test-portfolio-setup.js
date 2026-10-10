/* Section H: adding entities, properties and buildings, against the REAL
   database through the REAL routes, with every write rolled back.

   db.tx is swapped for a version that runs the checks INSIDE the
   transaction and then rolls it back, so the assertions see the rows the
   route wrote and the shared database never does. The last check proves
   that: nothing named by this suite exists afterwards.

   The identity is stubbed at its outbound boundary (the dash_my_access
   call), exactly as test-reporting-ui.js documents, so the admin gate under
   test is the real one.

   Run:  node test/test-portfolio-setup.js
*/
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const express = require('express');

const ROOT = path.join(__dirname, '..');
for (const l of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
  const m = /^([A-Za-z0-9_]+)=(.*)$/.exec(l.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
const db = require(path.join(ROOT, 'supabase-db.js'));

let inside = null;
db.tx = async fn => {
  const client = await db.getPool().connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    if (inside) await inside(client, out);
    return out;
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
};
/* the post-save refresh would rebuild the reporting views for nothing */
const realQ = db.q;
db.q = (sql, p) => (/refresh_reporting/.test(sql) ? Promise.resolve({ rows: [] }) : realQ(sql, p));

let ROLE = 'owner', STAFF = null;
const realFetch = global.fetch;
global.fetch = async function (url, init) {
  if (String(url).indexOf('/rpc/dash_my_access') >= 0) {
    return new Response(JSON.stringify({
      user: { id: STAFF.id, email: STAFF.email, full_name: STAFF.full_name, role: ROLE },
      companies: {}, access: { exec: { properties: 'edit' } },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  return realFetch(url, init);
};
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://x.supabase.co';
process.env.SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'k';

const SETUP = require(path.join(ROOT, 'portfolio-setup-api.js'));
const NAME = 'Zz Setup Suite Apartments';

let pass = 0; const fails = [];
const check = async (n, fn) => { try { await fn(); pass++; } catch (e) { fails.push(n + ' -> ' + e.message); } };

(async () => {
  STAFF = (await realQ(`select id, email, full_name from public.staff where lower(email) = 'jay@leadliconsulting.com'`)).rows[0];
  const app = express();
  app.use('/api/portfolio-setup', SETUP.setupRoutes());
  const srv = app.listen(0);
  const base = 'http://127.0.0.1:' + srv.address().port + '/api/portfolio-setup';
  const post = (p, body) => realFetch(base + p, { method: 'POST', headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    .then(async r => ({ status: r.status, body: await r.json() }));
  const get = p => realFetch(base + p, { headers: { Authorization: 'Bearer t' } }).then(async r => ({ status: r.status, body: await r.json() }));

  const mgr = (await realQ(`select id from public.entity where name = 'Park Ave Capital LLC'`)).rows[0].id;
  const copper = (await realQ(`select id from public.property where dba_name ilike 'Copperleaf%' limit 1`)).rows[0].id;

  /* ---- the gate ---- */
  ROLE = 'user';
  await check('a plain user cannot add anything (403)', async () => {
    const r = await post('/entity', { name: 'Zz Nope LLC' });
    assert.strictEqual(r.status, 403, JSON.stringify(r.body));
    const b = await post('/property/' + copper + '/building', { name: 'X', units: 1 });
    assert.strictEqual(b.status, 403);
  });
  await check('a plain user is told they are not an admin, and gets no lists', async () => {
    const r = await get('/options');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.isAdmin, false);
    assert.ok(!r.body.entities);
  });
  await check('a plain user can still read the checklist', async () => {
    const r = await get('/property/' + copper + '/checklist');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.items.length, 4);
  });
  ROLE = 'owner';

  await check('options offer the constraint vocabularies and the managers', async () => {
    const r = await get('/options');
    assert.strictEqual(r.body.isAdmin, true);
    assert.ok(r.body.managers.length >= 17, 'managers ' + r.body.managers.length);
    assert.deepStrictEqual(r.body.buildingTypes.slice(0, 2), ['residential', 'garage']);
    assert.ok(r.body.managerGroups.indexOf('Point Guard NE') >= 0);
  });

  /* ---- + Property, everything at once ---- */
  let seen = null;
  inside = async (c, out) => {
    seen = {
      p: (await c.query(`select p.*, e.name owner_name, e.manager_entity_id from public.property p join public.entity e on e.id = p.entity_id where p.id = $1`, [out.id])).rows[0],
      alias: (await c.query(`select source_system, source_label, scope from public.property_source_alias where property_id = $1`, [out.id])).rows,
      fee: (await c.query(`select s.* from public.am_fee_schedule s join public.am_fee_schedule_property l on l.schedule_id = s.id where l.property_id = $1`, [out.id])).rows,
      loan: (await c.query(`select l.*, c.property_id from public.loan l join public.loan_collateral c on c.loan_id = l.id where c.property_id = $1`, [out.id])).rows,
      log: (await c.query(`select target_table, edited_by from public.sov_edit_log where edited_at >= now() - interval '1 minute' and column_name = '(record created)' order by edited_at`)).rows,
    };
  };
  const full = await post('/property', {
    name: NAME, street: '1 Suite St', city: 'Omaha', state: 'NE', zip: '68102', units: '24', purchase_price: '$2,400,000', purchase_date: '2026-03-01',
    new_owner: { name: 'Zz Setup Suite LLC', manager_entity_id: mgr },
    source_system: 'buildium', source_label: NAME + ' - Buildium',
    dropbox_url: 'https://www.dropbox.com/scl/fo/zz/zz?rlkey=zz&dl=0',
    fee: { enabled: true, manager_group: 'Point Guard NE', fee_type: 'pct_gross', fee_pct: '3', payment_timing: 'following_month' },
    loan: { enabled: true, lender: 'Zz Bank', origination_amount: '1,500,000', interest_rate_pct: '6.5', origination_date: '2026-03-01', maturity_date: '2031-03-01', purpose: 'primary_mortgage' },
  });
  await check('+ Property answers 201 with the new id', async () => {
    assert.strictEqual(full.status, 201, JSON.stringify(full.body));
    assert.ok(/^[0-9a-f-]{36}$/.test(full.body.property.id));
  });
  await check('the property is held, owned by the new LLC under its manager', async () => {
    assert.strictEqual(seen.p.dba_name, NAME);
    assert.strictEqual(seen.p.ownership_status, 'held');
    assert.strictEqual(seen.p.owner_name, 'Zz Setup Suite LLC');
    assert.strictEqual(seen.p.manager_entity_id, mgr);
    assert.strictEqual(Number(seen.p.purchase_price), 2400000);
  });
  await check('units are a VERIFIED count in the person\'s name, never unit_count_reported', async () => {
    assert.strictEqual(seen.p.unit_count_verified, 24);
    assert.strictEqual(seen.p.unit_count_verified_by, STAFF.email);
    assert.strictEqual(seen.p.unit_count_reported, null);
  });
  await check('the report-source name becomes the alias the sync matches on', async () => {
    assert.deepStrictEqual(seen.alias, [{ source_system: 'buildium', source_label: NAME + ' - Buildium', scope: 'property' }]);
  });
  await check('the fee schedule covers the property', async () => {
    assert.strictEqual(seen.fee.length, 1);
    assert.strictEqual(seen.fee[0].fee_type, 'pct_gross');
    assert.strictEqual(Number(seen.fee[0].fee_pct), 3);
    assert.strictEqual(seen.fee[0].payment_timing, 'following_month');
  });
  await check('the loan rate is stored as a FRACTION, borrowed by the owner, secured on the property', async () => {
    assert.strictEqual(seen.loan.length, 1);
    assert.strictEqual(Number(seen.loan[0].interest_rate_pct), 0.065);
    assert.strictEqual(seen.loan[0].borrower_entity_id, seen.p.entity_id);
    assert.strictEqual(seen.loan[0].status, 'active');
  });
  await check('every record is audited under the person who added it', async () => {
    const tables = seen.log.filter(l => l.edited_by === STAFF.email).map(l => l.target_table);
    ['entity', 'property', 'property_source_alias', 'am_fee_schedule', 'loan'].forEach(t => assert.ok(tables.indexOf(t) >= 0, 'no audit row for ' + t + ': ' + tables));
  });
  inside = null;

  /* ---- refusals: nothing half-written ---- */
  await check('a name already matched to another property is a 409 that names it', async () => {
    const taken = (await realQ(`select a.source_label, p.dba_name from public.property_source_alias a join public.property p on p.id = a.property_id where a.source_system = 'buildium' limit 1`)).rows[0];
    const r = await post('/property', { name: 'Zz Alias Clash', owner_entity_id: mgr, source_system: 'buildium', source_label: taken.source_label });
    assert.strictEqual(r.status, 409);
    assert.strictEqual(r.body.field, 'source_label');
    assert.ok(r.body.error.indexOf(taken.dba_name) >= 0, r.body.error);
  });
  await check('an existing property name is a 409, not a second row', async () => {
    const name = (await realQ(`select dba_name from public.property where id = $1`, [copper])).rows[0].dba_name;
    const r = await post('/property', { name: name.toUpperCase(), owner_entity_id: mgr });
    assert.strictEqual(r.status, 409);
    assert.strictEqual(r.body.field, 'name');
  });
  await check('a source with no name there is refused on that field', async () => {
    const r = await post('/property', { name: 'Zz No Label', owner_entity_id: mgr, source_system: 'appfolio' });
    assert.strictEqual(r.status, 400);
    assert.strictEqual(r.body.field, 'source_label');
  });
  await check('a fee over 100% is refused on that field', async () => {
    const r = await post('/property', { name: 'Zz Fee', owner_entity_id: mgr, fee: { enabled: true, manager_group: 'X', fee_type: 'pct_gross', fee_pct: '120', payment_timing: 'same_month' } });
    assert.strictEqual(r.status, 400);
    assert.strictEqual(r.body.field, 'fee.fee_pct');
  });
  await check('a Dropbox value that is not a Dropbox link is refused', async () => {
    const r = await post('/property', { name: 'Zz Dbx', owner_entity_id: mgr, dropbox_url: '/Company/Some Folder' });
    assert.strictEqual(r.status, 400);
    assert.strictEqual(r.body.field, 'dropbox_url');
  });
  await check('no owner at all is refused', async () => {
    const r = await post('/property', { name: 'Zz Orphan' });
    assert.strictEqual(r.status, 400);
    assert.strictEqual(r.body.field, 'owner_entity_id');
  });

  /* ---- + Entity ---- */
  inside = async (c, out) => { seen = (await c.query('select name, entity_type, manager_entity_id, company_id from public.entity where id = $1', [out.id])).rows[0]; };
  await check('+ Entity creates a LeavenWealth entity with its manager', async () => {
    const r = await post('/entity', { name: 'Zz Setup Entity LLC', entity_type: 'holding', manager_entity_id: mgr });
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    assert.deepStrictEqual(seen, { name: 'Zz Setup Entity LLC', entity_type: 'holding', manager_entity_id: mgr, company_id: 'c0000000-0000-4000-8000-000000000003' });
  });
  inside = null;
  await check('+ Entity refuses a duplicate name, ignoring case', async () => {
    const r = await post('/entity', { name: 'park ave capital llc' });
    assert.strictEqual(r.status, 409);
  });
  await check('+ Entity refuses a type the database does not allow', async () => {
    const r = await post('/entity', { name: 'Zz Typo LLC', entity_type: 'trust' });
    assert.strictEqual(r.status, 400);
    assert.strictEqual(r.body.field, 'entity_type');
  });

  /* ---- + Building ---- */
  inside = async (c, out) => { seen = (await c.query('select unit_identifier, current_total_units, building_type, location_street, entity_id from public.unit where id = $1', [out.id])).rows[0]; };
  await check('+ Building adds a building with no address of its own', async () => {
    const r = await post('/property/' + copper + '/building', { name: 'Building 99', units: '0', building_type: 'garage' });
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    assert.strictEqual(seen.unit_identifier, 'Building 99');
    assert.strictEqual(seen.current_total_units, 0, '0 on a garage is complete data');
    assert.strictEqual(seen.location_street, null);
  });
  inside = null;
  await check('+ Building refuses a name the property already has', async () => {
    const r = await post('/property/' + copper + '/building', { name: 'building 1', units: 4 });
    assert.strictEqual(r.status, 409);
  });
  await check('+ Building needs a whole number of apartments', async () => {
    const r = await post('/property/' + copper + '/building', { name: 'Building 98', units: '2.5' });
    assert.strictEqual(r.status, 400);
    assert.strictEqual(r.body.field, 'units');
  });

  /* ---- H3 ---- */
  await check('the checklist answers the four spec questions for Copperleaf', async () => {
    const r = await get('/property/' + copper + '/checklist');
    assert.deepStrictEqual(r.body.items.map(i => i.key), ['sync', 'dropbox', 'fee', 'loan']);
    assert.deepStrictEqual(r.body.items.map(i => i.label), ['Sync name matched', 'Dropbox folder set', 'Fee set', 'Loan on file']);
    assert.ok(r.body.items.every(i => i.done), JSON.stringify(r.body.items));
  });

  await check('the route file can only INSERT: no UPDATE or DELETE statement', async () => {
    const src = fs.readFileSync(path.join(ROOT, 'portfolio-setup-api.js'), 'utf8').replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    assert.ok(!/\b(update|delete)\s+(from\s+)?public\./i.test(src), 'found a write other than insert');
  });
  await check('nothing this suite created is left in the database', async () => {
    const r = await realQ(`select (select count(*) from public.property where dba_name like 'Zz %')::int p,
                                  (select count(*) from public.entity where name like 'Zz %')::int e,
                                  (select count(*) from public.unit where property_id = $1 and unit_identifier = 'Building 99')::int u`, [copper]);
    assert.deepStrictEqual(r.rows[0], { p: 0, e: 0, u: 0 });
  });

  srv.close();
  console.log('\nportfolio setup: ' + pass + ' passed, ' + fails.length + ' failed');
  fails.forEach(f => console.log('  FAIL  ' + f));
  process.exit(fails.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
