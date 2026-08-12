-- ===========================================================================
-- 20260810_app_access_reconcile.sql   (Phase 7)
--
-- Reconciles the permission catalog with the portal's nav, adds a single bulk
-- read for the whole access matrix, and closes two holes where the database
-- would store a grant that the resolver silently ignores.
--
-- Additive and reversible. Rollback at the bottom.
--
-- FOUR DEVIATIONS from the phase brief, each forced by what is actually live.
-- All four were checked against the database before writing, as the brief asked:
--
--   1. NO new unique index on (company_id, module_key). One already exists:
--        uq_app_module ON app_module (module_key, coalesce(company_id::text,'exec'))
--      Adding app_module_uniq would have been a duplicate index on the same
--      expression pair.
--
--   2. handle_new_user() is EXTENDED rather than adding trg_app_link_auth_user.
--      auth.users already carries trg_on_auth_user_created -> handle_new_user(),
--      which inserts into profiles. Two independent AFTER INSERT triggers on
--      auth.users would race and neither would own the outcome, so the link is
--      folded into the existing function.
--
--   3. app_level_for() now resolves the WHOLE Executive scope from the single
--      (company_id IS NULL, module='executive') grant row for an admin. Without
--      this, section 7b's seven new Exec modules are invisible to every admin:
--      the old else-branch compares `company_id = p_company` with p_company NULL,
--      which is never true, so it returned null for orgdept/team/alltasks/...
--      This is not a new policy - it is the brief's own stated rule ("For
--      Executive Board, a row with company_id IS NULL AND module = 'executive'"),
--      which describes a scope-wide grant, applied to a scope that now has 8
--      modules instead of 1.
--
--   4. A unique index on (scope, nav_id) is added. app_my_access() builds its
--      payload with jsonb_object_agg(nav_id, level), which RAISES on a duplicate
--      key. A future duplicate nav_id would therefore break the access call for
--      every user at boot, not merely render something odd. Cheap insurance.
--
-- NOT DONE HERE - section 7d. public.auth.users has ZERO rows, so there is no
-- Supabase Auth user to link chris@leavenwealth.com to, and a UUID must not be
-- invented. Deviation 2 makes the manual UPDATE unnecessary: create the Auth
-- user in the dashboard (Authentication > Users) and the trigger links it on
-- insert. A commented fallback for an ALREADY-existing Auth user is at the end.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 7a. Map catalog keys to portal nav ids
--
-- The portal's nav ids are used by MENUS, the V view map, isEmbedView(),
-- embedInfo() and the ops hash deep links. Renaming them there would be
-- invasive; the catalog carries the mapping instead.
-- ---------------------------------------------------------------------------
alter table public.app_module
  add column if not exists nav_id text;

-- Where the catalog key and the nav id already agree, copy it.
update public.app_module set nav_id = module_key where nav_id is null;

-- The three that disagree.
update public.app_module set nav_id = 'ads'         where module_key = 'marketing';
update public.app_module set nav_id = 'subscribers' where module_key = 'app_users';
update public.app_module set nav_id = 'pipeline'    where module_key = 'loan_pipeline';

-- The Executive module is keyed 'executive' but the portal's nav id is 'exec'.
update public.app_module set nav_id = 'exec' where module_key = 'executive';

alter table public.app_module alter column nav_id set not null;

comment on column public.app_module.nav_id is
  'The id used by MENUS in public/portal.html. Kept separate from module_key so the permission catalog and the nav can be named independently. If you add a nav item, add its module row here too or it will be invisible to everyone except owners.';

-- Deviation 4: app_my_access() aggregates on nav_id per scope and would raise on
-- a duplicate. Enforce what that function assumes.
create unique index if not exists uq_app_module_nav
  on public.app_module (coalesce(company_id::text,'exec'), nav_id);

-- ---------------------------------------------------------------------------
-- 7b. Add the missing modules
--
-- Every brand menu starts with Overview but no company had an 'overview' module,
-- so a `user` had Overview hidden with no way to be granted it. Executive Board
-- had one module against eight nav items.
-- ---------------------------------------------------------------------------
insert into public.app_module (company_id, module_key, label, nav_id, sort)
select c.id, 'overview', 'Overview', 'overview', 5
from public.company c
where not exists (
  select 1 from public.app_module m
  where m.company_id = c.id and m.module_key = 'overview');

-- Executive Board scope is company_id IS NULL. 'executive' -> nav id 'exec' already exists.
insert into public.app_module (company_id, module_key, label, nav_id, sort) values
  (null, 'orgdept',      'Org & Departments',  'orgdept',      20),
  (null, 'team',         'Team directory',     'team',         30),
  (null, 'alltasks',     'All Tasks',          'alltasks',     40),
  (null, 'financials',   'Financials',         'financials',   50),
  (null, 'investors',    'Investors',          'investors',    60),
  (null, 'integrations', 'Integrations',       'integrations', 70),
  (null, 'access',       'Access & Roles',     'access',       80)
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- Deviation 3. Admins hold Executive Board as a scope, not module by module.
-- ---------------------------------------------------------------------------
create or replace function public.app_level_for(p_user uuid, p_company uuid, p_module text)
returns text
language sql stable security definer
set search_path to 'public'
as $function$
  select case
    when u.role = 'owner' then 'write'
    when u.role = 'admin' then (
      case
        -- Executive Board (company_id IS NULL) is one grant covering the whole
        -- scope. Keyed on p_company rather than p_module = 'executive' so the
        -- other seven Exec modules resolve too; the old form fell through to the
        -- '*' lookup below and compared company_id = NULL, which is never true.
        when p_company is null then
          (select 'write' from public.app_permission
             where app_user_id=p_user and company_id is null and module='executive' limit 1)
        else
          (select 'write' from public.app_permission
             where app_user_id=p_user and company_id=p_company and module='*' limit 1)
      end)
    else
      -- A plain user gets exactly the level on the matching (company, module) row.
      (select level from public.app_permission
         where app_user_id=p_user
           and coalesce(company_id::text,'exec') = coalesce(p_company::text,'exec')
           and module=p_module limit 1)
  end
  from public.app_user u where u.id = p_user
$function$;

-- ---------------------------------------------------------------------------
-- 7c. One call for the whole access matrix
-- ---------------------------------------------------------------------------
create or replace function public.app_my_access()
returns jsonb
language sql stable security definer
set search_path to 'public'
as $function$
  select jsonb_build_object(
    'user', (select jsonb_build_object(
               'id', u.id, 'email', u.email, 'full_name', u.full_name,
               'role', u.role, 'is_active', u.is_active)
             from public.app_user u where u.id = public.current_app_user_id()),
    -- Only companies the caller can actually reach. This function is SECURITY
    -- DEFINER, so it bypasses RLS; listing every company here would leak brand
    -- names to a user granted nothing.
    'companies', (select coalesce(jsonb_object_agg(c.id::text, c.name), '{}'::jsonb)
                  from public.company c
                  where c.is_active is not false
                    and exists (
                      select 1 from public.app_module m
                      where m.company_id = c.id
                        and public.my_level(m.company_id, m.module_key) is not null)),
    -- { "<company_id|exec>": { "<nav_id>": "read"|"write" } }
    -- Only granted entries appear. Absent means no access.
    'access', (
      select coalesce(jsonb_object_agg(scope, mods), '{}'::jsonb) from (
        select coalesce(m.company_id::text, 'exec') as scope,
               jsonb_object_agg(m.nav_id, lvl) as mods
        from public.app_module m
        cross join lateral (
          select public.my_level(m.company_id, m.module_key) as lvl
        ) l
        where l.lvl is not null
        group by coalesce(m.company_id::text, 'exec')
      ) s
    )
  )
$function$;

revoke all on function public.app_my_access() from anon;
grant execute on function public.app_my_access() to authenticated;

comment on function public.app_my_access() is
  'The whole access matrix for the signed-in user in ONE round trip, keyed by nav_id so the frontend can gate MENUS directly. Absent key = no access. Never call my_level() per module from the browser - that is up to 39 requests to paint one sidebar.';

-- ---------------------------------------------------------------------------
-- 7d. Self-healing Auth link (deviation 2: fold into the existing trigger)
--
-- Preserves the profiles insert this function already did. Adding the link here
-- rather than as a second trigger on auth.users keeps one owner of the outcome.
-- Runs with auth.uid() null (service role / dashboard), so app_user_guard()
-- treats it as a trusted backend and does not block the update.
-- ---------------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql security definer
set search_path to 'public'
as $function$
begin
  insert into public.profiles (id, email)
  values (new.id, new.email)
  on conflict (id) do nothing;

  -- Claim any app_user row waiting for an Auth user with this address. Matching
  -- on lower(email) because Auth addresses are case-insensitive in practice.
  -- `auth_user_id is null` makes this idempotent and stops a new Auth user from
  -- stealing an account that is already linked.
  update public.app_user
     set auth_user_id = new.id,
         updated_at   = now()
   where lower(email) = lower(new.email)
     and auth_user_id is null;

  return new;
end;
$function$;

-- ---------------------------------------------------------------------------
-- 7e. A plain `user` can never hold Executive Board
--
-- app_level_for() will not resolve an Exec grant for a `user`, so without this
-- the catalog would happily store a row that does nothing but appear in the UI.
-- ---------------------------------------------------------------------------
create or replace function public.app_permission_guard()
returns trigger
language plpgsql security definer
set search_path to 'public'
as $function$
declare actor uuid; actor_role text; target uuid; target_role text;
begin
  -- Executive Board (company_id IS NULL) is owner/admin only. Checked BEFORE the
  -- trusted-backend escape hatch on purpose: the invite endpoint runs as the
  -- service role and must be bound by this rule too.
  if TG_OP <> 'DELETE' and NEW.company_id is null then
    select role into target_role from public.app_user where id = NEW.app_user_id;
    if target_role = 'user' then
      raise exception 'Executive Board access requires the Admin or Owner role';
    end if;
  end if;

  actor := public.current_app_user_id();
  if actor is null then return coalesce(NEW, OLD); end if;   -- trusted backend
  select role into actor_role from public.app_user where id = actor;
  if actor_role not in ('owner','admin') then
    raise exception 'Not permitted to manage permissions';
  end if;
  if actor_role = 'owner' then return coalesce(NEW, OLD); end if;
  -- admin restrictions:
  target := coalesce(NEW.app_user_id, OLD.app_user_id);
  if target = actor then
    raise exception 'Admins cannot modify their own permissions (owner only)';
  end if;
  if TG_OP <> 'DELETE' then
    if public.app_level_rank(public.app_level_for(actor, NEW.company_id, NEW.module))
       < public.app_level_rank(NEW.level) then
      raise exception 'You cannot grant more access than you have';
    end if;
  end if;
  return coalesce(NEW, OLD);
end $function$;

-- Matching hole: demoting an admin who holds Exec grants down to `user` leaves
-- those rows orphaned, and the account silently loses Exec with nothing deleted.
create or replace function public.app_user_guard()
returns trigger
language plpgsql security definer
set search_path to 'public'
as $function$
declare actor uuid; actor_role text;
begin
  -- Before the trusted-backend return, for the same reason as above.
  if TG_OP = 'UPDATE' and NEW.role = 'user' and OLD.role <> 'user'
     and exists (select 1 from public.app_permission
                  where app_user_id = NEW.id and company_id is null) then
    raise exception 'Remove this user''s Executive Board access before changing their role to User';
  end if;

  actor := public.current_app_user_id();
  if actor is null then return NEW; end if;                 -- service role / no session = trusted backend
  select role into actor_role from public.app_user where id = actor;
  if actor_role not in ('owner','admin') then
    raise exception 'Not permitted to manage users';
  end if;
  if actor_role = 'owner' then return NEW; end if;
  -- admin restrictions:
  if NEW.role = 'owner' then
    raise exception 'Only an owner can grant the Owner role';
  end if;
  if TG_OP = 'UPDATE' and NEW.id = actor and NEW.role is distinct from OLD.role then
    raise exception 'Admins cannot change their own role';
  end if;
  return NEW;
end $function$;

-- ---------------------------------------------------------------------------
-- 7f. Hardening flagged earlier. Zero behaviour change.
--
-- NOTE, and this is the one that bites: `revoke ... from anon` is NOT enough.
-- Postgres grants EXECUTE on every new function to PUBLIC by default, and anon
-- inherits PUBLIC, so revoking the explicit anon grant leaves the function fully
-- callable without a session. The security advisor caught app_my_access() still
-- reachable via /rest/v1/rpc/ after the anon revoke had "succeeded".
-- Revoke from PUBLIC, then re-grant the roles that should have it.
--
-- `authenticated` MUST keep app_my_role() and current_app_user_id(): the
-- app_user / app_permission RLS policies call them directly, and policy
-- expressions are evaluated as the querying role, not as the definer.
-- ---------------------------------------------------------------------------
alter function public.app_level_rank(text) set search_path to 'public';

revoke execute on function public.app_my_access()                 from public;
revoke execute on function public.my_level(uuid, text)            from public;
revoke execute on function public.app_my_role()                   from public;
revoke execute on function public.app_level_for(uuid, uuid, text) from public;

-- Harmless belt-and-braces if an explicit anon grant is ever added by hand.
revoke execute on function public.app_my_access()                 from anon;
revoke execute on function public.my_level(uuid, text)            from anon;
revoke execute on function public.app_my_role()                   from anon;
revoke execute on function public.app_level_for(uuid, uuid, text) from anon;

grant execute on function public.app_my_access() to authenticated;

-- Verify with the privilege system rather than trusting the linter's cache:
--   select proname,
--          has_function_privilege('anon', oid, 'execute')          as anon_can,
--          has_function_privilege('authenticated', oid, 'execute') as auth_can
--     from pg_proc p join pg_namespace n on n.oid=p.pronamespace
--    where n.nspname='public'
--      and proname in ('app_my_access','my_level','app_my_role','app_level_for');
--
-- STILL anon-callable and deliberately left alone: current_app_user_id() and
-- app_level_rank(). Both pre-existing, both named by neither this phase nor 7f,
-- and neither leaks anything - without a session the first returns null and the
-- second is a pure integer mapping. app_level_for() remains callable by
-- `authenticated`, which lets a signed-in user read another user's level if they
-- can guess an app_user id. Worth revisiting in Phase 10, when it is clear
-- whether anything in the browser needs it; it is not needed there today.

-- ===========================================================================
-- Fallback for 7d, ONLY if a Supabase Auth user for this address already exists
-- (it does not today - auth.users is empty). Prefer the trigger above.
--
--   update public.app_user
--      set auth_user_id = '<the auth.users UUID>'
--    where email = 'chris@leavenwealth.com' and auth_user_id is null;
--
-- ===========================================================================
-- ROLLBACK
--
--   -- 7a / 7b / deviation 4
--   drop index if exists public.uq_app_module_nav;
--   delete from public.app_module
--    where company_id is null
--      and module_key in ('orgdept','team','alltasks','financials',
--                         'investors','integrations','access');
--   delete from public.app_module where module_key = 'overview';
--   alter table public.app_module drop column if exists nav_id;
--
--   -- deviation 3: original app_level_for
--   create or replace function public.app_level_for(p_user uuid, p_company uuid, p_module text)
--   returns text language sql stable security definer set search_path to 'public'
--   as $$
--     select case
--       when u.role = 'owner' then 'write'
--       when u.role = 'admin' then (
--         case
--           when p_module = 'executive' then
--             (select 'write' from public.app_permission
--                where app_user_id=p_user and company_id is null and module='executive' limit 1)
--           else
--             (select 'write' from public.app_permission
--                where app_user_id=p_user and company_id=p_company and module='*' limit 1)
--         end)
--       else
--         (select level from public.app_permission
--            where app_user_id=p_user
--              and coalesce(company_id::text,'exec') = coalesce(p_company::text,'exec')
--              and module=p_module limit 1)
--     end
--     from public.app_user u where u.id = p_user
--   $$;
--
--   -- 7c
--   drop function if exists public.app_my_access();
--
--   -- 7d: original handle_new_user (profiles insert only)
--   create or replace function public.handle_new_user()
--   returns trigger language plpgsql security definer set search_path to 'public'
--   as $$
--   begin
--     insert into public.profiles (id, email)
--     values (new.id, new.email)
--     on conflict (id) do nothing;
--     return new;
--   end;
--   $$;
--
--   -- 7e: original app_permission_guard (no Exec role check)
--   create or replace function public.app_permission_guard()
--   returns trigger language plpgsql security definer set search_path to 'public'
--   as $$
--   declare actor uuid; actor_role text; target uuid;
--   begin
--     actor := public.current_app_user_id();
--     if actor is null then return coalesce(NEW, OLD); end if;
--     select role into actor_role from public.app_user where id = actor;
--     if actor_role not in ('owner','admin') then
--       raise exception 'Not permitted to manage permissions';
--     end if;
--     if actor_role = 'owner' then return coalesce(NEW, OLD); end if;
--     target := coalesce(NEW.app_user_id, OLD.app_user_id);
--     if target = actor then
--       raise exception 'Admins cannot modify their own permissions (owner only)';
--     end if;
--     if TG_OP <> 'DELETE' then
--       if public.app_level_rank(public.app_level_for(actor, NEW.company_id, NEW.module))
--          < public.app_level_rank(NEW.level) then
--         raise exception 'You cannot grant more access than you have';
--       end if;
--     end if;
--     return coalesce(NEW, OLD);
--   end $$;
--
--   -- 7e: original app_user_guard (no Exec demotion check)
--   create or replace function public.app_user_guard()
--   returns trigger language plpgsql security definer set search_path to 'public'
--   as $$
--   declare actor uuid; actor_role text;
--   begin
--     actor := public.current_app_user_id();
--     if actor is null then return NEW; end if;
--     select role into actor_role from public.app_user where id = actor;
--     if actor_role not in ('owner','admin') then
--       raise exception 'Not permitted to manage users';
--     end if;
--     if actor_role = 'owner' then return NEW; end if;
--     if NEW.role = 'owner' then
--       raise exception 'Only an owner can grant the Owner role';
--     end if;
--     if TG_OP = 'UPDATE' and NEW.id = actor and NEW.role is distinct from OLD.role then
--       raise exception 'Admins cannot change their own role';
--     end if;
--     return NEW;
--   end $$;
--
--   -- 7f grants (only if anon genuinely needs them again, which it should not)
--   -- grant execute on function public.my_level(uuid, text) to anon;
-- ===========================================================================
