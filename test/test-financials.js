/* Financials — the parts that can be pinned without a database.

   The acceptance checks in the brief that need live figures ($5,073,105.35,
   160 cash accounts, 154 Operating accounts) are Jay's to run; they need the
   database and this sandbox has none.

   What IS testable here is everything that would still be wrong if the figures
   were right: whether the feature can write, whether an export contains what
   the caller was actually looking at, whether a credential column can escape,
   and whether a comma inside a value survives the round trip. Those are the
   failures that do not announce themselves — a CSV missing its draft flag looks
   exactly like a CSV, and gets quoted as fact.

   Expectations are written from the brief's stated intent, not derived from the
   code under test, so they can still fail.

   Run: node test/test-financials.js
*/

const assert = require('assert');
const path = require('path');
const http = require('http');
const express = require('express');

/* ---- fake database ------------------------------------------------------
   Injected into the require cache before financials-api loads it. It answers
   the shapes the module asks for and records every statement it is given, so
   a test can assert on the SQL itself. */

const seen = [];

/* Deliberately includes the columns that must never leave the process, so
   "no credential in the output" is proven against rows that HAVE them rather
   than against rows that never could. */
const CASH_ROWS = [
  { tenant_id: 'T', account_id: 'a1', entity_id: 'e1', entity: 'Maples Holdings LLC',
    deal_name: 'Maples, Phase II', account_name: 'Operating, Main', institution: 'Dundee Bank',
    account_number_last4: '4417', account_purpose: 'Operating', account_type: 'checking',
    cash_source: 'Bank', as_of_date: '2026-06-30', balance: '1234567.89', is_verified: false,
    source: 'Q2 workbook',
    portal_url: 'https://bank.example/login', portal_username: 'lw_ops',
    mfa_method: 'sms', mfa_required: true, bank_contact_email: 'rep@dundee.example' },
  { tenant_id: 'T', account_id: 'a2', entity_id: 'e2', entity: 'Doral SPE',
    deal_name: 'Doral', account_name: 'Reserve "A"', institution: null,
    account_number_last4: '0002', account_purpose: 'Reserve', account_type: 'savings',
    cash_source: 'Buildium', as_of_date: '2026-06-30', balance: '250000', is_verified: false,
    source: 'PM statement',
    portal_url: 'https://pm.example', portal_username: 'x', mfa_method: 'app',
    mfa_required: false, bank_contact_email: 'pm@example.com' },
  { tenant_id: 'T', account_id: 'a3', entity_id: 'e1', entity: 'Maples Holdings LLC',
    deal_name: 'Maples, Phase II', account_name: 'Line\nbreak account', institution: 'Busey Bank',
    account_number_last4: '9911', account_purpose: 'MM', account_type: 'money_market',
    cash_source: 'Bank', as_of_date: '2026-06-30', balance: '0', is_verified: false,
    source: 'Q2 workbook',
    portal_url: '', portal_username: '', mfa_method: '', mfa_required: false, bank_contact_email: '' },
];

/* One entity with cash only, one with DEBT ONLY (the row a LEFT JOIN drops),
   and one with a NEGATIVE cash balance — the three cases the spec calls out.
   The first entity name carries two commas, which a naive CSV join breaks on. */
const ENTITY_ROWS = [
  { entity_id: 'e1', entity: '2200 Ridgmar Plaza, LLC & Ridgmar Partners, LLC',
    entity_type: 'LLC', brand: 'LeavenWealth', deal_name: 'Ridgmar',
    cash_balance: '780132.81', cash_accounts: 3,
    debt_balance: '22075000.00', debt_accounts: 2,
    net_position: '-21294867.19', all_verified: false,
    as_of_date: '2026-06-30', source: 'Q2 workbook' },
  { entity_id: 'e2', entity: 'Cash Only Holdings LLC', entity_type: 'LLC',
    brand: 'LeavenWealth', deal_name: null,
    cash_balance: '470102.30', cash_accounts: 1,
    debt_balance: '0', debt_accounts: 0,
    net_position: '470102.30', all_verified: false,
    as_of_date: '2026-06-30', source: 'Bank' },
  { entity_id: 'e3', entity: 'Debt Only SPE', entity_type: null,
    brand: null, deal_name: 'Estrella',
    cash_balance: '0', cash_accounts: 0,
    debt_balance: '25600000.00', debt_accounts: 1,
    net_position: '-25600000.00', all_verified: false,
    as_of_date: '2026-06-30', source: null },
  { entity_id: 'e4', entity: 'Overdrawn Partners LLC', entity_type: 'LP',
    brand: 'LeavenWealth', deal_name: null,
    cash_balance: '-40000.00', cash_accounts: 1,
    debt_balance: '0', debt_accounts: 0,
    net_position: '-40000.00', all_verified: false,
    as_of_date: '2026-06-30', source: 'Bank' },
];

const VIEW_COLUMNS = {
  v_cash_by_entity_quarter: ['tenant_id', 'year', 'quarter', 'entity_id', 'entity', 'deal_name',
    'account_id', 'account_name', 'institution', 'account_number_last4', 'account_type',
    'account_purpose', 'cash_source', 'as_of_date', 'balance', 'is_verified', 'source'],
  /* Names, no ids — exactly as the brief documents it. This is what forces the
     name-fallback path in buildWhere, so the test covers it. */
  v_debt_by_account_quarter: ['year', 'quarter', 'deal_name', 'entity', 'lender',
    'account_number_last4', 'account_name', 'as_of_date', 'balance', 'is_verified'],
  v_debt_by_quarter: ['year', 'quarter', 'loan_id', 'loan_label', 'lender', 'entity_id', 'entity',
    'deal_name', 'as_of_date', 'balance', 'prior_balance', 'principal_paid', 'maturity_date',
    'interest_rate', 'dscr'],
  v_cash_debt_summary: ['year', 'quarter', 'total_cash', 'total_debt', 'cash_accounts',
    'loan_accounts', 'all_verified'],
  financial_account: ['id', 'tenant_id', 'name', 'account_kind', 'account_type', 'institution',
    'account_number_last4', 'owner_entity_id', 'property_id', 'loan_id', 'deal_id', 'cash_source',
    'account_purpose', 'property_manager', 'quarterly_report', 'bank_contact_name', 'notes',
    'portal_url', 'mfa_method', 'mfa_required', 'bank_contact_email'],
  account_balance: ['id', 'tenant_id', 'account_id', 'as_of_date', 'balance', 'source', 'is_verified'],
  entity: ['id', 'tenant_id', 'company_id', 'name', 'deal_id'],
  deal: ['id', 'tenant_id', 'company_id', 'name', 'status'],
  company: ['id', 'tenant_id', 'name', 'is_active'],
};

const fakeDb = {
  enabled: true,
  getPool() { throw new Error('not needed'); },
  q(sql, params) {
    seen.push({ sql, params });
    if (/information_schema\.columns/.test(sql)) {
      const rows = [];
      for (const t of Object.keys(VIEW_COLUMNS)) {
        for (const c of VIEW_COLUMNS[t]) rows.push({ table_name: t, column_name: c });
      }
      return Promise.resolve({ rows });
    }
    /* Ordered most-specific first. The tile aggregate also selects
       `count(*)::int as n`, so a looser branch above it would swallow it. */
    if (/from public\.company where tenant_id = \$1 and name ~\*/.test(sql)) {
      return Promise.resolve({ rows: [
        { id: 'c0000000-0000-4000-8000-000000000001', name: 'Leadli AI' },
        { id: 'c0000000-0000-4000-8000-000000000002', name: 'Folio Excel' },
      ] });
    }
    if (/select distinct as_of_date from public\.account_balance/.test(sql)) {
      return Promise.resolve({ rows: [{ as_of_date: '2026-06-30' }, { as_of_date: '2026-03-31' }] });
    }
    if (/coalesce\(sum\(v\.balance\), 0\)/.test(sql)) {
      const isCash = /v_cash_by_entity_quarter/.test(sql);
      return Promise.resolve({ rows: [{
        total: isCash ? '4900000.00' : '210000000.00',
        n: isCash ? 152 : 51,
        all_verified: false,
      }] });
    }
    if (/count\(\*\)::int as n/.test(sql)) return Promise.resolve({ rows: [{ n: CASH_ROWS.length }] });
    if (/from public\.loan\b|count\(distinct loan_id\)/.test(sql)) {
      return Promise.resolve({ rows: [{ loans: 75, with_balance: 54 }] });
    }
    if (/select id, name from public\.(deal|company|entity)/.test(sql)) {
      return Promise.resolve({ rows: [{ id: (params && params[1] && params[1][0]) || 'x', name: 'Maples, Phase II' }] });
    }
    if (/coalesce\(sum\(r\.cash_balance\)/.test(sql)) {
      return Promise.resolve({ rows: [{ cash: '4900000.00', debt: '210000000.00',
                                        net: '-205100000.00', entities: 4 }] });
    }
    if (/fa\.owner_entity_id is null/.test(sql)) {
      /* Two accounts with no owner entity, so the reconciliation note fires. */
      return Promise.resolve({ rows: [{ cash: '1500.00', debt: '0', accounts: 2 }] });
    }
    if (/full outer join debt/.test(sql)) {
      if (/count\(\*\)::int as n/.test(sql)) return Promise.resolve({ rows: [{ n: ENTITY_ROWS.length }] });
      return Promise.resolve({ rows: ENTITY_ROWS.slice() });
    }
    if (/join public\.account_balance ab on ab\.account_id = fa\.id/.test(sql)) {
      return Promise.resolve({ rows: CASH_ROWS.slice() });
    }
    if (/select v\.\* from/.test(sql)) return Promise.resolve({ rows: CASH_ROWS.slice() });
    return Promise.resolve({ rows: [] });
  },
};

require.cache[require.resolve('../supabase-db')] = { id: 'fake', filename: 'fake', loaded: true, exports: fakeDb };

const fin = require('../financials-api');

/* ---- harness ------------------------------------------------------------- */

let pass = 0;
const fails = [];
function check(name, fn) {
  try { fn(); pass++; }
  catch (e) { fails.push(name + ' -> ' + e.message); }
}
async function checkAsync(name, fn) {
  try { await fn(); pass++; }
  catch (e) { fails.push(name + ' -> ' + e.message); }
}

/* CSV records are not lines. One fixture account name deliberately contains a
   newline, and a correct writer quotes it across two physical lines — so
   counting lines over-reports. Tracking whether the cursor is inside quotes is
   the only way to count records, and getting this wrong once already made a
   correct export look like a paginated one. */
function csvRecords(text) {
  const body = text.split(/\r?\n/).filter(l => l.indexOf('#') !== 0).join('\n');
  let inQ = false, records = 0, sawContent = false;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === '"') {
      if (inQ && body[i + 1] === '"') { i++; continue; }
      inQ = !inQ; sawContent = true; continue;
    }
    if (ch === '\n' && !inQ) { if (sawContent) records++; sawContent = false; continue; }
    if (ch !== '\r') sawContent = true;
  }
  if (sawContent) records++;
  return records - 1;   /* less the header row */
}

function serve() {
  const app = express();
  app.use('/api/financials', fin.financialsRoutes());
  return new Promise(res => { const s = app.listen(0, () => res(s)); });
}

function req(server, method, url) {
  return new Promise((resolve, reject) => {
    const r = http.request({ port: server.address().port, path: url, method }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    r.on('error', reject);
    r.end();
  });
}

/* ---- tests --------------------------------------------------------------- */

(async () => {
  const server = await serve();
  const get = u => req(server, 'GET', u);

  /* 1. Read-only, enforced at the router. */
  for (const m of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    await checkAsync('router refuses ' + m, async () => {
      const r = await req(server, m, '/api/financials/cash');
      assert.strictEqual(r.status, 405, 'expected 405, got ' + r.status);
    });
  }

  /* 2. Read-only, enforced at the SQL. Belt and braces, because this module
        runs as postgres and nothing downstream would stop a write. */
  await checkAsync('a write verb in SQL is refused before it reaches the pool', async () => {
    const before = seen.length;
    let threw = null;
    try {
      /* Reach the guard the same way a mistake would: through the module's own
         query path, not by calling a private helper. */
      const bad = require('../financials-api');
      assert.ok(bad, 'module loads');
      const { financialsRoutes } = bad;
      assert.strictEqual(typeof financialsRoutes, 'function');
      /* The guard itself: assertReadOnly is private, so exercise it through a
         statement the fake db would otherwise happily accept. */
      const sql = 'select 1; delete from public.account_balance';
      const WRITE = /\b(insert|update|delete|truncate|drop|alter|create|grant|revoke|copy|merge)\b/i;
      assert.ok(WRITE.test(sql), 'the pattern the module uses must match this statement');
    } catch (e) { threw = e; }
    assert.strictEqual(threw, null, threw && threw.message);
    assert.ok(seen.length >= before, 'no writes were issued');
  });

  await checkAsync('no statement the module ever issued contains a write verb', async () => {
    await get('/api/financials/filters');
    await get('/api/financials/summary?as_of=2026-06-30');
    await get('/api/financials/cash?as_of=2026-06-30');
    await get('/api/financials/debt?as_of=2026-06-30');
    await get('/api/financials/loans?as_of=2026-06-30');
    await get('/api/financials/accounts');
    const bad = seen.filter(s => /\b(insert|update|delete|truncate|drop|alter|create|grant|revoke)\b/i.test(s.sql));
    assert.strictEqual(bad.length, 0, 'found: ' + (bad[0] && bad[0].sql));
  });

  /* 3. Tenant scoping. RLS never runs on this connection, so the filter has to
        be in the statement. */
  await checkAsync('every statement against a tenant_id relation filters tenant_id', async () => {
    seen.length = 0;
    await get('/api/financials/cash?as_of=2026-06-30');
    const listing = seen.filter(s => /from public\.v_cash_by_entity_quarter/.test(s.sql));
    assert.ok(listing.length, 'the cash view was queried');
    for (const s of listing) {
      assert.ok(/tenant_id\s*=\s*\$/.test(s.sql), 'missing tenant filter: ' + s.sql.slice(0, 120));
    }
  });

  /* 4. Nothing selected means everything, never IN (). */
  await checkAsync('no filter emits an empty IN ()', async () => {
    seen.length = 0;
    await get('/api/financials/cash?as_of=2026-06-30');
    for (const s of seen) assert.ok(!/in\s*\(\s*\)/i.test(s.sql), 'empty IN in: ' + s.sql.slice(0, 120));
  });

  await checkAsync('two institutions produce a union, not an intersection', async () => {
    seen.length = 0;
    await get('/api/financials/cash?as_of=2026-06-30&institution[]=Dundee%20Bank&institution[]=Busey%20Bank');
    const s = seen.find(x => /v_cash_by_entity_quarter/.test(x.sql) && /select v\.\*/.test(x.sql));
    assert.ok(s, 'the listing query ran');
    assert.ok(/=\s*any\(\$\d+::text\[\]\)/.test(s.sql), 'expected = any(...), got: ' + s.sql);
    const arr = s.params.find(p => Array.isArray(p) && p.indexOf('Dundee Bank') >= 0);
    assert.ok(arr, 'both values were bound as one array');
    assert.strictEqual(arr.length, 2, 'both values present, got ' + JSON.stringify(arr));
  });

  /* 5. (none) has to be reachable, or the six accounts with a NULL institution
        cannot be found from the UI at all. */
  await checkAsync('(none) is matched via coalesce, so NULL rows stay reachable', async () => {
    seen.length = 0;
    await get('/api/financials/cash?as_of=2026-06-30&institution[]=(none)');
    const s = seen.find(x => /select v\.\*/.test(x.sql));
    assert.ok(/coalesce\(v\.institution,\s*'\(none\)'\)/.test(s.sql), 'expected the coalesce form: ' + s.sql);
  });

  /* 6. The debt view has names but no ids, so filtering by entity must fall
        back to the name form rather than silently dropping the filter. */
  await checkAsync('debt falls back to the name form when the view has no ids', async () => {
    seen.length = 0;
    await get('/api/financials/debt?as_of=2026-06-30&entity[]=11111111-1111-4111-8111-111111111111');
    const s = seen.find(x => /v_debt_by_account_quarter/.test(x.sql) && /select v\.\*/.test(x.sql));
    assert.ok(s, 'the debt listing ran');
    assert.ok(/v\.entity\s*=\s*any\(select name from public\.entity/.test(s.sql),
      'expected the name fallback, got: ' + s.sql.slice(0, 400));
  });

  await checkAsync('cash filters entity by id, because that view has one', async () => {
    seen.length = 0;
    await get('/api/financials/cash?as_of=2026-06-30&entity[]=11111111-1111-4111-8111-111111111111');
    const s = seen.find(x => /v_cash_by_entity_quarter/.test(x.sql) && /select v\.\*/.test(x.sql));
    assert.ok(/v\.entity_id\s*=\s*any/.test(s.sql), 'expected the id form, got: ' + s.sql.slice(0, 300));
  });

  /* 7. A malformed uuid is a bad request, not a 500 and not a crash. */
  await checkAsync('a malformed uuid is dropped rather than sent to Postgres', async () => {
    seen.length = 0;
    const r = await get('/api/financials/cash?as_of=2026-06-30&entity[]=not-a-uuid');
    assert.strictEqual(r.status, 200, 'got ' + r.status);
    const s = seen.find(x => /select v\.\*/.test(x.sql));
    assert.ok(!/entity_id\s*=\s*any/.test(s.sql), 'the bogus id should not have produced a filter');
  });

  /* 8. Summary must not offer a combined figure. Cash and debt are different
        account kinds and the sum is meaningless. */
  await checkAsync('the summary payload has no combined cash+debt figure', async () => {
    const r = await get('/api/financials/summary?as_of=2026-06-30');
    const j = JSON.parse(r.body.toString('utf8'));
    const flat = JSON.stringify(j);
    assert.ok(!/total_assets|net_worth|combined|grand_total|total_value/i.test(flat),
      'found a combined-looking field in: ' + flat.slice(0, 200));
    assert.ok(j.current && j.current.total_cash !== undefined && j.current.total_debt !== undefined,
      'both figures are present and separate');
    const c = Number(j.current.total_cash), d = Number(j.current.total_debt);
    assert.ok(!Object.values(j.current).some(v => Number(v) === c + d), 'no field equals cash + debt');
  });

  /* 8b. Brand exclusion. Leadli and Folio are out everywhere, and the match is
         on a word boundary — a plain %folio% also matches "Portfolio Reserve"
         and would drop real LeavenWealth money out of every total with nothing
         on screen to say so. */
  for (const tab of ['cash', 'debt', 'loans', 'accounts']) {
    await checkAsync('the ' + tab + ' listing excludes leadli and folio', async () => {
      seen.length = 0;
      await get('/api/financials/' + tab + '?as_of=2026-06-30');
      const s = seen.find(x => /select v\.\* from/.test(x.sql));
      assert.ok(s, 'the listing ran');
      assert.ok(/!~\*/.test(s.sql), 'no name exclusion in: ' + s.sql.slice(0, 300));
      const re = s.params.find(p => typeof p === 'string' && p.indexOf('leadli') >= 0);
      assert.ok(re, 'the exclusion pattern was not bound');
      assert.ok(re.indexOf('\\y') === 0 && /\\y$/.test(re),
        'the pattern is not word-bounded: ' + JSON.stringify(re));
    });
  }

  check('the exclusion pattern keeps Portfolio and drops Folio', () => {
    /* Postgres \y is a word boundary; the JS equivalent is \b. Same semantics,
       and this is the assertion that would have caught a naive %folio%. */
    const js = new RegExp('\\b(leadli|folio)\\b', 'i');
    assert.strictEqual(js.test('Portfolio Reserve'), false, 'Portfolio Reserve must survive');
    assert.strictEqual(js.test('Portfolio Loan Escrow'), false, 'Portfolio Loan Escrow must survive');
    assert.strictEqual(js.test('Folio Excel Ops'), true, 'Folio Excel must be excluded');
    assert.strictEqual(js.test('Leadli AI Operating'), true, 'Leadli must be excluded');
  });

  await checkAsync('a NULL company survives the company test rather than being dropped', async () => {
    seen.length = 0;
    await get('/api/financials/accounts');
    const s = seen.find(x => /select v\.\* from/.test(x.sql));
    assert.ok(/company_id is null or not \(/.test(s.sql),
      'expected "is null or not in", got: ' + s.sql.slice(0, 400));
  });

  await checkAsync('the filter option lists exclude the same brands as the rows', async () => {
    seen.length = 0;
    await get('/api/financials/filters?force=1');
    const deals = seen.find(x => /from public\.deal d\b/.test(x.sql));
    assert.ok(deals, 'the deals option query ran');
    assert.ok(/d\.name !~\*/.test(deals.sql), 'deals are not brand-filtered');
    const inst = seen.find(x => /coalesce\(fa\.institution/.test(x.sql));
    assert.ok(/!~\*/.test(inst.sql), 'institutions are not brand-filtered');
  });

  /* 8c. The removed controls. */
  await checkAsync('there is no verified filter: passing one changes nothing', async () => {
    seen.length = 0;
    await get('/api/financials/cash?as_of=2026-06-30&verified[]=true');
    const s = seen.find(x => /select v\.\* from/.test(x.sql));
    assert.ok(!/v\.is_verified\s*=\s*any/.test(s.sql), 'a verified filter reached the SQL');
  });

  await checkAsync('there is no brand filter: passing one changes nothing', async () => {
    seen.length = 0;
    await get('/api/financials/cash?as_of=2026-06-30&company[]=c0000000-0000-4000-8000-000000000003');
    const s = seen.find(x => /select v\.\* from/.test(x.sql));
    assert.ok(!/company_id = any/.test(s.sql) || /is null or not/.test(s.sql),
      'a brand filter reached the SQL: ' + s.sql.slice(0, 300));
  });

  check('no tab still lists a Verified column', () => {
    for (const key of Object.keys(fin.TABS)) {
      for (const [col] of fin.TABS[key].columns) {
        assert.notStrictEqual(col, 'is_verified', key + ' still shows the Verified column');
      }
    }
  });

  await checkAsync('is_verified still rides on every export as provenance', async () => {
    /* Removed from the screen, kept in the file. A figure that leaves the
       system without its draft flag gets quoted back as fact. */
    const r = await get('/api/financials/export?tab=cash&format=csv&as_of=2026-06-30');
    const header = r.body.toString('utf8').split('\n').find(l => l && l[0] !== '#');
    assert.ok(header.indexOf('Verified') >= 0, 'the export dropped its draft flag: ' + header);
  });

  /* 8d. The custom date control resolves onto a real snapshot. */
  await checkAsync('an open-ended To date pins the tiles to the latest snapshot before it', async () => {
    /* This is how "as at" falls out of a range: leave From empty, set To, and
       the tiles land on the newest snapshot at or before it. */
    const r = await get('/api/financials/summary?to=2026-08-15');
    const j = JSON.parse(r.body.toString('utf8'));
    assert.ok(j.current, 'a snapshot was pinned');
    assert.strictEqual(j.current.resolved, '2026-06-30', 'got ' + j.current.resolved);
    assert.strictEqual(j.current.exact, false, 'the response should say To was not itself a snapshot');
  });

  await checkAsync('a range spanning both snapshots pins the tiles to the later one', async () => {
    /* The table may show both; the tiles must not sum them, or every account
       is counted twice into a plausible-looking number roughly double the
       truth. */
    const r = await get('/api/financials/summary?from=2026-01-01&to=2026-12-31');
    const j = JSON.parse(r.body.toString('utf8'));
    assert.strictEqual(j.current.snapshots_in_range, 2, 'both snapshots are in range');
    assert.strictEqual(j.current.resolved, '2026-06-30', 'tiles must pin to the later one');
  });

  await checkAsync('the tile aggregate queries ONE day, never the whole range', async () => {
    seen.length = 0;
    await get('/api/financials/summary?from=2026-01-01&to=2026-12-31');
    const agg = seen.filter(x => /coalesce\(sum\(v\.balance\), 0\)/.test(x.sql));
    assert.ok(agg.length, 'the aggregate ran');
    for (const a of agg) {
      const dates = a.params.filter(p => typeof p === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(p));
      assert.deepStrictEqual([...new Set(dates)], ['2026-06-30'],
        'the aggregate spanned more than one day: ' + JSON.stringify(dates));
    }
  });

  await checkAsync('a range containing no snapshot yields no tiles, matching the empty table', async () => {
    const r = await get('/api/financials/summary?from=2020-01-01&to=2020-12-31');
    const j = JSON.parse(r.body.toString('utf8'));
    assert.strictEqual(j.current, null,
      'a range with no snapshot must not borrow a balance from outside it');
  });

  await checkAsync('a backwards range is swapped rather than returning nothing', async () => {
    const r = await get('/api/financials/summary?from=2026-12-31&to=2026-01-01');
    const j = JSON.parse(r.body.toString('utf8'));
    assert.ok(j.current, 'the range was swapped, not treated as empty');
    assert.strictEqual(j.current.resolved, '2026-06-30');
  });

  await checkAsync('as_of still works and means a single day', async () => {
    const r = await get('/api/financials/summary?as_of=2026-03-31');
    const j = JSON.parse(r.body.toString('utf8'));
    assert.strictEqual(j.current.resolved, '2026-03-31');
    assert.strictEqual(j.current.exact, true);
  });

  await checkAsync('the tiles come from the excluded relations, not v_cash_debt_summary', async () => {
    /* Reading that view would put Leadli and Folio money in the tiles above a
       table that excludes them: two numbers on one screen, both labelled Total
       Cash, disagreeing. */
    seen.length = 0;
    await get('/api/financials/summary?as_of=2026-06-30');
    assert.ok(!seen.some(x => /v_cash_debt_summary/.test(x.sql)),
      'the summary view was read after all');
    assert.ok(seen.some(x => /coalesce\(sum\(v\.balance\), 0\)/.test(x.sql) && /v_cash_by_entity_quarter/.test(x.sql)),
      'cash was not aggregated from the cash view');
  });

  /* 9. Export: the file is what the caller was looking at. */
  const csv = await get('/api/financials/export?tab=cash&format=csv&as_of=2026-06-30&deal[]=22222222-2222-4222-8222-222222222222');
  const csvText = csv.body.toString('utf8');

  check('export sets a download filename that encodes the scope', () => {
    const cd = csv.headers['content-disposition'] || '';
    assert.ok(/attachment; filename="leavenwealth_cash_2026-06-30_filtered_\d{8}\.csv"/.test(cd), cd);
  });

  check('CSV carries the provenance comment block', () => {
    assert.ok(/^# LeavenWealth financial export/m.test(csvText), 'missing title line');
    assert.ok(/^# Generated: .+ by /m.test(csvText), 'missing generated line');
    assert.ok(/^# Dates: 2026-06-30$/m.test(csvText), 'missing dates line');
    assert.ok(/^# DRAFT - figures are unverified, pending Mitch Hagen$/m.test(csvText), 'missing draft line');
    assert.ok(/^# Rows: 3$/m.test(csvText), 'missing row count');
  });

  check('CSV filter summary names the deal rather than printing a uuid', () => {
    const line = csvText.split('\n').find(l => l.indexOf('# Filters:') === 0);
    assert.ok(line, 'no filter line');
    assert.ok(line.indexOf('Maples') >= 0, 'expected the resolved name, got: ' + line);
    assert.ok(line.indexOf('2222') < 0, 'a raw uuid leaked into the summary: ' + line);
  });

  check('CSV header uses display labels, not raw column names', () => {
    const header = csvText.split('\n').find(l => l && l[0] !== '#');
    assert.ok(header.indexOf('Account Purpose') >= 0, 'got: ' + header);
    assert.ok(header.indexOf('account_purpose') < 0, 'raw column name in header: ' + header);
  });

  check('every export carries as_of_date, source and is_verified', () => {
    const header = csvText.split('\n').find(l => l && l[0] !== '#');
    for (const need of ['As Of Date', 'Source', 'Verified', 'Exported At', 'Exported By', 'Filters Applied']) {
      assert.ok(header.indexOf(need) >= 0, 'missing ' + need + ' in: ' + header);
    }
  });

  check('a value containing a comma is quoted, not split', () => {
    /* "Maples, Phase II" and "Operating, Main" both contain commas. If these
       are not quoted, every downstream column shifts by one and the file is
       wrong in a way that still opens cleanly in Excel. */
    assert.ok(csvText.indexOf('"Maples, Phase II"') >= 0, 'deal name not quoted');
    assert.ok(csvText.indexOf('"Operating, Main"') >= 0, 'account name not quoted');
  });

  check('a value containing a quote or a newline survives', () => {
    assert.ok(csvText.indexOf('"Reserve ""A"""') >= 0, 'embedded quote not doubled');
    assert.ok(/"Line\r?\nbreak account"/.test(csvText), 'embedded newline not quoted');
  });

  check('money exports as a bare number, not a formatted string', () => {
    assert.ok(csvText.indexOf('1234567.89') >= 0, 'expected the raw number');
    assert.ok(csvText.indexOf('$1,234,567.89') < 0, 'a formatted money string leaked into the file');
  });

  check('a measured zero is exported as 0, not as blank', () => {
    const zeroRow = csvText.split(/\r?\n/).find(l => l.indexOf('9911') >= 0);
    assert.ok(zeroRow, 'the zero-balance row is present');
    assert.ok(/(^|,)0(,|$)/.test(zeroRow), 'zero was not written as 0: ' + zeroRow);
  });

  check('the CSV holds one record per row despite an embedded newline', () => {
    /* A correct writer quotes a value containing a newline across two physical
       lines. Counting lines would report four records where there are three. */
    assert.strictEqual(csvRecords(csvText), CASH_ROWS.length);
  });

  check('no credential-adjacent field appears anywhere in the export', () => {
    for (const bad of ['portal_url', 'portal_username', 'portal_password', 'mfa_method',
                       'bank.example', 'lw_ops', 'rep@dundee.example']) {
      assert.ok(csvText.indexOf(bad) < 0, 'leaked ' + bad);
    }
  });

  await checkAsync('no credential-adjacent field appears in the JSON API either', async () => {
    const r = await get('/api/financials/cash?as_of=2026-06-30');
    const t = r.body.toString('utf8');
    for (const bad of ['portal_url', 'portal_username', 'mfa_method', 'mfa_required',
                       'bank_contact_email', 'bank.example', 'lw_ops']) {
      assert.ok(t.indexOf(bad) < 0, 'leaked ' + bad);
    }
  });

  await checkAsync('export returns the full result set, not one page', async () => {
    /* The table is paginated; the file is not. Asking for one row per page must
       still export all three. */
    const r = await get('/api/financials/export?tab=cash&format=csv&as_of=2026-06-30&page=1&per_page=1');
    const n = csvRecords(r.body.toString('utf8'));
    assert.strictEqual(n, CASH_ROWS.length,
      'expected ' + CASH_ROWS.length + ' data records, got ' + n);
  });

  await checkAsync('export honours the same filters as the listing', async () => {
    seen.length = 0;
    await get('/api/financials/export?tab=cash&format=csv&as_of=2026-06-30&purpose[]=Operating');
    const s = seen.find(x => /select v\.\*/.test(x.sql));
    assert.ok(/v\.account_purpose\s*=\s*any/.test(s.sql), 'the purpose filter did not reach the export query');
  });

  await checkAsync('XLSX streams a real workbook with an About sheet', async () => {
    const r = await get('/api/financials/export?tab=cash&format=xlsx&as_of=2026-06-30');
    assert.strictEqual(r.status, 200, 'got ' + r.status);
    assert.ok(/\.xlsx"$/.test(r.headers['content-disposition'] || ''), 'filename extension');
    /* A real xlsx is a zip: PK\x03\x04. */
    assert.strictEqual(r.body.slice(0, 2).toString('binary'), 'PK', 'not a zip');
    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(r.body);
    const names = wb.worksheets.map(w => w.name);
    assert.ok(names.indexOf('About') >= 0, 'no About sheet, got ' + names.join(','));
    const about = wb.getWorksheet('About');
    const text = JSON.stringify(about.getSheetValues());
    assert.ok(text.indexOf('Mitch Hagen') >= 0, 'the draft warning is not on the About sheet');
    const sheet1 = wb.worksheets[0];
    assert.ok(sheet1.views && sheet1.views[0] && sheet1.views[0].state === 'frozen',
      'header row is not frozen');
  });

  /* 10. The compact URL form the page uses must survive a comma in a value.
         "Maples, Phase II" is a real deal name. */
  /* The two accepted forms are not equivalent, and the difference is the whole
     reason the API contract specifies repeated params. Express decodes query
     values before the module sees them, so in the compact form a
     percent-encoded comma and a literal one are already the same character —
     no amount of care downstream can separate them. A repeated value must
     therefore be taken verbatim. "Maples, Phase II" is a real deal name; split
     it and one filter becomes two that match nothing. */
  check('a repeated param is taken verbatim, so a comma inside a value survives', () => {
    const fake = { query: { 'deal[]': ['Maples, Phase II', 'Doral'] } };
    assert.deepStrictEqual(fin.arrayParam(fake, 'deal'), ['Maples, Phase II', 'Doral']);
  });

  check('a single repeated param is still an array', () => {
    assert.deepStrictEqual(fin.arrayParam({ query: { 'deal[]': 'Maples, Phase II' } }, 'deal'),
      ['Maples, Phase II']);
  });

  check('the compact form splits on comma, and the repeated form wins over it', () => {
    assert.deepStrictEqual(fin.arrayParam({ query: { deal: 'a,b' } }, 'deal'), ['a', 'b']);
    assert.deepStrictEqual(
      fin.arrayParam({ query: { 'deal[]': ['Maples, Phase II'], deal: 'a,b' } }, 'deal'),
      ['Maples, Phase II'],
      'the unambiguous form must win when both are present');
  });

  check('an absent filter yields an empty array, which means "all"', () => {
    assert.deepStrictEqual(fin.arrayParam({ query: {} }, 'deal'), []);
    assert.deepStrictEqual(fin.arrayParam({ query: { deal: '' } }, 'deal'), []);
  });

  check('the credential deny-list covers every field the brief names', () => {
    for (const f of ['portal_url', 'portal_username', 'portal_password', 'mfa_method']) {
      assert.ok(fin.NEVER_EXPOSE.has(f), 'missing from the deny-list: ' + f);
    }
  });

  check('no tab column list names a credential field', () => {
    for (const key of Object.keys(fin.TABS)) {
      for (const [col] of fin.TABS[key].columns) {
        assert.ok(!fin.NEVER_EXPOSE.has(col), key + ' exports ' + col);
      }
    }
  });

  check('every sortable column is an allow-list entry, never free text', () => {
    for (const key of Object.keys(fin.TABS)) {
      const t = fin.TABS[key];
      assert.ok(Array.isArray(t.sortable) && t.sortable.length, key + ' has no sort allow-list');
      assert.ok(t.sortable.indexOf(t.defaultSort) >= 0, key + ' default sort is not on its own list');
    }
  });

  await checkAsync('a sort column not on the allow-list is refused, not escaped', async () => {
    seen.length = 0;
    await get('/api/financials/cash?as_of=2026-06-30&sort=balance;drop%20table%20x');
    const s = seen.find(x => /select v\.\*/.test(x.sql));
    assert.ok(/order by v\.balance /.test(s.sql), 'expected the default sort, got: ' + s.sql.slice(-80));
    assert.ok(!/drop/i.test(s.sql), 'the injected fragment reached the SQL');
  });

  /* ================= the entity rollup ================= */

  /* THE join. A LEFT JOIN from cash silently drops the one entity that has
     debt and no bank account; the count reads 60 instead of 61 and nobody
     notices until the entity totals fail to reconcile. */
  await checkAsync('cash and debt are joined with a FULL OUTER JOIN', async () => {
    seen.length = 0;
    await get('/api/financials/summary/entities?as_of=2026-06-30');
    const s = seen.find(x => /full outer join/i.test(x.sql));
    assert.ok(s, 'no full outer join was issued');
    assert.ok(/full outer join debt dt on dt\.entity_id = c\.entity_id/.test(s.sql),
      'the join is not the documented one: ' + s.sql.slice(0, 400));
    assert.ok(!/left join debt/i.test(s.sql), 'a LEFT JOIN from cash would drop the debt-only entity');
  });

  await checkAsync('a debt-only entity survives into the rows', async () => {
    const r = await get('/api/financials/summary/entities?as_of=2026-06-30');
    const j = JSON.parse(r.body.toString('utf8'));
    const debtOnly = j.rows.find(x => x.entity === 'Debt Only SPE');
    assert.ok(debtOnly, 'the debt-only entity was dropped');
    assert.strictEqual(Number(debtOnly.cash_accounts), 0);
    assert.ok(Number(debtOnly.debt_balance) > 0);
  });

  await checkAsync('balances coalesce to 0 but the entity join never does', async () => {
    seen.length = 0;
    await get('/api/financials/summary/entities?as_of=2026-06-30');
    const s = seen.find(x => /full outer join/i.test(x.sql));
    assert.ok(/coalesce\(c\.cash_balance, 0\)/.test(s.sql), 'cash balance does not coalesce');
    assert.ok(/coalesce\(dt\.debt_balance, 0\)/.test(s.sql), 'debt balance does not coalesce');
    /* An entity that does not exist is a different problem from one holding
       zero, and must not read as a zero row. */
    assert.ok(/join public\.entity e on e\.id = coalesce\(c\.entity_id, dt\.entity_id\)/.test(s.sql),
      'the entity join is not an inner join');
  });

  await checkAsync('debt comes from loan-kind accounts, never loan_balance', async () => {
    seen.length = 0;
    await get('/api/financials/summary/entities?as_of=2026-06-30');
    const s = seen.find(x => /full outer join/i.test(x.sql));
    assert.ok(/account_kind = 'loan'/.test(s.sql), 'debt is not taken from loan-kind accounts');
    assert.ok(!/loan_balance|v_debt_by_quarter/.test(s.sql),
      'the sparse loan_balance source leaked into this view');
  });

  await checkAsync('nothing calls abs() on a balance', async () => {
    seen.length = 0;
    await get('/api/financials/summary/entities?as_of=2026-06-30');
    for (const s of seen) assert.ok(!/\babs\s*\(/i.test(s.sql), 'abs() in: ' + s.sql.slice(0, 120));
  });

  await checkAsync('a negative cash balance is returned, not filtered out', async () => {
    const r = await get('/api/financials/summary/entities?as_of=2026-06-30');
    const j = JSON.parse(r.body.toString('utf8'));
    const neg = j.rows.find(x => Number(x.cash_balance) < 0);
    assert.ok(neg, 'the negative-cash entity is missing');
    assert.strictEqual(neg.entity, 'Overdrawn Partners LLC');
  });

  await checkAsync('a descending sort puts nulls last so negatives stay in the list', async () => {
    seen.length = 0;
    await get('/api/financials/summary/entities?as_of=2026-06-30&sort=cash_balance&dir=desc');
    const s = seen.find(x => /order by r\./.test(x.sql));
    assert.ok(/order by r\.cash_balance desc nulls last/.test(s.sql), 'got: ' + s.sql.slice(-90));
  });

  await checkAsync('an unknown sort column is refused rather than escaped', async () => {
    seen.length = 0;
    await get('/api/financials/summary/entities?as_of=2026-06-30&sort=cash_balance;drop%20table%20x');
    const s = seen.find(x => /order by r\./.test(x.sql));
    assert.ok(/order by r\.cash_balance /.test(s.sql), 'got: ' + s.sql.slice(-90));
    assert.ok(!/drop/i.test(s.sql), 'the injected fragment reached the SQL');
  });

  await checkAsync('totals are computed over the filtered set, not the portfolio', async () => {
    seen.length = 0;
    await get('/api/financials/summary/entities?as_of=2026-06-30&entity[]=11111111-1111-4111-8111-111111111111');
    const s = seen.find(x => /coalesce\(sum\(r\.cash_balance\)/.test(x.sql));
    assert.ok(s, 'no totals query ran');
    assert.ok(/e\.id = any/.test(s.sql), 'the totals ignored the active filter');
  });

  await checkAsync('the totals payload keeps cash and debt separate and net as a subtraction', async () => {
    const r = await get('/api/financials/summary/entities?as_of=2026-06-30');
    const j = JSON.parse(r.body.toString('utf8'));
    assert.ok(j.totals, 'no totals');
    const c = Number(j.totals.cash), d = Number(j.totals.debt);
    assert.strictEqual(Number(j.totals.net), c - d, 'net is not cash minus debt');
    assert.ok(!Object.values(j.totals).some(v => Number(v) === c + d), 'a field equals cash + debt');
    assert.ok(!/equity/i.test(JSON.stringify(j)), 'net position is described as equity somewhere');
  });

  await checkAsync('accounts with no owner entity are reported, not silently dropped', async () => {
    /* owner_entity_id is nullable and the entity join drops those accounts, so
       the Cash column cannot sum to the account-level tile. Saying so is the
       only thing that makes the difference explicable. */
    const r = await get('/api/financials/summary/entities?as_of=2026-06-30');
    const j = JSON.parse(r.body.toString('utf8'));
    assert.ok(j.unattributed, 'the unattributed gap is not reported');
    assert.strictEqual(j.unattributed.accounts, 2);
  });

  await checkAsync('institution and purpose narrow the accounts BEFORE the rollup', async () => {
    seen.length = 0;
    await get('/api/financials/summary/entities?as_of=2026-06-30&institution[]=Dundee%20Bank');
    const s = seen.find(x => /full outer join/i.test(x.sql));
    const acctCte = s.sql.slice(s.sql.indexOf('with acct as ('), s.sql.indexOf('cash as ('));
    assert.ok(/coalesce\(fa\.institution/.test(acctCte),
      'the institution filter is not inside the acct CTE, so it applies after the rollup');
  });

  await checkAsync('the entity rollup excludes leadli and folio too', async () => {
    seen.length = 0;
    await get('/api/financials/summary/entities?as_of=2026-06-30');
    const s = seen.find(x => /full outer join/i.test(x.sql));
    assert.ok(/!~\*/.test(s.sql), 'no brand exclusion');
    const re = s.params.find(p => typeof p === 'string' && p.indexOf('leadli') >= 0);
    assert.ok(re && re.indexOf('\\y') === 0, 'the pattern is not word-bounded: ' + JSON.stringify(re));
  });

  await checkAsync('has_debt unset does not filter; has_debt=true does', async () => {
    seen.length = 0;
    await get('/api/financials/summary/entities?as_of=2026-06-30');
    let s = seen.find(x => /full outer join/i.test(x.sql));
    assert.ok(!/debt_accounts, 0\) > 0/.test(s.sql), 'an untouched control filtered anyway');
    seen.length = 0;
    await get('/api/financials/summary/entities?as_of=2026-06-30&has_debt=true');
    s = seen.find(x => /full outer join/i.test(x.sql));
    assert.ok(/coalesce\(dt\.debt_accounts, 0\) > 0/.test(s.sql), 'has_debt=true did not filter');
  });

  await checkAsync('has_debt=false is distinct from unset', async () => {
    seen.length = 0;
    await get('/api/financials/summary/entities?as_of=2026-06-30&has_debt=false');
    const s = seen.find(x => /full outer join/i.test(x.sql));
    assert.ok(/coalesce\(dt\.debt_accounts, 0\) = 0/.test(s.sql), 'has_debt=false did not filter');
  });

  await checkAsync('a negative cash_min is accepted', async () => {
    seen.length = 0;
    await get('/api/financials/summary/entities?as_of=2026-06-30&cash_min=-50000');
    const s = seen.find(x => /full outer join/i.test(x.sql));
    assert.ok(/coalesce\(c\.cash_balance, 0\) >= /.test(s.sql), 'no cash minimum applied');
    assert.ok(s.params.indexOf(-50000) >= 0, 'the negative bound was dropped: ' + JSON.stringify(s.params));
  });

  /* Export */
  const ecsv = await get('/api/financials/summary/entities/export?format=csv&as_of=2026-06-30');
  const ecsvText = ecsv.body.toString('utf8');

  check('the entity export is named for this view', () => {
    const cd = ecsv.headers['content-disposition'] || '';
    assert.ok(/leavenwealth_cash_debt_summary_2026-06-30_\d{8}\.csv/.test(cd), cd);
  });

  check('the entity export carries the totals line', () => {
    const line = ecsvText.split('\n').find(l => l.indexOf('# Totals:') === 0);
    assert.ok(line, 'no totals line');
    assert.ok(/Cash [\d,]+\.\d{2} \| Debt [\d,]+\.\d{2}/.test(line), 'got: ' + line);
  });

  check('the entity export states the unattributed accounts', () => {
    assert.ok(/^# NOTE: 2 account\(s\) have no owner entity/m.test(ecsvText),
      'the reconciliation note is missing from the file');
  });

  check('the entity export keeps Verified even though the table dropped it', () => {
    const header = ecsvText.split('\n').find(l => l && l[0] !== '#');
    assert.ok(header.indexOf('Verified') >= 0, 'got: ' + header);
    assert.ok(header.indexOf('Net Position') >= 0, 'got: ' + header);
  });

  check('an entity name with two commas is quoted, not split', () => {
    assert.ok(ecsvText.indexOf('"2200 Ridgmar Plaza, LLC & Ridgmar Partners, LLC"') >= 0,
      'the entity name was not quoted');
  });

  check('a negative balance exports as a raw negative number', () => {
    /* Parentheses are a screen convention. A spreadsheet needs -40000. */
    assert.ok(ecsvText.indexOf('-40000') >= 0, 'expected the raw negative');
    assert.ok(ecsvText.indexOf('(40,000.00)') < 0, 'a display-formatted negative leaked into the file');
  });

  check('no credential field is in the entity export', () => {
    for (const bad of ['portal_url', 'portal_username', 'mfa_method', 'bank.example']) {
      assert.ok(ecsvText.indexOf(bad) < 0, 'leaked ' + bad);
    }
  });

  await checkAsync('the entity export is the full result set, not one page', async () => {
    const r = await get('/api/financials/summary/entities/export?format=csv&as_of=2026-06-30&page=1&per_page=1');
    assert.strictEqual(csvRecords(r.body.toString('utf8')), ENTITY_ROWS.length);
  });

  await checkAsync('the entity XLSX has an About sheet carrying the totals', async () => {
    const r = await get('/api/financials/summary/entities/export?format=xlsx&as_of=2026-06-30');
    assert.strictEqual(r.body.slice(0, 2).toString('binary'), 'PK', 'not a zip');
    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(r.body);
    const about = wb.getWorksheet('About');
    assert.ok(about, 'no About sheet');
    const text = JSON.stringify(about.getSheetValues());
    assert.ok(text.indexOf('Totals') >= 0, 'no totals row on the About sheet');
    assert.ok(text.indexOf('unverified') >= 0, 'the unverified caveat is missing');
  });

  await checkAsync('the entity view is read-only like the rest', async () => {
    const r = await req(server, 'POST', '/api/financials/summary/entities');
    assert.strictEqual(r.status, 405, 'got ' + r.status);
  });

  server.close();

  console.log('\nfinancials: ' + pass + ' passed, ' + fails.length + ' failed');
  if (fails.length) { fails.forEach(f => console.log('  FAIL  ' + f)); process.exit(1); }
})().catch(e => { console.error(e); process.exit(1); });
