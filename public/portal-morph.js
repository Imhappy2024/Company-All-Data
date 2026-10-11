/* ===========================================================================
   portal-morph.js — update a subtree in place from new HTML.

   The portal's screens are written as "state -> HTML string". Assigning that
   string to innerHTML on every interaction rebuilt the whole section: every
   node was new, so entry animations replayed, scroll positions reset, the
   focused input lost its caret, and the browser re-laid out and repainted the
   page. That is the flicker.

   PortalMorph.morph(host, html) parses the new HTML and walks it against the
   live DOM, changing only what differs: an attribute, a text node, a row
   added or removed. Untouched nodes are the SAME nodes, so nothing animates,
   scrolls or blurs unless it actually changed.

   Identity: two elements match when they have the same tag and the same
   `data-k`. Give a container a data-k that names what it shows (a page, a
   tab) and switching to something else replaces it outright - which is when
   an entry animation SHOULD run. Everything without a data-k matches by
   position.

   Form controls: a control the user is typing in keeps its live value; the
   render already holds that value in state, and writing it back would move
   the caret. Other controls take `value` / `checked` / `selected` from the
   new markup as properties, not just attributes.
   =========================================================================== */
(function () {
  'use strict';

  function key(n) { return n.nodeType === 1 ? n.getAttribute('data-k') : null; }
  function same(a, b) {
    return a.nodeType === b.nodeType && a.nodeName === b.nodeName && key(a) === key(b);
  }

  function syncAttrs(from, to) {
    var i, a;
    for (i = from.attributes.length - 1; i >= 0; i--) {
      a = from.attributes[i];
      if (!to.hasAttribute(a.name)) from.removeAttribute(a.name);
    }
    for (i = 0; i < to.attributes.length; i++) {
      a = to.attributes[i];
      if (from.getAttribute(a.name) !== a.value) from.setAttribute(a.name, a.value);
    }
  }

  function syncControl(from, to) {
    var tag = from.nodeName;
    if (tag === 'INPUT') {
      if (from.type === 'checkbox' || from.type === 'radio') from.checked = to.hasAttribute('checked');
      else if (from !== document.activeElement) {
        var v = to.getAttribute('value') || '';
        if (from.value !== v) from.value = v;
      }
    } else if (tag === 'TEXTAREA') {
      if (from !== document.activeElement && from.value !== to.value) from.value = to.value;
    } else if (tag === 'OPTION') {
      from.selected = to.hasAttribute('selected');
    }
  }

  function morphNode(from, to) {
    if (from.nodeType === 3 || from.nodeType === 8) {
      if (from.nodeValue !== to.nodeValue) from.nodeValue = to.nodeValue;
      return;
    }
    syncAttrs(from, to);
    if (from.nodeName === 'TEXTAREA') { syncControl(from, to); return; }
    morphChildren(from, to);
    syncControl(from, to);
    if (from.nodeName === 'SELECT' && from !== document.activeElement) {
      var sel = to.querySelector('option[selected]');
      var want = sel ? sel.getAttribute('value') !== null ? sel.getAttribute('value') : sel.textContent : null;
      if (want !== null && from.value !== want) from.value = want;
    }
  }

  function morphChildren(fromParent, toParent) {
    var f = fromParent.firstChild, t = toParent.firstChild, next;
    while (t) {
      var tNext = t.nextSibling;
      if (!f) { fromParent.appendChild(t); t = tNext; continue; }
      next = f.nextSibling;
      if (same(f, t)) { morphNode(f, t); f = next; }
      else if (next && same(next, t) && !(tNext && same(f, tNext))) {
        /* one old node went away (a status line dismissed): drop it, keep the rest */
        fromParent.removeChild(f); f = next; continue;
      }
      else {
        /* a keyed node further along (e.g. a tab body after an inserted
           banner) is moved up rather than rebuilt */
        var k = key(t), found = null;
        if (k !== null) {
          for (var s = next; s; s = s.nextSibling) if (key(s) === k && s.nodeName === t.nodeName) { found = s; break; }
        }
        if (found) { fromParent.insertBefore(found, f); morphNode(found, t); }
        else fromParent.insertBefore(t, f);
      }
      t = tNext;
    }
    while (f) { next = f.nextSibling; fromParent.removeChild(f); f = next; }
  }

  function morph(host, html) {
    var tpl = document.createElement('template');
    tpl.innerHTML = html;
    if (!host.firstChild) { host.appendChild(tpl.content); return; }
    morphChildren(host, tpl.content);
  }

  window.PortalMorph = { morph: morph };
})();
