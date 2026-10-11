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

  /* Completed: the server's flag, or (for a copy cached before the flag
     existed) the same rule: ClickUp type "closed", or named complete,
     completed or done. */
  var DONE_RE = /^(complete|completed|done)$/i;
  function isDone(t) { return !!(t.done || t.statusType === 'closed' || DONE_RE.test(String(t.status || '').trim())); }

  /* Pure: the rows for one view. Each task id appears once whatever the input. */
  function groupMine(tasks, meId, today) {
    var seen = {}, mine = [];
    tasks.forEach(function (t) {
      if (seen[t.id] || isDone(t)) return;   /* completed tasks are not shown */
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
      if (seen[t.id] || isDone(t)) return; seen[t.id] = true;
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
    return '<tr class="hm-row' + (P.id === t.id ? ' hm-sel' : '') + '" data-hm-open="' + esc(t.id) + '"><td class="hm-task"><a href="' + esc(t.url) + '" target="_blank" rel="noopener" data-hm-open="' + esc(t.id) + '">' + esc(t.name) + '</a></td>' +
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
        '<p class="hm-note">From ClickUp, using your own ClickUp sign-in, so you only see spaces and lists you can access. Click a task to open it here.' +
        (S.data.stale || S.loading ? ' Refreshing…' : '') + '</p></div>';
    }
    if (window.PortalMorph) window.PortalMorph.morph(S.host, html); else S.host.innerHTML = html;
  }


  /* ===========================================================================
     The task panel. Ported from the /ops dashboard's task detail
     (openTaskDetail, openStatusEditor, openDuePicker, openAssigneePicker,
     saveAssignees, renderComments, submitComment in public/index.html), which
     came from the click-up-dashboard repo. Same behaviour; the look is the
     shell's. Every read and write goes through /api/home with the person's
     own ClickUp sign-in, so ClickUp's permissions apply, and a refusal is shown
     in the panel in ClickUp's own words.
     =========================================================================== */
  var P = { id: null };
  var PRIORITY = { urgent: 'Urgent', high: 'High', normal: 'Normal', low: 'Low' };

  function api(method, path, body) {
    var cu = null; try { cu = localStorage.getItem('du_auth_token'); } catch (e) { /* storage blocked */ }
    var base = window.PortalSession && window.PortalSession.authHeaders
      ? window.PortalSession.authHeaders({ Accept: 'application/json' }) : Promise.resolve({ Accept: 'application/json' });
    return base.then(function (h) {
      if (cu) h['X-ClickUp-Token'] = cu;
      if (body) h['Content-Type'] = 'application/json';
      return fetch('/api/home' + path, { method: method, headers: h, credentials: 'include', body: body ? JSON.stringify(body) : undefined });
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok) { var e = new Error(j.error || ('HTTP ' + r.status)); e.connect = !!j.connect; throw e; }
        return j;
      });
    });
  }
  function taskById(id) { return S.data && S.data.tasks.find(function (t) { return t.id === id; }); }
  function fmtStamp(msv) {
    if (msv === null || msv === undefined) return '–';
    return new Date(msv).toLocaleString('en-US', { timeZone: TZ, month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
  }
  function isoDay(msv) { return msv === null || msv === undefined ? '' : dayOf(msv); }

  function panelHost() {
    var el = document.getElementById('hmPanel');
    if (el) return el;
    el = document.createElement('div');
    el.id = 'hmPanel';
    document.body.appendChild(el);
    el.onclick = onPanelClick;
    el.onchange = onPanelChange;
    el.oninput = onPanelInput;
    el.onkeydown = onPanelKey;
    return el;
  }
  var keysBound = false;
  function bindKeys() {
    if (keysBound) return; keysBound = true;
    document.addEventListener('keydown', function (ev) {
      if (!P.id) return;
      if (ev.key === 'Tab') { trapFocus(ev); return; }
      if (ev.key !== 'Escape') return;
      if (P.assign) { P.assign = null; paintPanel(); return; }
      if (P.statusOpen) { P.statusOpen = false; paintPanel(); return; }
      closePanel();
    });
  }

  /* Focus stays inside the open dialog: Tab from the last control wraps to the
     first, Shift+Tab from the first wraps to the last. */
  function trapFocus(ev) {
    var box = document.querySelector('#hmPanel .hm-dlg') || document.querySelector('#hmPanel .hm-panel');
    if (!box) return;
    var f = Array.prototype.filter.call(box.querySelectorAll('a[href],button:not([disabled]),input:not([disabled]),textarea:not([disabled]),select,[tabindex]:not([tabindex="-1"])'),
      function (el) { return el.offsetParent !== null && !el.closest('[hidden]'); });
    if (!f.length) { ev.preventDefault(); return; }
    var first = f[0], last = f[f.length - 1], at = document.activeElement;
    if (!box.contains(at)) { ev.preventDefault(); first.focus(); return; }
    if (ev.shiftKey && at === first) { ev.preventDefault(); last.focus(); }
    else if (!ev.shiftKey && at === last) { ev.preventDefault(); first.focus(); }
  }

  /* The task pop-up, for any task object: Home's rows and the Executive
     board's L10 agenda both open it. `onChange` is told after every edit (and
     on close), so the screen behind can repaint its row. */
  function openTask(task, opts) {
    if (!task) return;
    var back = document.activeElement;
    P = { id: task.id, task: task, onChange: (opts && opts.onChange) || null, statuses: null, statusOpen: false,
          comments: null, commentsErr: '', msg: '', assign: null, posting: false, back: back };
    bindKeys();
    paintPanel();
    if (P.onChange) P.onChange(task);
    var c = document.querySelector('#hmPanel .hm-p-x'); if (c) c.focus();
    loadComments();
  }
  function openPanel(id) { openTask(taskById(id), { onChange: homeChanged }); }
  function homeChanged() { if (S.data) { writeCache(S.data); counts(); } paint(); }
  function closePanel() {
    if (!P.id) return;
    var back = P.back, cb = P.onChange, t = P.task;
    P = { id: null };
    paintPanel();
    if (cb) cb(t);
    if (back && back.focus && document.body.contains(back)) back.focus();
  }

  function loadComments() {
    var id = P.id;
    P.comments = null; P.commentsErr = '';
    paintPanel();
    var t0 = window.PortalLoader ? window.PortalLoader.now() : 0;
    api('GET', '/task/' + encodeURIComponent(id) + '/comments').then(function (d) {
      var done = function () { if (P.id !== id) return; P.comments = d.comments || []; paintPanel(); };
      if (window.PortalLoader) window.PortalLoader.settle(t0, done); else done();
    }, function (e) { if (P.id !== id) return; P.commentsErr = e.message; P.comments = []; paintPanel(); });
  }

  /* One write: change the row now, send it, keep ClickUp's answer, or put the
     row back and say why. */
  function update(body, optimistic) {
    var t = P.task;
    if (!t) return;
    var before = JSON.parse(JSON.stringify(t));
    optimistic(t);
    P.msg = ''; P.saving = true;
    afterChange();
    api('PUT', '/task/' + encodeURIComponent(t.id), body).then(function (d) {
      var fresh = d.task || {};
      SYNCED.forEach(function (k) { if (k in fresh) t[k] = fresh[k]; });
      P.saving = false;
      afterChange();
    }, function (e) {
      Object.keys(before).forEach(function (k) { t[k] = before[k]; });
      P.saving = false;
      P.msg = 'ClickUp did not save this: ' + e.message;
      afterChange();
    });
  }
  var SYNCED = ['status', 'statusType', 'statusColor', 'done', 'due', 'assignees', 'priority', 'tags', 'updated', 'name'];
  /* The same task can be on Home and on the L10 agenda as two objects; an edit
     in either copy is mirrored into Home's, so neither screen goes stale. */
  function afterChange() {
    var t = P.task, h = t && taskById(t.id);
    if (h && h !== t) SYNCED.forEach(function (k) { if (k in t) h[k] = t[k]; });
    if (P.onChange) P.onChange(t);
    if (h && P.onChange !== homeChanged) homeChanged();
    paintPanel();
  }

  function openStatus() {
    P.statusOpen = !P.statusOpen;
    paintPanel();
    var t = P.task;
    if (!P.statusOpen || P.statuses || !t || !t.listId) return;
    var id = P.id;
    api('GET', '/list/' + encodeURIComponent(t.listId) + '/statuses').then(function (d) {
      if (P.id !== id) return;
      P.statuses = (d.statuses || []).slice().sort(function (a, b) { return (a.orderindex || 0) - (b.orderindex || 0); });
      paintPanel();
    }, function (e) { if (P.id !== id) return; P.statuses = []; P.msg = 'Could not load this list’s statuses: ' + e.message; paintPanel(); });
  }
  function setStatus(name) {
    var st = (P.statuses || []).find(function (x) { return x.status === name; });
    P.statusOpen = false;
    /* a completed status takes the row off Home at once; the panel stays open */
    update({ status: name }, function (t) { t.status = name; if (st) { t.statusColor = st.color; t.statusType = st.type; t.done = !!st.done; } else t.done = DONE_RE.test(name); });
  }
  function setDue(iso) {
    /* 5 pm, as the dashboard always set it, so the day never slips across a timezone */
    var t = P.task;
    if (!t || (iso || '') === isoDay(t.due)) return;   /* the same day again is not a change */
    var msv = iso ? new Date(iso + 'T17:00:00').getTime() : null;
    update({ due_date: msv }, function (t) { t.due = msv; });
  }

  function openAssign() {
    var t = P.task;
    if (!t) return;
    P.assign = { members: null, q: '', sel: {}, err: '' };
    (t.assignees || []).forEach(function (a) { P.assign.sel[String(a.id)] = true; });
    paintPanel();
    var id = P.id;
    api('GET', '/list/' + encodeURIComponent(t.listId) + '/members').then(function (d) {
      if (P.id !== id || !P.assign) return;
      var byId = {};
      (d.members || []).forEach(function (m) { byId[m.id] = m; });
      /* anyone already assigned stays visible, so they can be removed even if they left the list */
      (t.assignees || []).forEach(function (a) { if (!byId[String(a.id)]) byId[String(a.id)] = { id: String(a.id), name: a.name, initials: a.initials }; });
      P.assign.members = Object.keys(byId).map(function (k) { return byId[k]; })
        .sort(function (a, b) { return String(a.name).localeCompare(String(b.name)); });
      paintPanel();
      var q = document.querySelector('#hmPanel .hm-dlg-q'); if (q) q.focus();
    }, function (e) { if (P.assign) { P.assign.err = e.message; P.assign.members = []; paintPanel(); } });
  }
  function saveAssign() {
    var t = P.task, a = P.assign;
    if (!t || !a || !a.members) return;
    var cur = {}; (t.assignees || []).forEach(function (x) { cur[String(x.id)] = true; });
    var add = Object.keys(a.sel).filter(function (k) { return a.sel[k] && !cur[k]; });
    var rem = Object.keys(cur).filter(function (k) { return !a.sel[k]; });
    var chosen = a.members.filter(function (m) { return a.sel[m.id]; })
      .map(function (m) { return { id: m.id, name: m.name, initials: m.initials }; });
    P.assign = null;
    if (!add.length && !rem.length) { paintPanel(); return; }
    update({ assignees: { add: add, rem: rem } }, function (x) { x.assignees = chosen; });
  }

  function postComment() {
    var box = document.querySelector('#hmPanel .hm-c-in');
    var text = box ? box.value.trim() : '';
    if (!text || P.posting) return;
    var id = P.id;
    P.posting = true; P.msg = ''; P.draft = box.value;
    paintPanel();
    api('POST', '/task/' + encodeURIComponent(id) + '/comment', { comment_text: text }).then(function () {
      if (P.id !== id) return;
      P.posting = false; P.draft = '';
      loadComments();
    }, function (e) {
      if (P.id !== id) return;
      P.posting = false; P.msg = 'ClickUp did not post this comment: ' + e.message;
      paintPanel();
    });
  }

  function onPanelClick(ev) {
    var el = ev.target.closest('[data-p]');
    if (ev.target.classList && ev.target.classList.contains('hm-scrim')) { closePanel(); return; }
    if (!el) return;
    var act = el.getAttribute('data-p');
    if (act === 'close') closePanel();
    else if (act === 'status') openStatus();
    else if (act === 'pick') setStatus(el.getAttribute('data-v'));
    else if (act === 'clear-due') setDue('');
    else if (act === 'assign') openAssign();
    else if (act === 'assign-cancel') { P.assign = null; paintPanel(); }
    else if (act === 'assign-save') saveAssign();
    else if (act === 'post') postComment();
    else if (act === 'dismiss') { P.msg = ''; paintPanel(); }
  }
  function onPanelChange(ev) {
    var el = ev.target;
    if (el.classList.contains('hm-due-in')) setDue(el.value);
    else if (el.classList.contains('hm-dlg-cb') && P.assign) P.assign.sel[el.value] = el.checked;
  }
  function onPanelInput(ev) {
    var el = ev.target;
    if (el.classList.contains('hm-dlg-q') && P.assign) {
      /* filter in place: repainting the dialog would steal the caret */
      P.assign.q = el.value.toLowerCase();
      document.querySelectorAll('#hmPanel .hm-dlg-m').forEach(function (row) {
        row.hidden = P.assign.q && row.getAttribute('data-n').indexOf(P.assign.q) < 0;
      });
    } else if (el.classList.contains('hm-c-in')) P.draft = el.value;
  }
  function onPanelKey(ev) {
    if (ev.target.classList.contains('hm-c-in') && ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); postComment(); }
  }

  function commentHtml(c) {
    var body = c.parts.map(function (p) {
      if (p.link) return '<a href="' + esc(p.link) + '" target="_blank" rel="noopener">' + esc(p.text) + '</a>';
      return esc(p.text);
    }).join('');
    return '<div class="hm-c"><div class="hm-c-meta"><b>' + esc(c.author) + '</b><span>' + esc(fmtStamp(c.at)) + '</span></div><div class="hm-c-t">' + body + '</div></div>';
  }

  function paintPanel() {
    var host = panelHost();
    var t = P.id && P.task;
    if (!t) { host.innerHTML = ''; document.documentElement.classList.remove('hm-locked'); return; }
    document.documentElement.classList.add('hm-locked');
    /* the frame is built once per opening, so its slide-in plays once; every
       later repaint morphs the inside, which also leaves a focused field alone */
    var aside = host.querySelector('.hm-panel');
    if (!aside) {
      host.innerHTML = '<div class="hm-scrim"></div><div class="hm-panel" role="dialog" aria-modal="true" aria-labelledby="hmPTitle"></div>';
      aside = host.querySelector('.hm-panel');
    }
    var td = today();
    var overdue = t.due !== null && t.due !== undefined && dayOf(t.due) < td;
    var where = [t.spaceName, t.folder, t.list].filter(Boolean).map(esc).join(' <span class="hm-sep">/</span> ');
    var dot = function (c) { return '<i class="hm-dot" style="background:' + esc(c || 'var(--ink-3)') + '"></i>'; };
    var statusMenu = '';
    if (P.statusOpen) {
      statusMenu = '<div class="hm-menu" role="listbox">' + (P.statuses === null
        ? '<div class="hm-menu-i hm-muted">' + (window.PortalLoader ? window.PortalLoader.small('statuses') : '') + '</div>'
        : (P.statuses.length ? P.statuses.map(function (x) {
            var on = String(x.status).toLowerCase() === String(t.status).toLowerCase();
            return '<button class="hm-menu-i" role="option" aria-selected="' + on + '" data-p="pick" data-v="' + esc(x.status) + '">' + dot(x.color) + '<span>' + esc(x.status) + '</span>' + (on ? '<span class="hm-on">Current</span>' : '') + '</button>';
          }).join('') : '<div class="hm-menu-i hm-muted">No statuses for this list</div>')) + '</div>';
    }
    var people = (t.assignees || []).length
      ? (t.assignees || []).map(function (a) { return esc(a.name); }).join(', ')
      : '<span class="hm-muted">Unassigned</span>';
    var tags = (t.tags || []).length ? (t.tags || []).map(function (x) { return '<span class="hm-tag">' + esc(x) + '</span>'; }).join(' ') : '<span class="hm-muted">–</span>';
    var pr = PRIORITY[t.priority];
    var comments;
    if (P.comments === null) comments = window.PortalLoader ? window.PortalLoader.full('comments') : '';
    else if (P.commentsErr) comments = '<div class="hm-p-err">Could not load comments: ' + esc(P.commentsErr) + '</div>';
    else if (!P.comments.length) comments = '<div class="hm-muted hm-c-none">No comments yet.</div>';
    else comments = P.comments.map(commentHtml).join('');

    var dlg = '';
    if (P.assign) {
      var a = P.assign;
      var list = a.members === null
        ? (window.PortalLoader ? window.PortalLoader.full('members') : '')
        : (a.err ? '<div class="hm-p-err">Could not load the list’s members: ' + esc(a.err) + '</div>'
          : (a.members.length ? a.members.map(function (m) {
              return '<label class="hm-dlg-m" data-n="' + esc(String(m.name).toLowerCase()) + '"' + (a.q && String(m.name).toLowerCase().indexOf(a.q) < 0 ? ' hidden' : '') + '><input type="checkbox" class="hm-dlg-cb" value="' + esc(m.id) + '"' + (a.sel[m.id] ? ' checked' : '') + '><span class="hm-av">' + esc(m.initials || '') + '</span><span>' + esc(m.name) + '</span></label>';
            }).join('') : '<div class="hm-muted">No one can be assigned in this list.</div>'));
      dlg = '<div class="hm-dlg-back"><div class="hm-dlg" role="dialog" aria-modal="true" aria-labelledby="hmDlgT">' +
        '<div class="hm-dlg-h" id="hmDlgT">Assign</div>' +
        '<div class="hm-dlg-s">Members who can be assigned in ' + esc(t.list || 'this list') + '. Check to add, uncheck to remove.</div>' +
        '<input class="hm-dlg-q" type="search" placeholder="Search members" aria-label="Search members" value="' + esc(a.q) + '">' +
        '<div class="hm-dlg-list">' + list + '</div>' +
        '<div class="hm-dlg-f"><button class="btn" data-p="assign-cancel">Cancel</button><button class="btn primary" data-p="assign-save"' + (a.members ? '' : ' disabled') + '>Save</button></div>' +
        '</div></div>';
    }

    var inner = '<header class="hm-p-h"><div class="hm-p-ht"><h2 id="hmPTitle">' + esc(t.name) + '</h2>' +
      (where ? '<div class="hm-p-where">' + where + '</div>' : '') + '</div>' +
      '<button class="hm-p-x press" data-p="close" aria-label="Close (Esc)">×</button></header>' +
      (P.msg ? '<div class="hm-p-err" role="alert">' + esc(P.msg) + ' <button class="link" data-p="dismiss">Dismiss</button></div>' : '') +
      '<div class="hm-p-b">' +
      '<dl class="hm-kv">' +
      '<dt>Status</dt><dd class="hm-rel"><button class="hm-st press" data-p="status" aria-haspopup="listbox" aria-expanded="' + !!P.statusOpen + '">' + dot(t.statusColor) + '<span>' + esc(t.status || '–') + '</span><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg></button>' + statusMenu + '</dd>' +
      '<dt>Due</dt><dd><input type="date" class="hm-due-in' + (overdue ? ' hm-overdue' : '') + '" value="' + esc(isoDay(t.due)) + '" aria-label="Due date">' +
        (t.due !== null && t.due !== undefined ? ' <button class="link" data-p="clear-due">Clear</button>' : '') + (overdue ? ' <span class="hm-overdue">Overdue</span>' : '') + '</dd>' +
      '<dt>Assignees</dt><dd>' + people + ' <button class="link" data-p="assign">Edit</button></dd>' +
      '<dt>Priority</dt><dd>' + (pr ? '<span class="hm-pr hm-pr-' + esc(t.priority) + '"><i></i>' + pr + '</span>' : '<span class="hm-muted">–</span>') + '</dd>' +
      '<dt>Tags</dt><dd>' + tags + '</dd>' +
      '<dt>Created</dt><dd>' + esc(fmtStamp(t.created)) + '</dd>' +
      '<dt>Updated</dt><dd>' + esc(fmtStamp(t.updated)) + '</dd>' +
      '</dl>' +
      '<a class="hm-p-cu" href="' + esc(t.url) + '" target="_blank" rel="noopener">View in ClickUp</a>' +
      (P.saving ? '<div class="hm-saving">' + (window.PortalLoader ? window.PortalLoader.small('saving') : 'Saving') + '</div>' : '') +
      '<section class="hm-cs"><h3>Comments</h3>' +
      '<div class="hm-c-form"><textarea class="hm-c-in" rows="3" placeholder="Add a comment" aria-label="Add a comment"' + (P.posting ? ' disabled' : '') + '>' + esc(P.draft || '') + '</textarea>' +
      '<div class="hm-c-f"><span class="hm-muted">Ctrl+Enter posts</span><button class="btn primary" data-p="post"' + (P.posting ? ' disabled' : '') + '>' + (P.posting ? 'Posting' : 'Post') + '</button></div></div>' +
      '<div class="hm-c-list">' + comments + '</div></section>' +
      '</div>' + dlg;
    if (window.PortalMorph) window.PortalMorph.morph(aside, inner); else aside.innerHTML = inner;
  }

  /* ===========================================================================
     The L10 agenda (Executive board). ClickUp list MASTER LIST in the Company
     space, split by its "Appears In" labels into Rocks, Sprint and IDS. Read
     with the signed-in admin's own ClickUp sign-in; completed items never
     show; a row opens the same task pop-up as Home.
     =========================================================================== */
  var SECTIONS = [['rock', 'Rocks'], ['sprint', 'Sprint'], ['ids', 'IDS']];
  var L = { host: null, data: null, err: '', connect: false, loading: false, tab: 'rock', onTab: null };

  function mountL10(host, opts) {
    if (!host) return;
    L.host = host; L.onTab = (opts && opts.onTab) || null;
    host.onclick = function (ev) {
      var tb = ev.target.closest('[data-l10-tab]');
      if (tb) { L.tab = tb.getAttribute('data-l10-tab'); if (L.onTab) L.onTab(L.tab); paintL10(); return; }
      if (ev.target.closest('[data-l10-retry]')) { L.err = ''; loadL10(true); return; }
      var row = ev.target.closest('[data-l10-open]');
      if (!row || !L.data) return;
      if (ev.target.closest('a') && (ev.ctrlKey || ev.metaKey || ev.shiftKey || ev.button !== 0)) return;
      ev.preventDefault();
      var id = row.getAttribute('data-l10-open');
      openTask((L.data.items || []).find(function (x) { return x.id === id; }), { onChange: paintL10 });
    };
    paintL10();
    loadL10(false);
  }
  function loadL10(fresh) {
    if (!signedIn()) { L.connect = true; paintL10(); return; }
    if (L.loading) return;
    L.loading = true;
    var t0 = window.PortalLoader ? window.PortalLoader.now() : 0;
    api('GET', '/l10' + (fresh ? '?fresh=1' : '')).then(function (d) {
      var done = function () { L.data = d; L.err = ''; L.connect = false; L.loading = false; paintL10(); };
      if (window.PortalLoader) window.PortalLoader.settle(t0, done); else done();
    }, function (e) { L.loading = false; if (e.connect) L.connect = true; else L.err = e.message; paintL10(); });
  }
  function paintL10() {
    if (!L.host || !document.body.contains(L.host)) return;
    var html;
    if (L.connect) {
      html = '<div class="hm-connect"><p>The L10 agenda reads ClickUp with your own ClickUp sign-in.</p>' +
        '<a class="hm-btn" href="' + esc(window.PortalAuth ? window.PortalAuth.signInUrl() : '/auth/clickup') + '">Connect ClickUp</a></div>';
    } else if (L.err && !L.data) {
      html = '<div class="hm-err" role="alert">Could not load the L10 agenda: ' + esc(L.err) + ' <button class="hm-link" data-l10-retry>Try again</button></div>';
    } else if (!L.data) {
      html = window.PortalLoader ? window.PortalLoader.full('the L10 agenda') : '';
    } else {
      var live = (L.data.items || []).filter(function (t) { return !isDone(t); });
      var td = today();
      var tabs = '<div class="seg" role="tablist">' + SECTIONS.map(function (x) {
        var n = live.filter(function (t) { return (t.sections || []).indexOf(x[0]) >= 0; }).length;
        return '<button class="segbtn' + (L.tab === x[0] ? ' on' : '') + '" role="tab" aria-selected="' + (L.tab === x[0]) + '" data-l10-tab="' + x[0] + '">' + x[1] + ' <span class="hm-gc">' + n + '</span></button>';
      }).join('') + '</div>';
      var rows = live.filter(function (t) { return (t.sections || []).indexOf(L.tab) >= 0; }).sort(byDue);
      var body = rows.length ? rows.map(function (t) {
        var overdue = t.due !== null && t.due !== undefined && dayOf(t.due) < td;
        var owners = (t.assignees || []).map(function (a) { return esc(a.name); }).join(', ');
        return '<tr class="hm-row' + (P.id === t.id ? ' hm-sel' : '') + '" data-l10-open="' + esc(t.id) + '">' +
          '<td class="hm-task"><a href="' + esc(t.url) + '" target="_blank" rel="noopener">' + esc(t.name) + '</a></td>' +
          '<td>' + statusPill(t.status) + '</td>' +
          '<td>' + (owners || '<span class="hm-muted">Unassigned</span>') + '</td>' +
          '<td class="' + (overdue ? 'hm-overdue' : '') + '">' + esc(fmtDue(t.due, td)) + '</td>' +
          '<td>' + priorityCell(t.priority) + '</td>' +
          '<td class="hm-muted">' + esc(fmtDue(t.updated, td)) + '</td></tr>';
      }).join('') : '<tr><td colspan="6" class="hm-empty">Nothing open in ' + esc((SECTIONS.find(function (x) { return x[0] === L.tab; }) || [0, ''])[1]) + '.</td></tr>';
      html = tabs + '<div class="hm-frame"><table class="hm-tbl"><thead><tr><th class="hm-tcol">Item</th><th>Status</th><th>Owner</th><th>Due</th><th>Priority</th><th>Updated</th></tr></thead><tbody>' +
        body + '</tbody></table></div>' +
        '<p class="hm-note">From ClickUp, ' + esc(L.data.list.name) + (L.data.list.space ? ' in the ' + esc(L.data.list.space) + ' space' : '') +
        ', using your own ClickUp sign-in. Completed items are not shown. Click an item to open it here.' + (L.loading ? ' Refreshing…' : '') + '</p>';
    }
    if (window.PortalMorph) window.PortalMorph.morph(L.host, html); else L.host.innerHTML = html;
  }

  function mount(host, opts) {
    if (!host) return;
    S.host = host; S.view = (opts && opts.view) === 'all' ? 'all' : 'mine';
    S.onCounts = (opts && opts.onCounts) || S.onCounts;
    host.onclick = function (ev) {
      var el = ev.target.closest && ev.target.closest('[data-hm]');
      if (el && el.getAttribute('data-hm') === 'retry') { S.error = ''; load(true); return; }
      var row = ev.target.closest && ev.target.closest('[data-hm-open]');
      if (!row) return;
      /* ctrl / cmd / shift / middle click on the name keeps its link: ClickUp in a new tab */
      if (ev.target.closest('a') && (ev.ctrlKey || ev.metaKey || ev.shiftKey || ev.button !== 0)) return;
      ev.preventDefault();
      openPanel(row.getAttribute('data-hm-open'));
    };
    if (!S.data) { var c = readCache(); if (c) { S.data = c; counts(); } }
    paint();
    load(false);   /* background refresh; the cached copy is already on screen */
  }
  function current() { return S.data ? { mine: groupMine(S.data.tasks, S.data.me.id, today()).count, all: groupAll(S.data.tasks).count } : null; }
  function reset() { S.data = null; S.connect = false; if (P.id) closePanel(); try { sessionStorage.removeItem(CACHE_KEY); } catch (e) { /* */ } }

  return { mount: mount, counts: current, reset: reset, open: openPanel, openTask: openTask, close: closePanel,
           mountL10: mountL10, l10Tab: function () { return L.tab; }, setL10Tab: function (t) { if (SECTIONS.some(function (x) { return x[0] === t; })) L.tab = t; },
           _internal: { isDone: isDone, groupMine: groupMine, groupAll: groupAll, bucket: bucket, fmtDue: fmtDue, dayOf: dayOf } };
});
