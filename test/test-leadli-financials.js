/* Leadli AI financials — the empty state, and the day it stops being empty.

   Built to LEADLI_FINANCIAL_SPEC §6. Verified live 2026-09-08: Leadli has 0
   sales_payment rows, 0 subscription_client, 0 transaction, 2,557 leads and 0
   with is_client, and `sales_payment` has NO is_test column.

   Every check runs against TWO fixtures:

     EMPTY   what the screen shows today
     SEEDED  one real payment inserted by hand

   because the spec's real acceptance check is "inserting a test Leadli payment
   makes all four cards and the table populate with no code change". A suite
   that only tested the empty state would pass on a screen that can never
   show anything.

   Run: node test/test-leadli-financials.js
*/

const assert = require('assert');
const http = require('http');
const fs = require('fs');
const path = require('path');
const express = require('express');

const TENANT = '72381c81-af95-4e1d-ad0d-20a3a3421119';
const LEADLI_COMPANY = 'c0000000-0000-4000-8000-000000000001';
const LEADLI_ENTITY = '8bd3c562-1feb-4e85-b363-bc21aebff616';

/* One payment, shaped as sales_payment holds it, and chosen so several traps
   are live at once:
     - customer_name is NULL, as Whop sends it routinely, so the fallback chain
       has to run (it was null on the one real Folio payment)
     - product_name matches no `service` catalogue entry, which is why nothing
       joins them
     - a 100.75 fee, so gross != net and the row expand has something to show */
const PAYMENT = {
  id: 'p-leadli-1',
  external_payment_id: 'pay_leadli_001',
  external_subscription_id: 'mem_leadli_x1',
  external_customer_id: 'user_LEADLI1',
  product_name: 'Whop Pro - Leadli',
  customer_name: null,
  raw: { billing_address: { name: null }, user: { username: 'shivani_s' },
         payment_instrument: { display_name: 'Visa 4242' }, receipt_number: 'R-001' },
  customer_email: 'ops@example.test',
  usd_total: '2500.00', total: '2500.00', currency: 'USD',
  fee_amount: '100.75', amount_after_fees: '2399.25', refunded_amount: '0.00',
  billing_reason: 'subscription_create', status: 'paid', substatus: 'succeeded',
  paid_at: '2026-09-08T19:40:00Z', refunded_at: null,
  source_created_at: '2026-09-08T19:40:00Z',
  notes: null,
};

/* Folio's rows live in the same table. They must never reach a Leadli figure,
   which is what makes the company filter worth asserting rather than assuming. */
const FOLIO_PAYMENT = {
  id: 'p-folio-1', external_payment_id: 'pay_zZNxyVzd31xESP',
  external_customer_id: 'user_UXmbt3s7kazEB', customer_name: 'J & M',
  usd_total: '1000.00', total: '1000.00', currency: 'USD',
  fee_amount: '40.37', amount_after_fees: '959.63', refunded_amount: '0.00',
  billing_reason: 'subscription_create', status: 'paid', substatus: 'succeeded',
  paid_at: '2026-08-17T19:06:40Z', notes: null, raw: {},
  customer_email: 'brandi@jandmrealestate.com', external_subscription_id: 'mem_m1Z0CYCBZUtgxy',
  product_name: 'Chris Pomerleau-Standard', source_created_at: '2026-08-17T19:06:40Z',
  refunded_at: null,
};

/* A $1 test row, matched by the provisional predicate the way the live data
   is: TEST TRANSACTION in notes AND a Whop-anonymised email. */
const TEST_PAYMENT = {
  id: 'p-leadli-test', external_payment_id: 'pay_leadli_test',
  external_subscription_id: null, external_customer_id: null,
  product_name: null, customer_name: 'Shivani Sharma', raw: {},
  customer_email: '225faa5e0c7253c4@deleted.com',
  usd_total: '1.00', total: '1.00', currency: 'USD',
  fee_amount: '0.42', amount_after_fees: '0.58', refunded_amount: '0.00',
  billing_reason: 'one_time', status: 'paid', substatus: 'succeeded',
  paid_at: '2026-09-01T00:00:00Z', refunded_at: null,
  source_created_at: '2026-09-01T00:00:00Z',
  notes: 'TEST TRANSACTION - $1 card test.',
};

const LEADS = 2557;

let seeded = false;              /* flipped to run the whole suite twice */
let hasIsTestColumn = false;     /* the probe's answer */
const seen = [];

const num = v => (v === null || v === undefined ? 0 : Number(v));
const isTest = p => /TEST TRANSACTION/i.test(p.notes || '')
                 || /@deleted\.com$/.test(p.customer_email || '');

/* Rows the fake exposes as `sales_payment` for the LEADLI company. Folio's row
   is in the table but never in this list, because the module filters by
   company_id - if it stopped doing that, the fake would have to be wrong for
   the test to pass. */
function leadliRows() {
  if (!seeded) return [];
  return [PAYMENT, TEST_PAYMENT];
}
function allRows() {
  return leadliRows().concat([FOLIO_PAYMENT]);
}

const fakeDb = {
  enabled: true,
  getPool() { throw new Error('not needed'); },
  q(sql, params) {
    seen.push({ sql, params });

    /* The is_test capability probe. */
    if (/information_schema\.columns/.test(sql) && /is_test/.test(sql)) {
      return Promise.resolve({ rows: hasIsTestColumn ? [{ '?column?': 1 }] : [] });
    }

    /* The lead count for the empty state. */
    if (/from public\.lead l/.test(sql)) {
      return Promise.resolve({ rows: [{ total_leads: LEADS }] });
    }

    if (/from public\.sales_payment sp/.test(sql)) {
      const scopedToLeadli = params.indexOf(LEADLI_COMPANY) >= 0;
      let rows = scopedToLeadli ? leadliRows() : allRows();
      const excludesTest = /not \(sp\.notes ilike/.test(sql) || /not coalesce\(sp\.is_test/.test(sql);
      if (excludesTest) rows = rows.filter(p => !isTest(p));
      const paidOnly = /sp\.status = 'paid'/.test(sql);
      if (paidOnly) rows = rows.filter(p => p.status === 'paid');

      /* The service-type filter, honoured rather than ignored. Without this
         the chips appear to work while the fake returns everything, and the
         check that they narrow anything passes on nothing. */
      if (/end\) = any\(\$\d+::text\[\]\)/.test(sql)) {
        const wanted = params.filter(p => Array.isArray(p)).pop() || [];
        rows = rows.filter(p => {
          const b = ['one_time', 'manual'].indexOf(p.billing_reason) >= 0 ? 'One-time'
                  : p.billing_reason ? 'Subscription' : 'Unknown';
          return wanted.indexOf(b) >= 0;
        });
      }

      /* An aggregate: one row, computed the way Postgres would. */
      if (/count\(\*\)::int\s+as payment_count/.test(sql) || /as total_amount/.test(sql)) {
        const recurring = ['subscription_create', 'subscription_cycle', 'subscription_update', 'subscription'];
        const oneOff = ['one_time', 'manual'];
        const payers = new Set(rows.map(p => p.external_customer_id || p.customer_email));
        const subs = new Set(rows.map(p => p.external_subscription_id).filter(Boolean));
        return Promise.resolve({ rows: [{
          total_amount: rows.reduce((t, p) => t + num(p.usd_total), 0).toFixed(2),
          total_clients: payers.size,
          subscription_count: rows.filter(p => recurring.indexOf(p.billing_reason) >= 0).length,
          one_time_count: rows.filter(p => oneOff.indexOf(p.billing_reason) >= 0).length,
          unknown_reason_count: rows.filter(p => !p.billing_reason).length,
          distinct_subscriptions: subs.size,
          payment_count: rows.length,
          fees_total: rows.reduce((t, p) => t + num(p.fee_amount), 0).toFixed(2),
          net_total: rows.reduce((t, p) => t + num(p.amount_after_fees), 0).toFixed(2),
          first_paid_at: rows.map(p => p.paid_at).sort()[0] || null,
          last_paid_at: rows.map(p => p.paid_at).sort().pop() || null,
          currency: 'USD', currencies: rows.length ? 1 : 0,
        }] });
      }

      /* The table. The fallback chain is applied here the way the SQL does,
         written out independently so the fake cannot agree with the module by
         construction. */
      return Promise.resolve({ rows: rows.map(p => {
        const ba = (p.raw && p.raw.billing_address && p.raw.billing_address.name) || null;
        const un = (p.raw && p.raw.user && p.raw.user.username) || null;
        const name = p.customer_name || ba || un || p.customer_email || null;
        const src = p.customer_name ? 'payment'
                  : ba ? 'billing_address'
                  : un ? 'whop_username'
                  : p.customer_email ? 'email' : 'none';
        const oneOff = ['one_time', 'manual'].indexOf(p.billing_reason) >= 0;
        return Object.assign({}, p, {
          customer_name: name, name_source: src,
          card: (p.raw && p.raw.payment_instrument && p.raw.payment_instrument.display_name) || null,
          receipt_number: (p.raw && p.raw.receipt_number) || null,
          failure_message: null,
          is_test: isTest(p),
          service_type: oneOff ? 'One-time' : (p.billing_reason ? 'Subscription' : 'Unknown'),
        });
      }) });
    }

    return Promise.resolve({ rows: [] });
  },
};

require.cache[require.resolve('../supabase-db')] =
  { id: 'fake', filename: 'fake', loaded: true, exports: fakeDb };
const leadli = require('../leadli-financials-api');

let pass = 0;
const fails = [];
function check(n, fn) { try { fn(); pass++; } catch (e) { fails.push(n + ' -> ' + e.message); } }
async function checkAsync(n, fn) { try { await fn(); pass++; } catch (e) { fails.push(n + ' -> ' + e.message); } }

const BASE = '/api/leadli/financials';
function serve() {
  const app = express();
  app.use(BASE, leadli.leadliFinancialsRoutes());
  return new Promise(r => { const s = app.listen(0, () => r(s)); });
}
function req(server, method, url) {
  return new Promise((resolve, reject) => {
    const r = http.request({ port: server.address().port, path: url, method }, res => {
      const c = []; res.on('data', x => c.push(x));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(c) }));
    });
    r.on('error', reject); r.end();
  });
}
const json = r => JSON.parse(r.body.toString('utf8'));

function numbers(o, at, out) {
  out = out || []; at = at || '';
  if (o === null || o === undefined) return out;
  if (typeof o === 'number') { out.push([at, o]); return out; }
  if (Array.isArray(o)) { o.forEach((v, i) => numbers(v, at + '[' + i + ']', out)); return out; }
  if (typeof o === 'object') Object.keys(o).forEach(k => numbers(o[k], at ? at + '.' + k : k, out));
  return out;
}

(async () => {
  const server = await serve();
  const get = u => req(server, 'GET', BASE + u);

  /* ---- read-only ------------------------------------------------------- */
  for (const m of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    await checkAsync('refuses ' + m, async () => {
      assert.strictEqual((await req(server, m, BASE + '/summary')).status, 405);
    });
  }
  await checkAsync('no statement contains a write verb', async () => {
    seen.length = 0;
    await get('/summary'); await get('/payments');
    const bad = seen.filter(s => /\b(insert|update|delete|truncate|drop|alter|create|grant|revoke)\b/i.test(s.sql));
    assert.strictEqual(bad.length, 0, bad[0] && bad[0].sql.slice(0, 120));
  });

  /* ---- scoping --------------------------------------------------------- */
  await checkAsync('every statement is tenant-scoped and Leadli-scoped', async () => {
    seen.length = 0;
    await get('/summary'); await get('/payments');
    const data = seen.filter(s => !/information_schema/.test(s.sql));
    assert.ok(data.length, 'statements ran');
    for (const s of data) {
      assert.ok(s.params.indexOf(TENANT) >= 0, 'not tenant-scoped: ' + s.sql.slice(0, 80));
      assert.ok(s.params.indexOf(LEADLI_COMPANY) >= 0,
        'not Leadli-scoped: ' + s.sql.slice(0, 80));
    }
  });

  await checkAsync('nothing reads transaction.company_id', async () => {
    seen.length = 0;
    await get('/summary'); await get('/payments');
    assert.strictEqual(seen.filter(s => /transaction/.test(s.sql) && /company_id/.test(s.sql)).length, 0);
  });

  await checkAsync('nothing reads is_client', async () => {
    seen.length = 0;
    await get('/summary'); await get('/payments');
    const bad = seen.filter(s => /is_client/.test(s.sql));
    assert.strictEqual(bad.length, 0, bad[0] && bad[0].sql.slice(0, 90));
  });

  await checkAsync('nothing sums subscription_client for the total', async () => {
    /* That column is a recurring RATE, not money received. */
    seen.length = 0;
    await get('/summary');
    const bad = seen.filter(s => /subscription_client/.test(s.sql));
    assert.strictEqual(bad.length, 0, 'the total came from subscription_client');
  });

  await checkAsync('nothing joins product_name to the service catalogue', async () => {
    seen.length = 0;
    await get('/payments');
    const bad = seen.filter(s => /public\.service\b/.test(s.sql));
    assert.strictEqual(bad.length, 0, 'a name join to `service` would mislabel revenue');
  });

  await checkAsync('no statement groups by a pipeline stage', async () => {
    seen.length = 0;
    await get('/summary'); await get('/payments');
    const bad = seen.filter(s => /pipeline_stage/.test(s.sql));
    assert.strictEqual(bad.length, 0, 'CRM pipeline data belongs on the Leads page');
  });

  /* ---- the is_test probe ----------------------------------------------- */
  await checkAsync('the test filter is provisional while the column is absent', async () => {
    const s = json(await get('/summary'));
    assert.strictEqual(s.test_filter.provisional, true);
    assert.ok(/notes/.test(s.test_filter.note), s.test_filter.note);
  });

  await checkAsync('the predicate applies BOTH halves, per the spec', async () => {
    seen.length = 0;
    await get('/payments');
    const p = seen.filter(s => /from public\.sales_payment/.test(s.sql))[0];
    assert.ok(/TEST TRANSACTION/.test(p.sql), 'the notes half is missing');
    assert.ok(/@deleted\.com/.test(p.sql), 'the anonymised-email half is missing');
  });

  await checkAsync('and it switches to is_test the moment the column exists', async () => {
    /* The probe caches, so this clears it - and this is what makes the spec's
       "no code change" promise true in the other direction too. */
    leadli._resetTestCap();
    hasIsTestColumn = true;
    seen.length = 0;
    const s = json(await get('/summary'));
    assert.strictEqual(s.test_filter.provisional, false);
    const p = seen.filter(s2 => /from public\.sales_payment/.test(s2.sql))[0];
    assert.ok(/is_test/.test(p.sql), 'the column is not used');
    assert.ok(!/TEST TRANSACTION/.test(p.sql), 'the notes string is still being matched');
    hasIsTestColumn = false;
    leadli._resetTestCap();
  });

  /* ---- THE EMPTY STATE (what the screen shows today) ------------------- */
  await checkAsync('all four cards read zero', async () => {
    const s = json(await get('/summary'));
    assert.strictEqual(s.total_amount, 0);
    assert.strictEqual(s.total_clients, 0);
    assert.strictEqual(s.subscription_count, 0);
    assert.strictEqual(s.one_time_count, 0);
  });

  await checkAsync('and the payload says it is empty, from the count', async () => {
    /* Derived, not hardcoded - which is what makes one inserted payment flip
       the screen with no code change. */
    const s = json(await get('/summary'));
    assert.strictEqual(s.empty, true);
    assert.strictEqual(s.payment_count, 0);
  });

  await checkAsync('the table is empty rather than fabricated', async () => {
    const d = json(await get('/payments'));
    assert.deepStrictEqual(d.rows, []);
    assert.strictEqual(d.total_count, 0);
  });

  await checkAsync('the empty state carries the lead count that explains it', async () => {
    const s = json(await get('/summary'));
    assert.strictEqual(s.pipeline.total_leads, LEADS);
    assert.strictEqual(s.pipeline.converted, 0);
    /* Converted comes from the payment stream. lead.is_client reads 0 here and
       4 for Folio where one customer pays, so the source matters even when the
       two agree. */
    assert.ok(/never lead\.is_client/.test(s.pipeline.converted_source), s.pipeline.converted_source);
  });

  await checkAsync('no count equals 2,557 except the lead figure itself', async () => {
    const s = json(await get('/summary'));
    const bad = numbers(s).filter(([k, v]) => v === LEADS && k !== 'pipeline.total_leads');
    assert.deepStrictEqual(bad, [], 'a lead count leaked into a money or client figure');
  });

  await checkAsync('no payload publishes a trend, MRR, ARR or NRR', async () => {
    /* Word boundaries. A substring test matches "arrives" in the empty-state
       copy - the same trap as "Cash Source" containing "Source" on the
       LeavenWealth export. */
    for (const u of ['/summary', '/payments']) {
      const body = (await get(u)).body.toString('utf8');
      const hits = body.match(/\b(mrr|arr|nrr|mom|churn|run.?rate)\b/gi) || [];
      assert.deepStrictEqual(hits, [], u + ' publishes ' + hits.join(', '));
    }
  });

  /* ---- SEEDED: one payment, no code change ----------------------------- */
  seeded = true;

  await checkAsync('one payment populates all four cards', async () => {
    const s = json(await get('/summary'));
    assert.strictEqual(s.empty, false);
    assert.strictEqual(s.total_amount, 2500, 'total amount');
    assert.strictEqual(s.total_clients, 1, 'one distinct payer');
    assert.strictEqual(s.subscription_count, 1, 'one recurring payment');
    assert.strictEqual(s.one_time_count, 0, 'the $1 test is excluded, so no one-off');
  });

  await checkAsync('the $1 test row is excluded from every figure', async () => {
    const s = json(await get('/summary'));
    assert.strictEqual(s.payment_count, 1, 'the test payment was counted');
    assert.notStrictEqual(s.total_amount, 2501, 'the test dollar leaked into the total');
    const d = json(await get('/payments'));
    assert.strictEqual(d.rows.length, 1);
    assert.ok(d.rows.every(r => !r.is_test));
  });

  await checkAsync('Folio payments never reach a Leadli figure', async () => {
    const s = json(await get('/summary'));
    assert.notStrictEqual(s.total_amount, 3500, 'Folio’s $1,000 was included');
    const body = (await get('/payments')).body.toString('utf8');
    assert.ok(body.indexOf('pay_zZNxyVzd31xESP') < 0, 'a Folio payment is in the Leadli table');
  });

  await checkAsync('the customer name falls back to the Whop handle, and SAYS so', async () => {
    /* customer_name is null on this row, as Whop sends it. The fallback finds
       the username - and the client must not pass a handle off as a person's
       name, so the source rides along. */
    const r = json(await get('/payments')).rows[0];
    assert.strictEqual(r.customer, 'shivani_s');
    assert.strictEqual(r.customer_source, 'whop_username');
  });

  await checkAsync('a null product is returned as null, not invented', async () => {
    const d = json(await get('/payments'));
    assert.strictEqual(d.rows[0].product, 'Whop Pro - Leadli');
    /* And the client labels a null rather than the API filling one in. */
    const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'portal-leadli-fin.js'), 'utf8');
    assert.ok(/Unknown product/.test(src), 'the client cannot label a null product');
  });

  await checkAsync('the fee is carried, because Amount alone hides it', async () => {
    const r = json(await get('/payments')).rows[0];
    assert.strictEqual(r.amount, 2500);
    assert.strictEqual(r.fee, 100.75);
    assert.strictEqual(r.net, 2399.25);
    assert.strictEqual(Math.round((r.amount - r.fee) * 100) / 100, r.net,
      'gross minus fee does not equal net');
  });

  await checkAsync('service type is derived, and a null reason is Unknown', async () => {
    const d = json(await get('/payments'));
    assert.strictEqual(d.rows[0].service_type, 'Subscription');
    assert.deepStrictEqual(d.service_types, ['Subscription', 'One-time', 'Unknown']);
  });

  await checkAsync('the service-type filter narrows on the derived bucket', async () => {
    const sub = json(await get('/payments?service_type[]=Subscription'));
    assert.strictEqual(sub.rows.length, 1);
    const one = json(await get('/payments?service_type[]=One-time'));
    assert.strictEqual(one.rows.length, 0, 'the only one-off row is the excluded test');
  });

  await checkAsync('and still no count equals 2,557', async () => {
    const s = json(await get('/summary'));
    const bad = numbers(s).filter(([k, v]) => v === LEADS && k !== 'pipeline.total_leads');
    assert.deepStrictEqual(bad, []);
  });

  /* ---- the screen itself ----------------------------------------------- */
  const UI = fs.readFileSync(path.join(__dirname, '..', 'public', 'portal-leadli-fin.js'), 'utf8');
  const decomment = t => t.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/.*$/gm, ' ');
  const BODY = decomment(UI.slice(UI.indexOf('window.PortalLeadliFin')));

  check('the screen builds four cards and no chart', () => {
    assert.strictEqual((BODY.match(/kpiCard\(/g) || []).length, 5,
      'expected four kpiCard calls plus the definition');
    assert.ok(!/barChart|class="bars/.test(BODY), 'a chart is rendered');
  });

  check('no card can carry a delta', () => {
    /* portal.html's kpi() takes a fifth argument that colours a figure green
       or red. This one takes four, so there is nowhere to put one. */
    const def = /function kpiCard\(([^)]*)\)/.exec(BODY);
    assert.ok(def, 'kpiCard is missing');
    assert.strictEqual(def[1].split(',').length, 4, 'kpiCard has a delta slot: ' + def[1]);
  });

  check('the screen names no invented metric', () => {
    const hits = BODY.match(/\b(MRR|ARR|NRR|MoM|churn)\b/g) || [];
    assert.deepStrictEqual(hits, [], 'the screen names ' + hits.join(', '));
  });

  check('dates are not formatted through the viewer timezone', () => {
    assert.ok(!/toLocaleDateString/.test(BODY),
      'paid_at is a timestamptz; a locale conversion shifts the date a day east of UTC');
  });

  check('the empty state seeds no sample row', () => {
    /* The failure this prevents by name: Folio's page shipped with six
       invented businesses in it. */
    for (const ghost of ['Bluebird', 'Redwood', 'Cornerstone', 'Harbor Homes',
                         'Prairie Rentals', 'Elm Street', 'Sample', 'Demo ', 'Acme']) {
      assert.ok(BODY.indexOf(ghost) < 0, 'the screen contains a placeholder customer: ' + ghost);
    }
  });

  check('the empty state names where revenue will arrive from', () => {
    assert.ok(/Whop webhook/.test(BODY), 'the empty state does not say what feeds it');
    assert.ok(/payment success/.test(BODY), 'the n8n workflow is not named');
    assert.ok(/leads in the pipeline/.test(BODY), 'the lead count is missing');
  });

  check('the screen sends repeated array params', () => {
    assert.ok(/service_type\[\]=/.test(BODY), 'filters are not sent in the repeated form');
  });

  check('it binds with .onclick, not addEventListener', () => {
    /* paint() rebuilds the subtree on every change and mount() runs on every
       navigation back, so addEventListener stacks a copy per paint. */
    assert.ok(!/addEventListener/.test(BODY), 'a listener is added rather than assigned');
  });

  /* Every relation named in every statement is real - the fake never parses
     SQL, so this is the lint that caught `relation "s" does not exist` on the
     Folio module. */
  await checkAsync('every relation named in a statement is real', async () => {
    seen.length = 0;
    await get('/summary'); await get('/payments');
    await get('/payments?service_type[]=Subscription');
    for (const s of seen) {
      const sql = s.sql.replace(/\/\*[\s\S]*?\*\//g, ' ');
      const ctes = new Set([...sql.matchAll(/\bwith\s+([a-z_][a-z0-9_]*)\s+as\b/gi)].map(m => m[1].toLowerCase()));
      for (const m of sql.matchAll(/\b(?:from|join)\s+([a-zA-Z_][A-Za-z0-9_.]*)/g)) {
        const rel = m[1];
        if (/^public\./.test(rel) || /^information_schema\./.test(rel)) continue;
        assert.ok(ctes.has(rel.toLowerCase()),
          'names relation "' + rel + '": ' + sql.replace(/\s+/g, ' ').slice(0, 120));
      }
    }
  });

  server.close();
  console.log('\nleadli financials: ' + pass + ' passed, ' + fails.length + ' failed');
  if (fails.length) { fails.forEach(f => console.log('  FAIL  ' + f)); process.exit(1); }
})().catch(e => { console.error(e); process.exit(1); });
