/* ===========================================================================
   portal-sheet.js — the Custom view spreadsheet on screen (window.PortalSheet).

   The engine (formulas, references, totals) is sheet-core.js; this file is
   the grid you click and type in. portal-props.js renders it inside a view
   with html(ctx) and saves the view when onChange() is called.

   What it does, as a spreadsheet does:
     select a cell, a range (drag or Shift), a whole column or row; arrows,
     Tab, Enter, Home/End, Ctrl+A; type or F2 / double-click to edit; Enter
     commits; Esc cancels; Delete clears; Ctrl+C / Ctrl+V copy and paste
     (tab-separated, so Excel and Google Sheets paste straight in); Ctrl+Z /
     Ctrl+Y undo and redo; while typing a formula, clicking or dragging over
     cells writes their address; drag a column's or row's edge to resize it
     (double-click the edge to fit); sum / average / count of a selection.
   The view's data cells and Totals are read-only. People with edit rights
   add formula and input columns and use the rows under Total freely.
   =========================================================================== */
(function () {
  'use strict';
  var X = window.SheetCore;
  var H = null;       /* helpers from portal-props: esc, money, pct, ratio, cnt, paint */
  var SS = {};        /* per view: selection, edit, undo, local sizes, last grid */
  var ROW_H = 30, RN_W = 46, HEAD_H = 26;
  var FMTS = [['auto', 'Automatic'], ['money', 'Dollars'], ['number', 'Number'], ['pct', 'Percent'], ['ratio', 'Ratio'], ['text', 'Text']];

  function st(key) {
    return SS[key] || (SS[key] = { sel: { r: 1, c: 0, r2: 1, c2: 0 }, anchor: null, edit: null, undo: [], redo: [], msg: '',
      colW: {}, rowH: {}, grid: null, ctx: null, drag: null, pick: null, status: '' });
  }
  function esc(s) { return H.esc(s); }
  function isNum(v) { return typeof v === 'number' && isFinite(v); }

  /* ---- what a cell shows ----------------------------------------------- */
  function show(v, fmt) {
    if (X.isErr(v)) return v.err;
    if (v === null || v === undefined || v === '') return '';
    if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
    if (typeof v !== 'number') return String(v);
    switch (fmt) {
      case 'money': return H.money(v);
      case 'pct': return H.pct(v);
      case 'ratio': return H.ratio(v);
      case 'count': return H.cnt(v);
      case 'number': return v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      case 'text': return X.toStr(v);
      default: return v.toLocaleString('en-US', { maximumFractionDigits: Math.abs(v) < 1 && v !== 0 ? 4 : 2 });
    }
  }
  var DEF_W = { name: 220, field: 130, formula: 140, input: 140, spare: 110 };
  function colW(s, ctx, g, c) { var k = g.cols[c].key; return s.colW[k] || ctx.sheet.colW[k] || DEF_W[g.cols[c].kind] || 120; }
  function rowH(s, ctx, g, r) { var k = g.rowKey(r); return s.rowH[k] || ctx.sheet.rowH[k] || ROW_H; }
  function norm(sel) { return { r1: Math.min(sel.r, sel.r2), r2: Math.max(sel.r, sel.r2), c1: Math.min(sel.c, sel.c2), c2: Math.max(sel.c, sel.c2) }; }
  function clampSel(s, g) {
    var R = g.rowsN - 1, C = g.cols.length - 1, x = s.sel;
    x.r = Math.max(0, Math.min(R, x.r)); x.r2 = Math.max(0, Math.min(R, x.r2));
    x.c = Math.max(0, Math.min(C, x.c)); x.c2 = Math.max(0, Math.min(C, x.c2));
  }

  /* ---- render ----------------------------------------------------------- */
  /* ctx: { key, result, sheet, canEdit, height, onChange } */
  function html(ctx) {
    var s = st(ctx.key);
    var g = X.build({ heads: ctx.result.heads, rows: ctx.result.rows, totals: ctx.result.totals, sheet: ctx.sheet });
    s.grid = g; s.ctx = ctx;
    clampSel(s, g);
    var sel = norm(s.sel), a = s.sel, ed = s.edit;
    var activeRaw = ed ? ed.text : g.raw(a.r, a.c);
    var canEd = ctx.canEdit && g.editable(a.r, a.c);
    var aCol = g.cols[a.c];
    var widths = g.cols.map(function (x, c) { return colW(s, ctx, g, c); });
    var total = RN_W + widths.reduce(function (x, y) { return x + y; }, 0);

    var h = '<div class="sx-root" data-sxroot="' + esc(ctx.key) + '">';
    /* toolbar */
    h += '<div class="sx-bar">';
    if (ctx.canEdit) {
      h += '<button class="btn press" data-sxa="addf" title="A column whose formula fills every row">+ Formula column</button>' +
        '<button class="btn press" data-sxa="addi" title="A column you type values into, one per property">+ Input column</button>';
      if (aCol && aCol.id) h += '<button class="btn press" data-sxa="rmcol">Remove column ' + X.colName(a.c) + '</button>';
      var fmtable = (aCol && aCol.id) || a.r > g.T;
      var curF = aCol && aCol.id ? (aCol.fmt || 'auto') : g.fmtOf(a.r, a.c);
      h += '<label class="sx-lbl">Format <select class="sel" data-sxf' + (fmtable ? '' : ' disabled') + '>' +
        FMTS.map(function (f) { return '<option value="' + f[0] + '"' + (curF === f[0] ? ' selected' : '') + '>' + f[1] + '</option>'; }).join('') + '</select></label>';
      var sortable = aCol && (aCol.kind === 'name' || aCol.kind === 'field' || aCol.kind === 'input');
      h += '<span class="sx-grp"><button class="btn press" data-sxa="sort:asc"' + (sortable ? '' : ' disabled') + ' title="Sort the properties by column ' + X.colName(a.c) + '">Sort A→Z</button>' +
        '<button class="btn press" data-sxa="sort:desc"' + (sortable ? '' : ' disabled') + '>Z→A</button>' +
        (ctx.sheet.sort ? '<button class="link" data-sxa="sort:none">Clear sort</button>' : '') + '</span>';
      h += '<span class="sx-grp"><button class="btn press" data-sxa="undo"' + (s.undo.length ? '' : ' disabled') + ' title="Undo (Ctrl+Z)">Undo</button>' +
        '<button class="btn press" data-sxa="redo"' + (s.redo.length ? '' : ' disabled') + ' title="Redo (Ctrl+Y)">Redo</button></span>';
    }
    h += '<span class="sx-save">' + esc(ctx.saveText || '') + '</span>' +
      '<details class="sx-help"><summary>Formula help</summary><div class="sx-help-b">' +
      '<p>Start with <b>=</b>. Use cell addresses (<b>D2</b>, <b>$D$2</b>), ranges (<b>D2:D9</b>) and whole columns (<b>D:D</b>, the property rows only). ' +
      'Operators: + − * / ^ % &amp; and comparisons (= &lt;&gt; &lt; &gt; &lt;= &gt;=). While typing a formula, click or drag over cells to add their address.</p>' +
      '<p>A formula typed in any property row of a formula column fills the whole column; its Total is the same formula over the totals. ' +
      'Input columns take a value per property. The rows under Total are free for any value or formula.</p>' +
      '<p>Functions: ' + X.FUNCTIONS.join(', ') + '.</p></div></details></div>';

    /* formula bar */
    h += '<div class="sx-fx"><span class="sx-addr">' + (sel.r1 === sel.r2 && sel.c1 === sel.c2 ? X.addr(a.r, a.c) : X.addr(sel.r1, sel.c1) + ':' + X.addr(sel.r2, sel.c2)) + '</span>' +
      '<span class="sx-fxi">fx</span><input class="sx-fxin" data-sxbar aria-label="Contents of ' + X.addr(a.r, a.c) + '" value="' + esc(activeRaw === null || activeRaw === undefined ? '' : activeRaw) + '"' +
      (canEd ? '' : ' readonly') + ' spellcheck="false" autocomplete="off"></div>';

    /* grid */
    var hpx = ctx.height ? 'height:' + ctx.height + 'px' : 'max-height:640px';
    h += '<div class="sx-wrap frame" tabindex="0" data-sxgrid="' + esc(ctx.key) + '" style="' + hpx + '" aria-label="Spreadsheet" role="grid">' +
      '<table class="sx" style="width:' + total + 'px"><colgroup><col style="width:' + RN_W + 'px">' +
      widths.map(function (w, c) { return '<col data-sxw="' + c + '" style="width:' + w + 'px">'; }).join('') + '</colgroup>' +
      '<thead><tr><th class="sx-corner" data-sxall title="Select everything"></th>' +
      g.cols.map(function (x, c) {
        var on = c >= sel.c1 && c <= sel.c2;
        return '<th class="sx-cl' + (on ? ' on' : '') + '" data-sxcolh="' + c + '">' + X.colName(c) + '<span class="sx-cr" data-sxcol="' + c + '" title="Drag to resize; double-click to fit"></span></th>';
      }).join('') + '</tr></thead><tbody>';
    for (var r = 0; r < g.rowsN; r++) {
      var rk = r === 0 ? 'hdr' : r <= g.n ? 'dat' : r === g.T ? 'tot' : 'free';
      var ron = r >= sel.r1 && r <= sel.r2;
      h += '<tr class="sx-' + rk + '" style="height:' + rowH(s, ctx, g, r) + 'px"><th class="sx-rn' + (ron ? ' on' : '') + '" data-sxrowh="' + r + '">' + (r + 1) +
        '<span class="sx-rr" data-sxrow="' + r + '" title="Drag to resize; double-click to reset"></span></th>';
      for (var c = 0; c < g.cols.length; c++) {
        var inSel = ron && c >= sel.c1 && c <= sel.c2, act = r === a.r && c === a.c;
        var editing = ed && ed.where === 'cell' && ed.r === r && ed.c === c;
        var v = editing ? null : g.value(r, c), f = g.fmtOf(r, c);
        var txt = editing ? '' : show(v, f);
        var cls = 'sx-c' + (inSel ? ' sel' : '') + (act ? ' act' : '') + (isNum(v) && f !== 'text' ? ' n' : '') + (X.isErr(v) ? ' err' : '') +
          (ctx.canEdit && g.editable(r, c) && r !== 0 && r <= g.n ? ' inp' : '') + (c === 0 ? ' c0' : '') + (isNum(v) && v < 0 && f !== 'text' ? ' neg' : '');
        var tip = X.isErr(v) ? ' title="' + esc(g.errorOf(r, c) || errHelp(v.err)) + '"' : '';
        h += '<td class="' + cls + '" data-sx="' + r + ':' + c + '"' + tip + '>' +
          (editing ? '<input class="sx-in" data-sxin value="' + esc(ed.text) + '" spellcheck="false" autocomplete="off" aria-label="Edit ' + X.addr(r, c) + '">' : esc(txt)) + '</td>';
      }
      h += '</tr>';
    }
    h += '</tbody></table></div>';

    /* status: what the selection adds up to */
    h += '<div class="sx-status">' + esc(statusText(g, sel)) + (s.msg ? '<span class="sx-msg">' + esc(s.msg) + '</span>' : '') + '</div></div>';
    return h;
  }
  function errHelp(e) {
    return { '#DIV/0!': 'Division by zero.', '#REF!': 'The formula points at a cell or column that is no longer there.', '#NAME?': 'An unknown function or name.',
             '#VALUE!': 'A value of the wrong kind, e.g. text where a number is needed.', '#N/A': 'Not found.', '#NUM!': 'No numeric answer.',
             '#CIRC!': 'The formula depends on its own cell.', '#ERROR!': 'The formula cannot be read.' }[e] || '';
  }
  function statusText(g, sel) {
    var ns = [], k = 0;
    for (var r = sel.r1; r <= sel.r2; r++) for (var c = sel.c1; c <= sel.c2; c++) {
      var v = g.value(r, c); if (v !== null && v !== '') k++;
      if (isNum(v) && r !== 0) ns.push(v);
    }
    if ((sel.r1 === sel.r2 && sel.c1 === sel.c2) || !ns.length) return k > 1 ? 'Count ' + k : '';
    var s = ns.reduce(function (x, y) { return x + y; }, 0);
    var f = g.fmtOf(sel.r1 === 0 ? 1 : sel.r1, sel.c1); f = f === 'count' ? 'auto' : f;
    return 'Sum ' + show(s, f) + '   Average ' + show(s / ns.length, f) + '   Count ' + k + '   Min ' + show(Math.min.apply(null, ns), f) + '   Max ' + show(Math.max.apply(null, ns), f);
  }

  /* ---- changes ---------------------------------------------------------- */
  function snapshot(s) { s.undo.push(JSON.stringify(s.ctx.sheet)); if (s.undo.length > 100) s.undo.shift(); s.redo = []; }
  function restore(target, json) {
    var o = JSON.parse(json);
    Object.keys(target).forEach(function (k) { delete target[k]; });
    Object.keys(o).forEach(function (k) { target[k] = o[k]; });
  }
  function changed(s) { s.ctx.onChange(); H.paint(); }
  function commit(s, move) {
    var e = s.edit; if (!e) return;
    s.edit = null;
    var g = s.grid, before = JSON.stringify(s.ctx.sheet);
    var text = e.text;
    var cur = g.raw(e.r, e.c);
    if ((cur === null || cur === undefined ? '' : String(cur)) === text) { s.msg = ''; moveBy(s, move); H.paint(); return; }
    var msg = X.write(s.ctx.sheet, g, e.r, e.c, text);
    if (msg) { s.msg = msg; H.paint(); return; }
    s.undo.push(before); if (s.undo.length > 100) s.undo.shift(); s.redo = [];
    s.msg = '';
    moveBy(s, move);
    changed(s);
  }
  function moveBy(s, m) {
    if (!m) return;
    s.sel.r += m[0]; s.sel.c += m[1]; s.sel.r2 = s.sel.r; s.sel.c2 = s.sel.c; clampSel(s, s.grid);
  }
  function startEdit(s, text, where) {
    var a = s.sel, g = s.grid;
    if (!s.ctx.canEdit) { s.msg = 'You can view this sheet but not change it.'; H.paint(); return false; }
    if (!g.editable(a.r, a.c)) {
      s.msg = a.r === g.T ? 'Totals are worked out for you.' : a.r === 0 ? 'Only added columns can be renamed.'
        : 'This cell comes from the data. Add a column, or use the rows under Total, to calculate with it.';
      H.paint(); return false;
    }
    var raw = g.raw(a.r, a.c);
    s.edit = { r: a.r, c: a.c, text: text !== undefined ? text : raw === null || raw === undefined ? '' : String(raw), where: where || 'cell' };
    s.msg = '';
    H.paint();
    /* paint is synchronous: move the caret into the box now, so the next
       keystroke of someone typing fast lands in it, not on the grid */
    focusEdit(s);
    return true;
  }
  function focusEdit(s) {
    var root = rootOf(s); if (!root) return;
    var inp = s.edit && s.edit.where === 'cell' ? root.querySelector('[data-sxin]') : root.querySelector('[data-sxbar]');
    if (!inp) return;
    /* called only after the sheet itself changed the text (an edit opening, a
       clicked address, a key that arrived early). Once typed in, a box ignores
       its value attribute, so set the text itself; the caret goes to the end. */
    if (s.edit && inp.value !== s.edit.text) inp.value = s.edit.text;
    if (document.activeElement !== inp) inp.focus();
    var L = inp.value.length; try { inp.setSelectionRange(L, L); } catch (e) { /* ignore */ }
  }
  function rootOf(s) { return document.querySelector('[data-sxroot="' + (window.CSS && CSS.escape ? CSS.escape(s.ctx.key) : s.ctx.key) + '"]'); }
  function focusGrid(s) { var root = rootOf(s); var w = root && root.querySelector('[data-sxgrid]'); if (w && document.activeElement !== w) w.focus({ preventScroll: true }); }
  function scrollActive(s) {
    var root = rootOf(s); if (!root) return;
    var td = root.querySelector('td[data-sx="' + s.sel.r + ':' + s.sel.c + '"]'), w = root.querySelector('[data-sxgrid]');
    if (!td || !w) return;
    var t = td.offsetTop, b = t + td.offsetHeight, l = td.offsetLeft, rr = l + td.offsetWidth;
    var top = HEAD_H + (s.sel.r > 0 ? rowH(s, s.ctx, s.grid, 0) : 0), left = RN_W + (s.sel.c > 0 ? colW(s, s.ctx, s.grid, 0) : 0);
    if (t - top < w.scrollTop) w.scrollTop = t - top; else if (b > w.scrollTop + w.clientHeight) w.scrollTop = b - w.clientHeight;
    if (l - left < w.scrollLeft) w.scrollLeft = l - left; else if (rr > w.scrollLeft + w.clientWidth) w.scrollLeft = rr - w.clientWidth;
  }
  function clearSel(s) {
    var g = s.grid, sel = norm(s.sel), before = JSON.stringify(s.ctx.sheet), n = 0, refused = 0;
    if (!s.ctx.canEdit) return;
    for (var r = sel.r1; r <= sel.r2; r++) for (var c = sel.c1; c <= sel.c2; c++) {
      if (r === 0) continue;
      if (!g.editable(r, c)) { if (g.raw(r, c) !== null && g.raw(r, c) !== '') refused++; continue; }
      var raw = g.raw(r, c);
      if (raw === null || raw === undefined || raw === '') continue;
      X.write(s.ctx.sheet, g, r, c, ''); n++;
    }
    s.msg = refused && !n ? 'Data cells and totals cannot be cleared.' : '';
    if (n) { s.undo.push(before); s.redo = []; changed(s); } else H.paint();
  }
  function selText(s) {
    var g = s.grid, sel = norm(s.sel), lines = [];
    for (var r = sel.r1; r <= sel.r2; r++) {
      var cells = [];
      for (var c = sel.c1; c <= sel.c2; c++) {
        var v = g.value(r, c);
        cells.push(X.isErr(v) ? v.err : v === null || v === undefined ? '' : typeof v === 'number' ? String(Math.round(v * 1e8) / 1e8) : typeof v === 'boolean' ? (v ? 'TRUE' : 'FALSE') : String(v).replace(/[\t\n\r]/g, ' '));
      }
      lines.push(cells.join('\t'));
    }
    return lines.join('\n');
  }
  function paste(s, text) {
    if (!s.ctx.canEdit) { s.msg = 'You can view this sheet but not change it.'; H.paint(); return; }
    var g = s.grid, rows = String(text).replace(/\r\n?/g, '\n').replace(/\n$/, '').split('\n').map(function (l) { return l.split('\t'); });
    var before = JSON.stringify(s.ctx.sheet), n = 0, skip = 0;
    rows.forEach(function (row, i) {
      row.forEach(function (val, j) {
        var r = s.sel.r + i, c = s.sel.c + j;
        if (r >= g.rowsN || c >= g.cols.length || !g.editable(r, c)) { skip++; return; }
        if (X.write(s.ctx.sheet, g, r, c, val) === null) n++; else skip++;
      });
    });
    s.sel.r2 = Math.min(g.rowsN - 1, s.sel.r + rows.length - 1); s.sel.c2 = Math.min(g.cols.length - 1, s.sel.c + rows[0].length - 1);
    s.msg = skip ? skip + (skip === 1 ? ' cell was' : ' cells were') + ' not pasted: data cells and totals are read-only.' : '';
    if (n) { s.undo.push(before); s.redo = []; changed(s); } else H.paint();
  }
  function undo(s, redo) {
    var from = redo ? s.redo : s.undo, to = redo ? s.undo : s.redo;
    if (!from.length) return;
    to.push(JSON.stringify(s.ctx.sheet));
    restore(s.ctx.sheet, from.pop());
    s.edit = null; s.msg = '';
    changed(s);
  }
  function newId() { return 'k' + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36); }

  function act(s, a) {
    var g = s.grid, sh = s.ctx.sheet, col = g.cols[s.sel.c];
    if (a === 'undo') return undo(s, false);
    if (a === 'redo') return undo(s, true);
    if (!s.ctx.canEdit) return;
    if (a === 'addf' || a === 'addi') {
      if (sh.cols.length >= 20) { s.msg = 'A sheet holds up to 20 added columns.'; return H.paint(); }
      snapshot(s);
      sh.cols.push({ id: newId(), label: a === 'addf' ? 'Formula ' + (sh.cols.length + 1) : 'Input ' + (sh.cols.length + 1), kind: a === 'addf' ? 'formula' : 'input', fmt: 'auto', f: '', vals: {} });
      var c = 1 + g.F + sh.cols.length - 1;
      s.sel = { r: 1, c: c, r2: 1, c2: c };
      s.msg = a === 'addf' ? 'Type a formula in any property row, e.g. =' + X.colName(Math.min(2, c - 1)) + '2*2. It fills the whole column. Click the header to rename it.'
                           : 'Type a value for each property. Click the header to rename the column.';
      return changed(s);
    }
    if (a === 'rmcol' && col && col.id) {
      if (!window.confirm('Remove column ' + X.colName(s.sel.c) + ' "' + col.label + '"? Formulas that use it will show #REF!.')) return;
      snapshot(s);
      sh.cols = sh.cols.filter(function (x) { return x.id !== col.id; });
      delete sh.colW[col.key];
      s.msg = '';
      return changed(s);
    }
    if (a.indexOf('sort:') === 0) {
      snapshot(s);
      var dir = a.slice(5);
      sh.sort = dir === 'none' ? null : { key: col.key, dir: dir };
      s.msg = '';
      return changed(s);
    }
  }
  function setFormat(s, f) {
    var g = s.grid, sh = s.ctx.sheet, col = g.cols[s.sel.c], sel = norm(s.sel);
    if (!s.ctx.canEdit) return;
    snapshot(s);
    if (col && col.id && s.sel.r <= g.T) { sh.cols.forEach(function (x) { if (x.id === col.id) x.fmt = f; }); return changed(s); }
    for (var r = Math.max(sel.r1, g.T + 1); r <= sel.r2; r++) for (var c = sel.c1; c <= sel.c2; c++) {
      var k = (r - g.T) + '|' + g.cols[c].key;
      if (f === 'auto') { if (sh.cells[k]) { delete sh.cells[k].fmt; if (!sh.cells[k].v) delete sh.cells[k]; } }
      else sh.cells[k] = Object.assign({ v: '' }, sh.cells[k] || {}, { fmt: f });
    }
    changed(s);
  }

  /* ---- events (bound once on the section's host) ------------------------ */
  function cellAt(t) { var td = t.closest && t.closest('td[data-sx]'); if (!td) return null; var p = td.getAttribute('data-sx').split(':'); return { r: +p[0], c: +p[1] }; }
  function sheetOf(t) { var root = t.closest && t.closest('[data-sxroot]'); return root ? SS[root.getAttribute('data-sxroot')] || null : null; }
  /* while typing a formula, a click on a cell writes its address into it */
  function picking(s) {
    var e = s.edit; if (!e || e.text.charAt(0) !== '=') return false;
    var t = e.text.replace(/\s+$/, '');
    return /[=(+\-*/^,:&<>]$/.test(t) || !!s.pick;
  }
  function pickRef(s, r1, c1, r2, c2) {
    var ref = r1 === r2 && c1 === c2 ? X.addr(r1, c1) : X.addr(Math.min(r1, r2), Math.min(c1, c2)) + ':' + X.addr(Math.max(r1, r2), Math.max(c1, c2));
    var e = s.edit;
    if (!s.pick) s.pick = { at: e.text.length, len: 0, r: r1, c: c1 };
    e.text = e.text.slice(0, s.pick.at) + ref + e.text.slice(s.pick.at + s.pick.len);
    s.pick.len = ref.length;
  }

  function onMouseDown(ev) {
    var s = sheetOf(ev.target); if (!s || !s.grid) return;
    var t = ev.target;
    if (t.closest('[data-sxcol],[data-sxrow]')) return;           /* a resize, handled on pointerdown */
    if (t.matches('[data-sxin],[data-sxbar]')) return;
    var g = s.grid, cell = cellAt(t);
    var colH = t.closest('[data-sxcolh]'), rowHd = t.closest('[data-sxrowh]'), all = t.closest('[data-sxall]');
    if (!cell && !colH && !rowHd && !all) return;
    ev.preventDefault();
    if (cell && picking(s) && !(cell.r === s.edit.r && cell.c === s.edit.c)) {
      pickRef(s, cell.r, cell.c, cell.r, cell.c);
      s.drag = { pick: true, r: cell.r, c: cell.c };
      H.paint(); focusEdit(s);
      return;
    }
    if (s.edit) commit(s, null);
    s.pick = null;
    if (all) s.sel = { r: 0, c: 0, r2: g.rowsN - 1, c2: g.cols.length - 1 };
    else if (colH) { var c = +colH.getAttribute('data-sxcolh'); s.sel = ev.shiftKey ? { r: 0, c: s.sel.c, r2: g.rowsN - 1, c2: c } : { r: 0, c: c, r2: g.rowsN - 1, c2: c }; }
    else if (rowHd) { var r = +rowHd.getAttribute('data-sxrowh'); s.sel = ev.shiftKey ? { r: s.sel.r, c: 0, r2: r, c2: g.cols.length - 1 } : { r: r, c: 0, r2: r, c2: g.cols.length - 1 }; }
    else if (ev.shiftKey) { s.sel.r2 = cell.r; s.sel.c2 = cell.c; }
    else s.sel = { r: cell.r, c: cell.c, r2: cell.r, c2: cell.c };
    if (cell) s.drag = { r: cell.r, c: cell.c };
    s.msg = '';
    H.paint();
    focusGrid(s);
  }
  function onMouseOver(ev) {
    if (!(ev.buttons & 1)) return;
    var s = sheetOf(ev.target); if (!s || !s.drag) return;
    var cell = cellAt(ev.target); if (!cell) return;
    if (s.drag.pick) { if (!s.edit) return; pickRef(s, s.drag.r, s.drag.c, cell.r, cell.c); H.paint(); focusEdit(s); return; }
    if (s.sel.r2 === cell.r && s.sel.c2 === cell.c) return;
    s.sel.r2 = cell.r; s.sel.c2 = cell.c;
    H.paint();
  }
  function onMouseUp() { Object.keys(SS).forEach(function (k) { SS[k].drag = null; }); }
  function onDblClick(ev) {
    var s = sheetOf(ev.target); if (!s || !s.grid) return;
    var cr = ev.target.closest('[data-sxcol]'), rr = ev.target.closest('[data-sxrow]');
    if (cr) return fitCol(s, +cr.getAttribute('data-sxcol'));
    if (rr) return sizeRow(s, +rr.getAttribute('data-sxrow'), null);
    var cell = cellAt(ev.target); if (!cell || s.edit) return;
    s.sel = { r: cell.r, c: cell.c, r2: cell.r, c2: cell.c };
    startEdit(s);
  }
  function onKeyDown(ev) {
    var s = sheetOf(ev.target); if (!s || !s.grid) return;
    var t = ev.target, k = ev.key, mod = ev.ctrlKey || ev.metaKey;
    var inCell = t.matches('[data-sxin]'), inBar = t.matches('[data-sxbar]');
    if (inCell || inBar) {
      if (inBar && !s.edit) {
        if (k === 'Enter' || k === 'Escape' || k === 'Tab') { if (k !== 'Tab') { ev.preventDefault(); focusGrid(s); } }
        return;
      }
      if (k === 'Enter') { ev.preventDefault(); s.pick = null; commit(s, [ev.shiftKey ? -1 : 1, 0]); scrollSoon(s); return; }
      if (k === 'Tab') { ev.preventDefault(); s.pick = null; commit(s, [0, ev.shiftKey ? -1 : 1]); scrollSoon(s); return; }
      if (k === 'Escape') { ev.preventDefault(); s.edit = null; s.pick = null; s.msg = ''; H.paint(); focusGrid(s); return; }
      s.pick = null;
      return;
    }
    if (!t.matches('[data-sxgrid]')) return;
    /* a key that arrives while an edit is opening belongs to the edit */
    if (s.edit) {
      if (!mod && !ev.altKey && k.length === 1) { ev.preventDefault(); s.edit.text += k; H.paint(); focusEdit(s); }
      return;
    }
    var g = s.grid, a = s.sel, R = g.rowsN - 1, C = g.cols.length - 1;
    var move = function (dr, dc, extend) {
      var r = (extend ? a.r2 : a.r), c = (extend ? a.c2 : a.c);
      if (mod) { r = dr ? (dr > 0 ? (r < g.n ? g.n : R) : (r > 1 ? 1 : 0)) : r; c = dc ? (dc > 0 ? C : 0) : c; }
      else { r += dr; c += dc; }
      r = Math.max(0, Math.min(R, r)); c = Math.max(0, Math.min(C, c));
      if (extend) { a.r2 = r; a.c2 = c; } else s.sel = { r: r, c: c, r2: r, c2: c };
      s.msg = ''; ev.preventDefault(); H.paint(); scrollSoon(s);
    };
    switch (k) {
      case 'ArrowUp': return move(-1, 0, ev.shiftKey);
      case 'ArrowDown': return move(1, 0, ev.shiftKey);
      case 'ArrowLeft': return move(0, -1, ev.shiftKey);
      case 'ArrowRight': return move(0, 1, ev.shiftKey);
      case 'Tab': return move(0, ev.shiftKey ? -1 : 1, false);
      case 'Enter': return move(ev.shiftKey ? -1 : 1, 0, false);
      case 'Home': s.sel = { r: mod ? 0 : a.r, c: 0, r2: mod ? 0 : a.r, c2: 0 }; ev.preventDefault(); H.paint(); scrollSoon(s); return;
      case 'End': s.sel = { r: mod ? R : a.r, c: C, r2: mod ? R : a.r, c2: C }; ev.preventDefault(); H.paint(); scrollSoon(s); return;
      case 'F2': ev.preventDefault(); startEdit(s); return;
      case 'Delete': case 'Backspace': ev.preventDefault(); clearSel(s); return;
    }
    if (mod && (k === 'z' || k === 'Z')) { ev.preventDefault(); undo(s, ev.shiftKey); return; }
    if (mod && (k === 'y' || k === 'Y')) { ev.preventDefault(); undo(s, true); return; }
    if (mod && (k === 'a' || k === 'A')) { ev.preventDefault(); s.sel = { r: 0, c: 0, r2: R, c2: C }; H.paint(); return; }
    if (!mod && !ev.altKey && k.length === 1) { ev.preventDefault(); startEdit(s, k); }
  }
  function scrollSoon(s) { setTimeout(function () { scrollActive(s); }, 0); }
  function onInput(ev) {
    var t = ev.target; if (!t.matches || !t.matches('[data-sxin],[data-sxbar]')) return;
    var s = sheetOf(t); if (!s) return;
    if (t.matches('[data-sxbar]') && !s.edit) {
      if (!s.ctx.canEdit || !s.grid.editable(s.sel.r, s.sel.c)) return;
      s.edit = { r: s.sel.r, c: s.sel.c, text: t.value, where: 'bar' };
    }
    if (!s.edit) return;
    s.edit.text = t.value; s.pick = null;
    /* keep the other box in step without a repaint (the caret stays put) */
    var root = rootOf(s), other = root && root.querySelector(t.matches('[data-sxin]') ? '[data-sxbar]' : '[data-sxin]');
    if (other) other.value = t.value;
  }
  function onFocusOut(ev) {
    var t = ev.target; if (!t.matches || !t.matches('[data-sxin],[data-sxbar]')) return;
    var s = sheetOf(t); if (!s || !s.edit) return;
    /* leaving the box for anything but the sheet itself commits, as clicking away does */
    setTimeout(function () {
      var root = rootOf(s); if (!s.edit || (root && root.contains(document.activeElement))) return;
      commit(s, null);
    }, 0);
  }
  function onCopy(ev) {
    var s = sheetOf(ev.target); if (!s || !s.grid || s.edit || !ev.target.matches('[data-sxgrid]')) return;
    ev.preventDefault();
    ev.clipboardData.setData('text/plain', selText(s));
    s.msg = 'Copied ' + X.addr(norm(s.sel).r1, norm(s.sel).c1) + (s.sel.r !== s.sel.r2 || s.sel.c !== s.sel.c2 ? ':' + X.addr(norm(s.sel).r2, norm(s.sel).c2) : '') + '.';
    H.paint();
  }
  function onPaste(ev) {
    var s = sheetOf(ev.target); if (!s || !s.grid || s.edit || !ev.target.matches('[data-sxgrid]')) return;
    ev.preventDefault();
    paste(s, ev.clipboardData.getData('text/plain'));
  }
  function onClick(ev) {
    var b = ev.target.closest && ev.target.closest('[data-sxa]'); if (!b) return;
    var s = sheetOf(b); if (!s) return;
    ev.preventDefault();
    if (s.edit) commit(s, null);
    act(s, b.getAttribute('data-sxa'));
  }
  function onChange(ev) {
    var t = ev.target; if (!t.matches || !t.matches('[data-sxf]')) return;
    var s = sheetOf(t); if (s) setFormat(s, t.value);
  }

  /* ---- resizing columns and rows ---------------------------------------- */
  function onPointerDown(ev) {
    var hc = ev.target.closest && ev.target.closest('[data-sxcol],[data-sxrow]'); if (!hc) return;
    var s = sheetOf(hc); if (!s || !s.grid) return;
    ev.preventDefault(); ev.stopPropagation();
    var isCol = hc.hasAttribute('data-sxcol'), i = +hc.getAttribute(isCol ? 'data-sxcol' : 'data-sxrow');
    var root = rootOf(s), table = root.querySelector('table.sx');
    var colEl = isCol ? root.querySelector('col[data-sxw="' + i + '"]') : null, tr = isCol ? null : hc.closest('tr');
    var start = isCol ? colW(s, s.ctx, s.grid, i) : rowH(s, s.ctx, s.grid, i), x0 = ev.clientX, y0 = ev.clientY, tw = parseFloat(table.style.width);
    var now = start;
    try { hc.setPointerCapture(ev.pointerId); } catch (e) { /* ignore */ }
    hc.classList.add('on');
    function mv(e) {
      now = Math.round(Math.max(isCol ? 40 : 18, Math.min(isCol ? 800 : 300, start + (isCol ? e.clientX - x0 : e.clientY - y0))));
      if (isCol) { colEl.style.width = now + 'px'; table.style.width = (tw + now - start) + 'px'; } else tr.style.height = now + 'px';
    }
    function up() {
      hc.removeEventListener('pointermove', mv); hc.removeEventListener('pointerup', up); hc.removeEventListener('pointercancel', up);
      hc.classList.remove('on');
      if (now === start) return;
      if (isCol) sizeCol(s, i, now); else sizeRow(s, i, now);
    }
    hc.addEventListener('pointermove', mv); hc.addEventListener('pointerup', up); hc.addEventListener('pointercancel', up);
  }
  /* sizes: saved with the view for people who can edit it, kept for this
     visit for people who can only view it */
  function sizeCol(s, c, w) {
    var k = s.grid.cols[c].key;
    if (s.ctx.canEdit) { if (w === null) delete s.ctx.sheet.colW[k]; else s.ctx.sheet.colW[k] = w; delete s.colW[k]; s.ctx.onChange(); }
    else if (w === null) delete s.colW[k]; else s.colW[k] = w;
    H.paint();
  }
  function sizeRow(s, r, h) {
    var k = s.grid.rowKey(r);
    if (s.ctx.canEdit) { if (h === null) delete s.ctx.sheet.rowH[k]; else s.ctx.sheet.rowH[k] = h; delete s.rowH[k]; s.ctx.onChange(); }
    else if (h === null) delete s.rowH[k]; else s.rowH[k] = h;
    H.paint();
  }
  function fitCol(s, c) {
    var g = s.grid, longest = String(X.colName(c)).length, f = 7.2;
    for (var r = 0; r < g.rowsN; r++) { var t = show(g.value(r, c), g.fmtOf(r, c)); if (t.length > longest) longest = t.length; }
    sizeCol(s, c, Math.max(60, Math.min(600, Math.round(longest * f + 26))));
  }

  /* ---- export: the grid as the export tables (values, as shown) ---------- */
  var XF = { money: 'money', pct: 'pct', ratio: 'ratio', count: 'count', number: 'number', text: 'text' };
  function exportTables(key, title) {
    var s = SS[key]; if (!s || !s.grid) return [];
    var g = s.grid, last = g.firstSpare - 1;
    var cellOf = function (r, c) {
      var v = g.value(r, c), f = g.fmtOf(r, c);
      if (X.isErr(v)) return { f: 'text', v: v.err };
      if (typeof v === 'number') return { f: XF[f] || 'number', v: v };
      return { f: 'text', v: v === null || v === undefined ? '' : typeof v === 'boolean' ? (v ? 'TRUE' : 'FALSE') : String(v) };
    };
    var main = { title: title || 'Spreadsheet', heads: g.cols.slice(0, last + 1).map(function (x) { return x.label; }), rows: [] };
    for (var r = 1; r <= g.T; r++) {
      var cells = []; for (var c = 1; c <= last; c++) cells.push(cellOf(r, c));
      main.rows.push({ label: String(g.value(r, 0) || ''), kind: r === g.T ? 'total' : '', cells: cells });
    }
    var out = [main];
    /* the calculation area, if anything is in it */
    var used = [], maxC = 0;
    for (var fr = g.T + 1; fr < g.rowsN; fr++) {
      var any = false;
      for (var cc = 0; cc < g.cols.length; cc++) { var raw = g.raw(fr, cc); if (raw !== null && raw !== undefined && raw !== '') { any = true; maxC = Math.max(maxC, cc); } }
      if (any) used.push(fr);
    }
    if (used.length) {
      out.push({ title: 'Calculations', heads: ['Row'].concat(g.cols.slice(0, maxC + 1).map(function (x, c) { return X.colName(c); })),
        rows: used.map(function (fr) { var cs = []; for (var c = 0; c <= maxC; c++) cs.push(cellOf(fr, c)); return { label: String(fr + 1), kind: '', cells: cs }; }) });
    }
    return out;
  }
  /* before saving: re-key the stored formulas against the grid on screen */
  function settle(key, sheet) { var s = SS[key]; if (s && s.grid && s.ctx && s.ctx.sheet === sheet) X.settle(sheet, s.grid); return sheet; }
  function forget(key) { delete SS[key]; }

  var bound = false;
  function init(helpers) {
    H = helpers;
    if (bound) return; bound = true;
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('mouseover', onMouseOver);
    document.addEventListener('mouseup', onMouseUp);
    document.addEventListener('dblclick', onDblClick);
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('input', onInput);
    document.addEventListener('focusout', onFocusOut);
    document.addEventListener('copy', onCopy);
    document.addEventListener('paste', onPaste);
    document.addEventListener('click', onClick);
    document.addEventListener('change', onChange);
    document.addEventListener('pointerdown', onPointerDown, true);
  }

  window.PortalSheet = { init: init, html: html, exportTables: exportTables, settle: settle, forget: forget, _state: SS };
})();
