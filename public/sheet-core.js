/* ===========================================================================
   sheet-core.js — the Custom view spreadsheet's engine, pure and shared.

   Loaded by the browser (the grid recalculates as you type) and require()d by
   the tests. Nothing typed is ever executed: a formula is tokenized, parsed
   into a tree and walked by evaluate() below over the grid's own values. No
   eval, no Function, no SQL; a formula can only read cells of its own sheet.

   Grid shape (row r, column c, both from 0; the screen shows r + 1 and a
   column letter):
     row 0                  header
     rows 1..n              one per property (the view's data, read-only)
     row n + 1              Total
     rows n + 2 ...         free calculation area
     column 0               Property, then one column per field, then the
                            columns people add (formula or input), then spare
                            columns (free area only).

   STORED formulas name columns and rows by KEY, not letter, so adding a
   field, adding a property or another reader seeing fewer properties never
   points a formula at the wrong cell:  {noi|d3}  {$units|$t}  {x:c1}:{x:c1}
   decode() turns them into A1 text for the screen; encode() turns A1 text
   back. Row keys: h header, d<i> i-th property row, t total, f<k> k-th free
   row. Column keys: name, a field key, x:<id> an added column, s<k> spare.
   =========================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SheetCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ---- addresses -------------------------------------------------------- */
  function colName(i) { var s = ''; i += 1; while (i > 0) { var m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; }
  function colIndex(s) { var n = 0; s = s.toUpperCase(); for (var i = 0; i < s.length; i++) n = n * 26 + (s.charCodeAt(i) - 64); return n - 1; }
  function addr(r, c) { return colName(c) + (r + 1); }

  /* ---- values ----------------------------------------------------------- */
  function E(code) { return { err: code }; }
  function isErr(v) { return !!(v && typeof v === 'object' && v.err); }
  var DIV0 = '#DIV/0!', VALUE = '#VALUE!', REF = '#REF!', NAME = '#NAME?', NA = '#N/A', NUM = '#NUM!', CIRC = '#CIRC!';

  function toNum(v) {
    if (typeof v === 'number') return v;
    if (v === null || v === undefined || v === '') return 0;
    if (typeof v === 'boolean') return v ? 1 : 0;
    if (isErr(v)) return v;
    var n = parseNumber(v);
    return n === null ? E(VALUE) : n;
  }
  /* "1,234.5", "$1,200", "12%", "(300)" -> numbers; anything else null */
  function parseNumber(s) {
    if (typeof s === 'number') return s;
    var t = String(s).trim();
    if (!t) return null;
    var neg = /^\(.*\)$/.test(t); if (neg) t = t.slice(1, -1).trim();
    var pct = /%$/.test(t); if (pct) t = t.slice(0, -1).trim();
    t = t.replace(/^\$/, '').replace(/^-\$/, '-').replace(/,/g, '');
    if (!/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(t)) return null;
    var n = Number(t) * (pct ? 0.01 : 1) * (neg ? -1 : 1);
    return Number.isFinite(n) ? n : null;
  }
  function toStr(v) {
    if (v === null || v === undefined) return '';
    if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
    if (typeof v === 'number') return String(Math.round(v * 1e10) / 1e10);
    return String(v);
  }
  function toBool(v) {
    if (typeof v === 'boolean') return v;
    if (typeof v === 'number') return v !== 0;
    if (v === null || v === undefined || v === '') return false;
    if (isErr(v)) return v;
    var u = String(v).toUpperCase();
    if (u === 'TRUE') return true; if (u === 'FALSE') return false;
    return E(VALUE);
  }

  /* ---- tokenizer -------------------------------------------------------- */
  var RE = {
    ws: /^\s+/,
    num: /^(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?/,
    str: /^"((?:[^"]|"")*)"/,
    cell: /^(\$?)([A-Za-z]{1,3})(\$?)(\d{1,6})(?![A-Za-z0-9_(.])/,
    key: /^\{(\$?)([A-Za-z0-9_:-]{1,48})(?:\|(\$?)([a-z]\d{0,5}))?\}/,
    col: /^(\$?)([A-Za-z]{1,3})(?=\s*:)/,
    col2: /^(\$)([A-Za-z]{1,3})(?![A-Za-z0-9_(])/,
    name: /^[A-Za-z_][A-Za-z0-9_.]*/,
    op: /^(<=|>=|<>|[-+*/^&=<>%(),:;])/,
  };
  function tokenize(src) {
    var out = [], i = 0, s = src;
    while (s.length) {
      var m;
      if ((m = RE.ws.exec(s))) { i += m[0].length; s = s.slice(m[0].length); continue; }
      var at = i, tk = null;
      if ((m = RE.key.exec(s))) tk = { t: 'key', ac: !!m[1], ck: m[2], ar: !!m[3], rk: m[4] || null };
      else if ((m = RE.num.exec(s))) tk = { t: 'num', v: Number(m[0]) };
      else if ((m = RE.str.exec(s))) tk = { t: 'str', v: m[1].replace(/""/g, '"') };
      else if ((m = RE.cell.exec(s))) tk = { t: 'cell', ac: !!m[1], c: colIndex(m[2]), ar: !!m[3], r: Number(m[4]) - 1 };
      else if (((m = RE.col.exec(s)) && !/^\$?[A-Za-z]{1,3}\s*:\s*\d/.test(s)) || (m = RE.col2.exec(s))) tk = { t: 'colref', ac: !!m[1], c: colIndex(m[2]) };
      else if ((m = RE.name.exec(s))) tk = { t: 'name', v: m[0].toUpperCase() };
      else if ((m = RE.op.exec(s))) tk = { t: 'op', v: m[0] === ';' ? ',' : m[0] };
      else throw new Error('Unexpected "' + s[0] + '"');
      tk.at = at; tk.len = m[0].length; tk.text = m[0];
      out.push(tk); i += m[0].length; s = s.slice(m[0].length);
    }
    return out;
  }

  /* ---- parser (Excel precedence) -----------------------------------------
     comparison < & < + - < * / < ^ < unary - < % < primary                 */
  function parse(src) {
    var tks = tokenize(src), p = 0;
    function peek(v) { var t = tks[p]; return t && t.t === 'op' && (v === undefined || t.v === v) ? t : null; }
    function eat(v) { if (!peek(v)) throw new Error('Expected "' + v + '"'); return tks[p++]; }
    function cmp() {
      var a = cat();
      while (peek() && ['=', '<>', '<', '>', '<=', '>='].indexOf(tks[p].v) >= 0) { var op = tks[p++].v; a = { t: 'bin', op: op, a: a, b: cat() }; }
      return a;
    }
    function cat() { var a = add(); while (peek('&')) { p++; a = { t: 'bin', op: '&', a: a, b: add() }; } return a; }
    function add() { var a = mul(); while (peek('+') || peek('-')) { var op = tks[p++].v; a = { t: 'bin', op: op, a: a, b: mul() }; } return a; }
    function mul() { var a = pow(); while (peek('*') || peek('/')) { var op = tks[p++].v; a = { t: 'bin', op: op, a: a, b: pow() }; } return a; }
    function pow() { var a = un(); while (peek('^')) { p++; a = { t: 'bin', op: '^', a: a, b: un() }; } return a; }
    function un() {
      if (peek('-')) { p++; return { t: 'neg', a: un() }; }
      if (peek('+')) { p++; return un(); }
      var a = post(); return a;
    }
    function post() { var a = prim(); while (peek('%')) { p++; a = { t: 'pct', a: a }; } return a; }
    function prim() {
      var t = tks[p];
      if (!t) throw new Error('The formula ends too soon');
      if (t.t === 'num') { p++; return { t: 'num', v: t.v }; }
      if (t.t === 'str') { p++; return { t: 'str', v: t.v }; }
      if (t.t === 'key') throw new Error('Stored reference in a typed formula');
      if (t.t === 'cell') {
        p++;
        if (peek(':')) {
          p++; var b = tks[p++];
          if (!b || b.t !== 'cell') throw new Error('A range needs a cell on both sides of ":"');
          return { t: 'range', r1: Math.min(t.r, b.r), c1: Math.min(t.c, b.c), r2: Math.max(t.r, b.r), c2: Math.max(t.c, b.c) };
        }
        return { t: 'ref', r: t.r, c: t.c };
      }
      if (t.t === 'colref') {
        p++; eat(':'); var b2 = tks[p++];
        if (!b2 || (b2.t !== 'colref' && b2.t !== 'name')) throw new Error('A column range looks like C:C');
        var c2 = b2.t === 'colref' ? b2.c : /^[A-Z]{1,3}$/.test(b2.v) ? colIndex(b2.v) : -1;
        if (c2 < 0) throw new Error('A column range looks like C:C');
        return { t: 'cols', c1: Math.min(t.c, c2), c2: Math.max(t.c, c2) };
      }
      if (t.t === 'name') {
        p++;
        if (peek('(')) {
          p++; var args = [];
          if (!peek(')')) { do { args.push(peek(',') || peek(')') ? { t: 'empty' } : cmp()); } while (peek(',') && ++p); }
          eat(')');
          return { t: 'fn', name: t.v, args: args };
        }
        if (t.v === 'TRUE' || t.v === 'FALSE') return { t: 'bool', v: t.v === 'TRUE' };
        return { t: 'badname', v: t.v };
      }
      if (peek('(')) { p++; var e = cmp(); eat(')'); return e; }
      throw new Error('Unexpected "' + t.text + '"');
    }
    var ast = cmp();
    if (p < tks.length) throw new Error('Unexpected "' + tks[p].text + '"');
    return ast;
  }
  var parseCache = {};
  function parsed(src) {
    if (Object.prototype.hasOwnProperty.call(parseCache, src)) return parseCache[src];
    var out;
    try { out = { ast: parse(src) }; } catch (e) { out = { error: e.message }; }
    if (Object.keys(parseCache).length > 5000) parseCache = {};
    parseCache[src] = out;
    return out;
  }

  /* ---- references: fill-down and stored keys ----------------------------- */
  /* rewrite every A1 reference in a formula. fn(ref, role) -> { r, c } or
     null (#REF!); role is 'one', 'start' or 'end' (of a range), 'col'. */
  function mapRefs(src, fn) {
    var tks;
    try { tks = tokenize(src); } catch (e) { return src; }
    var out = '', last = 0;
    for (var i = 0; i < tks.length; i++) {
      var t = tks[i], rep = null;
      if (t.t === 'cell') {
        var role = tks[i + 1] && tks[i + 1].v === ':' && tks[i + 2] && tks[i + 2].t === 'cell' ? 'start'
          : tks[i - 1] && tks[i - 1].v === ':' && tks[i - 2] && tks[i - 2].t === 'cell' ? 'end' : 'one';
        var n = fn({ r: t.r, c: t.c, ar: t.ar, ac: t.ac }, role);
        rep = n ? (t.ac ? '$' : '') + colName(n.c) + (t.ar ? '$' : '') + (n.r + 1) : REF;
      } else if (t.t === 'colref') {
        var nc = fn({ r: null, c: t.c, ar: false, ac: t.ac }, 'col');
        rep = nc ? (t.ac ? '$' : '') + colName(nc.c) : REF;
      } else if (t.t === 'name' && /^[A-Z]{1,3}$/.test(t.v) && tks[i - 1] && tks[i - 1].v === ':' && tks[i - 2] && tks[i - 2].t === 'colref') {
        var nc2 = fn({ r: null, c: colIndex(t.v), ar: false, ac: false }, 'col');
        rep = nc2 ? colName(nc2.c) : REF;
      }
      if (rep !== null) { out += src.slice(last, t.at) + rep; last = t.at + t.len; }
    }
    return out + src.slice(last);
  }
  /* the same formula one row further down (fill down), as a spreadsheet does:
     relative rows move, $-anchored rows stay */
  function shiftRows(src, dr) {
    if (!dr) return src;
    return mapRefs(src, function (x) {
      var r = x.ar || x.r === null ? x.r : x.r + dr;
      return r !== null && r < 0 ? null : { r: r, c: x.c };
    });
  }

  /* A1 -> stored keys */
  function encode(src, L) {
    if (typeof src !== 'string' || src.charAt(0) !== '=') return src;
    var tks;
    try { tks = tokenize(src); } catch (e) { return src; }
    var out = '', last = 0;
    for (var i = 0; i < tks.length; i++) {
      var t = tks[i], rep = null;
      if (t.t === 'cell') {
        var ck = L.colKey(t.c), rk = L.rowKey(t.r);
        rep = ck && rk ? '{' + (t.ac ? '$' : '') + ck + '|' + (t.ar ? '$' : '') + rk + '}' : null;
      } else if (t.t === 'colref') {
        var k = L.colKey(t.c); rep = k ? '{' + (t.ac ? '$' : '') + k + '}' : null;
      } else if (t.t === 'name' && /^[A-Z]{1,3}$/.test(t.v) && tks[i - 1] && tks[i - 1].v === ':' && tks[i - 2] && tks[i - 2].t === 'colref') {
        var k2 = L.colKey(colIndex(t.v)); rep = k2 ? '{' + k2 + '}' : null;
      }
      if (rep !== null) { out += src.slice(last, t.at) + rep; last = t.at + t.len; }
    }
    return out + src.slice(last);
  }
  /* stored keys -> A1. A range that ran to the last property row when it was
     saved (n0) still runs to the last one now. A key that no longer exists
     becomes #REF!, as a deleted column does in a spreadsheet. */
  function decode(src, L) {
    if (typeof src !== 'string' || src.indexOf('{') < 0) return src;
    var tks;
    try { tks = tokenize(src); } catch (e) { return src; }
    var out = '', last = 0;
    for (var i = 0; i < tks.length; i++) {
      var t = tks[i];
      if (t.t !== 'key') continue;
      var c = L.colOf(t.ck), rep;
      if (t.rk === null) rep = c === null ? REF : (t.ac ? '$' : '') + colName(c);
      else {
        var isEnd = tks[i - 1] && tks[i - 1].v === ':' && tks[i - 2] && tks[i - 2].t === 'key';
        var rk = t.rk;
        if (isEnd && rk === 'd' + L.n0 && L.n0 > 0) rk = 'd' + L.n;
        var r = L.rowOf(rk);
        rep = c === null || r === null ? REF : (t.ac ? '$' : '') + colName(c) + (t.ar ? '$' : '') + (r + 1);
      }
      out += src.slice(last, t.at) + rep; last = t.at + t.len;
    }
    return out + src.slice(last);
  }

  /* ---- functions -------------------------------------------------------- */
  /* every value an argument holds, ranges flattened */
  function flat(args, keepText) {
    var out = [];
    args.forEach(function (a) {
      if (a && a.range) a.rows.forEach(function (row) { row.forEach(function (v) { out.push({ v: v, inRange: true }); }); });
      else out.push({ v: a, inRange: false });
    });
    return out;
  }
  /* the numbers in the arguments, as SUM reads them: text and blanks in a
     range are skipped, a typed argument must be a number */
  function nums(args) {
    var out = [];
    var all = flat(args);
    for (var i = 0; i < all.length; i++) {
      var x = all[i];
      if (isErr(x.v)) return x.v;
      if (x.inRange) { if (typeof x.v === 'number') out.push(x.v); continue; }
      var n = toNum(x.v); if (isErr(n)) return n; out.push(n);
    }
    return out;
  }
  function crit(c) {
    if (isErr(c)) return function () { return false; };
    if (typeof c === 'number' || typeof c === 'boolean') return function (v) { return v === c || (typeof v === 'string' && parseNumber(v) === c); };
    var m = /^(<=|>=|<>|<|>|=)?(.*)$/.exec(String(c)), op = m[1] || '=', rhs = m[2], n = parseNumber(rhs);
    if (n !== null) {
      return function (v) {
        var x = typeof v === 'number' ? v : typeof v === 'string' ? parseNumber(v) : null;
        if (x === null) return op === '<>';
        return op === '=' ? x === n : op === '<>' ? x !== n : op === '<' ? x < n : op === '>' ? x > n : op === '<=' ? x <= n : x >= n;
      };
    }
    var rx = new RegExp('^' + rhs.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i');
    return function (v) {
      var s = v === null || v === undefined ? '' : toStr(v);
      return op === '<>' ? !rx.test(s) : op === '=' ? rx.test(s) : false;
    };
  }
  function cells(a) { return a && a.range ? a.rows.reduce(function (x, r) { return x.concat(r); }, []) : [a]; }
  function ifs(args, start, fn) {
    /* (range, crit) pairs from args[start]; fn(i) for each matching index */
    var pairs = [];
    for (var i = start; i + 1 < args.length; i += 2) pairs.push([cells(args[i]), crit(args[i + 1])]);
    if (!pairs.length) return E(VALUE);
    var n = pairs[0][0].length;
    if (pairs.some(function (p) { return p[0].length !== n; })) return E(VALUE);
    for (var j = 0; j < n; j++) if (pairs.every(function (p) { return p[1](p[0][j]); })) fn(j);
    return null;
  }
  function round(n, d, mode) {
    var f = Math.pow(10, d), x = n * f;
    var r = mode === 'up' ? (x < 0 ? -Math.ceil(-x - 1e-9) : Math.ceil(x - 1e-9)) : mode === 'down' ? Math.trunc(x) : (x < 0 ? -Math.round(-x) : Math.round(x + 1e-9));
    return r / f;
  }
  function pmt(rate, nper, pv, fv, type) {
    fv = fv || 0; type = type ? 1 : 0;
    if (!nper) return E(NUM);
    if (rate === 0) return -(pv + fv) / nper;
    var q = Math.pow(1 + rate, nper);
    return -(rate * (pv * q + fv)) / ((1 + rate * type) * (q - 1));
  }
  function lookupEq(a, b) {
    if (typeof a === 'number' || typeof b === 'number') { var x = typeof a === 'number' ? a : parseNumber(a), y = typeof b === 'number' ? b : parseNumber(b); return x !== null && x === y; }
    return toStr(a).toLowerCase() === toStr(b).toLowerCase();
  }
  function lt(a, b) {
    if (typeof a === 'number' && typeof b === 'number') return a < b;
    if (typeof a === 'number') return true; if (typeof b === 'number') return false;
    return toStr(a).toLowerCase() < toStr(b).toLowerCase();
  }
  function approxIndex(list, v) { var best = -1; for (var i = 0; i < list.length; i++) { if (list[i] === null || list[i] === undefined) continue; if (lookupEq(list[i], v)) return i; if (lt(list[i], v)) best = i; else break; } return best; }

  function N(v) { var n = toNum(v); return n; }
  var FN = {
    SUM: function (a) { var n = nums(a); return isErr(n) ? n : n.reduce(function (x, y) { return x + y; }, 0); },
    AVERAGE: function (a) { var n = nums(a); return isErr(n) ? n : n.length ? n.reduce(function (x, y) { return x + y; }, 0) / n.length : E(DIV0); },
    MIN: function (a) { var n = nums(a); return isErr(n) ? n : n.length ? Math.min.apply(null, n) : 0; },
    MAX: function (a) { var n = nums(a); return isErr(n) ? n : n.length ? Math.max.apply(null, n) : 0; },
    MEDIAN: function (a) { var n = nums(a); if (isErr(n)) return n; if (!n.length) return E(NUM); n.sort(function (x, y) { return x - y; }); var h = Math.floor(n.length / 2); return n.length % 2 ? n[h] : (n[h - 1] + n[h]) / 2; },
    PRODUCT: function (a) { var n = nums(a); return isErr(n) ? n : n.length ? n.reduce(function (x, y) { return x * y; }, 1) : 0; },
    STDEV: function (a) { var n = nums(a); if (isErr(n)) return n; if (n.length < 2) return E(DIV0); var m = n.reduce(function (x, y) { return x + y; }, 0) / n.length; return Math.sqrt(n.reduce(function (s, x) { return s + (x - m) * (x - m); }, 0) / (n.length - 1)); },
    COUNT: function (a) { return flat(a).filter(function (x) { return typeof x.v === 'number' || (!x.inRange && parseNumber(x.v) !== null && typeof x.v !== 'boolean'); }).length; },
    COUNTA: function (a) { return flat(a).filter(function (x) { return x.v !== null && x.v !== undefined && x.v !== ''; }).length; },
    COUNTBLANK: function (a) { return flat(a).filter(function (x) { return x.v === null || x.v === undefined || x.v === ''; }).length; },
    SUMPRODUCT: function (a) {
      var arrs = a.map(cells); if (!arrs.length) return E(VALUE);
      var n = arrs[0].length; if (arrs.some(function (x) { return x.length !== n; })) return E(VALUE);
      var s = 0; for (var i = 0; i < n; i++) { var p = 1; for (var j = 0; j < arrs.length; j++) { var v = arrs[j][i]; if (isErr(v)) return v; p *= typeof v === 'number' ? v : 0; } s += p; }
      return s;
    },
    SUMIF: function (a) { var rng = cells(a[0]), c = crit(a[1]), sr = a.length > 2 ? cells(a[2]) : rng, s = 0; rng.forEach(function (v, i) { if (c(v) && typeof sr[i] === 'number') s += sr[i]; }); return s; },
    COUNTIF: function (a) { var c = crit(a[1]); return cells(a[0]).filter(function (v) { return c(v); }).length; },
    AVERAGEIF: function (a) { var rng = cells(a[0]), c = crit(a[1]), sr = a.length > 2 ? cells(a[2]) : rng, s = 0, k = 0; rng.forEach(function (v, i) { if (c(v) && typeof sr[i] === 'number') { s += sr[i]; k++; } }); return k ? s / k : E(DIV0); },
    SUMIFS: function (a) { var sr = cells(a[0]), s = 0, e = ifs(a, 1, function (i) { if (typeof sr[i] === 'number') s += sr[i]; }); return e || s; },
    COUNTIFS: function (a) { var k = 0, e = ifs(a, 0, function () { k++; }); return e || k; },
    AVERAGEIFS: function (a) { var sr = cells(a[0]), s = 0, k = 0, e = ifs(a, 1, function (i) { if (typeof sr[i] === 'number') { s += sr[i]; k++; } }); return e || (k ? s / k : E(DIV0)); },
    MINIFS: function (a) { var sr = cells(a[0]), o = [], e = ifs(a, 1, function (i) { if (typeof sr[i] === 'number') o.push(sr[i]); }); return e || (o.length ? Math.min.apply(null, o) : 0); },
    MAXIFS: function (a) { var sr = cells(a[0]), o = [], e = ifs(a, 1, function (i) { if (typeof sr[i] === 'number') o.push(sr[i]); }); return e || (o.length ? Math.max.apply(null, o) : 0); },
    ROUND: function (a) { var n = N(a[0]), d = a.length > 1 ? N(a[1]) : 0; return isErr(n) ? n : isErr(d) ? d : round(n, Math.trunc(d)); },
    ROUNDUP: function (a) { var n = N(a[0]), d = a.length > 1 ? N(a[1]) : 0; return isErr(n) ? n : isErr(d) ? d : round(n, Math.trunc(d), 'up'); },
    ROUNDDOWN: function (a) { var n = N(a[0]), d = a.length > 1 ? N(a[1]) : 0; return isErr(n) ? n : isErr(d) ? d : round(n, Math.trunc(d), 'down'); },
    INT: function (a) { var n = N(a[0]); return isErr(n) ? n : Math.floor(n); },
    TRUNC: function (a) { var n = N(a[0]); return isErr(n) ? n : Math.trunc(n); },
    ABS: function (a) { var n = N(a[0]); return isErr(n) ? n : Math.abs(n); },
    SIGN: function (a) { var n = N(a[0]); return isErr(n) ? n : Math.sign(n); },
    SQRT: function (a) { var n = N(a[0]); return isErr(n) ? n : n < 0 ? E(NUM) : Math.sqrt(n); },
    POWER: function (a) { var x = N(a[0]), y = N(a[1]); return isErr(x) ? x : isErr(y) ? y : Math.pow(x, y); },
    EXP: function (a) { var n = N(a[0]); return isErr(n) ? n : Math.exp(n); },
    LN: function (a) { var n = N(a[0]); return isErr(n) ? n : n <= 0 ? E(NUM) : Math.log(n); },
    LOG10: function (a) { var n = N(a[0]); return isErr(n) ? n : n <= 0 ? E(NUM) : Math.log(n) / Math.LN10; },
    LOG: function (a) { var n = N(a[0]), b = a.length > 1 ? N(a[1]) : 10; return isErr(n) ? n : isErr(b) ? b : n <= 0 || b <= 0 || b === 1 ? E(NUM) : Math.log(n) / Math.log(b); },
    MOD: function (a) { var x = N(a[0]), y = N(a[1]); return isErr(x) ? x : isErr(y) ? y : y === 0 ? E(DIV0) : x - y * Math.floor(x / y); },
    CEILING: function (a) { var x = N(a[0]), s = a.length > 1 ? N(a[1]) : 1; return isErr(x) ? x : isErr(s) ? s : s === 0 ? 0 : Math.ceil(x / s - 1e-12) * s; },
    FLOOR: function (a) { var x = N(a[0]), s = a.length > 1 ? N(a[1]) : 1; return isErr(x) ? x : isErr(s) ? s : s === 0 ? E(DIV0) : Math.floor(x / s + 1e-12) * s; },
    PI: function () { return Math.PI; },
    AND: function (a) { var all = flat(a); for (var i = 0; i < all.length; i++) { if (all[i].inRange && (all[i].v === null || typeof all[i].v === 'string')) continue; var b = toBool(all[i].v); if (isErr(b)) return b; if (!b) return false; } return true; },
    OR: function (a) { var all = flat(a), any = false; for (var i = 0; i < all.length; i++) { if (all[i].inRange && (all[i].v === null || typeof all[i].v === 'string')) continue; var b = toBool(all[i].v); if (isErr(b)) return b; if (b) any = true; } return any; },
    NOT: function (a) { var b = toBool(a[0]); return isErr(b) ? b : !b; },
    ISBLANK: function (a) { return a[0] === null || a[0] === undefined || a[0] === ''; },
    ISNUMBER: function (a) { return typeof a[0] === 'number'; },
    ISTEXT: function (a) { return typeof a[0] === 'string'; },
    ISERROR: function (a) { return isErr(a[0]); },
    CONCAT: function (a) { var all = flat(a), s = ''; for (var i = 0; i < all.length; i++) { if (isErr(all[i].v)) return all[i].v; s += toStr(all[i].v); } return s; },
    LEN: function (a) { return isErr(a[0]) ? a[0] : toStr(a[0]).length; },
    UPPER: function (a) { return isErr(a[0]) ? a[0] : toStr(a[0]).toUpperCase(); },
    LOWER: function (a) { return isErr(a[0]) ? a[0] : toStr(a[0]).toLowerCase(); },
    TRIM: function (a) { return isErr(a[0]) ? a[0] : toStr(a[0]).trim().replace(/\s+/g, ' '); },
    LEFT: function (a) { var n = a.length > 1 ? N(a[1]) : 1; return isErr(a[0]) ? a[0] : isErr(n) ? n : toStr(a[0]).slice(0, Math.max(0, n)); },
    RIGHT: function (a) { var n = a.length > 1 ? N(a[1]) : 1, s = toStr(a[0]); return isErr(a[0]) ? a[0] : isErr(n) ? n : n <= 0 ? '' : s.slice(-n); },
    MID: function (a) { var st = N(a[1]), n = N(a[2]); return isErr(a[0]) ? a[0] : isErr(st) ? st : isErr(n) ? n : st < 1 ? E(VALUE) : toStr(a[0]).substr(st - 1, Math.max(0, n)); },
    VALUE: function (a) { if (isErr(a[0])) return a[0]; var n = parseNumber(a[0]); return n === null ? E(VALUE) : n; },
    TEXT: function (a) { return isErr(a[0]) ? a[0] : toStr(a[0]); },
    CHOOSE: function (a) { var i = N(a[0]); return isErr(i) ? i : i >= 1 && i < a.length ? a[Math.trunc(i)] : E(VALUE); },
    ROWS: function (a) { return a[0] && a[0].range ? a[0].rows.length : 1; },
    COLUMNS: function (a) { return a[0] && a[0].range ? (a[0].rows[0] || []).length : 1; },
    INDEX: function (a) {
      var rg = a[0]; if (!rg || !rg.range) return a[1] === undefined || toNum(a[1]) === 1 ? rg : E(REF);
      var r = a.length > 1 ? N(a[1]) : 1, c = a.length > 2 ? N(a[2]) : 1;
      if (isErr(r)) return r; if (isErr(c)) return c;
      if (rg.rows.length === 1 && a.length === 2) { c = r; r = 1; }
      var row = rg.rows[r - 1]; return row && c >= 1 && c <= row.length ? row[c - 1] : E(REF);
    },
    MATCH: function (a) {
      var list = cells(a[1]), type = a.length > 2 ? N(a[2]) : 1;
      if (isErr(type)) return type;
      if (type === 0) { var cf = typeof a[0] === 'string' && /[*?]/.test(a[0]) ? crit(a[0]) : null; for (var i = 0; i < list.length; i++) if (cf ? cf(list[i]) : lookupEq(list[i], a[0])) return i + 1; return E(NA); }
      var k = approxIndex(list, a[0]); return k < 0 ? E(NA) : k + 1;
    },
    VLOOKUP: function (a) {
      var rg = a[1]; if (!rg || !rg.range) return E(REF);
      var c = N(a[2]), exact = a.length > 3 && !toBool(a[3]);
      if (isErr(c)) return c;
      var first = rg.rows.map(function (r) { return r[0]; });
      var i = exact ? first.findIndex(function (v) { return lookupEq(v, a[0]); }) : approxIndex(first, a[0]);
      if (i < 0) return E(NA);
      var row = rg.rows[i]; return c >= 1 && c <= row.length ? row[c - 1] : E(REF);
    },
    HLOOKUP: function (a) {
      var rg = a[1]; if (!rg || !rg.range) return E(REF);
      var r = N(a[2]), exact = a.length > 3 && !toBool(a[3]);
      if (isErr(r)) return r;
      var top = rg.rows[0] || [];
      var i = exact ? top.findIndex(function (v) { return lookupEq(v, a[0]); }) : approxIndex(top, a[0]);
      if (i < 0) return E(NA);
      var row = rg.rows[r - 1]; return row ? row[i] : E(REF);
    },
    XLOOKUP: function (a) {
      var look = cells(a[1]), ret = cells(a[2]);
      if (look.length !== ret.length) return E(VALUE);
      for (var i = 0; i < look.length; i++) if (lookupEq(look[i], a[0])) return ret[i];
      return a.length > 3 ? a[3] : E(NA);
    },
    PMT: function (a) { var v = [0, 1, 2, 3, 4].map(function (i) { return i < a.length ? N(a[i]) : 0; }); var e = v.find(isErr); return e || pmt(v[0], v[1], v[2], v[3], v[4]); },
    FV: function (a) {
      var v = [0, 1, 2, 3, 4].map(function (i) { return i < a.length ? N(a[i]) : 0; }); var e = v.find(isErr); if (e) return e;
      var r = v[0], n = v[1], p = v[2], pv = v[3], t = v[4] ? 1 : 0;
      if (r === 0) return -(pv + p * n);
      var q = Math.pow(1 + r, n); return -(pv * q + p * (1 + r * t) * (q - 1) / r);
    },
    PV: function (a) {
      var v = [0, 1, 2, 3, 4].map(function (i) { return i < a.length ? N(a[i]) : 0; }); var e = v.find(isErr); if (e) return e;
      var r = v[0], n = v[1], p = v[2], fv = v[3], t = v[4] ? 1 : 0;
      if (r === 0) return -(fv + p * n);
      var q = Math.pow(1 + r, n); return -(fv + p * (1 + r * t) * (q - 1) / r) / q;
    },
    NPV: function (a) { var r = N(a[0]); if (isErr(r)) return r; var n = nums(a.slice(1)); if (isErr(n)) return n; return n.reduce(function (s, x, i) { return s + x / Math.pow(1 + r, i + 1); }, 0); },
    IRR: function (a) {
      var n = nums([a[0]]); if (isErr(n)) return n;
      /* no answer without money going both ways */
      if (!n.some(function (x) { return x > 0; }) || !n.some(function (x) { return x < 0; })) return E(NUM);
      var r = a.length > 1 ? N(a[1]) : 0.1; if (isErr(r)) return r;
      for (var k = 0; k < 100; k++) {
        var f = 0, d = 0;
        for (var i = 0; i < n.length; i++) { f += n[i] / Math.pow(1 + r, i); d -= i * n[i] / Math.pow(1 + r, i + 1); }
        if (Math.abs(f) < 1e-9) return r;
        if (d === 0) break;
        var nr = r - f / d; if (!Number.isFinite(nr) || nr <= -1) break;
        if (Math.abs(nr - r) < 1e-12) return nr;
        r = nr;
      }
      return E(NUM);
    },
  };
  FN.CONCATENATE = FN.CONCAT;
  FN.AVG = FN.AVERAGE;
  FN['STDEV.S'] = FN.STDEV;
  /* IF, IFERROR, IFNA evaluate lazily: only the branch taken */
  var LAZY = {
    IF: function (args, ev) {
      if (args.length < 2) return E(VALUE);
      var c = toBool(scalar(ev(args[0]))); if (isErr(c)) return c;
      return c ? ev(args[1]) : args.length > 2 ? ev(args[2]) : false;
    },
    IFERROR: function (args, ev) { var v = scalar(ev(args[0])); return isErr(v) ? (args.length > 1 ? ev(args[1]) : '') : v; },
    IFNA: function (args, ev) { var v = scalar(ev(args[0])); return isErr(v) && v.err === NA ? (args.length > 1 ? ev(args[1]) : '') : v; },
  };
  var FUNCTIONS = Object.keys(FN).concat(Object.keys(LAZY)).sort();
  /* a range used where one value is wanted: its single cell, else #VALUE! */
  function scalar(v) { if (v && v.range) return v.rows.length === 1 && v.rows[0].length === 1 ? v.rows[0][0] : E(VALUE); return v; }

  /* ---- evaluation ------------------------------------------------------- */
  /* ctx: { get(r, c) -> value, dataFirst, dataLast (row range of C:C), maxR, maxC } */
  function evaluate(ast, ctx) {
    var steps = 0;
    function ev(n) {
      if (++steps > 200000) return E(NUM);
      switch (n.t) {
        case 'num': return n.v;
        case 'str': return n.v;
        case 'bool': return n.v;
        case 'empty': return null;
        case 'badname': return E(NAME);
        case 'ref': return n.r < 0 || n.c < 0 ? E(REF) : ctx.get(n.r, n.c);
        case 'range': return rangeOf(n.r1, n.c1, n.r2, n.c2);
        case 'cols': return rangeOf(ctx.dataFirst, n.c1, ctx.dataLast, n.c2);
        case 'neg': { var a = toNum(scalar(ev(n.a))); return isErr(a) ? a : -a; }
        case 'pct': { var p = toNum(scalar(ev(n.a))); return isErr(p) ? p : p / 100; }
        case 'fn': {
          if (LAZY[n.name]) return LAZY[n.name](n.args, ev);
          var f = FN[n.name]; if (!f) return E(NAME);
          var args = n.args.map(ev);
          var r = f(args);
          return typeof r === 'number' && !Number.isFinite(r) ? E(NUM) : r;
        }
        case 'bin': return bin(n.op, scalar(ev(n.a)), scalar(ev(n.b)));
      }
      return E(VALUE);
    }
    function rangeOf(r1, c1, r2, c2) {
      if (r2 < r1) return { range: true, rows: [] };
      if ((r2 - r1 + 1) * (c2 - c1 + 1) > 100000) return E(REF);
      var rows = [];
      for (var r = r1; r <= r2; r++) { var row = []; for (var c = c1; c <= c2; c++) row.push(ctx.get(r, c)); rows.push(row); }
      return { range: true, rows: rows };
    }
    var out = scalar(ev(ast));
    return out === undefined ? null : out;
  }
  function bin(op, a, b) {
    if (isErr(a)) return a; if (isErr(b)) return b;
    if (op === '&') return toStr(a) + toStr(b);
    if (['=', '<>', '<', '>', '<=', '>='].indexOf(op) >= 0) {
      var x = a === null ? (typeof b === 'string' ? '' : 0) : a, y = b === null ? (typeof a === 'string' ? '' : 0) : b, c;
      if (typeof x === 'string' && typeof y === 'string') { x = x.toLowerCase(); y = y.toLowerCase(); c = x < y ? -1 : x > y ? 1 : 0; }
      else if (typeof x === typeof y) c = x < y ? -1 : x > y ? 1 : 0;
      else c = (typeof x === 'number' ? 0 : typeof x === 'string' ? 1 : 2) - (typeof y === 'number' ? 0 : typeof y === 'string' ? 1 : 2);
      return op === '=' ? c === 0 : op === '<>' ? c !== 0 : op === '<' ? c < 0 : op === '>' ? c > 0 : op === '<=' ? c <= 0 : c >= 0;
    }
    var p = toNum(a), q = toNum(b);
    if (isErr(p)) return p; if (isErr(q)) return q;
    var r;
    if (op === '+') r = p + q; else if (op === '-') r = p - q; else if (op === '*') r = p * q;
    else if (op === '/') { if (q === 0) return E(DIV0); r = p / q; }
    else if (op === '^') r = Math.pow(p, q);
    return Number.isFinite(r) ? r : E(NUM);
  }

  /* ---- the sheet -------------------------------------------------------- */
  /* model: { heads: [{key,label,type}], rows: [{id,name,cells}], totals, sheet (validated) }
     Returns the grid: columns, rows, and value(r, c) / raw(r, c) / editable(r, c). */
  function build(model) {
    var sh = model.sheet, heads = model.heads, F = heads.length;
    var data = model.rows.slice();
    var X = sh.cols;
    var cols = [{ key: 'name', label: 'Property', kind: 'name', type: 'text' }]
      .concat(heads.map(function (h) { return { key: h.key, label: h.label, kind: 'field', type: h.type }; }))
      .concat(X.map(function (x) { return { key: 'x:' + x.id, label: x.label, kind: x.kind, fmt: x.fmt, id: x.id }; }));
    var firstSpare = cols.length;
    /* free cells name their column by key; a spare column s<k> sits k after the last real one */
    var colPos = {}; cols.forEach(function (c, i) { colPos[c.key] = i; });
    var free = {}, maxFreeRow = 0, maxSpare = -1;
    Object.keys(sh.cells).forEach(function (k) {
      var bar = k.indexOf('|'), fr = +k.slice(0, bar), ck = k.slice(bar + 1);
      var c = /^s\d{1,2}$/.test(ck) ? firstSpare + +ck.slice(1) : colPos[ck];
      if (c === undefined) return;
      if (/^s/.test(ck)) maxSpare = Math.max(maxSpare, +ck.slice(1));
      free[fr + ':' + c] = sh.cells[k];
      maxFreeRow = Math.max(maxFreeRow, fr);
    });
    var spare = Math.max(3, maxSpare + 2);
    for (var s = 0; s < spare; s++) cols.push({ key: 's' + s, label: '', kind: 'spare', type: 'auto' });
    colPos = {}; cols.forEach(function (c, i) { colPos[c.key] = i; });

    /* sort: by a column's value, before addresses are given out */
    if (sh.sort && colPos[sh.sort.key] !== undefined) {
      var sc = colPos[sh.sort.key], col = cols[sc], dir = sh.sort.dir === 'desc' ? -1 : 1;
      var keyOf = function (row) {
        if (col.kind === 'name') return row.name;
        if (col.kind === 'field') return row.cells[sc - 1];
        if (col.kind === 'input') { var x = X[sc - 1 - F], v = x.vals[row.id]; var n = parseNumber(v); return n === null ? v || null : n; }
        return null;
      };
      data = data.map(function (row, i) { return { row: row, i: i, k: keyOf(row) }; }).sort(function (a, b) {
        var x = a.k, y = b.k;
        if (x === null || x === undefined || x === '') return y === null || y === undefined || y === '' ? a.i - b.i : 1;
        if (y === null || y === undefined || y === '') return -1;
        var c = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y));
        return c ? c * dir : a.i - b.i;
      }).map(function (o) { return o.row; });
    }
    var n = data.length, T = n + 1, freeRows = Math.max(sh.rows, maxFreeRow + 5);
    var rowsN = T + 1 + freeRows;

    var L = {
      n: n, n0: sh.n,
      colKey: function (c) { return c >= 0 && c < cols.length ? cols[c].key : c >= firstSpare ? 's' + (c - firstSpare) : null; },
      rowKey: function (r) { return r === 0 ? 'h' : r >= 1 && r <= n ? 'd' + r : r === T ? 't' : r > T ? 'f' + (r - T) : null; },
      colOf: function (k) { if (colPos[k] !== undefined) return colPos[k]; var m = /^s(\d{1,2})$/.exec(k); return m ? firstSpare + +m[1] : null; },
      rowOf: function (k) {
        if (k === 'h') return 0; if (k === 't') return T;
        var m = /^([df])(\d{1,5})$/.exec(k); if (!m) return null;
        var i = +m[2]; if (m[1] === 'd') return i >= 1 && i <= n ? i : null;
        return i >= 1 ? T + i : null;
      },
    };

    /* the text behind a cell: what the formula bar shows */
    function raw(r, c) {
      var col = cols[c]; if (!col) return null;
      if (r === 0) return col.label;
      if (r <= n) {
        var row = data[r - 1];
        if (col.kind === 'name') return row.name;
        if (col.kind === 'field') return row.cells[c - 1];
        if (col.kind === 'formula') { var x = X[c - 1 - F]; return x.vals[row.id] !== undefined ? decode(x.vals[row.id], L) : x.f ? shiftRows(decode(x.f, L), r - 1) : null; }
        if (col.kind === 'input') { var y = X[c - 1 - F].vals[row.id]; return y === undefined ? null : decode(y, L); }
        return null;
      }
      if (r === T) {
        if (col.kind === 'name') return 'Total';
        if (col.kind === 'field') return model.totals[c - 1];
        /* a formula column's total is its formula over the totals, never the
           sum of its rows (the view's rule for group subtotals) */
        if (col.kind === 'formula') return X[c - 1 - F].f ? shiftRows(decode(X[c - 1 - F].f, L), n) : null;
        if (col.kind === 'input') return n ? '=SUM(' + colName(c) + '2:' + colName(c) + (n + 1) + ')' : null;
        return null;
      }
      var cell = free[(r - T) + ':' + c];
      return cell ? decode(cell.v, L) : null;
    }
    function fmtOf(r, c) {
      var col = cols[c]; if (!col || r === 0) return 'text';
      if (r > T) { var cell = free[(r - T) + ':' + c]; return (cell && cell.fmt) || 'auto'; }
      if (col.kind === 'field') return col.type;
      if (col.kind === 'name') return 'text';
      return col.fmt || 'auto';
    }
    function editable(r, c) {
      var col = cols[c]; if (!col) return false;
      if (r === 0) return col.kind === 'formula' || col.kind === 'input';
      if (r <= n) return col.kind === 'formula' || col.kind === 'input';
      if (r === T) return false;
      return true;
    }

    var memo = {}, busy = {};
    function value(r, c) {
      if (r < 0 || c < 0 || r >= rowsN || c >= cols.length) return null;
      var k = r + ':' + c;
      if (Object.prototype.hasOwnProperty.call(memo, k)) return memo[k];
      if (busy[k]) return E(CIRC);
      var x = raw(r, c), v;
      if (typeof x === 'string' && x.charAt(0) === '=' && x.length > 1) {
        busy[k] = true;
        var p = parsed(x.slice(1));
        v = p.error ? E('#ERROR!') : evaluate(p.ast, ctx);
        delete busy[k];
      } else if (typeof x === 'string' && r !== 0 && (r > T || cols[c].kind === 'input' || cols[c].kind === 'formula')) {
        var num = parseNumber(x); v = num === null ? x : num;
      } else v = x === undefined ? null : x;
      memo[k] = v;
      return v;
    }
    var ctx = { get: value, dataFirst: 1, dataLast: n };
    function errorOf(r, c) {
      var x = raw(r, c);
      if (typeof x === 'string' && x.charAt(0) === '=' && x.length > 1) { var p = parsed(x.slice(1)); return p.error || null; }
      return null;
    }

    return { cols: cols, rows: data, n: n, T: T, rowsN: rowsN, F: F, firstSpare: firstSpare, layout: L,
             raw: raw, value: value, fmtOf: fmtOf, editable: editable, errorOf: errorOf,
             rowKey: function (r) { return r === 0 ? 'h' : r <= n ? data[r - 1].id : r === T ? 't' : 'f' + (r - T); } };
  }

  /* ---- writing a cell back into the stored settings ---------------------- */
  /* text typed at (r, c) of grid g, into sheet settings sh (mutated). Returns
     a message when the cell cannot take it. */
  function write(sh, g, r, c, text) {
    var col = g.cols[c]; if (!col) return 'No such cell.';
    text = String(text === null || text === undefined ? '' : text).slice(0, 1000);
    var stored = encode(text, g.layout);
    if (!g.editable(r, c)) return r === g.T ? 'Totals are worked out for you.' : 'This cell comes from the data. Add a column, or use the rows under Total, to calculate with it.';
    var x = col.id ? sh.cols.find(function (k) { return k.id === col.id; }) : null;
    if (r === 0) { x.label = text.trim().slice(0, 80) || x.label; return null; }
    if (r <= g.n) {
      var pid = g.rows[r - 1].id;
      if (col.kind === 'input') { if (text === '') delete x.vals[pid]; else x.vals[pid] = stored; return null; }
      /* a formula typed in one row becomes the whole column's formula, as a
         fill-down would; clearing a row's override goes back to it */
      if (text === '' || text.charAt(0) === '=') {
        if (text === '') { delete x.vals[pid]; if (!Object.keys(x.vals).length) x.f = ''; return null; }
        x.f = encode(shiftRows(text, -(r - 1)), g.layout); delete x.vals[pid];
        return null;
      }
      x.vals[pid] = stored; return null;
    }
    var key = (r - g.T) + '|' + col.key;
    if (text === '') { var old = sh.cells[key]; if (old && old.fmt) old.v = ''; else delete sh.cells[key]; }
    else sh.cells[key] = Object.assign({}, sh.cells[key] || {}, { v: stored });
    return null;
  }
  /* before saving: re-key every stored formula against the grid as it is
     now (a range that ran to the last property row is extended), and record
     how many property rows that was */
  function settle(sh, g) {
    var L = g.layout;
    var re = function (v) { return typeof v === 'string' && v.indexOf('{') >= 0 ? encode(decode(v, L), L) : v; };
    sh.cols.forEach(function (x) { x.f = re(x.f); Object.keys(x.vals).forEach(function (k) { x.vals[k] = re(x.vals[k]); }); });
    Object.keys(sh.cells).forEach(function (k) { sh.cells[k].v = re(sh.cells[k].v); });
    sh.n = g.n;
    return sh;
  }

  return { colName: colName, colIndex: colIndex, addr: addr, parse: parse, tokenize: tokenize, evaluate: evaluate,
           shiftRows: shiftRows, mapRefs: mapRefs, encode: encode, decode: decode, build: build, write: write, settle: settle,
           parseNumber: parseNumber, isErr: isErr, toStr: toStr, FUNCTIONS: FUNCTIONS };
});
