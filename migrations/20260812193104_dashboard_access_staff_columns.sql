-- Dashboard access lives on staff. One row per person; no separate user table.
-- staff.user_id is already FK to auth.users, and staff already has email,
-- full_name, avatar_url and is_active.
--
-- NOTE: staff_company.role holds job titles ("Director of Finance"). It is the
-- company role and has nothing to do with dashboard access. Do not read it here.
--
-- ROLLBACK:
--   drop index if exists public.staff_tenant_email_uniq;
--   alter table public.staff drop constraint if exists staff_dashboard_consistent;
--   alter table public.staff drop constraint if exists staff_dashboard_role_check;
--   alter table public.staff drop column if exists dashboard_role;
--   alter table public.staff drop column if exists dashboard_access;

alter table public.staff
  add column if not exists dashboard_access boolean not null default false,
  add column if not exists dashboard_role   text;

alter table public.staff drop constraint if exists staff_dashboard_role_check;
alter table public.staff add constraint staff_dashboard_role_check
  check (dashboard_role is null or dashboard_role in ('owner','admin','user'));

-- Access and role travel together, so a half-configured row cannot mean anything.
alter table public.staff drop constraint if exists staff_dashboard_consistent;
alter table public.staff add constraint staff_dashboard_consistent
  check ( (dashboard_access = false and dashboard_role is null)
       or (dashboard_access = true  and dashboard_role is not null) );

-- The invite flow matches people by email, so it has to be unique.
create unique index if not exists staff_tenant_email_uniq
  on public.staff (tenant_id, lower(email));

comment on column public.staff.dashboard_access is
  'Can this person sign in to the dashboard. False for staff who are recorded but have no login.';
comment on column public.staff.dashboard_role is
  'owner | admin | user. The dashboard access role. NOT the job title, which lives on staff_company.role.';
