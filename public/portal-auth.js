/* ===========================================================================
   portal-auth.js - ClickUp sign-in state for the portal.

   The portal itself needs no login. Only the Tasks screens do, because reading
   and writing ClickUp is attributed to the signed-in user. So this module owns
   auth state and hands out a gate panel; it never covers the whole app.

   Server side (all pre-existing, see server.js):
     GET  /auth/clickup   starts OAuth, redirects to ClickUp
     GET  /auth/callback  exchanges the code, sets the du_token cookie, redirects
                          back with #auth=<base64url> in the fragment
     GET  /auth/me        200 {user} when signed in, non-200 when not
     POST /auth/logout    clears the cookie

   Two deliberate differences from the equivalent code in public/index.html:

   1. index.html short-circuits on localStorage and only calls /auth/me when
      localStorage is empty (its line ~3029). That means a user whose ClickUp
      token was revoked stays "signed in" client-side forever. Here localStorage
      is used for the instant first paint, but /auth/me is ALWAYS verified in the
      background and the session is cleared if it comes back non-200.

   2. index.html has no 401 handling: a revoked token produces a generic toast
      and the gate never returns. Here every call goes through PortalAuth.fetch(),
      which treats 401/403 as "signed out", clears the session and notifies
      subscribers so the Tasks view can re-render into the gate.

   Exposes window.PortalAuth. No dependencies, no build step.
   =========================================================================== */
(function () {
  'use strict';

  var TOKEN_KEY = 'du_auth_token';
  var USER_KEY  = 'du_auth_user';

  var user = null;          // {id, username, email, color, profilePicture} or null
  var verified = false;     // has /auth/me confirmed this session at least once
  var subscribers = [];
  var verifyInflight = null;

  /* ---- storage -------------------------------------------------------- */

  function readStored(key) {
    try { return localStorage.getItem(key); } catch (e) { return null; }
  }
  function writeStored(key, val) {
    try { if (val == null) localStorage.removeItem(key); else localStorage.setItem(key, val); }
    catch (e) { /* private mode; auth still works for this page load */ }
  }
  function storedUser() {
    var raw = readStored(USER_KEY);
    if (!raw) return null;
    try { var u = JSON.parse(raw); return (u && u.id) ? u : null; } catch (e) { return null; }
  }
  function clearSession() {
    user = null;
    verified = false;
    writeStored(TOKEN_KEY, null);
    writeStored(USER_KEY, null);
  }

  /* ---- OAuth fragment capture ----------------------------------------- */

  /* After /auth/callback we land back here with #auth=<base64url payload>.
     Decode it, persist it, then strip the fragment so the token is not left
     sitting in the address bar or in the browser history. Runs synchronously
     before anything else reads auth state. */
  function captureAuthFromUrl() {
    var hash = location.hash || '';
    if (hash.indexOf('auth=') === -1) return false;
    try {
      var params = new URLSearchParams(hash.replace(/^#/, ''));
      var payload = params.get('auth');
      if (!payload) return false;
      var json = atob(payload.replace(/-/g, '+').replace(/_/g, '/'));
      var decoded = JSON.parse(json);
      if (decoded && decoded.token) {
        writeStored(TOKEN_KEY, decoded.token);
        writeStored(USER_KEY, JSON.stringify(decoded.user || {}));
        user = (decoded.user && decoded.user.id) ? decoded.user : null;
      }
      params.delete('auth');
      var rest = params.toString();
      history.replaceState(null, '', location.pathname + location.search + (rest ? '#' + rest : ''));
      return true;
    } catch (e) {
      console.error('portal-auth: could not read the auth fragment', e);
      return false;
    }
  }

  /* ---- verification ---------------------------------------------------- */

  /* Always ask the server, even when localStorage looks fine. A token revoked
     in ClickUp is invisible from the client otherwise. */
  function verify() {
    if (verifyInflight) return verifyInflight;
    verifyInflight = fetch('/auth/me', { credentials: 'include', headers: headers() })
      .then(function (res) {
        if (!res.ok) throw new Error('not signed in');
        return res.json();
      })
      .then(function (data) {
        var next = (data && data.user && data.user.id) ? data.user : null;
        var changed = !!next !== !!user || (next && user && next.id !== user.id);
        user = next;
        verified = true;
        if (next) writeStored(USER_KEY, JSON.stringify(next));
        else clearSession();
        if (changed) notify();
        return user;
      })
      .catch(function () {
        var had = !!user;
        clearSession();
        if (had) notify();
        return null;
      })
      .then(function (u) { verifyInflight = null; return u; });
    return verifyInflight;
  }

  function notify() {
    subscribers.slice().forEach(function (fn) {
      try { fn(user); } catch (e) { console.error('portal-auth subscriber threw', e); }
    });
  }

  /* ---- public surface --------------------------------------------------- */

  function headers() {
    var token = readStored(TOKEN_KEY);
    if (!token) return {};
    var h = { 'X-ClickUp-Token': token };
    var u = storedUser();
    if (u) h['X-ClickUp-User'] = encodeURIComponent(JSON.stringify(u));
    return h;
  }

  /* Where /auth/callback should drop the user back.

     It cannot carry a fragment: the server appends #auth=<token> to whatever it
     is handed, and a second '#' would swallow the token. The portal keeps the
     screen you are on in the fragment, so it moves into ?v= here and portal.html
     reads it back after the round trip. Without this, signing in from Property
     Tasks returns you to Overview. */
  function defaultReturnPath() {
    try {
      var frag = (location.hash || '').replace(/^#/, '');
      var qs = new URLSearchParams(location.search);
      qs.delete('v');
      if (frag) qs.set('v', frag);
      var q = qs.toString();
      return location.pathname + (q ? '?' + q : '');
    } catch (e) {
      return location.pathname;
    }
  }

  function signInUrl(returnPath) {
    var dest = returnPath || defaultReturnPath();
    /* Same-origin absolute path only. The server validates this again before
       redirecting to it - an unvalidated return path here would be an open
       redirect. Belt and braces. */
    if (typeof dest !== 'string' || dest.charAt(0) !== '/' || dest.indexOf('//') === 0 || dest.indexOf(':') !== -1) {
      dest = '/';
    }
    return '/auth/clickup?state=' + encodeURIComponent(dest);
  }

  function signOut() {
    return fetch('/auth/logout', { method: 'POST', credentials: 'include', headers: headers() })
      .catch(function () { /* clearing locally is what matters */ })
      .then(function () { clearSession(); notify(); });
  }

  /* Every ClickUp-backed call goes through here. A 401 or 403 means the session
     is gone, so clear it and let subscribers put the gate back up. Callers still
     get the response and can show their own error. */
  function authedFetch(url, opts) {
    opts = opts || {};
    var merged = {};
    for (var k in opts) if (Object.prototype.hasOwnProperty.call(opts, k)) merged[k] = opts[k];
    merged.credentials = 'include';
    merged.headers = Object.assign({}, opts.headers || {}, headers());
    return fetch(url, merged).then(function (res) {
      if (res.status === 401 || res.status === 403) {
        var had = !!user;
        clearSession();
        if (had) notify();
      }
      return res;
    });
  }

  /* Gate markup. Rendered inside the Tasks content area, not as an overlay, so
     the sidebar, header and theme toggle stay usable. Colour comes entirely from
     tokens.css. */
  function gateHtml(opts) {
    opts = opts || {};
    var title = opts.title || 'Sign in to ClickUp';
    var body = opts.body || 'Tasks are read from and written back to ClickUp. Signing in means every change you make here is attributed to you in ClickUp, not to a shared account.';
    var note = opts.note || '';
    return '' +
      '<div class="pa-gate">' +
        '<div class="pa-gate-card">' +
          '<div class="pa-gate-mark" aria-hidden="true">' +
            '<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">' +
              '<path d="M3 15.5 12 8l9 7.5"/><path d="M3 9.5 12 2l9 7.5"/>' +
            '</svg>' +
          '</div>' +
          '<div class="pa-gate-title">' + esc(title) + '</div>' +
          '<div class="pa-gate-body">' + esc(body) + '</div>' +
          '<a class="pa-gate-btn" href="' + esc(signInUrl()) + '">Sign in with ClickUp</a>' +
          (note ? '<div class="pa-gate-note">' + esc(note) + '</div>' : '') +
          '<div class="pa-gate-err" id="paGateErr" hidden></div>' +
        '</div>' +
      '</div>';
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function injectStyles() {
    if (document.getElementById('pa-styles')) return;
    var css = '' +
      '.pa-gate{display:flex;align-items:flex-start;justify-content:center;padding:48px 16px}' +
      '.pa-gate-card{max-width:460px;width:100%;text-align:center;background:var(--surface);' +
        'border:1px solid var(--border);border-radius:var(--radius,11px);padding:34px 30px}' +
      '.pa-gate-mark{width:46px;height:46px;margin:0 auto 16px;border-radius:12px;display:grid;' +
        'place-items:center;background:var(--accent-soft,var(--surface-2));color:var(--accent)}' +
      '.pa-gate-title{font-size:16px;font-weight:650;color:var(--text);margin-bottom:8px}' +
      '.pa-gate-body{font-size:13px;line-height:1.55;color:var(--text2);margin-bottom:20px}' +
      '.pa-gate-btn{display:inline-block;padding:9px 20px;border-radius:8px;background:var(--accent);' +
        'color:#fff;font-size:13.5px;font-weight:600;text-decoration:none;border:1px solid transparent}' +
      '.pa-gate-btn:hover{filter:brightness(1.07)}' +
      '.pa-gate-btn:focus-visible{outline:2px solid var(--focus,var(--accent));outline-offset:2px}' +
      '.pa-gate-note{margin-top:14px;font-size:11.5px;color:var(--text3)}' +
      '.pa-gate-err{margin-top:14px;font-size:12.5px;color:var(--crit-ink,var(--red))}';
    var el = document.createElement('style');
    el.id = 'pa-styles';
    el.textContent = css;
    document.head.appendChild(el);
  }

  var initialised = false;
  function init() {
    if (initialised) return Promise.resolve(user);
    initialised = true;
    injectStyles();
    captureAuthFromUrl();
    user = storedUser();          /* optimistic, for instant paint */
    return verify();              /* then confirm, and correct if wrong */
  }

  window.PortalAuth = {
    init: init,
    verify: verify,
    user: function () { return user; },
    isSignedIn: function () { return !!user; },
    isVerified: function () { return verified; },
    headers: headers,
    fetch: authedFetch,
    signInUrl: signInUrl,
    signOut: signOut,
    gateHtml: gateHtml,
    onChange: function (fn) {
      subscribers.push(fn);
      return function () { subscribers = subscribers.filter(function (f) { return f !== fn; }); };
    },
  };

  /* Capture the fragment as early as possible so the token never survives a
     render. Full init is driven by portal.html. */
  captureAuthFromUrl();
})();
