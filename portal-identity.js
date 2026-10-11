// ===========================================================================
// portal-identity.js — who is calling, decided by the database.
//
// Every route added for the curated datasets and saved views reads through
// the privileged pg pool, where SUPABASE_DB_URL connects as the postgres
// SUPERUSER. RLS never runs on that connection and current_tenant_ids() is
// never called, so nothing downstream will stop one tenant reading another's
// rows. Authorization is therefore this module's job, and tenant scoping is
// the caller's.
//
// The identity is NOT decoded from the JWT. A JWT payload is base64, not a
// signature; anyone can craft one. It is established by asking Supabase to
// evaluate dash_my_access() AS the caller, which is the portal's existing
// contract and returns the staff record, the brands they can reach and their
// per-nav access levels in one call. If the token is bad, PostgREST refuses
// and nobody is identified.
//
// ghl-send.js already makes this argument for sends; the same reasoning
// applies to any read the superuser connection performs, because there is no
// second line behind it.
// ===========================================================================
'use strict';

const db = require('./supabase-db');

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || '';

class AuthError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function bearer(req) {
  const m = /^Bearer\s+(.+)$/i.exec((req.headers && req.headers.authorization) || '');
  return m ? m[1].trim() : null;
}

/* Ask Supabase to run dash_my_access() as the caller. A valid token that
   belongs to nobody with dashboard access returns a null `user`, which is a
   403 rather than a 401: they are signed in, they just cannot be here. */
async function identify(req) {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    throw new AuthError(503, 'Supabase is not configured on this deployment (SUPABASE_URL / SUPABASE_ANON_KEY).');
  }
  const token = bearer(req);
  if (!token) throw new AuthError(401, 'Not signed in.');

  let res;
  try {
    res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/dash_my_access`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: '{}',
    });
  } catch (e) {
    throw new AuthError(502, 'Could not reach Supabase to verify the session.');
  }
  if (res.status === 401 || res.status === 403) throw new AuthError(401, 'Session expired. Sign in again.');
  if (!res.ok) throw new AuthError(502, 'Could not verify the session (HTTP ' + res.status + ').');

  let body = null;
  try { body = await res.json(); } catch (e) { body = null; }
  const user = body && body.user;
  if (!user || !user.id) throw new AuthError(403, 'This account has no dashboard access.');

  /* tenant_id is not in dash_my_access's payload, and it is the scope every
     query below filters on. Read it by the staff id we have just proven,
     never from anything the caller sent. */
  const r = await db.q(
    'select tenant_id from public.staff where id = $1 and is_active and dashboard_access',
    [user.id]
  );
  if (!r.rows.length) throw new AuthError(403, 'This account has no dashboard access.');

  return {
    staffId: user.id,
    email: user.email || null,
    fullName: user.full_name || null,
    role: user.role || null,                     // owner | admin | user
    tenantId: r.rows[0].tenant_id,
    access: (body && body.access) || {},
    companies: (body && body.companies) || {},
  };
}

/* Does this person hold any grant for a nav id, in any brand or at exec?
   Used to gate a screen, never to decide which ROWS come back - rows are
   scoped by tenant in the query itself. */
function hasNav(identity, navId) {
  const a = (identity && identity.access) || {};
  for (const scope of Object.keys(a)) {
    if (a[scope] && Object.prototype.hasOwnProperty.call(a[scope], navId)) return true;
  }
  return false;
}

function isAdmin(identity) {
  return identity && (identity.role === 'owner' || identity.role === 'admin');
}

/* The person's Claude connector role (mcp.app_user.db_role), which every
   data query of theirs runs as (supabase-db.js runAs). Read on the
   privileged connection: the role is what decides access, so it cannot be
   looked up through itself. A person with no connector account, or an
   inactive one, has no data access - in the dashboard exactly as in Claude. */
/* cached 30s: a deactivation still bites at once, because identify() refuses
   anyone whose dashboard_access the sync has already turned off */
const roleCache = new Map();
async function connectorRole(staffId) {
  const hit = roleCache.get(staffId);
  if (hit && hit.at > Date.now() - 30000) return hit.role;
  const r = await db.privileged(() => db.q(
    `select u.db_role from mcp.app_user u where u.staff_id = $1 and u.active and u.db_role is not null`, [staffId]));
  if (!r.rows.length) { roleCache.delete(staffId); throw new AuthError(403, 'Your Claude connector account is not set up, so there is no data to show. Ask an admin.'); }
  roleCache.set(staffId, { role: r.rows[0].db_role, at: Date.now() });
  return r.rows[0].db_role;
}

function fail(res, e) {
  const status = e instanceof AuthError ? e.status : 500;
  if (status === 500) console.error('[identity]', e);
  return res.status(status).json({ error: e.message || 'Not authorised.' });
}

/* Express middleware: identify the caller and run the rest of the request
   as their connector role. For routers that do not call guard() per route. */
function asCaller() {
  return async function (req, res, next) {
    let who, role;
    try { who = await identify(req); role = await connectorRole(who.staffId); }
    catch (e) { return fail(res, e); }
    req.who = who;
    db.runAs(role, () => next());
  };
}

/* For the routes the /ops dashboard shares (/api/loans, /api/tracker): /ops
   sends a ClickUp token, not a Supabase session, so it keeps today's path.
   A portal request carries a session and runs as the person. This leaves the
   /ops path as open as it was; it closes when /ops is retired. */
function asCallerIfSession() {
  const mw = asCaller();
  return function (req, res, next) {
    const t = bearer(req);
    /* a ClickUp token is not a JWT; a Supabase session token is (three dot-separated parts) */
    if (t && t.split('.').length === 3) return mw(req, res, next);
    return next();
  };
}

/* Express middleware for admin-only and legacy routers: owner or admin, run
   on the privileged connection. Users & Roles and the setup forms live here,
   so an admin can always repair access even when grants are wrong. */
function adminOnly() {
  return async function (req, res, next) {
    let who;
    try {
      who = await identify(req);
      if (!isAdmin(who)) throw new AuthError(403, 'Only an owner or admin can use this.');
    } catch (e) { return fail(res, e); }
    req.who = who;
    db.privileged(() => next());
  };
}

/* Wrap a route so it always has an identity, and so a thrown AuthError turns
   into its own status rather than a 500. The handler runs as the caller's
   connector role, unless opts.privileged (owner/admin only) or the router is
   already inside adminOnly(). */
function guard(handler, opts) {
  const need = opts && opts.nav;
  const priv = !!(opts && opts.privileged);
  return async function (req, res) {
    let who, role = null;
    const already = db.currentRole() === null && db.inPrivileged();
    try {
      who = await identify(req);
      if (need && !hasNav(who, need) && !isAdmin(who)) {
        throw new AuthError(403, 'You do not have access to this screen.');
      }
      if ((priv || already) && !isAdmin(who)) throw new AuthError(403, 'Only an owner or admin can use this.');
      if (!priv && !already) role = await connectorRole(who.staffId);
    } catch (e) { return fail(res, e); }
    const run = () => handler(req, res, who);
    try {
      await (role ? db.runAs(role, run) : db.privileged(run));
    } catch (e) {
      console.error('[' + (req.baseUrl || '') + req.path + ']', e);
      if (!res.headersSent) res.status(500).json({ error: e.message || 'Server error.' });
    }
  };
}

module.exports = { identify, hasNav, isAdmin, guard, asCaller, asCallerIfSession, adminOnly, connectorRole, AuthError, bearer };
