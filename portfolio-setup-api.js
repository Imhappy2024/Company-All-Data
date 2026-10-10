// ===========================================================================
// portfolio-setup-api.js — adding records from Properties (spec section H).
//
//   GET  /api/portfolio-setup/options                 what the forms offer
//   POST /api/portfolio-setup/entity                  + Entity
//   POST /api/portfolio-setup/property                + Property (guided)
//   POST /api/portfolio-setup/property/:id/building   + Building
//   GET  /api/portfolio-setup/property/:id/checklist  H3 setup checklist
//
// The Properties section is otherwise read-only, and this file keeps it that
// way in the sense that matters: it can only INSERT. There is no UPDATE and
// no DELETE anywhere below, so nothing that already exists becomes editable.
//
// ADMINS ONLY, decided here on every request from the identity
// portal-identity.js verified, never from anything the browser says. The
// server connects as the postgres superuser, so RLS is not a second line.
//
// AUDITED TWICE. The zz_audit_row_log triggers on entity, property, unit,
// loan and property_source_alias record every insert, but they run as the
// superuser and cannot know which PERSON asked. So each record created here
// also gets a sov_edit_log row naming the signed-in person, what was created
// and the values they entered.
//
// ONE TRANSACTION per form. A property whose alias, fee or loan failed to
// save is the half-set-up record the H3 checklist exists to prevent; if any
// part fails, nothing is written.
// ===========================================================================
'use strict';

const express = require('express');
const db = require('./supabase-db');
const { guard, isAdmin } = require('./portal-identity');

const LEAVENWEALTH = 'c0000000-0000-4000-8000-000000000003';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/* The vocabularies the database's own CHECK constraints allow. A value the
   constraint would refuse is refused here first, with a sentence. */
const ENTITY_TYPES = ['property', 'manager', 'holding', 'deal', 'operating_business'];
const SOURCES = ['buildium', 'appfolio', 'other'];
const BUILDING_TYPES = ['residential', 'garage', 'shed', 'storage', 'carport', 'office', 'amenity', 'laundry', 'land', 'other'];
const LOAN_PURPOSES = ['primary_mortgage', 'construction_note', 'primary_plus_construction_note', 'seller_carry', 'pace_equity', 'bridge', 'pac_due'];
const FEE_TYPES = ['pct_gross', 'fixed'];
const TIMINGS = ['same_month', 'following_month'];

/* ---- input reading: every field is checked, nothing is passed through ---- */
class Invalid extends Error {
  constructor(field, message) { super(message); this.field = field; }
}
const str = (v, field, max, required) => {
  const s = v === null || v === undefined ? '' : String(v).trim();
  if (!s) { if (required) throw new Invalid(field, 'Required.'); return null; }
  if (s.length > max) throw new Invalid(field, 'Keep this under ' + max + ' characters.');
  return s;
};
const num = (v, field, opts) => {
  if (v === null || v === undefined || String(v).trim() === '') {
    if (opts && opts.required) throw new Invalid(field, 'Required.');
    return null;
  }
  const n = Number(String(v).replace(/[$,\s]/g, ''));
  if (!Number.isFinite(n)) throw new Invalid(field, 'Enter a number.');
  if (opts && opts.min !== undefined && n < opts.min) throw new Invalid(field, 'Must be at least ' + opts.min + '.');
  if (opts && opts.max !== undefined && n > opts.max) throw new Invalid(field, 'Must be at most ' + opts.max + '.');
  if (opts && opts.int && !Number.isInteger(n)) throw new Invalid(field, 'Enter a whole number.');
  return n;
};
const day = (v, field, required) => {
  const s = v === null || v === undefined ? '' : String(v).trim();
  if (!s) { if (required) throw new Invalid(field, 'Required.'); return null; }
  if (!DAY.test(s) || isNaN(Date.parse(s + 'T00:00:00Z'))) throw new Invalid(field, 'Enter a date.');
  return s;
};
const oneOf = (v, list, field, required) => {
  if (v === null || v === undefined || v === '') { if (required) throw new Invalid(field, 'Required.'); return null; }
  if (list.indexOf(v) < 0) throw new Invalid(field, 'Not one of the allowed values.');
  return v;
};
const uuid = (v, field, required) => {
  if (!v) { if (required) throw new Invalid(field, 'Required.'); return null; }
  if (!UUID.test(String(v))) throw new Invalid(field, 'Not a valid choice.');
  return String(v);
};

function adminOnly(handler) {
  return guard(async (req, res, who) => {
    if (!isAdmin(who)) return res.status(403).json({ error: 'Only an owner or admin can add records.' });
    try {
      await handler(req, res, who);
    } catch (e) {
      if (e instanceof Invalid) return res.status(400).json({ error: e.message, field: e.field });
      if (e && e.status) return res.status(e.status).json({ error: e.message, field: e.field || null });
      if (e && e.code === '23505') return res.status(409).json({ error: 'That already exists: ' + (e.detail || e.message) });
      throw e;
    }
  }, { nav: 'properties' });
}
const conflict = (field, message) => Object.assign(new Error(message), { status: 409, field });

/* The auth user behind the staff row, for created_by. created_by references
   auth.users, and a staff id there would be a foreign key violation. */
async function authUserOf(client, who) {
  const r = await client.query('select user_id from public.staff where id = $1', [who.staffId]);
  return (r.rows[0] && r.rows[0].user_id) || null;
}

async function audit(client, who, table, id, values, note) {
  await client.query(
    `insert into public.sov_edit_log (tenant_id, edited_by, target_table, target_id, column_name, old_value, new_value, note)
     values ($1, $2, $3, $4, '(record created)', null, $5, $6)`,
    [who.tenantId, who.email || who.fullName || who.staffId, table, id, JSON.stringify(values), note]
  );
}

/* New records appear in the Properties screens through the materialized
   views, so they are refreshed before answering. About half a second. */
async function refreshReporting() {
  try { await db.q('select reporting.refresh_reporting()'); }
  catch (e) { console.error('[portfolio-setup] refresh_reporting failed:', e.message); }
}

/* ---- GET /options -------------------------------------------------------- */
async function options(req, res, who) {
  if (!isAdmin(who)) return res.json({ ok: true, isAdmin: false });
  const [ents, groups, assetTypes] = await Promise.all([
    db.q(`select e.id, e.name, e.entity_type, e.manager_entity_id,
                 exists (select 1 from public.entity c where c.manager_entity_id = e.id) as manages
            from public.entity e where e.tenant_id = $1 order by lower(e.name)`, [who.tenantId]),
    db.q(`select distinct manager_group from public.am_fee_schedule where tenant_id = $1 order by 1`, [who.tenantId]),
    db.q(`select asset_type, count(*)::int n from public.property
           where tenant_id = $1 and asset_type is not null group by 1 order by 2 desc, 1`, [who.tenantId]),
  ]);
  res.json({
    ok: true, isAdmin: true,
    entities: ents.rows,
    managers: ents.rows.filter(e => e.manages || e.entity_type === 'manager'),
    managerGroups: groups.rows.map(r => r.manager_group),
    assetTypes: assetTypes.rows.map(r => r.asset_type),
    entityTypes: ENTITY_TYPES, sources: SOURCES, buildingTypes: BUILDING_TYPES,
    loanPurposes: LOAN_PURPOSES, feeTypes: FEE_TYPES, timings: TIMINGS,
  });
}

/* ---- + Entity ------------------------------------------------------------ */
async function insertEntity(client, who, b, prefix) {
  const p = prefix || '';
  const v = {
    name: str(b.name, p + 'name', 200, true),
    entity_type: oneOf(b.entity_type || null, ENTITY_TYPES, p + 'entity_type', false),
    parent_entity_id: uuid(b.parent_entity_id, p + 'parent_entity_id', false),
    manager_entity_id: uuid(b.manager_entity_id, p + 'manager_entity_id', false),
  };
  const dup = await client.query('select id from public.entity where tenant_id = $1 and lower(name) = lower($2)', [who.tenantId, v.name]);
  if (dup.rows.length) throw conflict(p + 'name', 'An entity called "' + v.name + '" already exists.');
  for (const k of ['parent_entity_id', 'manager_entity_id']) {
    if (!v[k]) continue;
    const ok = await client.query('select 1 from public.entity where id = $1 and tenant_id = $2', [v[k], who.tenantId]);
    if (!ok.rows.length) throw new Invalid(p + k, 'That entity was not found.');
  }
  const r = await client.query(
    `insert into public.entity (tenant_id, company_id, name, entity_type, parent_entity_id, manager_entity_id, created_by)
     values ($1, $2, $3, $4, $5, $6, $7) returning id, name`,
    [who.tenantId, LEAVENWEALTH, v.name, v.entity_type, v.parent_entity_id, v.manager_entity_id, await authUserOf(client, who)]
  );
  await audit(client, who, 'entity', r.rows[0].id, v, 'Added from Properties');
  return r.rows[0];
}

async function createEntity(req, res, who) {
  const out = await db.tx(client => insertEntity(client, who, req.body || {}));
  await refreshReporting();
  res.status(201).json({ ok: true, entity: out });
}

/* ---- + Property ----------------------------------------------------------
   One form, one transaction: the property, its owner LLC (picked or new),
   the name it carries in the report source, its Dropbox link, the asset
   management fee and an optional loan. */
async function createProperty(req, res, who) {
  const b = req.body || {};
  const out = await db.tx(async client => {
    const userId = await authUserOf(client, who);

    /* owner LLC: an existing entity, or a new one created in the same go */
    let ownerId = uuid(b.owner_entity_id, 'owner_entity_id', false);
    let ownerNew = null;
    if (!ownerId) {
      if (!b.new_owner || !String(b.new_owner.name || '').trim()) {
        throw new Invalid('owner_entity_id', 'Pick the owner LLC, or name a new one.');
      }
      ownerNew = await insertEntity(client, who, {
        name: b.new_owner.name, entity_type: 'property',
        manager_entity_id: b.new_owner.manager_entity_id,
      }, 'new_owner.');
      ownerId = ownerNew.id;
    } else {
      const ok = await client.query('select 1 from public.entity where id = $1 and tenant_id = $2', [ownerId, who.tenantId]);
      if (!ok.rows.length) throw new Invalid('owner_entity_id', 'That entity was not found.');
    }

    const p = {
      dba_name: str(b.name, 'name', 200, true),
      street: str(b.street, 'street', 200, false),
      city: str(b.city, 'city', 100, false),
      state: str(b.state, 'state', 40, false),
      zip: str(b.zip, 'zip', 20, false),
      asset_type: str(b.asset_type, 'asset_type', 100, false),
      year_built: str(b.year_built, 'year_built', 20, false),
      management_company: str(b.management_company, 'management_company', 200, false),
      purchase_price: num(b.purchase_price, 'purchase_price', { min: 0 }),
      purchase_date: day(b.purchase_date, 'purchase_date', false),
      units: num(b.units, 'units', { min: 0, max: 100000, int: true }),
      dropbox_url: str(b.dropbox_url, 'dropbox_url', 1000, false),
    };
    if (p.dropbox_url && !/^https:\/\/(www\.)?dropbox\.com\//i.test(p.dropbox_url)) {
      throw new Invalid('dropbox_url', 'Paste the folder\'s Dropbox link (https://www.dropbox.com/...).');
    }
    const dupP = await client.query('select id from public.property where tenant_id = $1 and lower(dba_name) = lower($2)', [who.tenantId, p.dba_name]);
    if (dupP.rows.length) throw conflict('name', 'A property called "' + p.dba_name + '" already exists.');

    const ins = await client.query(
      `insert into public.property (tenant_id, entity_id, dba_name, street, city, state, zip, asset_type,
         year_built, management_company, purchase_price, purchase_date, dropbox_url, ownership_status,
         unit_count_verified, unit_count_verified_by, unit_count_verified_at, unit_count_note, created_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'held',
         $14, case when $14::int is null then null else $15 end,
         case when $14::int is null then null else now() end,
         case when $14::int is null then null else 'Entered when the property was added' end, $16)
       returning id, dba_name`,
      [who.tenantId, ownerId, p.dba_name, p.street, p.city, p.state, p.zip, p.asset_type,
       p.year_built, p.management_company, p.purchase_price, p.purchase_date, p.dropbox_url,
       p.units, who.email || who.fullName, userId]
    );
    const propertyId = ins.rows[0].id;
    await audit(client, who, 'property', propertyId, Object.assign({ owner_entity_id: ownerId }, p), 'Added from Properties');

    /* the name the report source uses: what the sync matches T12s and rent
       rolls on. Unique per source, so a name already matched elsewhere is
       a conflict worth stopping for, not something to overwrite. */
    const source = oneOf(b.source_system || null, SOURCES, 'source_system', false);
    const sourceLabel = str(b.source_label, 'source_label', 300, !!source);
    if (source && sourceLabel) {
      const taken = await client.query(
        `select p.dba_name from public.property_source_alias a join public.property p on p.id = a.property_id
          where a.tenant_id = $1 and a.source_system = $2 and lower(a.source_label) = lower($3)`,
        [who.tenantId, source, sourceLabel]);
      if (taken.rows.length) {
        throw conflict('source_label', 'That name is already matched to ' + taken.rows[0].dba_name + '.');
      }
      const a = await client.query(
        `insert into public.property_source_alias (tenant_id, property_id, source_system, source_label, scope, notes)
         values ($1, $2, $3, $4, 'property', 'Added with the property') returning id`,
        [who.tenantId, propertyId, source, sourceLabel]);
      await audit(client, who, 'property_source_alias', a.rows[0].id, { source, sourceLabel }, 'Added with ' + p.dba_name);
    }

    /* asset management fee */
    const fee = b.fee && b.fee.enabled ? b.fee : null;
    if (fee) {
      const f = {
        manager_group: str(fee.manager_group, 'fee.manager_group', 100, true),
        fee_type: oneOf(fee.fee_type, FEE_TYPES, 'fee.fee_type', true),
        payment_timing: oneOf(fee.payment_timing, TIMINGS, 'fee.payment_timing', true),
        effective_from: day(fee.effective_from, 'fee.effective_from', false),
      };
      f.fee_pct = f.fee_type === 'pct_gross' ? num(fee.fee_pct, 'fee.fee_pct', { required: true, min: 0, max: 100 }) : null;
      f.fixed_amount = f.fee_type === 'fixed' ? num(fee.fixed_amount, 'fee.fixed_amount', { required: true, min: 0 }) : null;
      const label = p.dba_name;
      const dupF = await client.query('select 1 from public.am_fee_schedule where tenant_id = $1 and lower(label) = lower($2)', [who.tenantId, label]);
      if (dupF.rows.length) throw conflict('fee.manager_group', 'A fee schedule called "' + label + '" already exists.');
      const s = await client.query(
        `insert into public.am_fee_schedule (tenant_id, label, manager_group, payment_timing, fee_type,
           fee_pct, fixed_amount, effective_from, sort_order)
         values ($1, $2, $3, $4, $5, $6, $7, coalesce($8::date, date_trunc('month', now())::date),
           (select coalesce(max(sort_order), 0) + 10 from public.am_fee_schedule where tenant_id = $1))
         returning id`,
        [who.tenantId, label, f.manager_group, f.payment_timing, f.fee_type, f.fee_pct, f.fixed_amount, f.effective_from]);
      await client.query('insert into public.am_fee_schedule_property (schedule_id, property_id) values ($1, $2)', [s.rows[0].id, propertyId]);
      await audit(client, who, 'am_fee_schedule', s.rows[0].id, f, 'Fee for ' + p.dba_name);
    }

    /* optional loan, secured on the property, borrowed by the owner LLC */
    const loan = b.loan && b.loan.enabled ? b.loan : null;
    if (loan) {
      const ratePct = num(loan.interest_rate_pct, 'loan.interest_rate_pct', { min: 0, max: 30 });
      const l = {
        lender: str(loan.lender, 'loan.lender', 200, true),
        loan_number: str(loan.loan_number, 'loan.loan_number', 100, false),
        purpose: oneOf(loan.purpose || null, LOAN_PURPOSES, 'loan.purpose', false),
        origination_amount: num(loan.origination_amount, 'loan.origination_amount', { required: true, min: 0 }),
        origination_date: day(loan.origination_date, 'loan.origination_date', false),
        maturity_date: day(loan.maturity_date, 'loan.maturity_date', false),
        /* loan.interest_rate_pct is a FRACTION (0.065 = 6.50%); people type 6.5 */
        interest_rate_pct: ratePct === null ? null : ratePct / 100,
      };
      if (l.origination_date && l.maturity_date && l.maturity_date < l.origination_date) {
        throw new Invalid('loan.maturity_date', 'Maturity is before origination.');
      }
      const ln = await client.query(
        `insert into public.loan (tenant_id, borrower_entity_id, lender, loan_number, purpose, origination_amount,
           origination_date, maturity_date, interest_rate_pct, status, created_by)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'active', $10) returning id`,
        [who.tenantId, ownerId, l.lender, l.loan_number, l.purpose, l.origination_amount,
         l.origination_date, l.maturity_date, l.interest_rate_pct, userId]);
      await client.query(
        'insert into public.loan_collateral (tenant_id, loan_id, property_id, created_by) values ($1, $2, $3, $4)',
        [who.tenantId, ln.rows[0].id, propertyId, userId]);
      await audit(client, who, 'loan', ln.rows[0].id, l, 'Loan on ' + p.dba_name);
    }

    return { id: propertyId, name: p.dba_name, owner: ownerNew };
  });
  await refreshReporting();
  res.status(201).json({ ok: true, property: out });
}

/* ---- + Building ------------------------------------------------------------
   A building is identified by (property, name), never by address: several
   share one, and outbuildings have none. Blank address = shares the
   property's, which is how outbuildings are already recorded. */
async function createBuilding(req, res, who) {
  const pid = uuid(req.params.id, 'property', true);
  const b = req.body || {};
  const out = await db.tx(async client => {
    const prop = await client.query('select id, entity_id, dba_name from public.property where id = $1 and tenant_id = $2', [pid, who.tenantId]);
    if (!prop.rows.length) throw Object.assign(new Error('No such property.'), { status: 404 });
    const v = {
      unit_identifier: str(b.name, 'name', 120, true),
      current_total_units: num(b.units, 'units', { required: true, min: 0, max: 10000, int: true }),
      building_type: oneOf(b.building_type || null, BUILDING_TYPES, 'building_type', false),
      location_street: str(b.street, 'street', 200, false),
      location_city: str(b.city, 'city', 100, false),
      location_state: str(b.state, 'state', 40, false),
      location_zip: str(b.zip, 'zip', 20, false),
    };
    const dup = await client.query('select 1 from public.unit where property_id = $1 and lower(unit_identifier) = lower($2)', [pid, v.unit_identifier]);
    if (dup.rows.length) throw conflict('name', prop.rows[0].dba_name + ' already has a building called "' + v.unit_identifier + '".');
    const r = await client.query(
      `insert into public.unit (tenant_id, property_id, entity_id, unit_identifier, current_total_units,
         building_type, location_street, location_city, location_state, location_zip, created_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) returning id, unit_identifier`,
      [who.tenantId, pid, prop.rows[0].entity_id, v.unit_identifier, v.current_total_units, v.building_type,
       v.location_street, v.location_city, v.location_state, v.location_zip, await authUserOf(client, who)]);
    await audit(client, who, 'unit', r.rows[0].id, v, 'Building added to ' + prop.rows[0].dba_name);
    return r.rows[0];
  });
  await refreshReporting();
  res.status(201).json({ ok: true, building: out });
}

/* ---- H3: the setup checklist ----------------------------------------------
   Read-only and for everyone who can see the property: it answers "is this
   property fully set up", which is as useful to the person reading a blank
   T12 tab as to the admin who added it. */
async function checklist(req, res, who) {
  const pid = uuid(req.params.id, 'property', true);
  const r = await db.q(
    `select p.id, p.dropbox_url,
            (select json_agg(json_build_object('source', a.source_system, 'label', a.source_label) order by a.source_system)
               from public.property_source_alias a where a.property_id = p.id and not a.is_ignored) as aliases,
            (select count(*)::int from public.document d where d.property_id = p.id) as documents,
            (select json_agg(json_build_object('label', s.label, 'group', s.manager_group, 'type', s.fee_type,
                    'pct', s.fee_pct, 'fixed', s.fixed_amount, 'timing', s.payment_timing))
               from public.am_fee_schedule_property l join public.am_fee_schedule s on s.id = l.schedule_id
              where l.property_id = p.id) as fees,
            (select count(distinct c.loan_id)::int from public.loan_collateral c
              where c.property_id = p.id or c.unit_id in (select u.id from public.unit u where u.property_id = p.id)) as loans,
            ps.t12_period_end, ps.rent_roll_as_of
       from public.property p
       left join reporting.property_summary_mv ps on ps.id = p.id
      where p.id = $1 and p.tenant_id = $2`,
    [pid, who.tenantId]);
  const x = r.rows[0];
  if (!x) return res.status(404).json({ error: 'No such property.' });
  const aliases = x.aliases || [];
  const SRC = { buildium: 'Buildium', appfolio: 'AppFolio', other: 'Other source' };
  res.json({ ok: true, items: [
    { key: 'sync', label: 'Sync name matched', done: aliases.length > 0,
      detail: aliases.length
        ? aliases.map(a => (SRC[a.source] || a.source) + ': "' + a.label + '"').join('; ') +
          (x.t12_period_end || x.rent_roll_as_of ? '' : '. No report has arrived under that name yet.')
        : 'No report-source name on file, so T12s and rent rolls cannot be matched to this property.' },
    { key: 'dropbox', label: 'Dropbox folder set', done: !!x.dropbox_url || x.documents > 0,
      detail: x.dropbox_url ? 'Folder link on file' + (x.documents ? ', ' + x.documents + ' documents filed' : ', no documents filed yet')
        : (x.documents ? x.documents + ' documents filed, no folder link on file' : 'No folder link and no documents filed.') },
    { key: 'fee', label: 'Fee set', done: !!(x.fees && x.fees.length),
      detail: x.fees && x.fees.length
        ? x.fees.map(f => f.group + ', ' + (f.type === 'fixed' ? '$' + Number(f.fixed).toLocaleString('en-US') + ' a month' : Number(f.pct) + '% of gross') +
            ', paid ' + (f.timing === 'same_month' ? 'the same month' : 'the following month')).join('; ')
        : 'No asset management fee schedule covers this property.' },
    { key: 'loan', label: 'Loan on file', done: x.loans > 0,
      detail: x.loans ? x.loans + (x.loans === 1 ? ' loan' : ' loans') + ' secured on this property' : 'No loan is secured on this property or its buildings.' },
  ] });
}

function setupRoutes() {
  const r = express.Router();
  r.use(express.json({ limit: '64kb' }));
  r.get('/options', guard(options, { nav: 'properties' }));
  r.post('/entity', adminOnly(createEntity));
  r.post('/property', adminOnly(createProperty));
  r.post('/property/:id/building', adminOnly(createBuilding));
  r.get('/property/:id/checklist', guard(checklist, { nav: 'properties' }));
  return r;
}

module.exports = { setupRoutes, _internal: { insertEntity, createProperty, createBuilding, checklist, options, Invalid } };
