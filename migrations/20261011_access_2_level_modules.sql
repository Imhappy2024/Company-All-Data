-- ===========================================================================
-- Access unification, part 2 of 3: screens follow the data level.   NOT APPLIED.
--
-- mcp.access_grant (the connector's grants) is the ONE source of truth. This
-- file adds:
--   mcp.level_module        which dashboard screens each level allows, and
--                           whether it may write there (one table, edit here)
--   mcp.module_restriction  per-person narrowing: a screen can be hidden or
--                           made read-only for someone, never widened
--   mcp.dashboard_modules() the screens a person gets, derived from the above
--   mcp.sync_dashboard()    rewrites that person's public.dashboard_permission
--                           and staff.dashboard_access / dashboard_role
-- and triggers on access_grant, module_restriction and app_user (active,
-- staff link) that call sync_dashboard(), so a change made with the
-- connector's own admin tools moves the dashboard too.
--
-- Changes nobody's access: sync_dashboard() does nothing for a person until
-- mcp.app_user.dashboard_synced is set for them (part 1), which happens one
-- person at a time after Jay approves their row.
-- ===========================================================================
begin;

/* area 'company': a brand's own menu (nav ids in public.dashboard_module with
   a company_id). area 'exec': the Executive Board menu, reachable only from a
   grant on scope 'all'. */
create table mcp.level_module (
  level     text not null references mcp.access_level(name),
  area      text not null check (area in ('company', 'exec')),
  nav_id    text not null,
  can_write boolean not null,
  primary key (level, area, nav_id)
);

/* Screens that show money. user and user_3 ("no financials") never get them. */
create temp table _fin (nav_id text primary key) on commit drop;
insert into _fin values ('loans'), ('investors'), ('insurance'), ('financials'), ('reports'), ('subscribers'), ('plans'), ('exec');

create temp table _navs (area text, nav_id text) on commit drop;
insert into _navs select distinct case when company_id is null then 'exec' else 'company' end, nav_id from public.dashboard_module;

-- admin: every screen, write. 'access' (Users & Roles) only exists in the exec menu.
insert into mcp.level_module select 'admin', area, nav_id, true from _navs;
-- user: every non-financial screen, write
insert into mcp.level_module select 'user', area, nav_id, true from _navs n
 where nav_id not in (select nav_id from _fin) and nav_id <> 'access';
-- user_2: every screen including financials, read only
insert into mcp.level_module select 'user_2', area, nav_id, false from _navs where nav_id <> 'access';
-- user_3: every non-financial screen, read only
insert into mcp.level_module select 'user_3', area, nav_id, false from _navs n
 where nav_id not in (select nav_id from _fin) and nav_id <> 'access';
-- custom: no screens until chosen per person (its data is table-by-table)

-- LeavenWealth-only levels: LeavenWealth's menu
insert into mcp.level_module (level, area, nav_id, can_write)
select l, 'company', nav_id, true from (values ('principal'), ('lw_corporate')) v(l),
       (select distinct nav_id from public.dashboard_module where company_id = 'c0000000-0000-4000-8000-000000000003') m;
/* Jay 2026-10-11: Properties, Tasks, Custom view and Documents with editing;
   Team, Departments and Tools read-only. No Leads, Loans or Financials (those
   menus are going; loans and financials live inside Properties). The asset
   management fee tab is part of Properties; its data is granted in part 3. */
insert into mcp.level_module (level, area, nav_id, can_write) values
  ('lw_user', 'company', 'properties', true), ('lw_user', 'company', 'tasks', true), ('lw_user', 'company', 'views', true),
  ('lw_user', 'company', 'documents', true), ('lw_user', 'company', 'team', false), ('lw_user', 'company', 'departments', false),
  ('lw_user', 'company', 'tools', false),
  ('lw_user_ro', 'company', 'properties', false), ('lw_user_ro', 'company', 'tasks', false), ('lw_user_ro', 'company', 'views', false),
  ('lw_user_ro', 'company', 'documents', false), ('lw_user_ro', 'company', 'team', false), ('lw_user_ro', 'company', 'departments', false),
  ('lw_user_ro', 'company', 'tools', false),
  ('lw_viewer', 'company', 'properties', false);

-- per-person narrowing ----------------------------------------------------
create table mcp.module_restriction (
  user_id uuid not null references mcp.app_user(id) on delete cascade,
  scope   text not null,            -- a company key, or 'all' for the exec menu
  area    text not null check (area in ('company', 'exec')),
  nav_id  text not null,
  max     text not null check (max in ('none', 'read')),
  set_by  text,
  set_at  timestamptz not null default now(),
  primary key (user_id, scope, area, nav_id)
);

create or replace function mcp.log_restriction_change() returns trigger
language plpgsql security definer set search_path to 'pg_catalog' as $$
declare r record := coalesce(new, old);
begin
  insert into mcp.access_change (changed_by, user_id, person, scope, what, old_value, new_value)
  values (coalesce(nullif(current_setting('mcp.actor', true), ''), r.set_by, session_user), r.user_id,
          (select full_name from mcp.app_user where id = r.user_id), r.scope, 'module',
          case when tg_op = 'INSERT' then null else old.nav_id || '=' || old.max end,
          case when tg_op = 'DELETE' then null else new.nav_id || '=' || new.max end);
  return r;
end $$;
create trigger module_restriction_log after insert or update or delete on mcp.module_restriction
  for each row execute function mcp.log_restriction_change();

/* The screens a person gets: per company (and the exec menu), the best of
   their grants, then narrowed by any restriction. A grant on 'all' at user /
   user_2 / user_3 behaves as lw_user / lw_user_ro on LeavenWealth, exactly as
   mcp.access_level says it does for data. */
create or replace function mcp.dashboard_modules(p_user uuid)
returns table (company_id uuid, nav_id text, level text)
language sql stable security definer set search_path to 'pg_catalog' as $$
  with g as (
    select co.company_id, co.key,
           case when g.scope = 'all' and co.key = 'leavenwealth' and g.level = 'user' then 'lw_user'
                when g.scope = 'all' and co.key = 'leavenwealth' and g.level in ('user_2', 'user_3') then 'lw_user_ro'
                else g.level end as level
      from mcp.access_grant g join mcp.app_user u on u.id = g.user_id and u.active
      join mcp.company co on g.scope = 'all' or g.scope = co.key
     where g.user_id = p_user
  ), comp as (
    select g.company_id, g.key, m.nav_id, bool_or(lm.can_write) w
      from g join public.dashboard_module m on m.company_id = g.company_id
      join mcp.level_module lm on lm.level = g.level and lm.area = 'company' and lm.nav_id = m.nav_id
     group by 1, 2, 3
  ), ex as (
    select null::uuid company_id, 'all'::text key, lm.nav_id, bool_or(lm.can_write) w
      from mcp.access_grant g join mcp.app_user u on u.id = g.user_id and u.active
      join mcp.level_module lm on lm.level = g.level and lm.area = 'exec'
     where g.user_id = p_user and g.scope = 'all'
       and (lm.nav_id <> 'access' or g.level = 'admin')
     group by 1, 2, 3
  ), both_ as (select * from comp union all select * from ex)
  select b.company_id, b.nav_id,
         case when r.max = 'read' or not b.w then 'read' else 'write' end
    from both_ b
    left join mcp.module_restriction r on r.user_id = p_user and r.scope = b.key
         and r.area = case when b.company_id is null then 'exec' else 'company' end and r.nav_id = b.nav_id
   where r.max is distinct from 'none'
$$;

/* Owner is a named person, not a level (Jay 2026-10-11: Chris only). */
alter table mcp.app_user add column dashboard_owner boolean not null default false;

/* Rewrite one person's dashboard access from their grants.
     owner  dashboard_owner, active                 -> every screen
     admin  admin on 'all'                          -> every screen
     user   everyone else                           -> the derived screens
   Owners and admins get the '*' (per company) and 'executive' rows that
   dash_level_for() reads for those roles, which is exactly the layout the
   admins have today. Users & Roles stays role-gated (owner/admin). */
create or replace function mcp.sync_dashboard(p_user uuid) returns integer
language plpgsql security definer set search_path to 'pg_catalog' as $$
declare u record; n integer := 0; v_tenant uuid; v_role text;
begin
  select * into u from mcp.app_user where id = p_user;
  if not found or u.staff_id is null or not u.dashboard_synced then return 0; end if;
  select tenant_id into v_tenant from public.staff where id = u.staff_id;
  v_role := case when not u.active then null
                 when u.dashboard_owner then 'owner'
                 when exists (select 1 from mcp.access_grant where user_id = p_user and scope = 'all' and level = 'admin') then 'admin'
                 else 'user' end;
  delete from public.dashboard_permission where staff_id = u.staff_id;
  if v_role in ('owner', 'admin') then
    insert into public.dashboard_permission (tenant_id, staff_id, company_id, module, level)
    select v_tenant, u.staff_id, c.company_id, '*', 'write' from mcp.company c
    union all select v_tenant, u.staff_id, null, 'executive', 'write';
  elsif v_role = 'user' then
    insert into public.dashboard_permission (tenant_id, staff_id, company_id, module, level)
    select v_tenant, u.staff_id, d.company_id, m.module_key, d.level
      from mcp.dashboard_modules(p_user) d
      join public.dashboard_module m on m.nav_id = d.nav_id and m.company_id is not distinct from d.company_id;
  end if;
  get diagnostics n = row_count;
  if v_role = 'user' and n = 0 then v_role := null; end if;
  update public.staff s set dashboard_access = v_role is not null, dashboard_role = v_role where s.id = u.staff_id;
  return n;
end $$;

/* the connector's sync now carries the dashboard with it */
create or replace function mcp.sync_user_access_and_dashboard() returns trigger
language plpgsql security definer set search_path to 'pg_catalog' as $$
begin
  perform mcp.sync_dashboard(coalesce(new.user_id, old.user_id));
  return null;
end $$;
create trigger access_grant_dashboard after insert or update or delete on mcp.access_grant
  for each row execute function mcp.sync_user_access_and_dashboard();
create trigger module_restriction_dashboard after insert or update or delete on mcp.module_restriction
  for each row execute function mcp.sync_user_access_and_dashboard();

create or replace function mcp.sync_dashboard_on_user() returns trigger
language plpgsql security definer set search_path to 'pg_catalog' as $$
begin perform mcp.sync_dashboard(new.id); return null; end $$;
create trigger app_user_dashboard after update of active, staff_id, dashboard_synced, dashboard_owner on mcp.app_user
  for each row execute function mcp.sync_dashboard_on_user();

commit;
