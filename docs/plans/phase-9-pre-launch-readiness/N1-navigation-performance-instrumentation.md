# Navigation N1 Performance Instrumentation

## Goal

Build a reliable, privacy-safe measurement harness for the navigation transitions reported as slow, without changing navigation scheduling, query behavior, or screen output.

## User Value

FolioLens currently has plausible causes for intermittent tap stalls but no trustworthy native release timing that separates tap handling, route commit, and post-animation usability. This milestone makes those delays observable so later remediation can be measured rather than inferred.

## Context

PR #250 is the unmerged control plane for the performance-remediation program. Queue 1 requires Navigation N1 before any behavior changes. The current `src/lib/perfMark.ts` stores starts in a map keyed only by label. Concurrent work with the same label overwrites the earlier start, which makes portfolio and prefetch timings unreliable. The app uses Expo Router, React Query, native SQLite synchronization, and a PostHog analytics facade.

The required route pairs are Portfolio to Settings, Settings to About, Portfolio or Funds to Fund Detail, and bottom-tab switches. Each measured navigation needs a press-to-route-commit duration and a press-to-post-interaction-usable duration. Context may include normalized route names, cache warmth, whether a database sync is active, and aggregate row counts. It must not contain fund names, database identifiers, transaction details, authentication data, or user personally identifiable information.

## Assumptions

- `InteractionManager.runAfterInteractions` is the repository's accepted signal that the navigation animation and queued interactions have drained; it is a proxy for "usable," not a frame-level rendering guarantee.
- A React effect observing the normalized Expo Router pathname runs after the destination route commits.
- React Query cache state can be sampled synchronously at press time without triggering a fetch.
- N1 records baseline measurements but does not optimize the measured transitions.
- PR #250's research branch remains separate and is neither merged nor cherry-picked into this branch.

## Definitions

- A span is one timed operation with a unique identifier, start time, label, and optional completion metadata.
- Route commit is the first committed React render in which Expo Router reports the expected normalized destination.
- Post-interaction usable is the first callback after React Native reports that active interactions have completed.
- Cache state is `warm` when the relevant React Query entry already contains data, `cold` when no relevant cached data exists, and `unknown` when the transition has no meaningful query-key probe.
- Sanitization is an allowlist transformation that discards all metric properties except approved low-cardinality fields and bounded aggregate counts.

## Scope

- Change `perfStart` to return a unique span ID and change `perfEnd` to close that ID.
- Migrate every existing performance span call site.
- Add a reusable Expo Router navigation measurement manager and route observer.
- Instrument the four required transition families at their press entry points.
- Capture cache warmth, sync-active state, and available aggregate row counts.
- Emit concise development logs and sanitized PostHog events.
- Add unit tests for same-label concurrency, lifecycle behavior, route normalization, and metric sanitization.
- Document repeatable Android and iOS release-build baseline collection.
- Update README capability documentation.

## Out of Scope

- Cancelling, delaying, or changing prefetches.
- Freezing screens, changing query focus gates, or changing invalidation.
- Deferring FeedbackSheet or any route module.
- Changing navigation animations, route structure, or data fetching.
- Establishing the final performance target; later milestones use the collected baseline.

## Approach

`perfStart` will allocate a monotonic process-local ID and store each span independently. `perfEnd` will accept only that ID, remove exactly one start, and emit the existing `perf_mark` event. Existing call sites will retain their current labels and metadata but keep the returned ID until completion.

A pure navigation manager will own pending navigation attempts. Press handlers provide normalized source and destination names plus optional low-cardinality context. The manager creates two spans per attempt. A root observer watches the current pathname, closes the route-commit span when the expected route appears, then closes the usable span through `InteractionManager.runAfterInteractions`. Starting another attempt does not overwrite an existing attempt because every attempt and span has its own ID.

The navigation event payload will be built through an exported allowlist sanitizer. Route values will be mapped to a fixed vocabulary. Counts will be finite, non-negative integers and capped to avoid accidental high-cardinality values. Unknown keys, IDs, names, free text, URLs, and user data will be discarded before any PostHog call.

## Alternatives Considered

- Key starts by label plus a counter. This still forces callers to reconstruct the correct counter and is less safe than returning an opaque ID.
- Measure only with Expo Router route events. That omits the user-perceived delay before commit and cannot reliably associate concurrent presses.
- Put raw pathnames and full query keys in analytics. Dynamic fund IDs and query values would create privacy and cardinality problems, so fixed route names and aggregate cache context are required.
- Change navigation or fetching while adding measurements. This would contaminate the baseline and violates N1 scope.

## Milestones

### Milestone 1: Unique span lifecycle

Change the timing API and migrate all call sites. Run:

    npm test -- --runInBand src/lib/__tests__/perfMark.test.ts
    npm run typecheck

Expected outcome: concurrent spans with the same label close independently and every existing call site typechecks with an explicit span ID.

Acceptance criteria:

- `perfStart` returns a unique opaque ID.
- `perfEnd` closes only the supplied ID.
- Missing or already-closed IDs return `-1` without emitting analytics.
- Existing query and sync labels remain unchanged.

### Milestone 2: Navigation transition measurement

Add the reusable manager, root observer, and press-point instrumentation. Run:

    npm test -- --runInBand src/lib/__tests__/navigationPerformance.test.ts
    npm run typecheck

Expected outcome: the required route pairs produce both commit and usable measurements with privacy-safe context.

Acceptance criteria:

- Portfolio to Settings, Settings to About, Portfolio or Funds to Fund Detail, and bottom-tab switches are covered.
- Each attempt creates press-to-commit and press-to-usable spans.
- Route commit closes only when the expected normalized destination is observed.
- The usable span closes after `InteractionManager` completes.
- Cache state, sync state, and available row counts are sampled without starting a query.
- Only allowlisted sanitized properties reach analytics.

### Milestone 3: Baseline runbook and final validation

Document exact release-build collection steps and run repository checks:

    npm run typecheck
    npm run lint
    npm test -- --runInBand src/lib/__tests__/perfMark.test.ts src/lib/__tests__/navigationPerformance.test.ts

Expected outcome: another engineer can collect comparable warm and cold samples on Android and iOS and locate both log and PostHog evidence.

Acceptance criteria:

- The runbook identifies build profile, update/build ID, device model, OS version, warm/cold setup, repetitions, log filters, and fields to record.
- TypeScript reports zero errors.
- ESLint reports zero warnings.
- Focused tests pass.

## Validation

Automated validation covers unique same-label spans, missing and duplicate completion, sanitized fields, dynamic pathname normalization, cache/count normalization, and pending-navigation lifecycle. Static validation covers all migrated call sites and React hook dependency arrays.

Native release evidence must use physical Android and iOS devices where available. For each required route family, collect at least ten warm samples and five cold samples, record median and p95 for both durations, note whether sync was active, and retain the exact build or EAS update ID. If an iOS physical device or signing access is unavailable, record that limitation explicitly rather than substituting simulator development timings as acceptance evidence.

## Risks And Mitigations

- A destination may never commit after a press. The manager expires stale attempts so abandoned navigation does not leak memory or close a future unrelated route.
- Double taps may create overlapping attempts. Unique attempt/span IDs preserve both; the destination commit closes every compatible press independently.
- Raw routes may contain fund IDs. Route normalization maps any `/fund/<value>` pathname to `fund_detail` before event creation.
- Aggregate counts could be malformed. The sanitizer rejects non-finite/negative values and caps accepted integers.
- Instrumentation could accidentally trigger data work. Cache context reads only existing QueryClient state and never calls fetch or prefetch methods.

## Decision Log

- 2026-07-01: Use a root Expo Router pathname observer for route commit because it measures after React commit and avoids modifying destination business logic.
- 2026-07-01: Use `InteractionManager.runAfterInteractions` for the second timing because the repository already uses it to defer chart work until navigation settles.
- 2026-07-01: Keep navigation payloads behind a strict allowlist instead of applying a denylist to arbitrary metric metadata.
- 2026-07-01: Keep PR #250 unmerged and branch N1 directly from `origin/main` at `df5f746d907250fa5dfeb9aedede6135cc511ab1`.
- 2026-07-01: Track sync activity with a nested counter around both high-level scope derivation and low-level sync. Inferring it only from emitted `db:sync:*` spans would miss the initial fund-roster fetch.

## Amendments

Implementation stayed inside N1 scope. Two details were sharpened from the initial approach:

- The cache snapshot includes `active_query_count`, matching the control report's requirement in addition to the prompt's warm/cold and row-count fields.
- Sync-in-flight uses an idempotent counter in `performanceRuntimeState.ts` rather than inferring from timed sync spans, so the signal covers the whole orchestration. This changes no sync order, query, or data behavior.

Validation completed on 2026-07-01:

- `npm run typecheck` — passed with zero errors.
- `npm run lint` — passed with zero warnings.
- Focused perf/navigation/sync tests — 36 passed.
- Full Jest suite — 76 suites and 1,795 tests passed.
- Android production export — passed, 1,745 modules, 6.2 MB Hermes bundle.
- iOS production export — passed, 1,732 modules, 6.2 MB Hermes bundle.
- No Android device or booted iOS Simulator was attached. The managed Expo checkout has no generated Xcode project, so physical release p50/p95 samples are intentionally deferred to the documented EAS-installed-device run rather than replaced with development timings.

## Progress

- [x] Read AGENTS.md, VISION.md, the control report, and PR #250 conversation.
- [x] Create `codex/n1-navigation-performance-instrumentation` from current `origin/main`.
- [x] Implement unique performance span IDs and migrate call sites.
- [x] Implement sanitized navigation attempt management and route observation.
- [x] Instrument all required route-pair press points.
- [x] Add focused tests.
- [x] Add the native release baseline runbook and README note.
- [x] Run validation and record results.
- [x] Add Amendments for the active-query and sync-state implementation details.
- [ ] Publish the draft N1 PR and attach acceptance evidence.
