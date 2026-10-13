/* ===========================================================================
   portal-props.js — the Properties section, v2 (docs/PROPERTIES_SPEC.md).

   A port of the approved mockup (docs/mockup/properties-mockup.dc.html) into
   the portal's stack: vanilla JS, server-built payloads. The markup, wording,
   behaviour and calculations follow the mockup; every number comes from
   /api/props (props-api.js), which serves each of the mockup's data methods
   for every property.

     Portfolio  ->  Managing entity  ->  Property (8 tabs)
     Portfolio tabs: Entities | Custom view | Reports (portal-reports.js)

   One TABLE MODEL drives both the screen and the exports: a table is a list
   of rows, each a label plus raw values with a format. tableHtml() renders
   it; exportTab() sends the same model to /api/props/export. So a file can
   never disagree with the screen it was exported from.

   Wiring: .onclick / .oninput / .onchange on the host, set on every mount
   rather than added, so returning to the section never stacks listeners.
   =========================================================================== */
(function () {
  'use strict';

  var MN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var NONE = 'No managing entity';

  /* ---- formatting ------------------------------------------------------- */
  function esc(s) {
    return String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  var DASH = '–';
  function isNum(v) { return typeof v === 'number' && isFinite(v); }
  function money(v, cents) {
    if (!isNum(v)) return DASH;
    var s = Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: cents ? 2 : 0, maximumFractionDigits: cents ? 2 : 0 });
    return v < 0 ? '($' + s + ')' : '$' + s;
  }
  function num2(v) {
    if (!isNum(v)) return DASH;
    var s = Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return v < 0 ? '(' + s + ')' : s;
  }
  function pct(v) { return isNum(v) ? (v * 100).toFixed(1) + '%' : DASH; }
  function cnt(v) { return isNum(v) ? Math.round(v).toLocaleString('en-US') : DASH; }
  function ratio(v) { return isNum(v) ? v.toFixed(2) : DASH; }
  function fmt(f, v) {
    if (f === 'text') return v === null || v === undefined || v === '' ? DASH : String(v);
    if (f === 'money') return money(v);
    if (f === 'moneyc') return money(v, true);
    if (f === 'money2' || f === 'number') return num2(v);
    if (f === 'pct') return pct(v);
    if (f === 'ratio') return ratio(v);
    if (f === 'count') return cnt(v);
    return isNum(v) ? String(v) : DASH;
  }
  function ymShort(ym) { var m = /^(\d{4})-(\d{2})/.exec(ym || ''); return m ? MN[+m[2] - 1] + ' ' + m[1].slice(2) : ''; }
  function ymLong(ym) { var m = /^(\d{4})-(\d{2})/.exec(ym || ''); return m ? MN[+m[2] - 1] + ' ' + m[1] : ''; }
  function dayLong(d) { var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(d || ''); return m ? MN[+m[2] - 1] + ' ' + (+m[3]) + ', ' + m[1] : ''; }
  function ym(y, mo) { return y + '-' + String(mo).padStart(2, '0'); }
  /* "RENTS" -> "Rents": sentence-case labels the books shout */
  function sentence(s) {
    s = String(s || '');
    if (/[a-z]/.test(s) || !/[A-Z]/.test(s)) return s;
    var t = s.toLowerCase();
    return t.charAt(0).toUpperCase() + t.slice(1);
  }
  function C(k) { return 'color: var(--' + k + ')'; }
  function dscrStyle(v) { return !isNum(v) ? C('muted') : v < 1 ? C('bad') + '; font-weight: 600' : v < 1.25 ? C('warn') : C('ok'); }
  function occStyle(v) { return !isNum(v) ? '' : v < 0.85 ? C('bad') : v < 0.9 ? C('warn') : ''; }
  function sum(a) { var f = a.filter(isNum); return f.length ? f.reduce(function (x, y) { return x + y; }, 0) : null; }
  function avg(a) { var f = a.filter(isNum); return f.length ? sum(f) / f.length : null; }
  function svg(path, size, extra) {
    return '<svg width="' + (size || 14) + '" height="' + (size || 14) + '" style="width:' + (size || 14) + 'px;height:' + (size || 14) + 'px;flex:none" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"' + (extra || '') + '>' + path + '</svg>';
  }
  var ICON_DOWN = '<path d="M12 3v12M7 10l5 5 5-5M5 21h14"></path>';
  var ICON_CHEV = '<path d="M6 9l6 6 6-6"></path>';
  var ICON_CRUMB = '<path d="M9 6l6 6-6 6"></path>';

  /* ---- data ------------------------------------------------------------- */
  function authHeaders() {
    return window.PortalSession.client()
      .then(function (c) { return c.auth.getSession(); })
      .then(function (r) {
        var t = r && r.data && r.data.session && r.data.session.access_token;
        if (!t) throw new Error('Your session has expired. Sign in again.');
        return { Authorization: 'Bearer ' + t, Accept: 'application/json' };
      });
  }
  function api(path, method, body) {
    return authHeaders().then(function (h) {
      var o = { headers: h, cache: 'no-store', method: method || 'GET' };
      if (body !== undefined) { o.headers['Content-Type'] = 'application/json'; o.body = JSON.stringify(body); }
      return fetch(path, o).then(function (r) {
        return r.json().then(function (b) {
          if (!r.ok) throw new Error((b && b.error) || ('HTTP ' + r.status));
          return b;
        }, function () { throw new Error('HTTP ' + r.status); });
      });
    });
  }
  function download(body) {
    return authHeaders().then(function (h) {
      h['Content-Type'] = 'application/json';
      return fetch('/api/props/export', { method: 'POST', headers: h, body: JSON.stringify(body) });
    }).then(function (r) {
      if (!r.ok) return r.json().then(function (b) { throw new Error(b.error || 'Export failed.'); });
      var cd = r.headers.get('Content-Disposition') || '';
      var m = /filename\*=UTF-8''([^;]+)/.exec(cd);
      var name = m ? decodeURIComponent(m[1]) : 'export';
      return r.blob().then(function (b) {
        var a = document.createElement('a');
        a.href = URL.createObjectURL(b); a.download = name;
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(function () { URL.revokeObjectURL(a.href); }, 4000);
        return name;
      });
    });
  }

  /* ---- state ------------------------------------------------------------ */
  var S = {
    host: null,
    level: 'portfolio', l1: 'entities',
    ent: null,            /* managing entity id, or 'none' */
    prop: null, ptab: 'overview',
    fm: null, fy: null, tm: null, ty: null,  /* period, defaulted from the data */
    feeYear: null, feeFrom: 1, feeTo: null,
    asOf: null,
    q: '', src: 'all',
    dense: false,
    exportOpen: false, exportMsg: '',
    oa: {}, wnoi: {},     /* what-if inputs per property; never saved */
    data: {}, pending: {}, errors: {}, old: {}, last: {}, staleNow: false,
    dataset: null,        /* every property's plain figures, for the builder's local preview */
    cv: { mode: 'view', sel: null, draft: null, exportOpen: false, msg: '', preview: null, previewKey: '', saving: false, err: '' },
  };
  try { S.dense = localStorage.getItem('lwDense') === '1'; } catch (e) { /* storage blocked: default density */ }

  /* Every response is kept for the session under its key (property, period,
     tab), so going back to anything already loaded is instant. A key being
     fetched again after a realtime invalidation keeps showing its previous
     answer (S.old) until the new one lands: no loader, no blank. The loader
     is held back 250ms and, once visible, kept 400ms (PortalLoader.settle). */
  function need(key, url) {
    if (S.data[key]) return S.data[key];
    if (!S.pending[key] && !S.errors[key]) {
      S.pending[key] = true;
      var t0 = window.PortalLoader.now();
      api(url).then(function (d) {
        window.PortalLoader.settle(t0, function () { S.data[key] = d; delete S.old[key]; delete S.pending[key]; paint(); });
      }, function (e) {
        /* a failed refresh must say so, not keep showing the old answer as current */
        window.PortalLoader.settle(t0, function () { S.errors[key] = e.message; delete S.old[key]; delete S.pending[key]; paint(); });
      });
    }
    return S.old[key] || null;
  }
  /* For a tab whose period or date changed: the new answer if loaded, else
     the last one this tab showed for the same property, marked stale, so the
     panel stays on screen (dimmed) while the new one loads. */
  function needOr(kind, key, url) {
    var d = need(key, url);
    if (d) { if (!S.pending[key]) S.last[kind] = key; return { D: d, stale: false }; }
    var lk = S.last[kind];
    if (lk && lk.split(':')[1] === S.prop && S.data[lk] && !errOf(key)) { S.staleNow = true; return { D: S.data[lk], stale: true }; }
    return { D: null, stale: false };
  }
  function errOf(key) { return S.errors[key] || null; }
  /* the latest answer for a key, including one being refreshed */
  function cur(key) { return S.data[key] || S.old[key] || null; }
  function drop(prefix) {
    [S.data, S.errors, S.old].forEach(function (o) {
      Object.keys(o).forEach(function (k) { if (k.indexOf(prefix) === 0) delete o[k]; });
    });
  }

  function list() { return need('list', '/api/props/list'); }
  function through() { var L = cur('list'); return (L && L.dataThrough) || null; }
  function defaultPeriod() {
    var t = through(); if (!t || S.ty) return;
    var y = +t.slice(0, 4), m = +t.slice(5, 7);
    S.ty = y; S.tm = m;
    var k = y * 12 + m - 1 - 11;
    S.fy = Math.floor(k / 12); S.fm = (k % 12) + 1;
    if (!S.feeYear) { S.feeYear = y; S.feeTo = m; }
  }
  function periodFromTo() { return { from: ym(S.fy, S.fm), to: ym(S.ty, S.tm) }; }

  /* ---- URL: the level, entity, property, tab and period ride in the hash
     through urlParams(), because portal.html rebuilds the fragment on every
     render. Navigation inside the section PUSHES, so Back steps back. ------ */
  var urlRead = false;
  function ensureUrlRead() { if (!urlRead) { urlRead = true; readUrl(); } }
  function urlParams() {
    ensureUrlRead();
    var o = { lvl: S.level };
    if (S.level === 'portfolio') { o.l1 = S.l1; if (S.l1 === 'custom' && S.cv.sel) o.cv = S.cv.sel; }
    if (S.level !== 'portfolio') o.ent = S.ent || '';
    if (S.level === 'property') { o.prop = S.prop; o.ptab = S.ptab; }
    if (S.fy) { o.from = ym(S.fy, S.fm); o.to = ym(S.ty, S.tm); }
    if (S.asOf) o.asof = S.asOf;
    return o;
  }
  function readUrl() {
    var p;
    try { p = new URLSearchParams((location.hash || '').replace(/^#/, '')); } catch (e) { return; }
    if (p.get('view') !== 'properties') return;
    var lvl = p.get('lvl');
    if (['portfolio', 'entity', 'property'].indexOf(lvl) >= 0) S.level = lvl;
    if (p.get('l1') === 'custom' || p.get('l1') === 'reports') S.l1 = p.get('l1');
    if (p.get('cv')) S.cv.sel = p.get('cv');
    if (p.has('ent')) S.ent = p.get('ent') || null;
    if (p.get('prop')) S.prop = p.get('prop');
    if (TABS.some(function (t) { return t[0] === p.get('ptab'); })) S.ptab = p.get('ptab');
    var f = /^(\d{4})-(\d{2})$/.exec(p.get('from') || ''), t = /^(\d{4})-(\d{2})$/.exec(p.get('to') || '');
    if (f && t) { S.fy = +f[1]; S.fm = +f[2]; S.ty = +t[1]; S.tm = +t[2]; }
    if (/^\d{4}-\d{2}-\d{2}$/.test(p.get('asof') || '')) S.asOf = p.get('asof');
    if (S.level === 'property' && !S.prop) S.level = 'portfolio';
  }
  function pushUrl() {
    try {
      var p = new URLSearchParams((location.hash || '').replace(/^#/, ''));
      ['lvl', 'l1', 'cv', 'ent', 'prop', 'ptab', 'from', 'to', 'asof'].forEach(function (k) { p.delete(k); });
      var x = urlParams();
      Object.keys(x).forEach(function (k) { if (x[k] !== null && x[k] !== undefined) p.set(k, x[k]); });
      history.pushState(null, '', location.pathname + location.search + '#' + p.toString());
    } catch (e) { /* a URL we cannot write is no reason to refuse to navigate */ }
  }
  window.addEventListener('popstate', function () {
    if (!S.host || !document.body.contains(S.host)) return;
    urlRead = true; S.level = 'portfolio'; S.ent = null; S.prop = null; S.l1 = 'entities';
    readUrl(); paint();
  });

  function goPortfolio(l1) { S.level = 'portfolio'; S.ent = null; S.prop = null; if (l1) S.l1 = l1; closeMenus(); pushUrl(); paint(); }
  function goEntity(id) { S.level = 'entity'; S.ent = id || 'none'; S.prop = null; S.q = ''; closeMenus(); pushUrl(); paint(); }
  function goProperty(id, tab) {
    var p = propById(id);
    S.level = 'property'; S.prop = id; S.ptab = tab || 'overview'; S.asOf = null;
    if (p) S.ent = p.ownerId || 'none';
    closeMenus(); pushUrl(); paint();
  }
  function closeMenus() { S.exportOpen = false; S.exportMsg = ''; S.cv.exportOpen = false; }
  function propById(id) { var L = cur('list'); return L ? L.properties.find(function (p) { return p.id === id; }) || null : null; }
  function entName(id) {
    if (!id || id === 'none') return NONE;
    var L = cur('list'); var p = L && L.properties.find(function (x) { return x.ownerId === id; });
    return p ? p.owner : '';
  }

  /* ---- generic table renderer ------------------------------------------ */
  /* cell: { v, f, style, cls, html }  row: { label, html, kind, cls, labelStyle, act, cells } */
  function cellText(c) { return c.html !== undefined ? c.html : esc(fmt(c.f || 'text', c.v)); }
  function cellStyle(c) {
    if (c.style !== undefined) return c.style;
    if (c.f === 'text') return '';
    return isNum(c.v) ? (c.v < 0 ? C('bad') : '') : C('muted');
  }
  function tableHtml(t) {
    var h = '<div class="scroll frame"' + (t.maxH ? ' style="max-height:' + t.maxH + 'px"' : '') + '><table><thead><tr>' +
      t.heads.map(function (x, i) {
        return '<th class="' + (x.cls || '') + '" style="' + (i === 0 && t.firstW ? 'min-width:' + t.firstW + 'px;' : '') + (x.style || '') + '">' + esc(x.label) + '</th>';
      }).join('') + '</tr></thead><tbody>';
    t.rows.forEach(function (r) {
      var cls = [r.kind === 'total' ? 'total' : '', r.kind === 'key' ? 'key' : '', r.kind === 'group' ? 'group' : '', r.band ? 'band' : '', r.act ? 'click' : '', r.cls || ''].join(' ').trim();
      h += '<tr class="' + cls + '"' + (r.act ? ' data-a="' + esc(r.act) + '"' : '') + '>' +
        '<td style="' + (r.labelStyle || '') + '">' + (r.html !== undefined ? r.html : esc(r.label)) + '</td>' +
        r.cells.map(function (c) { return '<td class="' + (c.cls || '') + '" style="' + cellStyle(c) + '">' + cellText(c) + '</td>'; }).join('') +
        '</tr>';
    });
    return h + '</tbody></table></div>';
  }
  /* the same model, for an export: label + raw values with a format */
  function tableExport(t) {
    var XF = { money: 'money', moneyc: 'money2', money2: 'money2', number: 'money2', pct: 'pct', ratio: 'ratio', count: 'count', text: 'text' };
    return {
      title: t.title || 'Table',
      heads: t.heads.map(function (x) { return x.label; }),
      rows: t.rows.map(function (r) {
        return { label: r.exportLabel !== undefined ? r.exportLabel : r.label, kind: r.kind || (r.band ? 'key' : ''),
          cells: r.cells.map(function (c) { var f = XF[c.f || 'text'] || 'text'; return { f: f, v: f === 'text' ? (c.exportText !== undefined ? c.exportText : (c.v === null || c.v === undefined ? '' : c.v)) : (isNum(c.v) ? c.v : null) }; }) };
      }),
    };
  }
  function cardsHtml(cards) {
    return '<div class="frame lw-cards">' + cards.map(function (k) {
      return '<div class="lw-card"><div class="lw-card-l">' + esc(k.label) + '</div>' +
        '<div class="lw-card-v" style="' + (k.style || '') + '" title="' + esc(k.value) + '">' + esc(k.value) + '</div>' +
        '<div class="lw-card-s" title="' + esc(k.sub || '') + '"><span>' + esc(k.sub || '') + '</span>' + (k.tag ? '<span class="lw-tag">' + esc(k.tag) + '</span>' : '') + '</div></div>';
    }).join('') + '</div>';
  }
  /* every loading state: the animated mark (portal-loader.js), shown after
     250ms and for at least 400ms, in the content area only */
  function loading(name) { return window.PortalLoader.full(name); }
  function staleCls(m) { return m && m.stale ? ' ld-stale' : ''; }
  function errorBox(msg) { return '<div class="lw-err" role="alert">' + esc(msg) + ' <button class="link" data-a="retry">Try again</button></div>'; }

  /* ===================================================================== */
  /*  HEADER                                                               */
  /* ===================================================================== */
  function headHtml() {
    var parts = [{ label: 'Portfolio', a: 'crumb:portfolio' }];
    /* at property level the crumb is the property's OWN manager: a page opened
       by a link has no drill-down behind it, and S.ent may be empty */
    var pp = S.level === 'property' ? propById(S.prop) : null;
    if (pp) S.ent = pp.ownerId || 'none';
    /* a property opened cold has no manager to name until the list arrives;
       leave the crumb out rather than say "No managing entity" */
    if (S.level === 'entity' || (S.level === 'property' && pp)) parts.push({ label: entName(S.ent) || 'Entity', a: 'crumb:entity' });
    if (S.level === 'property' && pp) parts.push({ label: pp.name });
    var crumbs = parts.map(function (c, i) {
      var last = i === parts.length - 1;
      return (i ? svg(ICON_CRUMB, 14, ' style="color:var(--muted)"') : '') +
        (last ? '<span aria-current="page">' + esc(c.label) + '</span>' : '<button class="link" data-a="' + c.a + '">' + esc(c.label) + '</button>');
    }).join('');
    var t = through();
    return '<header class="lw-head"><nav aria-label="Breadcrumb" class="lw-crumbs">' + crumbs + '</nav>' +
      '<span class="lw-through">' + (t ? 'Data through ' + ymLong(t) : '') +
      (cur('list') && cur('list').nextSync ? ', next sync ' + esc(cur('list').nextSync.label) : '') + '</span>' +
      '<div role="group" aria-label="Row density" style="display:flex;gap:4px">' +
      '<button class="btn press' + (!S.dense ? ' on' : '') + '" data-a="dense:0">Comfortable</button>' +
      '<button class="btn press' + (S.dense ? ' on' : '') + '" data-a="dense:1">Compact</button></div></header>';
  }

  /* ===================================================================== */
  /*  PORTFOLIO: Entities (owner LLCs) | Custom view | Reports             */
  /* ===================================================================== */
  var NONE_OWNER = 'No owner entity on file';
  var ECON_NOTE = 'Economic occupancy is (rent income + recurring fee income) / total expected income for the latest month; a red – means total expected income is not loaded yet.';
  /* missing data that should exist: a red dash, never 0 */
  function econCell(v, suffix) {
    return isNum(v) ? { v: v, f: 'pct', style: occStyle(v), html: esc(pct(v)) + (suffix ? '<span style="font-size:12px;color:var(--muted)">' + esc(suffix) + '</span>' : '') }
                    : { v: null, f: 'pct', style: C('bad') + '; font-weight: 600', html: DASH };
  }
  function groupsOf(P) {
    var g = {};
    P.forEach(function (p) { var k = p.ownerId || 'none'; (g[k] = g[k] || []).push(p); });
    return g;
  }
  function portfolioHtml() {
    var L = list();
    if (!L) return '<main class="view lw-main">' + (errOf('list') ? errorBox(errOf('list')) : loading('the portfolio')) + '</main>';
    var P = L.properties;
    var units = sum(P.map(function (p) { return p.units; })) || 0;
    var h = '<main class="view lw-main"><div style="display:flex;align-items:baseline;justify-content:space-between;gap:16px;flex-wrap:wrap">' +
      '<h1 class="h1">Portfolio</h1><p class="note">' + P.length + ' held properties with reports, ' + units.toLocaleString('en-US') +
      ' units, income through ' + ymLong(L.dataThrough) + '</p></div>' +
      '<div role="tablist" aria-label="Portfolio views" class="lw-tabs">' +
      [['entities', 'Entities'], ['custom', 'Custom view'], ['reports', 'Reports']].map(function (x) {
        return '<button role="tab" aria-selected="' + (S.l1 === x[0]) + '" class="tab press' + (S.l1 === x[0] ? ' on' : '') + '" data-a="l1:' + x[0] + '">' + x[1] + '</button>';
      }).join('') + '</div>';
    h += S.l1 === 'custom' ? customHtml() : S.l1 === 'reports' && window.PortalReports ? window.PortalReports.html() : entitiesHtml(P);
    return h + '</main>';
  }

  function entitiesHtml(P) {
    var g = groupsOf(P);
    var keys = Object.keys(g).sort(function (a, b) {
      return (a === 'none') - (b === 'none') || (g[a][0].owner || '').localeCompare(g[b][0].owner || '');
    });
    var rows = keys.map(function (k) {
      var ps = g[k], isNone = k === 'none';
      var units = sum(ps.map(function (p) { return p.units; }));
      var w = ps.filter(function (p) { return p.units && isNum(p.occ); });
      var uo = sum(w.map(function (p) { return p.units; }));
      var occ = uo ? sum(w.map(function (p) { return p.units * p.occ; })) / uo : null;
      var ew = ps.filter(function (p) { return isNum(p.econDen) && p.econDen > 0; });
      var econ = ew.length ? sum(ew.map(function (p) { return p.econNum; })) / sum(ew.map(function (p) { return p.econDen; })) : null;
      var mgrs = ps.map(function (p) { return p.mgr; }).filter(function (m, i, a) { return m && a.indexOf(m) === i; });
      var noi = sum(ps.map(function (p) { return p.noi; }));
      var cf = sum(ps.map(function (p) { return p.cf; }));
      var debt = sum(ps.map(function (p) { return p.debt; }));
      var vs = ps.filter(function (p) { return p.value; });
      var mv = vs.length ? sum(vs.map(function (p) { return p.value; })) : null;
      var name = isNone ? NONE_OWNER : ps[0].owner;
      var act = 'ent:' + k;
      return { act: act, label: name, exportLabel: name,
        html: '<button class="link" data-a="' + act + '" style="font-weight:500' + (isNone ? ';' + C('warn') : '') + '">' + esc(name) + '</button>' +
              '<div style="font-size:12px;color:var(--muted)">' + ps.length + (ps.length === 1 ? ' property' : ' properties') +
              (mgrs.length === 1 ? ', managing entity ' + esc(mgrs[0]) : mgrs.length > 1 ? ', ' + mgrs.length + ' managing entities' : '') + '</div>',
        cells: [
          { v: ps.length, f: 'count', style: '' }, { v: units, f: 'count', style: '' }, { v: occ, f: 'pct', style: occStyle(occ) },
          econCell(econ, ew.length < ps.length && ew.length ? ' (' + ew.length + ' of ' + ps.length + ')' : ''),
          { v: noi, f: 'money', cls: 'sep', style: noi < 0 ? C('bad') : '' },
          { v: mv, f: 'money', exportText: mv, style: mv === null ? C('bad') + '; font-weight: 600' : '',
            html: mv === null ? DASH : esc(money(mv)) + (vs.length < ps.length ? '<span style="font-size:12px;color:var(--muted)"> (' + vs.length + ' of ' + ps.length + ')</span>' : '') + '<span class="lw-tag">Outdated</span>' },
          { v: cf, f: 'money', style: C('muted') },
          { v: debt, f: 'money', cls: 'sep', style: '' },
        ] };
    });
    S.exportModel = null;
    return '<div class="view" style="margin-top:14px">' + tableHtml({
      firstW: 300, maxH: Math.max(400, window.innerHeight - 230),
      heads: [{ label: 'Owner entity' }, { label: 'Properties' }, { label: 'Units' }, { label: 'Physical occupancy' }, { label: 'Economic occupancy' }, { label: 'NOI', cls: 'sep' },
              { label: 'Market value' }, { label: 'Cash flow after debt and capex' }, { label: 'Debt', cls: 'sep' }],
      rows: rows }) +
      '<p class="note" style="margin-top:8px">NOI and cash flow are the trailing 12 months. Market value is the sum of values on file; every value on file is more than 12 months old or undated. ' + ECON_NOTE + ' Click an entity to see its properties.</p></div>';
  }

  /* ===================================================================== */
  /*  ENTITY: its properties                                               */
  /* ===================================================================== */
  function entityHtml() {
    var L = list();
    if (!L) return '<main class="view lw-main">' + (errOf('list') ? errorBox(errOf('list')) : loading('the entity')) + '</main>';
    var scope = L.properties.filter(function (p) { return (p.ownerId || 'none') === (S.ent || 'none'); });
    var nm = entName(S.ent);
    var q = S.q.trim().toLowerCase();
    var listP = scope.filter(function (p) { return (S.src === 'all' || p.src === S.src) && (!q || (p.name + ' ' + p.pm + ' ' + p.address).toLowerCase().indexOf(q) >= 0); })
      .sort(function (a, b) { return (b.noi || 0) - (a.noi || 0); });
    var rows = listP.map(function (p) {
      var er = p.inc ? p.opx / p.inc : null;
      return { act: 'prop:' + p.id, label: p.name,
        html: '<button class="link" data-a="prop:' + p.id + '" style="font-weight:500">' + esc(p.name) + '</button> <span class="chip">' + esc(p.src) + '</span>',
        cells: [
          { v: p.units, f: 'count', style: '' }, { v: p.occ, f: 'pct', style: occStyle(p.occ) }, econCell(p.econ, ''),
          { v: p.inc, f: 'money', cls: 'sep', style: '' }, { v: p.opx, f: 'money', style: '' }, { v: p.noi, f: 'money' },
          { v: p.opt, f: 'money', style: '' }, { v: er, f: 'pct', style: er > 0.6 ? C('warn') : '' },
          { v: p.cf, f: 'money', style: C('muted') },
          { v: p.dscr, f: 'ratio', cls: 'sep', style: dscrStyle(p.dscr) },
          { v: p.pm, f: 'text', cls: 'l', style: 'color:var(--muted);max-width:220px;overflow:hidden;text-overflow:ellipsis' },
        ] };
    });
    return '<main class="view lw-main"><h1 class="h1">' + esc(nm) + '</h1>' +
      '<p class="note" style="margin-top:2px">' + scope.length + (scope.length === 1 ? ' property' : ' properties') +
      (S.ent === 'none' || !S.ent ? '. These properties have no owner entity on file.' : '') + '</p>' +
      '<div class="view" style="display:flex;align-items:center;gap:8px 12px;margin-top:14px;flex-wrap:wrap;font-size:13px;color:var(--muted)">' +
      '<input class="sel" type="search" placeholder="Search property" value="' + esc(S.q) + '" data-in="q" aria-label="Search property" style="width:220px">' +
      [['all', 'All sources'], ['Buildium', 'Buildium'], ['AppFolio', 'AppFolio']].map(function (b) {
        return '<button class="btn press' + (S.src === b[0] ? ' on' : '') + '" aria-pressed="' + (S.src === b[0]) + '" data-a="src:' + b[0] + '">' + b[1] + '</button>';
      }).join('') + '<span style="margin-left:auto">' + listP.length + ' of ' + scope.length + ', sorted by NOI</span></div>' +
      '<div style="margin-top:10px">' + tableHtml({ firstW: 260, maxH: Math.max(400, window.innerHeight - 260),
        heads: [{ label: 'Property' }, { label: 'Units' }, { label: 'Physical occupancy' }, { label: 'Economic occupancy' }, { label: 'Total income', cls: 'sep' }, { label: 'Total expenses' },
                { label: 'NOI, trailing 12 mo' }, { label: 'Best NOI' }, { label: 'Expense ratio' }, { label: 'Cash flow after debt and capex' },
                { label: 'DSCR, mortgage', cls: 'sep' }, { label: 'Manager', cls: 'l' }], rows: rows }) + '</div>' +
      '<p class="note" style="margin-top:8px">' + ECON_NOTE + ' Click a property to open it. Cash flow is after debt service and capex, so it is shown without color; red is kept for NOI and coverage.</p></main>';
  }

  /* ===================================================================== */
  /*  PROPERTY                                                             */
  /* ===================================================================== */
  var TABS = [['overview', 'Overview'], ['buildings', 'Buildings & units'], ['attention', 'Needs attention'], ['monthly', 'Monthly financials'],
              ['optimized', 'Optimized NOI'], ['fee', 'Asset management fee'], ['rent', 'Rent roll'], ['capex', 'Capex']];
  var EXPORTABLE = { monthly: 'Monthly financials', optimized: 'Optimized NOI', rent: 'Rent roll', capex: 'Capex' };

  function propertyHtml() {
    var L = list();
    var H = need('p:' + S.prop, '/api/props/' + S.prop);
    if (!L || !H) {
      var e = errOf('list') || errOf('p:' + S.prop);
      var pp = propById(S.prop);
      return '<main class="view lw-main">' + (e ? errorBox(e) : loading(pp ? pp.name : 'the property')) + '</main>';
    }
    var p = H.property, flags = H.flags;
    var h = '<main class="view lw-main"><div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap"><h1 class="h1">' + esc(p.name) + '</h1>' +
      '<span style="padding:2px 8px;border-radius:4px;font-size:12px;font-weight:500;background:var(--okBg);color:var(--ok)">Held</span>' +
      '<span class="chip">' + esc(p.src) + '</span></div>' +
      '<p class="note" style="margin-top:4px">' + esc((p.pm ? 'Managed by ' + p.pm : '') + (p.mgr ? ', managing entity ' + p.mgr : ', no managing entity on file')) + '</p>';
    if (S.ptab === 'overview') h += '<div data-k="ovcards" style="margin-top:16px">' + cardsHtml(overviewCards(p, H)) + '</div>';

    var body = TAB_RENDER[S.ptab](p, H);
    h += '<div class="lw-tabbar" data-k="tabbar"><div role="tablist" aria-label="Property sections" style="display:flex;flex-wrap:wrap">' +
      TABS.map(function (t) {
        var badge = t[0] === 'attention' && flags.length ? '<span class="lw-badge">' + flags.length + '</span>' : '';
        return '<button role="tab" aria-selected="' + (S.ptab === t[0]) + '" class="tab press' + (S.ptab === t[0] ? ' on' : '') + '" data-a="ptab:' + t[0] + '">' + t[1] + badge + '</button>';
      }).join('') + '</div>' + controlsHtml() + '</div>';
    if (S.exportMsg && EXPORTABLE[S.ptab]) {
      h += '<div role="status" class="lw-status">' + svg('<path d="M5 12l5 5L20 7"></path>', 14, ' style="color:var(--ok)"') + '<span>' + esc(S.exportMsg) +
        '</span><button class="link" data-a="clearmsg" style="margin-left:auto">Dismiss</button></div>';
    }
    return h + '<div data-k="tab:' + S.ptab + '">' + body + '</div></main>';
  }

  function periodSelects() {
    var t = through(); var maxY = t ? +t.slice(0, 4) : new Date().getFullYear();
    var years = []; for (var y = maxY - 2; y <= maxY; y++) years.push(y);
    var mSel = function (k, v, lbl) {
      return '<select class="sel" aria-label="' + lbl + '" data-in="' + k + '">' + MN.map(function (_, i) {
        return '<option value="' + (i + 1) + '"' + (v === i + 1 ? ' selected' : '') + '>' + String(i + 1).padStart(2, '0') + '</option>';
      }).join('') + '</select>';
    };
    var ySel = function (k, v, lbl) {
      return '<select class="sel" aria-label="' + lbl + '" data-in="' + k + '">' + years.map(function (y) {
        return '<option value="' + y + '"' + (v === y ? ' selected' : '') + '>' + y + '</option>';
      }).join('') + '</select>';
    };
    return '<span>From</span>' + mSel('fm', S.fm, 'From month') + ySel('fy', S.fy, 'From year') +
      '<span style="margin-left:8px">to</span>' + mSel('tm', S.tm, 'To month') + ySel('ty', S.ty, 'To year');
  }

  function controlsHtml() {
    var h = '';
    var busy = S.staleNow ? window.PortalLoader.small('Updating') : '';
    if (S.ptab === 'monthly' || S.ptab === 'capex') h += '<div class="lw-ctrls">' + periodSelects() + busy + '</div>';
    if (S.ptab === 'fee') {
      var t = through(); var maxY = t ? +t.slice(0, 4) : new Date().getFullYear();
      var ys = []; for (var y = maxY - 1; y <= maxY; y++) ys.push(y);
      h += '<div class="lw-ctrls"><label for="lw-fy">Year</label><select id="lw-fy" class="sel" data-in="feeYear">' +
        ys.map(function (y) { return '<option value="' + y + '"' + (S.feeYear === y ? ' selected' : '') + '>' + y + '</option>'; }).join('') + '</select>' +
        '<label for="lw-ff" style="margin-left:6px">From</label><select id="lw-ff" class="sel" data-in="feeFrom">' + MN.map(function (m, i) {
          return '<option value="' + (i + 1) + '"' + (S.feeFrom === i + 1 ? ' selected' : '') + '>' + m + ' ' + String(S.feeYear).slice(2) + '</option>'; }).join('') + '</select>' +
        '<label for="lw-ft">to</label><select id="lw-ft" class="sel" data-in="feeTo">' + MN.map(function (m, i) {
          return '<option value="' + (i + 1) + '"' + (S.feeTo === i + 1 ? ' selected' : '') + '>' + m + ' ' + String(S.feeYear).slice(2) + '</option>'; }).join('') + '</select>' + busy + '</div>';
    }
    if (S.ptab === 'rent') {
      /* while another date loads, keep the dates list the panel already has */
      var R = S.data['rr:' + S.prop + ':' + (S.asOf || '')] || (S.last.rr && S.last.rr.split(':')[1] === S.prop ? S.data[S.last.rr] : null);
      var dates = R ? R.asOfDates : [];
      if (dates.length) {
        h += '<div class="lw-ctrls"><label for="lw-asof">As of</label><select id="lw-asof" class="sel" data-in="asOf">' +
          dates.map(function (d) { return '<option value="' + d + '"' + ((S.asOf || R.asOf) === d ? ' selected' : '') + '>' + dayLong(d) + '</option>'; }).join('') + '</select>' + busy + '</div>';
      }
    }
    if (EXPORTABLE[S.ptab]) {
      h += '<div style="position:relative;padding-bottom:8px">' +
        '<button class="btn press" data-a="export" aria-haspopup="menu" aria-expanded="' + S.exportOpen + '" style="display:inline-flex;align-items:center;gap:6px;color:var(--ink)">' +
        svg(ICON_DOWN, 14) + 'Export' + svg(ICON_CHEV, 12, ' stroke-width="2.2"') + '</button>' +
        (S.exportOpen ? exportMenu('xp') : '') + '</div>';
    }
    return h;
  }
  function exportMenu(prefix) {
    return '<div role="menu" class="lw-menu">' + [
      ['xlsx', 'Excel (.xlsx)', 'Every table on its own sheet, with totals and formatting'],
      ['pdf', 'PDF', 'Report layout: header, cards and tables, ready to print or send'],
      ['csv', 'CSV', 'Plain data, one table per file in a zip'],
    ].map(function (o) {
      return '<button role="menuitem" class="press" data-a="' + prefix + ':' + o[0] + '"><div style="font-weight:600">' + o[1] + '</div><div style="font-size:12px;color:var(--muted)">' + o[2] + '</div></button>';
    }).join('') + '</div>';
  }

  /* ---- Overview --------------------------------------------------------- */
  function overviewCards(p, H) {
    var per = H.window ? ymLong(H.window.from) + ' to ' + ymLong(H.window.to) : '';
    var usrc = { rent_roll: 'Latest rent roll', verified: 'Verified count', buildings: 'Building records' }[p.unitsSource] || 'Not on file';
    return [
      { label: 'Units', value: cnt(p.units), sub: usrc },
      { label: 'Physical occupancy', value: pct(p.occ), sub: H.rentRollAsOf ? 'Latest rent roll' : 'No rent roll on file', style: occStyle(p.occ) },
      { label: 'NOI, trailing 12 mo', value: money(p.noi), sub: per, style: p.noi < 0 ? C('bad') : '' },
      { label: 'Best NOI, latest', value: p.opt ? money(p.opt) : 'None', sub: p.opt ? 'Months above the 12-month average, to the latest month' : 'Latest month is not above the 12-month average', style: p.opt ? C('ok') : C('muted') },
      { label: 'Cash flow after debt and capex', value: money(p.cf), sub: 'NOI less fee, debt service and capex' },
      { label: 'Market value', value: p.value ? money(p.value) : DASH, sub: p.value ? (p.valueAsOf ? 'On file, ' + dayLong(p.valueAsOf) : 'On file, no date') : 'No valuation on file',
        tag: p.value ? 'Outdated' : '', style: p.value ? '' : C('bad') },
      { label: 'Debt', value: money(p.debt), sub: p.debt ? 'Loan records' : 'No loan on file' },
      { label: 'DSCR, mortgage', value: ratio(p.dscr), sub: p.dscr === null ? 'No debt service on file' : 'Required 1.25',
        style: p.dscr === null ? C('bad') : dscrStyle(p.dscr) },
    ];
  }
  function overviewHtml(p, H) {
    var d = [
      ['Managing entity', p.mgr || 'Not on file', p.mgr ? '' : C('warn')], ['Property manager', p.pm || DASH], ['Owner', p.owner || DASH],
      ['Address', p.address || DASH], ['Report source', p.src], ['Units', cnt(p.units)], ['Occupancy', pct(p.occ)],
      ['Market value', money(p.value)], ['Value date', p.value ? (p.valueAsOf ? dayLong(p.valueAsOf) : 'Not on file') : DASH],
      ['Debt on file', money(p.debt)], ['Total income, 12 mo', money(p.inc)], ['Total expenses, 12 mo', money(p.opx)],
    ];
    return '<div class="view" style="margin-top:16px"><section class="frame" style="padding:16px 18px"><h2 class="h2">Property details</h2>' +
      '<div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:0 24px;margin-top:8px">' +
      d.map(function (x) { return '<div class="lw-kv"><span>' + esc(x[0]) + '</span><span style="' + (x[2] || '') + '">' + esc(x[1]) + '</span></div>'; }).join('') +
      '</div></section></div>';
  }

  /* ---- Needs attention -------------------------------------------------- */
  function attentionHtml(p, H) {
    var h = '<div class="view" style="margin-top:16px"><section class="frame" style="padding:16px 18px"><h2 class="h2">Needs attention</h2>';
    if (!H.flags.length) h += '<p class="note" style="margin-top:8px">Nothing needs attention. Checked: coverage, vacancy, operating loss, delinquency, lease expirations, data gaps.</p>';
    h += '<div style="display:flex;flex-direction:column;gap:10px;margin-top:10px">' + H.flags.map(function (f) {
      return '<div style="display:flex;gap:10px;align-items:flex-start"><span class="lw-level lw-lv-' + f.sev + '">' + esc(f.level) + '</span>' +
        '<div><div style="font-weight:600">' + esc(f.title) + '</div><div style="font-size:13px;margin-top:3px;line-height:1.5">' + esc(f.detail) +
        '</div><div style="font-size:13px;margin-top:4px">' + esc(f.next) + '</div><div style="font-size:12px;margin-top:4px;color:var(--muted)">' + esc(f.source) + '</div></div></div>';
    }).join('') + '</div></section></div>';
    return h;
  }

  /* ---- Buildings & units ------------------------------------------------ */
  function buildingsHtml(p) {
    var key = 'b:' + S.prop, D = need(key, '/api/props/' + S.prop + '/buildings');
    if (!D) return errOf(key) ? errorBox(errOf(key)) : loading('buildings and units');
    var B = D.buildings, rrUnits = D.rentRollUnits;
    var main = B.filter(function (x) { return x[2] !== null || (x[3] !== null && x[3] > 0); });
    var other = B.filter(function (x) { return !(x[2] !== null || (x[3] !== null && x[3] > 0)); });
    var known = function (i) { return main.map(function (x) { return x[i]; }).filter(function (v) { return v !== null && v !== undefined && v !== ''; }); };
    var unitsKnown = known(3);
    var bldUnits = unitsKnown.length ? sum(unitsKnown) : null;
    var years = known(4).map(function (y) { return parseInt(String(y), 10); }).filter(function (y) { return y > 1800; });
    var sq = known(7), stories = known(6).map(Number).filter(function (v) { return v > 0; });
    var cons = known(5), counts = {};
    cons.forEach(function (c) { counts[c] = (counts[c] || 0) + 1; });
    var consTop = cons.length ? Object.keys(counts).sort(function (a, b) { return counts[b] - counts[a]; })[0] : null;
    var spr = main.filter(function (x) { return x[9] !== null; }), sprYes = spr.filter(function (x) { return x[9]; }).length;
    var range = function (a) { if (!a.length) return DASH; var lo = Math.min.apply(null, a), hi = Math.max.apply(null, a); return lo === hi ? String(lo) : lo + ' to ' + hi; };
    var cards = [
      { label: 'Buildings', value: String(main.length), sub: other.length ? '+ ' + other.length + ' other structures' : 'On file' },
      { label: 'Units, building records', value: bldUnits === null ? DASH : String(bldUnits), sub: unitsKnown.length + ' of ' + main.length + ' buildings have a count',
        style: bldUnits !== null && rrUnits !== null && bldUnits !== rrUnits ? C('warn') : '' },
      { label: 'Units, rent roll', value: rrUnits === null ? DASH : String(rrUnits), sub: D.rentRollAsOf ? dayLong(D.rentRollAsOf) : 'No rent roll on file' },
      { label: 'Year built', value: range(years), sub: years.length ? years.length + ' of ' + main.length + ' buildings' : 'Not on file' },
      { label: 'Square feet', value: sq.length ? sum(sq).toLocaleString('en-US') : DASH, sub: sq.length ? sq.length + ' of ' + main.length + ' buildings' : 'Not on file' },
      { label: 'Stories', value: range(stories), sub: '' },
      { label: 'Construction', value: consTop || DASH, sub: cons.length ? cons.length + ' of ' + main.length + ' buildings' : 'Not on file', style: 'font-size:15px' },
      { label: 'Sprinklered', value: spr.length ? sprYes + ' of ' + spr.length : DASH, sub: spr.length ? 'Buildings with a record' : 'Not on file' },
    ];
    var checks = [];
    if (!B.length) checks.push('No building records on file for this property.' + (rrUnits !== null ? ' The rent roll shows ' + rrUnits + ' units.' : ''));
    if (bldUnits !== null && rrUnits !== null && bldUnits !== rrUnits) checks.push('Building records add up to ' + bldUnits + ' units, but the rent roll has ' + rrUnits + '. One of them needs correcting.');
    if (main.length && !unitsKnown.length) checks.push('No building has a unit count yet.');
    var yn = function (v) { return v === null || v === undefined ? DASH : v ? 'Yes' : 'No'; };
    var kinds = {};
    other.forEach(function (x) { var k = /garage/i.test(x[1]) ? 'garages' : /shed/i.test(x[1]) ? 'sheds' : 'other structures'; kinds[k] = (kinds[k] || 0) + 1; });
    var otherTxt = Object.keys(kinds).map(function (k) { return kinds[k] + ' ' + (kinds[k] === 1 ? k.replace(/s$/, '') : k); }).join(', ');
    var t = { firstW: 0, maxH: 620,
      heads: [{ label: 'No.' }, { label: 'Building', cls: 'l', style: 'min-width:150px' }, { label: 'Address', cls: 'l', style: 'min-width:300px' }, { label: 'Units' }, { label: 'Year built' },
              { label: 'Construction', cls: 'l' }, { label: 'Stories' }, { label: 'Square feet' }, { label: 'Roof year' }, { label: 'Sprinklered' }, { label: 'Fire alarm' }, { label: 'Parcel', cls: 'l' }],
      rows: main.map(function (x) {
        return { label: x[0] || DASH, cells: [
          { v: x[1], f: 'text', cls: 'l', style: 'font-weight:500' }, { v: x[2], f: 'text', cls: 'l', style: x[2] ? '' : C('muted') },
          { v: x[3], f: 'count', style: '' }, { v: x[4], f: 'text' }, { v: x[5], f: 'text', cls: 'l' }, { v: x[6], f: 'text' },
          { v: x[7], f: 'count', style: '' }, { v: x[8], f: 'text' }, { v: yn(x[9]), f: 'text' }, { v: yn(x[10]), f: 'text' }, { v: x[11], f: 'text', cls: 'l' }] };
      }) };
    return '<div class="view" style="margin-top:14px">' + cardsHtml(cards) +
      checks.map(function (c) { return '<div style="margin-top:10px;padding:8px 12px;border-radius:6px;background:var(--warnBg);color:var(--warn);font-size:13px">' + esc(c) + '</div>'; }).join('') +
      (main.length ? '<h2 class="h2" style="margin-top:20px">Buildings</h2><div style="margin-top:8px">' + tableHtml(t) + '</div>' : '') +
      (otherTxt ? '<p class="note" style="margin-top:8px">Also on file: ' + esc(otherTxt) + '.</p>' : '') + '</div>';
  }

  /* ---- Monthly financials ----------------------------------------------- */
  function monthlyModel(p) {
    var pf = periodFromTo();
    var key = 'm:' + S.prop + ':' + pf.from + ':' + pf.to;
    var got = needOr('m', key, '/api/props/' + S.prop + '/monthly?from=' + pf.from + '&to=' + pf.to), D = got.D;
    if (!D) return { pending: true, error: errOf(key) };
    var se = D.series, requested = D.months.length;
    /* months with no data are hidden: Oct-Dec 2025 are being backfilled and
       show nothing rather than an estimate */
    var keep = D.months.map(function (m, i) { return i; }).filter(function (i) { return isNum(se.inc[i]); });
    var pick = function (a) { return keep.map(function (i) { return a ? (isNum(a[i]) ? a[i] : null) : null; }); };
    var z = function (a) { return a.map(function (v) { return v === null ? 0 : v; }); };
    var labels = keep.map(function (i) { return D.labels[i]; });
    var n = keep.length;
    var ST = D.statements;
    var lineSum = function (lines) { return keep.map(function (i) { return lines.reduce(function (a, l) { return a + (isNum(l[1][i]) ? l[1][i] : 0); }, 0); }); };
    var hasSt = ST.income.length + ST.expense.length > 0;
    var stInc = lineSum(ST.income), stOpx = lineSum(ST.expense), stNonInc = lineSum(ST.nonopIncome), stNonExp = lineSum(ST.nonopExpense);
    var stNoi = stInc.map(function (v, j) { return v - stOpx[j]; });
    var netIncome = stNoi.map(function (v, j) { return v + stNonInc[j] - stNonExp[j]; });

    var inc = pick(se.inc), opx = pick(se.opx), noi = pick(se.noi), capex = z(pick(se.capex)), am = z(pick(se.am)), ds = pick(se.ds), cf = pick(se.cashFlow);
    var ti = sum(inc), te = sum(opx), tn = sum(noi), tc = sum(capex), td = sum(ds.filter(isNum)), tcf = sum(cf);
    var dsc = td ? tn / td : null;
    var span = n ? labels[0] + ' to ' + labels[n - 1] : '';
    var cover = n === requested ? span : span + ', ' + n + ' of ' + requested + ' months have data';
    var tiles = [
      { label: 'Total income', value: money(ti), sub: n ? cover : 'No data in this period' },
      { label: 'Total expenses', value: money(te), sub: ti ? pct(te / ti) + ' of income' : DASH, style: ti && te / ti > 0.6 ? C('warn') : '' },
      { label: 'Net operating income', value: money(tn), sub: n ? money(tn / n) + ' a month' : DASH, style: n ? C(tn < 0 ? 'bad' : 'ok') : '' },
      { label: 'Capital expenses', value: money(tc), sub: ti ? pct(tc / ti) + ' of income' : DASH },
      { label: 'Debt service', value: td ? money(td) : DASH, sub: td ? (D.dsSource.indexOf('Loan record') === 0 ? 'Loan record' : 'Paid in the books') : 'Not on file', style: td ? '' : C('bad') },
      { label: 'DSCR', value: dsc === null || tn <= 0 ? DASH : dsc.toFixed(2), sub: tn <= 0 && td ? 'Operating loss, no coverage' : 'Required 1.25', style: dsc === null || tn <= 0 ? (td ? '' : C('bad')) : dscrStyle(dsc) },
      { label: 'Net income', value: hasSt ? money(sum(netIncome)) : DASH, sub: hasSt ? 'For the period' : 'Needs the full income statement', style: hasSt ? '' : C('muted') },
      { label: 'Cash after debt and capex', value: money(tcf), sub: 'NOI less fee, debt, capex', style: n ? C(tcf < 0 ? 'bad' : 'ok') : '' },
    ];

    var heads = [{ label: p.name }].concat(labels.map(function (l) { return { label: l }; }), [{ label: 'Average', cls: 'sep' }, { label: 'Total' }]);
    var row = function (label, a, o) {
      o = o || {};
      var f = o.f || 'money2';
      var empty = !a || a.every(function (v) { return !isNum(v); });
      var vals = a || labels.map(function () { return null; });
      var cells = vals.map(function (v) { return { v: v, f: f, style: !isNum(v) ? C('muted') : (o.cell ? o.cell(v) : v < 0 ? C('bad') : '') }; });
      var av = o.avg !== undefined ? o.avg : avg(vals);
      cells.push({ v: empty ? null : av, f: f, cls: 'sep', style: o.key ? 'font-weight:600' : '' });
      cells.push({ v: empty || o.noTot ? null : sum(vals), f: f, style: o.key ? 'font-weight:600' : '', html: empty || o.noTot ? '' : undefined });
      return { label: label, empty: empty, kind: o.key ? 'key' : o.group ? 'group' : '', band: !!o.band || /^(Total|Net |Cash from|Net cash|Cash flow)/.test(label),
               labelStyle: o.indent ? 'padding-left:28px;color:var(--muted)' : '', cells: cells };
    };
    var head = function (label) { return { label: label, kind: 'group', labelStyle: '', cells: labels.map(function () { return { v: '', f: 'text', html: '' }; }).concat([{ v: '', f: 'text', html: '', cls: 'sep' }, { v: '', f: 'text', html: '' }]) }; };
    var ratioA = function (x, y) { return x.map(function (v, i) { return !isNum(v) || !y[i] ? null : v / y[i]; }); };
    var okBad = function (v) { return C(v < 0 ? 'bad' : 'ok'); };
    var units = keep.map(function (i) { return isNum(se.units[i]) ? se.units[i] : p.units; });
    var summary = [
      row('Units', units, { f: 'count', cell: function () { return ''; }, avg: p.units, noTot: true }),
      row('Rent income', pick(se.rent)), row('Recurring fee income', pick(se.recurringFee)), row('Non-recurring fee income', pick(se.nonRecurringFee)),
      row('Total expected income', pick(se.expected)),
      row('Total operating income', inc), row('Total operating expense', opx),
      row('Net operating income', noi, { key: true, band: true, cell: okBad }),
      row('Expense ratio', ratioA(opx, inc), { f: 'pct', cell: function (v) { return v > 0.6 ? C('warn') : ''; }, avg: ti ? te / ti : null, noTot: true }),
      row('Capital expense', capex), row('Capex ratio', ratioA(capex, inc), { f: 'pct', cell: function () { return ''; }, avg: ti ? tc / ti : null, noTot: true }),
      row('Cash flow', cf, { key: true, cell: okBad }),
      row('Delinquency', pick(se.delinq), { avg: null, noTot: true }),
      row('Asset management fee', am), row('Asset management fee %', ratioA(am, inc), { f: 'pct', cell: function () { return ''; }, avg: ti ? sum(am) / ti : null, noTot: true }),
      row('Physical occupancy', pick(se.occ), { key: true, f: 'pct', cell: function (v) { return occStyle(v) || C('ok'); }, avg: null, noTot: true }),
      row('Economic occupancy', pick(se.econOcc), { f: 'pct', cell: function () { return ''; }, avg: null, noTot: true }),
      row('Debt service, mortgage', ds),
      row('DSCR, mortgage', ratioA(noi, ds), { key: true, band: true, f: 'ratio', cell: dscrStyle, avg: td ? sum(noi.filter(function (v, j) { return isNum(ds[j]); })) / td : null, noTot: true }),
      row('Loss to lease', pick(se.ltl), { avg: null, noTot: true }),
    ].filter(function (r) { return !r.empty; });
    var outside = n < requested ? ' Months with no income statement loaded are hidden; Oct to Dec 2025 are being backfilled and appear once loaded.' : '';
    var tables = [{ title: 'Summary', heads: heads, rows: summary, maxH: 620, firstW: 260,
      note: 'Key figures by month, cash basis, from ' + p.src + '. Debt service: ' + D.dsSource.charAt(0).toLowerCase() + D.dsSource.slice(1) +
            '. Cash flow here is NOI less asset management fee, debt service and capex.' + outside }];
    var lineRows = function (lines) { return lines.map(function (l) { return row(sentence(l[0]), pick(l[1]), { indent: true }); }).filter(function (r) { return !r.empty; }); };
    if (hasSt) {
      var isRows = [head('Operating income')].concat(lineRows(ST.income), [row('Total operating income', stInc, { key: true })],
        [head('Operating expenses')], lineRows(ST.expense), [row('Total operating expense', stOpx, { key: true })],
        [row('Net operating income', stNoi, { key: true, band: true, cell: okBad })],
        ST.nonopIncome.length ? [head('Non-operating income')].concat(lineRows(ST.nonopIncome), [row('Total non-operating income', stNonInc, { key: true })]) : [],
        ST.nonopExpense.length ? [head('Non-operating expenses')].concat(lineRows(ST.nonopExpense), [row('Total non-operating expenses', stNonExp, { key: true })]) : [],
        [row('Net income', netIncome, { key: true, band: true, cell: okBad })]);
      tables.push({ title: 'Income statement', heads: heads, rows: isRows, maxH: 620, firstW: 260,
        note: 'Income statement by month, cash basis, from ' + p.src + '. Capital expenses, debt interest and the asset management fee sit below NOI, so they reduce net income but not NOI.' + outside });
      var opAdj = lineSum(ST.operating), fin = lineSum(ST.financing), inv = lineSum(ST.investing);
      var cfo = netIncome.map(function (v, j) { return v + opAdj[j]; });
      var net = cfo.map(function (v, j) { return v + fin[j] + inv[j]; });
      var cfRows = [row('Net income', netIncome, { key: true })];
      if (ST.operating.length) cfRows = cfRows.concat([head('Changes in operating balances')], lineRows(ST.operating));
      cfRows.push(row('Cash from operations', cfo, { key: true, cell: okBad }));
      if (ST.financing.length) cfRows = cfRows.concat([head('Financing and owner activity')], lineRows(ST.financing), [row('Cash from financing', fin, { key: true })]);
      /* investing: only the three properties that book a purchase here have
         any; hidden everywhere else */
      if (ST.investing.length) cfRows = cfRows.concat([head('Investing')], lineRows(ST.investing), [row('Cash from investing', inv, { key: true })]);
      cfRows.push(row('Net cash flow', net, { key: true, band: true, cell: okBad }));
      tables.push({ title: 'Cash flow statement', heads: heads, rows: cfRows, maxH: 620, firstW: 260,
        note: 'Cash flow statement by month: net income adjusted for deposits, prepaid rent, escrows and clearing balances, then loan principal, credit-line draws, owner activity and any purchases. Capital expenses are already deducted in net income. Beginning and ending bank balances come from the manager’s cash report and are not in these books.' + outside });
    }
    return { cards: tiles, tables: tables, empty: !n, stale: got.stale };
  }
  function monthlyHtml(p) {
    var M = monthlyModel(p);
    if (M.pending) return M.error ? errorBox(M.error) : loading('monthly financials');
    S.exportModel = M.stale ? null : M;
    if (M.empty) return '<div class="frame view' + staleCls(M) + '" style="margin-top:16px;padding:18px;color:var(--muted)">No income statement is loaded for these months. Choose a period inside the months on file.</div>';
    return '<div class="view' + staleCls(M) + '" style="margin-top:14px"><div style="margin-bottom:14px">' + cardsHtml(M.cards) + '</div>' +
      M.tables.map(function (t) {
        return '<h2 class="h2" style="margin:20px 0 4px">' + esc(t.title) + '</h2><p class="note" style="margin-bottom:8px">' + esc(t.note) + '</p>' + tableHtml(t);
      }).join('') + '</div>';
  }

  /* ---- Optimized NOI ---------------------------------------------------- */
  function nIn(v) { var x = parseFloat(v); return isFinite(x) ? x : null; }
  function optimizedModel(p) {
    var key = 'o:' + S.prop, D = need(key, '/api/props/' + S.prop + '/optimized');
    if (!D) return { pending: true, error: errOf(key) };
    var L12 = D.labels, NN = D.noi;
    var avail = NN.map(function (v, i) { return isNum(v) ? i : -1; }).filter(function (i) { return i >= 0; });
    var nA = avail.length;
    var trailing = nA ? sum(NN) * 12 / nA : null;
    /* Best NOI (Jay, 2026-10-13): the unbroken run of months above the
       12-month average that ends at the latest month (none when the latest
       month is below it), and the most recent such run before it. Computed by
       the server (props-api bestRuns), the same rule as
       property_summary.optimized_noi. */
    var TW = D.trailing || { windows: [] };
    var BR = D.best || {};
    var bw = BR.latest || null, pw = BR.previous || null;
    var noneWhy = BR.end ? ymShort(BR.end) + ' is below the 12-month average of ' + money(BR.average) + ' a month' : 'No NOI on file';
    var wLab = function (w) { return w.k === 1 ? ymShort(w.to) : ymShort(w.from) + ' to ' + ymShort(w.to); };
    var std = { req: '1.25', rate: '6.5', amort: '30', cap: '7', ltv: '75', loan: D.loan ? String(Math.round(D.loan)) : '', ds: D.debtService ? String(Math.round(D.debtService)) : '' };
    var cur = Object.assign({}, std, S.oa[S.prop] || {});
    var edited = Object.keys(std).some(function (k) { return cur[k] !== std[k]; });
    var req = nIn(cur.req) || 1.25, rate = nIn(cur.rate) ? nIn(cur.rate) / 100 : null, yrs = nIn(cur.amort), cap = nIn(cur.cap) ? nIn(cur.cap) / 100 : null, loan = nIn(cur.loan), ds = nIn(cur.ds);
    var ltv = nIn(cur.ltv) ? nIn(cur.ltv) / 100 : null;
    var k2 = rate && yrs ? 12 * (rate / 12) / (1 - Math.pow(1 + rate / 12, -yrs * 12)) : null;
    var optimized = bw ? bw.annual : null;
    var dOf = function (v) { return ds && isNum(v) ? v / ds : null; };
    var dT = dOf(trailing), dO = dOf(optimized !== null ? optimized : trailing);
    var grp;
    if (!ds) grp = { name: 'No debt service on file', style: C('muted') };
    else if (dT !== null && dT >= req) grp = { name: 'Safe', style: C('ok') };
    else if (dO !== null && dO >= req) grp = { name: 'Fixable', style: C('warn') };
    else if (dO !== null && dO >= 1) grp = { name: 'At risk', style: C('warn') };
    else grp = { name: 'Critical', style: C('bad') };
    var wRaw = (S.wnoi || {})[S.prop];
    var wDefault = optimized !== null ? optimized : (trailing || 0);
    var W = wRaw !== undefined && wRaw !== '' && nIn(wRaw) !== null ? nIn(wRaw) : wDefault;
    var srow = function (name, months, rec, noi, cls) {
      var d = isNum(noi) && noi > 0 ? dOf(noi) : null, maxL = k2 && noi > 0 ? noi / req / k2 : null, vs = maxL !== null && loan !== null ? maxL - loan : null;
      return { label: name, kind: cls === 'key' ? 'key' : '', band: cls === 'key', cells: [
        { v: months, f: 'text', cls: 'l', style: C('muted') },
        { v: rec, f: 'text', cls: 'l', style: C('muted'), html: rec ? undefined : '' },
        { v: noi, f: 'money', style: '' },
        { v: d, f: 'ratio', cls: 'sep', style: d === null ? C('muted') : dscrStyle(d) },
        { v: d === null ? null : (d >= req ? 'Yes' : 'No'), f: 'text', style: d === null ? C('muted') : d >= req ? C('ok') : C('bad') },
        { v: maxL, f: 'money', style: '' },
        { v: vs, f: 'money', style: vs === null ? C('muted') : vs >= 0 ? C('ok') : C('bad'), html: vs === null ? DASH : esc((vs >= 0 ? '+' : '') + money(vs)), exportText: vs },
        { v: cap && noi > 0 ? noi / cap : null, f: 'money', cls: 'sep', style: '' },
      ] };
    };
    var mult = function (k) { var x = 12 / k; return 'x ' + (x % 1 ? x.toFixed(1) : x); };
    var scen = [
      bw ? srow('Best NOI, latest (T' + bw.k + ')', wLab(bw), mult(bw.k), bw.annual, 'key')
         : srow('Best NOI, latest', 'None: ' + noneWhy, '', null, 'key'),
      pw ? srow('Previous best NOI (T' + pw.k + ')', wLab(pw), mult(pw.k), pw.annual)
         : srow('Previous best NOI', 'None before ' + (bw ? wLab(bw) : 'the latest month'), '', null),
      srow('What-if', 'Your number', '', W)];
    var maxLOpt = k2 && optimized > 0 ? optimized / req / k2 : null;
    var vsOpt = maxLOpt !== null && loan !== null ? maxLOpt - loan : null;
    var cards = [
      { label: 'Status', value: grp.name, sub: ds ? 'Required DSCR ' + req.toFixed(2) : 'Debt service not on file', style: grp.style },
      { label: 'NOI, trailing 12 mo', value: money(trailing), sub: nA < 12 ? 'Annualized from ' + nA + ' months' : L12[0] + ' to ' + L12[11] },
      { label: 'Best NOI, latest', value: bw ? money(optimized) : 'None', sub: bw ? 'T' + bw.k + ', ' + wLab(bw) : (pw ? 'Previous best T' + pw.k + ', ' + wLab(pw) + ', ' + money(pw.annual) : noneWhy), style: bw ? C('ok') : C('muted') },
      { label: 'DSCR, trailing', value: dT === null || trailing <= 0 ? DASH : dT.toFixed(2), sub: ds ? '' : 'No debt service on file', style: dT === null || trailing <= 0 ? (ds ? '' : C('bad')) : dscrStyle(dT) },
      { label: 'DSCR, best NOI', value: optimized === null || dOf(optimized) === null ? DASH : dOf(optimized).toFixed(2), sub: ds ? '' : 'No debt service on file', style: optimized === null || dOf(optimized) === null ? (ds ? '' : C('bad')) : dscrStyle(dOf(optimized)) },
      { label: 'Max loan, best NOI', value: money(maxLOpt), sub: rate && yrs ? cur.rate + '%, ' + cur.amort + ' yrs' : '' },
      { label: 'Compared with current loan', value: vsOpt === null ? DASH : (vsOpt >= 0 ? '+' : '') + money(vsOpt), sub: loan ? 'Current ' + money(loan) : 'No loan on file', style: vsOpt === null ? '' : vsOpt >= 0 ? C('ok') : C('bad') },
      { label: 'Value, best NOI', value: cap && optimized > 0 ? money(optimized / cap) : DASH, sub: 'At ' + cur.cap + '% cap, estimate' },
    ];
    var inRun = function (w, i) { return !!w && D.months[i] >= w.from && D.months[i] <= w.to; };
    var dot = function (w) { return function (i) { var on = inRun(w, i); return { v: on ? '●' : '', f: 'text', html: on ? '●' : '', style: on ? C('ok') + ';text-align:center' : '', exportText: on ? 'Yes' : '' }; }; };
    var vals = avail.map(function (i) { return NN[i]; });
    var hi = Math.max.apply(null, vals.concat([1])), nonneg = vals.filter(function (v) { return v >= 0; });
    var lo = nonneg.length ? Math.min.apply(null, nonneg) : hi;
    var heat = function (v) { if (v < 0) return 'background:var(--badBg);' + C('bad') + ';'; var f = hi > lo ? (v - lo) / (hi - lo) : 1; return 'background:color-mix(in srgb, var(--ok) ' + Math.round(8 + f * 40) + '%, transparent);'; };
    var heatT = { title: 'NOI heat map', firstW: 200,
      heads: [{ label: '' }].concat(avail.map(function (i) { return { label: L12[i] }; })),
      rows: [
        { label: 'NOI', kind: 'key', cells: avail.map(function (i) { return { v: NN[i], f: 'money2', style: heat(NN[i]) + (isNum(BR.average) && NN[i] > BR.average ? 'font-weight:600;' : '') }; }) },
        { label: 'Best NOI, latest' + (bw ? ' (T' + bw.k + ')' : ': none'), cells: avail.map(dot(bw)) },
        { label: 'Previous best NOI' + (pw ? ' (T' + pw.k + ')' : ': none'), cells: avail.map(dot(pw)) },
      ] };
    var scenT = { title: 'What it earns, and what that supports', firstW: 260,
      heads: [{ label: 'What it earns, and what that supports' }, { label: 'Months', cls: 'l' }, { label: 'Annualized', cls: 'l' }, { label: 'Annual NOI' }, { label: 'DSCR', cls: 'sep' },
              { label: 'Meets?' }, { label: 'Max loan' }, { label: 'Compared with current loan' }, { label: 'Value at cap rate', cls: 'sep' }],
      rows: scen };
    /* Side by side (Jay, 2026-10-13): the assumptions next to what is real
       today, column for column, so the gap is visible. Rows: your inputs;
       the current loans on file; the debt service actually paid in the
       books; and what a new loan sized on today's T12 would look like, which
       is the answer for a property with no loan. Every DSCR is on the same two
       NOIs: trailing 12 months and best NOI, latest. */
    var LN = D.loans, longest = TW.windows.length ? TW.windows[TW.windows.length - 1] : null;
    var dscrOn = function (noi, dsA) { return isNum(noi) && noi > 0 && dsA > 0 ? noi / dsA : null; };
    var ratePct = function (r) { return isNum(r) ? (Math.round(r * 100) / 100) + '%' : null; };
    var crow = function (label, o, key) {
      var dT2 = o.dT !== undefined ? o.dT : dscrOn(trailing, o.ds), dB = o.dB !== undefined ? o.dB : dscrOn(optimized, o.ds);
      return { label: label, kind: key ? 'key' : '', band: !!key, cells: [
        { v: o.loan, f: 'money', style: '' },
        { v: ratePct(o.rate), f: 'text', style: isNum(o.rate) ? '' : C('muted') },
        { v: o.ds, f: 'money', style: '' },
        { v: dT2, f: 'ratio', cls: 'sep', style: isNum(dT2) ? dscrStyle(dT2) : C('muted') },
        { v: dB, f: 'ratio', style: isNum(dB) ? dscrStyle(dB) : C('muted') },
        { v: isNum(dT2) ? (dT2 >= req ? 'Yes' : 'No') : null, f: 'text', style: !isNum(dT2) ? C('muted') : dT2 >= req ? C('ok') : C('bad') },
        { v: o.note || '', f: 'text', cls: 'l sep', style: C('muted') + ';font-weight:400;white-space:normal;min-width:300px;max-width:440px' },
      ] };
    };
    var cmp = [crow('Assumptions', { loan: loan, rate: rate ? rate * 100 : null, ds: ds,
      note: edited ? 'Your inputs (changed, not saved)' : 'Standard values; loan and debt service from ' + (D.debtService ? D.debtServiceSource.toLowerCase() : 'nothing on file') }, true)];
    if (LN) {
      var lnNote = LN.count + (LN.count === 1 ? ' loan' : ' loans') +
        (LN.balanceKnown < LN.count ? ', balance on ' + LN.balanceKnown + ' of ' + LN.count : '') +
        (LN.debtServiceKnown < LN.count ? ', debt service on ' + LN.debtServiceKnown + ' of ' + LN.count : '') +
        (LN.ratesKnown < LN.count ? ', rate on ' + LN.ratesKnown + ' of ' + LN.count : '') +
        (LN.maturity ? '; first maturity ' + dayLong(LN.maturity) : '');
      cmp.push(crow('Current loans, on file', { loan: isNum(LN.balance) ? LN.balance : D.loan, rate: LN.rate, ds: LN.debtService > 0 ? LN.debtService : null, note: lnNote }));
    } else {
      cmp.push(crow('Current loans, on file', { loan: null, rate: null, ds: null, note: 'No current loan on file' }));
    }
    /* only a payment the books actually carry is "actual"; where the monthly
       figure falls back to the loan record, this row would repeat the one above */
    var srcCode = D.debtServiceMonthlySourceCode;
    var inBooks = srcCode === 'income_statement' || srcCode === 'interest_only_books';
    var paidA = inBooks && longest && isNum(longest.dsPaid) && longest.dsMonths ? longest.dsPaid * 12 / longest.dsMonths : null;
    var srcTxt = srcCode === 'interest_only_books' ? '; interest only, no principal recorded, so coverage is overstated' : '';
    var paidNote = !longest ? 'No NOI on file' :
      srcCode === 'loan_record' ? 'The payment is not in the books; monthly coverage uses the loan record (the row above)' :
      paidA === null ? 'No debt service in the books' :
      'Paid ' + (longest.k === 1 ? ymShort(longest.to) : ymShort(longest.from) + ' to ' + ymShort(longest.to)) + ', annualized' +
      (longest.dsMonths < longest.k ? ' from the ' + longest.dsMonths + ' of ' + longest.k + ' months with debt service in the books' : '') +
      (isNum(longest.dscrAll) && isNum(longest.dscr) && Math.abs(longest.dscrAll - longest.dscr) >= 0.005 ? '; all debt ' + longest.dscrAll.toFixed(2) : '') + srcTxt;
    cmp.push(crow('Actual, from the books', { loan: null, rate: null, ds: paidA,
      dT: paidA !== null ? longest.dscr : null, dB: paidA !== null && bw && isNum(bw.dscr) ? bw.dscr : null, note: paidNote }));
    var byDscr = k2 && trailing > 0 ? trailing / req / k2 : null;
    var valueT = cap && trailing > 0 ? trailing / cap : null;
    var byLtv = ltv && valueT ? valueT * ltv : null;
    var newLoan = byDscr !== null && byLtv !== null ? Math.min(byDscr, byLtv) : (byDscr !== null ? byDscr : byLtv);
    var curLoan = LN && isNum(LN.balance) ? LN.balance : D.loan;
    var ltvBinds = byLtv !== null && (byDscr === null || byLtv < byDscr);
    var newNote = newLoan === null ? (trailing > 0 ? 'Needs a rate, amortization and cap rate' : 'NOI is not positive; no loan can be sized') :
      'Limited by ' + (ltvBinds ? cur.ltv + '% of ' + money(valueT) + ' value at ' + cur.cap + '% cap' : 'DSCR ' + req.toFixed(2)) +
      '; ' + cur.rate + '%, ' + cur.amort + ' yrs' +
      (isNum(curLoan) && curLoan > 0 ? '; ' + (newLoan - curLoan >= 0 ? '+' : '') + money(newLoan - curLoan) + ' against current loans' : '');
    cmp.push(crow('New loan today, sized on T12', { loan: newLoan, rate: rate ? rate * 100 : null, ds: newLoan !== null && k2 ? newLoan * k2 : null, note: newNote }));
    var cmpT = { title: 'Assumptions against what is real today', firstW: 220,
      heads: [{ label: 'Side by side' }, { label: 'Loan balance' }, { label: 'Rate' }, { label: 'Annual debt service' },
              { label: 'DSCR, T12 NOI', cls: 'sep' }, { label: 'DSCR, best NOI' }, { label: 'Meets ' + req.toFixed(2) + '?' }, { label: 'Basis', cls: 'l sep' }],
      rows: cmp };
    return { cards: cards, tables: [cmpT, scenT, heatT], cur: cur, edited: edited, cmpT: cmpT, wEdited: wRaw !== undefined, wInput: wRaw !== undefined ? wRaw : String(Math.round(W)),
             loanPh: D.loan ? 'On file' : 'Not on file', dsPh: D.debtService ? D.debtServiceSource : 'Not on file',
             period: L12[0] + ' to ' + L12[L12.length - 1], scenT: scenT, heatT: heatT };
  }
  function optimizedHtml(p) {
    var M = optimizedModel(p);
    if (M.pending) return M.error ? errorBox(M.error) : loading('optimized NOI');
    S.exportModel = M;
    var inp = function (lbl, k, step, suffix, wide, ph) {
      return '<label>' + lbl + ' <input class="inp' + (wide ? ' wide' : '') + '" type="number" step="' + step + '" value="' + esc(M.cur[k]) + '"' + (ph ? ' placeholder="' + esc(ph) + '"' : '') + ' data-in="oa:' + k + '">' + (suffix ? ' ' + suffix : '') + '</label>';
    };
    return '<div class="view" style="margin-top:14px">' + cardsHtml(M.cards) +
      '<section class="frame" style="margin-top:16px;overflow:hidden">' +
      '<div style="display:flex;align-items:center;gap:10px 16px;flex-wrap:wrap;padding:12px 16px;background:var(--band);border-bottom:1px solid var(--rule);font-size:13px;color:var(--muted)">' +
      '<span style="font-weight:600;color:var(--ink)">Assumptions</span>' +
      inp('Required DSCR', 'req', '0.05') + inp('New loan rate', 'rate', '0.125', '%') + inp('Amortization', 'amort', '5', 'yrs') + inp('Cap rate', 'cap', '0.25', '%') + inp('Max LTV', 'ltv', '5', '%') +
      inp('Loan balance', 'loan', '1000', '', true, M.loanPh) + inp('Annual debt service', 'ds', '1000', '', true, M.dsPh) +
      '<label>What-if NOI <input class="inp wide" type="number" step="1000" value="' + esc(M.wInput) + '" data-in="wnoi"></label>' +
      '<span style="margin-left:auto">' + (M.edited || M.wEdited ? 'Changed, not saved' : 'Standard values') + '</span>' +
      (M.edited ? '<button class="link" data-a="oareset">Reset</button>' : '') + (M.wEdited ? '<button class="link" data-a="wreset">Reset what-if</button>' : '') +
      '</div>' + tableHtml(M.cmpT).replace('class="scroll frame"', 'class="scroll"') +
      '<div style="border-top:1px solid var(--rule)">' + tableHtml(M.scenT).replace('class="scroll frame"', 'class="scroll"') + '</div></section>' +
      '<h2 class="h2" style="margin-top:20px">NOI heat map</h2><div style="margin-top:8px">' + tableHtml(M.heatT) + '</div>' +
      '<div class="lw-legend"><span><span class="lw-sw" style="color:var(--ok)">●</span>Months in the best NOI run</span><span>Bold: above the 12-month average</span></div>' +
      '<p class="note" style="margin-top:8px">A month is good when its NOI is above the 12-month average. Best NOI is the unbroken run of good months ending at the latest month, annualized: T2 if August and September, T1 if September alone; none if September is below the average. Previous best is the most recent run of good months before it. Side by side puts the assumptions next to the current loans on file, the debt service actually paid in the books (actual DSCR is NOI divided by what was paid over the same months), and a new loan sized today on the trailing 12 months: the smaller of what that NOI supports at the required DSCR and the max LTV of its value at the cap rate. DSCR is NOI divided by annual debt service. Max loan is what that NOI supports at the required DSCR, with payments at the new loan rate and amortization. Value is NOI divided by the cap rate, an estimate, not an appraisal. Inputs are what-if only and are never saved.</p></div>';
  }

  /* ---- Asset management fee -------------------------------------------- */
  function feeHtml(p) {
    var key = 'f:' + S.prop + ':' + S.feeYear, got = needOr('f', key, '/api/props/' + S.prop + '/fee?year=' + S.feeYear), D = got.D;
    if (!D) return errOf(key) ? errorBox(errOf(key)) : loading('the asset management fee');
    if (!D.schedule) return '<div class="frame view' + staleCls(got) + '" style="margin-top:16px;padding:18px;color:var(--muted)">No asset management fee is set up for this property.</div>';
    var a = Math.min(S.feeFrom, S.feeTo) - 1, b = Math.max(S.feeFrom, S.feeTo) - 1;
    var idx = []; for (var i = a; i <= b; i++) idx.push(i);
    var heads = [{ label: '' }].concat(idx.map(function (i) { return { label: MN[i] + ' ' + String(D.year).slice(2) }; }), [{ label: 'Total', cls: 'sep' }]);
    var vStyle = function (v) { return !isNum(v) ? C('muted') : Math.abs(v) < 1 ? C('muted') : v < 0 ? C('bad') + ';background:var(--badBg)' : C('ok'); };
    var tot = function (arr) { return sum(idx.map(function (i) { return arr[i]; })); };
    var vt = tot(D.variance);
    var t = { firstW: 120, heads: heads, rows: [
      { label: 'Expected', labelStyle: C('muted'), cells: idx.map(function (i) { return { v: D.expected[i], f: 'money2', style: '' }; }).concat([{ v: tot(D.expected), f: 'money2', cls: 'sep', style: 'font-weight:600' }]) },
      { label: 'Received', labelStyle: C('muted'), cells: idx.map(function (i) { return { v: D.received[i], f: 'money2', style: D.fromBooks[i] && isNum(D.received[i]) ? 'font-style:italic' : '' }; }).concat([{ v: tot(D.received), f: 'money2', cls: 'sep', style: 'font-weight:600' }]) },
      { label: 'Variance', labelStyle: C('muted'), cells: idx.map(function (i) { var v = D.variance[i]; return { v: v, f: 'money2', style: vStyle(v), html: isNum(v) && Math.abs(v) < 1 ? '0.00' : undefined }; })
          .concat([{ v: vt, f: 'money2', cls: 'sep', style: 'font-weight:600;' + vStyle(vt), html: isNum(vt) && Math.abs(vt) < 1 ? '0.00' : undefined }]) },
    ] };
    var facts = [['Paid by', D.schedule.group], ['Fee', D.schedule.feeText], ['Timing', D.schedule.following ? 'Following month' : 'Same month'], ['Fee row', D.schedule.label]];
    return '<div class="view' + staleCls(got) + '" style="margin-top:14px"><div style="display:flex;gap:8px 28px;flex-wrap:wrap">' +
      facts.map(function (f) { return '<div><div style="font-size:12.5px;color:var(--muted)">' + esc(f[0]) + '</div><div style="font-weight:600">' + esc(f[1]) + '</div></div>'; }).join('') +
      '</div><div style="margin-top:12px">' + tableHtml(t) + '</div>' +
      '<p class="note" style="margin-top:8px">Expected is the fee rate times the month’s gross income; managers who pay the following month are charged on the previous month’s income. Italic received amounts come from the property’s books. Differences under $1 count as matched.</p></div>';
  }

  /* ---- Rent roll -------------------------------------------------------- */
  var STATUS = { current: 'Current', notice: 'Notice', vacant_rented: 'Vacant, rented', vacant_unrented: 'Vacant, unrented', past: 'Past', future: 'Future' };
  function rentModel() {
    var key = 'rr:' + S.prop + ':' + (S.asOf || '');
    var got = needOr('rr', key, '/api/props/' + S.prop + '/rent-roll' + (S.asOf ? '?as_of=' + S.asOf : '')), D = got.D;
    if (!D) return { pending: true, error: errOf(key) };
    if (!D.rentRoll) return { none: true, stale: got.stale };
    var R = D.rentRoll;
    var units = R[0], occ = R[1], notice = R[2], vacR = R[3], vacU = R[4], rent = R[5], mktOcc = R[6], mktAll = R[7], delinq = R[8], delinqN = R[9], prepaid = R[10], exp90 = R[11], mtm = R[12], mix = R[13], exp = R[14];
    var vac = vacR + vacU, ltl = isNum(mktOcc) && rent ? mktOcc - rent : null, occP = units ? occ / units : null;
    var asOfTxt = dayLong(D.asOf);
    var cards = [
      { label: 'Units', value: String(units), sub: 'Rent roll, ' + asOfTxt },
      { label: 'Occupancy', value: pct(occP), sub: occ + ' occupied', style: occStyle(occP) },
      { label: 'Vacant', value: String(vac), sub: vacR + ' pre-leased, ' + vacU + ' not leased', style: vac ? C('warn') : '' },
      { label: 'On notice', value: String(notice), sub: notice ? 'Moving out' : 'None' },
      { label: 'Monthly rent', value: money(rent), sub: occ && rent ? money(rent / occ) + ' per occupied unit' : '' },
      { label: 'Loss to lease', value: ltl === null ? DASH : money(ltl), sub: ltl === null ? 'No market rent in this report' : pct(ltl / mktOcc) + ' below market', style: ltl > 0 ? C('warn') : '' },
      { label: 'Delinquency', value: money(delinq || 0), sub: delinqN + (delinqN === 1 ? ' tenant' : ' tenants') + (prepaid ? ', ' + money(prepaid) + ' prepaid' : ''), style: delinq ? C('bad') : '' },
      { label: 'Expiring in 90 days', value: String(exp90), sub: mtm + ' month-to-month' },
    ];
    var typeLabel = function (bd, ba) { return (bd === null ? 'Unknown' : bd === 0 ? 'Studio' : bd + ' bed') + ' / ' + (ba === null ? '?' : ba) + ' bath'; };
    var mixT = { title: 'Unit mix', firstW: 200,
      heads: [{ label: 'Unit type' }, { label: 'Units' }, { label: 'Occupied' }, { label: 'Vacant' }, { label: 'Occupancy' }, { label: 'Average rent', cls: 'sep' }, { label: 'Average market rent' }, { label: 'Below market' }],
      rows: mix.map(function (m) {
        var o = m[2] ? m[3] / m[2] : null, gap = isNum(m[4]) && isNum(m[5]) ? m[5] - m[4] : null;
        return { label: typeLabel(m[0], m[1]), cells: [{ v: m[2], f: 'count', style: '' }, { v: m[3], f: 'count', style: '' }, { v: m[2] - m[3], f: 'count', style: '' },
          { v: o, f: 'pct', style: occStyle(o) }, { v: m[4], f: 'money', cls: 'sep', style: '' }, { v: m[5], f: 'money', style: '' }, { v: gap, f: 'money', style: gap > 0 ? C('warn') : '' }] };
      }).concat([{ label: 'All units', kind: 'total', cells: [{ v: units, f: 'count', style: '' }, { v: occ, f: 'count', style: '' }, { v: units - occ, f: 'count', style: '' },
          { v: occP, f: 'pct', style: '' }, { v: occ ? rent / occ : null, f: 'money', cls: 'sep', style: '' }, { v: isNum(mktAll) && units ? mktAll / units : null, f: 'money', style: '' }, { v: null, f: 'text', html: '' }] }]) };
    var mx = Math.max.apply(null, exp.concat([1]));
    var expT = { title: 'Lease expirations, next 12 months', firstW: 200,
      heads: [{ label: '' }].concat(D.expMonths.map(function (m) { return { label: m }; })),
      rows: [
        { label: 'Leases expiring', cells: exp.map(function (c) { return { v: c || null, f: 'count', style: c ? 'background:color-mix(in srgb, var(--warn) ' + Math.round(8 + (c / mx) * 40) + '%, transparent);font-weight:600' : C('muted') }; }) },
        { label: 'Share of occupied units', cells: exp.map(function (c) { return { v: c && occ ? c / occ : null, f: 'pct', style: C('muted') }; }) },
      ] };
    var unitT = { title: 'Units', maxH: 520,
      heads: [{ label: 'Unit' }, { label: 'Beds / baths', cls: 'l' }, { label: 'Tenant', cls: 'l' }, { label: 'Status', cls: 'l' }, { label: 'Rent' }, { label: 'Market rent' }, { label: 'Below market' }, { label: 'Balance' }, { label: 'Lease ends' }],
      rows: D.units.map(function (u) {
        var gap = isNum(u.market) && isNum(u.rent) ? u.market - u.rent : null;
        var st = STATUS[u.status] || sentence(u.status) || DASH;
        return { label: u.unit, cells: [
          { v: (u.beds === null ? '?' : u.beds) + ' / ' + (u.baths === null ? '?' : u.baths), f: 'text', cls: 'l' },
          { v: u.tenant, f: 'text', cls: 'l' }, { v: st, f: 'text', cls: 'l', style: u.status === 'current' ? '' : C('warn') },
          { v: u.rent, f: 'moneyc', style: '' }, { v: u.market, f: 'moneyc', style: '' }, { v: gap, f: 'moneyc', style: gap > 0 ? C('warn') : '' },
          { v: u.balance, f: 'moneyc', style: u.balance > 0 ? C('bad') : '' }, { v: u.leaseEnd ? dayLong(u.leaseEnd) : '', f: 'text' }] };
      }) };
    var lines = D.units.length;
    return { cards: cards, tables: [mixT, expT, unitT], asOf: D.asOf, lines: lines, units: units, stale: got.stale };
  }
  function rentHtml() {
    var M = rentModel();
    if (M.pending) return M.error ? errorBox(M.error) : loading('the rent roll');
    if (M.none) { S.exportModel = null; return '<div class="frame view' + staleCls(M) + '" style="margin-top:16px;padding:18px;color:var(--muted)">No rent roll on file for this property.</div>'; }
    S.exportModel = M.stale ? null : M;
    return '<div class="view' + staleCls(M) + '" style="margin-top:14px">' + cardsHtml(M.cards) +
      M.tables.map(function (t) { return '<h2 class="h2" style="margin-top:20px">' + esc(t.title) + '</h2><div style="margin-top:8px">' + tableHtml(t) + '</div>'; }).join('') +
      '<p class="note" style="margin-top:8px">' + M.units + ' units on ' + M.lines + ' lease lines: roommates each have a line. Occupied means a current lease or one on notice. A negative balance means prepaid.</p></div>';
  }

  /* ---- Capex ------------------------------------------------------------ */
  function capexModel() {
    var pf = periodFromTo();
    var key = 'c:' + S.prop + ':' + pf.from + ':' + pf.to;
    var got = needOr('c', key, '/api/props/' + S.prop + '/capex?from=' + pf.from + '&to=' + pf.to), D = got.D;
    if (!D) return { pending: true, error: errOf(key) };
    var ms = D.months, units = D.units;
    var vals = ms.map(function (m) { return m.capex; });
    var tot = sum(vals) || 0;
    var withInc = ms.filter(function (m) { return isNum(m.inc); });
    var incT = sum(withInc.map(function (m) { return m.inc; })), noiT = sum(withInc.map(function (m) { return m.noi; }));
    var capInc = sum(withInc.map(function (m) { return m.capex; }));
    var pctInc = incT ? capInc / incT : null, pctNoi = noiT > 0 ? capInc / noiT : null;
    var big = null; ms.forEach(function (m) { if (!big || m.capex > big.capex) big = m; });
    var active = vals.filter(function (v) { return v > 0; }).length;
    var cats = D.categories, catTot = sum(cats.map(function (c) { return c[1]; })) || 0;
    var span = ms.length ? ms[0].label + ' to ' + ms[ms.length - 1].label : '';
    var cards = [
      { label: 'Capital expenses', value: money(tot), sub: span || 'No months with data' },
      { label: 'Per unit', value: units ? money(tot / units) : DASH, sub: units ? units + ' units' : 'Units not on file' },
      { label: 'Share of income', value: pct(pctInc), sub: 'Capex divided by total income', style: pctInc > 0.25 ? C('warn') : '' },
      { label: 'Share of NOI', value: pct(pctNoi), sub: 'How much of NOI went to capex', style: pctNoi > 0.5 ? C('warn') : '' },
      { label: 'Monthly average', value: ms.length ? money(tot / ms.length) : DASH, sub: ms.length + ' months' },
      { label: 'Largest month', value: big && big.capex > 0 ? money(big.capex) : DASH, sub: big && big.capex > 0 ? big.label : 'No capex in the period' },
      { label: 'Biggest category', value: cats.length ? cats[0][0] : DASH, sub: cats.length ? money(cats[0][1]) + ', ' + pct(cats[0][1] / catTot) + ' of capex' : 'No detail on file', style: 'font-size:15px' },
      { label: 'Months with capex', value: active + ' of ' + ms.length, sub: '' },
    ];
    var mxM = Math.max.apply(null, vals.concat([1]));
    var monthT = { title: 'By month', firstW: 180,
      heads: [{ label: '' }].concat(ms.map(function (m) { return { label: m.label }; }), [{ label: 'Total', cls: 'sep' }]),
      rows: [
        { label: 'Capital expenses', kind: 'key', cells: ms.map(function (m) { return { v: m.capex, f: 'money2', style: m.capex > 0 ? 'background:color-mix(in srgb, var(--accent) ' + Math.round(6 + (m.capex / mxM) * 36) + '%, transparent)' : C('muted') }; })
            .concat([{ v: tot, f: 'money2', cls: 'sep', style: 'font-weight:600' }]) },
        { label: 'Share of income', cells: ms.map(function (m) { return { v: m.inc ? m.capex / m.inc : null, f: 'pct', style: C('muted') }; }).concat([{ v: pctInc, f: 'pct', cls: 'sep', style: 'font-weight:600' }]) },
      ] };
    var mxC = Math.max.apply(null, cats.map(function (c) { return c[1]; }).concat([1]));
    var catT = { title: 'By category, ' + span, firstW: 260,
      heads: [{ label: 'Category' }, { label: 'Total' }, { label: 'Share of capex' }, { label: 'Per unit' }],
      rows: cats.map(function (c) {
        return { label: c[0], cells: [{ v: c[1], f: 'money', style: 'background:color-mix(in srgb, var(--accent) ' + Math.round(6 + (Math.max(c[1], 0) / mxC) * 30) + '%, transparent)' },
          { v: catTot ? c[1] / catTot : null, f: 'pct', style: '' }, { v: units ? c[1] / units : null, f: 'money', style: '' }] };
      }).concat([{ label: 'All capital expenses', kind: 'total', cells: [{ v: catTot, f: 'money', style: '' }, { v: catTot ? 1 : null, f: 'pct', style: '' }, { v: null, f: 'text', html: '' }] }]) };
    return { cards: cards, tables: cats.length ? [monthT, catT] : [monthT], cats: cats.length, stale: got.stale };
  }
  function capexHtml() {
    var M = capexModel();
    if (M.pending) return M.error ? errorBox(M.error) : loading('capex');
    S.exportModel = M.stale ? null : M;
    return '<div class="view' + staleCls(M) + '" style="margin-top:14px">' + cardsHtml(M.cards) +
      M.tables.map(function (t) { return '<h2 class="h2" style="margin-top:20px">' + esc(t.title) + '</h2><div style="margin-top:8px">' + tableHtml(t) + '</div>'; }).join('') +
      '<p class="note" style="margin-top:8px">' + (M.cats ? 'Categories group the capital accounts in the income statement by the rules in the capex category map, which can be edited.' : 'No account-level capex detail on file for this property; monthly totals come from the income statement.') + '</p></div>';
  }

  var TAB_RENDER = {
    overview: overviewHtml, attention: attentionHtml, buildings: buildingsHtml, monthly: monthlyHtml,
    optimized: optimizedHtml, fee: feeHtml, rent: rentHtml, capex: capexHtml,
  };

  /* ---- export of the current property tab ------------------------------ */
  function exportTab(format) {
    var p = propById(S.prop), M = S.exportModel;
    S.exportOpen = false;
    if (!p || !M) { paint(); return; }
    var per = S.ptab === 'rent' ? 'as of ' + dayLong(M.asOf)
      : S.ptab === 'optimized' ? M.period
      : MN[S.fm - 1] + ' ' + S.fy + ' to ' + MN[S.tm - 1] + ' ' + S.ty;
    var base = p.name + ' - ' + EXPORTABLE[S.ptab] + ' - ' + per;
    S.exportMsg = 'Preparing "' + base + '"…'; paint();
    download({ format: format, filename: base, title: p.name + ', ' + EXPORTABLE[S.ptab], subtitle: per + '. Managed by ' + (p.pm || DASH) + '.',
               cards: M.cards.map(function (c) { return { label: c.label, value: c.value, sub: (c.sub || '') + (c.tag ? ' (' + c.tag + ')' : '') }; }),
               tables: M.tables.map(tableExport) })
      .then(function (name) { S.exportMsg = 'Exported "' + name + '".'; paint(); },
            function (e) { S.exportMsg = 'Export failed: ' + e.message; paint(); });
  }

  /* ===================================================================== */
  /*  CUSTOM VIEW                                                          */
  /* ===================================================================== */
  var SPAN = { S: 3, M: 4, L: 6 };
  var STYLES = [['table', 'Table'], ['list', 'List'], ['chart', 'Chart']];
  var FIELD_GROUPS = ['Location', 'Rent roll', 'Income and NOI', 'Expenses and capex', 'Asset management fee', 'Debt and value', 'Management'];

  function meta() { return need('people', '/api/props/people'); }
  function fieldsMap() { var M = cur('people'); var o = {}; (M ? M.fields : []).forEach(function (f) { o[f.key] = f; }); return o; }
  function vfmt(type, v) { return type === 'money' ? money(v) : type === 'pct' ? pct(v) : type === 'ratio' ? ratio(v) : type === 'count' ? cnt(v) : type === 'number' ? (isNum(v) ? (Math.round(v * 100) / 100).toLocaleString('en-US') : DASH) : (v === null || v === undefined || v === '' ? DASH : String(v)); }

  function customHtml() {
    var V = need('views', '/api/props/views'), M = meta();
    if (!V || !M) return (errOf('views') || errOf('people')) ? errorBox(errOf('views') || errOf('people')) : loading('custom views');
    var views = V.views, cv = S.cv;
    if (cv.mode !== 'build' && views.length && !views.some(function (v) { return v.id === cv.sel; })) cv.sel = views[0].id;
    var h = '<div class="view" style="margin-top:12px"><div style="display:flex;align-items:flex-end;justify-content:space-between;gap:12px;border-bottom:1px solid var(--rule)">' +
      '<div role="tablist" aria-label="Custom views" style="display:flex;flex-wrap:wrap">' +
      views.map(function (v) {
        var on = cv.mode !== 'build' && cv.sel === v.id;
        return '<button role="tab" aria-selected="' + on + '" class="tab press' + (on ? ' on' : '') + '" data-a="cvsel:' + v.id + '">' + esc(v.name) + '</button>';
      }).join('') + '</div>' +
      '<button class="btn press on" data-a="cvadd" style="margin-bottom:8px;color:var(--ink);display:inline-flex;align-items:center;gap:6px">' +
      svg('<path d="M12 5v14M5 12h14"></path>', 13, ' stroke-width="2.4"') + 'Add custom view</button></div>';
    if (!views.length && cv.mode !== 'build') h += '<p class="note" style="margin-top:14px">No custom views yet. Use "Add custom view" to build one; each view you save appears as a tab here.</p>';
    h += '<div style="margin-top:14px" data-k="cv:' + esc(cv.mode === 'build' ? 'build:' + ((cv.draft && cv.draft.id) || 'new') : cv.sel || '') + '">' +
      (cv.mode === 'build' ? builderHtml() : views.length ? viewerHtml() : '') + '</div></div>';
    return h;
  }

  /* ---- the saved view, read --------------------------------------------- */
  function viewerHtml() {
    var cv = S.cv, key = 'view:' + cv.sel, D = need(key, '/api/props/views/' + cv.sel);
    if (!D) return errOf(key) ? errorBox(errOf(key)) : loading('the view');
    var v = D.view, r = D.result, cfg = v.config;
    var sub = r.count + ' properties' + (r.groupNames.length ? ' from ' + (r.groupNames.length === 1 ? 'the group ' : 'the groups ') +
      r.groupNames.map(function (x) { return '"' + x + '"'; }).join(' and ') + (r.excluded ? ', ' + r.excluded + ' excluded' : '') : ', picked one by one') +
      '. Live data through ' + ymLong(r.through) + ', updated after each monthly sync.';
    var shared = (v.shares || []).length > 0;
    var canEdit = D.permission === 'owner' || D.permission === 'editor';
    var h = '<section class="frame" style="padding:18px 20px"><div style="display:flex;align-items:flex-start;gap:12px">' +
      '<div style="flex:1;min-width:0"><div style="display:flex;align-items:center;gap:10px"><h2 class="h2" style="font-size:17px">' + esc(v.name) + '</h2>' +
      '<span style="padding:1px 7px;border-radius:4px;font-size:11.5px;font-weight:500;' + (shared ? 'background:var(--okBg);color:var(--ok)' : 'background:var(--tag);color:var(--muted)') + '">' + (shared ? 'Shared' : 'Private') + '</span></div>' +
      '<p class="note" style="margin-top:2px">' + esc(sub) + '</p></div>' +
      (canEdit ? '<button class="btn press" data-a="cvedit">Edit</button>' : '') +
      '<div style="position:relative"><button class="btn press" data-a="cvexport" style="display:inline-flex;align-items:center;gap:6px;color:var(--ink)">' + svg(ICON_DOWN, 14) + 'Export' + svg(ICON_CHEV, 12) + '</button>' +
      (cv.exportOpen ? exportMenu('cvx') : '') + '</div></div>';
    if (cv.msg) h += '<div role="status" class="lw-status"><span>' + esc(cv.msg) + '</span><button class="link" data-a="cvclear" style="margin-left:auto">Dismiss</button></div>';
    h += '<div class="lw-grid12" style="margin-top:14px">' + blocksHtml(cfg, r) + '</div>';
    var access = (v.is_mine ? 'Owner: you.' : 'Owner: ' + (v.owner_name || 'another person') + '. You ' + (D.permission === 'editor' ? 'can view and edit' : 'can view') + ' it.') +
      (shared ? ' Shared with ' + v.shares.map(function (x) { return x.name + ' (' + (x.permission === 'editor' ? 'can view and edit' : 'can view') + ')'; }).join(', ') + '.' : v.is_mine ? ' Only you can see this view.' : '');
    return h + '<p class="note" style="margin-top:14px">' + esc(access) + '</p></section>';
  }

  function blocksHtml(cfg, r) {
    var cardBy = {}; r.cards.forEach(function (c) { cardBy[c.id] = c; });
    var defs = {}; cfg.cards.forEach(function (c) { defs[c.id] = c; });
    return cfg.layout.map(function (k) {
      if (k.indexOf('card:') === 0) {
        var id = k.slice(5), c = defs[id], res = cardBy[id];
        if (!c || !res) return '';
        var val = vfmt(res.type, res.value);
        var red = res.value === null && c.kind === 'value' && ['value', 'ds', 'dscr'].indexOf(c.field) >= 0;
        var big = c.size === 'L' ? 'font-size:26px;' : c.size === 'S' ? 'font-size:17px;' : 'font-size:21px;';
        return '<div style="min-width:0;grid-column:span ' + SPAN[c.size] + '"><div class="frame" style="padding:12px 14px;height:100%" title="' + esc(res.sub) + '">' +
          '<div style="font-size:12.5px;color:var(--muted)">' + esc(c.label || 'Untitled') + '</div>' +
          '<div style="font-weight:600;margin-top:2px;' + big + (red ? C('bad') : '') + '">' + esc(val) + '</div>' +
          '<div style="font-size:11.5px;margin-top:3px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + esc(res.sub) + '</div></div></div>';
      }
      if (k === 'chart') {
        var bars = r.chart.bars, mx = Math.max.apply(null, bars.map(function (b) { return Math.abs(b.v); }).concat([1]));
        return '<div style="min-width:0;grid-column:span 12"><div class="frame" style="padding:14px 16px"><div style="font-weight:600">' + esc(r.chart.title) + '</div>' +
          '<div style="margin-top:8px;display:grid;grid-template-columns:minmax(140px,220px) 1fr auto;gap:6px 12px;align-items:center">' +
          bars.map(function (b) {
            return '<span style="font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + esc(b.name) + '</span>' +
              '<div class="lw-bar"><div style="width:' + Math.max(1, Math.abs(b.v) / mx * 100).toFixed(1) + '%;background:' + (b.v < 0 ? 'var(--bad)' : 'var(--accent)') + '"></div></div>' +
              '<span style="font-size:13px;text-align:right;min-width:90px">' + esc(vfmt(r.chart.type, b.v)) + '</span>';
          }).join('') + (bars.length ? '' : '<span class="note">No values to chart.</span>') + '</div></div></div>';
      }
      if (k === 'table') return '<div style="min-width:0;grid-column:span 12">' + tableHtml(viewTable(r)) + '</div>';
      if (k === 'list') {
        return '<div style="min-width:0;grid-column:span 12"><div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:10px">' +
          r.list.map(function (it) {
            return '<div class="frame" style="padding:12px 14px"><button class="link" data-a="prop:' + it.id + '" style="font-weight:600">' + esc(it.name) + '</button>' +
              '<div style="font-size:12.5px;color:var(--muted);margin-top:2px">' + esc(it.address || DASH) + '</div><div style="margin-top:8px">' +
              it.kv.map(function (x) { return '<div style="display:flex;justify-content:space-between;gap:10px;padding:3px 0;font-size:13px"><span style="color:var(--muted)">' + esc(x.k) + '</span><span>' + esc(vfmt(x.type, x.v)) + '</span></div>'; }).join('') +
              '</div></div>';
          }).join('') + '</div></div>';
      }
      return '';
    }).join('');
  }
  function viewTable(r) {
    var F = { money: 'money', pct: 'pct', ratio: 'ratio', count: 'count', text: 'text' };
    return { title: 'Properties', firstW: 200,
      heads: [{ label: 'Property' }].concat(r.heads.map(function (h) { return { label: h.label, cls: h.type === 'text' ? 'l' : '' }; })),
      rows: r.rows.map(function (row) {
        return { act: 'prop:' + row.id, label: row.name, html: '<button class="link" data-a="prop:' + row.id + '" style="font-weight:500">' + esc(row.name) + '</button>',
          cells: row.cells.map(function (v, i) {
            var h = r.heads[i];
            var red = !isNum(v) && ['value', 'ds', 'dscr'].indexOf(h.key) >= 0;
            return { v: v, f: F[h.type], cls: h.type === 'text' ? 'l' : '',
              style: h.type === 'text' ? 'color:var(--muted);max-width:320px;overflow:hidden;text-overflow:ellipsis' : red ? C('bad') + ';font-weight:600' : (isNum(v) && v < 0 ? C('bad') : '') };
          }) };
      }).concat([{ label: 'Total', kind: 'total', cells: r.totals.map(function (v, i) { var h = r.heads[i]; return { v: h.type === 'text' ? '' : v, f: h.type === 'text' ? 'text' : F[h.type], html: h.type === 'text' ? '' : undefined, cls: h.type === 'text' ? 'l' : '', style: '' }; }) }]) };
  }

  function exportView(format) {
    var D = S.data['view:' + S.cv.sel];
    S.cv.exportOpen = false;
    if (!D) return paint();
    var v = D.view, r = D.result, defs = {};
    v.config.cards.forEach(function (c) { defs[c.id] = c; });
    var tables = [];
    if (v.config.layout.indexOf('table') >= 0 || v.config.fields.length) tables.push(tableExport(viewTable(r)));
    if (v.config.layout.indexOf('chart') >= 0) tables.push({ title: r.chart.title, heads: ['Property', r.chart.title.replace(/ by property$/, '')],
      rows: r.chart.bars.map(function (b) { return { label: b.name, kind: '', cells: [{ f: { money: 'money', pct: 'pct', ratio: 'ratio', count: 'count' }[r.chart.type] || 'money2', v: b.v }] }; }) });
    S.cv.msg = 'Preparing "' + v.name + '"…'; paint();
    download({ format: format, filename: v.name, title: v.name, subtitle: r.count + ' properties, data through ' + ymLong(r.through) + '.',
               cards: r.cards.map(function (c) { return { label: (defs[c.id] || {}).label || '', value: vfmt(c.type, c.value), sub: c.sub }; }), tables: tables })
      .then(function (name) { S.cv.msg = 'Exported "' + name + '".'; paint(); }, function (e) { S.cv.msg = 'Export failed: ' + e.message; paint(); });
  }

  /* ---- the builder ------------------------------------------------------ */
  function emptyDraft() {
    var G = S.data.groups;
    return { id: null, bmode: 'quick', quickCards: true, name: '', how: G && G.groups.length ? 'group' : 'create', props: [], newGroupName: '', newProps: [],
             groups: [], excl: [], fields: ['address', 'units', 'inc', 'noi', 'debt'], styles: ['table'], chartField: 'inc',
             cards: [], layout: [], openCard: null, drag: null, share: [], shareSel: '', shareRole: 'viewer', q: '', isOwner: true };
  }
  function draftFromView(D) {
    var c = D.view.config;
    return { id: D.view.id, bmode: c.mode, quickCards: c.quickCards, name: D.view.name, how: c.groups.length ? 'group' : 'pick',
             props: (c.props || []).slice(), newGroupName: '', newProps: [], groups: c.groups.slice(), excl: c.excl.slice(),
             fields: c.fields.slice(), styles: c.styles.slice(), chartField: c.chartField,
             cards: c.cards.map(function (x) { return JSON.parse(JSON.stringify(x)); }), layout: c.layout.slice(), openCard: null, drag: null,
             share: (D.view.shares || []).filter(function (s) { return s.principal_id; }).map(function (s) { return { principal_type: s.principal_type, principal_id: s.principal_id, permission: s.permission }; }),
             shareSel: '', shareRole: 'viewer', q: '', isOwner: D.permission === 'owner' };
  }
  function syncLayout(layout, cards, styles) {
    var want = cards.map(function (c) { return 'card:' + c.id; }).concat(styles);
    var kept = (layout || []).filter(function (k) { return want.indexOf(k) >= 0; });
    return kept.concat(want.filter(function (k) { return kept.indexOf(k) < 0; }));
  }
  function draftConfig(d) {
    var F = fieldsMap();
    var quick = d.bmode !== 'advanced';
    var cards = d.cards, layout = syncLayout(d.layout, d.cards, d.styles);
    if (quick) {
      cards = d.quickCards ? d.fields.filter(function (k) { return F[k] && F[k].type !== 'text'; }).map(function (k, i) {
        return { id: 'q' + i, label: F[k].label, kind: 'value', field: k, period: { t: 'ttm' }, agg: 'total', size: 'M' }; }) : [];
      layout = cards.map(function (c) { return 'card:' + c.id; }).concat(['chart', 'table', 'list'].filter(function (k) { return d.styles.indexOf(k) >= 0; }));
    }
    var useG = d.how === 'group';
    return { mode: quick ? 'quick' : 'advanced', quickCards: !!d.quickCards, groups: useG ? d.groups.slice() : [], excl: useG ? d.excl.slice() : [],
             props: useG ? null : d.props.slice(), fields: d.fields.slice(), styles: d.styles.slice(), chartField: d.chartField, cards: cards, layout: layout };
  }
  /* live result preview, computed HERE: the same engine the server runs
     (props-views-core.js) over every property's figures, loaded once per
     session, so each change to a field, period or formula updates at once
     with no request. Null while that data loads, or when the draft names a
     group this browser has not loaded (a view shared by its owner); the
     server preview below covers those. */
  function localPreview(d) {
    var core = window.PropsViewsCore, DS = need('dataset', '/api/props/views/dataset'), G = cur('groups');
    if (!core || !DS || !G) return null;
    var cfg = core.validateConfig(draftConfig(d)), k = JSON.stringify(cfg);
    /* cached per draft AND per data: a refreshed dataset or group list is a new answer */
    if (S.cv.localKey === k && S.cv.localDS === DS && S.cv.localG === G) return S.cv.local;
    if (cfg.groups.some(function (gid) { return !G.groups.some(function (g) { return g.id === gid; }); })) return null;
    S.cv.localKey = k; S.cv.localDS = DS; S.cv.localG = G;
    S.cv.local = core.evaluateData(cfg, core.resolve(cfg, G.groups), DS);
    return S.cv.local;
  }
  /* server preview: only when the local one cannot answer, debounced */
  var previewTimer = null;
  function schedulePreview() {
    var d = S.cv.draft; if (!d) return;
    var cfg = draftConfig(d), k = JSON.stringify(cfg);
    if (k === S.cv.previewKey) return;
    clearTimeout(previewTimer);
    previewTimer = setTimeout(function () {
      S.cv.previewKey = k;
      api('/api/props/views/preview', 'POST', { config: cfg }).then(function (r) {
        if (S.cv.previewKey !== k) return;
        S.cv.preview = r.result; paint();
      }, function (e) { S.cv.err = e.message; paint(); });
    }, 350);
  }

  function periodKey(pd) { pd = pd || { t: 'ttm' }; return pd.t === 'month' ? 'm:' + pd.a : pd.t; }
  function periodSelect(pd, attr, M) {
    var k = periodKey(pd);
    return '<select class="sel" aria-label="Period" ' + attr + '>' +
      '<option value="ttm"' + (k === 'ttm' ? ' selected' : '') + '>Trailing 12 months</option>' +
      '<option value="ytd"' + (k === 'ytd' ? ' selected' : '') + '>' + esc(M.periods.ytdLabel) + '</option>' +
      M.periods.months.map(function (m) { return '<option value="m:' + m.value + '"' + (k === 'm:' + m.value ? ' selected' : '') + '>' + m.label + '</option>'; }).join('') +
      '<option value="range"' + (k === 'range' ? ' selected' : '') + '>Range of months</option></select>';
  }
  function monthSelect(v, attr, M) {
    return '<select class="sel" ' + attr + '>' + M.periods.months.map(function (m) { return '<option value="' + m.value + '"' + (v === m.value ? ' selected' : '') + '>' + m.label + '</option>'; }).join('') + '</select>';
  }
  function fieldSelect(v, attr, M) {
    return '<select class="sel" aria-label="Field" ' + attr + '>' + M.fields.filter(function (f) { return f.type !== 'text'; }).map(function (f) {
      return '<option value="' + f.key + '"' + (v === f.key ? ' selected' : '') + '>' + esc(f.label) + '</option>'; }).join('') + '</select>';
  }
  function aggSelect(v, attr) {
    return '<select class="sel" aria-label="Combine properties" ' + attr + '><option value="total"' + (v !== 'avg' ? ' selected' : '') + '>Total of properties</option><option value="avg"' + (v === 'avg' ? ' selected' : '') + '>Average per property</option></select>';
  }

  function builderHtml() {
    var d = S.cv.draft, M = meta(), G = need('groups', '/api/props/groups'), L = list();
    if (!G || !L) return errOf('groups') ? errorBox(errOf('groups')) : loading('the builder');
    var F = fieldsMap(), P = L.properties, byId = {};
    P.forEach(function (p) { byId[p.id] = p; });
    var isQuick = d.bmode !== 'advanced';
    var memberIds = function () {
      var out = [];
      d.groups.forEach(function (gid) { var g = G.groups.find(function (x) { return x.id === gid; }); if (g) g.property_ids.forEach(function (pid) { if (d.excl.indexOf(gid + '|' + pid) < 0 && out.indexOf(pid) < 0) out.push(pid); }); });
      return out;
    };
    var selIds = memberIds();
    var canSaveGroup = !!d.newGroupName.trim() && d.newProps.length > 0;
    var canSave = !!d.name.trim() && (d.fields.length || d.cards.length) && (d.styles.length || d.cards.length || (isQuick && d.quickCards)) &&
      (d.how === 'pick' ? d.props.length > 0 : d.how === 'group' ? selIds.length > 0 : false);
    var local = localPreview(d), pv = local || S.cv.preview, pvCards = {};
    if (pv) pv.cards.forEach(function (c) { pvCards[c.id] = c; });

    var h = '<section class="frame" style="padding:18px 20px"><h2 class="h2" style="font-size:17px">' + (d.id ? 'Edit custom view' : 'Add custom view') + '</h2>' +
      '<div role="radiogroup" aria-label="Build mode" class="lw-modes">' + [['quick', 'Quick build', 'Pick properties, information and a design'], ['advanced', 'Advanced', 'Build each card, use periods and formulas, arrange the layout']].map(function (m) {
        var on = (d.bmode || 'quick') === m[0];
        return '<button class="press lw-mode' + (on ? ' on' : '') + '" role="radio" aria-checked="' + on + '" data-a="bmode:' + m[0] + '"><div style="font-weight:600">' + m[1] + '</div><div style="font-size:12.5px;color:var(--muted);margin-top:2px">' + m[2] + '</div></button>';
      }).join('') + '</div>' +
      '<div style="margin-top:18px"><label style="font-weight:600" for="cv-name">Name</label></div>' +
      '<input id="cv-name" class="sel" style="width:100%;max-width:420px;margin-top:6px" placeholder="e.g. Sioux Falls townhomes overview" value="' + esc(d.name) + '" data-in="d:name">';

    /* properties */
    h += '<div style="margin-top:20px;font-weight:600">Properties</div><div role="group" style="display:flex;gap:6px;margin-top:8px;flex-wrap:wrap">' +
      [['group', 'Use a property group'], ['create', 'Create a property group'], ['pick', 'Pick properties without saving']].map(function (b) {
        return '<button class="btn press' + (d.how === b[0] ? ' on' : '') + '" aria-pressed="' + (d.how === b[0]) + '" data-a="how:' + b[0] + '">' + b[1] + '</button>'; }).join('') + '</div>';
    if (d.how === 'group') {
      if (G.groups.length) {
        h += '<div style="margin-top:10px;border:1px solid var(--rule);border-radius:6px">' + G.groups.map(function (g) {
          var on = d.groups.indexOf(g.id) >= 0;
          var inc = g.property_ids.filter(function (pid) { return d.excl.indexOf(g.id + '|' + pid) < 0; }).length;
          var s = '<div style="border-bottom:1px solid var(--rule)"><label class="lw-check" style="padding:9px 12px;gap:10px"><input type="checkbox"' + (on ? ' checked' : '') + ' data-a="grp:' + g.id + '">' +
            '<span style="font-weight:600">' + esc(g.name) + '</span><span style="font-size:12.5px;color:var(--muted)">' + (on ? inc + ' of ' + g.property_ids.length + ' properties included' : g.property_ids.length + ' properties') + '</span></label>';
          if (on) {
            s += '<div style="padding:0 12px 8px 36px">' + g.property_ids.map(function (pid) {
              var incl = d.excl.indexOf(g.id + '|' + pid) < 0, p = byId[pid];
              return '<label class="lw-check" style="gap:10px;padding:4px 0"><input type="checkbox"' + (incl ? ' checked' : '') + ' data-a="excl:' + g.id + '|' + pid + '"><span>' + esc(p ? p.name : 'A property not in the portfolio list') + '</span>' +
                '<span style="font-size:12px;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(p ? p.address : '') + '</span></label>';
            }).join('') + '</div>';
          }
          return s + '</div>';
        }).join('') + '</div><p class="note" style="margin-top:6px">' + selIds.length + (selIds.length === 1 ? ' property selected' : ' properties selected') + '. Unticking a property leaves it out of this view only; the group itself stays the same.</p>';
      } else h += '<p class="note" style="margin-top:10px">You have no property groups yet.</p>';
      h += '<button class="link" data-a="how:create" style="margin-top:10px">+ Create a property group</button>';
    }
    if (d.how === 'create') h += '<input class="sel" style="width:260px;margin-top:10px;display:block" placeholder="Group name, e.g. Sioux Falls townhomes" value="' + esc(d.newGroupName) + '" data-in="d:newGroupName" aria-label="Group name">';
    if (d.how === 'pick' || d.how === 'create') {
      var key = d.how === 'create' ? 'newProps' : 'props', qq = d.q.toLowerCase();
      var picks = P.slice().sort(function (a, b) { return a.name.localeCompare(b.name); }).filter(function (p) { return !qq || (p.name + ' ' + p.address + ' ' + p.pm).toLowerCase().indexOf(qq) >= 0; });
      h += '<div style="display:flex;align-items:center;gap:10px;margin-top:10px"><input class="sel" type="search" placeholder="Search name, address or manager" value="' + esc(d.q) + '" data-in="d:q" style="width:300px"><span class="note">' + d[key].length + ' selected</span></div>' +
        '<div class="scroll" style="margin-top:8px;max-height:230px;border:1px solid var(--rule);border-radius:6px">' + picks.map(function (p) {
          return '<label class="lw-check" style="gap:10px;padding:7px 12px;border-bottom:1px solid var(--rule)"><input type="checkbox"' + (d[key].indexOf(p.id) >= 0 ? ' checked' : '') + ' data-a="pick:' + key + ':' + p.id + '">' +
            '<span style="font-weight:500">' + esc(p.name) + '</span><span style="font-size:12.5px;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(p.address) + '</span></label>'; }).join('') + '</div>';
    }
    if (d.how === 'create') {
      h += '<div style="display:flex;align-items:center;gap:10px;margin-top:10px"><button class="btn press' + (canSaveGroup ? ' on' : '') + '" data-a="savegroup" style="color:var(--ink)"' + (canSaveGroup ? '' : ' disabled') + '>Save property group</button>' +
        '<span class="note">' + (canSaveGroup ? '' : 'Name the group and select at least one property.') + '</span></div>';
    }

    /* fields */
    h += '<div style="margin-top:20px;font-weight:600">Information to show</div><div class="lw-fields">' + FIELD_GROUPS.map(function (gname) {
      return '<div><div style="font-size:12.5px;color:var(--muted);margin-bottom:4px">' + gname + '</div>' + M.fields.filter(function (f) { return f.group === gname; }).map(function (f) {
        return '<label class="lw-check"><input type="checkbox"' + (d.fields.indexOf(f.key) >= 0 ? ' checked' : '') + ' data-a="fld:' + f.key + '">' + esc(f.label) + '</label>'; }).join('') + '</div>';
    }).join('') + '</div>';

    /* display */
    h += '<div style="margin-top:20px;font-weight:600">Display as</div><div style="display:flex;gap:16px;margin-top:8px;align-items:center;flex-wrap:wrap">' +
      (isQuick ? '<label class="lw-check"><input type="checkbox"' + (d.quickCards ? ' checked' : '') + ' data-a="qcards">Cards (a total for each number)</label>' : '') +
      STYLES.map(function (s) { return '<label class="lw-check"><input type="checkbox"' + (d.styles.indexOf(s[0]) >= 0 ? ' checked' : '') + ' data-a="sty:' + s[0] + '">' + s[1] + '</label>'; }).join('') +
      (d.styles.indexOf('chart') >= 0 ? '<span class="note" style="margin-left:8px">Chart shows</span>' + fieldSelect(d.chartField, 'data-in="d:chartField"', M) : '') + '</div>';

    /* advanced: cards + layout */
    if (!isQuick) {
      h += '<div style="display:flex;align-items:center;justify-content:space-between;margin-top:22px"><span style="font-weight:600">Cards</span><button class="btn press" data-a="addcard">+ Add card</button></div>';
      if (d.cards.length) {
        h += '<div style="margin-top:8px;border:1px solid var(--rule);border-radius:6px">' + d.cards.map(function (c, ci) {
          var res = pvCards[c.id];
          var pvTxt = res ? vfmt(res.type, res.value) : '…';
          var open = d.openCard === c.id;
          var s = '<div style="border-bottom:1px solid var(--rule)"><div style="display:flex;align-items:center;gap:12px;padding:10px 12px">' +
            '<button class="link" data-a="ctog:' + c.id + '" style="font-weight:600;color:var(--ink)">' + esc(c.label || 'Untitled card') + '</button>' +
            '<span class="chip">' + { S: 'Small', M: 'Medium', L: 'Large' }[c.size || 'M'] + '</span><span style="margin-left:auto;font-weight:600">' + esc(pvTxt) + '</span>' +
            '<button class="link" data-a="ctog:' + c.id + '">Edit</button><button class="link" data-a="crm:' + c.id + '" style="color:var(--muted)">Remove</button></div>';
          if (open) {
            var at = function (k) { return 'data-in="c:' + ci + ':' + k + '"'; };
            s += '<div style="padding:4px 12px 14px;display:flex;flex-direction:column;gap:10px;font-size:13px">' +
              '<div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap"><label>Label <input class="sel" style="width:240px" value="' + esc(c.label) + '" ' + at('label') + '></label>' +
              '<label>Size <select class="sel" ' + at('size') + '>' + [['S', 'Small'], ['M', 'Medium'], ['L', 'Large']].map(function (z) { return '<option value="' + z[0] + '"' + (c.size === z[0] ? ' selected' : '') + '>' + z[1] + '</option>'; }).join('') + '</select></label>' +
              '<span style="display:flex;gap:6px">' + [['value', 'A value'], ['formula', 'A formula']].map(function (kb) { return '<button class="btn press' + ((c.kind || 'value') === kb[0] ? ' on' : '') + '" data-a="ckind:' + ci + ':' + kb[0] + '">' + kb[1] + '</button>'; }).join('') + '</span></div>';
            if ((c.kind || 'value') === 'value') {
              var f = F[c.field] || {};
              s += '<div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">' + fieldSelect(c.field, at('field'), M) +
                (f.monthly ? periodSelect(c.period, at('period'), M) : '') +
                (f.monthly && c.period && c.period.t === 'range' ? monthSelect(c.period.a, at('pa') + ' aria-label="From"', M) + '<span>to</span>' + monthSelect(c.period.b, at('pb') + ' aria-label="To"', M) : '') +
                aggSelect(c.agg, at('agg')) + '</div>';
            } else {
              s += (c.terms || []).map(function (tm, ti) {
                var tat = function (k) { return 'data-in="t:' + ci + ':' + ti + ':' + k + '"'; };
                var tf = F[tm.field] || {};
                return '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">' +
                  (ti ? '<select class="sel" aria-label="Operator" style="width:56px" ' + tat('op') + '>' + [['+', '+'], ['-', '−'], ['*', '×'], ['/', '÷']].map(function (o) { return '<option value="' + o[0] + '"' + (tm.op === o[0] ? ' selected' : '') + '>' + o[1] + '</option>'; }).join('') + '</select>'
                      : '<span style="width:56px;color:var(--muted)">Start</span>') +
                  '<select class="sel" aria-label="Term type" ' + tat('kind') + '><option value="field"' + (tm.kind !== 'num' ? ' selected' : '') + '>Field</option><option value="num"' + (tm.kind === 'num' ? ' selected' : '') + '>Number</option></select>' +
                  (tm.kind === 'num' ? '<input class="inp" type="number" value="' + esc(tm.num) + '" aria-label="Number" ' + tat('num') + '>' :
                    fieldSelect(tm.field, tat('field'), M) + (tf.monthly ? periodSelect(tm.period, tat('period'), M) : '') +
                    (tf.monthly && tm.period && tm.period.t === 'range' ? monthSelect(tm.period.a, tat('pa') + ' aria-label="From"', M) + '<span>to</span>' + monthSelect(tm.period.b, tat('pb') + ' aria-label="To"', M) : '') +
                    aggSelect(tm.agg, tat('agg'))) +
                  ((c.terms || []).length > 1 ? '<button class="link" data-a="trm:' + ci + ':' + ti + '" style="color:var(--muted)">Remove</button>' : '') + '</div>';
              }).join('') +
                '<div style="display:flex;gap:10px;align-items:center"><button class="link" data-a="tadd:' + ci + '">+ Add term</button><label style="margin-left:12px">Show result as <select class="sel" ' + at('fmt') + '>' +
                [['money', 'Dollars'], ['number', 'Number'], ['pct', 'Percent'], ['ratio', 'Ratio']].map(function (o) { return '<option value="' + o[0] + '"' + ((c.fmt || 'money') === o[0] ? ' selected' : '') + '>' + o[1] + '</option>'; }).join('') + '</select></label></div>';
            }
            s += '<div style="padding:8px 10px;border-radius:6px;background:var(--hover)"><span style="color:var(--muted)">Result:</span> <span style="font-weight:600">' + esc(pvTxt) + '</span>' +
              (res ? ' <span style="color:var(--muted)">from ' + esc(res.sub) + '</span>' : '') + '</div></div>';
          }
          return s + '</div>';
        }).join('') + '</div>';
      }
      h += '<p class="note" style="margin-top:6px">Monthly figures exist through ' + esc(ymLong(M.periods.through)) + '. Months not loaded yet show "–" until the sync brings them in; Oct to Dec 2025 are being backfilled.</p>';
      var layout = syncLayout(d.layout, d.cards, d.styles);
      h += '<div style="margin-top:20px;font-weight:600">Layout</div><p class="note" style="margin-top:2px">Drag the blocks into the order you want, or use the arrows. Cards sit side by side by size; the table, chart and list take the full width.</p>';
      if (layout.length) {
        h += '<div class="lw-grid12" style="gap:8px;margin-top:8px">' + layout.map(function (k, i) {
          var c = k.indexOf('card:') === 0 ? d.cards.find(function (x) { return 'card:' + x.id === k; }) : null;
          var label = c ? 'Card: ' + (c.label || 'Untitled') : (STYLES.find(function (s) { return s[0] === k; }) || [0, k])[1];
          var subT = c ? (pvCards[c.id] ? vfmt(pvCards[c.id].type, pvCards[c.id].value) : '…') : 'Full width';
          return '<div class="lw-tile' + (d.drag === i ? ' drag' : '') + '" draggable="true" data-drag="' + i + '" style="grid-column:span ' + (c ? SPAN[c.size || 'M'] : 12) + '">' +
            '<div style="display:flex;align-items:center;gap:6px">' + svg('<circle cx="8" cy="6" r="1.6"></circle><circle cx="16" cy="6" r="1.6"></circle><circle cx="8" cy="12" r="1.6"></circle><circle cx="16" cy="12" r="1.6"></circle><circle cx="8" cy="18" r="1.6"></circle><circle cx="16" cy="18" r="1.6"></circle>', 12, ' fill="var(--muted)" stroke="none"') +
            '<span style="font-weight:600;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(label) + '</span>' +
            '<span style="margin-left:auto;display:flex;gap:2px"><button class="link" data-a="mv:' + i + ':-1" aria-label="Move earlier" style="color:var(--muted)">←</button><button class="link" data-a="mv:' + i + ':1" aria-label="Move later" style="color:var(--muted)">→</button></span></div>' +
            '<div style="font-size:12px;color:var(--muted);margin-top:2px">' + esc(subT) + '</div></div>';
        }).join('') + '</div>';
      }
    }

    /* who can see it */
    var nameOf = function (s) {
      if (s.principal_type === 'role' || s.principal_type === 'department') { var t = M.teams.find(function (x) { return x.type === s.principal_type && x.id === s.principal_id; }); return t ? t.name : s.principal_id; }
      var pp = M.people.find(function (x) { return x.id === s.principal_id; }); return pp ? pp.full_name : 'A person';
    };
    h += '<div style="margin-top:20px;font-weight:600">Who can see it</div>';
    if (!d.isOwner) h += '<p class="note" style="margin-top:6px">Only the creator of a view changes who can see it.</p>';
    else {
      if (!d.share.length) h += '<p class="note" style="margin-top:6px">Private: only you can see this view.</p>';
      h += d.share.map(function (x, i) {
        return '<div style="display:flex;align-items:center;gap:10px;margin-top:6px"><span style="font-weight:500">' + esc(nameOf(x)) + '</span><span class="chip">' + (x.permission === 'editor' ? 'Can view and edit' : 'Can view') + '</span><button class="link" data-a="shrm:' + i + '">Remove</button></div>';
      }).join('');
      var taken = d.share.map(function (s) { return s.principal_type + ':' + s.principal_id; });
      h += '<div style="display:flex;gap:8px;margin-top:8px;align-items:center;flex-wrap:wrap"><select class="sel" style="width:240px" data-in="d:shareSel" aria-label="Person or team"><option value="">Person or team</option>' +
        [['department', 'Departments'], ['role', 'Roles']].map(function (g) {
          return '<optgroup label="' + g[1] + '">' + M.teams.filter(function (t) { return t.type === g[0] && taken.indexOf(t.type + ':' + t.id) < 0; }).map(function (t) {
            var v = t.type + ':' + t.id; return '<option value="' + v + '"' + (d.shareSel === v ? ' selected' : '') + '>' + esc(t.name) + '</option>'; }).join('') + '</optgroup>';
        }).join('') +
        '<optgroup label="People">' + M.people.filter(function (p) { return taken.indexOf('user:' + p.id) < 0; }).map(function (p) { return '<option value="user:' + p.id + '"' + (d.shareSel === 'user:' + p.id ? ' selected' : '') + '>' + esc(p.full_name) + '</option>'; }).join('') + '</optgroup></select>' +
        '<select class="sel" data-in="d:shareRole" aria-label="Access"><option value="viewer"' + (d.shareRole !== 'editor' ? ' selected' : '') + '>Can view</option><option value="editor"' + (d.shareRole === 'editor' ? ' selected' : '') + '>Can view and edit</option></select>' +
        '<button class="btn press" data-a="shadd"' + (d.shareSel ? '' : ' disabled') + '>Add</button></div>';
    }

    h += '<div style="display:flex;gap:8px;margin-top:22px;padding-top:14px;border-top:1px solid var(--rule);align-items:center;flex-wrap:wrap">' +
      '<button class="btn press' + (canSave ? ' on' : '') + '" data-a="cvsave" style="color:var(--ink)"' + (canSave && !S.cv.saving ? '' : ' disabled') + '>' + (S.cv.saving ? 'Saving…' : 'Save view') + '</button>' +
      '<button class="btn press" data-a="cvcancel">Cancel</button>' +
      '<span class="note">' + esc(S.cv.err || (canSave ? '' : d.how === 'create' ? 'Save the property group first, then it is used for this view.' : 'Add a name, properties, and at least one card or display style.')) + '</span>' +
      (d.id && d.isOwner ? '<button class="link" data-a="cvdelete" style="margin-left:auto;color:var(--bad)">Delete view</button>' : '') + '</div></section>';
    if (!local) schedulePreview();
    return h;
  }

  /* ---- builder actions -------------------------------------------------- */
  function D() { return S.cv.draft; }
  function toggleIn(arr, v) { var i = arr.indexOf(v); if (i >= 0) arr.splice(i, 1); else arr.push(v); }
  function newCardId() { return 'c' + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36); }
  function keyToPeriod(k, old) {
    var t = (S.data.people && S.data.people.periods.through) || '';
    if (k.indexOf('m:') === 0) return { t: 'month', a: k.slice(2) };
    if (k === 'range') return { t: 'range', a: old && old.a ? old.a : t, b: old && old.b ? old.b : t };
    return { t: k };
  }
  function saveView() {
    var d = D(); if (!d) return;
    var body = { name: d.name.trim(), config: draftConfig(d) };
    if (d.isOwner) body.shares = d.share;
    S.cv.saving = true; S.cv.err = ''; paint();
    var req = d.id ? api('/api/props/views/' + d.id, 'PUT', body) : api('/api/props/views', 'POST', body);
    req.then(function (r) {
      var id = d.id || r.view.id;
      drop('views'); drop('view:' + id);
      S.cv = { mode: 'view', sel: id, draft: null, exportOpen: false, msg: '', preview: null, previewKey: '', saving: false, err: '' };
      pushUrl(); paint();
    }, function (e) { S.cv.saving = false; S.cv.err = e.message; paint(); });
  }
  function saveGroup() {
    var d = D();
    api('/api/props/groups', 'POST', { name: d.newGroupName.trim(), property_ids: d.newProps }).then(function (r) {
      drop('groups');
      d.groups.push(r.group.id); d.how = 'group'; d.newGroupName = ''; d.newProps = []; d.q = '';
      paint();
    }, function (e) { S.cv.err = e.message; paint(); });
  }
  function deleteView() {
    var d = D();
    if (!d || !d.id || !window.confirm('Delete the view "' + d.name + '"? People it was shared with lose it too.')) return;
    api('/api/props/views/' + d.id, 'DELETE').then(function () {
      drop('views'); drop('view:' + d.id);
      S.cv = { mode: 'view', sel: null, draft: null, exportOpen: false, msg: '', preview: null, previewKey: '', saving: false, err: '' };
      paint();
    }, function (e) { S.cv.err = e.message; paint(); });
  }

  /* ===================================================================== */
  /*  paint + events                                                        */
  /* ===================================================================== */
  /* The page a render belongs to. Its <main> carries this as data-k, so a
     different page replaces the main (and fades in) while every other
     render - a filter, an input, a menu, a sort, density, a load landing -
     patches the existing nodes in place (PortalMorph): nothing replays its
     entry animation, scroll positions and the caret stay where they are. */
  function pageKey() {
    if (S.level === 'property') return 'property:' + S.prop;
    if (S.level === 'entity') return 'entity:' + (S.ent || 'none');
    return 'portfolio:' + S.l1;
  }
  function paint() {
    if (!S.host || !document.body.contains(S.host)) return;
    if (cur('list')) defaultPeriod();
    S.staleNow = false;
    var body = S.level === 'property' ? propertyHtml() : S.level === 'entity' ? entityHtml() : portfolioHtml();
    body = body.replace('<main ', '<main data-k="' + esc(pageKey()) + '" ');
    window.PortalMorph.morph(S.host, '<div class="lw' + (S.dense ? ' lw-dense' : '') + '">' + headHtml() + body + '</div>');
  }

  function onClick(ev) {
    var el = ev.target.closest('[data-a]');
    if (!el || !S.host.contains(el)) return;
    var a = el.getAttribute('data-a'), parts = a.split(':'), d = D();
    var cmd = parts[0];
    if (cmd.indexOf('rp') === 0 && window.PortalReports) {
      if (el.tagName !== 'INPUT') ev.preventDefault();
      window.PortalReports.act(cmd, parts, el); return;
    }
    if (el.tagName === 'INPUT') {
      /* checkboxes act on click; let the box tick first */
    } else ev.preventDefault();
    switch (cmd) {
      case 'crumb': if (parts[1] === 'portfolio') goPortfolio(); else goEntity(S.ent); return;
      case 'dense': S.dense = parts[1] === '1'; try { localStorage.setItem('lwDense', S.dense ? '1' : '0'); } catch (e) { /* ignore */ } paint(); return;
      case 'l1': S.l1 = parts[1]; closeMenus(); pushUrl(); paint(); return;
      case 'ent': goEntity(parts[1]); return;
      case 'prop': goProperty(parts[1]); return;
      case 'src': S.src = parts[1]; paint(); return;
      case 'ptab': S.ptab = parts[1]; closeMenus(); pushUrl(); paint(); return;
      case 'export': S.exportOpen = !S.exportOpen; paint(); return;
      case 'xp': exportTab(parts[1]); return;
      case 'clearmsg': S.exportMsg = ''; paint(); return;
      case 'retry': S.errors = {}; paint(); return;
      case 'oareset': delete S.oa[S.prop]; paint(); return;
      case 'wreset': delete S.wnoi[S.prop]; paint(); return;
      /* custom view */
      case 'cvsel': S.cv.sel = parts[1]; S.cv.mode = 'view'; S.cv.draft = null; S.cv.exportOpen = false; S.cv.msg = ''; pushUrl(); paint(); return;
      case 'cvadd': S.cv.mode = 'build'; S.cv.draft = emptyDraft(); S.cv.preview = null; S.cv.previewKey = ''; S.cv.err = ''; S.cv.msg = ''; S.cv.exportOpen = false; paint(); return;
      case 'cvedit': { var VD = S.data['view:' + S.cv.sel]; if (!VD) return; S.cv.mode = 'build'; S.cv.draft = draftFromView(VD); S.cv.preview = null; S.cv.previewKey = ''; S.cv.err = ''; S.cv.exportOpen = false; paint(); return; }
      case 'cvexport': S.cv.exportOpen = !S.cv.exportOpen; paint(); return;
      case 'cvx': exportView(parts[1]); return;
      case 'cvclear': S.cv.msg = ''; paint(); return;
      case 'cvcancel': S.cv.mode = 'view'; S.cv.draft = null; S.cv.err = ''; paint(); return;
      case 'cvsave': saveView(); return;
      case 'cvdelete': deleteView(); return;
    }
    if (!d) return;
    switch (cmd) {
      case 'bmode': d.bmode = parts[1]; break;
      case 'how': d.how = parts[1]; d.q = ''; break;
      case 'grp': {
        var gid = parts[1];
        if (d.groups.indexOf(gid) >= 0) { d.groups.splice(d.groups.indexOf(gid), 1); d.excl = d.excl.filter(function (x) { return x.indexOf(gid + '|') !== 0; }); }
        else d.groups.push(gid);
        break;
      }
      case 'excl': toggleIn(d.excl, a.slice(5)); break;
      case 'pick': toggleIn(d[parts[1]], parts[2]); break;
      case 'savegroup': saveGroup(); return;
      case 'fld': toggleIn(d.fields, parts[1]); break;
      case 'qcards': d.quickCards = !d.quickCards; break;
      case 'sty': toggleIn(d.styles, parts[1]); d.layout = syncLayout(d.layout, d.cards, d.styles); break;
      case 'addcard': { var id = newCardId(); d.cards.push({ id: id, label: 'New card', kind: 'value', field: 'inc', period: { t: 'ttm' }, agg: 'total', size: 'M', fmt: 'money', terms: [] }); d.openCard = id; d.layout = syncLayout(d.layout, d.cards, d.styles); break; }
      case 'ctog': d.openCard = d.openCard === parts[1] ? null : parts[1]; break;
      case 'crm': d.cards = d.cards.filter(function (c) { return c.id !== parts[1]; }); d.layout = syncLayout(d.layout, d.cards, d.styles); break;
      case 'ckind': {
        var c = d.cards[+parts[1]]; c.kind = parts[2];
        if (c.kind === 'formula' && !(c.terms && c.terms.length)) {
          var t = S.data.people.periods.through, prev = t;
          var k = +t.slice(0, 4) * 12 + (+t.slice(5)) - 2; prev = Math.floor(k / 12) + '-' + String((k % 12) + 1).padStart(2, '0');
          c.terms = [{ kind: 'field', field: 'inc', period: { t: 'month', a: prev }, agg: 'total' }, { op: '+', kind: 'field', field: 'inc', period: { t: 'month', a: t }, agg: 'total' }];
          c.fmt = c.fmt || 'money';
        }
        break;
      }
      case 'tadd': d.cards[+parts[1]].terms.push({ op: '+', kind: 'field', field: 'inc', period: { t: 'ttm' }, agg: 'total' }); break;
      case 'trm': d.cards[+parts[1]].terms.splice(+parts[2], 1); delete d.cards[+parts[1]].terms[0].op; break;
      case 'mv': {
        var L2 = syncLayout(d.layout, d.cards, d.styles), from = +parts[1], to = from + (+parts[2]);
        if (to < 0 || to >= L2.length) return;
        var x = L2.splice(from, 1)[0]; L2.splice(to, 0, x); d.layout = L2; break;
      }
      case 'shadd': {
        if (!d.shareSel) return;
        var ps = d.shareSel.split(':');
        d.share.push({ principal_type: ps[0], principal_id: ps[1], permission: d.shareRole === 'editor' ? 'editor' : 'viewer' });
        d.shareSel = ''; break;
      }
      case 'shrm': d.share.splice(+parts[1], 1); break;
      default: return;
    }
    paint();
  }

  function setIn(key, value, isChange) {
    var parts = key.split(':'), d = D();
    if (parts[0].indexOf('rp') === 0 && window.PortalReports) return window.PortalReports.input(key, value);
    switch (parts[0]) {
      case 'q': S.q = value; return true;
      case 'fm': case 'tm': case 'fy': case 'ty': S[parts[0]] = +value; pushUrl(); return true;
      case 'feeYear': S.feeYear = +value; return true;
      case 'feeFrom': S.feeFrom = +value; return true;
      case 'feeTo': S.feeTo = +value; return true;
      case 'asOf': S.asOf = value; pushUrl(); return true;
      /* what-if inputs recalculate as you type, all in the browser: the
         render patches the figures in place and leaves the input alone */
      case 'oa': S.oa[S.prop] = Object.assign({}, S.oa[S.prop] || {}, (function () { var o = {}; o[parts[1]] = value; return o; })()); return true;
      case 'wnoi': S.wnoi[S.prop] = value; return true;
    }
    if (!d) return false;
    if (parts[0] === 'd') { d[parts[1]] = value; return true; }
    if (parts[0] === 'c') {
      var c = d.cards[+parts[1]], k = parts[2];
      if (k === 'period') c.period = keyToPeriod(value, c.period);
      else if (k === 'pa') c.period = { t: 'range', a: value, b: c.period.b };
      else if (k === 'pb') c.period = { t: 'range', a: c.period.a, b: value };
      else c[k] = value;
      return true;
    }
    if (parts[0] === 't') {
      var tm = d.cards[+parts[1]].terms[+parts[2]], tk = parts[3];
      if (tk === 'period') tm.period = keyToPeriod(value, tm.period);
      else if (tk === 'pa') tm.period = { t: 'range', a: value, b: tm.period.b };
      else if (tk === 'pb') tm.period = { t: 'range', a: tm.period.a, b: value };
      else if (tk === 'num') tm.num = value === '' ? 0 : Number(value);
      else {
        tm[tk] = value;
        if (tk === 'kind' && value === 'field' && !tm.field) { tm.field = 'inc'; tm.period = { t: 'ttm' }; tm.agg = 'total'; }
      }
      return true;
    }
    return false;
  }
  function onInput(ev) {
    var el = ev.target, k = el.getAttribute && el.getAttribute('data-in');
    if (!k || el.tagName === 'SELECT') return;
    /* typing updates state; search boxes repaint as you type (the caret is
       kept), the rest wait for change so a number is not recomputed mid-entry */
    if (setIn(k, el.value, false)) paint();
    else if (S.cv.draft) schedulePreview();
  }
  function onChange(ev) {
    var el = ev.target, k = el.getAttribute && el.getAttribute('data-in');
    if (!k) return;
    setIn(k, el.value, true);
    /* change fires DURING blur; repainting now would remove the node the
       browser is blurring, so defer a tick */
    setTimeout(paint, 0);
  }
  function onDragStart(ev) {
    var t = ev.target.closest && ev.target.closest('[data-drag]');
    if (!t || !D()) return;
    D().drag = +t.getAttribute('data-drag');
    try { ev.dataTransfer.effectAllowed = 'move'; ev.dataTransfer.setData('text/plain', String(D().drag)); } catch (e) { /* ignore */ }
  }
  function onDragOver(ev) { if (ev.target.closest && ev.target.closest('[data-drag]')) ev.preventDefault(); }
  function onDrop(ev) {
    var t = ev.target.closest && ev.target.closest('[data-drag]'), d = D();
    if (!t || !d || d.drag === null || d.drag === undefined) return;
    ev.preventDefault();
    var L2 = syncLayout(d.layout, d.cards, d.styles), from = d.drag, to = +t.getAttribute('data-drag');
    if (from !== to) { var x = L2.splice(from, 1)[0]; L2.splice(to, 0, x); d.layout = L2; }
    d.drag = null; paint();
  }

  var docBound = false;
  function bindDoc() {
    if (docBound) return; docBound = true;
    document.addEventListener('click', function (ev) {
      if (S.host && window.PortalReports && window.PortalReports.clickOutside(ev.target)) { paint(); return; }
      if (!S.host || !S.exportOpen && !S.cv.exportOpen) return;
      if (ev.target.closest && (ev.target.closest('.lw-menu') || ev.target.closest('[data-a="export"]') || ev.target.closest('[data-a="cvexport"]'))) return;
      S.exportOpen = false; S.cv.exportOpen = false; paint();
    });
    document.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape' && S.host && document.body.contains(S.host) && window.PortalReports && window.PortalReports.escape()) { paint(); return; }
      if (ev.key === 'Escape' && (S.exportOpen || S.cv.exportOpen)) { S.exportOpen = false; S.cv.exportOpen = false; paint(); }
    });
  }

  function mount(host) {
    if (!host) return;
    ensureUrlRead();
    S.host = host;
    if (window.PortalReports) window.PortalReports.init({ api: api, authHeaders: authHeaders, paint: paint, esc: esc, fmt: fmt });
    host.onclick = onClick; host.oninput = onInput; host.onchange = onChange;
    host.ondragstart = onDragStart; host.ondragover = onDragOver; host.ondrop = onDrop;
    bindDoc();
    paint();
  }
  /* realtime: a property, unit, loan or rent roll changed somewhere. The
     materialised views only move after a refresh, so drop everything. */
  function invalidate() {
    /* keep showing what is on screen while each key refetches (need() serves
       S.old until the new answer lands), so a sync elsewhere never blanks it */
    Object.keys(S.data).forEach(function (k) { S.old[k] = S.data[k]; });
    S.data = {}; S.errors = {}; S.pending = {}; S.cv.localKey = ''; paint();
  }

  /* back to the section's front door: Portfolio > Entities. The shell calls
     this when someone comes INTO LeavenWealth from elsewhere; loaded data and
     the period stay (they are caches and preferences, not a place). */
  function reset() {
    ensureUrlRead();
    S.level = 'portfolio'; S.l1 = 'entities'; S.ent = null; S.prop = null; S.ptab = 'overview';
    S.q = ''; S.asOf = null; closeMenus();
  }

  window.PortalProps = { mount: mount, invalidate: invalidate, urlParams: urlParams, reset: reset, _state: S,
                         _internal: { monthlyModel: monthlyModel, optimizedModel: optimizedModel, sentence: sentence, fmt: fmt } };
})();
