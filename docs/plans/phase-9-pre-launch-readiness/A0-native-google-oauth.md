# Auth A0 — deterministic native Google OAuth completion

## Goal

Make the first Google sign-in attempt finish predictably on native FolioLens builds. Every attempt must end in a signed-in app, an explicit cancellation, or an actionable error within a defined time. A callback delivered both to Expo WebBrowser and Expo Router must exchange credentials once and navigate once.

## User Value

A user should not have to kill the app and tap Google sign-in a second time. After approving Google consent, FolioLens should establish the session and open the portfolio. If the browser is closed, the network fails, or the callback is incomplete, the app should stop loading and explain what the user can do next.

## Context

PR #250 is the unmerged control plane for the navigation and auth reliability program. Its Auth A0 prompt requires an explicit PKCE flow, one completion owner, bounded failures, sanitized telemetry, and release-like native evidence. Navigation N4 already shipped `src/context/SessionContext.tsx`, so the app process has one `getSession()` bootstrap and one `onAuthStateChange()` subscription.

The current flow is internally inconsistent:

- `src/lib/supabase.ts` leaves `flowType` unset, so Supabase defaults to implicit OAuth.
- `app/auth/index.tsx` starts OAuth and only understands a PKCE `code` when WebBrowser returns.
- `app/auth/callback.tsx` separately handles both code and fragment callbacks, then waits for `AuthGate` to navigate.
- the installed Supabase client accepts the authorization code itself in `exchangeCodeForSession(code)`, but the current callback passes a full URL.
- WebBrowser and Expo Router can observe the same callback, but each screen owns independent state and there is no process-wide deduplication.
- browser launch, browser return, exchange, session confirmation, and navigation have no complete bounded state machine.
- `maybeCompleteAuthSession()` is called with a native comment even though Expo defines it as web-only.

The relevant historical fixes are PRs #43, #47, #52, #114, and #236. They added Google OAuth, corrected the bridge host, preserved fragment callbacks, guarded a route-param race, and finally delegated navigation to AuthGate. Each addressed a local symptom while retaining split completion ownership.

## Assumptions

- Navigation N4 remains the sole session source and must not be duplicated.
- The HTTPS bridge at `EXPO_PUBLIC_APP_BASE_URL/auth/callback` remains the registered Google/Supabase redirect target.
- Production, preview-main, and preview-PR native schemes remain `foliolens`, `foliolens-main`, and `foliolens-pr`.
- OAuth fragment tokens are rejected. They cannot prove app-initiated provenance or possession of a PKCE verifier; magic-link fragments remain isolated to `/auth/confirm`.
- Android is the locally available physical-device evidence surface. iOS scheme behavior will be covered by shared deterministic tests and the existing multi-scheme configuration; any unavailable physical iOS evidence will be stated honestly.

## Definitions

- PKCE: an OAuth authorization-code flow where the initiating app stores a one-time verifier and later exchanges the returned code. A stolen code is unusable without that verifier.
- completion coordinator: the single process-wide object that parses, deduplicates, exchanges, confirms, and navigates an OAuth callback.
- callback transport: `code` for the canonical PKCE query parameter. OAuth token fragments are classified only so they can be rejected explicitly.
- reconciliation: one exceptional `getSession()` call after session-confirmation timeout to detect a session that Supabase persisted but whose auth event was missed.
- sanitized flow ID: a short non-secret identifier used to correlate stages. It never contains a callback URL, code, token, email, or provider identity.

## Scope

- Configure Supabase auth with explicit `flowType: 'pkce'`.
- Add one testable OAuth completion coordinator shared by direct WebBrowser results and the Expo Router callback route.
- Use the same coordinator for Google account linking so it cannot retain a separate callback race.
- Extend SessionProvider with bounded session confirmation and exceptional reconciliation while preserving one normal bootstrap and subscription.
- Bound OAuth URL creation, browser return, exchange/session confirmation, and navigation; always clear button/loading state.
- Add privacy-safe stage telemetry for `oauth_started`, `browser_returned`, `callback_received`, `session_started`, `session_confirmed`, and `navigation_completed`.
- Restrict the root native deep-link handler to magic-link confirmation and keep `maybeCompleteAuthSession()` on web only.
- Add deterministic tests for duplicate delivery, replay, late params, cancellation, dismissal, timeouts, exchange failure, reconciliation, background/foreground-compatible browser completion, and cold session restoration.
- Update `docs/architecture/auth-flow.md`, this ExecPlan, and README current capabilities.

## Out of Scope

- Changing Google OAuth client credentials or Supabase provider configuration.
- Replacing the HTTPS bridge with universal/app links.
- Redesigning the sign-in screen.
- Adding another session store or auth subscription.
- Persisting callback payloads, authorization codes, tokens, or flow state outside Supabase's existing PKCE verifier storage.

## Approach

Create `src/lib/oauthCompletion.ts` as a pure, dependency-injected coordinator with one exported process instance. It parses a callback into PKCE code, rejected token fragment, provider error, or invalid input; derives only an in-memory hashed deduplication key; and stores in-flight/completed promises in a bounded map. The first valid code delivery performs the exchange, waits for the shared SessionProvider to expose the expected session, reconciles once on confirmation timeout, replaces the route with `/(tabs)`, and emits sanitized stage telemetry. Duplicate deliveries await or reuse the same result without exchanging or navigating again.

Create a small React hook that supplies the coordinator with SessionProvider confirmation/reconciliation and Expo Router navigation. `app/auth/index.tsx`, `app/(tabs)/settings/account.tsx`, and `app/auth/callback.tsx` call that hook instead of interpreting callbacks independently. A testable native-attempt runner wraps OAuth URL creation and WebBrowser return with timeouts and returns a terminal result to the initiating screen.

SessionProvider will keep its existing single bootstrap/subscription. It will add a waiter set that resolves when the provider receives the expected user session. A reconciliation method performs one explicit `authClient.getSession()` only after a coordinator timeout, applies that result to the same provider state, and publishes the effective missed auth transition once to lifecycle subscribers.

Telemetry will use a fixed allowlist of non-sensitive fields: stage duration, platform, app version, EAS channel, app variant, update ID, browser result type, callback transport, callback source, and sanitized flow ID. Tests will assert that URLs, codes, tokens, email, and provider IDs never enter tracked properties.

## Alternatives Considered

- Let AuthGate remain the completion owner. Rejected because it cannot distinguish an in-progress OAuth attempt, report stage failures, or guarantee the callback was exchanged before navigation.
- Let the callback screen be the sole owner. Rejected because WebBrowser may receive the result directly and Expo Router may deliver late or not mount before an existing-session AuthGate redirect during account linking.
- Store raw callback URLs for deduplication. Rejected because finance-app telemetry and persistence must not retain credentials.
- Use only a component ref to block duplicate exchange. Rejected because refs are screen-local and do not deduplicate two different mounted delivery paths.

## Milestones

### 1. Establish protocol and shared completion primitives

Set `flowType: 'pkce'`, implement callback parsing/deduplication, and extend SessionProvider with session confirmation and reconciliation. Unit tests must prove normal mounts still perform one bootstrap and one subscription, and duplicate callback delivery exchanges once.

### 2. Migrate native initiators and callback route

Move sign-in and account linking to the bounded native attempt runner. Move callback-route processing to the same coordinator. Remove native claims around `maybeCompleteAuthSession()` and restrict root fragment handling to magic-link routes. Tests must prove cancel, dismiss, timeout, late callback data, rejected OAuth fragments, and callback replay all terminate.

### 3. Add sanitized telemetry and documentation

Emit the six required stages with allowlisted metadata, update the architecture diagram and sequence, and update README. Tests must inspect captured properties and prove no callback credentials or identity data are emitted.

### 4. Validate and collect release-like evidence before opening the PR

Run focused auth tests, the full test suite, typecheck, zero-warning lint, diff check, and relevant exports. Push the implementation branch, manually dispatch the pre-PR OTA workflow against its exact SHA, apply the Android `foliolens-pr` OTA, and exercise first-attempt success, cancellation/retry, background/foreground during consent, and kill/relaunch restoration. Record update IDs, stage timings, terminal states, and zero auth/SQLite errors in this plan. Only then open the ready implementation PR and request the two independent reviews.

## Validation

Run:

    npm test -- --runInBand <focused auth suites>
    npm run typecheck
    npm run lint
    npm test -- --runInBand
    git diff --check origin/main...HEAD

Expected results are zero TypeScript errors, zero lint warnings, all focused and full tests passing, and no whitespace errors. Native evidence must identify the exact branch SHA and OTA ID and must not contain credentials or PII.

## Risks And Mitigations

- Switching to PKCE invalidates an implicit OAuth callback initiated by an older bundle. This is an intentional security boundary: fragment tokens are rejected because a custom-scheme fragment has no trustworthy app-initiated provenance.
- Duplicate callbacks can race before a map entry is visible. The coordinator inserts the shared promise synchronously before awaiting network work.
- A session event can arrive before a waiter registers. SessionProvider checks its current session snapshot before adding the waiter.
- A timeout can leave a waiter behind. Waiters remove themselves on resolve, rejection, timeout, and provider unmount.
- A callback route with no parsed params can spin forever. The route has an explicit missing-callback timer and actionable retry UI.
- Account linking begins with an existing session, so matching any non-null session is insufficient. Confirmation matches the session user returned by the exchange and the coordinator still owns navigation.
- Shared `foliolens-pr` OTA can be overwritten. Verify the About update prefix immediately before native measurement and republish only if the implementation SHA changes.

## Decision Log

- 2026-07-05: Use the N4 SessionProvider rather than creating OAuth-specific auth state.
- 2026-07-05: Treat the installed Supabase API contract as authoritative and pass only the PKCE code to `exchangeCodeForSession`.
- 2026-07-05: Include account linking in the coordinator migration because it uses the same browser/callback route and otherwise preserves the same race.
- 2026-07-05: Keep legacy fragments only for rollout compatibility; all newly initiated flows use explicit PKCE.
- 2026-07-05: Supersede the fragment-compatibility decision after independent review identified login-CSRF/session swapping. Reject every OAuth token fragment; only the PKCE code path may establish a Google session.
- 2026-07-05: Open the implementation PR only after exact-SHA Android evidence, per the revised program process.
- 2026-07-05: After Android acceptance, rebase onto documentation-only PR #258 before opening the implementation PR. The owner explicitly waived a redundant native rerun because all 19 A0-touched file blobs are identical between measured commit `c729b14de77171e03f9e50fbc1d154ffce684396` and rebased head `2ba2c695a0c43a25885be49ddade71884451a5bc`.

## Amendments

- The implementation uses the installed `@supabase/auth-js` source as the API contract: `exchangeCodeForSession` accepts the authorization code string, not a reconstructed callback URL. A focused regression test asserts the exact one-time code is passed.
- Required stages are sent to analytics and mirrored to `[auth/oauth]` release log lines with the same allowlisted payload so physical-device evidence does not depend on PostHog access. Tests scan both sinks for forbidden credentials and identity values.
- Session reconciliation is revision-guarded. If a newer `SIGNED_OUT` or `SIGNED_IN` event arrives while the exceptional `getSession()` call is pending, the late result cannot overwrite that event.
- Review correction: an accepted reconciliation now advances the same revision fence and publishes the effective missed transition to lifecycle subscribers. A one-shot transition marker suppresses one delayed identical provider event while preserving token refreshes, account switches, and sign-outs, so SQLite bootstrap and analytics identification run exactly once.
- Review correction: native Router fallback URLs must match the installed build scheme and exact `/auth/callback` route. A stale `/auth/confirm` URL is ignored while the callback screen waits for late Router code parameters.
- Review correction: all OAuth token fragments are rejected before provider mutation. Cold, replayed, and in-flight fragment URLs cannot call `setSession`; magic-link fragments remain on their separate confirmation route.
- Account linking was migrated with sign-in because it used the same browser and callback route. Keeping it separate would have retained the duplicate-exchange and existing-session AuthGate race.
- Physical iOS evidence is not locally available. All three iOS schemes are release-exported and share the deterministic coordinator tests; the final PR will state this evidence boundary rather than claiming a device run.

## Validation Record

- Focused auth validation: 5 suites, 47 tests passed.
- Full repository validation: 88 suites, 1,914 tests passed.
- `npm run typecheck`: zero errors.
- `npm run lint`: zero warnings.
- Android release exports: production, preview-main, and preview-PR succeeded; each emitted a 6.3 MB Hermes bundle.
- iOS release exports: production, preview-main, and preview-PR succeeded; each emitted a 6.2 MB Hermes bundle.
- Pre-PR manual workflow validation before A0: run `28734201289` published Android update `019f3151-1d17-7eb7-b651-cf57a60ed121` and iOS update `019f3151-1d17-7dd6-b88c-9b52ba105076` at exact base SHA `c597b22924d79d205809dea8acb5057bedcf682f`, with an empty PR target.
- Final A0 pre-PR workflow: run `28734845945` passed both required jobs at measured implementation `c729b14de77171e03f9e50fbc1d154ffce684396` and published Android update `019f3169-6957-7a06-add7-b04f997f2f64` plus iOS update `019f3169-6957-7d82-b667-b87c0dee0428`.
- Pixel 8a exact-update verification: Settings -> About displayed `019f3169-695...` before destructive setup and again after clearing app data, redownloading the update, restarting, authenticating, and returning to About.
- Clean first-attempt sign-in: one Google tap and one account choice reached Portfolio/Funds/Wealth Journey without an app restart or second sign-in tap. Flow `oauth-mr7vmbkm-1` emitted `oauth_started` at 0 ms, `callback_received` at 58,344 ms, `session_started` at 58,348 ms, `browser_returned` at 58,351 ms, `session_confirmed` at 58,596 ms, and `navigation_completed` at 58,636 ms. The callback source was `router`, transport was `code`, and browser result was `success`.
- Session persistence: force-stop and cold relaunch returned directly to the authenticated Portfolio tabs; the Google sign-in action was absent.
- Cancellation: closing the Google custom tab returned in 4,547 ms, emitted terminal `browser_dismiss` telemetry at 4,552 ms, cleared loading, and displayed `Google sign-in was cancelled. You can try again when ready.` with an enabled retry action.
- Background/foreground retry: while the account chooser was active, Home -> Recents -> FolioLens PR preserved the custom tab. Selecting the account then completed flow `oauth-mr7vr7c6-2`: callback at 77,319 ms, session start at 77,321 ms, browser return at 77,323 ms, session confirmation at 77,617 ms, and tab navigation at 77,661 ms.
- Privacy and failure scan: the captured `[auth/oauth]` records contained zero callback URLs, authorization-code values, access/refresh tokens, email addresses, or provider identities. Captured app logs contained zero auth lifecycle, SQLite, storage, React Native fatal, or unhandled-promise errors. The Android screen timeout was restored from the temporary 1,800,000 ms value to its original 120,000 ms.
- Post-evidence rebase: PR #258 changed only program documentation. Blob comparison proved all 19 A0-touched files byte-identical at measured commit `c729b14` and rebased head `2ba2c69`. Per the owner's explicit exception, redundant workflow run `28743946990` was cancelled and native evidence was not repeated.
- Cache-shape declaration: `useOAuthCompletion` and the SessionProvider regressions do not change any React Query key or serialized payload shape. The owner approved the `[cache-shape-stable]` PR-title marker required by the mechanical cache gate.

## Progress

- [x] Read AGENTS.md, VISION.md, the control report, Auth A0 prompt, findings 2 and 12, auth architecture, and PRs #43/#47/#52/#114/#236.
- [x] Verify the pre-PR manual OTA workflow on exact main SHA before starting A0.
- [x] Implement explicit PKCE and shared completion primitives.
- [x] Migrate sign-in, account linking, callback route, and root deep-link handling.
- [x] Add telemetry and regression tests.
- [x] Update auth architecture and README.
- [x] Run focused/full repository validation and six release exports.
- [x] Publish exact-SHA pre-PR OTA and capture native Android acceptance evidence.
- [ ] Open the ready implementation PR and obtain Codex/Claude convergence.
