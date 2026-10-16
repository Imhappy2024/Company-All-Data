/* The Custom view spreadsheet engine (public/sheet-core.js), pure: no
   database, no browser. Expected values are worked out by hand.

   Run:  node test/test-sheet-core.js
*/
const path = require('path');
const assert = require('assert');
const X = require(path.join(__dirname, '..', 'public', 'sheet-core.js'));
const core = require(path.join(__dirname, '..', 'public', 'props-views-core.js'));

let pass = 0; const fails = [];
const check = (n, fn) => { try { fn(); pass++; } catch (e) { fails.push(n + ' -> ' + e.message.slice(0, 300)); } };
const near = (a, b, n) => assert.ok(typeof a === 'number' && Math.abs(a - b) < 1e-6, n + ': ' + JSON.stringify(a) + ' vs ' + b);

/* a formula on its own, in an empty sheet */
const blank = () => X.build({ heads: [], rows: [], totals: [], sheet: core.cleanSheet({}) });
function calc(f) {
  const sh = core.cleanSheet({}), g = blank();
  X.write(sh, g, g.T + 1, 0, f);
  return X.build({ heads: [], rows: [], totals: [], sheet: sh }).value(g.T + 1, 0);
}

check('column names', () => { assert.deepStrictEqual([0, 25, 26, 51, 701].map(X.colName), ['A', 'Z', 'AA', 'AZ', 'ZZ']); assert.strictEqual(X.colIndex('AA'), 26); });
check('precedence', () => { assert.strictEqual(calc('=1+2*3'), 7); assert.strictEqual(calc('=(1+2)*3'), 9); assert.strictEqual(calc('=2^3^2'), 64); assert.strictEqual(calc('=-2^2'), 4); assert.strictEqual(calc('=10-2-3'), 5); });
check('percent, text, comparison', () => { assert.strictEqual(calc('=50%'), 0.5); assert.strictEqual(calc('="a"&"b"&1'), 'ab1'); assert.strictEqual(calc('=1<2'), true); assert.strictEqual(calc('="A"="a"'), true); });
check('division by zero', () => assert.deepStrictEqual(calc('=10/0'), { err: '#DIV/0!' }));
check('functions', () => {
  assert.strictEqual(calc('=SUM(1,2,3)'), 6); assert.strictEqual(calc('=AVERAGE(2,4)'), 3); assert.strictEqual(calc('=MAX(1,9,3)'), 9);
  assert.strictEqual(calc('=ROUND(2.345,2)'), 2.35); assert.strictEqual(calc('=ROUNDDOWN(2.349,2)'), 2.34); assert.strictEqual(calc('=ROUNDUP(2.341,2)'), 2.35);
  assert.strictEqual(calc('=IF(1>2,"yes","no")'), 'no'); assert.strictEqual(calc('=IFERROR(1/0,"none")'), 'none');
  assert.strictEqual(calc('=AND(TRUE,1>0)'), true); assert.strictEqual(calc('=MOD(-7,3)'), 2); assert.strictEqual(calc('=LEFT("Franklin",4)'), 'Fran');
  /* r * PV / (1 - (1 + r)^-n) with r = 6.5% / 12, n = 360 */
  near(calc('=PMT(0.065/12,360,-1000000)'), 6320.680234929653, 'PMT');
  assert.deepStrictEqual(calc('=IRR(-100)'), { err: '#NUM!' });
});
check('IRR over a range', () => {
  const sh = core.cleanSheet({}); let g = blank();
  [-100, 60, 60].forEach((v, i) => X.write(sh, g, g.T + 1 + i, 0, String(v)));
  X.write(sh, g, g.T + 4, 0, '=IRR(A3:A5)');
  g = X.build({ heads: [], rows: [], totals: [], sheet: sh });
  near(g.value(g.T + 4, 0), 0.1306623863, 'IRR');
});
check('unknown names and bad syntax', () => {
  assert.deepStrictEqual(calc('=NOPE(1)'), { err: '#NAME?' });
  assert.deepStrictEqual(calc('=constructor'), { err: '#NAME?' });
  assert.deepStrictEqual(calc('=1+'), { err: '#ERROR!' });
});
check('fill down moves relative rows only', () => assert.strictEqual(X.shiftRows('=A1+$B$2+C$3+D4', 2), '=A3+$B$2+C$3+D6'));

/* Jay's example: 70 units at 68% and 20 units at 98% is 74.67% across both */
const heads = [{ key: 'units', label: 'Units', type: 'count' }, { key: 'occ', label: 'Occupancy', type: 'pct' }];
const P1 = '11111111-1111-4111-8111-111111111111', P2 = '22222222-2222-4222-8222-222222222222', P3 = '33333333-3333-4333-8333-333333333333';
const rows2 = [{ id: P1, name: 'Seventy', cells: [70, 0.68] }, { id: P2, name: 'Twenty', cells: [20, 0.98] }];
const model = (sheet, rows, hd, totals) => ({ heads: hd || heads, rows: rows || rows2, totals: totals || [90, 67.2 / 90], sheet });

check('weighted occupancy in a free cell', () => {
  const sh = core.cleanSheet({}); let g = X.build(model(sh));
  assert.strictEqual(X.write(sh, g, g.T + 1, 0, '=SUMPRODUCT(B2:B3,C2:C3)/SUM(B2:B3)'), null);
  g = X.build(model(sh));
  near(g.value(g.T + 1, 0), 67.2 / 90, 'weighted');
  assert.strictEqual(X.addr(g.T + 1, 0), 'A5');
});
check('a formula column fills down and its total is the formula over the totals', () => {
  const sh = core.cleanSheet({ cols: [{ id: 'occu', label: 'Occupied units', kind: 'formula' }] }); let g = X.build(model(sh));
  X.write(sh, g, 2, 3, '=B3*C3');              /* typed in the 2nd property row */
  g = X.build(model(sh));
  near(g.value(1, 3), 47.6, 'row 1'); near(g.value(2, 3), 19.6, 'row 2'); near(g.value(g.T, 3), 67.2, 'total');
  assert.strictEqual(g.raw(1, 3), '=B2*C2');
});
check('an input column: numbers, formulas and its sum', () => {
  const sh = core.cleanSheet({ cols: [{ id: 'tgt', label: 'Target', kind: 'input' }] }); let g = X.build(model(sh));
  X.write(sh, g, 1, 3, '$1,000'); X.write(sh, g, 2, 3, '=B3*2');
  g = X.build(model(sh));
  assert.strictEqual(g.value(1, 3), 1000); assert.strictEqual(g.value(2, 3), 40); assert.strictEqual(g.value(g.T, 3), 1040);
});
check('C:C is the property rows only', () => {
  const sh = core.cleanSheet({}); let g = X.build(model(sh));
  X.write(sh, g, g.T + 1, 1, '=SUM(B:B)'); X.write(sh, g, g.T + 2, 1, '=SUM($B:$B)');
  g = X.build(model(sh));
  assert.strictEqual(g.value(g.T + 1, 1), 90); assert.strictEqual(g.value(g.T + 2, 1), 90);
});
check('lookups', () => {
  const sh = core.cleanSheet({}); let g = X.build(model(sh));
  X.write(sh, g, g.T + 1, 0, '=VLOOKUP("twenty",A2:C3,2,FALSE)');
  X.write(sh, g, g.T + 2, 0, '=INDEX(B2:B3,MATCH("Seventy",A2:A3,0))');
  X.write(sh, g, g.T + 3, 0, '=XLOOKUP("Nobody",A2:A3,B2:B3,"none")');
  X.write(sh, g, g.T + 4, 0, '=COUNTIF(B2:B3,">50")');
  X.write(sh, g, g.T + 5, 0, '=SUMIFS(B2:B3,C2:C3,">0.9")');
  g = X.build(model(sh));
  assert.deepStrictEqual([1, 2, 3, 4, 5].map(k => g.value(g.T + k, 0)), [20, 70, 'none', 1, 20]);
});
check('a cell that reads itself is #CIRC!', () => {
  const sh = core.cleanSheet({}); let g = X.build(model(sh));
  X.write(sh, g, g.T + 1, 0, '=A5+1');
  g = X.build(model(sh));
  assert.deepStrictEqual(g.value(g.T + 1, 0), { err: '#CIRC!' });
});
check('data cells and totals are read-only', () => {
  const sh = core.cleanSheet({}); const g = X.build(model(sh));
  assert.ok(/comes from the data/.test(X.write(sh, g, 1, 1, '5')));
  assert.ok(/worked out/.test(X.write(sh, g, g.T, 1, '5')));
});
check('sorting reorders rows; formulas follow their row', () => {
  const sh = core.cleanSheet({ sort: { key: 'units', dir: 'asc' }, cols: [{ id: 'occu', label: 'Occupied', kind: 'formula', f: '={units|d1}*{occ|d1}' }] });
  const g = X.build(model(sh));
  assert.strictEqual(g.value(1, 0), 'Twenty'); near(g.value(1, 3), 19.6, 'sorted row');
});
check('stored formulas survive a new property and a new field', () => {
  const sh = core.cleanSheet({}); let g = X.build(model(sh));
  X.write(sh, g, g.T + 1, 0, '=SUM(B2:B3)');      /* to the last property row */
  X.write(sh, g, g.T + 2, 0, '=A5*2');            /* the cell above, in the free area */
  X.settle(sh, g);
  assert.strictEqual(sh.cells['1|name'].v, '=SUM({units|d1}:{units|d2})');
  assert.strictEqual(sh.cells['2|name'].v, '={name|f1}*2');
  /* a third property arrives and a field is added in front of Units */
  const hd = [{ key: 'address', label: 'Address', type: 'text' }].concat(heads);
  const rows3 = [{ id: P1, name: 'Seventy', cells: ['a', 70, 0.68] }, { id: P2, name: 'Twenty', cells: ['b', 20, 0.98] }, { id: P3, name: 'Ten', cells: ['c', 10, 0.5] }];
  g = X.build(model(sh, rows3, hd, [null, 100, 0.722]));
  assert.strictEqual(g.raw(g.T + 1, 0), '=SUM(C2:C4)');
  assert.strictEqual(g.value(g.T + 1, 0), 100);
  assert.strictEqual(g.raw(g.T + 2, 0), '=A6*2');
  assert.strictEqual(g.value(g.T + 2, 0), 200);
  /* a removed field is #REF!, as a deleted column is */
  g = X.build(model(sh, rows3.map(r => ({ id: r.id, name: r.name, cells: [r.cells[0]] })), [hd[0]], [null]));
  assert.ok(/#REF!/.test(g.raw(g.T + 1, 0)));
});
check('settings are bounded on the way in', () => {
  const s = core.cleanSheet({ n: 3, rows: 9999, cols: [{ id: 'bad id!', label: 'x' }, { id: 'ok', label: 'y'.repeat(500), kind: 'weird', f: '=1'.repeat(900), vals: { 'not-a-uuid': '1', [P1]: '2' } }],
    cells: { '1|name': { v: '=1' }, '0|name': { v: 'x' }, 'zz': { v: 'x' }, '3|x:ok': { v: 'y', fmt: 'pct' } }, colW: { name: 99999, units: 120 }, sort: { key: 'units', dir: 'up' } });
  assert.strictEqual(s.rows, 20); assert.strictEqual(s.cols.length, 1); assert.strictEqual(s.cols[0].label.length, 80); assert.strictEqual(s.cols[0].kind, 'formula');
  assert.strictEqual(s.cols[0].f.length, 1000); assert.deepStrictEqual(Object.keys(s.cols[0].vals), [P1]);
  assert.deepStrictEqual(Object.keys(s.cells).sort(), ['1|name', '3|x:ok']); assert.deepStrictEqual(s.colW, { units: 120 }); assert.strictEqual(s.sort.dir, 'asc');
});

/* the view engine's dates */
check('a view period: months of the range, ratios from the same months', () => {
  const t = '2026-09';
  const se = { '2026-07': { inc: 100, opx: 40, noi: 60, ds: 30 }, '2026-08': { inc: 200, opx: 50, noi: 150, ds: 30 }, '2026-09': { inc: 300, opx: 60, noi: 240, ds: 30 } };
  const props = [{ id: P1, name: 'One', inc: 9999, opx: 1, noi: 9998, ds: 360, series: se }];
  const cfg = core.validateConfig({ props: [P1], fields: ['inc', 'er', 'dscr', 'noi'], styles: ['table'], period: { t: 'last', n: 3 } });
  const r = core.evaluateData(cfg, core.resolve(cfg, []), { through: t, props });
  assert.deepStrictEqual(r.rows[0].cells.slice(0, 1), [600]);
  near(r.rows[0].cells[1], 150 / 600, 'expense ratio for the 3 months');
  near(r.rows[0].cells[2], 450 / 90, 'DSCR for the 3 months');
  assert.strictEqual(r.periodText, 'last 3 months, Jul 26 to Sep 26');
  /* the viewer's dates override the view's own */
  const m = core.evaluateData(cfg, core.resolve(cfg, []), { through: t, props }, { t: 'month', a: '2026-08' });
  assert.strictEqual(m.rows[0].cells[0], 200);
  /* a month not loaded yet is "–", not a partial total */
  const f = core.evaluateData(cfg, core.resolve(cfg, []), { through: t, props }, { t: 'range', a: '2026-08', b: '2026-10' });
  assert.strictEqual(f.rows[0].cells[0], null);
});
check('card sizes: old S/M/L keep their width, w/h bounded', () => {
  const c = core.validateConfig({ cards: [{ id: 'a', size: 'L' }, { id: 'b', w: 99, h: 0 }, { id: 'c', w: 7, h: 5 }], blocks: { table: { w: 8, h: 6 } } });
  assert.deepStrictEqual(c.cards.map(x => [x.w, x.h]), [[6, 2], [4, 2], [7, 5]]);
  assert.deepStrictEqual(c.blocks.table, { w: 8, h: 6 }); assert.deepStrictEqual(c.blocks.chart, { w: 12, h: 0 });
});

console.log('sheet core: ' + pass + ' passed, ' + fails.length + ' failed');
fails.forEach(f => console.log('  FAIL ' + f));
process.exit(fails.length ? 1 : 0);
