-- Universe backfill monthly refresh marker.
--
-- The universe-backfill scheduling refactor (replaces the always-on */15 cron with
-- a monthly trigger) requires a marker to signal when a fresh monthly refresh is due.
-- This pg_cron job writes `universe_backfill_refresh_due` to app_config on the 15th
-- @ 23:00 UTC (one hour before the 16th @ 01:00 UTC monthly trigger). The frequent
-- cron (every 15 min) checks this marker to decide whether a backfill is needed
-- (if marker exists and force=false, start fresh; if both phases are done and marker
-- doesn't exist, short-circuit with zero cost).

-- Schedule: 15th @ 23:00 UTC (1 hour before the monthly 16th @ 01:00 UTC trigger)
SELECT cron.unschedule(jobid)
FROM cron.job
WHERE jobname = 'universe-backfill-monthly-refresh-marker';

SELECT cron.schedule(
  'universe-backfill-monthly-refresh-marker',
  '0 23 15 * *',
  $$
  INSERT INTO public.app_config (key, value, description, updated_at)
  VALUES (
    'universe_backfill_refresh_due',
    jsonb_build_object(
      'timestamp', now()::text,
      'month', to_char(now(), 'YYYY-MM')
    )::text,
    'Monthly refresh cycle marker for universe-backfill. Set on 15th @ 23:00 UTC, triggers full re-run starting 16th @ 01:00 UTC. Cleared when both phases complete.',
    now()
  )
  ON CONFLICT (key) DO UPDATE
  SET value = EXCLUDED.value, description = EXCLUDED.description, updated_at = now()
  $$
);
