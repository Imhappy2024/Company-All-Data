/* Folio Excel financials — the things that would make this screen lie.

   Built to FOLIO_FINANCIAL_DASHBOARD_SPEC §7. The live figures were verified
   against Supabase on 2026-09-07 and are Jay's to re-check; what this pins is
   everything that would still be wrong if those figures were right.

   The five that matter:

     1. THE TWO $1 CARD TESTS ARE OUT BY DEFAULT. With them in, one payment
        becomes three and $1,000 becomes $1,001 — and there is no is_test
        column, so the filter is a notes string plus an anonymised email.

     2. lead.is_client READS 4 AND IS WRONG THREE TIMES OVER. No count in any
        payload may equal 4, and no statement may read that column.

     3. MRR COMES FROM subscription_client, never from summing payments. And
        the monthly assumption behind it must reach the UI in words.

     4. UNITS, PLAN AND BILLING PERIOD ARE NULL. The values appear to sit in
        unlabelled GHL custom fields; 1600 and "Founding Customer" must never
        be rendered on that basis.

     5. THREE CARDS AND ONE TABLE, AND NO TREND INDICATOR ON EITHER. One
        customer and one month of history supports no MoM, no ARR, no NRR and
        no chart, and no funnel belongs on a financial page.

   Expectations are written from that stated intent, not derived from the code,
   so they can still fail. Where a check reads the SQL text rather than the
   payload it says so — the fake below stands in for Postgres, so a check that
   only inspects its output can pass while the real query is wrong.

   Run: node test/test-folio-financials.js
*/

const assert = require('assert');
const http = require('http');
const fs = require('fs');
const path = require('path');
const express = require('express');

const TENANT = '72381c81-af95-4e1d-ad0d-20a3a3421119';
const FOLIO_COMPANY = 'c0000000-0000-4000-8000-000000000002';
const FOLIO_ENTITY = '32bec21a-b52f-49db-93fb-fea5a594b480';
const MEMBERSHIP = 'mem_m1Z0CYCBZUtgxy';
const seen = [];

/* The three real payments as sales_payment holds them. Note what makes each
   one load-bearing:
     - the real one has a 40.37 fee, so gross != net
     - the succeeded test has usd_total 1.00, so a careless sum reads 1001
     - the FAILED test has usd_total AND amount_after_fees null, so anything
       coalescing to 0 reports it as a free sale
   Neither test carries an external_subscription_id, which is why the
   include_test toggle has to widen past the subscription join to find them. */
const PAYMENTS = [
  { id: 'p1', external_payment_id: 'pay_zZNxyVzd31xESP', external_subscription_id: MEMBERSHIP,
    customer_name: 'J & M Real Estate and Property Management Brandi',
    customer_email: 'brandi@jandmrealestate.com', product_name: 'Chris Pomerleau-Standard',
    billing_reason: 'subscription_create', status: 'paid', substatus: 'succeeded',
    currency: 'USD', total: '1000', usd_total: '1000', fee_amount: '40.37',
    amount_after_fees: '959.63', tax_amount: '0', refunded_amount: '0',
    paid_at: '2026-08-17T19:06:40.623Z', refunded_at: null,
    source_created_at: '2026-08-17T19:06:40.623Z',
    card: 'Visa 3471', receipt_number: 'ZZNXYVZD31XESP', failure_message: null,
    notes: 'First real Folio Excel subscriber.' },
  { id: 'p2', external_payment_id: 'pay_FgziDAhWNZgyMU', external_subscription_id: null,
    customer_name: 'Shivani Sharma', customer_email: '225faa5e0c7253c4@deleted.com',
    product_name: null, billing_reason: 'subscription_create',
    status: 'paid', substatus: 'succeeded', currency: 'USD',
    total: '1.00', usd_total: '1.00', fee_amount: '0.42', amount_after_fees: '0.58',
    tax_amount: '0.00', refunded_amount: '0.00', paid_at: '2026-06-04T16:23:52Z',
    refunded_at: null, source_created_at: '2026-06-04T16:23:52Z',
    card: null, receipt_number: 'FGZIDAHWNZGYMU', failure_message: null,
    notes: 'TEST TRANSACTION - $1 card test by Chris Pomerleau.' },
  { id: 'p3', external_payment_id: 'pay_cclK859htn24nk', external_subscription_id: null,
    customer_name: 'Shivani Sharma', customer_email: '225faa5e0c7253c4@deleted.com',
    product_name: null, billing_reason: 'subscription_create',
    status: 'open', substatus: 'failed', currency: 'USD',
    total: '1.00', usd_total: null, fee_amount: '0.00', amount_after_fees: null,
    tax_amount: '0.00', refunded_amount: '0.00', paid_at: null,
    refunded_at: null, source_created_at: '2026-06-04T16:20:00Z',
    card: null, receipt_number: 'CCLK859HTN24NK', failure_message: null,
    notes: 'TEST TRANSACTION - $1 card test by Chris Pomerleau. Declined.' },
];

/* The one subscriber. `company` is the GHL business name and is what the
   screen must show; the Whop billing-address version is on the payment above
   and must never appear as the business. */
const SUBSCRIBER = {
  id: 'a3b28821-67f7-4252-8e93-71a8293dcc69',
  company: 'J & M Property Management, Inc.',
  name: 'Brandi Jorgensen', email: 'brandi@jandmrealestate.com', phone: '+16056594269',
  number_of_units: null, subscription_plan_id: null, billing_period: null,
  subscription_amount: '1000.00', currency: 'USD',
  status: 'active', payment_status: 'paid', start_date: '2026-08-17',
  provider: 'whop', external_subscription_id: MEMBERSHIP,
  next_billing_date: null, cancelled_at: null,
  /* lead_id is a column ON subscription_client, which is why the table needs
     no join to `lead` for the business-name link. */
  lead_id: '1c3b0b94-2462-4e39-a4fb-a02bf42f491f',
  last_payment_at: '2026-08-17T19:06:40.623Z',
};

/* The fake's own reading of "is this a test row", written out here
   independently of the module's SQL — a fake that borrowed the module's
   definition could never disagree with it. */
const isTest = p => /TEST TRANSACTION/i.test(p.notes || '')
                 || /@deleted\.com$/.test(p.customer_email || '');

const num = v => (v === null || v === undefined ? 0 : Number(v));

const fakeDb = {
  enabled: true,
  getPool() { throw new Error('not needed'); },
  q(sql, params) {
    seen.push({ sql, params });

    /* MRR, from subscription_client and normalised by billing_period. */
    if (/case lower\(coalesce\(sc\.billing_period/.test(sql)) {
      const a = [SUBSCRIBER].filter(s => s.status === 'active' && !s.cancelled_at);
      return Promise.resolve({ rows: [{
        active_subscribers: a.length,
        mrr: a.reduce((t, s) => {
          const p = (s.billing_period || 'monthly').toLowerCase();
          const amt = num(s.subscription_amount);
          return t + (p === 'annual' || p === 'yearly' ? amt / 12
                    : p === 'quarterly' ? amt / 3 : amt);
        }, 0).toFixed(2),
        period_unknown: a.filter(s => s.billing_period === null).length,
        non_monthly: a.filter(s => s.billing_period !== null &&
                                   s.billing_period.toLowerCase() !== 'monthly').length,
        /* The plain sum, which is what the "total monthly subscription" card
           shows. Equal to mrr today and only different once a period says
           something other than monthly. */
        monthly_subscription: a.reduce((t, s) => t + num(s.subscription_amount), 0).toFixed(2),
        /* NULL, exactly as Postgres returns sum() over no non-null rows. This
           is the value the card must render as "Not set" rather than 0, so the
           fake has to produce the null rather than a convenient zero. */
        units_managed: a.some(s => s.number_of_units !== null)
          ? a.reduce((t, s) => t + num(s.number_of_units), 0) : null,
        units_known: a.filter(s => s.number_of_units !== null).length,
        currency: 'USD', currencies: 1,
      }] });
    }

    /* The ledger cross-check. */
    if (/from public\.transaction t/.test(sql)) {
      return Promise.resolve({ rows: [{ rows: 1, inflow: '1000.00', outflow: '0' }] });
    }

    /* Collected payments: revenue to date, the Whop cut, the net, and the
       month count that decides whether a trend exists at all. */
    if (/count\(\*\)::int as payments/.test(sql) && /sales_payment/.test(sql)) {
      const rows = PAYMENTS.filter(p => p.status === 'paid' && !isTest(p));
      const months = new Set(rows.map(p => String(p.paid_at).slice(0, 7)));
      return Promise.resolve({ rows: [{
        payments: rows.length,
        collected_usd: rows.reduce((t, p) => t + num(p.usd_total), 0).toFixed(2),
        fees_usd: rows.reduce((t, p) => t + num(p.fee_amount), 0).toFixed(2),
        net_usd: rows.reduce((t, p) => t + num(p.amount_after_fees), 0).toFixed(2),
        refunded_usd: '0.00',
        first_paid_at: rows.map(p => p.paid_at).sort()[0] || null,
        last_paid_at: rows.map(p => p.paid_at).sort().pop() || null,
        months: months.size,
      }] });
    }

    /* Filter option lists. */
    if (/array_agg\(distinct coalesce\(status/.test(sql)) {
      return Promise.resolve({ rows: [{
        status: ['active'], payment_status: ['paid'],
        billing_period: ['(not set)'], plan: ['(not set)'], provider: ['whop'],
      }] });
    }

    /* One subscriber by id, for the payment-history route. */
    if (/select sc\.id, sc\.company, sc\.provider/.test(sql)) {
      const wanted = params[params.length - 1];
      return Promise.resolve({ rows: wanted === SUBSCRIBER.id ? [Object.assign({}, SUBSCRIBER)] : [] });
    }

    /* The subscriber table. Honours only the filters the checks exercise; a
       value that matches nothing returns nothing, as Postgres would. */
    if (/from public\.subscription_client sc/.test(sql)) {
      let rows = [Object.assign({}, SUBSCRIBER)];
      const wants = (frag, field, fallback) => {
        if (!new RegExp(frag).test(sql)) return;
        const vals = params.filter(p => Array.isArray(p)).reduce((a, b) => a.concat(b), []);
        if (!vals.length) return;
        rows = rows.filter(r => vals.indexOf(r[field] === null ? fallback : r[field]) >= 0);
      };
      wants('coalesce\\(sc\\.status', 'status', '(not set)');
      wants('coalesce\\(sc\\.billing_period', 'billing_period', '(not set)');
      return Promise.resolve({ rows });
    }

    /* The payment stream. */
    if (/from public\.sales_payment sp/.test(sql)) {
      const excludeTest = /not \(sp\.notes ilike/.test(sql);
      const widened = /sp\.external_subscription_id is null and \(sp\.notes ilike/.test(sql);
      const subId = params.filter(p => typeof p === 'string' && p.indexOf('mem_') === 0)[0];
      let rows = PAYMENTS.slice();
      if (subId) {
        rows = rows.filter(p => p.external_subscription_id === subId ||
          (widened && p.external_subscription_id === null && isTest(p)));
      }
      if (excludeTest) rows = rows.filter(p => !isTest(p));
      return Promise.resolve({ rows: rows.map(p => Object.assign({}, p, {
        is_test: isTest(p),
        one_off: ['one_time', 'manual'].indexOf(p.billing_reason) >= 0,
      })) });
    }

    return Promise.resolve({ rows: [] });
  },
};

require.cache[require.resolve('../supabase-db')] =
  { id: 'fake', filename: 'fake', loaded: true, exports: fakeDb };
const folio = require('../folio-financials-api');

let pass = 0;
const fails = [];
function check(n, fn) { try { fn(); pass++; } catch (e) { fails.push(n + ' -> ' + e.message); } }
async function checkAsync(n, fn) { try { await fn(); pass++; } catch (e) { fails.push(n + ' -> ' + e.message); } }

const BASE = '/api/folio/financials';
function serve() {
  const app = express();
  app.use(BASE, folio.folioFinancialsRoutes());
  return new Promise(r => { const s = app.listen(0, () => r(s)); });
}
function req(server, method, url) {
  return new Promise((resolve, reject) => {
    const r = http.request({ port: server.address().port, path: url, method }, res => {
      const c = []; res.on('data', x => c.push(x));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(c),
                                    headers: res.headers }));
    });
    r.on('error', reject); r.end();
  });
}
const json = r => JSON.parse(r.body.toString('utf8'));

/* Every number in a payload with its key path, so a check can ask "does any
   count in here equal 4" without knowing the shape. */
function numbers(o, at, out) {
  out = out || []; at = at || '';
  if (o === null || o === undefined) return out;
  if (typeof o === 'number') { out.push([at, o]); return out; }
  if (Array.isArray(o)) { o.forEach((v, i) => numbers(v, at + '[' + i + ']', out)); return out; }
  if (typeof o === 'object') { Object.keys(o).forEach(k => numbers(o[k], at ? at + '.' + k : k, out)); }
  return out;
}
function strings(o, out) {
  out = out || [];
  if (typeof o === 'string') { out.push(o); return out; }
  if (o && typeof o === 'object') Object.keys(o).forEach(k => strings(o[k], out));
  return out;
}

(async () => {
  const server = await serve();
  const get = u => req(server, 'GET', BASE + u);
  const PAY_URL = '/subscribers/' + SUBSCRIBER.id + '/payments';

  /* ---- read-only ------------------------------------------------------- */
  for (const m of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    await checkAsync('refuses ' + m, async () => {
      assert.strictEqual((await req(server, m, BASE + '/summary')).status, 405);
    });
  }
  await checkAsync('no statement contains a write verb', async () => {
    seen.length = 0;
    await get('/summary'); await get('/subscribers'); await get('/funnel'); await get(PAY_URL);
    const bad = seen.filter(s => /\b(insert|update|delete|truncate|drop|alter|create|grant|revoke)\b/i.test(s.sql));
    assert.strictEqual(bad.length, 0, bad[0] && bad[0].sql.slice(0, 120));
  });

  /* ---- every relation named actually exists ----------------------------
     THE FAKE ABOVE NEVER PARSES SQL, so a statement Postgres refuses passes
     every other check in this file. That is exactly how
     `relation "s" does not exist` reached production: the options query was
     five scalar subqueries in the select list, each `(select … from s)` over a
     subquery aliased `s` in the FROM — which is not legal, because a
     sub-select in the target list cannot reference a sibling FROM item as a
     relation. The screen showed nothing but the error.

     This lints what the fake cannot: every name used as a relation is either
     `public.<table>` or a CTE declared in the same statement. It is narrow on
     purpose - it catches referencing an alias as a table, and it would have
     caught that bug. It is NOT a substitute for running the SQL, which is
     what tools/check-folio-sql.js does. */
  await checkAsync('every relation named in a statement is real', async () => {
    seen.length = 0;
    await get('/summary');
    await get('/subscribers');
    await get('/subscribers?status[]=active&from=2026-08-01&to=2026-08-31');
    await get(PAY_URL); await get(PAY_URL + '?include_test=true');
    await get('/payments?include_test=true');
    await get('/export?view=subscribers'); await get('/export?view=payments');
    assert.ok(seen.length, 'statements ran');

    for (const s of seen) {
      const sql = s.sql.replace(/\/\*[\s\S]*?\*\//g, ' ');
      const ctes = new Set([...sql.matchAll(/\bwith\s+([a-z_][a-z0-9_]*)\s+as\b/gi)].map(m => m[1].toLowerCase()));
      [...sql.matchAll(/,\s*([a-z_][a-z0-9_]*)\s+as\s*\(/gi)].forEach(m => ctes.add(m[1].toLowerCase()));
      for (const m of sql.matchAll(/\b(?:from|join)\s+([a-zA-Z_][A-Za-z0-9_.]*)/g)) {
        const rel = m[1];
        if (/^public\./.test(rel)) continue;
        assert.ok(ctes.has(rel.toLowerCase()),
          'statement names relation "' + rel + '" which is neither public.<table> nor a CTE: ' +
          sql.replace(/\s+/g, ' ').slice(0, 130));
      }
    }
  });

  /* ---- scoping --------------------------------------------------------- */
  await checkAsync('every statement is tenant-scoped and Folio-scoped', async () => {
    seen.length = 0;
    await get('/summary'); await get('/subscribers'); await get('/funnel'); await get(PAY_URL);
    assert.ok(seen.length, 'statements ran');
    for (const s of seen) {
      assert.ok(s.params.indexOf(TENANT) >= 0, 'not tenant-scoped: ' + s.sql.slice(0, 90));
      assert.ok(s.params.indexOf(FOLIO_COMPANY) >= 0 || s.params.indexOf(FOLIO_ENTITY) >= 0,
        'not Folio-scoped: ' + s.sql.slice(0, 90));
    }
  });

  /* transaction has NO company_id. Filtering on one is a 42703 at runtime,
     which is a 500 on a screen rather than a caught mistake. */
  await checkAsync('the ledger is scoped by entity_id, never transaction.company_id', async () => {
    seen.length = 0;
    await get('/summary');
    const t = seen.filter(s => /public\.transaction/.test(s.sql))[0];
    assert.ok(t, 'the ledger statement ran');
    assert.ok(!/company_id/.test(t.sql), 'the ledger query references company_id');
    assert.ok(/t\.entity_id = \$2/.test(t.sql), 'the ledger is not scoped by entity_id');
  });

  await checkAsync('subscribers scope through business_entity_id, not company_id', async () => {
    seen.length = 0;
    await get('/subscribers');
    const s = seen.filter(x => /subscription_client/.test(x.sql))[0];
    assert.ok(/sc\.business_entity_id = \$2/.test(s.sql), 'the entity scope is missing');
    assert.ok(!/sc\.company_id/.test(s.sql), 'subscription_client has no company_id column');
  });

  /* lead.custom_fields is MIXED TYPE — 4,642 Folio rows hold an array and 3
     hold an object. jsonb_array_length on the object rows throws, and it
     throws for the whole query, not just that row. */
  /* Written as "never read UNGUARDED" rather than "read, and guarded": the
     table no longer joins `lead` at all, so there is nothing to guard today.
     Stated the other way round the check would have to be deleted now and
     rewritten from scratch the day someone reads the column again - which is
     exactly the day it matters. */
  await checkAsync('custom_fields is never read without a jsonb_typeof guard', async () => {
    seen.length = 0;
    await get('/subscribers'); await get('/summary'); await get(PAY_URL);
    for (const s of seen.filter(x => /custom_fields/.test(x.sql))) {
      assert.ok(/jsonb_typeof\([a-z]*\.?custom_fields\) = 'array'/.test(s.sql),
        'custom_fields is read unguarded: ' + s.sql.slice(0, 120));
    }
  });

  /* ---- the subscriber table (spec §7) ---------------------------------- */
  await checkAsync('returns exactly one subscriber, with the verified values', async () => {
    const d = json(await get('/subscribers'));
    assert.strictEqual(d.rows.length, 1);
    const r = d.rows[0];
    assert.strictEqual(r.amount, 1000);
    assert.strictEqual(r.currency, 'USD');
    assert.strictEqual(r.status, 'active');
    assert.strictEqual(r.payment_status, 'paid');
    assert.strictEqual(r.start_date, '2026-08-17');
  });

  await checkAsync('the business is the GHL name, NOT the Whop billing name', async () => {
    const d = json(await get('/subscribers'));
    assert.strictEqual(d.rows[0].business, 'J & M Property Management, Inc.');
    assert.ok(!/J & M Real Estate and Property Management Brandi/.test(strings(d).join(' | ')),
      'the Whop billing-address name reached the subscriber payload');
  });

  await checkAsync('units, plan and billing period are null AND flagged not-set', async () => {
    const r = json(await get('/subscribers')).rows[0];
    assert.strictEqual(r.units, null);
    assert.strictEqual(r.plan, null);
    assert.strictEqual(r.billing_period, null);
    assert.deepStrictEqual(r.not_set.slice().sort(), ['billing_period', 'plan', 'units']);
    assert.ok(/GHL|field mapping/i.test(r.not_set_reason || ''), 'no reason given');
  });

  /* The values inferred from the unlabelled GHL fields. If either ever appears
     in a payload, someone decided a guess was good enough. */
  await checkAsync('no inferred GHL value is emitted (1600, Founding Customer)', async () => {
    const d = json(await get('/subscribers'));
    assert.ok(numbers(d).every(([, v]) => v !== 1600), '1600 was emitted as a real value');
    assert.ok(!/Founding Customer/i.test(strings(d).join(' ')), 'the inferred plan name was emitted');
  });

  /* ---- MRR ------------------------------------------------------------- */
  await checkAsync('MRR is 1000 and carries its assumption in words', async () => {
    const s = json(await get('/summary'));
    assert.strictEqual(s.active_subscribers, 1);
    assert.strictEqual(s.mrr, 1000);
    assert.strictEqual(s.mrr_assumed, true);
    assert.ok(/assumed monthly/i.test(s.mrr_assumption), s.mrr_assumption);
    assert.ok(/billing_period/.test(s.mrr_assumption), 'the reason is not named');
  });

  await checkAsync('MRR is derived from subscription_client, never from payments', async () => {
    seen.length = 0;
    await get('/summary');
    const m = seen.filter(s => /case lower\(coalesce\(sc\.billing_period/.test(s.sql))[0];
    assert.ok(m, 'the MRR statement ran');
    assert.ok(/subscription_client/.test(m.sql), 'MRR does not read subscription_client');
    assert.ok(!/sales_payment/.test(m.sql), 'the MRR statement reads sales_payment');
  });

  await checkAsync('no summary field carries a summed-payment-stream figure', async () => {
    /* 1001 is what summing all three payments gives, and it is plausible
       enough to go unquestioned. */
    const s = json(await get('/summary'));
    assert.deepStrictEqual(numbers(s).filter(([, v]) => v === 1001 || v === 2002), []);
  });

  /* ---- test payments --------------------------------------------------- */
  await checkAsync('payment history shows ONE payment by default', async () => {
    const d = json(await get(PAY_URL));
    assert.strictEqual(d.rows.length, 1);
    const p = d.rows[0];
    assert.strictEqual(p.payment_id, 'pay_zZNxyVzd31xESP');
    assert.strictEqual(p.gross, 1000);
    assert.strictEqual(p.fee, 40.37);
    assert.strictEqual(p.net, 959.63);
    assert.ok(String(p.paid_at).indexOf('2026-08-17') === 0, p.paid_at);
    assert.strictEqual(d.totals.gross, 1000);
    assert.strictEqual(d.totals.net, 959.63);
  });

  await checkAsync('include_test adds exactly the two $1 rows and nothing else', async () => {
    const d = json(await get(PAY_URL + '?include_test=true'));
    assert.strictEqual(d.rows.length, 3);
    const ones = d.rows.filter(p => p.charged === 1);
    assert.strictEqual(ones.length, 2, 'the two $1 tests');
    assert.ok(ones.every(p => p.is_test), 'both are flagged as tests');
  });

  await checkAsync('the default excludes tests in the SQL, not in the client', async () => {
    seen.length = 0;
    await get(PAY_URL);
    const p = seen.filter(s => /from public\.sales_payment/.test(s.sql)).pop();
    assert.ok(/not \(sp\.notes ilike/.test(p.sql), 'the test filter is not in the statement');
    assert.ok(/@deleted\.com/.test(p.sql), 'the structural half of the filter is missing');
  });

  await checkAsync('collected totals exclude the test dollar', async () => {
    const s = json(await get('/summary'));
    assert.strictEqual(s.history.payments, 1);
    assert.strictEqual(s.history.collected_usd, 1000);
  });

  await checkAsync('a failed payment is listed, and never reads as $0 collected', async () => {
    const d = json(await get('/payments?include_test=true'));
    const failed = d.rows.filter(p => p.payment_id === 'pay_cclK859htn24nk')[0];
    assert.ok(failed, 'the failed payment is in the list');
    assert.strictEqual(failed.failed, true);
    assert.strictEqual(failed.gross, null, 'a failed payment must not report a gross');
    assert.strictEqual(failed.charged, 1, 'the attempted amount is still shown');
    /* With tests included the two SUCCEEDED payments total; the failed one
       contributes nothing at all rather than a zero. */
    assert.strictEqual(d.totals.payments, 2, 'the failed payment was totalled');
    assert.strictEqual(d.totals.gross, 1001, 'gross with the tests in');
    const off = json(await get('/payments'));
    assert.strictEqual(off.totals.payments, 1, 'the default totals one payment');
    assert.strictEqual(off.totals.gross, 1000, 'the default gross is 1000, not 1001');
  });

  /* ---- lead.is_client -------------------------------------------------- */
  await checkAsync('no count in any payload equals 4', async () => {
    const urls = ['/summary', '/subscribers', PAY_URL];
    const COUNTISH = /(count|subscribers|payments|leads|paying|rows|staged)/i;
    for (const u of urls) {
      const bad = numbers(json(await get(u))).filter(([k, v]) => v === 4 && COUNTISH.test(k));
      assert.deepStrictEqual(bad, [], u + ' has a count of 4, which is lead.is_client');
    }
  });

  await checkAsync('no statement reads is_client', async () => {
    seen.length = 0;
    await get('/summary'); await get('/subscribers'); await get('/funnel');
    const bad = seen.filter(s => /is_client/.test(s.sql));
    assert.strictEqual(bad.length, 0, bad[0] && bad[0].sql.slice(0, 90));
  });

  /* ---- the funnel is GONE ----------------------------------------------
     Pipeline stages and lead counts are CRM data and belong on the Leads
     page, by instruction. The route went with the panel: an endpoint nothing
     calls is the kind of thing somebody later wires a screen into without
     noticing nothing linked to it. */
  await checkAsync('the funnel endpoint no longer exists', async () => {
    assert.strictEqual((await get('/funnel')).status, 404);
  });

  await checkAsync('no payload carries a pipeline stage or a lead count', async () => {
    for (const u of ['/summary', '/subscribers', PAY_URL]) {
      const body = (await get(u)).body.toString('utf8');
      assert.ok(!/pipeline|Closed Won|Demo Complete|Qualified|staged/i.test(body),
        u + ' carries CRM pipeline data');
      assert.ok(!/4,?645|4,?637/.test(body), u + ' carries a lead count');
    }
  });

  await checkAsync('no statement reads the lead pipeline', async () => {
    seen.length = 0;
    await get('/summary'); await get('/subscribers');
    const bad = seen.filter(s => /pipeline_stage/.test(s.sql));
    assert.strictEqual(bad.length, 0, bad[0] && bad[0].sql.slice(0, 90));
  });

  /* ---- no tiles, no trend ---------------------------------------------- */
  await checkAsync('the summary states that no trend is available', async () => {
    const s = json(await get('/summary'));
    assert.strictEqual(s.history.trend_available, false);
    assert.ok(/no trend/i.test(s.history.trend_note), s.history.trend_note);
    assert.deepStrictEqual(numbers(s).filter(([k]) => /mom|change|delta|growth|prev/i.test(k)), [],
      'a period-over-period field is published');
  });

  /* ---- the three cards (spec §1 and §6) -------------------------------- */
  await checkAsync('the cards read $1,000.00, 1, and Not set', async () => {
    const s = json(await get('/summary'));
    assert.strictEqual(s.monthly_subscription, 1000, 'total monthly subscription');
    assert.strictEqual(s.active_subscribers, 1, 'total app users');
    /* NULL, not 0. The card renders "Not set" off exactly this, and a 0 here
       would claim the business manages no units. */
    assert.strictEqual(s.units_managed, null, 'total units managed must be null, not 0');
    assert.strictEqual(s.units_known, 0, 'no subscriber reports a unit count');
  });

  await checkAsync('the monthly total is the plain sum, and says when that is an assumption', async () => {
    const s = json(await get('/summary'));
    assert.strictEqual(s.period_unknown, 1, 'billing_period is unset on the one subscriber');
    assert.strictEqual(s.non_monthly, 0, 'nothing is billed on a non-monthly period');
    /* Equal today, and they must be: with billing_period NULL the plain sum
       and the assumed-monthly normalisation are the same figure. They diverge
       only once a period is recorded, which is what non_monthly is for. */
    assert.strictEqual(s.monthly_subscription, s.mrr);
  });

  /* ---- Reports & Financials -------------------------------------------
     Revenue, the Whop fee and the net are no longer cards - they are in the
     payment expand - but the summary still carries them and they still have
     to exclude the test rows. */
  await checkAsync('the summary carries revenue, the Whop fee and the net', async () => {
    const s = json(await get('/summary'));
    assert.strictEqual(s.history.collected_usd, 1000, 'revenue to date');
    assert.strictEqual(s.history.fees_usd, 40.37, 'Whop fees to date');
    assert.strictEqual(s.history.net_usd, 959.63, 'net');
    /* Gross minus fee must equal net, or one of the three is from a different
       row set than the others. */
    assert.strictEqual(Math.round((s.history.collected_usd - s.history.fees_usd) * 100) / 100,
      s.history.net_usd, 'the three figures do not reconcile');
  });

  await checkAsync('the fee and net exclude the test payments too', async () => {
    /* The tests carry a 0.42 fee and 0.58 net. If either leaks, the fee reads
       40.79 and the net 960.21 - which is what the first version of this
       screen showed. */
    const s = json(await get('/summary'));
    assert.notStrictEqual(s.history.fees_usd, 40.79, 'the test fee leaked into fees to date');
    assert.notStrictEqual(s.history.net_usd, 960.21, 'the test net leaked into net');
  });

  await checkAsync('the first payment date is 2026-08-17 and the month count is counted', async () => {
    const s = json(await get('/summary'));
    assert.ok(String(s.history.first_paid_at).indexOf('2026-08-17') === 0, s.history.first_paid_at);
    assert.strictEqual(s.history.months, 1);
    assert.strictEqual(s.history.trend_available, false);
    /* Counted, not hardcoded: the note has to name the month count so it stops
       saying "one month" the moment there are two. */
    assert.ok(/one month/i.test(s.history.trend_note), s.history.trend_note);
  });

  /* Read from the front-end SOURCE, because "no tiles" is a property of the
     screen and no API response can enforce it. */
  const UI = fs.readFileSync(path.join(__dirname, '..', 'public', 'portal-folio-fin.js'), 'utf8');
  /* Comments are stripped, or these checks read the prose that explains why a
     thing is absent and conclude it is present. The module documents why it
     shows no ARR and why it does not call toLocaleDateString; both sentences
     name the thing they rule out. */
  const decomment = t => t.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/.*$/gm, ' ');
  const BODY = decomment(UI.slice(UI.indexOf('window.PortalFolioFin')));

  /* Three cards are now WANTED - what is forbidden is a trend indicator on
     them. So this checks the shape rather than the absence of cards: the
     portal's own kpi() markup, no chart, and nothing passed into the delta
     slot that colours a figure green or red. */
  check('the reports view builds cards in the portal own markup', () => {
    assert.ok(/class="kpis"/.test(BODY), 'the card row is missing');
    assert.ok(/class="kpi"/.test(BODY), 'the cards are not the portal component');
    assert.ok(/mountReports/.test(BODY), 'the reports view is missing');
  });

  check('no card carries a chart, an arrow or a delta class', () => {
    assert.ok(!/class="bars/.test(BODY), 'a bar chart is rendered');
    assert.ok(!/barChart/.test(BODY), 'a bar chart is built');
    /* kpi()'s fifth argument is the class that colours a delta up or down.
       kpiCard() here takes four and has no such slot at all. */
    assert.ok(!/'up'|"up"|'down'|"down"/.test(BODY), 'a delta direction is passed');
    assert.ok(!/&#8593;|&#8595;|&uarr;|&darr;|▲|▼/.test(BODY.replace(/fin-caret[\s\S]{0,120}/g, '')),
      'an arrow glyph is rendered outside the sort caret');
  });

  check('exactly three cards are built', () => {
    const inCards = BODY.slice(BODY.indexOf('function cards('), BODY.indexOf('function subscriberCard('));
    const n = (inCards.match(/kpiCard\(/g) || []).length;
    /* Two literal calls plus the units card, which is built in a branch
       because NULL and a real total say different things. */
    assert.strictEqual(n, 4, 'expected three cards (the units one has two branches), saw ' + n);
    assert.ok(/Total monthly subscription/.test(inCards), 'card 1 is missing');
    assert.ok(/Total app users/.test(inCards), 'card 2 is missing');
    assert.ok(/Total units managed/.test(inCards), 'card 3 is missing');
  });

  check('the units card says Not set, never 0 and never 1600', () => {
    const inCards = BODY.slice(BODY.indexOf('function cards('), BODY.indexOf('function subscriberCard('));
    assert.ok(/'Not set'/.test(inCards), 'the units card cannot say Not set');
    assert.ok(!/1600/.test(inCards), '1600 is rendered');
    /* The FIGURE must never be coalesced. `units_known || 0` is fine and is
       how the card decides which branch to take - a count of rows with a value
       genuinely is zero. Coalescing `units_managed` is the bug: it would turn
       "nobody has recorded this" into "they manage none". */
    assert.ok(!/units_managed\s*\|\|/.test(inCards), 'the units total falls back to a number');
    assert.ok(!/Number\(s\.units_managed\s*\|\|/.test(inCards), 'the units total is coalesced');
  });

  check('the table is the five spec columns, sortable, amount-first', () => {
    const cols = /var SORTS = \[([\s\S]*?)\];/.exec(BODY);
    assert.ok(cols, 'the column list is missing');
    for (const c of ['business', 'units', 'amount', 'status', 'payment_status']) {
      assert.ok(cols[1].indexOf("'" + c + "'") >= 0, 'column missing: ' + c);
    }
    assert.strictEqual((cols[1].match(/key:/g) || []).length, 5, 'expected exactly five columns');
    assert.ok(/sort: 'amount', dir: 'desc'/.test(BODY), 'the default sort is not amount desc');
    assert.ok(/data-sort=/.test(BODY), 'the columns are not sortable');
  });

  check('status and payment status render as portal badges', () => {
    assert.ok(/class="pill /.test(BODY), 'badges are not the portal .pill component');
    /* App Users' own colours: active is good, a trial is neutral, anything
       else needs looking at. Plain substring checks - a regex here would need
       escaping around the ternary and would trip over its own punctuation. */
    var wanted = ["'active' ? 'green'", "'paid' ? 'green'",
                  "'due' ? 'amber'", "'overdue' ? 'rose'"];
    for (var wi = 0; wi < wanted.length; wi++) {
      assert.ok(BODY.indexOf(wanted[wi]) >= 0, 'badge colour missing: ' + wanted[wi]);
    }
    /* A state nobody has defined falls through to grey rather than to a
       colour that would assert something about it. */
    assert.ok(/: 'gray'/.test(BODY), 'no neutral fallback for an unknown state');
  });

  check('the reports view publishes no ARR and no retention figure', () => {
    /* ARR would be MRR x 12 off a billing period nobody has confirmed, and
       NRR needs a prior period to retain. Neither is computable. */
    assert.ok(!/\bARR\b/.test(BODY), 'an ARR figure is rendered');
    assert.ok(!/\bNRR\b|retention/i.test(BODY), 'a retention figure is rendered');
    assert.ok(!/\* 12|\*12|\/ 12|\/12/.test(BODY), 'a figure is annualised in the client');
  });

  /* A payment's date is a business fact, not an instant to be converted into
     the reader's timezone. paid_at is 2026-08-17T19:06:40Z, so
     toLocaleDateString renders "18 Aug 2026" anywhere east of UTC. */
  check('dates are formatted from the ISO string, not the viewer timezone', () => {
    assert.ok(!/toLocaleDateString/.test(BODY),
      'a date is formatted through the viewer timezone');
  });

  /* And the same rule at the source: portal.html must not still hold the
     invented figures behind the old page. */
  const PORTAL = decomment(fs.readFileSync(path.join(__dirname, '..', 'public', 'portal.html'), 'utf8'));
  check('portal.html no longer computes Folio reports from a baked array', () => {
    assert.ok(/reports\(\)\{return '<div id="folioReportsNative"><\/div>';\},/.test(PORTAL),
      'V.reports() does not render the live container');
    /* The three specific fabrications that were on that page. */
    assert.ok(!/'ARR'/.test(PORTAL), 'the ARR tile is still there');
    assert.ok(!/Net revenue retention/i.test(PORTAL), 'the NRR tile is still there');
    assert.ok(!/\['Apr',2600/.test(PORTAL), 'the invented MRR trend is still there');
    assert.ok(!/\+8% MoM/.test(PORTAL), 'a MoM figure is still there');
  });
  check('the screen builds no tiles', () => {
    assert.ok(!/class="fin-tiles/.test(BODY), 'a tile grid is rendered');
    assert.ok(!/class="fin-tile/.test(BODY), 'a tile is rendered');
  });
  check('the screen shows no MoM or percentage change', () => {
    assert.ok(!/MoM/.test(BODY), 'a MoM label is rendered');
    assert.ok(!/%\s*(MoM|change)/i.test(BODY), 'a change figure is rendered');
  });
  check('the screen asks for the spec route', () => {
    assert.ok(/var API = '\/api\/folio\/financials'/.test(UI), 'the API base is wrong');
  });
  check('the screen sends repeated array params, not a comma list', () => {
    assert.ok(/\[\]=' \+ encodeURIComponent/.test(BODY), 'filters are not sent in the repeated form');
  });

  /* ---- ledger ---------------------------------------------------------- */
  await checkAsync('the ledger reconciles with collected payments', async () => {
    const s = json(await get('/summary'));
    assert.strictEqual(s.ledger.rows, 1);
    assert.strictEqual(s.ledger.inflow, 1000);
    assert.strictEqual(s.ledger.reconciles, true);
    assert.strictEqual(s.ledger.inflow, s.history.collected_usd);
  });

  /* ---- filters --------------------------------------------------------- */
  await checkAsync('an empty selection filters nothing and emits no IN ()', async () => {
    seen.length = 0;
    const d = json(await get('/subscribers'));
    assert.strictEqual(d.rows.length, 1);
    for (const s of seen) assert.ok(!/in\s*\(\s*\)/i.test(s.sql), 'an empty IN () was emitted');
  });

  await checkAsync('the null billing period is selectable as (not set)', async () => {
    /* A value nobody can select is a row nobody can find, and this row's
       billing_period is exactly the null in question. */
    const d = json(await get('/subscribers?billing_period[]=' + encodeURIComponent('(not set)')));
    assert.strictEqual(d.rows.length, 1, 'the subscriber is unreachable from its own filter');
    assert.ok((d.options.billing_period || []).indexOf('(not set)') >= 0,
      '(not set) is not offered as an option');
  });

  await checkAsync('a selection that matches nothing returns nothing, not everything', async () => {
    assert.strictEqual(json(await get('/subscribers?status[]=cancelled')).rows.length, 0);
  });

  await checkAsync('two selections union rather than intersect', async () => {
    const d = json(await get('/subscribers?status[]=active&status[]=cancelled'));
    assert.strictEqual(d.rows.length, 1, 'a union of two statuses lost the row');
  });

  await checkAsync('a backwards date range is swapped, not answered as empty', async () => {
    const d = json(await get('/subscribers?from=2026-12-31&to=2026-01-01'));
    assert.strictEqual(d.filters.from, '2026-01-01');
    assert.strictEqual(d.filters.to, '2026-12-31');
  });

  await checkAsync('a date range on a subscriber list says what it means', async () => {
    const d = json(await get('/subscribers?from=2026-08-01&to=2026-08-31'));
    assert.ok(/paid_at/.test(d.date_scope || ''), 'the date scope is not explained');
  });

  await checkAsync('a malformed date is ignored rather than half-applied', async () => {
    const d = json(await get('/subscribers?from=august'));
    assert.strictEqual(d.filters.from, null);
    assert.strictEqual(d.rows.length, 1);
  });

  /* ---- export ---------------------------------------------------------- */
  const csvOf = r => r.body.toString('utf8');
  await checkAsync('the subscriber export carries provenance and the test-payment line', async () => {
    const csv = csvOf(await get('/export?view=subscribers'));
    assert.ok(/^# Folio Excel financial export/m.test(csv), 'no provenance block');
    assert.ok(/^# Generated:/m.test(csv), 'no generated line');
    assert.ok(/^# Test payments: excluded/m.test(csv), 'the test-payment state is not stated');
    assert.ok(/no is_test column/.test(csv), 'the filter is not declared provisional');
    assert.ok(/billing_period is not set/.test(csv), 'the monthly assumption is not stated');
    assert.ok(/^# Rows: 1/m.test(csv), 'no row count');
  });

  await checkAsync('the export names the file and does not render it inline', async () => {
    const r = await get('/export?view=payments');
    assert.ok(/attachment; filename="folio-payments-/.test(r.headers['content-disposition'] || ''),
      r.headers['content-disposition']);
  });

  await checkAsync('a business name with a comma and an ampersand survives the CSV', async () => {
    const csv = csvOf(await get('/export?view=subscribers'));
    assert.ok(csv.indexOf('"J & M Property Management, Inc."') >= 0,
      'the name was not quoted, so the comma split it into two columns');
  });

  await checkAsync('the export is the filtered set, and the toggle reaches it', async () => {
    const off = csvOf(await get('/export?view=payments'));
    const on = csvOf(await get('/export?view=payments&include_test=true'));
    assert.ok(/^# Rows: 1/m.test(off), 'the default export is not one row');
    assert.ok(/^# Rows: 3/m.test(on), 'include_test did not reach the export');
    assert.ok(/^# Test payments: INCLUDED/m.test(on), 'the file does not say tests are in it');
    assert.ok(off.indexOf('pay_FgziDAhWNZgyMU') < 0, 'a test payment is in the default export');
  });

  await checkAsync('money exports as a bare number, and an absent value as empty', async () => {
    const csv = csvOf(await get('/export?view=payments&include_test=true'));
    const failed = csv.split('\n').filter(l => l.indexOf('pay_cclK859htn24nk') >= 0)[0];
    assert.ok(failed, 'the failed payment is in the file');
    /* Data rows only. The provenance block above the header says "two $1 card
       tests are in this file", and that dollar sign is prose, not a figure. */
    const data = csv.split('\n').filter(l => l && l[0] !== '#').join('\n');
    assert.ok(!/\$/.test(data), 'a currency symbol reached a data row');
    assert.ok(!/\(1,000\.00\)/.test(data), 'a formatted figure reached a data row');
    /* Gross is the 5th column and must be EMPTY for the failed payment rather
       than 0 — a spreadsheet SUM must not count it as a free sale. */
    assert.strictEqual(failed.split(',')[4], '', 'a null gross exported as something');
  });

  await checkAsync('no export column carries a credential or an unlabelled payload', async () => {
    for (const v of ['subscribers', 'payments']) {
      const csv = csvOf(await get('/export?view=' + v));
      for (const bad of folio.NEVER_EXPOSE) {
        assert.ok(csv.indexOf(bad) < 0, bad + ' reached the ' + v + ' export');
      }
      assert.ok(!/risk_score|billing_address|card_last4/.test(csv), 'raw Whop detail reached ' + v);
    }
  });

  await checkAsync('the export column sets match the spec', async () => {
    const subs = csvOf(await get('/export?view=subscribers')).split('\n').filter(l => l && l[0] !== '#')[0];
    for (const h of ['Business', 'Contact', 'Email', 'Units', 'Plan', 'Amount', 'Currency',
                     'Billing Period', 'Status', 'Payment Status', 'Start Date',
                     'Last Payment', 'Provider', 'Subscription ID']) {
      assert.ok(subs.indexOf(h) >= 0, 'subscribers export is missing ' + h);
    }
    const pay = csvOf(await get('/export?view=payments')).split('\n').filter(l => l && l[0] !== '#')[0];
    for (const h of ['Payment ID', 'Receipt Number', 'Paid At', 'Billing Reason', 'Gross',
                     'Fee', 'Net', 'Currency', 'Status', 'Substatus', 'Refunded Amount', 'Card']) {
      assert.ok(pay.indexOf(h) >= 0, 'payments export is missing ' + h);
    }
  });

  /* ---- 404s ------------------------------------------------------------ */
  await checkAsync('an id that is not a Folio subscriber is a 404, not an empty list', async () => {
    const r = await get('/subscribers/a3b28821-0000-0000-0000-000000000000/payments');
    assert.strictEqual(r.status, 404);
  });

  server.close();
  console.log('\nfolio financials: ' + pass + ' passed, ' + fails.length + ' failed');
  if (fails.length) { fails.forEach(f => console.log('  FAIL  ' + f)); process.exit(1); }
})().catch(e => { console.error(e); process.exit(1); });
