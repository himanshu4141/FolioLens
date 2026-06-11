-- Freshness-check infrastructure: security-definer helper to read cron failures.
--
-- The freshness-check edge function needs to audit recent cron job failures
-- (e.g., sync-nav-hourly silently failing 18×/day). The cron schema is hidden
-- from PostgREST and the service role, so we expose a read-only, security-definer
-- function that returns recent failures for a specified time window.
--
-- Sequence after FL-2 (completed universe-backfill migrations) so backfill
-- cursor keys are stable.

CREATE OR REPLACE FUNCTION public.recent_cron_failures(hours int DEFAULT 24)
RETURNS TABLE (
  jobname text,
  status text,
  start_time timestamptz,
  message text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT
    j.jobname,
    jrd.status,
    jrd.start_time,
    jrd.message
  FROM cron.job j
  INNER JOIN cron.job_run_details jrd ON j.jobid = jrd.jobid
  WHERE jrd.start_time > now() - (hours || ' hours')::interval
    AND jrd.status != 'succeeded'
  ORDER BY jrd.start_time DESC
$$;

COMMENT ON FUNCTION public.recent_cron_failures(int) IS
  'Returns cron job failures from the past N hours (default 24). Security-definer so the freshness-check edge function (running as service_role) can audit cron health without direct schema access.';

GRANT EXECUTE ON FUNCTION public.recent_cron_failures(int) TO service_role;

-- Schedule the freshness-check cron job (08:00 UTC daily, with --no-verify-jwt
-- so pg_cron can invoke it without a bearer token).
SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = 'freshness-check-daily';
SELECT cron.schedule(
  'freshness-check-daily',
  '0 8 * * *',
  $$
  SELECT net.http_post(
    url := public.app_config_get('supabase_functions_base_url') || '/freshness-check',
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body := '{}'::jsonb
  );
  $$
);

COMMENT ON CRON JOB (jobid := (SELECT jobid FROM cron.job WHERE jobname = 'freshness-check-daily'))
  IS 'Daily health check: NAV freshness, cron job failures, backfill cursor staleness, OpenFolio availability, composition age. Alerts on Slack + email if any check fails.';
