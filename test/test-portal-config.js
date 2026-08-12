/* ===========================================================================
   test-portal-config.js - GET /api/portal-config

   The route hands the Supabase anon key to the browser. Two things must hold:

     1. It fails CLOSED and names the missing variables. Serving `undefined` would
        surface later as an unreadable supabase-js error a long way from the cause.
     2. It never leaks SUPABASE_SERVICE_ROLE. That key bypasses RLS entirely, so
        this is asserted explicitly rather than assumed from reading the handler.

   Runs the real server.js as a child process, twice: once with the variables unset
   and once with them set.
   =========================================================================== */
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

const PORT = 4341;
const FAKE_URL = 'https://example-ref.supabase.co';
const FAKE_ANON = 'anon-key-for-the-test-only';
const FAKE_SERVICE = 'SERVICE-ROLE-MUST-NEVER-APPEAR-IN-A-RESPONSE';

let failures = 0;
function check(name, actual, want) {
  const a = JSON.stringify(actual), w = JSON.stringify(want);
  const ok = a === w;
  if (!ok) failures++;
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name +
    (ok ? '  ' + a : '\n          expected ' + w + '\n          actual   ' + a));
}

function get(p) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: PORT, path: p }, r => {
      let b = '';
      r.on('data', c => { b += c; });
      r.on('end', () => {
        let json = null;
        try { json = JSON.parse(b); } catch (_) { /* leave null */ }
        resolve({ status: r.statusCode, json, raw: b });
      });
    }).on('error', reject);
  });
}

function boot(env) {
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), DATA_SOURCE: 'clickup',
           SUPABASE_DB_URL: '', CLICKUP_API_TOKEN: '', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', () => {});
  child.stderr.on('data', () => {});
  return child;
}

async function waitUp(tries = 80) {
  for (let i = 0; i < tries; i++) {
    try { const r = await get('/api/portal-config'); if (r.status) return; } catch (_) { /* not up */ }
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('server did not start');
}

(async () => {
  /* ---- 1. Unset: must 503 and name both variables ---- */
  let child = boot({ SUPABASE_URL: '', SUPABASE_ANON_KEY: '', SUPABASE_SERVICE_ROLE: FAKE_SERVICE });
  try {
    await waitUp();
    const r = await get('/api/portal-config');
    console.log('\nBoth variables unset');
    check('fails closed with 503', r.status, 503);
    check('names both missing variables', (r.json && r.json.missing) || null,
      ['SUPABASE_URL', 'SUPABASE_ANON_KEY']);
    check('message mentions where to set them', /Railway|\.env/.test((r.json && r.json.error) || ''), true);
    check('serves no url or key', [r.json && r.json.url, r.json && r.json.anonKey], [undefined, undefined]);
    check('does not leak the service role', r.raw.includes(FAKE_SERVICE), false);
  } finally { child.kill(); }
  await new Promise(r => setTimeout(r, 350));

  /* ---- 2. Only one set: must still 503, naming just the missing one ---- */
  child = boot({ SUPABASE_URL: FAKE_URL, SUPABASE_ANON_KEY: '', SUPABASE_SERVICE_ROLE: FAKE_SERVICE });
  try {
    await waitUp();
    const r = await get('/api/portal-config');
    console.log('\nOnly SUPABASE_URL set');
    check('still fails closed', r.status, 503);
    check('names only the one that is missing', (r.json && r.json.missing) || null, ['SUPABASE_ANON_KEY']);
    check('does not serve the half-configuration', r.json && r.json.url, undefined);
  } finally { child.kill(); }
  await new Promise(r => setTimeout(r, 350));

  /* ---- 3. Both set: serves exactly the two public values ---- */
  child = boot({ SUPABASE_URL: FAKE_URL, SUPABASE_ANON_KEY: FAKE_ANON, SUPABASE_SERVICE_ROLE: FAKE_SERVICE });
  try {
    await waitUp();
    const r = await get('/api/portal-config');
    console.log('\nBoth variables set');
    check('200', r.status, 200);
    check('serves the url and anon key', [r.json.url, r.json.anonKey], [FAKE_URL, FAKE_ANON]);
    check('exactly those two keys, nothing else', Object.keys(r.json).sort(), ['anonKey', 'url']);
    check('does not leak the service role', r.raw.includes(FAKE_SERVICE), false);
  } finally { child.kill(); }

  console.log(failures ? `\n${failures} CHECK(S) FAILED` : '\nAll checks passed');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error('\nTEST ERROR:', e.message); process.exit(1); });
