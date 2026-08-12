-- Claude Code proposed revoking EXECUTE on current_app_role() from authenticated
-- because it is a retired concept. That would have broken profiles: four live
-- policies still call it, and RLS policy expressions run as the QUERYING role, so
-- removing the grant makes every one of them raise permission denied and profiles
-- becomes unreadable to signed-in users.
--
-- Repoint the policies first, then the revoke is safe. Order matters.
--
-- No self-edit clause: Jay decided the profile panel is read-only, so name and
-- avatar changes go through Users & Roles like everything else.
--
-- ROLLBACK: restore the four policies below with current_app_role() = 'admin',
--   and grant execute on function public.current_app_role() to anon, authenticated;

drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles
  for select to authenticated
  using (id = auth.uid() or public.dash_role() = any (array['owner','admin']));

drop policy if exists profiles_insert on public.profiles;
create policy profiles_insert on public.profiles
  for insert to authenticated
  with check (public.dash_role() = any (array['owner','admin']));

drop policy if exists profiles_update on public.profiles;
create policy profiles_update on public.profiles
  for update to authenticated
  using      (public.dash_role() = any (array['owner','admin']))
  with check (public.dash_role() = any (array['owner','admin']));

drop policy if exists profiles_delete on public.profiles;
create policy profiles_delete on public.profiles
  for delete to authenticated
  using (public.dash_role() = 'owner');

-- Now nothing references it. Revoke rather than drop: reversible, and dropping is
-- destructive for no gain. profiles.role stays as a dead column.
revoke execute on function public.current_app_role() from public, anon, authenticated;

comment on function public.current_app_role() is
  'DEAD. Reads profiles.role, a retired concept superseded by staff.dashboard_role. No policy calls it and EXECUTE is revoked from anon and authenticated. Do not write new code against this or profiles.role.';
