# Test Plan: Monthly Reconciliation (FL-5 Extension)

**Date**: June 12, 2026  
**Objective**: Validate monthly reconciliation feature catches coverage regressions structurally.

## Pre-requisites

- Migration `20260612000004_monthly_reconciliation_cron.sql` applied to dev environment
- Edge function `freshness-check` deployed with monthly mode support
- OpenFolio API credentials set (`OPENFOLIO_API_KEY`, `OPENFOLIO_API_BASE`)

## Test Cases

### 1. Unit Tests (Pure Logic) ✓ Validated by Claude

**Status**: PASS  
**Evidence**: 41 tests passed, including 12 new monthly reconciliation tests  
**Coverage**:
- `checkMetadataCoverage`: 85% threshold, rounding, edge cases
- `checkCompositionCoverage`: same tolerance math
- `checkDisclosureDateLag`: lag calculation, same-day, null handling

### 2. Migration Validation

**Test**: Migration applies without errors  
**Method**: 
```bash
supabase db push --yes
# Check cron.job table for 'freshness-check-monthly' entry
```

**Expected**:
- `count_synced_metadata_schemes()` function created ✓
- `count_official_composition_schemes()` function created ✓  
- Cron job scheduled: `0 2 1 * *` (1st of month, 02:00 UTC)

**Validation**: Manual SQL check on dev
```sql
SELECT * FROM cron.job WHERE jobname = 'freshness-check-monthly';
-- Should show schedule: 0 2 1 * *
```

### 3. RPC Function Tests

**Test 3a**: `count_synced_metadata_schemes()`  
**Method**: Call directly via Supabase Dashboard or CLI
```sql
SELECT * FROM count_synced_metadata_schemes();
```
**Expected**: Single row with `count` column, integer > 0

**Test 3b**: `count_official_composition_schemes()`  
**Method**: Call directly
```sql
SELECT * FROM count_official_composition_schemes();
```
**Expected**: Single row with `count` column, integer > 0

### 4. Monthly Reconciliation Function (Dev Integration)

**Test 4a**: All-pass scenario  
**Method**: Call freshness-check with mode='monthly'
```bash
curl -X POST "https://imkgazlrxtlhkfptkzjc.supabase.co/functions/v1/freshness-check" \
  -H "Content-Type: application/json" \
  -d '{"mode": "monthly"}' \
  -H "Authorization: Bearer <anon-key>"
```

**Expected Response**:
```json
{
  "timestamp": "2026-06-12T...",
  "checks": [
    {
      "name": "Metadata coverage",
      "ok": true,
      "detail": "Metadata coverage: {local}/{upstream} ({pct}%) >= 85%."
    },
    {
      "name": "Composition coverage", 
      "ok": true,
      "detail": "Composition coverage: {local}/{upstream} ({pct}%) >= 85%."
    },
    {
      "name": "Disclosure date lag",
      "ok": true,
      "detail": "Disclosure date lag: {days} days (...), within 45-day threshold."
    }
  ],
  "passedCount": 3,
  "failedCount": 0,
  "details": {
    "metadata_coverage_pct": 95,
    "composition_coverage_pct": 94,
    "disclosure_date_lag_days": 10
  }
}
```

**Validation**: POST OP-1 (after universe-backfill completes), expect ≥85% coverage.

**Test 4b**: Metadata coverage failure (< 85%)  
**Method**: Simulate by querying local counts
```sql
-- Check actual metadata count
SELECT COUNT(*) FROM scheme_master WHERE openfolio_meta_synced_at IS NOT NULL;

-- Check OpenFolio /v1/metadata?page_size=1 in browser or curl
curl -H "Authorization: Bearer $OPENFOLIO_API_KEY" \
  "https://api.openfolio.com/v1/metadata?page_size=1" | jq .total
```

**Expected**: If local < 85% of upstream, call function and verify:
- Response includes failed metadata check
- Alert is sent (if FOLIOLENS_INBOUND_ROUTER_SECRET set)
- Logs include `[freshness-check] monthly-reconciliation summary passed=2 failed=1`

**Test 4c**: Composition coverage failure (< 85%)  
**Method**: Similar to 4b, check fund_portfolio_composition
```sql
SELECT COUNT(DISTINCT scheme_code) FROM fund_portfolio_composition WHERE source='official';
```

**Test 4d**: Disclosure date lag failure (> 45 days)  
**Method**: Check lag manually
```sql
SELECT MAX(portfolio_date) FROM fund_portfolio_composition WHERE source='official';
-- Compare to OpenFolio /health latest_disclosure_date
```

**Expected**: If lag > 45 days, response shows failed disclosure lag check

### 5. Cron Scheduling

**Test**: Cron job runs automatically on 1st of month  
**Method**: 
1. Wait until 1st of next month @ 02:00 UTC, OR
2. Manually invoke via Supabase Dashboard:
   - Navigate to Database → Cron Jobs → `freshness-check-monthly`
   - Click "Run now" (if available)

**Expected**:
- Function executes
- Logs appear in Edge Functions → `freshness-check` (search `monthly-reconciliation`)
- Alert sent if any check failed

### 6. Alert Pathway

**Test**: Failed check triggers alert  
**Method**: 
1. Simulate failure: Call with bad OpenFolio URL
```bash
curl -X POST "https://imkgazlrxtlhkfptkzjc.supabase.co/functions/v1/freshness-check" \
  -H "Content-Type: application/json" \
  -d '{"mode": "monthly", "openfolio_base": "https://invalid.example"}' \
  -H "Authorization: Bearer <anon-key>"
```

2. Check logs for HMAC signing and POST to router endpoint
3. Verify email received (if router endpoint is wired)

**Expected**: Alert payload includes:
```json
{
  "v": 1,
  "environment": "dev",
  "checks": [
    { "name": "Metadata coverage", "ok": false, ... },
    ...
  ],
  "failedCount": 3
}
```

## Validation Checklist

- [ ] Migration applied, functions exist in `public` schema
- [ ] `count_synced_metadata_schemes()` returns expected count
- [ ] `count_official_composition_schemes()` returns expected count
- [ ] Monthly function call (mode='monthly') succeeds with all-pass response
- [ ] Coverage percentages calculated correctly (85% threshold)
- [ ] Disclosure date lag calculated correctly (45-day threshold)
- [ ] Failure scenarios trigger alerts via Resend router
- [ ] Cron job scheduled: `0 2 1 * *`
- [ ] Logs include `[freshness-check] monthly-reconciliation summary`

## Post-OP-1 Validation

After universe-backfill OP-1 completes:

1. **Check baseline coverage**:
   ```bash
   curl -X POST "https://imkgazlrxtlhkfptkzjc.supabase.co/functions/v1/freshness-check" \
     -H "Content-Type: application/json" \
     -d '{"mode": "monthly"}' \
     -H "Authorization: Bearer <anon-key>"
   ```
   - Expect `passedCount: 3, failedCount: 0`
   - Metadata coverage ≥ 85%
   - Composition coverage ≥ 85%
   - Disclosure lag ≤ 45 days

2. **Paste response** into GitHub PR for documentation

3. **Next month (1st)**: Monitor logs for automatic cron execution

## Rollback

If reconciliation thresholds need adjustment:

1. Update constants in `freshness-check.ts`:
   - `COVERAGE_THRESHOLD_PCT` (currently 85)
   - `DISCLOSURE_LAG_THRESHOLD_DAYS` (currently 45)

2. Re-deploy freshness-check edge function

3. To unschedule cron:
   ```sql
   SELECT cron.unschedule('freshness-check-monthly');
   ```

## Notes

- Thresholds are intentionally conservative (85% coverage tolerance) to accommodate sync delays
- Disclosure lag threshold (45 days) aligns with quarter-end disclosure batches
- All checks reuse FL-5's alert pathway (HMAC signing, Resend router)
- Pure test coverage is 100% for tolerance math; integration testing validates data freshness
