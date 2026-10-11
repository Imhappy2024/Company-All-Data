// ===========================================================================
// shell-api.js — the shared pages every business has: Team, Departments,
// Tools & apps. Mounted at /api/shell behind portal-identity asCaller(), so
// each read runs as the signed-in person's connector role: someone sees the
// same people, departments and tools here as in Claude.
//
//   GET /team          active staff with their businesses and type
//   GET /departments   departments with current member counts
//   GET /tools         the tool register (no credentials: none are stored here)
// ===========================================================================
'use strict';

const express = require('express');
const db = require('./supabase-db');

const q = async (sql, params) => (await db.q(sql, params)).rows;

async function team(req, res) {
  const rows = await q(`
    select s.id, s.full_name name, s.title, s.email, s.phone, s.staff_type, s.avatar_url, s.description,
           coalesce((select json_agg(json_build_object('id', c.id, 'name', c.name) order by c.name)
                       from public.staff_company sc join public.company c on c.id = sc.company_id
                      where sc.staff_id = s.id and sc.is_active is not false), '[]') businesses
      from public.staff s
     where s.tenant_id = $1 and s.is_active
     order by s.full_name`, [req.who.tenantId]);
  res.json({ people: rows.map(r => ({
    id: r.id, name: r.name || '', title: r.title || '', email: r.email || '', phone: r.phone || '',
    type: r.staff_type === 'contractor' ? 'Contractor' : 'Employee', avatar_url: r.avatar_url || '',
    /* a description that is only a URL is not a bio (one row holds an avatar URL there) */
    bio: /^\s*https?:\/\/\S+\s*$/.test(r.description || '') ? '' : (r.description || ''),
    businesses: r.businesses,
  })) });
}

async function departments(req, res) {
  const rows = await q(`
    select d.id, d.name, p.name parent,
           (select count(*) from public.department_member m where m.department_id = d.id
               and (m.end_date is null or m.end_date >= current_date))::int members
      from public.department d left join public.department p on p.id = d.parent_department_id
     where d.tenant_id = $1 order by d.name`, [req.who.tenantId]);
  res.json({ departments: rows });
}

async function tools(req, res) {
  const rows = await q(`
    select t.id, t.name, t.category, t.plan_tier, t.monthly_cost, t.renewal_date::text renewal_date, t.notes,
           s.full_name billing_owner,
           (select count(*) from public.tool_user u where u.tool_id = t.id)::int users
      from public.tool t left join public.staff s on s.id = t.billing_owner_staff_id
     where t.tenant_id = $1 order by t.name`, [req.who.tenantId]);
  res.json({ tools: rows.map(r => Object.assign(r, { monthly_cost: r.monthly_cost === null ? null : Number(r.monthly_cost) })) });
}

function shellRoutes() {
  const r = express.Router();
  const wrap = fn => (req, res) => Promise.resolve(fn(req, res)).catch(e => {
    console.error('[shell]', e.message);
    if (!res.headersSent) res.status(e.code === '42501' ? 403 : 500).json({ error: e.code === '42501' ? 'Your access does not include this.' : e.message });
  });
  r.get('/team', wrap(team));
  r.get('/departments', wrap(departments));
  r.get('/tools', wrap(tools));
  return r;
}

module.exports = { shellRoutes };
