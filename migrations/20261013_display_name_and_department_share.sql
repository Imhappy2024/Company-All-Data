-- ===========================================================================
-- 1. property.display_name: the short name the screens show. Filled from the
--    approved mockup's DISPLAY map; NULL means "show dba_name". Additive.
-- 2. saved_view_share can name a DEPARTMENT, so a custom view can be shared
--    with a whole department (membership is read from department_member,
--    current members only, at read time).
--
-- Reverse:
--   alter table public.property drop column display_name;
--   delete from public.saved_view_share where principal_type = 'department';
--   restore the two-value principal_type check.
-- ===========================================================================

alter table public.property add column if not exists display_name text;
comment on column public.property.display_name is
  'Short name shown in the portal. NULL = show dba_name. Seeded from the approved Properties mockup.';

update public.property p
   set display_name = m.display_name
  from (values
    ('500 S Dakota Ave LLC',                        '500 S Dakota Ave'),
    ('Fast Ave Properties LLC',                     'Fast Ave Properties'),
    ('Independence 18 dba 321 Townhomes',           '321 Townhomes'),
    ('NB Brothers, LLC',                            'NB Brothers'),
    ('Patrick''s Place',                            'Patrick’s Place'),
    ('Sandra Ann LLC',                              'Sandra Ann'),
    ('Sonesta The Cass Apartments',                 'The Cass'),
    ('The Beverly / Keystone Apartments Wichita',   'The Beverly'),
    ('The Whitney FKA Colonial Court Apartments',   'The Whitney'),
    ('Uptown Flats FKA Summit at Midtown',          'Uptown Flats')
  ) as m(dba_name, display_name)
 where p.dba_name = m.dba_name
   and p.display_name is null;

alter table public.saved_view_share drop constraint if exists saved_view_share_principal_type_check;
alter table public.saved_view_share add constraint saved_view_share_principal_type_check
  check (principal_type = any (array['user', 'role', 'department']));
