/* Folio Excel financials — Whop billing.

   Reads /api/folio-financials. Reuses the `fin-` classes from
   portal-financials.css so this reads as the same product as the LeavenWealth
   screen without a second stylesheet — the layout is shared, the data model is
   not.

   ---------------------------------------------------------------------------
   WHY A SEPARATE SCREEN

   Every relation the LeavenWealth screen reads is EMPTY for Folio (verified
   2026-09-07): 0 financial accounts, 0 deals, 0 transactions, 0 statements. A
   brand filter on that screen would have worked and shown zeros forever, which
   reads as "Folio has no money" rather than "those are the wrong tables".

   Folio's money is Whop billing: three payments and one subscription.

   ---------------------------------------------------------------------------
   TWO THINGS THIS SCREEN SAYS OUT LOUD

   1. THERE IS NO MRR. subscription_client.billing_period is NULL on the only
      row, along with number_of_units, next_billing_date and the plan link (and
      subscription_plan is empty). A $1,000 subscription with no period is
      either $1,000 a month or $1,000 a year — a twelvefold difference — so the
      tile shows the amount and says the period is missing instead of picking
      one. `mrr_derivable` comes from the server; nothing here computes around
      it.

   2. GROSS AND NET ARE BOTH SHOWN. Whop's fee is 4% of this volume ($40.79 on
      $1,001), which is the difference between what customers paid and what
      landed. One figure alone invites the other question.

   sales_payment and whop_payment hold the SAME three payments. The server
   reads only the first; the raw Whop record is fetched per-payment for card
   and billing detail and can never reach a total.
   --------------------------------------------------------------------------- */

window.PortalFolioFin = (function () {
  'use strict';

  var API = '/api/folio-financials';

  var S = {
    tab: 'payments',
    summary: null, payments: null, subs: null,
    loading: false, error: null,
    openWhop: null, whop: null,
    loadedAt: null
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
  /* Plain, not abbreviated. Folio's volume is in the hundreds and "$1.0K"
     would lose the only interesting digits. */
  function moneyTile(v) {
    var n = Number(v);
    if (!isFinite(n)) return '—';
    return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function dateOnly(v) { return v ? String(v).slice(0, 10) : null; }

  function getJson(url) {
    return fetch(url, { headers: { Accept: 'application/json' } }).then(function (r) {
      return r.json().then(function (j) {
        if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
        return j;
      });
    });
  }

  function load() {
    S.loading = true; S.error = null;
    paint();
    return Promise.all([
      getJson(API + '/summary'),
      getJson(API + '/payments'),
      getJson(API + '/subscriptions')
    ]).then(function (out) {
      S.summary = out[0];
      S.payments = out[1].rows || [];
      S.subs = out[2].rows || [];
      S.loadedAt = Date.now();
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
      return '<div class="fin-problem"><div><b>Folio financials could not load.</b><div>' +
        esc(S.error) + '</div></div></div>';
    }
    if (!S.summary) return '<div class="fin-loading">Reading Whop billing&hellip;</div>';
    return header() + tiles() + notes() + tabs() +
      (S.tab === 'payments' ? paymentsTable() : subsTable());
  }

  function header() {
    return '' +
      '<div class="fin-head">' +
        '<div>' +
          '<h1 class="fin-title">Financials</h1>' +
          '<p class="fin-sub">Folio Excel &middot; Whop billing</p>' +
        '</div>' +
        '<div class="fin-headtools">' +
          '<button class="fin-btn" id="ff-refresh">Refresh</button>' +
        '</div>' +
      '</div>';
  }

  function tiles() {
    var s = S.summary;
    /* Gross beside net, because the fee is the difference between what the
       customer paid and what arrived, and either figure alone invites the
       other question. */
    return '<div class="fin-tiles">' +
      tile('cash', 'Collected (net)', moneyTile(s.net_usd),
           'after ' + money(s.fees_usd).replace(/<[^>]*>/g, '') + ' in fees') +
      tile('', 'Gross', moneyTile(s.gross_usd),
           s.collected_count + ' of ' + s.payments + ' payments collected') +
      tile('debt', 'Outstanding', moneyTile(s.outstanding_usd),
           s.outstanding_count + (s.outstanding_count === 1 ? ' payment not collected' : ' payments not collected')) +
      subscriptionTile(s) +
      '</div>';
  }

  /* The one tile that has to refuse to answer. */
  function subscriptionTile(s) {
    if (!s.active_subscriptions) {
      return tile('', 'Subscriptions', '0', 'none active');
    }
    if (s.mrr_derivable) {
      return tile('', 'Recurring', moneyTile(s.active_amount),
                  s.active_subscriptions + ' active');
    }
    return '<div class="fin-tile" title="subscription_client.billing_period is null, so a monthly figure cannot be derived">' +
      '<div class="k">Subscriptions</div>' +
      '<div class="v">' + moneyTile(s.active_amount) + '</div>' +
      '<div class="d">' + s.active_subscriptions +
        (s.active_subscriptions === 1 ? ' active &middot; ' : ' active &middot; ') +
        '<span style="color:var(--warn-ink)">no billing period recorded</span></div>' +
      '</div>';
  }

  function tile(cls, label, value, sub) {
    return '<div class="fin-tile ' + cls + '">' +
      '<div class="k">' + esc(label) + '</div>' +
      '<div class="v">' + value + '</div>' +
      (sub ? '<div class="d">' + sub + '</div>' : '') +
      '</div>';
  }

  function notes() {
    var s = S.summary, out = '';

    /* The reason this screen exists rather than the LeavenWealth one. Stated
       once, at the top, because "no cash accounts" and "$0 cash" are different
       claims and only one of them is true here. */
    var na = s.not_applicable || {};
    out += '<div class="fin-note">Folio has <b>no bank or loan accounts, deals, ' +
      'transactions or statements</b> &mdash; ' +
      na.accounts + ' accounts, ' + na.deals + ' deals, ' + na.transactions + ' transactions. ' +
      'The cash-and-debt screen is LeavenWealth’s and would show zeros here forever, ' +
      'so this reads Whop billing instead.</div>';

    if (!s.mrr_derivable && s.active_subscriptions) {
      out += '<div class="fin-note warn"><b>No MRR is shown, deliberately.</b> ' +
        'The active subscription has no <code>billing_period</code>, so ' +
        moneyTile(s.active_amount) + ' is either monthly or annual &mdash; a twelvefold ' +
        'difference. Set the period in <code>subscription_client</code> and a recurring ' +
        'figure appears on its own.</div>';
    }
    return out;
  }

  function tabs() {
    var t = [['payments', 'Payments', (S.payments || []).length],
             ['subscriptions', 'Subscriptions', (S.subs || []).length]];
    return '<div class="fin-tabs">' + t.map(function (x) {
      return '<button class="fin-tab' + (S.tab === x[0] ? ' active' : '') + '" data-fftab="' + x[0] + '">' +
        x[1] + '<span class="n">' + x[2] + '</span></button>';
    }).join('') + '</div>';
  }

  function paymentsTable() {
    var rows = S.payments || [];
    if (!rows.length) {
      return '<div class="fin-tablewrap"><div class="fin-empty">' +
        '<b>No payments yet</b>Nothing has been billed through Whop for Folio.</div></div>';
    }
    var head = ['Customer', 'Product', 'Status', 'Gross', 'Fee', 'Net', 'Paid', '']
      .map(function (h, i) { return '<th' + (i >= 3 && i <= 5 ? ' class="r"' : '') + '>' + h + '</th>'; }).join('');

    var body = rows.map(function (p) {
      /* An uncollected payment shows its `total` in the Gross column and
         nothing in Net, because usd_total and amount_after_fees are both null
         until money moves — rendering 0 there would claim it was free. */
      var gross = p.collected ? money(p.usd_total) : money(p.total);
      return '<tr>' +
        '<td>' + esc(p.customer_name || p.customer_email || '') +
          (p.customer_email && p.customer_name ? '<div style="font-size:11px;color:var(--dimmer)">' + esc(p.customer_email) + '</div>' : '') +
        '</td>' +
        '<td>' + (p.product_name ? esc(p.product_name) : nil()) +
          (p.billing_reason ? '<div style="font-size:11px;color:var(--dimmer)">' + esc(p.billing_reason) + '</div>' : '') + '</td>' +
        '<td>' + statusPill(p) + '</td>' +
        '<td class="r">' + gross + '</td>' +
        '<td class="r">' + (p.collected ? money(p.fee_amount) : nil()) + '</td>' +
        '<td class="r">' + (p.collected ? money(p.amount_after_fees) : nil()) + '</td>' +
        '<td>' + (p.paid_at ? esc(dateOnly(p.paid_at)) : nil()) + '</td>' +
        '<td><button class="fin-btn" data-whop="' + esc(p.external_payment_id) + '">Detail</button></td>' +
      '</tr>' +
      (S.openWhop === p.external_payment_id ? whopRow() : '');
    }).join('');

    return '<div class="fin-tablewrap"><div class="fin-scroll">' +
      '<table class="fin-table"><thead><tr>' + head + '</tr></thead><tbody>' + body + '</tbody></table>' +
      '</div><div class="fin-foot"><span class="pginfo">' + rows.length +
      (rows.length === 1 ? ' payment' : ' payments') + '</span></div></div>';
  }

  /* The only place whop_payment is read, and it is one row at a time so it can
     never contribute to a total. */
  function whopRow() {
    if (!S.whop) return '<tr class="fin-exp"><td colspan="8"><div class="fin-loading">Reading the Whop record&hellip;</div></td></tr>';
    var w = S.whop;
    var f = function (k, v) {
      return '<dt>' + esc(k) + '</dt><dd>' + (v || v === 0 ? esc(v) : nil()) + '</dd>';
    };
    return '<tr class="fin-exp"><td colspan="8">' +
      '<div style="padding:10px 2px 14px">' +
      '<div class="fin-note" style="margin-bottom:10px">Raw Whop record. Same payment as the row above &mdash; ' +
        '<code>sales_payment</code> and <code>whop_payment</code> mirror each other, and are never summed together.</div>' +
      '<dl class="fin-fields">' +
        f('Receipt', w.receipt_number) +
        f('Whop id', w.whop_payment_id) +
        f('Status', w.status + (w.sub_status ? ' / ' + w.sub_status : '')) +
        (w.failure_reason ? f('Failure', w.failure_reason) : '') +
        f('Method', [w.payment_method_type, w.card_brand, w.card_last4 ? '•••• ' + w.card_last4 : null].filter(Boolean).join(' ')) +
        f('Billing', [w.billing_city, w.billing_state, w.billing_country].filter(Boolean).join(', ')) +
        f('Subtotal', w.subtotal) + f('Fee', w.fee) + f('Tax', w.tax_amount) +
        f('Total incl. fees', w.total_including_fees) +
        (Number(w.refunded_amount) ? f('Refunded', w.refunded_amount) : '') +
        (w.promo_code ? f('Promo', w.promo_code) : '') +
        (w.attempted_count > 1 ? f('Attempts', w.attempted_count) : '') +
        (w.is_test ? f('Test payment', 'yes') : '') +
      '</dl></div></td></tr>';
  }

  function statusPill(p) {
    if (p.collected) return '<span class="fin-flag ok">' + esc(p.status || 'paid') + '</span>';
    return '<span class="fin-flag draft">' + esc(p.status || 'open') + '</span>';
  }

  function subsTable() {
    var rows = S.subs || [];
    if (!rows.length) {
      return '<div class="fin-tablewrap"><div class="fin-empty">' +
        '<b>No subscriptions</b>Nothing in <code>subscription_client</code> for Folio.</div></div>';
    }
    var head = ['Client', 'Status', 'Amount', 'Period', 'Units', 'Started', 'Next bill']
      .map(function (h, i) { return '<th' + (i === 2 ? ' class="r"' : '') + '>' + h + '</th>'; }).join('');
    var body = rows.map(function (s) {
      return '<tr>' +
        '<td>' + esc(s.name || '') +
          (s.email ? '<div style="font-size:11px;color:var(--dimmer)">' + esc(s.email) + '</div>' : '') + '</td>' +
        '<td><span class="fin-flag ' + (s.status === 'active' ? 'ok' : 'draft') + '">' +
          esc(s.status || '') + '</span></td>' +
        '<td class="r">' + money(s.subscription_amount) + '</td>' +
        /* The null that stops MRR existing. Named, not blank. */
        '<td>' + (s.billing_period ? esc(s.billing_period)
                 : '<span style="color:var(--warn-ink)">not recorded</span>') + '</td>' +
        '<td>' + (s.number_of_units || s.number_of_units === 0 ? esc(s.number_of_units) : nil()) + '</td>' +
        '<td>' + (s.start_date ? esc(dateOnly(s.start_date)) : nil()) + '</td>' +
        '<td>' + (s.next_billing_date ? esc(dateOnly(s.next_billing_date)) : nil()) + '</td>' +
      '</tr>';
    }).join('');
    return '<div class="fin-tablewrap"><div class="fin-scroll">' +
      '<table class="fin-table"><thead><tr>' + head + '</tr></thead><tbody>' + body + '</tbody></table>' +
      '</div></div>';
  }

  /* ---- wiring -----------------------------------------------------------
     `.onclick =`, never addEventListener: paint() replaces the subtree and
     mount() runs on every navigation back, so addEventListener would stack a
     copy per paint and fire N requests per click. */
  function wire() {
    var rf = host.querySelector('#ff-refresh');
    if (rf) rf.onclick = function () { S.openWhop = null; S.whop = null; load(); };

    host.querySelectorAll('[data-fftab]').forEach(function (b) {
      b.onclick = function () { S.tab = b.getAttribute('data-fftab'); paint(); };
    });

    host.querySelectorAll('[data-whop]').forEach(function (b) {
      b.onclick = function () {
        var id = b.getAttribute('data-whop');
        if (S.openWhop === id) { S.openWhop = null; S.whop = null; paint(); return; }
        S.openWhop = id; S.whop = null; paint();
        getJson(API + '/payments/' + encodeURIComponent(id) + '/whop')
          .then(function (j) { if (S.openWhop === id) { S.whop = j.payment; paint(); } })
          .catch(function () { if (S.openWhop === id) { S.openWhop = null; paint(); } });
      };
    });
  }

  function mount(el) {
    if (!el) return;
    host = el;
    if (S.summary) { paint(); return; }
    load();
  }

  function invalidate() { S.summary = null; if (host && host.isConnected) load(); }

  return { mount: mount, invalidate: invalidate, state: S };
})();
