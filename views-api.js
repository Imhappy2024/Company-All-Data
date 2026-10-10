// ===========================================================================
// views-api.js — saved custom views (Phase 3.5).
//
//   GET    /api/datasets
//   GET    /api/views            POST /api/views
//   GET    /api/views/:id        PUT  /api/views/:id      DELETE /api/views/:id
//   GET    /api/views/:id/data
//   GET    /api/views/:id/shares PUT  /api/views/:id/shares
//
// A saved view stores a QUESTION, never data: a dataset key, a display type
// and a config. Rows are fetched fresh on every load and scoped to whoever
// is looking.
//
// THE SECURITY SHAPE, because this is the part worth getting right:
//
//  * No free-typed SQL reaches the database, ever. Every identifier comes out
//    of config/datasets.js by key lookup - column, relation, operator,
//    aggregate and sort direction each have their own allowlist helper. Every
//    VALUE is a bound parameter.
//
//  * Sharing a view never grants access to data the person could not
//    otherwise see. The dataset query applies the READER's tenant scope, not
//    the owner's, so a shared view may legitimately show them fewer rows.
//    This is the single most important line in the file: taking the scope
//    from the saved row instead would turn a share into a privilege grant.
//
//  * The server reads with the postgres superuser, so RLS is not a second
//    line here either. Permission is decided in code, on every request, from
//    the identity portal-identity.js verified against Supabase.
//
// Config is validated against the registry on SAVE and again on LOAD. A field
// that disappears from a dataset later must not break a saved view: it
// renders as "Field missing: <label>" and the rest of the view still works.
// ===========================================================================
'use strict';

const express = require('express');
const db = require('./supabase-db');
const { guard, isAdmin } = require('./portal-identity');
const R = require('./config/datasets');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuidOrNull = v => (typeof v === 'string' && UUID.test(v.trim()) ? v.trim() : null);

const PER_PAGE_DEFAULT = 200;
const PER_PAGE_MAX = 200;

/* ---------------------------------------------------------------------------
   Config validation.

   Returns { config, problems[] }. Problems are DESCRIPTIVE, never fatal: the
   view still loads with the bad parts dropped, and the screen says which.
--------------------------------------------------------------------------- */
function validateConfig(datasetKey, raw) {
  const ds = R.getDataset(datasetKey);
  const problems = [];
  const cfg = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
  if (!ds) return { config: {}, problems: ['Unknown dataset: ' + datasetKey] };

  const keep = {};

  keep.fields = [];
  for (const f of Array.isArray(cfg.fields) ? cfg.fields : []) {
    const key = f && typeof f === 'object' ? f.key : f;
    const def = R.getField(datasetKey, key);
    if (!def) { problems.push('Field missing: ' + (key || '(unnamed)')); continue; }
    keep.fields.push({
      key: def.key,
      label: (f && f.label) || def.label,
      format: (f && f.format) || def.format || null,
      width: f && Number.isFinite(Number(f.width)) ? Number(f.width) : null,
    });
  }

  keep.filters = [];
  for (const f of Array.isArray(cfg.filters) ? cfg.filters : []) {
    if (!f || typeof f !== 'object') continue;
    const def = R.getField(datasetKey, f.field);
    if (!def) { problems.push('Filter on a missing field: ' + (f.field || '(unnamed)')); continue; }
    const op = R.safeOp(f.op);
    if (!op) { problems.push('Unsupported filter on ' + def.label + ': ' + f.op); continue; }
    keep.filters.push({ field: def.key, op, value: f.value });
  }

  keep.sort = [];
  for (const s of Array.isArray(cfg.sort) ? cfg.sort : []) {
    if (!s || !R.getField(datasetKey, s.field)) {
      if (s) problems.push('Sort on a missing field: ' + (s.field || '(unnamed)'));
      continue;
    }
    keep.sort.push({ field: s.field, dir: String(s.dir).toLowerCase() === 'desc' ? 'desc' : 'asc' });
  }
  if (!keep.sort.length && ds.defaultSort) keep.sort = ds.defaultSort.slice();

  keep.group_by = [];
  for (const g of Array.isArray(cfg.group_by) ? cfg.group_by : []) {
    if (!R.getField(datasetKey, g)) { problems.push('Grouping on a missing field: ' + g); continue; }
    keep.group_by.push(g);
  }

  keep.aggregates = [];
  for (const a of Array.isArray(cfg.aggregates) ? cfg.aggregates : []) {
    if (!a || !R.getField(datasetKey, a.field)) {
      if (a) problems.push('Aggregate on a missing field: ' + (a.field || '(unnamed)'));
      continue;
    }
    if (!R.safeAggregate(a.fn)) { problems.push('Unsupported aggregate: ' + a.fn); continue; }
    keep.aggregates.push({ field: a.field, fn: String(a.fn).toLowerCase() });
  }

  if (cfg.period && typeof cfg.period === 'object') {
    const t = cfg.period.type;
    if (['latest', 'year', 'range'].indexOf(t) >= 0) keep.period = cfg.period;
    else problems.push('Unknown period type: ' + t);
  }

  if (cfg.pivot && typeof cfg.pivot === 'object') {
    const rows = cfg.pivot.rows, cols = cfg.pivot.columns, val = cfg.pivot.value;
    const bad = [rows, cols, val].filter(k => k && !R.getField(datasetKey, k));
    if (bad.length) problems.push('Pivot uses missing fields: ' + bad.join(', '));
    else keep.pivot = { rows, columns: cols, value: val };
  }

  if (Array.isArray(cfg.layout)) {
    keep.layout = [];
    for (const t of cfg.layout) {
      if (!t || typeof t !== 'object') continue;
      if (t.type !== 'number' && t.type !== 'table') { problems.push('Unknown tile type: ' + t.type); continue; }
      const fields = t.fields || (t.field ? [t.field] : []);
      const missing = fields.filter(k => !R.getField(datasetKey, k));
      if (missing.length) { problems.push('Tile "' + (t.title || '') + '" uses missing fields: ' + missing.join(', ')); continue; }
      keep.layout.push({
        type: t.type, title: t.title || '', fields,
        aggregate: R.safeAggregate(t.aggregate) ? String(t.aggregate).toLowerCase() : null,
        w: Number(t.w) || 1, h: Number(t.h) || 1,
        filters: Array.isArray(t.filters) ? t.filters : [],
      });
    }
  }

  return { config: keep, problems };
}

/* ---------------------------------------------------------------------------
   Query building. Identifiers come from the registry; values are bound.
--------------------------------------------------------------------------- */
function buildWhere(datasetKey, filters, params) {
  const parts = [];
  for (const f of filters || []) {
    const col = R.safeColumn(datasetKey, f.field);
    if (!col) continue;
    const v = f.value;
    switch (f.op) {
      case 'is_empty':   parts.push(`(${col} is null)`); break;
      case 'not_empty':  parts.push(`(${col} is not null)`); break;
      case 'in': {
        const list = Array.isArray(v) ? v : [v];
        if (!list.length) { parts.push('false'); break; }   // never an empty IN ()
        params.push(list);
        parts.push(`(${col} = any($${params.length}))`);
        break;
      }
      case 'between': {
        const list = Array.isArray(v) ? v : [];
        if (list.length !== 2) break;
        params.push(list[0]); const a = params.length;
        params.push(list[1]); const b = params.length;
        parts.push(`(${col} between $${a} and $${b})`);
        break;
      }
      case 'contains':
        params.push('%' + String(v == null ? '' : v) + '%');
        parts.push(`(${col}::text ilike $${params.length})`);
        break;
      default: {
        const OPS = { eq: '=', ne: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=' };
        const sqlOp = OPS[f.op];
        if (!sqlOp) break;
        params.push(v);
        parts.push(`(${col} ${sqlOp} $${params.length})`);
      }
    }
  }
  return parts;
}

async function runDataset(datasetKey, config, tenantId, page, perPage) {
  const ds = R.getDataset(datasetKey);
  const view = R.safeView(datasetKey);
  const tenantCol = R.tenantColumn(datasetKey);   // throws if a dataset forgot one
  if (!ds || !view) throw new Error('Unknown dataset.');

  const params = [tenantId];
  const where = [`${tenantCol} = $1`].concat(buildWhere(datasetKey, config.filters, params));

  /* SQL grouping ONLY when there are aggregates.
     A report groups in the RENDERER - sections with subtotals and a grand
     total - and it needs the detail rows to do it. Grouping in SQL on a
     report's group_by collapsed every row to the manager plus whatever was
     aggregated, so the other seven columns came back absent and the screen
     filled with dashes. group_by alone is a presentation instruction. */
  const grouping = !!(config.aggregates && config.aggregates.length);

  let selectList, groupBy = '';
  if (grouping) {
    const gcols = (config.group_by || []).map(k => R.safeColumn(datasetKey, k) + ' as ' + R.safeColumn(datasetKey, k));
    const acols = (config.aggregates || []).map(a => {
      const col = R.safeColumn(datasetKey, a.field);
      const fn = R.safeAggregate(a.fn);
      return `${fn}(${col}) as "${a.fn}_${a.field}"`;
    });
    selectList = gcols.concat(acols).join(', ') || '1';
    if (config.group_by && config.group_by.length) {
      groupBy = ' group by ' + config.group_by.map(k => R.safeColumn(datasetKey, k)).join(', ');
    }
  } else {
    const cols = (config.fields && config.fields.length ? config.fields.map(f => f.key) : ds.fields.map(f => f.key))
      .map(k => R.safeColumn(datasetKey, k)).filter(Boolean);
    selectList = cols.join(', ') || '*';
  }

  /* When the query groups, ORDER BY may only name a grouped column or an
     aggregate. The default sort comes from the dataset and knows nothing
     about this config, so an ungrouped default silently turns every grouped
     view into a 42803 - which is what it did for three of the four starter
     views. Sorts that cannot apply are dropped, not rejected: a grouped view
     with no usable sort is still a valid view. */
  let orderBy = '';
  const groupedCols = grouping
    ? new Set((config.group_by || []).map(k => R.safeColumn(datasetKey, k)).filter(Boolean))
    : null;
  const aggAlias = new Map();
  for (const a of (grouping ? (config.aggregates || []) : [])) {
    aggAlias.set(a.field, `"${a.fn}_${a.field}"`);
  }

  const sorts = (config.sort || []).map(s => {
    const col = R.safeColumn(datasetKey, s.field);
    if (!col) return null;
    let target = col;
    if (grouping) {
      if (groupedCols.has(col)) target = col;
      else if (aggAlias.has(s.field)) target = aggAlias.get(s.field);
      else return null;
    }
    /* nulls last in BOTH directions: a null at the top of a descending
       column reads as the largest value, which is how number_of_units
       misled the Folio table. */
    return target + ' ' + R.safeDir(s.dir) + ' nulls last';
  }).filter(Boolean);
  if (sorts.length) orderBy = ' order by ' + sorts.join(', ');

  const base = `from ${view} where ${where.join(' and ')}`;
  const countRow = await db.q(
    grouping
      ? `select count(*)::int as n from (select 1 ${base}${groupBy}) z`
      : `select count(*)::int as n ${base}`,
    params
  );
  const total = countRow.rows[0] ? countRow.rows[0].n : 0;

  const lim = Math.min(Math.max(1, Number(perPage) || PER_PAGE_DEFAULT), PER_PAGE_MAX);
  const off = Math.max(0, ((Number(page) || 1) - 1) * lim);
  params.push(lim); const pl = params.length;
  params.push(off); const po = params.length;

  const rows = await db.q(
    `select ${selectList} ${base}${groupBy}${orderBy} limit $${pl} offset $${po}`,
    params
  );
  return { rows: rows.rows, total, page: Number(page) || 1, per_page: lim };
}

/* ---------------------------------------------------------------------------
   Permissions
--------------------------------------------------------------------------- */
async function loadView(id, who) {
  const r = await db.q(
    `select v.*,
            (select coalesce(json_agg(json_build_object(
                'principal_type', sh.principal_type, 'principal_id', sh.principal_id,
                'permission', sh.permission)), '[]'::json)
               from public.saved_view_share sh where sh.view_id = v.id) as shares
       from public.saved_view v
      where v.id = $1::uuid and v.tenant_id = $2 and v.deleted_at is null`,
    [id, who.tenantId]
  );
  return r.rows[0] || null;
}

/* owner > editor > viewer > null. An owner or admin always has owner rights;
   an admin is included because Users & Roles is role-gated for the same
   reason - the person who fixes access must not be able to lock themselves
   out of it. */
function permissionFor(view, who) {
  if (!view) return null;
  if (view.owner_staff_id === who.staffId) return 'owner';
  if (isAdmin(who)) return 'owner';
  let best = null;
  for (const s of view.shares || []) {
    const match = (s.principal_type === 'user' && s.principal_id === who.staffId)
      || (s.principal_type === 'role' && s.principal_id === who.role);
    if (!match) continue;
    if (s.permission === 'editor') best = 'editor';
    else if (best !== 'editor') best = 'viewer';
  }
  return best;
}

/* ---------------------------------------------------------------------------
   Routes
--------------------------------------------------------------------------- */

async function listDatasets(req, res, who) {
  res.json({
    ok: true,
    datasets: Object.keys(R.DATASETS).map(k => {
      const d = R.DATASETS[k];
      return {
        key: d.key, label: d.label, description: d.description, grain: d.grain,
        fields: d.fields.map(f => ({
          key: f.key, label: f.label, type: f.type, hidden: !!f.hidden,
          format: f.format || null, suffix: f.suffix || null, decimals: f.decimals || null,
        })),
        defaultSort: d.defaultSort || [],
      };
    }),
    filterOps: R.FILTER_OPS,
    aggregates: R.AGGREGATES,
    displayTypes: R.DISPLAY_TYPES,
  });
}

async function listViews(req, res, who) {
  const r = await db.q(
    `select v.id, v.name, v.description, v.dataset_key, v.display_type,
            v.created_at, v.updated_at, v.owner_staff_id,
            s.full_name as owner_name,
            (v.owner_staff_id = $2) as is_mine
       from public.saved_view v
       left join public.staff s on s.id = v.owner_staff_id
      where v.tenant_id = $1 and v.deleted_at is null
        and (v.owner_staff_id = $2
             or exists (select 1 from public.saved_view_share sh
                         where sh.view_id = v.id
                           and ((sh.principal_type = 'user' and sh.principal_id = $2::text)
                                or (sh.principal_type = 'role' and sh.principal_id = $3))))
      order by v.updated_at desc`,
    [who.tenantId, who.staffId, who.role]
  );
  res.json({ ok: true, views: r.rows });
}

async function getView(req, res, who) {
  const id = uuidOrNull(req.params.id);
  if (!id) return res.status(400).json({ error: 'Bad view id.' });
  const v = await loadView(id, who);
  const perm = permissionFor(v, who);
  if (!perm) return res.status(404).json({ error: 'No such view.' });
  const { config, problems } = validateConfig(v.dataset_key, v.config);
  res.json({ ok: true, view: Object.assign({}, v, { config }), permission: perm, problems });
}

async function getViewData(req, res, who) {
  const id = uuidOrNull(req.params.id);
  if (!id) return res.status(400).json({ error: 'Bad view id.' });
  const v = await loadView(id, who);
  const perm = permissionFor(v, who);
  if (!perm) return res.status(404).json({ error: 'No such view.' });

  const { config, problems } = validateConfig(v.dataset_key, v.config);
  /* THE READER'S tenant, never the saved row's owner scope. A share is not a
     privilege grant. */
  const out = await runDataset(v.dataset_key, config, who.tenantId,
    req.query.page, req.query.per_page);
  res.json(Object.assign({ ok: true, dataset: v.dataset_key, problems }, out));
}

/* The builder's live preview (step 6). It runs a DRAFT config that has not
   been saved, so there is no view row to check permissions against - the
   permission that matters is simply "may this person read this dataset",
   which is the same tenant scope every other read applies. Nothing is
   written, and the config goes through exactly the same validation a save
   would use, so the preview cannot show rows a saved view would not. */
async function previewData(req, res, who) {
  const datasetKey = String(req.query.dataset || '');
  if (!R.getDataset(datasetKey)) return res.status(400).json({ error: 'Unknown dataset.' });

  let raw = {};
  try { raw = JSON.parse(req.query.config || '{}'); }
  catch (e) { return res.status(400).json({ error: 'The view configuration could not be read.' }); }

  const { config, problems } = validateConfig(datasetKey, raw);
  const out = await runDataset(datasetKey, config, who.tenantId, 1, req.query.per_page || 50);
  res.json(Object.assign({ ok: true, dataset: datasetKey, problems }, out));
}

async function createView(req, res, who) {
  const b = req.body || {};
  const ds = R.getDataset(b.dataset_key);
  if (!ds) return res.status(400).json({ error: 'Unknown dataset.' });
  if (R.DISPLAY_TYPES.indexOf(b.display_type) < 0) return res.status(400).json({ error: 'Unknown display type.' });
  const name = String(b.name || '').trim();
  if (!name) return res.status(400).json({ error: 'A name is required.' });

  const { config, problems } = validateConfig(b.dataset_key, b.config);
  const r = await db.q(
    `insert into public.saved_view (tenant_id, owner_staff_id, name, description,
       dataset_key, display_type, config)
     values ($1, $2, $3, $4, $5, $6, $7::jsonb) returning *`,
    [who.tenantId, who.staffId, name, b.description || null,
     b.dataset_key, b.display_type, JSON.stringify(config)]
  );
  res.status(201).json({ ok: true, view: r.rows[0], problems });
}

async function updateView(req, res, who) {
  const id = uuidOrNull(req.params.id);
  if (!id) return res.status(400).json({ error: 'Bad view id.' });
  const v = await loadView(id, who);
  const perm = permissionFor(v, who);
  if (!perm) return res.status(404).json({ error: 'No such view.' });
  if (perm === 'viewer') return res.status(403).json({ error: 'You have view-only access to this view.' });

  const b = req.body || {};
  const datasetKey = b.dataset_key || v.dataset_key;
  if (!R.getDataset(datasetKey)) return res.status(400).json({ error: 'Unknown dataset.' });
  const display = b.display_type || v.display_type;
  if (R.DISPLAY_TYPES.indexOf(display) < 0) return res.status(400).json({ error: 'Unknown display type.' });

  const { config, problems } = validateConfig(datasetKey, b.config === undefined ? v.config : b.config);
  const name = b.name === undefined ? v.name : String(b.name || '').trim();
  if (!name) return res.status(400).json({ error: 'A name is required.' });

  /* An editor may change the CONFIG. owner_staff_id is never writable here:
     it is not in the statement at all, so a payload carrying one is ignored
     rather than trusted. */
  const r = await db.q(
    `update public.saved_view
        set name = $3, description = $4, dataset_key = $5, display_type = $6,
            config = $7::jsonb, updated_at = now()
      where id = $1::uuid and tenant_id = $2 and deleted_at is null
      returning *`,
    [id, who.tenantId, name, b.description === undefined ? v.description : b.description,
     datasetKey, display, JSON.stringify(config)]
  );
  res.json({ ok: true, view: r.rows[0], problems });
}

async function deleteView(req, res, who) {
  const id = uuidOrNull(req.params.id);
  if (!id) return res.status(400).json({ error: 'Bad view id.' });
  const v = await loadView(id, who);
  const perm = permissionFor(v, who);
  if (!perm) return res.status(404).json({ error: 'No such view.' });
  if (perm !== 'owner') return res.status(403).json({ error: 'Only the owner can delete a view.' });

  /* Soft delete. A shared view that vanishes from under the people it was
     shared with is a support ticket; the row stays addressable. */
  await db.q(
    `update public.saved_view set deleted_at = now(), updated_at = now()
      where id = $1::uuid and tenant_id = $2`,
    [id, who.tenantId]
  );
  res.json({ ok: true, deleted: id });
}

async function getShares(req, res, who) {
  const id = uuidOrNull(req.params.id);
  if (!id) return res.status(400).json({ error: 'Bad view id.' });
  const v = await loadView(id, who);
  const perm = permissionFor(v, who);
  if (!perm) return res.status(404).json({ error: 'No such view.' });
  const r = await db.q(
    `select sh.principal_type, sh.principal_id, sh.permission, sh.granted_at,
            s.full_name, s.email
       from public.saved_view_share sh
       left join public.staff s
              on sh.principal_type = 'user' and s.id::text = sh.principal_id
      where sh.view_id = $1::uuid order by sh.granted_at`,
    [id]
  );
  const people = await db.q(
    `select id, full_name, email from public.staff
      where tenant_id = $1 and is_active and dashboard_access order by full_name`,
    [who.tenantId]
  );
  res.json({ ok: true, shares: r.rows, permission: perm, people: people.rows, roles: ['owner', 'admin', 'user'] });
}

async function putShares(req, res, who) {
  const id = uuidOrNull(req.params.id);
  if (!id) return res.status(400).json({ error: 'Bad view id.' });
  const v = await loadView(id, who);
  const perm = permissionFor(v, who);
  if (!perm) return res.status(404).json({ error: 'No such view.' });
  if (perm !== 'owner') return res.status(403).json({ error: 'Only the owner can change sharing.' });

  const list = Array.isArray(req.body && req.body.shares) ? req.body.shares : [];
  const clean = [];
  for (const s of list) {
    if (!s || (s.principal_type !== 'user' && s.principal_type !== 'role')) continue;
    if (s.permission !== 'viewer' && s.permission !== 'editor') continue;
    const pid = String(s.principal_id || '').trim();
    if (!pid) continue;
    if (s.principal_type === 'user' && !uuidOrNull(pid)) continue;
    if (s.principal_type === 'role' && ['owner', 'admin', 'user'].indexOf(pid) < 0) continue;
    /* sharing with the owner is a no-op that would otherwise show them as
       their own viewer */
    if (s.principal_type === 'user' && pid === v.owner_staff_id) continue;
    clean.push({ t: s.principal_type, id: pid, p: s.permission });
  }

  await db.tx(async client => {
    await client.query('delete from public.saved_view_share where view_id = $1::uuid', [id]);
    for (const c of clean) {
      await client.query(
        `insert into public.saved_view_share (view_id, principal_type, principal_id, permission, granted_by)
         values ($1::uuid, $2, $3, $4, $5)
         on conflict (view_id, principal_type, principal_id) do update set permission = excluded.permission`,
        [id, c.t, c.id, c.p, who.staffId]
      );
    }
    await client.query('update public.saved_view set updated_at = now() where id = $1::uuid', [id]);
  });

  res.json({ ok: true, shares: clean.map(c => ({ principal_type: c.t, principal_id: c.id, permission: c.p })) });
}

/* A small fixed-window limiter on /data only, which is the one route that can
   be made expensive on purpose. Per staff id, in memory - this process is
   single-instance, same as the realtime hub. */
const hits = new Map();
const WINDOW_MS = 60000;
const MAX_PER_WINDOW = 120;
function rateLimitData(req, res, next) {
  const key = (req.headers.authorization || '').slice(-24);
  const now = Date.now();
  const rec = hits.get(key);
  if (!rec || now - rec.start > WINDOW_MS) hits.set(key, { start: now, n: 1 });
  else if (++rec.n > MAX_PER_WINDOW) {
    res.set('Retry-After', String(Math.ceil((rec.start + WINDOW_MS - now) / 1000)));
    return res.status(429).json({ error: 'Too many requests. Wait a moment and try again.' });
  }
  if (hits.size > 5000) hits.clear();
  next();
}

function datasetRoutes() {
  const r = express.Router();
  r.get('/', guard(listDatasets));
  return r;
}

function viewRoutes() {
  const r = express.Router();
  r.use(express.json({ limit: '256kb' }));
  r.get('/', guard(listViews));
  r.post('/', guard(createView));
  /* before /:id, or 'preview' is read as a view id and 400s as a bad uuid */
  r.get('/preview', rateLimitData, guard(previewData));
  r.get('/:id', guard(getView));
  r.put('/:id', guard(updateView));
  r.delete('/:id', guard(deleteView));
  r.get('/:id/data', rateLimitData, guard(getViewData));
  r.get('/:id/shares', guard(getShares));
  r.put('/:id/shares', guard(putShares));
  return r;
}

module.exports = {
  datasetRoutes, viewRoutes,
  _internal: { validateConfig, buildWhere, runDataset, permissionFor },
};
