/* ===========================================================================
   portal-reporting.js. the Properties section (Phase 2), READ-ONLY.

   Replaces the portal-properties.js UI. Everything on screen comes from the
   `reporting` views through /api/portfolio/* and /api/am-fees; no screen here
   reads t12_monthly or loan directly, and none of them calls a write
   endpoint.

   Conventions this file follows because the rest of the portal does:

     * `.onclick =`, never addEventListener. mount() runs on EVERY navigation
       back to the section, and paint() re-renders the subtree on every tab
       change. addEventListener there stacks a copy per visit and fires N
       requests per click - the bug the Users screen hit with its focus
       listener and the Properties port hit again.

     * Class names are prefixed `rp-`. portal.html owns generic names like
       .col, .card and .view at the top level; portal-properties.css was
       shimmed for colours but never scoped for names, and a bar called .col
       silently inherited 10px of padding and a border, which is what drew
       a solid band across the maturity wall.

     * "–" means NOT AVAILABLE and is never 0. A month before a property was
       owned, a DSCR with no debt service, and a cap rate of zero are all
       absent, not zero, and rendering them as 0 states something nobody
       said.

   Exposes window.PortalReporting.
   =========================================================================== */
(function () {
  'use strict';

  /* ---- helpers, carried locally ------------------------------------------
     The portal is split across files, so this module brings its own rather
     than depending on a load order it cannot see. */
  function escS(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  var DASH = '–';

  function isNum(v) { return v !== null && v !== undefined && v !== '' && isFinite(Number(v)); }

  /* Money with cents. Negatives in parentheses, accounting style, and the
     caller adds the colour class - the string itself never carries markup. */
  function money(v, opts) {
    if (!isNum(v)) return DASH;
    var n = Number(v);
    var abs = Math.abs(n).toLocaleString('en-US', {
      minimumFractionDigits: (opts && opts.whole) ? 0 : 2,
      maximumFractionDigits: (opts && opts.whole) ? 0 : 2,
    });
    return n < 0 ? '(' + abs + ')' : abs;
  }
  function money$(v, opts) { return isNum(v) ? (Number(v) < 0 ? '($' + money(v, opts).slice(1) : '$' + money(v, opts)) : DASH; }
  function moneyK(v) {
    if (!isNum(v)) return DASH;
    var n = Number(v), a = Math.abs(n);
    var s = a >= 1e6 ? '$' + (a / 1e6).toFixed(2) + 'M'
          : a >= 1e3 ? '$' + (a / 1e3).toFixed(0) + 'K' : '$' + a.toFixed(0);
    return n < 0 ? '(' + s + ')' : s;
  }
  function pct(v, dp) {
    if (!isNum(v)) return DASH;
    return (Number(v) * 100).toFixed(dp === undefined ? 1 : dp) + '%';
  }
  function ratio(v) { return isNum(v) ? Number(v).toFixed(2) : DASH; }
  function intf(v) { return isNum(v) ? Number(v).toLocaleString('en-US') : DASH; }

  /* A date is sliced off the ISO string, never formatted through the
     viewer's timezone. paid_at taught this one: toLocaleDateString on a
     timestamptz renders the previous day for any reader east of UTC. */
  function dateOnly(s) {
    if (!s) return DASH;
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s));
    if (!m) return DASH;
    var MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return Number(m[3]) + ' ' + MON[Number(m[2]) - 1] + ' ' + m[1];
  }
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  function neg(v) { return isNum(v) && Number(v) < 0 ? ' rp-neg' : ''; }

  /* Stored values are enums; the screen speaks the business's own words.
     "rent_roll" and "appfolio" leaked through as-is, which reads as a
     database showing through rather than a product. Anything not listed
     falls back to sentence case rather than to the raw token. */
  var LABELS = {
    rent_roll: 'Rent roll', verified: 'Verified count', buildings: 'Building total',
    appfolio: 'AppFolio', buildium: 'Buildium',
    held: 'Held', sold: 'Sold', demolished: 'Demolished', not_owned: 'Not owned',
    on_file: 'On file', income_statement: 'Income statement',
    loan_record: 'Loan record', interest_only_books: 'Interest only, from the books',
    same_month: 'Same month', following_month: 'Following month',
  };
  function label(v) {
    if (v === null || v === undefined || v === '') return DASH;
    var k = String(v);
    if (Object.prototype.hasOwnProperty.call(LABELS, k.toLowerCase())) return LABELS[k.toLowerCase()];
    if (/^[a-z0-9_]+$/.test(k)) { var t = k.replace(/_/g, ' '); return t.charAt(0).toUpperCase() + t.slice(1); }
    return k;
  }

  /* Icons come from the portal's own thin-line set, so every glyph shares one
     stroke weight. Resolved at render time: this file loads before the
     inline script that defines the set. */
  function icon(name) {
    return (window.PortalIcons && window.PortalIcons[name]) || '';
  }

  /* A figure that is an estimate has to SAY SO next to itself. A DSCR built
     from interest with no principal is not a coverage ratio, it is an upper
     bound on one, and a reader who sees 1.64 with nothing beside it has no
     way to know which they are looking at. */
  function tag(label, title, kind) {
    return '<span class="rp-tag' + (kind ? ' rp-tag-' + kind : '') + '"' +
      (title ? ' title="' + escS(title) + '"' : '') + '>' + escS(label) + '</span>';
  }
  var TAG_INTEREST_ONLY = function () {
    return tag('interest only', 'No principal in the books; coverage is likely overstated.', 'warn');
  };
  function monthsSince(iso) {
    var m = /^(\d{4})-(\d{2})/.exec(String(iso || ''));
    if (!m) return null;
    var now = new Date();
    return (now.getFullYear() - Number(m[1])) * 12 + (now.getMonth() + 1 - Number(m[2]));
  }
  /* A value with no date is stale too: "we do not know when this was true" is
     a different claim from "this is current", and only one is safe to divide
     debt by. */
  function valueStale(asOf) { var n = monthsSince(asOf); return n === null || n > 6; }

  /* ---- data --------------------------------------------------------------- */
  function authHeaders() {
    return window.PortalSession.client()
      .then(function (c) { return c.auth.getSession(); })
      .then(function (r) {
        var t = r && r.data && r.data.session && r.data.session.access_token;
        if (!t) throw new Error('Your session has expired. Sign in again.');
        return { Authorization: 'Bearer ' + t, Accept: 'application/json' };
      });
  }
  function api(path) {
    return authHeaders().then(function (h) {
      return fetch(path, { headers: h, cache: 'no-store' }).then(function (r) {
        return r.json().then(function (b) {
          if (!r.ok) throw new Error((b && b.error) || ('HTTP ' + r.status));
          return b;
        }, function () { throw new Error('HTTP ' + r.status); });
      });
    });
  }

  /* ---- state --------------------------------------------------------------

     Three levels, reached by drilling down rather than by a tree in a
     sidebar. The entity tree panel is gone: it listed 106 legal entities as
     navigation, which is a directory, and it took a third of the width from
     the tables that are the actual content.

       portfolio -> entity -> property

     Every part of that - level, entity, property, tab and period - is in the
     URL, so a property tab is a link somebody can send.
  -------------------------------------------------------------------------- */
  var S = {
    host: null,
    tree: null,                /* /api/portfolio, for building-level data only */
    level: 'portfolio',        /* portfolio | entity | property */
    tab: 'entities',           /* portfolio+entity: entities | properties | fees | views */
    ptab: 'overview',          /* property level */
    entityId: null,            /* a MANAGING entity id, or '' for the none-on-file bucket */
    entityName: null,
    propertyId: null,

    /* period (A4). Months are 1-12; the default is the current year, January
       to the latest month that actually has data. */
    year: new Date().getFullYear(),
    fromMonth: 1,
    toMonth: 12,
    rentAsOf: null,
    notice: null,              /* one line after adding a record (H) */
    forceTree: false,          /* bypass /api/portfolio's cache once, after + Building */

    search: '',
    status: 'held',
    withReports: true,
    source: '',
    density: 'comfortable',
    showUnavailable: false,
    showEmpty: false,
    collapsed: {},             /* fee groups */

    cache: {},
    seq: 0,                    /* see load(): the stale-response guard */
    busy: false,
    error: null,

    /* what-if inputs. Never saved, never sent; a reload returns to defaults. */
    whatif: { capRatePct: 7, requiredDscr: 1.25, newRatePct: 6.5, amortYears: 30, loanBalance: null, annualDebtService: null },
    whatifTouched: false,
  };

  function reset() {
    S.whatif = { capRatePct: 7, requiredDscr: 1.25, newRatePct: 6.5, amortYears: 30, loanBalance: null, annualDebtService: null };
    S.whatifTouched = false;
  }

  /* ---- URL ----------------------------------------------------------------
     portal.html owns brand/view/sub and rebuilds the fragment from scratch on
     every render, so these ride along through the urlParams() hook rather
     than being written into the hash directly - written directly they were
     stripped by the next render.

     Navigation inside the section PUSHES, so browser Back steps back through
     the drill-down. portal.html's own writeState replaces rather than pushes,
     so it never competes for history entries.
  -------------------------------------------------------------------------- */
  /* Read the URL ONCE, before anything can overwrite it.

     portal.html's writeState() runs inside render() BEFORE mount(), and it
     rebuilds the fragment from scratch using urlParams(). If urlParams()
     answered from default state, the first render rewrote a bookmarked
     property link to the portfolio landing before this module ever saw it,
     so a shared link opened the wrong page. Clicking through never showed
     this, because a click sets state first; only a cold load did. */
  var urlRead = false;
  function ensureUrlRead() { if (!urlRead) { urlRead = true; readUrl(); } }

  function urlParams() {
    ensureUrlRead();
    var o = { lvl: S.level };
    if (S.level !== 'portfolio') { o.ent = S.entityId === null ? '' : S.entityId; }
    if (S.level === 'property') { o.prop = S.propertyId; o.ptab = S.ptab; }
    else { o.ptab = S.tab; }
    o.yr = S.year;
    if (S.fromMonth !== 1) o.fm = S.fromMonth;
    if (S.toMonth !== 12) o.tm = S.toMonth;
    return o;
  }

  function readUrl() {
    var p;
    try { p = new URLSearchParams((location.hash || '').replace(/^#/, '')); }
    catch (e) { return; }
    if (p.get('view') !== 'properties') return;
    var lvl = p.get('lvl');
    if (lvl === 'entity' || lvl === 'property' || lvl === 'portfolio') S.level = lvl;
    if (p.has('ent')) { S.entityId = p.get('ent') || null; }
    if (p.has('prop')) S.propertyId = p.get('prop');
    var t = p.get('ptab');
    if (t) { if (S.level === 'property') S.ptab = t; else S.tab = t; }
    var y = Number(p.get('yr'));
    if (y >= 2000 && y <= 2100) S.year = y;
    var fm = Number(p.get('fm')), tm = Number(p.get('tm'));
    if (fm >= 1 && fm <= 12) S.fromMonth = fm;
    if (tm >= 1 && tm <= 12) S.toMonth = tm;
  }

  function pushUrl() {
    try {
      var p = new URLSearchParams((location.hash || '').replace(/^#/, ''));
      var extra = urlParams();
      ['lvl', 'ent', 'prop', 'ptab', 'yr', 'fm', 'tm'].forEach(function (k) { p.delete(k); });
      Object.keys(extra).forEach(function (k) {
        if (extra[k] !== null && extra[k] !== undefined && extra[k] !== '') p.set(k, extra[k]);
        else if (k === 'ent') p.set(k, '');
      });
      history.pushState(null, '', location.pathname + location.search + '#' + p.toString());
    } catch (e) { /* a URL we cannot write is not a reason to refuse to navigate */ }
  }

  /* ---- navigation --------------------------------------------------------- */
  function goPortfolio(tab) {
    S.notice = null;
    S.level = 'portfolio'; S.entityId = null; S.entityName = null; S.propertyId = null;
    if (tab) S.tab = tab;
    pushUrl(); load();
  }
  function goEntity(id, name, tab) {
    S.notice = null;
    S.level = 'entity'; S.entityId = id === undefined ? null : id; S.entityName = name || null;
    S.propertyId = null; S.tab = tab || 'properties';
    pushUrl(); load();
  }
  function goProperty(id) {
    S.level = 'property'; S.propertyId = id; S.ptab = 'overview';
    S.rentAsOf = null; reset();
    pushUrl(); load();
  }

  function crumbHtml() {
    var parts = ['<button class="rp-crumb-b" data-crumb="portfolio">Portfolio</button>'];
    if (S.level !== 'portfolio') {
      var nm = S.entityName || entityNameOf(S.entityId) || 'No managing entity';
      if (S.level === 'property') {
        parts.push('<button class="rp-crumb-b" data-crumb="entity">' + escS(nm) + '</button>');
        parts.push('<span>' + escS(propertyNameOf(S.propertyId)) + '</span>');
      } else {
        parts.push('<span>' + escS(nm) + '</span>');
      }
    }
    return '<nav class="rp-crumb">' + parts.join('<i>/</i>') + '</nav>';
  }

  function entityNameOf(id) {
    var rows = (S.cache.entities && S.cache.entities.rows) || [];
    for (var i = 0; i < rows.length; i++) {
      if ((rows[i].managing_entity_id || null) === (id || null)) {
        return rows[i].managing_entity_name || 'No managing entity';
      }
    }
    return null;
  }
  function propertyNameOf(id) {
    var d = S.cache.prop;
    if (d && d.summary && d.summary.id === id && d.summary.name) return d.summary.name;
    var rows = (S.cache.summary && S.cache.summary.rows) || [];
    for (var i = 0; i < rows.length; i++) if (rows[i].id === id) return rows[i].name;
    return '';
  }

  function propertyById(id) {
    return (S.tree && S.tree.properties || []).filter(function (p) { return p.id === id; })[0] || null;
  }

  /* The mortgage DSCR on the list prefers the BOOKS' own twelve months and
     falls back to the loan-record ratio, so a property whose debt service
     comes from its books is not blank here just because its loan record has
     no annual figure. */
  function dscrM(r) {
    return isNum(r.trailing_dscr_mortgage) ? r.trailing_dscr_mortgage : r.trailing_dscr;
  }
  /* B4: red below 1.00, orange to 1.24, green at or above the required
     ratio (the what-if input, 1.25 by default). Between 1.25 and a higher
     requirement a DSCR is simply uncoloured: adequate, not good. */
  function cls(v) {
    if (!isNum(v)) return '';
    var n = Number(v), req = isNum(S.whatif.requiredDscr) ? Number(S.whatif.requiredDscr) : 1.25;
    return n < 1 ? 'rp-bad' : n < 1.25 ? 'rp-warn' : n >= req ? 'rp-good' : '';
  }
  function noiCls(v) { return !isNum(v) ? '' : Number(v) < 0 ? 'rp-bad' : Number(v) > 0 ? 'rp-good' : ''; }

  /* Where a unit count came from, and whether the two sources disagree.
     A count from the rent roll is a snapshot of what was leasable on one
     date; a verified count is a deliberate statement about the asset. They
     are not the same claim, so the screen says which it is showing. */
  function unitsNote(r) {
    if (!isNum(r.units)) return '';
    if (r.units_disagree) {
      return ' ' + tag('rr ' + intf(r.units_rent_roll),
        'Verified count ' + intf(r.units) + '; the rent roll of ' +
        dateOnly(r.units_rent_roll_as_of) + ' shows ' + intf(r.units_rent_roll) + '.', 'warn');
    }
    if (r.units_source === 'rent_roll') {
      return ' ' + tag('rent roll',
        'No verified count or building total on file; taken from the rent roll of ' +
        dateOnly(r.units_rent_roll_as_of) + '.');
    }
    return '';
  }

  function colourClass(row) {
    /* red beats orange; the brief's thresholds, applied per cell by the
       caller rather than to the whole row. */
    return {
      noi: noiCls(row.t12_noi),
      net: isNum(row.t12_net_income) && Number(row.t12_net_income) < 0 ? 'rp-bad' : '',
      dscr: cls(dscrM(row)),
      occ: !isNum(row.latest_occupancy) ? ''
           : Number(row.latest_occupancy) < 0.85 ? 'rp-bad'
           : Number(row.latest_occupancy) <= 0.90 ? 'rp-warn' : '',
      exp: isNum(row.expense_ratio) && Number(row.expense_ratio) > 0.60 ? 'rp-warn' : '',
    };
  }

  /* "In Dropbox (T12 / Rent roll)".
     This used to print the SOURCE SYSTEM, which answers a different question
     and answers it for every property that has any data at all - so it read
     "T12" for 80 of 80 while only 50 actually have one filed. Both chips are
     driven by the document linked to the property's latest report of each
     kind, and the title says which file. */
  function dropboxCell(r) {
    function chip(on, label, file, when) {
      return '<span class="rp-dbx' + (on ? ' on' : '') + '"' +
        (on && file ? ' title="' + escS(file) + (when ? ' (' + dateOnly(when) + ')' : '') + '"' : '') +
        '>' + label + '</span>';
    }
    return chip(r.t12_in_dropbox, 'T12', r.t12_file_name, r.t12_period_end) +
           chip(r.rent_roll_in_dropbox, 'RR', r.rent_roll_file_name, r.rent_roll_as_of);
  }

  /* ---- C1/C2: the Properties table ---------------------------------------- */
  function visibleRows(data) {
    return (data.rows || []).filter(function (r) {
      if (S.status && r.ownership_status !== S.status) return false;
      if (S.withReports && !r.source_system) return false;
      if (S.source && r.source_system !== S.source) return false;
      if (S.search) {
        var q = S.search.toLowerCase();
        if (String(r.name || '').toLowerCase().indexOf(q) < 0 &&
            String(r.pm_company || '').toLowerCase().indexOf(q) < 0 &&
            String(r.managing_entity_name || '').toLowerCase().indexOf(q) < 0 &&
            String(r.entity_name || '').toLowerCase().indexOf(q) < 0) return false;
      }
      return true;
    });
  }

  function propertiesTab(data) {
    var all = data.rows || [];
    var rows = visibleRows(data);
    /* "only shown if any property in view has other debt" - a column of
       dashes for 78 of 80 properties is a column nobody can use. */
    var showAll = rows.some(function (r) { return isNum(r.trailing_dscr_all_debt) && isNum(r.t12_other_interest) && Number(r.t12_other_interest) > 0; });

    var statuses = {}, sources = {};
    all.forEach(function (r) {
      if (r.ownership_status) statuses[r.ownership_status] = 1;
      if (r.source_system) sources[r.source_system] = 1;
    });

    var h = [];
    h.push('<div class="rp-bar">' +
      '<input class="rp-inp" id="rpSearch" placeholder="Search property, entity or PM" value="' + escS(S.search) + '">' +
      '<select class="rp-inp" id="rpStatus">' +
        Object.keys(statuses).sort().map(function (s) {
          return '<option value="' + escS(s) + '"' + (S.status === s ? ' selected' : '') + '>' + escS(s) + '</option>';
        }).join('') +
        '<option value=""' + (S.status === '' ? ' selected' : '') + '>all statuses</option></select>' +
      '<select class="rp-inp" id="rpSource"><option value="">all sources</option>' +
        Object.keys(sources).sort().map(function (s) {
          return '<option value="' + escS(s) + '"' + (S.source === s ? ' selected' : '') + '>' + escS(s) + '</option>';
        }).join('') + '</select>' +
      '<label class="sv-chk' + (S.withReports ? ' on' : '') + '" id="rpWithReports">With reports</label>' +
      '<span class="rp-count">' + rows.length + ' of ' + all.length + '</span>' +
      '<span class="rp-spacer"></span>' +
      '<span class="rp-lbl">Density</span>' +
      '<button class="rp-btn' + (S.density === 'comfortable' ? ' on' : '') + '" data-density="comfortable">Comfortable</button>' +
      '<button class="rp-btn' + (S.density === 'compact' ? ' on' : '') + '" data-density="compact">Compact</button>' +
      '<button class="rp-btn" id="rpExport">Export CSV</button>' +
      '</div>');

    h.push('<div id="rpTblHost"><div class="rp-scroll"><table class="rp-tbl rp-frozen"><thead><tr>' +
      '<th>Property</th><th class="r">Units</th><th class="r">Occupancy</th>' +
      '<th class="r">Total income</th><th class="r">Total expenses</th>' +
      '<th class="r">NOI, trailing 12 mo</th><th class="r">Optimized NOI</th>' +
      '<th class="r">Expense ratio</th><th class="r">Net income</th>' +
      '<th class="r">DSCR, mortgage</th>' + (showAll ? '<th class="r">DSCR, all debt</th>' : '') +
      '<th>PM company</th><th>In Dropbox</th></tr></thead><tbody>');

    rows.forEach(function (r) {
      var c = colourClass(r);
      h.push('<tr class="rp-row" data-prop="' + escS(r.id) + '">' +
        '<td><a class="rp-link" href="#brand=leavenwealth&view=properties&lvl=property&prop=' + escS(r.id) + '">' +
          escS(r.name) + '</a>' +
          (r.source_system ? '<span class="rp-src">' + escS(label(r.source_system)) + '</span>' : '') + '</td>' +
        '<td class="r">' + intf(r.units) + unitsNote(r) + '</td>' +
        '<td class="r ' + c.occ + '">' + pct(r.latest_occupancy) + '</td>' +
        '<td class="r">' + money$(r.t12_income, { whole: true }) + '</td>' +
        '<td class="r">' + money$(r.t12_expense, { whole: true }) + '</td>' +
        '<td class="r ' + c.noi + '">' + money$(r.t12_noi, { whole: true }) + '</td>' +
        '<td class="r">' + money$(r.optimized_noi, { whole: true }) + '</td>' +
        '<td class="r ' + c.exp + '">' + pct(r.expense_ratio) + '</td>' +
        /* B4: net income is NOT coloured in tables, only on its own tab */
        '<td class="r">' + money$(r.t12_net_income, { whole: true }) + '</td>' +
        '<td class="r ' + c.dscr + '">' + ratio(dscrM(r)) +
          (r.debt_service_interest_only ? ' ' + TAG_INTEREST_ONLY() : '') + '</td>' +
        (showAll ? '<td class="r ' + cls(r.trailing_dscr_all_debt) + '">' + ratio(r.trailing_dscr_all_debt) + '</td>' : '') +
        '<td>' + escS(r.pm_company || DASH) + '</td>' +
        '<td>' + dropboxCell(r) + '</td></tr>');
    });

    var t = totalsOf(rows);
    h.push('</tbody><tfoot><tr>' +
      '<td><b>Total</b> <span class="rp-dim">' + rows.length + '</span></td>' +
      '<td class="r">' + intf(t.units) + '</td><td class="r">' + pct(t.occupancy) + '</td>' +
      '<td class="r">' + money$(t.t12_income, { whole: true }) + '</td>' +
      '<td class="r">' + money$(t.t12_expense, { whole: true }) + '</td>' +
      '<td class="r' + neg(t.t12_noi) + '">' + money$(t.t12_noi, { whole: true }) + '</td>' +
      '<td class="r">' + money$(t.optimized_noi, { whole: true }) + '</td>' +
      '<td class="r">' + pct(t.expense_ratio) + '</td>' +
      '<td class="r">' + money$(t.t12_net_income, { whole: true }) + '</td>' +
      '<td class="r">' + ratio(t.dscr) + '</td>' +
      (showAll ? '<td class="r">' + ratio(t.dscr_all) + '</td>' : '') +
      '<td></td><td></td></tr></tfoot></table></div></div>');
    return h.join('');
  }

  /* Totals over what is ON SCREEN, which is what the export writes too - a
     total that does not match the rows above it is worse than no total. */
  function totalsOf(rows) {
    var sum = function (k) {
      var v = rows.map(function (r) { return r[k]; }).filter(isNum).map(Number);
      return v.length ? v.reduce(function (a, b) { return a + b; }, 0) : null;
    };
    var units = sum('units'), inc = sum('t12_income'), exp = sum('t12_expense');
    var ds = sum('t12_debt_service'), oi = sum('t12_other_interest') || 0;
    var noi = sum('t12_noi');
    /* occupancy is weighted by units, not averaged: a 12-unit property and a
       235-unit property do not count the same */
    var occN = 0, occD = 0;
    rows.forEach(function (r) {
      if (isNum(r.latest_occupancy) && isNum(r.units)) { occN += Number(r.latest_occupancy) * Number(r.units); occD += Number(r.units); }
    });
    return {
      units: units, t12_income: inc, t12_expense: exp, t12_noi: noi,
      optimized_noi: sum('optimized_noi'), t12_net_income: sum('t12_net_income'),
      expense_ratio: inc > 0 ? exp / inc : null,
      occupancy: occD > 0 ? occN / occD : null,
      dscr: ds > 0 ? noi / ds : null,
      dscr_all: (ds || 0) + oi > 0 ? noi / ((ds || 0) + oi) : null,
      t12_debt_service: ds, t12_other_interest: oi,
    };
  }

  /* ---- F: the fee tracker -------------------------------------------------- */
  /* F4. A variance under a dollar is a rounding difference, not a miss, and
     rendering it as "(0.01)" in red asks somebody to chase a penny. Under
     $1.00 reads 0.00 in neutral grey, and the fills are tints rather than
     blocks so a month of them does not drown the figures. */
  function varianceCell(v) {
    if (!isNum(v)) return '<td class="r">' + DASH + '</td>';
    var n = Number(v);
    if (Math.abs(n) < 1) return '<td class="r rp-vzero">0.00</td>';
    return '<td class="r ' + (n < 0 ? 'rp-vneg' : 'rp-vpos') + '">' + money(n) + '</td>';
  }

  function feesTab(fees) {
    var h = [];
    h.push('<div class="rp-bar">' +
      '<span class="rp-lbl">Year</span>' +
      '<select class="rp-inp" id="rpYear">' +
      [S.year - 2, S.year - 1, S.year, S.year + 1].map(function (y) {
        return '<option value="' + y + '"' + (y === S.year ? ' selected' : '') + '>' + y + '</option>';
      }).join('') + '</select>' +
      '<span class="rp-dim">Received is display-only in this release. ' +
      '<i>Italic</i> figures come from the property’s own books rather than a recorded receipt.</span>' +
      '<span class="rp-spacer"></span>' +
      '<button class="rp-btn" id="rpFeeExport">Export CSV</button></div>');

    if (!fees.groups || !fees.groups.length) {
      h.push('<div class="rp-empty">' +
        (S.level === 'entity'
          ? 'No asset management fees set up for this entity.'
          : 'No fee schedule for ' + S.year + '.') + '</div>');
      return h.join('');
    }

    h.push('<div class="rp-scroll"><table class="rp-tbl rp-fees rp-frozen"><thead><tr>' +
      '<th>Fee row</th><th></th>' +
      MONTHS.map(function (m) { return '<th class="r">' + m + '</th>'; }).join('') +
      '<th class="r rp-total-col">Total</th></tr></thead>');

    var gt = { expected: {}, received: {}, variance: {} };

    fees.groups.forEach(function (g) {
      var open = !S.collapsed[g.manager_group];
      h.push('<tbody class="rp-grp"><tr class="rp-grph"><td colspan="15">' +
        '<button class="rp-collapse' + (open ? ' open' : '') + '" data-fgroup="' + escS(g.manager_group) + '"' +
        ' aria-expanded="' + (open ? 'true' : 'false') + '"' +
        ' aria-label="' + (open ? 'Collapse ' : 'Expand ') + escS(g.manager_group) + '">' +
        icon('chev') + '</button>' +
        '<b>' + escS(g.manager_group) + '</b>' +
        '<span class="rp-chip">' + (g.payment_timing === 'same_month' ? 'same month' : 'following month') + '</span>' +
        (g.timing_confirmed ? '' : '<span class="rp-chip rp-chip-warn">timing not confirmed</span>') +
        '<span class="rp-dim"> ' + g.rows.length + ' fee row' + (g.rows.length === 1 ? '' : 's') + '</span>' +
        '</td></tr>');

      g.rows.forEach(function (r) {
        /* totals accumulate whether or not the group is open - collapsing a
           group hides rows, it does not remove them from the portfolio */
        var te = 0, tr = 0, tv = 0, he = false, hr = false, hv = false;
        var ec = [], rc = [], vc = [];
        for (var m = 1; m <= 12; m++) {
          var ev = r.expected[m], rv = r.received[m], vv = r.variance[m];
          if (isNum(ev)) { te += Number(ev); he = true; gt.expected[m] = (gt.expected[m] || 0) + Number(ev); }
          if (isNum(rv)) { tr += Number(rv); hr = true; gt.received[m] = (gt.received[m] || 0) + Number(rv); }
          if (isNum(vv)) { tv += Number(vv); hv = true; gt.variance[m] = (gt.variance[m] || 0) + Number(vv); }
          ec.push('<td class="r">' + money(ev) + '</td>');
          rc.push('<td class="r' + (r.received_source[m] === 'books' ? ' rp-books' : '') + '"' +
            (r.received_source[m] ? ' title="from ' + escS(r.received_source[m]) + '"' : '') + '>' + money(rv) + '</td>');
          vc.push(varianceCell(vv));
        }
        if (!open) return;

        var fee = r.fee_type === 'fixed' ? money$(r.fixed_amount) + ' fixed' : (isNum(r.fee_pct) ? r.fee_pct + '% of gross' : DASH);
        var names = (r.properties || []).map(function (p) { return p.property_name; }).join(', ');
        h.push('<tr class="rp-feehead"><td rowspan="3"><b>' + escS(r.label) + '</b>' +
          '<div class="rp-dim rp-sub">' + escS(fee) + (names ? ' · ' + escS(names) : '') + '</div>' +
          (r.fee_note ? '<div class="rp-note rp-sub">' + escS(r.fee_note) + '</div>' : '') +
          '</td><td class="rp-rl">Expected</td>' + ec.join('') +
          '<td class="r rp-total-col"><b>' + (he ? money(te) : DASH) + '</b></td></tr>');
        h.push('<tr><td class="rp-rl">Received</td>' + rc.join('') +
          '<td class="r rp-total-col"><b>' + (hr ? money(tr) : DASH) + '</b></td></tr>');
        h.push('<tr class="rp-varrow"><td class="rp-rl">Variance</td>' + vc.join('') +
          '<td class="r rp-total-col"><b>' + (hv ? money(tv) : DASH) + '</b></td></tr>');
      });
      h.push('</tbody>');
    });

    function totalRow(label, map, isVar) {
      var t = 0, has = false, cells = [];
      for (var m = 1; m <= 12; m++) {
        var v = map[m];
        if (isNum(v)) { t += Number(v); has = true; }
        cells.push(isVar ? varianceCell(v) : '<td class="r">' + money(v) + '</td>');
      }
      return '<tr><td class="rp-rl">' + label + '</td>' + cells.join('') +
             '<td class="r rp-total-col"><b>' + (has ? money(t) : DASH) + '</b></td></tr>';
    }
    h.push('<tfoot><tr class="rp-grph"><td colspan="15"><b>All properties</b></td></tr>' +
      '<tr><td rowspan="3"></td>' + totalRow('Expected', gt.expected).slice(4) +
      totalRow('Received', gt.received) + totalRow('Variance', gt.variance, true) + '</tfoot>');
    h.push('</table></div>');
    return h.join('');
  }

  /* ---- the property page --------------------------------------------------- */

  /* D2. Row order is the Excel sheet's, not an invention, so the two can be
     read side by side. The flag on each row says whether it is conditional:
     a row that is "only if any" is hidden entirely when the property has
     none, because a permanently blank row teaches the reader to skip that
     part of the table. */
  var MROWS = [
    ['# of Units', 'units', intf, 0],
    ['Rent Income', 'rent_income', money, 0],
    ['Recurring Fee Income', 'recurring_fee_income', money, 0],
    ['Non-Recurring Fee Income', 'non_recurring_fee_income', money, 0],
    ['Total Expected Income', 'total_expected_income', money, 0],
    ['Total Operating Income', 'total_operating_income', money, 0],
    ['Total Operating Expense', 'total_operating_expense', money, 0],
    ['Net Operating Income', 'noi', money, 1],
    ['Expense Ratio', '_expratio', pct, 1],
    ['Capital Expense', 'capex', money, 0],
    ['Capex Ratio', '_capexratio', pct, 0],
    ['Utility Income Ratio', '_utilratio', pct, 0],
    ['Cash Flow', 'cash_flow', money, 1],
    ['Delinquency', 'delinquency', money, 0],
    ['Asset Management Fee', 'am_fee_booked', money, 0],
    ['Asset Management Fee %', '_amfeepct', pct, 0],
    ['Physical Occupancy', 'physical_occupancy', pct, 1],
    ['Economic Occupancy', 'economic_occupancy', pct, 1],
    ['Debt Service, mortgage', 'debt_service', money, 0],
    ['Other interest counted as debt', 'recurring_other_interest', money, 0, 'otherDebt'],
    ['Debt Service, all debt', 'debt_service_all', money, 1, 'otherDebt'],
    ['Loan Proceeds', 'loan_proceeds', money, 0, 'proceeds'],
    ['DSCR, mortgage', 'dscr', ratio, 1],
    ['DSCR, all debt', 'dscr_all_debt', ratio, 1, 'otherDebt'],
    ['Loss to Lease', 'loss_to_lease', money, 0],
  ];

  function derived(r, key) {
    if (!r) return null;
    var inc = Number(r.total_operating_income);
    switch (key) {
      case '_expratio':   return isNum(r.total_operating_expense) && inc > 0 ? r.total_operating_expense / inc : null;
      case '_capexratio': return isNum(r.capex) && inc > 0 ? r.capex / inc : null;
      case '_amfeepct':   return isNum(r.am_fee_booked) && inc > 0 ? r.am_fee_booked / inc : null;
      /* utility income is not a column on property_month, so this is
         deliberately absent rather than approximated from something else */
      case '_utilratio':  return null;
      default: return r[key];
    }
  }

  function monthlyTab(d) {
    var from = Math.min(S.fromMonth, S.toMonth), to = Math.max(S.fromMonth, S.toMonth);
    var months = [];
    for (var m = from; m <= to; m++) months.push(m);

    var anyOther = months.some(function (mm) {
      var r = d.byMonth[d.year + '-' + String(mm).padStart(2, '0')];
      return r && isNum(r.recurring_other_interest) && Number(r.recurring_other_interest) !== 0;
    });
    var anyProceeds = months.some(function (mm) {
      var r = d.byMonth[d.year + '-' + String(mm).padStart(2, '0')];
      return r && isNum(r.loan_proceeds);
    });

    var h = [];
    var dsNote = d.debtServiceSource === 'income_statement'
      ? 'Debt service is this property’s own interest plus principal from its books.'
      : d.debtServiceSource === 'loan_record'
      ? 'This property’s books carry no principal line, so debt service is the loan record’s annual figure divided by 12.'
      : d.debtServiceSource === 'interest_only_books'
      ? '<b>Interest only, from the books.</b> This property books interest but no principal and has no loan record, so debt service here is the interest alone and is lower than the real payment. Coverage below is correspondingly optimistic.'
      : 'No debt service could be established for this property.';

    h.push('<p class="rp-note rp-src-note">Source: T12 export, <b>' + escS(d.basis) + '</b> basis. ' + dsNote +
      ' Cash flow is NOI less the asset management fee, debt service and capital expense. ' +
      'A month with no export shows ' + DASH + ', which means not available rather than zero.</p>');

    if (anyProceeds) {
      var notes = [];
      months.forEach(function (mm) {
        var r = d.byMonth[d.year + '-' + String(mm).padStart(2, '0')];
        if (r && r.loan_proceeds_note) notes.push(MONTHS[mm - 1] + ': ' + r.loan_proceeds_note);
      });
      if (notes.length) h.push('<p class="rp-note">Loan proceeds are money arriving, not a cost, and are never netted against anything. ' + escS(notes.join(' · ')) + '</p>');
    }

    /* build every row first, so a row that is entirely unavailable can be
       counted before deciding whether to show the toggle at all */
    var built = [];
    MROWS.forEach(function (row) {
      var label = row[0], key = row[1], fmt = row[2], bold = row[3], cond = row[4];
      if (cond === 'otherDebt' && !anyOther) return;
      if (cond === 'proceeds' && !anyProceeds) return;

      var vals = [], cells = [];
      months.forEach(function (mm) {
        var rec = d.byMonth[d.year + '-' + String(mm).padStart(2, '0')];
        var v = rec ? derived(rec, key) : null;
        if (isNum(v)) vals.push(Number(v));
        var c = '';
        if (key === 'noi' || key === 'cash_flow') c = isNum(v) ? (Number(v) < 0 ? ' rp-neg' : ' rp-pos') : '';
        else if (key === 'dscr' || key === 'dscr_all_debt') c = ' ' + cls(v);
        else if (fmt === money && isNum(v) && Number(v) < 0) c = ' rp-neg';
        cells.push('<td class="r' + c + '">' + fmt(v) + '</td>');
      });

      var sum = vals.length ? vals.reduce(function (a, b) { return a + b; }, 0) : null;
      var avg = vals.length ? sum / vals.length : null;
      var isRate = fmt === pct || fmt === ratio;
      var totalV = isRate ? avg : (key === 'units' ? (vals.length ? vals[vals.length - 1] : null) : sum);
      cells.push('<td class="r">' + fmt(avg) + '</td>');
      cells.push('<td class="r rp-total-col"><b>' + fmt(totalV) + '</b></td>');
      built.push({ label: label, bold: bold, empty: vals.length === 0, html: cells.join('') });
    });

    var hidden = built.filter(function (b) { return b.empty; }).length;
    if (hidden) {
      h.push('<div class="rp-bar"><label class="sv-chk' + (S.showUnavailable ? ' on' : '') +
        '" id="rpShowUnavailable">Show unavailable rows</label>' +
        '<span class="rp-dim">' + hidden + ' row' + (hidden === 1 ? '' : 's') +
        ' have no data for this period</span></div>');
    }

    h.push('<div class="rp-scroll"><table class="rp-tbl rp-monthly rp-frozen"><thead><tr><th>Line</th>' +
      months.map(function (mm) { return '<th class="r">' + MONTHS[mm - 1] + '</th>'; }).join('') +
      '<th class="r">Average</th><th class="r rp-total-col">Total</th></tr></thead><tbody>');
    built.forEach(function (b) {
      if (b.empty && !S.showUnavailable) return;
      h.push('<tr class="' + (b.bold ? 'rp-strong' : '') + (b.empty ? ' rp-rowempty' : '') + '">' +
        '<td>' + escS(b.label) + '</td>' + b.html + '</tr>');
    });
    h.push('</tbody></table></div>');
    return h.join('');
  }

  /* 2.5 Income & expenses */
  function isTab(d) {
    if (!d.lines || !d.lines.length) return '<div class="rp-empty">No income statement on file for this property.</div>';
    var months = d.months;
    var h = ['<div class="rp-scroll"><table class="rp-tbl rp-is"><thead><tr><th>Account</th>' +
      months.map(function (m) { return '<th class="r">' + escS(m) + '</th>'; }).join('') +
      '<th class="r">Total</th></tr></thead><tbody>'];

    function block(section, title) {
      var lines = d.lines.filter(function (l) { return l.section === section; });
      if (!lines.length) return;
      h.push('<tr class="rp-grph"><td colspan="' + (months.length + 2) + '"><b>' + escS(title) + '</b></td></tr>');
      lines.forEach(function (l) {
        h.push('<tr class="' + (l.is_total ? 'rp-strong' : '') + '">' +
          '<td style="padding-left:' + (10 + (Number(l.depth) || 0) * 14) + 'px">' + escS(l.line_label) + '</td>' +
          months.map(function (m) {
            var v = l.values[m];
            return '<td class="r' + neg(v) + '">' + money(v) + '</td>';
          }).join('') +
          '<td class="r"><b>' + money(l.total) + '</b></td></tr>');
      });
    }
    block('income', 'Income');
    block('operating_expense', 'Operating expense');
    block('non_operating_expense', 'Non-operating expense');
    block('other_cash_items', 'Other cash items');
    h.push('</tbody></table></div>');
    return h.join('');
  }

  /* 2.6 Optimized NOI */
  function noiTab(d) {
    var w = S.whatif;
    var N = window.NoiAnalysis;
    var series = d.series || [];
    var best1 = d.windows.best1, best3 = d.windows.best3, best6 = d.windows.best6;

    var inWin = function (win) {
      if (!win) return function () { return false; };
      return function (m) { return m >= win.from && m <= win.to; };
    };
    var in1 = inWin(best1 ? { from: best1.from, to: best1.to } : null);
    var in3 = inWin(best3 ? { from: best3.from, to: best3.to } : null);
    var in6 = inWin(best6 ? { from: best6.from, to: best6.to } : null);

    var h = [];
    h.push('<div class="rp-bar">' +
      '<label class="rp-lbl">Cap rate</label>' +
      '<input class="rp-inp rp-num" id="rpCap" type="number" step="0.1" value="' + w.capRatePct + '"> <span class="rp-dim">%</span>' +
      '<span class="rp-state">' + (S.whatifTouched ? 'Changed (not saved)' : 'Standard values') + '</span>' +
      '<button class="rp-btn" id="rpReset">Reset</button></div>');

    h.push('<div class="rp-scroll"><table class="rp-tbl"><thead><tr><th>Month</th>' +
      '<th class="r">Operating income</th><th class="r">Operating expenses</th><th class="r">NOI</th></tr></thead><tbody>');
    series.forEach(function (s) {
      var cls = in1(s.month) ? ' rp-w1' : in3(s.month) ? ' rp-w3' : in6(s.month) ? ' rp-w6' : '';
      h.push('<tr class="' + cls.trim() + '"><td>' + escS(s.month) + '</td>' +
        '<td class="r">' + money(s.income) + '</td><td class="r">' + money(s.expense) + '</td>' +
        '<td class="r' + neg(s.noi) + '"><b>' + money(s.noi) + '</b></td></tr>');
    });
    h.push('</tbody></table></div>');
    h.push('<div class="rp-legend"><span class="rp-k rp-w1"></span>best month' +
      '<span class="rp-k rp-w3"></span>best 3 consecutive' +
      '<span class="rp-k rp-w6"></span>best 6 consecutive</div>');

    var cap = Number(w.capRatePct);
    var trailing = d.trailing_noi;
    var scenarios = [
      ['Trailing 12 months', series.length, trailing, false],
      ['Optimized NOI', 6, best6 ? best6.annual : null, true],
      ['Best 3 months × 4', 3, best3 ? best3.annual : null, false],
      ['Best month × 12', 1, best1 ? best1.annual : null, false],
    ];

    h.push('<h4 class="rp-h4">What it earns at its best</h4>');
    h.push('<table class="rp-tbl"><thead><tr><th></th><th class="r">Months</th>' +
      '<th class="r">Annual NOI</th><th class="r">Value at ' + cap.toFixed(1) + '% cap rate ' +
        tag('estimate', 'Derived from NOI at the cap rate above, not an observed value.') + '</th>' +
      '<th class="r">vs. trailing 12</th></tr></thead><tbody>');
    scenarios.forEach(function (s) {
      var annual = s[2];
      var val = N ? N.valueAtCap(annual, cap) : null;
      var dv = isNum(annual) && isNum(trailing) ? annual - trailing : null;
      var dp = isNum(dv) && isNum(trailing) && trailing !== 0 ? dv / Math.abs(trailing) : null;
      h.push('<tr class="' + (s[3] ? 'rp-strong rp-w6' : '') + '"><td>' + escS(s[0]) + '</td>' +
        '<td class="r">' + intf(s[1]) + '</td>' +
        '<td class="r">' + money$(annual, { whole: true }) + '</td>' +
        '<td class="r">' + money$(val, { whole: true }) + '</td>' +
        '<td class="r' + neg(dv) + '">' + (isNum(dv) ? money$(dv, { whole: true }) + ' (' + pct(dp) + ')' : DASH) + '</td></tr>');
    });
    h.push('</tbody></table>');
    if (!best6) h.push('<p class="rp-note">Optimized NOI needs six consecutive months of data. This property has fewer, so it is ' + DASH + ' rather than a smaller window scaled up.</p>');
    return h.join('');
  }

  /* 2.6 DSCR */
  function dscrTab(d) {
    var w = S.whatif, N = window.NoiAnalysis;
    var f = d.facts || {};
    var balance = isNum(w.loanBalance) ? Number(w.loanBalance) : f.balance;
    /* Prefer an explicit what-if, then the loan record, then the BOOKS. The
       last step is what stops a property whose debt service is in its income
       statement being told it has none on file. */
    var ads = isNum(w.annualDebtService) ? Number(w.annualDebtService)
            : isNum(f.annual_debt_service) ? Number(f.annual_debt_service)
            : isNum(f.books_annual_debt_service) ? Number(f.books_annual_debt_service)
            : null;
    var adsFromBooks = !isNum(w.annualDebtService) && !isNum(f.annual_debt_service) && isNum(ads);

    var h = [];
    h.push('<div class="rp-bar rp-wrap">' +
      '<label class="rp-lbl">Required DSCR</label><input class="rp-inp rp-num" id="rpReq" type="number" step="0.01" value="' + w.requiredDscr + '">' +
      '<label class="rp-lbl">New loan rate</label><input class="rp-inp rp-num" id="rpRate" type="number" step="0.1" value="' + w.newRatePct + '"><span class="rp-dim">%</span>' +
      '<label class="rp-lbl">Amortization</label><input class="rp-inp rp-num" id="rpAmort" type="number" step="1" value="' + w.amortYears + '"><span class="rp-dim">yrs</span>' +
      '<label class="rp-lbl">Loan balance</label><input class="rp-inp rp-num" id="rpBal" type="number" value="' + (isNum(balance) ? balance : '') + '">' +
      '<label class="rp-lbl">Annual debt service</label><input class="rp-inp rp-num" id="rpAds" type="number" value="' + (isNum(ads) ? ads : '') + '">' +
      '<span class="rp-state">' + (S.whatifTouched ? 'Changed (not saved)' : 'Standard values') + '</span>' +
      '<button class="rp-btn" id="rpReset2">Reset</button></div>');

    if (f.debt_service_source === 'interest_only_books') {
      h.push('<p class="rp-note">' + TAG_INTEREST_ONLY() +
        ' This property books interest but no principal and has no loan record, so every ratio below is an ' +
        '<b>upper bound</b> on its real coverage, not a measurement of it.</p>');
    }
    if (d.other_interest_counted) {
      h.push('<p class="rp-note">Other interest on this property recurs and is backed by a non-primary loan on file, ' +
        'so it is counted as additional debt service in the all-debt column. Mortgage-only coverage is shown beside it ' +
        'so the two can be compared rather than one replacing the other.</p>');
    }
    if (adsFromBooks) {
      h.push('<p class="rp-note">Debt service here is this property’s own, from its income statement. ' +
        '<b>' + money$(ads) + '</b> over ' + f.books_months + ' months. ' +
        'Its loan record states no annual figure, which is a gap in the loan record rather than an absence of debt.</p>');
    }
    if (f.balance === null || f.balance === undefined) {
      h.push('<p class="rp-note">Loan record: <b>Not on file.</b> ' +
        (isNum(d.series && d.series.length) ? 'Loan payments seen in the income statement are shown below.' : '') + '</p>');
    } else {
      h.push('<p class="rp-note">Loan balance <b>' + money$(f.balance) + '</b>' +
        ' · annual debt service ' + (isNum(f.annual_debt_service) ? '<b>' + money$(f.annual_debt_service) + '</b>' : DASH) +
        ' · rate ' + (isNum(f.interest_rate_pct) ? Number(f.interest_rate_pct).toFixed(3) + '%' : DASH) +
        ' · matures ' + dateOnly(f.maturity_date) + '</p>');
    }

    if (!isNum(ads)) {
      h.push('<div class="rp-empty">No debt service on file. Enter an annual debt service above to see coverage (not saved).</div>');
    } else {
      var monthly = Number(ads) / 12;
      /* Per month, the books' own figure beats an annual average wherever it
         exists: debt service is not flat across a year on a property that
         refinanced mid-period. */
      var perMonth = function (s) {
        if (isNum(w.annualDebtService)) return Number(w.annualDebtService) / 12;
        if (isNum(s.debt_service)) return Number(s.debt_service);
        return monthly;
      };
      h.push('<div class="rp-scroll"><table class="rp-tbl"><thead><tr><th>Month</th>' +
        '<th class="r">NOI</th><th class="r">Debt service</th>' +
        '<th class="r">Other interest</th>' +
        '<th class="r">DSCR, mortgage</th><th class="r">DSCR, all debt</th></tr></thead><tbody>');
      (d.series || []).forEach(function (s) {
        var oi = isNum(s.recurring_other_interest) ? Number(s.recurring_other_interest) : 0;
        var ds = perMonth(s);
        var r = N ? N.dscr(s.noi, ds) : null;
        var rAll = N ? N.dscr(s.noi, ds + oi) : null;
        var cl = function (x) { return !isNum(x) ? '' : Number(x) < Number(w.requiredDscr) ? ' rp-bad' : ' rp-ok'; };
        h.push('<tr><td>' + escS(s.month) + '</td><td class="r">' + money(s.noi) + '</td>' +
          '<td class="r">' + money(ds) + '</td>' +
          '<td class="r">' + (oi ? money(oi) : DASH) + '</td>' +
          '<td class="r' + cl(r) + '">' + ratio(r) + '</td>' +
          '<td class="r' + cl(rAll) + '">' + ratio(rAll) + '</td></tr>');
      });
      h.push('</tbody></table></div>');
    }

    h.push('<h4 class="rp-h4">Can it carry its loan, and how much more?</h4>');
    h.push('<table class="rp-tbl"><thead><tr><th></th><th class="r">Annual NOI</th><th class="r">DSCR</th>' +
      '<th class="r">Meets ' + Number(w.requiredDscr).toFixed(2) + '?</th>' +
      '<th class="r">Max loan</th><th class="r">vs. current loan</th></tr></thead><tbody>');
    var annualOther = (d.series || []).reduce(function (a, s) {
      return a + (isNum(s.recurring_other_interest) ? Number(s.recurring_other_interest) : 0); }, 0);
    [['Trailing 12 months', d.trailing_noi], ['Optimized NOI', d.optimized_noi]].forEach(function (s) {
      var annual = s[1];
      var r = isNum(annual) && isNum(ads) && Number(ads) > 0 ? Number(annual) / Number(ads) : null;
      var rAll = isNum(annual) && (Number(ads || 0) + annualOther) > 0
        ? Number(annual) / (Number(ads || 0) + annualOther) : null;
      var ml = N ? N.maxLoan(annual, w.requiredDscr, w.newRatePct, w.amortYears) : null;
      var dv = isNum(ml) && isNum(balance) ? ml - Number(balance) : null;
      h.push('<tr><td>' + escS(s[0]) + '</td><td class="r">' + money$(annual, { whole: true }) + '</td>' +
        '<td class="r">' + ratio(r) + (annualOther ? ' <span class="rp-dim">/ ' + ratio(rAll) + '</span>' : '') + '</td>' +
        '<td class="r">' + (!isNum(r) ? DASH : (Number(r) >= Number(w.requiredDscr) ? '<span class="rp-ok">Yes</span>' : '<span class="rp-bad">No</span>')) + '</td>' +
        '<td class="r">' + money$(ml, { whole: true }) + '</td>' +
        '<td class="r' + neg(dv) + '">' + money$(dv, { whole: true }) + '</td></tr>');
    });
    h.push('</tbody></table>');
    return h.join('');
  }

  /* 2.6 Asset management fee, this property only */
  function feePropTab(fees, propId) {
    var rows = (fees.rows || []).filter(function (r) {
      return (r.properties || []).some(function (p) { return p.property_id === propId; });
    });
    if (!rows.length) return '<div class="rp-empty">No asset management fee row covers this property.</div>';

    var h = ['<div class="rp-bar"><label class="rp-lbl">Year</label><select class="rp-inp" id="rpFeeYear2">' +
      [S.year - 2, S.year - 1, S.year, S.year + 1].map(function (y) {
        return '<option value="' + y + '"' + (y === S.year ? ' selected' : '') + '>' + y + '</option>';
      }).join('') + '</select></div>'];

    rows.forEach(function (r) {
      h.push('<p class="rp-note">Paid by <b>' + escS(r.manager_group) + '</b> · ' +
        (r.fee_type === 'fixed' ? money$(r.fixed_amount) + ' fixed' : (isNum(r.fee_pct) ? r.fee_pct + '% of gross' : DASH)) +
        ' · billed ' + (r.payment_timing === 'same_month' ? 'in the same month' : 'the following month') +
        ' · fee row <b>' + escS(r.label) + '</b>' +
        (r.fee_note ? ' · <i>' + escS(r.fee_note) + '</i>' : '') + '</p>');
      h.push('<div class="rp-scroll"><table class="rp-tbl"><thead><tr><th></th>' +
        MONTHS.map(function (m) { return '<th class="r">' + m + '</th>'; }).join('') + '<th class="r">Total</th></tr></thead><tbody>');
      [['Expected', 'expected', ''], ['Received', 'received', ''], ['Variance', 'variance', 'var']].forEach(function (k) {
        var t = 0, has = false, cells = [];
        for (var m = 1; m <= 12; m++) {
          var v = r[k[1]][m];
          if (isNum(v)) { t += Number(v); has = true; }
          var c = k[2] === 'var' && isNum(v) ? (Number(v) < 0 ? ' rp-vneg' : Number(v) > 0 ? ' rp-vpos' : ' rp-vzero') : '';
          cells.push('<td class="r' + c + '">' + money(v) + '</td>');
        }
        cells.push('<td class="r"><b>' + (has ? money(t) : DASH) + '</b></td>');
        h.push('<tr><td class="rp-rl">' + k[0] + '</td>' + cells.join('') + '</tr>');
      });
      h.push('</tbody></table></div>');
    });
    return h.join('');
  }

  /* 2.7 the rest */
  function totalsTab(d, prop) {
    var rows = [
      ['Units', intf(prop.units)], ['Occupancy', pct(prop.latest_occupancy)],
      ['Total income, trailing 12 mo', money$(prop.t12_income)],
      ['Total expenses, trailing 12 mo', money$(prop.t12_expense)],
      ['NOI, trailing 12 mo', money$(prop.t12_noi)], ['Optimized NOI', money$(prop.optimized_noi)],
      ['Expense ratio', pct(prop.expense_ratio)], ['Net income, trailing 12 mo', money$(prop.t12_net_income)],
      ['Debt', money$(prop.debt)],
      ['Debt service, mortgage (T12)', money$(prop.t12_debt_service)],
      ['Other interest counted (T12)', money$(prop.t12_other_interest)],
      ['DSCR, mortgage', ratio(dscrM(prop)) +
        (prop.debt_service_interest_only ? ' ' + TAG_INTEREST_ONLY() : '')],
      ['DSCR, all debt', ratio(prop.trailing_dscr_all_debt)],
      ['Next maturity', dateOnly(prop.next_maturity)],
    ];
    return '<table class="rp-tbl rp-kv"><tbody>' + rows.map(function (r) {
      return '<tr><td>' + escS(r[0]) + '</td><td class="r"><b>' + r[1] + '</b></td></tr>';
    }).join('') + '</tbody></table>';
  }

  function rentTab(d) {
    var u = d.units || [];
    if (!u.length) return '<div class="rp-empty">No rent roll on file for this property.</div>';
    var s = d.rentSummary || {};
    var dates = d.asOfDates || [];
    var h = [];
    if (dates.length > 1) {
      h.push('<div class="rp-bar"><span class="rp-lbl">Rent roll as of</span><select class="rp-inp" id="rpAsOf" aria-label="Rent roll date">' +
        dates.map(function (x) {
          return '<option value="' + escS(x) + '"' + (x === d.asOf ? ' selected' : '') + '>' + dateOnly(x) + '</option>';
        }).join('') + '</select>' +
        (dates[0] !== d.asOf ? '<span class="rp-dim">an earlier rent roll; the newest is ' + dateOnly(dates[0]) + '</span>' : '') + '</div>');
    }
    h.push('<p class="rp-note">As of <b>' + dateOnly(d.asOf || s.as_of_date) + '</b> · ' +
      intf(s.units) + ' units · ' + intf(s.occupied) + ' occupied · ' + intf(s.vacant) + ' vacant · ' +
      'rent ' + money$(s.rent_total) + ' against market ' + money$(s.market_rent_total) +
      ' · loss to lease ' + money$(s.loss_to_lease) + '</p>');
    h.push('<div class="rp-scroll"><table class="rp-tbl"><thead><tr><th>Unit</th><th>Tenant</th><th>Status</th>' +
      '<th class="r">Beds</th><th class="r">Baths</th><th class="r">Rent</th><th class="r">Market</th>' +
      '<th class="r">Balance</th><th>Lease start</th><th>Lease end</th></tr></thead><tbody>');
    u.forEach(function (r) {
      h.push('<tr><td>' + escS(r.unit || DASH) + '</td><td>' + escS(r.tenant || DASH) + '</td>' +
        '<td>' + escS(r.status || DASH) + '</td><td class="r">' + intf(r.beds) + '</td>' +
        '<td class="r">' + intf(r.baths) + '</td><td class="r">' + money(r.rent) + '</td>' +
        '<td class="r">' + money(r.market_rent) + '</td>' +
        '<td class="r' + neg(r.balance_due) + '">' + money(r.balance_due) + '</td>' +
        '<td>' + dateOnly(r.lease_start) + '</td><td>' + dateOnly(r.lease_end) + '</td></tr>');
    });
    h.push('</tbody></table></div>');
    return h.join('');
  }

  function capexTab(d) {
    var lines = (d.lines || []).filter(function (l) {
      return l.section === 'non_operating_expense' &&
             /capital/i.test((l.account_path || []).join(' ') + ' ' + l.line_label);
    });
    if (!lines.length) return '<div class="rp-empty">No capital expense lines in this period.</div>';
    var months = d.months;
    var h = ['<div class="rp-scroll"><table class="rp-tbl"><thead><tr><th>Account</th>' +
      months.map(function (m) { return '<th class="r">' + escS(m) + '</th>'; }).join('') +
      '<th class="r">Total</th></tr></thead><tbody>'];
    lines.forEach(function (l) {
      h.push('<tr class="' + (l.is_total ? 'rp-strong' : '') + '"><td style="padding-left:' +
        (10 + (Number(l.depth) || 0) * 14) + 'px">' + escS(l.line_label) + '</td>' +
        months.map(function (m) { return '<td class="r">' + money(l.values[m]) + '</td>'; }).join('') +
        '<td class="r"><b>' + money(l.total) + '</b></td></tr>');
    });
    h.push('</tbody></table></div>');
    return h.join('');
  }

  function valTab(prop) {
    var vpu = isNum(prop.value_on_file) && isNum(prop.units) && Number(prop.units) > 0
      ? Number(prop.value_on_file) / Number(prop.units) : null;
    var capAtT12 = isNum(prop.t12_noi) && isNum(prop.value_on_file) && Number(prop.value_on_file) > 0
      ? Number(prop.t12_noi) / Number(prop.value_on_file) : null;

    var stale = valueStale(prop.value_as_of);
    /* Every value carries its date, and one older than six months - or with
       no date at all - says so. A number divided by debt to produce an LTV
       has to be dated, or the LTV is undated too and nothing on screen
       admits it. */
    var dateBit = (prop.value_on_file === null || prop.value_on_file === undefined) ? ''
      : ' <span class="rp-dim">as of ' + dateOnly(prop.value_as_of) + '</span>' +
        (stale ? ' ' + tag('stale', prop.value_as_of
              ? 'This value is more than six months old.'
              : 'No as-of date is recorded for this value.', 'warn') : '');

    /* The cap-rate value is derived from NOI, not observed. It is always
       labelled, whatever the cap rate is set to. */
    var capValue = window.NoiAnalysis
      ? window.NoiAnalysis.valueAtCap(prop.t12_noi, S.whatif.capRatePct) : null;
    var ltvEst = isNum(capValue) && Number(capValue) > 0 && isNum(prop.debt)
      ? Number(prop.debt) / Number(capValue) : null;

    var rows = [
      ['Value on file', money$(prop.value_on_file) + dateBit],
      ['Value per unit', money$(vpu)],
      ['Cap rate at trailing NOI', pct(capAtT12)],
      ['Value at ' + Number(S.whatif.capRatePct).toFixed(1) + '% cap rate',
        money$(capValue, { whole: true }) + ' ' + tag('estimate', 'Derived from trailing NOI at the cap rate above, not an observed value.')],
      ['Debt', money$(prop.debt)],
      ['LTV', pct(prop.ltv) + (prop.ltv_basis === 'on_file'
        ? ' <span class="rp-dim">against the value on file, ' + dateOnly(prop.value_as_of) + '</span>' +
          (stale ? ' ' + tag('stale', 'The value it is measured against is more than six months old.', 'warn') : '')
        : ' <span class="rp-dim">no value on file</span>')],
      ['LTV at cap-rate estimate', pct(ltvEst) + ' ' + tag('estimate', 'Measured against the cap-rate value above, not an observed value.')],
    ];
    return '<table class="rp-tbl rp-kv"><tbody>' + rows.map(function (r) {
      return '<tr><td>' + escS(r[0]) + '</td><td class="r"><b>' + r[1] + '</b></td></tr>';
    }).join('') + '</tbody></table>';
  }

  function detailsTab(prop, raw) {
    var rows = [
      ['Property', prop.name], ['Entity', prop.entity_name], ['PM company', prop.pm_company],
      ['Source system', prop.source_system], ['City', prop.city], ['State', prop.state],
      ['Ownership status', prop.ownership_status], ['Units', intf(prop.units)],
    ];
    var h = ['<p class="rp-note">This release is <b>read-only</b>. Nothing on these screens writes to the database.</p>'];
    h.push('<table class="rp-tbl rp-kv"><tbody>' + rows.map(function (r) {
      return '<tr><td>' + escS(r[0]) + '</td><td class="r">' + escS(r[1] === null || r[1] === undefined || r[1] === '' ? DASH : r[1]) + '</td></tr>';
    }).join('') + '</tbody></table>');
    if (raw && raw.buildings && raw.buildings.length) {
      h.push('<h4 class="rp-h4">Buildings</h4><table class="rp-tbl"><thead><tr><th>Building</th><th class="r">Apartments</th></tr></thead><tbody>');
      raw.buildings.forEach(function (b) {
        h.push('<tr><td>' + escS(b.name || b.unit_identifier || DASH) + '</td><td class="r">' + intf(b.apartments != null ? b.apartments : b.current_total_units) + '</td></tr>');
      });
      h.push('</tbody></table>');
    }
    return h.join('');
  }

  function addBuildingBar() {
    return window.PortalSetup && PortalSetup.isAdmin()
      ? '<div class="rp-bar"><span class="rp-spacer"></span><button class="rp-btn" id="rpAddBuilding">' + icon('plus') + 'Building</button></div>' : '';
  }
  function bldgTab(raw) {
    var b = (raw && raw.buildings) || [];
    if (!b.length) return addBuildingBar() + '<div class="rp-empty">No building records for this property.</div>';
    /* residential first, then a NATURAL comparator: plain string order puts
       "Building 10" before "Building 2". */
    var sorted = b.slice().sort(function (x, y) {
      return String(x.name || x.unit_identifier || '').localeCompare(
        String(y.name || y.unit_identifier || ''), undefined, { numeric: true, sensitivity: 'base' });
    });
    return addBuildingBar() + '<div class="rp-scroll"><table class="rp-tbl"><thead><tr><th>Building</th>' +
      '<th class="r">Apartments</th><th>Address</th></tr></thead><tbody>' +
      sorted.map(function (x) {
        return '<tr><td>' + escS(x.name || x.unit_identifier || DASH) + '</td>' +
          '<td class="r">' + intf(x.apartments != null ? x.apartments : x.current_total_units) + '</td>' +
          '<td>' + escS(x.street || DASH) + '</td></tr>';
      }).join('') + '</tbody></table></div>';
  }

  /* ---- CSV export ---------------------------------------------------------- */
  function csv(rows) {
    return rows.map(function (r) {
      return r.map(function (c) {
        var s = c === null || c === undefined ? '' : String(c);
        return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
      }).join(',');
    }).join('\n');
  }
  function download(name, text) {
    var b = new Blob([text], { type: 'text/csv;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(b); a.download = name;
    document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 0);
  }

  /* ---- paint --------------------------------------------------------------- */
  function skeleton(rows, cols) {
    var n = rows || 10, c = cols || 8, h = ['<div class="rp-skel">'];
    h.push('<div class="rp-skel-bar"></div>');
    h.push('<table class="rp-tbl"><tbody>');
    for (var i = 0; i < n; i++) {
      h.push('<tr>');
      for (var j = 0; j < c; j++) {
        h.push('<td><span class="rp-skel-cell" style="width:' +
          (j === 0 ? 70 : 40 + ((i * 7 + j * 13) % 35)) + '%"></span></td>');
      }
      h.push('</tr>');
    }
    h.push('</tbody></table></div>');
    return h.join('');
  }

  /* ---- A1: the Entities table ---------------------------------------------
     One row per MANAGING entity. The old screen drilled through 130 legal
     entities; this drills through 17 managers, which is how the portfolio is
     actually run.
  -------------------------------------------------------------------------- */
  function entitiesTab(d) {
    var rows = d.rows || [];
    var showAll = !!d.anyOtherDebt;
    var h = [];
    h.push(densityBar(rows.length + ' managing entities'));
    h.push('<div class="rp-scroll"><table class="rp-tbl rp-frozen"><thead><tr>' +
      '<th>Managing entity</th><th class="r">Properties</th><th class="r">Units</th>' +
      '<th class="r">NOI, trailing 12 mo</th><th class="r">Optimized NOI</th>' +
      '<th class="r">Net income</th><th class="r">Value</th><th class="r">Debt</th>' +
      '<th class="r">LTV</th><th class="r">DSCR, mortgage</th>' +
      (showAll ? '<th class="r">DSCR, all debt</th>' : '') +
      '<th class="r">Flags</th></tr></thead><tbody>');

    rows.forEach(function (r) {
      var id = r.managing_entity_id || '';
      var nm = r.managing_entity_name || 'No managing entity on file';
      var sub = intf(r.properties) + ' propert' + (Number(r.properties) === 1 ? 'y' : 'ies') +
                (r.main_city ? ', ' + r.main_city : '');
      h.push('<tr class="rp-row" data-ent="' + escS(id) + '" data-entname="' + escS(nm) + '">' +
        '<td><a class="rp-link" href="#brand=leavenwealth&view=properties&lvl=entity&ent=' + escS(id) + '">' +
          escS(nm) + '</a>' + shortCode(nm) +
          '<div class="rp-dim rp-sub">' + escS(sub) + '</div></td>' +
        '<td class="r">' + intf(r.properties) + '</td>' +
        '<td class="r">' + intf(r.units) + '</td>' +
        '<td class="r' + neg(r.t12_noi) + '">' + money$(r.t12_noi, { whole: true }) + '</td>' +
        '<td class="r">' + money$(r.optimized_noi, { whole: true }) + '</td>' +
        '<td class="r">' + money$(r.t12_net_income, { whole: true }) + '</td>' +
        '<td class="r">' + money$(r.value_on_file, { whole: true }) + '</td>' +
        '<td class="r">' + money$(r.debt, { whole: true }) + '</td>' +
        '<td class="r">' + pct(r.ltv) + '</td>' +
        '<td class="r ' + cls(r.dscr_mortgage) + '">' + ratio(r.dscr_mortgage) + '</td>' +
        (showAll ? '<td class="r ' + cls(r.dscr_all_debt) + '">' + ratio(r.dscr_all_debt) + '</td>' : '') +
        '<td class="r">' + flagChip(r) + '</td></tr>');
    });

    var t = d.totals || {};
    h.push('</tbody><tfoot><tr><td><b>Total</b></td>' +
      '<td class="r">' + intf(t.properties) + '</td><td class="r">' + intf(t.units) + '</td>' +
      '<td class="r' + neg(t.t12_noi) + '">' + money$(t.t12_noi, { whole: true }) + '</td>' +
      '<td class="r">' + money$(t.optimized_noi, { whole: true }) + '</td>' +
      '<td class="r">' + money$(t.t12_net_income, { whole: true }) + '</td>' +
      '<td class="r">' + money$(t.value_on_file, { whole: true }) + '</td>' +
      '<td class="r">' + money$(t.debt, { whole: true }) + '</td>' +
      '<td class="r">' + pct(t.ltv) + '</td>' +
      '<td class="r">' + ratio(t.dscr_mortgage) + '</td>' +
      (showAll ? '<td class="r">' + DASH + '</td>' : '') +
      '<td class="r">' + intf(t.flags) + '</td></tr></tfoot></table></div>');
    return h.join('');
  }

  /* A short code from the entity name - "Midwest Portfolio Managers 4 LLC"
     becomes MPM4. Derived, never stored: a code nobody maintains is one that
     goes stale the first time an entity is renamed. */
  function shortCode(name) {
    var words = String(name || '').replace(/\b(LLC|L\.L\.C\.|Inc|LP|Ltd|Co)\b\.?/gi, '').trim().split(/\s+/);
    var letters = words.filter(function (w) { return /^[A-Za-z]/.test(w); })
      .map(function (w) { return w[0].toUpperCase(); }).join('');
    var num = (String(name || '').match(/\b(\d+)\b/) || [])[1] || '';
    var code = (letters.slice(0, 4) + num).trim();
    return code && code.length > 1 ? '<span class="rp-code">' + escS(code) + '</span>' : '';
  }

  function flagChip(r) {
    if (!r.flags) return '<span class="rp-dim">' + DASH + '</span>';
    var bits = [];
    if (r.flag_dscr) bits.push(r.flag_dscr + ' DSCR');
    if (r.flag_occ) bits.push(r.flag_occ + ' occupancy');
    if (r.flag_noi) bits.push(r.flag_noi + ' NOI');
    if (r.flag_maturity) bits.push(r.flag_maturity + ' maturing');
    if (r.flag_no_t12) bits.push(r.flag_no_t12 + ' no T12');
    return '<span class="rp-flag" title="' + escS(bits.join(' · ')) + '">' + r.flags + '</span>';
  }

  /* ---- D1 Overview --------------------------------------------------------- */
  function overviewTab(d, check) {
    var p = d.property || {};
    var h = [];
    if (check && window.PortalSetup) h.push(PortalSetup.checklistHtml(check));

    h.push('<h4 class="rp-h4">Needs attention</h4>');
    if (!d.flags || !d.flags.length) {
      h.push('<div class="rp-ok-box">Nothing needs attention.</div>');
    } else {
      h.push('<ul class="rp-flags">' + d.flags.map(function (f) {
        return '<li class="rp-flag-' + escS(f.level) + '"><span class="rp-flag-dot"></span>' + escS(f.text) + '</li>';
      }).join('') + '</ul>');
    }

    var groups = [
      ['Ownership', [
        ['Managing entity', p.managing_entity_name], ['Owner LLC', p.entity_name],
        ['Property manager', p.pm_company], ['Ownership status', label(p.ownership_status)],
        ['Report source', p.source_system ? label(p.source_system) : null],
      ]],
      ['Physical', [
        ['Address', p.street], ['City', p.city], ['State', p.state], ['ZIP', p.zip],
        ['Asset type', p.asset_type], ['Units', intf(p.units)],
        ['Units source', p.units_source ? label(p.units_source) : null], ['Year built', p.year_built],
      ]],
      ['Acquisition and value', [
        ['Purchase price', money$(p.purchase_price)], ['Purchase date', dateOnly(p.purchase_date)],
        ['Value on file', money$(p.value_on_file)], ['Value as of', dateOnly(p.value_as_of)],
        ['Debt', money$(p.debt)], ['LTV', pct(p.ltv)],
        ['Next maturity', dateOnly(p.next_maturity)],
      ]],
    ];

    h.push('<div class="rp-bar"><label class="sv-chk' + (S.showEmpty ? ' on' : '') +
      '" id="rpShowEmpty">Show empty fields</label></div>');
    h.push('<div class="rp-cols">');
    groups.forEach(function (g) {
      var rows = g[1].filter(function (r) {
        return S.showEmpty || (r[1] !== null && r[1] !== undefined && r[1] !== '' && r[1] !== DASH);
      });
      if (!rows.length) return;
      h.push('<div class="rp-col"><h5 class="rp-h5">' + escS(g[0]) + '</h5><table class="rp-tbl rp-kv"><tbody>' +
        rows.map(function (r) {
          var v = (r[1] === null || r[1] === undefined || r[1] === '') ? DASH : r[1];
          return '<tr><td>' + escS(r[0]) + '</td><td class="r">' + escS(String(v)) + '</td></tr>';
        }).join('') + '</tbody></table></div>');
    });
    h.push('</div>');
    return h.join('');
  }

  /* ---- D11 Documents ------------------------------------------------------- */
  function documentsTab(d) {
    var docs = d.documents || [];
    if (!docs.length) return '<div class="rp-empty">No documents are linked to this property.</div>';
    var h = ['<div class="rp-scroll"><table class="rp-tbl"><thead><tr>' +
      '<th>File</th><th>Kind</th><th class="r">Size</th><th>Added</th><th>Path</th>' +
      '</tr></thead><tbody>'];
    docs.forEach(function (x) {
      var kb = isNum(x.file_size_bytes) ? (Number(x.file_size_bytes) / 1024) : null;
      h.push('<tr><td>' + escS(x.file_name || DASH) + '</td>' +
        '<td>' + (x.report_kind ? '<span class="rp-dbx on">' + escS(x.report_kind) + '</span>' : '<span class="rp-dim">' + DASH + '</span>') + '</td>' +
        '<td class="r">' + (kb === null ? DASH : (kb > 1024 ? (kb / 1024).toFixed(1) + ' MB' : kb.toFixed(0) + ' KB')) + '</td>' +
        '<td>' + dateOnly(x.created_at) + '</td>' +
        '<td class="rp-dim rp-path">' + escS(x.storage_path || DASH) + '</td></tr>');
    });
    h.push('</tbody></table></div>');
    return h.join('');
  }

  /* ---- shared chrome ------------------------------------------------------- */
  function densityBar(countText) {
    return '<div class="rp-bar">' +
      (countText ? '<span class="rp-count">' + escS(countText) + '</span>' : '') +
      '<span class="rp-spacer"></span>' +
      '<span class="rp-lbl">Density</span>' +
      '<button class="rp-btn' + (S.density === 'comfortable' ? ' on' : '') + '" data-density="comfortable">Comfortable</button>' +
      '<button class="rp-btn' + (S.density === 'compact' ? ' on' : '') + '" data-density="compact">Compact</button>' +
      '</div>';
  }

  var MONTH_NAMES = MONTHS;
  function periodBar(years) {
    var ys = (years && years.length) ? years : [S.year];
    var h = ['<div class="rp-period">'];
    h.push('<span class="rp-lbl">Year</span><select class="rp-inp" id="rpYear">' +
      ys.map(function (y) { return '<option value="' + y + '"' + (y === S.year ? ' selected' : '') + '>' + y + '</option>'; }).join('') +
      '</select>');
    h.push('<span class="rp-lbl">From</span><select class="rp-inp" id="rpFrom">' +
      MONTH_NAMES.map(function (m, i) {
        return '<option value="' + (i + 1) + '"' + (i + 1 === S.fromMonth ? ' selected' : '') + '>' + m + '</option>';
      }).join('') + '</select>');
    h.push('<span class="rp-lbl">To</span><select class="rp-inp" id="rpTo">' +
      MONTH_NAMES.map(function (m, i) {
        return '<option value="' + (i + 1) + '"' + (i + 1 === S.toMonth ? ' selected' : '') + '>' + m + '</option>';
      }).join('') + '</select>');
    h.push('</div>');
    return h.join('');
  }

  function shell(body, head) {
    /* No sidebar. The entity tree listed 106 legal entities as navigation,
       which is a directory rather than a route, and it took a third of the
       width from the tables that are the actual content. */
    var note = S.notice
      ? '<div class="rp-notice" role="status"><span>' + escS(S.notice) + '</span><button class="rp-btn rp-x" id="rpNoticeX" aria-label="Dismiss">' +
        '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="m4.5 4.5 7 7m0-7-7 7"/></svg></button></div>'
      : '';
    return '<div class="rp-full rp-' + S.density + '">' + crumbHtml() + note + (head || '') +
      '<div class="rp-body">' + body + '</div></div>';
  }

  function tabsHtml(list, active, attr, trailing) {
    return '<nav class="rp-tabs">' + list.map(function (t) {
      return '<button class="rp-tab' + (t[0] === active ? ' on' : '') + '" data-' + attr + '="' + escS(t[0]) + '">' +
        escS(t[1]) + '</button>';
    }).join('') + (trailing || '') + '</nav>';
  }

  var PORTFOLIO_TABS = [
    ['entities', 'Entities'], ['properties', 'Properties'],
    ['fees', 'Asset management fees'], ['views', 'Views'],
  ];
  var ENTITY_TABS = [['properties', 'Properties'], ['fees', 'Asset management fees']];

  var PTABS = [
    ['overview', 'Overview'], ['monthly', 'Monthly financials'], ['is', 'Income & expenses'],
    ['noi', 'Optimized NOI'], ['dscr', 'DSCR'], ['fee', 'Asset management fee'],
    ['rent', 'Rent roll'], ['bldg', 'Buildings & units'], ['capex', 'Capex'],
    ['val', 'Valuation'], ['docs', 'Documents'],
  ];

  /* key-figure row (A3), each with its source underneath */
  function keyFigures(p) {
    var dscr = isNum(p.trailing_dscr_mortgage) ? p.trailing_dscr_mortgage : p.trailing_dscr;
    var items = [
      ['Units', intf(p.units), p.units_source === 'rent_roll'
        ? 'Rent roll, ' + dateOnly(p.units_rent_roll_as_of)
        : (p.units_source ? label(p.units_source) + (p.units_disagree ? ', rent roll ' + intf(p.units_rent_roll) : '') : null)],
      ['Occupancy', pct(p.latest_occupancy), p.occupancy_as_of ? 'Rent roll, ' + dateOnly(p.occupancy_as_of) : null],
      ['NOI, trailing 12 mo', money$(p.t12_noi, { whole: true }), p.source_system ? label(p.source_system) + ' books' : null],
      ['Optimized NOI', money$(p.optimized_noi, { whole: true }), 'best 6 consecutive months × 2'],
      ['Net income', money$(p.t12_net_income, { whole: true }), 'after fee, debt service and capex'],
      ['Market value', money$(p.value_on_file, { whole: true }),
        p.value_on_file == null ? 'Not on file'
          : (p.value_as_of ? 'On file, ' + dateOnly(p.value_as_of) : 'On file, undated') +
            (p.value_is_stale ? ' (stale)' : '')],
      ['Debt', money$(p.debt, { whole: true }), null],
      ['LTV', pct(p.ltv), p.ltv_basis === 'on_file' ? 'against the value on file' : 'no value on file'],
      ['DSCR, mortgage', ratio(dscr), p.debt_service_interest_only ? 'Interest only, likely overstated' : 'Trailing 12 months'],
    ];
    return '<div class="rp-keys">' + items.map(function (i) {
      return '<div class="rp-key"><div class="k">' + escS(i[0]) + '</div>' +
        '<div class="v' + (i[0].indexOf('DSCR') === 0 ? ' ' + cls(dscr) : i[0] === 'NOI, trailing 12 mo' ? ' ' + noiCls(p.t12_noi) : '') + '">' + i[1] + '</div>' +
        '<div class="s">' + (i[2] ? escS(i[2]) : '&nbsp;') + '</div></div>';
    }).join('') + '</div>';
  }

  function propertyHead(p) {
    var tags = [];
    if (p.ownership_status) tags.push('<span class="rp-tagline">' + escS(label(p.ownership_status)) + '</span>');
    if (p.asset_type) tags.push('<span class="rp-tagline">' + escS(p.asset_type) + '</span>');
    if (p.source_system) tags.push('<span class="rp-src">' + escS(label(p.source_system)) + '</span>');
    /* Labelled fields rather than one line strung together with middle dots:
       four facts separated by dots read as a run-on, and the reader has to
       work out which name is the manager and which the owner. */
    var line = [p.street, p.city, p.state, p.zip].filter(Boolean).join(', ');
    var meta = [
      ['Address', line || null],
      ['Managing entity', p.managing_entity_name || 'None on file'],
      ['Owner LLC', p.entity_name || null],
      ['Property manager', p.pm_company || 'None on file'],
    ];
    return '<header class="rp-phead"><h2>' + escS(p.name || '') + ' ' + tags.join(' ') + '</h2>' +
      '<dl class="rp-meta">' + meta.map(function (m) {
        return '<div><dt>' + escS(m[0]) + '</dt><dd>' + escS(m[1] || DASH) + '</dd></div>';
      }).join('') + '</dl></header>' +
      keyFigures(p);
  }

  /* ---- paint --------------------------------------------------------------- */
  function paint() {
    if (!S.host) return;
    if (S.error) { S.host.innerHTML = shell('<div class="rp-err">' + escS(S.error) + '</div>'); wire(); return; }

    var body = '', head = '';

    if (S.level === 'property') {
      var d = S.cache.prop || {};
      var p = (d.overview && d.overview.property) || d.summary || {};
      var needsPeriod = ['monthly', 'is', 'capex', 'fee'].indexOf(S.ptab) >= 0;
      head = propertyHead(p) +
        tabsHtml(PTABS, S.ptab, 'ptab', needsPeriod ? periodBar(d.years) : '');
      switch (S.ptab) {
        case 'overview': body = d.overview ? overviewTab(d.overview, d.check) : skeleton(6, 3); break;
        case 'monthly':  body = d.monthly ? monthlyTab(d.monthly) : skeleton(12, 8); break;
        case 'is':       body = d.is ? isTab(d.is) : skeleton(12, 8); break;
        case 'noi':      body = d.noi ? noiTab(d.noi) : skeleton(10, 4); break;
        case 'dscr':     body = d.noi ? dscrTab(d.noi) : skeleton(10, 5); break;
        case 'fee':      body = d.fees ? feePropTab(d.fees, S.propertyId) : skeleton(4, 8); break;
        case 'rent':     body = d.units ? rentTab(d) : skeleton(10, 8); break;
        case 'bldg':     body = d.raw ? bldgTab(d.raw) : skeleton(6, 3); break;
        case 'capex':    body = d.is ? capexTab(d.is) : skeleton(8, 8); break;
        case 'val':      body = valTab(p); break;
        case 'docs':     body = d.docs ? documentsTab(d.docs) : skeleton(8, 5); break;
      }
    } else {
      var tabs = S.level === 'portfolio' ? PORTFOLIO_TABS : ENTITY_TABS;
      var adds = window.PortalSetup && PortalSetup.isAdmin() && S.tab !== 'views'
        ? '<span class="rp-adds"><button class="rp-btn" id="rpAddEntity">' + icon('plus') + 'Entity</button>' +
          '<button class="rp-btn" id="rpAddProperty">' + icon('plus') + 'Property</button></span>' : '';
      head = tabsHtml(tabs, S.tab, 'tab', adds);
      if (S.tab === 'views') {
        body = '<div id="rpViewsHost"></div>';
      } else if (S.tab === 'fees') {
        body = S.cache.fees ? feesTab(S.cache.fees) : skeleton(9, 10);
      } else if (S.tab === 'entities' && S.level === 'portfolio') {
        body = S.cache.entities ? entitiesTab(S.cache.entities) : skeleton(10, 9);
      } else {
        body = S.cache.summary ? propertiesTab(S.cache.summary) : skeleton(12, 10);
      }
    }
    S.host.innerHTML = shell(body, head);
    wire();

    /* The Views tab hosts the saved-views module inside the Properties
       section, so it is reachable without leaving the drill-down. */
    if (S.level !== 'property' && S.tab === 'views' && window.PortalViews) {
      PortalViews.mount(S.host.querySelector('#rpViewsHost'));
    }
  }

  /* ---- wiring: .onclick, never addEventListener ---------------------------- */
  function wire() {
    var root = S.host;
    if (!root) return;
    var plain = function (ev) {
      return !(ev && (ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.button === 1));
    };

    root.querySelectorAll('[data-crumb]').forEach(function (b) {
      b.onclick = function () {
        if (b.getAttribute('data-crumb') === 'portfolio') goPortfolio();
        else goEntity(S.entityId, S.entityName, 'properties');
      };
    });
    root.querySelectorAll('[data-ent]').forEach(function (b) {
      b.onclick = function (ev) {
        if (!plain(ev)) return;
        if (ev && ev.preventDefault) ev.preventDefault();
        goEntity(b.getAttribute('data-ent') || null, b.getAttribute('data-entname'), 'properties');
      };
    });
    root.querySelectorAll('[data-prop]').forEach(function (b) {
      b.onclick = function (ev) {
        if (!plain(ev)) return;
        if (ev && ev.preventDefault) ev.preventDefault();
        goProperty(b.getAttribute('data-prop'));
      };
    });
    root.querySelectorAll('[data-tab]').forEach(function (b) {
      b.onclick = function () { S.tab = b.getAttribute('data-tab'); pushUrl(); load(); };
    });
    root.querySelectorAll('[data-ptab]').forEach(function (b) {
      b.onclick = function () { S.ptab = b.getAttribute('data-ptab'); pushUrl(); load(); };
    });
    root.querySelectorAll('[data-density]').forEach(function (b) {
      b.onclick = function () { S.density = b.getAttribute('data-density'); paint(); };
    });

    var se = root.querySelector('#rpShowEmpty');
    if (se) se.onclick = function () { S.showEmpty = !S.showEmpty; paint(); };
    var su = root.querySelector('#rpShowUnavailable');
    if (su) su.onclick = function () { S.showUnavailable = !S.showUnavailable; paint(); };

    /* period */
    var y = root.querySelector('#rpYear');
    if (y) y.onchange = function () { S.year = Number(y.value); dropPeriodCaches(); pushUrl(); load(); };
    var fm = root.querySelector('#rpFrom');
    if (fm) fm.onchange = function () { S.fromMonth = Number(fm.value); pushUrl(); paint(); };
    var tm = root.querySelector('#rpTo');
    if (tm) tm.onchange = function () { S.toMonth = Number(tm.value); pushUrl(); paint(); };
    var ra = root.querySelector('#rpAsOf');
    if (ra) ra.onchange = function () {
      S.rentAsOf = ra.value;
      if (S.cache.prop) S.cache.prop.units = null;
      load();
    };

    /* list filters, which repaint only the table so the input keeps focus */
    function repaintTable() {
      if (!S.cache.summary) { paint(); return; }
      var host = S.host.querySelector('#rpTblHost');
      if (!host) { paint(); return; }
      var tmp = document.createElement('div');
      tmp.innerHTML = propertiesTab(S.cache.summary);
      var fresh = tmp.querySelector('#rpTblHost');
      if (!fresh) { paint(); return; }
      host.innerHTML = fresh.innerHTML;
      var cnt = S.host.querySelector('.rp-count'), vis = tmp.querySelector('.rp-count');
      if (cnt && vis) cnt.textContent = vis.textContent;
      S.host.querySelectorAll('[data-prop]').forEach(function (b) {
        b.onclick = function (ev) {
          if (!plain(ev)) return;
          if (ev && ev.preventDefault) ev.preventDefault();
          goProperty(b.getAttribute('data-prop'));
        };
      });
    }
    var s = root.querySelector('#rpSearch');
    if (s) s.oninput = function () { S.search = s.value; repaintTable(); };
    var st = root.querySelector('#rpStatus');
    if (st) st.onchange = function () { S.status = st.value; repaintTable(); };
    var wr = root.querySelector('#rpWithReports');
    if (wr) wr.onclick = function () { S.withReports = !S.withReports; paint(); };
    var sr = root.querySelector('#rpSource');
    if (sr) sr.onchange = function () { S.source = sr.value; repaintTable(); };

    root.querySelectorAll('[data-fgroup]').forEach(function (b) {
      b.onclick = function () {
        var g = b.getAttribute('data-fgroup');
        S.collapsed[g] = !S.collapsed[g];
        paint();
      };
    });

    /* what-if, deferred past blur - `change` fires DURING blur and paint()
       replaces innerHTML, which removes the node the browser is blurring */
    function repaintSoon() { setTimeout(paint, 0); }
    function num(sel, key) {
      var e = root.querySelector(sel);
      if (!e) return;
      e.onchange = function () {
        S.whatif[key] = e.value === '' ? null : Number(e.value);
        S.whatifTouched = true; repaintSoon();
      };
    }
    num('#rpCap', 'capRatePct'); num('#rpReq', 'requiredDscr'); num('#rpRate', 'newRatePct');
    num('#rpAmort', 'amortYears'); num('#rpBal', 'loanBalance'); num('#rpAds', 'annualDebtService');
    ['#rpReset', '#rpReset2'].forEach(function (sel) {
      var e = root.querySelector(sel);
      if (e) e.onclick = function () { reset(); repaintSoon(); };
    });

    /* section H: adding records. The forms live in portal-setup.js. */
    var nx = root.querySelector('#rpNoticeX');
    if (nx) nx.onclick = function () { S.notice = null; paint(); };
    var ae = root.querySelector('#rpAddEntity');
    if (ae) ae.onclick = function () { PortalSetup.open('entity', {}, added); };
    var ap = root.querySelector('#rpAddProperty');
    if (ap) ap.onclick = function () { PortalSetup.open('property', {}, added); };
    var ab = root.querySelector('#rpAddBuilding');
    if (ab) ab.onclick = function () {
      var p = (S.cache.prop && (S.cache.prop.summary || {})) || {};
      PortalSetup.open('building', { propertyId: S.propertyId, propertyName: p.name }, added);
    };

    var ex = root.querySelector('#rpExport');
    if (ex) ex.onclick = exportProperties;
    var fx = root.querySelector('#rpFeeExport');
    if (fx) fx.onclick = exportFees;
  }

  /* After a record is added: drop what it changes, then land where it can be
     seen. A new property opens on its Overview, where the setup checklist
     says what is still missing. */
  function added(kind, b) {
    if (kind === 'property') {
      S.cache = {}; S.tree = null;
      S.notice = b.property.name + ' added.' + (b.property.owner ? ' New owner LLC: ' + b.property.owner.name + '.' : '');
      goProperty(b.property.id);
    } else if (kind === 'building') {
      if (S.cache.prop) { S.cache.prop.raw = null; S.cache.prop.overview = null; S.cache.prop.check = null; }
      S.cache.summary = null; S.forceTree = true;
      S.notice = 'Building ' + b.building.unit_identifier + ' added.';
      load();
    } else {
      S.cache.entities = null; S.cache.summary = null;
      S.notice = b.entity.name + ' added. It appears under Entities once a property names it as manager, and in the owner pickers now.';
      load();
    }
  }

  function dropPeriodCaches() {
    if (S.cache.prop) { S.cache.prop.monthly = null; S.cache.prop.is = null; S.cache.prop.fees = null; }
    S.cache.fees = null;
  }

  /* ---- loading ------------------------------------------------------------
     A6. Every request carries the sequence number it was issued under, and a
     response whose number is no longer current is DROPPED.

     Without it, switching entity while a slower request was in flight let the
     older response land last and repaint the new screen with the old
     entity's rows - the bug where Kouri and Adventureland appeared under
     4813 Underwood Partners LLC. Nothing about the response says it is
     stale; only the sequence does.
  -------------------------------------------------------------------------- */
  function load() {
    var mine = ++S.seq;
    var fresh = function () { return mine === S.seq; };
    paint();
    S.error = null;

    var jobs = [];
    var entQ = S.level === 'entity'
      ? (S.entityId ? '?managing=' + encodeURIComponent(S.entityId) : '?managing=none') : '';

    if (!S.tree) {
      jobs.push(fetch('/api/portfolio', { cache: 'no-store' }).then(function (r) { return r.json(); })
        .then(function (b) { if (fresh()) S.tree = b; }));
    }

    if (S.level === 'property') {
      var d = S.cache.prop;
      if (!d || d._id !== S.propertyId) { S.cache.prop = d = { _id: S.propertyId }; }
      var pid = S.propertyId;
      var need = function (k, url, assign) {
        if (d[k]) return;
        jobs.push(api(url).then(function (b) { if (fresh() && S.propertyId === pid) assign(b); }));
      };
      need('overview', '/api/portfolio/' + pid + '/overview', function (b) {
        d.overview = b; d.summary = b.property;
        /* The breadcrumb names the property's OWN managing entity. Reached by
           a link, a reload or a new-property save there is no drill-down
           behind it, and it read "No managing entity" over a property whose
           manager is on file two lines below. */
        if (b.property) { S.entityId = b.property.managing_entity_id || null; S.entityName = b.property.managing_entity_name || null; }
      });
      if (S.ptab === 'monthly') need('monthly', '/api/portfolio/' + pid + '/monthly?year=' + S.year, function (b) { d.monthly = b; d.years = b.years; });
      if (S.ptab === 'is' || S.ptab === 'capex') need('is', '/api/portfolio/' + pid + '/income-statement', function (b) { d.is = b; });
      if (S.ptab === 'noi' || S.ptab === 'dscr') need('noi', '/api/portfolio/' + pid + '/noi-analysis', function (b) { d.noi = b; });
      if (S.ptab === 'fee') need('fees', '/api/am-fees?year=' + S.year, function (b) { d.fees = b; });
      if (S.ptab === 'rent') need('units', '/api/portfolio/' + pid + '/rent-roll' + (S.rentAsOf ? '?as_of=' + encodeURIComponent(S.rentAsOf) : ''),
        function (b) { d.units = b.units; d.rentSummary = b.rentSummary; d.asOfDates = b.asOfDates; d.asOf = b.asOf; });
      if (S.ptab === 'overview') need('check', '/api/portfolio-setup/property/' + pid + '/checklist', function (b) { d.check = b.items; });
      if (S.ptab === 'docs') need('docs', '/api/portfolio/' + pid + '/documents', function (b) { d.docs = b; });
      if ((S.ptab === 'bldg') && !d.raw) {
        var treeUrl = '/api/portfolio' + (S.forceTree ? '?force=1' : '');
        S.forceTree = false;
        jobs.push(fetch(treeUrl, { cache: 'no-store' }).then(function (r) { return r.json(); })
          .then(function (b) {
            if (!fresh() || S.propertyId !== pid) return;
            d.raw = (b.properties || []).filter(function (x) { return x.id === pid; })[0] || {};
          }));
      }
    } else if (S.tab === 'views') {
      /* the module loads itself */
    } else if (S.tab === 'fees') {
      var feeKey = S.level + '|' + (S.entityId || '') + '|' + S.year;
      if (!S.cache.fees || S.cache.feesKey !== feeKey) {
        jobs.push(api('/api/am-fees?year=' + S.year + (S.level === 'entity' && S.entityId ? '&managing=' + encodeURIComponent(S.entityId) : ''))
          .then(function (b) { if (!fresh()) return; S.cache.fees = b; S.cache.feesKey = feeKey; }));
      }
    } else if (S.tab === 'entities' && S.level === 'portfolio') {
      if (!S.cache.entities) {
        jobs.push(api('/api/portfolio/entities').then(function (b) { if (fresh()) S.cache.entities = b; }));
      }
    } else {
      var key = S.level + '|' + (S.entityId === null ? 'all' : S.entityId);
      if (!S.cache.summary || S.cache.summaryKey !== key) {
        jobs.push(api('/api/portfolio/summary' + (S.level === 'entity' ? entQ : ''))
          .then(function (b) { if (!fresh()) return; S.cache.summary = b; S.cache.summaryKey = key; }));
      }
    }

    Promise.all(jobs)
      .then(function () { if (fresh()) paint(); })
      .catch(function (e) { if (fresh()) { S.error = e.message || String(e); paint(); } });
  }

  /* ---- exports ------------------------------------------------------------- */
  function exportProperties() {
    var d = S.cache.summary || { rows: [] };
    var head = ['Property', 'Source', 'Managing entity', 'Owner LLC', 'Units', 'Units source',
                'Occupancy', 'Total income', 'Total expenses', 'NOI, trailing 12 mo', 'Optimized NOI',
                'Expense ratio', 'Net income', 'DSCR mortgage', 'DSCR all debt', 'PM company',
                'Ownership', 'T12 filed', 'T12 file', 'Rent roll filed', 'Rent roll file'];
    var body = visibleRows(d).map(function (r) {
      return [r.name, r.source_system, r.managing_entity_name, r.entity_name, r.units, r.units_source,
              r.latest_occupancy, r.t12_income, r.t12_expense, r.t12_noi, r.optimized_noi,
              r.expense_ratio, r.t12_net_income, dscrM(r), r.trailing_dscr_all_debt, r.pm_company,
              r.ownership_status, r.t12_in_dropbox ? 'yes' : 'no', r.t12_file_name || '',
              r.rent_roll_in_dropbox ? 'yes' : 'no', r.rent_roll_file_name || ''];
    });
    download('properties.csv', csv([head].concat(body)));
  }

  function exportFees() {
    var f = S.cache.fees || { rows: [] };
    var head = ['Manager', 'Fee row', 'Timing', 'Measure'].concat(MONTHS).concat(['Total']);
    var out = [head];
    (f.rows || []).forEach(function (r) {
      [['Expected', 'expected'], ['Received', 'received'], ['Variance', 'variance']].forEach(function (k) {
        var vals = [], t = 0, has = false;
        for (var m = 1; m <= 12; m++) {
          var v = r[k[1]][m];
          if (isNum(v)) { t += Number(v); has = true; }
          vals.push(isNum(v) ? v : '');
        }
        out.push([r.manager_group, r.label, r.payment_timing, k[0]].concat(vals).concat([has ? t : '']));
      });
    });
    download('am-fees-' + S.year + '.csv', csv(out));
  }

  /* ---- mount --------------------------------------------------------------- */
  var popBound = false;
  function mount(host) {
    S.host = host;
    if (!host) return;
    ensureUrlRead();
    if (!popBound) {
      /* bound ONCE. mount() runs on every navigation back to the section, and
         a listener added each time leaves N copies firing N reloads. */
      window.addEventListener('popstate', function () {
        if (!S.host || !document.body.contains(S.host)) return;
        readUrl(); load();
      });
      popBound = true;
    }
    paint();
    load();
    if (window.PortalSetup) PortalSetup.load().then(function () { if (PortalSetup.isAdmin() && S.host) paint(); });
  }

  function invalidate() {
    S.cache = {}; S.tree = null;
    if (S.host) load();
  }

  window.PortalReporting = { mount: mount, invalidate: invalidate, urlParams: urlParams, _state: S };
})();
