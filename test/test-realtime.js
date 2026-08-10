/* Exercises realtime.js over real HTTP: an Express app, a real SSE client, real
   POSTs. Checks the security behaviour first, because that is the part that was
   wrong last time. */
'use strict';
const http = require('http');
const express = require('express');

let failures = 0;
function check(name, actual, want) {
  const a = JSON.stringify(actual), w = JSON.stringify(want);
  const ok = a === w;
  if (!ok) failures++;
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (ok ? '  ' + a : '\n          expected ' + w + '\n          actual   ' + a));
}

function post(port, body, secret) {
  return new Promise((resolve) => {
    const data = JSON.stringify(body);
    const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) };
    if (secret !== undefined) headers['x-lw-webhook-secret'] = secret;
    const req = http.request({ port, path: '/api/hooks/supabase', method: 'POST', headers }, (res) => {
      let b = ''; res.on('data', c => b += c);
      res.on('end', () => resolve({ status: res.statusCode, body: b ? JSON.parse(b) : null }));
    });
    req.end(data);
  });
}

/* Minimal SSE client: collects frames and exposes them as parsed events. */
function sse(port) {
  return new Promise((resolve) => {
    const req = http.get({ port, path: '/api/events', headers: { Accept: 'text/event-stream' } }, (res) => {
      const client = { status: res.statusCode, raw: '', events: [], comments: 0, res,
        close: () => { req.destroy(); } };
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        client.raw += chunk;
        let idx;
        while ((idx = client.raw.indexOf('\n\n')) !== -1) {
          const frame = client.raw.slice(0, idx);
          client.raw = client.raw.slice(idx + 2);
          if (frame.startsWith(':')) { client.comments++; continue; }
          const ev = { name: null, data: null };
          frame.split('\n').forEach((line) => {
            if (line.startsWith('event: ')) ev.name = line.slice(7);
            if (line.startsWith('data: ')) { try { ev.data = JSON.parse(line.slice(6)); } catch (e) { ev.data = line.slice(6); } }
          });
          client.events.push(ev);
        }
      });
      resolve(client);
    });
  });
}

const wait = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  /* Short intervals so the test does not take half a minute. */
  process.env.SSE_PING_MS = '250';
  process.env.SSE_COALESCE_MS = '150';
  process.env.SSE_MAX_PER_IP = '3';
  delete process.env.SUPABASE_WEBHOOK_SECRET;

  const realtime = require('../realtime');
  const app = express();
  app.use(express.json());
  realtime.mount(app);
  const server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  const port = server.address().port;

  console.log('\nSecret handling');
  let r = await post(port, { type: 'UPDATE', table: 'loan' });
  check('503 when SUPABASE_WEBHOOK_SECRET is unset (fails closed)', r.status, 503);

  process.env.SUPABASE_WEBHOOK_SECRET = 'correct-horse-battery-staple';
  r = await post(port, { type: 'UPDATE', table: 'loan' });
  check('401 with no header', r.status, 401);
  r = await post(port, { type: 'UPDATE', table: 'loan' }, 'wrong');
  check('401 with a wrong secret', r.status, 401);
  r = await post(port, { type: 'UPDATE', table: 'loan' }, 'correct-horse-battery-stapl');
  check('401 with a near-miss secret (length differs)', r.status, 401);
  r = await post(port, { type: 'UPDATE', table: 'loan' }, 'correct-horse-battery-staple');
  check('200 with the right secret', r.status, 200);
  r = await post(port, { type: 'UPDATE' }, 'correct-horse-battery-staple');
  check('400 when the table is missing', r.status, 400);

  console.log('\nStream');
  const a = await sse(port);
  await wait(80);
  check('stream opens 200', a.status, 200);
  check('first event is hello', a.events[0] && a.events[0].name, 'hello');
  check('hello carries serverStart', typeof (a.events[0] && a.events[0].data.serverStart), 'string');

  console.log('\nDelivery and coalescing');
  a.events.length = 0;
  await post(port, { type: 'UPDATE', table: 'loan' }, 'correct-horse-battery-staple');
  await wait(300);
  check('one event delivered', a.events.length, 1);
  check('carries the table name', a.events[0].data.tables, ['loan']);
  check('carries no row data', Object.keys(a.events[0].data).sort(), ['at', 'ops', 'tables']);

  a.events.length = 0;
  for (let i = 0; i < 40; i++) await post(port, { type: 'UPDATE', table: 'loan' }, 'correct-horse-battery-staple');
  await post(port, { type: 'INSERT', table: 'loan_balance' }, 'correct-horse-battery-staple');
  await wait(400);
  check('41 hooks across 2 tables collapse to one event', a.events.length, 1);
  check('deduplicated table list', a.events[0].data.tables, ['loan', 'loan_balance']);

  console.log('\nKeepalive');
  const before = a.comments;
  await wait(600);
  check('sends periodic ping comments', a.comments > before, true);

  console.log('\nFan-out and caps');
  const b = await sse(port);
  await wait(60);
  b.events.length = 0; a.events.length = 0;
  await post(port, { type: 'DELETE', table: 'property' }, 'correct-horse-battery-staple');
  await wait(300);
  check('both listeners receive it', [a.events.length, b.events.length], [1, 1]);

  const c = await sse(port);
  await wait(50);
  const d = await sse(port);
  await wait(50);
  check('per-IP cap returns 429 on the 4th stream', d.status, 429);
  c.close();

  console.log('\nHealth');
  const health = await new Promise((resolve) => {
    http.get({ port, path: '/api/events/health' }, (res) => {
      let s = ''; res.on('data', x => s += x); res.on('end', () => resolve(JSON.parse(s)));
    });
  });
  check('health reports the secret is configured', health.secretConfigured, true);
  check('health reports live listeners', health.listeners >= 2, true);

  a.close(); b.close();
  realtime._internals.reset();
  server.close();
  console.log('\n' + (failures ? failures + ' FAILURE(S)' : 'All checks passed'));
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
