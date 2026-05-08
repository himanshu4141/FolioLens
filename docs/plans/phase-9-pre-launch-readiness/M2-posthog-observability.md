# Phase 9 M2 — PostHog Observability (single pane for events + crashes)


## Goal


Wire PostHog as the single operational dashboard for the FolioLens mobile + web app. After this milestone, every onboarding funnel step, portfolio import, insight view, app resume, and uncaught exception is visible in one PostHog project — no fragmenting across expo.dev, Sentry, or vendor-specific consoles. The implementation must not measurably slow the app on either platform; Vercel Web Vitals stay where they are because they cover an axis PostHog doesn't.


## User Value


For the founder: open one URL, see whether onboarding is converting, where it drops off, which Android version is crashing, and what the app's resume rate looks like — without stitching three dashboards together.


For the user: this milestone adds zero visible UI. The app initialises an analytics SDK quietly in the background, batches events on a 30-second timer, and never blocks render. Performance is the same on day-after-merge as it was day-before-merge.


## Context


Audit Topic 3 (crash monitoring) and Topic 4 (analytics events) returned MISSING / MISSING. The repo currently has:


- `expo-insights` in `package.json` but no JS-side use of it. The package auto-instruments at native init (app launches, OTA reach) and reports to expo.dev. We did not call it from any file.
- `@vercel/analytics` + `@vercel/speed-insights` mounted via `<VercelInsights />` in `app/_layout.tsx`, gated by `EXPO_PUBLIC_ENABLE_INSIGHTS=1` (which the Vercel build wrapper sets when `VERCEL_ENV=production`). Web-only.
- Zero crash reporting beyond what Expo or the OS dump into native logs that nobody is watching.


The user's stated constraint is "single pane of glass." Two-tool stacks (Sentry for crashes + PostHog for analytics) are explicitly off the table. Datadog is out on cost. PostHog wins on free-tier headroom (1M events/mo vs Sentry's 5K errors), product-funnel ergonomics, and the fact that errors are increasingly first-class in their SDK.


This milestone is the second instalment of Phase 9 readiness; M1 (`M1-store-submission-blockers.md`) covers disclaimers + deletion + store metadata and lives on a parked PR (#118).


## Assumptions


1. The PostHog project, API key, and host URL exist before this milestone ships. The key lives at `EXPO_PUBLIC_POSTHOG_KEY` and the host (default `https://us.i.posthog.com`) at `EXPO_PUBLIC_POSTHOG_HOST`. Both are set per environment in the Vercel project (web) and in expo.dev → EAS env vars (native). No keys ever land in the repo.
2. The same gating model from PR #102 (Vercel Speed Insights) applies: events fire on production builds and main-branch web previews; PR-preview deploys and local dev stay quiet. The control surface is build-time env vars, not runtime checks.
3. PostHog can ingest 1M events/mo on the free tier. A back-of-envelope: 100 daily-actives × 30 events/session × 1 session/day × 30 days = 90K events/mo. Comfortable margin.
4. The user has read [`docs/plans/phase-9-pre-launch-readiness/M1-store-submission-blockers.md`](./M1-store-submission-blockers.md) (the disclaimer / deletion / store-metadata plan) and is treating M2 as additive, not in conflict.


## Definitions


- **Analytics event** — a structured `{name, properties}` pair sent to PostHog at a meaningful product moment. Six events from the audit are required: `onboarding_started`, `onboarding_step_completed`, `onboarding_completed`, `portfolio_imported`, `insight_viewed`, `app_returned`.
- **Captured exception** — an uncaught JS exception forwarded to PostHog via `posthog.captureException`. Crash *symbolication* on iOS / Android (mapping minified stack traces to source) is automatic on PostHog's hosted backend if we include source maps with EAS uploads (already handled by `expo-updates`).
- **Identified user** — the PostHog `distinct_id` is the Supabase user id once the user signs in, and an anonymous device id before that. We never set the email as the distinct_id; the email goes in as a property only.
- **Single pane** — one PostHog project ingests events from both the React Native bundle (iOS + Android) and the Expo Router web bundle (Vercel-served). Same project, same dashboard, same event taxonomy.


## Scope


- Install `posthog-react-native` (covers iOS + Android + JS-side capture on native) and `posthog-js` (web bundle).
- Create `src/lib/analytics.ts` — a thin facade with `track`, `identify`, `reset`, `captureException`. The facade picks the right SDK at runtime; calling code never imports `posthog-*` directly.
- Mount `<PostHogProvider>` once in `app/_layout.tsx`, *after* `QueryClientProvider`, so the SDK initialises in parallel with the rest of the app rather than blocking render.
- Identify the user from `useSession`'s `onAuthStateChange` listener — `analytics.identify(user.id, { ... })` on sign-in, `analytics.reset()` on sign-out.
- Wire the six required audit events at their natural emit sites. Each event lists in this plan's "Event taxonomy" section so the wiring is reproducible.
- Add a global `ErrorBoundary` that calls `analytics.captureException` and renders a Clear Lens fallback. Hook it as the outermost child of `<ThemeProvider>`.
- Hook `ErrorUtils.setGlobalHandler` (RN) / `window.onerror` + `window.onunhandledrejection` (web) to forward uncaught errors that bypass React's tree.
- Remove `expo-insights` from `package.json`. Replace its OTA-update tracking with an `app_started` event property: `eas_update_id`, `eas_update_created_at`, `is_embedded_launch`.
- Add Jest tests for the analytics facade (mock the SDK, assert correct calls).
- Add a short note to [`docs/INFRASTRUCTURE.md`](../../INFRASTRUCTURE.md) under "Observability" pointing at PostHog.


## Out of Scope


- PostHog session replay. Heavy on mobile, fragments user trust on a finance app, and we don't need it at closed-beta volume. Can be enabled later for a specific cohort via PostHog's targeting.
- PostHog feature flags / experiments. Useful but a separate decision; this milestone is read-only telemetry.
- A/B testing infrastructure.
- Migrating away from Vercel Web Vitals. They cover Web Vital metrics PostHog reports differently; both stay, complementing each other.
- Any per-screen or per-button autocapture. We emit explicit events with curated properties — autocapture noise hurts more than it helps for funnel analysis.
- ~~Server-side / Edge Function instrumentation~~ — **expanded scope** during implementation per a user direction ("we need both before prod deploy anyways"). Now in scope; see "Server-side instrumentation" below.


## Server-side instrumentation


All server surfaces report to the **same PostHog project** as the client SDKs — that's what makes the dashboard a single pane. Events from the server side carry `environment: 'production' | 'dev'` so dashboards can filter prod from dev when one project ingests both. Distinct IDs use `system:<surface>` for non-user events (cron jobs, webhook handlers pre-auth) and the auth user id for user-attributed events.


    Surface                         SDK / transport                          Events
    ──────────────────────────────────────────────────────────────────────────────────────────────
    Supabase Edge Functions (Deno)  Direct HTTP via fetch to /capture/       cas_parse_success
                                    (no JSR/npm dep — keeps cold-start       cas_parse_failed
                                    minimal)                                  cas_inbound_imported
                                                                              cas_inbound_failed
                                                                              cas_inbound_crashed
                                                                              sync_completed (per cron)
                                                                              sync_failed (per cron)

    Vercel Python parser            urllib in stdlib (no posthog-python      cas_parser_python_outcome
                                    dep — avoids bumping requirements.txt)    {outcome: success | wrong_password
                                                                                      | holdings_only | exception}

    GitHub Actions AMFI sync        curl on success/failure (closes audit    amfi_sync_completed
                                    Topic 15 alerting gap)                    {outcome, environment, run_url}


All server-side captures are fire-and-forget when the function still has work to do (e.g. `parse-cas-pdf` returning a user response) and `await`-ed when the function is wrapping up (cron jobs ending). Errors from the analytics POST itself are swallowed and logged at `console.warn` — analytics must never break a user-visible function.


Server env vars (set in Supabase Edge Function Secrets, Vercel project env, and GitHub Actions secrets — same value as client `EXPO_PUBLIC_POSTHOG_KEY`):


    POSTHOG_PROJECT_KEY    project token (`phc_...`)
    POSTHOG_HOST           defaults to https://us.i.posthog.com
    APP_ENVIRONMENT        'production' or 'dev' — added as a property to every event


## Approach


### Why PostHog, not the alternatives


The audit noted four candidates. The decision rationale, condensed:


- **Sentry** — best crash dashboard, weak funnels, 1-user free tier ceiling. Fine if a teammate is added later, but the "single pane" claim collapses the moment we want "% of new users who completed onboarding by step."
- **Datadog** — true single pane (could include Supabase Edge logs), but no real free tier and ~$15/host minimum. Deferred until paid infra.
- **Firebase** — best mobile crash reporting, but the web bundle is treated as a generic site and pairs awkwardly with the rest of the stack.
- **PostHog** — single SDK family covering events + replay + flags + errors, generous free tier, product-funnel-first UX. Errors module is newer than Sentry's but adequate for the volume FolioLens will produce.


PostHog wins on the user's primary constraint (single pane) plus the volume profile (free tier covers expected closed-beta usage by ~10×).


### Performance budget


Three concerns with adding any analytics SDK:


1. **Bundle size** — `posthog-react-native` adds ~70KB minified to the native bundle; `posthog-js` adds ~50KB to the web bundle. On native, this is amortised across one one-time download per user (or one OTA-update download). On web, the existing Vercel-served bundle is already 1.5MB+ — 50KB is rounding error. **Acceptable.**
2. **Cold-start cost** — the SDK initialises lazily after `useEffect` runs in `<PostHogProvider>`. Init is sub-50ms on mid-range Android. We mount it *outside* the auth-gated render path so first-paint is unaffected. **Acceptable.**
3. **Network chatter** — `flushAt: 20` and `flushInterval: 30000` (30s) batch events into one POST every 30 seconds or every 20 events, whichever comes first. We disable autocapture (which would multiply network traffic by 10×) and disable session replay (heavy). **Acceptable.**


To make these claims falsifiable, the validation section requires a release build comparison:
- App start time (cold) before vs after, ≤ +50ms tolerance
- Web LCP before vs after on a Vercel preview, ≤ +100ms tolerance


### Gating strategy


Identical to PR #102's pattern, so the user has only one mental model for "where does telemetry fire":


- Build-time env: `EXPO_PUBLIC_POSTHOG_KEY`, `EXPO_PUBLIC_POSTHOG_HOST`
- The web build's `scripts/vercel-build.py` sets `EXPO_PUBLIC_POSTHOG_KEY` only when `VERCEL_ENV=production`. PR previews leave it unset → SDK init no-ops → zero events fire.
- For native, the env vars are scoped in expo.dev to `production` and `preview` environments only. `development` env builds (Expo Go on the founder's laptop) leave them unset.
- The facade in `src/lib/analytics.ts` checks `process.env.EXPO_PUBLIC_POSTHOG_KEY` at the top — if empty, every public method becomes a no-op. No SDK is initialised, no native module loads beyond the inert require.


### Event taxonomy


Six events, with required properties:


    onboarding_started
      properties: { entry_point: 'fresh_install' | 'returning_anon' }
      emit at: app/onboarding/index.tsx — first mount of the wizard
                  with no `pan` and no `kfintech_email` on user_profile

    onboarding_step_completed
      properties: { step: 'welcome' | 'identity' | 'import' | 'done',
                    step_index: 0 | 1 | 2 | 3 }
      emit at: app/onboarding/index.tsx — every transition that
                  advances `draft.step`

    onboarding_completed
      properties: { funds_imported_count: number }
      emit at: app/onboarding/index.tsx — when isSetupComplete first
                  flips from false to true

    portfolio_imported
      properties: { source: 'cas_pdf' | 'cas_email' | 'manual',
                    funds_count: number,
                    transactions_count: number }
      emit at: src/utils/casPdfUpload.ts — on successful import response;
                  also on Resend Inbound webhook success (server side, deferred)

    insight_viewed
      properties: { surface: 'home' | 'insights' | 'fund_detail' |
                    'leaderboard' | 'wealth_journey' | 'tools' | 'goal_summary' |
                    'money_trail',
                    fund_id?: string }
      emit at: each Clear Lens screen's first useEffect after mount

    app_returned
      properties: { previous_session_age_hours: number }
      emit at: app/_layout.tsx — AppState 'active' transition where the
                  delta from last `active` exceeds 5 minutes (D1+ heuristic
                  is in the dashboard, not the SDK)


Plus a free `app_started` event sent on every cold start, carrying `eas_update_id`, `eas_update_created_at`, `is_embedded_launch`, `app_version`. This replaces the OTA-update visibility we lose by removing `expo-insights`.


### Error capture


Three layers:


1. **React tree errors** — top-level `<ErrorBoundary>` (new file `src/components/ErrorBoundary.tsx`) catches render-phase exceptions, calls `analytics.captureException`, renders a Clear Lens fallback with a "Send error report" affordance.
2. **Uncaught JS errors** — on web, `window.onerror` + `window.onunhandledrejection`; on native, `ErrorUtils.setGlobalHandler`. Both forward into `analytics.captureException` then call the previous handler.
3. **Mutation errors** — `queryClient` in `src/lib/queryClient.ts` already has a place where we'd want a global `onError`; this milestone wires `defaultOptions.mutations.onError` to `analytics.captureException` so any failed Supabase RPC surfaces in PostHog without screen-specific instrumentation.


### What we DON'T do


- We do not autocapture clicks. PostHog's autocapture turns "every tap" into an event; on a finance app this both leaks behavioural signal we'd rather curate and multiplies event volume by 10×.
- We do not capture screen names automatically via `expo-router`'s segments. The `insight_viewed` event with an explicit `surface` is more useful for funnels than `screen=/(tabs)/index`.
- We do not enable PostHog's flag SDK. Feature flags are a separate decision; reuse comes when we want them.


## Architecture


    src/lib/analytics.ts                                  ← public facade
      track(name, properties)
      identify(distinctId, properties)
      reset()
      captureException(error, properties)
      isEnabled  ← boolean: false when EXPO_PUBLIC_POSTHOG_KEY unset

    src/lib/analytics.web.ts                              ← web impl (posthog-js)
    src/lib/analytics.native.ts                           ← native impl (posthog-react-native)
      Both files re-export the same surface; Metro picks one per platform.

    src/components/ErrorBoundary.tsx                      ← class component
      forwards errors to analytics.captureException, shows Clear Lens fallback

    app/_layout.tsx
      <ErrorBoundary>                                     ← outermost
        <QueryClientProvider>
          <ThemeProvider>
            <PostHogProvider>                             ← only when isEnabled
              <ThemedAppShell />
              <VercelInsights />                          ← unchanged
            </PostHogProvider>
          </ThemeProvider>
        </QueryClientProvider>
      </ErrorBoundary>

    scripts/vercel-build.py
      sets EXPO_PUBLIC_POSTHOG_KEY only when VERCEL_ENV=production

    package.json
      + posthog-react-native
      + posthog-js
      − expo-insights

    docs/INFRASTRUCTURE.md
      Observability section now lists PostHog as the single pane


## Alternatives Considered


- **Sentry + PostHog (split-stack)** — best of both, but explicitly contradicts the "single pane" constraint. Rejected.
- **Datadog** — true single pane plus server-side observability, but ~$15/host minimum and no real free tier. Deferred until the product is on paid infra.
- **PostHog Cloud EU vs US** — defaults to US (`us.i.posthog.com`). EU is `eu.i.posthog.com`. The user stores user data in India-region Supabase (likely AP-South-1); routing analytics to EU vs US has marginal latency differences, both < 200ms. Stay with US (default) unless explicitly directed otherwise; the property is overridable via env var.
- **Self-hosted PostHog** — free in monetary terms, expensive in operational terms. Skip.
- **Keep `expo-insights` alongside PostHog** — small overhead, but fragments the dashboard. The whole point of this milestone is one pane; keeping a second destination defeats the goal.


## Milestones


This is a single coherent PR. Tasks are ordered for execution, not sliced for separate ships.


### Order of operations


1. Install `posthog-react-native` + `posthog-js`. Remove `expo-insights`.
2. Create `src/lib/analytics.ts` + the platform-specific impls.
3. Add `<ErrorBoundary>` and the global handlers.
4. Update `app/_layout.tsx` to mount the boundary + provider.
5. Update `src/hooks/useSession.ts` to call `analytics.identify` / `reset` on auth-state changes.
6. Wire each of the six events at their named emit sites.
7. Update `scripts/vercel-build.py` to forward `EXPO_PUBLIC_POSTHOG_KEY` on `VERCEL_ENV=production`.
8. Add Jest tests for the facade.
9. Update `docs/INFRASTRUCTURE.md` Observability section.
10. Validate: typecheck, lint, tests, coverage.
11. Push, open PR.


## Validation


### Static checks (must pass before PR opens)


    npm run typecheck       # zero errors
    npm run lint            # zero warnings (--max-warnings 0)
    npm test                # all tests green
    npx jest --coverage     # ≥95% on src/utils/, overall ≥70%


### Behavioural validation (manual, after PR merges to dev)


- On `foliolens-dev.vercel.app`: open the site, hit insights, check PostHog → Live Events. Each surface produces one `insight_viewed` event with the correct `surface` property.
- On `preview-main` Android build: complete onboarding from a fresh install. PostHog → Funnel: `onboarding_started → onboarding_step_completed (welcome) → ... → onboarding_completed` shows the user.
- Force a JS exception (add a temporary `throw new Error('canary')` to a non-critical screen); confirm a `$exception` event appears in PostHog with the stack trace within 60 seconds.
- Background the app for 6+ minutes, foreground; confirm `app_returned` fires with `previous_session_age_hours > 0.1`.
- Run a PR-preview Vercel deploy; confirm zero events fire from that URL (the build flag is unset).


### Performance validation (must pass before PR opens)


- Cold-start time: average over 5 launches on a mid-range Android (~3GB RAM). Allowed regression: ≤50ms vs the same measurement on `main`. If exceeded, lazy-init further or report the actual delta in the PR description.
- Web LCP: Vercel preview before vs after, allowed regression: ≤100ms. If exceeded, drop session-replay-related deps from the web SDK or report the delta.


## Risks And Mitigations


| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| `posthog-react-native` peer dep drag breaks Expo SDK 55 build | Medium | High | Pin to the SDK's documented Expo 55 compatible version; run `expo doctor` after install. |
| Bundle bloat exceeds the 70KB native budget | Low | Medium | Tree-shake by importing the entry point, not deep paths; document if measured larger than expected. |
| Init time blocks first paint | Low | High | Provider mounts inside `<ThemeProvider>`, *not* at the synchronous top of `RootLayout`. Init runs in `useEffect`. |
| Events fire from PR-preview deploys | Low | Medium | Build-time gate via `vercel-build.py`; facade is a no-op when `EXPO_PUBLIC_POSTHOG_KEY` is empty. |
| User PII leaks into events | Low | Critical | Facade strips email / PAN before passing properties to the SDK; explicit allow-list per event in the Definitions section above. |
| PostHog free tier exceeded | Very Low | Low | Volume estimate is 90K events/mo at 100 DAU; tier limit is 1M. We get 10× headroom. PostHog also throttles to free-tier limits gracefully (drops events past quota), no crash. |
| Removing `expo-insights` breaks an unseen integration | Very Low | Low | Code grep returned zero non-package.json references. The native module's auto-instrumentation is opt-in via the JS package; uninstalling removes both. |
| Vercel + PostHog double-counting page views | Low | Low | Vercel measures *infrastructure-side* page views; PostHog measures *user-side* events. They're complementary, not duplicates. Documented in the INFRASTRUCTURE.md update. |


## Decision Log


- **2026-05-08**: Chose PostHog as the single pane, after option-tree review with the user. Tradeoff acknowledged: PostHog's error symbolication isn't Sentry-grade, but it's adequate for closed-beta volume.
- **2026-05-08**: Removed `expo-insights` rather than running both. Single-pane goal trumps the small OTA-reach insight; PostHog reproduces it via `app_started` properties.
- **2026-05-08**: Kept Vercel Speed Insights + Web Analytics. They cover Web Vitals at the infrastructure level (per-route, per-deploy); PostHog covers user-journey-level events. They don't duplicate.
- **2026-05-08**: Disabled session replay and autocapture by default. Re-enable later only if a specific debugging need arises and only for opted-in cohorts.
- **2026-05-08**: Used the same `EXPO_PUBLIC_*` build-time gating model as PR #102 (Vercel insights). One mental model, one place to flip.
- **2026-05-08**: Expanded scope mid-implementation to include server-side instrumentation (Edge Functions + Python parser + AMFI GitHub Action). User asked "shouldn't we be using the same for backend logs too" — single-pane goal would have been hollow without this. Implemented via direct HTTP capture (no new SDK deps) so the change is small and the cold-start cost on Edge Functions is unaffected.
- **2026-05-08**: Decided not to add the `posthog-python` SDK to the Vercel parser — used `urllib` for direct HTTP capture. Avoids a new pip dep and the parser already has a tight dependency closure (`casparser`, `pdfplumber`).


## Progress

- [ ] `posthog-react-native` + `posthog-js` installed
- [ ] `expo-insights` removed
- [ ] `src/lib/analytics.ts` facade + platform impls written
- [ ] `src/components/ErrorBoundary.tsx` written
- [ ] Global error handlers (web + native) wired
- [ ] `app/_layout.tsx` updated with `<ErrorBoundary>` + `<PostHogProvider>`
- [ ] `useSession` calls `analytics.identify` / `reset`
- [ ] `onboarding_started` emitted
- [ ] `onboarding_step_completed` emitted (4 steps)
- [ ] `onboarding_completed` emitted
- [ ] `portfolio_imported` emitted
- [ ] `insight_viewed` emitted on every insight surface
- [ ] `app_returned` emitted on AppState resume after >5min idle
- [ ] `app_started` emitted on cold start with EAS update properties
- [ ] `scripts/vercel-build.py` forwards `EXPO_PUBLIC_POSTHOG_KEY` on prod
- [ ] Jest test for the facade covers happy / no-key / exception path
- [ ] `supabase/functions/_shared/analytics.ts` helper for Edge Functions (HTTP capture, no JSR deps)
- [ ] Edge function events wired: parse-cas-pdf (success / failed), cas-webhook-resend (imported / failed / crashed), sync-nav, sync-index, sync-fund-portfolios, sync-fund-meta (completed / failed)
- [ ] Python parser `cas_parser_python_outcome` event via urllib (no new pip dep)
- [ ] AMFI sync GitHub Actions workflow emits `amfi_sync_completed` on success and failure
- [ ] `docs/INFRASTRUCTURE.md` Observability section updated
- [ ] `npm run typecheck` zero errors
- [ ] `npm run lint --max-warnings 0` zero warnings
- [ ] `npm test` green
- [ ] `npx jest --coverage` meets thresholds
- [ ] PR opened against `main`
