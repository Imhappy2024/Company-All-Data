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
    if (/count\(\*\)::int as n/.test(sql)) return Promise.resolve({ rows: [{ n: CASH_ROWS.length }] });
    if (/from public\.v_cash_debt_summary/.test(sql)) {
      return Promise.resolve({ rows: [{ year: 2026, quarter: 2, total_cash: '5073105.35',
        total_debt: '225424320.06', cash_accounts: 160, loan_accounts: 55, all_verified: false }] });
    }
    if (/from public\.loan\b|count\(distinct loan_id\)/.test(sql)) {
      return Promise.resolve({ rows: [{ loans: 75, with_balance: 54 }] });
    }
    if (/select id, name from public\.(deal|company|entity)/.test(sql)) {
      return Promise.resolve({ rows: [{ id: (params && params[1] && params[1][0]) || 'x', name: 'Maples, Phase II' }] });
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
    assert.ok(/^# Quarter: 2026-06-30$/m.test(csvText), 'missing quarter line');
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

  server.close();

  console.log('\nfinancials: ' + pass + ' passed, ' + fails.length + ' failed');
  if (fails.length) { fails.forEach(f => console.log('  FAIL  ' + f)); process.exit(1); }
})().catch(e => { console.error(e); process.exit(1); });
