-- ===========================================================================
-- Best NOI: runs of months above the 12-month average (Jay, 2026-10-13)
--
-- REVIEW ONLY until Jay approves. migrations/ is not auto-applied.
--
-- Supersedes 20261016 (best trailing period). Replaces ONE CTE of
-- reporting.property_summary; every column keeps its name, type and position
-- and every other column is computed exactly as before (checked in the dry
-- run). optimized_noi now holds the LATEST Best NOI, and is NULL when the
-- latest month is below the 12-month average.
--
-- After applying:  node tools/refresh-reporting.js
-- To reverse: re-run 20261016_optimized_noi_trailing.sql, then refresh.
-- ===========================================================================

create or replace view reporting.property_summary
with (security_invoker = true) as
with rr_units as (
  -- the latest rent roll's own unit count, which is a COUNT OF UNITS rather
  -- than of leases (property_month folds leases to units first)
  select distinct on (property_id) property_id, units, rent_roll_as_of as as_of_date
    from reporting.property_month_mv
   where units is not null
   order by property_id, month desc
),
units as (
  -- The unit-count rule from CLAUDE.md, with a THIRD step.
  --
  -- The verified count leads; the sum of buildings' current_total_units is
  -- the fallback. Both are NULL on a lot of properties - Modern Heights,
  -- 500 S Dakota, Adventureland, Aksarben and BG Flats all have either no
  -- unit rows at all or unit rows whose current_total_units was never
  -- filled - so the page showed a dash for properties whose rent roll names
  -- 160, 22, 72, 24 and 42 units respectively.
  --
  -- The rent roll is the third step. It is LAST on purpose: it is a snapshot
  -- of what was leasable on one date, where unit_count_verified is a
  -- deliberate statement about the asset. Where they disagree the verified
  -- figure still wins, and units_rent_roll carries the other number so the
  -- disagreement is visible rather than resolved silently. Altoona Terrace
  -- is the live case: 84 verified against 83 on the rent roll.
  --
  -- unit_count_reported is still NEVER used - it holds only the FIRST
  -- building's count and reads 26 against a real 87.
  --
  -- v2 (PROPERTIES_SPEC v2 section 5): the LATEST RENT ROLL now leads, then
  -- the verified count, then the buildings. The rent roll is the only source
  -- refreshed every month, and its unit count is now a count of units as
  -- they stand (past and future leases excluded), so it is the figure
  -- occupancy is a share of. Altoona Terrace moves from 84 (verified) to 83
  -- (rent roll); units_disagree still flags that.
  select p.id as property_id,
         coalesce(rr.units, p.unit_count_verified, bs.building_units) as units,
         case when rr.units              is not null then 'rent_roll'
              when p.unit_count_verified is not null then 'verified'
              when bs.building_units     is not null then 'buildings'
         end as units_source,
         rr.units      as units_rent_roll,
         rr.as_of_date as units_rent_roll_as_of
    from public.property p
    left join (select property_id, sum(current_total_units) as building_units
                 from public.unit group by 1) bs on bs.property_id = p.id
    left join rr_units rr on rr.property_id = p.id
),
t12 as (
  select property_id, accounting_basis,
         max(month) as latest_month,
         count(*) filter (where has_data) as months_with_data
    from reporting.property_month_mv
   group by 1, 2
),
trailing_12 as (
  select pm.property_id, pm.accounting_basis,
         sum(pm.total_operating_income)  as t12_income,
         sum(pm.total_operating_expense) as t12_expense,
         sum(pm.noi)                     as t12_noi,
         sum(pm.cash_flow)               as cash_flow_after_debt_and_capex,
         sum(pm.debt_service)            as t12_debt_service,
         -- what the property actually pays a year: the months that carry a
         -- figure, averaged and annualised, so a month with no export yet
         -- does not read as a month with no payment
         avg(pm.debt_service) * 12       as annual_debt_service_paid,
         sum(pm.recurring_other_interest) as t12_other_interest,
         bool_or(pm.debt_service_source = 'interest_only_books') as any_interest_only
    from reporting.property_month_mv pm
    join t12 on t12.property_id = pm.property_id and t12.accounting_basis = pm.accounting_basis
   where pm.has_data
     and pm.month > (t12.latest_month - interval '12 months')
   group by 1, 2
),
-- Best NOI (2026-10-13, Jay), carried in the optimized_noi column. A month is
-- GOOD when its NOI is above the property's average month over the twelve
-- months ending at its latest month with data. Best NOI is the unbroken run
-- of good months that ends at that latest month, annualised (T1 if only that
-- month, T2 if the two latest, ...). NULL when the latest month is not good:
-- the screens then say "None" and show the previous run instead. A month with
-- no NOI breaks a run. Same rule in JS: bestRuns() in props-api.js.
last_m as (
  select property_id, accounting_basis, max(month) as m
    from reporting.property_month_mv
   where has_data
   group by 1, 2
),
base as (
  select pm.property_id, pm.accounting_basis, pm.month, pm.noi, l.m
    from reporting.property_month_mv pm
    join last_m l on l.property_id = pm.property_id and l.accounting_basis = pm.accounting_basis
   where pm.has_data
     and pm.month > l.m - interval '12 months'
),
avg_m as (
  select property_id, accounting_basis, avg(noi) as a
    from base where noi is not null group by 1, 2
),
tw as (
  select b.property_id, b.accounting_basis, b.month, b.m,
         row_number() over w as k,
         sum(b.noi) over (w rows between unbounded preceding and current row) as noi_k,
         bool_and(coalesce(b.noi > am.a, false)) over (w rows between unbounded preceding and current row) as all_good
    from base b
    join avg_m am on am.property_id = b.property_id and am.accounting_basis = b.accounting_basis
  window w as (partition by b.property_id, b.accounting_basis order by b.month desc)
),
opt as (
  -- the longest unbroken run of good months that ends at the latest month
  select distinct on (property_id, accounting_basis)
         property_id, accounting_basis, noi_k * 12.0 / k as optimized_noi
    from tw
   where all_good
     and month = (m - make_interval(months => (k - 1)::int))::date
   order by property_id, accounting_basis, k desc
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
    from reporting.property_month_mv
   where physical_occupancy is not null
   order by property_id, month desc
),
-- "In Dropbox (T12 / Rent roll)". The brief asks the Properties table to say
-- whether each report is actually filed, and property_summary had no such
-- column - the first version printed the SOURCE SYSTEM under that heading,
-- which answers a different question and answers it for every property that
-- has any data at all.
--
-- Taken from the document linked to the property's LATEST report of each
-- kind: 88 of 89 t12_reports and 89 of 90 rent_roll_reports carry a
-- document_id, so the one that does not reads "not filed" rather than
-- silently inheriting an older report's file.
t12_doc as (
  select distinct on (r.property_id)
         r.property_id, d.id as document_id, d.file_name, d.storage_path, r.period_end
    from public.t12_report r
    left join public.document d on d.id = r.document_id
   order by r.property_id, r.period_end desc nulls last
),
rr_doc as (
  select distinct on (r.property_id)
         r.property_id, d.id as document_id, d.file_name, d.storage_path, r.as_of_date
    from public.rent_roll_report r
    left join public.document d on d.id = r.document_id
   order by r.property_id, r.as_of_date desc nulls last
)
select
  p.id,
  p.tenant_id,
  coalesce(p.dba_name, p.trade_name) as name,
  -- The OWNER LLC, which is what property.entity_id points at.
  e.id            as entity_id,
  e.name          as entity_name,
  -- The MANAGING entity, which is the level the portfolio drills through.
  -- entity.manager_entity_id gives 17 of them across the portfolio; 35 held
  -- properties have none, and they are bucketed rather than hidden - a
  -- property with no manager on file is a gap to close, not a property to
  -- drop off the navigation.
  m.id            as managing_entity_id,
  m.name          as managing_entity_name,
  p.street,
  p.zip,
  p.asset_type,
  p.year_built,
  p.purchase_price,
  p.purchase_date,
  p.management_company as pm_company,
  tr12.accounting_basis,
  rep.source_system,
  p.city, p.state,
  p.ownership_status,
  u.units,
  u.units_source,
  u.units_rent_roll,
  u.units_rent_roll_as_of,
  -- true when the two sources disagree, so a screen can say so
  (u.units_rent_roll is not null and u.units is not null
     and u.units_rent_roll <> u.units) as units_disagree,
  occ.physical_occupancy as latest_occupancy,
  occ.rent_roll_as_of    as occupancy_as_of,
  tr12.t12_income, tr12.t12_expense, tr12.t12_noi, tr12.cash_flow_after_debt_and_capex,
  opt.optimized_noi,
  case when tr12.t12_income > 0 then tr12.t12_expense / tr12.t12_income end as expense_ratio,
  d.debt,
  -- only when EVERY loan states one (see property_month)
  case when d.loans > 0 and d.loans = d.loans_with_ds then d.annual_debt_service end as annual_debt_service,
  -- `trailing_dscr` is MORTGAGE ONLY and keeps that meaning; the saved
  -- Coverage watchlist filters on it.
  case when d.loans > 0 and d.loans = d.loans_with_ds and d.annual_debt_service > 0
       then tr12.t12_noi / d.annual_debt_service end as trailing_dscr,
  -- the books' own twelve months, which is what the all-debt figure is built
  -- on - the loan record knows nothing about a seller-carry note's interest
  case when tr12.t12_debt_service > 0 then tr12.t12_noi / tr12.t12_debt_service end as trailing_dscr_mortgage,
  case when (coalesce(tr12.t12_debt_service,0) + coalesce(tr12.t12_other_interest,0)) > 0
       then tr12.t12_noi / (coalesce(tr12.t12_debt_service,0) + coalesce(tr12.t12_other_interest,0))
       end as trailing_dscr_all_debt,
  tr12.t12_debt_service,
  tr12.annual_debt_service_paid,
  tr12.t12_other_interest,
  coalesce(tr12.any_interest_only, false) as debt_service_interest_only,
  p.current_market_value       as value_on_file,
  p.current_market_value_asof  as value_as_of,
  -- Six months is the line the brief draws. A value with no date at all is
  -- also stale: "we do not know when this was true" is not the same claim as
  -- "this is current", and only one of them is safe to divide debt by.
  (p.current_market_value is not null
     and (p.current_market_value_asof is null
          or p.current_market_value_asof < (current_date - interval '6 months'))) as value_is_stale,
  case when p.current_market_value > 0 then d.debt / p.current_market_value end as ltv,
  case when p.current_market_value > 0 then 'on_file' end as ltv_basis,
  d.next_maturity,

  (t12d.document_id is not null)            as t12_in_dropbox,
  t12d.file_name                            as t12_file_name,
  t12d.storage_path                         as t12_storage_path,
  t12d.period_end                           as t12_period_end,
  (rrd.document_id is not null)             as rent_roll_in_dropbox,
  rrd.file_name                             as rent_roll_file_name,
  rrd.storage_path                          as rent_roll_storage_path,
  rrd.as_of_date                            as rent_roll_as_of
from public.property p
left join units u      on u.property_id = p.id
left join public.entity e on e.id = p.entity_id
left join public.entity m on m.id = e.manager_entity_id
left join trailing_12 tr12 on tr12.property_id = p.id
left join opt          on opt.property_id = p.id and opt.accounting_basis = tr12.accounting_basis
left join debt d       on d.property_id = p.id
left join occ          on occ.property_id = p.id
left join (select distinct on (property_id) property_id, source_system
             from public.t12_report order by property_id, period_end desc) rep
       on rep.property_id = p.id
left join t12_doc t12d on t12d.property_id = p.id
left join rr_doc  rrd  on rrd.property_id = p.id;
