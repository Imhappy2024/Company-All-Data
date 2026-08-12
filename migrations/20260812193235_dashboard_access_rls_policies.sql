-- The ensure_rls event trigger turns RLS ON for new tables but creates NO policies,
-- so both tables are currently readable by nobody. These are those policies.
--
-- ROLLBACK: drop policy if exists ... for each of the seven below.

alter table public.dashboard_module     enable row level security;
alter table public.dashboard_permission enable row level security;

-- Catalog. Any signed-in dashboard user may read it; it is reference data, not
-- customer data, and the Users & Roles checkboxes are drawn from it.
drop policy if exists dashboard_module_sel on public.dashboard_module;
create policy dashboard_module_sel on public.dashboard_module
  for select to authenticated
  using (tenant_id in (select public.current_tenant_ids()));

drop policy if exists dashboard_module_ins on public.dashboard_module;
create policy dashboard_module_ins on public.dashboard_module
  for insert to authenticated
  with check (tenant_id in (select public.current_tenant_ids())
              and public.dash_role() = any (array['owner','admin']));

drop policy if exists dashboard_module_upd on public.dashboard_module;
create policy dashboard_module_upd on public.dashboard_module
  for update to authenticated
  using      (tenant_id in (select public.current_tenant_ids())
              and public.dash_role() = any (array['owner','admin']))
  with check (tenant_id in (select public.current_tenant_ids())
              and public.dash_role() = any (array['owner','admin']));

drop policy if exists dashboard_module_del on public.dashboard_module;
create policy dashboard_module_del on public.dashboard_module
  for delete to authenticated
  using (tenant_id in (select public.current_tenant_ids())
         and public.dash_role() = 'owner');

-- Grants. You can always read your own. Owner and admin can read and write rows
-- belonging to staff in their own tenant. A plain user never writes their own.
drop policy if exists dashboard_permission_sel on public.dashboard_permission;
create policy dashboard_permission_sel on public.dashboard_permission
  for select to authenticated
  using (staff_id = public.current_staff_id()
         or (public.dash_role() = any (array['owner','admin'])
             and tenant_id in (select public.current_tenant_ids())));

drop policy if exists dashboard_permission_ins on public.dashboard_permission;
create policy dashboard_permission_ins on public.dashboard_permission
  for insert to authenticated
  with check (public.dash_role() = any (array['owner','admin'])
              and tenant_id in (select public.current_tenant_ids()));

drop policy if exists dashboard_permission_upd on public.dashboard_permission;
create policy dashboard_permission_upd on public.dashboard_permission
  for update to authenticated
  using      (public.dash_role() = any (array['owner','admin'])
              and tenant_id in (select public.current_tenant_ids()))
  with check (public.dash_role() = any (array['owner','admin'])
              and tenant_id in (select public.current_tenant_ids()));

drop policy if exists dashboard_permission_del on public.dashboard_permission;
create policy dashboard_permission_del on public.dashboard_permission
  for delete to authenticated
  using (public.dash_role() = any (array['owner','admin'])
         and tenant_id in (select public.current_tenant_ids()));
