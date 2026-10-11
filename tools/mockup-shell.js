/* Render docs/mockup/shell.dc.html in a browser and screenshot four states, for
   the shell rebuild's side-by-side comparison.

   node tools/mockup-shell.js [--out docs/screenshots/shell] [--theme dark|light]

   The mockup is a DC component (template + a logic class) whose runtime
   (support.js) is not in this repo. This file is a minimal stand-in for it:
   {{expr}} interpolation, <sc-for list as>, <sc-if value>, and the class's
   renderVals(). Event handlers are not wired; each state is set directly. */
'use strict';
const fs = require('fs');
const path = require('path');
const { chromium } = require(path.join(__dirname, '..', 'node_modules', 'playwright'));
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const OUT = path.resolve(arg('out', path.join(__dirname, '..', 'docs', 'screenshots', 'shell')));
const LIGHT = arg('theme', 'dark') === 'light';
const SRC = fs.readFileSync(path.join(__dirname, '..', 'docs', 'mockup', 'shell.dc.html'), 'utf8');
const helmet = /<helmet>([\s\S]*?)<\/helmet>/.exec(SRC)[1];
/* <sc-for>/<sc-if> become <template>s: the HTML parser hoists any other element
   out of a <tbody>, which would empty every table in the mockup. */
const tpl = /<\/helmet>([\s\S]*?)<\/x-dc>/.exec(SRC)[1]
  .replace(/<sc-(for|if)\b/g, '<template data-sc="$1"').replace(/<\/sc-(for|if)>/g, '</template>');
const logic = /<script type="text\/x-dc"[^>]*>([\s\S]*?)<\/script>/.exec(SRC)[1];

const RUNTIME = `
class DCLogic { constructor(p) { this.props = p || {}; } setState(o) { Object.assign(this.state, o); } }
${logic}
const ev = (e, sc) => { try { return new Function('sc', 'with (sc) { return (' + e + '); }')(sc); } catch (x) { return ''; } };
const interp = (s, sc) => s.replace(/\\{\\{([\\s\\S]*?)\\}\\}/g, (_, e) => { const v = ev(e, sc); return v == null ? '' : String(v); });
function render(node, sc, out) {
  if (node.nodeType === 3) { out.appendChild(document.createTextNode(interp(node.nodeValue, sc))); return; }
  if (node.nodeType !== 1) return;
  const tag = node.getAttribute('data-sc') || node.localName;
  const kids = node.localName === 'template' ? node.content.childNodes : node.childNodes;
  if (tag === 'for') {
    const list = ev(/^\\{\\{([\\s\\S]*)\\}\\}$/.exec(node.getAttribute('list'))[1], sc) || [];
    const as = node.getAttribute('as');
    list.forEach(item => kids.forEach(c => render(c, Object.assign({}, sc, { [as]: item }), out)));
    return;
  }
  if (tag === 'if') {
    if (ev(/^\\{\\{([\\s\\S]*)\\}\\}$/.exec(node.getAttribute('value'))[1], sc)) kids.forEach(c => render(c, sc, out));
    return;
  }
  const el = document.createElementNS(node.namespaceURI, node.localName);
  for (const a of node.attributes) {
    if (/^on/i.test(a.name) || /^hint-/.test(a.name) || a.name === 'data-sc') continue;
    el.setAttribute(a.name, interp(a.value, sc));
  }
  node.childNodes.forEach(c => render(c, sc, el));
  out.appendChild(el);
}
window.__show = function (state, light) {
  const c = new Component({ light });
  Object.assign(c.state, state);
  const vals = c.renderVals();
  const t = document.getElementById('tpl');
  const host = document.getElementById('host');
  host.innerHTML = '';
  t.content.childNodes.forEach(n => render(n, vals, host));
};`;

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const b = await chromium.launch();
  const pg = await b.newPage({ viewport: { width: 1440, height: 900 } });
  await pg.setContent(`<!doctype html><html><head><meta charset="utf-8">${helmet}</head><body><template id="tpl">${tpl}</template><div id="host"></div><script>${RUNTIME}</script></body></html>`, { waitUntil: 'networkidle' });
  const STATES = [
    ['home-mine', { home: true, homeView: 'mine' }],
    ['home-all', { home: true, homeView: 'all' }],
    ['lw-team', { home: false, biz: 0, page: { 0: 'team', 1: 'team', 2: 'team', 3: 'team' } }],
    ['folio-team', { home: false, biz: 1, page: { 0: 'team', 1: 'team', 2: 'team', 3: 'team' } }],
  ];
  for (const [name, st] of STATES) {
    await pg.evaluate(([s, l]) => window.__show(s, l), [st, LIGHT]);
    await pg.waitForTimeout(300);
    await pg.screenshot({ path: path.join(OUT, 'mockup-' + name + '.png') });
    console.log('mockup-' + name);
  }
  await b.close();
})().catch(e => { console.error(e); process.exit(1); });
