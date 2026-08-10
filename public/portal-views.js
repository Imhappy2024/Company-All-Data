/* =========================================================================
   portal-views.js — the portal's screens.
   Loaded by portal.html, which defines the formatters and components.
   Every view is async and renders from /api/portal/*.
   ========================================================================= */

/* ---------- embed host: keep-alive iframes into /ops ---------- */
const EMBEDS = {};
function embed(key, src) {
  const host = document.getElementById('embedHost');
  let f = EMBEDS[key];
  if (!f) {
    f = document.createElement('iframe');
    f.src = src; f.title = key;
    EMBEDS[key] = f; host.appendChild(f);
  }
  Object.values(EMBEDS).forEach(x => x.classList.toggle('on', x === f));
  host.classList.add('on');
}
function noEmbed() {
  document.getElementById('embedHost').classList.remove('on');
  Object.values(EMBEDS).forEach(x => x.classList.remove('on'));
}
const opsTheme = () => (document.documentElement.dataset.theme === 'dark' ? '&theme=dark' : '&theme=light');

/* Names for a grouped alert: unique, real names only, capped with a count. */
function nameList(names) {
  const u = [...new Set(names.filter(n => n && n !== '(unassigned)'))];
  if (!u.length) return 'none of these have collateral assigned';
  return u.slice(0, 3).join(' · ') + (u.length > 3 ? ` and ${u.length - 3} more` : '');
}

/* ---------- views ---------- */
const V = {};

/* ============================ OVERVIEW ============================ */
V.overview = async () => {
  if (state.brand === 'leavenwealth') return lwOverview();
  if (state.brand === 'leadli') return leadliOverview();
  if (state.brand === 'folio') return folioOverview();
  if (state.brand === 'liquid') return liquidOverview();
  return groupOverview();
};

async function lwOverview() {
  const [s, l, ins] = await Promise.all([api('summary'), api('loans'), api('insurance')]);
  const t = s.data.totals, c = s.data.coverage;
  const loans = l.data.rows, ladder = l.data.ladder;
  const past = loans.filter(x => x.days_to_maturity != null && x.days_to_maturity < 0 && x.status !== 'closed');
  const soon = loans.filter(x => x.days_to_maturity != null && x.days_to_maturity >= 0 && x.days_to_maturity <= 180 && x.status !== 'closed');
  const lapsed = ins.data.lapsed, upcoming = ins.data.upcoming.filter(r => r.days <= 60);

  const alerts = [];
  if (past.length) alerts.push({ sev: 'crit', t: `${past.length} loan${past.length > 1 ? 's are' : ' is'} past the maturity date on file`,
    s: nameList(past.map(x => x.property_name)),
    v: m$(past.reduce((a, x) => a + (N(x.current_balance) || 0), 0)), m: 'balance on file', go: 'loans' });
  if (lapsed.length) alerts.push({ sev: 'crit', t: `${c.policies_past_renewal} insurance policies have a renewal date in the past`,
    s: 'Either the cover lapsed or the renewal was never written back to the record',
    v: m$(lapsed.reduce((a, x) => a + (N(x.premium) || 0), 0)), m: 'premium affected', go: 'insurance' });
  if (soon.length) alerts.push({ sev: 'warn', t: `${soon.length} loan${soon.length > 1 ? 's mature' : ' matures'} inside 180 days`,
    s: nameList(soon.map(x => x.property_name)),
    v: m$(soon.reduce((a, x) => a + (N(x.current_balance) || 0), 0)), m: 'balance on file', go: 'loans' });
  if (upcoming.length) alerts.push({ sev: 'warn', t: `${upcoming.length} insurance renewals fall due inside 60 days`,
    s: nameList(upcoming.map(x => x.property)),
    v: m$(upcoming.reduce((a, x) => a + (N(x.premium) || 0), 0)), m: 'premium on file', go: 'insurance' });
  if (c.loans_with_balance < c.loans_total) alerts.push({ sev: 'warn', t: 'Debt balances are stale or missing',
    s: `${c.loans_total - c.loans_with_balance} of ${c.loans_total} loans carry no current balance; the newest balance on file is dated ${dt(c.balance_as_of)}`,
    v: `${c.loans_with_balance} / ${c.loans_total}`, m: 'coverage', go: 'loans' });

  const attn = alerts.map(a => `<button class="att" data-go="${a.go}">
      <span class="att-ic ${a.sev}">${ic(a.sev === 'crit' ? 'alert' : 'clock', 14)}</span>
      <span class="att-t"><b>${esc(a.t)}</b><span>${esc(a.s)}</span></span>
      <span class="att-v"><b class="num">${a.v}</b><span>${esc(a.m)}</span></span></button>`).join('');

  const debtOnFile = loans.reduce((a, x) => a + (N(x.current_balance) || 0), 0);
  const occ = t.units_with_occupancy;

  setTimeout(() => stackedBars(document.getElementById('ch-ladder'),
    ladder.map(r => ({ ...r, note: `${r.loans} loan${r.loans > 1 ? 's' : ''} · ${r.from_balance} from a recorded balance, ${r.from_estimate} estimated` })),
    [{ key: 'fixed', label: 'Fixed rate', color: 'var(--s1)' },
     { key: 'variable', label: 'Variable rate', color: 'var(--s2)' },
     { key: 'unclassified', label: 'Rate type not recorded', color: 'var(--ink-3)' }],
    { aria: 'Debt maturity ladder' }), 0);

  return `
  <div class="page-head"><h1>Portfolio overview</h1>
    <p>Everything that needs a decision, then the position behind it. Every figure below is read live from Supabase.</p></div>

  ${alerts.length ? panel('Needs attention', `${alerts.length} open items, grouped and ranked by how urgently they need a decision`,
      `<div class="attlist">${attn}</div>`,
      { flush: true, foot: prov('Thresholds: maturity 180 days · renewal 60 days. Related rows are collapsed into one item so a single systemic issue does not fill the panel.') })
    : panel('Needs attention', '', empty('Nothing outstanding', 'No maturities, lapsed policies or coverage gaps inside their alert windows.'), { flush: true })}

  <div class="grid g4 mt">
    ${kpi({ label: 'Debt outstanding', value: m$(debtOnFile), sub: `${c.loans_with_balance} of ${c.loans_total} loans have a balance`,
      help: 'Sum of the most recent recorded balance per loan. Loans with no balance record are excluded rather than counted as zero.' })}
    ${kpi({ label: 'NOI (marked assets)', value: m$(t.noi), sub: `${c.properties_with_financials} of ${c.properties_total} properties · ${dtY(c.financials_as_of)}`,
      delta: `<span class="delta flat">${pct((N(t.noi) || 0) / (N(t.egi) || 1), 0)} of EGI</span>`,
      help: 'Only properties with a property_financials row contribute. All are dated 2025-09-30.' })}
    ${kpi({ label: 'Units reported', value: n0(t.units_reported), sub: `${n0(t.properties)} properties · ${n0(t.buildings)} building records`,
      help: 'property.unit_count_reported. The unit table holds building records, not apartments.' })}
    ${kpi({ label: 'Insured value (TIV)', value: m$(t.tiv), sub: `${m$(t.premium)} annual premium on ${c.policies_with_premium} policies` })}
  </div>

  <div class="grid g23 mt">
    ${panel('Debt maturity ladder', 'Exposure by maturity year, split by how the coupon behaves',
      legend([{ color: 'var(--s1)', label: 'Fixed rate' }, { color: 'var(--s2)', label: 'Variable rate' }, { color: 'var(--ink-3)', label: 'Not recorded' }])
      + `<div class="chart" id="ch-ladder" style="min-height:240px"></div>`,
      { foot: prov(`Exposure = recorded balance where present, else the original loan amount, else the balloon. ${c.loans_without_maturity} loans carry no maturity date and are excluded.`) })}
    ${panel('Debt by lender', 'Where the balance sits, by counterparty',
      bars(l.data.lenders.filter(x => N(x.balance)).slice(0, 8).map(x => ({ k: x.lender, v: x.balance }))),
      { foot: prov(`${l.data.lenders.filter(x => x.lender !== '(not recorded)').length} named lenders on record.`) })}
  </div>

  <div class="grid g2 mt">
    ${panel('Cash and accounts', 'Latest recorded balance per account',
      table('t-acct', [
        { k: 'name', t: 'Account', f: r => `<b>${esc(r.name)}</b><div style="font-size:11px;color:var(--ink-3)">${esc(r.institution || '')}</div>` },
        { k: 'account_type', t: 'Type', f: r => `<span class="badge mute">${esc(String(r.account_type || '—').replace(/_/g, ' '))}</span>` },
        { k: 'balance', t: 'Balance', r: 1, f: r => money(r.balance, 2) },
        { k: 'as_of_date', t: 'As of', r: 1, f: r => dtY(r.as_of_date), sv: r => r.as_of_date ? new Date(r.as_of_date).getTime() : null }
      ], s.data.accounts, { sortK: 'balance', sortDir: 'desc',
        emptyTitle: 'No account balances recorded', emptyBody: 'The <code>account_balance</code> table is empty.',
        totals: rows => ({ name: `${rows.length} accounts`, balance: money(rows.reduce((a, r) => a + (N(r.balance) || 0), 0), 2) }) }),
      { flush: true, foot: prov('One row includes a credit-card balance, which is a liability. The total is a net position, not cash on hand.') })}
    ${panel('Investors', 'Recorded stakes',
      table('t-inv', [
        { k: 'name', t: 'Investor', f: r => `<b>${esc(r.name)}</b>` },
        { k: 'positions', t: 'Position', f: r => r.positions ? esc(r.positions) : NIL },
        { k: 'top_stake_pct', t: 'Stake', r: 1, f: r => pctRaw(r.top_stake_pct, 0) }
      ], s.data.investors, { sortK: 'top_stake_pct', sortDir: 'desc',
        emptyTitle: 'No investors recorded', emptyBody: 'The <code>investor</code> table is empty.' }),
      { flush: true, foot: `<span class="badge warn">${ic('alert', 11)}No capital account</span> ${prov('Stakes are recorded, but contributions, distributions and capital balances have no table. An investor cannot yet be shown their own position.')}` })}
  </div>

  ${occ === 0 ? `<div class="mt"><div class="note">${ic('alert', 15)}<div><b>Occupancy is not tracked.</b>
    <code>unit.occupancy</code> is a free-text column and is empty on all ${n0(t.buildings)} rows, and there is no lease or tenant table.
    Physical occupancy, economic occupancy, WALT and lease expiry cannot be derived from this database today.</div></div></div>` : ''}

  <div class="mt">${coverageNote(c)}</div>`;
}

async function leadliOverview() {
  const [m, ld, ap] = await Promise.all([api('marketing'), api('leads'), api('appointments')]);
  const pv = m.data.provenance;
  const live = m.data.daily.filter(r => r.period_date >= '2026-07-20');
  const spend = live.reduce((a, r) => a + (N(r.amount_spent) || 0), 0);
  const leads = live.reduce((a, r) => a + (N(r.leads) || 0), 0);
  const rows = [...live].reverse().map(r => ({ ...r, label: dtY(r.period_date) }));
  setTimeout(() => {
    lineChart(document.getElementById('ch-spend'), rows, [{ key: 'amount_spent', label: 'Spend', color: 'var(--s1)', fmt: v => money(v, 2) }],
      { h: 190, xfmt: r => dtY(r.period_date) });
    lineChart(document.getElementById('ch-leads'), rows, [{ key: 'leads', label: 'Leads', color: 'var(--s3)', fmt: v => n0(v) }],
      { h: 190, xfmt: r => dtY(r.period_date), fmtAxis: v => String(Math.round(v)) });
  }, 0);
  return `
  <div class="page-head"><h1>Leadli AI</h1><p>Paid acquisition and pipeline, read live from <code>leadli_marketing_daily</code>, <code>lead</code> and <code>appointment</code>.</p></div>
  <div class="grid g4">
    ${kpi({ label: 'Spend (live feed)', value: money(spend, 2), sub: `${live.length} days from ${dtY('2026-07-20')}`, help: 'Rows before 20 Jul 2026 came from a seeding migration and are excluded.' })}
    ${kpi({ label: 'Leads (same period)', value: n0(leads) })}
    ${kpi({ label: 'Cost per lead', value: leads ? money(spend / leads, 2) : NIL, sub: 'blended over the live period' })}
    ${kpi({ label: 'Lead records', value: n0(ld.data.rows.length), sub: `${ap.data.rows.length} appointments` })}
  </div>
  <div class="mt">${panel('Daily spend and leads', 'Two measures, two panels. Never two y-axes on one chart.',
    `<div class="grid g2"><div>${legend([{ color: 'var(--s1)', label: 'Spend' }])}<div class="chart" id="ch-spend" style="min-height:190px"></div></div>
     <div>${legend([{ color: 'var(--s3)', label: 'Leads' }])}<div class="chart" id="ch-leads" style="min-height:190px"></div></div></div>`,
    { foot: prov(`Feed runs ${dtY(pv.first_date)} to ${dtY(pv.last_date)}. ${pv.rows_with_bookings === 0 ? 'Bookings and applications are null on every row, so cost-per-booking cannot be computed.' : ''}`) })}</div>
  <div class="grid g2 mt">
    ${panel('Pipeline by stage', 'Across all lead records',
      bars(ld.data.by_stage.map(r => ({ k: r.stage, v: r.leads, disp: String(r.leads) }))),
      { foot: prov(`${(ld.data.by_stage.find(r => r.stage === '(no stage)') || {}).leads || 0} leads have no pipeline stage set.`) })}
    ${panel('Lead source', 'By recorded provider',
      bars(ld.data.by_provider.map(r => ({ k: r.provider, v: r.leads, disp: `${r.leads}${r.clients ? ` · ${r.clients} client${r.clients > 1 ? 's' : ''}` : ''}` }))),
      { foot: prov('Providers come from lead_provider; "(none)" means provider_id is null.') })}
  </div>
  ${pv.daily_unattributed ? `<div class="mt"><div class="note">${ic('alert', 15)}<div><b>${pv.daily_unattributed} of ${pv.daily_rows} marketing rows have no company_id</b>
    (and ${pv.insight_unattributed} of ${pv.insight_rows} raw Meta rows). Those rows cannot be scoped to a brand by row-level security,
    and a per-brand rollup will under-report until the n8n workflow sets company_id on every write.</div></div></div>` : ''}`;
}

async function folioOverview() {
  const sub = await api('subscriptions');
  const cl = sub.data.clients, pl = sub.data.plans;
  const mrr = cl.filter(c => c.status === 'active').reduce((a, c) => a + (N(c.subscription_amount) || 0), 0);
  return `
  <div class="page-head"><h1>Folio Excel</h1><p>Bookkeeping SaaS. Reads <code>subscription_client</code> and <code>subscription_plan</code>.</p></div>
  ${!cl.length && !pl.length
    ? panel('Nothing to report yet', '', empty('No subscription data',
        'Both <code>subscription_client</code> and <code>subscription_plan</code> are empty. Once plans and clients exist, MRR, unit counts and payment status appear here. No placeholder figures are shown in the meantime.'), { flush: true })
    : `<div class="grid g4">
        ${kpi({ label: 'MRR', value: money(mrr), sub: `${cl.filter(c => c.status === 'active').length} active clients` })}
        ${kpi({ label: 'Clients', value: n0(cl.length) })}
        ${kpi({ label: 'Units billed', value: n0(cl.reduce((a, c) => a + (N(c.number_of_units) || 0), 0)) })}
        ${kpi({ label: 'Plans', value: n0(pl.length) })}
      </div>`}`;
}

async function liquidOverview() {
  const d = await api('lending');
  const sh = d.data.shape;
  return `
  <div class="page-head"><h1>Liquid Lending</h1><p>Private credit. There is no origination-pipeline table in this database yet.</p></div>
  <div class="grid g3">
    ${kpi({ label: 'Loans in the book', value: n0(sh.loans), sub: 'shared with the real-estate portfolio', help: 'The loan table is not split by originating brand.' })}
    ${kpi({ label: 'Borrower leads', value: n0(sh.borrower_leads), sub: 'tagged to Liquid Lending' })}
    ${kpi({ label: 'Deals recorded', value: n0(sh.deals) })}
  </div>
  <div class="mt">${panel('Deal pipeline', 'From the deal table',
    table('t-deal', [
      { k: 'name', t: 'Deal', f: r => `<b>${esc(r.name)}</b>` },
      { k: 'stage', t: 'Stage', f: r => `<span class="badge mute">${esc(String(r.stage || '—').replace(/_/g, ' '))}</span>` },
      { k: 'target_property_name', t: 'Target', f: r => r.target_property_name ? esc(r.target_property_name) : NIL },
      { k: 'offer_price', t: 'Offer', r: 1, f: r => money(r.offer_price) },
      { k: 'close_date', t: 'Close', r: 1, f: r => dtY(r.close_date), sv: r => r.close_date ? new Date(r.close_date).getTime() : null }
    ], d.data.deals, { sortK: 'close_date', sortDir: 'asc', emptyTitle: 'No deals recorded', emptyBody: 'The <code>deal</code> table is empty.' }),
    { flush: true, foot: `<span class="badge warn">${ic('alert', 11)}No application table</span> ${prov('A lending pipeline needs loan applications, underwriting status and borrower documents. None of those tables exist yet.')}` })}</div>`;
}

async function groupOverview() {
  const [s, ld] = await Promise.all([api('summary', 'leavenwealth'), api('leads', 'all')]);
  const t = s.data.totals, c = s.data.coverage;
  return `
  <div class="page-head"><h1>Group overview</h1><p>Across all four brands. Figures come from the same tables each brand view reads.</p></div>
  <div class="grid g4">
    ${kpi({ label: 'Portfolio NOI', value: m$(t.noi), sub: `${c.properties_with_financials} marked assets · ${dtY(c.financials_as_of)}` })}
    ${kpi({ label: 'Debt outstanding', value: m$(t.debt), sub: `${c.loans_with_balance} of ${c.loans_total} loans` })}
    ${kpi({ label: 'Properties', value: n0(t.properties), sub: `${n0(t.units_reported)} units reported` })}
    ${kpi({ label: 'Lead records', value: n0(ld.data.rows.length), sub: 'all brands' })}
  </div>
  <div class="mt">${coverageNote(c)}</div>
  <div class="mt"><div class="note">${ic('info', 15)}<div><b>Group revenue is not shown.</b>
    There is no revenue table. The ledger holds ${'transaction'} rows for a six-week window only, which is not a revenue figure and would be
    misleading presented as one.</div></div></div>`;
}

/* ============================ PROPERTIES ============================ */
V.properties = async () => {
  const p = await api('properties');
  const rows = p.data.rows, c = p.data.coverage;
  const withFin = rows.filter(r => N(r.noi) != null);
  const cols = [
    { k: 'name', t: 'Property', f: r => `<b>${esc(r.name)}</b>` },
    { k: 'pm', t: 'Manager', f: r => r.pm ? esc(r.pm) : NIL },
    { k: 'status', t: 'Status', f: r => r.status ? `<span class="badge mute">${esc(r.status)}</span>` : NIL },
    { k: 'units', t: 'Units', r: 1, f: r => n0(r.units) },
    { k: 'noi', t: 'NOI', r: 1, f: r => money(r.noi), help: 'As of ' + c.financials_as_of },
    { k: 'cap_rate', t: 'Cap', r: 1, f: r => pct(r.cap_rate, 2) },
    { k: 'dcr', t: 'DSCR', r: 1, f: r => r.dcr == null ? NIL : badge(dscrSev(N(r.dcr)), ratio(r.dcr)), help: 'Covenant floor is commonly 1.25x' },
    { k: 'total_ltv', t: 'LTV', r: 1, f: r => r.total_ltv == null ? NIL : badge(ltvSev(N(r.total_ltv)), pct(r.total_ltv, 0)) },
    { k: 'premium', t: 'Premium', r: 1, f: r => money(r.premium) },
    { k: 'next_renewal', t: 'Next renewal', r: 1, f: r => { if (!r.next_renewal) return NIL; const d = daysFrom(r.next_renewal);
        return `${dtY(r.next_renewal)} ${d < 0 ? badge('crit', 'past') : d <= 60 ? badge('warn', d + 'd') : ''}`; },
      sv: r => r.next_renewal ? new Date(r.next_renewal).getTime() : null }
  ];
  return `
  <div class="page-head"><h1>Properties</h1><p>${rows.length} properties. Financial columns are populated for the ${c.properties_with_financials} with a snapshot on file. Click a row for the full record.</p></div>
  <div class="grid g4">
    ${kpi({ label: 'Properties', value: n0(rows.length), sub: `${n0(rows.reduce((a, r) => a + (N(r.buildings) || 0), 0))} building records`, sm: 1 })}
    ${kpi({ label: 'Units reported', value: n0(rows.reduce((a, r) => a + (N(r.units) || 0), 0)), sub: `${c.properties_without_unit_count} properties have no count`, sm: 1 })}
    ${kpi({ label: 'NOI on file', value: m$(withFin.reduce((a, r) => a + N(r.noi), 0)), sub: `${withFin.length} assets · ${dtY(c.financials_as_of)}`, sm: 1 })}
    ${kpi({ label: 'Annual premium', value: m$(rows.reduce((a, r) => a + (N(r.premium) || 0), 0)), sub: 'where recorded', sm: 1 })}
  </div>
  <div class="mt">${panel('Property schedule', 'Click a column header to sort. Numeric columns are right-aligned and tabular so they compare down the column.',
    table('t-prop', cols, rows, { sortK: 'noi', sortDir: 'desc', onRow: openProperty,
      emptyTitle: 'No properties', emptyBody: 'The <code>property</code> table is empty.',
      totals: r => ({ name: `${r.length} properties`, units: n0(r.reduce((a, x) => a + (N(x.units) || 0), 0)),
        noi: money(r.reduce((a, x) => a + (N(x.noi) || 0), 0)), premium: money(r.reduce((a, x) => a + (N(x.premium) || 0), 0)) }) }),
    { flush: true, actions: `<a class="ctl" href="/ops#tab=properties" target="_blank">Open the ops editor</a>` })}</div>
  <div class="mt">${coverageNote(c)}</div>`;
};

/* ============================ DEBT ============================ */
V.loans = async () => {
  const l = await api('loans');
  const rows = l.data.rows, c = l.data.coverage, ladder = l.data.ladder;
  const withBal = rows.filter(r => N(r.current_balance) != null);
  const total = withBal.reduce((a, r) => a + N(r.current_balance), 0);
  const variable = withBal.filter(r => r.loan_type === 'variable');
  const rated = withBal.filter(r => N(r.interest_rate_pct) != null);
  const wavg = rated.length ? rated.reduce((a, r) => a + N(r.interest_rate_pct) * N(r.current_balance), 0) / rated.reduce((a, r) => a + N(r.current_balance), 0) : null;
  const past = rows.filter(r => N(r.days_to_maturity) < 0 && r.status !== 'closed');

  setTimeout(() => stackedBars(document.getElementById('ch-ladder2'),
    ladder.map(r => ({ ...r, note: `${r.loans} loans · ${r.from_balance} from a recorded balance, ${r.from_estimate} estimated` })),
    [{ key: 'fixed', label: 'Fixed rate', color: 'var(--s1)' },
     { key: 'variable', label: 'Variable rate', color: 'var(--s2)' },
     { key: 'unclassified', label: 'Not recorded', color: 'var(--ink-3)' }], { h: 250 }), 0);

  const cols = [
    { k: 'property_name', t: 'Collateral', f: r => r.property_name && r.property_name !== '(unassigned)' ? `<b>${esc(r.property_name)}</b>` : `<span class="nil">Unassigned</span>` },
    { k: 'lender', t: 'Lender', f: r => r.lender ? esc(r.lender) : NIL },
    { k: 'position', t: 'Position', f: r => `<span class="badge mute">${esc(String(r.position || '—').replace(/_/g, ' '))}</span>` },
    { k: 'loan_type', t: 'Rate type', f: r => r.loan_type ? esc(r.loan_type) : NIL },
    { k: 'interest_rate_pct', t: 'Rate', r: 1, f: r => pct(r.interest_rate_pct, 2), help: 'Stored as a decimal fraction; shown as a percentage' },
    { k: 'current_balance', t: 'Balance', r: 1, f: r => money(r.current_balance) },
    { k: 'balance_as_of', t: 'As of', r: 1, f: r => dtY(r.balance_as_of), sv: r => r.balance_as_of ? new Date(r.balance_as_of).getTime() : null },
    { k: 'maturity_date', t: 'Maturity', r: 1, f: r => r.maturity_date ? dtY(r.maturity_date) : NA, sv: r => r.maturity_date ? new Date(r.maturity_date).getTime() : null },
    { k: 'days_to_maturity', t: 'Days', r: 1, f: r => { const d = N(r.days_to_maturity); if (d == null) return NA;
        const s = matSev(d); return s ? badge(s, d < 0 ? Math.abs(d) + 'd over' : d + 'd') : `<span class="num">${n0(d)}</span>`; } }
  ];
  return `
  <div class="page-head"><h1>Debt</h1><p>${rows.length} loan records from <code>v_loan_maturities</code>. Rate is stored as a decimal fraction in the database and shown here as a percentage.</p></div>
  <div class="grid g4">
    ${kpi({ label: 'Balance on file', value: m$(total), sub: `${withBal.length} of ${rows.length} loans`, help: 'Loans without a balance record are excluded rather than counted as zero.' })}
    ${kpi({ label: 'Weighted avg rate', value: pct(wavg, 2), sub: 'balance-weighted, where a rate is recorded' })}
    ${kpi({ label: 'Variable-rate exposure', value: m$(variable.reduce((a, r) => a + N(r.current_balance), 0)),
      sub: `${variable.length} loans · ${pct(variable.reduce((a, r) => a + N(r.current_balance), 0) / (total || 1), 0)} of balance` })}
    ${kpi({ label: 'Past maturity', value: n0(past.length), sub: `${m$(past.reduce((a, r) => a + (N(r.current_balance) || 0), 0))} recorded balance`,
      delta: past.length ? `<span class="delta dn">needs action</span>` : '' })}
  </div>
  <div class="grid g23 mt">
    ${panel('Maturity ladder', 'Exposure by maturity window',
      legend([{ color: 'var(--s1)', label: 'Fixed' }, { color: 'var(--s2)', label: 'Variable' }, { color: 'var(--ink-3)', label: 'Not recorded' }])
      + `<div class="chart" id="ch-ladder2" style="min-height:250px"></div>`,
      { foot: prov(`Exposure = recorded balance, else original amount, else balloon. ${c.loans_without_maturity} loans have no maturity date and are excluded.`) })}
    ${panel('Rate-type mix', 'Balance split by how the coupon behaves',
      bars([
        { k: 'Fixed', v: withBal.filter(r => r.loan_type === 'fixed').reduce((a, r) => a + N(r.current_balance), 0), color: 'var(--s1)' },
        { k: 'Variable', v: variable.reduce((a, r) => a + N(r.current_balance), 0), color: 'var(--s2)' },
        { k: 'Not recorded', v: withBal.filter(r => !r.loan_type).reduce((a, r) => a + N(r.current_balance), 0), color: 'var(--ink-3)' }
      ]) + `<div class="hr"></div><p class="sec-t">Largest variable positions</p>`
      + bars(variable.sort((a, b) => N(b.current_balance) - N(a.current_balance)).slice(0, 5)
          .map(r => ({ k: `${r.property_name} · ${r.index || 'index not recorded'}`, v: r.current_balance, color: 'var(--s2)' }))),
      { foot: prov('No loan has a next-reset date on file, so reset risk cannot be dated.') })}
  </div>
  <div class="mt">${panel('Loan schedule', 'Default sort puts the nearest maturity first',
    table('t-loan', cols, rows, { sortK: 'days_to_maturity', sortDir: 'asc', onRow: openLoan,
      emptyTitle: 'No loans', emptyBody: 'The <code>loan</code> table is empty.',
      totals: r => ({ property_name: `${r.length} loans`, current_balance: money(r.reduce((a, x) => a + (N(x.current_balance) || 0), 0)) }) }),
    { flush: true, actions: `<a class="ctl" href="/ops#tab=loanviews" target="_blank">Loan views in ops</a>` })}</div>`;
};

/* ============================ INVESTORS ============================ */
V.investors = async () => {
  const d = await api('investors');
  const ca = d.data.capital_account;
  return `
  <div class="page-head"><h1>Investors</h1><p>Recorded investors and their stakes.</p></div>
  ${panel('Stakes on record', '',
    table('t-inv2', [
      { k: 'name', t: 'Investor', f: r => `<b>${esc(r.name)}</b>` },
      { k: 'email', t: 'Email', f: r => r.email ? esc(r.email) : NIL },
      { k: 'position_in', t: 'Position in', f: r => r.position_in ? esc(r.position_in) : NIL },
      { k: 'stake_pct', t: 'Stake', r: 1, f: r => pctRaw(r.stake_pct, 0) },
      { k: 'is_primary', t: 'Primary', f: r => r.is_primary ? badge('good', 'primary') : `<span class="nil">—</span>` }
    ], d.data.rows, { sortK: 'stake_pct', sortDir: 'desc',
      emptyTitle: 'No investors recorded', emptyBody: 'The <code>investor</code> table is empty.' }), { flush: true })}
  <div class="mt"><div class="note">${ic('alert', 15)}<div><b>This is not an investor portal yet, and should not be shown to investors.</b>
    ${ca.stakes_recorded} stakes are recorded, but there is no capital-account, contribution or distribution table
    (<code>has_capital_account: ${ca.has_capital_account}</code>), and <code>document</code> is empty.
    An investor cannot be shown what they put in, what they have been paid, or what their position is worth. Those tables need to exist first.</div></div></div>`;
};

/* ============================ INSURANCE ============================ */
V.insurance = async () => {
  const d = await api('insurance');
  const c = d.data.coverage, up = d.data.upcoming, lap = d.data.lapsed;
  const in90 = up.filter(r => r.days <= 90);
  return `
  <div class="page-head"><h1>Insurance</h1><p>${c.policies_total} policies. Premium is recorded on ${c.policies_with_premium}; the rest inherit a property-level figure and show as not reported.</p></div>
  <div class="grid g4">
    ${kpi({ label: 'Total insured value', value: m$(d.data.carriers.reduce((a, r) => a + (N(r.tiv) || 0), 0)), sub: `${c.policies_total} policies` })}
    ${kpi({ label: 'Annual premium', value: m$(d.data.carriers.reduce((a, r) => a + (N(r.premium) || 0), 0)), sub: `on ${c.policies_with_premium} policies` })}
    ${kpi({ label: 'Renewing in 90 days', value: m$(in90.reduce((a, r) => a + (N(r.premium) || 0), 0)), sub: `${in90.reduce((a, r) => a + Number(r.policies), 0)} policies`,
      delta: in90.length ? `<span class="delta dn">${ic('clock', 11)} act now</span>` : '' })}
    ${kpi({ label: 'Past renewal date', value: n0(c.policies_past_renewal), sub: `${m$(lap.reduce((a, r) => a + (N(r.premium) || 0), 0))} of premium`,
      delta: `<span class="delta dn">${ic('alert', 11)} verify</span>`,
      help: 'Renewal date is earlier than today: either the policy lapsed or the renewal was never written back.' })}
  </div>
  <div class="grid g2 mt">
    ${panel('Upcoming renewals', 'Soonest first',
      table('t-up', [
        { k: 'property', t: 'Property', f: r => r.property ? `<b>${esc(r.property)}</b>` : NIL },
        { k: 'carrier', t: 'Carrier / broker', f: r => esc(r.carrier || '—') },
        { k: 'policies', t: 'Policies', r: 1, f: r => n0(r.policies) },
        { k: 'premium', t: 'Premium', r: 1, f: r => money(r.premium) },
        { k: 'renewal_date', t: 'Renews', r: 1, f: r => dtY(r.renewal_date), sv: r => new Date(r.renewal_date).getTime() },
        { k: 'days', t: 'In', r: 1, f: r => Number(r.days) <= 30 ? badge('crit', r.days + 'd') : Number(r.days) <= 90 ? badge('warn', r.days + 'd') : `<span class="num">${r.days}d</span>` }
      ], up, { sortK: 'renewal_date', sortDir: 'asc', cap: true, emptyTitle: 'No upcoming renewals', emptyBody: 'No policy has a renewal date in the future.' }), { flush: true })}
    ${panel('Past their renewal date', 'Oldest first — these need verifying before anything else on this page can be trusted',
      table('t-lap', [
        { k: 'property', t: 'Property', f: r => r.property ? `<b>${esc(r.property)}</b>` : NIL },
        { k: 'carrier', t: 'Carrier', f: r => esc(r.carrier || '—') },
        { k: 'policies', t: 'Policies', r: 1, f: r => n0(r.policies) },
        { k: 'renewal_date', t: 'Was due', r: 1, f: r => dtY(r.renewal_date), sv: r => new Date(r.renewal_date).getTime() },
        { k: 'days_overdue', t: 'Overdue', r: 1, f: r => badge('crit', r.days_overdue + 'd') }
      ], lap, { sortK: 'renewal_date', sortDir: 'asc', cap: true, emptyTitle: 'Nothing overdue', emptyBody: 'Every policy has a renewal date in the future.' }), { flush: true })}
  </div>
  <div class="mt">${panel('Carrier concentration', 'Annual premium by carrier, largest first',
    bars([...d.data.carriers].sort((a, b) => (N(b.premium) || 0) - (N(a.premium) || 0)).slice(0, 12)
      .map(r => ({ k: `${r.carrier} · ${r.policies} ${Number(r.policies) === 1 ? 'policy' : 'policies'}`, v: r.premium }))),
    { foot: prov('Carrier strings embed the broker name and are inconsistently formatted in the source data.') })}</div>`;
};

/* ============================ LEADS / APPOINTMENTS ============================ */
V.leads = async () => {
  const d = await api('leads');
  return `
  <div class="page-head"><h1>Leads</h1><p>${d.data.rows.length} lead records${state.brand !== 'all' ? ` scoped to ${BRANDS[state.brand].name}` : ''}.</p></div>
  <div class="grid g2">
    ${panel('By stage', '', bars(d.data.by_stage.map(r => ({ k: r.stage, v: r.leads, disp: String(r.leads) }))), {})}
    ${panel('By provider', '', bars(d.data.by_provider.map(r => ({ k: r.provider, v: r.leads, disp: String(r.leads) }))), {})}
  </div>
  <div class="mt">${panel('Lead records', 'Newest first',
    table('t-lead', [
      { k: 'name', t: 'Name', f: r => `<b>${esc(((r.first_name || '') + ' ' + (r.last_name || '')).trim() || '(no name)')}</b>`, sv: r => (r.first_name || '') + (r.last_name || '') },
      { k: 'email', t: 'Email', f: r => r.email ? esc(r.email) : NIL },
      { k: 'provider', t: 'Provider', f: r => r.provider ? `<span class="badge mute">${esc(r.provider)}</span>` : NIL },
      { k: 'pipeline_stage', t: 'Stage', f: r => r.pipeline_stage ? esc(r.pipeline_stage) : NIL },
      { k: 'is_client', t: 'Client', f: r => r.is_client ? badge('good', 'client') : `<span class="nil">—</span>` },
      { k: 'company', t: 'Brand', f: r => r.company ? esc(r.company) : NIL },
      { k: 'created_at', t: 'Created', r: 1, f: r => dtY(r.created_at), sv: r => new Date(r.created_at).getTime() }
    ], d.data.rows, { sortK: 'created_at', sortDir: 'desc', cap: true,
      emptyTitle: 'No leads', emptyBody: 'No rows in <code>lead</code> for this brand.' }), { flush: true })}</div>`;
};

V.appointments = async () => {
  const d = await api('appointments');
  return `
  <div class="page-head"><h1>Appointments</h1><p>Synced from GoHighLevel into <code>appointment</code>.</p></div>
  ${panel('Booked calls', '',
    table('t-appt', [
      { k: 'lead_name', t: 'Lead', f: r => r.lead_name ? `<b>${esc(r.lead_name)}</b>` : `<span class="nil">(lead has no name on file)</span>` },
      { k: 'calendar_name', t: 'Calendar', f: r => esc(r.calendar_name || '—') },
      { k: 'start_time', t: 'Start', r: 1, f: r => dtTime(r.start_time), sv: r => new Date(r.start_time).getTime() },
      { k: 'status', t: 'Status', f: r => `<span class="badge ${r.status === 'showed' ? 'good' : 'info'}">${esc(r.status || '—')}</span>` },
      { k: 'booked_source', t: 'Source', f: r => r.booked_source ? esc(r.booked_source) : NIL }
    ], d.data.rows, { sortK: 'start_time', sortDir: 'desc',
      emptyTitle: 'No appointments', emptyBody: 'No rows in <code>appointment</code> for this brand.' }), { flush: true })}`;
};

/* ============================ MARKETING ============================ */
V.ads = async () => {
  const m = await api('marketing');
  const pv = m.data.provenance;
  const rows = [...m.data.daily].sort((a, b) => String(a.period_date).localeCompare(String(b.period_date)));
  const live = rows.filter(r => r.period_date >= '2026-07-20');
  const spend = live.reduce((a, r) => a + (N(r.amount_spent) || 0), 0);
  const leads = live.reduce((a, r) => a + (N(r.leads) || 0), 0);
  const imp = live.reduce((a, r) => a + (N(r.impressions) || 0), 0);
  setTimeout(() => {
    lineChart(document.getElementById('ch-mspend'), live, [{ key: 'amount_spent', label: 'Spend', color: 'var(--s1)', fmt: v => money(v, 2) }], { h: 200, xfmt: r => dtY(r.period_date) });
    lineChart(document.getElementById('ch-mleads'), live, [{ key: 'leads', label: 'Leads', color: 'var(--s3)', fmt: v => n0(v) }], { h: 200, xfmt: r => dtY(r.period_date), fmtAxis: v => String(Math.round(v)) });
  }, 0);
  return `
  <div class="page-head"><h1>Marketing</h1><p>Meta Ads, synced by n8n into <code>leadli_marketing_daily</code> and <code>meta_ads_insight</code>.
    Rows before 20 Jul 2026 came from a seeding migration; every figure on this page excludes them.</p></div>
  <div class="grid g4">
    ${kpi({ label: 'Spend (live period)', value: money(spend, 2), sub: `${live.length} days` })}
    ${kpi({ label: 'Leads', value: n0(leads) })}
    ${kpi({ label: 'Cost per lead', value: leads ? money(spend / leads, 2) : NIL, sub: 'blended' })}
    ${kpi({ label: 'Impressions', value: n0(imp) })}
  </div>
  <div class="mt">${panel('Daily spend and leads', 'Two measures, two panels',
    `<div class="grid g2"><div>${legend([{ color: 'var(--s1)', label: 'Spend' }])}<div class="chart" id="ch-mspend" style="min-height:200px"></div></div>
     <div>${legend([{ color: 'var(--s3)', label: 'Leads' }])}<div class="chart" id="ch-mleads" style="min-height:200px"></div></div></div>`,
    { foot: prov(`${pv.daily_rows} daily rows on file, ${dtY(pv.first_date)} to ${dtY(pv.last_date)}.`) })}</div>
  <div class="mt">${panel('What would need fixing before this drives spend decisions', '',
    `<div style="display:flex;flex-direction:column;gap:9px">
      ${pv.daily_unattributed ? `<div class="note">${ic('alert', 15)}<div><b>${pv.daily_unattributed} of ${pv.daily_rows} daily rows have no company_id</b>
        (and ${pv.insight_unattributed} of ${pv.insight_rows} raw Meta rows). Brand-scoped row-level security cannot see them and a per-brand rollup under-reports.</div></div>` : ''}
      ${pv.rows_with_bookings === 0 ? `<div class="note">${ic('alert', 15)}<div><b>No bookings or applications recorded.</b>
        The columns exist in <code>leadli_marketing_daily</code> but every row is null, so cost-per-booking cannot be computed.</div></div>` : ''}
      <div class="note">${ic('info', 15)}<div><b>Two data regimes share one table.</b> Nothing on a row distinguishes seeded from live except the date.
        A <code>source</code> or <code>is_seed</code> flag would stop a future query silently mixing them.</div></div>
    </div>`)}</div>`;
};

/* ============================ SERVICES / SUBSCRIPTIONS ============================ */
V.services = async () => {
  const d = await api('services');
  return `
  <div class="page-head"><h1>Services</h1><p>Leadli AI service catalogue and engaged clients.</p></div>
  <div class="grid g2">
    ${panel('Catalogue', `${d.data.catalogue.length} services`,
      table('t-svc', [
        { k: 'name', t: 'Service', f: r => `<b>${esc(r.name)}</b>` },
        { k: 'category', t: 'Category', f: r => `<span class="badge mute">${esc(r.category || '—')}</span>` },
        { k: 'pricing_model', t: 'Pricing', f: r => esc(String(r.pricing_model || '—').replace(/_/g, ' ')) },
        { k: 'price', t: 'Price', r: 1, f: r => money(r.price) }
      ], d.data.catalogue, { sortK: 'category', emptyTitle: 'No services', emptyBody: '<code>service</code> is empty.' }),
      { flush: true, foot: prov('Every service has a pricing model but no price on file.') })}
    ${panel('Clients', '',
      table('t-svcc', [
        { k: 'name', t: 'Client', f: r => `<b>${esc(r.name)}</b>` },
        { k: 'status', t: 'Status', f: r => `<span class="badge mute">${esc(r.status || '—')}</span>` },
        { k: 'monthly_value', t: 'Monthly', r: 1, f: r => money(r.monthly_value) }
      ], d.data.clients, { sortK: 'monthly_value', sortDir: 'desc',
        emptyTitle: 'No service clients yet', emptyBody: '<code>service_client</code> and <code>service_engagement</code> are both empty, so no revenue can be shown for this brand.' }), { flush: true })}
  </div>`;
};

V.subscriptions = async () => {
  const d = await api('subscriptions');
  return `
  <div class="page-head"><h1>Subscriptions</h1><p>Folio Excel plans and subscribers.</p></div>
  <div class="grid g2">
    ${panel('Plans', '', table('t-plan', [
      { k: 'name', t: 'Plan', f: r => `<b>${esc(r.name)}</b>` },
      { k: 'price', t: 'Price', r: 1, f: r => money(r.price) },
      { k: 'price_per_unit', t: 'Per unit', r: 1, f: r => money(r.price_per_unit, 2) }
    ], d.data.plans, { emptyTitle: 'No plans', emptyBody: '<code>subscription_plan</code> is empty.' }), { flush: true })}
    ${panel('Subscribers', '', table('t-subs', [
      { k: 'name', t: 'Client', f: r => `<b>${esc(r.name)}</b>` },
      { k: 'plan', t: 'Plan', f: r => r.plan ? esc(r.plan) : NIL },
      { k: 'number_of_units', t: 'Units', r: 1, f: r => n0(r.number_of_units) },
      { k: 'subscription_amount', t: 'Amount', r: 1, f: r => money(r.subscription_amount) },
      { k: 'payment_status', t: 'Payment', f: r => r.payment_status ? `<span class="badge mute">${esc(r.payment_status)}</span>` : NIL }
    ], d.data.clients, { emptyTitle: 'No subscribers', emptyBody: '<code>subscription_client</code> is empty.' }), { flush: true })}
  </div>`;
};

V.lending = liquidOverview;

/* ============================ FINANCIALS ============================ */
V.financials = async () => {
  const d = await api('financials');
  const w = d.data.window, acc = d.data.accounts;
  const bank = acc.filter(a => a.account_type !== 'credit_card');
  const cards = acc.filter(a => a.account_type === 'credit_card');
  return `
  <div class="page-head"><h1>Financials</h1><p>Single-entry ledger. Amounts are always positive in the database; direction carries the sign.</p></div>
  <div class="grid g4">
    ${kpi({ label: 'Bank and escrow', value: money(bank.reduce((a, r) => a + (N(r.balance) || 0), 0)), sub: `${bank.length} accounts · ${dtY((acc[0] || {}).as_of_date)}`,
      help: 'Credit-card balances are excluded here because they are a liability, not cash.' })}
    ${kpi({ label: 'Card balance', value: money(Math.abs(cards.reduce((a, r) => a + (N(r.balance) || 0), 0))), sub: `${cards.length} card${cards.length === 1 ? '' : 's'} · owed` })}
    ${kpi({ label: 'Inflow', value: money(w.inflow), sub: `${dtY(w.first_txn)} – ${dtY(w.last_txn)}`, help: 'Only this window exists in the ledger. It is not a revenue figure.' })}
    ${kpi({ label: 'Outflow', value: money(w.outflow), sub: `${w.txns} transactions · ${w.reconciled} reconciled` })}
  </div>
  <div class="grid g23 mt">
    ${panel('Transactions', `${w.txns} rows, newest first`,
      table('t-txn', [
        { k: 'txn_date', t: 'Date', f: r => dtY(r.txn_date), sv: r => new Date(r.txn_date).getTime() },
        { k: 'description', t: 'Description', f: r => esc(r.description || '—') },
        { k: 'category', t: 'Category', f: r => r.category ? `<span class="badge mute">${esc(r.category)}</span>` : NIL },
        { k: 'account', t: 'Account', f: r => r.account ? esc(r.account) : NIL },
        { k: 'amount', t: 'Amount', r: 1, f: r => `<span style="color:${r.direction === 'inflow' ? 'var(--good-ink)' : r.direction === 'outflow' ? 'var(--crit-ink)' : 'var(--ink-2)'}">${r.direction === 'outflow' ? '−' : r.direction === 'inflow' ? '+' : ''}${money(r.amount, 2)}</span>` }
      ], d.data.transactions, { sortK: 'txn_date', sortDir: 'desc', cap: true,
        emptyTitle: 'No transactions', emptyBody: '<code>transaction</code> is empty.' }),
      { flush: true, foot: prov('Direction, not sign, distinguishes inflow from outflow. The database stores every amount as positive.') })}
    ${panel('By category', 'Total moved per category',
      bars(d.data.by_category.map(r => ({ k: `${r.category} · ${r.category_type}`, v: r.amount,
        color: r.category_type === 'income' ? 'var(--s3)' : r.category_type === 'transfer' ? 'var(--ink-3)' : 'var(--s2)' }))),
      { foot: prov('Gross movement, not net. Transfers are shown separately because they are neither income nor expense.') })}
  </div>
  <div class="mt"><div class="note">${ic('info', 15)}<div><b>This is a six-week window, not a P&amp;L.</b>
    The ledger holds ${w.txns} transactions between ${dt(w.first_txn)} and ${dt(w.last_txn)}. There is no revenue table and no period close,
    so nothing here should be read as monthly or annual performance.</div></div></div>`;
};

/* ============================ WORKSPACE ============================ */
V.team = async () => {
  const d = await api('team');
  const people = d.data.rows;
  return `
  <div class="page-head"><h1>Team</h1><p>${people.length} people in <code>staff</code>${state.brand !== 'all' ? `, filtered to ${BRANDS[state.brand].name}` : ''}. Click anyone for their record.</p></div>
  ${people.length ? `<div class="people">${people.map((p, i) => `<button class="person" data-person="${i}">
      ${p.avatar_url ? `<img class="av" src="${esc(p.avatar_url)}" alt="">` : `<span class="av">${esc((p.full_name || '?').split(' ').map(x => x[0]).slice(0, 2).join(''))}</span>`}
      <span><span class="pn">${esc(p.full_name)}</span><span class="pr">${esc(p.title || (p.companies[0] && p.companies[0].role) || p.staff_type || '')}</span></span>
    </button>`).join('')}</div>` : empty('No staff records', 'No rows in <code>staff</code> for this brand.')}
  ${(() => { setTimeout(() => document.querySelectorAll('[data-person]').forEach(b => b.onclick = () => openPerson(people[+b.dataset.person])), 0); return ''; })()}`;
};

V.departments = async () => {
  const d = await api('departments');
  const rows = d.data.rows;
  const top = rows.filter(r => !r.parent_department_id), child = rows.filter(r => r.parent_department_id);
  const cardFor = r => `<div class="deptcard"><h4>${esc(r.name)}</h4>
    <div class="sub">${r.parent_name ? 'under ' + esc(r.parent_name) + ' · ' : ''}${r.members.length} member${r.members.length === 1 ? '' : 's'} · ${r.tools} tool${Number(r.tools) === 1 ? '' : 's'}</div>
    ${r.members.length ? `<div class="chips">${r.members.map(m => `<span class="chip">${esc(m.name)}${m.is_lead ? ' ' + badge('info', 'lead') : ''}</span>`).join('')}</div>`
      : `<div class="prov">${ic('info', 12)}No one is assigned. <code>department_member</code> is empty.</div>`}</div>`;
  return `
  <div class="page-head"><h1>Departments</h1><p>${rows.length} departments. Membership comes from <code>department_member</code>.</p></div>
  ${rows.length ? `<div class="grid g3">${top.map(cardFor).join('')}</div>
     ${child.length ? `<div class="grid g4 mt">${child.map(cardFor).join('')}</div>` : ''}`
    : empty('No departments', '<code>department</code> is empty.')}
  ${rows.every(r => !r.members.length) ? `<div class="mt"><div class="note">${ic('alert', 15)}<div><b>No department has any members.</b>
    <code>department_member</code> has zero rows, so an org chart cannot be drawn from this data. The 14 staff records exist but are not
    connected to a department.</div></div></div>` : ''}`;
};

V.tools = async () => {
  const d = await api('tools');
  return `
  <div class="page-head"><h1>Tools &amp; Apps</h1><p>Software the business runs on, from <code>tool</code>.</p></div>
  ${panel('Software', `${d.data.rows.length} tools`,
    table('t-tool', [
      { k: 'name', t: 'Tool', f: r => `<b>${esc(r.name)}</b>` },
      { k: 'category', t: 'Category', f: r => `<span class="badge mute">${esc(String(r.category || '—').replace(/_/g, ' '))}</span>` },
      { k: 'departments', t: 'Departments', f: r => (r.departments || []).length ? (r.departments || []).map(esc).join(', ') : NIL, sv: r => (r.departments || []).length },
      { k: 'users', t: 'Users', r: 1, f: r => Number(r.users) === 0 ? `<span class="nil" title="tool_user has no rows">0</span>` : n0(r.users) },
      { k: 'plan_tier', t: 'Plan', f: r => r.plan_tier ? esc(r.plan_tier) : NIL },
      { k: 'monthly_cost', t: 'Cost / mo', r: 1, f: r => money(r.monthly_cost) }
    ], d.data.rows, { sortK: 'name', emptyTitle: 'No tools', emptyBody: '<code>tool</code> is empty.',
      totals: r => ({ name: `${r.length} tools`, monthly_cost: money(r.reduce((a, x) => a + (N(x.monthly_cost) || 0), 0)) }) }),
    { flush: true, foot: prov('No tool has a monthly cost or plan tier recorded, so software spend cannot be totalled. tool_user is empty, so per-seat usage is unknown.') })}`;
};

V.documents = async () => {
  const d = await api('documents');
  return `
  <div class="page-head"><h1>Documents</h1><p>Statements, reports and uploads.</p></div>
  ${panel('Document register', '',
    table('t-doc', [
      { k: 'title', t: 'Title', f: r => `<b>${esc(r.title)}</b>` },
      { k: 'doc_type', t: 'Type', f: r => r.doc_type ? esc(r.doc_type) : NIL },
      { k: 'visibility', t: 'Visibility', f: r => `<span class="badge ${r.visibility === 'external' ? 'info' : 'mute'}">${esc(r.visibility || '—')}</span>` },
      { k: 'property', t: 'Attached to', f: r => esc(r.property || r.entity || r.vendor || '—') },
      { k: 'created_at', t: 'Added', r: 1, f: r => dtY(r.created_at), sv: r => new Date(r.created_at).getTime() }
    ], d.data.rows, { sortK: 'created_at', sortDir: 'desc',
      emptyTitle: 'No documents yet',
      emptyBody: 'The <code>document</code> table has zero rows and no Supabase Storage bucket is configured. Until documents are uploaded and marked <em>external</em>, there is nothing to show investors or lenders here.' }),
    { flush: true })}`;
};

/* Tasks stays on the ops dashboard: it owns the live ClickUp two-way sync. */
V.tasks = async () => {
  const spaces = BRAND_SPACES[state.brand] || [];
  const tabs = [['overview', 'Overview'], ['all', 'Tasks']];
  if (state.brand === 'leavenwealth') tabs.push(['ptasks', 'Property tasks']);
  const tab = tabs.some(t => t[0] === state.tasksTab) ? state.tasksTab : 'overview';
  const seg = `<div class="seg">${tabs.map(([id, l]) => `<button class="${tab === id ? 'on' : ''}" data-tasktab="${id}">${l}</button>`).join('')}</div>`;
  setTimeout(() => document.querySelectorAll('[data-tasktab]').forEach(b => b.onclick = () => { state.tasksTab = b.dataset.tasktab; render(); }), 0);
  const sp = spaces.length ? '&spaces=' + spaces.join(',') : '';
  if (tab === 'ptasks') { embed('ptasks', `/ops#tab=properties&sub=tasks&embed=1&bare=1${opsTheme()}`); return seg; }
  if (spaces.length || state.brand === 'leavenwealth' || state.brand === 'all') {
    embed('ops-' + tab, `/ops#tab=${tab === 'all' ? 'alltasks' : 'overview'}&embed=1${sp}${opsTheme()}`);
    return seg;
  }
  return seg + empty('No ClickUp space for this brand', `${esc(BRANDS[state.brand].name)} has no ClickUp space mapped yet, so there are no tasks to show.`);
};

/* ---------- drawers ---------- */
function drawer(title, sub, body) {
  document.getElementById('drawer').innerHTML = `
    <div class="dr-h"><div style="flex:1;min-width:0"><h3>${esc(title)}</h3><p>${sub}</p></div>
      <button class="icon-btn" data-close aria-label="Close">${ic('x', 15)}</button></div>
    <div class="dr-b">${body}</div>`;
  document.getElementById('drawer').classList.add('on');
  document.getElementById('scrim').classList.add('on');
  const b = document.querySelector('[data-close]'); if (b) b.focus();
}
function closeDrawer() {
  document.getElementById('drawer').classList.remove('on');
  document.getElementById('scrim').classList.remove('on');
}
function openProperty(p) {
  drawer(p.name, `${esc(p.entity || '')}${p.city ? ' · ' + esc(p.city) + ', ' + esc(p.state || '') : ''}`, `
    <p class="sec-t">Identification</p>
    <dl class="dl">
      <dt>Owning entity</dt><dd>${p.entity ? esc(p.entity) : NIL}</dd>
      <dt>Address</dt><dd style="max-width:230px">${p.street ? esc(p.street) : NIL}</dd>
      <dt>Manager</dt><dd>${p.pm ? esc(p.pm) : NIL}</dd>
      <dt>Asset type</dt><dd>${p.asset_type ? esc(p.asset_type) : NIL}</dd>
      <dt>Status</dt><dd>${p.status ? esc(p.status) : NIL}</dd>
      <dt>Year acquired</dt><dd>${p.year_acquired ? esc(p.year_acquired) : NIL}</dd>
      <dt>Units reported</dt><dd>${n0(p.units)}</dd>
      <dt>Building records</dt><dd>${n0(p.buildings)}</dd>
      <dt>Purchase price</dt><dd>${money(p.purchase_price)}</dd>
    </dl>
    <p class="sec-t">Financials${p.as_of_date ? ' · as of ' + dt(p.as_of_date) : ''}</p>
    ${N(p.noi) == null ? `<div class="note">${ic('info', 15)}<div>No financial snapshot on file for this property.</div></div>` : `
    <dl class="dl">
      <dt>Effective gross income</dt><dd>${money(p.egi)}</dd>
      <dt>Operating expenses</dt><dd>${money(p.opex)}</dd>
      <dt>Net operating income</dt><dd><b>${money(p.noi)}</b></dd>
      <dt>Marked value</dt><dd>${money(p.marked_value)}</dd>
      <dt>Cap rate</dt><dd>${pct(p.cap_rate, 2)}</dd>
      <dt>DSCR</dt><dd>${p.dcr == null ? NIL : badge(dscrSev(N(p.dcr)), ratio(p.dcr))}</dd>
      <dt>LTV</dt><dd>${p.total_ltv == null ? NIL : badge(ltvSev(N(p.total_ltv)), pct(p.total_ltv, 1))}</dd>
      <dt>Equity</dt><dd>${money(p.property_equity)}</dd>
    </dl>`}
    <p class="sec-t">Insurance</p>
    <dl class="dl">
      <dt>Policies</dt><dd>${n0(p.policies)}</dd>
      <dt>Annual premium</dt><dd>${money(p.premium)}</dd>
      <dt>Insured value</dt><dd>${money(p.tiv)}</dd>
      <dt>Next renewal</dt><dd>${p.next_renewal ? dt(p.next_renewal) + (daysFrom(p.next_renewal) < 0 ? ' ' + badge('crit', 'past') : '') : NIL}</dd>
    </dl>`);
}
function openLoan(l) {
  drawer(l.property_name && l.property_name !== '(unassigned)' ? l.property_name : 'Unassigned loan',
    `${esc(l.lender || 'Lender not recorded')} · ${esc(String(l.position || '').replace(/_/g, ' '))}`, `
    <p class="sec-t">Terms</p>
    <dl class="dl">
      <dt>Loan number</dt><dd>${l.loan_number ? esc(l.loan_number) : NIL}</dd>
      <dt>Purpose</dt><dd>${l.purpose ? esc(String(l.purpose).replace(/_/g, ' ')) : NIL}</dd>
      <dt>Rate type</dt><dd>${l.loan_type ? esc(l.loan_type) : NIL}</dd>
      <dt>Rate</dt><dd>${pct(l.interest_rate_pct, 3)}</dd>
      <dt>Index</dt><dd style="max-width:230px">${l.index ? esc(l.index) : NA}</dd>
      <dt>Originated</dt><dd>${dtY(l.origination_date)}</dd>
      <dt>Original amount</dt><dd>${money(l.origination_amount)}</dd>
      <dt>Matures</dt><dd>${l.maturity_date ? dt(l.maturity_date) : NA}</dd>
      <dt>Balloon</dt><dd>${money(l.balloon_payment)}</dd>
      <dt>Extension available</dt><dd>${l.extension_available == null ? NIL : (l.extension_available ? 'Yes' : 'No')}</dd>
    </dl>
    <p class="sec-t">Position</p>
    <dl class="dl">
      <dt>Current balance</dt><dd><b>${money(l.current_balance)}</b></dd>
      <dt>Balance as of</dt><dd>${dtY(l.balance_as_of)}</dd>
      <dt>Status flag</dt><dd>${esc(l.status || '—')}</dd>
      <dt>Days to maturity</dt><dd>${N(l.days_to_maturity) == null ? NA : (matSev(N(l.days_to_maturity)) ? badge(matSev(N(l.days_to_maturity)), N(l.days_to_maturity) < 0 ? Math.abs(l.days_to_maturity) + 'd past' : l.days_to_maturity + 'd') : n0(l.days_to_maturity))}</dd>
    </dl>
    ${l.status === 'none' ? `<div class="note">${ic('info', 15)}<div><b>Status is <code>none</code>.</b> Most loans carry the default status,
      so the field cannot be read as "inactive". Maturity date and balance are the reliable signals.</div></div>` : ''}`);
}
function openPerson(p) {
  drawer(p.full_name, esc(p.title || p.staff_type || ''), `
    <dl class="dl">
      <dt>Email</dt><dd>${p.email ? esc(p.email) : NIL}</dd>
      <dt>Phone</dt><dd>${p.phone ? esc(p.phone) : NIL}</dd>
      <dt>Type</dt><dd>${esc(p.staff_type || '—')}</dd>
      <dt>Active</dt><dd>${p.is_active ? 'Yes' : 'No'}</dd>
    </dl>
    <p class="sec-t">Companies</p>
    ${(p.companies || []).length ? (p.companies || []).map(c => `<div class="note" style="margin-bottom:7px">${ic('bldg', 15)}<div>
        <b>${esc(c.company)}</b>${c.role ? ' · ' + esc(c.role) : ''}${c.is_primary ? ' ' + badge('info', 'primary') : ''}
        ${c.work_email ? `<br>${esc(c.work_email)}` : ''}</div></div>`).join('')
      : `<div class="note">${ic('info', 15)}<div>No <code>staff_company</code> row, so this person is not mapped to a brand.</div></div>`}
    ${p.description ? `<p class="sec-t">About</p><p style="font-size:12.5px;color:var(--ink-2)">${esc(p.description)}</p>` : ''}`);
}

/* ---------- shell ---------- */
function buildNav() {
  const menu = MENUS[state.brand] || MENUS.all;
  document.getElementById('nav').innerHTML = menu.map(it => it.lbl
    ? `<div class="nav-lbl">${esc(it.lbl)}</div>`
    : `<button class="nav-item" data-view="${it.id}" ${state.view === it.id ? 'aria-current="page"' : ''} title="${esc(it.label)}">${ic(it.ic, 15)}<span>${esc(it.label)}</span></button>`).join('');
}
function buildWorkspace() {
  const b = BRANDS[state.brand];
  document.getElementById('wsMark').textContent = b.mark;
  document.getElementById('wsMark').style.background = b.color;
  document.getElementById('wsName').textContent = b.name;
  document.getElementById('wsSub').textContent = b.sub;
  document.getElementById('wsMenu').innerHTML = Object.entries(BRANDS).map(([k, v]) =>
    `<button class="ws-item ${k === state.brand ? 'on' : ''}" data-brand="${k}">
       <span class="ws-dot" style="background:${v.color}">${esc(v.mark)}</span>${esc(v.name)}</button>`).join('');
}
function buildBar() {
  document.getElementById('bar').innerHTML = `
    <span class="meta">${ic('info', 12)} Every figure on this page is read live from Supabase. Nothing is hard-coded.</span>
    <span class="spacer"></span>
    <button class="ctl" id="densityBtn">${state.density === 'compact' ? 'Compact' : 'Comfortable'} rows</button>
    <span class="meta" id="asOf">${ic('clock', 12)} …</span>`;
}

async function render() {
  buildWorkspace(); buildNav(); buildBar();
  document.documentElement.dataset.theme = state.theme;
  document.documentElement.dataset.density = state.density;
  document.getElementById('app').dataset.rail = state.rail;
  document.getElementById('themeBtn').innerHTML = ic(state.theme === 'dark' ? 'sun' : 'moon', 15);
  document.getElementById('crumb').innerHTML = `${esc(BRANDS[state.brand].name)} ${ic('chev', 12)} <b>${esc(TITLES[state.view] || state.view)}</b>`;
  const menu = MENUS[state.brand] || MENUS.all;
  if (!menu.some(i => i.id === state.view)) state.view = 'overview';
  history.replaceState(null, '', `#brand=${state.brand}&view=${state.view}`);

  const view = document.getElementById('view');

  // Properties and Tasks are still served by the ops dashboard, which owns the
  // ClickUp sync and the inline editors. Everything else renders natively.
  if (state.view === 'tasks') { view.innerHTML = await V.tasks(); return; }
  noEmbed();

  const fn = V[state.view];
  if (!fn) { view.innerHTML = empty('Nothing here yet', 'This section has no view.'); return; }
  view.innerHTML = skeleton();
  try {
    view.innerHTML = await fn();
    const a = document.getElementById('asOf');
    if (a) a.innerHTML = `${ic('clock', 12)} Fetched ${new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`;
  } catch (e) {
    view.innerHTML = `<div class="page-head"><h1>${esc(TITLES[state.view] || state.view)}</h1></div>` + errorBlock(e);
  }
}

/* ---------- events ---------- */
document.addEventListener('click', e => {
  const t = e.target.closest('[data-view],[data-brand],[data-go],[data-close]');
  const ws = e.target.closest('#wsBtn');
  const menu = document.getElementById('wsMenu');
  if (ws) { const open = menu.classList.toggle('open'); document.getElementById('wsBtn').setAttribute('aria-expanded', String(open)); return; }
  if (!e.target.closest('#wsMenu')) menu.classList.remove('open');
  if (!t) return;
  if (t.dataset.view) { state.view = t.dataset.view; document.getElementById('scroll').scrollTop = 0; render(); }
  else if (t.dataset.brand) { state.brand = t.dataset.brand; state.view = 'overview'; menu.classList.remove('open'); render(); }
  else if (t.dataset.go) { state.view = t.dataset.go; render(); }
  else if (t.hasAttribute('data-close')) closeDrawer();
});
document.addEventListener('click', e => {
  if (e.target.closest('#densityBtn')) { state.density = state.density === 'compact' ? 'comfortable' : 'compact';
    try { localStorage.setItem('lw-density', state.density); } catch (_) {} render(); }
});
document.getElementById('themeBtn').onclick = () => {
  state.theme = state.theme === 'dark' ? 'light' : 'dark';
  try { localStorage.setItem('lw-theme', state.theme); } catch (_) {}
  Object.values(EMBEDS).forEach(f => { const u = new URL(f.src, location.href);
    u.hash = u.hash.replace(/&theme=(dark|light)/, '') + (state.theme === 'dark' ? '&theme=dark' : '&theme=light'); f.src = u.toString(); });
  render();
};
document.getElementById('railBtn').onclick = () => { state.rail = state.rail ? 0 : 1; render(); };
document.getElementById('scrim').onclick = closeDrawer;
document.getElementById('refreshBtn').onclick = async () => {
  apiCache.clear();
  try { await fetch('/api/portal/_flush', { method: 'POST' }); } catch (_) {}
  render();
};
document.addEventListener('keydown', e => { if (e.key === 'Escape') { closeDrawer(); document.getElementById('wsMenu').classList.remove('open'); } });
let rt; addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(render, 200); });

render();
