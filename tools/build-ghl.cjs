/* Assemble portal-ghl.js from command-center's actual Leads code.

   This is a TRANSPLANT, not a re-implementation. The four pieces below are
   lifted verbatim out of command-center's public/index.html; everything this
   script does is the minimum needed to make them run inside the portal.

   The first attempt at this screen was written from scratch to "the same
   layout", which is not the same thing and did not look like it. */

const fs = require('fs');
const path = require('path');

/* The exact slices lifted out of command-center, kept beside this script so
   the port is reproducible without re-cloning that repo. */
const SRC = process.env.CC_LEADS || path.join(__dirname, 'ghl-source');
const read = f => fs.readFileSync(path.join(SRC, f), 'utf8');

const helpers = read('p1-helpers.txt');   // initials, makeSplitter
const apiSrc  = read('p3-api.txt');       // api, post, BANNERS, activeView, banner
const leads   = read('p2-leads.txt');     // the whole LEADS section
const thread  = read('p4-thread.txt');    // loadThread, redrawDetailKeepingDraft
/* .view is display:none until it carries .on — command-center's own view
   switcher adds it. There is no view switcher here (the portal is the
   switcher), so the section ships already open. Without this the whole screen
   renders and is invisible, which is indistinguishable from a failed fetch. */
const markup  = read('ld.html.txt')
  .replace('<section class="view" id="v-leads">', '<section class="view on" id="v-leads">');

const misses = [];
function edit(src, needle, repl, label) {
  const n = src.split(needle).length - 1;
  if (n !== 1) { misses.push(label + ' (' + n + ')'); return src; }
  return src.replace(needle, () => repl);
}

/* ---- 1. the API helper carries the brand -------------------------------- */

let api = apiSrc;

api = edit(api, `async function api(url, options){
  const r = await fetch(url, options);`,
`/* Every /api/ghl call carries the current brand. Injecting it HERE rather than
   at the ~10 call sites is what makes it impossible to forget on one of them —
   and forgetting on one is how another brand's leads reach the screen. */
async function api(url, options){
  url = scopeUrl(url);
  const r = await fetch(url, options);`, 'api scope');

api = edit(api, `const post = (url, body) => api(url, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body || {})
});`,
`/* No post. This service holds no GHL credential, so every write path in the
   transplanted code below is neutralised rather than left to fail against a
   404. Calling it is a bug, so it says so instead of silently no-opping. */
const post = () => Promise.reject(new Error('This dashboard is read-only: no GHL credential is configured.'));`,
'post');

/* One banner, not a map across views. */
api = edit(api, `const BANNERS = { inbox: 'ib-banner', leads: 'ld-banner' };`,
  `const BANNERS = { leads: 'ld-banner' };`, 'BANNERS');
api = api.replace(/function activeView\(\)\{[\s\S]*?\n\}/, () =>
  `/* The portal only ever mounts the Leads view from this module. */
function activeView(){ return 'leads'; }`);
api = edit(api, `    || document.getElementById(BANNERS.inbox);`,
  `    || document.getElementById(BANNERS.leads);`, 'banner fallback');

/* The api/banner extract runs from line 16560 and picks up a little Inbox
   wiring on the way. #ib-demo is the Inbox's demo toggle; it does not exist
   here and toggleDemo is not coming across, so the line throws at parse time
   and takes the whole IIFE with it — window.PortalGHL never gets defined. */
/* p1-helpers.txt is trimmed at source to initials + makeSplitter. */

/* ---- 2. the LEADS block ------------------------------------------------- */

let ld = leads;

/* CAL is the calendar view's state and is not coming across. Only .demo is
   read, and it is always false here.

   The fold runs over the ASSEMBLED file at the bottom, not here. The first
   version did it here, on `ld` alone, and missed the CAL.demo inside
   loadThread — which comes from a different extract. Opening a lead then threw
   "CAL is not defined" and the screen reported it as "Could not load leads",
   naming neither the real cause nor the file. Anything that has to hold across
   all four extracts belongs after they are joined. */

/* The composer. Everything it does is a POST, and there is no credential. The
   thread stays; the reply box becomes a line saying why it is not there. */
ld = edit(ld, `      + '<div class="composer">'
        + '<div class="chanrow">' + CHANNELS.map(c =>
            '<button class="chan' + (LD.channel === c.k ? ' on' : '') + '" data-chan="' + c.k + '">'
            + c.label + '</button>').join('') + '</div>'`,
`      /* READ-ONLY. command-center composes here because it holds a GHL Private
         Integration Token per location; this service holds none, so the
         controls are absent rather than present and failing. */
      + '<div class="composer readonly">'
        + '<div class="chanrow">' + CHANNELS.map(c =>
            '<span class="chan' + (LD.channel === c.k ? ' on' : '') + '">'
            + c.label + '</span>').join('') + '</div>'`, 'composer chanrow');

const composerTail = ld.indexOf(`        + (LD.channel === 'email'`);
const composerEnd  = ld.indexOf(`      + '</div>';`, composerTail);
if (composerTail < 0 || composerEnd < 0) misses.push('composer body');
else {
  ld = ld.slice(0, composerTail) +
`        + '<div class="ronote">Replying is not available here: this dashboard reads '
        + 'the GHL mirror in Supabase and holds no GHL send credential. '
        + 'Messages arrive through the n8n pipeline.</div>'
` + ld.slice(composerEnd);
}

/* Live updates. command-center's /api/ghl/events is a Postgres NOTIFY fan-out
   that this service does not run, and an EventSource pointed at a 404 retries
   forever. portal-realtime.js already refreshes this view on lead/ghl_* change,
   so the subscription is dropped rather than reimplemented. */
ld = ld.replace(/const es = new EventSource\('\/api\/ghl\/events'\);/,
`  /* No EventSource. /api/ghl/events does not exist in this service — see the
     note above — and portal-realtime.js drives the refresh instead. */
  const es = { close(){}, addEventListener(){}, set onerror(_){}, set onopen(_){} };`);

/* The sub-account list hangs off command-center's own left nav
   (.navitem[data-target="leads"]), which does not exist here — the portal owns
   the nav. It moves inside the section, above the stage bar, so the location
   selector is still there and still works. Each brand has exactly one
   sub-account today, so it is mostly an "All locations" row; it earns its place
   the day a brand gets a second one. */
ld = edit(ld,
`function mountLeadSubnav(){
  const item = document.querySelector('.navitem[data-target="leads"]');
  if (!item) return;
  ldSubEl = document.createElement('div');
  ldSubEl.className = 'subnav';
  ldSubEl.hidden = true;
  item.after(ldSubEl);
  document.querySelectorAll('.navitem').forEach(b =>
    b.addEventListener('click', () => { ldSubEl.hidden = b.dataset.target !== 'leads'; }));
}`,
`function mountLeadSubnav(){
  const stages = document.getElementById('ld-stages');
  if (!stages) return;
  /* Rebuilt on every mount, so a re-entry cannot leave two of them. */
  const old = document.getElementById('ld-subnav');
  if (old) old.remove();
  ldSubEl = document.createElement('div');
  ldSubEl.className = 'subnav';
  ldSubEl.id = 'ld-subnav';
  stages.before(ldSubEl);
}`, 'mountLeadSubnav');

/* command-center prices in pesos. This portfolio is in dollars, and an
   opportunity value rendered with the wrong symbol is a wrong number. */
ld = edit(ld, "const money = n => '\\u20b1' + n.toLocaleString();",
  "const money = n => '$' + n.toLocaleString();", 'money symbol');

/* ---- the parse-time wiring moves into wireLeads() ----------------------

   command-center runs all of this at parse time against markup that is in the
   document from first paint. The portal injects the markup in mount(), so
   these have to run after it — and mount() runs on every navigation back, so
   they must be safe to run twice. */

ld = edit(ld, '\nmountLeadSubnav();\n', '\n', 'mountLeadSubnav call');

const wireFrom = ld.indexOf('startLiveUpdates();');
if (wireFrom < 0) misses.push('startLiveUpdates call');
else {
  const tailSrc = ld.slice(wireFrom);
  ld = ld.slice(0, wireFrom) +
`/* Everything below ran at parse time in command-center. See the note above. */
function wireLeads(){
  mountLeadSubnav();
` + tailSrc
      /* The refresh button is not guaranteed to exist the instant this runs. */
      .replace("document.getElementById('ld-refresh').onclick =",
               "const refreshBtn = document.getElementById('ld-refresh');\n  if (refreshBtn) refreshBtn.onclick =")
    + '\n}\n';
}

/* ---- a Leads-only load() ------------------------------------------------

   command-center's load() is its APP-wide loader: mail, calendar, social, ads
   and leads in one Promise.allSettled. Porting it whole would drag in Inbox,
   Calendar and Social. This is its GHL third, with the same delta/cursor/cache
   behaviour and the same "one failure does not blank the others" shape. */

ld += `

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
`;

/* ---- 3. assemble -------------------------------------------------------- */

const HEAD = `/* Leads (GHL) — command-center's Leads screen, transplanted.

   This file is command-center's actual implementation, not a rewrite of it:
   the LEADS section of its public/index.html (1,214 lines) plus the four
   helpers it reaches out to — initials, makeSplitter, api/banner, loadThread.
   Assembled by .build-ghl.cjs so the diff against the original stays readable.

   ---------------------------------------------------------------------------
   WHAT CHANGED, AND ONLY THIS

   1. \`api()\` injects \`company_id\` into every /api/ghl URL. That is the brand
      scope, and putting it in the one helper every call already goes through is
      what makes it impossible to omit on one of them.

   2. \`post()\` throws. This service holds no GHL credential, so the composer is
      replaced by a line saying why, and any write path that survives says so
      loudly rather than 404ing quietly.

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

function scopeUrl(url){
  if (typeof url !== 'string' || url.indexOf('/api/ghl') !== 0) return url;
  if (!SCOPE_COMPANY) return url;
  return url + (url.indexOf('?') >= 0 ? '&' : '?') + 'company_id=' + encodeURIComponent(SCOPE_COMPANY);
}

`;

const TAIL = `

/* ---- mounting -----------------------------------------------------------

   command-center's markup is in the document from first paint and this code
   wired itself against it at parse time. The portal builds a view on
   navigation, so the markup is injected here and the wiring runs after.

   Changing brand is a different dataset, not a filter over the same one, so
   everything is dropped and refetched. */

const MARKUP = ${JSON.stringify(markup)};

let mounted = false;

function mount(el, opts){
  if (!el) return;
  const o = opts || {};
  const changed = o.companyId !== SCOPE_COMPANY;
  SCOPE_COMPANY = o.companyId || null;
  SCOPE_BRAND = o.brandName || '';

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
`;

let out = HEAD + api + '\n\n' + helpers + '\n\n' + ld + '\n\n' + thread + TAIL;

/* ---- whole-file folds ---------------------------------------------------
   These have to hold across every extract, so they run once, here, after the
   pieces are joined. Doing them per-piece is what let CAL.demo survive inside
   loadThread. */

out = out.replace(/CAL\.demo/g, 'false');

/* Any surviving CAL is a ReferenceError the moment that code path runs, and
   the screen reports it as "Could not load leads" with nothing pointing at the
   cause. Fail the build instead of shipping it. */
{
  const body = out.split('\n');
  const stray = body.filter((l, i) =>
    /\bCAL\b/.test(l) &&
    !/^\s*(\*|\/\*|\/\/)/.test(l) &&        /* not a comment line */
    !/CAL is the calendar|CAL\.demo` folds/.test(l));
  if (stray.length) misses.push('stray CAL reference: ' + stray[0].trim().slice(0, 70));
}

if (misses.length) {
  console.error('MISSED: ' + misses.join(', '));
  process.exit(1);
}

fs.writeFileSync(path.join(__dirname, '..', 'public', 'portal-ghl.js'), out);
console.log('wrote public/portal-ghl.js  (' + out.split('\n').length + ' lines)');
