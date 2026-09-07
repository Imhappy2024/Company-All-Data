-- Folio Excel is missing its `financials` dashboard_module row.
--
-- Every brand now carries a Financials nav item. The item only APPEARS when
-- `dash_my_access()` returns a level for it, and that comes from a
-- dashboard_module catalog row -- so without this insert Folio's item is
-- invisible no matter what MENUS says. Verified 2026-09-07:
--
--   scope                     nav_id=financials
--   ------------------------  -----------------
--   (exec / no company)       present
--   LeavenWealth              present  (sort 100)
--   Leadli AI                 present  (sort  80)
--   Liquid Lending Solutions  present  (sort  70)
--   Folio Excel               MISSING          <-- this file
--
-- Folio never had the item, which is why the row was never seeded. It was
-- found by a portal-nav test asserting that every brand shows the item: Leadli
-- and Liquid passed and Folio did not, and the difference was in the catalog
-- rather than in the code.
--
-- sort 85 puts it between Folio's `tools` (80) and `documents` (90), matching
-- where the other three brands place it.
--
-- ADDITIVE and reversible. A catalog row means "grantable", which is the point
-- here: the row lets an owner hand Folio's Financials screen to someone. It
-- does NOT grant anything by itself -- dashboard_permission still decides who
-- actually has it.
--
-- Note the `access` exception documented in CLAUDE.md does NOT apply: that nav
-- id is deliberately kept OUT of the per-brand catalog because it is
-- role-gated. `financials` is permission-gated like every other screen, so a
-- per-brand row is correct for it.
--
-- migrations/ in this repo is REVIEW-ONLY and is not applied automatically.
-- Apply this in the Supabase SQL editor, then reload the portal.

insert into public.dashboard_module (tenant_id, company_id, module_key, nav_id, label, sort)
select '72381c81-af95-4e1d-ad0d-20a3a3421119'::uuid,
       'c0000000-0000-4000-8000-000000000002'::uuid,   -- Folio Excel
       'financials', 'financials', 'Financials', 85
where not exists (
  select 1 from public.dashboard_module
   where company_id = 'c0000000-0000-4000-8000-000000000002'::uuid
     and nav_id = 'financials'
);

-- Rollback:
-- delete from public.dashboard_module
--  where company_id = 'c0000000-0000-4000-8000-000000000002'::uuid
--    and nav_id = 'financials';
