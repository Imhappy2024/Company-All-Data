/* ===========================================================================
   portal-tasks.js - the native per-brand Tasks screen.

   Replaces the /ops iframe for the brand "All Tasks" view. Reads GET /api/tasks
   (the whole workspace, ~500KB gzipped, server-cached 10 min) and filters to the
   brand's ClickUp spaces in the browser.

   Layout, as specified:
     row 1  four counter cards - Total Open / Overdue / Due This Week / Completed
     row 2  the task list, showing whichever card is active. Clicking a card
            swaps the list in place. There is always exactly one active card.
   No space filter: the brand already decides the scope.

   Writes go through the signed-in user's ClickUp token so changes are attributed
   to them, and are applied optimistically then reconciled.

   Colour comes only from tokens.css. Nothing here hard-codes a palette hex.

   Exposes window.PortalTasks. Requires window.PortalAuth (portal-auth.js).
   =========================================================================== */
(function () {
  'use strict';

  /* =======================================================================
     Status model. Mirrors data/status-mappings.json + mapStatusToCanonical()
     in server.js. The server pre-computes canonical_status; this is the
     fallback for a stale cache.
     ===================================================================== */

  var CANONICAL = ['To Do', 'In Progress', 'In Review', 'Blocked', 'Long Term', 'Completed'];

  function toCanonicalFallback(raw) {
    var s = (raw || '').toLowerCase().trim();
    if (!s) return 'To Do';
    if (/^(to\s*do|todo|backlog|open|new|not started|pending)$/.test(s)) return 'To Do';
    if (/in\s*progress|working|doing|active|started|wip|on track/.test(s)) return 'In Progress';
    if (/blocked|stuck|on\s*hold|waiting|off\s*track/.test(s)) return 'Blocked';
    if (/long.?term|parking|someday|future|deferred|not reporting|recurring/.test(s)) return 'Long Term';
    if (/review|qa|testing|approval/.test(s)) return 'In Review';
    if (/done|complet|closed|finish|live|shipped|resolved|archived/.test(s)) return 'Completed';
    return 'To Do';
  }
  function canonical(t) {
    return t.canonical_status || toCanonicalFallback(t.status && t.status.status);
  }

  /* Which canonical buckets are NOT open work.
     Only 'Completed' by default, which matches the ops dashboard so the two
     surfaces never disagree about the same task.

     Worth knowing before you change it: this ClickUp workspace uses the raw
     statuses "not reporting" and "quarterly recurring" as placeholders on the
     quarterly property-reporting lists. Those are real rows nobody is expected
     to action, and with the default set they count as open. If LeavenWealth's
     Total Open reads higher than the real workload, add 'Long Term' here and
     map those two statuses to Long Term in data/status-mappings.json. */
  var NOT_OPEN = { 'Completed': true };

  function isCompleted(t) { return canonical(t) === 'Completed'; }
  function isOpen(t) { return !NOT_OPEN[canonical(t)]; }

  function startOfToday() { var d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); }
  function dueMs(t) { var v = parseInt(t.due_date || 0, 10); return v || 0; }

  /* The four cards. One definition of done (isCompleted) and one time boundary
     (start of today) across all of them, so no two can disagree about a task.
     Tasks with no due date land in Open and Completed but in neither Overdue nor
     Due This Week - that is correct, and the card subtitles say so. */
  var CARDS = [
    {
      key: 'open', label: 'Total - Open Tasks', sub: 'not completed', tone: 'info',
      pick: function (ts) { return ts.filter(isOpen); },
    },
    {
      key: 'overdue', label: 'Overdue', sub: 'past due, not completed', tone: 'crit',
      pick: function (ts) {
        var t0 = startOfToday();
        return ts.filter(function (t) { return isOpen(t) && dueMs(t) && dueMs(t) < t0; });
      },
    },
    {
      key: 'dueweek', label: 'Due This Week', sub: 'today through the next 7 days', tone: 'warn',
      pick: function (ts) {
        var a = startOfToday(), b = a + 7 * 86400000;
        return ts.filter(function (t) { return isOpen(t) && dueMs(t) >= a && dueMs(t) < b; });
      },
    },
    {
      key: 'completed', label: 'Completed', sub: 'canonical status Completed', tone: 'good',
      pick: function (ts) { return ts.filter(isCompleted); },
    },
  ];
  function cardByKey(k) {
    for (var i = 0; i < CARDS.length; i++) if (CARDS[i].key === k) return CARDS[i];
    return CARDS[0];
  }

  var PRIORITY_BY_ID = { '1': 'urgent', '2': 'high', '3': 'normal', '4': 'low' };
  function priorityOf(t) {
    var p = t.priority;
    if (!p) return '';
    return String(p.priority || PRIORITY_BY_ID[String(p.id)] || '').toLowerCase();
  }

  /* =======================================================================
     Payload cache. The response is large, so it is fetched once and reused
     across navigation. Refetch on: older than CACHE_MS, an explicit refresh,
     or invalidate() from the realtime layer.
     ===================================================================== */

  var CACHE_MS = 10 * 60 * 1000;
  var payload = null, payloadAt = 0, inflight = null, loadError = null;

  function load(force) {
    if (!force && payload && Date.now() - payloadAt < CACHE_MS) return Promise.resolve(payload);
    if (inflight) return inflight;
    var url = '/api/tasks' + (force ? '?force=1' : '');
    inflight = PortalAuth.fetch(url)
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function (data) {
        if (data && data.error && !data.tasks) throw new Error(data.error);
        payload = data;
        payloadAt = Date.now();
        loadError = null;
        return payload;
      })
      .catch(function (err) {
        loadError = err;
        /* Keep any previous payload. A stale list with a banner beats a blank page. */
        if (!payload) throw err;
        return payload;
      })
      .then(function (p) { inflight = null; return p; });
    return inflight;
  }

  /* =======================================================================
     View state. Survives portal.html re-rendering the container, because
     render() rebuilds from here rather than from the DOM.
     ===================================================================== */

  var ui = {
    brand: null,
    brandName: '',
    spaces: [],
    containerId: null,
    card: 'open',
    q: '',
    assignee: {},   /* id -> true */
    status: {},     /* canonical bucket -> true */
    priority: {},   /* 'urgent'|'high'|'normal'|'low' -> true */
    nest: true,
  };
  function activeFilterCount() {
    return Object.keys(ui.assignee).length + Object.keys(ui.status).length +
           Object.keys(ui.priority).length + (ui.q ? 1 : 0);
  }
  function clearFilters() {
    ui.q = ''; ui.assignee = {}; ui.status = {}; ui.priority = {};
  }

  /* =======================================================================
     Selection
     ===================================================================== */

  function scoped() {
    if (!payload || !payload.tasks) return [];
    var allow = {};
    for (var i = 0; i < ui.spaces.length; i++) allow[String(ui.spaces[i])] = true;
    return payload.tasks.filter(function (t) {
      var sid = t.space && t.space.id;
      return sid != null && allow[String(sid)];
    });
  }

  function applyFilters(tasks) {
    var q = ui.q.trim().toLowerCase();
    var hasA = Object.keys(ui.assignee).length > 0;
    var hasS = Object.keys(ui.status).length > 0;
    var hasP = Object.keys(ui.priority).length > 0;
    return tasks.filter(function (t) {
      if (q) {
        var hay = (t.name || '') + ' ' + (t.list && t.list.name || '') + ' ' + (t.space && t.space.name || '');
        if (hay.toLowerCase().indexOf(q) === -1) return false;
      }
      if (hasA) {
        var as = t.assignees || [];
        var hit = false;
        for (var i = 0; i < as.length; i++) if (ui.assignee[String(as[i].id)]) { hit = true; break; }
        if (!hit && !ui.assignee.__none) return false;
        if (!hit && ui.assignee.__none && as.length) return false;
      }
      if (hasS && !ui.status[canonical(t)]) return false;
      if (hasP) {
        var p = priorityOf(t);
        if (!p || !ui.priority[p]) return false;
      }
      return true;
    });
  }

  /* =======================================================================
     Formatting
     ===================================================================== */

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function fmtDue(t) {
    var ms = dueMs(t);
    if (!ms) return '<span class="nt-nil" title="No due date in ClickUp">—</span>';
    var d = new Date(ms), now = new Date();
    var label = MONTHS[d.getMonth()] + ' ' + d.getDate();
    if (d.getFullYear() !== now.getFullYear()) label += ', ' + d.getFullYear();
    var cls = '';
    if (!isCompleted(t)) {
      if (ms < startOfToday()) cls = ' nt-due-over';
      else if (ms < startOfToday() + 2 * 86400000) cls = ' nt-due-soon';
    }
    return '<span class="nt-due' + cls + '">' + esc(label) + '</span>';
  }
  function severityFor(bucket) {
    if (bucket === 'Completed') return 'good';
    if (bucket === 'Blocked') return 'crit';
    if (bucket === 'In Review') return 'warn';
    if (bucket === 'In Progress') return 'info';
    return 'mute';
  }
  function initialsOf(a) {
    if (a.initials) return a.initials;
    var n = (a.username || a.email || '?').trim();
    var parts = n.split(/\s+/);
    return ((parts[0] || '')[0] || '?').toUpperCase() + (parts[1] ? parts[1][0].toUpperCase() : '');
  }
  /* Avatar tint is derived from the user id so it is stable per person. Hue only;
     lightness and chroma are fixed so it sits correctly on both themes. */
  function tintFor(key) {
    var s = String(key || ''), h = 0;
    for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
    return 'hsl(' + h + ' 42% 42%)';
  }
  function avatarsHtml(t) {
    var as = t.assignees || [];
    if (!as.length) return '<span class="nt-nil" title="No assignee in ClickUp">—</span>';
    var shown = as.slice(0, 3).map(function (a) {
      return '<span class="nt-av" style="background:' + tintFor(a.id || a.username) + '" title="' +
             esc(a.username || a.email || '') + '">' + esc(initialsOf(a)) + '</span>';
    }).join('');
    var more = as.length > 3 ? '<span class="nt-av nt-av-more" title="' +
      esc(as.slice(3).map(function (a) { return a.username; }).join(', ')) + '">+' + (as.length - 3) + '</span>' : '';
    return '<span class="nt-avs">' + shown + more + '</span>';
  }

  /* =======================================================================
     Render
     ===================================================================== */

  var renderToken = 0;
  var CHUNK = 60;

  function container() {
    return ui.containerId ? document.getElementById(ui.containerId) : null;
  }

  function render(brand, containerId, opts) {
    opts = opts || {};
    var brandChanged = ui.brand !== brand;
    ui.brand = brand;
    ui.containerId = containerId;
    ui.brandName = opts.brandName || brand;
    ui.spaces = opts.spaces || [];
    if (brandChanged) { clearFilters(); ui.card = 'open'; }

    var el = container();
    if (!el) return;

    if (!PortalAuth.isSignedIn()) {
      el.innerHTML = PortalAuth.gateHtml({
        note: 'You only need this for Tasks. The rest of the portal works without it.',
      });
      return;
    }
    if (!ui.spaces.length) {
      el.innerHTML = emptyState(
        'No ClickUp space for ' + esc(ui.brandName) + ' yet',
        'Once this business has a space in ClickUp, its tasks appear here automatically. Nothing to configure in the dashboard.');
      return;
    }

    if (!payload) el.innerHTML = skeletonHtml();
    load(false).then(paint).catch(function (err) {
      var e = container();
      if (e) e.innerHTML = emptyState('Could not reach ClickUp',
        String(err && err.message || err) + '. Nothing stale is being shown in its place, because there is nothing to show yet.');
    });
  }

  function paint() {
    var el = container();
    if (!el) return;
    if (!PortalAuth.isSignedIn()) { render(ui.brand, ui.containerId, { spaces: ui.spaces, brandName: ui.brandName }); return; }

    var base = scoped();
    var filtered = applyFilters(base);
    var counts = CARDS.map(function (c) { return c.pick(filtered).length; });
    var rows = cardByKey(ui.card).pick(filtered);

    el.innerHTML =
      bannerHtml() +
      cardsHtml(counts) +
      toolbarHtml(base, filtered.length, rows.length) +
      '<div class="nt-tablewrap"><div class="nt-thead">' + headHtml() + '</div>' +
      '<div class="nt-tbody" id="ntBody"></div></div>' +
      '<div class="nt-drawer" id="ntDrawer" hidden></div>' +
      '<div class="nt-scrim" id="ntScrim" hidden></div>' +
      '<div class="nt-pop" id="ntPop" hidden></div>' +
      '<div class="nt-toast" id="ntToast" hidden></div>';

    bindOnce(el);
    renderRows(rows);
  }

  function bannerHtml() {
    if (!loadError && !(payload && payload.error)) return '';
    var msg = loadError ? String(loadError.message || loadError) : String(payload.error);
    var age = payloadAt ? Math.round((Date.now() - payloadAt) / 60000) : null;
    return '<div class="nt-banner">Showing the last data we could load' +
      (age != null ? ' (' + age + ' min old)' : '') + '. ' + esc(msg) + '</div>';
  }

  function cardsHtml(counts) {
    return '<div class="nt-cards" role="tablist" aria-label="Task view">' + CARDS.map(function (c, i) {
      var on = c.key === ui.card;
      return '<button class="nt-card' + (on ? ' on' : '') + ' t-' + c.tone + '" role="tab" ' +
        'aria-selected="' + (on ? 'true' : 'false') + '" data-card="' + c.key + '" ' +
        'title="' + esc(c.label + ': ' + c.sub) + '">' +
        '<span class="nt-card-l">' + esc(c.label) + '</span>' +
        '<span class="nt-card-v">' + counts[i] + '</span>' +
        '<span class="nt-card-s">' + esc(c.sub) + '</span>' +
      '</button>';
    }).join('') + '</div>';
  }

  function toolbarHtml(base, filteredCount, rowCount) {
    var people = {};
    base.forEach(function (t) {
      (t.assignees || []).forEach(function (a) { people[String(a.id)] = a.username || a.email || String(a.id); });
    });
    var buckets = {};
    base.forEach(function (t) { buckets[canonical(t)] = true; });

    var n = activeFilterCount();
    return '<div class="nt-bar">' +
      '<input class="nt-search" id="ntQ" type="search" placeholder="Search tasks…" value="' + esc(ui.q) + '" aria-label="Search tasks">' +
      dropdown('assignee', 'Assignee', Object.keys(people).sort(function (a, b) {
        return people[a].localeCompare(people[b]);
      }).map(function (id) { return [id, people[id]]; }).concat([['__none', 'Unassigned']]), ui.assignee) +
      dropdown('status', 'Status', CANONICAL.filter(function (s) { return buckets[s]; }).map(function (s) { return [s, s]; }), ui.status) +
      dropdown('priority', 'Priority', [['urgent', 'Urgent'], ['high', 'High'], ['normal', 'Normal'], ['low', 'Low']], ui.priority) +
      (n ? '<button class="nt-clear" data-act="clear">Clear ' + n + '</button>' : '') +
      '<div class="nt-spacer"></div>' +
      '<span class="nt-count">' + rowCount + ' ' + esc(cardByKey(ui.card).label.replace(/^Total - /, '').toLowerCase()) +
        ' of ' + filteredCount + (activeFilterCount() ? ' matching' : ' in ' + esc(ui.brandName)) + '</span>' +
      '<button class="nt-icon" data-act="refresh" title="Refresh from ClickUp" aria-label="Refresh from ClickUp">' +
        '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">' +
        '<path d="M13.6 6.8A5.8 5.8 0 1 0 13 10.4"/><path d="M13.6 3v3.8h-3.8"/></svg>' +
      '</button>' +
    '</div>';
  }

  function dropdown(field, label, items, sel) {
    var n = Object.keys(sel).length;
    return '<div class="nt-dd" data-field="' + field + '">' +
      '<button class="nt-dd-btn' + (n ? ' on' : '') + '" data-act="dd" aria-expanded="false">' +
        esc(label) + (n ? ' · ' + n : '') + '<span class="nt-caret">▾</span>' +
      '</button>' +
      '<div class="nt-dd-panel" hidden>' + (items.length ? items.map(function (it) {
        return '<label class="nt-dd-opt"><input type="checkbox" data-field="' + field + '" value="' + esc(it[0]) + '"' +
               (sel[it[0]] ? ' checked' : '') + '> <span>' + esc(it[1]) + '</span></label>';
      }).join('') : '<div class="nt-dd-empty">Nothing to filter</div>') + '</div>' +
    '</div>';
  }

  function headHtml() {
    return '<div class="nt-row nt-head">' +
      '<div class="nt-c-name">Task</div>' +
      '<div class="nt-c-status">Status</div>' +
      '<div class="nt-c-assign">Assignees</div>' +
      '<div class="nt-c-due">Due</div>' +
      '<div class="nt-c-pri">Priority</div>' +
      '<div class="nt-c-list">List</div>' +
      '<div class="nt-c-space">Space</div>' +
    '</div>';
  }

  /* Subtasks are nested under a parent when the parent is in the same visible
     set. Anything whose parent is absent is rendered at the top level so it can
     never disappear. Depth capped at 5. */
  function nest(rows) {
    if (!ui.nest) return rows.map(function (t) { return { t: t, d: 0 }; });
    var byId = {}, children = {};
    rows.forEach(function (t) { byId[t.id] = t; });
    rows.forEach(function (t) {
      if (t.parent && byId[t.parent]) (children[t.parent] = children[t.parent] || []).push(t);
    });
    var out = [];
    function walk(t, d) {
      out.push({ t: t, d: d });
      if (d >= 5) return;
      (children[t.id] || []).forEach(function (c) { walk(c, d + 1); });
    }
    rows.forEach(function (t) { if (!t.parent || !byId[t.parent]) walk(t, 0); });
    return out;
  }

  /* Chunked so a few thousand rows never block the main thread. The token
     cancels an in-flight render when a newer one starts. */
  function renderRows(rows) {
    var body = document.getElementById('ntBody');
    if (!body) return;
    var mine = ++renderToken;
    if (!rows.length) {
      body.innerHTML = '<div class="nt-empty">' +
        (activeFilterCount() ? 'No tasks match these filters.' : 'Nothing in ' + esc(cardByKey(ui.card).label) + '.') +
      '</div>';
      return;
    }
    var flat = nest(rows);
    body.innerHTML = '';
    var i = 0;
    (function step() {
      if (mine !== renderToken) return;
      var frag = document.createDocumentFragment();
      var end = Math.min(i + CHUNK, flat.length);
      for (; i < end; i++) {
        var d = document.createElement('div');
        d.innerHTML = rowHtml(flat[i].t, flat[i].d);
        frag.appendChild(d.firstChild);
      }
      body.appendChild(frag);
      if (i < flat.length) requestAnimationFrame(step);
    })();
  }

  function rowHtml(t, depth) {
    var bucket = canonical(t);
    var pri = priorityOf(t);
    return '<div class="nt-row" data-id="' + esc(t.id) + '"' + (t.list ? ' data-list="' + esc(t.list.id) + '"' : '') + '>' +
      '<div class="nt-c-name"' + (depth ? ' style="padding-left:' + (depth * 16) + 'px"' : '') + '>' +
        (depth ? '<span class="nt-sub" aria-hidden="true">↳</span>' : '') +
        '<button class="nt-name" data-act="open">' + esc(t.name || '(untitled)') + '</button>' +
      '</div>' +
      '<div class="nt-c-status">' +
        '<button class="badge ' + severityFor(bucket) + ' nt-editable" data-act="status" ' +
        'title="' + esc((t.status && t.status.status) || bucket) + ' (click to change)">' + esc(bucket) + '</button>' +
      '</div>' +
      '<div class="nt-c-assign"><button class="nt-plain nt-editable" data-act="assign">' + avatarsHtml(t) + '</button></div>' +
      '<div class="nt-c-due"><button class="nt-plain nt-editable" data-act="due">' + fmtDue(t) + '</button></div>' +
      '<div class="nt-c-pri">' + (pri ? '<span class="nt-pri p-' + esc(pri) + '">' + esc(pri) + '</span>' : '<span class="nt-nil">—</span>') + '</div>' +
      '<div class="nt-c-list">' + esc((t.list && t.list.name) || '') + '</div>' +
      '<div class="nt-c-space">' + esc((t.space && t.space.name) || '') + '</div>' +
    '</div>';
  }

  function skeletonHtml() {
    var bars = '';
    for (var i = 0; i < 10; i++) bars += '<div class="nt-sk-row"></div>';
    return '<div class="nt-cards">' + CARDS.map(function () { return '<div class="nt-card nt-sk-card"></div>'; }).join('') + '</div>' +
      '<div class="nt-sk-bar"></div><div class="nt-tablewrap">' + bars + '</div>';
  }

  function emptyState(title, body) {
    return '<div class="nt-blank"><div class="nt-blank-t">' + title + '</div><div class="nt-blank-b">' + body + '</div></div>';
  }

  /* =======================================================================
     Interaction. One delegated listener per container, rebound after each
     paint() because portal.html replaces innerHTML wholesale.
     ===================================================================== */

  function bindOnce(el) {
    if (el.__ntBound === paintId()) return;
    el.__ntBound = paintId();

    el.addEventListener('click', function (ev) {
      var pop = document.getElementById('ntPop');
      var ddBtn = ev.target.closest && ev.target.closest('[data-act="dd"]');
      var inPanel = ev.target.closest && ev.target.closest('.nt-dd-panel');
      if (!ddBtn && !inPanel) closeDropdowns();
      if (!(ev.target.closest && ev.target.closest('.nt-pop')) && pop && !pop.hidden &&
          !(ev.target.closest && ev.target.closest('[data-act="status"],[data-act="assign"],[data-act="due"]'))) {
        pop.hidden = true;
      }

      var card = ev.target.closest && ev.target.closest('[data-card]');
      if (card) { setCard(card.getAttribute('data-card')); return; }

      if (ddBtn) {
        var panel = ddBtn.parentNode.querySelector('.nt-dd-panel');
        var open = panel.hidden;
        closeDropdowns();
        panel.hidden = !open;
        ddBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
        return;
      }

      var act = ev.target.closest && ev.target.closest('[data-act]');
      if (!act) return;
      var kind = act.getAttribute('data-act');
      if (kind === 'clear') { clearFilters(); paint(); return; }
      if (kind === 'refresh') { refresh(); return; }

      var row = act.closest('.nt-row');
      if (!row) return;
      var task = taskById(row.getAttribute('data-id'));
      if (!task) return;
      if (kind === 'open') openDrawer(task);
      if (kind === 'status') openStatusPop(task, act);
      if (kind === 'assign') openAssignPop(task, act);
      if (kind === 'due') openDuePop(task, act);
    });

    el.addEventListener('change', function (ev) {
      var cb = ev.target;
      if (cb.type !== 'checkbox' || !cb.getAttribute('data-field')) return;
      var field = cb.getAttribute('data-field'), val = cb.value;
      if (cb.checked) ui[field][val] = true; else delete ui[field][val];
      paint();
      var b = document.querySelector('.nt-dd[data-field="' + field + '"] .nt-dd-panel');
      if (b) b.hidden = false;
    });

    var qTimer = null;
    el.addEventListener('input', function (ev) {
      if (ev.target.id !== 'ntQ') return;
      clearTimeout(qTimer);
      var v = ev.target.value;
      qTimer = setTimeout(function () {
        ui.q = v;
        paint();
        var q = document.getElementById('ntQ');
        if (q) { q.focus(); q.setSelectionRange(q.value.length, q.value.length); }
      }, 180);
    });

    document.addEventListener('keydown', function (ev) {
      if (ev.key !== 'Escape') return;
      closeDropdowns();
      var pop = document.getElementById('ntPop'); if (pop) pop.hidden = true;
      closeDrawer();
    });
  }
  var _paintId = 0;
  function paintId() { return ++_paintId; }

  function closeDropdowns() {
    Array.prototype.forEach.call(document.querySelectorAll('.nt-dd-panel'), function (p) { p.hidden = true; });
    Array.prototype.forEach.call(document.querySelectorAll('[data-act="dd"]'), function (b) { b.setAttribute('aria-expanded', 'false'); });
  }

  function taskById(id) {
    if (!payload || !payload.tasks) return null;
    for (var i = 0; i < payload.tasks.length; i++) if (payload.tasks[i].id === id) return payload.tasks[i];
    return null;
  }

  function setCard(key) { ui.card = key; paint(); }

  function refresh() {
    var btn = document.querySelector('[data-act="refresh"]');
    if (btn) btn.classList.add('spin');
    load(true).then(paint).catch(function () { paint(); });
  }

  /* =======================================================================
     Writes. Optimistic: patch locally, repaint, then reconcile. On failure the
     original is restored and a toast explains why.
     ===================================================================== */

  function patchLocal(id, patch) {
    var t = taskById(id);
    if (!t) return null;
    var before = {};
    Object.keys(patch).forEach(function (k) { before[k] = t[k]; });
    Object.keys(patch).forEach(function (k) { t[k] = patch[k]; });
    return before;
  }

  function commit(task, body, optimistic, label) {
    if (!PortalAuth.isSignedIn()) { toast('Sign in to ClickUp to make changes.', true); return Promise.resolve(false); }
    var before = patchLocal(task.id, optimistic);
    paint();
    return PortalAuth.fetch('/api/task/' + encodeURIComponent(task.id), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then(function (res) {
      if (!res.ok) return res.json().catch(function () { return {}; }).then(function (e) {
        throw new Error(e.error || ('HTTP ' + res.status));
      });
      /* The server expires its cache on write, so the next natural load is fresh. */
      payloadAt = 0;
      toast(label + ' updated');
      return true;
    }).catch(function (err) {
      if (before) patchLocal(task.id, before);
      paint();
      toast('Could not update ' + label.toLowerCase() + ': ' + err.message, true);
      return false;
    });
  }

  function openStatusPop(task, anchor) {
    var listId = task.list && task.list.id;
    if (!listId) { toast('This task has no list, so its statuses cannot be read.', true); return; }
    showPop(anchor, '<div class="nt-pop-load">Loading statuses…</div>');
    PortalAuth.fetch('/api/list/' + encodeURIComponent(listId) + '/statuses')
      .then(function (r) { return r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status)); })
      .then(function (data) {
        var list = (data && (data.statuses || data)) || [];
        if (!list.length) { showPop(anchor, '<div class="nt-pop-load">No statuses on this list.</div>'); return; }
        showPop(anchor, list.map(function (s) {
          var name = s.status || s.name || String(s);
          var on = task.status && task.status.status === name;
          return '<button class="nt-pop-item' + (on ? ' on' : '') + '" data-status="' + esc(name) + '">' +
            '<span class="nt-dot" style="background:' + esc(s.color || 'var(--ink-3)') + '"></span>' + esc(name) + '</button>';
        }).join(''));
        wirePop(function (el) {
          var name = el.getAttribute('data-status');
          if (!name) return;
          document.getElementById('ntPop').hidden = true;
          commit(task, { status: name },
            { status: Object.assign({}, task.status || {}, { status: name }), canonical_status: null },
            'Status');
        });
      })
      .catch(function (e) { showPop(anchor, '<div class="nt-pop-load">Could not load statuses: ' + esc(e.message) + '</div>'); });
  }

  function openAssignPop(task, anchor) {
    var listId = task.list && task.list.id;
    if (!listId) { toast('This task has no list, so its members cannot be read.', true); return; }
    showPop(anchor, '<div class="nt-pop-load">Loading people…</div>');
    PortalAuth.fetch('/api/list/' + encodeURIComponent(listId) + '/members')
      .then(function (r) { return r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status)); })
      .then(function (data) {
        var members = (data && (data.members || data)) || [];
        var current = {};
        (task.assignees || []).forEach(function (a) { current[String(a.id)] = true; });
        showPop(anchor, members.map(function (m) {
          var on = current[String(m.id)];
          return '<button class="nt-pop-item' + (on ? ' on' : '') + '" data-user="' + esc(m.id) + '">' +
            '<span class="nt-av" style="background:' + tintFor(m.id) + '">' + esc(initialsOf(m)) + '</span>' +
            esc(m.username || m.email || m.id) + (on ? '<span class="nt-tick">✓</span>' : '') + '</button>';
        }).join('') || '<div class="nt-pop-load">Nobody on this list.</div>');
        wirePop(function (el) {
          var id = el.getAttribute('data-user');
          if (!id) return;
          var on = current[String(id)];
          var next = (task.assignees || []).filter(function (a) { return String(a.id) !== String(id); });
          if (!on) {
            var m = members.filter(function (x) { return String(x.id) === String(id); })[0];
            if (m) next = next.concat([m]);
          }
          document.getElementById('ntPop').hidden = true;
          commit(task, { assignees: on ? { rem: [Number(id)] } : { add: [Number(id)] } },
            { assignees: next }, 'Assignees');
        });
      })
      .catch(function (e) { showPop(anchor, '<div class="nt-pop-load">Could not load people: ' + esc(e.message) + '</div>'); });
  }

  function openDuePop(task, anchor) {
    var ms = dueMs(task);
    var val = ms ? new Date(ms).toISOString().slice(0, 10) : '';
    showPop(anchor,
      '<div class="nt-pop-due">' +
        '<input type="date" id="ntDueIn" value="' + esc(val) + '">' +
        '<div class="nt-pop-actions">' +
          (ms ? '<button class="nt-pop-btn ghost" data-due="clear">Clear</button>' : '') +
          '<button class="nt-pop-btn" data-due="save">Save</button>' +
        '</div>' +
      '</div>');
    wirePop(function (el) {
      var a = el.getAttribute('data-due');
      if (!a) return;
      var pop = document.getElementById('ntPop');
      if (a === 'clear') {
        pop.hidden = true;
        commit(task, { due_date: null }, { due_date: null }, 'Due date');
        return;
      }
      var input = document.getElementById('ntDueIn');
      if (!input || !input.value) return;
      /* Noon local so a timezone shift can never move it to the previous day. */
      var picked = new Date(input.value + 'T12:00:00').getTime();
      pop.hidden = true;
      commit(task, { due_date: picked, due_date_time: false }, { due_date: String(picked) }, 'Due date');
    });
  }

  function showPop(anchor, html) {
    var pop = document.getElementById('ntPop');
    if (!pop) return;
    pop.innerHTML = html;
    pop.hidden = false;
    var r = anchor.getBoundingClientRect();
    var host = container().getBoundingClientRect();
    pop.style.top = (r.bottom - host.top + 6) + 'px';
    pop.style.left = Math.max(0, Math.min(r.left - host.left, host.width - 260)) + 'px';
  }
  function wirePop(handler) {
    var pop = document.getElementById('ntPop');
    if (!pop) return;
    pop.onclick = function (ev) {
      var el = ev.target.closest('[data-status],[data-user],[data-due]');
      if (el) handler(el);
    };
  }

  /* =======================================================================
     Drawer
     ===================================================================== */

  function openDrawer(task) {
    var d = document.getElementById('ntDrawer'), s = document.getElementById('ntScrim');
    if (!d) return;
    var bucket = canonical(task);
    d.innerHTML =
      '<div class="nt-dr-head">' +
        '<div><div class="nt-dr-title">' + esc(task.name || '(untitled)') + '</div>' +
        '<div class="nt-dr-sub">' + esc((task.space && task.space.name) || '') +
          ((task.list && task.list.name) ? ' · ' + esc(task.list.name) : '') + '</div></div>' +
        '<button class="nt-icon" data-act="drclose" aria-label="Close">✕</button>' +
      '</div>' +
      '<div class="nt-dr-meta">' +
        metaRow('Status', '<span class="badge ' + severityFor(bucket) + '">' + esc(bucket) + '</span>') +
        metaRow('Raw status', esc((task.status && task.status.status) || '—')) +
        metaRow('Assignees', avatarsHtml(task)) +
        metaRow('Due', fmtDue(task)) +
        metaRow('Priority', priorityOf(task) ? esc(priorityOf(task)) : '<span class="nt-nil">—</span>') +
      '</div>' +
      (task.url ? '<a class="nt-dr-link" href="' + esc(task.url) + '" target="_blank" rel="noopener">Open in ClickUp ↗</a>' : '') +
      '<div class="nt-dr-sec">Comments</div>' +
      '<div id="ntComments" class="nt-comments"><div class="nt-pop-load">Loading…</div></div>' +
      '<form class="nt-cform" id="ntCForm"><textarea id="ntCText" rows="2" placeholder="Add a comment…"></textarea>' +
      '<button class="nt-pop-btn" type="submit">Post</button></form>';
    d.hidden = false; if (s) s.hidden = false;

    d.onclick = function (ev) {
      if (ev.target.closest('[data-act="drclose"]')) closeDrawer();
    };
    if (s) s.onclick = closeDrawer;

    loadComments(task);
    var form = document.getElementById('ntCForm');
    if (form) form.onsubmit = function (ev) {
      ev.preventDefault();
      var box = document.getElementById('ntCText');
      var text = (box.value || '').trim();
      if (!text) return;
      if (!PortalAuth.isSignedIn()) { toast('Sign in to ClickUp to comment.', true); return; }
      box.disabled = true;
      PortalAuth.fetch('/api/task/' + encodeURIComponent(task.id) + '/comment', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ comment_text: text }),
      }).then(function (r) {
        if (!r.ok) return r.json().catch(function () { return {}; }).then(function (e) { throw new Error(e.error || ('HTTP ' + r.status)); });
        box.value = ''; loadComments(task);
      }).catch(function (e) { toast('Comment failed: ' + e.message, true); })
        .then(function () { box.disabled = false; box.focus(); });
    };
  }
  function metaRow(k, v) {
    return '<div class="nt-dr-row"><span class="nt-dr-k">' + esc(k) + '</span><span class="nt-dr-v">' + v + '</span></div>';
  }
  function loadComments(task) {
    var box = document.getElementById('ntComments');
    if (!box) return;
    PortalAuth.fetch('/api/task/' + encodeURIComponent(task.id) + '/comments')
      .then(function (r) { return r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status)); })
      .then(function (d) {
        var list = (d && d.comments) || [];
        box.innerHTML = list.length ? list.map(function (c) {
          var who = (c.user && (c.user.username || c.user.email)) || 'Unknown';
          var txt = c.comment_text || (Array.isArray(c.comment) ? c.comment.map(function (p) { return p.text || ''; }).join('') : '');
          var when = c.date ? new Date(parseInt(c.date, 10)) : null;
          return '<div class="nt-cm"><div class="nt-cm-h">' + esc(who) +
            (when ? ' · ' + MONTHS[when.getMonth()] + ' ' + when.getDate() : '') + '</div>' +
            '<div class="nt-cm-b">' + esc(txt) + '</div></div>';
        }).join('') : '<div class="nt-pop-load">No comments.</div>';
      })
      .catch(function (e) { box.innerHTML = '<div class="nt-pop-load">Could not load comments: ' + esc(e.message) + '</div>'; });
  }
  function closeDrawer() {
    var d = document.getElementById('ntDrawer'), s = document.getElementById('ntScrim');
    if (d) d.hidden = true;
    if (s) s.hidden = true;
  }

  function toast(msg, bad) {
    var el = document.getElementById('ntToast');
    if (!el) return;
    el.textContent = msg;
    el.className = 'nt-toast' + (bad ? ' bad' : '');
    el.hidden = false;
    clearTimeout(el.__t);
    el.__t = setTimeout(function () { el.hidden = true; }, bad ? 6000 : 2600);
  }

  /* =======================================================================
     Styles. Layout and geometry only - every colour is a token, so light and
     dark come for free and stay in step with the rest of the portal.
     ===================================================================== */

  function injectStyles() {
    if (document.getElementById('nt-styles')) return;
    var css = [
      '.nt-cards{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:14px}',
      '@media (max-width:900px){.nt-cards{grid-template-columns:repeat(2,1fr)}}',
      '.nt-card{text-align:left;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius,11px);',
        'padding:12px 14px;cursor:pointer;display:block;position:relative;transition:border-color .12s,background .12s}',
      '.nt-card:hover{background:var(--surface-2,var(--panel-2))}',
      '.nt-card:focus-visible{outline:2px solid var(--focus,var(--accent));outline-offset:2px}',
      '.nt-card.on{border-color:var(--accent);background:var(--accent-soft,var(--surface-2))}',
      '.nt-card.on::after{content:"";position:absolute;left:14px;right:14px;bottom:-1px;height:2px;background:var(--accent);border-radius:2px}',
      '.nt-card-l{display:block;font-size:11.5px;font-weight:600;color:var(--text2);letter-spacing:.01em}',
      '.nt-card-v{display:block;font-size:26px;font-weight:650;color:var(--text);line-height:1.15;margin:2px 0 1px;font-variant-numeric:tabular-nums}',
      '.nt-card-s{display:block;font-size:11px;color:var(--text3)}',
      '.nt-card.t-crit.on .nt-card-v{color:var(--crit-ink,var(--red))}',
      '.nt-card.t-warn.on .nt-card-v{color:var(--warn-ink,var(--yellow))}',
      '.nt-card.t-good.on .nt-card-v{color:var(--good-ink,var(--green))}',

      '.nt-bar{display:flex;align-items:center;gap:8px;margin-bottom:10px;flex-wrap:wrap}',
      '.nt-spacer{flex:1}',
      '.nt-search{height:30px;min-width:190px;padding:0 10px;border-radius:8px;border:1px solid var(--border);',
        'background:var(--surface);color:var(--text);font:inherit;font-size:12.5px}',
      '.nt-search:focus{outline:2px solid var(--focus,var(--accent));outline-offset:-1px}',
      '.nt-dd{position:relative}',
      '.nt-dd-btn,.nt-clear,.nt-icon{height:30px;padding:0 10px;border-radius:8px;border:1px solid var(--border);',
        'background:var(--surface);color:var(--text2);font:inherit;font-size:12.5px;cursor:pointer;display:inline-flex;align-items:center;gap:5px}',
      '.nt-dd-btn:hover,.nt-clear:hover,.nt-icon:hover{background:var(--surface-2,var(--panel-2));color:var(--text)}',
      '.nt-dd-btn.on{border-color:var(--accent);color:var(--accent)}',
      '.nt-caret{opacity:.6;font-size:10px}',
      '.nt-dd-panel{position:absolute;z-index:40;top:34px;left:0;min-width:210px;max-height:280px;overflow:auto;',
        'background:var(--surface);border:1px solid var(--border);border-radius:10px;box-shadow:var(--shadow-md,0 8px 24px -6px rgba(0,0,0,.3));padding:5px}',
      '.nt-dd-opt{display:flex;align-items:center;gap:8px;padding:5px 8px;border-radius:6px;font-size:12.5px;color:var(--text);cursor:pointer}',
      '.nt-dd-opt:hover{background:var(--surface-2,var(--panel-2))}',
      '.nt-dd-empty{padding:8px;font-size:12px;color:var(--text3)}',
      '.nt-count{font-size:12px;color:var(--text3);font-variant-numeric:tabular-nums}',
      '.nt-icon.spin svg{animation:ntspin .8s linear infinite}',
      '@keyframes ntspin{to{transform:rotate(360deg)}}',

      '.nt-banner{margin-bottom:10px;padding:8px 12px;border-radius:8px;font-size:12.5px;',
        'background:var(--warn-soft,var(--surface-2));color:var(--warn-ink,var(--text));border:1px solid var(--border)}',

      '.nt-tablewrap{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius,11px);overflow:hidden}',
      '.nt-thead{position:sticky;top:0;z-index:2;background:var(--surface-2,var(--panel-2));border-bottom:1px solid var(--border)}',
      '.nt-row{display:grid;grid-template-columns:minmax(220px,2.6fr) 116px 92px 84px 78px minmax(90px,1fr) minmax(90px,1fr);',
        'align-items:center;gap:10px;padding:0 14px;min-height:var(--row-h,38px);border-bottom:1px solid var(--border)}',
      '.nt-row:last-child{border-bottom:none}',
      '.nt-tbody .nt-row:hover{background:var(--surface-2,var(--panel-2))}',
      '.nt-head{font-size:11px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--text3);border-bottom:none}',
      '.nt-row>div{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12.5px;color:var(--text2)}',
      '.nt-c-name{display:flex;align-items:center;gap:6px}',
      '.nt-name{background:none;border:none;padding:0;font:inherit;font-size:13px;color:var(--text);text-align:left;',
        'cursor:pointer;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.nt-name:hover{color:var(--accent);text-decoration:underline}',
      '.nt-sub{color:var(--text3);font-size:11px;flex:none}',
      '.nt-plain{background:none;border:none;padding:2px 4px;margin:-2px -4px;border-radius:6px;font:inherit;color:inherit;cursor:pointer}',
      '.nt-editable{cursor:pointer}',
      '.nt-editable:hover{box-shadow:inset 0 0 0 1px var(--border-strong,var(--border2))}',
      '.nt-nil{color:var(--text3)}',
      '.nt-due{font-variant-numeric:tabular-nums}',
      '.nt-due-over{color:var(--crit-ink,var(--red));font-weight:600}',
      '.nt-due-soon{color:var(--warn-ink,var(--yellow))}',
      '.nt-avs{display:inline-flex;gap:3px}',
      '.nt-av{width:20px;height:20px;border-radius:50%;display:inline-grid;place-items:center;color:#fff;',
        'font-size:9px;font-weight:650;letter-spacing:-.2px;flex:none}',
      '.nt-av-more{background:var(--surface-3,var(--panel-2))!important;color:var(--text2)}',
      '.nt-pri{font-size:11px;text-transform:capitalize;color:var(--text2)}',
      '.nt-pri.p-urgent{color:var(--crit-ink,var(--red));font-weight:600}',
      '.nt-pri.p-high{color:var(--warn-ink,var(--orange))}',
      '.nt-empty,.nt-pop-load{padding:26px 14px;text-align:center;font-size:12.5px;color:var(--text3)}',

      '.nt-blank{padding:56px 20px;text-align:center}',
      '.nt-blank-t{font-size:14.5px;font-weight:600;color:var(--text);margin-bottom:6px}',
      '.nt-blank-b{font-size:12.5px;color:var(--text2);max-width:440px;margin:0 auto;line-height:1.55}',

      '.nt-pop{position:absolute;z-index:60;min-width:210px;max-width:260px;max-height:300px;overflow:auto;',
        'background:var(--surface);border:1px solid var(--border);border-radius:10px;',
        'box-shadow:var(--shadow-md,0 8px 24px -6px rgba(0,0,0,.35));padding:5px}',
      '.nt-pop-item{display:flex;align-items:center;gap:8px;width:100%;padding:6px 8px;border:none;background:none;',
        'border-radius:6px;font:inherit;font-size:12.5px;color:var(--text);cursor:pointer;text-align:left}',
      '.nt-pop-item:hover{background:var(--surface-2,var(--panel-2))}',
      '.nt-pop-item.on{background:var(--accent-soft,var(--surface-2));color:var(--accent)}',
      '.nt-dot{width:8px;height:8px;border-radius:50%;flex:none}',
      '.nt-tick{margin-left:auto;color:var(--accent)}',
      '.nt-pop-due{padding:8px}',
      '.nt-pop-due input{width:100%;height:30px;padding:0 8px;border-radius:7px;border:1px solid var(--border);',
        'background:var(--surface);color:var(--text);font:inherit;font-size:12.5px}',
      '.nt-pop-actions{display:flex;gap:6px;justify-content:flex-end;margin-top:8px}',
      '.nt-pop-btn{padding:6px 12px;border-radius:7px;border:1px solid transparent;background:var(--accent);color:#fff;',
        'font:inherit;font-size:12.5px;font-weight:600;cursor:pointer}',
      '.nt-pop-btn.ghost{background:none;border-color:var(--border);color:var(--text2)}',

      '.nt-scrim{position:fixed;inset:0;z-index:70;background:rgba(0,0,0,.34)}',
      '.nt-drawer{position:fixed;top:0;right:0;bottom:0;z-index:71;width:min(440px,94vw);overflow:auto;',
        'background:var(--surface);border-left:1px solid var(--border);padding:18px 20px}',
      '.nt-dr-head{display:flex;align-items:flex-start;gap:10px;margin-bottom:14px}',
      '.nt-dr-title{font-size:15px;font-weight:650;color:var(--text);line-height:1.35}',
      '.nt-dr-sub{font-size:11.5px;color:var(--text3);margin-top:3px}',
      '.nt-dr-row{display:flex;gap:10px;padding:6px 0;border-bottom:1px solid var(--border);font-size:12.5px}',
      '.nt-dr-k{width:96px;flex:none;color:var(--text3)}',
      '.nt-dr-v{color:var(--text)}',
      '.nt-dr-link{display:inline-block;margin:12px 0;font-size:12.5px;color:var(--accent);text-decoration:none}',
      '.nt-dr-link:hover{text-decoration:underline}',
      '.nt-dr-sec{margin:14px 0 8px;font-size:11px;font-weight:600;letter-spacing:.05em;text-transform:uppercase;color:var(--text3)}',
      '.nt-cm{padding:8px 0;border-bottom:1px solid var(--border)}',
      '.nt-cm-h{font-size:11.5px;color:var(--text3);margin-bottom:3px}',
      '.nt-cm-b{font-size:12.5px;color:var(--text);white-space:pre-wrap;line-height:1.5}',
      '.nt-cform{display:flex;gap:8px;margin-top:12px}',
      '.nt-cform textarea{flex:1;padding:7px 9px;border-radius:8px;border:1px solid var(--border);',
        'background:var(--surface);color:var(--text);font:inherit;font-size:12.5px;resize:vertical}',

      '.nt-toast{position:fixed;left:50%;bottom:26px;transform:translateX(-50%);z-index:90;padding:9px 16px;',
        'border-radius:9px;font-size:12.5px;background:var(--ink);color:var(--surface);',
        'box-shadow:var(--shadow-md,0 8px 24px -6px rgba(0,0,0,.4))}',
      '.nt-toast.bad{background:var(--crit,#d03b3b);color:#fff}',

      '.nt-sk-card{height:76px;background:var(--surface-2,var(--panel-2));border-color:transparent}',
      '.nt-sk-bar{height:30px;border-radius:8px;background:var(--surface-2,var(--panel-2));margin-bottom:10px;max-width:420px}',
      '.nt-sk-row{height:var(--row-h,38px);border-bottom:1px solid var(--border);background:',
        'linear-gradient(90deg,transparent,var(--surface-2,var(--panel-2)),transparent);background-size:200% 100%;animation:ntsk 1.4s linear infinite}',
      '@keyframes ntsk{to{background-position:-200% 0}}',
      '@media (prefers-reduced-motion:reduce){.nt-sk-row,.nt-icon.spin svg{animation:none}}',
    ].join('');
    var el = document.createElement('style');
    el.id = 'nt-styles';
    el.textContent = css;
    document.head.appendChild(el);
  }
  injectStyles();

  /* Signing out (or a 401 anywhere) must put the gate back immediately. */
  if (window.PortalAuth && PortalAuth.onChange) {
    PortalAuth.onChange(function () {
      if (container()) render(ui.brand, ui.containerId, { spaces: ui.spaces, brandName: ui.brandName });
    });
  }

  window.PortalTasks = {
    render: render,
    invalidate: function () { payloadAt = 0; },
    refresh: refresh,
    setCard: setCard,
    /* exposed for the fixture harness and for console debugging */
    _internals: {
      CARDS: CARDS, canonical: canonical, isOpen: isOpen, isCompleted: isCompleted,
      startOfToday: startOfToday, dueMs: dueMs, applyFilters: applyFilters,
      setPayload: function (p) { payload = p; payloadAt = Date.now(); },
      ui: ui,
    },
  };
})();
