-- ===========================================================================
-- Columns required by the two-way ClickUp <-> Supabase task sync.
-- Run once against your Supabase Postgres (Dashboard > SQL editor, or psql).
-- Safe to re-run (IF NOT EXISTS).
-- ===========================================================================

-- Lets the sync resolve a ClickUp "Property" relationship target (a ClickUp task
-- id) to the migrated Supabase property/unit row. Backfill via the migration:
--   python leavenwealth_migration.py --relink        (best-effort, by name)
--   python leavenwealth_migration.py --reset         (clean reload WITH ids)
alter table public.property add column if not exists clickup_task_id text;
alter table public.unit     add column if not exists clickup_task_id text;
create index if not exists property_clickup_task_id_idx on public.property (clickup_task_id);
create index if not exists unit_clickup_task_id_idx     on public.unit (clickup_task_id);

-- The public.task table is expected to already exist (per the spec). For reference,
-- the shape the sync relies on:
--
-- create table if not exists public.task (
--   id uuid primary key default gen_random_uuid(),
--   clickup_task_id text unique,
--   clickup_list_id text,
--   name text not null,
--   description text,
--   status text,
--   category text,
--   priority text,
--   assignees jsonb default '[]'::jsonb,
--   start_date timestamptz,
--   due_date timestamptz,
--   date_closed timestamptz,
--   property_id uuid references public.property(id) on delete set null,
--   unit_id uuid references public.unit(id) on delete set null,
--   loan_id uuid references public.loan(id) on delete set null,
--   sync_state text default 'pending',     -- 'pending' | 'synced' | 'error'
--   last_synced_at timestamptz,
--   created_at timestamptz default now(),
--   updated_at timestamptz default now(),
--   created_by text,
--   updated_by text
-- );
--
-- NOTE on updated_at: the reconcile pass anchors conflict detection on
-- last_synced_at (a side "changed" only if its timestamp is newer than the last
-- successful sync), so a BEFORE UPDATE trigger that forces updated_at = now() is
-- compatible and will not cause sync ping-pong.
