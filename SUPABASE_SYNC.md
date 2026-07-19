# Supabase data source (Properties) + two-way task sync

When `DATA_SOURCE=supabase` is set, the **entire Properties view runs from Supabase**:

- **Properties / entities / loans / insurance** → read **and written** to Supabase
  (the source of truth; ClickUp no longer feeds this data).
- **Property Tasks** → stored in Supabase **and kept in two-way sync with ClickUp**
  (last-write-wins), because the team works tasks in ClickUp.

When the flag is unset (default) nothing changes — everything reads/writes ClickUp
directly exactly as before, and the `pg` driver is never even loaded.

| Endpoint | flag OFF (default) | flag ON (`DATA_SOURCE=supabase`) |
|---|---|---|
| `GET /api/properties`, `/api/loans` | ClickUp walk | Supabase |
| `POST .../entity`, `.../property`, `.../building`, `.../loan` | ClickUp | Supabase |
| `PATCH .../field/:id` (inline edit) | ClickUp | Supabase |
| `GET/POST /api/property-tasks` | ClickUp | Supabase (+ ClickUp sync) |
| `POST /api/property-tasks/sync` | n/a | reconcile ClickUp ⇄ Supabase |

## 1. One-time database setup
Run `supabase_task_sync.sql` against your Supabase Postgres (Dashboard → SQL editor):
it adds `clickup_task_id` to `property` and `unit` (the `task` table already exists).

Then backfill the ClickUp ids onto the migrated property/unit rows so tasks can be
linked to a Supabase property/unit:

```bash
pip install requests psycopg2-binary
export CLICKUP_API_TOKEN="pk_..."
export SUPABASE_DB_URL="postgresql://postgres:PASSWORD@db.<ref>.supabase.co:5432/postgres"

python leavenwealth_migration.py --relink     # backfill ids on existing rows (by name)
# OR, for a clean reload that stores ids on insert:
python leavenwealth_migration.py --reset
```

`--relink` is best-effort (matches by name); `--reset` is the reliable path if you
can reload (it truncates the data tables — only do this before real tasks exist).

## 2. Server env vars (Railway → Variables)
| Variable | Required | Purpose |
|---|---|---|
| `DATA_SOURCE` | yes (`supabase`) | turns the sync on; anything else = ClickUp-direct |
| `SUPABASE_DB_URL` | yes | Postgres URI (Project Settings → Database → Connection string → URI) |
| `CLICKUP_API_TOKEN` | yes | already set; the **scheduled/background sync** uses it (no logged-in user at boot/midnight) |

Dashboard-originated creates/edits use the **logged-in user's** token (so ClickUp
attributes them correctly); the scheduled background sync uses the server
`CLICKUP_API_TOKEN`.

## 3. How it works
- **Read** (`GET /api/property-tasks`) → served from Supabase `task` (joined to
  property/unit for display names), same payload shape the Kanban already consumes,
  plus a per-task `sync_state`.
- **Create** (`POST /api/property-tasks`) → requires a parent (the chosen
  property/building); inserts into Supabase (`sync_state='pending'`) then immediately
  pushes to ClickUp (stores `clickup_task_id`, flips to `synced`); stays `pending`
  if the push fails, to be retried by the next sync.
- **Reconcile** (`POST /api/property-tasks/sync`, the "Sync tasks" button, and the
  midnight-CT schedule + on boot):
  1. ClickUp-only tasks → inserted into Supabase (Property relationship resolved to a
     property/unit FK via `clickup_task_id`).
  2. Supabase-only (`clickup_task_id` null) → created in ClickUp.
  3. In both → **last-write-wins**: a side counts as "changed" only if its timestamp
     is newer than `last_synced_at` (this anchor prevents ping-pong); the newer of
     ClickUp `date_updated` / Supabase `updated_at` wins and is applied to the other.
  - Deletions are out of scope for v1 (logged, not auto-applied).
- The board shows a small **pending / error** badge per task from `sync_state`.

## 4. Verification
Open **`GET /api/_selfcheck`** on the live app (DATA_SOURCE=supabase). It returns row
counts per table and each check as pass/fail, including:
`count_entity_eq_64`, `count_property_eq_70`, `count_unit_eq_223`, `count_loan_eq_57`,
`no_orphan_properties`, `property_clickup_task_id_backfilled`.

Then walk the interactive checks:
- [ ] Properties list shows **64 entities** flat; each entity shows its own properties
      (70 total); detail popup renders property fields + **full** Loan Data + Buildings.
- [ ] Add entity / property / building / loan use **in-app modals** (no native dialogs);
      parent is required; property + loan **create-then-open**.
- [ ] Inline-edit a property field → persists to Supabase (re-open shows the new value).
- [ ] Loan "Current Debt" entered on add-loan is written as a **loan_balance** row
      (as_of_date = today), not a loan column.
- [ ] Messages: post a comment → row in `property_comment` (property_id set); reload shows it.
- [ ] Create a task in the dashboard (parent required) → appears in ClickUp with the
      Property relationship + Category; `clickup_task_id` stored; `sync_state=synced`.
- [ ] Create a task in ClickUp → after a sync it appears in the dashboard, linked to
      the right property/unit. Edit on both sides between syncs → newer timestamp wins.
- [ ] `sync_state` shows `pending` before a push and `synced` after; failures show `error`.

## Properties view in Supabase mode — notes
- Reads assemble the same payload shape the front-end already uses, so the entity
  list + detail popup render unchanged. Column names follow `leavenwealth_migration.py`;
  if your schema renamed a column, update the maps in `supabase-properties.js`.
- Inline field edits write straight to Supabase (no ClickUp round-trip). "Loan Status"
  edits update the property's collateralized loan(s).
- "Current Debt" is computed from the latest `loan_balance` per loan; "Market value",
  units, etc. come from the `property` columns.
- **Property comments** (the Messages box) are ClickUp-task-only and are disabled in
  Supabase mode (properties aren't ClickUp tasks). Tell me if you want a Supabase
  comments table wired in.

## Rollback
Unset `DATA_SOURCE` (or set it to `clickup`) and redeploy — the whole Properties view
instantly returns to reading/writing ClickUp directly. No data is lost; the Supabase
rows remain for the next time it's enabled.
