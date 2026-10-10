// ===========================================================================
// formula.js — the calculated-column expression language (spec G3).
//
// A saved view may define columns like
//
//     NOI per unit      =  ROUND(t12_noi / units, 0)
//     Coverage gap      =  IF(trailing_dscr < 1.25, 1.25 - trailing_dscr, 0)
//
// and the formula is typed by a USER and stored in a view config. It is then
// turned into SQL and run as the postgres superuser, where RLS never applies.
// So this file is a security boundary first and a calculator second.
//
// HOW IT STAYS SAFE. There is no string concatenation of anything the user
// typed. The formula is tokenised, parsed into a tree, and the tree is
// compiled. Every leaf is one of exactly three things:
//
//   * a FIELD   -> looked up in config/datasets.js and emitted as its quoted
//                  column, or the compile fails. An unknown name never
//                  reaches SQL.
//   * a NUMBER  -> pushed into the params array and emitted as $n. A number is
//                  never inlined, so "1; drop table x" cannot even tokenise.
//   * a FUNCTION -> one of a fixed list, emitted from a hard-coded template.
//
// Anything else - a quote, a semicolon, a dot, a comment, an unknown word - is
// rejected by the tokenizer before a parser ever sees it.
//
// MISSING DATA SHOWS AS A DASH. Division is compiled as `a / nullif(b, 0)`,
// so dividing by zero yields NULL rather than an error, and NULL renders as
// the not-available dash. NULL in any operand propagates the same way.
//
// SUM and AVERAGE total a COLUMN, the way they do in a spreadsheet. In a
// per-row column they compile to a window over the whole filtered result
// (`sum(x) over ()`), so `t12_noi / SUM(t12_noi)` is each row's share of the
// total and the result still has one row per record. In a grouped view they
// are plain aggregates per group, and there every field must sit inside one,
// because a bare field has no single value for a group. Aggregates do not
// nest.
// ===========================================================================
'use strict';

const R = require('./config/datasets');

const MAX_LENGTH = 400;     // characters
const MAX_NODES = 120;      // tree size
const MAX_DEPTH = 24;       // nesting

class FormulaError extends Error {
  constructor(message, position) { super(message); this.position = position; }
}

/* argument counts; SUM and AVERAGE are the aggregates, handled in compile() */
const FUNCS = {
  IF:      { min: 3, max: 3 },
  MIN:     { min: 2, max: 8 },
  MAX:     { min: 2, max: 8 },
  ROUND:   { min: 1, max: 2 },
  ABS:     { min: 1, max: 1 },
  SUM:     { min: 1, max: 1 },
  AVERAGE: { min: 1, max: 1 },
};

/* ---- tokenizer ------------------------------------------------------------ */
function tokenize(src) {
  const out = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue; }

    /* numbers: 12, 1.25, .5 - no exponents, no signs (unary minus is an
       operator), no thousands separators */
    if (/[0-9.]/.test(c)) {
      const m = /^(\d+(\.\d+)?|\.\d+)/.exec(src.slice(i));
      if (!m) throw new FormulaError('Malformed number', i);
      out.push({ t: 'num', v: Number(m[0]), p: i });
      i += m[0].length; continue;
    }

    /* identifiers: field keys and function names. Lowercase snake for
       fields, letters for functions; nothing with a dot or quote. */
    if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i));
      out.push({ t: 'id', v: m[0], p: i });
      i += m[0].length; continue;
    }

    const two = src.slice(i, i + 2);
    if (two === '>=' || two === '<=' || two === '<>' || two === '!=') {
      out.push({ t: 'op', v: two === '!=' ? '<>' : two, p: i }); i += 2; continue;
    }
    if ('+-*/(),<>='.indexOf(c) >= 0) {
      out.push({ t: c === '(' || c === ')' || c === ',' ? c : 'op', v: c, p: i }); i++; continue;
    }

    /* everything else - quotes, semicolons, dots outside numbers, comment
       markers, backslashes - is refused here, before parsing */
    throw new FormulaError('Unexpected character "' + c + '"', i);
  }
  out.push({ t: 'eof', p: src.length });
  return out;
}

/* ---- parser: precedence climbing ----------------------------------------
     comparison  <  additive  <  multiplicative  <  unary  <  primary
-------------------------------------------------------------------------- */
function parse(src) {
  if (typeof src !== 'string') throw new FormulaError('A formula is required', 0);
  const text = src.trim().replace(/^=/, '').trim();
  if (!text) throw new FormulaError('A formula is required', 0);
  if (text.length > MAX_LENGTH) throw new FormulaError('Formula is longer than ' + MAX_LENGTH + ' characters', 0);

  const toks = tokenize(text);
  let k = 0, nodes = 0;
  const peek = () => toks[k];
  const next = () => toks[k++];
  const node = (n, depth) => {
    if (++nodes > MAX_NODES) throw new FormulaError('Formula is too complex', n.p || 0);
    if (depth > MAX_DEPTH) throw new FormulaError('Formula is nested too deeply', n.p || 0);
    return n;
  };
  const expect = (t, msg) => {
    const x = next();
    if (x.t !== t) throw new FormulaError(msg || ('Expected ' + t), x.p);
    return x;
  };

  function comparison(d) {
    let left = additive(d + 1);
    while (peek().t === 'op' && ['<', '>', '<=', '>=', '=', '<>'].indexOf(peek().v) >= 0) {
      const op = next();
      left = node({ k: 'cmp', op: op.v, a: left, b: additive(d + 1), p: op.p }, d);
    }
    return left;
  }
  function additive(d) {
    let left = multiplicative(d + 1);
    while (peek().t === 'op' && (peek().v === '+' || peek().v === '-')) {
      const op = next();
      left = node({ k: 'bin', op: op.v, a: left, b: multiplicative(d + 1), p: op.p }, d);
    }
    return left;
  }
  function multiplicative(d) {
    let left = unary(d + 1);
    while (peek().t === 'op' && (peek().v === '*' || peek().v === '/')) {
      const op = next();
      left = node({ k: 'bin', op: op.v, a: left, b: unary(d + 1), p: op.p }, d);
    }
    return left;
  }
  function unary(d) {
    if (peek().t === 'op' && peek().v === '-') {
      const op = next();
      return node({ k: 'neg', a: unary(d + 1), p: op.p }, d);
    }
    return primary(d + 1);
  }
  function primary(d) {
    const x = peek();
    if (x.t === 'num') { next(); return node({ k: 'num', v: x.v, p: x.p }, d); }
    if (x.t === '(') {
      next();
      const e = comparison(d + 1);
      expect(')', 'Missing closing parenthesis');
      return e;
    }
    if (x.t === 'id') {
      next();
      if (peek().t === '(') {
        const name = x.v.toUpperCase();
        if (!Object.prototype.hasOwnProperty.call(FUNCS, name)) {
          throw new FormulaError('Unknown function ' + x.v + '. Use IF, MIN, MAX, ROUND, ABS, SUM or AVERAGE.', x.p);
        }
        next();
        const args = [];
        if (peek().t !== ')') {
          args.push(comparison(d + 1));
          while (peek().t === ',') { next(); args.push(comparison(d + 1)); }
        }
        expect(')', 'Missing closing parenthesis after ' + name);
        const spec = FUNCS[name];
        if (args.length < spec.min || args.length > spec.max) {
          throw new FormulaError(name + ' takes ' + (spec.min === spec.max ? spec.min : spec.min + ' to ' + spec.max) +
            ' argument' + (spec.max === 1 ? '' : 's'), x.p);
        }
        return node({ k: 'fn', name, args, p: x.p }, d);
      }
      return node({ k: 'field', v: x.v, p: x.p }, d);
    }
    throw new FormulaError(x.t === 'eof' ? 'Formula ends too early' : 'Unexpected "' + (x.v || x.t) + '"', x.p);
  }

  const tree = comparison(0);
  if (peek().t !== 'eof') throw new FormulaError('Unexpected "' + (peek().v || peek().t) + '"', peek().p);
  return tree;
}

/* ---- compiler ------------------------------------------------------------
   opts.datasetKey   which registry the fields resolve against
   opts.params       the shared parameter array; numbers are pushed onto it
   opts.grouped      the view groups rows: SUM/AVERAGE are per group, and
                     every field must be inside one
   opts.extraFields  { key: sqlExpr } for already-compiled calculated
                     columns this formula may reference (no cycles)
-------------------------------------------------------------------------- */
function compile(src, opts) {
  const o = opts || {};
  const params = o.params || [];
  const fields = new Set();
  let usesAggregate = false;
  let inAgg = 0;
  const tree = parse(src);

  function emit(n) {
    switch (n.k) {
      case 'num':
        params.push(n.v);
        return '$' + params.length + '::numeric';
      case 'field': {
        if (o.extraFields && Object.prototype.hasOwnProperty.call(o.extraFields, n.v)) {
          if (inAgg) throw new FormulaError('"' + n.v + '" is a calculated column and cannot go inside SUM or AVERAGE', n.p);
          return '(' + o.extraFields[n.v] + ')';
        }
        const col = R.safeColumn(o.datasetKey, n.v);
        if (!col) throw new FormulaError('Unknown field "' + n.v + '"', n.p);
        const f = R.getField(o.datasetKey, n.v);
        if (f && ['number', 'currency', 'percent', 'ratio'].indexOf(f.type) < 0) {
          throw new FormulaError('"' + n.v + '" is ' + f.type + ', not a number', n.p);
        }
        if (o.grouped && !inAgg) {
          throw new FormulaError('This view is grouped, so "' + n.v + '" needs SUM or AVERAGE around it', n.p);
        }
        fields.add(n.v);
        return col + '::numeric';
      }
      case 'neg':  return '(-' + emit(n.a) + ')';
      case 'bin':
        if (n.op === '/') return '(' + emit(n.a) + ' / nullif(' + emit(n.b) + ', 0))';
        return '(' + emit(n.a) + ' ' + n.op + ' ' + emit(n.b) + ')';
      case 'cmp':
        return '(' + emit(n.a) + ' ' + n.op + ' ' + emit(n.b) + ')';
      case 'fn': {
        const a = n.args;
        switch (n.name) {
          case 'IF':
            /* the condition must be a comparison; a bare number is not a
               truth value here, and coercing one would hide a typo */
            if (a[0].k !== 'cmp') throw new FormulaError('The first argument of IF must be a comparison, like units > 0', a[0].p);
            return '(case when ' + emit(a[0]) + ' then ' + emit(a[1]) + ' else ' + emit(a[2]) + ' end)';
          case 'MIN':   return 'least(' + a.map(x => emit(x)).join(', ') + ')';
          case 'MAX':   return 'greatest(' + a.map(x => emit(x)).join(', ') + ')';
          case 'ABS':   return 'abs(' + emit(a[0]) + ')';
          case 'ROUND': {
            if (a.length === 2 && a[1].k !== 'num') throw new FormulaError('ROUND places must be a number', a[1].p);
            const places = a.length === 2 ? Math.max(0, Math.min(6, Math.round(a[1].v))) : 0;
            params.push(places);
            return 'round(' + emit(a[0]) + ', $' + params.length + '::int)';
          }
          case 'SUM':
          case 'AVERAGE': {
            if (inAgg) throw new FormulaError(n.name + ' cannot go inside another SUM or AVERAGE', n.p);
            usesAggregate = true;
            inAgg++;
            const inner = emit(a[0]);
            inAgg--;
            return (n.name === 'SUM' ? 'sum(' : 'avg(') + inner + ')' + (o.grouped ? '' : ' over ()');
          }
        }
      }
    }
    throw new FormulaError('Cannot compile this formula', n.p || 0);
  }

  const sql = emit(tree);
  return { sql, params, fields: [...fields], usesAggregate, tree };
}

/* Validate without keeping the SQL - for the builder, as the user types. */
function check(src, datasetKey, opts) {
  try {
    const r = compile(src, Object.assign({ datasetKey, params: [] }, opts || {}));
    return { ok: true, fields: r.fields, usesAggregate: r.usesAggregate };
  } catch (e) {
    return { ok: false, error: e.message, position: e.position || 0 };
  }
}

module.exports = { parse, compile, check, tokenize, FormulaError, FUNCS, MAX_LENGTH };
