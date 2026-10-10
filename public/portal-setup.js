/* ===========================================================================
   portal-setup.js — adding records from Properties (spec section H).

   + Entity, + Property (a guided form) and + Building, for owners and admins
   only, plus the H3 setup checklist every reader sees on a property's
   Overview. The server (portfolio-setup-api.js) decides who is an admin on
   every request; the buttons here are hidden from everyone else only so
   nobody is offered a control that will refuse them.

   The dialog lives on document.body, not inside the Properties host, because
   the host is repainted wholesale on every load and a half-typed form must
   survive that. Typing never repaints the form either: only choices that
   change its SHAPE (owner new or existing, fee on or off, loan on or off)
   redraw it, and they carry every typed value across.

   Exposes window.PortalSetup.
   =========================================================================== */
(function () {
  'use strict';

  function escS(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function headers() {
    return window.PortalSession.client()
      .then(function (c) { return c.auth.getSession(); })
      .then(function (r) {
        var t = r && r.data && r.data.session && r.data.session.access_token;
        if (!t) throw new Error('Your session has expired. Sign in again.');
        return { Authorization: 'Bearer ' + t, Accept: 'application/json', 'Content-Type': 'application/json' };
      });
  }
  function call(path, body) {
    return headers().then(function (h) {
      return fetch(path, { method: body ? 'POST' : 'GET', headers: h, cache: 'no-store', body: body ? JSON.stringify(body) : undefined })
        .then(function (r) {
          return r.json().then(function (b) {
            if (!r.ok) { var e = new Error((b && b.error) || ('HTTP ' + r.status)); e.field = b && b.field; throw e; }
            return b;
          }, function () { throw new Error('HTTP ' + r.status); });
        });
    });
  }

  var opts = null, optsP = null;
  function load() {
    if (opts) return Promise.resolve(opts);
    if (!optsP) {
      optsP = call('/api/portfolio-setup/options')
        .then(function (b) { opts = b; return b; })
        .catch(function () { opts = { isAdmin: false }; return opts; });
    }
    return optsP;
  }
  function isAdmin() { return !!(opts && opts.isAdmin); }

  var LABEL = {
    property: 'Owns a property', manager: 'Managing entity', holding: 'Holding company',
    deal: 'Deal / offering', operating_business: 'Operating business',
    buildium: 'Buildium', appfolio: 'AppFolio', other: 'Other',
    residential: 'Residential', garage: 'Garage', shed: 'Shed', storage: 'Storage', carport: 'Carport',
    office: 'Office', amenity: 'Amenity', laundry: 'Laundry', land: 'Land',
    primary_mortgage: 'Primary mortgage', construction_note: 'Construction note',
    primary_plus_construction_note: 'Primary plus construction', seller_carry: 'Seller carry',
    pace_equity: 'PACE equity', bridge: 'Bridge', pac_due: 'PAC due',
  };
  var lbl = function (k) { return LABEL[k] || k; };

  /* ---- form state ---- */
  var F = null;   // { kind, ctx, v: values, err: {field: msg}, error, busy, onDone, returnFocus }

  function val(k) { var v = F.v[k]; return v === undefined || v === null ? '' : v; }
  function errFor(k) { return F.err[k] ? '<div class="rp-ferr" id="err-' + escS(k.replace(/\./g, '-')) + '">' + escS(F.err[k]) + '</div>' : ''; }
  function described(k) { return F.err[k] ? ' aria-invalid="true" aria-describedby="err-' + escS(k.replace(/\./g, '-')) + '"' : ''; }

  function input(k, label, o) {
    o = o || {};
    return '<label class="rp-field' + (o.wide ? ' wide' : '') + '"><span>' + escS(label) + (o.req ? ' <i aria-hidden="true">*</i>' : '') + '</span>' +
      '<input class="rp-inp" data-v="' + escS(k) + '" value="' + escS(val(k)) + '"' +
      (o.type ? ' type="' + o.type + '"' : '') + (o.mode ? ' inputmode="' + o.mode + '"' : '') +
      (o.list ? ' list="' + o.list + '"' : '') + (o.ph ? ' placeholder="' + escS(o.ph) + '"' : '') +
      (o.req ? ' required' : '') + ' autocomplete="off"' + described(k) + '>' +
      (o.hint ? '<small>' + escS(o.hint) + '</small>' : '') + errFor(k) + '</label>';
  }
  function select(k, label, list, o) {
    o = o || {};
    return '<label class="rp-field' + (o.wide ? ' wide' : '') + '"><span>' + escS(label) + (o.req ? ' <i aria-hidden="true">*</i>' : '') + '</span>' +
      '<select class="rp-inp" data-v="' + escS(k) + '"' + (o.shape ? ' data-shape="1"' : '') + described(k) + '>' +
      (o.none !== undefined ? '<option value="">' + escS(o.none) + '</option>' : '') +
      list.map(function (x) {
        var id = typeof x === 'string' ? x : x.id, name = typeof x === 'string' ? lbl(x) : x.name;
        return '<option value="' + escS(id) + '"' + (String(val(k)) === String(id) ? ' selected' : '') + '>' + escS(name) + '</option>';
      }).join('') + '</select>' + (o.hint ? '<small>' + escS(o.hint) + '</small>' : '') + errFor(k) + '</label>';
  }
  function toggle(k, label) {
    return '<label class="rp-toggle"><input type="checkbox" data-v="' + escS(k) + '" data-shape="1"' + (F.v[k] ? ' checked' : '') + '> ' + escS(label) + '</label>';
  }
  function radios(k, list) {
    return '<div class="rp-radios" role="radiogroup">' + list.map(function (x) {
      return '<label><input type="radio" name="' + escS(k) + '" value="' + escS(x[0]) + '" data-v="' + escS(k) + '" data-shape="1"' +
        (String(val(k)) === x[0] ? ' checked' : '') + '> ' + escS(x[1]) + '</label>';
    }).join('') + '</div>';
  }
  function section(n, title, body, note) {
    return '<section class="rp-fsec"><h4><span class="rp-fnum">' + n + '</span>' + escS(title) + '</h4>' +
      (note ? '<p class="rp-fnote">' + note + '</p>' : '') + '<div class="rp-fgrid">' + body + '</div></section>';
  }

  function entityForm() {
    return section(1, 'The entity',
      input('name', 'Legal name', { req: true, wide: true, ph: 'e.g. Maple Court Partners LLC' }) +
      select('entity_type', 'Type', opts.entityTypes, { none: 'Not set' }) +
      select('parent_entity_id', 'Parent entity', opts.entities, { none: 'None' }) +
      select('manager_entity_id', 'Managing entity', opts.managers, { none: 'None',
        hint: 'The entity that runs it. Properties group under this on the Entities tab.' }));
  }

  function propertyForm() {
    var h = [];
    h.push('<datalist id="rpAssetTypes">' + (opts.assetTypes || []).map(function (a) { return '<option value="' + escS(a) + '">'; }).join('') + '</datalist>');
    h.push('<datalist id="rpGroups">' + (opts.managerGroups || []).map(function (a) { return '<option value="' + escS(a) + '">'; }).join('') + '</datalist>');
    h.push(section(1, 'The property',
      input('name', 'Property name', { req: true, wide: true, ph: 'As the portfolio calls it' }) +
      input('street', 'Street', { wide: true }) + input('city', 'City') + input('state', 'State') + input('zip', 'ZIP') +
      input('asset_type', 'Asset type', { list: 'rpAssetTypes' }) + input('year_built', 'Year built', { mode: 'numeric' }) +
      input('units', 'Apartments', { mode: 'numeric', hint: 'Saved as a verified count, in your name.' }) +
      input('management_company', 'Property manager') +
      input('purchase_price', 'Purchase price', { mode: 'decimal', ph: '$' }) + input('purchase_date', 'Purchase date', { type: 'date' })));

    var own = val('owner_mode') || 'existing';
    h.push(section(2, 'Owner LLC',
      '<div class="wide">' + radios('owner_mode', [['existing', 'An entity already on file'], ['new', 'A new LLC']]) + '</div>' +
      (own === 'new'
        ? input('new_owner.name', 'New LLC name', { req: true, wide: true }) +
          select('new_owner.manager_entity_id', 'Managing entity', opts.managers, { none: 'None on file', wide: true })
        : select('owner_entity_id', 'Owner LLC', opts.entities, { req: true, none: 'Choose…', wide: true }))));

    h.push(section(3, 'Report source',
      select('source_system', 'Comes from', opts.sources, { none: 'Not set yet' }) +
      input('source_label', 'Its exact name there', { wide: true, ph: 'Copied from the report heading' }),
      'T12s and rent rolls are matched to this property by that name, so copy it exactly, punctuation included.'));

    h.push(section(4, 'Dropbox',
      input('dropbox_url', 'Folder link', { wide: true, ph: 'https://www.dropbox.com/…' }),
      'The property folder\'s share link. The document sync picks up a new folder separately.'));

    h.push(section(5, 'Asset management fee',
      '<div class="wide">' + toggle('fee.enabled', 'This property pays an asset management fee') + '</div>' +
      (F.v['fee.enabled']
        ? input('fee.manager_group', 'Manager group', { req: true, list: 'rpGroups' }) +
          '<div class="rp-field"><span>Charged as</span>' + radios('fee.fee_type', [['pct_gross', '% of gross'], ['fixed', 'Fixed a month']]) + '</div>' +
          (val('fee.fee_type') === 'fixed'
            ? input('fee.fixed_amount', 'Amount a month', { req: true, mode: 'decimal', ph: '$' })
            : input('fee.fee_pct', 'Percent of gross', { req: true, mode: 'decimal', ph: 'e.g. 3' })) +
          '<div class="rp-field"><span>Paid</span>' + radios('fee.payment_timing', [['same_month', 'The same month'], ['following_month', 'The following month']]) + '</div>' +
          input('fee.effective_from', 'Starting', { type: 'date', hint: 'Blank means the first of this month.' })
        : '')));

    h.push(section(6, 'Loan',
      '<div class="wide">' + toggle('loan.enabled', 'Add the loan on this property') + '</div>' +
      (F.v['loan.enabled']
        ? input('loan.lender', 'Lender', { req: true }) + input('loan.loan_number', 'Loan number') +
          input('loan.origination_amount', 'Original amount', { req: true, mode: 'decimal', ph: '$' }) +
          input('loan.interest_rate_pct', 'Interest rate %', { mode: 'decimal', ph: 'e.g. 6.5' }) +
          input('loan.origination_date', 'Originated', { type: 'date' }) + input('loan.maturity_date', 'Matures', { type: 'date' }) +
          select('loan.purpose', 'Purpose', opts.loanPurposes, { none: 'Not set' })
        : ''),
      F.v['loan.enabled'] ? 'Borrowed by the owner LLC and secured on this property.' : ''));
    return h.join('');
  }

  function buildingForm() {
    return section(1, 'The building',
      input('name', 'Name', { req: true, ph: 'e.g. Building 6' }) +
      input('units', 'Apartments', { req: true, mode: 'numeric', hint: '0 is right for a garage or shed.' }) +
      select('building_type', 'Kind', opts.buildingTypes, { none: 'Not set' }) +
      '<div class="wide rp-fsub">Address <small>Leave blank for a building that shares the property\'s address, as outbuildings do.</small></div>' +
      input('street', 'Street', { wide: true }) + input('city', 'City') + input('state', 'State') + input('zip', 'ZIP'));
  }

  var TITLES = { entity: 'Add an entity', property: 'Add a property', building: 'Add a building' };
  var SAVE = { entity: 'Add entity', property: 'Add property', building: 'Add building' };

  function render() {
    var root = document.getElementById('rpSetupRoot');
    if (!root) {
      root = document.createElement('div');
      root.id = 'rpSetupRoot';
      document.body.appendChild(root);
    }
    var body = F.kind === 'entity' ? entityForm() : F.kind === 'building' ? buildingForm() : propertyForm();
    root.innerHTML =
      '<div class="rp-overlay" data-close="1"></div>' +
      '<div class="rp-dialog" role="dialog" aria-modal="true" aria-labelledby="rpSetupTitle">' +
        '<header><div><h3 id="rpSetupTitle">' + escS(TITLES[F.kind]) + '</h3>' +
          (F.ctx && F.ctx.propertyName ? '<div class="rp-dim">' + escS(F.ctx.propertyName) + '</div>' : '') + '</div>' +
          '<button class="rp-btn rp-x" data-close="1" aria-label="Close">' + xIcon() + '</button></header>' +
        '<form class="rp-form" novalidate>' + body + '</form>' +
        '<footer>' + (F.error ? '<div class="rp-ferr rp-ferr-top" role="alert">' + escS(F.error) + '</div>' : '<span class="rp-dim">Only adds; nothing already on file changes. Recorded under your name.</span>') +
          '<span class="rp-spacer"></span>' +
          '<button class="rp-btn" data-close="1">Cancel</button>' +
          '<button class="rp-btn rp-primary" id="rpSetupSave"' + (F.busy ? ' disabled' : '') + '>' + (F.busy ? 'Saving…' : escS(SAVE[F.kind])) + '</button>' +
        '</footer>' +
      '</div>';
    wire(root);
  }
  function xIcon() {
    return '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="m4.5 4.5 7 7m0-7-7 7"/></svg>';
  }

  function wire(root) {
    root.querySelectorAll('[data-close]').forEach(function (b) { b.onclick = function (e) { e.preventDefault(); close(); }; });
    root.querySelectorAll('[data-v]').forEach(function (el) {
      var k = el.getAttribute('data-v');
      var set = function () {
        if (el.type === 'checkbox') F.v[k] = el.checked;
        else if (el.type === 'radio') { if (el.checked) F.v[k] = el.value; }
        else F.v[k] = el.value;
        if (F.err[k]) { delete F.err[k]; el.removeAttribute('aria-invalid'); var m = el.parentNode.querySelector('.rp-ferr'); if (m) m.remove(); }
      };
      if (el.getAttribute('data-shape')) el.onchange = function () { set(); render(); refocus(k); };
      else el.oninput = el.onchange = set;
    });
    var f = root.querySelector('form');
    f.onsubmit = function (e) { e.preventDefault(); save(); };
    root.querySelector('#rpSetupSave').onclick = function (e) { e.preventDefault(); save(); };
  }
  function refocus(k) {
    var el = document.querySelector('#rpSetupRoot [data-v="' + k + '"]' + (F.v[k] && typeof F.v[k] === 'string' ? '[value="' + F.v[k] + '"]' : ''));
    if (el) el.focus();
  }

  /* dotted keys (fee.fee_pct) become nested objects for the server */
  function payload() {
    var out = {};
    Object.keys(F.v).forEach(function (k) {
      var parts = k.split('.'), o = out;
      for (var i = 0; i < parts.length - 1; i++) o = o[parts[i]] = o[parts[i]] || {};
      o[parts[parts.length - 1]] = F.v[k];
    });
    if (F.kind === 'property') {
      if (out.owner_mode === 'new') delete out.owner_entity_id; else delete out.new_owner;
      delete out.owner_mode;
    }
    return out;
  }

  function save() {
    if (F.busy) return;
    F.busy = true; F.error = null; render();
    var url = F.kind === 'entity' ? '/api/portfolio-setup/entity'
      : F.kind === 'building' ? '/api/portfolio-setup/property/' + encodeURIComponent(F.ctx.propertyId) + '/building'
      : '/api/portfolio-setup/property';
    call(url, payload()).then(function (b) {
      var done = F.onDone, kind = F.kind;
      opts = null; optsP = null;            // the new entity belongs in the pickers next time
      close();
      load();
      if (done) done(kind, b);
    }).catch(function (e) {
      F.busy = false;
      if (e.field) { F.err[e.field] = e.message; F.error = 'Check the highlighted field.'; }
      else F.error = e.message;
      render();
      var bad = e.field && document.querySelector('#rpSetupRoot [data-v="' + e.field + '"]');
      if (bad) bad.focus();
    });
  }

  var keysBound = false;
  function open(kind, ctx, onDone) {
    load().then(function () {
      if (!isAdmin()) return;
      F = { kind: kind, ctx: ctx || {}, v: {}, err: {}, error: null, busy: false, onDone: onDone,
            returnFocus: document.activeElement };
      if (kind === 'property') {
        F.v.owner_mode = 'existing';
        F.v['fee.fee_type'] = 'pct_gross';
        F.v['fee.payment_timing'] = 'following_month';
      }
      if (kind === 'building') F.v.building_type = 'residential';
      document.documentElement.classList.add('rp-modal-open');
      render();
      var first = document.querySelector('#rpSetupRoot .rp-inp');
      if (first) first.focus();
      if (!keysBound) {
        /* bound once: open() runs every time a form opens */
        document.addEventListener('keydown', function (e) {
          if (!F) return;
          if (e.key === 'Escape') { e.preventDefault(); close(); return; }
          if (e.key !== 'Tab') return;
          var f = document.querySelectorAll('#rpSetupRoot .rp-dialog input, #rpSetupRoot .rp-dialog select, #rpSetupRoot .rp-dialog button');
          if (!f.length) return;
          var a = f[0], z = f[f.length - 1];
          if (e.shiftKey && document.activeElement === a) { e.preventDefault(); z.focus(); }
          else if (!e.shiftKey && document.activeElement === z) { e.preventDefault(); a.focus(); }
        });
        keysBound = true;
      }
    });
  }
  function close() {
    var back = F && F.returnFocus;
    F = null;
    var root = document.getElementById('rpSetupRoot');
    if (root) root.innerHTML = '';
    document.documentElement.classList.remove('rp-modal-open');
    if (back && document.body.contains(back)) back.focus();
  }

  /* ---- H3: the setup checklist ---- */
  function checklistHtml(items) {
    if (!items || !items.length) return '';
    var done = items.filter(function (i) { return i.done; }).length;
    /* fully set up: one quiet line, details on hover, so a finished property
       does not spend a row of its Overview on four green ticks */
    if (done === items.length) {
      return '<p class="rp-setup-ok" title="' + escS(items.map(function (i) { return i.label + ': ' + i.detail; }).join('\n')) + '">' +
        '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m3.5 8.5 3 3 6-7"/></svg>' +
        '<span>Set up: ' + items.map(function (i) { return i.label.replace(/^(Sync|Fee|Loan)/, function (m) { return m.toLowerCase(); }); }).join(', ') + '.</span></p>';
    }
    var tick = '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m3.5 8.5 3 3 6-7"/></svg>';
    var open = '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><circle cx="8" cy="8" r="5.5"/></svg>';
    return '<section class="rp-setup" aria-label="Setup checklist">' +
      '<h4 class="rp-h4">Setup <span class="rp-dim">' + done + ' of ' + items.length + ' in place</span></h4>' +
      '<ul>' + items.map(function (i) {
        return '<li class="' + (i.done ? 'ok' : 'todo') + '"><span class="ic">' + (i.done ? tick : open) + '</span>' +
          '<div><b>' + escS(i.label) + '</b><span class="sr-only">' + (i.done ? ', done' : ', not done') + '</span>' +
          '<small>' + escS(i.detail || '') + '</small></div></li>';
      }).join('') + '</ul></section>';
  }

  window.PortalSetup = { load: load, isAdmin: isAdmin, open: open, close: close, checklistHtml: checklistHtml };
})();
