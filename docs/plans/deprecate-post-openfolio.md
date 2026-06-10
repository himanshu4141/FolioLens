# ExecPlan: Deprecate post-OpenFolio dead weight

Status: **Complete** — all four phases implemented and merged.
Date: 2026-06-01 (Phase 1) → 2026-06-08 (Phases 2–4)
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

## Risks accepted

- **~0.9% of schemes** (mfdata tail not covered by OpenFolio) now show category-average cap with the existing disclaimer. Honest and acceptable.
- **Single source of truth for cap** — mitigated: FolioLens caches into its own Postgres, so an OpenFolio outage doesn't affect request-time composition reads.
