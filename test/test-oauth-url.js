/* The ClickUp authorize URL must carry exactly two parameters.

   ClickUp's authorize page is the legacy `app.clickup.com/api` endpoint. Handed
   anything beyond client_id and redirect_uri it refuses the whole request with
   "Whoops! Unable to authorize your teams", before the user ever sees the
   consent step. The previous dashboard (imhappy2024/click-up-dashboard) sends
   two params and works; this one added `&state=` to carry the return path and
   sign-in broke. The return path now rides in a short-lived cookie instead.

   This test exists so nobody re-adds a query parameter to that URL. It boots the
   real server.js with throwaway OAuth credentials - it never talks to ClickUp. */
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');

const PORT = 4175;
let failures = 0;
function check(name, actual, want) {
  const a = JSON.stringify(actual), w = JSON.stringify(want);
  const ok = a === w;
  if (!ok) failures++;
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (ok ? '  ' + a : '\n          expected ' + w + '\n          actual   ' + a));
}

function get(pathname, headers) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: pathname, headers: headers || {} },
      res => { res.resume(); resolve({ status: res.statusCode, headers: res.headers }); });
    req.on('error', reject);
  });
}
const wait = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: {
      ...process.env,
      PORT: String(PORT),
      CLICKUP_OAUTH_CLIENT_ID: 'TESTCLIENTID',
      CLICKUP_OAUTH_CLIENT_SECRET: 'TESTSECRET',
      DATA_SOURCE: '',
      SUPABASE_DB_URL: '',
    },
    stdio: 'ignore',
  });

  try {
    for (let i = 0; i < 50; i++) {
      try { await get('/auth/debug'); break; } catch (e) { await wait(200); }
    }

    console.log('\nThe ClickUp authorize URL');
    /* Railway terminates TLS at the edge and forwards these, so this is what a
       production request looks like. */
    const PROD = { host: 'portal.example.com', 'x-forwarded-proto': 'https', 'x-forwarded-host': 'portal.example.com' };
    const r = await get('/auth/clickup', PROD);
    check('redirects', r.status, 302);
    const u = new URL(r.headers.location);
    check('to ClickUp\'s authorize page', u.origin + u.pathname, 'https://app.clickup.com/api');
    /* The assertion that matters: the exact parameter set, not a subset. A
       `state` here is what broke sign-in. */
    check('with exactly client_id and redirect_uri', [...u.searchParams.keys()].sort(), ['client_id', 'redirect_uri']);
    check('no state parameter', u.searchParams.has('state'), false);
    check('client_id is passed through', u.searchParams.get('client_id'), 'TESTCLIENTID');
    check('redirect_uri is this host\'s callback', u.searchParams.get('redirect_uri'), 'https://portal.example.com/auth/callback');
    /* redirect_uri must match what is registered in the ClickUp app EXACTLY,
       scheme included. It is built from the forwarded headers, so if the proxy
       ever stops sending x-forwarded-proto this silently becomes http:// and
       ClickUp refuses the whole request the same way a stray param does. */
    const plain = await get('/auth/clickup', { host: 'portal.example.com' });
    check('scheme comes from x-forwarded-proto',
      new URL(plain.headers.location).searchParams.get('redirect_uri'), 'http://portal.example.com/auth/callback');

    console.log('\nThe return path rides in a cookie instead');
    const r2 = await get('/auth/clickup?state=' + encodeURIComponent('/?v=brand%3Dleavenwealth%26view%3Dtasks%26sub%3Dptasks'), PROD);
    const setCookie = [].concat(r2.headers['set-cookie'] || []);
    const ret = setCookie.find(c => c.startsWith('du_return='));
    check('du_return is set', !!ret, true);
    check('it holds the screen', decodeURIComponent((ret || '').split(';')[0].replace('du_return=', '')),
      '/?v=brand%3Dleavenwealth%26view%3Dtasks%26sub%3Dptasks');
    check('HttpOnly', /HttpOnly/.test(ret || ''), true);
    /* Short-lived: it is only needed for the hop to ClickUp and back, and it is
       not a credential worth keeping around. */
    check('expires in minutes, not a year', /Max-Age=600\b/.test(ret || ''), true);
    check('still no state in the URL', new URL(r2.headers.location).searchParams.has('state'), false);

    console.log('\nsafeReturnPath still refuses an open redirect');
    for (const [bad, why] of [['//evil.com', 'protocol-relative'], ['https://evil.com', 'absolute'],
                              ['/x#auth=fake', 'fragment (would eat the token)'], ['javascript:alert(1)', 'scheme']]) {
      const rr = await get('/auth/clickup?state=' + encodeURIComponent(bad), PROD);
      const c = [].concat(rr.headers['set-cookie'] || []).find(x => x.startsWith('du_return=')) || '';
      check('rejected: ' + why, decodeURIComponent(c.split(';')[0].replace('du_return=', '')), '/');
    }
  } finally {
    srv.kill();
  }

  console.log(failures ? `\n${failures} FAILURE(S)` : '\nAll checks passed');
  process.exit(failures ? 1 : 0);
})();
