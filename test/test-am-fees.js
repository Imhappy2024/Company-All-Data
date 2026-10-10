/* Asset management fee rules.

   The figures below are the brief's own acceptance checks, which is the point:
   they were written down before the code and they are arithmetic, not data, so
   they can be verified without a database.

     Dakota Bend Feb 2026 expected 969.39  = 2% of Jan income 48,469.52
     Franklin Court Jan 2026 expected 4,474.54 = 3% of Dec 2025 income 149,151.49
       received from books 4,474.99, variance +0.45
     Doral Jun 2026 expected 1,911.16

   The acceptance checks that need live DATA (Franklin Court May income, the
   optimized NOI, the DSCR) are not here and cannot be: they are what the
   reporting views return, and no fake can tell you whether a view matches the
   database. Those stay Jay's to run once the views are applied.

   Run: node test/test-am-fees.js
*/
const assert = require('assert');
const R = require('../am-fee-rules');

let pass = 0; const fails = [];
const check = (n, fn) => { try { fn(); pass++; } catch (e) { fails.push(n + ' -> ' + e.message); } };
const near = (a, b, tol) => Math.abs(a - b) <= (tol === undefined ? 0.005 : tol);

/* ---- the brief's three expected figures ---- */

check('Dakota Bend Feb 2026 is 2% of January income', () => {
  const s = { fee_type: 'pct_gross', fee_pct: 2, payment_timing: 'following_month' };
  const got = R.expectedFee(s, '2026-02', { '2026-01': 48469.52 });
  assert.ok(near(got, 969.39), 'got ' + got + ', expected 969.39');
});

check('Franklin Court Jan 2026 is 3% of December 2025 income, across the year boundary', () => {
  /* the year rollover is the part worth testing: prevMonth('2026-01') must be
     '2025-12', not '2026-00' or '2026-12'. */
  assert.strictEqual(R.prevMonth('2026-01'), '2025-12');
  const s = { fee_type: 'pct_gross', fee_pct: 3, payment_timing: 'following_month' };
  const got = R.expectedFee(s, '2026-01', { '2025-12': 149151.49 });
  assert.ok(near(got, 4474.54), 'got ' + got + ', expected 4474.54');
});

check('Franklin Court Jan 2026 variance is +0.45 against the books', () => {
  const s = { fee_type: 'pct_gross', fee_pct: 3, payment_timing: 'following_month' };
  const expected = R.expectedFee(s, '2026-01', { '2025-12': 149151.49 });
  const r = R.receivedFee(null, 4474.99);
  assert.strictEqual(r.source, 'books');
  const v = R.variance(expected, r.amount, '2026-01', new Date('2026-10-11T00:00:00Z'));
  assert.ok(near(v, 0.45), 'got ' + v + ', expected 0.45');
});

check('Doral Jun 2026 expected is 1911.16 at 3% of May income', () => {
  /* 1911.16 / 0.03 = 63,705.33 */
  const s = { fee_type: 'pct_gross', fee_pct: 3, payment_timing: 'following_month' };
  const got = R.expectedFee(s, '2026-06', { '2026-05': 63705.33 });
  assert.ok(near(got, 1911.16, 0.01), 'got ' + got + ', expected 1911.16');
});

/* ---- same month vs following month ---- */

check('same_month reads its OWN month, following_month reads the one before', () => {
  const gross = { '2026-02': 100000, '2026-03': 200000 };
  const same = { fee_type: 'pct_gross', fee_pct: 2, payment_timing: 'same_month' };
  const foll = { fee_type: 'pct_gross', fee_pct: 2, payment_timing: 'following_month' };
  assert.strictEqual(R.expectedFee(same, '2026-03', gross), 4000);
  assert.strictEqual(R.expectedFee(foll, '2026-03', gross), 2000);
});

/* ---- null is not zero. This is the whole file's reason to exist. ---- */

check('no income data gives NULL, never 0', () => {
  const s = { fee_type: 'pct_gross', fee_pct: 2, payment_timing: 'same_month' };
  assert.strictEqual(R.expectedFee(s, '2026-03', {}), null, 'absent month must be null');
  assert.strictEqual(R.expectedFee(s, '2026-03', { '2026-03': null }), null, 'explicit null must be null');
  assert.strictEqual(R.expectedFee(s, '2026-03', { '2026-03': 0 }), 0, 'a real zero is 0, not null');
});

check('a prototype key is not income - __proto__ gives null, never NaN', () => {
  /* grossByMonth is a plain object keyed by month, and `month` arrives from a
     saved view config. A bare grossByMonth['__proto__'] returns
     Object.prototype, which is neither undefined nor null, so it slips past
     the no-data guard and comes back NaN - a bogus number out of the one
     function whose job is to return null when it does not know. */
  const s = { fee_type: 'pct_gross', fee_pct: 2, payment_timing: 'same_month' };
  for (const bad of ['__proto__', 'constructor', 'toString', '2026-13', '', 'nope']) {
    const got = R.expectedFee(s, bad, {});
    assert.strictEqual(got, null, bad + ' gave ' + got);
  }
});

check('a fixed fee ignores income entirely, including when there is none', () => {
  const s = { fee_type: 'fixed', fixed_amount: 8291.67, payment_timing: 'following_month' };
  assert.strictEqual(R.expectedFee(s, '2026-03', {}), 8291.67);
});

check('a 0% fee is 0, not blank - Estrella and Sierra Gardens are 0%', () => {
  const s = { fee_type: 'pct_gross', fee_pct: 0, payment_timing: 'same_month' };
  assert.strictEqual(R.expectedFee(s, '2026-03', { '2026-03': 50000 }), 0);
});

/* ---- received, and the precedence rule ---- */

check('a recorded receipt beats the books; books never overwrite seed or manual', () => {
  const seeded = R.receivedFee({ amount_received: 8245.83, source: 'seed' }, 9999);
  assert.strictEqual(seeded.amount, 8245.83);
  assert.strictEqual(seeded.source, 'seed');
  const manual = R.receivedFee({ amount_received: 100, source: 'manual' }, 200);
  assert.strictEqual(manual.source, 'manual');
});

check('a zero receipt is a real receipt, not an absent one', () => {
  /* `if (receipt.amount_received)` would drop this and fall through to the
     books, turning "they paid nothing" into "the books say 500". */
  const r = R.receivedFee({ amount_received: 0, source: 'manual' }, 500);
  assert.strictEqual(r.amount, 0, 'got ' + r.amount);
  assert.strictEqual(r.source, 'manual');
});

check('no receipt and no books gives null, not 0', () => {
  const r = R.receivedFee(null, null);
  assert.strictEqual(r.amount, null);
  assert.strictEqual(r.source, null);
});

/* ---- variance ---- */

check('a PAST month with an expected fee and nothing received is -expected', () => {
  const v = R.variance(1000, null, '2026-01', new Date('2026-10-11T00:00:00Z'));
  assert.strictEqual(v, -1000);
});

check('the CURRENT month with nothing received is not yet a miss', () => {
  const v = R.variance(1000, null, '2026-10', new Date('2026-10-11T00:00:00Z'));
  assert.strictEqual(v, null, 'got ' + v + ' - the month is not over');
});

check('no expected figure means no variance, even in a past month', () => {
  /* otherwise every month before a property was owned reads as a missed
     payment of an amount nobody ever billed. */
  assert.strictEqual(R.variance(null, null, '2026-01', new Date('2026-10-11T00:00:00Z')), null);
});

check('feeRow puts it together', () => {
  const s = { fee_type: 'pct_gross', fee_pct: 2, payment_timing: 'following_month' };
  const row = R.feeRow(s, '2026-02', { '2026-01': 48469.52 },
                       { amount_received: 969.39, source: 'seed' }, null,
                       new Date('2026-10-11T00:00:00Z'));
  assert.ok(near(row.expected, 969.39));
  assert.strictEqual(row.received_source, 'seed');
  assert.ok(near(row.variance, 0));
});

/* ---- month arithmetic ---- */

check('prevMonth refuses nonsense rather than inventing a month', () => {
  assert.strictEqual(R.prevMonth('2026-13'), null);
  assert.strictEqual(R.prevMonth('nope'), null);
  assert.strictEqual(R.prevMonth(null), null);
  assert.strictEqual(R.prevMonth('2026-10'), '2026-09');
});

console.log('\nam fee rules: ' + pass + ' passed, ' + fails.length + ' failed');
if (fails.length) { fails.forEach(f => console.log('  FAIL  ' + f)); process.exit(1); }
