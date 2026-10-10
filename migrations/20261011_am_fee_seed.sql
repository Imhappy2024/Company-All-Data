-- ===========================================================================
-- Asset management fee schedule + receipts, seeded  (Phase 2.8)
--
-- REVIEW ONLY until Jay approves the mapping. migrations/ is not auto-applied.
--
-- Every property_id below was resolved by NAME against the live
-- /api/portfolio payload on 2026-10-11 and checked against the property's
-- recorded PM company. 42 fee rows, 43 property links, 42 seeded receipts.
-- The mapping, including the four names that did not match cleanly, is in
-- the PR description - read that before applying this.
--
-- Everything is ON CONFLICT DO NOTHING, so applying it twice is a no-op
-- rather than a duplicate fee row.
-- ===========================================================================

-- schedule rows
insert into public.am_fee_schedule
  (tenant_id, label, manager_group, payment_timing, fee_type, fee_pct, fixed_amount, fee_note, effective_from, sort_order)
values
  ('72381c81-af95-4e1d-ad0d-20a3a3421119', 'BG Champion (Flats + Villa)', 'RPME', 'following_month', 'fixed', null, 8291.67, '1% of equity', date '2026-01-01', 10),
  ('72381c81-af95-4e1d-ad0d-20a3a3421119', 'Doral Apartments', 'RPME', 'following_month', 'pct_gross', 3, null, null, date '2026-01-01', 20),
  ('72381c81-af95-4e1d-ad0d-20a3a3421119', 'Dakota Bend', 'J&M', 'following_month', 'pct_gross', 2, null, null, date '2026-01-01', 30),
  ('72381c81-af95-4e1d-ad0d-20a3a3421119', 'Grandview', 'J&M', 'following_month', 'pct_gross', 2, null, null, date '2026-01-01', 40),
  ('72381c81-af95-4e1d-ad0d-20a3a3421119', 'Indigo Apartments', 'McClain Co.', 'following_month', 'pct_gross', 2, null, 'timing not confirmed', date '2026-01-01', 50),
  ('72381c81-af95-4e1d-ad0d-20a3a3421119', 'Capitol City Villas', 'Arrow', 'following_month', 'pct_gross', 3, null, 'incl. 2520 M (the property address)', date '2026-01-01', 60),
  ('72381c81-af95-4e1d-ad0d-20a3a3421119', 'Lions Gate', 'Kouri', 'following_month', 'pct_gross', 4, null, null, date '2026-01-01', 70),
  ('72381c81-af95-4e1d-ad0d-20a3a3421119', 'Boulder Ridge', 'Kouri', 'following_month', 'pct_gross', 2, null, null, date '2026-01-01', 80),
  ('72381c81-af95-4e1d-ad0d-20a3a3421119', 'Adventureland', 'Kouri', 'following_month', 'pct_gross', 3, null, null, date '2026-01-01', 90),
  ('72381c81-af95-4e1d-ad0d-20a3a3421119', 'Altoona Terrace', 'Kouri', 'following_month', 'pct_gross', 3, null, null, date '2026-01-01', 100),
  ('72381c81-af95-4e1d-ad0d-20a3a3421119', 'Franklin Court', 'Kouri', 'following_month', 'pct_gross', 3, null, null, date '2026-01-01', 110),
  ('72381c81-af95-4e1d-ad0d-20a3a3421119', 'The Whitney', 'Bender / AJ', 'following_month', 'pct_gross', 2, null, 'timing not confirmed', date '2026-01-01', 120),
  ('72381c81-af95-4e1d-ad0d-20a3a3421119', 'Uptown Flats', 'Bender / AJ', 'following_month', 'pct_gross', 2, null, 'timing not confirmed', date '2026-01-01', 130),
  ('72381c81-af95-4e1d-ad0d-20a3a3421119', 'Copperleaf', 'Point Guard NE', 'same_month', 'pct_gross', 2, null, null, date '2026-01-01', 140),
  ('72381c81-af95-4e1d-ad0d-20a3a3421119', 'Langston Loge', 'Point Guard NE', 'same_month', 'pct_gross', 4, null, null, date '2026-01-01', 150),
  ('72381c81-af95-4e1d-ad0d-20a3a3421119', 'Patrick''s Place', 'Point Guard NE', 'same_month', 'pct_gross', 4, null, null, date '2026-01-01', 160),
  ('72381c81-af95-4e1d-ad0d-20a3a3421119', 'Sandra Ann', 'Point Guard NE', 'same_month', 'pct_gross', 2, null, null, date '2026-01-01', 170),
  ('72381c81-af95-4e1d-ad0d-20a3a3421119', 'The Vincent', 'Point Guard NE', 'same_month', 'pct_gross', 2, null, null, date '2026-01-01', 180),
  ('72381c81-af95-4e1d-ad0d-20a3a3421119', 'The Venice (4916 California)', 'Point Guard NE', 'same_month', 'pct_gross', 2, null, '4916 California is the address / entity name', date '2026-01-01', 190),
  ('72381c81-af95-4e1d-ad0d-20a3a3421119', '9447 J Street', 'Point Guard NE', 'same_month', 'pct_gross', 2, null, null, date '2026-01-01', 200),
  ('72381c81-af95-4e1d-ad0d-20a3a3421119', 'Villa Blanca', 'Point Guard NE', 'same_month', 'pct_gross', 2, null, null, date '2026-01-01', 210),
  ('72381c81-af95-4e1d-ad0d-20a3a3421119', 'Carter Place (1003 Ave K)', 'Point Guard NE', 'same_month', 'pct_gross', 2, null, 'two properties share this address - see note', date '2026-01-01', 220),
  ('72381c81-af95-4e1d-ad0d-20a3a3421119', 'The Beverly (Keystone)', 'Point Guard NE', 'same_month', 'pct_gross', 2, null, null, date '2026-01-01', 230),
  ('72381c81-af95-4e1d-ad0d-20a3a3421119', 'The Todd', 'Point Guard NE', 'same_month', 'pct_gross', 2, null, null, date '2026-01-01', 240),
  ('72381c81-af95-4e1d-ad0d-20a3a3421119', 'College Heights', 'Point Guard NE', 'same_month', 'pct_gross', 3, null, null, date '2026-01-01', 250),
  ('72381c81-af95-4e1d-ad0d-20a3a3421119', 'Park Place', 'Point Guard NE', 'same_month', 'pct_gross', 2, null, null, date '2026-01-01', 260),
  ('72381c81-af95-4e1d-ad0d-20a3a3421119', '321 Townhomes (Independence 18)', 'Point Guard NE', 'same_month', 'pct_gross', 2, null, null, date '2026-01-01', 270),
  ('72381c81-af95-4e1d-ad0d-20a3a3421119', 'Tall Oaks', 'Point Guard NE', 'same_month', 'pct_gross', 2, null, null, date '2026-01-01', 280),
  ('72381c81-af95-4e1d-ad0d-20a3a3421119', 'Brent Village', 'Point Guard NE', 'same_month', 'pct_gross', 3, null, null, date '2026-01-01', 290),
  ('72381c81-af95-4e1d-ad0d-20a3a3421119', 'The Cass', 'Point Guard NE', 'same_month', 'pct_gross', 3, null, null, date '2026-01-01', 300),
  ('72381c81-af95-4e1d-ad0d-20a3a3421119', 'The Preserve', 'Point Guard SD', 'same_month', 'pct_gross', 2, null, null, date '2026-01-01', 310),
  ('72381c81-af95-4e1d-ad0d-20a3a3421119', 'Eagle Creek', 'Point Guard SD', 'same_month', 'pct_gross', 4, null, null, date '2026-01-01', 320),
  ('72381c81-af95-4e1d-ad0d-20a3a3421119', 'Maple Park', 'Point Guard SD', 'same_month', 'pct_gross', 2, null, null, date '2026-01-01', 330),
  ('72381c81-af95-4e1d-ad0d-20a3a3421119', 'Bancroft Place', 'Point Guard SD', 'same_month', 'pct_gross', 3, null, null, date '2026-01-01', 340),
  ('72381c81-af95-4e1d-ad0d-20a3a3421119', 'Boulder Pointe', 'Point Guard SD', 'same_month', 'pct_gross', 3, null, null, date '2026-01-01', 350),
  ('72381c81-af95-4e1d-ad0d-20a3a3421119', 'Judee Estates', 'Point Guard SD', 'same_month', 'pct_gross', 3, null, null, date '2026-01-01', 360),
  ('72381c81-af95-4e1d-ad0d-20a3a3421119', '500 S Dakota', 'Point Guard SD', 'same_month', 'pct_gross', 2, null, null, date '2026-01-01', 370),
  ('72381c81-af95-4e1d-ad0d-20a3a3421119', 'Cleveland Park', 'Point Guard SD', 'same_month', 'pct_gross', 4, null, null, date '2026-01-01', 380),
  ('72381c81-af95-4e1d-ad0d-20a3a3421119', 'Town Park', 'Point Guard SD', 'same_month', 'pct_gross', 4, null, null, date '2026-01-01', 390),
  ('72381c81-af95-4e1d-ad0d-20a3a3421119', 'Heston Pointe', 'Point Guard OK', 'same_month', 'pct_gross', 2, null, null, date '2026-01-01', 400),
  ('72381c81-af95-4e1d-ad0d-20a3a3421119', 'Estrella', 'Point Guard TX', 'same_month', 'pct_gross', 0, null, null, date '2026-01-01', 410),
  ('72381c81-af95-4e1d-ad0d-20a3a3421119', 'Sierra Gardens', 'Point Guard TX', 'same_month', 'pct_gross', 0, null, 'PM of record is Cushman & Wakefield, not Point Guard', date '2026-01-01', 420)
on conflict (tenant_id, label) do nothing;

-- property links (property ids verified against /api/portfolio on 2026-10-11)
insert into public.am_fee_schedule_property (schedule_id, property_id)
select s.id, v.property_id from (values
  ('BG Champion (Flats + Villa)', '1a20a0b6-b200-4ad0-82dd-fbefa34a08a8'::uuid)   -- BG Flats,
  ('BG Champion (Flats + Villa)', '67c60e51-3217-45a5-ab76-b2cb7c254f50'::uuid)   -- Champion Villas,
  ('Doral Apartments', 'f3e9a168-e136-4b09-86eb-93be3a83061d'::uuid)   -- Doral Apartments,
  ('Dakota Bend', '98022e92-bfc2-4e0e-9b68-8c44851d488e'::uuid)   -- Dakota Bend,
  ('Grandview', 'bbee8569-8133-4243-85ca-f55c73bca460'::uuid)   -- Grandview Apartments,
  ('Indigo Apartments', '14b1efcf-2903-4b85-b21c-6109bc12c0ec'::uuid)   -- Indigo Apartments,
  ('Capitol City Villas', '989f9eba-b567-4b96-8b23-8ee456cf21b7'::uuid)   -- Capitol City Villas,
  ('Lions Gate', 'ef5351bf-c9cb-427e-adfe-eb012e381fa4'::uuid)   -- Lions Gate Apartments,
  ('Boulder Ridge', '02e611f2-fdb6-4967-8f09-30f50bf54563'::uuid)   -- Boulder Ridge,
  ('Adventureland', '29a1fbc2-f627-4a48-93d1-daaa91ede130'::uuid)   -- Adventureland Village,
  ('Altoona Terrace', 'f2ad17b2-23b2-46c1-a70f-acee68d76d5d'::uuid)   -- Altoona Terrace,
  ('Franklin Court', 'f30ecd20-a1d2-4219-b18c-90355a3a732f'::uuid)   -- Franklin Court,
  ('The Whitney', '79cab8e5-302f-4e4b-af08-8d9bf5ddc32a'::uuid)   -- The Whitney FKA Colonial Court Apartments,
  ('Uptown Flats', 'aec1e772-88e1-4f31-a6aa-43f0dfa56121'::uuid)   -- Uptown Flats FKA Summit at Midtown,
  ('Copperleaf', '7f3e2a54-df42-47a9-91b2-0ffcf830289a'::uuid)   -- Copperleaf Apartments,
  ('Langston Loge', '6eeb1990-3fba-4bce-bd7a-d6d5b7856f19'::uuid)   -- Langston Loge,
  ('Patrick''s Place', '76bc1424-5519-4beb-baed-a1ead62e488d'::uuid)   -- Patrick's Place,
  ('Sandra Ann', '7a8d0538-72d9-41e2-ab83-ac7480e7a547'::uuid)   -- Sandra Ann LLC,
  ('The Vincent', 'a2d960f6-f50a-4f95-b5f9-ba3a99b94a39'::uuid)   -- The Vincent,
  ('The Venice (4916 California)', '52c5f750-a894-4b22-83d4-f0aa3c4ec57a'::uuid)   -- The Venice,
  ('9447 J Street', '3dfa3cf8-b677-46b8-b06c-962ea4519bfc'::uuid)   -- 9447 J Street,
  ('Villa Blanca', 'cf2cdf52-9cf9-43d4-9455-d34584005ce6'::uuid)   -- Villa Blanca,
  ('Carter Place (1003 Ave K)', '2cee5d6a-423b-4fb4-b44e-e4d9f06b7719'::uuid)   -- Carter Place,
  ('The Beverly (Keystone)', '91ce0f2f-f90d-4ef4-b0e4-7382331dcc89'::uuid)   -- The Beverly / Keystone Apartments Wichita,
  ('The Todd', '208784a9-00c6-419b-8ffc-dc5c97e33b80'::uuid)   -- The Todd,
  ('College Heights', 'fd0bf0a7-c983-4123-9802-b46cac4df791'::uuid)   -- College Heights,
  ('Park Place', '42e3faea-00db-4f4a-b554-97c0df3ff139'::uuid)   -- Park Place Apartments,
  ('321 Townhomes (Independence 18)', '4f7b2491-9db7-4ad2-a559-3b7800b14439'::uuid)   -- Independence 18 dba 321 Townhomes,
  ('Tall Oaks', 'ca6528d5-d889-4b5e-8881-40668a729ff5'::uuid)   -- Tall Oaks,
  ('Brent Village', '4442d1aa-b56c-44b7-bd4c-2f07ef801884'::uuid)   -- Brent Village Apartments,
  ('The Cass', '1f2e67d7-5837-412b-99f5-53f4f31f7dc9'::uuid)   -- Sonesta The Cass Apartments,
  ('The Preserve', '9be67812-0c47-46e6-931e-67fe0e7662a3'::uuid)   -- The Preserve,
  ('Eagle Creek', '094c1a21-bccc-49be-9391-d7df03051997'::uuid)   -- Eagle Creek,
  ('Maple Park', 'ddb43299-8254-43fc-baa2-5ff5b83b73e4'::uuid)   -- Maple Park Apartments,
  ('Bancroft Place', '45281306-5b77-4216-b4da-924028ffaa84'::uuid)   -- Bancroft Place Apartments,
  ('Boulder Pointe', '438864cf-8eb3-47b3-924a-990857454b9a'::uuid)   -- Boulder Pointe Townhomes,
  ('Judee Estates', 'ba7f11ac-d0b4-48bc-a5f2-a05f2aa95591'::uuid)   -- Judee Estates,
  ('500 S Dakota', '7718467b-e915-4c91-9f1e-76b16366b78c'::uuid)   -- 500 S Dakota Ave LLC,
  ('Cleveland Park', 'a1d92b66-fde4-4a7b-b689-e347e67c38d9'::uuid)   -- Cleveland Park Townhomes,
  ('Town Park', '2f1344ff-378c-4641-85ff-19931b0d13eb'::uuid)   -- Town Park Townhomes,
  ('Heston Pointe', 'c23ffd3c-f9ca-4838-a1c7-e2f2b58c8785'::uuid)   -- Heston Pointe,
  ('Estrella', '58dc877f-d786-4178-ac77-2cfe91388974'::uuid)   -- Estrella,
  ('Sierra Gardens', '0baca074-ad4e-4fc6-8866-37aed0bdf21e'::uuid)   -- Sierra Gardens
) as v(label, property_id)
join public.am_fee_schedule s on s.label = v.label and s.tenant_id = '72381c81-af95-4e1d-ad0d-20a3a3421119'
on conflict do nothing;

-- seeded receipts, 2026 Jan-Sep
insert into public.am_fee_receipt (tenant_id, schedule_id, fee_month, amount_received, source)
select '72381c81-af95-4e1d-ad0d-20a3a3421119', s.id, v.fee_month, v.amount, 'seed' from (values
  ('BG Champion (Flats + Villa)', date '2026-01-01', 8593.8),
  ('BG Champion (Flats + Villa)', date '2026-02-01', 8245.83),
  ('BG Champion (Flats + Villa)', date '2026-03-01', 8245.83),
  ('BG Champion (Flats + Villa)', date '2026-04-01', 8245.83),
  ('BG Champion (Flats + Villa)', date '2026-05-01', 8245.83),
  ('BG Champion (Flats + Villa)', date '2026-06-01', 8245.83),
  ('BG Champion (Flats + Villa)', date '2026-07-01', 8245.83),
  ('BG Champion (Flats + Villa)', date '2026-08-01', 8245.83),
  ('BG Champion (Flats + Villa)', date '2026-09-01', 8245.83),
  ('Doral Apartments', date '2026-06-01', 1893.61),
  ('Doral Apartments', date '2026-07-01', 2157.43),
  ('Doral Apartments', date '2026-08-01', 2200.93),
  ('Doral Apartments', date '2026-09-01', 1986.38),
  ('Dakota Bend', date '2026-01-01', 925.5),
  ('Dakota Bend', date '2026-02-01', 969.39),
  ('Dakota Bend', date '2026-03-01', 944.01),
  ('Dakota Bend', date '2026-04-01', 937.41),
  ('Dakota Bend', date '2026-05-01', 932),
  ('Dakota Bend', date '2026-06-01', 964.59),
  ('Dakota Bend', date '2026-08-01', 1916.38),
  ('Grandview', date '2026-01-01', 162.08),
  ('Grandview', date '2026-02-01', 197.41),
  ('Grandview', date '2026-03-01', 249.93),
  ('Grandview', date '2026-04-01', 249.93),
  ('Grandview', date '2026-05-01', 199.04),
  ('Grandview', date '2026-06-01', 228.82),
  ('Grandview', date '2026-07-01', 218.15),
  ('Grandview', date '2026-08-01', 218.39),
  ('Indigo Apartments', date '2026-02-01', 261.9),
  ('Indigo Apartments', date '2026-04-01', 439.72),
  ('Indigo Apartments', date '2026-06-01', 465.2),
  ('Indigo Apartments', date '2026-08-01', 420.18),
  ('Indigo Apartments', date '2026-09-01', 217.2),
  ('Capitol City Villas', date '2026-01-01', 1832.33),
  ('Capitol City Villas', date '2026-02-01', 1827.59),
  ('Capitol City Villas', date '2026-03-01', 1876.73),
  ('Capitol City Villas', date '2026-04-01', 1858.08),
  ('Capitol City Villas', date '2026-05-01', 1918.86),
  ('Capitol City Villas', date '2026-06-01', 1885.13),
  ('Capitol City Villas', date '2026-07-01', 1857.76),
  ('Capitol City Villas', date '2026-08-01', 1734.52),
  ('Capitol City Villas', date '2026-09-01', 1845.54)
) as v(label, fee_month, amount)
join public.am_fee_schedule s on s.label = v.label and s.tenant_id = '72381c81-af95-4e1d-ad0d-20a3a3421119'
on conflict (schedule_id, fee_month) do nothing;

-- ---------------------------------------------------------------------------
-- Verify after applying. Expected: 42 / 43 / 42.
-- ---------------------------------------------------------------------------
--   select count(*) from public.am_fee_schedule;           -- 42
--   select count(*) from public.am_fee_schedule_property;  -- 43
--   select count(*) from public.am_fee_receipt;            -- 42
--
-- Every fee row must cover at least one property, or it can never produce an
-- expected figure and would sit in the tracker as a permanently blank line:
--   select s.label from public.am_fee_schedule s
--    where not exists (select 1 from public.am_fee_schedule_property l
--                       where l.schedule_id = s.id);       -- 0 rows
