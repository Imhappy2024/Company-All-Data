/* ===========================================================================
   test-task-cache.js - patching the cached /api/tasks payload after a write.

   THE BUG THIS GUARDS. Every task write expired the whole cache, so the next
   /api/tasks re-walked the entire ClickUp workspace behind a rate limiter. One status
   change cost minutes of blank screen, and it got worse the more the app was used.
   It also left the property detail and the Property Tasks board disagreeing for that
   whole window: same task, both writing to ClickUp, neither seeing the other.

   Expectations are written from the intended behaviour, not read off the code.
   =========================================================================== */
const { mergeTask, patchTask, dropTask } = require('../task-cache');

let failures = 0;
function check(name, actual, want) {
  const a = JSON.stringify(actual), w = JSON.stringify(want);
  const ok = a === w;
  if (!ok) failures++;
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name +
    (ok ? '  ' + a : '\n          expected ' + w + '\n          actual   ' + a));
}

/* A cached task as the WORKSPACE WALK leaves it: space carries a name, and there are
   fields the single-task response never mentions. */
const walked = () => ({
  id: 't1',
  name: 'Fix the roof',
  status: { status: 'to do', type: 'open', color: '#d3d3d3' },
  space: { id: 'sp1', name: 'Properties' },
  assignees: [{ id: 1, username: 'ada' }],
  list: { id: 'L1', name: 'Roof work' },
});
const payload = () => ({ tasks: [walked(), { id: 't2', name: 'Other' }], count: 2 });

console.log('\nA write updates the task in place, keeping the cache warm');
let p = payload();
check('it reports the patch was applied',
  patchTask(p, 't1', { id: 't1', status: { status: 'complete', type: 'closed' } }), true);
check('the new value is there',
  p.tasks[0].status.status, 'complete');
check('other tasks are untouched', p.tasks[1].name, 'Other');
check('and the count still matches the array', [p.count, p.tasks.length], [2, 2]);

console.log('\nThe walk enriches objects the task response returns thinner');
/* The single-task response gives space as {id}. A flat overwrite would strip the
   name off every task anyone edited, and nothing would look broken until a board
   started grouping by blank. */
p = payload();
patchTask(p, 't1', { id: 't1', space: { id: 'sp1' } });
check('space.name survives a thinner response', p.tasks[0].space, { id: 'sp1', name: 'Properties' });
check('fields the response never mentions survive too',
  [p.tasks[0].list.name, p.tasks[0].name], ['Roof work', 'Fix the roof']);

console.log('\nArrays are replaced, not merged');
/* Unassigning everyone sends []. Merging index-wise would keep the old assignee and
   the task would look assigned to somebody who was just removed. */
p = payload();
patchTask(p, 't1', { id: 't1', assignees: [] });
check('an empty assignee list really empties it', p.tasks[0].assignees, []);
p = payload();
patchTask(p, 't1', { id: 't1', assignees: [{ id: 2, username: 'bo' }] });
check('and a replacement does not keep the previous one',
  p.tasks[0].assignees.map(a => a.username), ['bo']);

console.log('\nAnything it cannot patch with confidence falls back to a refresh');
check('a task the cache has never seen', patchTask(payload(), 'nope', { id: 'nope' }), false);
check('a response with no id', patchTask(payload(), 't1', {}), false);
check('a null response', patchTask(payload(), 't1', null), false);
check('no payload at all', patchTask(null, 't1', { id: 't1' }), false);
check('a payload with no task array', patchTask({ count: 0 }, 't1', { id: 't1' }), false);

console.log('\nDeleting removes the row and keeps the count honest');
p = payload();
check('it reports the removal', dropTask(p, 't1'), true);
check('the task is gone', p.tasks.map(t => t.id), ['t2']);
check('and the count followed it', p.count, 1);
check('deleting something absent asks for a refresh instead',
  dropTask(payload(), 'nope'), false);

console.log('\nmergeTask does not mutate what it was given');
/* patchTask assigns the result back, so a merge that mutated in place would still
   look correct here - and would corrupt the cache the moment anything else held a
   reference to the old object. */
const before = walked();
const snapshot = JSON.stringify(before);
mergeTask(before, { id: 't1', name: 'Changed', space: { id: 'sp9' } });
check('the original object is unchanged', JSON.stringify(before), snapshot);

console.log(failures ? `\n${failures} CHECK(S) FAILED` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
