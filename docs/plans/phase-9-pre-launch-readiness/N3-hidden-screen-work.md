# N3 Hidden-Screen Work and Granular Sync Invalidation

## Goal

Prevent hidden navigation screens and stale React Query observers from starting expensive work during another screen's transition. Native synchronization must invalidate only data that actually changed, mark hidden derived queries stale without refetching them, and immediately refresh only the visible route's affected queries.

## User Value

Portfolio, Funds, Wealth Journey, and Settings currently remain mounted as the user navigates. A bootstrap or foreground sync that inserts one row can invalidate every query in the app, causing hidden portfolio aggregation, timelines, Money Trail transforms, and Settings reads to compete with the destination screen. After N3, hidden screens stay frozen and their expensive queries are disabled. They become stale when their inputs change and refresh when focused again, while the visible screen receives the needed update immediately.

## Context

PR #250 is the unmerged control plane for the navigation performance-remediation program. N0 merged in PR #255 as `303905447db341b7708a98e19b024fa6b29abfca`; this branch starts directly from that `origin/main` commit under the updated rule that coordinator status is asynchronous bookkeeping.

N1 added navigation and query timing. N2 removed automatic alternate-benchmark prefetch and focus-gated targeted prefetch. N2D serialized SQLite writes, N2T reused timeline inputs, and N0 decoupled native data lifecycle from analytics. N3 now removes the remaining hidden-observer and global-invalidation amplifier without changing financial calculations.

The tab navigator freezes only Wealth Journey today. Root bootstrap and foreground sync call unscoped `queryClient.invalidateQueries()` whenever any transaction, NAV, or index row changes. React Query refetches active observers by default, and a frozen React tree can still own active observers. Portfolio and Funds both mount the full portfolio query and composition work; Portfolio also mounts Money Trail and timeline queries; Wealth Journey mounts portfolio and transaction derivation; Settings owns freshness queries.

## Assumptions

- Android main-preview is the native acceptance target. iOS remains out of scope because FolioLens has no iOS publishing path.
- React Query cached data remains readable while a query is disabled; focus gating therefore preserves the last rendered state and only suppresses fetches.
- Returning focus changes disabled queries back to enabled, which refetches stale data under React Query's existing defaults.
- SyncResult insertion counts are authoritative for which SQLite input family changed.
- CAS import paths that explicitly invalidate broader state remain unchanged; root sync invalidation becomes granular.

## Definitions

- **Hidden screen:** a mounted route that is not the current navigation focus.
- **Freeze on blur:** React Native Screens behavior that suspends rendering updates for an unfocused screen.
- **Focus gate:** a React Query `enabled` condition that includes `useIsFocused()` so hidden observers cannot fetch or refetch.
- **Derived prefix:** the first element of a React Query key whose payload depends on transaction, NAV, or index inputs.
- **Stale-only invalidation:** `invalidateQueries` with `refetchType: 'none'`, which marks matching cache entries stale without starting network or SQLite work.
- **Visible-route refetch:** an explicit refetch of affected active prefixes owned by the current route after stale-only invalidation completes.

## Scope

- Set `freezeOnBlur: true` for Portfolio, Funds, Wealth Journey, Settings, and every Settings stack screen.
- Keep native inactive-screen detachment explicit.
- Add focus-aware `enabled` options to expensive reusable hooks without changing their cache keys or payloads.
- Focus-gate Portfolio aggregation, fund roster, timeline, Money Trail, and composition queries in both mobile and desktop Portfolio.
- Focus-gate Portfolio/composition queries in mobile and desktop Funds.
- Focus-gate Portfolio and transaction derivation in Wealth Journey.
- Focus-gate Settings freshness queries and Fund Detail's detail/NAV/index/timeline work.
- Replace root global invalidation with a pure, tested SyncResult mapper.
- Mark every affected prefix stale with `refetchType: 'none'`; refetch only affected prefixes owned by the current visible route.
- Include `user-funds` on transaction changes so a newly imported CAS fund roster remains correct.
- Remove the `^NSEI` default from `usePortfolio`; update Wealth Journey and onboarding to use the stored TRI benchmark.
- Add automated regression coverage for mapping, hidden-route non-refetch, freeze config, and Wealth Journey benchmark selection.
- Capture release-like Android Settings → About and Funds → Fund Detail evidence with no hidden Portfolio/timeline starts.

## Out of Scope

- Splitting portfolio core from benchmark output; N7 owns that larger financial-compute refactor.
- Virtualizing Funds or Money Trail; N5 owns list scaling.
- Replacing the session architecture or broad Zustand subscriptions; N4 owns those changes.
- Changing query payload shapes, persistence allowlist, SQLite schema, or sync write behavior.
- Changing manual pull-to-refresh or CAS-import invalidation beyond the two root lifecycle calls named by Prompt 3.
- iOS measurements.

## Approach

Create `src/lib/syncInvalidation.ts` as a provider-light module. It accepts the structural SyncResult fields and returns unique one-element query-key prefixes. Transaction changes, including drift repair, invalidate fund/transaction inputs and every transaction-derived portfolio, Money Trail, timeline, Fund Detail, and Wealth Journey result. NAV changes invalidate portfolio, Fund Detail NAV, latest-NAV, and timeline results. Index changes invalidate portfolio and benchmark/index-derived results only.

The helper first invalidates every affected prefix with `refetchType: 'none'`. It then intersects those prefixes with a fixed visible-route ownership map and calls `refetchQueries({ type: 'active' })` only for the intersection. An About transition therefore starts no Portfolio/timeline refetch even if sync completes during the transition. A visible Portfolio route refetches its affected portfolio/chart/preview queries immediately. Hidden disabled observers refetch when focus returns.

The root lifecycle keeps one stable auth/app-state installation. `useAppLifecycle` stores the latest normalized pathname in a ref and passes it to the invalidation helper without resubscribing lifecycle listeners on navigation.

Reusable hooks gain an optional `{ enabled?: boolean }` argument with `true` as the compatibility default. Cache keys and query functions are unchanged. Screen owners combine this option with their existing auth/preview prerequisites. Fund Detail passes focus into its screen-only detail, NAV, index, and investment-timeline reads.

`usePortfolio` will require a benchmark symbol. Wealth Journey reads `defaultBenchmarkSymbol` from the store; onboarding's success screen does the same. TypeScript then prevents any future no-argument call from silently recreating the legacy `^NSEI` cache variant.

## Alternatives Considered

- Rely on `freezeOnBlur` alone. Rejected because React Query observers can remain active and refetch while rendering is frozen.
- Use `queryClient.invalidateQueries()` with `refetchType: 'inactive'`. Rejected because it starts hidden work, the opposite of the acceptance goal.
- Invalidate only the visible route. Rejected because hidden cached results would remain falsely fresh after their inputs changed.
- Clear affected queries instead of marking them stale. Rejected because it discards useful last-known data and creates loading flashes on return.
- Keep the `^NSEI` default and update only Wealth Journey. Rejected because another future no-argument call could silently recreate the same fourth cache variant.

## Milestones

### 1. Granular invalidation contract

Add the pure prefix mapper and visible-route refetch helper with transaction, NAV, index, drift-rebuild, and no-change tests.

Expected outcome: a NAV-only result never touches Money Trail; a transaction result covers every transaction-derived family; About/unknown routes refetch nothing.

Run:

    npm test -- --runInBand src/lib/__tests__/syncInvalidation.test.ts

Acceptance: every invalidation uses `refetchType: 'none'`, visible refetches are an affected-prefix subset, and hidden routes issue zero refetch calls.

### 2. Freeze and focus gates

Freeze heavy tabs and Settings screens, add reusable hook options, and apply focus gates to Portfolio, Funds, Wealth Journey, Settings, and Fund Detail.

Expected outcome: navigating away disables all expensive screen-owned queries while cached data remains available for rendering on return.

Run:

    npm test -- --runInBand scripts/__tests__/navigation-n3-config.test.ts
    npm run typecheck
    npm run lint

Acceptance: config tests lock all required freeze flags and no-argument `usePortfolio()` calls remain.

### 3. Root integration and native evidence

Wire both bootstrap and foreground SyncResults through granular invalidation, run full validation, publish Android main-preview, and capture required navigation sequences.

Expected outcome: Settings → About and Funds → Fund Detail remain responsive; no hidden Portfolio/timeline query starts after blur; visible routes refresh correctly after sync.

Run:

    npm test -- --runInBand
    npm run typecheck
    npm run lint
    npx expo export --platform android --output-dir /tmp/foliolens-n3-android-export
    git diff --check

Acceptance: all checks pass and Android logs identify OTA/SHA, route timings, sync overlap, query starts after blur, and SQLite errors.

## Validation

Automated evidence must prove:

- NAV-only sync excludes `money-trail`, `user-transactions`, and Wealth Journey transaction derivation;
- transaction sync invalidates the fund roster, raw transactions, portfolio, Money Trail, Fund Detail, investment input/output, portfolio/performance timelines, and Wealth Journey derivation;
- index-only sync excludes transaction and NAV-only families;
- drift repair is treated as a transaction change;
- no-change/error-only results trigger no invalidation;
- every affected entry is marked stale with `refetchType: 'none'`;
- About and unknown routes refetch no hidden queries;
- visible Portfolio/Funds/Wealth/Settings/Fund Detail routes refetch only their affected active prefixes;
- all required freeze flags remain configured;
- Wealth Journey and onboarding create no legacy `^NSEI` portfolio query.

Native evidence must record device/OS, package/channel, OTA/update ID, implementation SHA, Settings → About and Funds → Fund Detail commit/usable timings, any concurrent sync, all query starts after the owner screen blurs, and relevant SQLite errors. Evidence must distinguish stale-only invalidation from visible-route refetch and must not claim the original intermittent hang is reproduced if it is not.

Automated validation completed on 2026-07-03:

- focused N3 and lifecycle suites: 3 suites, 37 tests passed;
- full Jest suite: 83 suites, 1,863 tests passed;
- `npm run typecheck`: zero errors;
- `npm run lint`: zero warnings;
- Android Expo export: completed successfully with a Hermes bundle;
- `git diff --check`: clean.

## Risks And Mitigations

- **Under-invalidation:** encode the dependency map in one exported constant, test every input family, and include user-funds for CAS roster correctness.
- **Over-invalidation:** use one-element prefixes only for genuinely dependent families and assert exclusions for NAV-only and index-only changes.
- **Visible data stays stale:** explicitly refetch the visible route's affected active prefixes after stale-only invalidation.
- **Lifecycle listener churn:** store pathname in a ref rather than adding it to the lifecycle installation effect dependencies.
- **Hidden query still active:** pass focus through every screen-owned reusable hook and add source/config regression tests.
- **Cache contract drift:** change only `enabled`; keys and payloads remain stable, so no buster bump is required.
- **Legacy benchmark recurrence:** remove the default parameter so TypeScript rejects no-argument calls.

## Decision Log

- 2026-07-03: Start N3 immediately from N0 merge `30390544`; coordinator table state is not a gate.
- 2026-07-03: Use stale-only prefix invalidation plus visible-route refetch instead of relying on React Query's active/inactive classification.
- 2026-07-03: Treat transaction drift repair as a transaction input change and include `user-funds` for CAS roster correctness.
- 2026-07-03: Focus-gate Fund Detail as well as the four named tab families because previously visited detail observers were part of finding 1.
- 2026-07-03: Focus-gate Fund Detail composition and Settings cache-debug AsyncStorage inspection too; both can remain mounted after navigation and are screen-owned work even though sync does not invalidate them.
- 2026-07-03: Require an explicit TRI benchmark at every `usePortfolio` call site.

## Amendments

Implementation also focus-gates Money Trail and Portfolio Insights root screens. They are not frozen tab screens, but they can remain mounted in the root stack and own the same expensive transaction, portfolio, and composition queries. This extends the same hidden-work invariant without changing their cache keys, payloads, or user-visible behavior.

The source-level navigation configuration test covers every Settings child that owns a query plus Fund Detail. Behavioral invalidation tests remain provider-independent and assert exact React Query calls, while the existing hook and screen suites cover rendering contracts.

## Progress

- [x] Read AGENTS.md, VISION.md, docs/SCREENS.md, docs/architecture/cache-surfaces.md, the updated control report, and later PR #250 comments.
- [x] Verify N0 merge on `origin/main` and create `codex/n3-hidden-screen-work` from `30390544`.
- [x] Record the N3 design and validation contract in this ExecPlan.
- [x] Add granular invalidation helper and tests.
- [x] Freeze required screens and add focus-aware query options.
- [x] Remove the legacy `^NSEI` default and update callers.
- [x] Integrate visible-route invalidation into root lifecycle.
- [x] Run focused, full, static, and Android export validation.
- [ ] Capture Android main-preview acceptance evidence.
- [ ] Push and open draft implementation PR.
