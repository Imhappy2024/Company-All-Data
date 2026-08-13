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
    adding: false,                         /* the drawer is Add rather than Edit */
    candidates: null,                      /* staff WITHOUT dashboard access, lazily loaded */
    pickQuery: '',
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
    bindFocusRefresh();
    paint();
    load().then(paint);
  }

  /* Staying current has three layers, because no one of them covers the others.
     A change made HERE refetches immediately - the three mutations each call
     load(true). A change made by ANOTHER admin arrives over the SSE channel, through
     the staff and dashboard_permission bindings in portal-realtime.js. Neither one
     reaches a tab that sat in the background while somebody else worked: the stream
     has no replay buffer, and a disconnected client cannot know what it missed. So
     returning to the tab refetches as well.

     This layer is also the only one that works before
     migrations/20260810_supabase_webhooks.sql is applied, since until then nothing
     POSTs to the hook and the SSE channel never fires at all.

     Bound ONCE, not per paint. render() runs on every navigation, and a listener
     added each time would still be attached after you left the screen - N copies
     firing N refetches on a single focus. */
  var focusBound = false;
  function bindFocusRefresh() {
    if (focusBound) return;
    focusBound = true;
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) return;
      if (!el()) return;            /* not the screen on display - nothing to refresh */
      load(true).then(paint);
    });
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
        '<div>' +
          '<div class="pu-head-t">' + (ui.users || []).length + ' ' +
            ((ui.users || []).length === 1 ? 'person' : 'people') + ' with dashboard access</div>' +
          '<div class="pu-head-s">' +
            (ui.scope === EXEC
              ? 'Everyone with access, and the businesses each of them can reach.'
              : 'Only people who can reach ' + esc(scopeName) + '.') +
            ' Staff without dashboard access are not listed here &mdash; they are on Team directory.' +
          '</div>' +
        '</div>' +
      /* No button here: the page header owns "Invite user", so rendering one would
         put two identical controls on the same screen. */
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

  /* The headshot from staff.avatar_url, with the initials chip as the fallback.

     The initials stay in the DOM UNDERNEATH the image rather than being swapped in on
     failure: dropping the <img> then reveals them with no re-render, and no state to
     keep in sync. Same rule as brandMarkFailed() for the workspace logos - a broken
     image must never leave an empty circle.

     That path is live, not theoretical. Every one of these headshots is hotlinked from
     static.showit.co, so anywhere that host is blocked or unreachable, every avatar on
     the screen takes it. */
  function avatarChip(u) {
    var ini = esc(initials(u));
    if (!u.avatar_url) return '<span class="pu-av">' + ini + '</span>';
    return '<span class="pu-av has-photo">' + ini +
      '<img src="' + esc(u.avatar_url) + '" alt="" loading="lazy"' +
      ' onerror="PortalUsers.avatarFailed(this)"></span>';
  }

  function avatarFailed(img) {
    var span = img.parentNode;
    if (span) span.classList.remove('has-photo');
    if (img.remove) img.remove();
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

    /* Accepted people first, outstanding invitations in their own group underneath.
       SPLIT, not hidden: an invitation nobody can see is one nobody can chase, and
       "did that actually send?" stops being answerable from the screen that sent it.
       Grouping keeps the working list uncluttered without losing that.
       The Active heading only appears when there is something to contrast it with -
       a single group does not need a label telling you what it is. */
    var live = [], invited = [];
    ui.users.forEach(function (u) { (u.pending ? invited : live).push(u); });

    return '<div class="pu-table">' +
      '<div class="pu-row pu-hrow">' +
        '<div>Person</div><div>Role</div>' +
        (execCol ? '<div>Reaches</div>' : '<div>Access here</div>') +
        '<div></div>' +
      '</div>' +
      (live.length && invited.length ? groupHead('Active', live.length) : '') +
      rows(live, execCol) +
      (invited.length
        ? groupHead('Invited &mdash; not yet accepted', invited.length) + rows(invited, execCol)
        : '') +
    '</div>';
  }

  function groupHead(label, n) {
    return '<div class="pu-grouph">' + label + '<span class="pu-groupn">' + n + '</span></div>';
  }

  function rows(list, execCol) {
    return list.map(function (u) {
        var mine = ui.me && u.id === ui.me.id;
        /* An admin cannot edit its own row - the database refuses it, so the control
           is hidden and the reason is on hover rather than discovered on save. */
        var blocked = mine && !isOwner();
        return '<div class="pu-row" data-id="' + esc(u.id) + '">' +
          '<div class="pu-person">' +
            avatarChip(u) +
            '<span><span class="pu-name">' + esc(u.full_name || '(no name)') +
              (mine ? ' <span class="pu-you">you</span>' : '') +
              /* user_id is still null: invited, link not yet clicked. */
              (u.pending ? ' <span class="pu-pending" title="Invited, but the invitation has not been accepted yet">Pending</span>' : '') +
              '</span>' +
            '<span class="pu-email">' + esc(u.email) + '</span></span>' +
          '</div>' +
          '<div><span class="pu-role r-' + esc(u.role) + '">' + esc(ROLE_LABEL[u.role] || u.role) + '</span></div>' +
          '<div class="pu-reach">' + (execCol
            ? esc(reachOf(u).join(', ') || 'Nothing yet')
            : esc(hereSummary(u))) + '</div>' +
          '<div class="pu-actions">' + (blocked
            ? '<span class="pu-blocked" title="Admins cannot edit their own access. An owner has to do it.">Not editable</span>'
            : '<button class="pu-btn ghost" data-act="edit">Edit</button>' +
              /* Revoking your own access would lock you out of the screen that
                 undoes it, so it is never offered on your own row. */
              (mine ? '' : '<button class="pu-btn ghost danger" data-act="revoke">Revoke</button>')
            ) + '</div>' +
        '</div>';
      }).join('');
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
          /* Adding has no person yet, so the header names the action rather than
             rendering an empty title. Matches the button that opened it. */
          '<div><div class="pu-dr-t">' + (ui.adding ? 'Invite user' : esc(u.full_name || u.email)) + '</div>' +
          '<div class="pu-dr-s">' +
            (ui.adding ? 'They receive an email invitation and choose their own password.'
                       : esc(u.email)) + '</div></div>' +
          '<button class="pu-icon" data-act="close" aria-label="Close">&#10005;</button>' +
        '</div>' +
        steps() +
        '<div class="pu-dr-body">' +
          (ui.step === 1 ? stepDetails(u, d) : ui.step === 2 ? stepType(d) : stepAccess(d)) +
        '</div>' +
        '<div class="pu-dr-foot">' + footInner() + '</div>' +
      '</aside>';
  }

  /* Split out so refreshFoot() can re-evaluate the Send button as the name is typed
     without repainting the field the caret is in. */
  function footInner() {
    return (ui.step > 1 ? '<button class="pu-btn ghost" data-act="back">Back</button>' : '<span></span>') +
      (ui.step < 3
        ? '<button class="pu-btn" data-act="next">Next</button>'
        : ui.adding
          ? '<button class="pu-btn" data-act="invite"' +
            ((ui.busy || !inviteReady()) ? ' disabled' : '') +
            (inviteReady() ? '' : ' title="Enter a first name, last name and email address first"') + '>' +
            (ui.busy ? 'Sending…' : 'Send invitation') + '</button>'
          : '<button class="pu-btn" data-act="save"' + (ui.busy ? ' disabled' : '') + '>' +
            (ui.busy ? 'Saving…' : 'Save changes') + '</button>');
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
    if (ui.adding) return stepPick(d);
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

  /* Pick an existing staff member, or type a genuinely new address.

     staff has a unique index on (tenant_id, lower(email)), so an address that
     matches an existing person must UPDATE that row - setting dashboard_access and
     dashboard_role - and never insert a second one. Picking from the list removes
     the chance to mistype at all; the free-text field is for someone who is not in
     staff yet. Either way the server decides update-vs-insert by email, so a typo
     that happens to match still lands on the right person. */
  function stepPick(d) {
    var q = (ui.pickQuery || '').toLowerCase().trim();
    var list = (ui.candidates || []).filter(function (c) {
      if (!q) return true;
      return ((c.full_name || '') + ' ' + (c.email || '')).toLowerCase().indexOf(q) >= 0;
    }).slice(0, 8);

    /* TYPED, not picked. Somebody hired to run leads is not in staff yet, and making
       the list the only way in meant they had to be created elsewhere first. These
       fields serve both jobs: a new person gets a staff record AND a login, and an
       address that already belongs to someone attaches to that person instead.

       The uniqueness guarantee the picker used to provide is kept, and is now the
       server's rather than the UI's: staff has a unique index on
       (tenant_id, lower(email)), so an address that matches UPDATES that row and
       never inserts a second. The match is surfaced below as it is typed so nobody
       has to wonder which of the two happened. */
    var match = matchedStaff(d.email);
    return '<div class="pu-two">' +
        '<div><label class="pu-lab" for="puFirst">First name</label>' +
          '<input class="pu-in" id="puFirst" data-field="first" autocomplete="off" value="' + esc(d.first || '') + '"></div>' +
        '<div><label class="pu-lab" for="puLast">Last name</label>' +
          '<input class="pu-in" id="puLast" data-field="last" autocomplete="off" value="' + esc(d.last || '') + '"></div>' +
      '</div>' +
      '<label class="pu-lab" for="puEmail">Email</label>' +
      '<input class="pu-in" id="puEmail" data-field="email" type="email" autocomplete="off"' +
        ' placeholder="name@company.com" value="' + esc(d.email || '') + '">' +
      (match
        ? '<div class="pu-note">That address already belongs to <b>' + esc(match.full_name || match.email) +
          '</b> in staff. Access is added to that record - no second person is created.</div>' +
          priorGrantsNote(match.id)
        : '<div class="pu-note">A staff record is created for them alongside the login, ' +
          'so a new hire does not have to be added anywhere else first.</div>');
  }

  /* An existing staff member with this address, if there is one. Candidates are the
     staff WITHOUT dashboard access, which is exactly the set an invite can attach to;
     anyone already holding access is on the list behind this drawer. */
  function matchedStaff(email) {
    var e = String(email || '').trim().toLowerCase();
    if (!e) return null;
    return (ui.candidates || []).filter(function (c) {
      return String(c.email || '').trim().toLowerCase() === e;
    })[0] || null;
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
      : '<div class="pu-note">An Administrator holds whole businesses, so the ' +
        'per-module choices are replaced by a single tick per business. Switching ' +
        'back to User before saving restores them &mdash; nothing is written until ' +
        'you press Save.</div>');
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
              : scopeOn(d, scope)
                /* LeavenWealth alone carries eleven modules, so setting them one at a
                   time is the common case and the slow one. Clear keeps the business
                   ticked - it empties the grants rather than undoing the choice. */
                ? '<span class="pu-bulk">' +
                    '<button data-act="bulk" data-scope="' + esc(scope) + '" data-level="write">All read &amp; write</button>' +
                    '<button data-act="bulk" data-scope="' + esc(scope) + '" data-level="read">All read</button>' +
                    '<button data-act="bulk" data-scope="' + esc(scope) + '" data-level="" class="pu-bulk-x">Clear</button>' +
                  '</span>'
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

  /* Revoking access leaves the grant rows in place, so re-granting hands the person
     back exactly what they had. That is the right default - it beats silently
     starting them at nothing - but six months is long enough for "read on
     Properties" to have stopped being appropriate, so it is shown rather than
     restored quietly. */
  function priorGrantsNote(staffId) {
    var prior = (ui.priorGrants || {})[staffId];
    if (!prior) return '';
    if (!prior.length) {
      return '<div class="pu-note">They held no access before, so nothing is restored.</div>';
    }
    var mods = {};
    (ui.modules || []).forEach(function (m) { mods[(m.company_id || EXEC) + '::' + m.module_key] = m.label; });
    var lines = prior.map(function (g) {
      var scope = g.company_id || EXEC;
      var where = scope === EXEC ? 'Executive Board' : (ui.companies[scope] || 'A business');
      var what = g.module === '*' ? 'the whole business'
               : (mods[scope + '::' + g.module] || g.module);
      return where + ' &rarr; ' + what + ': ' + (g.level === 'write' ? 'Read & Write' : 'Read');
    });
    return '<div class="pu-note pu-prior"><b>They will get their previous access back:</b>' +
      '<ul>' + lines.map(function (l) { return '<li>' + l + '</li>'; }).join('') + '</ul>' +
      'Check it is still appropriate &mdash; you can change it on the next two steps.</div>';
  }

  /* Selected means "the key exists", NOT "it holds at least one grant".
     toggleScope() sets an EMPTY object for a plain user - the business is chosen, no
     module granted yet - so counting grants made that first tick read back as
     unchecked. The module list is rendered on the same test, so it never opened and a
     User could not be granted anything at all. Unticking deletes the key, which is
     what makes presence the right test. */
  function scopeOn(d, scope) {
    return Object.prototype.hasOwnProperty.call(d.grants || {}, scope);
  }

  /* ---- drafting --------------------------------------------------------- */

  /* Add-person drawer. Same three steps, but step 1 is the picker. */
  function openAdd() {
    ui.adding = true;
    ui.open = { id: null, full_name: '', email: '', role: 'user', grants: [] };
    ui.draft = { role: 'user', first: '', last: '', full_name: '', email: '', staff_id: null, grants: {} };
    ui.pickQuery = '';
    ui.step = 1;
    ui.msg = null;
    paint();
    if (ui.candidates === null) {
      api('/api/access/candidates').then(function (r) {
        ui.candidates = r.candidates || []; paint();
      }).catch(function (e) { ui.candidates = []; ui.msg = e.message; ui.msgBad = true; paint(); });
    }
  }

  /* When the typed address matches somebody already in staff, pre-load the access
     they held before. Grants survive a revoke, so re-inviting hands back exactly what
     they had - the right default, but it wants showing rather than restoring quietly.
     Same behaviour the picker used to give, now reached by typing the address. */
  function loadPriorGrants(staffId) {
    if (!staffId) return;
    ui.priorGrants = ui.priorGrants || {};
    /* Claimed before the request so a further keystroke cannot fire a second one. */
    if (staffId in ui.priorGrants) return;
    ui.priorGrants[staffId] = null;
    {
      api('/api/access/grants/' + encodeURIComponent(staffId)).then(function (r) {
        ui.priorGrants[staffId] = r.grants || [];
        (r.grants || []).forEach(function (g) {
          var s = g.company_id || EXEC;
          ui.draft.grants[s] = ui.draft.grants[s] || {};
          ui.draft.grants[s][g.module] = g.level;
        });
        paint();
      }).catch(function () { /* the note is a courtesy; never block the invite */ });
    }
  }

  function revoke(u) {
    if (!window.confirm(
      'Remove dashboard access for ' + (u.full_name || u.email) + '?\n\n' +
      'They will no longer be able to sign in, and they disappear from this list.\n\n' +
      'Their staff record is NOT deleted - they stay in Team directory, and their ' +
      'existing access can be restored later.')) return;
    ui.busy = true; paint();
    api('/api/access/user/' + encodeURIComponent(u.id), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dashboard_access: false }),
    }).then(function () {
      ui.busy = false;
      ui.msg = 'Dashboard access removed for ' + (u.full_name || u.email) + '. Their staff record is unchanged.';
      ui.msgBad = false;
      ui.candidates = null;              /* they are a candidate again now */
      return load(true).then(paint);
    }).catch(function (e) {
      ui.busy = false; ui.msg = e.message; ui.msgBad = true; paint();
    });
  }

  function openFor(u) {
    ui.adding = false;
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

  /* Set every module in one business at once, CLAMPED to what the signed-in user
     actually holds. The trigger refuses a grant above the granter's own level, so an
     unclamped "all read & write" would quietly assemble rows that bounce on save -
     and the person who pressed it would not be told which ones. A module the granter
     cannot grant at all is skipped rather than written at a level it would reject.
     An owner's cap is 'write' everywhere, so for an owner this is the plain
     everything. */
  function bulkLevel(scope, level) {
    var d = ui.draft;
    if (!d) return;
    d.grants[scope] = d.grants[scope] || {};
    modulesFor(scope).forEach(function (m) {
      if (!level) { delete d.grants[scope][m.module_key]; return; }
      var cap = myCap(scope, m.module_key, m.nav_id);
      if (!cap) return;
      d.grants[scope][m.module_key] = rank(level) > rank(cap) ? cap : level;
    });
    paint();
  }

  function setLevel(scope, mod, level) {
    ui.draft.grants[scope] = ui.draft.grants[scope] || {};
    if (!level) delete ui.draft.grants[scope][mod];
    else ui.draft.grants[scope][mod] = level;
    paint();
  }

  /* A name AND a plausible address. The name is required because this now creates the
     staff record too - "who is this" cannot be answered by an address alone, and a
     directory full of people identified only by email is not a directory. */
  function inviteReady() {
    var d = ui.draft || {};
    return !!(String(d.first || '').trim() && String(d.last || '').trim() &&
              /.+@.+\..+/.test(String(d.email || '').trim()));
  }

  /* Repaints ONLY the footer, so the Send button can enable as the name is typed
     without the repaint stealing the caret out of the field being typed into. */
  function refreshFoot() {
    var host = el(); if (!host) return;
    var foot = host.querySelector('.pu-dr-foot');
    if (foot) foot.innerHTML = footInner();
  }

  function sendInvite() {
    var d = ui.draft;
    var grants = [];
    Object.keys(d.grants).forEach(function (s) {
      Object.keys(d.grants[s]).forEach(function (m) {
        grants.push({ company_id: s === EXEC ? null : s, module: m, level: d.grants[s][m] });
      });
    });
    if (d.role === 'user' && !grants.length &&
        !window.confirm('Invite ' + (d.email || d.full_name) +
                        ' with no access at all? They will be able to sign in and see nothing.')) return;

    ui.busy = true; paint();
    api('/api/access/invite', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: d.email, full_name: d.full_name, role: d.role, grants: grants }),
    }).then(function (r) {
      ui.busy = false; ui.open = null; ui.draft = null; ui.adding = false;
      ui.candidates = null;                /* they are no longer a candidate */
      ui.msg = 'Invitation sent to ' + (r.email || d.email) +
               '. They appear as Pending until they open the link and choose a password.';
      ui.msgBad = false;
      return load(true).then(paint);
    }).catch(function (e) {
      ui.busy = false;
      /* Verbatim, including the rollback note if the server could not fully undo. */
      ui.msg = e.message; ui.msgBad = true; paint();
    });
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
      var rowOf = function () {
        var row = a.closest('.pu-row');
        return row && (ui.users || []).filter(function (x) { return x.id === row.getAttribute('data-id'); })[0];
      };
      if (act === 'edit') {
        var u = rowOf(); if (u) openFor(u);
      } else if (act === 'revoke') {
        var ru = rowOf(); if (ru) revoke(ru);
      } else if (act === 'add') {
        openAdd();
      } else if (act === 'close') {
        ui.open = null; ui.draft = null; ui.adding = false; paint();
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
      } else if (act === 'bulk') {
        bulkLevel(a.getAttribute('data-scope'), a.getAttribute('data-level') || null);
      } else if (act === 'save') {
        save();
      } else if (act === 'invite') {
        sendInvite();
      }
    });
    host.addEventListener('change', function (ev) {
      var c = ev.target;
      if (c.type === 'checkbox' && c.getAttribute('data-act') === 'scope') {
        toggleScope(c.getAttribute('data-scope'), c.checked);
      }
    });
    host.addEventListener('input', function (ev) {
      var f = ev.target.getAttribute && ev.target.getAttribute('data-field');
      if (f === 'full_name') {
        ui.draft.full_name = ev.target.value;   /* no repaint: it would lose the caret */
      } else if (f === 'first' || f === 'last') {
        /* No repaint: it would lose the caret, and nothing on screen depends on the
           name except the Send button, which foot() re-evaluates on its own. */
        ui.draft[f] = ev.target.value;
        ui.draft.full_name = [ui.draft.first || '', ui.draft.last || ''].join(' ').trim();
        refreshFoot();
      } else if (f === 'email') {
        /* Email DOES repaint, because the "already belongs to X" note underneath it
           changes as it is typed - that note is the only thing telling you whether
           this attaches to an existing person or creates one. Caret restored by hand,
           since the repaint replaces the field. */
        ui.draft.email = ev.target.value.trim();
        /* Resolved HERE rather than during render, so painting stays free of side
           effects. staff_id is what tells the server this is an existing person; the
           server would reach the same answer from the address alone, but sending it
           makes the intent explicit rather than implied. */
        var m = matchedStaff(ui.draft.email);
        ui.draft.staff_id = m ? m.id : null;
        if (m) loadPriorGrants(m.id);
        var caret = ev.target.selectionStart;
        paint();
        var again = document.getElementById('puEmail');
        if (again) { again.focus(); try { again.setSelectionRange(caret, caret); } catch (e) {} }
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
      '.pu-head{display:flex;align-items:flex-start;justify-content:space-between;gap:14px}',
      '.pu-head-t{font-size:14.5px;font-weight:650;color:var(--text)}',
      '.pu-head-s{font-size:12.5px;color:var(--text2);margin-top:2px;max-width:620px;line-height:1.5}',
      '.pu-pending{font-size:10px;font-weight:700;letter-spacing:.03em;text-transform:uppercase;',
        'padding:1px 6px;border-radius:999px;background:var(--warn-soft,rgba(224,138,11,.16));',
        'color:var(--warn-ink,var(--text2));cursor:help}',
      '.pu-btn.danger{color:var(--crit-ink,var(--text2));border-color:var(--border)}',
      '.pu-btn.danger:hover{border-color:var(--crit,#d03b3b);color:var(--crit,#d03b3b)}',
      '.pu-actions{display:flex;gap:6px;justify-content:flex-end}',
      '.pu-picks{display:flex;flex-direction:column;gap:6px;margin-bottom:12px}',
      '.pu-pick{display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:9px;',
        'border:1px solid var(--border);background:none;cursor:pointer;text-align:left;font:inherit}',
      '.pu-pick.on{border-color:var(--accent);background:var(--accent-soft,var(--surface-2))}',
      '.pu-todo{border:1px dashed var(--border-strong,var(--border));background:none}',
      '.pu-prior ul{margin:6px 0 6px 16px;padding:0}',
      '.pu-prior li{font-size:12px;color:var(--text2);margin:2px 0}',
      '.pu-table{border:1px solid var(--border);border-radius:10px;overflow:hidden;background:var(--surface)}',
      '.pu-row{display:grid;grid-template-columns:minmax(0,2fr) 130px minmax(0,2fr) 110px;',
        'align-items:center;gap:12px;padding:10px 14px;border-bottom:1px solid var(--border)}',
      '.pu-row:last-child{border-bottom:none}',
      '.pu-grouph{display:flex;align-items:center;gap:7px;padding:7px 14px;',
        'background:var(--surface-2,var(--panel-2));border-bottom:1px solid var(--border);',
        'font-size:10.5px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:var(--text3)}',
      '.pu-groupn{font-weight:600;opacity:.75}',
      '.pu-hrow{font-size:11px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;',
        'color:var(--text3);background:var(--surface-2,var(--panel-2))}',
      '.pu-person{display:flex;align-items:center;gap:10px;min-width:0}',
      '.pu-av{width:28px;height:28px;border-radius:50%;flex:none;display:flex;align-items:center;',
        'justify-content:center;font-size:11px;font-weight:700;background:var(--accent);color:#fff}',
      /* The photo sits OVER the initials rather than replacing them, so removing a
         broken <img> reveals the chip underneath with nothing to re-render. */
      '.pu-av.has-photo{position:relative;overflow:hidden}',
      /* Above centre: a centred square crop of a portrait cuts the top of the head. */
      '.pu-av img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;object-position:50% 20%;border-radius:inherit}',
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
      '.pu-two{display:flex;gap:12px}.pu-two>div{flex:1;min-width:0}',
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
      '.pu-bulk{margin-left:auto;display:flex;gap:12px}',
      '.pu-bulk button{all:unset;cursor:pointer;font-size:11px;font-weight:650;color:var(--accent)}',
      '.pu-bulk button:hover{text-decoration:underline}',
      '.pu-bulk .pu-bulk-x{color:var(--text3)}',
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
    openAdd: openAdd,        /* the page header's "Invite user" button calls this */
    avatarFailed: avatarFailed,   /* referenced from the img onerror attribute */
    invalidate: function () { ui.users = null; },
    _internals: { ui: ui, reachOf: reachOf, hereSummary: hereSummary, myCap: myCap,
                  avatarChip: avatarChip },
  };
})();
