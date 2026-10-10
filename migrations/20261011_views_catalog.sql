-- ===========================================================================
-- Catalog rows for the Views nav item (Phase 3.4)
--
-- A nav item only appears when dash_my_access() returns a level for it, which
-- comes from a dashboard_module row. CLAUDE.md states the rule plainly: add a
-- nav item, add its catalog row. Folio's Financials entry is the standing
-- proof of what happens otherwise - its menu pointed at an id with no row, so
-- the screen could never appear for anyone, owner included.
--
-- TWO rows: Executive Board (company_id is null) and LeavenWealth, which are
-- the two menus the item was added to. A view is built against a curated
-- dataset rather than a brand, so this is deliberately NOT seeded for every
-- company - a catalog row means grantable, and there is no reason yet to let
-- Leadli or Folio grant a screen that reads LeavenWealth's property datasets.
-- Add a row the day a brand's own datasets land, not before.
-- ===========================================================================

insert into public.dashboard_module (tenant_id, company_id, module_key, nav_id, label, sort)
select t.tenant_id, t.company_id, 'views', 'views', 'Views', t.sort
from (values
  ('72381c81-af95-4e1d-ad0d-20a3a3421119'::uuid, null::uuid,                                    70),
  ('72381c81-af95-4e1d-ad0d-20a3a3421119'::uuid, 'c0000000-0000-4000-8000-000000000003'::uuid,  70)
) as t(tenant_id, company_id, sort)
where not exists (
  select 1 from public.dashboard_module m
   where m.tenant_id = t.tenant_id
     and m.nav_id = 'views'
     and m.company_id is not distinct from t.company_id
);

-- `is not distinct from` rather than `=`, because company_id is NULL for the
-- Executive Board row and `null = null` is null, not true - so a plain `=`
-- would never match it and the row would be inserted again on every run.

-- verify: 2 rows
--   select nav_id, label, company_id from public.dashboard_module where nav_id = 'views';
