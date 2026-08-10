# Migrations

Nothing in this folder runs automatically. Read it, run it in the Supabase SQL
editor, then re-run the security advisor.

| File | What it does | Why |
|---|---|---|
| `20260810_fix_entity_rls.sql` | Re-scopes `entity` RLS to `current_tenant_ids()` | `entity` is the only tenant table without a tenant predicate. Today any authenticated user with a `profiles` row can read every entity in every tenant. |

## Still blocking a real login

The portal reads through the server, so it works today. Browser-side reads
against RLS will not, because these tables are empty:

- `profiles` — 0 rows (populated by the `handle_new_user` trigger on signup)
- `tenant_member` — 0 rows
- `company_member` — 0 rows

Until at least one user exists in all three, `current_tenant_ids()` returns an
empty set and every RLS-filtered query returns zero rows.
