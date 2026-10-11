-- ===========================================================================
-- Access unification, part 5: the rpt_ views are for connector roles only.
--
-- Supabase's default privileges gave anon, authenticated and service_role
-- every privilege on the nine rpt_ views part 3 created. Their filter already
-- returns no rows to those roles (no connector account has them as db_role),
-- but nothing should be grantable that is never meant to be used, and the
-- browser's REST API must not even see them. Connector roles keep the SELECT
-- that mcp.sync_user_access gives them; postgres owns them.
-- ===========================================================================
begin;
do $$
declare v text;
begin
  for v in select viewname from pg_views where schemaname = 'public' and viewname like 'rpt\_%' loop
    execute format('revoke all on public.%I from anon, authenticated, service_role', v);
  end loop;
end $$;
commit;
