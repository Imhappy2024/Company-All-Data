// ===========================================================================
// tools/mockup-reference.js — the approved mockup, loaded as a reference.
//
// docs/mockup/properties-mockup.dc.html is the design AND the reference
// implementation (docs/PROPERTIES_SPEC.md). Its Component class carries the
// snapshot data every screen was drawn from (liveProps, monthlyAll, capexData,
// rentRolls ...) and every calculation. This loads that class in Node, with a
// stub for the framework base class, so tests can compare what the live
// endpoints return against what the mockup shows, number for number.
//
// Nothing here runs in production.
// ===========================================================================
'use strict';
const fs = require('fs');
const path = require('path');

function load(palette) {
  const html = fs.readFileSync(path.join(__dirname, '..', 'docs', 'mockup', 'properties-mockup.dc.html'), 'utf8');
  const m = /<script type="text\/x-dc"[^>]*>([\s\S]*?)<\/script>/.exec(html);
  if (!m) throw new Error('mockup script block not found');
  class DCLogic { constructor(props) { this.props = props || {}; this.state = {}; } setState(p) { Object.assign(this.state, typeof p === 'function' ? p(this.state) : p); } }
  // eslint-disable-next-line no-new-func
  const Component = new Function('DCLogic', m[1] + '\nreturn Component;')(DCLogic);
  return new Component({ palette: palette || 'graphite' });
}

module.exports = { load };
