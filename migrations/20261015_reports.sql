-- ===========================================================================
-- Properties > Reports: saved reports, schedules, and a send log
--
-- REVIEW ONLY until Jay approves. migrations/ is not auto-applied.
--
-- A report stores its DEFINITION, never its figures, so opening or sending it
-- always runs on current data:
--
--   config = { reports: { income: bool, rr: bool, opt: bool },
--              incType: 'regular'|'quarter'|'half'|'annual',
--              from: 'YYYY-MM', to: 'YYYY-MM',            -- regular
--              quarter: 'YYYYQn', half: 'YYYYHn', annual: 'YYYY'|'T12',
--              stmt: { is: bool, cf: bool },
--              props: [property id] }
--
-- The server validates every key on save and on load. A schedule carries its
-- own copy of the config (the mockup schedules straight from the builder), and
-- at each send rolls the period forward to the latest completed period of the
-- same type.
--
-- Access: these tables are read and written only by the dashboard server, on
-- its privileged connection, filtered by the signed-in person's verified staff
-- id. No connector role is granted on them and RLS is on with no policy, so
-- nothing reaches them from the browser or from Claude. The report DATA is
-- still read as the person's own connector role (as the person for a manual
-- run, as the owner for a scheduled one), so a report never includes a
-- property the person cannot see. The owner's access is checked again at
-- every scheduled send.
--
-- Additive and reversible. To reverse:
--   drop table public.report_send_log, public.report_schedule, public.report_definition;
-- ===========================================================================

begin;

create table if not exists public.report_definition (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenant(id) on delete cascade,
  owner_staff_id  uuid not null references public.staff(id) on delete cascade,
  name            text not null,
  config          jsonb not null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  deleted_at      timestamptz,
  constraint report_definition_name_not_blank check (length(btrim(name)) > 0),
  constraint report_definition_config_object check (jsonb_typeof(config) = 'object')
);
create index if not exists report_definition_tenant
  on public.report_definition (tenant_id, created_at desc) where deleted_at is null;

create table if not exists public.report_schedule (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenant(id) on delete cascade,
  owner_staff_id  uuid not null references public.staff(id) on delete cascade,
  report_id       uuid references public.report_definition(id) on delete set null,  -- the saved report it came from, if any
  name            text not null,
  config          jsonb not null,
  to_emails       text[] not null,
  cc_emails       text[] not null default '{}',
  bcc_emails      text[] not null default '{}',
  subject         text not null,
  body            text not null default '',
  format          text not null default 'pdf',
  start_date      date not null,                      -- first send, 9:00 AM America/Chicago
  repeat          text not null,
  next_run_at     timestamptz,                         -- null once paused
  active          boolean not null default true,
  last_sent_at    timestamptz,
  last_status     text,                                -- 'sent' | 'failed' | 'skipped'
  last_error      text,
  failure_count   integer not null default 0,          -- consecutive failures
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  deleted_at      timestamptz,
  constraint report_schedule_name_not_blank check (length(btrim(name)) > 0),
  constraint report_schedule_config_object  check (jsonb_typeof(config) = 'object'),
  constraint report_schedule_has_recipient  check (cardinality(to_emails) between 1 and 4),
  constraint report_schedule_cc_limit       check (cardinality(cc_emails) <= 3 and cardinality(bcc_emails) <= 3),
  constraint report_schedule_format         check (format in ('pdf', 'xlsx', 'csv')),
  constraint report_schedule_repeat         check (repeat in ('daily', 'weekly', 'monthly', 'yearly')),
  constraint report_schedule_status         check (last_status is null or last_status in ('sent', 'failed', 'skipped'))
);
-- what the 9:00 AM job reads
create index if not exists report_schedule_due
  on public.report_schedule (next_run_at) where active and deleted_at is null;
create index if not exists report_schedule_tenant
  on public.report_schedule (tenant_id, created_at desc) where deleted_at is null;

-- every send, manual or scheduled, and every failed attempt
create table if not exists public.report_send_log (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenant(id) on delete cascade,
  schedule_id     uuid references public.report_schedule(id) on delete set null,
  sent_by_staff_id uuid references public.staff(id) on delete set null,   -- the person, or the schedule owner
  report_name     text not null,
  period_label    text,
  to_emails       text[] not null,
  cc_emails       text[] not null default '{}',
  bcc_emails      text[] not null default '{}',
  format          text not null,
  property_count  integer,
  status          text not null,
  error           text,
  created_at      timestamptz not null default now(),
  constraint report_send_log_status check (status in ('sent', 'failed', 'skipped'))
);
create index if not exists report_send_log_schedule on public.report_send_log (schedule_id, created_at desc);

-- server-only: RLS on and no policy, so authenticated and anon read nothing
alter table public.report_definition enable row level security;
alter table public.report_schedule   enable row level security;
alter table public.report_send_log   enable row level security;
revoke all on public.report_definition, public.report_schedule, public.report_send_log from anon, authenticated;

commit;
