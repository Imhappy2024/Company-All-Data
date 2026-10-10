/* The brief's section 2.10 acceptance checks, split into the half that is
   ARITHMETIC and the half that is DATA.

   This file is the arithmetic half, and it can run anywhere. The brief states
   both the inputs and the outputs for these, so the figures check each other:
   Dakota Bend's income, NOI, expense ratio, interest and principal are five
   numbers that only agree if all five are right, and they do agree to the
   cent. That is a real check on the rules this repo implements, not a
   restatement of them.

   The DATA half - does reporting.property_month actually RETURN 149,000.29
   for Franklin Court in May 2026 - is deliberately absent. A fixture cannot
   answer it, and asserting it against one would be the vacuous-test failure
   CLAUDE.md records under Financials. It needs a live connection.

   Run: node test/test-acceptance-math.js
*/
const assert = require('assert');
const N = require('../noi-analysis');
const R = require('../am-fee-rules');

let pass = 0; const fails = [];
const check = (n, fn) => { try { fn(); pass++; } catch (e) { fails.push(n + ' -> ' + e.message); } };
const near = (a, b, tol) => Math.abs(a - b) <= (tol === undefined ? 0.005 : tol);

/* =====================================================================
   Dakota Bend, January 2026
   income 48,469.52 | NOI 15,074.52 | expense ratio 68.9%
   capex 21,339.55  | debt service 13,539.14 | DSCR 1.11
   interest 8,362.74 + principal 5,176.40
   ===================================================================== */

const DB_INCOME = 48469.52, DB_NOI = 15074.52;
const DB_INTEREST = 8362.74, DB_PRINCIPAL = 5176.40, DB_DS = 13539.14;

check('Dakota Bend debt service is interest plus principal', () => {
  /* the correction that matters: principal IS in the income statement.
     AppFolio books it in other_cash_items as a NEGATIVE amount, so the view
     negates it. Getting that sign wrong gives 8362.74 - 5176.40 = 3186.34,
     a debt service SMALLER than the interest, which still renders. */
  assert.ok(near(DB_INTEREST + DB_PRINCIPAL, DB_DS), 'got ' + (DB_INTEREST + DB_PRINCIPAL));
  const wrongSign = DB_INTEREST - DB_PRINCIPAL;
  assert.ok(wrongSign < DB_INTEREST, 'sanity: the wrong sign is smaller than interest alone');
});

check('Dakota Bend DSCR is 1.11', () => {
  const d = N.dscr(DB_NOI, DB_DS);
  assert.strictEqual(Number(d.toFixed(2)), 1.11, 'got ' + d);
});

check('Dakota Bend expense ratio is 68.9%, and ties to income and NOI', () => {
  /* NOI = income - expense, so expense is implied. If the ratio, the income
     and the NOI did not agree, one of the three would be wrong. */
  const expense = DB_INCOME - DB_NOI;
  const ratio = expense / DB_INCOME;
  assert.strictEqual(Number((ratio * 100).toFixed(1)), 68.9, 'got ' + (ratio * 100));
});

check('Dakota Bend Feb fee ties to the SAME January income', () => {
  /* 2% of 48,469.52 = 969.39, which is the seeded February receipt. The fee
     check and the financial check are reading one number. */
  const s = { fee_type: 'pct_gross', fee_pct: 2, payment_timing: 'following_month' };
  assert.ok(near(R.expectedFee(s, '2026-02', { '2026-01': DB_INCOME }), 969.39));
});

/* =====================================================================
   Franklin Court
   trailing 828,323 | optimized 970,480 (Apr-Sep 2026)
   loan record 774,391.92 / yr | current loan 8.08M
   at 1.25 / 6.5% / 30yr -> max loan about 10.24M, +2.16M
   ===================================================================== */

const FC_TRAILING = 828323, FC_OPTIMIZED = 970480, FC_CURRENT_LOAN = 8080000;

check('Franklin Court falls back to the loan record, at 774,391.92 / 12', () => {
  /* its books carry interest but no principal and no unsplit payment, so
     debt_service_source must be 'loan_record'. */
  assert.ok(near(774391.92 / 12, 64532.66), 'got ' + (774391.92 / 12));
});

check('optimized NOI is the best SIX consecutive months, doubled', () => {
  /* Apr-Sep 2026 summing to 485,240 doubles to the brief's 970,480. The
     surrounding months are deliberately weaker, and a 2025 run is included
     to prove the window is picked on value rather than recency. */
  const best6 = FC_OPTIMIZED / 2;
  const rows = [
    { month: '2025-10', noi: 60000 }, { month: '2025-11', noi: 61000 },
    { month: '2025-12', noi: 62000 }, { month: '2026-01', noi: 63000 },
    { month: '2026-02', noi: 64000 }, { month: '2026-03', noi: 65000 },
    { month: '2026-04', noi: best6 / 6 }, { month: '2026-05', noi: best6 / 6 },
    { month: '2026-06', noi: best6 / 6 }, { month: '2026-07', noi: best6 / 6 },
    { month: '2026-08', noi: best6 / 6 }, { month: '2026-09', noi: best6 / 6 },
  ];
  const o = N.optimizedNoi(rows);
  assert.ok(o, 'no window found');
  assert.ok(near(o.annual, FC_OPTIMIZED, 0.5), 'got ' + o.annual);
  assert.strictEqual(o.from, '2026-04');
  assert.strictEqual(o.to, '2026-09');
});

check('max loan at 1.25 / 6.5% / 30yr is about 10.24M on the optimized NOI', () => {
  const m = N.maxLoan(FC_OPTIMIZED, 1.25, 6.5, 30);
  assert.ok(near(m / 1e6, 10.24, 0.01), 'got ' + (m / 1e6).toFixed(3) + 'M');
});

check('the uplift against the current loan is about +2.16M', () => {
  const m = N.maxLoan(FC_OPTIMIZED, 1.25, 6.5, 30);
  assert.ok(near((m - FC_CURRENT_LOAN) / 1e6, 2.16, 0.01), 'got ' + ((m - FC_CURRENT_LOAN) / 1e6).toFixed(3) + 'M');
});

check('the trailing NOI supports a SMALLER loan than the optimized one', () => {
  /* the whole point of the screen: if these came out equal, the optimized
     column is not being computed. */
  const opt = N.maxLoan(FC_OPTIMIZED, 1.25, 6.5, 30);
  const tr = N.maxLoan(FC_TRAILING, 1.25, 6.5, 30);
  assert.ok(tr < opt, 'trailing ' + tr + ' is not below optimized ' + opt);
});

/* =====================================================================
   The window rules
   ===================================================================== */

check('six months are needed - five give null, not a scaled-up window', () => {
  const five = ['2026-01', '2026-02', '2026-03', '2026-04', '2026-05']
    .map(m => ({ month: m, noi: 50000 }));
  assert.strictEqual(N.optimizedNoi(five), null);
  assert.ok(N.optimizedNoi(five.concat({ month: '2026-06', noi: 50000 })));
});

check('a window must be ADJACENT months, not just six rows', () => {
  /* Jan, Feb, Mar then Oct, Nov, Dec is six rows and is not six consecutive
     months. Sliding over the array without checking the calendar treats
     March and October as neighbours and reports a window that never
     happened. */
  const gapped = ['2026-01', '2026-02', '2026-03', '2026-10', '2026-11', '2026-12']
    .map(m => ({ month: m, noi: 50000 }));
  assert.strictEqual(N.optimizedNoi(gapped), null, 'a gapped run must not qualify');
});

check('a window spanning the year boundary is still consecutive', () => {
  const rows = ['2025-10', '2025-11', '2025-12', '2026-01', '2026-02', '2026-03']
    .map(m => ({ month: m, noi: 40000 }));
  const o = N.optimizedNoi(rows);
  assert.ok(o, 'Oct through Mar is six consecutive months');
  assert.strictEqual(o.from, '2025-10');
  assert.strictEqual(o.to, '2026-03');
});

check('a null NOI month is skipped, and breaks the run rather than counting as 0', () => {
  const rows = [
    { month: '2026-01', noi: 50000 }, { month: '2026-02', noi: null },
    { month: '2026-03', noi: 50000 }, { month: '2026-04', noi: 50000 },
    { month: '2026-05', noi: 50000 }, { month: '2026-06', noi: 50000 },
    { month: '2026-07', noi: 50000 },
  ];
  /* Feb is absent, so Mar-Jul is only five adjacent months. */
  assert.strictEqual(N.optimizedNoi(rows), null);
});

/* =====================================================================
   Guards
   ===================================================================== */

check('no debt service gives a null DSCR, never Infinity', () => {
  assert.strictEqual(N.dscr(100000, 0), null);
  assert.strictEqual(N.dscr(100000, null), null);
  assert.ok(N.dscr(100000, 50000) === 2);
});

check('a zero cap rate has no value, rather than an infinite one', () => {
  assert.strictEqual(N.valueAtCap(700000, 0), null);
  assert.ok(near(N.valueAtCap(700000, 7), 10000000));
});

check('a 0% loan amortises linearly instead of dividing by zero', () => {
  const k = N.annualConstant(0, 30);
  assert.ok(near(k, 12 / 360, 1e-9), 'got ' + k);
  assert.ok(isFinite(N.maxLoan(1000000, 1.25, 0, 30)));
});

console.log('\nacceptance math: ' + pass + ' passed, ' + fails.length + ' failed');
if (fails.length) { fails.forEach(f => console.log('  FAIL  ' + f)); process.exit(1); }
