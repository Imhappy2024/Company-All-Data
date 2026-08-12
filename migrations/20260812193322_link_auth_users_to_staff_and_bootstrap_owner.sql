-- Extend the EXISTING handle_new_user trigger rather than adding a second AFTER
-- INSERT trigger on auth.users; two would race. When an invited person accepts,
-- their staff row is linked by email automatically.
--
-- ROLLBACK: restore handle_new_user to the profiles-only body, and
--   update public.staff set user_id = null, dashboard_access = false,
--          dashboard_role = null where lower(email) = 'chris@leavenwealth.com';

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path to 'public' as $$
begin
  insert into public.profiles (id, email)
  values (new.id, new.email)
  on conflict (id) do nothing;

  -- Self-heal the staff link on invite acceptance. Matches on email, which is
  -- unique per tenant as of the dashboard_access_staff_columns migration.
  update public.staff
     set user_id = new.id, updated_at = now()
   where lower(email) = lower(new.email)
     and user_id is null;

  return new;
end;
$$;

-- Bootstrap the owner. Runs as the migration role, so current_staff_id() is null
-- and the staff guard's trusted-backend path applies.
update public.staff s
   set user_id          = u.id,
       dashboard_access = true,
       dashboard_role   = 'owner',
       updated_at       = now()
  from auth.users u
 where lower(u.email) = lower(s.email)
   and lower(s.email) = 'chris@leavenwealth.com';
