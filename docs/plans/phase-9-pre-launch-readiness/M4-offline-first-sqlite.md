# Phase 9 M4 — Offline-first SQLite cache for transactions / NAV / index history


## Goal


After this milestone, FolioLens is a true offline-first app for the read paths. Concretely:


- Past transactions, past NAVs, and past index closes live in on-device SQLite. Once they're written, the app never re-reads them from Supabase.
- App-open syncs a small delta (today's NAV publish, any newly-ingested transactions from auto-forward) and writes it to SQLite. The Portfolio / Fund Detail / Compare screens render from the local DB.
- Cold-start on the train (no network) still paints the full portfolio, accurate to the last successful sync.
- Network is reserved for: the delta-sync itself, ingestion writes (CAS upload), and the small number of computed values that aren't materialised yet (composition snapshots, scheme_master extended fields).


## User Value


For the user, the offline-first cache turns the app from "fast on second open" into "instant on every open". The 4-fix PR (#135) reduces per-session re-fetches by sharing inputs across screens, but every cold start still pulls a window of history from Supabase. After M4, cold start touches the network only for the *delta* — typically one day's NAVs (~20 rows for a 10-fund portfolio) and zero transactions. No network at all if Wi-Fi is off and the user is happy to see yesterday's prices.


For the founder, M4 collapses the Supabase egress bill from the dominant cost (NAV history re-downloads) to a baseline of ~50 rows / user / open. It also unblocks features like "view portfolio offline on a flight" and removes the AsyncStorage size pressure that the React Query persister is starting to brush against at 5+ funds × 5 years of daily NAVs.


Comparison branch context: PR #135 ships the "shared inputs" pattern using React Query + AsyncStorage persister. M4 is the heavier, native-module-backed cousin — same architectural intent, but using SQLite as the persistence layer instead of serialised JSON in AsyncStorage. The user wants to A/B both approaches before committing.


## Context


PR #135 already establishes:

- `['user-funds', userId]` and `['user-transactions', userId]` shared cache keys with single-producer SELECT shapes (collision-proof — both screens read the same memory).
- `qc.fetchQuery` wiring from `fetchPortfolioData` / `fetchFundDetail` so consumers share inflight requests.
- `PersistQueryClientProvider` mounted in `app/_layout.tsx` with `__BUSTER__`, `gcTime: 24h`, and a per-key allowlist.
- `STALE_TIMES` constants tuned per data shape (NAV/index = 6h, portfolio = 1h, transactions = 5min).

M4 replaces the network-fetch portion of those `queryFn`s with a SQLite-backed repo. The React Query layer stays in place above the repo (so memoisation and React-render integration work), but the underlying truth moves from Supabase → on-device SQL.

Read paths affected:

| Source table | Used by | Today's cost (10 funds, 5Y) |
| --- | --- | --- |
| `nav_history` | usePortfolio (90d), useFundDetail (2 rows), useFundNavHistory (full), useInvestmentVsBenchmarkTimeline (windowed), Past SIP Check (windowed), Compare (windowed) | 250–12,500 rows depending on window |
| `index_history` | usePortfolio (since firstTxDate), useInvestmentVsBenchmarkTimeline (windowed), `app/fund/[id].tsx` (since firstTxDate) | 1,250–7,700 rows |
| `transaction` | usePortfolio, useFundDetail, useWealthJourney, useMoneyTrail, useInvestmentVsBenchmarkTimeline | ~150–500 rows for typical users |

Write paths (out of scope for M4 — Supabase remains the source of truth):

- CAS import (writes new transactions + new fund rows; the daily sync-nav / sync-index edge functions write new NAV / index closes).
- User profile edits.
- Composition snapshots (refreshed monthly server-side).


## Assumptions


- The user has run a CAS import at least once (otherwise the SQLite tables are empty and we fall through to network on first open — same as today).
- `expo-sqlite` is supported on every target platform (iOS, Android, Web — `expo-sqlite` shims to IndexedDB on web, which we verify in M4.6).
- A 30 MB SQLite file is acceptable on-device. Worst case: 50 funds × 10 years × 250 trading days × ~40 bytes/row ≈ 5 MB. We're orders of magnitude under any practical limit.
- The daily `sync-nav` / `sync-index` cron continues to populate `nav_history` / `index_history` server-side. We only consume from those tables; we don't write back.
- Each user has one active device per session (multi-device sync is a re-sync from cold on the second device, not an active reconciliation).


## Definitions


- **Repo**: a thin function module over a SQLite table that exposes typed read/write helpers. One repo per table.
- **Delta-sync**: on app open, fetch only rows newer than `sync_state.last_synced_at` for a given source table. Append-only tables guarantee no row is ever mutated, so a date-based watermark is sufficient.
- **Watermark**: the maximum `(scheme_code | index_symbol)`-scoped date already stored locally. The next fetch uses `.gte(watermark)` to pull only new rows.
- **Cold-start path**: first app open after install / clear-data. SQLite is empty; the bootstrap flow does a full-history pull and writes the result to local. Subsequent opens are delta-only.
- **Hot path**: any open where SQLite is already populated. The repo serves reads synchronously; the sync orchestrator runs in the background and writes new rows as they arrive.


## Scope


In:

- New native module: `expo-sqlite` (installed via `npx expo install`; requires a new EAS build, not an OTA).
- SQLite schema for: `tx`, `nav`, `idx`, `sync_state`. (Local names use short identifiers to avoid confusion with Supabase tables of the same shape.)
- Repo modules: `src/lib/db/tx.ts`, `src/lib/db/nav.ts`, `src/lib/db/idx.ts`, `src/lib/db/syncState.ts`.
- A single `db.ts` orchestrator that owns the SQLite connection, schema migrations, and the sync orchestrator entry point.
- Wiring in `fetchPortfolioData` and `fetchFundDetail` so the existing `qc.fetchQuery` shape stays, but the underlying source is SQLite (with network fallback on cold-start).
- A bootstrap flow on app launch + `useFocusEffect`-driven background sync per screen.
- Cache invalidation on signout (drop all rows).
- Unit tests for repos + sync orchestrator (using `expo-sqlite`'s in-memory `:memory:` mode in tests).

Out:

- Write paths (CAS upload remains a Supabase-direct write; we then trigger a delta-sync to pull our own write back into SQLite).
- Other tables (`scheme_master`, `fund`, `user_profile`, composition snapshots). Reads still hit Supabase via React Query; these are lower-cost and lower-cardinality.
- Multi-device active sync. Second device does a cold bootstrap.
- Conflict resolution. We're read-only over append-only data, so there are no conflicts.


## Out of Scope


- Writing back to Supabase from SQLite (no offline write queue, no eventual-consistency replay).
- Encryption at rest. SQLite is plaintext; iOS / Android already encrypt the app sandbox at the OS level.
- Migrations across breaking schema changes from Supabase. If `nav_history` schema changes on the server, we bump `SCHEMA_VERSION`, drop the table, and re-bootstrap. Stale data is never silently mixed with new shapes.


## Approach


Three layers, bottom-up.

### Layer 1 — `src/lib/db/db.ts` (connection + schema)


Owns:

- A singleton `Promise<SQLiteDatabase>` returned by `getDb()`. On first call: open `foliolens.db`, run `CREATE TABLE IF NOT EXISTS` for every table, write the current `SCHEMA_VERSION` to a single-row `meta` table. On subsequent calls: return the cached promise.
- A `dropAndRecreate()` helper used on signout and schema-version-bump.

DDL:

    CREATE TABLE IF NOT EXISTS tx (
      fund_id TEXT NOT NULL,
      transaction_date TEXT NOT NULL,
      transaction_type TEXT NOT NULL,
      units REAL NOT NULL,
      amount REAL NOT NULL,
      PRIMARY KEY (fund_id, transaction_date, transaction_type, units, amount)
    );
    CREATE INDEX IF NOT EXISTS idx_tx_fund_date ON tx (fund_id, transaction_date);

    CREATE TABLE IF NOT EXISTS nav (
      scheme_code INTEGER NOT NULL,
      nav_date TEXT NOT NULL,
      nav REAL NOT NULL,
      PRIMARY KEY (scheme_code, nav_date)
    );
    CREATE INDEX IF NOT EXISTS idx_nav_scheme_date ON nav (scheme_code, nav_date);

    CREATE TABLE IF NOT EXISTS idx (
      index_symbol TEXT NOT NULL,
      index_date TEXT NOT NULL,
      close_value REAL NOT NULL,
      PRIMARY KEY (index_symbol, index_date)
    );
    CREATE INDEX IF NOT EXISTS idx_idx_symbol_date ON idx (index_symbol, index_date);

    CREATE TABLE IF NOT EXISTS sync_state (
      scope TEXT NOT NULL PRIMARY KEY,    -- 'nav:12345', 'idx:^NSEI', 'tx:user-id'
      last_synced_at TEXT NOT NULL,       -- ISO timestamp
      watermark_date TEXT                 -- max(date) row currently stored
    );

    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

Primary keys are composite and chosen to make `INSERT OR IGNORE` idempotent — re-running a sync that pulls overlapping rows is a no-op. We rely on the natural keys; no surrogate row IDs because the SQLite copy never leaves the device.


### Layer 2 — `src/lib/db/<table>.ts` (repos)


Each repo exposes:

- `readAll<T>(...filters)`: select rows for a query (e.g. `tx.readByUserAndFundIds`, `nav.readBySchemeCodes`).
- `bulkInsert(rows)`: `INSERT OR IGNORE` with a single prepared statement and a transaction.
- `getWatermark(...scope)`: max date for the scope.
- `clear()`: delete all rows (used on signout).

Each repo's read functions return plain JS objects with the same shape as their corresponding `UserFundRow` / `UserTransactionRow` / `RawNavRow` / `RawIdxRow` types. Drop-in replacement at the call site.

Example signature (`tx.ts`):

    export interface DbTxRow {
      fund_id: string;
      transaction_date: string;
      transaction_type: string;
      units: number;
      amount: number;
    }

    export async function readByFundIds(fundIds: string[]): Promise<DbTxRow[]>;
    export async function bulkInsert(rows: DbTxRow[]): Promise<void>;
    export async function getWatermark(): Promise<string | null>;
    export async function clear(): Promise<void>;

We do *not* expose userId scoping at the repo layer. The repo is single-user (the app is single-user per session). Signout calls `clear()` to wipe.


### Layer 3 — `src/lib/db/sync.ts` (orchestrator)


Two entry points:

- `bootstrapIfEmpty(userId)`: on cold start (no rows in `tx` for this user), do a full-history fetch from Supabase and `bulkInsert`. Idempotent — safe to call on every app open. Sets `sync_state` entries with `watermark_date = max(date)` for each scope.
- `syncDelta(userId)`: for each scope, `SELECT max(date) FROM <table> WHERE …`, then `supabase.from(...).gte(date, watermark)`, then `bulkInsert`. Updates `sync_state`.

The orchestrator runs on:

- App launch (after auth resolves), in `app/_layout.tsx`.
- Screen focus (`useFocusEffect` in Portfolio + Fund Detail) so the user sees fresh data after returning from background.
- Pull-to-refresh, when the relevant screen exposes one.

Failures are non-fatal. If `syncDelta` throws (network down, Supabase 500), the app keeps rendering from whatever's in SQLite and surfaces a small "Last synced N min ago" hint in the header. No spinner blocks the UI.

The orchestrator calls `qc.invalidateQueries({ queryKey: ['portfolio', userId] })` after a successful sync writes new rows — React Query then re-runs `fetchPortfolioData`, which re-reads from SQLite (now containing the new rows).


### Layer 4 — Wiring `fetchPortfolioData` / `fetchFundDetail` to SQLite


`fetchUserTransactions(userId)` is rewritten to read from SQLite first:

    export async function fetchUserTransactions(userId: string): Promise<UserTransactionRow[]> {
      // Try SQLite first
      const rows = await txRepo.readAll();
      if (rows.length > 0) return rows;
      // Cold start: SQLite is empty. Bootstrap from Supabase, write to SQLite, return.
      const fresh = await fetchTransactionsFromSupabase(userId);
      await txRepo.bulkInsert(fresh);
      return fresh;
    }

The Supabase fallback fetcher is what today's `fetchUserTransactions` does. We keep it for the cold-start bootstrap path.

Similarly:

- `fetchPortfolioData` reads NAV / index from `nav` / `idx` repos. Cold-start fallback fetches from Supabase and writes to SQLite.
- `fetchFundDetail` reads its NAV-limit-2 from the local `nav` repo (`SELECT * FROM nav WHERE scheme_code = ? ORDER BY nav_date DESC LIMIT 2`).
- `useInvestmentVsBenchmarkTimeline` reads its window-bounded NAV / index from local repos.
- `useFundNavHistory` reads the full per-scheme NAV history from the local `nav` repo.

The React Query cache still wraps these calls, so cross-screen sharing of inflight requests still works (the cache key + queryFn shape is unchanged). The user-visible difference: the queryFn's "fetch" is now disk-local in the hot path.


## Alternatives Considered


- **Stay on AsyncStorage + React Query persister.** This is PR #135's approach. Wins instantly without a new native module, but AsyncStorage has a practical ~6 MB safe limit on Android and serialises the whole cache as JSON on every persist. For 10 funds × 5 years × 250 days ≈ 12,500 NAV rows ≈ ~600 KB of JSON, the persister is fine. For 50 funds it brushes the limit. SQLite scales 10–100× better and reads are O(log n) via the index, not O(n) deserialisation.

- **Use WatermelonDB or RxDB.** Both are heavier reactive ORMs. They give us a lot of features we don't need (sync conflict resolution, observable queries, custom collections) and add ~200 KB to the bundle. Plain `expo-sqlite` + thin repos is enough because our data is append-only and single-user.

- **Use react-native-mmkv.** Faster than AsyncStorage for K/V but still serialises bulk data as a single blob per key. Same scaling problem as the persister.

- **Stream history via Supabase Realtime.** Would give push-based updates instead of polling. We'd still need a local store for the offline read path, and Realtime adds operational complexity (WebSocket connection lifecycle, reconnect handling). Pull-based delta-sync is enough for daily NAV publish cadence.

- **Move all hooks to read directly from SQLite without React Query.** Drops a layer, but loses the cross-screen inflight-dedup and memoisation that React Query gives us. Net: same code surface, fewer concerns separated. Not worth the simplification.


## Milestones


### M4.1 — Schema + db.ts + repo scaffolds


Scope: install `expo-sqlite`, create `src/lib/db/db.ts` with the schema migration, write empty repo modules with type-correct signatures and no implementations. Compile passes; nothing runs against the real DB yet.

Outcome: `import { getDb } from '@/src/lib/db/db'` works in a React Native context. `getDb().then(db => db.execAsync('SELECT 1'))` returns successfully on iOS / Android simulators.

Commands:

    npx expo install expo-sqlite
    npm run typecheck

Acceptance: zero TS errors. `getDb` returns a singleton.


### M4.2 — Repo implementations + unit tests


Scope: implement `readAll`, `bulkInsert`, `getWatermark`, `clear` for `tx.ts`, `nav.ts`, `idx.ts`, `syncState.ts`. Tests run against an in-memory `expo-sqlite` instance (`SQLite.openDatabaseSync(':memory:')`).

Outcome: tests pass. Bulk insert of 10,000 rows < 200ms on a Pixel 6.

Commands:

    npx jest src/lib/db
    npm run lint

Acceptance: 95%+ line coverage on each repo file. INSERT OR IGNORE re-runs are idempotent.


### M4.3 — Sync orchestrator + bootstrap


Scope: `src/lib/db/sync.ts`. `bootstrapIfEmpty(userId)` calls the existing Supabase fetchers from `useUserTransactions` / `useInvestmentVsBenchmarkTimeline` and writes rows into SQLite. `syncDelta(userId)` uses the watermark.

Outcome: a unit test that bootstraps an empty DB from a mocked Supabase response, then runs `syncDelta` with a new-row response, and asserts the DB now contains union of both.

Acceptance: bootstrap is idempotent. Delta with no new rows is a no-op. Failures don't corrupt watermark.


### M4.4 — Wire `fetchPortfolioData` and `fetchFundDetail` to repos


Scope: replace the Supabase calls inside the existing fetchers with repo reads, with the Supabase fallback only on `count === 0` (cold start). Keep the React Query cache layer above unchanged.

Outcome: existing `usePortfolio.test.ts` / `useFundDetail.test.ts` keep passing with updated mocks that route through repo stubs.

Acceptance: tests pass. Manual smoke on simulator: open app, navigate Portfolio → Fund Detail → back → Fund Detail. Second open paints in < 200ms with airplane mode on.


### M4.5 — App-launch bootstrap + screen-focus sync


Scope: wire `bootstrapIfEmpty` into `app/_layout.tsx`'s auth-resolved effect. Wire `syncDelta` into `useFocusEffect` for Portfolio + Fund Detail. Add "Last synced N min ago" line to Portfolio header.

Outcome: a fresh install, after onboarding, sees Portfolio paint from a single network round-trip; second open paints from SQLite only.

Acceptance: device test on Android (PR build via foliolens-pr OTA channel, after a fresh EAS build that includes the SQLite native module).


### M4.6 — Web fallback verification


Scope: confirm `expo-sqlite` web shim works on `app.foliolens.in`. The web build uses IndexedDB under the hood; our DDL needs to be IndexedDB-compatible. If not, gate the SQLite code on `Platform.OS !== 'web'` and fall through to the React Query persister on web (PR #135's behaviour).

Outcome: web build builds and Portfolio renders correctly on Chrome desktop.

Acceptance: `npm run web` paints Portfolio.


### M4.7 — Sign-out, schema migration, and graceful failure


Scope:

- `supabase.auth.onAuthStateChange` SIGNED_OUT handler calls `dropAndRecreate()` so PII never persists past logout.
- Bump `SCHEMA_VERSION` constant if any DDL changes; on mismatch in `meta`, drop and recreate.
- Wrap every repo read in a try/catch — on SQLite open failure (rare, but possible on misconfigured devices), surface a console.warn and fall through to Supabase as the safety net.

Outcome: sign out, sign in as a different user, no row leakage. Cold start with intentionally broken DB recovers without a crash.

Acceptance: tests + manual.


### M4.8 — EAS preview build + comparison testing


Scope: cut a new EAS preview build on `foliolens-pr` channel (SQLite native module requires this). Distribute install link to the user.

Outcome: side-by-side comparison with PR #135 (the AsyncStorage variant): cold start, warm start, navigation latency, network egress.

Acceptance: PostHog perf marks tell the story. We expect `query:portfolio` ≤ 50ms on warm SQLite path vs ~800ms on AsyncStorage path.


## Validation


- Per-milestone unit tests (Jest, in-memory SQLite).
- Manual smoke at M4.4 (simulator) and M4.5 (device).
- PostHog `perf_mark` events from the existing `perfMark.ts` instrumentation continue to fire. Compare `query:portfolio` / `query:fundDetail` distributions between this branch and PR #135.
- Network tab on web: cold-start app, observe one Supabase batch (bootstrap), then no further requests for the read path.
- Airplane mode test: enable airplane mode, kill app, relaunch — Portfolio paints with the last-synced data, "Last synced N min ago" reflects accurately.


## Risks And Mitigations


- **Native module + EAS rebuild required.** Mitigation: schedule a clear cutover. Existing OTA bundles cannot pick up SQLite — they'd crash on require. We ship M4 as a *new* EAS build with a feature flag (`useAppStore.localCacheEnabled`) defaulting to off. The flag flips on after the new build is on 90%+ of devices.

- **SQLite open fails on some devices.** Mitigation: try/catch every repo entry point and fall through to Supabase. Log the failure with `analytics.track('sqlite_open_failed', {...})`. Worst case is the user gets PR #135's behaviour with extra overhead.

- **Schema drift between SQLite and Supabase.** Mitigation: `SCHEMA_VERSION` constant + drop-and-recreate on mismatch. We accept losing the local copy on schema changes; the bootstrap re-populates from Supabase on next open.

- **Web platform divergence.** Mitigation: M4.6 explicitly tests the IndexedDB-backed shim. If broken, we gate SQLite on native only.

- **AsyncStorage persister still mounted.** Mitigation: keep it for non-SQLite cache entries (computed results like `['portfolio', userId, …]`, fund metadata, profile). The repos own the raw history; React Query persister owns the derived state. No conflict.


## Decision Log


- 2026-05-12: User chose SQLite-backed full-offline over expanded AsyncStorage persister. The comparison branch builds this as a parallel implementation, not a replacement; PR #135 lands first.
- 2026-05-12: Primary keys are composite natural keys (no surrogate IDs). Append-only data + single-user device means no risk of merge conflicts. INSERT OR IGNORE handles overlapping syncs.
- 2026-05-12: Bootstrap reuses the existing Supabase fetchers from PR #135 (`fetchUserTransactions` etc.). No second copy of pagination logic.
- 2026-05-12: Web fallback decided at M4.6 — if `expo-sqlite` web shim is unstable, gate on `Platform.OS !== 'web'`.


## Progress

- [ ] M4.1 — Install expo-sqlite + schema + db.ts + repo scaffolds
- [ ] M4.2 — Repo implementations + unit tests
- [ ] M4.3 — Sync orchestrator + bootstrap
- [ ] M4.4 — Wire fetchPortfolioData / fetchFundDetail to repos
- [ ] M4.5 — App-launch bootstrap + screen-focus sync
- [ ] M4.6 — Web fallback verification
- [ ] M4.7 — Sign-out, schema migration, graceful failure
- [ ] M4.8 — EAS preview build + comparison testing
