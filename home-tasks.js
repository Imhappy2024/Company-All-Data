// ===========================================================================
// home-tasks.js — Home: every open ClickUp task the signed-in person can see.
//
//   GET /api/home/tasks          { me, tasks, workspaces, fetchedAt, stale }
//   GET /api/home/tasks?fresh=1  wait for a fresh read instead of the cache
//
// ONLY the person's own ClickUp sign-in (the OAuth token PortalAuth sends as
// X-ClickUp-Token, or the du_token cookie) is ever used here. There is no
// fallback to the server's shared CLICKUP_API_TOKEN: ClickUp's own
// permissions decide what each person sees, and someone who has not connected
// ClickUp gets a 401 and a "Connect ClickUp" button, never a borrowed view.
//
// Every page of every workspace is read (100 tasks a page, until last_page),
// tasks are de-duplicated by id - a task reachable from two businesses' spaces
// is one task - and the result is cached per token for the session and
// refreshed in the background once it is a minute old.
// ===========================================================================
'use strict';

const crypto = require('crypto');
const express = require('express');

const API = 'https://api.clickup.com/api/v2';
const FRESH_MS = 60 * 1000;          // serve without refreshing
const KEEP_MS = 30 * 60 * 1000;      // drop a cache entry this old
const MAX_PAGES = 200;               // 20,000 tasks per workspace; a guard, not a limit anyone reaches

const RETRY_MS = 60 * 1000;          // after a failed refresh, wait this long before trying again
const MAX_ENTRIES = 500;             // one per signed-in person; a guard, not a limit anyone reaches
const cache = new Map();             // staffId:sha256(token) -> { at, data, inflight, failedAt }

/* The person's own token, nothing else. */
function personToken(req) {
  const h = req.headers['x-clickup-token'];
  if (h) return String(h);
  const m = /(?:^|;\s*)du_token=([^;]+)/.exec(req.headers.cookie || '');
  return m ? decodeURIComponent(m[1]) : null;
}

async function cu(token, path, fetchImpl) {
  const r = await (fetchImpl || fetch)(API + path, { headers: { Authorization: token } });
  if (r.status === 401 || r.status === 403) { const e = new Error('ClickUp refused your sign-in. Connect ClickUp again.'); e.status = 401; throw e; }
  if (r.status === 429) { const e = new Error('ClickUp is rate limiting; try again in a minute.'); e.status = 429; throw e; }
  if (!r.ok) { const e = new Error('ClickUp ' + r.status + ' on ' + path.split('?')[0]); e.status = 502; throw e; }
  return r.json();
}

const ms = v => (v === null || v === undefined || v === '' ? null : Number(v));
function initials(name) {
  const p = String(name || '').trim().split(/\s+/).filter(Boolean);
  return p.length ? ((p[0][0] || '') + (p.length > 1 ? p[p.length - 1][0] : '')).toUpperCase() : '?';
}
/* One ClickUp task -> the row Home renders. */
function normalize(t, workspace, spaceNames) {
  const spaceId = (t.space && t.space.id) ? String(t.space.id) : '';
  return {
    id: String(t.id),
    name: t.name || '(untitled)',
    url: t.url || ('https://app.clickup.com/t/' + t.id),
    list: (t.list && t.list.name) || '',
    listId: (t.list && t.list.id) ? String(t.list.id) : '',
    space: spaceId,
    spaceName: (spaceNames && spaceNames[spaceId]) || (t.space && t.space.name) || '',
    /* a list outside any folder sits in a hidden folder ClickUp names "hidden" */
    folder: (t.folder && !t.folder.hidden && t.folder.name) || '',
    workspace: workspace ? String(workspace) : '',
    status: (t.status && t.status.status) || '',
    statusType: (t.status && t.status.type) || '',
    statusColor: (t.status && t.status.color) || '',
    priority: (t.priority && t.priority.priority) || null,
    tags: (t.tags || []).map(x => x.name).filter(Boolean),
    created: ms(t.date_created),
    updated: ms(t.date_updated),
    due: ms(t.due_date),
    assignees: (t.assignees || []).map(a => ({ id: String(a.id), name: a.username || a.email || 'Someone', initials: a.initials || initials(a.username) })),
  };
}
/* One ClickUp comment -> author, time, and its parts: text runs and links
   (an attachment, or text ClickUp marked as a link). */
function shapeComment(c) {
  const parts = [];
  for (const p of (c.comment || [])) {
    if (p.type === 'attachment' && p.attachment) parts.push({ link: p.attachment.url || p.attachment.url_w_query || '', text: p.attachment.title || 'Attachment', file: true });
    else if (p.attributes && p.attributes.link) parts.push({ link: p.attributes.link, text: p.text || p.attributes.link });
    else if (p.text) parts.push({ text: p.text });
  }
  if (!parts.length && c.comment_text) parts.push({ text: c.comment_text });
  return { id: String(c.id), author: (c.user && (c.user.username || c.user.email)) || 'Someone', at: ms(c.date), parts };
}

/* Merge pages from every workspace into one list, each task once. */
function collect(pages, spaceNames) {
  const byId = new Map();
  for (const pg of pages) {
    for (const t of (pg.tasks || [])) {
      const id = String(t.id);
      if (!byId.has(id)) byId.set(id, normalize(t, pg.workspace, spaceNames));
    }
  }
  return [...byId.values()];
}

async function readAll(token, fetchImpl) {
  const me = (await cu(token, '/user', fetchImpl)).user || {};
  const teams = (await cu(token, '/team', fetchImpl)).teams || [];
  const pages = [];
  const spaceNames = {};
  for (const team of teams) {
    /* the task payload carries only the space id; the panel's location line needs its name */
    try {
      const sp = await cu(token, '/team/' + encodeURIComponent(team.id) + '/space?archived=false', fetchImpl);
      for (const x of (sp.spaces || [])) spaceNames[String(x.id)] = x.name;
    } catch (e) { if (e.status === 401) throw e; /* names are a nicety; tasks still load */ }
    for (let page = 0; page < MAX_PAGES; page++) {
      const d = await cu(token, '/team/' + encodeURIComponent(team.id) + '/task?page=' + page +
        '&subtasks=true&include_closed=false&order_by=due_date&reverse=false', fetchImpl);
      pages.push({ workspace: team.id, tasks: d.tasks || [] });
      if (d.last_page === true || !(d.tasks || []).length) break;
    }
  }
  return {
    me: { id: String(me.id || ''), name: me.username || me.email || '', initials: me.initials || initials(me.username) },
    workspaces: teams.length,
    tasks: collect(pages, spaceNames),
    fetchedAt: new Date().toISOString(),
  };
}

/* A panel action, as the person. ClickUp's own refusal is passed back as the
   message, never a generic error. A 401 from ClickUp here is a refusal on this
   one task, so it is reported as 403: the client keeps the person signed in. */
async function act(token, method, path, body, fetchImpl) {
  const r = await (fetchImpl || fetch)(API + path, {
    method, headers: { Authorization: token, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let j = null; try { j = text ? JSON.parse(text) : null; } catch (e) { /* not JSON */ }
  if (!r.ok) {
    const e = new Error((j && (j.err || j.error)) || ('ClickUp refused this (' + r.status + ').'));
    e.status = r.status === 401 ? 403 : (r.status === 429 ? 429 : (r.status >= 500 ? 502 : 400));
    throw e;
  }
  return j || {};
}

/* Only these fields can be changed from the panel. */
function cleanUpdate(b) {
  const out = {};
  if (typeof b.status === 'string' && b.status.trim()) out.status = b.status.trim();
  if ('due_date' in b) {
    if (b.due_date === null || b.due_date === '') out.due_date = null;
    else if (Number.isFinite(Number(b.due_date))) { out.due_date = Number(b.due_date); out.due_date_time = false; }
  }
  if (b.assignees && typeof b.assignees === 'object') {
    const ids = v => (Array.isArray(v) ? v : []).map(Number).filter(Number.isFinite);
    const add = ids(b.assignees.add), rem = ids(b.assignees.rem);
    if (add.length || rem.length) out.assignees = { add, rem };
  }
  return out;
}

/* After a write, put the task's new shape into the person's cached copy, so a
   reload of Home agrees with the panel instead of showing the old row. */
function patchCached(key, task) {
  const e = cache.get(key);
  if (!e || !e.data) return;
  const i = e.data.tasks.findIndex(t => t.id === task.id);
  if (i >= 0) e.data.tasks[i] = Object.assign({}, e.data.tasks[i], task, { spaceName: e.data.tasks[i].spaceName });
}

function refresh(key, token) {
  const entry = cache.get(key) || {};
  if (entry.inflight) return entry.inflight;
  entry.inflight = readAll(token)
    .then(data => { cache.set(key, { at: Date.now(), data }); return data; })
    .catch(e => {
      /* an entry that never got data is dropped; one that has data keeps
         serving it, and waits RETRY_MS before asking ClickUp again */
      const c = cache.get(key);
      if (c && !c.data) cache.delete(key); else if (c) c.failedAt = Date.now();
      throw e;
    })
    .finally(() => { const e = cache.get(key); if (e) e.inflight = null; });
  if (!cache.has(key) && cache.size >= MAX_ENTRIES) cache.delete(cache.keys().next().value);
  cache.set(key, entry);
  return entry.inflight;
}

function homeRoutes() {
  const r = express.Router();
  r.use(express.json({ limit: '64kb' }));
  const keyOf = (req, token) => String((req.who && req.who.staffId) || '') + ':' + crypto.createHash('sha256').update(token).digest('hex');
  /* Every panel read and write: the person's own token, or a 401 asking them to connect. */
  const panel = fn => async (req, res) => {
    const token = personToken(req);
    if (!token) return res.status(401).json({ error: 'Connect ClickUp to work on tasks.', connect: true });
    try { await fn(req, res, token); }
    catch (e) { res.status(e.status || 500).json({ error: e.message }); }
  };
  const idOk = v => /^[A-Za-z0-9_-]{1,40}$/.test(String(v || ''));
  const badId = (res, what) => res.status(400).json({ error: 'Not a ' + what + ' id.' });

  r.get('/list/:id/statuses', panel(async (req, res, token) => {
    if (!idOk(req.params.id)) return badId(res, 'list');
    const d = await act(token, 'GET', '/list/' + req.params.id);
    res.json({ statuses: (d.statuses || []).map(x => ({ status: x.status, color: x.color, type: x.type, orderindex: x.orderindex })) });
  }));
  r.get('/list/:id/members', panel(async (req, res, token) => {
    if (!idOk(req.params.id)) return badId(res, 'list');
    const d = await act(token, 'GET', '/list/' + req.params.id + '/member');
    res.json({ members: (d.members || []).map(m => ({ id: String(m.id), name: m.username || m.email || String(m.id), email: m.email || null, initials: m.initials || initials(m.username || m.email) })) });
  }));
  r.put('/task/:id', panel(async (req, res, token) => {
    if (!idOk(req.params.id)) return badId(res, 'task');
    const body = cleanUpdate(req.body || {});
    if (!Object.keys(body).length) return res.status(400).json({ error: 'Nothing to change.' });
    const t = normalize(await act(token, 'PUT', '/task/' + req.params.id, body));
    patchCached(keyOf(req, token), t);
    res.json({ task: t });
  }));
  r.get('/task/:id/comments', panel(async (req, res, token) => {
    if (!idOk(req.params.id)) return badId(res, 'task');
    const d = await act(token, 'GET', '/task/' + req.params.id + '/comment');
    res.json({ comments: (d.comments || []).map(shapeComment).sort((a, b) => (b.at || 0) - (a.at || 0)) });
  }));
  r.post('/task/:id/comment', panel(async (req, res, token) => {
    if (!idOk(req.params.id)) return badId(res, 'task');
    const text = String((req.body && req.body.comment_text) || '').trim();
    if (!text) return res.status(400).json({ error: 'Write a comment first.' });
    if (text.length > 20000) return res.status(400).json({ error: 'That comment is too long.' });
    await act(token, 'POST', '/task/' + req.params.id + '/comment', { comment_text: text, notify_all: false });
    res.json({ ok: true });
  }));

  r.get('/tasks', async (req, res) => {
    const token = personToken(req);
    if (!token) return res.status(401).json({ error: 'Connect ClickUp to see your tasks.', connect: true });
    const key = keyOf(req, token);
    try {
      const hit = cache.get(key);
      const fresh = req.query.fresh === '1';
      if (hit && hit.data && !fresh) {
        const age = Date.now() - hit.at;
        const backingOff = hit.failedAt && Date.now() - hit.failedAt < RETRY_MS;
        if (age > FRESH_MS && !backingOff) refresh(key, token).catch(() => { /* keep serving the cached copy */ });
        return res.json(Object.assign({ stale: age > FRESH_MS, refreshFailed: !!hit.failedAt }, hit.data));
      }
      const data = await refresh(key, token);
      res.json(Object.assign({ stale: false }, data));
    } catch (e) {
      res.status(e.status || 500).json({ error: e.message, connect: e.status === 401 });
    }
  });
  return r;
}

/* old entries go */
setInterval(() => { const cut = Date.now() - KEEP_MS; for (const [k, v] of cache) if (!v.inflight && (!v.at || v.at < cut)) cache.delete(k); }, 5 * 60 * 1000).unref();

module.exports = { homeRoutes, _internal: { collect, normalize, readAll, personToken, cleanUpdate, shapeComment, act } };
