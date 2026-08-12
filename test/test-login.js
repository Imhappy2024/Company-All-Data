/* ===========================================================================
   test-login.js - Step 2: /login, remember-device, and the portal gate.

   Runs the real server with a real browser against a FAKE Supabase Auth endpoint,
   so the whole path is exercised: /api/portal-config -> portal-session.js ->
   supabase-js -> the gate in portal.html. Nothing about the code under test is
   stubbed; only Supabase itself is.

   The remember-device rules are the fiddly part and the reason this exists:
     checked   -> localStorage,   survives a browser restart
     unchecked -> sessionStorage, gone when the browser closes
     stamp in the past -> torn down on boot, before anything else
   "Restart the browser" is simulated with a fresh BrowserContext, which is
   precisely what sessionStorage does not survive and localStorage does.

   Expectations are written from the intended behaviour, not read off the code.
   =========================================================================== */
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const ROOT = path.join(__dirname, '..');
const { chromium } = require(path.join(ROOT, 'node_modules', 'playwright'));

const PORT = 4361;
const BASE = `http://localhost:${PORT}`;
const FAKE_URL = `http://127.0.0.1:${PORT + 1}`;
const FAKE_ANON = 'test-anon-key';
const EMAIL = 'owner@example.invalid';
const PASSWORD = 'correct-horse';

let failures = 0;
function check(name, actual, want) {
  const a = JSON.stringify(actual), w = JSON.stringify(want);
  const ok = a === w;
  if (!ok) failures++;
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name +
    (ok ? '  ' + a : '\n          expected ' + w + '\n          actual   ' + a));
}

/* ---- A fake Supabase Auth + RPC endpoint -------------------------------- */
const seen = { reset: [], signin: 0 };
const fake = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    const send = (code, obj) => {
      res.writeHead(code, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': '*',
        'Access-Control-Allow-Methods': '*',
      });
      res.end(JSON.stringify(obj));
    };
    if (req.method === 'OPTIONS') return send(200, {});
    const url = req.url.split('?')[0];

    if (url === '/auth/v1/token') {
      seen.signin++;
      const b = (() => { try { return JSON.parse(body); } catch (e) { return {}; } })();
      if (b.password !== PASSWORD) {
        return send(400, { error: 'invalid_grant', error_description: 'Invalid login credentials' });
      }
      return send(200, {
        access_token: 'fake-access', token_type: 'bearer', expires_in: 3600,
        expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: 'fake-refresh',
        user: { id: 'u-1', email: b.email, aud: 'authenticated', role: 'authenticated' },
      });
    }
    if (url === '/auth/v1/recover') {
      /* Supabase puts redirectTo in the QUERY STRING as redirect_to, not the body,
         so record the full URL - asserting on the body alone finds nothing. */
      seen.reset.push(req.url + ' ' + body);
      return send(200, {});
    }
    if (url === '/auth/v1/logout') return send(204, {});
    if (url === '/auth/v1/user') {
      return send(200, { id: 'u-1', email: EMAIL, aud: 'authenticated', role: 'authenticated' });
    }
    /* dash_my_access(): an owner with one company, so the gate has something real. */
    if (url === '/rest/v1/rpc/dash_my_access') {
      return send(200, {
        user: { id: 's-1', email: EMAIL, full_name: 'Test Owner', avatar_url: null, role: 'owner' },
        companies: { 'c-1': 'LeavenWealth' },
        access: { exec: { exec: 'write' }, 'c-1': { overview: 'write' } },
      });
    }
    return send(404, { error: 'unhandled ' + url });
  });
});

function boot(env) {
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: { ...process.env, PORT: String(PORT), DATA_SOURCE: 'clickup', SUPABASE_DB_URL: '',
           CLICKUP_API_TOKEN: '', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', () => {});
  child.stderr.on('data', () => {});
  return child;
}
function get(p) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: PORT, path: p }, r => {
      let b = ''; r.on('data', c => { b += c; }); r.on('end', () => resolve({ status: r.statusCode, body: b }));
    }).on('error', reject);
  });
}
async function waitUp(tries = 80) {
  for (let i = 0; i < tries; i++) {
    try { const r = await get('/api/portal-config'); if (r.status) return; } catch (_) {}
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('server did not start');
}

(async () => {
  await new Promise(r => fake.listen(PORT + 1, r));
  let child = boot({ SUPABASE_URL: FAKE_URL, SUPABASE_ANON_KEY: FAKE_ANON });
  const browser = await chromium.launch(
    process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});

  const newCtx = async () => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await ctx.newPage();
    page.on('pageerror', e => { errors.push(String(e)); });
    /* "Failed to load resource" lines are HTTP statuses, not JS faults, and are
       expected here: /auth/me 401 (no ClickUp token), /api/* 503 (ClickUp not
       configured), and one deliberate 400 from the wrong-password check. Real
       exceptions still arrive through pageerror above, which stays strict. */
    page.on('console', m => {
      if (m.type() === 'error'
          && !/fonts\.googleapis|favicon|ERR_|404|jsdelivr|Failed to load resource/.test(m.text())) {
        errors.push(m.text());
      }
    });
    return { ctx, page };
  };
  let errors = [];

  try {
    await waitUp();

    /* ---------------------------------------------------------------- gate */
    console.log('\nThe portal is gated: no session goes to /login');
    let { ctx, page } = await newCtx();
    await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
    await page.waitForURL('**/login', { timeout: 8000 });
    check('redirected to /login', new URL(page.url()).pathname, '/login');
    check('the sign-in form is there', await page.locator('#signinForm').count(), 1);
    await ctx.close();

    console.log('\nNo flash of dashboard content on the way there');
    /* Measured at DOMContentLoaded, which is the earliest moment the body exists
       with styles applied, and recorded into sessionStorage because the redirect
       destroys the page that holds it - reading it afterwards on the window would
       always come back null, which is what the first version of this check did. */
    ({ ctx, page } = await newCtx());
    await page.addInitScript(() => {
      document.addEventListener('DOMContentLoaded', function () {
        try {
          if (location.pathname !== '/') return;
          sessionStorage.setItem('__gateProbe', JSON.stringify({
            visibility: getComputedStyle(document.body).visibility,
            gatePresent: !!document.getElementById('authGate'),
            /* The shell's DOM, not its nav: as of the permission gate the nav is
               empty until dash_my_access() lands, so counting nav items here would
               now be counting the gate working rather than the curtain working. */
            appPresent: !!document.querySelector('.app'),
          }));
        } catch (e) { /* ignore */ }
      }, { once: true });
    });
    await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
    await page.waitForURL('**/login', { timeout: 8000 });
    const probe = JSON.parse(await page.evaluate(() => sessionStorage.getItem('__gateProbe')) || 'null');
    check('gate style present at first paint', probe && probe.gatePresent, true);
    check('body hidden while the session is still unknown', probe && probe.visibility, 'hidden');
    /* The shell's DOM really was built behind the curtain, so this proves the
       curtain is what stopped it being seen rather than there being nothing to see. */
    check('and the shell DOM had in fact been built behind it', probe && probe.appPresent, true);
    await ctx.close();

    /* ------------------------------------------------------------- sign in */
    console.log('\nWrong password: an error, and no navigation');
    ({ ctx, page } = await newCtx());
    await page.goto(BASE + '/login', { waitUntil: 'domcontentloaded' });
    await page.fill('#email', EMAIL);
    await page.fill('#password', 'wrong');
    await page.click('#signinBtn');
    await page.waitForSelector('#signinMsg:not([hidden])', { timeout: 8000 });
    check('still on /login', new URL(page.url()).pathname, '/login');
    check('error is shown', /do not match an account/i.test(await page.textContent('#signinMsg')), true);
    check('password field cleared', await page.inputValue('#password'), '');

    console.log('\nCorrect password lands on the dashboard');
    await page.fill('#password', PASSWORD);
    await page.click('#signinBtn');
    await page.waitForURL(BASE + '/', { timeout: 8000 });
    await page.waitForSelector('.nav-item', { timeout: 8000 });
    check('on /', new URL(page.url()).pathname, '/');
    check('shell is visible (gate removed)',
      await page.evaluate(() => getComputedStyle(document.body).visibility), 'visible');
    check('gate style tag is gone', await page.locator('#authGate').count(), 0);
    check('dash_my_access was held', await page.evaluate(() => dashAccess && dashAccess.user.role), 'owner');
    await ctx.close();

    /* --------------------------------------------------- remember: OFF */
    console.log('\nRemember unchecked: gone when the browser closes');
    ({ ctx, page } = await newCtx());
    await page.goto(BASE + '/login', { waitUntil: 'domcontentloaded' });
    await page.fill('#email', EMAIL); await page.fill('#password', PASSWORD);
    await page.click('#signinBtn');
    await page.waitForURL(BASE + '/', { timeout: 8000 });
    const stores = await page.evaluate(() => ({
      remember: localStorage.getItem('lw-remember-until'),
      inLocal: !!localStorage.getItem('lw-session'),
      inSession: !!sessionStorage.getItem('lw-session'),
    }));
    check('no remember stamp written', stores.remember, null);
    check('session in sessionStorage, not localStorage', [stores.inSession, stores.inLocal], [true, false]);
    await ctx.close();
    /* A fresh context is a browser restart: sessionStorage does not survive it. */
    ({ ctx, page } = await newCtx());
    await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
    await page.waitForURL('**/login', { timeout: 8000 });
    check('after "restart" it asks to sign in again', new URL(page.url()).pathname, '/login');
    await ctx.close();

    /* ---------------------------------------------------- remember: ON */
    console.log('\nRemember checked: survives a browser restart');
    ({ ctx, page } = await newCtx());
    await page.goto(BASE + '/login', { waitUntil: 'domcontentloaded' });
    await page.fill('#email', EMAIL); await page.fill('#password', PASSWORD);
    await page.check('#remember');
    await page.click('#signinBtn');
    await page.waitForURL(BASE + '/', { timeout: 8000 });
    const kept = await page.evaluate(() => ({
      remember: Number(localStorage.getItem('lw-remember-until')),
      inLocal: !!localStorage.getItem('lw-session'),
      inSession: !!sessionStorage.getItem('lw-session'),
    }));
    check('stamp written to localStorage', kept.remember > Date.now(), true);
    const days = Math.round((kept.remember - Date.now()) / 86400000);
    check('stamp is 30 days out', days, 30);
    check('session in localStorage, not sessionStorage', [kept.inLocal, kept.inSession], [true, false]);
    const state = await ctx.storageState();
    await ctx.close();

    ({ ctx, page } = await (async () => {
      const c = await browser.newContext({ viewport: { width: 1280, height: 900 }, storageState: state });
      const p = await c.newPage();
      p.on('pageerror', e => errors.push(String(e)));
      return { ctx: c, page: p };
    })());
    await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.nav-item', { timeout: 8000 });
    check('still signed in after "restart"', new URL(page.url()).pathname, '/');

    /* --------------------------------------- remember: stamp in the past */
    console.log('\nA stamp in the past signs you out on the next boot');
    await page.evaluate(() => localStorage.setItem('lw-remember-until', String(Date.now() - 1000)));
    await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
    await page.waitForURL('**/login', { timeout: 8000 });
    check('sent to /login', new URL(page.url()).pathname, '/login');
    const after = await page.evaluate(() => ({
      remember: localStorage.getItem('lw-remember-until'),
      inLocal: !!localStorage.getItem('lw-session'),
      inSession: !!sessionStorage.getItem('lw-session'),
    }));
    check('stamp cleared', after.remember, null);
    check('session purged from both stores', [after.inLocal, after.inSession], [false, false]);
    await ctx.close();

    /* ------------------------------------------------- forgot password */
    console.log('\nForgot password says the same thing either way');
    ({ ctx, page } = await newCtx());
    await page.goto(BASE + '/login', { waitUntil: 'domcontentloaded' });
    await page.click('#toForgot');
    await page.fill('#femail', 'definitely-not-registered@example.invalid');
    await page.click('#forgotBtn');
    await page.waitForSelector('#forgotMsg:not([hidden])', { timeout: 8000 });
    const unknownMsg = await page.textContent('#forgotMsg');
    await page.fill('#femail', EMAIL);
    await page.click('#forgotBtn');
    await page.waitForTimeout(400);
    const knownMsg = await page.textContent('#forgotMsg');
    check('identical wording for unknown and known addresses',
      unknownMsg.replace(/definitely-not-registered@example\.invalid/, 'X') ===
      knownMsg.replace(new RegExp(EMAIL.replace('.', '\\.')), 'X'), true);
    check('it does not reveal whether the account exists', /no account|not found|does not exist/i.test(unknownMsg), false);
    check('the reset actually asked Supabase', seen.reset.length >= 2, true);
    check('and pointed at the set-password page',
      /invite%3Fmode%3Dreset|invite\?mode=reset/.test(seen.reset.join('|')), true);
    await ctx.close();

    /* --------------------------------------------------- config failure */
    console.log('\nMissing config is a named 503, not a broken form');
    child.kill();
    await new Promise(r => setTimeout(r, 400));
    child = boot({ SUPABASE_URL: '', SUPABASE_ANON_KEY: '' });
    await waitUp();
    const cfg = await get('/api/portal-config');
    check('503', cfg.status, 503);
    check('names both variables', JSON.parse(cfg.body).missing, ['SUPABASE_URL', 'SUPABASE_ANON_KEY']);
    ({ ctx, page } = await newCtx());
    await page.goto(BASE + '/login', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#signinMsg:not([hidden])', { timeout: 8000 });
    check('login says it is a deployment problem',
      /not configured on this deployment/i.test(await page.textContent('#signinMsg')), true);
    check('and disables the button rather than failing mysteriously',
      await page.locator('#signinBtn').isDisabled(), true);
    await ctx.close();

    console.log('\nThe service role key is nowhere in public/');
    const fs = require('fs');
    const hits = fs.readdirSync(path.join(ROOT, 'public'))
      .filter(f => /\.(html|js)$/.test(f))
      .filter(f => /SERVICE_ROLE|service_role/.test(fs.readFileSync(path.join(ROOT, 'public', f), 'utf8')));
    check('no file under public/ mentions the service role', hits, []);

    console.log('\nRuntime errors');
    check('no page errors', errors, []);
  } catch (e) {
    console.error('\nTEST ERROR:', e.message);
    failures++;
  } finally {
    await browser.close().catch(() => {});
    child.kill();
    fake.close();
  }

  console.log(failures ? `\n${failures} CHECK(S) FAILED` : '\nAll checks passed');
  process.exit(failures ? 1 : 0);
})();
