/* Folio Excel financials — the two things that would make this screen lie.

   The live figures (gross $1,001.00, net $960.21, fees $40.79, 1 outstanding
   payment of $1.00, 2 customers, 1 active subscription) were verified against
   Supabase on 2026-09-07 and are Jay's to re-check.

   What this pins is what would still be wrong if those figures were right:

     1. sales_payment and whop_payment hold the SAME three payments. Summing
        both reports $2,002 against a real $1,001 and looks entirely plausible.
        No aggregate may read whop_payment at all.

     2. There is no MRR. billing_period is null on the only subscription, so
        $1,000 is either monthly or annual — a twelvefold difference. Nothing
        may divide, multiply or assume a period.

   Expectations are written from that stated intent, not derived from the code,
   so they can still fail.

   Run: node test/test-folio-financials.js
*/

const assert = require('assert');
const http = require('http');
const express = require('express');

const FOLIO = 'c0000000-0000-4000-8000-000000000002';
const seen = [];

/* The three real payments, shaped as sales_payment returns them. The open one
   has usd_total AND amount_after_fees null, which is what makes "gross must
   come from usd_total" testable. */
const PAYMENTS = [
  { id: 'p1', provider: 'whop', external_payment_id: 'pay_zZNxyVzd31xESP',
    customer_email: 'brandi@jandmrealestate.com', customer_name: 'Brandi Jorgensen',
    status: 'paid', currency: 'USD', total: '1000.00', usd_total: '1000.00',
    amount_after_fees: '959.63', fee_amount: '40.37', refunded_amount: '0.00',
    paid_at: '2026-08-17T00:00:00Z', collected: true },
  { id: 'p2', provider: 'whop', external_payment_id: 'pay_FgziDAhWNZgyMU',
    customer_email: '225faa5e0c7253c4@deleted.com', customer_name: 'Chris Pomerleau',
    status: 'paid', currency: 'USD', total: '1.00', usd_total: '1.00',
    amount_after_fees: '0.58', fee_amount: '0.42', refunded_amount: '0.00',
    paid_at: '2026-06-04T00:00:00Z', collected: true },
  { id: 'p3', provider: 'whop', external_payment_id: 'pay_cclK859htn24nk',
    customer_email: '225faa5e0c7253c4@deleted.com', customer_name: 'Chris Pomerleau',
    status: 'open', currency: 'USD', total: '1.00', usd_total: null,
    amount_after_fees: null, fee_amount: null, refunded_amount: '0.00',
    paid_at: null, collected: false },
];

const SUBS = [
  { id: 's1', name: 'Brandi Jorgensen', email: 'brandi@jandmrealestate.com',
    status: 'active', payment_status: 'paid', provider: 'whop', currency: 'USD',
    subscription_amount: '1000.00',
    /* The null the whole MRR question turns on. */
    billing_period: null, number_of_units: null,
    start_date: '2026-08-18', next_billing_date: null, cancelled_at: null,
    entity: 'Folio Excel LLC', linked_to_lead: true },
];

const num = v => (v === null || v === undefined ? 0 : Number(v));

const fakeDb = {
  enabled: true,
  getPool() { throw new Error('not needed'); },
  q(sql, params) {
    seen.push({ sql, params });

    /* The summary aggregates are computed by the SERVER's SQL over a subquery,
       so the fake answers them the way Postgres would — from the same rows the
       payments route returns. */
    if (/coalesce\(sum\(usd_total\)/.test(sql)) {
      const c = PAYMENTS.filter(p => p.collected);
      const o = PAYMENTS.filter(p => !p.collected);
      return Promise.resolve({ rows: [{
        payments: PAYMENTS.length,
        collected_count: c.length,
        gross_usd: c.reduce((s, p) => s + num(p.usd_total), 0).toFixed(2),
        net_usd: c.reduce((s, p) => s + num(p.amount_after_fees), 0).toFixed(2),
        fees_usd: c.reduce((s, p) => s + num(p.fee_amount), 0).toFixed(2),
        outstanding_count: o.length,
        outstanding_usd: o.reduce((s, p) => s + num(p.total), 0).toFixed(2),
        refunded_usd: '0.00',
        customers: new Set(PAYMENTS.map(p => p.customer_email)).size,
        first_paid_at: '2026-06-04T00:00:00Z', last_paid_at: '2026-08-17T00:00:00Z',
      }] });
    }
    if (/coalesce\(sum\(subscription_amount\)/.test(sql)) {
      const a = SUBS.filter(s => s.status === 'active');
      return Promise.resolve({ rows: [{
        subscriptions: SUBS.length,
        active_subscriptions: a.length,
        active_amount: a.reduce((s, x) => s + num(x.subscription_amount), 0).toFixed(2),
        mrr_derivable: a.every(x => x.billing_period !== null),
      }] });
    }
    if (/from public\.financial_account fa/.test(sql)) {
      return Promise.resolve({ rows: [{ accounts: 0, deals: 0, transactions: 0 }] });
    }
    if (/from public\.whop_payment wp/.test(sql)) {
      const id = params[2];
      const p = PAYMENTS.find(x => x.external_payment_id === id);
      return Promise.resolve({ rows: p ? [{ whop_payment_id: id, status: p.status,
        payment_amount: p.total, fee: p.fee_amount, card_brand: 'visa', card_last4: '4242' }] : [] });
    }
    if (/from public\.subscription_client sc/.test(sql)) return Promise.resolve({ rows: SUBS.slice() });
    if (/from public\.sales_payment sp/.test(sql)) return Promise.resolve({ rows: PAYMENTS.slice() });
    return Promise.resolve({ rows: [] });
  },
};

require.cache[require.resolve('../supabase-db')] = { id: 'fake', filename: 'fake', loaded: true, exports: fakeDb };
const folio = require('../folio-financials-api');

let pass = 0;
const fails = [];
function check(n, fn) { try { fn(); pass++; } catch (e) { fails.push(n + ' -> ' + e.message); } }
async function checkAsync(n, fn) { try { await fn(); pass++; } catch (e) { fails.push(n + ' -> ' + e.message); } }

function serve() {
  const app = express();
  app.use('/api/folio-financials', folio.folioFinancialsRoutes());
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

(async () => {
  const server = await serve();
  const get = u => req(server, 'GET', u);

  /* ---- read-only ------------------------------------------------------- */
  for (const m of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    await checkAsync('refuses ' + m, async () => {
      assert.strictEqual((await req(server, m, '/api/folio-financials/summary')).status, 405);
    });
  }
  await checkAsync('no statement contains a write verb', async () => {
    seen.length = 0;
    await get('/api/folio-financials/summary');
    await get('/api/folio-financials/payments');
    await get('/api/folio-financials/subscriptions');
    const bad = seen.filter(s => /\b(insert|update|delete|truncate|drop|alter|create|grant|revoke)\b/i.test(s.sql));
    assert.strictEqual(bad.length, 0, bad[0] && bad[0].sql.slice(0, 120));
  });

  /* ---- scoping --------------------------------------------------------- */
  await checkAsync('every statement is scoped to tenant AND to Folio', async () => {
    seen.length = 0;
    await get('/api/folio-financials/summary');
    await get('/api/folio-financials/payments');
    await get('/api/folio-financials/subscriptions');
    assert.ok(seen.length, 'statements ran');
    for (const s of seen) {
      assert.ok(s.params && s.params.indexOf(FOLIO) >= 0,
        'a statement was not scoped to Folio: ' + s.sql.slice(0, 100));
    }
  });

  await checkAsync('subscriptions scope through entity.company_id, not company_id', async () => {
    /* subscription_client has no company_id column. Filtering on one would be
       a 42703 at runtime, so the join is the scope. */
    seen.length = 0;
    await get('/api/folio-financials/subscriptions');
    const s = seen.find(x => /subscription_client/.test(x.sql));
    assert.ok(/join public\.entity e on e\.id = sc\.business_entity_id/.test(s.sql),
      'the entity join is missing');
    assert.ok(/e\.company_id = \$2/.test(s.sql), 'the brand filter is not on the entity');
    assert.ok(!/sc\.company_id/.test(s.sql), 'filtered on a column subscription_client does not have');
  });

  /* ---- THE double-count guard ------------------------------------------ */
  await checkAsync('NO aggregate reads whop_payment', async () => {
    /* sales_payment.external_payment_id = whop_payment.whop_payment_id 1:1 on
       all three rows. Summing both gives $2,002 against a real $1,001. */
    seen.length = 0;
    await get('/api/folio-financials/summary');
    const touching = seen.filter(s => /whop_payment/.test(s.sql));
    assert.strictEqual(touching.length, 0,
      'the summary read whop_payment: ' + (touching[0] && touching[0].sql.slice(0, 140)));
  });

  await checkAsync('the payments list does not read whop_payment either', async () => {
    seen.length = 0;
    await get('/api/folio-financials/payments');
    assert.strictEqual(seen.filter(s => /whop_payment/.test(s.sql)).length, 0);
  });

  await checkAsync('whop_payment is reachable ONE row at a time, by provider id', async () => {
    /* Per-row is what keeps it out of every total. */
    seen.length = 0;
    const r = await get('/api/folio-financials/payments/pay_zZNxyVzd31xESP/whop');
    assert.strictEqual(r.status, 200);
    const s = seen.find(x => /whop_payment/.test(x.sql));
    assert.ok(s, 'the whop record was not read');
    assert.ok(/whop_payment_id = \$3/.test(s.sql), 'not keyed by the provider id');
    assert.ok(!/sum\(|count\(/i.test(s.sql), 'the per-row read aggregates');
  });

  await checkAsync('an unknown payment id is a 404, not an empty object', async () => {
    assert.strictEqual((await get('/api/folio-financials/payments/pay_nope/whop')).status, 404);
  });

  /* ---- the figures ----------------------------------------------------- */
  const sum = json(await get('/api/folio-financials/summary'));

  check('gross sums usd_total, so an uncollected payment cannot inflate it', () => {
    /* total across all three is 1002.00; gross must be 1001.00. */
    assert.strictEqual(Number(sum.gross_usd), 1001.00);
    assert.notStrictEqual(Number(sum.gross_usd), 1002.00);
  });

  check('net is after fees, and gross - fees = net', () => {
    assert.strictEqual(Number(sum.net_usd), 960.21);
    assert.strictEqual(Number(sum.fees_usd), 40.79);
    assert.ok(Math.abs(Number(sum.gross_usd) - Number(sum.fees_usd) - Number(sum.net_usd)) < 0.005,
      'gross - fees does not equal net');
  });

  check('outstanding is counted from `total`, since usd_total is null until paid', () => {
    assert.strictEqual(Number(sum.outstanding_usd), 1.00);
    assert.strictEqual(sum.outstanding_count, 1);
  });

  check('collected is 2 of 3', () => {
    assert.strictEqual(sum.collected_count, 2);
    assert.strictEqual(sum.payments, 3);
  });

  check('no field equals the double-counted total', () => {
    for (const [k, v] of Object.entries(sum)) {
      if (typeof v === 'object') continue;
      assert.notStrictEqual(Number(v), 2002.00, k + ' looks like sales_payment + whop_payment');
    }
  });

  /* ---- THE no-MRR guard ------------------------------------------------ */
  check('mrr_derivable is false while a billing period is missing', () => {
    assert.strictEqual(sum.mrr_derivable, false);
  });

  check('the payload carries NO monthly figure of any kind', () => {
    /* Not mrr, not monthly_revenue, not arr. A period nobody recorded cannot
       be divided or multiplied into one. */
    const keys = Object.keys(sum).join(' ');
    assert.ok(!/\bmrr\b(?!_derivable)|monthly|arr\b|annual/i.test(keys),
      'a derived recurring figure appeared: ' + keys);
    /* And no value is 1000/12 or 1000*12. */
    for (const v of Object.values(sum)) {
      if (typeof v === 'object') continue;
      const n = Number(v);
      assert.notStrictEqual(Math.round(n * 100), Math.round((1000 / 12) * 100), 'a monthly split appeared');
      assert.notStrictEqual(n, 12000, 'an annualised figure appeared');
    }
  });

  check('the active amount is reported as-is, without a period', () => {
    assert.strictEqual(Number(sum.active_amount), 1000.00);
    assert.strictEqual(sum.active_subscriptions, 1);
  });

  await checkAsync('the subscription row keeps billing_period null rather than defaulting it', async () => {
    const j = json(await get('/api/folio-financials/subscriptions'));
    assert.strictEqual(j.rows.length, 1);
    assert.strictEqual(j.rows[0].billing_period, null,
      'billing_period was given a default, which invents the period');
  });

  /* ---- why this screen exists at all ----------------------------------- */
  check('the summary states what the LeavenWealth model has for Folio', () => {
    /* "no cash accounts" and "$0 cash" are different claims, and only the
       first is true. The screen says which. */
    assert.ok(sum.not_applicable, 'not_applicable is missing');
    assert.strictEqual(sum.not_applicable.accounts, 0);
    assert.strictEqual(sum.not_applicable.deals, 0);
    assert.strictEqual(sum.not_applicable.transactions, 0);
  });

  check('the payload names its own source table', () => {
    assert.ok(/sales_payment/.test(sum.source), 'source does not name sales_payment');
    assert.ok(/whop_payment/.test(sum.source), 'source does not warn about whop_payment');
  });

  server.close();
  console.log('\nfolio financials: ' + pass + ' passed, ' + fails.length + ' failed');
  if (fails.length) { fails.forEach(f => console.log('  FAIL  ' + f)); process.exit(1); }
})().catch(e => { console.error(e); process.exit(1); });
