-- ===========================================================================
-- reporting schema  (Phase 1: curated datasets)
--
-- REVIEW ONLY until Jay approves. migrations/ is not auto-applied.
--
-- These views encode the data rules ONCE so no screen reads t12_monthly,
-- rent_roll_line or loan directly. Everything in Phase 2 and Phase 3 reads
-- from here.
--
-- ---------------------------------------------------------------------------
-- WHAT WAS VERIFIED, AND WHAT WAS NOT
-- ---------------------------------------------------------------------------
-- Every COLUMN below was verified to exist against the live database on
-- 2026-10-11 by probing PostgREST (a missing column answers 42703). No rows
-- were read: the anon role has no RLS grant, which is correct and is also why
-- the content checks below could not be made.
--
-- Verified column lists:
--   t12_monthly    (tenant_id, property_id, month, accounting_basis, section,
--                   account_path, depth, line_label, is_total, amount, sort_order)
--                  - it has NO foreign key to t12_report.
--   t12_report     (tenant_id, property_id, entity_id, period_start, period_end,
--                   accounting_basis, first_active_month, source_system,
--                   document_id, report_type)
--   rent_roll_report (tenant_id, property_id, as_of_date, source_system, document_id)
--   rent_roll_line   (tenant_id, rent_roll_report_id, unit_id, unit_label, beds,
--                   baths, occupancy_status, rent, market_rent, balance_due,
--                   lease_start, lease_end, move_in, move_out, square_feet)
--
-- THREE THINGS IN THE BRIEF ARE NOT IN THE DATABASE:
--
--   1. `balance_sheet_change` does not exist. It was the brief's source for
--      loan principal. The only balance-sheet source is v_gl_balance_sheet,
--      which is keyed by ENTITY and holds balances, not movements - an entity
--      can own several properties, so principal cannot be apportioned to one
--      property from it. `principal` is therefore NULL here and
--      debt_service_source resolves to 'loan_record' for every property.
--      See the note on debt_service below; this affects the Dakota Bend
--      acceptance figure.
--
--   2. `rent_roll_line` has NO tenant/resident name column. The brief's
--      rent_roll_unit.tenant cannot be populated. It is selected as NULL so
--      the field exists and renders as the not-available dash rather than
--      being silently dropped from the contract.
--
--   3. `property_financials` has recurring_fee_income, total_expected_income
--      and economic_occupancy, but NO non_recurring_fee_income. The brief
--      said "if derivable" - it is not derivable from any column present, so
--      it is NULL.
--
-- UNVERIFIED: the CONTENT vocabulary in MATCHERS below. section values and
-- line-label spellings are taken from the brief, not read from rows, because
-- no row is readable without the service role. Every one of them fails
-- SILENTLY to NULL if wrong - which is exactly the trap CLAUDE.md opens with -
-- so they are isolated in ONE place and must be confirmed against real rows
-- before this is applied. The query to confirm them is at the bottom.
-- ===========================================================================

create schema if not exists reporting;
grant usage on schema reporting to authenticated;

-- ===========================================================================
-- 1.2  reporting.income_statement_line
-- Account-by-account income statement. A near-direct projection of
-- t12_monthly; it exists so screens never name the raw table.
-- ===========================================================================
create or replace view reporting.income_statement_line
with (security_invoker = true) as
select
  t.tenant_id,
  t.property_id,
  date_trunc('month', t.month)::date as month,
  t.accounting_basis,
  t.section,
  t.account_path,
  t.depth,
  t.line_label,
  t.is_total,
  t.amount,
  t.sort_order
from public.t12_monthly t;

-- ===========================================================================
-- MATCHERS - the only place content vocabulary appears. CONFIRM BEFORE APPLY.
-- ===========================================================================
create or replace view reporting.t12_tagged
with (security_invoker = true) as
select
  t.*,
  -- depth-1 rows are the top-level groups the brief sums for the two totals.
  (t.section = 'income'            and t.depth = 1) as is_operating_income_group,
  (t.section = 'operating_expense' and t.depth = 1) as is_operating_expense_group,
  -- rent: the brief calls it "RENTS / Rent Income group total"
  (t.section = 'income' and (t.account_path ilike '%RENTS%'
                             or t.account_path ilike '%Rent Income%')) as is_rent_group,
  -- capital expenses, asset management fee and mortgage interest all sit in
  -- non_operating_expense
  (t.section = 'non_operating_expense'
     and (t.account_path ilike '%capital expense%'
          or t.account_path ilike '%capex%'))                as is_capex,
  (t.section = 'non_operating_expense'
     and t.account_path ilike '%asset management%')          as is_am_fee,
  (t.section = 'non_operating_expense'
     and (t.account_path ilike '%mortgage interest%'
          or t.account_path ilike '%interest expense%'))     as is_interest
from public.t12_monthly t;

-- ===========================================================================
-- 1.1  reporting.property_month
-- One row per property x month x basis. The spine every monthly screen reads.
-- ===========================================================================
create or replace view reporting.property_month
with (security_invoker = true) as
with months as (
  select distinct tenant_id, property_id, date_trunc('month', month)::date as month, accounting_basis
    from public.t12_monthly
),
-- first_active_month comes from t12_report. t12_monthly has no FK to it, so
-- the join is on (property, basis) and takes the EARLIEST first_active_month
-- on file: a property re-exported later must not lose the history it already
-- had. A month before it is not "zero", it is "this report does not cover it".
active as (
  select property_id, accounting_basis, min(first_active_month) as first_active_month
    from public.t12_report
   group by 1, 2
),
agg as (
  select
    g.tenant_id, g.property_id, date_trunc('month', g.month)::date as month, g.accounting_basis,
    sum(g.amount) filter (where g.is_operating_income_group)  as total_operating_income,
    sum(g.amount) filter (where g.is_operating_expense_group) as total_operating_expense,
    sum(g.amount) filter (where g.is_rent_group and g.is_total) as rent_income,
    sum(g.amount) filter (where g.is_capex)    as capex,
    sum(g.amount) filter (where g.is_am_fee)   as am_fee_booked,
    sum(g.amount) filter (where g.is_interest) as interest
  from reporting.t12_tagged g
  group by 1, 2, 3, 4
),
-- the rent roll that lands IN that month, if one was filed
rr as (
  select distinct on (r.property_id, date_trunc('month', r.as_of_date))
         r.property_id,
         date_trunc('month', r.as_of_date)::date as month,
         r.id as rent_roll_report_id,
         r.as_of_date
    from public.rent_roll_report r
   order by r.property_id, date_trunc('month', r.as_of_date), r.as_of_date desc
),
rr_agg as (
  select
    rr.property_id, rr.month, rr.as_of_date,
    count(l.*)                                                        as units,
    count(l.*) filter (where l.occupancy_status ilike 'occupied')      as occupied,
    count(l.*) filter (where l.occupancy_status not ilike 'occupied')  as vacant,
    sum(l.market_rent)                                                as market_rent_total,
    sum(l.rent)                                                       as rent_total,
    sum(greatest(l.balance_due, 0))                                   as delinquency
  from rr
  join public.rent_roll_line l on l.rent_roll_report_id = rr.rent_roll_report_id
  group by 1, 2, 3
),
-- property_financials is keyed by as_of_date, so it folds to a month
pf as (
  select distinct on (f.property_id, date_trunc('month', f.as_of_date))
         f.property_id,
         date_trunc('month', f.as_of_date)::date as month,
         f.recurring_fee_income,
         f.total_expected_income,
         f.economic_occupancy
    from public.property_financials f
   order by f.property_id, date_trunc('month', f.as_of_date), f.as_of_date desc
),
-- the loan-record fallback for debt service: only usable when EVERY loan on
-- the property states one, or the annual figure is a partial total pretending
-- to be whole.
loan_ds as (
  select c.property_id,
         sum(l.debt_service)                                      as annual_debt_service,
         count(*)                                                 as loans,
         count(*) filter (where l.debt_service is not null)       as loans_with_ds
    from public.loan l
    join public.loan_collateral c on c.loan_id = l.id
   where c.property_id is not null
   group by 1
)
select
  m.tenant_id,
  m.property_id,
  m.month,
  m.accounting_basis,
  (a.first_active_month is null or m.month >= date_trunc('month', a.first_active_month)::date) as has_data,

  agg.total_operating_income,
  agg.total_operating_expense,
  (agg.total_operating_income - agg.total_operating_expense) as noi,

  agg.rent_income,
  agg.capex,
  agg.am_fee_booked,
  agg.interest,

  -- principal is not derivable at property grain (see header note 1)
  null::numeric as principal,

  case when agg.interest is not null and false then 'income_statement'
       else 'loan_record' end as debt_service_source,

  case
    when ld.loans > 0 and ld.loans = ld.loans_with_ds then ld.annual_debt_service / 12.0
    else null
  end as debt_service,

  (
    (agg.total_operating_income - agg.total_operating_expense)
    - coalesce(agg.am_fee_booked, 0)
    - coalesce(case when ld.loans > 0 and ld.loans = ld.loans_with_ds
                    then ld.annual_debt_service / 12.0 end, 0)
    - coalesce(agg.capex, 0)
  ) as cash_flow,

  rr_agg.as_of_date        as rent_roll_as_of,
  rr_agg.units,
  rr_agg.occupied,
  rr_agg.vacant,
  case when rr_agg.units > 0
       then rr_agg.occupied::numeric / rr_agg.units::numeric end as physical_occupancy,
  rr_agg.market_rent_total,
  rr_agg.rent_total,
  (rr_agg.market_rent_total - rr_agg.rent_total) as loss_to_lease,
  rr_agg.delinquency,

  pf.recurring_fee_income,
  null::numeric as non_recurring_fee_income,   -- no column on property_financials
  pf.total_expected_income,
  pf.economic_occupancy
from months m
left join active  a      on a.property_id = m.property_id and a.accounting_basis = m.accounting_basis
left join agg            on agg.property_id = m.property_id and agg.month = m.month
                        and agg.accounting_basis = m.accounting_basis
left join rr_agg         on rr_agg.property_id = m.property_id and rr_agg.month = m.month
left join pf             on pf.property_id = m.property_id and pf.month = m.month
left join loan_ds ld     on ld.property_id = m.property_id;

-- ===========================================================================
-- 1.3  reporting.rent_roll_unit
-- ===========================================================================
create or replace view reporting.rent_roll_unit
with (security_invoker = true) as
with latest as (
  select distinct on (property_id) property_id, id, as_of_date
    from public.rent_roll_report
   order by property_id, as_of_date desc
)
select
  r.tenant_id,
  r.property_id,
  r.as_of_date,
  (latest.id is not null) as is_latest,
  l.unit_label              as unit,
  l.unit_id,
  l.beds,
  l.baths,
  null::text                as tenant,          -- no name column on rent_roll_line
  l.occupancy_status        as status,
  l.occupancy_status,
  l.rent,
  l.market_rent,
  l.balance_due,
  l.lease_start,
  l.lease_end,
  l.move_in,
  l.move_out,
  l.square_feet,
  l.sort_order
from public.rent_roll_report r
join public.rent_roll_line l on l.rent_roll_report_id = r.id
left join latest on latest.id = r.id;

-- ===========================================================================
-- 1.4  reporting.loan
-- One row per loan, with the property it secures. A loan reaches a property
-- directly OR through one of its buildings - CLAUDE.md is explicit that
-- counting only the former misses real debt, so both are unioned.
-- ===========================================================================
create or replace view reporting.loan
with (security_invoker = true) as
with reach as (
  select c.loan_id, c.property_id from public.loan_collateral c where c.property_id is not null
  union
  select c.loan_id, u.property_id from public.loan_collateral c
    join public.unit u on u.id = c.unit_id where c.unit_id is not null
),
latest_balance as (
  select distinct on (loan_id) loan_id, balance, as_of_date
    from public.loan_balance
   order by loan_id, as_of_date desc
)
select
  l.tenant_id,
  l.id as loan_id,
  r.property_id,
  l.lender,
  l.lender_id,
  b.balance        as latest_balance,
  b.as_of_date     as balance_as_of,
  -- CLAUDE.md: interest_rate_pct is a FRACTION (0.035 = 3.5%). Multiplied
  -- here once so no screen has to remember.
  (l.interest_rate_pct * 100) as interest_rate_pct,
  l.maturity_date,
  l.debt_service   as annual_debt_service,
  l.status,
  l.purpose
from public.loan l
left join reach r          on r.loan_id = l.id
left join latest_balance b on b.loan_id = l.id;

-- ===========================================================================
-- 1.5  reporting.property_summary
-- ===========================================================================
create or replace view reporting.property_summary
with (security_invoker = true) as
with units as (
  -- the unit-count rule from CLAUDE.md: the verified count leads, the sum of
  -- buildings' current_total_units is the fallback. unit_count_reported is
  -- NEVER used alone - it holds only the FIRST building's count and reads 26
  -- against a real 87.
  select p.id as property_id,
         coalesce(p.unit_count_verified, bs.building_units) as units
    from public.property p
    left join (select property_id, sum(current_total_units) as building_units
                 from public.unit group by 1) bs on bs.property_id = p.id
),
t12 as (
  select property_id, accounting_basis,
         max(month) as latest_month,
         count(*) filter (where has_data) as months_with_data
    from reporting.property_month
   group by 1, 2
),
trailing as (
  select pm.property_id, pm.accounting_basis,
         sum(pm.total_operating_income)  as t12_income,
         sum(pm.total_operating_expense) as t12_expense,
         sum(pm.noi)                     as t12_noi,
         sum(pm.cash_flow)               as t12_net_income
    from reporting.property_month pm
    join t12 on t12.property_id = pm.property_id and t12.accounting_basis = pm.accounting_basis
   where pm.has_data
     and pm.month > (t12.latest_month - interval '12 months')
   group by 1, 2
),
-- optimised NOI: best 6 consecutive months x 2. Null with fewer than 6.
win6 as (
  select property_id, accounting_basis, month,
         sum(noi) over (partition by property_id, accounting_basis
                        order by month rows between 5 preceding and current row) as noi6,
         count(*) over (partition by property_id, accounting_basis
                        order by month rows between 5 preceding and current row) as n6
    from reporting.property_month
   where has_data
),
opt as (
  select property_id, accounting_basis, max(noi6) * 2 as optimized_noi
    from win6 where n6 = 6 group by 1, 2
),
debt as (
  select property_id,
         sum(latest_balance)                                   as debt,
         count(*)                                              as loans,
         count(*) filter (where annual_debt_service is not null) as loans_with_ds,
         sum(annual_debt_service)                              as annual_debt_service,
         min(maturity_date) filter (where maturity_date >= current_date) as next_maturity
    from reporting.loan where property_id is not null group by 1
),
occ as (
  select distinct on (property_id) property_id, physical_occupancy, rent_roll_as_of
    from reporting.property_month
   where physical_occupancy is not null
   order by property_id, month desc
)
select
  p.id,
  p.tenant_id,
  p.name,
  e.id            as entity_id,
  e.name          as entity_name,
  p.manager       as pm_company,
  tr12.accounting_basis,
  rep.source_system,
  p.city, p.state,
  p.ownership_status,
  u.units,
  occ.physical_occupancy as latest_occupancy,
  occ.rent_roll_as_of    as occupancy_as_of,
  tr12.t12_income, tr12.t12_expense, tr12.t12_noi, tr12.t12_net_income,
  opt.optimized_noi,
  case when tr12.t12_income > 0 then tr12.t12_expense / tr12.t12_income end as expense_ratio,
  d.debt,
  -- only when EVERY loan states one (see property_month)
  case when d.loans > 0 and d.loans = d.loans_with_ds then d.annual_debt_service end as annual_debt_service,
  case when d.loans > 0 and d.loans = d.loans_with_ds and d.annual_debt_service > 0
       then tr12.t12_noi / d.annual_debt_service end as trailing_dscr,
  p.market_value        as value_on_file,
  p.market_value_as_of  as value_as_of,
  case when p.market_value > 0 then d.debt / p.market_value end as ltv,
  d.next_maturity
from public.property p
left join units u      on u.property_id = p.id
left join public.entity e on e.id = p.entity_id
left join trailing tr12 on tr12.property_id = p.id
left join opt          on opt.property_id = p.id and opt.accounting_basis = tr12.accounting_basis
left join debt d       on d.property_id = p.id
left join occ          on occ.property_id = p.id
left join (select distinct on (property_id) property_id, source_system
             from public.t12_report order by property_id, period_end desc) rep
       on rep.property_id = p.id;

-- ===========================================================================
-- 1.6  reporting.am_fee_month
-- Schedule row x month: expected, received, variance.
--
-- The fee rules, in one place:
--   gross           = total_operating_income for the month (cash basis)
--   same_month      -> pct x gross(M)
--   following_month -> pct x gross(M-1)
--   fixed           -> fixed_amount
--   no income data  -> NULL, never 0
--   received        -> am_fee_receipt, else am_fee_booked from the books
--   variance        -> received - expected; a past month with an expected
--                      figure and nothing received is -expected.
-- ===========================================================================
create or replace view reporting.am_fee_month
with (security_invoker = true) as
with cal as (
  select s.id as schedule_id, s.tenant_id, gs::date as fee_month
    from public.am_fee_schedule s
    cross join lateral generate_series(
      date_trunc('month', s.effective_from),
      date_trunc('month', coalesce(s.effective_to, current_date)),
      interval '1 month') gs
),
-- a fee row can cover several properties, so gross is the SUM across them
gross as (
  select l.schedule_id, pm.month, sum(pm.total_operating_income) as gross_income
    from public.am_fee_schedule_property l
    join reporting.property_month pm on pm.property_id = l.property_id
   where pm.accounting_basis = 'cash' and pm.has_data
   group by 1, 2
),
booked as (
  select l.schedule_id, pm.month, sum(pm.am_fee_booked) as am_fee_booked
    from public.am_fee_schedule_property l
    join reporting.property_month pm on pm.property_id = l.property_id
   where pm.accounting_basis = 'cash'
   group by 1, 2
)
-- expected is computed ONCE here. It was written twice - once for the column
-- and once inside variance - and that is a view whose two outputs can be
-- edited into disagreeing with each other while both still run.
--
-- fee_pct is a WHOLE percent (2 = 2%), the opposite of loan.interest_rate_pct.
-- Hence / 100.0, and the CHECK on the column is the other half of that.
resolved as (
  select
    c.tenant_id,
    c.schedule_id,
    c.fee_month,
    s.label,
    s.manager_group,
    s.payment_timing,
    case
      when s.fee_type = 'fixed'                 then s.fixed_amount
      when s.fee_type <> 'pct_gross'            then null
      when s.payment_timing = 'following_month' then (s.fee_pct / 100.0) * g_prev.gross_income
      -- same_month, and anything unrecognised, bills against its own month.
      -- The CHECK constraint makes the third case unreachable; it is spelled
      -- out so this matches am-fee-rules.js rather than relying on it.
      else (s.fee_pct / 100.0) * g_same.gross_income
    end as expected,
    coalesce(r.amount_received, b.am_fee_booked) as received,
    case when r.amount_received is not null then r.source
         when b.am_fee_booked   is not null then 'books' end as received_source
  from cal c
  join public.am_fee_schedule s on s.id = c.schedule_id
  left join gross  g_same on g_same.schedule_id = c.schedule_id and g_same.month = c.fee_month
  left join gross  g_prev on g_prev.schedule_id = c.schedule_id
                         and g_prev.month = (c.fee_month - interval '1 month')::date
  left join booked b      on b.schedule_id = c.schedule_id and b.month = c.fee_month
  left join public.am_fee_receipt r on r.schedule_id = c.schedule_id and r.fee_month = c.fee_month
)
select
  tenant_id, schedule_id, label, manager_group, payment_timing, fee_month,
  expected,
  received,
  received_source,
  case
    when expected is null then null            -- nothing billed, nothing to vary from
    when received is not null then received - expected
    -- a PAST month with an expected figure and nothing received is a full
    -- miss. The current month is simply not due yet.
    when fee_month < date_trunc('month', current_date)::date then -expected
  end as variance
from resolved;

grant select on all tables in schema reporting to authenticated;

-- ===========================================================================
-- CONFIRM THE MATCHERS BEFORE APPLYING THIS.
-- Run as service role; it reads t12_monthly's vocabulary, which no probe can:
--
--   select section, depth, count(*), min(line_label), min(account_path)
--     from public.t12_monthly group by 1, 2 order by 1, 2;
--
--   select distinct account_path from public.t12_monthly
--    where section = 'non_operating_expense' order by 1;
--
-- Expect to see: the three section values spelled exactly 'income',
-- 'operating_expense', 'non_operating_expense'; a rent group matching
-- RENTS or Rent Income; and capital expense / asset management / mortgage
-- interest paths. Every mismatch produces NULL, not an error.
-- ===========================================================================
