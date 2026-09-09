/* Leadli AI financials — the payment stream. READ-ONLY.

   Mounted at /api/leadli/financials. Built to LEADLI_FINANCIAL_SPEC, verified
   against the live database on 2026-09-08.

   ---------------------------------------------------------------------------
   LEADLI HAS NO PAYMENT DATA AT ALL, AND THE EMPTY STATE IS THE FEATURE

   Verified, not assumed:

     sales_payment       0 rows for Leadli   (all 3 rows in the table are Folio's)
     subscription_client 0 rows for Leadli
     transaction         0 rows for Leadli
     service_client      0 rows, whole table
     lead                2,557 rows, 0 with is_client

   So every card reads $0.00 or 0 and the table has nothing in it. That is
   ACCURATE, not broken: the routes answer normally, the counts are real zeros
   and the client renders a message naming where Leadli revenue will arrive
   from. Nothing here seeds a placeholder row to make the screen look
   populated — that is exactly how the Folio page ended up showing six
   businesses that do not exist.

   The acceptance check that matters: insert one real Leadli payment by hand
   and all four cards and the table populate with no code change.

   ---------------------------------------------------------------------------
   FIVE THINGS THIS MODULE MUST NEVER DO

   1. NEVER COUNT lead.is_client as clients. It reads 0 for Leadli today and 4
      for Folio, where only one customer pays — the flag drifted across earlier
      sessions. Paying customers come from the payment stream, full stop.

   2. NEVER SUM subscription_client.subscription_amount for the total. That is
      a recurring RATE, not money received. Total amount is
      sum(sales_payment.usd_total) on collected, non-test rows.

   3. NEVER READ transaction.company_id — the column does not exist. Leadli's
      ledger rows are reached by entity_id.

   4. NEVER JOIN product_name TO `service`. The catalogue holds 7 Leadli
      offerings, all with a NULL price, and `sales_payment.product_name` is
      whatever the Whop product is titled — on Folio it reads "Chris
      Pomerleau-Standard", which matches no catalogue entry. There is no key
      between them and a fuzzy name match would silently mislabel revenue.

   5. NEVER show a pipeline stage table or a funnel here. That is CRM data and
      belongs on the Leads page. The ONE lead count in the empty-state payload
      is the deliberate exception, because it is what explains why the page is
      empty.

   ---------------------------------------------------------------------------
   THE TEST-PAYMENT FILTER IS PROVISIONAL, AND PROBED RATHER THAN ASSUMED

   `sales_payment` has NO is_test column (verified 2026-09-08). Until it does,
   test rows are matched the only way available: a notes string plus a
   Whop-anonymised email. Both together, per the spec.

   Rather than hardcode that, `testPredicate()` asks
   information_schema ONCE and uses `is_test` the moment the column appears.
   That is what makes the spec's "no code change" acceptance check hold in both
   directions: add the column and this starts using it.

   A string match on a free-text notes field breaks silently the first time
   someone edits a note, and it breaks in the direction of inflating revenue.
   `sales_payment` wants an is_test boolean; that is Jay's call.
   --------------------------------------------------------------------------- */

const express = require('express');
const db = require('./supabase-db');
const { arrayParam } = require('./financials-api');

const TENANT_ID = '72381c81-af95-4e1d-ad0d-20a3a3421119';
const LEADLI_COMPANY_ID = 'c0000000-0000-4000-8000-000000000001';
const LEADLI_ENTITY_ID = '8bd3c562-1feb-4e85-b363-bc21aebff616';

/* The Leadli processor account already exists. account_kind = 'processor',
   deliberately not 'bank', which is what keeps Leadli revenue out of
   v_cash_by_entity_quarter and the property cash and debt dashboards. */
const WHOP_LEADLI_ACCOUNT_ID = 'fdefb5bc-e511-4688-bfc0-c8e20b7f52da';

/* subscription_create / subscription_cycle / subscription_update / subscription
   recur; one_time and manual are one-offs. Routed on billing_reason, never on
   which table the row came from. A NULL is 'Unknown' rather than being folded
   into either bucket. */
const RECURRING = ['subscription_create', 'subscription_cycle', 'subscription_update', 'subscription'];
const ONE_OFF = ['one_time', 'manual'];

const WRITE_SQL = /\b(insert|update|delete|truncate|drop|alter|create|grant|revoke|copy|merge)\b/i;

/* Read-only enforced twice. supabase-db connects with SUPABASE_DB_URL, which
   is the postgres superuser, so RLS never runs and a stray write would simply
   succeed with nothing downstream to catch it. */
async function q(sql, params) {
  if (WRITE_SQL.test(sql)) {
    throw new Error('leadli-financials-api is read-only; refused a statement containing a write verb');
  }
  if (/\btransaction\s*\.\s*company_id\b|\bt\.company_id\b/i.test(sql)) {
    throw new Error('transaction has no company_id column; scope Leadli by entity_id');
  }
  const r = await db.q(sql, params);
  return r.rows;
}

/* ---- the test-payment predicate ----------------------------------------
   Probed once, cached, and reported on every response so the screen can say
   which definition produced its figures. */
let testCap = null;
async function testPredicate() {
  if (testCap) return testCap;
  let hasColumn = false;
  try {
    const rows = await q(
      `select 1 from information_schema.columns
        where table_schema = 'public' and table_name = 'sales_payment'
          and column_name = 'is_test' limit 1`, []);
    hasColumn = rows.length > 0;
  } catch (err) {
    /* A probe that cannot run must not take the screen down. Fall back to the
       provisional predicate and say so. */
    console.error('[leadli-financials] is_test probe failed:', err && err.message);
  }
  testCap = hasColumn
    ? { sql: 'coalesce(sp.is_test, false)', provisional: false,
        note: 'sales_payment.is_test is populated and is what excludes test rows.' }
    : { sql: `(sp.notes ilike '%TEST TRANSACTION%' or sp.customer_email like '%@deleted.com')`,
        provisional: true,
        note: 'sales_payment has no is_test column, so test rows are matched on a notes '
            + 'string plus a Whop-anonymised email. Provisional: editing a note breaks it, '
            + 'in the direction of inflating revenue.' };
  return testCap;
}

/* ---- the four cards -----------------------------------------------------
   Total amount, total clients, subscription payments, one-time payments.

   `total_clients` counts DISTINCT PAYERS, preferring external_customer_id (the
   Whop `user_` id, which is the reliable identity) and falling back to email
   only where that is null. Never lead.is_client.

   The subscription and one-time figures are PAYMENT counts, not customer
   counts — one subscriber paying monthly for a year contributes 12 — and the
   cards are labelled to say so. `distinct_subscriptions` rides along beside
   them so the screen can state both without a second query. */
function summarySql(isTest) {
  return `
    select coalesce(sum(sp.usd_total), 0)                                     as total_amount,
           count(distinct coalesce(sp.external_customer_id, sp.customer_email))::int as total_clients,
           count(*) filter (where sp.billing_reason = any($3::text[]))::int    as subscription_count,
           count(*) filter (where sp.billing_reason = any($4::text[]))::int    as one_time_count,
           count(*) filter (where sp.billing_reason is null)::int              as unknown_reason_count,
           count(distinct sp.external_subscription_id)::int                    as distinct_subscriptions,
           count(*)::int                                                       as payment_count,
           coalesce(sum(sp.fee_amount), 0)                                     as fees_total,
           coalesce(sum(sp.amount_after_fees), 0)                              as net_total,
           min(sp.paid_at)                                                     as first_paid_at,
           max(sp.paid_at)                                                     as last_paid_at,
           min(sp.currency)                                                    as currency,
           count(distinct sp.currency)::int                                    as currencies
      from public.sales_payment sp
     where sp.tenant_id = $1 and sp.company_id = $2::uuid
       and sp.status = 'paid'
       and not ${isTest}`;
}

/* ---- the table ----------------------------------------------------------
   Four columns on screen; the rest of these fields feed the row expand, where
   the fee lives. The fee is real money and is invisible otherwise.

   CUSTOMER NAME NEEDS A FALLBACK CHAIN. Whop sends user.name as null
   routinely — it was null on the one real Folio payment, restored by hand from
   raw.billing_address.name. `name_source` rides along so the client can mark a
   Whop handle as a handle rather than passing it off as a person's name. */
function rowsSql(isTest) {
  return `
    select sp.id, sp.external_payment_id, sp.external_subscription_id,
           sp.external_customer_id, sp.product_name,
           coalesce(nullif(sp.customer_name, ''),
                    nullif(sp.raw->'billing_address'->>'name', ''),
                    nullif(sp.raw->'user'->>'username', ''),
                    nullif(sp.customer_email, '')) as customer_name,
           case
             when nullif(sp.customer_name, '') is not null then 'payment'
             when nullif(sp.raw->'billing_address'->>'name', '') is not null then 'billing_address'
             when nullif(sp.raw->'user'->>'username', '') is not null then 'whop_username'
             when nullif(sp.customer_email, '') is not null then 'email'
             else 'none'
           end as name_source,
           sp.customer_email, sp.usd_total, sp.total, sp.currency,
           sp.fee_amount, sp.amount_after_fees, sp.refunded_amount,
           sp.billing_reason, sp.status, sp.substatus, sp.paid_at, sp.refunded_at,
           sp.raw->'payment_instrument'->>'display_name' as card,
           sp.raw->>'receipt_number' as receipt_number,
           sp.raw->>'failure_message' as failure_message,
           ${isTest} as is_test,
           case
             when sp.billing_reason = any($4::text[]) then 'One-time'
             when sp.billing_reason is null           then 'Unknown'
             else 'Subscription'
           end as service_type
      from public.sales_payment sp
     where sp.tenant_id = $1 and sp.company_id = $2::uuid
       and not ${isTest}`;
}

function shapeRow(r) {
  return {
    id: r.id,
    payment_id: r.external_payment_id,
    subscription_id: r.external_subscription_id,
    receipt_number: r.receipt_number,
    /* "Unknown product" is the client's word for a null; the API returns the
       null so the client can label it rather than guessing at a name. */
    product: r.product_name,
    customer: r.customer_name,
    /* 'whop_username' means the value is a HANDLE, not a person's name. */
    customer_source: r.name_source,
    email: r.customer_email,
    amount: num(r.usd_total),
    charged: num(r.total),
    currency: r.currency,
    fee: num(r.fee_amount),
    net: num(r.amount_after_fees),
    refunded: num(r.refunded_amount),
    billing_reason: r.billing_reason,
    service_type: r.service_type,
    status: r.status,
    substatus: r.substatus,
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

function leadliFinancialsRoutes() {
  const r = express.Router();

  r.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return res.status(405).set('Allow', 'GET, HEAD')
        .json({ error: 'The Leadli financials API is read-only.' });
    }
    if (!db.enabled) {
      return res.status(503).json({
        configured: false,
        error: 'SUPABASE_DB_URL is not set, so there are no Leadli financials to read.',
      });
    }
    next();
  });

  const fail = (res, err) => {
    if (err && err.code === '22P02') return res.status(400).json({ error: 'That is not a valid id.' });
    console.error('[leadli-financials]', err && err.message);
    res.status(500).json({ error: (err && err.message) || 'query failed' });
  };

  const P = () => [TENANT_ID, LEADLI_COMPANY_ID, RECURRING, ONE_OFF];

  r.get('/summary', async (req, res) => {
    try {
      const t = await testPredicate();
      const [s] = await q(summarySql(t.sql), P());

      /* The ONE piece of CRM data on this page, and only because it is what
         explains an empty table. `converted` is derived from the PAYMENT
         stream, never from lead.is_client - which reads 0 here and 4 for
         Folio where one customer pays. */
      const [lead] = await q(
        `select count(*)::int as total_leads
           from public.lead l
          where l.tenant_id = $1 and l.company_id = $2::uuid`,
        [TENANT_ID, LEADLI_COMPANY_ID]);

      res.json({
        /* The four card figures. */
        total_amount: Number(s.total_amount),
        total_clients: s.total_clients,
        subscription_count: s.subscription_count,
        one_time_count: s.one_time_count,

        /* Context the cards need to be honest about what they counted. */
        payment_count: s.payment_count,
        unknown_reason_count: s.unknown_reason_count,
        distinct_subscriptions: s.distinct_subscriptions,
        fees_total: Number(s.fees_total),
        net_total: Number(s.net_total),
        first_paid_at: s.first_paid_at,
        last_paid_at: s.last_paid_at,
        currency: s.currencies > 1 ? 'mixed' : (s.currency || 'USD'),

        /* True today. It is what switches the table to its empty state, and it
           is derived from the count rather than hardcoded, so one inserted
           payment flips it. */
        empty: s.payment_count === 0,
        pipeline: {
          total_leads: lead.total_leads,
          converted: s.total_clients,
          converted_source: 'distinct payers in sales_payment, never lead.is_client',
        },
        test_filter: { provisional: t.provisional, note: t.note },
        as_of: new Date().toISOString(),
      });
    } catch (err) { fail(res, err); }
  });

  r.get('/payments', async (req, res) => {
    try {
      const t = await testPredicate();
      const params = P();
      const where = [];

      /* Service type narrows on the derived bucket rather than on a raw
         billing_reason list, so the chips cannot disagree with the column
         beside them. */
      const types = arrayParam(req, 'service_type');
      if (types.length) {
        params.push(types);
        where.push(`(case
                       when sp.billing_reason = any($4::text[]) then 'One-time'
                       when sp.billing_reason is null           then 'Unknown'
                       else 'Subscription'
                     end) = any($${params.length}::text[])`);
      }

      const rows = await q(
        `${rowsSql(t.sql)}${where.length ? ' and ' + where.join(' and ') : ''}
         order by sp.paid_at desc nulls last, sp.source_created_at desc nulls last`, params);

      res.json({
        rows: rows.map(shapeRow),
        total_count: rows.length,
        service_types: ['Subscription', 'One-time', 'Unknown'],
        selected: types,
        test_filter: { provisional: t.provisional, note: t.note },
      });
    } catch (err) { fail(res, err); }
  });

  /* Deliberately absent: any route returning pipeline stages, and any route
     joining product_name to `service`. See the header. */

  return r;
}

module.exports = {
  leadliFinancialsRoutes,
  LEADLI_COMPANY_ID, LEADLI_ENTITY_ID, WHOP_LEADLI_ACCOUNT_ID,
  RECURRING, ONE_OFF,
  summarySql, rowsSql, shapeRow, testPredicate,
  /* Test-only: the probe caches, and a suite that exercises both branches has
     to be able to clear it. */
  _resetTestCap() { testCap = null; },
};
