-- The module catalog and the grants table.
--
-- ROLLBACK:
--   drop table if exists public.dashboard_permission;
--   drop table if exists public.dashboard_module;

create table if not exists public.dashboard_module (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references public.tenant(id) on delete cascade,
  company_id uuid references public.company(id) on delete cascade,   -- NULL = Executive Board
  module_key text not null,
  nav_id     text not null,
  label      text not null,
  sort       int  not null default 100,
  created_at timestamptz not null default now()
);

create unique index if not exists dashboard_module_key_uniq
  on public.dashboard_module (tenant_id, coalesce(company_id::text,'exec'), module_key);

-- nav_id must be unique per scope: dash_my_access() aggregates with
-- jsonb_object_agg(nav_id, ...), which raises on a duplicate key. A duplicate would
-- break the access call at boot for every user, not just render oddly.
create unique index if not exists dashboard_module_nav_uniq
  on public.dashboard_module (tenant_id, coalesce(company_id::text,'exec'), nav_id);

comment on table public.dashboard_module is
  'Catalog of grantable modules. company_id NULL means the Executive Board scope. nav_id is the id used by MENUS in public/portal.html and is kept separate from module_key so the catalog and the nav can be named independently. Add a nav item, add its row here, or it is invisible to everyone except owners.';

create table if not exists public.dashboard_permission (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references public.tenant(id) on delete cascade,
  staff_id   uuid not null references public.staff(id) on delete cascade,
  company_id uuid references public.company(id) on delete cascade,   -- NULL = Executive Board
  module     text not null,        -- a module_key, or '*' meaning the whole business
  level      text not null check (level in ('read','write')),
  granted_by uuid references public.staff(id),
  created_at timestamptz not null default now()
);

create unique index if not exists dashboard_permission_uniq
  on public.dashboard_permission (staff_id, coalesce(company_id::text,'exec'), module);

create index if not exists dashboard_permission_staff_idx
  on public.dashboard_permission (staff_id);

comment on table public.dashboard_permission is
  'Grants. owner needs no rows. admin gets one row per business with module=''*'' at write, and Exec as company_id NULL with module=''executive''. user gets one row per module at read or write.';
