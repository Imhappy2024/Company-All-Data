/* ===========================================================================
   test-users-roles.js - Step 4: the Users & Roles screen.

   Drives the real portal.html + portal-users.js in a real browser, with
   portal-session.js stubbed (no Supabase here) and /api/access/* served by a fake
   so the whole component runs against realistic payloads.

   What it guards is what the UI OFFERS. The database refuses over-granting, an
   admin editing itself, granting Owner and Exec-for-a-plain-user by trigger, so
   these checks are about nobody being able to assemble a grant that would bounce -
   and about the refusal being shown verbatim when one does.

   It also guards the role gate, which is the one exception to "add a nav item, add
   its catalog row": `access` exists in the catalog only under Executive Board, so
   the per-brand item is shown on dash_role() alone.

   Expectations are written from the intended behaviour, not read off the code.
   =========================================================================== */
const http = require('http');
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const { chromium } = require(path.join(ROOT, 'node_modules', 'playwright'));

const PORT = 4381;
const BASE = `http://localhost:${PORT}`;
const LW = 'c0000000-0000-4000-8000-000000000003';
const LEADLI = 'c0000000-0000-4000-8000-000000000001';

/* ---- the catalog, as dashboard_module holds it (subset, enough to gate on) --- */
const MODULES = [
  { id: 'm1', company_id: null, module_key: 'executive', nav_id: 'exec', label: 'Executive', sort: 10 },
  { id: 'm2', company_id: null, module_key: 'financials', nav_id: 'financials', label: 'Financials', sort: 50 },
  { id: 'm3', company_id: null, module_key: 'access', nav_id: 'access', label: 'Users & Roles', sort: 80 },
  { id: 'm4', company_id: LW, module_key: 'overview', nav_id: 'overview', label: 'Overview', sort: 5 },
  { id: 'm5', company_id: LW, module_key: 'properties', nav_id: 'properties', label: 'Properties', sort: 10 },
  { id: 'm6', company_id: LW, module_key: 'loans', nav_id: 'loans', label: 'Loans', sort: 20 },
  { id: 'm7', company_id: LEADLI, module_key: 'overview', nav_id: 'overview', label: 'Overview', sort: 5 },
  { id: 'm8', company_id: LEADLI, module_key: 'leads', nav_id: 'leads', label: 'Leads', sort: 10 },
];

/* ---- staff, as GET /api/access/users returns them ------------------------- */
const USERS = [
  { id: 's-owner', full_name: 'Chris Owner', email: 'owner@x.invalid', avatar_url: null,
    is_active: true, role: 'owner', pending: false, grants: [] },
  { id: 's-admin', full_name: 'Ada Admin', email: 'admin@x.invalid', avatar_url: null,
    is_active: true, role: 'admin', pending: false,
    grants: [{ id: 'g1', company_id: LW, module: '*', level: 'write' }] },
  { id: 's-user', full_name: 'Ute User', email: 'user@x.invalid', avatar_url: null,
    is_active: true, role: 'user', pending: false,
    grants: [{ id: 'g2', company_id: LW, module: 'properties', level: 'read' }] },
  { id: 's-leadli', full_name: 'Leo Leadli', email: 'leo@x.invalid', avatar_url: null,
    is_active: true, role: 'user', pending: false,
    grants: [{ id: 'g3', company_id: LEADLI, module: 'leads', level: 'write' }] },
  /* Invited, link not yet clicked: dashboard_access true, user_id still null. */
  { id: 's-pending', full_name: 'Pat Pending', email: 'pat@x.invalid', avatar_url: null,
    is_active: true, role: 'user', pending: true,
    grants: [{ id: 'g4', company_id: LW, module: 'overview', level: 'read' }] },
];

/* Staff WITHOUT dashboard access - the add-person picker's source. These must never
   appear in the users list; that is the whole point of the change. */
const CANDIDATES = [
  { id: 'c-mitch', full_name: 'Mitch Existing', email: 'mitch@x.invalid', avatar_url: null },
  { id: 'c-jane', full_name: 'Jane Nodash', email: 'jane@x.invalid', avatar_url: null },
];

let lastPatch = null;
let lastInvite = null;
let patchShouldFail = null;

const MIME = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css',
               '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  let p = u.pathname;
  const json = (code, obj) => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(obj));
  };
  if (p === '/api/access/modules') return json(200, { modules: MODULES });
  if (p === '/api/access/candidates') return json(200, { candidates: CANDIDATES });
  if (p.startsWith('/api/access/grants/')) {
    /* Grants survive a revoke, so re-granting shows what is coming back. */
    const id = p.split('/').pop();
    return json(200, { grants: id === 'c-mitch'
      ? [{ company_id: LW, module: 'properties', level: 'read' }] : [] });
  }
  if (p === '/api/access/invite' && req.method === 'POST') {
    let body = '';
    req.on('data', c => { body += c; });
    return req.on('end', () => {
      lastInvite = JSON.parse(body || '{}');
      json(200, { ok: true, staff_id: 's-new', email: lastInvite.email, pending: true });
    });
  }
  if (p === '/api/access/users') {
    const company = u.searchParams.get('company');
    let users = USERS;
    if (company) {
      users = USERS.filter(x => x.role === 'owner' || x.grants.some(g => g.company_id === company));
    }
    return json(200, { users, scope: company || 'exec' });
  }
  if (p.startsWith('/api/access/user/') && req.method === 'PATCH') {
    let body = '';
    req.on('data', c => { body += c; });
    return req.on('end', () => {
      lastPatch = { id: p.split('/').pop(), body: JSON.parse(body || '{}') };
      if (patchShouldFail) return json(400, { error: patchShouldFail });
      json(200, { ok: true });
    });
  }
  if (p.startsWith('/api/')) return json(503, { error: 'offline in tests' });
  if (p === '/') p = '/portal.html';
  if (p === '/ops') p = '/index.html';
  for (const f of [path.join(ROOT, 'public', p), path.join(ROOT, p), path.join(ROOT, 'test', p)]) {
    if (fs.existsSync(f) && fs.statSync(f).isFile()) {
      res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'text/plain' });
      return res.end(fs.readFileSync(f));
    }
  }
  res.writeHead(404); res.end('nope');
});

let failures = 0;
function check(name, actual, want) {
  const a = JSON.stringify(actual), w = JSON.stringify(want);
  const ok = a === w;
  if (!ok) failures++;
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name +
    (ok ? '  ' + a : '\n          expected ' + w + '\n          actual   ' + a));
}

const OWNER_ACCESS = {
  user: { id: 's-owner', email: 'owner@x.invalid', full_name: 'Chris Owner', avatar_url: null, role: 'owner' },
  companies: { [LW]: 'LeavenWealth', [LEADLI]: 'Leadli AI' },
  access: {
    exec: { exec: 'write', financials: 'write', access: 'write' },
    [LW]: { overview: 'write', properties: 'write', loans: 'write' },
    [LEADLI]: { overview: 'write', leads: 'write' },
  },
};
/* An admin holding LeavenWealth only, and no Exec. */
const ADMIN_ACCESS = {
  user: { id: 's-admin', email: 'admin@x.invalid', full_name: 'Ada Admin', avatar_url: null, role: 'admin' },
  companies: { [LW]: 'LeavenWealth' },
  access: { [LW]: { overview: 'write', properties: 'write', loans: 'write' } },
};
/* A plain user - must not see the screen at all. */
const USER_ACCESS = {
  user: { id: 's-user', email: 'user@x.invalid', full_name: 'Ute User', avatar_url: null, role: 'user' },
  companies: { [LW]: 'LeavenWealth' },
  access: { [LW]: { overview: 'read', properties: 'read' } },
};

function stub(payload) {
  return `window.PortalSession = {
    enforceRememberWindow: function(){ return Promise.resolve(false); },
    getSession: function(){ return Promise.resolve({ user: { id: 'u' } }); },
    access: function(){ return Promise.resolve(${JSON.stringify(payload)}); },
    client: function(){ return Promise.resolve({ auth: {
      onAuthStateChange: function(){},
      getSession: function(){ return Promise.resolve({ data: { session: { access_token: 'fake-jwt' } } }); } } }); },
    signOut: function(){ return Promise.resolve(); },
    isRemembered: function(){ return false; },
    config: function(){ return Promise.resolve({ url: 'http://stub', anonKey: 'stub' }); },
  };`;
}

(async () => {
  await new Promise(r => server.listen(PORT, r));
  const browser = await chromium.launch(
    process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
  const errors = [];

  async function open(payload, hash) {
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 950 } });
    const page = await ctx.newPage();
    page.on('pageerror', e => errors.push(String(e)));
    await page.route('**/portal-session.js', r => r.fulfill({
      status: 200, contentType: 'application/javascript', body: stub(payload) }));
    await page.goto(BASE + (hash || ''), { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.dashAccess !== null, { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(300);
    return { ctx, page };
  }
  const navIds = p => p.evaluate(() => visibleMenu(brand).filter(x => x.id).map(x => x.id));

  try {
    /* ------------------------------------------------- the role gate */
    console.log('\nUsers & Roles is role-gated, not permission-gated');
    let { ctx, page } = await open(USER_ACCESS);
    check('a plain user does not see it in any workspace', (await navIds(page)).indexOf('access'), -1);
    check('and cannot route to it', await page.evaluate(() => { setView('access'); return view; }), 'overview');
    await ctx.close();

    ({ ctx, page } = await open(ADMIN_ACCESS));
    check('an admin sees it even with NO access catalog row for the company',
      (await navIds(page)).indexOf('access') >= 0, true);
    check('the Admin section heading appears with it',
      await page.evaluate(() => visibleMenu(brand).some(x => x.lbl === 'Admin')), true);
    await ctx.close();

    /* --------------------------------------------------- scope filter */
    console.log('\nOne component, two scopes');
    ({ ctx, page } = await open(OWNER_ACCESS, '#brand=all&view=access'));
    await page.waitForSelector('.pu-row[data-id]', { timeout: 8000 });
    check('Executive Board lists everyone with dashboard access',
      await page.$$eval('.pu-row[data-id]', r => r.map(x => x.getAttribute('data-id'))),
      ['s-owner', 's-admin', 's-user', 's-leadli', 's-pending']);
    check('and NOT staff who have no dashboard access',
      await page.evaluate(() => /Mitch Existing|Jane Nodash/.test(document.body.textContent)), false);
    check('it says where those people live instead',
      await page.$eval('.pu-head-s', e => /Team directory/.test(e.textContent)), true);
    check('with a Reaches column',
      await page.$eval('.pu-hrow', e => /Reaches/.test(e.textContent)), true);
    check('the owner is described as reaching everything',
      await page.$eval('.pu-row[data-id="s-owner"] .pu-reach', e => e.textContent.trim()), 'All workspaces');

    await page.evaluate(() => { setBrand('leadli'); setView('access'); });
    await page.waitForTimeout(400);
    check('inside a business, only people who reach it',
      await page.$$eval('.pu-row[data-id]', r => r.map(x => x.getAttribute('data-id'))),
      ['s-owner', 's-leadli']);
    check('scope filtering still applies on top of the access filter',
      await page.evaluate(() => /Pat Pending/.test(document.body.textContent)), false);
    check('and the column becomes what they hold HERE',
      await page.$eval('.pu-hrow', e => /Access here/.test(e.textContent)), true);
    await ctx.close();

    /* ------------------------------------------- what an owner may offer */
    console.log('\nAn owner may offer all three roles and every business');
    ({ ctx, page } = await open(OWNER_ACCESS, '#brand=all&view=access'));
    await page.waitForSelector('.pu-row[data-id="s-user"]');
    await page.click('.pu-row[data-id="s-user"] [data-act="edit"]');
    await page.waitForSelector('.pu-drawer');
    await page.click('[data-act="step"][data-step="2"]');
    check('all three role cards', await page.$$eval('.pu-card', c => c.map(x => x.getAttribute('data-role'))),
      ['owner', 'admin', 'user']);
    await page.click('[data-act="step"][data-step="3"]');
    check('every business plus Executive Board is offered',
      await page.$$eval('.pu-scope input[data-act="scope"]', c => c.map(x => x.getAttribute('data-scope'))),
      ['exec', LW, LEADLI]);

    console.log('\nExecutive Board is not offered to a User');
    check('the Exec checkbox is disabled while the role is User',
      await page.$eval('.pu-scope input[data-scope="exec"]', e => e.disabled), true);
    check('and the reason is given, not just the block',
      await page.$eval('.pu-scope', e => /Administrator or Owner/.test(e.textContent)), true);

    console.log('\nSwitching Admin -> User clears any Executive Board selection');
    await page.click('[data-act="step"][data-step="2"]');
    await page.click('[data-act="role"][data-role="admin"]');
    await page.click('[data-act="step"][data-step="3"]');
    await page.check('.pu-scope input[data-scope="exec"]');
    check('Exec selected while Admin',
      await page.evaluate(() => !!PortalUsers._internals.ui.draft.grants.exec), true);
    await page.click('[data-act="step"][data-step="2"]');
    await page.click('[data-act="role"][data-role="user"]');
    check('cleared on dropping to User',
      await page.evaluate(() => !!PortalUsers._internals.ui.draft.grants.exec), false);
    await ctx.close();

    /* ------------------------------------------- what an admin may offer */
    console.log('\nAn admin is offered less than an owner');
    ({ ctx, page } = await open(ADMIN_ACCESS, '#brand=leavenwealth&view=access'));
    await page.waitForSelector('.pu-row[data-id]');
    check('no Owner role card', await (async () => {
      await page.click('.pu-row[data-id="s-user"] [data-act="edit"]');
      await page.waitForSelector('.pu-drawer');
      await page.click('[data-act="step"][data-step="2"]');
      return page.$$eval('.pu-card', c => c.map(x => x.getAttribute('data-role')));
    })(), ['admin', 'user']);
    await page.click('[data-act="step"][data-step="3"]');
    check('only the business the admin itself holds',
      await page.$$eval('.pu-scope input[data-act="scope"]', c => c.map(x => x.getAttribute('data-scope'))),
      [LW]);
    check('Leadli, which the admin does not hold, is not offered',
      /* LEADLI has to be passed in: the page context cannot see this file's consts. */
      await page.$$eval('.pu-scope input[data-act="scope"]',
        (c, id) => c.some(x => x.getAttribute('data-scope') === id), LEADLI),
      false);
    await page.click('[data-act="close"]');

    console.log('\nAn admin cannot edit its own row');
    check('no Edit control on their own row',
      await page.locator('.pu-row[data-id="s-admin"] [data-act="edit"]').count(), 0);
    check('and the reason is on the row, not discovered on save',
      await page.$eval('.pu-row[data-id="s-admin"] .pu-blocked', e => e.getAttribute('title')),
      'Admins cannot edit their own access. An owner has to do it.');
    await ctx.close();

    /* The mirror case, which needs the owner's own session to mean anything. */
    ({ ctx, page } = await open(OWNER_ACCESS, '#brand=all&view=access'));
    await page.waitForSelector('.pu-row[data-id="s-owner"]');
    check('an owner CAN edit their own row',
      await page.locator('.pu-row[data-id="s-owner"] [data-act="edit"]').count(), 1);
    check('and is marked as themselves',
      await page.$eval('.pu-row[data-id="s-owner"] .pu-you', e => e.textContent), 'you');
    await ctx.close();

    /* --------------------------------------------------- saving a diff */
    console.log('\nSaving sends the whole desired grant set');
    lastPatch = null;
    ({ ctx, page } = await open(OWNER_ACCESS, '#brand=all&view=access'));
    await page.waitForSelector('.pu-row[data-id="s-user"]');
    await page.click('.pu-row[data-id="s-user"] [data-act="edit"]');
    await page.waitForSelector('.pu-drawer');
    await page.click('[data-act="step"][data-step="3"]');
    /* Ute holds LeavenWealth > Properties at read. Raise it to write. */
    await page.click(`[data-act="level"][data-scope="${LW}"][data-mod="properties"][data-level="write"]`);
    await page.click('[data-act="save"]');
    await page.waitForTimeout(500);
    check('patched the right person', lastPatch && lastPatch.id, 's-user');
    check('role and name carried', lastPatch && [lastPatch.body.role, lastPatch.body.full_name],
      ['user', 'Ute User']);
    check('the raised level is in the payload',
      lastPatch && lastPatch.body.grants.filter(g => g.module === 'properties')[0],
      { company_id: LW, module: 'properties', level: 'write' });
    await ctx.close();

    /* ---------------------------------------- the refusal, shown verbatim */
    console.log('\nA database refusal is surfaced word for word');
    patchShouldFail = 'You cannot grant more access than you have';
    ({ ctx, page } = await open(OWNER_ACCESS, '#brand=all&view=access'));
    await page.waitForSelector('.pu-row[data-id="s-user"]');
    await page.click('.pu-row[data-id="s-user"] [data-act="edit"]');
    await page.waitForSelector('.pu-drawer');
    await page.click('[data-act="step"][data-step="3"]');
    await page.click(`[data-act="level"][data-scope="${LW}"][data-mod="loans"][data-level="write"]`);
    await page.click('[data-act="save"]');
    await page.waitForSelector('.pu-msg.bad', { timeout: 8000 });
    check('the exact message, not a generic failure',
      (await page.textContent('.pu-msg.bad')).trim(), patchShouldFail);
    check('the drawer stays open so the change is not lost',
      await page.locator('.pu-drawer').count(), 1);
    patchShouldFail = null;
    await ctx.close();

    /* ---------------------------------------------- catalog, not constants */
    console.log('\nModule lists come from the catalog, not a hard-coded list');
    ({ ctx, page } = await open(OWNER_ACCESS, '#brand=all&view=access'));
    await page.waitForSelector('.pu-row[data-id="s-user"]');
    await page.click('.pu-row[data-id="s-user"] [data-act="edit"]');
    await page.waitForSelector('.pu-drawer');
    await page.click('[data-act="step"][data-step="3"]');
    check('labels are the catalog labels, not nav ids',
      await page.$$eval(`.pu-scope .pu-mod-n`, e => e.map(x => x.textContent)).then(a => a.slice(0, 3)),
      ['Overview', 'Properties', 'Loans']);
    check('and the tri-state offers None / Read / Read & Write',
      await page.$$eval('.pu-mod:first-child .pu-tri-b', b => b.map(x => x.textContent)),
      ['None', 'Read', 'Read & Write']);
    await ctx.close();

    /* ------------------------------------------------------ pending badge */
    console.log('\nInvited-not-accepted is shown, because user_id is still null');
    ({ ctx, page } = await open(OWNER_ACCESS, '#brand=all&view=access'));
    await page.waitForSelector('.pu-row[data-id="s-pending"]');
    check('Pending badge on the invited person',
      await page.$eval('.pu-row[data-id="s-pending"] .pu-pending', e => e.textContent), 'Pending');
    check('and it explains itself on hover',
      await page.$eval('.pu-row[data-id="s-pending"] .pu-pending', e => e.getAttribute('title')),
      'Invited, but the invitation has not been accepted yet');
    check('nobody who has accepted is marked pending',
      await page.locator('.pu-row[data-id="s-user"] .pu-pending').count(), 0);

    /* ------------------------------------------------------------- revoke */
    console.log('\nRevoke removes access without deleting the staff record');
    check('a Revoke control exists on other people',
      await page.locator('.pu-row[data-id="s-user"] [data-act="revoke"]').count(), 1);
    check('but never on your own row',
      await page.locator('.pu-row[data-id="s-owner"] [data-act="revoke"]').count(), 0);
    let confirmText = null;
    page.once('dialog', d => { confirmText = d.message(); d.accept(); });
    lastPatch = null;
    await page.click('.pu-row[data-id="s-user"] [data-act="revoke"]');
    await page.waitForTimeout(500);
    check('it confirms first', /Remove dashboard access/.test(confirmText || ''), true);
    check('and says the staff record survives',
      /staff record is NOT deleted/i.test(confirmText || ''), true);
    check('the request only turns access off',
      lastPatch && lastPatch.body, { dashboard_access: false });
    check('the role is NOT sent from the client - the server pairs it, per the constraint',
      lastPatch && 'role' in lastPatch.body, false);
    await ctx.close();

    /* ------------------------------------------------- the add-person picker */
    console.log('\nInvite user can pick an existing staff member');
    ({ ctx, page } = await open(OWNER_ACCESS, '#brand=all&view=access'));
    /* The page header owns this action. "New" on an access screen is ambiguous, and
       there is exactly one control for it - portal-users.js renders none of its own. */
    await page.waitForSelector('.page-h .btn');
    check('the action is named, not "New"',
      (await page.textContent('.page-h .btn')).trim(), 'Invite user');
    check('and there is only one of it', await page.locator('.page-h .btn').count(), 1);
    await page.click('.page-h .btn');
    await page.waitForSelector('.pu-drawer');
    check('the drawer header matches the button',
      (await page.textContent('.pu-dr-t')).trim(), 'Invite user');
    await page.waitForSelector('.pu-pick', { timeout: 8000 });
    check('candidates are staff WITHOUT dashboard access',
      await page.$$eval('.pu-pick', b => b.map(x => x.getAttribute('data-id'))),
      ['c-mitch', 'c-jane']);
    check('nobody already holding access is offered',
      await page.$$eval('.pu-pick', b => b.some(x => /Chris Owner|Ute User/.test(x.textContent))), false);

    await page.fill('#puPick', 'mitch');
    await page.waitForTimeout(200);
    check('typing filters the list',
      await page.$$eval('.pu-pick', b => b.map(x => x.getAttribute('data-id'))), ['c-mitch']);
    await page.click('.pu-pick[data-id="c-mitch"]');
    await page.waitForTimeout(200);
    check('picking records the existing staff id, so no second record is created',
      await page.evaluate(() => PortalUsers._internals.ui.draft.staff_id), 'c-mitch');
    check('and says so in as many words',
      await page.evaluate(() => /No second record is created/.test(document.body.textContent)), true);

    /* Revoke leaves grant rows in place, so re-granting hands them back. Six months
       is long enough for that to have become wrong, so it is shown, not restored
       quietly. */
    await page.waitForTimeout(400);
    check('previous access is shown before it is handed back',
      await page.evaluate(() => /previous access back/i.test(document.body.textContent)), true);
    check('itemised by catalog label, not module key',
      await page.evaluate(() => /Properties: Read/.test(document.body.textContent)), true);
    check('and pre-loaded into the draft so it can be changed',
      await page.evaluate(() => (PortalUsers._internals.ui.draft.grants[
        'c0000000-0000-4000-8000-000000000003'] || {}).properties), 'read');

    console.log('\nFree text is still allowed for someone genuinely new');
    await page.fill('#puPick', 'brand-new@example.invalid');
    await page.waitForTimeout(250);
    check('typing detaches the picked record',
      await page.evaluate(() => PortalUsers._internals.ui.draft.staff_id), null);
    check('and keeps the address as the intent',
      await page.evaluate(() => PortalUsers._internals.ui.draft.email), 'brand-new@example.invalid');
    /* The Send button only exists on step 3; steps 1 and 2 show Next. */
    await page.click('[data-act="step"][data-step="3"]');
    await page.waitForTimeout(200);
    const sendBtn = () => page.evaluate(() => {
      const b = [...document.querySelectorAll('.pu-dr-foot button')].pop();
      return { text: b.textContent.trim(), disabled: b.disabled, title: b.getAttribute('title') || '' };
    });
    check('an address is enough to send', (await sendBtn()).disabled, false);

    console.log('\nSending posts the invite');
    lastInvite = null;
    await page.click('[data-act="invite"]');
    await page.waitForTimeout(500);
    check('it called the invite endpoint', !!lastInvite, true);
    check('with the typed address and the chosen role',
      lastInvite && [lastInvite.email, lastInvite.role], ['brand-new@example.invalid', 'user']);
    check('and the drawer closed on success', await page.locator('.pu-drawer').count(), 0);
    check('with a message that explains Pending',
      /Pending until they open the link/.test(await page.textContent('.pu-msg')), true);

    console.log('\nNothing chosen means nothing to send');
    await page.click('.page-h .btn');
    await page.waitForSelector('.pu-drawer');
    await page.click('[data-act="step"][data-step="3"]');
    await page.waitForTimeout(200);
    const empty = await sendBtn();
    check('disabled with no person and no address', empty.disabled, true);
    check('and it says what is missing', /Choose a person or type an email/.test(empty.title), true);
    await ctx.close();

    console.log('\nRuntime errors');
    check('no page errors', errors, []);
  } catch (e) {
    console.error('\nTEST ERROR:', e.message);
    failures++;
  } finally {
    await browser.close().catch(() => {});
    server.close();
  }

  console.log(failures ? `\n${failures} CHECK(S) FAILED` : '\nAll checks passed');
  process.exit(failures ? 1 : 0);
})();
