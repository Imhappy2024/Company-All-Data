/* What /auth/clickup sends ClickUp, and how the return path survives the trip.

   History worth keeping: "Whoops! Unable to authorize your teams" was blamed on
   the `state` parameter, which was removed in ca5d396 and restored here once the
   error persisted without it. state is documented by ClickUp and is not the
   cause - that error comes from the OAuth app or its registered redirect URL,
   which is deployment config, not code. So this file pins the parameter set as
   THREE, and pins redirect_uri behaviour, which is the part that actually breaks
   sign-in when it drifts.

   Boots the real server.js with throwaway OAuth credentials - never talks to
   ClickUp. */
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
    /* The exact parameter set, not a subset - so dropping `state` is caught as
       readily as adding something new. */
    check('with client_id, redirect_uri and state', [...u.searchParams.keys()].sort(), ['client_id', 'redirect_uri', 'state']);
    check('client_id is passed through', u.searchParams.get('client_id'), 'TESTCLIENTID');
    check('redirect_uri is this host\'s callback', u.searchParams.get('redirect_uri'), 'https://portal.example.com/auth/callback');
    /* redirect_uri must match what is registered in the ClickUp app EXACTLY,
       scheme included. It is built from the forwarded headers, so if the proxy
       ever stops sending x-forwarded-proto this silently becomes http:// and
       ClickUp refuses the whole request the same way a stray param does. */
    const plain = await get('/auth/clickup', { host: 'portal.example.com' });
    check('scheme comes from x-forwarded-proto',
      new URL(plain.headers.location).searchParams.get('redirect_uri'), 'http://portal.example.com/auth/callback');

    console.log('\nThe return path travels in state AND a cookie');
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
    /* Same value both ways, so whichever the callback reads it lands identically. */
    check('state carries the same screen', new URL(r2.headers.location).searchParams.get('state'),
      '/?v=brand%3Dleavenwealth%26view%3Dtasks%26sub%3Dptasks');

    console.log('\nsafeReturnPath still refuses an open redirect');
    for (const [bad, why] of [['//evil.com', 'protocol-relative'], ['https://evil.com', 'absolute'],
                              ['/x#auth=fake', 'fragment (would eat the token)'], ['javascript:alert(1)', 'scheme']]) {
      const rr = await get('/auth/clickup?state=' + encodeURIComponent(bad), PROD);
      const c = [].concat(rr.headers['set-cookie'] || []).find(x => x.startsWith('du_return=')) || '';
      check('rejected: ' + why, decodeURIComponent(c.split(';')[0].replace('du_return=', '')), '/');
      /* Sanitised on the way out too, not just in the cookie. */
      check('  and not echoed into state', new URL(rr.headers.location).searchParams.get('state'), '/');
    }
  } finally {
    srv.kill();
  }

  /* redirect_uri must match the ClickUp app character for character. Derived
     from proxy headers it can drift - custom domain vs *.up.railway.app, or a
     proxy that rewrites Host - and ClickUp then refuses the request. Pinning it
     takes the headers out of the loop, and /auth/clickup and /auth/debug must
     agree about the pinned value or debugging the next failure is guesswork. */
  console.log('\nCLICKUP_OAUTH_REDIRECT_URI pins the redirect');
  const PINNED = 'https://portal.leavenwealth.com/auth/callback';
  const srv2 = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: {
      ...process.env, PORT: String(PORT + 1),
      CLICKUP_OAUTH_CLIENT_ID: 'TESTCLIENTID', CLICKUP_OAUTH_CLIENT_SECRET: 'TESTSECRET',
      CLICKUP_OAUTH_REDIRECT_URI: PINNED, DATA_SOURCE: '', SUPABASE_DB_URL: '',
    },
    stdio: 'ignore',
  });
  try {
    const get2 = p => new Promise((res, rej) => {
      /* A host that is deliberately NOT the pinned one: the pin must win. */
      const r = http.get({ host: '127.0.0.1', port: PORT + 1, path: p, headers: { host: 'wrong.example.com', 'x-forwarded-proto': 'https', 'x-forwarded-host': 'wrong.example.com' } },
        s => { let b = ''; s.on('data', d => b += d); s.on('end', () => res({ status: s.statusCode, headers: s.headers, body: b })); });
      r.on('error', rej);
    });
    for (let i = 0; i < 50; i++) { try { await get2('/auth/debug'); break; } catch (e) { await wait(200); } }
    const a = await get2('/auth/clickup');
    check('authorize uses the pin, not the headers', new URL(a.headers.location).searchParams.get('redirect_uri'), PINNED);
    const dbg = JSON.parse((await get2('/auth/debug')).body);
    check('/auth/debug reports the same value', dbg.computed_redirect_uri, PINNED);
    check('and says it is pinned', dbg.oauth_redirect_pinned, true);
    check('client id prefix is shown', dbg.oauth_client_id_prefix, 'TESTCLIENT');
    /* This endpoint is unauthenticated. */
    check('the secret is never printed', JSON.stringify(dbg).includes('TESTSECRET'), false);
  } finally {
    srv2.kill();
  }

  console.log(failures ? `\n${failures} FAILURE(S)` : '\nAll checks passed');
  process.exit(failures ? 1 : 0);
})();
