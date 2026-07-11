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
- [x] Run focused/full validation and capture performance evidence.
- [x] Capture exact-head Android evidence and open the N7 implementation PR.

## Evidence

Round-1 correction evidence at runtime commit `1c52e6cdb812bdd09e5645aa514b1d5e39c4bc3c`:

- Review finding fixed: the benchmark transaction stream now preserves global transaction chronology after per-fund reversal filtering, instead of concatenating normalized streams in fund order. The comparator sorts by `transaction_date` with deterministic tie-breakers (`created_at`, `id`, `fund_id`, `transaction_type`, `amount`, `units`).
- Regression added: a multi-fund fixture with interleaved purchases/redemptions asserts `benchmarkTransactions` order is global chronological and `marketXirr` matches `computeBenchmarkXirrFromNormalizedTransactions()` over that chronological stream.
- Focused validation: `src/hooks/__tests__/usePortfolio.test.ts`, `src/utils/__tests__/xirr.test.ts`, and `src/lib/__tests__/syncInvalidation.test.ts` passed, 3 suites / 129 tests.
- Full local validation: 91 suites / 1,945 tests passed; `npm run typecheck` passed; `npm run lint` passed with zero warnings; `git diff --check` passed.
- PR-preview workflow run `29131745910` passed for runtime commit `1c52e6cdb812bdd09e5645aa514b1d5e39c4bc3c`.
- Corrected Android OTA evidence: physical Pixel 8a, Android 16 / API 36, app `com.foliolens.app.prpreview`, channel `foliolens-pr`, Android OTA/update ID `019f4e7e-aaf0-7a47-a946-88c2586cf752`, in-app About verified prefix `019f4e7e-aaf`. The iOS OTA from the same workflow was `019f4e7e-aaf0-73d4-9770-14f80bf3c773`.
- Corrected Android smoke: Portfolio rendered with Portfolio/XIRR/benchmark labels; switching to Nifty 100 TRI rendered the Nifty 100 benchmark copy; error scan found zero app auth lifecycle, SQLite, storage, React Native fatal, or unhandled-promise signatures. Screen timeout was restored to `120000`.
- The earlier Android OTA `019f4b88-2fef-75c0-a87e-f52ce133619a` is superseded for runtime acceptance because code changed after round-1 review.

Local validation at runtime commit `6242282d209334b77fdb9e00bb85d3f92228a61e`:

- Focused Portfolio suite: `src/hooks/__tests__/usePortfolio.test.ts`, 20 tests passed.
- Focused XIRR suite: `src/utils/__tests__/xirr.test.ts`, 80 tests passed.
- Focused sync invalidation suite: `src/lib/__tests__/syncInvalidation.test.ts`, 28 tests passed.
- Full Jest: 91 suites / 1,944 tests passed.
- `npm run typecheck` passed.
- `npm run lint` passed with zero warnings.
- `git diff --check` passed.
- PR-preview workflow run `29085704006` passed for runtime commit `6242282d209334b77fdb9e00bb85d3f92228a61e`.

Exact Android OTA evidence:

- Device: physical Pixel 8a, Android 16 / API 36.
- App/channel: `com.foliolens.app.prpreview`, `foliolens-pr`.
- Android OTA/update ID: `019f4b88-2fef-75c0-a87e-f52ce133619a`.
- In-app About verified prefix: `019f4b88-2fe`.
- iOS OTA from the same workflow: `019f4b88-2fef-7d72-9ef4-07966b259d1d`.

Privacy-safe Android observations:

- Initial Portfolio refresh on the exact OTA rendered Portfolio, fund cards, portfolio XIRR, and benchmark XIRR. Perf logs showed core work once, then selected-index benchmark work:

      [perf] query:userFunds 271ms rows:20
      [perf] query:userTransactions 223ms rows:566 source:sqlite
      [perf] query:portfolio:nav 2013ms rows:1084 source:sqlite
      [perf] query:portfolio:core 2642ms fund_cards:13 txs:566 navs:1084 idxs:0
      [perf] query:indexSnapshot 369ms symbol:^NSEITRI ok:true points:6717
      [perf] query:portfolio:index 40ms rows:2060 symbol:^NSEITRI source:sqlite
      [perf] query:portfolio:benchmark 3185ms rows:2060 symbol:^NSEITRI source:sqlite

- Switching to Nifty 100 TRI changed the visible benchmark copy to Nifty 100 and ran only selected benchmark/index work:

      [perf] query:portfolio:index 47ms rows:2060 symbol:^NIFTY100TRI source:sqlite
      [perf] query:portfolio:benchmark 570ms rows:2060 symbol:^NIFTY100TRI source:sqlite
      [perf] query:indexSnapshot 717ms symbol:^NIFTY100TRI ok:true points:7805

  No `query:portfolio:core`, `query:userFunds`, `query:userTransactions`, or `query:portfolio:nav` lines appeared during the benchmark switch, and no eager all-benchmark full fetch was observed.

- Navigating away to Settings / About after the benchmark switch produced no delayed `query:portfolio`, `query:performanceTimeline`, `investmentVsBenchmark`, `query:portfolio:nav`, or `query:indexSnapshot` work after blur.
- Funds navigation rendered the Funds list without Portfolio/timeline work. Opening Fund Detail from a warm Funds row logged `navigation:press_to_route_commit 117ms` and `navigation:press_to_post_interaction_usable 132ms`; the screen rendered Performance, NAV & Facts, Mix & Weight, and XIRR selectors.
- Fund Detail selector checks switched to Mix & Weight and NAV & Facts. The selected modules rendered expected selector-specific content such as holdings/asset/sector and fund-fact/NAV labels, with no Portfolio recomputation logs.
- Error scan across the checked Android evidence segments found zero app auth lifecycle, SQLite, storage, React Native fatal, or unhandled-promise signatures. Only unrelated platform `AconfigStorageReadException` and accessibility-dumper diagnostic lines appeared during `uiautomator` inspection.
