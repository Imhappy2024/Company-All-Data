-- ===========================================================================
-- 20260813_harden_trigger_function_grants.sql
--
-- Advisor cleanup, same class as the app_sync_auth_email() revoke in 8f-1. No
-- behaviour change whatsoever.
--
-- Two findings, both structural rather than exploitable:
--
--   1. anon_security_definer_function_executable x8. Every function is
--      EXECUTE-to-PUBLIC by default and anon inherits PUBLIC, so these eight
--      trigger functions are reachable at /rest/v1/rpc/<name> by an anonymous
--      caller. A direct call raises "can only be called as a trigger" (or, for an
--      event trigger, cannot be invoked meaningfully at all), so nothing is
--      exploitable - but the warnings hide real ones, and trigger execution does
--      NOT consult EXECUTE, so revoking costs precisely nothing.
--
--   2. function_search_path_mutable x2. set_updated_at() and
--      lead_sync_client_flag() run with a caller-controlled search_path.
--
-- Checked before writing, because pinning search_path breaks anything relying on
-- an unqualified reference resolved elsewhere:
--   set_updated_at()        body is `new.updated_at = now()` - pg_catalog only.
--   lead_sync_client_flag() body uses ilike / now() / coalesce - pg_catalog only.
-- Neither touches a table or a type, so both pins are inert. Neither is SECURITY
-- DEFINER, which is why they appear only under the search_path lint.
--
-- BLAST RADIUS: set_updated_at() backs 41 row triggers across the schema. The pin
-- is safe for the reason above, but that is the one to re-verify after applying,
-- and the verification below does exactly that.
--
-- NOT touched, deliberately:
--   current_app_user_id(), app_level_rank() - agreed to stay PUBLIC. No arguments
--     and null without a session; and a pure text-to-int mapper. Neither leaks.
--   current_tenant_ids(), tenant_role(), current_company_ids(), company_role() -
--     these are Phase 12's, where they are rewritten anyway. They need
--     `authenticated` to keep EXECUTE because the 214 RLS policies call them
--     directly, so they want `revoke from public` + `grant to authenticated`,
--     not the blanket revoke used here.
--   current_app_role() - same family as the four above; leave it with them.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. Trigger-only functions: reachable by nobody but postgres / service_role.
--    All zero-argument; signatures confirmed against pg_proc before writing.
-- ---------------------------------------------------------------------------
revoke execute on function public.app_permission_guard()               from public, anon, authenticated;
revoke execute on function public.app_user_guard()                     from public, anon, authenticated;
revoke execute on function public.handle_new_user()                    from public, anon, authenticated;
revoke execute on function public.set_appointment_lead_id()            from public, anon, authenticated;
revoke execute on function public.inherit_tenant_from_loan()           from public, anon, authenticated;
revoke execute on function public.inherit_tenant_from_property()       from public, anon, authenticated;
revoke execute on function public.inherit_tenant_from_service_client() from public, anon, authenticated;

-- rls_auto_enable() returns event_trigger, not trigger. Event triggers fire on DDL
-- as the event-trigger owner and never consult EXECUTE either, so this is the same
-- free revoke - it is listed separately only because its return type differs.
revoke execute on function public.rls_auto_enable()                    from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. Pin the two mutable search_paths.
-- ---------------------------------------------------------------------------
alter function public.set_updated_at()        set search_path to 'public';
alter function public.lead_sync_client_flag() set search_path to 'public';

-- ===========================================================================
-- VERIFICATION (run after applying)
--
--   -- should drop from 14 to 6: company_role, current_app_role,
--   -- current_app_user_id, current_company_ids, current_tenant_ids, tenant_role
--   select count(*), string_agg(proname, ', ' order by proname)
--     from pg_proc p join pg_namespace n on n.oid=p.pronamespace
--    where n.nspname='public' and p.prosecdef
--      and has_function_privilege('anon', p.oid, 'execute');
--
--   -- set_updated_at must still fire on the 41 tables that use it
--   begin;
--     update public.app_user set full_name = full_name || ' x'
--      where email = 'chris@leavenwealth.com';
--     select updated_at from public.app_user where email = 'chris@leavenwealth.com';
--   rollback;
--
-- ROLLBACK
--   grant execute on function public.app_permission_guard()               to public;
--   grant execute on function public.app_user_guard()                     to public;
--   grant execute on function public.handle_new_user()                    to public;
--   grant execute on function public.set_appointment_lead_id()            to public;
--   grant execute on function public.inherit_tenant_from_loan()           to public;
--   grant execute on function public.inherit_tenant_from_property()       to public;
--   grant execute on function public.inherit_tenant_from_service_client() to public;
--   grant execute on function public.rls_auto_enable()                    to public;
--   alter function public.set_updated_at()        reset search_path;
--   alter function public.lead_sync_client_flag() reset search_path;
-- ===========================================================================
