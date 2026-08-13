/* ===========================================================================
   task-cache.js - keeping the cached /api/tasks payload correct after a write.

   WHY THIS EXISTS. Every task write used to expire the whole tasks cache. The next
   /api/tasks re-walked the entire ClickUp workspace - 21 spaces, 211 lists, ~4800
   tasks - and ClickUp rate-limits that walk, retrying at 60s. So one status change
   bought minutes of empty screen, and the app got slower the more it was used.

   It also kept the two task screens out of step for exactly that long: the property
   detail and the Property Tasks board show the same task and both write to ClickUp,
   but neither could see the other's change until the walk finished.

   ClickUp's PUT returns the updated task, so the right value is already in hand.

   Pure and payload-in/payload-out so it can be tested without a network or a server:
   the merge rule below is the part that is easy to get subtly wrong.
   =========================================================================== */
'use strict';

/* One level deep, deliberately.

   The workspace walk enriches objects that the single-task response returns in a
   thinner form - `space` comes back as {id} where the cache holds {id, name}. A flat
   overwrite would quietly strip the name off every task anyone edited, and nothing
   would look broken until someone noticed a board grouping by blank. */
function mergeTask(cached, updated) {
  const out = Object.assign({}, cached);
  Object.keys(updated || {}).forEach(k => {
    const a = cached ? cached[k] : undefined;
    const b = updated[k];
    const bothPlainObjects =
      b && a && typeof b === 'object' && typeof a === 'object' &&
      !Array.isArray(b) && !Array.isArray(a);
    out[k] = bothPlainObjects ? Object.assign({}, a, b) : b;
  });
  return out;
}

/* Returns true when the cache now reflects the write, false when the caller should
   fall back to a full refresh. A slow read beats a confidently wrong one. */
function patchTask(payload, taskId, updated) {
  if (!payload || !Array.isArray(payload.tasks)) return false;
  if (!updated || !updated.id) return false;
  const i = payload.tasks.findIndex(t => t && t.id === taskId);
  if (i < 0) return false;                 /* never seen it - refresh instead */
  payload.tasks[i] = mergeTask(payload.tasks[i], updated);
  payload.count = payload.tasks.length;
  return true;
}

function dropTask(payload, taskId) {
  if (!payload || !Array.isArray(payload.tasks)) return false;
  const before = payload.tasks.length;
  payload.tasks = payload.tasks.filter(t => !t || t.id !== taskId);
  if (payload.tasks.length === before) return false;   /* nothing removed */
  payload.count = payload.tasks.length;
  return true;
}

module.exports = { mergeTask, patchTask, dropTask };
