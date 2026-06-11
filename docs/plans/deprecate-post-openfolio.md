# ExecPlan: Deprecate post-OpenFolio dead weight

Status: **Complete** — five phases implemented and merged.
Date: 2026-06-01 (Phase 1) → 2026-06-08 (Phases 2–4) → 2026-06-10 (Phase 5)
Branch: `chore/deprecate-stock-market-cap` (PR #191)
Depends on: [#190](https://github.com/himanshu4141/FolioLens/pull/190) (OpenFolio-Data as primary holdings source, M1–M6 merged).
Related: `docs/plans/openfolio-holdings-integration.md`, `docs/research/2026-05-29-holdings-source-openfolio-data.md`.

## Goal

Retire every piece of FolioLens that existed only to work around the absence of a real holdings source:

1. **`stock_market_cap` table + `sync-stock-market-cap` cron/function** — AMFI ISIN→Large/Mid/Small classifier, now superseded by OpenFolio's `cap_mix` field.
2. **`classifyHoldings` / `CapClassification` / `MarketCapCategory` / `amfi-xlsx-parser.ts`** — the shared helpers that drove the classifier.
3. **`morningstar_rating` and `related_variants`** — dead `scheme_master` columns that were never read by the app after M5 retired the star-rating UI.

## Why

- **OpenFolio now owns cap classification.** `source='official'` rows carry a real Large/Mid/Small split computed over the full portfolio at ~99.1% AMC coverage. Our `stock_market_cap` classifier only ever fed the backup `amfi` (mfdata) path, and that path now uses SEBI category defaults for cap — honest, and a tiny tail behind `official`.
- **Removes duplicated reference-data plumbing.** Both FolioLens and OpenFolio were parsing the same AMFI half-yearly "Categorization of Stocks" list. Consolidating into OpenFolio deletes a cron, an edge function, a table, two shared parsers, a classifier, and a bootstrap-race guard.
- **Higher fidelity.** OpenFolio's `cap_mix` is computed over the *full* holdings; our classifier only saw the disclosed equity holdings we could fetch.
- **Dead columns.** `morningstar_rating` has had no app reader since M5 (star-rating UI removed). `related_variants` was never read. Carrying them in the `scheme_master` SELECT wastes cache bandwidth and keeps dead types in `database.types.ts`.

## What each deprecated piece powered (blast-radius analysis)

### `stock_market_cap` + classifier

Read in exactly two places, both the mfdata/`amfi` cap classifier:
- `sync-fund-portfolios/index.ts` — `loadIsinToCapMap` → `classifyHoldings`, plus the empty-table bootstrap guard `shouldSkipHoldingsSyncForEmptyClassifier`.
- `fetch-fund-snapshot/index.ts` — `getIsinToCapMap` (module cache via `isCachedMapStillValid`) → `classifyHoldings`.

Nothing in `src/` read the table. Shared helpers tied to the pipeline:
- `_shared/amfi-listing-parser.ts` — removed in Phase 1.
- `_shared/amfi-xlsx-parser.ts` — removed in Phase 2.
- `_shared/portfolio-utils.ts` — `classifyHoldings`, `CapClassification`, `MarketCapCategory` removed in Phase 2 (rest of module stays).

### `morningstar_rating` / `related_variants`

- `morningstar_rating`: read by `useSchemeMaster.ts` → `useFundDetail.ts` → `ClearLensCompareFundsScreen.tsx` + `previewData.ts`, but the **UI surface that rendered it was removed in M5**. All call sites returned `null` or ignored the value. Exposed via the `fund` view.
- `related_variants`: populated by `sync-fund-meta` from mfdata, **never read** by the app.

## Source ladder after all phases

```
official (OpenFolio, real cap, real holdings)
  → category_fallback (mfdata: real asset mix / sectors / debt, cap from SEBI defaults)
  → category_rules (SEBI rules only, no holdings)
```

The `amfi` source tag no longer exists — mfdata rows that formerly had a real cap split (via the classifier) now write as `category_fallback`, which is the honest label: real holdings, category-average cap.

---

## Phases

### Phase 1 — stop the population mechanism ✅ (2026-06-01)

Safe to merge anytime. Zero behavioral regression: the AMFI cap list is static reference data refreshed twice a year; a frozen snapshot stays accurate for months.

**Changes:**
- Migration: `cron.unschedule('sync-stock-market-cap-monthly')` (idempotent).
- Delete `supabase/functions/sync-stock-market-cap/` edge function.
- Delete `_shared/amfi-listing-parser.ts` + its test.
- Docs: drop the `sync-stock-market-cap` row from INFRASTRUCTURE; note the table is frozen pending Phase 2.

**Commit:** `af03ae0 chore(composition): deprecate stock_market_cap pipeline — Phase 1 (stop population)`

**Gating note:** Phase 1 was deliberately separated from Phase 2 to allow merge before the OpenFolio-prod-coverage gate passed.

### Phase 2 — drop the data + the classifier ✅ (2026-06-08)

**Gate:** [#190](https://github.com/himanshu4141/FolioLens/pull/190) merged (M1–M6 all in); OpenFolio-Data at full coverage in prod with `cap_mix` populated for a representative sample; dev backfill confirms `official` equity rows carry real Large/Mid/Small.

**Changes:**
- `supabase/migrations/20260608000001_drop_stock_market_cap.sql` — `DROP TABLE IF EXISTS public.stock_market_cap CASCADE`.
- `sync-fund-portfolios/index.ts` — removed `loadIsinToCapMap`, `classifyHoldings` call, `shouldSkipHoldingsSyncForEmptyClassifier` guard. The mfdata path still fetches holdings (asset mix, sectors, debt, top holdings); cap comes from `getCategoryRules` SEBI defaults. Source tag always `'category_fallback'`. Removed classifier-related analytics fields.
- `fetch-fund-snapshot/index.ts` — removed `getIsinToCapMap` module cache (the `cachedIsinToCap` / `cachedIsinToCapAt` / `CAP_MAP_TTL_MS` / `getIsinToCapMap` block), `classifyHoldings` call. Source tag always `'category_fallback'`.
- `_shared/amfi-xlsx-parser.ts` + its test — deleted.
- `_shared/portfolio-utils.ts` — removed `classifyHoldings`, `CapClassification`, `MarketCapCategory` + their tests.

**Commit:** `d5a2c46 chore(composition): Phase 2 — DROP stock_market_cap + remove ISIN→cap classifier`

**Validation:** 1346 tests, 62 suites — all pass. `npm run typecheck` (0), `npm run lint` (0).

### Phase 3 — drop dead `scheme_master` columns ✅ (2026-06-08)

**Changes:**
- `supabase/migrations/20260608000002_drop_morningstar_related_variants.sql` — drops and recreates the `fund` view without those columns (restoring grants), then `ALTER TABLE scheme_master DROP COLUMN IF EXISTS morningstar_rating, related_variants`.
- `sync-fund-meta/index.ts` — removed `morningstar_rating` and `related_variants` from the mfdata payload and the upsert.
- `fetch-fund-snapshot/index.ts` — removed from `syncMeta`.
- `src/hooks/useSchemeMaster.ts` — removed from `SCHEME_MASTER_COLUMNS` select string and `SchemeMasterDbRow` interface.
- `src/hooks/useFundDetail.ts` — removed `morningstarRating` from `FundDetailData` interface and all return sites.
- `src/components/clearLens/screens/tools/ClearLensCompareFundsScreen.tsx` — removed from local `SchemeMasterRow` interface and mapper.
- `src/lib/previewData.ts` — removed from `buildPreviewFundDetail` fixture.
- `src/types/database.types.ts` — removed from `scheme_master` Row/Insert/Update + `fund` view Row.
- `src/lib/queryClient.ts` — bumped `__BUSTER__` v6 → v7 (see `cache-surfaces.md`).

**Commit:** `6ecf71f chore(schema): Phase 3 — drop morningstar_rating + related_variants`

**Validation:** 1346 tests, 62 suites — all pass. `npm run typecheck` (0), `npm run lint` (0).

### Phase 4 — documentation ✅ (2026-06-08)

Update every doc that referenced the retired pipeline, the dead columns, or the old schema state.

**Changes:**
- `docs/plans/deprecate-stock-market-cap.md` → renamed to `docs/plans/deprecate-post-openfolio.md` and expanded to cover all phases.
- `docs/architecture/data-sync-pipeline.md` — removed `sync-stock-market-cap` from all mermaid diagrams; updated schedules text; demoted mfapi/mfdata to backup-only; removed deprecated section sequence diagram.
- `docs/TECH-DISCOVERY.md` — updated Holdings/Composition section to reflect current source ladder; removed `stock_market_cap` from data sources; updated morningstar note.
- `docs/architecture/cache-surfaces.md` — removed the module-scope ISIN→cap cache from Surface #2; updated `__BUSTER__` reference to v7; marked audit finding #7 resolved.
- `docs/EXIT-RUNBOOK.md` — updated pg_cron job count (5→4); removed `sync-stock-market-cap` from schedule list.
- `README.md` — updated Portfolio Insights description to remove `sync-stock-market-cap` reference and AMFI stock categorization mention.

---

## Rollback notes

- **Phase 1** (Phase 1 only) is reversible: re-deploy `sync-stock-market-cap` + re-schedule the cron. The `stock_market_cap` table still holds its last snapshot.
- **Phase 2** is the point of no return — `DROP TABLE` is irreversible in prod. Justified by the gate: confirmed OpenFolio coverage before merge. If coverage regresses, the recovery path is to re-seed `stock_market_cap` from git history + re-add the classifier — but `official` rows are unaffected, so the regression only impacts the ~0.9% tail.
- **Phase 3** (`morningstar_rating`, `related_variants`) — no recovery path is needed; no app surface reads these values.

### Phase 5 — retire pre-OpenFolio universe backfill ✅ (2026-06-10)

The `backfill-fund-universe.yml` GitHub Actions workflow and its companion script
`scripts/backfill-fund-universe.mjs` were originally built to pre-hydrate the full
~37k AMFI universe so Compare Funds and Past SIP Check had sub-50ms reads.  The
workflow has been timing out nightly since 2026-06-02 and its design is incompatible
with the post-#191 architecture:

- It wrote `source:'amfi'` composition rows — a source tag retired by #191.
  mfdata rows now write as `source:'category_fallback'`.
- Its stage 3 (full NAV history via mfapi.in) drives 8.8 M rows (98.8 % unheld),
  the 1.6 GB NAV history load that causes the timeouts.
- Universe pre-hydration is superseded by the OpenFolio chunked backfill
  (`supabase/functions/universe-backfill/`) + existing on-pick `fetch-fund-snapshot`
  hydration.

**Tradeoff accepted:** The old script gave a proactive full-universe NAV history
pre-seed (every scheme, not just held funds).  The replacement path (`universe-backfill`
edge function) covers composition + metadata for the full universe via OpenFolio, but
delegates NAV history to the on-demand path (`sync-nav` for held funds + per-scheme
`fetch-fund-nav` at pick time).  Compare Funds and Past SIP Check don't need NAV
history for the picker UX — only the Fund Detail NAV chart does, and that is already
served by the on-pick path.

**Changes:**
- Delete `.github/workflows/backfill-fund-universe.yml`.
- Delete `scripts/backfill-fund-universe.mjs`.
- `supabase/migrations/20260610000000_drop_scheme_master_backfill_columns.sql` — drops
  `idx_scheme_master_backfill_rotation` index and the four workflow-state columns
  (`last_backfill_attempted_at`, `backfill_outcome`, `backfill_failure_count`,
  `is_inactive`) from `scheme_master`.  No app read paths ever touched these columns
  (not in `database.types.ts`, not in `src/`, not in any Edge Function).
- Docs: updated `data-sync-pipeline.md`, README workflows table, this plan.

**Confirmed:** `src/types/database.types.ts`, `src/`, and all Edge Functions have zero
references to the dropped columns.  Migration is a pure DROP with no view rebuild
required (the `fund` view never projected these columns).

**NOT done in this PR:** nav_history rows written by the old script are left intact.
Row-level cleanup (delete unheld rows older than N days) is a separate follow-up PR
so it can be gated on a clear retention policy decision.

### Phase 6 — retire last legacy writers ✅ (2026-06-11)

The `sync-amfi-portfolios.yml` GitHub Actions workflow and its companion script
`scripts/sync-amfi-portfolios.mjs` were the last remaining pre-OpenFolio scheduled writer.
Despite the prod freeze policy, the workflow was still scheduled to run monthly (cron: '0 6 11 * *')
and its prod job block gave it write access to production. The workflow is now defunct:

- The `stock_market_cap` table (which it relied upon) was dropped in Phase 2.
- No schema supports the `source='amfi'` tag it would have written.
- Dev had zero `source='amfi'` rows as of 2026-06-11 06:00 UTC (the last scheduled run).

**Related:** `backfill-stock-market-cap.yml` + `scripts/backfill-stock-market-cap.mjs`
targeted the dropped `stock_market_cap` table and failed on every run.
Both also deleted along with the scheduled AMFI writer.

**Deployed functions cleaned up:** `diag-nav` (stale, last updated 2026-03-25)
and `sync-stock-market-cap` (noop since Phase 1) deleted from dev via
`supabase functions delete <slug>`.

**Changes:**
- Delete `.github/workflows/sync-amfi-portfolios.yml`.
- Delete `scripts/sync-amfi-portfolios.mjs`.
- Delete `.github/workflows/backfill-stock-market-cap.yml`.
- Delete `scripts/backfill-stock-market-cap.mjs`.
- Delete deployed Edge Functions `diag-nav` and `sync-stock-market-cap` from dev.
- Docs: updated `README.md` workflows table, `data-sync-pipeline.md`.

**Tradeoff accepted:** Prod still carries legacy `source='amfi'` rows from before the freeze.
`COMPOSITION_SOURCE_RANK` retains its 'amfi' entry to avoid a prod compatibility break.
Post-prod-cleanup removal of the rank entry and legacy rows is a separate future task.

**Rationale:** The writer violated the production freeze policy, was non-functional
(produced zero rows in dev), and both it and the backfill job targeted deprecated infrastructure.
Deletion reduces noise and clarifies the true active writer set.

---

## Risks accepted

- **~0.9% of schemes** (mfdata tail not covered by OpenFolio) now show category-average cap with the existing disclaimer. Honest and acceptable.
- **Single source of truth for cap** — mitigated: FolioLens caches into its own Postgres, so an OpenFolio outage doesn't affect request-time composition reads.
- **NAV history for non-held schemes** — the old script proactively pre-seeded NAV history for the full universe; this is no longer done.  Non-held schemes populate NAV history on-demand at pick time via `fetch-fund-nav`.  First-open latency for a never-held scheme in Past SIP Check / Compare is acceptable (single fetch, ~200ms) given the tail traffic these tools see.
