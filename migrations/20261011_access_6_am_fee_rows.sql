-- ===========================================================================
-- Access unification, part 6: the fee view, read through its owner.
--
-- reporting.am_fee_month is security_invoker (the browser's authenticated
-- role reads it under RLS), so even behind public.rpt_am_fee_month it checks
-- the READER against its sources: public.am_fee_receipt (unclassified) and
-- reporting.property_month_mv (a materialised view, which cannot carry row
-- rules and must not be granted to connector roles). Found by running the
-- dashboard as a connector role: "permission denied for table am_fee_receipt".
--
-- So the rows come from a SECURITY DEFINER function owned by postgres, and the
-- view applies the same row rule it had: a fee month is visible when any
-- property on its schedule is. The fee data is 42 schedules by month, so
-- computing it whole per call costs nothing.
-- ===========================================================================
begin;

create or replace function mcp_rls.am_fee_month_rows()
returns setof reporting.am_fee_month
language sql stable security definer set search_path to 'pg_catalog' as $$
  select * from reporting.am_fee_month
$$;
revoke all on function mcp_rls.am_fee_month_rows() from public, anon, authenticated, service_role;
grant execute on function mcp_rls.am_fee_month_rows() to mcp_user;

do $$
declare expr text;
begin
  expr := replace(mcp.class_expr('rpt_am_fee_month', 'property', '{leavenwealth}', false), '(property_id)', '(l.property_id)');
  execute format('create or replace view public.rpt_am_fee_month with (security_barrier) as select x.* from mcp_rls.am_fee_month_rows() x
                   where current_user = ''postgres''
                      or exists (select 1 from public.am_fee_schedule_property l where l.schedule_id = x.schedule_id and %s)', expr);
end $$;
revoke all on public.rpt_am_fee_month from anon, authenticated, service_role;

select mcp.sync_user_access(id) from mcp.app_user where db_role is not null;
commit;
