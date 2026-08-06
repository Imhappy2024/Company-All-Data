# CLAUDE.md — LeavenWealth Group "Company-All-Data"

Read this fully before doing anything. It is the source of truth for the project.
When you change architecture, update this file in the same commit.

## What this is
An all-company internal portal + dashboards for LeavenWealth Group (one company,
several brands). Two front ends are merged into ONE Express service:

- `/`     → **portal** (`public/portal.html`) — a **sidebar app shell with brand-as-workspace**.
            The workspace switcher (top-left) picks a brand (All Brands / LeavenWealth / Leadli AI /
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
- Portal **Tasks** tab hosts **Property Tasks** (segmented: Tasks | Property Tasks), which iframes
  `/ops#tab=properties&sub=tasks&embed=1&bare=1` (`bare=1` also hides the property sub-nav → board only).
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
- Match the existing design tokens (CSS variables in portal.html `:root` / `[data-theme=light]`).
- Money via the `money()`/`moneyk()` helpers; dates ISO in DB.
- Keep the portal cards mapped to the 5 sections above; don't silently re-add a flat grid.
- Prefer real Supabase reads over baked demo data once auth exists; until then, baked demo
  data in portal.html mirrors the seeded rows.

## Current state (done)
- Schema + brand layer + RLS + seed data all live in Supabase.
- Ops dashboard is live (ClickUp+Supabase). Portal built with the 5-section layout.
- Merged into one service; portal at `/`, ops at `/ops`; Properties card embeds ops.
- Portal non-Properties cards use baked demo data (mirrors seed).

## Roadmap (typical next tasks — confirm scope before large changes)
1. Add Supabase Auth (email magic-link or password) to the portal; gate `/` behind login.
2. Add a thin server API (or use supabase-js in the browser with anon key + RLS) so the
   portal's Exec/Financials/Leads/Ads/Appointments/Loans cards read LIVE from Supabase.
3. Wire Loans card to `/api/loans` (ops) or a Supabase read; Marketing/Ads to
   `meta_ads_insight`; Property financial reports to `statement`+`property_financials`.
4. Build the Investor portal and Client (upload) portal against real tables + Supabase Storage.
5. Respect brand filter end-to-end (pass company_id into queries).

## Guardrails
- Never commit secrets. `.env` is gitignored; use Railway variables in prod.
- Never send the service role key to the browser.
- Test locally (`npm start`) before pushing. Don't break `/api/*` or `/ops`.
- Ask before: destructive migrations, changing auth, or adding a build step/framework.
