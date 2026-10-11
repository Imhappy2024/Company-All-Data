/* ===========================================================================
   portal-reports.js — Properties > Reports (docs/mockup/properties-mockup.dc.html,
   the Reports tab): Build report | Saved reports | Scheduled.

   Rendered INSIDE PortalProps' portfolio page: portal-props.js calls html()
   for the tab body and forwards every data-a="rp*" click and data-in="rp*"
   input here, then repaints (PortalMorph), so this module never touches the
   DOM itself. Every figure comes from /api/reports (reports-api.js), which
   builds the document under the signed-in person's own access; the preview,
   the exported file and the emailed attachment are the same document.
   =========================================================================== */
(function () {
  'use strict';

  var X = null;   /* helpers from PortalProps: api, authHeaders, paint, esc, fmt */
  var R = {
    tab: 'build',
    reports: { income: true, rr: false, opt: false },
    incType: 'quarter', from: null, to: null, quarter: null, half: null, annual: 'T12',
    stmt: { is: true, cf: false }, props: [], q: '',
    preview: false, doc: null, docKey: '', loading: false, err: '',
    exportOpen: false, dialog: null, form: {}, busy: false, msg: '', msgBad: false, reportId: null,
    opts: null, optsErr: '', saved: null, scheds: null, listErr: '',
  };

  function esc(s) { return X.esc(s); }
  function cfg() {
    return { reports: { income: R.reports.income, rr: R.reports.rr, opt: R.reports.opt }, incType: R.incType,
             from: R.from, to: R.to, quarter: R.quarter, half: R.half, annual: R.annual,
             stmt: { is: R.stmt.is, cf: R.stmt.cf }, props: R.props.slice() };
  }
  function applyCfg(c) {
    R.reports = Object.assign({ income: false, rr: false, opt: false }, c.reports);
    R.incType = c.incType || 'quarter';
    ['from', 'to', 'quarter', 'half'].forEach(function (k) { if (c[k]) R[k] = c[k]; });
    R.annual = c.annual || 'T12';
    R.stmt = Object.assign({ is: true, cf: false }, c.stmt);
    R.props = (c.props || []).slice();
  }
  function canPreview() {
    return (R.reports.income || R.reports.rr || R.reports.opt) && R.props.length > 0 && (!R.reports.income || R.stmt.is || R.stmt.cf);
  }
  function canWrite() { return !!(R.opts && R.opts.canWrite); }
  function say(msg, bad) { R.msg = msg; R.msgBad = !!bad; }

  /* ---- loading ------------------------------------------------------------ */
  function loadOptions() {
    if (R.opts || R.loadingOpts) return;
    R.loadingOpts = true;
    X.api('/api/reports/options').then(function (o) {
      R.opts = o; R.loadingOpts = false;
      var P = o.periods;
      if (!R.quarter && P.quarters[0]) R.quarter = P.quarters[0].v;
      if (!R.half && P.halves[0]) R.half = P.halves[0].v;
      if (!R.to && P.months[0]) { R.to = P.months[0].v; R.from = (P.months[2] || P.months[0]).v; }
      X.paint();
    }, function (e) { R.optsErr = e.message; R.loadingOpts = false; X.paint(); });
  }
  /* force refetches but keeps the current rows on screen until the new ones land */
  function loadLists(force) {
    if (!R.loadingSaved && (force || !R.saved)) {
      R.loadingSaved = true;
      X.api('/api/reports/saved').then(function (o) { R.saved = o.saved; R.loadingSaved = false; X.paint(); },
        function (e) { R.listErr = e.message; R.loadingSaved = false; X.paint(); });
    }
    if (!R.loadingScheds && (force || !R.scheds)) {
      R.loadingScheds = true;
      X.api('/api/reports/schedules').then(function (o) { R.scheds = o.schedules; R.loadingScheds = false; X.paint(); },
        function (e) { R.listErr = e.message; R.loadingScheds = false; X.paint(); });
    }
  }
  function loadPreview() {
    var key = JSON.stringify(cfg());
    if (R.docKey === key && (R.doc || R.loading)) return;
    R.docKey = key; R.loading = true; R.err = ''; R.doc = null;
    X.api('/api/reports/preview', 'POST', { config: cfg() }).then(function (o) {
      if (R.docKey !== key) return;          /* a newer request owns the screen */
      R.doc = o.doc; R.loading = false; X.paint();
    }, function (e) {
      if (R.docKey !== key) return;
      R.err = e.message; R.loading = false; X.paint();
    });
  }

  /* ---- actions --------------------------------------------------------------- */
  function download(fmt) {
    R.exportOpen = false; say('Preparing the file...'); X.paint();
    X.authHeaders().then(function (h) {
      h['Content-Type'] = 'application/json';
      return fetch('/api/reports/export', { method: 'POST', headers: h, body: JSON.stringify({ config: cfg(), format: fmt, name: R.doc && R.doc.name }) });
    }).then(function (r) {
      if (!r.ok) return r.json().then(function (b) { throw new Error(b.error || 'Export failed.'); });
      var cd = r.headers.get('Content-Disposition') || '', m = /filename\*=UTF-8''([^;]+)/.exec(cd);
      var name = m ? decodeURIComponent(m[1]) : 'report';
      return r.blob().then(function (b) {
        var a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = name;
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(function () { URL.revokeObjectURL(a.href); }, 4000);
        say('Downloaded "' + name + '".'); X.paint();
      });
    }).catch(function (e) { say(e.message, true); X.paint(); });
  }
  function nextMonthFirst() {
    var d = new Date(), y = d.getFullYear(), m = d.getMonth() + 2;
    if (m > 12) { m = 1; y++; }
    return y + '-' + String(m).padStart(2, '0') + '-01';
  }
  var GREETING = 'Hi,\n\nPlease find the attached report.\n\nThanks';
  function openDialog(kind, name) {
    var n = name || (R.doc && R.doc.name) || 'Report';
    R.exportOpen = false; R.dialog = kind; R.err = '';
    R.form = kind === 'save' ? { name: n }
      : { name: n, to: '', cc: '', bcc: '', subject: n, body: GREETING, fmt: 'pdf', start: nextMonthFirst(), repeat: 'monthly' };
  }
  function submitDialog() {
    var F = R.form, kind = R.dialog;
    if (R.busy) return;
    var path = kind === 'save' ? '/api/reports/saved' : kind === 'send' ? '/api/reports/send' : '/api/reports/schedules';
    var body = kind === 'save' ? { name: F.name, config: cfg() }
      : { config: cfg(), name: F.name, to: F.to, cc: F.cc, bcc: F.bcc, subject: F.subject, body: F.body, format: F.fmt,
          start: F.start, repeat: F.repeat, reportId: R.reportId };
    R.busy = true; R.dialogErr = ''; X.paint();
    X.api(path, 'POST', body).then(function (o) {
      R.busy = false; R.dialog = null;
      if (kind === 'save') { say('Saved "' + F.name.trim() + '" to Saved reports.'); }
      else if (kind === 'send') say('Sent "' + (F.subject || F.name) + '" to ' + F.to + (F.cc ? ', cc ' + F.cc : '') + ' as ' + F.fmt.toUpperCase() + '.');
      else { say('Scheduled "' + F.name.trim() + '": ' + F.repeat + ', next send ' + o.schedule.next + ', to ' + F.to + '.'); }
      loadLists(true); X.paint();
    }, function (e) { R.busy = false; R.dialogErr = e.message; X.paint(); });
  }
  function rowAct(path, method, body, done) {
    X.api(path, method, body).then(function () { say(done); loadLists(true); X.paint(); }, function (e) { say(e.message, true); X.paint(); });
  }

  /* data-a="rp...": the click handler in portal-props.js forwards these */
  function act(cmd, parts) {
    var F = R.form;
    switch (cmd) {
      case 'rptab': R.tab = parts[1]; R.dialog = null; R.exportOpen = false; if (R.tab !== 'build') loadLists(); break;
      case 'rprep': R.reports[parts[1]] = !R.reports[parts[1]]; R.preview = false; break;
      case 'rpinc': R.incType = parts[1]; R.preview = false; break;
      case 'rpstmt': R.stmt[parts[1]] = !R.stmt[parts[1]]; R.preview = false; break;
      case 'rpprop': {
        var id = parts[1], i = R.props.indexOf(id);
        if (i >= 0) R.props.splice(i, 1); else if (R.props.length < ((R.opts && R.opts.maxProps) || 60)) R.props.push(id);
        R.preview = false; break;
      }
      case 'rpshown': shown().forEach(function (p) { if (R.props.indexOf(p.id) < 0 && R.props.length < ((R.opts && R.opts.maxProps) || 60)) R.props.push(p.id); }); R.preview = false; break;
      case 'rpclear': R.props = []; R.preview = false; break;
      case 'rppreview': if (!canPreview()) return; R.preview = true; R.reportId = null; loadPreview(); break;
      case 'rpback': R.preview = false; R.exportOpen = false; break;
      case 'rpexport': R.exportOpen = !R.exportOpen; break;
      case 'rpx': download(parts[1]); return;
      case 'rpdlg': if (!canWrite()) return; openDialog(parts[1]); break;
      case 'rpclose': R.dialog = null; R.dialogErr = ''; break;
      case 'rpsubmit': submitDialog(); return;
      case 'rprepeat': F.repeat = parts[1]; break;
      case 'rpmsg': R.msg = ''; break;
      case 'rpopen': case 'rpsend': case 'rpsched': {
        var s = (R.saved || []).filter(function (x) { return x.id === parts[1]; })[0];
        if (!s) return;
        applyCfg(s.config); R.tab = 'build'; R.preview = true; R.reportId = s.id; loadPreview();
        if (cmd !== 'rpopen' && canWrite()) openDialog(cmd === 'rpsend' ? 'send' : 'schedule', s.name);
        break;
      }
      case 'rpdel':
        if (!window.confirm('Delete this saved report? Schedules made from it keep running.')) return;
        rowAct('/api/reports/saved/' + parts[1], 'DELETE', undefined, 'Deleted the saved report.'); return;
      case 'rpscopen': {
        var c = (R.scheds || []).filter(function (x) { return x.id === parts[1]; })[0];
        if (!c) return;
        applyCfg(c.config); R.tab = 'build'; R.preview = true; R.reportId = null; loadPreview(); break;
      }
      case 'rppause': rowAct('/api/reports/schedules/' + parts[1], 'PATCH', { active: parts[2] === '1' }, parts[2] === '1' ? 'Schedule resumed.' : 'Schedule paused.'); return;
      case 'rpsdel':
        if (!window.confirm('Delete this schedule? Nothing more will be sent.')) return;
        rowAct('/api/reports/schedules/' + parts[1], 'DELETE', undefined, 'Deleted the schedule.'); return;
      default: return;
    }
    X.paint();
  }
  /* data-in="rp...": true when the screen should repaint */
  function input(key, value) {
    var k = key.split(':');
    if (k[0] === 'rpq') { R.q = value; return true; }
    if (k[0] === 'rpper') { R[k[1]] = value; R.preview = false; return true; }
    if (k[0] === 'rpf') { R.form[k[1]] = value; return k[1] === 'start' || k[1] === 'fmt' || k[1] === 'to' || k[1] === 'name'; }
    return false;
  }
  function escape() {
    if (R.dialog) { R.dialog = null; return true; }
    if (R.exportOpen) { R.exportOpen = false; return true; }
    return false;
  }
  function clickOutside(target) {
    if (!R.exportOpen) return false;
    if (target.closest && (target.closest('.lw-menu') || target.closest('[data-a="rpexport"]'))) return false;
    R.exportOpen = false; return true;
  }

  /* ---- markup --------------------------------------------------------------- */
  function shown() {
    var q = (R.q || '').trim().toLowerCase();
    return ((R.opts && R.opts.properties) || []).filter(function (p) {
      return !q || (p.name + ' ' + (p.mgr || '') + ' ' + (p.pm || '')).toLowerCase().indexOf(q) >= 0;
    });
  }
  function cb(on, a, label, sub, style) {
    return '<label style="display:flex;gap:10px;cursor:pointer;' + (style || '') + '"><input type="checkbox" data-a="' + a + '"' + (on ? ' checked' : '') +
      ' style="accent-color:var(--accent);margin-top:3px">' + (sub === undefined ? '<span>' + esc(label) + '</span>'
      : '<span><span style="font-weight:600">' + esc(label) + '</span><span style="display:block;font-size:12.5px;color:var(--muted)">' + esc(sub) + '</span></span>') + '</label>';
  }
  function select(key, val, list) {
    return '<select class="sel" data-in="' + key + '">' + list.map(function (o) {
      return '<option value="' + esc(o.v) + '"' + (o.v === val ? ' selected' : '') + '>' + esc(o.label) + '</option>';
    }).join('') + '</select>';
  }
  function tabs() {
    var nS = R.saved ? R.saved.length : '', nC = R.scheds ? R.scheds.length : '';
    return '<div role="tablist" class="lw-tabs" style="margin-top:0">' + [['build', 'Build report', ''], ['saved', 'Saved reports', nS], ['scheduled', 'Scheduled', nC]].map(function (t) {
      return '<button role="tab" aria-selected="' + (R.tab === t[0]) + '" class="tab press' + (R.tab === t[0] ? ' on' : '') + '" data-a="rptab:' + t[0] + '">' + t[1] +
        (t[2] !== '' ? ' <span style="color:var(--muted);font-weight:400">' + t[2] + '</span>' : '') + '</button>';
    }).join('') + '</div>';
  }
  function msgBar() {
    if (!R.msg) return '';
    return '<div role="status" class="lw-rp-msg' + (R.msgBad ? ' bad' : '') + '"><span>' + esc(R.msg) + '</span><button class="link" data-a="rpmsg" style="margin-left:auto">Dismiss</button></div>';
  }

  function buildHtml() {
    var o = R.opts, P = o.periods;
    var h = '<div style="display:grid;grid-template-columns:minmax(0,1.15fr) minmax(0,1fr);gap:20px;margin-top:16px;align-items:start" class="lw-rp-grid">';
    h += '<section class="frame" style="padding:16px 18px"><div style="font-weight:600">1. Reports</div><div style="display:flex;flex-direction:column;gap:8px;margin-top:10px">' +
      [['income', 'Income report', 'Income statement and cash flow by month, for a regular, quarterly, bi-annual or annual period'],
       ['rr', 'Rent roll', 'Units, occupancy, rent, delinquency and unit mix from the latest rent roll'],
       ['opt', 'Optimized NOI', 'Trailing NOI against the best 6, 3 and 1-month stretches, with their months']].map(function (b) {
        return cb(R.reports[b[0]], 'rprep:' + b[0], b[1], b[2], 'padding:10px 12px;border:1px solid var(--rule);border-radius:8px');
      }).join('') + '</div>';
    if (R.reports.income) {
      h += '<div style="margin-top:16px;font-weight:600">2. Income report period</div><div style="display:flex;gap:6px;margin-top:8px;flex-wrap:wrap">' +
        [['regular', 'Regular'], ['quarter', 'Quarterly'], ['half', 'Bi-annual'], ['annual', 'Annual']].map(function (b) {
          return '<button class="btn press' + (R.incType === b[0] ? ' on' : '') + '" aria-pressed="' + (R.incType === b[0]) + '" data-a="rpinc:' + b[0] + '">' + b[1] + '</button>';
        }).join('') + '</div><div style="display:flex;gap:8px;align-items:center;margin-top:10px;flex-wrap:wrap;font-size:13px;color:var(--muted)">';
      if (R.incType === 'regular') h += '<span>From</span>' + select('rpper:from', R.from, P.months.slice().reverse()) + '<span>to</span>' + select('rpper:to', R.to, P.months.slice().reverse());
      else if (R.incType === 'quarter') h += select('rpper:quarter', R.quarter, P.quarters);
      else if (R.incType === 'half') h += select('rpper:half', R.half, P.halves);
      else h += select('rpper:annual', R.annual, P.years);
      h += '</div><div style="display:flex;gap:18px;margin-top:10px">' + cb(R.stmt.is, 'rpstmt:is', 'Income statement') + cb(R.stmt.cf, 'rpstmt:cf', 'Cash flow statement') + '</div>';
    }
    h += '</section>';
    var list = shown();
    h += '<section class="frame" style="padding:16px 18px"><div style="display:flex;align-items:center;justify-content:space-between"><span style="font-weight:600">' + (R.reports.income ? '3' : '2') +
      '. Properties</span><span class="note">' + R.props.length + (R.props.length === 1 ? ' property selected' : ' properties selected') + '</span></div>' +
      '<div style="display:flex;gap:8px;margin-top:10px;align-items:center"><input class="sel" type="search" placeholder="Search property, entity or manager" data-in="rpq" value="' + esc(R.q) + '" style="flex:1" aria-label="Search properties">' +
      '<button class="link" data-a="rpshown">Select shown</button><button class="link" data-a="rpclear" style="color:var(--muted)">Clear</button></div>' +
      '<div class="scroll" style="margin-top:8px;max-height:330px;border:1px solid var(--rule);border-radius:6px">' +
      (list.length ? list.map(function (p) {
        var on = R.props.indexOf(p.id) >= 0;
        return '<label style="display:flex;align-items:center;gap:10px;padding:7px 12px;border-bottom:1px solid var(--rule);cursor:pointer"><input type="checkbox" data-a="rpprop:' + p.id + '"' + (on ? ' checked' : '') +
          ' style="accent-color:var(--accent)"><span style="font-weight:500;white-space:nowrap">' + esc(p.name) + '</span><span style="font-size:12px;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' +
          esc((p.mgr ? p.mgr + ', ' : '') + p.src) + '</span></label>';
      }).join('') : '<p class="note" style="padding:10px 12px">No property matches.</p>') + '</div></section></div>';
    var ok = canPreview();
    h += '<div style="display:flex;align-items:center;gap:12px;margin-top:16px"><button class="btn press' + (ok ? ' on' : '') + '" data-a="rppreview"' + (ok ? '' : ' disabled') +
      ' style="color:var(--ink);height:36px;padding:0 18px;font-weight:600">Preview report</button><span class="note">' +
      (ok ? '' : R.reports.income && !R.stmt.is && !R.stmt.cf ? 'Choose the income statement, the cash flow statement, or both.' : 'Choose at least one report and one property.') + '</span></div>';
    return h;
  }

  function cellHtml(c, extra) {
    var txt = c.f === 'text' ? esc(c.v === null || c.v === undefined ? '' : c.v) : esc(X.fmt(c.f, c.v));
    var neg = c.f !== 'text' && typeof c.v === 'number' && c.v < 0;
    return '<td class="' + (c.f === 'text' ? 'l' : '') + (extra || '') + '" style="' + (neg ? 'color:var(--bad)' : '') + '">' + txt + '</td>';
  }
  function docHtml(D) {
    var h = '<div class="lw-rp-paper"><div class="lw-rp-dochead"><div><div style="font-size:12px;color:var(--muted);letter-spacing:0.02em">LeavenWealth</div>' +
      '<div style="font-size:20px;font-weight:600;margin-top:2px">' + esc(D.name) + '</div></div><div style="text-align:right;font-size:12.5px;color:var(--muted)">' + esc(D.generated) + '</div></div>';
    if (D.omitted) h += '<p class="note" style="margin-top:10px">' + D.omitted + ' selected ' + (D.omitted === 1 ? 'property is' : 'properties are') + ' not included: you do not have access to ' + (D.omitted === 1 ? 'it' : 'them') + ', or there is no report data.</p>';
    D.docs.forEach(function (d) {
      h += '<div style="margin-top:22px"><div style="font-size:17px;font-weight:600">' + esc(d.name) + '</div><div style="font-size:12.5px;color:var(--muted)">' + esc(d.sub) + '</div>';
      d.sections.forEach(function (s) {
        h += '<div style="margin-top:14px"><div style="display:flex;align-items:baseline;gap:10px;flex-wrap:wrap"><span style="font-weight:600">' + esc(s.title) + '</span><span style="font-size:12.5px;color:var(--muted)">' + esc(s.sub) + '</span></div>';
        if (s.cards && s.cards.length) h += '<div class="lw-rp-cards">' + s.cards.map(function (c) { return '<div><div style="font-size:12px;color:var(--muted)">' + esc(c.k) + '</div><div style="font-weight:600">' + esc(c.v) + '</div></div>'; }).join('') + '</div>';
        if (s.note) h += '<p class="note" style="margin-top:6px">' + esc(s.note) + '</p>';
        if (s.table) {
          var t = s.table;
          h += '<div class="scroll" style="margin-top:8px;border:1px solid var(--rule);border-radius:8px"><table><thead><tr><th style="min-width:240px"></th>' +
            t.heads.map(function (x) { return '<th>' + esc(x) + '</th>'; }).join('') + (t.hasTotal ? '<th class="sep">Total</th>' : '') + '</tr></thead><tbody>' +
            t.rows.map(function (r) {
              var cls = r.kind === 'total' ? 'total' : r.kind === 'key' ? 'key' : r.kind === 'group' ? 'group' : '';
              return '<tr class="' + cls + '"><td style="' + (r.indent ? 'padding-left:24px;color:var(--muted)' : '') + '">' + esc(r.label) + '</td>' +
                r.cells.map(function (c) { return cellHtml(c); }).join('') + (t.hasTotal ? cellHtml(r.tot || { f: 'text', v: '' }, ' sep') : '') + '</tr>';
            }).join('') + '</tbody></table></div>';
        }
        h += '</div>';
      });
      h += '</div>';
    });
    if (!D.docs.length) h += '<p class="note" style="margin-top:18px">None of the selected properties have report data you can see.</p>';
    return h + '</div>';
  }

  function previewHtml() {
    var w = canWrite(), dis = w ? '' : ' disabled title="Your access to Properties is read-only"';
    var h = '<div style="display:flex;align-items:center;gap:8px;margin-top:14px;flex-wrap:wrap"><button class="link" data-a="rpback">&larr; Change report</button><span style="flex:1"></span>' +
      '<div style="position:relative"><button class="btn press" data-a="rpexport" aria-haspopup="menu" aria-expanded="' + R.exportOpen + '" style="color:var(--ink)"' + (R.doc ? '' : ' disabled') + '>Export &#9662;</button>' +
      (R.exportOpen ? '<div role="menu" class="lw-menu" style="width:250px">' + [['xlsx', 'Excel (.xlsx)', 'Each report on its own sheet'], ['pdf', 'PDF', 'Exactly as previewed'], ['csv', 'CSV', 'Plain data, one file per table']].map(function (o) {
        return '<button role="menuitem" class="press" data-a="rpx:' + o[0] + '"><div style="font-weight:600">' + o[1] + '</div><div style="font-size:12px;color:var(--muted)">' + o[2] + '</div></button>';
      }).join('') + '</div>' : '') + '</div>' +
      '<button class="btn press" data-a="rpdlg:save" style="color:var(--ink)"' + dis + '>Save report</button>' +
      '<button class="btn press" data-a="rpdlg:schedule" style="color:var(--ink)"' + dis + '>Schedule</button>' +
      '<button class="btn press on" data-a="rpdlg:send" style="color:var(--ink)"' + dis + '>Send</button></div>';
    if (R.err) return h + '<div class="lw-err" role="alert" style="margin-top:12px">' + esc(R.err) + '</div>';
    if (!R.doc) return h + '<div style="margin-top:12px">' + window.PortalLoader.full('the report') + '</div>';
    return h + '<div style="margin-top:12px">' + docHtml(R.doc) + '</div>';
  }

  function savedHtml() {
    if (!R.saved) return R.listErr ? '<div class="lw-err" role="alert" style="margin-top:14px">' + esc(R.listErr) + '</div>' : '<div style="margin-top:14px">' + window.PortalLoader.full('saved reports') + '</div>';
    if (!R.saved.length) return '<p class="note" style="margin-top:16px">No saved reports yet. Build one and choose "Save report".</p>';
    var w = canWrite();
    return '<div class="scroll frame" style="margin-top:14px"><table><thead><tr><th>Report</th><th class="l">Includes</th><th class="l">Properties</th><th class="l">Period</th><th class="l">Saved</th><th class="l"></th></tr></thead><tbody>' +
      R.saved.map(function (x) {
        return '<tr><td><button class="link" data-a="rpopen:' + x.id + '" style="font-weight:500">' + esc(x.name) + '</button></td><td class="l">' + esc(x.includes) + '</td><td class="l">' +
          x.properties + (x.properties === 1 ? ' property' : ' properties') + '</td><td class="l" style="color:var(--muted)">' + esc(x.period) + '</td><td class="l" style="color:var(--muted)">' +
          esc(x.when + (x.by ? ', ' + x.by : '')) + '</td><td class="l"><span style="display:inline-flex;gap:12px"><button class="link" data-a="rpopen:' + x.id + '">Open</button>' +
          (w ? '<button class="link" data-a="rpsend:' + x.id + '">Send</button><button class="link" data-a="rpsched:' + x.id + '">Schedule</button>' : '') +
          (x.canDelete ? '<button class="link" data-a="rpdel:' + x.id + '" style="color:var(--muted)">Delete</button>' : '') + '</span></td></tr>';
      }).join('') + '</tbody></table></div>';
  }

  var REPEAT = { daily: 'Daily', weekly: 'Weekly', monthly: 'Monthly', yearly: 'Yearly' };
  function schedHtml() {
    if (!R.scheds) return R.listErr ? '<div class="lw-err" role="alert" style="margin-top:14px">' + esc(R.listErr) + '</div>' : '<div style="margin-top:14px">' + window.PortalLoader.full('schedules') + '</div>';
    if (!R.scheds.length) return '<p class="note" style="margin-top:16px">No scheduled reports yet.</p>';
    return '<div class="scroll frame" style="margin-top:14px"><table><thead><tr><th>Report</th><th class="l">Sent to</th><th class="l">Repeats</th><th class="l">Next send</th><th class="l">Last sent</th><th class="l">Format</th><th class="l">Status</th><th class="l"></th></tr></thead><tbody>' +
      R.scheds.map(function (x) {
        var failed = x.lastStatus === 'failed' || x.lastStatus === 'skipped';
        var status = !x.active ? 'Paused' : failed ? (x.lastStatus === 'skipped' ? 'Skipped last send' : 'Last send failed') : 'Active';
        return '<tr><td><button class="link" data-a="rpscopen:' + x.id + '" style="font-weight:500">' + esc(x.name) + '</button>' + (x.by ? '<div style="font-size:12px;color:var(--muted)">' + esc(x.by) + '</div>' : '') + '</td>' +
          '<td class="l">' + esc(x.to.join(', ') + (x.cc.length ? ' (cc ' + x.cc.join(', ') + ')' : '')) + '</td><td class="l">' + REPEAT[x.repeat] + '</td><td class="l">' + esc(x.next) + '</td>' +
          '<td class="l" style="color:var(--muted)">' + esc(x.last) + '</td><td class="l">' + x.format.toUpperCase() + '</td>' +
          '<td class="l" style="' + (!x.active ? 'color:var(--muted)' : failed ? 'color:var(--bad)' : 'color:var(--ok)') + '"' + (failed && x.lastError ? ' title="' + esc(x.lastError) + '"' : '') + '>' + status + '</td>' +
          '<td class="l">' + (x.canChange ? '<span style="display:inline-flex;gap:12px"><button class="link" data-a="rppause:' + x.id + ':' + (x.active ? '0' : '1') + '">' + (x.active ? 'Pause' : 'Resume') + '</button>' +
          '<button class="link" data-a="rpsdel:' + x.id + '" style="color:var(--muted)">Delete</button></span>' : '') + '</td></tr>';
      }).join('') + '</tbody></table></div>';
  }

  function field(label, key, val, extra) {
    return '<label class="lw-rp-f">' + label + '<input class="sel" data-in="rpf:' + key + '" value="' + esc(val) + '"' + (extra || '') + '></label>';
  }
  function chicagoDayLabel(day) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day || '');
    if (!m) return '–';
    return ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][+m[2] - 1] + ' ' + (+m[3]) + ', ' + m[1] + ', 9:00 AM';
  }
  function dialogHtml() {
    if (!R.dialog) return '';
    var F = R.form, k = R.dialog;
    var title = k === 'save' ? 'Save report' : k === 'send' ? 'Send report' : 'Schedule report';
    var h = '<div class="lw-rp-scrim" data-a="rpclose"></div><div role="dialog" aria-modal="true" aria-label="' + title + '" class="lw-rp-dlg">' +
      '<div class="lw-rp-dlg-h">' + title + '</div><div class="lw-rp-dlg-b">';
    if (k === 'save') h += field('Report name', 'name', F.name) + '<span class="note">Saved reports keep the reports, period type and properties, and always show the latest data when opened.</span>';
    else {
      if (k === 'schedule') h += field('Schedule name', 'name', F.name);
      h += field('To', 'to', F.to, ' placeholder="name@company.com, separate with commas" type="text"') +
        '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">' + field('Cc (optional)', 'cc', F.cc) + field('Bcc (optional)', 'bcc', F.bcc) + '</div>' +
        field('Subject', 'subject', F.subject) +
        '<label class="lw-rp-f">Message<textarea class="sel" rows="5" data-in="rpf:body" style="height:auto;padding:8px 10px;resize:vertical">' + esc(F.body) + '</textarea></label>' +
        '<label style="display:flex;align-items:center;gap:10px;color:var(--muted)">Attach as<select class="sel" data-in="rpf:fmt">' +
        [['pdf', 'PDF'], ['xlsx', 'Excel (.xlsx)'], ['csv', 'CSV (zipped)']].map(function (o) { return '<option value="' + o[0] + '"' + (F.fmt === o[0] ? ' selected' : '') + '>' + o[1] + '</option>'; }).join('') + '</select></label>';
      if (k === 'schedule') {
        h += '<div style="display:flex;gap:12px;align-items:flex-end;flex-wrap:wrap"><label class="lw-rp-f">First send<input class="sel" type="date" data-in="rpf:start" value="' + esc(F.start) + '"></label>' +
          '<div class="lw-rp-f">Repeat<span style="display:flex;gap:6px">' + ['daily', 'weekly', 'monthly', 'yearly'].map(function (r) {
            return '<button class="btn press' + (F.repeat === r ? ' on' : '') + '" aria-pressed="' + (F.repeat === r) + '" data-a="rprepeat:' + r + '">' + REPEAT[r] + '</button>';
          }).join('') + '</span></div></div>' +
          '<span class="note">First send ' + esc(chicagoDayLabel(F.start)) + ' (Central time). ' +
          (R.reports.income ? 'Each send uses the latest completed ' + ({ regular: 'month range of the same length', quarter: 'quarter', half: 'half-year', annual: R.annual === 'T12' ? 'twelve months' : 'year' })[R.incType] + '; the rent roll uses the latest rent roll.' : 'Each send uses the latest data available on the send date.') +
          ' It only includes properties you can access on the day it sends.</span>';
      }
    }
    if (R.dialogErr) h += '<div class="lw-err" role="alert">' + esc(R.dialogErr) + '</div>';
    var ok = k === 'save' ? !!(F.name || '').trim() : /@/.test(F.to || '') && (k !== 'schedule' || (F.start && (F.name || '').trim()));
    var label = R.busy ? (k === 'send' ? 'Sending...' : 'Saving...') : k === 'save' ? 'Save' : k === 'send' ? 'Send' : 'Save schedule';
    h += '</div><div class="lw-rp-dlg-f"><button class="btn press" data-a="rpclose">Cancel</button><button class="btn press' + (ok ? ' on' : '') + '" data-a="rpsubmit" style="color:var(--ink)"' +
      (ok && !R.busy ? '' : ' disabled') + '>' + label + '</button></div></div>';
    return h;
  }

  function html() {
    loadOptions();
    if (R.tab !== 'build' || !R.saved) loadLists();
    var h = '<div class="view" data-k="rp:' + R.tab + (R.preview ? ':p' : '') + '" style="margin-top:12px">' + tabs() + msgBar();
    if (R.optsErr) return h + '<div class="lw-err" role="alert" style="margin-top:14px">' + esc(R.optsErr) + '</div></div>';
    if (!R.opts) return h + '<div style="margin-top:14px">' + window.PortalLoader.full('reports') + '</div></div>';
    if (R.tab === 'build') { if (R.preview && canPreview()) { loadPreview(); h += previewHtml(); } else h += buildHtml(); }
    else if (R.tab === 'saved') h += savedHtml();
    else h += schedHtml();
    return h + dialogHtml() + '</div>';
  }

  function init(helpers) { X = helpers; }

  window.PortalReports = { init: init, html: html, act: act, input: input, escape: escape, clickOutside: clickOutside, _state: R };
})();
