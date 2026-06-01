# ExecPlan: Deprecate `stock_market_cap` + `sync-stock-market-cap`

Status: Draft — Phase 1 implemented; Phase 2 gated (see Gating). DO NOT MERGE until the gate passes.
Date: 2026-06-01
Depends on: [#190](https://github.com/himanshu4141/FolioLens/pull/190) (OpenFolio-Data as primary holdings source). Branch is stacked on `feat/openfolio-holdings`.
Related: `docs/plans/openfolio-holdings-integration.md`, `docs/research/2026-05-29-holdings-source-openfolio-data.md`.

## Goal
Retire FolioLens's own market-cap classification pipeline — the `stock_market_cap`
table (AMFI ISIN→Large/Mid/Small) and the `sync-stock-market-cap` cron/edge function that
populates it — and rely on **OpenFolio-Data** for the cap split, now that OpenFolio publishes
a real `cap_mix` per fund (its `cap_bucket`/`cap_mix` fields are populated as of 2026-06-01)
across all 50 AMCs at ~99.1% coverage.

## Why
- **OpenFolio now owns this.** `source='official'` rows already carry a real Large/Mid/Small/
  Unclassified split computed over the full portfolio (verified live: scheme 122639 →
  `large 61.4 / mid 0.26 / small 2.5 / unclassified 16.65`). Our `stock_market_cap` classifier
  only ever fed the **backup** `amfi` (mfdata) path.
- **Removes duplicated reference-data plumbing.** Both services parsed the same AMFI half-yearly
  "Categorization of Stocks" list. Consolidating it into OpenFolio (the data product whose job
  is reference data) deletes a cron, an edge function, a table, two shared parsers, a classifier,
  and a bootstrap-race guard from FolioLens — an exit-runbook "shrink the surface" win.
- **Higher fidelity.** OpenFolio's `cap_mix` is computed over the *full* holdings; our classifier
  only saw the disclosed equity holdings we could fetch.

## What `stock_market_cap` powers today (so we know the blast radius)
Read in exactly two places, both the mfdata/`amfi` cap classifier:
- `supabase/functions/sync-fund-portfolios/index.ts` — `loadIsinToCapMap` → `classifyHoldings`,
  plus the empty-table bootstrap guard `shouldSkipHoldingsSyncForEmptyClassifier`.
- `supabase/functions/fetch-fund-snapshot/index.ts` — `getIsinToCapMap` (module cache via
  `isCachedMapStillValid`) → `classifyHoldings`.

Nothing in `src/` reads it. Shared helpers tied to the pipeline:
- `_shared/amfi-listing-parser.ts` — used **only** by `sync-stock-market-cap`.
- `_shared/amfi-xlsx-parser.ts` — `parseAmfiRows`/`validateBucketShape`/`countBuckets`/
  `AMFI_SANITY_BOUNDS` used only by `sync-stock-market-cap`; `isCachedMapStillValid` +
  `shouldSkipHoldingsSyncForEmptyClassifier` used by the two composition functions.
- `_shared/portfolio-utils.ts` — `classifyHoldings`, `CapClassification`, `MarketCapCategory`
  used only by the two composition functions (the rest of the module stays).

## Source ladder after deprecation
`official` (OpenFolio, real cap) → `amfi` (mfdata: real asset mix / sectors / debt / holdings,
**cap from SEBI category defaults**) → `category_fallback` → `category_rules`. The `amfi` path
keeps its mfdata holdings as a backup for the ~0.9% OpenFolio doesn't cover; it just no longer
computes a per-fund cap split (those funds show the existing "category averages" disclaimer —
honest, and they're a tiny tail behind `official`).

## Phases

### Phase 1 — stop the population mechanism (implemented here; safe to merge anytime)
Zero behavioral regression: the AMFI cap list is static reference data refreshed twice a year,
so a frozen `stock_market_cap` snapshot stays accurate for months while OpenFolio is proven out.
- Migration: `cron.unschedule('sync-stock-market-cap-monthly')` (idempotent).
- Delete the `sync-stock-market-cap` edge function.
- Delete `_shared/amfi-listing-parser.ts` (+ its test) — only that function used it.
- Docs: drop the `sync-stock-market-cap` row + cron from INFRASTRUCTURE / EXIT-RUNBOOK; note the
  table is frozen pending Phase 2.

### Phase 2 — drop the data + the classifier (gated; lands on this same branch before un-drafting)
- Migration: `DROP TABLE IF EXISTS public.stock_market_cap`.
- `sync-fund-portfolios` + `fetch-fund-snapshot`: remove `loadIsinToCapMap`/`getIsinToCapMap`,
  the `classifyHoldings` call, and the `shouldSkipHoldingsSyncForEmptyClassifier` guard. The
  mfdata path still fetches holdings (asset mix, sectors, debt, top holdings); cap comes from the
  SEBI category defaults already computed in `getCategoryRules`. Tag those rows
  `category_fallback` (real holdings, category cap — exactly what that source already means).
- Remove the now-dead `_shared/amfi-xlsx-parser.ts` (+ test) and `classifyHoldings` /
  `CapClassification` / `MarketCapCategory` from `_shared/portfolio-utils.ts` (+ their tests);
  drop the corresponding `collectCoverageFrom` entries.
- Remove classifier-related analytics fields (`classifier_*`, `classifier_table_*`) from the
  `sync-fund-portfolios` event.
- Docs: README, TECH-DISCOVERY (the cap-split row), cache-surfaces (remove the classifier
  module-cache + the `stock_market_cap` table entries).

## Gating (all required before un-drafting / merge)
1. [#190](https://github.com/himanshu4141/FolioLens/pull/190) merged to `main` (this branch rebased onto it).
2. OpenFolio-Data at full coverage in prod (`/health` shows the full 50-AMC scheme count and a
   sane `latest_disclosure_date`, not the in-rebuild `2055-08-18` artifact) and `cap_mix`
   populated for a representative sample.
3. The dev backfill (`openfolio-sync` `mode:backfill`) confirms `official` equity rows now carry
   real Large/Mid/Small (not all `not_classified`).
4. Phase 2 committed, then the refactored `sync-fund-portfolios` + `fetch-fund-snapshot` deployed
   to **dev** and smoke-tested (edge functions are excluded from `tsc`/`eslint`, so dev is the
   only typecheck for them).

## Validation
- `npm run typecheck` (0) · `npm run lint` (0) · `npx jest --coverage` (thresholds hold).
- Dev smoke: pick a fund with no `official` row, invoke `fetch-fund-snapshot`, confirm it writes a
  `category_fallback` row with real sectors/holdings and category cap — no error from a missing
  `stock_market_cap` table.
- Confirm `cron.job` no longer lists `sync-stock-market-cap-monthly`.

## Rollback
- Phase 1 is reversible by re-deploying `sync-stock-market-cap` and re-scheduling the cron.
- Phase 2's `DROP TABLE` is the point of no return — that's why it's gated on confirmed OpenFolio
  coverage. If OpenFolio coverage regresses after merge, the recovery is to re-seed
  `stock_market_cap` (re-add the function from git history) rather than revert composition, since
  `official` rows are unaffected.

## Risks
- **OpenFolio cap coverage < expected** → the ~0.9% tail shows category-average cap (with the
  existing disclaimer) instead of a classified split. Acceptable; honest; gated on validation.
- **Single source of truth** for cap classification → mitigated: we cache into our own Postgres
  (request-time unaffected by an OpenFolio outage), and OpenFolio can expose the raw ISIN→cap map
  (`/v1/isin/{isin}`) if we ever want an independent copy.
