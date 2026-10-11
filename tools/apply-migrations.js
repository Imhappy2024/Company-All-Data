// ===========================================================================
// tools/apply-migrations.js — apply migration files to the LIVE database,
// each in its own transaction, then refresh the reporting views.
//
//   node tools/apply-migrations.js migrations/a.sql migrations/b.sql
//
// Run tools/dry-run-migrations.js first. A file that fails rolls back alone
// and stops the run; files before it stay applied.
// ===========================================================================
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
process.loadEnvFile(path.join(ROOT, '.env'));
const db = require(path.join(ROOT, 'supabase-db.js'));

(async () => {
  const client = await db.getPool().connect();
  try {
    for (const f of process.argv.slice(2)) {
      await client.query('BEGIN');
      try {
        await client.query(fs.readFileSync(path.resolve(f), 'utf8'));
        await client.query('COMMIT');
        console.log('applied: ' + f);
      } catch (e) {
        await client.query('ROLLBACK');
        console.log('FAILED, rolled back: ' + f + ': ' + e.message);
        process.exitCode = 1;
        return;
      }
    }
  } finally { client.release(); }
  process.exit(process.exitCode || 0);
})();
