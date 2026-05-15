# Cache Surfaces Inventory

Every cache layer in FolioLens, in one place. Use this when adding a new cache, when an audit asks "have we covered every surface", or when debugging a stale-data bug.

## Why this doc exists

We've shipped three cache-related fixes in three weeks (PRs #133, #161, #164). Each was a different surface failing in a different way; each was discovered by a real user. The pattern is that caches are easy to add and hard to reason about as a system. This inventory makes the system surveyable.

The May 2026 audit (Phase 1 of the post-PR #161 follow-up) enumerated every cache, applied a 12-class bug taxonomy to each, and produced 1 HIGH + ~13 MED + ~5 LOW findings. Each finding is mapped below to its surface + the PR that addressed (or will address) it.

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
- **Version mechanism:** `__BUSTER__` constant in `queryClient.ts` (currently v4). Every persisted entry is keyed by buster; bumping the buster discards every persisted entry on next start.
- **What to bump on:** any change to the cached payload shape — adding/removing a `select(...)` column, renaming a derived field, changing a query-key tuple element, switching a hook from object to scalar input. **No automated check today** (audit finding #12 — Phase 2).
- **PERSIST_ALLOWLIST:** scoped to high-value reads (NAV, index history, scheme master, portfolio composition). Preview-mode keys are excluded by design.
- **Sign-out cleanup:** `queryClient.clear()` + `persister.removeClient()` in `app/_layout.tsx` SIGNED_OUT handler.
- **Bug class watchlist:** A (any new module-scope cache), B (the buster), C (per-query staleTime), E (invalidation chains in `ClearLensCompareFundsScreen` hydration cascade), I (the buster again).

### 2. Edge function module-scope caches

- **Where:** Long-lived `let cached* = …` at module scope inside `supabase/functions/<fn>/index.ts`. Currently one in [`fetch-fund-snapshot/index.ts`](../../supabase/functions/fetch-fund-snapshot/index.ts) for the AMFI ISIN→cap map.
- **Lifetime:** Until the Supabase Edge Function isolate restarts. TTL is enforced manually per cache (currently 6h for the ISIN map).
- **Helper:** [`isCachedMapStillValid`](../../supabase/functions/_shared/amfi-xlsx-parser.ts) handles bootstrap-race (Class A): refuses to use an empty cached map even within the TTL. Use this for any new map cache.
- **What to bump on:** the source table's shape changing — but more importantly, **any new module-scope cache must use the empty-map guard** or it will repro PR #161.
- **Sign-out cleanup:** N/A (not user-scoped).
- **Bug class watchlist:** A (covered by helper), G (parallel isolates writing the same row), I (idempotency precheck races — see [`sync-fund-portfolios/index.ts`](../../supabase/functions/sync-fund-portfolios/index.ts) `existing` precheck).

### 3. Zustand `appStore` — persisted preferences + in-memory transient state

- **Where:** [`src/store/appStore.ts`](../../src/store/appStore.ts).
- **Storage:** AsyncStorage at key `foliolens-app-store`, version 7, with `migrate: migratePersistedAppState` + `merge: mergePersistedAppState`.
- **Persisted (`partialize` allowlist):** `defaultBenchmarkSymbol`, `appColorScheme`, `wealthJourney`, `returnAssumptions`, `goals`, `fundsSortBy`, `portfolioChartWindow`, `moneyTrailSortBy`. Survive app restarts and sign-outs by design — these are app preferences, not user-data.
- **In-memory only:** `previewMode`, `importGateVisible`, `dialog`, `toolsFlags`, `fundsSearchQuery`. **Reset on sign-out** via `useAppStore.getState().resetUserScopedState()` (PR #164). When you add a new in-memory user-scoped field, add it to that reset payload.
- **Version bump:** `version: 7` + `migratePersistedAppState`. Bump when the persisted shape changes; the migration function reshapes old persisted blobs.
- **Sign-out cleanup:** `resetUserScopedState()` (PR #164).
- **Bug class watchlist:** D (handled by reset), K (migration must strip removed fields — audit #14, Phase 4).

### 4. Onboarding draft

- **Where:** [`src/utils/onboardingDraft.ts`](../../src/utils/onboardingDraft.ts).
- **Storage:** AsyncStorage at key `foliolens-onboarding-draft-v1`. Holds PAN, DOB, email, partial import result.
- **Version bump:** the `-v1` suffix in the key. **Manual** — no migration; bump key when shape changes (old blob effectively discarded). Audit #16 noted this is non-versioned in spirit; defensive `sanitizeX` in the loader handles missing fields silently.
- **Sign-out cleanup:** `clearOnboardingDraft()` from SIGNED_OUT handler (PR #164). PII must not cross sign-in boundaries.
- **Bug class watchlist:** B (key bump on shape change), D (handled by sign-out clear).

### 5. Supabase auth session

- **Where:** [`src/lib/supabase.ts`](../../src/lib/supabase.ts). On native, AsyncStorage (`sb-<project>-auth-token`); on web, localStorage.
- **Lifetime:** controlled by Supabase SDK. `signOut()` calls `storage.removeItem` on the session key as part of the sign-out mutation (verified against SDK source, May 2026).
- **Sign-out cleanup:** handled by `authClient.signOut()` itself; we don't need to remove the key explicitly. The PR #164 SIGNED_OUT handler runs *after* this.
- **Bug class watchlist:** D (verified clean), L (web vs native storage path).

### 6. SQLite read cache (native only)

- **Where:** [`src/lib/db/`](../../src/lib/db/). Tables: `tx`, `nav`, `index`, `fund`. Schema versioned via `SCHEMA_VERSION` constant in [`db.ts`](../../src/lib/db/db.ts) (currently 2).
- **Lifetime:** Persistent on-device. Wiped on sign-out via `clearAll()` (`clearLocalDb` in app/_layout).
- **Version bump:** bump `SCHEMA_VERSION` and add migration to the schema-init code path. Today the upgrade is `ALTER TABLE … ADD COLUMN`; old rows have NULL for new columns. **Audit #15 (Phase 4)** notes a mid-migration crash leaves orphan rows.
- **Sync watermark:** `syncDeltaForUser(uid)` uses `MAX(updated_at)` per table to fetch only new rows from Supabase. Append-only semantics mean `INSERT OR IGNORE` is safe.
- **Sign-out cleanup:** `clearLocalDb()` drops + recreates the DB file (PII in `tx`).
- **Bug class watchlist:** B (schema migration crash recovery — Phase 4), G (concurrent SQLite writes — append-only mostly safe).

### 7. CDN snapshot for index history

- **Where:** [`supabase/functions/regenerate-index-snapshots/index.ts`](../../supabase/functions/regenerate-index-snapshots/index.ts). Output: `static-snapshots/index/<symbol>.json` in a public Supabase Storage bucket.
- **Cache-Control:** `public, max-age=3600, stale-while-revalidate=86400`. SWR window is 24 hours.
- **Regeneration:** daily at 14:00 UTC weekdays (15 min after `sync-index`).
- **Client read:** [`useIndexSnapshot.ts`](../../src/hooks/useIndexSnapshot.ts) fetches the snapshot, falls back to a paginated PostgREST query on JSON-malformed or 404.
- **Bug class watchlist:** F (failed regen → 24h stale-but-served — audit #13, Phase 3), J (same finding, Class J), K (snapshot lags real index_history by ~1 day in the worst case).

### 8. Portfolio composition table (server-side, treated as cache by the client)

- **Where:** [`fund_portfolio_composition`](../../supabase/migrations/20260420000000_portfolio_insights_schema.sql) populated by [`sync-fund-portfolios`](../../supabase/functions/sync-fund-portfolios/index.ts) hourly cron + [`fetch-fund-snapshot`](../../supabase/functions/fetch-fund-snapshot/index.ts) on demand.
- **Source tagging:** `source` column distinguishes `'amfi'` (real holdings classified) / `'category_fallback'` (had holdings but classifier returned 0 coverage) / `'category_rules'` (no holdings disclosed). Client UI surfaces a disclaimer for the latter two.
- **Bug class watchlist:** A (the empty-map race — sync-fund-portfolios variant covered in audit #7, Phase 2), C/F (mfdata partial-success TTL trap — audit #6, Phase 3), K (mfdata holdings stored verbatim — audit #8, Phase 4).

## Audit findings tracker

| # | Finding (short) | Class | Severity | Surface | Status |
|---|---|---|---|---|---|
| 1 | Supabase token survives sign-out (verify) | D | HIGH→LOW | #5 | ✅ Verified clean (PR #164 comment) |
| 2 | Zustand `previewMode` + `dialog` survive sign-out | D | MED | #3 | ✅ PR #164 |
| 3 | `toolsFlags` not cleared on sign-out | D | MED | #3 | ✅ PR #164 |
| 4 | Onboarding draft survives sign-out (PII) | D | MED | #4 | ✅ PR #164 |
| 5 | Preview→real-user transition race | D | MED | #1, #3 | ⏳ Phase 4 |
| 6 | mfdata partial-success locks 7-day TTL | F | MED | #8 | ⏳ Phase 3 |
| 7 | `sync-fund-portfolios` lacks empty-map guard | A | MED | #2 | ⏳ Phase 2 |
| 8 | mfdata holdings stored verbatim, no upstream check | K | MED | #8 | ⏳ Phase 4 |
| 9 | `useFundComposition` vs `usePortfolioInsights` key shape | E | MED | #1 | ⏳ Phase 4 |
| 10 | `useFundDetail` `staleTime: 0` vs Portfolio 1h | H | MED | #1 | ⏳ Phase 4 |
| 11 | INVESTMENT_VS_BENCHMARK staleness vs inputs | C | MED | #1 | ⏳ Phase 4 |
| 12 | `__BUSTER__` not lint-enforced | I | MED | #1 | ⏳ Phase 2 |
| 13 | CDN snapshot 24h SWR serves broken file | J | MED | #7 | ⏳ Phase 3 |
| 14 | Zustand v6→v7 doesn't strip removed fields | K | MED | #3 | ⏳ Phase 4 |
| 15 | SQLite v1→v2 migration crash → orphan rows | B | MED | #6 | ⏳ Phase 4 |
| 16 | Persister `onError` swallows quota failures | F | LOW | #1 | Tracked, not scheduled |
| 17 | Onboarding draft non-versioned key | B | LOW | #4 | Tracked, not scheduled |
| 18 | Composition source dedup race | A | LOW | #8 | Tracked, not scheduled |
| 19 | `sync-fund-portfolios` precheck race | I | LOW | #2 | Tracked, not scheduled |
| 20 | `fetch-fund-nav` TTL boundary `<=` | C | LOW | #2 | Tracked, not scheduled |
| 21 | `usePortfolioInsights.syncMutation` lacks `onError` | F | LOW | #1 | ⏳ Phase 4 (cheap) |
| 22 | category_rules date inconsistency | C | LOW | #8 | Tracked, not scheduled |

## When adding a new cache — checklist

Before merging a PR that introduces a new cached value (anywhere — React Query, edge-function module, AsyncStorage, SQLite, CDN):

1. **Add a row to the inventory above** describing the surface.
2. **Walk the bug taxonomy.** For each of A–L, note in the code's inline comment whether you considered it ("not applicable: <reason>" is a fine answer). The audit was triggered by realising every cache bug we've shipped fits one of these classes.
3. **Pick a version mechanism.** If the cached payload shape can change in a future PR, bump-it-on-change must be obvious. Today: `__BUSTER__` for React Query, `version` + `migrate` for Zustand, `-v1`-suffixed key for AsyncStorage drafts, `SCHEMA_VERSION` for SQLite.
4. **Decide sign-out behaviour.** If the cached data is user-scoped, add the cleanup to `app/_layout.tsx` SIGNED_OUT handler (or to `useAppStore.resetUserScopedState()` if it's in-memory Zustand).
5. **Empty-result guard.** If the cache loads from a table that might be empty before the source has populated it (the PR #161 bug class), use `isCachedMapStillValid` or an equivalent guard. Don't cache the empty result.
6. **Tests.** Pure helpers go to `_shared/`-style modules with unit tests. The cache decision (refresh vs use) is the load-bearing assertion; test it independently of the I/O.
