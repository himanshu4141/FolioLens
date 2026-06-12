# Validation Checklist: scheme_active Column (FL-3)

## Objective
Persist OpenFolio's active registry signal in `scheme_master.scheme_active` and rank picker results by active status (true > false > null).

## Implementation Summary

### Files Changed
1. **Migration**: `supabase/migrations/20260612000003_add_scheme_active.sql`
   - Adds nullable `scheme_active: boolean` column to scheme_master
   - Comment explains semantics: true = active in AMFI NAVAll within 30d, false = wound-up/merged, null = not yet synced

2. **Schema Types**: 
   - `supabase/functions/_shared/openfolio.ts` - Added `active?: boolean | null` to FundMetadata
   - `src/types/database.types.ts` - Added scheme_active to Row/Insert/Update types

3. **Writers**:
   - `supabase/functions/universe-backfill/index.ts` - Maps active → scheme_active in metadata phase
   - `supabase/functions/sync-fund-meta/index.ts` - Maps OpenFolio.active → scheme_active 

4. **Picker**:
   - `src/utils/fundSearch.ts` - Orders by `scheme_active DESC NULLS LAST, scheme_name ASC`
   - Added schemeActive to SchemeSearchResult interface
   - Added scheme_active to SEARCH_COLUMNS select

5. **Tests**:
   - `src/utils/__tests__/fundSearch.test.ts` - Tests ordering and null handling (11 tests, all passing)

6. **Documentation**:
   - `docs/architecture/data-sync-pipeline.md` - Documented column, writers, and picker ranking

## Validation Steps

### Step 1: Migration Applied ✓
- [ ] Migration `20260612000003_add_scheme_active.sql` executed on dev
- [ ] Run: `supabase db pull` locally to verify schema matches
- [ ] Run: `npm run gen:types` to regenerate database.types.ts

**SQL to verify**:
```sql
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name = 'scheme_master' AND column_name = 'scheme_active';
-- Expected: scheme_active | boolean | YES
```

### Step 2: Writer Mapping (universe-backfill)
- [ ] Deploy `supabase/functions/universe-backfill/index.ts` 
- [ ] Trigger one chunk of metadata backfill (or wait for next scheduled run)
- [ ] Verify at least one scheme_active value was written

**SQL to verify**:
```sql
SELECT COUNT(*), COUNT(scheme_active) as non_null_active
FROM scheme_master
WHERE openfolio_meta_synced_at > (NOW() - INTERVAL '1 hour');
-- Expected: non_null_active > 0
```

**Evidence**: Number of schemes with non-null scheme_active after backfill run

### Step 3: Writer Mapping (sync-fund-meta)
- [ ] Deploy `supabase/functions/sync-fund-meta/index.ts`
- [ ] Wait for daily cron at 02:00 UTC or trigger manually
- [ ] Verify scheme_active values are set for held schemes

**SQL to verify**:
```sql
SELECT s.scheme_code, s.scheme_name, s.scheme_active
FROM scheme_master s
JOIN user_fund uf ON s.scheme_code = uf.scheme_code
WHERE s.fund_meta_synced_at > (NOW() - INTERVAL '1 hour')
LIMIT 10;
-- Expected: scheme_active is true/false/null for recent syncs
```

**Evidence**: Sample rows showing scheme_active is populated for held schemes

### Step 4: Picker Ordering
- [ ] Run picker for a query that has both active and inactive schemes
- [ ] Find a known wound-up scheme (research: schemes with scheme_active=false)
- [ ] Verify inactive schemes appear below active ones in results

**SQL to find a wound-up scheme**:
```sql
SELECT scheme_code, scheme_name, scheme_active
FROM scheme_master
WHERE scheme_active = false
LIMIT 1;
-- Use this scheme_code to test picker ranking
```

**Test case**:
1. Open UniversalFundPicker (Compare Funds flow)
2. Search for a broad term (e.g., "Fund")
3. Verify active schemes (green checkmark or active indicator) appear before inactive ones
4. Verify wound-up scheme from Step 4 appears after active matches

**Expected order**:
1. Active schemes (scheme_active = true) sorted by name
2. Inactive schemes (scheme_active = false) sorted by name  
3. Unsynced schemes (scheme_active = null) sorted by name

### Step 5: Search Ordering Unit Test
- [ ] Run: `npm test -- fundSearch`
- [ ] Verify: "orders by scheme_active DESC NULLS LAST" test passes
- [ ] Verify: "handles schemeActive null correctly" test passes

**Expected output**:
```
Test Suites: 1 passed, 1 total
Tests: 11 passed, 11 total
```

### Step 6: Type Safety
- [ ] Run: `npm run typecheck`
- [ ] Verify: No errors about scheme_active

### Step 7: Code Quality
- [ ] Run: `npm run lint`
- [ ] Verify: No warnings or errors

## Schema Change Summary

### Before
```sql
CREATE TABLE scheme_master (
  scheme_code INTEGER PRIMARY KEY,
  scheme_name TEXT NOT NULL,
  -- ... other columns ...
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

### After
```sql
CREATE TABLE scheme_master (
  scheme_code INTEGER PRIMARY KEY,
  scheme_name TEXT NOT NULL,
  -- ... other columns ...
  scheme_active BOOLEAN,  -- NEW: null = not yet synced
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

## Cache Impact
- **__BUSTER__**: No bump needed
  - `searchSchemes()` is NOT part of React Query's persisted cache
  - Uses direct Supabase query with separate columns (SEARCH_COLUMNS)
  - `useSchemeMaster` continues with its own SCHEME_MASTER_COLUMNS (unchanged)

## Rollback Plan
1. Keep column (additive + nullable, safe to leave)
2. Revert app code changes (fundSearch.ts, searchSchemes ordering)
3. Revert writer changes (universe-backfill, sync-fund-meta)
4. No data loss; column just remains unpopulated

## Validation Completion Checklist
- [ ] Migration applied to dev
- [ ] universe-backfill deployed + one chunk runs successfully
- [ ] sync-fund-meta deployed + next daily run succeeds
- [ ] Picker shows wound-up schemes sorted below active ones
- [ ] `npm test -- fundSearch` all pass
- [ ] `npm run typecheck` clean
- [ ] `npm run lint` clean
- [ ] SQL verification queries show data populated

## Next Steps (Post-Validation)
1. Create PR with this validation evidence
2. Merge to main
3. Deploy to production (schema change is safe: additive + nullable)
4. Monitor logs for any sync-fund-meta or universe-backfill issues
