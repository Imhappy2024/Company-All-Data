/* ===========================================================================
   portal-sw-cleanup.js - remove any service worker, on every surface.

   THIS ORIGIN HAS NO SERVICE WORKER, and is not supposed to have one. There is no
   sw.js in public/ and nothing registers one. What exists is a STALE REGISTRATION
   from an older build, whose sw.js served /index.html for every navigation - so a
   worker installed months ago can still control the origin, hijack navigations and
   serve cached /api responses. Service workers survive a hard refresh, which is why
   a fix can be deployed, verified live, and still not be what the browser is running.

   manifest.json stays: it drives the install prompt and the icons, and a manifest on
   its own never creates a worker.

   This used to live inline in index.html, which meant it only ran when somebody
   opened /ops. Anyone who only ever visits the portal at "/" - which is most people -
   was never healed. It is a shared file now, loaded by both surfaces.

   It also clears Cache Storage. A worker's caches outlive the worker: unregistering
   stops it controlling pages but leaves everything it stored, and a later
   registration - or the browser's own bookkeeping - can still serve from it. There is
   nothing legitimate in Cache Storage on this origin, so emptying it is safe.

   Removing this file is only correct once no stale registration can be in the wild.
   Since we cannot see other people's browsers, that is not a date anyone can name.
   =========================================================================== */
(function () {
  'use strict';

  var result = { workers: 0, caches: 0, reloaded: false };

  function clearCaches() {
    if (!window.caches || !caches.keys) return Promise.resolve();
    return caches.keys().then(function (keys) {
      result.caches = keys.length;
      return Promise.all(keys.map(function (k) { return caches.delete(k); }));
    }).catch(function () { /* best effort */ });
  }

  function run() {
    if (!('serviceWorker' in navigator)) return clearCaches();
    return navigator.serviceWorker.getRegistrations().then(function (regs) {
      result.workers = regs.length;
      return Promise.all(regs.map(function (r) { return r.unregister(); }));
    }).then(clearCaches).then(function () {
      /* If a worker was actually CONTROLLING this page, everything already
         rendered may have come from its cache - including the scripts running
         right now. Unregistering does not evict what it already served, so reload
         once to get the real thing. Guarded by a session flag: without it, a
         controller that somehow persists would put the page in a reload loop,
         which is worse than a stale asset. */
      if (result.workers && navigator.serviceWorker.controller) {
        try {
          if (!sessionStorage.getItem('lw-sw-cleaned')) {
            sessionStorage.setItem('lw-sw-cleaned', '1');
            result.reloaded = true;
            location.reload();
          }
        } catch (e) { /* storage blocked: skip the reload rather than loop */ }
      }
      if (result.workers || result.caches) {
        console.warn('[sw-cleanup] removed', result.workers, 'service worker(s) and',
                     result.caches, 'cache(s). A stale worker was controlling this origin.');
      }
      return result;
    }).catch(function () { return result; });
  }

  /* Runs immediately rather than on load: the sooner a controlling worker is gone,
     the fewer requests it answers from cache. */
  window.__swCleanup = run();
})();
