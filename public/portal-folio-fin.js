/* Folio Excel financials — Whop subscription billing.

   Reads /api/folio/financials. Reuses the `fin-` classes from
   portal-financials.css so this reads as the same product as the LeavenWealth
   screen without a second stylesheet: the layout components are shared, the
   data model is not.

   ---------------------------------------------------------------------------
   THERE ARE NO KPI TILES ON THIS SCREEN, AND THAT IS THE POINT.

   Folio has exactly ONE paying customer and ONE month of payment history. A
   tile reading "MRR $1,000 · +8% MoM" cannot be computed from that — there is
   no prior month to compare against. The App Users page this replaces showed
   precisely that figure with six invented subscribers behind it (Bluebird
   Property Mgmt, Redwood Residential, Cornerstone Realty…), invented
   Starter/Growth/Scale plans, 774 units and $2,369 of MRR. None of it existed.

   Putting a real number into the same shape is the same mistake with better
   inputs. So: a header line, the subscriber table, the payments under it, and
   the funnel. Tiles when there are two months to compare and more than one
   row.

   An earlier version of this file DID have four tiles, and they also counted
   the two $1 card tests — $1,001 gross where the real figure is $1,000. Both
   faults are gone.

   ---------------------------------------------------------------------------
   WHAT THE SCREEN REFUSES TO SHOW

   - Units, Plan and Billing period all read "Not set". The values appear to
     sit in GHL custom fields on the linked lead, keyed by OPAQUE IDS WITH NO
     NAMES, and the likely reading is units 1600 / period Monthly / plan
     "Founding Customer" — inferred from the values, never confirmed from a
     field name. Rendering 1600 as units on that basis would be a guess
     wearing four digits of precision.

   - No conversion percentage on the funnel. One customer.

   - The two $1 card tests are OUT by default. Including them turns one payment
     into three and $1,000 into $1,001. The toggle is explicit, and the
     provisional way test rows are identified is stated next to it.

   MRR is $1,000 and the header says "assumed monthly" beside it, because
   subscription_client.billing_period is NULL and $1,000 a month against
   $1,000 a year is a twelvefold difference. The assumption sentence comes from
   the server (`mrr_assumption`) so the screen cannot state a different one.
   --------------------------------------------------------------------------- */

window.PortalFolioFin = (function () {
  'use strict';

  var API = '/api/folio/financials';

  var FILTER_DEFS = [
    { key: 'status', label: 'Status' },
    { key: 'payment_status', label: 'Payment status' },
    { key: 'billing_period', label: 'Billing period' },
    { key: 'plan', label: 'Plan' },
    { key: 'provider', label: 'Provider' }
  ];

  var S = {
    mode: 'financials',     /* 'financials' = the table; 'reports' = the summary */
    summary: null, subs: null, funnel: null, options: null, dateScope: null,
    sel: { status: [], payment_status: [], billing_period: [], plan: [], provider: [] },
    openPanel: null,
    dateFrom: '', dateTo: '',
    includeTest: false,
    expanded: null,          /* subscriber id whose payments are open */
    payments: {},            /* subscriber id -> payload */
    payLoading: null,
    loading: false, error: null
  };

  var host = null;
  var docBound = false;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  function nil() { return '<span class="fin-nil">&mdash;</span>'; }

  function money(v) {
    if (v === null || v === undefined || v === '') return nil();
    var n = Number(v);
    if (!isFinite(n)) return nil();
    return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  /* Plain, never abbreviated. Folio's volume is in the hundreds and "$1.0K"
     would throw away the only interesting digits. */
  function plain(v) {
    var n = Number(v);
    if (!isFinite(n)) return '&mdash;';
    return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function dateOnly(v) { return v ? String(v).slice(0, 10) : null; }

  /* "Not set" is a statement, not a blank cell — and the tooltip says where
     the value actually is and why it is not being shown. */
  function notSet(reason) {
    return '<span class="fin-flag" title="' + esc(reason || '') + '">Not set</span>';
  }

  function getJson(url) {
    return fetch(url, { headers: { Accept: 'application/json' } }).then(function (r) {
      return r.json().then(function (j) {
        if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
        return j;
      });
    });
  }

  /* Repeated array params, never comma-joined: business names contain commas
     and ampersands ("J & M Property Management, Inc.") and the compact form
     cannot be un-split after Express has decoded it. */
  function qs() {
    var out = [];
    FILTER_DEFS.forEach(function (d) {
      (S.sel[d.key] || []).forEach(function (v) {
        out.push(encodeURIComponent(d.key) + '[]=' + encodeURIComponent(v));
      });
    });
    if (S.dateFrom) out.push('from=' + encodeURIComponent(S.dateFrom));
    if (S.dateTo) out.push('to=' + encodeURIComponent(S.dateTo));
    if (S.includeTest) out.push('include_test=true');
    return out.join('&');
  }

  function load() {
    S.loading = true; S.error = null;
    paint();
    /* Reports is a summary of the same two endpoints the Financials screen
       reads, so the two screens cannot report different money. It has no
       table, so it does not ask for the subscriber list. */
    var wants = [getJson(API + '/summary'), getJson(API + '/funnel')];
    if (S.mode !== 'reports') wants.push(getJson(API + '/subscribers?' + qs()));
    return Promise.all(wants).then(function (out) {
      S.summary = out[0];
      S.funnel = out[1];
      if (out[2]) {
        S.subs = out[2].rows || [];
        S.options = out[2].options || null;
        S.dateScope = out[2].date_scope || null;
        /* A filter change can hide the row whose payments are open. */
        if (S.expanded && !S.subs.some(function (r) { return r.id === S.expanded; })) S.expanded = null;
        S.payments = {};
      }
    }).catch(function (e) {
      S.error = e.message;
    }).then(function () {
      S.loading = false; paint();
    });
  }

  function loadPayments(id) {
    S.payLoading = id;
    paint();
    return getJson(API + '/subscribers/' + encodeURIComponent(id) + '/payments?' +
                   'include_test=' + (S.includeTest ? 'true' : 'false'))
      .then(function (j) { S.payments[id] = j; })
      .catch(function (e) { S.payments[id] = { error: e.message }; })
      .then(function () { S.payLoading = null; paint(); });
  }

  /* ---- render ----------------------------------------------------------- */

  /* Three screens, one module, one set of endpoints — so Folio cannot report
     one number for its money on one screen and a different one next door.
     That is not hypothetical: App Users showed "$2,369 MRR · +8% MoM" off six
     invented subscribers while the real answer was one subscriber at $1,000. */
  function paint() {
    if (!host) return;
    host.innerHTML = S.mode === 'reports' ? reportsView() : view();
    wire();
  }

  function shell(body) {
    if (S.error) {
      return '<div class="fin-problem"><div><b>Folio financials could not load.</b><div>' +
        esc(S.error) + '</div></div></div>';
    }
    if (!S.summary) return '<div class="fin-loading">Reading Whop billing&hellip;</div>';
    return body();
  }

  function view() {
    return shell(function () {
      return header() + filters() + subscriberTable() +
        (S.mode === 'financials' ? funnelPanel() : '') + provenance();
    });
  }

  /* ---- Reports & Financials --------------------------------------------
     The whole page, and every figure on it comes from a query.

     It replaces a screen that ran NO queries at all: MRR $2,369, ARR $28.4K,
     "Active users 4" and NRR 104% were computed from six invented subscribers
     in a `SUBS` array, and the MRR trend charted Apr–Jul at 2600/2900/3100/3308
     — four made-up months rendered ~10px apart, which is why they read as one
     placeholder shape. The only real payment is dated 17 Aug 2026.

     What is here instead: the subscriber line with its MRR caveat, revenue to
     date with the Whop fee and the net, and the funnel. No tiles, no trend,
     and nothing that cannot be computed. ARR is absent because it would be
     MRR × 12 off a billing period nobody has confirmed; NRR is absent because
     it needs a prior period to retain. */
  function reportsView() {
    return shell(function () {
      var s = S.summary;
      return '' +
        '<div class="fin-head"><div>' +
          '<h1 class="fin-title">Folio Excel &middot; Reports &amp; Financials</h1>' +
          '<p class="fin-sub">Whop subscription billing</p>' +
        '</div></div>' +
        '<div class="fin-tablewrap"><div class="fin-pairs">' +
          pair('Active subscribers', String(s.active_subscribers),
               'subscription_client where status = active') +
          pair('MRR', plain(s.mrr) +
               (s.mrr_assumed ? ' <span class="fin-flag" title="' + esc(s.mrr_assumption) +
                                '">assumed monthly</span>' : ''),
               s.mrr_assumed ? s.mrr_assumption : 'billing_period is set') +
          pair('Revenue to date', plain(s.history.collected_usd),
               s.history.payments + ' payment' + (s.history.payments === 1 ? '' : 's') +
               ', test rows excluded') +
          pair('First payment', s.history.first_paid_at ? longDate(s.history.first_paid_at) : '&mdash;',
               s.history.last_paid_at && s.history.last_paid_at !== s.history.first_paid_at
                 ? 'most recent ' + longDate(s.history.last_paid_at) : 'the only payment') +
          pair('Whop fees to date', plain(s.history.fees_usd), 'sum of fee_amount') +
          pair('Net', plain(s.history.net_usd), 'sum of amount_after_fees') +
        '</div>' +
        /* Where a KPI row would have been. It names the reason, so the absence
           reads as a fact about the data rather than a chart that failed. */
        '<p class="fin-note">' + esc(s.history.trend_note) +
          (s.mrr_assumed ? ' ' + esc(s.mrr_assumption) + '.' : '') + '</p>' +
        '</div>' +
        funnelPanel() +
        provenance();
    });
  }

  function pair(label, valueHtml, hint) {
    return '<div class="fin-pair">' +
      '<span class="k">' + esc(label) + '</span>' +
      '<span class="v">' + valueHtml + '</span>' +
      (hint ? '<span class="h">' + esc(hint) + '</span>' : '') +
      '</div>';
  }

  /* "17 Aug 2026", formatted from the ISO DATE PART and never through the
     viewer's timezone.

     `paid_at` is a timestamptz: the real payment is 2026-08-17T19:06:40Z, and
     toLocaleDateString on that instant renders "18 Aug 2026" for any reader
     east of UTC. A payment's date is a business fact, not a moment converted
     into wherever the browser happens to be - and the acceptance check says
     17 Aug. `dateOnly` elsewhere in this file slices the string for the same
     reason, so this keeps the two consistent. */
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function longDate(v) {
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v == null ? '' : v));
    if (!m) return esc(String(v == null ? '' : v).slice(0, 10));
    var mon = MONTHS[Number(m[2]) - 1];
    if (!mon) return esc(m[0]);
    return Number(m[3]) + ' ' + mon + ' ' + m[1];
  }

  /* The header carries the two numbers this screen has, in a sentence rather
     than in tiles — and the MRR assumption sits immediately beside the MRR,
     not in a footnote. */
  function header() {
    var s = S.summary;
    var subs = s.active_subscribers;
    var bits = [
      '<b>' + esc(String(subs)) + ' active subscriber' + (subs === 1 ? '' : 's') + '</b>',
      '<b>' + plain(s.mrr) + ' MRR</b>' +
        (s.mrr_assumed ? ' <span class="fin-flag" title="' + esc(s.mrr_assumption) +
                         '">assumed monthly</span>' : '')
    ];
    return '' +
      '<div class="fin-head">' +
        '<div>' +
          '<h1 class="fin-title">Folio Excel &middot; Whop billing</h1>' +
          '<p class="fin-sub">' + bits.join(' &middot; ') + '</p>' +
          /* Said out loud, because the absence of a chart is otherwise
             indistinguishable from one that failed to load. */
          '<p class="fin-note">' + esc(s.history.trend_note) + ' ' +
            esc(s.mrr_assumption) + '.</p>' +
        '</div>' +
      '</div>';
  }

  function optionsFor(key) {
    var raw = (S.options && S.options[key]) || [];
    return raw.filter(function (v) { return v !== null && v !== undefined; })
      .map(String).sort();
  }

  function msControl(def) {
    var sel = S.sel[def.key] || [];
    var open = S.openPanel === def.key;
    var opts = optionsFor(def.key);
    var list = opts.length
      ? opts.map(function (o) {
          var on = sel.indexOf(o) >= 0;
          return '<label class="fin-ms-opt">' +
            '<input type="checkbox" data-msk="' + esc(def.key) + '" value="' + esc(o) + '"' +
              (on ? ' checked' : '') + '>' +
            '<span class="n">' + esc(o) + '</span></label>';
        }).join('')
      : '<div class="fin-ms-none">No values recorded</div>';

    return '<span class="fin-ms">' +
      '<button class="fin-ms-btn' + (sel.length ? ' on' : '') + '" data-msbtn="' + esc(def.key) + '">' +
        esc(def.label) + (sel.length ? ' (' + sel.length + ')' : '') +
        '<span class="caret">&#9660;</span>' +
      '</button>' +
      '<div class="fin-ms-panel' + (open ? ' open' : '') + '" data-mspanel="' + esc(def.key) + '">' +
        '<div class="fin-ms-list">' + list + '</div>' +
        '<div class="fin-ms-foot">' +
          '<button data-msnone="' + esc(def.key) + '">Clear</button>' +
        '</div>' +
      '</div></span>';
  }

  function filters() {
    var chips = [];
    FILTER_DEFS.forEach(function (d) {
      (S.sel[d.key] || []).forEach(function (v) {
        chips.push('<span class="fin-chip">' + esc(d.label) + ': ' + esc(v) +
          '<button data-unchip="' + esc(d.key) + '" data-val="' + esc(v) + '">&times;</button></span>');
      });
    });
    if (S.dateFrom || S.dateTo) {
      /* The fallback is an entity, so it goes in AFTER esc() — inside it the
         ampersand would be escaped and the reader would see "&hellip;". */
      chips.push('<span class="fin-chip">Paid: ' + (esc(S.dateFrom) || '&hellip;') + ' to ' +
        (esc(S.dateTo) || '&hellip;') + '<button data-cleardates="1">&times;</button></span>');
    }
    if (S.includeTest) {
      chips.push('<span class="fin-chip">Test payments included' +
        '<button data-notest="1">&times;</button></span>');
    }

    return '' +
      '<div class="fin-filters">' +
        FILTER_DEFS.map(msControl).join('') +
        '<span class="fin-daterange">' +
          '<input class="fin-qsel" type="date" id="ff-from" aria-label="Paid from" value="' + esc(S.dateFrom) + '">' +
          '<span class="sep">to</span>' +
          '<input class="fin-qsel" type="date" id="ff-to" aria-label="Paid to" value="' + esc(S.dateTo) + '">' +
        '</span>' +
        /* Explicit, defaulting to off, and it says what turning it on costs. */
        '<label class="fin-tri-opt" title="Two $1 card tests. Off by default: including them reports 3 payments and $1,001 against a real 1 and $1,000.">' +
          '<input type="checkbox" id="ff-test"' + (S.includeTest ? ' checked' : '') + '> Include test payments' +
        '</label>' +
        '<span class="fin-headtools">' +
          '<button class="fin-btn" id="ff-x-subs">Export subscribers</button>' +
          '<button class="fin-btn" id="ff-x-pay">Export payments</button>' +
        '</span>' +
      '</div>' +
      (chips.length ? '<div class="fin-chips">' + chips.join('') +
        '<button class="fin-chip-clear" id="ff-clear">Clear all</button></div>' : '') +
      (S.dateScope ? '<p class="fin-note">' + esc(S.dateScope) + '</p>' : '');
  }

  var SUB_COLS = [
    ['business', 'Business'], ['contact', 'Contact'], ['units', 'Units'],
    ['plan', 'Plan'], ['amount', 'Amount / mo'], ['billing_period', 'Billing period'],
    ['status', 'Status'], ['payment_status', 'Payment status'],
    ['start_date', 'Since'], ['last_payment_at', 'Last payment']
  ];
  var NUMERIC = { units: 1, amount: 1 };

  function subCell(key, row) {
    if (key === 'business') {
      /* subscription_client.company, which is GHL-sourced and authoritative.
         NOT sales_payment.customer_name, which is Whop's billing-address
         version: "J & M Real Estate and Property Management Brandi". */
      return '<span class="fin-etoggle">' + (S.expanded === row.id ? '&#9662;' : '&#9656;') +
        '</span>' + esc(row.business || '') +
        /* One click to the CRM record behind the subscription. */
        (row.lead_id ? ' <a class="fin-flag" href="#brand=folio&view=leads"' +
          ' title="Open the linked GHL lead" data-lead="' + esc(row.lead_id) + '">lead</a>' : '');
    }
    if (key === 'contact') {
      return esc(row.contact || '') +
        (row.email ? '<div class="fin-sub">' + esc(row.email) + '</div>' : '');
    }
    /* Units, plan and billing period are NULL on the only subscriber, and are
       named as such rather than left blank or filled from a guess. */
    if (row.not_set && row.not_set.indexOf(key) >= 0) {
      return notSet(row.not_set_reason) +
        (key === 'billing_period' && S.summary && S.summary.mrr_assumed
          ? ' <span class="fin-sub">assumed monthly</span>' : '');
    }
    if (key === 'amount') {
      return money(row.amount) + (row.currency && row.currency !== 'USD'
        ? ' <span class="fin-sub">' + esc(row.currency) + '</span>' : '');
    }
    if (key === 'start_date' || key === 'last_payment_at') {
      return row[key] ? esc(dateOnly(row[key])) : nil();
    }
    var v = row[key];
    if (v === null || v === undefined || v === '') return nil();
    return esc(v);
  }

  function subscriberTable() {
    if (!S.subs) return '';
    if (!S.subs.length) {
      return '<div class="fin-empty">No subscriber matches these filters.' +
        (S.dateFrom || S.dateTo
          ? ' The date range is on payments, so a subscriber with no payment in it is not listed.'
          : '') + '</div>';
    }
    var head = SUB_COLS.map(function (c) {
      return '<th' + (NUMERIC[c[0]] ? ' class="r"' : '') + '>' + esc(c[1]) + '</th>';
    }).join('');

    var body = S.subs.map(function (row) {
      var open = S.expanded === row.id;
      var tr = '<tr class="fin-erow' + (open ? ' open' : '') + '" data-sub="' + esc(row.id) + '">' +
        SUB_COLS.map(function (c) {
          return '<td' + (NUMERIC[c[0]] ? ' class="r"' : '') + '>' + subCell(c[0], row) + '</td>';
        }).join('') + '</tr>';
      if (!open) return tr;
      return tr + '<tr class="fin-exp"><td colspan="' + SUB_COLS.length + '">' +
        paymentsPanel(row) + '</td></tr>';
    }).join('');

    return '<div class="fin-tablewrap"><div class="fin-scroll">' +
      '<table class="fin-table fin-etable"><thead><tr>' + head + '</tr></thead><tbody>' + body +
      '</tbody></table></div>' +
      '<div class="fin-foot"><span class="fin-count">' + S.subs.length +
        ' subscriber' + (S.subs.length === 1 ? '' : 's') + '</span>' +
      '<span class="fin-sub">Click a row for its payment history</span></div></div>';
  }

  var PAY_COLS = [
    ['paid_at', 'Paid'], ['payment_id', 'Payment'], ['billing_reason', 'Reason'],
    ['gross', 'Gross'], ['fee', 'Fee'], ['net', 'Net'],
    ['status', 'Status'], ['card', 'Card']
  ];
  var PAY_NUM = { gross: 1, fee: 1, net: 1 };

  function payCell(key, p) {
    if (key === 'paid_at') return p.paid_at ? esc(dateOnly(p.paid_at)) : nil();
    if (key === 'payment_id') {
      return '<span class="fin-mono">' + esc(p.payment_id) + '</span>' +
        (p.receipt_number ? '<div class="fin-sub">receipt ' + esc(p.receipt_number) + '</div>' : '');
    }
    if (key === 'gross') {
      /* usd_total is null until money moves. Rendering 0 for a failed payment
         would claim it was free, so the amount that was ATTEMPTED is shown
         instead, labelled as charged. */
      return p.gross === null
        ? nil() + ' <span class="fin-sub">charged ' +
            (p.charged === null ? '&mdash;' : plain(p.charged)) + '</span>'
        : money(p.gross);
    }
    if (key === 'fee' || key === 'net') return p[key] === null ? nil() : money(p[key]);
    if (key === 'billing_reason') {
      return esc(p.billing_reason || '') +
        (p.one_off ? ' <span class="fin-sub">one-off</span>' : '');
    }
    if (key === 'status') {
      var label = esc(p.status) + (p.substatus && p.substatus !== p.status
        ? ' / ' + esc(p.substatus) : '');
      /* A failed renewal is the earliest churn signal there is, so it stays in
         the list with its reason rather than being filtered out of sight. */
      if (p.failed) {
        return '<span class="fin-neg">' + label + '</span>' +
          (p.failure_message
            ? '<div class="fin-sub">' + esc(p.failure_message) + '</div>'
            : '<div class="fin-sub">no decline reason recorded</div>');
      }
      return label + (p.is_test ? ' <span class="fin-flag">test</span>' : '');
    }
    if (key === 'card') return p.card ? esc(p.card) : nil();
    var v = p[key];
    return v === null || v === undefined || v === '' ? nil() : esc(v);
  }

  function paymentsPanel(row) {
    if (S.payLoading === row.id) return '<div class="fin-loading">Reading payments&hellip;</div>';
    var d = S.payments[row.id];
    if (!d) return '<div class="fin-loading">Reading payments&hellip;</div>';
    if (d.error) return '<div class="fin-problem"><div>' + esc(d.error) + '</div></div>';
    if (!d.rows.length) {
      return '<div class="fin-empty">No payment recorded against ' +
        esc(row.external_subscription_id || 'this subscription') + '.</div>';
    }

    var head = PAY_COLS.map(function (c) {
      return '<th' + (PAY_NUM[c[0]] ? ' class="r"' : '') + '>' + esc(c[1]) + '</th>';
    }).join('');
    var body = d.rows.map(function (p) {
      return '<tr' + (p.failed ? ' class="muted"' : '') + '>' + PAY_COLS.map(function (c) {
        return '<td' + (PAY_NUM[c[0]] ? ' class="r"' : '') + '>' + payCell(c[0], p) + '</td>';
      }).join('') + '</tr>';
    }).join('');

    var t = d.totals;
    return '<table class="fin-sub-table"><thead><tr>' + head + '</tr></thead>' +
      '<tbody>' + body + '</tbody>' +
      /* Gross, fee and net as three figures. Whop's cut is 4% of this volume
         and it is the difference between what the customer paid and what
         landed; one number alone invites the other question. */
      '<tfoot><tr class="fin-totals"><td colspan="3">Collected (' + t.payments +
        ' payment' + (t.payments === 1 ? '' : 's') + ')</td>' +
        '<td class="r">' + money(t.gross) + '</td>' +
        '<td class="r">' + money(t.fee) + '</td>' +
        '<td class="r">' + money(t.net) + '</td>' +
        '<td colspan="2"></td></tr></tfoot></table>' +
      (d.include_test ? '<p class="fin-note">Test payments are included in this list.</p>' : '');
  }

  /* The stage breakdown as one line: "Qualified 1 · Demo Scheduled 1 · …".

     PIPELINE_ORDER is a DISPLAY order only — no count comes from it. `lead`
     stores pipeline_stage as free text with no ordinal, so a stage the list
     does not know cannot be placed in the funnel and is appended rather than
     dropped: an unknown stage is a lead somebody should see. */
  var PIPELINE_ORDER = ['Qualified', 'Demo Scheduled', 'Demo Complete',
                        'Closed Won', 'Onboard Initiated'];
  function breakdown(f) {
    var rank = function (s) {
      var i = PIPELINE_ORDER.indexOf(s.stage);
      return i < 0 ? PIPELINE_ORDER.length : i;
    };
    return f.stages.slice().sort(function (a, b) {
      return rank(a) - rank(b) || a.stage.localeCompare(b.stage);
    }).map(function (s) {
      return esc(s.stage) + ' ' + s.leads;
    }).join(' &middot; ');
  }

  /* The one panel with real volume behind it, which is the reason to build
     this page now rather than when there are more subscribers. */
  function funnelPanel() {
    var f = S.funnel;
    if (!f) return '';
    var max = f.stages.reduce(function (a, s) { return Math.max(a, s.leads); }, 0) || 1;
    var rows = f.stages.map(function (s) {
      return '<tr><td>' + esc(s.stage) + '</td>' +
        '<td class="r">' + s.leads + '</td>' +
        '<td><span class="fin-bar" style="width:' +
          Math.max(6, Math.round(s.leads / max * 100)) + '%"></span></td></tr>';
    }).join('');

    return '<div class="fin-tablewrap">' +
      '<div class="fin-head"><div>' +
        '<h2 class="fin-title">Funnel</h2>' +
        '<p class="fin-sub"><b>' + f.total_leads.toLocaleString('en-US') +
          '</b> leads &rarr; <b>' + f.staged_leads + '</b> in pipeline &rarr; <b>' +
          f.paying + '</b> paying</p>' +
        '<p class="fin-sub">' + breakdown(f) + '</p>' +
        /* Two sentences that head off two different wrong readings: that the
           missing percentage is an oversight, and that "paying" came from the
           lead flag — which reads 4 for Folio and is wrong three times over. */
        '<p class="fin-note">' + esc(f.conversion_note) +
          ' Paying comes from ' + esc(f.paying_source) + ', never lead.is_client.</p>' +
      '</div></div>' +
      '<div class="fin-scroll"><table class="fin-table"><thead><tr>' +
        '<th>Stage</th><th class="r">Leads</th><th></th></tr></thead>' +
        '<tbody>' + rows + '</tbody></table></div>' +
      '<div class="fin-foot"><span class="fin-count">' +
        f.no_stage.toLocaleString('en-US') + ' with no stage</span></div></div>';
  }

  /* The caveats, once, at the bottom — where they do not compete with the
     numbers but are still on the same screen as them. */
  function provenance() {
    var s = S.summary;
    /* Each entry is already HTML: the numbers come from plain() and the one
       piece of server text is escaped where it is added. Escaping the whole
       sentence afterwards would turn its own &mdash; into visible markup. */
    var out = [];
    if (s.ledger) {
      out.push('Ledger: ' + s.ledger.rows + ' Whop transaction' + (s.ledger.rows === 1 ? '' : 's') +
        ', ' + plain(s.ledger.inflow) + ' in &mdash; ' +
        (s.ledger.reconciles
          ? 'reconciles with collected payments.'
          : 'does NOT match collected payments (' + plain(s.history.collected_usd) + ').'));
    }
    if (s.test_filter && s.test_filter.provisional) out.push(esc(s.test_filter.note));
    return out.length ? '<p class="fin-note">' + out.join(' ') + '</p>' : '';
  }

  /* ---- wiring -----------------------------------------------------------
     `.onclick =`, never addEventListener: paint() rebuilds this subtree on
     every filter change and mount() runs on every navigation back, so a
     listener added per paint stacks a copy and fires N requests per click. */
  function wire() {
    if (!host) return;
    var $ = function (id) { return host.querySelector('#' + id); };

    host.querySelectorAll('[data-msbtn]').forEach(function (b) {
      b.onclick = function (e) {
        e.stopPropagation();
        var k = b.getAttribute('data-msbtn');
        S.openPanel = S.openPanel === k ? null : k;
        paint();
      };
    });
    /* An explicit `.open` class, never the `hidden` attribute — the ops
       dashboard hit exactly that, a display rule elsewhere won, and the panel
       stayed invisible with nothing in the console. */
    host.querySelectorAll('.fin-ms-panel').forEach(function (p) {
      p.onclick = function (e) { e.stopPropagation(); };
    });
    host.querySelectorAll('[data-msk]').forEach(function (cb) {
      cb.onchange = function () {
        var k = cb.getAttribute('data-msk'), v = cb.value;
        var cur = S.sel[k] || [];
        S.sel[k] = cb.checked ? cur.concat([v]) : cur.filter(function (x) { return x !== v; });
        load();
      };
    });
    host.querySelectorAll('[data-msnone]').forEach(function (b) {
      b.onclick = function () { S.sel[b.getAttribute('data-msnone')] = []; load(); };
    });
    host.querySelectorAll('[data-unchip]').forEach(function (b) {
      b.onclick = function () {
        var k = b.getAttribute('data-unchip'), v = b.getAttribute('data-val');
        S.sel[k] = (S.sel[k] || []).filter(function (x) { return x !== v; });
        load();
      };
    });
    var cd = host.querySelector('[data-cleardates]');
    if (cd) cd.onclick = function () { S.dateFrom = ''; S.dateTo = ''; load(); };
    var nt = host.querySelector('[data-notest]');
    if (nt) nt.onclick = function () { S.includeTest = false; S.payments = {}; load(); };

    var from = $('ff-from'), to = $('ff-to');
    if (from) from.onchange = function () { S.dateFrom = from.value || ''; load(); };
    if (to) to.onchange = function () { S.dateTo = to.value || ''; load(); };

    var test = $('ff-test');
    if (test) test.onchange = function () {
      S.includeTest = !!test.checked;
      /* The open payment list is scoped by the same toggle, so it has to be
         refetched rather than left showing the previous answer. */
      S.payments = {};
      var reopen = S.expanded;
      load().then(function () { if (reopen && S.expanded === reopen) loadPayments(reopen); });
    };

    var clear = $('ff-clear');
    if (clear) clear.onclick = function () {
      FILTER_DEFS.forEach(function (d) { S.sel[d.key] = []; });
      S.dateFrom = ''; S.dateTo = ''; S.includeTest = false; S.payments = {};
      load();
    };

    var xs = $('ff-x-subs');
    if (xs) xs.onclick = function () { doExport('subscribers'); };
    var xp = $('ff-x-pay');
    if (xp) xp.onclick = function () { doExport('payments'); };

    host.querySelectorAll('.fin-erow').forEach(function (tr) {
      tr.onclick = function (e) {
        /* The lead link is a link, not a row toggle. */
        if (e.target && e.target.getAttribute && e.target.getAttribute('data-lead')) return;
        var id = tr.getAttribute('data-sub');
        S.expanded = S.expanded === id ? null : id;
        if (S.expanded && !S.payments[S.expanded]) loadPayments(S.expanded);
        else paint();
      };
    });

    /* One document listener, bound once behind a guard. */
    if (!docBound) {
      docBound = true;
      document.addEventListener('click', function () {
        if (S.openPanel) { S.openPanel = null; paint(); }
      });
    }
  }

  /* The file is the full filtered result set, not the page on screen, and the
     download is a navigation so it carries no header — `exported_by` comes
     from the server session, as it does on the LeavenWealth export. */
  function doExport(viewName) {
    var url = API + '/export?view=' + encodeURIComponent(viewName) + '&' + qs();
    var a = document.createElement('a');
    a.href = url;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  /* ---- mount ------------------------------------------------------------ */
  function mount(el) { return mountAs('financials', el, 'folioFinNative'); }

  /* Folio's Reports & Financials screen, and its Overview, which renders the
     same view. Same module and same endpoints as the table above, so the two
     screens cannot show different money for the same brand. */
  function mountReports(el) { return mountAs('reports', el, 'folioReportsNative'); }

  /* App Users: the subscriber list, which for a SaaS IS the list of app users.
     Same table as Financials without the funnel underneath it. It replaced six
     invented companies (Bluebird Property Mgmt, Redwood Residential,
     Cornerstone Realty, Harbor Homes, Prairie Rentals, Elm Street Holdings),
     774 units billed and $2,369 of MRR, none of which was in the database. */
  function mountUsers(el) { return mountAs('subscribers', el, 'folioUsersNative'); }

  function mountAs(m, el, id) {
    host = el || document.getElementById(id);
    if (!host) return;
    /* A mode change needs a repaint AND, moving into either table mode, the
       subscriber list that reports mode never fetched. */
    var switched = S.mode !== m;
    S.mode = m;
    var needsRows = m !== 'reports' && !S.subs;
    if ((!S.summary || (switched && needsRows)) && !S.loading) load();
    else paint();
  }

  function invalidate() {
    S.payments = {};
    if (host) load(); else S.summary = null;
  }

  return { mount: mount, mountReports: mountReports, mountUsers: mountUsers,
           invalidate: invalidate, _state: S };
})();
