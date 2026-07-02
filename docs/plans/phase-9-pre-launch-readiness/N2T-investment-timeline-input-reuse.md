# N2T Investment Timeline Input Reuse and Bounded Valuation

## Goal

Make investment-versus-benchmark timeline changes fast without changing any financial output. Transaction and NAV work must be prepared once for a user, stable fund set, and chart window; changing only the benchmark must reuse that prepared input and perform only benchmark-specific index work.

## User Value

On the measured Android portfolio, selecting the 3Y timeline currently takes 4.830–5.919 seconds and processes 12,861 NAV rows to emit 83 chart points. A benchmark-only change repeats the same transaction read, NAV read, history construction, and per-fund valuation. The app appears hung even though most of that work is identical to the timeline already on screen.

After N2T, the first request for a window prepares the portfolio side once. A benchmark switch reuses it, fetches only the selected index history, and finishes below the 300 ms warm-switch p95 target on Android main-preview. Every emitted date and monetary value must remain equivalent to the pre-N2T implementation.

## Context

PR #250 is the unmerged control plane for the navigation performance-remediation program. N2D merged in PR #253 as `38d669b7f690305de12b8251609ba56049523f45`. N2D established one FIFO writer for the singleton SQLite connection, generation-fenced cleanup, and deterministic timeline NAV repair. N2T consumes those behaviors and must not redesign that coordinator.

The pre-N2T timeline query key contains user, fund set, benchmark, and window. Its query function reads the same transactions and window-bounded NAV rows for every benchmark, builds unit/cost/invested histories, values every fund on the union of every NAV and transaction date, and samples to roughly 90 points only afterward. Android evidence showed the NAV stage alone taking 2.669–3.727 seconds for 12,861 rows while index retrieval took roughly 40–70 ms.

## Assumptions

- Android main-preview is the native acceptance target. iOS remains out of scope because FolioLens has no iOS publishing path.
- SQLite remains a discardable native read cache; Supabase remains authoritative.
- Historical transaction, NAV, and index rows retain their existing shapes.
- The prepared input cache is session-memory React Query data. It is intentionally not persisted because it contains user-scoped transactions and non-JSON `Map` lookups.
- The existing persisted `investmentVsBenchmarkTimeline` output shape and query-key shape remain unchanged.

## Definitions

- **Prepared input:** benchmark-independent transactions, NAV rows and lookups, unit/cost/invested histories, candidate dates, and memoized portfolio valuations for one user, stable fund set, and window.
- **Stable fund set:** fund ID plus scheme code pairs sorted into one deterministic cache-key string, independent of caller array order.
- **Candidate date:** a NAV or transaction date that can contribute to the selected window before chart sampling.
- **Evaluation date:** a candidate date retained by the existing chart sampling contract and therefore requiring portfolio valuation.
- **Golden fixture:** deterministic transaction/NAV/index input evaluated by both the frozen pre-N2T algorithm and the new algorithm, with every output date and value compared.
- **Warm benchmark switch:** the first request for a different benchmark after the prepared input for the same user, fund set, and window is already cached.

## Scope

- Add a benchmark-independent React Query input entry keyed by user, stable fund set, and window.
- Cache window-specific transaction/NAV inputs, lookup maps, unit/cost/invested histories, candidate dates, and memoized valuations in that entry.
- Keep benchmark-specific output under the existing timeline key and make it fetch only index history after an input-cache hit.
- Choose the bounded evaluation dates before the per-fund NAV valuation loop while retaining complete NAV lookup rows.
- Preserve window fallback, visible boundary, terminal point, transaction ordering and reversal filtering, redemption cost basis, switch semantics, weekend/holiday latest-at-or-before lookup, and NFO mark-to-cost behavior.
- Add privacy-safe timing metadata for input-cache hit, row counts, candidate/evaluation point counts, and valuation-cache hit/miss counts.
- Invalidate the prepared input whenever the current timeline output is invalidated after a data refresh.
- Add legacy-equivalence fixtures and benchmark-switch cache tests.
- Keep all N2D serializer and deterministic repair regression tests green.
- Capture cold/warm Android main-preview evidence at the implementation SHA for every visible window and repeated benchmark switches.

## Out of Scope

- Changing the shared SQLite serializer, write scopes, repair retry, schema version, or repository write ownership.
- Portfolio-core refactoring outside this investment timeline. N3 and later milestones own other query/invalidation work.
- New financial formulas, changed transaction classifications, changed chart point budgets, or UI redesign.
- Persisting prepared transaction/NAV maps to AsyncStorage.
- iOS release measurements.

## Approach

Keep the existing benchmark-specific output query key so persisted chart output and consumers retain their contract. Introduce an in-memory `investmentTimelineInputs` key containing user, stable fund set, and window. The output query asks its `QueryClient` for that entry. A cache miss reads transactions and NAV once and builds the prepared input; a cache hit does not execute those reads or rebuild the histories.

The prepared input retains all fetched NAV rows and builds sorted latest-at-or-before lookup histories before any date reduction. It filters reversed transaction pairs once and builds unit, cost, and invested histories once. It also retains the sorted union of NAV and transaction dates. This preserves the data needed for correct weekend, holiday, missing-NAV, and NFO behavior.

The benchmark layer fetches only the selected index history, builds its latest-at-or-before lookup and simulated benchmark-unit history, and identifies the dates that satisfy the existing positive-invested/benchmark-availability contract. It applies the existing window fallback and sampling rule to those dates before asking the prepared input for portfolio values. Portfolio valuation is therefore bounded to at most the existing chart budget plus its retained terminal point instead of running for every raw NAV date. A memoized date-to-valuation map belongs to the prepared input, so benchmarks with the same coverage reuse the portfolio and invested series exactly.

The output timing mark records whether the prepared input was already cached, transaction/NAV/index row counts, candidate/evaluation counts, and valuation cache hits/misses. It does not record user IDs, fund IDs, scheme codes, transactions, dates, or monetary values.

The prepared entry is not added to the persistence allowlist. React Query `queryClient.clear()` already removes it on sign-out. The manual data-sync path invalidates both the prepared key and existing output key. Because no persisted payload or output key changes, React Query `__BUSTER__` remains unchanged.

## Alternatives Considered

- Cache only final output per benchmark. Rejected because every unseen benchmark would still reread transactions/NAV and rebuild the portfolio series.
- Drop most NAV rows before building lookup histories. Rejected because latest-at-or-before behavior across weekends, holidays, and NFO gaps would become incorrect.
- Precompute portfolio value on every NAV date and only cache the result. Rejected because it preserves the measured expensive loop that N2T must remove.
- Put benchmark-independent state in a module-level `Map`. Rejected because React Query already provides request deduplication, stale-time handling, explicit invalidation, and sign-out cleanup.
- Persist the prepared input. Rejected because its maps are not JSON payloads and it contains user-scoped transaction data; the persisted final chart output is sufficient for restart paint.

## Milestones

### 1. Freeze financial equivalence

Add a frozen pre-N2T reference implementation and deterministic fixtures covering weekends, holiday gaps, NFO mark-to-cost, switches, redemptions, reversed pairs, missing NAV/index data, and every 1M/3M/6M/1Y/3Y/All window.

Expected outcome: the fixture suite captures the exact current emitted dates and values before production logic changes.

Run:

    npm test -- --runInBand src/hooks/__tests__/useInvestmentVsBenchmarkTimeline.test.ts

Acceptance: every point is compared by date and by invested, portfolio, and benchmark value within a tight numeric tolerance.

### 2. Split and bound the computation

Introduce the prepared-input key and builder, move date sampling before per-fund valuation, and layer benchmark output over the cached input. Add row/cache/valuation timing metadata.

Expected outcome: the first benchmark builds prepared input once; a benchmark-only change fetches index history but performs no transaction/NAV read or history rebuild; output remains golden-equivalent.

Run:

    npm test -- --runInBand src/hooks/__tests__/useInvestmentVsBenchmarkTimeline.test.ts

Acceptance: cache tests prove one transaction/NAV input build across multiple benchmark outputs, valuation is bounded to the emitted point budget, and every golden case matches.

### 3. Preserve lifecycle and validate natively

Update manual invalidation and the cache inventory, run N2D regression tests and repository checks, publish Android main-preview at the implementation SHA, and measure all visible windows plus repeated benchmark switches.

Expected outcome: no SQLite transaction regression, no financial drift, material 3Y improvement, and warm benchmark-switch p95 below 300 ms.

Run:

    npm test -- --runInBand src/hooks/__tests__/useInvestmentVsBenchmarkTimeline.test.ts src/lib/db/__tests__/writeSerialization.test.ts src/lib/db/__tests__/sync.test.ts
    npm run typecheck
    npm run lint
    npm test -- --runInBand
    npx expo export --platform android --output-dir /tmp/foliolens-n2t-android-export
    git diff --check

Acceptance: required checks pass; Android evidence includes cold/warm duration, transaction/NAV/index row counts, input-cache hits, emitted points, and SQLite error counts for every window and repeated benchmark switches.

## Validation

Automated evidence must prove:

- stable fund-set keys do not depend on caller array order and include scheme identity;
- one prepared-input build serves multiple benchmark outputs for the same user/funds/window;
- benchmark-only changes do not reread transaction or NAV repositories;
- prepared histories and valuations are reused rather than rebuilt;
- no more than the bounded emitted date set enters the expensive per-fund valuation loop;
- every golden date/value matches the frozen pre-N2T implementation within tight tolerance;
- weekend/holiday, NFO, switch, redemption, reversed-pair, missing-data, and every required window case is covered;
- N2D write serialization, rejection isolation, cleanup fencing, and repair/local-read tests remain intact;
- no nested-transaction or invalid-rollback output is emitted.

Native evidence must record device/OS, package/channel, OTA/update ID, implementation SHA, exact interaction sequence, every visible window's cold/warm duration and row/point counts, repeated benchmark-switch samples and p95, input-cache hit values, and every SQLite error observed. Raw logs remain local and PR excerpts remain privacy-safe.

## Risks And Mitigations

- **Financial drift from early sampling:** retain complete NAV lookup rows; freeze the legacy algorithm in tests; compare every output point across edge fixtures.
- **Window boundary drift:** reuse the existing date-window calculation and fallback behavior, and retain the terminal point explicitly.
- **Cross-user input reuse:** include user ID in the React Query key and rely on existing sign-out `queryClient.clear()` cleanup.
- **Fund identity collision:** key on sorted fund ID plus scheme code, not fund ID alone.
- **Stale prepared input after refresh:** invalidate the prepared key everywhere the timeline output is invalidated; the existing full invalidation also covers it.
- **Persisted-cache incompatibility:** keep prepared maps outside the persistence allowlist and keep the output payload/key unchanged.
- **N2D regression:** make no serializer changes and run its concurrency/repair suites before review.
- **Misleading performance claim:** report cold and warm measurements separately and retain row/point counts so improvements remain attributable.

## Decision Log

- 2026-07-02: Start N2T from N2D merge `38d669b7` only after coordinator commit marked the row Ready.
- 2026-07-02: Keep benchmark-specific output under its current persisted key; add a separate non-persisted prepared-input key.
- 2026-07-02: Retain full fetched NAV lookup rows and bound evaluation dates before portfolio valuation rather than sampling raw NAV payloads.
- 2026-07-02: Reuse N2D SQLite reads/repair unchanged and treat Android as the only native acceptance platform.
- 2026-07-02: Keep all historical transactions needed to establish opening unit/cost and benchmark-unit state inside the window-specific prepared entry; only NAV reads are date-bounded because dropping pre-window transactions would change redemption and simulated-benchmark semantics.
- 2026-07-02: Use the existing positive invested-value and benchmark-unit guards to identify the legacy-valid date set before per-fund valuation. Golden fixtures confirm this selects the same emitted dates as the pre-N2T loop.
- 2026-07-02: Reuse the canonical persisted `['index-snapshot', symbol]` query for benchmark output. The first physical run showed that input reuse alone could still spend 2.443 seconds refetching an unchanged index snapshot for each window; sharing the existing payload removes that repeated work without changing its contract.
- 2026-07-02: Add a benchmark simulator entry point for already normalized transactions. The prepared input has already removed reversal pairs; repeating that pairing pass on every benchmark produced 333–343 ms warm samples even with 1–2 ms index-cache reads.
- 2026-07-02: Evaluate sorted benchmark, invested, and simulated-unit histories with monotonic pointers. Corrected-head warm samples after normalization reuse were still 337–435 ms because the benchmark path repeatedly binary-searched data whose dates are already ordered.
- 2026-07-02: Avoid copying/sorting already ordered index rows and avoid thousands of temporary window objects/maps. The first monotonic build improved the All-window path but remained 370–408 ms; only 91 output positions are needed.

## Amendments

The implementation follows the planned benchmark-independent split. One wording clarification is material: the prepared entry is window-specific and its NAV query is window-bounded, but it retains every historical transaction required to establish opening units, average-cost basis, invested value, and simulated benchmark units. Truncating transactions at the visible boundary would change redemptions and benchmark values, so the cache key provides window isolation without discarding financially required opening history.

The new `investmentTimelineInputs` entry is in-memory only and contains the complete fetched NAV lookup rows plus sorted histories and a memoized date valuation map. The existing persisted `investmentVsBenchmarkTimeline` tuple and payload remain unchanged. Manual data sync invalidates both entries; the existing sign-out `queryClient.clear()` removes the user-scoped input. No `__BUSTER__` or SQLite `SCHEMA_VERSION` bump is required.

The first physical Android attempt at `b5b926b` exposed an acceptance gap before evidence was posted: a benchmark-only input-cache hit still fetched and parsed the same full index snapshot, taking 2.443 seconds. The corrected implementation consumes the existing persisted `['index-snapshot', symbol]` cache. A real cached snapshot is reused across every window; `null` retains the established paginated fallback. This is an implementation correction, not a new cache shape.

A second pre-evidence run at `41ce027` confirmed index reuse at 1–2 ms but measured 333–343 ms total warm computation. The remaining duplicate was transaction normalization inside `simulateBenchmarkInvestment`, even though the prepared input already held a reversal-filtered series. The timeline now calls a normalized-input simulator that preserves the public simulator's financial behavior without rerunning the pairing pass. Unit coverage proves the normalized path is output-identical.

The first `c12a518` samples remained 337–435 ms with cached input and index data. The benchmark layer was still invoking binary latest-at-or-before lookup for each sorted transaction and candidate date. It now sorts index rows once, advances monotonic pointers across index/invested/benchmark-unit histories, and stores the selected date values for direct evaluation lookup. Golden fixtures continue to compare every output date and value to the frozen pre-N2T implementation.

The initial monotonic candidate `d29a236` measured 370–408 ms for the All window. Its remaining overhead came from copying and sorting 2,059 already ordered index rows, materializing a temporary object per candidate for window filtering, and filling date maps before retaining only 91 positions. The final path verifies order without copying, keeps parallel primitive arrays, derives the legacy window offset directly, and samples integer positions before valuation.

The frozen legacy oracle and deterministic fixtures cover weekend and holiday lookups, an NFO subscription before its first NAV, switches, redemptions, a failed-payment reversal pair, a fund with no NAV rows, delayed index coverage, and 1M/3M/6M/1Y/3Y/All. Every emitted date and invested/portfolio/benchmark value matches within 10 decimal digits. A 400-date fixture proves only the at-most-91 sampled dates enter the portfolio valuation cache and the terminal point is retained.

Validation before physical Android evidence:

- focused N2T, N2D serializer/sync, and query-cache checks passed: 4 suites and 80 tests;
- full Jest passed: 78 suites and 1,820 tests;
- `npm run typecheck` passed with zero errors;
- `npm run lint` passed with zero warnings;
- Android export passed: 1,747 modules and a 6.3 MB Hermes bundle;
- `git diff --check` passed.

Physical Android evidence at implementation `afd6a804b18e14c0f47ad44e34ca71d98ad0eb95`:

- Pixel 8a, Android 16; `com.foliolens.app.mainpreview`, channel `foliolens-main`, runtime/app `0.0.4`;
- Android main-preview OTA `019f2233-058f-774c-bfc7-d310fa931633` (About showed `019f2233-058…`);
- before measurement, the support-only local-cache reset confirmed 566 local/server transactions, then rebuilt 566 transaction, 51,902 NAV, and 22,325 index rows with `error_count: 0`; this deliberately invalidated timeline outputs and prepared inputs;
- interaction sequence: select one benchmark to build each window's prepared input, then select two different benchmarks for the same window. The reset also invalidated index snapshots, so the first Nifty 50/Nifty 100 switches at 3M were treated as one-time index warm-up; the repeated-switch acceptance set begins after all three canonical snapshots are fresh.

| Window | Cold total | tx / NAV / index rows | Points / evaluation dates | Warm totals | Warm cache result |
|---|---:|---:|---:|---:|---|
| 1M | 1,404 ms | 566 / 445 / 2,059 | 21 / 21 | 20, 50 ms | input + index hit; 21 valuation hits, 0 misses |
| 3M | 2,298 ms | 566 / 1,137 / 2,059 | 60 / 60 | 417, 465 ms setup | input hit; one-time invalidated index-snapshot refetch |
| 6M | 3,963 ms | 566 / 2,219 / 2,059 | 61 / 61 | 29, 35 ms | input + index hit; 61 valuation hits, 0 misses |
| 1Y | 6,233 ms | 566 / 4,443 / 2,059 | 83 / 83 | 36, 36 ms | input + index hit; 83 valuation hits, 0 misses |
| 3Y | 15,240 ms | 566 / 12,879 / 2,059 | 84 / 84 | 31, 21 ms | input + index hit; 84 valuation hits, 0 misses |
| All | 6,034 ms | 566 / 34,299 / 2,059 | 91 / 91 | 38, 38 ms | input + index hit; 91 valuation hits, 0 misses |

The steady-state repeated-switch set was `20, 50, 29, 35, 36, 36, 31, 21, 38, 38` ms: p95 50 ms, below the 300 ms target. The 3Y benchmark-only interaction improved from the 4.830–5.919 second baseline to 21–31 ms (more than 99% lower). Every warm row reported `input_cache_hit: true`, `index_cache_hit: true`, and zero valuation-cache misses. The cold numbers are reported separately: they include preparation of the window-specific input after a full local-cache rebuild, and show that SQLite NAV read/repair remains the dominant first-request cost, especially for 3Y. Logcat contained zero nested-transaction, invalid-rollback, `SQLITE_BUSY`, or `SQLITE_LOCKED` errors.

## Progress

- [x] Read AGENTS.md, VISION.md, docs/TECH-DISCOVERY.md, docs/architecture/cache-surfaces.md, docs/process/PLANS.md, the updated control report, and later PR #250 comments.
- [x] Verify N2D merge on `origin/main` and coordinator release of N2T.
- [x] Create `codex/n2t-timeline-input-reuse` from current `origin/main`.
- [x] Record the N2T design and validation contract in this ExecPlan.
- [x] Freeze legacy-equivalence fixtures.
- [x] Implement benchmark-independent prepared input and bounded valuation.
- [x] Update invalidation and cache inventory.
- [x] Run focused, full, static, and Android export validation.
- [x] Capture Android main-preview acceptance evidence.
- [x] Open the implementation PR and enter independent review.
