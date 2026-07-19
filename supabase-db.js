// ===========================================================================
// supabase-db.js — shared Postgres pool for the Supabase-backed features.
// Inert unless DATA_SOURCE=supabase AND SUPABASE_DB_URL is set. `pg` is loaded
// lazily so the dependency is only touched when the feature is enabled.
// ===========================================================================
const DATA_SOURCE = (process.env.DATA_SOURCE || 'clickup').toLowerCase();
const SUPABASE_DB_URL = process.env.SUPABASE_DB_URL || '';
const enabled = DATA_SOURCE === 'supabase' && !!SUPABASE_DB_URL;

let pool = null;
function getPool() {
  if (!enabled) return null;
  if (!pool) {
    const { Pool } = require('pg');
    pool = new Pool({
      connectionString: SUPABASE_DB_URL,
      ssl: { rejectUnauthorized: false },
      max: 6,
      idleTimeoutMillis: 30000,
    });
    pool.on('error', (e) => console.error('Supabase pool error:', e.message));
  }
  return pool;
}
function q(text, params) { return getPool().query(text, params); }

// Run fn(client) inside a single transaction. Commits on success, rolls back on any
// throw (and re-throws so the caller surfaces the error). client.query(text, params).
async function tx(fn) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw e;
  } finally {
    client.release();
  }
}

module.exports = { enabled, getPool, q, tx };
