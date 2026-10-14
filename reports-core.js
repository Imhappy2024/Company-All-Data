// ===========================================================================
// reports-core.js — Properties > Reports: what a report IS and how it runs.
//
// A report is a definition, never figures:
//   { reports: { income, rr, opt }, incType: regular|quarter|half|annual,
//     from, to ('YYYY-MM'), quarter ('YYYYQn'), half ('YYYYHn'),
//     annual ('YYYY' | 'T12'), stmt: { is, cf }, props: [property id] }
//
// buildDoc() runs it on current data and returns the document the preview
// renders and every export lays out, so the screen, the file and the email
// attachment are one model. It reads only through props-api's data functions
// (public.rpt_* views), and the caller decides whose database role it runs
// as: the person for a manual run, the owner for a scheduled one. A property
// that role cannot see simply does not come back, and is counted as omitted.
//
// Periods are calendar months as 'YYYY-MM' text end to end (no Date, no
// timezone). A schedule rolls its period forward at each send to the latest
// COMPLETED period of the same type, measured against the latest month of
// data loaded, not the calendar: a quarter the books do not cover yet is not
// complete.
// ===========================================================================
'use strict';

const P = require('./props-api').data;
const { ymAdd, ymSpan, ymShort } = P;
const OPT = require('./public/optimized-core');

const YM = /^(\d{4})-(0[1-9]|1[0-2])$/;
const MN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_PROPS = 60;
const INC_TYPES = ['regular', 'quarter', 'half', 'annual'];
const isNum = v => typeof v === 'number' && Number.isFinite(v);
const sumOf = a => { const f = a.filter(isNum); return f.length ? f.reduce((x, y) => x + y, 0) : null; };
const ymLong = ym => { const m = YM.exec(ym || ''); return m ? MN[+m[2] - 1] + ' ' + m[1] : ''; };

/* ---- periods ------------------------------------------------------------ */
function quarterSpan(k) { const m = /^(\d{4})Q([1-4])$/.exec(k || ''); if (!m) return null; const a = m[1] + '-' + String((+m[2] - 1) * 3 + 1).padStart(2, '0'); return [a, ymAdd(a, 2)]; }
function halfSpan(k) { const m = /^(\d{4})H([12])$/.exec(k || ''); if (!m) return null; const a = m[1] + (m[2] === '1' ? '-01' : '-07'); return [a, ymAdd(a, 5)]; }
function yearSpan(k, through) { if (k === 'T12') return through ? [ymAdd(through, -11), through] : null; return /^\d{4}$/.test(k || '') ? [k + '-01', k + '-12'] : null; }
const rangeText = (a, b) => MN[+a.slice(5) - 1] + ' to ' + MN[+b.slice(5) - 1];

function quarterLabel(k) { const s = quarterSpan(k); return 'Q' + k.slice(5) + ' ' + k.slice(0, 4) + ' (' + rangeText(s[0], s[1]) + ')'; }
function halfLabel(k) { const s = halfSpan(k); return k.slice(4) + ' ' + k.slice(0, 4) + ' (' + rangeText(s[0], s[1]) + ')'; }
function yearLabel(k, through) {
  if (k === 'T12') { const s = yearSpan('T12', through); return 'Trailing 12 months (' + ymLong(s[0]) + ' to ' + ymLong(s[1]) + ')'; }
  return k + ' (Jan to Dec)';
}

/* The months a config covers, and how to name them. */
function resolvePeriod(cfg, through) {
  let span = null, label = '';
  if (cfg.incType === 'regular') {
    let a = cfg.from, b = cfg.to;
    if (!YM.test(a || '') || !YM.test(b || '')) { b = through; a = ymAdd(through, -2); }
    if (a > b) { const x = a; a = b; b = x; }
    if (ymSpan(a, b).length > 24) a = ymAdd(b, -23);
    span = [a, b]; label = a === b ? ymLong(a) : ymLong(a) + ' to ' + ymLong(b);
  } else if (cfg.incType === 'quarter') { span = quarterSpan(cfg.quarter); label = span && quarterLabel(cfg.quarter); }
  else if (cfg.incType === 'half') { span = halfSpan(cfg.half); label = span && halfLabel(cfg.half); }
  else { span = yearSpan(cfg.annual, through); label = span && yearLabel(cfg.annual, through); }
  if (!span) { span = [ymAdd(through, -11), through]; label = yearLabel('T12', through); }
  return { from: span[0], to: span[1], months: ymSpan(span[0], span[1]), label };
}

/* What the period pickers offer: every period overlapping the data on file,
   newest first, within the last three years. */
function periodOptions(through, earliest) {
  if (!through) return { through: null, months: [], quarters: [], halves: [], years: [] };
  const floor = [earliest || ymAdd(through, -35), ymAdd(through, -35)].sort().pop();
  const months = ymSpan(floor, through).reverse();
  const qs = [], hs = [], ys = ['T12'];
  for (let y = +through.slice(0, 4); y >= +floor.slice(0, 4); y--) {
    for (let n = 4; n >= 1; n--) { const k = y + 'Q' + n, s = quarterSpan(k); if (s[0] <= through && s[1] >= floor) qs.push(k); }
    for (let n = 2; n >= 1; n--) { const k = y + 'H' + n, s = halfSpan(k); if (s[0] <= through && s[1] >= floor) hs.push(k); }
    ys.push(String(y));
  }
  return {
    through,
    months: months.map(m => ({ v: m, label: ymLong(m) })),
    quarters: qs.map(k => ({ v: k, label: quarterLabel(k) })),
    halves: hs.map(k => ({ v: k, label: halfLabel(k) })),
    years: ys.map(k => ({ v: k, label: yearLabel(k, through) })),
  };
}

/* A schedule's period at send time: the latest completed period of the same
   type, measured against the data loaded. */
function rollForward(cfg, through) {
  const c = Object.assign({}, cfg);
  if (!through || !cfg.reports.income) return c;
  if (c.incType === 'regular') {
    const n = YM.test(c.from || '') && YM.test(c.to || '') ? Math.min(24, ymSpan(c.from < c.to ? c.from : c.to, c.from < c.to ? c.to : c.from).length) : 3;
    c.to = through; c.from = ymAdd(through, -(n - 1));
  } else if (c.incType === 'quarter') {
    let k = through.slice(0, 4) + 'Q' + Math.ceil(+through.slice(5) / 3);
    if (quarterSpan(k)[1] > through) { const s = ymAdd(quarterSpan(k)[0], -1); k = s.slice(0, 4) + 'Q' + Math.ceil(+s.slice(5) / 3); }
    c.quarter = k;
  } else if (c.incType === 'half') {
    let k = through.slice(0, 4) + (+through.slice(5) <= 6 ? 'H1' : 'H2');
    if (halfSpan(k)[1] > through) { const s = ymAdd(halfSpan(k)[0], -1); k = s.slice(0, 4) + (+s.slice(5) <= 6 ? 'H1' : 'H2'); }
    c.half = k;
  } else if (c.annual !== 'T12') {
    c.annual = through.slice(5) === '12' ? through.slice(0, 4) : String(+through.slice(0, 4) - 1);
  }
  return c;
}

/* ---- the definition: every key checked, nothing else kept -------------- */
function validateConfig(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const rep = r.reports || {};
  const cfg = {
    reports: { income: !!rep.income, rr: !!rep.rr, opt: !!rep.opt },
    incType: INC_TYPES.indexOf(r.incType) >= 0 ? r.incType : 'quarter',
    from: YM.test(r.from || '') ? r.from : null,
    to: YM.test(r.to || '') ? r.to : null,
    quarter: /^\d{4}Q[1-4]$/.test(r.quarter || '') ? r.quarter : null,
    half: /^\d{4}H[12]$/.test(r.half || '') ? r.half : null,
    annual: r.annual === 'T12' || /^\d{4}$/.test(r.annual || '') ? r.annual : 'T12',
    stmt: { is: !(r.stmt && r.stmt.is === false), cf: !!(r.stmt && r.stmt.cf) },
    props: [...new Set((Array.isArray(r.props) ? r.props : []).filter(x => typeof x === 'string' && UUID.test(x)))].slice(0, MAX_PROPS),
  };
  return cfg;
}
function problemOf(cfg) {
  if (!cfg.reports.income && !cfg.reports.rr && !cfg.reports.opt) return 'Choose at least one report.';
  if (!cfg.props.length) return 'Choose at least one property.';
  if (cfg.reports.income && !cfg.stmt.is && !cfg.stmt.cf) return 'Choose the income statement, the cash flow statement, or both.';
  return null;
}
const KIND_NAMES = { income: 'Income report', rr: 'Rent roll', opt: 'Optimized NOI' };
function describe(cfg) { return Object.keys(KIND_NAMES).filter(k => cfg.reports[k]).map(k => KIND_NAMES[k]).join(', '); }

/* ---- the document -------------------------------------------------------- */
const cell = (v, f) => ({ f: f || 'money2', v: isNum(v) ? v : null });
function row(label, vals, o) {
  o = o || {};
  const f = o.f || 'money2';
  return { label, kind: o.kind || '', indent: !!o.indent, cells: vals.map(v => cell(v, f)),
           tot: o.noTot ? null : cell(sumOf(vals), f), empty: vals.every(v => !isNum(v)) };
}
const groupRow = (label, n) => ({ label, kind: 'group', indent: false, cells: Array.from({ length: n }, () => ({ f: 'text', v: '' })), tot: { f: 'text', v: '' } });
function sentence(s) {
  s = String(s || '');
  if (/[a-z]/.test(s) || !/[A-Z]/.test(s)) return s;
  const t = s.toLowerCase(); return t.charAt(0).toUpperCase() + t.slice(1);
}

async function incomeSection(tenantId, p, cfg, per, typeLabel) {
  const md = await P.monthlyData(tenantId, p.id, per);
  const keep = md.months.map((m, i) => i).filter(i => isNum(md.series.inc[i]));
  const heads = keep.map(i => md.labels[i]);
  const missing = md.months.length - keep.length;
  const sub = per.label + (missing ? '; ' + missing + ' of ' + md.months.length + ' months have no data yet and are left out' : '');
  const title = typeLabel + ' income report';
  if (!keep.length) return { kind: 'income', title, sub, note: 'No income statement is loaded for these months.', table: null };
  const pick = a => keep.map(i => (a && isNum(a[i]) ? a[i] : null));
  const lineSum = lines => keep.map(i => lines.reduce((acc, l) => acc + (isNum(l[1][i]) ? l[1][i] : 0), 0));
  const ST = md.statements;
  const n = heads.length;
  const lineRows = lines => lines.map(l => row(sentence(l[0]), pick(l[1]), { indent: true })).filter(r => !r.empty);
  let rows = [];
  if (ST.income.length + ST.expense.length) {
    const inc = lineSum(ST.income), opx = lineSum(ST.expense), nonI = lineSum(ST.nonopIncome), nonE = lineSum(ST.nonopExpense);
    const noi = inc.map((v, j) => v - opx[j]);
    const ni = noi.map((v, j) => v + nonI[j] - nonE[j]);
    if (cfg.stmt.is) {
      rows = rows.concat([groupRow('Income statement', n), groupRow('Operating income', n)], lineRows(ST.income),
        [row('Total operating income', inc, { kind: 'key' }), groupRow('Operating expenses', n)], lineRows(ST.expense),
        [row('Total operating expense', opx, { kind: 'key' }), row('Net operating income', noi, { kind: 'total' })],
        ST.nonopIncome.length ? [groupRow('Non-operating income', n)].concat(lineRows(ST.nonopIncome), [row('Total non-operating income', nonI, { kind: 'key' })]) : [],
        ST.nonopExpense.length ? [groupRow('Non-operating expenses', n)].concat(lineRows(ST.nonopExpense), [row('Total non-operating expenses', nonE, { kind: 'key' })]) : [],
        [row('Net income', ni, { kind: 'total' })]);
    }
    if (cfg.stmt.cf) {
      const op = lineSum(ST.operating), fin = lineSum(ST.financing), inv = lineSum(ST.investing);
      const cfo = ni.map((v, j) => v + op[j]), net = cfo.map((v, j) => v + fin[j] + inv[j]);
      rows = rows.concat([groupRow('Cash flow statement', n), row('Net income', ni, { kind: 'key' })],
        ST.operating.length ? [groupRow('Changes in operating balances', n)].concat(lineRows(ST.operating)) : [],
        [row('Cash from operations', cfo, { kind: 'key' })],
        ST.financing.length ? [groupRow('Financing and owner activity', n)].concat(lineRows(ST.financing), [row('Cash from financing', fin, { kind: 'key' })]) : [],
        ST.investing.length ? [groupRow('Investing', n)].concat(lineRows(ST.investing), [row('Cash from investing', inv, { kind: 'key' })]) : [],
        [row('Net cash flow', net, { kind: 'total' })]);
    }
  } else {
    /* no account-level statement on file: the key figures by month */
    const se = md.series;
    rows = [row('Total operating income', pick(se.inc), { kind: 'key' }), row('Total operating expense', pick(se.opx), { kind: 'key' }),
            row('Net operating income', pick(se.noi), { kind: 'total' }), row('Capital expenses', pick(se.capex)),
            row('Debt service', pick(se.ds)), row('Cash flow after debt and capex', pick(se.cashFlow), { kind: 'total' })].filter(r => !r.empty);
  }
  return { kind: 'income', title: title + (cfg.stmt.cf ? (cfg.stmt.is ? ' with cash flow' : ', cash flow statement') : ''), sub,
           note: ST.income.length + ST.expense.length ? '' : 'Account-level statement not on file for this property; key figures shown.',
           table: { heads, hasTotal: true, rows: rows.map(r => { delete r.empty; return r; }) } };
}

function typeOf(bd, ba) {
  return (bd === null ? 'Unknown' : bd === 0 ? 'Studio' : bd + ' bed') + ' / ' + (ba === null ? '?' : ba) + ' bath';
}
async function rentRollSection(tenantId, p) {
  const rr = await P.rentRollAgg(tenantId, p.id, null);
  if (!rr) return { kind: 'rr', title: 'Rent roll', sub: 'No rent roll on file', table: null, cards: [] };
  const R = rr.R;
  const [units, occ, , , , rent] = R;
  const asOf = /^(\d{4})-(\d{2})-(\d{2})$/.exec(rr.asOf);
  return {
    kind: 'rr', title: 'Rent roll', sub: 'As of ' + (asOf ? MN[+asOf[2] - 1] + ' ' + (+asOf[3]) + ', ' + asOf[1] : rr.asOf),
    cards: [
      { k: 'Units', v: String(units) },
      { k: 'Occupied', v: occ + ' (' + (units ? (occ / units * 100).toFixed(1) : '0.0') + '%)' },
      { k: 'Vacant', v: String(R[3] + R[4]) },
      { k: 'Monthly rent', v: P.money(rent) },
      { k: 'Delinquency', v: P.money(R[8] || 0) },
      { k: 'Expiring in 90 days', v: String(R[11]) },
    ],
    table: { heads: ['Units', 'Occupied', 'Average rent', 'Average market'], hasTotal: false,
      rows: R[13].map(([bd, ba, nU, nO, ar, am]) => ({ label: typeOf(bd, ba), kind: '', indent: false,
        cells: [cell(nU, 'count'), cell(nO, 'count'), cell(ar, 'money'), cell(am, 'money')], tot: null })) },
  };
}

/* Optimized NOI at the standard assumptions: the tab's NOI ladder and status
   (public/optimized-core.js), every window ending at the latest month */
async function optimizedSection(tenantId, p, through) {
  const od = await P.optimizedData(tenantId, p.id, p, through);
  if (!od.input) return { kind: 'opt', title: 'Optimized NOI', sub: 'No NOI on file', table: { heads: [], rows: [], hasTotal: false } };
  const r = OPT.compute(od.input), A = r.actual, L = od.labels, last = L[L.length - 1];
  const span = k => (L.length ? L[Math.max(0, L.length - k)] + ' to ' + last : '');
  const names = {
    t12: ['Trailing 12 months', A.t12w ? L[A.t12w.first] + ' to ' + last + (A.t12w.n < 12 ? ', ' + A.t12w.n + ' months annualized' : '') : '–'],
    t6: ['Trailing 6 months x 2', span(6)], t3: ['Trailing 3 months x 4', span(3)],
    lender: ['Lender view', 'Income ' + span(3) + ' x 4, expenses T12'],
    stab: ['Stabilized', A.rentCheck ? 'Rent data needs a check' : A.gpr !== null ? 'Market rent, 5% vacancy, reserves' : 'Needs market rent'],
  };
  const rows = r.ladder.filter(x => names[x.key]).map(x => ({
    label: names[x.key][0], kind: x.key === 'stab' ? 'total' : '', indent: false,
    cells: [{ f: 'text', v: names[x.key][1] }, cell(x.noi, 'money'), cell(x.key === 't12' ? null : x.vsT12, 'pct'),
            cell(x.dscr, 'ratio'), cell(x.max, 'money'), cell(x.value, 'money')],
    tot: null,
  }));
  return {
    kind: 'opt', title: 'Optimized NOI',
    sub: 'Status: ' + r.status.name + '. ' + r.status.text + ' Standard assumptions: required DSCR 1.25, 6.5% over 30 years, 7% cap rate, 5% vacancy, $250 a unit reserves; debt service ' +
         (r.ds ? P.money(r.ds) + ' (' + A.dsSrc.toLowerCase() + ')' : 'not on file') + '.',
    table: { heads: ['Months', 'Annual NOI', 'Against T12', 'DSCR', 'Max loan', 'Value at 7% cap'], hasTotal: false, rows },
  };
}

const TYPE_LABEL = { regular: 'Regular', quarter: 'Quarterly', half: 'Bi-annual', annual: 'Annual' };

/* in batches, so a 60-property report does not open 180 queries at once */
async function mapLimit(items, n, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  }));
  return out;
}

function reportName(cfg, props, per) {
  return (describe(cfg).split(', ').join(' + ') || 'Report') + ' - ' +
    (props.length === 1 ? props[0].name : props.length + ' properties') +
    (cfg.reports.income ? ' - ' + per.label.split(' (')[0] : '');
}

/* Runs the definition as whoever the caller is running as. */
async function buildDoc(tenantId, cfg, opts) {
  opts = opts || {};
  const through = await P.dataThrough(tenantId);
  const per = resolvePeriod(cfg, through);
  const props = (await P.q(P.LIST_SQL + ' and s.id = any($2::uuid[]) order by s.name', [tenantId, cfg.props])).map(P.shapeProp);
  const docs = await mapLimit(props, 3, async p => {
    const sections = [];
    if (cfg.reports.income) sections.push(await incomeSection(tenantId, p, cfg, per, TYPE_LABEL[cfg.incType]));
    if (cfg.reports.rr) sections.push(await rentRollSection(tenantId, p));
    if (cfg.reports.opt) sections.push(await optimizedSection(tenantId, p, through));
    return { id: p.id, name: p.name, sub: (p.mgr || 'No managing entity') + (p.pm ? ', managed by ' + p.pm : ''), sections };
  });
  return {
    name: opts.name || reportName(cfg, props, per),
    generated: 'Generated ' + new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', month: 'short', day: 'numeric', year: 'numeric' }).format(opts.now || new Date()) +
      (opts.by ? ' by ' + opts.by : ''),
    period: cfg.reports.income ? per.label : 'Latest data',
    dataThrough: through,
    includes: describe(cfg),
    docs,
    omitted: cfg.props.length - props.length,
  };
}

/* ---- schedules: 9:00 AM America/Chicago on each due date ----------------- */
/* The UTC instant of 09:00 Chicago on a calendar day, DST included. */
function chicagoNine(day) {
  const [y, m, d] = day.split('-').map(Number);
  let t = Date.UTC(y, m - 1, d, 14, 0, 0);           /* 9:00 CDT */
  const h = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', hour: 'numeric', hourCycle: 'h23' }).format(new Date(t)));
  if (h !== 9) t += (9 - h) * 3600000;               /* 9:00 CST is 15:00 UTC */
  return new Date(t);
}
function chicagoToday(now) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(now || new Date()).map(x => [x.type, x.value]));
  return p.year + '-' + p.month + '-' + p.day;
}
function addDays(day, n) { const d = new Date(day + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function addMonthsClamped(start, k) {
  const [y, m, d] = start.split('-').map(Number);
  const t = y * 12 + (m - 1) + k, yy = Math.floor(t / 12), mm = t % 12;
  const last = new Date(Date.UTC(yy, mm + 1, 0)).getUTCDate();
  return yy + '-' + String(mm + 1).padStart(2, '0') + '-' + String(Math.min(d, last)).padStart(2, '0');
}
/* the n-th occurrence from the start date (n = 0 is the start itself) */
function occurrence(start, repeat, n) {
  if (repeat === 'daily') return addDays(start, n);
  if (repeat === 'weekly') return addDays(start, 7 * n);
  if (repeat === 'yearly') return addMonthsClamped(start, 12 * n);
  return addMonthsClamped(start, n);
}
/* the first due date strictly after `after` (or the first not yet passed) */
function nextRun(start, repeat, after) {
  const now = after || new Date();
  for (let n = 0; n < 5000; n++) {
    const at = chicagoNine(occurrence(start, repeat, n));
    if (at > now) return at;
  }
  return null;
}
function runLabel(at) {
  if (!at) return '';
  return new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }).format(at);
}

module.exports = {
  validateConfig, problemOf, describe, resolvePeriod, periodOptions, rollForward, buildDoc,
  nextRun, chicagoNine, chicagoToday, runLabel, occurrence, MAX_PROPS, KIND_NAMES,
};
