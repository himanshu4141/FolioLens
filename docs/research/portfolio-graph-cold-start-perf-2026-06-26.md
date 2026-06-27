# Portfolio Graph — Cold-Start Performance Investigation (2026-06-26)

**Symptom:** Every time the user opens the app fresh (first open of the day / >24h since last
session), the "How your money grew" chart on the Portfolio screen shows a loading spinner for
several seconds before the chart appears. The hero numbers (`₹27.21L`, `15.08% p.a. XIRR`,
benchmark pill) all paint first, then the chart area sits empty with an `ActivityIndicator`.

**Scope:** Read-only code trace against `himanshu4141/foliolens` `origin/main` as of
2026-06-26. No live DB queries were run. All findings are code-verified.

---

## Implementation status (2026-06-27)

Fixes F1–F4 were implemented and shipped in the same PR as this document
([#245](https://github.com/himanshu4141/FolioLens/pull/245)).

| Fix | Status | Commit |
|-----|--------|--------|
| F1 — SQLite read-through in `fetchAllNavRows` | ✅ Done | `a2ca408` |
| F2 — SQLite read-through in `fetchAllTransactions` + `txRepo.readByFundIds` | ✅ Done | `a2ca408` |
| F3 — Prefetch chart query on portfolio data ready | ✅ Done | `a2ca408` |
| F4 — Raise `PERSIST_MAX_AGE_MS` to 48h | ✅ Done | `a2ca408` |
| F5 — Bootstrap-to-chart signalling | Future work | — |
| F6 — CDN NAV snapshot | Future work | — |

The implementation prompts in §6 document the intended approach; the actual diffs are the
canonical record of what shipped.

---

## Baselines

| | |
|---|---|
| Repo analysed | `himanshu4141/foliolens` |
| Branch | `claude/portfolio-graph-perf-report-hutcit` |
| Analysis timestamp | 2026-06-26 |
| Key files | `src/hooks/useInvestmentVsBenchmarkTimeline.ts`, `src/hooks/usePortfolio.ts`, `src/components/clearLens/screens/ClearLensPortfolioScreen.tsx`, `src/lib/queryClient.ts`, `app/_layout.tsx`, `src/lib/db/sync.ts`, `src/lib/db/nav.ts`, `src/lib/db/idx.ts` |

---

## 1. What the user actually sees (render sequence)

The Portfolio screen blocks behind two sequential async walls on every cold open.

**Wall 1 — React Query cache restore from AsyncStorage**

`app/_layout.tsx` wraps the app in `PersistQueryClientProvider`. On mount it reads the
persisted blob from `AsyncStorage`, JSON-parses it, and re-hydrates the cache. During this
window `useIsRestoring()` returns `true`. The portfolio screen explicitly gates on this:

```typescript
// ClearLensPortfolioScreen.tsx:985
const isRestoring = useIsRestoring();
const showFirstLoad = isRestoring || isLoading || data === undefined;
```

While `showFirstLoad` is true the screen renders a full-screen `ActivityIndicator` — no hero
numbers, no chart, nothing. On a mid-range Android device this restore takes **200–600 ms**
depending on blob size.

**Wall 2 — `usePortfolio` (hero numbers)**

Once the restore completes the `usePortfolio` query fires. If the persisted cache entry is
still valid (within 24h) it resolves from the in-memory hydrated cache — fast. If the
24h `PERSIST_MAX_AGE_MS` has elapsed (or a `__BUSTER__` bump discarded the entry), it runs
`fetchPortfolioData`, which reads NAV from SQLite (or falls back to Supabase). This is
**500 ms – 2 s** cold.

**Wall 3 — `InvestmentVsBenchmarkChart` spinner (what the user reported)**

The chart mounts as part of the `ScrollView` content that becomes visible only after Wall 1
and Wall 2 complete. `InvestmentVsBenchmarkChart` calls `useInvestmentVsBenchmarkTimeline`,
which fires its own React Query entry **completely independent of `usePortfolio`**. The chart
shows `ActivityIndicator` while this query is in flight. This is the spinner the user sees.

The three walls are sequential, not parallel, because the chart can't mount until the page
does, and the page can't render until the restore + portfolio query resolve.

---

## 2. Root cause map

### R1 (Critical) — `fetchAllNavRows` bypasses the local SQLite cache

**File:** `src/hooks/useInvestmentVsBenchmarkTimeline.ts:368–385`

```typescript
async function fetchAllNavRows(schemeCodes: number[], startDate: string): Promise<RawNavRow[]> {
  const rows: RawNavRow[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await navHistoryRepo
      .from()
      .select('scheme_code, nav_date, nav')
      .in('scheme_code', schemeCodes)
      .gte('nav_date', startDate)
      // ...paginate
  }
  return rows;
}
```

This function goes **directly to Supabase PostgREST** every time. It has no SQLite read path.

Compare with `usePortfolio` (`src/hooks/usePortfolio.ts:160–188`), which explicitly reads
SQLite first and only falls back to Supabase when the local cache is cold:

```typescript
// usePortfolio.ts:160
if (SQLITE_AVAILABLE) {
  navRows = await navRepo.readBySchemeCodes(schemeCodes, { sinceDate: navCutoffIso });
}
if (navRows.length === 0) {
  // fallback to Supabase + write-back to SQLite
}
```

The bootstrap (`src/lib/db/sync.ts`) writes ALL NAV history into SQLite. The chart hook
ignores that warm cache and hits Supabase anyway. On the typical "opening the app in the
morning" scenario:

- SQLite is **warm** (bootstrap ran yesterday, sync deltas ran on foreground)
- React Query `investmentVsBenchmarkTimeline` cache is **expired** (24h maxAge elapsed)
- Result: chart fetches from Supabase instead of the already-on-device SQLite

For a user with 10 funds and a portfolio starting in 2020, the default `1Y` window still
fetches ~3,000–5,000 NAV rows across 3–5 paginated requests to Supabase, each 150–400 ms on
Indian mobile networks. Total: **450 ms – 2 s of network time** for NAV alone.

For users who have changed the window to `3Y` or `All`, the query reads back to `firstTxDate`
(potentially 2013 for long-standing SIPs), which is 10,000+ rows and 10+ paginated requests:
**1.5 s – 5+ s**.

### R2 (Critical) — `fetchAllTransactions` also bypasses the SQLite tx cache

**File:** `src/hooks/useInvestmentVsBenchmarkTimeline.ts:350–366`

```typescript
async function fetchAllTransactions(userId: string, fundIds: string[]): Promise<RawTxRow[]> {
  const rows: RawTxRow[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await transactionRepo
      .from()
      .select(...)
      .eq('user_id', userId)
      .in('fund_id', fundIds)
      .order(...)
      .range(from, from + PAGE_SIZE - 1);
    // ...
  }
  return rows;
}
```

Same pattern as R1. This goes to Supabase directly. The SQLite `tx` table (populated by
`bootstrap` and `syncDelta`) holds these rows locally on device; the chart hook never checks.

Transactions are fetched **before** NAV rows (they're needed to derive `navStartDate`), so
this adds a serial dependency: transaction fetch must complete before the parallel
nav+index fetch can even start.

For a user with 200 transactions, that's 1 paginated request ≈ 150–400 ms before the NAV
fetch begins.

### R3 (High) — React Query cache for `investmentVsBenchmarkTimeline` expires after 24h

**File:** `src/lib/queryStaleTimes.ts:30` + `src/lib/queryClient.ts:84`

```typescript
INVESTMENT_VS_BENCHMARK: 1 * HOUR,   // staleTime
PERSIST_MAX_AGE_MS = 24 * 60 * 60 * 1000; // maxAge for ALL persisted entries
```

The persisted cache entry survives only 24h. A user who opens the app more than 24h after
their last session (= every morning user) gets no cache benefit. `isLoading = true` on mount
and the spinner shows until the full cold fetch completes.

There is no CDN snapshot or pre-computed endpoint for the portfolio timeline — unlike the
benchmark index history which has the Phase 9 M5 CDN snapshot
(`fetchIndexSnapshot`, `src/hooks/useIndexSnapshot.ts:55`). The NAV half of the chart has
no equivalent fast path.

### R4 (High) — No prefetch of chart data from `usePortfolio`

**File:** `src/hooks/usePortfolio.ts:491–501`

`usePortfolio` prefetches portfolio data for the other 2 benchmark options as a `useEffect`
after the primary data lands. But it does **not** prefetch `investmentVsBenchmarkTimeline`
for the current benchmark/window, even though it has all the data needed to know those
parameters (`defaultBenchmarkSymbol`, `portfolioChartWindow`).

The chart's React Query entry (`['investmentVsBenchmarkTimeline', userId, fundKey, benchmarkSymbol, window]`)
fires only when `InvestmentVsBenchmarkChart` mounts. This is inherently a second wave —
it starts after the portfolio query resolves and the component tree re-renders.

A prefetch started during or immediately after the `usePortfolio` query would eliminate the
visible "chart loading" phase for warm-SQLite users, since the data could be fetched and
cached before the chart ever mounts.

### R5 (Medium) — Bootstrap and chart fetch duplicate network traffic on first-ever launch

**File:** `app/_layout.tsx:199–231` + `src/lib/db/sync.ts:437–455`

On the very first launch (fresh install), `bootstrapForUser` fires from the layout's mount
effect (fire-and-forget). By the time the chart mounts (~2 s later), `bootstrap` is
in-flight pulling transactions, NAV history, and index history from Supabase. The chart's
`fetchInvestmentVsBenchmarkTimeline` then fires its own parallel fetch of the same data.

Two concurrent paginated SELECT chains against the same Supabase tables:
- Bootstrap: fetches all transactions + NAV history + index rows for all benchmarks
- Chart: fetches transactions + NAV history + index rows for current benchmark

No deduplication. The chart doesn't await the bootstrap; bootstrap doesn't populate the
React Query cache. If bootstrap writes to SQLite and fires `queryClient.invalidateQueries()`
while the chart's fetch is in-flight, the chart query is invalidated and **reruns** — doubling
the wait.

### R6 (Medium) — `usePortfolio` benchmark prefetch adds parallel index fetches during chart load

**File:** `src/hooks/usePortfolio.ts:491–501`

The moment `usePortfolio` resolves, its `useEffect` fires `prefetchQuery` for the other 2
benchmark symbols. Each `fetchPortfolioData` call eventually calls `fetchIndexHistory`
(CDN then paginated Supabase fallback). So at the same time the chart is fetching its NAV
rows and index history, the portfolio prefetch is also hitting the CDN / Supabase for index
data for 2 more symbols.

On a slow connection this is network saturation. Three concurrent CDN fetches + 3–10 paginated
NAV fetches + 1–2 transaction paginated fetches all hit simultaneously within the
first 3 seconds after the portfolio hero renders.

### R7 (Low-Medium) — AsyncStorage restore is the "invisible wall"

**File:** `src/lib/queryClient.ts:137–141`, `app/_layout.tsx:374–413`

The base persister uses `createAsyncStoragePersister` with `throttleTime: 1000`. On Android
the `AsyncStorage` implementation is backed by a SQLite file; large blobs (containing NAV
history, timeline data, fund details for multiple benchmarks) can take 50–250 ms just to
serialize/deserialize.

The `PERSIST_ALLOWLIST` includes:
- `investmentVsBenchmarkTimeline` — up to 3 benchmark × windowed entries
- `user-transactions` — all user transaction rows with 10 fields each
- `fund-nav-history` — per-fund NAV history
- `portfolio`, `fund-detail`, `index-snapshot`, etc.

After the benchmark prefetch (`useInvestmentVsBenchmarkTimeline`'s staggered prefetch fires
for 2 other benchmarks × current window), the blob grows further. The instrumented
`persister_write_failed` events in PostHog (see `queryClient.ts:181`) are the signal to watch
for whether Android's ~6 MB AsyncStorage limit is being hit. If the write fails, the next
launch has an empty cache and always hits Wall 1 + Wall 2 + Wall 3 cold.

---

## 3. What is working well

| Mechanism | File | Why it helps |
|---|---|---|
| CDN index snapshot | `useIndexSnapshot.ts:55` | Single CDN GET replaces 2–8 paginated PostgREST calls for benchmark TRI history; ~30–80 ms globally vs 600 ms+ paginated |
| Window-bounded NAV fetch | `useInvestmentVsBenchmarkTimeline.ts:306–309` | `navStartDate = laterDate(firstTxDate, windowStart)` limits rows to the selected window; `1Y` window dramatically reduces pages vs unconstrained |
| SQLite read-through in `usePortfolio` | `usePortfolio.ts:160–188` | Portfolio hero numbers paint from SQLite on any open after the first, even without network |
| Staggered benchmark prefetch | `useInvestmentVsBenchmarkTimeline.ts:436–464` | 1.2 s delay + 250 ms between prefetches avoids competing with the primary chart render; benchmark pill switches are instant after first paint |
| Single-flight bootstrap guard | `sync.ts:426–455` | `inFlightBootstrap` prevents concurrent screen mounts from firing duplicate bootstrap runs |
| staleTime = 1h for timeline | `queryStaleTimes.ts:31` | Within a session (multiple navigations), the chart never refetches — stale-while-revalidate returns cached data immediately |
| `useIsRestoring` guard in portfolio | `ClearLensPortfolioScreen.tsx:984` | Prevents "Import CAS" empty-state flash during the AsyncStorage restore window |

---

## 4. Quantified delay breakdown (estimated, typical mid-range Android, Indian mobile network)

| Phase | Duration (cold) | Duration (warm SQLite, expired RQ cache) |
|---|---|---|
| AsyncStorage restore (Wall 1) | 50–100 ms (empty blob) | 200–600 ms (populated blob) |
| `usePortfolio` cold fetch | 800 ms – 2 s | ~instant (SQLite) |
| Chart mount to `useInvestmentVsBenchmarkTimeline` start | ~100 ms | ~100 ms |
| `fetchAllTransactions` (Supabase) | 150–400 ms | 150–400 ms (**same — no SQLite path**) |
| `fetchAllNavRows` (Supabase, 1Y window) | 450 ms – 2 s | 450 ms – 2 s (**same — no SQLite path**) |
| `fetchIndexHistory` (CDN) | 30–80 ms | 30–80 ms |
| `computeInvestmentVsBenchmarkTimeline` (JS) | 20–100 ms | 20–100 ms |
| **Total chart visible to user** | **~2 – 5 s from app open** | **~1.5 – 4 s from portfolio paint** |

The `warm SQLite, expired RQ cache` column (the daily morning open) is the most common
scenario and still produces a 1.5–4 s visible chart spinner. The fix is to make
`fetchAllNavRows` and `fetchAllTransactions` use the SQLite repos that are already warm.

---

## 5. Ranked fix list

| # | Fix | Impact | Effort | Risk | Status |
|---|---|---|---|---|---|
| F1 | Add SQLite read-through in `fetchAllNavRows` (mirror `usePortfolio`'s nav read) | **Critical** | S | Low | ✅ Shipped (#245) |
| F2 | Add SQLite read-through in `fetchAllTransactions` (use `txRepo.readByFundIds`) | **High** | S | Low | ✅ Shipped (#245) |
| F3 | Prefetch `investmentVsBenchmarkTimeline` from `ClearLensPortfolioScreenMobile` once portfolio data lands | **High** | S | Low | ✅ Shipped (#245) |
| F4 | Raise `PERSIST_MAX_AGE_MS` from 24h to 48h | Medium | S | Low | ✅ Shipped (#245) |
| F5 | Bootstrap writes nav/idx to SQLite then signals readiness so chart can read locally | Medium | M | Medium | Future work |
| F6 | Add a CDN-served daily NAV snapshot (one JSON per user or per scheme set) to eliminate the paginated NAV fetch | High (long-term) | L | Medium | Future work |

---

## 6. Implementation prompts

### F1 (FL) `fix(timeline): read NAV rows from SQLite cache in fetchAllNavRows`

> **File:** `src/hooks/useInvestmentVsBenchmarkTimeline.ts`
>
> `fetchAllNavRows` (line 368) goes directly to Supabase PostgREST for every chart render
> where the React Query cache has expired (i.e., every morning open). The SQLite `nav` table
> is already populated by `bootstrapForUser` + `syncDelta` — but the chart hook ignores it.
>
> Mirror exactly what `usePortfolio`'s `fetchPortfolioData` does at `src/hooks/usePortfolio.ts:160–188`:
>
> 1. Import `SQLITE_AVAILABLE` from `src/lib/db/availability.ts` and `* as navRepo` from
>    `src/lib/db/nav.ts`.
>
> 2. In `fetchAllNavRows(schemeCodes, startDate)`:
>    - If `SQLITE_AVAILABLE`, call `navRepo.readBySchemeCodes(schemeCodes, { sinceDate: startDate })`.
>    - If the result is non-empty, return it immediately — no Supabase call.
>    - If SQLite returns empty (first ever launch or fresh install), fall through to the existing
>      paginated Supabase SELECT.
>    - After a successful Supabase fetch, write back to SQLite: `await navRepo.bulkInsert(rows)`
>      (wrapped in try/catch — write failure must not block the chart).
>
> 3. The SQLite `nav` table's PK is `(scheme_code, nav_date)` and inserts use `INSERT OR IGNORE`,
>    so write-back is safe to call even if rows are already present.
>
> 4. **Do NOT change the Supabase fallback path for web** (`SQLITE_AVAILABLE = false` on web).
>
> 5. Add a unit test in `src/hooks/__tests__/useInvestmentVsBenchmarkTimeline.test.ts` (create if
>    it doesn't exist) that stubs `navRepo.readBySchemeCodes` to return rows and asserts that
>    `navHistoryRepo.from()` is NOT called. Also add a test for the empty-SQLite fallback path.
>
> Acceptance: on a device with a warm SQLite (i.e., the app has been open before today), the
> chart paints without any network request for NAV rows. In the perf marks (`adb logcat | grep '\[perf\]'`),
> `query:timeline:nav` should report `rows: N, source: sqlite` and complete in < 50 ms.
> `[cache-shape-stable]` — no payload shape change for the React Query entry.

---

### F2 (FL) `fix(timeline): read transactions from SQLite tx cache in fetchAllTransactions`

> **File:** `src/hooks/useInvestmentVsBenchmarkTimeline.ts`
>
> `fetchAllTransactions` (line 350) paginates through Supabase `transactions` every time the
> React Query cache has expired. The SQLite `tx` table is populated by bootstrap + sync and
> is already warm on any non-first-ever launch.
>
> Fix:
>
> 1. Import `SQLITE_AVAILABLE` from `src/lib/db/availability.ts` and `* as txRepo` from
>    `src/lib/db/tx.ts`. Check what `txRepo.readAll(userId, fundIds)` looks like — if no such
>    method exists, add one: `SELECT * FROM tx WHERE fund_id IN (?) ORDER BY transaction_date ASC`.
>
> 2. In `fetchAllTransactions(userId, fundIds)`:
>    - If `SQLITE_AVAILABLE`, call `txRepo.readByFundIds(fundIds)` (or equivalent).
>    - Map the SQLite row shape to `RawTxRow` (fields: `fund_id`, `transaction_date`,
>      `transaction_type`, `units`, `amount` — already in the `tx` DDL at `src/lib/db/db.ts:37`).
>    - If non-empty, return immediately.
>    - If empty, fall through to the existing Supabase paginated path.
>    - After Supabase fetch, write back: `await txRepo.bulkInsert(rows)` (catch errors).
>
> 3. The `tx` table PK is `(fund_id, transaction_date, transaction_type, units, amount)`.
>    `INSERT OR IGNORE` keeps write-back safe.
>
> 4. Add a `readByFundIds(fundIds: string[]): Promise<DbTxRow[]>` export to `src/lib/db/tx.ts`
>    that runs `SELECT <columns> FROM tx WHERE fund_id IN (?) ORDER BY transaction_date ASC`.
>
> 5. Unit test: stub `txRepo.readByFundIds` to return rows; assert `transactionRepo.from()` is
>    not called. Empty-SQLite fallback test. Perf mark target: `query:timeline:tx` source=sqlite
>    in < 10 ms for a typical 200-transaction portfolio.
>
> **Dependency:** ship after or with F1. Both fixes together eliminate the two Supabase round-trip
> chains that cause the visible chart spinner on every morning open.
> `[cache-shape-stable]`

---

### F3 (FL) `feat(portfolio): prefetch investmentVsBenchmarkTimeline when portfolio data lands`

> **File:** `src/hooks/usePortfolio.ts` (the `useEffect` at line 491)
>
> The `usePortfolio` hook already prefetches portfolio data for the other 2 benchmark options
> after its own data lands. It should also kick off a prefetch for `investmentVsBenchmarkTimeline`
> for the current benchmark and window. By the time the user scrolls to the chart (or the chart
> mounts as part of the initial layout), the data will already be in the React Query cache.
>
> Changes:
>
> 1. In the existing `useEffect` (line 491, triggered when `query.data` populates):
>    - Read the current `portfolioChartWindow` from the store:
>      `const window = useAppStore.getState().portfolioChartWindow;`
>      (access via `getState()` — this is a one-shot read inside an effect, not a subscription).
>    - Also import `fundRefs` or derive them: `usePortfolio` itself doesn't have access to
>      `fundRefs` since it doesn't call `useUserFunds`. Options:
>      a. Pass `fundRefs: FundRef[]` as a parameter to `usePortfolio` (breaking change — need to
>         thread through from the screen). **Not recommended**.
>      b. Have the effect call `qc.getQueryData(['user-funds', userId])` to read from the already-warm
>         user-funds cache and derive `fundRefs` in place. This avoids a new parameter and keeps the
>         hook self-contained.
>      c. Move the prefetch into the screen component (`ClearLensPortfolioScreenMobile`), where
>         `fundRefs` is already derived. **Recommended** — simpler, avoids parameter threading.
>
> 2. In `ClearLensPortfolioScreenMobile` (or the Desktop variant), after `fundRefs` is ready and
>    `data` is non-null, call:
>    ```typescript
>    useEffect(() => {
>      if (!data || !userId || fundRefs.length === 0) return;
>      queryClient.prefetchQuery({
>        queryKey: ['investmentVsBenchmarkTimeline', userId, fundKey, defaultBenchmarkSymbol, window],
>        queryFn: () =>
>          fetchInvestmentVsBenchmarkTimeline(fundRefs, userId, defaultBenchmarkSymbol, window),
>        staleTime: STALE_TIMES.INVESTMENT_VS_BENCHMARK,
>      });
>    }, [data, userId, fundRefs, fundKey, defaultBenchmarkSymbol, window, queryClient]);
>    ```
>    where `fundKey` is the sorted join already computed by `useInvestmentVsBenchmarkTimeline`.
>
> 3. This prefetch fires at the same time as `usePortfolio`'s benchmark prefetches (after portfolio
>    data lands), so the chart data arrives **before** the user scrolls to it. Combined with F1+F2,
>    the prefetch will hit SQLite (fast) and the chart will paint from cache on mount with no spinner.
>
> 4. Avoid double-fetching: `prefetchQuery` is a no-op if the entry is already fresh; safe to call
>    even if the chart mounts before this effect fires.
>
> Unit test: assert that after `usePortfolio` resolves, a `prefetchQuery` call is made with the
> correct query key for the current benchmark+window.
> `[cache-shape-stable]`

---

### F4 (FL) `fix(persist): raise PERSIST_MAX_AGE_MS or use per-key TTL for stable data`

> **File:** `src/lib/queryClient.ts`
>
> The `PERSIST_MAX_AGE_MS = 24 * 60 * 60 * 1000` (24h) causes every morning open to start with
> an expired cache for the timeline entry. This is overly conservative for data that only changes
> once per day (NAV publishes at ~22:30 IST): a user who opens the app at 9 AM and again the
> next day at 9 AM waits in the cache-miss path.
>
> Options (choose one):
>
> **Option A — raise global maxAge to 48h.** Simple. The cache stays alive across a day's gap.
> Stale entries still trigger background refetch (staleTime = 1h), so users still get fresh data.
> The only trade-off: the persisted blob lives on disk longer. At the current blob size (estimated
> < 3 MB for a typical portfolio) this is acceptable.
>
> **Option B — per-key dehydration with per-key `dataUpdatedAt` filtering.** More surgical: in
> `shouldPersistQueryKey` / the `dehydrateOptions.shouldDehydrateQuery` callback, skip timeline
> entries that are within a SEBI-publish window (before 22:00 IST) since they'll be stale anyway.
> More complex, not worth the complexity for now.
>
> Recommended: **Option A** (change `PERSIST_MAX_AGE_MS` from `24 * HOUR` to `48 * HOUR`).
>
> Also monitor the `persister_write_failed` PostHog events for `blob_size_bytes` — if the Android
> 6 MB limit is being hit, the persisted cache never makes it to disk at all, making the daily
> cache-miss scenario 100% reproducible. If blob size > 5 MB, add a `maxEntries` or size
> filter to `dehydrateOptions`.
>
> Unit test: verify that `shouldPersistQueryKey` still returns correct values; no functional
> change expected.

---

## 7. Sequencing recommendation

**Actual shipping order (2026-06-27):** F1, F2, F3, and F4 all shipped together in PR #245
alongside this research document. The changes were small enough (~60 lines of production code)
that combining them reduced review overhead versus separate PRs.

Original intended order (preserved for reference):

1. **F1 + F2 together** — highest-impact, fully independent. Once merged, the chart's nav and
   transaction reads hit SQLite on every morning open where the device has been used before.
   The visible spinner goes from 1.5–4 s to < 100 ms on warm-SQLite devices.

2. **F3** — prefetch fire-on-portfolio-data means that even on first cold launch (before SQLite
   is warm), the chart's React Query entry is populated while the user reads the hero numbers.

3. **F4** — raises cache lifetime for users who open the app every 25–30h. Low risk, 2-line change.

4. **F5 / F6** are longer-term. F6 (CDN NAV snapshot) would be the ultimate solution for
   first-ever-launch speed, but F1+F2 already solve the daily open problem via on-device SQLite.

---

## 8. What NOT to do

- **Do not** remove or reduce `STALE_TIMES.INVESTMENT_VS_BENCHMARK` below 1h — this would
  cause refetches within a session and is unrelated to the problem.
- **Do not** add a loading skeleton to hide the spinner without fixing the underlying delay —
  the data is already on device and should paint in < 100 ms after F1+F2 land.
- **Do not** try to pre-compute the timeline server-side and store it in Supabase — too much
  complexity for what is ultimately a "the client already has the data" problem.
- **Do not** change the `computeInvestmentVsBenchmarkTimeline` algorithm — the JS compute
  time (20–100 ms for 90 sample points) is not the bottleneck.

---

## 9. How to verify the fix (acceptance criteria)

After F1+F2 ship:

1. On a device with an existing portfolio (SQLite warm), close the app fully, wait 25h, reopen.
   - Expected: chart appears within 200 ms of the hero numbers, with no visible spinner.
   - Perf marks to check via `adb logcat | grep '\[perf\] query:timeline'`:
     - `query:timeline:nav` should show `source: sqlite` (or not appear if the RQ cache is warm).
     - `query:timeline` total should be < 300 ms.

2. On a fresh install (no SQLite, no RQ cache):
   - Expected: chart shows spinner until bootstrap completes (may take 2–5 s). This is acceptable
     — it only happens once, on first ever launch.
   - After bootstrap writes to SQLite and `queryClient.invalidateQueries()` fires, the chart
     refetches and reads from SQLite — should complete in < 300 ms.

3. Confirm no regressions on:
   - Web (SQLITE_AVAILABLE = false): chart still goes to Supabase/CDN, same as before.
   - Window switching (1M, 3M, 6M, 1Y, 3Y, All): each window's `navStartDate` is correct;
     the SQLite read uses the right `sinceDate` filter.
   - Benchmark switching: staggered prefetch still fires; cache key includes benchmark symbol.
