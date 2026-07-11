# Correctness C2 — Web Portfolio freshness after server-side CAS imports

## Goal

Ensure the web Portfolio screen cannot keep showing a persisted pre-import portfolio value after new CAS transactions have landed server-side.

## User Value

When a user forwards or imports a CAS and the backend writes new transactions, the web app should show one coherent portfolio. Portfolio totals, Money Trail, timelines, and fund cards must agree about which transactions exist without asking the user to clear browser storage or wait for the old one-hour Portfolio stale window.

## Context

FolioLens persists selected React Query results on web through AsyncStorage's localStorage backend. Before this hotfix, web persisted both user-visible Portfolio aggregates and Money Trail / transaction data. Money Trail and the shared `user-transactions` input use a five-minute stale time, while the user-visible `portfolio` result uses a one-hour stale time. Web also does not run the native SQLite sync loop, because SQLite is unavailable on web.

That combination produced a correctness gap: a server-side CAS import could make Money Trail refresh to the new transactions while a still-fresh persisted Portfolio result continued showing the old value across reloads. N7 did not fix this because its fresh preview origin simply had empty localStorage; the public persisted `['portfolio', userId, benchmark]` key and one-hour stale time still existed.

The confirmed interrupt is tracked on control PR #250 as C2 and must merge before final program closeout.

## Assumptions

- Server transaction `created_at` is an authoritative insertion-time signal for CAS imports, including back-dated transaction dates.
- Transaction count plus max `created_at` is enough to detect whether transaction-backed web caches were computed from the same server state.
- Native should keep using the SQLite sync loop; this hotfix only adds a web freshness path.
- No financial formula changes are required. The fix changes cache invalidation and metadata attached to Portfolio query data.
- Physical iOS evidence remains unavailable for this program.

## Definitions

- Freshness marker: `{ count, latestCreatedAt }`, where `count` is the number of server transactions for the user and `latestCreatedAt` is the newest server insertion timestamp.
- Persisted Portfolio aggregate: the user-visible React Query result under `['portfolio', userId, benchmarkSymbol]`.
- Transaction-derived cache: any React Query entry whose output depends on user transactions, including Portfolio, Money Trail, timelines, Fund Detail, and user transaction inputs.

## Scope

- Add a cheap remote web freshness marker query over `user_transactions`.
- Attach the local transaction freshness marker to freshly computed Portfolio results.
- Bump the React Query persistence buster to v12 and update the cache-surface inventory because the persisted Portfolio payload shape changed.
- On web mount, sign-in, foreground return, and post-persisted-cache restore, compare remote freshness against cached `user-transactions` and cached Portfolio markers.
- If the marker differs, reuse the existing transaction invalidation fan-out so Portfolio, Money Trail, timelines, Fund Detail, and transaction inputs become stale together, with visible-route active refetch.
- Add deterministic tests for persisted pre-import Portfolio, already-refreshed Money Trail transaction cache plus stale Portfolio, and no-change/no-remote-marker cases.
- Record validation and evidence in this ExecPlan before opening the implementation PR.

## Out of Scope

- Editing `docs/research/app-navigation-performance-audit-2026-06-30.md`.
- Changing financial formulas, benchmark math, native SQLite sync semantics, database schema, auth, or visual design.
- Clearing localStorage or relying on the React Query buster as the primary fix. The fix must handle future server-side imports after the hotfix is deployed; the buster bump is only shape hygiene for the new persisted Portfolio metadata.
- Native Android evidence unless runtime app behavior outside web is changed by review.

## Approach

The hotfix adds a small server freshness query in `src/hooks/useUserTransactions.ts` that returns transaction count and newest `created_at`. `src/lib/transactionFreshness.ts` contains pure helpers for deriving and comparing markers.

`src/hooks/usePortfolio.ts` attaches the marker computed from the transaction rows used for each Portfolio aggregate. This is intentionally metadata only; rendered totals and formulas stay unchanged. The v12 buster discards old markerless persisted Portfolio entries on restore, and the markerless-entry path still treats them as stale when server transactions exist if one is encountered through a partial restore or test path.

`src/lib/webPortfolioFreshness.ts` compares the remote marker against two cached sources:

- `['user-transactions', userId]`, so stale transaction input caches are caught before a Portfolio mount uses them.
- every cached `['portfolio', userId, *]` result, so a Money Trail refresh cannot hide a stale Portfolio aggregate.

When either comparison differs, the function returns a transaction drift-style sync result. The existing `invalidateQueriesForSync()` fan-out then invalidates all transaction-derived prefixes and refetches active prefixes owned by the visible route.

`src/lib/appLifecycle.ts` runs this web freshness check in the same lifecycle slots where native runs SQLite sync: initial session, sign-in, and throttled foreground return. `app/_layout.tsx` also runs it after the persisted query cache restore succeeds, which closes the reload-specific failure mode where stale localStorage data hydrates after app startup.

## Alternatives Considered

- Only shortening Portfolio stale time was rejected as incomplete. It reduces the disagreement window but still allows stale persisted Portfolio values until the shorter timer expires.
- Only comparing the remote marker to `user-transactions` was rejected because Money Trail can refresh that shared input while the persisted Portfolio aggregate remains old.
- Relying only on a React Query buster bump was rejected as a one-time cleanup, not a future-proof freshness signal. C2 still bumps the buster because the persisted Portfolio shape changed, but the freshness probe is the ongoing correctness mechanism.
- Running a full transaction fetch on every web foreground was rejected as heavier than the count plus max-created-at marker.

## Milestones

### 1. Freshness marker and Portfolio metadata

Add pure marker helpers, the remote marker query, and marker metadata on Portfolio query results.

Expected outcome: freshly computed Portfolio data records the transaction server state it used without changing rendered financial values.

Commands:

    npx jest src/hooks/__tests__/usePortfolio.test.ts src/lib/__tests__/webPortfolioFreshness.test.ts --runInBand

Acceptance criteria: tests prove marker derivation and Portfolio metadata.

### 2. Web lifecycle invalidation

Run the marker comparison on web startup, post-cache restore, sign-in, and foreground return, then reuse existing transaction invalidation.

Expected outcome: stale persisted Portfolio and transaction-dependent caches are invalidated together before the one-hour Portfolio stale time can hide a server-side import.

Commands:

    npx jest src/lib/__tests__/appLifecycle.test.ts src/lib/__tests__/webPortfolioFreshness.test.ts --runInBand

Acceptance criteria: tests prove initial and foreground web checks run instead of native SQLite sync, and stale persisted Portfolio triggers the transaction invalidation result.

### 3. Full validation and PR setup

Run focused tests, full Jest, typecheck, zero-warning lint, and diff check. Record evidence here, open the implementation PR, post the C2 START comment on PR #250, and request dual review.

Expected outcome: C2 is ready for reviewer verification with deterministic evidence and no research-report edit.

Commands:

    npx jest src/lib/__tests__/webPortfolioFreshness.test.ts src/lib/__tests__/appLifecycle.test.ts src/hooks/__tests__/usePortfolio.test.ts --runInBand
    npx jest --runInBand
    npm run typecheck
    npm run lint
    git diff --check

Acceptance criteria: all commands pass; PR #250 C2 row moves to In review after the draft PR has complete evidence.

## Validation

Local validation on `program/c2-web-portfolio-freshness` before opening the implementation PR:

- Focused C2 suites passed: `npx jest src/lib/__tests__/webPortfolioFreshness.test.ts src/lib/__tests__/appLifecycle.test.ts src/hooks/__tests__/usePortfolio.test.ts --runInBand --silent`, 3 suites / 39 tests.
- Focused cache/freshness suite after the v12 buster and cache-documentation update passed: `npx jest src/lib/__tests__/queryClient.test.ts src/lib/__tests__/webPortfolioFreshness.test.ts src/lib/__tests__/appLifecycle.test.ts src/hooks/__tests__/usePortfolio.test.ts scripts/__tests__/navigation-n6-config.test.ts --runInBand --silent`, 5 suites / 82 tests.
- N6 rendered-navigation config suite passed after the Jest mock was made explicit for `keepPreviousData`: `npx jest scripts/__tests__/navigation-n6-config.test.ts --runInBand --silent`, 1 suite / 9 tests.
- Full Jest passed: `npx jest --runInBand --silent`, 92 suites / 1,956 tests.
- `npm run typecheck` passed.
- `npm run lint` passed with zero warnings.
- `git diff --check` passed.

Deterministic acceptance coverage:

- `src/lib/__tests__/webPortfolioFreshness.test.ts` hydrates a fresh pre-import persisted Portfolio marker, advances the remote transaction marker, and proves the web freshness check returns a transaction drift invalidation result before any one-hour stale-time expiry.
- The same suite covers the Money Trail asymmetry: `user-transactions` can already match the server marker while the cached Portfolio marker remains old, and the freshness check still invalidates transaction-derived caches.
- `src/lib/__tests__/appLifecycle.test.ts` proves web initial session and foreground return use the freshness hook instead of the native SQLite delta sync, and pass changed results into granular invalidation.
- `src/hooks/__tests__/usePortfolio.test.ts` proves freshly computed Portfolio results carry the transaction freshness marker that future web checks compare.

## Risks And Mitigations

- Risk: post-restore and initial lifecycle checks could duplicate the cheap marker request. Mitigation: the lifecycle has single-flight protection, and the query is a one-row/count request.
- Risk: old persisted Portfolio entries have no marker. Mitigation: missing marker is intentionally treated as stale when server transactions exist, causing a one-time refetch.
- Risk: remote marker request can fail due to network or auth state. Mitigation: failure returns no invalidation and logs a warning; existing stale-time behavior remains the fallback.
- Risk: web invalidates more transaction-derived prefixes than strictly necessary. Mitigation: it reuses the native transaction fan-out, keeping Portfolio, Money Trail, timelines, and Fund Detail coherent.

## Decision Log

- 2026-07-11: Use transaction count plus max `created_at` instead of full transaction fetch for the web freshness probe.
- 2026-07-11: Attach transaction freshness metadata to Portfolio results so stale Portfolio can be detected even after Money Trail refreshes the shared transaction cache.
- 2026-07-11: Run the freshness check after persisted-cache restore to cover reloads with fresh localStorage Portfolio data.
- 2026-07-11: Bump the React Query buster to v12 because the public persisted Portfolio payload shape changed; keep the marker probe as the actual ongoing correctness mechanism.

## Progress

- [x] Read VISION, PR #250 comments, and the program playbook C2 interrupt context.
- [x] Create `program/c2-web-portfolio-freshness` from current `origin/main`.
- [x] Add remote transaction freshness marker and pure marker helpers.
- [x] Attach transaction freshness metadata to Portfolio results.
- [x] Bump the React Query buster to v12 and update cache-surface documentation.
- [x] Add web freshness invalidation on lifecycle and post-persist restore.
- [x] Add deterministic unit tests for stale persisted Portfolio and already-refreshed transaction cache.
- [x] Run focused tests.
- [x] Run full Jest, typecheck, zero-warning lint, and diff check.
- [x] Update validation evidence in this ExecPlan.
- [ ] Open draft C2 PR and request review.
