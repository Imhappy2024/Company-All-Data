/* ===========================================================================
   portal-users.js - the Users & Roles screen.

   Same shape as portal-tasks.js: window.PortalUsers.render(brand, containerId,
   opts), painted from portal.html's render() AFTER the innerHTML assignment,
   because that assignment would otherwise wipe whatever we drew.

   ONE component, filtered by scope, never written twice:
     Executive Board  -> everyone, with a column of the businesses each reaches
     inside a business -> only people who can reach that business

   The layout follows Jay's mockup - the three-step drawer (Details, Type, Access),
   the role cards, the business checkboxes, the None / Read / Read & Write
   tri-state. None of its CSS is used: every colour here is a tokens.css token.
   None of its module lists are used either; they come from
   GET /api/access/modules, or they would drift the first time a module is added.

   WHAT THE UI IS AND IS NOT RESPONSIBLE FOR. The database refuses over-granting,
   an admin editing itself, granting Owner, and Exec-for-a-plain-user - by trigger,
   not by politeness. This file's job is to not OFFER those things, so nobody
   assembles a grant that cannot be saved. When the database does refuse, its
   message is shown verbatim: those messages are written to be read.
   =========================================================================== */
(function () {
  'use strict';

  var EXEC = 'exec';                       /* the scope key for Executive Board */
  var ROLE_LABEL = { owner: 'Owner', admin: 'Administrator', user: 'User' };
  var LEVELS = [
    { v: null, label: 'None' },
    { v: 'read', label: 'Read' },
    { v: 'write', label: 'Read & Write' },
  ];

  var ui = {
    brand: null, containerId: null, scope: null,
    me: null,                              /* dash_my_access().user */
    myAccess: null,                        /* dash_my_access().access */
    companies: {},                         /* id -> name, as granted to ME */
    users: null, modules: null,
    loading: false, error: null,
    open: null,                            /* the staff row being edited */
    draft: null,                           /* { role, full_name, grants:{scope:{module:level}} } */
    step: 1,
    busy: false, msg: null, msgBad: false,
  };

  function el() { return document.getElementById(ui.containerId); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
  }
  function rank(l) { return l === 'write' ? 2 : l === 'read' ? 1 : 0; }

  /* ---- what the SIGNED-IN user may offer --------------------------------- */

  function myRole() { return ui.me && ui.me.role; }
  function isOwner() { return myRole() === 'owner'; }

  /* An admin may only work inside businesses it holds. An owner holds everything.
     Exec is a scope like any other here, but only owner/admin can ever have it. */
  function myScopes() {
    return Object.keys(ui.myAccess || {});
  }
  function iHold(scope) { return !!(ui.myAccess && ui.myAccess[scope]); }

  /* The highest level the signed-in user could grant for one module in one scope.
     The trigger caps this too - dash_rank(mine) < dash_rank(theirs) is refused - so
     this exists to stop the UI offering a level that would bounce. */
  function myCap(scope, moduleKey, navId) {
    if (isOwner()) return 'write';
    var m = ui.myAccess && ui.myAccess[scope];
    if (!m) return null;
    /* An admin holds a whole business, so its cap is write across that business.
       For a plain user the cap is whatever they hold for that nav id - though a
       plain user never reaches this screen. */
    if (myRole() === 'admin') return 'write';
    return m[navId] || null;
  }

  /* ---- data ------------------------------------------------------------- */

  function authHeaders() {
    return PortalSession.client()
      .then(function (c) { return c.auth.getSession(); })
      .then(function (r) {
        var t = r && r.data && r.data.session && r.data.session.access_token;
        if (!t) throw new Error('Your session has expired. Sign in again.');
        return { Authorization: 'Bearer ' + t, Accept: 'application/json' };
      });
  }

  function api(path, init) {
    return authHeaders().then(function (h) {
      return fetch(path, Object.assign({}, init, {
        headers: Object.assign({}, h, (init && init.headers) || {}),
      }));
    }).then(function (res) {
      return res.text().then(function (txt) {
        var body = null;
        try { body = txt ? JSON.parse(txt) : null; } catch (e) { body = { error: txt }; }
        if (!res.ok) throw new Error((body && body.error) || ('HTTP ' + res.status));
        return body;
      });
    });
  }

  function load(force) {
    if (ui.users && ui.modules && !force) return Promise.resolve();
    ui.loading = true; ui.error = null;
    var q = ui.scope === EXEC ? '' : ('?company=' + encodeURIComponent(ui.scope));
    return Promise.all([
      api('/api/access/users' + q),
      ui.modules ? Promise.resolve({ modules: ui.modules }) : api('/api/access/modules'),
    ]).then(function (out) {
      ui.users = out[0].users || [];
      ui.modules = out[1].modules || [];
      ui.loading = false;
    }).catch(function (e) {
      ui.loading = false; ui.error = e.message;
    });
  }

  /* modules grouped by scope key, from the catalog. */
  function modulesFor(scope) {
    return (ui.modules || []).filter(function (m) {
      return (m.company_id || EXEC) === scope;
    });
  }

  /* ---- rendering -------------------------------------------------------- */

  function render(brand, containerId, opts) {
    opts = opts || {};
    var scopeChanged = ui.scope !== opts.scope;
    ui.brand = brand;
    ui.containerId = containerId;
    ui.scope = opts.scope;
    ui.me = opts.me || null;
    ui.myAccess = opts.access || null;
    ui.companies = opts.companies || {};
    if (scopeChanged) { ui.users = null; ui.open = null; ui.draft = null; ui.msg = null; }

    if (!el()) return;
    injectStyles();
    paint();
    load().then(paint);
  }

  function paint() {
    var host = el();
    if (!host) return;
    host.innerHTML = shell();
    bind(host);
  }

  function shell() {
    if (ui.error) {
      return blank('Could not load users', esc(ui.error));
    }
    if (ui.loading && !ui.users) {
      return '<div class="pu-wrap"><div class="pu-skel"></div><div class="pu-skel"></div><div class="pu-skel"></div></div>';
    }
    var scopeName = ui.scope === EXEC ? 'the whole group' : (ui.companies[ui.scope] || 'this business');
    return '<div class="pu-wrap">' +
      (ui.msg ? '<div class="pu-msg' + (ui.msgBad ? ' bad' : '') + '">' + esc(ui.msg) + '</div>' : '') +
      '<div class="pu-head">' +
        '<div class="pu-head-t">' + (ui.users || []).length + ' ' +
          ((ui.users || []).length === 1 ? 'person' : 'people') + ' with dashboard access</div>' +
        '<div class="pu-head-s">' +
          (ui.scope === EXEC
            ? 'Everyone with access, and the businesses each of them can reach.'
            : 'Only people who can reach ' + esc(scopeName) + '.') +
        '</div>' +
      '</div>' +
      table() +
      drawer();
  }

  function blank(t, b) {
    return '<div class="pu-blank"><div class="pu-blank-t">' + t + '</div><div class="pu-blank-b">' + b + '</div></div>';
  }

  /* The businesses one person reaches, for the Exec column. An owner reaches all,
     and says so rather than listing every one. */
  function reachOf(u) {
    if (u.role === 'owner') return ['All workspaces'];
    var ids = {};
    (u.grants || []).forEach(function (g) {
      if (g.company_id) ids[g.company_id] = true;
      else ids[EXEC] = true;
    });
    return Object.keys(ids).map(function (k) {
      return k === EXEC ? 'Executive Board' : (ui.companies[k] || 'A business');
    });
  }

  function initials(u) {
    var n = (u.full_name || '').trim();
    if (n) {
      var p = n.split(/\s+/);
      return ((p[0] || '')[0] || '' ) + (p.length > 1 ? (p[p.length - 1][0] || '') : '');
    }
    return ((u.email || '?')[0] || '?').toUpperCase();
  }

  function table() {
    if (!(ui.users || []).length) {
      return blank('Nobody yet',
        ui.scope === EXEC
          ? 'No accounts have dashboard access. Invite someone to get started.'
          : 'Nobody has been granted access to this business yet.');
    }
    var execCol = ui.scope === EXEC;
    return '<div class="pu-table">' +
      '<div class="pu-row pu-hrow">' +
        '<div>Person</div><div>Role</div>' +
        (execCol ? '<div>Reaches</div>' : '<div>Access here</div>') +
        '<div></div>' +
      '</div>' +
      ui.users.map(function (u) {
        var mine = ui.me && u.id === ui.me.id;
        /* An admin cannot edit its own row - the database refuses it, so the control
           is hidden and the reason is on hover rather than discovered on save. */
        var blocked = mine && !isOwner();
        return '<div class="pu-row" data-id="' + esc(u.id) + '">' +
          '<div class="pu-person">' +
            '<span class="pu-av">' + esc(initials(u)) + '</span>' +
            '<span><span class="pu-name">' + esc(u.full_name || '(no name)') +
              (mine ? ' <span class="pu-you">you</span>' : '') + '</span>' +
            '<span class="pu-email">' + esc(u.email) + '</span></span>' +
          '</div>' +
          '<div><span class="pu-role r-' + esc(u.role) + '">' + esc(ROLE_LABEL[u.role] || u.role) + '</span></div>' +
          '<div class="pu-reach">' + (execCol
            ? esc(reachOf(u).join(', ') || 'Nothing yet')
            : esc(hereSummary(u))) + '</div>' +
          '<div class="pu-actions">' + (blocked
            ? '<span class="pu-blocked" title="Admins cannot edit their own access. An owner has to do it.">Not editable</span>'
            : '<button class="pu-btn ghost" data-act="edit">Edit</button>') + '</div>' +
        '</div>';
      }).join('') +
    '</div>';
  }

  /* What one person holds in the CURRENT business, by catalog label. */
  function hereSummary(u) {
    if (u.role === 'owner') return 'Full access';
    var mods = modulesFor(ui.scope);
    var byKey = {};
    (u.grants || []).forEach(function (g) {
      if ((g.company_id || EXEC) === ui.scope) byKey[g.module] = g.level;
    });
    if (byKey['*']) return 'Full access (administrator)';
    var out = mods.filter(function (m) { return byKey[m.module_key]; })
      .map(function (m) { return m.label + ': ' + (byKey[m.module_key] === 'write' ? 'Read & Write' : 'Read'); });
    return out.length ? out.join(', ') : 'Nothing yet';
  }

  /* ---- the drawer ------------------------------------------------------- */

  function drawer() {
    if (!ui.open) return '';
    var u = ui.open, d = ui.draft;
    return '<div class="pu-scrim" data-act="close"></div>' +
      '<aside class="pu-drawer" role="dialog" aria-modal="true">' +
        '<div class="pu-dr-head">' +
          '<div><div class="pu-dr-t">' + esc(u.full_name || u.email) + '</div>' +
          '<div class="pu-dr-s">' + esc(u.email) + '</div></div>' +
          '<button class="pu-icon" data-act="close" aria-label="Close">&#10005;</button>' +
        '</div>' +
        steps() +
        '<div class="pu-dr-body">' +
          (ui.step === 1 ? stepDetails(u, d) : ui.step === 2 ? stepType(d) : stepAccess(d)) +
        '</div>' +
        '<div class="pu-dr-foot">' +
          (ui.step > 1 ? '<button class="pu-btn ghost" data-act="back">Back</button>' : '<span></span>') +
          (ui.step < 3
            ? '<button class="pu-btn" data-act="next">Next</button>'
            : '<button class="pu-btn" data-act="save"' + (ui.busy ? ' disabled' : '') + '>' +
              (ui.busy ? 'Saving…' : 'Save changes') + '</button>') +
        '</div>' +
      '</aside>';
  }

  function steps() {
    var names = ['Details', 'Type', 'Access'];
    return '<div class="pu-steps">' + names.map(function (n, i) {
      var k = i + 1;
      return '<button class="pu-step' + (ui.step === k ? ' on' : '') + '" data-act="step" data-step="' + k + '">' +
             '<span class="pu-step-n">' + k + '</span>' + n + '</button>';
    }).join('') + '</div>';
  }

  function stepDetails(u, d) {
    return '<label class="pu-lab" for="puName">Full name</label>' +
      '<input class="pu-in" id="puName" value="' + esc(d.full_name) + '" data-field="full_name">' +
      '<label class="pu-lab" for="puEmail">Email</label>' +
      '<input class="pu-in" id="puEmail" value="' + esc(u.email) + '" disabled>' +
      '<div class="pu-note">' +
        'Changing an email changes the address this person signs in with, so it is a ' +
        'separate, confirmed action rather than an inline edit. It is not wired up yet ' +
        '(it needs the server-side service role, which lands with the invite flow).' +
      '</div>';
  }

  function stepType(d) {
    /* The Owner card is hidden unless the signed-in user is an owner: the database
       refuses "Only an owner can grant the Owner role", so offering it would only
       produce a rejection. */
    var roles = isOwner() ? ['owner', 'admin', 'user'] : ['admin', 'user'];
    var blurb = {
      owner: 'Everything, everywhere. Needs no individual grants.',
      admin: 'Whole businesses, and can manage other people.',
      user: 'Only the modules picked in the next step. Cannot reach Executive Board.',
    };
    return '<div class="pu-cards">' + roles.map(function (r) {
      return '<button class="pu-card' + (d.role === r ? ' on' : '') + '" data-act="role" data-role="' + r + '">' +
        '<span class="pu-card-t">' + ROLE_LABEL[r] + '</span>' +
        '<span class="pu-card-b">' + blurb[r] + '</span></button>';
    }).join('') + '</div>' +
    (d.role === 'user'
      ? '<div class="pu-note">Executive Board is not available to a User. Any Executive ' +
        'Board access is cleared when the role is set to User.</div>'
      : '');
  }

  function stepAccess(d) {
    /* Scopes an admin may edit are only the ones it holds. Exec is offered only
       when the target is not a plain user. */
    var scopes = [];
    if (iHold(EXEC) || isOwner()) scopes.push(EXEC);
    Object.keys(ui.companies).forEach(function (cid) {
      if (isOwner() || iHold(cid)) scopes.push(cid);
    });

    return scopes.map(function (scope) {
      var isExec = scope === EXEC;
      var name = isExec ? 'Executive Board' : (ui.companies[scope] || 'Business');
      var execBlocked = isExec && d.role === 'user';
      var mods = modulesFor(scope);
      var adminWhole = d.role === 'admin' || d.role === 'owner';

      return '<div class="pu-scope' + (execBlocked ? ' off' : '') + '">' +
        '<div class="pu-scope-h">' +
          '<label class="pu-check">' +
            '<input type="checkbox" data-act="scope" data-scope="' + esc(scope) + '"' +
              (execBlocked ? ' disabled' : '') +
              (scopeOn(d, scope) ? ' checked' : '') + '>' +
            '<span>' + esc(name) + '</span>' +
          '</label>' +
          (execBlocked
            ? '<span class="pu-why">Requires the Administrator or Owner role</span>'
            : adminWhole
              ? '<span class="pu-why">Whole business</span>'
              : '') +
        '</div>' +
        (!execBlocked && scopeOn(d, scope) && !adminWhole
          ? '<div class="pu-mods">' + mods.map(function (m) {
              var cur = (d.grants[scope] || {})[m.module_key] || null;
              var cap = myCap(scope, m.module_key, m.nav_id);
              return '<div class="pu-mod">' +
                '<span class="pu-mod-n">' + esc(m.label) + '</span>' +
                '<span class="pu-tri">' + LEVELS.map(function (L) {
                  /* Capped at what the granting admin holds - the trigger refuses
                     more, so an uncheckable option would just bounce. */
                  var tooHigh = L.v && rank(L.v) > rank(cap);
                  return '<button class="pu-tri-b' + (cur === L.v ? ' on' : '') + (tooHigh ? ' cap' : '') + '"' +
                    (tooHigh ? ' disabled title="You do not hold this at that level"' : '') +
                    ' data-act="level" data-scope="' + esc(scope) + '" data-mod="' + esc(m.module_key) + '"' +
                    ' data-level="' + (L.v || '') + '">' + L.label + '</button>';
                }).join('') + '</span>' +
              '</div>';
            }).join('') + '</div>'
          : '') +
      '</div>';
    }).join('') || blank('Nothing to grant', 'You do not hold any business you could grant access to.');
  }

  function scopeOn(d, scope) {
    var m = d.grants[scope];
    return !!(m && Object.keys(m).length);
  }

  /* ---- drafting --------------------------------------------------------- */

  function openFor(u) {
    var grants = {};
    (u.grants || []).forEach(function (g) {
      var s = g.company_id || EXEC;
      grants[s] = grants[s] || {};
      grants[s][g.module] = g.level;
    });
    ui.open = u;
    ui.draft = { role: u.role, full_name: u.full_name || '', grants: grants };
    ui.step = 1;
    ui.msg = null;
    paint();
  }

  function setRole(r) {
    ui.draft.role = r;
    /* Dropping to User clears Exec immediately, so the drawer never shows a
       selection the database would refuse. The server clears it too. */
    if (r === 'user') delete ui.draft.grants[EXEC];
    /* admin/owner hold whole businesses, so per-module choices stop meaning
       anything; collapse each selected business to the '*' marker. */
    if (r === 'admin' || r === 'owner') {
      Object.keys(ui.draft.grants).forEach(function (s) {
        if (s !== EXEC) ui.draft.grants[s] = { '*': 'write' };
      });
      if (ui.draft.grants[EXEC]) ui.draft.grants[EXEC] = { executive: 'write' };
    } else {
      Object.keys(ui.draft.grants).forEach(function (s) {
        if (ui.draft.grants[s]['*']) delete ui.draft.grants[s]['*'];
      });
    }
    paint();
  }

  function toggleScope(scope, on) {
    if (!on) { delete ui.draft.grants[scope]; return paint(); }
    if (scope === EXEC) ui.draft.grants[EXEC] = { executive: 'write' };
    else if (ui.draft.role === 'admin' || ui.draft.role === 'owner') ui.draft.grants[scope] = { '*': 'write' };
    else ui.draft.grants[scope] = {};
    paint();
  }

  function setLevel(scope, mod, level) {
    ui.draft.grants[scope] = ui.draft.grants[scope] || {};
    if (!level) delete ui.draft.grants[scope][mod];
    else ui.draft.grants[scope][mod] = level;
    paint();
  }

  function save() {
    var d = ui.draft, u = ui.open;
    var grants = [];
    Object.keys(d.grants).forEach(function (s) {
      Object.keys(d.grants[s]).forEach(function (m) {
        grants.push({ company_id: s === EXEC ? null : s, module: m, level: d.grants[s][m] });
      });
    });
    /* Losing every grant is a real change and easy to do by accident. */
    if (d.role === 'user' && !grants.length &&
        !window.confirm('This will leave ' + (u.full_name || u.email) +
                        ' with no access at all. Continue?')) return;

    ui.busy = true; paint();
    api('/api/access/user/' + encodeURIComponent(u.id), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ full_name: d.full_name, role: d.role, grants: grants }),
    }).then(function () {
      ui.busy = false; ui.open = null; ui.draft = null;
      ui.msg = 'Saved.'; ui.msgBad = false;
      return load(true).then(paint);
    }).catch(function (e) {
      /* Verbatim: "You cannot grant more access than you have" is the answer. */
      ui.busy = false; ui.msg = e.message; ui.msgBad = true; paint();
    });
  }

  /* ---- events ----------------------------------------------------------- */

  function bind(host) {
    if (host.__puBound) return;
    host.__puBound = true;
    host.addEventListener('click', function (ev) {
      var a = ev.target.closest && ev.target.closest('[data-act]');
      if (!a) return;
      var act = a.getAttribute('data-act');
      if (act === 'edit') {
        var row = a.closest('.pu-row');
        var u = (ui.users || []).filter(function (x) { return x.id === row.getAttribute('data-id'); })[0];
        if (u) openFor(u);
      } else if (act === 'close') {
        ui.open = null; ui.draft = null; paint();
      } else if (act === 'step') {
        ui.step = Number(a.getAttribute('data-step')) || 1; paint();
      } else if (act === 'next') {
        ui.step = Math.min(3, ui.step + 1); paint();
      } else if (act === 'back') {
        ui.step = Math.max(1, ui.step - 1); paint();
      } else if (act === 'role') {
        setRole(a.getAttribute('data-role'));
      } else if (act === 'level') {
        setLevel(a.getAttribute('data-scope'), a.getAttribute('data-mod'),
                 a.getAttribute('data-level') || null);
      } else if (act === 'save') {
        save();
      }
    });
    host.addEventListener('change', function (ev) {
      var c = ev.target;
      if (c.type === 'checkbox' && c.getAttribute('data-act') === 'scope') {
        toggleScope(c.getAttribute('data-scope'), c.checked);
      }
    });
    host.addEventListener('input', function (ev) {
      if (ev.target.getAttribute && ev.target.getAttribute('data-field') === 'full_name') {
        ui.draft.full_name = ev.target.value;   /* no repaint: it would lose the caret */
      }
    });
    document.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape' && ui.open) { ui.open = null; ui.draft = null; paint(); }
    });
  }

  /* ---- styles: geometry only, every colour a token ---------------------- */

  function injectStyles() {
    if (document.getElementById('pu-styles')) return;
    var css = [
      '.pu-wrap{display:flex;flex-direction:column;gap:14px}',
      '.pu-skel{height:56px;border-radius:10px;background:var(--surface-2,var(--panel-2))}',
      '.pu-msg{padding:9px 12px;border-radius:8px;font-size:12.5px;background:var(--good-soft,rgba(12,163,12,.12));color:var(--good-ink,var(--text))}',
      '.pu-msg.bad{background:var(--crit-soft,rgba(208,59,59,.12));color:var(--crit-ink,var(--text));border:1px solid var(--crit,#d03b3b)}',
      '.pu-head-t{font-size:14.5px;font-weight:650;color:var(--text)}',
      '.pu-head-s{font-size:12.5px;color:var(--text2);margin-top:2px}',
      '.pu-table{border:1px solid var(--border);border-radius:10px;overflow:hidden;background:var(--surface)}',
      '.pu-row{display:grid;grid-template-columns:minmax(0,2fr) 130px minmax(0,2fr) 110px;',
        'align-items:center;gap:12px;padding:10px 14px;border-bottom:1px solid var(--border)}',
      '.pu-row:last-child{border-bottom:none}',
      '.pu-hrow{font-size:11px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;',
        'color:var(--text3);background:var(--surface-2,var(--panel-2))}',
      '.pu-person{display:flex;align-items:center;gap:10px;min-width:0}',
      '.pu-av{width:28px;height:28px;border-radius:50%;flex:none;display:flex;align-items:center;',
        'justify-content:center;font-size:11px;font-weight:700;background:var(--accent);color:#fff}',
      '.pu-name{display:block;font-size:13px;font-weight:600;color:var(--text)}',
      '.pu-email{display:block;font-size:11.5px;color:var(--text3)}',
      '.pu-you{font-size:10px;font-weight:600;color:var(--accent)}',
      '.pu-role{font-size:11.5px;font-weight:600;padding:2px 8px;border-radius:999px;',
        'background:var(--surface-2,var(--panel-2));color:var(--text2)}',
      '.pu-role.r-owner{background:var(--accent-soft,var(--surface-2));color:var(--accent)}',
      '.pu-reach{font-size:12px;color:var(--text2);min-width:0;overflow-wrap:anywhere}',
      '.pu-actions{text-align:right}',
      '.pu-blocked{font-size:11.5px;color:var(--text3);cursor:help;border-bottom:1px dotted var(--border-strong,var(--border))}',
      '.pu-btn{padding:7px 14px;border-radius:8px;border:1px solid transparent;background:var(--accent);',
        'color:#fff;font:inherit;font-size:12.5px;font-weight:600;cursor:pointer}',
      '.pu-btn.ghost{background:none;border-color:var(--border);color:var(--text2)}',
      '.pu-btn:disabled{opacity:.6;cursor:progress}',
      '.pu-blank{padding:34px 16px;text-align:center;border:1px solid var(--border);border-radius:10px;background:var(--surface)}',
      '.pu-blank-t{font-size:14px;font-weight:650;color:var(--text);margin-bottom:6px}',
      '.pu-blank-b{font-size:12.5px;color:var(--text2);max-width:420px;margin:0 auto;line-height:1.55}',

      '.pu-scrim{position:fixed;inset:0;z-index:70;background:rgba(0,0,0,.34)}',
      '.pu-drawer{position:fixed;top:0;right:0;bottom:0;z-index:71;width:min(520px,96vw);',
        'display:flex;flex-direction:column;background:var(--surface);',
        'border-left:1px solid var(--border);box-shadow:var(--shadow-lg,0 24px 70px -12px rgba(0,0,0,.5))}',
      '.pu-dr-head{display:flex;align-items:flex-start;gap:10px;padding:16px 18px 12px;border-bottom:1px solid var(--border)}',
      '.pu-dr-t{font-size:15px;font-weight:650;color:var(--text);overflow-wrap:anywhere}',
      '.pu-dr-s{font-size:11.5px;color:var(--text3);margin-top:2px}',
      '.pu-icon{margin-left:auto;background:none;border:none;color:var(--text3);font-size:14px;cursor:pointer;padding:2px 6px}',
      '.pu-steps{display:flex;gap:6px;padding:12px 18px;border-bottom:1px solid var(--border)}',
      '.pu-step{display:flex;align-items:center;gap:7px;padding:6px 11px;border-radius:999px;',
        'border:1px solid var(--border);background:none;color:var(--text2);font:inherit;font-size:12px;cursor:pointer}',
      '.pu-step.on{border-color:var(--accent);color:var(--accent);background:var(--accent-soft,var(--surface-2))}',
      '.pu-step-n{width:17px;height:17px;border-radius:50%;display:flex;align-items:center;justify-content:center;',
        'font-size:10px;font-weight:700;background:var(--surface-2,var(--panel-2))}',
      '.pu-step.on .pu-step-n{background:var(--accent);color:#fff}',
      '.pu-dr-body{flex:1;overflow:auto;padding:16px 18px}',
      '.pu-dr-foot{display:flex;align-items:center;justify-content:space-between;gap:10px;',
        'padding:12px 18px;border-top:1px solid var(--border)}',
      '.pu-lab{display:block;font-size:11px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;',
        'color:var(--text3);margin:0 0 6px}',
      '.pu-in{width:100%;height:36px;padding:0 10px;border-radius:8px;border:1px solid var(--border);',
        'background:var(--bg);color:var(--text);font:inherit;font-size:13px;margin-bottom:14px}',
      '.pu-in:disabled{opacity:.65;cursor:not-allowed}',
      '.pu-note{font-size:12px;color:var(--text2);line-height:1.55;background:var(--surface-2,var(--panel-2));',
        'padding:10px 12px;border-radius:8px}',
      '.pu-cards{display:flex;flex-direction:column;gap:9px;margin-bottom:14px}',
      '.pu-card{text-align:left;padding:11px 13px;border-radius:10px;border:1px solid var(--border);',
        'background:none;cursor:pointer;font:inherit}',
      '.pu-card.on{border-color:var(--accent);background:var(--accent-soft,var(--surface-2))}',
      '.pu-card-t{display:block;font-size:13px;font-weight:650;color:var(--text)}',
      '.pu-card-b{display:block;font-size:12px;color:var(--text2);margin-top:2px}',
      '.pu-scope{border:1px solid var(--border);border-radius:10px;padding:11px 12px;margin-bottom:10px}',
      '.pu-scope.off{opacity:.6}',
      '.pu-scope-h{display:flex;align-items:center;gap:10px}',
      '.pu-check{display:flex;align-items:center;gap:8px;font-size:13px;font-weight:600;color:var(--text);cursor:pointer}',
      '.pu-check input{width:15px;height:15px;accent-color:var(--accent);cursor:pointer}',
      '.pu-why{margin-left:auto;font-size:11.5px;color:var(--text3)}',
      '.pu-mods{margin-top:10px;display:flex;flex-direction:column;gap:6px}',
      '.pu-mod{display:flex;align-items:center;gap:10px}',
      '.pu-mod-n{flex:1;min-width:0;font-size:12.5px;color:var(--text2)}',
      '.pu-tri{display:flex;gap:4px;flex:none}',
      '.pu-tri-b{padding:4px 9px;border-radius:7px;border:1px solid var(--border);background:none;',
        'color:var(--text2);font:inherit;font-size:11.5px;cursor:pointer}',
      '.pu-tri-b.on{border-color:var(--accent);background:var(--accent);color:#fff}',
      '.pu-tri-b.cap{opacity:.4;cursor:not-allowed}',
      '@media (max-width:720px){.pu-row{grid-template-columns:minmax(0,1fr) 96px;row-gap:6px}',
        '.pu-reach,.pu-hrow{display:none}}',
    ].join('');
    var s = document.createElement('style');
    s.id = 'pu-styles';
    s.textContent = css;
    document.head.appendChild(s);
  }

  window.PortalUsers = {
    render: render,
    invalidate: function () { ui.users = null; },
    _internals: { ui: ui, reachOf: reachOf, hereSummary: hereSummary, myCap: myCap },
  };
})();
