/* Folio Excel financials — Whop billing, read-only.

   Mounted at /api/folio-financials.

   ---------------------------------------------------------------------------
   WHY THIS IS A SEPARATE MODULE AND NOT A BRAND FILTER ON financials-api.js

   Folio is a SaaS business and shares nothing with LeavenWealth's financial
   model. Verified against the live database on 2026-09-07:

     financial_account reachable from Folio (entity or deal) ..... 0
     deal ....................................................... 0
     transaction / transaction_category ......................... 0 / 0
     statement .................................................. 0

   Every relation the LeavenWealth screen reads is empty for Folio. A brand
   parameter on that API would have produced a working screen showing zeros
   forever, which reads as "Folio has no money" rather than "these are the
   wrong tables".

   What Folio HAS is Whop billing: sales_payment, whop_payment,
   subscription_client, subscription_plan.

   ---------------------------------------------------------------------------
   sales_payment AND whop_payment ARE THE SAME PAYMENTS. NEVER UNION THEM.

   All three Folio rows join 1:1 on
   sales_payment.external_payment_id = whop_payment.whop_payment_id
   (pay_cclK859htn24nk, pay_FgziDAhWNZgyMU, pay_zZNxyVzd31xESP).

   sales_payment is the provider-agnostic table and the one this module reads.
   whop_payment is the raw Whop mirror, kept for card / billing-address / fee
   breakdown detail. Summing both reports $2,002 against a real $1,001 — and
   looks entirely plausible while doing it, which is the whole danger.

   ---------------------------------------------------------------------------
   COLLECTED IS `paid_at IS NOT NULL`, NOT `status = 'paid'`

   Both agree in today's data. paid_at is the fact; status is a label, and a
   provider adding a spelling breaks a string test silently while leaving the
   timestamp test right.

   `usd_total` is null until a payment is collected, so gross sums THAT rather
   than `total` — otherwise the one open $1.00 payment inflates revenue.

   ---------------------------------------------------------------------------
   THERE IS NO MRR AND THIS DOES NOT INVENT ONE

   subscription_client.billing_period is NULL on the only row, as are
   number_of_units, next_billing_date and subscription_plan_id (and
   subscription_plan is empty). A $1,000 subscription with no period is either
   $1,000 a month or $1,000 a year — a twelvefold difference — so the payload
   carries `mrr_derivable: false` and the amount without a period. The screen
   says so rather than picking one.

   ---------------------------------------------------------------------------
   The optional views in migrations/20260907_folio_financial_views.sql hold the
   same SQL. This module reads the BASE TABLES so the screen works whether or
   not that migration has been applied — migrations/ is review-only here.
   --------------------------------------------------------------------------- */

const express = require('express');
const db = require('./supabase-db');

const TENANT_ID = '72381c81-af95-4e1d-ad0d-20a3a3421119';
const FOLIO_COMPANY_ID = 'c0000000-0000-4000-8000-000000000002';

const WRITE_SQL = /\b(insert|update|delete|truncate|drop|alter|create|grant|revoke|copy|merge)\b/i;

async function q(sql, params) {
  if (WRITE_SQL.test(sql)) {
    throw new Error('folio-financials-api is read-only; refused a statement containing a write verb');
  }
  const r = await db.q(sql, params);
  return r.rows;
}

/* Two different paths to the same brand, which is why neither is shared:
   sales_payment carries company_id, subscription_client carries
   business_entity_id and reaches the brand through entity.company_id. */
const PAYMENTS_SQL = `
  select sp.id, sp.provider, sp.external_payment_id, sp.external_subscription_id,
         sp.customer_email, sp.customer_name, sp.product_name, sp.billing_reason,
         sp.status, sp.currency, sp.total, sp.usd_total, sp.amount_after_fees,
         sp.fee_amount, sp.tax_amount, sp.refunded_amount,
         sp.paid_at, (sp.paid_at is not null) as collected,
         sp.refunded_at, sp.source_created_at
    from public.sales_payment sp
   where sp.tenant_id = $1 and sp.company_id = $2::uuid`;

const SUBS_SQL = `
  select sc.id, sc.name, sc.email, sc.phone, sc.company,
         sc.status, sc.payment_status, sc.provider, sc.external_subscription_id,
         sc.currency, sc.subscription_amount, sc.billing_period, sc.number_of_units,
         sc.start_date, sc.next_billing_date, sc.cancelled_at,
         e.name as entity, sc.lead_id is not null as linked_to_lead
    from public.subscription_client sc
    join public.entity e on e.id = sc.business_entity_id
   where sc.tenant_id = $1 and e.company_id = $2::uuid`;

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

  const T = [TENANT_ID, FOLIO_COMPANY_ID];

  r.get('/summary', async (req, res) => {
    try {
      const [pay] = await q(
        `select count(*)::int                                                      as payments,
                count(*) filter (where collected)::int                             as collected_count,
                coalesce(sum(usd_total)         filter (where collected), 0)        as gross_usd,
                coalesce(sum(amount_after_fees) filter (where collected), 0)        as net_usd,
                coalesce(sum(fee_amount)        filter (where collected), 0)        as fees_usd,
                count(*) filter (where not collected)::int                          as outstanding_count,
                coalesce(sum(total)             filter (where not collected), 0)    as outstanding_usd,
                coalesce(sum(refunded_amount), 0)                                   as refunded_usd,
                count(distinct customer_email)::int                                 as customers,
                min(paid_at)                                                        as first_paid_at,
                max(paid_at)                                                        as last_paid_at
           from (${PAYMENTS_SQL}) p`, T);

      const [sub] = await q(
        `select count(*)::int                                                        as subscriptions,
                count(*) filter (where status = 'active')::int                        as active_subscriptions,
                coalesce(sum(subscription_amount) filter (where status = 'active'), 0) as active_amount,
                /* False while ANY active subscription has no billing_period. */
                coalesce(bool_and(billing_period is not null)
                           filter (where status = 'active'), false)                   as mrr_derivable
           from (${SUBS_SQL}) s`, T);

      /* Named so the screen can say what it is NOT showing. Folio has none of
         these, and "no cash accounts" is a different statement from "$0". */
      const [empty] = await q(
        `select (select count(*)::int from public.financial_account fa
                  left join public.entity e on e.id = fa.owner_entity_id
                  left join public.deal   d on d.id = fa.deal_id
                 where fa.tenant_id = $1
                   and (e.company_id = $2::uuid or d.company_id = $2::uuid)) as accounts,
                (select count(*)::int from public.deal where tenant_id = $1 and company_id = $2::uuid) as deals,
                (select count(*)::int from public.transaction where tenant_id = $1) as transactions`, T);

      res.json({
        ...pay, ...sub,
        /* Stated rather than implied: the LeavenWealth model is empty here, and
           that is why this screen exists instead of a brand filter. */
        not_applicable: empty,
        /* So the client never has to guess which table the figures came from. */
        source: 'sales_payment (provider-agnostic); whop_payment holds the same rows and is not summed',
      });
    } catch (err) { fail(res, err); }
  });

  r.get('/payments', async (req, res) => {
    try {
      const rows = await q(`${PAYMENTS_SQL} order by coalesce(sp.paid_at, sp.source_created_at) desc nulls last`, T);
      res.json({ rows, total_count: rows.length });
    } catch (err) { fail(res, err); }
  });

  r.get('/subscriptions', async (req, res) => {
    try {
      const rows = await q(`${SUBS_SQL} order by sc.status, sc.name`, T);
      res.json({ rows, total_count: rows.length });
    } catch (err) { fail(res, err); }
  });

  /* The raw Whop detail for ONE payment — card brand, billing address, fee
     breakdown. Keyed by the provider's own payment id, which is the column
     sales_payment stores as external_payment_id. This is the only place
     whop_payment is read, and it is per-row rather than aggregated so it can
     never contribute to a total. */
  r.get('/payments/:extId/whop', async (req, res) => {
    try {
      const rows = await q(
        `select wp.whop_payment_id, wp.receipt_number, wp.status, wp.sub_status,
                wp.failure_reason, wp.description, wp.customer_name, wp.email,
                wp.currency, wp.subtotal, wp.payment_amount, wp.fee,
                wp.amount_excluding_tax, wp.tax_amount, wp.total_including_fees,
                wp.total_usd_including_fees, wp.refunded_amount, wp.promo_code,
                wp.attempted_count, wp.payment_method, wp.payment_method_type,
                wp.card_brand, wp.card_last4, wp.card_issue_country,
                wp.billing_city, wp.billing_state, wp.billing_country,
                wp.paid_at, wp.is_test
           from public.whop_payment wp
          where wp.tenant_id = $1 and wp.company_id = $2::uuid
            and wp.whop_payment_id = $3`, [TENANT_ID, FOLIO_COMPANY_ID, String(req.params.extId)]);
      if (!rows.length) return res.status(404).json({ error: 'No Whop record for that payment id.' });
      res.json({ payment: rows[0] });
    } catch (err) { fail(res, err); }
  });

  return r;
}

module.exports = { folioFinancialsRoutes, FOLIO_COMPANY_ID, PAYMENTS_SQL, SUBS_SQL };
