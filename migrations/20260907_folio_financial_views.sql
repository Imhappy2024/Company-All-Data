-- Folio Excel financials: three read-only views.
--
-- Folio is a SaaS business and shares NOTHING with LeavenWealth's financial
-- model. Verified 2026-09-07:
--
--   financial_account via entity or deal ....... 0
--   deal ....................................... 0
--   transaction / transaction_category ......... 0 / 0
--   statement .................................. 0
--
-- So the LeavenWealth screen (cash, debt, entity rollup, quarterly balance
-- snapshots) has literally no rows to show for Folio. What Folio HAS is Whop
-- billing:
--
--   sales_payment ....... 3 rows, all Folio, provider = 'whop'
--   whop_payment ........ 3 rows, all Folio  <-- THE SAME THREE PAYMENTS
--   subscription_client . 1 row,  Folio Excel LLC
--   subscription_plan ... 0 rows
--
-- ===========================================================================
-- sales_payment AND whop_payment ARE THE SAME PAYMENTS. NEVER UNION THEM.
-- ===========================================================================
-- Matched on sales_payment.external_payment_id = whop_payment.whop_payment_id,
-- all three join 1:1 (pay_cclK859htn24nk, pay_FgziDAhWNZgyMU,
-- pay_zZNxyVzd31xESP). sales_payment is the provider-agnostic table and is the
-- one to read; whop_payment is the raw Whop mirror kept for its card, billing
-- address and fee-breakdown detail.
--
-- Summing both reports $2,002 of revenue against a real $1,001, and looks
-- entirely plausible while doing it. These views read sales_payment only.
--
-- ---------------------------------------------------------------------------
-- COLLECTED IS `paid_at IS NOT NULL`, NOT `status = 'paid'`
-- Both agree in today's data, but paid_at is the fact and status is a label;
-- a provider that adds a status spelling breaks the string test silently and
-- leaves the timestamp test correct.
--
-- ---------------------------------------------------------------------------
-- THERE IS NO MRR, AND THESE VIEWS DO NOT INVENT ONE
-- subscription_client.billing_period is NULL on the only row, as are
-- number_of_units, next_billing_date and subscription_plan_id (and
-- subscription_plan is empty). A $1,000 subscription with no period could be
-- $1,000 a month or $1,000 a year — a twelvefold difference — so
-- v_folio_revenue_summary exposes `mrr_derivable = false` and the amount
-- WITHOUT a period, rather than picking one.
--
-- ---------------------------------------------------------------------------
-- Scoping. sales_payment and whop_payment carry company_id; subscription_client
-- and subscription_plan carry business_entity_id instead and reach the brand
-- through entity.company_id. Two different paths to the same brand, which is
-- why the filter is written out in each view rather than shared.
--
-- migrations/ in this repo is REVIEW-ONLY and is not applied automatically.
-- The Folio dashboard does NOT depend on these views: folio-financials-api.js
-- runs the same SQL against the base tables, so the screen works whether or
-- not this file has been run. Apply it if you want the views as database
-- objects for ad-hoc queries or other consumers.

-- Rollback is at the bottom of this file.

create or replace view public.v_folio_payments as
select sp.id,
       sp.tenant_id,
       sp.company_id,
       sp.provider,
       sp.external_payment_id,
       sp.external_subscription_id,
       sp.customer_email,
       sp.customer_name,
       sp.product_name,
       sp.billing_reason,
       sp.status,
       sp.currency,
       sp.total,
       /* usd_total is null until a payment is actually collected, so the gross
          figure has to come from it rather than from `total` — otherwise an
          open payment inflates revenue. */
       sp.usd_total,
       sp.amount_after_fees,
       sp.fee_amount,
       sp.tax_amount,
       sp.refunded_amount,
       sp.paid_at,
       (sp.paid_at is not null) as collected,
       sp.refunded_at,
       sp.source_created_at
  from public.sales_payment sp
 where sp.company_id = 'c0000000-0000-4000-8000-000000000002'::uuid;

comment on view public.v_folio_payments is
  'Folio Excel payments, from sales_payment ONLY. whop_payment holds the same '
  'three payments (matched on external_payment_id = whop_payment_id); unioning '
  'them double-counts revenue. `collected` is paid_at IS NOT NULL, not status.';

create or replace view public.v_folio_subscriptions as
select sc.id,
       sc.tenant_id,
       e.company_id,
       sc.business_entity_id,
       e.name  as entity,
       sc.name,
       sc.email,
       sc.phone,
       sc.company,
       sc.status,
       sc.payment_status,
       sc.provider,
       sc.external_subscription_id,
       sc.currency,
       sc.subscription_amount,
       /* Kept as-is and NOT turned into a monthly figure. NULL here is why
          v_folio_revenue_summary.mrr_derivable is false. */
       sc.billing_period,
       sc.number_of_units,
       sc.subscription_plan_id,
       sc.start_date,
       sc.next_billing_date,
       sc.cancelled_at,
       sc.lead_id,
       sc.assigned_staff_id
  from public.subscription_client sc
  join public.entity e on e.id = sc.business_entity_id
 where e.company_id = 'c0000000-0000-4000-8000-000000000002'::uuid;

comment on view public.v_folio_subscriptions is
  'Folio Excel subscriptions. Scoped through entity.company_id because '
  'subscription_client carries business_entity_id, not company_id. '
  'billing_period is deliberately not normalised to a monthly amount.';

create or replace view public.v_folio_revenue_summary as
with pay as (
  select count(*)::int                                                      as payments,
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
    from public.v_folio_payments
),
sub as (
  select count(*)::int                                                       as subscriptions,
         count(*) filter (where status = 'active')::int                       as active_subscriptions,
         coalesce(sum(subscription_amount) filter (where status = 'active'), 0) as active_amount,
         /* FALSE while any active subscription has no billing_period. A
            $1,000 subscription is $12,000 a year or $1,000 a year depending on
            a column that is null, so no monthly figure is published at all. */
         bool_and(billing_period is not null)
           filter (where status = 'active')                                   as mrr_derivable
    from public.v_folio_subscriptions
)
select 'c0000000-0000-4000-8000-000000000002'::uuid as company_id,
       p.payments, p.collected_count, p.gross_usd, p.net_usd, p.fees_usd,
       p.outstanding_count, p.outstanding_usd, p.refunded_usd, p.customers,
       p.first_paid_at, p.last_paid_at,
       s.subscriptions, s.active_subscriptions, s.active_amount,
       coalesce(s.mrr_derivable, false) as mrr_derivable
  from pay p cross join sub s;

comment on view public.v_folio_revenue_summary is
  'Folio Excel revenue tiles. gross_usd sums usd_total (null until collected); '
  'net_usd sums amount_after_fees. mrr_derivable is false while any active '
  'subscription has a null billing_period - no monthly figure is invented.';

grant select on public.v_folio_payments,
                public.v_folio_subscriptions,
                public.v_folio_revenue_summary
  to authenticated;

-- Verified figures at 2026-09-07, for whoever reviews this:
--   v_folio_payments            3 rows (2 collected, 1 open)
--   v_folio_subscriptions       1 row  (Brandi Jorgensen, active, $1000, no period)
--   v_folio_revenue_summary     gross 1001.00, net 960.21, fees 40.79,
--                               outstanding 1.00, customers 2,
--                               mrr_derivable false

-- Rollback:
-- drop view if exists public.v_folio_revenue_summary;
-- drop view if exists public.v_folio_subscriptions;
-- drop view if exists public.v_folio_payments;
