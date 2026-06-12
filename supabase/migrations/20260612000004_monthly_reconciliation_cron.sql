-- Monthly reconciliation infrastructure for freshness-check.
--
-- Adds helper functions to count metadata and composition schemes,
-- and schedules the monthly reconciliation cron job to run on the 1st of
-- each month at 02:00 UTC.
--
-- The monthly reconciliation compares FolioLens coverage against OpenFolio
-- upstream counts for:
-- (a) Metadata: count(openfolio_meta_synced_at IS NOT NULL) vs /v1/metadata total
-- (b) Composition: count(DISTINCT scheme_code) WHERE source='official' vs /v1/composition total
-- (c) Disclosure lag: max portfolio_date vs /health latest_disclosure_date

CREATE OR REPLACE FUNCTION public.count_synced_metadata_schemes()
RETURNS TABLE (count bigint)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT COUNT(*) as count
  FROM scheme_master
  WHERE openfolio_meta_synced_at IS NOT NULL
$$;

COMMENT ON FUNCTION public.count_synced_metadata_schemes() IS
  'Returns the count of scheme_master rows with openfolio_meta_synced_at NOT NULL. Used by the monthly reconciliation check to measure local metadata coverage vs OpenFolio.';

GRANT EXECUTE ON FUNCTION public.count_synced_metadata_schemes() TO service_role;

CREATE OR REPLACE FUNCTION public.count_official_composition_schemes()
RETURNS TABLE (count bigint)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT COUNT(DISTINCT scheme_code) as count
  FROM fund_portfolio_composition
  WHERE source = 'official'
$$;

COMMENT ON FUNCTION public.count_official_composition_schemes() IS
  'Returns the count of distinct scheme_codes with source=''official'' in fund_portfolio_composition. Used by the monthly reconciliation check to measure local composition coverage vs OpenFolio.';

GRANT EXECUTE ON FUNCTION public.count_official_composition_schemes() TO service_role;

-- Schedule the freshness-check monthly reconciliation cron job (1st of month, 02:00 UTC)
SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = 'freshness-check-monthly';
SELECT cron.schedule(
  'freshness-check-monthly',
  '0 2 1 * *',
  $$
  SELECT net.http_post(
    url := public.app_config_get('supabase_functions_base_url') || '/freshness-check',
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body := '{"mode": "monthly"}'::jsonb
  );
  $$
);
