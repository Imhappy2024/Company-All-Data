-- ===========================================================================
-- REVIEW BEFORE RUNNING. Not applied automatically by the app.
--
-- Problem: `entity` is the only tenant table whose policies are not scoped by
-- tenant. It uses current_app_role(), which reads public.profiles, and has no
-- tenant_id predicate. Any authenticated user with a profiles row of role
-- viewer/editor/admin can read every entity across every tenant.
--
-- Every other table in the schema uses current_tenant_ids(). This brings
-- `entity` in line. Additive and reversible: the old policies are dropped and
-- replaced in the same transaction, so there is no window with RLS off.
--
-- Run in Supabase SQL editor, then re-run the security advisor.
-- ===========================================================================
begin;

alter table public.entity enable row level security;

drop policy if exists entity_select on public.entity;
drop policy if exists entity_insert on public.entity;
drop policy if exists entity_update on public.entity;
drop policy if exists entity_delete on public.entity;

create policy entity_select on public.entity
  for select to authenticated
  using (tenant_id in (select current_tenant_ids()));

create policy entity_insert on public.entity
  for insert to authenticated
  with check (tenant_id in (select current_tenant_ids())
              and tenant_role(tenant_id) in ('admin','editor'));

create policy entity_update on public.entity
  for update to authenticated
  using (tenant_id in (select current_tenant_ids())
         and tenant_role(tenant_id) in ('admin','editor'))
  with check (tenant_id in (select current_tenant_ids()));

create policy entity_delete on public.entity
  for delete to authenticated
  using (tenant_id in (select current_tenant_ids())
         and tenant_role(tenant_id) = 'admin');

commit;

-- Check: every entity row must carry a tenant_id, or the new policy hides it.
-- select count(*) from public.entity where tenant_id is null;   -- expect 0
