-- Actually drop the four zombie backfill-tracking columns from scheme_master.
--
-- Context: migration 20260610000000_drop_scheme_master_backfill_columns.sql was
-- recorded as applied in supabase_migrations.schema_migrations (2026-06-10), but the
-- DDL never executed. The columns remain:
--   - last_backfill_attempted_at
--   - backfill_outcome
--   - backfill_failure_count
--   - is_inactive
-- plus their supporting index idx_scheme_master_backfill_rotation.
--
-- Root cause: migration ledger drift. The entry for 20260610000000 has the wrong name
-- recorded (was listed as "fix_sync_nav_cron_app_config"), masking the fact that the
-- DROP DDL never ran. That name collision is being fixed in a parallel ledger repair;
-- this migration now actually executes the DROP.
--
-- Verification (pre-execution):
--   SELECT COUNT(*) FROM information_schema.columns
--   WHERE table_schema = 'public'
--     AND table_name = 'scheme_master'
--     AND column_name IN (
--       'last_backfill_attempted_at', 'backfill_outcome',
--       'backfill_failure_count', 'is_inactive'
--     );
--   → Expected: 4 rows (the four columns still exist)
--
-- Expected rows affected: ~9,217 (scheme_master rows will become smaller).
--
-- No app read paths reference these columns (verified via grep across src/, app/,
-- supabase/functions/, scripts/). Safe to drop.
--
-- The supporting index will be dropped first (IF EXISTS guard against double-drop
-- if this migration is ever re-run).

DROP INDEX IF EXISTS idx_scheme_master_backfill_rotation;

ALTER TABLE scheme_master
  DROP COLUMN IF EXISTS last_backfill_attempted_at,
  DROP COLUMN IF EXISTS backfill_outcome,
  DROP COLUMN IF EXISTS backfill_failure_count,
  DROP COLUMN IF EXISTS is_inactive;
