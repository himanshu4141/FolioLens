# Navigation N4: Single Session Provider and Narrow State Subscriptions

## Goal

Make authentication and global UI state cheap to consume. The app must create one Supabase session bootstrap and one Supabase auth subscription, regardless of how many screens and hooks are mounted. Screens must subscribe only to the Zustand fields they use, and portfolio insights must not recompute when its financial inputs are unchanged.

## User Value

Opening Portfolio, Funds, Fund Detail, Settings, and About should not add auth listeners or trigger unrelated hidden-screen rerenders. Token refresh and preference changes should update only the consumers that need them, reducing transition contention without changing visible behavior or financial calculations.

## Context

PR #250 identified two structural problems. `src/hooks/useSession.ts` currently owns an effect, so every consumer calls `authClient.getSession()` and registers `authClient.onAuthStateChange()`. `app/_layout.tsx` also installs its own auth lifecycle subscription. Separately, broad `useAppStore()` calls subscribe large screens to every Zustand update, and `usePortfolioInsights` invokes `computeInsights` during every render.

N1 through N3 and the C1 correctness hotfix are already present on `main`. This plan changes auth/state subscription structure only. It must preserve AuthGate routing, magic-link and OAuth completion, native SQLite bootstrap/foreground sync/sign-out cleanup, preview mode, test mocks, and all financial output.

## Assumptions

- `authClient` remains the only Supabase auth wrapper.
- The root provider is mounted once for the application process.
- The existing lifecycle controller remains responsible for analytics, SQLite bootstrap, foreground sync, and sign-out cleanup, but receives session data from the root provider rather than opening another Supabase subscription.
- Zustand v5 `useShallow` is available through `zustand/react/shallow`.

## Definitions

- **Auth subscription:** the callback registered with `authClient.onAuthStateChange()`.
- **Session bootstrap:** the initial `authClient.getSession()` call used to establish the current signed-in state.
- **Selector:** a function that returns only the Zustand fields a component needs.
- **Stable tuple:** a small selector result compared shallowly so unrelated store fields cannot cause a rerender.

## Scope

- Add one root `SessionProvider` and make `useSession()` a context reader with no effect.
- Bridge the provider session stream into `startAppLifecycle` so it performs no direct auth bootstrap or Supabase auth subscription.
- Preserve all current `useSession()` consumers while making them share the provider.
- Replace every selector-free `useAppStore()` call with primitive selectors or `useShallow` over the smallest useful tuple.
- Keep Funds search input screen-local and defer its filtering value.
- Memoize `computeInsights` from stable fund-card and composition inputs.
- Add regressions for one underlying auth subscription and Zustand render isolation.

## Out of Scope

- Native Google OAuth state-machine changes (Auth A0).
- Visual redesign, list virtualization, financial arithmetic, query-key changes, or cache-format changes.
- Fund Detail transition-first work (N6).

## Approach

Create a session context whose provider owns the only Supabase bootstrap and listener. The context exposes the current React snapshot plus stable lifecycle adapters: an async current-session getter that waits for bootstrap, and an in-process event subscription. `startAppLifecycle` continues to consume its existing dependency interface, but the dependencies now point at the context adapters rather than `authClient`. This preserves the tested lifecycle controller while removing duplicate provider access.

Use `useShallow` for components that need multiple Zustand values and primitive selectors for one value. Funds search remains local to each active layout and uses `useDeferredValue` for filtering, so typing does not publish high-frequency updates to hidden screens.

## Alternatives Considered

- Keeping the lifecycle's direct auth subscription would leave two process-wide Supabase subscriptions and fail the explicit invariant.
- Moving SQLite lifecycle side effects into the SessionProvider would couple a reusable auth primitive to native storage and analytics. The in-process adapter preserves separation.
- Adding a second external session store was rejected because React context already provides the authoritative session snapshot.

## Milestones

1. Implement and mount the provider. Multiple consumers observe one session snapshot; the lifecycle receives the same bootstrap and auth events without calling Supabase itself.
2. Narrow every broad Zustand subscription and localize/defer Funds search input. Observable UI behavior remains unchanged.
3. Memoize portfolio insight derivation and add focused regression tests for auth-subscription cardinality and unrelated-store-update render isolation.
4. Run focused tests, full Jest, typecheck, zero-warning lint, and diff check. Open one implementation PR and keep evidence/review discussion there.

## Validation

- `npm run typecheck` completes with zero errors.
- `npm run lint` completes with zero warnings.
- Focused N4 tests prove multiple session consumers cause one `getSession()` and one `onAuthStateChange()` registration, and cleanup unsubscribes once.
- Render-count tests prove unrelated store updates do not rerender representative Portfolio/Funds selector consumers, while their selected fields still do.
- Full Jest remains green.
- A release-like native smoke checks Settings to About and Funds to Fund Detail without new auth bootstrap/subscription logs or behavior regressions.

## Initial Native Acceptance Evidence (superseded by code review)

Android acceptance ran on a paired Pixel 8a running Android 16 with the PR-preview package `com.foliolens.app.prpreview`. The measured implementation is `1b940695`; the exact Android OTA is `019f2fe5-d91d-7218-b57c-c977bfbb3a9a`. About showed channel `foliolens-pr`, prefix `019f2fe5-d91…`, version `0.0.4`, and the 5 Jul 2026 update date.

- Settings to About committed in 79 ms and became post-interaction usable in 86 ms. The sample was idle (`sync_in_flight=false`) with 6 active queries, 20 funds, and 566 transactions.
- Funds to Fund Detail was a cold target: route commit 50 ms and post-interaction usable 69 ms, also with `sync_in_flight=false`, 6 active queries, 20 funds, and 566 transactions. The useful hero rendered for DSP US Specific Equity Omni FoF with current value, invested amount, daily move, XIRR, and tabs; the local full-history NAV read then completed from SQLite.
- App-PID log scans across both transitions found zero auth/session failures, SQLite full/busy/locked/write errors, database-full errors, catalystLocalStorage failures, or fatal React Native exceptions.
- Runtime routing preserved the authenticated account and AuthGate throughout both transitions. Underlying provider cardinality is established deterministically at this exact implementation by the focused test that mounts three session consumers and observes one `authClient.getSession()` bootstrap, one `authClient.onAuthStateChange()` subscription, and one unsubscribe. Route consumers contain no auth effects, so mounting About or Fund Detail cannot register another provider listener.

Automated validation at the measured implementation: focused N4 tests 2 suites / 2 tests, full Jest 86 suites / 1,889 tests, typecheck, zero-warning lint, and diff check.

This evidence remains a useful transition baseline but is no longer final acceptance: independent Codex review found a bootstrap/auth-event ordering race, so corrected-head native evidence is required after the fix OTA.

## Amendments

- The implementation keeps CAS PDF upload's action-time `getSession()` token lookup. This is not an application bootstrap or subscription; it deliberately obtains the current access token immediately before a native binary upload.
- Funds search moved from transient Zustand state to layout-local state with a deferred filtering value. It can reset if the app crosses the mobile/desktop breakpoint, but keystrokes no longer fan out through the global store.
- The cache-shape guard is satisfied with the PR-title marker `[cache-shape-stable]`: N4 changes hook execution and subscriptions but does not alter a React Query key or serialized payload shape, so a `__BUSTER__` bump would incorrectly discard valid financial caches.
- Independent Codex review found that the initial bootstrap promise and auth callback were unsequenced writers. A delayed null bootstrap could erase a newer `SIGNED_IN`, while a delayed old bootstrap could resurrect a newer `SIGNED_OUT`. Auth events now advance a revision and resolve the bootstrap deferred immediately; bootstrap success/error applies only if no auth event has advanced that revision. Focused regressions reproduce both races.

## Risks And Mitigations

- A lifecycle consumer could mount before session bootstrap resolves. The provider's current-session adapter waits for the bootstrap promise.
- Supabase may emit an initial auth event as well as resolving `getSession()`. The lifecycle retains its event-specific behavior, and tests cover one underlying listener rather than assuming provider event order.
- Local Funds search no longer survives a responsive layout swap. Search was already deliberately non-persisted transient input; resetting on a rare breakpoint swap is preferable to global keystroke fan-out.

## Decision Log

- 2026-07-05: Started N4 from `origin/main` at C1 merge `289d224f` because N4 is the first Pending PR #250 row.
- 2026-07-05: Chose an in-process provider-to-lifecycle adapter so exactly one Supabase auth listener exists while retaining the independently tested lifecycle controller.
- 2026-07-05: Kept the CAS upload's action-time token lookup. It is not an application bootstrap or subscription, and it intentionally obtains the current access token at the upload boundary. Removed the redundant action-time session read from portfolio-composition sync because the functions wrapper already supplies auth.
- 2026-07-05: Localized Funds search independently in mobile and desktop layouts and deferred the filter input. Transient search now resets on a responsive breakpoint swap; this is preferable to publishing each keystroke into the process-wide store.
- 2026-07-05: Auth events take precedence over an in-flight bootstrap. This preserves the newest identity state and lets the lifecycle proceed from the first authoritative event instead of waiting for a stale bootstrap response.

## Progress

- [x] Read `VISION.md`, `docs/process/PLANS.md`, PR #250, and report sections 2 and 5.
- [x] Add and mount the single SessionProvider.
- [x] Route application lifecycle auth reads/events through the provider.
- [x] Replace selector-free Zustand subscriptions and localize Funds search.
- [x] Memoize portfolio insight computation.
- [x] Add N4 regression tests, including late-bootstrap-after-sign-in and late-bootstrap-after-sign-out ordering.
- [ ] Run all required validation and corrected-head native transition smoke. Typecheck, zero-warning lint, diff check, focused tests (2 suites / 4 tests), and full Jest (86 suites / 1,891 tests) pass; corrected-head Android evidence is pending.
- [x] Open draft implementation PR #259. Independent review requests follow the evidence-only commit.
