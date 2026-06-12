# OpenFolio DEV Reset and Backfill Report - 2026-06-12

## 1. Commits Reviewed

| Repository | Ref | SHA |
| --- | --- | --- |
| FolioLens | origin/main | `da3432c1a0a827b5518e58ae31a68b0cbfa352ac` |
| OpenFolio-Data | origin/main | `92b37603a4276ca087ac4f9f5c0cd60919dcc40f` |

Timestamp: `2026-06-12T10:28:33Z` during the manual backfill loop.

## 2. Deployments Reviewed

| Component | DEV State |
| --- | --- |
| Supabase project | `FundLens-Dev`, ref `imkgazlrxtlhkfptkzjc` |
| Production project | Not touched, ref `ohcaaioabjvzewfysqgh` |
| OpenFolio image | `asia-south1-docker.pkg.dev/fund-lens/openfolio/mfholdings:92b37603a4276ca087ac4f9f5c0cd60919dcc40f` |
| OpenFolio API health | `status=ok`, `db_schemes=2046`, `latest_disclosure_date=2026-06-12` |
| Cloud Run | `openfolio-api` Ready, revision `openfolio-api-00047-fjt`, 100% traffic |
| Cloud Run jobs | `openfolio-ingest`, `openfolio-nav-backfill`, `openfolio-nav-daily` Ready |
| GCS bucket | `gs://fund-lens-openfolio`, region `ASIA-SOUTH1`, versioning enabled |
| Required functions | `universe-backfill`, `sync-fund-meta`, `sync-nav`, `openfolio-sync`, `fetch-fund-snapshot`, `fetch-fund-nav`, `freshness-check`, `nav-retention` all deployed/active |
| Post-fix function deploys | `universe-backfill` v38, `freshness-check` v8, both `verify_jwt=false` in DEV |

The GitHub workflow `.github/workflows/universe-backfill.yml` exists, is active, and was manually dispatched. GitHub cron was not used as the driver.

## 3. Exact Reset Performed

Backup schema created: `dev_openfolio_reset_backup_20260612_0936`.

The destructive reset preserved identity/search/mapping fields and cleared only fields intended to be proven rebuilt:

```sql
-- Backups were created for metadata, composition, app_config backfill markers,
-- and unheld NAV rows in dev_openfolio_reset_backup_20260612_0936.

UPDATE public.scheme_master
SET
  expense_ratio = NULL,
  aum_cr = NULL,
  min_sip_amount = NULL,
  fund_meta_synced_at = NULL,
  mfdata_family_id = NULL,
  declared_benchmark_name = NULL,
  risk_label = NULL,
  mfdata_meta_synced_at = NULL,
  launch_date = NULL,
  exit_load = NULL,
  min_lumpsum = NULL,
  min_additional = NULL,
  period_returns = NULL,
  risk_ratios = NULL,
  ter_date = NULL,
  fund_manager = NULL,
  portfolio_turnover = NULL,
  openfolio_meta_synced_at = NULL,
  nav_backfilled_at = CASE
    WHEN scheme_code IN (SELECT DISTINCT scheme_code FROM public.user_fund)
    THEN nav_backfilled_at
    ELSE NULL
  END;

DELETE FROM public.fund_portfolio_composition;

DELETE FROM public.app_config
WHERE key LIKE 'universe_backfill_%';

DELETE FROM public.nav_history
WHERE scheme_code NOT IN (SELECT DISTINCT scheme_code FROM public.user_fund);

ANALYZE public.scheme_master;
ANALYZE public.fund_portfolio_composition;
ANALYZE public.nav_history;
ANALYZE public.app_config;
```

During the backfill loop, one stale composition cursor created by a function bug was also removed after explicit approval:

```sql
DELETE FROM public.app_config
WHERE key = 'universe_backfill_composition_cursor';
```

## 4. Preserved Tables

Preserved: `auth`, migrations, `user_fund`, `transaction`, `cas_import`, `user_profile`, `app_user`, `index_history`, held `nav_history`, and scheme identity/search/mapping columns in `scheme_master`.

Preserved scheme columns included `scheme_code`, `scheme_name`, `isin`, `scheme_category`, `sebi_category`, `benchmark_index`, `benchmark_index_symbol`, `amc_name`, `family_name`, `amc_slug`, `plan_type`, `option_type`, and `scheme_active`.

## 5. Cleared Tables/Columns

Cleared: OpenFolio/mfdata-derived metadata columns listed in section 3, all `fund_portfolio_composition` rows, all `universe_backfill_%` progress markers, and unheld NAV history.

Rationale: these fields are sync-derived and rebuilt by OpenFolio universe backfill, `fetch-fund-snapshot`, `sync-fund-meta`, `fetch-fund-nav`, or scheduled sync jobs. Identity/search/mapping fields were preserved so the backfill could join deterministically.

Rollback: backup tables were created before the reset; the reset was scoped to DEV only.

## 6. Before Metrics

| Metric | Before Reset |
| --- | ---: |
| `scheme_master` rows | 37,595 |
| `nav_history` rows | 123,831 |
| `fund_portfolio_composition` rows | 3,863 |
| `index_history` rows | 88,753 |
| `user_fund` rows | 39 |
| `transaction` rows | 1,708 |
| `cas_import` rows | 18 |
| `user_profile` rows | 5 |
| `app_user` rows | 9 |
| OpenFolio metadata synced | 3,234 |
| TER coverage | 2,379 |
| AUM coverage | 70 |
| returns coverage | 3,205 |
| risk coverage | 1,832 |
| fund manager coverage | 1,601 |
| official composition schemes | 3,687 |
| unheld NAV rows | 22,273 |

Initial backfill markers before reset included stale/incomplete metadata and composition cursors with `metadata.failed=106`.

## 7. After Metrics

After reset, before backfill: metadata coverage was zero, composition rows were zero, unheld NAV rows were zero, and user data counts were unchanged.

Final post-validation metrics:

| Metric | Final DEV |
| --- | ---: |
| `scheme_master` rows | 37,595 |
| `nav_history` rows | 104,863 |
| `fund_portfolio_composition` rows | 8,296 |
| `index_history` rows | 88,753 |
| `user_fund` rows | 39 |
| `transaction` rows | 1,708 |
| `cas_import` rows | 18 |
| `user_profile` rows | 5 |
| `app_user` rows | 9 |
| `app_config` rows | 3 |
| NAV schemes | 36 |
| held NAV rows | 101,558 |
| unheld NAV rows | 3,305 |
| latest NAV date | 2026-06-11 |
| index rows | 88,753 |
| latest index date | 2026-06-12 |

The `3,305` unheld NAV rows were created deliberately by functional validation of `fetch-fund-nav` for non-held scheme `119648`.

## 8. Workflow Run History

| Run ID | Duration | Conclusion | Cursor Before | Cursor After | Failures | Notes |
| --- | ---: | --- | --- | --- | ---: | --- |
| `27408434782` | 8m25s | success | comp 1, meta 1 | comp 9, meta 9 | metadata 56 | Exposed invalid integer writes for decimal minimum amounts. |
| `27409332973` | 7m22s | success | comp 9, meta rewound to 1 | comp 17, meta 9 | 0 | Patched integer-only minimum handling; deployed `universe-backfill` v37. |
| `27409706797` | 6m17s | success | comp 17, meta 9 | comp 25, meta 17 | 0 | Clean progress. |
| `27410072350` | 5m35s | success | comp 25, meta 17 | comp 33, meta 25 | 0 | Clean progress. |
| `27410373403` | 7m02s | success | comp 33, meta 25 | comp done, meta 33 | composition 2 transient | Page 39 replay proved 0 missing rows; composition done marker written. |
| `27410867661` | 3m45s | cancelled | comp done, meta 33 | meta 38, stale comp cursor 6 | 0 | Found `phase=both` done-marker fall-through bug; cancelled and patched. |
| `27411306090` | 1m39s | success | comp done, meta 38 | comp done, meta 46 | 0 | Patched `universe-backfill` v38 skipped composition correctly. |
| `27411411091` | 1m12s | success | comp done, meta 46 | both done | 0 | Backfill complete. |

Earlier run `27406345140` had failed pre-reset because the metadata failed count grew by 106.

## 9. Cursor Progression

Final `app_config` markers:

| Key | Value |
| --- | --- |
| `universe_backfill_composition_done_at` | `2026-06-12T10:41:32.474Z` |
| `universe_backfill_metadata_done_at` | `2026-06-12T10:58:39.680Z` |

No active `universe_backfill_%_cursor` rows remain.

## 10. Metadata Coverage

| Active Universe Metric | Count | Coverage |
| --- | ---: | ---: |
| Active schemes | 8,351 | 100.0% |
| OpenFolio metadata synced | 8,351 | 100.0% |
| TER | 8,255 | 98.9% |
| AUM | 0 | 0.0% |
| Returns | 7,769 | 93.0% |
| Risk ratios | 8,243 | 98.7% |
| Fund manager | 5,556 | 66.5% |
| Category | 7,318 | 87.6% |

Across all schemes, `openfolio_meta_synced_at` is present for 14,100 rows.

## 11. Composition Coverage

| Metric | Value |
| --- | ---: |
| Official composition rows | 8,296 |
| Distinct schemes with official composition | 8,296 |
| Active schemes with official composition | 8,020 / 8,351 |
| Oldest official portfolio date | 2021-12-23 |
| Newest official portfolio date | 2026-06-12 |
| Composition table size | 20 MB |

The 2 transient composition failures in run `27410373403` were diagnosed by replaying page 39 in a rollback-only transaction. All `290 / 290` expected page rows were present afterward; no missing rows remained.

## 12. Compare Readiness

| Readiness Definition | Active Funds Ready |
| --- | ---: |
| Core: metadata + returns + risk + category + composition | 6,614 / 8,351 |
| Core + TER | 6,614 / 8,351 |

Main blockers:

| Gap | Active Funds Affected |
| --- | ---: |
| Missing AUM | 8,351 |
| Missing category | 1,033 |
| Missing returns | 582 |
| Missing official composition | 331 |
| Missing risk | 108 |
| Missing TER | 96 |

Held-fund compare readiness is good for current held schemes. One held matured/closed scheme, `142499` (`DSP A.C.E. Fund - Series 2 - Dir - Growth Mat Dt.28-Jun-2021`), has stale NAV and no OpenFolio metadata/composition.

Answer to “Would I be comfortable letting a beta user compare any random fund in India?”: **No, not any random fund yet.** I would be comfortable with beta compare for the ready subset and held-fund common paths, but random active-fund coverage is not universal because AUM is absent, category gaps affect 1,033 active schemes, and 331 active schemes lack official composition.

## 13. NAV and Storage Metrics

| Table | Rows | Size |
| --- | ---: | ---: |
| `index_history` | 88,753 | 48 MB |
| `scheme_master` | 37,595 | 45 MB |
| `nav_history` | 104,863 | 23 MB |
| `fund_portfolio_composition` | 8,296 | 20 MB |

NAV:

| Metric | Value |
| --- | ---: |
| Oldest NAV | 2007-01-22 |
| Newest NAV | 2026-06-11 |
| Held schemes | 36 |
| Held schemes with NAV | 35 |
| Held schemes fresh within 3 days | 34 |
| Unheld NAV rows | 3,305 |

Held NAV exceptions:

| Scheme | Issue |
| ---: | --- |
| `130503` | Held scheme has no NAV rows. |
| `142499` | Matured/closed scheme latest NAV is 2021-06-28. |

## 14. Sample Fund Coverage

Random active non-held sample of 20 funds:

| Scheme | TER | AUM | Returns | Risk | Category | Composition |
| ---: | --- | --- | --- | --- | --- | --- |
| 100079 | yes | no | yes | yes | Medium Duration | yes |
| 101714 | yes | no | yes | yes | Liquid Fund | yes |
| 102676 | yes | no | yes | yes | Debt | yes |
| 103819 | yes | no | yes | yes | Large & Mid Cap Fund | yes |
| 119351 | yes | no | yes | yes | ELSS | yes |
| 120563 | yes | no | yes | yes | Debt | yes |
| 126687 | yes | no | yes | yes | Corporate Bond Fund | yes |
| 143167 | yes | no | yes | yes | Aggressive Hybrid Fund | yes |
| 144191 | yes | no | yes | yes | Ultra Short Duration Fund | yes |
| 146066 | yes | no | yes | yes | Overnight Fund | yes |
| 147518 | yes | no | yes | yes | Overnight Fund | yes |
| 148520 | yes | no | yes | yes | Small Cap Fund | yes |
| 149384 | yes | no | yes | yes | Multi Cap Fund | yes |
| 150238 | yes | no | yes | yes | Corporate Bond Fund | yes |
| 151305 | yes | no | yes | yes | Index Fund | yes |
| 151308 | yes | no | yes | yes | Hybrid | yes |
| 152010 | yes | no | yes | yes | Focused Fund | yes |
| 152571 | yes | no | yes | yes | Index Fund | yes |
| 153144 | yes | no | yes | yes | Index Fund | yes |
| 153780 | yes | no | no | yes | Equity | yes |

Sample result: `19 / 20` had returns, `20 / 20` had TER/risk/composition/category, and `0 / 20` had AUM.

## 15. Functional Validation Results

| Area | Result |
| --- | --- |
| Portfolio current NAV | Pass for active held NAV aggregate: latest held NAV is 2026-06-11 and freshness-check now passes. Exceptions are one no-NAV held scheme and one matured 2021 scheme. |
| Fund Detail, held fund | `fetch-fund-snapshot` for `118955` returned HTTP 200, `meta_status=fetched`, `composition_status=cache_hit`. `fetch-fund-nav` returned HTTP 200, `status=cache_hit`, `last_nav_date=2026-06-11`. |
| Fund Detail, non-held fund | `fetch-fund-snapshot` for `119648` returned HTTP 200, `meta_status=fetched`, `composition_status=cache_hit`. `fetch-fund-nav` returned HTTP 200, `status=fetched`, `rows_upserted=3305`, `last_nav_date=2026-06-11`. |
| Compare, held funds | Current held funds are metadata/TER/returns/risk/category/composition-ready except matured scheme `142499`. |
| Compare, random active funds | Works for ready subset; not universal due category/composition/returns gaps and AUM absence. |
| Missing-data behavior | Gaps are measurable; UI must continue to show missing-data states for AUM/category/composition/returns. |
| Search | DB probe for “HDFC Small Cap” returned active schemes first. Inactive discoverability is retained by searching `scheme_master`; active ordering is implemented in `src/utils/fundSearch.ts`. |
| Freshness | Initial `freshness-check` failed due stale query against `user_fund.nav_date`; patched and deployed. Final result: HTTP 200, `ok=true`, `passedCount=5`, `failedCount=0`. |

## 16. Remaining Issues

1. AUM is not populated by the backfill: active AUM coverage is `0 / 8,351`.
2. Compare is not universal: core ready coverage is `6,614 / 8,351` active funds.
3. 1,033 active schemes lack category, and 331 active schemes lack official composition.
4. One held scheme has no NAV rows: `130503`.
5. One held matured scheme has stale NAV and no current OpenFolio coverage: `142499`.
6. The workflow driver treats `composition.failed=2` as acceptable because the final done response after cursor deletion reports zero; a stricter persistent failure audit would be better.
7. GitHub Actions still contains schedule config, but this run intentionally used manual dispatch only.

## 17. Follow-up PRs

1. Add AUM ingestion or explicitly remove AUM from beta compare readiness gates.
2. Backfill or infer missing categories for active schemes with no `scheme_category`/`sebi_category`.
3. Add a persisted backfill run audit table so transient row failures survive cursor deletion.
4. Harden compare missing-data UX for AUM/category/composition/returns gaps.
5. Investigate held scheme `130503` missing NAV and model matured scheme `142499` as closed/stale rather than unhealthy.
6. Consider making `universe-backfill` fail on any row-level failure unless an explicit allowlist/replay proves no missing rows.

## Final Verdict

**AMBER - mostly clean, known blockers remain.**

The DEV reset and backfill are clean and complete for the defined OpenFolio metadata and composition phases: both done markers exist and no active cursors remain. The system is beta-usable for the ready subset and common held-fund workflows, but not beta-ready for comparing any random Indian fund because AUM coverage is zero and compare core readiness is only `6,614 / 8,351` active funds.
