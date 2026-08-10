-- ===========================================================================
-- Realtime sync: fire a webhook to the Railway app on EVERY change to a public
-- table, so the dashboards can refetch and stay live.
--
-- Supabase "Database Webhooks" are just Postgres triggers that call
-- supabase_functions.http_request (pg_net). The UI only lets you pick one table
-- at a time; this migration loops over every base table in the `public` schema
-- and installs the same trigger on each, so one script replaces clicking through
-- the UI table-by-table. Re-running it is safe (drops + recreates the trigger).
--
-- BEFORE RUNNING, set the two values below:
--   url    -> your Railway app URL + /api/hooks/supabase
--             e.g. https://<your-app>.up.railway.app/api/hooks/supabase
--   secret -> the SAME string you set as the WEBHOOK_SECRET env var on Railway
--             (the receiver rejects any POST whose x-webhook-secret doesn't match)
--
-- Requires the pg_net extension + supabase_functions schema, which every Supabase
-- project has by default (they power the built-in Database Webhooks).
-- ===========================================================================

do $$
declare
  r record;
  url    text := 'https://REPLACE_ME.up.railway.app/api/hooks/supabase';
  secret text := 'REPLACE_ME_WITH_WEBHOOK_SECRET';
  headers text;
  n int := 0;
begin
  headers := json_build_object('Content-Type','application/json','x-webhook-secret',secret)::text;

  for r in
    select c.relname as tbl
    from pg_class c
    join pg_namespace ns on ns.oid = c.relnamespace
    where ns.nspname = 'public'
      and c.relkind = 'r'          -- base tables only (skips views such as v_loan_maturities)
      and c.relname not like 'pg_%'
  loop
    execute format('drop trigger if exists zz_dashboard_sync on public.%I', r.tbl);
    execute format(
      'create trigger zz_dashboard_sync
         after insert or update or delete on public.%I
         for each row
         execute function supabase_functions.http_request(%L, %L, %L, %L, %L)',
      r.tbl, url, 'POST', headers, '{}', '5000'
    );
    n := n + 1;
  end loop;

  raise notice 'zz_dashboard_sync installed on % public tables', n;
end $$;

-- To remove later:
--   do $$ declare r record; begin
--     for r in select c.relname tbl from pg_class c join pg_namespace ns on ns.oid=c.relnamespace
--       where ns.nspname='public' and c.relkind='r' loop
--       execute format('drop trigger if exists zz_dashboard_sync on public.%I', r.tbl);
--     end loop; end $$;
