/* Leads (GHL) — command-center's Leads screen, transplanted.

   This file is command-center's actual implementation, not a rewrite of it:
   the LEADS section of its public/index.html (1,214 lines) plus the four
   helpers it reaches out to — initials, makeSplitter, api/banner, loadThread.
   Assembled by .build-ghl.cjs so the diff against the original stays readable.

   ---------------------------------------------------------------------------
   WHAT CHANGED, AND ONLY THIS

   1. `api()` injects `company_id` into every /api/ghl URL. That is the brand
      scope, and putting it in the one helper every call already goes through is
      what makes it impossible to omit on one of them.

   2. `api()` also attaches the caller's Supabase bearer token, because the
      send route takes the sender's address from the VERIFIED session and
      ignores anything the browser claims. The composer is command-center's,
      unchanged, except that the From picker becomes a statement — "Sending as
      <you>" — since there is nothing left to pick.

   3. The EventSource on /api/ghl/events is a stub. That route is a Postgres
      NOTIFY fan-out command-center runs and this service does not; an
      EventSource pointed at a 404 retries forever. portal-realtime.js already
      refreshes this view when lead / ghl_message / ghl_opportunity change.

   4. The calendar view's demo flag folds to false; that view is not part of
      this screen. (Worded without naming the flag, because the fold that
      replaces it runs over this comment too.)

   5. An IIFE exposing window.PortalGHL, plus mount(host, {companyId,
      brandName}), because the portal builds a view on navigation while
      command-center's markup is in the document from first paint.

   Everything else — the stage bar, the split list, the reader, the tabs, the
   IndexedDB cache, the delta cursor, the search-later queue, the splitter — is
   the original code.

   ---------------------------------------------------------------------------
   THE DATA, VERIFIED LIVE 2026-09-07

     LeavenWealth  r7zMur27ESvHGQpOWI2F  1,231 leads  31 opps    0 messages
     Leadli AI     sR79W8mCX3gd5pWKG5wU  2,538 leads   0 opps    0 messages
     Folio Excel   xvWwoC1KQ1cOtw8Qf3Ez  4,643 leads   8 opps  111 messages
     Liquid Lending — no sub-account; 8 leads carrying only a company_id

   Only Folio has messages, so an empty thread under the other brands is the
   ingest rather than this screen. Most leads have no stage — 28 of
   LeavenWealth's 1,231 — because a stage belongs to an opportunity.
   --------------------------------------------------------------------------- */

window.PortalGHL = (function () {
'use strict';

/* The brand, set by mount(). Read by scopeUrl on every request. */
let SCOPE_COMPANY = null;
let SCOPE_BRAND = '';

/* The signed-in person's address, for the composer's From line. The SERVER is
   the authority — it reads the caller's verified identity and ignores whatever
   the browser says — so this is a label, never an input. */
let SEND_AS = '';

/* One place that attaches the Supabase bearer, so no call site has to
   remember. Returns the options untouched when there is no session: reads work
   signed-out and the send route answers 401 on its own terms. */
async function withAuth(options){
  try {
    if (!window.PortalSession) return options;
    const s = await window.PortalSession.getSession();
    if (!s || !s.access_token) return options;
    return { ...(options || {}), headers: { ...((options || {}).headers || {}),
             Authorization: 'Bearer ' + s.access_token } };
  } catch (e) { return options; }
}

function scopeUrl(url){
  if (typeof url !== 'string' || url.indexOf('/api/ghl') !== 0) return url;
  if (!SCOPE_COMPANY) return url;
  return url + (url.indexOf('?') >= 0 ? '&' : '?') + 'company_id=' + encodeURIComponent(SCOPE_COMPANY);
}

/* Every /api/ghl call carries the current brand. Injecting it HERE rather than
   at the ~10 call sites is what makes it impossible to forget on one of them —
   and forgetting on one is how another brand's leads reach the screen. */
async function api(url, options){
  url = scopeUrl(url);
  /* The caller's Supabase token rides along, because the send route decides
     whose address goes on the message from the VERIFIED session rather than
     from anything the browser claims. Reads do not need it, but attaching it
     in one place beats remembering which calls do. */
  options = await withAuth(options);
  const r = await fetch(url, options);
  const body = await r.json().catch(() => ({}));
  if (!r.ok) {
    /* The status and the payload ride along on the error. A 409 from a lead
       stage write carries the stage GHL actually holds, and the handler needs
       both to tell a conflict apart from a plain failure. */
    const err = new Error(body.error || `${r.status} ${r.statusText}`);
    err.status = r.status;
    err.body = body;
    throw err;
  }
  return body;
}

const post = (url, body) => api(url, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body || {})
});

const msgUrl = m => `/api/mail/${encodeURIComponent(m.acct)}/${encodeURIComponent(m.id)}`;

/* One banner per view that has one, written to whichever view is on screen.

   This was previously hardwired to the Inbox's banner. Every error raised from the
   Leads view — a failed send, a rejected stage change, a warning that the first
   sync had not finished — was rendered inside a hidden section. From the user's
   side the action simply did nothing, which is the worst possible way for an error
   to behave. */
const BANNERS = { leads: 'ld-banner' };

/* The portal only ever mounts the Leads view from this module. */
function activeView(){ return 'leads'; }

function banner(text, kind){
  const targets = Object.values(BANNERS)
    .map(id => document.getElementById(id))
    .filter(Boolean);

  /* Cleared everywhere, so a stale message cannot linger on a view the user
     switches back to later. */
  for (const el of targets) el.hidden = true;
  if (!text) return;

  const el = document.getElementById(BANNERS[activeView()])
    /* A view with no banner of its own still gets its errors seen rather than
       swallowed: the Inbox's is the fallback and is at least reachable. */
    || document.getElementById(BANNERS.leads);
  if (!el) return;

  el.textContent = text;
  el.hidden = false;
  el.style.borderColor = kind === 'ok' ? '#4E9E7E55' : '';
  el.style.color = kind === 'ok' ? '#4E9E7E' : '';
}


const initials = n => n.replace(/^To:\s*/,'').split(/\s+/).slice(0,2).map(w => w[0]).join('').toUpperCase();

function makeSplitter(wrapId, gutterId, def){
  const gut = document.getElementById(gutterId);
  const wrap = document.getElementById(wrapId);
  if (!gut || !wrap) return;
  const MIN = 22, MAX = 66;
  let dragging = false;

  const setPct = p => wrap.style.setProperty('--split', Math.min(MAX, Math.max(MIN, p)).toFixed(2) + '%');
  const current = () => parseFloat(getComputedStyle(wrap).getPropertyValue('--split')) || def;

  gut.addEventListener('pointerdown', e => {
    dragging = true;
    gut.classList.add('drag');
    gut.setPointerCapture(e.pointerId);
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';
  });
  gut.addEventListener('pointermove', e => {
    if (!dragging) return;
    const r = wrap.getBoundingClientRect();
    setPct(((e.clientX - r.left) / r.width) * 100);
  });
  const stop = () => {
    if (!dragging) return;
    dragging = false;
    gut.classList.remove('drag');
    document.body.style.userSelect = '';
    document.body.style.cursor = '';
  };
  gut.addEventListener('pointerup', stop);
  gut.addEventListener('pointercancel', stop);
  gut.addEventListener('dblclick', () => setPct(def));
  gut.addEventListener('keydown', e => {
    if (e.key === 'ArrowLeft')  { setPct(current() - 3); e.preventDefault(); }
    if (e.key === 'ArrowRight') { setPct(current() + 3); e.preventDefault(); }
    if (e.key === 'Home')       { setPct(def); e.preventDefault(); }
  });
  setPct(def);
}


/* ================= LEADS =================
   LOCATIONS are GHL sub-accounts. Every write here is optimistic: update local
   state, fire the API call, revert on failure. GHL webhooks push the other way.
   Point LOCATIONS/LEADS/THREADS at /api/ghl/* and nothing below changes. */

let LOCATIONS = [];
let LEADS = [];
let THREADS = {};

/* Ingest health, from ghl_sync_log via GET /api/ghl/sync. Not a sync this
   dashboard runs — it cannot start, stop or retry one, and the UI no longer
   pretends otherwise. */
let INGEST = null;

/* Why the locations read failed, when it did. An empty sidebar has two causes —
   an empty table and a failed query — and rendering both as "Not ingested yet"
   sent the owner debugging the ingest pipeline when the server could not reach
   the database at all. */
let GHL_ERR = null;

/* Filled from /api/ghl/stages. Never hardcoded: stages are per pipeline and
   change, and the six invented ones matched no real pipeline. */
let STAGES = [];

/* ---------- cache ----------

   IndexedDB, one key-value store. A reload paints from here before the network
   answers, then asks the server only for what changed since the newest row it
   holds. Every accessor swallows its own failure: a private window, a cleared
   site, or a browser with IndexedDB off means "no cache", never a broken page. */
const CC_CACHE = (() => {
  const NAME = 'cc-cache', STORE = 'kv';
  let dbp = null;
  const open = () => dbp ||= new Promise((res, rej) => {
    if (!window.indexedDB) return rej(new Error('no IndexedDB'));
    const r = indexedDB.open(NAME, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return {
    async get(k){
      try {
        const db = await open();
        return await new Promise((res, rej) => {
          const q = db.transaction(STORE, 'readonly').objectStore(STORE).get(k);
          q.onsuccess = () => res(q.result ?? null);
          q.onerror = () => rej(q.error);
        });
      } catch { return null; }
    },
    async set(k, v){
      try {
        const db = await open();
        await new Promise((res, rej) => {
          const t = db.transaction(STORE, 'readwrite');
          t.objectStore(STORE).put(v, k);
          t.oncomplete = res; t.onerror = () => rej(t.error);
        });
      } catch { /* cache is a convenience */ }
    },
    async clear(){
      try {
        const db = await open();
        await new Promise((res, rej) => {
          const t = db.transaction(STORE, 'readwrite');
          t.objectStore(STORE).clear();
          t.oncomplete = res; t.onerror = () => rej(t.error);
        });
      } catch { /* nothing to clear */ }
    }
  };
})();

/* The delta cursor: the newest changedAt the server has told us about. It is the
   server clock, so a browser with the wrong time cannot skip rows. null means
   "never loaded" and forces a full read. */
let GHL_CURSOR = null;
let FORCE_FULL = false;

function advanceCursor(out){
  for (const l of out?.leads || []) {
    if (l.changedAt && (!GHL_CURSOR || l.changedAt > GHL_CURSOR)) GHL_CURSOR = l.changedAt;
  }
  /* A full read that found nothing still moves the cursor, otherwise every later
     load would be another full read. */
  if (!GHL_CURSOR && out?.serverTime && !out?.delta) GHL_CURSOR = out.serverTime;
}

/* Upsert by id. A row the user has read stays read unless a newer message has
   actually landed: the server derives unread from timestamps and knows nothing
   about a click made ten seconds ago. */
function mergeLeads(rows){
  const byId = new Map(LEADS.map(l => [l.id, l]));
  for (const r of rows) {
    const cur = byId.get(r.id);
    if (cur && cur.unread === false && r.unread && r.sortKey === cur.sortKey) r.unread = false;
    byId.set(r.id, r);
  }
  LEADS = [...byId.values()];
}

const saveLeadsCache = () => CC_CACHE.set('ghl:leads', { leads: LEADS, cursor: GHL_CURSOR, savedAt: Date.now() });
const saveLocationsCache = () => CC_CACHE.set('ghl:locations', LOCATIONS);

/* Paint from cache before the first network round trip. Resolved once, and
   load() waits on it so the first fetch can be a delta rather than everything. */
const CACHE_READY = (async () => {
  if (false) return;
  const [locs, leads] = await Promise.all([CC_CACHE.get('ghl:locations'), CC_CACHE.get('ghl:leads')]);
  if (Array.isArray(locs) && locs.length) LOCATIONS = locs;
  if (leads?.leads?.length) { LEADS = leads.leads; GHL_CURSOR = leads.cursor || null; }
  if (LOCATIONS.length || LEADS.length) {
    try { drawLeads(); } catch { /* the view may not be mounted yet */ }
  }
})();
const CHANNELS = [
  { k:'sms',   label:'SMS' },
  { k:'email', label:'Email' },
  { k:'wa',    label:'WhatsApp' },
  { k:'fb',    label:'FB' }
];

const LD = { loc:'all', stage:'all', sel:null, tab:'thread', channel:'sms', from:null,
  /* The search term, and whether a server round trip for it is in flight. The
     local filter is instant against what is loaded; the server call finds the
     rest, and both write into the same list. */
  q:'', qBusy:false, qTimer:null, qSeq:0 };

/* Kept beside THREADS rather than inside it. Activity records are GHL system
   events, and pending rows are inbound webhooks that arrived with no ids — both
   belong on the timeline but neither is a message, and folding them into THREADS
   would make every consumer separate them again. */
const ACTIVITY = {};
const PENDING = {};
const DETAIL = {};

/* Never undefined. A lead outlives the sub-account it came from -- GHL lets you
   remove a location and the lead rows stay -- and one such lead threw inside the
   row renderer, which blanked the entire list. An unknown account is still an
   account; it just has no name here. */
const LOC_UNKNOWN = { id: null, name: 'Unknown account', short: '—',
  color: 'var(--dimmer)', brand: null, sendable: false, senders: null };
const locById = id => LOCATIONS.find(l => l.id === id) || LOC_UNKNOWN;
const money = n => '$' + n.toLocaleString();

/* A lead with no opportunity has no stage \u2014 stage belongs to an opportunity, not
   to a person, and 3,288 of Folio's 3,296 leads have none. */
const stageLabel = l => l.stageName || (l.hasOpportunity ? 'No stage' : 'No opportunity');

/* GHL's status, not the stage name. This data has a "Closed Won" stage sitting
   at status open, so reading won/lost off the label would be wrong. */
const isClosed = l => l.status === 'won' || l.status === 'lost' || l.status === 'abandoned';

/* The same fields the SQL searches, so what appears the instant you type and
   what the server sends back a moment later are the same set. Phone numbers lose
   everything that is not a digit on both sides, because nobody types a number
   the way it was stored. */
function ldMatches(l, term){
  const q = term.toLowerCase();
  if ((l.name || '').toLowerCase().includes(q)) return true;
  if ((l.email || '').toLowerCase().includes(q)) return true;
  if ((l.source || '').toLowerCase().includes(q)) return true;
  if ((l.owner || '').toLowerCase().includes(q)) return true;
  if ((l.tags || []).some(t => String(t).toLowerCase().includes(q))) return true;
  const digits = term.replace(/\D+/g, '');
  if (digits.length >= 3
    && String(l.phone || '').replace(/\D+/g, '').includes(digits)) return true;
  return false;
}

function ldVisible(){
  const term = LD.q.trim();
  return LEADS.filter(l =>
    (LD.loc === 'all' || l.loc === LD.loc) &&
    (LD.stage === 'all' || l.stageName === LD.stage) &&
    (term.length < 2 || ldMatches(l, term)));
}

/* Typed terms go to the server too, because the list holds the few hundred most
   recently active leads and the person being looked for is usually older than
   that. Results are merged rather than replacing the list: clearing the box then
   costs nothing, and the live-update path keeps working throughout. */
function ldSearchLater(){
  clearTimeout(LD.qTimer);
  const term = LD.q.trim();
  if (term.length < 2) { LD.qBusy = false; drawLeads(); return; }
  LD.qTimer = setTimeout(async () => {
    const seq = ++LD.qSeq;
    LD.qBusy = true; drawLeadSearch();
    try {
      const out = await api('/api/ghl/leads?q=' + encodeURIComponent(term)
        + (LD.loc === 'all' ? '' : '&location=' + encodeURIComponent(LD.loc)));
      /* A slower earlier request must not overwrite a later one's results. */
      if (seq !== LD.qSeq) return;
      mergeLeads(out.leads || []);
      saveLeadsCache();
    } catch (err) {
      if (seq === LD.qSeq) console.error('lead search failed:', err.message);
    } finally {
      if (seq === LD.qSeq) { LD.qBusy = false; drawLeads(); }
    }
  }, 280);
}

/* Just the box, so a repaint mid-typing does not take the caret out of it. */
function drawLeadSearch(){
  const box = document.querySelector('.ldsearch');
  if (box) box.classList.toggle('busy', Boolean(LD.qBusy));
  const clear = document.getElementById('ld-qclear');
  if (clear) clear.hidden = !LD.q;
}

/* ---------- submenu ---------- */
let ldSubEl = null;
function mountLeadSubnav(){
  const stages = document.getElementById('ld-stages');
  if (!stages) return;
  /* Rebuilt on every mount, so a re-entry cannot leave two of them. */
  const old = document.getElementById('ld-subnav');
  if (old) old.remove();
  ldSubEl = document.createElement('div');
  ldSubEl.className = 'subnav';
  ldSubEl.id = 'ld-subnav';
  stages.before(ldSubEl);
}

function drawLeadSubnav(){
  if (!ldSubEl) return;
  const row = (key, label, count, color, broken, tip) =>
    '<button class="subitem' + (LD.loc === key ? ' on' : '') + (broken ? ' broken' : '') + '" data-loc="' + key + '"'
    + (tip ? ' title="' + escL(tip) + '"' : '') + '>'
    + '<span class="sdot" style="--c:' + (color || 'var(--dimmer)') + '"></span>'
    + '<span class="slabel">' + escL(label) + '</span>'
    + '<span class="scount">' + (broken ? '!' : (count || '')) + '</span></button>';

  /* The count is every lead in the location, from ghl_location's own lead
     count, not the open subset — a sub-account with 3,296 leads and 8
     opportunities showed 8 before, which read as a broken integration.

     No marker and no tooltip: there is no per-location sync state any more.
     A location is here because the pipeline ingested it. */
  const total = LOCATIONS.reduce((n, l) => n + (l.leads || 0), 0);

  let html = row('all', 'All locations', total, 'linear-gradient(135deg,#D9A441,#4E9E7E)');
  html += '<div class="subhead">Sub-accounts</div>';
  html += LOCATIONS.length
    ? LOCATIONS.map(l => row(l.id, l.name, l.leads,
        l.color, false,
        [l.brand, l.leads.toLocaleString() + ' leads',
         l.opportunities + ' opportunities',
         l.sendable ? null : 'read-only — no send token'].filter(Boolean).join(' · '))).join('')
    /* No connect button. Nothing here can be fixed from this screen: locations
       appear when the ingest pipeline ingests them — unless the read itself
       failed, which is a different fact and must not wear the same words. */
    : '<div class="subempty">' + (GHL_ERR ? 'Database unreachable' : 'Not ingested yet') + '</div>';

  ldSubEl.innerHTML = html;
  ldSubEl.querySelectorAll('[data-loc]').forEach(b => b.onclick = () => {
    LD.loc = b.dataset.loc; LD.sel = null; LD.stage = 'all';
    loadStages();
    drawLeads();
  });
}

/* ---------- render ---------- */
const escL = s => String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));

/* The stage cards come from ghl_pipeline_stage, in pipeline order, with GHL's
   own names. They used to be a hardcoded six \u2014 New, Contacted, Qualified,
   Proposal, Won, Lost \u2014 which matched no pipeline that exists: Folio's are
   Qualified, Demo Scheduled, Demo Complete, Proposal Sent, Long Term Follow Up,
   Closed Won, Onboard Initiated. Three of those collapsed into one card and four
   could not be shown at all.

   Counts come from the server, over every opportunity in the location, not from
   the capped lead list in the browser. */
function drawStages(){
  const box = document.getElementById('ld-stages');
  const pool = LEADS.filter(l => LD.loc === 'all' || l.loc === LD.loc);

  const cell = (key, label, count, val) =>
    '<button class="stg' + (LD.stage === key ? ' on' : '') + '" data-stage="' + escL(key) + '">'
    + '<div class="k">' + escL(label) + '</div><div class="n">' + count + '</div>'
    + '<div class="v">' + (val ? money(val) : '\u2014') + '</div></button>';

  const all = cell('all', 'All', pool.length,
    pool.reduce((s, l) => s + l.value, 0));

  /* Demo mode has no server to count for it, so it counts what it invented. */
  const counted = false
    ? STAGES.map(s => {
        const set = pool.filter(l => l.stageName === s.name);
        return { ...s, count: set.length, value: set.reduce((n, l) => n + l.value, 0) };
      })
    : STAGES;

  box.innerHTML = all + counted.map(s => cell(s.name, s.name, s.count, s.value)).join('');
  box.querySelectorAll('[data-stage]').forEach(b => b.onclick = () => {
    LD.stage = b.dataset.stage; LD.sel = null; drawLeads();
  });
}

/* Why the pipeline is empty, which is not one question but four. "Nothing matches
   this stage" was the only answer this view could give, and it was wrong in three
   of the four cases — a sub-account that has never synced, one whose sync failed,
   and one still syncing all looked identical to a genuinely empty pipeline. The
/* Why the pipeline is empty. There used to be four answers here, three of them
   about sync state — never synced, sync failed, still syncing — and command-center
   no longer syncs anything, so those cannot happen and must not be offered.

   What remains is genuinely distinct: no locations ingested at all, a location
   with leads but no opportunities, and a stage filter that matches nothing. The
   first cannot be fixed from this screen, and says so rather than showing a
   button that would pretend otherwise. */
function emptyPipeline(){
  if (GHL_ERR) {
    return '<div class="empty"><b>Could not read the database</b>'
      + '<small>' + escL(GHL_ERR) + '</small>'
      + '<small style="margin-top:6px">Open <b>/api/ghl/diag</b> for which database this '
      + 'server is connected to and what it can see.</small></div>';
  }
  if (!LOCATIONS.length) {
    return '<div class="empty"><b>No GHL data ingested yet</b>'
      + '<small>Sub-accounts appear here once the ingest pipeline has written them to '
      + 'Supabase. Nothing on this screen can start that — it runs in the backfill '
      + 'script and the n8n webhooks, not in this dashboard.</small></div>';
  }

  const pool = LEADS.filter(l => LD.loc === 'all' || l.loc === LD.loc);

  /* Leads exist, opportunities do not. Not a failure and not an empty CRM: a
     sub-account whose contacts have never been put into a pipeline. Worth saying
     outright, because waiting will not change it. */
  if (LD.stage === 'all' && pool.length && !pool.some(l => l.hasOpportunity)) {
    return '<div class="empty"><b>Leads, but no opportunities</b>'
      + '<small>' + pool.length.toLocaleString() + ' lead'
      + (pool.length === 1 ? '' : 's')
      + ' here and not one in a pipeline. The stage cards are built on GHL '
      + '<b>Opportunities</b>, so contacts alone will not fill them — waiting will '
      + 'not change that. Move contacts into a pipeline in GHL.</small></div>';
  }

  if (LD.stage !== 'all') {
    return '<div class="empty"><b>Nothing at this stage</b>'
      + '<small>No opportunity is at ' + escL(LD.stage) + ' in this location.</small></div>';
  }

  return '<div class="empty"><b>No leads here</b>'
    + '<small>This sub-account has no leads in Supabase.</small></div>';
}


function drawLeadList(){
  const rows = ldVisible().sort((a, b) => b.sortKey - a.sortKey);
  const el = document.getElementById('ld-list');
  const searching = LD.q.trim().length >= 2;
  document.getElementById('ld-listcount').textContent =
    rows.length + (searching ? (rows.length === 1 ? ' match' : ' matches')
      : (rows.length === 1 ? ' lead' : ' leads'));
  document.getElementById('ld-listtitle').textContent =
    searching ? 'Search' : LD.stage === 'all' ? 'All stages' : LD.stage;
  drawLeadSearch();

  if (!rows.length) {
    /* A search that found nothing is a different empty than a pipeline with
       nothing in it, and emptyPipeline() would say the wrong thing about the
       sub-account. */
    el.innerHTML = searching
      ? '<div class="empty"><b>Nothing matches "' + escL(LD.q.trim()) + '"</b>'
        + '<small>' + (LD.qBusy ? 'Still checking the rest of the database…'
            : 'Searched every lead' + (LD.loc === 'all' ? '' : ' in this sub-account')
              + ' by name, email, phone, tag, owner and source.') + '</small></div>'
      : emptyPipeline();
    return;
  }

  const showLoc = LD.loc === 'all';
  /* Tone from GHL's status, which is the fact, rather than from a stage name
     this dashboard would have to guess the meaning of. */
  const toneOf = l => l.status === 'won' ? 'won'
    : (l.status === 'lost' || l.status === 'abandoned') ? 'lost'
    : l.hasOpportunity ? 'hot' : '';

  /* Tags are a list of unknown length in a cell of known width. Two, then a
     count -- "+3" is information; three tags cut off mid-word is not. */
  const tagCell = tags => {
    const list = (tags || []).filter(Boolean);
    if (!list.length) return '<span class="none">—</span>';
    return '<span class="ldtags">'
      + list.slice(0, 2).map(t => '<span class="ldtag">' + escL(t) + '</span>').join('')
      + (list.length > 2 ? '<span class="ldtag more" title="' + escL(list.join(', ')) + '">+'
          + (list.length - 2) + '</span>' : '')
      + '</span>';
  };

  /* The pane is the full width of the page until a lead is open, and half of it
     after. Six columns in half a pane is six ellipses, so the stacked row comes
     back when there is no room for the table. */
  if (LD.sel) {
    el.innerHTML = rows.map(l => {
      const loc = locById(l.loc);
      const t = THREADS[l.id] || [];
      const last = t[t.length - 1];
      const tone = toneOf(l);
      return '<div class="msg' + (l.unread ? ' unread' : '') + (LD.sel === l.id ? ' on' : '')
        + '" data-lead="' + l.id + '" style="--c:' + loc.color + '">'
        + '<div class="mr1"><span class="udot"></span><b>' + escL(l.name) + '</b>'
        + (showLoc ? '<span class="mtag">' + escL(loc.short) + '</span>' : '')
        + '<span class="tm">' + escL(l.last) + '</span></div>'
        + '<div class="msubj"><span class="lstage' + (tone ? ' ' + tone : '') + '">'
        + escL(stageLabel(l)) + '</span>'
        + '<span style="margin-left:8px;font-family:\'JetBrains Mono\',monospace;font-size:11.5px;color:var(--brass)">'
        + money(l.value) + '</span></div>'
        + '<div class="msnip">' + escL(last ? (last.dir === 'out' ? 'You: ' : '') + last.body : 'No messages yet') + '</div>'
        + '</div>';
    }).join('');
  } else {
    const cols = [
      ['Name', 'minmax(150px,1.5fr)'],
      ['Email', 'minmax(170px,1.6fr)'],
      ['Phone', 'minmax(130px,1fr)'],
      ['Tags', 'minmax(120px,1.1fr)'],
      ...(showLoc ? [['Account', 'minmax(90px,.8fr)']] : []),
      ['Stage', 'minmax(100px,.9fr)'],
      ['Value', '96px'],
      ['Last', '68px']
    ];
    const grid = cols.map(c => c[1]).join(' ');
    const numeric = new Set(['Value']);

    el.innerHTML = '<div class="ldtable">'
      + '<div class="ldhead" style="grid-template-columns:' + grid + '">'
      +   cols.map(c => '<span' + (numeric.has(c[0]) ? ' class="n"' : '') + '>' + c[0] + '</span>').join('')
      + '</div>'
      + rows.map(l => {
          const loc = locById(l.loc);
          const tone = toneOf(l);
          const cell = v => v ? escL(v) : '<span class="none">—</span>';
          return '<div class="ldrow' + (l.unread ? ' unread' : '') + '" data-lead="' + l.id + '" '
            + 'style="grid-template-columns:' + grid + ';--c:' + loc.color + '" tabindex="0">'
            + '<span><span class="udot"></span><span class="nm">' + escL(l.name) + '</span></span>'
            /* mailto and tel are what these are for; the row click still opens
               the lead, so the link stops the event rather than fighting it. */
            + '<span class="dim">' + (l.email
                ? '<a href="mailto:' + escL(l.email) + '" onclick="event.stopPropagation()">'
                  + escL(l.email) + '</a>' : '<span class="none">—</span>') + '</span>'
            + '<span class="mono">' + (l.phone
                ? '<a href="tel:' + escL(String(l.phone).replace(/[^\d+]/g, '')) + '" '
                  + 'onclick="event.stopPropagation()">' + escL(l.phone) + '</a>'
                : '<span class="none">—</span>') + '</span>'
            + '<span>' + tagCell(l.tags) + '</span>'
            + (showLoc ? '<span class="dim">' + escL(loc.short) + '</span>' : '')
            + '<span><span class="ldstage' + (tone ? ' ' + tone : '') + '">'
            +   escL(stageLabel(l)) + '</span></span>'
            + '<span class="n">' + (l.value ? money(l.value) : '<span class="none">—</span>') + '</span>'
            + '<span class="mono">' + cell(l.last) + '</span>'
            + '</div>';
        }).join('')
      + '</div>';
  }

  el.querySelectorAll('[data-lead]').forEach(b => {
    const open = () => {
      const l = LEADS.find(x => x.id === b.dataset.lead);
      if (!l) return;
      l.unread = false; LD.sel = l.id; drawLeads();
      loadThread(l.id);
    };
    b.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); open(); } };
    b.onclick = () => {
    const l = LEADS.find(x => x.id === b.dataset.lead);
    l.unread = false; LD.sel = l.id; drawLeads();
    /* Threads are fetched on open rather than with the list, for the same reason
       mail bodies are: one request per lead beats pulling every conversation
       nobody has asked to read. */
    loadThread(l.id);
    };
  });
}

/* Who the message goes out as.

   Numbers and addresses are mirrored onto the location by the sync job — the
   composer must not call GHL. Three states per channel, and they mean different
   things:

     not synced yet   senders is null. GHL will pick its own default.
     none available   synced, and the sub-account genuinely has no sender.
     one or many      show it, or offer the choice.

   Email has no picker because GHL exposes no list of verified senders — only the
   sub-account's own address. Inventing a dropdown there would imply a choice that
   does not exist. */
function senderControl(loc){
  /* Sends go out as the signed-in person. The address is stated rather than
     chosen, because the server takes it from the verified session and would
     ignore a different one picked here. */
  if (SEND_AS) return 'Sending as ' + escL(SEND_AS);
  const s = loc.senders;

  if (LD.channel === 'sms') {
    if (!s) return 'Sender unknown';
    const nums = s.numbers || [];
    /* GHL's sending numbers are not in the mirror, so there is nothing to pick
       from and nothing to warn about. GHL uses the sub-account default, which is
       what happened anyway whenever the old cache was cold. */
    if (!nums.length && s.numbersUnavailable) return 'GHL sends from this sub-account’s default number';
    if (!nums.length) {
      return '<span style="color:var(--rust)">No number added in GHL</span>';
    }
    if (nums.length === 1) {
      return 'From ' + escL(nums[0].label || nums[0].phoneNumber);
    }
    const chosen = LD.from && nums.some(n => n.phoneNumber === LD.from) ? LD.from : nums[0].phoneNumber;
    return 'From <select class="stagesel" id="ld-from">'
      + nums.map(n => '<option value="' + escL(n.phoneNumber) + '"'
          + (n.phoneNumber === chosen ? ' selected' : '') + '>'
          + escL(n.label || n.phoneNumber) + '</option>').join('')
      + '</select>';
  }

  if (LD.channel === 'email') {
    /* A dropdown, not free text: GHL rejects an unverified sender, and it would
       do so after the optimistic bubble had already claimed the mail was sent.
       The options are the addresses the location profile carries. With one, it is
       shown rather than hidden so the operator knows who the mail comes from. */
    const addrs = (s?.emails && s.emails.length) ? s.emails : (s?.email ? [s.email] : []);
    if (!addrs.length) return 'GHL picks its verified sender';
    if (addrs.length === 1) return 'From ' + escL(addrs[0]);
    const chosen = LD.from && addrs.includes(LD.from) ? LD.from : addrs[0];
    return 'From <select class="stagesel" id="ld-from">'
      + addrs.map(a => '<option value="' + escL(a) + '"'
          + (a === chosen ? ' selected' : '') + '>' + escL(a) + '</option>').join('')
      + '</select>';
  }

  /* WhatsApp and Facebook send as the connected asset, not as a number the API
     lets you choose between. */
  return 'Posts to ' + escL(loc.name);
}

/* Whether Send can do anything on this channel. Disabling beats letting GHL
   reject it after the fact. */
function canSend(loc){
  const s = loc.senders;
  if (!s) return true;                       // unknown; let GHL decide
  if (LD.channel === 'sms') {
    /* Unknown is not the same as none. Sending numbers are not mirrored, so
       disabling here would block every SMS on missing data rather than on a
       missing number. */
    return s.numbersUnavailable ? true : (s.numbers || []).length > 0;
  }
  /* Email always sends: GHL falls back to its verified default when no From is
     named, and refusing here would be refusing on a guess. */
  return true;
}

/* Custom values, attribution, notes, tasks and appointments — everything the
   Details tab shows that is not a column on the lead itself.

   Rendered from Supabase through /detail, so the field NAME comes from
   ghl_custom_field rather than from parsing a JSON blob, and every person is a
   name resolved through staff or ghl_user rather than an id nobody can read. */
function detailSections(l){
  const d = DETAIL[l.id];
  if (!d) return '<div class="fields"><div class="frow"><span class="k">Loading</span>'
    + '<span class="v" style="color:var(--dimmer)">reading Supabase…</span></div></div>';

  const rows = list => list.map(r =>
    '<div class="frow"><span class="k">' + escL(r[0]) + '</span>'
    + '<span class="v">' + escL(r[1]) + '</span></div>').join('');

  const block = (title, inner, empty) =>
    '<div class="dsec"><div class="dsech">' + escL(title) + '</div>'
    + (inner || '<div class="frow"><span class="v" style="color:var(--dimmer)">'
        + escL(empty) + '</span></div>')
    + '</div>';

  const out = [];

  out.push(block('Custom fields',
    rows(d.fields.map(f => [f.name, f.value])),
    'None recorded in GHL.'));

  /* Two rows, not one. First touch and last touch are the whole point of
     attribution, and collapsing them loses it: for one lead here that is
     folioexcel.com/#capture then folioexcel.com/. */
  const first = d.attribution.find(a => a.which === 'first');
  const last = d.attribution.find(a => a.which === 'last');
  const touch = (label, a) => a
    ? [[label, [a.source, a.campaign, a.url].filter(Boolean).join(' · ') || '(no detail)']]
    : [];
  out.push(block('Attribution',
    rows([...touch('First touch', first), ...touch('Last touch', last)]),
    'No attribution recorded.'));

  out.push(block('Appointments',
    rows(d.appointments.map(a => [
      [a.day, a.time].filter(Boolean).join(' '),
      [a.title, a.calendar, a.owner ? 'with ' + a.owner : null, a.status]
        .filter(Boolean).join(' · ')
    ])),
    'None booked.'));

  out.push(block('Tasks',
    rows(d.tasks.map(t => [
      t.done ? 'Done' : (t.due || 'No due date'),
      [t.title, t.assignee].filter(Boolean).join(' · ')
    ])),
    'None open.'));

  out.push(block('Notes',
    rows(d.notes.map(n => [
      n.at || '',
      (n.author ? n.author + ': ' : '') + String(n.body).slice(0, 200)
    ])),
    'None written.'));

  return out.join('');
}

/* Fetched once per lead and cached, because the Details tab is switched back and
   forth and none of this changes between two clicks. */
async function loadDetail(id){
  if (false || !id || DETAIL[id]) return;
  try {
    DETAIL[id] = await api('/api/ghl/leads/' + encodeURIComponent(id) + '/detail');
    if (LD.sel === id && LD.tab === 'fields') drawLeadDetail();
  } catch (err) {
    banner('Could not load the lead details: ' + err.message);
  }
}

function drawLeadDetail(){
  const el = document.getElementById('ld-detail');
  const wrap = document.getElementById('ld-wrap');
  const l = LEADS.find(x => x.id === LD.sel);

  if (!l || !ldVisible().includes(l)) {
    el.hidden = true; el.innerHTML = ''; wrap.classList.remove('split');
    return;
  }
  el.hidden = false; wrap.classList.add('split');
  const loc = locById(l.loc);

  const head =
    '<div class="ldhead"><div class="ldtop">'
      + '<span class="av" style="--c:' + loc.color + '">' + escL(initials(l.name)) + '</span>'
      + '<span class="ldwho"><h2>' + escL(l.name) + '</h2>'
        + '<div class="meta">' + escL(l.phone) + '  \u00b7  ' + escL(l.email) + '</div>'
        + '<div class="meta" style="color:' + loc.color + '">' + escL(loc.name) + '</div></span>'
      + '<span class="ldval"><b>' + (l.hasOpportunity === false ? '—' : money(l.value))
      + '</b><small>' + (l.hasOpportunity === false ? 'No opportunity' : 'Opportunity')
      + '</small></span>'
    + '</div>'
    + '<div class="ldacts">'
      /* A stage belongs to an opportunity, not to a person. Most leads are
         contacts who were never put into a pipeline, and for those there is
         nothing in GHL to move — so the control says that rather than offering a
         change the server would have to refuse. */
      + '<select class="stagesel" id="ld-stage"'
      + (l.hasOpportunity === false
          ? ' disabled title="No opportunity in GHL, so there is no stage to change. Create one in GHL first."'
            + ' style="opacity:.5;cursor:not-allowed"'
          : '') + '>'
      /* GHL's real stages for this location, by id. A stage with no id — which
         is what a card folded across pipelines has — cannot be a target, so
         "All locations" offers only the current stage until one is picked. */
      + (l.hasOpportunity === false
          ? '<option selected>No opportunity</option>'
          : STAGES.some(s => s.id)
            ? STAGES.filter(s => s.id).map(s =>
                '<option value="' + escL(s.id) + '"'
                + (s.id === l.stageId ? ' selected' : '') + '>'
                + escL(s.name) + '</option>').join('')
            : '<option selected>' + escL(l.stageName || 'No stage') + '</option>')
      + '</select>'
      + '<button class="btn" data-lact="call">Call</button>'
      + '<button class="btn" data-lact="task">Create task</button>'
      + '<button class="btn" data-lact="ghl">Open in GHL</button>'
    + '</div></div>';

  const tabs = '<div class="ldtabs">'
    + '<button class="ldtab' + (LD.tab === 'thread' ? ' on' : '') + '" data-ltab="thread">Conversation</button>'
    + '<button class="ldtab' + (LD.tab === 'fields' ? ' on' : '') + '" data-ltab="fields">Details</button>'
    + '</div>';

  let body;
  if (LD.tab === 'thread') {
    /* One chronological pass over three sources. Activity records render as a
       slim marker rather than a bubble: they are things GHL did, not things
       anyone said, and as bubbles they drown the conversation \u2014 one contact here
       has 34 messages and 18 activity records. */
    const items = [
      ...(THREADS[l.id] || []).map(m => ({ ...m, _kind: 'msg' })),
      ...(ACTIVITY[l.id] || []).map(a => ({ ...a, _kind: 'act' })),
      ...(PENDING[l.id] || []).map(p => ({ ...p, _kind: 'msg', _unconf: true }))
    ].sort((a, b) => (Date.parse(a.sentAt || 0) || 0) - (Date.parse(b.sentAt || 0) || 0));

    let lastDay = '';
    const msgs = items.map(m => {
      let sep = '';
      if (m.day && m.day !== lastDay) {
        sep = '<div class="daysep">' + escL(m.day) + '</div>';
        lastDay = m.day;
      }

      if (m._kind === 'act') {
        return sep + '<div class="actline"><span>' + escL(m.kind)
          + (m.time ? ' \u00b7 ' + escL(m.time) : '') + '</span></div>';
      }

      const ch = (CHANNELS.find(c => c.k === m.channel) || {}).label || m.channel;
      const tail = m.failed ? ' \u00b7 not sent'
                 : m.pending ? ' \u00b7 sending\u2026'
                 : m._unconf ? ' \u00b7 not yet reconciled'
                 : (m.dir === 'out' ? ' \u00b7 sent' : ' \u00b7 received');
      return sep + '<div class="bub ' + m.dir + (m.failed ? ' failed' : '') + '">'
        + '<span class="ch">' + ch + tail
        + (m.actor ? ' \u00b7 ' + escL(m.actor) : '')
        + (m.attachments ? ' \u00b7 ' + m.attachments + ' file' + (m.attachments === 1 ? '' : 's') : '')
        + '</span>'
        + (m.subject ? '<span class="subj2">' + escL(m.subject) + '</span>' : '')
        + escL(m.body) + '<span class="tm2">' + escL(m.time) + '</span></div>';
    }).join('');

    body = '<div class="thread">' + (msgs ||
        '<div class="empty"><b>No messages</b><small>Start the conversation below. '
        + 'It posts through GHL on the channel you pick.</small></div>') + '</div>'
      + '<div class="composer">'
        + '<div class="chanrow">' + CHANNELS.map(c =>
            '<button class="chan' + (LD.channel === c.k ? ' on' : '') + '" data-chan="' + c.k + '">'
            + c.label + '</button>').join('') + '</div>'
        /* The channel switches the form. Email needs a header set; SMS and
           WhatsApp do not, and showing Subject on an SMS would be a field that
           goes nowhere \u2014 GHL only reads it on an Email send. */
        + (LD.channel === 'email'
            ? '<div class="ehead">'
              + '<label>To<input id="ld-to" value="' + escL(l.email || '') + '"'
              + ' placeholder="nobody@example.com"></label>'
              + '<label>Cc<input id="ld-cc" placeholder="optional"></label>'
              + '<label>Bcc<input id="ld-bcc" placeholder="optional"></label>'
              + '<label class="wide">Subject<input id="ld-subj" placeholder="Required for email"></label>'
              + '</div>'
            : '')
        + '<textarea id="ld-msg" placeholder="Message ' + escL(l.name.split(' ')[0]) + ' by '
        + escL((CHANNELS.find(c => c.k === LD.channel) || {}).label) + '\u2026"></textarea>'
        + '<div class="crow"><button class="btn primary" data-lact="send"'
        + (canSend(loc) ? '' : ' disabled style="opacity:.45;cursor:not-allowed"') + '>Send</button>'
        + '<button class="btn" data-lact="note">Log a note</button>'
        + '<span class="cfrom" style="margin-left:auto">' + senderControl(loc) + '</span></div>'
      + '</div>';
  } else {
    const f = (k, v, key) => '<div class="frow"><span class="k">' + k + '</span><span class="v">'
      + (key ? '<input value="' + escL(v) + '" data-field="' + key + '">' : escL(v)) + '</span></div>';
    body = '<div class="thread" style="padding:0;display:block"><div class="fields">'
      + f('Name', l.name, 'name')
      + f('Phone', l.phone, 'phone')
      + f('Email', l.email, 'email')
      + f('Source', l.source)
      + f('Owner', l.owner, 'owner')
      + f('Created', l.created)
      + f('Value', money(l.value))
      + '<div class="frow"><span class="k">Tags</span><span class="v"><span class="tagrow">'
        + l.tags.map(t => '<span class="chip">' + escL(t) + '</span>').join('')
        + '</span></span></div>'
      + '<div class="frow"><span class="k">Sub-account</span><span class="v" style="color:'
        + loc.color + '">' + escL(loc.name) + '</span></div>'
      + f('GHL ID', l.ghlId)
      + '</div>'
      + detailSections(l)
      + '</div>';
  }

  el.innerHTML = head + tabs + body;

  el.querySelectorAll('[data-ltab]').forEach(b => b.onclick = () => {
    LD.tab = b.dataset.ltab;
    drawLeadDetail();
    /* After the redraw, so the tab switches instantly and the sections fill in
       when Supabase answers rather than holding the click. */
    if (LD.tab === 'fields') loadDetail(l.id);
  });
  el.querySelectorAll('[data-chan]').forEach(b => b.onclick = () => { LD.channel = b.dataset.chan; drawLeadDetail(); });

  /* Remembered across re-renders, so picking a second number does not snap back
     to the first the moment the pane redraws. */
  const fromSel = document.getElementById('ld-from');
  if (fromSel) fromSel.onchange = () => { LD.from = fromSel.value; };

  /* Stage moves carry the stage they are moving *from*. The server re-reads GHL
     and answers 409 if a workflow got there first, which is the one case where
     reverting is wrong — GHL is right and the screen was stale. */
  const sel = document.getElementById('ld-stage');
  if (sel) sel.onchange = async () => {
    const wasId = l.stageId;
    const wasName = l.stageName;
    const next = sel.value;
    if (!next || next === wasId) return;

    l.stageId = next;
    l.stageName = (STAGES.find(s => s.id === next) || {}).name || wasName;
    syncPulse('Stage updated');
    drawLeads();

    try {
      await api('/api/ghl/leads/' + encodeURIComponent(l.id), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        /* The stage it is moving FROM, so the server can answer 409 if a GHL
           workflow got there first — the one case where reverting is wrong,
           because GHL is right and the screen was stale. */
        body: JSON.stringify({ stageId: next, expectedStageId: wasId || '' })
      });
      await Promise.all([load(), loadStages()]);
    } catch (err) {
      if (err.status === 409 && err.body?.stageId) {
        l.stageId = err.body.stageId;
        l.stageName = err.body.stageName || l.stageName;
        banner('GHL had already moved this lead to ' + (err.body.stageName || 'another stage') + '.');
      } else {
        l.stageId = wasId;
        l.stageName = wasName;
        banner(err.message);
      }
      drawLeads();
    }
  };

  el.querySelectorAll('[data-field]').forEach(i => i.onchange = async () => {
    const field = i.dataset.field;
    const was = l[field];
    const next = i.value;
    if (next === was) return;

    l[field] = next;
    syncPulse('Saved');
    drawLeadList();

    try {
      await api('/api/ghl/leads/' + encodeURIComponent(l.id), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [field]: next })
      });
      await load();
    } catch (err) {
      l[field] = was;
      banner(err.message);
      drawLeads();
    }
  });

  el.querySelectorAll('[data-lact]').forEach(b => b.onclick = async () => {
    const a = b.dataset.lact;
    if (a === 'send') {
      const ta = document.getElementById('ld-msg');
      const text = ta.value.trim();
      if (!text) return;

      const isEmail = LD.channel === 'email';
      const subjEl = document.getElementById('ld-subj');
      const subject = subjEl ? subjEl.value.trim() : '';

      /* Blocked here as well as on the server, so the answer is instant and the
         cursor lands in the field that is wrong. */
      if (isEmail && !subject) {
        banner('Email needs a subject.');
        if (subjEl) subjEl.focus();
        return;
      }

      const val = id => { const e = document.getElementById(id); return e ? e.value.trim() : ''; };
      const list = v => v ? v.split(/[;,]/).map(x => x.trim()).filter(Boolean) : undefined;

      /* Painted first so the thread feels immediate, then confirmed. The row is
         held by identity so the failure path finds this one and not whichever
         row happens to be last by then. */
      const optimistic = { dir:'out', channel:LD.channel, body:text,
        subject: isEmail ? subject : null,
        day:'Today', time:new Date().toTimeString().slice(0,5),
        sentAt: new Date().toISOString(), pending:true };
      const thread = (THREADS[l.id] ||= []);
      thread.push(optimistic);
      const wasLast = l.last, wasKey = l.sortKey;
      l.last = 'now'; l.sortKey = Date.now();
      syncPulse('Sending…');
      drawLeads();

      try {
        const picker = document.getElementById('ld-from');
        await post('/api/ghl/leads/' + encodeURIComponent(l.id) + '/message', {
          channel: LD.channel,
          body: text,
          /* Email carries a rich body; SMS carries text. Sending HTML in the
             text field arrives as visible markup. */
          html: isEmail ? text.replace(/\n/g, '<br>') : undefined,
          subject: isEmail ? subject : undefined,
          to: isEmail ? (val('ld-to') || undefined) : undefined,
          cc: isEmail ? list(val('ld-cc')) : undefined,
          bcc: isEmail ? list(val('ld-bcc')) : undefined,
          from: picker ? picker.value : undefined
        });
        syncPulse('Sent via GHL');
        /* Reloads rather than patching the row in place: the server has the real
           message id and timestamp, and the stage may have moved in GHL. */
        await load();
      } catch (err) {
        /* Marked failed and left in place rather than removed. A message that
           silently vanishes reads as sent; one labelled "not sent" does not, and
           the text is still there to retry. */
        optimistic.pending = false;
        optimistic.failed = true;
        l.last = wasLast; l.sortKey = wasKey;
        banner('Not sent: ' + err.message);
        drawLeads();
        drawLeadDetail();
      }
      return;
    }
    /* These four used to flip their own label and flash "Saved" while doing
       nothing at all. Two of them can be made real without an endpoint; the other
       two say plainly that they are not built rather than claiming success. */

    if (a === 'call') {
      if (!l.phone) return banner('No phone number on this contact in GHL.');
      /* A tel: link is the honest version of a Call button. Click-to-call would
         need the location's telephony provider, which the API does not expose. */
      window.location.href = 'tel:' + l.phone.replace(/[^\d+]/g, '');
      return;
    }

    if (a === 'ghl') {
      if (!l.contactId) return banner('This lead has no contact record in GHL to open.');
      window.open('https://app.gohighlevel.com/v2/location/' + encodeURIComponent(l.loc)
        + '/contacts/detail/' + encodeURIComponent(l.contactId), '_blank', 'noopener');
      return;
    }

    banner(a === 'task'
      ? 'Creating GHL tasks is not built yet. Use Open in GHL for now.'
      : 'Logging notes is not built yet. Use Open in GHL for now.');
  });
}

let pulseTimer = null;
function syncPulse(msg){
  const el = document.getElementById('ld-synced');
  if (!el) return;
  el.classList.add('flash');
  el.innerHTML = '<span class="d"></span>' + escL(msg) + ' \u00b7 GHL';
  clearTimeout(pulseTimer);
  pulseTimer = setTimeout(() => { el.classList.remove('flash'); drawLeadHeader(); }, 1800);
}

function drawLeadHeader(){
  const el = document.getElementById('ld-synced');
  if (!el) return;

  /* Standing state, not a flash. syncPulse() borrows this element for 1.8s after
     a write and then calls back here, so this is what it reverts to. */
  el.onclick = null;
  el.style.cursor = '';
  el.title = '';

  /* Reports the INGEST pipeline, not a sync this dashboard runs. A stalled
     ingest is the only reason a lead would be out of date now, and it is the one
     thing worth surfacing here \u2014 but it is not actionable from this screen, so
     it is a statement rather than a button. */
  if (!LOCATIONS.length) {
    el.innerHTML = '';
  } else if (INGEST?.failing) {
    const bad = (INGEST.entities || []).find(e => e.status === 'error');
    el.innerHTML = '<span class="d" style="background:var(--rust)"></span>Ingest failing \u00b7 '
      + INGEST.failing;
    el.title = bad
      ? bad.entity + ': ' + (bad.error || 'no error was recorded')
      : 'Check the ingest pipeline.';
  } else if (INGEST?.stale) {
    /* Something ended in an error once and the pipeline has run past it. Worth
       being able to see; not worth a red line that never goes away. */
    const bad = (INGEST.entities || []).find(e => e.status === 'error');
    el.innerHTML = '<span class="d" style="background:var(--dimmer)"></span>Synced \u00b7 '
      + INGEST.stale + ' stale';
    el.title = bad
      ? bad.entity + ' last failed on '
        + (bad.at ? new Date(bad.at).toLocaleDateString() : 'an unknown date')
        + ' (' + (bad.error || 'no error was recorded')
        + ') and has not run since. Everything else has.'
      : 'An entity failed once and has not run since.';
  } else if (INGEST?.pending) {
    el.innerHTML = '<span class="d" style="background:var(--brass)"></span>'
      + INGEST.pending + ' never ingested';
    el.title = (INGEST.entities || []).filter(e => e.status === 'pending')
      .map(e => e.entity).join(', ') + ' \u2014 these have never completed in the ingest pipeline.';
  } else if (INGEST?.lastRun) {
    /* Jade explicitly: the CSS only greens the dot under .flash, which is the
       transient write confirmation, and this is the standing healthy state. */
    el.innerHTML = '<span class="d" style="background:var(--jade)"></span>Ingested \u00b7 '
      + INGEST.done + ' feeds';
    el.title = 'Last ingest run ' + INGEST.lastRun;
  } else {
    el.innerHTML = '<span class="d"></span>Reading Supabase';
  }
  document.getElementById('ld-title').textContent =
    LD.loc === 'all' ? 'All locations' : (locById(LD.loc) || {}).name || 'Leads';
  const pool = LEADS.filter(l => LD.loc === 'all' || l.loc === LD.loc);
  /* Open by GHL's status, not by a stage name \u2014 "Closed Won" sits at status open
     in this data, so the label and the fact disagree. */
  const open = pool.filter(l => l.hasOpportunity && !isClosed(l));
  const unread = pool.filter(l => l.unread).length;
  /* "in pipeline" means opportunities, which most leads do not have now that the
     list is every contact. Counting them separately stops \u20b10 reading as a broken
     integration when it just means nobody has been put into a pipeline. */
  const inPipeline = pool.filter(l => l.hasOpportunity);
  /* The location's own total, not the length of a capped list. */
  const totalLeads = LD.loc === 'all'
    ? LOCATIONS.reduce((n, l) => n + (l.leads || 0), 0)
    : (locById(LD.loc) || {}).leads || pool.length;

  document.getElementById('ld-sub').textContent = LOCATIONS.length
    ? totalLeads.toLocaleString() + ' leads \u00b7 '
      + inPipeline.length.toLocaleString() + ' with an opportunity \u00b7 '
      + open.length.toLocaleString() + ' open \u00b7 '
      + money(inPipeline.reduce((s, l) => s + l.value, 0)) + ' in pipeline'
      + (unread ? ' \u00b7 ' + unread + ' unread' : '')
    : 'No GHL data ingested yet.';
  const badge = document.querySelector('.navitem[data-target="leads"] .badge');
  if (badge) badge.textContent = LEADS.filter(l => l.unread).length || '';
}

function drawLeads(){ drawLeadSubnav(); drawLeadHeader(); drawStages(); drawLeadList(); drawLeadDetail(); }

/* ---------- leads: loaders ----------

   There is no connect flow, no first-sync progress sheet and no re-sync. All
   three belonged to a model where command-center held the GHL connection and
   discovered locations itself. It reads a mirror now: sub-accounts arrive from
   ghl_location and the only meaningful action left is re-reading it. */


/* Stage cards for whatever location is selected. Separate from load() because
   the counts come from every opportunity in the location, not from the capped
   lead list, and they only change when the selection does. */
async function loadStages(){
  if (false) return;
  try {
    const q = LD.loc === 'all' ? '' : '?location=' + encodeURIComponent(LD.loc);
    const out = await api('/api/ghl/stages' + q);
    STAGES = out.stages || [];
  } catch {
    /* Cards fall back to All only. Better than a row of stale stage names from
       a different location. */
    STAGES = [];
  }
  drawStages();
}

/* Ingest health, for the header marker. Read once per load; there is nothing to
   poll for because nothing here starts a run. */
async function loadIngest(){
  if (false) return;
  try {
    const out = await api('/api/ghl/sync');
    INGEST = out.ingest || null;
  } catch { /* the marker keeps its last state */ }
}

/* ---------- live updates ----------

   GET /api/ghl/events is an SSE stream of the database's own triggers: ids only,
   {tbl, op, location, contact, conversation}. The contract is incremental — an
   event names the row that changed and the browser fetches exactly that row.
   Nothing here refetches a list.

   Today only ghl_location INSERT is wired (a new sub-account appears in the
   sidebar without a reload, existing rows untouched). lead and ghl_message
   arrive in later steps and will branch off the same stream. */
function startLiveUpdates(){
  if (false || !window.EventSource) return;
    /* No EventSource. /api/ghl/events does not exist in this service — see the
     note above — and portal-realtime.js drives the refresh instead. */
  const es = { close(){}, addEventListener(){}, set onerror(_){}, set onopen(_){} };

  /* Events are queued and flushed together 400ms later. One lead changing is
     one fetch; the ingest pipeline re-upserting three thousand is ONE delta
     fetch rather than three thousand single ones. Either way nothing re-reads
     the whole database. */
  const Q = { leads: new Set(), threads: new Set(), stages: false, timer: null };
  const schedule = () => { Q.timer ||= setTimeout(flushLive, 400); };

  async function flushLive(){
    Q.timer = null;
    const leadIds = [...Q.leads]; Q.leads.clear();
    const threadIds = [...Q.threads]; Q.threads.clear();
    const stages = Q.stages; Q.stages = false;

    try {
      if (leadIds.length > 20) {
        /* Bulk change: one delta against the cursor. */
        const out = await api('/api/ghl/leads' + (GHL_CURSOR ? '?since=' + encodeURIComponent(GHL_CURSOR) : ''));
        if (out.delta) mergeLeads(out.leads || []); else LEADS = out.leads || [];
        advanceCursor(out);
      } else {
        for (const id of leadIds) {
          try {
            const out = await api('/api/ghl/leads/' + encodeURIComponent(id));
            if (out.lead) { mergeLeads([out.lead]); advanceCursor({ leads: [out.lead] }); }
          } catch (err) {
            /* 404 is a lead outside what this dashboard may see; not an error. */
            if (err.status !== 404) console.error('live: lead refetch failed', id, err.message);
          }
        }
      }
      if (leadIds.length) { saveLeadsCache(); drawLeadList(); drawLeadHeader(); }
    } catch (err) {
      console.error('live: lead update failed', err.message);
    }

    /* Only conversations already held, open now or read before and cached. A
       message for a lead nobody has opened costs nothing until they do. */
    for (const id of threadIds) {
      if (THREADS[id] || LD.sel === id) await loadThread(id);
    }

    if (stages) loadStages();
  }

  es.onmessage = async e => {
    let ev;
    try { ev = JSON.parse(e.data); } catch { return; }

    const leadId = ev.location && ev.contact ? ev.location + ':' + ev.contact : null;

    /* Task 5: a lead row changed, or its opportunity did, which is what puts
       stage and value on the card. */
    if (leadId && (ev.tbl === 'lead' || ev.tbl === 'ghl_opportunity')) {
      Q.leads.add(leadId);
      if (ev.tbl === 'ghl_opportunity') Q.stages = true;
      schedule();
      return;
    }

    /* Task 7: a message. That lead's thread, and that lead's row (last
       activity, unread) — nothing else. */
    if (leadId && (ev.tbl === 'ghl_message' || ev.tbl === 'ghl_message_inbox')) {
      Q.leads.add(leadId);
      Q.threads.add(leadId);
      schedule();
      return;
    }

    if (ev.tbl === 'ghl_location' && ev.op === 'INSERT' && ev.location) {
      /* Redelivery-safe: the trigger fires per row, but an id already on screen
         is a no-op rather than a duplicate sidebar entry. */
      if (locById(ev.location)) return;
      try {
        const out = await api('/api/ghl/locations/' + encodeURIComponent(ev.location));
        if (!out.location || locById(out.location.id)) return;
        LOCATIONS.push(out.location);
        saveLocationsCache();
        /* Only the surfaces the new row appears on. The lead list, the open
           conversation and everything else already loaded are left alone. */
        drawLeadSubnav();
        drawLeadHeader();
        syncPulse('New sub-account: ' + out.location.name);
      } catch (err) {
        console.error('live: could not fetch new location', err.message);
      }
    }
  };
  /* No onerror handling on purpose: EventSource reconnects itself, honouring
     the server's retry hint, and a transient drop needs no UI. */
}
/* Everything below ran at parse time in command-center. See the note above. */
function wireLeads(){
  mountLeadSubnav();
startLiveUpdates();

/* Re-reads Supabase. Not a re-sync: it asks the database what it holds now. */
{
  const box = document.getElementById('ld-q');
  const clear = document.getElementById('ld-qclear');
  if (box) {
    box.addEventListener('input', () => {
      LD.q = box.value;
      /* Drawn immediately from what is already loaded, so typing feels
         instant; the server call catches up behind it. */
      drawLeadList();
      drawLeadSearch();
      ldSearchLater();
    });
    box.addEventListener('keydown', e => {
      if (e.key === 'Escape' && LD.q) {
        e.preventDefault();
        box.value = ''; LD.q = ''; clearTimeout(LD.qTimer); LD.qBusy = false; drawLeads();
      }
    });
  }
  if (clear) clear.onclick = () => {
    if (box) box.value = '';
    LD.q = ''; clearTimeout(LD.qTimer); LD.qBusy = false;
    drawLeads();
    box?.focus();
  };
}

const refreshBtn = document.getElementById('ld-refresh');
  if (refreshBtn) refreshBtn.onclick = async e => {
  const b = e.currentTarget;
  b.textContent = 'Refreshing…'; b.disabled = true;
  try {
    /* Refresh means "read it all again", not "what changed": it is the one
       escape hatch if the cache ever disagrees with the database. */
    FORCE_FULL = true;
    await Promise.all([load(), loadStages(), loadIngest()]);
    syncPulse('Refreshed');
  } finally { FORCE_FULL = false; b.textContent = 'Refresh'; b.disabled = false; }
};

makeSplitter('ld-wrap', 'ld-gutter', 34);


}


let loading = false;

async function load(){
  if (loading) return;
  loading = true;
  /* So the first fetch after a reload can be a delta against the cached cursor
     rather than a full read of every lead. */
  await CACHE_READY;
  try {
    const [locs, leads, sync] = await Promise.allSettled([
      api('/api/ghl/locations'),
      /* Every location, every stage: both filters are applied in the browser,
         and a delta only makes sense over one stable set. ?since= asks for rows
         changed after the newest we hold; Refresh forces the full read. */
      api('/api/ghl/leads' + (GHL_CURSOR && !FORCE_FULL ? '?since=' + encodeURIComponent(GHL_CURSOR) : '')),
      api('/api/ghl/sync')
    ]);

    const val = (r, key, fallback) =>
      r.status === 'fulfilled' && r.value ? (r.value[key] ?? fallback) : fallback;

    /* An empty sidebar has two causes — an empty table and a failed query — and
       rendering both as "Not ingested yet" sends the reader debugging the
       ingest when the server could not reach the database at all. */
    GHL_ERR = locs.status === 'rejected'
      ? (locs.reason?.body?.detail || locs.reason?.message || 'request failed')
      : null;
    LOCATIONS = val(locs, 'locations', []);

    /* A delta merges into what is held; a full read replaces it. Either way the
       cursor advances and the cache is written, so the next reload paints from
       this and asks only for what follows. */
    if (leads.status === 'fulfilled' && leads.value) {
      if (leads.value.delta) mergeLeads(leads.value.leads || []);
      else LEADS = leads.value.leads || [];
      advanceCursor(leads.value);
      saveLeadsCache();
    }
    if (locs.status === 'fulfilled' && locs.value) saveLocationsCache();
    INGEST = val(sync, 'ingest', null);

    if (LD.sel && LEADS.some(l => l.id === LD.sel)) await loadThread(LD.sel);

    drawLeads();
    /* Stage cards last, and only after LOCATIONS is populated: the counts are
       scoped to the selected location and there is nothing to scope to before
       that. Not awaited, because the list should not wait on it. */
    loadStages();
    loadIngest();
  } catch (err) {
    banner('Could not load leads: ' + err.message);
    drawLeads();
  } finally {
    loading = false;
  }
}


async function loadThread(id){
  if (false || !id) return;

  /* Cached first, so opening a conversation you have read before is instant,
     then the network answer replaces it. */
  if (!THREADS[id]) {
    const c = await CC_CACHE.get('ghl:thread:' + id);
    if (c?.thread) {
      THREADS[id] = c.thread; ACTIVITY[id] = c.activity || []; PENDING[id] = c.pending || [];
      if (LD.sel === id) drawLeadDetail();
    }
  }

  try {
    const out = await api('/api/ghl/leads/' + encodeURIComponent(id) + '/thread');
    THREADS[id] = out.thread || [];
    ACTIVITY[id] = out.activity || [];
    PENDING[id] = out.pending || [];
    CC_CACHE.set('ghl:thread:' + id, { thread: THREADS[id], activity: ACTIVITY[id], pending: PENDING[id] });
    if (LD.sel === id) redrawDetailKeepingDraft();
  } catch (err) {
    banner('Could not load the conversation: ' + err.message);
  }
}

/* A live message arriving while a reply is half-typed must not wipe the reply.
   drawLeadDetail rebuilds the composer from scratch, so the draft is lifted out
   and put back. */
function redrawDetailKeepingDraft(){
  const keep = {};
  for (const id of ['ld-msg', 'ld-subj', 'ld-to', 'ld-cc', 'ld-bcc']) {
    const el = document.getElementById(id);
    if (el && el.value) keep[id] = el.value;
  }
  const active = document.activeElement?.id;
  drawLeadDetail();
  for (const [id, v] of Object.entries(keep)) {
    const el = document.getElementById(id);
    if (el) el.value = v;
  }
  if (active && keep[active]) document.getElementById(active)?.focus();
}

/* The OAuth callback returns to /#inbox?connected=<email> or ?error=<msg>. Show
   it once, then strip the query so a refresh does not repeat it. */

/* ---- mounting -----------------------------------------------------------

   command-center's markup is in the document from first paint and this code
   wired itself against it at parse time. The portal builds a view on
   navigation, so the markup is injected here and the wiring runs after.

   Changing brand is a different dataset, not a filter over the same one, so
   everything is dropped and refetched. */

const MARKUP = "  <section class=\"view on\" id=\"v-leads\">\n    <div class=\"vhead\">\n      <div><h1 id=\"ld-title\">All locations</h1><p id=\"ld-sub\">Reading from Supabase…</p></div>\n      <div style=\"display:flex;gap:8px;align-items:center\">\n        <!-- Searches every lead in scope, not the page on screen: the list is\n             capped at the most recently active few hundred and the one you are\n             looking for is usually not among them. -->\n        <div class=\"ldsearch\">\n          <span class=\"ic\">⌕</span>\n          <input id=\"ld-q\" type=\"search\" autocomplete=\"off\" spellcheck=\"false\"\n                 placeholder=\"Search name, email, phone, tag…\">\n          <button class=\"x\" id=\"ld-qclear\" hidden title=\"Clear\">×</button>\n        </div>\n        <span class=\"synced\" id=\"ld-synced\"></span>\n        <!-- Refresh only. There is nothing to connect and nothing to re-sync:\n             the ingest pipeline owns GHL -> Supabase, and this is a re-read. -->\n        <button class=\"btn\" id=\"ld-refresh\">Refresh</button>\n      </div>\n    </div>\n\n    <!-- Leads has its own banner. Errors used to route to the Inbox's, which is\n         inside a hidden view, so a failed send reported itself where nobody could\n         see it and read as \"nothing happened\". -->\n    <div class=\"err\" id=\"ld-banner\" hidden></div>\n\n    <div class=\"stagebar\" id=\"ld-stages\"></div>\n\n    <div class=\"mailwrap\" id=\"ld-wrap\">\n      <div class=\"card flush maillist\">\n        <div class=\"cardhead\"><h3 id=\"ld-listtitle\">Leads</h3><span class=\"eyebrow\" id=\"ld-listcount\">—</span></div>\n        <div id=\"ld-list\"></div>\n      </div>\n      <div class=\"gutter\" id=\"ld-gutter\" role=\"separator\" aria-orientation=\"vertical\"\n           aria-label=\"Resize lead list\" tabindex=\"0\" title=\"Drag to resize, double-click to reset\"></div>\n      <div class=\"card flush reader\" id=\"ld-detail\" hidden></div>\n    </div>\n  </section>\n\n  <!-- PROPERTIES -->";

let mounted = false;

function mount(el, opts){
  if (!el) return;
  const o = opts || {};
  const changed = o.companyId !== SCOPE_COMPANY;
  SCOPE_COMPANY = o.companyId || null;
  SCOPE_BRAND = o.brandName || '';

  /* Who the composer says it is sending as. Read from the session rather than
     passed in, so it cannot drift from the address the server will actually
     use — the server takes it from the same session and ignores the browser. */
  if (window.PortalSession) {
    window.PortalSession.getSession().then(function (sess) {
      const email = sess && sess.user && sess.user.email;
      if (email && email !== SEND_AS) { SEND_AS = email; if (LD.sel) drawLeadDetail(); }
    }).catch(function () {});
  }

  el.innerHTML = MARKUP;

  if (changed) {
    /* Every cached list, thread and cursor belongs to the brand it was read
       for. Keeping any of it across a switch is how one brand's leads end up
       under another's name. */
    LOCATIONS = [];
    LEADS = [];
    for (const k of Object.keys(THREADS)) delete THREADS[k];
    for (const k of Object.keys(ACTIVITY)) delete ACTIVITY[k];
    for (const k of Object.keys(PENDING)) delete PENDING[k];
    STAGES = [];
    GHL_CURSOR = null;
    GHL_ERR = null;
    INGEST = null;
    LD.sel = null; LD.loc = 'all'; LD.stage = 'all'; LD.q = '';
    ldSubEl = null;
  }

  wireLeads();
  drawLeads();
  load();
}

/* portal-realtime.js calls this when lead / ghl_message / ghl_opportunity
   changes. The cursor is dropped so the next read is a full one rather than a
   delta against a cursor that predates the change. */
function invalidate(){
  GHL_CURSOR = null;
  FORCE_FULL = true;
  load().finally(() => { FORCE_FULL = false; });
}

return { mount, invalidate, state: LD };
})();
