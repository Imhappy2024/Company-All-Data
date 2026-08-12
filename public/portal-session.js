/* ===========================================================================
   portal-session.js - the Supabase SESSION layer for the portal.

   NOT to be confused with portal-auth.js, which is the ClickUp OAuth layer and
   gates only the Tasks screens. Two different identities:
     portal-auth.js  -> ClickUp token (du_token cookie + localStorage mirror)
     portal-session.js -> Supabase Auth session, i.e. who is signed in to the
                          dashboard at all
   Logging out has to clear both. See PortalSession.signOut().

   Used by public/login.html and public/portal.html, so the remember-device rules
   cannot drift between the page that sets them and the page that enforces them.

   Exposes window.PortalSession.
   =========================================================================== */
(function () {
  'use strict';

  /* Remember this device for 30 days.

     This is NOT a Supabase setting. supabase-js persists to localStorage and
     refreshes indefinitely, so "for 30 days" has to be built:
       checked   -> localStorage,   survives a browser restart
       unchecked -> sessionStorage, gone when the browser closes
     plus a stamp that is checked on every boot. Past the stamp we tear the session
     down, because Supabase would otherwise keep refreshing it forever.

     The storage choice is made at CLIENT CONSTRUCTION and cannot be changed after,
     which is why the stamp (in localStorage, outside either store) is what decides
     which store to construct with. */
  var REMEMBER_KEY = 'lw-remember-until';
  var REMEMBER_MS = 30 * 86400000;

  /* An explicit storageKey rather than supabase-js's derived `sb-<ref>-auth-token`.
     Teardown has to be able to purge the session deterministically from BOTH
     stores, and guessing an internal key name is fragile. */
  var STORAGE_KEY = 'lw-session';

  var configPromise = null;
  var client = null;
  var accessPromise = null;

  function ls() { try { return window.localStorage; } catch (e) { return null; } }
  function ss() { try { return window.sessionStorage; } catch (e) { return null; } }

  function rememberUntil() {
    var s = ls(); if (!s) return 0;
    var v = parseInt(s.getItem(REMEMBER_KEY) || '0', 10);
    return isFinite(v) ? v : 0;
  }
  function isRemembered() { return rememberUntil() > 0; }

  function setRemembered(on) {
    var s = ls(); if (!s) return;
    if (on) s.setItem(REMEMBER_KEY, String(Date.now() + REMEMBER_MS));
    else s.removeItem(REMEMBER_KEY);
  }

  /* Belt and braces to signOut(): remove the session from both stores by our own
     key, so nothing is left behind if signOut() fails or the storage we are not
     currently using still holds an older session. */
  function purgeStoredSession() {
    [ls(), ss()].forEach(function (s) {
      if (!s) return;
      try { s.removeItem(STORAGE_KEY); } catch (e) { /* ignore */ }
    });
  }

  /* GET /api/portal-config. 503s while the env vars are unset, and says which -
     serving `undefined` would surface later as an unreadable supabase-js error. */
  function config() {
    if (configPromise) return configPromise;
    configPromise = fetch('/api/portal-config', { headers: { Accept: 'application/json' } })
      .then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (body) {
          if (!r.ok) {
            var e = new Error(body.error || ('Supabase config unavailable (HTTP ' + r.status + ')'));
            e.missing = body.missing || [];
            e.status = r.status;
            throw e;
          }
          return body;
        });
      });
    return configPromise;
  }

  function waitForSupabaseLib(tries) {
    tries = tries == null ? 60 : tries;
    if (window.supabase && window.supabase.createClient) return Promise.resolve(true);
    if (tries <= 0) return Promise.reject(new Error('The Supabase library did not load.'));
    return new Promise(function (r) { setTimeout(r, 50); })
      .then(function () { return waitForSupabaseLib(tries - 1); });
  }

  /* One client per page load. Storage is chosen from the stamp, so a signed-in
     "remembered" session is found in localStorage and an unremembered one only for
     as long as the tab lives. */
  function getClient() {
    if (client) return Promise.resolve(client);
    return Promise.all([config(), waitForSupabaseLib()]).then(function (out) {
      var cfg = out[0];
      client = window.supabase.createClient(cfg.url, cfg.anonKey, {
        auth: {
          storage: isRemembered() ? ls() : ss(),
          storageKey: STORAGE_KEY,
          persistSession: true,
          autoRefreshToken: true,
          detectSessionInUrl: false,   // only invite.html consumes a URL fragment
        },
      });
      return client;
    });
  }

  /* Runs before anything else on every boot. If the stamp has passed, the session
     is torn down and the caller is told it is gone. Supabase refreshes forever, so
     without this "30 days" would mean "until you clear your browser". */
  function enforceRememberWindow() {
    var until = rememberUntil();
    if (!until || until > Date.now()) return Promise.resolve(false);
    return signOut().then(function () { return true; }, function () { return true; });
  }

  function getSession() {
    return getClient()
      .then(function (c) { return c.auth.getSession(); })
      .then(function (r) { return (r && r.data && r.data.session) || null; })
      .catch(function () { return null; });
  }

  function signIn(email, password, remember) {
    /* Set the stamp BEFORE constructing the client: the storage choice is fixed at
       construction, so deciding afterwards would put the session in the wrong store
       and "remember me" would silently not survive a restart. */
    setRemembered(!!remember);
    client = null;
    return getClient().then(function (c) {
      return c.auth.signInWithPassword({ email: email, password: password });
    }).then(function (r) {
      if (r.error) {
        /* Failed sign-in must not leave a stamp promising 30 days. */
        setRemembered(false);
        client = null;
        throw r.error;
      }
      return r.data;
    });
  }

  function sendReset(email, redirectPath) {
    return getClient().then(function (c) {
      return c.auth.resetPasswordForEmail(email, {
        redirectTo: window.location.origin + (redirectPath || '/invite?mode=reset'),
      });
    });
  }

  /* Order matters and is the reason this is one function.
     1. the stamp first: if signOut() throws or the tab closes mid-call, a stale
        stamp is worse than a stale session, because it keeps the NEXT visitor
        "remembered" and pointed at localStorage.
     2. the Supabase session.
     3. the ClickUp session. PortalAuth owns du_token plus its localStorage mirror;
        leaving it means the next person on a shared machine inherits it even though
        the dashboard logged out. */
  function signOut() {
    setRemembered(false);
    var step2 = client
      ? Promise.resolve(client).then(function (c) { return c.auth.signOut(); })
      : getClient().then(function (c) { return c.auth.signOut(); });
    return step2.catch(function () { /* best effort */ })
      .then(function () {
        purgeStoredSession();
        client = null;
        accessPromise = null;
        if (window.PortalAuth && window.PortalAuth.signOut) {
          try { return window.PortalAuth.signOut(); } catch (e) { /* ignore */ }
        }
      })
      .catch(function () { /* never reject: callers redirect regardless */ });
  }

  /* dash_my_access() - ONE call at boot, held for the page's lifetime. This is the
     frontend contract: { user, companies, access }, access keyed by nav_id, an
     absent key meaning no access. Never call dash_level() per module. */
  function access(force) {
    if (accessPromise && !force) return accessPromise;
    accessPromise = getClient()
      .then(function (c) { return c.rpc('dash_my_access'); })
      .then(function (r) {
        if (r.error) throw r.error;
        return r.data || null;
      });
    return accessPromise;
  }

  window.PortalSession = {
    config: config,
    client: getClient,
    getSession: getSession,
    signIn: signIn,
    sendReset: sendReset,
    signOut: signOut,
    access: access,
    enforceRememberWindow: enforceRememberWindow,
    isRemembered: isRemembered,
    rememberUntil: rememberUntil,
    /* exposed for the tests and for console debugging */
    _keys: { remember: REMEMBER_KEY, storage: STORAGE_KEY, windowMs: REMEMBER_MS },
  };
})();
