-- ===========================================================================
-- Saved custom views  (Phase 3.1)
--
-- REVIEW ONLY until Jay approves. migrations/ is not auto-applied.
--
-- A saved view is a stored QUESTION, never stored data: a dataset key from
-- config/datasets.js, a display type, and a config describing fields,
-- filters, sort and layout. The rows are fetched fresh on every load and
-- scoped to whoever is looking.
--
-- The two decisions worth defending:
--
--  * owner_user_id references public.staff, NOT auth.users. CLAUDE.md is
--    explicit that `staff` IS the dashboard user record and that ~38 columns
--    already reference auth.users with ON DELETE NO ACTION, so an auth user
--    who has created anything cannot be deleted. Pointing at staff keeps
--    this table out of that knot, and it is the id the portal's own session
--    layer already has in hand.
--
--  * config is jsonb and is validated in CODE against the dataset registry,
--    on save AND on load, not by a check constraint. A constraint would have
--    to be migrated every time a dataset gains a field, and a view saved
--    against yesterday's registry must still OPEN tomorrow - showing
--    "Field missing: X" in place of the field rather than failing. A
--    constraint cannot express "was valid when saved, degrades gracefully
--    now". config_version is what lets the loader know which shape it is
--    reading.
--
-- Soft delete only. A shared view that vanishes from under the people it was
-- shared with is a support ticket; deleted_at keeps the row addressable.
-- ===========================================================================

create table if not exists public.saved_view (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenant(id) on delete cascade,
  owner_staff_id  uuid not null references public.staff(id) on delete cascade,
  name            text not null,
  description     text,
  dataset_key     text not null,
  display_type    text not null check (display_type in ('dashboard', 'spreadsheet', 'list', 'report')),
  config          jsonb not null default '{}'::jsonb,
  config_version  integer not null default 1,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  deleted_at      timestamptz,

  constraint saved_view_name_not_blank check (length(btrim(name)) > 0),
  -- config must be an object. A bare array or string parses as valid jsonb
  -- and then every field read off it is null, which renders as an empty view
  -- rather than an error.
  constraint saved_view_config_is_object check (jsonb_typeof(config) = 'object')
);

-- the common read is "views I own that still exist", so the index carries the
-- soft-delete predicate rather than making every query filter a dead row out
-- after the fact.
create index if not exists saved_view_owner_idx
  on public.saved_view (tenant_id, owner_staff_id) where deleted_at is null;
create index if not exists saved_view_dataset_idx
  on public.saved_view (dataset_key) where deleted_at is null;

create table if not exists public.saved_view_share (
  view_id         uuid not null references public.saved_view(id) on delete cascade,
  principal_type  text not null check (principal_type in ('user', 'role')),
  principal_id    text not null,
  permission      text not null check (permission in ('viewer', 'editor')),
  granted_by      uuid references public.staff(id) on delete set null,
  granted_at      timestamptz not null default now(),
  primary key (view_id, principal_type, principal_id)
);

create index if not exists saved_view_share_principal_idx
  on public.saved_view_share (principal_type, principal_id);

-- principal_id is text, not uuid, because a 'role' principal is a role NAME
-- ('admin', 'owner', 'user') while a 'user' principal is a staff uuid. Two
-- columns would let a row name both or neither; one text column plus the
-- type discriminator cannot.

-- ---------------------------------------------------------------------------
-- RLS.
--
-- These policies are a SECOND line only. The portal's API reads with the
-- privileged SUPABASE_DB_URL connection, where RLS never runs - so the real
-- permission check lives in the route handler, exactly as CLAUDE.md says of
-- every other screen. What these buy is that a view is not readable by the
-- whole tenant if anything ever reaches this table over an authenticated
-- client.
-- ---------------------------------------------------------------------------
alter table public.saved_view       enable row level security;
alter table public.saved_view_share enable row level security;

drop policy if exists saved_view_read on public.saved_view;
create policy saved_view_read on public.saved_view
  for select to authenticated
  using (
    deleted_at is null
    and tenant_id = any (current_tenant_ids())
    and (
      owner_staff_id = current_staff_id()
      or exists (
        select 1 from public.saved_view_share sh
         where sh.view_id = id
           and (
             (sh.principal_type = 'user' and sh.principal_id = current_staff_id()::text)
             or (sh.principal_type = 'role' and sh.principal_id = dash_role())
           )
      )
    )
  );

-- only the owner may change or delete the view itself. Editors change the
-- CONFIG through the API, which runs privileged and does its own check; they
-- are deliberately not given a blanket update policy here, because that would
-- also let them rewrite owner_staff_id.
drop policy if exists saved_view_owner_write on public.saved_view;
create policy saved_view_owner_write on public.saved_view
  for all to authenticated
  using (tenant_id = any (current_tenant_ids()) and owner_staff_id = current_staff_id())
  with check (tenant_id = any (current_tenant_ids()) and owner_staff_id = current_staff_id());

drop policy if exists saved_view_share_read on public.saved_view_share;
create policy saved_view_share_read on public.saved_view_share
  for select to authenticated using (exists (
    select 1 from public.saved_view v
     where v.id = view_id and v.tenant_id = any (current_tenant_ids())));

drop policy if exists saved_view_share_write on public.saved_view_share;
create policy saved_view_share_write on public.saved_view_share
  for all to authenticated
  using (exists (select 1 from public.saved_view v
                  where v.id = view_id and v.owner_staff_id = current_staff_id()))
  with check (exists (select 1 from public.saved_view v
                  where v.id = view_id and v.owner_staff_id = current_staff_id()));

grant select on public.saved_view, public.saved_view_share to authenticated;
