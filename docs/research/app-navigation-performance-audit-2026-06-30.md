# FolioLens App-Wide Navigation Performance Audit (2026-06-30)

**Reported symptom:** taps sometimes appear to hang, especially Settings → About (and some
other Settings rows), Your Funds feels heavy, and Your Funds → Fund Detail does not transition
smoothly. Native Google sign-in also sometimes remains on a sign-in/completion spinner after the
first attempt; restarting the app and trying again appears to complete immediately.

**Conclusion:** this is not primarily an About-screen problem. The app permits multiple hidden
screen trees to stay mounted and active, starts speculative portfolio/timeline work in the
background, and then globally invalidates React Query after native sync. A tap to About or Fund
Detail can therefore compete with hidden Portfolio/Funds calculations and query refetches on the
single JavaScript thread. Funds and Money Trail add a second class of problem: non-virtualized
lists and per-row creation of very large style objects. Fund Detail adds a third: a staged data
waterfall followed by two chart libraries and several synchronous derivations on its first useful
render.

The likely explanation for the user's experience is therefore a **JS-thread scheduling and
render fan-out problem**, with network/cache latency amplifying it. Adding more spinners will not
fix the delayed tap response.

The Google sign-in hang is a separate **auth state-machine defect**, not another manifestation of
the navigation performance problem. The client is configured for Supabase's default implicit OAuth
flow while the app comments and primary completion path assume PKCE. It also has two competing
callback owners and no timeout or terminal recovery. Previous fixes addressed individual races but
did not make the flow explicit or observable.

---

## Baseline and scope

| | |
|---|---|
| Repository | `FolioLens` |
| Commit analysed | `df5f746d907250fa5dfeb9aedede6135cc511ab1` |
| Commit date | 2026-06-28 |
| Analysis date | 2026-06-30 |
| Primary surfaces | Portfolio, Your Funds, Fund Detail, Settings, About, Money Trail, native Google OAuth, root sync/cache lifecycle |
| Static checks | `npm run typecheck` ✅; `npm run lint` ✅ |
| Production export | Android Hermes bytecode **3.9 MB**; web JS **3.3 MB**; Android exported assets **17.0 MB** |
| Rendered smoke test | Expo web, 390×844 and 1280×720, preview fixtures; route/DOM/console inspection |

### Evidence standard

Findings are labelled as follows:

- **Confirmed** — directly demonstrated by current code or the rendered component tree.
- **Strong** — current code provides a complete causal path, but native release timings are still
  required to quantify the contribution.
- **Candidate** — credible risk worth measuring after the confirmed causes are fixed.

The browser run used a local stub only to enter preview mode. It proved component mounting and
route behaviour, but its elapsed navigation timings are intentionally **not** used here: development
Metro lazy bundling and automation round trips are not representative of an EAS release build.
An index-snapshot error produced by that stub is also excluded from the findings.

---

## Executive summary

| Order | Finding | Severity | Confidence | Explains |
|---:|---|---|---|---|
| 1 | Portfolio and timeline prefetches run expensive duplicate work and are not cancelled on blur | **P0** | Confirmed | Cross-channel lead for Settings/About stalls; tab-switch contention |
| 1a | Investment timeline rereads and recomputes benchmark-independent inputs; overlapping SQLite write-backs fail | **P0** | Confirmed on Android | 3Y timeline controls take 4.8–5.9 s and failed cache repair can repeat the slow path |
| 2 | Native SQLite bootstrap/foreground sync is disabled when analytics is off; preview-PR OTA builds omit the key | **P0 correctness / preview amplifier** | Confirmed | Preview-only cold fetches and inconsistent performance |
| 3 | Hidden tabs/stacks remain mounted while broad invalidation keeps them active | **P0** | Confirmed | Intermittent Settings/About stalls and navigation amplification |
| 4 | Funds and Money Trail render full lists in `ScrollView`; rows recreate screen-wide styles | **P0/P1** | Confirmed | Your Funds jank, delayed fund-card taps, Money Trail scaling failure |
| 5 | Broad Zustand subscriptions and un-memoized insight derivation fan updates into hidden screens | **P1** | Confirmed | Search/sort/preferences jank, unnecessary app-wide rerenders |
| 6 | Fund Detail has a staged query waterfall and mounts the heaviest tab first | **P1** | Confirmed | Funds → Fund Detail spinner/stutter and chart pop-in |
| 7 | Every `useSession()` call creates another auth read and subscription (23 consumers) | **P1** | Confirmed | Mount churn, auth-event rerender storms, delayed query enablement |
| 8 | Large barrel imports and eager optional modules inflate route evaluation and native assets | **P1/P2** | Confirmed size; Strong runtime impact | First visit to About/Fund Detail and cold launch |
| 9 | Persisted React Query data duplicates SQLite and can create a large synchronous restore blob | **P2** | Strong | Cold-launch hangs and post-OTA variability |
| Prerequisite | Existing performance marks miss navigation stalls and collide under concurrent requests | **P1 prerequisite** | Confirmed | Makes the field issue hard to prove or regress-test |
| 10 | Expo SDK patch versions are behind the SDK 55 recommended set | **P2** | Confirmed | Possible framework-level fixes are missing; not proven root cause |
| Independent auth track | Native Google OAuth mixes implicit and PKCE assumptions and has no deterministic completion owner (finding 12) | **P0 auth reliability** | Confirmed architecture; Strong symptom match | First-attempt spinner, restart/retry appears to work |

---

## 1. Hidden screens keep doing work during navigation — P0

**Status: Confirmed. This is an important amplifier, but not the most deterministic first fix.**

Only Wealth Journey sets `freezeOnBlur: true` in `app/(tabs)/_layout.tsx`. Portfolio, Funds,
and the nested Settings navigator use the default behaviour. The rendered mobile tree confirmed
that all of the following remained mounted together after navigating Portfolio → Settings → About:

- the complete Portfolio screen, including benchmark controls and Money Trail preview;
- the Settings hub;
- the About screen;
- the tab navigator.

After opening Funds and returning, Portfolio, Funds, and Settings content all remained present in
the component tree. Keeping navigation history mounted is normal, but keeping its expensive hooks
active is not safe with the current invalidation strategy.

Two root-level paths call an unscoped `queryClient.invalidateQueries()` when native SQLite sync
reports any changed row:

- initial bootstrap: `app/_layout.tsx:223-225`;
- foreground delta sync: `app/_layout.tsx:318-322`.

React Query's default invalidation behaviour refetches matching **active** queries. Because hidden
screens are still mounted, “active” can include Portfolio, Funds, Money Trail-derived queries,
composition, chart timelines, Settings freshness, and previously visited Fund Detail routes. One
new NAV row can therefore trigger far more work than the visible screen needs.

This aligns closely with the intermittent symptom: the destination route is not consistently slow;
it is slow when its transition overlaps sync completion, invalidation, or queued prefetch.

### Required fix

1. Set `freezeOnBlur: true` for every heavy tab and for Settings stack screens. Keep
   `detachInactiveScreens` enabled on native.
2. Do not treat freezing as sufficient. A frozen React tree can still have mounted React Query
   observers. Gate expensive screen-only queries and prefetch effects with `useIsFocused()`.
3. Replace root-level invalidation with keys derived from `SyncResult`:
   - transaction change → `user-transactions`, `portfolio`, `money-trail`, investment timelines,
     wealth-journey transaction derivations;
   - NAV change → `portfolio`, `fund-detail`, NAV/timeline keys;
   - index change → only benchmark/index-derived keys.
4. For background sync, use `refetchType: 'none'` to mark derived entries stale without launching
   all mounted screens immediately. Explicitly refetch only the visible route's primary query.
5. Cancel delayed timeline/benchmark prefetch when the owning screen loses focus.

### Acceptance criteria

- Navigating Portfolio → Settings → About produces no new Portfolio/timeline query starts after
  the Portfolio screen blurs.
- A foreground sync that inserts one NAV row does not refetch Money Trail or unrelated Settings
  queries.
- Warm Settings → About tap-to-usable p95 is below 300 ms on a mid-range Android release build.
- Returning to Portfolio still shows fresh data, via stale-on-blur + focused refetch.

---

## 2. `useSession()` creates 23 independent auth subscriptions — P1

**Status: Confirmed. Structural render churn, not the lead explanation for the reported hangs.**

`src/hooks/useSession.ts` is not a shared provider. Every invocation:

1. starts with local `{ session: null, loading: true }` state;
2. calls `authClient.getSession()`;
3. registers its own `authClient.onAuthStateChange()` listener;
4. sets local state when either resolves.

There are **23 consumers**. A single mounted screen often creates several copies indirectly:
Funds calls `useSession()` itself and `usePortfolio()` calls it again; Fund Detail calls it in the
screen and again inside `useFundDetail`; root AuthGate has another. Hidden mounted screens retain
their listeners.

Consequences:

- each newly mounted route performs at least one avoidable extra render after `getSession()`;
- query `enabled` flags transition from false to true at slightly different times, producing staged
  work instead of one coordinated render;
- any auth event fans state updates into every mounted subscriber;
- the number of listeners grows as more routes are visited.

### Required fix

- Add one `SessionProvider` above `AuthGate`, with one `getSession()` call and one auth subscription.
- Make `useSession()` a context selector/reader with no effect and no local subscription.
- Pass `userId` into data hooks where practical, so low-level hooks do not independently subscribe
  to auth at all.
- Add a test that mounts multiple consumers and asserts one underlying auth subscription.

### Acceptance criteria

- Exactly one `onAuthStateChange` subscription exists for the app process.
- Mounting Fund Detail does not initiate another `getSession()` call.
- A token refresh causes one provider update, not one update per mounted hook.

---

## 3. Speculative prefetch duplicates expensive portfolio work — P0 lead

**Status: Confirmed. It is the most deterministic explanation of the About timing pattern.**

`usePortfolio()` immediately prefetches both other benchmark options after its active query lands
(`src/hooks/usePortfolio.ts:491-501`). Each prefetch calls the complete `fetchPortfolioData()` path,
which does much more than fetch the alternate index:

- reads funds and every transaction;
- reads and sorts recent NAV rows;
- rebuilds per-fund cashflows and realized gains;
- calculates XIRR for every fund and the full portfolio;
- simulates benchmark cashflows and calculates benchmark XIRR.

`xirr()` permits up to **1,000 Newton-Raphson iterations**, and each iteration scans all cashflows
twice. Typical inputs converge quickly, but unusual transaction streams can consume a substantial
slice of the JS thread. The same per-fund work is identical for all three benchmark choices and
should not be recomputed.

The timeline hook already contains a comment saying simultaneous prefetch caused a freeze “when
navigating to About immediately after.” It now delays the first alternate-benchmark prefetch by
1.2 seconds (`src/hooks/useInvestmentVsBenchmarkTimeline.ts:491-534`). However, because Portfolio
stays mounted after navigation, the timeout is not cancelled on blur. It can still fire while About
is becoming interactive.

Unlike the root invalidation path in finding 1, this timer does not require sync to have changed any
rows. Portfolio mounts both expensive hooks, so the timer is armed on every Portfolio mount and can
reliably overlap a quick Portfolio → Settings → About sequence. Global invalidation remains a serious
intermittent amplifier; focus-gating and cancelling this timer is the smaller, higher-yield first
change.

There is also a benchmark-key bug: `usePortfolio()` defaults to the legacy `^NSEI`, while all store
options use TRI symbols. Wealth Journey and Onboarding call `usePortfolio()` without an argument.
Those consumers create a fourth portfolio cache variant and then prefetch all three TRI variants.

### Required fix

1. Split benchmark-independent portfolio core data from benchmark-specific comparison data.
   Compute fund cards, fund XIRRs, totals, and transaction normalization once.
2. Make the benchmark query consume that cached core and calculate only benchmark-specific output.
3. Remove eager “prefetch all alternatives.” Prefer prefetch on benchmark-pill `onPressIn`, web
   hover/focus, or a focus-aware idle task after the visible screen has been stable for several
   seconds.
4. Cancel idle prefetch on blur.
5. Remove the `^NSEI` default. Require a symbol or use `BENCHMARK_OPTIONS[0].symbol` consistently.
6. Normalize/reversal-filter each fund's transactions once; reuse the result for units, cashflows,
   XIRR, and realized gains.

### Acceptance criteria

- Initial Portfolio load runs benchmark-independent aggregation once.
- Leaving Portfolio before an idle prefetch starts produces no later timeline/portfolio work.
- Opening Wealth Journey does not create a `['portfolio', userId, '^NSEI']` query.
- Switching benchmark remains fast through targeted prefetch or a lightweight benchmark-only query.

### Android follow-up evidence: timeline pipeline and SQLite contention

A user-driven main-preview run on Pixel 8a / Android 16 did not reproduce the original
state-dependent navigation hang: 15 post-interaction-usable samples ranged from 59–127 ms, with a
75 ms median. It did reproduce a separate, user-visible timeline delay:

- 3Y changes took 4.830–5.919 seconds end to end;
- the NAV stage alone took 2.669–3.727 seconds and read 12,861 rows to render 83 chart points;
- 1Y took 2.211 seconds, 6M took 1.034–1.260 seconds, 3M took 0.963–1.011 seconds, and 1M took
  0.663 seconds;
- Android gfxinfo recorded 62 / 2,223 janky frames (2.79%), 47 slow UI-thread frames, and one
  missed Vsync.

The current query key includes both benchmark and window, so each unseen combination reruns
transaction reads, NAV reads, portfolio/invested-series construction, and benchmark work. A
benchmark-only change therefore reloads and reprocesses the same 12,861 NAV rows. The computation
builds the union of every NAV and transaction date, values every fund on every date, and samples to
about 90 points only after that work. Benchmark snapshot retrieval was only about 40–70 ms and was
not the dominant stage.

The same run repeatedly logged `cannot start a transaction within a transaction` followed by
`cannot rollback - no transaction is active`. `navRepo`, `txRepo`, and `idxRepo` each open
`withTransactionAsync` directly, while timeline fallback performs an unawaited NAV write-back and
bootstrap/prefetch can write concurrently. A failed write-back leaves local coverage incomplete,
so later query combinations can fall through to the same paginated Supabase read again.

This evidence does not prove the original navigation hang. It confirms a second bottleneck that
can make the app feel generally hung and can amplify navigation contention. N2 remains the next
small scheduling fix. N2D then lands the shared database-write serializer and repair proof as an
independently attributable correctness change. N2T follows with timeline input reuse and bounded
valuation, keeping the financial-equivalence refactor out of both smaller PRs.

---

## 4. Funds and Money Trail do not virtualize, and each row builds a full style sheet — P0/P1

**Status: Confirmed.**

### Your Funds

`ClearLensFundsScreenMobile` renders `sortedFunds.map(...)` inside a `ScrollView`
(`src/components/clearLens/screens/ClearLensFundsScreen.tsx:578-627`). Every fund is mounted even
when off-screen. `FundListItem` calls a `makeStyles(tokens)` factory that defines the entire screen's
roughly 460-line style sheet. Expanded rows create `MetricRow` children, and every `MetricRow` calls
the same full factory again. The desktop variant repeats the pattern.

The rows are not memoized, and their navigation/toggle callbacks are created inline. Search is
stored in Zustand, so every keystroke rerenders the list and other full-store subscribers.

This can delay a card press because the tap and navigation action share the JS thread with list
render/reconciliation. It also explains why users with more funds will see a much worse problem
than preview's five-fund fixture.

### Money Trail

Money Trail is the more severe scale failure. It renders every `visibleTransaction` in a
`ScrollView` (`app/money-trail/index.tsx:928-1010`). The source comment itself mentions a real
550-transaction portfolio. `TransactionRow` calls a `makeStyles(tokens)` factory whose definition
spans roughly **660 lines**. A 550-row screen can therefore create 550 copies of the screen-wide
style object and mount 550 touchable rows at once.

### Required fix

- Replace the Funds and Money Trail vertical `ScrollView` maps with `FlatList` (or FlashList only
  if a dependency is justified). Use `ListHeaderComponent`/`ListFooterComponent` for existing
  headers and disclaimers.
- Supply `keyExtractor`, realistic `getItemLayout` where row height is fixed, initial batch/window
  settings, and `removeClippedSubviews` after platform verification.
- Create screen styles once in the screen parent and pass only required style references to rows,
  or create a small row-specific style hook. Never call the 460/660-line factory per row.
- Wrap rows in `React.memo`; pass stable callbacks keyed by ID.
- Keep Funds search local and deferred (`useDeferredValue`) unless cross-breakpoint persistence is
  truly required. If persistence is required, use a narrow selector and debounce the persisted write.
- Add fixture tests at 25 funds and 1,000 transactions, not only the five-fund preview.

### Acceptance criteria

- Initial Funds mount creates only the visible window of fund rows.
- A 1,000-transaction Money Trail does not mount 1,000 `TransactionRow` instances.
- `makeStyles` is called once per screen/theme change, not once per row.
- Typing in Funds search does not rerender Portfolio or Wealth Journey.

---

## 5. State and derived-data subscriptions cause avoidable rerenders — P1

**Status: Confirmed.**

There are **12 `useAppStore()` calls with no selector**. A no-selector Zustand subscription receives
every store update. Heavy consumers include Portfolio, Funds, Wealth Journey, Portfolio Insights,
and several Tools screens. With inactive tabs mounted, changing unrelated state can rerender hidden
large screens.

Examples:

- every Funds search character updates `fundsSearchQuery` and notifies full-store subscribers;
- opening/debug state or changing a preference can rerender Portfolio and Wealth Journey;
- Wealth Journey subscribes to the whole store even though it uses three fields.

`usePortfolioInsights()` adds another avoidable cost: `computeInsights(fundCards, compositions)` is
executed directly in the hook body, not in `useMemo`. The hook has five consumers across mobile and
desktop screen variants. Any parent rerender repeats sorting, holdings aggregation, sector loops,
and allocation construction even when inputs are unchanged.

### Required fix

- Replace every full-store subscription with primitive selectors or `useShallow` for a small tuple.
- Keep high-frequency transient input local to the focused screen.
- Memoize `computeInsights` on stable `fundCards` and `compositions` references.
- Audit child components that rebuild the same large `StyleSheet` and pass parent-created styles.
- Add React Profiler/render-count tests for Portfolio + Funds mounted together.

---

## 6. Fund Detail starts with a waterfall, then mounts the heaviest tab — P1

**Status: Confirmed.**

`app/fund/[id].tsx` is 2,595 lines and imports `react-native-gifted-charts` at route scope. Its
first-load sequence is:

1. the screen and `useFundDetail` independently wait for their `useSession()` instances;
2. `fetchFundDetail` waits for shared funds + all transactions;
3. it then waits for scheme metadata + two latest NAV rows;
4. only after `data.schemeCode` exists can `useFundNavHistory` start full-history loading;
5. only after the detail render does `PerformanceTab` mount its index query and investment timeline;
6. the default tab immediately builds a gifted-charts line chart and the SVG Growth Consistency
   chart.

The route does use SQLite read-through and separates two latest NAV rows from full history, which is
good. The remaining problem is scheduling: there is no transition-aware deferral analogous to
Wealth Journey's existing `InteractionManager.runAfterInteractions()` chart gate.

There is a compounding link to finding 3. The composition tab calls
`usePortfolio(defaultBenchmarkSymbol)` to obtain one portfolio-weight value. That second full
portfolio hook does not merely repeat aggregation: it also re-arms the two alternate-benchmark
prefetches while Fund Detail is fetching and mounting charts. Replacing this call with a lightweight
cached weight selector is a contained first-wave fix; it should not wait for the full route split.

### Required fix

- Prefetch `fund-detail` and bounded/full NAV history from the Funds row's `onPressIn` and reuse the
  same query keys. On press, start prefetch before `router.push` without awaiting it.
- Render the hero shell immediately from the already-cached `FundCardData`; do not block the whole
  route on scheme metadata.
- Defer chart mounting until navigation interactions finish and the Performance tab is focused.
- Split Performance, NAV & Facts, and Mix & Weight into separate modules/components. Composition
  must not load until its tab is selected.
- Memoize the `fundRef` object/array passed to timeline hooks and make their prefetch focus-aware.
- Move portfolio-weight data into a lightweight cached selector instead of invoking another full
  `usePortfolio` from the composition tab.

### Acceptance criteria

- Warm Funds → Fund Detail renders header/hero in the first post-navigation frame.
- No chart component mounts before the navigation transition completes.
- Only the selected tab's data and chart code execute.
- Back navigation remains responsive while a history request is in flight; obsolete work is
  cancelled or ignored.

---

## 7. Bundle and optional-module weight — P1/P2

**Status: Size is confirmed; navigation contribution is strong but needs native trace data.**

The production export showed:

- Android Hermes bytecode: **3.9 MB**;
- web entry JS: **3.3 MB**;
- Android assets: **17.0 MB** across 68 assets;
- source map contents from `gifted-charts` packages: about **856 KB** of source;
- exported assets include every Inter weight/style, Material Symbols weights, and every legacy
  vector-icon font even though the app uses five Inter weights and Ionicons.

The import patterns explain this:

- 46 files import `{ Ionicons }` from the `@expo/vector-icons` barrel;
- root imports named fonts from the `@expo-google-fonts/inter` barrel;
- Fund Detail imports `{ LineChart, PieChart }` from the `react-native-gifted-charts` barrel, while
  the bundle also contains unused BubbleChart/BarChart modules.

About also eagerly imports `FeedbackSheet`; that component eagerly imports `expo-image-picker`,
storage, feedback data access, Updates, and a 586-line modal implementation even when the user only
wants to read the version. Route-level evaluation is confirmed; its native elapsed-time contribution
has not yet been measured. Deferring the import until a feedback action is tapped is nevertheless a
contained first-wave candidate, provided the N1 measurement confirms that first-route evaluation
is material.

### Required fix

- Use `import Ionicons from '@expo/vector-icons/Ionicons'` consistently.
- Import the five Inter font files through direct package subpaths if supported by the installed
  package, and verify the export asset list drops unused weights.
- Replace gifted-charts barrel imports with supported direct component entry points. If the package
  does not provide stable subpaths, consider replacing the three remaining charts with the existing
  `react-native-svg` chart primitives rather than adding Metro aliases to private internals.
- Move FeedbackSheet to a lazily mounted route/component loaded only after Request a feature or
  Report an issue is tapped.
- Split Fund Detail's tab implementations so first route evaluation does not initialize all tabs.
- Remove the Portfolio desktop/mobile require cycle by moving shared presentational components to a
  third module. The current cycle is reported at runtime.

Do this after the scheduling/list fixes. Bundle reduction improves cold start and first evaluation,
but it will not by itself stop hidden queries from refetching during a tap.

---

## 8. React Query persistence duplicates native SQLite — P2

**Status: Strong candidate, previously identified in the cold-start report.**

The 48-hour persister allowlist includes full/raw and derived copies of the same information:

- `user-transactions` plus `money-trail` and portfolio-derived results;
- `fund-nav-history` despite full NAV history already living in SQLite;
- index history in SQLite plus snapshot/query entries;
- potentially many per-fund detail/history entries accumulated as the user browses.

AsyncStorage restores one serialized client blob. Parsing a large blob occurs before screens that
gate on `useIsRestoring()` can paint. The previous cold-start report raised the TTL from 24 to 48
hours, which reduces misses but can grow the amount restored.

### Required fix

- Record blob bytes, query count, per-key estimated serialized bytes, restore duration, and device
  memory class in analytics. The debug screen already exposes part of this.
- On native, stop persisting large raw arrays that SQLite already stores. Persist only small,
  expensive derived summaries needed for instant first paint.
- Consider separate persisters/chunks if one large JSON blob remains a bottleneck.
- Keep the `__BUSTER__` and cache-surface documentation updated; the inventory still says v7 while
  code is v8.

---

## 9. Current instrumentation cannot prove navigation responsiveness — P1 prerequisite

**Status: Confirmed.**

Current `perfMark` spans time queries and sync, but it does not measure:

- tap → router action;
- router action → first destination frame;
- first frame → usable content;
- JS frame stalls during the transition;
- number of hidden screen renders triggered by one invalidation.

It also stores span starts in `Map<label, timestamp>`. Concurrent calls with the same label overwrite
one another. The three portfolio benchmark fetches all use labels such as `query:portfolio` and
`query:portfolio:index`, so emitted durations can be missing or assigned to the wrong request.

### Required fix

- Give every span an ID returned by `perfStart`; end by ID, not label.
- Add navigation marks at the shared row/card press helpers and destination screen commit.
- Record route, warm/cold cache, active query count, sync-in-flight, and portfolio/fund/transaction
  counts.
- Use two `requestAnimationFrame` callbacks or an `InteractionManager` completion mark to distinguish
  “component committed” from “transition became usable.”
- Build a PostHog dashboard for p50/p95 by route pair and app version.
- Validate on EAS release/profile builds. Development Metro timing is not a release metric.

---

## 10. Native data lifecycle is incorrectly coupled to analytics — P0 diagnostic/fix

**Status: Confirmed preview amplifier and correctness bug; not the cross-channel root cause.**

`useAnalyticsLifecycle()` returns immediately when `analytics.isEnabled` is false
(`app/_layout.tsx:147-148`). The same effect contains not only analytics, but also:

- the initial SQLite `bootstrapForUser` call;
- the auth listener that runs bootstrap on sign-in and clears local data on sign-out;
- the AppState listener that runs foreground delta sync.

If a development, preview, privacy-sensitive, or misconfigured production channel has no PostHog
key, none of that data lifecycle runs. Screens then depend more heavily on their Supabase fallback
paths and can remain cold or stale. It also makes performance differ by build-channel configuration,
which is exactly the kind of variability that turns a reproducible issue into “it hangs a lot.”

The channel check is no longer hypothetical:

- `.github/workflows/main-deploy.yml` and `production-release.yml` pass
  `EXPO_PUBLIC_POSTHOG_KEY` into `eas update`;
- `.github/workflows/pr-preview.yml` does not;
- the PR preview OTA published for this audit therefore builds `analytics.isEnabled === false` and
  skips bootstrap, foreground sync, auth-driven bootstrap, and sign-out cleanup.

The reported hangs were observed on both main and preview builds. Main supplies the PostHog key, so
this early return cannot explain the common symptom. N0 is a preview-only amplifier and a serious
cache/sign-out correctness bug; N2 prefetch cancellation is the cross-channel lead performance fix.
Correctness must never depend on telemetry configuration.

### Required fix

- Split the effect into an unconditional auth/data lifecycle and an optional analytics lifecycle.
- Keep PostHog calls guarded, but never guard cache correctness or sign-out cleanup on telemetry.
- Add a test with analytics disabled that still bootstraps, foreground-syncs, and clears user data.
- Before refactoring, record the tested app variant/update ID and whether analytics is enabled. This
  is a two-minute diagnostic and should be the first investigation step.
- Add the PostHog key/host wiring to `pr-preview.yml` so preview builds can emit N1 performance
  metrics comparable with main/production. This is observability parity, not a substitute for
  decoupling cache correctness from analytics.

---

## 11. Expo dependency alignment — P2

`expo start` reports that the repo is behind the SDK 55 recommended patch set, including Expo,
Expo Router, React Native, screens-related packages, and multiple Expo modules. Framework patch
releases often contain New Architecture, navigation, and rendering fixes.

This is not proven to cause the current hangs, so it should not precede the app-level fixes above.
After those fixes are measured, run `npx expo install --fix`, review the lockfile intentionally,
and repeat native release navigation tests. Do not mix this upgrade into the P0 scheduling PR; that
would make regressions hard to attribute.

---

## 12. Native Google sign-in has no single, explicit completion path — P0 release blocker

**Status: Confirmed architecture defects; Strong match for the first-attempt spinner.**

This is not caused by a slow Google response alone. The app's configured OAuth mode, callback
parsing, browser lifecycle, and post-auth navigation disagree about who owns completion.

### What the app actually does

1. `app/auth/index.tsx` sets `loadingMode = 'google'`, asks Supabase for an OAuth URL, then awaits
   `WebBrowser.openAuthSessionAsync()` with no timeout or `try/catch/finally`.
2. `src/lib/supabase.ts` does **not** set `auth.flowType`. The installed Supabase client defaults to
   `flowType: 'implicit'`; its own types say PKCE is recommended for mobile. The current root-layout
   comments and `parseOAuthCode()` branch nevertheless describe the native flow as PKCE.
3. An implicit success returns `access_token` and `refresh_token` in the URL fragment, not a
   `?code=`. The direct result handler in `app/auth/index.tsx` only calls `parseOAuthCode()`. It
   therefore cannot complete the flow it is actually configured to start.
4. Success instead depends on Expo Router independently seeing the same deep link, mounting
   `app/auth/callback.tsx`, and recovering the fragment through `Linking.useURL()` or
   `callbackUrl`. This makes the browser promise and the router two competing observers of one
   redirect.
5. The callback calls `setSession()` for implicit tokens (or `exchangeCodeForSession()` if it
   happens to receive a code), sets local state to `linked`, and deliberately does not navigate.
   It waits for the separate `AuthGate` `useSession()` subscription to observe the event and call
   `router.replace('/(tabs)')`.

There is no timeout at the browser, callback, session-establishment, or post-session-navigation
stage. There is also no recovery that asks `getSession()` whether a session was persisted after a
watchdog expires. Any missed event or unresolved promise is therefore rendered as an infinite
spinner.

The Android workaround in `app/_layout.tsx` is based on an incorrect premise. Its comment says
`maybeCompleteAuthSession()` resolves the pending Android `openAuthSessionAsync()` promise. The
installed Expo SDK 55 implementation and the [Expo WebBrowser documentation](https://docs.expo.dev/versions/latest/sdk/webbrowser/)
both define `maybeCompleteAuthSession()` as web-only; it returns “Not supported on this platform”
on Android and iOS. Android completion is implemented with a race between Chrome Custom Tabs,
`AppState`, and a `Linking` listener. The call added as the Android fix therefore has no native
effect.

### Why restart + retry can appear to fix it

The observation is consistent with two paths, and current telemetry cannot distinguish them:

- **Session was persisted but navigation never completed.** Supabase persists the session before
  the callback expects `AuthGate` to navigate. A new process can restore it via `getSession()`.
- **The app never consumed the first callback, but browser SSO completed.** Google/Supabase browser
  cookies and consent survive app restart, so the next OAuth attempt can return immediately even
  if the app did not persist a session the first time.

Do not use the fast second attempt as proof of either theory. Record a sanitized `getSession()`
result at cold start and stage completion timings first.

### Regression archaeology

| Change | What it addressed | What remains |
|---|---|---|
| [PR #43](https://github.com/himanshu4141/FolioLens/pull/43) | Introduced Google login/account linking | Established the split browser + route callback design |
| Commit `2eef2ca` | Added `maybeCompleteAuthSession()` for the Android spinner | The API is web-only, so this cannot resolve the native promise |
| [PR #47](https://github.com/himanshu4141/FolioLens/pull/47) | Corrected the mobile web bridge/hostname path | Did not unify native callback ownership |
| [PR #52](https://github.com/himanshu4141/FolioLens/pull/52) | Preserved query/hash and added implicit-token callback support | The auth-screen result handler still only handles PKCE codes |
| [PR #114](https://github.com/himanshu4141/FolioLens/pull/114) | Waited for Expo Router params and prevented double code exchange | Prevented a transient error, but retained indefinite waits |
| [PR #236](https://github.com/himanshu4141/FolioLens/pull/236) | Removed callback `router.replace()` to avoid competing redirects | Replaced competing navigation with an unbounded dependency on a different auth subscriber |

These fixes are individually reasonable responses to observed races, but the sequence has left the
flow dependent on implicit SDK defaults and event ordering. There is no native release evidence in
the PRs demonstrating first-attempt completion across Android and iOS.

### Required fix

1. **Make the protocol explicit.** Configure `flowType: 'pkce'` in the auth client and treat the
   authorization-code callback as the canonical new flow. Keep fragment-token parsing only as a
   bounded backward-compatible path during rollout. Supabase documents that PKCE stores a verifier
   on the initiating device and completes through
   [`exchangeCodeForSession`](https://supabase.com/docs/guides/auth/sessions/pkce-flow).
2. **Create one idempotent OAuth completion coordinator.** Both a WebBrowser result and an Expo
   Router deep link may deliver the URL, but they must call the same function, keyed/deduplicated by
   a sanitized flow ID. Exactly one owner exchanges the code, confirms the session, and completes
   navigation. Do not let the auth screen and callback screen independently interpret the redirect.
3. **Make success terminal and deterministic.** After `setSession()` or
   `exchangeCodeForSession()` returns a session, update the shared session source and replace the
   callback with `/(tabs)` through the coordinator. `AuthGate` remains a general access guard, not
   the only completion mechanism for an in-progress OAuth transaction.
4. **Add bounded failure handling.** Put timeouts around browser return and session completion;
   use `try/catch/finally`; always clear the initiating button state; render retry/cancel actions;
   and on a post-exchange timeout reconcile once with `getSession()` before reporting failure.
5. **Use the single `SessionProvider` from finding 2.** The callback and `AuthGate` must read the
   same state source. This removes the current dependency on one of 23 independent subscriptions
   winning an event race.
6. **Instrument stages without credentials.** Record `oauth_started`, `browser_returned`,
   `callback_received`, `session_started`, `session_confirmed`, and `navigation_completed`, with
   elapsed time, platform, app version/update ID, EAS channel, result type, and callback transport
   (`code` or `fragment`). Never record the callback URL, authorization code, access/refresh token,
   email, or provider user ID.
7. **Correct misleading comments and docs.** Update `docs/architecture/auth-flow.md` and remove the
   native claim attached to `maybeCompleteAuthSession()`.

### Acceptance criteria

- A clean-install first Google attempt reaches the app on Android and iOS without a second tap or
  process restart, on production, preview-main, and preview-PR schemes.
- Every attempt reaches one terminal state within a defined bound: tabs, actionable error, or
  cancelled. No spinner can remain indefinitely.
- The same callback delivered through both WebBrowser and Expo Router exchanges at most once.
- Cancel, browser close, network loss during exchange, background/foreground during consent, and
  callback replay all have automated tests and a native release-build verification record.
- After successful login, killing and reopening the app routes through the restored session without
  presenting or requiring the Google button.
- Telemetry can identify the last completed stage for a failed attempt without storing auth
  credentials or PII.

---

## Recommended implementation order

Implementation is deliberately sequential: one milestone, one implementation PR, two independent
reviews, convergence, merge, then the next milestone starts from the updated `main`. The milestone
IDs preserve the earlier research labels; the **Queue** column is the execution order.

| Queue | Milestone | Scope | Why here |
|---:|---|---|---|
| 1 | N1 | Navigation measurement harness | Establishes trustworthy before/after evidence |
| 2 | N2 | Cancel prefetch contention; remove Fund Detail's second portfolio hook; measure/defer FeedbackSheet | Cross-channel lead for both reported transitions |
| 3 | N2D | Serialize writes at the shared SQLite connection; prove cache repair | Stops the observed transaction failures and recurring remote fallback first |
| 4 | N2T | Reuse benchmark-independent timeline inputs; bound valuation dates | Fixes the measured 4.8–5.9 s control delay with isolated equivalence evidence |
| 5 | N0 | Decouple native data lifecycle from analytics; restore preview telemetry parity | Correctness fix and preview-only amplifier removal |
| 6 | N3 | Freeze/focus-gate hidden screens; granular invalidation; remove `^NSEI` default | Removes the intermittent background-work amplifier |
| 7 | N4 | Single SessionProvider; narrow Zustand subscriptions; memoize insights | Shared foundation for auth and structural rerender cleanup |
| 8 | Auth A0 | Deterministic native Google OAuth completion | Reuses the one N4 session source; does not block earlier navigation work |
| 9 | N5 | Virtualize Funds and Money Trail | Directly addresses list scaling and tap latency |
| 10 | N6 | Transition-first Fund Detail refactor | Builds on the contained N2 win |
| 11 | N7 | Split portfolio core from benchmark work | Larger financial-compute change after equivalence evidence exists |
| 12 | N8 | Bundle, persisted-cache, and SDK cleanup | Final measured optimization layer |

N1 instrumentation is first because the hangs occur on both main and preview. N2 is the first
behavior change because it is the shared cross-channel cause. N2D isolates the failed SQLite repair;
N2T then addresses the independently measured multi-second timeline path. N0 follows as a required
correctness fix and removes preview-only confounding; it is not expected to remove the main-build
hang by itself.

---

## Execution, review, and merge protocol

PR #250 is the control-plane PR and remains open until every implementation milestone is merged.
Implementation PRs target `main`; they must not merge or cherry-pick the research branch.

### Reading this report before PR #250 merges

At the start of every implementation and review session:

```bash
git fetch origin codex/app-navigation-performance-audit
git show origin/codex/app-navigation-performance-audit:docs/research/app-navigation-performance-audit-2026-06-30.md
```

Also read the current PR #250 conversation because later corrections may be newer than the last
report commit. Do not assume this file exists on `main`, and do not copy it into an implementation
PR merely to make the prompt path resolve.

### Three roles

1. **Execution owner** — implements exactly one queued milestone, validates it, opens the
   implementation PR, addresses review feedback, merges after convergence, then starts the next
   milestone from updated `main`.
2. **Codex reviewer/coordinator** — independently reviews each implementation PR and maintains the
   tracking table and conclusions on PR #250.
3. **Claude reviewer** — independently reviews each implementation PR, challenges claims and test
   evidence, and confirms convergence on the implementation PR.

Because the agents may post through the same GitHub account, every comment starts with a role tag:
`[Execution N1]`, `[Codex review N1]`, or `[Claude review N1]`.

### Per-milestone cycle

1. The execution owner selects the first `Pending` row below and branches from current `main`.
2. It reads the milestone prompt from this unmerged report, implements only that scope, and runs the
   repository validation checklist.
3. It opens a draft implementation PR against `main`, marks it ready when checks and milestone
   acceptance evidence are present, then comments on PR #250 with the implementation PR link.
4. Codex and Claude review independently. Actionable findings are inline threads; each reviewer also
   posts a top-level summary stating approve, changes requested, or blocked on evidence.
5. The execution owner addresses every actionable thread, replies with commit/test evidence, and
   requests re-review. It does not dismiss disagreement or self-resolve a reviewer's thread.
6. Review/fix/re-review repeats until both reviewers explicitly post `CONVERGED`, required checks are
   green, and no unresolved actionable thread remains.
7. The execution owner merges using the repository's normal merge method, confirms `main` contains
   the merge, and comments on PR #250 with the implementation PR, merge SHA, validation results,
   measured before/after evidence, and any scope amendment.
8. The Codex coordinator updates the tracking table on this branch. Only then may the execution
   owner start the next row from the new `main`.

### Program tracking

| Queue | Milestone | Status | Implementation PR | Merge SHA | Evidence / amendments |
|---:|---|---|---|---|---|
| 1 | N1 | Merged | [#251](https://github.com/himanshu4141/FolioLens/pull/251) | `53e57f58` | 39 focused + 1,798 full tests; Android/iOS exports; Android main-preview physical paired-log smoke at merge SHA posted on PR #250; iOS release evidence blocker recorded on PR #250 |
| 2 | N2 | Ready to merge | [#252](https://github.com/himanshu4141/FolioLens/pull/252) | — | Codex/Claude CONVERGED at docs head `ad40cf33`; code `d88d1271`; 77 suites / 1,805 tests, typecheck, lint, diff check; Android main-preview focused-idle, post-blur, Fund Detail, and cache-only evidence accepted |
| 3 | N2D | Pending | — | — | Android main-preview logged repeated overlapping SQLite transaction/write-back failures; land one shared connection-level serializer and repair proof |
| 4 | N2T | Pending | — | — | Android main-preview: 3Y timeline 4.830–5.919 s and 12,861 NAV rows for 83 points; consume N2D and isolate compute/input reuse |
| 5 | N0 | Pending | — | — | — |
| 6 | N3 | Pending | — | — | — |
| 7 | N4 | Pending | — | — | — |
| 8 | Auth A0 | Pending | — | — | — |
| 9 | N5 | Pending | — | — | — |
| 10 | N6 | Pending | — | — | — |
| 11 | N7 | Pending | — | — | — |
| 12 | N8 | Pending | — | — | — |

PR #250 merges last, after this table is complete and the report reflects the measured outcome of
all implementation PRs.

---

## Task prompts

The prompts below are intentionally scoped to one implementation PR each. Until PR #250 merges,
every prompt includes this mandatory preamble: fetch and read the report from
`origin/codex/app-navigation-performance-audit` with `git show`, read the PR #250 discussion, and do
not merge/cherry-pick the research branch into the implementation branch.

### Prompt 0 — decouple native data lifecycle from analytics

```text
PR #250 is intentionally unmerged. Fetch origin/codex/app-navigation-performance-audit, read this
report with git show from that ref, and read the current PR #250 conversation. Do not merge or
cherry-pick the research branch into this implementation branch.

Read VISION.md, docs/INFRASTRUCTURE.md, docs/architecture/cache-surfaces.md, and section 10 of
docs/research/app-navigation-performance-audit-2026-06-30.md.

Implement Navigation N0 only. First record the app variant, EAS update ID, and whether
analytics.isEnabled for the build used to reproduce the hangs. The current
.github/workflows/pr-preview.yml omits EXPO_PUBLIC_POSTHOG_KEY while main-deploy.yml and
production-release.yml supply it; verify this without printing secret values.

Refactor app/_layout.tsx so SQLite bootstrap, auth-driven bootstrap, foreground delta sync,
sign-out cleanup, cache clearing, and global error-handler installation do not depend on PostHog
being configured. Keep only analytics.track/identify/reset calls behind the analytics boundary.
Preserve the existing sign-out -> sign-in serialization and native/web guards.

Add tests with analytics disabled proving that initial bootstrap runs, SIGNED_IN bootstraps,
SIGNED_OUT clears every user-scoped cache, and foregrounding runs the throttled delta sync. Add a
channel/config regression check so a missing analytics key cannot silently disable correctness
again. Add the PostHog key/host wiring to pr-preview.yml so N1 telemetry is comparable across preview,
main, and production; do not expose secret values. Run npm run typecheck, npm run lint, and focused
root-lifecycle tests. Record before/after cold-query behavior for the exact preview update in the PR.
```

### Prompt A — native Google sign-in reliability (independent track)

```text
PR #250 is intentionally unmerged. Fetch origin/codex/app-navigation-performance-audit, read this
report with git show from that ref, and read the current PR #250 conversation. Do not merge or
cherry-pick the research branch into this implementation branch.

Read AGENTS.md, VISION.md, docs/process/PLANS.md, docs/architecture/auth-flow.md, finding 2, and
finding 12 of docs/research/app-navigation-performance-audit-2026-06-30.md. Inspect the diffs and
discussion in PRs #43, #47, #52, #114, and #236 before changing the flow. Create an ExecPlan because
this touches root navigation, auth persistence, native deep links, and three EAS schemes.

Fix first-attempt native Google login. Do not patch another individual race while retaining the
current mixed protocol. src/lib/supabase.ts currently omits auth.flowType, so the installed client
uses implicit flow even though the native code and docs describe PKCE. Configure PKCE explicitly
and make authorization-code exchange the canonical new flow. Preserve fragment-token handling only
as a tested compatibility path for callbacks already in flight during rollout.

Create one idempotent OAuth completion coordinator used by both the WebBrowser result and the Expo
Router callback. Deduplicate duplicate delivery without logging or persisting raw codes/tokens.
Exactly one path should exchange/set the session, confirm the shared session state, and replace the
callback with /(tabs). AuthGate should remain a safety guard, not the only post-OAuth navigator.
Correct the claim that maybeCompleteAuthSession resolves Android auth; Expo documents that method as
web-only. Keep it only where the web popup flow needs it.

Consume the single SessionProvider from Navigation N4 if it has landed. If it has not, implement
that provider and consumer migration in this branch, then treat N4's auth portion as complete. There
must be one getSession bootstrap and one onAuthStateChange subscription for the app process. The
coordinator and AuthGate must consume that same provider; do not introduce a second OAuth-only
session store.

Add timeouts and try/catch/finally around OAuth URL creation, browser return, session exchange, and
post-session navigation. Every attempt must end in tabs, an actionable retry/cancel error, or an
explicit cancellation. On a post-exchange timeout, call getSession once to reconcile a session that
may already have persisted. Always clear button loading state.

Add sanitized stage telemetry for oauth_started, browser_returned, callback_received,
session_started, session_confirmed, and navigation_completed. Include duration, platform, EAS
channel, app/update version, result type, and code-vs-fragment transport. Never capture callback
URLs, authorization codes, access/refresh tokens, email, or provider IDs.

Add unit/integration tests for duplicate URL delivery, missing/late router params, callback replay,
cancel, browser close, timeout before callback, network failure during exchange, a session that was
persisted before navigation, and cold-start restoration. Verify clean-install first-attempt login,
background/foreground during consent, and kill/relaunch after success on Android and iOS release
builds for production, preview-main, and preview-PR schemes. Record the stage timeline and build IDs
in the ExecPlan. Run npm run typecheck, npm run lint, and focused auth tests. Update
docs/architecture/auth-flow.md and add an Amendments section if implementation diverges.
```

### Prompt 1 — navigation performance instrumentation

```text
PR #250 is intentionally unmerged. Fetch origin/codex/app-navigation-performance-audit, read this
report with git show from that ref, and read the current PR #250 conversation. Do not merge or
cherry-pick the research branch into this implementation branch.

Read VISION.md, AGENTS.md, docs/process/PLANS.md, and
docs/research/app-navigation-performance-audit-2026-06-30.md.

Implement Navigation N1 only: a reliable navigation-performance harness for the Expo React Native app.
Current src/lib/perfMark.ts keys starts only by label, so concurrent portfolio/prefetch spans
overwrite each other. Change the API so perfStart returns a unique span ID and perfEnd closes that
ID. Migrate all call sites without changing business behaviour.

Add reusable navigation marks for these route pairs:
- Portfolio -> Settings
- Settings -> About
- Portfolio/Funds -> Fund Detail
- bottom-tab switches

Capture press-to-route-commit and press-to-post-interaction-usable timing, route names, cache
warm/cold state where available, sync-in-flight, and relevant row counts. Emit concise dev logs and
sanitized PostHog events. Do not include fund names, IDs, transaction details, or user PII.

Add tests for concurrent same-label spans and metric sanitization. Document how to collect a
baseline from Android/iOS release builds. Run npm run typecheck, npm run lint, and focused tests.
Do not change navigation scheduling or data fetching in this PR.
```

### Prompt 2 — cancel deterministic transition contention

```text
PR #250 is intentionally unmerged. Fetch origin/codex/app-navigation-performance-audit, read this
report with git show from that ref, and read the current PR #250 conversation. Do not merge or
cherry-pick the research branch into this implementation branch.

Read VISION.md, docs/SCREENS.md, and sections 3, 6, and 7 of
docs/research/app-navigation-performance-audit-2026-06-30.md.

Implement Navigation N2 only. Focus-gate every delayed benchmark/timeline prefetch and cancel queued
work immediately on blur. Portfolio -> Settings -> About within the 1.2-second window must produce
no later portfolio/timeline query start. Keep benchmark switching responsive through targeted
onPressIn/hover/focus prefetch rather than prefetching all alternatives on mount.

Replace Fund Detail composition's second full usePortfolio(defaultBenchmarkSymbol) call with a
lightweight cached selector/query for the one portfolio-weight value. Prove that Funds -> Fund
Detail no longer starts another full portfolio aggregation or re-arms two alternate-benchmark
prefetches.

Use the N1 harness to measure first-visit About route evaluation. If FeedbackSheet and its eager
dependencies are material, defer module evaluation and mounting until Request a feature or Report
an issue is tapped; do not claim a win from conditional rendering while retaining an eager import.

Add focused tests for blur cancellation, stable benchmark behavior, cached fund weight, and lazy
feedback loading if included. Validate Settings -> About and Funds -> Fund Detail in a release-like
native build. Run typecheck, lint, and focused tests.
```

### Prompt 2D — serialize SQLite writes and prove cache repair

```text
PR #250 is intentionally unmerged. Fetch origin/codex/app-navigation-performance-audit, read this
report with git show from that ref, and read the current PR #250 conversation. Do not merge or
cherry-pick the research branch into this implementation branch.

Read VISION.md, docs/TECH-DISCOVERY.md, docs/architecture/cache-surfaces.md, docs/process/PLANS.md,
and the Android follow-up subsection in finding 3 of
docs/research/app-navigation-performance-audit-2026-06-30.md. Create an ExecPlan because this
changes shared native-cache concurrency and repair behavior.

Implement Navigation N2D only. Introduce one serializer at the shared SQLite database-connection
level and route navRepo, txRepo, and idxRepo transactional writes through it. Do not create one lock
per repository: NAV, transaction, and index writes share one connection and must not overlap
withTransactionAsync. Avoid re-entrant queue deadlocks, ensure a rejected write does not poison the
queue, and do not hide transaction errors.

Make timeline fallback write-back observable and deterministic: await it or place it on the shared
durable-in-process queue, retain enough state to retry a failed repair, and prove that successful
repair makes the next identical read local. Preserve bootstrap, foreground sync, sign-out, database
close/delete, and test-reset ordering so queued user-scoped writes cannot land after cleanup.

Add concurrency tests that overlap bootstrap, foreground sync, timeline NAV write-back, and index
write-back on one mocked connection. Inject a write failure and assert the next queued operation
runs, retry/repair succeeds, and a later identical timeline read stays local. Verify no nested
transaction or invalid rollback error is emitted. Exercise the same overlap on Android main-preview
at the implementation SHA and record queue wait/write durations plus any SQLite errors. Run all
database/sync/timeline-read-through focused tests, typecheck, and lint; update the ExecPlan and cache
inventory if behavior or ownership changes.
```

### Prompt 2T — optimize the investment timeline

```text
PR #250 is intentionally unmerged. Fetch origin/codex/app-navigation-performance-audit, read this
report with git show from that ref, and read the current PR #250 conversation. Do not merge or
cherry-pick the research branch into this implementation branch.

Read VISION.md, docs/TECH-DISCOVERY.md, docs/architecture/cache-surfaces.md, docs/process/PLANS.md,
and the Android follow-up subsection in finding 3 of
docs/research/app-navigation-performance-audit-2026-06-30.md. Start from main after N2D is merged;
verify the shared connection-level serializer and cache-repair tests remain intact. Create an
ExecPlan because this changes financial timeline computation.

Implement Navigation N2T only. Do not redesign the SQLite coordinator in this PR.

Split investment-vs-benchmark timeline inputs from benchmark-specific output. Cache the
window-bounded transactions, NAV rows/lookups, unit/cost histories, invested series, and portfolio
valuation inputs by user + stable fund set + window, independent of benchmark. A benchmark-only
change may fetch index history and simulate the benchmark, but must not reread the same transaction
or NAV rows or rebuild the portfolio/invested series.

Move sampling ahead of the expensive per-fund/per-date valuation loop. Derive a bounded set of
evaluation dates while preserving visible window boundaries, the terminal point, transaction
semantics, latest-at-or-before NAV behavior, and the existing chart contract. Do not simply discard
raw NAV rows before building correct lookups. Add golden fixtures comparing every emitted date and
value against the pre-change implementation within tight numeric tolerances, including weekends,
holiday gaps, NFO mark-to-cost, switches, redemptions, reversed pairs, missing NAV/index data, and
1M/3M/6M/1Y/3Y/All windows.

Use the N1 harness on Android main-preview at the implementation SHA. Record cold and warm timings
for every window and repeated benchmark switches, NAV/transaction/index row counts, input-cache
hits, emitted point counts, and SQLite errors. Acceptance requires zero SQLite transaction errors,
no transaction/NAV reread on a benchmark-only switch, warm benchmark-switch p95 below 300 ms, and
material improvement over the 3Y 4.830–5.919 s baseline without financial-output drift. Run all
timeline and N2D regression tests, typecheck, and lint; update the ExecPlan amendments and cache
inventory if the cached payload contract changes.
```

### Prompt 3 — stop hidden-screen work and invalidation storms

```text
PR #250 is intentionally unmerged. Fetch origin/codex/app-navigation-performance-audit, read this
report with git show from that ref, and read the current PR #250 conversation. Do not merge or
cherry-pick the research branch into this implementation branch.

Read VISION.md, docs/SCREENS.md, docs/architecture/cache-surfaces.md, and sections 1 and 3 of
docs/research/app-navigation-performance-audit-2026-06-30.md.

Implement Navigation N3. Make Portfolio, Funds, Wealth Journey, and Settings stack screens freeze
on blur. Then focus-gate expensive screen-only queries; do not assume freezeOnBlur stops React Query
observers or refetches.

Replace both queryClient.invalidateQueries() calls in app/_layout.tsx after bootstrap/foreground
sync with a tested helper that maps SyncResult fields to the minimal dependent query-key prefixes.
Background sync should mark inactive derived queries stale with refetchType:'none'; only the visible
route should refetch immediately. Preserve correctness after CAS import and new daily NAV/index
rows.

Remove the legacy ^NSEI default from usePortfolio and update no-argument callers to use the stored
TRI benchmark or BENCHMARK_OPTIONS[0].symbol.

Add tests proving: NAV-only sync does not invalidate Money Trail; transaction sync invalidates all
transaction-derived summaries; hidden screens do not refetch; Wealth Journey creates no ^NSEI
query. Validate Settings -> About and Funds -> Fund Detail in a release-like native build. Run
typecheck, lint, and focused tests.
```

### Prompt 4 — single session provider and Zustand selector audit

```text
PR #250 is intentionally unmerged. Fetch origin/codex/app-navigation-performance-audit, read this
report with git show from that ref, and read the current PR #250 conversation. Do not merge or
cherry-pick the research branch into this implementation branch.

Read VISION.md and sections 2 and 5 of
docs/research/app-navigation-performance-audit-2026-06-30.md.

Implement Navigation N4. Replace the current effect-based useSession hook with one SessionProvider mounted at
the root. There must be exactly one authClient.getSession() bootstrap and one
authClient.onAuthStateChange() subscription for the app process. Preserve AuthGate behaviour,
magic-link/OAuth flows, sign-out cleanup, and test mocks.

If Prompt A has already shipped the provider and migrated consumers, verify those invariants rather
than rebuilding it; scope this branch to any remaining low-level auth reads plus the Zustand and
derived-state work below.

Migrate all 23 useSession consumers. Prefer passing userId into lower-level data hooks where this
removes redundant context reads cleanly.

Audit every no-selector useAppStore() call. Replace it with primitive selectors or useShallow over
the smallest stable tuple. Keep high-frequency Funds search input local/deferred or narrowly
subscribed. Memoize computeInsights in usePortfolioInsights.

Add tests showing multiple session consumers create one underlying subscription and unrelated
Zustand updates do not rerender representative Portfolio/Funds consumers. Run typecheck, lint, and
the relevant Jest suites.
```

### Prompt 5 — virtualize Your Funds and Money Trail

```text
PR #250 is intentionally unmerged. Fetch origin/codex/app-navigation-performance-audit, read this
report with git show from that ref, and read the current PR #250 conversation. Do not merge or
cherry-pick the research branch into this implementation branch.

Read VISION.md, DESIGN.md, docs/SCREENS.md, and section 4 of
docs/research/app-navigation-performance-audit-2026-06-30.md.

Implement Navigation N5 without changing visual design or financial calculations. Replace the vertical
ScrollView + map lists in ClearLensFundsScreenMobile, ClearLensFundsScreenDesktop where useful, and
app/money-trail/index.tsx with virtualized FlatList-based layouts. Preserve headers, filters,
expanded fund state, transaction navigation, desktop width constraints, pull/scroll behaviour, and
the disclaimer via list header/footer components.

The current TransactionRow and FundListItem call screen-wide makeStyles factories per row. Create
styles once per screen/theme and pass narrow style objects or row-specific styles. Memoize rows and
provide stable ID-based callbacks. Avoid nested same-direction scroll views.

Add deterministic fixtures/tests for 25 funds and 1,000 transactions. Include a dev render-count
assertion or profiler evidence that only the visible window mounts and that changing one expanded
fund does not rerender every unchanged row. Validate light/dark, mobile/desktop, search, sort,
filters, and fund/transaction navigation. Run typecheck, lint, and focused tests.
```

### Prompt 6 — Fund Detail transition-first refactor

```text
PR #250 is intentionally unmerged. Fetch origin/codex/app-navigation-performance-audit, read this
report with git show from that ref, and read the current PR #250 conversation. Do not merge or
cherry-pick the research branch into this implementation branch.

Read VISION.md, DESIGN.md, docs/SCREENS.md, and section 6 of
docs/research/app-navigation-performance-audit-2026-06-30.md. This is a multi-file refactor, so
create/update an ExecPlan under docs/plans/ following docs/process/PLANS.md.

Implement Navigation N6. The Funds -> Fund Detail transition must render a useful hero immediately from the
already-cached fund card, while full metadata/history/charts load progressively. Prefetch the exact
fund-detail and fund-nav-history query keys on fund-row onPressIn and start the same prefetch before
router.push without awaiting it.

Split app/fund/[id].tsx into a route shell plus Performance, NAV & Facts, and Mix & Weight modules.
Only the selected tab should mount its queries and chart code. Gate Performance charts behind
InteractionManager.runAfterInteractions (matching the Wealth Journey pattern) and cancel on blur.
Keep deep-link cold entry correct: it may show a skeleton, but back navigation must remain usable.

Memoize timeline inputs, avoid a second full usePortfolio call for portfolio weight, and retain all
financial output/caching semantics. Add query-order tests and rendered tests for warm navigation,
cold deep link, tab switching, and back during in-flight history. Run typecheck, lint, and focused
tests; document any ExecPlan amendments.
```

### Prompt 7 — remove duplicate portfolio/benchmark computation

```text
PR #250 is intentionally unmerged. Fetch origin/codex/app-navigation-performance-audit, read this
report with git show from that ref, and read the current PR #250 conversation. Do not merge or
cherry-pick the research branch into this implementation branch.

Read VISION.md, docs/TECH-DISCOVERY.md, and section 3 of
docs/research/app-navigation-performance-audit-2026-06-30.md. Create an ExecPlan because financial
calculation correctness and multiple consumers are involved.

Implement Navigation N7. Refactor usePortfolio so benchmark-independent work (fund/transaction normalization,
units, cost basis, realized gains, fund XIRRs, totals, NAV card data) is computed and cached once.
Create a separate benchmark-specific query/selector that consumes the core result and only loads /
computes index comparison output. Eliminate eager full fetchPortfolioData calls for all benchmarks.
Use targeted onPressIn/hover/focus prefetch or a cancellable focused idle task.

Normalize and reversal-filter each fund's transaction stream once and reuse it. Preserve every
existing output to tight numeric tolerances, including switches, redemptions, matured schemes,
unavailable NAV, portfolio XIRR, and benchmark XIRR. Add regression fixtures for pathological XIRR
inputs and assert bounded runtime/fallback behaviour. Run all portfolio/xirr tests, typecheck, and
lint. Record before/after query counts and JS compute timings from the N1 harness.
```

### Prompt 8 — bundle, persistence, and SDK cleanup

```text
PR #250 is intentionally unmerged. Fetch origin/codex/app-navigation-performance-audit, read this
report with git show from that ref, and read the current PR #250 conversation. Do not merge or
cherry-pick the research branch into this implementation branch.

Read VISION.md, docs/INFRASTRUCTURE.md, docs/architecture/cache-surfaces.md, and sections 7, 8, and
11 of docs/research/app-navigation-performance-audit-2026-06-30.md.

Implement Navigation N8 in separate commits: (1) safe bundle/import reductions, (2) native React Query
persister diet, (3) Expo SDK 55 patch alignment. Do not mix behaviour changes into the import-only
commit.

Use direct Ionicons imports and supported direct Inter/font/chart imports. Lazy-load the About
feedback UI until its action is tapped. Remove the Portfolio desktop/mobile require cycle. Produce
Android and web exports before and after, listing Hermes/JS bytes, total assets, TTF count, and
gifted-charts contribution.

On native, remove large persisted raw arrays already backed by SQLite unless measurements prove
they are needed. Keep small derived summaries required for first paint. Add analytics/debug output
for persister blob bytes, restore duration, query count, and per-prefix size. Bump __BUSTER__ if the
persisted contract changes and update cache-surfaces.md (currently documents v7 while code is v8).

Finally run npx expo install --fix, review every lockfile change, and validate auth, Settings/About,
Portfolio, Funds, Fund Detail, and Money Trail in iOS/Android release builds. Run typecheck, lint,
tests, and production exports.
```

---

## What not to do

- Do not add a loader to About. The tap delay occurs before About can solve anything.
- Do not merely increase stale times again. That can hide network fetches while preserving hidden
  render/computation storms and growing the restore blob.
- Do not set only `freezeOnBlur` and declare success. Query observers and delayed timers must be
  focus-gated or cancelled.
- Do not optimize financial math without equivalence fixtures. Performance changes cannot alter
  XIRR, cost basis, switches, or benchmark semantics.
- Do not use Expo development-server navigation timings as release evidence.
- Do not add another `maybeCompleteAuthSession()` call for Android; Expo defines it as web-only.
- Do not rely on Supabase's default OAuth flow or on AuthGate event timing. Set the protocol and
  completion owner explicitly.
- Do not log callback URLs, codes, URL fragments, tokens, emails, or provider identities while
  instrumenting auth.

---

## Final recommendation

Because the hangs occur on both main and preview, start the cross-channel performance path with N1
measurement and N2: **focus-aware cancellation of deterministic prefetch plus removal of Fund
Detail's second portfolio hook**. Android now demonstrates a separate 4.8–5.9 second timeline path
plus failed SQLite cache repair. Land N2D first as the small shared-database correctness change,
then N2T for benchmark-independent input reuse and bounded valuation with clean timing attribution.
Then run N0 lifecycle decoupling as a correctness fix and to remove the preview-only amplifier; it
is not the shared root cause. Follow with N3 granular invalidation/focus gating, then N4 and N5
before broad beta. The larger Fund Detail and portfolio core refactors follow once the contained
fixes are measured.

Run Auth A0 as an independent workstream in the same issue list, per the requested scope. It remains
important reliability work, but it must not gate the navigation sequence. Coordinate it with N4 so
the repository lands one shared SessionProvider rather than two competing auth state sources.

Treat bundle/cache work as the final layer. It matters for cold launch and first route evaluation,
but the current code already contains a more direct explanation for the intermittent in-session
hangs: too much invisible work is allowed to run at the same time as navigation.
