/* Runs EXPLAIN over every statement the Folio financials API issues.
   ---------------------------------------------------------------------------
   WHY THIS EXISTS

   test/test-folio-financials.js stands a fake in for Postgres, so a statement
   the database REFUSES passes all 62 of its checks. That is not a theoretical
   gap: the filter-options query was written as five scalar subqueries in the
   select list, each `(select array_agg(…) from s)` over a subquery aliased `s`
   in the FROM. A sub-select in the target list cannot reference a sibling FROM
   item as a relation, so Postgres answered

       relation "s" does not exist

   and Reports & Financials rendered nothing but that sentence. Every test was
   green.

   The suite now lints relation names, which catches that specific shape. This
   catches the rest: a mistyped column, a wrong cast, an aggregate in the wrong
   place - anything the planner refuses.

   ---------------------------------------------------------------------------
   HOW IT WORKS

   It mounts the router against a recording stub, calls every route (and the
   filter combinations that change the SQL), then EXPLAINs each distinct
   statement with its real parameters. EXPLAIN plans without executing, so this
   is read-only twice over: the module refuses any write verb, and nothing here
   runs a query body.

   Needs SUPABASE_DB_URL. With it unset the statements are printed and nothing
   is checked, which is still useful - the dump is what you paste into the SQL
   editor.

       SUPABASE_DB_URL=... node tools/check-folio-sql.js
       node tools/check-folio-sql.js --print

   Exit code is 1 if any statement fails to plan, so this can gate a deploy. */

const http = require('http');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const seen = [];

/* Stand in for supabase-db BEFORE the module is required, so it records
   statements instead of running them. `enabled: true` is what gets the router
   past its own 503 guard. */
const MEMBERSHIP = process.env.FOLIO_MEMBERSHIP || 'mem_m1Z0CYCBZUtgxy';

const recorder = {
  enabled: true,
  getPool() { throw new Error('the recorder has no pool'); },
  q(sql, params) {
    seen.push({ sql, params });
    /* The subscriber lookup has to answer with a row, or /subscribers/:id/
       payments 404s before it ever issues the statement this tool exists to
       check - and the payment predicate is the most intricate one in the
       module (it widens past the subscription join when test rows are asked
       for). Returning nothing here would silently drop two statements from
       the run, which is the same class of blind spot as the fake in the test
       suite. */
    if (/select sc\.id, sc\.company, sc\.provider/.test(sql)) {
      return Promise.resolve({ rows: [{
        id: params[params.length - 1], company: 'recorded',
        provider: 'whop', external_subscription_id: MEMBERSHIP,
      }] });
    }
    /* An ungrouped aggregate returns ONE row over zero rows, so the routes
       that destructure `const [m] = await q(...)` get an object rather than
       undefined. Without this they throw, log, and the run is littered with
       errors that look like the tool is broken. This mirrors Postgres rather
       than papering over it. */
    if (/^\s*(with\s|select\s+count\()/i.test(sql)) return Promise.resolve({ rows: [{}] });
    return Promise.resolve({ rows: [] });
  },
};
require.cache[require.resolve(path.join(ROOT, 'supabase-db'))] =
  { id: 'recorder', filename: 'recorder', loaded: true, exports: recorder };

const express = require(path.join(ROOT, 'node_modules', 'express'));
const folio = require(path.join(ROOT, 'folio-financials-api'));

/* A real subscriber id is needed for the per-row payment route; the route 404s
   on anything else and would issue only its lookup. Read it from the argv if
   the row ever changes. */
const SUB_ID = process.env.FOLIO_SUB_ID || 'a3b28821-67f7-4252-8e93-71a8293dcc69';

const ROUTES = [
  '/summary',
  '/subscribers',
  '/subscribers?status[]=active&payment_status[]=paid',
  '/subscribers?billing_period[]=' + encodeURIComponent('(not set)'),
  '/subscribers?plan[]=' + encodeURIComponent('(not set)') + '&provider[]=whop',
  '/subscribers?from=2026-08-01&to=2026-08-31',
  '/subscribers?from=2026-08-01&to=2026-08-31&include_test=true',
  '/subscribers/' + SUB_ID + '/payments',
  '/subscribers/' + SUB_ID + '/payments?include_test=true',
  '/payments',
  '/payments?include_test=true&status[]=paid&provider[]=whop',
  '/payments?from=2026-01-01&to=2026-12-31',
  '/export?view=subscribers',
  '/export?view=subscribers&status[]=active',
  '/export?view=payments',
  '/export?view=payments&include_test=true',
];

function call(port, p) {
  return new Promise(resolve => {
    http.get({ port, path: '/api/folio/financials' + p }, res => {
      res.on('data', () => {});
      res.on('end', () => resolve());
    }).on('error', () => resolve());
  });
}

(async () => {
  const app = express();
  app.use('/api/folio/financials', folio.folioFinancialsRoutes());
  const srv = app.listen(0);
  await new Promise(r => srv.once('listening', r));
  const port = srv.address().port;

  for (const r of ROUTES) await call(port, r);
  srv.close();

  /* Distinct by normalised text: most routes reissue the same statements. */
  const uniq = new Map();
  for (const s of seen) {
    const key = s.sql.replace(/\s+/g, ' ').trim() + ' :: ' + JSON.stringify(s.params);
    if (!uniq.has(key)) uniq.set(key, s);
  }
  const statements = [...uniq.values()];
  console.log(`${seen.length} statements issued across ${ROUTES.length} requests, ` +
              `${statements.length} distinct.`);

  const url = process.env.SUPABASE_DB_URL;
  if (!url || process.argv.indexOf('--print') >= 0) {
    statements.forEach((s, i) => {
      console.log(`\n----- ${i + 1} -----\nparams: ${JSON.stringify(s.params)}\n${s.sql.trim()}`);
    });
    if (!url) {
      console.log('\nSUPABASE_DB_URL is not set, so nothing was checked against a database.');
      console.log('The statements above are printed for review only.');
      process.exit(0);
    }
  }

  const { Pool } = require(path.join(ROOT, 'node_modules', 'pg'));
  const pool = new Pool({
    connectionString: url,
    ssl: /supabase\.co/.test(url) ? { rejectUnauthorized: false } : undefined,
    max: 2,
  });

  let failed = 0;
  for (let i = 0; i < statements.length; i++) {
    const s = statements[i];
    try {
      /* EXPLAIN, not the query: this validates parse, name resolution and
         planning without reading a row. */
      await pool.query('explain ' + s.sql, s.params);
      console.log(`  ok    ${i + 1}/${statements.length}`);
    } catch (err) {
      failed++;
      console.log(`  FAIL  ${i + 1}/${statements.length}  ${err.code || ''} ${err.message}`);
      console.log('        ' + s.sql.replace(/\s+/g, ' ').trim().slice(0, 200));
      console.log('        params: ' + JSON.stringify(s.params));
    }
  }
  await pool.end();

  console.log(failed
    ? `\n${failed} of ${statements.length} statements do not plan.`
    : `\nAll ${statements.length} statements plan against the live database.`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
