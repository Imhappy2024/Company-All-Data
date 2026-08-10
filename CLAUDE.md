# CLAUDE.md — LeavenWealth Group "Company-All-Data"

Read this fully before doing anything. It is the source of truth for the project.
When you change architecture, update this file in the same commit.

## What this is
An all-company internal portal + dashboards for LeavenWealth Group (one company,
several brands). Two front ends are merged into ONE Express service:

- `/`     → **portal** (`public/portal.html`) — a **sidebar app shell with brand-as-workspace**.
            The workspace switcher (top-left) picks a brand (Executive Board / LeavenWealth / Leadli AI /
            Folio Excel / Liquid Lending); each brand shows only its own nav + accent colour.
            LeavenWealth: Overview, Properties, Loans, Investors, Insurance + workspace core
            (Tasks, Leads, Team, Departments, Tools & Apps, Financials, Documents). Leadli: Leads,
            Appointments, Marketing/Ads. Folio: App Users, Plans, Reports (SaaS). Liquid: Loan
            Pipeline, Borrowers. Clicking a person (Org/Dept charts, Team) opens a profile drawer
            with a bio "See more". Brand maps 1:1 to Supabase `company` / `company_member`.
- `/ops`  → the existing **operations dashboard** (`public/index.html`) — live ClickUp +
            Supabase. Tabs: Overview, All Tasks, Needs Review, For Approval, L10,
            Properties (sub-views: Properties / Property Tasks),
            Loan Views (sub-views: CapEx Funding / Asset Fees / Escrows / TIF / Variable Rate / Maturities).
- `/api/*`→ existing routes (ClickUp + Supabase). Do not break these.

**Portal ↔ ops (interim, during the unify-into-one-app migration):**
- Portal **Properties** nav iframes `/ops#tab=properties&embed=1` (embed mode hides the ops
  header/tabs/filter bar). Property Tasks is intentionally **removed** from the Properties view.
- Portal **Tasks** tab (per brand) is segmented **Overview | All Tasks** (+ **Property Tasks**
  for LeavenWealth only). **All Tasks is NATIVE** — `public/portal-tasks.js` reads `/api/tasks`
  and filters by space in the browser; it is no longer an iframe. See "Portal Tasks + live sync"
  below. Overview still iframes `/ops#tab=overview&embed=1&spaces=<ids>`, and Property Tasks
  still iframes `/ops#tab=properties&sub=tasks&embed=1&bare=1` (`bare=1` hides the property
  sub-nav → board only). `spaces=<id,id,…>` sets the ops `filterState.space` on load (in-memory
  per iframe, never persisted). Brand→space map is `LW_SPACES`/`BRAND_SPACES`/`EXEC_SPACES` in
  portal.html (Leadli=Leadli space; Folio=Folio Excel space; LeavenWealth=the other 10 including
  the Chris Mitch Jay space; Liquid=none yet → empty-state).
- Portal **Loans** tab is segmented **Loan Book | Loan Views**: Loan Book reads `/api/loans`
  natively (Supabase); Loan Views iframes `/ops#tab=loanviews&embed=1` (CapEx Funding / Asset
  Fees / Escrows / TIF / Variable Rate / Maturities). Loan/debt views moved off Properties.
- The ops dashboard reads `#tab=<t>&sub=<s>` on load to deep-link; embed CSS keys off
  `html.embed-only` / `html.embed-bare` (set in `<head>` before render, no flash).
- Portal reads live where possible: **Loans** → `/api/loans` (Supabase); **Marketing/Ads** →
  `meta_ads_insight` via a browser supabase-js client (`window.__sb`, anon key), **session-gated**
  with a baked fallback until portal auth exists. Other cards are baked demo data for now.
- **Roadmap:** port the Properties + Property-Tasks views natively into the portal (reusing the
  same `/api/*`), then retire `/ops` and `public/index.html`. Until then the embeds are the bridge.

## Stack
Node 18+, Express, vanilla HTML/CSS/JS (NO framework, NO build step — keep it that way
unless explicitly told). Postgres via `pg`. Deployed on Railway (nixpacks, `node server.js`).

## Run / deploy
```
npm install
npm start           # http://localhost:3000  (portal at /, ops at /ops)
```
Railway: push to the repo connected to the service; it runs `npm install` then `node server.js`.
`railway.json` already sets the start command. No build step.

## Environment variables (set in .env locally and Railway — NEVER commit secrets)
Ops dashboard (already in use):
- `SUPABASE_DB_URL`  postgresql://postgres:PASSWORD@db.lhdpzalqrwepfjoicdiz.supabase.co:5432/postgres
- `DATA_SOURCE=supabase`  (makes Properties/loans/tasks read from Supabase)
- `CLICKUP_API_TOKEN`, `CLICKUP_TEAM_ID`, `CLICKUP_LIST_ID`, `CLICKUP_ALLOWED_USERS`
- `CLICKUP_OAUTH_CLIENT_ID`, `CLICKUP_OAUTH_CLIENT_SECRET`
- `PORT` (Railway injects this)
Portal live-data + auth (to be added):
- `SUPABASE_URL=https://lhdpzalqrwepfjoicdiz.supabase.co`
- `SUPABASE_ANON_KEY` (publishable key — safe for the browser, RLS enforces access)
- `SUPABASE_SERVICE_ROLE` (server-side ONLY, never sent to the browser)

## Supabase project
- Project ref: `lhdpzalqrwepfjoicdiz`  URL: `https://lhdpzalqrwepfjoicdiz.supabase.co`
- Single tenant. `tenant_id = 72381c81-af95-4e1d-ad0d-20a3a3421119`
- Brand layer = `company` table (4 brands, fixed UUIDs):
  - Leadli AI    `c0000000-0000-4000-8000-000000000001`  (entity 8bd3c562-1feb-4e85-b363-bc21aebff616)
  - Folio Excel  `c0000000-0000-4000-8000-000000000002`  (entity 32bec21a-b52f-49db-93fb-fea5a594b480)
  - LeavenWealth `c0000000-0000-4000-8000-000000000003`  (entity b30689f0-4d3c-4189-bd4a-f89c74008a94)
  - Liquid Lending `c0000000-0000-4000-8000-000000000004`
- Lead providers (`lead_provider`, Leadli only): Closers.io `a1000000-...-001`,
  AIA `a1000000-...-002`, Organic `a1000000-...-003`.

## Data model (public schema)
Core (pre-existing): tenant, tenant_member(tenant_id,user_id,role), entity(+company_id),
property, unit, loan, loan_balance, loan_collateral, property_financials, insurance_policy,
ownership, vendor, staff(+avatar_url,+description), profiles(+avatar_url,+description),
contact, deal, communication, task, document, integrations, investor, investor_stake.

Added for this project:
- `company`, `company_member(company_id,user_id,role)` — per-brand access grants.
- `financial_account`(+account_type), `account_balance`.
- `transaction_category`, `transaction` — single-entry ledger (direction in/out/transfer).
- `statement` — bank / credit_card / loan / pm_income_expense report headers.
- `meta_ads_insight`, `leadli_marketing_daily` — Meta ads (populated by n8n).
- `lead`(+provider_id,+company_id), `lead_provider`, `appointment`.
- `loan`(+`purpose`) — purpose ∈ primary_mortgage / construction_note /
  primary_plus_construction_note / seller_carry / pace_equity / bridge / pac_due
  (seniority is the separate `position` column). **`loan.interest_rate_pct` is a decimal
  FRACTION** (0.035 = 3.50%) — multiply by 100 to display.
- Read-only loan/debt SQL views served via `/api/views/:key` (grants: `authenticated`):
  `v_capex_funding` (capex), `v_asset_management_fees` (asset-fees), `v_escrows` (escrows),
  `v_tif_properties` (tif), `v_variable_rate_loans` (variable-rate), `v_loan_maturities`
  (maturities). All expose `property_name` + `management_company` (the PM filter). All six
  are surfaced in the ops **Loan Views** tab.

## Security model (RLS) — DO NOT WEAKEN
- All tenant tables: RLS on, `authenticated` role, filtered by `current_tenant_ids()`;
  writes gated by `tenant_role(tenant_id) in ('admin','editor')`.
- Brand tables (lead, appointment, meta_ads_insight, leadli_marketing_daily, lead_provider):
  filtered by `current_company_ids()` with a null-company fallback to tenant scope;
  writes gated by `company_role(company_id)`.
- Helper fns: `current_tenant_ids()`, `tenant_role(uuid)`, `current_company_ids()`,
  `company_role(uuid)`. Access rule: a tenant **admin** implicitly sees ALL brands;
  everyone else sees only brands they have a `company_member` row for.
- `anon` role has NO read access. Browser reads require a real Supabase Auth session
  (authenticated JWT) whose user has a `tenant_member` (and optionally `company_member`) row.
- n8n and server-side scripts write with the **service role**, which bypasses RLS. Never
  expose the service role to the browser.
- Migrations must be ADDITIVE and reversible. Never drop/alter a policy without replacing it.
  After any schema change, run the Supabase security advisor and fix new findings.
- `appointment` has a trigger that auto-creates a minimal `lead` if none matches
  `ghl_contact_id`; the later full contact upsert enriches that row. Don't remove it.

## n8n (leavenwealth.app.n8n.cloud) — context, usually edited elsewhere
- "New GHL Contact to Database": webhook → Normalize (Code) → Upsert Lead (PostgREST upsert
  on ghl_contact_id) → Has Appointment? → Upsert Appointment. Resolves brand from
  `body.location.name`, provider from tags. Writes with the Supabase service key.
- "Leadli FB ads to Spreadsheet Data": has a branch writing to meta_ads_insight +
  leadli_marketing_daily alongside Google Sheets.
- If you touch these, keep changes additive (parallel branches, continue-on-fail).

## Conventions
- No framework, no bundler. One self-contained HTML file per surface.
- **Design system: `public/tokens.css`** — the shared palette, geometry and dark theme,
  loaded by BOTH `/` (portal.html) and `/ops` (index.html) so the two surfaces read as one
  product. Theme via `data-theme` on `<html>` (ops also honours `body.dark-mode`). Use the
  token names (`--bg`, `--panel`, `--accent`, `--radius`, `--shadow`, series `--s1..s4`,
  status `--good/--warn/--crit`, etc.); tokens.css has a shim block mapping the old names.
  Don't re-add hard-coded colour blocks in the HTML files. (`migrations/` = review-only SQL,
  not auto-applied.)
- Money via the `money()`/`moneyk()` helpers; dates ISO in DB.
- Keep the portal cards mapped to the 5 sections above; don't silently re-add a flat grid.
- Prefer real Supabase reads over baked demo data once auth exists; until then, baked demo
  data in portal.html mirrors the seeded rows.

## Portal Tasks + live sync (added 2026-08-10)

**Per-brand Tasks is native, not an iframe.** `public/portal-tasks.js` reads
`GET /api/tasks` and filters to the brand's ClickUp spaces in the browser. Four
counter cards (Total Open / Overdue / Due This Week / Completed); clicking one
swaps the list below it in place. There is no space filter, because the brand is
already the scope. `public/portal-auth.js` owns ClickUp sign-in state and gates
**only** the Tasks screens, never the whole app.

Still `/ops` iframes: Tasks > Overview, Property Tasks, Loans > Loan Views, and
Executive Board > All Tasks. That last one *is* the ClickUp dashboard, which is
what it is meant to show.

### Counter semantics - do not let these drift apart
One definition of done (`canonical_status === 'Completed'`) and one time boundary
(start of today) across all four cards, so no two can disagree about the same
task. A task due earlier **today** is Due This Week, never Overdue. `/ops` has an
older inconsistency here (`isOverdue` uses a different done-test and an instant
comparison) - do not copy it back.

"Open" is `not Completed`, matching `/ops`. Two raw statuses in live use,
`not reporting` and `quarterly recurring`, are now mapped to Long Term in
`data/status-mappings.json`; before that they resolved to To Do via ClickUp's
`status.type = open` and inflated every open figure. They still count as open. If
that reads too high against real data, the single lever is `NOT_OPEN` at the top
of `portal-tasks.js` - but adding `'Long Term'` there makes the portal and `/ops`
disagree about the same task, so treat it as a decision, not a tweak.

### ClickUp space map
`LW_SPACES` (10) is LeavenWealth, **including** the personal "Chris Mitch Jay"
space by explicit decision. `EXEC_SPACES` (12) is the whole workspace. Leadli and
Folio Excel are excluded from the LeavenWealth brand view. This supersedes the
original build brief, which said 11 spaces with the personal space hidden
everywhere - that is out of date, do not revert to it.

### Live sync
Postgres trigger -> `POST /api/hooks/supabase` -> SSE on `/api/events` ->
`public/portal-realtime.js` refreshes the affected view.

The event carries **table names only**, never row data: RLS decides what a user
may read and this channel does not know who is listening. The hub in `realtime.js`
is in-memory and single-process - if this ever runs on more than one instance,
only the instance receiving the webhook would broadcast, so move it to Postgres
`LISTEN`/`NOTIFY` rather than trying to make the in-memory version work.

`TABLE_VIEWS` in `portal-realtime.js` maps tables to views. Keep it in sync with
the queries each view runs: a missing entry is a silently stale screen, a wrong
one is a pointless refetch. On **any** reconnect every view is marked dirty,
because the stream has no replay buffer and the client cannot know what it missed
while disconnected.

`POST /api/hooks/supabase` **fails closed**: 503 while `SUPABASE_WEBHOOK_SECRET`
is unset, 401 on a bad secret, compared with a timing-safe hash. An earlier
version of this layer compared with `!==` against an unset env var, which made
`undefined !== undefined` false and accepted anything. Do not reintroduce that.

`migrations/20260810_supabase_webhooks.sql` is written but **must be applied in
order**: deploy the server with the secret set and confirm
`GET /api/events/health` reports `secretConfigured: true` first, otherwise every
trigger POSTs into a 404.

### New routes and variables
`/api/org/summary`, `/api/events`, `/api/events/health`, `/api/hooks/supabase`.
New env var `SUPABASE_WEBHOOK_SECRET` (plus optional `SSE_*` tuning).

`/auth/callback` now honours a `state` return path via `safeReturnPath()` in
`server.js`, so signing in from the portal returns you to the portal instead of
`/ops`. That function is a security boundary - an unvalidated value there is an
open redirect. It does not affect the registered `redirect_uri`.

### Embed theme - do not undo this
Do **not** re-add an unguarded `html.embed-only body` palette to
`public/index.html`. It ties on specificity with the dark tokens in `tokens.css`
and loads later, so it wins and turns every embed white. The guard is
`:not(.embed-dark)`.

### Tests
    npm install --no-save playwright express
    node test/run-tests.js       # task counters, membership, click-to-filter, nesting, themes
    node test/test-realtime.js   # secret handling, coalescing, keepalive, client caps

`test/expected.json` is written by hand from each fixture's stated intent, not
derived from the code under test. Keep it that way, or the tests lose the ability
to fail.

## Still baked - the biggest remaining inaccuracy
`V.overview()` in `public/portal.html` still hard-codes the LeavenWealth KPIs:
66 properties, 92% occupancy, $72K NOI, $2.04M debt across 3 loans. Three of
those are wrong. The database has **75 loans totalling roughly $106.5M**, and
occupancy is not derivable at all: `unit.occupancy` is free text and empty on all
224 rows, with no lease or tenant table. Investors, Financials, Leads and
Appointments are baked too. Replacing them with live reads (or honest empty
states) is the next real piece of work.

## Current state (done)
- Schema + brand layer + RLS + seed data all live in Supabase.
- Ops dashboard is live (ClickUp+Supabase). Portal built with the 5-section layout.
- Merged into one service; portal at `/`, ops at `/ops`; Properties card embeds ops.
- Portal Tasks (per brand) is native and live; Overview/Property Tasks/Loan Views stay embeds.
- Live sync built (realtime.js + portal-realtime.js); the Supabase migration is NOT yet applied.
- Portal Overview/Investors/Financials/Leads/Appointments cards are STILL baked demo data.

## Roadmap (typical next tasks — confirm scope before large changes)
1. Add Supabase Auth (email magic-link or password) to the portal; gate `/` behind login.
2. Add a thin server API (or use supabase-js in the browser with anon key + RLS) so the
   portal's Exec/Financials/Leads/Ads/Appointments/Loans cards read LIVE from Supabase.
3. Replace the baked Overview KPIs (see "Still baked" above) - this is the top item.
   Property financial reports from `statement`+`property_financials`.
4. Build the Investor portal and Client (upload) portal against real tables + Supabase Storage.
5. Respect brand filter end-to-end (pass company_id into queries).

## Guardrails
- Never commit secrets. `.env` is gitignored; use Railway variables in prod.
- Never send the service role key to the browser.
- Test locally (`npm start`) before pushing. Don't break `/api/*` or `/ops`.
- Ask before: destructive migrations, changing auth, or adding a build step/framework.
