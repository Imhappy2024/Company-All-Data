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

/* Wrap a route so it always has an identity, and so a thrown AuthError turns
   into its own status rather than a 500. */
function guard(handler, opts) {
  const need = opts && opts.nav;
  return async function (req, res) {
    let who;
    try {
      who = await identify(req);
      if (need && !hasNav(who, need) && !isAdmin(who)) {
        throw new AuthError(403, 'You do not have access to this screen.');
      }
    } catch (e) {
      const status = e instanceof AuthError ? e.status : 500;
      if (status === 500) console.error('[identity]', e);
      return res.status(status).json({ error: e.message || 'Not authorised.' });
    }
    try {
      await handler(req, res, who);
    } catch (e) {
      console.error('[' + (req.baseUrl || '') + req.path + ']', e);
      if (!res.headersSent) res.status(500).json({ error: e.message || 'Server error.' });
    }
  };
}

module.exports = { identify, hasNav, isAdmin, guard, AuthError, bearer };
