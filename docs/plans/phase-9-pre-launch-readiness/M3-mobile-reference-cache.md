# M3 Mobile Reference Data Cache

## Goal

Make mobile web and phone app portfolio loads feel fast after the first visit by caching shared historical reference data locally and fetching only new rows. The slow user-visible area is the Portfolio tab's "How your money grew" graph, which currently waits on NAV and benchmark history even though most historical rows do not change.


## User Value

After this change, a user who opens Portfolio, moves around the app, refreshes, or reopens mobile web should see the portfolio chart and related portfolio data rebuild from local device storage. Network requests should mostly ask Supabase for NAV and index rows newer than the cached latest date, instead of downloading the same historical rows again.


## Context

FolioLens is an Expo React Native app with Supabase as the backend. The Portfolio tab uses:

- `src/hooks/usePortfolio.ts` for active funds, transactions, latest NAV, 30-day NAV sparklines, and headline XIRR vs benchmark.
- `src/hooks/useInvestmentVsBenchmarkTimeline.ts` for the Portfolio "How your money grew" graph.
- `src/hooks/useMoneyTrail.ts` and `src/hooks/usePortfolioInsights.ts` for secondary cards.
- `src/hooks/useFundDetail.ts` for fund-level NAV and benchmark charts after navigating away from Portfolio.

NAV history in `nav_history` and benchmark history in `index_history` are shared reference tables. They are append-mostly daily series: old NAVs and old index closes rarely change. User transactions can change after a CAS import and should continue to come from Supabase/React Query instead of being persisted by this work.

The current app relies on React Query's in-memory cache with 5 minute stale time. That helps only while the page stays warm in memory. Mobile web reloads lose it, and inactive chart queries can be garbage-collected. The current Portfolio data path also prefetches alternate benchmark query results after the active query, multiplying user/fund/transaction reads on slower phones.


## Assumptions

- NAV and benchmark rows older than the most recent daily sync are stable enough to cache locally.
- It is acceptable to persist shared market/reference data on the device; this work will not persist full user transaction history.
- AsyncStorage is the right cross-platform storage API because it maps to local storage on web and native storage on iOS/Android.
- A cache miss or quota failure must never break the app; it should fall back to normal Supabase fetches.


## Definitions

- NAV: Net Asset Value, the daily per-unit value of a mutual fund scheme.
- Index history: daily close values for a market benchmark such as Nifty 50 TRI.
- Delta fetch: a query that requests only rows after the latest date already saved locally.
- Reference data: shared non-user-specific data, here `nav_history` and `index_history`.


## Scope

- Add a compact versioned local cache for NAV and index date/value series.
- Add delta-fetch helpers that merge cached rows with rows returned by Supabase.
- Use those helpers in Portfolio summary, Portfolio investment-vs-benchmark chart, and Fund Detail chart data.
- Increase in-memory retention for the same high-cost queries so navigating away and back does not drop the graph.
- Update tests for cache merging and adjusted hooks.
- Update README "What works now" to mention local reference-data caching.


## Out Of Scope

- Persisting user transactions or derived user portfolio summaries in local storage.
- Adding new Supabase RPCs or migrations.
- Changing the visual design of Portfolio, Fund Detail, Money Trail, or Funds.
- Optimizing every tool screen that reads NAV history. This plan focuses on the phone slowness reported around Portfolio and adjacent navigation.


## Approach

Create `src/lib/referenceDataCache.ts` with a small cache format:

- one key per NAV scheme: `foliolens:reference-series:v1:nav:<scheme_code>`
- one key per benchmark symbol: `foliolens:reference-series:v1:index:<encoded_symbol>`
- rows stored as compact `[date, value]` tuples
- sorted and deduped by date on every merge
- malformed cache entries removed and treated as misses

For each requested series and start date:

1. Read local cache.
2. If the cache starts on or before the requested start date, return cached rows for the requested range and ask Supabase only for rows after the cached latest date.
3. If the cache does not cover the requested start date, fetch the requested range from Supabase and merge it into the cache.
4. If storage read/write fails, keep returning network data and do not surface a user-facing error.

Use the helpers in:

- `usePortfolio.ts`: fetch recent NAV rows for current/previous NAV and 30-day sparklines; fetch benchmark rows from the first user transaction date via delta cache.
- `useInvestmentVsBenchmarkTimeline.ts`: fetch NAV rows from the chart start and index rows from the first transaction date via delta cache.
- `useFundDetail.ts`: fetch full fund NAV/index chart histories through the same cache so returning from Fund Detail is not cold.

Increase `staleTime` and `gcTime` on the high-cost portfolio/chart/fund-detail queries so React Query keeps derived results while the user moves between screens. Pull-to-refresh and CAS import invalidation still refetch; the reference cache turns those refetches into small delta requests.


## Alternatives Considered

- Persist every React Query result. This would be broad and would persist user-specific transactions/portfolio summaries unless heavily filtered. The narrower reference-data cache gives most of the benefit with less privacy and invalidation risk.
- Add Supabase RPCs that return precomputed portfolio chart payloads. This could be faster but adds schema/API surface area and still would not help mobile web reloads unless persisted client-side.
- Only extend React Query `staleTime`. That helps within one app session but does not solve mobile web reloads or cold starts.


## Milestones

1. Investigation and plan
   - Confirm which hooks load Portfolio graph, NAV, index, and transaction data.
   - Write this ExecPlan.
   - Acceptance: plan identifies the precise data paths and a bounded implementation.

2. Reference cache implementation
   - Add `referenceDataCache.ts`.
   - Add unit tests for compact row merge, corrupt cache handling, range coverage, and delta fetch behavior.
   - Acceptance: tests show cached rows are reused and only newer rows are requested when possible.

3. Hook integration
   - Replace direct NAV/index history reads in Portfolio, investment-vs-benchmark chart, and Fund Detail with cached helpers.
   - Avoid query prefetches that duplicate fund and transaction reads for inactive benchmarks.
   - Acceptance: existing portfolio/fund tests pass with updated mocks, and query settings retain chart data across navigation.

4. Validation and documentation
   - Run focused tests for changed hooks/cache.
   - Run `npm run typecheck` and `npm run lint`.
   - Update README.
   - Acceptance: checks pass locally, or any blocker is recorded here.


## Validation

Run:

    npm test -- src/lib/__tests__/referenceDataCache.test.ts src/hooks/__tests__/usePortfolio.test.ts src/hooks/__tests__/useInvestmentVsBenchmarkTimeline.test.ts src/hooks/__tests__/useFundDetail.test.ts
    npm run typecheck
    npm run lint

Expected outcomes:

- Cache tests pass and prove delta fetching behavior.
- Existing portfolio and fund-detail tests still pass.
- TypeScript reports zero errors.
- ESLint reports zero warnings.


## Risks And Mitigations

- Risk: local storage quota errors on mobile web. Mitigation: compact tuple storage and non-fatal write failures.
- Risk: stale historical data if a provider corrects an old NAV/index row. Mitigation: cache is versioned, and future work can bump the version or add manual cache clearing. Daily delta still catches new rows.
- Risk: caching full history for many funds increases startup JSON parse time. Mitigation: cache one series per key and only read requested scheme/symbol keys.
- Risk: changing query stale times hides fresh CAS imports. Mitigation: existing import flow invalidates queries; pull-to-refresh still refetches.


## Decision Log

- 2026-05-10: Chose targeted NAV/index reference caching over full React Query persistence to avoid persisting user transaction data and to keep invalidation simple.
- 2026-05-10: Kept transactions network-backed because CAS imports can change them and because the reported pain is repeated historical NAV/index downloads for charts.
- 2026-05-10: Removed the Portfolio/chart alternate-benchmark query prefetches. With local reference-data deltas, benchmark switches remain cheap without duplicating active fund and transaction reads in the background on slow phones.


## Progress

- [x] Read `VISION.md`, `docs/SCREENS.md`, `docs/TECH-DISCOVERY.md`, and relevant hooks.
- [x] Identified Portfolio and Fund Detail NAV/index fetch paths.
- [x] Implement reference-data cache.
- [x] Wire cache into Portfolio, chart, and Fund Detail hooks.
- [x] Add tests.
- [x] Update README.
- [x] Run focused tests, typecheck, and lint.
- [x] Run full test suite.
