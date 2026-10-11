-- ===========================================================================
-- Access unification, part 4: the per-person changes Jay approved 2026-10-11.
-- Everyone not named here is left exactly as they are (dashboard_synced
-- stays false, so the dashboard sync never touches them).
-- ===========================================================================
begin;
select set_config('mcp.actor', 'jay@leavenwealth.com (approved 2026-10-11)', true);

-- Chris: retire the unused chris@leavenwealth.com connector account ---------
do $$
declare v_old uuid; v_role text;
begin
  select id, db_role into v_old, v_role from mcp.app_user where email = 'chris@leavenwealth.com';
  if v_old is null then return; end if;
  if exists (select 1 from mcp.token where user_id = v_old) or (select last_seen_at from mcp.app_user where id = v_old) is not null then
    raise exception 'chris@leavenwealth.com has been used; not retiring it without asking';
  end if;
  update mcp.app_user set active = false where id = v_old;          -- logged
  perform mcp.sync_user_access(v_old);                               -- revokes its table grants
  delete from mcp.access_grant where user_id = v_old;                -- logged
  delete from mcp.app_user where id = v_old;                         -- its email aliases go with it
  /* the role owns nothing and sync_user_access revoked its grants; if
     anything still depends on it, keep it with login disabled */
  if v_role is not null and exists (select 1 from pg_roles where rolname = v_role) then
    begin
      execute format('drop role %I', v_role);
    exception when others then
      execute format('alter role %I nologin', v_role);
      raise notice 'role % kept with login disabled: %', v_role, sqlerrm;
    end;
  end if;
end $$;

-- Chris: one account, both addresses, owner, principal unchanged -------------
insert into mcp.app_user_email (email, user_id, is_primary, added_by)
select 'chris@leavenwealth.com', id, false, 'jay@leavenwealth.com' from mcp.app_user where email = 'ckpomerleau@gmail.com';
update mcp.app_user set staff_id = (select id from public.staff where lower(email) = 'chris@leavenwealth.com'),
                        dashboard_owner = true, dashboard_synced = true
 where email = 'ckpomerleau@gmail.com';

-- Jay: jay@leadliconsulting.com is the same person; admin on all -------------
insert into mcp.app_user_email (email, user_id, is_primary, added_by)
select 'jay@leadliconsulting.com', id, false, 'jay@leavenwealth.com' from mcp.app_user where email = 'jay@leavenwealth.com';
update mcp.app_user set staff_id = (select id from public.staff where lower(email) = 'jay@leadliconsulting.com'), dashboard_synced = true
 where email = 'jay@leavenwealth.com';

-- Mitch: admin on all, unchanged; the dashboard now follows the grant --------
update mcp.app_user set dashboard_synced = true where email = 'mitch@leavenwealth.com';

-- Brian: Folio Excel at "user" (read/write, no financials); LeavenWealth lw_user
insert into mcp.access_grant (user_id, scope, level, granted_by)
select id, 'folio', 'user', 'jay@leavenwealth.com' from mcp.app_user where email = 'brian@leavenwealth.com';
update mcp.app_user set dashboard_synced = true where email = 'brian@leavenwealth.com';

select mcp.sync_user_access(id) from mcp.app_user
 where email in ('ckpomerleau@gmail.com', 'jay@leavenwealth.com', 'mitch@leavenwealth.com', 'brian@leavenwealth.com');

commit;
