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
- `CLICKUP_API_TOKEN`, `CLICKUP_TEAM_ID`, `CLICKUP_LIST_ID`
- `CLICKUP_OAUTH_CLIENT_ID`, `CLICKUP_OAUTH_CLIENT_SECRET`
- `CLICKUP_OAUTH_REDIRECT_URI` (optional) — pins the OAuth redirect; see the ClickUp sign-in notes
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

## Dashboard access: staff, dashboard_module, dashboard_permission
Applied 2026-08-12; the ten migrations are in `migrations/2026081219*.sql`.

**`staff` IS the dashboard user.** There is no separate user table.
`staff.dashboard_access` + `staff.dashboard_role` (owner | admin | user), paired by
the `staff_dashboard_consistent` constraint so a half-configured row cannot exist.
**`staff_company.role` is the job title** ("Director of Finance") — it is the company
role and has nothing to do with dashboard access. Never read it for permissions.

`dash_my_access()` is the frontend contract: one call at boot returning
`{user, companies, access}` with access keyed by `nav_id`, absent meaning no access.
**Never call `dash_level()` per module from the browser.**

### `/api/access/users` does not embed — it joins in code
`dashboard_permission` has **two** foreign keys to `staff` — `staff_id` (the subject)
and `granted_by` (an audit column) — so an unqualified embed is ambiguous. Verified
against the live API:

| form | result |
|---|---|
| `dashboard_permission(...)` | **HTTP 300 `PGRST201`** |
| `!dashboard_permission_staff_id_fkey` | 200 ✅ |
| `!staff_id` (column form) | 200 |
| `!dashboard_permission_granted_by_fkey` | **200 — and silently wrong** |

The last row is the trap. The wrong-direction hint is *accepted*: it joins on who
granted the row rather than whose row it is, so it returns data and the data is wrong.
A query that works and is wrong does more damage than a 300. If you ever embed `staff`
**from** `dashboard_permission`, it is ambiguous the same way and `granted_by` is the
one you would want there.

**`/api/access/users` therefore uses no embed at all.** It reads `staff`, then reads
`dashboard_permission` filtered by `staff_id=in.(…)` over just those people, and joins
them in JavaScript. Two round trips instead of one, on a payload of a handful of rows.

The hinted embed was **not** broken, and the Supabase edge logs say so — read them
before re-litigating this. Every `PGRST201` the app ever caused came from the
unqualified form and stopped at `2026-08-12T21:18:14Z`; the hinted request that shipped
in `390ed53` returned **200 in production at `2026-08-13T00:43:14Z`**. The error still
on screen three minutes later was a **sticky client-side error string**, not a live
failure: `ui.error` in portal-users.js survives until something calls `load(true)`, and
a single-page app gives you no reload to clear it. Hours went into a bug that was
already fixed, so: when a screen reports a server error, check the server's own logs
before touching the query. `query_logs` on `source = 'edge_logs'` filtered by
`log_attributes['request.path']` shows every request and status.

Dropping the embed anyway is a durability choice, not a fix for that error. `PGRST201`
cannot occur on a request with no embed in it, and this is the screen that fixes
everyone else's access — the wrong place for a failure mode whose blast radius is
"nobody can be granted anything".

It is also the safer of the two. The silent-wrongness in the table above is only
reachable through a hint; a join written out in code cannot pick the wrong foreign key
quietly. `test-access-api.js` pins it with a fixture where **every grant was handed out
by Ada**, so a join on `granted_by` gives Ada all three rows and Ute none — and the
test asserts both that each person gets their own grant and that the granter does not
collect anyone else's. Mutating the route to join on `granted_by` fails those two
checks; that was run, not assumed. If you reintroduce an embed here, that fixture is
what will catch you.

### Users & Roles
Shows only `dashboard_access = true`. A staff record without access is not a dashboard
user and belongs on **Team directory**. Exec vs per-business scoping applies on top.

- **`user_id IS NULL` means invited but not yet accepted** — `handle_new_user()` fills
  `user_id` only on acceptance — and is rendered as a Pending badge. Those rows are
  **grouped into "Invited — not yet accepted" below the accepted users**, not hidden:
  an invitation nobody can see is one nobody can chase, and "did that actually send?"
  stops being answerable from the screen that sent it. The Active heading appears only
  when both groups exist — one group needs no label saying what it is.
- **`is_active = false` staff are deliberately NOT filtered out of this list.** They
  cannot sign in (`current_staff_id()` requires `is_active AND dashboard_access`), but
  hiding them here would hide access that still needs revoking, on the one screen that
  can revoke it.
- **Revoke** sets `dashboard_access = false`; `dashboard_role` **must go NULL in the
  same UPDATE** or `staff_dashboard_consistent` rejects it. The staff record is not
  deleted, and grant rows are left in place — they are inert while access is off
  (`dash_level_for` and `current_staff_id` both require it), so restoring access
  restores what the person had.
- **Adding someone** must be able to pick an existing staff member, not only type an
  address. `staff` has a unique index on `(tenant_id, lower(email))`, so an address
  matching an existing person must **UPDATE** that row, never insert a second one.

### Staying current: three layers, none of which covers the others
1. **A change made here** — invite, save, revoke each call `load(true)`. Works today.
2. **A change made by someone else** — `staff` and `dashboard_permission` are bound to
   the `access` view in `TABLE_VIEWS`, and portal.html's realtime `invalidate` calls
   `PortalUsers.invalidate()`. Both halves are required: the component caches its list,
   so `rerender()` without dropping the cache repaints the identical rows. **This layer
   is dead until `migrations/20260810_supabase_webhooks.sql` is applied** — until then
   nothing POSTs to the hook and no SSE ever fires.
3. **Returning to a backgrounded tab** — `visibilitychange` in portal-users.js forces a
   refetch. The stream has no replay buffer, so a client that was disconnected cannot
   know what it missed; this is also the only layer that works before (2) is applied.

`dashboard_module` is deliberately **not** bound: the catalog is seeded by migration
rather than edited in the app, and `PortalUsers.invalidate()` does not clear
`ui.modules`, so binding it would schedule a refresh that could not refresh it.

The focus listener is bound **once**, not per paint. `render()` runs on every
navigation, and a listener added each time leaves N copies attached firing N refetches
per focus — the same bug as the old `bindOnce()`. The test asserts one focus is still
one request after three re-renders.

Every check counts **requests**, not rows: a repaint from cache and a real refetch look
identical on screen, which is exactly why this went unnoticed.

### Only one staff row has dashboard access
Verified 2026-08-13: 1 of 14 `staff` rows has `dashboard_access = true` (Chris
Pomerleau, owner). So this screen correctly shows **one person**, and an empty-looking
list is the data, not a bug. The other 13 reach it through the Invite user picker,
which lists `dashboard_access = false` staff. Confirmed as intended: the screen lists
dashboard users only.

`current_tenant_ids()` reads **`staff`**, not `tenant_member` — it returns
`tenant_id from staff where user_id = auth.uid() and is_active and dashboard_access`.
There are zero `tenant_member` rows in this project and RLS works fine without them, so
do not "fix" that absence. Impersonating the owner through RLS reads 14 staff, 49
modules.

**Users & Roles is role-gated, not permission-gated** — visible when `dash_role()` is
owner or admin, so an admin cannot lock themselves out of the screen that fixes
access. This is the **one exception** to "add a nav item, add its catalog row":
`access` exists in `dashboard_module` only under Executive Board, so requiring the
grant would hide the per-brand item from everyone including the owner. **Do not seed
per-brand `access` rows** to make it symmetrical — a catalog row means grantable, and
grantable means an owner could hand the screen to a plain user.

### Invite and the Auth admin API
There is no authoritative REST reference for the Auth admin endpoints. These shapes
are read from the **auth-js source** (`GoTrueAdminApi.ts`, `lib/fetch.ts`), not guessed:

    POST   /auth/v1/invite?redirect_to=<encoded>   { email, data? }
    PUT    /auth/v1/admin/users/<uuid>             { ...attributes }
    DELETE /auth/v1/admin/users/<uuid>             { should_soft_delete: false }

    headers: apikey + Authorization: Bearer  (both the SERVICE ROLE)
             X-Supabase-Api-Version: 2024-01-01
             Content-Type: application/json

**The redirect is a QUERY PARAMETER, not a body field.** In auth-js it is generic
request plumbing — `lib/fetch.ts` builds `qs['redirect_to']` from `options.redirectTo`
— which is why it reads like a body option. Put it in the body and nothing errors: it
is ignored and the link falls back to Site URL, so the invite arrives, works, and
lands in the wrong place. The same silent failure happens if the URL is not on the
allow list in **Authentication → URL Configuration**. DELETE carries a body, which is
unusual but is what auth-js sends.

**Leave the email templates alone.** `{{ .ConfirmationURL }}` already resolves to
`<ref>.supabase.co/auth/v1/verify?token=…&redirect_to=…`; replacing it with
`{{ .SiteURL }}/invite` strips the token.

### auth.users cannot be deleted while anything references it
**~38 columns in `public` reference `auth.users` with `ON DELETE NO ACTION`** —
`staff.user_id` plus `created_by` / `updated_by` / `uploaded_by` on `property`,
`loan`, `entity`, `transaction`, `document`, `statement`, `unit`, `task` and others.
Only **three cascade**: `profiles.id`, `tenant_member.user_id`, `company_member.user_id`.

So **any Auth user who has ever created or updated a record cannot be deleted** —
from the Supabase dashboard or anywhere else — until those columns are nulled. Someone
will eventually try to delete a departed employee and hit a wall of foreign keys.

This lands directly in the invite rollback. `handle_new_user()` fires on Auth user
creation and immediately sets `staff.user_id` by email match, so by the time the
staff/grant write fails, the staff row **already points at the new Auth user** and
deleting it first fails with a foreign key violation — leaving exactly the orphan the
rollback exists to prevent. The order must be:

1. null `staff.user_id` and restore `dashboard_access` / `dashboard_role`
2. **then** delete the Auth user

For a fresh invite only `staff.user_id` is involved, because nothing else has been
written yet. The rollback runs with the **service role**, not the caller's JWT: the
caller's own permissions may be why the write failed, and a rollback that can itself
be refused is not a rollback. `test/test-invite.js` forces the failure and asserts
both that the Auth user is gone and that no half-configured staff row remains; its
fake enforces the foreign key, and one check proves that enforcement is live.

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

### The gate covers every Tasks screen, embeds included
`clickUpGated()` in portal.html gates `view === 'tasks'` (all three sub-tabs) and
Executive Board `alltasks`. Property Tasks and Tasks > Overview are `/ops`
iframes rather than native, and they used to render with no gate at all - the
embed falls back to the server's shared ClickUp token, so a signed-out visitor
saw, and could edit, real tasks attributed to nobody. `isEmbedView()` returns
false while gated so the iframe is never created. Everything outside Tasks stays
ungated: portal-auth.js still owns Tasks only, never the whole app.

`PortalAuth.onChange` is subscribed twice on purpose - portal-tasks.js re-paints
`#tasksNative`, portal.html re-renders everything else. Dropping the portal.html
one leaves a signed-out user still looking at an embedded board.

### Screen state lives in the URL
`writeState()`/`readState()` in portal.html keep `brand`, `view` and the active
sub-tab in the fragment (`#brand=…&view=…&sub=…`), so a reload lands where you
were instead of bouncing to Overview, and a screen can be linked to. `render()`
calls `writeState()` first, which makes it the single choke point - every setter
already routes through `render()`.

It is **replaceState**, not pushState: navigating the portal is not browser
history, and pushState would make Back walk through every tab you touched. A
`hashchange` listener covers a link pasted into an already-open tab; replaceState
never fires that event, so it cannot loop. Unrecognised values fall back to the
brand's first screen - the fragment is user-editable and a stale link must not
leave the portal blank.

`?v=` is the ClickUp OAuth hand-back. `/auth/callback` appends `#auth=<token>` to
the return path, so that path **cannot carry a fragment of its own** - a second
`#` swallows the token and sign-in silently fails. `defaultReturnPath()` in
portal-auth.js moves the fragment into `?v=`, `readState()` reads it, and the
next `writeState()` drops it. `safeReturnPath()` in server.js now rejects any
`#` as a backstop.

### Property Tasks board columns are canonical, not raw
`PT_COLS` + `ptCanon()` in `public/index.html` group the board by canonical
bucket. The list carries two spellings of the same state - ClickUp's `To Do` /
`in progress` next to Supabase-originated `OPEN` / `IN_PROGRESS` - and grouping
on the raw status string gave each spelling its own column. Cards still show
their **raw** status in the pill, because that is the value written back to
ClickUp; only the grouping is canonical.

`toCanonicalFallback()` and `getStatusKey()` now treat `_` and `-` as separators.
Before that, `in_progress` matched no branch and fell through to To Do, which is
why the duplicate column was also the wrong colour. `ptIsCounterStatus()` and
`PT_DRILL.inreview` are canonical for the same reason: the board hides every In
Review task from the columns, so a counter that missed one would lose it
entirely.

The `⏳ pending` / `⚠ error` chip is a real sync state from `public.task`
(`supabase-sync.js` sets `error` when a push to ClickUp fails; **⇅ Sync tasks**
retries). It is not decoration - do not hide it. It used to render as a
full-width red bar because it was a direct child of the column-flex
`.task-name`; `.pt-nameline` keeps it beside the task name.

### Landing screen
The portal opens on **Executive Board** (`brand='all'`, `view='exec'`) - the group
view first, each brand a step down from it. `readState()` overrides both from the
fragment, so a reload or a shared link still wins. The two defaults must stay
consistent: `exec` is the first entry in `MENUS.all`.

### Brand marks
`BRANDS[x].logo` in portal.html points at an SVG in `public/icons/`;
`brandMark()` renders it and both call sites (the switcher button and the menu)
go through that one function so they cannot drift. A brand with no `logo`, or one
whose file fails to load, falls back to the tinted initials chip via
`brandMarkFailed()` - a missing asset must never leave an empty white square.
`logo` is independent of `color`: the accent drives the whole workspace theme,
not just this chip.

Marks sit on a **white plate** (`.has-logo`). They are fixed-colour artwork, and
a dark mark on the dark theme's panel would vanish.

`leavenwealth-mark.svg`, `leadli-mark.svg`, `folio-mark.svg` and
`liquid-mark.svg` and `exec-mark.svg` are **redraws** from artwork supplied in chat - the originals
were never in the repo and the sandbox has no outbound network to fetch them. To
use the official files, replace the SVG and keep the filename; nothing in
portal.html needs editing. Executive Board deliberately shares the LeavenWealth
mark, being the group view. Executive Board now has its own suited-figure mark.

### ClickUp sign-in is failing on CONFIG, not code
The symptom is **"Whoops! Unable to authorize your teams"** on ClickUp's own
consent page (app "Dashboard-v2"). It fails at the authorize step, so nothing
reaches `/auth/callback` and nothing appears in the server log.

**Do not go looking for this in the code.** The OAuth path here is functionally
identical to the predecessor dashboard (`imhappy2024/click-up-dashboard`), which
signs in fine: same `trust proxy`, same `getBaseUrl()`, same authorize URL, same
token exchange. The only code difference is the post-callback landing, which is
after the failing step.

`&state=` was wrongly blamed and briefly removed (ca5d396); the error persisted
without it and it was restored (it predates the parameter, and ClickUp documents
it). Do not remove it again.

What is left is deployment config, and it needs three facts gathered before any
change:
1. `computed_redirect_uri` from **`/auth/debug`** on the live host.
2. `CLICKUP_OAUTH_CLIENT_ID` on this service vs the working dashboard's
   (`/auth/debug` prints `oauth_client_id_prefix` on both, so this needs no
   Railway access).
3. The Redirect URL(s) registered on the matching ClickUp OAuth app.

1 and 3 must match character for character - scheme, host, no trailing slash,
`/auth/callback` spelled the same. If they differ, register 1 on the app. If the
two services use different client_ids, point this service at the working app's
credentials and add this callback URL to it. If both match, it is a permission
problem: the signed-in ClickUp account must be able to grant the workspace.

### redirect_uri is pinnable - use it
`oauthRedirectUri(req)` is the single source of truth, used by **both**
`/auth/clickup` and `/auth/debug` so they can never disagree while someone is
diagnosing a mismatch. It returns `CLICKUP_OAUTH_REDIRECT_URI` when set,
otherwise derives it from `x-forwarded-proto`/`-host`.

Derived is right behind Railway but is request-derived and can drift - a custom
domain vs `*.up.railway.app`, or a proxy that rewrites `Host` - and ClickUp
refuses the request when it no longer matches the registration. Once the correct
value is known, pin it.

`safeReturnPath()` guards the return path on both legs and is an open-redirect
boundary, unrelated to this error. Leave it alone.

`test/test-oauth-url.js` pins the authorize parameter set, the pin behaviour, and
that `/auth/debug` never prints the client secret.

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
    node test/test-portal-nav.js # Tasks gating, URL state, PT board columns, marks
    node test/test-oauth-url.js  # authorize params, redirect_uri pinning, debug output

`test/expected.json` is written by hand from each fixture's stated intent, not
derived from the code under test. Keep it that way, or the tests lose the ability
to fail. `test-portal-nav.js` follows the same rule: its expectations describe the
intended behaviour, and its board fixture deliberately carries both spellings of
To Do and In Progress.

In the sandbox `run-tests.js` reports one failure, `no page errors ->
ERR_CONNECTION_RESET`: the staff headshots are hotlinked from static.showit.co
and there is no outbound network. That one is an environment artefact.

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
