// ---------------------------------------------------------------------------
// INERT STUB — two-way ClickUp <-> Supabase task sync.
// The real implementation is not present in this repo. This stub keeps
// server.js bootable and, per CLAUDE.md, stays DISABLED unless a real module
// (plus DATA_SOURCE=supabase + SUPABASE_DB_URL) is supplied. All server routes
// guard on `enabled`, so with enabled=false none of the async methods run.
// Replace this file with the real module to activate the feature.
// ---------------------------------------------------------------------------
module.exports = {
  enabled: false,
  init() { /* no-op: real module wires ClickUp helpers here */ },
  async runSync() {
    throw new Error('Task sync not configured (supabase-sync is a stub).');
  },
  async getBoardPayload() {
    return { statuses: [], tasks: [] };
  },
  async createTaskFromDashboard() {
    throw new Error('Task sync not configured (supabase-sync is a stub).');
  },
};
