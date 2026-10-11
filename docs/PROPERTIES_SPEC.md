TASK: Build the Properties section exactly as the approved mockup, connected to the live database. Design, layout, wording, behavior and calculations must match the mockup; the only difference is that every number comes from the database instead of the mockup's embedded snapshot.

SOURCE OF TRUTH
- docs/mockup/properties-mockup.dc.html is the approved design AND the reference implementation. Read all of it: the markup/CSS (look and layout) and the Component class (every calculation, rule, label, color and empty state). Port it into the portal's existing stack (vanilla JS modules, server-built payloads); do not ship the mockup's framework (support.js / x-dc).
- Where this message and the mockup disagree, the mockup wins. Where the mockup and docs/PROPERTIES_SPEC.md disagree, the mockup wins: replace PROPERTIES_SPEC.md with "PROPERTIES_SPEC v2" = this message, and keep the checklist at the end.
- The mockup's embedded data methods (liveProps, monthlyAll, noi12, statements, dakota, rentRolls, buildings, capexData, addresses, incomeData, feeGroups, receivedSeed) show what each screen needs. Each one must be replaced by a server endpoint returning the same shape from live data, for every property (the mockup only had full detail for some).
- Save this message verbatim as docs/PROPERTIES_SPEC.md before starting. Work through every checklist item; report once at the end with each item Done / Not done (and why). Show me any SQL migration before applying it. Do not deploy until all items are done or reported as blocked.

1. DESIGN SYSTEM (exactly as mockup)
- IBM Plex Sans, tabular numerals, sentence-case labels; colors as tokens; Graphite is the dark theme, Light stone the light theme (map both onto the portal's existing light/dark switch; drop Navy).
- Red/amber/green only for meaning; total rows get the light band highlight; frozen header row and first column on every table; Comfortable/Compact density switch; motion and press states as in the mockup's CSS; prefers-reduced-motion respected.
- "–" means not available; a RED "–" means missing data that should exist (market value, debt service, DSCR). Values on file show an "Outdated" tag.

2. NAVIGATION
- Portfolio tabs: Entities | Custom view.
- Entities table columns: Managing entity | Properties | Units | Occupancy | NOI | Market value (sum of values on file, "(k of n)" when partial, "Outdated" tag, red "–" if none) | Cash flow after debt and capex | Debt. Properties with no managing entity are grouped under an entity row "No managing entity".
- Entity page: its properties table. Property page header + tabs in this order: Overview | Buildings & units | Needs attention (with red count badge) | Monthly financials | Optimized NOI | Asset management fee | Rent roll | Capex.
- The key-figure cards (Units, Occupancy, NOI, Optimized NOI, Cash flow after debt and capex, Market value, Debt, DSCR) appear ONLY on Overview.
- Breadcrumb, browser Back and URL state as before.

3. PROPERTY TABS (each exactly as the mockup renders it)
- Overview: key-figure cards + Property details.
- Buildings & units: cards, amber data checks (e.g. building units vs rent roll), buildings table, "Also on file: n garages/sheds". Source: unit table.
- Needs attention: the mockup's rules and wording (operating loss, DSCR < 1.00, DSCR < 1.25, vacancy >= 15%, delinquency >= 5% of rent, leases expiring in 90 days >= 10% of occupied, no managing entity, value with no date / older than 12 months, coverage not calculable). Each item: specific title with the actual numbers, explanation, next step, source. Rules run server-side. Debt service in the explanation = debt service actually paid in the books (annualized), else loan record.
- Monthly financials: From/To month (01-12) + year selectors (default 10/2025 to 09/2026), eight period tiles, then Summary, Income statement, Cash flow statement stacked (no switch buttons). Rows and months with no data are hidden automatically. Income statement = account lines from t12_monthly. Cash flow statement = net income + operating balance changes (deposits, prepaid, escrows, clearing) + financing/owner lines (loan principal, credit line, owner contributions/distributions, intercompany) from other_cash_items, as grouped in the mockup's statements(). Build reporting views for both for every property.
- Optimized NOI: eight cards (Status Safe/Fixable/At risk/Critical, NOI trailing, Optimized NOI with months and current/older, DSCR trailing, DSCR optimized, Max loan, vs current loan, Value), then the Assumptions row attached to the "What it earns, and what that supports" table (what-if inputs incl. What-if NOI; never saved), then the NOI heat map. No slider.
- Asset management fee: as mockup.
- Rent roll: cards, Unit mix, Lease expirations next 12 months, Units list (full list for every property), As-of selector. Source: reporting.rent_roll_unit (is_latest, is_current).
- Capex: period filter, cards, By month, By category. Categories come from a NEW editable mapping table capex_category_map(pattern or account label -> category), seeded with the mockup's keyword rules; unmatched accounts go to "Other".
- Export button (Excel, PDF, CSV) on Monthly financials, Optimized NOI, Rent roll and Capex: real downloads, file names as in the mockup ("<Property> - <Tab> - <Period>.<ext>"). Excel: one sheet per table, totals, formatting (exceljs is installed). PDF: report layout with header, cards and tables. CSV: one file per table, zipped.

4. CUSTOM VIEW (Portfolio > Custom view)
- Sub-tabs, one per saved view, with "+ Add custom view" at the right. Builder has Quick build and Advanced exactly as the mockup.
- Properties: Use a property group (checkbox list; ticking a group lists its properties with checkboxes; unticking excludes for this view only) | Create a property group (name, search, tick, Save property group; it becomes selected) | Pick properties without saving.
- Fields: every field in the mockup's FIELDS list, same groups and labels, with the same group-total rules (weighted occupancy, sum-based ratios, etc.).
- Quick: Cards (one total per selected number) / Table / List / Chart.
- Advanced: cards built one by one (label, size S/M/L; Value = field + period [trailing 12, Jan-Sep YTD, a month, a range] + total/average; Formula = terms with + - x / and numbers, standard precedence, format dollars/number/percent/ratio), live result preview, drag-and-drop layout with arrow-button fallback. Months without data show "–".
- Saved view: layout grid, Edit, Export (Excel/PDF/CSV of what is shown). Clicking a property opens it.
- Access: private to the creator by default; creator can add people or teams as "Can view" or "Can view and edit"; only the creator deletes or changes access; viewers never see properties outside their own access.
- Storage (show me the SQL): property_group, property_group_member (owned by the user, reusable across views); extend saved_view config with mode, groups, excluded properties, fields, styles, chart field, cards (incl. formulas and periods), layout; reuse saved_view_share for access. Formulas are evaluated server-side from a whitelist of fields; never eval user input.

5. DATA RULES (fix in the reporting views; show SQL first)
- Units and occupancy: latest rent roll first (count of is_current units; occupied = current + notice), then unit_count_verified, then sum of buildings. Fixes Franklin Court (95.9%), Grandview (73.3%) and similar.
- Rename "net income" in property_summary output to cash_flow_after_debt_and_capex (it is NOI less debt service and capex); true net income comes from the income statement view.
- Already corrected directly in the database on Oct 11, 2026 (do not redo; notes are on the records): The Preserve unit_count_verified 72; The Preserve "Building 10" moved to The Beverly as Building 1 (701 S Beverly Drive, Wichita, KS 67218, 176 units); The Todd 22; Villa Blanca 24; Capitol City Villas 70; Dakota Bend 56; The Whitney and Uptown Flats management_company = AJ Property Management.
- Oct-Dec 2025 monthly data is missing for most properties; a backfill is running. Show "–" until it lands; do not estimate.

6. READ-ONLY AND PERMISSIONS
- Property data stays read-only (PROPERTIES_READ_ONLY). Custom views, property groups and sharing are user content and are writable by their owner/editors. Every endpoint checks the signed-in user server-side.

7. ACCEPTANCE (compare the app to the mockup, same data)
- Champion Villas Needs attention badge 2; DSCR item reads "NOI of $777,274 ... annual mortgage payments of $712,716 = 1.09 ... rise by $113,621 to $890,895".
- Franklin Court: Capex $571,210 (31.4% of income); Optimized NOI status Fixable; rent roll 172 units, 95.9% occupied, delinquency $16,461 / 35 tenants.
- Dakota Bend: Jan 2026 NOI 15,074.52, DSCR 1.11; income statement net income Oct 2025-Sep 2026 = 17,140.74.
- Custom view "Sioux Falls townhomes overview" (recreate as a seed for me): Units 262; Income, Aug + Sep 2026 = $579,376.
- Screenshots of every tab for Franklin Court, Champion Villas and one entity, the Entities table, and the custom view builder (both modes) next to the same mockup screens. Any visible difference is a defect unless it is live data.

REPORT: PR link, migrations (shown before applying), checklist with every item marked, screenshots side by side with the mockup, and anything that could not match.
