/* Leadli AI — Financials. Reads /api/leadli/financials.

   Four cards and one four-column table, in the PORTAL's own components
   (`.kpis`/`.kpi`, `.card`, `.pill`) plus the `fin-` helpers from
   portal-financials.css, so it reads as the same product as the LeavenWealth
   and Folio screens without a third visual language.

   ---------------------------------------------------------------------------
   THE EMPTY STATE IS THE BUILD, because it is what this screen shows today.

   Leadli has NO payment data: 0 rows in sales_payment, subscription_client and
   transaction. So all four cards read $0.00 / 0 and the table renders one
   centred message naming where revenue will arrive from.

   That is accurate, not broken. No skeletons, no spinners left running, and
   NO placeholder rows, sample products or demo customers to make the page look
   populated — that is exactly how Folio's page ended up displaying six
   businesses that do not exist.

   `empty` comes from the server's own payment_count, so inserting one real
   payment flips the screen with no code change here. That is the acceptance
   check that matters.

   ---------------------------------------------------------------------------
   WHAT IS DELIBERATELY ABSENT

   No MRR, ARR, NRR, MoM, churn or trend chart. Leadli has zero payments; each
   of those would be a fabrication, and the Folio version of this page shipped
   with $2,369 MRR, 104% NRR and a four-bar chart, none of which existed.

   No percentage, arrow or period-over-period figure on any card — `kpiCard()`
   has no delta slot at all, where portal.html's `kpi()` takes a fifth argument
   that colours a figure green or red.

   No pipeline stages and no funnel. The single lead count inside the
   empty-state message is the one exception, and only because it explains why
   the page is empty.
   --------------------------------------------------------------------------- */

window.PortalLeadliFin = (function () {
  'use strict';

  var API = '/api/leadli/financials';

  var S = {
    summary: null, rows: null,
    type: [],                 /* Service type chips: [] means All */
    sort: 'amount', dir: 'desc',
    expanded: null,
    loading: false, error: null
  };

  var host = null;

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
  /* Plain, never abbreviated, and $0.00 is a real answer here rather than a
     placeholder - it is what "no payments yet" looks like in a money column. */
  function plain(v) {
    var n = Number(v);
    if (!isFinite(n)) return '&mdash;';
    return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  /* Sliced off the ISO string, NEVER formatted through the viewer's timezone.
     paid_at is a timestamptz; toLocaleDateString on an evening-UTC instant
     renders the next day for any reader east of UTC, and a payment's date is a
     business fact rather than a moment converted into wherever the browser
     happens to be. A test asserts toLocaleDateString appears nowhere here. */
  function dateOnly(v) { return v ? String(v).slice(0, 10) : null; }

  function icon(n) {
    try { return (typeof I !== 'undefined' && I && I[n]) || ''; } catch (e) { return ''; }
  }

  /* portal.html's kpi() reproduced: a script-scoped helper in another file
     cannot be called from here, so this emits the same markup. FOUR arguments,
     not five - the fifth is the class that colours a delta, and there are no
     deltas on this screen. */
  function kpiCard(ic, label, value, sub) {
    return '<div class="kpi">' +
      '<div class="k">' + icon(ic) + ' ' + esc(label) + '</div>' +
      '<div class="v">' + value + '</div>' +
      (sub ? '<div class="d">' + sub + '</div>' : '') +
      '</div>';
  }

  function getJson(url) {
    return fetch(url, { headers: { Accept: 'application/json' } }).then(function (r) {
      return r.json().then(function (j) {
        if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
        return j;
      });
    });
  }

  /* Repeated array params, never comma-joined. */
  function qs() {
    return S.type.map(function (t) {
      return 'service_type[]=' + encodeURIComponent(t);
    }).join('&');
  }

  function load() {
    S.loading = true; S.error = null;
    paint();
    return Promise.all([
      getJson(API + '/summary'),
      getJson(API + '/payments?' + qs())
    ]).then(function (out) {
      S.summary = out[0];
      S.rows = out[1].rows || [];
      if (S.expanded && !S.rows.some(function (r) { return r.id === S.expanded; })) S.expanded = null;
    }).catch(function (e) {
      S.error = e.message;
    }).then(function () {
      S.loading = false; paint();
    });
  }

  /* ---- render ----------------------------------------------------------- */

  function paint() { if (host) { host.innerHTML = view(); wire(); } }

  function view() {
    if (S.error) {
      return '<div class="fin-problem"><div><b>Leadli financials could not load.</b><div>' +
        esc(S.error) + '</div></div></div>';
    }
    if (!S.summary) return '<div class="fin-loading">Reading the payment stream&hellip;</div>';
    return head() + cards(S.summary) + filters() + table();
  }

  function head() {
    return '<div class="fin-head"><div>' +
      '<h1 class="fin-title">Financials</h1>' +
      '<p class="fin-sub">Leadli AI &middot; payments received</p>' +
      '</div></div>';
  }

  function cards(s) {
    /* Card 1. Money RECEIVED, from sales_payment - never
       subscription_client.subscription_amount, which is a recurring rate. */
    var amount = kpiCard('dollar', 'Total amount', plain(s.total_amount),
      esc(s.payment_count + ' collected payment' + (s.payment_count === 1 ? '' : 's') +
          (s.test_filter && s.test_filter.provisional ? ', test rows excluded' : '')));

    /* Card 2. DISTINCT PAYERS. Never lead.is_client. */
    var clients = kpiCard('users', 'Total clients', String(s.total_clients),
      'distinct payers, not leads');

    /* Cards 3 and 4 count PAYMENTS, not customers - one subscriber paying
       monthly for a year contributes 12 - and the sub-lines say so. Where the
       two differ, the distinct-subscription count is named beside it rather
       than swapped in silently. */
    var subs = kpiCard('trend', 'Subscriptions', String(s.subscription_count),
      s.subscription_count && s.distinct_subscriptions !== s.subscription_count
        ? esc('payments, across ' + s.distinct_subscriptions + ' subscription' +
              (s.distinct_subscriptions === 1 ? '' : 's'))
        : 'recurring payments');

    var once = kpiCard('card', 'One-time payments', String(s.one_time_count),
      s.unknown_reason_count
        ? esc(s.unknown_reason_count + ' more with no billing reason recorded')
        : 'one-off payments');

    return '<div class="kpis">' + amount + clients + subs + once + '</div>';
  }

  /* Service type chips. Hidden while there is nothing to filter - a control
     whose every option returns nothing is worse than no control. */
  function filters() {
    if (S.summary.empty) return '';
    var opts = [['', 'All'], ['Subscription', 'Subscription'], ['One-time', 'One-time']];
    if (S.summary.unknown_reason_count) opts.push(['Unknown', 'Unknown']);
    return '<div class="fin-filters"><span class="fin-tri">' +
      opts.map(function (o) {
        var on = o[0] === '' ? !S.type.length : S.type.indexOf(o[0]) >= 0;
        return '<button class="fin-tri-opt' + (on ? ' on' : '') +
          '" data-type="' + esc(o[0]) + '">' + esc(o[1]) + '</button>';
      }).join('') +
      '</span></div>';
  }

  var COLS = [
    { key: 'product', label: 'Product name' },
    { key: 'customer', label: 'Customer name' },
    { key: 'amount', label: 'Amount', r: 1 },
    { key: 'service_type', label: 'Service type' }
  ];

  function sorted() {
    var rows = (S.rows || []).slice();
    var k = S.sort, dir = S.dir === 'asc' ? 1 : -1;
    return rows.sort(function (a, b) {
      var x = a[k], y = b[k];
      /* Nulls last in BOTH directions: a null at the top of a descending
         column reads as the largest value. */
      if (x === null || x === undefined || x === '') return (y === null || y === undefined || y === '') ? 0 : 1;
      if (y === null || y === undefined || y === '') return -1;
      if (typeof x === 'number' && typeof y === 'number') return (x - y) * dir;
      return String(x).localeCompare(String(y)) * dir;
    });
  }

  function typePill(t) {
    var c = t === 'Subscription' ? 'blue' : t === 'One-time' ? 'green' : 'gray';
    return '<span class="pill ' + c + '">' + esc(t) + '</span>';
  }

  function cell(key, row) {
    if (key === 'product') {
      /* A null product is named, not blank. */
      return '<span class="fin-etoggle">' + (S.expanded === row.id ? '&#9662;' : '&#9656;') + '</span>' +
        (row.product ? esc(row.product)
                     : '<span class="fin-flag" title="sales_payment.product_name is null on this row">Unknown product</span>');
    }
    if (key === 'customer') {
      if (!row.customer) return nil();
      /* A Whop username is a HANDLE. Passing it off as a person's name is the
         one thing the spec asks this column not to do. */
      var mark = row.customer_source === 'whop_username'
        ? ' <span class="fin-flag" title="From the Whop username - a handle, not a person&#39;s name">handle</span>'
        : row.customer_source === 'email'
          ? ' <span class="fin-flag" title="No name on the payment or in the billing address; showing the email">email</span>'
          : '';
      return esc(row.customer) + mark;
    }
    if (key === 'amount') {
      return money(row.amount) +
        (row.currency && row.currency !== 'USD'
          ? ' <span class="fin-sub">' + esc(row.currency) + '</span>' : '');
    }
    if (key === 'service_type') return typePill(row.service_type);
    var v = row[key];
    return v === null || v === undefined || v === '' ? nil() : esc(v);
  }

  /* ---- the empty state ---------------------------------------------------
     One centred message, not an empty grid and not placeholder rows. It names
     the pipeline that will fill it, so "why is this blank" is answerable from
     the screen. */
  function emptyState() {
    var p = S.summary.pipeline || { total_leads: 0, converted: 0 };
    return '<div class="card"><div class="card-b">' +
      '<div class="fin-empty">' +
        '<b>No payments recorded yet</b>' +
        '<div>Leadli revenue arrives through the Whop webhook ' +
          '(n8n workflow &ldquo;Whop to database (payment success)&rdquo;). ' +
          'Nothing has been received for Leadli to date.</div>' +
        '<div class="fin-sub">' +
          p.total_leads.toLocaleString('en-US') + ' leads in the pipeline &middot; ' +
          p.converted + ' converted' +
        '</div>' +
      '</div></div></div>';
  }

  function table() {
    if (S.summary.empty) return emptyState();
    var rows = sorted();
    if (!rows.length) {
      return '<div class="card"><div class="card-b"><div class="fin-empty">' +
        '<b>No payment matches this filter</b>' +
        '<div>Clear the Service type chips to see all ' +
          S.summary.payment_count + '.</div></div></div></div>';
    }

    var head = COLS.map(function (c) {
      var on = S.sort === c.key;
      return '<th class="' + (c.r ? 'r ' : '') + 'fin-sortable' + (on ? ' on' : '') +
        '" data-sort="' + esc(c.key) + '">' + esc(c.label) +
        (on ? '<span class="fin-caret">' + (S.dir === 'asc' ? '&#9650;' : '&#9660;') + '</span>' : '') +
        '</th>';
    }).join('');

    var body = rows.map(function (row) {
      var open = S.expanded === row.id;
      var tr = '<tr class="fin-erow' + (open ? ' open' : '') + (row.failed ? ' muted' : '') +
        '" data-row="' + esc(row.id) + '">' +
        COLS.map(function (c) {
          return '<td' + (c.r ? ' class="r"' : '') + '>' + cell(c.key, row) + '</td>';
        }).join('') + '</tr>';
      if (!open) return tr;
      return tr + '<tr class="fin-exp"><td colspan="' + COLS.length + '">' + detail(row) + '</td></tr>';
    }).join('');

    return '<div class="card"><div class="card-h">' + icon('dollar') + ' Payments' +
      '<span class="badge">' + rows.length + '</span></div>' +
      '<div class="card-b flush"><table class="fin-etable"><thead><tr>' + head + '</tr></thead>' +
      '<tbody>' + body + '</tbody></table></div></div>';
  }

  /* The row expand. The FEE is why this exists: it is real money and it is
     invisible from the Amount column alone. */
  function detail(row) {
    var f = [
      ['Paid', row.paid_at ? esc(dateOnly(row.paid_at)) : nil()],
      ['Payment id', '<span class="fin-mono">' + esc(row.payment_id || '') + '</span>' +
        (row.receipt_number ? ' <span class="fin-sub">receipt ' + esc(row.receipt_number) + '</span>' : '')],
      ['Gross', money(row.amount)],
      ['Fee', money(row.fee)],
      ['Net', money(row.net)],
      ['Status', esc(row.status || '') + (row.substatus && row.substatus !== row.status
        ? ' / ' + esc(row.substatus) : '')],
      ['Card', row.card ? esc(row.card) : nil()]
    ];
    if (Number(row.refunded)) f.push(['Refunded', money(row.refunded)]);
    /* A failed payment keeps its reason: a failed renewal is the earliest
       churn signal there is. */
    if (row.failed) {
      f.push(['Declined', row.failure_message
        ? esc(row.failure_message) : '<span class="fin-sub">no reason recorded</span>']);
    }
    if (row.billing_reason) f.push(['Billing reason', '<span class="fin-mono">' + esc(row.billing_reason) + '</span>']);
    if (row.email) f.push(['Email', esc(row.email)]);

    return '<dl class="fin-fields">' + f.map(function (p) {
      return '<dt>' + p[0] + '</dt><dd>' + p[1] + '</dd>';
    }).join('') + '</dl>';
  }

  /* ---- wiring -----------------------------------------------------------
     `.onclick =`, never addEventListener: paint() rebuilds this subtree on
     every change and mount() runs on every navigation back, so a listener
     added per paint stacks a copy and fires N requests per click. */
  function wire() {
    if (!host) return;

    host.querySelectorAll('[data-type]').forEach(function (b) {
      b.onclick = function () {
        var t = b.getAttribute('data-type');
        /* All is exclusive with everything else, and re-clicking the only
           active chip returns to All rather than to nothing. */
        if (!t) S.type = [];
        else if (S.type.indexOf(t) >= 0) S.type = S.type.filter(function (x) { return x !== t; });
        else S.type = S.type.concat([t]);
        load();
      };
    });

    host.querySelectorAll('[data-sort]').forEach(function (th) {
      th.onclick = function () {
        var k = th.getAttribute('data-sort');
        if (S.sort === k) S.dir = S.dir === 'asc' ? 'desc' : 'asc';
        else { S.sort = k; S.dir = k === 'amount' ? 'desc' : 'asc'; }
        paint();
      };
    });

    host.querySelectorAll('.fin-erow').forEach(function (tr) {
      tr.onclick = function () {
        var id = tr.getAttribute('data-row');
        S.expanded = S.expanded === id ? null : id;
        paint();
      };
    });
  }

  /* ---- mount ------------------------------------------------------------ */
  function mount(el) {
    host = el || document.getElementById('leadliFinNative');
    if (!host) return;
    if (!S.summary && !S.loading) load();
    else paint();
  }

  function invalidate() { if (host) load(); else S.summary = null; }

  return { mount: mount, invalidate: invalidate, _state: S };
})();
