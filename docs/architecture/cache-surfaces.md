# Cache Surfaces Inventory

Every cache layer in FolioLens, in one place. Use this when adding a new cache, when an audit asks "have we covered every surface", or when debugging a stale-data bug.

## Why this doc exists

We've shipped three cache-related fixes in three weeks (PRs #133, #161, #164). Each was a different surface failing in a different way; each was discovered by a real user. The pattern is that caches are easy to add and hard to reason about as a system. This inventory makes the system surveyable.

The May 2026 audit after the PR #161 cache bug enumerated every cache, applied a
12-class bug taxonomy to each, and produced 1 HIGH + ~13 MED + ~5 LOW findings.
The historical tracker below remains as provenance; the surface inventory is the
current source of truth.

## Bug taxonomy

When adding a new cache, walk this list and note in the inline comment which classes you considered.

| | Class | Means |
|---|---|---|
| A | Bootstrap race | Cache populated before its source is valid; empty/null persisted then served past the TTL. |
| B | Schema drift | Persisted shape doesn't match new code; missing version/buster bump on a payload change. |
| C | TTL too long | Cache outlives its freshness contract; updates take too long to propagate. |
| D | Cross-user poisoning | Cache survives sign-out and is read by the next user (PII, feature flags, modals). |
| E | Invalidation cascade | Invalidate one key but a derived/dependent cache wasn't refreshed. |
| F | Stale-while-revalidate dead-letter | Fallback served forever because revalidation silently fails. |
| G | Concurrent read/write race | Two parallel reads/writes in different isolates or renders. |
| H | Cache as source of truth | Code reads cache and treats it as authoritative when source-of-truth is elsewhere. |
| I | Idempotency / buster bump cycle | New cached shape ships without the version/idempotency key being bumped. |
| J | CDN edge cache poisoning | CDN serves a stale snapshot for the full SWR window after the source updates or fails. |
| K | External API staleness | Upstream itself caches; we store its response as fresh. |
| L | Native vs web divergence | Behaviour differs across AsyncStorage (native, durable) and localStorage (web, 5 MB quota). |

## Surface inventory

### 1. React Query — in-memory + persisted (web localStorage / native AsyncStorage)

- **Where:** [`src/lib/queryClient.ts`](../../src/lib/queryClient.ts), [`src/lib/queryStaleTimes.ts`](../../src/lib/queryStaleTimes.ts).
- **Persister:** `@tanstack/query-async-storage-persister` via `@react-native-async-storage/async-storage`. Web uses `window.localStorage`.
- **Version mechanism:** `__BUSTER__` constant in `queryClient.ts` (currently **v12**) inside one stable AsyncStorage key. A buster mismatch discards the dehydrated client on restore. Before v10 the buster was also embedded in the storage key, which orphaned every older blob; v10 deletes all `foliolens.react-query-cache.v*` keys once and uses the stable key thereafter.
- **What to bump on:** any change to the cached payload shape — adding/removing a `select(...)` column, renaming a derived field, changing a query-key tuple element, switching a hook from object to scalar input. `cache-shape-check.yml` watches the high-risk files and requires either a buster bump or an explicit `[cache-shape-stable]` PR-title assertion.
- **Current buster (C2):** `__BUSTER__` is **v12**. v8 added `scheme_active`; v9 purged historical outputs computed from unproven recent-only SQLite slices; v10 migrated to the stable key and removed redundant raw daily-history payloads; v11 stops persisting `user-transactions` on native because SQLite owns the durable transaction copy, while web still persists it because there is no SQLite read-through; v12 adds transaction freshness metadata to public persisted Portfolio results so web can invalidate server-side CAS imports before the old one-hour Portfolio stale window keeps a pre-import value alive across reloads.
- **PERSIST_ALLOWLIST:** scoped to bounded, high-value rendered results and small supporting lookups. Raw `fund-nav-history`, `performance-timeline`, `index-snapshot`, `fund-detail`, and `fund-detail-index` arrays are memory-only because native SQLite/CDN already own their authoritative copies; `fund-detail` embeds the raw NAV array and therefore is not a bounded exception. `user-transactions` is web-only persistence; native rebuilds the React Query entry from SQLite instead of duplicating the largest raw user-scoped array in AsyncStorage. The serialized React Query client is capped at 4 MiB of JSON characters; on any write failure the retry path removes the largest dehydrated query until a valid smaller cache writes or no queries remain. This leaves headroom in Android's shared 6 MB AsyncStorage database for auth and app preferences.
- **N8 persister telemetry:** successful restores emit `persister_restore_completed` with buster, restore duration, blob bytes, query count, and per-prefix serialized bytes. Restore failures include duration and raw blob size. The cache-debug screen mirrors the same per-prefix byte breakdown so field screenshots can identify which persisted family dominates the blob without logging payload contents.
- **Prepared timeline input:** `['investmentTimelineInputs', userId, stableFundSet, window]` is an in-memory-only React Query entry. It holds benchmark-independent transaction/NAV inputs, lookup `Map`s, unit/cost/invested histories, candidate dates, the legacy-equivalent portfolio-valid date set, and memoized portfolio valuations so benchmark-only changes do not reread or rebuild them. It is deliberately absent from `PERSIST_ALLOWLIST`: the payload is user-scoped and contains non-JSON maps/sets. The existing sign-out `queryClient.clear()` removes it, and manual data sync invalidates it alongside `investmentVsBenchmarkTimeline`. The persisted output key and payload did not change when this entry was added, so no buster bump was required for that change. Bug taxonomy: B/I/L are avoided by not persisting; D uses existing sign-out cleanup; E is covered by paired invalidation; G uses React Query request deduplication; A/C/F/H/J/K do not apply because this is derived session data with the same stale time and authoritative inputs as the existing output query.
- **N2T index reuse:** timeline output reads the existing in-memory `['index-snapshot', symbol]` entry before fetching a benchmark. The payload remains the canonical `IndexSnapshot` object owned by `useIndexSnapshot`; N2T only filters its `points` to the transaction start date. C1 v10 stopped persisting this raw daily array because native SQLite/CDN already own the authoritative copy. A cached `null` snapshot still takes the existing paginated fallback, so a failed CDN response is not treated as authoritative.
- **N3 sync invalidation:** bootstrap and foreground delta sync map `txInserted`, `navInserted`, `idxInserted`, and transaction drift repair to the minimal dependent query-key prefixes in `src/lib/syncInvalidation.ts`. The inventory includes core portfolio/detail/timeline keys and financial-tool keys for Compare Funds, Direct vs Regular, Past SIP Check, and the held-fund picker. Every affected entry is marked stale with `refetchType: 'none'`; only affected active prefixes owned by the visible route are then refetched. Hidden screen queries include navigation focus in `enabled`, so they remain readable from cache but cannot wake during another route's transition. This changes no query key or payload shape, adds no cache, and requires no `__BUSTER__` bump. Bug taxonomy: E is handled by the centralized dependency map and exhaustive input-family/tool-route tests; C keeps each query's existing stale time; D uses existing sign-out clearing; B/I/L do not apply because persistence contracts are unchanged.
- **N7 portfolio core / benchmark split:** `usePortfolio` now composes the public persisted `['portfolio', userId, benchmarkSymbol]` output from two memory-only internal React Query families: `['portfolio-core', userId]` and `['portfolio-benchmark', userId, benchmarkSymbol]`. The core entry owns benchmark-independent fund cards, normalized/reversal-filtered transactions, totals, NAV freshness, and portfolio XIRR. The benchmark entry owns only index-history loading and selected-symbol market XIRR. Both internal keys are deliberately absent from `PERSIST_ALLOWLIST`: the public `['portfolio', …]` output remains the persisted render payload, while the internal entries duplicate user-scoped transaction-derived state that can be rebuilt from persisted `user-funds`/`user-transactions` plus SQLite/CDN inputs. Transaction sync invalidates `portfolio-core`, `portfolio-benchmark`, and the public `portfolio` output; NAV sync invalidates `portfolio-core` and public `portfolio`; index sync invalidates `portfolio-benchmark` and public `portfolio`. No `__BUSTER__` bump is required because the persisted public portfolio payload shape and key tuple are unchanged. Bug taxonomy: B/I/L are avoided by not persisting the new internal shapes; D uses existing sign-out `queryClient.clear()`; E is covered by sync-invalidation tests; G uses React Query request deduplication for concurrent core reads; C keeps the existing Portfolio stale time; A/F/H/J/K do not apply because these are derived session entries backed by existing authoritative sources.
- **C2 web Portfolio freshness marker:** public persisted `['portfolio', userId, benchmarkSymbol]` outputs now include optional `transactionFreshness: { count, latestCreatedAt }` metadata derived from the transaction rows used for the aggregate. Web lifecycle and post-restore checks compare that marker, plus the shared `['user-transactions', userId]` cache, against a cheap server marker query. If the server marker differs, the existing transaction invalidation fan-out marks Portfolio, Money Trail, timelines, Fund Detail, and transaction inputs stale together and refetches the visible route. `__BUSTER__` moves to v12 because the persisted Portfolio payload shape changed; the markerless old shape is also treated as stale when server transactions exist, so the buster is shape hygiene rather than the only correctness mechanism. Bug taxonomy: B/I are handled by v12 and markerless-entry invalidation; C is addressed by the freshness probe rather than shortening only staleTime; E uses the existing sync invalidation map; D uses existing sign-out `queryClient.clear()` and persister removal; L is explicit because the new probe runs only on web, while native keeps SQLite sync; A/F/G/H/J/K do not apply because the marker is derived metadata and the server remains authoritative.
- **Q4 CAS catalog isolation:** CAS imports can add a server-only provisional `scheme_master` identity and later replace its name through `sync-fund-meta`, but the new CAS identity creation/hydration/attempt timestamps are absent from all client selects. Query keys, fund/transaction payloads, persistence allowlists, stale times, native SQLite rows, and the existing import/sync invalidation paths are unchanged. The provisional identity is not an additional cache: it is a durable referential row whose incomplete status is explicit and retried with a 24-hour provider backoff. No `__BUSTER__`, SQLite `SCHEMA_VERSION`, Zustand version, or AsyncStorage key bump is required. Bug taxonomy: B/I/L do not apply because no client shape changes; E keeps the existing transaction/fund synchronization; F is handled by explicit provisional provenance plus bounded provider retries; D uses existing user-cache cleanup while the shared catalog remains global; A/C/G/H/J/K are unchanged.
- **CAS C1 holding-activation recency:** the atomic CAS database writer now resolves `user_fund.is_active` through a service-role-only database policy that checks balance recency before positive, zero, or missing closing units and treats an empty committed post-plan ledger as a deactivation floor. The client `user-funds` payload and every query key remain byte-for-byte unchanged; only an incorrect server boolean is prevented. Direct upload already refreshes user funds and Portfolio, while server-imported changes use the existing user-fund/transaction freshness and invalidation fan-out. No `__BUSTER__`, SQLite `SCHEMA_VERSION`, Zustand version, or AsyncStorage key bump is required. Bug taxonomy: E retains the existing direct/server import invalidation paths; F is closed by persisted prior state, explicit recency, and the ledger floor; D uses existing sign-out cleanup; A/B/C/G/H/I/J/K/L are unchanged because there is no new cache, payload, platform split, or lifecycle behavior.
- **C1 NAV-history coverage proof:** each scheme has an optional `sync_state` row at `nav-coverage:<schemeCode>`. Absence means SQLite may contain only a recent slice. A row with a date proves upstream completeness from that lower bound; a row with a null watermark proves an unbounded/full-history read. Coverage can only move earlier, and it is written after NAV rows are durable; successful empty intervals are also marked so genuine NFO pre-allotment gaps do not refetch forever. Historical timeline, Fund Detail, and Compare reads reject non-empty but unproven slices. Multi-scheme pagination is ordered by `nav_date` and then `scheme_code`. A timeline repair removes stale sibling `investmentTimelineInputs` and `investmentVsBenchmarkTimeline` entries; v9 purges persisted pre-fix outputs. Existing `sync_state` and NAV sign-out/reset cleanup removes both rows and their proof together. Bug taxonomy: B/H/I are addressed by explicit provenance plus the v9 purge; E by sibling eviction; F/G by serialized monotonic coverage writes and deterministic pagination; D by existing database cleanup; C by bounded lower-bound semantics.
- **Sign-out cleanup:** `queryClient.clear()` + `persister.removeClient()` in the application lifecycle controller installed by `app/_layout.tsx`. N0 keeps this cleanup active even when analytics is disabled.
- **Bug class watchlist:** A (any new module-scope cache), B (the buster), C (per-query staleTime), E (invalidation chains in `ClearLensCompareFundsScreen` hydration cascade), I (the buster again).

### 2. Edge function module-scope caches

- **Where:** Long-lived `let cached* = …` at module scope inside `supabase/functions/<fn>/index.ts`.
- **Current state:** **No active module-scope caches.** The AMFI ISIN→cap map cache that lived in `fetch-fund-snapshot/index.ts` (`cachedIsinToCap` / `cachedIsinToCapAt` / `CAP_MAP_TTL_MS`) was removed when OpenFolio `cap_mix` replaced the local classifier, along with the `stock_market_cap` table it loaded from. `isCachedMapStillValid` and the `_shared/amfi-xlsx-parser.ts` module that hosted it are also deleted.
- **Lifetime:** Until the Supabase Edge Function isolate restarts. TTL was enforced manually per cache; no active caches means no TTL to maintain.
- **If you add a new one:** Any new module-scope cache that loads from a DB table must guard against an empty-table bootstrap race (Class A). Use a helper analogous to the deleted `isCachedMapStillValid`: refuse to cache an empty map even within the TTL.
- **Sign-out cleanup:** N/A (not user-scoped).
- **Bug class watchlist:** A (use an empty-map guard for any new cache), G (parallel isolates writing the same row — idempotency precheck in `sync-fund-portfolios/index.ts` `existing` check).

### 3. Zustand `appStore` — persisted preferences + in-memory transient state

- **Where:** [`src/store/appStore.ts`](../../src/store/appStore.ts).
- **Storage:** AsyncStorage at key `foliolens-app-store`, version 7, with `migrate: migratePersistedAppState` + `merge: mergePersistedAppState`.
- **Persisted (`partialize` allowlist):** `defaultBenchmarkSymbol`, `appColorScheme`, `wealthJourney`, `returnAssumptions`, `goals`, `fundsSortBy`, `portfolioChartWindow`, `moneyTrailSortBy`. Survive app restarts and sign-outs by design — these are app preferences, not user-data.
- **In-memory only:** `previewMode`, `importGateVisible`, `dialog`, `toolsFlags`, `fundsSearchQuery`. **Reset on sign-out** via `useAppStore.getState().resetUserScopedState()` (PR #164). When you add a new in-memory user-scoped field, add it to that reset payload.
- **Version bump:** `version: 7` + `migratePersistedAppState`. Bump when the persisted shape changes; the migration function reshapes old persisted blobs.
- **Sign-out cleanup:** `resetUserScopedState()` (PR #164).
- **Bug class watchlist:** D (handled by reset), K (migration must strip removed fields).

### 4. Onboarding draft

- **Where:** [`src/utils/onboardingDraft.ts`](../../src/utils/onboardingDraft.ts).
- **Storage:** AsyncStorage at key `foliolens-onboarding-draft-v1`. Holds PAN, DOB, partial import result. (The `email` field was dropped from the draft in the 2026-05-20 onboarding redesign — the loader still silently discards `email` keys from older blobs via the shape-tolerant sanitiser.)
- **Version bump:** the `-v1` suffix in the key. **Manual** — no migration; bump key when shape changes (old blob effectively discarded). Audit #16 noted this is non-versioned in spirit; defensive `sanitizeX` in the loader handles missing fields silently.
- **Sign-out cleanup:** `clearOnboardingDraft()` from SIGNED_OUT handler (PR #164). PII must not cross sign-in boundaries.
- **Bug class watchlist:** B (key bump on shape change), D (handled by sign-out clear).

### 5. Supabase auth session

- **Where:** [`src/lib/supabase.ts`](../../src/lib/supabase.ts). On native, AsyncStorage (`sb-<project>-auth-token`); on web, localStorage.
- **Lifetime:** controlled by Supabase SDK. `signOut()` calls `storage.removeItem` on the session key as part of the sign-out mutation (verified against SDK source, May 2026).
- **Sign-out cleanup:** handled by `authClient.signOut()` itself; we don't need to remove the key explicitly. The PR #164 SIGNED_OUT handler runs *after* this.
- **Bug class watchlist:** D (verified clean), L (web vs native storage path).

### 6. SQLite read cache (native only)

- **Where:** [`src/lib/db/`](../../src/lib/db/). Tables: `tx`, `nav`, `index`, `fund`. Schema versioned via `SCHEMA_VERSION` constant in [`db.ts`](../../src/lib/db/db.ts) (currently 3).
- **Lifetime:** Persistent on-device. Wiped on sign-out via `clearAll()` (`clearLocalDb` in app/_layout).
- **Version bump:** bump `SCHEMA_VERSION` and update the schema-init path. Version 3 changes the `tx` primary key from the old fund/date/type/units/amount shape to immutable server `id`, allowing two genuine CAS events with identical economics to survive the native cache. A version mismatch drops this discardable cache and re-syncs from Supabase; the public React Query transaction payload and explicit server `select(...)` stay unchanged, so no `__BUSTER__` bump accompanies v3. Audit #15 noted that a mid-migration crash can leave orphan rows; preserve the serialized write/cleanup boundary when changing this area.
- **Sync watermark + deletion repair:** transaction delta fetches use `MAX(created_at)` for new/back-dated inserts. Because Q3 can delete an exactly reversed server row, every bootstrap/foreground sync separately compares sorted immutable transaction IDs from Supabase and SQLite. Any difference atomically replaces `tx` from a full server snapshot inside the shared write serializer; a failed replacement rolls back to the prior cache. NAV/index rows remain append-oriented `INSERT OR IGNORE` caches.
- **Write ownership:** one FIFO serializer in [`db.ts`](../../src/lib/db/db.ts) owns every write on the singleton connection. `tx`, `nav`, `idx`, `sync_state`, and cleanup writes must enter through that boundary; per-repository locks are invalid because all repositories share the same connection. Rejected entries propagate to their caller while the recovered queue tail continues. Privacy-safe `db:write_queue_wait` and `db:write` marks expose operation, queue depth, attempt, status, and duration.
- **Repair + cleanup ordering:** remote read-through flows capture a database-write scope before fetching. Sign-out/manual reset advances the scope generation and queues one wipe, so old queued or late-arriving writes reject before touching the reset cache. Timeline NAV fallback awaits its repair, retries once from the rows already fetched, and reports a final failure instead of silently leaving an incomplete cache.
- **Sign-out cleanup:** `clearLocalDb()` deletes every cached table row in one serialized transaction (PII in `tx`) before a later sign-in bootstrap may begin. The N0 application lifecycle controller runs and serializes this cleanup independently of analytics configuration.
- **Bug class watchlist:** B (schema migration crash recovery), G (shared-connection write overlap resolved by the serializer; keep every new write on the shared boundary), D (write-scope invalidation prevents old-user work landing after cleanup), F (timeline repair is awaited/retried and final failure remains observable).

### 7. CDN snapshot for index history

- **Where:** [`supabase/functions/regenerate-index-snapshots/index.ts`](../../supabase/functions/regenerate-index-snapshots/index.ts). Output: `static-snapshots/index/<symbol>.json` in a public Supabase Storage bucket.
- **Cache-Control:** `public, max-age=3600, stale-while-revalidate=86400`. SWR window is 24 hours.
- **Regeneration:** daily at 14:00 UTC weekdays, after the index sync window.
- **Client read:** [`useIndexSnapshot.ts`](../../src/hooks/useIndexSnapshot.ts) fetches the snapshot, falls back to a paginated PostgREST query on JSON-malformed or 404.
- **Bug class watchlist:** F/J (failed regeneration can serve a stale snapshot for the SWR window), K (snapshot can lag real `index_history` by roughly a day in the worst case).

### 8. Portfolio composition table (server-side, treated as cache by the client)

- **Where:** [`fund_portfolio_composition`](../../supabase/migrations/20260420000000_portfolio_insights_schema.sql) populated by [`openfolio-sync`](../../supabase/functions/openfolio-sync/index.ts) monthly cron (15th) + [`sync-fund-portfolios`](../../supabase/functions/sync-fund-portfolios/index.ts) daily cron + [`fetch-fund-snapshot`](../../supabase/functions/fetch-fund-snapshot/index.ts) on demand.
- **Source tagging + precedence:** `source` column distinguishes `'official'` (OpenFolio-Data parsed AMC disclosures — primary), legacy `'amfi'` rows, `'category_fallback'` (mfdata real holdings with SEBI-default cap mix), and `'category_rules'` (SEBI rules only, no holdings). New mfdata writes use `'category_fallback'`; the selector still ranks legacy `'amfi'` above category fallback while such rows exist. The best-row selector ranks `official > amfi > category_fallback > category_rules` via [`src/utils/compositionSource.ts`](../../src/utils/compositionSource.ts) (`pickBestCompositionRows`) — **not** alphabetical `source` sort, which breaks because `'official'` sorts last. Multiple sources for one scheme coexist under `UNIQUE(scheme_code, portfolio_date, source)`. Client UI surfaces a disclaimer for the category-derived sources.
- **Shape note:** adding the `'official'` source value + the read-selector swap is cache-shape-stable — same `select()` columns, same `['portfolio-composition', [code]]` key tuple, same array shape; only row *selection* changed, so no `__BUSTER__` bump (see the cache-shape CI guard).
- **Bug class watchlist:** A (empty-map race), C/F (partial-success TTL traps), K (upstream holdings stored without validation), H (category proxy misuse; see audit #23 / PR #188 / [postmortem](../postmortems/2026-05-flexicap-proxy-strikes-twice.md)).

## Audit finding provenance

The original May 2026 tracker is historical. Do not use phase labels from old
plans as a current roadmap. When a cache bug is fixed, the durable state should be
reflected in the relevant surface entry above: owner, persistence status,
version/buster mechanism, invalidation path, sign-out cleanup, and tests. New
open risks should be tracked in the active PR/issue/plan that owns them, then
rolled back into this inventory when implemented.

## When adding a new cache — checklist

Before merging a PR that introduces a new cached value (anywhere — React Query, edge-function module, AsyncStorage, SQLite, CDN):

1. **Add a row to the inventory above** describing the surface.
2. **Walk the bug taxonomy.** For each of A–L, note in the code's inline comment whether you considered it ("not applicable: <reason>" is a fine answer). The audit was triggered by realising every cache bug we've shipped fits one of these classes.
3. **Pick a version mechanism.** If the cached payload shape can change in a future PR, bump-it-on-change must be obvious. Today: `__BUSTER__` for React Query, `version` + `migrate` for Zustand, `-v1`-suffixed key for AsyncStorage drafts, `SCHEMA_VERSION` for SQLite.
4. **Decide sign-out behaviour.** If the cached data is user-scoped, add the cleanup to `app/_layout.tsx` SIGNED_OUT handler (or to `useAppStore.resetUserScopedState()` if it's in-memory Zustand).
5. **Empty-result guard.** If the cache loads from a table that might be empty before the source has populated it (the PR #161 bug class), use `isCachedMapStillValid` or an equivalent guard. Don't cache the empty result.
6. **Tests.** Pure helpers go to `_shared/`-style modules with unit tests. The cache decision (refresh vs use) is the load-bearing assertion; test it independently of the I/O.
