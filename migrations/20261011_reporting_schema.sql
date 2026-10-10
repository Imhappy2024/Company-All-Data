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
-- CORRECTED 2026-10-11 against the live database by Jay. Two of the three
-- gaps the probe reported were wrong, and the correction is recorded here
-- because the wrong versions were circulated:
--
--   1. PRINCIPAL IS AVAILABLE. There is no `balance_sheet_change` table and
--      no such section, but principal is in the income statement after all:
--      AppFolio books it in `other_cash_items` as loan/mortgage lines with
--      NEGATIVE amounts (negative = principal paid), and Buildium books it
--      in non_operating_expense as a positive 'Mortgage Principal'.
--      v_gl_balance_sheet is a red herring - it is entity-keyed and was the
--      wrong place to look.
--
--      So debt_service_source is 'income_statement' wherever a property
--      books principal or an unsplit payment, and falls back to the loan
--      record only where it does not. Dakota Bend Jan 2026 is the worked
--      example: interest 8,362.74 + principal 5,176.40 = 13,539.14.
--
--   2. `rent_roll_line` DOES carry the tenant. The column is `tenant_names`,
--      which the probe's candidate list did not contain. A probe can only
--      disprove a name it thinks to try, and "absent from my list" is not
--      "absent from the table" - worth remembering before the next one.
--
--   3. `property_financials` genuinely has NO non_recurring_fee_income.
--      That one stands; it stays NULL.
--
-- The MATCHERS below are now Jay's, read off real rows. They are still the
-- only place content vocabulary appears, and they still fail SILENTLY to
-- NULL if a spelling drifts, so they stay isolated in one view.
-- ===========================================================================

create schema if not exists reporting;
grant usage on schema reporting to authenticated;

-- Dropped and recreated rather than replaced: `create or replace view` cannot
-- add a column anywhere but the end, and this revision adds loan_proceeds and
-- other_interest in the middle of property_month. Nothing holds a foreign key
-- to a view, and saved_view stores a dataset KEY rather than a reference, so
-- dropping these is safe. Reverse dependency order.
drop view if exists reporting.am_fee_month        cascade;
drop view if exists reporting.property_summary    cascade;
drop view if exists reporting.property_month      cascade;
drop view if exists reporting.t12_tagged          cascade;
drop view if exists reporting.rent_roll_unit      cascade;
drop view if exists reporting.loan                cascade;
drop view if exists reporting.income_statement_line cascade;

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
-- MATCHERS - the only place content vocabulary appears.
--
-- These are Jay's, read off the live database on 2026-10-11, NOT guessed.
-- They cover both source systems, which spell everything differently:
--
--   Buildium   'Rent Income'           AppFolio  'RENTS'
--   Buildium   'Capital Improvements'  AppFolio  'CAPITAL EXPENSES'
--   Buildium   'Mortgage Principal'    AppFolio  'Principal Payment', or a
--                                                balance-sheet loan line
--
-- The five sections are exactly: income, operating_expense,
-- non_operating_income, non_operating_expense, other_cash_items.
--
-- THE SIGN RULE. other_cash_items is a balance-sheet section: an outflow is
-- stored NEGATIVE. Principal and the one AppFolio capex line there are
-- therefore negated into positive figures, so every number this view emits
-- is a positive cost. Mixing a negative principal into debt service silently
-- SUBTRACTS the principal from the interest and produces a debt service
-- smaller than the interest alone - which still renders, and still looks
-- plausible.
-- ===========================================================================
create or replace view reporting.t12_tagged
with (security_invoker = true) as
select
  t.*,

  -- the two depth-1 group totals the brief sums
  (t.section = 'income'            and t.depth = 1) as is_operating_income_group,
  (t.section = 'operating_expense' and t.depth = 1) as is_operating_expense_group,

  -- RENT. Three tiers, taken in order by the aggregate below: the depth-1
  -- TOTAL line first, then a depth-1 non-total, then AppFolio's
  -- 'Rent - Residential' total nested under 'INCOME - TENANT'.
  (t.section = 'income' and t.depth = 1 and t.is_total
     and (t.line_label ~* '^(rent income|rents)$'))               as is_rent_total,
  (t.section = 'income' and t.depth = 1 and not t.is_total
     and t.line_label ~* '^rent income$')                         as is_rent_depth1,
  (t.section = 'income' and t.is_total
     and t.line_label ~* '^rent - residential$'
     and array_to_string(t.account_path, ' > ') ~* 'INCOME - TENANT') as is_rent_tenant,

  -- ASSET MANAGEMENT FEE. Non-total, any depth. Buildium nests it under
  -- 'Non-operating Expense'; AppFolio under 'Other Expense', 'Corporate
  -- Overhead Expenses' or 'OTHER EXPENSES', with the word Fee(s) cased
  -- inconsistently.
  (t.section = 'non_operating_expense' and not t.is_total
     and t.line_label ~* '^asset management fees?$')              as is_am_fee,

  -- CAPEX. Depth-1 totals in non_operating_expense, plus the single AppFolio
  -- property that books it in other_cash_items.
  (t.section = 'non_operating_expense' and t.depth = 1 and t.is_total
     and t.line_label ~* '^(capital improvements|capital expenses)$')
                                                                  as is_capex_total,
  (t.section = 'other_cash_items' and not t.is_total
     and t.line_label ~* '^capital expenditures$')                as is_capex_cash,

  -- INTEREST. Non-total, any depth. Three spellings count, and they are
  -- mutually exclusive in practice: BG Flats, Champion Villas and Doral use
  -- 'Interest Exp'; The Whitney and Uptown Flats use 'Interest Payment'; and
  -- NONE of those five carries a 'Mortgage Interest' line, so the alternate
  -- spellings are their only interest rather than an extra.
  --
  -- The anchors matter. '^interest exp$' must not reach 'Interest Expense',
  -- which is a different label on a different property.
  (t.section = 'non_operating_expense' and not t.is_total
     and t.line_label ~* '^(mortgage interest|interest exp|interest payment)$') as is_interest,

  -- INTEREST THAT IS DELIBERATELY NOT COUNTED. 'Other Interest Expense'
  -- (Cedar Haven, Estrella, Heston Pointe, Sierra Gardens, The Beverly) and
  -- 'Other interest' (Franklin Court, Lions Gate) sit ALONGSIDE a real
  -- 'Mortgage Interest' line on every one of those properties, so they are
  -- other debt - a line of credit or similar - and adding them would inflate
  -- debt service and depress DSCR on seven properties.
  --
  -- 'Interest Expense' (Ash Street Place, 2023-09 to 2024-03) is also out: it
  -- is in neither list, it is that property's only interest line, and its
  -- data ends before the current reporting period, so excluding it moves no
  -- live figure. Surfaced rather than silently folded in either direction.
  (t.section = 'non_operating_expense' and not t.is_total
     and t.line_label ~* 'interest'
     and t.line_label !~* '^(mortgage interest|interest exp|interest payment)$') as is_other_interest,

  -- LOAN PROCEEDS. The positive side of other_cash_items: money arriving
  -- rather than principal paid. Doral's 4,326,000.00 refinance in MAY 2026
  -- and its 200,000.00 'Loan - Other' in June, plus two 960.40 'Arrow Loan'
  -- rows at Capitol City Villas.
  --
  -- 'Loan - Other' IS proceeds even though it is excluded from principal, so
  -- it is included here and the label rides along - see loan_proceeds_note.
  (t.section = 'other_cash_items' and not t.is_total
     and t.amount > 0
     and t.line_label ~* '(loan|mortgage)'
     and t.line_label !~* '(security deposit|prepaid|clearing)')  as is_loan_proceeds,

  -- PRINCIPAL, booked as an expense. Already positive.
  (t.section = 'non_operating_expense' and not t.is_total
     and t.line_label ~* '^(mortgage principal|principal payment)$')
                                                                  as is_principal_expense,

  -- PRINCIPAL, booked as a balance-sheet movement.
  --
  -- `amount < 0` IS THE RULE, not a tidy-up. In this section a negative is
  -- money leaving (principal paid) and a POSITIVE is money arriving - a draw.
  -- The live data holds four: Doral's +4,326,000.00 refinance in MAY 2026
  -- and its +200,000.00 'Loan - Other' in June, plus two +960.40 'Arrow Loan'
  -- rows at Capitol City Villas in January and February.
  --
  -- (An earlier note here said April. That was read off a renderer that
  -- called toISOString() on a DATE, which from UTC+8 shifts 2026-05-01 back
  -- to 2026-04-30 - the same timezone bug CLAUDE.md records against paid_at,
  -- this time in the tool doing the verifying rather than in the product.)
  -- Negated, that refinance becomes principal of MINUS 4.3M, a debt service
  -- of minus 4.3M and a wildly positive cash flow, all of which render
  -- perfectly happily.
  --
  -- The label exclusions are the second line: 'Loan - Other' is not a
  -- mortgage, and a security deposit, prepaid or clearing account is not
  -- debt service.
  (t.section = 'other_cash_items' and not t.is_total
     and t.amount < 0
     and t.line_label ~* '(loan|mortgage)'
     and t.line_label !~* '^loan - other$'
     and t.line_label !~* '(security deposit|prepaid|clearing)')  as is_principal_cash,

  -- UNSPLIT PAYMENTS. Interest and principal in one line, so the whole line
  -- is debt service.
  --
  -- The two near-misses are the reason this is spelled out rather than
  -- matched on 'mortgage payment': 'Mortgage Escrow Replacement Reserve' is
  -- a reserve, and 'Mortgage Escrow Expense' is taxes and insurance, which
  -- is an OPERATING expense. Both contain the word Mortgage and neither is
  -- debt service; counting either inflates DSCR's denominator.
  (t.section = 'non_operating_expense' and not t.is_total
     and t.line_label ~* '^mortgage payment( - seller carry)?$')  as is_unsplit_payment
from public.t12_monthly t;

-- ===========================================================================
-- 1.1  reporting.property_month
-- One row per property x month x basis. The spine every monthly screen reads.
--
-- DEBT SERVICE is decided at PROPERTY level, then summed per month.
--
-- A property whose books carry principal or unsplit-payment lines anywhere in
-- the period uses its income statement for every month; one whose books carry
-- interest only falls back to the loan record. Deciding this per MONTH instead
-- would flip the source mid-year on any property with a ragged export, and the
-- two sources do not agree, so a column would silently mix them.
--
-- Franklin Court is the fallback case: interest only in its books, so its
-- debt service is the loan record's annual figure / 12.
-- ===========================================================================
create or replace view reporting.property_month
with (security_invoker = true) as
with months as (
  select distinct tenant_id, property_id, date_trunc('month', month)::date as month, accounting_basis
    from public.t12_monthly
),
-- first_active_month comes from t12_report. t12_monthly has no FK to it, so
-- the join is on (property, basis) and takes the EARLIEST on file: a property
-- re-exported later must not lose history it already had. A month before it is
-- not "zero", it is "this report does not cover it".
-- t12_monthly DOES carry a foreign key to t12_report: source_t12_report_id.
-- An earlier version joined on (property, basis) because a column probe had
-- not thought to try that name - the same miss as tenant_names. The real key
-- is exact, so first_active_month comes from the report that actually
-- supplied the row.
--
-- active_any is the fallback for a row whose source report is missing, and
-- for it the earliest first_active_month on file wins: a property re-exported
-- later must not lose history it already had.
active_any as (
  select property_id, min(first_active_month) as first_active_month
    from public.t12_report group by 1
),
agg as (
  select
    g.tenant_id, g.property_id, date_trunc('month', g.month)::date as month, g.accounting_basis,

    sum(g.amount) filter (where g.is_operating_income_group)  as total_operating_income,
    sum(g.amount) filter (where g.is_operating_expense_group) as total_operating_expense,

    -- rent, in tier order
    sum(g.amount) filter (where g.is_rent_total)  as rent_total_line,
    sum(g.amount) filter (where g.is_rent_depth1) as rent_depth1_line,
    sum(g.amount) filter (where g.is_rent_tenant) as rent_tenant_line,

    -- capex: the expense-section total, plus the balance-sheet line negated
    -- into a positive cost
    coalesce(sum(g.amount)  filter (where g.is_capex_total), 0)
      + coalesce(sum(-g.amount) filter (where g.is_capex_cash), 0)        as capex_raw,
    count(*) filter (where g.is_capex_total or g.is_capex_cash)           as capex_lines,

    sum(g.amount) filter (where g.is_am_fee)   as am_fee_booked,
    sum(g.amount) filter (where g.is_interest) as interest,
    count(*) filter (where g.is_interest)      as interest_lines,
    sum(g.amount) filter (where g.is_other_interest) as other_interest,
    sum(g.amount) filter (where g.is_loan_proceeds)  as loan_proceeds,
    string_agg(distinct g.line_label, ', ') filter (where g.is_loan_proceeds) as loan_proceeds_note,

    -- principal: expense lines are positive already, balance-sheet lines are
    -- negative and are negated
    coalesce(sum(g.amount)  filter (where g.is_principal_expense), 0)
      + coalesce(sum(-g.amount) filter (where g.is_principal_cash), 0)    as principal_raw,
    count(*) filter (where g.is_principal_expense or g.is_principal_cash) as principal_lines,

    sum(g.amount) filter (where g.is_unsplit_payment)                     as unsplit_payment,
    count(*) filter (where g.is_unsplit_payment)                          as unsplit_lines,
    min(rep.first_active_month)                                           as first_active_month
  from reporting.t12_tagged g
  left join public.t12_report rep on rep.id = g.source_t12_report_id
  group by 1, 2, 3, 4
),
-- How does this property's debt service get decided? Three steps, in order,
-- and the decision is made per PROPERTY over the whole period so a ragged
-- export cannot flip the source mid-year and mix two of them in one column.
--
--   a) its books carry principal or an unsplit payment -> income_statement
--   b) else every loan on it states an annual figure    -> loan_record
--   c) else its books carry interest                    -> interest_only_books
--
-- (c) exists because of Doral: interest every month from May 2026, no
-- principal line, and no loan record either - so the first two steps both
-- yield NULL and the screen showed a blank debt service for a property that
-- demonstrably pays one. Interest-only is an understatement of the real
-- payment, not a guess at it, so the source is named and the screen says
-- "interest only, from the books" rather than presenting it as complete.
ds_capable as (
  select property_id, accounting_basis,
         (sum(principal_lines) + sum(unsplit_lines)) > 0 as books_debt_service,
         sum(interest_lines) > 0                         as books_interest
    from agg group by 1, 2
),
rr as (
  select distinct on (r.property_id, date_trunc('month', r.as_of_date))
         r.property_id,
         date_trunc('month', r.as_of_date)::date as month,
         r.id as rent_roll_report_id,
         r.as_of_date
    from public.rent_roll_report r
   order by r.property_id, date_trunc('month', r.as_of_date), r.as_of_date desc
),
-- A rent_roll_line is a LEASE, not a unit. Copperleaf has 494 lines over 87
-- units, and 156 of them are 'current' across only 82 units - roommates and
-- co-tenants each get a line, and expired leases stay on file.
--
-- So counting ROWS gives 494 units at a property with 87, and summing rent
-- over rows counts every roommate separately. Both render perfectly happily.
--
-- The states are: current, past, vacant_unrented, vacant_rented, future,
-- notice. There is no 'occupied' - the first version matched that word, found
-- nothing, and every occupancy on the portfolio page read 0.0%, which is the
-- silent-NULL trap one level down: the figure was present and wrong rather
-- than absent.
--
-- Fold to one row per UNIT first, then aggregate.
rr_units as (
  select
    rr.property_id, rr.month, rr.as_of_date,
    coalesce(l.unit_label, l.unit_id::text)                             as unit_key,
    max(case when l.occupancy_status = 'current' then 1 else 0 end)     as is_occupied,
    sum(l.rent) filter (where l.occupancy_status = 'current')           as unit_rent,
    max(l.market_rent)                                                  as unit_market,
    sum(greatest(l.balance_due, 0))                                     as unit_balance
  from rr
  join public.rent_roll_line l on l.rent_roll_report_id = rr.rent_roll_report_id
  group by 1, 2, 3, 4
),
rr_agg as (
  select
    property_id, month, as_of_date,
    count(*)                        as units,
    sum(is_occupied)                as occupied,
    count(*) - sum(is_occupied)     as vacant,
    sum(unit_market)                as market_rent_total,
    sum(unit_rent)                  as rent_total,
    sum(unit_balance)               as delinquency
  from rr_units
  group by 1, 2, 3
),
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
-- the fallback. Only usable when EVERY loan states one, or the annual figure
-- is a partial total pretending to be whole.
loan_ds as (
  select c.property_id,
         sum(l.debt_service)                                as annual_debt_service,
         count(*)                                           as loans,
         count(*) filter (where l.debt_service is not null) as loans_with_ds
    from public.loan l
    join public.loan_collateral c on c.loan_id = l.id
   where c.property_id is not null
   group by 1
),
resolved as (
  select
    m.tenant_id, m.property_id, m.month, m.accounting_basis,
    (coalesce(agg.first_active_month, aa.first_active_month) is null
       or m.month >= date_trunc('month',
            coalesce(agg.first_active_month, aa.first_active_month))::date) as has_data,

    agg.total_operating_income,
    agg.total_operating_expense,
    (agg.total_operating_income - agg.total_operating_expense) as noi,

    coalesce(agg.rent_total_line, agg.rent_depth1_line, agg.rent_tenant_line) as rent_income,
    case when agg.capex_lines > 0 then agg.capex_raw end as capex,
    agg.am_fee_booked,
    agg.interest,
    case when agg.principal_lines > 0 then agg.principal_raw end as principal,
    agg.unsplit_payment,

    case
      when dc.books_debt_service                          then 'income_statement'
      when ld.loans > 0 and ld.loans = ld.loans_with_ds   then 'loan_record'
      when dc.books_interest                              then 'interest_only_books'
    end as debt_service_source,

    case
      when dc.books_debt_service then
        coalesce(agg.interest, 0) + coalesce(case when agg.principal_lines > 0 then agg.principal_raw end, 0)
          + coalesce(agg.unsplit_payment, 0)
      when ld.loans > 0 and ld.loans = ld.loans_with_ds then ld.annual_debt_service / 12.0
      when dc.books_interest then agg.interest
    end as debt_service,

    agg.other_interest,
    agg.loan_proceeds,
    agg.loan_proceeds_note,

    rr_agg.as_of_date as rent_roll_as_of,
    rr_agg.units, rr_agg.occupied, rr_agg.vacant,
    case when rr_agg.units > 0
         then rr_agg.occupied::numeric / rr_agg.units::numeric end as physical_occupancy,
    rr_agg.market_rent_total,
    rr_agg.rent_total,
    (rr_agg.market_rent_total - rr_agg.rent_total) as loss_to_lease,
    rr_agg.delinquency,

    pf.recurring_fee_income,
    null::numeric as non_recurring_fee_income,   -- no such column; confirmed absent
    pf.total_expected_income,
    pf.economic_occupancy
  from months m
  left join active_any aa on aa.property_id = m.property_id
  left join agg           on agg.property_id = m.property_id and agg.month = m.month
                         and agg.accounting_basis = m.accounting_basis
  left join ds_capable dc on dc.property_id = m.property_id and dc.accounting_basis = m.accounting_basis
  left join rr_agg        on rr_agg.property_id = m.property_id and rr_agg.month = m.month
  left join pf            on pf.property_id = m.property_id and pf.month = m.month
  left join loan_ds ld    on ld.property_id = m.property_id
)
-- cash_flow reads debt_service from the CTE rather than restating the CASE.
-- Written inline it was two copies of one rule, and an edit to either leaves
-- a view whose debt service and cash flow disagree while both still run.
select
  r.*,
  (r.noi - coalesce(r.am_fee_booked, 0) - coalesce(r.debt_service, 0) - coalesce(r.capex, 0)) as cash_flow,
  case when r.debt_service > 0 then r.noi / r.debt_service end as dscr
from resolved r;

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
  l.tenant_names            as tenant,
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
  l.sort_order,
  -- APPENDED, not inserted: `create or replace view` cannot change the name
  -- of an existing column position, so a new field goes on the end.
  --
  -- A line is a LEASE. 'past' and 'future' are history rather than the unit's
  -- state today, and a property carries hundreds of them - Copperleaf has 494
  -- lines over 87 units. The Rent roll tab filters on this.
  (l.occupancy_status in ('current', 'vacant_unrented', 'vacant_rented', 'notice')) as is_current
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
trailing_12 as (
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
  e.id            as entity_id,
  e.name          as entity_name,
  p.management_company as pm_company,
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
  p.current_market_value       as value_on_file,
  p.current_market_value_asof  as value_as_of,
  case when p.current_market_value > 0 then d.debt / p.current_market_value end as ltv,
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
left join trailing_12 tr12 on tr12.property_id = p.id
left join opt          on opt.property_id = p.id and opt.accounting_basis = tr12.accounting_basis
left join debt d       on d.property_id = p.id
left join occ          on occ.property_id = p.id
left join (select distinct on (property_id) property_id, source_system
             from public.t12_report order by property_id, period_end desc) rep
       on rep.property_id = p.id
left join t12_doc t12d on t12d.property_id = p.id
left join rr_doc  rrd  on rrd.property_id = p.id;

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
   where lower(pm.accounting_basis) = 'cash' and pm.has_data
   group by 1, 2
),
booked as (
  select l.schedule_id, pm.month, sum(pm.am_fee_booked) as am_fee_booked
    from public.am_fee_schedule_property l
    join reporting.property_month pm on pm.property_id = l.property_id
   where lower(pm.accounting_basis) = 'cash'
   group by 1, 2
),
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
-- CONFIRM THE MATCHERS. They were read off real rows by Jay on 2026-10-11,
-- so this is a regression check rather than a discovery, but every one of
-- them still fails SILENTLY to NULL if a spelling drifts.
--
--   -- the five sections, and nothing else
--   select section, count(*) from public.t12_monthly group by 1 order by 1;
--
--   -- every line the matchers claim, with what they matched
--   select section, depth, is_total, line_label, count(*)
--     from public.t12_monthly
--    where line_label ~* '^(rent income|rents|rent - residential)$'
--       or line_label ~* '^asset management fees?$'
--       or line_label ~* '^(capital improvements|capital expenses|capital expenditures)$'
--       or line_label ~* '^mortgage interest$'
--       or line_label ~* '^(mortgage principal|principal payment)$'
--       or line_label ~* '^mortgage payment( - seller carry)?$'
--       or (section = 'other_cash_items' and line_label ~* '(loan|mortgage)')
--    group by 1,2,3,4 order by 1,4;
--
--   -- THE EXCLUSIONS. Every row here is money the principal matcher does
--   -- NOT count. Read it: anything in this list that is really a mortgage
--   -- payment is debt service going missing, and DSCR reads high.
--   select distinct line_label from public.t12_monthly
--    where section = 'other_cash_items' and line_label ~* '(loan|mortgage)'
--      and (line_label ~* '^loan - other$'
--           or line_label ~* '(security deposit|prepaid|clearing)')
--    order by 1;
--
--   -- the sign rule: other_cash_items loan lines should be NEGATIVE
--   select line_label, min(amount), max(amount) from public.t12_monthly
--    where section = 'other_cash_items' and line_label ~* '(loan|mortgage)'
--    group by 1 order by 1;
-- ===========================================================================
