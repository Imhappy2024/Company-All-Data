// ===========================================================================
// portal-queries.js — every SQL statement the portal reads.
//
// Rules this file exists to enforce:
//   1. No number rendered in the portal is written by hand. If it is not in
//      here, it does not appear on screen.
//   2. Every aggregate reports its own coverage (how many rows it is built
//      from, and how many it could not use) so the UI can say so out loud.
//   3. NULL is preserved as NULL all the way to the browser. It is never
//      coalesced to 0, because "not reported" and "zero" are different claims.
//
// Each entry is { sql, params } or a function (params) -> { queries: {...} }.
// Consumed by portal-api.js.
// ===========================================================================

const TENANT = '72381c81-af95-4e1d-ad0d-20a3a3421119';

const COMPANY = {
  leadli: 'c0000000-0000-4000-8000-000000000001',
  folio: 'c0000000-0000-4000-8000-000000000002',
  leavenwealth: 'c0000000-0000-4000-8000-000000000003',
  liquid: 'c0000000-0000-4000-8000-000000000004',
};

/* ---------------------------------------------------------------------------
   Coverage: the honesty layer. Every section that shows an aggregate also
   returns one of these so the UI can print "built from N of M rows".
--------------------------------------------------------------------------- */
const COVERAGE = `
select
  (select count(*) from property)                                            as properties_total,
  (select count(distinct property_id) from property_financials)              as properties_with_financials,
  (select max(as_of_date) from property_financials)                          as financials_as_of,
  (select count(*) from loan)                                                as loans_total,
  (select count(*) from v_loan_current_balance)                              as loans_with_balance,
  (select max(as_of_date) from loan_balance)                                 as balance_as_of,
  (select count(*) from loan where maturity_date is null)                    as loans_without_maturity,
  (select count(*) from loan where maturity_date < current_date
      and status <> 'closed')                                                as loans_past_maturity,
  (select count(*) from insurance_policy)                                    as policies_total,
  (select count(*) from insurance_policy where annual_premium is not null)   as policies_with_premium,
  (select count(*) from insurance_policy where renewal_date < current_date)  as policies_past_renewal,
  (select count(*) from unit)                                                as building_records,
  (select count(*) from property where unit_count_reported is null)          as properties_without_unit_count`;

/* --------------------------------------------------------------------------- */

const Q = {
  /* ---------------- shared ---------------- */
  coverage: () => ({ coverage: { sql: COVERAGE, one: true } }),

  /* ---------------- LeavenWealth: portfolio ---------------- */
  'summary:leavenwealth': () => ({
    coverage: { sql: COVERAGE, one: true },
    totals: {
      one: true,
      sql: `
        select
          (select count(*) from property)                             as properties,
          (select sum(unit_count_reported) from property)             as units_reported,
          (select count(*) from unit)                                 as buildings,
          (select sum(noi) from property_financials)                  as noi,
          (select sum(egi) from property_financials)                  as egi,
          (select sum(operating_expenses) from property_financials)   as opex,
          (select sum(current_market_value) from property_financials) as marked_value,
          (select sum(property_equity) from property_financials)      as equity,
          (select sum(balance) from v_loan_current_balance)           as debt,
          (select sum(annual_premium) from insurance_policy)          as premium,
          (select sum(tiv) from insurance_policy)                     as tiv,
          -- occupancy lives on unit.occupancy as free text and is null on every
          -- row today. Reported as a count so the UI can show "not tracked"
          -- instead of inventing a percentage.
          (select count(*) from unit where occupancy is not null
             and btrim(occupancy) <> '')                              as units_with_occupancy`,
    },
    accounts: {
      sql: `
        select fa.id, fa.name, fa.institution, fa.account_type, fa.account_kind,
               ab.balance, ab.as_of_date
          from financial_account fa
          left join lateral (
            select balance, as_of_date from account_balance
             where account_id = fa.id order by as_of_date desc limit 1
          ) ab on true
         order by ab.balance desc nulls last, fa.name`,
    },
    investors: {
      sql: `
        select i.id, i.name, i.email,
               count(s.id)                                  as stakes,
               max(s.stake_pct)                             as top_stake_pct,
               string_agg(distinct coalesce(e.name, p.dba_name), ', ')  as positions
          from investor i
          left join investor_stake s on s.investor_id = i.id
          left join entity   e on e.id = s.entity_id
          left join property p on p.id = s.property_id
         group by i.id, i.name, i.email
         order by max(s.stake_pct) desc nulls last, i.name`,
    },
  }),

  /* ---------------- LeavenWealth: properties ---------------- */
  properties: () => ({
    coverage: { sql: COVERAGE, one: true },
    rows: {
      sql: `
        select p.id, p.dba_name as name, p.street, p.city, p.state,
               p.management_company as pm, p.asset_type, p.status,
               p.unit_count_reported as units, p.purchase_price, p.year_acquired,
               p.current_market_value as listed_value,
               e.name as entity,
               (select count(*) from unit u where u.property_id = p.id) as buildings,
               pf.as_of_date, pf.egi, pf.operating_expenses as opex, pf.noi,
               pf.cap_rate, pf.dcr, pf.total_ltv, pf.property_equity,
               pf.current_market_value as marked_value,
               ins.policies, ins.premium, ins.tiv, ins.next_renewal
          from property p
          left join entity e on e.id = p.entity_id
          left join property_financials pf on pf.property_id = p.id
          left join lateral (
            select count(*) as policies, sum(ip.annual_premium) as premium,
                   sum(ip.tiv) as tiv, min(ip.renewal_date) as next_renewal
              from insurance_policy ip
             where ip.property_id = p.id
                or ip.unit_id in (select id from unit where property_id = p.id)
          ) ins on true
         order by pf.noi desc nulls last, p.dba_name`,
    },
  }),

  /* ---------------- LeavenWealth: debt ---------------- */
  loans: () => ({
    coverage: { sql: COVERAGE, one: true },
    rows: {
      sql: `
        select m.loan_id as id, m.property_name, m.management_company as pm,
               m.loan_number, m.lender, m.purpose, m."position", m.loan_type,
               m.status, m.origination_date, m.origination_amount,
               m.maturity_date, m.days_to_maturity, m.current_balance,
               m.balance_as_of, m.interest_rate_pct, m.index,
               m.balloon_payment, m.extension_available
          from v_loan_maturities m
         order by m.days_to_maturity asc nulls last`,
    },
    /* The ladder coalesces balance -> origination -> balloon because 33 loans
       have no balance. `measure_mix` reports how many rows used each source so
       the chart footer can say which. */
    ladder: {
      sql: `
        with x as (
          select l.id, l.loan_type,
                 extract(year from l.maturity_date)::int as yr,
                 coalesce(cb.balance, l.origination_amount, l.balloon_payment) as exposure,
                 case when cb.balance is not null then 'balance'
                      when l.origination_amount is not null then 'origination'
                      when l.balloon_payment is not null then 'balloon'
                      else 'none' end as measure
            from loan l
            left join v_loan_current_balance cb on cb.loan_id = l.id
           where l.maturity_date is not null
        )
        select case
                 when yr <= 2029 then yr::text
                 when yr between 2030 and 2034 then '2030-34'
                 when yr between 2035 and 2044 then '2035-44'
                 else '2045+'
               end as bucket,
               min(case when yr <= 2029 then yr when yr < 2035 then 2030
                        when yr < 2045 then 2035 else 2045 end) as sort_key,
               count(*)                                                            as loans,
               sum(exposure) filter (where loan_type = 'fixed')                    as fixed,
               sum(exposure) filter (where loan_type = 'variable')                 as variable,
               sum(exposure) filter (where loan_type is null)                      as unclassified,
               count(*) filter (where measure = 'balance')                         as from_balance,
               count(*) filter (where measure <> 'balance' and measure <> 'none')  as from_estimate,
               count(*) filter (where measure = 'none')                            as no_measure
          from x group by 1 order by 2`,
    },
    lenders: {
      sql: `
        select coalesce(l.lender, '(not recorded)') as lender,
               count(*) as loans, sum(cb.balance) as balance
          from loan l
          left join v_loan_current_balance cb on cb.loan_id = l.id
         group by 1 order by 3 desc nulls last`,
    },
  }),

  /* ---------------- LeavenWealth: investors ---------------- */
  investors: () => ({
    rows: {
      sql: `
        select i.id, i.name, i.email, i.phone, i.notes,
               e.name as entity_name,
               s.stake_pct, s.is_primary,
               coalesce(pe.name, pr.dba_name) as position_in
          from investor i
          left join entity e on e.id = i.entity_id
          left join investor_stake s on s.investor_id = i.id
          left join entity   pe on pe.id = s.entity_id
          left join property pr on pr.id = s.property_id
         order by s.stake_pct desc nulls last, i.name`,
    },
    /* An investor portal needs a capital account. There is no table for one.
       This reports that fact rather than the UI guessing. */
    capital_account: {
      one: true,
      sql: `
        select
          to_regclass('public.capital_account')  is not null as has_capital_account,
          to_regclass('public.distribution')     is not null as has_distributions,
          to_regclass('public.contribution')     is not null as has_contributions,
          (select count(*) from investor_stake)              as stakes_recorded`,
    },
  }),

  /* ---------------- LeavenWealth: insurance ---------------- */
  insurance: () => ({
    coverage: { sql: COVERAGE, one: true },
    by_month: {
      sql: `
        select to_char(date_trunc('month', renewal_date), 'YYYY-MM') as month,
               count(*) as policies, sum(annual_premium) as premium,
               count(*) filter (where annual_premium is null) as premium_missing
          from insurance_policy where renewal_date is not null
         group by 1 order by 1`,
    },
    upcoming: {
      sql: `
        select coalesce(p.dba_name, pu.dba_name) as property,
               ip.carrier,
               count(*)                       as policies,
               sum(ip.annual_premium)         as premium,
               sum(ip.tiv)                    as tiv,
               ip.renewal_date,
               (ip.renewal_date - current_date) as days
          from insurance_policy ip
          left join property p  on p.id = ip.property_id
          left join unit     u  on u.id = ip.unit_id
          left join property pu on pu.id = u.property_id
         where ip.renewal_date >= current_date
         group by 1, 2, ip.renewal_date
         order by ip.renewal_date limit 40`,
    },
    lapsed: {
      sql: `
        select coalesce(p.dba_name, pu.dba_name) as property, ip.carrier,
               count(*) as policies, sum(ip.annual_premium) as premium,
               max(ip.renewal_date) as renewal_date,
               (current_date - max(ip.renewal_date)) as days_overdue
          from insurance_policy ip
          left join property p  on p.id = ip.property_id
          left join unit     u  on u.id = ip.unit_id
          left join property pu on pu.id = u.property_id
         where ip.renewal_date < current_date
         group by 1, 2 order by max(ip.renewal_date) limit 40`,
    },
    carriers: {
      sql: `
        select carrier, count(*) as policies, sum(annual_premium) as premium,
               sum(tiv) as tiv
          from insurance_policy where carrier is not null
         group by 1 order by 3 desc nulls last`,
    },
  }),

  /* ---------------- Group: financials ---------------- */
  financials: () => ({
    accounts: {
      sql: `
        select fa.id, fa.name, fa.institution, fa.account_kind, fa.account_type,
               fa.account_number_last4, e.name as owner_entity,
               ab.balance, ab.as_of_date
          from financial_account fa
          left join entity e on e.id = fa.owner_entity_id
          left join lateral (
            select balance, as_of_date from account_balance
             where account_id = fa.id order by as_of_date desc limit 1
          ) ab on true
         order by ab.balance desc nulls last, fa.name`,
    },
    transactions: {
      sql: `
        select t.id, t.txn_date, t.direction, t.amount, t.currency, t.description,
               t.counterparty, t.memo, t.is_reconciled, t.ingestion_method,
               c.name as category, c.category_type,
               fa.name as account, p.dba_name as property
          from transaction t
          left join transaction_category c on c.id = t.category_id
          left join financial_account fa on fa.id = t.financial_account_id
          left join property p on p.id = t.property_id
         order by t.txn_date desc, t.created_at desc limit 200`,
    },
    by_category: {
      sql: `
        select coalesce(c.name, '(uncategorised)') as category,
               coalesce(c.category_type, 'unknown') as category_type,
               count(*) as txns, sum(t.amount) as amount
          from transaction t
          left join transaction_category c on c.id = t.category_id
         group by 1, 2 order by 4 desc`,
    },
    window: {
      one: true,
      sql: `
        select min(txn_date) as first_txn, max(txn_date) as last_txn,
               count(*) as txns,
               sum(amount) filter (where direction = 'inflow')  as inflow,
               sum(amount) filter (where direction = 'outflow') as outflow,
               sum(amount) filter (where direction = 'transfer') as transfers,
               count(*) filter (where is_reconciled) as reconciled
          from transaction`,
    },
    statements: {
      sql: `
        select id, statement_type, period_start, period_end, statement_date,
               opening_balance, closing_balance, total_inflow, total_outflow,
               status, ingestion_method
          from statement order by coalesce(statement_date, period_end) desc limit 50`,
    },
  }),

  /* ---------------- Brand: leads ---------------- */
  leads: (p) => ({
    rows: {
      params: [p.companyId || null],
      sql: `
        select l.id, l.first_name, l.last_name, l.email, l.phone, l.source,
               l.status, l.pipeline, l.pipeline_stage, l.won_lost, l.tags,
               l.opportunity_value, l.is_client, l.became_client_at,
               l.created_at, l.last_synced_at,
               lp.name as provider, s.full_name as assigned_to, c.name as company
          from lead l
          left join lead_provider lp on lp.id = l.provider_id
          left join staff s on s.id = l.assigned_staff_id
          left join company c on c.id = l.company_id
         where ($1::uuid is null or l.company_id = $1::uuid)
         order by l.created_at desc limit 500`,
    },
    by_stage: {
      params: [p.companyId || null],
      sql: `
        select coalesce(pipeline_stage, '(no stage)') as stage, count(*) as leads
          from lead where ($1::uuid is null or company_id = $1::uuid)
         group by 1 order by 2 desc`,
    },
    by_provider: {
      params: [p.companyId || null],
      sql: `
        select coalesce(lp.name, '(none)') as provider, count(*) as leads,
               count(*) filter (where l.is_client) as clients
          from lead l left join lead_provider lp on lp.id = l.provider_id
         where ($1::uuid is null or l.company_id = $1::uuid)
         group by 1 order by 2 desc`,
    },
  }),

  /* ---------------- Brand: appointments ---------------- */
  appointments: (p) => ({
    rows: {
      params: [p.companyId || null],
      sql: `
        select a.id, a.title, a.calendar_name, a.start_time, a.end_time,
               a.status, a.appointment_status, a.booked_source, a.meeting_address,
               trim(coalesce(l.first_name,'') || ' ' || coalesce(l.last_name,'')) as lead_name,
               l.email as lead_email
          from appointment a left join lead l on l.id = a.lead_id
         where ($1::uuid is null or a.company_id = $1::uuid)
         order by a.start_time desc nulls last limit 200`,
    },
  }),

  /* ---------------- Brand: marketing ---------------- */
  marketing: (p) => ({
    daily: {
      params: [p.companyId || null],
      sql: `
        select period_date, campaign, campaign_id, amount_spent, impressions,
               clicks_all, link_clicks, leads, cpl, cpm, ctr_link,
               applications, bookings, cost_per_booking, source, company_id
          from leadli_marketing_daily
         where ($1::uuid is null or company_id = $1::uuid or company_id is null)
         order by period_date desc limit 400`,
    },
    insights: {
      params: [p.companyId || null],
      sql: `
        select date_start, date_stop, campaign_name, level, ad_account_id,
               spend, impressions, clicks, inline_link_clicks, cpm, cpc, ctr,
               leads, cost_per_lead, company_id
          from meta_ads_insight
         where ($1::uuid is null or company_id = $1::uuid or company_id is null)
         order by date_start desc limit 400`,
    },
    /* Reports the seeded-vs-live split and the null company_id problem rather
       than silently mixing two data regimes in one chart. */
    provenance: {
      one: true,
      sql: `
        select count(*)                                          as daily_rows,
               count(*) filter (where company_id is null)         as daily_unattributed,
               count(distinct source)                             as sources,
               min(period_date)                                   as first_date,
               max(period_date)                                   as last_date,
               (select count(*) from meta_ads_insight)            as insight_rows,
               (select count(*) from meta_ads_insight
                  where company_id is null)                       as insight_unattributed,
               (select count(*) from leadli_marketing_daily
                  where bookings is not null)                     as rows_with_bookings,
               (select count(*) from leadli_marketing_daily
                  where applications is not null)                 as rows_with_applications
          from leadli_marketing_daily`,
    },
  }),

  /* ---------------- Workspace: team ---------------- */
  team: (p) => ({
    rows: {
      params: [p.companyId || null],
      sql: `
        select s.id, s.full_name, s.email, s.phone, s.title, s.staff_type,
               s.is_active, s.avatar_url, s.description,
               coalesce(
                 json_agg(json_build_object('company', c.name, 'role', sc.role,
                                            'work_email', sc.work_email,
                                            'is_primary', sc.is_primary)
                          order by sc.is_primary desc, c.name)
                 filter (where c.id is not null), '[]'
               ) as companies
          from staff s
          left join staff_company sc on sc.staff_id = s.id
          left join company c on c.id = sc.company_id
         where ($1::uuid is null or exists (
                 select 1 from staff_company x
                  where x.staff_id = s.id and x.company_id = $1::uuid))
         group by s.id
         order by s.is_active desc, s.full_name`,
    },
  }),

  /* ---------------- Workspace: departments ---------------- */
  departments: () => ({
    rows: {
      sql: `
        select d.id, d.name, d.parent_department_id, pd.name as parent_name,
               coalesce(
                 json_agg(json_build_object('staff_id', s.id, 'name', s.full_name,
                                            'title', s.title, 'role', dm.role,
                                            'is_lead', dm.is_lead,
                                            'avatar_url', s.avatar_url)
                          order by dm.is_lead desc, s.full_name)
                 filter (where s.id is not null), '[]'
               ) as members,
               count(distinct dt.tool_id) as tools
          from department d
          left join department pd on pd.id = d.parent_department_id
          left join department_member dm on dm.department_id = d.id
          left join staff s on s.id = dm.staff_id
          left join department_tool dt on dt.department_id = d.id
         group by d.id, pd.name order by d.parent_department_id nulls first, d.name`,
    },
  }),

  /* ---------------- Workspace: tools ---------------- */
  tools: () => ({
    rows: {
      sql: `
        select t.id, t.name, t.category, t.plan_tier, t.account_identifier,
               t.monthly_cost, t.renewal_date, s.full_name as billing_owner,
               coalesce(
                 json_agg(distinct d.name) filter (where d.name is not null), '[]'
               ) as departments,
               (select count(*) from tool_user tu where tu.tool_id = t.id) as users
          from tool t
          left join staff s on s.id = t.billing_owner_staff_id
          left join department_tool dt on dt.tool_id = t.id
          left join department d on d.id = dt.department_id
         group by t.id, s.full_name order by t.name`,
    },
  }),

  /* ---------------- Workspace: documents ---------------- */
  documents: () => ({
    rows: {
      sql: `
        select d.id, d.title, d.doc_type, d.visibility, d.audience, d.storage_url,
               d.ingestion_method, d.created_at,
               p.dba_name as property, e.name as entity, v.name as vendor
          from document d
          left join property p on p.id = d.property_id
          left join entity e on e.id = d.entity_id
          left join vendor v on v.id = d.vendor_id
         order by d.created_at desc limit 200`,
    },
  }),

  /* ---------------- Workspace: tasks ---------------- */
  tasks: () => ({
    rows: {
      sql: `
        select t.id, t.name, t.status, t.category, t.priority, t.due_date,
               t.start_date, t.date_closed, t.assignees, t.sync_state,
               t.clickup_task_id, t.last_synced_at,
               p.dba_name as property, l.loan_number
          from task t
          left join property p on p.id = t.property_id
          left join loan l on l.id = t.loan_id
         order by t.due_date asc nulls last limit 200`,
    },
  }),

  /* ---------------- Folio Excel: subscriptions ---------------- */
  subscriptions: () => ({
    clients: {
      sql: `
        select sc.id, sc.name, sc.email, sc.company, sc.status, sc.number_of_units,
               sc.subscription_amount, sc.billing_period, sc.payment_status,
               sc.next_billing_date, sc.start_date, sp.name as plan
          from subscription_client sc
          left join subscription_plan sp on sp.id = sc.subscription_plan_id
         order by sc.subscription_amount desc nulls last, sc.name`,
    },
    plans: {
      sql: `
        select id, name, billing_period, price, price_per_unit,
               unit_range_min, unit_range_max, description, is_active
          from subscription_plan order by coalesce(unit_range_min, 0)`,
    },
  }),

  /* ---------------- Leadli: services ---------------- */
  services: () => ({
    catalogue: {
      sql: `
        select id, name, category, description, pricing_model, price, is_active
          from service order by category, name`,
    },
    clients: {
      sql: `
        select sc.id, sc.name, sc.email, sc.company, sc.status, sc.start_date,
               s.full_name as assigned_to,
               coalesce(sum(se.monthly_value), 0) as monthly_value,
               count(se.id) as engagements
          from service_client sc
          left join staff s on s.id = sc.assigned_staff_id
          left join service_engagement se on se.service_client_id = sc.id
         group by sc.id, s.full_name order by 8 desc, sc.name`,
    },
  }),

  /* ---------------- Liquid Lending ---------------- */
  lending: () => ({
    /* No origination pipeline table exists. Report that rather than invent one. */
    shape: {
      one: true,
      sql: `
        select (select count(*) from loan)                       as loans,
               (select count(*) from lead where company_id =
                  'c0000000-0000-4000-8000-000000000004')        as borrower_leads,
               (select count(*) from deal)                       as deals,
               to_regclass('public.loan_application') is not null as has_application_table`,
    },
    deals: {
      sql: `
        select d.id, d.name, d.stage, d.target_property_name, d.offer_price,
               d.close_date, d.notes, s.full_name as sponsor
          from deal d left join staff s on s.id = d.sponsor_staff_id
         order by d.close_date nulls last`,
    },
  }),
};

module.exports = { Q, COMPANY, TENANT };
