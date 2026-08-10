-- ===========================================================================
-- 20260810_supabase_webhooks.sql
--
-- Outbound table-change webhooks: every table in `public` tells the dashboard
-- when it changed, so the front end can refresh the affected view.
--
-- ADDITIVE. Creates one extension, one config table, one function and one
-- trigger per table. No existing object is altered. No RLS policy is touched.
-- Rollback is at the bottom of this file.
--
-- BEFORE YOU RUN THIS, read the two checks in the "Verify first" block. The
-- pg_net function signature differs between versions and guessing it produces a
-- function that compiles and silently never fires.
--
-- The payload is the TABLE NAME AND OPERATION ONLY. Row data is deliberately not
-- sent: it would travel to a browser whose user may not be entitled to read it
-- under RLS, and the front end does not need it - it only needs to know which
-- cache to drop.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Verify first (run these two, adjust the function below if they disagree)
--
--   select n.nspname as pg_net_schema
--   from pg_extension e join pg_namespace n on n.oid = e.extnamespace
--   where e.extname = 'pg_net';
--   -- expect: net
--
--   select p.proname, pg_get_function_identity_arguments(p.oid) as args
--   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--   where n.nspname = 'net' and p.proname = 'http_post';
--   -- expect something like:
--   --   url text, body jsonb, params jsonb, headers jsonb, timeout_milliseconds integer
-- ---------------------------------------------------------------------------

create extension if not exists pg_net;

-- ---------------------------------------------------------------------------
-- Where to send, and what to sign with. In a table rather than hard-coded so
-- the endpoint and secret can be rotated without a migration, and so the secret
-- never lands in version control.
--
-- RLS is enabled and NO policy is created. That is the point: under RLS a table
-- with no policy is readable by nobody. Only the SECURITY DEFINER function below
-- and the service role can see it.
-- ---------------------------------------------------------------------------
create table if not exists public.webhook_config (
  id          int primary key default 1 check (id = 1),
  endpoint    text        not null,
  secret      text        not null,
  is_active   boolean     not null default true,
  updated_at  timestamptz not null default now()
);

alter table public.webhook_config enable row level security;
revoke all on public.webhook_config from anon, authenticated;

comment on table public.webhook_config is
  'Single-row config for outbound table-change webhooks. Deliberately has RLS on and no policy, so no client role can read the secret. Seed it from the SQL editor; never commit the secret.';

-- ---------------------------------------------------------------------------
-- The trigger function.
--
-- SECURITY DEFINER so it can read webhook_config even though the calling role
-- cannot. search_path is pinned so a malicious schema on the caller's path
-- cannot shadow net.http_post - without this, SECURITY DEFINER is a privilege
-- escalation waiting to happen.
-- ---------------------------------------------------------------------------
create or replace function public.notify_row_change()
returns trigger
language plpgsql
security definer
set search_path = public, extensions, net, pg_temp
as $$
declare
  cfg public.webhook_config;
begin
  select * into cfg from public.webhook_config where id = 1 and is_active;
  if not found then
    return null;   -- statement-level AFTER trigger: return value is ignored
  end if;

  perform net.http_post(
    url     := cfg.endpoint,
    body    := jsonb_build_object(
                 'type',   tg_op,              -- INSERT | UPDATE | DELETE
                 'schema', tg_table_schema,
                 'table',  tg_table_name,
                 'at',     now()
               ),
    headers := jsonb_build_object(
                 'Content-Type',        'application/json',
                 'x-lw-webhook-secret', cfg.secret
               ),
    timeout_milliseconds := 3000
  );
  return null;

exception when others then
  -- A notification must never be able to fail a write. If the endpoint is down,
  -- mid-deploy, or the extension is missing, the transaction still commits and
  -- the front end simply stays stale until the next change or a manual refresh.
  raise warning 'notify_row_change failed for %.%: %', tg_table_schema, tg_table_name, sqlerrm;
  return null;
end;
$$;

comment on function public.notify_row_change() is
  'AFTER STATEMENT trigger. POSTs {type, schema, table, at} to webhook_config.endpoint via pg_net. Never sends row data. Swallows all errors so a webhook failure cannot roll back a write.';

-- ---------------------------------------------------------------------------
-- One trigger per table in `public`.
--
-- STATEMENT level, not ROW: we only need to know the table changed, and this
-- fires once per statement instead of once per row. A 500-row update produces
-- one HTTP call, not 500.
--
-- webhook_config excludes itself, otherwise rotating the secret would fire a
-- webhook signed with the old secret.
-- ---------------------------------------------------------------------------
do $$
declare
  r record;
  n int := 0;
begin
  for r in
    select c.relname
    from pg_class c
    join pg_namespace ns on ns.oid = c.relnamespace
    where ns.nspname = 'public'
      and c.relkind = 'r'
      and c.relname <> 'webhook_config'
    order by c.relname
  loop
    execute format('drop trigger if exists trg_notify_change on public.%I', r.relname);
    execute format(
      'create trigger trg_notify_change after insert or update or delete on public.%I '
      'for each statement execute function public.notify_row_change()', r.relname);
    n := n + 1;
  end loop;
  raise notice 'notify_row_change installed on % tables', n;
end $$;

-- ---------------------------------------------------------------------------
-- Seed the config. DO NOT COMMIT THIS WITH REAL VALUES - run it in the Supabase
-- SQL editor with the live endpoint and the secret you set in Railway as
-- SUPABASE_WEBHOOK_SECRET.
--
--   insert into public.webhook_config (id, endpoint, secret)
--   values (1, 'https://<your-railway-domain>/api/hooks/supabase', '<SUPABASE_WEBHOOK_SECRET>')
--   on conflict (id) do update
--     set endpoint = excluded.endpoint,
--         secret   = excluded.secret,
--         updated_at = now();
--
-- To pause every webhook without dropping anything:
--   update public.webhook_config set is_active = false where id = 1;
--
-- To point it at a staging deployment instead:
--   update public.webhook_config set endpoint = 'https://<staging>/api/hooks/supabase' where id = 1;
--   (only one endpoint at a time - staging and production cannot both receive)
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- Verify after running
--
--   select count(*) as triggers_installed
--   from pg_trigger t join pg_class c on c.oid = t.tgrelid
--   join pg_namespace n on n.oid = c.relnamespace
--   where not t.tgisinternal and n.nspname = 'public'
--     and t.tgname = 'trg_notify_change';
--   -- expect: one per table in public, minus webhook_config
--
--   -- fire one and watch it land
--   update public.tenant set updated_at = now() where id = '72381c81-af95-4e1d-ad0d-20a3a3421119';
--   select id, url, status_code, created
--   from net._http_response order by created desc limit 5;
--   -- expect a 200 from /api/hooks/supabase
-- ---------------------------------------------------------------------------

-- ===========================================================================
-- ROLLBACK
--
--   do $$
--   declare r record;
--   begin
--     for r in
--       select c.relname from pg_class c
--       join pg_namespace n on n.oid = c.relnamespace
--       where n.nspname = 'public' and c.relkind = 'r'
--     loop
--       execute format('drop trigger if exists trg_notify_change on public.%I', r.relname);
--     end loop;
--   end $$;
--
--   drop function if exists public.notify_row_change();
--   drop table if exists public.webhook_config;
--   -- pg_net is left installed; dropping it would break anything else using it.
-- ===========================================================================
