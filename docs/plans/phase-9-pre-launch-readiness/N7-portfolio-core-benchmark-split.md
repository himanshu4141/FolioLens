# Navigation N7 — Portfolio core and benchmark split

## Goal

Make Portfolio compute benchmark-independent holdings data once, cache that core result, and switch benchmarks by doing only benchmark-specific index work. Preserve the existing `usePortfolio()` public result shape so Portfolio, Funds, Fund Detail cached selectors, Wealth Journey, onboarding, and insights keep rendering the same financial outputs.

## User Value

Users should be able to open Portfolio, switch benchmark pills, and navigate away without hidden duplicate portfolio aggregations blocking taps elsewhere. A benchmark switch should reuse the already-computed fund cards, totals, units, realized gains, and portfolio XIRR instead of rebuilding all holdings work for every benchmark.

## Context

The accepted navigation audit lives on `origin/codex/app-navigation-performance-audit` and is read-only for this program. Section 3 identifies `src/hooks/usePortfolio.ts` as a P0 source of duplicate JavaScript work: the old shape caches one full `['portfolio', userId, benchmarkSymbol]` query per benchmark, and each benchmark variant rereads funds, transactions, recent NAV rows, normalizes transactions, computes fund cards, realized gains, portfolio XIRR, and then computes market XIRR. Most of that work is identical for all benchmark choices.

This branch is `program/n7-portfolio-core-benchmark-split`, created from `origin/main` after the N6 merge `184fe50832267071677dad3829572209b58fff34`. PR #250 is the mutable program control plane. N7 is marked In progress there. The research report must not be edited during N7.

Earlier milestones already removed the legacy no-argument `^NSEI` default, made benchmark prefetch event-driven instead of eager, and kept hidden screens disabled with focus gates. N7 must not undo those changes.

## Assumptions

- `usePortfolio(defaultBenchmarkSymbol)` must continue returning `{ fundCards, summary }` with the same field names and numeric meaning.
- Preview mode can continue returning `PREVIEW_FUND_CARDS` and `PREVIEW_PORTFOLIO_SUMMARY` directly because it does not run production calculations.
- Recent NAV data for the Portfolio cards remains a 90-day window; N7 does not expand historical NAV coverage.
- Benchmark-specific work means index-history loading, index SQLite write-back, benchmark lookup construction, and `computeBenchmarkXirr`.
- The existing `['portfolio', userId, benchmarkSymbol]` cache key remains the composed public query used by screen code and persisted cache consumers. A new core query key can sit underneath it.
- Native Android evidence is required for the final runtime SHA unless the final PR head is documentation-only after accepted runtime evidence.

## Definitions

- Portfolio core: benchmark-independent data derived from the user's active funds, transactions, and recent NAV rows. It includes normalized per-fund transaction streams, fund cards, totals, latest live NAV date, NAV-unavailable count, portfolio cashflows, and portfolio XIRR.
- Benchmark result: the selected index symbol's market XIRR over the same transaction stream and terminal date as the portfolio XIRR.
- Composed Portfolio result: the existing `PortfolioData` shape produced by combining portfolio core with one benchmark result.
- Reversal-filtered transactions: transaction rows after removing purchase/redemption pairs that cancel failed or reversed payments and should not create holdings.
- Targeted prefetch: prefetch only for a benchmark explicitly touched by press, hover, or keyboard focus.

## Scope

- Split `src/hooks/usePortfolio.ts` into exported core-query helpers, benchmark-query helpers, and a composed `fetchPortfolioData()` compatibility function.
- Normalize and reversal-filter each fund's transaction stream exactly once per core fetch and reuse that normalized stream for units, invested amount, realized gains, fund XIRR, portfolio XIRR, and benchmark XIRR input.
- Keep `prefetchPortfolioBenchmark()` targeted, but make it prefetch only the selected benchmark's composed result by reusing the cached core.
- Preserve cache-only selectors `useCachedFundCard()` and `useCachedPortfolioWeight()`.
- Update onboarding prefetch and any tests that call `fetchPortfolioData()` so they exercise the split without changing screen behavior.
- Add regression tests proving core work is shared across benchmark variants and that output equivalence is preserved for purchases, switches, redemptions, fully exited funds, NAV-unavailable holdings, matured/inactive funds, portfolio XIRR, and benchmark XIRR.
- Add bounded pathological XIRR regression coverage where the calculation returns promptly with the existing fallback behavior.
- Record N1-style query counts and JavaScript compute timings before opening the implementation PR.

## Out of Scope

- Editing `docs/research/app-navigation-performance-audit-2026-06-30.md`.
- Changing financial formulas, display copy, visual design, persisted-cache policy, or backend schema.
- Reworking the investment-vs-benchmark timeline pipeline beyond ensuring N7 does not reintroduce delayed or eager hidden prefetch.
- Solving the later N8 bundle/persistence/SDK work.

## Approach

Add a `PortfolioCoreData` internal/exported type in `src/hooks/usePortfolio.ts`. Its fetcher loads shared `user-funds` and `user-transactions`, filters active portfolio funds, groups each fund's transactions once, reads recent NAV rows, builds NAV lookup maps, computes fund cards, collects normalized benchmark transactions for active funds, computes portfolio totals, and returns enough metadata for a benchmark query to run without rereading or renormalizing holdings data.

Add canonical query-key builders:

- `portfolioCoreQueryKey(userId)` for the benchmark-independent result.
- `portfolioBenchmarkQueryKey(userId, benchmarkSymbol)` for selected-index output built from the core.
- `portfolioQueryKey(userId, benchmarkSymbol)` for the public composed `PortfolioData` result.

`fetchPortfolioData(queryClient, userId, benchmarkSymbol)` remains the compatibility entry point. It first fetches or reads `PortfolioCoreData` through `queryClient.fetchQuery`, then fetches or reads the selected benchmark result through a benchmark query that consumes the core and loads only index history. It returns the old `PortfolioData` shape by pairing `core.fundCards` with a summary that copies core totals and fills `marketXirr` plus `benchmarkSymbol`.

When two benchmark variants are requested back-to-back, the second request should hit `portfolioCoreQueryKey(userId)` and skip funds, transactions, recent NAV rows, card construction, realized-gain loops, and portfolio XIRR. It may load a different index history and compute a different `marketXirr`.

Keep targeted prefetch explicit. `prefetchPortfolioBenchmark()` should prefetch the public composed key for the specific symbol supplied by the UI event. It must not enumerate every option. Existing Portfolio and desktop benchmark-pill event handlers can keep their call sites, but the underlying work becomes lightweight after core is warm.

Keep preview mode separate in `usePortfolio()`. Preview returns the existing fixture result and does not write core or benchmark queries.

## Alternatives Considered

- Changing every screen to call separate core and benchmark hooks was rejected because it expands the surface area and risks UI drift. The compatibility fetcher keeps this milestone centered on the computation/cache boundary.
- Removing the public `['portfolio', userId, benchmarkSymbol]` key was rejected because Fund Detail cached selectors and the persisted React Query cache already rely on that shape.
- Storing benchmark XIRR directly inside `PortfolioCoreData` was rejected because it would reintroduce benchmark-specific state into the shared cache.
- Performing benchmark computation in a React `select` callback was rejected because the benchmark path performs asynchronous index-history reads and SQLite write-back.

## Milestones

### 1. Plan and isolate current contracts

Create this ExecPlan, inspect all `usePortfolio()` consumers, and identify tests that assert the current query keys and financial outputs.

Expected outcome: the branch has a self-contained plan and a clear compatibility boundary.

### 2. Core/benchmark query split

Refactor `src/hooks/usePortfolio.ts` into pure core construction, benchmark construction, and compatibility composition. Preserve exported public types and keep query stale times unchanged.

Expected outcome: existing screens compile without call-site churn, and one warm core supports multiple benchmark symbols.

### 3. Transaction normalization reuse

Move per-fund reversal filtering and transaction normalization into the core path. Reuse the same normalized stream for card units/invested amount, realized gains, fund XIRR, portfolio XIRR, and benchmark input.

Expected outcome: each fund's transaction stream is prepared once per core fetch and financial outputs stay equivalent to the pre-refactor path.

### 4. Regression tests and performance evidence

Update focused portfolio tests for cache-key behavior, cross-benchmark dedupe, output equivalence, and pathological XIRR runtime/fallback behavior. Capture before/after query counts and compute timings using the N1 harness or existing `[perf]` query spans.

Expected outcome: focused tests demonstrate no duplicate core work across benchmark switches and no output drift.

### 5. Full validation and native evidence

Run focused portfolio/XIRR suites, full Jest, typecheck, zero-warning lint, and `git diff --check`. Build or dispatch the PR-preview workflow, apply the exact OTA to the Pixel 8a, and record privacy-safe Portfolio evidence naming device, channel, OTA/update ID, and runtime SHA.

Expected outcome: N7 is ready for a draft implementation PR with exact-head evidence and no research-report edits.

## Validation

Focused validation:

    npm test -- --runInBand src/hooks/__tests__/usePortfolio.test.ts src/utils/__tests__/xirr.test.ts

Full local validation:

    npm test -- --runInBand
    npm run typecheck
    npm run lint
    git diff --check

Performance/native evidence:

- Capture query/perf logs showing initial Portfolio load performs one core aggregation.
- Capture benchmark switch evidence showing the second benchmark uses the warm core and does not reread funds/transactions/recent NAVs or recompute fund cards.
- Capture a navigation-away check showing no delayed Portfolio/timeline work starts after the screen is blurred.
- On Android, record physical device name, app id/channel, exact OTA/update ID, runtime SHA, benchmark-switch behavior, and absence of auth lifecycle, SQLite, storage, fatal React Native, or unhandled-promise errors.

## Risks And Mitigations

- Financial output drift: keep `fetchPortfolioData()` output shape stable, add equivalence fixtures before changing call sites, and compare numeric results with tight tolerances.
- Cache-shape drift: retain the public `['portfolio', userId, benchmarkSymbol]` composed key and add only narrower internal keys; document any new key in PR evidence.
- Partial transaction normalization mismatch: use one normalized per-fund stream and pass it through every downstream calculation that previously read raw transactions.
- Persisted-cache incompatibility: do not remove the public `PortfolioData` key shape. If a new persisted core key is introduced, verify cache-shape checks and consider whether a buster is necessary.
- Hidden work regression: keep prefetch event-driven and include tests/log evidence that no benchmark enumeration or blur-time timer is present.

## Decision Log

- 2026-07-10: Preserve `usePortfolio()` and `fetchPortfolioData()` as compatibility APIs while splitting the internal cache into core and benchmark work.
- 2026-07-10: Keep the public `['portfolio', userId, benchmarkSymbol]` composed query key for existing selectors and persisted cache compatibility.
- 2026-07-10: Treat `portfolioCoreQueryKey(userId)` as the authoritative home for fund cards, units, realized gains, totals, and portfolio XIRR; benchmark queries may not recompute those fields.

## Progress

- [x] Read VISION, TECH-DISCOVERY, PR #250 control context, report section 3, and Prompt 7.
- [x] Create N7 branch from current `origin/main` and mark PR #250 In progress.
- [x] Create this N7 ExecPlan.
- [x] Refactor Portfolio core and benchmark query helpers.
- [x] Reuse normalized per-fund transaction streams across all core calculations.
- [x] Add focused financial equivalence, dedupe, and pathological XIRR tests.
- [ ] Run focused/full validation and capture performance evidence.
- [ ] Capture exact-head Android evidence and open the N7 implementation PR.
