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
function normalize(t, workspace) {
  return {
    id: String(t.id),
    name: t.name || '(untitled)',
    url: t.url || ('https://app.clickup.com/t/' + t.id),
    list: (t.list && t.list.name) || '',
    listId: (t.list && t.list.id) ? String(t.list.id) : '',
    space: (t.space && t.space.id) ? String(t.space.id) : '',
    workspace: workspace ? String(workspace) : '',
    status: (t.status && t.status.status) || '',
    statusType: (t.status && t.status.type) || '',
    priority: (t.priority && t.priority.priority) || null,
    due: ms(t.due_date),
    assignees: (t.assignees || []).map(a => ({ id: String(a.id), name: a.username || a.email || 'Someone', initials: a.initials || initials(a.username) })),
  };
}
/* Merge pages from every workspace into one list, each task once. */
function collect(pages) {
  const byId = new Map();
  for (const pg of pages) {
    for (const t of (pg.tasks || [])) {
      const id = String(t.id);
      if (!byId.has(id)) byId.set(id, normalize(t, pg.workspace));
    }
  }
  return [...byId.values()];
}

async function readAll(token, fetchImpl) {
  const me = (await cu(token, '/user', fetchImpl)).user || {};
  const teams = (await cu(token, '/team', fetchImpl)).teams || [];
  const pages = [];
  for (const team of teams) {
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
    tasks: collect(pages),
    fetchedAt: new Date().toISOString(),
  };
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
  r.get('/tasks', async (req, res) => {
    const token = personToken(req);
    if (!token) return res.status(401).json({ error: 'Connect ClickUp to see your tasks.', connect: true });
    const key = String((req.who && req.who.staffId) || '') + ':' + crypto.createHash('sha256').update(token).digest('hex');
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

module.exports = { homeRoutes, _internal: { collect, normalize, readAll, personToken } };
