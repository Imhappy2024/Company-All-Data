/* ===========================================================================
   test-home.js - Home (tasks), no network and no browser.

   The case the brief names: a person assigned to tasks in two businesses sees
   each task ONCE. A task is reachable from more than one place - two ClickUp
   workspaces, or the same workspace read twice across pages - and every one of
   those paths must collapse to one row, in My tasks and in All tasks.

   Also pinned: Home only ever uses the person's own ClickUp sign-in. With the
   server's shared CLICKUP_API_TOKEN set and no personal token on the request,
   the answer is 401 "connect", never a borrowed view.

   Expectations are written from the brief, not read off the code.
   =========================================================================== */
'use strict';
const assert = require('assert');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const { _internal: S } = require(path.join(ROOT, 'home-tasks.js'));
const H = require(path.join(ROOT, 'public', 'portal-home.js'))._internal;

let pass = 0; const fails = [];
const check = (n, fn) => { try { fn(); pass++; } catch (e) { fails.push(n + ' -> ' + e.message); } };

const ME = '111';
const OTHER = '222';
const DAY = 864e5;
const NOON = Date.parse('2026-10-11T17:00:00Z');          // noon in Chicago
const raw = (id, name, list, due, who) => ({
  id, name, url: 'https://app.clickup.com/t/' + id, list: { id: 'l-' + list, name: list },
  status: { status: 'to do', type: 'open' }, priority: { priority: 'normal' },
  due_date: due === null ? null : String(due), assignees: who.map(w => ({ id: Number(w), username: w === ME ? 'Jay Delgado' : 'Mitch Hagen' })),
});

/* Two businesses' workspaces. t-shared lives in both (a task linked into a list
   in each), and t-lw-2 is repeated on a second page of the same workspace. */
const LW = [raw('t-lw-1', 'Refi Modern Heights', 'Dashboard', NOON - 3 * DAY, [ME]),
            raw('t-shared', 'Quarterly investor reports', "AM To-Do's", NOON + 2 * DAY, [ME, OTHER])];
const LW_P2 = [raw('t-lw-2', 'Insurance renewal', 'MASTER LIST', NOON, [ME]),
               raw('t-lw-2', 'Insurance renewal', 'MASTER LIST', NOON, [ME])];
const FE = [raw('t-shared', 'Quarterly investor reports', "AM To-Do's", NOON + 2 * DAY, [ME, OTHER]),
            raw('t-fe-1', 'Folio onboarding', 'FolioExcel', NOON + 20 * DAY, [ME]),
            raw('t-fe-2', 'Not mine', 'FolioExcel', null, [OTHER])];

const tasks = S.collect([{ workspace: 'lw', tasks: LW }, { workspace: 'lw', tasks: LW_P2 }, { workspace: 'fe', tasks: FE }]);

console.log('\nOne task, one row');
check('collect keeps each task id once (5 distinct ids)', () => assert.deepStrictEqual(tasks.map(t => t.id).sort(),
  ['t-fe-1', 't-fe-2', 't-lw-1', 't-lw-2', 't-shared']));
const today = H.dayOf(NOON);
const mine = H.groupMine(tasks, ME, today);
const mineIds = mine.groups.flatMap(g => g.tasks.map(t => t.id));
check('My tasks shows each of my tasks once', () => assert.deepStrictEqual(mineIds.slice().sort(), ['t-fe-1', 't-lw-1', 't-lw-2', 't-shared']));
check('and counts 4, not 5 or 6', () => assert.strictEqual(mine.count, 4));
check('the task in both businesses appears once', () => assert.strictEqual(mineIds.filter(x => x === 't-shared').length, 1));
/* groupMine is also safe on its own: hand it duplicates directly */
const dupMine = H.groupMine(tasks.concat(tasks), ME, today);
check('groupMine itself refuses duplicates', () => assert.strictEqual(dupMine.count, 4));
const all = H.groupAll(tasks.concat(tasks));
check('All tasks shows each task once', () => assert.strictEqual(all.count, 5));
check('All tasks is grouped by list', () => assert.deepStrictEqual(all.groups.map(g => g.group).sort(),
  ["AM To-Do's", 'Dashboard', 'FolioExcel', 'MASTER LIST']));

console.log('\nGroups and order');
check('Overdue / Today / This week / Later, in that order', () => assert.deepStrictEqual(mine.groups.map(g => g.group),
  ['Overdue', 'Today', 'This week', 'Later']));
check('overdue counted', () => assert.strictEqual(mine.overdue, 1));
check('earliest due first inside a list', () => {
  const g = H.groupAll([
    { id: 'a', name: 'b', list: 'L', due: NOON + DAY, assignees: [] },
    { id: 'b', name: 'a', list: 'L', due: NOON - DAY, assignees: [] },
    { id: 'c', name: 'c', list: 'L', due: null, assignees: [] }]);
  assert.deepStrictEqual(g.groups[0].tasks.map(t => t.id), ['b', 'a', 'c']);
});
check('the day is Chicago\'s, not the viewer\'s', () =>
  assert.strictEqual(H.dayOf(Date.parse('2026-10-12T03:00:00Z')), '2026-10-11'));

console.log('\nOnly the person\'s own ClickUp sign-in');
check('a request with no personal token has no token', () => {
  process.env.CLICKUP_API_TOKEN = 'shared-server-token';
  assert.strictEqual(S.personToken({ headers: {} }), null);
});
check('the X-ClickUp-Token header is used', () => assert.strictEqual(S.personToken({ headers: { 'x-clickup-token': 'mine' } }), 'mine'));
check('or the du_token cookie', () => assert.strictEqual(S.personToken({ headers: { cookie: 'a=1; du_token=abc%20d' } }), 'abc d'));

(async () => {
  /* readAll walks every page of every workspace and de-duplicates across them. */
  const calls = [];
  const fake = async url => {
    calls.push(url);
    const u = new URL(url);
    const body = u.pathname.endsWith('/user') ? { user: { id: Number(ME), username: 'Jay Delgado' } }
      : u.pathname.endsWith('/team') ? { teams: [{ id: 'lw' }, { id: 'fe' }] }
      : u.pathname.includes('/team/lw/') ? (u.searchParams.get('page') === '0' ? { tasks: LW, last_page: false } : { tasks: LW_P2, last_page: true })
      : { tasks: FE, last_page: true };
    return { ok: true, status: 200, json: async () => body };
  };
  const d = await S.readAll('person-token', fake);
  check('reads both pages of the first workspace and the second workspace', () =>
    assert.strictEqual(calls.filter(c => c.includes('/task?')).length, 3));
  check('and returns each task once', () => assert.strictEqual(d.tasks.length, 5));
  check('me is the signed-in person', () => assert.strictEqual(d.me.id, ME));

  /* the route refuses rather than borrowing the server token */
  const express = require('express');
  const app = express(); app.use('/api/home', require(path.join(ROOT, 'home-tasks.js')).homeRoutes());
  const srv = app.listen(0); const port = srv.address().port;
  const r = await fetch('http://127.0.0.1:' + port + '/api/home/tasks');
  const j = await r.json();
  check('no personal sign-in is a 401 asking to connect, with the shared token set', () =>
    assert.deepStrictEqual([r.status, j.connect], [401, true]));
  srv.close();

  console.log(`\nhome: ${pass} passed, ${fails.length} failed`);
  fails.forEach(f => console.log('  FAIL  ' + f));
  process.exit(fails.length ? 1 : 0);
})();
