# Database Migrations

All database schema changes live in this directory as SQL files following the naming convention:

```
YYYYMMDDXXXXXX_descriptive_name.sql
```

Where:
- `YYYYMMDD` is the date the migration was created (e.g., 20260610)
- `XXXXXX` is a zero-padded sequence number (000000, 000001, etc.) for multiple migrations on the same day
- `descriptive_name` is a slug describing the change in snake_case

## Version integrity rules

**Version collisions are not allowed.** Two migrations cannot share the same version prefix (e.g., `20260610000000`). This is enforced by the CI check `scripts/check-migration-versions.mjs` which runs on every PR touching migrations.

**Backfilling old versions is not allowed.** Do not create a migration with a version ≤ the max version on `origin/main`. If you need to add a migration from an earlier date, create it on a feature branch and merge after it's landed on main.

## Before pushing

Run the migration version check locally:

```bash
node scripts/check-migration-versions.mjs --check-branch
```

This validates:
1. No two files in this directory share the same version prefix
2. No new migrations backfill versions that already exist on `origin/main`

## The ledger

Supabase CLI maintains `supabase_migrations.schema_migrations` — a table that tracks which migrations have been applied. When you run `supabase db push`, the CLI:
1. Compares files on disk to entries in the ledger
2. Executes any migrations that exist on disk but not in the ledger
3. Updates the ledger with the new version + file name

**The ledger must always match the source of truth (files on disk).** A mismatch — where a ledger entry has the wrong name or a migration's DDL never executed despite being marked applied — is a silent failure that corrupts the schema.

### Incident (June 2026)

Migration `20260610000000_drop_scheme_master_backfill_columns.sql` had its ledger entry recorded with the wrong name (`fix_sync_nav_cron_app_config`), causing:
1. Two ledger rows with version `20260610000000` (both saying the same name)
2. The DROP DDL never executed, leaving columns in production
3. Schema divergence between the repo and the databases

This was fixed by:
1. Creating a new migration `20260612000000_drop_backfill_columns_for_real.sql` that executes the DROP (with idempotent guards)
2. Manually correcting the ledger entries to match the files on disk
3. Deploying the new migration to both environments

## Migration file checklist

Before committing:
- [ ] File name follows `YYYYMMDDXXXXXX_description.sql`
- [ ] Version is unique (no existing file with the same version prefix)
- [ ] Version is > max version on `origin/main` (unless intentionally fixing a drift on a feature branch)
- [ ] Changes are idempotent (use `IF EXISTS` guards, etc.)
- [ ] Header comment explains the WHY, not just the WHAT
- [ ] Affected tables/columns are not read by app code (grep `src/`, `app/`, `supabase/functions/`, `scripts/`)
- [ ] After local testing with `supabase db reset`, schema matches the intended change

## Running migrations locally

Reset the local database and replay all migrations:

```bash
supabase db reset
```

Lint the schema after applying:

```bash
supabase db lint --local --fail-on error --schema public
```

## Manual ledger repair (if needed)

If a migration's ledger entry has the wrong name or version, you can repair it via the Supabase Dashboard SQL Editor or `psql`:

```sql
UPDATE supabase_migrations.schema_migrations
SET name = 'correct_name'
WHERE version = '20260610000000' AND name = 'wrong_name';
```

**Before executing:** verify the file on disk matches the intended name. Ledger repairs should be documented in the PR and the exact commands recorded for audit/rollback purposes.
