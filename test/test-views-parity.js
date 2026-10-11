/* The builder's preview runs in the browser (public/props-views-core.js over
   GET /api/props/views/dataset); a saved view runs on the server
   (props-views.evaluate). They must give the SAME answer. This evaluates a
   set of configs both ways against the live database and compares.

   Run:  node test/test-views-parity.js
*/
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const ROOT = path.join(__dirname, '..');
for (const l of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
  const m = /^([A-Za-z0-9_]+)=(.*)$/.exec(l.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
const db = require(path.join(ROOT, 'supabase-db.js'));
const V = require(path.join(ROOT, 'props-views.js'));
const core = require(path.join(ROOT, 'public', 'props-views-core.js'));
const TENANT = '72381c81-af95-4e1d-ad0d-20a3a3421119';

let pass = 0; const fails = [];
const check = (n, fn) => { try { fn(); pass++; } catch (e) { fails.push(n + ' -> ' + e.message.slice(0, 300)); } };

(async () => {
  const all = (await db.q(`select id::text id from reporting.property_summary_mv where tenant_id = $1 order by name limit 40`, [TENANT])).rows.map(r => r.id);
  const groups = (await db.q(`select g.id::text id, g.name, coalesce(array_agg(m.property_id::text order by m.property_id) filter (where m.property_id is not null), '{}') property_ids
      from public.property_group g left join public.property_group_member m on m.group_id = g.id where g.tenant_id = $1 group by g.id`, [TENANT])).rows;
  const dataset = await V.loadPlain(null, TENANT);
  const t = dataset.through, prev = core.ymAdd(t, -1);
  const fields = core.FIELD_LIST.map(f => f.key);

  const configs = [
    { name: 'every field, picked properties', cfg: { mode: 'quick', quickCards: true, props: all, fields, styles: ['table', 'list', 'chart'], chartField: 'noi', cards: [] } },
    { name: 'advanced cards: periods, averages, formula', cfg: { mode: 'advanced', props: all.slice(0, 12), fields: ['units', 'noi', 'dscr'], styles: ['table'], chartField: 'inc',
      cards: [
        { id: 'a', label: 'YTD income', kind: 'value', field: 'inc', period: { t: 'ytd' }, agg: 'total', size: 'M' },
        { id: 'b', label: 'Avg NOI last month', kind: 'value', field: 'noi', period: { t: 'month', a: t }, agg: 'avg', size: 'S' },
        { id: 'c', label: 'Range capex', kind: 'value', field: 'capex', period: { t: 'range', a: core.ymAdd(t, -5), b: t }, agg: 'total', size: 'L' },
        { id: 'd', label: 'Growth', kind: 'formula', fmt: 'pct', terms: [
          { kind: 'field', field: 'inc', period: { t: 'month', a: t }, agg: 'total' },
          { op: '-', kind: 'field', field: 'inc', period: { t: 'month', a: prev }, agg: 'total' },
          { op: '/', kind: 'field', field: 'inc', period: { t: 'month', a: prev }, agg: 'total' }] },
        { id: 'e', label: 'Occupancy', kind: 'value', field: 'occ', size: 'M' },
      ], layout: [] } },
  ];
  if (groups.length) {
    const g = groups.find(x => x.property_ids.length > 1) || groups[0];
    configs.push({ name: 'a property group with one exclusion', cfg: { mode: 'quick', quickCards: true, groups: [g.id],
      excl: g.property_ids.length > 1 ? [g.id + '|' + g.property_ids[0]] : [], fields: ['inc', 'noi', 'occ', 'address'], styles: ['table'], cards: [] } });
  }

  for (const c of configs) {
    const cfg = core.validateConfig(c.cfg);
    const server = await V.evaluate(cfg, TENANT);
    const browser = core.evaluateData(cfg, core.resolve(cfg, groups), JSON.parse(JSON.stringify(dataset)));
    check(c.name + ': same answer in the browser as on the server', () => assert.deepStrictEqual(browser, server));
    check(c.name + ': has rows', () => assert.ok(server.count > 0, 'count ' + server.count));
  }
  console.log('views parity: ' + pass + ' passed, ' + fails.length + ' failed  (' + configs.length + ' configs, ' + dataset.props.length + ' properties in the dataset)');
  fails.forEach(f => console.log('  FAIL ' + f));
  process.exit(fails.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
