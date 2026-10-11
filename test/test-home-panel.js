/* ===========================================================================
   test-home-panel.js - the Home task panel in a browser.

   Drives the real portal.html. /api/home/* is answered here from the saved
   task fixture (real tasks) and records every request, so the checks are on
   what the panel SENDS and what it SHOWS: a click opens the panel instead of
   leaving for ClickUp; the list's own statuses; a status, due date and
   assignee change reach ClickUp and move the row at once; a refusal is shown
   in ClickUp's words and the row goes back; comments load behind the logo
   loader, newest first, attachments as links; Ctrl+Enter posts; Esc closes.

   Expectations are written from the brief, not read off the code.
   =========================================================================== */
const http = require('http');
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const { chromium } = require(path.join(ROOT, 'node_modules', 'playwright'));

const PORT = 4391;
const SHOTS = process.argv.includes('--shots') ? path.join(ROOT, 'docs', 'screenshots', 'shell') : null;
const shot = async (pg, n) => { if (SHOTS) await pg.screenshot({ path: path.join(SHOTS, 'after-' + n + '.png') }); };
const BASE = `http://localhost:${PORT}`;
const LW = 'c0000000-0000-4000-8000-000000000003';
const FX = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'home-tasks.json'), 'utf8'));
FX.tasks.forEach(t => { t.listId = 'L-' + t.list.replace(/\W+/g, ''); t.spaceName = 'Asset Management'; t.folder = 'Operations';
  t.statusColor = '#87909e'; t.tags = t.id === '86bce80dn' ? ['loan', 'quarterly'] : []; t.created = 1780000000000; t.updated = 1790000000000; });
const TARGET = '86bce80dn';                // "BRENT VILLAGE: Quarterly Loan Report Requirements", Jay, due Nov 2026
const MEMBERS = [{ id: 'u-jay-delgado', name: 'Jay Delgado', initials: 'JD' }, { id: 'u-brian-nelson', name: 'Brian Nelson', initials: 'BN' },
                 { id: 'u-mitchell-hagen', name: 'Mitchell Hagen', initials: 'MH' }];
const STATUSES = [{ status: 'to do', color: '#87909e', type: 'open', orderindex: 0 }, { status: 'in progress', color: '#5f55ee', type: 'custom', orderindex: 1 },
                  { status: 'in review', color: '#f8ae00', type: 'custom', orderindex: 2 }, { status: 'complete', color: '#008844', type: 'closed', orderindex: 3, done: true }];
const COMMENTS = [
  { id: 'c1', author: 'Mitchell Hagen', at: 1791000000000, parts: [{ text: 'Older note' }] },
  { id: 'c2', author: 'Brian Nelson', at: 1792000000000, parts: [{ text: 'See ' }, { link: 'https://files.example/report.pdf', text: 'report.pdf', file: true }] },
];
let REFUSE = false;
const sent = [];
let commentsDelay = 900;

const MIME = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' };
const server = http.createServer((req, res) => {
  let p = req.url.split('?')[0];
  const json = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
  if (p === '/auth/me') return json(200, { user: { id: FX.me.id, username: FX.me.name } });
  if (p.startsWith('/api/home/')) {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      sent.push({ method: req.method, path: p, token: req.headers['x-clickup-token'] || null, body: body ? JSON.parse(body) : null });
      if (p === '/api/home/tasks') return json(200, FX);
      if (/\/list\/[^/]+\/statuses$/.test(p)) return json(200, { statuses: STATUSES });
      if (/\/list\/[^/]+\/members$/.test(p)) return json(200, { members: MEMBERS });
      if (/\/comments$/.test(p)) return setTimeout(() => json(200, { comments: COMMENTS.slice().sort((a, b) => b.at - a.at) }), commentsDelay);
      if (/\/comment$/.test(p)) { const b = JSON.parse(body); COMMENTS.push({ id: 'c' + (COMMENTS.length + 1), author: 'Jay Delgado', at: 1793000000000, parts: [{ text: b.comment_text }] }); return json(200, { ok: true }); }
      if (req.method === 'PUT') {
        if (REFUSE) return json(403, { error: 'You do not have permission to edit this task' });
        const t = FX.tasks.find(x => x.id === p.split('/').pop());   /* ClickUp keeps what it saved */
        const b = JSON.parse(body);
        if (b.status) t.status = b.status;
        if ('due_date' in b) t.due = b.due_date;
        if (b.assignees) {
          let a = (t.assignees || []).filter(x => !(b.assignees.rem || []).map(String).includes(String(x.id)));
          (b.assignees.add || []).forEach(id => a.push(MEMBERS.find(m => m.id === String(id)) || { id, name: String(id), initials: '?' }));
          t.assignees = a;
        }
        return json(200, { task: t });
      }
      return json(404, { error: 'unexpected ' + p });
    });
    return;
  }
  if (p.startsWith('/api/')) return json(503, { error: 'offline in tests' });
  if (p === '/') p = '/portal.html';
  for (const f of [path.join(ROOT, 'public', p)]) {
    if (fs.existsSync(f) && fs.statSync(f).isFile()) { res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'text/plain' }); return res.end(fs.readFileSync(f)); }
  }
  res.writeHead(404); res.end('not found');
});

let failures = 0;
function check(name, actual, want) {
  const a = JSON.stringify(actual), w = JSON.stringify(want), ok = a === w;
  if (!ok) failures++;
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (ok ? '' : '\n          expected ' + w + '\n          actual   ' + a));
}
const STUB = `window.PortalSession = {
  enforceRememberWindow: function(){ return Promise.resolve(false); },
  getSession: function(){ return Promise.resolve({ access_token: 'jwt' }); },
  access: function(){ return Promise.resolve({ user: { id: 's-jay', email: 'jay@x.invalid', full_name: 'Jay Delgado', role: 'admin' }, companies: {}, access: { '${LW}': { properties: 'write', team: 'write' } } }); },
  client: function(){ return Promise.resolve({ auth: { onAuthStateChange: function(){}, getSession: function(){ return Promise.resolve({ data: { session: { access_token: 'jwt' } } }); } } }); },
  authHeaders: function(x){ return Promise.resolve(Object.assign({ Authorization: 'Bearer jwt' }, x || {})); },
  getJson: function(u){ return fetch(u).then(function(r){ return r.json(); }); },
  signOut: function(){ return Promise.resolve(); },
};`;

(async () => {
  await new Promise(r => server.listen(PORT, r));
  const browser = await chromium.launch();
  const errors = [];
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.addInitScript(u => { try { localStorage.setItem('du_auth_token', 'person-token'); localStorage.setItem('du_auth_user', JSON.stringify(u)); } catch (e) { /* */ } }, { id: FX.me.id, username: FX.me.name });
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push(String(e)));
  await page.route('**/portal-session.js', r => r.fulfill({ status: 200, contentType: 'application/javascript', body: STUB }));
  const panelText = () => page.$eval('#hmPanel', e => e.innerText);
  const rowOf = id => page.$eval(`tr[data-hm-open="${id}"]`, e => [...e.cells].map(c => c.innerText.trim()));
  const groupOf = id => page.evaluate(i => { let g = null; for (const tr of document.querySelectorAll('.hm-tbl tbody tr')) { if (tr.classList.contains('hm-grp')) g = tr.querySelector('td > span').textContent; if (tr.getAttribute('data-hm-open') === i) return g; } return null; }, id);

  try {
    await page.goto(BASE + '/#brand=home&view=mine', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector(`tr[data-hm-open="${TARGET}"]`, { timeout: 10000 });

    console.log('\nA click opens the panel here, not ClickUp');
    const popup = [];
    page.on('popup', p => popup.push(p.url()));
    await page.click(`tr[data-hm-open="${TARGET}"] a`);
    await page.waitForSelector('.hm-panel');
    check('no new tab, no navigation', [popup.length, new URL(page.url()).pathname], [0, '/']);
    check('header: task name', await page.$eval('#hmPTitle', e => e.textContent), 'BRENT VILLAGE: Quarterly Loan Report Requirements');
    check('header: Space / Folder / List', await page.$eval('.hm-p-where', e => e.innerText.replace(/\s+/g, ' ')), "Asset Management / Operations / AM To-Do's");
    check('comments show the logo loader while they load, never "Loading..."', await page.evaluate(() =>
      [!!document.querySelector('#hmPanel .hm-c-list .ld-full, #hmPanel .hm-c-list [class*="ld-"]'), /Loading\.\.\./.test(document.getElementById('hmPanel').innerText)]), [true, false]);
    await page.waitForSelector('.hm-c', { timeout: 5000 });
    check('comments: newest first, author shown', await page.$$eval('.hm-c-meta b', e => e.map(x => x.textContent)), ['Brian Nelson', 'Mitchell Hagen']);
    check('attachments are links', await page.$eval('.hm-c a', a => [a.textContent.includes('report.pdf'), a.getAttribute('href'), a.target]), [true, 'https://files.example/report.pdf', '_blank']);
    await shot(page, 'home-panel');
    const kv = await page.$$eval('.hm-kv dt', e => e.map(x => x.textContent));
    check('details rows', kv, ['Status', 'Due', 'Assignees', 'Priority', 'Tags', 'Created', 'Updated']);
    check('tags and View in ClickUp', await page.evaluate(() => [[...document.querySelectorAll('.hm-tag')].map(x => x.textContent), document.querySelector('.hm-p-cu').getAttribute('href')]),
      [['loan', 'quarterly'], 'https://app.clickup.com/t/86bce80dn']);

    console.log('\nStatus: the list\'s own statuses, saved at once');
    await page.click('[data-p="status"]');
    await page.waitForSelector('.hm-menu button');
    check('options are the list\'s statuses with ClickUp colours', await page.$$eval('.hm-menu button', e => e.map(b => [b.getAttribute('data-v'), b.querySelector('.hm-dot').style.background])),
      [['to do', 'rgb(135, 144, 158)'], ['in progress', 'rgb(95, 85, 238)'], ['in review', 'rgb(248, 174, 0)'], ['complete', 'rgb(0, 136, 68)']]);
    await page.click('.hm-menu button[data-v="in progress"]');
    await page.waitForTimeout(150);
    const put1 = sent.filter(x => x.method === 'PUT').pop();
    check('sent to ClickUp with the person\'s own token', [put1.path, put1.body, put1.token], ['/api/home/task/' + TARGET, { status: 'in progress' }, 'person-token']);
    check('the row changed at once', (await rowOf(TARGET))[2], 'in progress');

    console.log('\nDue: editable, row moves group');
    check('starts in Later', await groupOf(TARGET), 'Later');
    await page.fill('.hm-due-in', '2026-10-14');
    await page.$eval('.hm-due-in', e => e.dispatchEvent(new Event('change', { bubbles: true })));
    await page.waitForTimeout(200);
    check('due_date sent', typeof sent.filter(x => x.method === 'PUT').pop().body.due_date, 'number');
    check('row moved to This week', await groupOf(TARGET), 'This week');
    await page.fill('.hm-due-in', '2026-10-01');
    await page.$eval('.hm-due-in', e => e.dispatchEvent(new Event('change', { bubbles: true })));
    await page.waitForTimeout(200);
    check('past date: Overdue group, red in the panel', [await groupOf(TARGET), await page.$eval('.hm-due-in', e => e.classList.contains('hm-overdue'))], ['Overdue', true]);

    console.log('\nAssign dialog');
    await page.click('[data-p="assign"]');
    await page.waitForSelector('.hm-dlg-m');
    await shot(page, 'home-assign');
    check('only members of that list, current ones ticked', await page.$$eval('.hm-dlg-m', e => e.map(l => [l.innerText.trim().split('\n').pop(), l.querySelector('input').checked])),
      [['Brian Nelson', false], ['Jay Delgado', true], ['Mitchell Hagen', false]]);
    await page.fill('.hm-dlg-q', 'bri');
    check('search filters', await page.$$eval('.hm-dlg-m', e => e.filter(l => !l.hidden).map(l => l.innerText.trim().split('\n').pop())), ['Brian Nelson']);
    await page.check('.hm-dlg-m:not([hidden]) input');
    await page.fill('.hm-dlg-q', '');
    await page.click('[data-p="assign-save"]');
    await page.waitForTimeout(200);
    check('add sent', sent.filter(x => x.method === 'PUT').pop().body, { assignees: { add: ['u-brian-nelson'], rem: [] } });
    check('names in the panel, initials in the row', [await page.$eval('.hm-kv dd:nth-of-type(3)', e => e.innerText.replace(' Edit', '')), (await rowOf(TARGET))[5].split(/\s+/).sort()],
      ['Jay Delgado, Brian Nelson', ['BN', 'JD']]);
    await page.click('[data-p="assign"]');
    await page.waitForSelector('.hm-dlg-m');
    await page.click('[data-p="assign-cancel"]');
    check('Cancel sends nothing', sent.filter(x => x.method === 'PUT').length, 4);

    console.log('\nA ClickUp refusal is shown, and the row goes back');
    REFUSE = true;
    await page.click('[data-p="status"]');
    await page.waitForSelector('.hm-menu button');
    await page.click('.hm-menu button[data-v="complete"]');
    await page.waitForSelector('.hm-p-err');
    check('ClickUp\'s message in the panel', /You do not have permission to edit this task/.test(await panelText()), true);
    check('row reverted', (await rowOf(TARGET))[2], 'in progress');
    REFUSE = false;

    console.log('\nMarking it complete takes it off Home');
    await page.click('[data-p="status"]');
    await page.waitForSelector('.hm-menu button');
    await page.click('.hm-menu button[data-v="complete"]');
    await page.waitForTimeout(250);
    check('the row is gone from My tasks, the panel stays open', [await page.$$eval(`tr[data-hm-open="${TARGET}"]`, e => e.length), await page.$$eval('.hm-panel', e => e.length)], [0, 1]);
    check('and the My tasks count dropped to 18', await page.$eval('#nav .nav-item .nav-count', e => e.textContent), '18');

    console.log('\nComments: Ctrl+Enter posts');
    commentsDelay = 50;
    await page.fill('.hm-c-in', 'Posted from Home');
    await page.press('.hm-c-in', 'Control+Enter');
    await page.waitForFunction(() => /Posted from Home/.test((document.querySelector('.hm-c') || {}).innerText || ''), null, { timeout: 5000 });
    const post = sent.find(x => x.method === 'POST');
    check('posted with the person\'s token', [post.path, post.body, post.token], ['/api/home/task/' + TARGET + '/comment', { comment_text: 'Posted from Home' }, 'person-token']);
    check('box cleared and newest on top', [await page.$eval('.hm-c-in', e => e.value), await page.$eval('.hm-c-meta b', e => e.textContent)], ['', 'Jay Delgado']);

    console.log('\nEsc closes');
    await page.keyboard.press('Escape');
    check('panel gone', await page.$$eval('.hm-panel', e => e.length), 0);
    check('nothing in capitals in the panel CSS', /text-transform:\s*uppercase/.test(fs.readFileSync(path.join(ROOT, 'public', 'portal-shell.css'), 'utf8').split('Home task panel')[1]), false);
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
