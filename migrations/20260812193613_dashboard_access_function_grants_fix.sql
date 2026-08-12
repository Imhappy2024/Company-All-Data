-- Correction. `revoke ... from public` is NOT enough on Supabase.
--
-- ALTER DEFAULT PRIVILEGES in this project grants EXECUTE on every new function in
-- `public` to anon, authenticated and service_role EXPLICITLY (see pg_default_acl,
-- defaclobjtype 'f'). Revoking from PUBLIC removes only the implicit grant and
-- leaves the explicit ones in place, so the function stays callable at
-- /rest/v1/rpc/<name> without signing in. Revoke from `anon` by name.
--
-- ROLLBACK: grant execute on each function below to anon, authenticated.

-- Trigger-only functions: never called directly by anyone. A direct call raises
-- "can only be called as a trigger", and trigger execution does not consult
-- EXECUTE, so revoking costs nothing.
revoke execute on function public.dashboard_permission_guard() from public, anon, authenticated;
revoke execute on function public.staff_dashboard_guard()      from public, anon, authenticated;

-- Takes an arbitrary staff id, so a signed-in user could probe someone else's
-- level. dash_level() is the entry point; being SECURITY DEFINER, its inner call
-- runs as the owner and does not need the caller to hold EXECUTE.
revoke execute on function public.dash_level_for(uuid, uuid, text) from public, anon, authenticated;

-- Callable only when signed in.
revoke execute on function public.current_staff_id()          from public, anon;
revoke execute on function public.dash_role()                 from public, anon;
revoke execute on function public.dash_rank(text)             from public, anon;
revoke execute on function public.dash_level(uuid, text)      from public, anon;
revoke execute on function public.dash_my_access()            from public, anon;
revoke execute on function public.current_tenant_ids()        from public, anon;
revoke execute on function public.tenant_role(uuid)           from public, anon;
revoke execute on function public.current_company_ids()       from public, anon;
revoke execute on function public.company_role(uuid)          from public, anon;

-- RLS policy expressions run as the querying role, so authenticated must keep
-- EXECUTE on anything a policy calls.
grant execute on function public.current_staff_id()      to authenticated;
grant execute on function public.dash_role()             to authenticated;
grant execute on function public.dash_rank(text)         to authenticated;
grant execute on function public.dash_level(uuid, text)  to authenticated;
grant execute on function public.dash_my_access()        to authenticated;
grant execute on function public.current_tenant_ids()    to authenticated;
grant execute on function public.tenant_role(uuid)       to authenticated;
grant execute on function public.current_company_ids()   to authenticated;
grant execute on function public.company_role(uuid)      to authenticated;
