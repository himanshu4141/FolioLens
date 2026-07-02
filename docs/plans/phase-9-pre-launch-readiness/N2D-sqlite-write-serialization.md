# N2D Shared SQLite Write Serialization and Cache Repair

## Goal

Prevent overlapping writes on FolioLens's one native SQLite connection and make timeline NAV cache repair deterministic. A failed write must reject its caller without blocking later writes, and a successful retry must make the next identical timeline read local.

## User Value

Users should not repeatedly pay the network and computation cost of a timeline whose local cache repair failed. Bootstrap, foreground refresh, timeline read-through, and index read-through may all become active near the same time; they must no longer produce SQLite errors such as `cannot start a transaction within a transaction` or `cannot rollback - no transaction is active`.

The observable result is that concurrent native cache work completes in order, a transient failed write can repair from the rows already fetched, and a repeated timeline read uses SQLite instead of fetching the same NAV pages again.

## Context

PR #250 is the unmerged control plane for the performance-remediation program. N1 instrumentation merged in PR #251 and N2 transition-contention work merged in PR #252. The coordinator marked N2D Ready to start after verifying N2 on `main` at `7d3f25efec3acc127a871b80110370ea6743fb3c`.

The Android follow-up run on a Pixel 8a repeatedly logged nested-transaction and invalid-rollback errors while timeline fallback, bootstrap, and prefetch could write concurrently. The native cache repositories in `src/lib/db/tx.ts`, `src/lib/db/nav.ts`, and `src/lib/db/idx.ts` all call `withTransactionAsync` independently even though `src/lib/db/db.ts` gives them the same singleton connection. Timeline NAV fallback in `src/hooks/useInvestmentVsBenchmarkTimeline.ts` starts a fire-and-forget write-back, so the query can finish while repair is still pending or has already failed.

SQLite is a discardable native read cache. Supabase remains authoritative. The cache schema stays at version 2 because N2D changes write ownership and ordering, not any stored table or row shape.

## Assumptions

- N2D remains a small database-correctness milestone. It does not optimize timeline computation or change financial results; N2T owns that work.
- Native repositories share exactly one connection returned by `getDb()`.
- Android main-preview is the native acceptance target. iOS is out of scope because FolioLens has no Apple Developer account or iOS distribution path.
- Queue operation names and timings may be logged, but user identifiers, fund identifiers, transactions, and fetched values must not be logged.

## Definitions

- **Serializer:** one first-in, first-out promise queue that allows only one write operation to use the singleton SQLite connection at a time.
- **Write scope:** a generation token captured by an asynchronous flow before it may later write. Cleanup invalidates older scopes so work belonging to the signed-out/reset state cannot land afterward.
- **Repair:** inserting NAV rows obtained from a remote timeline fallback into SQLite so the next identical read is served locally.
- **Rejection isolation:** a rejected queued operation is returned to its caller, while the queue tail recovers and starts the next operation.
- **Connection lifecycle operation:** cleanup or test connection replacement that must run after active writes and before later writes.

## Scope

- Add one serializer next to the singleton database connection and expose bounded operation labels plus queue-wait/write timing marks.
- Route transaction, NAV, index, sync-state, and cleanup writes through that serializer. Transactional repository writes remain atomic.
- Invalidate old write scopes before sign-out or manual cache cleanup, serialize the wipe as one lifecycle operation, and wait for it before re-bootstrap.
- Make timeline NAV repair awaited and retry once from the rows already fetched. Propagate the final error rather than reporting a repaired query when SQLite is still incomplete.
- Make test database replacement wait for the queue so no old queued task can write to a replaced connection.
- Add concurrency, rejection, cleanup-ordering, and timeline repair/read-through tests.
- Update the SQLite cache inventory to record the shared writer ownership and cleanup fence.
- Capture Android main-preview evidence at the implementation SHA, including queue wait/write durations and the absence of SQLite transaction errors.

## Out of Scope

- Benchmark-independent timeline input reuse, date bounding, sampling changes, or warm-switch performance targets. Those belong to N2T.
- SQLite schema or payload changes, a `SCHEMA_VERSION` bump, or React Query persisted-cache changes.
- Supabase schema, Edge Function, or server synchronization changes.
- A per-repository lock. Independent locks would still allow repositories using the same connection to overlap.
- Suppressing SQLite or transaction errors to make logs appear clean.

## Approach

Keep the serializer at the shared connection boundary in `src/lib/db/db.ts`, not in individual repositories. Each queue entry returns its own promise. The queue stores a recovered tail (`entry.then(success, failure)`) so one rejection cannot poison later work, while the entry promise itself retains the original error for its caller.

Repository methods enqueue one top-level operation and execute their prepared statements directly inside that operation. They do not call another queued repository method from inside a queued callback, which avoids a re-entrant queue deadlock. Connection lifecycle operations use the same queue.

Asynchronous flows that can cross sign-out or manual reset capture a write scope before remote work. Cleanup advances the scope generation synchronously, then queues one wipe behind any currently executing entry. Already queued stale entries reject before touching SQLite, and later work for the new generation queues after cleanup. The sign-in bootstrap continues to await the cleanup promise already maintained by `app/_layout.tsx`.

Timeline fallback awaits repair. On the first write rejection it retries once using the in-memory NAV rows that were just fetched; it does not re-fetch the network payload merely to retry SQLite. A second failure rejects the timeline query so the error is observable. A successful retry returns only after the cache is repaired.

Use the N1 performance-mark channel for low-cardinality `db:write_queue_wait` and `db:write` durations. Include operation name, queue depth, status, and retry attempt only.

## Alternatives Considered

- Use one mutex per repository. Rejected because NAV, transaction, index, and sync-state writes share one connection and would still overlap across mutexes.
- Switch each repository to `withExclusiveTransactionAsync`. Rejected because it creates a transaction-specific connection and does not establish lifecycle ordering across all callers; the observed problem is ownership and scheduling on the shared cache connection.
- Keep timeline repair fire-and-forget and rely on a later bootstrap. Rejected because the query can report success before cache durability and a failed repair repeats the slow remote path.
- Swallow failed writes and let the queue continue. Rejected because rejection isolation must preserve the original failure for the caller.
- Fold N2T's computation refactor into this PR. Rejected because it would mix database correctness with financial-performance changes and obscure attribution.

## Milestones

### 1. Establish the shared writer and lifecycle fence

Add the connection-level queue, scope generation, lifecycle cleanup, test reset ordering, and privacy-safe timing marks. Route all native cache writes through it.

Expected outcome: concurrent repository calls never overlap `withTransactionAsync`; one failure rejects only that call; cleanup cannot be followed by a stale queued write.

Run:

    npm test -- --runInBand src/lib/db/__tests__

Acceptance: concurrency, rejection isolation, and cleanup-order tests pass with no nested transaction or invalid rollback errors.

### 2. Make timeline repair deterministic

Replace the fire-and-forget timeline NAV write-back with an awaited repair that retains the fetched rows for one retry. Capture the originating write scope before remote fallback.

Expected outcome: an injected first write failure is followed by a successful queued retry, and the next identical timeline read uses SQLite without another NAV network request.

Run:

    npm test -- --runInBand src/hooks/__tests__/useInvestmentVsBenchmarkTimeline.test.ts src/lib/db/__tests__

Acceptance: the failure/retry/local-read integration case passes and the final failure remains observable.

### 3. Validate repository and native behavior

Run the required focused and repository-wide checks, publish main-preview at the implementation SHA, and exercise overlapping bootstrap, foreground sync, timeline repair, and index write-back on the connected Android device.

Expected outcome: tests and static checks are clean; native logs show serialized queue wait/write marks and zero nested-transaction or invalid-rollback errors; repeating the same timeline read is local after repair.

Run:

    npm test -- --runInBand src/lib/db/__tests__ src/hooks/__tests__/useInvestmentVsBenchmarkTimeline.test.ts src/hooks/__tests__/useIndexSnapshot.test.ts src/hooks/__tests__/usePortfolio.test.ts src/hooks/__tests__/useFundDetail.test.ts src/hooks/__tests__/useFundDetail.windowed.test.ts
    npm run typecheck
    npm run lint
    npm test -- --runInBand
    npx expo export --platform android --output-dir /tmp/foliolens-n2d-android-export
    git diff --check

Acceptance: all commands pass, Android evidence is recorded in this plan and PR #253 or the implementation PR assigned by GitHub, and both independent reviewers converge.

## Validation

Automated evidence must cover:

- transaction, NAV, and index transactional writes sharing one mocked connection with maximum concurrency of one;
- actual bootstrap and foreground-sync paths overlapping timeline NAV repair and index write-back;
- a failed write followed by a successful later queued write;
- retry using retained NAV rows, followed by an identical local read with no remote NAV call;
- cleanup invalidating old scopes and completing before new-generation writes;
- test database replacement waiting until queued work settles;
- no `cannot start a transaction within a transaction` or `cannot rollback - no transaction is active` output.

Native evidence must record device/OS, package/channel, OTA/update ID, implementation SHA, actions performed, queue wait/write durations, cache source on the repeated timeline read, and every SQLite error observed. Raw logs remain local and any PR excerpt must be sanitized.

## Risks And Mitigations

- **Deadlock from nested queue entry:** queued callbacks contain only direct SQLite statements and never await another public queued repository method. Tests cover the supported composition boundary.
- **Queue poisoning after rejection:** advance the stored tail through both fulfillment and rejection, but return the original entry promise to preserve the caller's error.
- **Old-user write after sign-out:** capture scopes before remote work, invalidate them synchronously at cleanup start, and keep the existing sign-in cleanup await.
- **Cleanup races with an active transaction:** cleanup uses the same queue and therefore runs only after the active entry exits.
- **Silent repair failure:** await retry and propagate the final rejection.
- **Excessive telemetry:** fixed labels and bounded operation names only; no row contents or user/fund identifiers.
- **Cache invalidation/version drift:** no stored shape changes, so `SCHEMA_VERSION` and React Query `__BUSTER__` remain unchanged; document the ownership change in the cache inventory.

## Decision Log

- 2026-07-02: Branch N2D from `origin/main` at N2 merge `7d3f25ef`, after coordinator commit `6548e25` marked N2D Ready to start.
- 2026-07-02: Use one connection-level serializer, not repository locks, because every native repository receives the same `getDb()` connection.
- 2026-07-02: Keep N2T financial/timeline computation changes out of N2D.
- 2026-07-02: Treat cleanup as a queue lifecycle boundary with scope invalidation; draining alone cannot stop an older remote request from enqueueing after a wipe.
- 2026-07-02: Retry timeline repair once from retained fetched rows and propagate a second failure.
- 2026-07-02: Codex review identified that high-level bootstrap/delta captured their scope after the roster request and used global unkeyed single-flight promises. Capture before roster I/O, pass that scope into `runSync`, and use identity-safe maps keyed by user plus generation.

## Amendments

The implementation follows the planned scope. The lifecycle fence was applied to every existing asynchronous native read-through writer, not only the timeline, so Portfolio NAV/index, Fund Detail NAV/tail, and transaction read-through work also carries the generation captured before its remote request. This is required for the cleanup invariant; leaving any older read-through path unscoped would allow it to enqueue after sign-out or manual reset.

The serializer also owns `sync_state` writes and the manual Settings cache reset. Although `sync_state` does not open a transaction itself, an uncoordinated `runAsync` could otherwise execute between another repository's `BEGIN` and `COMMIT` on Expo's non-exclusive connection. Cleanup deletes all four cached tables in one queued transaction.

Independent review found one lifecycle gap in the initial implementation: `bootstrapForUser` and `syncDeltaForUser` fetched the fund roster before `runSync` captured its generation, and their single-flight promises were global. A blocked old-user roster could therefore cross cleanup, capture the new generation, and be reused by a new user. The corrected implementation captures before roster I/O, passes the originating scope through `bootstrap`/`syncDelta` into `runSync`, and keeps separate identity-safe in-flight maps keyed by user plus generation. Blocked-roster race tests cover both high-level paths and prove only the new user's transaction remains after cleanup.

No schema or cached row shape changed. `SCHEMA_VERSION` remains 2 and React Query `__BUSTER__` is unchanged.

Validation completed before native evidence:

- Focused database, timeline, index, Portfolio, and Fund Detail tests passed: 9 suites and 161 tests.
- The review-fix regression subset passed: 3 suites and 47 tests.
- Full Jest passed after the review fix: 78 suites and 1,814 tests.
- `npm run typecheck` passed with zero errors.
- `npm run lint` passed with zero warnings.
- Android production export passed: 1,747 modules and a 6.2 MB Hermes bundle.
- `git diff --check` passed.

Pre-review Android physical evidence used a Pixel 8a running Android 16 with package `com.foliolens.app.mainpreview`, app version/runtime `0.0.4`, and channel `foliolens-main`. The Android OTA was `019f1ffb-2073-7241-941f-c77c691b4df6` (group `8e02462d-f6cd-44a7-850b-81f92d9d5249`) at initial implementation SHA `715ec3c36a5269c6136224ff426ea171a1d6e525`. The About screen independently displayed `foliolens-main` and OTA prefix `019f1ffb-207…` after clean process restarts. The serializer behavior remains useful supporting evidence, but final acceptance must be recaptured at the corrected lifecycle head.

The stress sequence unlocked the native cache diagnostics, reset the local cache, immediately opened Portfolio and changed benchmarks, backgrounded/foregrounded the app to start delta sync, and then selected the 3Y timeline while bootstrap and read-through work remained active. It exercised `database_clear_all`, bootstrap and delta transaction/NAV/index writes, Portfolio NAV/index write-back, timeline NAV repair, and sync-state updates on the same connection.

Measured evidence:

- The queue absorbed real contention: the longest observed queue wait was 41,084 ms and the longest write was the 38,164 ms cold bootstrap NAV transaction. Portfolio/index and delta work waited rather than starting a nested transaction.
- Timeline NAV repair completed successfully from retained rows under the cold overlap. Recorded repair writes included 24,031 ms, 8,158 ms, and 8,289 ms; the deliberately cold run covered up to 34,299 fetched NAV rows. Every recorded repair/write status was `ok`; no `error` or `stale` status appeared.
- Foreground delta sync completed in 13,436 ms while sharing the queue. The deliberately empty-cache bootstrap completed in 123,653 ms after the queued stress work. These are correctness-stress timings, not claimed performance improvements.
- Sanitized logs contain zero `cannot start a transaction within a transaction`, zero `cannot rollback - no transaction is active`, and zero SQLite write-failure matches.
- Automated repair evidence remains the deterministic locality proof: an injected first transaction failure is followed by a successful retry using the same fetched rows, and a later identical timeline call makes no second NAV network request. A separate test proves a second repair failure rejects the timeline query.

The very long cold write/repair times are a confirmed limitation, not an N2D regression or hidden success claim. N2D establishes ordering and durable repair. N2T immediately follows and owns reducing the repeated input/valuation volume that made this stress run expensive.

Raw device logs and UI dumps remain local under `/tmp/foliolens-n2d-android-main/`; PR evidence contains only bounded operation names, row counts, durations, status values, device/build identity, and error counts.

Final corrected-head Android evidence used the same Pixel 8a running Android 16 with package `com.foliolens.app.mainpreview`, app version/runtime `0.0.4`, and channel `foliolens-main`. The Android OTA was `019f201f-b4bd-76f7-8386-57c7f3a7d5b0` (group `5cfbb5b0-2042-43e5-9797-06294253f4e7`) at review-fix SHA `86d176dd63c3b489787e111a9b6b850fb13018d9`. EAS reported that exact `gitCommitHash`, and the About screen displayed OTA prefix `019f201f-b4b…` after three process restarts.

The corrected-head stress sequence reset the local cache, opened Portfolio during post-reset work, changed benchmarks, backgrounded and foregrounded the app, selected the 3Y timeline, waited for the serialized writes to drain, and then switched away from and back to the identical 3Y selection. It recorded 33 completed serialized writes across transaction, NAV, index, sync-state, and timeline-repair operations. The two timeline repairs completed with `ok` status in 8,833 ms and 9,240 ms; the second waited 8,405 ms behind the first. All other recorded writes completed in at most 13 ms. The repeated identical 3Y read produced no later `db:write` or repair event, consistent with the repaired SQLite cache serving that request locally.

The corrected-head log contains zero nested-transaction matches, zero invalid-rollback matches, zero SQLite write failures, zero `status: 'error'` writes, and zero timeline-retry warnings. The high-level blocked-roster tests provide the deterministic user/generation cleanup-race proof added for review; this physical run confirms that the corrected implementation retains the shared-connection ordering and local-repair behavior on the release Android target. Raw corrected-head artifacts remain local under `/tmp/foliolens-n2d-android-corrected-86d176d/`.

## Progress

- [x] Read AGENTS.md, VISION.md, docs/TECH-DISCOVERY.md, docs/architecture/cache-surfaces.md, docs/process/PLANS.md, the current control report, and PR #250 conversation.
- [x] Create `codex/n2d-sqlite-write-serialization` from current `origin/main`.
- [x] Record the N2D scope and implementation decisions in this ExecPlan.
- [x] Implement the shared serializer and lifecycle fence.
- [x] Route repository, sync-state, reset, and cleanup writes through the serializer.
- [x] Make timeline NAV repair awaited and retriable.
- [x] Add focused concurrency and repair tests.
- [x] Run repository validation.
- [x] Capture final Android main-preview evidence at the corrected implementation SHA.
- [x] Publish the implementation PR and attach acceptance evidence.
