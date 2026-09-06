/* Leads (GHL) — brand scoping, and the read-only guard.

   The live figures (1,231 LeavenWealth leads, 111 Folio messages) were verified
   against Supabase on 2026-09-07 and are Jay's to re-check. What this pins is
   the thing that would still be wrong if those figures were right: whether one
   brand's workspace can be made to answer with another brand's leads.

   That failure is silent in the worst way. Nothing errors, the screen fills,
   and the only tell is that the names are wrong — which nobody notices until
   they recognise a contact who should not be there.

   Expectations are written from the stated intent, not derived from the code
   under test, so they can still fail.

   Run: node test/test-ghl.js
*/

const assert = require('assert');
const http = require('http');
const express = require('express');

/* ---- fake database ------------------------------------------------------ */

const seen = [];

const LW   = 'r7zMur27ESvHGQpOWI2F';
const LEAD = 'sR79W8mCX3gd5pWKG5wU';
const FOL  = 'xvWwoC1KQ1cOtw8Qf3Ez';

const CO_LEADLI = 'c0000000-0000-4000-8000-000000000001';
const CO_FOLIO  = 'c0000000-0000-4000-8000-000000000002';
const CO_LW     = 'c0000000-0000-4000-8000-000000000003';
const CO_LIQUID = 'c0000000-0000-4000-8000-000000000004';

const LOCATIONS = [
  { ghl_location_id: LW,   name: 'LeavenWealth', company_id: CO_LW },
  { ghl_location_id: LEAD, name: 'LeadLi AI',    company_id: CO_LEADLI },
  { ghl_location_id: FOL,  name: 'Folio Excel',  company_id: CO_FOLIO },
];

function leadRow(loc, contact, name) {
  return {
    location_id: loc, contact_id: contact, contact_name: name,
    phone: '(402) 555-0134', email: name.toLowerCase().replace(/\s+/g, '') + '@example.com',
    source: 'Facebook', tags: ['investor'], contact_owner: 'Megan Richardson',
    date_added: '2026-05-01T10:00:00Z',
    opportunity_id: null, pipeline_id: null, stage_id: null, stage_name: null,
    status: null, value: null, opp_name: null, opp_owner: null, updated_at: null,
    last_at: null, last_in: null, last_out: null,
    activity: '2026-05-01T10:00:00Z', changed_at: '2026-05-01T10:00:00Z',
  };
}

const fakeDb = {
  enabled: true,
  getPool() { throw new Error('not needed'); },
  q(sql, params) {
    seen.push({ sql, params });

    if (/information_schema/.test(sql)) {
      return Promise.resolve({ rows: [{ has_col: 1, has_tbl: 1 }] });
    }

    /* allowedLocationIds(companyId) */
    if (/SELECT ghl_location_id FROM ghl_location WHERE company_id/.test(sql)) {
      return Promise.resolve({
        rows: LOCATIONS.filter(l => l.company_id === params[0])
                       .map(l => ({ ghl_location_id: l.ghl_location_id })),
      });
    }
    if (/SELECT ghl_location_id FROM ghl_location\s*$/.test(sql.trim())) {
      return Promise.resolve({ rows: LOCATIONS.map(l => ({ ghl_location_id: l.ghl_location_id })) });
    }

    /* subAccounts */
    if (/FROM ghl_location gl/.test(sql)) {
      const onlyId = params[0], companyId = params[1];
      const rows = LOCATIONS
        .filter(l => (!onlyId || l.ghl_location_id === onlyId))
        .filter(l => (!companyId || l.company_id === companyId))
        .map(l => ({ id: l.ghl_location_id, name: l.name, brand: l.name,
                     lead_count: 10, opportunity_count: 1 }));
      return Promise.resolve({ rows });
    }

    /* leadRows — returns rows only for the location ids it was handed, which
       is what makes a leaked id observable in the response rather than only in
       the SQL. */
    if (/FROM lead l/.test(sql) && /WITH msg AS/.test(sql)) {
      const ids = params[0] || [];
      const rows = [];
      for (const id of ids) {
        const who = LOCATIONS.find(l => l.ghl_location_id === id);
        rows.push(leadRow(id, 'c-' + id, (who ? who.name : id) + ' Contact'));
      }
      /* The company-only lead: a brand with no location still has these. */
      const companyId = params[6];
      if (companyId === CO_LIQUID) {
        const r = leadRow(null, 'c-liquid', 'Liquid Only Contact');
        r.location_id = null;
        rows.push(r);
      }
      return Promise.resolve({ rows });
    }

    if (/count\(\*\)::int/i.test(sql) || /COUNT\(\*\)::int AS n/i.test(sql)) {
      return Promise.resolve({ rows: [{ n: 10, total: 10 }] });
    }
    if (/FROM ghl_pipeline_stage/.test(sql)) {
      return Promise.resolve({ rows: [{ id: 'stage-1', name: 'New Lead', position: 0, opportunities: 3, value: '0' }] });
    }
    if (/ghl_sync_log/.test(sql)) return Promise.resolve({ rows: [] });
    return Promise.resolve({ rows: [] });
  },
};

require.cache[require.resolve('../supabase-db')] = { id: 'fake', filename: 'fake', loaded: true, exports: fakeDb };

const ghl = require('../ghl-api');

/* ---- harness ------------------------------------------------------------ */

let pass = 0;
const fails = [];
function check(name, fn) { try { fn(); pass++; } catch (e) { fails.push(name + ' -> ' + e.message); } }
async function checkAsync(name, fn) { try { await fn(); pass++; } catch (e) { fails.push(name + ' -> ' + e.message); } }

function serve() {
  const app = express();
  app.use('/api/ghl', ghl.ghlRoutes());
  return new Promise(res => { const s = app.listen(0, () => res(s)); });
}
function req(server, method, url) {
  return new Promise((resolve, reject) => {
    const r = http.request({ port: server.address().port, path: url, method }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
    });
    r.on('error', reject);
    r.end();
  });
}
const json = r => JSON.parse(r.body.toString('utf8'));

/* ---- tests -------------------------------------------------------------- */

(async () => {
  const server = await serve();
  const get = u => req(server, 'GET', u);

  /* 1. Read-only. */
  for (const m of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    await checkAsync('the router refuses ' + m, async () => {
      const r = await req(server, m, '/api/ghl/leads');
      assert.strictEqual(r.status, 405, 'got ' + r.status);
    });
  }

  await checkAsync('no statement it ever issues contains a write verb', async () => {
    seen.length = 0;
    await get('/api/ghl/locations?company_id=' + CO_LW);
    await get('/api/ghl/leads?company_id=' + CO_LW);
    await get('/api/ghl/stages?company_id=' + CO_LW);
    const bad = seen.filter(s => /\b(insert|update|delete|truncate|drop|alter|create|grant|revoke)\b/i.test(s.sql));
    assert.strictEqual(bad.length, 0, 'found: ' + (bad[0] && bad[0].sql.slice(0, 120)));
  });

  /* 2. THE scoping tests. Each brand sees its own location and no other. */
  const BRANDS = [
    ['LeavenWealth', CO_LW, LW, [LEAD, FOL]],
    ['Leadli AI', CO_LEADLI, LEAD, [LW, FOL]],
    ['Folio Excel', CO_FOLIO, FOL, [LW, LEAD]],
  ];

  for (const [label, company, mine, others] of BRANDS) {
    await checkAsync(label + ' sees only its own sub-account', async () => {
      const j = json(await get('/api/ghl/locations?company_id=' + company));
      const ids = j.locations.map(l => l.id);
      assert.deepStrictEqual(ids, [mine], 'got ' + JSON.stringify(ids));
    });

    await checkAsync(label + ' leads carry only its own location', async () => {
      const j = json(await get('/api/ghl/leads?company_id=' + company));
      const locs = [...new Set(j.leads.map(l => l.loc))];
      assert.deepStrictEqual(locs, [mine], 'got ' + JSON.stringify(locs));
      for (const other of others) {
        assert.ok(!JSON.stringify(j).includes(other),
          'another brand\'s location id leaked into the payload: ' + other);
      }
    });

    await checkAsync(label + ' cannot read another brand\'s lead by id', async () => {
      /* The whole point of putting the gate in allowedLocationIds rather than
         only in the list: a guessed id must not answer. */
      for (const other of others) {
        const r = await get('/api/ghl/leads/' + other + ':c-' + other + '/thread?company_id=' + company);
        assert.strictEqual(r.status, 404, 'expected 404 for ' + other + ', got ' + r.status);
        const r2 = await get('/api/ghl/leads/' + other + ':c-' + other + '/detail?company_id=' + company);
        assert.strictEqual(r2.status, 404, 'expected 404 for ' + other + ', got ' + r2.status);
      }
    });
  }

  await checkAsync('the ?location= param cannot widen past the brand', async () => {
    /* Narrowing within the brand is fine; naming another brand's location must
       select nothing rather than fetching it. */
    const j = json(await get('/api/ghl/leads?company_id=' + CO_LW + '&location=' + FOL));
    assert.strictEqual(j.leads.length, 0, 'got ' + j.leads.length + ' leads');
    assert.ok(!JSON.stringify(j).includes(FOL), 'the foreign location id leaked');
  });

  await checkAsync('no company_id scopes to NOTHING, never to everything', async () => {
    /* The safe direction. An empty screen gets reported; another brand's 4,643
       leads under this one does not. */
    const j = json(await get('/api/ghl/locations'));
    assert.deepStrictEqual(j.locations.map(l => l.id), [],
      'an unscoped request returned locations: ' + JSON.stringify(j.locations));
    const l = json(await get('/api/ghl/leads'));
    assert.strictEqual(l.leads.length, 0, 'an unscoped request returned leads');
  });

  await checkAsync('a malformed company_id scopes to nothing rather than being ignored', async () => {
    const j = json(await get('/api/ghl/locations?company_id=not-a-uuid'));
    assert.deepStrictEqual(j.locations.map(l => l.id), [],
      'a junk company_id fell through to unscoped');
  });

  await checkAsync('the brand filter reaches the SQL, not just the response', async () => {
    seen.length = 0;
    await get('/api/ghl/leads?company_id=' + CO_LW);
    const gate = seen.find(s => /company_id/.test(s.sql));
    assert.ok(gate, 'no statement filtered on company_id');
    assert.ok(gate.params.includes(CO_LW), 'the company id was not bound');
  });

  /* 3. Liquid Lending: a brand with leads but no sub-account. */
  await checkAsync('a brand with no sub-account still returns its company-only leads', async () => {
    /* Verified live: Liquid has 0 ghl_location rows and 8 leads carrying only a
       company_id. The location-only predicate command-center shipped hides
       every one of them. */
    const j = json(await get('/api/ghl/leads?company_id=' + CO_LIQUID));
    assert.strictEqual(j.leads.length, 1, 'got ' + j.leads.length);
    assert.strictEqual(j.leads[0].name, 'Liquid Only Contact');
    assert.strictEqual(j.leads[0].noLocation, true,
      'a location-less lead must be flagged so the client does not fetch a thread for it');
  });

  await checkAsync('that brand reports the scope resolved to no sub-account', async () => {
    const j = json(await get('/api/ghl/locations?company_id=' + CO_LIQUID));
    assert.strictEqual(j.scoped, true, 'the request was scoped');
    assert.strictEqual(j.scopeResolved, false, 'and it resolved to no location');
  });

  await checkAsync('the company id is bound for the company-only widening', async () => {
    seen.length = 0;
    await get('/api/ghl/leads?company_id=' + CO_LIQUID);
    const q = seen.find(s => /WITH msg AS/.test(s.sql));
    assert.ok(q, 'the lead query ran even with no location ids');
    assert.strictEqual(q.params[6], CO_LIQUID, 'companyId was not passed as $7');
    assert.ok(/l\.company_id = \$7/.test(q.sql), 'the widening predicate is missing');
  });

  /* 4. Shaping rules that would misreport the data. */
  check('a lead id round-trips through splitLeadId', () => {
    const parsed = ghl.splitLeadId(LW + ':abc123');
    assert.strictEqual(parsed.locationId, LW);
    assert.strictEqual(parsed.contactId, 'abc123');
  });

  check('an opportunity-only lead id is recognised as one', () => {
    const parsed = ghl.splitLeadId(LW + ':o_opp-9');
    assert.strictEqual(parsed.opportunityId, 'opp-9');
    assert.strictEqual(parsed.contactId, null);
  });

  check('a malformed lead id yields no location rather than a partial one', () => {
    for (const bad of ['', 'nocolon', ':leading', 'trailing:']) {
      assert.strictEqual(ghl.splitLeadId(bad).locationId, null, 'accepted ' + JSON.stringify(bad));
    }
  });

  check('a contact with no opportunity has NO stage, not a default one', () => {
    /* Only 28 of LeavenWealth's 1,231 leads have a stage. Defaulting to "new"
       would assert a pipeline position about twelve hundred people. */
    const shaped = ghl.shapeLead(leadRow(LW, 'c1', 'No Opp'));
    assert.strictEqual(shaped.stageName, null);
    assert.strictEqual(shaped.stageId, null);
    assert.strictEqual(shaped.status, null);
  });

  check('unread means they answered last, and is false with no messages', () => {
    const none = ghl.shapeLead(leadRow(LW, 'c1', 'Quiet'));
    assert.strictEqual(none.unread, false);

    const row = leadRow(LW, 'c2', 'Replied');
    row.last_in = '2026-05-02T10:00:00Z';
    row.last_out = '2026-05-01T10:00:00Z';
    assert.strictEqual(ghl.shapeLead(row).unread, true, 'inbound newer than outbound is unread');

    row.last_out = '2026-05-03T10:00:00Z';
    assert.strictEqual(ghl.shapeLead(row).unread, false, 'we answered after them');
  });

  check('a NUMERIC value arriving as text becomes a number', () => {
    const row = leadRow(LW, 'c1', 'Valued');
    row.value = '25000.50';
    assert.strictEqual(ghl.shapeLead(row).value, 25000.5);
  });

  check('sender HTML is flattened, never passed through', () => {
    const out = ghl.flatten('<script>alert(1)</script><p>Hello</p><br>World&nbsp;&amp;&nbsp;co');
    assert.ok(out.indexOf('<') < 0, 'markup survived: ' + out);
    assert.ok(out.indexOf('alert(1)') < 0, 'a script body survived: ' + out);
    assert.ok(out.indexOf('Hello') >= 0 && out.indexOf('World') >= 0, 'text was lost: ' + out);
  });

  await checkAsync('a one-character search is ignored and SAYS it was ignored', async () => {
    /* Echoing back a term that did not run is how a caller concludes the
       search is broken when it simply did not happen. */
    const j = json(await get('/api/ghl/leads?company_id=' + CO_LW + '&q=a'));
    assert.strictEqual(j.search, null, 'a single character was treated as a search');
    assert.strictEqual(j.searchIgnored, true, 'the response does not say it was ignored');
  });

  await checkAsync('a two-character search runs', async () => {
    const j = json(await get('/api/ghl/leads?company_id=' + CO_LW + '&q=ab'));
    assert.strictEqual(j.search, 'ab');
    assert.strictEqual(j.searchIgnored, false);
  });

  await checkAsync('a malformed ?since is refused, not treated as "everything"', async () => {
    /* Silently widening it would make the browser merge a full list believing
       it was a delta. */
    const r = await get('/api/ghl/leads?company_id=' + CO_LW + '&since=yesterday');
    assert.strictEqual(r.status, 400, 'got ' + r.status);
  });

  server.close();
  console.log('\nghl: ' + pass + ' passed, ' + fails.length + ' failed');
  if (fails.length) { fails.forEach(f => console.log('  FAIL  ' + f)); process.exit(1); }
})().catch(e => { console.error(e); process.exit(1); });
