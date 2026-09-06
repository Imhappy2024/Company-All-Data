# CLAUDE.md — LeavenWealth Group "Company-All-Data"

Read this fully before doing anything. It is the source of truth for the project.
When you change architecture, update this file in the same commit.

## What this is
An all-company internal portal + dashboards for LeavenWealth Group (one company,
several brands). Two front ends are merged into ONE Express service:

- `/`     → **portal** (`public/portal.html`) — a **sidebar app shell with brand-as-workspace**.
            The workspace switcher (top-left) picks a brand (Executive Board / LeavenWealth / Leadli AI /
            Folio Excel / Liquid Lending); each brand shows only its own nav + accent colour.
            LeavenWealth: Overview, Properties, Loans + workspace core
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
- Portal **Properties** is **NATIVE** — the iframe is gone. See "Properties: the command-center
  port" below. Property Tasks stays out of the Properties view.
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
- **Roadmap:** Properties is done (native). Port Property Tasks and Loan Views the same way,
  then retire `/ops` and `public/index.html`. Until then the remaining embeds are the bridge.

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
  `user_id` only on acceptance — and is rendered as a green **"Invite sent"** chip at
  the right edge of the Person cell, between the name and the role. It clears itself:
  nothing in the app resets it, because `handle_new_user()` fills `user_id` the moment
  the person sets a password and signs in. Those rows are
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
- **Adding someone is a typed form — first name, last name, email — not a staff
  picker.** A new hire is not in `staff` yet, and a picker made that the one case the
  screen could not serve; the form creates the staff record alongside the login.
  `staff` has a unique index on `(tenant_id, lower(email))`, so an address matching an
  existing person must **UPDATE** that row, never insert a second one — that guarantee
  is the server's, and the UI surfaces the match ("already belongs to X") as the
  address is typed, along with any access they held before a revoke.
- **Avatars come from `staff.avatar_url` everywhere**, with the initials chip rendered
  *underneath* the photo so dropping a broken `<img>` reveals it with nothing to
  re-render — `avatarChip()` in portal-users.js, `staffPhoto()`/`renderIdentity()` in
  portal.html. The headshots are hotlinked from `static.showit.co`, so that path is
  live. `object-position: 50% 20%`, because a centred square crop of a portrait cuts
  the top of the head off. **Test fixtures must use a `data:` URI** — the sandbox has
  no outbound network, so an http URL fails, the fallback strips the img exactly as
  designed, and the result is indistinguishable from the feature being broken.

### Team directory reads live staff
`GET /api/team` returns every **active** staff row; `V.team()` and the profile drawer
in portal.html render it. `is_active` is filtered here and deliberately *not* on Users
& Roles: a directory answers "who works here now", while Users & Roles answers "who can
get in", where a departed person still holding access is the most important row.

The job title is `staff.title`, **not** `staff_company.role` — `staff_company` has one
row per person per business (Brian Nelson two, Jay Delgado three), so joining it lists
people two and three times.

Five staff rows have no title, bio, photo or phone, and one has an avatar URL sitting in
`description`. A description that is only a URL is dropped server-side rather than
rendered as somebody's About text. The baked `STAFF` array now serves **only** the org
and department charts, which encode reporting lines the database does not hold.

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

## Verify the DEPLOYED artifact, never a local copy of it

This cost two days, from both directions, and it is the single most useful habit in
this repo.

**What happened.** A patched `supabase-properties.js` existed in a sandbox and was
described in a brief as "the data layer already exposes the new fields". The pushes
carrying it had 403'd, so the repo still had the pre-SOV version. Three commits of
correct Properties UI were built against payload keys the server has never emitted.
They rendered empty and read as filter bugs, so two further rounds were spent
diagnosing the filters — "options built from filtered rows", then "a loan attribute
looked up at property level". Both were plausible. Both were wrong.

**What settled it in one command:**

```js
fetch('/api/properties').then(r => r.json()).then(d => {
  const p = d.entities.flatMap(e => e.properties)[0];
  console.log(Object.keys(p));                       // no ownership_status/parcels/deal
  console.log(Object.keys(p.buildings[0].fields));   // no 'occupancy / type of asset'
});
```

**The rule.** When a screen is empty or wrong, read what the server actually returns
before reasoning about the code that consumes it. A missing key fails SILENTLY as an
empty string — it never throws — so it is indistinguishable from a logic bug by
inspection, and reasoning will produce a confident wrong answer every time.

The same rule caught two other faults this week: a `Cache-Control: no-store` header
proved a build was current when reasoning said it could not be, and Supabase
`edge_logs` showed a query returning 200 while the screen displayed its error, which
turned out to be a cached HTTP 300 replayed from disk with no request reaching the
server at all.

**It is silent in BOTH directions, which is why it has to be reflexive.**

| Described artifact | What you get instead of an error |
|---|---|
| A payload key that is not emitted | `''` — reads as an empty filter, a blank field, a short list |
| A column that is null on 72 of 75 rows | a filter that matches nothing, forever |

Neither throws. Both look exactly like a logic bug in the consuming code, so the
instinct to "read the code more carefully" is precisely the wrong move — it produces a
confident wrong answer, twice in a row, as it did here.

This runs both ways between people too. One side asserted a file's contents from a
local copy and the other built on it; the other side asserted a column's contents from
memory and the first checked before building. Same failure, opposite directions, one
rule: **do not build on a described artifact — query it.** A `select count(*)` or a
`fetch()` costs one command and settles what an hour of reasoning cannot.

**Corollaries.**
- Fingerprint a deployment by something only the new build has — a header, a file, a
  string — rather than by whether the fix "should" be live.
- `query_logs` on `source = 'edge_logs'`, filtered by `log_attributes['request.path']`,
  shows every request and status. Read it before touching a query.
- If a payload label is renamed, move BOTH sides in one commit. `propNorm(label)` is
  the key the UI reads; splitting the rename reproduces exactly this failure.

## Properties + the SOV data model (imported Aug 2026)

**The vocabulary changed and the old table names lie.** Read this before touching
`/ops#tab=properties`.

| Concept | Lives in | Trap |
|---|---|---|
| Property | `property` | 168 rows, only **79 held**. 84 sold, 4 demolished, 1 not owned. |
| Building | `unit` (badly named) | `unit_identifier` = "Building 1". **268 rows.** |
| Apartment | `unit.current_total_units` | **2,434 total.** Counting `unit` ROWS as apartments is wrong. |
| Parcel | `property_parcel` | Many per property (one has 47). `property.parcel_id` was DROPPED. |
| Offering | `deal` (42 rows) | The old pipeline table was renamed to `acquisition`. |

Verify UI work against: **Copperleaf** 5 buildings / 87 apartments (incl. a garage and
a street shed at 0), **Sierra Gardens** 235 + 0, **Bancroft Place** 8 + 8 garages,
**Boulder Pointe** 13 + 13. `test/test-sov-properties.js` pins all four.

### Ownership status defaults to `held`
84 of 168 properties are sold. Without the default, every list, count and roll-up is
dominated by assets the group no longer owns. **Clear returns to `held`**, not to all
168, and the default deliberately does NOT count as an active filter — otherwise the
screen looks filtered the moment it loads and people clear it without knowing why.

`property.status` (Under Development / Stabilized) is **operational** and unrelated to
`ownership_status`; a sold property can still read Stabilized. Both are shown, labelled
distinctly.

### "Residential only" is defined by EXCLUSION
`SOV_OUTBUILDING` lists garage, street shed, flood insurance, vacant land, clubhouse,
corporate office, HOA unit. **56 buildings have a NULL `structure_type` and hold 123
apartments between them**, so an inclusion list would silently drop them from exactly
the unit maths the toggle exists to serve. Unknown stays visible.
Dropdowns are built from the data, never a constant — the live set contains a bare
`Residential` value that no hand-written list had.

### Rendering rules that are easy to get wrong
- **Apartments = SUM(`current_total_units`)**, never the building count.
- **Buildings sort residential-first with a NATURAL comparator.** Plain string order
  puts "Building 10" before "Building 2" — visible across Boulder Pointe's 13.
- **`0` units on a garage is COMPLETE data**, not missing. Null is different, and the
  sheet usually carries `unit_count_note` ("Industrial", "2 Bed / 1 Bath") instead.
- **Outbuildings have `location_street = NULL` on purpose** — they share the parent's
  address. Fall back to it and say so; never render blank.
- **Insurance limits are a BASIS plus sometimes a number.** 142 of 262 Business Income
  rows are `actual_loss_sustained` (uncapped). Render the number alone and a fully
  populated policy looks like an empty form. The composed fields are suppressed from
  the generic grid via `SOV_RAW` so they are not printed twice.
- **Wind/hail is a percentage with a floor**, often per building: `3% / $25,000 min
  (per building)` from the structured columns.
- **Tri-state flags** (fire alarm, sprinklered, escrow): true / explicitly-false /
  never-stated are three different answers. A dashed outline carries the third.
- **`unit_count_verified` leads**; `unit_count_reported` shows as a secondary only when
  it disagrees — it is often just the first building's count.
- Parcel numbers keep their dashes and periods (`216-13-0-10-01-007.00-0`) and render
  verbatim in a mono chip.

### Escrow: the verification targets, and why the obvious query is wrong

`loan_collateral` holds **both levels** — 42 rows keyed by `property_id`, 15 by
`unit_id`. A loan can be secured against a property OR against a building inside it,
so a property "has an escrowing loan" when either is true. `p.loans` unions both; that
is the BUG-1 behaviour, and it is correct.

Joining only `loan_collateral.property_id` under-counts and looks authoritative while
doing it. **Bancroft Place settles it**: zero property-level collateral rows, one
unit-level. The narrow query reports "Bancroft has no tax escrow" while its eight
buildings demonstrably do.

**Correct targets** (property → collateral at EITHER level → loan). Identical with or
without the held filter, because every matching property is held:

| Filter | Properties | Loans |
|---|---|---|
| Taxes | **16** | 20 |
| Insurance | **3** | 4 |
| Replacement reserve | **10** | 11 |
| Any (`has_escrow`) | **19** | 23 |

`has_escrow` and "any of the three booleans" agree at 19 (and at 23 on loans), so the
separate Any toggle cannot disagree with the multi-select beneath it.

Superseded figures — `Taxes 9 · Insurance 1 · Replacement 6 · Any 12` — are
property-collateral-only. They are recorded here because they were circulated as
expected values: **read against correct behaviour they look like failures.**

Escrow lives ONLY on `public.loan`. Two decoys are empty and must not be read:
`loan.escrow_types` (0 rows, deprecated) and `unit.tax_escrow` /
`insurance_escrow` / `replacement_reserve` (0 rows each, legacy).

**A near-matching count is disconfirmation, not confirmation.** Reaching loans through
`borrower_entity_id` gives 13 properties against an observed 16 — close enough to look
like the cause, and it was not. Seven of the sixteen have no escrowing loan naming
their entity at all, which rules that path out entirely. Both times a plausible
mechanism nearly matched here, it was wrong; check the mechanism, not the proximity.

### Known data quirks — do NOT "fix" these in the UI
- `property.dog_park` is CORRUPTED in the source (contains addresses). Do not display
  it; use `dog_park_count` once the sheet is realigned.
- `Flood Insurance` structure types are insurance lines, not physical buildings.
- **`unit.year_renovated` does not exist** — only `property.year_renovated`. The
  original brief asked for it per building; there is no column to read.
- Only **6 loans** carry `lender_id`, so the mortgagee clause is rare. `loan.lender` is
  free text kept for the old label; `lenderRecord` is the normalised row and is joined
  in code (not embedded) so a loan without one still renders.

## Three screens specified but NOT built (database layers done)

Data Tracker, Cash & Debt quarterly, and the SOV editor. Every view exists and every
figure below was verified live before any UI work started.

| Object | Rows |
|---|---|
| `v_tracker_megan` | 36 |
| `v_tracker_mitch` | 10 |
| `v_sov` | 268 (one per building) |
| `v_sov_tax_filers` / `v_sov_entities` / `v_sov_properties` / `v_sov_buildings` | 34 / 110 / 168 / 268 |
| `v_cash_debt_summary` | 2026 Q1 cash $6,291,363.69 debt $229,329,779.11 (168/58); Q2 $5,073,105.35 / $225,424,320.06 (160/55) |
| `account_balance` unverified | **441 of 441** |

### The tracker badges count OUTSTANDING work, not rows
The spec asked for badges of 36 and 10 "from `v_tracker_counts`". Those are different
numbers, and the view is the correct one:

```
Megan  36 rows = 32 open + 4 resolved                    -> megan_open = 32
Mitch  10 rows = 3 open + 4 blocked + 1 waiting + 2 done -> 8 outstanding
```

`v_tracker_counts` excludes finished items; the list views return everything. A badge is
a workload signal, so it must count what needs doing — building to the row totals puts
resolved and done items in it. Use `megan_open` and `mitch_exceptions + mitch_tasks`,
and expect the badge to be SMALLER than the list it opens. That is correct, not a bug.

### Cash & Debt: every balance is a draft
All 441 rows are `is_verified = false`, from a source marked "DRAFT REQUIRES MITCH
HAGEN VERIFICATION". The screen must say so. `v_cash_debt_summary` exposes
`all_verified` (currently false) so the badge can be driven from data rather than
hard-coded.

Only 2026 Q1 and Q2 exist. Offer only quarters present in the data — rendering an empty
Q3 as zeroes states a fact nobody has.

`cash_source` is Bank (192), Buildium (42), PM-Bank (17), AppFolio (5). Buildium and
AppFolio are property-management systems, so those accounts legitimately have no
institution or last4; that is not missing data.

### SOV editor: `v_sov` is a VIEW — never write to it
It returns `building_id`, `property_id` and `entity_id` on every row so each column can
be routed to its own table: entity (tax filer, quarterly reports, tax projection),
property (name, purchase, market value, manager, ownership), unit (address, units,
occupancy type, sqft, year built, stories, alarms, construction, counts),
insurance_policy (carrier, renewal, deductibles, premium, limits, TIV), loan (lender,
escrow, DSCR), property_parcel (parcel id).

**Never write `property.unit_count_reported`** — it is the immutable source-document
figure, and it is the column that produced the wrong 1,355 unit total. Corrected counts
go to `unit_count_verified` with `_by`, `_at` and `unit_count_note`.

Every cell change logs to `sov_edit_log` (target_table, target_id, column_name,
old_value, new_value, edited_by).

Insert conventions, all recorded in `schema_changelog`: a building is identified by
`(property_id, unit_identifier)` and never by address, because several buildings share
one address and outbuildings have none; outbuildings get `location_street = NULL` and 0
apartments rather than a copy of the parent's address; parcels split on `A / B` into
separate rows keeping dashes and periods; insurance limits carry a basis, and where
there is no number the basis IS the value.

## The design, and where it came from

The whole service now wears command-center's design: indigo on a near-black indigo
ground, Space Grotesk / Instrument Sans / JetBrains Mono, 8/11/16 radii, and mono
uppercase micro-labels on every chip, pill and small button.

All of it lives in `public/tokens.css`. That is the point of the file — one edit
re-themes the portal, `/ops`, `login`, `invite` and `portal-properties.css`
together, and nothing downstream needs to know a colour changed.

| | |
|---|---|
| Ground / card / raised | `#0E1120` / `#161A2C` / `#1D2238` |
| Accent (was `--brass`) | `#7C6CFF` |
| Good / bad / warn | jade `#35D0A5` / rust `#FF5A45` / amber `#FFB020` |
| Ink, four levels | `#EDEFF8` `#C7CCE4` `#9BA2C2` `#828AB0` |
| Radii | `--r-sm 8` `--r-md 11` `--r-lg 16` |

### Four levels of ink, not three
The source design has `--cream --text --dim --dimmer` and uses all four; this file
had three. `--ink-4` was added rather than collapsing dimmer into `--ink-3`,
because every label/value pair on the page relies on that fourth step and
flattening it makes labels compete with their own values.

### Status and series share hues here — that has a cost
command-center uses ONE colour set for both, so `--s3` and `--good` are both jade,
`--s2` and `--crit` are both rust. That contradicts this file's older rule that
status colours are never reused as series colours, and it was adopted knowingly:
a chart in this palette **must not lean on colour alone** to say good or bad,
because the same jade means "category three" two panels over. Label the series.

The four series hues do still separate under colour-vision deficiency, which was
checked rather than assumed — violet / red-orange / green-cyan / yellow. Under
deuteranopia the last three collapse toward the yellow band, so they separate by
lightness instead: rust dark, jade mid, amber bright. Swapping a hue means
re-checking that.

### The light theme is derived, not inverted
command-center is dark-only, so there was nothing to copy. The light block keeps
the same indigo and the same status hues, re-stepped for a light ground. Inverting
the dark values instead would make one theme a photographic negative of the other
rather than two members of one family.

Dark is the portal's default (`theme='dark'` in portal.html), so the adopted
palette is what loads.

### `--shadow` stayed a hairline ring
The source design's shadow carries an inset top highlight and a deep drop. Plenty
of surfaces here use `--shadow` **instead of** a border, and giving them a drop
shadow alone strips their outline and adds a glow. Depth went into `--shadow-pop`,
which is the token that carries the inset highlight. Do not "finish the job" by
moving it into `--shadow`.

### Typography is applied in portal.html, not in tokens.css
A variable can carry a typeface; it cannot carry how the type is used, and that is
most of what makes the design recognisable. The adoption block at the end of
portal.html's `<style>` is where headings take `--font-display`, micro-labels take
tracked uppercase mono, and the active nav row becomes an indigo edge plus a tint
rather than a solid fill. It **layers over** the existing component rules instead
of rewriting them, so the diff says exactly what changed and a rule that was
already right is left alone.

Space Grotesk is wider-set than Inter, so the display sizes carry less negative
tracking (`-.006em` where Inter had `-.012em`). Keep Inter's value and the
counters close up at 19px.

### login.html and invite.html are surfaces too
Both load `tokens.css` and both had their own hard-coded Inter link and
`font-family:Inter`, so they inherited the new palette but kept the old typeface —
a half-adopted look that is easy to miss because nothing errors. They were found
by measuring, not by reading: a headless check of `/` kept reporting Inter, which
turned out to be the **login page**, because `/` bounces there without a session.
If a design change looks like it did not land, check which document you are
actually measuring before touching the CSS.

## Properties: the command-center port

Portal Properties is the implementation from `Imhappy2024/command-center`, running
natively. The `/ops` iframe is gone.

| Piece | command-center | here |
|---|---|---|
| List + tree + roll-ups | `routes/properties.js` | `portfolio-list.js` |
| One record + every write | `routes/property-detail.js` | `portfolio-detail.js` |
| Section CSS (`pr-` prefix) | inline in `public/index.html` | `public/portal-properties.css` |
| Section JS + markup | inline in `public/index.html` | `public/portal-properties.js` |

### It is mounted at `/api/portfolio`, NOT `/api/properties`
This service **already serves a different Properties payload** at `/api/properties`
to `/ops` and the SOV screens, and already has `/api/properties/:taskId/comments`.
Two shapes on one path is the exact failure "Verify the DEPLOYED artifact" opens
with: the key the caller wants is simply absent, which reads as an empty string and
never as an error. When `/ops` is retired the path can shorten; until then, do not
merge them.

### What changed on the way over, and nothing else
1. **The nine fetch URLs** point at `/api/portfolio`.
2. **`escS` / `toast` / `tkRel` are defined in the module.** command-center is one
   16k-line `index.html` where those are page-level helpers; the portal is split
   across files, so the module carries its own rather than depending on a load
   order it cannot see. `toast` builds its own `#pr-toasts` host on first use —
   command-center's wrote into a `#so-toasts` that only exists on that page, and a
   failed save reporting nothing is worse than an unstyled notice.
3. **An IIFE exposing `window.PortalProperties`**, because `PR`, `PD` and ~38 `pr*`
   functions would otherwise sit in the same global scope as portal.html's.
4. **`mount(host)`.** command-center wired itself at parse time against markup
   already in the document. The portal builds a view on navigation, so the two
   element-level listeners from the bottom of the original file moved into
   `mount()`, and the boot fetch is deferred to first mount.

`ghlQuery(sql, params)` → `db.q(sql, params)`: same signature, same `{rows}`.

### `.onclick =`, not `addEventListener`
`mount()` runs on **every** navigation back to Properties. `addEventListener` there
stacks a fresh copy per visit — N listeners, N refreshes per click. That is the
same bug the Users screen hit with its focus listener. The document-level Escape
handler binds once behind a `keysBound` guard for the same reason.

### The palette is shimmed, not pasted
command-center is dark-only and names colours `--brass --cream --jade --rust
--panel2/3 --edge/2 --ink2`. The top of `portal-properties.css` maps those onto
tokens.css names. Paste the hex values in instead and Properties is a dark
rectangle in a light page, and it silently stops tracking the design system the
moment anyone retunes it. `--i` and `--c` are deliberately absent from the shim:
the JS sets both inline, per row.

### The numbers keep their original guards
These came across intact and are the reason the port was worth doing rather than
rebuilding:
- **Apartments are `SUM(unit.current_total_units)`.** `unit_count_reported` holds
  only the FIRST building's count — one property reads 26 against a real 87.
- **A loan reaches a property directly OR through one of its buildings**
  (`loan_collateral.property_id || unitOwner.get(unit_id)`). Counting only the
  former misses real debt. Same union the escrow section argues for.
- **The roll-up deduplicates by property id via a Set.** Co-ownership otherwise
  counts one property once per owner — $124M against a real $31M.
- **Debt is the latest balance per loan**, never the origination amount.
- **`loanRate()` prefers `interest_rate_pct`** and parses `interest_rate` text only
  when it is a plain percentage. Guessing at a spread over an index would be
  inventing a number.
- **`problems[]` distinguishes a missing TABLE from a missing COLUMN.** The `q()`
  wrapper tolerates the first and rethrows the second, so an empty screen says
  which it is instead of looking the same either way.

### Rendering, and where the write goes
Field labels come from the **server**, not from a snake_case-to-Title-Case
function: `dba_name` is "DBA Name / Name of Apartment Complex", the name the people
who maintain this data use, carried over from the ClickUp fields it was migrated
out of. Types come from `information_schema`, and that same lookup is what stops a
column name arriving from the browser from reaching a query.

Each field id encodes its own destination — `p:<col>`, `u:<unitId>:<col>`,
`l:<loanId>:<col>`, `f:<finId>:<col>`, `i:<insId>:<col>`, `ownerentity`,
`loanstatus:<propId>` — so the panel never has to know which table anything lives
in, and a column added in Supabase appears without touching the front end.

### In portal.html
`V.properties()` returns `<div id="propertiesNative"></div>` and `render()` calls
`PortalProperties.mount()` after `innerHTML` — the same arrangement as Tasks and
Users & Roles, and for the same reason: the module needs the element to exist
before it can wire it. Properties also takes the `wide` class (it was getting that
free as an embed; a 12-column grid in a narrow column is unreadable) and
suppresses the generic `page-h`, because it renders its own header and one screen
should carry one title.

`PortalProperties.invalidate()` is wired into the realtime `invalidate` callback.
It forces past **two** caches — the module's payload and the server's five-minute
one — because `property`, `unit`, `loan`, `ownership` and `entity` are all already
bound to the `properties` view in `TABLE_VIEWS`, and a stale read on this screen is
a wrong debt figure rather than a slow one.

## Financials: cash and debt

`/api/financials` (`financials-api.js`) + `public/portal-financials.{js,css}`.
Replaces the baked `V.financials()` KPI block — Cash $770,785 across "5
accounts", plus income, expenses and net. Three of those four could not have
been made live even in principle: `transaction` and `transaction_category` are
both **0 rows** pending the Buildium/AppFolio sync, so there is deliberately no
income statement, expense breakdown, category chart or NOI trend on this
screen. `property_financials` has 28 rows, which is not a portfolio.

### Read-only is enforced twice, because nothing downstream would catch it
The router refuses any method that is not GET/HEAD (405), and every SQL string
is checked against a write-verb pattern before it reaches the pool. That second
guard is not paranoia: `supabase-db` connects with `SUPABASE_DB_URL`, which is
the **postgres superuser**, so a stray write would simply succeed.

**Tenant scoping is this module's job for the same reason.** RLS never runs on
that connection — `current_tenant_ids()` is never called — so every query
filters `tenant_id` explicitly. A test asserts that every statement issued
against a relation carrying the column has the filter in it.

### The capability probe is the answer to "verify against the live database"
The brief says to verify every column live rather than trusting its list. That
was impossible while writing it: the repo has no `.env`. So the **server** does
the verification, once, at first use, against `information_schema.columns`, and
`problems[]` rides on every response.

That turns the silent failure into a sentence. A column named here that the
database lacks yields `undefined` → empty string, which on screen is
indistinguishable from "no data for this quarter" — the exact trap the
"Verify the DEPLOYED artifact" section opens with.

`caps` also does real routing work. `v_debt_by_account_quarter` is documented
with **names but no ids** (`entity`, `deal_name`, `lender`), while
`v_cash_by_entity_quarter` has both. Filtering by id is correct; filtering by
name is a guess when two entities share one. Each filter prefers the id form
and falls back to the name form only where the view leaves no choice.

### Two debt numbers that do not agree, and both are right

| Source | Q2 2026 | Grain |
|---|---|---|
| `v_debt_by_account_quarter` (**Debt** tab, default) | $225,424,320.06 / 55 accounts | loan-kind rows in `account_balance` |
| `v_debt_by_quarter` (**Loans** tab) | $15,223,209.45 / 3 loans | per-loan rows in `loan_balance` |

`loan_balance` is sparse and its dates are ragged, so quarter-filtering it drops
almost everything. Separate tabs, each with a note saying what it measures.
**They are never added, and neither is cash and debt** — different account
kinds, and the sum is a meaningless nine-figure number. There is no helper in
either file that could produce one, and a test asserts no field in the summary
payload equals cash + debt.

Coverage is printed beside the loan total (**54 of 75 loans** have any balance
row) because a bare total implies the other 21 are paid off. They are
unpopulated.

### Every balance is a draft — and the screen no longer says so anywhere
All 441 rows are `is_verified = false`. There is **no Verified column, no
Verified filter and no draft banner**: on a dataset where the value never
varies, all three were repeating one fact 441 times.

`is_verified` and the DRAFT line **still ride on every export** (via
`PROVENANCE`), and that is deliberate rather than an oversight. On screen the
reader has the context that these are quarterly draft snapshots; in a
spreadsheet mailed to someone else they have nothing. That is where the caveat
earns its place.

### Leadli and Folio are excluded, on a WORD BOUNDARY
This screen is LeavenWealth's. Leadli AI and Folio Excel are excluded from the
tables, the tiles, the filter option lists and the exports, with no toggle — a
control that could put them back would make every figure mean two things
depending on a checkbox nobody remembers setting.

**The word boundary is the whole design decision.** A plain `%folio%` also
matches "Portfolio Reserve" and "Portfolio Loan Escrow" — entirely plausible
account names here — and would drop real LeavenWealth money out of every total
with nothing on screen to say it happened. The pattern is
`y(leadli|folio)y` with `~*`.

Two independent tests, because either alone leaks:
- **by company**, catching a Leadli entity whose own name says nothing about
  Leadli. The ids are resolved *by name at boot*, not hardcoded, so a renamed
  or re-seeded company still resolves.
- **by name**, catching a row hanging off a NULL `company_id` — the one row the
  company test cannot see.

The company test is written `company_id is null or not (… = any(…))`, never
`<>`: a NULL has to survive, and SQL quietly turns "not one of these" into
false for it.

There is also **no Brand filter**. Deal and Entity already scope to one brand and
name it beside each option; a third control selecting the same rows another way
is a way to contradict yourself.

### The tiles do NOT come from `v_cash_debt_summary`
They are aggregated from the same relations and the same exclusion the tables
use. That view has no brand dimension, so reading it would put Leadli and Folio
money in a tile above a table that excludes them — two numbers on one screen,
both labelled Total Cash, disagreeing. **Expect the tiles to sit below the
brief's figures** ($5,073,105.35 / $225,424,320.06); that is the exclusion
working, not a fault.

### A date RANGE — and the tiles pin to one date inside it
From and To, both free-form and both optional, replacing the quarter dropdown.
Clearing both shows every snapshot.

**The table may span several snapshots; the tiles may not.** Every row carries
its own As Of Date, so reading Q1 beside Q2 is a real thing to want. But summing
a range covering both counts every account twice and yields roughly double the
truth while looking entirely plausible. So `/summary` pins the tiles to the
**latest snapshot inside the range**, and the header says which one whenever the
range holds more than one.

"As at" falls out of this for free: leave **From** empty, set **To**, and the
tiles land on the newest snapshot at or before it. A range containing no
snapshot yields no tiles at all rather than borrowing a balance from outside it,
which matches the empty table beneath. A backwards range is swapped, because
that is a slip rather than a request for nothing.

An account present in an earlier snapshot but absent from the pinned one is
therefore not in the tiles. With two snapshots that is rare, and the
alternative — a latest-per-account roll-up — **cannot be done on
`v_debt_by_account_quarter`, which carries no account id at all.**

`as_of=X` is still accepted and means a single day (`from = to = X`).

The URL uses `?q=` when both bounds are the same day and `?from=&to=`
otherwise, so the common case stays a short link.

### `account_purpose`, not `account_type`
`account_purpose` is free text holding the original source labels (Operating,
Loan, MM, Sec Dep, Reserve, CD, Savings, ICS, Other). `account_type` is the
lossy CHECK-constrained version: CD and Savings both become `savings`, MM and
ICS both become `money_market`. Both are offered as separate filters. When
someone asks for a source label, it is `account_purpose`.

`(none)` is a real selectable value under Institution, matched through
`coalesce(institution, '(none)')`, so the **six** accounts whose source showed
the bank as "?" stay reachable. Any nullable filter column gets the same
treatment — a value nobody can select is a row nobody can find.

### The two array-param forms are NOT equivalent
`deal[]=a&deal[]=b` is the contract and each value is taken **verbatim**.
`deal=a,b` is the compact form the page hash uses and it is **lossy on
purpose**: Express decodes query values before the module sees them, so by then
a percent-encoded comma and a literal comma are the same character and nothing
downstream can separate them. "Maples, Phase II" is a real deal name.

So the browser module uses the repeated form for every request, and reserves the
comma form for the hash — where it does its own split-**before**-decode and the
ambiguity never arises. When both are present, repeated wins.

### Exports carry provenance, and never credentials
Every export includes `as_of_date`, `source`, `is_verified`, `exported_at`,
`exported_by` and a human-readable `filters_applied`, regardless of which
columns are on screen. A figure that leaves this system without its as-of date
and its draft flag gets quoted back as fact.

The file is the **full filtered result set, not the current page** — the export
route ignores `page`/`per_page`. CSV gets a `#` comment block; XLSX gets an
`About` sheet instead, because a comment block above the header breaks every
pivot the person downloading it is about to build.

`NEVER_EXPOSE` (`portal_url`, `portal_username`, `portal_password`,
`mfa_method`, `mfa_required`, `bank_contact_email`) is applied to every row on
the way out, as a second line behind the per-tab column lists — so a column
added to a list by name cannot smuggle one through. **`portal_password` was
dropped from the schema on 2026-09-07; never reintroduce it in any form.**

### `.onclick =`, not `addEventListener` (again)
`paint()` re-renders the whole subtree on every filter change and `mount()` runs
on every navigation back. `addEventListener` there stacks a copy per paint and
fires N requests per click — the same bug the Users screen hit with its focus
listener. The one document-level listener (click-outside to close a filter
panel) binds once behind a guard.

Filter panels toggle an explicit `.open` class, never the `hidden` attribute.
The ops dashboard's multi-selects hit exactly that: the attribute flipped
correctly, a `display` rule elsewhere won, and the panel stayed invisible with
nothing in the console.

### Tests
    node test/test-financials.js     # 81 checks, no database needed

The brief's acceptance checks that need live figures ($5,073,105.35, 160 cash
accounts, 154 Operating) are Jay's to run. What this pins is everything that
would still be wrong if the figures were right: that the feature cannot write,
that tenant filtering is in the statement, that no filter emits an empty
`IN ()`, that two selections union rather than intersect, that an export
matches the on-screen filters and contains all rows rather than one page, that
a comma / quote / newline inside a value survives, that money exports as a bare
number and a measured zero as `0`, and that no credential field appears in any
response or file.

Two of those caught real bugs during the build: the summary was matching the
selected quarter against an `as_of_date` column that `v_cash_debt_summary` does
not have, so `current` came back null and every tile rendered "no data" over
data; and `arrayParam` was comma-splitting repeated params, which would have
torn "Maples, Phase II" into two filters matching nothing.

## Cash & Debt Summary: the entity rollup

The **By Entity** tab (default) on Financials. One row per entity, cash beside
debt: "which LLCs are holding cash, and what do they owe". The other three tabs
are the account-level detail underneath it.

`GET /api/financials/summary/entities`, `/:id/accounts`, `/export`.

### The join is a FULL OUTER JOIN and that is the whole point
At Q2 2026: 45 entities have both cash and debt, 15 have cash only, and **one
has debt only**. A LEFT JOIN from cash silently drops that one — the count reads
60 instead of 61, and an entity carrying debt with no operating account
disappears from a debt report. Nobody notices until the entity totals fail to
reconcile to the portfolio.

`coalesce(..., 0)` is on the **balances** but never on the entity join. An
entity with no bank accounts genuinely holds zero cash; an entity that does not
exist is a different problem and must not read as a zero.

### Accounts with no owner entity are REPORTED, not silently dropped
`financial_account.owner_entity_id` is nullable, and the rollup joins entity on
`coalesce(cash.entity_id, debt.entity_id)` — so an account with no owner is
dropped by that join. The Cash column then **cannot** sum to the account-level
tile, and nothing would say why.

`fetchEntityRows` measures that gap separately and returns it as
`unattributed`; the screen states it and so does every export. This is the
difference between a number someone can explain and a number someone finds with
a calculator.

### Cash can be negative; net position is meant to be about -$220M
Eight entities carry a negative cash balance. Nothing calls `abs()`, the sort
uses `nulls last` so a -$40,000 entity sits at the bottom of a descending sort
rather than dropping off an end, and negatives render in parentheses in the crit
colour per accounting convention — but **export as raw negatives**, because a
spreadsheet needs `-40000`, not `(40,000.00)`.

Net position across the portfolio is roughly **-$220M**. That is what a
leveraged property portfolio looks like: it is not an error state, the column is
not painted red, and there is no health indicator implying distress. It is
labelled **Net Cash Position** and it is **not equity** — property values are
nowhere in this calculation.

### Debt is loan-KIND ACCOUNTS, never `loan_balance`
`account_balance` where `account_kind = 'loan'` gives $225.4M across 55
accounts; `loan_balance` gives $15.2M across 3 loans. This view uses the first
and there is deliberately **no toggle** — `loan_balance` is sparse with ragged
dates and has its own tab.

### One row per entity means ONE snapshot
The view pins to the latest snapshot inside the date range, exactly as the tiles
do. A range covering both dates would otherwise give every entity two rows and a
totals line counting every account twice. The screen says which date it pinned
to whenever the range holds more than one.

### Institution and Purpose narrow the ACCOUNTS, before the rollup
Picking Dundee Bank shows each entity's **Dundee-only** cash, not its full
balance. That is deliberate and the UI says so under the chips — without the
note the totals look wrong to anyone checking them against the account view.

### Two spec bullets deliberately not followed
The brief lists a **Brand filter** and a **Verified column**. Both were removed
from the sibling account-level view by later instruction, and Leadli/Folio are
excluded from this screen entirely, so:
- there is no Brand filter (Deal and Entity already scope to one brand, and the
  option lists name it);
- there is no Verified column, but `is_verified` **is** in every export — which
  is what the brief's §2.6 actually requires.

The same brand exclusion applies here as everywhere else on the screen, so the
row count and totals will sit **below** the brief's figures (61 entities,
$5,073,105.35). That is the exclusion working.

### `has_cash` / `has_debt` are THREE states
Yes, No, and not filtering. A plain boolean collapses the last two, so an
untouched control would mean "hide everything that has debt". They test
`*_accounts > 0`, not `balance <> 0` — an entity with a loan account sitting at
zero still has debt on file.

## Removed screens: Investors, Insurance / Risk, Integrations

Removed 2026-09-07 by explicit instruction — the nav entries AND the `V.*`
functions behind them. All three were placeholders or baked demo data:
`investors` rendered a five-row hardcoded `INVESTORS` array, `insurance` and
`integrations` rendered a "coming soon" placeholder naming the table each would
one day read.

The view functions went with the nav entries rather than being left in place. A
screen with no route to it is one somebody eventually wires data into without
noticing nothing links to it.

**The data is untouched.** `insurance_policy` (257 policies, 21 carriers,
$435M TIV), `investor`, `investor_stake` and `integrations` are all still
there, and `/ops` still surfaces the loan/debt views. Only the portal screens
went.

`TABLE_VIEWS` in portal-realtime.js was cleaned in the same commit: bindings to
a view that no longer exists can never match, which is not a live bug but reads
as coverage that is not there. `insurance_policy` still refreshes `overview`.

**Still present, deliberately:** the Executive Board overview keeps its baked
"Investors" card, because it is a card on a dashboard rather than a menu. Say
the word and it goes too.

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
- **Design system: `public/tokens.css`** — the shared palette, geometry, type and dark
  theme, loaded by ALL FOUR surfaces (`portal.html`, `index.html`, `login.html`,
  `invite.html`) so they read as one product. **The palette, the three faces and the
  radius steps are adopted from command-center** (see "The design, and where it came
  from" below). Theme via `data-theme` on `<html>` (ops also honours `body.dark-mode`). Use the
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

### Task writes patch the cache; they must not dump it
`PUT`/`DELETE /api/task/:id` used to set `cachedTasksAt = 0`, expiring the whole
tasks cache. The next `/api/tasks` re-walked the entire ClickUp workspace — 21 spaces,
211 lists, ~4800 tasks — behind ClickUp's rate limiter, retrying at 60s. One status
change cost **minutes** of blank screen, and the app got slower the more it was used.
The cache was working; it was being thrown away.

`task-cache.js` patches the one task instead, from the object ClickUp's PUT returns.
The merge is **one level deep on purpose**: the walk enriches objects the single-task
response returns thinner — `space` is `{id}` there and `{id, name}` in the cache — so a
flat overwrite silently strips the name off every edited task. Arrays are replaced, not
merged, or unassigning everyone would keep the previous assignee. Anything it cannot
patch confidently falls back to expiring the cache: a slow read beats a wrong one.

**The same task is editable from two screens with two separate caches** — the property
detail overlay reads `allTasks`, the Property Tasks board reads `propTasksData` plus a
localStorage SWR copy (`lwPtaskCacheV1`). Both wrote to ClickUp and both were right
about ClickUp, but neither told the other, so whichever screen you were not looking at
stayed stale. Every write funnels through `updateTask()` in index.html, which is why
`taskChangedElsewhere()` lives there: it patches `allTasks` and **drops** the board's
cache rather than patching it, because the two shapes are built by different code paths
and a wrong patch is a silent lie on the screen people use to decide what needs doing.

### Tests
    npm install --no-save playwright express
    node test/run-tests.js       # task counters, membership, click-to-filter, nesting, themes
    node test/test-realtime.js   # secret handling, coalescing, keepalive, client caps
    node test/test-portal-nav.js # Tasks gating, URL state, PT board columns, marks
    node test/test-oauth-url.js  # authorize params, redirect_uri pinning, debug output
    node test/test-task-cache.js # task cache patching after a write (no network needed)
    node test/test-sov-properties.js # SOV rules: apartments, sorting, insurance basis
    node test/test-financials.js # financials: read-only, filters, export provenance

`test/expected.json` is written by hand from each fixture's stated intent, not
derived from the code under test. Keep it that way, or the tests lose the ability
to fail. `test-portal-nav.js` follows the same rule: its expectations describe the
intended behaviour, and its board fixture deliberately carries both spellings of
To Do and In Progress.

In the sandbox `run-tests.js` reports one failure, `no page errors ->
ERR_CONNECTION_RESET`: the staff headshots are hotlinked from static.showit.co
and there is no outbound network. That one is an environment artefact.

## Still baked
`V.overview()` in `public/portal.html` still hard-codes the LeavenWealth KPIs:
66 properties, 92% occupancy, $72K NOI, $2.04M debt across 3 loans. Three of
those are wrong. The database has **75 loans totalling roughly $106.5M**, and
occupancy is not derivable at all: `unit.occupancy` is free text and empty on all
224 rows, with no lease or tenant table. Investors, Leads and Appointments are baked too.
**Financials is now live** - see "Financials: cash and debt" above. Replacing them with live reads (or honest empty
states) is the next real piece of work.

## Current state (done)
- Schema + brand layer + RLS + seed data all live in Supabase.
- Ops dashboard is live (ClickUp+Supabase). Portal built with the 5-section layout.
- Merged into one service; portal at `/`, ops at `/ops`; Properties card embeds ops.
- Portal Tasks (per brand) is native and live; Overview/Property Tasks/Loan Views stay embeds.
- Portal **Properties is native** (ported from command-center); it no longer embeds `/ops`.
- Live sync built (realtime.js + portal-realtime.js); the Supabase migration is NOT yet applied.
- Portal Overview/Leads/Appointments cards are STILL baked demo data.
- Investors, Insurance / Risk and Integrations were REMOVED from the nav (and their
  views deleted) on 2026-09-07. See "Removed screens" below before re-adding one.

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
