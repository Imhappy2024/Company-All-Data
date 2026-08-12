-- ===========================================================================
-- 20260812_profile_self_service.sql   (Phase 8f-1)
--
-- Lets a person edit their own profile, and makes app_user.email a read-through
-- of the confirmed Supabase Auth address rather than an independently writable
-- value.
--
-- Additive. Rollback at the bottom.
--
-- WHY THIS IS SPLIT ACROSS TWO LAYERS, which looks redundant until you try it:
--   * the POLICY (app_user_upd_self) decides WHETHER you may update your own row
--   * the TRIGGER (app_user_guard) decides WHICH COLUMNS you may change
-- Postgres RLS cannot compare OLD to NEW in a single expression, so column
-- scoping cannot live in a WITH CHECK. It has to be in the trigger, where both
-- tuples are in scope. Do not try to move it.
--
-- Before this migration a plain `user` could not edit their own name at all, and
-- failed twice over: app_user_upd requires owner/admin so RLS matched zero rows
-- silently, and app_user_guard() raised 'Not permitted to manage users' before
-- anything else ran.
--
-- Verified against the live app_user_guard() body first; it matched the expected
-- pre-state from 20260810_app_access_reconcile.sql.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Self-update policy.
--
-- Additive: multiple PERMISSIVE policies for the same command are OR'd, so this
-- grants self-update without touching or weakening app_user_upd. Reads already
-- work - app_user_sel carries `OR id = current_app_user_id()`.
-- ---------------------------------------------------------------------------
drop policy if exists app_user_upd_self on public.app_user;
create policy app_user_upd_self on public.app_user
  for update to authenticated
  using      (id = public.current_app_user_id())
  with check (id = public.current_app_user_id());

-- ---------------------------------------------------------------------------
-- Guard: the email mirror rule, and the column-scoped self-service branch.
-- ---------------------------------------------------------------------------
create or replace function public.app_user_guard()
returns trigger
language plpgsql security definer
set search_path to 'public'
as $function$
declare actor uuid; actor_role text;
begin
  -- (unchanged) Exec grants must be cleared before a demotion to 'user'.
  if TG_OP = 'UPDATE' and NEW.role = 'user' and OLD.role <> 'user'
     and exists (select 1 from public.app_permission
                  where app_user_id = NEW.id and company_id is null) then
    raise exception 'Remove this user''s Executive Board access before changing their role to User';
  end if;

  -- app_user.email is a MIRROR of the confirmed auth.users email, never an
  -- independent value. Once an account is linked, the only address you may write
  -- is the one Supabase Auth has already confirmed. This is what stops a profile
  -- form from changing what someone signs in with. Above the trusted-backend
  -- return on purpose: it binds the service role too.
  --
  -- Skipped while auth_user_id is null, i.e. an invited-but-not-yet-accepted row,
  -- where there is no confirmed address to mirror yet.
  if TG_OP = 'UPDATE' and NEW.auth_user_id is not null
     and NEW.email is distinct from OLD.email
     and lower(NEW.email) <> lower(coalesce(
           (select u.email from auth.users u where u.id = NEW.auth_user_id), '')) then
    raise exception 'Email changes go through Supabase Auth. app_user.email mirrors the confirmed address.';
  end if;

  actor := public.current_app_user_id();
  if actor is null then return NEW; end if;                 -- service role / no session
  select role into actor_role from public.app_user where id = actor;

  -- Self-service profile edit. Returns BEFORE the management checks, so a plain
  -- `user` is not rejected by them. Column-scoped, so it cannot be turned into
  -- self-promotion; email is already constrained by the mirror rule above.
  -- Owners and admins fall through deliberately - they hold broader rights and
  -- the management path already allows editing their own row.
  if TG_OP = 'UPDATE' and NEW.id = actor and actor_role not in ('owner','admin') then
    if NEW.role         is distinct from OLD.role
    or NEW.is_active    is distinct from OLD.is_active
    or NEW.tenant_id    is distinct from OLD.tenant_id
    or NEW.auth_user_id is distinct from OLD.auth_user_id
    or NEW.staff_id     is distinct from OLD.staff_id
    or NEW.invited_by   is distinct from OLD.invited_by then
      raise exception 'You may only change your own name and email here';
    end if;
    return NEW;
  end if;

  -- (unchanged from here down)
  if actor_role not in ('owner','admin') then
    raise exception 'Not permitted to manage users';
  end if;
  if actor_role = 'owner' then return NEW; end if;
  if NEW.role = 'owner' then
    raise exception 'Only an owner can grant the Owner role';
  end if;
  if TG_OP = 'UPDATE' and NEW.id = actor and NEW.role is distinct from OLD.role then
    raise exception 'Admins cannot change their own role';
  end if;
  return NEW;
end $function$;

-- ---------------------------------------------------------------------------
-- Keep the mirror in sync: a confirmed auth email change flows onto app_user.
-- ---------------------------------------------------------------------------
create or replace function public.app_sync_auth_email()
returns trigger
language plpgsql security definer
set search_path to 'public'
as $function$
begin
  if new.email is distinct from old.email then
    update public.app_user
       set email = new.email, updated_at = now()
     where auth_user_id = new.id;
  end if;
  return new;
end $function$;

-- AFTER UPDATE OF email is a different event from the existing AFTER INSERT
-- trigger (trg_on_auth_user_created -> handle_new_user), so the two cannot race.
drop trigger if exists trg_app_sync_auth_email on auth.users;
create trigger trg_app_sync_auth_email
  after update of email on auth.users
  for each row execute function public.app_sync_auth_email();

comment on function public.app_sync_auth_email() is
  'Mirrors a confirmed auth.users email change onto app_user. Together with the email rule in app_user_guard(), this makes app_user.email a read-through of the confirmed address rather than a value the app can set.';

-- Same lesson as 7f: a new function is EXECUTE-to-PUBLIC by default and anon
-- inherits PUBLIC. A direct RPC call would fail anyway ("can only be called as a
-- trigger"), but leaving it exposed adds a security-advisor finding for nothing.
-- Trigger execution does not consult EXECUTE, so this is free.
revoke execute on function public.app_sync_auth_email() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Collision note. app_user has UNIQUE (tenant_id, email). If the new address
-- already belongs to someone in the tenant, the sync UPDATE above raises, and the
-- auth email change then fails at CONFIRMATION time - a confusing place to find
-- out, long after the form said "check your email". PATCH /api/profile pre-checks
-- the collision before calling updateUser so it fails at submit instead.
-- ---------------------------------------------------------------------------

-- ===========================================================================
-- ROLLBACK
--
--   drop policy if exists app_user_upd_self on public.app_user;
--   drop trigger if exists trg_app_sync_auth_email on auth.users;
--   drop function if exists public.app_sync_auth_email();
--
--   -- then restore app_user_guard() to the 20260810_app_access_reconcile.sql body:
--   create or replace function public.app_user_guard()
--   returns trigger language plpgsql security definer set search_path to 'public'
--   as $$
--   declare actor uuid; actor_role text;
--   begin
--     if TG_OP = 'UPDATE' and NEW.role = 'user' and OLD.role <> 'user'
--        and exists (select 1 from public.app_permission
--                     where app_user_id = NEW.id and company_id is null) then
--       raise exception 'Remove this user''s Executive Board access before changing their role to User';
--     end if;
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
-- ===========================================================================
