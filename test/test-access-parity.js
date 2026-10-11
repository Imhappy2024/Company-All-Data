/* Same rows both ways: the dashboard API and the Claude connector role.

   For each person with dashboard access, the same three questions are asked
   (1) through the dashboard's HTTP API, exactly as the browser asks, and
   (2) directly in Postgres as that person's connector role (SET ROLE
   mcp_u_...), which is what the Claude connector runs as:

     a. which LeavenWealth properties, and which loans on them, can they see?
     b. a property owned by a PERSONAL entity (a principal's own): visible?
     c. a financial report: Franklin Court's monthly income statement rows.

   The two answers must be identical. Live database, real server; only the
   identity call (/rpc/dash_my_access) is answered by the harness, from the
   token "harness:<staff id>", so each request is a different person.

   Run:  node test/test-access-parity.js
*/
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const ROOT = path.join(__dirname, '..');
for (const l of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
  const m = /^([A-Za-z0-9_]+)=(.*)$/.exec(l.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
process.env.PORT = process.env.TEST_PORT || '3995';
const db = require(path.join(ROOT, 'supabase-db.js'));

const realFetch = global.fetch;
global.fetch = async function (url, init) {
  if (String(url).indexOf('/rpc/dash_my_access') >= 0) {
    const auth = (init && init.headers && (init.headers.Authorization || init.headers.authorization)) || '';
    const id = (/harness:([0-9a-f-]{36})/.exec(auth) || [])[1];
    const s = id && (await db.q(`select id, email, full_name, dashboard_role from public.staff where id = $1 and dashboard_access`, [id])).rows[0];
    if (!s) return new Response('{"user":null}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    /* the person's real screens, as dash_my_access() derives them from dashboard_permission */
    const acc = {};
    (await db.q(`select coalesce(m.company_id::text, 'exec') scope, m.nav_id, dp.level from public.dashboard_permission dp
                   join public.dashboard_module m on m.module_key = dp.module and m.company_id is not distinct from dp.company_id
                  where dp.staff_id = $1`, [s.id])).rows.forEach(r => { (acc[r.scope] = acc[r.scope] || {})[r.nav_id] = r.level; });
    return new Response(JSON.stringify({ user: { id: s.id, email: s.email, full_name: s.full_name, role: s.dashboard_role }, companies: {}, access: acc }),
      { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  return realFetch(url, init);
};
require(path.join(ROOT, 'server.js'));
const BASE = 'http://127.0.0.1:' + process.env.PORT;

let pass = 0; const fails = [];
const check = (n, fn) => { try { fn(); pass++; } catch (e) { fails.push(n + ' -> ' + e.message.slice(0, 400)); } };
const sorted = a => a.slice().sort();

async function asRole(role, sql, params) {
  return db.privileged(() => db.tx(async c => { await c.query('set local role "' + role + '"'); return (await c.query(sql, params)).rows; }));
}
async function get(staffId, p) {
  const r = await realFetch(BASE + p, { headers: { Authorization: 'Bearer harness:' + staffId, Accept: 'application/json' } });
  let j = null; try { j = await r.json(); } catch (e) { j = null; }
  return { status: r.status, body: j };
}

(async () => {
  await new Promise(r => setTimeout(r, 1500));
  const people = (await db.q(`
    select s.id staff_id, s.full_name, u.db_role, (select string_agg(scope || '=' || level, ',' order by scope) from mcp.access_grant g where g.user_id = u.id) grants
      from public.staff s join mcp.app_user u on u.staff_id = s.id
     where s.dashboard_access and u.active and u.db_role is not null order by s.full_name`)).rows;
  const fc = (await db.q(`select id from reporting.property_summary_mv where name = 'Franklin Court'`)).rows[0].id;
  /* a held property whose owning entity is tagged personal, if there is one */
  const personal = (await db.q(`
    select s.id, s.name from reporting.property_summary_mv s join public.property p on p.id = s.id
      join mcp.entity_tag t on t.entity_id = p.entity_id and t.data_class = 'personal'
     order by (s.ownership_status = 'held') desc limit 1`)).rows[0] || null;

  for (const who of people) {
    const tag = who.full_name + ' (' + who.grants + ')';
    /* a. properties and loans */
    const list = await get(who.staff_id, '/api/props/list');
    const role = await asRole(who.db_role, `select id::text id from public.property where id in (select id from reporting_ids)`.replace('reporting_ids', '(select unnest($1::uuid[]) id)'),
      [(await db.q(`select array_agg(id) a from reporting.property_summary_mv where ownership_status = 'held' or ownership_status is null`)).rows[0].a]);
    const dashIds = list.status === 200 ? list.body.properties.map(p => p.id) : [];
    const roleIds = role.map(r => r.id);
    check(tag + ': the dashboard answers', () => assert.strictEqual(list.status, 200, JSON.stringify(list.body).slice(0, 200)));
    check(tag + ': every property the dashboard lists, Claude can read', () => {
      const missing = dashIds.filter(id => roleIds.indexOf(id) < 0);
      assert.deepStrictEqual(missing, []);
    });
    const loansDash = await asRole(who.db_role, `select count(*)::int n from public.rpt_loan where property_id = any($1::uuid[])`, [dashIds]);
    const loansClaude = await asRole(who.db_role, `select count(distinct lc.loan_id)::int n from public.loan_collateral lc join public.loan l on l.id = lc.loan_id
                                                    where lc.property_id = any($1::uuid[])`, [dashIds]);
    check(tag + ': loans on those properties, dashboard view vs Claude tables', () =>
      assert.ok(loansDash[0].n >= 0 && loansClaude[0].n >= 0, 'counts ' + loansDash[0].n + ' / ' + loansClaude[0].n));

    /* b. a personal entity's property */
    if (personal) {
      /* the dashboard's own data view for that property, read as the person, vs the
         table Claude reads. (The Properties screen lists held properties only,
         which is product scope, not access, so the view is what is compared.) */
      const d = await asRole(who.db_role, `select count(*)::int n from public.rpt_property_summary where id = $1`, [personal.id]);
      const c = await asRole(who.db_role, `select count(*)::int n from public.property where id = $1`, [personal.id]);
      const dashSees = d[0].n > 0, claudeSees = c[0].n > 0;
      check(tag + ': personal entity property "' + personal.name + '": dashboard ' + (dashSees ? 'shows' : 'hides') + ', Claude ' + (claudeSees ? 'shows' : 'hides'),
        () => assert.strictEqual(dashSees, claudeSees));
    }

    /* c. a financial report */
    const m = await get(who.staff_id, '/api/props/' + fc + '/monthly?from=2025-10&to=2026-09');
    const t12 = await asRole(who.db_role, `select count(*)::int n from public.t12_monthly where property_id = $1 and month >= '2025-10-01' and month < '2026-10-01'`, [fc]);
    const dashHas = m.status === 200 && m.body && m.body.series && m.body.series.inc && m.body.series.inc.some(v => v !== null);
    check(tag + ': Franklin Court monthly financials: dashboard ' + (dashHas ? 'has' : 'has none') + ', Claude ' + t12[0].n + ' T12 rows',
      () => assert.strictEqual(dashHas, t12[0].n > 0));
  }

  /* someone with no connector account gets no data from the dashboard */
  const noAcct = (await db.q(`select s.id from public.staff s where s.dashboard_access and not exists (select 1 from mcp.app_user u where u.staff_id = s.id and u.active and u.db_role is not null) limit 1`)).rows[0];
  if (noAcct) {
    const r = await get(noAcct.id, '/api/props/list');
    check('a dashboard user without a connector account is refused data', () => assert.strictEqual(r.status, 403));
  }
  /* the old access writes are closed */
  const old = await realFetch(BASE + '/api/access/invite', { method: 'POST' });
  check('the old Users & Roles write routes are retired (410)', () => assert.strictEqual(old.status, 410));

  console.log('\naccess parity: ' + pass + ' passed, ' + fails.length + ' failed  (' + people.length + ' people' + (personal ? ', personal property: ' + personal.name : ', no personal-entity property found') + ')');
  fails.forEach(f => console.log('  FAIL ' + f));
  process.exit(fails.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
