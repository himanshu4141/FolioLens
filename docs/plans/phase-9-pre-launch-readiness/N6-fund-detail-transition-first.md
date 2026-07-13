# Navigation N6 — Fund Detail transition-first refactor

## Goal

Make Funds → Fund Detail feel immediate: render a useful hero from the already-cached fund card in the first post-navigation frame, prefetch the exact detail/history queries before navigation, and defer expensive chart/data work until navigation settles and its tab is selected.

## User Value

A user tapping a fund should see its name and current holding metrics immediately, keep a responsive back button while history loads, and avoid paying for charts or composition data they have not opened.

## Context

The accepted audit is read-only on `origin/codex/app-navigation-performance-audit`. Its section 6 identifies `app/fund/[id].tsx` as a 2,595-line route that imports chart libraries at route scope, waits for detail metadata before starting full NAV history, and mounts the default tab's chart work during the transition. N4 already replaced the Composition tab's second `usePortfolio()` call with `useCachedPortfolioWeight`; N6 preserves that improvement.

This branch is `program/n6-fund-detail-transition-first`, created from `origin/main` at N5 merge `fb7bbb1d919ec31ff5912cf8ff3eb3a7b382d022`. PR #250 is the mutable control plane. The research report must not be edited during N6.

## Assumptions

- Funds already has a `FundCardData` object containing every hero metric required for warm navigation.
- Deep links may lack a cached card and can show the existing loading shell while the detail query resolves.
- React Query prefetch must use the exact keys and query functions used by `useFundDetail` and `useFundNavHistory`; duplicate key construction is unacceptable.
- Full NAV history can start from `FundCardData.schemeCode` before scheme metadata finishes.
- Charts are not required in the transition frame and may wait for `InteractionManager.runAfterInteractions()`.

## Definitions

- Warm navigation: Funds data is already cached because the user arrived from the Funds screen.
- Cold deep link: Fund Detail opens directly without a cached portfolio fund card.
- Transition shell: header, back action, and hero metrics rendered without waiting for metadata/history/charts.
- Selected-tab isolation: only the active tab component is mounted, so unselected queries and chart effects do not execute.

## Scope

- Export canonical detail and NAV-history query keys/options plus one transition-prefetch helper from `src/hooks/useFundDetail.ts`.
- Start both prefetches on Funds row `onPressIn`, and again immediately before `router.push`, without awaiting either call.
- Add a stable cached-fund-card selector that observes React Query without mounting a second Portfolio query.
- Render the warm hero from cached `FundCardData`; progressively upgrade to `FundDetailData` when available.
- Gate Performance chart mounting until the route is focused and `InteractionManager` reports navigation work complete; cancel the gate on blur/unmount.
- Split Performance, NAV & Facts, and Mix & Weight into separate components/modules so inactive tabs do not mount their queries or chart work.
- Keep timeline `fundRef` inputs stable and prefetch focus-aware.
- Add deterministic tests for query-key identity/order, warm shell selection, cold entry, transition cancellation, selected-tab isolation, and back availability.

## Out of Scope

- Financial calculation, cache shape, persistence, query payload, database, or visual redesign changes.
- N7 portfolio computation deduplication beyond the already-shipped cached weight selector.
- N8 bundle/persistence/SDK cleanup and any research-report edit.

## Approach

Put query construction in exported pure helpers so hooks and event prefetch cannot drift. A `useFundDetailTransitionPrefetch` hook captures session, preview mode, and the shared QueryClient and returns a stable callback accepting `{ id, schemeCode }`. Funds rows receive that callback and call it on `onPressIn`; the navigation callback repeats it to cover keyboard/programmatic activation.

Add `useCachedFundCard(fundId)` beside `useCachedPortfolioWeight`. Its snapshot returns the existing `FundCardData` object from any cached `portfolio` query, so React's external-store contract receives a stable reference and no fetch begins. The route chooses full detail data when present and otherwise maps the cached card into the hero fields. Metadata-dependent tabs stay unavailable until detail data exists, but the back button and hero remain usable.

Move tab bodies into the `src/components/clearLens/fund-detail/` directory. The route owns only tab selection and shell composition. The Performance module owns its chart imports, queries, and derivations. The NAV & Facts module owns NAV charts/technical details. The Mix & Weight module owns composition and cached weight rendering. Conditional rendering ensures only one module mounts.

Use the existing Wealth Journey transition gate pattern: reset readiness on blur, schedule readiness with `InteractionManager.runAfterInteractions()` on focus, and cancel the task during cleanup. Performance receives `chartsReady`; before readiness it renders a lightweight card skeleton, not chart components.

## Alternatives Considered

- Awaiting prefetch before navigation was rejected because it delays the route transition.
- Seeding detail-query data with `FundCardData` was rejected because it is a different payload shape and could poison the query cache.
- Keeping all tab code in the route behind conditionals was rejected because chart imports and unrelated concerns would remain route-scoped.
- Fixed timeouts were rejected in favor of `InteractionManager`, which tracks navigation/animation work and supports cancellation.

## Milestones

### 1. Canonical query contract and warm-card selector

Export exact query-key/options builders, transition prefetch, and cached-card selection. Add pure tests proving preview/authenticated keys and both prefetches start without serial waiting.

Expected outcome: hooks and prefetch share one key contract; cached-card observation never starts a Portfolio query.

### 2. Prefetch from mobile and desktop Funds

Wire `onPressIn` and pre-navigation fallback for both row variants using stable ID/object callbacks. Preserve row memoization and navigation measurement.

Expected outcome: touch-down starts detail and full-history work before route push, with no await in the interaction path.

### 3. Transition shell and tab isolation

Render cached hero data on warm entry, preserve cold loading/error states, add the cancellable interaction gate, stabilize `fundRef`, and split tab bodies into modules.

Expected outcome: warm hero/back appear immediately; no chart mounts before readiness; only the selected tab executes its queries.

### 4. Validate and capture exact-head evidence

Run focused/full Jest, typecheck, zero-warning lint, and `git diff --check`. Capture responsive browser behavior plus exact-SHA Android evidence for warm tap, cold deep link, tab switching, and immediate back during in-flight history.

Expected outcome: PR evidence names device, channel, OTA/update ID, and exact runtime SHA and demonstrates no auth/SQLite/storage/fatal errors.

## Validation

Run:

    npm test -- --runInBand <N6 focused suites>
    npm run typecheck
    npm run lint
    npm test -- --runInBand
    git diff --check

The focused suite must prove canonical prefetch keys, parallel dispatch, warm/cold shell choice, transition cancellation, and selected-tab isolation. Native evidence must name the Pixel 8a, `foliolens-pr`, the exact OTA, and implementation SHA.

## Risks And Mitigations

- A partial hero object could be mistaken for `FundDetailData`. Keep it as a separate view model and never write it into the detail query cache.
- Query-key drift would make prefetch useless. Hooks and event handlers must call the same exported builders.
- `useSyncExternalStore` can loop if snapshots allocate. Return the cached `FundCardData` object itself, not a new wrapper.
- Interaction callbacks can fire after blur. Track cancellation and call `task.cancel()` in cleanup.
- Moving components can silently change styles. Move rendering/styles mechanically and verify light/dark mobile plus desktop.

## Decision Log

- 2026-07-06: Preserve existing financial/cache payloads; warm hero uses a separate cached-card view model.
- 2026-07-06: Start both detail and unbounded full NAV-history prefetches in parallel and never await them in navigation handlers.
- 2026-07-06: Reuse the shipped cached Portfolio weight selector; N6 will not reintroduce `usePortfolio()` in Composition.
- 2026-07-06: Use `InteractionManager`, not a timeout, as the chart readiness barrier.

## Progress

- [x] Read VISION, DESIGN, SCREENS, PLANS, N6 report section, and Prompt 6.
- [x] Create N6 branch from current `origin/main` and mark PR #250 In progress.
- [x] Add canonical query/prefetch and cached-card contracts with tests.
- [x] Wire mobile/desktop Funds prefetch.
- [x] Split the route into transition shell and isolated tab modules.
- [x] Run all validation and exact-head field evidence.

## Amendments

- The three selected-tab bodies are loaded with `React.lazy`, not only conditionally rendered. This keeps `react-native-gifted-charts` and `react-native-svg` out of the route module and delays each tab bundle until selection.
- `useCachedFundCard` reads the exact active Portfolio key for the current session, preview mode, and benchmark instead of scanning all Portfolio entries. This prevents a stale account or preview cache from supplying the warm hero while preserving the no-fetch contract.
- Entry-state selection is a pure tested contract. A cold terminal query error now wins over the loading fallback; the previous `data === undefined` ordering could leave an errored deep link on a spinner.
- Native cold-path validation exposed the related successful-null case (`fetchFundDetail` found no matching fund). The entry-state contract now treats a settled query with no detail or cached card as an error shell with a usable back action instead of an indefinite spinner.

## Validation Results

- Focused N6 suites: 4 suites, 72 tests passed.
- Full Jest: 91 suites, 1,932 tests passed.
- TypeScript: zero errors.
- ESLint: zero warnings with `--max-warnings 0`.
- `git diff --check`: clean.
- Exact-SHA Android evidence passed on the Pixel 8a; details are recorded below. Local web rendering reached the auth screen with safe placeholder environment values, but the sample portfolio now requires posting the demo-signup form. No personal email was transmitted, so responsive browser evidence remains a documented environment limitation rather than an acceptance claim.

## Exact-Head Android Evidence

- Device: physical Google Pixel 8a (`akita`), Android PR-preview application `in.foliolens.app.prpreview`.
- Runtime implementation: `aba8b6f4e36860f7e79d9c35c350f9c4393fda87`.
- Channel: `foliolens-pr`.
- Android OTA: `019f39eb-e71e-710d-8c14-c1ca2cc57430`.
- Workflow: green pre-PR run `28832069957`; its trace binds the OTA to the exact runtime SHA.
- About verification: visible prefix `019f39eb-e71…`; subsequent startup reported no newer update available.
- Warm Funds → Fund Detail: route commit/post-interaction usable measured 63/68 ms on one holding and 52/61 ms on another. The hero, `Go back`, tab controls, and Performance content were visible. The first run's detail/history work completed later (detail 131 ms; full SQLite NAV history 215 ms), proving route usability did not wait for either query.
- Deferred/back behavior: on a previously unopened holding, an on-device sequence tapped `Go back` 120 ms after the row tap. Funds was visible again while full detail continued and completed at 649 ms; NAV history completed at 137 ms. The transition remained responsive while metadata was in flight.
- Repeat navigation: reopening that holding measured 59/66 ms and emitted no Fund Detail or NAV-history query timing, confirming the warm cache path.
- Selected-tab isolation: Performance showed fund-value chart content; NAV & Facts showed Expense Ratio/AUM; Mix & Weight showed Top Holdings and Portfolio Weight. Content from the other tab modules was absent in each scoped UI dump.
- Cold/error path: direct deep link to a non-existent fund resolved in 50 ms to the visible `Couldn't load fund data` shell with a working `Go back`; back returned to the prior valid Fund Detail screen.
- Runtime health across the corrected evidence process: `fatal_or_unhandled=0`, `sqlite_errors=0`, `auth_errors=0`, `storage_errors=0`, and React Native error-level lines `=0`.
- Device hygiene: screen timeout restored from the temporary evidence value to its original `120000` ms.
