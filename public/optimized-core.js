/* ===========================================================================
   optimized-core.js: the Optimized NOI rules, shared (Jay, 2026-10-14).

   The SAME file runs on the server (props-api: Needs attention, the list's
   Optimized NOI, Reports) and in the browser (the tab recomputes as
   assumptions are typed). Built to docs/mockup/optimized-noi.dc.html, whose
   Component logic starts at "let o2".

   Every NOI window ENDS AT THE LATEST LOADED MONTH: T12, T6 x 2, T3 x 4, the
   lender view (last 3 months' operating income x 4 less T12 operating
   expenses) and stabilized NOI (market rent of every unit, less vacancy, plus
   other income, less T12 expenses and reserves). There is no "best months
   anywhere".

   Input is plain JSON built by props-api optimizedInputs():
     months   12 'YYYY-MM', the twelve ending at the latest loaded month
     noi, inc 12 numbers or null (null = no data that month)
     t12      { n, inc, opx, rent } sums over the months with data
     rr       { units, withMarket, marketAll (a month), vacant, asOf } or null
     units    unit count when there is no rent roll
     capexT12, loans [{ balance, ratePct, io, amortYears }], dsAct, dsSrc
   =========================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.OptimizedCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function isNum(v) { return typeof v === 'number' && isFinite(v); }
  function n(v) { var x = parseFloat(v); return isFinite(x) ? x : null; }
  function sum(a) { return a.reduce(function (x, y) { return x + y; }, 0); }

  /* the annual payment per dollar of loan */
  function paymentFactor(rate, yrs) {
    return rate && yrs ? 12 * (rate / 12) / (1 - Math.pow(1 + rate / 12, -yrs * 12)) : null;
  }

  /* the figures that come from records, before any assumption */
  function actuals(I) {
    var NN = I.noi, last = NN.length - 1;
    var win = function (w) {
      var have = []; for (var i = last - w + 1; i <= last; i++) if (i >= 0 && isNum(NN[i])) have.push(i);
      return have.length ? { sum: sum(have.map(function (i) { return NN[i]; })), n: have.length, first: have[0] } : null;
    };
    var t12w = win(12), t6w = win(6), t3w = win(3);
    var ann = function (w) { return w ? w.sum * 12 / w.n : null; };
    var T = I.t12 || {};
    var opx12 = isNum(T.opx) && T.n ? T.opx * 12 / Math.min(12, T.n) : null;
    var inc3 = I.inc.slice(-3).filter(isNum);
    var lender = inc3.length && opx12 !== null ? sum(inc3) * 12 / inc3.length - opx12 : null;
    var rr = I.rr;
    var units = rr && rr.units ? rr.units : (I.units || null);
    /* gross potential rent needs market rent for EVERY unit; a partial sum
       would understate it and overstate vacancy */
    var gpr = rr && rr.units && rr.withMarket === rr.units && rr.marketAll > 0 ? rr.marketAll * 12 : null;
    var rentT12 = isNum(T.rent) && T.n ? T.rent * 12 / T.n : null;
    var otherInc = isNum(T.inc) && isNum(T.rent) && T.n ? (T.inc - T.rent) * 12 / T.n : null;
    var rentCheck = gpr !== null && rentT12 !== null && rentT12 > gpr * 1.02;
    var econVac = gpr && rentT12 !== null && !rentCheck ? 1 - rentT12 / gpr : null;
    var physVac = rr && rr.units ? rr.vacant / rr.units : null;
    var L = I.loans || [];
    var withBal = L.filter(function (l) { return isNum(l.balance); });
    var loanBal = withBal.length ? sum(withBal.map(function (l) { return l.balance; })) : null;
    var rated = L.filter(function (l) { return isNum(l.ratePct) && isNum(l.balance) && l.balance > 0; });
    var rateAct = rated.length ? sum(rated.map(function (l) { return l.ratePct / 100 * l.balance; })) / sum(rated.map(function (l) { return l.balance; }))
      : (L[0] && isNum(L[0].ratePct) ? L[0].ratePct / 100 : null);
    var io = L.some(function (l) { return l.io; });
    var yrsLoan = L.filter(function (l) { return isNum(l.amortYears); })[0];
    var amortAct = io ? 'Interest only' : yrsLoan ? yrsLoan.amortYears : null;
    var T12 = ann(t12w);
    var dsAct = isNum(I.dsAct) && I.dsAct > 0 ? I.dsAct : null;
    return { t12w: t12w, t6w: t6w, t3w: t3w, T12: T12, T6: ann(t6w), T3: ann(t3w), lender: lender, opx12: opx12,
             units: units, gpr: gpr, rentT12: rentT12, otherInc: otherInc, rentCheck: rentCheck, econVac: econVac, physVac: physVac,
             loanBal: loanBal, rateAct: rateAct, amortAct: amortAct, loans: L.length, capexPerUnit: isNum(I.capexT12) && units ? I.capexT12 / units : null,
             dsAct: dsAct, dsSrc: I.dsSrc || 'Not on file', actDscr: dsAct && T12 !== null ? T12 / dsAct : null };
  }

  /* the standard assumptions, as the strings the inputs hold */
  function defaults(I, a) {
    a = a || actuals(I);
    return { req: '1.25', rate: '6.5', amort: '30', cap: '7', vac: '5', res: '250',
             loan: a.loanBal ? String(Math.round(a.loanBal)) : '', ds: a.dsAct ? String(Math.round(a.dsAct)) : '',
             w: a.T12 !== null ? String(Math.round(a.T12)) : '' };
  }

  /* everything the tab, Reports and Needs attention show, for one set of
     assumptions (strings; anything unparseable falls back as the mockup does) */
  function compute(I, cur) {
    var a = actuals(I), std = defaults(I, a);
    cur = Object.assign({}, std, cur || {});
    var req = n(cur.req) || 1.25, rate = n(cur.rate) ? n(cur.rate) / 100 : null, yrs = n(cur.amort), cap = n(cur.cap) ? n(cur.cap) / 100 : null;
    var vac = n(cur.vac) !== null ? n(cur.vac) / 100 : 0.05, resU = n(cur.res) !== null ? n(cur.res) : 250;
    var loan = n(cur.loan), ds = n(cur.ds), W = n(cur.w);
    var k = paymentFactor(rate, yrs);
    var vacLoss = a.gpr !== null ? a.gpr * vac : null;
    var egi = a.gpr !== null && a.otherInc !== null ? a.gpr - vacLoss + a.otherInc : null;
    var reserves = a.units ? resU * a.units : null;
    var stab = !a.rentCheck && egi !== null && a.opx12 !== null ? egi - a.opx12 - (reserves || 0) : null;
    var dOf = function (v) { return ds && isNum(v) ? v / ds : null; };
    var maxLoan = function (v) { return k && v > 0 ? v / req / k : null; };
    var dL = dOf(a.lender), dS = dOf(stab);
    var status;
    if (!ds) status = { name: 'No debt service', tone: 'muted', text: 'Enter or load the annual debt service to see coverage.' };
    else if (dL === null && dS === null) status = { name: 'Not enough data', tone: 'muted', text: 'Needs income and expenses for the latest months.' };
    else if (dL !== null && dL >= req) status = { name: 'Safe', tone: 'ok', text: 'A lender would size this loan comfortably today (lender view ' + dL.toFixed(2) + ').' };
    else if (dS !== null && dS >= req) status = { name: 'Fixable', tone: 'warn', text: 'Below ' + req.toFixed(2) + ' on current operations, but clears it once stabilized (' + dS.toFixed(2) + '): an operations gap.' };
    else if (dL !== null && dL >= 1) status = { name: 'At risk', tone: 'warn', text: 'Covers its payments but stays under ' + req.toFixed(2) + (dS !== null ? ', even stabilized (' + dS.toFixed(2) + ').' : '; stabilized needs market rent.') };
    else status = { name: 'Critical', tone: 'bad', text: 'Current operations do not cover the loan payments.' };
    var trend = a.T3 !== null && a.T12 ? a.T3 / a.T12 - 1 : null;
    var best = stab !== null ? stab : a.lender, bestKind = stab !== null ? 'stabilized' : 'lender view';
    var mlBest = maxLoan(best);
    var row = function (key, v) {
      var d = isNum(v) && v > 0 ? dOf(v) : null, ml = maxLoan(v);
      return { key: key, noi: isNum(v) ? v : null, vsT12: a.T12 && isNum(v) ? v / a.T12 - 1 : null, dscr: d, meets: d === null ? null : d >= req,
               max: ml, vs: ml !== null && loan !== null ? ml - loan : null, value: cap && v > 0 ? v / cap : null };
    };
    return {
      actual: a, std: std, cur: cur, edited: Object.keys(std).some(function (x) { return cur[x] !== std[x]; }),
      req: req, rate: rate, yrs: yrs, cap: cap, vac: vac, resU: resU, loan: loan, ds: ds, W: W, k: k,
      vacLoss: vacLoss, egi: egi, reserves: reserves, stab: stab, dL: dL, dS: dS, status: status,
      trend: trend, trendTxt: trend === null ? '' : trend > 0.03 ? 'Improving' : trend < -0.03 ? 'Softening' : 'Steady',
      best: best, bestKind: bestKind, maxLoanBest: mlBest, vsBest: mlBest !== null && loan !== null ? mlBest - loan : null,
      valueBest: cap && best > 0 ? best / cap : null,
      ladder: [row('t12', a.T12), row('t6', a.T6), row('t3', a.T3), row('lender', a.lender), row('stab', stab), row('w', W)],
    };
  }

  return { actuals: actuals, defaults: defaults, compute: compute, paymentFactor: paymentFactor };
});
