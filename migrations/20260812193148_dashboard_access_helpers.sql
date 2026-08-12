-- The contract the frontend and the RLS policies both use.
-- All SECURITY DEFINER with a pinned search_path: policies call these, and their
-- internal reads must bypass RLS or they would recurse.
--
-- ROLLBACK: drop function if exists ... for each of the five below.

create or replace function public.current_staff_id()
returns uuid language sql stable security definer set search_path to 'public' as $$
  select id from public.staff
   where user_id = auth.uid() and is_active and dashboard_access
   limit 1
$$;

create or replace function public.dash_role()
returns text language sql stable security definer set search_path to 'public' as $$
  select dashboard_role from public.staff where id = public.current_staff_id()
$$;

create or replace function public.dash_rank(p text)
returns int language sql immutable set search_path to 'public' as $$
  select case p when 'write' then 2 when 'read' then 1 else 0 end
$$;

-- The admin Executive branch keys on p_company IS NULL, deliberately, NOT on the
-- module name. Keying it on a literal module name means every other Exec module
-- resolves to null for admins.
create or replace function public.dash_level_for(p_staff uuid, p_company uuid, p_module text)
returns text language sql stable security definer set search_path to 'public' as $$
  select case
    when s.dashboard_role = 'owner' then 'write'
    when s.dashboard_role = 'admin' then (
      case when p_company is null then
        (select 'write' from public.dashboard_permission
          where staff_id = p_staff and company_id is null and module = 'executive' limit 1)
      else
        (select 'write' from public.dashboard_permission
          where staff_id = p_staff and company_id = p_company and module = '*' limit 1)
      end)
    else
      (select level from public.dashboard_permission
        where staff_id = p_staff
          and coalesce(company_id::text,'exec') = coalesce(p_company::text,'exec')
          and module = p_module limit 1)
  end
  from public.staff s where s.id = p_staff and s.dashboard_access
$$;

create or replace function public.dash_level(p_company uuid, p_module text)
returns text language sql stable security definer set search_path to 'public' as $$
  select public.dash_level_for(public.current_staff_id(), p_company, p_module)
$$;

-- The whole access matrix in ONE round trip, keyed by nav_id so the frontend can
-- gate MENUS directly. Absent key = no access. Never call dash_level() per module
-- from the browser.
create or replace function public.dash_my_access()
returns jsonb language sql stable security definer set search_path to 'public' as $$
  select jsonb_build_object(
    'user', (select jsonb_build_object(
               'id', s.id, 'email', s.email, 'full_name', s.full_name,
               'avatar_url', s.avatar_url, 'role', s.dashboard_role)
             from public.staff s where s.id = public.current_staff_id()),
    -- Only companies the caller can actually reach. This function is SECURITY
    -- DEFINER and bypasses RLS; listing every company would leak brand names to
    -- someone who has been granted nothing.
    'companies', (select coalesce(jsonb_object_agg(c.id::text, c.name), '{}'::jsonb)
                  from public.company c
                  where c.is_active is not false
                    and exists (select 1 from public.dashboard_module m
                                 where m.company_id = c.id
                                   and public.dash_level(m.company_id, m.module_key) is not null)),
    'access', (select coalesce(jsonb_object_agg(scope, mods), '{}'::jsonb) from (
        select coalesce(m.company_id::text,'exec') as scope,
               jsonb_object_agg(m.nav_id, lvl) as mods
        from public.dashboard_module m
        cross join lateral (select public.dash_level(m.company_id, m.module_key) as lvl) l
        where l.lvl is not null
        group by coalesce(m.company_id::text,'exec')
      ) s)
  )
$$;

comment on function public.dash_my_access() is
  'The whole access matrix for the signed-in user in one call, keyed by nav_id. This is the frontend contract.';

-- Postgres grants EXECUTE to PUBLIC on every new function and anon inherits it, so
-- "revoke from anon" alone does nothing. Revoke from PUBLIC, then grant explicitly.
revoke execute on function public.current_staff_id()                      from public;
revoke execute on function public.dash_role()                             from public;
revoke execute on function public.dash_rank(text)                         from public;
revoke execute on function public.dash_level(uuid, text)                  from public;
revoke execute on function public.dash_level_for(uuid, uuid, text)        from public;
revoke execute on function public.dash_my_access()                        from public;

grant execute on function public.current_staff_id() to authenticated;
grant execute on function public.dash_role()        to authenticated;
grant execute on function public.dash_rank(text)    to authenticated;
grant execute on function public.dash_level(uuid, text) to authenticated;
grant execute on function public.dash_my_access()   to authenticated;
-- dash_level_for is not needed from the browser: it takes an arbitrary staff id and
-- would let a signed-in user probe someone else's level. Callers reach it through
-- dash_level, which is SECURITY DEFINER and so runs its inner call as the owner.
