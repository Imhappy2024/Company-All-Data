/* Extract the Leads screen's CSS from command-center, and scope it.

   The class names are matched against the transplanted source rather than
   parsed out of it: the JS builds most of its markup by string concatenation
   ('<div class="ld' + kind + 'row">'), so any regex over class="..." misses
   them. A rule is kept when a class in its selector appears as a word anywhere
   in the Leads HTML or JS. That over-includes a little, which is the safe
   direction here.

   Every rule is then prefixed with #ghlNative. command-center owns .card, .btn,
   .empty, .thread and .view at the top level and so does the portal; dropping
   these in unscoped would restyle the whole app. Scoping by the container id
   keeps the look exact without renaming sixty classes across 1,500 lines. */

const fs = require('fs');
const path = require('path');

/* The exact slices lifted out of command-center, kept beside this script so
   the port is reproducible without re-cloning that repo. */
const SRC = process.env.CC_LEADS || path.join(__dirname, 'ghl-source');
/* The CSS extractor still needs command-center's whole index.html. Clone it
   and point CC_ANALYZE at the checkout to regenerate the stylesheet. */
const CC = process.env.CC_ANALYZE || path.join(__dirname, 'cc-analyze');

const page = fs.readFileSync(path.join(CC, 'public', 'index.html'), 'utf8');
const source = fs.readFileSync(path.join(SRC, 'ld.html.txt'), 'utf8')
             + fs.readFileSync(path.join(SRC, 'p2-leads.txt'), 'utf8')
             + fs.readFileSync(path.join(SRC, 'p1-helpers.txt'), 'utf8');

/* All <style> content. */
let css = '';
for (const m of page.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)) css += m[1] + '\n';

/* Strip comments so a class named in a comment cannot pull in a rule. */
css = css.replace(/\/\*[\s\S]*?\*\//g, '');

/* Split into top-level rules, keeping @media blocks whole. */
const rules = [];
let depth = 0, start = 0;
for (let i = 0; i < css.length; i++) {
  const c = css[i];
  if (c === '{') depth++;
  else if (c === '}') {
    depth--;
    if (depth === 0) { rules.push(css.slice(start, i + 1).trim()); start = i + 1; }
  }
}

const used = new Set();
for (const m of source.matchAll(/[a-zA-Z][\w-]*/g)) used.add(m[0]);

/* Keyframes the kept rules reference. */
const keyframes = new Map();
for (const r of rules) {
  const m = /^@keyframes\s+([\w-]+)/.exec(r);
  if (m) keyframes.set(m[1], r);
}

function selectorClasses(sel) {
  return [...sel.matchAll(/\.([a-zA-Z][\w-]*)/g)].map(m => m[1]);
}

function wanted(rule) {
  if (/^@keyframes/.test(rule)) return false;         /* pulled in on demand */
  if (/^@(font-face|import|charset)/.test(rule)) return false;
  const sel = rule.slice(0, rule.indexOf('{'));
  const classes = selectorClasses(sel);
  if (!classes.length) return false;                   /* bare element rules stay out */
  return classes.some(c => used.has(c));
}

const kept = [];
for (const rule of rules) {
  if (/^@media/.test(rule)) {
    /* Keep a media block if any inner rule is wanted, and keep only those. */
    const open = rule.indexOf('{');
    const head = rule.slice(0, open + 1);
    const body = rule.slice(open + 1, rule.lastIndexOf('}'));
    const inner = [];
    let d = 0, s = 0;
    for (let i = 0; i < body.length; i++) {
      if (body[i] === '{') d++;
      else if (body[i] === '}') { d--; if (d === 0) { inner.push(body.slice(s, i + 1).trim()); s = i + 1; } }
    }
    const keepInner = inner.filter(wanted);
    if (keepInner.length) kept.push({ media: head, rules: keepInner });
    continue;
  }
  if (wanted(rule)) kept.push({ media: null, rules: [rule] });
}

/* Which keyframes survived. */
const animNames = new Set();
for (const k of kept) for (const r of k.rules) {
  for (const m of r.matchAll(/animation(?:-name)?\s*:\s*([^;]+)/g)) {
    for (const w of m[1].split(/[\s,]+/)) if (keyframes.has(w)) animNames.add(w);
  }
}

const SCOPE = '#ghlNative';

function scope(rule) {
  const open = rule.indexOf('{');
  const sel = rule.slice(0, open).trim();
  const body = rule.slice(open);
  const scoped = sel.split(',').map(s => {
    s = s.trim();
    if (!s) return s;
    /* :root and html/body level selectors would escape the container. */
    if (/^(:root|html|body)\b/.test(s)) return SCOPE + ' ' + s.replace(/^(:root|html|body)\b/, '').trim();
    return SCOPE + ' ' + s;
  }).filter(Boolean).join(',\n');
  return scoped + ' ' + body;
}

let out = `/* ===========================================================================
   Leads (GHL) — command-center's own stylesheet for this screen.

   Extracted by .build-ghl-css.cjs rather than rewritten, for the same reason
   the JS was transplanted: a hand-made approximation of a layout is not that
   layout. ${kept.reduce((n, k) => n + k.rules.length, 0)} rules.

   EVERY SELECTOR IS SCOPED UNDER #ghlNative. command-center styles .card,
   .btn, .empty, .thread and .view at the top level, and so does the portal —
   dropping these in unscoped would restyle the whole application. The
   container id keeps the look byte-identical without renaming sixty classes
   across 1,500 lines of transplanted JS.

   command-center's colour names (--brass --cream --jade --rust --panel2/3
   --edge/2 --ink2 --dim/dimmer --ff-mono) are mapped onto tokens.css at the
   top of portal-properties.css, which loads first. Nothing here needs a second
   shim.

   Regenerate: node .build-ghl-css.cjs
   =========================================================================== */

`;

for (const k of kept) {
  if (k.media) {
    out += k.media + '\n' + k.rules.map(r => '  ' + scope(r)).join('\n') + '\n}\n';
  } else {
    out += scope(k.rules[0]) + '\n';
  }
}

for (const name of animNames) out += '\n' + keyframes.get(name) + '\n';

fs.writeFileSync(path.join(__dirname, '..', 'public', 'portal-ghl.css'), out);
console.log('wrote public/portal-ghl.css  (' +
  kept.reduce((n, k) => n + k.rules.length, 0) + ' rules, ' +
  animNames.size + ' keyframes, ' + out.split('\n').length + ' lines)');
