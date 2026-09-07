-- Folio Excel: rename the `reports` module label to "Financials".
--
-- WHY THIS AND NOT A NEW ROW
--
-- Folio used to carry TWO Financials entries in the portal menu:
--
--     reports      "Reports & Financials"   <- has a dashboard_module row
--     financials   "Financials"             <- has NO dashboard_module row
--
-- Verified live 2026-09-07: `financials` rows exist for exec, LeavenWealth,
-- Leadli AI and Liquid Lending, and NOT for Folio Excel. So only the first of
-- those two could ever appear, and the second was dead markup.
--
-- By instruction there is now exactly one Financials item per brand. Folio's
-- keeps the `reports` NAV ID (the one that can be granted) and takes the
-- "Financials" LABEL. portal.html renders its labels from its own MENUS map,
-- so the nav already reads "Financials" with no migration at all.
--
-- This file exists for the one place that renders the CATALOG label instead:
-- Users & Roles. `portal-users.js` prints `m.label` when listing what can be
-- granted, so without this an admin granting Folio access sees
-- "Reports & Financials" in a list beside a nav that says "Financials" — two
-- names for one screen, on the screen whose whole job is deciding who reaches
-- it.
--
-- Nothing breaks if this is never applied. The nav is correct either way; only
-- the grant list disagrees.
--
-- SUPERSEDES migrations/20260907_folio_financials_module.sql, which added a
-- Folio `financials` row. That row is no longer wanted: Folio's menu has no
-- `financials` entry to reveal, so the row would grant access to nothing. That
-- file was deleted rather than left as a trap.

update public.dashboard_module
   set label = 'Financials'
 where nav_id = 'reports'
   and company_id = 'c0000000-0000-4000-8000-000000000002';

-- Expect: UPDATE 1
--
-- Verify:
--   select nav_id, label from public.dashboard_module
--    where company_id = 'c0000000-0000-4000-8000-000000000002'
--    order by nav_id;
--   -> documents, leads, overview, plans, reports = Financials, subscribers,
--      tasks, team, departments, tools
--
-- Rollback:
-- update public.dashboard_module
--    set label = 'Reports & Financials'
--  where nav_id = 'reports'
--    and company_id = 'c0000000-0000-4000-8000-000000000002';
