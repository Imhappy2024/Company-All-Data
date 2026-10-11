/* ===========================================================================
   portal-access.js — Users & Roles (Executive Board), on the Claude
   connector's access model.

   Per person, per company: a data level, in plain English, with the
   description the connector uses for it. "Every company" is a grant on scope
   'all'. The screens a level gives come from mcp.level_module (server side);
   here they can be narrowed (read only, hidden), never widened, and for the
   Custom level chosen one by one. Saving writes mcp.access_grant and friends
   through /api/people; the dashboard and Claude then follow the same rows.

   The connector token is never shown here: an invite or "Send new token"
   emails it to the person directly.
   =========================================================================== */
(function () {
  'use strict';

  var S = { host: null, data: null, loading: false, error: '', open: null, draft: null, mode: null, msg: '', busy: false, inv: null };

  function esc(s) {
    return String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function api(path, method, body) {
    return window.PortalSession.authHeaders(body ? { 'Content-Type': 'application/json' } : {}).then(function (h) {
      return fetch('/api/people' + path, { method: method || 'GET', headers: h, cache: 'no-store', body: body ? JSON.stringify(body) : undefined });
    }).then(function (r) {
      return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status)); return j; },
                           function () { throw new Error('HTTP ' + r.status); });
    });
  }

  function load(force) {
    if (S.loading || (S.data && !force)) return;
    S.loading = true; S.error = '';
    window.PortalLoader.hold(api('/')).then(function (d) { S.data = d; }, function (e) { S.error = e.message; })
      .then(function () { S.loading = false; paint(); });
  }

  /* ---- level helpers ----------------------------------------------------- */
  function D() { return S.data; }
  function levelByName(n) { return D().levels.find(function (l) { return l.name === n; }); }
  function label(n) { var l = levelByName(n); return l ? l.label : n; }
  function kindOf(scope) { return scope === 'all' ? 'all' : scope === 'leavenwealth' ? 'leavenwealth' : 'company'; }
  function levelsFor(scope) { var k = kindOf(scope); return D().levels.filter(function (l) { return l.scopes.indexOf(k) >= 0; }); }
  function companyName(key) { var c = D().companies.find(function (x) { return x.key === key; }); return c ? c.name : key; }
  function companyByKey(key) { return D().companies.find(function (x) { return x.key === key; }); }

  /* The screens one company (or the exec menu, scope 'all') gives from a set of
     grants, mirroring mcp.dashboard_modules(): {nav_id: canWrite} */
  function allowedScreens(grants, scope) {
    var out = {}, isExec = scope === 'all';
    var cid = isExec ? 'exec' : (companyByKey(scope) || {}).company_id;
    var navsHere = D().navs.filter(function (n) { return n.company_id === cid; }).map(function (n) { return n.nav_id; });
    grants.forEach(function (g) {
      if (isExec ? g.scope !== 'all' : (g.scope !== 'all' && g.scope !== scope)) return;
      var lv = g.level;
      if (!isExec && g.scope === 'all' && scope === 'leavenwealth') lv = lv === 'user' ? 'lw_user' : (lv === 'user_2' || lv === 'user_3') ? 'lw_user_ro' : lv;
      D().levelModules.forEach(function (m) {
        if (m.level !== lv || m.area !== (isExec ? 'exec' : 'company') || navsHere.indexOf(m.nav_id) < 0) return;
        if (isExec && m.nav_id === 'access' && g.level !== 'admin') return;
        out[m.nav_id] = !!(out[m.nav_id] || m.can_write);
      });
    });
    return out;
  }
  function navLabel(scope, nav) {
    var cid = scope === 'all' ? 'exec' : (companyByKey(scope) || {}).company_id;
    var n = D().navs.find(function (x) { return x.company_id === cid && x.nav_id === nav; });
    return n ? n.label : nav;
  }

  /* ---- render ------------------------------------------------------------ */
  function statusChip(p) {
    if (!p.user_id) return '<span class="pa-chip">No Claude account</span>';
    if (!p.active) return '<span class="pa-chip bad">Deactivated</span>';
    if (p.dashboard_access && !p.has_login) return '<span class="pa-chip ok">Invite sent</span>';
    return '<span class="pa-chip ok">Active</span>';
  }
  function dashRole(p) {
    if (!p.dashboard_access) return '<span class="pa-muted">No dashboard</span>';
    return { owner: 'Owner', admin: 'Admin', user: 'User' }[p.dashboard_role] || p.dashboard_role;
  }
  function grantCell(p, scope) {
    var g = (p.grants || []).find(function (x) { return x.scope === scope; });
    return g ? '<span class="pa-lv">' + esc(label(g.level)) + '</span>' : '<span class="pa-muted">–</span>';
  }

  function table() {
    var cos = D().companies;
    var h = '<div class="pa-scroll"><table class="pa-tbl"><thead><tr><th>Person</th><th>Status</th><th>Dashboard</th><th>Every company</th>' +
      cos.map(function (c) { return '<th>' + esc(c.name) + '</th>'; }).join('') + '<th>Last in Claude</th></tr></thead><tbody>';
    D().people.forEach(function (p, i) {
      var emails = (p.emails || []).map(function (e) { return e.email; });
      if (!emails.length && p.staff_email) emails = [p.staff_email];
      h += '<tr class="pa-row" data-i="' + i + '"><td><div class="pa-name">' + esc(p.full_name || '(no name)') + (p.owner ? ' <span class="pa-chip">Owner</span>' : '') +
        (p.principal ? ' <span class="pa-chip">Principal: ' + esc(p.principal) + '</span>' : '') + '</div>' +
        '<div class="pa-sub">' + esc(emails.join(', ')) + '</div></td>' +
        '<td>' + statusChip(p) + '</td><td>' + dashRole(p) + '</td><td>' + grantCell(p, 'all') + '</td>' +
        cos.map(function (c) { return '<td>' + grantCell(p, c.key) + '</td>'; }).join('') +
        '<td class="pa-muted">' + (p.last_seen_at ? esc(String(p.last_seen_at).slice(0, 10)) : '–') + '</td></tr>';
    });
    return h + '</tbody></table></div>';
  }

  function logTable(rows, title) {
    if (!rows.length) return '';
    return '<h3 class="pa-h3">' + esc(title) + '</h3><div class="pa-scroll"><table class="pa-tbl pa-log"><thead><tr><th>When</th><th>Changed by</th><th>Person</th><th>Company</th><th>What</th><th>Before</th><th>After</th></tr></thead><tbody>' +
      rows.map(function (r) {
        var sc = r.scope === 'all' ? 'Every company' : r.scope === '-' ? '' : companyName(r.scope);
        var lv = function (v) { return v === null || v === undefined ? '–' : r.what === 'level' ? label(v) : v; };
        return '<tr><td>' + esc(String(r.at).replace('T', ' ').slice(0, 16)) + '</td><td>' + esc(r.changed_by) + '</td><td>' + esc(r.person) + '</td><td>' + esc(sc) +
          '</td><td>' + esc(r.what) + '</td><td>' + esc(lv(r.old_value)) + '</td><td>' + esc(lv(r.new_value)) + '</td></tr>';
      }).join('') + '</tbody></table></div>';
  }

  function levelSelect(scope, current, attr) {
    return '<select class="pa-sel" ' + attr + '><option value="">No access</option>' + levelsFor(scope).map(function (l) {
      return '<option value="' + l.name + '"' + (current === l.name ? ' selected' : '') + '>' + esc(l.label) + '</option>';
    }).join('') + '</select>';
  }
  function levelBlock(scope, current, attrPrefix) {
    var l = current ? levelByName(current) : null;
    return '<div class="pa-field"><label>' + esc(scope === 'all' ? 'Every company' : companyName(scope)) + '</label>' +
      levelSelect(scope, current, 'data-in="' + attrPrefix + scope + '"') +
      '<div class="pa-desc">' + (l ? esc(l.description) : (scope === 'all' ? 'Grants on every company at once. "Admin" here is admin on every company.' : '')) + '</div></div>';
  }

  /* screens: narrowing for normal levels, choosing for Custom */
  function screensBlock(dr) {
    var scopes = ['all'].concat(D().companies.map(function (c) { return c.key; }));
    var h = '';
    scopes.forEach(function (scope) {
      var g = dr.grants[scope];
      if (scope === 'all' && !g) return;
      if (scope !== 'all' && !g && !dr.grants.all) return;
      if (g === 'custom' && scope !== 'all') {
        var cid = (companyByKey(scope) || {}).company_id;
        var navs = D().navs.filter(function (n) { return n.company_id === cid; });
        h += '<div class="pa-screens"><div class="pa-scr-h">' + esc(companyName(scope)) + ' <span class="pa-muted">Custom: choose each screen</span></div>' +
          navs.map(function (n) {
            var cur = dr.custom[scope + '|' + n.nav_id] || '';
            return '<label class="pa-scr"><span>' + esc(n.label) + '</span><select class="pa-sel sm" data-in="cm:' + scope + '|' + n.nav_id + '">' +
              '<option value=""' + (!cur ? ' selected' : '') + '>Hidden</option><option value="read"' + (cur === 'read' ? ' selected' : '') + '>Read only</option>' +
              '<option value="write"' + (cur === 'write' ? ' selected' : '') + '>Can edit</option></select></label>';
          }).join('') + '</div>';
        return;
      }
      var grants = Object.keys(dr.grants).map(function (k) { return { scope: k, level: dr.grants[k] }; });
      var allowed = allowedScreens(grants, scope), keys = Object.keys(allowed);
      if (!keys.length) return;
      var area = scope === 'all' ? 'exec' : 'company';
      h += '<div class="pa-screens"><div class="pa-scr-h">' + esc(scope === 'all' ? 'Executive Board' : companyName(scope)) + '</div>' +
        keys.map(function (nav) {
          var r = dr.restrict[scope + '|' + area + '|' + nav] || '';
          var w = allowed[nav];
          return '<label class="pa-scr"><span>' + esc(navLabel(scope, nav)) + '</span><select class="pa-sel sm" data-in="rs:' + scope + '|' + area + '|' + nav + '">' +
            (w ? '<option value=""' + (!r ? ' selected' : '') + '>Can edit</option>' : '') +
            '<option value="' + (w ? 'read' : '') + '"' + ((w ? r === 'read' : !r) ? ' selected' : '') + '>Read only</option>' +
            '<option value="none"' + (r === 'none' ? ' selected' : '') + '>Hidden</option></select></label>';
        }).join('') + '</div>';
    });
    return h ? '<h3 class="pa-h3">Screens</h3><p class="pa-desc">What the level gives, narrowed per person. A level never gives more here than its data allows in Claude.</p>' + h : '';
  }

  function draftFrom(p) {
    var d = { grants: {}, restrict: {}, custom: {}, principal: p.principal || '', owner: !!p.owner, email: '' };
    (p.grants || []).forEach(function (g) { d.grants[g.scope] = g.level; });
    (p.restrictions || []).forEach(function (r) { d.restrict[r.scope + '|' + r.area + '|' + r.nav_id] = r.max; });
    (p.custom_modules || []).forEach(function (m) { d.custom[m.scope + '|' + m.nav_id] = m.can_write ? 'write' : 'read'; });
    return d;
  }

  function drawer() {
    if (S.mode === 'invite') return inviteDrawer();
    var p = S.open, dr = S.draft, me = S.me || {};
    if (!p) return '';
    var h = '<aside class="pa-drawer" role="dialog" aria-label="' + esc(p.full_name) + '"><div class="pa-dh"><div><div class="pa-dt">' + esc(p.full_name) + '</div>' +
      '<div class="pa-sub">' + statusChip(p) + ' ' + dashRole(p) + '</div></div><button class="pa-x" data-a="close" aria-label="Close">×</button></div>';
    if (!p.user_id) {
      h += '<p class="pa-desc">' + esc(p.full_name) + ' has no Claude connector account, so no access in either place. Invite them to create one.</p>' +
        '<button class="pa-btn on" data-a="inviteFrom">Invite ' + esc((p.full_name || '').split(' ')[0]) + '</button></aside>';
      return h;
    }
    h += '<h3 class="pa-h3">Email addresses</h3><div class="pa-emails">' + (p.emails || []).map(function (e) {
      return '<div class="pa-email"><span>' + esc(e.email) + '</span>' + (e.primary ? '<span class="pa-muted">sign-in</span>' : '<button class="pa-link" data-a="rmEmail:' + esc(e.email) + '">Remove</button>') + '</div>';
    }).join('') + '<div class="pa-email"><input class="pa-sel" placeholder="Add another address for this person" data-in="email" value="' + esc(dr.email) + '"><button class="pa-btn" data-a="addEmail">Add</button></div></div>';

    h += '<h3 class="pa-h3">Data level</h3><p class="pa-desc">The same level applies in the dashboard and in Claude.</p>' +
      levelBlock('all', dr.grants.all, 'g:') + D().companies.map(function (c) { return levelBlock(c.key, dr.grants[c.key], 'g:'); }).join('');
    var needsP = Object.keys(dr.grants).some(function (k) { return dr.grants[k] === 'principal'; }) || dr.principal;
    if (needsP) {
      h += '<div class="pa-field"><label>Principal</label><select class="pa-sel" data-in="principal"><option value="">Not a principal</option>' +
        D().principals.map(function (x) { return '<option value="' + esc(x.key) + '"' + (dr.principal === x.key ? ' selected' : '') + '>' + esc(x.name) + '</option>'; }).join('') +
        '</select><div class="pa-desc">Required for the Principal level: whose personal data counts as their own.</div></div>';
    }
    if (me.role === 'owner') {
      h += '<label class="pa-check"><input type="checkbox" data-in="owner"' + (dr.owner ? ' checked' : '') + '> Owner of the dashboard</label>';
    }
    if (p.custom_tables) h += '<p class="pa-desc">' + p.custom_tables + ' custom table choices are kept as they are (set with the connector\'s admin tools).</p>';
    h += screensBlock(dr);
    h += '<div class="pa-actions"><button class="pa-btn on" data-a="save"' + (S.busy ? ' disabled' : '') + '>' + (S.busy ? 'Saving…' : 'Save') + '</button>' +
      (p.active ? '<button class="pa-btn" data-a="sendToken">Email a new connector token</button><button class="pa-btn bad" data-a="deactivate">Deactivate</button>'
                : '<button class="pa-btn" data-a="reactivate">Reactivate</button>') + '</div>';
    if (S.msg) h += '<div class="pa-msg" role="status">' + esc(S.msg) + '</div>';
    var mine = D().log.filter(function (r) { return r.person === p.full_name; }).slice(0, 12);
    h += logTable(mine, 'Recent changes for ' + p.full_name);
    return h + '</aside>';
  }

  function inviteDrawer() {
    var v = S.inv, cfg = D().configured || {};
    var h = '<aside class="pa-drawer" role="dialog" aria-label="Invite a person"><div class="pa-dh"><div class="pa-dt">Invite a person</div><button class="pa-x" data-a="close" aria-label="Close">×</button></div>' +
      '<p class="pa-desc">Creates their Claude connector account and dashboard sign-in together, with the same access in both. They get two emails: a link to set their dashboard password, and their Claude connector setup steps with a personal token. The token is never shown here.</p>';
    if (!cfg.roleSecret) h += '<div class="pa-msg bad">Invites are switched off until MCP_ROLE_SECRET is set on this deployment (same value as on lw-data-mcp).</div>';
    if (!cfg.tokenEmail) h += '<div class="pa-msg bad">The connector email is not configured (CONNECTOR_INVITE_URL / CONNECTOR_INVITE_SECRET).</div>';
    h += '<div class="pa-grid2"><div class="pa-field"><label>First name</label><input class="pa-sel" data-in="i:first_name" value="' + esc(v.first_name) + '"></div>' +
      '<div class="pa-field"><label>Last name</label><input class="pa-sel" data-in="i:last_name" value="' + esc(v.last_name) + '"></div></div>' +
      '<div class="pa-field"><label>Work email</label><input class="pa-sel" type="email" data-in="i:email" value="' + esc(v.email) + '"></div>' +
      '<h3 class="pa-h3">Data level</h3>' + levelBlock('all', v.grants.all, 'ig:') + D().companies.map(function (c) { return levelBlock(c.key, v.grants[c.key], 'ig:'); }).join('');
    if (Object.keys(v.grants).some(function (k) { return v.grants[k] === 'principal'; })) {
      h += '<div class="pa-field"><label>Principal</label><select class="pa-sel" data-in="i:principal"><option value="">Choose</option>' +
        D().principals.map(function (x) { return '<option value="' + esc(x.key) + '"' + (v.principal === x.key ? ' selected' : '') + '>' + esc(x.name) + '</option>'; }).join('') + '</select></div>';
    }
    h += '<div class="pa-actions"><button class="pa-btn on" data-a="sendInvite"' + (S.busy || !cfg.roleSecret ? ' disabled' : '') + '>' + (S.busy ? 'Inviting…' : 'Send invite') + '</button></div>';
    if (S.msg) h += '<div class="pa-msg" role="status">' + esc(S.msg) + '</div>';
    return h + '</aside>';
  }

  function paint() {
    if (!S.host || !document.body.contains(S.host)) return;
    var html;
    if (S.error && !S.data) html = '<div class="pa-msg bad">' + esc(S.error) + '</div>';
    else if (!S.data) html = window.PortalLoader.full('people');
    else {
      html = '<div class="pa"><p class="pa-desc pa-top">One set of access for the dashboard and for Claude: each person\'s level per company decides what they can see and change in both. Changes apply immediately and are logged.</p>' +
        table() + logTable(D().log.slice(0, 25), 'Recent access changes') + '</div>' + drawer();
    }
    if (window.PortalMorph) window.PortalMorph.morph(S.host, html); else S.host.innerHTML = html;
  }

  /* ---- actions ----------------------------------------------------------- */
  function payload(dr) {
    var grants = Object.keys(dr.grants).filter(function (k) { return dr.grants[k]; }).map(function (k) { return { scope: k, level: dr.grants[k] }; });
    var restrictions = Object.keys(dr.restrict).filter(function (k) { return dr.restrict[k]; }).map(function (k) {
      var p = k.split('|'); return { scope: p[0], area: p[1], nav_id: p[2], max: dr.restrict[k] };
    });
    var customModules = Object.keys(dr.custom).filter(function (k) { return dr.custom[k]; }).map(function (k) {
      var p = k.split('|'); return { scope: p[0], nav_id: p[1], can_write: dr.custom[k] === 'write' };
    });
    return { grants: grants, restrictions: restrictions, customModules: customModules, principal: dr.principal || null, owner: dr.owner };
  }
  function after(promise, okMsg) {
    S.busy = true; S.msg = ''; paint();
    return promise.then(function (r) {
      S.msg = typeof okMsg === 'function' ? okMsg(r) : okMsg;
      return api('/').then(function (d) {
        S.data = d;
        if (S.open) { S.open = d.people.find(function (x) { return x.user_id === S.open.user_id && x.staff_id === S.open.staff_id; }) || S.open; S.draft = Object.assign(draftFrom(S.open), { email: '' }); }
      });
    }, function (e) { S.msg = 'Not saved: ' + e.message; })
      .then(function () { S.busy = false; paint(); });
  }

  function onClick(ev) {
    var row = ev.target.closest('.pa-row');
    if (row && S.host.contains(row)) { var p = D().people[+row.getAttribute('data-i')]; S.mode = 'edit'; S.open = p; S.draft = draftFrom(p); S.msg = ''; paint(); return; }
    var el = ev.target.closest('[data-a]'); if (!el || !S.host.contains(el)) return;
    var a = el.getAttribute('data-a'), p2 = S.open;
    if (a === 'close') { S.open = null; S.mode = null; S.msg = ''; paint(); return; }
    if (a === 'inviteFrom') { var n = (p2.full_name || '').split(' '); openInvite({ first_name: n[0] || '', last_name: n.slice(1).join(' '), email: p2.staff_email || '' }); return; }
    if (a === 'save') { after(api('/' + p2.user_id, 'PUT', payload(S.draft)), 'Saved. The dashboard and Claude now use these levels.'); return; }
    if (a === 'addEmail') { after(api('/' + p2.user_id + '/emails', 'POST', { email: S.draft.email }), 'Address added.'); return; }
    if (a.indexOf('rmEmail:') === 0) { after(api('/' + p2.user_id + '/emails/' + encodeURIComponent(a.slice(8)), 'DELETE'), 'Address removed.'); return; }
    if (a === 'deactivate') {
      if (!window.confirm('Deactivate ' + p2.full_name + '? Their Claude connector and dashboard sign-in stop working until reactivated.')) return;
      after(api('/' + p2.user_id + '/deactivate', 'POST', {}), function (r) { return 'Deactivated. Dashboard sign-in: ' + r.login + '.'; }); return;
    }
    if (a === 'reactivate') { after(api('/' + p2.user_id + '/reactivate', 'POST', {}), function (r) { return 'Reactivated. Dashboard sign-in: ' + r.login + '.'; }); return; }
    if (a === 'sendToken') {
      if (!window.confirm('Email ' + p2.full_name + ' a new Claude connector token? Their current token stops working.')) return;
      after(api('/' + p2.user_id + '/send-token', 'POST', {}), function (r) { return 'Connector email: ' + r.email + '.'; }); return;
    }
    if (a === 'sendInvite') {
      var v = S.inv;
      var body = { first_name: v.first_name, last_name: v.last_name, email: v.email, principal: v.principal || null,
                   grants: Object.keys(v.grants).filter(function (k) { return v.grants[k]; }).map(function (k) { return { scope: k, level: v.grants[k] }; }) };
      after(api('/invite', 'POST', body), function (r) { return 'Invited. Dashboard sign-in: ' + r.login + '. Claude connector email: ' + r.connector + '.'; });
    }
  }
  function onInput(ev) {
    var el = ev.target, k = el.getAttribute && el.getAttribute('data-in'); if (!k) return;
    var v = el.type === 'checkbox' ? el.checked : el.value;
    if (k.indexOf('g:') === 0) S.draft.grants[k.slice(2)] = v;
    else if (k.indexOf('rs:') === 0) S.draft.restrict[k.slice(3)] = v;
    else if (k.indexOf('cm:') === 0) S.draft.custom[k.slice(3)] = v;
    else if (k === 'principal') S.draft.principal = v;
    else if (k === 'owner') S.draft.owner = v;
    else if (k === 'email') { S.draft.email = v; return; }
    else if (k.indexOf('ig:') === 0) S.inv.grants[k.slice(3)] = v;
    else if (k.indexOf('i:') === 0) { S.inv[k.slice(2)] = v; if (el.tagName !== 'SELECT') return; }
    paint();
  }

  function openInvite(pre) {
    if (!S.data) return;
    S.mode = 'invite'; S.open = null; S.msg = '';
    S.inv = Object.assign({ first_name: '', last_name: '', email: '', principal: '', grants: {} }, pre || {});
    paint();
  }

  var CSS = [
    '.pa{display:flex;flex-direction:column;gap:12px}',
    '.pa-top{margin:0 0 4px}',
    '.pa-scroll{overflow:auto;border:1px solid var(--border);border-radius:var(--radius,10px)}',
    '.pa-tbl{width:100%;border-collapse:collapse;font-size:13px}',
    '.pa-tbl th{position:sticky;top:0;background:var(--panel);text-align:left;font-weight:500;color:var(--text3,var(--muted));padding:8px 12px;border-bottom:1px solid var(--border);white-space:nowrap;text-transform:none;letter-spacing:0;font-family:inherit;font-size:12.5px}',
    '.pa-tbl td{padding:8px 12px;border-bottom:1px solid var(--border);vertical-align:top}',
    '.pa-row{cursor:pointer}.pa-row:hover td{background:var(--panel-2,rgba(127,127,127,.06))}',
    '.pa-name{font-weight:600}.pa-sub{font-size:12px;color:var(--text3,var(--muted));margin-top:2px}',
    '.pa-muted{color:var(--text3,var(--muted))}','.pa-tbl td:nth-child(2),.pa-tbl td:nth-child(3){white-space:nowrap}',
    '.pa-chip{display:inline-block;white-space:nowrap;padding:1px 7px;border-radius:4px;font-size:11.5px;background:var(--panel-2,rgba(127,127,127,.12));color:var(--text2,inherit)}',
    '.pa-chip.ok{background:color-mix(in srgb,var(--good,#35D0A5) 16%,transparent);color:var(--good,#35D0A5)}',
    '.pa-chip.bad{background:color-mix(in srgb,var(--crit,#FF5A45) 16%,transparent);color:var(--crit,#FF5A45)}',
    '.pa-lv{white-space:nowrap}',
    '.pa-h3{margin:18px 0 6px;font-size:14px}',
    '.pa-desc{margin:4px 0 0;font-size:12.5px;color:var(--text3,var(--muted))}',
    '.pa-drawer{position:fixed;top:0;right:0;bottom:0;width:min(560px,100vw);overflow:auto;z-index:60;background:var(--panel);border-left:1px solid var(--border);padding:18px 20px 40px;box-shadow:-12px 0 32px rgba(0,0,0,.28)}',
    '.pa-dh{display:flex;justify-content:space-between;align-items:flex-start;gap:12px}.pa-dt{font-size:18px;font-weight:600}',
    '.pa-x{background:none;border:0;font-size:22px;line-height:1;color:inherit;cursor:pointer}',
    '.pa-field{margin-top:10px}.pa-field label{display:block;font-size:12.5px;font-weight:600;margin-bottom:4px}',
    '.pa-sel{width:100%;height:34px;padding:0 10px;border:1px solid var(--border);border-radius:8px;background:var(--bg,transparent);color:inherit;font:inherit;font-size:13px;box-sizing:border-box}',
    '.pa-sel.sm{width:auto;height:30px}',
    '.pa-grid2{display:grid;grid-template-columns:1fr 1fr;gap:10px}',
    '.pa-emails{display:flex;flex-direction:column;gap:6px}.pa-email{display:flex;align-items:center;gap:10px;justify-content:space-between}',
    '.pa-screens{margin-top:10px;border:1px solid var(--border);border-radius:8px;padding:8px 12px}.pa-scr-h{font-weight:600;margin-bottom:4px}',
    '.pa-scr{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:3px 0;font-size:13px}',
    '.pa-check{display:flex;gap:8px;align-items:center;margin-top:12px;font-size:13px}',
    '.pa-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:18px}',
    '.pa-btn{height:34px;padding:0 14px;border:1px solid var(--border);border-radius:8px;background:transparent;color:inherit;font:inherit;font-size:13px;cursor:pointer}',
    '.pa-btn.on{background:var(--accent);border-color:var(--accent);color:#fff}.pa-btn.bad{color:var(--crit,#FF5A45)}.pa-btn[disabled]{opacity:.55;cursor:default}',
    '.pa-link{background:none;border:0;color:var(--accent);cursor:pointer;font:inherit;font-size:12.5px}',
    '.pa-msg{margin-top:12px;padding:8px 12px;border-radius:8px;background:var(--panel-2,rgba(127,127,127,.1));font-size:13px}.pa-msg.bad{color:var(--crit,#FF5A45)}',
    '@media (max-width:640px){.pa-grid2{grid-template-columns:1fr}}',
  ].join('');
  var cssDone = false;

  function mount(host, opts) {
    if (!host) return;
    if (!cssDone) { var st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st); cssDone = true; }
    S.host = host; S.me = (opts && opts.me) || S.me;
    host.onclick = onClick; host.onchange = onInput; host.oninput = function (ev) { var k = ev.target.getAttribute && ev.target.getAttribute('data-in'); if (k === 'email' || (k && k.indexOf('i:') === 0)) onInput(ev); };
    if (!S.data) load(); else paint();
    paint();
  }
  function invalidate() { if (S.host) { S.loading = false; load(true); } }

  window.PortalAccess = { mount: mount, invalidate: invalidate, openInvite: openInvite };
})();
