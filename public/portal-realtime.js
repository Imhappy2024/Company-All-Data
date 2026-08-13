/* ===========================================================================
   portal-realtime.js - keeps the portal in step with Supabase.

   A row changes -> a Postgres trigger POSTs /api/hooks/supabase -> the server
   fans the table name out over /api/events -> this file decides which views are
   now stale and refreshes the one you are actually looking at.

   Two rules that keep it cheap and correct:

     1. Only the VISIBLE view refetches. Everything else is marked dirty and
        refetches the next time you open it. A change to `loan` while you are on
        Properties costs nothing.

     2. On any reconnect, every view is marked dirty. The stream carries no
        replay buffer, so the client cannot know what it missed while the socket
        was down or the tab was hidden. Assuming the worst is the only correct
        answer, and it is cheap because only the visible view actually refetches.

   The event carries table names only. No row data ever reaches the browser this
   way, which is deliberate - RLS decides what a user may read, and this channel
   has no idea who is listening.

   Exposes window.PortalRealtime. No dependencies.
   =========================================================================== */
(function () {
  'use strict';

  /* -----------------------------------------------------------------------
     Which portal views depend on which Supabase tables.

     Derived from what each view actually reads. Keep it in sync when you add a
     query: a missing entry is a silently stale screen, a wrong entry is a
     pointless refetch. '*' means every view - use it only for tables that change
     the shape of the whole app (the tenant, the brand list, who can see what).
  ----------------------------------------------------------------------- */
  var TABLE_VIEWS = {
    /* real estate */
    property: ['properties', 'overview'],
    unit: ['properties'],
    property_financials: ['properties', 'overview'],
    property_comment: ['properties'],
    property_vendor: ['properties'],
    ownership: ['properties'],
    vendor: ['properties'],
    entity: ['properties', 'loans'],
    entity_owner: ['properties'],

    /* debt */
    loan: ['loans', 'overview'],
    loan_balance: ['loans'],
    loan_collateral: ['loans'],
    guarantor: ['loans'],
    reporting_requirement: ['loans'],

    /* risk + capital */
    insurance_policy: ['insurance', 'overview'],
    investor: ['investors'],
    investor_stake: ['investors'],

    /* growth */
    lead: ['leads', 'overview'],
    lead_provider: ['leads'],
    appointment: ['appointments'],
    contact: ['leads'],
    deal: ['leads'],
    communication: ['leads'],
    meta_ads_insight: ['ads'],
    leadli_marketing_daily: ['ads'],

    /* money */
    financial_account: ['financials'],
    account_balance: ['financials'],
    transaction: ['financials'],
    transaction_category: ['financials'],
    statement: ['financials', 'documents'],

    /* people + org */
    /* staff drives 'access' too: it IS the dashboard user record, so an invite, a
       revoke or a role change is a staff write. dashboard_permission is the grant
       rows behind the same screen. Without both, Users & Roles keeps painting a
       cached list after somebody else has changed who can see what - and that is the
       one screen where a stale answer is a security answer.
       dashboard_module is deliberately NOT bound: the catalog is seeded by migration
       rather than edited in the app, and PortalUsers.invalidate() does not clear it,
       so binding it would schedule a refresh that could not actually refresh it. */
    staff: ['team', 'orgdept', 'access'],
    dashboard_permission: ['access'],
    staff_company: ['team'],
    profiles: ['team'],
    department: ['departments', 'orgdept'],
    department_member: ['departments', 'orgdept'],
    department_tool: ['departments', 'tools'],
    org_role: ['orgdept'],
    tool: ['tools'],
    tool_user: ['tools'],

    /* saas + services */
    subscription_plan: ['plans'],
    subscription_client: ['subscribers'],
    service: ['services'],
    service_client: ['services'],
    service_engagement: ['services'],

    /* misc */
    document: ['documents'],
    task: ['tasks'],
    integrations: ['integrations'],

    /* structural - changes the switcher counts and the brand list */
    company: ['*'],
    company_member: ['*'],
    tenant: ['*'],
    tenant_member: ['*'],
  };

  /* -----------------------------------------------------------------------
     State
  ----------------------------------------------------------------------- */

  var host = null;          /* {currentView, rerender, invalidate, indicator} */
  var es = null;
  var dirty = {};           /* view id -> true */
  var backoff = 1000;
  var MAX_BACKOFF = 30000;
  var everConnected = false;
  var serverStart = null;
  var reconnectTimer = null;
  var stopped = false;

  function log() {
    if (!window.__PORTAL_RT_DEBUG) return;
    console.log.apply(console, ['[realtime]'].concat([].slice.call(arguments)));
  }

  function viewsFor(tables) {
    var out = {}, all = false;
    tables.forEach(function (t) {
      var vs = TABLE_VIEWS[t];
      if (!vs) { log('no view binding for table', t); return; }
      vs.forEach(function (v) { if (v === '*') all = true; else out[v] = true; });
    });
    return { views: Object.keys(out), all: all };
  }

  function markAllDirty(why) {
    log('marking every view dirty:', why);
    Object.keys(TABLE_VIEWS).forEach(function (t) {
      TABLE_VIEWS[t].forEach(function (v) { if (v !== '*') dirty[v] = true; });
    });
    if (host && host.invalidate) host.invalidate('*');
    refreshIfVisible();
  }

  function onTables(tables) {
    var r = viewsFor(tables);
    if (r.all) { markAllDirty('structural table changed'); return; }
    if (!r.views.length) return;
    r.views.forEach(function (v) { dirty[v] = true; });
    if (host && host.invalidate) r.views.forEach(function (v) { host.invalidate(v); });
    refreshIfVisible();
  }

  function refreshIfVisible() {
    if (!host || !host.currentView) return;
    var v = host.currentView();
    if (!v || !dirty[v]) return;
    delete dirty[v];
    log('refreshing visible view', v);
    try { host.rerender(); } catch (e) { console.error('[realtime] rerender threw', e); }
    indicate();
  }

  /* A quiet mark, not a toast. This fires whenever anyone edits anything; a
     popup every time would be unusable. */
  function indicate() {
    var el = host && host.indicator && document.getElementById(host.indicator);
    if (!el) return;
    el.textContent = 'Updated just now';
    el.hidden = false;
    clearTimeout(el.__rt);
    el.__rt = setTimeout(function () { el.hidden = true; }, 4000);
  }

  /* -----------------------------------------------------------------------
     Connection
  ----------------------------------------------------------------------- */

  function connect() {
    if (stopped || es || document.hidden) return;
    if (typeof EventSource === 'undefined') { log('EventSource unsupported; realtime off'); return; }

    try { es = new EventSource('/api/events'); }
    catch (e) { log('could not open stream', e); scheduleReconnect(); return; }

    es.addEventListener('hello', function (ev) {
      var d = {};
      try { d = JSON.parse(ev.data); } catch (e) { /* ignore */ }
      var restarted = serverStart && d.serverStart && d.serverStart !== serverStart;
      serverStart = d.serverStart || serverStart;
      backoff = 1000;
      /* First connection of the page's life needs no invalidation - the views
         were just loaded. Every later one does, because we cannot know what we
         missed. */
      if (everConnected) markAllDirty(restarted ? 'server restarted' : 'reconnected');
      everConnected = true;
      log('connected', d);
    });

    es.onmessage = function (ev) {
      var d;
      try { d = JSON.parse(ev.data); } catch (e) { return; }
      if (!d || !Array.isArray(d.tables)) return;
      log('tables changed', d.tables);
      onTables(d.tables);
    };

    es.onerror = function () {
      /* EventSource retries on its own, but with no cap and no visibility. Own
         it: close, back off, reopen. */
      log('stream error, backing off', backoff);
      closeStream();
      scheduleReconnect();
    };
  }

  function closeStream() {
    if (!es) return;
    try { es.close(); } catch (e) { /* ignore */ }
    es = null;
  }

  function scheduleReconnect() {
    if (stopped || reconnectTimer || document.hidden) return;
    reconnectTimer = setTimeout(function () {
      reconnectTimer = null;
      connect();
    }, backoff);
    backoff = Math.min(backoff * 2, MAX_BACKOFF);
  }

  /* A hidden tab holding an open stream is a connection the server has to ping
     forever for nothing. Drop it, and reconnect (marking everything dirty) when
     the user comes back. */
  function onVisibility() {
    if (document.hidden) {
      log('tab hidden, closing stream');
      closeStream();
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    } else {
      backoff = 1000;
      connect();
    }
  }

  /* -----------------------------------------------------------------------
     Public surface
  ----------------------------------------------------------------------- */

  function start(opts) {
    opts = opts || {};
    if (typeof opts.currentView !== 'function' || typeof opts.rerender !== 'function') {
      console.error('[realtime] start() needs currentView() and rerender()');
      return;
    }
    host = opts;
    stopped = false;
    document.addEventListener('visibilitychange', onVisibility);
    connect();
  }

  function stop() {
    stopped = true;
    closeStream();
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    document.removeEventListener('visibilitychange', onVisibility);
  }

  window.PortalRealtime = {
    start: start,
    stop: stop,
    /* Call after painting a view so it stops being considered stale. */
    markClean: function (view) { delete dirty[view]; },
    isDirty: function (view) { return !!dirty[view]; },
    dirtyViews: function () { return Object.keys(dirty); },
    connected: function () { return !!es; },
    tableViews: TABLE_VIEWS,
  };
})();
