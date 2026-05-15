-- Schedule the `sync-stock-market-cap` edge function to run monthly on the
-- 1st at 00:30 UTC (06:00 IST). AMFI publishes the stock-categorization
-- list twice a year (Jan / Jul), but a monthly cadence is idempotent and
-- removes "AMFI shifted their release window" as a failure mode — the
-- seeder logs `was_noop: true` when the classification_period matches
-- what's already in the table.
--
-- See docs/plans/phase-9-pre-launch-readiness/M6-honest-portfolio-composition.md.

SELECT cron.schedule(
  'sync-stock-market-cap-monthly',
  '30 0 1 * *',
  $$
  SELECT net.http_post(
    url := current_setting('app.supabase_functions_base_url') || '/sync-stock-market-cap',
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body := '{}'::jsonb
  );
  $$
);
