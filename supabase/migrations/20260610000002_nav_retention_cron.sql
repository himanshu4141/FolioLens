-- Weekly pg_cron job for NAV retention.
--
-- Calls the nav-retention edge function once a week (Sundays 03:00 UTC /
-- 08:30 IST) to delete nav_history rows for schemes that:
--   1. are NOT held by any active user_fund (no user is tracking them), AND
--   2. have nav_backfilled_at IS NULL (never demand-fetched) OR
--      nav_backfilled_at < now() - interval '90 days' (stale demand-fetch).
--
-- The function caps each run at 100 k deleted rows so it fits inside the
-- edge-function 150 s wall-clock limit.  Multiple weekly runs drain any
-- backlog that exists after the one-time manual cleanup (see
-- docs/INFRASTRUCTURE.md "Runbook: one-time NAV retention cleanup").
--
-- URL read from app_config per the established pattern (see
-- 20260513000001_app_config_table.sql).  A missing app_config row produces
-- a NULL URL and causes net.http_post to fail loudly — the intended
-- behaviour if bootstrap was skipped.
--
-- Deploy nav-retention with --no-verify-jwt (pg_cron has no JWT to send).

SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = 'nav-retention-weekly';
SELECT cron.schedule(
  'nav-retention-weekly',
  '0 3 * * 0',
  $$
  SELECT net.http_post(
    url     := public.app_config_get('supabase_functions_base_url') || '/nav-retention',
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body    := '{}'::jsonb
  );
  $$
);
