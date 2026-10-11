-- ===========================================================================
-- Access unification, part 1 of 3: identity and audit.     NOT APPLIED.
--
-- One person = one connector account (mcp.app_user), reachable by any of
-- their email addresses, and linked to their dashboard staff record. Every
-- access change is logged: who, person, company, old level, new level.
--
-- Changes nobody's access. Links staff to connector accounts only where the
-- staff email already equals a connector email (exact, lowercase).
-- ===========================================================================
begin;

-- 1. Several emails per person -------------------------------------------
create table mcp.app_user_email (
  email      text primary key check (email = lower(btrim(email)) and position('@' in email) > 1),
  user_id    uuid not null references mcp.app_user(id) on delete cascade,
  is_primary boolean not null default false,
  added_by   text,
  added_at   timestamptz not null default now()
);
create unique index app_user_email_one_primary on mcp.app_user_email (user_id) where is_primary;

insert into mcp.app_user_email (email, user_id, is_primary, added_by)
select lower(btrim(email)), id, true, 'migration 20261011_access_1' from mcp.app_user;

/* app_user.email stays the primary address; a new or changed one is added to
   the list, and an address that already belongs to someone else is refused:
   that refusal is what keeps one person from getting a second account. */
create or replace function mcp.app_user_email_sync() returns trigger
language plpgsql security definer set search_path to 'pg_catalog' as $$
declare v_owner uuid;
begin
  select user_id into v_owner from mcp.app_user_email where email = lower(btrim(new.email));
  if v_owner is not null and v_owner <> new.id then
    raise exception 'the address % already belongs to another person''s connector account', new.email;
  end if;
  update mcp.app_user_email set is_primary = false where user_id = new.id and is_primary and email <> lower(btrim(new.email));
  insert into mcp.app_user_email (email, user_id, is_primary, added_by)
  values (lower(btrim(new.email)), new.id, true, coalesce(nullif(current_setting('mcp.actor', true), ''), session_user))
  on conflict (email) do update set is_primary = true;
  return new;
end $$;
create trigger app_user_email_sync after insert or update of email on mcp.app_user
  for each row execute function mcp.app_user_email_sync();

create or replace function mcp.user_for_email(p_email text) returns uuid
language sql stable security definer set search_path to 'pg_catalog' as $$
  select user_id from mcp.app_user_email where email = lower(btrim(p_email))
$$;

-- 2. The dashboard staff record each connector account belongs to ---------
alter table mcp.app_user add column staff_id uuid unique references public.staff(id) on delete set null;
/* dashboard_synced: false until Jay approves this person's row in the
   per-person table. While false, mcp.sync_dashboard() (part 2) leaves the
   person's dashboard access exactly as it is. */
alter table mcp.app_user add column dashboard_synced boolean not null default false;

update mcp.app_user u set staff_id = s.id
  from public.staff s
  join mcp.app_user_email e on e.email = lower(btrim(s.email))
 where e.user_id = u.id
   and not exists (select 1 from mcp.app_user x where x.staff_id = s.id);

-- 3. Audit: every access change ---------------------------------------------
create table mcp.access_change (
  id         bigserial primary key,
  at         timestamptz not null default now(),
  changed_by text not null,        -- the signed-in admin (mcp.actor), else the grant's granted_by, else the database role
  user_id    uuid not null,
  person     text,
  scope      text,                 -- 'all', a company key, or '-' for account-level changes
  what       text not null,        -- 'level', 'active', 'principal', 'module'
  old_value  text,
  new_value  text
);
create index access_change_user on mcp.access_change (user_id, at desc);

create or replace function mcp.log_grant_change() returns trigger
language plpgsql security definer set search_path to 'pg_catalog' as $$
declare r record := coalesce(new, old);
begin
  if tg_op = 'UPDATE' and old.level is not distinct from new.level then return new; end if;
  insert into mcp.access_change (changed_by, user_id, person, scope, what, old_value, new_value)
  values (coalesce(nullif(current_setting('mcp.actor', true), ''), case when tg_op = 'DELETE' then old.granted_by else new.granted_by end, session_user),
          r.user_id, (select full_name from mcp.app_user where id = r.user_id), r.scope, 'level',
          case when tg_op = 'INSERT' then null else old.level end,
          case when tg_op = 'DELETE' then null else new.level end);
  return r;
end $$;
create trigger access_grant_log after insert or update or delete on mcp.access_grant
  for each row execute function mcp.log_grant_change();

create or replace function mcp.log_user_change() returns trigger
language plpgsql security definer set search_path to 'pg_catalog' as $$
declare v_by text := coalesce(nullif(current_setting('mcp.actor', true), ''), session_user);
begin
  if old.active is distinct from new.active then
    insert into mcp.access_change (changed_by, user_id, person, scope, what, old_value, new_value)
    values (v_by, new.id, new.full_name, '-', 'active', old.active::text, new.active::text);
  end if;
  if old.principal is distinct from new.principal then
    insert into mcp.access_change (changed_by, user_id, person, scope, what, old_value, new_value)
    values (v_by, new.id, new.full_name, 'leavenwealth', 'principal', old.principal, new.principal);
  end if;
  return new;
end $$;
create trigger app_user_log after update of active, principal on mcp.app_user
  for each row execute function mcp.log_user_change();

commit;
