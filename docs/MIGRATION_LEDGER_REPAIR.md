# Migration Ledger Repair Guide (June 2026)

## Incident Summary

Two migrations share version `20260610000000` in the dev database's ledger:
- **Expected:** `20260610000000_drop_scheme_master_backfill_columns.sql`
- **Actual in ledger:** Both `20260610000000` and `20260610000001` are listed as `fix_sync_nav_cron_app_config`

Result: the DROP DDL never executed, leaving four columns in `scheme_master`:
- `last_backfill_attempted_at`
- `backfill_outcome`
- `backfill_failure_count`
- `is_inactive`

Plus supporting index: `idx_scheme_master_backfill_rotation`

## Remedy

Three steps:

### Step 1: Verify current state (read-only, safe)

Run this against **DEV only** via Supabase Dashboard → SQL Editor:

```sql
-- Check the ledger drift
SELECT version, name, executed_at
FROM supabase_migrations.schema_migrations
WHERE version LIKE '20260610%'
ORDER BY version, name;

-- Expected output: Two rows, both with version 20260610000000 and name 'fix_sync_nav_cron_app_config'
-- After repair: will show correct names matching the repo files

-- Verify the zombie columns still exist
SELECT COUNT(*) as column_count
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'scheme_master'
  AND column_name IN (
    'last_backfill_attempted_at',
    'backfill_outcome',
    'backfill_failure_count',
    'is_inactive'
  );

-- Expected: 4 rows
-- After all repairs complete: 0 rows
```

### Step 2: Repair the ledger name for 20260610000000

Run **once** against **DEV only**:

```sql
-- Fix the 20260610000000 entry to reflect the actual file name
UPDATE supabase_migrations.schema_migrations
SET name = 'drop_scheme_master_backfill_columns'
WHERE version = '20260610000000'
  AND name = 'fix_sync_nav_cron_app_config';

-- Verify: should show "1 row updated"

-- Double-check the result
SELECT version, name
FROM supabase_migrations.schema_migrations
WHERE version LIKE '20260610%'
ORDER BY version, name;

-- Expected: Two rows with correct names:
-- 20260610000000 | drop_scheme_master_backfill_columns
-- 20260610000001 | fix_sync_nav_cron_app_config
```

### Step 3: Deploy the new migration to actually drop the columns

After fixing the ledger, deploy this PR to push the new migration:

```bash
# From the FolioLens repo root
git pull origin claude/busy-keller-1u1jwz
supabase db push
```

This executes `20260612000000_drop_backfill_columns_for_real.sql`, which:
- Drops the index (if it exists)
- Drops the four columns (all with IF EXISTS guards for idempotency)

### Step 4: Verify the final state (read-only, safe)

Run this against **DEV** after `supabase db push` completes:

```sql
-- Verify the columns are gone
SELECT COUNT(*) as zombie_columns
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'scheme_master'
  AND column_name IN (
    'last_backfill_attempted_at',
    'backfill_outcome',
    'backfill_failure_count',
    'is_inactive'
  );

-- Expected: 0 rows (columns deleted)

-- Verify the ledger is consistent with the repo
SELECT version, name
FROM supabase_migrations.schema_migrations
WHERE version IN ('20260610000000', '20260610000001', '20260612000000')
ORDER BY version;

-- Expected: three rows
-- 20260610000000 | drop_scheme_master_backfill_columns
-- 20260610000001 | fix_sync_nav_cron_app_config
-- 20260612000000 | drop_backfill_columns_for_real

-- Verify no schema drift
-- From a clean checkout, run:
supabase db push --dry-run

-- Expected: "Finished supabase db push" with no pending migrations
```

## Rollback (if needed)

If the repair needs to be reversed, the steps are:

1. **Re-add the columns** via a revert migration (name: `20260612000001_revert_drop_backfill_columns.sql`):
   ```sql
   ALTER TABLE scheme_master
     ADD COLUMN IF NOT EXISTS last_backfill_attempted_at TIMESTAMPTZ,
     ADD COLUMN IF NOT EXISTS backfill_outcome TEXT,
     ADD COLUMN IF NOT EXISTS backfill_failure_count INT,
     ADD COLUMN IF NOT EXISTS is_inactive BOOLEAN;

   CREATE INDEX IF NOT EXISTS idx_scheme_master_backfill_rotation
   ON scheme_master (is_inactive, last_backfill_attempted_at);
   ```

2. **Restore the ledger entry** (if the UPDATE was reversed):
   ```sql
   UPDATE supabase_migrations.schema_migrations
   SET name = 'fix_sync_nav_cron_app_config'
   WHERE version = '20260610000000'
     AND name = 'drop_scheme_master_backfill_columns';
   ```

## Why this happened

**Root cause:** The migration file `20260610000000_drop_scheme_master_backfill_columns.sql` existed and was supposed to execute, but its ledger entry was recorded with a different name (`fix_sync_nav_cron_app_config`) — likely due to a typo during the initial migration creation or a bug in the tooling. When Supabase CLI compares files to the ledger, it matches by version number, not file name. Since a ledger entry already existed for version `20260610000000`, the CLI skipped the file and never executed its DDL.

**Prevention:** The new `scripts/check-migration-versions.mjs` guard detects duplicate version prefixes and backfilled versions, preventing similar incidents in the future. It runs on every PR that touches migrations.

## Related files

- **Migration file:** `supabase/migrations/20260612000000_drop_backfill_columns_for_real.sql`
- **Guard script:** `scripts/check-migration-versions.mjs`
- **CI workflow:** `.github/workflows/supabase-validate.yml` (runs the guard)
- **Documentation:** `docs/INFRASTRUCTURE.md` (section: "Migrations: version integrity")
- **Migration README:** `supabase/migrations/README.md`
