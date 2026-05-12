-- Schedule the `regenerate-index-snapshots` edge function to run daily,
-- 15 minutes after `sync-index` (which runs at 13:45 UTC). Snapshot
-- regeneration thus picks up the day's freshly-ingested close.
--
-- Weekdays only — indices don't trade on weekends. If a weekend run is
-- desired later (e.g. for index reclassifications), bump the schedule
-- to `0 14 * * *`.
--
-- URL is built from `current_setting('app.supabase_functions_base_url')`
-- so the same migration applies to dev and prod. Each project must run
-- the one-time bootstrap (handled by the Supabase deploy workflows in
-- `.github/workflows/supabase-deploy-{dev,prod}.yml`):
--
--   ALTER DATABASE postgres
--     SET app.supabase_functions_base_url = 'https://<project-ref>.supabase.co/functions/v1';
--
-- If the setting is missing the cron job will fail loudly at execution
-- time with "unrecognized configuration parameter" rather than silently
-- calling the wrong project — which is the intended failure mode.
--
-- Phase 9 M5 — Layer 3 of "CDN snapshots for benchmark index history".

SELECT cron.schedule(
  'regenerate-index-snapshots-daily',
  '0 14 * * 1-5',
  $$
  SELECT net.http_post(
    url := current_setting('app.supabase_functions_base_url') || '/regenerate-index-snapshots',
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body := '{}'::jsonb
  );
  $$
);
