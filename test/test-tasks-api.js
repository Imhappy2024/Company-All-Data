/* ===========================================================================
   test-tasks-api.js - the /api/tasks fetch strategy and response shaping.

   Runs the REAL server.js as a child process against a fake ClickUp (via the
   CLICKUP_API_BASE override), so the assertions cover the actual route, cache
   and fetch code rather than a reimplementation.

   What it guards, and why each one matters:
     - /ops must keep receiving the full task objects. It reads description,
       text_content, custom_fields, canonical_fields, tags, four date fields,
       archived and orderindex; dropping any of them is a silent blank column,
       not an error.
     - ?slim=1 must return exactly the 11 fields the portal renders and nothing
       heavy. That trim is the point of the change.
     - ?spaces= must scope server-side, so one brand does not download the other
       eleven spaces' tasks.
     - The filtered-team endpoint must be preferred (one paginated walk) and the
       per-list crawl must remain a working fallback. A silent downgrade to the
       crawl looks exactly like "it got slow again", so `mode` is asserted.
     - Space and list NAMES must survive the team path, which returns space ids
       only. Without the enrichment both surfaces render blank columns.
     - The crawl must use a worker pool, not lockstep batches. Asserted by
       interleaving, not by wall-clock - see the slow-list note below.

   Expectations are written from the intent above, not read back off the
   implementation.
   =========================================================================== */
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

/* Three distinct ports, deliberately explicit rather than derived from one
   another: the control server was briefly at CLICKUP_PORT+1, which collided with
   APP_PORT, so /api/health silently returned the control server's JSON. */
const CLICKUP_PORT = 4311;
const CONTROL_PORT = 4312;
const APP_PORT = 4313;
const TEAM_ID = '900';

const CONCURRENCY = 5;      // must match the pool size in server.js crawlListTasks
const FAST_MS = 10;
const SLOW_MS = 260;        // one deliberately slow list, to expose lockstep

let failures = 0;
function check(name, actual, want) {
  const a = JSON.stringify(actual), w = JSON.stringify(want);
  const ok = a === w;
  if (!ok) failures++;
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name +
    (ok ? '  ' + a : '\n          expected ' + w + '\n          actual   ' + a));
}

/* ---------------------------------------------------------------------------
   Fake ClickUp.

   Two spaces so ?spaces= has something to exclude. 20 lists so the list count
   comfortably exceeds the pool size - with only 4 lists a worker pool and
   lockstep batches behave identically and the concurrency check proves nothing.
   250 tasks so the team walk has to paginate (100/page).
   --------------------------------------------------------------------------- */
const SPACES = [
  { id: 'sp1', name: 'Asset Management' },
  { id: 'sp2', name: 'Leadli' },
];
const WINS_LIST_ID = '901403327501';   // matches ARCHIVED_FETCH_LIST_IDS in server.js
const SLOW_LIST_ID = 'l-slow';         // served with SLOW_MS latency

const LISTS = [];
for (let i = 0; i < 20; i++) {
  LISTS.push({ id: 'l' + i, name: 'List ' + i, spaceId: 'sp1', folder: i === 1 ? { id: 'f1', name: 'Ops' } : null });
}
/* sp2 holds exactly one list, and it is the slow one. Combined with sp2's list
   index being served faster than sp1's (see the /space/:id/list handler), this
   list is deterministically FIRST in the discovered order, so it is always picked
   up by one of the first workers. Without that the slow list could land last and
   the worker-pool assertion below would pass or fail on luck. */
LISTS.push({ id: SLOW_LIST_ID, name: 'Leadli Pipeline', spaceId: 'sp2', folder: null });
LISTS.push({ id: WINS_LIST_ID, name: 'Wins', spaceId: 'sp1', folder: null });

const TASK_LISTS = LISTS.filter(l => l.id !== WINS_LIST_ID);
function spaceOf(listId) { return (LISTS.find(l => l.id === listId) || {}).spaceId; }

/* A full-fat ClickUp task: every field /ops reads, plus the bulk ?slim=1 strips. */
function makeTask(n, listId) {
  return {
    id: 'T' + n,
    custom_id: null,
    name: 'Task ' + n,
    text_content: 'plain text body ' + n,
    description: 'A description long enough to matter '.repeat(20),
    status: { status: n % 5 === 0 ? 'complete' : 'to do', type: n % 5 === 0 ? 'closed' : 'open', color: '#87909e' },
    orderindex: String(n),
    date_created: '1750000000000',
    date_updated: '1755000000000',
    date_closed: n % 5 === 0 ? '1755500000000' : null,
    date_done: n % 5 === 0 ? '1755500000000' : null,
    archived: false,
    creator: { id: 1, username: 'Creator' },
    assignees: n % 3 === 0
      ? [{ id: 7, username: 'Brian Nelson', email: 'b@x.com', initials: 'BN', color: '#123', profilePicture: null }]
      : [],
    watchers: [{ id: 9, username: 'Watcher' }],
    checklists: [{ id: 'c1', name: 'Steps', items: [] }],
    tags: [{ name: 'urgent-tag', tag_fg: '#fff', tag_bg: '#000' }],
    parent: null,
    priority: n % 4 === 0 ? { id: '2', priority: 'high', color: '#f50' } : null,
    due_date: n % 2 === 0 ? '1755600000000' : null,
    start_date: null,
    points: null,
    time_estimate: 3600000,
    time_spent: 0,
    custom_fields: [
      { id: 'cf1', name: 'Property', type: 'list_relationship', value: [{ id: 'p1', name: 'TownPark' }] },
      { id: 'cf2', name: 'Category', type: 'drop_down', value: 0, type_config: { options: [{ orderindex: 0, name: 'Other' }] } },
    ],
    dependencies: [], linked_tasks: [], team_id: TEAM_ID,
    url: 'https://app.clickup.com/t/T' + n,
    sharing: { public: false }, permission_level: 'create',
    list: { id: listId, name: null },              // ClickUp gives the id; the name is ours to resolve
    project: { id: 'f1' }, folder: { id: 'f1' },
    space: { id: spaceOf(listId) },                // id only - no name
  };
}

const ALL_TASKS = [];
for (let n = 1; n <= 250; n++) ALL_TASKS.push(makeTask(n, TASK_LISTS[n % TASK_LISTS.length].id));
const ARCHIVED_WIN = { ...makeTask(9001, WINS_LIST_ID), archived: true, name: 'Archived win' };

/* Knobs the tests flip, plus a record of what the server asked for and when. */
const fake = { teamTaskFails: false, requests: [], spans: [] };

const clickupServer = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  const page = url.searchParams.get('page');
  const label = p + (page ? '?page=' + page : '');
  const span = { label, start: Date.now(), end: null };
  fake.requests.push(label);
  fake.spans.push(span);

  const send = (obj, status = 200, delay = FAST_MS) => {
    setTimeout(() => {
      span.end = Date.now();
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(obj));
    }, delay);
  };

  if (p === '/team') {
    return send({ teams: [{ id: TEAM_ID, name: 'LeavenWealth', members: [{ user: { id: 7, username: 'Brian Nelson', email: 'b@x.com' } }] }] });
  }
  if (p === `/team/${TEAM_ID}/space`) return send({ spaces: SPACES });

  const spaceList = p.match(/^\/space\/([^/]+)\/list$/);
  if (spaceList) {
    const sid = spaceList[1];
    /* sp2 answers first so its single (slow) list is discovered before sp1's 20.
       This is what makes the worker-pool assertion deterministic. */
    return send({ lists: LISTS.filter(l => l.spaceId === sid && !l.folder).map(l => ({ id: l.id, name: l.name })) },
      200, sid === 'sp2' ? 1 : 30);
  }
  const spaceFolder = p.match(/^\/space\/([^/]+)\/folder$/);
  if (spaceFolder) {
    const folders = LISTS.filter(l => l.spaceId === spaceFolder[1] && l.folder).map(l => l.folder);
    return send({ folders: [...new Map(folders.map(f => [f.id, f])).values()] });
  }
  const folderList = p.match(/^\/folder\/([^/]+)\/list$/);
  if (folderList) {
    return send({ lists: LISTS.filter(l => l.folder && l.folder.id === folderList[1]).map(l => ({ id: l.id, name: l.name })) });
  }

  // The cheap path: one paginated walk of the workspace.
  if (p === `/team/${TEAM_ID}/task`) {
    if (fake.teamTaskFails) return send({ err: 'boom' }, 500);
    const pg = parseInt(page || '0', 10);
    const slice = ALL_TASKS.slice(pg * 100, pg * 100 + 100);
    return send({ tasks: slice, last_page: pg * 100 + 100 >= ALL_TASKS.length });
  }

  // The fallback path: one paginated fetch per list. Also serves archived.
  const listTask = p.match(/^\/list\/([^/]+)\/task$/);
  if (listTask) {
    const listId = listTask[1];
    if (url.searchParams.get('archived') === 'true') {
      return send({ tasks: listId === WINS_LIST_ID ? [ARCHIVED_WIN] : [], last_page: true });
    }
    const pg = parseInt(page || '0', 10);
    const mine = ALL_TASKS.filter(t => t.list.id === listId);
    const slice = mine.slice(pg * 100, pg * 100 + 100);
    return send({ tasks: slice, last_page: pg * 100 + 100 >= mine.length },
      200, listId === SLOW_LIST_ID ? SLOW_MS : FAST_MS);
  }
  return send({ err: 'unhandled ' + p }, 404);
});

// Test-only control plane, so a test can flip a knob mid-run.
const controlServer = http.createServer((req, res) => {
  if (req.url === '/fail-team') fake.teamTaskFails = true;
  if (req.url === '/heal-team') fake.teamTaskFails = false;
  if (req.url === '/reset') { fake.requests = []; fake.spans = []; }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ requests: fake.requests, spans: fake.spans }));
});

function get(port, p) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: p }, r => {
      let b = '';
      r.on('data', c => { b += c; });
      r.on('end', () => {
        try { resolve({ status: r.statusCode, json: JSON.parse(b), bytes: Buffer.byteLength(b) }); }
        catch (e) { reject(new Error('bad JSON from ' + p + ': ' + b.slice(0, 200))); }
      });
    }).on('error', reject);
  });
}

async function waitForApp(tries = 100) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await get(APP_PORT, '/api/health');
      if (r.status === 200) return r.json;
    } catch (_) { /* not up yet */ }
    await new Promise(r => setTimeout(r, 150));
  }
  throw new Error('app did not start');
}
/* The boot pre-warm is async; wait for it to land rather than sleeping a guess. */
async function waitForCache(tries = 120) {
  let last = null;
  for (let i = 0; i < tries; i++) {
    const h = await get(APP_PORT, '/api/health');
    last = h.json;
    if ((h.json.cache_count || 0) > 0) return h.json;
    await new Promise(r => setTimeout(r, 150));
  }
  throw new Error('cache never warmed; last /api/health = ' + JSON.stringify(last));
}

/* How many DISTINCT list fetches began while the slow one was still open.
   A worker pool keeps pulling new lists the moment a worker frees up, so this
   climbs well past the pool size. Lockstep batches cannot exceed CONCURRENCY-1,
   because nothing outside the current slice of 5 may start until the slice - and
   therefore the slow list in it - has finished. That gap is the assertion. */
function overlapDuringSlowList(spans) {
  const slow = spans.find(s => s.label.startsWith(`/list/${SLOW_LIST_ID}/task`));
  if (!slow || !slow.end) return { found: false, overlap: 0 };
  const overlap = new Set(
    spans.filter(s => s !== slow
      && /^\/list\/.*\/task/.test(s.label)
      && s.start >= slow.start && s.start < slow.end)
      .map(s => s.label)
  );
  return { found: true, overlap: overlap.size };
}

(async () => {
  await new Promise(r => clickupServer.listen(CLICKUP_PORT, r));
  await new Promise(r => controlServer.listen(CONTROL_PORT, r));

  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: {
      ...process.env,
      PORT: String(APP_PORT),
      CLICKUP_API_BASE: `http://127.0.0.1:${CLICKUP_PORT}`,
      CLICKUP_API_TOKEN: 'test-token',
      CLICKUP_TEAM_ID: TEAM_ID,
      CLICKUP_LIST_ID: 'l1',
      DATA_SOURCE: 'clickup',      // Supabase inert: persistence must degrade gracefully
      SUPABASE_DB_URL: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const log = [];
  child.stdout.on('data', d => log.push(String(d)));
  child.stderr.on('data', d => log.push(String(d)));

  /* aborted means the checks never finished, which is a failure even though no
     individual check failed. Printing "All checks passed" there would be a lie. */
  const done = ({ aborted } = {}) => {
    child.kill();
    clickupServer.close(); controlServer.close();
    if (aborted) console.log('\nABORTED before the checks completed');
    else if (failures) console.log(`\n${failures} CHECK(S) FAILED`);
    else console.log('\nAll checks passed');
    process.exit(aborted || failures ? 1 : 0);
  };

  try {
    await waitForApp();
    await waitForCache();

    console.log('\nStrategy: the filtered-team endpoint, not a per-list crawl');
    const seen = (await get(CONTROL_PORT, '/status')).json.requests;
    check('walked the team endpoint, paginated', seen.filter(s => s.startsWith(`/team/${TEAM_ID}/task`)).length, 3);
    check('no per-list task fetch except the archived Wins list',
      seen.filter(s => /^\/list\/.*\/task/.test(s)).length, 1);
    console.log(`        ${seen.length} ClickUp requests total for ${LISTS.length} lists`);
    const full = await get(APP_PORT, '/api/tasks');
    check('mode reports the cheap path', full.json.mode, 'team');
    check('every task present, plus the archived win', full.json.count, 251);

    console.log('\nNames survive the team path (it returns space ids only)');
    const t1 = full.json.tasks.find(t => t.id === 'T1');
    check('space name resolved', t1.space, { id: spaceOf(t1.list.id), name: SPACES.find(s => s.id === spaceOf(t1.list.id)).name });
    check('list name resolved', t1.list.name, LISTS.find(l => l.id === t1.list.id).name);
    check('no task left with a nameless space',
      full.json.tasks.filter(t => !t.space || !t.space.name).length, 0);
    check('no task left with a nameless list',
      full.json.tasks.filter(t => !t.list || !t.list.name).length, 0);

    console.log('\n/ops keeps the full task objects');
    for (const f of ['description', 'text_content', 'custom_fields', 'canonical_fields',
                     'tags', 'date_created', 'date_updated', 'archived', 'orderindex']) {
      check(`full payload keeps ${f}`, Object.prototype.hasOwnProperty.call(t1, f), true);
    }
    check('unscoped count matches total_count', full.json.count, full.json.total_count);
    check('not flagged slim or scoped', [full.json.slim, full.json.scoped], [false, false]);

    console.log('\n?slim=1 returns exactly the 11 fields the portal renders');
    const slim = await get(APP_PORT, '/api/tasks?slim=1');
    check('field set', Object.keys(slim.json.tasks[0]).sort(),
      ['assignees', 'canonical_status', 'due_date', 'id', 'list', 'name', 'parent',
       'priority', 'space', 'status', 'url']);
    check('no description', 'description' in slim.json.tasks[0], false);
    check('no custom_fields', 'custom_fields' in slim.json.tasks[0], false);
    check('same task count as full', slim.json.count, full.json.count);
    check('canonical_status still resolved', slim.json.tasks.find(t => t.id === 'T5').canonical_status, 'Completed');
    check('assignee trimmed to what the avatars need',
      Object.keys(slim.json.tasks.find(t => t.assignees.length).assignees[0]).sort(),
      ['email', 'id', 'initials', 'username']);
    const shrink = full.bytes / slim.bytes;
    console.log(`        payload ${(full.bytes / 1024).toFixed(0)}KB -> ${(slim.bytes / 1024).toFixed(0)}KB (${shrink.toFixed(1)}x smaller)`);
    check('materially smaller, not marginally', shrink > 5, true);

    console.log('\n?spaces= scopes server-side');
    const sp2 = await get(APP_PORT, '/api/tasks?slim=1&spaces=sp2');
    check('only the requested space came back', [...new Set(sp2.json.tasks.map(t => t.space.id))], ['sp2']);
    check('fewer tasks than the whole workspace', sp2.json.count < full.json.count, true);
    check('total_count still reports the whole workspace', sp2.json.total_count, 251);
    check('flagged scoped', sp2.json.scoped, true);
    console.log(`        scoped response ${(sp2.bytes / 1024).toFixed(0)}KB vs ${(full.bytes / 1024).toFixed(0)}KB full`);
    const both = await get(APP_PORT, '/api/tasks?slim=1&spaces=sp1,sp2');
    check('multiple spaces union to everything', both.json.count, full.json.count);
    const unknown = await get(APP_PORT, '/api/tasks?slim=1&spaces=nope');
    check('an unknown space is empty, not everything', unknown.json.count, 0);

    console.log('\nFallback: the per-list crawl still works when the team walk fails');
    await get(CONTROL_PORT, '/reset');
    await get(CONTROL_PORT, '/fail-team');
    const crawled = await get(APP_PORT, '/api/tasks?force=1');
    check('mode reports the fallback', crawled.json.mode, 'crawl');
    check('no tasks lost by falling back', crawled.json.count, 251);
    const after = (await get(CONTROL_PORT, '/status')).json;
    check('it did fetch per list',
      after.requests.filter(s => /^\/list\/.*\/task/.test(s)).length >= TASK_LISTS.length, true);
    check('fallback resolves names too',
      crawled.json.tasks.filter(t => !t.space || !t.space.name).length, 0);

    console.log('\nThe crawl uses a worker pool, not lockstep batches');
    const ov = overlapDuringSlowList(after.spans);
    check('the slow list was observed', ov.found, true);
    console.log(`        ${ov.overlap} other list fetches started while the slow one was open`);
    check(`more than ${CONCURRENCY - 1} lists overlapped the slow one`, ov.overlap > CONCURRENCY - 1, true);

    console.log('\nPersistence degrades gracefully with Supabase off');
    await get(CONTROL_PORT, '/heal-team');
    const health = await get(APP_PORT, '/api/health');
    check('server still healthy', health.json.status, 'ok');
    check('no unhandled rejection or crash in the log',
      /UnhandledPromiseRejection|TypeError|ReferenceError/.test(log.join('')), false);

    done();
  } catch (e) {
    console.error('\nTEST ERROR:', e.message);
    console.error(log.join('').slice(-2500));
    done({ aborted: true });
  }
})();
