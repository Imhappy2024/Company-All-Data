-- ===========================================================================
-- Access unification, part 3 of 3: one enforcement for both.     NOT APPLIED.
--
-- The dashboard server will run each signed-in person's data queries as
-- their connector role (SET LOCAL ROLE mcp_u_...), so Postgres applies the
-- connector's grants and row rules to the dashboard exactly as it does to
-- Claude. For that to work, everything the dashboard reads has to be reachable
-- through the connector's own mechanism (mcp.table_class + sync_user_access):
--
--   A. postgres (the dashboard's connection) may SET ROLE to each person's
--      role - SET only, never INHERIT, so it gains nothing it did not have.
--      provision_user_role() grants it for every new person.
--   B. The reporting schema's views and materialised views get public "rpt_"
--      views that filter rows with the SAME generated rule the connector puts
--      on the underlying tables (mcp.class_expr), evaluated for current_user.
--      A materialised view cannot carry row-level security, so the filter has
--      to live in a view in front of it. The rpt_ views are classified
--      (financial, LeavenWealth) and lw_user / lw_user_ro may read them.
--   C. Dashboard tables the connector had not classified are classified:
--      fee schedules, capex category map, property groups, saved views.
--   D. The four cash/debt views and three tracker views become
--      security_invoker, so the underlying tables' row rules apply to whoever
--      reads them, and are classified as financial.
--
-- Every new table_class row also becomes visible through Claude for the same
-- people: one model, both ways. sync_user_access is then run for every
-- person who already has a role, so their grants include the new objects.
-- That widens nobody's DATA (the rules are the existing rules); it only lets
-- the dashboard read through the same door.
-- ===========================================================================
begin;

-- A. the dashboard may act as a person, never inherit from them -------------
do $$
declare r record;
begin
  for r in select db_role from mcp.app_user where db_role is not null and exists (select 1 from pg_roles where rolname = db_role) loop
    execute format('grant %I to postgres with inherit false, set true', r.db_role);
  end loop;
end $$;

create or replace function mcp.provision_user_role(p_user uuid, p_password text)
 returns text language plpgsql security definer set search_path to 'pg_catalog' as $function$
declare
  v_role   text := 'mcp_u_' || substr(replace(p_user::text, '-', ''), 1, 12);
  v_active boolean;
begin
  if coalesce(length(p_password), 0) < 32 then
    raise exception 'role password must be at least 32 characters';
  end if;
  select active into v_active from mcp.app_user where id = p_user;
  if not found then raise exception 'no such person: %', p_user; end if;
  if not exists (select 1 from pg_roles where rolname = v_role) then
    execute format('create role %I nologin in role mcp_user', v_role);
  end if;
  execute format('alter role %I password %L', v_role, p_password);
  execute format('alter role %I %s', v_role, case when v_active then 'login' else 'nologin' end);
  execute format('alter role %I set search_path = public', v_role);
  execute format('alter role %I set statement_timeout = %L', v_role, '60s');
  /* the dashboard runs this person's queries as this role */
  execute format('grant %I to postgres with inherit false, set true', v_role);
  update mcp.app_user set db_role = v_role where id = p_user and db_role is distinct from v_role;
  perform mcp.sync_user_access(p_user);
  return v_role;
end;
$function$;

-- B. reporting, through filtered views --------------------------------------
insert into mcp.table_class (table_name, is_financial, companies, scope_mode, class_rule, hidden_columns, admin_write) values
  ('rpt_property_summary',       true, '{leavenwealth}', 'table', 'property', '{}', false),
  ('rpt_property_month',         true, '{leavenwealth}', 'table', 'property', '{}', false),
  ('rpt_rent_roll_unit',         true, '{leavenwealth}', 'table', 'property', '{}', false),
  ('rpt_income_statement_line',  true, '{leavenwealth}', 'table', 'property', '{}', false),
  ('rpt_income_statement_month', true, '{leavenwealth}', 'table', 'property', '{}', false),
  ('rpt_capex_line',             true, '{leavenwealth}', 'table', 'property', '{}', false),
  ('rpt_cash_flow_line',         true, '{leavenwealth}', 'table', 'property', '{}', false),
  ('rpt_loan',                   true, '{leavenwealth}', 'table', 'loan',     '{}', false),
  ('rpt_am_fee_month',           true, '{leavenwealth}', 'table', 'property', '{}', false);

do $$
declare
  v record; expr text;
begin
  for v in select * from (values
      ('rpt_property_summary',       'reporting.property_summary_mv',   'property', 'id'),
      ('rpt_property_month',         'reporting.property_month_mv',     'property', 'property_id'),
      ('rpt_rent_roll_unit',         'reporting.rent_roll_unit',        'property', 'property_id'),
      ('rpt_income_statement_line',  'reporting.income_statement_line', 'property', 'property_id'),
      ('rpt_income_statement_month', 'reporting.income_statement_month','property', 'property_id'),
      ('rpt_capex_line',             'reporting.capex_line',            'property', 'property_id'),
      ('rpt_cash_flow_line',         'reporting.cash_flow_line',        'property', 'property_id'),
      ('rpt_loan',                   'reporting.loan',                  'loan',     'loan_id')
    ) t(name, src, rule, keycol)
  loop
    expr := mcp.class_expr(v.name, v.rule, '{leavenwealth}', false);
    /* the generated rule names property_id / loan_id; point it at x.<key> */
    expr := replace(replace(expr, '(property_id)', '(x.' || v.keycol || ')'), '(loan_id)', '(x.' || v.keycol || ')');
    /* postgres (the dashboard's own connection, for admin screens and jobs)
       already reads every table; every connector role gets the rule */
    execute format('create view public.%I with (security_barrier) as select x.* from %s x where current_user = ''postgres'' or %s', v.name, v.src, expr);
    execute format('comment on view public.%I is %L', v.name,
      'Rows of ' || v.src || ' that the reader''s connector role may see (mcp.class_expr rule ' || v.rule || '). Read by the dashboard as the signed-in person.');
  end loop;

  /* a fee month belongs to a schedule that can cover several properties: it
     is visible when any of them is */
  expr := mcp.class_expr('rpt_am_fee_month', 'property', '{leavenwealth}', false);
  expr := replace(expr, '(property_id)', '(l.property_id)');
  execute format('create view public.rpt_am_fee_month with (security_barrier) as select x.* from reporting.am_fee_month x
                   where current_user = ''postgres''
                      or exists (select 1 from public.am_fee_schedule_property l where l.schedule_id = x.schedule_id and %s)', expr);
end $$;

-- C. dashboard tables the connector had not classified ----------------------
insert into mcp.table_class (table_name, is_financial, companies, scope_mode, class_rule, hidden_columns, admin_write) values
  ('am_fee_schedule',          true,  '{leavenwealth}', 'table', 'fixed_property', '{}', false),
  ('am_fee_schedule_property', true,  '{leavenwealth}', 'table', 'property',       '{}', false),
  ('capex_category_map',       false, '{leavenwealth}', 'table', 'fixed_property', '{}', true),
  ('property_group',           false, '{leavenwealth}', 'table', null,             '{}', false),
  ('property_group_member',    false, '{leavenwealth}', 'table', 'property',       '{}', false),
  ('saved_view',               false, '{leavenwealth}', 'table', null,             '{}', false),
  ('saved_view_share',         false, '{leavenwealth}', 'table', null,             '{}', false);
select mcp.apply_table_policies(t) from unnest(array['am_fee_schedule', 'am_fee_schedule_property', 'capex_category_map',
  'property_group', 'property_group_member', 'saved_view', 'saved_view_share']) t;

-- D. cash/debt and tracker views read through the caller's row rules --------
alter view public.v_cash_by_entity_quarter  set (security_invoker = true);
alter view public.v_debt_by_account_quarter set (security_invoker = true);
alter view public.v_debt_by_quarter         set (security_invoker = true);
alter view public.v_cash_debt_summary       set (security_invoker = true);
alter view public.v_tracker_counts          set (security_invoker = true);
alter view public.v_tracker_megan           set (security_invoker = true);
alter view public.v_tracker_mitch           set (security_invoker = true);
insert into mcp.table_class (table_name, is_financial, companies, scope_mode, class_rule, hidden_columns, admin_write) values
  ('v_cash_by_entity_quarter',  true,  '{leavenwealth}', 'table', null, '{}', false),
  ('v_debt_by_account_quarter', true,  '{leavenwealth}', 'table', null, '{}', false),
  ('v_debt_by_quarter',         true,  '{leavenwealth}', 'table', null, '{}', false),
  ('v_cash_debt_summary',       true,  '{leavenwealth}', 'table', null, '{}', false),
  ('v_tracker_counts',          false, '{leavenwealth}', 'table', null, '{}', false),
  ('v_tracker_megan',           false, '{leavenwealth}', 'table', null, '{}', false),
  ('v_tracker_mitch',           false, '{leavenwealth}', 'table', null, '{}', false);

-- the LeavenWealth staff levels: what each may read (w = write) -------------
insert into mcp.lw_level_table (level, table_name, can_write)
select l.level, t.name, l.level = 'lw_user' and t.w
  from (values ('lw_user'), ('lw_user_ro')) l(level),
       (values ('rpt_property_summary', false), ('rpt_property_month', false), ('rpt_rent_roll_unit', false),
               ('rpt_income_statement_line', false), ('rpt_income_statement_month', false), ('rpt_capex_line', false),
               ('rpt_cash_flow_line', false), ('rpt_loan', false), ('rpt_am_fee_month', false),
               ('am_fee_schedule', false), ('am_fee_schedule_property', false), ('capex_category_map', false),
               ('property_group', true), ('property_group_member', true), ('saved_view', true), ('saved_view_share', true),
               ('v_tracker_counts', false), ('v_tracker_megan', false), ('v_tracker_mitch', false)) t(name, w);
insert into mcp.lw_level_table (level, table_name, can_write) values ('lw_viewer', 'rpt_property_summary', false);

-- re-grant everyone who has a role, so the new objects are included ---------
select mcp.sync_user_access(id) from mcp.app_user where db_role is not null;

commit;
