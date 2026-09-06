/* Leads (GHL) — the command-center Leads screen, brand-scoped.

   Stage bar over a split list/reader, exactly as command-center lays it out.
   Everything reads /api/ghl.

   ---------------------------------------------------------------------------
   THE BRAND IS THE SCOPE, AND IT IS NOT A FILTER

   The LeavenWealth workspace shows LeavenWealth's GHL sub-account and nobody
   else's. `company_id` goes on every request and the server resolves it to a
   set of location ids; there is deliberately no control that could widen it,
   because the workspace switcher already IS that control.

   Verified against the live database on 2026-09-07:

     LeavenWealth  1,231 leads   31 opportunities     0 messages
     Leadli AI     2,538 leads    0 opportunities     0 messages
     Folio Excel   4,643 leads    8 opportunities   111 messages
     Liquid Lending — no GHL sub-account at all

   Two consequences the screen has to state rather than imply:

   1. THE THREAD IS EMPTY FOR TWO OF THE THREE BRANDS. Only Folio has messages
      ingested. An empty Messages tab under LeavenWealth is the ingest, not a
      broken screen, and it says so.

   2. MOST LEADS HAVE NO STAGE. A stage belongs to an opportunity, not to a
      person — 28 of LeavenWealth's 1,231 leads have one. The chip is absent
      rather than defaulted to "new", which would assert a stage about twelve
      hundred people.

   Liquid Lending gets a real empty state naming the reason, not a spinner that
   never resolves.

   ---------------------------------------------------------------------------
   READ ONLY

   command-center can send a message because it holds a GHL Private Integration
   Token per location. This service holds no GHL credential, so there is no
   composer, no reply box and no sync button — and no control that looks like
   one and fails. Refresh is a re-read; the GHL -> Supabase pipeline is owned
   elsewhere (n8n) and this dashboard cannot start, stop or retry it.
   --------------------------------------------------------------------------- */

window.PortalGHL = (function () {
  'use strict';

  var API = '/api/ghl';

  var S = {
    companyId: null,
    brandName: '',
    locations: [], scoped: false, scopeResolved: false,
    leads: [], total: 0, stages: [],
    q: '', searchIgnored: false,
    stage: null,              /* selected stage id, or null for all */
    openId: null, detail: null, thread: null, tab: 'messages',
    loading: false, error: null,
    loadedFor: null,          /* which company the current data belongs to */
    syncedAt: null, ingestBad: null
  };

  var host = null;
  var searchTimer = null;

  /* ---- helpers ---------------------------------------------------------- */

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  function nil() { return '<span class="ld-nil">&mdash;</span>'; }

  function getJson(url) {
    return fetch(url, { headers: { Accept: 'application/json' } }).then(function (r) {
      return r.json().then(function (j) {
        if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
        return j;
      });
    });
  }

  /* company_id rides on every request. Building it here rather than at each
     call site is what makes it impossible to forget on one of them. */
  function qs(extra) {
    var p = [];
    if (S.companyId) p.push('company_id=' + encodeURIComponent(S.companyId));
    if (extra) Object.keys(extra).forEach(function (k) {
      if (extra[k] !== null && extra[k] !== undefined && extra[k] !== '') {
        p.push(k + '=' + encodeURIComponent(extra[k]));
      }
    });
    return p.join('&');
  }

  /* ---- loading ---------------------------------------------------------- */

  function loadAll() {
    S.loading = true; S.error = null;
    paint();
    var mine = S.companyId;
    return Promise.all([
      getJson(API + '/locations?' + qs()),
      getJson(API + '/stages?' + qs()),
      getJson(API + '/leads?' + qs({ q: S.q })),
      getJson(API + '/sync?' + qs()).catch(function () { return null; })
    ]).then(function (out) {
      /* The brand can change while a request is in flight. Landing another
         brand's leads under this one is the single failure this screen exists
         to prevent, so a late response for a brand we have left is dropped. */
      if (mine !== S.companyId) return;
      S.locations = out[0].locations || [];
      S.scoped = !!out[0].scoped;
      S.scopeResolved = !!out[0].scopeResolved;
      S.stages = out[1].stages || [];
      S.leads = out[2].leads || [];
      S.total = out[2].total || 0;
      S.searchIgnored = !!out[2].searchIgnored;
      S.syncedAt = Date.now();
      S.ingestBad = ingestProblem(out[3]);
      S.loadedFor = mine;
    }).catch(function (e) {
      if (mine !== S.companyId) return;
      S.error = e.message; S.leads = []; S.stages = [];
    }).then(function () {
      if (mine !== S.companyId) return;
      S.loading = false;
      paint();
    });
  }

  function loadLeads() {
    S.loading = true;
    paint();
    var mine = S.companyId;
    return getJson(API + '/leads?' + qs({ q: S.q })).then(function (j) {
      if (mine !== S.companyId) return;
      S.leads = j.leads || [];
      S.total = j.total || 0;
      S.searchIgnored = !!j.searchIgnored;
      S.error = null;
    }).catch(function (e) {
      if (mine !== S.companyId) return;
      S.error = e.message; S.leads = [];
    }).then(function () {
      if (mine !== S.companyId) return;
      S.loading = false; paint();
    });
  }

  function openLead(id) {
    S.openId = id; S.detail = null; S.thread = null; S.tab = 'messages';
    paint();
    var mine = S.companyId;
    Promise.all([
      getJson(API + '/leads/' + encodeURIComponent(id) + '/thread?' + qs()).catch(function () { return null; }),
      getJson(API + '/leads/' + encodeURIComponent(id) + '/detail?' + qs()).catch(function () { return null; })
    ]).then(function (out) {
      if (mine !== S.companyId || S.openId !== id) return;
      S.thread = out[0] || { thread: [], activity: [], pending: [] };
      S.detail = out[1] || { fields: [], attribution: [], notes: [], tasks: [], appointments: [] };
      paint();
    });
  }

  /* One line for the pipeline as a whole. A stalled ingest is why a lead would
     look out of date, and there is no per-location signal for it. */
  function ingestProblem(sync) {
    if (!sync || !sync.ingest) return null;
    var bad = (sync.ingest.entities || []).filter(function (e) { return e.status === 'error'; });
    if (!bad.length) return null;
    var first = bad[0];
    var days = first.at ? Math.floor((Date.now() - new Date(first.at).getTime()) / 86400000) : null;
    return 'Ingest error on ' + (first.entity || 'a feed') +
      (days !== null ? ' (' + days + 'd ago)' : '') +
      (bad.length > 1 ? ' and ' + (bad.length - 1) + ' more' : '') + '.';
  }

  /* ---- render ----------------------------------------------------------- */

  function paint() {
    if (!host) return;
    host.innerHTML = view();
    wire();
  }

  function view() {
    return header() + banner() + notes() + stagebar() + split();
  }

  function header() {
    var syncCls = S.error ? 'bad' : (S.syncedAt ? 'ok' : '');
    var syncTxt = S.error ? 'read failed'
      : S.loading ? 'reading…'
      : S.syncedAt ? 'read ' + rel(S.syncedAt) : '';
    return '' +
      '<div class="ld-head">' +
        '<div>' +
          '<h1 class="ld-title">Leads</h1>' +
          '<p class="ld-sub">' + esc(S.brandName || 'GHL') + subLocations() + '</p>' +
        '</div>' +
        '<div class="ld-tools">' +
          '<div class="ld-search">' +
            '<span class="ic">&#9906;</span>' +
            '<input id="ld-q" type="search" autocomplete="off" spellcheck="false"' +
              ' placeholder="Search name, email, phone, tag…" value="' + esc(S.q) + '">' +
            (S.q ? '<button class="x" id="ld-qclear" title="Clear">&times;</button>' : '') +
          '</div>' +
          '<span class="ld-synced ' + syncCls + '"><span class="d"></span>' + esc(syncTxt) + '</span>' +
          /* Refresh only. There is nothing to connect and nothing to re-sync:
             the GHL -> Supabase pipeline is owned elsewhere. */
          '<button class="ld-btn" id="ld-refresh">Refresh</button>' +
        '</div>' +
      '</div>';
  }

  function subLocations() {
    if (!S.locations.length) return '';
    return ' &middot; ' + S.locations.map(function (l) {
      return esc(l.name) + ' (' + Number(l.leads).toLocaleString() + ')';
    }).join(' &middot; ');
  }

  function banner() {
    if (!S.error) return '';
    return '<div class="ld-banner">' + esc(S.error) + '</div>';
  }

  function notes() {
    var out = '';
    /* Liquid Lending has no ghl_location row but does have leads carrying only
       a company_id. Saying so is the difference between "this brand is not set
       up in GHL" and "this screen is broken", which look identical otherwise. */
    if (!S.loading && S.scoped && !S.scopeResolved) {
      out += '<div class="ld-note">No GHL sub-account is linked to <b>' +
        esc(S.brandName || 'this workspace') + '</b>. ' +
        (S.leads.length
          ? 'The ' + S.leads.length + ' lead' + (S.leads.length === 1 ? '' : 's') +
            ' below carry a brand but no location, so they have no conversation or pipeline record.'
          : 'Nothing in <code>ghl_location</code> points here, so there is nothing to read.') +
        '</div>';
    }
    if (S.ingestBad) out += '<div class="ld-banner">' + esc(S.ingestBad) + '</div>';
    if (S.searchIgnored) {
      out += '<div class="ld-note">A single character is not a search. Type at least two.</div>';
    }
    return out;
  }

  function stagebar() {
    if (!S.stages.length) return '';
    var all = S.leads.length;
    var cards = '<button class="ld-stage' + (S.stage === null ? ' on' : '') + '" data-stage="">' +
      '<span class="n">All</span><span class="v">' + Number(S.total || all).toLocaleString() + '</span></button>';
    cards += S.stages.map(function (s) {
      var id = s.id || s.stage_id || s.ghl_stage_id;
      return '<button class="ld-stage' + (S.stage === id ? ' on' : '') + '" data-stage="' + esc(id) + '">' +
        '<span class="n">' + esc(s.name || s.stage_name || 'Stage') + '</span>' +
        '<span class="v">' + Number(s.count != null ? s.count : 0).toLocaleString() + '</span>' +
      '</button>';
    }).join('');
    return '<div class="ld-stagebar">' + cards + '</div>';
  }

  function shownLeads() {
    if (S.stage === null) return S.leads;
    return S.leads.filter(function (l) { return l.stageId === S.stage; });
  }

  function split() {
    var rows = shownLeads();
    var list =
      '<div class="ld-card">' +
        '<div class="ld-cardhead"><h3>Leads</h3><span class="ld-eyebrow">' +
          (S.loading ? '…' : Number(rows.length).toLocaleString() +
            (S.total && rows.length !== S.total ? ' of ' + Number(S.total).toLocaleString() : '')) +
        '</span></div>' +
        '<div class="ld-list">' + (
          S.loading && !S.leads.length ? '<div class="ld-loading">Reading leads…</div>'
          : !rows.length ? emptyList()
          : rows.map(leadRow).join('')
        ) + '</div>' +
      '</div>';

    if (!S.openId) return '<div class="ld-wrap">' + list + '</div>';
    return '<div class="ld-wrap split">' + list + reader() + '</div>';
  }

  function emptyList() {
    if (S.q) return '<div class="ld-empty"><b>No match</b>Nothing in this workspace matches &ldquo;' + esc(S.q) + '&rdquo;.</div>';
    if (S.stage !== null) return '<div class="ld-empty"><b>No leads at this stage</b>Pick another stage, or All.</div>';
    return '<div class="ld-empty"><b>No leads yet</b>Nothing has been ingested for this workspace.</div>';
  }

  function leadRow(l) {
    var cls = 'ld-row' + (l.id === S.openId ? ' on' : '') + (l.unread ? ' unread' : '');
    var stage = l.stageName
      ? '<span class="ld-stagechip ' + esc(String(l.status || '').toLowerCase()) + '">' + esc(l.stageName) + '</span>'
      : '';
    var meta = [l.email, l.phone, l.source].filter(Boolean).map(esc).join(' &middot; ');
    var tags = (l.tags || []).slice(0, 3).map(function (t) {
      return '<span class="ld-tag">' + esc(t) + '</span>';
    }).join('') + ((l.tags || []).length > 3
      ? '<span class="ld-tag more">+' + (l.tags.length - 3) + '</span>' : '');

    return '<button class="' + cls + '" data-lead="' + esc(l.id) + '">' +
      '<span class="top">' +
        '<span class="ld-name">' + esc(l.name) + '</span>' + stage +
        '<span class="ld-when">' + esc(l.last || '') + '</span>' +
      '</span>' +
      '<div class="ld-meta">' + (meta || '&nbsp;') + '</div>' +
      (tags ? '<div class="ld-tags">' + tags + '</div>' : '') +
    '</button>';
  }

  function reader() {
    var l = S.leads.filter(function (x) { return x.id === S.openId; })[0];
    if (!l) return '';
    var t = S.thread || { thread: [], activity: [], pending: [] };
    var d = S.detail || { fields: [], attribution: [], notes: [], tasks: [], appointments: [] };

    var tabs = [
      ['messages', 'Messages', t.thread.length],
      ['activity', 'Activity', t.activity.length],
      ['fields', 'Fields', d.fields.length],
      ['notes', 'Notes', d.notes.length],
      ['tasks', 'Tasks', (d.tasks || []).length + (d.appointments || []).length]
    ];

    return '<div class="ld-card ld-reader">' +
      '<div class="ld-rhead">' +
        '<button class="ld-rclose" id="ld-close" title="Close">&times;</button>' +
        '<div class="ld-rname">' + esc(l.name) + '</div>' +
        '<div class="ld-rmeta">' +
          (l.email ? '<a href="mailto:' + esc(l.email) + '">' + esc(l.email) + '</a>' : '') +
          (l.phone ? '<a href="tel:' + esc(l.phone.replace(/[^\d+]/g, '')) + '">' + esc(l.phone) + '</a>' : '') +
          (l.owner ? '<span>Owner: ' + esc(l.owner) + '</span>' : '') +
          (l.source ? '<span>Source: ' + esc(l.source) + '</span>' : '') +
          (l.created ? '<span>Added ' + esc(l.created) + '</span>' : '') +
          (l.value ? '<span>$' + Number(l.value).toLocaleString() + '</span>' : '') +
        '</div>' +
      '</div>' +
      '<div class="ld-tabs">' + tabs.map(function (x) {
        return '<button class="ld-tab' + (S.tab === x[0] ? ' on' : '') + '" data-ldtab="' + x[0] + '">' +
          x[1] + '<span class="n">' + x[2] + '</span></button>';
      }).join('') + '</div>' +
      '<div class="ld-body">' + readerBody(t, d) + '</div>' +
    '</div>';
  }

  function readerBody(t, d) {
    if (!S.thread && !S.detail) return '<div class="ld-loading">Reading…</div>';

    if (S.tab === 'messages') {
      if (!t.thread.length) {
        /* The distinction that matters. Two of the three brands have zero rows
           in ghl_message, so "no messages" here is the ingest and not this
           screen — saying which one saves somebody an afternoon. */
        return '<div class="ld-empty"><b>No messages</b>' +
          'No conversation has been ingested for this contact. Message history is ' +
          'currently only populated for Folio Excel.</div>';
      }
      return t.thread.map(function (m) {
        return '<div class="ld-bubble ' + (m.dir === 'in' ? 'in' : 'out') + '">' +
          '<div class="bh"><span>' + esc(m.channel || '') + '</span>' +
            '<span>' + esc(m.day) + ' ' + esc(m.time) + '</span>' +
            (m.actor ? '<span>' + esc(m.actor) + '</span>' : '') + '</div>' +
          (m.subject ? '<div class="subj">' + esc(m.subject) + '</div>' : '') +
          esc(m.body) +
          (m.attachments ? '<div class="bh">' + m.attachments + ' attachment(s)</div>' : '') +
        '</div>';
      }).join('');
    }

    if (S.tab === 'activity') {
      if (!t.activity.length) return '<div class="ld-empty"><b>No activity</b>Nothing recorded for this contact.</div>';
      return t.activity.map(function (a) {
        return '<div class="ld-act"><span class="k">' + esc(a.kind || '') + '</span>' +
          '<span>' + esc(a.body || '') + '</span>' +
          '<span class="ld-when" style="margin-left:auto">' + esc(a.day) + '</span></div>';
      }).join('');
    }

    var open = S.leads.filter(function (x) { return x.id === S.openId; })[0];
    if (open && open.noLocation) {
      return '<div class="ld-empty"><b>No GHL sub-account</b>' +
        'This lead carries a brand but no <code>ghl_location_id</code>, so there is no ' +
        'conversation, pipeline record or custom-field history to show. Its contact ' +
        'details are in the header above.</div>';
    }

    if (S.tab === 'fields') {
      if (!d.fields.length) return '<div class="ld-empty"><b>No custom fields</b>Nothing set on this contact.</div>';
      return '<dl class="ld-fields">' + d.fields.map(function (f) {
        return '<dt>' + esc(f.name) + '</dt><dd>' + (f.value ? esc(f.value) : nil()) + '</dd>';
      }).join('') + '</dl>';
    }

    if (S.tab === 'notes') {
      if (!d.notes.length) return '<div class="ld-empty"><b>No notes</b>Nothing written against this contact.</div>';
      return d.notes.map(function (n) {
        return '<div class="ld-act"><span class="k">' + esc(n.when || '') + '</span>' +
          '<span style="white-space:pre-wrap">' + esc(n.body || '') + '</span></div>';
      }).join('');
    }

    var items = (d.tasks || []).map(function (x) { return ['Task', x.title || x.body || '', x.due_date || '']; })
      .concat((d.appointments || []).map(function (x) { return ['Appointment', x.title || x.calendar_name || '', x.start_time || '']; }));
    if (!items.length) return '<div class="ld-empty"><b>Nothing scheduled</b>No tasks or appointments for this contact.</div>';
    return items.map(function (x) {
      return '<div class="ld-act"><span class="k">' + esc(x[0]) + '</span>' +
        '<span>' + esc(x[1]) + '</span>' +
        '<span class="ld-when" style="margin-left:auto">' + esc(String(x[2]).slice(0, 10)) + '</span></div>';
    }).join('');
  }

  function rel(ms) {
    var m = Math.round((Date.now() - ms) / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return m + 'm ago';
    var h = Math.round(m / 60);
    return h < 24 ? h + 'h ago' : Math.round(h / 24) + 'd ago';
  }

  /* ---- wiring ------------------------------------------------------------
     `.onclick =` throughout, never addEventListener. paint() replaces the
     whole subtree and mount() runs on every navigation back, so
     addEventListener would stack a copy per paint and fire N requests per
     click — the bug the Users screen hit with its focus listener. */

  function wire() {
    var q = host.querySelector('#ld-q');
    if (q) {
      /* Debounced. The search runs across every lead in scope, not the page on
         screen, so firing it per keystroke is thousands of rows per letter. */
      q.oninput = function () {
        S.q = this.value;
        clearTimeout(searchTimer);
        searchTimer = setTimeout(function () { loadLeads(); }, 280);
      };
      /* Restores the caret after the repaint. The field is type=search, which
         DOES support the caret API — unlike type=email, which is what made the
         invite form type backwards. */
      if (document.activeElement !== q && S.q) {
        var pos = q.value.length;
        q.focus(); try { q.setSelectionRange(pos, pos); } catch (e) {}
      }
    }
    var qc = host.querySelector('#ld-qclear');
    if (qc) qc.onclick = function () { S.q = ''; loadLeads(); };

    var rf = host.querySelector('#ld-refresh');
    if (rf) rf.onclick = function () { loadAll(); };

    host.querySelectorAll('[data-stage]').forEach(function (b) {
      b.onclick = function () {
        var v = b.getAttribute('data-stage');
        S.stage = v || null;
        paint();
      };
    });

    host.querySelectorAll('[data-lead]').forEach(function (b) {
      b.onclick = function () {
        var id = b.getAttribute('data-lead');
        if (S.openId === id) { S.openId = null; S.thread = null; S.detail = null; paint(); return; }
        var lead = S.leads.filter(function (x) { return x.id === id; })[0];
        /* No location means no thread and no detail to fetch — both routes
           resolve the lead through its location and would 404. Opening it with
           empty payloads shows the contact header and an honest reason, rather
           than firing two requests to be told nothing. */
        if (lead && lead.noLocation) {
          S.openId = id; S.tab = 'fields';
          S.thread = { thread: [], activity: [], pending: [] };
          S.detail = { fields: [], attribution: [], notes: [], tasks: [], appointments: [] };
          paint();
          return;
        }
        openLead(id);
      };
    });

    host.querySelectorAll('[data-ldtab]').forEach(function (b) {
      b.onclick = function () { S.tab = b.getAttribute('data-ldtab'); paint(); };
    });

    var cl = host.querySelector('#ld-close');
    if (cl) cl.onclick = function () { S.openId = null; S.thread = null; S.detail = null; paint(); };
  }

  /* ---- mount -------------------------------------------------------------
     The brand comes from portal.html, which owns the switcher. Changing brand
     is a different dataset, not a filter over the same one, so everything is
     dropped and refetched rather than re-filtered. */

  function mount(el, opts) {
    if (!el) return;
    host = el;
    var o = opts || {};
    var changed = o.companyId !== S.companyId;
    S.companyId = o.companyId || null;
    S.brandName = o.brandName || '';

    if (changed) {
      S.leads = []; S.stages = []; S.locations = [];
      S.openId = null; S.detail = null; S.thread = null;
      S.stage = null; S.q = ''; S.total = 0;
      S.error = null; S.loadedFor = null;
    }

    if (S.loadedFor && S.loadedFor === S.companyId) { paint(); return; }
    loadAll();
  }

  /* portal-realtime.js calls this when lead, ghl_message, ghl_opportunity or
     appointment changes. */
  function invalidate() {
    S.loadedFor = null;
    if (host && host.isConnected) loadAll();
  }

  return { mount: mount, invalidate: invalidate, state: S };
})();
