/* Folio Excel — Financials and App Users. Whop subscription billing.

   Reads /api/folio/financials. One module, one set of endpoints, so Folio
   cannot report one figure for its money on one screen and a different one
   next door. That is not hypothetical — it is what was here: App Users showed
   "$2,369 MRR · +8% MoM" from six invented subscribers while the real answer
   was one subscriber at $1,000.

     mountReports()  FINANCIALS, and Folio's Overview, which renders the same
                     view: three cards and one table. Nothing else.
                     The nav id behind it is `reports` and the label is
                     "Financials" — Folio has exactly ONE Financials item, and
                     `reports` is the id that can carry it because it is the
                     one with a dashboard_module row. Folio has no
                     `financials` row (verified live 2026-09-07), so an item on
                     that id could never appear.
     mountUsers()    App Users: the same table without the cards.
     mount()         The wider table with filters and CSV export.
                     *** NOTHING ROUTES TO THIS TODAY. *** It was the screen
                     for Folio's `financials` nav id, which was removed when
                     the menu collapsed to one Financials item. It is kept
                     because the /export endpoint behind it is live and
                     tested, and reaching it again is one nav entry. If it is
                     still unrouted next time someone reads this, delete it
                     rather than leaving a screen nobody can open.

   ---------------------------------------------------------------------------
   EVERY NUMBER COMES FROM A QUERY. IF IT CANNOT BE COMPUTED IT SAYS "Not set".

   Never 0. Nobody has said this business manages zero units; what happened is
   that `number_of_units` is NULL. Those are different statements and a card
   reading "0" makes the wrong one.

   ---------------------------------------------------------------------------
   THE THREE CARDS, AND WHAT IS DELIBERATELY NOT ON THEM

   Total monthly subscription ($1,000.00), Total app users (1), Total units
   managed (Not set). No percentage, no arrow, no period-over-period figure on
   any of them: one customer and one month of payment history leaves nothing to
   compare against.

   Gone with the page they were on, and NOT replaced with real versions:
     MRR trend   four invented months (Apr–Jul 2600/2900/3100/3308) whose bars
                 land ~10px apart. The only real payment is 17 Aug 2026.
     ARR         would be MRR × 12 off a billing period nobody has confirmed.
     NRR         needs a prior period to retain.
     Funnel      pipeline stages and lead counts are CRM data and belong on
                 the Leads page. The query is preserved in a comment in
                 folio-financials-api.js.

   ---------------------------------------------------------------------------
   THE VISUAL LANGUAGE IS THE PORTAL'S OWN

   `.kpis`/`.kpi` cards, `.card`, a plain table and `.pill` badges — the markup
   kpi(), card(), tbl() and pill() emit in portal.html, which every other
   screen uses. Badge colours are App Users' own (active green, trialing grey,
   past_due and cancelled rose; paid green, due amber, trial grey, overdue
   rose) so a status reads the same here as anywhere else. The only additions
   in portal-financials.css are the sortable header and its caret.

   ---------------------------------------------------------------------------
   THREE THINGS THIS SCREEN REFUSES TO DO

   1. Show `1600` as units. The value appears to sit in a GHL custom field on
      the linked lead, keyed by an OPAQUE ID WITH NO NAME — inferred from the
      value, never confirmed from a field name, and there is no table anywhere
      holding that mapping. "Not set" until Jay confirms it.

   2. Count `lead.is_client`. It reads 4 for Folio and one of those is a
      paying customer; the others are a test record, an internal contact and
      someone still `open`. Only `subscription_client` knows who pays.

   3. Show the two $1 card tests. There is no `is_test` column, so they are
      matched on a notes string AND a Whop-anonymised email, both applied
      together. With them in, one payment becomes three and $1,000 becomes
      $1,001 — which is what an earlier version of this file reported.
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
    mode: 'financials',  /* 'reports' | 'subscribers' | 'financials' */
    sort: 'amount', dir: 'desc',   /* the spec's default: amount per month, descending */
    summary: null, subs: null, options: null, dateScope: null,
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
  /* Sliced off the ISO string, NEVER formatted through the viewer's timezone.

     paid_at is a timestamptz and the real payment is 2026-08-17T19:06:40Z, so
     toLocaleDateString on that instant renders 18 Aug for any reader east of
     UTC - including Manila, where this is read. A payment's date is a business
     fact, not a moment converted into wherever the browser happens to be, and
     the acceptance check says 2026-08-17. Caught by rendering under
     TZ=Asia/Manila, not by review; a test asserts toLocaleDateString appears
     nowhere in this file. */
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
    /* Every screen reads the same two endpoints, so no two of them can report
       different money for the brand. There is no /funnel call: pipeline data
       is CRM data and belongs on the Leads page. */
    return Promise.all([
      getJson(API + '/summary'),
      getJson(API + '/subscribers?' + qs())
    ]).then(function (out) {
      S.summary = out[0];
      S.subs = out[1].rows || [];
      S.options = out[1].options || null;
      S.dateScope = out[1].date_scope || null;
      /* A filter change can hide the row whose payments are open. */
      if (S.expanded && !S.subs.some(function (r) { return r.id === S.expanded; })) S.expanded = null;
      S.payments = {};
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
      /* App Users is the five-column list and nothing else - it is the same
         table Reports & Financials shows, without the cards above it.

         'financials' is the filter-and-export screen from the earlier spec.
         It keeps the wider table because that is what an export view is for,
         and it is the one Folio screen still unreachable (no dashboard_module
         row), so it cannot contradict anything on screen today. */
      if (S.mode === 'subscribers') {
        return screenHead('App Users', 'Folio Excel &middot; who is subscribed') +
          subscriberCard();
      }
      return header() + filters() + subscriberTable();
    });
  }

  /* ---- Reports & Financials --------------------------------------------
     Three cards and one table. Nothing else, by instruction.

     THE VISUAL LANGUAGE IS THE PORTAL'S OWN, not a new one: `.kpis`/`.kpi`
     cards, a `.card` wrapper, a plain table and `.pill` badges, which is what
     kpi(), card(), tbl() and pill() in portal.html emit and what every other
     screen in the app uses. The badge colours are the ones App Users used
     (active green, trialing grey, anything else rose; paid green, due amber,
     trial grey, overdue rose), so a status reads the same here as anywhere.

     WHAT IS DELIBERATELY ABSENT
     - No percentage, arrow or period-over-period figure on any card. One
       customer, one month of payment history, nothing to compare against.
     - No MRR trend, ARR, NRR or conversion rate. All four were fabricated on
       the version this replaces: MRR $2,369 and ARR $28.4K off six invented
       subscribers, NRR 104% off nothing at all, and an Apr–Jul bar chart whose
       only real payment is dated 17 Aug 2026.
     - No funnel, stage list or lead count. That is CRM data and belongs on
       the Leads page; the query it used is preserved in a comment in
       folio-financials-api.js.

     Icons come from portal.html's `I` map when this runs inside the portal and
     are simply absent otherwise, so the module never depends on a load order
     it cannot see. */
  function icon(n) {
    try { return (typeof I !== 'undefined' && I && I[n]) || ''; } catch (e) { return ''; }
  }

  /* kpi() in portal.html, reproduced: the module cannot call a helper that is
     script-scoped in another file, so it emits the same markup instead. The
     delta slot carries a SOURCE, never a change: `dc` (which colours a delta
     green or red) is never passed. */
  function kpiCard(ic, label, value, sub) {
    return '<div class="kpi">' +
      '<div class="k">' + icon(ic) + ' ' + esc(label) + '</div>' +
      '<div class="v">' + value + '</div>' +
      (sub ? '<div class="d">' + sub + '</div>' : '') +
      '</div>';
  }

  function reportsView() {
    return shell(function () {
      var s = S.summary;
      return screenHead('Financials', 'Folio Excel &middot; Whop subscription billing') +
        cards(s) + subscriberCard();
    });
  }

  /* The screen names itself, because portal.html suppresses its generic
     `page-h` for this view. That suppression is deliberate: the generic header
     also renders a "New" button wherever the caller can write, and this
     feature cannot write anything at all. */
  function screenHead(title, sub) {
    return '<div class="fin-head"><div>' +
      '<h1 class="fin-title">' + esc(title) + '</h1>' +
      '<p class="fin-sub">' + sub + '</p>' +
      '</div></div>';
  }

  function cards(s) {
    /* Card 1. The PLAIN sum of subscription_amount, which is what "total
       monthly subscription" means. The caveat sits in the sub-line because
       billing_period is NULL: calling $1,000 a monthly total is an assumption,
       and if a period ever says otherwise the sub-line says that instead. */
    var amount = plain(s.monthly_subscription);
    var amountSub = s.non_monthly > 0
      ? esc(s.non_monthly + ' subscription' + (s.non_monthly === 1 ? '' : 's') +
            ' not billed monthly - this total is not a monthly figure')
      : (s.period_unknown > 0
          ? esc('assumed monthly - billing_period not set on ' + s.period_unknown +
                ' of ' + s.active_subscribers)
          : 'billing_period: monthly');

    /* Card 3. NULL means nobody has recorded a unit count, which is not the
       same as zero, so the card says "Not set". A partial total states its own
       coverage rather than quietly under-reporting. */
    var unitsKnown = s.units_known || 0;
    var unitsCard;
    if (!unitsKnown) {
      unitsCard = kpiCard('grid', 'Total units managed', 'Not set',
        esc('number_of_units is not recorded on ' +
            (s.active_subscribers === 1 ? 'the subscriber' : 'any subscriber')));
    } else {
      unitsCard = kpiCard('grid', 'Total units managed',
        Number(s.units_managed).toLocaleString('en-US'),
        unitsKnown < s.active_subscribers
          ? esc('from ' + unitsKnown + ' of ' + s.active_subscribers + ' subscribers')
          : 'all subscribers reporting');
    }

    return '<div class="kpis">' +
      kpiCard('dollar', 'Total monthly subscription', amount, amountSub) +
      kpiCard('users', 'Total app users', String(s.active_subscribers),
              esc('active subscription_client rows')) +
      unitsCard +
      '</div>';
  }

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
      /* No lead link here either, for the same reason as the five-column
         table above. */
      return '<span class="fin-etoggle">' + (S.expanded === row.id ? '&#9662;' : '&#9656;') +
        '</span>' + esc(row.business || '');
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

  /* ---- the subscriber table -------------------------------------------
     Five columns, per the spec, in the portal's own table and badges. It is
     the App Users list as well: for a SaaS, the people who pay you ARE the
     app users, and both screens render this one function so they cannot
     disagree about how many there are.

     `company` is the business name and it is GHL-sourced and authoritative.
     NOT sales_payment.customer_name, which is Whop's billing-address version
     ("J & M Real Estate and Property Management Brandi"). */
  var SORTS = [
    { key: 'business', label: 'Business name' },
    { key: 'units', label: 'Number of units', r: 1 },
    { key: 'amount', label: 'Amount per month', r: 1 },
    { key: 'status', label: 'Status' },
    { key: 'payment_status', label: 'Payment status' }
  ];

  /* Badge colours as App Users had them: active is good, a trial is neutral,
     anything else needs looking at. Unknown values fall through to grey rather
     than to a colour that would assert something about a state nobody has
     defined. */
  function statusPill(v) {
    var t = String(v == null ? '' : v);
    var c = t === 'active' ? 'green'
          : (t === 'trialing' || t === 'trial') ? 'gray'
          : (t === 'past_due' || t === 'cancelled') ? 'rose' : 'gray';
    return t ? '<span class="pill ' + c + '">' + esc(t.replace(/_/g, ' ')) + '</span>' : nil();
  }
  function payPill(v) {
    var t = String(v == null ? '' : v);
    var c = t === 'paid' ? 'green'
          : t === 'due' ? 'amber'
          : t === 'trial' ? 'gray'
          : t === 'overdue' ? 'rose' : 'gray';
    return t ? '<span class="pill ' + c + '">' + esc(t.replace(/_/g, ' ')) + '</span>' : nil();
  }

  function sortedSubs() {
    var rows = (S.subs || []).slice();
    var k = S.sort, dir = S.dir === 'asc' ? 1 : -1;
    return rows.sort(function (a, b) {
      var x = a[k], y = b[k];
      /* Nulls last in BOTH directions: `number_of_units` is null on every row
         today, and a null that sorts to the top of a descending column looks
         like the largest value. */
      if (x === null || x === undefined) return y === null || y === undefined ? 0 : 1;
      if (y === null || y === undefined) return -1;
      if (typeof x === 'number' && typeof y === 'number') return (x - y) * dir;
      return String(x).localeCompare(String(y)) * dir;
    });
  }

  function subCell5(key, row) {
    if (key === 'business') {
      /* PLAIN TEXT, not a link. The spec asked for the name to link through to
         the lead record; that was dropped by instruction. The whole row is
         still clickable and opens the payment history, so a link inside it was
         also two different actions in one cell.

         `lead_id` still rides on the payload - it is a column on
         subscription_client and costs nothing - so a link is one line away if
         it is ever wanted. */
      return '<span class="fin-etoggle">' + (S.expanded === row.id ? '&#9662;' : '&#9656;') +
        '</span>' + esc(row.business || '');
    }
    if (key === 'units') {
      /* NULL, and named as such. The value appears to be in a GHL custom field
         keyed by an opaque id (1600, probably units) - inferred from the value,
         never confirmed from a field name, so it is not displayed. */
      return row.units === null || row.units === undefined
        ? notSet(row.not_set_reason)
        : Number(row.units).toLocaleString('en-US');
    }
    if (key === 'amount') {
      return money(row.amount) + (row.currency && row.currency !== 'USD'
        ? ' <span class="fin-sub">' + esc(row.currency) + '</span>' : '');
    }
    if (key === 'status') return statusPill(row.status);
    if (key === 'payment_status') return payPill(row.payment_status);
    var v = row[key];
    return v === null || v === undefined || v === '' ? nil() : esc(v);
  }

  function subscriberCard() {
    var rows = sortedSubs();
    if (!rows.length) {
      return '<div class="card"><div class="card-h">' + icon('users') +
        ' App users</div><div class="card-b">' +
        '<div class="fin-empty">No subscriber recorded for Folio Excel.</div></div></div>';
    }

    var head = SORTS.map(function (c) {
      var on = S.sort === c.key;
      return '<th class="' + (c.r ? 'r ' : '') + 'fin-sortable' + (on ? ' on' : '') + '"' +
        ' data-sort="' + esc(c.key) + '">' + esc(c.label) +
        (on ? '<span class="fin-caret">' + (S.dir === 'asc' ? '&#9650;' : '&#9660;') + '</span>' : '') +
        '</th>';
    }).join('');

    var body = rows.map(function (row) {
      var open = S.expanded === row.id;
      var tr = '<tr class="fin-erow' + (open ? ' open' : '') + '" data-sub="' + esc(row.id) + '">' +
        SORTS.map(function (c) {
          return '<td' + (c.r ? ' class="r"' : '') + '>' + subCell5(c.key, row) + '</td>';
        }).join('') + '</tr>';
      if (!open) return tr;
      return tr + '<tr class="fin-exp"><td colspan="' + SORTS.length + '">' +
        paymentsPanel(row) + '</td></tr>';
    }).join('');

    return '<div class="card"><div class="card-h">' + icon('users') + ' App users' +
      '<span class="badge">' + rows.length + '</span></div>' +
      '<div class="card-b flush"><table class="fin-etable"><thead><tr>' + head + '</tr></thead>' +
      '<tbody>' + body + '</tbody></table></div></div>';
  }

  /* THE PROVENANCE LINE IS GONE, by instruction. It read:

       "Ledger: 1 Whop transaction, $1,000.00 in - reconciles with collected
        payments. sales_payment has no is_test column. Test rows are matched
        on a notes string plus a Whop-anonymised email; a note edit would
        break it."

     Both facts still matter and neither is lost:
       - the ledger reconciliation is asserted by test-folio-financials.js
         against `summary.ledger.reconciles`, so a drift between the payment
         stream and `transaction` fails a test rather than needing a reader to
         notice a sentence;
       - the provisional test-payment filter is stated in the provenance block
         of every CSV export, which is where a figure leaving this system needs
         its caveats.

     `/summary` still returns `ledger` and `test_filter` for exactly those two
     consumers. */

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

    /* Column sort. Purely client-side: the whole result set is already here
       (one row today), so a round trip would buy nothing and lose the open
       payment panel. Clicking the active column flips direction. */
    host.querySelectorAll('[data-sort]').forEach(function (th) {
      th.onclick = function () {
        var k = th.getAttribute('data-sort');
        if (S.sort === k) S.dir = S.dir === 'asc' ? 'desc' : 'asc';
        else { S.sort = k; S.dir = k === 'amount' || k === 'units' ? 'desc' : 'asc'; }
        paint();
      };
    });

    host.querySelectorAll('.fin-erow').forEach(function (tr) {
      tr.onclick = function () {
        /* No guard needed: there is nothing clickable inside the row now that
           the business name is plain text, so the whole row toggles. */
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
  /* UNROUTED — see the header. Kept for the CSV export, which is live. */
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
    if ((!S.summary || !S.subs) && !S.loading) load();
    else if (switched) paint();
    else paint();
  }

  function invalidate() {
    S.payments = {};
    if (host) load(); else S.summary = null;
  }

  return { mount: mount, mountReports: mountReports, mountUsers: mountUsers,
           invalidate: invalidate, _state: S };
})();
