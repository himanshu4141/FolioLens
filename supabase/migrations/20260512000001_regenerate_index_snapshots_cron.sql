-- Schedule the `regenerate-index-snapshots` edge function to run daily,
-- 15 minutes after `sync-index` (which runs at 13:45 UTC). Snapshot
-- regeneration thus picks up the day's freshly-ingested close.
--
-- Weekdays only — indices don't trade on weekends. If a weekend run is
-- desired later (e.g. for index reclassifications), bump the schedule
-- to `0 14 * * *`.
--
-- Phase 9 M5 — Layer 3 of "CDN snapshots for benchmark index history".

SELECT cron.schedule(
  'regenerate-index-snapshots-daily',
  '0 14 * * 1-5',
  $$
  SELECT net.http_post(
    url := 'https://imkgazlrxtlhkfptkzjc.supabase.co/functions/v1/regenerate-index-snapshots',
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body := '{}'::jsonb
  );
  $$
);
