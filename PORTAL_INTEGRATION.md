# Portal + Ops Dashboard (merged)

This repo now serves TWO things from one Express service:

- `/`      → **Company portal** (`public/portal.html`) — the front door, with the
             5 sections: Company (org/dept), Dashboards (Exec, Marketing/Ads),
             Transactions & Financials (Internal financials, Property financial reports),
             Properties (Properties, Loans), Leads (Leads, Appointments), + Team.
- `/ops`   → the existing **operations dashboard** (`public/index.html`), unchanged,
             with live ClickUp + Supabase data (Overview, Tasks, Properties, CapEx, etc).

The portal's **Properties** card embeds `/ops#tab=properties` in an iframe (same-origin,
so your ClickUp session/OAuth just works). A deep-link handler was added to the ops
dashboard so `#tab=<name>&sub=<subview>` opens the right view.

## Deploy (recommended: one service)
Push this folder to the existing **click-up-dashboard** repo/Railway service. All your
current env vars (ClickUp token, Supabase/PG) keep working. After deploy:
- portal:  https://<your-service>/
- ops:     https://<your-service>/ops

## Portal data
The portal cards currently render from baked demo data that mirrors the seeded Supabase
rows (so it looks populated with no extra wiring). The Properties card is already LIVE via
the embedded ops dashboard. Swap the other cards to live Supabase reads once auth is added.
