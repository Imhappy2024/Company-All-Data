-- ===========================================================================
-- Asset management fee tracker  (Phase 2.8)
--
-- Three tables behind the fee tracker: the schedule (who charges what, when),
-- which properties each fee row covers, and what was actually received.
--
-- REVIEW ONLY until Jay approves. migrations/ is not auto-applied.
--
-- Design notes worth keeping:
--
--  * A fee row can cover SEVERAL properties, which is why the link is its own
--    table rather than a column. "BG Champion (Flats + Villa)" is one
--    $8,291.67 fixed fee covering BG Flats and Champion Villas together, so
--    neither property can carry the fee on its own row without double
--    counting it.
--
--  * payment_timing decides WHICH month's income the fee is a percentage of,
--    not when a payment is recorded. 'following_month' means the fee billed
--    in March is 3% of February's gross. Getting this backwards shifts every
--    expected figure by one column and still looks entirely plausible.
--
--  * fee_pct is stored as a WHOLE PERCENT (2 = 2%), unlike loan.interest_rate_pct
--    which CLAUDE.md records as a fraction (0.035 = 3.5%). The two are
--    deliberately different and the check constraint below is what makes a
--    fraction typed in here fail loudly instead of quietly billing 0.02%.
--
--  * effective_from / effective_to let a fee change without destroying the
--    history of what was charged before it. A fee row is never edited in
--    place to a new percentage.
--
--  * am_fee_receipt is unique on (schedule_id, fee_month) so re-running the
--    seed cannot create a second payment for the same month.
-- ===========================================================================

create table if not exists public.am_fee_schedule (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenant(id) on delete cascade,
  label           text not null,
  manager_group   text not null,
  payment_timing  text not null check (payment_timing in ('same_month', 'following_month')),
  fee_type        text not null check (fee_type in ('pct_gross', 'fixed')),
  fee_pct         numeric(6,3) check (fee_pct is null or (fee_pct >= 0 and fee_pct <= 100)),
  fixed_amount    numeric(14,2) check (fixed_amount is null or fixed_amount >= 0),
  fee_note        text,
  effective_from  date not null default date '2026-01-01',
  effective_to    date,
  sort_order      integer not null default 0,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  -- the fee has to be readable off the row: a percentage fee needs a
  -- percentage, a fixed fee needs an amount. Without this a row can say
  -- 'pct_gross' with a null pct and every expected figure it produces is
  -- silently null, which on screen is indistinguishable from "no income data".
  constraint am_fee_schedule_amount_matches_type check (
    (fee_type = 'pct_gross' and fee_pct is not null and fixed_amount is null) or
    (fee_type = 'fixed'     and fixed_amount is not null and fee_pct is null)
  ),
  constraint am_fee_schedule_dates check (effective_to is null or effective_to >= effective_from),
  constraint am_fee_schedule_label_unique unique (tenant_id, label)
);

create table if not exists public.am_fee_schedule_property (
  schedule_id  uuid not null references public.am_fee_schedule(id) on delete cascade,
  property_id  uuid not null references public.property(id) on delete cascade,
  primary key (schedule_id, property_id)
);

create index if not exists am_fee_schedule_property_property_idx
  on public.am_fee_schedule_property (property_id);

create table if not exists public.am_fee_receipt (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references public.tenant(id) on delete cascade,
  schedule_id      uuid not null references public.am_fee_schedule(id) on delete cascade,
  fee_month        date not null,
  amount_received  numeric(14,2) not null,
  source           text not null check (source in ('seed', 'books', 'manual')),
  note             text,
  entered_at       timestamptz not null default now(),

  -- a month is the first of the month, always. Without this, two rows for
  -- "March" that differ only by day of month both survive the unique index.
  constraint am_fee_receipt_month_is_first check (fee_month = date_trunc('month', fee_month)::date),
  constraint am_fee_receipt_one_per_month unique (schedule_id, fee_month)
);

create index if not exists am_fee_receipt_month_idx on public.am_fee_receipt (fee_month);

-- ---------------------------------------------------------------------------
-- RLS. These follow the tenant pattern in CLAUDE.md: read for anyone whose
-- current_tenant_ids() includes the row's tenant, write for admin/editor only.
-- The fee tracker is display-only in this release, but the policies are
-- written now so the table is never briefly readable by everyone.
-- ---------------------------------------------------------------------------
alter table public.am_fee_schedule          enable row level security;
alter table public.am_fee_schedule_property enable row level security;
alter table public.am_fee_receipt           enable row level security;

drop policy if exists am_fee_schedule_read on public.am_fee_schedule;
create policy am_fee_schedule_read on public.am_fee_schedule
  for select to authenticated using (tenant_id = any (current_tenant_ids()));

drop policy if exists am_fee_schedule_write on public.am_fee_schedule;
create policy am_fee_schedule_write on public.am_fee_schedule
  for all to authenticated
  using (tenant_role(tenant_id) in ('admin', 'editor'))
  with check (tenant_role(tenant_id) in ('admin', 'editor'));

-- the link table carries no tenant_id of its own, so it borrows the
-- schedule's. Writing it as an EXISTS against am_fee_schedule means the link
-- can never outlive the visibility of the fee row it belongs to.
drop policy if exists am_fee_schedule_property_read on public.am_fee_schedule_property;
create policy am_fee_schedule_property_read on public.am_fee_schedule_property
  for select to authenticated using (exists (
    select 1 from public.am_fee_schedule s
     where s.id = schedule_id and s.tenant_id = any (current_tenant_ids())));

drop policy if exists am_fee_schedule_property_write on public.am_fee_schedule_property;
create policy am_fee_schedule_property_write on public.am_fee_schedule_property
  for all to authenticated
  using (exists (select 1 from public.am_fee_schedule s
                  where s.id = schedule_id and tenant_role(s.tenant_id) in ('admin', 'editor')))
  with check (exists (select 1 from public.am_fee_schedule s
                  where s.id = schedule_id and tenant_role(s.tenant_id) in ('admin', 'editor')));

drop policy if exists am_fee_receipt_read on public.am_fee_receipt;
create policy am_fee_receipt_read on public.am_fee_receipt
  for select to authenticated using (tenant_id = any (current_tenant_ids()));

drop policy if exists am_fee_receipt_write on public.am_fee_receipt;
create policy am_fee_receipt_write on public.am_fee_receipt
  for all to authenticated
  using (tenant_role(tenant_id) in ('admin', 'editor'))
  with check (tenant_role(tenant_id) in ('admin', 'editor'));

grant select on public.am_fee_schedule, public.am_fee_schedule_property, public.am_fee_receipt
  to authenticated;
