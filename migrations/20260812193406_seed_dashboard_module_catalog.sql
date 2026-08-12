-- Module lists come from Jay's Users & Roles mockup, which is authoritative for
-- WHICH modules each business has. Every brand also gets 'overview', which the
-- mockup omits but every brand menu starts with.
--
-- nav_id is the id public/portal.html uses in MENUS. Three are known to differ from
-- the natural module_key: marketing->ads, app_users->subscribers,
-- loan_pipeline->pipeline. The rest are set equal to module_key and MUST be
-- verified against MENUS. A wrong nav_id makes that menu item invisible to
-- everyone except owners.
--
-- ROLLBACK: delete from public.dashboard_module;

with t as (select id from public.tenant limit 1),
     c as (select id, name from public.company),
     seed(company_name, module_key, nav_id, label, sort) as (values
  -- Executive Board: company_id NULL
  (null,                        'executive',   'exec',         'Executive',          10),
  (null,                        'orgdept',     'orgdept',      'Org & Departments',  20),
  (null,                        'team',        'team',         'Team directory',     30),
  (null,                        'alltasks',    'alltasks',     'All Tasks',          40),
  (null,                        'financials',  'financials',   'Financials',         50),
  (null,                        'investors',   'investors',    'Investors',          60),
  (null,                        'integrations','integrations', 'Integrations',       70),
  (null,                        'access',      'access',       'Users & Roles',      80),

  ('LeavenWealth','overview',    'overview',    'Overview',           5),
  ('LeavenWealth','properties',  'properties',  'Properties',        10),
  ('LeavenWealth','loans',       'loans',       'Loans',             20),
  ('LeavenWealth','investors',   'investors',   'Investors',         30),
  ('LeavenWealth','insurance',   'insurance',   'Insurance / Risk',  40),
  ('LeavenWealth','tasks',       'tasks',       'Tasks',             50),
  ('LeavenWealth','leads',       'leads',       'Leads',             60),
  ('LeavenWealth','team',        'team',        'Team',              70),
  ('LeavenWealth','departments', 'departments', 'Departments',       80),
  ('LeavenWealth','tools',       'tools',       'Tools & Apps',      90),
  ('LeavenWealth','financials',  'financials',  'Financials',       100),
  ('LeavenWealth','documents',   'documents',   'Documents',        110),

  ('Leadli AI','overview',    'overview',    'Overview',        5),
  ('Leadli AI','leads',       'leads',       'Leads',          10),
  ('Leadli AI','appointments','appointments','Appointments',   20),
  ('Leadli AI','marketing',   'ads',         'Marketing / Ads',30),
  ('Leadli AI','tasks',       'tasks',       'Tasks',          40),
  ('Leadli AI','team',        'team',        'Team',           50),
  ('Leadli AI','departments', 'departments', 'Departments',    60),
  ('Leadli AI','tools',       'tools',       'Tools & Apps',   70),
  ('Leadli AI','financials',  'financials',  'Financials',     80),
  ('Leadli AI','documents',   'documents',   'Documents',      90),

  ('Folio Excel','overview',   'overview',    'Overview',              5),
  ('Folio Excel','app_users',  'subscribers', 'App Users',            10),
  ('Folio Excel','plans',      'plans',       'Plans & Pricing',      20),
  ('Folio Excel','reports',    'reports',     'Reports & Financials', 30),
  ('Folio Excel','tasks',      'tasks',       'Tasks',                40),
  ('Folio Excel','leads',      'leads',       'Leads',                50),
  ('Folio Excel','team',       'team',        'Team',                 60),
  ('Folio Excel','departments','departments', 'Departments',          70),
  ('Folio Excel','tools',      'tools',       'Tools & Apps',         80),
  ('Folio Excel','documents',  'documents',   'Documents',            90),

  ('Liquid Lending Solutions','overview',     'overview',  'Overview',           5),
  ('Liquid Lending Solutions','loan_pipeline','pipeline',  'Loan Pipeline',     10),
  ('Liquid Lending Solutions','borrowers',    'borrowers', 'Borrowers / Apps',  20),
  ('Liquid Lending Solutions','tasks',        'tasks',     'Tasks',             30),
  ('Liquid Lending Solutions','leads',        'leads',     'Leads',             40),
  ('Liquid Lending Solutions','team',         'team',      'Team',              50),
  ('Liquid Lending Solutions','tools',        'tools',     'Tools & Apps',      60),
  ('Liquid Lending Solutions','financials',   'financials','Financials',        70),
  ('Liquid Lending Solutions','documents',    'documents', 'Documents',         80)
)
insert into public.dashboard_module (tenant_id, company_id, module_key, nav_id, label, sort)
select t.id, c.id, s.module_key, s.nav_id, s.label, s.sort
from seed s
cross join t
left join c on c.name = s.company_name
where s.company_name is null or c.id is not null
on conflict do nothing;
