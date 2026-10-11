// ===========================================================================
// supabase-db.js — shared Postgres pool for the Supabase-backed features.
// Inert unless DATA_SOURCE=supabase AND SUPABASE_DB_URL is set. `pg` is loaded
// lazily so the dependency is only touched when the feature is enabled.
//
// RUN AS THE CALLER. The pool connects as postgres, which reads everything.
// A request that portal-identity.js has identified runs inside runAs(role):
// every q() and tx() in it then executes in a transaction that starts with
// SET LOCAL ROLE <the person's connector role> (mcp_u_...), so Postgres
// applies the connector's grants and row rules - the same ones Claude gets.
// Code outside a request (jobs, the admin screens that deliberately use
// privileged()) keeps the plain connection.
// ===========================================================================
const { AsyncLocalStorage } = require('async_hooks');

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

/* { role: 'mcp_u_<12 hex>' } inside a caller's request, { role: null } inside
   privileged(), undefined outside any request */
const als = new AsyncLocalStorage();
const ROLE_RX = /^mcp_u_[0-9a-f]{12}$/;

function currentRole() { const s = als.getStore(); return s && s.role ? s.role : null; }
function inPrivileged() { const s = als.getStore(); return !!s && s.role === null; }
function runAs(role, fn) {
  if (role !== null && !ROLE_RX.test(String(role))) throw new Error('refusing to run as an unexpected role');
  return als.run({ role }, fn);
}
function privileged(fn) { return als.run({ role: null }, fn); }

/* One small pool per person's role, as the connector does (lw-data-mcp
   rolePools): every connection in it is switched to the role ONCE, when it
   opens, so a query is one round trip and a request's parallel queries stay
   parallel. A per-query SET LOCAL ROLE transaction cost three round trips and
   made a property page 3-4 s from a distant client. These connections are
   never handed to anything but that role's queries, and no code path here
   issues RESET ROLE. */
const rolePools = new Map();
const verified = new WeakSet();
function poolFor(role) {
  let p = rolePools.get(role);
  if (!p) {
    const { Pool } = require('pg');
    p = new Pool({ connectionString: SUPABASE_DB_URL, ssl: { rejectUnauthorized: false }, max: 3, idleTimeoutMillis: 30000 });
    p.on('error', (e) => console.error('Supabase role pool error:', e.message));
    rolePools.set(role, p);
  }
  return p;
}
/* A connection from a role pool, PROVEN to be that role. Checked on first use
   and the proof kept for the connection's life. Any failure destroys the
   connection and throws: a connection that silently stayed postgres would
   answer with everything, so it must never reach a query. */
async function roleClient(role) {
  const client = await poolFor(role).connect();
  if (verified.has(client)) return client;
  try {
    /* the name is checked against ROLE_RX, so quoting it is enough */
    await client.query('SET ROLE "' + role + '"');
    const who = (await client.query('select current_user u')).rows[0].u;
    if (who !== role) throw new Error('connection is ' + who + ', not ' + role);
    verified.add(client);
    return client;
  } catch (e) {
    client.release(true);
    throw new Error('Could not switch to your database role: ' + e.message);
  }
}

async function q(text, params) {
  const role = currentRole();
  if (!role) return getPool().query(text, params);
  const client = await roleClient(role);
  try { return await client.query(text, params); } finally { client.release(); }
}

// Run fn(client) inside a single transaction. Commits on success, rolls back on any
// throw (and re-throws so the caller surfaces the error). client.query(text, params).
async function tx(fn) {
  const role = currentRole();
  const client = role ? await roleClient(role) : await getPool().connect();
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

module.exports = { enabled, getPool, q, tx, runAs, privileged, currentRole, inPrivileged };
