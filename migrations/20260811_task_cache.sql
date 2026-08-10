-- ===========================================================================
-- 20260811_task_cache.sql
--
-- Snapshot of the /api/tasks payload, so a restart or deploy does not force the
-- next visitor to wait out a cold ClickUp workspace walk (tens of seconds).
--
-- Additive and reversible. The server treats this table as entirely optional:
-- if it is absent, persistTasksCache()/restoreTasksCache() log one warning and
-- everything behaves as it did before. So applying this is a performance fix,
-- never a correctness dependency.
--
-- Single row, id = 1. This is a cache, not history - there is nothing to keep.
-- ===========================================================================

create table if not exists public.clickup_task_cache (
  id          smallint primary key default 1,
  payload     jsonb       not null,
  fetched_at  timestamptz not null default now(),
  -- Pin it to exactly one row: an upsert on id=1 can never silently grow this.
  constraint clickup_task_cache_single_row check (id = 1)
);

comment on table public.clickup_task_cache is
  'Single-row snapshot of the ClickUp /api/tasks payload, to avoid cold-start workspace walks. Written by the server with the service role; not user data.';

-- ---------------------------------------------------------------------------
-- RLS. This holds ClickUp task data for the whole workspace, so it follows the
-- project rule: RLS on, anon gets nothing. There is deliberately NO policy for
-- `authenticated` either - nothing in the browser reads this table, only the
-- server via SUPABASE_DB_URL (which bypasses RLS). Enabling RLS with no policy
-- is therefore the correct, tightest setting, not an oversight.
-- ---------------------------------------------------------------------------
alter table public.clickup_task_cache enable row level security;

revoke all on public.clickup_task_cache from anon;
revoke all on public.clickup_task_cache from authenticated;

-- ---------------------------------------------------------------------------
-- Rollback
--   drop table if exists public.clickup_task_cache;
-- Safe at any time: the server degrades to its previous cold-start behaviour.
-- ---------------------------------------------------------------------------
