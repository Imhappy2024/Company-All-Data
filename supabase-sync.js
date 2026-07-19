// ===========================================================================
// supabase-sync.js — two-way ClickUp <-> Supabase sync for the Property Tasks list.
//
// FULLY GATED: only active when DATA_SOURCE=supabase AND SUPABASE_DB_URL is set.
// When disabled, `enabled` is false and the server keeps reading/writing ClickUp
// directly exactly as before. `pg` is required lazily so the dependency is only
// touched when the feature is turned on.
//
// All ClickUp access + constants are injected via init() to avoid a circular
// dependency with server.js.
// ===========================================================================

const db = require('./supabase-db');
const enabled = db.enabled;

let deps = null; // injected by init()
function init(d) { deps = d; }
function q(text, params) { return db.q(text, params); }
function serviceToken() { return deps.serviceToken; }

// ---------------------------------------------------------------------------
// ClickUp field-def cache (Category options + the Property/Category field ids)
// ---------------------------------------------------------------------------
let _fieldDefs = null, _fieldDefsAt = 0;
async function fieldDefs() {
  if (_fieldDefs && Date.now() - _fieldDefsAt < 6 * 3600 * 1000) return _fieldDefs;
  const data = await deps.clickup(`/list/${deps.PROPERTY_TASKS_LIST_ID}/field`);
  _fieldDefs = data.fields || [];
  _fieldDefsAt = Date.now();
  return _fieldDefs;
}
async function categoryOptions() {
  const defs = await fieldDefs();
  const f = defs.find(x => x.id === deps.CATEGORY_FIELD_ID);
  return (f?.type_config?.options || []).map(o => ({ id: o.id, name: o.name, orderindex: o.orderindex }));
}
async function categoryOptionId(name) {
  if (!name) return null;
  const o = (await categoryOptions()).find(o => String(o.name).toLowerCase() === String(name).toLowerCase());
  return o ? o.id : null;
}
async function categoryNameForOption(optId) {
  if (optId == null || optId === '') return null;
  const o = (await categoryOptions()).find(o => String(o.id) === String(optId) || o.orderindex === optId);
  return o ? o.name : null;
}

// ---------------------------------------------------------------------------
// ClickUp task field decoding
// ---------------------------------------------------------------------------
function cuField(task, fieldId) { return (task.custom_fields || []).find(x => x.id === fieldId); }
// The Property relationship's first target as { id, name }. The name lets us link a
// task to its Supabase property/unit even when clickup_task_id hasn't been backfilled.
function cuPropertyTarget(task) {
  const f = cuField(task, deps.PROPERTY_FIELD_ID);
  if (f && Array.isArray(f.value) && f.value.length) {
    const v = f.value[0];
    if (v && typeof v === 'object') return { id: v.id != null ? String(v.id) : null, name: v.name || v.title || null };
    return { id: String(v), name: null };
  }
  return { id: null, name: null };
}
function cuCategoryName(task) {
  const f = cuField(task, deps.CATEGORY_FIELD_ID);
  if (!f || f.value == null || f.value === '') return null;
  const opts = f.type_config?.options || [];
  const o = opts.find(o => o.id === f.value || o.orderindex === f.value);
  return o ? o.name : null;
}
const msToISO = (ms) => (ms ? new Date(Number(ms)).toISOString() : null);
function cuToRow(task) {
  return {
    name: task.name || '',
    description: task.text_content || task.description || null,
    status: task.status?.status || null,
    priority: task.priority?.priority || null,
    assignees: JSON.stringify((task.assignees || []).map(a => asg(a))),   // {id,name,initials}
    start_date: msToISO(task.start_date),
    due_date: msToISO(task.due_date),
    date_closed: msToISO(task.date_closed),
    category: cuCategoryName(task),
  };
}
function parseAssignees(v) {
  if (!v) return [];
  if (Array.isArray(v)) return v;
  try { return JSON.parse(v) || []; } catch { return []; }
}
// Initials from a display name / email (never an id).
function initialsOf(name) {
  let s = String(name || '').trim();
  if (!s) return '?';
  if (s.includes('@')) s = s.split('@')[0];
  const parts = s.split(/[\s._-]+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  return (parts[0] || s).slice(0, 2).toUpperCase();
}
// Normalize an assignee to { id, name, initials } using username/email (never bare id
// as the name). `raw` may be an id, or an object with id/name/username/email.
function asg(raw) {
  const o = (raw && typeof raw === 'object') ? raw : { id: raw };
  const name = o.name || o.username || o.email || null;
  return { id: o.id, name, initials: initialsOf(name) };
}

// ---------------------------------------------------------------------------
// Link resolution: ClickUp record id <-> Supabase property_id / unit_id
// (relies on property.clickup_task_id / unit.clickup_task_id backfilled by the
//  migration script — see leavenwealth_migration.py --relink).
// ---------------------------------------------------------------------------
const linkNorm = s => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
// Accepts either a ClickUp target id (string) or a { id, name } object. Resolves to a
// Supabase property/unit by clickup_task_id first, then falls back to an UNAMBIGUOUS
// name match (so tasks link even before --relink backfills clickup_task_id).
async function resolveLink(target) {
  const id = (target && typeof target === 'object') ? target.id : target;
  const name = (target && typeof target === 'object') ? target.name : null;
  if (id) {
    let r = await q('select id from public.property where clickup_task_id = $1 limit 1', [String(id)]);
    if (r.rows.length) return { property_id: r.rows[0].id, unit_id: null };
    r = await q('select id from public.unit where clickup_task_id = $1 limit 1', [String(id)]);
    if (r.rows.length) return { property_id: null, unit_id: r.rows[0].id };
  }
  if (name) {
    const n = linkNorm(name);
    let r = await q('select id from public.property where lower(btrim(dba_name)) = $1', [n]);
    if (r.rows.length === 1) return { property_id: r.rows[0].id, unit_id: null };
    r = await q('select id from public.unit where lower(btrim(unit_identifier)) = $1', [n]);
    if (r.rows.length === 1) return { property_id: null, unit_id: r.rows[0].id };
  }
  return { property_id: null, unit_id: null };
}
async function clickupTargetForRow(row) {
  if (row.property_id) {
    const r = await q('select clickup_task_id from public.property where id = $1', [row.property_id]);
    return r.rows[0]?.clickup_task_id || null;
  }
  if (row.unit_id) {
    const r = await q('select clickup_task_id from public.unit where id = $1', [row.unit_id]);
    return r.rows[0]?.clickup_task_id || null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Push helpers (Supabase row -> ClickUp). `tok` defaults to the service token;
// dashboard-originated creates pass the logged-in user's token.
// ---------------------------------------------------------------------------
async function pushCreate(row, tok = serviceToken(), explicitTargetId = null) {
  const body = { name: row.name || 'Untitled task' };
  if (row.description) body.description = row.description;
  if (row.status) body.status = row.status;
  if (row.due_date) body.due_date = new Date(row.due_date).getTime();
  const assignees = parseAssignees(row.assignees).map(a => a.id).filter(v => v != null).map(Number);
  if (assignees.length) body.assignees = assignees;
  const catOpt = await categoryOptionId(row.category);
  if (catOpt) body.custom_fields = [{ id: deps.CATEGORY_FIELD_ID, value: catOpt }];
  const created = await deps.clickupWriteWithToken(tok, 'POST', `/list/${deps.PROPERTY_TASKS_LIST_ID}/task`, body);
  const target = explicitTargetId || await clickupTargetForRow(row);
  if (target) {
    try { await deps.clickupWriteWithToken(tok, 'POST', `/task/${created.id}/field/${deps.PROPERTY_FIELD_ID}`, { value: { add: [String(target)] } }); }
    catch (e) { console.warn('pushCreate: link relationship failed:', e.message); }
  }
  return String(created.id);
}
async function pushUpdate(clickupId, row, tok = serviceToken()) {
  const body = {};
  if (row.name != null) body.name = row.name;
  if (row.description != null) body.description = row.description;
  if (row.status) body.status = row.status;
  body.due_date = row.due_date ? new Date(row.due_date).getTime() : null;
  await deps.clickupWriteWithToken(tok, 'PUT', `/task/${clickupId}`, body);
  const catOpt = await categoryOptionId(row.category);
  if (catOpt) {
    try { await deps.clickupWriteWithToken(tok, 'POST', `/task/${clickupId}/field/${deps.CATEGORY_FIELD_ID}`, { value: catOpt }); }
    catch (e) { console.warn('pushUpdate: category set failed:', e.message); }
  }
}
async function markError(id) {
  try { await q(`update public.task set sync_state='error' where id=$1`, [id]); } catch (e) {}
}

// ---------------------------------------------------------------------------
// READ: board payload (same shape buildPropTasksCache produces, so the Kanban
// consumes it unchanged). Adds sync_state per task.
// ---------------------------------------------------------------------------
async function getBoardPayload() {
  let statuses = [];
  try { statuses = await deps.getListStatuses(deps.PROPERTY_TASKS_LIST_ID); } catch (e) {}
  const statusByName = new Map(statuses.map(s => [String(s.status).toLowerCase(), s]));
  const catOpts = await categoryOptions().catch(() => []);
  const rows = (await q(`
    select t.*, coalesce(p.dba_name, u.unit_identifier) as link_name
    from public.task t
    left join public.property p on p.id = t.property_id
    left join public.unit u on u.id = t.unit_id
    order by t.updated_at desc nulls last`, [])).rows;
  const tasks = rows.map(r => {
    const st = statusByName.get(String(r.status || '').toLowerCase());
    // value carries the Supabase property/unit id so the front-end's "Open Tasks"
    // + per-building task matching (by property.taskId / building id) works.
    const linkId = r.property_id || r.unit_id;
    return {
      id: String(r.clickup_task_id || ('sb-' + r.id)),
      supabaseId: r.id,
      name: r.name,
      url: r.clickup_task_id ? `https://app.clickup.com/t/${r.clickup_task_id}` : '#',
      status: r.status || null,
      statusColor: st?.color || null,
      statusType: st?.type || null,
      assignees: parseAssignees(r.assignees).map(a => { const n = asg(a); return { id: n.id, name: n.name, initials: n.initials, username: n.name || ('User ' + n.id), color: null }; }),
      due_date: r.due_date ? new Date(r.due_date).getTime() : null,
      sync_state: r.sync_state || 'synced',
      fields: {
        'property': { id: deps.PROPERTY_FIELD_ID, name: 'Property', type: 'tasks', value: linkId ? [{ id: String(linkId), name: r.link_name || '' }] : [], display: r.link_name ? [r.link_name] : [] },
        'category': { id: deps.CATEGORY_FIELD_ID, name: 'Category', type: 'drop_down', value: null, display: r.category || null, options: catOpts },
      },
    };
  });
  return {
    generatedAt: new Date().toISOString(),
    statuses: statuses.map(s => ({ status: s.status, color: s.color, type: s.type, orderindex: s.orderindex })),
    tasks,
    source: 'supabase',
  };
}

// Resolve a SUPABASE property/unit id (what the Supabase-backed board sends) to the
// FK + the ClickUp relationship target (the record's clickup_task_id, for the push).
async function resolveSupabaseLink(id) {
  if (!id) return { property_id: null, unit_id: null, clickupTarget: null };
  let r = await q('select id, clickup_task_id from public.property where id = $1 limit 1', [id]);
  if (r.rows.length) return { property_id: r.rows[0].id, unit_id: null, clickupTarget: r.rows[0].clickup_task_id || null };
  r = await q('select id, clickup_task_id from public.unit where id = $1 limit 1', [id]);
  if (r.rows.length) return { property_id: null, unit_id: r.rows[0].id, clickupTarget: r.rows[0].clickup_task_id || null };
  return { property_id: null, unit_id: null, clickupTarget: null };
}
// ---------------------------------------------------------------------------
// CREATE (dashboard-originated). Parent link REQUIRED (a Supabase property/unit id).
// Inserts pending, then attempts an immediate push; leaves pending on failure for
// the next scheduled sync.
// ---------------------------------------------------------------------------
async function createTaskFromDashboard(input, userToken) {
  const link = await resolveSupabaseLink(input.clickupTargetId); // clickupTargetId = chosen Supabase property/unit id
  if (!link.property_id && !link.unit_id) {
    throw new Error('A parent property or building is required');
  }
  const catName = input.categoryName || await categoryNameForOption(input.categoryValue);
  // Store assignees as {id,name,initials} (front end sends {id,name}); never bare ids.
  const assignees = JSON.stringify((input.assignees || []).map(a => asg(a)));
  const ins = await q(`
    insert into public.task
      (clickup_task_id, clickup_list_id, name, description, status, category, assignees, due_date,
       property_id, unit_id, loan_id, sync_state, updated_at, last_synced_at)
    values (null, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'pending', now(), null)
    returning id`,
    [deps.PROPERTY_TASKS_LIST_ID, input.name, input.description || null, input.status || null, catName,
     assignees, input.due_date ? new Date(Number(input.due_date)).toISOString() : null,
     link.property_id, link.unit_id, input.loan_id || null]);
  const rowId = ins.rows[0].id;
  try {
    const row = (await q('select * from public.task where id=$1', [rowId])).rows[0];
    // Push to ClickUp; set the Property relationship to the record's clickup_task_id
    // (null if the property/unit hasn't been backfilled yet — task still created).
    const newId = await pushCreate(row, userToken || serviceToken(), link.clickupTarget);
    await q(`update public.task set clickup_task_id=$1, sync_state='synced', last_synced_at=now() where id=$2`, [newId, rowId]);
    return { id: rowId, taskId: newId, clickup_task_id: newId, sync_state: 'synced' };
  } catch (e) {
    console.warn('createTaskFromDashboard: immediate push failed, left pending:', e.message);
    return { id: rowId, taskId: null, clickup_task_id: null, sync_state: 'pending', warning: e.message };
  }
}

// ---------------------------------------------------------------------------
// SYNC: one reconcile pass. Convergence is anchored on last_synced_at to avoid
// ping-pong: a side "changed" only if its timestamp is newer than last_synced_at.
// ---------------------------------------------------------------------------
async function runSync() {
  if (!enabled) return { skipped: true };
  const res = { pulled_new: 0, pushed_new: 0, updated_supabase: 0, updated_clickup: 0, relinked: 0, conflicts: 0, errors: 0 };
  const cuTasks = await deps.fetchAllListTasks(deps.PROPERTY_TASKS_LIST_ID);
  const sb = (await q('select * from public.task', [])).rows;
  const sbByCu = new Map();
  const sbLocalOnly = [];
  for (const row of sb) {
    if (row.clickup_task_id) sbByCu.set(String(row.clickup_task_id), row);
    else sbLocalOnly.push(row);
  }

  // 1) ClickUp-only -> insert into Supabase
  for (const t of cuTasks) {
    if (sbByCu.has(String(t.id))) continue;
    try {
      const link = await resolveLink(cuPropertyTarget(t));
      const r = cuToRow(t);
      await q(`
        insert into public.task
          (clickup_task_id, clickup_list_id, name, description, status, category, priority, assignees,
           start_date, due_date, date_closed, property_id, unit_id, sync_state, last_synced_at, updated_at)
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'synced', now(), $14)
        on conflict (clickup_task_id) do nothing`,
        [String(t.id), deps.PROPERTY_TASKS_LIST_ID, r.name, r.description, r.status, r.category, r.priority,
         r.assignees, r.start_date, r.due_date, r.date_closed, link.property_id, link.unit_id,
         msToISO(t.date_updated) || new Date().toISOString()]);
      res.pulled_new++;
    } catch (e) { res.errors++; console.error('sync pull(new):', e.message); }
  }

  // 2) Supabase local-only -> create in ClickUp
  for (const row of sbLocalOnly) {
    try {
      const newId = await pushCreate(row);
      await q(`update public.task set clickup_task_id=$1, clickup_list_id=$2, sync_state='synced', last_synced_at=now() where id=$3`,
        [newId, deps.PROPERTY_TASKS_LIST_ID, row.id]);
      res.pushed_new++;
    } catch (e) { res.errors++; await markError(row.id); console.error('sync push(new):', e.message); }
  }

  // 3) In both -> last-write-wins vs last_synced_at
  const SKEW = 2000; // ms tolerance
  for (const t of cuTasks) {
    const row = sbByCu.get(String(t.id));
    if (!row) continue;
    try {
      // Re-resolve the property/unit link from the CURRENT ClickUp relationship every
      // sync (by id, then by name), so links self-heal after the Supabase data is
      // reshaped and ids change — not only when the stored FK is null. Only overwrite
      // when we positively resolve a target AND it differs from what's stored, so we
      // never wipe a good link just because a name lookup came up empty.
      {
        const link = await resolveLink(cuPropertyTarget(t));
        if ((link.property_id || link.unit_id) &&
            (String(link.property_id || '') !== String(row.property_id || '') ||
             String(link.unit_id || '') !== String(row.unit_id || ''))) {
          await q('update public.task set property_id=$1, unit_id=$2 where id=$3', [link.property_id, link.unit_id, row.id]);
          row.property_id = link.property_id; row.unit_id = link.unit_id;
          res.relinked = (res.relinked || 0) + 1;
        }
        // Backfill assignee display names from ClickUp (existing rows may hold id-only
        // objects, which the UI would otherwise show as the numeric id). Part 3.
        const cuAsg = (t.assignees || []).map(a => asg(a));
        const storedAsg = parseAssignees(row.assignees);
        if (cuAsg.length && (storedAsg.length !== cuAsg.length || storedAsg.some(a => !a.name))) {
          const j = JSON.stringify(cuAsg);
          await q('update public.task set assignees=$1 where id=$2', [j, row.id]);
          row.assignees = j;
        }
      }
      const lastSync = row.last_synced_at ? new Date(row.last_synced_at).getTime() : 0;
      const cuUpdated = Number(t.date_updated || 0);
      const sbUpdated = row.updated_at ? new Date(row.updated_at).getTime() : 0;
      const cuChanged = cuUpdated > lastSync + SKEW;
      const sbChanged = sbUpdated > lastSync + SKEW;
      if (!cuChanged && !sbChanged) continue;
      let clickupWins;
      if (cuChanged && sbChanged) { res.conflicts++; clickupWins = cuUpdated >= sbUpdated; }
      else { clickupWins = cuChanged; }
      if (clickupWins) {
        const r = cuToRow(t);
        // NOTE: do NOT touch property_id/unit_id here — the relink block above manages the
        // link non-destructively. Overwriting it with a failed resolve (null) would wipe a
        // good link (e.g. a dashboard-created building task whose unit has no clickup id).
        await q(`
          update public.task set name=$1, description=$2, status=$3, category=$4, priority=$5, assignees=$6,
            start_date=$7, due_date=$8, date_closed=$9,
            sync_state='synced', last_synced_at=now(), updated_at=now()
          where id=$10`,
          [r.name, r.description, r.status, r.category, r.priority, r.assignees, r.start_date, r.due_date,
           r.date_closed, row.id]);
        res.updated_supabase++;
      } else {
        await pushUpdate(t.id, row);
        await q(`update public.task set sync_state='synced', last_synced_at=now() where id=$1`, [row.id]);
        res.updated_clickup++;
      }
    } catch (e) { res.errors++; await markError(row.id); console.error('sync reconcile:', e.message); }
  }

  console.log('Task sync:', JSON.stringify(res));
  return res;
}

module.exports = { enabled, init, getBoardPayload, createTaskFromDashboard, runSync };
