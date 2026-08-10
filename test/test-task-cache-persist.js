/* ===========================================================================
   test-task-cache-persist.js - the persisted task-cache snapshot.

   The point of persistence is that a deploy or restart must not force the next
   visitor to wait out a cold ClickUp workspace walk. This proves that directly:
   the fake ClickUp NEVER answers, so if /api/tasks serves tasks at all, they can
   only have come from the restored snapshot. No timing assumptions, no sleeps.

   supabase-db is stubbed in-process with an in-memory single-row store, so this
   needs no database. It therefore verifies the server's read/write logic and the
   shape of the queries - NOT that the SQL runs against real Postgres. Applying
   migrations/20260811_task_cache.sql is still needed to confirm that end.
   =========================================================================== */
const http = require('http');

const CLICKUP_PORT = 4321;
const APP_PORT = 4322;

let failures = 0;
function check(name, actual, want) {
  const a = JSON.stringify(actual), w = JSON.stringify(want);
  const ok = a === w;
  if (!ok) failures++;
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name +
    (ok ? '  ' + a : '\n          expected ' + w + '\n          actual   ' + a));
}

/* A ClickUp that accepts connections and then never replies. Any refresh started
   by the server hangs forever, which is the whole point. */
const hungRequests = [];
const clickupServer = http.createServer((req, res) => { hungRequests.push(req.url); /* never respond */ });

/* ---- The snapshot a previous process supposedly left behind ---------------- */
const SNAPSHOT = {
  tasks: [
    { id: 'S1', name: 'Restored task one', status: { status: 'to do' }, canonical_status: 'To Do',
      assignees: [], due_date: null, priority: null, parent: null, url: 'u1',
      list: { id: 'l1', name: 'LOC Draws' }, space: { id: 'sp1', name: 'Asset Management' } },
    { id: 'S2', name: 'Restored task two', status: { status: 'complete' }, canonical_status: 'Completed',
      assignees: [], due_date: null, priority: null, parent: null, url: 'u2',
      list: { id: 'l1', name: 'LOC Draws' }, space: { id: 'sp1', name: 'Asset Management' } },
    { id: 'S3', name: 'Other space', status: { status: 'to do' }, canonical_status: 'To Do',
      assignees: [], due_date: null, priority: null, parent: null, url: 'u3',
      list: { id: 'l9', name: 'Leadli Pipeline' }, space: { id: 'sp2', name: 'Leadli' } },
  ],
  members: [{ id: 7, username: 'Brian Nelson' }],
  spaces: [{ id: 'sp1', name: 'Asset Management' }, { id: 'sp2', name: 'Leadli' }],
  fetched_at: new Date(Date.now() - 40 * 60000).toISOString(),
  team_id: '900',
  mode: 'team',
  count: 3,
};

/* Age it deliberately past the 10-minute TTL: a restored snapshot must be served
   AND be recognised as stale, so a background refresh is still triggered. Marking
   it fresh would hide staleness for ten minutes after every deploy. */
const SNAPSHOT_AGE_MIN = 40;

const store = { row: null, writes: [], selects: 0 };

(async () => {
  await new Promise(r => clickupServer.listen(CLICKUP_PORT, r));

  process.env.PORT = String(APP_PORT);
  process.env.CLICKUP_API_BASE = `http://127.0.0.1:${CLICKUP_PORT}`;
  process.env.CLICKUP_API_TOKEN = 'test-token';
  process.env.CLICKUP_TEAM_ID = '900';
  process.env.CLICKUP_LIST_ID = 'l1';
  process.env.DATA_SOURCE = 'supabase';
  process.env.SUPABASE_DB_URL = 'postgres://stub';

  /* Stub the pool before server.js is required, so it never reaches real pg. */
  const db = require('../supabase-db');
  db.enabled = true;
  db.getPool = () => { throw new Error('the persistence test must not open a real pool'); };
  db.q = async (text, params) => {
    const sql = String(text).trim().toLowerCase();
    if (sql.startsWith('insert into clickup_task_cache')) {
      store.writes.push(JSON.parse(params[0]));
      store.row = { payload: JSON.parse(params[0]), fetched_at: new Date().toISOString() };
      return { rows: [] };
    }
    if (sql.startsWith('select payload, fetched_at from clickup_task_cache')) {
      store.selects++;
      return { rows: store.row ? [store.row] : [] };
    }
    throw new Error('unexpected SQL in the persistence stub: ' + sql.slice(0, 80));
  };

  // Seed the snapshot as though a previous process had written it.
  store.row = {
    payload: SNAPSHOT,
    fetched_at: new Date(Date.now() - SNAPSHOT_AGE_MIN * 60000).toISOString(),
  };

  require('../server.js');

  const get = (p) => new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: APP_PORT, path: p }, r => {
      let b = '';
      r.on('data', c => { b += c; });
      r.on('end', () => {
        try { resolve({ status: r.statusCode, json: JSON.parse(b) }); }
        catch (e) { reject(new Error('bad JSON from ' + p + ': ' + b.slice(0, 200))); }
      });
    }).on('error', reject);
  });

  const finish = (aborted) => {
    clickupServer.close();
    if (aborted) console.log('\nABORTED before the checks completed');
    else if (failures) console.log(`\n${failures} CHECK(S) FAILED`);
    else console.log('\nAll checks passed');
    process.exit(aborted || failures ? 1 : 0);
  };

  try {
    // Wait for the restore, which is the only thing that can warm the cache here.
    let health = null;
    for (let i = 0; i < 80; i++) {
      try {
        const h = await get('/api/health');
        health = h.json;
        if ((health.cache_count || 0) > 0) break;
      } catch (_) { /* not listening yet */ }
      await new Promise(r => setTimeout(r, 100));
    }

    console.log('\nCold start is served from the snapshot, with ClickUp unreachable');
    check('the snapshot was read back', store.selects >= 1, true);
    check('cache warm without a single ClickUp response', health && health.cache_count, 3);
    check('ClickUp was in fact called and left hanging', hungRequests.length > 0, true);

    const res = await get('/api/tasks');
    check('serves the restored tasks', res.json.tasks.map(t => t.id), ['S1', 'S2', 'S3']);
    check('reported as cache', res.json.from_cache, true);
    check('mode carried across the restart', res.json.mode, 'team');

    console.log('\nA restored snapshot is stale, not passed off as fresh');
    const ageMin = Math.round(res.json.cache_age_ms / 60000);
    check('age reflects when it was really fetched, not the restore', ageMin, SNAPSHOT_AGE_MIN);
    check('so a background refresh is triggered', res.json.refreshing, true);

    console.log('\nShaping still applies to a restored payload');
    const scoped = await get('/api/tasks?slim=1&spaces=sp2');
    check('space filter works on restored data', scoped.json.tasks.map(t => t.id), ['S3']);
    check('total_count still the whole snapshot', scoped.json.total_count, 3);

    console.log('\nWrites go back to the store');
    /* Nothing has completed a refresh (ClickUp hangs), so there must be no write
       yet - a snapshot written from an empty/failed refresh would poison the
       next cold start, which is worse than having no snapshot at all. */
    check('no snapshot written from a refresh that never finished', store.writes.length, 0);

    finish(false);
  } catch (e) {
    console.error('\nTEST ERROR:', e.message);
    finish(true);
  }
})();
