/* ===========================================================================
   test-access-api.js - the /api/access/* routes against a fake PostgREST.

   WHY THIS EXISTS. test-users-roles.js fakes /api/access/*, i.e. the server's own
   API, so it never exercises the seam between server.js and PostgREST - which is
   exactly where the ambiguous-embed bug lived. A fake that only implements the
   happy shape cannot catch that class of bug, so this one deliberately REJECTS
   what real PostgREST rejects:

     - an unqualified dashboard_permission(...) embed is ambiguous, because that
       table has two foreign keys to staff (staff_id and granted_by), and answers
       HTTP 300 PGRST201 exactly as the live API does. Verified against the real
       endpoint before writing this.
     - a missing apikey header is 401, so a route that forgot it would fail here.

   It also records every request in order, which is how the "clear Exec BEFORE
   demoting to user" requirement is checked - that one is about sequence, not about
   the final state, so asserting the end result alone would pass either way.
   =========================================================================== */
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

const APP_PORT = 4391;
const PG_PORT = 4392;
const ANON = 'test-anon-key';
const SERVICE = 'SERVICE-ROLE-MUST-NEVER-BE-SENT';
const USER_JWT = 'user-jwt-token';
const LW = 'c0000000-0000-4000-8000-000000000003';

let failures = 0;
function check(name, actual, want) {
  const a = JSON.stringify(actual), w = JSON.stringify(want);
  const ok = a === w;
  if (!ok) failures++;
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name +
    (ok ? '  ' + a : '\n          expected ' + w + '\n          actual   ' + a));
}

/* ---- fake PostgREST ------------------------------------------------------ */
const db = {
  staff: [
    { id: 's-1', full_name: 'Ada Admin', email: 'ada@x.invalid', avatar_url: null,
      is_active: true, dashboard_access: true, dashboard_role: 'admin' },
    { id: 's-2', full_name: 'Ute User', email: 'ute@x.invalid', avatar_url: null,
      is_active: true, dashboard_access: true, dashboard_role: 'user' },
  ],
  perms: [
    { id: 'p-1', staff_id: 's-1', company_id: null, module: 'executive', level: 'write' },
    { id: 'p-2', staff_id: 's-1', company_id: LW, module: '*', level: 'write' },
    { id: 'p-3', staff_id: 's-2', company_id: LW, module: 'properties', level: 'read' },
  ],
};
let log = [];
let failNext = null;
let seenAuthHeaders = [];

const pg = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    const u = new URL(req.url, 'http://x');
    const table = u.pathname.replace(/^\/rest\/v1\//, '');
    const send = (code, obj) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    log.push(`${req.method} ${table}${u.search}`);
    seenAuthHeaders.push({ apikey: req.headers.apikey, auth: req.headers.authorization });

    /* Real PostgREST needs the apikey header; a publishable key is only ever
       accepted there, never as a bearer. */
    if (!req.headers.apikey) return send(401, { message: 'No API key found in request' });

    if (failNext) { const m = failNext; failNext = null; return send(400, { message: m }); }

    const select = u.searchParams.get('select') || '';
    /* THE POINT OF THIS FAKE: refuse an ambiguous embed the way the live API does. */
    if (/(^|,)dashboard_permission\(/.test(select)) {
      return send(300, {
        code: 'PGRST201',
        message: "Could not embed because more than one relationship was found for 'staff' and 'dashboard_permission'",
        details: [
          { relationship: 'dashboard_permission_granted_by_fkey using staff(id) and dashboard_permission(granted_by)' },
          { relationship: 'dashboard_permission_staff_id_fkey using staff(id) and dashboard_permission(staff_id)' },
        ],
      });
    }

    if (table === 'dashboard_module') {
      return send(200, [
        { id: 'm1', company_id: null, module_key: 'executive', nav_id: 'exec', label: 'Executive', sort: 10 },
        { id: 'm2', company_id: LW, module_key: 'properties', nav_id: 'properties', label: 'Properties', sort: 10 },
      ]);
    }

    if (table === 'staff') {
      if (req.method === 'PATCH') {
        const id = (u.searchParams.get('id') || '').replace('eq.', '');
        const patch = JSON.parse(body || '{}');
        const row = db.staff.find(s => s.id === id);
        if (row) Object.assign(row, patch);
        return send(204, null);
      }
      const wantEmbed = /dashboard_permission!/.test(select);
      return send(200, db.staff.filter(s => s.dashboard_access).map(s => {
        const out = { id: s.id, full_name: s.full_name, email: s.email, avatar_url: s.avatar_url,
                      is_active: s.is_active, dashboard_access: s.dashboard_access,
                      dashboard_role: s.dashboard_role };
        if (wantEmbed) {
          out.dashboard_permission = db.perms.filter(p => p.staff_id === s.id)
            .map(p => ({ id: p.id, company_id: p.company_id, module: p.module, level: p.level }));
        }
        return out;
      }));
    }

    if (table === 'dashboard_permission') {
      if (req.method === 'POST') {
        const rows = JSON.parse(body || '[]');
        rows.forEach((r, i) => db.perms.push(Object.assign({ id: 'new-' + (db.perms.length + i) }, r)));
        return send(201, null);
      }
      if (req.method === 'DELETE') {
        const id = (u.searchParams.get('id') || '').replace('eq.', '');
        db.perms = db.perms.filter(p => p.id !== id);
        return send(204, null);
      }
      if (req.method === 'PATCH') {
        const id = (u.searchParams.get('id') || '').replace('eq.', '');
        const patch = JSON.parse(body || '{}');
        const row = db.perms.find(p => p.id === id);
        if (row) Object.assign(row, patch);
        return send(204, null);
      }
      const staffEq = (u.searchParams.get('staff_id') || '').replace('eq.', '');
      let rows = db.perms.filter(p => !staffEq || p.staff_id === staffEq);
      if (u.searchParams.get('company_id') === 'is.null') rows = rows.filter(p => p.company_id === null);
      return send(200, rows.map(p => ({ id: p.id, company_id: p.company_id, module: p.module, level: p.level })));
    }
    send(404, { message: 'unhandled ' + table });
  });
});

function req(pathname, { method = 'GET', token = USER_JWT, body } = {}) {
  return new Promise((resolve, reject) => {
    const headers = {};
    if (token) headers.Authorization = 'Bearer ' + token;
    if (body) headers['Content-Type'] = 'application/json';
    const r = http.request({ host: '127.0.0.1', port: APP_PORT, path: pathname, method, headers }, res => {
      let b = '';
      res.on('data', c => { b += c; });
      res.on('end', () => {
        let json = null;
        try { json = b ? JSON.parse(b) : null; } catch (e) { json = { raw: b }; }
        resolve({ status: res.statusCode, json });
      });
    });
    r.on('error', reject);
    if (body) r.write(JSON.stringify(body));
    r.end();
  });
}

function boot(env) {
  const c = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(APP_PORT), DATA_SOURCE: 'clickup', SUPABASE_DB_URL: '',
           CLICKUP_API_TOKEN: '', SUPABASE_URL: `http://127.0.0.1:${PG_PORT}`,
           SUPABASE_ANON_KEY: ANON, SUPABASE_SERVICE_ROLE: SERVICE, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  c.stdout.on('data', () => {}); c.stderr.on('data', () => {});
  return c;
}
async function waitUp(tries = 80) {
  for (let i = 0; i < tries; i++) {
    try { const r = await req('/api/portal-config'); if (r.status) return; } catch (_) {}
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('server did not start');
}

(async () => {
  await new Promise(r => pg.listen(PG_PORT, r));
  let child = boot();
  try {
    await waitUp();

    console.log('\nThe embed is disambiguated, so PostgREST does not refuse it');
    log = [];
    const users = await req('/api/access/users');
    check('200, not the 300 an ambiguous embed would cause', users.status, 200);
    check('grants actually came back embedded',
      users.json.users.find(u => u.id === 's-2').grants,
      [{ id: 'p-3', company_id: LW, module: 'properties', level: 'read' }]);
    check('the request named the constraint',
      /dashboard_permission!dashboard_permission_staff_id_fkey/.test(log.join(' ')), true);

    console.log('\nAnd the fake really would have caught the old form');
    /* Proof the guard is live rather than decorative. */
    const amb = await new Promise((resolve) => {
      http.get({ host: '127.0.0.1', port: PG_PORT,
                 path: '/rest/v1/staff?select=id,dashboard_permission(module)',
                 headers: { apikey: ANON } }, r => {
        let b = ''; r.on('data', c => { b += c; });
        r.on('end', () => resolve({ status: r.statusCode, json: JSON.parse(b) }));
      });
    });
    check('unqualified embed is refused', amb.status, 300);
    check('with the same code the live API uses', amb.json.code, 'PGRST201');

    console.log('\nScope filtering');
    const scoped = await req('/api/access/users?company=' + LW);
    check('everyone who reaches that business', scoped.json.users.map(u => u.id), ['s-1', 's-2']);
    check('scope reported back', scoped.json.scope, LW);

    console.log('\nThe caller JWT is used, and the service role never is');
    /* Filtered to requests that carried a bearer at all: the ambiguity probe above
       is made directly by this test and deliberately sends only an apikey. */
    check('every bearer sent by the server is the caller token, not the service role',
      seenAuthHeaders.filter(h => h.auth).every(h => h.auth === 'Bearer ' + USER_JWT), true);
    check('and the server did send some', seenAuthHeaders.filter(h => h.auth).length > 0, true);
    check('service role appears in no outbound header',
      seenAuthHeaders.some(h => JSON.stringify(h).includes(SERVICE)), false);
    check('apikey is always sent', seenAuthHeaders.every(h => h.apikey === ANON), true);

    console.log('\nAuth and config are fail-closed');
    check('no bearer -> 401', (await req('/api/access/users', { token: null })).status, 401);
    child.kill(); await new Promise(r => setTimeout(r, 350));
    child = boot({ SUPABASE_URL: '', SUPABASE_ANON_KEY: '' });
    await waitUp();
    check('no Supabase config -> 503', (await req('/api/access/users')).status, 503);
    child.kill(); await new Promise(r => setTimeout(r, 350));
    child = boot(); await waitUp();

    console.log('\nPATCH diffs the grant set: add, change level, remove');
    log = [];
    const r1 = await req('/api/access/user/s-2', { method: 'PATCH', body: {
      full_name: 'Ute Renamed', role: 'user',
      grants: [
        { company_id: LW, module: 'properties', level: 'write' },   // p-3 read -> write
        { company_id: LW, module: 'loans', level: 'read' },         // new
      ],
    } });
    check('ok', r1.status, 200);
    check('level raised in place, not re-created',
      db.perms.find(p => p.id === 'p-3').level, 'write');
    check('the new grant was inserted',
      !!db.perms.find(p => p.staff_id === 's-2' && p.module === 'loans'), true);
    check('name reached staff', db.staff.find(s => s.id === 's-2').full_name, 'Ute Renamed');

    console.log('\nRemoving a grant deletes the row');
    await req('/api/access/user/s-2', { method: 'PATCH', body: { role: 'user', grants: [] } });
    check('no grants left for that person',
      db.perms.filter(p => p.staff_id === 's-2').length, 0);

    console.log('\nExec is cleared BEFORE the demotion, not after');
    /* Sequence, not end state: doing it the other way round trips the staff guard,
       which refuses to demote anyone still holding Exec. */
    log = [];
    await req('/api/access/user/s-1', { method: 'PATCH', body: {
      role: 'user', grants: [{ company_id: LW, module: 'properties', level: 'read' }] } });
    const delIdx = log.findIndex(l => l.startsWith('DELETE dashboard_permission'));
    const patchIdx = log.findIndex(l => l.startsWith('PATCH staff'));
    check('a DELETE of the exec grant happened', delIdx >= 0, true);
    check('and it came before the role PATCH', delIdx < patchIdx, true);
    check('the exec grant is gone',
      db.perms.filter(p => p.staff_id === 's-1' && p.company_id === null).length, 0);

    console.log('\nA database refusal is passed through word for word');
    failNext = 'You cannot grant more access than you have';
    const refused = await req('/api/access/user/s-2', { method: 'PATCH', body: {
      role: 'user', grants: [{ company_id: LW, module: 'properties', level: 'write' }] } });
    check('status is the database status', refused.status, 400);
    check('message intact, not flattened', refused.json.error, 'You cannot grant more access than you have');

    console.log('\nBad input is rejected before it reaches the database');
    check('unknown role', (await req('/api/access/user/s-2', { method: 'PATCH', body: { role: 'wizard' } })).status, 400);
    check('empty name', (await req('/api/access/user/s-2', { method: 'PATCH', body: { full_name: '   ' } })).status, 400);
  } catch (e) {
    console.error('\nTEST ERROR:', e.message);
    failures++;
  } finally {
    child.kill();
    pg.close();
  }

  console.log(failures ? `\n${failures} CHECK(S) FAILED` : '\nAll checks passed');
  process.exit(failures ? 1 : 0);
})();
