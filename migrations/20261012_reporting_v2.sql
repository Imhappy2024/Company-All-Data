-- ===========================================================================
-- reporting schema v2  (PROPERTIES_SPEC v2, 2026-10-12)
--
-- REVIEW ONLY until Jay approves. migrations/ is not auto-applied.
--
-- A full re-run of 20261011_reporting_schema.sql with the v2 changes, so the
-- whole schema can be read in one place. What changed against v1:
--
--   1. RENT ROLL FOLD. Only the lines that describe a unit TODAY count
--      (current, notice, vacant_rented, vacant_unrented); past and future
--      leases are history. Occupied = current OR notice. Delinquency is the
--      unit's NET balance when positive, prepaid its net credit. Loss to lease
--      is market rent of OCCUPIED units less their rent. Reproduces the
--      mockup's rent-roll figures for all 50 properties with a rent roll
--      (Franklin Court 172 units, 165 occupied = 95.9%).
--   2. UNITS ORDER. Latest rent roll first, then unit_count_verified, then the
--      sum of buildings. (v1 had verified first.)
--   3. RENAME. property_summary.t12_net_income -> cash_flow_after_debt_and_capex
--      (it was always NOI less fee, debt service, other debt and capex).
--      True net income comes from reporting.income_statement_month.
--   4. NEW property_summary.annual_debt_service_paid: the average monthly debt
--      service over the trailing twelve months with data, x 12. Books first,
--      loan record where the books carry none (property_month's own rule).
--      This is the figure the Needs attention explanations quote.
--   5. NEW reporting.income_statement_month: the depth-1 lines of every
--      section, which is the income statement as the mockup lays it out.
--      Net income = income + non-operating income - operating expense -
--      non-operating expense. Dakota Bend Oct 2025 to Sep 2026: 17,140.74.
--   6. NEW reporting.cash_flow_line: other_cash_items classified as operating
--      (deposits, prepaid, escrow, clearing, accruals), financing (loan
--      principal, credit line, owner contributions and distributions,
--      intercompany) or investing (building, land, fixtures, intangibles,
--      capital expenditures booked here).
--   7. NEW public.capex_category_map + reporting.capex_line: every capex
--      account line with its category. The seeded rules reproduce the
--      mockup's categories exactly for all 44 properties with capex.
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
drop materialized view if exists reporting.property_summary_mv cascade;
drop materialized view if exists reporting.property_month_mv   cascade;
drop view if exists reporting.am_fee_month        cascade;
drop view if exists reporting.property_summary    cascade;
drop view if exists reporting.property_month      cascade;
drop view if exists reporting.t12_tagged          cascade;
drop view if exists reporting.rent_roll_unit      cascade;
drop view if exists reporting.loan                cascade;
drop view if exists reporting.income_statement_line cascade;
drop view if exists reporting.income_statement_month cascade;
drop view if exists reporting.cash_flow_line cascade;
drop view if exists reporting.capex_line cascade;

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
--
-- v2: only lines that describe the unit TODAY count - past and future leases
-- are history, and counting them made a unit that turned over twice look like
-- three units. Occupied = current OR notice (a tenant on notice still lives
-- there). Balance is netted per unit, so a roommate's credit offsets the
-- other's charge exactly as the rent roll's own unit total does.
rr_units as (
  select
    rr.property_id, rr.month, rr.as_of_date,
    coalesce(l.unit_label, l.unit_id::text)                                       as unit_key,
    max(case when l.occupancy_status in ('current', 'notice') then 1 else 0 end)  as is_occupied,
    sum(l.rent) filter (where l.occupancy_status in ('current', 'notice'))        as unit_rent,
    max(l.market_rent)                                                            as unit_market,
    sum(l.balance_due)                                                            as unit_balance
  from rr
  join public.rent_roll_line l on l.rent_roll_report_id = rr.rent_roll_report_id
  where l.occupancy_status in ('current', 'notice', 'vacant_rented', 'vacant_unrented')
  group by 1, 2, 3, 4
),
rr_agg as (
  select
    property_id, month, as_of_date,
    count(*)                                          as units,
    sum(is_occupied)                                  as occupied,
    count(*) - sum(is_occupied)                       as vacant,
    sum(unit_market)                                  as market_rent_total,
    sum(unit_market) filter (where is_occupied = 1)   as market_rent_occupied,
    sum(unit_rent)                                    as rent_total,
    sum(unit_balance) filter (where unit_balance > 0) as delinquency
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
-- RECURRING OTHER INTEREST: other debt that is real enough to count.
--
-- Classified by RULE, never by property name:
--   * the line appears with a POSITIVE amount in >= 6 of the last 12 months, and
--   * the property has a loan on file that could explain it - either a loan
--     whose purpose is a KNOWN non-primary kind, or two or more loans.
--
-- "Known" is the load-bearing word. `purpose <> 'primary_mortgage'` is TRUE
-- for a NULL purpose, and NULL means nobody recorded what the loan is - which
-- is not evidence of extra debt. The Beverly is exactly that case: one loan,
-- purpose unrecorded, $7,500 a month of other interest its $171,700 balance
-- cannot explain. It stays OUT and stays visible in other_interest as an open
-- question. Cedar Haven qualifies on a seller_carry note, Heston Pointe on
-- pac_due and pace_equity.
--
-- The positive-amount test also keeps the two CREDIT lines out: Franklin
-- Court and Lions Gate book negative 'Other interest', and a negative can
-- never be additional debt service.
t12_bounds as (
  select max(month) as last_month from public.t12_monthly
),
other_int_month as (
  select g.property_id, g.accounting_basis, g.month, sum(g.amount) as amt
    from reporting.t12_tagged g
   where g.is_other_interest
   group by 1, 2, 3
),
other_int_recent as (
  select o.property_id, o.accounting_basis,
         count(*) filter (where o.amt > 0
                            and o.month > (select last_month from t12_bounds) - interval '12 months') as months_12
    from other_int_month o
   group by 1, 2
),
loans_on_file as (
  select c.property_id,
         count(*)                                                                    as loans,
         count(*) filter (where l.purpose is not null
                            and l.purpose <> 'primary_mortgage')                     as known_non_primary
    from public.loan_collateral c
    join public.loan l on l.id = c.loan_id
   where c.property_id is not null
   group by 1
),
oi_qualifies as (
  select r.property_id, r.accounting_basis
    from other_int_recent r
    join loans_on_file f on f.property_id = r.property_id
   where r.months_12 >= 6
     and (f.known_non_primary > 0 or f.loans >= 2)
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
    -- the qualifying portion, and only ever the positive side of it
    case when oq.property_id is not null and agg.other_interest > 0
         then agg.other_interest end as recurring_other_interest,
    (oq.property_id is not null) as other_interest_is_debt_service,
    agg.loan_proceeds,
    agg.loan_proceeds_note,

    rr_agg.as_of_date as rent_roll_as_of,
    rr_agg.units, rr_agg.occupied, rr_agg.vacant,
    case when rr_agg.units > 0
         then rr_agg.occupied::numeric / rr_agg.units::numeric end as physical_occupancy,
    rr_agg.market_rent_total,
    rr_agg.rent_total,
    -- v2: market rent of the OCCUPIED units against their rent. Vacant units
    -- carry a market rent and no rent, so v1 counted every vacancy as "loss
    -- to lease" too.
    (rr_agg.market_rent_occupied - rr_agg.rent_total) as loss_to_lease,
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
  left join oi_qualifies oq on oq.property_id = m.property_id
                           and oq.accounting_basis = m.accounting_basis
)
-- cash_flow reads debt_service from the CTE rather than restating the CASE.
-- Written inline it was two copies of one rule, and an edit to either leaves
-- a view whose debt service and cash flow disagree while both still run.
select
  r.*,
  (r.noi - coalesce(r.am_fee_booked, 0) - coalesce(r.debt_service, 0)
         - coalesce(r.recurring_other_interest, 0) - coalesce(r.capex, 0)) as cash_flow,
  -- `dscr` keeps its existing meaning - mortgage only - because the saved
  -- Coverage watchlist filters on it and a silent redefinition would change
  -- what that view means without changing a word of its config.
  case when r.debt_service > 0 then r.noi / r.debt_service end as dscr,
  (coalesce(r.debt_service, 0) + coalesce(r.recurring_other_interest, 0)) as debt_service_all,
  case when (coalesce(r.debt_service, 0) + coalesce(r.recurring_other_interest, 0)) > 0
       then r.noi / (coalesce(r.debt_service, 0) + coalesce(r.recurring_other_interest, 0)) end as dscr_all_debt
from resolved r;

-- ===========================================================================
-- reporting.property_month_mv — the monthly spine, materialised.
--
-- property_summary reads property_month FOUR times (trailing twelve, the
-- six-month windows, the latest occupancy, the year bounds), and each read
-- re-evaluates the whole CTE chain over t12_monthly. The result was 1.1s in
-- Postgres and ~2.9s at the browser for a page that is the section's front
-- door, which reads as broken rather than slow.
--
-- The data behind it arrives in BATCH SYNCS - a T12 export, a rent roll
-- import - not continuously, so a materialised copy is not a staleness
-- trade so much as a match to how the data actually changes. Refresh it
-- after a sync: `select reporting.refresh_reporting();`
--
-- The unique index is required for REFRESH ... CONCURRENTLY, which is what
-- lets the refresh run without taking the screen offline. (tenant_id,
-- property_id, month, accounting_basis) is the view's own grain - `months`
-- is a SELECT DISTINCT over exactly those four columns.
-- ===========================================================================
create materialized view reporting.property_month_mv as
  select * from reporting.property_month;

create unique index if not exists property_month_mv_key
  on reporting.property_month_mv (tenant_id, property_id, month, accounting_basis);
create index if not exists property_month_mv_prop
  on reporting.property_month_mv (property_id, month desc);
create index if not exists property_month_mv_tenant
  on reporting.property_month_mv (tenant_id) where has_data;

-- Concurrently where possible, plainly on the first run when the view has
-- never been populated (CONCURRENTLY is rejected against an unpopulated
-- matview, and a refresh that throws on a fresh database is a refresh nobody
-- can run).
create or replace function reporting.refresh_reporting()
returns void language plpgsql security definer set search_path to 'reporting, public' as $fn$
begin
  if exists (select 1 from pg_class where relname = 'property_month_mv' and relispopulated) then
    refresh materialized view concurrently reporting.property_month_mv;
  else
    refresh materialized view reporting.property_month_mv;
  end if;

  -- AFTER the spine, because it is built from it. Refreshing these the other
  -- way round leaves the summary a generation behind for no reason anyone
  -- could see from the screen.
  if exists (select 1 from pg_class where relname = 'property_summary_mv' and relispopulated) then
    refresh materialized view concurrently reporting.property_summary_mv;
  else
    refresh materialized view reporting.property_summary_mv;
  end if;
end $fn$;

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
-- optimised NOI: best 6 consecutive months x 2. Null with fewer than 6.
win6 as (
  select property_id, accounting_basis, month,
         sum(noi) over (partition by property_id, accounting_basis
                        order by month rows between 5 preceding and current row) as noi6,
         count(*) over (partition by property_id, accounting_basis
                        order by month rows between 5 preceding and current row) as n6
    from reporting.property_month_mv
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
  -- TRANSITIONAL: the deployed app still reads the old name. Drop this alias
  -- in the migration that follows the properties-v2 deploy.
  tr12.cash_flow_after_debt_and_capex as t12_net_income,
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

-- ===========================================================================
-- reporting.property_summary_mv — the Properties page's front door.
--
-- 170 rows, read on every load of the section, and the most expensive thing
-- in the schema: four passes over the monthly spine plus the six-month
-- windows. Materialising the monthly spine took it from 1.1s to ~380ms warm
-- and ~1.8s cold, which is still a visible stall on the first open of the
-- day. Materialising the summary itself takes it to a single index scan.
--
-- Refreshed by the same function, AFTER property_month_mv, because it is
-- built from it.
-- ===========================================================================
create materialized view reporting.property_summary_mv as
  select * from reporting.property_summary;

create unique index if not exists property_summary_mv_key
  on reporting.property_summary_mv (id);
create index if not exists property_summary_mv_tenant
  on reporting.property_summary_mv (tenant_id, ownership_status);
create index if not exists property_summary_mv_entity
  on reporting.property_summary_mv (entity_id);

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
    join reporting.property_month_mv pm on pm.property_id = l.property_id
   where lower(pm.accounting_basis) = 'cash' and pm.has_data
   group by 1, 2
),
booked as (
  select l.schedule_id, pm.month, sum(pm.am_fee_booked) as am_fee_booked
    from public.am_fee_schedule_property l
    join reporting.property_month_mv pm on pm.property_id = l.property_id
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

-- ===========================================================================
-- v2  reporting.income_statement_month
-- The income statement as the Monthly financials tab lays it out: one row per
-- DEPTH-1 line of each section, per month. A group appears as its own total
-- line; a line that is not in a group appears as itself. Depth-1 lines never
-- overlap, so they add up:
--
--   net income = income + non_operating_income
--              - operating_expense - non_operating_expense
--
-- Dakota Bend, Oct 2025 to Sep 2026: 580,082.96 - 385,661.61 - 177,280.61
-- = 17,140.74, the acceptance figure.
--
-- other_cash_items is NOT here: it is the balance sheet, and lives in
-- reporting.cash_flow_line below.
-- ===========================================================================
create view reporting.income_statement_month
with (security_invoker = true) as
select
  t.tenant_id,
  t.property_id,
  date_trunc('month', t.month)::date as month,
  t.accounting_basis,
  t.section,
  t.line_label,
  t.is_total                         as is_group,
  t.amount,
  t.sort_order
from public.t12_monthly t
where t.depth = 1
  and t.section in ('income', 'operating_expense', 'non_operating_income', 'non_operating_expense');

-- ===========================================================================
-- v2  reporting.cash_flow_line
-- other_cash_items, classified. Signs are kept as the books store them: a
-- positive is cash arriving (a deposit taken, a draw on a credit line, an
-- owner contribution), a negative is cash leaving.
--
--   cash from operations = net income + operating lines
--   net cash flow        = cash from operations + financing + investing
--
-- The classification is BY LABEL, read off all 51 labels in the live data on
-- 2026-10-12. Anything unrecognised is OPERATING, which is where every
-- unrecognised label in the data turned out to belong (payables, accruals,
-- clearing and cash accounts). Investing exists because three properties book
-- an acquisition here (Building, Land, Furniture & Fixtures); the mockup's
-- statements had no such rows, and the screen hides a section with nothing
-- in it.
-- ===========================================================================
create view reporting.cash_flow_line
with (security_invoker = true) as
select
  t.tenant_id,
  t.property_id,
  date_trunc('month', t.month)::date as month,
  t.accounting_basis,
  t.line_label,
  case
    when t.line_label ~* '(loan|mortgage|line of credit|owner|intercompany|interfund|due to|-snb\M|\msba\M)' then 'financing'
    when t.line_label ~* '^(building|land|land improvements|furniture & fixtures|intangible asset|capital expenditures)$' then 'investing'
    else 'operating'
  end as activity,
  t.amount,
  t.sort_order
from public.t12_monthly t
where t.section = 'other_cash_items'
  and not t.is_total
  and t.depth = 1;

-- ===========================================================================
-- v2  public.capex_category_map + reporting.capex_line
--
-- EDITABLE: the category of a capex account is a judgement, so it lives in a
-- table rather than in code. Each rule is a case-insensitive regular
-- expression on the account label; the LOWEST priority that matches wins, and
-- an account no rule matches is 'Other'.
--
-- The seed reproduces the approved mockup's categories exactly, for all 44
-- properties that have capex (checked line by line on 2026-10-12). Two of
-- its quirks are deliberate, because the mockup is the reference:
--   * 'heat' sits under HVAC, so hot water heaters are HVAC - and so is
--     'Sheathing - Material', which contains the letters h-e-a-t.
--   * trash service, signage, site work, fire safety and equipment rental
--     are Other.
-- Change a rule here and the Capex tab follows on the next load.
-- ===========================================================================
create table if not exists public.capex_category_map (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid references public.tenant(id) on delete cascade,  -- null = every tenant
  pattern     text not null,
  category    text not null,
  priority    integer not null,
  note        text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint capex_category_map_pattern_valid check (length(btrim(pattern)) > 0)
);
create unique index if not exists capex_category_map_rule
  on public.capex_category_map (coalesce(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid), pattern);

alter table public.capex_category_map enable row level security;
drop policy if exists capex_category_map_read on public.capex_category_map;
create policy capex_category_map_read on public.capex_category_map
  for select to authenticated
  using (tenant_id is null or tenant_id in (select current_tenant_ids()));
drop policy if exists capex_category_map_admin_write on public.capex_category_map;
create policy capex_category_map_admin_write on public.capex_category_map
  for all to authenticated
  using (dash_role() in ('owner', 'admin') and (tenant_id is null or tenant_id in (select current_tenant_ids())))
  with check (dash_role() in ('owner', 'admin') and (tenant_id is null or tenant_id in (select current_tenant_ids())));

insert into public.capex_category_map (tenant_id, pattern, category, priority, note) values
  (null, 'hvac|heat',                     'HVAC',                            10, 'hot water heaters are here, as in the mockup'),
  (null, 'applian',                       'Appliances',                      20, null),
  (null, 'floor|carpet|tile|vinyl',       'Flooring',                        30, null),
  (null, 'plumb|water heater',            'Plumbing and water heaters',      40, null),
  (null, 'electric',                      'Electrical',                      50, null),
  (null, 'paint|drywall',                 'Paint and drywall',               60, null),
  (null, 'roof|siding|masonry|landscap|concrete|pavement|sidewalk|earthwork|parking|pool|exterior|deck',
                                          'Roof, exterior and site',         70, null),
  (null, 'door|window|hardware|lock|blind|key|access',
                                          'Doors, windows and hardware',     80, null),
  (null, 'labor|material|remodel|furniture|cabinet|countertop|framing|millwork|insulation|mailbox|fenc|tenant improvement|carpentry',
                                          'Renovation, labor and materials', 90, 'after the trades, so "HVAC - Labor" stays HVAC')
on conflict do nothing;

-- Every capex ACCOUNT line, not the group totals: the leaves under a depth-1
-- 'Capital Improvements' / 'CAPITAL EXPENSES' group, plus the one AppFolio
-- property that books 'Capital Expenditures' in other_cash_items (negated,
-- because an outflow is stored negative there). Sums to property_month.capex.
create view reporting.capex_line
with (security_invoker = true) as
with lines as (
  select t.tenant_id, t.property_id, date_trunc('month', t.month)::date as month,
         t.accounting_basis, t.line_label, t.amount
    from public.t12_monthly t
   where t.section = 'non_operating_expense'
     and not t.is_total
     and t.depth >= 2
     and t.account_path[2] ~* '^(capital improvements|capital expenses)$'
  union all
  select t.tenant_id, t.property_id, date_trunc('month', t.month)::date,
         t.accounting_basis, t.line_label, -t.amount
    from public.t12_monthly t
   where t.section = 'other_cash_items'
     and not t.is_total
     and t.line_label ~* '^capital expenditures$'
)
select
  l.*,
  coalesce((select m.category
              from public.capex_category_map m
             where (m.tenant_id is null or m.tenant_id = l.tenant_id)
               and l.line_label ~* m.pattern
             order by m.priority, m.tenant_id nulls last
             limit 1), 'Other') as category
from lines l;

grant select on public.capex_category_map to authenticated;
grant select on all tables in schema reporting to authenticated;
grant execute on function reporting.refresh_reporting() to authenticated;
select reporting.refresh_reporting();

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
