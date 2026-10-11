// ===========================================================================
// people-api.js — Users & Roles, on the connector's own access model.
//
// mounted at /api/people behind portal-identity adminOnly(): owners and
// admins, on the privileged connection (so an admin can always repair access,
// even when someone's grants are wrong).
//
// ONE model. Who may see what lives in mcp.access_grant (+ mcp.app_user for
// active / principal), exactly the rows the Claude connector reads and its
// own admin tools write. The dashboard's public.dashboard_permission is
// DERIVED from them by mcp.sync_dashboard() (triggers on every change), and
// the dashboard's data queries run as the person's connector role, so the
// dashboard and Claude cannot disagree. Every change is logged in
// mcp.access_change with the signed-in admin as changed_by (mcp.actor).
//
//   GET    /                     companies, levels, screens, people, recent log
//   PUT    /:id                  levels per company, principal, screen choices
//   POST   /:id/emails           add an address (an alias of the same account)
//   DELETE /:id/emails/:email    remove a non-primary address
//   POST   /:id/deactivate       connector off, dashboard off, login banned
//   POST   /:id/reactivate       the reverse
//   POST   /:id/send-token       a NEW connector token, emailed to the person
//   POST   /invite               create or update a person end to end
//
// The connector token is never returned to the browser: it is created here,
// handed straight to the n8n email workflow, and dropped.
// ===========================================================================
'use strict';

const express = require('express');
const crypto = require('crypto');
const db = require('./supabase-db');

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE || '';
const INVITE_URL = process.env.CONNECTOR_INVITE_URL || '';
const INVITE_SECRET = process.env.CONNECTOR_INVITE_SECRET || '';
const MCP_URL = process.env.CONNECTOR_MCP_URL || 'https://lw-data-mcp-production.up.railway.app/mcp';
/* The connector logs in as each person's role with a password derived from
   this secret (lw-data-mcp src/db.js rolePassword). Provisioning a role here
   with anything else would lock the person out of Claude, so without it the
   invite refuses rather than guesses. Same value as on the lw-data-mcp service. */
const MCP_ROLE_SECRET = process.env.MCP_ROLE_SECRET || '';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/* Plain-English names, in the order the screen offers them. Descriptions come
   from mcp.access_level, so the two tools describe a level in the same words. */
const LABELS = {
  admin: 'Admin', user: 'Editor (no financials)', user_2: 'Viewer with financials', user_3: 'Viewer without financials',
  custom: 'Custom', principal: 'Principal', lw_corporate: 'Corporate', lw_user: 'Operations',
  lw_user_ro: 'Operations (read-only)', lw_viewer: 'Property facts only',
};

class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
const roleFor = (userId) => 'mcp_u_' + userId.replace(/-/g, '').slice(0, 12);
const rolePassword = (role) => crypto.createHmac('sha256', MCP_ROLE_SECRET).update(role, 'utf8').digest('hex');

/* every write runs in one transaction, with the admin named on the audit rows */
function asAdmin(who, fn) {
  return db.tx(async (c) => {
    await c.query(`select set_config('mcp.actor', $1, true)`, [who.email || who.fullName || 'dashboard admin']);
    return fn(c);
  });
}

async function person(c, userId) {
  const r = await c.query(`select u.*, s.user_id as auth_user_id, s.full_name as staff_name from mcp.app_user u
                             left join public.staff s on s.id = u.staff_id where u.id = $1`, [userId]);
  if (!r.rows.length) throw new HttpError(404, 'No such person.');
  return r.rows[0];
}

/* ---- GET / --------------------------------------------------------------- */
async function overview(req, res) {
  const who = req.who;
  const [companies, levels, scopes, navs, levelMods, people, log, principals] = await Promise.all([
    db.q(`select key, company_id::text company_id, name from mcp.company order by name`),
    db.q(`select name, description, sort from mcp.access_level order by sort`),
    db.q(`select level, scope_kind from mcp.level_scope`),
    db.q(`select coalesce(m.company_id::text, 'exec') company_id, m.nav_id, m.label, m.sort from public.dashboard_module m order by m.sort`),
    db.q(`select level, area, nav_id, can_write from mcp.level_module`),
    db.q(`
      with p as (
        select u.id user_id, s.id staff_id from mcp.app_user u left join public.staff s on s.id = u.staff_id
        union
        select null, s.id from public.staff s
         where (s.is_active or s.dashboard_access) and not exists (select 1 from mcp.app_user u where u.staff_id = s.id)
      )
      select p.user_id, p.staff_id, coalesce(s.full_name, u.full_name) full_name, s.title, s.avatar_url,
             s.email staff_email, s.is_active staff_active, s.dashboard_access, s.dashboard_role, (s.user_id is not null) has_login,
             u.email connector_email, u.active, u.principal, u.dashboard_owner owner, u.dashboard_synced synced,
             (u.db_role is not null) has_role, u.last_seen_at,
             coalesce((select json_agg(json_build_object('email', e.email, 'primary', e.is_primary) order by e.is_primary desc, e.email)
                         from mcp.app_user_email e where e.user_id = u.id), '[]') emails,
             coalesce((select json_agg(json_build_object('scope', g.scope, 'level', g.level) order by g.scope)
                         from mcp.access_grant g where g.user_id = u.id), '[]') grants,
             coalesce((select json_agg(json_build_object('scope', r.scope, 'area', r.area, 'nav_id', r.nav_id, 'max', r.max))
                         from mcp.module_restriction r where r.user_id = u.id), '[]') restrictions,
             coalesce((select json_agg(json_build_object('scope', cm.scope, 'nav_id', cm.nav_id, 'can_write', cm.can_write))
                         from mcp.custom_module cm where cm.user_id = u.id), '[]') custom_modules,
             (select count(*) from mcp.custom_access ca where ca.user_id = u.id)::int custom_tables,
             coalesce((select json_agg(json_build_object('company_id', coalesce(d.company_id::text, 'exec'), 'nav_id', d.nav_id, 'level', d.level))
                         from mcp.dashboard_modules(u.id) d where u.id is not null), '[]') screens
        from p left join mcp.app_user u on u.id = p.user_id left join public.staff s on s.id = p.staff_id
       order by coalesce(s.full_name, u.full_name)`),
    db.q(`select at, changed_by, person, scope, what, old_value, new_value from mcp.access_change order by id desc limit 60`),
    db.q(`select key, name from mcp.principal order by name`),
  ]);
  const kinds = {};
  scopes.rows.forEach(r => { (kinds[r.level] = kinds[r.level] || []).push(r.scope_kind); });
  res.json({
    me: { staffId: who.staffId, email: who.email, role: who.role },
    companies: companies.rows,
    levels: levels.rows.map(l => ({ name: l.name, label: LABELS[l.name] || l.name, description: l.description, scopes: kinds[l.name] || [] })),
    navs: navs.rows, levelModules: levelMods.rows,
    people: people.rows, log: log.rows, principals: principals.rows,
    configured: { tokenEmail: !!(INVITE_URL && INVITE_SECRET), roleSecret: !!MCP_ROLE_SECRET, authAdmin: !!SUPABASE_SERVICE_ROLE },
  });
}

/* ---- writes ------------------------------------------------------------ */
function cleanGrants(list) {
  const out = new Map();
  for (const g of Array.isArray(list) ? list : []) {
    const scope = String((g && g.scope) || '').trim(), level = String((g && g.level) || '').trim();
    if (!scope || !level) continue;
    if (!/^[a-z_]{2,32}$/.test(scope) || !/^[a-z_0-9]{2,32}$/.test(level)) throw new HttpError(400, 'Bad level or company.');
    out.set(scope, level);
  }
  return out;
}

/* Write one person's levels, principal and screen choices. The database
   validates every grant (mcp.check_access_grant: known company, level allowed
   for that company, principal set before Principal) and its message is passed
   back word for word. */
async function writeAccess(c, who, userId, b) {
  const p = await person(c, userId);
  const want = cleanGrants(b.grants);

  /* only the owner changes the owner's access */
  if (p.dashboard_owner && who.role !== 'owner') throw new HttpError(403, 'Only the owner can change the owner\'s access.');
  /* nobody locks themselves out of the screen that fixes access */
  if (p.staff_id && p.staff_id === who.staffId && want.get('all') !== 'admin') {
    throw new HttpError(400, 'You cannot remove your own admin access on every company. Ask another admin.');
  }
  if (b.owner !== undefined && !!b.owner !== !!p.dashboard_owner) {
    if (who.role !== 'owner') throw new HttpError(403, 'Only the owner can change who is owner.');
    await c.query(`update mcp.app_user set dashboard_owner = $2 where id = $1`, [userId, !!b.owner]);
  }
  if (b.principal !== undefined) {
    const pr = b.principal ? String(b.principal) : null;
    await c.query(`update mcp.app_user set principal = $2 where id = $1`, [userId, pr]);
  }

  const have = new Map((await c.query(`select scope, level from mcp.access_grant where user_id = $1`, [userId])).rows.map(r => [r.scope, r.level]));
  for (const [scope] of have) if (!want.has(scope)) await c.query(`delete from mcp.access_grant where user_id = $1 and scope = $2`, [userId, scope]);
  for (const [scope, level] of want) {
    if (!have.has(scope)) {
      await c.query(`insert into mcp.access_grant (user_id, scope, level, granted_by) values ($1, $2, $3, $4)`, [userId, scope, level, who.email]);
    } else if (have.get(scope) !== level) {
      await c.query(`update mcp.access_grant set level = $3, granted_by = $4, granted_at = now() where user_id = $1 and scope = $2`, [userId, scope, level, who.email]);
    }
  }

  if (Array.isArray(b.restrictions)) {
    await c.query(`delete from mcp.module_restriction where user_id = $1`, [userId]);
    for (const r of b.restrictions) {
      if (!r || !['none', 'read'].includes(r.max) || !['company', 'exec'].includes(r.area)) continue;
      await c.query(`insert into mcp.module_restriction (user_id, scope, area, nav_id, max, set_by) values ($1, $2, $3, $4, $5, $6)
                     on conflict (user_id, scope, area, nav_id) do update set max = excluded.max, set_by = excluded.set_by, set_at = now()`,
        [userId, String(r.scope), r.area, String(r.nav_id), r.max, who.email]);
    }
  }
  if (Array.isArray(b.customModules)) {
    await c.query(`delete from mcp.custom_module where user_id = $1`, [userId]);
    for (const m of b.customModules) {
      if (!m || want.get(String(m.scope)) !== 'custom') continue;
      await c.query(`insert into mcp.custom_module (user_id, scope, nav_id, can_write, set_by) values ($1, $2, $3, $4, $5)`,
        [userId, String(m.scope), String(m.nav_id), !!m.can_write, who.email]);
    }
  }

  /* managed from here on: the dashboard follows the grants */
  if (p.staff_id && !p.dashboard_synced) await c.query(`update mcp.app_user set dashboard_synced = true where id = $1`, [userId]);
  await c.query(`select mcp.sync_user_access($1)`, [userId]);
  await c.query(`select mcp.sync_dashboard($1)`, [userId]);
}

async function updatePerson(req, res) {
  const id = req.params.id;
  if (!UUID.test(id)) throw new HttpError(400, 'Bad person id.');
  await asAdmin(req.who, c => writeAccess(c, req.who, id, req.body || {}));
  res.json({ ok: true });
}

async function addEmail(req, res) {
  const id = req.params.id, email = String((req.body || {}).email || '').trim().toLowerCase();
  if (!UUID.test(id)) throw new HttpError(400, 'Bad person id.');
  if (!EMAIL.test(email)) throw new HttpError(400, 'Enter a valid email address.');
  await asAdmin(req.who, async (c) => {
    await person(c, id);
    const other = (await c.query(`select u.full_name from mcp.app_user_email e join mcp.app_user u on u.id = e.user_id where e.email = $1`, [email])).rows[0];
    if (other) throw new HttpError(409, email + ' already belongs to ' + other.full_name + '.');
    await c.query(`insert into mcp.app_user_email (email, user_id, is_primary, added_by) values ($1, $2, false, $3)`, [email, id, req.who.email]);
  });
  res.json({ ok: true });
}

async function removeEmail(req, res) {
  const id = req.params.id, email = String(req.params.email || '').toLowerCase();
  if (!UUID.test(id)) throw new HttpError(400, 'Bad person id.');
  await asAdmin(req.who, async (c) => {
    const r = await c.query(`delete from mcp.app_user_email where user_id = $1 and email = $2 and not is_primary returning email`, [id, email]);
    if (!r.rows.length) throw new HttpError(400, 'Only a secondary address can be removed; the primary one is the connector sign-in.');
  });
  res.json({ ok: true });
}

/* ---- Supabase Auth: ban / unban / invite (service role, server-side only) */
async function authAdmin(method, path, body) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) throw new HttpError(503, 'SUPABASE_SERVICE_ROLE is not set on this deployment.');
  const r = await fetch(SUPABASE_URL + '/auth/v1' + path, {
    method,
    headers: { apikey: SUPABASE_SERVICE_ROLE, Authorization: 'Bearer ' + SUPABASE_SERVICE_ROLE,
               'X-Supabase-Api-Version': '2024-01-01', 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const t = await r.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch (e) { j = { message: t }; }
  if (!r.ok) throw new HttpError(r.status >= 400 && r.status < 600 ? r.status : 502, (j && (j.msg || j.message || j.error_description)) || ('HTTP ' + r.status));
  return j;
}

async function setActive(req, res, active) {
  const id = req.params.id;
  if (!UUID.test(id)) throw new HttpError(400, 'Bad person id.');
  let p;
  await asAdmin(req.who, async (c) => {
    p = await person(c, id);
    if (!active && p.staff_id === req.who.staffId) throw new HttpError(400, 'You cannot deactivate yourself.');
    if (p.dashboard_owner && req.who.role !== 'owner') throw new HttpError(403, 'Only the owner can deactivate or reactivate the owner.');
    await c.query(`update mcp.app_user set active = $2 where id = $1`, [id, active]);   // logged; dashboard sync follows
    if (active && p.db_role) await c.query('alter role "' + p.db_role.replace(/"/g, '') + '" login');
    await c.query(`select mcp.sync_user_access($1)`, [id]);                            // inactive: revoke + nologin
    await c.query(`select mcp.sync_dashboard($1)`, [id]);
  });
  /* the dashboard sign-in itself: banned while inactive, so a session cannot
     be renewed even though dashboard_access is already off */
  let login = 'no dashboard login';
  if (p.auth_user_id) {
    try { await authAdmin('PUT', '/admin/users/' + p.auth_user_id, { ban_duration: active ? 'none' : '876000h' }); login = active ? 'unbanned' : 'banned'; }
    catch (e) { login = 'could not ' + (active ? 'unban' : 'ban') + ': ' + e.message; }
  }
  res.json({ ok: true, login });
}

/* ---- the connector email (n8n "Connector access email") ---------------- */
async function emailToken(p, token, who, accessLines) {
  if (!INVITE_URL || !INVITE_SECRET) return 'not sent: CONNECTOR_INVITE_URL / CONNECTOR_INVITE_SECRET are not set on this deployment';
  try {
    const r = await fetch(INVITE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-connector-invite-secret': INVITE_SECRET },
      body: JSON.stringify({ to: p.email, name: p.full_name, token, connector_url: MCP_URL, access: accessLines,
                             invited_by: who.fullName || who.email }),
    });
    return r.ok ? 'sent' : 'not sent: the email workflow answered HTTP ' + r.status;
  } catch (e) {
    return 'not sent: ' + e.message;
  }
}

async function accessLines(c, userId) {
  const r = await c.query(`select g.scope, g.level, co.name from mcp.access_grant g left join mcp.company co on co.key = g.scope where g.user_id = $1 order by g.scope`, [userId]);
  return r.rows.map(x => (x.scope === 'all' ? 'Every company' : (x.name || x.scope)) + ': ' + (LABELS[x.level] || x.level));
}

/* The new token replaces the old one only if the email carrying it was sent:
   the reset and the send happen in one transaction, and a failed send rolls
   the reset back, so the person keeps a working token either way. */
async function sendToken(req, res) {
  const id = req.params.id;
  if (!UUID.test(id)) throw new HttpError(400, 'Bad person id.');
  if (!INVITE_URL || !INVITE_SECRET) throw new HttpError(503, 'The connector email is not configured (CONNECTOR_INVITE_URL / CONNECTOR_INVITE_SECRET).');
  await asAdmin(req.who, async (c) => {
    const p = await person(c, id);
    if (p.dashboard_owner && req.who.role !== 'owner') throw new HttpError(403, 'Only the owner can reset the owner\'s token.');
    if (!p.active) throw new HttpError(400, 'Reactivate this person before sending them a connector token.');
    let token = (await c.query(`select mcp.reset_token($1) t`, [p.email])).rows[0].t;
    const lines = await accessLines(c, id);
    const sent = await emailToken(p, token, req.who, lines);
    token = null;
    if (sent !== 'sent') throw new HttpError(502, 'The email was not sent (' + sent + '), so the current token was kept.');
  });
  res.json({ ok: true, email: 'sent' });
}

/* ---- POST /invite --------------------------------------------------------
   One transaction for everything in the database: the staff record, the
   connector account (mcp.add_user, same email and name), its role
   (mcp.provision_user_role, with the connector's own password rule), the
   grants, and mcp.sync_user_access. Then, outside it, the dashboard sign-in
   invitation and the connector email. A failure in the transaction leaves
   nothing behind; a failed email can be re-sent with /send-token. */
async function invite(req, res) {
  const who = req.who, b = req.body || {};
  const first = String(b.first_name || '').trim(), last = String(b.last_name || '').trim();
  const email = String(b.email || '').trim().toLowerCase();
  const name = (first + ' ' + last).trim();
  if (!first || !last) throw new HttpError(400, 'First and last name are required.');
  if (!EMAIL.test(email)) throw new HttpError(400, 'Enter a valid email address.');
  if (!cleanGrants(b.grants).size) throw new HttpError(400, 'Choose a level for at least one company.');
  if (!MCP_ROLE_SECRET) {
    throw new HttpError(503, 'Invitations need MCP_ROLE_SECRET on the dashboard service (the same value as on lw-data-mcp), ' +
      'so the new person\'s database role gets the password the Claude connector signs in with. Set it in Railway and redeploy.');
  }

  let userId, staffId, token = null, created = false, authUserId, lines;
  await asAdmin(who, async (c) => {
    /* the person, by any of their addresses */
    userId = (await c.query(`select mcp.user_for_email($1) id`, [email])).rows[0].id;
    let staff = (await c.query(`select id, user_id from public.staff where tenant_id = $1 and lower(email) = $2`, [who.tenantId, email])).rows[0];
    if (!staff && userId) staff = (await c.query(`select s.id, s.user_id from mcp.app_user u join public.staff s on s.id = u.staff_id where u.id = $1`, [userId])).rows[0];
    if (!staff) {
      staff = (await c.query(`insert into public.staff (tenant_id, full_name, email, is_active, staff_type) values ($1, $2, $3, true, 'employee') returning id, user_id`,
        [who.tenantId, name, email])).rows[0];
    }
    staffId = staff.id; authUserId = staff.user_id;

    if (!userId) {
      token = (await c.query(`select mcp.add_user($1, $2) t`, [email, name])).rows[0].t;
      userId = (await c.query(`select mcp.user_for_email($1) id`, [email])).rows[0].id;
      created = true;
    } else {
      const u = (await c.query(`select active, staff_id from mcp.app_user where id = $1`, [userId])).rows[0];
      if (!u.active) throw new HttpError(409, email + ' has a deactivated connector account. Reactivate it instead of inviting again.');
      if (u.staff_id && u.staff_id !== staffId) throw new HttpError(409, email + ' belongs to a connector account linked to someone else.');
    }
    await c.query(`update mcp.app_user set staff_id = $2 where id = $1 and staff_id is distinct from $2`, [userId, staffId]);

    const role = roleFor(userId);
    await c.query(`select mcp.provision_user_role($1, $2)`, [userId, rolePassword(role)]);
    await writeAccess(c, who, userId, { grants: b.grants, principal: b.principal, restrictions: b.restrictions, customModules: b.customModules });
    lines = await accessLines(c, userId);
  });

  /* the dashboard sign-in: an email from Supabase with a link to set a password */
  let login = 'already has a dashboard login';
  if (!authUserId) {
    try {
      const base = (req.headers['x-forwarded-proto'] || req.protocol) + '://' + (req.headers['x-forwarded-host'] || req.get('host'));
      await authAdmin('POST', '/invite?redirect_to=' + encodeURIComponent(base + '/invite'), { email, data: { full_name: name } });
      login = 'invitation sent';
    } catch (e) {
      login = 'invitation not sent: ' + e.message;
    }
  }
  /* the connector email, only for a new account: an existing one already has a
     token, and replacing it would silently break whatever uses it */
  const connector = created ? await emailToken({ email, full_name: name }, token, who, lines) : 'existing connector account kept';
  token = null;
  res.status(201).json({ ok: true, userId, staffId, login, connector });
}

function peopleRoutes() {
  const r = express.Router();
  r.use(express.json({ limit: '64kb' }));
  const wrap = fn => (req, res) => Promise.resolve(fn(req, res)).catch(e => {
    const status = e instanceof HttpError ? e.status : (e && e.code && /^(23|P0|42)/.test(e.code) ? 400 : 500);
    if (status === 500) console.error('[people]', e);
    if (!res.headersSent) res.status(status).json({ error: e.message || 'Server error.' });
  });
  r.get('/', wrap(overview));
  r.post('/invite', wrap(invite));
  r.put('/:id', wrap(updatePerson));
  r.post('/:id/emails', wrap(addEmail));
  r.delete('/:id/emails/:email', wrap(removeEmail));
  r.post('/:id/deactivate', wrap((req, res) => setActive(req, res, false)));
  r.post('/:id/reactivate', wrap((req, res) => setActive(req, res, true)));
  r.post('/:id/send-token', wrap(sendToken));
  return r;
}

module.exports = { peopleRoutes, LABELS, _internal: { roleFor, cleanGrants } };
