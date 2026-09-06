/* Financials — cash and debt, read-only.

   Replaces the baked KPI block V.financials() has been rendering (Cash $770,785
   across "5 accounts", an income figure and a transactions table, none of which
   came from the database). Everything here reads /api/financials.

   ---------------------------------------------------------------------------
   FIVE THINGS THE DATA IS, WHICH THE SCREEN HAS TO SAY OUT LOUD

   1. The grain is QUARTERLY. There are two balance dates in the whole dataset,
      2026-03-31 and 2026-06-30. There is no "current cash" and nothing here is
      ever labelled Today or Current Balance — the quarter selector is the
      primary control and every figure on the page inherits it.

   2. Every balance is a DRAFT. All 441 rows are is_verified = false, from a
      source marked DRAFT REQUIRES MITCH HAGEN VERIFICATION. Nothing on screen
      says so any more — no Verified column, no Verified filter, no banner. On
      a dataset where the value is false everywhere, all three were repeating
      one fact that never varied.

      is_verified and the DRAFT line DO still ride on every export, and that is
      deliberate rather than an oversight: on screen the reader has the context
      that these are quarterly draft snapshots, and in a spreadsheet mailed to
      someone else they have nothing. That is where the caveat earns its place.

   3. There are TWO debt numbers and they do not agree. v_debt_by_account_quarter
      reports ~$225.4M across 55 accounts; v_debt_by_quarter reports ~$15.2M
      across 3 loans. Both are right about what they measure — loan_balance is
      sparse and its dates are ragged, so quarter-filtering it drops almost
      everything. They live in separate tabs, each says what it measures, and
      nothing on this page adds them together.

   4. Loan coverage is PARTIAL: 54 of 75 loans have any balance row. The Loans
      tab prints that beside its total, because a bare total implies the other
      21 are paid off. They are not; they are unpopulated.

   5. Transaction-level data DOES NOT EXIST yet — transaction and
      transaction_category are both empty pending the Buildium/AppFolio sync.
      So there is no income statement, no expense breakdown, no category chart
      and no NOI trend here. property_financials has 28 rows, which is not a
      portfolio.

   Cash and debt are NEVER summed. There is no code path in this file that
   could produce a combined figure, and there should not be one: they are
   different account kinds and the total is meaningless.
   --------------------------------------------------------------------------- */

window.PortalFinancials = (function () {
  'use strict';

  var API = '/api/financials';
  var LS_KEY = 'lwFinFiltersV1';

  var TABS = [
    /* Debt is the default tab, per the brief. It is also the view that answers
       the question the account-level data can actually answer. */
    { id: 'debt', label: 'Debt' },
    { id: 'cash', label: 'Cash' },
    { id: 'loans', label: 'Loans' },
    { id: 'accounts', label: 'Accounts' }
  ];

  /* Which filters each tab's relation can actually apply. Offering a control
     that the server will ignore is worse than not offering it: the chip says
     the view is filtered and the rows say otherwise. */
  var TAB_FILTERS = {
    cash:     ['deal', 'entity', 'institution', 'purpose', 'type', 'cash_source', 'range'],
    debt:     ['deal', 'entity', 'institution', 'range'],
    loans:    ['deal', 'entity', 'institution', 'range'],
    accounts: ['deal', 'entity', 'institution', 'purpose', 'type', 'kind', 'cash_source']
  };

  /* No Brand filter. Deal and Entity already scope to one brand, and the
     option lists show each one's brand beside its name — which is what
     actually disambiguates two similarly named entities. A third control
     selecting the same rows a second way is a way to contradict yourself. */
  var FILTER_DEFS = [
    { key: 'deal',        label: 'Deal',         opts: 'deals',        idField: 'id',    nameField: 'name' },
    { key: 'entity',      label: 'Entity',       opts: 'entities',     idField: 'id',    nameField: 'name' },
    { key: 'institution', label: 'Institution',  opts: 'institutions', idField: 'value', nameField: 'value', count: 'accounts' },
    { key: 'purpose',     label: 'Purpose',      opts: 'purposes',     idField: 'value', nameField: 'value', count: 'accounts' },
    { key: 'type',        label: 'Type',         opts: 'types',        idField: 'value', nameField: 'value', count: 'accounts' },
    { key: 'kind',        label: 'Kind',         opts: 'kinds',        idField: 'value', nameField: 'value', count: 'accounts' },
    { key: 'cash_source', label: 'Cash source',  opts: 'cash_sources', idField: 'value', nameField: 'value', count: 'accounts' }
  ];

  var S = {
    tab: 'debt',
    dateFrom: null, dateTo: null,   /* inclusive range; either may be null */
    sel: {},              /* key -> array of selected values */
    min: '', max: '',
    sort: null, dir: null,
    page: 1, perPage: 50,
    options: null, summary: null, coverage: null,
    rows: [], columns: [], total: 0,
    loading: false, error: null, problems: [],
    optionsErr: null,
    openPanel: null,
    search: {}            /* key -> type-ahead text */
  };

  FILTER_DEFS.forEach(function (d) { S.sel[d.key] = []; });

  /* ---- helpers ---------------------------------------------------------- */

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  /* A missing value renders as an em dash in the muted ink, never as an empty
     cell and never as 0 — "not reported" and "zero" are different claims. */
  function nil() { return '<span class="fin-nil">&mdash;</span>'; }

  function money(v) {
    if (v === null || v === undefined || v === '') return nil();
    var n = Number(v);
    if (!isFinite(n)) return nil();
    return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function moneyShort(v) {
    var n = Number(v);
    if (!isFinite(n)) return '—';
    var a = Math.abs(n);
    if (a >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (a >= 1e6) return '$' + (n / 1e6).toFixed(2) + 'M';
    if (a >= 1e3) return '$' + Math.round(n / 1e3) + 'K';
    return '$' + n.toFixed(0);
  }

  function dateOnly(v) { return v ? String(v).slice(0, 10) : null; }

  function fmtCell(key, row) {
    var v = row[key];
    if (v === null || v === undefined || v === '') return nil();
    if (key === 'balance' || key === 'prior_balance' || key === 'principal_paid') return money(v);
    if (key === 'as_of_date' || key === 'maturity_date') return esc(dateOnly(v));
    if (key === 'dscr') { var n = Number(v); return isFinite(n) ? n.toFixed(2) : esc(v); }
    return esc(v);
  }

  function isNumericCol(k) {
    return k === 'balance' || k === 'prior_balance' || k === 'principal_paid' || k === 'dscr';
  }

  /* ---- URL + localStorage state ------------------------------------------

     The page URL carries the compact comma form the brief specifies, so a
     filtered view can be pasted into a message. Each element is split on comma
     BEFORE being decoded, so a value containing a literal comma survives as
     %2C rather than being torn into two filters. Institution names contain
     commas, so this is not hypothetical.

     The API takes the same values as repeated params, which has no such
     problem — see qs() below. */

  function readUrl() {
    var h = location.hash || '';
    var i = h.indexOf('?');
    if (i < 0) return;
    var raw = h.slice(i + 1);
    raw.split('&').forEach(function (pair) {
      var eq = pair.indexOf('=');
      if (eq < 0) return;
      var k = decodeURIComponent(pair.slice(0, eq));
      var vRaw = pair.slice(eq + 1);
      if (k === 'fintab' && TAB_FILTERS[vRaw]) S.tab = vRaw;
      else if (k === 'from') S.dateFrom = decodeURIComponent(vRaw);
      else if (k === 'to') S.dateTo = decodeURIComponent(vRaw);
      else if (k === 'q') { S.dateFrom = S.dateTo = decodeURIComponent(vRaw); }
      else if (k === 'min') S.min = decodeURIComponent(vRaw);
      else if (k === 'max') S.max = decodeURIComponent(vRaw);
      else if (S.sel[k]) {
        S.sel[k] = vRaw.split(',').map(function (x) {
          try { return decodeURIComponent(x); } catch (e) { return x; }
        }).filter(Boolean);
      }
    });
  }

  function urlBits() {
    var out = [];
    if (S.tab) out.push('fintab=' + S.tab);
    if (S.dateFrom && S.dateFrom === S.dateTo) out.push('q=' + encodeURIComponent(S.dateFrom));
    else {
      if (S.dateFrom) out.push('from=' + encodeURIComponent(S.dateFrom));
      if (S.dateTo) out.push('to=' + encodeURIComponent(S.dateTo));
    }
    FILTER_DEFS.forEach(function (d) {
      var v = S.sel[d.key];
      if (v && v.length) out.push(d.key + '=' + v.map(encodeURIComponent).join(','));
    });
    if (S.min !== '') out.push('min=' + encodeURIComponent(S.min));
    if (S.max !== '') out.push('max=' + encodeURIComponent(S.max));
    return out;
  }

  /* replaceState, not push: navigating filters is not browser history, and
     pushState would make Back walk through every checkbox the reader touched. */
  function writeUrl() {
    var h = location.hash || '';
    var base = h.indexOf('?') >= 0 ? h.slice(0, h.indexOf('?')) : h;
    var bits = urlBits();
    var next = base + (bits.length ? '?' + bits.join('&') : '');
    if (next !== h) history.replaceState(null, '', location.pathname + location.search + next);
  }

  /* Per-user, in the browser only. The brief is explicit that this is not
     persisted server-side. */
  function saveLocal() {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify({
        tab: S.tab, dateFrom: S.dateFrom, dateTo: S.dateTo, sel: S.sel, min: S.min, max: S.max
      }));
    } catch (e) { /* private window, or storage blocked — not worth reporting */ }
  }

  function loadLocal() {
    try {
      var raw = localStorage.getItem(LS_KEY);
      if (!raw) return;
      var v = JSON.parse(raw);
      if (v.tab && TAB_FILTERS[v.tab]) S.tab = v.tab;
      if (v.dateFrom) S.dateFrom = v.dateFrom;
      if (v.dateTo) S.dateTo = v.dateTo;
      if (v.min !== undefined) S.min = v.min;
      if (v.max !== undefined) S.max = v.max;
      if (v.sel) FILTER_DEFS.forEach(function (d) {
        if (Array.isArray(v.sel[d.key])) S.sel[d.key] = v.sel[d.key].slice();
      });
    } catch (e) { /* a corrupt entry must not stop the screen loading */ }
  }

  /* ---- request building --------------------------------------------------
     Repeated params, per the API contract, so a value containing a comma
     survives the wire without any splitting convention at all. */
  function qs(extra) {
    var p = [];
    /* Sent as a range. When both bounds are the same day this is exactly the
       old single-date request, so nothing downstream needs a special case. */
    if (S.dateFrom) p.push('from=' + encodeURIComponent(S.dateFrom));
    if (S.dateTo) p.push('to=' + encodeURIComponent(S.dateTo));
    var allowed = TAB_FILTERS[S.tab] || [];
    FILTER_DEFS.forEach(function (d) {
      if (allowed.indexOf(d.key) < 0) return;
      (S.sel[d.key] || []).forEach(function (v) {
        p.push(d.key + '[]=' + encodeURIComponent(v));
      });
    });
    if (allowed.indexOf('range') >= 0) {
      if (S.min !== '') p.push('min=' + encodeURIComponent(S.min));
      if (S.max !== '') p.push('max=' + encodeURIComponent(S.max));
    }
    if (extra) Object.keys(extra).forEach(function (k) {
      if (extra[k] !== null && extra[k] !== undefined && extra[k] !== '') {
        p.push(k + '=' + encodeURIComponent(extra[k]));
      }
    });
    return p.join('&');
  }

  function getJson(url) {
    return fetch(url, { headers: { Accept: 'application/json' } }).then(function (r) {
      return r.json().then(function (j) {
        if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
        return j;
      });
    });
  }

  /* ---- loading ----------------------------------------------------------- */

  function loadOptions() {
    if (S.options) return Promise.resolve(S.options);
    return getJson(API + '/filters').then(function (j) {
      S.options = j;
      S.problems = j.problems || [];
      /* Default to the newest snapshot alone rather than to every date: one
         snapshot is the reading somebody wants on arrival, and a table that
         opens showing two quarters interleaved is confusing before it is
         useful. Explicit is fine, so both bounds are set. */
      if (!S.dateFrom && !S.dateTo && j.quarters && j.quarters.length) {
        S.dateFrom = S.dateTo = j.quarters[0].as_of;
      }
      return j;
    }).catch(function (e) { S.optionsErr = e.message; return null; });
  }

  function loadSummary() {
    var p2 = [];
    if (S.dateFrom) p2.push('from=' + encodeURIComponent(S.dateFrom));
    if (S.dateTo) p2.push('to=' + encodeURIComponent(S.dateTo));
    return getJson(API + '/summary' + (p2.length ? '?' + p2.join('&') : ''))
      .then(function (j) { S.summary = j; })
      .catch(function () { S.summary = null; });
  }

  function loadCoverage() {
    if (S.coverage) return Promise.resolve();
    return getJson(API + '/loan-coverage')
      .then(function (j) { S.coverage = j; })
      .catch(function () { S.coverage = null; });
  }

  function loadRows() {
    /* No guard against an unbounded range any more, and none is needed. The
       old single-date control could resolve to nothing and then omit as_of,
       which made the server answer with EVERY quarter at once and
       double-count every account. A range always sends the bounds it has, and
       "all dates" is now a thing the reader can deliberately ask for — every
       row carries its own As Of Date, so a multi-snapshot table reads
       correctly. Only the tiles have to pin to one date, and the server does
       that. */
    S.loading = true; S.error = null;
    paint();
    var extra = { page: S.page, per_page: S.perPage };
    if (S.sort) { extra.sort = S.sort; extra.dir = S.dir; }
    return getJson(API + '/' + S.tab + '?' + qs(extra)).then(function (j) {
      S.rows = j.rows || [];
      S.columns = j.columns || [];
      S.total = j.total_count || 0;
      if (j.problems && j.problems.length) S.problems = j.problems;
    }).catch(function (e) {
      S.error = e.message; S.rows = []; S.total = 0;
    }).then(function () {
      S.loading = false;
      writeUrl(); saveLocal(); paint();
    });
  }

  function reload() {
    S.page = 1;
    Promise.all([loadSummary(), S.tab === 'loans' ? loadCoverage() : null]).then(loadRows);
  }

  /* ---- rendering --------------------------------------------------------- */

  var host = null;

  function paint() {
    if (!host) return;
    host.innerHTML = view();
    wire();
  }

  function view() {
    if (S.optionsErr) {
      return '<div class="fin-problem"><div><b>Financials could not load.</b><div>' +
        esc(S.optionsErr) + '</div></div></div>';
    }
    if (!S.options) return '<div class="fin-loading">Reading accounts&hellip;</div>';
    return header() + problems() + tiles() + filterBar() + chips() + tabs() + tabNote() + table();
  }

  /* ---- the date range ----------------------------------------------------

     From and To, both free-form and both optional. Empty means "no bound that
     side", so clearing both shows every snapshot.

     The TABLE may legitimately span more than one snapshot — every row carries
     its own As Of Date, so reading Q1 beside Q2 is a real thing to want.

     The TILES may not. Summing a range covering both snapshots counts every
     account twice and yields roughly double the truth while looking entirely
     plausible. The server pins them to the LATEST snapshot inside the range,
     and the header says which one whenever the range holds more than one. */

  function snapshots() {
    return ((S.options && S.options.quarters) || []).map(function (x) { return x.as_of; });
  }

  function snapshotsInRange() {
    return snapshots().filter(function (d) {
      return (!S.dateFrom || d >= S.dateFrom) && (!S.dateTo || d <= S.dateTo);
    });
  }

  function header() {
    var all = snapshots();
    var range = (S.options && S.options.date_range) || null;
    var bounds = range ? ' min="' + esc(range.min) + '" max="' + esc(range.max) + '"' : '';

    var datalist = all.length
      ? '<datalist id="fin-snapshots">' + all.map(function (d) {
          return '<option value="' + esc(d) + '"></option>';
        }).join('') + '</datalist>'
      : '';

    var inputs =
      '<span class="fin-daterange">' +
        '<input class="fin-qsel" type="date" id="fin-from" list="fin-snapshots" aria-label="From date"' +
          ' value="' + esc(S.dateFrom || '') + '"' + bounds + '>' +
        '<span class="sep">to</span>' +
        '<input class="fin-qsel" type="date" id="fin-to" list="fin-snapshots" aria-label="To date"' +
          ' value="' + esc(S.dateTo || '') + '"' + bounds + '>' +
      '</span>';

    /* Only when it is not obvious. Announcing the pinned date on a range that
       contains exactly one snapshot is noise. */
    var inR = snapshotsInRange();
    var note = '';
    if (!inR.length && (S.dateFrom || S.dateTo)) {
      note = '<span class="fin-resolved warn">no snapshot in this range</span>';
    } else if (inR.length > 1) {
      note = '<span class="fin-resolved">' + inR.length + ' snapshots &middot; totals as at ' +
             esc(inR[0]) + '</span>';
    }

    return '' +
      '<div class="fin-head">' +
        '<div>' +
          '<h1 class="fin-title">Financials</h1>' +
          '<p class="fin-sub">Cash &amp; debt &middot; LeavenWealth</p>' +
        '</div>' +
        '<div class="fin-headtools">' +
          note + inputs + datalist +
          (all.length ? '<button class="fin-btn" id="fin-latest">Latest</button>' : '') +
          (all.length ? '<button class="fin-btn" id="fin-alldates">All dates</button>' : '') +
          '<button class="fin-btn" id="fin-export-csv">Export CSV</button>' +
          '<button class="fin-btn" id="fin-export-xlsx">Export XLSX</button>' +
        '</div>' +
      '</div>';
  }

  function problems() {
    if (!S.problems || !S.problems.length) return '';
    var real = S.problems.filter(function (p) { return p.kind === 'missing'; });
    if (!real.length) return '';
    return '<div class="fin-problem"><div><b>Some data could not be read.</b>' +
      '<ul>' + real.map(function (p) { return '<li>' + esc(p.detail) + '</li>'; }).join('') + '</ul>' +
      '</div></div>';
  }

  function tiles() {
    var c = S.summary && S.summary.current;
    if (!c) {
      return '<div class="fin-tiles">' +
        tile('', 'Total Cash', null, 'no summary for this quarter') +
        tile('', 'Total Debt', null, 'no summary for this quarter') +
        tile('', 'Accounts', null, '') +
        tile('', 'As Of', null, '') +
        '</div>';
    }
    var cashN = c.cash_accounts, loanN = c.loan_accounts;
    return '<div class="fin-tiles">' +
      tile('cash', 'Total Cash', c.total_cash, cashN != null ? cashN + ' cash accounts' : '') +
      tile('debt', 'Total Debt', c.total_debt, loanN != null ? loanN + ' loan accounts' : '') +
      tile('', 'Accounts', null,
           (cashN != null && loanN != null) ? (cashN + loanN) + ' with a balance this quarter' : '',
           (cashN != null && loanN != null) ? String(cashN + loanN) : null) +
      tile('', 'As Of', null,
           (c.snapshots_in_range > 1 ? 'latest of ' + c.snapshots_in_range + ' in range' : 'snapshot'),
           dateOnly(c.as_of_date) || '—') +
      '</div>';
    /* Accounts adds a COUNT of accounts, which is a real quantity. Cash and
       debt are never added; there is no tile for that and no helper for it. */
  }

  function tile(cls, label, moneyVal, sub, plainVal) {
    var v = plainVal != null ? esc(plainVal)
          : (moneyVal === null || moneyVal === undefined ? '<span class="fin-nil">no data</span>' : moneyShort(moneyVal));
    var title = (moneyVal !== null && moneyVal !== undefined) ? ' title="' + esc(money(moneyVal).replace(/<[^>]*>/g, '')) + '"' : '';
    return '<div class="fin-tile ' + cls + '"' + title + '>' +
      '<div class="k">' + esc(label) + '</div>' +
      '<div class="v">' + v + '</div>' +
      (sub ? '<div class="d">' + esc(sub) + '</div>' : '') +
      '</div>';
  }

  function filterBar() {
    var allowed = TAB_FILTERS[S.tab] || [];
    var html = FILTER_DEFS.filter(function (d) { return allowed.indexOf(d.key) >= 0; })
      .map(msControl).join('');
    if (allowed.indexOf('range') >= 0) {
      html += '<span class="fin-range">' +
        '<input id="fin-min" type="number" step="0.01" placeholder="Min $" value="' + esc(S.min) + '">' +
        '<span class="sep">to</span>' +
        '<input id="fin-max" type="number" step="0.01" placeholder="Max $" value="' + esc(S.max) + '">' +
        '</span>';
    }
    return '<div class="fin-filters">' + html + '</div>';
  }

  function optionsFor(def) {
    var raw = (S.options && S.options[def.opts]) || [];
    return raw.map(function (o) {
      return {
        id: String(o[def.idField]),
        name: String(o[def.nameField] != null ? o[def.nameField] : o[def.idField]),
        count: def.count ? o[def.count] : null,
        company: o.company || null
      };
    });
  }

  function msControl(def) {
    var sel = S.sel[def.key] || [];
    var open = S.openPanel === def.key;
    var search = (S.search[def.key] || '').toLowerCase();
    var opts = optionsFor(def);
    var shown = search ? opts.filter(function (o) { return o.name.toLowerCase().indexOf(search) >= 0; }) : opts;

    var list = shown.length
      ? shown.map(function (o) {
          var on = sel.indexOf(o.id) >= 0;
          return '<label class="fin-ms-opt">' +
            '<input type="checkbox" data-msk="' + esc(def.key) + '" value="' + esc(o.id) + '"' + (on ? ' checked' : '') + '>' +
            '<span class="n">' + esc(o.name) + (o.company ? ' <span class="c">' + esc(o.company) + '</span>' : '') + '</span>' +
            (o.count != null ? '<span class="c">' + o.count + '</span>' : '') +
            '</label>';
        }).join('')
      : '<div class="fin-ms-none">Nothing matches &ldquo;' + esc(S.search[def.key] || '') + '&rdquo;</div>';

    /* The count in the label is what makes a collapsed control honest —
       "Institution (2)" rather than a control that looks untouched. */
    return '<span class="fin-ms">' +
      '<button class="fin-ms-btn' + (sel.length ? ' on' : '') + '" data-msbtn="' + esc(def.key) + '">' +
        esc(def.label) + (sel.length ? ' (' + sel.length + ')' : '') + '<span class="caret">&#9660;</span>' +
      '</button>' +
      '<div class="fin-ms-panel' + (open ? ' open' : '') + '" data-mspanel="' + esc(def.key) + '">' +
        (opts.length > 8 ? '<input class="fin-ms-search" data-mssearch="' + esc(def.key) + '" placeholder="Search&hellip;" value="' + esc(S.search[def.key] || '') + '">' : '') +
        '<div class="fin-ms-list">' + list + '</div>' +
        '<div class="fin-ms-foot">' +
          '<button data-msall="' + esc(def.key) + '">Select all shown</button>' +
          '<button data-msnone="' + esc(def.key) + '">Clear</button>' +
        '</div>' +
      '</div>' +
    '</span>';
  }

  function labelFor(key, id) {
    var def = FILTER_DEFS.filter(function (d) { return d.key === key; })[0];
    if (!def) return id;
    var hit = optionsFor(def).filter(function (o) { return o.id === String(id); })[0];
    return hit ? hit.name : id;
  }

  function chips() {
    var allowed = TAB_FILTERS[S.tab] || [];
    var out = [];
    FILTER_DEFS.forEach(function (d) {
      if (allowed.indexOf(d.key) < 0) return;
      (S.sel[d.key] || []).forEach(function (v) {
        out.push('<span class="fin-chip">' + esc(d.label) + ': ' + esc(labelFor(d.key, v)) +
          '<span class="x" data-unchip="' + esc(d.key) + '" data-val="' + esc(v) + '">&times;</span></span>');
      });
    });
    if (allowed.indexOf('range') >= 0) {
      if (S.min !== '') out.push('<span class="fin-chip">Min: ' + esc(S.min) + '<span class="x" data-unrange="min">&times;</span></span>');
      if (S.max !== '') out.push('<span class="fin-chip">Max: ' + esc(S.max) + '<span class="x" data-unrange="max">&times;</span></span>');
    }

    var noun = S.tab === 'loans' ? 'loans' : S.tab === 'accounts' ? 'accounts' : 'rows';
    var shownN = Math.min(S.rows.length, S.total);
    var count = S.loading ? 'Loading&hellip;'
      : 'Showing ' + shownN.toLocaleString() + ' of ' + S.total.toLocaleString() + ' ' + noun;

    if (!out.length) return '<div class="fin-chips"><span class="fin-count">' + count + '</span></div>';
    return '<div class="fin-chips">' + out.join('') +
      '<button class="fin-chip-clear" id="fin-clearall">Clear all</button>' +
      '<span class="fin-count">' + count + '</span></div>';
  }

  function tabs() {
    return '<div class="fin-tabs">' + TABS.map(function (t) {
      return '<button class="fin-tab' + (t.id === S.tab ? ' active' : '') + '" data-fintab="' + t.id + '">' +
        esc(t.label) + '</button>';
    }).join('') + '</div>';
  }

  /* The one place the two debt figures are explained. It sits above the table
     rather than in a footnote, because the number is right there. */
  function tabNote() {
    if (S.tab === 'loans') {
      var cov = S.coverage
        ? '<b>' + S.coverage.with_balance + ' of ' + S.coverage.loans + ' loans</b> have any balance row at all. ' +
          'The rest are unpopulated, not paid off.'
        : '';
      return '<div class="fin-note">Per-loan snapshots from <b>loan_balance</b>, whose dates are ragged &mdash; ' +
        'each row shows its own as-of date rather than the selected quarter. ' +
        'This total is <b>not comparable</b> with the Debt tab and the two are never added. ' + cov + '</div>';
    }
    if (S.tab === 'debt') {
      return '<div class="fin-note">Loan-kind accounts from <b>account_balance</b>, at the selected quarter. ' +
        'The Loans tab measures something different (per-loan snapshots, ragged dates) and reports a much smaller ' +
        'total; both are correct for what they measure.</div>';
    }
    if (S.tab === 'accounts') {
      return '<div class="fin-note">Reference list &mdash; account setup, not balances. ' +
        'The quarter selector does not apply here.</div>';
    }
    return '';
  }

  function table() {
    if (S.error) {
      return '<div class="fin-tablewrap"><div class="fin-empty"><b>That query failed.</b>' +
        esc(S.error) + '</div></div>';
    }
    if (S.loading && !S.rows.length) {
      return '<div class="fin-tablewrap"><div class="fin-loading">Reading&hellip;</div></div>';
    }
    if (!S.rows.length) {
      /* An empty result is stated as an empty result. It is never rendered as
         a zero, because zero is a figure and this is the absence of one. */
      var why = anyFilter()
        ? 'No rows match these filters. Clear one and try again.'
        : (S.tab === 'accounts'
            ? 'No accounts are recorded yet.'
            : (snapshotsInRange().length
                ? 'No balances were recorded in this date range.'
                : 'No snapshot falls in this date range. Balances exist on '
                  + esc(snapshots().join(' and ')) + '.'));
      return '<div class="fin-tablewrap"><div class="fin-empty"><b>Nothing to show</b>' + why + '</div></div>';
    }

    var cols = S.columns.length ? S.columns : Object.keys(S.rows[0]).map(function (k) { return [k, k]; });
    var head = cols.map(function (c) {
      var key = c[0], label = c[1];
      var isSort = S.sort === key;
      var arrow = isSort ? '<span class="dir">' + (S.dir === 'asc' ? '&#9650;' : '&#9660;') + '</span>' : '';
      return '<th data-sort="' + esc(key) + '">' + esc(label) + arrow + '</th>';
    }).join('');

    var body = S.rows.map(function (row) {
      return '<tr>' + cols.map(function (c) {
        var key = c[0];
        var cls = isNumericCol(key) ? ' class="r"' : (key === 'account_number_last4' ? ' class="mono"' : '');
        return '<td' + cls + '>' + fmtCell(key, row) + '</td>';
      }).join('') + '</tr>';
    }).join('');

    var pages = Math.max(1, Math.ceil(S.total / S.perPage));
    return '<div class="fin-tablewrap">' +
      '<div class="fin-scroll"><table class="fin-table"><thead><tr>' + head + '</tr></thead>' +
      '<tbody>' + body + '</tbody></table></div>' +
      '<div class="fin-foot">' +
        '<span class="pginfo">Page ' + S.page + ' of ' + pages + '</span>' +
        '<span class="sp"></span>' +
        '<button class="fin-btn" id="fin-prev"' + (S.page <= 1 ? ' disabled' : '') + '>Prev</button>' +
        '<button class="fin-btn" id="fin-next"' + (S.page >= pages ? ' disabled' : '') + '>Next</button>' +
      '</div>' +
    '</div>';
  }

  function anyFilter() {
    var allowed = TAB_FILTERS[S.tab] || [];
    var any = FILTER_DEFS.some(function (d) {
      return allowed.indexOf(d.key) >= 0 && (S.sel[d.key] || []).length;
    });
    return any || (allowed.indexOf('range') >= 0 && (S.min !== '' || S.max !== ''));
  }

  /* ---- wiring ------------------------------------------------------------

     Every handler is `.onclick =`, never addEventListener. paint() re-renders
     the whole subtree on each change, and mount() runs again on every
     navigation back to this screen; addEventListener would stack a fresh copy
     per paint and fire N requests per click. That is the bug the users screen
     hit with its focus listener and the one the Properties port was careful to
     avoid. */

  function wire() {
    var $ = function (id) { return host.querySelector('#' + id); };

    var fromEl = $('fin-from'), toEl = $('fin-to');
    if (fromEl) fromEl.onchange = function () { S.dateFrom = this.value || null; reload(); };
    if (toEl)   toEl.onchange   = function () { S.dateTo   = this.value || null; reload(); };
    var latest = $('fin-latest');
    if (latest) latest.onclick = function () {
      var all = snapshots();
      S.dateFrom = S.dateTo = all[0] || null;
      reload();
    };
    var allDates = $('fin-alldates');
    if (allDates) allDates.onclick = function () { S.dateFrom = S.dateTo = null; reload(); };

    var csv = $('fin-export-csv');
    if (csv) csv.onclick = function () { doExport('csv'); };
    var xlsx = $('fin-export-xlsx');
    if (xlsx) xlsx.onclick = function () { doExport('xlsx'); };

    host.querySelectorAll('[data-fintab]').forEach(function (b) {
      b.onclick = function () {
        S.tab = b.getAttribute('data-fintab');
        S.sort = null; S.dir = null; S.page = 1;
        if (S.tab === 'loans') loadCoverage().then(loadRows); else loadRows();
      };
    });

    host.querySelectorAll('[data-msbtn]').forEach(function (b) {
      b.onclick = function (e) {
        e.stopPropagation();
        var k = b.getAttribute('data-msbtn');
        S.openPanel = S.openPanel === k ? null : k;
        paint();
        var s = host.querySelector('[data-mssearch="' + k + '"]');
        if (s) s.focus();
      };
    });

    host.querySelectorAll('.fin-ms-panel').forEach(function (p) {
      p.onclick = function (e) { e.stopPropagation(); };
    });

    host.querySelectorAll('[data-mssearch]').forEach(function (i) {
      i.oninput = function () {
        S.search[i.getAttribute('data-mssearch')] = i.value;
        paint();
        var again = host.querySelector('[data-mssearch="' + i.getAttribute('data-mssearch') + '"]');
        if (again) { again.focus(); again.setSelectionRange(again.value.length, again.value.length); }
      };
    });

    host.querySelectorAll('[data-msk]').forEach(function (cb) {
      cb.onchange = function () {
        var k = cb.getAttribute('data-msk'), v = cb.value;
        var arr = S.sel[k] || (S.sel[k] = []);
        var i = arr.indexOf(v);
        if (cb.checked && i < 0) arr.push(v);
        if (!cb.checked && i >= 0) arr.splice(i, 1);
        reload();
      };
    });

    host.querySelectorAll('[data-msall]').forEach(function (b) {
      b.onclick = function () {
        var k = b.getAttribute('data-msall');
        var def = FILTER_DEFS.filter(function (d) { return d.key === k; })[0];
        var search = (S.search[k] || '').toLowerCase();
        var opts = optionsFor(def).filter(function (o) { return !search || o.name.toLowerCase().indexOf(search) >= 0; });
        S.sel[k] = opts.map(function (o) { return o.id; });
        reload();
      };
    });

    host.querySelectorAll('[data-msnone]').forEach(function (b) {
      b.onclick = function () { S.sel[b.getAttribute('data-msnone')] = []; reload(); };
    });

    host.querySelectorAll('[data-unchip]').forEach(function (x) {
      x.onclick = function () {
        var k = x.getAttribute('data-unchip'), v = x.getAttribute('data-val');
        S.sel[k] = (S.sel[k] || []).filter(function (a) { return a !== v; });
        reload();
      };
    });

    host.querySelectorAll('[data-unrange]').forEach(function (x) {
      x.onclick = function () { S[x.getAttribute('data-unrange')] = ''; reload(); };
    });

    var clear = $('fin-clearall');
    if (clear) clear.onclick = function () {
      FILTER_DEFS.forEach(function (d) { S.sel[d.key] = []; });
      S.min = ''; S.max = '';
      reload();
    };

    var min = $('fin-min'), max = $('fin-max');
    if (min) min.onchange = function () { S.min = this.value; reload(); };
    if (max) max.onchange = function () { S.max = this.value; reload(); };

    host.querySelectorAll('[data-sort]').forEach(function (th) {
      th.onclick = function () {
        var k = th.getAttribute('data-sort');
        if (S.sort === k) S.dir = S.dir === 'asc' ? 'desc' : 'asc';
        else { S.sort = k; S.dir = isNumericCol(k) ? 'desc' : 'asc'; }
        S.page = 1; loadRows();
      };
    });

    var prev = $('fin-prev'), next = $('fin-next');
    if (prev) prev.onclick = function () { if (S.page > 1) { S.page--; loadRows(); } };
    if (next) next.onclick = function () {
      if (S.page < Math.ceil(S.total / S.perPage)) { S.page++; loadRows(); }
    };
  }

  /* Bound once at module scope, not per paint, for the same reason as above. */
  var docBound = false;
  function bindDoc() {
    if (docBound) return;
    docBound = true;
    document.addEventListener('click', function () {
      if (S.openPanel) { S.openPanel = null; paint(); }
    });
  }

  /* ---- export ------------------------------------------------------------
     The link carries the same filter parameters the table was built from, so
     the file is exactly what is on screen — the FULL result set, not the
     current page, because the server ignores page/per_page on this route. */
  function doExport(format) {
    var url = API + '/export?tab=' + encodeURIComponent(S.tab) +
      '&format=' + encodeURIComponent(format) +
      (S.sort ? '&sort=' + encodeURIComponent(S.sort) + '&dir=' + encodeURIComponent(S.dir || '') : '') +
      '&' + qs();
    var a = document.createElement('a');
    a.href = url;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  /* ---- mount -------------------------------------------------------------- */

  function mount(el) {
    if (!el) return;
    host = el;
    bindDoc();
    if (!S.options) {
      loadLocal();
      readUrl();          /* a shared link wins over the reader's own last set */
      paint();
      loadOptions().then(function (o) {
        if (!o) { paint(); return; }
        Promise.all([loadSummary(), S.tab === 'loans' ? loadCoverage() : null]).then(loadRows);
      });
    } else {
      paint();
      loadRows();
    }
  }

  /* portal-realtime.js calls this when a bound table changes. financial_account
     and account_balance both feed every figure on the screen. */
  function invalidate() {
    S.options = null;
    S.summary = null;
    S.coverage = null;
    if (host && host.isConnected) {
      loadOptions().then(function () {
        Promise.all([loadSummary(), S.tab === 'loans' ? loadCoverage() : null]).then(loadRows);
      });
    }
  }

  return { mount: mount, invalidate: invalidate, state: S };
})();
