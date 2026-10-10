// ===========================================================================
// am-fee-rules.js — the asset management fee arithmetic, as pure functions.
//
// The same rules are expressed in SQL in reporting.am_fee_month. They live
// here as well because the brief asks for them unit-tested, and because a
// rule you can only exercise by standing up Postgres is a rule nobody runs
// the edge cases on. The SQL is what the screens read; this is what pins the
// behaviour.
//
// The rules:
//   gross            = total_operating_income for the month, cash basis
//   pct + same_month      -> pct x gross(M)
//   pct + following_month -> pct x gross(M-1)
//   fixed                 -> fixed_amount, whatever the income
//   no income data        -> null, NEVER 0
//   received         = a recorded receipt, else the fee booked in the books
//   variance         = received - expected
//                      a PAST month with an expected figure and nothing
//                      received is -expected, not null
//
// The distinction this file exists to protect is null versus zero. "We have
// no income figure for March" and "March income was zero" produce the same
// screen if you coalesce, and the first is the common case for a property
// that was not owned yet. Every function here returns null rather than 0 when
// the input is absent, and the tests assert it both ways.
// ===========================================================================
'use strict';

/* fee_pct is a WHOLE-NUMBER percent: 2 means 2%. This is deliberately the
   opposite of loan.interest_rate_pct, which CLAUDE.md records as a FRACTION
   (0.035 = 3.50%). Two columns ending _pct with opposite conventions is a
   trap, so the divisor is named rather than left as a bare / 100. The CHECK
   constraint on am_fee_schedule.fee_pct (0..100) is the other half. */
const PCT_TO_FRACTION = 100;

const FEE_TYPE = { PCT_GROSS: 'pct_gross', FIXED: 'fixed' };
const TIMING = { SAME_MONTH: 'same_month', FOLLOWING_MONTH: 'following_month' };
const SOURCE = { SEED: 'seed', BOOKS: 'books', MANUAL: 'manual' };

/* A month key is 'YYYY-MM', zero-padded, so a plain < is a real month
   comparison. Dates are never constructed from these strings:
   `new Date('2026-03-01')` is UTC midnight and shifts a month backwards for
   any reader west of UTC, which is the same class of bug CLAUDE.md records
   against toLocaleDateString on paid_at. String arithmetic has no timezone. */
const MONTH_KEY = /^\d{4}-(0[1-9]|1[0-2])$/;
const monthKey = (y, mo) => y + '-' + String(mo).padStart(2, '0');

function prevMonth(key) {
  if (!MONTH_KEY.test(key || '')) return null;
  let y = Number(key.slice(0, 4)), mo = Number(key.slice(5, 7));
  mo -= 1;
  if (mo === 0) { mo = 12; y -= 1; }
  return monthKey(y, mo);
}

/* UTC, not the local clock. reporting.am_fee_month decides the same thing
   with the database's current_date, and a server in Asia/Manila reading a UTC
   database disagrees with it for the first hours of every month - which flips
   variance between -expected and null, the exact null-versus-zero distinction
   this file exists to protect. Callers that need a specific day pass `today`. */
function isPastMonth(key, today) {
  const now = today || new Date();
  const cur = monthKey(now.getUTCFullYear(), now.getUTCMonth() + 1);
  return typeof key === 'string' && key < cur;
}

/* schedule: { fee_type, fee_pct, fixed_amount, payment_timing }
   grossByMonth: { 'YYYY-MM': number | null | undefined } */
function expectedFee(schedule, month, grossByMonth) {
  if (!schedule) return null;
  if (schedule.fee_type === FEE_TYPE.FIXED) {
    return schedule.fixed_amount === null || schedule.fixed_amount === undefined
      ? null : Number(schedule.fixed_amount);
  }
  if (schedule.fee_type !== FEE_TYPE.PCT_GROSS) return null;
  if (schedule.fee_pct === null || schedule.fee_pct === undefined) return null;

  const key = schedule.payment_timing === TIMING.FOLLOWING_MONTH ? prevMonth(month) : month;
  // The same_month branch takes `month` verbatim, so it has to be validated
  // here too. Without this, a key of '__proto__' or 'constructor' reads off
  // Object.prototype, which is neither undefined nor null, slips past the
  // guard below and returns NaN - a bogus number where the whole point of
  // this function is to return null when it does not know.
  if (!MONTH_KEY.test(key || '')) return null;

  const gross = grossByMonth && Object.prototype.hasOwnProperty.call(grossByMonth, key)
    ? grossByMonth[key] : undefined;
  // absent OR explicitly null is "no income data" -> blank, not zero.
  if (gross === undefined || gross === null) return null;

  return (Number(schedule.fee_pct) / PCT_TO_FRACTION) * Number(gross);
}

/* receipt: { amount_received, source } | null   booked: number | null */
function receivedFee(receipt, booked) {
  if (receipt && receipt.amount_received !== null && receipt.amount_received !== undefined) {
    // a recorded receipt always wins: 'books' must never overwrite 'seed' or
    // 'manual', because the books figure is what we are checking against.
    return { amount: Number(receipt.amount_received), source: receipt.source || SOURCE.MANUAL };
  }
  if (booked !== null && booked !== undefined) return { amount: Number(booked), source: SOURCE.BOOKS };
  return { amount: null, source: null };
}

function variance(expected, received, month, today) {
  if (expected === null || expected === undefined) return null;   // nothing to vary from
  if (received !== null && received !== undefined) return received - expected;
  // expected, nothing received: a past month is a full miss; the current and
  // future months are simply not due yet.
  return isPastMonth(month, today) ? -expected : null;
}

function feeRow(schedule, month, grossByMonth, receipt, booked, today) {
  const expected = expectedFee(schedule, month, grossByMonth);
  const r = receivedFee(receipt, booked);
  return {
    month,
    expected,
    received: r.amount,
    received_source: r.source,
    variance: variance(expected, r.amount, month, today),
  };
}

module.exports = {
  prevMonth, isPastMonth, expectedFee, receivedFee, variance, feeRow,
  FEE_TYPE, TIMING, SOURCE, PCT_TO_FRACTION,
};
