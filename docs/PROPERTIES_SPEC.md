PROPERTIES SECTION: COMPLETE SPEC (supersedes every earlier message about Properties and Views)

FIRST: save this entire message verbatim as docs/PROPERTIES_SPEC.md and commit it. It is the single source of truth. Work through EVERY item. When done, reply once with the spec's checklist, each item marked Done / Not done (with the reason). Do not report "done" with unchecked items. Deploy when all items are done or explicitly reported as blocked.

=====================================================================
A. NAVIGATION: three-level drill-down
=====================================================================
Remove the left entity tree panel and the "Company" label. No sidebar or dropdown for entities; content uses the full width. Navigation is by drill-down and breadcrumb.

A1. Level 1, Portfolio (landing): tabs Entities | Properties | Asset management fees | Views.
 - Entities: one row per MANAGING entity (~17, via the property's managing entity), not every legal entity. Columns: Managing entity (+ short code; sub-line "<n> properties, <main city>"), Properties, Units, NOI (trailing 12 mo), Optimized NOI, Net income, Value, Debt, LTV, DSCR (mortgage), Flags. Totals row.
 - Properties: every held property (columns in C1).
 - Asset management fees: company-wide tracker (section F).
 - Views: saved views (section G).
A2. Level 2, Entity: breadcrumb Portfolio / <Entity>. Tabs: Properties (that entity's properties) | Asset management fees (that entity's rows only; "No asset management fees set up for this entity" if none).
A3. Level 3, Property: breadcrumb Portfolio / <Entity> / <Property>. Header: name, status and asset-type tags, address, managing entity, owner LLC, manager. Key-figure row: Units, Occupancy, NOI (trailing 12 mo), Optimized NOI, Net income, Market value, Debt, LTV, DSCR (mortgage), each with a small source/as-of line under it (e.g. "Rent roll Sep 30, 2026", "Value on file Sep 30, 2025, stale").
 Tabs in this order: Overview | Monthly financials | Income & expenses | Optimized NOI | DSCR | Asset management fee | Rent roll | Buildings & units | Capex | Valuation | Documents.
A4. Period filter at the right end of the property tab bar: Year + From/To month (default current year, Jan to latest month loaded). Applies to Monthly financials, Income & expenses, Capex, Asset management fee. Rent roll has its own "As of" selector (dates available for that property, default latest).
A5. Names of entities and properties look clickable (link color, underline on hover, pointer; whole row clickable). Breadcrumb goes back up; browser Back works; level, entity, property, tab and period are in the URL (bookmarkable, shareable).
A6. Every page/tab reloads for the current selection and ignores stale responses (bug seen: switching entity on Asset management fees kept showing Kouri / Adventureland under 4813 Underwood Partners LLC). Test it.

=====================================================================
B. GLOBAL RULES
=====================================================================
B1. Read-only: nobody edits existing data from these screens (flag PROPERTIES_READ_ONLY=true). Exceptions: section H (adding records, admins only) and section G (saving view definitions, which are not data).
B2. "–" means not available, never zero. No charts anywhere.
B3. Labels: never "T12" on screen; use "NOI, trailing 12 mo", "Optimized NOI", "Run-rate NOI".
B4. Colors (same meaning everywhere): red = NOI or net income < 0 (net income uncolored in tables; red only on its own tab), DSCR < 1.00, occupancy < 85%; orange = DSCR 1.00-1.24, occupancy 85-90%, expense ratio > 60%; green = DSCR >= required, positive NOI.
B5. Tables: header row and first column frozen while scrolling; one-line names with the Buildium/AppFolio tag small beside the name; normal-case header labels with readable contrast; Compact / Comfortable density switch; totals/right columns reachable (frozen Total column where a table has one).
B6. Estimates are labeled on screen: DSCR from interest-only books gets an "interest only" tag (tooltip "No principal in the books; coverage is likely overstated"); every value shows its as-of date, values older than 6 months tagged "stale"; "Value at cap rate" labeled "estimate"; LTV states which value it uses.
B7. Performance: reporting.property_summary (2.9 s) becomes a materialized view refreshed after each sync; skeleton tables while loading; never a blank page.

=====================================================================
C. PORTFOLIO / ENTITY TABLES
=====================================================================
C1. Properties table columns: Property | Units | Occupancy | Total income | Total expenses | NOI, trailing 12 mo | Optimized NOI | Expense ratio | Net income | DSCR, mortgage | DSCR, all debt (only shown if any property in view has other debt) | PM company | In Dropbox (T12 / Rent roll chips; dashed outline when missing). Totals row.
C2. Default sort: NOI descending; properties with no reports go last. Filters: search, status (default held), "With reports" (default on), source (Buildium / AppFolio). Export CSV of what is on screen.

=====================================================================
D. PROPERTY TABS
=====================================================================
D1. Overview: flags ("Nothing needs attention" when none: matured/maturing loans, DSCR, vacancy, receivables, negative NOI, insurance dates) and property details (ownership, physical, acquisition and value), read-only, with "Show empty fields".
D2. Monthly financials (our Excel "Monthly Property Financials"): months of the selected period as columns + Averages + Totals. Rows in order: # of Units, Rent Income, Recurring Fee Income, Non-Recurring Fee Income, Total Expected Income, Total Operating Income, Total Operating Expense, Net Operating Income (bold), Expense Ratio (bold), Capital Expense, Capex Ratio, Utility Income Ratio, Cash Flow (bold), Delinquency, Asset Management Fee, Asset Management Fee %, Physical Occupancy (bold), Economic Occupancy (bold), Debt Service (mortgage), Other interest counted as debt (only if any), Debt Service, all debt (only if other debt), Loan Proceeds (only if any), DSCR, mortgage (bold, colored), DSCR, all debt (only if other debt), Loss to Lease.
 Rows that are entirely "–" for the period are hidden behind a "Show unavailable rows" toggle. Label column wide enough for one line. A note states source, basis, and how debt service and cash flow are calculated (cash flow = NOI - AM fee - debt service - capex).
D3. Income & expenses: income statement by account for the period: income accounts (indented by depth), Total Operating Income, expense accounts, Total Operating Expense, NOI; months across + Total.
D4. Optimized NOI:
 - What-if input: Cap rate (default 7%), never saved; "Standard values" / "Changed (not saved)" + Reset.
 - Monthly NOI table (latest 12 months loaded): Operating income, Operating expenses, NOI; best month outlined (2px green), best 3 consecutive months darker green fill, best 6 consecutive months light green fill; legend that actually shows the three swatches.
 - "What it earns at its best": rows Trailing 12 months | Optimized NOI (best 6 consecutive months x 2, highlighted) | Best 3 months x 4 | Best month x 12; columns Months, Annual NOI, Value at <cap> cap rate (estimate), vs. trailing 12 months (+$ and +%).
 - Only months on/after first_active_month count; optimized needs 6+ months, else "Not enough months".
D5. DSCR:
 - What-if inputs (never saved): Required DSCR (1.25), New loan rate (6.5%), Amortization (30 yrs), Loan balance, Annual debt service (pre-filled from loan records); Standard/Changed + Reset.
 - Facts: loan balance, annual debt service, rate, maturity, lender (or "Loan record: Not on file" + payments seen in the books); debt_service_source shown in words.
 - Monthly coverage table: NOI, Debt service (mortgage), Other interest (if any), DSCR mortgage, DSCR all debt (if any), colored vs required.
 - "Can it carry its loan, and how much more?": rows Trailing 12 months and Optimized NOI; columns Annual NOI, DSCR mortgage, DSCR all debt (if any), Meets <required>? (Yes/No), Max loan, vs. current loan. Max loan = annual NOI / required DSCR / k, k = 12 x (r/12) / (1 - (1 + r/12)^(-years x 12)).
D6. Asset management fee: Expected / Received / Variance for this property over the period + facts (paid by, fee, timing, fee row).
D7. Rent roll: As-of selector; summary (units, occupied, vacant, physical occupancy, rent vs market, loss to lease, delinquency) + unit list (unit, beds/baths, tenant, status, rent, market rent, balance, lease end).
D8. Buildings & units: buildings with unit counts (read-only), plus "+ Building" for admins (section H). Apartment-level units come from rent rolls only.
D9. Capex: monthly capex by account for the period + total. D10. Valuation: value on file (with date, stale tag), value per unit, cap rate at trailing NOI, LTV. D11. Documents: linked documents (T12 and rent roll files in Dropbox first).

=====================================================================
E. DATA RULES (reporting views; keep everything already verified)
=====================================================================
E1. Units: existing unit-count rule; when it yields nothing, fall back to the latest rent roll's unit count (Modern Heights 160, 500 S Dakota 22, Adventureland 72, Aksarben 24, BG Flats 42). Report the source per property; explain Altoona 84 vs rent roll 83.
E2. Interest: 'Mortgage Interest', 'Interest Exp', 'Interest Payment'. Principal: Buildium 'Mortgage Principal'; AppFolio 'Principal Payment'; other_cash_items loan/mortgage lines, NEGATIVE amounts only (principal = -amount); positive amounts are loan_proceeds (Doral May 2026 4,326,000), never debt service. Exclude 'Loan - Other' and 'Arrow Loan'.
E3. Debt service fallback per property: (a) books interest + principal + unsplit payments when principal/unsplit lines exist; (b) else loan record annual / 12; (c) else books interest only, tagged interest_only_books.
E4. Other Interest Expense: counted as additional debt ONLY for Cedar Haven Duplexes and Heston Pointe (rule in SQL: present in >= 6 of last 12 months AND a non-primary loan on file). The Beverly excluded and listed as an open question; Estrella, Sierra Gardens (one-offs) and 'Other interest' credits excluded; all visible in other_interest.
E5. Optimized NOI, newest-export-wins and first_active_month rules as already built. Acceptance figures already verified must not change.

=====================================================================
F. ASSET MANAGEMENT FEE TRACKER
=====================================================================
F1. Layout like our Excel tracker: grouped by manager (RPME, J&M, McClain Co., Arrow, Kouri, Bender / AJ, Point Guard NE/SD/OK/TX), group header with timing (and "timing not confirmed" for McClain and Bender/AJ); per fee row Expected / Received / Variance; months + frozen Total column; all-properties totals; groups collapsible; year selector; Export CSV.
F2. Expected = fee % x gross income (total operating income, cash) of the same month or the previous month (following-month managers); BG Champion fixed $8,291.67. No income = blank.
F3. Received display-only: seed values, else the property's booked asset management fee (source 'books', shown in italics with a legend explaining it).
F4. Variance = received - expected; past month with nothing received = -expected; |variance| < $1.00 shows "0.00" in neutral grey (never "(0.00)"/"(0.01)"). Lighter tints, not heavy fills.

=====================================================================
G. VIEWS (custom saved views)
=====================================================================
G1. Already built: datasets registry, saved_view and saved_view_share, builder (dataset, display type, fields, filters, sort/group/aggregates/pivot or tiles, live preview, save, share with users/roles as viewer/editor), four starter views. Keep it; make sure it is reachable from the Views tab and portal nav.
G2. Add styling options stored in the view config: conditional color rules (e.g. DSCR < 1.00 red, 1.00-1.25 orange), drag to reorder and resize columns, rename headers, number format (dollars/cents, %, decimals), dashboard tile drag-and-drop with size (S/M/L) and accent color from a fixed palette, density and text size, report header (title, subtitle, logo, date range) for PDF export, preset color themes that work in light and dark. No free colors or fonts.
G3. Add calculated columns: formula box with field autocomplete; operators + - * /, IF, MIN, MAX, ROUND, ABS, SUM/AVERAGE for subtotals; preview on sample rows; divide-by-zero or missing data shows "–"; formula shown on hover. Own small expression language parsed server-side into parameterized SQL over registry fields only (no raw SQL). Formulas belong to the view; an admin can "promote" one to the dataset registry.
G4. Permissions server-side: owner edits/shares/deletes; editor edits layout; viewer views; sharing never grants data access beyond the user's own scope.

=====================================================================
H. ADDING RECORDS (admins only, audited; nothing existing becomes editable)
=====================================================================
H1. "+ Entity" (name, type, parent), "+ Property" (guided form), "+ Building" (name/address, unit count) under a property.
H2. "+ Property" form also captures: report source (Buildium/AppFolio) and the property's exact name there (creates the property_source_alias the sync matches on), Dropbox entity folder and property folder (added to the sync's folder mapping), asset management fee (manager group, fee % or fixed, same/following month), optional loan.
H3. After saving, the property shows a setup checklist: Sync name matched / Dropbox folder set / Fee set / Loan on file, so nothing is half set up.

=====================================================================
I. ORDER OF WORK
=====================================================================
1. A (navigation) + A6 bug + B + E1 + B7 + F4.  2. C + D (all tabs).  3. F.  4. G2-G3.  5. H.
Run all suites after each step; deploy after step 3 and again at the end.
Final reply: the checklist from this spec with every item marked, plus anything blocked and why.
