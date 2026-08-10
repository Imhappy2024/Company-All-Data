const express = require('express');
const fetch = require('node-fetch');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const compression = require('compression');
const taskSync = require('./supabase-sync'); // gated: inert unless DATA_SOURCE=supabase
const supaProps = require('./supabase-properties'); // gated: Properties from Supabase when enabled
const db = require('./supabase-db'); // shared Supabase pg pool (same cached instance supaProps uses; not a new pool)

const app = express();
const PORT = process.env.PORT || 3000;
const CLICKUP_TOKEN = process.env.CLICKUP_API_TOKEN;
// LeavenWealth team. Override via CLICKUP_TEAM_ID env var if needed.
const TEAM_ID_OVERRIDE = process.env.CLICKUP_TEAM_ID || '9014303262';
const LIST_ID_FALLBACK = process.env.CLICKUP_LIST_ID || '901415877955';

// OAuth config
const OAUTH_CLIENT_ID = process.env.CLICKUP_OAUTH_CLIENT_ID || '';
const OAUTH_CLIENT_SECRET = process.env.CLICKUP_OAUTH_CLIENT_SECRET || '';
const ALLOWED_USERS = (process.env.CLICKUP_ALLOWED_USERS || '')
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const COOKIE_TOKEN = 'du_token';
const COOKIE_USER = 'du_user';
const COOKIE_MAX_AGE = 60 * 60 * 24 * 365; // 1 year

app.set('trust proxy', 1);
app.use(compression()); // gzip responses — cuts the ~5MB /api/tasks payload to ~500KB
app.use(cors());
app.use(express.json());
// Portal shell is the front door; the ops dashboard lives at /ops
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'portal.html')));
app.get('/ops', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.use(express.static(path.join(__dirname, 'public')));

let cachedTeamId = TEAM_ID_OVERRIDE;
let cachedTeams = null;

// In-memory cache of the full /api/tasks payload
const TASKS_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
let cachedTasksPayload = null;
let cachedTasksAt = 0;

async function clickup(endpoint, attempt = 0) {
  if (!CLICKUP_TOKEN) throw new Error('CLICKUP_API_TOKEN env variable not set');
  const res = await fetch(`https://api.clickup.com/api/v2${endpoint}`, {
    headers: { Authorization: CLICKUP_TOKEN, 'Content-Type': 'application/json' }
  });
  if (!res.ok) {
    // Retry on rate-limit (429) up to 3 times with exponential backoff so
    // we don't silently drop spaces during the workspace walk.
    if (res.status === 429 && attempt < 3) {
      const retryAfter = parseInt(res.headers.get('retry-after') || '1', 10);
      const waitMs = Math.max(retryAfter * 1000, 1000 * Math.pow(2, attempt));
      console.warn(`Rate limited on ${endpoint}, retry ${attempt + 1}/3 in ${waitMs}ms`);
      await new Promise(r => setTimeout(r, waitMs));
      return clickup(endpoint, attempt + 1);
    }
    const text = await res.text();
    throw new Error(`ClickUp ${res.status} ${endpoint}: ${text}`);
  }
  return res.json();
}

async function clickupWrite(method, endpoint, body) {
  if (!CLICKUP_TOKEN) throw new Error('CLICKUP_API_TOKEN env variable not set');
  const res = await fetch(`https://api.clickup.com/api/v2${endpoint}`, {
    method,
    headers: { Authorization: CLICKUP_TOKEN, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`ClickUp ${res.status} ${method} ${endpoint}: ${text}`);
  }
  return res.json();
}

// ----- Mappings (status + field) loaded from data/*.json -----
function loadJson(file, fallback) {
  try {
    const raw = fs.readFileSync(path.join(__dirname, 'data', file), 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    console.warn(`Could not load data/${file}, using fallback:`, e.message);
    return fallback;
  }
}

const statusMappings = loadJson('status-mappings.json', {});
const fieldMappings = loadJson('field-mappings.json', {});

// Normalize keys to lowercase once
const statusMappingsLower = Object.fromEntries(
  Object.entries(statusMappings).filter(([k]) => !k.startsWith('_')).map(([k, v]) => [k.toLowerCase().trim(), v])
);
const fieldMappingsLower = Object.fromEntries(
  Object.entries(fieldMappings).filter(([k]) => !k.startsWith('_')).map(([k, v]) => [k, (v || []).map(s => String(s).toLowerCase().trim())])
);

const unmappedStatusesSeen = new Set();
const seenFieldNames = new Set();

function mapStatusToCanonical(rawStatus, statusType) {
  if (!rawStatus) return 'To Do';
  const lc = String(rawStatus).toLowerCase().trim();

  // 1. Explicit mapping wins
  if (statusMappingsLower[lc]) return statusMappingsLower[lc];

  // 2. ClickUp's status.type for the unambiguous ends
  if (statusType === 'open') return 'To Do';
  if (statusType === 'closed') return 'Completed';

  // 3. Regex fallback (covers reasonably-named statuses)
  if (/^(to\s*do|todo|backlog|open|new|not started|pending)$/.test(lc)) return 'To Do';
  if (/in\s*progress|working|doing|active|started|wip|on track/.test(lc)) return 'In Progress';
  if (/blocked|stuck|on\s*hold|waiting|off\s*track/.test(lc)) return 'Blocked';
  if (/long.?term|parking|someday|future|deferred/.test(lc)) return 'Long Term';
  if (/review|qa|testing|approval/.test(lc)) return 'In Review';
  if (/done|complet|closed|finish|live|shipped|resolved|archived/.test(lc)) return 'Completed';

  // 4. Unknown — track for the admin endpoint
  unmappedStatusesSeen.add(rawStatus);
  return 'To Do';
}

// Identify the canonical concept (if any) a given field name represents.
// EXACT match only — partial matching produces false positives (e.g. "Insurance Team"
// would have wrongly mapped to the canonical "team" concept).
function fieldNameToCanonical(name) {
  if (!name) return null;
  const lc = String(name).toLowerCase().trim();
  for (const [canonical, aliases] of Object.entries(fieldMappingsLower)) {
    if (aliases.includes(lc)) return canonical;
  }
  return null;
}

// Resolve a custom field's raw value into a human-readable form.
// For dropdown/label fields, looks up the option names from type_config.options.
function resolveFieldValue(field) {
  if (!field || field.value == null) return null;
  // Array: multi-select / labels
  if (Array.isArray(field.value)) {
    return field.value.map(v => {
      if (v && typeof v === 'object') return v.label || v.name || null;
      const opt = field.type_config?.options?.find(o => o.id === v || o.orderindex === v);
      return opt?.label || opt?.name || null;
    }).filter(Boolean);
  }
  // Object: dropdown returned as object
  if (typeof field.value === 'object') {
    return field.value.name || field.value.label || null;
  }
  // String: dropdown returned as option id → look up
  if (typeof field.value === 'string') {
    const opt = field.type_config?.options?.find(o => o.id === field.value || o.orderindex === field.value);
    return opt?.name || opt?.label || field.value;
  }
  // Number: dropdown stored as an option orderindex (ClickUp does this for
  // values set in the UI) → map the orderindex to the option name.
  if (typeof field.value === 'number' && field.type_config?.options) {
    const opt = field.type_config.options.find(o => o.orderindex === field.value);
    if (opt) return opt.name || opt.label || field.value;
  }
  return field.value;
}

// Enrich a task with canonical_status + canonical_fields (resolved labels, not raw IDs)
function enrichTask(t) {
  t.canonical_status = mapStatusToCanonical(t.status?.status, t.status?.type);
  const canonicals = {};
  (t.custom_fields || []).forEach(f => {
    if (f?.name) seenFieldNames.add(f.name);
    const canonical = fieldNameToCanonical(f?.name);
    if (canonical && !canonicals[canonical]) {
      const resolved = resolveFieldValue(f);
      if (resolved != null && !(Array.isArray(resolved) && !resolved.length)) {
        canonicals[canonical] = resolved;
      }
    }
  });
  if (Object.keys(canonicals).length) t.canonical_fields = canonicals;
  return t;
}

// Per-list statuses cache (rarely changes)
const listStatusesCache = new Map();
async function getListStatuses(listId) {
  if (listStatusesCache.has(listId)) return listStatusesCache.get(listId);
  const data = await clickup(`/list/${listId}`);
  const statuses = data.statuses || [];
  listStatusesCache.set(listId, statuses);
  return statuses;
}

// Per-list members cache — these are the members who can be assigned in that list
// (and therefore in its space). Rarely changes.
const listMembersCache = new Map();
async function getListMembers(listId) {
  if (listMembersCache.has(listId)) return listMembersCache.get(listId);
  const data = await clickup(`/list/${listId}/member`);
  const members = (data.members || []).map(m => ({
    id: m.id,
    username: m.username || m.email || String(m.id),
    email: m.email || null,
    color: m.color || null,
  }));
  listMembersCache.set(listId, members);
  return members;
}

// Per-space members cache — aggregated unique members across all lists in a space.
// First call is slow (fetches all the space's lists then their members); subsequent
// calls are instant. Cleared if you push a new server build.
const spaceMembersCache = new Map();
async function getSpaceMembers(spaceId) {
  if (spaceMembersCache.has(spaceId)) return spaceMembersCache.get(spaceId);
  // Discover every list in the space (including empty ones, via the API).
  const listIds = new Set();
  // From cached tasks (covers active lists)
  if (cachedTasksPayload?.tasks) {
    cachedTasksPayload.tasks.forEach(t => {
      if (String(t.space?.id) === String(spaceId) && t.list?.id) {
        listIds.add(String(t.list.id));
      }
    });
  }
  // From API (covers empty lists too)
  try {
    const folderlessData = await clickup(`/space/${spaceId}/list?archived=false`);
    (folderlessData.lists || []).forEach(l => listIds.add(String(l.id)));
    const folderData = await clickup(`/space/${spaceId}/folder?archived=false`);
    for (const folder of (folderData.folders || [])) {
      try {
        const fLists = await clickup(`/folder/${folder.id}/list?archived=false`);
        (fLists.lists || []).forEach(l => listIds.add(String(l.id)));
      } catch (e) { /* skip */ }
    }
  } catch (e) { console.warn(`getSpaceMembers space ${spaceId}: list fetch failed:`, e.message); }

  // Fetch members for each list, throttled
  const memberMap = new Map();
  await runConcurrent([...listIds], 3, async (listId) => {
    try {
      const members = await getListMembers(listId);
      members.forEach(m => {
        if (m?.id != null && !memberMap.has(m.id)) memberMap.set(m.id, m);
      });
    } catch (e) { /* skip */ }
  });
  const result = [...memberMap.values()];
  spaceMembersCache.set(spaceId, result);
  return result;
}

async function getTeams() {
  if (cachedTeams) return cachedTeams;
  const data = await clickup('/team');
  cachedTeams = data.teams || [];
  if (!cachedTeams.length) throw new Error('No teams accessible with this token');
  if (!cachedTeamId) {
    cachedTeamId = cachedTeams[0].id;
    console.log(`Resolved team_id: ${cachedTeamId} (${cachedTeams[0].name})`);
  }
  return cachedTeams;
}

async function fetchAllListTasks(listId, { archivedOnly = false } = {}) {
  let page = 0;
  let allTasks = [];
  while (true) {
    const archivedParam = archivedOnly ? '&archived=true' : '';
    const data = await clickup(
      `/list/${listId}/task?page=${page}&include_closed=true&subtasks=true&order_by=due_date${archivedParam}`
    );
    const batch = data.tasks || [];
    allTasks = allTasks.concat(batch);
    if (data.last_page) break;
    page++;
    if (page > 30) break;
  }
  return allTasks.map(enrichTask);
}

// List IDs whose archived tasks we ALSO want to pull in (e.g., the Wins list).
const ARCHIVED_FETCH_LIST_IDS = ['901403327501'];

// Run an array of async tasks with a concurrency cap (avoid ClickUp's
// 100-req/min rate limit and prevent silent drops of slower spaces).
async function runConcurrent(items, limit, fn) {
  const results = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      try { results[idx] = await fn(items[idx], idx); }
      catch (e) { results[idx] = { __error: e }; }
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, worker);
  await Promise.all(workers);
  return results;
}

// Stash of discovered spaces from the most recent walk (used by /api/tasks
// to surface empty spaces in the Space filter even when they have no tasks).
let lastDiscoveredSpaces = [];

// Walk the workspace: spaces → (folders → lists) + folderless lists.
// Sequential per-space (or low concurrency) to avoid rate-limit drops that
// would silently lose a whole space's data.
async function discoverLists(teamId) {
  const spacesData = await clickup(`/team/${teamId}/space?archived=false`);
  const spaces = spacesData.spaces || [];
  lastDiscoveredSpaces = spaces.map(s => ({ id: s.id, name: s.name }));
  console.log(`Discovered ${spaces.length} active space(s): ${spaces.map(s => s.name).join(', ')}`);
  const lists = [];

  // Process spaces with low concurrency (3) — slow but reliable
  await runConcurrent(spaces, 3, async (space) => {
    const spaceMeta = { id: space.id, name: space.name };
    let folderlessCount = 0;
    let folderListCount = 0;

    try {
      const flData = await clickup(`/space/${space.id}/list?archived=false`);
      (flData.lists || []).forEach(l => {
        lists.push({ id: l.id, name: l.name, space: spaceMeta, folder: null });
        folderlessCount++;
      });
    } catch (e) { console.warn(`Space "${space.name}": folderless lists failed:`, e.message); }

    try {
      const folderData = await clickup(`/space/${space.id}/folder?archived=false`);
      const folders = folderData.folders || [];
      await runConcurrent(folders, 3, async (folder) => {
        const folderMeta = { id: folder.id, name: folder.name };
        try {
          const fLists = await clickup(`/folder/${folder.id}/list?archived=false`);
          (fLists.lists || []).forEach(l => {
            lists.push({ id: l.id, name: l.name, space: spaceMeta, folder: folderMeta });
            folderListCount++;
          });
        } catch (e) { console.warn(`Folder "${folder.name}" in "${space.name}": lists failed:`, e.message); }
      });
    } catch (e) { console.warn(`Space "${space.name}": folders failed:`, e.message); }

    console.log(`  Space "${space.name}": ${folderlessCount} folderless lists + ${folderListCount} in folders`);
  });

  console.log(`Workspace walk complete: ${lists.length} lists total`);
  return lists;
}

async function fetchAllWorkspaceTasks(teamId) {
  const lists = await discoverLists(teamId);
  console.log(`Discovered ${lists.length} lists across workspace`);

  // Fetch tasks per list (parallel, but cap concurrency to be polite to API)
  const CONCURRENCY = 5;
  const allBatches = [];
  for (let i = 0; i < lists.length; i += CONCURRENCY) {
    const slice = lists.slice(i, i + CONCURRENCY);
    const batches = await Promise.all(slice.map(async list => {
      try {
        const tasks = await fetchAllListTasks(list.id);
        return tasks.map(t => ({
          ...t,
          // Enrich with NAME, not just id
          space: { id: list.space.id, name: list.space.name },
          folder: list.folder ? { id: list.folder.id, name: list.folder.name } : (t.folder || null),
          list: t.list || { id: list.id, name: list.name },
        }));
      } catch (e) {
        console.warn(`List ${list.name} (${list.id}) failed:`, e.message);
        return [];
      }
    }));
    allBatches.push(...batches);
  }

  // Additionally fetch ARCHIVED tasks for designated lists (the Wins source).
  for (const listId of ARCHIVED_FETCH_LIST_IDS) {
    const meta = lists.find(l => String(l.id) === String(listId));
    if (!meta) continue;
    try {
      const archived = await fetchAllListTasks(meta.id, { archivedOnly: true });
      const enrichedArchived = archived.map(t => ({
        ...t,
        space: { id: meta.space.id, name: meta.space.name },
        folder: meta.folder ? { id: meta.folder.id, name: meta.folder.name } : (t.folder || null),
        list: t.list || { id: meta.id, name: meta.name },
      }));
      allBatches.push(enrichedArchived);
      console.log(`Archived fetch for ${meta.name}: +${enrichedArchived.length} tasks`);
    } catch (e) {
      console.warn(`Archived fetch failed for ${listId}:`, e.message);
    }
  }

  const all = allBatches.flat();
  // Dedupe by task id, then enrich with canonical fields/status
  const deduped = [...new Map(all.map(t => [t.id, t])).values()];
  return deduped;
}

function extractMembersFromTeams(teams, teamId) {
  const team = teams.find(t => t.id === teamId) || teams[0];
  if (!team?.members) return [];
  return team.members
    .map(m => m.user)
    .filter(u => u && u.id)
    .map(u => ({
      id: u.id,
      username: u.username || u.email || String(u.id),
      email: u.email || null,
    }));
}

let refreshInProgress = false;
let inProgressPromise = null;
let lastRefreshError = null;

// Single source of truth for refreshing the task cache. If a refresh is already
// running, all callers share the same in-flight promise — no duplicate workspace
// walks even if scheduled + manual + post-write all fire concurrently.
async function refreshTasksCache() {
  if (inProgressPromise) return inProgressPromise;

  refreshInProgress = true;
  console.log('Refresh starting...');
  inProgressPromise = (async () => {
    try {
      const teams = await getTeams();
      const teamId = cachedTeamId;
      const members = extractMembersFromTeams(teams, teamId);

      let tasks = [];
      let mode = 'workspace';
      try {
        tasks = await fetchAllWorkspaceTasks(teamId);
        console.log(`Workspace fetch: ${tasks.length} tasks`);
      } catch (e) {
        console.warn('Workspace walk failed, falling back to single list:', e.message);
        mode = 'list';
      }
      if (!tasks.length) {
        tasks = await fetchAllListTasks(LIST_ID_FALLBACK);
        mode = 'list';
        console.log(`List fallback: ${tasks.length} tasks`);
      }

      cachedTasksPayload = {
        tasks,
        members,
        spaces: lastDiscoveredSpaces, // every workspace space (including empty ones)
        fetched_at: new Date().toISOString(),
        team_id: teamId,
        mode,
        count: tasks.length,
      };
      cachedTasksAt = Date.now();
      lastRefreshError = null;
      console.log(`Refresh complete: ${tasks.length} tasks`);
      return cachedTasksPayload;
    } catch (e) {
      lastRefreshError = e.message;
      console.error('Refresh failed:', e.message);
      throw e;
    } finally {
      refreshInProgress = false;
      inProgressPromise = null;
    }
  })();

  return inProgressPromise;
}

function triggerBackgroundRefresh() {
  refreshTasksCache().catch(() => { /* logged inside */ });
}

// ----- Scheduled refresh at 8 AM & 12 PM Central (America/Chicago) -----
// Fires server-side even when no browser has the dashboard open, so the ClickUp
// task cache (and the two-way ClickUp <-> Supabase task sync) refresh twice a day
// regardless. Open dashboards refresh at the same times (see scheduleAutoRefresh
// in public/index.html).
const REFRESH_TARGETS_CENTRAL = [8 * 3600, 12 * 3600]; // 08:00 and 12:00, seconds-into-day
function msUntilNextScheduledRefreshCentral() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  }).formatToParts(new Date());
  let chHour = parseInt(parts.find(p => p.type === 'hour').value, 10);
  if (chHour === 24) chHour = 0;
  const chMin = parseInt(parts.find(p => p.type === 'minute').value, 10);
  const chSec = parseInt(parts.find(p => p.type === 'second').value, 10);
  const secondsNow = chHour * 3600 + chMin * 60 + chSec;
  for (const t of REFRESH_TARGETS_CENTRAL) if (t > secondsNow) return (t - secondsNow) * 1000;
  return ((86400 - secondsNow) + REFRESH_TARGETS_CENTRAL[0]) * 1000; // wrap to tomorrow 08:00
}

let dailyRefreshTimer = null;
function scheduleDailyRefresh() {
  if (dailyRefreshTimer) clearTimeout(dailyRefreshTimer);
  const ms = msUntilNextScheduledRefreshCentral();
  const hours = (ms / 3600000).toFixed(1);
  console.log(`Scheduled refresh in ${hours} h (next 8 AM / 12 PM CT)`);
  dailyRefreshTimer = setTimeout(async () => {
    console.log('=== Scheduled 8AM/12PM CT refresh firing ===');
    try {
      await refreshTasksCache();
      console.log('=== Scheduled refresh complete ===');
    } catch (e) {
      console.error('Scheduled refresh failed:', e.message);
    }
    // Two-way ClickUp <-> Supabase task sync on the same schedule.
    if (taskSync.enabled) {
      try { await taskSync.runSync(); }
      catch (e) { console.error('Scheduled task sync failed:', e.message); }
    }
    scheduleDailyRefresh(); // reschedule for the next target (8 AM or 12 PM)
  }, ms);
}

app.get('/api/tasks', async (req, res) => {
  const force = req.query.force === '1';
  const cacheAge = Date.now() - cachedTasksAt;
  const cacheStale = cacheAge > TASKS_CACHE_TTL_MS;

  // Stale-while-revalidate: if we have any cache, return it immediately.
  // Refresh in the background if it's stale or the user forced.
  if (cachedTasksPayload && !force) {
    if (cacheStale) triggerBackgroundRefresh();
    return res.json({
      ...cachedTasksPayload,
      from_cache: true,
      cache_age_ms: cacheAge,
      refreshing: cacheStale,
    });
  }

  // No cache OR force=1: do the full fetch synchronously.
  try {
    const payload = await refreshTasksCache();
    res.json({ ...payload, from_cache: false });
  } catch (err) {
    console.error('Sync fetch failed:', err.message);
    // If we have ANY cached payload, return it as a fallback even if forced
    if (cachedTasksPayload) {
      return res.json({
        ...cachedTasksPayload,
        from_cache: true,
        cache_age_ms: cacheAge,
        error: err.message,
      });
    }
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/health', (req, res) => {
  const cacheAgeMs = cachedTasksAt ? Date.now() - cachedTasksAt : null;
  res.json({
    status: 'ok',
    configured: !!CLICKUP_TOKEN,
    team_id: cachedTeamId,
    list_id_fallback: LIST_ID_FALLBACK,
    cache_age_ms: cacheAgeMs,
    cache_count: cachedTasksPayload?.count ?? 0,
  });
});

// ===================== OAUTH (per-user identity) =====================
function parseCookies(req) {
  const out = {};
  const header = req.headers.cookie;
  if (!header) return out;
  header.split(';').forEach(c => {
    const idx = c.indexOf('=');
    if (idx > 0) {
      const k = c.slice(0, idx).trim();
      const v = c.slice(idx + 1).trim();
      try { out[k] = decodeURIComponent(v); } catch { out[k] = v; }
    }
  });
  return out;
}

function getBaseUrl(req) {
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}`;
}

function setAuthCookies(res, token, user) {
  const userJson = JSON.stringify({ id: user.id, username: user.username, email: user.email });
  // SameSite=None lets the cookie work when the dashboard is loaded inside a ClickUp iframe.
  // Requires Secure (HTTPS only) — Railway terminates TLS at the edge so this is fine.
  res.setHeader('Set-Cookie', [
    `${COOKIE_TOKEN}=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=${COOKIE_MAX_AGE}`,
    `${COOKIE_USER}=${encodeURIComponent(userJson)}; Path=/; Secure; SameSite=None; Max-Age=${COOKIE_MAX_AGE}`,
  ]);
}

function clearAuthCookies(res) {
  res.setHeader('Set-Cookie', [
    `${COOKIE_TOKEN}=; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=0`,
    `${COOKIE_USER}=; Path=/; Secure; SameSite=None; Max-Age=0`,
  ]);
}

function getAuth(req) {
  // 1. Prefer the Authorization header (frontend sends it from localStorage —
  //    works when the dashboard is in an iframe and cookies are blocked).
  const headerToken = req.headers['x-clickup-token'];
  if (headerToken) {
    let user = null;
    const userHeader = req.headers['x-clickup-user'];
    if (userHeader) {
      try { user = JSON.parse(decodeURIComponent(userHeader)); } catch {}
    }
    return { token: headerToken, user };
  }
  // 2. Fall back to cookies (works in top-level browser contexts).
  const cookies = parseCookies(req);
  const token = cookies[COOKIE_TOKEN];
  if (!token) return null;
  let user = null;
  try { user = cookies[COOKIE_USER] ? JSON.parse(cookies[COOKIE_USER]) : null; } catch {}
  return { token, user };
}

function requireAuth(req, res) {
  const auth = getAuth(req);
  if (!auth) {
    res.status(401).json({ error: 'Not authenticated. Sign in with ClickUp first.' });
    return null;
  }
  return auth;
}

async function clickupWriteWithToken(token, method, endpoint, body) {
  const res = await fetch(`https://api.clickup.com/api/v2${endpoint}`, {
    method,
    headers: { Authorization: token, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`ClickUp ${res.status} ${method} ${endpoint}: ${text}`);
  }
  return res.json();
}

// Debug: shows what redirect_uri the server is sending to ClickUp.
// Open this in the browser to verify it matches what you registered in ClickUp.
app.get('/auth/debug', (req, res) => {
  const redirect = `${getBaseUrl(req)}/auth/callback`;
  res.json({
    oauth_client_id_set: !!OAUTH_CLIENT_ID,
    oauth_client_secret_set: !!OAUTH_CLIENT_SECRET,
    allowed_users_count: ALLOWED_USERS.length,
    allowed_users_preview: ALLOWED_USERS.slice(0, 3),
    computed_redirect_uri: redirect,
    base_url: getBaseUrl(req),
    auth_url_that_would_be_used: OAUTH_CLIENT_ID
      ? `https://app.clickup.com/api?client_id=${encodeURIComponent(OAUTH_CLIENT_ID)}&redirect_uri=${encodeURIComponent(redirect)}`
      : null,
    forwarded_proto: req.headers['x-forwarded-proto'] || null,
    forwarded_host: req.headers['x-forwarded-host'] || null,
    host_header: req.headers.host || null,
  });
});

// Kick off the OAuth flow
app.get('/auth/clickup', (req, res) => {
  if (!OAUTH_CLIENT_ID) {
    return res.status(500).send('OAuth not configured. CLICKUP_OAUTH_CLIENT_ID missing.');
  }
  const redirect = `${getBaseUrl(req)}/auth/callback`;
  const url = `https://app.clickup.com/api?client_id=${encodeURIComponent(OAUTH_CLIENT_ID)}&redirect_uri=${encodeURIComponent(redirect)}`;
  res.redirect(url);
});

// OAuth callback — exchange code for access token, fetch user, set cookie
app.get('/auth/callback', async (req, res) => {
  const code = req.query.code;
  if (!code) return res.status(400).send('Missing OAuth code.');
  if (!OAUTH_CLIENT_ID || !OAUTH_CLIENT_SECRET) {
    return res.status(500).send('OAuth not configured.');
  }
  try {
    // 1. Exchange code for access token
    const tokenRes = await fetch('https://api.clickup.com/api/v2/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: OAUTH_CLIENT_ID,
        client_secret: OAUTH_CLIENT_SECRET,
        code,
      }),
    });
    if (!tokenRes.ok) {
      const t = await tokenRes.text();
      console.error('Token exchange failed:', t);
      return res.status(500).send(`OAuth token exchange failed: ${t}`);
    }
    const tokenData = await tokenRes.json();
    const accessToken = tokenData.access_token;
    if (!accessToken) return res.status(500).send('No access_token in response');

    // 2. Fetch user info
    const userRes = await fetch('https://api.clickup.com/api/v2/user', {
      headers: { Authorization: accessToken },
    });
    if (!userRes.ok) {
      return res.status(500).send('Could not fetch user info from ClickUp');
    }
    const userPayload = await userRes.json();
    const user = userPayload.user;
    if (!user) return res.status(500).send('Malformed user response');

    // 3. Enforce allowlist (if configured)
    if (ALLOWED_USERS.length) {
      const ok = ALLOWED_USERS.includes(String(user.email || '').toLowerCase())
              || ALLOWED_USERS.includes(String(user.id))
              || ALLOWED_USERS.includes(String(user.username || '').toLowerCase());
      if (!ok) {
        return res.status(403).send(`Access denied. <strong>${user.email || user.username}</strong> is not in the allowed users list. <a href="/">Back</a>`);
      }
    }

    // 4. Set cookie (works in top-level contexts) AND embed token in URL fragment
    //    (works inside ClickUp iframes where third-party cookies are blocked).
    setAuthCookies(res, accessToken, user);
    const userJson = JSON.stringify({ id: user.id, username: user.username, email: user.email });
    const payload = Buffer.from(JSON.stringify({ token: accessToken, user: JSON.parse(userJson) })).toString('base64url');
    console.log(`OAuth success: ${user.username || user.email} (id ${user.id})`);
    // Return to the ops app (`/ops`), which has the #auth fragment capture. The
    // portal (`/`) doesn't handle the ClickUp token. When sign-in was launched in
    // a popup, /ops self-closes it after storing the token (see captureAuthFromUrl).
    res.redirect(`/ops#auth=${payload}`);
  } catch (e) {
    console.error('OAuth callback error:', e);
    res.status(500).send('Auth failed: ' + e.message);
  }
});

// Who am I? — frontend calls this on load to decide whether to show login UI
app.get('/auth/me', (req, res) => {
  const auth = getAuth(req);
  if (!auth) return res.status(401).json({ error: 'Not authenticated' });
  res.json({ user: auth.user, oauth_configured: !!OAUTH_CLIENT_ID });
});

app.post('/auth/logout', (req, res) => {
  clearAuthCookies(res);
  res.json({ ok: true });
});

// Debug: what spaces / folders / lists is the workspace walk actually finding?
// Compare this against the ClickUp UI to identify what's being missed.
app.get('/api/debug/structure', async (req, res) => {
  try {
    await getTeams(); // populates cachedTeamId
    const teamId = cachedTeamId;
    // Raw spaces (no archive filter, in case archived=false is hiding things)
    const allSpacesData = await clickup(`/team/${teamId}/space?archived=false`);
    const archivedSpacesData = await clickup(`/team/${teamId}/space?archived=true`);
    const lists = await discoverLists(teamId);
    // Group discovered lists by space for the report
    const bySpace = {};
    lists.forEach(l => {
      const key = l.space.name + ' (' + l.space.id + ')';
      if (!bySpace[key]) bySpace[key] = [];
      bySpace[key].push({
        list_id: l.id,
        list_name: l.name,
        folder: l.folder?.name || null,
      });
    });
    // Per-space task counts from current cache
    const counts = {};
    if (cachedTasksPayload?.tasks) {
      cachedTasksPayload.tasks.forEach(t => {
        const key = (t.space?.name || 'Unknown') + ' (' + (t.space?.id || '?') + ')';
        counts[key] = (counts[key] || 0) + 1;
      });
    }
    res.json({
      team_id: teamId,
      active_spaces: (allSpacesData.spaces || []).map(s => ({ id: s.id, name: s.name, private: s.private })),
      archived_spaces: (archivedSpacesData.spaces || []).map(s => ({ id: s.id, name: s.name })),
      discovered_lists_total: lists.length,
      discovered_lists_by_space: bySpace,
      task_counts_by_space: counts,
      cache_age_ms: cachedTasksAt ? Date.now() - cachedTasksAt : null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin: view current mappings
app.get('/api/mappings', (req, res) => {
  res.json({
    statuses: statusMappings,
    fields: fieldMappings,
  });
});

// Admin: see status names that fell through the mapping (need an entry)
app.get('/api/unmapped-statuses', (req, res) => {
  res.json({
    unmapped: [...unmappedStatusesSeen].sort(),
    count: unmappedStatusesSeen.size,
  });
});

// Admin: see every custom field name encountered across the workspace
app.get('/api/seen-fields', (req, res) => {
  res.json({
    fields: [...seenFieldNames].sort(),
    count: seenFieldNames.size,
  });
});

// GET valid statuses for a list (used to populate inline status dropdown)
app.get('/api/list/:id/statuses', async (req, res) => {
  try {
    const statuses = await getListStatuses(req.params.id);
    res.json({ statuses });
  } catch (err) {
    console.error('list statuses:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET members assignable to tasks in this list (scoped to the list's space)
app.get('/api/list/:id/members', async (req, res) => {
  try {
    const members = await getListMembers(req.params.id);
    res.json({ members });
  } catch (err) {
    console.error('list members:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET members of a space (aggregated across all the space's lists).
// Used by the dashboard's Space filter to narrow the Assignee filter.
app.get('/api/space/:id/members', async (req, res) => {
  try {
    const members = await getSpaceMembers(req.params.id);
    res.json({ members });
  } catch (err) {
    console.error('space members:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Update a task (status, due_date, assignees, name, etc.) — uses authed user's token
app.put('/api/task/:id', async (req, res) => {
  const auth = requireAuth(req, res); if (!auth) return;
  try {
    const result = await clickupWriteWithToken(auth.token, 'PUT', `/task/${req.params.id}`, req.body || {});
    cachedTasksAt = 0;
    res.json(result);
  } catch (err) {
    console.error('task update:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Delete a task — uses authed user's token
app.delete('/api/task/:id', async (req, res) => {
  const auth = requireAuth(req, res); if (!auth) return;
  try {
    const result = await clickupWriteWithToken(auth.token, 'DELETE', `/task/${req.params.id}`, null);
    cachedTasksAt = 0;
    res.json(result || { ok: true });
  } catch (err) {
    console.error('task delete:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Get task comments (uses shared token; reads only)
app.get('/api/task/:id/comments', async (req, res) => {
  try {
    const data = await clickup(`/task/${req.params.id}/comment`);
    res.json(data);
  } catch (err) {
    console.error('task comments:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Post a new comment — uses authed user's token (ClickUp attributes comment to them)
app.post('/api/task/:id/comment', async (req, res) => {
  const auth = requireAuth(req, res); if (!auth) return;
  try {
    const body = {
      comment_text: req.body?.comment_text || '',
      notify_all: !!req.body?.notify_all,
    };
    const result = await clickupWriteWithToken(auth.token, 'POST', `/task/${req.params.id}/comment`, body);
    res.json(result);
  } catch (err) {
    console.error('post comment:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ===================== PROPERTIES VIEW (isolated, lazily cached) =====================
// ACCESS-MODEL NOTE: like the rest of this dashboard, /api/properties and /api/loans
// are served with the SHARED read token. That means ALL property + loan financials are
// visible to anyone who can load the page. Writes use the logged-in user's token.
// Locking down read access (per-user scoping) is a known limitation — access model TBD.
const PROPERTIES_SPACE_ID = '90142742038';
const LOAN_DATA_FOLDER_ID = '90147274220';
const LOAN_DATA_FOLDER_NAME = '001 - loan data';
const DATA_TEMPLATE_FOLDER_NAME = '000 - data template';
const LOANS_FIELD_ID = '23b9b541-c356-44a5-944f-7ba9d31317d1';
const LOAN_STATUS_FIELD_ID = '18b9b1ce-6d7c-4a10-9bfe-4c6a57cd5a28';
const LOAN_STATUS_OPT_NONE = '04957d5e-05b6-45d7-afe4-2973ce44bb9f';
const PROPERTY_TASKS_LIST_ID = '901417444379'; // "Tasks and Projects" list (Kanban)
const PROJECT_NAME_ITEM_ID = 1001; // ClickUp custom task type for property records
const PROPERTIES_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
// Custom-field ids on the Tasks-and-Projects list (used by the Supabase sync).
const PT_PROPERTY_FIELD_ID = '947b1989-be4e-46d3-82de-ee77412defa4'; // "Property" relationship
const PT_CATEGORY_FIELD_ID = '844789da-24f9-4c74-9281-4a85dd0dd5a4'; // "Category" dropdown

// Wire the (gated) Supabase task-sync module with the ClickUp helpers it needs.
taskSync.init({
  clickup, clickupWriteWithToken, fetchAllListTasks, getListStatuses,
  serviceToken: CLICKUP_TOKEN,
  PROPERTY_TASKS_LIST_ID, PROPERTY_FIELD_ID: PT_PROPERTY_FIELD_ID, CATEGORY_FIELD_ID: PT_CATEGORY_FIELD_ID,
});
if (taskSync.enabled) console.log('Supabase task sync ENABLED (DATA_SOURCE=supabase).');

let cachedPropertiesPayload = null;
let cachedPropertiesAt = 0;
let propertiesInFlight = null;
let cachedLoansById = new Map();
let cachedLoansAt = 0;
let loansInFlight = null;

// Field names are the stable key across lists (ids drift). Normalize:
// trim, lowercase, collapse internal whitespace (handles "TIV  (Total Insured Value)").
const normPropField = s => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();

function buildPropFieldObj(f) {
  return {
    id: f.id,
    name: f.name,
    type: f.type,
    value: f.value ?? null,
    display: resolveFieldValue(f),
    options: (f.type === 'drop_down' && f.type_config && f.type_config.options)
      ? f.type_config.options.map(o => ({ id: o.id, name: o.name, orderindex: o.orderindex }))
      : undefined,
  };
}
// Resolve a task's custom fields into a name-keyed map, merging duplicate names
// (prefer the variant that actually carries a value).
function propFieldsToMap(customFields) {
  const map = {};
  (customFields || []).forEach(f => {
    if (!f || !f.name) return;
    const key = normPropField(f.name);
    if (!map[key] || (map[key].value == null && f.value != null)) map[key] = buildPropFieldObj(f);
  });
  return map;
}
function propFieldsDataCount(map) {
  let n = 0;
  for (const k of Object.keys(map)) {
    const d = map[k].display;
    if (d != null && d !== '' && !(Array.isArray(d) && !d.length)) n++;
  }
  return n;
}
// Building / structure sub-records (vs the primary property record). Naming
// conventions seen in the data: "{Property} - Building 8", "{Property} - Building 8 (Garage)",
// "{Property} (Garage)", "Garage 2", "Shed". The parent property record never
// ends with one of these suffixes.
function isBuildingTask(name) {
  const n = String(name || '').trim();
  return /\((garage|shed)\)\s*$/i.test(n)        // "… (Garage)"
    || /\b(garage|shed)\s*\d*\s*$/i.test(n)      // "… Garage", "… Shed 2"
    || /\bbuilding\s+\d+\s*(\(.*\))?\s*$/i.test(n) // "… Building 8", "… Building 8 (Garage)"
    || /\b(bldg|unit)\s+\d+\s*$/i.test(n);        // "… Bldg 3", "… Unit 4"
}
function isPropertyRecord(t) {
  return t.custom_item_id === PROJECT_NAME_ITEM_ID
    || t.task_type === 'Project Name' || t.custom_type === 'Project Name';
}
// Strip a trailing building/structure suffix to recover the parent property name,
// e.g. "Foo, LLC dba Foo - Building 8 (Garage)" -> "Foo, LLC dba Foo".
function stripBuildingSuffix(name) {
  const out = String(name || '')
    .replace(/\s+[-–]\s+building\s+\d+\s*(\(.*\))?\s*$/i, '')
    .replace(/\s+[-–]\s+(bldg|unit)\s+\d+\s*$/i, '')
    .replace(/\s*\((garage|shed)\)\s*$/i, '')
    .replace(/\s+(garage|shed)\s*\d*\s*$/i, '')
    .trim();
  return out || String(name || '');
}

// Walk only the 001 - Loan Data folder; cache every loan task by id so
// /api/properties can hydrate the "Loans" relationship links.
async function buildLoansCache() {
  if (loansInFlight) return loansInFlight;
  loansInFlight = (async () => {
    const byId = new Map();
    try {
      const fLists = await clickup(`/folder/${LOAN_DATA_FOLDER_ID}/list?archived=false`);
      const lists = fLists.lists || [];
      await runConcurrent(lists, 4, async (list) => {
        try {
          const data = await clickup(`/list/${list.id}/task?include_closed=true&subtasks=true`);
          (data.tasks || []).forEach(t => {
            const fields = propFieldsToMap(t.custom_fields);
            byId.set(String(t.id), {
              id: String(t.id), name: t.name,
              url: t.url || `https://app.clickup.com/t/${t.id}`,
              listName: list.name, fields, dataCount: propFieldsDataCount(fields),
            });
          });
        } catch (e) { console.warn(`Loan list ${list.name} failed:`, e.message); }
      });
    } catch (e) { console.warn('buildLoansCache failed:', e.message); }
    cachedLoansById = byId;
    cachedLoansAt = Date.now();
    console.log(`Loans cache built: ${byId.size} loan tasks`);
    return byId;
  })();
  loansInFlight.finally(() => { loansInFlight = null; });
  return loansInFlight;
}

async function buildPropertiesCache() {
  if (propertiesInFlight) return propertiesInFlight;
  propertiesInFlight = (async () => {
    await buildLoansCache();
    const entities = [];
    const folderData = await clickup(`/space/${PROPERTIES_SPACE_ID}/folder?archived=false`);
    const folders = (folderData.folders || []).filter(f =>
      String(f.id) !== LOAN_DATA_FOLDER_ID &&
      normPropField(f.name) !== DATA_TEMPLATE_FOLDER_NAME &&
      normPropField(f.name) !== LOAN_DATA_FOLDER_NAME
    );
    await runConcurrent(folders, 3, async (folder) => {
      const properties = [];
      let lists = [];
      try { lists = (await clickup(`/folder/${folder.id}/list?archived=false`)).lists || []; }
      catch (e) { console.warn(`Folder ${folder.name} lists failed:`, e.message); return; }
      await runConcurrent(lists, 4, async (list) => {
        let tasks = [];
        try { tasks = (await clickup(`/list/${list.id}/task?include_closed=true&subtasks=true`)).tasks || []; }
        catch (e) { console.warn(`Property list ${list.name} failed:`, e.message); return; }
        // Keep only property records (custom task type); drop work tasks (null type).
        const records = tasks.filter(isPropertyRecord);
        if (!records.length) return;
        const mains = records.filter(t => !isBuildingTask(t.name));
        let primary, displayName, buildingRecords;
        if (mains.length) {
          // A real top-level property record exists; the rest are its structures.
          primary = mains[0];
          displayName = primary.name;
          buildingRecords = records.filter(t => String(t.id) !== String(primary.id));
        } else {
          // Every record is a building/structure (e.g. "{Property} - Building N").
          // The property IS the whole set: use the shared parent name, carry
          // fields from the first record, and list ALL records as buildings.
          primary = records[0];
          displayName = stripBuildingSuffix(primary.name);
          buildingRecords = records;
        }
        const buildings = buildingRecords.map(t => ({ id: String(t.id), name: t.name }));
        const fields = propFieldsToMap(primary.custom_fields);
        const lsf = fields[normPropField('Loan Status')];
        const loanStatus = lsf ? (Array.isArray(lsf.display) ? lsf.display[0] : lsf.display) : null;

        // Hydrate linked loan(s) via the relationship field.
        const loanField = (primary.custom_fields || []).find(f => f.id === LOANS_FIELD_ID);
        const linkedIds = [];
        if (loanField && Array.isArray(loanField.value)) {
          loanField.value.forEach(v => {
            const id = v && typeof v === 'object' ? v.id : v;
            if (id) linkedIds.push(String(id));
          });
        }
        const loans = [];
        for (const lid of linkedIds) {
          let loan = cachedLoansById.get(String(lid));
          if (!loan) {
            try {
              const lt = await clickup(`/task/${lid}`);
              const lf = propFieldsToMap(lt.custom_fields);
              loan = { id: String(lt.id), name: lt.name, url: lt.url, fields: lf, dataCount: propFieldsDataCount(lf) };
            } catch (e) { loan = { id: String(lid), name: `Loan ${lid}`, url: '', fields: {}, dataCount: 0 }; }
          }
          loans.push({ id: loan.id, name: loan.name, url: loan.url, fields: loan.fields, hasData: loan.dataCount >= 3 });
        }

        properties.push({
          listId: String(list.id), taskId: String(primary.id), name: displayName,
          url: primary.url || `https://app.clickup.com/t/${primary.id}`,
          fields, loanStatus: loanStatus || null, loans, buildings,
        });
      });
      if (properties.length) {
        properties.sort((a, b) => String(a.name).localeCompare(String(b.name)));
        entities.push({ id: String(folder.id), name: folder.name, properties });
      }
    });
    entities.sort((a, b) => String(a.name).localeCompare(String(b.name)));
    cachedPropertiesPayload = { generatedAt: new Date().toISOString(), entities };
    cachedPropertiesAt = Date.now();
    const total = entities.reduce((s, e) => s + e.properties.length, 0);
    console.log(`Properties cache built: ${entities.length} entities, ${total} properties`);
    return cachedPropertiesPayload;
  })();
  propertiesInFlight.finally(() => { propertiesInFlight = null; });
  return propertiesInFlight;
}

function patchCachedPropertyField(taskId, fieldId, value) {
  if (!cachedPropertiesPayload) return;
  for (const ent of cachedPropertiesPayload.entities) {
    for (const p of ent.properties) {
      if (String(p.taskId) !== String(taskId)) continue;
      for (const k of Object.keys(p.fields)) {
        const f = p.fields[k];
        if (f.id !== fieldId) continue;
        f.value = value;
        if (f.type === 'drop_down' && f.options) {
          const opt = f.options.find(o => o.id === value || o.orderindex === value);
          f.display = opt ? opt.name : value;
          if (k === normPropField('Loan Status')) p.loanStatus = f.display;
        } else {
          f.display = value;
        }
        return;
      }
    }
  }
}

// Master grid of property records (entity > property > record), built on first
// request and cached 6h with stale-while-revalidate. NOT pre-warmed on boot.
app.get('/api/properties', async (req, res) => {
  if (supaProps.enabled) {
    try { return res.json({ ...(await supaProps.getPropertiesPayload()), from_cache: false }); }
    catch (err) { console.error('supabase properties read failed:', err.message); return res.status(500).json({ error: err.message }); }
  }
  const force = req.query.force === '1';
  const age = Date.now() - cachedPropertiesAt;
  if (cachedPropertiesPayload && !force) {
    if (age > PROPERTIES_TTL_MS) buildPropertiesCache().catch(() => {});
    return res.json({ ...cachedPropertiesPayload, from_cache: true, cache_age_ms: age });
  }
  try {
    const payload = await buildPropertiesCache();
    res.json({ ...payload, from_cache: false });
  } catch (err) {
    console.error('properties build failed:', err.message);
    if (cachedPropertiesPayload) return res.json({ ...cachedPropertiesPayload, from_cache: true, error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// Loan records from 001 - Loan Data (also used internally to hydrate links).
// Org header counts for the portal workspace switcher subtitle. Read-only, tiny.
// Cached for 5 minutes — this changes about once a year.
let orgSummaryCache = null, orgSummaryAt = 0;
app.get('/api/org/summary', async (req, res) => {
  if (!db.enabled) return res.status(503).json({ error: 'database_not_configured' });
  if (orgSummaryCache && Date.now() - orgSummaryAt < 5 * 60 * 1000) {
    return res.json({ ...orgSummaryCache, cached: true });
  }
  try {
    const [t, c] = await Promise.all([
      db.q('select id, name from tenant where is_active is not false order by name'),
      db.q('select id, tenant_id, name from company where is_active is not false order by name'),
    ]);
    orgSummaryCache = {
      tenants: t.rows,
      companies: c.rows,
      tenant_count: t.rows.length,
      company_count: c.rows.length,
    };
    orgSummaryAt = Date.now();
    res.json({ ...orgSummaryCache, cached: false });
  } catch (e) {
    console.error('/api/org/summary:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/loans', async (req, res) => {
  if (supaProps.enabled) {
    try { return res.json(await supaProps.getLoansPayload()); }
    catch (err) { console.error('supabase loans read failed:', err.message); return res.status(500).json({ error: err.message }); }
  }
  try {
    if (!cachedLoansAt || Date.now() - cachedLoansAt > PROPERTIES_TTL_MS) await buildLoansCache();
    const loans = [...cachedLoansById.values()].map(l => ({
      id: l.id, name: l.name, url: l.url, fields: l.fields, hasData: l.dataCount >= 3,
    }));
    res.json({ generatedAt: cachedLoansAt ? new Date(cachedLoansAt).toISOString() : null, loans });
  } catch (err) {
    console.error('loans build failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Manual refresh — clears the properties + loans caches and rebuilds.
app.post('/api/properties/refresh', async (req, res) => {
  if (supaProps.enabled) return res.json({ ok: true, source: 'supabase' }); // live DB; nothing to rebuild
  cachedPropertiesAt = 0; cachedPropertiesPayload = null;
  cachedLoansAt = 0; cachedLoansById = new Map();
  try {
    const payload = await buildPropertiesCache();
    res.json({ ok: true, generatedAt: payload.generatedAt, entities: payload.entities.length });
  } catch (err) {
    console.error('properties refresh failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Write a single custom field back to ClickUp using the LOGGED-IN USER's token.
// Value formats (client sends the already-formatted value): relationship =
// { add:[id], rem:[id] }, dropdown = option uuid, currency/number = number,
// date = epoch ms.
app.patch('/api/properties/:taskId/field/:fieldId', async (req, res) => {
  const auth = requireAuth(req, res); if (!auth) return;
  const { taskId, fieldId } = req.params;
  const value = req.body ? req.body.value : undefined;
  if (supaProps.enabled) {
    try { return res.json(await supaProps.patchField(taskId, fieldId, value)); }
    catch (err) { console.error('supabase field write:', err.message); return res.status(500).json({ error: err.message }); }
  }
  try {
    const result = await clickupWriteWithToken(auth.token, 'POST', `/task/${taskId}/field/${fieldId}`, { value });
    patchCachedPropertyField(taskId, fieldId, value);
    res.json(result || { ok: true });
  } catch (err) {
    console.error('property field write:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Post a comment on a property record — logged-in user's token.
app.post('/api/properties/:taskId/comment', async (req, res) => {
  const auth = requireAuth(req, res); if (!auth) return;
  if (supaProps.enabled) {
    try {
      const author = auth.user?.username || auth.user?.email || null;
      return res.json(await supaProps.addComment('property', req.params.taskId, req.body?.comment_text || '', author));
    } catch (err) { console.error('supabase add comment:', err.message); return res.status(500).json({ error: err.message }); }
  }
  try {
    const result = await clickupWriteWithToken(auth.token, 'POST', `/task/${req.params.taskId}/comment`, {
      comment_text: req.body?.comment_text || '', notify_all: false,
    });
    res.json(result || { ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.get('/api/properties/:taskId/comments', async (req, res) => {
  if (supaProps.enabled) {
    try { return res.json(await supaProps.getComments('property', req.params.taskId)); }
    catch (err) { console.error('supabase get comments:', err.message); return res.status(500).json({ error: err.message }); }
  }
  try { res.json(await clickup(`/task/${req.params.taskId}/comment`)); }
  catch (err) { res.status(500).json({ error: err.message }); }
});
// Unit (building) comments — Supabase only (property_comment with unit_id).
app.get('/api/units/:unitId/comments', async (req, res) => {
  if (!supaProps.enabled) return res.json({ comments: [] });
  try { res.json(await supaProps.getComments('unit', req.params.unitId)); }
  catch (err) { console.error('supabase unit comments:', err.message); res.status(500).json({ error: err.message }); }
});
app.post('/api/units/:unitId/comment', async (req, res) => {
  const auth = requireAuth(req, res); if (!auth) return;
  if (!supaProps.enabled) return res.status(400).json({ error: 'Unit comments require Supabase mode.' });
  try {
    const author = auth.user?.username || auth.user?.email || null;
    res.json(await supaProps.addComment('unit', req.params.unitId, req.body?.comment_text || '', author));
  } catch (err) { console.error('supabase add unit comment:', err.message); res.status(500).json({ error: err.message }); }
});
// Assign borrower + collateral to a loan (E2: clears it from the unlinked list).
app.post('/api/properties/loan/assign', async (req, res) => {
  const auth = requireAuth(req, res); if (!auth) return;
  if (!supaProps.enabled) return res.status(400).json({ error: 'Supabase mode required.' });
  try { res.json(await supaProps.assignLoan(String(req.body?.loanId || ''), req.body?.borrowerEntityId || null, req.body?.collateral || [])); }
  catch (err) { console.error('supabase assign loan:', err.message); res.status(500).json({ error: err.message }); }
});

// ----- Co-owners (ownership table) — add / remove a NON-PRIMARY owner -----
// Body: { entity_id, target:'property'|'unit', unit_id? }. :id is the property id.
app.post('/api/properties/:id/owners', async (req, res) => {
  const auth = requireAuth(req, res); if (!auth) return;
  if (!supaProps.enabled) return res.status(400).json({ error: 'Supabase mode required.' });
  const b = req.body || {};
  try {
    res.json(await supaProps.addOwner({
      propertyId: req.params.id, target: b.target === 'unit' ? 'unit' : 'property',
      unitId: b.unit_id || null, entityId: String(b.entity_id || ''),
    }));
  } catch (err) { console.error('add co-owner:', err.message); res.status(500).json({ error: err.message }); }
});
// Remove a co-owner. ?target=unit&unit_id=… for a building co-owner. Never the primary.
app.delete('/api/properties/:id/owners/:entityId', async (req, res) => {
  const auth = requireAuth(req, res); if (!auth) return;
  if (!supaProps.enabled) return res.status(400).json({ error: 'Supabase mode required.' });
  try {
    res.json(await supaProps.removeOwner({
      propertyId: req.params.id, target: req.query.target === 'unit' ? 'unit' : 'property',
      unitId: req.query.unit_id || null, entityId: String(req.params.entityId || ''),
    }));
  } catch (err) { console.error('remove co-owner:', err.message); res.status(500).json({ error: err.message }); }
});

// Read-only SQL views for the extra Properties tables (capex / asset-fees / escrows /
// tif). Optional ?pm=<management_company> filter. Supabase-only.
app.get('/api/views/:key', async (req, res) => {
  // Read-only Supabase SQL views (loan/property financials). Served OPEN, matching
  // /api/properties and /api/loans (see the ACCESS-MODEL NOTE above): same data class,
  // same server-side read connection, no ClickUp login required. Do NOT add a write path
  // here without gating it behind requireAuth.
  if (!supaProps.enabled) return res.status(400).json({ error: 'Supabase mode required.' });
  try { res.json(await supaProps.getView(req.params.key, req.query.pm || null)); }
  catch (err) { console.error('view read:', err.message); res.status(500).json({ error: err.message }); }
});

// Self-check (B1): row counts per table + each verification check pass/fail.
app.get('/api/_selfcheck', async (req, res) => {
  if (!supaProps.enabled) return res.json({ enabled: false, note: 'DATA_SOURCE is not supabase; nothing to check.' });
  try { res.json(await supaProps.selfCheck()); }
  catch (err) { console.error('selfcheck failed:', err.message); res.status(500).json({ error: err.message }); }
});

// ----- Add entity (folder) — structural write, user token -----
app.post('/api/properties/entity', async (req, res) => {
  const auth = requireAuth(req, res); if (!auth) return;
  const name = (req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Entity name required' });
  if (supaProps.enabled) {
    try { return res.json(await supaProps.createEntity(name, req.body?.parentEntityId || null)); }
    catch (err) { console.error('supabase add entity:', err.message); return res.status(500).json({ error: err.message }); }
  }
  try {
    const folder = await clickupWriteWithToken(auth.token, 'POST', `/space/${PROPERTIES_SPACE_ID}/folder`, { name });
    cachedPropertiesAt = 0; // force rebuild on next load
    res.json({ ok: true, id: String(folder.id), name: folder.name });
  } catch (err) {
    console.error('add entity:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ----- Add property/location — creates list + property record, plus a matching
// blank loan record (new list in 001 - Loan Data), links them, sets status None.
app.post('/api/properties/property', async (req, res) => {
  const auth = requireAuth(req, res); if (!auth) return;
  const folderId = String(req.body?.folderId || '');
  const name = (req.body?.name || '').trim();
  if (!folderId || !name) return res.status(400).json({ error: 'folderId and name required' });
  if (supaProps.enabled) {
    try { return res.json(await supaProps.createProperty(folderId, name, req.body?.address || null)); } // folderId = entity id in Supabase mode
    catch (err) { console.error('supabase add property:', err.message); return res.status(500).json({ error: err.message }); }
  }
  const tok = auth.token;
  try {
    // 1. Property list + record (custom task type "Project Name").
    const list = await clickupWriteWithToken(tok, 'POST', `/folder/${folderId}/list`, { name });
    const propTask = await clickupWriteWithToken(tok, 'POST', `/list/${list.id}/task`, { name, custom_item_id: PROJECT_NAME_ITEM_ID });
    // 2. Matching blank loan record (new list in 001 - Loan Data + one Loan# task).
    let loanTask = null;
    try {
      const loanList = await clickupWriteWithToken(tok, 'POST', `/folder/${LOAN_DATA_FOLDER_ID}/list`, { name });
      loanTask = await clickupWriteWithToken(tok, 'POST', `/list/${loanList.id}/task`, { name: 'Loan#' });
      // 3. Link loan to property via the Loans relationship field.
      await clickupWriteWithToken(tok, 'POST', `/task/${propTask.id}/field/${LOANS_FIELD_ID}`, { value: { add: [String(loanTask.id)] } });
    } catch (e) { console.warn('loan auto-create failed (property still created):', e.message); }
    // 4. Set Loan Status = None.
    try {
      await clickupWriteWithToken(tok, 'POST', `/task/${propTask.id}/field/${LOAN_STATUS_FIELD_ID}`, { value: LOAN_STATUS_OPT_NONE });
    } catch (e) { console.warn('set Loan Status None failed:', e.message); }

    cachedPropertiesAt = 0; cachedLoansAt = 0; cachedLoansById = new Map();
    res.json({ ok: true, listId: String(list.id), taskId: String(propTask.id), loanTaskId: loanTask ? String(loanTask.id) : null });
  } catch (err) {
    console.error('add property:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Create a loan-data record (list + task in the 001 - Loan Data folder), set any
// provided fields by name, and link it to the property via the Loans relationship.
app.post('/api/properties/loan', async (req, res) => {
  const auth = requireAuth(req, res); if (!auth) return;
  const tok = auth.token;
  const propertyTaskId = String(req.body?.propertyTaskId || '');
  const name = (req.body?.name || '').trim();
  const fields = req.body?.fields || {};
  if (!propertyTaskId || !name) return res.status(400).json({ error: 'propertyTaskId and name required' });
  if (supaProps.enabled) {
    try { return res.json(await supaProps.createLoan(propertyTaskId, name, fields, req.body?.collateral || null, req.body?.borrowerEntityId || null)); }
    catch (err) { console.error('supabase add loan:', err.message); return res.status(500).json({ error: err.message }); }
  }
  try {
    const loanList = await clickupWriteWithToken(tok, 'POST', `/folder/${LOAN_DATA_FOLDER_ID}/list`, { name });
    const loanTask = await clickupWriteWithToken(tok, 'POST', `/list/${loanList.id}/task`, { name });
    // Set provided custom fields, resolved by (normalized) name against the list's fields.
    const keys = Object.keys(fields).filter(k => fields[k] !== '' && fields[k] != null);
    if (keys.length) {
      let defs = [];
      try { defs = (await clickup(`/list/${loanList.id}/field`)).fields || []; } catch (e) {}
      const byName = {}; defs.forEach(f => { if (f && f.name) byName[normPropField(f.name)] = f; });
      for (const k of keys) {
        const def = byName[normPropField(k)]; if (!def) continue;
        let value = fields[k];
        if (def.type === 'date') { const ms = Date.parse(value); if (isNaN(ms)) continue; value = ms; }
        else if (def.type === 'currency' || def.type === 'number') { value = Number(value); if (!isFinite(value)) continue; }
        try { await clickupWriteWithToken(tok, 'POST', `/task/${loanTask.id}/field/${def.id}`, { value }); }
        catch (e) { console.warn(`set loan field ${k} failed:`, e.message); }
      }
    }
    // Link the loan to the property.
    await clickupWriteWithToken(tok, 'POST', `/task/${propertyTaskId}/field/${LOANS_FIELD_ID}`, { value: { add: [String(loanTask.id)] } });
    cachedPropertiesAt = 0; cachedLoansAt = 0; cachedLoansById = new Map();
    res.json({ ok: true, loanTaskId: String(loanTask.id) });
  } catch (err) {
    console.error('add loan:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ----- Property Tasks list (Kanban source) — separate cache -----
let cachedPropTasks = null;
let cachedPropTasksAt = 0;
let propTasksInFlight = null;
async function buildPropTasksCache() {
  if (propTasksInFlight) return propTasksInFlight;
  propTasksInFlight = (async () => {
    const raw = await fetchAllListTasks(PROPERTY_TASKS_LIST_ID);
    let statuses = [];
    try { statuses = await getListStatuses(PROPERTY_TASKS_LIST_ID); } catch (e) {}
    const tasks = raw.map(t => ({
      id: String(t.id), name: t.name, url: t.url || `https://app.clickup.com/t/${t.id}`,
      status: t.status?.status || null, statusColor: t.status?.color || null, statusType: t.status?.type || null,
      assignees: (t.assignees || []).map(a => ({ id: a.id, username: a.username || a.email || String(a.id), color: a.color || null })),
      due_date: t.due_date || null,
      fields: propFieldsToMap(t.custom_fields),
    }));
    cachedPropTasks = {
      generatedAt: new Date().toISOString(),
      statuses: statuses.map(s => ({ status: s.status, color: s.color, type: s.type, orderindex: s.orderindex })),
      tasks,
    };
    cachedPropTasksAt = Date.now();
    console.log(`Property tasks cache built: ${tasks.length} tasks`);
    return cachedPropTasks;
  })();
  propTasksInFlight.finally(() => { propTasksInFlight = null; });
  return propTasksInFlight;
}
app.get('/api/property-tasks', async (req, res) => {
  // Supabase-backed read when the two-way sync is enabled.
  if (taskSync.enabled) {
    try { return res.json({ ...(await taskSync.getBoardPayload()), from_cache: false }); }
    catch (err) { console.error('supabase board read failed:', err.message); return res.status(500).json({ error: err.message }); }
  }
  const force = req.query.force === '1';
  const age = Date.now() - cachedPropTasksAt;
  if (cachedPropTasks && !force) {
    if (age > PROPERTIES_TTL_MS) buildPropTasksCache().catch(() => {});
    return res.json({ ...cachedPropTasks, from_cache: true, cache_age_ms: age });
  }
  try { res.json({ ...(await buildPropTasksCache()), from_cache: false }); }
  catch (err) {
    console.error('property tasks build failed:', err.message);
    if (cachedPropTasks) return res.json({ ...cachedPropTasks, from_cache: true, error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// Field definitions for the Tasks and Projects list — used by the create-task
// form to find the "Property" relationship field id + the Category dropdown
// options + statuses (works even when the list has zero tasks).
let cachedPTFields = null, cachedPTFieldsAt = 0;
app.get('/api/property-tasks/fields', async (req, res) => {
  try {
    if (!cachedPTFields || Date.now() - cachedPTFieldsAt > PROPERTIES_TTL_MS) {
      const data = await clickup(`/list/${PROPERTY_TASKS_LIST_ID}/field`);
      let statuses = [];
      try { statuses = await getListStatuses(PROPERTY_TASKS_LIST_ID); } catch (e) {}
      cachedPTFields = {
        fields: (data.fields || []).map(f => ({
          id: f.id, name: f.name, type: f.type,
          options: f.type_config?.options ? f.type_config.options.map(o => ({ id: o.id, name: o.name, orderindex: o.orderindex })) : undefined,
        })),
        statuses: statuses.map(s => ({ status: s.status, color: s.color, type: s.type, orderindex: s.orderindex })),
      };
      cachedPTFieldsAt = Date.now();
    }
    res.json(cachedPTFields);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Create a task in the Tasks and Projects list (logged-in user's token), set the
// Property relationship to the chosen record (property OR specific building),
// and the Category dropdown. Invalidates the board cache.
app.post('/api/property-tasks', async (req, res) => {
  const auth = requireAuth(req, res); if (!auth) return;
  const b = req.body || {};
  if (!b.name) return res.status(400).json({ error: 'Task name required' });
  // Supabase-backed create when the two-way sync is enabled: insert locally
  // (pending) + attempt immediate push to ClickUp using the user's token.
  if (taskSync.enabled) {
    if (!b.linkTaskId) return res.status(400).json({ error: 'A parent property or building is required' });
    try {
      const out = await taskSync.createTaskFromDashboard({
        name: b.name, description: b.description, assignees: b.assignees, due_date: b.due_date,
        status: b.status, categoryValue: b.categoryValue, clickupTargetId: b.linkTaskId,
      }, auth.token);
      return res.json({ ok: true, ...out });
    } catch (err) {
      console.error('supabase create task:', err.message);
      return res.status(500).json({ error: err.message });
    }
  }
  const body = { name: String(b.name) };
  if (b.description) body.description = String(b.description);
  // Assignees may arrive as ids or {id,name} objects — ClickUp wants numeric ids.
  if (Array.isArray(b.assignees) && b.assignees.length) body.assignees = b.assignees.map(a => (a && typeof a === 'object') ? a.id : a).filter(v => v != null).map(Number);
  if (b.due_date) body.due_date = Number(b.due_date);
  if (b.status) body.status = String(b.status);
  const cf = [];
  if (b.categoryFieldId && b.categoryValue) cf.push({ id: b.categoryFieldId, value: b.categoryValue });
  if (cf.length) body.custom_fields = cf;
  try {
    const task = await clickupWriteWithToken(auth.token, 'POST', `/list/${PROPERTY_TASKS_LIST_ID}/task`, body);
    if (b.propertyFieldId && b.linkTaskId) {
      try { await clickupWriteWithToken(auth.token, 'POST', `/task/${task.id}/field/${b.propertyFieldId}`, { value: { add: [String(b.linkTaskId)] } }); }
      catch (e) { console.warn('link property relationship failed:', e.message); }
    }
    cachedPropTasksAt = 0;
    res.json({ ok: true, taskId: String(task.id) });
  } catch (err) {
    console.error('create property task:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Manual two-way sync trigger (the "Sync tasks" button). No-op error when the
// Supabase data source isn't configured.
app.post('/api/property-tasks/sync', async (req, res) => {
  if (!taskSync.enabled) return res.status(400).json({ error: 'Task sync is not enabled. Set DATA_SOURCE=supabase and SUPABASE_DB_URL.' });
  try { res.json({ ok: true, ...(await taskSync.runSync()) }); }
  catch (err) { console.error('manual task sync failed:', err.message); res.status(500).json({ error: err.message }); }
});

// Add a building/structure record (property-type task) in a property's list.
app.post('/api/properties/building', async (req, res) => {
  const auth = requireAuth(req, res); if (!auth) return;
  const listId = String(req.body?.listId || '');
  const name = (req.body?.name || '').trim();
  if (!listId || !name) return res.status(400).json({ error: 'listId and name required' });
  if (supaProps.enabled) {
    try { return res.json(await supaProps.createBuilding(listId, name)); } // listId = property id in Supabase mode
    catch (err) { console.error('supabase add building:', err.message); return res.status(500).json({ error: err.message }); }
  }
  try {
    const task = await clickupWriteWithToken(auth.token, 'POST', `/list/${listId}/task`, { name, custom_item_id: PROJECT_NAME_ITEM_ID });
    cachedPropertiesAt = 0;
    res.json({ ok: true, taskId: String(task.id), name: task.name });
  } catch (err) {
    console.error('add building:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ===================== LIVE SYNC: Supabase webhooks -> SSE =====================
// Supabase database webhooks (one trigger per table, created by
// migrations/20260810_realtime_webhooks.sql) POST here on every insert/update/
// delete. We verify a shared secret, bust the affected server cache, and push a
// small "table changed" ping to open dashboards over SSE so they refetch. Only the
// table name + event type is broadcast over the (open) stream -- never row data.
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || '';
const sseClients = new Set();

app.get('/api/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 5000\n\n');
  res.write('event: hello\ndata: {"ok":true}\n\n');
  if (res.flush) res.flush();               // defeat the compression middleware's buffering
  sseClients.add(res);
  const ping = setInterval(() => { try { res.write(': keep-alive\n\n'); if (res.flush) res.flush(); } catch (e) {} }, 25000);
  req.on('close', () => { clearInterval(ping); sseClients.delete(res); });
});

function broadcastChange(table, type) {
  const msg = `event: db-change\ndata: ${JSON.stringify({ table, type, at: Date.now() })}\n\n`;
  sseClients.forEach(res => { try { res.write(msg); if (res.flush) res.flush(); } catch (e) {} });
}

app.post('/api/hooks/supabase', (req, res) => {
  if (WEBHOOK_SECRET && req.get('x-webhook-secret') !== WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  const b = req.body || {};
  const table = String(b.table || 'unknown');
  const type = String(b.type || b.event || 'UNKNOWN');
  const t = table.toLowerCase();
  // Bust whatever server-side cache this table feeds so the next read is fresh.
  if (/(propert|loan|unit|entity|financial|insurance|ownership|investor)/.test(t)) {
    cachedPropertiesAt = 0; cachedLoansAt = 0;
  }
  if (/task/.test(t)) cachedPropTasksAt = 0;
  broadcastChange(table, type);
  res.json({ ok: true });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Dashboard running on port ${PORT}`);
  if (!CLICKUP_TOKEN) console.warn('WARNING: CLICKUP_API_TOKEN is not set.');
  if (CLICKUP_TOKEN) {
    // Pre-warm cache so the first user request is instant, not a cold workspace walk
    setTimeout(() => {
      console.log('Pre-warming task cache...');
      triggerBackgroundRefresh();
    }, 1000);
    // 8 AM + 12 PM CT auto-refresh — runs even when no users have the dashboard open,
    // so newly created spaces / lists / tasks are picked up reliably twice a day.
    scheduleDailyRefresh();
    // Initial task reconcile on boot so Supabase reflects ClickUp right away.
    if (taskSync.enabled) {
      setTimeout(() => { taskSync.runSync().catch(e => console.error('Boot task sync failed:', e.message)); }, 4000);
    }
  }
});
