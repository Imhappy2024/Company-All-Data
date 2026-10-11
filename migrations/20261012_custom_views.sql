-- ===========================================================================
-- Custom views and property groups  (PROPERTIES_SPEC v2 section 4)
--
-- REVIEW ONLY until Jay approves. migrations/ is not auto-applied.
--
-- A custom view is a saved_view row like the existing ones: same table, same
-- sharing (saved_view_share), same "the reader's own tenant scope" rule. It
-- gets its own display_type, 'custom', so the old Views screen and the new
-- Custom view tab never show each other's rows. Its config carries:
--
--   { mode: 'quick'|'advanced', quickCards, groups: [group id], excl:
--     ['<group id>|<property id>'], props: [property id] | null,
--     fields: [field key], styles: ['table'|'list'|'chart'], chartField,
--     cards: [{ id, label, size, kind: 'value'|'formula', field, period,
--              agg, fmt, terms: [...] }], layout: ['card:<id>'|'table'|...] }
--
-- No column holds it: config is jsonb and the server validates every key
-- against a whitelist on save AND on load, as it already does for views.
--
-- Property groups are the user's own and reusable across their views. A
-- group is a list of property ids, never a query, so a viewer the view is
-- shared with sees exactly the properties the owner chose - and the server
-- still reads them through the reader's tenant scope.
--
-- Additive and reversible: two new tables, one widened CHECK, one seeded
-- group and one seeded view. To reverse:
--   delete from saved_view where display_type = 'custom';
--   drop table property_group_member, property_group;
--   and restore the four-value display_type check.
-- ===========================================================================

create table if not exists public.property_group (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenant(id) on delete cascade,
  owner_staff_id  uuid not null references public.staff(id) on delete cascade,
  name            text not null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint property_group_name_not_blank check (length(btrim(name)) > 0)
);
-- one name per owner; two people may each have a "Kouri portfolio"
create unique index if not exists property_group_owner_name
  on public.property_group (tenant_id, owner_staff_id, lower(name));

create table if not exists public.property_group_member (
  group_id     uuid not null references public.property_group(id) on delete cascade,
  property_id  uuid not null references public.property(id) on delete cascade,
  added_at     timestamptz not null default now(),
  primary key (group_id, property_id)
);
create index if not exists property_group_member_property on public.property_group_member (property_id);

alter table public.property_group enable row level security;
alter table public.property_group_member enable row level security;

drop policy if exists property_group_owner on public.property_group;
create policy property_group_owner on public.property_group
  for all to authenticated
  using (tenant_id in (select current_tenant_ids()) and owner_staff_id = current_staff_id())
  with check (tenant_id in (select current_tenant_ids()) and owner_staff_id = current_staff_id());

drop policy if exists property_group_member_owner on public.property_group_member;
create policy property_group_member_owner on public.property_group_member
  for all to authenticated
  using (exists (select 1 from public.property_group g
                  where g.id = property_group_member.group_id
                    and g.owner_staff_id = current_staff_id()))
  with check (exists (select 1 from public.property_group g
                       where g.id = property_group_member.group_id
                         and g.owner_staff_id = current_staff_id()));

grant select, insert, update, delete on public.property_group, public.property_group_member to authenticated;

-- 'custom' joins the four existing display types
alter table public.saved_view drop constraint if exists saved_view_display_type_check;
alter table public.saved_view add constraint saved_view_display_type_check
  check (display_type = any (array['dashboard', 'spreadsheet', 'list', 'report', 'custom']));

-- ---------------------------------------------------------------------------
-- Seed: the mockup's "Sioux Falls townhomes overview", for Jay
-- (staff cccf545b-..., jay@leadliconsulting.com). Acceptance: Units 262;
-- Income, Aug + Sep 2026 = $579,376.
-- ---------------------------------------------------------------------------
with g as (
  insert into public.property_group (tenant_id, owner_staff_id, name)
  values ('72381c81-af95-4e1d-ad0d-20a3a3421119', 'cccf545b-7bdd-44f1-9c4b-d43a045f15b5', 'Sioux Falls townhomes')
  on conflict do nothing
  returning id
),
gid as (
  select id from g
  union all
  select id from public.property_group
   where owner_staff_id = 'cccf545b-7bdd-44f1-9c4b-d43a045f15b5' and lower(name) = 'sioux falls townhomes'
  limit 1
),
members as (
  insert into public.property_group_member (group_id, property_id)
  select gid.id, p.id
    from gid
    join public.property p on p.dba_name in ('Bancroft Place Apartments', 'Boulder Pointe Townhomes',
                                             'Cleveland Park Townhomes', 'Town Park Townhomes', 'The Maples Townhomes')
  on conflict do nothing
  returning group_id
)
insert into public.saved_view (tenant_id, owner_staff_id, name, description, dataset_key, display_type, config)
select '72381c81-af95-4e1d-ad0d-20a3a3421119', 'cccf545b-7bdd-44f1-9c4b-d43a045f15b5',
       'Sioux Falls townhomes overview', null, 'property_custom', 'custom',
       jsonb_build_object(
         'mode', 'advanced', 'quickCards', false,
         'groups', jsonb_build_array(gid.id), 'excl', '[]'::jsonb, 'props', null,
         'fields', '["address","units","occ","inc","noi","debt"]'::jsonb,
         'styles', '["chart","table"]'::jsonb, 'chartField', 'inc',
         'cards', '[
           {"id":"c1","label":"Units","kind":"value","field":"units","period":{"t":"ttm"},"agg":"total","size":"S"},
           {"id":"c2","label":"Total operating income, last 12 months","kind":"value","field":"inc","period":{"t":"ttm"},"agg":"total","size":"M"},
           {"id":"c3","label":"Income, Aug + Sep 2026","kind":"formula","fmt":"money","size":"M","terms":[
              {"kind":"field","field":"inc","period":{"t":"month","a":"2026-08"},"agg":"total"},
              {"op":"+","kind":"field","field":"inc","period":{"t":"month","a":"2026-09"},"agg":"total"}]},
           {"id":"c4","label":"NOI per unit","kind":"formula","fmt":"money","size":"S","terms":[
              {"kind":"field","field":"noi","period":{"t":"ttm"},"agg":"total"},
              {"op":"/","kind":"field","field":"units","period":{"t":"ttm"},"agg":"total"}]},
           {"id":"c5","label":"NOI, Sep 2026","kind":"value","field":"noi","period":{"t":"month","a":"2026-09"},"agg":"total","size":"L"}
         ]'::jsonb,
         'layout', '["card:c1","card:c2","card:c3","card:c4","card:c5","chart","table"]'::jsonb)
  from gid
 where not exists (select 1 from public.saved_view v
                    where v.owner_staff_id = 'cccf545b-7bdd-44f1-9c4b-d43a045f15b5'
                      and v.name = 'Sioux Falls townhomes overview' and v.deleted_at is null);
