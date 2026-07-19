# Kickoff prompt — paste this as your first message to Claude Code

You are working in the LeavenWealth Group "Company-All-Data" repo. Before writing any
code, do this in order and stop for my confirmation after step 4:

1. Read `CLAUDE.md` end to end. Treat it as the source of truth. Also read `README.md`,
   `SUPABASE_SYNC.md`, `PORTAL_INTEGRATION.md`, `server.js`, and `public/portal.html`.
2. Confirm the app runs: `npm install` then `npm start`. Verify the portal loads at `/`
   and the ops dashboard at `/ops`. Report anything broken. Do NOT change behavior yet.
3. Check that a `.env` exists with the variables listed in CLAUDE.md. If not, create
   `.env.example` (names only, no values) and tell me exactly which values to fill.
   Never print or commit real secrets.
4. Give me a short plan for Task 1 below (files you'll touch, approach, risks). Wait for
   my go-ahead before editing.

## Task 1 — Live data for the portal, safely
Goal: make the portal's cards read REAL data from Supabase instead of the baked demo data,
without weakening RLS.

- Add Supabase Auth to the portal (email magic-link is fine) and gate `/` behind login.
  Use `SUPABASE_URL` + `SUPABASE_ANON_KEY` in the browser (RLS enforces access). The signed-in
  user must have a `tenant_member` row; brand-restricted users additionally need `company_member`.
- Replace baked data in these detail views with live Supabase reads, respecting the brand
  filter (pass/ära filter by `company_id` where the table has it):
  Executive overview, Internal financials (transaction/financial_account/statement),
  Leads (lead + lead_provider), Appointments (appointment), Marketing/Ads (meta_ads_insight),
  Property financial reports (statement where type='pm_income_expense' + property_financials).
- Loans card: read from the ops endpoint `/api/loans` (same origin) OR Supabase `loan`; pick
  the simpler correct one and explain the choice.
- Keep Properties card as the same-origin `/ops#tab=properties` embed. Don't reimplement it.
- Do not change the ops dashboard's `/api/*` behavior or its data.

Constraints:
- Additive only. No framework, no build step. Match existing CSS tokens in portal.html.
- Never expose the service role key to the browser.
- Verify locally, then show me a diff before committing. Small, reviewable commits.

## After Task 1 (only when I say so)
- Task 2: Investor portal against `investor`/`investor_stake`/`document`.
- Task 3: Client upload portal using Supabase Storage (private bucket) + the
  `document` table with `ingestion_method` + `uploaded_by`.
- Task 4: deploy to Railway and confirm `/` and `/ops` both work in prod.

Rules of engagement: ask before destructive DB migrations, auth changes, or adding
dependencies. Update CLAUDE.md whenever architecture changes.
