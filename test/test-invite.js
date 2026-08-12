/* ===========================================================================
   test-invite.js - Step 5: POST /api/access/invite, and its rollback.

   The fake stands in for BOTH Supabase surfaces and enforces the constraints that
   make this flow difficult, rather than the happy shape:

     - staff_user_id_fkey is ON DELETE NO ACTION. The fake REFUSES to delete an Auth
       user while any staff row still references it, exactly as Postgres does. So a
       rollback that deletes in the wrong order fails here the way it would in
       production.
     - handle_new_user fires on Auth user creation and links staff.user_id by email
       match. The fake does that too, which is what creates the reference that then
       blocks the delete.

   Without both of those this test would pass against a rollback that is wrong.

   The invite ordering is: verify caller, validate grants, create Auth user, write
   staff + grants, and on failure undo the staff write BEFORE deleting the Auth user.
   =========================================================================== */
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

const APP = 4401;
const SB = 4402;
const ANON = 'anon-key';
const SERVICE = 'service-role-key';
const CALLER = 'caller-jwt';
const TENANT = '72381c81-af95-4e1d-ad0d-20a3a3421119';
const LW = 'c0000000-0000-4000-8000-000000000003';

let failures = 0;
function check(name, actual, want) {
  const a = JSON.stringify(actual), w = JSON.stringify(want);
  const ok = a === w;
  if (!ok) failures++;
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name +
    (ok ? '  ' + a : '\n          expected ' + w + '\n          actual   ' + a));
}

let db, log, failGrantWrite, callerRole;
function reset() {
  db = {
    authUsers: [{ id: 'au-owner', email: 'owner@x.invalid' }],
    staff: [
      { id: 's-owner', tenant_id: TENANT, email: 'owner@x.invalid', full_name: 'Chris Owner',
        user_id: 'au-owner', dashboard_access: true, dashboard_role: 'owner' },
      /* Existing staff, no dashboard access - the "Mitch already exists" case. */
      { id: 's-mitch', tenant_id: TENANT, email: 'mitch@x.invalid', full_name: 'Mitch Existing',
        user_id: null, dashboard_access: false, dashboard_role: null },
    ],
    perms: [],
    seq: 0,
  };
  log = [];
  failGrantWrite = false;
  callerRole = 'owner';
}

const sb = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    const u = new URL(req.url, 'http://x');
    const send = (code, obj) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(obj === null ? '' : JSON.stringify(obj));
    };
    const isService = req.headers.apikey === SERVICE;
    log.push(`${req.method} ${u.pathname}${u.search}${isService ? ' [service]' : ''}`);

    /* ---------------- Auth admin ---------------- */
    if (u.pathname === '/auth/v1/invite') {
      if (req.headers.apikey !== SERVICE) return send(401, { msg: 'service role required' });
      if (req.headers['x-supabase-api-version'] !== '2024-01-01') {
        return send(400, { msg: 'missing X-Supabase-Api-Version' });
      }
      const b = JSON.parse(body || '{}');
      const id = 'au-' + (++db.seq);
      db.authUsers.push({ id, email: b.email, redirect_to: u.searchParams.get('redirect_to') });
      /* handle_new_user: link a waiting staff row by email. This is what makes the
         delete-first ordering fail. */
      const row = db.staff.find(s => s.email.toLowerCase() === String(b.email).toLowerCase() && !s.user_id);
      if (row) row.user_id = id;
      return send(200, { id, email: b.email });
    }
    const del = u.pathname.match(/^\/auth\/v1\/admin\/users\/(.+)$/);
    if (del && req.method === 'DELETE') {
      const id = decodeURIComponent(del[1]);
      /* staff_user_id_fkey, ON DELETE NO ACTION. */
      if (db.staff.some(s => s.user_id === id)) {
        return send(409, { msg: 'update or delete on table "users" violates foreign key ' +
                                'constraint "staff_user_id_fkey" on table "staff"' });
      }
      db.authUsers = db.authUsers.filter(a => a.id !== id);
      return send(200, {});
    }
    if (del && req.method === 'PUT') {
      const id = decodeURIComponent(del[1]);
      const b = JSON.parse(body || '{}');
      const a = db.authUsers.find(x => x.id === id);
      if (a && b.email) a.email = b.email;
      return send(200, a || {});
    }

    /* ---------------- PostgREST ---------------- */
    const table = u.pathname.replace(/^\/rest\/v1\//, '');
    if (!req.headers.apikey) return send(401, { message: 'No API key found in request' });

    if (table === 'rpc/dash_my_access') {
      return send(200, {
        user: { id: 's-owner', email: 'owner@x.invalid', full_name: 'Chris Owner', role: callerRole },
        companies: { [LW]: 'LeavenWealth' },
        access: callerRole === 'owner'
          ? { exec: { exec: 'write' }, [LW]: { overview: 'write', properties: 'write' } }
          : { [LW]: { overview: 'write', properties: 'write' } },
      });
    }
    if (table === 'rpc/current_staff_id') return send(200, 's-owner');

    if (table === 'staff') {
      if (req.method === 'POST') {
        const b = JSON.parse(body || '{}');
        const row = Object.assign({ id: 's-new-' + (++db.seq) }, b);
        db.staff.push(row);
        return send(201, [row]);
      }
      if (req.method === 'PATCH') {
        const id = (u.searchParams.get('id') || '').replace('eq.', '');
        const byUser = (u.searchParams.get('user_id') || '').replace('eq.', '');
        const patch = JSON.parse(body || '{}');
        db.staff.filter(s => (id && s.id === id) || (byUser && s.user_id === byUser))
          .forEach(s => Object.assign(s, patch));
        return send(204, null);
      }
      if (req.method === 'DELETE') {
        const id = (u.searchParams.get('id') || '').replace('eq.', '');
        db.staff = db.staff.filter(s => s.id !== id);
        return send(204, null);
      }
      const idEq = (u.searchParams.get('id') || '').replace('eq.', '');
      const mail = (u.searchParams.get('email') || '').replace('ilike.', '').toLowerCase();
      const neq = (u.searchParams.get('id') || '').startsWith('neq.')
        ? u.searchParams.get('id').replace('neq.', '') : null;
      let rows = db.staff;
      if (idEq && !neq) rows = rows.filter(s => s.id === idEq);
      if (neq) rows = rows.filter(s => s.id !== neq);
      if (mail) rows = rows.filter(s => s.email.toLowerCase() === mail);
      return send(200, rows);
    }

    if (table === 'dashboard_permission') {
      if (req.method === 'POST') {
        if (failGrantWrite) {
          /* The realistic failure: the trigger refuses the grant. */
          return send(400, { message: 'You cannot grant more access than you have' });
        }
        JSON.parse(body || '[]').forEach(r => db.perms.push(Object.assign({ id: 'p-' + (++db.seq) }, r)));
        return send(201, null);
      }
      const staffEq = (u.searchParams.get('staff_id') || '').replace('eq.', '');
      return send(200, db.perms.filter(p => !staffEq || p.staff_id === staffEq));
    }
    send(404, { message: 'unhandled ' + table });
  });
});

function api(pathname, { method = 'GET', body, token = CALLER } = {}) {
  return new Promise((resolve, reject) => {
    const headers = {};
    if (token) headers.Authorization = 'Bearer ' + token;
    if (body) headers['Content-Type'] = 'application/json';
    const r = http.request({ host: '127.0.0.1', port: APP, path: pathname, method, headers }, res => {
      let b = '';
      res.on('data', c => { b += c; });
      res.on('end', () => {
        let j = null; try { j = b ? JSON.parse(b) : null; } catch (e) { j = { raw: b }; }
        resolve({ status: res.statusCode, json: j });
      });
    });
    r.on('error', reject);
    if (body) r.write(JSON.stringify(body));
    r.end();
  });
}
function boot(env) {
  const c = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(APP), DATA_SOURCE: 'clickup', SUPABASE_DB_URL: '',
           CLICKUP_API_TOKEN: '', SUPABASE_URL: `http://127.0.0.1:${SB}`,
           SUPABASE_ANON_KEY: ANON, SUPABASE_SERVICE_ROLE: SERVICE, ...env },
    stdio: ['ignore', 'pipe', 'pipe'] });
  c.stdout.on('data', () => {}); c.stderr.on('data', () => {});
  return c;
}
async function waitUp(tries = 80) {
  for (let i = 0; i < tries; i++) {
    try { const r = await api('/api/portal-config'); if (r.status) return; } catch (_) {}
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('server did not start');
}

(async () => {
  reset();
  await new Promise(r => sb.listen(SB, r));
  let child = boot();
  try {
    await waitUp();

    console.log('\nInviting an existing staff member updates that row, never a second one');
    reset();
    let r = await api('/api/access/invite', { method: 'POST', body: {
      email: 'MITCH@x.invalid', full_name: 'Mitch Existing', role: 'user',
      grants: [{ company_id: LW, module: 'properties', level: 'read' }] } });
    check('ok', r.status, 200);
    check('still exactly one Mitch',
      db.staff.filter(s => s.email.toLowerCase() === 'mitch@x.invalid').length, 1);
    check('it is the SAME row, updated', r.json.staff_id, 's-mitch');
    const mitch = db.staff.find(s => s.id === 's-mitch');
    check('access granted and role set', [mitch.dashboard_access, mitch.dashboard_role], [true, 'user']);
    check('linked to the new Auth user by the trigger', !!mitch.user_id, true);
    check('the grant was written', db.perms.length, 1);

    console.log('\nThe redirect is a QUERY parameter, not a body field');
    const invited = db.authUsers.find(a => a.email === 'MITCH@x.invalid'.toLowerCase() || a.email === 'mitch@x.invalid');
    check('redirect_to was sent on the URL', /\/invite$/.test(invited.redirect_to || ''), true);
    check('and the invite call was made with the service role',
      log.some(l => l.startsWith('POST /auth/v1/invite') && l.includes('[service]')), true);

    console.log('\nA brand-new address creates a staff row');
    reset();
    r = await api('/api/access/invite', { method: 'POST', body: {
      email: 'newbie@x.invalid', full_name: 'New Bie', role: 'user', grants: [] } });
    check('ok', r.status, 200);
    check('a staff row now exists', db.staff.filter(s => s.email === 'newbie@x.invalid').length, 1);

    /* ============ THE ONE THAT MATTERS ============ */
    console.log('\nStep 4 fails: the Auth user goes, and no half-configured staff row remains');
    reset();
    failGrantWrite = true;
    r = await api('/api/access/invite', { method: 'POST', body: {
      email: 'mitch@x.invalid', full_name: 'Mitch Existing', role: 'user',
      grants: [{ company_id: LW, module: 'properties', level: 'write' }] } });
    check('the caller is told why', r.json.error, 'You cannot grant more access than you have');
    check('no rollback warning, so it undid cleanly', r.json.rollback, null);
    check('the Auth user is GONE', db.authUsers.filter(a => a.email === 'mitch@x.invalid').length, 0);
    const after = db.staff.find(s => s.id === 's-mitch');
    check('staff.user_id was nulled first, which is what allowed the delete', after.user_id, null);
    check('and the access columns are back as they were',
      [after.dashboard_access, after.dashboard_role], [false, null]);
    check('the staff record itself survives - it is a person, not an invite',
      db.staff.filter(s => s.id === 's-mitch').length, 1);
    check('no grant rows leaked', db.perms.length, 0);

    console.log('\nProof the fake would have caught the WRONG order');
    /* Without this, "the Auth user is GONE" could pass against a rollback that
       deletes first, if the fake happened not to enforce the foreign key. Delete an
       Auth user that a staff row still references, directly, and require the 409 -
       which is what the wrong ordering would run into in production. */
    reset();
    db.authUsers.push({ id: 'au-ref', email: 'ref@x.invalid' });
    db.staff.push({ id: 's-ref', tenant_id: TENANT, email: 'ref@x.invalid', full_name: 'Ref',
                    user_id: 'au-ref', dashboard_access: false, dashboard_role: null });
    const blocked = await new Promise(resolve => {
      const rq = http.request({ host: '127.0.0.1', port: SB, method: 'DELETE',
        path: '/auth/v1/admin/users/au-ref',
        headers: { apikey: SERVICE, 'X-Supabase-Api-Version': '2024-01-01' } }, rr => {
        let b = ''; rr.on('data', c => { b += c; });
        rr.on('end', () => resolve({ status: rr.statusCode, json: JSON.parse(b || '{}') }));
      });
      rq.end();
    });
    check('deleting while a staff row references it is refused', blocked.status, 409);
    check('with the foreign key named, as Postgres would',
      /staff_user_id_fkey/.test(blocked.json.msg || ''), true);
    check('and the Auth user is still there', db.authUsers.filter(a => a.id === 'au-ref').length, 1);

    /* Re-run the failing invite so the ordering assertions below have a fresh log. */
    reset();
    failGrantWrite = true;
    await api('/api/access/invite', { method: 'POST', body: {
      email: 'mitch@x.invalid', full_name: 'Mitch Existing', role: 'user',
      grants: [{ company_id: LW, module: 'properties', level: 'write' }] } });

    console.log('\nThe rollback really is ordered - the null precedes the delete');
    const nullIdx = log.findIndex(l => l.startsWith('PATCH /rest/v1/staff') && l.includes('[service]'));
    const delIdx = log.findIndex(l => l.startsWith('DELETE /auth/v1/admin/users'));
    check('a service-role staff PATCH happened', nullIdx >= 0, true);
    check('before the Auth delete', nullIdx < delIdx, true);
    check('and the rollback used the service role, not the caller',
      log[nullIdx].includes('[service]'), true);

    console.log('\nA brand-new invite that fails leaves nothing behind at all');
    reset();
    failGrantWrite = true;
    r = await api('/api/access/invite', { method: 'POST', body: {
      email: 'ghost@x.invalid', full_name: 'Ghost', role: 'user',
      grants: [{ company_id: LW, module: 'properties', level: 'write' }] } });
    check('refused', r.status, 400);
    check('no Auth user', db.authUsers.filter(a => a.email === 'ghost@x.invalid').length, 0);
    check('no staff row', db.staff.filter(s => s.email === 'ghost@x.invalid').length, 0);

    console.log('\nAuthority comes from the JWT, never the request body');
    reset();
    callerRole = 'user';
    r = await api('/api/access/invite', { method: 'POST', body: {
      email: 'x@x.invalid', role: 'admin', grants: [] } });
    check('a plain user cannot invite', r.status, 403);
    check('and no Auth user was created on the way to finding out', db.authUsers.length, 1);

    reset();
    callerRole = 'admin';
    r = await api('/api/access/invite', { method: 'POST', body: {
      email: 'x@x.invalid', role: 'owner', grants: [] } });
    check('an admin cannot mint an owner', r.status, 403);
    check('again, nothing was created first', db.authUsers.length, 1);

    console.log('\nGrants are validated BEFORE an Auth user exists');
    reset();
    callerRole = 'admin';
    r = await api('/api/access/invite', { method: 'POST', body: {
      email: 'x@x.invalid', role: 'user', grants: [{ company_id: null, module: 'executive', level: 'write' }] } });
    check('Exec for a plain user is refused', r.status, 400);
    check('with the message the trigger would have used',
      r.json.error, 'Executive Board access requires the Admin or Owner role');
    check('and there is no orphan to clean up', db.authUsers.length, 1);

    console.log('\nAlready has access');
    reset();
    r = await api('/api/access/invite', { method: 'POST', body: {
      email: 'owner@x.invalid', role: 'admin', grants: [] } });
    check('409 rather than a duplicate', r.status, 409);

    console.log('\nWithout the service role it fails closed');
    child.kill(); await new Promise(r => setTimeout(r, 350));
    child = boot({ SUPABASE_SERVICE_ROLE: '' });
    await waitUp();
    reset();
    r = await api('/api/access/invite', { method: 'POST', body: {
      email: 'x@x.invalid', role: 'user', grants: [] } });
    check('503', r.status, 503);
    check('naming the variable', r.json.missing, ['SUPABASE_SERVICE_ROLE']);
    check('it did NOT fall back to the anon key', db.authUsers.length, 1);
    const emailAttempt = await api('/api/access/user/s-mitch', { method: 'PATCH', body: { email: 'a@b.invalid' } });
    check('an email change also 503s rather than half-working', emailAttempt.status, 503);
  } catch (e) {
    console.error('\nTEST ERROR:', e.message);
    failures++;
  } finally {
    child.kill();
    sb.close();
  }
  console.log(failures ? `\n${failures} CHECK(S) FAILED` : '\nAll checks passed');
  process.exit(failures ? 1 : 0);
})();
