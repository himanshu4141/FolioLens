-- Retire the pre-OpenFolio universe backfill tracking columns.
--
-- These four columns (and the supporting index) were introduced by
-- 20260509000002_scheme_master_backfill_tracking.sql to serve the
-- GitHub Actions-based backfill-fund-universe workflow.  That workflow and
-- its companion script (scripts/backfill-fund-universe.mjs) are retired
-- as of 2026-06-10 because:
--
--   1. The workflow has been timing out nightly since 2026-06-02 against
--      the mfdata.in 1.6 GB NAV history load (8.8 M rows, 98.8 % unheld).
--   2. It wrote source:'amfi' composition rows — a source tag that no longer
--      exists after the #191 deprecation (mfdata rows are now 'category_fallback').
--   3. Universe pre-hydration is now owned by the OpenFolio chunked backfill
--      (supabase/functions/universe-backfill/) + the existing on-pick
--      fetch-fund-snapshot hydration path.
--
-- No app read paths ever touched these columns (confirmed: not in database.types.ts,
-- not in src/, not in any Edge Function).  Dropping them shrinks the hot
-- scheme_master row and removes a dead index.
--
-- NAV history rows written by the old script are left intact; cleanup is a
-- separate PR.

DROP INDEX IF EXISTS idx_scheme_master_backfill_rotation;

ALTER TABLE scheme_master
  DROP COLUMN IF EXISTS last_backfill_attempted_at,
  DROP COLUMN IF EXISTS backfill_outcome,
  DROP COLUMN IF EXISTS backfill_failure_count,
  DROP COLUMN IF EXISTS is_inactive;
