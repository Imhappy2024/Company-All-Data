/* Create (or refresh) the four starter views from config/starter-views.json.
   Idempotent: it matches on name and never inserts a second copy.

     node tools/seed-starter-views.js            # create missing, leave the rest
     node tools/seed-starter-views.js --refresh  # also rewrite existing configs

   Every config goes through views-api's own validateConfig first, so a seed
   cannot create a view the application would refuse to load.

   NOTE on the report: it carries `group_by` and deliberately NO `aggregates`.
   A report groups in the RENDERER, with subtotals and a grand total, and it
   needs detail rows to do that. SQL aggregates collapse each row to the group
   key plus the aggregates, so every other column comes back absent and the
   table fills with dashes - which is exactly how it first shipped. */
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
for (const l of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
  const m = /^([A-Za-z0-9_]+)=(.*)$/.exec(l.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
const db = require(path.join(ROOT, 'supabase-db'));
const V = require(path.join(ROOT, 'views-api'))._internal;
const OWNER_EMAIL = process.env.STARTER_VIEW_OWNER || 'jay@leadliconsulting.com';
const refresh = process.argv.indexOf('--refresh') >= 0;

(async () => {
  const s = (await db.q(
    `select id, tenant_id, full_name from public.staff where lower(email) = lower($1)`,
    [OWNER_EMAIL])).rows[0];
  if (!s) throw new Error('owner not found: ' + OWNER_EMAIL);
  console.log('owner:', s.full_name);

  const starters = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'starter-views.json'), 'utf8'));
  for (const v of starters) {
    const { config, problems } = V.validateConfig(v.dataset_key, v.config);
    if (problems.length) console.log('  ! ' + v.name + ': ' + problems.join('; '));
    const existing = (await db.q(
      `select id from public.saved_view where tenant_id = $1 and name = $2 and deleted_at is null`,
      [s.tenant_id, v.name])).rows[0];
    if (existing && !refresh) { console.log('  exists   ' + v.name); continue; }
    if (existing) {
      await db.q(`update public.saved_view set config = $2::jsonb, description = $3,
                    display_type = $4, updated_at = now() where id = $1`,
        [existing.id, JSON.stringify(config), v.description, v.display_type]);
      console.log('  refreshed ' + v.name);
    } else {
      await db.q(`insert into public.saved_view
                    (tenant_id, owner_staff_id, name, description, dataset_key, display_type, config)
                  values ($1,$2,$3,$4,$5,$6,$7::jsonb)`,
        [s.tenant_id, s.id, v.name, v.description, v.dataset_key, v.display_type, JSON.stringify(config)]);
      console.log('  created   ' + v.name);
    }
  }
  await db.getPool().end();
})().catch(e => { console.error(e.message); process.exit(1); });
