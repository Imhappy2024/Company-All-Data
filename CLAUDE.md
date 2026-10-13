# CLAUDE.md — LeavenWealth Group "Company-All-Data"

Current state of the project, as built and deployed on 2026-10-12. Read all of it
before changing anything.

## 0. How to use this file

- **This file describes the build as it is now.** Each rule appears once. If code and
  this file disagree, check the deployed artifact (section 17), then fix whichever is
  wrong in the same commit.
- **Order of authority** when sources disagree:
  1. The person's instruction in the current session.
  2. This file.
  3. `docs/PROPERTIES_SPEC.md` + `docs/mockup/*.dc.html` for the look and behaviour of
     Properties and the shell.
  4. `docs/SYSTEM.md` for where the numbers come from.
  5. `docs/HISTORY.md` (archive only).
- **`docs/HISTORY.md` is the old 3,267-line CLAUDE.md, kept verbatim.** It explains
  *why* past decisions were made: incident write-ups, superseded designs, verification
  logs. Read it when you need the reasoning behind a rule. Never take instructions
  from it. Anything there that contradicts this file is superseded.
- **Update this file in the same commit** as any change to architecture, menus,
  routes, data rules, env vars or tests. Keep it current-state. Put the story of how
  you got there in HISTORY.md, not here.
- **Do not re-ask decided questions.** Section 18 lists open items. Everything else
  in this file is settled.

## 1. What this is

One Express service, the internal portal for LeavenWealth Group: one company,
four businesses.

| Path | What | Status |
|---|---|---|
| `/` | **Portal** (`public/portal.html`), the shell from `docs/mockup/shell.dc.html` | Live, the product |
| `/login`, `/invite` | Supabase Auth sign-in and invite acceptance | Live |
| `/api/*` | All data routes | Live |
| `/ops` | Legacy ClickUp operations dashboard (`public/index.html`) | Still served, **not linked from the portal**. Do not break it; do not extend it. Retire later. |

Businesses (`company` table, fixed UUIDs), in rail order (`BIZ_ORDER`):

| Key | Name | company_id |
|---|---|---|
| `leavenwealth` | LeavenWealth | `c0000000-0000-4000-8000-000000000003` |
| `folio` | Folio Excel | `c0000000-0000-4000-8000-000000000002` |
| `leadli` | Leadli AI | `c0000000-0000-4000-8000-000000000001` |
| `liquid` | Liquid Lending Solutions | `c0000000-0000-4000-8000-000000000004` |

Single tenant: `tenant_id = 72381c81-af95-4e1d-ad0d-20a3a3421119`. Supabase project
`lhdpzalqrwepfjoicdiz` ("LW Data base").

**Related systems** (separate repos and services, not this one):
- **Buildium/AppFolio sync** (repo `Imhappy2024/LW-t12-rentroll`, Railway cron).
  - Loads T12s and rent rolls into `t12_report*`, `t12_monthly` and `rent_roll_*`.
  - Files per-property Excel files to Dropbox.
  - Runs on the 3rd Thursday of the month, with a daily resume.
- **LeavenWealth Database Connector** (`lw-data-mcp`): Claude's access to the same
  database, under the same access model as the portal (section 5).
- **n8n** (`leavenwealth.app.n8n.cloud`): email workflows (section 15).

## 2. Stack, run, deploy

- **Stack:** Node 18+, Express, `pg`, vanilla HTML/CSS/JS.
  - **No framework, no bundler, no build step.** Ask before adding one.
- **Dependencies:** archiver, compression, cors, csv-stringify, exceljs, express,
  node-fetch, pdfkit, pg.
- **Run locally:** `npm install && npm start` serves http://localhost:3000.
  - Needs a gitignored `.env` with at least `SUPABASE_DB_URL`, `DATA_SOURCE=supabase`,
    `SUPABASE_URL` and `SUPABASE_ANON_KEY`.
- **Deploy:** Railway (nixpacks).
  - `railway.json` starts `node server.js`.
  - Pushing to `main` deploys.
- **Migrations:** `migrations/` is review-only SQL and is never auto-applied.
  - Dry run: `node tools/dry-run-migrations.js <files>`
  - Apply: `node tools/apply-migrations.js <files>`
  - Show the SQL to Jay before applying anything that changes schema or deletes data.

## 3. Repo map (what is live)

**Server**
| File | Mounted at | Purpose |
|---|---|---|
| `server.js` | | App, auth, ClickUp OAuth, /ops routes, route mounting |
| `supabase-db.js` | | `q()`/`tx()`, per-role pools (section 6) |
| `portal-identity.js` | middleware | `identify`, `guard()`, `asCaller()`, `asCallerIfSession()`, `adminOnly()` |
| `shell-api.js` | `/api/shell` | Team, Departments, Tools (as caller) |
| `home-tasks.js` | `/api/home` | Home tasks, L10, task pop-up writes (person's own ClickUp token) |
| `people-api.js` | `/api/people` | Roles & permissions, invite, deactivate (admin only) |
| `props-api.js` | `/api/props` | Properties v2: list, property, monthly, optimized, fee, rent-roll, buildings, capex, custom views, groups, export |
| `props-views.js` | | Custom-view engine (server side of `public/props-views-core.js`) |
| `props-export.js` | | xlsx / pdf / zipped csv from the table model the browser sends |
| `reports-api.js`, `reports-core.js`, `reports-export.js`, `report-mailer.js`, `report-scheduler.js` | `/api/reports` | Properties > Reports |
| `folio-financials-api.js` | `/api/folio/financials` | Folio Excel (Whop billing) |
| `leadli-financials-api.js` | `/api/leadli/financials` | Leadli AI payments |
| `realtime.js` | `/api/events`, `/api/hooks/supabase` | SSE live sync |
| `config/datasets.js` | | Dataset allowlist for saved views (legacy `/api/views`) |
| `am-fee-rules.js`, `noi-analysis.js`, `formula.js` | | Pure rule modules (tests and legacy views) |

**Browser** (`public/`), in the order `portal.html` loads them:
`portal-sw-cleanup.js`, `portal-loader.js`, `portal-morph.js`, `props-views-core.js`,
`portal-session.js`, `portal-access.js`, `portal-auth.js`, `portal-home.js`,
`portal-reports.js`, `portal-props.js`, `portal-folio-fin.js`,
`portal-leadli-fin.js`, `portal-realtime.js`.

Styles: `tokens.css`, `portal-shell.css`, `portal-props.css`, `portal-loader.css`,
`portal-financials.css`.

**Legacy: in the repo, NOT loaded or routed by the portal.**
- Browser modules:
  - `portal-properties.{js,css}` (command-center port)
  - `portal-reporting.{js,css}` (Properties phase 2)
  - `portal-saved-views.js`
  - `portal-setup.js` (add-record forms)
  - `portal-tasks.js`
  - `portal-financials.js` (LeavenWealth cash & debt)
  - `portal-ghl.{js,css}` (Leads)
- Server APIs that are still mounted but have no portal screen:
  - `/api/portfolio*`, `/api/am-fees`, `/api/datasets`, `/api/views`,
    `/api/portfolio-setup`
  - `/api/financials`, `/api/ghl`, `/api/tracker`, `/api/loans`, `/api/tasks`
  - `/api/properties*` (used by /ops)
- Do not wire these back in, and do not delete them, without being asked.
  `/api/properties` (used by /ops) and `/api/portfolio` are different payloads, so
  never merge them.

## 4. The shell (`public/portal.html` + `portal-shell.css`)

Built to `docs/mockup/shell.dc.html`. Properties mounts inside it at `#reportingNative`.

### Rail
- **First button:** Home for everyone. For owners and admins it is the
  **Executive board** instead (`homeViews()`).
- Then a divider, then one button per business the person can reach.
- **Shortcuts:** Ctrl+0 is Home/Executive board; Ctrl+1..4 are the businesses in
  rail order.
- **One business only:** the rail's business part is hidden, and My tasks / All tasks
  move to the top of that business's sidebar.

### Menus (`MENUS`)
| Business | Items |
|---|---|
| LeavenWealth | Properties, Team, Departments, Tools & apps, Documents |
| Folio Excel | Overview, Financials, Plans, Reports, Team, Departments, Tools & apps, Documents |
| Leadli AI | Overview, Financials, Team, Departments, Tools & apps, Documents |
| Liquid Lending | Overview, Financials, Team, Departments, Tools & apps, Documents |

- **Removed by decision; do not re-add:**
  - Leads (GHL stays a link on Tools & apps).
  - Loans and Financials under LeavenWealth (Properties covers them).
  - Tasks inside businesses (Home covers them).
  - Users & Roles as a business item.
  - Investors, Insurance/Risk, Integrations and Plans & Pricing as separate screens.
  - The old per-brand Overview KPIs.
- **Gates:** an item shows only when `dash_my_access()` returns its catalog id.
  - The optional third element of a `MENUS` entry names the catalog id when it
    differs from the page: Folio Financials rides on `reports`; Liquid Departments
    rides on `team`.
  - A page the person cannot open is never listed, so no screen ever says "no access".

### Home / Executive board
- **Home** (everyone else): My tasks, All tasks.
- **Executive board** (owner/admin): L10 agenda, All tasks, Personal tasks, then
  **Roles & permissions** below a divider. That is the only access screen.

### Header
Menu toggle (`lwSideHidden:<staff id>`), breadcrumb, full screen, and the light/dark
icon at the top right. No search box, no notifications bell.

### Theme
- Kept per person in `localStorage['lwTheme:<staff id>']`; with none saved, the
  device setting decides.
- The pre-paint script uses `lwThemeLast`; `personTheme()` corrects it once the
  person is known.

### Memory and URL
- Memory: `localStorage['lwShell:<staff id>']` holds the last business and the last
  page per business. A URL fragment wins over it.
- **Default page on entering a business** (`DEFAULT_PAGE` in portal.html):
  LeavenWealth opens on Properties > Portfolio whenever you come into it from another
  business or Home (`PortalProps.reset()`); a reload keeps the exact page (it comes
  back through the URL). Other businesses return to their last page.
- URL: `#brand=<home|leavenwealth|folio|leadli|liquid>&view=<page>&sub=<tab>`, plus
  Properties' own params and `who=` for the Team filter. Back, refresh and shared
  links must land in the same place.

### Pages
- Team, Departments and Tools read `/api/shell/*` as the caller.
- Documents is a placeholder.
- Folio Plans reads `/api/folio/financials/plans`.
- Liquid Overview and Financials are empty states today (section 13).

### Tables
`dataTable()` gives sortable headers (nulls last), a frozen header,
Compact/Comfortable density (`localStorage.lwDensity`) and CSV export.

## 5. Access: ONE model, shared with the Claude connector

### Source of truth
- **`mcp.access_grant`** (+ `mcp.app_user` for active, principal, owner): the rows the
  LeavenWealth Database Connector reads and its admin tools write.
- **Never create a second permission model.**

### Levels
- Descriptions: `mcp.access_level`. Where a level may be given: `mcp.level_scope`.
- Any company or `all`: admin, user, user_2, user_3, custom.
- LeavenWealth only: principal, lw_corporate, lw_user, lw_user_ro, lw_viewer.
- Admin cannot be given on `leavenwealth` alone, only on `all` or another company.
- Owner is a person (`dashboard_owner`, Chris), not a level. Admin on `all` makes a
  person a dashboard admin.

### Screens follow the level
- **Tables:**
  - `mcp.level_module`: level × screen × can_write.
  - `mcp.module_restriction`: narrows per person, never widens.
  - `mcp.custom_module`: picks the screens for the Custom level.
- **Sync:** `mcp.sync_dashboard()` rewrites `public.dashboard_permission` and
  `staff.dashboard_access/role`. Triggers call it, so changes made with the
  connector's own tools move the dashboard too. A person is synced only once
  `app_user.dashboard_synced` is true.
- **`dash_my_access()`** is the frontend contract: one call at boot returns
  `{user, companies, access}`. Never call `dash_level()` per module from the browser.
- **Job title vs access:** `staff.title` / `staff_company.role` is the job title and
  never a permission.

### People and audit
- **One person, several emails:** `mcp.app_user_email` holds the aliases;
  `app_user.staff_id` links the person to their dashboard staff row.
- **Audit:** `mcp.access_change` records who changed what, from `mcp.actor`.

### Roles & permissions screen
`people-api.js` + `public/portal-access.js`, inside the Executive board.
- **List:** only people with dashboard access. Click a row to see their level per
  company and the screens it gives.
- **Invite** (two steps: name and email, then permissions) runs as one transaction:
  - staff row, `mcp.add_user`, `mcp.provision_user_role`, grants, `sync_user_access`;
  - then the **Supabase dashboard invitation** (the only email sent on invite),
    which lands on `/invite`.
- **Claude connector setup email:** NOT sent on invite. An admin sends it from Update
  ("Email Claude connector setup") through the n8n workflow "Connector access email
  (dashboard invites)" (`G6O73UaJOyKNjpMG`). The token is never returned to the
  browser.
- **Invites refuse to run** without `MCP_ROLE_SECRET`, which must equal lw-data-mcp's
  value. The role password is HMAC-SHA256(secret, role).
- **Revoke/deactivate:** `app_user.active=false`, `sync_user_access` (nologin),
  dashboard off, Supabase ban. The owner and yourself cannot be revoked.

### Auth admin API shapes
Read from auth-js; do not guess them.
- The invite `redirect_to` is a **query parameter**. Put in the body, it is silently
  ignored.
- Leave the email templates alone.
- `auth.users` rows referenced by ~38 `created_by`/`updated_by`/`user_id` columns
  cannot be deleted until those columns are nulled. On a rollback, null
  `staff.user_id` first, then delete.

## 6. Security and identity (DO NOT WEAKEN)

### Connection and identity
- **`supabase-db` connects as the postgres superuser**, so RLS does not run on
  privileged queries.
- **Identity is verified, never decoded.** `portal-identity.js` asks Supabase to run
  `dash_my_access()` as the caller. A JWT payload is base64, not proof.
- **Data routes run as the caller's connector role.**
  - `guard()` / `asCaller()` look up `mcp.app_user.db_role`.
  - `q()`/`tx()` then run on a per-role pool whose connections are proven
    (`SET ROLE` + a `current_user` check; a connection that fails the check is
    destroyed).
  - Postgres then applies the connector's grants and row rules. The dashboard and
    Claude see the same rows.
  - No connector account means 403 and no data.

### Admin and fallback paths
- **`adminOnly()`** keeps Roles & permissions, setup forms and legacy APIs on the
  privileged connection, behind a server-side admin check.
- **Privileged queries:** filter `tenant_id` from the verified identity in every
  statement. A missing scope must throw, never degrade into "no filter".
- **`reporting.*` is read only through `public.rpt_*` security-barrier views:**
  - Materialized views cannot hold row rules.
  - Each view is filtered by `mcp.class_expr`, classified in `mcp.table_class`, and
    granted by `mcp.sync_user_access`.
  - `props-api` and `reports-api` read only `rpt_*`.

### RLS
- Tenant tables: `current_tenant_ids()` (reads `staff`, not `tenant_member`; zero
  `tenant_member` rows is correct).
- Brand tables: `current_company_ids()`.
- `anon` has no read access.
- n8n and server scripts use the service role, which must never reach the browser.

### Other boundaries
- **No free-typed SQL** ever reaches the database:
  - Custom-view fields come from a whitelist (`props-views-core.js` `FIELDS`).
  - Formulas are parsed and evaluated, never eval'd and never concatenated.
  - Every value is bound.
- **Security boundaries; leave them alone:**
  - `safeReturnPath()` (open redirect).
  - The webhook secret compare in `realtime.js` (fails closed: 503 unset, 401 wrong,
    timing-safe).
  - `formula.js` / `props-views` parsing.
- **Migrations:** additive and reversible. Never drop or alter a policy without
  replacing it. After a schema change, run the Supabase security advisor.

## 7. Properties (`public/portal-props.{js,css}`, `window.PortalProps`)

### Design source
Built to `docs/mockup/properties-mockup.dc.html` (readable source) and
`properties-mockup-standalone.html` (renders alone, for side-by-side screenshots).
Spec: `docs/PROPERTIES_SPEC.md`.

**Reports tab caveat:** Reports was added on 2026-10-12 from a newer mockup revision
than the repo copy. Replace `docs/mockup/properties-mockup.dc.html` with that
revision when Jay supplies it.

### Structure
- **Portfolio** tabs: **Entities | Custom view | Reports**.
  - **Entities = OWNER entities** (`property.entity_id`, the owner LLC), not managing
    entities (Jay, 2026-10-13). Each row's sub-line names its managing entity. The
    drill-down (`ent=` in the URL) is the owner entity id.
  - Entities table columns: Owner entity, Properties, Units, Physical occupancy,
    Economic occupancy, NOI, Market value, Cash flow after debt and capex, Debt.
  - **Economic occupancy** = (rent income + recurring fee income) / total expected
    income, latest month with data (`economicOccupancy()` in props-api.js); an entity's
    figure is the ratio of the sums. Total expected income and recurring fee income
    (`property_financials`) are empty today, so it shows a red "–" until loaded.
  - **Market value:** sum of values on file, "(k of n)" when partial, an "Outdated"
    tag, red "–" when none.
  - A property with no owner entity would sit under "No owner entity on file" (none
    today: all 50 have one).
- **Entity page:** its properties table only (Physical and Economic occupancy columns).
- **Property page** tabs, in this order:
  1. Overview (the only place with the key-figure cards)
  2. Buildings & units
  3. Needs attention (red count badge)
  4. Monthly financials
  5. Optimized NOI
  6. Asset management fee
  7. Rent roll
  8. Capex
  - **Not tabs:** Optimized NOI and DSCR are ONE tab (named Optimized NOI). There is
    no Valuation, Documents, Income & expenses or Loans tab.
- **Export** (Excel / PDF / CSV) appears on Monthly financials, Optimized NOI, Rent
  roll and Capex. File name: `<Property> - <Tab> - <Period>.<ext>`.

### Tab details
- **Monthly financials:**
  - From/To month (01–12) + year selectors, eight period tiles.
  - Then Summary, Income statement and Cash flow statement, stacked with no switch
    buttons.
  - Rows and months with no data are hidden automatically.
- **Optimized NOI:**
  - Cards: status (Safe / Fixable / At risk / Critical), Best NOI latest, DSCR, max
    loan, vs current loan, value (all on Best NOI).
  - Then the Assumptions row; under it **Actual DSCR, from the books** (Best NOI,
    Previous best, T12: NOI / debt service paid over the same months, all-debt where
    it differs); then the "What it earns, and what that supports" table with three
    rows only: Best NOI, latest (T#) or "None", Previous best NOI (T#), What-if.
    What-if inputs are never saved.
  - Then the NOI heat map: above-average months bold, dot rows for both runs.
- **Needs attention:**
  - Rules run server-side: operating loss, DSCR < 1.00, DSCR < 1.25, vacancy ≥ 15%,
    delinquency ≥ 5% of rent, ≥ 10% of occupied leases expiring in 90 days, no
    managing entity, a value with no date or older than 12 months, coverage not
    calculable.
  - Each item states the actual numbers, the next step and the source.
  - **Gaps in sentences are computed between ROUNDED figures**, so the printed
    numbers add up.

### Read-only
- Property data is read-only (`PROPERTIES_READ_ONLY`, default true).
- Writable by their owner/editors: custom views, property groups, saved reports,
  schedules and shares.
- Add-record forms (+ Entity / Property / Building) are not reachable (decision).
  The server side (`/api/portfolio-setup`, insert-only, audited) remains.

### Header and names
- **Header:** "Data through <Mon YYYY>" comes from the latest `t12_report.period_end`.
  "Next sync" is the next 3rd Thursday at 9:00 AM America/Chicago (`nextSync()`).
- **Names:** `property.display_name` where set, otherwise `dba_name`.

### Custom view (Portfolio > Custom view)
Sub-tabs, one per saved view, with "+ Add custom view" at the right. Builder modes:
- **Quick build:** properties, fields, then Cards / Table / List / Chart.
- **Advanced:**
  - Cards built one by one: Value (field + period + total/average) or Formula
    (+ − × ÷, numbers).
  - S/M/L sizes, drag-and-drop layout.
- **Property groups:**
  - `property_group`, `property_group_member`, owned by the user and reusable.
  - Pick groups with checkboxes and untick properties per view; the group itself
    does not change.
- **Rules code:**
  - `public/props-views-core.js` is the ONE copy of the rules, loaded by the browser
    and `require`d by `props-views.js`. Previews run in the browser;
    `test-views-parity.js` asserts the two match.
  - **A group subtotal of a formula is the formula over the totals,** never the sum
    of row results.
- **Sharing:** private by default, shared with a person, role or department as
  viewer or editor via `saved_view_share`. Sharing never widens data access: the
  reader's own connector role applies.

### Reports (Portfolio > Reports)
Build report | Saved reports | Scheduled.
- **Contents:** Income report (regular range / quarterly / bi-annual / annual / T12;
  income and/or cash flow statement), Rent roll, Optimized NOI, in any combination,
  for any properties. Preview renders as a document.
- **A report stores its definition, never figures.** Every open, export, send and
  scheduled run rebuilds it on current data.
- **Send:** To / Cc / Bcc / Subject / Message plus the attachment, via the n8n
  "Report email (dashboard reports)" workflow (`ghGUvzmOC19PUwMO`, Graph `/me/sendMail`
  as Jay).
  - Attachments are capped at 3 MB.
  - Max 4 To, 3 Cc, 3 Bcc.
  - Needs `REPORT_EMAIL_SECRET`.
- **Schedules** (`report-scheduler.js`, 5-minute tick, 9:00 AM America/Chicago):
  - Run as the OWNER's connector role, after re-checking that the owner is active and
    has Properties write.
  - Roll forward to the latest completed period of the same type, measured against
    data loaded, not the calendar.
  - Claim the occurrence before sending, so a send never happens twice.
  - On failure: record it and email the owner.
  - `REPORT_SCHEDULER=off` disables them.
- **Tables:** `report_definition`, `report_schedule`, `report_send_log`. Server-only:
  RLS on, no policy.
- **Permissions:** read-only levels can build, preview and export. Saving, sending
  and scheduling need Properties write.

### No flicker (keep it this way)
- **`paint()` morphs** (`portal-morph.js`): only changed nodes are touched.
  - Identity is tag + `data-k`. `<main>` carries the page key, the tab body
    `tab:<n>`, a custom view `cv:...`.
  - Give any container whose content identity changes a `data-k`, or the fade will
    not run and nodes will be reused wrongly.
- **Session cache** per property/period/tab (`S.data`). Going back is instant;
  refreshes keep old content visible and dimmed (`ld-stale`).
- **What-if inputs recompute in the browser;** the focused input is left alone.
- **Stale responses are dropped:** a reply for a previous selection never overwrites
  the current one.
- **Bind with `.onclick =`** on elements that are re-rendered, never stacked
  `addEventListener`.

## 8. The reporting layer: data rules

**Read path:** screens read `public.rpt_*` over `reporting.*`. Nothing reads
`t12_monthly`, `rent_roll_line` or `loan` directly. Migrations:
`20261011_reporting_schema.sql`, then `20261012_reporting_v2.sql` (current).

### Materialized views
- `reporting.property_month_mv` and `property_summary_mv`.
- **After every T12 or rent roll load:** `node tools/refresh-reporting.js`
  (`reporting.refresh_reporting()`, concurrent).
- Measure Postgres execution time (`explain analyze`), not laptop round trips.

### Units and occupancy
- **Units:** latest rent roll, then `unit_count_verified`, then the sum of buildings'
  `current_total_units`. `units_source` names which one was used.
  - Never use `unit_count_reported`; it is often the first building only, and never
    write to it.
  - Corrections go to `unit_count_verified` with `_by`, `_at` and a note.
- **A `rent_roll_line` is a LEASE, not a unit.**
  - `occupancy_status` ∈ current, past, vacant_unrented, future, notice,
    vacant_rented. There is no "occupied".
  - Fold to one row per unit first; only current, notice and vacant_* lines count.
  - Occupied = current or notice. Rent = current leases only.
  - Loss to lease uses occupied units only.
  - Delinquency = positive net balance; prepaid = net credit.
- **The `unit` table holds BUILDINGS** (`unit_identifier` = "Building 1").
  - Apartments = SUM(`current_total_units`); 0 on a garage is complete data.
  - Outbuildings (garage, shed, …) are listed separately.
  - Sort buildings with a natural comparator.

### Debt service (per property; first match wins)
| Step | Condition | Source label |
|---|---|---|
| a | Books carry principal or an unsplit payment | `income_statement` |
| b | Every loan states an annual debt service | `loan_record` |
| c | Books carry interest only | `interest_only_books`, tagged "interest only" (coverage overstated) |

**Interest labels:**
- Count `Mortgage Interest`, `Interest Exp`, `Interest Payment`.
- Do not count `Other Interest Expense`, `Other interest` or `Interest Expense`.
- The matcher anchors matter: `^interest exp$` must not catch `Interest Expense`.

**Principal:**
- Buildium: `Mortgage Principal`. AppFolio: `Principal Payment`.
- AppFolio `other_cash_items` loan/mortgage lines count only when NEGATIVE
  (principal = −amount).
- Positive amounts are **`loan_proceeds`** and never debt service. Example: Doral
  4,326,000 in May 2026.
- Exclude `Loan - Other` and `Arrow Loan` (manager advance) from principal.
- `Mortgage Payment` / `Mortgage Payment - Seller Carry` are unsplit debt service.

**Not debt service** (all contain the word "Mortgage"):
- `Mortgage Escrow Replacement Reserve`
- `Mortgage Escrow Expense` (operating expense)
- `security deposit | prepaid | clearing` lines

**Other interest counts as extra debt only by rule:** positive in ≥ 6 of the last 12
months AND a loan with a KNOWN non-primary purpose (or 2+ loans).
- Qualifying today: Cedar Haven Duplexes, Heston Pointe.
- **The Beverly is deliberately out** (open item).
- Excluded amounts stay visible in `other_interest`.

**Two DSCRs everywhere:**
- "DSCR, mortgage" (`dscr` / `trailing_dscr`, unchanged meaning) and
  "DSCR, all debt" (additive columns).
- DSCR in Needs attention and the cards uses `annual_debt_service_paid` (books,
  annualized), else the loan record.

### Other figures
- **`property_summary.cash_flow_after_debt_and_capex`** = NOI − AM fee − debt service
  − capex. It is NOT net income.
  - True net income comes from `reporting.income_statement_month`.
  - The old `t12_net_income` column is dropped. The custom-view field KEY
    `t12_net_income` survives in saved configs and reads the new column.
- **Best NOI** (the Optimized NOI figure, Jay 2026-10-13): a good month has NOI above
  the property's 12-month average. **Latest** = the unbroken run of good months ending
  at the latest month with data, T1 to T12, annualized (NOI x 12 / k). If the latest
  month is not good, latest is NONE and `optimized_noi` is NULL (about 30 of 50
  properties today). **Previous** = the most recent good run before it. A month with
  no data breaks a run. T2/T3/T6/T12 rows are gone by instruction.
  - SQL: `property_summary.optimized_noi` (`migrations/20261017_best_noi_runs.sql`).
  - Same rule in JS: `bestRuns()` in props-api.js, used by the tab and Reports. Keep
    the two in step (Franklin Court: T4 Jun-Sep 26, $1,006,943; previous T1 Apr 26).
- **Partial history:** a report only claims months from its `first_active_month`.
  Months before it show "–", never 0.
- **Asset management fees:**
  - Expected = fee % × gross income (total operating income, cash) of the same month,
    or of the previous month for following-month managers. BG Champion is a fixed
    $8,291.67.
  - Received = seed/manual value, else the booked AM fee line (`books`, shown in
    italics).
  - Variance = received − expected; a past month with nothing received counts as
    −expected; |variance| < $1 displays as a grey 0.00.
  - **`am_fee_schedule.fee_pct` is a WHOLE percent (2 = 2%);
    `loan.interest_rate_pct` is a FRACTION (0.035 = 3.5%).**
- **Capex categories:** from the editable table `capex_category_map`; unmatched
  accounts go to "Other".
- **Cash flow statement:** `reporting.cash_flow_line` classifies `other_cash_items` as
  operating, financing or investing. An empty section is hidden.

### Matchers fail silently
- The account-label matchers live in `reporting.t12_tagged`. A spelling drift
  returns NULL, which looks like "no data".
- Buildium and AppFolio spell things differently (`Rent Income`/`RENTS`,
  `Capital Improvements`/`CAPITAL EXPENSES`).
- Regression queries are at the bottom of the migrations. Run them after any matcher
  change.

### Dates and estimates
- **Months travel as `'YYYY-MM'` text** (`to_char`).
- Never `toISOString()` a Postgres DATE; from UTC+8 it shifts a day. The test
  harness pins `TZ=UTC`.
- Estimates say so next to themselves:
  - "interest only" tag on DSCR from interest-only books.
  - "Outdated" / "stale" on values (with no date, or older than 6–12 months).
  - "estimate" on value at cap rate.
  - LTV names which value it used.

## 9. Home tasks, L10 and the task pop-up

### Home (`home-tasks.js` at `/api/home`, `public/portal-home.js`)
- **Token:** only the person's OWN ClickUp OAuth token (`X-ClickUp-Token` /
  `du_token`). Never `CLICKUP_API_TOKEN`.
  - No token means 401 and one "Connect ClickUp" button.
- **Loading:** reads every page of every workspace, de-duplicated by task id, so a
  task in several businesses appears once.
  - Server cache per token: fresh for 60 s, then served stale while it refreshes.
  - Browser cache: `sessionStorage.lwHomeTasks`.
- **Completed tasks never show** (ClickUp status type `closed`, or a status named
  complete/completed/done).
  - Both the server and the browser apply this rule.
  - A task marked complete leaves the list at once.
- **Board** (`boardHtml()`):
  - Four count cards that filter the table: Open, Overdue, Due this week, then In
    review (personal) or Unassigned (all).
  - Filter bar: search, assignee, status, priority, space.
  - The table.

### L10 agenda (Executive board only; admin's own token)
- Source: ClickUp list `901403327501` (MASTER LIST, Company space).
- Split by the "Appears In" labels field `21ad3d3b-bfc9-4a1e-9e9e-6bfc8b58cbee` into
  Rocks / Sprint / IDS (label ids in `L10.sections`; an item can be in several).
- The section is in the URL as `sec=`.

### Task pop-up (`openTask()` / `openPanel()`)
- **Frame:** centered modal, dimmed backdrop. Closes on X, Esc or an outside click.
  Focus is trapped; the page behind does not scroll.
- **Fields:**
  - Status: the list's own statuses with ClickUp colours.
  - Due: editable (5 pm, as /ops sets it).
  - Assign: dialog limited to the list's members.
  - Also shown: priority, tags, created, updated.
  - Comments: newest first, attachments as links, Ctrl+Enter posts.
- **Writes are optimistic:** a ClickUp refusal puts the row back and shows ClickUp's
  own message.
- **Endpoints:** every call goes to `/api/home/{task,list}/...` with the person's
  token.
  - A ClickUp 401 on a task is returned as 403, so the person stays signed in.
  - The /ops routes (`/api/task/:id`, shared token) are not used.

### ClickUp OAuth
- **`oauthRedirectUri(req)`** is the single source of truth for `/auth/clickup` and
  `/auth/debug`. It returns `CLICKUP_OAUTH_REDIRECT_URI` when set; pin that in
  production.
- **Keep `&state=`.**
- **"Unable to authorize your teams" is config, not code.** Compare `/auth/debug`'s
  redirect and client id with the ClickUp app registration.

## 10. Folio Excel and Leadli AI financials

Folio: `folio-financials-api.js` + `portal-folio-fin.js`.
Leadli: `leadli-financials-api.js` + `portal-leadli-fin.js`.

- **Data sources:**
  - Billing: Whop data.
  - Folio: `subscription_client`, `subscription_plan`, `sales_payment`.
  - Leadli: the payment stream.
- **NULL is "Not set", never 0** (e.g. Folio `units_managed`).
  - A partial total states its coverage ("from 1 of 3").
- **Never count `lead.is_client`** as clients. It is wrong: it includes test and
  internal records.
- **Test payments:** the two $1 tests are excluded by `IS_TEST` (a notes text plus a
  Whop-anonymised email, applied together). This is provisional;
  `sales_payment.is_test` is Jay's call.
- **Dates:** slice the ISO string; never format through the viewer's timezone.
- **Company scoping:** `transaction` has no `company_id`.
- **Leadli has little or no payment data.** The empty state is the feature; it fills
  in as Whop webhooks arrive.

## 11. Design system and UI conventions

- **`public/tokens.css` is the only palette:**
  - Graphite (dark, the default) and Light stone, IBM Plex Sans / Plex Mono.
  - Every surface loads it.
  - Theme via `data-theme` on `<html>`.
  - Use token names (`--bg`, `--panel`, `--ink`, `--accent`, `--good/--warn/--crit`,
    …). There is no `--ink-1`. Never hard-code colours.
  - The command-center indigo is history.
- **Labels and text:**
  - Sentence case everywhere: no ALL-CAPS labels, eyebrow labels or "A · B · C"
    strings.
  - Red/amber/green only for meaning.
- **Tables:**
  - Total rows get the light band highlight.
  - Frozen header and first column.
- **Values:**
  - "–" = not available.
  - **red "–"** = missing data that should exist (market value, debt service, DSCR).
  - Never show 0 for unknown.
- **Loading:** `PortalLoader` (`portal-loader.{js,css}`, from
  `docs/mockup/loader.dc.html`) is the only loading component.
  - `full(name)` (88 px logo) for a section load.
  - `small(label)` beside a panel being refreshed, with the old content dimmed.
  - Hidden for 250 ms, then shown for at least 400 ms.
  - Never a blank page, never the bare word "Loading".
- **Motion:** fast ease-out, ≤ 200 ms, only for state changes. The view fade runs
  only on a page or tab change. `prefers-reduced-motion` is respected.
- **Scoping:** `portal.html` styles `.btn`, `.chip`, `th` and `table` globally;
  `portal-props.css` undoes that under `.lw`. Keep new Properties class names under
  `.lw` / `lw-`.
- **Helpers:** money via `money()` / `money0()` / `moneyk()`. Escape everything
  rendered with `esc()` (or the module's own escaper).

## 12. Buildings, SOV and data quirks (also used by /ops)

- **Property counts:** `property` has ~170 rows, of which ~80 are held.
  - Lists default to `ownership_status = held`. Clearing a filter returns to held,
    not all.
  - `property.status` is operational and unrelated to ownership.
- **Loans:**
  - A loan reaches a property directly OR through one of its buildings
    (`loan_collateral` at either level).
  - Debt = latest balance per loan.
  - De-duplicate co-owned properties by id.
- **Escrow** lives only on `public.loan`. `loan.escrow_types` and the
  `unit.*_escrow` columns are empty decoys.
- **`v_sov` is a VIEW. Never write to it;** route each column to its own table and
  log every cell to `sov_edit_log`.
- **Corrupted or misleading columns:**
  - `property.dog_park` is corrupted; do not display it.
  - "Flood Insurance" structure types are insurance lines, not buildings.
  - `unit.year_renovated` does not exist.
- **Status tables:**
  - `account_balance` rows are all unverified drafts.
  - Data Tracker, Cash & Debt and the SOV editor views exist with no portal screen.
- **Partial lists by design:** some held properties have no managing entity and some
  values have no date. Show them, never hide them.

## 13. Liquid Lending Solutions

- **Today:** Overview and Financials show empty states.
- **Data available** for the planned dashboards (mockup in `docs/mockup/shell.dc.html`,
  LL pages):
  - QuickBooks GL: `v_gl_pnl_monthly` (Jan–Aug 2026) and `v_gl_balance_sheet`
    (Aug 31; balances; net income ties to the P&L).
  - `investor_loan` (47 notes) and `investor_payment`.
- **No borrower-level loan data exists.** Do not invent loan-book detail.

## 14. Environment variables (Railway; never commit secrets)

**Read by the code:**
- ClickUp: `CLICKUP_API_TOKEN`, `CLICKUP_TEAM_ID`, `CLICKUP_LIST_ID`,
  `CLICKUP_OAUTH_CLIENT_ID`, `CLICKUP_OAUTH_CLIENT_SECRET`, `CLICKUP_OAUTH_REDIRECT_URI`
- Supabase and data: `SUPABASE_DB_URL`, `DATA_SOURCE` (=`supabase`), `SUPABASE_URL`,
  `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE` (server only),
  `SUPABASE_WEBHOOK_SECRET`
- Connector and access: `MCP_ROLE_SECRET`, `CONNECTOR_INVITE_URL`,
  `CONNECTOR_INVITE_SECRET`, `CONNECTOR_MCP_URL`
- Reports: `REPORT_EMAIL_SECRET`, `REPORT_EMAIL_WEBHOOK_URL`, `REPORT_SCHEDULER`
- Live sync: `SSE_COALESCE_MS`, `SSE_MAX_CLIENTS`, `SSE_MAX_PER_IP`, `SSE_PING_MS`
- Other: `PROPERTIES_READ_ONLY`, `OWNER_EMAIL`, `AGENT_TIMEZONE`
- GHL pairs: `GHL_TOKEN_<NAME>` / `GHL_LOCATION_<NAME>`

**Regenerate this list rather than trusting it:**

    grep -ohE "process\.env\.[A-Z0-9_]+" *.js config/*.js | sed 's/process.env.//' | sort -u

**Rules:**
- **Never set `PORT`.** Railway injects it, and setting it breaks the deploy.
- **Do not copy command-center's `.env`.** Its variables are not this app's.
- **Failures surface per request, not at boot:** a bad `SUPABASE_DB_URL` or
  `AGENT_TIMEZONE` does not crash startup.

## 15. n8n workflows used by this app

| Workflow | ID | Used by |
|---|---|---|
| Report email (dashboard reports) | `ghGUvzmOC19PUwMO` | Reports send and schedules (Graph `/me/sendMail` as Jay; keeps no execution data) |
| Connector access email (dashboard invites) | `G6O73UaJOyKNjpMG` | "Email Claude connector setup" in Roles & permissions |
| New GHL Contact to Database, Leadli FB ads | n/a | Write leads and ads with the service role |

Workflows owned by the sync repo (SMS code, sign-in link, Dropbox upload, alerts,
watchdog) are documented there.

When editing n8n, keep changes additive (parallel branches, continue-on-fail).

## 16. Live sync (realtime)

- **Flow:** Postgres trigger → `POST /api/hooks/supabase` → SSE `/api/events` →
  `public/portal-realtime.js`.
  - Events carry table names only, never row data.
  - `TABLE_VIEWS` maps tables to views; keep it in step with the queries.
- **On reconnect** every view is marked dirty (there is no replay buffer).
- **The hub is in-memory and single-instance.** If the service ever scales out, move
  it to Postgres `LISTEN`/`NOTIFY`.
- **Applying the webhook migration:** `migrations/20260810_supabase_webhooks.sql` may
  only be applied after `/api/events/health` reports `secretConfigured: true`.
  Confirm with Jay whether it has been applied before relying on push refresh.

## 17. Working habits (these prevent most regressions)

1. **Query, don't believe.** Before reasoning about why a screen is empty or wrong,
   read what the deployed server returns (`fetch(...)`, `select count(*)`,
   `explain analyze`).
   - A missing key or a NULL column fails silently as a blank.
   - A described artifact (a brief, a local copy, a memory) is not evidence.
2. **Verify the DEPLOYED build.** Fingerprint it by something only the new build has
   (a file, a header, a string) before saying a fix is live.
3. **A probe disproves only the names it tries.** "Not in my candidate list" is not
   "absent". Confirm with a real query.
4. **A near-matching count is a warning, not confirmation.** Check the mechanism.
5. **Measure the server, not your latency.** Measure the instrument too: verification
   helpers have shifted dates before.
6. **Move both sides of a rename in one commit** (payload key and consumer).
7. **Tests:** `test/expected.json` and similar expectations are written from intent,
   never derived from the code under test.
   - A fake that never parses SQL proves nothing about SQL.
   - Live-data checks belong in the live-data suites.
8. **One complete spec beats incremental messages.** When asked to build from a
   mockup, port the mockup's markup, CSS and logic exactly. Report once at the end
   with a checklist marked Done / Not done (and why).

## 18. Open items (decided to do, or waiting on Jay)

1. **Economic occupancy inputs:** total expected income and recurring fee income are
   not loaded for any property, so the column is a red "–". Needs a source.
2. **Brent Village owner name:** the database says "BVP, LLC"; Dropbox and AppFolio
   say "Brent Partners". Waiting on Jay.
3. **Liquid Lending dashboards** (Overview, Financials, Investor notes) from the
   shell mockup.
4. **The Beverly:** $7,500/month other interest is unexplained by its loan on file.
5. **Duplicate property records** (Carter Place K; Grandview / 15 Unit SC): cleanup
   items. Do not delete without approval.
6. **QuickBooks per property LLC (coming):**
   - Loan balances from balance sheets.
   - Principal = month-over-month balance decrease; this retires
     `interest_only_books`.
   - Investor payments.
   - Map the loan accounts to `loan.id` before building anything.
7. **Oct–Dec 2025 monthly data** is being backfilled by the sync. Show "–" until it
   lands; never estimate.
8. **Legacy cleanup** (after Jay confirms): retire `/ops` and the unrouted legacy
   modules and APIs listed in section 3.
9. **`am-fee-rules.js` vs `reporting.am_fee_month`:** no automatic agreement check
   exists yet.
10. **`sales_payment.is_test`** column (Folio test payments), Jay's call.

## 19. Tests and tools

    npm install --no-save playwright express

**Shell, Home and access**

    node test/test-shell.js            # rail, menus, gates, memory, shortcuts, no capitals
    node test/test-home.js             # a task in two businesses appears once; never the shared token
    node test/test-home-panel.js       # task pop-up: status, due, assign, comments, refusals
    node test/test-access-parity.js    # same rows via dashboard API and connector role (live)
    node test/test-access-ui.js
    node test/test-identity.js
    node test/test-login.js
    node test/test-routes.js
    node test/test-oauth-url.js

**Properties, custom views and reports** (live data)

    node test/test-props-ui.js [--shots]         # acceptance figures on screen
    node test/test-props-flicker.js [--baseline] # nodes kept, fades, requests, layout
    node test/test-views-parity.js               # browser preview == server evaluation
    node test/test-reports-ui.js [--shots]
    node test/test-report-scheduler.js

**Rules, pure and live**

    node test/test-am-fees.js
    node test/test-datasets.js
    node test/test-acceptance-math.js
    node test/test-portfolio-setup.js
    node test/test-sov-properties.js
    node test/test-maturity-wall.js

**Other modules**

    node test/test-folio-financials.js
    node test/test-leadli-financials.js
    node test/test-financials.js
    node test/test-ghl.js
    node test/test-realtime.js
    node test/test-task-cache.js
    node test/run-tests.js             # /ops: counters, membership, themes

**Tools**

    node tools/dry-run-migrations.js <files>   # apply in a transaction, check, roll back
    node tools/apply-migrations.js <files>
    node tools/refresh-reporting.js            # after any T12 or rent roll load
    node tools/side-by-side.js                 # live vs mockup screenshots -> docs/screenshots/compare/
    node tools/mockup-shell.js                 # render the shell mockup
    node tools/shot-pages.js / shot-loader.js  # screenshots
    node tools/check-folio-sql.js              # EXPLAIN every Folio statement (needs SUPABASE_DB_URL)

**Known environment artefacts** (not product bugs):
- `run-tests.js` reports one failure in the sandbox: staff headshots are hotlinked
  and there is no outbound network.
- Timing checks: if one goes flaky, ask what it is really measuring before widening
  the wait.

## 20. Guardrails

- Never commit secrets. `.env` is gitignored.
- Never send the service role key or a connector token to the browser.
- Do not break `/api/*` or `/ops` while they are still served.
- **Ask before:**
  - destructive or schema-altering migrations;
  - changing auth or the access model;
  - adding a framework or build step;
  - deleting data or records;
  - re-adding a removed screen.
- Test locally (`npm start`) and run the relevant suites before pushing. After
  deploying, verify the live site (section 17).
