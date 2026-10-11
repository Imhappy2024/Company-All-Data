/* ===========================================================================
   portal-home.js — Home: tasks across every business, in one place.

   My tasks   assigned to the signed-in person, grouped Overdue / Today /
              This week / Later (then No due date), earliest due first,
              overdue dates in red.
   All tasks  every space and list the person can access in ClickUp, grouped
              by list.

   Data: GET /api/home/tasks with the person's OWN ClickUp sign-in
   (PortalAuth.authedFetch). Never a shared token: not connected means one
   "Connect ClickUp" button. Cached for the session (sessionStorage) and
   refreshed in the background, so returning to Home is instant.

   The grouping functions are pure and exported for Node (test/test-home.js).
   =========================================================================== */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PortalHome = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var TZ = 'America/Chicago';
  var MN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  /* YYYY-MM-DD of an instant, in the business's time zone */
  function dayOf(msv) { return new Date(msv).toLocaleDateString('en-CA', { timeZone: TZ }); }
  function addDays(day, n) { var d = new Date(day + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
  function fmtDue(msv, today) {
    if (msv === null || msv === undefined) return '–';
    var d = dayOf(msv), y = d.slice(0, 4);
    return MN[+d.slice(5, 7) - 1] + ' ' + (+d.slice(8, 10)) + (y !== String(today).slice(0, 4) ? ', ' + y : '');
  }
  function bucket(msv, today) {
    if (msv === null || msv === undefined) return 'No due date';
    var d = dayOf(msv);
    return d < today ? 'Overdue' : d === today ? 'Today' : d <= addDays(today, 7) ? 'This week' : 'Later';
  }
  var byDue = function (a, b) {
    var x = a.due === null || a.due === undefined ? Infinity : a.due, y = b.due === null || b.due === undefined ? Infinity : b.due;
    return x - y || String(a.name).localeCompare(String(b.name));
  };

  /* Pure: the rows for one view. Each task id appears once whatever the input. */
  function groupMine(tasks, meId, today) {
    var seen = {}, mine = [];
    tasks.forEach(function (t) {
      if (seen[t.id]) return;
      if ((t.assignees || []).some(function (a) { return String(a.id) === String(meId); })) { seen[t.id] = true; mine.push(t); }
    });
    mine.sort(byDue);
    var out = [];
    ['Overdue', 'Today', 'This week', 'Later', 'No due date'].forEach(function (g) {
      var ks = mine.filter(function (t) { return bucket(t.due, today) === g; });
      if (ks.length) out.push({ group: g, tasks: ks });
    });
    return { groups: out, count: mine.length, overdue: (out.find(function (g) { return g.group === 'Overdue'; }) || { tasks: [] }).tasks.length };
  }
  function groupAll(tasks) {
    var seen = {}, lists = {};
    tasks.forEach(function (t) {
      if (seen[t.id]) return; seen[t.id] = true;
      var k = t.list || 'No list';
      (lists[k] = lists[k] || []).push(t);
    });
    var names = Object.keys(lists).sort(function (a, b) { return lists[b].length - lists[a].length || a.localeCompare(b); });
    var count = 0;
    var groups = names.map(function (n) { lists[n].sort(byDue); count += lists[n].length; return { group: n, tasks: lists[n] }; });
    return { groups: groups, count: count, lists: names.length };
  }

  /* ---- browser ----------------------------------------------------------- */
  var S = { host: null, view: 'mine', data: null, error: '', loading: false, connect: false, onCounts: null, retries: 0 };
  var MAX_STALE_RETRIES = 3;
  var CACHE_KEY = 'lwHomeTasks';

  function esc(s) {
    return String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function today() { return dayOf(Date.now()); }
  function readCache() { try { var v = sessionStorage.getItem(CACHE_KEY); return v ? JSON.parse(v) : null; } catch (e) { return null; } }
  function writeCache(d) { try { sessionStorage.setItem(CACHE_KEY, JSON.stringify(d)); } catch (e) { /* storage full or blocked */ } }

  function signedIn() { return !!(typeof window !== 'undefined' && window.PortalAuth && window.PortalAuth.isSignedIn && window.PortalAuth.isSignedIn()); }

  function load(fresh) {
    if (S.loading) return;
    if (!signedIn()) { S.connect = true; paint(); return; }
    S.loading = true;
    var t0 = window.PortalLoader ? window.PortalLoader.now() : 0;
    /* The dashboard session (Authorization) plus the person's own ClickUp
       token. Plain fetch, not PortalAuth.fetch: that one signs the person out
       of ClickUp on any 401, and a 401 here can be the dashboard session. */
    var cu = null; try { cu = localStorage.getItem('du_auth_token'); } catch (e) { /* storage blocked */ }
    var withSession = window.PortalSession && window.PortalSession.authHeaders
      ? window.PortalSession.authHeaders({ Accept: 'application/json' }) : Promise.resolve({ Accept: 'application/json' });
    withSession.then(function (h) { if (cu) h['X-ClickUp-Token'] = cu; return fetch('/api/home/tasks' + (fresh ? '?fresh=1' : ''), { headers: h, credentials: 'include' }); })
      .then(function (r) { return r.json().then(function (j) { if (!r.ok) { var e = new Error(j.error || ('HTTP ' + r.status)); e.connect = !!j.connect; throw e; } return j; }); })
      .then(function (d) {
        var done = function () {
          S.data = d; S.error = ''; S.connect = false; writeCache(d); S.loading = false; counts(); paint();
          /* the server answered from its cache: ask again once it has refreshed,
             a few times at most, and only while Home is on screen */
          if (!d.stale || d.refreshFailed) { S.retries = 0; return; }
          if (S.retries >= MAX_STALE_RETRIES) return;
          S.retries++;
          setTimeout(function () { if (S.host && document.body.contains(S.host)) load(false); }, 8000 * S.retries);
        };
        if (window.PortalLoader) window.PortalLoader.settle(t0, done); else done();
      }, function (e) { S.loading = false; if (e.connect) S.connect = true; else S.error = e.message; paint(); });
  }

  function counts() {
    if (!S.data || !S.onCounts) return;
    S.onCounts({ mine: groupMine(S.data.tasks, S.data.me.id, today()).count, all: groupAll(S.data.tasks).count });
  }

  var IN_TONE = { 'in progress': 'acc', 'in review': 'warn', 'off track': 'bad' };
  function statusPill(st) {
    var tone = IN_TONE[String(st || '').toLowerCase()] || 'neutral';
    return '<span class="hm-pill hm-' + tone + '">' + esc(st || '–') + '</span>';
  }
  function priorityCell(p) {
    var lab = { urgent: 'Urgent', high: 'High', normal: 'Normal', low: 'Low' }[p] || null;
    if (!lab) return '<span class="hm-muted">–</span>';
    return '<span class="hm-pr hm-pr-' + p + '"><i></i>' + lab + '</span>';
  }
  function row(t, td) {
    var overdue = t.due !== null && t.due !== undefined && dayOf(t.due) < td;
    return '<tr><td class="hm-task"><a href="' + esc(t.url) + '" target="_blank" rel="noopener">' + esc(t.name) + '</a></td>' +
      '<td class="hm-muted">' + esc(t.list) + '</td><td>' + statusPill(t.status) + '</td><td>' + priorityCell(t.priority) + '</td>' +
      '<td class="' + (overdue ? 'hm-overdue' : '') + '">' + esc(fmtDue(t.due, td)) + '</td>' +
      '<td><span class="hm-people">' + (t.assignees || []).map(function (a) { return '<span class="hm-av" title="' + esc(a.name) + '">' + esc(a.initials) + '</span>'; }).join('') + '</span></td></tr>';
  }

  function paint() {
    if (!S.host || !document.body.contains(S.host)) return;
    var html;
    var title = S.view === 'mine' ? 'My tasks' : 'All tasks';
    if (S.connect) {
      html = '<div class="hm"><h1 class="hm-h1">' + title + '</h1><div class="hm-connect">' +
        '<p>Home shows your ClickUp tasks across every business, using your own ClickUp sign-in so you only see what ClickUp lets you see.</p>' +
        '<a class="hm-btn" href="' + esc(window.PortalAuth ? window.PortalAuth.signInUrl() : '/auth/clickup') + '">Connect ClickUp</a></div></div>';
    } else if (S.error && !S.data) {
      html = '<div class="hm"><h1 class="hm-h1">' + title + '</h1><div class="hm-err" role="alert">' + esc(S.error) +
        ' <button class="hm-link" data-hm="retry">Try again</button></div></div>';
    } else if (!S.data) {
      html = window.PortalLoader ? window.PortalLoader.full('your tasks') : 'Loading';
    } else {
      var td = today(), g, sub;
      if (S.view === 'mine') {
        g = groupMine(S.data.tasks, S.data.me.id, td);
        sub = g.count + ' open ' + (g.count === 1 ? 'task' : 'tasks') + ' assigned to you, ' + g.overdue + ' overdue';
      } else {
        g = groupAll(S.data.tasks);
        sub = g.count + ' open tasks in ' + g.lists + ' lists you can access';
      }
      var body = g.groups.map(function (grp) {
        var cls = S.view === 'mine' && grp.group === 'Overdue' ? ' hm-overdue' : '';
        return '<tr class="hm-grp"><td colspan="6"><span class="' + cls + '">' + esc(grp.group) + '</span><span class="hm-gc">' + grp.tasks.length + '</span></td></tr>' +
          grp.tasks.map(function (t) { return row(t, td); }).join('');
      }).join('');
      if (!g.count) body = '<tr><td colspan="6" class="hm-empty">' + (S.view === 'mine' ? 'Nothing assigned to you is open. Nice.' : 'No open tasks in the lists you can access.') + '</td></tr>';
      html = '<div class="hm"><div class="hm-top"><h1 class="hm-h1">' + title + '</h1><span class="hm-sub">' + esc(sub) + '</span></div>' +
        '<div class="hm-frame"><table class="hm-tbl"><thead><tr><th class="hm-tcol">Task</th><th>List</th><th>Status</th><th>Priority</th><th>Due</th><th>Assigned to</th></tr></thead><tbody>' +
        body + '</tbody></table></div>' +
        '<p class="hm-note">From ClickUp, using your own ClickUp sign-in, so you only see spaces and lists you can access. Click a task to open it in ClickUp.' +
        (S.data.stale || S.loading ? ' Refreshing…' : '') + '</p></div>';
    }
    if (window.PortalMorph) window.PortalMorph.morph(S.host, html); else S.host.innerHTML = html;
  }

  function mount(host, opts) {
    if (!host) return;
    S.host = host; S.view = (opts && opts.view) === 'all' ? 'all' : 'mine';
    S.onCounts = (opts && opts.onCounts) || S.onCounts;
    host.onclick = function (ev) { var el = ev.target.closest && ev.target.closest('[data-hm]'); if (el && el.getAttribute('data-hm') === 'retry') { S.error = ''; load(true); } };
    if (!S.data) { var c = readCache(); if (c) { S.data = c; counts(); } }
    paint();
    load(false);   /* background refresh; the cached copy is already on screen */
  }
  function current() { return S.data ? { mine: groupMine(S.data.tasks, S.data.me.id, today()).count, all: groupAll(S.data.tasks).count } : null; }
  function reset() { S.data = null; S.connect = false; try { sessionStorage.removeItem(CACHE_KEY); } catch (e) { /* */ } }

  return { mount: mount, counts: current, reset: reset, _internal: { groupMine: groupMine, groupAll: groupAll, bucket: bucket, fmtDue: fmtDue, dayOf: dayOf } };
});
