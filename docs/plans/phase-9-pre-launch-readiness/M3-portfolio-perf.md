# Phase 9 M3 — Portfolio screen perf: persistent cache + delta-fetch


## Goal


After this milestone, the Portfolio (Home) screen feels instant on warm starts. Concretely:

- A page reload on `app.foliolens.in` returns the user to a fully-rendered portfolio + chart in under one second when the cache is warm, instead of the current ~3–6 seconds where the chart spins for a noticeable beat after the cards appear.
- Navigating away from Portfolio inside the app and back paints the cached state immediately, with a background revalidation that is invisible unless data actually changed.
- Daily NAV publish (~24h) triggers a small delta fetch (10 rows) instead of a full history fetch (12,500+ rows), so the network bill for a returning user is dominated by today's price tick rather than a re-download of every NAV ever.


## User Value


For the user: opening the app on the train, where mobile signal is patchy and roundtrips to Supabase routinely run 400–800ms, the Portfolio screen does not block on a network request. Past prices the user has already seen don't get re-fetched — they live in the browser's localStorage, and only the new prices since the last visit cross the wire.


For the founder: this milestone reduces both perceived latency (user-felt) and Supabase bandwidth. At a typical user volume (10 funds, 5 years of daily NAVs, daily app opens) it cuts the warm-day Portfolio fetch from ~14,000 rows to ~10–20 rows.


## Context


Investigation on 2026-05-10 mapped what the Portfolio (Home) screen pulls on every cold mount:

| Hook | Tables | Approx rows (10 funds × 5y) |
| --- | --- | --- |
| `usePortfolio` | `fund`, `transaction`, `nav_history`, `index_history` | ~13,950 |
| `useInvestmentVsBenchmarkTimeline` | `transaction`, `nav_history`, `index_history` (paginated 1000 / call) | ~13,950 |
| `usePortfolioInsights` | `fund_portfolio_composition` | ~10 |
| `useMoneyTrail` | `transaction`, `fund` | ~210 |
| **Total** | | **~28,000 rows** |

`nav_history` and `index_history` together are 99% of that volume, and they are append-only — past rows never change. `transaction` is append-only with low write frequency. `fund` and `user_profile` are tiny.

Two structural problems amplify the wait:

1. **No persistence.** `src/lib/queryClient.ts` constructs a `QueryClient` with `staleTime: 5 * 60 * 1000` and no persister. On a page reload the cache is empty; every query refetches from scratch. There is `@react-native-async-storage/async-storage` in the bundle (which is `window.localStorage` on web) but it is not wired to React Query.
2. **No delta fetch.** Each NAV/index query fetches the full history every time it refetches, even though the only new row is whatever published since the last fetch. After 5 minutes of `staleTime`, the next mount re-pulls 14k rows just to learn that NAVs ticked once.

A user moving between tabs and back — the symptom that prompted this milestone — also runs into the React Query default `gcTime` of 5 minutes: data goes from cached → garbage-collected → refetched. Persisting the cache + raising `gcTime` removes that footgun for the page-reload and tab-away cases at once.


## Assumptions


1. Users primarily open FolioLens on web (`app.foliolens.in`) on phones — the same surface the perf complaint came from. The native app benefits too because AsyncStorage is durable on iOS / Android by default, but web is the bottleneck (cold reload is more common, and the chart blocks on more concurrent network roundtrips).
2. `window.localStorage` on web has a per-origin quota of ≥5 MB (the browser-spec minimum; Safari and Chrome both ship 5–10 MB in practice). One user's persisted React Query cache, JSON-encoded, is dominated by NAV / index history — at ~50 bytes per row × 14k rows, the estimate is ~700 KB pre-compression. Well inside the quota.
3. AMFI's daily NAV publish lands ~10:30 PM IST. NAVs older than today's most-recent close are immutable. Index closes follow the same daily-immutable pattern.
4. Transactions are append-only from the user's side (CAS imports add new rows, parsed from a fresh PDF). They never modify a past row's units / amount.
5. The delta-fetch correctness boundary is "rows whose `nav_date` (or `index_date`) is strictly greater than the latest cached date for that scheme." We do not need to handle backfills of historical rows because the AMFI sync edge function never rewrites them; on the rare occasion it does, the cache buster in this plan is the escape hatch.


## Definitions


- **Persister** — a small adapter that serialises the React Query cache to a key/value store and rehydrates it on app start. We use `@tanstack/query-async-storage-persister` with the existing `@react-native-async-storage/async-storage` (which transparently uses `window.localStorage` on web).
- **Buster** — a string baked into the persisted cache. When the app code changes the buster, every persisted entry is discarded on next start. Bumping the buster is how we recover from schema migrations or query-shape changes.
- **`staleTime` vs `gcTime`** — `staleTime` is "how long until React Query considers cached data 'might be out of date' and should be revalidated in the background"; `gcTime` is "how long until cached data is dropped from memory entirely once nothing is using it". Both default to 5 minutes; this plan raises `gcTime` so cached data isn't dropped between tab switches, and lengthens `staleTime` per-query for stable data so revalidation doesn't fire as often.
- **Delta fetch** — given a list of `scheme_code`s and the latest `nav_date` already on hand for each, ask Supabase only for `nav_date > latest_known_date`. If we have nothing cached for a scheme, fall back to the full fetch for that scheme. Same shape for `index_history` keyed by `index_symbol`.
- **Cache shape stability** — every consumer of a cached row reads the same column set so partial shapes don't leak into the cache. The Portfolio screen already enforces this for `user_profile` (M2 follow-up); this milestone keeps the existing cache shapes unchanged for `usePortfolio` etc. — the only new hook is the delta fetcher, which has its own dedicated cache key.


## Scope


- Add `@tanstack/query-async-storage-persister` and `@tanstack/react-query-persist-client` to `package.json`.
- Replace `<QueryClientProvider>` in `app/_layout.tsx` with `<PersistQueryClientProvider>` and wire it to AsyncStorage.
- Bump `gcTime` to 24 hours on the QueryClient default so persisted data isn't immediately evicted on reload, and so tab-away ↔ tab-back keeps memory cache.
- Tighten `staleTime` per query family in `src/lib/queryStaleTimes.ts`:
    - NAV / index queries: 6 hours.
    - Portfolio composition: keep 1 hour.
    - Portfolio aggregate (`usePortfolio`): 1 hour (down from 5 min) — past NAVs don't change inside that window, today's tick is already covered by background revalidation.
    - Money trail / transactions: 5 minutes.
    - User profile: short, controlled by `useUserProfile`.
- Build `src/utils/navHistoryDelta.ts` — a pure helper that, given a list of `scheme_code`s and a cached `latestByScheme: Record<schemeCode, dateString>`, returns the SELECT clause + `gte` boundary for the delta query. Pure and unit-testable.
- Build `src/hooks/useNavHistory.ts` — a thin React Query hook that owns the `nav_history` cache. It looks up the previously-cached payload via `queryClient.getQueryData`, derives `latestByScheme`, runs the delta fetch through `navHistoryDelta`, and merges the result with the cached payload.
- Symmetric `src/hooks/useIndexHistory.ts` for `index_history` keyed by `index_symbol`.
- Refactor `src/hooks/usePortfolio.ts` and `src/hooks/useInvestmentVsBenchmarkTimeline.ts` to call the new shared hooks instead of re-querying `nav_history` / `index_history` directly. Keep the legacy `fetchPortfolioData` shape stable so the consumer screen code does not change.
- Add a `__BUSTER__` constant in `src/lib/queryClient.ts` set to `'v1'`. Any future schema change bumps it.
- Wire a "skip persist" filter so we do not persist `auth-session`, `user-profile`, or any query whose key starts with `['supabase-internal', …]` (none today, but the filter is the place where future ones land).
- Add Jest tests:
    - `src/utils/__tests__/navHistoryDelta.test.ts` — pure helper, full branch coverage.
    - `src/hooks/__tests__/useNavHistory.test.ts` — mocks the supabase client and asserts the hook makes a delta-shaped call when cache is warm and a full-shape call when cache is empty.
    - Lift the existing `usePortfolio.test.ts` to cover the delta path (cache warm → small SELECT, cache empty → full SELECT).
- Update `README.md`'s "What works now" with one bullet about the cache.


## Out of Scope


- Server-side caching. The bottleneck is round-trips and JSON payload size, not Supabase compute.
- Switching from `localStorage` to IndexedDB on web. AsyncStorage's localStorage shim is sufficient at current data volume; if a 50-fund / 15-year user appears, we revisit. The persister API is storage-agnostic so the migration would be one file.
- Pre-fetching the next benchmark on hover/idle. Already partially implemented in `usePortfolio`'s `prefetchQuery` block; not touched here.
- Optimistic updates after CAS import. CAS import already invalidates the right keys; this plan does not change invalidation behaviour.
- Compression. JSON inside localStorage is reasonably small after the delta-fetch reduces the steady-state payload. If quota becomes an issue we can layer in `lz-string` later — the persister's `serialize` / `deserialize` hooks are the right seam.
- Native iOS / Android perf optimisation. AsyncStorage is durable on native and the perf complaint was specifically about mobile *web*. Native gets the cache-persistence win for free.


## Approach


### 1. Persistence wiring (15 LOC)

`app/_layout.tsx`'s `<QueryClientProvider client={queryClient}>` becomes:

    <PersistQueryClientProvider
        client={queryClient}
        persistOptions={{
            persister,
            buster: __BUSTER__,
            maxAge: 24 * 60 * 60 * 1000,
            dehydrateOptions: {
                shouldDehydrateQuery: (q) => SHOULD_PERSIST(q.queryKey),
            },
        }}
    >

`persister` is created in `src/lib/queryClient.ts`:

    import { createAsyncStoragePersister } from '@tanstack/query-async-storage-persister';
    import AsyncStorage from '@react-native-async-storage/async-storage';
    export const persister = createAsyncStoragePersister({
        storage: AsyncStorage,
        key: 'foliolens.react-query-cache.v1',
        throttleTime: 1000,
    });

`SHOULD_PERSIST` is a small allowlist exported from the same file. We persist `['portfolio', …]`, `['nav-history', …]`, `['index-history', …]`, `['portfolio-composition', …]`, `['money-trail', …]`, `['investmentVsBenchmarkTimeline', …]`. We skip `['user-profile', …]` and any key starting with `['auth', …]`.

### 2. Delta-fetch helpers (`src/utils/navHistoryDelta.ts`)

Pure functions:

    export interface NavRow { scheme_code: number; nav_date: string; nav: number }

    export function deriveLatestByScheme(rows: NavRow[]): Record<number, string>

    export function deltaQueryWindow(
        schemeCodes: number[],
        latestByScheme: Record<number, string>,
    ): { schemes: number[]; minDate: string | null }

    export function mergeNavRows(cached: NavRow[], delta: NavRow[]): NavRow[]

`deltaQueryWindow` returns the *minimum* `latest` across requested schemes. The single SQL call uses `.in('scheme_code', schemes).gte('nav_date', minDate)` and we filter per-scheme client-side. Doing one Supabase round trip beats N parallel ones for the typical fund count (≤20).

If `latestByScheme[scheme]` is missing for any scheme, the helper degrades gracefully: `minDate` is `null` and the caller fetches full history for those schemes.

### 3. `useNavHistory` hook

Reads the previous query data from `queryClient.getQueryData<NavRow[]>(['nav-history', schemeCodes])`. If present:

- compute `latestByScheme`
- fetch delta
- merge

If absent (cold mount or first run after buster bump):

- run the existing full-history SELECT (re-using `usePortfolio.ts`'s current SQL).

The hook returns `NavRow[]` sorted descending by `nav_date`, matching the format `usePortfolio` already expects.

### 4. Consumer refactor

`usePortfolio.ts` previously did its own `nav_history` SELECT inside `fetchPortfolioData`. After this milestone:

- `fetchPortfolioData(userId, benchmarkSymbol, navHistory, indexHistory)` — its NAV / index inputs are passed in, not fetched inline.
- `usePortfolio()` becomes a small composer that calls `useFunds`, `useTransactions`, `useNavHistory`, `useIndexHistory`, then runs the existing pure compute (`fundCards`, summary, vsMarket, etc.) inside a `useMemo`.

`useInvestmentVsBenchmarkTimeline` is the same shape: `useNavHistory` + `useIndexHistory` + per-window compute in `useMemo`. The window-aware filtering moves to the consumer (it is already pure — `filterToWindow` is in `src/utils/navUtils.ts`).

### 5. staleTime + gcTime tuning

A new tiny module `src/lib/queryStaleTimes.ts` exports labelled constants so each hook self-documents its expectation:

    export const STALE_TIMES = {
        NAV_HISTORY: 6 * 60 * 60 * 1000,           // NAVs publish daily ~22:30 IST
        INDEX_HISTORY: 6 * 60 * 60 * 1000,
        PORTFOLIO: 60 * 60 * 1000,                  // depends on NAV; same cadence
        PORTFOLIO_COMPOSITION: 60 * 60 * 1000,      // already 1h
        MONEY_TRAIL: 5 * 60 * 1000,                 // user can add txs in-session
        USER_PROFILE: 5 * 60 * 1000,
    };

`gcTime` defaults to 24 hours globally so persisted data is not evicted from memory immediately on reload.

### 6. Buster

`src/lib/queryClient.ts` exports `export const __BUSTER__ = 'v1'`. Bumped any time:

- A query's row shape changes (new column, dropped column, renamed key).
- A migration backfills history rows (so cached deltas would be wrong).
- React Query's serialisation format changes (rare, but possible across major versions).


## Alternatives Considered


- **Persist via IndexedDB**. Better quota, but requires an extra dependency on web and is unused on native. AsyncStorage's localStorage shim covers expected payload sizes; revisit only if a power user hits the 5 MB ceiling.
- **Move NAV / index lookups to a Supabase view**. Doesn't help the round-trip / payload-size problem; the bottleneck is "rows over the wire" not "rows scanned".
- **Server-Sent Events for NAV updates**. Real-time NAV is over-engineered for a once-a-day publish. Cron-based daily AMFI sync remains correct.
- **Paginated infinite-scroll on NAV history**. Doesn't help the chart, which needs the full window. Delta fetch over a persisted cache solves the same problem with less code.


## Milestones



### M3.1 — Persistence wiring + gcTime + tests for the persister filter

- Install the two `@tanstack` packages.
- Replace provider, add `persister`, add `SHOULD_PERSIST` allowlist, add `__BUSTER__`.
- Set `gcTime: 24h` on QueryClient default.
- Tests: pure-function tests for `SHOULD_PERSIST` (covers the allowlist + skip rules).
- Acceptance: a hard-reload of the running web app on `app.foliolens.in` paints the Portfolio cards before the network finishes; React Query devtools show queries restored from cache.



### M3.2 — `navHistoryDelta` + `useNavHistory` + `useIndexHistory`

- Build the pure helpers in `src/utils/navHistoryDelta.ts`.
- Build the two hooks.
- Tests:
    - `deriveLatestByScheme` — empty input, single scheme, multi-scheme, ties.
    - `deltaQueryWindow` — all schemes cached, partial cache, empty cache, single scheme.
    - `mergeNavRows` — dedupe by (scheme_code, nav_date), preserve sort order.
    - `useNavHistory` — uses `select` with `.gte('nav_date', minDate)` when cache warm; uses no `gte` when cache cold.
- Acceptance: in a unit test, a warm cache for scheme `12345` with `nav_date <= 2026-05-09` triggers a SELECT that includes `gte('nav_date', '2026-05-09')`, not the full history.



### M3.3 — Refactor `usePortfolio` + `useInvestmentVsBenchmarkTimeline` to consume the new hooks

- Pull the NAV / index SQL out of `fetchPortfolioData`. Keep its return shape unchanged.
- Wire the composer hook.
- Run existing tests; update mocks where the chain changes shape.
- Acceptance: existing tests pass; portfolio page renders identically; chart still draws.



### M3.4 — staleTime constants and rollout to all consumers

- Add `src/lib/queryStaleTimes.ts`.
- Each hook switches its inline `staleTime: 5 * 60 * 1000` for the labelled constant.
- Acceptance: a global grep for the literal `5 * 60 * 1000` returns only `STALE_TIMES.MONEY_TRAIL` and `STALE_TIMES.USER_PROFILE`.



### M3.5 — Smoke and PR

- `npm run typecheck`, `npm run lint`, `npm test -- --coverage`.
- Manual: start `npm run web`, sign in, watch DevTools Network tab. On warm reload, `nav_history` and `index_history` payloads are <50 rows.
- Open PR with the diff + this ExecPlan.


## Validation


On a development build:

1. Cold cache (clear localStorage, reload). DevTools Network: `nav_history` and `index_history` calls show *no* `gte=…` filter (full fetch). Cards + chart paint after the network resolves.
2. Reload again without clearing. DevTools Network shows `nav_history?nav_date=gte.YYYY-MM-DD` and `index_history?index_date=gte.YYYY-MM-DD` with *today's* date as the lower bound (or yesterday's, depending on AMFI publish state). Payload <50 rows. Portfolio cards paint instantly from cache before the network resolves.
3. Wait six hours, reload. NAVs revalidate in the background; user-visible state stays painted from cache.
4. Clear cache by bumping `__BUSTER__` in source, reload. All queries refetch from scratch — verifies the buster works.
5. On native (Expo Go or a dev-client install), kill the app and relaunch. Portfolio paints from AsyncStorage before the network resolves.

Numerical:

- Network rows on warm reload: ≤ 50 (down from ~14,000).
- Time-to-first-pixel of Portfolio cards on warm reload: < 200 ms on a fast desktop, < 1000 ms on mobile web with 4G.


## Risks And Mitigations


| Risk | Mitigation |
| --- | --- |
| Cached rows go stale across a schema change. | `__BUSTER__` constant; bump on every schema-affecting migration. |
| `localStorage` quota exceeded for a power user. | Quota errors are caught; persister's `removeClient` fires and we fall back to in-memory only. We log via the existing analytics facade (`analytics.captureException`). |
| AMFI back-fills a historical NAV row (rare but happens for corrections). | The delta `gte` would miss it. Mitigation: bump `__BUSTER__` whenever the corrections sync runs; the corrections workflow already writes a `cas_import` audit row, so we add a check in `sync-fund-meta` that surfaces a Supabase audit log we can react to manually. Documented in the runbook. |
| Persisted cache contains the *wrong* user's data after a sign-out/sign-in. | The persister key includes `__BUSTER__` only, not the user id. Mitigation: clear the persister on sign-out. We hook the existing `supabase.auth.onAuthStateChange` listener in `app/_layout.tsx` to call `persister.removeClient()` on `SIGNED_OUT`. |
| `gcTime: 24h` keeps too much in memory on long-running native sessions. | Worst-case memory cost is ~1.5 MB per active user. Acceptable. If profiling shows otherwise, lower to 4h. |
| AsyncStorage write is slow on a low-end Android device, hitting the throttle. | `throttleTime: 1000` already debounces. Persisted writes are async and never block render. |


## Decision Log


- **2026-05-10** — Chose AsyncStorage persister over IndexedDB. Rationale: the existing `@react-native-async-storage/async-storage` polyfills `window.localStorage` on web (verified in `node_modules/@react-native-async-storage/async-storage/lib/module/AsyncStorage.js` lines 16–34); using it keeps native + web on a single API and avoids a second persistence dep. Will revisit if quota becomes a recurring complaint.
- **2026-05-10** — Single delta `gte` for *all* schemes in one call rather than per-scheme parallel calls. The min-date approach over-fetches a tiny amount (rows whose date is between the per-scheme latest and the overall min) but trades that for one Supabase round trip instead of N. At typical fund counts the over-fetch is < 100 rows.
- **2026-05-10** — `__BUSTER__` lives in source, bumped manually. Considered tying it to `package.json` `version`, but that would invalidate the cache on every release whether or not query shapes changed. Manual bumps are cheap and intentional.


## Progress

- [x] M3.1 — persister wired (`@tanstack/query-async-storage-persister` + `@tanstack/react-query-persist-client`), `gcTime: 24h`, `__BUSTER__` constant, allowlist filter, sign-out cache clear (`SIGNED_OUT` event in `app/_layout.tsx`)
- [x] M3.2 — `src/utils/navHistoryDelta.ts` (pure helpers) + `src/lib/sharedHistoryCache.ts` (cache-aware fetchers) with tests; 100% line coverage on the pure helper, 89% on the cache layer (uncovered lines are the `qc.fetchQuery` wrappers, which need a live query client to test)
- [x] M3.3 — `usePortfolio` + `useInvestmentVsBenchmarkTimeline` route NAV / index reads through `fetchNavHistoryWithCache` / `fetchIndexHistoryWithCache`; the inline `fetchAllNavRows` / `fetchAllIndexRows` helpers in the timeline hook were removed
- [x] M3.4 — `STALE_TIMES` constants applied across `usePortfolio`, `useInvestmentVsBenchmarkTimeline`, `usePortfolioTimeline`, `usePerformanceTimeline`, `useMoneyTrail`, `usePortfolioInsights`, `useFundComposition`, `sharedHistoryCache`. The only remaining `5 * 60 * 1000` literal is `useFundDetail`'s `staleTime: 0` (intentional)
- [ ] M3.5 — smoke verified on web + native; PR open

### Decision Log Amendment — 2026-05-10

Implementation took the simpler "cache-aware fetcher" path rather than building dedicated `useNavHistory` / `useIndexHistory` hooks as originally sketched. The shared layer (`fetchNavHistoryWithCache` / `fetchIndexHistoryWithCache`) wraps `qc.fetchQuery`, which gives multi-consumer cache sharing without a hook-shaped public API. Both `usePortfolio` and `useInvestmentVsBenchmarkTimeline` keep their existing `useQuery` cache keys; the NAV / index fetch is delegated to the shared layer inside their `queryFn`. This minimised the surface area of the change (existing tests for `fetchPortfolioData` only needed a mock-chain `.range()` addition; no consumer logic was rewritten).


### Post-merge bug report — 2026-05-11

Testing on the `foliolens-main` OTA build surfaced three issues that the original PR missed:

1. **`fetchIndexHistoryWithCache` shape collision.** `app/fund/[id].tsx:188-203` runs its own `useQuery` against the *same* cache key (`['index-history', selectedSymbol]`) that my shared layer wrote to, but stores rows in `{ date, value }[]` shape — not the `{ index_date, close_value }[]` shape my fetcher expects. When the user visited Fund Detail with Nifty 500 TRI selected, the wrong-shape payload landed in the persister. On the next Portfolio mount, the timeline's `fetchIndexHistoryWithCache` call hit the cached value via `qc.fetchQuery` (data not stale per `staleTime: 5min`), and the downstream `.filter(row => row.index_date >= firstTxDate)` dropped every row because `index_date` was undefined. The Investment-vs-Benchmark chart's `points.length < 2` guard then unmounted the entire chart section — but *only when the active benchmark matched what the user had previously opened in Fund Detail*. Switching to Nifty 50 / Nifty 100 worked because those keys had no cross-contamination. This is the exact same cache-shape-collision pattern fixed in PR #127 for `user-profile`.

2. **Cold-load regression on Portfolio and Timeline.** The previous code paths fetched window-bounded data (`.gte('nav_date', windowStart)`, `.gte('index_date', firstTxDate)`). My shared layer fetches *full* history regardless of window because the cache is keyed by `(userId, schemeCodes)` and has to hold every row anyone might ever ask for. For a user with 10 funds and an `^NIFTY500TRI` benchmark, the cold-load now paginates ~12,500 NAV rows + 7,769 index rows through 1000-row pages — ~15 round trips, ~8s on the user's connection. The persister doesn't help on the *first* launch after the OTA bundle drops (cache is empty), so the user genuinely felt the regression. Wins only appear from the second relaunch onward.

3. **Fund Detail chart clipping.** Pre-existing bug, surfaced by the user's iPhone testing in this round. The NAV history, Performance %, and "How your money grew" `LineChart`s on `app/fund/[id].tsx` all compute `spacing = Math.max(8, (chartBodyWidth - 16) / (samplePoints - 1))`. On a narrow viewport with 60–90 sampled points, the natural spacing computes to ~4px but is clamped to 8px. The chart then extends ~2× wider than its canvas and the right half is clipped by `react-native-gifted-charts` (which doesn't enable scroll-on-overflow by default). Worst on the "All" range. Not caused by this milestone but in scope for the follow-up since the user reported it together.

### Follow-up plan — 2026-05-11

1. **Strategic retreat on the shared NAV/index cache.** Drop the `qc.fetchQuery` indirection in `fetchPortfolioData` and `fetchInvestmentVsBenchmarkTimeline`. Each consumer fetches what it actually needs:
    - `fetchPortfolioData`: only the last 90 days of NAVs (sparkline is 30 days; the extra 60 days are buffer for weekends + lookback so the "previous NAV" exists even after a holiday weekend).
    - `fetchInvestmentVsBenchmarkTimeline`: window-bounded as before. Keeps the original `fetchAllNavRows` / `fetchAllIndexRows` shape.
    - `app/fund/[id].tsx`: keeps its existing `{ date, value }[]` shape; cache key is renamed to `['fund-detail-index', selectedSymbol]` so it can't collide with anything in `src/lib/sharedHistoryCache.ts` even if a future caller is added.
    - `sharedHistoryCache.ts` stays in the tree as future-tooling but no live consumer uses its `*WithCache` wrappers after this PR. Its `*Direct` functions remain only as the pagination implementation underneath the inline fetches.

2. **Fund Detail chart fits the viewport.** Cap sample count by chart-body width so spacing stays ≥ 4px without needing a `Math.max` clamp that pushes content off-canvas. Apply the same helper to all three `LineChart`s.

3. **Persister restore observability.** Wire `onSuccess` and `onError` on `PersistQueryClientProvider`. Both call `analytics.track` (already in the bundle) and `console.log` with elapsed ms + persisted-bytes so the user can confirm in PostHog (or device logs) that the OTA bundle actually restored the cache.

4. **Keep the wins from M3.1:** persister wiring, `gcTime: 24h`, `STALE_TIMES`, `__BUSTER__`, sign-out clear. Those are correct and untouched.

The trade-off: delta-fetch (M3.2's specific user ask) is set aside until the cache architecture is solid. The persister-backed cache of *computed* results (`['portfolio', userId, benchmarkSymbol]` and `['investmentVsBenchmarkTimeline', ...]`) is what actually delivers the user-visible "page reload paints instantly" win — and it survives this revert.


### Round-2 follow-up — 2026-05-11 (still on PR #135)

Field testing the bug-fix bundle on the foliolens-main Android OTA surfaced a fresh symptom the persister hadn't fixed: **the Portfolio screen flashed "Import CAS" before showing the spinner before painting cards**. Three-state flicker, not the two-state load we expected. Root cause: `PersistQueryClientProvider` puts queries into `fetchStatus: 'paused'` while it rehydrates, and in React Query v5 `isLoading` is `(isPending && fetchStatus === 'fetching')` — so during the paused window `isLoading` is **false** and `data` is `undefined`. The Portfolio screen's render chain (`isLoading ? spinner : empty? "Import CAS" : cards`) fell through to the empty-state branch and rendered the "Import CAS" button for the ~0.5–1s rehydrate window before the cached payload arrived. Same flicker on Fund Detail.

In addition, three user-journey complaints needed direct attention:

1. **Just finished onboarding → tap Done → land on Portfolio.** Wizard's `handleFinish` invalidated every query and navigated, but no prefetch — Portfolio mounted cold and spun another 2–3s while the post-import fetch ran. The user had already waited for the CAS parser; another spinner felt punishing.

2. **Same-day reopen.** Persister was restoring fine but the flicker above made it look like loading even when the cached payload was about to arrive.

3. **Fund Detail cold-load.** `useFundDetail` did a full paginated NAV history fetch (1k–3k rows) and a full paginated index history fetch *before* its `useQuery` resolved — so the entire fund-detail page stayed on a spinner until both finished, despite the header card / metadata / XIRR only needing one short SELECT.

### Round-2 fixes in this PR

- **`useIsRestoring` gate on Portfolio (mobile + desktop) and Fund Detail.** A new `showFirstLoad = isRestoring || isLoading || data === undefined` collapses the three-state flicker to a clean spinner during rehydrate and switches to the real page (or genuinely-empty state) only once we have data on hand or have confirmed there is none.

- **Prefetch in onboarding `handleFinish`.** After invalidating, fire a `queryClient.prefetchQuery({ queryKey: ['portfolio', userId, benchmarkSymbol], … })` so the network request overlaps with the React Native navigation animation. The user lands on Portfolio with a populated (or near-populated) cache instead of triggering a fresh fetch from a cold mount.

- **Split Fund Detail's NAV history into a deferred query.** `fetchFundDetail` now SELECTs only the two most-recent NAV rows (enough for "current NAV" + "as of"). The full paginated history is exposed via a separate `useFundNavHistory(schemeCode)` hook that runs in parallel; the screen passes its result to the chart components, which gate on `navHistory.length > 1` to show their own empty/loading state until it lands. `useFundDetail.indexHistory` was also dropped from the response shape because the screen's `['fund-detail-index', symbol]` query already owns the benchmark series. Net effect: fund detail's header card paints from a single round-trip-and-a-bit, charts fill in 1–2s later.

- **`'fund-nav-history'` added to the persist allowlist** so the deferred fetch survives across reloads.

Tests: 991 still passing. The `useFundDetail` test mocks gained a `.limit()` chain method (now the terminal call for the light SELECT) and a tighter `MOCK_NAV` fixture in descending order; the obsolete `MOCK_INDEX` block and the period-return assertion that depended on full `data.navHistory` were dropped — full-history assertions belong on `useFundNavHistory` once we add tests for it.
