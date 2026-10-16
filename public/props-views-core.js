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
  /* a field follows a date range when it is a monthly figure, or a ratio
     built only from monthly figures; rent roll, debt and value are snapshots */
  var DERIVED = { er: 1, capexRatio: 1, dscr: 1 };
  function periodic(f) { return !!(f && (f[5] || DERIVED[f[0]])); }
  var FIELD_LIST = FIELDS.map(function (f) { return { key: f[0], label: f[1], group: f[2], type: f[3], monthly: periodic(f) }; });
  var FIELD_GROUPS = ['Location', 'Rent roll', 'Income and NOI', 'Expenses and capex', 'Asset management fee', 'Debt and value', 'Management'];

  /* -------------------------------------------------------------------------
     Config validation: rebuilt from scratch, unknown keys dropped.
  ------------------------------------------------------------------------- */
  function str(v, n) { return String(v === null || v === undefined ? '' : v).slice(0, n); }
  var ID = /^[A-Za-z0-9_-]{1,40}$/;
  function uniq(a) { return a.filter(function (k, i) { return a.indexOf(k) === i; }); }

  /* Period shapes: ttm | ytd | last (n = 1, 3 or 6 latest months) | year (y)
     | month (a) | range (a..b), plus 'view' on a card or formula term: "use
     the view's dates". A view's own dates never take 'view'. */
  function cleanPeriod(p, allowView) {
    if (!p || typeof p !== 'object') return { t: 'ttm' };
    if (p.t === 'ttm' || p.t === 'ytd') return { t: p.t };
    if (p.t === 'view' && allowView) return { t: 'view' };
    if (p.t === 'last' && [1, 3, 6].indexOf(Number(p.n)) >= 0) return { t: 'last', n: Number(p.n) };
    if (p.t === 'year' && /^\d{4}$/.test(String(p.y))) return { t: 'year', y: String(p.y) };
    if (p.t === 'month' && YM.test(p.a)) return { t: 'month', a: p.a };
    if (p.t === 'range' && YM.test(p.a) && YM.test(p.b)) return { t: 'range', a: p.a <= p.b ? p.a : p.b, b: p.a <= p.b ? p.b : p.a };
    return { t: 'ttm' };
  }
  function int(v, lo, hi, dflt) { var n = Math.round(Number(v)); return Number.isFinite(n) && n >= lo && n <= hi ? n : dflt; }
  var SPAN = { S: 3, M: 4, L: 6 };
  var BLOCKS = ['table', 'list', 'chart'];

  /* The spreadsheet's own settings. Formulas are stored as text and only ever
     read by sheet-core.js's parser; here they are just bounded strings. */
  /* a free cell: "<rows below Total>|<column key>" (sheet-core.js) */
  var CELL_KEY = /^(\d{1,3})\|([A-Za-z0-9_:-]{1,48})$/;
  var FMTS = ['auto', 'money', 'number', 'pct', 'ratio', 'text'];
  function cleanSheet(s) {
    s = s && typeof s === 'object' ? s : {};
    var out = { n: int(s.n, 0, 5000, 0), cols: [], cells: {}, colW: {}, rowH: {}, sort: null, rows: int(s.rows, 5, 200, 20) };
    (Array.isArray(s.cols) ? s.cols : []).slice(0, 20).forEach(function (c) {
      if (!c || !ID.test(String(c.id || ''))) return;
      var col = { id: String(c.id), label: str(c.label, 80) || 'New column', kind: c.kind === 'input' ? 'input' : 'formula',
                  fmt: FMTS.indexOf(c.fmt) >= 0 ? c.fmt : 'auto', f: str(c.f, 1000), vals: {} };
      var v = c.vals && typeof c.vals === 'object' ? c.vals : {};
      Object.keys(v).slice(0, 600).forEach(function (pid) { if (UUID.test(pid) && v[pid] !== '' && v[pid] !== null && v[pid] !== undefined) col.vals[pid] = str(v[pid], 1000); });
      out.cols.push(col);
    });
    var cells = s.cells && typeof s.cells === 'object' ? s.cells : {};
    Object.keys(cells).slice(0, 3000).forEach(function (k) {
      var m = CELL_KEY.exec(k), x = cells[k];
      if (!m || +m[1] < 1 || +m[1] > 200 || !x || typeof x !== 'object') return;
      var v = str(x.v, 1000);
      if (v === '' && !x.fmt) return;
      out.cells[k] = { v: v }; if (FMTS.indexOf(x.fmt) > 0) out.cells[k].fmt = x.fmt;
    });
    var dims = function (o, lo, hi) {
      var r = {}; o = o && typeof o === 'object' ? o : {};
      Object.keys(o).slice(0, 800).forEach(function (k) { if (/^[A-Za-z0-9_:-]{1,48}$/.test(k)) { var n = int(o[k], lo, hi, null); if (n !== null) r[k] = n; } });
      return r;
    };
    out.colW = dims(s.colW, 40, 800); out.rowH = dims(s.rowH, 18, 300);
    if (s.sort && typeof s.sort === 'object' && /^[A-Za-z0-9_:-]{1,48}$/.test(String(s.sort.key || ''))) out.sort = { key: String(s.sort.key), dir: s.sort.dir === 'desc' ? 'desc' : 'asc' };
    return out;
  }
  function cleanTerm(t, first) {
    var out = {};
    if (!first) out.op = ['+', '-', '*', '/'].indexOf(t && t.op) >= 0 ? t.op : '+';
    if (t && t.kind === 'num') { out.kind = 'num'; var n = Number(t.num); out.num = Number.isFinite(n) ? n : 0; return out; }
    out.kind = 'field';
    out.field = t && FMAP[t.field] && FMAP[t.field][3] !== 'text' ? t.field : 'inc';
    out.period = cleanPeriod(t && t.period, true);
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
      period: cleanPeriod(c.period),
      cards: [],
      blocks: {},
      sheet: cleanSheet(c.sheet),
    };
    var bl = c.blocks && typeof c.blocks === 'object' ? c.blocks : {};
    BLOCKS.forEach(function (k) { var b = bl[k] || {}; cfg.blocks[k] = { w: int(b.w, 1, 12, 12), h: int(b.h, 0, 30, 0) }; });
    (Array.isArray(c.cards) ? c.cards : []).slice(0, 24).forEach(function (k) {
      if (!k || !ID.test(String(k.id || ''))) return;
      var size = ['S', 'M', 'L'].indexOf(k.size) >= 0 ? k.size : 'M';
      /* w: grid columns of 12; h: rows of 44px. Views saved before these
         existed keep the width their S/M/L size gave them. */
      var card = { id: String(k.id), label: str(k.label, 120), size: size, w: int(k.w, 1, 12, SPAN[size]), h: int(k.h, 1, 12, 2),
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

  /* plain property -> the object the field rules read, for the trailing 12
     months (the figures as loaded) */
  function hydrate(p, t) {
    var ttmMonths = ymSpan(ymAdd(t, -11), t);
    var q = Object.assign({}, p);
    var se = p.series || {};
    q.month = function (m, k) { return se[m] && Object.prototype.hasOwnProperty.call(se[m], k) ? se[m][k] : null; };
    q.ttm = function (k) { return ttmMonths.map(function (m) { return q.month(m, k); }); };
    return q;
  }
  /* the same property seen through a date range: every monthly figure is the
     total of the range's months and q.ttm() walks those months instead, so
     every field rule (ratios included) answers for the range unchanged.
     Snapshot figures (rent roll, debt, value, optimized NOI) are left alone. */
  var SCOPED = ['inc', 'opx', 'noi', 'ds', 'cf'];
  function scope(q, pd, t) {
    if (!pd || pd.t === 'ttm') return q;
    var ms = monthsOf(pd, t);
    /* a month after the latest data is not loaded yet: say so with "–"
       rather than total what is there */
    var future = ms.some(function (m) { return m > t; });
    var s = Object.assign({}, q);
    SCOPED.forEach(function (k) { s[k] = future ? null : sumA(ms.map(function (m) { return q.month(m, k); })); });
    s.ttm = function (k) { return ms.map(function (m) { return future ? null : q.month(m, k); }); };
    return s;
  }

  function monthsOf(pd, t) {
    if (pd.t === 'ytd') return ymSpan(t.slice(0, 4) + '-01', t);
    if (pd.t === 'last') return ymSpan(ymAdd(t, 1 - pd.n), t);
    if (pd.t === 'year') return ymSpan(pd.y + '-01', pd.y + '-12');
    if (pd.t === 'month') return [pd.a];
    if (pd.t === 'range') return ymSpan(pd.a, pd.b);
    return ymSpan(ymAdd(t, -11), t);
  }
  function periodText(pd, t) {
    if (pd.t === 'ttm') return 'trailing 12 months';
    if (pd.t === 'ytd') return 'Jan to ' + MN[Number(t.slice(5)) - 1] + ' ' + t.slice(0, 4);
    if (pd.t === 'last') return pd.n === 1 ? 'latest month, ' + ymShort(t) : 'last ' + pd.n + ' months, ' + ymShort(ymAdd(t, 1 - pd.n)) + ' to ' + ymShort(t);
    if (pd.t === 'year') return 'Jan to Dec ' + pd.y;
    if (pd.t === 'month') return ymShort(pd.a);
    return ymShort(pd.a) + ' to ' + ymShort(pd.b);
  }
  /* a term's period, with "use the view's dates" resolved */
  function periodOf(tm, vp) { var pd = (tm && tm.period) || { t: 'ttm' }; return pd.t === 'view' ? vp : pd; }

  /* ps(pd): the properties seen through period pd (cached per period) */
  function termVal(ps, tm, t, vp) {
    var f = FMAP[tm.field]; if (!f) return null;
    var qs = ps(periodic(f) ? periodOf(tm, vp || { t: 'ttm' }) : { t: 'ttm' });
    if (f[6]) return f[6](qs);
    var vals = qs.map(function (q) { return f[4](q); })
      .filter(function (v) { return v !== null && v !== undefined && !Number.isNaN(v); });
    if (!vals.length) return null;
    var s = vals.reduce(function (a, b) { return a + b; }, 0);
    if (f[3] === 'pct' || f[3] === 'ratio' || tm.agg === 'avg') return s / vals.length;
    return s;
  }
  function termText(tm, t, vp) {
    var f = FMAP[tm.field]; if (!f) return '?';
    return f[1] + (periodic(f) ? ', ' + periodText(periodOf(tm, vp || { t: 'ttm' }), t) : '') + (tm.agg === 'avg' && f[3] !== 'pct' && f[3] !== 'ratio' ? ' (average)' : '');
  }
  /* standard precedence over a flat list: × and ÷ bind first, then + and −,
     left to right. Division by zero is no answer, not infinity. */
  function evalFormula(ps, terms, t, vp) {
    var vals = terms.map(function (tm) { return tm.kind === 'num' ? tm.num : termVal(ps, tm, t, vp); });
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
  function formulaText(terms, t, vp) { return terms.map(function (tm, i) { return (i ? OPN[tm.op] + ' ' : '') + (tm.kind === 'num' ? String(tm.num) : termText(tm, t, vp)); }).join(' '); }

  function cardResult(ps, c, t, vp) {
    if (c.kind === 'formula') return { value: evalFormula(ps, c.terms, t, vp), type: c.fmt, sub: formulaText(c.terms, t, vp) };
    var f = FMAP[c.field];
    return { value: termVal(ps, c, t, vp), type: f[3],
             sub: termText(c, t, vp) + (f[3] === 'pct' || f[3] === 'ratio' || f[6] ? '' : c.agg === 'avg' ? '' : ', total') };
  }

  /* cfg: validated config. sel: resolve() output. data: { through, props } with
     plain props for (at least) every id in sel.ids. period: the dates picked
     on screen, overriding the view's own (cfg.period) for this answer only. */
  function evaluateData(cfg, sel, data, period) {
    var t = data.through;
    var vp = period ? cleanPeriod(period) : cfg.period || { t: 'ttm' };
    var byId = {}; (data.props || []).forEach(function (p) { byId[p.id] = p; });
    var base = sel.ids.map(function (id) { return byId[id]; }).filter(Boolean).map(function (p) { return hydrate(p, t); });
    var cache = {};
    var ps = function (pd) {
      var k = JSON.stringify(pd);
      return cache[k] || (cache[k] = base.map(function (q) { return scope(q, pd, t); }));
    };
    /* quick-build cards are made for the view as a whole, so they follow its dates */
    var cards = cfg.mode === 'quick' ? cfg.cards.map(function (c) { return Object.assign({}, c, { period: { t: 'view' } }); }) : cfg.cards;
    var fs = cfg.fields.map(function (k) { return FMAP[k]; });
    var numF = fs.filter(function (f) { return f[3] !== 'text'; });
    var cf = FMAP[cfg.chartField] || numF[0] || FMAP.inc;
    var at = function (f) { return function (q) { return f[4](q); }; };
    var rowsQ = ps(vp);
    return {
      through: t,
      period: vp, periodText: periodText(vp, t),
      count: base.length, groupNames: sel.groupNames, excluded: cfg.excl.length,
      properties: base.map(function (q) { return { id: q.id, name: q.name, address: q.address, mgr: q.mgr }; }),
      cards: cards.map(function (c) { return Object.assign({ id: c.id }, cardResult(ps, c, t, vp)); }),
      heads: fs.map(function (f) { return { key: f[0], label: f[1], type: f[3], dated: periodic(f) }; }),
      rows: rowsQ.map(function (q) { return { id: q.id, name: q.name, mgr: q.mgr, cells: fs.map(function (f) { return f[4](q); }) }; }),
      totals: fs.map(function (f) { return f[3] === 'text' ? null : termVal(ps, { field: f[0], period: { t: 'view' }, agg: 'total' }, t, vp); }),
      list: rowsQ.map(function (q) { return { id: q.id, name: q.name, address: q.address, kv: numF.map(function (f) { return { k: f[1], type: f[3], v: f[4](q) }; }) }; }),
      chart: { title: cf[1] + ' by property' + (periodic(cf) ? ', ' + periodText(vp, t) : ''), type: cf[3],
               bars: rowsQ.map(function (q) { return { id: q.id, name: q.name, v: cf[4](q) }; })
                 .filter(function (b) { return b.v !== null && b.v !== undefined; }).sort(function (a, b) { return b.v - a.v; }) },
    };
  }

  /* the months a picker offers: the two years of history loaded (loadPlain
     reads 24 months) plus three ahead, which show "–" until synced */
  function periodOptionsFor(t) {
    var months = ymSpan(ymAdd(t, -23), ymAdd(t, 3));
    var y = +t.slice(0, 4), years = [String(y), String(y - 1)];
    return { through: t, ytdLabel: 'Jan to ' + MN[Number(t.slice(5)) - 1] + ' ' + t.slice(0, 4),
             months: months.map(function (m) { return { value: m, label: ymShort(m) }; }),
             years: years };
  }

  return { FIELDS: FIELDS, FIELD_LIST: FIELD_LIST, FIELD_GROUPS: FIELD_GROUPS, FMAP: FMAP, SPAN: SPAN,
           validateConfig: validateConfig, resolve: resolve, evaluateData: evaluateData, periodOptionsFor: periodOptionsFor,
           hydrate: hydrate, evalFormula: evalFormula, termVal: termVal, cleanPeriod: cleanPeriod, cleanSheet: cleanSheet,
           periodText: periodText, ymAdd: ymAdd, ymSpan: ymSpan };
});
