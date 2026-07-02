# N0 Native Data Lifecycle Independence

## Goal

Make the native SQLite lifecycle correct even when PostHog is absent or misconfigured. Initial and auth-driven bootstrap, foreground delta sync, sign-out cleanup, cache clearing, and global error-handler installation must run independently of analytics configuration, while analytics calls remain optional diagnostics.

## User Value

The PR-preview build currently compiles without a PostHog key. In that build, the root lifecycle effect exits before it bootstraps SQLite or installs auth, sign-out, and foreground listeners. A user can therefore see cold remote reads, stale local data, or user-scoped cache data that is not cleared simply because telemetry is disabled. After N0, correctness is identical across preview-pr, preview-main, and production, and all three native channels carry comparable navigation telemetry configuration.

## Context

PR #250 is the unmerged control plane for the navigation performance-remediation program. N2T merged in PR #254 as `74cf1d897fd5b169089d797b600a416aef670bcf`; this branch starts directly from that `origin/main` commit. The N0 prompt owns only the analytics/data-lifecycle coupling and PR-preview PostHog wiring.

The user reported the original state-dependent hangs on both main and preview builds. Because main already supplies `EXPO_PUBLIC_POSTHOG_KEY`, the missing key cannot be the shared cross-channel root cause. It is still a correctness bug and a preview-only amplifier. The instrumented PR-preview physical run used Android package `com.foliolens.app.prpreview`, channel `foliolens-pr`, OTA `019f1e01-2178-7209-bae6-f1c94efff850`; the workflow that produced it omitted the PostHog key, so `analytics.isEnabled` was false. Secret-name inspection confirms `POSTHOG_PROJECT_KEY` exists without reading or printing its value, and the repository variable `POSTHOG_HOST` points to the configured EU ingest host.

## Assumptions

- Android is the only native acceptance platform because FolioLens has no iOS publishing path.
- SQLite remains native-only; web keeps its React Query and Supabase paths.
- Analytics is diagnostic and can never be a precondition for data correctness or privacy cleanup.
- The existing sign-out-to-sign-in serialization must remain intact.
- The existing query, Zustand, onboarding-draft, and SQLite cleanup inventory is complete and must remain one audited sign-out operation.

## Definitions

- **Lifecycle controller:** a testable function that registers auth and app-state listeners and owns bootstrap, foreground sync, and sign-out cleanup.
- **Analytics boundary:** the `analytics.isEnabled` decision that permits optional `track`, `identify`, and `reset` calls without enclosing correctness work.
- **Initial bootstrap:** the first SQLite bootstrap for the already-authenticated user returned by `getSession()`.
- **Foreground delta sync:** the throttled native refresh that runs when the app becomes active.
- **Preview parity:** preview-pr, preview-main, and production OTA workflows all provide the PostHog key and host under the same environment-variable names.

## Scope

- Extract the root data lifecycle into a testable controller and call it once from `app/_layout.tsx`.
- Run bootstrap, auth subscription, sign-out cleanup, foreground sync, and global error-handler installation regardless of `analytics.isEnabled`.
- Guard only analytics tracking, identification, and reset behavior.
- Preserve native/web guards and sign-out-to-sign-in cleanup serialization.
- Add disabled-analytics tests for initial bootstrap, `SIGNED_IN`, `SIGNED_OUT`, foreground sync, and serialization.
- Add PostHog key and host wiring to `.github/workflows/pr-preview.yml` without exposing values.
- Add a repository regression test that verifies all three native OTA workflows wire the key and host.
- Update infrastructure/cache documentation and README lifecycle behavior.
- Publish and verify an Android preview-pr OTA at the implementation SHA, then record before/after cold-query behavior.

## Out of Scope

- Treating N0 as the shared cause of main and preview hangs.
- Changing SQLite schema, serializer, repair behavior, timeline computation, navigation scheduling, or query invalidation policy.
- Changing PostHog event names or payload contents beyond retaining existing optional diagnostics.
- Adding another analytics vendor or runtime feature-flag system.
- iOS measurements.

## Approach

Move the non-React lifecycle orchestration into `src/lib/appLifecycle.ts`. The controller receives narrow dependency functions for auth, app-state subscription, SQLite sync and cleanup, React Query cleanup, Zustand reset, onboarding-draft cleanup, and analytics. This keeps provider-specific access at existing wrapper boundaries and makes disabled-analytics behavior runnable under Jest without rendering the Expo root layout.

At startup, the controller always installs global error handlers, resolves the current session, registers the auth listener, and registers the app-state listener. It derives no-op `track`, `identify`, and `reset` functions when analytics is disabled. All data operations are outside that optional boundary. On sign-out, it synchronously clears in-memory React Query data and resets Zustand state, starts persisted-query and onboarding-draft cleanup, and generation-fenced SQLite cleanup. A subsequent sign-in waits for the SQLite cleanup promise before bootstrapping, matching the existing serialization.

The PR-preview workflow will consume the existing `POSTHOG_PROJECT_KEY` secret and `POSTHOG_HOST` repository variable using the same expressions as main and production. A text-level workflow regression test inspects the environment block for each native OTA variant; it reads names and expressions only, never secret values.

## Alternatives Considered

- Remove only the early return in `app/_layout.tsx`. Rejected because the large hook would remain difficult to test, and N0 explicitly requires disabled-analytics lifecycle regression coverage.
- Split analytics and data behavior into two unrelated effects. Rejected because both need the same auth and app-state events, which would create duplicate subscriptions and make ordering harder to reason about.
- Require PostHog on every channel and leave correctness coupled. Rejected because telemetry configuration is fallible and must never control bootstrap or privacy cleanup.
- Move lifecycle work into screen hooks. Rejected because hidden or unmounted screens cannot own application-wide auth and cache correctness.

## Milestones

### 1. Freeze disabled-analytics behavior

Create a testable lifecycle controller and tests that run it with `analytics.isEnabled === false`.

Expected outcome: tests fail against the old root early-return behavior and prove initial bootstrap, auth bootstrap, sign-out cleanup, foreground delta sync, error-handler installation, and sign-out-to-sign-in serialization.

Run:

    npm test -- --runInBand src/lib/__tests__/appLifecycle.test.ts

Acceptance: every required operation is observed while no analytics method is invoked.

### 2. Integrate lifecycle and channel parity

Replace the root hook body with one controller installation, make global error-handler installation analytics-independent, add the preview-pr key/host environment wiring, and add a workflow regression test covering preview-pr, preview-main, and production.

Expected outcome: `app/_layout.tsx` no longer gates correctness on PostHog and every native OTA workflow has comparable telemetry configuration.

Run:

    npm test -- --runInBand src/lib/__tests__/appLifecycle.test.ts src/lib/__tests__/installGlobalErrorHandlers.test.ts scripts/__tests__/native-analytics-config.test.ts

Acceptance: focused tests pass and workflow assertions fail if either key or host wiring is removed from any native channel.

### 3. Validate and measure Android preview-pr

Run repository checks, publish the implementation to preview-pr, verify the About-screen OTA prefix, and compare a cold launch with the pre-fix analytics-disabled preview behavior.

Expected outcome: the exact implementation update reports analytics enabled, runs SQLite bootstrap on cold authenticated launch, and retains foreground/sign-out behavior without lifecycle errors.

Run:

    npm run typecheck
    npm run lint
    npm test -- --runInBand
    npx expo export --platform android --output-dir /tmp/foliolens-n0-android-export
    git diff --check

Acceptance: all checks pass; Android evidence records device/OS, package/channel, OTA ID, implementation SHA, analytics state, cold bootstrap/query sequence, and any SQLite/auth errors.

## Validation

Automated evidence must prove:

- disabled analytics does not block initial bootstrap;
- disabled analytics does not block a later `SIGNED_IN` bootstrap;
- disabled analytics does not block React Query, persisted-query, Zustand, onboarding-draft, or SQLite cleanup on `SIGNED_OUT`;
- a sign-in that follows sign-out waits for local SQLite cleanup;
- disabled analytics does not block throttled foreground delta sync;
- global error-handler installation is attempted even when analytics is disabled;
- preview-pr, preview-main, and production workflow environment blocks each include PostHog key and host expressions;
- native/web guards remain unchanged.

Native evidence must compare the known pre-fix analytics-disabled PR-preview target with the new preview-pr update. It must identify the OTA and code SHA and record whether cold bootstrap/local-query behavior occurs before Portfolio becomes usable. N0 must be described as preview-only correction, not proof that the shared hang is solved.

## Risks And Mitigations

- **Duplicate subscriptions:** install the controller once in a zero-dependency root effect and return both unsubscribe functions.
- **Sign-out/sign-in race regression:** retain one pending cleanup promise and add an explicit deferred-cleanup test.
- **Analytics calls when disabled:** route only optional calls through enabled-bound no-op functions and assert zero calls.
- **Web SQLite access:** preserve the `Platform.OS !== 'web'` dependency passed by the root.
- **Secret exposure:** reference GitHub secret/variable expressions only; never query or print the secret value.
- **Misattributed performance result:** compare channel behavior but retain the report conclusion that main already had analytics and therefore N0 is not the shared root cause.

## Decision Log

- 2026-07-02: Start N0 immediately from `origin/main` `74cf1d89` under the updated execution rule; coordinator status is asynchronous bookkeeping.
- 2026-07-02: Use a dependency-injected lifecycle controller so disabled-analytics correctness can be proven without mounting Expo Router.
- 2026-07-02: Keep one auth and one app-state subscription rather than splitting analytics and correctness into duplicate effects.
- 2026-07-02: Reuse the existing GitHub PostHog secret and host variable; only names/expressions are inspected.

## Amendments

The implementation follows the planned controller split. The existing root lifecycle behavior moved without changing event names, query invalidation, sync throttling, or cleanup ordering. The transaction-count diagnostic is now skipped entirely when analytics is disabled, avoiding a SQLite read that has no consumer in that configuration. Global handlers still chain to the prior runtime handler; their analytics capture call goes through the existing no-op facade when PostHog is unavailable.

No cache key, payload, persistence allowlist, SQLite schema, or Zustand shape changed, so neither React Query `__BUSTER__`, SQLite `SCHEMA_VERSION`, nor the Zustand version requires a bump.

Pre-native validation passed with 3 focused suites / 11 tests, full Jest 81 suites / 1,833 tests, typecheck, zero-warning lint, diff check, and an Android preview-pr export of 1,748 modules / 6.3 MB Hermes.

Final Android preview-pr evidence used implementation `8433596be61bef61e12a7bfe91a0c6eb650705e9` on a Pixel 8a / Android 16, package `com.foliolens.app.prpreview`, channel `foliolens-pr`, runtime/app `0.0.4`. The PR workflow produced Android OTA `019f23ef-e7d8-7dd1-9f2c-f1f78f5ccd84` in group `ad434d49-a2c9-4c96-adae-074f71484642`. Its job log showed `EXPO_PUBLIC_POSTHOG_KEY: ***` and `EXPO_PUBLIC_POSTHOG_HOST: https://eu.i.posthog.com`; this is sufficient to establish `analytics.isEnabled === true` because the native facade constructs its client exactly when the key is present. After three process restarts, About displayed `019f23ef-e7d…`.

On the authenticated cold launch, Android displayed the activity in 416 ms. The app read 566 timeline transactions in 64 ms, 13,605 timeline NAV rows in 123 ms, built timeline inputs in 2,039 ms, read Portfolio NAV from SQLite in 80 ms and index rows from SQLite in 34 ms, and completed the Portfolio query in 2,962 ms. More importantly for N0, the log then recorded `bootstrap_tx_write`, `bootstrap_tx_sync_state`, `bootstrap_nav_write`, and per-scheme bootstrap sync-state operations. The pre-fix preview-pr control could not produce any root-lifecycle bootstrap operation: the same channel omitted the key, `analytics.isEnabled` was false, and the old root effect returned before `getSession`, auth subscription, and `bootstrapForUser`.

Backgrounding and foregrounding the exact update produced `delta_tx_write`, `delta_nav_write`, and `delta_index_write` plus their sync-state operations. Recorded delta writes were 3–12 ms with zero queue wait in the captured sequence. Across OTA application, cold launch, and foreground evidence there were zero nested-transaction, invalid-rollback, `SQLITE_BUSY`, `SQLITE_LOCKED`, write-error-status, bootstrap-failed, foreground-delta-failed, clear-failed, or auth-session-missing matches. The device screen timeout was restored to 60 seconds after capture.

One separate signal remains visible: the first cold launch logged `persister:restore_failed` at 141 ms. N0 does not change the React Query persister, and native SQLite lifecycle still ran correctly. This is retained as evidence for the later persistence/cache milestone rather than misreported as an N0 regression or silently omitted.

## Progress

- [x] Read AGENTS.md, VISION.md, docs/INFRASTRUCTURE.md, docs/architecture/cache-surfaces.md, the updated control report, and later PR #250 comments.
- [x] Verify N2T merge on `origin/main` and create `codex/n0-native-data-lifecycle` from `74cf1d89`.
- [x] Record the pre-fix preview variant, OTA, and disabled analytics state.
- [x] Add disabled-analytics lifecycle tests and controller.
- [x] Integrate the controller in the root layout and make error-handler installation independent.
- [x] Add preview-pr telemetry wiring and channel regression coverage.
- [x] Update documentation.
- [x] Run focused, full, static, and Android export validation.
- [x] Capture Android preview-pr acceptance evidence at the implementation SHA.
- [x] Push and open draft implementation PR #255.
