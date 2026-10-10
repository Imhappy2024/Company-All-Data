/* ===========================================================================
   portal-reporting.js — the Properties section (Phase 2), READ-ONLY.

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

  /* ---- state -------------------------------------------------------------- */
  var S = {
    host: null,
    tree: null,            /* /api/portfolio: entities + tree */
    scope: 'company',      /* company | entity | property */
    entityId: null,
    propertyId: null,
    tab: 'properties',     /* company/entity: properties | fees */
    ptab: 'monthly',       /* property page tab */
    year: new Date().getFullYear(),
    search: '',
    status: 'held',
    cache: {},
    busy: false,
    error: null,
    /* what-if inputs. Never saved, never sent - reload returns to defaults. */
    whatif: { capRatePct: 7, requiredDscr: 1.25, newRatePct: 6.5, amortYears: 30, loanBalance: null, annualDebtService: null },
    whatifTouched: false,
  };

  function reset() {
    S.whatif = { capRatePct: 7, requiredDscr: 1.25, newRatePct: 6.5, amortYears: 30, loanBalance: null, annualDebtService: null };
    S.whatifTouched = false;
  }

  /* ---- the left menu: folders only, never properties ----------------------
     The brief is explicit. A menu listing 170 properties is a directory, not
     navigation, and the entity page already lists them in a table that can
     be searched and sorted. */
  function entityChildren(id) {
    var out = [];
    (S.tree && S.tree.entities || []).forEach(function (e) {
      if ((e.parentId || null) === (id || null)) out.push(e);
    });
    return out.sort(function (a, b) { return String(a.name).localeCompare(String(b.name)); });
  }
  function entityById(id) {
    return (S.tree && S.tree.entities || []).filter(function (e) { return e.id === id; })[0] || null;
  }
  function propertyById(id) {
    return (S.tree && S.tree.properties || []).filter(function (p) { return p.id === id; })[0] || null;
  }
  function ancestry(entityId) {
    var out = [], guard = 0, e = entityById(entityId);
    while (e && guard++ < 50) { out.unshift(e); e = e.parentId ? entityById(e.parentId) : null; }
    return out;
  }

  function menuHtml() {
    var h = ['<div class="rp-menu">'];
    h.push('<button class="rp-mi' + (S.scope === 'company' ? ' on' : '') + '" data-go="company">' +
           '<span class="rp-mi-ic">▦</span>Company</button>');

    function walk(parentId, depth) {
      entityChildren(parentId).forEach(function (e) {
        var open = S.entityId === e.id ||
                   (S.scope === 'property' && ancestry(S.entityId).some(function (a) { return a.id === e.id; }));
        h.push('<button class="rp-mi' + (S.entityId === e.id && S.scope !== 'property' ? ' on' : '') +
               '" style="padding-left:' + (14 + depth * 14) + 'px" data-ent="' + escS(e.id) + '">' +
               '<span class="rp-mi-ic">▸</span>' + escS(e.name) + '</button>');
        if (open) walk(e.id, depth + 1);
        /* When a property is open, show ONLY that property, under its
           entity folder. Not the entity's other properties - the menu is
           not a list. */
        if (open && S.scope === 'property') {
          var p = propertyById(S.propertyId);
          if (p && p.entityId === e.id) {
            h.push('<button class="rp-mi on rp-mi-prop" style="padding-left:' + (14 + (depth + 1) * 14) + 'px">' +
                   '<span class="rp-mi-ic">▪</span>' + escS(p.name) + '</button>');
          }
        }
      });
    }
    walk(null, 1);
    h.push('</div>');
    return h.join('');
  }

  function crumbHtml() {
    var parts = ['<button data-go="company">Company</button>'];
    var chain = S.scope === 'property'
      ? ancestry(propertyById(S.propertyId) ? propertyById(S.propertyId).entityId : null)
      : ancestry(S.entityId);
    chain.forEach(function (e) {
      parts.push('<button data-ent="' + escS(e.id) + '">' + escS(e.name) + '</button>');
    });
    if (S.scope === 'property') {
      var p = propertyById(S.propertyId);
      parts.push('<span>' + escS(p ? p.name : '') + '</span>');
    }
    return '<nav class="rp-crumb">' + parts.join('<i>/</i>') + '</nav>';
  }

  /* ---- company / entity: the Properties tab -------------------------------- */
  /* The mortgage DSCR on the list prefers the BOOKS' own twelve months and
     falls back to the loan-record ratio, so a property whose debt service
     comes from its books is not blank here just because its loan record has
     no annual figure. */
  function dscrM(r) {
    return isNum(r.trailing_dscr_mortgage) ? r.trailing_dscr_mortgage : r.trailing_dscr;
  }
  function cls(v) {
    return !isNum(v) ? '' : Number(v) < 1 ? 'rp-bad' : Number(v) < 1.25 ? 'rp-warn' : '';
  }

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
      noi: isNum(row.t12_noi) && Number(row.t12_noi) < 0 ? 'rp-bad' : '',
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

  function propertiesTab(data) {
    var rows = (data.rows || []).filter(function (r) {
      if (S.status && r.ownership_status !== S.status) return false;
      if (S.search) {
        var q = S.search.toLowerCase();
        if (String(r.name || '').toLowerCase().indexOf(q) < 0 &&
            String(r.pm_company || '').toLowerCase().indexOf(q) < 0 &&
            String(r.entity_name || '').toLowerCase().indexOf(q) < 0) return false;
      }
      return true;
    });

    var statuses = {};
    (data.rows || []).forEach(function (r) { if (r.ownership_status) statuses[r.ownership_status] = 1; });

    var h = [];
    h.push('<div class="rp-bar">' +
      '<input class="rp-inp" id="rpSearch" placeholder="Search property, entity or PM" value="' + escS(S.search) + '">' +
      '<select class="rp-inp" id="rpStatus">' +
      Object.keys(statuses).sort().map(function (s) {
        return '<option value="' + escS(s) + '"' + (S.status === s ? ' selected' : '') + '>' + escS(s) + '</option>';
      }).join('') +
      '<option value=""' + (S.status === '' ? ' selected' : '') + '>all</option></select>' +
      '<span class="rp-count">' + rows.length + ' of ' + (data.rows || []).length + '</span>' +
      '<button class="rp-btn" id="rpExport">Export CSV</button>' +
      '</div>');

    h.push('<div id="rpTblHost"><div class="rp-scroll"><table class="rp-tbl"><thead><tr>' +
      '<th>Property</th><th class="r">Units</th><th class="r">Occupancy</th>' +
      '<th class="r">Total income</th><th class="r">Total expenses</th>' +
      '<th class="r">NOI, trailing 12 mo</th><th class="r">Optimized NOI</th>' +
      '<th class="r">Expense ratio</th><th class="r">Net income</th>' +
      '<th class="r">DSCR, mortgage</th><th class="r">DSCR, all debt</th>' +
      '<th>PM company</th><th>In Dropbox</th></tr></thead><tbody>');

    rows.forEach(function (r) {
      var c = colourClass(r);
      /* The name is an <a>, not a bold <td>. The whole row has been clickable
         since this shipped, but nothing on screen said so - no colour, no
         underline, no cursor - so the eleven property tabs behind it were
         effectively undiscoverable. An affordance is not decoration here; it
         is the only route to Monthly financials, Optimized NOI and DSCR.

         href is a real deep link so the row can be opened in a new tab and
         pasted to someone; the handler preventDefault()s the plain click. */
      h.push('<tr class="rp-row" data-prop="' + escS(r.id) + '">' +
        '<td><a class="rp-link" href="#brand=leavenwealth&view=properties&property=' + escS(r.id) + '">' +
        escS(r.name) + '</a>' + (r.source_system ? '<span class="rp-src">' + escS(r.source_system) + '</span>' : '') + '</td>' +
        '<td class="r">' + intf(r.units) + unitsNote(r) + '</td>' +
        '<td class="r ' + c.occ + '">' + pct(r.latest_occupancy) + '</td>' +
        '<td class="r">' + money$(r.t12_income, { whole: true }) + '</td>' +
        '<td class="r">' + money$(r.t12_expense, { whole: true }) + '</td>' +
        '<td class="r ' + c.noi + '">' + money$(r.t12_noi, { whole: true }) + '</td>' +
        '<td class="r">' + money$(r.optimized_noi, { whole: true }) + '</td>' +
        '<td class="r ' + c.exp + '">' + pct(r.expense_ratio) + '</td>' +
        '<td class="r ' + c.net + '">' + money$(r.t12_net_income, { whole: true }) + '</td>' +
        '<td class="r ' + c.dscr + '">' + ratio(dscrM(r)) +
          (r.debt_service_interest_only ? ' ' + TAG_INTEREST_ONLY() : '') + '</td>' +
        '<td class="r ' + cls(r.trailing_dscr_all_debt) + '">' + ratio(r.trailing_dscr_all_debt) + '</td>' +
        '<td>' + escS(r.pm_company || DASH) + '</td>' +
        '<td class="rp-dim">' + dropboxCell(r) + '</td></tr>');
    });

    var t = data.totals || {};
    h.push('</tbody><tfoot><tr>' +
      '<td><b>Total</b> <span class="rp-dim">' + (t.properties || 0) + ' held</span></td>' +
      '<td class="r">' + intf(t.units) + '</td><td class="r">' + DASH + '</td>' +
      '<td class="r">' + money$(t.t12_income, { whole: true }) + '</td>' +
      '<td class="r">' + money$(t.t12_expense, { whole: true }) + '</td>' +
      '<td class="r' + neg(t.t12_noi) + '">' + money$(t.t12_noi, { whole: true }) + '</td>' +
      '<td class="r">' + money$(t.optimized_noi, { whole: true }) + '</td>' +
      '<td class="r">' + pct(t.expense_ratio) + '</td>' +
      '<td class="r' + neg(t.t12_net_income) + '">' + money$(t.t12_net_income, { whole: true }) + '</td>' +
      '<td class="r">' + ratio(t.dscr) + '</td><td class="r">' + DASH + '</td>' +
      '<td></td><td></td></tr></tfoot></table></div></div>');

    return h.join('');
  }

  /* ---- company / entity: the Asset management fees tab --------------------- */
  function feesTab(fees) {
    var h = [];
    h.push('<div class="rp-bar">' +
      '<label class="rp-lbl">Year</label>' +
      '<select class="rp-inp" id="rpFeeYear">' +
      [S.year - 2, S.year - 1, S.year, S.year + 1].map(function (y) {
        return '<option value="' + y + '"' + (y === S.year ? ' selected' : '') + '>' + y + '</option>';
      }).join('') + '</select>' +
      '<span class="rp-dim">Received is display-only in this release.</span>' +
      '<button class="rp-btn" id="rpFeeExport">Export CSV</button></div>');

    if (!fees.groups || !fees.groups.length) {
      h.push('<div class="rp-empty">No fee schedule for ' + S.year + '.</div>');
      return h.join('');
    }

    h.push('<div class="rp-scroll"><table class="rp-tbl rp-fees"><thead><tr>' +
      '<th>Fee row</th><th></th>' +
      MONTHS.map(function (m) { return '<th class="r">' + m + '</th>'; }).join('') +
      '<th class="r">Total</th></tr></thead>');

    var gt = { expected: {}, received: {}, variance: {} };

    fees.groups.forEach(function (g) {
      h.push('<tbody class="rp-grp"><tr class="rp-grph"><td colspan="15">' +
        '<b>' + escS(g.manager_group) + '</b>' +
        '<span class="rp-chip">' + (g.payment_timing === 'same_month' ? 'same month' : 'following month') + '</span>' +
        (g.timing_confirmed ? '' : '<span class="rp-chip rp-chip-warn">timing not confirmed</span>') +
        '</td></tr>');

      g.rows.forEach(function (r) {
        var fee = r.fee_type === 'fixed' ? money$(r.fixed_amount) + ' fixed' : (isNum(r.fee_pct) ? r.fee_pct + '%' : DASH);
        var names = (r.properties || []).map(function (p) { return p.property_name; }).join(', ');
        h.push('<tr class="rp-feehead"><td rowspan="3"><b>' + escS(r.label) + '</b>' +
          '<div class="rp-dim">' + escS(fee) + (names ? ' · ' + escS(names) : '') + '</div>' +
          (r.fee_note ? '<div class="rp-note">' + escS(r.fee_note) + '</div>' : '') +
          '</td><td class="rp-rl">Expected</td>');
        var te = 0, tr = 0, tv = 0, he = false, hr = false, hv = false;
        for (var m = 1; m <= 12; m++) {
          var v = r.expected[m];
          if (isNum(v)) { te += Number(v); he = true; gt.expected[m] = (gt.expected[m] || 0) + Number(v); }
          h.push('<td class="r">' + money(v) + '</td>');
        }
        h.push('<td class="r"><b>' + (he ? money(te) : DASH) + '</b></td></tr>');

        h.push('<tr><td class="rp-rl">Received</td>');
        for (var m2 = 1; m2 <= 12; m2++) {
          var rv = r.received[m2];
          if (isNum(rv)) { tr += Number(rv); hr = true; gt.received[m2] = (gt.received[m2] || 0) + Number(rv); }
          var src = r.received_source[m2];
          h.push('<td class="r' + (src === 'books' ? ' rp-books' : '') + '"' +
                 (src ? ' title="from ' + escS(src) + '"' : '') + '>' + money(rv) + '</td>');
        }
        h.push('<td class="r"><b>' + (hr ? money(tr) : DASH) + '</b></td></tr>');

        h.push('<tr class="rp-varrow"><td class="rp-rl">Variance</td>');
        for (var m3 = 1; m3 <= 12; m3++) {
          var vv = r.variance[m3];
          if (isNum(vv)) { tv += Number(vv); hv = true; gt.variance[m3] = (gt.variance[m3] || 0) + Number(vv); }
          var cls = !isNum(vv) ? '' : Number(vv) < 0 ? ' rp-vneg' : Number(vv) > 0 ? ' rp-vpos' : ' rp-vzero';
          h.push('<td class="r' + cls + '">' + money(vv) + '</td>');
        }
        h.push('<td class="r"><b>' + (hv ? money(tv) : DASH) + '</b></td></tr>');
      });
      h.push('</tbody>');
    });

    function totalRow(label, map, cls) {
      var t = 0, has = false, cells = [];
      for (var m = 1; m <= 12; m++) {
        var v = map[m];
        if (isNum(v)) { t += Number(v); has = true; }
        var c = cls === 'var' && isNum(v) ? (Number(v) < 0 ? ' rp-vneg' : Number(v) > 0 ? ' rp-vpos' : ' rp-vzero') : '';
        cells.push('<td class="r' + c + '">' + money(v) + '</td>');
      }
      return '<tr><td class="rp-rl">' + label + '</td>' + cells.join('') +
             '<td class="r"><b>' + (has ? money(t) : DASH) + '</b></td></tr>';
    }
    h.push('<tfoot><tr class="rp-grph"><td colspan="15"><b>All properties</b></td></tr>' +
      '<tr><td rowspan="3"></td>' + totalRow('Expected', gt.expected).slice(4) +
      totalRow('Received', gt.received) + totalRow('Variance', gt.variance, 'var') + '</tfoot>');
    h.push('</table></div>');
    return h.join('');
  }

  /* ---- the property page --------------------------------------------------- */
  var PTABS = [
    ['monthly', 'Monthly financials'], ['is', 'Income & expenses'],
    ['noi', 'Optimized NOI'], ['dscr', 'DSCR'], ['fee', 'Asset management fee'],
    ['totals', 'Totals'], ['rent', 'Rent roll'], ['bldg', 'Buildings & units'],
    ['capex', 'Capex'], ['val', 'Valuation'], ['details', 'Details'],
  ];

  /* 2.4 Monthly financials, the Excel sheet */
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
    ['Other Interest (counted as debt)', 'recurring_other_interest', money, 0],
    ['Debt Service, all debt', 'debt_service_all', money, 1],
    ['Loan Proceeds', 'loan_proceeds', money, 0],
    ['DSCR, mortgage', 'dscr', ratio, 1],
    ['DSCR, all debt', 'dscr_all_debt', ratio, 1],
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
    var h = [];
    h.push('<div class="rp-bar"><label class="rp-lbl">Year</label>' +
      '<select class="rp-inp" id="rpYear">' +
      (d.years && d.years.length ? d.years : [S.year]).map(function (y) {
        return '<option value="' + y + '"' + (y === d.year ? ' selected' : '') + '>' + y + '</option>';
      }).join('') + '</select></div>');

    var dsNote = d.debtServiceSource === 'income_statement'
      ? 'Debt service is this property’s own interest plus principal from its books.'
      : d.debtServiceSource === 'loan_record'
      ? 'This property’s books carry no principal line, so debt service is the loan record’s annual figure divided by 12.'
      : d.debtServiceSource === 'interest_only_books'
      /* Doral: interest every month, no principal line and no loan record.
         Interest alone UNDERSTATES the real payment, so the screen says so
         rather than presenting the figure as complete. */
      ? '<b>Interest only, from the books.</b> This property books interest but no principal, and has no loan record, ' +
        'so debt service here is the interest alone and is lower than the real payment. DSCR is correspondingly optimistic.'
      : 'No debt service could be established for this property.';

    h.push('<p class="rp-note rp-src-note">Source: T12 export, <b>' + escS(d.basis) + '</b> basis. ' +
      dsNote +
      ' Cash flow is NOI less the asset management fee, debt service and capital expense. ' +
      'Loan proceeds are money arriving, not a cost, and are shown separately rather than netted against anything. ' +
      'A month with no export shows ' + DASH + ', which means not available rather than zero.</p>');

    /* the proceeds label, when there is one - 4,326,000.00 with no line name
       beside it invites the question the note answers */
    var notes = [];
    for (var pm = 1; pm <= 12; pm++) {
      var rec0 = d.byMonth[d.year + '-' + String(pm).padStart(2, '0')];
      if (rec0 && rec0.loan_proceeds_note) notes.push(MONTHS[pm - 1] + ': ' + rec0.loan_proceeds_note);
    }
    if (notes.length) h.push('<p class="rp-note">Loan proceeds lines — ' + escS(notes.join(' · ')) + '</p>');

    var oi = [];
    for (var om = 1; om <= 12; om++) {
      var rec1 = d.byMonth[d.year + '-' + String(om).padStart(2, '0')];
      if (rec1 && isNum(rec1.other_interest)) oi.push(Number(rec1.other_interest));
    }
    if (oi.length) {
      h.push('<p class="rp-note">This property also books <b>' +
        money$(oi.reduce(function (a, b) { return a + b; }, 0)) + '</b> of other interest in ' + d.year +
        ', which is <b>not</b> included in debt service — it sits alongside a mortgage interest line, so it is other debt.</p>');
    }

    h.push('<div class="rp-scroll"><table class="rp-tbl rp-monthly"><thead><tr><th>Line</th>' +
      MONTHS.map(function (m) { return '<th class="r">' + m + '</th>'; }).join('') +
      '<th class="r">Average</th><th class="r">Total</th></tr></thead><tbody>');

    MROWS.forEach(function (row) {
      var label = row[0], key = row[1], fmt = row[2], bold = row[3];
      var vals = [], cells = [];
      for (var m = 1; m <= 12; m++) {
        var k = d.year + '-' + String(m).padStart(2, '0');
        var rec = d.byMonth[k];
        var v = rec ? derived(rec, key) : null;
        if (isNum(v)) vals.push(Number(v));
        var cls = (fmt === money && isNum(v) && Number(v) < 0) ? ' rp-neg'
                : (key === 'noi' && isNum(v)) ? (Number(v) < 0 ? ' rp-neg' : ' rp-pos') : '';
        cells.push('<td class="r' + cls + '">' + fmt(v) + '</td>');
      }
      var sum = vals.length ? vals.reduce(function (a, b) { return a + b; }, 0) : null;
      var avg = vals.length ? sum / vals.length : null;
      /* a ratio and an occupancy do not SUM; their total column is the
         average, and the units row is the latest rather than either. */
      var isRate = fmt === pct || fmt === ratio;
      var totalV = isRate ? avg : (key === 'units' ? (vals.length ? vals[vals.length - 1] : null) : sum);
      cells.push('<td class="r">' + fmt(avg) + '</td>');
      cells.push('<td class="r"><b>' + fmt(totalV) + '</b></td>');
      h.push('<tr class="' + (bold ? 'rp-strong' : '') + '"><td>' + escS(label) + '</td>' + cells.join('') + '</tr>');
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
      '<th class="r">Annual NOI</th><th class="r">Value at ' + cap.toFixed(1) + '% cap</th>' +
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
      h.push('<p class="rp-note">Debt service here is this property’s own, from its income statement — ' +
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
    var h = ['<p class="rp-note">As of <b>' + dateOnly(s.as_of_date) + '</b> · ' +
      intf(s.units) + ' units · ' + intf(s.occupied) + ' occupied · ' + intf(s.vacant) + ' vacant · ' +
      'rent ' + money$(s.rent_total) + ' against market ' + money$(s.market_rent_total) +
      ' · loss to lease ' + money$(s.loss_to_lease) + '</p>'];
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

  function bldgTab(raw) {
    var b = (raw && raw.buildings) || [];
    if (!b.length) return '<div class="rp-empty">No building records for this property.</div>';
    /* residential first, then a NATURAL comparator: plain string order puts
       "Building 10" before "Building 2". */
    var sorted = b.slice().sort(function (x, y) {
      return String(x.name || x.unit_identifier || '').localeCompare(
        String(y.name || y.unit_identifier || ''), undefined, { numeric: true, sensitivity: 'base' });
    });
    return '<div class="rp-scroll"><table class="rp-tbl"><thead><tr><th>Building</th>' +
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

  function shell(body, tabs) {
    return '<div class="rp-wrap2"><aside class="rp-side">' + menuHtml() + '</aside>' +
      '<section class="rp-main">' + crumbHtml() +
      (tabs || '') +
      '<div class="rp-body">' + body + '</div></section></div>';
  }

  function tabsHtml(list, active, attr) {
    return '<nav class="rp-tabs">' + list.map(function (t) {
      return '<button class="rp-tab' + (t[0] === active ? ' on' : '') + '" data-' + attr + '="' + escS(t[0]) + '">' +
        escS(t[1]) + '</button>';
    }).join('') + '</nav>';
  }

  function paint() {
    if (!S.host) return;
    if (S.error) {
      S.host.innerHTML = shell('<div class="rp-err">' + escS(S.error) + '</div>', '');
      wire();
      return;
    }
    if (S.busy && !S.cache.current) {
      /* A skeleton, not a blank page and not the word "Loading". The shape of
         what is coming is itself information: the reader knows a table is
         arriving and roughly how wide, so the wait reads as a wait rather
         than as an empty screen. */
      S.host.innerHTML = shell(skeleton(), '');
      wire();
      return;
    }

    var body = '', tabs = '';
    if (S.scope === 'property') {
      var d = S.cache.prop || {};
      var prop = d.summary || {};
      tabs = '<header class="rp-phead"><h2>' + escS(prop.name || '') + '</h2>' +
        '<div class="rp-dim">' + escS(prop.entity_name || DASH) + ' · ' +
        escS(prop.source_system || DASH) + ' · ' + escS(prop.pm_company || DASH) + '</div></header>' +
        tabsHtml(PTABS, S.ptab, 'ptab');
      switch (S.ptab) {
        case 'monthly': body = d.monthly ? monthlyTab(d.monthly) : skeleton(8, 6); break;
        case 'is':      body = d.is ? isTab(d.is) : skeleton(8, 6); break;
        case 'noi':     body = d.noi ? noiTab(d.noi) : skeleton(8, 6); break;
        case 'dscr':    body = d.noi ? dscrTab(d.noi) : skeleton(8, 6); break;
        case 'fee':     body = d.fees ? feePropTab(d.fees, S.propertyId) : skeleton(8, 6); break;
        case 'totals':  body = totalsTab(d, prop); break;
        case 'rent':    body = rentTab(d); break;
        case 'bldg':    body = bldgTab(d.raw); break;
        case 'capex':   body = d.is ? capexTab(d.is) : skeleton(8, 6); break;
        case 'val':     body = valTab(prop); break;
        case 'details': body = detailsTab(prop, d.raw); break;
      }
    } else {
      tabs = tabsHtml([['properties', 'Properties'], ['fees', 'Asset management fees']], S.tab, 'tab');
      if (S.tab === 'fees') body = S.cache.fees ? feesTab(S.cache.fees) : skeleton(8, 6);
      else body = S.cache.summary ? propertiesTab(S.cache.summary) : skeleton(8, 6);
    }
    S.host.innerHTML = shell(body, tabs);
    wire();
  }

  /* ---- wiring: .onclick, never addEventListener --------------------------- */
  function wire() {
    var root = S.host;
    if (!root) return;
    root.querySelectorAll('[data-go="company"]').forEach(function (b) {
      b.onclick = function () { S.scope = 'company'; S.entityId = null; S.propertyId = null; load(); };
    });
    root.querySelectorAll('[data-ent]').forEach(function (b) {
      b.onclick = function () { S.scope = 'entity'; S.entityId = b.getAttribute('data-ent'); S.propertyId = null; load(); };
    });
    root.querySelectorAll('[data-prop]').forEach(function (b) {
      b.onclick = function (ev) {
        /* The name carries a real href so it can be opened in a new tab;
           a plain click is handled here instead. Ctrl/cmd/middle click is
           left alone so "open in new tab" keeps working. */
        if (ev && (ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.button === 1)) return;
        if (ev && ev.preventDefault) ev.preventDefault();
        S.propertyId = b.getAttribute('data-prop');
        var p = propertyById(S.propertyId);
        S.entityId = p ? p.entityId : S.entityId;
        S.scope = 'property'; S.ptab = 'monthly'; reset(); load();
      };
    });
    root.querySelectorAll('[data-tab]').forEach(function (b) {
      b.onclick = function () { S.tab = b.getAttribute('data-tab'); load(); };
    });
    root.querySelectorAll('[data-ptab]').forEach(function (b) {
      b.onclick = function () { S.ptab = b.getAttribute('data-ptab'); load(); };
    });

    /* Search repaints ONLY the table, not the section.
       paint() replaces host.innerHTML, which removes the focused input
       mid-keystroke; the browser fires blur against a node that is no longer
       in the tree and throws "The node to be removed is no longer a child of
       this node". Refocusing afterwards papered over the caret but not the
       error. Rebuilding just the rows leaves the input in place and needs no
       focus restoration at all. */
    function repaintTable() {
      var host = S.host.querySelector('#rpTblHost');
      if (!host || !S.cache.summary) { paint(); return; }
      var tmp = document.createElement('div');
      tmp.innerHTML = propertiesTab(S.cache.summary);
      var fresh = tmp.querySelector('#rpTblHost');
      if (fresh) host.innerHTML = fresh.innerHTML; else paint();
      var cnt = S.host.querySelector('.rp-count');
      var vis = tmp.querySelector('.rp-count');
      if (cnt && vis) cnt.textContent = vis.textContent;
      S.host.querySelectorAll('[data-prop]').forEach(function (b) {
        b.onclick = function (ev) {
          if (ev && (ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.button === 1)) return;
          if (ev && ev.preventDefault) ev.preventDefault();
          S.propertyId = b.getAttribute('data-prop');
          var p = propertyById(S.propertyId);
          S.entityId = p ? p.entityId : S.entityId;
          S.scope = 'property'; S.ptab = 'monthly'; reset(); load();
        };
      });
    }
    var s = root.querySelector('#rpSearch');
    if (s) s.oninput = function () { S.search = s.value; repaintTable(); };
    var st = root.querySelector('#rpStatus');
    if (st) st.onchange = function () { S.status = st.value; repaintTable(); };

    var y = root.querySelector('#rpYear');
    if (y) y.onchange = function () { S.year = Number(y.value); S.cache.prop = Object.assign({}, S.cache.prop, { monthly: null }); load(); };
    ['#rpFeeYear', '#rpFeeYear2'].forEach(function (sel) {
      var e = root.querySelector(sel);
      if (e) e.onchange = function () { S.year = Number(e.value); S.cache.fees = null; load(); };
    });

    /* `change` on a text input fires DURING blur, and paint() replaces
       host.innerHTML - so the node the browser is mid-blur on is removed
       from under it and it throws "The node to be removed is no longer a
       child of this node. Perhaps it was moved in a 'blur' event handler?".
       Deferring by a tick lets the blur finish before the DOM changes. */
    function repaintSoon() { setTimeout(paint, 0); }

    function num(sel, key) {
      var e = root.querySelector(sel);
      if (!e) return;
      e.onchange = function () {
        var v = e.value === '' ? null : Number(e.value);
        S.whatif[key] = v; S.whatifTouched = true; repaintSoon();
      };
    }
    num('#rpCap', 'capRatePct'); num('#rpReq', 'requiredDscr'); num('#rpRate', 'newRatePct');
    num('#rpAmort', 'amortYears'); num('#rpBal', 'loanBalance'); num('#rpAds', 'annualDebtService');
    ['#rpReset', '#rpReset2'].forEach(function (sel) {
      var e = root.querySelector(sel);
      if (e) e.onclick = function () { reset(); repaintSoon(); };
    });

    var ex = root.querySelector('#rpExport');
    if (ex) ex.onclick = function () {
      var d = S.cache.summary || { rows: [] };
      var head = ['Property', 'Source', 'Entity', 'Units', 'Occupancy', 'Total income', 'Total expenses',
                  'NOI, trailing 12 mo', 'Optimized NOI', 'Expense ratio', 'Net income', 'DSCR mortgage', 'DSCR all debt', 'PM company', 'Ownership',
                  'T12 filed', 'T12 file', 'Rent roll filed', 'Rent roll file'];
      var body = (d.rows || []).filter(function (r) { return !S.status || r.ownership_status === S.status; })
        .map(function (r) {
          return [r.name, r.source_system, r.entity_name, r.units, r.latest_occupancy, r.t12_income,
                  r.t12_expense, r.t12_noi, r.optimized_noi, r.expense_ratio, r.t12_net_income,
                  dscrM(r), r.trailing_dscr_all_debt, r.pm_company, r.ownership_status,
                  r.t12_in_dropbox ? 'yes' : 'no', r.t12_file_name || '',
                  r.rent_roll_in_dropbox ? 'yes' : 'no', r.rent_roll_file_name || ''];
        });
      download('properties.csv', csv([head].concat(body)));
    };
    var fx = root.querySelector('#rpFeeExport');
    if (fx) fx.onclick = function () {
      var f = S.cache.fees || { rows: [] };
      var head = ['Manager', 'Fee row', 'Timing', 'Measure'].concat(MONTHS).concat(['Total']);
      var out = [head];
      (f.rows || []).forEach(function (r) {
        [['Expected', 'expected'], ['Received', 'received'], ['Variance', 'variance']].forEach(function (k) {
          var vals = [], t = 0, has = false;
          for (var m = 1; m <= 12; m++) { var v = r[k[1]][m]; if (isNum(v)) { t += Number(v); has = true; } vals.push(isNum(v) ? v : ''); }
          out.push([r.manager_group, r.label, r.payment_timing, k[0]].concat(vals).concat([has ? t : '']));
        });
      });
      download('am-fees-' + S.year + '.csv', csv(out));
    };
  }

  /* ---- loading ------------------------------------------------------------- */
  function load() {
    paint();
    S.busy = true; S.error = null;
    var jobs = [];

    if (!S.tree) jobs.push(fetch('/api/portfolio', { cache: 'no-store' }).then(function (r) { return r.json(); })
      .then(function (b) { S.tree = b; }));

    if (S.scope === 'property') {
      S.cache.prop = S.cache.prop || {};
      var d = S.cache.prop;
      if (d._id !== S.propertyId) { S.cache.prop = d = { _id: S.propertyId }; }
      if (!d.summary) {
        jobs.push(api('/api/portfolio/summary').then(function (b) {
          d.summary = (b.rows || []).filter(function (r) { return r.id === S.propertyId; })[0] || {};
        }));
      }
      if (S.ptab === 'monthly' && !d.monthly) {
        jobs.push(api('/api/portfolio/' + S.propertyId + '/monthly?year=' + S.year).then(function (b) { d.monthly = b; }));
      }
      if ((S.ptab === 'is' || S.ptab === 'capex') && !d.is) {
        jobs.push(api('/api/portfolio/' + S.propertyId + '/income-statement').then(function (b) { d.is = b; }));
      }
      if ((S.ptab === 'noi' || S.ptab === 'dscr') && !d.noi) {
        jobs.push(api('/api/portfolio/' + S.propertyId + '/noi-analysis').then(function (b) { d.noi = b; }));
      }
      if (S.ptab === 'fee' && !d.fees) {
        jobs.push(api('/api/am-fees?year=' + S.year).then(function (b) { d.fees = b; }));
      }
      if (S.ptab === 'rent' && !d.units) {
        jobs.push(api('/api/portfolio/' + S.propertyId + '/rent-roll').then(function (b) {
          d.units = b.units; d.rentSummary = b.rentSummary;
        }));
      }
      if ((S.ptab === 'bldg' || S.ptab === 'details') && !d.raw) {
        jobs.push(fetch('/api/portfolio', { cache: 'no-store' }).then(function (r) { return r.json(); })
          .then(function (b) {
            d.raw = (b.properties || []).filter(function (p) { return p.id === S.propertyId; })[0] || {};
          }));
      }
    } else if (S.tab === 'fees') {
      if (!S.cache.fees) {
        jobs.push(api('/api/am-fees?year=' + S.year + (S.entityId ? '&entity=' + S.entityId : ''))
          .then(function (b) { S.cache.fees = b; }));
      }
    } else {
      var key = S.entityId || 'all';
      if (!S.cache.summary || S.cache.summaryKey !== key) {
        jobs.push(api('/api/portfolio/summary' + (S.entityId ? '?entity=' + S.entityId : ''))
          .then(function (b) { S.cache.summary = b; S.cache.summaryKey = key; }));
      }
    }

    Promise.all(jobs).then(function () { S.busy = false; paint(); })
      .catch(function (e) { S.busy = false; S.error = e.message || String(e); paint(); });
  }

  function mount(host) {
    S.host = host;
    if (!host) return;
    paint();
    load();
  }

  function invalidate() {
    S.cache = {}; S.tree = null;
    if (S.host) load();
  }

  window.PortalReporting = { mount: mount, invalidate: invalidate, _state: S };
})();
