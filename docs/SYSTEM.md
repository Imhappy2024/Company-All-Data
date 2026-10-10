# SYSTEM.md — where the numbers come from

Companion to `CLAUDE.md`. That file records how this repo works and why;
this one records where the **data** comes from and what is still missing from
it. Start here when a figure looks wrong before reading the code that renders
it.

## The reporting layer

Every property screen reads `reporting.*`, never the raw tables. The rules
live in those views so no two screens can disagree about them.

| View | Grain | Source |
|---|---|---|
| `reporting.property_month` | property × month × basis | `t12_monthly`, `t12_report`, `rent_roll_*`, `property_financials`, `loan` |
| `reporting.income_statement_line` | property × month × account | `t12_monthly` |
| `reporting.rent_roll_unit` | property × as-of × lease | `rent_roll_report`, `rent_roll_line` |
| `reporting.loan` | loan (+ the property it secures) | `loan`, `loan_balance`, `loan_collateral` |
| `reporting.property_summary` | property | the four above |
| `reporting.am_fee_month` | fee row × month | `am_fee_*` + `property_month` |

## Debt service today, and what is missing

Debt service is resolved per property, in this order:

1. **`income_statement`** — the books carry principal, or an unsplit mortgage
   payment. This is the only path that measures the real payment.
2. **`loan_record`** — the books carry no principal, but every loan on the
   property states an annual `debt_service`.
3. **`interest_only_books`** — neither of the above, but the books carry
   interest. The figure is then **interest alone**, which is an upper bound on
   coverage rather than a measurement of it, and every screen that shows a
   ratio built from it carries an `interest only` tag.

Step 3 exists because of Doral: interest every month from May 2026, no
principal line, no loan record. Without it the screen showed a blank debt
service for a property that demonstrably pays one.

### QuickBooks will replace step 3 — NOT YET BUILT

Once monthly **QuickBooks balance sheets exist per property LLC**, two things
change and both are improvements on what is here now:

1. **Loan balances should come from QuickBooks**, not from `loan_balance`.
   That table is sparse and its dates are ragged — 54 of 75 loans have any
   balance row at all, which is why `v_debt_by_quarter` reads $15.2M against
   the $225.4M in `account_balance`. A monthly balance sheet per LLC gives a
   dated balance for every loan every month.

2. **Principal paid = the month-over-month DECREASE in the loan balance.**
   That is a measurement rather than an inference, and it removes the
   interest-only fallback entirely: a property with interest in its P&L and a
   falling loan balance on its balance sheet has a complete debt service
   without anyone having to book a principal line.

   It also fixes the sign problem recorded in `CLAUDE.md`. Today principal is
   read out of `other_cash_items`, where an outflow is negative and a loan
   draw is positive, and the two are told apart by a sign test. A balance
   decrease is unambiguous: a refinance **raises** the balance and can never
   be mistaken for a payment.

**Do not build the import against assumptions.** When the QuickBooks data
lands, check what the balance sheet actually calls the loan accounts and how
they map to `loan.id` before writing anything — the same discipline that
turned up `tenant_names`, `source_t12_report_id` and five sections rather
than the four the brief described.

## Other interest

`Other Interest Expense` and `Other interest` are **not** mortgage interest.
A property carrying one almost always carries a real `Mortgage Interest` line
as well, so these are other debt — a seller-carry note, a PACE loan, a line
of credit.

They count toward debt service only when **both** hold:

* the line appears with a positive amount in **≥ 6 of the last 12 months**, and
* the property has a loan on file that could explain it — a loan with a
  **known** non-primary `purpose`, or two or more loans.

"Known" matters: `purpose <> 'primary_mortgage'` is TRUE for a NULL purpose,
and NULL means nobody recorded what the loan is, which is not evidence of
extra debt.

Today that qualifies **Cedar Haven Duplexes** (seller-carry note) and
**Heston Pointe** (PACE equity and PAC due). Everything else stays visible in
`property_month.other_interest` without being summed in.

### Open question: The Beverly / Keystone Apartments Wichita

$97,500 a year of `Other Interest Expense`, every month, against a single
loan on file of $171,700 with **no recorded purpose**. $7,500 a month cannot
be serviced by that balance, so there is debt here that the loan records do
not describe. It is deliberately **not** counted, and it is the first thing
QuickBooks should settle.

## Values and LTV

`property.current_market_value` carries `current_market_value_asof`. A value
older than six months — **or with no date at all** — is tagged `stale` on
screen, and the LTV says which value it was measured against. The cap-rate
value is derived from trailing NOI and is always labelled `estimate`,
whatever the cap rate is set to.

## Things that are measured, not assumed

Recorded because each was wrong once and the wrong version looked fine:

* A `rent_roll_line` is a **lease**, not a unit. Copperleaf: 494 lines, 87
  units, 156 current leases across 82 of them.
* `occupancy_status` is `current / past / vacant_unrented / future / notice /
  vacant_rented`. There is no `occupied`.
* `t12_monthly.account_path` is `text[]`.
* `accounting_basis` is `'Cash'` / `'Accrual'`, capitalised.
* A **positive** amount in `other_cash_items` is a loan draw, not principal.
  Doral has a +$4,326,000 refinance in **May 2026**.
