// ===========================================================================
// portal-api.js — the portal's read layer.
//
//   GET /api/portal/:section?brand=<slug>
//
// Runs the statements in portal-queries.js against the shared pg pool and
// returns { ok, section, brand, asOf, data:{...}, empty:[...] }.
//
// Design rules:
//   * If the pool is not configured the response is 503 with a reason. It is
//     never a fallback payload. A dashboard that invents numbers when the
//     database is unreachable is worse than one that says it is unreachable.
//   * `empty` lists the result sets that came back with zero rows, so the
//     browser can render a real empty state instead of a blank card.
//   * NULLs are passed through untouched. The browser decides how to show
//     "not reported" versus "zero"; the API never guesses.
// ===========================================================================
const db = require('./supabase-db');
const { Q, COMPANY } = require('./portal-queries');

const CACHE_MS = Number(process.env.PORTAL_CACHE_MS || 20000);
const cache = new Map();

function cacheKey(section, brand) { return section + '|' + (brand || 'all'); }

function readCache(k) {
  const hit = cache.get(k);
  if (hit && Date.now() - hit.t < CACHE_MS) return hit.v;
  return null;
}

async function runSection(section, brand) {
  // Brand-specific summaries fall back to the generic section of the same name.
  const key = Q[`${section}:${brand}`] ? `${section}:${brand}` : section;
  const build = Q[key];
  if (!build) return { status: 404, body: { ok: false, error: `Unknown section "${section}"` } };

  const companyId = brand && brand !== 'all' ? COMPANY[brand] || null : null;
  const spec = build({ brand, companyId });

  const data = {};
  const empty = [];
  const timings = {};

  await Promise.all(Object.entries(spec).map(async ([name, def]) => {
    const t0 = Date.now();
    const res = await db.q(def.sql, def.params || []);
    timings[name] = Date.now() - t0;
    if (def.one) {
      data[name] = res.rows[0] || null;
    } else {
      data[name] = res.rows;
      if (!res.rows.length) empty.push(name);
    }
  }));

  return {
    status: 200,
    body: {
      ok: true, section: key, brand: brand || 'all',
      asOf: new Date().toISOString(),
      data, empty, timings,
    },
  };
}

function mount(app) {
  app.get('/api/portal/:section', async (req, res) => {
    const { section } = req.params;
    const brand = (req.query.brand || '').toLowerCase() || null;

    if (!db.enabled) {
      return res.status(503).json({
        ok: false,
        error: 'database_not_configured',
        detail: 'Set DATA_SOURCE=supabase and SUPABASE_DB_URL. The portal shows no figures without a live connection.',
      });
    }

    const k = cacheKey(section, brand);
    const hit = readCache(k);
    if (hit) return res.json({ ...hit, cached: true });

    try {
      const { status, body } = await runSection(section, brand);
      if (status === 200) cache.set(k, body);
      res.status(status).json(body);
    } catch (e) {
      console.error(`portal/${section} failed:`, e.message);
      res.status(500).json({ ok: false, error: 'query_failed', detail: e.message, section });
    }
  });

  // Config the browser is allowed to know. Keeps keys out of the HTML.
  app.get('/api/portal-config', (_req, res) => {
    res.json({
      dbConfigured: db.enabled,
      companies: COMPANY,
      cacheMs: CACHE_MS,
      // Publishable key only, and only if the deployment sets it. Never the service role.
      supabaseUrl: process.env.SUPABASE_URL || null,
      supabaseAnonKey: process.env.SUPABASE_ANON_KEY || null,
    });
  });

  app.post('/api/portal/_flush', (_req, res) => { cache.clear(); res.json({ ok: true }); });
}

module.exports = { mount, runSection };
