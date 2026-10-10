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
    return keys.map(function (k) {
      var f = fieldOf(view.dataset_key, k);
      var cfg = (view.config.fields || []).filter(function (x) { return x.key === k; })[0];
      return f ? { key: k, label: (cfg && cfg.label) || f.label, type: f.type, field: f, missing: false }
               : { key: k, label: 'Field missing: ' + k, type: 'text', field: null, missing: true };
    });
  }

  function spreadsheet(view, data) {
    var c = cols(view);
    var h = ['<div class="rp-scroll"><table class="rp-tbl"><thead><tr>' +
      c.map(function (x) {
        return '<th class="' + (x.type === 'currency' || x.type === 'number' || x.type === 'percent' || x.type === 'ratio' ? 'r' : '') + '">' +
          (x.missing ? '<span class="sv-miss">' + escS(x.label) + '</span>' : escS(x.label)) + '</th>';
      }).join('') + '</tr></thead><tbody>'];
    (data.rows || []).forEach(function (row) {
      h.push('<tr>' + c.map(function (x) {
        var v = row[x.key];
        var right = x.type === 'currency' || x.type === 'number' || x.type === 'percent' || x.type === 'ratio';
        return '<td class="' + (right ? 'r' : '') + negClass(v, x.type) + '">' +
          (x.missing ? DASH : fmt(v, x.type, x.field)) + '</td>';
      }).join('') + '</tr>');
    });
    h.push('</tbody></table></div>');
    return h.join('');
  }

  function listView(view, data) {
    var c = cols(view);
    if (!c.length) return '<div class="rp-empty">This view has no fields.</div>';
    var title = c[0], rest = c.slice(1, 7);
    return (data.rows || []).map(function (row) {
      return '<div class="sv-list-row"><h5>' + (title.missing ? DASH : fmt(row[title.key], title.type, title.field)) + '</h5>' +
        '<div class="sv-list-sec">' + rest.map(function (x) {
          return '<span><span class="rp-dim">' + escS(x.label) + '</span> ' +
            '<b class="' + negClass(row[x.key], x.type).trim() + '">' +
            (x.missing ? DASH : fmt(row[x.key], x.type, x.field)) + '</b></span>';
        }).join('') + '</div></div>';
    }).join('') || '<div class="rp-empty">No rows match this view.</div>';
  }

  function report(view, data) {
    var c = cols(view);
    var groupKey = (view.config.group_by || [])[0] || null;
    var h = ['<div class="rp-scroll"><table class="rp-tbl"><thead><tr>' +
      c.map(function (x) { return '<th>' + escS(x.label) + '</th>'; }).join('') + '</tr></thead>'];
    var rows = data.rows || [];
    if (!groupKey) {
      h.push('<tbody>' + rows.map(function (row) {
        return '<tr>' + c.map(function (x) { return '<td>' + (x.missing ? DASH : fmt(row[x.key], x.type, x.field)) + '</td>'; }).join('') + '</tr>';
      }).join('') + '</tbody>');
    } else {
      var groups = {};
      rows.forEach(function (r) { (groups[r[groupKey]] = groups[r[groupKey]] || []).push(r); });
      Object.keys(groups).sort().forEach(function (g) {
        h.push('<tbody><tr class="rp-grph"><td colspan="' + c.length + '"><b>' + escS(g === 'null' ? DASH : g) + '</b></td></tr>');
        groups[g].forEach(function (row) {
          h.push('<tr>' + c.map(function (x) {
            var right = x.type === 'currency' || x.type === 'number';
            return '<td class="' + (right ? 'r' : '') + '">' + (x.missing ? DASH : fmt(row[x.key], x.type, x.field)) + '</td>';
          }).join('') + '</tr>');
        });
        /* subtotal every numeric column */
        h.push('<tr class="rp-strong">' + c.map(function (x, i) {
          if (i === 0) return '<td>Subtotal</td>';
          if (x.type !== 'currency' && x.type !== 'number') return '<td></td>';
          var vals = groups[g].map(function (r) { return r[x.key]; }).filter(isNum).map(Number);
          return '<td class="r">' + (vals.length ? fmt(vals.reduce(function (a, b) { return a + b; }, 0), x.type, x.field) : DASH) + '</td>';
        }).join('') + '</tr></tbody>');
      });
      h.push('<tfoot><tr>' + c.map(function (x, i) {
        if (i === 0) return '<td><b>Grand total</b></td>';
        if (x.type !== 'currency' && x.type !== 'number') return '<td></td>';
        var vals = rows.map(function (r) { return r[x.key]; }).filter(isNum).map(Number);
        return '<td class="r">' + (vals.length ? fmt(vals.reduce(function (a, b) { return a + b; }, 0), x.type, x.field) : DASH) + '</td>';
      }).join('') + '</tr></tfoot>');
    }
    h.push('</table></div>');
    return h.join('');
  }

  function dashboard(view, data) {
    var layout = view.config.layout || [];
    if (!layout.length) return '<div class="rp-empty">This dashboard has no tiles yet.</div>';
    var rows = data.rows || [];
    var h = ['<div class="sv-tiles">'];
    layout.filter(function (t) { return t.type === 'number'; }).forEach(function (t) {
      var key = (t.fields || [])[0];
      var f = fieldOf(view.dataset_key, key);
      var vals = rows.map(function (r) { return r[key]; }).filter(isNum).map(Number);
      var v = null;
      if (t.aggregate === 'count') v = rows.length;
      else if (vals.length) {
        if (t.aggregate === 'sum') v = vals.reduce(function (a, b) { return a + b; }, 0);
        else if (t.aggregate === 'avg') v = vals.reduce(function (a, b) { return a + b; }, 0) / vals.length;
        else if (t.aggregate === 'min') v = Math.min.apply(null, vals);
        else if (t.aggregate === 'max') v = Math.max.apply(null, vals);
      }
      var type = t.aggregate === 'count' ? 'number' : (f ? f.type : 'number');
      h.push('<div class="sv-tile"><div class="k">' + escS(t.title || (f ? f.label : key)) + '</div>' +
        '<div class="v' + negClass(v, type) + '">' + (v === null ? DASH : fmt(v, type, f)) + '</div>' +
        (f ? '' : '<div class="sv-miss">Field missing: ' + escS(key) + '</div>') + '</div>');
    });
    h.push('</div>');
    layout.filter(function (t) { return t.type === 'table'; }).forEach(function (t) {
      var keys = t.fields || [];
      h.push('<h4 class="rp-h4">' + escS(t.title || 'Table') + '</h4>');
      h.push('<div class="rp-scroll"><table class="rp-tbl"><thead><tr>' +
        keys.map(function (k) { var f = fieldOf(view.dataset_key, k); return '<th>' + escS(f ? f.label : 'Field missing: ' + k) + '</th>'; }).join('') +
        '</tr></thead><tbody>' +
        rows.slice(0, 12).map(function (r) {
          return '<tr>' + keys.map(function (k) {
            var f = fieldOf(view.dataset_key, k);
            var right = f && (f.type === 'currency' || f.type === 'number' || f.type === 'ratio' || f.type === 'percent');
            return '<td class="' + (right ? 'r' : '') + '">' + (f ? fmt(r[k], f.type, f) : DASH) + '</td>';
          }).join('') + '</tr>';
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

    if (pending) {
      h.push('<div class="rp-empty">Loading…</div>');
    } else {
      switch (v.display_type) {
        case 'dashboard':   h.push(dashboard(v, d)); break;
        case 'list':        h.push(listView(v, d)); break;
        case 'report':      h.push(report(v, d)); break;
        default:            h.push(spreadsheet(v, d));
      }
    }

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
  var STEPS = ['Dataset', 'Display', 'Fields', 'Filters', 'Sort & group', 'Preview', 'Save', 'Share'];

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
      h.push('<p class="rp-note">Which fields appear, and in what order. Clicking toggles.</p><div class="sv-pick">');
      (d ? d.fields : []).forEach(function (f) {
        var on = (dr.config.fields || []).some(function (x) { return x.key === f.key; });
        h.push('<label class="sv-chk' + (on ? ' on' : '') + '" data-f="' + escS(f.key) + '">' + escS(f.label) +
          '<span class="rp-dim"> ' + escS(f.type) + '</span></label>');
      });
      h.push('</div>');
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
        (d ? d.fields : []).map(function (x) {
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
      h.push('<div id="svPreview">' + (S.data ? previewHtml() : '<div class="rp-empty">Loading preview…</div>') + '</div>');
    } else if (S.step === 7) {
      h.push('<div class="sv-fieldrow"><span class="rp-lbl">Name</span>' +
        '<input class="rp-inp" id="svName" style="min-width:320px" value="' + escS(dr.name || '') + '"></div>' +
        '<div class="sv-fieldrow"><span class="rp-lbl">Description</span>' +
        '<input class="rp-inp" id="svDesc" style="min-width:420px" value="' + escS(dr.description || '') + '"></div>' +
        '<button class="rp-btn" id="svSave">Save view</button>');
    } else if (S.step === 8) {
      h.push(sharesHtml());
    }
    h.push('</div>');

    h.push('<div class="rp-bar">' +
      (S.step > 1 ? '<button class="rp-btn" id="svPrevStep">Back</button>' : '') +
      (S.step < STEPS.length ? '<button class="rp-btn" id="svNextStep">Next</button>' : '') + '</div>');
    return h.join('');
  }

  function previewHtml() {
    var v = { name: S.draft.name, display_type: S.draft.display_type, dataset_key: S.draft.dataset_key, config: S.draft.config };
    var d = S.data || { rows: [] };
    switch (v.display_type) {
      case 'dashboard': return dashboard(v, d);
      case 'list':      return listView(v, d);
      case 'report':    return report(v, d);
      default:          return spreadsheet(v, d);
    }
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
      S.draft = { dataset_key: 'property_summary', display_type: 'spreadsheet', name: '', description: '', config: { fields: [], filters: [], sort: [] } };
      S.step = 1; S.mode = 'builder'; S.data = null; paint();
    });
    on('#svBack', function () { S.mode = 'list'; S.view = null; S.data = null; S.draft = null; load(); });
    on('#svEdit', function () {
      S.draft = { id: S.view.id, dataset_key: S.view.dataset_key, display_type: S.view.display_type,
                  name: S.view.name, description: S.view.description, config: S.view.config || {} };
      S.step = 3; S.mode = 'builder'; S.data = null; paint();
    });
    on('#svShare', function () {
      S.draft = { id: S.view.id, dataset_key: S.view.dataset_key, display_type: S.view.display_type,
                  name: S.view.name, description: S.view.description, config: S.view.config || {} };
      S.step = 8; S.mode = 'builder';
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
      b.onclick = function () { S.draft.dataset_key = b.getAttribute('data-ds'); S.draft.config = { fields: [], filters: [], sort: [] }; paint(); };
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
    on('#svSaveShares', function () {
      api('/api/views/' + S.draft.id + '/shares', { method: 'PUT', body: JSON.stringify({ shares: S.shares.shares || [] }) })
        .then(function () { S.mode = 'list'; load(); })
        .catch(function (e) { S.error = e.message; paint(); });
    });
  }

  function gotoStep(n) {
    if (n < 1 || n > STEPS.length) return;
    S.step = n;
    if (n === 6) { S.data = null; paint(); previewLoad(); return; }
    if (n === 8 && S.draft.id && !S.shares) {
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
             '&config=' + encodeURIComponent(JSON.stringify(d.config)) + '&per_page=50';
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
    p.then(function (b) { S.draft.id = b.view.id; S.step = 8; S.shares = null; gotoStep(8); })
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
