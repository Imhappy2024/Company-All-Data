/* Folio Excel financials — Whop subscription billing. READ-ONLY.

   Mounted at /api/folio/financials. Built to FOLIO_FINANCIAL_DASHBOARD_SPEC,
   verified against the live database on 2026-09-07.

   ---------------------------------------------------------------------------
   FOLIO HAS EXACTLY ONE PAYING CUSTOMER. THAT IS THE WHOLE DESIGN.

   Not a placeholder and not a filter artefact — one. So no figure this API
   serves is period-over-period, and there is nothing to draw a trend from:
   one customer and one month of payment history cannot support a MoM figure,
   and putting a real number into a shape that implies one is the same mistake
   as the invented $2,369 MRR this replaces, with better inputs.

   What it serves: the three card figures (/summary), the subscriber table
   (/subscribers), the payment history under a row
   (/subscribers/:id/payments), and a CSV export (/export).

   /funnel is GONE. Pipeline stages and lead counts are CRM data and belong on
   the Leads page; the query is preserved in a comment where the route was.

   EVERY FIGURE THAT CANNOT BE COMPUTED IS RETURNED AS NULL, NEVER AS 0, so the
   screen can say "Not set". `units_managed` is the live case: nobody has
   recorded a unit count, which is a different statement from "they manage
   none", and a 0 here would make the wrong one.

   ---------------------------------------------------------------------------
   WHY THIS IS A SEPARATE MODULE AND NOT A BRAND FILTER ON financials-api.js

   Folio shares no tables with the property screens except `transaction`.
   Verified: financial_account reachable from Folio 0, deal 0, statement 0.
   A brand parameter on that API would have produced a working screen showing
   zeros forever, which reads as "Folio has no money" rather than "these are
   the wrong tables".

   ---------------------------------------------------------------------------
   THREE THINGS THIS MODULE MUST NEVER DO

   1. NEVER COUNT lead.is_client. It reads 4 for Folio and one of those is a
      paying customer: the other three are a test record ("jay test"), an
      internal row (Liquid Lending) and a lead flagged while still open.
      `subscription_client` is the only trustworthy subscriber count. A test
      asserts no count in any payload equals 4.

   2. NEVER SUM sales_payment FOR MRR. Two of the three rows are $1 card
      tests, and a sum conflates a monthly renewal with an annual prepayment.
      MRR comes from subscription_client.subscription_amount, normalised by
      billing_period.

   3. NEVER READ transaction.company_id. The column does not exist — this is
      not an oversight to work around. Folio's ledger rows are reached by
      entity_id (or financial_account_id).

   ---------------------------------------------------------------------------
   THE TEST-PAYMENT FILTER IS PROVISIONAL AND SAYS SO

   `sales_payment` has NO is_test flag. The two $1 tests are identifiable only
   by a string in `notes` plus the fact that Whop anonymised their email to
   `…@deleted.com`. Both conditions are applied together, and both agree on
   the same two rows today.

   A string match on a free-text notes field WILL break the first time someone
   edits a note, silently and in the direction of inflating revenue. This needs
   `sales_payment.is_test`; that is Jay's call, not this module's.

   ---------------------------------------------------------------------------
   Money: `usd_total` for display and maths, `amount_after_fees` for net,
   `fee_amount` for the Whop cut. On the one real payment that is
   1000.00 / 959.63 / 40.37 — the fee is 4% and real, and it disappears if
   only the gross is shown.
   --------------------------------------------------------------------------- */

const express = require('express');
const db = require('./supabase-db');
const { stringify } = require('csv-stringify');
const { arrayParam } = require('./financials-api');

const TENANT_ID = '72381c81-af95-4e1d-ad0d-20a3a3421119';
const FOLIO_COMPANY_ID = 'c0000000-0000-4000-8000-000000000002';
const FOLIO_ENTITY_ID = '32bec21a-b52f-49db-93fb-fea5a594b480';

/* The Whop processor account. Deliberately account_kind = 'processor' and not
   'bank', which is what keeps Folio revenue out of v_cash_by_entity_quarter
   and the property cash and debt dashboards. Do not "fix" that. */
const WHOP_FOLIO_ACCOUNT_ID = 'b8e55fa7-8967-4bea-9b71-57c5498136ff';

const WRITE_SQL = /\b(insert|update|delete|truncate|drop|alter|create|grant|revoke|copy|merge)\b/i;

/* Read-only is enforced twice. supabase-db connects with SUPABASE_DB_URL,
   which is the postgres superuser, so RLS never runs and a stray write would
   simply succeed — nothing downstream would catch it. */
async function q(sql, params) {
  if (WRITE_SQL.test(sql)) {
    throw new Error('folio-financials-api is read-only; refused a statement containing a write verb');
  }
  if (/\btransaction\s*\.\s*company_id\b|\bt\.company_id\b/i.test(sql)) {
    throw new Error('transaction has no company_id column; scope Folio by entity_id');
  }
  const r = await db.q(sql, params);
  return r.rows;
}

/* ---- the test-payment predicate ------------------------------------------
   Provisional, per the header. Written as a fragment so every query that
   touches payments uses the same definition and they cannot drift apart. */
const IS_TEST = `(sp.notes ilike '%TEST TRANSACTION%' or sp.customer_email like '%@deleted.com')`;

/* ---- subscribers ---------------------------------------------------------
   Scoped by business_entity_id: subscription_client has no company_id, it
   reaches the brand through the entity. `company` is the GHL-sourced business
   name and is authoritative — sales_payment.customer_name is the messy Whop
   billing-address version ("J & M Real Estate and Property Management Brandi")
   and must never be shown as the business. */
/* NO JOIN TO `lead`. The table needs nothing from it - `lead_id` is a column
   on subscription_client and is all the business-name link requires - and
   pipeline stages are CRM data that must not appear on a financial page.

   The join used to be here for `pipeline_stage` and a count of the lead's GHL
   custom fields. Both are gone with the funnel. If anything ever does read
   `lead.custom_fields` again it MUST be guarded with
   `jsonb_typeof(custom_fields) = 'array'`: the column is mixed type (4,642
   Folio rows hold an array, 3 hold an object) and jsonb_array_length on an
   object row throws for the whole query, not just that row. A test asserts
   the column is never read unguarded. */
const SUBS_SQL = `
  select sc.id, sc.company, sc.name, sc.email, sc.phone,
         sc.number_of_units, sc.subscription_plan_id, sc.subscription_amount,
         sc.currency, sc.billing_period, sc.status, sc.payment_status,
         sc.start_date, sc.provider, sc.external_subscription_id,
         sc.next_billing_date, sc.cancelled_at, sc.lead_id,
         (select max(sp.paid_at) from public.sales_payment sp
           where sp.provider = sc.provider
             and sp.external_subscription_id = sc.external_subscription_id
             and sp.status = 'paid'
             and not ${IS_TEST}) as last_payment_at
    from public.subscription_client sc
   where sc.tenant_id = $1 and sc.business_entity_id = $2::uuid`;

/* ---- payments ------------------------------------------------------------ */
const PAY_COLS = `
  sp.id, sp.external_payment_id, sp.external_subscription_id,
  sp.customer_name, sp.customer_email, sp.product_name, sp.billing_reason,
  sp.status, sp.substatus, sp.currency,
  sp.total, sp.usd_total, sp.fee_amount, sp.amount_after_fees,
  sp.tax_amount, sp.refunded_amount, sp.paid_at, sp.refunded_at,
  sp.source_created_at,
  sp.raw->'payment_instrument'->>'display_name' as card,
  sp.raw->>'receipt_number'  as receipt_number,
  sp.raw->>'failure_message' as failure_message,
  ${IS_TEST} as is_test,
  /* one_time and manual are one-offs; every other billing_reason recurs.
     Route on this, never on which table the row came from. */
  (sp.billing_reason in ('one_time', 'manual')) as one_off`;

const PAY_FROM = `
    from public.sales_payment sp
   where sp.tenant_id = $1 and sp.company_id = $2::uuid`;

/* ---- filters ------------------------------------------------------------- */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const NOT_SET = '(not set)';

function dateParam(v) {
  const s = v === undefined || v === null ? '' : String(v).trim();
  return ISO_DATE.test(s) ? s : null;
}

/* Off unless explicitly asked for. A default that included the $1 tests would
   report 3 payments and $1,001 of revenue against a real 1 and $1,000. */
function includeTest(req) {
  const v = String(req.query.include_test === undefined ? '' : req.query.include_test).toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

function readFilters(req) {
  let from = dateParam(req.query.from);
  let to = dateParam(req.query.to);
  /* A backwards range is a slip, not a request for nothing. */
  if (from && to && from > to) { const t = from; from = to; to = t; }
  return {
    status: arrayParam(req, 'status'),
    payment_status: arrayParam(req, 'payment_status'),
    billing_period: arrayParam(req, 'billing_period'),
    plan: arrayParam(req, 'plan'),
    provider: arrayParam(req, 'provider'),
    from, to,
    include_test: includeTest(req),
  };
}

/* `cardinality($n) = 0 or col = any($n)` so "nothing selected" means "all"
   with no branching, and an empty selection can never emit `in ()`.

   Nullable columns are matched through coalesce to '(not set)', so the one
   subscriber — whose billing_period and plan are both NULL — stays reachable
   from its own filter. A value nobody can select is a row nobody can find. */
function subscriberWhere(f, P) {
  const w = [];
  if (f.status.length) w.push(`coalesce(sc.status, '${NOT_SET}') = any(${P(f.status)}::text[])`);
  if (f.payment_status.length) w.push(`coalesce(sc.payment_status, '${NOT_SET}') = any(${P(f.payment_status)}::text[])`);
  if (f.billing_period.length) w.push(`coalesce(sc.billing_period, '${NOT_SET}') = any(${P(f.billing_period)}::text[])`);
  if (f.plan.length) w.push(`coalesce(sc.subscription_plan_id::text, '${NOT_SET}') = any(${P(f.plan)}::text[])`);
  if (f.provider.length) w.push(`coalesce(sc.provider, '${NOT_SET}') = any(${P(f.provider)}::text[])`);
  /* The date range is on paid_at, which lives on payments — so on the
     subscriber table it means "has a payment in this range". The screen says
     so whenever a range is set, because otherwise a subscriber vanishing from
     a list of subscribers looks like a bug. `Last payment` keeps showing the
     true latest payment rather than the latest in range. */
  if (f.from || f.to) {
    const bits = [`sp.provider = sc.provider`,
                  `sp.external_subscription_id = sc.external_subscription_id`,
                  `sp.paid_at is not null`];
    if (!f.include_test) bits.push(`not ${IS_TEST}`);
    if (f.from) bits.push(`sp.paid_at >= ${P(f.from)}::date`);
    if (f.to) bits.push(`sp.paid_at < (${P(f.to)}::date + 1)`);
    w.push(`exists (select 1 from public.sales_payment sp where ${bits.join(' and ')})`);
  }
  return w;
}

function paymentWhere(f, P, subId) {
  const w = [];
  if (!f.include_test) w.push(`not ${IS_TEST}`);
  if (subId !== undefined) {
    /* The two test payments have a NULL external_subscription_id — Whop never
       attached them to a membership — so a plain join on the subscription id
       excludes them whatever include_test says. Widening to the brand's
       unattached test rows is what makes the toggle do what it promises: it
       adds those two and nothing else. */
    if (f.include_test) {
      w.push(`(sp.external_subscription_id = ${P(subId)} or (sp.external_subscription_id is null and ${IS_TEST}))`);
    } else {
      w.push(`sp.external_subscription_id = ${P(subId)}`);
    }
  }
  if (f.status.length) w.push(`coalesce(sp.status, '${NOT_SET}') = any(${P(f.status)}::text[])`);
  if (f.provider.length) w.push(`coalesce(sp.provider, '${NOT_SET}') = any(${P(f.provider)}::text[])`);
  if (f.from) w.push(`sp.paid_at >= ${P(f.from)}::date`);
  if (f.to) w.push(`sp.paid_at < (${P(f.to)}::date + 1)`);
  return w;
}

/* ---- MRR ----------------------------------------------------------------
   From subscription_client, normalised by billing_period. The
   coalesce(billing_period, 'monthly') is A STATED ASSUMPTION, NOT A FACT: the
   column is NULL on the only subscriber, and $1,000 a month against $1,000 a
   year is a twelvefold difference. `mrr_assumption` carries that sentence to
   the UI, which must display it. */
const MRR_SQL = `
  select count(*)::int as active_subscribers,
         coalesce(sum(
           case lower(coalesce(sc.billing_period, 'monthly'))
             when 'monthly'   then sc.subscription_amount
             when 'quarterly' then sc.subscription_amount / 3
             when 'annual'    then sc.subscription_amount / 12
             when 'yearly'    then sc.subscription_amount / 12
             else sc.subscription_amount
           end), 0) as mrr,
         count(*) filter (where sc.billing_period is null)::int as period_unknown,
         count(*) filter (where lower(sc.billing_period) not in ('monthly'))::int as non_monthly,
         /* "Total monthly subscription" on the card is the PLAIN sum, which is
            what the spec asks for. It only differs from the mrr figure above
            once a billing_period is recorded as something other than monthly,
            and non_monthly is what lets the screen say so instead of
            labelling an annual amount "monthly".

            (No backticks in this comment: it sits inside a template literal,
            and one would end the SQL string mid-query.) */
         sum(sc.subscription_amount) as monthly_subscription,
         /* NULL when NO active row carries a unit count, which is the case
            today. The card must read "Not set" rather than 0: nobody has said
            this business manages zero units. units_known is what lets a
            partial total admit the gap ("from 1 of 3 subscribers") instead of
            quietly under-reporting. */
         sum(sc.number_of_units)   as units_managed,
         count(sc.number_of_units)::int as units_known,
         min(sc.currency) as currency,
         count(distinct sc.currency)::int as currencies
    from public.subscription_client sc
   where sc.tenant_id = $1
     and sc.business_entity_id = $2::uuid
     and sc.status = 'active'
     and sc.cancelled_at is null`;

function folioFinancialsRoutes() {
  const r = express.Router();

  r.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return res.status(405).set('Allow', 'GET, HEAD')
        .json({ error: 'The Folio financials API is read-only.' });
    }
    if (!db.enabled) {
      return res.status(503).json({
        configured: false,
        error: 'SUPABASE_DB_URL is not set, so there are no Folio financials to read.',
      });
    }
    next();
  });

  const fail = (res, err) => {
    if (err && err.code === '22P02') return res.status(400).json({ error: 'That is not a valid id.' });
    console.error('[folio-financials]', err && err.message);
    res.status(500).json({ error: (err && err.message) || 'query failed' });
  };

  /* Every query is parameterised through this, so a filter value can never
     reach the SQL text. */
  const binder = (seed) => {
    const params = seed.slice();
    const P = (v) => `$${params.push(v)}`;
    P.params = params;
    return P;
  };
  const T = () => [TENANT_ID, FOLIO_ENTITY_ID];
  const C = () => [TENANT_ID, FOLIO_COMPANY_ID];

  /* ---- summary ---------------------------------------------------------
     No tiles are built from this. It is the header line: subscriber count,
     MRR, and the assumption behind the MRR in words. */
  r.get('/summary', async (req, res) => {
    try {
      const [m] = await q(MRR_SQL, T());

      /* Ledger cross-check. `transaction` mirrors Whop revenue so cash
         reconciles, and this is the only place the two are compared: a
         payment stream that has drifted from the ledger is worth one line of
         UI, and an acceptance check nobody can run from the screen is one
         nobody runs. Scoped by entity_id — transaction has no company_id. */
      const [led] = await q(
        `select count(*)::int as rows,
                coalesce(sum(t.amount) filter (where t.direction = 'inflow'), 0)  as inflow,
                coalesce(sum(t.amount) filter (where t.direction = 'outflow'), 0) as outflow
           from public.transaction t
          where t.tenant_id = $1 and t.entity_id = $2::uuid and t.source_system = 'whop'`, T());

      /* Revenue to date, the Whop cut, and the net — all three, because the
         fee is 4% of this volume and the gross alone hides it. Every figure
         here EXCLUDES the two $1 card tests, and `first_paid_at` is what lets
         the screen say why there is no trend instead of just omitting one. */
      const [pay] = await q(
        `select count(*)::int as payments,
                coalesce(sum(sp.usd_total), 0)         as collected_usd,
                coalesce(sum(sp.fee_amount), 0)        as fees_usd,
                coalesce(sum(sp.amount_after_fees), 0) as net_usd,
                coalesce(sum(sp.refunded_amount), 0)   as refunded_usd,
                min(sp.paid_at) as first_paid_at,
                max(sp.paid_at) as last_paid_at,
                count(distinct date_trunc('month', sp.paid_at))::int as months
           from public.sales_payment sp
          where sp.tenant_id = $1 and sp.company_id = $2::uuid
            and sp.status = 'paid' and not ${IS_TEST}`, C());

      const mrr = Number(m.mrr);
      const assumption = m.period_unknown > 0
        ? `billing_period not set on ${m.period_unknown} of ${m.active_subscribers} `
          + `active subscriber${m.active_subscribers === 1 ? '' : 's'}; assumed monthly`
        : 'billing_period is set on every active subscriber';

      res.json({
        active_subscribers: m.active_subscribers,
        mrr,
        mrr_assumption: assumption,
        /* So the UI never has to infer whether the caveat applies. */
        mrr_assumed: m.period_unknown > 0,
        /* The three card figures. `units_managed` stays NULL rather than
           becoming 0 — the card renders "Not set" off exactly that. */
        monthly_subscription: num(m.monthly_subscription),
        units_managed: num(m.units_managed),
        units_known: m.units_known,
        period_unknown: m.period_unknown,
        non_monthly: m.non_monthly,
        currency: m.currencies > 1 ? 'mixed' : (m.currency || 'USD'),
        as_of: new Date().toISOString(),
        /* Stated, not implied: `months` is COUNTED, so "no trend" is a fact
           about the data rather than a hardcoded sentence that would keep
           saying "one month" forever. It flips on its own at the second
           month's payment, and the note names the count either way. */
        history: {
          payments: pay.payments,
          collected_usd: Number(pay.collected_usd),
          fees_usd: Number(pay.fees_usd),
          net_usd: Number(pay.net_usd),
          refunded_usd: Number(pay.refunded_usd),
          first_paid_at: pay.first_paid_at,
          last_paid_at: pay.last_paid_at,
          months: pay.months,
          trend_available: pay.months > 1,
          trend_note: pay.months <= 1
            ? `No trend available — ${pay.months === 1 ? 'one month' : 'no months'} `
              + 'of payment history.'
            : `${pay.months} months of payment history.`,
        },
        ledger: {
          rows: led.rows,
          inflow: Number(led.inflow),
          outflow: Number(led.outflow),
          reconciles: Number(led.inflow) === Number(pay.collected_usd),
          source: 'transaction where source_system = whop, scoped by entity_id',
        },
        test_filter: {
          provisional: true,
          note: 'sales_payment has no is_test column. Test rows are matched on a '
              + 'notes string plus a Whop-anonymised email; a note edit would break it.',
        },
      });
    } catch (err) { fail(res, err); }
  });

  /* ---- subscribers ----------------------------------------------------- */
  r.get('/subscribers', async (req, res) => {
    try {
      const f = readFilters(req);
      const P = binder(T());
      const where = subscriberWhere(f, P);
      const rows = await q(
        `${SUBS_SQL}${where.length ? ' and ' + where.join(' and ') : ''}
         order by sc.subscription_amount desc nulls last, sc.company`, P.params);

      /* Option lists come from the unfiltered set, so a selection can never
         remove its own option. NULL is offered as '(not set)'. */
      const O = binder(T());
      const [opts] = await q(
        `select
           (select array_agg(distinct coalesce(status, '${NOT_SET}')) from s)          as status,
           (select array_agg(distinct coalesce(payment_status, '${NOT_SET}')) from s)  as payment_status,
           (select array_agg(distinct coalesce(billing_period, '${NOT_SET}')) from s)  as billing_period,
           (select array_agg(distinct coalesce(subscription_plan_id::text, '${NOT_SET}')) from s) as plan,
           (select array_agg(distinct coalesce(provider, '${NOT_SET}')) from s)        as provider
         from (select sc.status, sc.payment_status, sc.billing_period,
                      sc.subscription_plan_id, sc.provider
                 from public.subscription_client sc
                where sc.tenant_id = $1 and sc.business_entity_id = $2::uuid) s`, O.params);

      res.json({
        rows: rows.map(shapeSubscriber),
        total_count: rows.length,
        filters: f,
        options: opts,
        /* Only when it applies, so the note is never noise. */
        date_scope: (f.from || f.to)
          ? 'The date range is on paid_at, so this lists subscribers with a payment in that range. '
            + '"Last payment" still shows the latest payment overall.'
          : null,
      });
    } catch (err) { fail(res, err); }
  });

  /* ---- payment history, per subscriber --------------------------------- */
  r.get('/subscribers/:id/payments', async (req, res) => {
    try {
      const f = readFilters(req);
      const S = binder(T());
      const sub = await q(
        `select sc.id, sc.company, sc.provider, sc.external_subscription_id
           from public.subscription_client sc
          where sc.tenant_id = $1 and sc.business_entity_id = $2::uuid
            and sc.id = ${S(String(req.params.id))}::uuid`, S.params);
      if (!sub.length) return res.status(404).json({ error: 'No Folio subscriber with that id.' });

      const P = binder(C());
      const where = paymentWhere(f, P, sub[0].external_subscription_id);
      const rows = await q(
        `select ${PAY_COLS} ${PAY_FROM}${where.length ? ' and ' + where.join(' and ') : ''}
         order by sp.paid_at desc nulls last, sp.source_created_at desc nulls last`, P.params);

      res.json({
        subscriber: { id: sub[0].id, company: sub[0].company,
                      external_subscription_id: sub[0].external_subscription_id },
        rows: rows.map(shapePayment),
        total_count: rows.length,
        include_test: f.include_test,
        /* Gross, fee and net are three columns for a reason: the fee is 4% of
           the one real payment and vanishes if only the gross is shown. */
        totals: totalsOf(rows),
      });
    } catch (err) { fail(res, err); }
  });

  /* ---- every Folio payment (the export view, and a flat list) ---------- */
  r.get('/payments', async (req, res) => {
    try {
      const f = readFilters(req);
      const P = binder(C());
      const where = paymentWhere(f, P);
      const rows = await q(
        `select ${PAY_COLS} ${PAY_FROM}${where.length ? ' and ' + where.join(' and ') : ''}
         order by sp.paid_at desc nulls last, sp.source_created_at desc nulls last`, P.params);
      res.json({ rows: rows.map(shapePayment), total_count: rows.length,
                 include_test: f.include_test, totals: totalsOf(rows), filters: f });
    } catch (err) { fail(res, err); }
  });

  /* The funnel was here and is GONE, by instruction: pipeline stages and lead
     counts are CRM data and belong on the Leads page, not on a financial one.
     The query it ran, if it is wanted there:

       select coalesce(pipeline_stage, 'No stage') as stage, count(*) as leads
         from public.lead
        where tenant_id = $1 and company_id = $2::uuid
        group by 1 order by 2 desc, 1;

     Two things that cost time to establish and should not be re-derived:
     Folio has 4,645 leads with 4,637 carrying NO stage, and the eight staged
     ones are Closed Won 3, Demo Complete 2, Demo Scheduled 1, Onboard
     Initiated 1, Qualified 1. Any "paying" figure beside them comes from
     subscription_client, never from lead.is_client, which reads 4. */

  /* ---- export ---------------------------------------------------------- */
  r.get('/export', async (req, res) => {
    try {
      const view = req.query.view === 'payments' ? 'payments' : 'subscribers';
      const f = readFilters(req);
      const meta = {
        exportedAt: new Date().toISOString(),
        exportedBy: exportedBy(req),
        filtersApplied: describeFolioFilters(f),
      };

      let cols, rows;
      if (view === 'payments') {
        const P = binder(C());
        const where = paymentWhere(f, P);
        const raw = await q(
          `select ${PAY_COLS} ${PAY_FROM}${where.length ? ' and ' + where.join(' and ') : ''}
           order by sp.paid_at desc nulls last`, P.params);
        rows = raw.map(shapePayment);
        cols = PAYMENT_EXPORT_COLUMNS;
      } else {
        const P = binder(T());
        const where = subscriberWhere(f, P);
        const raw = await q(
          `${SUBS_SQL}${where.length ? ' and ' + where.join(' and ') : ''}
           order by sc.subscription_amount desc nulls last`, P.params);
        rows = raw.map(shapeSubscriber);
        cols = SUBSCRIBER_EXPORT_COLUMNS;
      }

      /* The file is the full filtered result set, never the page on screen. */
      sendCsv(res, view, cols, rows, meta, f);
    } catch (err) {
      if (res.headersSent) return res.end();
      fail(res, err);
    }
  });

  return r;
}

/* ---- shaping ------------------------------------------------------------
   Units, plan and billing period are NULL on the only subscriber. They are
   returned as null with an explicit `not_set` list, so the UI renders
   "Not set" rather than a blank cell — and so nothing downstream mistakes an
   absent value for a zero.

   The values appear to exist in GHL custom fields on the linked lead, keyed by
   OPAQUE IDS WITH NO NAMES. The likely reading is units 1600, period Monthly,
   plan "Founding Customer", but that is inferred from the values themselves,
   not confirmed from field names, and there is no table anywhere holding the
   id-to-name mapping. So none of it is displayed. */
function shapeSubscriber(r) {
  const notSet = [];
  if (r.number_of_units === null) notSet.push('units');
  if (r.subscription_plan_id === null) notSet.push('plan');
  if (r.billing_period === null) notSet.push('billing_period');
  return {
    id: r.id,
    /* GHL-sourced and authoritative. NOT sales_payment.customer_name. */
    business: r.company,
    contact: r.name,
    email: r.email,
    phone: r.phone,
    units: r.number_of_units,
    plan: r.subscription_plan_id,
    amount: num(r.subscription_amount),
    currency: r.currency,
    billing_period: r.billing_period,
    status: r.status,
    payment_status: r.payment_status,
    start_date: r.start_date,
    next_billing_date: r.next_billing_date,
    cancelled_at: r.cancelled_at,
    last_payment_at: r.last_payment_at,
    provider: r.provider,
    external_subscription_id: r.external_subscription_id,
    lead_id: r.lead_id,
    not_set: notSet,
    not_set_reason: notSet.length
      ? 'Held in GHL custom fields on the linked lead, which are keyed by opaque '
        + 'ids with no names. Pending field mapping — not displayed on a guess.'
      : null,
  };
}

function shapePayment(r) {
  return {
    id: r.id,
    payment_id: r.external_payment_id,
    receipt_number: r.receipt_number,
    subscription_id: r.external_subscription_id,
    customer_name: r.customer_name,
    customer_email: r.customer_email,
    product: r.product_name,
    billing_reason: r.billing_reason,
    one_off: r.one_off,
    /* usd_total is null until money moves, and a failed payment must not read
       as $0.00 collected — that would claim it was free. */
    gross: num(r.usd_total),
    charged: num(r.total),
    fee: num(r.fee_amount),
    net: num(r.amount_after_fees),
    tax: num(r.tax_amount),
    refunded: num(r.refunded_amount),
    currency: r.currency,
    status: r.status,
    substatus: r.substatus,
    /* A failed renewal is the earliest churn signal there is, so these stay in
       the list, greyed, with the decline reason. */
    failed: r.substatus === 'failed' || r.status === 'failed',
    failure_message: r.failure_message,
    card: r.card,
    paid_at: r.paid_at,
    refunded_at: r.refunded_at,
    is_test: r.is_test,
  };
}

function num(v) {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/* Sums only what was actually collected. A null gross contributes nothing
   rather than a zero.

   Takes RAW database rows, not shaped ones — it reads usd_total / fee_amount /
   amount_after_fees. Handed shaped rows it would quietly total zero, so the
   callers pass the raw result and shape separately. */
function totalsOf(rows) {
  let gross = 0, fee = 0, net = 0, counted = 0;
  for (const r of rows) {
    if (r.status !== 'paid' || r.usd_total === null || r.usd_total === undefined) continue;
    gross += Number(r.usd_total);
    fee += Number(r.fee_amount || 0);
    net += Number(r.amount_after_fees === null ? 0 : r.amount_after_fees);
    counted++;
  }
  return { gross: round2(gross), fee: round2(fee), net: round2(net), payments: counted };
}
const round2 = n => Math.round(n * 100) / 100;

/* ---- export columns ---------------------------------------------------- */
const SUBSCRIBER_EXPORT_COLUMNS = [
  ['business', 'Business'], ['contact', 'Contact'], ['email', 'Email'],
  ['units', 'Units'], ['plan', 'Plan'], ['amount', 'Amount'], ['currency', 'Currency'],
  ['billing_period', 'Billing Period'], ['status', 'Status'],
  ['payment_status', 'Payment Status'], ['start_date', 'Start Date'],
  ['last_payment_at', 'Last Payment'], ['provider', 'Provider'],
  ['external_subscription_id', 'Subscription ID'],
];

const PAYMENT_EXPORT_COLUMNS = [
  ['payment_id', 'Payment ID'], ['receipt_number', 'Receipt Number'],
  ['paid_at', 'Paid At'], ['billing_reason', 'Billing Reason'],
  ['gross', 'Gross'], ['fee', 'Fee'], ['net', 'Net'], ['currency', 'Currency'],
  ['status', 'Status'], ['substatus', 'Substatus'],
  ['refunded', 'Refunded Amount'], ['card', 'Card'],
];

/* Never exported, on any view. The GHL custom-field payload is unlabelled and
   would travel as authoritative-looking numbers; `raw` carries a billing
   address and a risk score. */
const NEVER_EXPOSE = ['custom_fields', 'raw', 'external_customer_id'];

function describeFolioFilters(f) {
  const bits = [];
  if (f.from && f.to && f.from === f.to) bits.push('Paid on: ' + f.from);
  else if (f.from && f.to) bits.push('Paid: ' + f.from + ' to ' + f.to);
  else if (f.from) bits.push('Paid from: ' + f.from);
  else if (f.to) bits.push('Paid up to: ' + f.to);
  const named = [['Status', f.status], ['Payment status', f.payment_status],
                 ['Billing period', f.billing_period], ['Plan', f.plan],
                 ['Provider', f.provider]];
  for (const [label, vals] of named) if (vals.length) bits.push(`${label}: ${vals.join(', ')}`);
  /* Test payments are NOT mentioned here: the export writes a dedicated line
     for them, and saying it twice reads as two different facts. */
  return bits.length ? bits.join(' · ') : 'none';
}

function exportedBy(req) {
  if (req.session && req.session.user && (req.session.user.email || req.session.user.name)) {
    return req.session.user.email || req.session.user.name;
  }
  /* Read for the audit line only; nothing is authorised on it, so an
     unverified decode is the right amount of work here. (The GHL send path
     verifies its caller against Supabase Auth, because that one decides whose
     name goes on a message to a customer.) */
  const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '');
  if (m) {
    try {
      const p = JSON.parse(Buffer.from(m[1].split('.')[1], 'base64url').toString('utf8'));
      if (p && p.email) return p.email;
    } catch (_) { /* a token we cannot read is not an error here */ }
  }
  return 'unknown';
}

function sendCsv(res, view, cols, rows, meta, f) {
  res.type('text/csv; charset=utf-8');
  res.setHeader('Content-Disposition',
    `attachment; filename="folio-${view}-${meta.exportedAt.slice(0, 10)}.csv"`);

  /* Provenance above the header. A figure that leaves this system without its
     as-of date and its caveats gets quoted back as fact — and on this export
     the caveats are the point: whether test payments are in it, and that the
     MRR behind the amounts assumes a billing period nobody has confirmed. */
  res.write(
    '# Folio Excel financial export\n' +
    `# Generated: ${meta.exportedAt} by ${meta.exportedBy}\n` +
    `# View: ${view}\n` +
    `# Filters: ${meta.filtersApplied}\n` +
    `# Test payments: ${f.include_test ? 'INCLUDED - two $1 card tests are in this file' : 'excluded'}\n` +
    '# Test rows are identified by a notes string and an anonymised email; '
      + 'sales_payment has no is_test column, so that filter is provisional.\n' +
    '# billing_period is not set on the subscriber; any monthly figure assumes monthly.\n' +
    `# Rows: ${rows.length}\n`);

  const s = stringify({ header: true, columns: cols.map(([key, label]) => ({ key, header: label })) });
  s.on('error', () => res.end());
  s.pipe(res);
  for (const row of rows) {
    const rec = {};
    for (const [key] of cols) {
      if (NEVER_EXPOSE.includes(key)) continue;
      const v = row[key];
      /* A measured zero exports as 0; an absent value exports empty. Money
         goes out as a bare number — a spreadsheet needs -40000, not
         (40,000.00) — and "Not set" goes out empty rather than as the words,
         which would break every SUM in the file. */
      rec[key] = v === null || v === undefined ? '' : v;
    }
    s.write(rec);
  }
  s.end();
}

module.exports = {
  folioFinancialsRoutes,
  FOLIO_COMPANY_ID, FOLIO_ENTITY_ID, WHOP_FOLIO_ACCOUNT_ID,
  SUBS_SQL, PAY_COLS, PAY_FROM, MRR_SQL, IS_TEST,
  SUBSCRIBER_EXPORT_COLUMNS, PAYMENT_EXPORT_COLUMNS, NEVER_EXPOSE,
  shapeSubscriber, shapePayment, totalsOf, describeFolioFilters,
  readFilters, subscriberWhere, paymentWhere, includeTest,
};
