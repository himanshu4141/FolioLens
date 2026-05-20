# Phase 6 / M2 — Resend Inbound Email + Per-User Auto-Refresh

## Goal

Replace the CASParser-based email forwarding flow with a self-hosted equivalent on `foliolens.in` using Resend receiving plus a production Vercel inbound router. Each user gets a unique inbound address; emails sent there are parsed by our Edge Function and imported automatically. Removes a paid third-party dependency, lands import notifications inside our own infrastructure, and unlocks one-tap (or fully-automatic, pending feasibility) refresh for users willing to forward their next CAS email.

## User Value

Today, refreshing a portfolio means re-running the entire upload flow once a month. Most users won't bother. After M2, a user who forwards their next CAMS / KFintech CAS email one time gets that import done without re-uploading; if their mail client supports a verified auto-forward filter, every future CAS lands automatically and the portfolio updates itself. We also retire the CASParser subscription, simplifying the bill and the codebase.

## Context

- **M1 must land first.** M2 adds the auto-refresh card to Step 3 of M1's wizard and a post-import nudge on Step 4.
- The domain `foliolens.in` is already verified with Resend for outbound transactional email (magic-link sign-in). Inbound is now also on the apex domain because the Resend free plan allows only one verified domain; subdomain-based dev/prod routing would require a paid plan.
- We have **one Resend account and one verified domain** (`foliolens.in`) but **two app environments** (dev + preview, prod). M2 must namespace inbound addresses so dev / prod don't share users' tokens or routing — see "Dev / prod environment differentiation" below.
- The current `cas-webhook` Edge Function on `main` accepts a CASParser-shaped payload and looks up the user via the `reference` field. Resend's payload shape is different and our webhook has to be rewritten.
- Two CASParser-coupled Edge Functions exist on `main`: `request-cas` (programmatically asks KFintech to email a CAS) and `create-inbound-session` (creates a per-user CASParser inbound mailbox). Both are called from the legacy onboarding screen which M1 retires.
- The `user_profile` table already has `pan`, `dob`, `kfintech_email`. M2 adds `cas_inbox_token`.
- **Theme + desktop reality.** Like M1, M2's UI surfaces (auto-refresh card on Step 3, post-import nudge on Step 4, Settings row) must read colors from `useClearLensTokens()`, define styles inside `makeStyles(tokens)`, and render correctly inside the desktop sidebar shell.

## Dev / prod environment differentiation

Single domain, single Resend account, and one Resend webhook endpoint. Resend owns the apex MX records for `foliolens.in` and POSTs every inbound `email.received` event to the Vercel router at `https://app.foliolens.in/api/resend-inbound-router`. The router verifies the Resend Svix signature, then routes by recipient local-part:

| Env  | User-facing address                | Resend Inbound pattern        | Webhook target                                 |
|------|-------------------------------------|-------------------------------|-------------------------------------------------|
| Dev  | `cas-dev-<token>@foliolens.in`      | all mail to `foliolens.in`    | Vercel router → `https://<dev-project-ref>.supabase.co/functions/v1/cas-webhook-resend` |
| Prod | `cas-<token>@foliolens.in`          | all mail to `foliolens.in`    | Vercel router → `https://<prod-project-ref>.supabase.co/functions/v1/cas-webhook-resend` |

The same router also replaces Cloudflare Email Routing for human aliases:

- `hello@foliolens.in`
- `support@foliolens.in`
- `privacy@foliolens.in`
- `security@foliolens.in`

Those aliases are forwarded to the owner Gmail using Resend's send API, with `reply_to` set to the original sender. Unknown recipients return 200 and are dropped.

The wizard / Settings UI still builds addresses from environment-aware helpers, but the environment marker now lives in the local-part (`cas-dev-…` for dev, `cas-…` for prod), not the domain. The Supabase Edge Function still reads `INBOUND_DOMAIN=foliolens.in` and verifies the original Resend `svix-*` signature forwarded by the router.

## Auto-forward feasibility discovery

The original M2 sketch leaned on a one-time Gmail / Outlook filter that auto-forwards every CAS email to the user's private CAS address. That assumed Gmail still allows arbitrary auto-forward filters. **It does not.** Since 2018, Gmail requires that the destination address either (a) be on a Google Workspace domain that has been allowlisted by the destination admin, or (b) confirm ownership by clicking a link Google emails to the destination address.

For our setup, option (a) is unavailable (we are not a Google Workspace tenant for `foliolens.in`). Option (b) means the confirmation email lands at `cas-<token>@foliolens.in` (or `cas-dev-<token>@foliolens.in` on dev) — i.e. it passes through the Vercel router and then hits our `cas-webhook-resend` Edge Function. We currently have no path to surface that confirmation link back to the user inside FolioLens.

Outlook (consumer + Microsoft 365), Apple Mail / iCloud, and Yahoo Mail likely have similar verification flows; we have not yet confirmed each.

### Discovery deliverables (M2.0, must complete before M2.4)

- **Document each major mail client's auto-forward verification flow** (Gmail consumer, Gmail Workspace, Outlook.com, Microsoft 365, iCloud, Yahoo). For each: does it require destination verification, and if so, how is the verification email delivered.
- **Decide one of three paths** based on what the discovery turns up:
  1. **Auto-forward path remains viable.** The Edge Function detects a verification email (sender pattern `forwarding-noreply@google.com` etc.), extracts the confirmation link, surfaces it to the user via the Settings → Auto-refresh row.
  2. **Manual-forward only.** Drop the auto-forward pitch entirely; M2.4's card pitches "Forward your next CAS email and your portfolio updates automatically — no auto-forward filter needed." User forwards each monthly CAS by hand. Still cheaper than re-uploading.
  3. **Hybrid.** Try auto-forward; if the user's client doesn't support it, fall back to manual-forward instructions.
- **Update the copy catalog in `00-onboarding-redesign.md` and the Settings hint copy** to match whichever path is chosen.

This discovery unblocks M2.4 (auto-refresh card UX) and M2.5 (Settings row copy). Until it's done, the M2 backend (M2.1–M2.3, already shipped) continues to work — it processes whatever CAS emails arrive, regardless of how the user got them there. We can begin manual-forward testing on dev today without finalising the discovery.

### Discovery findings — per-client breakdown

| Client | Filter / rule based forwarding? | Destination verification? | Verdict for FolioLens |
|---|---|---|---|
| **Gmail (consumer / `gmail.com`)** | Yes — Settings → Filters → "Forward to" action | **Required.** Adding a forwarding address triggers Google to email a confirmation code to the destination from `forwarding-noreply@google.com`. Subject: "Gmail Forwarding Confirmation". Body contains a 9-digit code and a confirmation URL. The destination must either click the URL or the user enters the code in Gmail's Forwarding settings. | **Auto-forward viable**, but only if we surface the confirmation URL back to the user from the verification email. Otherwise the filter never activates. |
| **Gmail Workspace** | Same as consumer. | Required by default. A Workspace admin can pre-allowlist external destination domains, in which case per-user verification is skipped. We are not the admin of users' orgs. | Same as consumer — surface URL or fall back. |
| **Outlook.com (consumer)** | Yes — Settings → Mail → Rules → Forward / Forward as attachment | **Not required.** Outlook applies the rule immediately to any destination address. | **Auto-forward works out of the box.** No FolioLens code needed beyond showing rule-creation instructions. |
| **Microsoft 365 (Exchange Online business)** | Same as Outlook.com — Inbox Rules support Forward. | Not required at the user level. Some tenants enable transport rules that block forwarding to external domains; that's a per-tenant admin setting outside our control. | Works for the majority of users. Tenant-level blocking falls back to manual forward. |
| **iCloud Mail** | **No filter / rule support.** Settings → Mail → Auto-Reply forwards the *entire inbox* to one address; cannot scope to "from CAMS / KFintech only". | Not required because there's nothing to scope. | **Not viable.** Forwarding everything to `cas-<token>@…` would spam our parser with non-CAS PDFs and is a privacy footgun. Manual forward only. |
| **Yahoo Mail (free)** | **No auto-forward.** Yahoo removed the feature for free accounts in 2014. | N/A | **Not viable.** Manual forward only. |
| **Yahoo Mail Plus** (paid) | Yes | Required, similar to Gmail. | Niche; treat as Gmail-equivalent if we ever encounter a paid Yahoo user. |
| **Apple Mail (macOS / iOS) backed by IMAP** | Forwarding is server-side (driven by the IMAP provider, not Apple Mail), so behaviour matches the provider. | Inherits from provider. | Same answer as the underlying provider. |

### Decision — Hybrid (Option 3)

The wizard's M2.4 auto-refresh card will pitch **manual forward as the universal default** and offer **opt-in auto-forward instructions per client family**, gated on what we can actually support:

| User's email client | What M2.4's card shows |
|---|---|
| Gmail / Workspace | Manual-forward primary CTA. Below: "Set up auto-forward" expander with 3 steps (open Forwarding settings, paste address, **come back to FolioLens to confirm the verification link**). Once the verification email arrives at our webhook, the Settings → Auto-refresh row exposes a "Confirm Gmail forwarding" button that opens the captured URL. |
| Outlook / Microsoft 365 | Manual-forward primary CTA. Below: "Set up auto-forward" expander with rule-creation instructions. No verification step. |
| iCloud / Yahoo (free) | Manual-forward primary CTA only. No auto-forward expander. |
| "Other / Not sure" | Manual-forward primary CTA. Auto-forward expander shows the generic "your client may need verification — paste the address and check your email" guidance. |

**Why hybrid over manual-only:** Outlook is free for users (one rule, no verification, set-and-forget) and Gmail is the most common client we'll see. Dropping auto-forward entirely for both would leave a real UX win on the table for the bulk of beta testers.

**Why hybrid over auto-forward-as-default:** iCloud + Yahoo-free can never auto-forward, and Gmail's verification-link UX is tedious enough that we should not lead with it. Manual forward "just works" and is the honest default.

### Implementation impact on M2.4 (future PR)

This decision shapes the M2.4 PR but **does not change M2.1–M2.3 (this PR's backend)**. Specifically, M2.4 will need:

- **A new migration** adding `cas_inbox_confirmation_url text` to `user_profile` (nullable; populated by the Edge Function when a verification email arrives).
- **A new branch in `cas-webhook-resend`** that detects Gmail's verification email pattern (`from = forwarding-noreply@google.com`, subject contains "Gmail Forwarding Confirmation") and stores the extracted URL on the user's profile instead of running the import path. Returns 200; no `cas_import` row.
- **UI**: the auto-refresh card on Step 3 + Settings → Auto-refresh row + a "Confirm Gmail forwarding" button that opens `cas_inbox_confirmation_url` in `expo-web-browser` (native) or a new tab (web), then clears the column once the user reports completion (or after a 24h TTL, since the link is single-use).
- **Auto-clear on success**: the next inbound CAS email proves the filter is active. M2.4's webhook can clear `cas_inbox_confirmation_url` opportunistically when it sees a successful import follow a verification, since there's no other way to know the user actually clicked.

We deliberately do **not** ship the migration or the verification-detection branch in this PR — they have no UI consumer until M2.4 lands, and adding dead schema to prod is a worse outcome than two migrations, given how cheap each migration deploy is.

## Assumptions

- Resend Inbound is available on the existing FolioLens Resend account at no incremental cost for the volumes we expect (a few hundred users × ~1 email/month each). If it isn't, the same pattern works with Postmark, SendGrid Inbound Parse, or Cloudflare Email Routing — only the webhook adapter changes.
- Resend Inbound supports receiving on the existing verified apex domain and sending one `email.received` webhook per inbound message.
- The Vercel-hosted CAS PDF parser at `${APP_BASE_URL}/api/parse-cas-pdf` accepts raw PDF bytes (already true on main).
- We are willing to delete `request-cas` (RTA email is no longer triggered server-side; user requests CAS themselves via the M1 portal flow).
- Apex MX cutover from Cloudflare Email Routing to Resend is acceptable; the Vercel router takes over the four human aliases Cloudflare used to forward.

## Definitions

- **Inbox token** — an 8-character random opaque string per user (e.g. `A8K3Z9P2`). Drawn from a 32-char base32 alphabet that excludes visually ambiguous chars (`I L O 0 1`).
- **Inbound domain** — `foliolens.in` for both dev and prod. Environment is encoded in the local-part.
- **Resend Inbound Router** — Vercel function at `/api/resend-inbound-router`; verifies Resend signatures, forwards human aliases, and dispatches CAS emails to the right Supabase project.
- **Manual forward** — user opens the CAS email from CAMS/KFintech and taps Forward → pastes their `cas-<token>@…` or `cas-dev-<token>@…` address → sends. Works on every mail client without extra setup.
- **Auto-forward filter** — a Gmail / Outlook rule that auto-forwards matching emails to the inbox token address. Subject to client-side verification (see "Auto-forward feasibility discovery" above).

## Scope

- Add `cas_inbox_token` column to `user_profile` with a generation function + trigger + per-row backfill.
- Add Edge Function `cas-webhook-resend` that accepts Resend's inbound payload, decodes the inbox token from the To address, looks up the user, fetches attachment bytes through Resend's Receiving API, and calls `parse-cas-pdf` for each PDF.
- Configure Resend MX records and the Vercel inbound router (manual; documented inline in the PR description).
- Add Step 3 "auto-refresh" card to the M1 wizard (currently a placeholder).
- Add a post-import nudge ("Set this up once and never re-upload") that surfaces on Step 4 (Done) of M1.
- Add Settings → Account → "Auto-refresh inbox" row that shows the user's inbox address, a Copy button, and the last refresh timestamp.
- Delete `request-cas` and `create-inbound-session` Edge Functions and any remaining call sites in app code.
- Deprecate the `CASPARSER_API_KEY` environment variable on Supabase Edge runtime (manual on Supabase Dashboard).
- Theme: every UI surface added by M2 reads from tokens; styles live inside `makeStyles`. No `ClearLensColors` literals.

## Out of Scope

- Verifying that the user actually set up the Gmail filter — out of scope; we just show the address and rely on the user.
- Detecting and de-duplicating reimports of the same PDF — already handled by `import-cas.ts` via per-folio reconciliation.
- Any UI for users to disable / regenerate their inbox token — defer to a later milestone if it becomes a real issue.

## Approach

When a user completes M1, they have a portfolio. On the post-import screen we show a card. Its copy and CTA depend on the M2.0 discovery outcome (auto-forward viable / manual-only / hybrid) — but in every variant the card surfaces the user's forwarding address (`cas-<token>@foliolens.in` on prod or `cas-dev-<token>@foliolens.in` on dev) and a Copy button.

On the backend side, the Vercel router accepts Resend's webhook payload first. For CAS recipients it forwards the unchanged raw body and `svix-*` headers to `cas-webhook-resend` on the dev or prod Supabase project. The Edge Function parses the inbox token from `to`, resolves the user, then runs the same import path that M1's upload uses — namely POSTing the PDF bytes to the existing Vercel parser and handing the result to the shared `import-cas.ts` helper.

We deliberately keep the parsing path unified (one `parse-cas-pdf` Vercel endpoint, one `import-cas.ts` helper) so M1's upload and M2's email-in produce identical outcomes. Tests for the import path don't multiply.

The Vercel router verifies the Resend Svix signature before any side effects. The Supabase Edge Function also verifies the same original signature forwarded by the router, so direct calls to the Edge Function still fail unless they carry a valid Resend signature.

## Alternatives Considered

- **Cloudmailin** (PR #75's approach) — generic email-to-webhook tool. Works, but adds a second email vendor on top of Resend. Rejected.
- **Cloudflare Email Routing** — already used for human aliases, but it owns apex MX and cannot coexist with Resend receiving on the same domain. Replaced with Resend + Vercel router so one provider owns inbound mail.
- **Keep CASParser** — the existing flow already works. Rejected because the user explicitly wants to drop CASParser and consolidate on `foliolens.in`.

## Milestones

### M2.0 — Auto-forward feasibility discovery (precedes UI work)

- Document each major mail client's auto-forward verification flow (Gmail consumer, Gmail Workspace, Outlook.com, Microsoft 365, iCloud, Yahoo Mail).
- Decide between auto-forward, manual-forward-only, or hybrid (see "Auto-forward feasibility discovery" above).
- Update copy in `00-onboarding-redesign.md` to match the chosen path. Update M2.4's UX accordingly.
- **Acceptance**: a written discovery note in this plan + an explicit decision recorded in the Decision Log section.

### M2.1 — Schema + token generation [shipped on `feat/cas-resend-inbound-m2`]

- Migration `20260504020000_user_profile_cas_inbox_token.sql`:
  - Adds `cas_inbox_token text unique` to `user_profile`.
  - Adds a function `gen_cas_inbox_token()` returning a random 8-char base32 string from alphabet `[A-HJKMNP-Z2-9]` (excludes `I L O 0 1`). 32⁸ ≈ 10¹² unique tokens.
  - Adds a `BEFORE INSERT` trigger that fills the column when null on row insert.
  - Backfills existing rows: `update user_profile set cas_inbox_token = gen_cas_inbox_token() where cas_inbox_token is null`.
  - Locks down the function: `revoke ... from public, anon, authenticated` then `grant execute ... to supabase_auth_admin` only.
- `database.types.ts` updated.
- **Acceptance**: every existing and new user has a unique 8-char `cas_inbox_token`; `select count(distinct cas_inbox_token) = count(*) from user_profile` is true.

### M2.2 — Resend Inbound Router + DNS (manual, single endpoint)

- Merge and production-release the Vercel router endpoint `https://app.foliolens.in/api/resend-inbound-router`.
- Enable Resend receiving on the existing `foliolens.in` domain.
- Create one Resend `email.received` webhook pointing at the router endpoint.
- Replace Cloudflare Email Routing apex MX records with Resend's apex MX records. Keep outbound TXT/DKIM/SPF intact.
- Set Vercel production env vars: `RESEND_API_KEY`, `RESEND_INBOUND_ROUTER_SECRET`, `MAIL_FORWARD_TO`, `MAIL_FORWARD_FROM`, `SUPABASE_DEV_FUNCTION_URL`, `SUPABASE_PROD_FUNCTION_URL`.
- Set the same Resend Svix secret on both Supabase projects as `RESEND_INBOUND_SECRET`, set `RESEND_API_KEY`, and set `INBOUND_DOMAIN=foliolens.in`.
- Smoke test human forwarding: send to `hello@foliolens.in`; expect a forwarded email in owner Gmail.
- Smoke test CAS dispatch after PR #93 deploys: send to `cas-dev-TESTTOKEN@foliolens.in`; Resend calls Vercel router, router calls dev Supabase, function returns unknown token.
- **Acceptance**: one Resend webhook endpoint handles human aliases, dev CAS, and prod CAS without extra Resend domains or subdomains.

### M2.3 — Edge Function `cas-webhook-resend` [shipped on `feat/cas-resend-inbound-m2`]

- `supabase/functions/cas-webhook-resend/index.ts`:
  - Reads `INBOUND_DOMAIN=foliolens.in` from `Deno.env` and parses `cas-dev-<token>` / `cas-<token>` local-parts.
  - Verifies the original Svix signature using `RESEND_INBOUND_SECRET` (timing-safe HMAC).
  - Looks up `user_profile` by `cas_inbox_token`; rejects 404 if no match.
  - For each PDF attachment, fetches bytes from Resend's Receiving API → POSTs to `${APP_BASE_URL}/api/parse-cas-pdf` with the user's PAN as password (and `cdsl_password` for CDSL/NSDL fallback).
  - Runs `importCASData` from `_shared/import-cas.ts`.
  - Inserts a `cas_import` row with `import_source = 'email'`.
  - Returns 200 on either success or expected user errors so Resend doesn't retry.
- Deployed with `--no-verify-jwt` (Resend cannot send a Supabase JWT).
- Structured `[cas-webhook-resend]` logs at invocation, signature OK, user resolution, per-attachment, completion.
- **Acceptance**: dev test email with a real CAS PDF imports successfully; `cas_import` table reflects the run; tampered signature rejects with 401; the function works against both dev and prod with no code change (only `INBOUND_DOMAIN` differs).

### M2.4 — Wizard Step 3 forwarding card + post-import nudge (hybrid flow per M2.0)

Implements the hybrid path locked in by M2.0 — manual forward as the universal default, opt-in auto-forward instructions per client family.

**New migrations**:

- Adds `cas_inbox_confirmation_url text` (nullable) to `user_profile`.
- Adds `cas_auto_forward_setup_completed_at timestamptz` (nullable) to `user_profile` so the user can explicitly mark provider-side auto-forward setup complete after the Gmail / Outlook rule is saved.
- Updates `database.types.ts`.

**Edge Function update** — `supabase/functions/cas-webhook-resend/index.ts` gains a new branch:

- Detect Gmail's verification email pattern: `from = forwarding-noreply@google.com` AND subject matches `/Gmail Forwarding Confirmation/i`.
- On match: extract the confirmation URL from the body (`https://mail.google.com/mail/vf-…`, `https://mail-settings.google.com/mail/vf-…`, or `https://isolated.mail.google.com/mail/vf-…`), `update user_profile set cas_inbox_confirmation_url = <url> where cas_inbox_token = <token>`, log `[cas-webhook-resend] gmail-verification-captured`, and return 200 without running the import path or inserting a `cas_import` row.
- Opportunistic clear: on a successful import (an actual CAS PDF), if `cas_inbox_confirmation_url is not null` for the user, set it back to null (the filter is now active and the link is single-use anyway).

**UI** — wizard Step 3 + Settings row + post-import nudge:

- Step 3 auto-refresh card (replaces the M1 placeholder slot):
  - Hero: address built from `EXPO_PUBLIC_INBOUND_DOMAIN` + Copy button.
  - Primary CTA: "Forward your next CAS email" (manual-forward primary path; works on every client without any setup).
  - Below the primary CTA: a collapsible "Or set up auto-forward" expander with platform tabs:
    - **Gmail**: forwarding-address setup, captured verification-link CTA when available, exact filter query for `donotreply@camsonline.com` / `samfS@kfintech.com`, and a checklist the user marks complete before saving "auto-forward ready".
    - **Outlook / Microsoft 365**: rule instructions using the same CAMS / KFintech senders; no verification step.
    - **iCloud / Yahoo**: copy that explains why auto-forward isn't supported on these clients ("Your inbox doesn't allow filtered auto-forward — please use manual forward instead.").
    - **Other / not sure**: generic guidance, falls back to manual.
- Settings → Account → Auto-refresh row (M2.5):
  - Address + Copy button.
  - Last refresh timestamp + source ("via auto-refresh" / "via upload").
  - When `cas_auto_forward_setup_completed_at` is non-null: status reads "Auto-forward ready for future CAMS / KFintech emails".
  - When `cas_inbox_confirmation_url` is non-null and setup is not completed: a "Confirm Gmail forwarding" button opens the URL in `expo-web-browser` (native) / new tab (web).
- Settings → Portfolio import:
  - Reads the Resend inbox address from `user_profile.cas_inbox_token` rather than the retired CASParser inbound-session API.
  - Shows auto-forward readiness, pending Gmail verification, latest import source/status, and opens the M1 import wizard for both setup review and manual PDF fallback.
- After M1.5's Done step, single-card nudge with the same Step 3 card content.
- All colors via tokens; styles via `makeStyles(tokens)`. Verify in light + dark + system, on mobile + desktop.

**Acceptance**:

- A user can copy the address, forward a CAS email by hand, and receive the import (manual flow works for all clients).
- A Gmail user can paste the address into their Forwarding settings, see the confirmation button surface in FolioLens within ~30 sec, create a sender filter for `donotreply@camsonline.com` / `samfS@kfintech.com`, mark the checklist complete, and have subsequent CAS emails auto-import.
- An Outlook user can create a rule pointing at the address with no verification step and have subsequent CAS emails auto-import.
- The next successful import after a Gmail verification clears `cas_inbox_confirmation_url`.

### M2.5 — Settings hook + last-refresh

- Add a Settings → Account → "Auto-refresh inbox" row that shows the address + Copy button.
- Surface the last `cas_import` row's status and timestamp on the same row ("Last refresh: 2 hours ago"). If `import_source = 'email'`, show "via auto-refresh"; otherwise "via upload".
- **Acceptance**: refreshing the row after sending a test email updates the timestamp.

### M2.6 — Retire CASParser

- Delete `supabase/functions/request-cas/`.
- Delete `supabase/functions/create-inbound-session/`.
- Remove all `supabase.functions.invoke('request-cas', ...)` and `supabase.functions.invoke('create-inbound-session', ...)` call sites — replace with a router push to the M1 import wizard. After M1 lands, these call sites already disappear from `app/onboarding/index.tsx`; M2 confirms there are no stragglers.
- Remove `CASPARSER_API_KEY` from `.env.example`; request that the user removes it from Supabase secrets manually.
- **Acceptance**: `grep -r "casparser\|request-cas\|create-inbound-session" src/ app/ supabase/` returns nothing in code (docs may still mention historical context).

### M2.7 — Tests + manual validation

- Unit tests for the inbox-token generator (uniqueness, character set).
- Unit tests for the To-header parser (handles `<cas-dev-ABC23456@foliolens.in>` and `cas-ABC23456@foliolens.in` and quoted forms).
- Edge function happy-path test using a recorded Resend payload fixture.
- Manual checklist:
  - Send a real CAS PDF email from CAMS to your token address — webhook fires, import succeeds.
  - Tamper with signature → webhook rejects with 401.
  - Token mismatch → webhook returns 404.
  - Settings row shows updated last-refresh timestamp.
  - Sign-out clears local state but token persists in DB.

## Validation

- `npm run typecheck` — zero errors.
- `npm run lint` — zero warnings.
- `npx jest --ci --coverage` — all suites pass; project floor and `src/utils/` thresholds hold.
- Migration applies cleanly to dev and prod via the existing `supabase-deploy-{dev,prod}.yml` workflows.
- One real CAMS email and one real KFintech email each round-trip end-to-end during M2.7 manual validation.

## Amendments

- 2026-05-06 — Removed the Clear Lens "Sync portfolio" quick action because FolioLens no longer programmatically asks an RTA to email a CAS. Mobile overflow and desktop sidebar now expose one `Import portfolio` action that opens the onboarding import flow.
- 2026-05-06 — Reworked Settings → Portfolio import away from the old CASParser inbound session model. The screen now uses the Resend inbox token, shows auto-forward setup state, and routes manual PDF upload through the newer onboarding import flow instead of deep-linking to `/onboarding/pdf`.
- 2026-05-06 — Removed the unused client hook and tests for `create-inbound-session`. The Edge Functions themselves remain for the explicit M2.6 retirement cleanup.
- 2026-05-06 — Added a holding-mode branch to onboarding. AMC / folio users are routed to CAMS / KFintech, demat / broker users are routed to CDSL / NSDL Detailed CAS, and unsure users see both paths. Auto-refresh remains scoped to CAMS / KFintech because it depends on predictable RTA CAS emails.
- 2026-05-06 — Inbound and manual PDF imports now reject parsed PDFs that contain holdings but zero transaction rows with a clear "Detailed CAS required" error instead of recording an apparently successful `0 transactions` import.
- 2026-05-06 — Inbound PDF imports now send Clear Lens styled status emails through Resend Templates to the user's auth email. Success messages include fund / transaction counts; failures explain the next action and keep the Resend response idempotent by import id. DEV and PROD use separate template ids / aliases and distinct From addresses (`noreply-dev@foliolens.in` vs `noreply@foliolens.in`).
- 2026-05-06 — `gen_cas_inbox_token()` is now deterministic — token is a stable hash of the user's UUID instead of a random sequence. Previously, deleting and recreating a `user_profile` row (a real path used for dev resets) handed the user a brand-new token and silently broke any Gmail / Outlook auto-forward filter pointing at the old `cas-<old-token>@foliolens.in` address. New rows generated post-migration are stable across recreations; existing rows keep their pre-migration tokens (no backfill, since their tokens are already wired into live forwarding filters).
- 2026-05-06 — Webhook now finalises imports in `EdgeRuntime.waitUntil(...)` instead of inline. The full path (Resend Receiving fetch + attachment download + Vercel parser + `importCASData` upserts) takes 20–40 s end to end, well past Svix's hard 15 s delivery timeout — the timeout was triggering Resend retries which produced duplicate `cas_import` rows plus duplicate notification emails (the dedup upsert kept the data correct but the second row landed at 0 funds / 0 transactions and the user got a "could not import" follow-up to a CAS we'd already imported). The sync handler now writes a `pending` audit row, hands off to a background processor, and returns 200 in <1 s. A catch-all in the background processor guarantees the row never stays `pending` on a hard crash and the user gets a failure notification instead of silence.
- 2026-05-06 — Resend template variables must be strings — sending `FUNDS_UPDATED: 21` (number) returns a 422 `validation_error` even though the API docs allow numbers. Both numeric variables (`FUNDS_UPDATED`, `TRANSACTIONS_IMPORTED`) are now coerced with `String(...)` and the `buildImportNotificationVariables` return type is narrowed to `Record<string, string>` so TypeScript catches the regression. Notification-failure logging promoted to `console.error` with a stable `DROPPED notification_failed: import_id=… status=… error=…` tag for dashboard greppability — the import row stays accurate independently of email delivery, but until this commit the email-delivery failure was invisible from outside Resend's dashboard.
- 2026-05-06 — UX polish across the wizard + settings PAN / DOB / CAS surfaces, after walking the flows end-to-end. (a) Identity step now warns about PAN / DOB permanence *before* save, not just after — the locked-state hint only appears once a typo is already saved. (b) The Done step's "Settings → Account → Restart import" pointer was broken (no such row exists) and now points to "Settings → Portfolio import", which is the actual hub. (c) The "Treat this like a password" warning on the inbox address overstated the threat model (signature check is on Resend's envelope, not per-sender) and is reframed as "treat the address like an unlisted phone number." (d) The Gmail completion checklist was phrased as system claims ("Gmail accepted the FolioLens address") even though the boxes are manually ticked by the user; reworded in first-person ("I added the forwarding address" etc.). (e) The same concept was variously labelled "FolioLens inbox", "private import address", "private FolioLens address", and "FolioLens address" across three files; settled on "FolioLens import inbox" everywhere.
- 2026-05-20 — `AutoRefreshSetup` repainted with the Direction B hero from the onboarding redesign (PR #174). New eyebrow + H1 ("Skip the upload from now on.") and a two-step honest explanation ("One-time: set up a Gmail or Outlook filter… From then on, every new statement flows in by itself.") replace the older "Set up auto-refresh" intro. The "RECOMMENDED" badge moved off the manual-forward card so auto-forward reads as the primary path; manual stays as the universal fallback below. Underlying Gmail / Outlook checklist mechanics (verification capture, per-client tabs, completion handler) are unchanged. A new `onboarding_auto_refresh_setup_completed` PostHog event fires when the user marks setup complete, pairing with the existing `cas_auto_forward_setup_completed_at` DB write so funnels comparing "imported a PDF" → "set up auto-forward" work without a SQL join.

## Follow-ups

The four UX items from this list and the two GitHub issues Codex filed (#108, #107) are all picked up on the `chore/m2-followups` branch:

- ~~**Rename `kfintech_email` UI label.**~~ Shipped — Account screen now labels the row "Email at CAMS / KFintech" with a sub explaining the purpose.
- ~~**In-wizard "Wrong PAN? Request correction" link.**~~ Shipped — locked Identity-step hints surface the same FeedbackSheet correction flow Account uses, so the user never has to leave the wizard.
- ~~**Settings IA consolidation.**~~ Shipped — the "Auto-refresh inbox" row was removed from Account; Portfolio import is now the canonical home for inbox state. Account stays focused on identity.
- **Sticky button footers in the wizard.** Deferred — `Continue` / `Upload the PDF` still sit at the end of the ScrollView and can scroll out of view on long content. A `position: absolute` bottom bar would prevent users from missing the CTA on first-run; the refactor touches the wizard's layout primitives so it's worth its own PR.
- ~~**Issue #108 — retire CASParser.in API.**~~ Shipped — `request-cas`, `create-inbound-session`, and `cas-webhook` Edge Functions deleted; `CASPARSER_API_KEY` row removed from INFRASTRUCTURE.md (operator deletes the secret from both Supabase project dashboards). Python `casparser` library + `api/_cas_parser.py` retained per the issue's scope.
- ~~**Issue #107 — route Resend out of Supabase.**~~ Shipped — Supabase no longer reads `RESEND_INBOUND_SECRET` or `RESEND_API_KEY`. Vercel router fetches Resend Receiving content + signs a normalized payload with `FOLIOLENS_INBOUND_ROUTER_SECRET`; Supabase verifies the FolioLens HMAC and downloads attachments via Resend's presigned URLs. Outbound notification emails go through a new `api/cas-import-notify.py` endpoint that Supabase calls with the same FolioLens HMAC. See INFRASTRUCTURE.md for the new secrets layout.

## Risks And Mitigations

- **Risk**: Resend Inbound has a delivery hiccup and emails are silently dropped. **Mitigation**: log every webhook fire to `cas_import` with the raw payload (hash) so we can reconcile against Resend's dashboard.
- **Risk**: User forwards an email that isn't a CAS (random PDF). **Mitigation**: parser already returns "no mutual fund data found" — webhook records this in `cas_import` with a clear error message; user sees it in Settings.
- **Risk**: Spam to the CAS local-parts on `foliolens.in`. **Mitigation**: only attachments with content-type `application/pdf` and size < 10 MB are processed; everything else returns 200 silently.
- **Risk**: User deletes the inbox token by accident (UI bug or manual SQL). **Mitigation**: token is generated by trigger on insert; provide a "Regenerate token" admin path later if this becomes a real issue.
- **Risk**: CASParser-using code paths are missed during M2.6 cleanup. **Mitigation**: the grep step in M2.6's acceptance is the gating check.

## Decision Log

- 2026-05-04 — Chose Resend Inbound over Cloudmailin to consolidate email vendors on the existing `foliolens.in` Resend account.
- 2026-05-04 — Initially chose plus-addressing (`cas+token@foliolens.in`) over wildcard subdomain (`cas-<token>@foliolens.in`) because plus-addressing required no DNS change beyond the one MX record set.
- 2026-05-04 — Decided not to verify Gmail filter completion (no programmatic way to detect it; would over-engineer the milestone). **Superseded 2026-05-05 — see M2.0 entry below.**
- 2026-05-05 — Renumbered from Phase 5 to Phase 6 (Phase 5 is now Desktop Web). M2 ships strictly after M1; both must honour PR #95 + #97 design realities.
- 2026-05-05 — Subdomain namespacing (`dev.foliolens.in` for dev, `foliolens.in` for prod) was chosen for env differentiation, then superseded by the 2026-05-06 router decision after Resend free-plan testing showed subdomains count as separate domains.
- 2026-05-05 — **(M2.0 outcome)** Chose hybrid path for the auto-refresh card: manual forward as universal default, opt-in auto-forward instructions per client family (Gmail with confirmation-link surfacing, Outlook with no extra steps, iCloud + Yahoo skip auto-forward entirely). Reasoning: manual works for everyone with zero friction; Outlook is free for users; Gmail's verification-link tedium is gated behind an opt-in expander rather than the default. Drops the 2026-05-04 "no Gmail verification" decision because the captured-URL + UI-button pattern turned out to be cheaper than I'd assumed.
- 2026-05-06 — Revised inbound architecture after Resend free-plan testing: subdomains count as extra domains, so Resend now owns apex inbound for `foliolens.in`; a PROD Vercel router handles human aliases plus dev/prod CAS dispatch. CAS addresses are `cas-dev-<token>@foliolens.in` for dev and `cas-<token>@foliolens.in` for prod.
- 2026-05-06 — Removed the old "Sync portfolio" product language from app navigation. Refresh now means either auto-forwarded future CAS emails or opening the import flow for a manual upload/setup review.

## Progress

- [x] M2.0 — Auto-forward feasibility discovery + decision (this plan, 2026-05-05; see "Discovery findings" + "Decision" sections above)
- [x] M2.1 — Inbox-token schema + generation + backfill (PR #93)
- [x] M2.2 — Resend inbound router + DNS cutover — router PR, see SETUP.md
- [x] M2.3 — `cas-webhook-resend` Edge Function with env-driven `INBOUND_DOMAIN` (PR #93)
- [x] M2.4 — Hybrid auto-refresh card on wizard Step 3 + `cas_inbox_confirmation_url` migration + Gmail verification capture in webhook + opportunistic clear after successful CAS import + Settings → Auto-refresh row + post-import nudge on Done step (PR #93, stacked on top of #92)
- [x] M2.5 — Settings → Account "Auto-refresh inbox" row with address + Copy + last-refresh timestamp + Confirm Gmail button when verification URL pending (PR #93, folded into M2.4)
- [x] M2.6 — Retire CASParser code paths — PR #93 removed app call sites + `create-inbound-session` hook; the follow-up branch deletes the three legacy Edge Functions (`request-cas`, `create-inbound-session`, `cas-webhook`), drops the deprecated `CASPARSER_API_KEY` row from INFRASTRUCTURE.md, and updates `_shared/import-cas.ts`'s comment header. Acceptance grep `casparser\|request-cas\|create-inbound-session` over `src/ app/ supabase/` only matches the retained Python `casparser` library references (xirr edge cases + import-cas tests).
- [x] M2.7 — Tests for Gmail verification helpers (`supabase/functions/_shared/gmail-verification.ts`, 100% coverage); real-email round-trip is operator validation per `SETUP.md` §3
