/* ===========================================================================
   test-routes.js - what the server serves for which path.

   Guards the fix to the old `app.get('*')` catch-all, which sent
   public/index.html for every unmatched path. That made /login, /invite and any
   typo render the ClickUp ops dashboard, and made a missing route
   indistinguishable from a working one.

   The two things that must not regress:
     1. / serves the portal and /ops serves the ops dashboard. The portal iframes
        /ops, so breaking either breaks Properties, Loan Views and Tasks>Overview.
     2. Static assets under public/ still resolve. The ClickUp sign-in return path
        comes from location.pathname of a page that was actually served, so if
        static stopped matching, sign-in would return people to a 404.
   =========================================================================== */
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

const PORT = 4351;

let failures = 0;
function check(name, actual, want) {
  const a = JSON.stringify(actual), w = JSON.stringify(want);
  const ok = a === w;
  if (!ok) failures++;
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name +
    (ok ? '  ' + a : '\n          expected ' + w + '\n          actual   ' + a));
}

function get(p, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path: p, method }, r => {
      let b = '';
      r.on('data', c => { b += c; });
      r.on('end', () => resolve({
        status: r.statusCode,
        type: (r.headers['content-type'] || '').split(';')[0],
        body: b,
      }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function waitUp(tries = 80) {
  for (let i = 0; i < tries; i++) {
    try { const r = await get('/api/health'); if (r.status) return; } catch (_) { /* not up */ }
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('server did not start');
}

(async () => {
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), DATA_SOURCE: 'clickup',
           SUPABASE_DB_URL: '', CLICKUP_API_TOKEN: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', () => {});
  child.stderr.on('data', () => {});

  try {
    await waitUp();

    console.log('\nThe two real surfaces still work');
    const root = await get('/');
    check('/ is 200 html', [root.status, root.type], [200, 'text/html']);
    check('/ is the portal, not the ops dashboard', /portal-tasks\.js/.test(root.body), true);
    const ops = await get('/ops');
    check('/ops is 200 html', [ops.status, ops.type], [200, 'text/html']);
    check('/ops is the ops dashboard', /id="bulkBar"/.test(ops.body), true);

    console.log('\nStatic assets still resolve (the OAuth return depends on this)');
    /* express.static serves .js as application/javascript, not text/javascript. */
    for (const [p, t] of [['/tokens.css', 'text/css'], ['/portal-tasks.js', 'application/javascript'],
                          ['/icons/exec-mark.svg', 'image/svg+xml']]) {
      const r = await get(p);
      check(`${p} is 200 ${t}`, [r.status, r.type], [200, t]);
    }

    console.log('\nUnmatched paths 404 instead of serving the ops dashboard');
    for (const p of ['/nonsense', '/deep/unknown/path', '/dashboard']) {
      const r = await get(p);
      check(`${p} is 404`, r.status, 404);
      check(`${p} is NOT the ops dashboard`, /id="bulkBar"/.test(r.body), false);
    }

    console.log('\nThe pages step 2 and step 5 will add are not silently faked');
    for (const p of ['/login', '/invite']) {
      const r = await get(p);
      /* 404 until those steps land. What matters is that it is not the ops
         dashboard, which is what it used to be. */
      check(`${p} does not render the ops dashboard`, /id="bulkBar"/.test(r.body), false);
      console.log(`        ${p} -> ${r.status} (${r.type || 'no type'})`);
    }

    console.log('\nUnmatched /api stays JSON, so callers do not get a parse error');
    const api = await get('/api/definitely-not-a-route');
    check('is 404', api.status, 404);
    check('is application/json', api.type, 'application/json');
    check('body parses and names the route', (() => {
      try { return /definitely-not-a-route/.test(JSON.parse(api.body).error); } catch (e) { return false; }
    })(), true);
    const apiPost = await get('/api/definitely-not-a-route', 'POST');
    check('non-GET too', [apiPost.status, apiPost.type], [404, 'application/json']);

    console.log('\nThe 404 page is styled, not a bare Express stack');
    const nf = await get('/nonsense');
    check('links back to the dashboard', /href="\/"/.test(nf.body), true);
    check('loads tokens.css rather than hard-coding colours', /tokens\.css/.test(nf.body), true);
    check('no Express default error page', /<pre>|Cannot GET/.test(nf.body), false);
  } catch (e) {
    console.error('\nTEST ERROR:', e.message);
    failures++;
  } finally {
    child.kill();
  }

  console.log(failures ? `\n${failures} CHECK(S) FAILED` : '\nAll checks passed');
  process.exit(failures ? 1 : 0);
})();
