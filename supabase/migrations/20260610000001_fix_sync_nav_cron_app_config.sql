-- Fix sync-nav-hourly cron: replace current_setting() regression with app_config_get().
--
-- Root cause: migration 20260528000000_sync_nav_bimodal_schedule.sql re-created
-- the sync-nav-hourly job using:
--
--   url := current_setting('app.supabase_functions_base_url') || '/sync-nav'
--
-- That reverted to the pattern that 20260513000001_app_config_table.sql explicitly
-- retired. Supabase managed Postgres locks down `ALTER DATABASE … SET` for arbitrary
-- GUCs, so the GUC is never set and every cron tick fails with:
--
--   ERROR: unrecognized configuration parameter "app.supabase_functions_base_url"
--
-- The project convention since 20260513000001 is public.app_config_get(key), which
-- reads from the public.app_config table that IS bootstrapped on both projects.
-- Migration 20260531000000 (openfolio-composition-monthly) already follows this
-- pattern; this migration brings sync-nav-hourly back into line.
--
-- The bimodal schedule from 20260528000000 is preserved unchanged:
--   30 0,2,4,6,8,10,12,13,14,15,16,17,18,19,20,21,22,23 * * *
--   (18 invocations/day: hourly 6 PM–6 AM IST for EOD NAV window,
--    every 2 h 8 AM–4 PM IST for the idle daytime window)
--
-- Idempotent unschedule: jobid-lookup means a missing job → zero rows deleted
-- → safe no-op (the named-argument form of cron.unschedule raises on a missing
-- job, which would abort the migration on a fresh project).

SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = 'sync-nav-hourly';
SELECT cron.schedule(
  'sync-nav-hourly',
  '30 0,2,4,6,8,10,12,13,14,15,16,17,18,19,20,21,22,23 * * *',
  $$
  SELECT net.http_post(
    url     := public.app_config_get('supabase_functions_base_url') || '/sync-nav',
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body    := '{}'::jsonb
  );
  $$
);
