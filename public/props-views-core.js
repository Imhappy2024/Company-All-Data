/* ===========================================================================
   props-views-core.js — the Custom view engine's pure half, shared.

   The SAME file runs on the server (required by props-views.js, which adds
   the database reads) and in the browser (loaded by portal.html, so the
   builder's preview recalculates on every keystroke without a request).
   One definition of every field, period and formula rule means a preview can
   never disagree with the saved view it becomes.

   Nothing a user types is ever executed. The config is rebuilt from scratch
   against fixed lists: a field key must be in FIELDS, an operator one of
   + - * /, a number a finite number, a period one of the shapes below. A
   formula is a list of terms evaluated by a small precedence routine over
   numbers - no expression string, no eval, no SQL from anything in the config.

   Input data is PLAIN (JSON-safe): one object per property with its trailing
   figures, rent roll tuple and a `series` map { 'YYYY-MM': { inc, opx, ... } }.
   hydrate() adds the month()/ttm() accessors the field rules read.
   =========================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PropsViewsCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var YM = /^(\d{4})-(0[1-9]|1[0-2])$/;
  var UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  var MN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function ymAdd(ym, n) { var m = YM.exec(ym); var k = Number(m[1]) * 12 + Number(m[2]) - 1 + n; return Math.floor(k / 12) + '-' + String((k % 12) + 1).padStart(2, '0'); }
  function ymShort(ym) { var m = YM.exec(ym); return MN[Number(m[2]) - 1] + ' ' + m[1].slice(2); }
  function ymSpan(a, b) { var o = [], x = a; for (var i = 0; i < 36 && x <= b; i++) { o.push(x); x = ymAdd(x, 1); } return o; }
  function sumA(a) { var f = a.filter(function (v) { return v !== null && v !== undefined && !Number.isNaN(v); }); return f.length ? f.reduce(function (x, y) { return x + y; }, 0) : null; }

  /* -------------------------------------------------------------------------
     The mockup's FIELDS list:
     [key, label, group, type, value(q), monthly series key or null, combine(ps) or null]
     `combine` is the group-total rule for a ratio: computed from the totals,
     never the sum or average of each property's ratio.
  ------------------------------------------------------------------------- */
  function rr(q) { return q.rr || null; }
  var FIELDS = [
    ['address', 'Address', 'Location', 'text', function (q) { return q.address || null; }],
    ['manager', 'Property manager', 'Management', 'text', function (q) { return q.pm || null; }],
    ['entity', 'Managing entity', 'Management', 'text', function (q) { return q.mgr || 'Not on file'; }],
    ['units', 'Units', 'Rent roll', 'count', function (q) { return q.units; }],
    ['occ', 'Occupancy', 'Rent roll', 'pct', function (q) { return rr(q) && rr(q)[0] ? rr(q)[1] / rr(q)[0] : q.occ; }, null,
      function (ps) { var u = sumA(ps.map(function (q) { return rr(q) ? rr(q)[0] : null; })); var o = sumA(ps.map(function (q) { return rr(q) ? rr(q)[1] : null; })); return u ? o / u : null; }],
    ['vacant', 'Vacant units', 'Rent roll', 'count', function (q) { return rr(q) ? rr(q)[3] + rr(q)[4] : null; }],
    ['notice', 'On notice', 'Rent roll', 'count', function (q) { return rr(q) ? rr(q)[2] : null; }],
    ['rentRoll', 'Monthly rent', 'Rent roll', 'money', function (q) { return rr(q) ? rr(q)[5] : null; }],
    ['ltl', 'Loss to lease', 'Rent roll', 'money', function (q) { return rr(q) && rr(q)[6] !== null && rr(q)[5] ? rr(q)[6] - rr(q)[5] : null; }],
    ['delinq', 'Delinquency', 'Rent roll', 'money', function (q) { return rr(q) ? rr(q)[8] || 0 : null; }],
    ['prepaid', 'Prepaid rent', 'Rent roll', 'money', function (q) { return rr(q) ? rr(q)[10] || 0 : null; }],
    ['exp90', 'Leases expiring in 90 days', 'Rent roll', 'count', function (q) { return rr(q) ? rr(q)[11] : null; }],
    ['mtm', 'Month-to-month leases', 'Rent roll', 'count', function (q) { return rr(q) ? rr(q)[12] : null; }],
    ['avgRent', 'Average rent', 'Rent roll', 'money', function (q) { return rr(q) && rr(q)[1] && rr(q)[5] ? rr(q)[5] / rr(q)[1] : null; }, null,
      function (ps) { var r = sumA(ps.map(function (q) { return rr(q) ? rr(q)[5] : null; })); var o = sumA(ps.map(function (q) { return rr(q) && rr(q)[5] ? rr(q)[1] : null; })); return o ? r / o : null; }],
    ['mktRent', 'Average market rent', 'Rent roll', 'money', function (q) { return rr(q) && rr(q)[7] ? rr(q)[7] / rr(q)[0] : null; }, null,
      function (ps) { var m = sumA(ps.map(function (q) { return rr(q) && rr(q)[7] ? rr(q)[7] : null; })); var u = sumA(ps.map(function (q) { return rr(q) && rr(q)[7] ? rr(q)[0] : null; })); return u ? m / u : null; }],
    ['inc', 'Total operating income', 'Income and NOI', 'money', function (q) { return q.inc; }, 'inc'],
    ['opx', 'Total operating expense', 'Income and NOI', 'money', function (q) { return q.opx; }, 'opx'],
    ['noi', 'NOI', 'Income and NOI', 'money', function (q) { return q.noi; }, 'noi'],
    ['er', 'Expense ratio', 'Income and NOI', 'pct', function (q) { return q.inc ? q.opx / q.inc : null; }, null,
      function (ps) { var i = sumA(ps.map(function (q) { return q.inc; })); return i ? sumA(ps.map(function (q) { return q.opx; })) / i : null; }],
    ['opt', 'Optimized NOI', 'Income and NOI', 'money', function (q) { return q.opt; }],
    ['capex', 'Capital expense', 'Expenses and capex', 'money', function (q) { return sumA(q.ttm('capex')); }, 'capex'],
    ['capexRatio', 'Capex ratio', 'Expenses and capex', 'pct', function (q) { var c = sumA(q.ttm('capex')); return q.inc && c !== null ? c / q.inc : null; }, null,
      function (ps) { var i = sumA(ps.map(function (q) { return q.inc; })); return i ? sumA(ps.map(function (q) { return sumA(q.ttm('capex')); })) / i : null; }],
    ['amExp', 'Asset management fee, expected', 'Asset management fee', 'money', function (q) { return sumA(q.ttm('amExp')); }, 'amExp'],
    ['amRec', 'Asset management fee, received', 'Asset management fee', 'money', function (q) { return sumA(q.ttm('amRec')); }, 'amRec'],
    ['amVar', 'Asset management fee, variance', 'Asset management fee', 'money', function (q) { return sumA(q.ttm('amVar')); }, 'amVar'],
    ['ds', 'Debt service', 'Debt and value', 'money', function (q) { return q.ds; }, 'ds'],
    ['dscr', 'DSCR', 'Debt and value', 'ratio', function (q) { return q.ds && q.noi > 0 ? q.noi / q.ds : null; }, null,
      function (ps) { var pp = ps.filter(function (q) { return q.ds; }); var d = sumA(pp.map(function (q) { return q.ds; })); return d ? sumA(pp.map(function (q) { return q.noi; })) / d : null; }],
    ['cf', 'Cash flow after debt and capex', 'Debt and value', 'money', function (q) { return q.cf; }, 'cf'],
    ['debt', 'Debt', 'Debt and value', 'money', function (q) { return q.debt; }],
    ['value', 'Value on file', 'Debt and value', 'money', function (q) { return q.value; }],
  ];
  var FMAP = {};
  FIELDS.forEach(function (f) { FMAP[f[0]] = f; });
  var FIELD_LIST = FIELDS.map(function (f) { return { key: f[0], label: f[1], group: f[2], type: f[3], monthly: !!f[5] }; });
  var FIELD_GROUPS = ['Location', 'Rent roll', 'Income and NOI', 'Expenses and capex', 'Asset management fee', 'Debt and value', 'Management'];

  /* -------------------------------------------------------------------------
     Config validation: rebuilt from scratch, unknown keys dropped.
  ------------------------------------------------------------------------- */
  function str(v, n) { return String(v === null || v === undefined ? '' : v).slice(0, n); }
  var ID = /^[A-Za-z0-9_-]{1,40}$/;
  function uniq(a) { return a.filter(function (k, i) { return a.indexOf(k) === i; }); }

  function cleanPeriod(p) {
    if (!p || typeof p !== 'object') return { t: 'ttm' };
    if (p.t === 'ttm' || p.t === 'ytd') return { t: p.t };
    if (p.t === 'month' && YM.test(p.a)) return { t: 'month', a: p.a };
    if (p.t === 'range' && YM.test(p.a) && YM.test(p.b)) return { t: 'range', a: p.a <= p.b ? p.a : p.b, b: p.a <= p.b ? p.b : p.a };
    return { t: 'ttm' };
  }
  function cleanTerm(t, first) {
    var out = {};
    if (!first) out.op = ['+', '-', '*', '/'].indexOf(t && t.op) >= 0 ? t.op : '+';
    if (t && t.kind === 'num') { out.kind = 'num'; var n = Number(t.num); out.num = Number.isFinite(n) ? n : 0; return out; }
    out.kind = 'field';
    out.field = t && FMAP[t.field] && FMAP[t.field][3] !== 'text' ? t.field : 'inc';
    out.period = cleanPeriod(t && t.period);
    out.agg = t && t.agg === 'avg' ? 'avg' : 'total';
    return out;
  }
  function validateConfig(raw) {
    var c = raw && typeof raw === 'object' ? raw : {};
    var ids = function (a) { return (Array.isArray(a) ? a : []).map(String).filter(function (x) { return UUID.test(x); }).slice(0, 500); };
    var cfg = {
      mode: c.mode === 'quick' ? 'quick' : 'advanced',
      quickCards: !!c.quickCards,
      groups: uniq(ids(c.groups)).slice(0, 20),
      excl: (Array.isArray(c.excl) ? c.excl : []).map(String).filter(function (x) { return /^[0-9a-f-]{36}\|[0-9a-f-]{36}$/i.test(x); }).slice(0, 500),
      props: c.props === null || c.props === undefined ? null : uniq(ids(c.props)),
      fields: uniq((Array.isArray(c.fields) ? c.fields : []).filter(function (k) { return FMAP[k]; })).slice(0, 30),
      styles: uniq((Array.isArray(c.styles) ? c.styles : []).filter(function (s) { return ['table', 'list', 'chart'].indexOf(s) >= 0; })),
      chartField: FMAP[c.chartField] && FMAP[c.chartField][3] !== 'text' ? c.chartField : 'inc',
      cards: [],
    };
    (Array.isArray(c.cards) ? c.cards : []).slice(0, 24).forEach(function (k) {
      if (!k || !ID.test(String(k.id || ''))) return;
      var card = { id: String(k.id), label: str(k.label, 120), size: ['S', 'M', 'L'].indexOf(k.size) >= 0 ? k.size : 'M',
                   kind: k.kind === 'formula' ? 'formula' : 'value' };
      if (card.kind === 'formula') {
        card.fmt = ['money', 'number', 'pct', 'ratio'].indexOf(k.fmt) >= 0 ? k.fmt : 'money';
        card.terms = (Array.isArray(k.terms) ? k.terms : []).slice(0, 12).map(function (t, i) { return cleanTerm(t, i === 0); });
        if (!card.terms.length) card.terms = [cleanTerm(null, true)];
      } else {
        var t = cleanTerm(k, true);
        card.field = t.field; card.period = t.period; card.agg = t.agg;
      }
      cfg.cards.push(card);
    });
    var want = cfg.cards.map(function (x) { return 'card:' + x.id; }).concat(cfg.styles);
    var lay = (Array.isArray(c.layout) ? c.layout : []).map(String);
    var kept = lay.filter(function (k, i) { return want.indexOf(k) >= 0 && lay.indexOf(k) === i; });
    cfg.layout = kept.concat(want.filter(function (k) { return kept.indexOf(k) < 0; }));
    return cfg;
  }

  /* -------------------------------------------------------------------------
     Which properties: groups (each group's members in property-id order, the
     same order /api/props/groups returns), minus per-view exclusions; or a
     hand-picked list. `groups` is [{ id, name, property_ids }].
  ------------------------------------------------------------------------- */
  function resolve(cfg, groups) {
    if (!cfg.groups.length) return { ids: (cfg.props || []).slice(), groupNames: [] };
    var ex = {}; cfg.excl.forEach(function (x) { ex[x] = true; });
    var out = [], names = [];
    cfg.groups.forEach(function (gid) {
      var g = (groups || []).find(function (x) { return x.id === gid; });
      if (!g || !(g.property_ids || []).length) return;
      names.push(g.name);
      (g.property_ids || []).slice().sort().forEach(function (pid) {
        if (!ex[gid + '|' + pid] && out.indexOf(pid) < 0) out.push(pid);
      });
    });
    return { ids: out, groupNames: names };
  }

  /* plain property -> the object the field rules read */
  function hydrate(p, t) {
    var ttmMonths = ymSpan(ymAdd(t, -11), t);
    var q = Object.assign({}, p);
    var se = p.series || {};
    q.month = function (m, k) { return se[m] && Object.prototype.hasOwnProperty.call(se[m], k) ? se[m][k] : null; };
    q.ttm = function (k) { return ttmMonths.map(function (m) { return q.month(m, k); }); };
    return q;
  }

  /* -------------------------------------------------------------------------
     Evaluation: the mockup's propVal / termVal / evalFormula, unchanged in
     meaning.
  ------------------------------------------------------------------------- */
  function monthsOf(pd, t) {
    if (pd.t === 'ytd') return ymSpan(t.slice(0, 4) + '-01', t);
    if (pd.t === 'month') return [pd.a];
    if (pd.t === 'range') return ymSpan(pd.a, pd.b);
    return null;
  }
  function periodText(pd, t) {
    if (pd.t === 'ttm') return 'trailing 12 months';
    if (pd.t === 'ytd') return 'Jan to ' + MN[Number(t.slice(5)) - 1] + ' ' + t.slice(0, 4);
    if (pd.t === 'month') return ymShort(pd.a);
    return ymShort(pd.a) + ' to ' + ymShort(pd.b);
  }
  function propVal(f, q, pd, t) {
    if (!f[5] || !pd || pd.t === 'ttm') return f[4](q);
    var ms = monthsOf(pd, t);
    /* a month after the latest data is not loaded yet: say so with "–" rather
       than total what is there */
    if (ms.some(function (m) { return m > t; })) return null;
    return sumA(ms.map(function (m) { return q.month(m, f[5]); }));
  }
  function termVal(ps, tm, t) {
    var f = FMAP[tm.field]; if (!f) return null;
    if (f[6] && (!f[5] || !tm.period || tm.period.t === 'ttm')) return f[6](ps);
    var vals = ps.map(function (q) { return propVal(f, q, f[5] ? tm.period : null, t); })
      .filter(function (v) { return v !== null && v !== undefined && !Number.isNaN(v); });
    if (!vals.length) return null;
    var s = vals.reduce(function (a, b) { return a + b; }, 0);
    if (f[3] === 'pct' || f[3] === 'ratio' || tm.agg === 'avg') return s / vals.length;
    return s;
  }
  function termText(tm, t) {
    var f = FMAP[tm.field]; if (!f) return '?';
    return f[1] + (f[5] ? ', ' + periodText(tm.period || { t: 'ttm' }, t) : '') + (tm.agg === 'avg' && f[3] !== 'pct' && f[3] !== 'ratio' ? ' (average)' : '');
  }
  /* standard precedence over a flat list: × and ÷ bind first, then + and −,
     left to right. Division by zero is no answer, not infinity. */
  function evalFormula(ps, terms, t) {
    var vals = terms.map(function (tm) { return tm.kind === 'num' ? tm.num : termVal(ps, tm, t); });
    if (vals.some(function (v) { return v === null || v === undefined || Number.isNaN(v); })) return null;
    var st = [vals[0]], ops = [];
    for (var i = 1; i < terms.length; i++) {
      var op = terms[i].op;
      if (op === '*' || op === '/') {
        var a = st.pop();
        if (op === '/' && vals[i] === 0) return null;
        st.push(op === '*' ? a * vals[i] : a / vals[i]);
      } else { ops.push(op); st.push(vals[i]); }
    }
    var r = st[0];
    ops.forEach(function (o, j) { r = o === '-' ? r - st[j + 1] : r + st[j + 1]; });
    return Number.isFinite(r) ? r : null;
  }
  var OPN = { '+': '+', '-': '−', '*': '×', '/': '÷' };
  function formulaText(terms, t) { return terms.map(function (tm, i) { return (i ? OPN[tm.op] + ' ' : '') + (tm.kind === 'num' ? String(tm.num) : termText(tm, t)); }).join(' '); }

  function cardResult(ps, c, t) {
    if (c.kind === 'formula') return { value: evalFormula(ps, c.terms, t), type: c.fmt, sub: formulaText(c.terms, t) };
    var f = FMAP[c.field];
    return { value: termVal(ps, c, t), type: f[3],
             sub: termText(c, t) + (f[3] === 'pct' || f[3] === 'ratio' || f[6] ? '' : c.agg === 'avg' ? '' : ', total') };
  }

  /* cfg: validated config. sel: resolve() output. data: { through, props } with
     plain props for (at least) every id in sel.ids. */
  function evaluateData(cfg, sel, data) {
    var t = data.through;
    var byId = {}; (data.props || []).forEach(function (p) { byId[p.id] = p; });
    var ps = sel.ids.map(function (id) { return byId[id]; }).filter(Boolean).map(function (p) { return hydrate(p, t); });
    var fs = cfg.fields.map(function (k) { return FMAP[k]; });
    var numF = fs.filter(function (f) { return f[3] !== 'text'; });
    var cf = FMAP[cfg.chartField] || numF[0] || FMAP.inc;
    return {
      through: t,
      count: ps.length, groupNames: sel.groupNames, excluded: cfg.excl.length,
      properties: ps.map(function (q) { return { id: q.id, name: q.name, address: q.address, mgr: q.mgr }; }),
      cards: cfg.cards.map(function (c) { return Object.assign({ id: c.id }, cardResult(ps, c, t)); }),
      heads: fs.map(function (f) { return { key: f[0], label: f[1], type: f[3] }; }),
      rows: ps.map(function (q) { return { id: q.id, name: q.name, mgr: q.mgr, cells: fs.map(function (f) { return f[4](q); }) }; }),
      totals: fs.map(function (f) { return f[3] === 'text' ? null : termVal(ps, { field: f[0], period: { t: 'ttm' }, agg: 'total' }, t); }),
      list: ps.map(function (q) { return { id: q.id, name: q.name, address: q.address, kv: numF.map(function (f) { return { k: f[1], type: f[3], v: f[4](q) }; }) }; }),
      chart: { title: cf[1] + ' by property', type: cf[3],
               bars: ps.map(function (q) { return { id: q.id, name: q.name, v: cf[4](q) }; })
                 .filter(function (b) { return b.v !== null && b.v !== undefined; }).sort(function (a, b) { return b.v - a.v; }) },
    };
  }

  function periodOptionsFor(t) {
    var months = ymSpan(ymAdd(t, -11), ymAdd(t, 3));
    return { through: t, ytdLabel: 'Jan to ' + MN[Number(t.slice(5)) - 1] + ' ' + t.slice(0, 4),
             months: months.map(function (m) { return { value: m, label: ymShort(m) }; }) };
  }

  return { FIELDS: FIELDS, FIELD_LIST: FIELD_LIST, FIELD_GROUPS: FIELD_GROUPS, FMAP: FMAP,
           validateConfig: validateConfig, resolve: resolve, evaluateData: evaluateData, periodOptionsFor: periodOptionsFor,
           hydrate: hydrate, evalFormula: evalFormula, termVal: termVal, cleanPeriod: cleanPeriod,
           ymAdd: ymAdd, ymSpan: ymSpan };
});
