# Navigation N2 Transition Contention

## Goal

Prevent speculative portfolio and investment-timeline work from starting after the user leaves Portfolio, and stop Fund Detail from starting a second full portfolio aggregation merely to render portfolio weight.

## User Value

Opening Settings, About, or Fund Detail should not compete with invisible benchmark calculations left behind by Portfolio. Benchmark changes should remain responsive because the app starts the exact requested work at the user interaction boundary instead of calculating every alternative in advance.

## Context

PR #250 is the unmerged control plane for the performance-remediation program. Navigation N1 merged through PR #251 and added privacy-safe press-to-route-commit and press-to-post-interaction-usable measurements. N2 is Queue 2 and is the first behavior-changing milestone.

`usePortfolio` currently starts full portfolio calculations for every alternate benchmark as soon as the active result arrives. `useInvestmentVsBenchmarkTimeline` starts a delayed alternate-benchmark queue after 1.2 seconds, and the Portfolio screen separately primes its active timeline. Expo Router keeps tab screens mounted, so those effects can run after Portfolio loses focus and contend with a quick Portfolio to Settings to About transition.

Fund Detail's Portfolio Weight card currently calls `usePortfolio` again. That call observes or starts the full portfolio query and also arms the alternate-benchmark prefetch effect. The card only needs allocation and rank values that already exist in the cached Portfolio result reached from Funds.

The post-N1 Android main-preview evidence recorded on PR #250 measured first-visit Settings to About at 59 ms in the user-driven run and 84 ms in the canonical physical smoke. That does not show a material eager `FeedbackSheet` route-evaluation cost, so N2 will not add lazy feedback loading without evidence.

## Assumptions

- The Portfolio and Funds routes normally populate the active Portfolio React Query entry before Fund Detail opens.
- If Fund Detail is deep-linked without a cached Portfolio result, hiding Portfolio Weight is safer than starting a second full aggregation during the route transition.
- `useIsFocused` from Expo Router reflects blur while a tab remains mounted.
- A targeted prefetch can safely be called more than once because React Query deduplicates an in-flight query and honors fresh cached data.
- Android main-preview is the native acceptance target because FolioLens has no Apple Developer account or current iOS distribution path.

## Definitions

- Speculative prefetch means work started before the user selects the corresponding benchmark.
- Targeted prefetch means warming exactly one benchmark because its pill received press, pointer-hover, or keyboard-focus intent.
- Cache-only selector means a read-only subscription to React Query's existing cache that cannot initiate a fetch when the entry is missing or stale.
- No-intent behavior means leaving Portfolio focused without pressing, hovering, or keyboard-focusing another benchmark starts no alternate benchmark work at any later time.

## Scope

- Remove `usePortfolio`'s eager loop over all alternate benchmarks.
- Add reusable targeted Portfolio and timeline prefetch functions.
- Extend benchmark pills with press-in, hover, and focus intent handlers and warm the exact portfolio/timeline combination.
- Focus-gate the Portfolio active-timeline prime and remove the delayed alternate-timeline queue entirely.
- Cancel delayed timeline timers on blur and prevent completion of an in-flight item from scheduling another item after blur.
- Replace Fund Detail's second `usePortfolio` call with a cache-only allocation selector.
- Add focused tests for no-intent behavior, targeted benchmark behavior, and the cache-only Fund Detail selector.
- Use N1 measurements and Android release-like evidence to validate Settings to About and Funds to Fund Detail.

## Out of Scope

- Shared SQLite write serialization and timeline cache repair; those are N2D.
- Timeline input reuse, early date bounding, or financial computation changes; those are N2T.
- Broad hidden-screen query disabling or granular invalidation; those are N3.
- Splitting benchmark-independent Portfolio core computation; that larger refactor remains N7.
- Session-provider consolidation, list virtualization, or Fund Detail chart/module decomposition.
- Lazy FeedbackSheet loading without material N1 evidence.

## Approach

Create small exported prefetch helpers beside the existing query fetchers so screens and tests use the same query keys, stale times, and query functions as the active hooks. The active Portfolio screen will call both helpers when a non-active benchmark pill receives intent. This keeps the selected benchmark responsive without warming all alternatives on mount.

Read focus state inside Portfolio variants. The screen's active-key timeline prime runs only while focused. Delete the alternate-timeline effect and its queue so neither Portfolio nor Fund Detail can start unselected benchmark work from mount or elapsed time. Both screens use targeted benchmark intent handlers only.

Add a read-only `QueryCache` subscription for the active Portfolio key that selects the target fund's percentage and rank from existing `fundCards` and `summary`. It does not mount a query observer or provide a query function, so a missing cache entry produces no card instead of a full portfolio aggregation. Fund Detail will use this selector and remove its `usePortfolio` call.

## Alternatives Considered

- Remove all prefetching. This guarantees no speculative work but makes a deliberately selected benchmark cold. Targeted interaction prefetch preserves responsiveness with bounded work.
- Keep the Portfolio eager loop but delay it. A delay still races navigation unless it is focus-aware, and calculating every alternative remains unnecessary.
- Pass portfolio total and rank through route parameters. That duplicates derived financial display state in navigation URLs and becomes stale after refresh. Reading the existing query cache keeps one source of truth.
- Fetch a lightweight total directly in Fund Detail. Even a smaller fetch adds route-transition work and a new data contract. The prior Funds screen already has the exact derived result.
- Lazy-load FeedbackSheet now. Current first-visit About evidence is healthy, so doing so would claim an unmeasured win and expand N2.

## Milestones

### Milestone 1: Focus-safe and targeted benchmark work

Remove eager alternate Portfolio/timeline prefetch, add exact-key prefetch helpers, wire benchmark intent handlers, and focus-gate only the active-key timeline prime.

Run:

    npm test -- --runInBand src/hooks/__tests__/usePortfolio.test.ts src/hooks/__tests__/useInvestmentVsBenchmarkTimeline.test.ts
    npm run typecheck

Expected outcome: leaving Portfolio idle starts no alternate work, while a benchmark pill starts only that benchmark's Portfolio and timeline prefetch.

Acceptance criteria:

- Portfolio to Settings to About produces no later alternate Portfolio or timeline query start.
- A focused Portfolio left idle beyond the former 1.2-second boundary starts no alternate timeline.
- Mounting Portfolio does not fetch every alternate Portfolio benchmark.
- Press, hover, or focus on one benchmark pill warms exactly that benchmark.

### Milestone 2: Cache-only Fund Detail portfolio weight

Replace the Portfolio Weight card's `usePortfolio` call with a read-only selector over the existing active Portfolio cache entry.

Run:

    npm test -- --runInBand src/hooks/__tests__/usePortfolio.test.ts
    npm run typecheck

Expected outcome: Funds to Fund Detail does not start `query:portfolio` or arm Portfolio alternate prefetches, while a warm cache renders the same percentage and rank.

Acceptance criteria:

- The selector returns allocation and rank from a populated cache.
- A missing cache does not run `fetchPortfolioData`.
- Fund Detail contains no `usePortfolio` call.

### Milestone 3: Validation and native evidence

Run focused and repository checks, publish an Android main-preview update at the implementation SHA, and capture N1 logs for Settings to About and Funds to Fund Detail.

Run:

    npm run typecheck
    npm run lint
    npm test -- --runInBand
    git diff --check

Expected outcome: automated checks pass, no post-blur speculative query starts appear, and Fund Detail does not start another full Portfolio aggregation.

Acceptance criteria:

- TypeScript has zero errors and ESLint has zero warnings.
- Focused cancellation, benchmark, and selector tests pass.
- Android release-like logs identify the update ID and implementation SHA.
- The evidence records route commit and post-interaction usable time plus query starts during the observation window.

## Validation

Automated tests retain fake timers beyond the former 1.2-second boundary and prove that creating the targeted handler without invoking it starts no work. A single invocation must warm exactly the selected symbol, and a blurred/disabled handler must do nothing. Cache-selector tests verify percentage/rank equivalence and empty-result behavior; static inspection verifies the hook uses only `getQueryData` plus `QueryCache.subscribe`, with no query function or fetch call.

Native evidence will use the connected Pixel 8a running the main-preview Android package. For Portfolio to Settings to About, clear logs, open Portfolio, navigate through About within 1.2 seconds, then observe at least another two seconds for delayed `query:portfolio` or `query:timeline` starts. For Funds to Fund Detail, capture N1 navigation metrics and assert no second `query:portfolio` starts and no two-alternate benchmark sequence is armed. Record the update ID, Git SHA, device/OS, cache state, timing, and limitations.

## Risks And Mitigations

- A second React Query observer on the Portfolio key could replace shared fetch options. Avoid an observer entirely; subscribe to QueryCache and read `getQueryData` only.
- Hover and focus can both fire for one pointer action. React Query deduplication and stale-time checks make repeated exact-key prefetch calls safe.
- Focus state can change after a targeted prefetch starts. N2 prevents new intent work once blurred but does not abort a fetch already chosen by the user; AbortSignal-aware cancellation belongs to a later milestone if measurements require it.
- Direct Fund Detail entry may lack cached allocation. Hide the nonessential Portfolio Weight card rather than delaying the primary route.
- Desktop and mobile Portfolio variants can drift. Both use the same exported prefetch helpers and shared benchmark card contract.

## Decision Log

- 2026-07-01: Branch N2 from `origin/main` at `53e57f58`, after the coordinator marked N2 Ready to start.
- 2026-07-01: Initial implementation retained a focus-gated timeline idle queue while replacing Portfolio's immediate all-alternative loop.
- 2026-07-01: Use a read-only QueryCache subscription for Fund Detail allocation. This cannot fetch and cannot replace the existing Portfolio query's options.
- 2026-07-01: Exclude FeedbackSheet deferral because Android first-visit About measurements of 59-84 ms do not demonstrate material route-evaluation cost.
- 2026-07-01: Use Android main-preview as native acceptance evidence; iOS publishing/signing is unavailable and the blocker is recorded on PR #250.
- 2026-07-01: Mark PR #252 `[cache-shape-stable]`. N2 retains the existing Portfolio and investment-timeline query keys and serialized payloads; it changes only when prefetches run and reads an existing Portfolio result without adding a persisted cache entry. Bumping `__BUSTER__` would discard valid user caches.
- 2026-07-01: First review removed Fund Detail from the idle queue after physical evidence showed two unselected timeline calculations.
- 2026-07-01: Independent Codex and Claude review then clarified the prompt requires targeted prefetch instead of all automatic alternate work even while Portfolio remains focused. Delete the queue mechanism and make targeted intent the only alternate-benchmark entry point.

## Amendments

The implementation follows the planned scope with one safety refinement: the initial design proposed a disabled React Query observer for Fund Detail. Review of React Query's shared-key behavior showed that even a disabled observer unnecessarily participates in query option management. The final implementation uses `useSyncExternalStore` over `QueryCache.subscribe` and reads the existing result with `getQueryData`, so it has no fetch path and cannot replace the active Portfolio query function.

FeedbackSheet remains eagerly imported because the N1 Android measurements showed healthy first-visit About usability at 59-84 ms. N2 therefore makes no unsupported bundle-evaluation claim.

The first physical Fund Detail trace confirmed the cache-only selector removed `query:portfolio`, but also showed the route's existing idle timeline queue calculating two unselected benchmarks. A second implementation disabled that queue for Fund Detail, but independent review correctly found focused Portfolio still ran the same speculative work. The final implementation removes the queue and its opt-in parameter entirely. The replacement helper has no timer or mount effect and can run only when a press/hover/focus handler invokes it.

Validation completed before native evidence:

- `npm run typecheck` passed with zero errors.
- `npm run lint` passed with zero warnings.
- Focused N2 tests passed: 3 suites and 29 tests.
- Full Jest passed: 77 suites and 1,805 tests.
- Android production export passed: 1,747 modules and a 6.2 MB Hermes bundle.
- `git diff --check` passed.

Preliminary Android physical evidence used a Pixel 8a running Android 16 with package `com.foliolens.app.prpreview`, app version/runtime `0.0.4`, and channel `foliolens-pr`. The tested Android OTA was `019f1eef-cd9e-79cf-9d2a-6472c0f4a6cb` at implementation head `40d345b0`. This proved post-blur and Fund Detail behavior but predates removal of focused Portfolio's idle queue and is not the final acceptance record. Per the coordinator/reviewer requirement, final evidence must use Android main-preview/release at the corrected implementation head.

Measured evidence:

- Focus was moved Funds → Portfolio, then Portfolio → Settings → About inside the 1.2-second idle window. Bottom-tab commit/usable was 45/46 ms, Portfolio → Settings was 110/112 ms, and Settings → About was 90/92 ms. No `query:portfolio`, `query:timeline`, `query:timeline:nav`, or `query:timeline:index` started before the four-second post-blur end marker.
- Funds → Fund Detail committed in 73 ms and was post-interaction usable in 78 ms. The selected fund's one active timeline completed in 187 ms; no `query:portfolio` and no two alternate timeline queries started during the six-second observation window.
- Selecting Mix & Weight rendered cached portfolio allocation, rank, and total value. No `query:portfolio` started during the 7.6-second observation window.
- Raw device logs remain local under `/tmp/foliolens-n2-android/`; PR evidence contains only sanitized route names, benchmark symbols, aggregate counts, durations, and update/build identifiers.

## Progress

- [x] Read AGENTS.md, VISION.md, docs/SCREENS.md, docs/process/PLANS.md, the current control report, and PR #250 conversation.
- [x] Create `codex/n2-cancel-transition-contention` from current `origin/main`.
- [x] Record N2 scope, evidence, and implementation decisions in this ExecPlan.
- [x] Implement focus-safe and targeted benchmark prefetch.
- [x] Implement the cache-only Fund Detail allocation selector.
- [x] Add focused tests.
- [x] Run repository validation.
- [ ] Capture final Android main-preview/release evidence at the corrected implementation SHA.
- [ ] Publish the implementation PR and attach acceptance evidence.
