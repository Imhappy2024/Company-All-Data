// ===========================================================================
// noi-analysis.js — optimized NOI, DSCR and max loan, as pure functions.
//
// Phase 2.6's arithmetic. The what-if inputs on that screen (cap rate,
// required DSCR, rate, amortization) change numbers on screen only and are
// never saved, so the maths has to run in the browser as well as the server.
// Keeping it here, with no I/O and no DOM, is what lets both use it and lets
// the tests pin the brief's acceptance figures without a database.
//
// Three rules that are easy to get wrong:
//
//  * A window of N consecutive months means N months that are actually
//    adjacent on the calendar. A gap in the data is not consecutive, and
//    sliding over an array of whatever months happen to exist silently
//    treats Jan and Nov as neighbours if the nine between are missing.
//
//  * Optimized NOI needs SIX months. With five it is null, not a smaller
//    window scaled up — a property with four good months would otherwise
//    report an annualised figure built from a quarter of a year.
//
//  * Only months on or after first_active_month count. A month before the
//    property was owned is absent data, not a zero-NOI month, and averaging
//    it in drags every window down.
// ===========================================================================
'use strict';

const MONTH_KEY = /^\d{4}-(0[1-9]|1[0-2])$/;

function monthIndex(key) {
  if (!MONTH_KEY.test(key || '')) return null;
  return Number(key.slice(0, 4)) * 12 + (Number(key.slice(5, 7)) - 1);
}

/* rows: [{ month: 'YYYY-MM', noi: number|null }], any order.
   Returns the best sum over a window of exactly `size` ADJACENT months, or
   null when no such run exists. */
function bestWindow(rows, size) {
  const usable = (rows || [])
    .filter(r => r && MONTH_KEY.test(r.month) && r.noi !== null && r.noi !== undefined && isFinite(r.noi))
    .map(r => ({ idx: monthIndex(r.month), noi: Number(r.noi), month: r.month }))
    .sort((a, b) => a.idx - b.idx);

  let best = null;
  for (let start = 0; start + size <= usable.length; start++) {
    const end = start + size - 1;
    // adjacency: the run must span exactly `size` calendar months
    if (usable[end].idx - usable[start].idx !== size - 1) continue;
    let sum = 0;
    for (let i = start; i <= end; i++) sum += usable[i].noi;
    if (best === null || sum > best.total) {
      best = { total: sum, from: usable[start].month, to: usable[end].month, months: size };
    }
  }
  return best;
}

/* Optimized NOI: the best 6 consecutive months, doubled. Null below 6. */
function optimizedNoi(rows) {
  const w = bestWindow(rows, 6);
  return w ? { annual: w.total * 2, from: w.from, to: w.to, basis: 'best 6 consecutive months x 2' } : null;
}

/* The brief's annual constant:
     k = 12 * (r/12) / (1 - (1 + r/12)^(-years*12))
   which is the annual payment per dollar borrowed. A zero rate amortises
   linearly and the formula divides by zero, so it is handled separately. */
function annualConstant(ratePct, years) {
  const r = Number(ratePct) / 100;
  const n = Number(years) * 12;
  if (!isFinite(r) || !isFinite(n) || n <= 0) return null;
  if (r === 0) return 12 / n;
  const i = r / 12;
  return (12 * i) / (1 - Math.pow(1 + i, -n));
}

/* Max loan = annual NOI / required DSCR / k */
function maxLoan(annualNoi, requiredDscr, ratePct, years) {
  if (annualNoi === null || annualNoi === undefined || !isFinite(annualNoi)) return null;
  const d = Number(requiredDscr);
  if (!isFinite(d) || d <= 0) return null;
  const k = annualConstant(ratePct, years);
  if (k === null || k <= 0) return null;
  return annualNoi / d / k;
}

/* DSCR is null, never Infinity, when there is no debt service. A property
   with no debt does not have infinite coverage; it has no ratio. */
function dscr(noi, debtService) {
  if (noi === null || noi === undefined) return null;
  if (debtService === null || debtService === undefined || Number(debtService) === 0) return null;
  return Number(noi) / Number(debtService);
}

/* Value at a cap rate. A zero or absent cap rate has no value, rather than
   an infinite one. */
function valueAtCap(annualNoi, capRatePct) {
  if (annualNoi === null || annualNoi === undefined) return null;
  const c = Number(capRatePct) / 100;
  if (!isFinite(c) || c <= 0) return null;
  return annualNoi / c;
}

/* Both the server and the browser use this. The what-if inputs on the
   Optimized NOI and DSCR tabs change numbers on screen only and are never
   saved, so the maths has to run client-side - and it must be the SAME
   maths, or the screen and the API disagree about the same property. One
   file, loaded two ways, is what makes that impossible. */
const API = { monthIndex, bestWindow, optimizedNoi, annualConstant, maxLoan, dscr, valueAtCap };
if (typeof module !== 'undefined' && module.exports) module.exports = API;
if (typeof window !== 'undefined') window.NoiAnalysis = API;
