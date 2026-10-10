/* ===========================================================================
   portal-saved-views.js — the Views section (Phase 3).

   A list of views you own and views shared with you, a step-by-step builder,
   and four renderers: dashboard, spreadsheet, list and report.

   Views never edit data. The builder composes a QUESTION against a curated
   dataset; the server turns it into a parameterized query from the registry
   and returns rows. Nothing here can write to a reporting table.

   Same conventions as portal-reporting.js: `.onclick` rather than
   addEventListener because paint() re-renders the subtree, `sv-` prefixed
   class names because portal.html owns the generic ones, and "–" for not
   available, never 0.

   Exposes window.PortalViews.
   =========================================================================== */
(function () {
  'use strict';

  function escS(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  var DASH = '–';
  function isNum(v) { return v !== null && v !== undefined && v !== '' && isFinite(Number(v)); }

  /* Formatting is shared with the Properties section by TYPE, from the same
     registry the server validates against, so a figure cannot be currency on
     one screen and a bare number on another. */
  function fmt(v, type, field) {
    if (v === null || v === undefined || v === '') return DASH;
    switch (type) {
      case 'currency': {
        var n = Number(v);
        if (!isFinite(n)) return DASH;
        var a = Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        return n < 0 ? '($' + a + ')' : '$' + a;
      }
      case 'percent': return isNum(v) ? (Number(v) * 100).toFixed(1) + '%' : DASH;
      case 'ratio':   return isNum(v) ? Number(v).toFixed(2) : DASH;
      case 'number': {
        if (!isNum(v)) return DASH;
        var dp = field && field.decimals;
        var s = dp ? Number(v).toFixed(dp) : Number(v).toLocaleString('en-US');
        return s + (field && field.suffix ? field.suffix : '');
      }
      case 'date': {
        var m = /^(\d{4})-(\d{2})(?:-(\d{2}))?/.exec(String(v));
        if (!m) return escS(String(v));
        var MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
        if (field && field.format === 'YYYY-MM') return MON[Number(m[2]) - 1] + ' ' + m[1];
        return (m[3] ? Number(m[3]) + ' ' : '') + MON[Number(m[2]) - 1] + ' ' + m[1];
      }
      default: return escS(String(v));
    }
  }
  function negClass(v, type) {
    return (type === 'currency' || type === 'number') && isNum(v) && Number(v) < 0 ? ' rp-neg' : '';
  }

  /* ---- G2 presentation: formats, colour rules, column descriptors ----
     Every option is picked from a fixed list the server also holds; a saved
     view can rename a header or change how a number is written, never what
     the number is. */
  var NUMERIC = { currency: 1, number: 1, percent: 1, ratio: 1 };
  var FORMATS = [
    ['', 'Field default'], ['currency', '$1,234.56'], ['currency0', '$1,235'],
    ['thousands', '$1.2K'], ['millions', '$1.23M'], ['number', '1,234.5'],
    ['number0', '1,235'], ['number2', '1,234.50'], ['percent', '12.3%'],
    ['percent0', '12%'], ['ratio', '1.23']
  ];
  var CALC_FORMATS = [['number', 'Number'], ['currency', 'Dollars'], ['percent', 'Percent'], ['ratio', 'Ratio']];
  var ACCENTS = ['indigo', 'jade', 'amber', 'rust', 'sky', 'slate'];
  var TONES = [['good', 'Good'], ['warn', 'Warning'], ['bad', 'Bad'], ['muted', 'Muted'], ['accent', 'Accent']];
  var RULE_OPS = [['gt', '>'], ['gte', '≥'], ['lt', '<'], ['lte', '≤'], ['eq', '='], ['ne', '≠'],
                  ['is_empty', 'is empty'], ['not_empty', 'has a value']];
  var FN_HELP = {
    IF: 'IF(test, then, else)', MIN: 'smallest of', MAX: 'largest of',
    ROUND: 'ROUND(x, places)', ABS: 'without the sign',
    SUM: 'column total', AVERAGE: 'column average'
  };

  function money(x, dp, suffix) {
    var a = Math.abs(x).toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
    var s = '$' + a + (suffix || '');
    return x < 0 ? '(' + s + ')' : s;
  }
  /* A saved format overrides how a value is written for display only. */
  function fmtAs(v, col) {
    var f = col.format;
    if (!f) return fmt(v, col.type, col.field);
    if (v === null || v === undefined || v === '') return DASH;
    if (!isNum(v)) return escS(String(v));
    var n = Number(v);
    switch (f) {
      case 'currency':  return money(n, 2);
      case 'currency0': return money(n, 0);
      case 'thousands': return money(n / 1e3, 1, 'K');
      case 'millions':  return money(n / 1e6, 2, 'M');
      case 'number':    return n.toLocaleString('en-US');
      case 'number0':   return n.toLocaleString('en-US', { maximumFractionDigits: 0 });
      case 'number2':   return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      case 'percent':   return (n * 100).toFixed(1) + '%';
      case 'percent0':  return (n * 100).toFixed(0) + '%';
      case 'ratio':     return n.toFixed(2);
    }
    return fmt(v, col.type, col.field);
  }

  function styleOf(view) { return (view.config && view.config.style) || {}; }
  function ruleHit(rule, v) {
    var empty = v === null || v === undefined || v === '';
    if (rule.op === 'is_empty') return empty;
    if (rule.op === 'not_empty') return !empty;
    if (!isNum(v) || !isNum(rule.value)) return false;
    var n = Number(v), x = Number(rule.value);
    switch (rule.op) {
      case 'gt': return n > x;   case 'gte': return n >= x;
      case 'lt': return n < x;   case 'lte': return n <= x;
      case 'eq': return n === x; case 'ne': return n !== x;
    }
    return false;
  }
  /* First matching rule wins, in the order the person listed them. */
  function toneFor(view, row, key, target) {
    var rules = styleOf(view).rules || [];
    for (var i = 0; i < rules.length; i++) {
      var r = rules[i];
      if ((r.target === 'row' ? 'row' : 'cell') !== target) continue;
      if (target === 'cell' && r.field !== key) continue;
      if (ruleHit(r, row[r.field])) return ' sv-tone-' + r.tone;
    }
    return '';
  }

  function calcOf(view, k) {
    return (view.config.calculated || []).filter(function (c) { return c.key === k; })[0] || null;
  }
  function colFor(view, k) {
    var cfg = (view.config.fields || []).filter(function (x) { return x.key === k; })[0] || {};
    var c = calcOf(view, k);
    if (c) {
      return { key: k, label: cfg.label || c.label, type: c.format || 'number',
               field: { decimals: c.decimals }, missing: false, calc: true, formula: c.formula,
               format: null, width: cfg.width || null };
    }
    var f = fieldOf(view.dataset_key, k);
    return f ? { key: k, label: cfg.label || f.label, type: f.type, field: f, missing: false,
                 format: cfg.format || null, width: cfg.width || null }
             : { key: k, label: 'Field missing: ' + k, type: 'text', field: null, missing: true };
  }
  function thHtml(x, resizable) {
    var right = NUMERIC[x.type];
    var title = x.calc ? ' title="' + escS(x.label + ' = ' + x.formula) + '"' : '';
    var w = x.width ? ' style="width:' + x.width + 'px;min-width:' + x.width + 'px"' : '';
    return '<th class="' + (right ? 'r' : '') + (resizable ? ' sv-th-rs' : '') + '"' + title + w + '>' +
      (x.missing ? '<span class="sv-miss">' + escS(x.label) + '</span>' : escS(x.label)) +
      (x.calc ? '<span class="sv-fx">fx</span>' : '') +
      (resizable ? '<span class="sv-rsz" data-rsz="' + escS(x.key) + '" title="Drag to resize"></span>' : '') +
      '</th>';
  }
  function tdHtml(view, row, x) {
    var v = row[x.key];
    return '<td class="' + (NUMERIC[x.type] ? 'r' : '') + negClass(v, x.type) + toneFor(view, row, x.key, 'cell') + '">' +
      (x.missing ? DASH : fmtAs(v, x)) + '</td>';
  }

  /* The header a printed view carries: on paper there is no screen around
     it saying what it is, when it was run, or how it was filtered. */
  function today() {
    var d = new Date();
    var MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return d.getDate() + ' ' + MON[d.getMonth()] + ' ' + d.getFullYear();
  }
  /* an ISO day as written, never through the viewer's timezone */
  function dayLabel(iso) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
    if (!m) return DASH;
    var MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return Number(m[3]) + ' ' + MON[Number(m[2]) - 1] + ' ' + m[1];
  }

  /* ---- formula evaluation for subtotals (G3) ----
     Walks the tree the server parsed. Mirrors the SQL it compiles to: NULL
     propagates, a divide by zero is NULL, LEAST/GREATEST skip NULLs, and an
     IF whose test is NULL takes the else branch. */
  function evalTree(n, ctx) {
    var a, b;
    switch (n.k) {
      case 'num': return n.v;
      case 'field': return ctx.field(n.v);
      case 'neg': a = evalTree(n.a, ctx); return a === null ? null : -a;
      case 'bin':
        a = evalTree(n.a, ctx); b = evalTree(n.b, ctx);
        if (a === null || b === null) return null;
        if (n.op === '+') return a + b;
        if (n.op === '-') return a - b;
        if (n.op === '*') return a * b;
        return b === 0 ? null : a / b;
      case 'cmp':
        a = evalTree(n.a, ctx); b = evalTree(n.b, ctx);
        if (a === null || b === null) return null;
        switch (n.op) { case '<': return a < b; case '>': return a > b; case '<=': return a <= b;
                        case '>=': return a >= b; case '=': return a === b; default: return a !== b; }
      case 'fn': {
        var args = n.args;
        switch (n.name) {
          case 'IF': return evalTree(args[0], ctx) === true ? evalTree(args[1], ctx) : evalTree(args[2], ctx);
          case 'MIN': case 'MAX': {
            var vals = args.map(function (x) { return evalTree(x, ctx); }).filter(function (v) { return v !== null; });
            return vals.length ? Math[n.name === 'MIN' ? 'min' : 'max'].apply(null, vals) : null;
          }
          case 'ABS': a = evalTree(args[0], ctx); return a === null ? null : Math.abs(a);
          case 'ROUND': {
            a = evalTree(args[0], ctx);
            var p = Math.pow(10, args.length > 1 ? Math.max(0, Math.min(6, Math.round(args[1].v))) : 0);
            return a === null ? null : Math.round(a * p) / p;
          }
          case 'SUM': case 'AVERAGE': return ctx.agg(n.name, args[0]);
        }
      }
    }
    return null;
  }
  /* A subtotal: every bare field is the group's SUM, SUM/AVERAGE total the
     expression row by row, and a reference to another calculated column is
     that column's own subtotal. */
  function groupValue(key, rows, trees) {
    var tree = trees && trees[key];
    if (!tree) return null;
    var num = function (v) { return isNum(v) ? Number(v) : null; };
    var sumOf = function (vals) { vals = vals.filter(function (v) { return v !== null; }); return vals.length ? vals.reduce(function (x, y) { return x + y; }, 0) : null; };
    var rowCtx = function (row) {
      return { field: function (k) { return num(row[k]); }, agg: function () { return null; } };
    };
    var ctx = {
      field: function (k) { return trees[k] ? groupValue(k, rows, trees) : sumOf(rows.map(function (r) { return num(r[k]); })); },
      agg: function (fn, expr) {
        var vals = rows.map(function (r) { return evalTree(expr, rowCtx(r)); }).filter(function (v) { return v !== null; });
        if (!vals.length) return null;
        var s = vals.reduce(function (x, y) { return x + y; }, 0);
        return fn === 'SUM' ? s : s / vals.length;
      },
    };
    var v = evalTree(tree, ctx);
    return typeof v === 'number' && isFinite(v) ? v : null;
  }

  function filterText(view) {
    var OPS = { eq: '=', ne: '≠', gt: '>', gte: '≥', lt: '<', lte: '≤', in: 'is one of', between: 'between',
                contains: 'contains', is_empty: 'is empty', not_empty: 'has a value' };
    return (view.config.filters || []).map(function (f) {
      var c = colFor(view, f.field);
      var v = f.op === 'is_empty' || f.op === 'not_empty' ? '' :
        ' ' + (Array.isArray(f.value) ? f.value.join(', ') : String(f.value === undefined ? '' : f.value));
      return c.label + ' ' + (OPS[f.op] || f.op) + v;
    }).join('; ');
  }
  function reportHeader(view) {
    var hd = styleOf(view).header || {};
    var meta = [];
    if (hd.period_from || hd.period_to) meta.push('Period ' + dayLabel(hd.period_from) + ' to ' + dayLabel(hd.period_to));
    if (hd.show_date !== false) meta.push('Run ' + today());
    if (hd.show_filters !== false && (view.config.filters || []).length) meta.push('Filters: ' + filterText(view));
    var onScreen = view.display_type === 'report' && (hd.title || hd.subtitle);
    return '<header class="sv-rhead' + (onScreen ? '' : ' sv-print-only') + '">' +
      (hd.show_logo !== false ? '<span class="sv-rhead-logo"><img src="/icons/leavenwealth-mark.svg" alt="LeavenWealth"></span>' : '') +
      '<div><h2>' + escS(hd.title || view.name || '') + '</h2>' +
      (hd.subtitle ? '<p>' + escS(hd.subtitle) + '</p>' : '') +
      (meta.length ? '<div class="sv-rhead-meta">' + meta.map(escS).join(' · ') + '</div>' : '') +
      '</div></header>';
  }
  function styled(view, inner) {
    var st = styleOf(view);
    var theme = st.theme === 'light' || st.theme === 'dark' ? ' data-theme="' + st.theme + '"' : '';
    return '<div class="sv-styled' + (theme ? ' sv-themed' : '') +
      ' sv-d-' + (st.density || 'comfortable') + ' sv-t-' + (st.text_size || 'md') +
      ' sv-acc-' + (ACCENTS.indexOf(st.accent) >= 0 ? st.accent : 'indigo') + '"' + theme + '>' +
      reportHeader(view) + inner + '</div>';
  }
  function render(view, data) {
    var body;
    switch (view.display_type) {
      case 'dashboard': body = dashboard(view, data); break;
      case 'list':      body = listView(view, data); break;
      case 'report':    body = report(view, data); break;
      default:          body = spreadsheet(view, data);
    }
    return styled(view, body);
  }

  /* ---- data ---- */
  function authHeaders() {
    return window.PortalSession.client()
      .then(function (c) { return c.auth.getSession(); })
      .then(function (r) {
        var t = r && r.data && r.data.session && r.data.session.access_token;
        if (!t) throw new Error('Your session has expired. Sign in again.');
        return { Authorization: 'Bearer ' + t, Accept: 'application/json', 'Content-Type': 'application/json' };
      });
  }
  function api(path, init) {
    return authHeaders().then(function (h) {
      return fetch(path, Object.assign({ cache: 'no-store' }, init, { headers: h }))
        .then(function (r) {
          return r.json().then(function (b) {
            if (!r.ok) throw new Error((b && b.error) || ('HTTP ' + r.status));
            return b;
          }, function () { throw new Error('HTTP ' + r.status); });
        });
    });
  }

  /* ---- state ---- */
  var S = {
    host: null, mode: 'list', busy: false, error: null,
    datasets: null, views: null,
    view: null, perm: null, data: null, problems: [],
    page: 1,
    draft: null, step: 1,
    shares: null,
    fstat: {},          // formula status per calculated column, kept across repaints
  };

  function ds(key) {
    return (S.datasets || []).filter(function (d) { return d.key === key; })[0] || null;
  }
  function fieldOf(dsKey, k) {
    var d = ds(dsKey);
    return d ? (d.fields.filter(function (f) { return f.key === k; })[0] || null) : null;
  }

  /* ---- list ---- */
  function listHtml() {
    var mine = (S.views || []).filter(function (v) { return v.is_mine; });
    var shared = (S.views || []).filter(function (v) { return !v.is_mine; });
    function card(v) {
      var d = ds(v.dataset_key);
      return '<div class="sv-card" data-open="' + escS(v.id) + '">' +
        '<h4>' + escS(v.name) + '</h4>' +
        '<div class="rp-dim">' + escS(v.description || (d ? d.label : '')) + '</div>' +
        '<div class="sv-meta">' +
          '<span class="sv-tag">' + escS(v.display_type) + '</span>' +
          '<span class="sv-tag">' + escS(d ? d.label : v.dataset_key) + '</span>' +
          (v.is_mine ? '' : '<span class="sv-tag">' + escS(v.owner_name || 'shared') + '</span>') +
        '</div></div>';
    }
    var h = ['<div class="sv-head"><div><h3 style="margin:0">Views</h3>' +
      '<div class="rp-dim">Build a view from a curated dataset, save it, share it. Views never change data.</div></div>' +
      '<button class="rp-btn" id="svNew">New view</button></div>'];
    if (!S.views || !S.views.length) {
      h.push('<div class="rp-empty">No views yet. <b>New view</b> starts one.</div>');
      return h.join('');
    }
    if (mine.length) h.push('<h4 class="rp-h4">Mine</h4><div class="sv-grid">' + mine.map(card).join('') + '</div>');
    if (shared.length) h.push('<h4 class="rp-h4">Shared with me</h4><div class="sv-grid">' + shared.map(card).join('') + '</div>');
    return h.join('');
  }

  /* ---- renderers ---- */
  function cols(view) {
    var d = ds(view.dataset_key);
    var keys = (view.config.fields || []).map(function (f) { return f.key; });
    if (!keys.length && d) keys = d.fields.filter(function (f) { return !f.hidden; }).map(function (f) { return f.key; });
    return keys.map(function (k) { return colFor(view, k); });
  }
  /* Column widths can be dragged only while building; a saved view is read. */
  function resizable() { return S.mode === 'builder'; }

  function spreadsheet(view, data) {
    var c = cols(view), rs = resizable();
    var h = ['<div class="rp-scroll"><table class="rp-tbl sv-tbl"><thead><tr>' +
      c.map(function (x) { return thHtml(x, rs); }).join('') + '</tr></thead><tbody>'];
    (data.rows || []).forEach(function (row) {
      h.push('<tr class="' + toneFor(view, row, null, 'row').trim() + '">' +
        c.map(function (x) { return tdHtml(view, row, x); }).join('') + '</tr>');
    });
    h.push('</tbody></table></div>');
    return h.join('');
  }

  function listView(view, data) {
    var c = cols(view);
    if (!c.length) return '<div class="rp-empty">This view has no fields.</div>';
    var title = c[0], rest = c.slice(1, 7);
    return (data.rows || []).map(function (row) {
      return '<div class="sv-list-row' + toneFor(view, row, null, 'row') + '"><h5>' +
        (title.missing ? DASH : fmtAs(row[title.key], title)) + '</h5>' +
        '<div class="sv-list-sec">' + rest.map(function (x) {
          return '<span><span class="rp-dim">' + escS(x.label) + '</span> ' +
            '<b class="' + (negClass(row[x.key], x.type) + toneFor(view, row, x.key, 'cell')).trim() + '">' +
            (x.missing ? DASH : fmtAs(row[x.key], x)) + '</b></span>';
        }).join('') + '</div></div>';
    }).join('') || '<div class="rp-empty">No rows match this view.</div>';
  }

  /* Subtotals add only money and counts; a percent or a ratio does not sum.
     A calculated column's subtotal is its own formula over the totals, never
     the sum of its rows. */
  function summable(x) { return x.calc || x.type === 'currency' || x.type === 'number'; }
  function totalCell(x, rows, trees) {
    if (x.calc) {
      var g = groupValue(x.key, rows, trees);
      return '<td class="r" title="' + escS(x.formula) + ', over the totals">' + (g === null ? DASH : fmtAs(g, x)) + '</td>';
    }
    var vals = rows.map(function (r) { return r[x.key]; }).filter(isNum).map(Number);
    return '<td class="r">' + (vals.length ? fmtAs(vals.reduce(function (a, b) { return a + b; }, 0), x) : DASH) + '</td>';
  }

  function report(view, data) {
    var c = cols(view), rs = resizable();
    var groupKey = (view.config.group_by || [])[0] || null;
    var h = ['<div class="rp-scroll"><table class="rp-tbl sv-tbl"><thead><tr>' +
      c.map(function (x) { return thHtml(x, rs); }).join('') + '</tr></thead>'];
    var rows = data.rows || [];
    /* the Subtotal / Grand total label sits in the first column that has no
       total of its own, so it never covers a figure */
    var labelAt = c.findIndex(function (x) { return !summable(x); });
    if (labelAt < 0) labelAt = 0;
    var line = function (row) {
      return '<tr class="' + toneFor(view, row, null, 'row').trim() + '">' +
        c.map(function (x) { return tdHtml(view, row, x); }).join('') + '</tr>';
    };
    if (!groupKey) {
      h.push('<tbody>' + rows.map(line).join('') + '</tbody>');
    } else {
      var groups = {};
      rows.forEach(function (r) { (groups[r[groupKey]] = groups[r[groupKey]] || []).push(r); });
      Object.keys(groups).sort().forEach(function (g) {
        h.push('<tbody><tr class="rp-grph"><td colspan="' + c.length + '"><b>' + escS(g === 'null' ? DASH : g) + '</b></td></tr>');
        groups[g].forEach(function (row) { h.push(line(row)); });
        h.push('<tr class="rp-strong">' + c.map(function (x, i) {
          if (i === labelAt) return '<td>Subtotal</td>';
          return summable(x) ? totalCell(x, groups[g], data.formulas) : '<td></td>';
        }).join('') + '</tr></tbody>');
      });
      h.push('<tfoot><tr>' + c.map(function (x, i) {
        if (i === labelAt) return '<td><b>Grand total</b></td>';
        return summable(x) ? totalCell(x, rows, data.formulas) : '<td></td>';
      }).join('') + '</tr></tfoot>');
    }
    h.push('</table></div>');
    return h.join('');
  }

  function tileValue(rows, key, agg) {
    if (agg === 'count') return rows.length;
    var vals = rows.map(function (r) { return r[key]; }).filter(isNum).map(Number);
    if (!vals.length) return null;
    var sum = vals.reduce(function (a, b) { return a + b; }, 0);
    switch (agg) {
      case 'avg': return sum / vals.length;
      case 'min': return Math.min.apply(null, vals);
      case 'max': return Math.max.apply(null, vals);
      default:    return sum;
    }
  }

  function dashboard(view, data) {
    var layout = view.config.layout || [];
    if (!layout.length) return '<div class="rp-empty">This dashboard has no tiles yet. Edit it and add some under <b>Style</b>.</div>';
    var rows = data.rows || [];
    var h = ['<div class="sv-tiles">'];
    layout.filter(function (t) { return t.type === 'number'; }).forEach(function (t) {
      var key = (t.fields || [])[0];
      var col = colFor(view, key);
      var v = tileValue(rows, key, t.aggregate);
      var shown = t.aggregate === 'count' ? { type: 'number', field: null, format: null } : col;
      h.push('<div class="sv-tile sv-sz-' + (t.size || 'M') + (t.accent ? ' sv-tile-acc sv-acc-' + t.accent : '') + '">' +
        '<div class="k">' + escS(t.title || col.label) + '</div>' +
        '<div class="v' + negClass(v, shown.type) + '">' + (v === null ? DASH : fmtAs(v, shown)) + '</div>' +
        (col.missing ? '<div class="sv-miss">' + escS(col.label) + '</div>' : '') + '</div>');
    });
    h.push('</div>');
    layout.filter(function (t) { return t.type === 'table'; }).forEach(function (t) {
      var c = (t.fields || []).map(function (k) { return colFor(view, k); });
      h.push('<h4 class="rp-h4">' + escS(t.title || 'Table') + '</h4>');
      h.push('<div class="rp-scroll"><table class="rp-tbl sv-tbl"><thead><tr>' +
        c.map(function (x) { return thHtml(x, false); }).join('') + '</tr></thead><tbody>' +
        rows.slice(0, 12).map(function (r) {
          return '<tr>' + c.map(function (x) { return tdHtml(view, r, x); }).join('') + '</tr>';
        }).join('') + '</tbody></table></div>');
    });
    return h.join('');
  }

  function viewHtml() {
    var v = S.view;
    if (!v) return '<div class="rp-empty">Loading…</div>';
    /* S.data is null until the rows arrive. Falling back to an empty result
       here rendered "No rows match this view. 0 of 0 rows" over a view that
       has eight - a confident wrong answer in the window before the fetch
       returns, and one that a screenshot catches as fact. */
    var pending = !S.data;
    var d = S.data || { rows: [], total: 0, page: 1, per_page: 200 };
    var h = ['<div class="sv-head"><div><h3 style="margin:0">' + escS(v.name) + '</h3>' +
      '<div class="rp-dim">' + escS(v.description || '') + '</div></div><div class="rp-bar" style="margin:0">' +
      '<button class="rp-btn" id="svBack">All views</button>' +
      (S.perm === 'viewer' ? '' : '<button class="rp-btn" id="svEdit">Edit</button>') +
      (S.perm === 'owner' ? '<button class="rp-btn" id="svShare">Share</button>' +
                            '<button class="rp-btn" id="svDelete">Delete</button>' : '') +
      '<button class="rp-btn" id="svCsv">Export CSV</button>' +
      (v.display_type === 'report' ? '<button class="rp-btn" id="svPrint">Print / PDF</button>' : '') +
      '</div></div>'];

    if (S.problems && S.problems.length) {
      h.push('<div class="sv-probs"><b>This view refers to things that are no longer in its dataset.</b> ' +
        'It still loads; the parts below are what changed.<ul><li>' +
        S.problems.map(escS).join('</li><li>') + '</li></ul></div>');
    }

    if (pending) h.push('<div class="rp-empty">Loading…</div>');
    else h.push(render(v, d));

    if (!pending && (v.display_type === 'spreadsheet' || v.display_type === 'list')) {
      var pages = Math.max(1, Math.ceil((d.total || 0) / (d.per_page || 200)));
      h.push('<div class="rp-bar" style="margin-top:12px">' +
        '<span class="rp-count">' + (d.rows || []).length + ' of ' + (d.total || 0) + ' rows</span>' +
        (pages > 1 ? '<button class="rp-btn" id="svPrev"' + (S.page <= 1 ? ' disabled' : '') + '>Prev</button>' +
          '<span class="rp-dim">page ' + S.page + ' of ' + pages + '</span>' +
          '<button class="rp-btn" id="svNext"' + (S.page >= pages ? ' disabled' : '') + '>Next</button>' : '') +
        '</div>');
    }
    return h.join('');
  }

  /* ---- builder ---- */
  var STEPS = ['Dataset', 'Display', 'Fields', 'Filters', 'Sort & group', 'Style', 'Preview', 'Save', 'Share'];

  function builderHtml() {
    var dr = S.draft;
    var d = ds(dr.dataset_key);
    var h = ['<div class="sv-head"><h3 style="margin:0">' + (dr.id ? 'Edit view' : 'New view') + '</h3>' +
      '<button class="rp-btn" id="svBack">Cancel</button></div>'];
    h.push('<div class="sv-steps">' + STEPS.map(function (s, i) {
      var n = i + 1;
      return '<button class="sv-step' + (S.step === n ? ' on' : (n < S.step ? ' done' : '')) + '" data-step="' + n + '">' +
        n + '. ' + escS(s) + '</button>';
    }).join('') + '</div>');

    h.push('<div class="sv-panel">');
    if (S.step === 1) {
      h.push('<p class="rp-note">Pick the dataset this view asks about. Every field you can use comes from it.</p><div class="sv-pick">');
      (S.datasets || []).forEach(function (x) {
        h.push('<label class="sv-chk' + (dr.dataset_key === x.key ? ' on' : '') + '" data-ds="' + escS(x.key) + '">' +
          '<b>' + escS(x.label) + '</b> <span class="rp-dim">' + escS(x.grain) + '</span></label>');
      });
      h.push('</div>');
      if (d) h.push('<p class="rp-note">' + escS(d.description) + '</p>');
    } else if (S.step === 2) {
      h.push('<p class="rp-note">How should it be shown? No charts in this release; numbers and tables only.</p><div class="sv-pick">');
      [['spreadsheet', 'Spreadsheet, a sortable grid'], ['list', 'List, one card per record'],
       ['report', 'Report, grouped with subtotals'], ['dashboard', 'Dashboard, number tiles']].forEach(function (t) {
        h.push('<label class="sv-chk' + (dr.display_type === t[0] ? ' on' : '') + '" data-dt="' + t[0] + '">' + escS(t[1]) + '</label>');
      });
      h.push('</div>');
    } else if (S.step === 3) {
      h.push(fieldsStepHtml());
    } else if (S.step === 4) {
      h.push('<p class="rp-note">Filters narrow the rows. Values are always sent as parameters, never pasted into the query.</p>');
      (dr.config.filters || []).forEach(function (f, i) {
        h.push('<div class="sv-fieldrow">' +
          '<select class="rp-inp" data-fw="' + i + '">' + (d ? d.fields : []).map(function (x) {
            return '<option value="' + escS(x.key) + '"' + (x.key === f.field ? ' selected' : '') + '>' + escS(x.label) + '</option>';
          }).join('') + '</select>' +
          '<select class="rp-inp" data-fo="' + i + '">' + ['eq', 'ne', 'in', 'gt', 'gte', 'lt', 'lte', 'between', 'contains', 'is_empty', 'not_empty'].map(function (o) {
            return '<option value="' + o + '"' + (o === f.op ? ' selected' : '') + '>' + o + '</option>';
          }).join('') + '</select>' +
          '<input class="rp-inp" data-fv="' + i + '" value="' + escS(Array.isArray(f.value) ? f.value.join(', ') : (f.value === null || f.value === undefined ? '' : f.value)) + '" placeholder="value">' +
          '<button class="rp-btn" data-fx="' + i + '">Remove</button></div>');
      });
      h.push('<button class="rp-btn" id="svAddFilter">Add filter</button>');
    } else if (S.step === 5) {
      h.push('<p class="rp-note">Sort, and optionally group with aggregates.</p>');
      h.push('<div class="sv-fieldrow"><span class="rp-lbl">Sort by</span>' +
        '<select class="rp-inp" id="svSortF"><option value="">(dataset default)</option>' +
        (d ? d.fields : []).concat((dr.config.calculated || []).map(function (c) { return { key: c.key, label: c.label + ' (calculated)' }; })).map(function (x) {
          var cur = (dr.config.sort || [])[0];
          return '<option value="' + escS(x.key) + '"' + (cur && cur.field === x.key ? ' selected' : '') + '>' + escS(x.label) + '</option>';
        }).join('') + '</select>' +
        '<select class="rp-inp" id="svSortD"><option value="asc">ascending</option>' +
        '<option value="desc"' + (((dr.config.sort || [])[0] || {}).dir === 'desc' ? ' selected' : '') + '>descending</option></select></div>');
      h.push('<div class="sv-fieldrow"><span class="rp-lbl">Group by</span>' +
        '<select class="rp-inp" id="svGroup"><option value="">(none)</option>' +
        (d ? d.fields : []).map(function (x) {
          return '<option value="' + escS(x.key) + '"' + ((dr.config.group_by || [])[0] === x.key ? ' selected' : '') + '>' + escS(x.label) + '</option>';
        }).join('') + '</select></div>');
      h.push('<p class="rp-note">A grouped view can only sort by a grouped column or an aggregate. Anything else is dropped rather than refused.</p>');
    } else if (S.step === 6) {
      h.push(styleStepHtml());
    } else if (S.step === 7) {
      h.push('<p class="rp-note">Drag the edge of a column header to change its width.</p>' +
        '<div id="svPreview">' + (S.data ? previewHtml() : '<div class="rp-empty">Loading preview…</div>') + '</div>');
    } else if (S.step === 8) {
      h.push('<div class="sv-fieldrow"><span class="rp-lbl">Name</span>' +
        '<input class="rp-inp" id="svName" style="min-width:320px" value="' + escS(dr.name || '') + '"></div>' +
        '<div class="sv-fieldrow"><span class="rp-lbl">Description</span>' +
        '<input class="rp-inp" id="svDesc" style="min-width:420px" value="' + escS(dr.description || '') + '"></div>' +
        '<button class="rp-btn" id="svSave">Save view</button>');
    } else if (S.step === 9) {
      h.push(sharesHtml());
    }
    h.push('</div>');

    h.push('<div class="rp-bar">' +
      (S.step > 1 ? '<button class="rp-btn" id="svPrevStep">Back</button>' : '') +
      (S.step < STEPS.length ? '<button class="rp-btn" id="svNextStep">Next</button>' : '') + '</div>');
    return h.join('');
  }

  function previewHtml() {
    return render(draftView(), S.data || { rows: [] });
  }

  function sharesHtml() {
    if (!S.draft.id) return '<p class="rp-note">Save the view first, then it can be shared.</p>';
    if (!S.shares) return '<div class="rp-empty">Loading…</div>';
    var h = ['<p class="rp-note">Sharing never grants access to data someone could not already see. ' +
      'The rows are fetched with <b>their</b> scope, so a shared view may legitimately show them fewer.</p>'];
    h.push('<div class="sv-pick">');
    (S.shares.people || []).forEach(function (p) {
      var cur = (S.shares.shares || []).filter(function (s) { return s.principal_type === 'user' && s.principal_id === p.id; })[0];
      h.push('<label class="sv-chk' + (cur ? ' on' : '') + '" data-share="user:' + escS(p.id) + '">' +
        escS(p.full_name || p.email) + (cur ? ' <span class="rp-dim">' + escS(cur.permission) + '</span>' : '') + '</label>');
    });
    h.push('</div><h4 class="rp-h4">By role</h4><div class="sv-pick">');
    (S.shares.roles || []).forEach(function (r) {
      var cur = (S.shares.shares || []).filter(function (s) { return s.principal_type === 'role' && s.principal_id === r; })[0];
      h.push('<label class="sv-chk' + (cur ? ' on' : '') + '" data-share="role:' + escS(r) + '">' +
        escS(r) + (cur ? ' <span class="rp-dim">' + escS(cur.permission) + '</span>' : '') + '</label>');
    });
    h.push('</div><div class="sv-fieldrow"><span class="rp-lbl">New shares get</span>' +
      '<select class="rp-inp" id="svPerm"><option value="viewer">viewer</option><option value="editor">editor</option></select>' +
      '<button class="rp-btn" id="svSaveShares">Save sharing</button></div>');
    return h.join('');
  }

  /* ---- builder: Fields (order, rename, format) and calculated columns ---- */
  function opts(list, cur) {
    return list.map(function (o) {
      return '<option value="' + escS(o[0]) + '"' + (String(cur || '') === o[0] ? ' selected' : '') + '>' + escS(o[1]) + '</option>';
    }).join('');
  }
  function draftView() {
    return { name: S.draft.name, display_type: S.draft.display_type, dataset_key: S.draft.dataset_key, config: S.draft.config };
  }
  /* Numeric fields plus calculated columns: what a rule, a tile or a formula
     can work with. */
  function numericChoices(upto) {
    var d = ds(S.draft.dataset_key);
    var out = (d ? d.fields : []).filter(function (f) { return NUMERIC[f.type] && !f.hidden; })
      .map(function (f) { return [f.key, f.label]; });
    (S.draft.config.calculated || []).slice(0, upto === undefined ? 99 : upto).forEach(function (c) {
      out.push([c.key, c.label + ' (calculated)']);
    });
    return out;
  }

  function fieldsStepHtml() {
    var dr = S.draft, d = ds(dr.dataset_key), v = draftView();
    var chosen = dr.config.fields || [];
    var h = ['<h4 class="rp-h4">Columns, in order</h4>'];
    if (!chosen.length) {
      h.push('<p class="rp-note">None chosen yet, so the view shows every field in the dataset. Pick below to choose and order your own.</p>');
    } else {
      h.push('<p class="rp-note">Drag a row, or use the arrows, to reorder. Rename a header or change how its numbers are written; the values themselves never change.</p>');
      h.push('<ol class="sv-order">');
      chosen.forEach(function (f, i) {
        var c = colFor(v, f.key);
        var isNumeric = NUMERIC[c.type] && !c.calc;
        h.push('<li class="sv-ord" draggable="true" data-ord="' + i + '">' +
          '<span class="sv-grip" aria-hidden="true"></span>' +
          '<span class="sv-ord-src">' + escS(c.calc ? c.label : (fieldOf(dr.dataset_key, f.key) || { label: f.key }).label) +
            (c.calc ? '<span class="sv-fx">fx</span>' : '') + '</span>' +
          '<input class="rp-inp" data-rn="' + i + '" value="' + escS(f.label || '') + '" placeholder="' + escS(c.calc ? c.label : (fieldOf(dr.dataset_key, f.key) || { label: f.key }).label) + '" aria-label="Header for ' + escS(c.label) + '">' +
          (isNumeric ? '<select class="rp-inp" data-nf="' + i + '" aria-label="Number format">' + opts(FORMATS, f.format) + '</select>' : '<span></span>') +
          '<span class="sv-ord-btns">' +
            '<button class="rp-btn sv-ib" data-up="' + i + '" aria-label="Move up"' + (i === 0 ? ' disabled' : '') + '>' + svgIcon('up') + '</button>' +
            '<button class="rp-btn sv-ib" data-dn="' + i + '" aria-label="Move down"' + (i === chosen.length - 1 ? ' disabled' : '') + '>' + svgIcon('down') + '</button>' +
            '<button class="rp-btn sv-ib" data-rm="' + i + '" aria-label="Remove column">' + svgIcon('x') + '</button>' +
          '</span></li>');
      });
      h.push('</ol>');
    }

    h.push('<h4 class="rp-h4">Add fields</h4><div class="sv-pick">');
    (d ? d.fields : []).filter(function (f) { return !f.hidden; }).forEach(function (f) {
      var on = chosen.some(function (x) { return x.key === f.key; });
      h.push('<label class="sv-chk' + (on ? ' on' : '') + '" data-f="' + escS(f.key) + '">' + escS(f.label) +
        '<span class="rp-dim"> ' + escS(f.type) + '</span></label>');
    });
    h.push('</div>');

    h.push('<h4 class="rp-h4">Calculated columns</h4>' +
      '<p class="rp-note">Write a formula with field names, numbers and <code>+ - * /</code>. ' +
      'Functions: <code>IF(test, then, else)</code>, <code>MIN</code>, <code>MAX</code>, <code>ROUND(x, places)</code>, <code>ABS</code>, ' +
      'and <code>SUM</code> / <code>AVERAGE</code> for a column total, so <code>t12_noi / SUM(t12_noi)</code> is each row\'s share. ' +
      'Missing data or a divide by zero shows ' + DASH + '. Start typing a name for suggestions.</p>');
    (dr.config.calculated || []).forEach(function (c, i) {
      h.push('<div class="sv-calc">' +
        '<div class="sv-fieldrow">' +
          '<input class="rp-inp" data-cl="' + i + '" value="' + escS(c.label || '') + '" placeholder="Column name" aria-label="Calculated column name">' +
          '<select class="rp-inp" data-cfmt="' + i + '" aria-label="Show as">' + opts(CALC_FORMATS, c.format || 'number') + '</select>' +
          '<button class="rp-btn" data-cx="' + i + '">Remove</button>' +
        '</div>' +
        '<div class="sv-formula"><span class="sv-eq" aria-hidden="true">=</span>' +
          '<textarea class="rp-inp sv-fbox" data-cf="' + i + '" rows="2" spellcheck="false" autocomplete="off" ' +
            'role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="svAc' + i + '" ' +
            'aria-label="Formula for ' + escS(c.label || 'calculated column') + '">' + escS(c.formula || '') + '</textarea>' +
          '<div class="sv-ac" id="svAc' + i + '" role="listbox"></div>' +
        '</div>' +
        '<div class="sv-fstat" data-cs="' + i + '" aria-live="polite">' + ((S.fstat[i] && S.fstat[i].formula === c.formula) ? S.fstat[i].html : '') + '</div>' +
      '</div>');
    });
    h.push('<button class="rp-btn" id="svAddCalc">Add calculated column</button>');
    return h.join('');
  }

  /* ---- builder: Style (G2) ---- */
  function seg(name, list, cur) {
    return '<span class="sv-seg" role="group">' + list.map(function (o) {
      var on = cur === o[0];
      return '<button class="sv-seg-b' + (on ? ' on' : '') + '" data-st="' + name + ':' + o[0] + '" aria-pressed="' + on + '">' + escS(o[1]) + '</button>';
    }).join('') + '</span>';
  }
  function styleStepHtml() {
    var dr = S.draft, st = dr.config.style = dr.config.style || {};
    var hd = st.header = st.header || {};
    var h = ['<h4 class="rp-h4">Look</h4>'];
    h.push('<div class="sv-fieldrow"><span class="rp-lbl">Density</span>' +
      seg('density', [['compact', 'Compact'], ['comfortable', 'Comfortable'], ['spacious', 'Spacious']], st.density || 'comfortable') + '</div>');
    h.push('<div class="sv-fieldrow"><span class="rp-lbl">Text size</span>' +
      seg('text_size', [['sm', 'Small'], ['md', 'Medium'], ['lg', 'Large']], st.text_size || 'md') + '</div>');
    h.push('<div class="sv-fieldrow"><span class="rp-lbl">Theme</span>' +
      seg('theme', [['auto', 'Follow the portal'], ['light', 'Light'], ['dark', 'Dark']], st.theme || 'auto') + '</div>');
    h.push('<div class="sv-fieldrow"><span class="rp-lbl">Accent</span><span class="sv-swatches" role="group" aria-label="Accent colour">' +
      ACCENTS.map(function (a) {
        var on = (st.accent || 'indigo') === a;
        return '<button class="sv-sw sv-acc-' + a + (on ? ' on' : '') + '" data-st="accent:' + a + '" aria-pressed="' + on + '" aria-label="' + a + '" title="' + a + '"></button>';
      }).join('') + '</span></div>');

    h.push('<h4 class="rp-h4">Colour rules</h4>' +
      '<p class="rp-note">Colour a cell, or its whole row, when a value meets a condition. The first matching rule wins. ' +
      'Percentages compare as fractions: 0.9 means 90%.</p>');
    var nums = numericChoices();
    (st.rules || []).forEach(function (r, i) {
      h.push('<div class="sv-fieldrow">' +
        '<select class="rp-inp" data-rf="' + i + '" aria-label="Field">' + opts(nums, r.field) + '</select>' +
        '<select class="rp-inp" data-ro="' + i + '" aria-label="Condition">' + opts(RULE_OPS, r.op) + '</select>' +
        '<input class="rp-inp sv-num" data-rv="' + i + '" inputmode="decimal" value="' + escS(r.value === null || r.value === undefined ? '' : r.value) + '" aria-label="Value"' +
          (r.op === 'is_empty' || r.op === 'not_empty' ? ' disabled' : '') + '>' +
        '<select class="rp-inp" data-rt="' + i + '" aria-label="Colour">' + opts(TONES, r.tone) + '</select>' +
        '<select class="rp-inp" data-rg="' + i + '" aria-label="Apply to">' + opts([['cell', 'the cell'], ['row', 'the whole row']], r.target || 'cell') + '</select>' +
        '<button class="rp-btn" data-rx="' + i + '">Remove</button></div>');
    });
    h.push('<button class="rp-btn" id="svAddRule"' + (nums.length ? '' : ' disabled') + '>Add colour rule</button>');

    if (dr.display_type === 'dashboard') {
      h.push('<h4 class="rp-h4">Tiles</h4><p class="rp-note">Each tile is one number over the rows the view returns. Drag or use the arrows to reorder.</p>');
      h.push('<ol class="sv-order">');
      (dr.config.layout || []).forEach(function (t, i) {
        if (t.type !== 'number') return;
        h.push('<li class="sv-ord sv-ord-tile" draggable="true" data-tord="' + i + '">' +
          '<span class="sv-grip" aria-hidden="true"></span>' +
          '<input class="rp-inp" data-tt="' + i + '" value="' + escS(t.title || '') + '" placeholder="Title" aria-label="Tile title">' +
          '<select class="rp-inp" data-tf="' + i + '" aria-label="Field">' + opts(nums, (t.fields || [])[0]) + '</select>' +
          '<select class="rp-inp" data-ta="' + i + '" aria-label="Summary">' +
            opts([['sum', 'Total'], ['avg', 'Average'], ['min', 'Lowest'], ['max', 'Highest'], ['count', 'Count of rows']], t.aggregate || 'sum') + '</select>' +
          seg('tsize' + i, [['S', 'S'], ['M', 'M'], ['L', 'L']], t.size || 'M') +
          '<select class="rp-inp" data-tc="' + i + '" aria-label="Tile accent">' +
            opts([['', 'No accent']].concat(ACCENTS.map(function (a) { return [a, a]; })), t.accent || '') + '</select>' +
          '<span class="sv-ord-btns">' +
            '<button class="rp-btn sv-ib" data-tup="' + i + '" aria-label="Move tile up"' + (i === 0 ? ' disabled' : '') + '>' + svgIcon('up') + '</button>' +
            '<button class="rp-btn sv-ib" data-tdn="' + i + '" aria-label="Move tile down">' + svgIcon('down') + '</button>' +
            '<button class="rp-btn sv-ib" data-trm="' + i + '" aria-label="Remove tile">' + svgIcon('x') + '</button>' +
          '</span></li>');
      });
      h.push('</ol><button class="rp-btn" id="svAddTile"' + (nums.length ? '' : ' disabled') + '>Add number tile</button>');
    }

    h.push('<h4 class="rp-h4">Printed header</h4>' +
      '<p class="rp-note">Printing or saving as PDF puts this above the view' +
      (dr.display_type === 'report' ? ', and a report shows it on screen too once it has a title' : '') + '.</p>' +
      '<div class="sv-fieldrow"><span class="rp-lbl">Title</span><input class="rp-inp sv-wide" data-hd="title" value="' + escS(hd.title || '') + '" placeholder="' + escS(dr.name || 'The view name') + '"></div>' +
      '<div class="sv-fieldrow"><span class="rp-lbl">Subtitle</span><input class="rp-inp sv-wide" data-hd="subtitle" value="' + escS(hd.subtitle || '') + '"></div>' +
      '<div class="sv-fieldrow"><span class="rp-lbl">Period</span><input class="rp-inp" type="date" data-hd="period_from" value="' + escS(hd.period_from || '') + '" aria-label="Period from">' +
        '<span class="rp-dim">to</span><input class="rp-inp" type="date" data-hd="period_to" value="' + escS(hd.period_to || '') + '" aria-label="Period to"></div>' +
      '<div class="sv-fieldrow"><label class="sv-cb"><input type="checkbox" data-hdc="show_logo"' + (hd.show_logo === false ? '' : ' checked') + '> Logo</label>' +
      '<label class="sv-cb"><input type="checkbox" data-hdc="show_date"' + (hd.show_date === false ? '' : ' checked') + '> Date it was run</label>' +
      '<label class="sv-cb"><input type="checkbox" data-hdc="show_filters"' + (hd.show_filters === false ? '' : ' checked') + '> The filters applied</label></div>');
    return h.join('');
  }

  /* Small inline icons in the portal's thin-line style; PortalIcons does not
     carry arrows or a cross. */
  function svgIcon(name) {
    var P = { up: '<path d="m4 10 4-4 4 4"/>', down: '<path d="m4 6 4 4 4-4"/>', x: '<path d="m4.5 4.5 7 7m0-7-7 7"/>' };
    return '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + P[name] + '</svg>';
  }

  /* ---- builder wiring for the two steps above ---- */
  function move(list, from, to) {
    if (to < 0 || to >= list.length || from === to) return;
    var x = list.splice(from, 1)[0];
    list.splice(to, 0, x);
  }
  function dragList(r, attr, getList) {
    var from = null;
    r.querySelectorAll('[' + attr + ']').forEach(function (li) {
      li.ondragstart = function (e) { from = Number(li.getAttribute(attr)); li.classList.add('dragging'); if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move'; };
      li.ondragend = function () { li.classList.remove('dragging'); };
      li.ondragover = function (e) { e.preventDefault(); li.classList.add('over'); };
      li.ondragleave = function () { li.classList.remove('over'); };
      li.ondrop = function (e) {
        e.preventDefault();
        if (from === null) return;
        move(getList(), from, Number(li.getAttribute(attr)));
        from = null; paint();
      };
    });
  }

  function wireFields(r) {
    var dr = S.draft;
    var list = function () { return dr.config.fields = dr.config.fields || []; };
    dragList(r, 'data-ord', list);
    r.querySelectorAll('[data-up]').forEach(function (b) { b.onclick = function () { var i = Number(b.getAttribute('data-up')); move(list(), i, i - 1); paint(); }; });
    r.querySelectorAll('[data-dn]').forEach(function (b) { b.onclick = function () { var i = Number(b.getAttribute('data-dn')); move(list(), i, i + 1); paint(); }; });
    r.querySelectorAll('[data-rm]').forEach(function (b) { b.onclick = function () { list().splice(Number(b.getAttribute('data-rm')), 1); paint(); }; });
    r.querySelectorAll('[data-rn]').forEach(function (e) { e.oninput = function () { list()[Number(e.getAttribute('data-rn'))].label = e.value || undefined; }; });
    r.querySelectorAll('[data-nf]').forEach(function (e) { e.onchange = function () { list()[Number(e.getAttribute('data-nf'))].format = e.value || undefined; }; });

    var calc = function () { return dr.config.calculated = dr.config.calculated || []; };
    var ab = r.querySelector('#svAddCalc');
    if (ab) ab.onclick = function () {
      var n = 1, used = calc().map(function (c) { return c.key; });
      while (used.indexOf('calc_' + n) >= 0) n++;
      calc().push({ key: 'calc_' + n, label: 'Calculated ' + n, formula: '', format: 'number' });
      list().push({ key: 'calc_' + n });
      paint();
      var ta = r.querySelector('[data-cf="' + (calc().length - 1) + '"]');
      if (ta) ta.focus();
    };
    r.querySelectorAll('[data-cx]').forEach(function (b) {
      b.onclick = function () {
        var i = Number(b.getAttribute('data-cx')), key = calc()[i].key;
        calc().splice(i, 1);
        dr.config.fields = list().filter(function (f) { return f.key !== key; });
        /* statuses are kept by position; shift the ones after the removed column */
        var next = {};
        Object.keys(S.fstat).forEach(function (k) { k = Number(k); if (k < i) next[k] = S.fstat[k]; else if (k > i) next[k - 1] = S.fstat[k]; });
        S.fstat = next;
        paint();
      };
    });
    r.querySelectorAll('[data-cl]').forEach(function (e) { e.oninput = function () { calc()[Number(e.getAttribute('data-cl'))].label = e.value; }; });
    r.querySelectorAll('[data-cfmt]').forEach(function (e) { e.onchange = function () { calc()[Number(e.getAttribute('data-cfmt'))].format = e.value; }; });
    r.querySelectorAll('[data-cf]').forEach(function (ta) { wireFormula(ta, Number(ta.getAttribute('data-cf'))); });
  }

  /* The formula box. Typing never repaints the builder (that would take the
     caret away); only the status line and the suggestion list under this
     one box are redrawn. */
  function wireFormula(ta, i) {
    var box = S.host.querySelector('#svAc' + i);
    var stat = S.host.querySelector('[data-cs="' + i + '"]');
    var items = [], sel = 0, timer = null, seq = 0;

    function token() {
      var pos = ta.selectionStart;
      var m = /[A-Za-z_][A-Za-z0-9_]*$/.exec(ta.value.slice(0, pos));
      return m ? { text: m[0], start: pos - m[0].length, end: pos } : null;
    }
    function candidates() {
      var out = numericChoices(i).map(function (c) { return { ins: c[0], label: c[1] }; });
      Object.keys(FN_HELP).forEach(function (fn) { out.push({ ins: fn + '(', label: FN_HELP[fn] }); });
      return out;
    }
    function close() { items = []; box.innerHTML = ''; box.classList.remove('open'); ta.setAttribute('aria-expanded', 'false'); ta.removeAttribute('aria-activedescendant'); }
    function draw() {
      box.innerHTML = items.map(function (c, k) {
        return '<div role="option" id="svAc' + i + '_' + k + '" class="sv-ac-i' + (k === sel ? ' on' : '') + '" data-k="' + k + '" aria-selected="' + (k === sel) + '">' +
          '<code>' + escS(c.ins) + '</code><span>' + escS(c.label) + '</span></div>';
      }).join('');
      box.classList.add('open');
      ta.setAttribute('aria-expanded', 'true');
      ta.setAttribute('aria-activedescendant', 'svAc' + i + '_' + sel);
      box.querySelectorAll('[data-k]').forEach(function (el) {
        /* mousedown, not click: a click would blur the box first and close
           the list before the choice registers */
        el.onmousedown = function (e) { e.preventDefault(); accept(Number(el.getAttribute('data-k'))); };
      });
    }
    function suggest() {
      var t = token();
      if (!t) return close();
      var q = t.text.toLowerCase();
      items = candidates().filter(function (c) {
        return c.ins.toLowerCase().indexOf(q) === 0 || c.label.toLowerCase().indexOf(q) >= 0;
      }).slice(0, 8);
      if (!items.length || (items.length === 1 && items[0].ins === t.text)) return close();
      sel = 0; draw();
    }
    function accept(k) {
      var t = token(), c = items[k];
      if (!t || !c) return close();
      ta.value = ta.value.slice(0, t.start) + c.ins + ta.value.slice(t.end);
      var p = t.start + c.ins.length;
      ta.setSelectionRange(p, p);
      close(); changed();
    }
    function changed() {
      S.draft.config.calculated[i].formula = ta.value;
      clearTimeout(timer);
      timer = setTimeout(check, 300);
    }
    function check() {
      var formula = ta.value, mine = ++seq, c = S.draft.config.calculated[i];
      if (!formula.trim()) { stat.innerHTML = ''; return; }
      api('/api/views/formula', { method: 'POST', body: JSON.stringify({
        dataset: S.draft.dataset_key, formula: formula,
        calculated: (S.draft.config.calculated || []).slice(0, i),
        grouped: !!(S.draft.config.aggregates && S.draft.config.aggregates.length),
      }) }).then(function (b) {
        if (mine !== seq) return;   // a newer keystroke has its own check in flight
        var html;
        if (!b.ok) {
          html = '<span class="sv-ferr">' + escS(b.error) + (b.position ? ' <span class="rp-dim">at character ' + (b.position + 1) + '</span>' : '') + '</span>';
        } else {
          var col = { type: c.format || 'number', field: { decimals: c.decimals }, format: null };
          html = '<span class="sv-fok">Valid.</span>' +
            (b.sample && b.sample.length
              ? '<table class="sv-sample"><tbody>' + b.sample.map(function (s) {
                  return '<tr><td>' + escS(s.label || '') + '</td><td class="r">' + fmtAs(s.value, col) + '</td></tr>';
                }).join('') + '</tbody></table>'
              : ' <span class="rp-dim">No rows with every field it reads, so no sample to show.</span>');
        }
        S.fstat[i] = { formula: formula, html: html };
        stat.innerHTML = html;
      }).catch(function (e) { if (mine === seq) stat.innerHTML = '<span class="sv-ferr">' + escS(e.message) + '</span>'; });
    }

    ta.oninput = function () { changed(); suggest(); };
    ta.onkeydown = function (e) {
      if (!items.length) return;
      if (e.key === 'ArrowDown') { sel = (sel + 1) % items.length; draw(); e.preventDefault(); }
      else if (e.key === 'ArrowUp') { sel = (sel - 1 + items.length) % items.length; draw(); e.preventDefault(); }
      else if (e.key === 'Enter' || e.key === 'Tab') { accept(sel); e.preventDefault(); }
      else if (e.key === 'Escape') { close(); e.preventDefault(); }
    };
    ta.onblur = close;
    var c0 = S.draft.config.calculated[i];
    if (c0.formula && !(S.fstat[i] && S.fstat[i].formula === c0.formula)) check();
  }

  function wireStyle(r) {
    var dr = S.draft, st = dr.config.style = dr.config.style || {};
    r.querySelectorAll('[data-st]').forEach(function (b) {
      b.onclick = function () {
        var p = b.getAttribute('data-st').split(':');
        var m = /^tsize(\d+)$/.exec(p[0]);
        if (m) dr.config.layout[Number(m[1])].size = p[1];
        else st[p[0]] = p[1];
        paint();
      };
    });
    var rules = function () { return st.rules = st.rules || []; };
    var add = r.querySelector('#svAddRule');
    if (add) add.onclick = function () {
      var nums = numericChoices();
      rules().push({ field: nums[0][0], op: 'lt', value: 0, tone: 'bad', target: 'cell' });
      paint();
    };
    r.querySelectorAll('[data-rx]').forEach(function (b) { b.onclick = function () { rules().splice(Number(b.getAttribute('data-rx')), 1); paint(); }; });
    r.querySelectorAll('[data-rf]').forEach(function (e) { e.onchange = function () { rules()[Number(e.getAttribute('data-rf'))].field = e.value; }; });
    r.querySelectorAll('[data-ro]').forEach(function (e) { e.onchange = function () { rules()[Number(e.getAttribute('data-ro'))].op = e.value; paint(); }; });
    r.querySelectorAll('[data-rv]').forEach(function (e) { e.oninput = function () { rules()[Number(e.getAttribute('data-rv'))].value = e.value === '' ? null : Number(e.value); }; });
    r.querySelectorAll('[data-rt]').forEach(function (e) { e.onchange = function () { rules()[Number(e.getAttribute('data-rt'))].tone = e.value; }; });
    r.querySelectorAll('[data-rg]').forEach(function (e) { e.onchange = function () { rules()[Number(e.getAttribute('data-rg'))].target = e.value; }; });

    var hd = st.header = st.header || {};
    r.querySelectorAll('[data-hd]').forEach(function (e) { e.oninput = function () { hd[e.getAttribute('data-hd')] = e.value; }; });
    r.querySelectorAll('[data-hdc]').forEach(function (e) { e.onchange = function () { hd[e.getAttribute('data-hdc')] = e.checked; }; });

    var tiles = function () { return dr.config.layout = dr.config.layout || []; };
    dragList(r, 'data-tord', tiles);
    var at = r.querySelector('#svAddTile');
    if (at) at.onclick = function () {
      var nums = numericChoices();
      tiles().push({ type: 'number', title: '', fields: [nums[0][0]], aggregate: 'sum', size: 'M' });
      paint();
    };
    r.querySelectorAll('[data-tup]').forEach(function (b) { b.onclick = function () { var i = Number(b.getAttribute('data-tup')); move(tiles(), i, i - 1); paint(); }; });
    r.querySelectorAll('[data-tdn]').forEach(function (b) { b.onclick = function () { var i = Number(b.getAttribute('data-tdn')); move(tiles(), i, i + 1); paint(); }; });
    r.querySelectorAll('[data-trm]').forEach(function (b) { b.onclick = function () { tiles().splice(Number(b.getAttribute('data-trm')), 1); paint(); }; });
    r.querySelectorAll('[data-tt]').forEach(function (e) { e.oninput = function () { tiles()[Number(e.getAttribute('data-tt'))].title = e.value; }; });
    r.querySelectorAll('[data-tf]').forEach(function (e) { e.onchange = function () { tiles()[Number(e.getAttribute('data-tf'))].fields = [e.value]; }; });
    r.querySelectorAll('[data-ta]').forEach(function (e) { e.onchange = function () { tiles()[Number(e.getAttribute('data-ta'))].aggregate = e.value; }; });
    r.querySelectorAll('[data-tc]').forEach(function (e) { e.onchange = function () { tiles()[Number(e.getAttribute('data-tc'))].accent = e.value || undefined; }; });
  }

  /* Column resizing on the preview. The width lands in the draft's field
     list, materialising it from the dataset defaults if the person never
     chose fields, so the saved view keeps exactly the columns they saw. */
  function wireResize(r) {
    r.querySelectorAll('[data-rsz]').forEach(function (h) {
      h.onpointerdown = function (e) {
        e.preventDefault();
        var th = h.parentNode, key = h.getAttribute('data-rsz');
        var x0 = e.clientX, w0 = th.getBoundingClientRect().width, w = w0;
        h.setPointerCapture(e.pointerId);
        th.classList.add('sizing');
        h.onpointermove = function (ev) {
          w = Math.max(60, Math.min(600, Math.round(w0 + ev.clientX - x0)));
          th.style.width = th.style.minWidth = w + 'px';
        };
        h.onpointerup = function () {
          h.onpointermove = h.onpointerup = null;
          th.classList.remove('sizing');
          var fields = S.draft.config.fields;
          if (!fields || !fields.length) {
            fields = S.draft.config.fields = cols(draftView()).map(function (c) { return { key: c.key }; });
          }
          var f = fields.filter(function (x) { return x.key === key; })[0];
          if (f) f.width = w;
        };
      };
    });
  }

  /* ---- paint + wire ---- */
  function paint() {
    if (!S.host) return;
    var body;
    if (S.error) body = '<div class="rp-err">' + escS(S.error) + '</div>';
    else if (!S.datasets) body = '<div class="rp-empty">Loading…</div>';
    else if (S.mode === 'builder') body = builderHtml();
    else if (S.mode === 'view') body = viewHtml();
    else body = listHtml();
    S.host.innerHTML = body;
    wire();
  }

  function wire() {
    var r = S.host;
    if (!r) return;
    var on = function (sel, fn) { var e = r.querySelector(sel); if (e) e.onclick = fn; };

    on('#svNew', function () {
      S.draft = { dataset_key: 'property_summary', display_type: 'spreadsheet', name: '', description: '',
                  config: { fields: [], filters: [], sort: [], calculated: [], style: {} } };
      S.fstat = {};
      S.step = 1; S.mode = 'builder'; S.data = null; paint();
    });
    on('#svBack', function () { S.mode = 'list'; S.view = null; S.data = null; S.draft = null; load(); });
    on('#svEdit', function () {
      S.draft = { id: S.view.id, dataset_key: S.view.dataset_key, display_type: S.view.display_type,
                  name: S.view.name, description: S.view.description, config: S.view.config || {} };
      S.step = 3; S.mode = 'builder'; S.data = null; S.fstat = {}; paint();
    });
    on('#svShare', function () {
      S.draft = { id: S.view.id, dataset_key: S.view.dataset_key, display_type: S.view.display_type,
                  name: S.view.name, description: S.view.description, config: S.view.config || {} };
      S.step = 9; S.mode = 'builder';
      api('/api/views/' + S.view.id + '/shares').then(function (b) { S.shares = b; paint(); })
        .catch(function (e) { S.error = e.message; paint(); });
      paint();
    });
    on('#svDelete', function () {
      if (!window.confirm('Delete "' + S.view.name + '"? It is removed from everyone it was shared with.')) return;
      api('/api/views/' + S.view.id, { method: 'DELETE' })
        .then(function () { S.mode = 'list'; S.view = null; load(); })
        .catch(function (e) { S.error = e.message; paint(); });
    });
    on('#svPrint', function () { window.print(); });
    on('#svCsv', function () { exportCsv(); });
    on('#svPrev', function () { if (S.page > 1) { S.page--; loadData(); } });
    on('#svNext', function () { S.page++; loadData(); });

    r.querySelectorAll('[data-open]').forEach(function (b) {
      b.onclick = function () { openView(b.getAttribute('data-open')); };
    });
    r.querySelectorAll('[data-step]').forEach(function (b) {
      b.onclick = function () { gotoStep(Number(b.getAttribute('data-step'))); };
    });
    on('#svNextStep', function () { gotoStep(S.step + 1); });
    on('#svPrevStep', function () { gotoStep(S.step - 1); });

    r.querySelectorAll('[data-ds]').forEach(function (b) {
      b.onclick = function () {
        S.draft.dataset_key = b.getAttribute('data-ds');
        S.draft.config = { fields: [], filters: [], sort: [], calculated: [], style: {} };
        S.fstat = {}; paint();
      };
    });
    r.querySelectorAll('[data-dt]').forEach(function (b) {
      b.onclick = function () { S.draft.display_type = b.getAttribute('data-dt'); paint(); };
    });
    r.querySelectorAll('[data-f]').forEach(function (b) {
      b.onclick = function () {
        var k = b.getAttribute('data-f');
        var list = S.draft.config.fields = S.draft.config.fields || [];
        var i = list.findIndex(function (x) { return x.key === k; });
        if (i >= 0) list.splice(i, 1); else list.push({ key: k });
        paint();
      };
    });
    on('#svAddFilter', function () {
      S.draft.config.filters = S.draft.config.filters || [];
      var d = ds(S.draft.dataset_key);
      S.draft.config.filters.push({ field: d && d.fields.length ? d.fields[0].key : '', op: 'eq', value: '' });
      paint();
    });
    r.querySelectorAll('[data-fx]').forEach(function (b) {
      b.onclick = function () { S.draft.config.filters.splice(Number(b.getAttribute('data-fx')), 1); paint(); };
    });
    ['fw', 'fo', 'fv'].forEach(function (kind) {
      r.querySelectorAll('[data-' + kind + ']').forEach(function (e) {
        e.onchange = function () {
          var i = Number(e.getAttribute('data-' + kind));
          var f = S.draft.config.filters[i];
          if (kind === 'fw') f.field = e.value;
          else if (kind === 'fo') f.op = e.value;
          else f.value = e.value.indexOf(',') >= 0 ? e.value.split(',').map(function (s) { return s.trim(); }) : e.value;
        };
      });
    });
    var sf = r.querySelector('#svSortF'), sd = r.querySelector('#svSortD');
    if (sf) sf.onchange = function () { S.draft.config.sort = sf.value ? [{ field: sf.value, dir: sd ? sd.value : 'asc' }] : []; };
    if (sd) sd.onchange = function () { if (sf && sf.value) S.draft.config.sort = [{ field: sf.value, dir: sd.value }]; };
    var g = r.querySelector('#svGroup');
    if (g) g.onchange = function () { S.draft.config.group_by = g.value ? [g.value] : []; };

    var nm = r.querySelector('#svName'); if (nm) nm.oninput = function () { S.draft.name = nm.value; };
    var de = r.querySelector('#svDesc'); if (de) de.oninput = function () { S.draft.description = de.value; };
    on('#svSave', function () { save(); });

    r.querySelectorAll('[data-share]').forEach(function (b) {
      b.onclick = function () {
        var parts = b.getAttribute('data-share').split(':');
        var list = S.shares.shares = S.shares.shares || [];
        var i = list.findIndex(function (s) { return s.principal_type === parts[0] && s.principal_id === parts[1]; });
        var permEl = r.querySelector('#svPerm');
        if (i >= 0) list.splice(i, 1);
        else list.push({ principal_type: parts[0], principal_id: parts[1], permission: permEl ? permEl.value : 'viewer' });
        paint();
      };
    });
    if (S.mode === 'builder' && S.step === 3) wireFields(r);
    if (S.mode === 'builder' && S.step === 6) wireStyle(r);
    wireResize(r);

    on('#svSaveShares', function () {
      api('/api/views/' + S.draft.id + '/shares', { method: 'PUT', body: JSON.stringify({ shares: S.shares.shares || [] }) })
        .then(function () { S.mode = 'list'; load(); })
        .catch(function (e) { S.error = e.message; paint(); });
    });
  }

  function gotoStep(n) {
    if (n < 1 || n > STEPS.length) return;
    S.step = n;
    if (n === 7) { S.data = null; paint(); previewLoad(); return; }
    if (n === 9 && S.draft.id && !S.shares) {
      api('/api/views/' + S.draft.id + '/shares').then(function (b) { S.shares = b; paint(); })
        .catch(function (e) { S.error = e.message; paint(); });
    }
    paint();
  }

  /* The preview runs the real query through a throwaway POST-free path: the
     draft is sent as a saved view only when the person saves. Until then the
     preview reads the dataset directly with the same validation. */
  function previewLoad() {
    var d = S.draft;
    var qs = '?dataset=' + encodeURIComponent(d.dataset_key) +
             '&config=' + encodeURIComponent(JSON.stringify(d.config)) +
             /* a dashboard totals the rows it is given, so it gets a full page */
             '&per_page=' + (d.display_type === 'dashboard' ? 200 : 50);
    api('/api/views/preview' + qs)
      .then(function (b) { S.data = b; S.problems = b.problems || []; paint(); })
      .catch(function (e) { S.error = e.message; paint(); });
  }

  function save() {
    var d = S.draft;
    if (!d.name) { S.error = 'Give the view a name first.'; paint(); return; }
    var body = JSON.stringify({ name: d.name, description: d.description, dataset_key: d.dataset_key,
                                display_type: d.display_type, config: d.config });
    var p = d.id ? api('/api/views/' + d.id, { method: 'PUT', body: body })
                 : api('/api/views', { method: 'POST', body: body });
    p.then(function (b) { S.draft.id = b.view.id; S.shares = null; gotoStep(9); })
     .catch(function (e) { S.error = e.message; paint(); });
  }

  function exportCsv() {
    var v = S.view || { config: S.draft.config, dataset_key: S.draft.dataset_key };
    var c = cols(v), d = S.data || { rows: [] };
    var lines = [c.map(function (x) { return x.label; })];
    (d.rows || []).forEach(function (row) { lines.push(c.map(function (x) { return row[x.key]; })); });
    var text = lines.map(function (r) {
      return r.map(function (cell) {
        var s = cell === null || cell === undefined ? '' : String(cell);
        return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
      }).join(',');
    }).join('\n');
    var b = new Blob([text], { type: 'text/csv;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(b); a.download = ((S.view && S.view.name) || 'view') + '.csv';
    document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 0);
  }

  function openView(id) {
    S.mode = 'view'; S.page = 1; S.view = null; S.data = null; paint();
    api('/api/views/' + id).then(function (b) {
      S.view = b.view; S.perm = b.permission; S.problems = b.problems || [];
      paint(); loadData();
    }).catch(function (e) { S.error = e.message; paint(); });
  }

  function loadData() {
    if (!S.view) return;
    api('/api/views/' + S.view.id + '/data?page=' + S.page)
      .then(function (b) { S.data = b; S.problems = b.problems || S.problems; paint(); })
      .catch(function (e) { S.error = e.message; paint(); });
  }

  function load() {
    S.error = null;
    var jobs = [];
    if (!S.datasets) jobs.push(api('/api/datasets').then(function (b) { S.datasets = b.datasets; }));
    jobs.push(api('/api/views').then(function (b) { S.views = b.views; }));
    Promise.all(jobs).then(paint).catch(function (e) { S.error = e.message; paint(); });
  }

  function mount(host) {
    S.host = host;
    if (!host) return;
    S.mode = 'list'; S.view = null; S.draft = null; S.data = null;
    paint(); load();
  }

  function invalidate() { S.views = null; if (S.host) load(); }

  window.PortalViews = { mount: mount, invalidate: invalidate, _state: S };
})();
