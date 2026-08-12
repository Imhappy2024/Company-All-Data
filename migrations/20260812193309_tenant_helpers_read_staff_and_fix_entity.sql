-- current_tenant_ids() and tenant_role() read tenant_member, which has 0 rows, so
-- all 196 RLS policies currently evaluate to false for every signed-in user. Nobody
-- can read staff, which everything in this build depends on.
--
-- Do NOT rewrite the policies. Change the functions they call. One seam, not 196.
--
-- ROLLBACK: the original bodies are at the bottom of this file.

create or replace function public.current_tenant_ids()
returns setof uuid language sql stable security definer set search_path to 'public' as $$
  select tenant_id from public.staff
   where user_id = auth.uid() and is_active and dashboard_access
$$;

-- Why a plain user maps to 'viewer' and not 'editor': the existing policies are
-- tenant-grained, not module-grained. tenant_role() IN ('admin','editor') gates
-- writes to EVERY tenant-scoped table at once, so mapping a user with one write
-- grant to 'editor' would hand them write access to loan, investor and everything
-- else from the browser. A plain user is read-only at the database; writes they are
-- entitled to go through a server route that checks dash_level() first.
create or replace function public.tenant_role(p_tenant uuid)
returns text language sql stable security definer set search_path to 'public' as $$
  select case s.dashboard_role
           when 'owner' then 'admin'
           when 'admin' then 'admin'
           else 'viewer'
         end
    from public.staff s
   where s.user_id = auth.uid() and s.is_active and s.dashboard_access
     and s.tenant_id = p_tenant
$$;

create or replace function public.current_company_ids()
returns setof uuid language sql stable security definer set search_path to 'public' as $$
  select distinct m.company_id
    from public.dashboard_module m
   where m.company_id is not null
     and public.dash_level(m.company_id, m.module_key) is not null
$$;

create or replace function public.company_role(p_company uuid)
returns text language sql stable security definer set search_path to 'public' as $$
  select case when public.dash_role() in ('owner','admin') then 'admin' else 'viewer' end
   where exists (select 1 from public.dashboard_module m
                  where m.company_id = p_company
                    and public.dash_level(m.company_id, m.module_key) is not null)
$$;

-- Policy expressions run as the querying role, so authenticated needs EXECUTE on
-- anything a policy calls. anon does not.
revoke execute on function public.current_tenant_ids()      from public;
revoke execute on function public.tenant_role(uuid)         from public;
revoke execute on function public.current_company_ids()     from public;
revoke execute on function public.company_role(uuid)        from public;
grant  execute on function public.current_tenant_ids()      to authenticated;
grant  execute on function public.tenant_role(uuid)         to authenticated;
grant  execute on function public.current_company_ids()     to authenticated;
grant  execute on function public.company_role(uuid)        to authenticated;

-- ---------------------------------------------------------------------------
-- entity is the only table in the schema whose policies ignore tenant_id. They
-- gate on current_app_role(), which reads profiles.role, which is NOT NULL
-- DEFAULT 'viewer' and is set for every new account by handle_new_user. So the
-- moment a second person can sign in, every signed-in user could read all 72
-- entity rows regardless of what they hold. Inert today only because nobody can
-- sign in yet; this build is what makes it live.
-- ---------------------------------------------------------------------------
drop policy if exists entity_select on public.entity;
create policy entity_select on public.entity for select to authenticated
  using (tenant_id in (select public.current_tenant_ids()));

drop policy if exists entity_insert on public.entity;
create policy entity_insert on public.entity for insert to authenticated
  with check (tenant_id in (select public.current_tenant_ids())
              and public.tenant_role(tenant_id) = any (array['admin','editor']));

drop policy if exists entity_update on public.entity;
create policy entity_update on public.entity for update to authenticated
  using      (tenant_id in (select public.current_tenant_ids())
              and public.tenant_role(tenant_id) = any (array['admin','editor']))
  with check (tenant_id in (select public.current_tenant_ids())
              and public.tenant_role(tenant_id) = any (array['admin','editor']));

drop policy if exists entity_delete on public.entity;
create policy entity_delete on public.entity for delete to authenticated
  using (tenant_id in (select public.current_tenant_ids())
         and public.tenant_role(tenant_id) = 'admin');

-- ===========================================================================
-- ROLLBACK for the four helpers (original bodies, verbatim):
--
-- create or replace function public.current_tenant_ids()
-- returns setof uuid language sql stable security definer set search_path to 'public'
-- as $f$ select tenant_id from public.tenant_member where user_id = auth.uid() $f$;
--
-- create or replace function public.tenant_role(p_tenant uuid)
-- returns text language sql stable security definer set search_path to 'public'
-- as $f$ select role from public.tenant_member
--         where user_id = auth.uid() and tenant_id = p_tenant $f$;
--
-- create or replace function public.current_company_ids()
-- returns setof uuid language sql stable security definer set search_path to 'public'
-- as $f$ select company_id from public.company_member where user_id = auth.uid()
--        union
--        select c.id from public.company c
--          join public.tenant_member tm on tm.tenant_id = c.tenant_id
--         where tm.user_id = auth.uid() and tm.role = 'admin' $f$;
--
-- create or replace function public.company_role(p_company uuid)
-- returns text language sql stable security definer set search_path to 'public'
-- as $f$ select coalesce(
--         (select role from public.company_member
--           where user_id=auth.uid() and company_id=p_company limit 1),
--         (select tm.role from public.company c
--            join public.tenant_member tm on tm.tenant_id=c.tenant_id
--           where c.id=p_company and tm.user_id=auth.uid()
--             and tm.role='admin' limit 1)) $f$;
--
-- entity policies: restore the four current_app_role() versions.
-- ===========================================================================
