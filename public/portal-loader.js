/* ===========================================================================
   portal-loader.js — one loading component for the whole dashboard.

   PortalLoader.full(name)    centred 88px mark with "Loading <name>" under it:
                              a section, page or tab whose data is not loaded
                              yet. Goes in the content area only.
   PortalLoader.small(label)  20px mark for refreshing one table, panel or card
                              set; put it beside that panel's title and keep the
                              old content visible inside PortalLoader.stale().
   PortalLoader.stale(html)   the old content, dimmed, while the new arrives.
   PortalLoader.settle(t0, fn)
                              call fn when a load that started at t0 finishes:
                              at once if the mark never became visible (under
                              250ms), otherwise once it has been up for 400ms,
                              so it never blinks.

   Markup and motion: docs/mockup/loader.dc.html, styles in portal-loader.css.
   =========================================================================== */
(function () {
  'use strict';

  var SHOW_AFTER = 250, MIN_SHOWN = 400;

  function esc(s) {
    return String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* the six rects in their rotated group, exactly as loader.dc.html */
  function mark(size, label) {
    var a11y = label ? ' role="img" aria-label="' + esc(label) + '"' : ' aria-hidden="true"';
    return '<svg class="lw-mark" width="' + size + '" height="' + size + '" viewBox="0 0 1024 1024"' + a11y + '>' +
      '<g transform="rotate(45 512 512) translate(-20 4)">' +
      '<rect class="bar b1 ld-c1" x="300" y="282" width="344" height="92" rx="16"></rect>' +
      '<rect class="bar b2 ld-c2" x="300" y="402" width="150" height="92" rx="16"></rect>' +
      '<rect class="bar b3 ld-c1" x="478" y="402" width="166" height="92" rx="16"></rect>' +
      '<rect class="bar b4 ld-c1" x="300" y="522" width="344" height="92" rx="16"></rect>' +
      '<rect class="bar b5 ld-c3" x="300" y="642" width="464" height="92" rx="16"></rect>' +
      '<rect class="bar b6 ld-c3" x="672" y="282" width="92" height="332" rx="16"></rect>' +
      '</g></svg>';
  }

  function full(name) {
    var what = name ? 'Loading ' + name : 'Loading';
    return '<div class="ld-full" role="status" aria-live="polite" aria-busy="true" data-k="ld-full">' +
      '<div class="ld-fade ld-col">' + mark(88, 'Loading') +
      '<div class="ld-text"><span class="ld-dots">' + esc(what) + '</span></div></div></div>';
  }

  function small(label) {
    return '<span class="ld-small ld-fade" role="status" aria-live="polite" data-k="ld-small">' +
      mark(20, label || 'Refreshing') + (label ? '<span>' + esc(label) + '</span>' : '') + '</span>';
  }

  function stale(html) { return '<div class="ld-stale" aria-busy="true">' + html + '</div>'; }

  function now() { return (window.performance && performance.now) ? performance.now() : Date.now(); }
  function settle(t0, fn) {
    var el = now() - t0;
    var wait = el < SHOW_AFTER ? 0 : Math.max(0, SHOW_AFTER + MIN_SHOWN - el);
    if (wait) setTimeout(fn, wait); else fn();
  }

  /* hold(promise): the same promise, settled no sooner than settle() allows
     from the moment it was handed over. Wrap a fetch in it and a loader shown
     for that fetch never blinks, success or failure. */
  function hold(p) {
    var t0 = now();
    return Promise.resolve(p).then(function (v) {
      return new Promise(function (res) { settle(t0, function () { res(v); }); });
    }, function (e) {
      return new Promise(function (res, rej) { settle(t0, function () { rej(e); }); });
    });
  }

  window.PortalLoader = { mark: mark, full: full, small: small, stale: stale, settle: settle, hold: hold, now: now,
                          SHOW_AFTER: SHOW_AFTER, MIN_SHOWN: MIN_SHOWN };
})();
