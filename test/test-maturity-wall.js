/* The maturity wall: two bugs that were only visible by MEASURING it.

   Reported as "there's a big empty space in the middle of the dash" on
   Properties > Debt. Two separate faults, both reproduced here before either
   was touched:

   1. THE AXIS RAN TO THE FURTHEST MATURITY. One loan due in 2056 drew 31
      columns of which 26 were empty, each bar 22px wide, with the year labels
      overlapping because thirty of them do not fit. It now shows ten years of
      detail plus ONE bucket for everything later, so no dollar leaves the
      chart.

   2. THE BARS WERE CALLED `.col`, AND portal.html OWNS THAT NAME. Its Property
      Tasks board defines `.col{background;border:1px solid;border-radius;
      padding:10px}`. That padding and border FLOOR every bar at 22px and add
      22px to every real one - so 26 empty columns rendered as 22px bordered
      panels side by side, one continuous band across the card. The inline
      style said `height:2px` and the browser reported 22px.

      Reasoning about the CSS did not find this and could not: the rule that
      broke it is in a different file, and the symptom is a height, not an
      error. The measurement found it in one run.

   So this test asserts BOX GEOMETRY, not markup: an empty column is 2px tall,
   the column count is bounded, and nothing overflows. A source check for the
   class name would not have caught fault 1, and a screenshot diff would not
   have said why either was wrong.

   Run: node test/test-maturity-wall.js
*/
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');

/* Maturities chosen to match the screenshot: bars at 2027, 2029, ~2042 and
   2049, one far-out loan in 2056, and nine undated. */
const YEARS = [
  ['2027-06-30', 36000000], ['2029-01-15', 14000000],
  ['2042-04-01', 16000000], ['2049-09-30', 34000000],
  ['2056-12-31', 4000000],
];
const loans = [];
YEARS.forEach(function (y, i) {
  loans.push({ id: 'l' + i, name: 'Loan ' + i, lender: i % 2 ? 'Northwest Bank' : null,
               maturity: y[0], balance: y[1], ratePct: 0.0597 });
});
for (var u = 0; u < 9; u++) {
  loans.push({ id: 'u' + u, name: 'Undated ' + u, lender: null,
               maturity: null, balance: 1000000, ratePct: null });
}

const props = [{
  id: 'prop-1', name: 'Park Place', ownershipStatus: 'held',
  marketValue: 256000000, debt: loans.reduce((a, l) => a + l.balance, 0),
  manager: null, state: 'NE', units: 3347, buildings: 264,
  loans: loans, buildingsList: [], fields: {}, parcels: [],
  entityId: 'e1', owners: ['e1'], buildings: [], noi: null, unitsVerified: 3347,
}];

/* The real shape: a FLAT properties array, plus entities and a tree whose
   nodes carry property ids. Nesting properties under entities - which is what
   the first attempt did - leaves the module reading 0 of 0. */
const PAYLOAD = {
  properties: props,
  entities: [{ id: 'e1', name: 'Partners of Park Place, LLC' }],
  tree: [{ id: 'e1', name: 'Partners of Park Place, LLC',
           properties: props.map(p => p.id), children: [] }],
  problems: [], generatedAt: new Date().toISOString(),
};

const server = http.createServer((req, res) => {
  const p = req.url.split('?')[0];
  if (p.indexOf('/api/portfolio') === 0) {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify(PAYLOAD));
  }
  if (p.indexOf('/api/') === 0) { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end('{}'); }
  if (p === '/portal-inline.css') {
    const html = fs.readFileSync(path.join(ROOT, 'public', 'portal.html'), 'utf8');
    res.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8' });
    return res.end([...html.matchAll(/<style>([\s\S]*?)<\/style>/g)].map(m => m[1]).join('\n'));
  }
  if (p === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(`<!doctype html><html data-theme="dark"><head><meta charset="utf-8">
      <link rel="stylesheet" href="/tokens.css"><link rel="stylesheet" href="/portal-inline.css">
      <link rel="stylesheet" href="/portal-properties.css"></head>
      <body><div class="content wide" style="padding:20px">
      <div id="propertiesNative"></div></div>
      <script src="/portal-properties.js"></script>
      <script>PortalProperties.mount(document.getElementById('propertiesNative'));</script>
      </body></html>`);
  }
  const f = path.join(ROOT, 'public', p);
  if (fs.existsSync(f) && fs.statSync(f).isFile()) {
    res.writeHead(200, { 'Content-Type': p.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8' });
    return res.end(fs.readFileSync(f));
  }
  res.writeHead(404); res.end('no');
});

(async () => {
  await new Promise(r => server.listen(4329, r));
  const b = await chromium.launch();
  const pg = await b.newPage({ viewport: { width: 1500, height: 950 } });
  const errs = [];
  pg.on('pageerror', e => errs.push(String(e.stack || e.message).split('\n').slice(0, 3).join(' | ')));
  await pg.goto('http://127.0.0.1:4329/', { waitUntil: 'networkidle' });
  await pg.waitForTimeout(600);
  console.log('page errors :', errs);

  /* Into Debt mode, the way the reader does. */
  const debt = pg.locator('button', { hasText: /^Debt$/ });
  if (await debt.count()) { await debt.first().click(); await pg.waitForTimeout(500); }
  console.log('wall present :', await pg.locator('.prwallgrid').count());
  console.log('buttons      :', await pg.$$eval('button', e => e.slice(0,14).map(x => x.textContent.trim().slice(0,20))));
  console.log('body text    :', (await pg.locator('#propertiesNative').textContent()).replace(/\s+/g,' ').slice(0,220));

  const cols = await pg.$$eval('.pryr', els => els.map(e => {
    /* .prbar, not .col: portal.html owns a generic .col and its padding and
       border floor every bar at 22px. Reported by name rather than thrown, so
       the failure says what happened instead of printing a stack. */
    const col = e.querySelector('.prbar');
    if (!col) return { year: (e.querySelector('.yl') || {}).textContent || '?',
                       amt: '', w: 0, h: -1, cls: 'NO .prbar - is the bar called .col again?' };
    const r = col.getBoundingClientRect();
    return {
      year: e.querySelector('.yl').textContent.trim(),
      amt: e.querySelector('.amt').textContent.trim(),
      w: Math.round(r.width), h: Math.round(r.height),
      cls: e.className.replace('pryr', '').trim(),
    };
  }));
  const grid = await pg.$eval('.prwallgrid', e => {
    const r = e.getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height), scrollW: Math.round(e.scrollWidth) };
  });
  console.log('columns      :', cols.length, '| empty:', cols.filter(c => !c.amt).length);
  cols.forEach(c => console.log('   ' + c.year.padEnd(6) + (c.amt || '-').padEnd(8) +
    'w=' + String(c.w).padStart(3) + ' h=' + String(c.h).padStart(4) + '  ' + c.cls));
  console.log('grid         :', JSON.stringify(grid));

  let pass = 0; const fails = [];
  const check = (n, fn) => { try { fn(); pass++; } catch (e) { fails.push(n + ' -> ' + e.message); } };

  check('the axis is bounded, not one column per year to the last maturity', () => {
    /* Ten years plus the bucket. The fixture's furthest loan is 2056, which
       used to produce 31. */
    assert.ok(cols.length <= 12, 'saw ' + cols.length + ' columns');
    assert.ok(cols.length >= 3, 'the wall collapsed to ' + cols.length + ' columns');
  });

  check('everything past the horizon is in ONE bucket, and it is labelled', () => {
    const last = cols[cols.length - 1];
    assert.ok(/\+$/.test(last.year), 'the last column is not a bucket: ' + last.year);
    assert.ok(last.cls.indexOf('rest') >= 0, 'the bucket is not marked: ' + last.cls);
    /* 16 + 34 + 4 = 54M, so nothing beyond the horizon was dropped. */
    assert.strictEqual(last.amt, '$54M', 'the bucket total is ' + last.amt);
  });

  check('an EMPTY column is 2px tall, not a bordered panel', () => {
    /* The whole band, in one assertion. portal.html's generic `.col` gave
       these 10px of padding and a 1px border, flooring them at 22px. */
    const empties = cols.filter(c => !c.amt);
    assert.ok(empties.length, 'the fixture has empty years');
    for (const c of empties) {
      assert.ok(c.h <= 4, c.year + ' renders ' + c.h + 'px tall, so it reads as a bar');
    }
  });

  check('a real bar is proportional to its amount', () => {
    /* $14M against a $54M maximum over 150px is ~39px. If a stray padding
       came back, every bar would be 22px taller than this. */
    const m = cols.filter(c => c.amt === '$14M')[0];
    assert.ok(m, 'the $14M bar is present');
    assert.ok(Math.abs(m.h - 39) <= 3, 'the $14M bar is ' + m.h + 'px, expected about 39');
  });

  check('the columns are wide enough for a year label', () => {
    /* 31 columns left 22px each, which is why the labels overlapped. */
    assert.ok(cols[0].w >= 34, 'columns are ' + cols[0].w + 'px wide');
  });

  check('the grid does not overflow its card', () => {
    assert.ok(grid.scrollW <= grid.w + 1, 'scrollWidth ' + grid.scrollW + ' vs ' + grid.w);
  });

  check('no page errors', () => assert.deepStrictEqual(errs, []));

  await b.close(); server.close();

  console.log('\nmaturity wall: ' + pass + ' passed, ' + fails.length + ' failed');
  if (fails.length) { fails.forEach(f => console.log('  FAIL  ' + f)); process.exit(1); }
})().catch(e => { console.error(e); process.exit(1); });
