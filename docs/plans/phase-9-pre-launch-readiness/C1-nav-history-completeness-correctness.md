# C1 — Authoritative NAV-history completeness

## Goal

Repair the native NAV cache so historical financial views never treat a recent slice as complete history. The implementation must make the Portfolio “All” journey agree with bounded windows on overlapping dates, preserve legitimate pre-allotment cost marking for new fund offers (NFOs), and keep subsequent reads local once the requested upstream interval has been proven complete.


## User Value

A user must be able to trust every historical portfolio value shown by FolioLens. The current Android build can show Portfolio exactly equal to Invested for several years because missing historical NAV rows are silently replaced with cost basis. This hotfix prevents that failure, repairs affected device caches, and makes any future fallback observable.


## Context

The Android reproduction on 3 July 2026 used one account with 566 local transactions and 566 server transactions. The local NAV table contained 1,813 rows across 20 schemes: one closed scheme had 813 old rows ending in 2021, while most active schemes had only 56–57 recent rows ending on 2 July 2026. The Portfolio “All” journey accepted that combined cache and showed Portfolio equal to Invested from 2022 through 2025. Selecting 3Y rejected the recent-only interval, fetched 12,897 NAV rows from 26 June 2023, and produced a plausible 16 October 2023 portfolio value of ₹33,25,508 instead of cost.

The defect is in `src/hooks/useInvestmentVsBenchmarkTimeline.ts`. Its native read-through checks that every scheme appears, then validates only the globally earliest row, `cached[0].nav_date`. The old closed scheme satisfies that global check for every active scheme. `getTimelineValuation` then applies its intentional NFO fallback—cost basis when no NAV exists on or before a date—to live schemes whose older NAV rows are merely missing locally.

Two independent issue reviews on PR #250 confirmed this diagnosis:

- `[Codex issue review]` at issue comment 4878011636 confirmed the cache guard, provenance, stale derived-query risk, and a second correctness risk: multi-scheme PostgREST pagination orders only by non-unique `nav_date`, so offset pages can omit tied rows.
- `[Claude issue review]` at issue comments 4878020409 and 4878028445 confirmed the same root cause, narrowed the unaffected current-value path, and required an authoritative lower-bound marker so genuine NFO gaps do not trigger recurring remote reads.

The reviews agree that current Portfolio value, daily change, and 30-day sparklines are not wrong: `src/hooks/usePortfolio.ts` intentionally reads only recent NAV and does not perform historical per-date valuation. That path stays unchanged. The historical consumers `useInvestmentVsBenchmarkTimeline`, `useFundNavHistory`, and Compare’s five-year NAV metrics must nevertheless prove that their requested historical interval is authoritative before using SQLite.


## Assumptions

- Supabase `nav_history` remains the source of truth; SQLite is discardable and append-only.
- A successful remote query is authoritative for its requested lower bound even when a scheme has no row until a later allotment date.
- Existing `sync_state` storage can hold per-scheme coverage markers without a SQLite schema change.
- The Android PR-preview app and paired Pixel 8a remain the native acceptance target. iOS is out of scope.
- The performance queue remains paused until this PR is merged with accepted native evidence and two exact convergence comments.


## Definitions

- **Coverage lower bound:** the earliest date for which a completed upstream query proved that the local cache contains every available NAV row for a scheme. An unbounded fetch records full-history coverage.
- **Exposure interval:** the dates during which a scheme has positive units and therefore needs NAV valuation. A fully redeemed scheme does not need recent NAV after its units reach zero.
- **Known pre-allotment gap:** a date after the authoritative coverage lower bound but before the first upstream NAV. Cost basis is correct for this gap.
- **Unexpected coverage miss:** a cost fallback reached without authoritative coverage for the scheme/date. Acceptance requires zero.


## Scope

- Persist and query authoritative per-scheme NAV coverage lower bounds in SQLite’s existing `sync_state` table.
- Make bootstrap backfill full per-scheme history when no full-history marker exists, even if a recent NAV watermark already exists.
- Validate timeline SQLite input per scheme against the required exposure interval; fetch and repair remotely on unknown or insufficient coverage.
- Use deterministic `nav_date`, then `scheme_code`, ordering for every paginated multi-scheme NAV query.
- Invalidate/remove stale `investmentTimelineInputs` and `investmentVsBenchmarkTimeline` siblings immediately after a timeline repair so All→3Y→All agrees in one session.
- Make Fund Detail full-history reads reject non-empty but unproven SQLite slices.
- Make Compare’s five-year metrics reject non-empty but unproven SQLite slices and use its authoritative remote month-end fallback until SQLite coverage is established.
- Normalize the shared `month_end_nav` provider response to ascending, finite `NavPoint` values so Past SIP and non-local Compare calculations cannot consume the deployed RPC’s descending rows.
- Surface coverage status in Cache Debug.
- Emit separate sampled valuation counts for known cost fallback and unexpected coverage miss.
- Add deterministic tests for partial mixed histories, NFO gaps, pagination ordering, cache invalidation, and affected historical consumers.
- Validate Portfolio journey, Fund Detail history, Compare metrics, current Portfolio summary, Money Trail, and Past SIP Check on Android.


## Out of Scope

- Changing the current-value/recent-NAV read in `usePortfolio`.
- Reworking portfolio arithmetic, benchmark simulation, transaction normalization, or XIRR formulas.
- Redesigning charts or changing chart sampling.
- Production deployment or iOS validation.
- General index-cache redesign. The timeline uses the canonical full index snapshot; the current-value benchmark path is audited and documented but changed only if tests demonstrate an analogous incomplete-start failure.


## Approach

Use a `nav-coverage:<schemeCode>` row in `sync_state`. Row presence proves that a remote query completed. `watermark_date` stores the authoritative requested lower bound; `null` means an unbounded/full-history fetch. Coverage updates are monotonic: full history remains full, and bounded lower bounds only move earlier. Write the marker only after all remote pages complete and their rows are durably inserted. A successful empty interval still records coverage, which makes genuine NFO pre-allotment gaps local-only on the second read.

For the Portfolio journey, derive the earliest needed date for each scheme from normalized transactions and the selected window. Ignore schemes with no positive-unit exposure in that window. If every required scheme has a coverage marker at or before its required date, read SQLite. Otherwise fetch the incomplete schemes from the earliest missing lower bound, order pages by `nav_date` plus `scheme_code`, insert the result, and record coverage for every requested scheme—including schemes with no rows in the interval.

For root bootstrap, any scheme without a full-history marker receives one unbounded fetch regardless of its latest watermark. This repairs devices already poisoned by recent-only `usePortfolio` writes. Once full coverage exists, normal watermark-based delta sync resumes.

For Fund Detail, a local non-empty history is usable only with a full-history marker. Otherwise fetch the complete upstream history, insert it, then mark full. For Compare, a five-year local slice is usable only when coverage reaches the five-year lower bound; otherwise use the existing month-end upstream query. The recent-only `usePortfolio` writer remains valid but never creates a historical-coverage marker.

After a timeline repair, remove stale sibling prepared-input and output entries while preserving the currently executing window. This avoids displaying a persisted wrong All result during background refetch and satisfies same-session overlap consistency.


## Alternatives Considered

- **Check the earliest cached row per scheme without a marker.** This catches the reported bug but refetches forever for legitimate NFO gaps because the first real NAV can be weeks after the first holding date.
- **Treat row count or latest watermark as completeness.** Neither proves historical lower-bound coverage; this is the current failure mode.
- **Clear the whole NAV table and rebuild.** Correct but unnecessarily destructive, expensive on every upgrade, and opens a worse failure mode if the network drops mid-rebuild.
- **Bump the SQLite schema.** Not required because `sync_state.scope` is already free-form and cleared on sign-out. Avoiding a schema reset preserves valid cached data while the marker-driven repair fills only missing history.
- **Fix only the visible All chart.** Rejected because Fund Detail and Compare independently accept any non-empty local history as complete.


## Milestones

### Milestone 1 — Coverage contract and deterministic I/O

Add reusable per-scheme coverage helpers, monotonic marker writes, exposure-lower-bound derivation, and deterministic multi-scheme remote ordering. Update root bootstrap to perform one full repair for schemes lacking full coverage.

Run:

    npm test -- --runInBand src/lib/db/__tests__/repos.test.ts src/lib/db/__tests__/sync.test.ts

Acceptance: markers distinguish absent, bounded, and full coverage; an existing recent-only scheme is fully fetched once; a second bootstrap uses the watermark path; page builders order by both date and scheme.


### Milestone 2 — Historical consumer correctness

Apply coverage checks to the investment journey, Fund Detail, and Compare. Add immediate sibling-query eviction/invalidation after repair and cost-fallback telemetry.

Run:

    npm test -- --runInBand src/hooks/__tests__/useInvestmentVsBenchmarkTimeline.test.ts src/hooks/__tests__/useFundDetail.windowed.test.ts src/lib/db/__tests__/repos.test.ts

Acceptance: mixed closed/live partial cache is rejected and repaired; an authoritative NFO gap marks to cost and performs no second remote read; All→3Y→All cannot reuse the stale All input/output; Fund Detail and Compare reject unproven slices; unexpected coverage fallback is zero.


### Milestone 3 — Repository validation and documentation

Update `docs/architecture/cache-surfaces.md`, add this plan’s amendments/progress, and run the complete required validation.

Run:

    npm run typecheck
    npm run lint
    npm test -- --runInBand

Acceptance: zero type errors, zero lint warnings, and all tests pass. The cache inventory documents marker semantics, sign-out behavior, invalidation, pagination ordering, and bug-taxonomy coverage.


### Milestone 4 — Android correctness evidence

Publish the exact implementation SHA to the Android PR-preview channel, apply it to the paired Pixel 8a, verify the About OTA prefix, and validate with the same account.

Capture:

- Cache Debug before/after repair: per-scheme row counts, coverage markers, transaction drift, SQLite errors.
- Portfolio All and 3Y tooltips on at least three overlapping dates; invested, portfolio, and benchmark must match within display rounding.
- A second All/3Y pass without another full-history fetch.
- Fund Detail full-history chart start/end and a representative historical value.
- Compare Funds five-year period/metric output on two held funds, repeated after navigation with no remote refetch.
- Current Portfolio value, today change, and XIRR before/after repair to prove the intentionally unchanged recent path remains stable except for normal market-data timing.
- Money Trail transaction totals and Past SIP Check representative output to confirm transaction- and direct-upstream paths remain stable.
- Privacy-safe perf/log evidence showing known NFO fallback count, unexpected miss count zero, and zero SQLite transaction/lock/full errors.

Acceptance: every affected historical view uses authoritative history; All and bounded windows agree; no recurring repair occurs; unaffected current and transaction-driven views remain stable.


### Milestone 5 — Independent review and merge

Open a draft implementation PR from current `origin/main`, keep implementation/evidence/fixes there, and post one implementation-link handoff on PR #250. Request independent `[Codex review C1]` and `[Claude review C1]` reviews after checks and Android evidence pass. Address every actionable thread with code or a reasoned response and test evidence. Reviewers own thread resolution.

Merge only after both exact `[Codex review C1] CONVERGED` and `[Claude review C1] CONVERGED` comments exist, required checks are green, actionable threads are reviewer-resolved, and corrected-head Android evidence is accepted. Fetch `origin/main`, verify the merge commit, post one `[Execution C1] MERGED` handoff on PR #250, then resume the first remaining performance milestone from current main.


## Validation

Automated validation covers marker monotonicity, sign-out cleanup through the existing `sync_state` wipe, partial-cache repair, NFO authoritative emptiness, deterministic pagination calls, query invalidation, and consumer fallback behavior. Native validation must use real account data because the reported failure depends on the interaction between one old redeemed scheme and many recent-only live schemes.

The transaction path is considered authoritative for this incident when Cache Debug shows local count equals server count and drift is zero; tests retain the existing global reconciliation contract. The timeline index path remains authoritative through the canonical full snapshot and must log index coverage reaching the first transaction date. Any observed index start gap expands this hotfix before review.


## Android Evidence

Final acceptance used Pixel 8a PR-preview OTA `019f2dc4-2424-7a71-9bcd-eee78d8fb21b` at exact implementation `1d716eeed790a9c388f64523cf189c142993c794`; About showed `019f2dc4-242…` on `foliolens-pr` dated 4 July 2026.

- Cache Debug showed 566 local and 566 server transactions, drift 0, and 51,972 NAV rows across 20 schemes with full-history markers. After Portfolio, Fund Detail, Compare, and Past SIP, the v10 React Query blob was 653.8 KB / 30 entries. Its listed families remained bounded outputs/lookups; raw `fund-nav-history`, `performance-timeline`, `index-snapshot`, `fund-detail`, and `fund-detail-index` arrays were absent. Auth occupied 3.2 KB and the onboarding draft was absent.
- Portfolio All and 3Y matched exactly at display precision on three overlapping dates: 3 June 2024 (`₹24,35,913 / ₹43,37,012 / ₹46,79,458` invested/portfolio/Nifty 500 TRI), 1 April 2025 (`₹34,20,426 / ₹53,35,851 / ₹54,04,671`), and 3 February 2026 (`₹44,72,728 / ₹71,43,115 / ₹71,02,194`). Repeating 3Y → All used the already-proven local inputs; no second NAV repair appeared.
- The intentionally unchanged current path remained `₹86.05L`, today `+₹16.8K (+0.20%)`, XIRR `15.29%`, NAV as of 3 July. A fresh Nifty 50 All output used 566 transactions, 34,336 NAV rows, 2,060 index rows, 91 evaluation points, 91 valuation-cache hits, one known NFO cost fallback, and zero unexpected fallbacks.
- DSP Small Cap Fund Detail remained `₹8.76L` on `₹7.46L` invested with 22.20% XIRR. NAV & Facts All spanned January 2013–July 2026: current `₹242.7430`, period start `₹17.6890`, change `+1272.28%`.
- Compare reproduced held-fund 5Y returns of 11.1% and 14.5% for DSP Aggressive Hybrid and DSP Large & Mid Cap; the revisit read 122 local NAV metric rows in 7 ms with no month-end remote refetch. Past SIP for DSP Aggressive Hybrid produced 60 monthly installments: `₹6.00L` invested, `₹7.77L` current value, `+₹1.77L (+29.4%)`, versus `₹6.16L` in Nifty 500 TRI.
- App-PID log scans across the matrix contained no SQLite, `catalystLocalStorage`, database-full, auth-lifecycle, or unexpected-coverage errors. The device screen timeout was restored to its original 120 seconds after capture.


## Risks And Mitigations

- **One-time repair is large.** Full history for 20 schemes can exceed 30,000 rows. Serialize writes through the existing database queue and report cold repair separately from warm reads.
- **NFO has no NAV near first holding.** Marker records the requested upstream lower bound, not the first returned row, so empty pre-allotment intervals are authoritative.
- **Marker written before rows.** Write rows first and marker second; marker failure causes a safe repeat, while row failure cannot create false completeness.
- **Stale persisted output survives repair.** Remove/invalidate both prepared input and derived output siblings immediately, and retain root-sync invalidation.
- **Offset pagination omits tied dates.** Add `scheme_code` as a deterministic secondary order and lock it with query-builder tests.
- **Performance regresses permanently.** Acceptance requires the second identical read to stay local. Only the first unknown interval pays the repair cost.
- **Scope expands into current Portfolio calculations.** Keep recent-only current-value code unchanged and prove stability with native before/after evidence.


## Decision Log

- 2026-07-03: Paused the performance queue because historical financial correctness outranks navigation performance work.
- 2026-07-03: Adopted the union of Codex and Claude issue reviews: exposure-aware per-scheme coverage, authoritative lower-bound markers, deterministic pagination, immediate derived-cache invalidation, NFO-safe telemetry, and same-session overlap evidence.
- 2026-07-03: Kept `usePortfolio` recent-value reads out of implementation scope, following both code inspection and Claude’s scope correction.
- 2026-07-03: Retained Fund Detail and Compare validation/repair because both independently treat a non-empty SQLite history as complete; this is directly testable even though neither caused the reported Portfolio tooltip.
- 2026-07-03: Reused `sync_state` rather than adding a table or bumping `SCHEMA_VERSION`; marker rows are user-scoped by the database lifecycle and existing sign-out wipe.
- 2026-07-03: Kept daily full history rather than monthly compaction. The observed 6 MB failure belongs to Android AsyncStorage’s `catalystLocalStorage`, not `foliolens.db`. A representative SQLite database with 34,299 NAV rows, the production primary key, and the secondary index occupied about 2.5 MB after checkpoint. Timeline valuation needs transaction-date/trading-date fidelity, while prepared timeline inputs remain in-memory and only the bounded 90-point output is persisted to AsyncStorage.
- 2026-07-04: Corrected the shared month-end provider contract after Android acceptance exposed 163 returned rows but zero usable Past SIP installments. The deployed SQL intentionally emits newest-first rows for `DISTINCT ON`; the client now sorts ascending and normalizes numeric values at the wrapper boundary. This also protects Compare’s upstream fallback.
- 2026-07-04: Rejected monthly compaction of canonical SQLite NAV history. Corrected-head Android logs proved the 6 MB failure was `catalystLocalStorage` (AsyncStorage), not `foliolens.db`; daily NAV fidelity remains required for transaction/trading-date valuation. The actual storage defect was version-suffixed React Query keys orphaning every old cache plus redundant persisted daily arrays.


## Amendments

- Compare’s existing bounded upstream month-end fallback remains non-persistent. It does not write a bounded slice or coverage marker into SQLite; root bootstrap or another full-history consumer establishes reusable local proof. This preserves the stronger invariant that a populated NAV table never implies completeness.
- Fund Detail returns successfully fetched remote rows even if its optional SQLite write fails, but it deliberately withholds the full-history marker in that case. The next read retries the repair instead of trusting an incomplete device cache.
- The implementation bumped the persisted React Query buster to v9 as a semantic correctness purge. No payload shape changed, but persisted pre-C1 timeline/Fund Detail values can be financially wrong and therefore cannot be retained through their normal TTL.
- Android acceptance on implementation `45ffa2b` found a second source-order bug rather than accepting partial evidence: `month_end_nav` returned 163 valid monthly rows newest-first, while Past SIP and Compare require ascending input. The wrapper normalization and regression tests are part of C1; all native evidence must be rerun on the corrected implementation SHA.
- Corrected-head evidence on `9d01f95` then exposed repeated Android `SQLiteFullException` writes to `catalystLocalStorage`. C1 now uses one stable React Query storage key, deletes all legacy version-suffixed keys, excludes raw NAV/performance/index daily arrays already backed by SQLite/CDN, caps the serialized client at 4 MiB characters, and drops the largest dehydrated query on a failed write. The buster is v10. Native acceptance must prove legacy cleanup, a bounded successful blob, and zero further AsyncStorage/SQLite full errors after exercising all affected screens.
- Independent re-review at `b515d4e` found that a repair mutated shared SQLite NAV history but evicted timelines only for the repairing fund set. The final implementation centralizes user-wide NAV-repair eviction: timeline repairs preserve only the exact tuple being rebuilt, while Fund Detail full-history repairs preserve nothing. Bidirectional single-fund/all-funds tests and an actual Fund Detail repair-path test protect the contract. Because this changes implementation code, the otherwise-passing `b515d4e` Android matrix is diagnostic evidence only and must be repeated on the new OTA.


## Progress

- [x] Reproduce incorrect All values and capture Cache Debug evidence.
- [x] Obtain and reconcile independent Codex and Claude issue reviews.
- [x] Branch `codex/nav-history-completeness` from `origin/main` at `d75a5920dd27dd398751d151ee110ae0b5a421d3`.
- [x] Write the reviewed C1 ExecPlan.
- [x] Implement coverage markers, deterministic pagination, and bootstrap repair.
- [x] Apply coverage to timeline, Fund Detail, and Compare.
- [x] Add regression tests and telemetry.
- [x] Re-pass full repository validation after the Android-discovered month-end ordering, AsyncStorage, and cross-fund-set invalidation corrections (`typecheck`, zero-warning lint, 84 suites / 1,887 tests).
- [x] Capture corrected-head Android evidence.
- [x] Open implementation PR #257.
- [ ] Request corrected-head independent reviews and reach dual convergence.
- [ ] Reach dual convergence, merge, verify main, and resume the performance queue.
