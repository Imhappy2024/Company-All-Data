// ===========================================================================
// tools/dry-run-access.js — the three access migrations, applied to the LIVE
// database inside ONE transaction, checked, and ROLLED BACK. Nothing is kept.
//
//   node tools/dry-run-access.js [--json out.json]
//
// Checks: nobody's dashboard access changes; every connector account has its
// email in the alias list; what the new design would give each person; and,
// as sample people's connector roles, that the dashboard's rpt_ views show
// the same properties the connector's own tables show them.
// ===========================================================================
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
process.loadEnvFile(path.join(ROOT, '.env'));
const { Pool } = require('pg');

const PEOPLE = process.argv.indexOf('--with-people') > 0;
const FILES = ['20261011_access_1_identity_audit.sql', '20261011_access_2_level_modules.sql', '20261011_access_3_enforcement.sql']
  .concat(PEOPLE ? ['20261011_access_4_people.sql'] : [])
  .map(f => path.join(ROOT, 'migrations', f));
const strip = s => s.replace(/^﻿/, '').replace(/^\s*begin;\s*$/im, '').replace(/^\s*commit;\s*$/im, '');

(async () => {
  const pool = new Pool({ connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });
  const c = await pool.connect();
  const out = { checks: [], people: [], parity: [] };
  const ok = (name, pass, detail) => { out.checks.push({ name, pass, detail }); console.log((pass ? '  PASS  ' : '  FAIL  ') + name + (detail ? '  ' + detail : '')); };
  try {
    await c.query('begin');
    const perStaff = async () => (await c.query(`select s.full_name, s.dashboard_role r, s.dashboard_access a,
        (select string_agg(coalesce(co.name, 'Executive') || ':' || dp.module || '=' || dp.level, ', ' order by co.name nulls first, dp.module)
           from public.dashboard_permission dp left join public.company co on co.id = dp.company_id where dp.staff_id = s.id) p
       from public.staff s order by 1`)).rows;
    const staffRows0 = await perStaff();
    const before = (await c.query(`select count(*)::int n, md5(string_agg(staff_id || company_id::text || module || level, ',' order by staff_id, company_id, module)) h from public.dashboard_permission`)).rows[0];
    const staffBefore = (await c.query(`select md5(string_agg(id || coalesce(dashboard_role,'') || dashboard_access, ',' order by id)) h from public.staff`)).rows[0].h;
    for (const f of FILES) { await c.query(strip(fs.readFileSync(f, 'utf8'))); console.log('applied (in transaction) ' + path.basename(f)); }

    const after = (await c.query(`select count(*)::int n, md5(string_agg(staff_id || company_id::text || module || level, ',' order by staff_id, company_id, module)) h from public.dashboard_permission`)).rows[0];
    const staffAfter = (await c.query(`select md5(string_agg(id || coalesce(dashboard_role,'') || dashboard_access, ',' order by id)) h from public.staff`)).rows[0].h;
    if (!PEOPLE) {
      ok('nobody\'s dashboard permissions changed', before.h === after.h, before.n + ' rows before, ' + after.n + ' after');
      ok('nobody\'s dashboard role or access changed', staffBefore === staffAfter);
    } else {
      const staffRows1 = await perStaff();
      out.changed = [];
      staffRows1.forEach((r, i) => { const b = staffRows0[i]; if (JSON.stringify(b) !== JSON.stringify(r)) out.changed.push({ before: b, after: r }); });
      const names = out.changed.map(x => x.after.full_name).sort();
      ok('only Brian, Chris, Jay and Mitch change on the dashboard', names.every(n => /^(Brian Nelson|Chris Pomerleau|Jay Delgado|Mitch Hagen)$/.test(n)), names.join(', ') || 'nobody');
      for (const x of out.changed) console.log('    ' + x.after.full_name + '\n      before: ' + x.before.r + ' | ' + x.before.p + '\n      after:  ' + x.after.r + ' | ' + x.after.p);
      const g = (await c.query(`select u.email, string_agg(g.scope || '=' || g.level, ', ' order by g.scope) g, u.dashboard_owner o,
          (select string_agg(email, ', ' order by email) from mcp.app_user_email e where e.user_id = u.id) emails
          from mcp.app_user u left join mcp.access_grant g on g.user_id = u.id group by u.id order by 1`)).rows;
      g.forEach(r => console.log('    connector ' + r.email + ': ' + (r.g || 'no grants') + (r.o ? ' (owner)' : '') + '  emails: ' + r.emails));
    }
    const al = (await c.query(`select (select count(*) from mcp.app_user)::int u, (select count(distinct user_id) from mcp.app_user_email where is_primary)::int a`)).rows[0];
    ok('every connector account has its primary email in the alias list', al.u === al.a, al.a + ' of ' + al.u);

    /* the audit trigger fires, inside the transaction */
    await c.query(`select set_config('mcp.actor', 'dry-run', true)`);
    const any = (await c.query(`select user_id, scope, level from mcp.access_grant limit 1`)).rows[0];
    await c.query(`update mcp.access_grant set level = level where user_id = $1 and scope = $2`, [any.user_id, any.scope]);
    await c.query(`insert into mcp.module_restriction (user_id, scope, area, nav_id, max, set_by) values ($1, 'leavenwealth', 'company', 'tasks', 'read', 'dry-run')`, [any.user_id]);
    const logged = (await c.query(`select count(*)::int n from mcp.access_change where changed_by = 'dry-run'`)).rows[0].n;
    ok('a restriction change is logged with who made it', logged === 1, logged + ' row');
    await c.query(`delete from mcp.module_restriction where user_id = $1`, [any.user_id]);

    /* what the new design would set, per person (dashboard_synced stays false) */
    out.people = (await c.query(`
      select u.email, u.full_name, u.active, u.db_role is not null has_role, s.full_name staff_name, s.email staff_email,
             (select string_agg(g.scope || '=' || g.level, ', ' order by g.scope) from mcp.access_grant g where g.user_id = u.id) grants,
             case when exists (select 1 from mcp.access_grant g where g.user_id = u.id and g.scope = 'all' and g.level = 'admin') then 'owner' else 'user' end new_role,
             (select string_agg(coalesce(co.name, 'Executive') || ': ' || d.mods, ' | ' order by co.name nulls first) from (
                select company_id, string_agg(nav_id || (case when level = 'read' then '(r)' else '' end), ',' order by nav_id) mods
                  from mcp.dashboard_modules(u.id) group by 1) d left join public.company co on co.id = d.company_id) new_modules
        from mcp.app_user u left join public.staff s on s.id = u.staff_id order by u.full_name`)).rows;

    /* parity: as each sample person's connector role */
    const sample = (await c.query(`select u.full_name, u.db_role, (select string_agg(scope || '=' || level, ',') from mcp.access_grant where user_id = u.id) g
                                     from mcp.app_user u where u.db_role is not null and u.active order by u.full_name`)).rows;
    /* the properties the dashboard covers, read as postgres before switching role */
    const summaryIds = (await c.query(`select array_agg(id) ids from reporting.property_summary_mv`)).rows[0].ids;
    const loanIds = (await c.query(`select array_agg(distinct loan_id) ids from reporting.loan`)).rows[0].ids;
    for (const p of sample) {
      await c.query('savepoint p');
      try {
        if (!/^mcp_u_[0-9a-f]{12}$/.test(p.db_role)) throw new Error('unexpected role name ' + p.db_role);
        await c.query(`set local role ${p.db_role}`);
        const r = (await c.query(`
          select (select count(*) from public.property where id = any($1::uuid[]))::int via_tables,
                 (select count(*) from public.rpt_property_summary)::int via_dashboard,
                 (select count(*) from public.loan where id = any($2::uuid[]))::int loans_tables,
                 (select count(distinct loan_id) from public.rpt_loan)::int loans_dashboard`, [summaryIds, loanIds])).rows[0];
        out.parity.push(Object.assign({ person: p.full_name, grants: p.g }, r));
        ok(p.full_name + ' (' + p.g + '): same properties through the dashboard view as through the tables',
           r.via_tables === r.via_dashboard && r.loans_tables === r.loans_dashboard,
           'properties ' + r.via_dashboard + ' vs ' + r.via_tables + ', loans ' + r.loans_dashboard + ' vs ' + r.loans_tables);
      } catch (e) {
        out.parity.push({ person: p.full_name, grants: p.g, error: e.message });
        ok(p.full_name + ' (' + p.g + '): role query', false, e.message);
      }
      await c.query('rollback to savepoint p');
    }
  } catch (e) {
    console.log('  FAIL  migration error: ' + e.message + (e.where ? '\n        ' + e.where.split('\n')[0] : ''));
    out.error = e.message;
  } finally {
    await c.query('rollback');
    c.release(); await pool.end();
    console.log('rolled back: nothing kept');
  }
  const j = process.argv.indexOf('--json');
  if (j > 0) fs.writeFileSync(process.argv[j + 1], JSON.stringify(out, null, 2));
  process.exit(out.error || out.checks.some(x => !x.pass) ? 1 : 0);
})();
