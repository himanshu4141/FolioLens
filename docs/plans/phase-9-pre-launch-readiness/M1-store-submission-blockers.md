# Phase 9 M1 — Store Submission Blockers (Disclaimers, Account Deletion, App Store Metadata)


## Goal


Close every gap that prevents FolioLens from being submitted to the Apple App Store and Google Play Store. After this milestone, a reviewer at either store can find an in-app data deletion path, see a "not investment advice" disclaimer on every screen that surfaces portfolio data, click a working privacy policy link from the listing, and read a description that matches the product's legal position (analysis tool, not advisory).


## User Value


An investor who opens FolioLens for the first time, lands on any insight screen, or browses the listing on a phone never sees performance numbers without the legal framing that says these are calculations, not recommendations. A user who wants to leave the product can fully delete their data in two taps from Settings — no email-the-founder dance, no lingering rows in any database, no need to delete the auth user manually. A reviewer at Apple or Google can verify both flows, the privacy policy URL, and the listing copy without running a custom build.


## Context


FolioLens is a SEBI-jurisdiction Indian mutual-fund portfolio analysis tool. It is *not* a SEBI-registered investment adviser, *not* a distributor, and *not* a research analyst — the product's legal posture is explicitly "calculation and clarity, not advice." This is stated correctly in `foliolens-site/terms.html` and `foliolens-site/privacy.html` on the marketing site, but the in-app surface has no equivalent framing today.


Before this milestone:


- `git grep "investment advice"` returns zero matches in `app/` or `src/`.
- `app/(tabs)/settings/account.tsx` has no destructive actions — no delete, no danger zone.
- `app.config.js` has no `description`, no `privacy` URL, no `category`, no Apple privacy strings.
- `eas.json submit.production` is `{}` — no Apple App Store Connect or Google Play credentials.
- The marketing site already exposes `https://foliolens.in/privacy.html` and `https://foliolens.in/terms.html` — both are live and meet store policy on disclosure of data handling, third-party services, and user rights. We just don't link to them from anywhere in the app.


Two related audit findings are *out of scope* for this milestone but flagged so the reader doesn't expect them here:


- Crash reporting (Sentry / Crashlytics) — separate milestone (Phase 9 M2).
- Analytics events — separate milestone (Phase 9 M3).


## Assumptions


1. The marketing site is hosted on Cloudflare Pages and already serves `/privacy.html` and `/terms.html` — we treat those URLs as stable inputs to this milestone, not deliverables.
2. The Supabase service-role key is available to Edge Functions automatically as `SUPABASE_SERVICE_ROLE_KEY` (per `docs/INFRASTRUCTURE.md`). We do not need to add a new secret.
3. All user-data tables already cascade-delete from `auth.users` via FK constraints — this is true today (see `supabase/migrations/20260317000000_initial_schema.sql` and the `cas_inbound_flow` migration). The Edge Function only needs to delete the auth user; cascades remove the rest.
4. App Store and Play Store credentials (Apple Issuer ID + API Key + Play Console JSON key) will be added to GitHub Actions Secrets *after* this PR merges. The PR ships the `eas.json` shape, not the credential values.
5. Disclaimer copy is the same English string everywhere — we do not have a translations layer, and adding one is out of scope.


## Definitions


- **Insight screen** — any screen that shows derived numbers about a user's portfolio: home dashboard, fund detail, portfolio insights, money trail, leaderboard, wealth simulator, tools (goal planner). Distinguished from screens that show only raw inputs (CAS upload form, settings rows).
- **PortfolioDisclaimer** — the new shared component this milestone introduces; renders the standard "not investment advice" copy in Clear Lens styling. Non-dismissable, non-collapsible. Always inline at the bottom of a scroll container.
- **Danger Zone** — the conventional naming for a Settings sub-section that holds destructive actions (sign out, delete account). On `account.tsx` we add a third card titled "Account actions" with this content.
- **Account deletion** — irreversible removal of the user's `auth.users` row plus every dependent table row reachable via FK cascade. Distinct from sign-out (which only clears the local session).
- **Cascading FK** — Postgres `ON DELETE CASCADE` constraint that deletes child rows automatically when the parent is deleted. Already present on every user-scoped table in our schema.


## Scope


- New shared component `src/components/clearLens/PortfolioDisclaimer.tsx` with two variants: `compact` (one-line for headers/footers) and `inline` (3-line block for screen footers).
- Mount the disclaimer on every insight surface: portfolio home, portfolio insights, fund detail, funds list, money trail, wealth journey/simulator, tools hub, goal planner result, **past SIP check, compare funds, direct vs regular**, onboarding welcome step, and Settings → About. (The Leaderboard screen was retired upstream in PR #117 and is no longer in scope.)
- New Edge Function `supabase/functions/delete-account/index.ts` that authenticates the caller and deletes their `auth.users` row using the service-role key.
- New mutation hook `src/hooks/useDeleteAccount.ts` that emits an `account_deleted` PostHog event on successful delete (before the local sign-out clears the distinct id), then signs the local session out.
- New Settings → Account "Account actions" card with a destructive "Delete account" row, a confirmation sheet that requires typing the user's email to confirm, and a redirect to `/auth` after success.
- Extend `useTrackInsightViewed`'s `InsightSurface` enum with `past_sip_check`, `compare_funds`, and `direct_vs_regular` so the three new tool screens (added upstream after the original PR opened) emit the same `insight_viewed` events as every other insight surface — closes a coverage gap that surfaced during the rebase.
- `app.config.js` populated with `description`, iOS `infoPlist` privacy strings, Android `category`, and the privacy policy URL.
- `eas.json submit.production` block populated with the credential *shape* for both Apple App Store Connect and Google Play Console, with placeholder values referencing Actions secrets.
- Settings → About gets two new "Legal" link rows: "Privacy Policy" → `https://foliolens.in/privacy.html` and "Terms of Use" → `https://foliolens.in/terms.html`. Both open via `expo-web-browser` like the existing Help link.
- Jest unit tests for the deletion mutation covering: happy path (asserting `account_deleted` event fires and session is cleared), 401 (function returns error envelope), 5xx (function returns ok=false), and empty-body (function returns null data) — all four error paths must NOT emit the analytics event nor sign out.


## Out of Scope


- Crash reporting integration (Phase 9 M2).
- Analytics SDK + onboarding/portfolio events (Phase 9 M3).
- Storefront screenshots and marketing copy artwork — content production lives outside the repo. We populate the *config*, not the *assets*.
- Live submission of the actual store listings — that's a release activity, not a code change.
- A "soft delete" or undo window — App Store and Play Store both accept hard delete with a confirmation step; we ship that simpler path.
- Disclaimer translation / localisation.


## Approach


### Disclaimer component


One file: `src/components/clearLens/PortfolioDisclaimer.tsx`. Exports a single `<PortfolioDisclaimer />` component with an optional `variant?: 'inline' | 'compact'` prop (default `inline`). The component reads tokens via `useClearLensTokens()` and renders a `View` with `Ionicons name="information-circle-outline"` plus body text.


Copy (verbatim — do not paraphrase):


    inline:
      "FolioLens is a portfolio analysis and clarity tool. The numbers, charts,
      and comparisons shown here are not investment advice, recommendations, or
      a solicitation to buy, sell, or hold any mutual fund. Consult a
      SEBI-registered investment adviser before making financial decisions."

    compact:
      "Not investment advice. Calculated from your CAS data and AMFI disclosures."


We mount `inline` once at the bottom of every insight screen's scroll container, and `compact` on screens where space is tight (e.g., fund detail just under the fund name, or the goal-planner result card).


To keep the cross-screen edits small, the inline component is a self-contained block — it has its own padding, doesn't require a card wrapper, and styles itself against `cl.background` so it reads on every Clear Lens surface.


### Account deletion


Edge Function `supabase/functions/delete-account/index.ts` does five things, in order:


1. Reads the JWT from the `Authorization: Bearer <token>` header.
2. Verifies the JWT against `auth.users` using the per-request anon Supabase client; rejects with 401 if invalid.
3. Constructs a service-role Supabase client (`SUPABASE_SERVICE_ROLE_KEY`) and calls `supabase.auth.admin.deleteUser(userId)`.
4. Returns `{ ok: true }` on success or `{ ok: false, error }` on failure.
5. Logs a `[delete-account]` line at every step (per project memory: structured prefix logging on every Edge Function).


Cascading FK constraints already remove rows from: `user_profile`, `cas_import`, `cas_inbound_session`, `fund_portfolio_composition` (this is *not* user-scoped — it's a shared catalog, so cascades don't apply there, which is correct), `user_feedback`, `user_feedback_attachments`. The migration for each table has the cascade in place; deleting the auth user is sufficient.


No new migration is needed.


Client side:


- `src/hooks/useDeleteAccount.ts` — React Query `useMutation` that POSTs to the Edge Function with the current JWT. On success it calls `supabase.auth.signOut()` and routes to `/auth`. On failure it surfaces a string the caller can display.
- `src/components/DeleteAccountSheet.tsx` — a modal sheet with two-step confirmation: (a) explanation copy (b) input that requires typing the user's email to enable the destructive button. Uses the same Clear Lens patterns as `FeedbackSheet.tsx`.
- `app/(tabs)/settings/account.tsx` — adds a third card at the bottom labelled "Account actions" with one row: "Delete account" in `cl.negative` colour, opens the sheet on press.


### App Store metadata


`app.config.js` gains:


    description: 'FolioLens is a mutual fund portfolio analysis tool for Indian investors. Import CAS, see allocation, overlap, concentration, and performance vs benchmarks. Not investment advice.'

    privacy: 'https://foliolens.in/privacy.html'

    ios: {
      ...,
      privacyManifests: { ... }            // see "iOS privacy" below
      infoPlist: {
        NSCameraUsageDescription: 'FolioLens uses the camera to attach screenshots to feedback.',
        NSPhotoLibraryUsageDescription: 'FolioLens reads images you attach to feedback.',
      },
    }

    android: {
      ...,
      category: 'FINANCE',
    }


iOS privacy: the app does collect an email + portfolio data. Apple's App Privacy questionnaire is filled in App Store Connect, not the binary, so we don't need to embed every answer here. We do need the `NSCameraUsageDescription` / `NSPhotoLibraryUsageDescription` strings because `FeedbackSheet.tsx` triggers a media picker on attach. Without them the iOS build crashes the first time a user taps "Attach screenshot."


`eas.json submit.production` gains:


    submit: {
      production: {
        ios: {
          appleId: '<set via expo.dev secrets or eas submit --apple-id>',
          ascAppId: '<App Store Connect numeric app ID>',
          appleTeamId: '<10-char team ID>'
        },
        android: {
          serviceAccountKeyPath: './play-store-key.json',
          track: 'internal'
        }
      }
    }


The actual credentials are loaded from EAS secrets at submission time, not the repo. We document this in the milestone validation step.


### Settings → About legal links


Add two `LinkRow` entries to `about.tsx` between the support card and the sign-out card:


    <View style={styles.card}>
      <LinkRow icon="document-text-outline" label="Privacy Policy"
               onPress={() => WebBrowser.openBrowserAsync('https://foliolens.in/privacy.html', ...)} />
      <LinkRow icon="reader-outline" label="Terms of Use"
               onPress={() => WebBrowser.openBrowserAsync('https://foliolens.in/terms.html', ...)} isLast />
    </View>


This single block satisfies both Play Store policy ("privacy policy must be reachable from within the app") and App Store guideline 5.1.1(v) (data deletion + privacy reachable in-app).


## Alternatives Considered


- **Modal disclaimer on first launch instead of inline on every screen.** Rejected: SEBI's disclosure expectation is "before the user sees portfolio insight data," not "once at launch." A user who sees the home dashboard six months later still needs the framing. A modal is also dismissable; an inline banner is not.
- **Soft-delete with a 30-day undo.** Rejected for now: adds a `deleted_at` column, scheduled job, and email reactivation flow we don't currently have. Hard delete with a typed-email confirmation is acceptable to both stores.
- **Self-service deletion via a SQL function (`select delete_my_account()`).** Rejected: Postgres can't delete `auth.users` rows from the public schema; that table is in `auth.*` and only the service-role key can mutate it. An Edge Function is the right boundary.
- **Disclaimer as a full-screen modal users must accept once.** Rejected for the same reason as the first alternative — and adds friction to a product whose pitch is "calm clarity," not "scary legal walls."


## Architecture


    src/components/clearLens/PortfolioDisclaimer.tsx
      <PortfolioDisclaimer variant="inline" | "compact" />

    src/hooks/useDeleteAccount.ts
      useDeleteAccount() → { mutate, isLoading, error }
      deleteAccount() — exported async; emits `account_deleted` then signs out

    src/hooks/useTrackInsightViewed.ts (extended in this PR)
      InsightSurface += 'past_sip_check' | 'compare_funds' | 'direct_vs_regular'

    src/components/DeleteAccountSheet.tsx
      <DeleteAccountSheet visible onClose />

    supabase/functions/delete-account/index.ts
      POST /  →  { ok: true } | 401 | 5xx

    app/(tabs)/settings/account.tsx
      + "Account actions" card → "Delete account" row → opens sheet

    app/(tabs)/settings/about.tsx
      + "Legal" card → "Privacy Policy" + "Terms of Use" rows

    app.config.js
      + description, privacy, ios.infoPlist, android.category

    eas.json
      submit.production: ios { ... }, android { ... }


## Milestones


This is a single coherent PR — there are no internal milestones we want to ship separately. The work is broken into ordered tasks below for execution and progress tracking, not for shipping in stages.


### Order of operations


1. Add `PortfolioDisclaimer` component.
2. Mount it on every insight screen + onboarding + about (12 surfaces total after the rebase: portfolio home, insights, fund detail, funds list, money trail, wealth journey, tools, goal summary, past SIP check, compare funds, direct vs regular, settings → about; plus the onboarding welcome step).
3. Add the `delete-account` Edge Function.
4. Add `useDeleteAccount` hook + `DeleteAccountSheet` component. Hook emits `account_deleted` analytics event before sign-out.
5. Extend `InsightSurface` enum and call `useTrackInsightViewed` from each of the three new tool screens.
6. Add the "Account actions" card to `account.tsx`.
7. Add the "Legal" card to `about.tsx`.
8. Populate `app.config.js` (description, privacy, infoPlist, category).
9. Populate `eas.json submit.production`.
10. Add Jest test for `useDeleteAccount`.
11. Deploy the Edge Function (via MCP per `feedback_edge_function_deploy.md`).
12. Run typecheck + lint + tests + coverage. Push, open PR.


## Validation


### Static checks (must pass before PR is opened)


    npm run typecheck       # zero errors
    npm run lint            # zero warnings (--max-warnings 0)
    npm test                # all tests green
    npx jest --coverage     # ≥95% on src/utils/, overall ≥70%


### Behavioural validation (must be confirmed by hand on a running app)


- Open the app, navigate to: Home → Insights → Fund Detail → Funds list → Money Trail → Wealth Journey → Tools → Goal Planner. Each screen shows the inline disclaimer at the bottom of its scroll content.
- Open Onboarding (Welcome step). The disclaimer appears below the call-to-action.
- Open Settings → About. Privacy Policy and Terms of Use rows are present and open `foliolens.in/privacy.html` and `/terms.html` respectively in an in-app browser.
- Open Settings → Account. Scroll to bottom, see "Account actions" → "Delete account."
- Tap Delete account. Confirmation sheet appears. The destructive button is disabled until the user types their exact email.
- Type the wrong email — button stays disabled. Type the correct email — button enables.
- Tap the destructive button. Mutation fires, Edge Function returns 200, local session is cleared, app redirects to `/auth`. In Supabase Studio (DEV), confirm: the `auth.users` row is gone, and the corresponding `user_profile`, `cas_import`, and `user_feedback` rows are gone.
- Run the app on iOS simulator. Tap "Attach screenshot" in the feedback sheet. The system permission dialog appears with the new `NSPhotoLibraryUsageDescription` copy. (No crash.)


### Submission readiness


- Open `app.config.js`. Confirm `description`, `privacy`, `ios.infoPlist.NSCameraUsageDescription`, `ios.infoPlist.NSPhotoLibraryUsageDescription`, and `android.category` are all set.
- Open `eas.json`. Confirm `submit.production.ios` and `submit.production.android` are populated with the correct shape (real credentials are added later via `eas secret:create`, not in this PR).


## Risks And Mitigations


| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Edge Function deploy fails because of `../_shared/` import paths | Medium | Medium | Use the MCP `deploy_edge_function` tool with `_shared/` rewrites per `feedback_edge_function_deploy.md`. |
| Disclaimer copy on a screen scrolls *off* and is never seen | Low | High | Inline component is at the bottom of *every* `ScrollView` content, after the last meaningful card. Users always reach it because the alternative is leaving the screen with no resolution. |
| Cascade FK is missing on a table I'm not aware of | Low | High | Pre-migration sanity check: query `pg_constraint` for FK constraints referencing `auth.users` with `confdeltype = 'c'` and confirm all user-scoped tables are covered. Document the result in the PR description. |
| `auth.admin.deleteUser` fails partway and leaves orphaned rows | Very low | Medium | Postgres FK cascades happen inside the same transaction as the delete; partial state is impossible unless the cascade definition is wrong (covered by previous risk). |
| Privacy URL link breaks if the marketing site moves | Low | Medium | The URL is hardcoded in `app.config.js` and `about.tsx`; if it ever changes, both sites need to ship in lockstep. Documented in the marketing site README. |
| Apple rejects on age rating because it's not set in App Store Connect | Medium | Low | Age rating is configured via the App Store Connect questionnaire, not the binary. Out of scope for this PR but documented in the launch checklist. |


## Decision Log


- **2026-05-08**: Chose inline-on-every-screen disclaimer over a one-time modal — better matches SEBI's "before each disclosure" expectation, and avoids dismissability.
- **2026-05-08**: Chose hard delete over soft delete — both stores accept it with a confirmation step, and we don't have the infrastructure for a 30-day undo window.
- **2026-05-08**: Decided to put the deletion entry on `account.tsx` (under identity), not `about.tsx` (under support). Discoverable, convention-aligned, and keeps `about.tsx` focused on read-only info.
- **2026-05-08**: Chose to populate `eas.json submit.production` with the *shape* but not the credentials — credential values live in EAS secrets, never the repo.
- **2026-05-09**: Rebased onto `main` after Phase 9 M2 (#119, PostHog observability), tools-hub M2/M3/M4 (#99, #100, #101), TRI benchmarks (#104), and Resend inbound (#93) all merged. Three new tool screens (Past SIP Check, Compare Funds, Direct vs Regular) needed the same disclaimer treatment as the rest. The Leaderboard screen was retired upstream (#117) — its disclaimer mount was dropped from this PR via a `git rm` during conflict resolution.
- **2026-05-09**: Added `account_deleted` PostHog event to the deletion mutation. M2 shipped the analytics facade; emitting one more event during deletion costs nothing and gives the funnel a measurable terminal state. Event fires *before* `signOut()` so it's attributed to the user's distinct id rather than landing on a fresh anonymous id post-reset.
- **2026-05-09**: Extended the `InsightSurface` enum (originally introduced in M2) with `past_sip_check` / `compare_funds` / `direct_vs_regular` so the three new tool screens emit `insight_viewed` events. This is technically M2 territory but the rebase made it a natural sibling of the disclaimer mounts, and shipping both in one PR avoids two rounds of touching the same files.


## Progress

- [x] PortfolioDisclaimer component created (`src/components/clearLens/PortfolioDisclaimer.tsx`)
- [x] Disclaimer mounted on Portfolio home (`ClearLensPortfolioScreen.tsx`)
- [x] Disclaimer mounted on Portfolio Insights (`ClearLensPortfolioInsightsScreen.tsx`)
- [x] Disclaimer mounted on Fund Detail (`app/fund/[id].tsx`)
- [x] Disclaimer mounted on Funds list (`ClearLensFundsScreen.tsx`)
- [x] Disclaimer mounted on Money Trail (`app/money-trail/index.tsx`)
- [x] Disclaimer mounted on Wealth Journey (`ClearLensWealthJourneyScreen.tsx`)
- [x] Disclaimer mounted on Tools hub (`ClearLensToolsScreen.tsx`)
- [x] Disclaimer mounted on Goal Planner result (`ClearLensGoalSummaryScreen.tsx`)
- [x] Disclaimer mounted on Past SIP Check (`ClearLensPastSipCheckScreen.tsx`)
- [x] Disclaimer mounted on Compare Funds (`ClearLensCompareFundsScreen.tsx`)
- [x] Disclaimer mounted on Direct vs Regular (`ClearLensDirectVsRegularScreen.tsx`)
- [x] Disclaimer mounted on Onboarding welcome (`app/onboarding/index.tsx`)
- [x] Disclaimer mounted on Settings → About
- [x] `delete-account` Edge Function written + deployed via MCP
- [x] `useDeleteAccount` hook written + emits `account_deleted` PostHog event on success
- [x] `DeleteAccountSheet` component written
- [x] Settings → Account "Account actions" card added
- [x] Settings → About "Legal" card with Privacy + Terms links added
- [x] `app.config.js` populated (description, privacy, infoPlist, category)
- [x] `eas.json submit.production` populated
- [x] `useTrackInsightViewed` `InsightSurface` enum extended with `past_sip_check` / `compare_funds` / `direct_vs_regular`; hook called from each new screen
- [x] Jest test for `useDeleteAccount` covers happy path (with `account_deleted` event assertion) + 401 + 5xx + empty-body
- [x] `npm run typecheck` zero errors
- [x] `npm run lint --max-warnings 0` zero warnings
- [x] `npm test` green
- [x] `npx jest --coverage` meets thresholds
- [x] PR opened against `main`
