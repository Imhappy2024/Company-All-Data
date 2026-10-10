/* Refresh the reporting materialised views.

   RUN THIS AFTER A SYNC — a T12 export, a rent roll import, a loan edit.

   The Properties section reads the materialised copies, so until this runs it
   shows the state as of the last refresh. That is deliberate rather than a
   compromise: the source data arrives in batches, and recomputing four passes
   over the monthly spine on every page load cost 1.1s in Postgres and ~2.9s
   at the browser for the section's front door.

     node tools/refresh-reporting.js

   Refreshes CONCURRENTLY where it can, so the screen stays up while it runs.
*/
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
for (const l of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
  const m = /^([A-Za-z0-9_]+)=(.*)$/.exec(l.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
const db = require(path.join(ROOT, 'supabase-db'));

(async () => {
  const t0 = Date.now();
  await db.q('select reporting.refresh_reporting()', []);
  const r = await db.q(
    `select (select count(*) from reporting.property_month_mv)   as months,
            (select count(*) from reporting.property_summary_mv) as properties`, []);
  console.log('refreshed in ' + (Date.now() - t0) + 'ms  |  ' +
    r.rows[0].months + ' month rows, ' + r.rows[0].properties + ' properties');
  await db.getPool().end();
})().catch(e => { console.error(e.message); process.exit(1); });
