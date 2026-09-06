/* ===========================================================================
   Properties — ported from command-center, running natively in the portal.

   This replaces the /ops iframe. The whole section (list, entity tree, record
   panel, inline editing) is the command-center implementation; what changed on
   the way over is only what had to:

     1. It fetches /api/portfolio, not /api/properties. This service already
        serves a DIFFERENT Properties payload at /api/properties to /ops, and
        two shapes on one path is the silent-empty-string failure CLAUDE.md
        opens with. When /ops goes, the path can shorten.

     2. escS / toast / tkRel are defined here. In command-center they are
        page-level helpers in a single 16k-line index.html; the portal is split
        across files, so this module carries its own rather than depending on
        load order it cannot see.

     3. It is wrapped in an IIFE exposing window.PortalProperties, so `PR`,
        `PD` and thirty-odd pr* functions cannot collide with portal.html's
        globals. Everything inside is otherwise untouched.

     4. mount(host) replaces the section markup and wires it. command-center
        ran its wiring at parse time against markup already in the document;
        the portal builds views on navigation, so the listeners bind when the
        view is drawn and the boot fetch is deferred to the first mount.

   The numbers keep their original guards. Apartments come from
   SUM(unit.current_total_units) and never from unit_count_reported, which
   holds only the FIRST building's count; the rollup deduplicates by property
   id, because co-ownership otherwise counts one property once per owner.
   =========================================================================== */

window.PortalProperties = (function(){
'use strict';

/* ---- helpers the host page owned in command-center ---------------------- */

const escS = s => String(s == null ? '' : s)
  .replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));

function tkRel(ms){
  if (!ms) return '\u2014';
  const mins = Math.round((Date.now() - ms) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return mins + 'm ago';
  const h = Math.round(mins / 60);
  if (h < 24) return h + 'h ago';
  return Math.round(h / 24) + 'd ago';
}

/* Self-hosting: command-center's toast writes into a #so-toasts host that only
   exists on that page. Rather than require portal.html to add one, this makes
   its own on first use. A failed save that reports nothing is worse than an
   unstyled notice. */
function toast(msg){
  let host = document.getElementById('pr-toasts');
  if (!host) {
    host = document.createElement('div');
    host.id = 'pr-toasts';
    document.body.appendChild(host);
  }
  const el = document.createElement('div');
  el.className = 'pr-toast';
  el.textContent = msg;
  host.appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity .3s, transform .3s';
    el.style.opacity = '0';
    el.style.transform = 'translateY(8px)';
    setTimeout(() => el.remove(), 320);
  }, 2600);
}

/* command-center closes an audio player before the panel on Escape. There is no
   player here, so this is the no-op that keeps the key handler verbatim. */
function agClosePlayer(){}

/* ================= PROPERTIES =================

   Two surfaces.

   The list is one table with entity bands over it. Open an entity and its
   properties unfold underneath; the band stays stuck under the header while you
   read them, because with twenty-six rows below it, scrolling used to lose which
   entity you were inside. A totals footer holds the bottom of the view so the
   figure you are comparing against never scrolls away.

   The record is a wide panel with tabs. A property here has eighty-odd fields,
   up to twenty-six buildings, its own loans, financial snapshots and messages.
   One long scroll makes you hunt; collapsing everything makes you click before
   you can look. Tabs are the honest answer, and every field in them edits in
   place.

   Field labels are not derived from column names. `dba_name` is "DBA Name /
   Name of Apartment Complex" -- what the people who maintain this data call it,
   carried over from the ClickUp fields it was migrated out of. The server sends
   the labels; see routes/property-detail.js.

   One number deserves suspicion and gets it: `unit_count_reported` holds only
   the FIRST building's count. Units come from the verified column when it is
   set, then from summing the buildings, and only then from the reported one. */

const PR = {
  loaded: false, loading: false, error: null,
  /* Distinct from PR.loaded, which a refresh resets. This one says whether the
     section has ever been open, and it is what stops a refresh or a return visit
     re-expanding a band the reader closed. */
  everLoaded: false,
  data: null,
  mode: 'portfolio',                // portfolio | debt
  q: '', own: 'held', manager: '', state: '', lender: '', loans: '',
  group: 'entity',
  sort: 'marketValue', dir: 'desc',
  open: null,                       // the one open band
  year: null                        // a bar on the maturity wall, used as a filter
};

async function prLoad(force){
  if (PR.loading) return;
  PR.loading = true; PR.error = null;
  drawProperties();
  try {
    const r = await fetch('/api/portfolio' + (force ? '?force=1' : ''));
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || ('properties ' + r.status));
    PR.data = j;
    prIndex();
    /* Open the largest root the current filter leaves standing -- on the FIRST
       load only. The default filter is Held, and the biggest root by raw value
       can easily be a shell whose properties were all sold, which would open
       onto nothing.

       Only the first, because leaving the section now closes everything and
       re-expanding a band on the way back would undo that immediately. */
    if (!PR.everLoaded) {
      const passing = new Set((PR.data.properties || []).filter(prPass).map(p => p.id));
      let best = null;
      for (const t of PR.data.tree || []) {
        let mv = 0, n = 0;
        for (const id of PR.data.subtree.get(t.id) || []) {
          if (!passing.has(id)) continue;
          const p = PR.data.byId.get(id);
          if (p) { mv += prMv(p); n++; }
        }
        if (n && (!best || mv > best.mv)) best = { id: t.id, mv };
      }
      PR.open = best ? best.id : null;
      PR.everLoaded = true;
    }
    PR.loaded = true;
  } catch (err) { PR.error = err.message; }
  PR.loading = false;
  drawProperties();
}

/* The server sends the tree with placement and roll-ups computed. What it does
   not send is the id sets, because 110 entities x 168 ids is a lot of payload
   for something derivable in a millisecond. */
function prIndex(){
  const d = PR.data;
  d.byId = new Map((d.properties || []).map(p => [p.id, p]));
  d.node = new Map();
  d.place = new Map();
  d.subtree = new Map();
  d.parentOf = new Map();
  d.nameOf = new Map((d.entities || []).map(e => [e.id, e.name]));

  const walk = (n, parent) => {
    d.node.set(n.id, n);
    d.parentOf.set(n.id, parent);
    d.place.set(n.id, n.properties || []);
    const set = new Set(n.properties || []);
    for (const c of n.children || []) {
      walk(c, n.id);
      for (const x of d.subtree.get(c.id)) set.add(x);
    }
    d.subtree.set(n.id, set);
  };
  (d.tree || []).forEach(n => walk(n, null));
}

/* ---------- formatting ---------- */

const prMoney = n => {
  const v = Math.round(Number(n) || 0);
  if (!v) return '—';
  if (Math.abs(v) >= 1e6) return '$' + (v / 1e6).toFixed(Math.abs(v) >= 1e7 ? 0 : 1) + 'M';
  if (Math.abs(v) >= 1e3) return '$' + Math.round(v / 1e3) + 'k';
  return '$' + v.toLocaleString();
};
const prFull = n => '$' + Math.round(Number(n) || 0).toLocaleString();
const prPct = n => (n == null ? '—' : (n * 100).toFixed(1) + '%');
const PR_GAP = '<span class="prnone" title="Not recorded">·</span>';

const PR_OWN_LABEL = {
  held: 'Held', sold: 'Sold', demolished: 'Demolished', not_owned: 'Not owned',
  under_contract: 'Under contract', transferred: 'Transferred', unknown: 'Unknown'
};

/* Lender thresholds, not a gradient: 70% is a conversation, 85% is a problem. */
const prLtvColour = r => r >= 0.85 ? 'var(--rust)' : r >= 0.70 ? 'var(--amber)'
  : r > 0 ? 'var(--jade)' : 'var(--dimmer)';
const prMv = p => Number(p.marketValue || 0);
const prLtv = p => (prMv(p) ? p.debt / prMv(p) : 0);
const prCap = p => (prMv(p) && p.noi ? p.noi / prMv(p) : null);
const prYear = iso => { const t = Date.parse(iso); return Number.isFinite(t) ? new Date(t).getFullYear() : null; };
const prNextMat = p => {
  const ds = p.loans.map(l => l.maturity).filter(Boolean).sort();
  return ds.length ? String(ds[0]).slice(0, 10) : null;
};

/* The unit-count trap, in one place. `unit_count_reported` holds only the first
   building's number, so it is the last resort and it says so. */
function prUnits(p){
  if (p.unitsVerified != null && p.unitsVerified !== '') {
    return { n: Number(p.unitsVerified), source: 'verified' };
  }
  if (p.apartments) return { n: Number(p.apartments), source: 'buildings' };
  if (p.unitsReported) return { n: Number(p.unitsReported), source: 'reported' };
  return { n: 0, source: null };
}

const prOwner = p => p.entityId || p.owners[0] || null;
const prEntName = id => (PR.data.nameOf.get(id) || (id ? 'Unknown entity' : 'Unassigned'));

function prPathTo(id){
  const out = [];
  for (let cur = id; cur; cur = PR.data.parentOf.get(cur)) out.unshift(cur);
  return out;
}

/* ---------- filtering ---------- */

function prPass(p){
  if (PR.own && p.ownershipStatus !== PR.own) return false;
  if (PR.manager && p.manager !== PR.manager) return false;
  if (PR.state && p.state !== PR.state) return false;
  if (PR.lender && !p.loans.some(l => l.lender === PR.lender)) return false;
  if (PR.loans === 'has' && !p.loans.length) return false;
  if (PR.loans === 'none' && p.loans.length) return false;
  if (PR.year && !p.loans.some(l => prYear(l.maturity) === PR.year)) return false;
  const q = PR.q.trim().toLowerCase();
  if (q) {
    const hay = [p.name, p.street, p.city, p.state, p.manager, p.assetType,
      ...p.owners.map(prEntName), ...p.loans.map(l => l.lender || '')].join(' ').toLowerCase();
    if (!hay.includes(q)) return false;
  }
  return true;
}
const prShown = () => (PR.data?.properties || []).filter(prPass);

/* ---------- the view ---------- */

function drawProperties(){
  const body = document.getElementById('pr-body');
  const state = document.getElementById('pr-state');
  const sub = document.getElementById('pr-sub');
  if (!body) return;

  if (state) {
    state.innerHTML = PR.loading
      ? '<span class="d" style="background:var(--brass)"></span>Reading…'
      : PR.error ? '<span class="d" style="background:var(--rust)"></span>' + escS(PR.error.slice(0, 60))
      : PR.data?.configured === false ? '<span class="d" style="background:var(--rust)"></span>No database'
      : PR.data ? '<span class="d"></span>as of ' + tkRel(Date.parse(PR.data.cachedAt))
      : '';
  }
  if (sub) {
    const t = PR.data?.totals;
    sub.textContent = PR.data?.configured === false ? 'No database connected.'
      : t ? t.properties + ' properties · ' + t.entities + ' entities · ' + t.buildings
            + ' buildings · ' + t.apartments.toLocaleString() + ' apartments'
      : 'Reading the portfolio…';
  }

  if (PR.data?.configured === false) {
    body.innerHTML = '<div class="card flush"><div class="empty"><b>No database connected</b>'
      + '<small>' + escS(PR.data.reason || '') + '</small></div></div>';
    return;
  }
  if (PR.error && !PR.loaded) {
    body.innerHTML = '<div class="card flush"><div class="empty"><b>Could not read the portfolio</b>'
      + '<small>' + escS(PR.error) + '</small></div></div>';
    return;
  }
  if (!PR.loaded) {
    body.innerHTML = '<div class="card flush"><div class="empty"><b>Reading the portfolio…</b>'
      + '<small>Entities, properties, buildings and loans.</small></div></div>';
    return;
  }

  body.innerHTML = prAlert() + prStrip() + prToolbar() + prChips()
    + (PR.mode === 'debt' ? prDebtView() : prTableView());
  wirePr(body);
}

/* ---------- the alert band ----------
   Only when something is actually wrong, and only the most urgent one. A banner
   that is always there is furniture. */

function prAlert(){
  const problems = PR.data.problems || [];
  if (problems.length) {
    return '<div class="pralert bad"><b>' + problems.length + ' quer'
      + (problems.length > 1 ? 'ies' : 'y') + ' failed</b>'
      + '<span class="grow">' + escS(problems[0].query || problems[0].kind || '')
      + ': ' + escS(String(problems[0].message || 'no detail').slice(0, 120)) + '</span>'
      + '<button class="tgl" data-prrefresh="1">Retry</button></div>';
  }

  const ps = prShown();
  const soonCut = Date.now() + 180 * 86400000;              // six months
  const soon = ps.flatMap(p => p.loans).filter(l => {
    const t = Date.parse(l.maturity);
    return t && t < soonCut;
  });
  if (soon.length) {
    const amt = soon.reduce((a, l) => a + l.balance, 0);
    return '<div class="pralert"><b>' + soon.length + ' loan' + (soon.length > 1 ? 's' : '')
      + ' mature within six months</b>'
      + '<span class="grow">' + prFull(amt) + ' comes due. '
      + escS([...new Set(soon.map(l => l.lender).filter(Boolean))].slice(0, 3).join(', ')) + '</span>'
      + '<button class="tgl" data-prmode="debt">See the wall</button></div>';
  }

  /* Unverified unit counts are the quiet one: every figure per unit is wrong
     until they are checked, and nothing else on screen says so. */
  const unver = ps.filter(p => prUnits(p).source === 'reported');
  if (unver.length > ps.length * 0.15 && ps.length) {
    return '<div class="pralert"><b>' + unver.length + ' of ' + ps.length
      + ' properties have no verified unit count</b>'
      + '<span class="grow">Their unit numbers come from the reported column, which holds only '
      + 'the first building. Anything per-unit is a guess for those.</span></div>';
  }
  return '';
}

/* ---------- the strip ---------- */

function prStrip(){
  const ps = prShown();
  const mv = ps.reduce((a, p) => a + prMv(p), 0);
  const debt = ps.reduce((a, p) => a + p.debt, 0);
  const eq = mv - debt;
  const ltv = mv ? debt / mv : 0;
  const units = ps.reduce((a, p) => a + prUnits(p).n, 0);
  const verified = ps.filter(p => prUnits(p).source === 'verified').length;
  const blds = ps.reduce((a, p) => a + p.buildings, 0);
  const loans = ps.flatMap(p => p.loans);
  const horizon = Date.now() + 550 * 86400000;              // roughly eighteen months
  const soon = loans.filter(l => { const t = Date.parse(l.maturity); return t && t < horizon; });
  const soonAmt = soon.reduce((a, l) => a + l.balance, 0);

  const tile = (lab, val, sub2, accent) =>
    '<div class="prtile"><div class="lab">' + lab + '</div>'
    + '<div class="val"' + (accent ? ' style="color:' + accent + '"' : '') + '>' + val + '</div>'
    + '<div class="sub">' + sub2 + '</div></div>';

  return '<div class="prstrip">'
    + '<div class="prtile"><div class="lab">Portfolio value</div>'
    +   '<div class="val">' + prMoney(mv) + ' <small>' + (mv ? prPct(ltv) + ' LTV' : '') + '</small></div>'
    +   '<div class="prstack"><i class="eq" style="width:' + (mv ? (eq / mv * 100).toFixed(1) : 0) + '%"></i>'
    +     '<i class="dt" style="width:' + (mv ? (ltv * 100).toFixed(1) : 0) + '%"></i></div>'
    +   '<div class="prlegend"><span><i style="background:var(--jade)"></i>Equity ' + prMoney(eq) + '</span>'
    +     '<span><i style="background:var(--brass)"></i>Debt ' + prMoney(debt) + '</span></div>'
    + '</div>'
    + tile('Units', units.toLocaleString(),
        verified + ' of ' + ps.length + ' properties unit-verified',
        ps.length && verified / ps.length < 0.7 ? 'var(--amber)' : null)
    + tile('Buildings', String(blds),
        ps.length + ' properties · ' + (PR.data.totals?.entities || 0) + ' entities')
    + tile('Maturing within 18 months', prMoney(soonAmt),
        loans.length ? soon.length + ' of ' + loans.length + ' loans' : 'no loans in view',
        soon.length ? 'var(--amber)' : null)
    /* Closing .prstrip. Without it the toolbar and the table were adopted as
       extra cells of this four-column grid, which is exactly what a missing tag
       looks like from outside: everything in the wrong place, nothing obviously
       broken. */
    + '</div>';
}

/* ---------- toolbar and chips ---------- */

function prToolbar(){
  const props = PR.data.properties || [];
  const counts = {};
  for (const p of props) counts[p.ownershipStatus] = (counts[p.ownershipStatus] || 0) + 1;
  const order = ['held', 'under_contract', 'sold', 'demolished', 'transferred', 'not_owned', 'unknown'];
  const opt = (arr, val) => arr.map(([v, l]) =>
    '<option value="' + escS(v) + '"' + (v === val ? ' selected' : '') + '>' + escS(l) + '</option>').join('');

  const managers = [...new Set(props.map(p => p.manager).filter(Boolean))].sort();
  const states = [...new Set(props.map(p => p.state).filter(Boolean))].sort();
  const lenders = [...new Set(props.flatMap(p => p.loans.map(l => l.lender).filter(Boolean)))].sort();

  let h = '<div class="prbar">'
    + '<input class="stagesel" id="pr-q" style="flex:1 1 230px;min-width:170px" '
    + 'placeholder="Search property, entity, manager, lender" value="' + escS(PR.q) + '">'
    + '<select class="stagesel" id="pr-own">'
    +   opt([['', 'All statuses (' + props.length + ')']].concat(
          order.filter(k => counts[k]).map(k => [k, PR_OWN_LABEL[k] + ' (' + counts[k] + ')'])), PR.own)
    + '</select>';
  /* A select with one option is a control that cannot do anything. */
  if (managers.length > 1) h += '<select class="stagesel" id="pr-manager">'
    + opt([['', 'Any manager']].concat(managers.map(x => [x, x])), PR.manager) + '</select>';
  if (states.length > 1) h += '<select class="stagesel" id="pr-fstate">'
    + opt([['', 'All states']].concat(states.map(x => [x, x])), PR.state) + '</select>';
  if (lenders.length > 1) h += '<select class="stagesel" id="pr-lender">'
    + opt([['', 'Any lender']].concat(lenders.map(x => [x, x])), PR.lender) + '</select>';
  h += '<select class="stagesel" id="pr-loans">'
    + opt([['', 'Loan: any'], ['has', 'Has a loan'], ['none', 'No loan']], PR.loans) + '</select>';

  h += '<div class="prseg" id="pr-seg">'
    + [['portfolio', 'Portfolio'], ['debt', 'Debt']].map(([m, l]) =>
        '<button data-prmode="' + m + '"' + (PR.mode === m ? ' class="on"' : '') + '>' + l + '</button>').join('')
    + '</div>'
    + '<button class="tgl" id="pr-export" title="Download what is on screen, columns and all">Export</button>'
    + '<button class="tgl" id="pr-addentity">+ Entity</button>'
    + '<button class="tgl" id="pr-addprop">+ Property</button>'
    + '</div>';
  return h;
}

/* Every active filter as a removable chip, so a short list is always
   explainable. Ownership shows even at its default: the filter doing the most
   work is exactly the one you must not hide. */
function prChips(){
  const out = [];
  const add = (label, val, key) => out.push('<span class="prchip">' + label + ' <b>' + escS(val)
    + '</b><button data-prclear="' + key + '" aria-label="Clear ' + label + '">×</button></span>');
  if (PR.own) add('Status', PR_OWN_LABEL[PR.own] || PR.own, 'own');
  if (PR.manager) add('Manager', PR.manager, 'manager');
  if (PR.state) add('State', PR.state, 'state');
  if (PR.lender) add('Lender', PR.lender, 'lender');
  if (PR.loans) add('Loans', PR.loans === 'has' ? 'has a loan' : 'no loan', 'loans');
  if (PR.year) add('Maturing', String(PR.year), 'year');
  if (PR.q) add('Search', PR.q, 'q');
  if (!out.length) return '';
  return '<div class="prchips">' + out.join('')
    + (out.length > 1 ? '<span class="prchip" style="border-style:dashed">'
        + '<button data-prclear="all" style="color:var(--dim)">Clear all</button></span>' : '')
    + '</div>';
}

/* ---------- columns ---------- */

const PR_COLS = [
  { k: 'name', l: 'Property', w: 'minmax(160px,1.7fr)', always: 1,
    get: p => p.name,
    cell: p => '<span class="name">' + escS(p.name) + '</span>'
      + (p.ownershipStatus !== 'held'
          ? '<span class="chip2" style="opacity:.75">'
            + escS(PR_OWN_LABEL[p.ownershipStatus] || p.ownershipStatus) + '</span>' : '') },
  { k: 'entity', l: 'Owner entity', w: 'minmax(130px,1.25fr)', always: 1,
    get: p => prEntName(prOwner(p)),
    /* Co-ownership is real here, and showing only the first owner makes four TIC
       entities look like one. */
    cell: p => '<span class="dim">' + escS(prEntName(prOwner(p))) + '</span>'
      + (p.owners.length > 1
          ? '<span class="chip2" title="' + escS(p.owners.map(prEntName).join(', ')) + '">+'
            + (p.owners.length - 1) + '</span>' : '') },
  { k: 'assetType', l: 'Type', w: '104px',
    get: p => p.assetType,
    cell: p => p.assetType ? '<span class="dim">' + escS(p.assetType) + '</span>' : PR_GAP },
  { k: 'city', l: 'Location', w: '124px',
    get: p => p.city,
    cell: p => p.city ? '<span class="dim">' + escS([p.city, p.state].filter(Boolean).join(', ')) + '</span>' : PR_GAP },
  { k: 'units', l: 'Units', w: '84px', n: 1,
    get: p => prUnits(p).n || null,
    /* An unverified count is shown with a mark, not hidden and not silently
       trusted -- it is usually one building's worth standing in for six. */
    cell: p => { const u = prUnits(p);
      if (!u.n) return PR_GAP;
      return u.source === 'verified' ? u.n.toLocaleString()
        : '<span title="' + (u.source === 'buildings' ? 'Summed from the buildings' : 'Reported count: holds only the first building')
          + '" style="color:' + (u.source === 'reported' ? 'var(--amber)' : 'var(--text)') + '">'
          + u.n.toLocaleString() + (u.source === 'reported' ? ' ?' : '') + '</span>'; } },
  { k: 'marketValue', l: 'Market value', w: '110px', n: 1, always: 1,
    get: p => prMv(p),
    cell: p => prMv(p)
      ? '<b style="font-weight:500;color:var(--cream)" title="' + prFull(prMv(p)) + '">'
        + prMoney(prMv(p)) + '</b>' : PR_GAP },
  { k: 'debt', l: 'Debt', w: '98px', n: 1, always: 1,
    get: p => p.debt || null,
    cell: p => p.debt ? '<span title="' + prFull(p.debt) + '">' + prMoney(p.debt) + '</span>' : PR_GAP },
  { k: 'ltv', l: 'Leverage', w: '116px', n: 1, always: 1,
    get: p => (p.debt ? prLtv(p) : null),
    cell: p => p.debt ? prLtvBar(prLtv(p)) : PR_GAP },
  { k: 'cap', l: 'Cap rate', w: '86px', n: 1,
    get: p => prCap(p),
    cell: p => prCap(p) ? (prCap(p) * 100).toFixed(2) + '%' : PR_GAP },
  { k: 'noi', l: 'NOI', w: '94px', n: 1,
    get: p => p.noi || null,
    cell: p => p.noi ? prMoney(p.noi) : PR_GAP },
  { k: 'occupancy', l: 'Occupancy', w: '94px', n: 1,
    get: p => p.occupancy,
    cell: p => p.occupancy == null ? PR_GAP
      : '<span' + (p.occupancy < 0.85 ? ' style="color:var(--amber)"' : '') + '>'
        + prPct(p.occupancy) + '</span>' },
  { k: 'maturity', l: 'Next maturity', w: '112px', n: 1,
    get: p => prNextMat(p),
    cell: p => { const m = prNextMat(p);
      if (!m) return PR_GAP;
      const y = prYear(m), now = new Date().getFullYear();
      const c = y <= now ? 'var(--rust)' : y === now + 1 ? 'var(--amber)' : 'var(--dim)';
      return '<span style="color:' + c + '">' + escS(m.slice(0, 7)) + '</span>'; } },
  { k: 'manager', l: 'Manager', w: '132px',
    get: p => p.manager,
    cell: p => p.manager ? '<span class="dim">' + escS(p.manager) + '</span>' : PR_GAP }
];

function prLtvBar(r){
  return '<span class="prltv"><span class="track"><i style="width:'
    + Math.min(100, r * 100).toFixed(1) + '%;background:' + prLtvColour(r) + '"></i></span>'
    + '<span class="pc" style="color:' + prLtvColour(r) + '">'
    + (r ? (r * 100).toFixed(0) + '%' : '—') + '</span></span>';
}

/* A column blank on two thirds of the rows costs width and reads as broken data.
   Dropping it hides nothing: the record carries every field. */
function prLiveCols(list){
  const n = list.length || 1;
  const filled = c => list.filter(p => {
    const v = c.get(p);
    return v !== null && v !== undefined && v !== '' && v !== 0;
  }).length;
  return PR_COLS.filter(c => c.always || filled(c) / n >= 0.33);
}

/* ---------- the table ---------- */

function prTableView(){
  const list = prShown();
  if (!list.length) return '<div class="card flush">' + prEmpty() + '</div>';

  const cols = prLiveCols(list);
  const grid = cols.map(c => c.w).join(' ');
  const sortCol = cols.find(c => c.k === PR.sort) || cols[0];
  const cmp = (a, b) => {
    const x = sortCol.get(a), y = sortCol.get(b);
    /* Absent sinks whichever way the column points. A blank floating to the top
       of a descending sort is just a second empty state. */
    if (x == null && y == null) return 0;
    if (x == null) return 1;
    if (y == null) return -1;
    const c = typeof x === 'string' ? String(x).localeCompare(String(y)) : (Number(x) || 0) - (Number(y) || 0);
    return PR.dir === 'asc' ? c : -c;
  };

  const head = '<div class="prthead" style="grid-template-columns:' + grid + '">'
    + cols.map(c => '<button class="prthb' + (c.n ? ' r' : '') + (PR.sort === c.k ? ' act' : '') + '" '
        + 'data-prsort="' + c.k + '">' + c.l + '<span class="ar">'
        + (PR.dir === 'asc' ? '▲' : '▼') + '</span></button>').join('')
    + '</div>';

  const row = (p, depth) => '<div class="prtr" data-prprop="' + escS(p.id) + '" tabindex="0" '
    + 'style="grid-template-columns:' + grid + '">'
    + cols.map((c, i) => '<span' + (c.n ? ' class="n"' : '')
        + (i === 0 ? ' style="--i:' + (12 + (depth || 0) * 18) + 'px;padding-left:calc(var(--i) + 14px)"' : '')
        + '>' + c.cell(p) + '</span>').join('')
    + '</div>';

  const q = PR.q.trim().toLowerCase();
  /* The needle goes into a regex, so it has to be escaped: an entity search for
     "(" would otherwise throw and blank the whole pane. */
  const mark = str => {
    const safe = escS(str);
    if (!q) return safe;
    const needle = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return safe.replace(new RegExp('(' + needle + ')', 'ig'), '<mark>$1</mark>');
  };

  const total = list.reduce((a, p) => a + prMv(p), 0);

  const band = (name, r, depth, key, open) => {
    const lv = r.mv ? r.debt / r.mv : 0;
    const share = total ? Math.max(2, Math.min(100, r.mv / total * 100)) : 0;
    const cells = cols.map((c, i) => {
      if (i === 0) return '<span style="padding-left:' + (12 + depth * 18) + 'px">'
        + '<span class="cv">▸</span><span class="gname">' + mark(name) + '</span>'
        + '<span class="gct">' + r.n + '</span></span>';
      if (i === 1) return '<span>' + (r.units ? '<span class="gct">'
        + r.units.toLocaleString() + ' units</span>' : '') + '</span>';
      if (c.k === 'marketValue') return '<span class="n">' + prMoney(r.mv)
        + '<i class="prshare" style="width:' + share.toFixed(1) + 'px"></i></span>';
      if (c.k === 'debt') return '<span class="n">' + (r.debt ? prMoney(r.debt) : PR_GAP) + '</span>';
      if (c.k === 'ltv') return '<span class="n">' + (r.debt ? prLtvBar(lv) : PR_GAP) + '</span>';
      return '<span></span>';
    }).join('');
    return '<button class="prgrp d' + Math.min(depth, 2) + (open ? ' open' : '') + '" '
      + 'data-prgrp="' + escS(key) + '" style="grid-template-columns:' + grid + '">'
      + cells + '</button>';
  };

  const d = PR.data;
  const passing = new Set(list.map(p => p.id));
  /* Roll up over a SET of property ids, never by adding child totals. Four TIC
     entities holding one building each are placed under all four, so summing the
     subtrees counted that building four times -- one holding company read $124M
     of debt against a real $31M. */
  const roll = id => {
    let mv = 0, debt = 0, units = 0, n = 0;
    for (const pid of d.subtree.get(id) || []) {
      if (!passing.has(pid)) continue;
      const p = d.byId.get(pid);
      if (!p) continue;
      mv += prMv(p); debt += p.debt; units += prUnits(p).n; n++;
    }
    return { mv, debt, units, n };
  };

  /* Opening a sub-entity keeps its ancestors open, so the path down to what you
     are looking at stays visible and everything else folds away. */
  const path = new Set(PR.open ? prPathTo(PR.open) : []);
  let seen = 0;

  const node = (n, depth) => {
    const r = roll(n.id);
    if (!r.n) return '';
    seen++;
    const open = path.has(n.id);
    const kids = (n.children || []).slice().sort((a, b) => roll(b.id).mv - roll(a.id).mv);
    const mine = (d.place.get(n.id) || []).map(id => d.byId.get(id))
      .filter(p => p && passing.has(p.id)).sort(cmp);
    /* The nest is always in the DOM so the open/close can animate its height.
       Rendering it only when open would make every expansion a jump-cut. */
    return band(n.name, r, depth, n.id, open)
      + '<div class="prnestwrap' + (open ? ' on' : '') + '"><div class="prnest">'
      +   (open ? kids.map(c => node(c, depth + 1)).join('') + mine.map(p => row(p, depth + 1)).join('') : '')
      + '</div></div>';
  };

  const rows = (d.tree || []).map(n => ({ n, r: roll(n.id) })).filter(x => x.r.n)
    .sort((a, b) => b.r.mv - a.r.mv).map(x => node(x.n, 0)).join('');

  /* Totals stay put at the bottom. The figure you are comparing a row against
     must not be the one that scrolled away. */
  const totals = {
    mv: total,
    debt: list.reduce((a, p) => a + p.debt, 0),
    units: list.reduce((a, p) => a + prUnits(p).n, 0),
    noi: list.reduce((a, p) => a + (p.noi || 0), 0)
  };
  const foot = '<div class="prtfoot" style="grid-template-columns:' + grid + '">'
    + cols.map((c, i) => {
        if (i === 0) return '<span class="lbl">' + list.length + ' properties · ' + seen + ' entities</span>';
        if (c.k === 'units') return '<span class="n">' + (totals.units || '') + '</span>';
        if (c.k === 'marketValue') return '<span class="n">' + prMoney(totals.mv) + '</span>';
        if (c.k === 'debt') return '<span class="n">' + prMoney(totals.debt) + '</span>';
        if (c.k === 'ltv') return '<span class="n">'
          + (totals.mv ? (totals.debt / totals.mv * 100).toFixed(0) + '%' : '—') + '</span>';
        if (c.k === 'noi') return '<span class="n">' + (totals.noi ? prMoney(totals.noi) : '') + '</span>';
        return '<span></span>';
      }).join('')
    + '</div>';

  const hidden = PR_COLS.length - cols.length;
  const notice = hidden
    ? '<span class="eyebrow" style="margin-left:auto" title="A column hides when fewer than a '
      + 'third of the rows in view have a value for it. The record still has them.">'
      + hidden + ' sparse column' + (hidden > 1 ? 's' : '') + ' hidden</span>'
    : '';

  return '<div class="card flush"><div class="cardhead"><h3>' + list.length + ' properties</h3>'
    + '<span class="eyebrow">' + prMoney(total) + ' · sorted by '
    +   escS(sortCol.l.toLowerCase()) + '</span>' + notice
    + '</div><div class="prtbwrap"><div class="prtb">' + head + rows + foot + '</div></div></div>';
}

function prEmpty(){
  return '<div class="empty"><b>Nothing matches</b><small>'
    + (PR.own ? 'Ownership is set to <b>' + escS(PR_OWN_LABEL[PR.own] || PR.own) + '</b>. ' : '')
    + 'Clear a filter to see more.</small></div>';
}

/* ---------- Debt ---------- */

function prDebtView(){
  const ps = prShown();
  const loans = ps.flatMap(p => p.loans.map(l => ({ ...l, prop: p })));
  if (!loans.length) return '<div class="card flush">' + prEmpty() + '</div>';

  const thisYear = new Date().getFullYear();
  const years = {};
  let undated = 0;
  for (const l of loans) {
    const y = prYear(l.maturity);
    if (y == null) { undated++; continue; }
    years[y] = (years[y] || 0) + l.balance;
  }
  const keys = Object.keys(years).map(Number).sort((a, b) => a - b);
  const total = loans.reduce((a, l) => a + l.balance, 0);

  let wall = '<div class="hint" style="padding:0 18px 14px">No maturity dates recorded.</div>';
  if (keys.length) {
    const span = [];
    /* Start at this year even when nothing matures until later, so the distance
       to the first wall is visible rather than implied. */
    for (let y = Math.min(thisYear, keys[0]); y <= keys[keys.length - 1]; y++) span.push(y);
    const max = Math.max(...Object.values(years));
    wall = '<div class="prwall"><div class="prwallgrid">' + span.map(y => {
      const amt = years[y] || 0;
      const cls = y <= thisYear ? 'now' : y === thisYear + 1 ? 'soon' : '';
      return '<button class="pryr ' + cls + (PR.year === y ? ' sel' : '') + '" data-pryear="' + y + '" '
        + 'title="' + prFull(amt) + ' maturing in ' + y + '">'
        + '<span class="amt">' + (amt ? prMoney(amt) : '') + '</span>'
        + '<span class="col" style="height:' + (amt ? Math.max(2, amt / max * 150) : 2) + 'px"></span>'
        + '<span class="yl">' + y + '</span></button>';
    }).join('') + '</div>'
      + '<p class="hint" style="margin-top:12px">Click a year to filter every view to the '
      + 'properties whose loans come due then.'
      + (undated ? ' ' + undated + ' loan' + (undated > 1 ? 's have' : ' has') + ' no maturity date and '
        + 'appear' + (undated > 1 ? '' : 's') + ' in no bar.' : '') + '</p></div>';
  }

  /* Lender concentration: who could actually say no at renewal. */
  const byLender = {};
  for (const l of loans) {
    const k = l.lender || 'No lender recorded';
    byLender[k] = byLender[k] || { bal: 0, n: 0, props: new Set() };
    byLender[k].bal += l.balance; byLender[k].n++; byLender[k].props.add(l.prop.id);
  }
  const lenders = Object.entries(byLender).sort((a, b) => b[1].bal - a[1].bal);
  const topBal = lenders[0][1].bal || 1;
  const exposure = lenders.map(([name, v]) =>
    '<div class="prexprow"><span class="nm">' + escS(name)
    + '<small>' + v.n + ' loan' + (v.n > 1 ? 's' : '') + ' · ' + v.props.size + ' propert'
    + (v.props.size > 1 ? 'ies' : 'y')
    + (total ? ' · ' + (v.bal / total * 100).toFixed(0) + '% of debt' : '') + '</small></span>'
    + '<span class="fg">' + prMoney(v.bal) + '</span>'
    + '<span class="barr"><i style="width:' + (v.bal / topBal * 100).toFixed(1) + '%"></i></span></div>').join('');

  const rated = loans.filter(l => l.ratePct);
  const ratedBal = rated.reduce((a, l) => a + l.balance, 0);
  const wAvg = ratedBal ? rated.reduce((a, l) => a + l.ratePct * l.balance, 0) / ratedBal : null;

  const rows = loans.slice().sort((a, b) =>
    (Date.parse(a.maturity) || Infinity) - (Date.parse(b.maturity) || Infinity)).map(l => {
    const y = prYear(l.maturity);
    const col = y == null ? 'var(--dimmer)' : y <= thisYear ? 'var(--rust)'
      : y === thisYear + 1 ? 'var(--amber)' : 'var(--dim)';
    return '<div class="prloan" data-prprop="' + escS(l.prop.id) + '" tabindex="0">'
      + '<span class="nm">' + escS(l.name) + '<small>' + escS(l.prop.name) + '</small></span>'
      + '<span class="c">' + escS(l.lender || '—') + '</span>'
      + '<span class="n">' + (l.ratePct ? (l.ratePct * 100).toFixed(2) + '%' : '—') + '</span>'
      + '<span class="n" style="color:' + col + '">'
      +   escS(l.maturity ? String(l.maturity).slice(0, 10) : 'no date') + '</span>'
      + '<span class="n">' + prMoney(l.balance) + '</span></div>';
  }).join('');

  return '<div class="prtwo">'
    + '<div class="card flush"><div class="cardhead"><h3>Maturity wall</h3>'
    +   '<span class="eyebrow">' + prMoney(total) + ' across ' + loans.length + ' loans'
    +   (wAvg ? ' · ' + (wAvg * 100).toFixed(2) + '% weighted rate' : '') + '</span></div>'
    +   wall + '</div>'
    + '<div class="card flush"><div class="cardhead"><h3>Lender exposure</h3>'
    +   '<span class="eyebrow">' + lenders.length + ' lenders</span></div>' + exposure + '</div>'
    + '<div class="card flush" style="grid-column:1/-1"><div class="cardhead"><h3>Loans</h3>'
    +   '<span class="eyebrow">soonest first</span></div>' + rows + '</div>'
    + '</div>';
}

/* ---------- toolbar actions ---------- */

/* Export writes what is on screen: the rows the filters left, the columns the
   sparse-column rule kept. An export that quietly returns all 168 rows and every
   column is a different document that happens to have been triggered here. */
function prExport(){
  const list = prShown();
  if (!list.length) { toast('Nothing to export'); return; }
  const cols = prLiveCols(list);
  const rest = cols.filter(c => !['name', 'entity', 'city'].includes(c.k));
  const head = ['Property', 'Owner entity', 'Address', 'City', 'State', 'Units', 'Unit source',
    ...rest.filter(c => c.k !== 'units').map(c => c.l)];

  const cell = v => {
    if (v === null || v === undefined) return '';
    const t = String(v);
    /* A leading =, +, - or @ is a formula to Excel. Property names are typed by
       people and one starting with a dash would execute. */
    const safe = /^[=+\-@]/.test(t) ? "'" + t : t;
    return /[",\n]/.test(safe) ? '"' + safe.replace(/"/g, '""') + '"' : safe;
  };

  const rows = list.slice().sort((a, b) => prMv(b) - prMv(a)).map(p => {
    const u = prUnits(p);
    return [p.name, prEntName(prOwner(p)), p.street || '', p.city || '', p.state || '',
      u.n || '', u.source || 'none',
      ...rest.filter(c => c.k !== 'units').map(c => {
        const v = c.get(p);
        if (['ltv', 'cap', 'occupancy'].includes(c.k)) return v == null ? '' : (v * 100).toFixed(2) + '%';
        return v == null ? '' : v;
      })];
  });

  const csv = [head, ...rows].map(r => r.map(cell).join(',')).join('\r\n');
  /* A BOM, because Excel reads a UTF-8 CSV as Latin-1 without one and every name
     with an accent or a curly apostrophe comes out mangled. */
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'properties-' + new Date().toISOString().slice(0, 10) + '.csv';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast(list.length + ' properties exported');
}

/* A small modal for the create forms. Fields are [key, label, kind, options,
   placeholder]; returning a string from onSubmit means "not valid" and the form
   stays open saying so. */
function prForm({ title, note, fields, submit, onSubmit }){
  const host = document.createElement('div');
  host.className = 'tkmodal on';
  const close = () => host.remove();

  const draw = err => {
    host.innerHTML = '<div class="tkmpanel" role="dialog" aria-modal="true" style="max-width:460px">'
      + '<div class="tkmhead"><div style="flex:1;min-width:0"><h3>' + escS(title) + '</h3>'
      +   (note ? '<p>' + escS(note) + '</p>' : '') + '</div>'
      +   '<button class="tgl" data-prfclose="1">Close</button></div>'
      + '<div class="tkmbody">'
      +   (err ? '<div class="err" style="padding:0 0 12px">' + escS(err) + '</div>' : '')
      +   fields.map(f => '<label class="fld" style="margin-bottom:12px">'
          + '<span class="eyebrow">' + escS(f[1]) + '</span>'
          + (f[2] === 'select'
              ? '<select class="prsel" style="width:100%" data-prf="' + escS(f[0]) + '">'
                + (f[3] || []).map(o => '<option value="' + escS(o[0]) + '">' + escS(o[1]) + '</option>').join('')
                + '</select>'
              : '<input data-prf="' + escS(f[0]) + '" placeholder="' + escS(f[4] || '') + '">')
          + '</label>').join('')
      +   '<div class="sheetfoot" style="padding:6px 0 0;border:0">'
      +     '<button class="tgl" data-prfclose="1">Cancel</button>'
      +     '<button class="btn primary" data-prfgo="1">' + escS(submit) + '</button>'
      +   '</div>'
      + '</div></div>';
    host.querySelectorAll('[data-prfclose]').forEach(b => b.onclick = close);
    host.querySelector('[data-prfgo]').onclick = async () => {
      const values = {};
      host.querySelectorAll('[data-prf]').forEach(el => { values[el.dataset.prf] = el.value.trim(); });
      host.querySelector('[data-prfgo]').disabled = true;
      const problem = await onSubmit(values);
      if (problem) { draw(problem); return; }
      close();
    };
    const first = host.querySelector('[data-prf]');
    if (first) first.focus();
  };

  draw(null);
  /* Clicking the backdrop closes; clicking the panel must not. */
  host.onclick = e => { if (e.target === host) close(); };
  document.body.appendChild(host);
}

function prAddEntity(){
  const entities = (PR.data?.entities || []).slice().sort((a, b) => a.name.localeCompare(b.name));
  prForm({
    title: 'New entity',
    note: 'A holding company or an LLC. Leave the parent empty for a top-level one.',
    fields: [
      ['name', 'Name', 'text', null, 'Ridgmar Partners, LLC'],
      ['parentEntityId', 'Parent entity', 'select',
        [['', '— none, this is top level —'], ...entities.map(e => [e.id, e.name])]]
    ],
    submit: 'Create entity',
    onSubmit: async v => {
      if (!v.name) return 'An entity needs a name.';
      try {
        const r = await fetch('/api/portfolio/entity', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: v.name, parentEntityId: v.parentEntityId || null })
        });
        const j = await r.json();
        if (!r.ok) return j.error || ('create failed (' + r.status + ')');
        toast('Created ' + v.name);
        await prLoad(true);
        return null;
      } catch (err) { return err.message; }
    }
  });
}

function prAddProperty(){
  const entities = (PR.data?.entities || []).slice().sort((a, b) => a.name.localeCompare(b.name));
  if (!entities.length) { toast('Create an entity first — a property has to belong to one'); return; }
  prForm({
    title: 'New property',
    note: 'Created as held, owned by the entity you pick.',
    fields: [
      ['name', 'Name', 'text', null, 'BG Flats'],
      ['entityId', 'Owner entity', 'select', entities.map(e => [e.id, e.name])],
      ['street', 'Street', 'text', null, '3200 Jaffa Garden Way'],
      ['city', 'City', 'text', null, 'Rapid City'],
      ['state', 'State', 'text', null, 'SD'],
      ['zip', 'ZIP', 'text', null, '57703']
    ],
    submit: 'Create property',
    onSubmit: async v => {
      if (!v.name) return 'A property needs a name.';
      if (!v.entityId) return 'Pick the entity that owns it.';
      try {
        const r = await fetch('/api/portfolio/property', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(v)
        });
        const j = await r.json();
        if (!r.ok) return j.error || ('create failed (' + r.status + ')');
        toast('Created ' + v.name);
        await prLoad(true);
        /* Straight into the record: a property with a name and an address is not
           finished, and the next thing anyone wants is the rest of its fields. */
        if (j.id) prOpenPanel(j.id);
        return null;
      } catch (err) { return err.message; }
    }
  });
}

/* ---------- wiring ---------- */

function wirePr(root){
  const q = root.querySelector('#pr-q');
  if (q) q.oninput = () => {
    PR.q = q.value;
    drawProperties();
    /* Redrawing on every keystroke drops the caret, so it goes back. */
    const again = document.getElementById('pr-q');
    if (again) { again.focus(); again.setSelectionRange(again.value.length, again.value.length); }
  };

  const selects = { 'pr-own': 'own', 'pr-manager': 'manager', 'pr-fstate': 'state',
    'pr-lender': 'lender', 'pr-loans': 'loans' };
  for (const [id, key] of Object.entries(selects)) {
    const el = root.querySelector('#' + id);
    if (el) el.onchange = () => { PR[key] = el.value; drawProperties(); };
  }

  root.querySelectorAll('[data-prmode]').forEach(b => b.onclick = () => {
    PR.mode = b.dataset.prmode; drawProperties();
  });
  root.querySelectorAll('[data-prrefresh]').forEach(b => b.onclick = () => prLoad(true));

  root.querySelectorAll('[data-prclear]').forEach(b => b.onclick = () => {
    const k = b.dataset.prclear;
    if (k === 'all') Object.assign(PR, { q: '', own: '', manager: '', state: '', lender: '', loans: '', year: null });
    else if (k === 'year') PR.year = null;
    else PR[k] = '';
    drawProperties();
  });

  root.querySelectorAll('[data-prgrp]').forEach(b => b.onclick = () => {
    const k = b.dataset.prgrp;
    /* Clicking what is already open closes it. For a nested entity that means
       falling back to its parent, not collapsing the branch you are in. */
    PR.open = PR.open === k ? (PR.data.parentOf.get(k) || null) : k;
    drawProperties();
  });

  root.querySelectorAll('[data-prsort]').forEach(b => b.onclick = () => {
    const k = b.dataset.prsort;
    if (PR.sort === k) PR.dir = PR.dir === 'asc' ? 'desc' : 'asc';
    else { PR.sort = k; PR.dir = PR_COLS.find(c => c.k === k)?.n ? 'desc' : 'asc'; }
    drawProperties();
  });

  root.querySelectorAll('[data-pryear]').forEach(b => b.onclick = () => {
    const y = Number(b.dataset.pryear);
    PR.year = PR.year === y ? null : y;
    /* A filter you cannot see acting on anything is indistinguishable from a
       broken button, so it takes you to the view it changes. */
    PR.mode = 'portfolio';
    drawProperties();
  });

  root.querySelectorAll('[data-prprop]').forEach(el => {
    el.onclick = () => prOpenPanel(el.dataset.prprop);
    el.onkeydown = e => { if (e.key === 'Enter') prOpenPanel(el.dataset.prprop); };
  });

  const exp = root.querySelector('#pr-export');
  if (exp) exp.onclick = prExport;
  const addE = root.querySelector('#pr-addentity');
  if (addE) addE.onclick = prAddEntity;
  const addP = root.querySelector('#pr-addprop');
  if (addP) addP.onclick = prAddProperty;
}

/* moved into mount() */

/* ---------- the property record ----------

   Nothing here declares a field. The server reads information_schema, pairs each
   column with the label the people who maintain this data actually use, and says
   which of six kinds it is. This renders whatever it is handed, so a column added
   to Supabase appears without anyone touching the front end.

   A field id says where a write goes: p:<col>, u:<unitId>:<col>, l:<loanId>:<col>,
   i:<insId>:<col>, ownerentity, loanstatus:<id>. The panel never has to know
   which table anything lives in. */

const PD = {
  id: null, data: null, loading: false, error: null,
  unit: null,                    // building drill-down
  tab: 'summary',
  fq: '', hideEmpty: true,
  editing: null, draft: '', busy: null, err: null,
  comment: '', posting: false
};

const PD_TABS = [
  ['summary', 'Summary'], ['loans', 'Loans'], ['financials', 'Financials'],
  ['buildings', 'Buildings'], ['messages', 'Messages']
];

function prOpenPanel(id){
  PD.id = id;
  PD.data = null; PD.error = null; PD.unit = null; PD.tab = 'summary';
  PD.editing = null; PD.err = null; PD.fq = ''; PD.comment = '';
  document.getElementById('pr-panel')?.classList.add('on');
  document.getElementById('pr-panel')?.setAttribute('aria-hidden', 'false');
  document.getElementById('pr-scrim')?.classList.add('on');
  prdDraw();
  prdLoad();
}

function prClosePanel(){
  document.getElementById('pr-panel')?.classList.remove('on');
  document.getElementById('pr-panel')?.setAttribute('aria-hidden', 'true');
  document.getElementById('pr-scrim')?.classList.remove('on');
  PD.id = null;
}

async function prdLoad(){
  const id = PD.id;
  PD.loading = true;
  prdDraw();
  try {
    const r = await fetch('/api/portfolio/' + encodeURIComponent(id) + '/detail');
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || ('record ' + r.status));
    if (PD.id !== id) return;             // the panel moved on while this was in flight
    PD.data = j;
  } catch (err) {
    if (PD.id === id) PD.error = err.message;
  }
  PD.loading = false;
  prdDraw();
}

/* ---------- field formatting ----------
   Ported from the dashboard this replaces, so the same value reads the same way
   in both. */

function prdFmt(f){
  if (!f) return '';
  const v = f.value, d = f.display;
  if (f.pct) {
    const n = Number(v);
    return (v != null && v !== '' && isFinite(n)) ? (Math.round(n * 10000) / 100).toLocaleString() + '%' : (d ?? '');
  }
  if (f.type === 'currency') {
    const n = Number(v);
    return (v != null && v !== '' && isFinite(n)) ? prFull(n) : (d ?? '');
  }
  if (f.type === 'number') {
    const n = Number(v);
    return (v != null && v !== '' && isFinite(n)) ? (Math.round(n * 100) / 100).toLocaleString() : (d ?? '');
  }
  if (f.type === 'date') {
    const n = Number(v);
    return (isFinite(n) && n > 0) ? new Date(n).toLocaleDateString('en-US') : (d ?? '');
  }
  if (f.type === 'drop_down') {
    const o = (f.options || []).find(x => String(x.id) === String(v));
    return o ? o.name : (d ?? '');
  }
  return d != null ? String(d) : '';
}

const prdHas = f => f && f.value != null && f.value !== '';
const PRD_EDITABLE = new Set(['short_text', 'number', 'currency', 'date', 'drop_down']);
/* A field with no id is derived -- current debt comes from loan_balance, the
   parcel from property_parcel. Showing it is right; letting someone type into it
   is a lie about where the number lives. */
const prdEditable = f => Boolean(f && f.id) && PRD_EDITABLE.has(f.type);

/* What goes into the input. A currency field showing "$7,982,500" has to edit as
   7982500 or the first save fails on its own formatting. */
function prdRaw(f){
  if (!f || f.value == null) return '';
  if (f.type === 'date') {
    const n = Number(f.value);
    return isFinite(n) && n > 0 ? new Date(n).toISOString().slice(0, 10) : '';
  }
  return String(f.value);
}

function prdMark(text){
  const q = PD.fq.trim().toLowerCase();
  const safe = escS(text);
  if (!q) return safe;
  const needle = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return safe.replace(new RegExp('(' + needle + ')', 'ig'), '<mark>$1</mark>');
}

/* ---------- one field row ---------- */

function prdField(f){
  const editing = PD.editing === f.id && f.id;
  const busy = PD.busy === f.id && f.id;
  const editable = prdEditable(f);

  if (!editing) {
    let body;
    if (busy) body = '<span class="mt">saving…</span>';
    else if (f.link && f.value) {
      body = '<a href="' + escS(f.value) + '" target="_blank" rel="noopener">Open ↗</a>';
    } else {
      const t = prdFmt(f);
      body = t === '' ? '<span class="mt">—</span>' : escS(t);
    }
    return '<div class="prf"><span class="fl">' + prdMark(f.name) + '</span>'
      + '<span class="fv ' + (editable ? 'ed' : 'ro') + '"'
      + (editable ? ' data-prdedit="' + escS(f.id) + '"' : '') + '>' + body + '</span></div>';
  }

  /* The control matches the kind. A date picker for a date and a real select for
     a dropdown is the difference between editing a record and retyping it. */
  const raw = escS(PD.draft);
  const input = f.type === 'drop_down'
    ? '<select class="predin" data-prdinput="1">'
      + (f.options || []).map(o => '<option value="' + escS(o.id) + '"'
        + (String(o.id) === String(PD.draft) ? ' selected' : '') + '>' + escS(o.name) + '</option>').join('')
      + '</select>'
    : '<input class="predin" data-prdinput="1" type="'
      + (f.type === 'date' ? 'date' : f.type === 'currency' || f.type === 'number' ? 'number' : 'text')
      + '" value="' + raw + '"' + (f.type === 'currency' || f.type === 'number' ? ' step="any"' : '') + '>';

  return '<div class="prf"><span class="fl">' + prdMark(f.name) + '</span>'
    + '<span class="fv"><div class="predwrap">' + input
    +   '<div class="predacts">'
    +     '<button class="tgl" data-prdsave="' + escS(f.id) + '">Save</button>'
    +     '<button class="tgl" data-prdcancel="1">Cancel</button>'
    +     (PD.err ? '<span class="prederr">' + escS(PD.err) + '</span>' : '')
    +   '</div></div></span></div>';
}

/* Fields, grouped and searched. `groupOrder` comes from the server so the two
   halves cannot drift. */
function prdGroups(fields){
  const q = PD.fq.trim().toLowerCase();
  const order = PD.data.groupOrder || ['Property', 'Other'];
  const by = {};
  for (const key of Object.keys(fields)) {
    const f = fields[key];
    if (q && !String(f.name).toLowerCase().includes(q)) continue;
    /* A search overrides hide-empty. Asking for a field by name is how you go to
       fill it in, and answering "nothing to show" is the one moment that is
       certainly wrong. */
    if (PD.hideEmpty && !q && !prdHas(f) && PD.editing !== f.id) continue;
    (by[f.group || 'Other'] ||= []).push(f);
  }
  const out = order.filter(g => by[g]).map(g =>
    '<div class="prsect"><div class="prsecth"><b>' + escS(g) + '</b>'
    + '<span class="cnt">' + by[g].length + '</span></div>'
    + '<div class="prfgrid">' + by[g].map(prdField).join('') + '</div></div>').join('');

  if (!out) {
    return '<div class="prtabempty"><b>Nothing to show</b><small>'
      + (q ? 'No field matches “' + escS(PD.fq) + '”. '
          : PD.hideEmpty ? 'Every field here is empty. ' : '')
      + (PD.hideEmpty ? 'Untick “hide empty” to fill them in.' : 'Clear the search.')
      + '</small></div>';
  }
  return out;
}

const prdCount = fields => {
  const total = Object.keys(fields).length;
  const filled = Object.keys(fields).filter(k => prdHas(fields[k])).length;
  return filled + ' of ' + total + ' filled';
};

/* ---------- writes ---------- */

async function prdSave(fieldId, value){
  PD.busy = fieldId;
  PD.editing = null;
  PD.err = null;
  prdDraw();
  try {
    const r = await fetch('/api/portfolio/' + encodeURIComponent(PD.id) + '/field', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ field: fieldId, value })
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || ('save ' + r.status));
    /* Re-read rather than patch in place: a write can move more than the column
       written -- a market value moves the LTV, occupancy moves the roll-up --
       and guessing which is how a panel drifts from the database. */
    PD.busy = null;
    await prdLoad();
    prLoad(true);
    toast('Saved');
    return;
  } catch (err) {
    PD.err = err.message;
    PD.editing = fieldId;
    toast(err.message);
  }
  PD.busy = null;
  prdDraw();
}

async function prdOwner(method, path, body){
  try {
    const r = await fetch('/api/portfolio/' + encodeURIComponent(PD.id) + path, {
      method, headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || (method + ' ' + r.status));
    await prdLoad();
    prLoad(true);
  } catch (err) { toast(err.message); }
}

async function prdPost(){
  const body = PD.comment.trim();
  if (!body || PD.posting) return;
  PD.posting = true;
  prdDraw();
  try {
    const r = await fetch('/api/portfolio/' + encodeURIComponent(PD.id) + '/comments', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body })
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || ('post ' + r.status));
    PD.data.comments = [...(PD.data.comments || []), j.comment];
    PD.comment = '';
  } catch (err) { toast(err.message); }
  PD.posting = false;
  prdDraw();
}

/* ---------- panel head ---------- */

function prdHead(){
  const d = PD.data;
  const unit = PD.unit ? d.buildings.find(b => b.id === PD.unit) : null;
  const status = d.loanStatus || 'none';
  const pill = status === 'active' ? 'active' : status === 'pending' ? 'pending' : 'off';

  const crumb = unit
    ? '<button data-prdunit="">‹ ' + escS(d.name) + '</button>'
    : d.path.map((n, i) => (i ? '<span>›</span>' : '')
        + '<button data-prdent="' + escS(n.id) + '">' + escS(n.name) + '</button>').join('');

  const units = d.buildings.reduce((a, b) => a + b.units, 0);
  const mvField = d.fields[prdKey('Current Market Value')];
  const mv = mvField ? Number(mvField.value || 0) : 0;
  const ltv = mv ? d.currentDebt / mv : 0;

  const sums = unit
    ? [['Units', String(unit.units || '—'), ''],
       ['Square feet', unit.squareFeet ? unit.squareFeet.toLocaleString() : '—', ''],
       ['Owner', (unit.owners.find(o => o.primary) || {}).name || '—', ''],
       ['Fields', prdCount(unit.fields), '']]
    : [['Market value', prMoney(mv), mvField && mvField.value ? prFull(mv) : 'not recorded'],
       ['Debt', prMoney(d.currentDebt), d.currentDebt ? (ltv * 100).toFixed(0) + '% LTV' : 'unlevered'],
       ['Units', units ? units.toLocaleString() : '—', d.buildings.length + ' buildings'],
       ['Loans', String(d.loans.length), d.loans.length ? STATUSY(d) : 'none']];

  return '<div class="prptop"><div style="flex:1;min-width:0">'
    + '<h3>' + escS(unit ? unit.name : d.name) + '</h3>'
    + '<div class="prcrumb">' + crumb + '</div>'
    + '</div>'
    + '<span class="prpill ' + pill + '">' + escS(status) + '</span>'
    + '<button class="tgl" data-prdclose="1">Close</button></div>'
    + '<div class="prsums">' + sums.map(([l, v, s]) =>
        '<div class="s"><em>' + escS(l) + '</em><strong>' + escS(v)
        + (s ? ' <span class="sec">' + escS(s) + '</span>' : '') + '</strong></div>').join('')
    + '</div>'
    + '<div class="prtabs">' + PD_TABS.map(([k, l]) => {
        const n = k === 'loans' ? d.loans.length
          : k === 'financials' ? d.financials.length
          : k === 'buildings' ? d.buildings.length
          : k === 'messages' ? d.comments.length : null;
        return '<button class="prtab' + (PD.tab === k ? ' on' : '') + '" data-prdtab="' + k + '">'
          + escS(l) + (n === null ? '' : '<span class="tn">' + n + '</span>') + '</button>';
      }).join('') + '</div>';
}

const prdKey = label => String(label).toLowerCase().replace(/\s+/g, ' ').trim();
const STATUSY = d => [...new Set(d.loans.map(l => l.status))].join(', ').toLowerCase();

/* ---------- tabs ---------- */

function prdSummary(){
  const d = PD.data;
  if (PD.unit) {
    const u = d.buildings.find(b => b.id === PD.unit);
    if (!u) return '<div class="prtabempty"><b>That building is gone</b>'
      + '<small>It may have been removed since this panel opened.</small></div>';
    return prdOwnership(u) + prdGroups(u.fields);
  }
  return prdOwnership(null) + prdGroups(d.fields);
}

/* Ownership is a relationship, not a label: `ownership` is the source of truth
   and property.entity_id is a copy of the primary row. Both move together, which
   is why the primary owner is changed here and never removed. */
function prdOwnership(unit){
  const d = PD.data;
  const owners = unit ? unit.owners : d.owners;
  const primary = owners.find(o => o.primary);
  const co = owners.filter(o => !o.primary);
  const taken = new Set(owners.map(o => o.id));
  const free = d.entityOptions.filter(e => !taken.has(e.id));
  const fieldId = unit ? 'ownerentityunit:' + unit.id : 'ownerentity';

  return '<div class="prown">'
    + '<div class="prownline"><span class="prownlab">Primary owner</span>'
    +   '<select class="prsel" data-prdowner="' + escS(fieldId) + '">'
    +     d.entityOptions.map(e => '<option value="' + escS(e.id) + '"'
          + (e.id === (primary?.id || '') ? ' selected' : '') + '>' + escS(e.name) + '</option>').join('')
    +   '</select></div>'
    + '<div class="prownline"><span class="prownlab">Co-owners</span>'
    +   (co.length ? co.map(o => '<span class="prcoch">' + escS(o.name)
        + '<button data-prdrm="' + escS(o.id) + '" title="Remove">×</button></span>').join('')
        : '<span class="mt" style="color:var(--edge2);font-size:11.5px">None</span>')
    +   (free.length
          ? '<select class="prsel" data-prdaddowner="1"><option value="">+ Add co-owner…</option>'
            + free.map(e => '<option value="' + escS(e.id) + '">' + escS(e.name) + '</option>').join('')
            + '</select>' : '')
    + '</div></div>';
}

const PR_POS_LABEL = { primary: 'Primary', seller_carry: 'Seller Carry',
  secondary: 'Secondary', pac_due: 'PAC Due' };
const PR_POS_ORDER = ['primary', 'seller_carry', 'secondary', 'pac_due'];

function prdLoans(){
  const d = PD.data;
  if (!d.loans.length) {
    return '<div class="prtabempty"><b>Unlevered</b>'
      + '<small>Nothing is secured against this property or its buildings. '
      + 'A loan reaches a property directly or through one of its buildings, and neither exists here.'
      + '</small></div>';
  }
  /* Grouped by position, in the order a lender would read them. */
  const groups = {};
  for (const l of d.loans) (groups[l.position || 'primary'] ||= []).push(l);
  const order = [...PR_POS_ORDER.filter(k => groups[k]),
    ...Object.keys(groups).filter(k => !PR_POS_ORDER.includes(k))];

  /* A dashed chip means nobody answered, which is not the same as "no". */
  const tri = (label, v) => '<span class="prtri ' + (v === true ? 'yes' : v === false ? 'no' : 'unk')
    + '">' + escS(label) + (v === true ? ' ✓' : v === false ? ' ✕' : ' ?') + '</span>';

  return order.map(pos =>
    '<div class="prgrouph">' + escS(PR_POS_LABEL[pos] || pos)
    + '<span class="cc">' + groups[pos].length + '</span></div>'
    + groups[pos].map(l => {
      const bits = [
        l.currentDebt ? prFull(l.currentDebt) + (l.currentDebtAsOf
          ? ' as of ' + String(l.currentDebtAsOf).slice(0, 10) : '') : 'no balance recorded',
        l.interestRatePct != null ? (l.interestRatePct * 100).toFixed(2) + '%'
          : (l.interestRate || null),
        l.maturityDate ? 'matures ' + String(l.maturityDate).slice(0, 10) : null,
        l.dscr != null ? 'DSCR ' + l.dscr : null
      ].filter(Boolean);
      const here = l.collateral.filter(c => c.here).length;
      const elsewhere = l.collateral.length - here;
      const st = String(l.status || '').toLowerCase();
      return '<div class="prlcard">'
        + '<div class="prltop"><b>' + escS(l.name) + '</b>'
        +   '<span class="prpill ' + (st === 'active' ? 'active' : st === 'pending' ? 'pending' : 'off')
        +   '">' + escS(l.status) + '</span>'
        +   (l.lender ? '<span class="prtri">' + escS(l.lender) + '</span>' : '')
        + '</div>'
        + '<div class="prlsum">' + escS(bits.join(' · ')) + '</div>'
        + '<div class="prchiprow">'
        +   tri('Escrow', l.hasEscrow) + tri('Taxes', l.escrowTaxes)
        +   tri('Insurance', l.escrowInsurance) + tri('Reserve', l.escrowReserve)
        +   tri('Extension', l.extensionAvailable) + tri('TIF', l.isTif)
        +   (l.recourse ? '<span class="prtri">' + escS(l.recourse) + '</span>' : '')
        + '</div>'
        /* Collateral elsewhere is the thing you cannot see from this property and
           most need to know: the same loan securing another building. */
        + '<div class="prcollat">Secured on ' + here + ' here'
        +   (elsewhere ? ' and ' + elsewhere + ' elsewhere: '
              + escS(l.collateral.filter(c => !c.here).map(c => c.name).join(', ')) : '')
        + '</div>'
        + '<div class="prfgrid">' + (() => {
            const q = PD.fq.trim().toLowerCase();
            return Object.keys(l.fields).map(k => l.fields[k])
              .filter(f => !q || String(f.name).toLowerCase().includes(q))
              .filter(f => q || !PD.hideEmpty || prdHas(f))
              .map(prdField).join('');
          })()
        + '</div></div>';
    }).join('')).join('');
}

function prdFinancials(){
  const d = PD.data;
  if (!d.financials.length) {
    return '<div class="prtabempty"><b>No financial snapshots</b>'
      + '<small>NOI, EGI, occupancy and cap rate come from property_financials, and this '
      + 'property has no rows there yet. The market value on the Summary tab is the one on '
      + 'the property record itself.</small></div>';
  }
  /* Oldest first for the chart, newest first for the table: a series reads left
     to right, a list reads most-recent-first. */
  const rows = d.financials.slice();
  const series = rows.slice().reverse();
  const n = series.length;

  const line = (pick, colour) => {
    const vals = series.map(pick).map(v => Number(v || 0));
    const max = Math.max(...vals, 1);
    if (n === 1) {
      return '<circle cx="50%" cy="' + (84 - vals[0] / max * 74).toFixed(1) + '" r="3" fill="'
        + colour + '"></circle>';
    }
    const pts = vals.map((v, i) =>
      (i / (n - 1) * 100).toFixed(2) + '%,' + (84 - v / max * 74).toFixed(1)).join(' ');
    return '<polyline points="' + pts + '" fill="none" stroke="' + colour
      + '" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"></polyline>';
  };

  const chart = '<div class="prchartbox">'
    + '<div class="prckey">'
    +   '<span><i style="background:var(--brass)"></i>Market value</span>'
    +   '<span><i style="background:var(--jade)"></i>NOI</span>'
    +   '<span style="margin-left:auto;font-family:var(--ff-mono);font-size:10px;color:var(--dimmer)">'
    +     escS(String(series[0].as_of_date || '').slice(0, 10)) + ' → '
    +     escS(String(series[n - 1].as_of_date || '').slice(0, 10)) + '</span>'
    + '</div>'
    /* Two series on one axis each scaled to its own maximum: they differ by two
       orders of magnitude, and a shared axis would flatten NOI into the floor.
       Shape is the question here, not comparison. */
    + '<svg class="prcsvg" viewBox="0 0 100 84" preserveAspectRatio="none">'
    +   line(f => f.current_market_value, 'var(--brass)')
    +   line(f => f.noi, 'var(--jade)')
    + '</svg></div>';

  const num = v => v == null || v === '' ? '—' : prMoney(v);
  const pct = v => v == null || v === '' ? '—' : (Number(v) * 100).toFixed(1) + '%';

  const table = '<div class="prftab">'
    + '<div class="prfhd"><span>As of</span><span>Market value</span><span>NOI</span>'
    +   '<span>Cap</span><span>Occ</span><span>DCR</span></div>'
    + rows.map(f => '<div class="prfrw" data-prdfin="' + escS(f.id) + '">'
        + '<span>' + escS(String(f.as_of_date || '').slice(0, 10) || '—') + '</span>'
        + '<span>' + num(f.current_market_value) + '</span>'
        + '<span>' + num(f.noi) + '</span>'
        + '<span>' + pct(f.cap_rate) + '</span>'
        + '<span>' + (f.occupancy == null || f.occupancy === '' ? '—'
            : (Number(f.occupancy) > 1 ? Number(f.occupancy).toFixed(0) + '%' : pct(f.occupancy))) + '</span>'
        + '<span>' + (f.dcr == null || f.dcr === '' ? '—' : Number(f.dcr).toFixed(2)) + '</span>'
        + '</div>').join('')
    + '</div>';

  /* The newest snapshot's own fields, editable, under the summary of all of
     them: the one anybody actually corrects is the latest. */
  const latest = rows[0];
  const detail = '<div class="prsect" style="margin-top:16px">'
    + '<div class="prsecth"><b>Snapshot ' + escS(String(latest.as_of_date || '').slice(0, 10))
    +   '</b><span class="cnt">' + prdCount(latest.fields) + '</span></div>'
    + '<div class="prfgrid">' + Object.keys(latest.fields).map(k => latest.fields[k])
        .filter(f => !PD.hideEmpty || prdHas(f)).map(prdField).join('') + '</div></div>';

  return chart + table + detail;
}

function prdBuildings(){
  const d = PD.data;
  if (!d.buildings.length) {
    return '<div class="prtabempty"><b>No buildings recorded</b>'
      + '<small>Apartments are counted from the buildings, so a property with none has no '
      + 'trustworthy unit count. Add one to start recording them.</small>'
      + '<button class="tgl" data-prdaddbuilding="1" style="margin-top:12px">+ Building</button></div>';
  }
  const q = PD.fq.trim().toLowerCase();
  const list = q ? d.buildings.filter(b => b.name.toLowerCase().includes(q)) : d.buildings;
  return list.map(b => {
    const owner = (b.owners.find(o => o.primary) || {}).name;
    const filled = Object.keys(b.fields).filter(k => prdHas(b.fields[k])).length;
    return '<button class="prbrow" data-prdunit="' + escS(b.id) + '">'
      + '<span class="bn">' + prdMark(b.name)
      +   '<small>' + (owner ? escS(owner) + ' · ' : '') + filled + ' fields filled</small></span>'
      + '<span class="bu">' + (b.units ? b.units + ' units' : '—') + '</span>'
      + '<span class="go">›</span></button>';
  }).join('')
    + '<button class="tgl" data-prdaddbuilding="1" style="margin-top:6px">+ Building</button>';
}

function prdMessages(){
  const list = PD.data.comments || [];
  return (list.length
      ? list.map(c => '<div class="prmsg"><div class="mh"><b style="color:var(--dim)">'
          + escS(c.author) + '</b><span>' + (c.at ? tkRel(c.at) : '') + '</span></div>'
          + '<p>' + escS(c.body) + '</p></div>').join('')
      : '<div class="prtabempty"><b>No messages yet</b>'
        + '<small>Notes here stay with the property. Six months from now the reason a number '
        + 'changed is worth more than the number.</small></div>')
    + '<div class="prmform"><textarea id="prd-comment" rows="2" '
    +   'placeholder="Add a message / comment…">' + escS(PD.comment) + '</textarea>'
    + '<button class="tgl" id="prd-post"' + (PD.posting ? ' disabled' : '') + '>'
    +   (PD.posting ? 'Posting…' : 'Post') + '</button></div>';
}

/* ---------- drawing ---------- */

function prdDraw(){
  const head = document.getElementById('pr-phead');
  const tools = document.getElementById('pr-ptools');
  const body = document.getElementById('pr-pbody');
  if (!head || !body) return;

  if (PD.error) {
    head.innerHTML = '<div class="prptop"><div style="flex:1"><h3>Could not read this property</h3></div>'
      + '<button class="tgl" data-prdclose="1">Close</button></div>';
    tools.innerHTML = '';
    body.innerHTML = '<div class="prtabempty"><b>' + escS(PD.error) + '</b>'
      + '<small>The record is in Supabase; the list you came from may be cached.</small></div>';
    wirePrd();
    return;
  }
  if (!PD.data) {
    head.innerHTML = '<div class="prptop"><div style="flex:1"><h3>Reading the record…</h3>'
      + '<div class="prcrumb">Fields, loans, buildings, financials and messages</div></div>'
      + '<button class="tgl" data-prdclose="1">Close</button></div>';
    tools.innerHTML = '';
    body.innerHTML = '';
    wirePrd();
    return;
  }

  head.innerHTML = prdHead();

  /* The field tools only make sense where there are fields. */
  const fieldy = ['summary', 'loans', 'financials', 'buildings'].includes(PD.tab);
  const scope = PD.unit ? (PD.data.buildings.find(b => b.id === PD.unit) || {}).fields
    : PD.data.fields;
  tools.className = fieldy ? 'prptools' : '';
  tools.innerHTML = fieldy
    ? '<input type="text" id="prd-fq" placeholder="Find a field" value="' + escS(PD.fq) + '">'
      + '<label class="prtgl"><input type="checkbox" id="prd-hide"'
      +   (PD.hideEmpty ? ' checked' : '') + '> Hide empty</label>'
      + '<span class="prpcount">' + (PD.tab === 'summary' && scope ? prdCount(scope) : '') + '</span>'
    : '';

  body.innerHTML = PD.tab === 'loans' ? prdLoans()
    : PD.tab === 'financials' ? prdFinancials()
    : PD.tab === 'buildings' ? prdBuildings()
    : PD.tab === 'messages' ? prdMessages()
    : prdSummary();

  wirePrd();
}

function wirePrd(){
  const panel = document.getElementById('pr-panel');
  if (!panel) return;

  panel.querySelectorAll('[data-prdclose]').forEach(b => b.onclick = prClosePanel);
  panel.querySelectorAll('[data-prdtab]').forEach(b => b.onclick = () => {
    PD.tab = b.dataset.prdtab; PD.editing = null; prdDraw();
  });
  panel.querySelectorAll('[data-prdunit]').forEach(b => b.onclick = () => {
    PD.unit = b.dataset.prdunit || null;
    PD.tab = 'summary'; PD.editing = null; PD.fq = '';
    prdDraw();
  });
  /* An entity in the breadcrumb takes you back to the list with it open. */
  panel.querySelectorAll('[data-prdent]').forEach(b => b.onclick = () => {
    PR.open = b.dataset.prdent;
    prClosePanel();
    drawProperties();
  });

  panel.querySelectorAll('[data-prdedit]').forEach(el => el.onclick = () => {
    if (PD.busy) return;
    const id = el.dataset.prdedit;
    const f = prdFind(id);
    if (!f) return;
    PD.editing = id;
    PD.err = null;
    PD.draft = prdRaw(f);
    prdDraw();
    const input = panel.querySelector('[data-prdinput]');
    if (input) { input.focus(); if (input.select) input.select(); }
  });

  const input = panel.querySelector('[data-prdinput]');
  if (input) {
    input.oninput = () => { PD.draft = input.value; };
    input.onkeydown = e => {
      if (e.key === 'Escape') { PD.editing = null; PD.err = null; prdDraw(); }
      if (e.key === 'Enter') { e.preventDefault(); prdSave(PD.editing, input.value); }
    };
    /* A select commits on change: picking an option is the decision, and asking
       for a second click to confirm it is a click that carries nothing. */
    if (input.tagName === 'SELECT') input.onchange = () => prdSave(PD.editing, input.value);
  }
  panel.querySelectorAll('[data-prdsave]').forEach(b => b.onclick = () => {
    const box = panel.querySelector('[data-prdinput]');
    prdSave(b.dataset.prdsave, box ? box.value : PD.draft);
  });
  panel.querySelectorAll('[data-prdcancel]').forEach(b => b.onclick = () => {
    PD.editing = null; PD.err = null; prdDraw();
  });

  panel.querySelectorAll('[data-prdowner]').forEach(sel => sel.onchange = () =>
    prdSave(sel.dataset.prdowner, sel.value));
  panel.querySelectorAll('[data-prdaddowner]').forEach(sel => sel.onchange = () => {
    if (!sel.value) return;
    prdOwner('POST', '/owners', PD.unit ? { entityId: sel.value, unitId: PD.unit }
      : { entityId: sel.value });
  });
  panel.querySelectorAll('[data-prdrm]').forEach(b => b.onclick = () =>
    prdOwner('DELETE', '/owners/' + encodeURIComponent(b.dataset.prdrm)
      + (PD.unit ? '?unitId=' + encodeURIComponent(PD.unit) : '')));

  const fq = panel.querySelector('#prd-fq');
  if (fq) fq.oninput = () => {
    PD.fq = fq.value;
    prdDraw();
    const again = document.getElementById('prd-fq');
    if (again) { again.focus(); again.setSelectionRange(again.value.length, again.value.length); }
  };
  const hide = panel.querySelector('#prd-hide');
  if (hide) hide.onchange = () => { PD.hideEmpty = hide.checked; prdDraw(); };

  const box = panel.querySelector('#prd-comment');
  if (box) {
    box.oninput = () => { PD.comment = box.value; };
    box.onkeydown = e => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); prdPost(); }
    };
  }
  const post = panel.querySelector('#prd-post');
  if (post) post.onclick = prdPost;

  panel.querySelectorAll('[data-prdaddbuilding]').forEach(b => b.onclick = () => prAddBuilding());
}

/* Find a field by its id across everything the panel can show. The id is the
   only handle a click carries, and the field could be on the property, a
   building, a loan or a snapshot. */
function prdFind(id){
  const d = PD.data;
  if (!d) return null;
  const scan = map => { for (const k of Object.keys(map || {})) if (map[k].id === id) return map[k]; return null; };
  return scan(d.fields)
    || d.buildings.reduce((a, b) => a || scan(b.fields), null)
    || d.loans.reduce((a, l) => a || scan(l.fields), null)
    || d.financials.reduce((a, f) => a || scan(f.fields), null);
}

function prAddBuilding(){
  prForm({
    title: 'New building',
    note: 'Apartments are counted from the buildings, so this is where a unit count becomes real.',
    fields: [['name', 'Name or identifier', 'text', null, 'Building A']],
    submit: 'Create building',
    onSubmit: async v => {
      if (!v.name) return 'A building needs a name.';
      try {
        const r = await fetch('/api/portfolio/' + encodeURIComponent(PD.id) + '/building', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: v.name })
        });
        const j = await r.json();
        if (!r.ok) return j.error || ('create failed (' + r.status + ')');
        toast('Created ' + v.name);
        await prdLoad();
        prLoad(true);
        return null;
      } catch (err) { return err.message; }
    }
  });
}

/* moved into mount() */

/* ---- mounting ----------------------------------------------------------

   command-center's markup is in the document from first paint, so it wired
   itself at parse time. The portal builds a view when you navigate to it, so
   the two element-level listeners that ran at the bottom of the original file
   move in here, where the elements exist.

   They are `.onclick =` rather than addEventListener on purpose: mount() runs
   on every navigation back to Properties, and addEventListener would stack a
   fresh copy each time — N listeners, N refreshes per click. That is the same
   bug the users screen hit with its focus listener.

   The keydown handler is document-level and binds exactly once, guarded, for
   the same reason. */

const MARKUP = `
  <div class="prhead">
    <div><h1 class="prtitle">Properties</h1><p class="prsub" id="pr-sub">Reading the portfolio\u2026</p></div>
    <div class="prheadtools">
      <span class="prstate" id="pr-state"></span>
      <button class="prbtn" id="pr-refresh">Refresh</button>
    </div>
  </div>
  <div id="pr-body"></div>
  <div class="prscrim" id="pr-scrim"></div>
  <aside class="prpanel" id="pr-panel" aria-hidden="true">
    <div class="prphead" id="pr-phead"></div>
    <div id="pr-ptools"></div>
    <div class="prpbody" id="pr-pbody"></div>
  </aside>`;

let keysBound = false;

function mount(host){
  if (!host) return;
  host.innerHTML = MARKUP;

  const refresh = host.querySelector('#pr-refresh');
  if (refresh) refresh.onclick = () => prLoad(true);
  const scrim = host.querySelector('#pr-scrim');
  if (scrim) scrim.onclick = prClosePanel;

  if (!keysBound) {
    keysBound = true;
    document.addEventListener('keydown', e => {
      if (e.key !== 'Escape') return;
      if (PD.id && !PD.editing) prClosePanel();
    });
  }

  /* A return visit repaints from what is already loaded — the fetch is
     five-minute cached server-side anyway, and redrawing from state keeps the
     open band and the filters the reader left set. */
  if (PR.data) drawProperties(); else prLoad();
}

/* portal-realtime.js calls this when Supabase says property, unit, loan or
   entity changed. It forces past the server's cache, which is the point: a
   stale read here is a wrong debt figure, not a slow one. */
function invalidate(){
  if (document.getElementById('pr-body')) prLoad(true);
  else { PR.loaded = false; PR.data = null; }
}

return { mount, invalidate, reload: prLoad, state: PR };
})();
