-- ===========================================================================
-- 20260812_unify_access_helpers.sql   (Phase 12c + the entity/profiles fix)
--
-- ONE TRANSACTION, deliberately. Three changes that are only safe together:
--
--   1. The four RLS helpers stop reading tenant_member / company_member and start
--      reading app_user / app_permission. 214 policies call these four functions
--      and NONE of them are edited - that is the whole point. One seam, not 214
--      rewrites, and it keeps the additive-and-reversible rule in CLAUDE.md.
--
--   2. public.entity gets a tenant predicate. It had NONE - not tenant_id, not
--      company_id - and its policies gated on current_app_role(), which reads
--      profiles.role, which is NOT NULL DEFAULT 'viewer'. So every account that
--      ever signed in could read all 72 entity rows across every tenant. Not
--      exploitable yet only because nobody had signed in; it becomes real with the
--      first non-owner account in Phase 11.
--
--   3. public.profiles stops gating on profiles.role and gates on app_user.role.
--
-- Splitting 1 from 2 would leave entity readable-by-everyone in one migration and
-- readable-by-nobody in the next. Hence one file, one transaction.
--
-- profiles.role was a THIRD role system, alongside app_user.role and the
-- tenant_member/company_member pair. Nothing ever wrote 'admin' to it, so entity
-- insert/update/delete and all profiles management were impossible for everyone -
-- the mirror image of the read hole. Both go away here.
--
-- The column public.profiles.role SURVIVES and is now dead weight. Dropping a
-- column is destructive and it is not in the way. Do not wire new policies to it.
-- ===========================================================================

begin;

-- ---------------------------------------------------------------------------
-- 12c. The seam. Same four names, same three-word vocabulary
-- (admin | editor | viewer) the 214 policies compare against, new source.
-- ---------------------------------------------------------------------------
create or replace function public.current_tenant_ids()
returns setof uuid language sql stable security definer
set search_path to 'public'
as $function$
  select tenant_id from public.app_user
   where auth_user_id = auth.uid() and is_active
$function$;

create or replace function public.current_company_ids()
returns setof uuid language sql stable security definer
set search_path to 'public'
as $function$
  select distinct m.company_id
    from public.app_module m
   where m.company_id is not null
     and public.my_level(m.company_id, m.module_key) is not null
$function$;

/* WHY a `user` maps to viewer and NOT editor, which is the tempting mapping:
   the 214 policies are tenant-grained, not module-grained. `tenant_role() IN
   ('admin','editor')` gates writes to EVERY tenant-scoped table at once, so a user
   granted write on nothing but Properties would get direct write access to loan,
   investor and everything else straight from the browser with their own JWT. RLS
   cannot express "write to property but not loan" in its current shape.
   So: a `user` is read-only at the database, and any write they are entitled to
   goes through an Express route that checks my_level() server-side first.
   Do not "fix" this by promoting user to editor. */
create or replace function public.tenant_role(p_tenant uuid)
returns text language sql stable security definer
set search_path to 'public'
as $function$
  select case u.role
           when 'owner' then 'admin'
           when 'admin' then 'admin'
           else 'viewer'
         end
    from public.app_user u
   where u.auth_user_id = auth.uid() and u.is_active
     and u.tenant_id = p_tenant
$function$;

create or replace function public.company_role(p_company uuid)
returns text language sql stable security definer
set search_path to 'public'
as $function$
  select case
           when public.app_my_role() in ('owner','admin') then 'admin'
           else 'viewer'
         end
   where exists (select 1 from public.app_module m
                  where m.company_id = p_company
                    and public.my_level(m.company_id, m.module_key) is not null)
$function$;

-- ---------------------------------------------------------------------------
-- entity: the standard shape used by the other 57 tables. Replacements, not
-- additions, so the policy count does not move.
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

-- ---------------------------------------------------------------------------
-- profiles: gate on the real role source. The self clause on select/update is
-- intentional - profiles carries full_name and avatar_url, which a person should
-- be able to change about themselves.
-- ---------------------------------------------------------------------------
drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles for select to authenticated
  using (id = auth.uid() or public.app_my_role() = any (array['owner','admin']));

drop policy if exists profiles_insert on public.profiles;
create policy profiles_insert on public.profiles for insert to authenticated
  with check (public.app_my_role() = any (array['owner','admin']));

drop policy if exists profiles_update on public.profiles;
create policy profiles_update on public.profiles for update to authenticated
  using      (id = auth.uid() or public.app_my_role() = any (array['owner','admin']))
  with check (id = auth.uid() or public.app_my_role() = any (array['owner','admin']));

drop policy if exists profiles_delete on public.profiles;
create policy profiles_delete on public.profiles for delete to authenticated
  using (public.app_my_role() = any (array['owner','admin']));

-- ---------------------------------------------------------------------------
-- ADDED, not in the brief - flag it and drop it if unwanted.
--
-- profiles_update now permits `id = auth.uid()`, and profiles.role has no column
-- scoping, so a plain user could set their own profiles.role = 'admin'. That is
-- inert TODAY because current_app_role() is dropped below and nothing reads the
-- column - but "inert dead column" is exactly what profiles.role looked like
-- before it turned out to be backing eight policies, one of which let every
-- signed-in account read all of entity. Closing the write path means the column
-- cannot quietly become an escalation vector if someone wires a policy to it later.
--
-- Same two-layer pattern as 8f-1: the policy decides WHETHER, the trigger decides
-- WHICH COLUMNS, because RLS cannot compare OLD to NEW.
-- ---------------------------------------------------------------------------
create or replace function public.profiles_guard()
returns trigger language plpgsql security definer
set search_path to 'public'
as $function$
declare actor uuid;
begin
  actor := public.current_app_user_id();
  if actor is null then return NEW; end if;      -- service role / no session
  if NEW.role is distinct from OLD.role
     and public.app_my_role() not in ('owner','admin') then
    raise exception 'Only an owner or admin may change a profile role';
  end if;
  return NEW;
end $function$;

drop trigger if exists trg_profiles_guard on public.profiles;
create trigger trg_profiles_guard
  before update on public.profiles
  for each row execute function public.profiles_guard();

-- 7f lesson, applied on creation this time rather than after the advisor says so.
revoke execute on function public.profiles_guard() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Retire current_app_role(). Verified first: 8 policies referenced it (the 8
-- replaced above), no function, no view, and nothing in server.js / public/ /
-- realtime.js / test/ - the only app-code mention of `profiles` anywhere is a
-- TABLE_VIEWS entry in portal-realtime.js, which is a refresh mapping, not a role read.
-- ---------------------------------------------------------------------------
drop function if exists public.current_app_role();

commit;

-- ===========================================================================
-- VERIFICATION (impersonate `authenticated`; see the report for results)
--
--   -- unchanged at 215. NOTE: 215, not the 214 in the brief - app_user_upd_self
--   -- from 20260812_profile_self_service.sql is the +1. These are replacements.
--   select count(*) from pg_policies where schemaname='public';
--
--   -- owner: 72 rows, and writes now work (before this they could read, not write)
--   -- test user: 72 rows (correct, entity is tenant-scoped), insert refused
--   -- a row under a fabricated second tenant must be invisible to the owner
--
-- ROLLBACK
--   -- entity / profiles policies: restore the current_app_role() forms
--   -- drop policy if exists entity_select on public.entity;
--   -- create policy entity_select on public.entity for select to authenticated
--   --   using (public.current_app_role() = any (array['admin','editor','viewer']));
--   -- ... insert/update: current_app_role() = any (array['admin','editor'])
--   -- ... delete:        current_app_role() = any (array['admin','editor'])
--   -- profiles_select: id = auth.uid() or public.current_app_role() = 'admin'
--   -- profiles_insert/update/delete: public.current_app_role() = 'admin'
--   --
--   -- and recreate the function it needs:
--   -- create or replace function public.current_app_role()
--   -- returns text language sql stable security definer set search_path to 'public'
--   -- as $$ select role from public.profiles where id = auth.uid(); $$;
--   --
--   -- drop trigger if exists trg_profiles_guard on public.profiles;
--   -- drop function if exists public.profiles_guard();
--   --
--   -- the four helpers, verbatim as they were before this migration:
--   -- create or replace function public.current_tenant_ids()
--   -- returns setof uuid language sql stable security definer set search_path to 'public'
--   -- as $$ select tenant_id from public.tenant_member where user_id = auth.uid() $$;
--   --
--   -- create or replace function public.tenant_role(p_tenant uuid)
--   -- returns text language sql stable security definer set search_path to 'public'
--   -- as $$ select role from public.tenant_member
--   --        where user_id = auth.uid() and tenant_id = p_tenant $$;
--   --
--   -- create or replace function public.current_company_ids()
--   -- returns setof uuid language sql stable security definer set search_path to 'public'
--   -- as $$ select company_id from public.company_member where user_id = auth.uid()
--   --       union
--   --       select c.id from public.company c
--   --         join public.tenant_member tm on tm.tenant_id = c.tenant_id
--   --        where tm.user_id = auth.uid() and tm.role = 'admin' $$;
--   --
--   -- create or replace function public.company_role(p_company uuid)
--   -- returns text language sql stable security definer set search_path to 'public'
--   -- as $$ select coalesce(
--   --        (select role from public.company_member
--   --          where user_id=auth.uid() and company_id=p_company limit 1),
--   --        (select tm.role from public.company c
--   --           join public.tenant_member tm on tm.tenant_id=c.tenant_id
--   --          where c.id=p_company and tm.user_id=auth.uid()
--   --            and tm.role='admin' limit 1)) $$;
--
-- NOT DONE HERE - 12d (dropping tenant_member / company_member). That waits until
-- Phase 12 is re-verified in a real browser session as the owner, per the
-- resequence. Both tables are empty, so nothing depends on the delay.
-- ===========================================================================
