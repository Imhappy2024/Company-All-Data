-- ===========================================================================
-- Access unification, part 7: screens for the Custom level.
--
-- Jay 2026-10-11: "Custom level: no screens until chosen per person."
-- mcp.module_restriction can only narrow what a level gives, and Custom gives
-- nothing, so choosing its screens needs a place of its own. Each row is one
-- screen for one person on one company, read-only or with editing. The data
-- behind it is still whatever their custom tables allow (mcp.custom_access):
-- a screen whose tables they cannot read shows nothing, never more.
-- ===========================================================================
begin;

create table mcp.custom_module (
  user_id   uuid not null,
  scope     text not null,
  nav_id    text not null,
  can_write boolean not null default false,
  set_by    text,
  set_at    timestamptz not null default now(),
  primary key (user_id, scope, nav_id),
  foreign key (user_id, scope) references mcp.access_grant (user_id, scope) on delete cascade
);

create or replace function mcp.log_custom_module_change() returns trigger
language plpgsql security definer set search_path to 'pg_catalog' as $$
declare r record := coalesce(new, old);
begin
  insert into mcp.access_change (changed_by, user_id, person, scope, what, old_value, new_value)
  values (coalesce(nullif(current_setting('mcp.actor', true), ''), r.set_by, session_user), r.user_id,
          (select full_name from mcp.app_user where id = r.user_id), r.scope, 'custom screen',
          case when tg_op = 'INSERT' then null else old.nav_id || case when old.can_write then '=write' else '=read' end end,
          case when tg_op = 'DELETE' then null else new.nav_id || case when new.can_write then '=write' else '=read' end end);
  return r;
end $$;
create trigger custom_module_log after insert or update or delete on mcp.custom_module
  for each row execute function mcp.log_custom_module_change();
create trigger custom_module_dashboard after insert or update or delete on mcp.custom_module
  for each row execute function mcp.sync_user_access_and_dashboard();

/* dashboard_modules(), with Custom grants contributing their chosen screens */
create or replace function mcp.dashboard_modules(p_user uuid)
returns table (company_id uuid, nav_id text, level text)
language sql stable security definer set search_path to 'pg_catalog' as $$
  with g as (
    select co.company_id, co.key, g.scope,
           case when g.scope = 'all' and co.key = 'leavenwealth' and g.level = 'user' then 'lw_user'
                when g.scope = 'all' and co.key = 'leavenwealth' and g.level in ('user_2', 'user_3') then 'lw_user_ro'
                else g.level end as level
      from mcp.access_grant g join mcp.app_user u on u.id = g.user_id and u.active
      join mcp.company co on g.scope = 'all' or g.scope = co.key
     where g.user_id = p_user
  ), comp as (
    select x.company_id, x.key, x.nav_id, bool_or(x.w) w from (
      select g.company_id, g.key, m.nav_id, lm.can_write w
        from g join public.dashboard_module m on m.company_id = g.company_id
        join mcp.level_module lm on lm.level = g.level and lm.area = 'company' and lm.nav_id = m.nav_id
      union all
      select g.company_id, g.key, m.nav_id, cm.can_write
        from g join mcp.custom_module cm on cm.user_id = p_user and cm.scope = g.scope and g.level = 'custom'
        join public.dashboard_module m on m.company_id = g.company_id and m.nav_id = cm.nav_id
    ) x group by 1, 2, 3
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

commit;
