-- Guardrails enforced in the database, not just hidden in the UI.
--
-- ROLLBACK:
--   drop trigger if exists trg_dashboard_permission_guard on public.dashboard_permission;
--   drop trigger if exists trg_staff_dashboard_guard on public.staff;
--   drop function if exists public.dashboard_permission_guard();
--   drop function if exists public.staff_dashboard_guard();

create or replace function public.dashboard_permission_guard()
returns trigger language plpgsql security definer set search_path to 'public' as $$
declare
  actor uuid; actor_role text; target_role text;
begin
  -- Derive tenant_id from the staff row so callers cannot set it inconsistently.
  if TG_OP <> 'DELETE' and NEW.tenant_id is null then
    select tenant_id into NEW.tenant_id from public.staff where id = NEW.staff_id;
  end if;

  -- Executive Board is owner and admin only. Checked BEFORE the trusted-backend
  -- escape hatch on purpose: the invite endpoint runs as the service role and must
  -- be bound by this too. dash_level_for will not resolve such a grant anyway, so
  -- allowing the row only creates a permission that shows in the UI and does
  -- nothing.
  if TG_OP <> 'DELETE' and NEW.company_id is null then
    select dashboard_role into target_role from public.staff where id = NEW.staff_id;
    if target_role = 'user' then
      raise exception 'Executive Board access requires the Admin or Owner role';
    end if;
  end if;

  actor := public.current_staff_id();
  if actor is null then return coalesce(NEW, OLD); end if;   -- service role / no session

  select dashboard_role into actor_role from public.staff where id = actor;

  if actor_role not in ('owner','admin') then
    raise exception 'Not permitted to manage permissions';
  end if;
  if actor_role = 'owner' then return coalesce(NEW, OLD); end if;

  -- Admin restrictions from here down.
  if coalesce(NEW.staff_id, OLD.staff_id) = actor then
    raise exception 'Admins cannot modify their own permissions (owner only)';
  end if;

  if TG_OP <> 'DELETE' then
    if public.dash_rank(public.dash_level_for(actor, NEW.company_id, NEW.module))
       < public.dash_rank(NEW.level) then
      raise exception 'You cannot grant more access than you have';
    end if;
  end if;

  return coalesce(NEW, OLD);
end $$;

drop trigger if exists trg_dashboard_permission_guard on public.dashboard_permission;
create trigger trg_dashboard_permission_guard
  before insert or update or delete on public.dashboard_permission
  for each row execute function public.dashboard_permission_guard();


-- Only fires on dashboard fields. Ordinary HR edits to a staff row (title, phone,
-- avatar) are untouched by this.
create or replace function public.staff_dashboard_guard()
returns trigger language plpgsql security definer set search_path to 'public' as $$
declare
  actor uuid; actor_role text;
begin
  if NEW.dashboard_role is not distinct from OLD.dashboard_role
     and NEW.dashboard_access is not distinct from OLD.dashboard_access then
    return NEW;   -- nothing access-related changed
  end if;

  -- Demoting to 'user' while Exec grants remain would orphan those rows and change
  -- access silently. Applies to everyone including the service role.
  if NEW.dashboard_role = 'user' and OLD.dashboard_role is distinct from 'user'
     and exists (select 1 from public.dashboard_permission
                  where staff_id = NEW.id and company_id is null) then
    raise exception 'Remove this person''s Executive Board access before changing their role to User';
  end if;

  actor := public.current_staff_id();
  if actor is null then return NEW; end if;

  select dashboard_role into actor_role from public.staff where id = actor;

  if actor_role not in ('owner','admin') then
    raise exception 'Not permitted to manage dashboard access';
  end if;
  if actor_role = 'owner' then return NEW; end if;

  if NEW.dashboard_role = 'owner' then
    raise exception 'Only an owner can grant the Owner role';
  end if;
  if NEW.id = actor then
    raise exception 'Admins cannot change their own dashboard role or access';
  end if;

  return NEW;
end $$;

drop trigger if exists trg_staff_dashboard_guard on public.staff;
create trigger trg_staff_dashboard_guard
  before update on public.staff
  for each row execute function public.staff_dashboard_guard();

revoke execute on function public.dashboard_permission_guard() from public;
revoke execute on function public.staff_dashboard_guard()      from public;
