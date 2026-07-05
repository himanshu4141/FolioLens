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

## Risks And Mitigations

- A lifecycle consumer could mount before session bootstrap resolves. The provider's current-session adapter waits for the bootstrap promise.
- Supabase may emit an initial auth event as well as resolving `getSession()`. The lifecycle retains its event-specific behavior, and tests cover one underlying listener rather than assuming provider event order.
- Local Funds search no longer survives a responsive layout swap. Search was already deliberately non-persisted transient input; resetting on a rare breakpoint swap is preferable to global keystroke fan-out.

## Decision Log

- 2026-07-05: Started N4 from `origin/main` at C1 merge `289d224f` because N4 is the first Pending PR #250 row.
- 2026-07-05: Chose an in-process provider-to-lifecycle adapter so exactly one Supabase auth listener exists while retaining the independently tested lifecycle controller.
- 2026-07-05: Kept the CAS upload's action-time token lookup. It is not an application bootstrap or subscription, and it intentionally obtains the current access token at the upload boundary. Removed the redundant action-time session read from portfolio-composition sync because the functions wrapper already supplies auth.
- 2026-07-05: Localized Funds search independently in mobile and desktop layouts and deferred the filter input. Transient search now resets on a responsive breakpoint swap; this is preferable to publishing each keystroke into the process-wide store.

## Progress

- [x] Read `VISION.md`, `docs/process/PLANS.md`, PR #250, and report sections 2 and 5.
- [x] Add and mount the single SessionProvider.
- [x] Route application lifecycle auth reads/events through the provider.
- [x] Replace selector-free Zustand subscriptions and localize Funds search.
- [x] Memoize portfolio insight computation.
- [x] Add N4 regression tests.
- [ ] Run all required validation and native transition smoke. Typecheck, zero-warning lint, diff check, focused tests, and full Jest (86 suites / 1,889 tests) pass; exact-head native smoke remains.
- [ ] Open the implementation PR and request independent reviews.
