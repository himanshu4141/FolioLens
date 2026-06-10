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
| `sync-nav` | pg_cron (bimodal: hourly 6 PM → 6 AM IST + every 2h during the day, 7 days) | Pulls NAV history from mfapi.in for every active scheme | Active |
| `sync-index` | pg_cron (hourly) | Pulls benchmark index closes from yahoo finance | Active |
| `fetch-fund-nav` | On-demand (client POST, no auth required) | Backfills full NAV history for any scheme not held by the user — used by Compare Funds and Past SIP Check. Cache-aware (skips upstream if latest row ≤ 3 days old). Stamps `scheme_master.nav_backfilled_at` on every successful hydration (cache-hit or fresh fetch) so the retention cron knows when the series was last confirmed current. | Active |
| `nav-retention` | pg_cron weekly (Sundays 03:00 UTC / 08:30 IST) | Deletes `nav_history` rows for schemes that are not held by any active `user_fund` **and** whose `scheme_master.nav_backfilled_at` is NULL or older than 90 days. Batched deletes (≤ 100 k rows per run). See "Runbook: NAV retention" below. | Active |
| `openfolio-sync` | pg_cron (`openfolio-composition-monthly`, 15th @ 01:30 UTC) + manual `{"mode":"backfill"}` | **Primary** holdings source: pages OpenFolio-Data's bulk `/v1/composition`, matches schemes to `scheme_master` (AMFI code → ISIN), upserts `source='official'` rows. Reads `OPENFOLIO_API_BASE` + `OPENFOLIO_API_KEY` secrets. | Active |
| `sync-fund-portfolios` | pg_cron (hourly) | **Backup** holdings source: mfdata.in portfolio composition → `source='amfi'` (now outranked by `official`) | Active |
| `sync-fund-meta` | pg_cron (daily) | Refreshes scheme metadata (AUM, expense ratio, risk) | Active |
| `notify-feedback` | AFTER INSERT trigger on `public.user_feedback` (via `pg_net.http_post`) | Sign-and-forward relay: looks up the user's auth email (for reply-to), signs a payload with `FOLIOLENS_INBOUND_ROUTER_SECRET`, and POSTs to the Vercel router's `/api/feedback-notify` endpoint which performs the actual Resend send | Active |
| `demo-signup` | In-app "Try with sample data" sheet (pre-auth) | Captures email + marketing consent + UTM/referrer attribution into `public.demo_signup`. Idempotent on email — re-submissions bump `signup_count` instead of erroring. Service-role insert path; RLS on the table denies direct client writes. | Active |


All cron-triggered functions are deployed with `--no-verify-jwt` because pg_cron has no JWT to send. `notify-feedback` is deployed the same way so the DB trigger can call it without needing a service-role key embedded in the SQL function. `demo-signup` is also deployed `--no-verify-jwt` because the caller (auth screen) has no session yet — the function is the public API boundary and validates payloads itself. `nav-retention` is deployed `--no-verify-jwt` for the same reason as other cron functions. `fetch-fund-nav` is deployed `--no-verify-jwt` so the client can call it without a session JWT when picking non-held funds.


### One-time per-project bootstrap: `public.app_config`


Cron migrations and trigger functions read their target Edge Function URL from a `public.app_config` table (created by migration `20260513000001_app_config_table.sql`) so the same migration file applies cleanly to dev and prod. An earlier iteration of this pattern used `ALTER DATABASE postgres SET app.supabase_functions_base_url = …`, but Supabase managed Postgres locks down `ALTER DATABASE … SET` for arbitrary GUCs from the SQL Editor, so the bootstrap step was unrunnable. A regular table works inside that privilege model.

Each Supabase project needs the row populated **once**, via the Dashboard SQL Editor (or any `psql` session as the `postgres` role):

    -- DEV project
    INSERT INTO public.app_config (key, value)
    VALUES (
      'supabase_functions_base_url',
      'https://imkgazlrxtlhkfptkzjc.supabase.co/functions/v1'
    )
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();

    -- PROD project (run from the PROD project's SQL editor only)
    INSERT INTO public.app_config (key, value)
    VALUES (
      'supabase_functions_base_url',
      'https://ohcaaioabjvzewfysqgh.supabase.co/functions/v1'
    )
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();

Re-running is safe; the `ON CONFLICT` upsert overwrites the existing value. If the row is missing the call sites' `NULL || '/sync-nav'` evaluates to NULL and `net.http_post` errors loudly — the intended failure mode, since silently calling the wrong project's edge functions is worse than failing loudly.

All current pg_net call sites — the cron schedules (`sync-nav-hourly`, `sync-index-hourly`, `sync-portfolio-composition-hourly`, `sync-fund-meta-daily`, `openfolio-composition-monthly`), the `regenerate-index-snapshots-daily` cron, and the `notify_feedback_inserted` trigger function — use this `public.app_config_get('supabase_functions_base_url')` lookup. Any new pg_net call site added going forward should follow the same pattern rather than hardcoding a project ref.

> **Note (2026-06-10):** Migration `20260528000000_sync_nav_bimodal_schedule.sql` introduced a regression by using `current_setting('app.supabase_functions_base_url')` instead of `public.app_config_get()`, causing every `sync-nav-hourly` run to fail with `unrecognized configuration parameter`. Fixed by `20260610000000_fix_sync_nav_cron_app_config.sql`.

`notify-feedback` follows the same Issue #107 architecture as `cas-webhook-resend`: Resend secrets stay at the router boundary, not on Supabase. **No new Supabase env vars are required** — the function reuses `FOLIOLENS_INBOUND_ROUTER_SECRET` and `NOTIFY_ENVIRONMENT` (both already set for `cas-webhook-resend`). An optional `ROUTER_FEEDBACK_NOTIFY_URL` can override the default `https://app.foliolens.in/api/feedback-notify` for local testing.

The Vercel side (`api/feedback-notify.py`) reuses the existing `RESEND_API_KEY`, `MAIL_FORWARD_TO` (founder inbox), and `MAIL_FORWARD_FROM` (verified sender) env vars — same ones that already power human-alias forwarding and CAS import notifications. **No new Vercel env vars are required.**

`public.demo_signup` is intentionally separate from the marketing-site early-access form (currently a Tally embed; future Supabase `waitlist_signup` table per `foliolens-site/supabase-waitlist-endpoint-guide.md` is unbuilt). The two funnels share the `source` / `status` convention so they can be merged later if needed. No new env vars are required — `demo-signup` uses the standard `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` already present on every project.


### Runbook: NAV retention


**What it is.** `nav_history` grows unboundedly as users pick non-held funds in Compare Funds / Past SIP Check — each pick triggers `fetch-fund-nav` which backfills ~3 000–6 000 rows. A scheme that is never picked again is never cleaned up. The weekly `nav-retention` cron prunes those orphaned series automatically.

**Retention logic.** A scheme's NAV series is prunable when:
1. It does not appear in any active `user_fund` (no user is currently holding or tracking it), **and**
2. `scheme_master.nav_backfilled_at IS NULL` (never demand-fetched) **OR** `nav_backfilled_at < now() - 90 days` (last confirmed more than 90 days ago).

`nav_backfilled_at` is stamped by `fetch-fund-nav` on every cache-hit and every successful upsert, so the 90-day clock resets each time a user picks the fund.

**Trade-off.** A pruned fund re-hydrates when a user next picks it — `fetch-fund-nav` fetches the full history from mfapi.in in a single round-trip. Users see a 1–2 s loading spinner instead of an instant render. This is acceptable given that the trigger is "pick a fund you haven't looked at in 3+ months."

**Steady-state operation.** The weekly cron runs on Sundays at 03:00 UTC (08:30 IST), identified as `nav-retention-weekly` in `cron.job`. Each run deletes at most 100 k rows and emits a `nav_retention_completed` PostHog event with `rows_deleted`, `pruneable_schemes`, and `capped` fields. Monitor via PostHog or Supabase Edge Function logs.


#### One-time manual cleanup of existing orphan rows

> **⚠️ Do NOT execute this yourself — it requires explicit approval before running against any environment.**

As of 2026-06-10, `nav_history` holds approximately **8.6 M rows** for schemes that have never been held by any user. These were written by the now-retired `backfill-fund-universe` script. The weekly cron caps at 100 k rows/run, so the natural drain would take ~86 weeks. If you need to reclaim space faster, execute the following batched cleanup **after** deploying this migration to the target project.

**Step 0 (optional): create a one-week archive table for rollback safety**

```sql
-- Run in the target project's SQL editor
-- Gives you a 1-week window to restore if needed; drop it afterwards.
CREATE TABLE IF NOT EXISTS nav_history_orphan_archive AS
SELECT nh.*
FROM nav_history nh
WHERE NOT EXISTS (
  SELECT 1 FROM user_fund uf
  WHERE uf.scheme_code = nh.scheme_code
    AND uf.is_active = true
)
AND (
  (SELECT nav_backfilled_at FROM scheme_master sm WHERE sm.scheme_code = nh.scheme_code)
  IS NULL
  OR
  (SELECT nav_backfilled_at FROM scheme_master sm WHERE sm.scheme_code = nh.scheme_code)
  < now() - interval '90 days'
);
-- Check the archive row count before proceeding:
SELECT count(*) FROM nav_history_orphan_archive;
```

**Step 1: batched DELETE loop (run in the SQL editor)**

Run this loop repeatedly — each iteration deletes 200 k rows; adjust the batch size down if you see lock contention. Stop when it reports 0 rows deleted.

```sql
-- One iteration — re-run until rows_this_batch = 0
WITH pruneable AS (
  SELECT nh.id
  FROM nav_history nh
  JOIN scheme_master sm ON sm.scheme_code = nh.scheme_code
  WHERE NOT EXISTS (
    SELECT 1 FROM user_fund uf
    WHERE uf.scheme_code = nh.scheme_code AND uf.is_active = true
  )
  AND (sm.nav_backfilled_at IS NULL OR sm.nav_backfilled_at < now() - interval '90 days')
  LIMIT 200000
),
deleted AS (
  DELETE FROM nav_history
  WHERE id IN (SELECT id FROM pruneable)
  RETURNING id
)
SELECT count(*) AS rows_this_batch FROM deleted;
```

**Step 2: VACUUM FULL (optional, during a low-traffic window)**

DELETE in Postgres marks rows as dead but does not return pages to the OS. After the bulk cleanup, run:

```sql
-- Returns freed space to the OS; acquires an ACCESS EXCLUSIVE lock.
-- Run during off-peak hours (e.g., Sunday night IST).
VACUUM FULL nav_history;
-- Then rebuild indexes in the freed space:
REINDEX TABLE nav_history;
```

Supabase managed Postgres allows `VACUUM FULL` from the SQL Editor (runs as the `postgres` role). Expect it to take several minutes on a large table.

**Step 3: drop the archive table after confirming correctness**

```sql
-- Only after you are satisfied the cleanup is correct and the app is healthy.
DROP TABLE IF EXISTS nav_history_orphan_archive;
```

**Rollback.** If the deletion turns out to be incorrect, restore from the archive:

```sql
INSERT INTO nav_history SELECT * FROM nav_history_orphan_archive
ON CONFLICT (scheme_code, nav_date) DO NOTHING;
```

All pruned NAV data is fully regenerable from the OpenFolio API (`/v1/nav/{scheme_code}`) or mfapi.in (`/mf/{scheme_code}`) — this is exactly what `fetch-fund-nav` does on the next user pick.


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


## Feature flags


Flags resolve **at build time** from `EXPO_PUBLIC_FEATURE_*` env vars baked into the JS bundle. The EAS channel decides which value gets baked: each channel block in [eas.json](../eas.json) sets its own `env` map, and the flag value follows from there. The source of truth for what's wired up is [src/lib/featureFlags.ts](../src/lib/featureFlags.ts).


Why build-time rather than runtime: at this scale (one consumer per flag, low cadence) the simplicity wins. No runtime fetch, no PostHog round-trip on the critical auth path, no RLS to reason about. The trade-off is that toggling a flag requires a rebuild + OTA — acceptable for "ship-readiness" gates.


### Current flags


| Flag | Env var | preview-* channels | production channel |
|------|---------|--------------------|--------------------|
| Preview mode (sample-data walkthrough) | `EXPO_PUBLIC_FEATURE_PREVIEW_MODE` | `true` | `false` |


### Adding or toggling a flag


1. **Pick the env var name.** Stick to the `EXPO_PUBLIC_FEATURE_<NAME>` convention. Anything without the `EXPO_PUBLIC_` prefix won't make it into the JS bundle.
2. **Set the per-channel value in [eas.json](../eas.json).** Every channel that should see the flag enabled needs `"EXPO_PUBLIC_FEATURE_<NAME>": "true"`. Production should default to `"false"` unless you actively want it on in prod.
3. **Wire the flag into `src/lib/featureFlags.ts`.** One `process.env` read at module scope, exported via the `featureFlags` object. Consumers import `featureFlags.<name>` — never call `process.env` directly from feature code.
4. **For Vercel web builds**, also set the env var in the Vercel project's Environment Variables UI for the relevant environments (Preview vs Production). Vercel does not read `eas.json` — the web bundle gets its env from Vercel's own settings.
5. **To toggle in prod:** flip the value in `eas.json` for the relevant channel, commit, and republish the OTA update (or cut a new native build if the change needs to reach users on an older binary).


### Defense-in-depth for state that outlives the flag


If a flag controls a mode that persists state (e.g. preview mode persists `previewMode` in the Zustand store), the app should force-exit that state when the flag is off. See `AuthGate` in [app/_layout.tsx](../app/_layout.tsx) for the pattern — a one-shot effect that clears the persisted flag-gated state on mount when `featureFlags.<name>` is false. Without this, a user whose previous build had the flag on would stay stuck in the flag-gated mode after we flip it off.


### Graduation path: PostHog runtime override


If a flag ever needs to be toggled **at runtime** for a specific user cohort — e.g. "enable preview for the people who emailed asking for it" — layer PostHog feature flags on top **without removing the build-time floor**. PostHog is already initialised via [src/lib/analytics.ts](../src/lib/analytics.ts) and identifies users by Supabase `user.id`, so cohort targeting is free.


The shape of the change:


```ts
import { PostHog } from 'posthog-react-native';

const buildTimeDefault = process.env.EXPO_PUBLIC_FEATURE_PREVIEW_MODE === 'true';

export function isPreviewModeEnabled(posthog?: PostHog): boolean {
  // PostHog override wins when defined; otherwise build-time default.
  const override = posthog?.getFeatureFlag('preview_mode_enabled');
  if (override === true) return true;
  if (override === false) return false;
  return buildTimeDefault;
}
```


Keep the build-time default `false` in prod so a missing or misconfigured PostHog flag can never *enable* a feature that prod isn't ready for — PostHog can only override the build-time decision for a targeted cohort. Target the PostHog flag at distinct IDs (which `analytics.identify()` already populates with the Supabase user ID) or by an email-domain property from the PostHog dashboard.


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
| `OPENFOLIO_API_BASE` | OpenFolio-Data REST API base URL (the GCP Cloud Run URL). Read by `openfolio-sync` + `fetch-fund-snapshot` via `_shared/openfolio.ts`. Same value dev + prod (one API serves both). Falls back to `OPENFOLIO_API_BASE_URL` if that name is used instead. | same |
| `OPENFOLIO_API_KEY` | OpenFolio-Data `X-API-Key`. Same value dev + prod. | same |

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
  - **Client (native + web)**: onboarding funnel events `onboarding_started` / `onboarding_step_completed` / `onboarding_completed` / `portfolio_imported` plus the redesign-era decision / failure / design-validation events (`onboarding_skip_clicked`, `onboarding_pdf_picker_dismissed`, `onboarding_path_chosen`, `portfolio_import_failed`, `onboarding_password_override_used`, `onboarding_app_family_selected`, `onboarding_portal_opened`, `onboarding_auto_refresh_setup_completed`, `onboarding_done_nudge_clicked`); plus `insight_viewed` / `app_started` / `app_returned` plus `$exception` from uncaught errors. Per-event dimensions documented in `docs/plans/phase-6-cas-onboarding/00-onboarding-redesign.md` → "Analytics Events". Gated by `EXPO_PUBLIC_POSTHOG_KEY`.
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
