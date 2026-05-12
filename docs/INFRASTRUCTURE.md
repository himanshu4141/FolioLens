# FolioLens Infrastructure


This document is the canonical reference for how FolioLens runs in production and development. It covers every service the app touches, the boundaries between dev and prod, the workflows that ship code and data, and the manual config that lives outside the repo. Read this when joining the project, when adding new infra, or when something in CI/CD breaks.


## High-level picture


FolioLens has **two fully isolated environments** — DEV and PROD — that share no data, no users, and no auth tokens. Each environment has its own Supabase project, its own Vercel project, its own Google OAuth client, its own EAS Update channels, and its own native app variant. They do share **one** of each platform account (Supabase, Vercel, Resend, Expo, Google Cloud), but resources inside those accounts are split.


The mobile app exists in three flavours so we can ship safely:


| Build | Source of code | Source of data | Audience |
|-------|----------------|----------------|----------|
| `production` | `foliolens-production` EAS channel (only updated on tag push) | PROD Supabase | Beta users |
| `preview-main` | `foliolens-main` EAS channel (updated on every `main` merge) | DEV Supabase | Early testers (you + friends) |
| `preview-pr` | `foliolens-pr` EAS channel (updated on every PR commit) | DEV Supabase | PR reviewers |


The web app at `https://app.foliolens.in` runs the same Expo Router code, exported via `expo export --platform web` and served by Vercel. The PROD Vercel project is **disconnected from GitHub** so it only deploys when the production-release workflow pushes it; the DEV Vercel project auto-deploys every PR (preview) and every `main` merge (production).


## Domain map


| Domain | Hosted on | Purpose |
|--------|-----------|---------|
| `foliolens.in` | Cloudflare | Marketing landing page + privacy / FAQ |
| `app.foliolens.in` | Vercel (PROD project: `foliolens`) | Production web app |
| `foliolens-dev.vercel.app` | Vercel (DEV project: `foliolens-dev`) | Dev web app + PR previews |
| `<*>.vercel.app` | Vercel (DEV project) | Per-PR preview URLs |
| `cas-<token>@foliolens.in` | Resend Inbound → Vercel router → PROD Supabase (M2 incoming) | Production per-user CAS forwarding inbox |
| `cas-dev-<token>@foliolens.in` | Resend Inbound → Vercel router → DEV Supabase (M2 incoming) | Dev / preview per-user CAS forwarding inbox |
| `hello@foliolens.in`, `support@foliolens.in`, `privacy@foliolens.in`, `security@foliolens.in` | Resend Inbound → Vercel router | Human-facing aliases forwarded to the owner Gmail |
| `noreply@foliolens.in` | Resend SMTP / API (PROD) | Magic-link + transactional email — prod |
| `noreply-dev@foliolens.in` | Resend SMTP / API (DEV) | Magic-link + transactional email — dev |


## The two Supabase projects


Both run Postgres 17, the same schema (kept in sync via migrations under `supabase/migrations/`), and the same set of Edge Functions. They differ only in user data, auth credentials, and SMTP sender.


| | DEV project | PROD project |
|---|---|---|
| Reference | `imkgazlrxtlhkfptkzjc` | `ohcaaioabjvzewfysqgh` |
| URL | `https://imkgazlrxtlhkfptkzjc.supabase.co` | `https://ohcaaioabjvzewfysqgh.supabase.co` |
| Site URL (Auth) | `https://foliolens-dev.vercel.app` | `https://app.foliolens.in` |
| Magic-link sender | `noreply-dev@foliolens.in` (FolioLens Dev) | `noreply@foliolens.in` (FolioLens) |
| Google OAuth client | DEV-specific Web Client ID | PROD-specific Web Client ID |
| Migrations applied by | `supabase-deploy-dev.yml` (auto on main merge) | `supabase-deploy-prod.yml` (manual workflow_dispatch) |
| Edge functions deployed by | same workflow | same workflow |
| Native scheme allowlist | `foliolens-dev://`, `foliolens-main://`, `foliolens-pr://` | `foliolens://` |


### What lives in Supabase


- **Auth** — magic-link + Google OAuth. PKCE flow on native. JWT-based sessions stored client-side.
- **Database** — `user_profile`, `cas_import`, `cas_inbound_session`, `fund_portfolio_composition`, `nav_history`, `index_history`, `scheme_master`, `user_feedback`, plus per-user views (e.g. `fund`).
- **Edge Functions** — listed below.
- **Storage** — currently one bucket: `user-feedback-attachments` (private, 10 MB cap, image MIME types only).
- **pg_cron** — scheduled NAV / index / fund-meta sync jobs (see Edge Functions table).


### Edge Functions


| Function | Trigger | Purpose | Status |
|---------|---------|---------|--------|
| `parse-cas-pdf` | Native upload from app | Forwards a binary PDF to the Vercel-hosted Python parser, then runs `_shared/import-cas.ts` | Active |
| `cas-webhook` | CASParser inbound-email webhook | Receives parsed CAS payload from CASParser and imports it | **Deprecated, replaced by `cas-webhook-resend`** (still on disk while M2.6 retires call sites) |
| `cas-webhook-resend` | Vercel inbound router | Receives Resend-signed CAS webhook payloads routed by `/api/resend-inbound-router`, looks up user via `cas_inbox_token`, fetches email content / attachments through Resend, calls Vercel parser, imports | M2 (PR #93) |
| `request-cas` | App "Sync portfolio" tap | Triggers KFintech CAS email via CASParser API | **Deprecated**, retired in M2.6 |
| `create-inbound-session` | First onboarding | Creates a per-user CASParser inbound mailbox | **Deprecated**, retired in M2.6 |
| `sync-nav` | pg_cron (hourly) | Pulls NAV history from mfapi.in for every active scheme | Active |
| `sync-index` | pg_cron (hourly) | Pulls benchmark index closes from yahoo finance | Active |
| `sync-fund-portfolios` | pg_cron (monthly) | Pulls AMFI portfolio composition disclosures | Active |
| `sync-fund-meta` | pg_cron (daily) | Refreshes scheme metadata (AUM, expense ratio, risk) | Active |
| `notify-feedback` | AFTER INSERT trigger on `public.user_feedback` (via `pg_net.http_post`) | Sign-and-forward relay: looks up the user's auth email (for reply-to), signs a payload with `FOLIOLENS_INBOUND_ROUTER_SECRET`, and POSTs to the Vercel router's `/api/feedback-notify` endpoint which performs the actual Resend send | Active |


All cron-triggered functions are deployed with `--no-verify-jwt` because pg_cron has no JWT to send. `notify-feedback` is deployed the same way so the DB trigger can call it without needing a service-role key embedded in the SQL function.


### One-time per-project bootstrap: `app.supabase_functions_base_url`


Cron migrations introduced from Phase 9 M5 onwards build their target URL from `current_setting('app.supabase_functions_base_url')` instead of hardcoding a project ref, so the same migration file applies cleanly to dev and prod.

Each Supabase project needs the setting populated **once**, via the Dashboard SQL Editor (or any `psql` session as the `postgres` role):

    -- DEV project
    ALTER DATABASE postgres
      SET app.supabase_functions_base_url = 'https://imkgazlrxtlhkfptkzjc.supabase.co/functions/v1';

    -- PROD project (run from the PROD project's SQL editor only)
    ALTER DATABASE postgres
      SET app.supabase_functions_base_url = 'https://ohcaaioabjvzewfysqgh.supabase.co/functions/v1';

Re-running is safe; `ALTER DATABASE … SET` overwrites the existing value. If the setting is missing the cron job logs `unrecognized configuration parameter "app.supabase_functions_base_url"` at execution time — the intended failure mode, since silently calling the wrong project's edge functions is worse than failing loudly.

All current pg_net call sites — the four cron schedules (`sync-nav-hourly`, `sync-index-hourly`, `sync-portfolio-composition-hourly`, `sync-fund-meta-daily`) and the `notify_feedback_inserted` trigger function — use this parameterised pattern (retrofitted in migration `20260513000000_parameterise_existing_cron_urls.sql`). Any new pg_net call site added going forward should follow the same `current_setting('app.supabase_functions_base_url')` lookup rather than hardcoding a project ref.

`notify-feedback` follows the same Issue #107 architecture as `cas-webhook-resend`: Resend secrets stay at the router boundary, not on Supabase. **No new Supabase env vars are required** — the function reuses `FOLIOLENS_INBOUND_ROUTER_SECRET` and `NOTIFY_ENVIRONMENT` (both already set for `cas-webhook-resend`). An optional `ROUTER_FEEDBACK_NOTIFY_URL` can override the default `https://app.foliolens.in/api/feedback-notify` for local testing.

The Vercel side (`api/feedback-notify.py`) reuses the existing `RESEND_API_KEY`, `MAIL_FORWARD_TO` (founder inbox), and `MAIL_FORWARD_FROM` (verified sender) env vars — same ones that already power human-alias forwarding and CAS import notifications. **No new Vercel env vars are required.**


## Vercel projects


| | DEV project (`foliolens-dev`) | PROD project (`foliolens`) |
|---|---|---|
| Project ID | `prj_EQ1YcOJeh9nzDnjk4mdPRi4y7zOR` | `prj_mjY4K0rYmgNhoGMyJ5oC9xMLcTAi` |
| Team | `team_HeMWH6xlqe2BOC0NpT85uZPV` (one team for both) |
| GitHub integration | Connected — auto-deploys main as production, every PR as a preview | **Disconnected** — only deploys via `production-release.yml` on tag push |
| Production domain | `foliolens-dev.vercel.app` | `app.foliolens.in` (CNAME from Cloudflare) |
| Build command | `expo export --platform web` (default for Expo template) | same |
| Env vars (build-time) | `_DEV` values for `EXPO_PUBLIC_SUPABASE_URL`, `EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `EXPO_PUBLIC_APP_BASE_URL` | `_PROD` values for the same |


## Resend


Single Resend account on the verified domain `foliolens.in`. Used for two purposes:


1. **Outbound** — Supabase Auth's SMTP setting points at `smtp.resend.com:465` and uses a Resend SMTP key. Two different Resend "addresses" / sender names are configured per Supabase project so dev and prod emails don't blur: DEV sends as `FolioLens Dev <noreply-dev@foliolens.in>`, PROD sends as `FolioLens <noreply@foliolens.in>`.
2. **Inbound** (M2) — Resend owns the apex MX records for `foliolens.in` and POSTs every `email.received` event to `https://app.foliolens.in/api/resend-inbound-router`. The Vercel router verifies the Resend Svix signature, forwards human aliases to the owner Gmail, and forwards CAS messages to the matching Supabase project:
   - `cas-dev-<token>@foliolens.in` → DEV `cas-webhook-resend`
   - `cas-<token>@foliolens.in` → PROD `cas-webhook-resend`

   **Recipient discovery is multi-source** so both manual forwards (user types the cas-XXX address themselves) and auto-forwards (Gmail / Outlook / Postfix / Exim, which preserve the original `To:` and stamp the real destination into a forwarding-marker header) route correctly. Order of resolution: `data.to/cc/bcc` → `Delivered-To` / `X-Original-To` / `X-Forwarded-To` / `Envelope-To` / `X-Rcpt-To` headers → `Received: ... for <addr>` chain → singular `envelope_to` / `recipient` / `rcpt_to` keys → fallback fetch of the full email via the Resend Receiving API (`GET /emails/receiving/{email_id}`) when the lightweight webhook payload omits headers entirely.

The inbound CAS path also sends a FolioLens-branded status email to the user's auth email after each PDF import attempt. These are application-triggered Resend Template emails, not Supabase Auth templates. DEV and PROD must use distinct template ids / aliases and From addresses:

| Environment | Template source | Required sender |
|---|---|---|
| DEV | `supabase/templates/resend_cas_import_status.html` published in Resend as the DEV import-status template | `FolioLens Dev <noreply-dev@foliolens.in>` |
| PROD | Same source, separately published / aliased as the PROD import-status template | `FolioLens <noreply@foliolens.in>` |

Success emails include funds / transactions imported; failure emails explain the actionable next step, especially when a holdings-only CAS lacks transaction history.

The router intentionally lives on the PROD Vercel project so Resend needs only one webhook endpoint and one verified domain on the free plan. DEV / PROD separation is encoded in the email local-part, not in subdomains.


DNS for `foliolens.in` lives at the registrar; Cloudflare proxies the apex (landing page) and lets `app.foliolens.in` pass through unproxied to Vercel. SPF / DKIM / DMARC are managed in Resend's domain panel.


## Expo / EAS


Single expo.dev account. One project (`fa824fc9-9add-418b-8959-eeeeb693b7b5`, slug `foliolens`) hosts every flavour. Variants are picked at build time via the `APP_VARIANT` env var, which `app.config.js` maps onto:


| Variant | Scheme | Bundle ID | EAS channel |
|---------|--------|-----------|-------------|
| `production` | `foliolens://` | `com.foliolens.app` | `foliolens-production` |
| `preview-main` | `foliolens-main://` | `com.foliolens.app.preview-main` | `foliolens-main` |
| `preview-pr` | `foliolens-pr://` | `com.foliolens.app.preview-pr` | `foliolens-pr` |
| `development` | `foliolens-dev://` | `com.foliolens.app.dev` | `development` |


Build-time env vars (the `EXPO_PUBLIC_*` ones baked into the JS bundle) come from **expo.dev → Project → Environment Variables**, scoped to one of three EAS environments:


- `production` env → PROD Supabase + `https://app.foliolens.in`
- `preview` env → DEV Supabase + `https://foliolens-dev.vercel.app`
- `development` env → DEV Supabase + local dev server URLs


GitHub Actions overrides these for OTA updates by passing the workflow's `_PROD` or `_DEV` GitHub secrets at runtime — that way OTA bundles always land with values matching the channel they ship to.


## Google OAuth


Two OAuth Web Client IDs live in **a single Google Cloud project**. Each has the matching Supabase callback as its only Authorized Redirect URI:


| Client | Authorized redirect URI |
|--------|--------------------------|
| FolioLens-Dev | `https://imkgazlrxtlhkfptkzjc.supabase.co/auth/v1/callback` |
| FolioLens | `https://ohcaaioabjvzewfysqgh.supabase.co/auth/v1/callback` |


The OAuth consent screen is in **Testing** mode with External user type. The "App name" is set to `FolioLens` but Google still falls back to showing the Supabase host on the consent screen until brand verification is complete (blocked on having published privacy / terms pages on `foliolens.in`).


## GitHub Actions workflows


All workflows live under `.github/workflows/`. The intent is that **PRs and `main` merges only ever touch DEV**, and **production is gated behind an explicit git tag**.


| Workflow | Trigger | What it does |
|---------|---------|---|
| `pr-preview.yml` | PR open / commit | typecheck + lint + tests + EAS update to `foliolens-pr` (DEV Supabase). Comments the OTA update IDs onto the PR. |
| `supabase-validate.yml` | PR commit (only when `supabase/**` changes) | Spins up local Supabase, replays migrations, lints `public` schema. Read-only. |
| `main-deploy.yml` | Push to `main` | typecheck + lint + tests + EAS update to `foliolens-main` (DEV Supabase). |
| `supabase-deploy-dev.yml` | Push to `main` (only when `supabase/**` changes) | Deploys all Edge Functions and pushes migrations to DEV Supabase. |
| `supabase-deploy-prod.yml` | `workflow_dispatch` only (manual button) | Validates parity, deploys functions, pushes migrations to PROD Supabase. |
| `production-release.yml` | Tag push `v*` (also `workflow_dispatch`) | typecheck + lint + tests + EAS update to `foliolens-production` + Vercel prod deploy via CLI. |
| `sync-amfi-portfolios.yml` | Monthly cron + manual dispatch | Runs `scripts/sync-amfi-portfolios.mjs` against DEV and PROD in parallel matrix jobs. |


### What does **not** trigger automatically


- Production EAS update — only on `v*` tag push
- Production Vercel deploy — only on `v*` tag push (project is disconnected from GitHub)
- Production Supabase migration / function deploy — only via `workflow_dispatch`


This three-way gate is deliberate. A bad commit on `main` updates DEV but cannot touch any production user.


## Secrets matrix


All secrets are stored in **GitHub Actions repository secrets**.


| Secret | Used by | Notes |
|--------|---------|-------|
| `EXPO_TOKEN` | All EAS-using workflows | Single token, scoped to the FolioLens Expo account |
| `SUPABASE_ACCESS_TOKEN` | All Supabase workflows | Personal access token, scoped to both projects |
| `SUPABASE_PROJECT_REF_DEV` | dev deploy / sync workflows | `imkgazlrxtlhkfptkzjc` |
| `SUPABASE_PROJECT_REF_PROD` | prod deploy / sync workflows | `ohcaaioabjvzewfysqgh` |
| `EXPO_PUBLIC_SUPABASE_URL_DEV` | preview / main / dev workflows | DEV Supabase URL |
| `EXPO_PUBLIC_SUPABASE_URL_PROD` | production-release | PROD Supabase URL |
| `EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY_DEV` / `_PROD` | same as above | anon keys |
| `EXPO_PUBLIC_APP_BASE_URL_DEV` / `_PROD` | same as above | `foliolens-dev.vercel.app` / `app.foliolens.in` |
| `SUPABASE_SECRET_KEY_DEV` / `_PROD` | `sync-amfi-portfolios.yml` | Service-role keys for server-to-server access |
| `VERCEL_TOKEN` | `production-release.yml` | Personal access token from Vercel → Account → Tokens |
| `VERCEL_ORG_ID` | `production-release.yml` | `team_HeMWH6xlqe2BOC0NpT85uZPV` |
| `VERCEL_PROJECT_ID_PROD` | `production-release.yml` | `prj_mjY4K0rYmgNhoGMyJ5oC9xMLcTAi` |
| `POSTHOG_PROJECT_KEY` | `sync-amfi-portfolios.yml` | Same `phc_...` token as the client SDKs and Edge Function runtime use. Optional; the workflow no-ops the PostHog step if unset. |


On the Edge Function runtime (Supabase Dashboard → Functions → Secrets), the following are set per project:


| Secret | DEV | PROD |
|--------|-----|------|
| `APP_BASE_URL` | `https://foliolens-dev.vercel.app` | `https://app.foliolens.in` |
| `CAS_PARSER_SHARED_SECRET` | shared with the Vercel Python parser | same |
| `EODHD_API_KEY` | only set if EOD-style index data needed | same |
| `FOLIOLENS_INBOUND_ROUTER_SECRET` | Issue #107: HMAC shared with the Vercel router for inbound CAS handoff + outbound notification callback | same |
| `ROUTER_NOTIFY_URL` | (optional) Vercel cas-import-notify endpoint, defaults to `https://app.foliolens.in/api/cas-import-notify` | same |
| `NOTIFY_ENVIRONMENT` | `dev` — picks the dev Resend template + dev From address at the router | `prod` — picks the prod Resend template + prod From address |
| `VERCEL_PROTECTION_BYPASS_TOKEN` | only when Vercel protection is enabled | same |
| `POSTHOG_PROJECT_KEY` | same `phc_...` as the client SDKs use; enables server-side `cas_parse_*` / `cas_inbound_*` / `sync_*` events | same |
| `POSTHOG_HOST` | optional; defaults to `https://us.i.posthog.com`. Set to `https://eu.i.posthog.com` if the PostHog project is on EU Cloud | same |
| `APP_ENVIRONMENT` | `dev` — tags every server-side event so dashboards can filter prod from dev when one PostHog project ingests both | `production` |

**Removed in Issue #107**: `RESEND_INBOUND_SECRET`, `RESEND_API_KEY`, `RESEND_IMPORT_NOTIFICATION_TEMPLATE_ID`, and `RESEND_NOTIFICATION_FROM` no longer live on Supabase. After deploying this PR, delete those four secrets from both DEV and PROD Supabase project dashboards. They moved to the Vercel project (see "Inbound router" section below).


`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are auto-provided by Supabase to every Edge Function — never set them manually.


On the PROD Vercel project (`foliolens`), the inbound router needs these production environment variables:


| Variable | Purpose |
|----------|---------|
| `RESEND_API_KEY` | Reads received email content / attachments, sends forwarded human-alias mail, sends CAS import status emails (post-#107 — Supabase no longer holds this secret) |
| `RESEND_INBOUND_ROUTER_SECRET` | Resend Svix webhook signing secret for `email.received` |
| `FOLIOLENS_INBOUND_ROUTER_SECRET` | HMAC shared with both Supabase webhooks for inbound CAS handoff + outbound notification callback (see Issue #107) |
| `MAIL_FORWARD_TO` | Owner Gmail destination for `hello@`, `support@`, `privacy@`, and `security@` |
| `MAIL_FORWARD_FROM` | Verified Resend sender used when forwarding aliases, e.g. `FolioLens Mail <noreply@foliolens.in>` |
| `SUPABASE_DEV_FUNCTION_URL` | DEV `cas-webhook-resend` endpoint |
| `SUPABASE_PROD_FUNCTION_URL` | PROD `cas-webhook-resend` endpoint |
| `RESEND_NOTIFICATION_FROM_DEV` | DEV From address for CAS import status emails, e.g. `FolioLens Dev <noreply-dev@foliolens.in>` |
| `RESEND_NOTIFICATION_FROM_PROD` | PROD From address for CAS import status emails, e.g. `FolioLens <noreply@foliolens.in>` |
| `RESEND_IMPORT_NOTIFICATION_TEMPLATE_ID_DEV` | Published DEV Resend Template id/alias for CAS import status emails |
| `RESEND_IMPORT_NOTIFICATION_TEMPLATE_ID_PROD` | Published PROD Resend Template id/alias for CAS import status emails |


## Branching, merging, releasing


### Daily flow


1. Cut a feature branch off `main`
2. Open a PR — `pr-preview.yml` ships an OTA update to the `foliolens-pr` channel; PR Vercel preview goes live
3. Merge to `main` (squash) — `main-deploy.yml` ships an OTA update to `foliolens-main`; `foliolens-dev` Vercel auto-deploys; if `supabase/**` changed, `supabase-deploy-dev.yml` applies the migration / functions
4. Beta testers on the `preview-main` Android APK get the update on next launch


### Producing a release


1. Confirm `main` is green and beta-tested via the `preview-main` build
2. If new migrations or Edge Functions changed, run **Deploy Supabase (Prod)** from the Actions tab and wait for it to go green
3. `git tag v0.X.Y && git push origin v0.X.Y`
4. `production-release.yml` ships:
   - JS bundle to the `foliolens-production` EAS channel
   - Web app to the `foliolens` Vercel project (`app.foliolens.in`)
5. Beta users on the `production` Android APK pull the OTA on next launch


There is **no** automatic prod release. Tagging is the explicit human-in-the-loop gate.


## Manual prerequisites that live outside the repo


These are configured once and rarely change. If you spin up a fresh fork, you'll need to redo them.


| Where | What |
|-------|------|
| Supabase Dashboard → DEV → Auth → URL Configuration | Site URL + redirect URL list (one entry per native scheme + Vercel preview wildcard) |
| Supabase Dashboard → PROD → Auth → URL Configuration | Site URL + redirect URL list (only `foliolens://` and `app.foliolens.in/**`) |
| Supabase Dashboard → both projects → Auth → Email Templates → Magic Link | Paste the contents of `supabase/templates/magic_link.html`; set Subject |
| Supabase Dashboard → both projects → Auth → Providers → Google | Enable, paste the matching Google Cloud OAuth Client ID + Secret |
| Supabase Dashboard → both projects → Functions → Secrets | Set per-project secrets from the table above |
| Resend Dashboard → Domains → `foliolens.in` | DKIM, SPF, DMARC verified; sender addresses configured |
| Resend Dashboard → Receiving / Webhooks (M2) | Enable receiving on `foliolens.in`, point `email.received` at `https://app.foliolens.in/api/resend-inbound-router`, copy the Svix signing secret |
| Google Cloud Console → OAuth consent screen | App name + support email + privacy / terms URLs (TODO once landing-page legal pages are live) |
| Cloudflare → DNS for `foliolens.in` | A / AAAA records for apex (landing page) + CNAME for `app` → Vercel + Resend outbound TXT/DKIM/SPF + Resend inbound MX records |
| Vercel → `foliolens` project → Settings → Git | Disconnected from GitHub. Re-connecting accidentally would resume auto-deploys on every push and break the manual-only release gate. |
| Vercel → both projects → Settings → Domains | DEV: `foliolens-dev.vercel.app` (auto). PROD: `app.foliolens.in` (custom). |
| Vercel → `foliolens` project → Environment Variables | Set `RESEND_API_KEY`, `RESEND_INBOUND_ROUTER_SECRET`, `MAIL_FORWARD_TO`, `MAIL_FORWARD_FROM`, `SUPABASE_DEV_FUNCTION_URL`, `SUPABASE_PROD_FUNCTION_URL` for the production router |
| expo.dev → Environment Variables | DEV / preview / production envs each have their `EXPO_PUBLIC_*` values |


## Observability


- **PostHog** — single pane for product events and operational health, fed from every surface that runs FolioLens code:
  - **Client (native + web)**: `onboarding_started` / `onboarding_step_completed` / `onboarding_completed` / `portfolio_imported` / `insight_viewed` / `app_started` / `app_returned` plus `$exception` from uncaught errors. Gated by `EXPO_PUBLIC_POSTHOG_KEY`.
  - **Supabase Edge Functions**: `cas_parse_success` / `cas_parse_failed` (parse-cas-pdf), `cas_inbound_imported` / `cas_inbound_failed` / `cas_inbound_crashed` (cas-webhook-resend), `sync_completed` / `sync_failed` per cron job. Direct HTTP capture from the function — no JSR dep, no cold-start hit. Server env: `POSTHOG_PROJECT_KEY`, `POSTHOG_HOST`, `APP_ENVIRONMENT`.
  - **Vercel Python parser**: `cas_parser_python_outcome` with `outcome ∈ {success, wrong_password, holdings_only, exception}`. Reads `EXPO_PUBLIC_POSTHOG_KEY` / `EXPO_PUBLIC_POSTHOG_HOST` from the same Vercel project env vars that the Expo web build inlines, so a single setting powers both consumers. (`APP_ENVIRONMENT` stays non-prefixed since there's no Expo equivalent.)
  - **GitHub Actions AMFI sync**: `amfi_sync_completed` with `outcome ∈ {success, failure}` and a `workflow_run_url` so a failed monthly sync can be triaged in two clicks. Closes the alerting gap from the readiness audit.
- **Vercel Speed Insights + Web Analytics** — Web Vitals (LCP / INP / CLS) per-route and infrastructure-side page views for the Vercel-served web build. Complements PostHog (which captures user-journey events but not Web Vitals).
- **Supabase Logs** — Auth, Edge Function, and Database logs viewable in the dashboard. Auth log level is set to "errors only" by default; set to "info" temporarily when debugging sign-in flows.
- **Vercel Logs** — only the dev project receives meaningful traffic; prod logs are sparse since the app is mostly RN with thin web shell.
- **Supabase Dashboard → Database → Cron Jobs** — confirms each pg_cron job is firing on schedule.
- **Resend Dashboard → Logs** — outbound delivery and inbound webhook firing per email.


## Cost summary (rough)


- Supabase: free tier per project, with paid backup retention if needed
- Vercel: hobby tier; bumps to Pro if we ever exceed 100 GB / mo bandwidth
- Resend: free tier (3K emails / mo) — well above expected volume during beta
- Expo: free tier with a paid Production plan; EAS Update is included
- Cloudflare: free tier
- Google OAuth: free
- Vercel Python parser: deployed to the same `foliolens` Vercel project's Serverless Functions — counts toward Vercel's Hobby execution-time budget
- PostHog: free tier (1M events / mo). Comfortably above closed-beta volume.


## Out of scope (for now)


- Multi-region failover — single-region Supabase + Vercel is sufficient at this volume
- Read-replica / staging tier — DEV serves both purposes today
- App store submission — internal-distribution APKs are the channel for beta; iOS TestFlight submission is queued behind paid Apple Developer setup
- MFCentral OAuth integration — separate Phase 6 milestone, requires a partner agreement
