// ===========================================================================
// realtime.js - Supabase table events to the browser, over Server-Sent Events.
//
//   POST /api/hooks/supabase   called by a Postgres trigger (pg_net). Shared
//                              secret in the x-lw-webhook-secret header.
//   GET  /api/events           the EventSource stream the portal subscribes to.
//
// The event carries TABLE NAMES ONLY, never row data. Two reasons: the browser
// may not be entitled to the row under RLS, and the portal only needs to know
// which of its caches to drop. Anything more would be a data leak with no
// upside.
//
// Deliberately in-memory. This is a single Railway process and the events are
// hints, not data. A dropped event costs one stale view until the next change
// or the next manual refresh. If this ever runs multi-instance, only the
// instance that receives the webhook would broadcast, so swap the hub for
// Postgres LISTEN/NOTIFY or Redis pub/sub. Do NOT try to make the in-memory
// version work across processes.
// ===========================================================================
'use strict';

const crypto = require('crypto');

const PING_MS = Number(process.env.SSE_PING_MS || 25000);   // Railway kills idle streams
const COALESCE_MS = Number(process.env.SSE_COALESCE_MS || 300);
const MAX_CLIENTS = Number(process.env.SSE_MAX_CLIENTS || 200);
const MAX_PER_IP = Number(process.env.SSE_MAX_PER_IP || 6);

const SERVER_START = new Date().toISOString();

/** @type {Set<{res: import('http').ServerResponse, ip: string, at: number}>} */
const clients = new Set();

/** table name -> Set of operations seen since the last flush */
let pending = new Map();
let flushTimer = null;
let pingTimer = null;
let eventSeq = 0;

/* ---- secret ------------------------------------------------------------ */

/* Hash both sides to a fixed 32 bytes before comparing. timingSafeEqual throws
   on length mismatch, and returning early on length would leak the secret's
   length; hashing removes both problems. */
function sha(v) { return crypto.createHash('sha256').update(String(v)).digest(); }

function checkSecret(provided) {
  const expected = process.env.SUPABASE_WEBHOOK_SECRET;
  if (!expected) return 'unconfigured';   // fail closed, see the route below
  if (typeof provided !== 'string' || !provided) return 'bad';
  return crypto.timingSafeEqual(sha(provided), sha(expected)) ? 'ok' : 'bad';
}

/* ---- fan-out ----------------------------------------------------------- */

function writeTo(client, payload) {
  try {
    client.res.write(payload);
    return true;
  } catch (e) {
    dropClient(client);
    return false;
  }
}

function dropClient(client) {
  clients.delete(client);
  try { client.res.end(); } catch (e) { /* already gone */ }
  if (!clients.size) stopPing();
}

function broadcast(eventName, data) {
  const frame = 'id: ' + (++eventSeq) + '\n' +
                (eventName ? 'event: ' + eventName + '\n' : '') +
                'data: ' + JSON.stringify(data) + '\n\n';
  clients.forEach(function (c) { writeTo(c, frame); });
  return frame;
}

/* A bulk update fires one trigger per statement, and a workflow often touches
   several tables in a row. Buffer briefly and emit one deduplicated message so
   the browser does one refetch, not five. */
function queue(table, op) {
  if (!table) return;
  if (!pending.has(table)) pending.set(table, new Set());
  if (op) pending.get(table).add(op);
  if (flushTimer) return;
  flushTimer = setTimeout(flush, COALESCE_MS);
  if (flushTimer.unref) flushTimer.unref();
}

function flush() {
  flushTimer = null;
  if (!pending.size) return;
  const tables = Array.from(pending.keys()).sort();
  const ops = {};
  pending.forEach(function (set, t) { ops[t] = Array.from(set).sort(); });
  pending = new Map();
  if (!clients.size) return;             // nobody listening; nothing to do
  broadcast(null, { tables: tables, ops: ops, at: new Date().toISOString() });
}

function startPing() {
  if (pingTimer) return;
  pingTimer = setInterval(function () {
    clients.forEach(function (c) { writeTo(c, ': ping\n\n'); });
  }, PING_MS);
  if (pingTimer.unref) pingTimer.unref();
}
function stopPing() {
  if (!pingTimer) return;
  clearInterval(pingTimer);
  pingTimer = null;
}

/* ---- routes ------------------------------------------------------------ */

function mount(app) {
  app.get('/api/events', function (req, res) {
    const ip = req.ip || (req.connection && req.connection.remoteAddress) || 'unknown';

    let perIp = 0;
    clients.forEach(function (c) { if (c.ip === ip) perIp++; });
    if (perIp >= MAX_PER_IP) {
      res.status(429).json({ error: 'too_many_streams', detail: 'Close an existing tab and try again.' });
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',   // stop any reverse proxy buffering the stream
    });
    if (res.flushHeaders) res.flushHeaders();

    const client = { res: res, ip: ip, at: Date.now() };

    /* Oldest out first if we are at the cap. Better a bounded set of live
       streams than an unbounded one that eventually exhausts the process. */
    while (clients.size >= MAX_CLIENTS) {
      const oldest = clients.values().next().value;
      if (!oldest) break;
      dropClient(oldest);
    }
    clients.add(client);
    startPing();

    res.write(': connected\n\n');
    /* serverStart lets the client tell a plain reconnect from a redeploy. */
    writeTo(client, 'event: hello\ndata: ' + JSON.stringify({
      serverStart: SERVER_START, coalesceMs: COALESCE_MS, pingMs: PING_MS,
    }) + '\n\n');

    req.on('close', function () { dropClient(client); });
    req.on('error', function () { dropClient(client); });
  });

  app.post('/api/hooks/supabase', function (req, res) {
    const state = checkSecret(req.get('x-lw-webhook-secret'));

    /* Fail closed. An unset secret must never mean "accept anything" - that is
       exactly the bug the previous version of this file shipped with. */
    if (state === 'unconfigured') {
      return res.status(503).json({
        error: 'webhook_not_configured',
        detail: 'SUPABASE_WEBHOOK_SECRET is not set on this server.',
      });
    }
    if (state !== 'ok') return res.status(401).json({ error: 'bad_secret' });

    const body = req.body || {};
    const table = typeof body.table === 'string' ? body.table.slice(0, 128) : null;
    const op = typeof body.type === 'string' ? body.type.slice(0, 16) : null;
    if (!table) return res.status(400).json({ error: 'missing_table' });

    /* Answer immediately. pg_net has a short timeout and a slow reply here
       would back up the queue behind every write in the database. */
    res.json({ ok: true, listeners: clients.size });
    queue(table, op);
  });

  /* Small health view, handy when a view stops refreshing and you need to know
     whether the problem is Postgres, this process, or the browser. */
  app.get('/api/events/health', function (_req, res) {
    res.json({
      listeners: clients.size,
      serverStart: SERVER_START,
      secretConfigured: !!process.env.SUPABASE_WEBHOOK_SECRET,
      coalesceMs: COALESCE_MS,
      pingMs: PING_MS,
      maxClients: MAX_CLIENTS,
      pendingTables: Array.from(pending.keys()),
    });
  });
}

module.exports = {
  mount: mount,
  /* exported for tests and for anything server-side that wants to nudge the UI */
  _internals: {
    queue: queue,
    flush: flush,
    broadcast: broadcast,
    clients: clients,
    checkSecret: checkSecret,
    reset: function () {
      clients.forEach(dropClient);
      pending = new Map();
      if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
      stopPing();
    },
  },
};
