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

### /api/tasks fetch strategy and payload shaping (added 2026-08-11)
The screen was slow because this was bulk in two places at once. Both are fixed;
the numbers below are measured by `test/test-tasks-api.js`.

**Fetching.** `fetchAllWorkspaceTasks()` discovers lists once, then prefers
`GET /team/{id}/task` - one paginated walk (100/page) - over the old per-list
crawl, which issued a paginated fetch **per list** (200-300 requests, enough to
trip ClickUp's 100-req/min limit and sit in 429 backoff). The crawl survives as
`crawlListTasks()` and runs if the team walk throws or returns 0 tasks while lists
exist. Which path ran is reported as `mode` (`team` / `crawl` / `list`) in the
payload and `/api/health` - **check it before assuming the fast path is live**, a
silent downgrade just looks like "it got slow again".

Two things the team endpoint does NOT give you, both handled:
- **Space names.** It returns space ids only. `withListNames()` resolves space /
  folder / list names from the discovered list metadata, and both paths funnel
  through it. Skip it and every Space and List column renders blank.
- **Archived tasks.** Still fetched per list for `ARCHIVED_FETCH_LIST_IDS` (the
  Wins source) by `fetchArchivedExtras()`.

`crawlListTasks()` uses `runConcurrent()` (the pool already in the file), not the
old `for (i += 5) { await Promise.all(slice) }`, which made the slowest list in
each group of five gate the next group.

**Shaping.** `/api/tasks` takes `?slim=1` and `?spaces=a,b`. Both default OFF, so
`/ops` receives byte-for-byte what it always did - it needs `description`,
`text_content`, `custom_fields`, `canonical_fields`, `tags`, all four date
fields, `archived` and `orderindex`. `slimTask()` trims to the 11 fields the
portal renders. **Audit both consumers before changing that list**; dropping a
field `/ops` reads is a silent blank column, not an error. Measured: 484KB -> 74KB
slim, and 20KB for a single-space brand.

`portal-tasks.js` requests `slim=1&spaces=<brand>`. Because the response is now
scoped, its client cache is keyed on the space set (`payloadKey`) - one brand's
payload must not be served to another. `scoped()` still re-filters by space, so a
server that ignored the param would still render correctly.

**Persistence.** `migrations/20260811_task_cache.sql` adds a single-row
`clickup_task_cache`. The server snapshots after each refresh and restores on boot
*before* pre-warming, so the first visitor after a deploy gets the snapshot rather
than a cold walk. Entirely best-effort: no table or `DATA_SOURCE != supabase`
means one warning and the old behaviour. The restored snapshot keeps its real age,
so it is correctly seen as stale and still triggers a background refresh.
**The migration is not applied yet** - until it is, cold starts stay slow.

`CLICKUP_API_BASE` exists so the tests can point at a fake ClickUp. Never set it
in production. The OAuth endpoints deliberately keep the literal host.

### Task modal + popovers (portal-tasks.js) - the overlay layer
The task modal, the status/assignee/due/priority popovers and the toast live in
a single `#ntOverlays` div appended **to `<body>`**, not inside the task
container. `paint()` replaces that container's innerHTML on every write, so an
overlay inside it was destroyed the moment you changed anything from it - which
is why editing from the drawer used to close the drawer. Consequences to keep in
mind if you touch this:

- `paint()` calls `renderDrawer(false)`, rebuilding the open modal in place so it
  shows what was just saved. `false` preserves the comment list already loaded.
- Leaving the Tasks screen must call `PortalTasks.close()`; `portal.html` does
  this in `render()`. Without it an open modal outlives the view it belongs to.
- Popovers are `position:fixed` and placed by `placePop()` in **viewport**
  coordinates, flipping above the anchor near the bottom edge and following it on
  scroll. They were `position:absolute` doing viewport arithmetic while the
  container was `position:static`, so the offset parent was some ancestor and the
  menu appeared adrift from its row. Don't go back to absolute without also
  making the container a positioned ancestor.
- z-order: scrim 70, modal 71, popover 80, toast 90. The popover must stay above
  the modal, because the modal opens the same popovers.
- Escape closes **one** layer (popover, then modal). That handler is bound in
  `ensureOverlays()`, which runs once. `bindOnce()` used to compare
  `el.__ntBound === paintId()` with a `paintId()` that incremented on every call,
  so it never matched and every paint stacked another set of listeners - 16
  document keydown handlers after five paints, which made one Escape close both
  layers at once. Keep document-scoped listeners out of `bindOnce()`.
- The modal is centred (`left/top 50%` + `translate(-50%,-50%)`), matching the
  ops drilldown. It was a right-edge drawer, which read as a different product
  from the same thing on the Executive Board.

Status, assignees, due and priority are editable from **both** the list row and
the modal. Priority writes `priority: 1..4` (urgent..low, `null` clears) straight
through `PUT /api/task/:id`, which is a pass-through to ClickUp - no server
change was needed for it.

### Needs Review / For Approval / L10 - counter-driven single panel
Row 1's counters ARE the switcher: exactly one is selected and row 2 is a single
panel showing that set, the same shape as the portal's native Tasks screen. Row 2
used to be three columns, which duplicated the counters on the two review tabs
and, on L10, showed a different cut (Rocks / IDS / Sprint) than the counters
above it.

`PANEL_VIEWS` + `panelCard` + `paintCounterPanel()` in `public/index.html` drive
all three tabs, so a change lands on all of them at once. Each view's render
function builds `{ key: {title, desc, tint, tasks} }` and hands it over; the panel
header takes the selected counter's `tint` so the two rows read as one unit.
`grouped: true` (L10 only) groups by raw status, matching what its columns did.

Element ids follow `<view>-card-<key>` / `<view>-kpi-<key>` / `<view>-panel-*`,
where view is `td` / `fr` / `l10`. `paintCounterPanel()` falls back to the first
counter if a stored key ever goes missing, because "no selection" would render an
empty screen.

**Rocks / IDS / Sprint did not disappear** - it moved to the drilldown, which
already grouped by category (`groupBy: 'category'`). That is why the small **View**
chip keeps its `openDrilldown()` handler while the card body switches the panel;
the chip needs `event.stopPropagation()` so it does not also switch. The chip was
`pointer-events:none` because the whole card used to be one click target - it now
becomes clickable on hover, so anything driving it must hover first.

`.panel-card` is excluded from the mobile card accordion in both places that
implement it. It is the content of its view, not one of several cards to collapse
between - collapsing it leaves the screen empty below the counters.

### Ops bulk-action bar
`.bulk-bar` in `public/index.html` hides with `visibility:hidden` as well as
`translateY(120%)`. The transform alone left ~14px of the bar visible above the
bottom edge whenever nothing was selected, which showed up as a mystery box at
the bottom of every embedded ops view. The `visibility` transition is delayed by
0.2s on hide only, so the slide-out is still seen.

### Embed theme - do not undo this
Do **not** re-add an unguarded `html.embed-only body` palette to
`public/index.html`. It ties on specificity with the dark tokens in `tokens.css`
and loads later, so it wins and turns every embed white. The guard is
`:not(.embed-dark)`.

### Tests
    npm install --no-save playwright express
    node node_modules/playwright/cli.js install chromium
    node test/run-tests.js       # task counters, membership, click-to-filter, nesting, themes
    node test/test-realtime.js   # secret handling, coalescing, keepalive, client caps
    node test/test-oauth-url.js  # ClickUp authorize URL + redirect_uri
    node test/test-portal-nav.js # brand/view routing, reload survival, PT board columns
    node test/test-tasks-api.js  # fetch strategy, slim/spaces shaping, crawl fallback
    node test/test-task-cache-persist.js   # cold start served from the snapshot

`test-tasks-api.js` runs the real `server.js` as a child process against a fake
ClickUp via `CLICKUP_API_BASE`. Its worker-pool assertion counts how many list
fetches overlap one deliberately slow list: a pool reaches ~21, lockstep batches
cannot exceed 4. The fake answers `sp2` faster than `sp1` so the slow list is
always discovered first - without that the check passes or fails on luck.

`test-task-cache-persist.js` stubs `supabase-db` in-process and lets the fake
ClickUp hang forever, so any served task can only have come from the restored
snapshot. It verifies the server's logic, NOT that the SQL runs on real Postgres.
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

`run-tests.js` and `smoke-portal.js` launch whatever browser Playwright
installed; `CHROME_PATH` overrides it. They used to hardcode
`/opt/pw-browsers/chromium-1194/...`, which made the suite unrunnable off the
Linux sandbox it was written in. Don't reintroduce an absolute browser path.

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
