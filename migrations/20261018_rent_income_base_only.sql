-- ===========================================================================
-- Rent income is BASE RENT only (Jay, 2026-10-14)
--
-- REVIEW ONLY until Jay approves. migrations/ is not auto-applied.
--
-- rent_income took the whole rent TOTAL line, and some managers book fees
-- under it. Champion Villas' 'Rent - Residential' total carries internet,
-- utility and solar reimbursements, pet rent, garage and service fees
-- ($1.32M rent against $1.17M of market rent for every unit); Dakota Bend's
-- 'RENTS' carries internet and utility reimbursement fees.
--
-- This replaces two views IN PLACE, with every existing column unchanged in
-- name, type and position:
--   reporting.t12_tagged      + is_rent_fee_total, is_rent_fee_tenant (at the end)
--   reporting.property_month  rent_income = rent tier line less those fees
-- Total operating income, NOI, DSCR and every other column are untouched: the
-- fees move from rent to other income, nothing leaves income.
-- Both bodies are copied from 20261014_drop_t12_net_income_alias.sql with
-- only the marked lines changed.
--
-- After applying:  node tools/refresh-reporting.js
-- To reverse: re-run the two view bodies from 20261014 (create or replace
-- cannot drop the two new columns; they are harmless if left), then refresh.
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
     and t.line_label ~* '^mortgage payment( - seller carry)?$')  as is_unsplit_payment,

  -- RENT FEES (Jay, 2026-10-14). Charges the manager books UNDER the rent
  -- total that are not base rent: internet, utility and solar
  -- reimbursements, pet rent, garage, lease-buyout, month-to-month premiums, short-term rental surplus
  -- and other fees. They stay
  -- in total operating income and leave rent_income, which is base rent only
  -- (rent, subsidy/HAP portions, concessions, vacancy, loss to lease). One
  -- flag per rent tier, so a fee is only taken out of the total it sits in.
  -- Added at the END: create or replace view can only append columns.
  (t.section = 'income' and not t.is_total
     and array_to_string(t.account_path, ' > ') ~* '^[^>]+ > (rents|rent income) > '
     and t.line_label ~* '(fee|internet|utilit|reimburse|solar|pet|garage|parking|storage|buyout|deposit|premium|surplus)')
                                                                  as is_rent_fee_total,
  (t.section = 'income' and not t.is_total
     and array_to_string(t.account_path, ' > ') ~* 'INCOME - TENANT > Rent - Residential > '
     and t.line_label ~* '(fee|internet|utilit|reimburse|solar|pet|garage|parking|storage|buyout|deposit|premium|surplus)')
                                                                  as is_rent_fee_tenant
from public.t12_monthly t;

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
    sum(g.amount) filter (where g.is_rent_fee_total)  as rent_fee_total,
    sum(g.amount) filter (where g.is_rent_fee_tenant) as rent_fee_tenant,

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

    -- base rent only: the tier's line less the fees booked under it
    case when agg.rent_total_line  is not null then agg.rent_total_line - coalesce(agg.rent_fee_total, 0)
         when agg.rent_depth1_line is not null then agg.rent_depth1_line
         when agg.rent_tenant_line is not null then agg.rent_tenant_line - coalesce(agg.rent_fee_tenant, 0)
    end as rent_income,
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
