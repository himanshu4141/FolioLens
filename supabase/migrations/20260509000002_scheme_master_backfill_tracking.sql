-- Backfill-tracking columns on scheme_master.
--
-- The Compare Funds + Past SIP Check tools need fast reads against the entire
-- AMFI scheme universe (~37k codes). The daily sync-fund-meta cron only
-- processes user_fund rows; the universe-wide backfill (run via the new
-- backfill-fund-universe workflow) needs its own state-tracking so it can
-- - skip schemes refreshed recently
-- - deprioritise schemes that fail repeatedly (dead AMFI codes, etc.)
-- - mark schemes as inactive when external sources consistently return no data
--
-- Read paths in the app screens never touch these columns — they're
-- workflow-state plumbing.

ALTER TABLE scheme_master
  ADD COLUMN IF NOT EXISTS last_backfill_attempted_at  timestamptz,
  ADD COLUMN IF NOT EXISTS backfill_outcome            text,
  ADD COLUMN IF NOT EXISTS backfill_failure_count      integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS is_inactive                 boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN scheme_master.last_backfill_attempted_at IS
  'When the universe-backfill last touched this scheme — success or failure. '
  'Drives the rotation order in the daily cron (oldest-first).';

COMMENT ON COLUMN scheme_master.backfill_outcome IS
  'Last backfill outcome: ''success'' | ''partial'' | ''no_data'' | ''http_error'' | ''rate_limited''. '
  'NULL until the first attempt.';

COMMENT ON COLUMN scheme_master.backfill_failure_count IS
  'Consecutive failure count. Reset to 0 on a successful run. Schemes with '
  'count >= 5 get their is_inactive flag set so the cron stops attempting them.';

COMMENT ON COLUMN scheme_master.is_inactive IS
  'True when the scheme is presumed dead (no metadata + no NAV from any source). '
  'Excluded from backfill rotation. The daily cron still re-checks weekly via a '
  'separate slow-lane query so a re-listed scheme can recover.';

-- Composite index for the cron's primary read pattern: pick the next batch of
-- active schemes ordered by oldest-attempted first.
CREATE INDEX IF NOT EXISTS idx_scheme_master_backfill_rotation
  ON scheme_master (is_inactive, last_backfill_attempted_at NULLS FIRST)
  WHERE is_inactive = false;
