-- Fix category_rules accretion and demote the composition sync to daily.
--
-- Problem: sync-fund-portfolios seeded category_rules rows with
-- portfolio_date = CURRENT_DATE, so every cron tick created a distinct
-- (scheme_code, today, 'category_rules') key — the UNIQUE constraint never
-- fired and rows accreted one per day (dev: 1,736 rows over 91 schemes
-- as of 2026-06-10).
--
-- Fix: use the fixed sentinel date '1900-01-01' as portfolio_date for all
-- category_rules rows. A re-run always upserts the same
-- (scheme_code, '1900-01-01', 'category_rules') key → exactly one row per
-- scheme. The sentinel is harmless because pickBestCompositionRows ranks
-- category_rules last (rank 0), so it can never displace a higher-ranked
-- real-data row in the read path regardless of the date.
-- computeInsights excludes category_rules rows from the dataAsOf calculation
-- for the same reason (no disclosure meaning).
--
-- Cron demotion: The hourly schedule was motivated by "new imported funds get
-- composition data within the hour". With category_rules now guaranteed to
-- update on the first daily run, and mfdata.in / OpenFolio-Data rows updating
-- at most monthly, an hourly poll burns pg_net quota for zero benefit.
-- The new daily schedule (02:10 UTC, after the fund-meta cron at 02:00 UTC)
-- is sufficient.

-- ─── 1. Dedupe: keep only the most recent category_rules row per scheme ────
-- DISTINCT ON orders by (scheme_code, synced_at DESC) to identify the survivor.
DELETE FROM fund_portfolio_composition
WHERE source = 'category_rules'
  AND id NOT IN (
    SELECT DISTINCT ON (scheme_code) id
    FROM fund_portfolio_composition
    WHERE source = 'category_rules'
    ORDER BY scheme_code, synced_at DESC
  );

-- ─── 2. Rewrite surviving rows to use the sentinel date ──────────────────────
UPDATE fund_portfolio_composition
SET portfolio_date = '1900-01-01',
    synced_at      = now()
WHERE source = 'category_rules'
  AND portfolio_date <> '1900-01-01';

-- ─── 3. Demote composition sync from hourly to daily ─────────────────────────
-- Idempotent: unschedule both the old name and the new name before
-- (re)scheduling. A missing job produces an empty result set — no error.
SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = 'sync-portfolio-composition-hourly';
SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = 'sync-portfolio-composition-daily';

-- Daily at 02:10 UTC — avoids the sync-fund-meta-daily window at 02:00 UTC
-- and still runs well before the IST business day starts.
SELECT cron.schedule(
  'sync-portfolio-composition-daily',
  '10 2 * * *',
  $$
  SELECT net.http_post(
    url     := public.app_config_get('supabase_functions_base_url') || '/sync-fund-portfolios',
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body    := '{}'::jsonb
  );
  $$
);
