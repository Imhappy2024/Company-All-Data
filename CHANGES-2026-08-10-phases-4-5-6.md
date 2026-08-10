# Phases 4, 5 and 6 - what changed

Applied on top of `e14ac72` (Phases 1-3 plus the realtime teardown). Everything
below is already in this tree. Nothing is left to wire.

## New files

| File | What it is |
|---|---|
| `public/portal-auth.js` | ClickUp sign-in state. Captures the `#auth=` fragment, verifies against `/auth/me` in the background, exposes `PortalAuth.fetch()` with a 401 interceptor, renders the sign-in panel. Gates **only** Tasks. |
| `public/portal-tasks.js` | The native per-brand Tasks screen: four counter cards, click-to-swap, filters, chunked table with subtask nesting, inline status / assignee / due edits, comment drawer, optimistic writes. |
| `public/portal-realtime.js` | EventSource client. `TABLE_VIEWS` maps Supabase tables to portal views; only the visible view refetches. |
| `realtime.js` | SSE hub plus `POST /api/hooks/supabase`. Timing-safe secret, fails closed, 300ms coalescing, keepalive, client caps. |
| `migrations/20260810_supabase_webhooks.sql` | pg_net, `webhook_config`, `notify_row_change()`, one statement-level trigger per table. **Not applied.** |
| `test/` | The harness that verifies all of the above. |

## Edited

**`public/portal.html`** - loads the three modules (plain tags, not `defer`,
because the inline script runs during parsing and calls `render()` immediately);
`V.tasks()` renders `#tasksNative` for the `all` tab and that segment is
relabelled **All Tasks**; `isEmbedView()` and `embedInfo()` no longer claim it;
`render()` calls `PortalTasks.render()` after the innerHTML assignment, passing
`spaces` and `brandName` in because `brandSpaces` and `BRANDS` are script-scoped
consts that a separate file cannot read; boot calls `PortalAuth.init()` and
`PortalRealtime.start()`; a quiet `#rtStamp` was added to the topbar.

**`server.js`** - requires and mounts `realtime.js` (after `express.json()`, which
it depends on for `req.body`); adds `safeReturnPath()`; `/auth/clickup` passes a
validated `state`; `/auth/callback` returns the user where they started instead of
always `/ops`; `sb-` guards on both comment routes.

**`data/status-mappings.json`** - `not reporting` and `quarterly recurring` mapped
to Long Term. Both are in live use on the quarterly property lists and in AM
To-Do's, and neither was mapped, so they resolved to To Do through ClickUp's
`status.type = open` and inflated every open figure.

**`.env.example`** - `SUPABASE_WEBHOOK_SECRET` plus the optional `SSE_*` tuning.

**`CLAUDE.md`** - new "Portal Tasks + live sync" section; the stale
Tasks-is-an-iframe paragraph corrected; current state and roadmap refreshed; and a
"Still baked" section naming the wrong Overview KPIs.

## Verified here

```
npm install --no-save express playwright
node test/test-realtime.js    # 20 checks
node test/run-tests.js        # 17 checks
node server.js &
node test/smoke-portal.js     # 14 checks against the real server
```

All 51 pass. Screenshots land in `test/`.

The smoke test is the one that matters. It drives the real Express server and the
real `portal.html`, not the modules in isolation, and proves: the sign-in gate
appears with the sidebar still usable, no iframe mounts for the All Tasks tab any
more, the counters render inside the real shell, there is no space filter on that
screen, the SSE stream actually connects (the server reports a live listener), and
Properties / Loan Views / Executive Board still mount their embeds.

Worth knowing about the counter tests: `test/expected.json` is written by hand
from each fixture's stated intent, not derived from the code under test. If you
change counter logic, update the fixtures and expectations deliberately. Do not
regenerate them from the implementation, or the tests lose the ability to fail.

## Not verified here - needs the deploy

The OAuth round trip, live ClickUp writes, the real ~5MB `/api/tasks` payload, and
pg_net actually reaching your Railway URL.

## Order of operations for the realtime migration

1. Deploy with `SUPABASE_WEBHOOK_SECRET` set in Railway.
2. Confirm `GET /api/events/health` reports `secretConfigured: true`.
3. Run `migrations/20260810_supabase_webhooks.sql` in the Supabase SQL editor,
   after working through its "Verify first" block. pg_net is not installed in the
   project yet and the `http_post` signature varies by version.
4. Seed `webhook_config` with the live endpoint and the same secret, from the SQL
   editor. Never commit it.

Any other order leaves every trigger POSTing into a 404.

## One thing to check before the first sign-in

`/auth/debug` on the deployed URL should still report
`computed_redirect_uri = <origin>/auth/callback`. The `state` change affects only
where you land after the callback, not the registered `redirect_uri`, so it should
be unchanged. If it moved, stop and look at it before anyone tries to sign in.

## Still outstanding

`V.overview()` in `public/portal.html` hard-codes 66 properties, 92% occupancy,
$72K NOI and $2.04M debt across 3 loans. Three of those are wrong. The database
has 75 loans totalling roughly $106.5M, and occupancy is not derivable at all:
`unit.occupancy` is free text and empty on all 224 unit rows, with no lease or
tenant table anywhere. Investors, Financials, Leads and Appointments are baked
too.

That was never part of Phases 1 to 6, but it is the largest remaining inaccuracy
in the dashboard and the obvious next piece of work.
