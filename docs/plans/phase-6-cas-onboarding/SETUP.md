# Phase 6 — Manual Setup & Testing Runbook

This is the operator runbook for the Phase 6 CAS onboarding + Resend inbound work. The current architecture uses **one Resend verified domain** (`foliolens.in`) and **one Resend webhook endpoint** to stay inside the Resend free-plan limits.

> **Strategy recap.** Resend owns apex inbound MX for `foliolens.in` and sends every `email.received` event to `https://app.foliolens.in/api/resend-inbound-router`. That production Vercel router verifies Resend's Svix signature, forwards human aliases to the owner Gmail, and dispatches CAS mail by local-part:
>
> - `cas-dev-<token>@foliolens.in` -> DEV Supabase `cas-webhook-resend`
> - `cas-<token>@foliolens.in` -> PROD Supabase `cas-webhook-resend`
> - `hello@`, `support@`, `privacy@`, `security@` -> owner Gmail via Resend send API

---

## Variables you'll reuse

| Variable | Value |
|---|---|
| `<router-url>` | `https://app.foliolens.in/api/resend-inbound-router` |
| `<dev-project-ref>` | `imkgazlrxtlhkfptkzjc` |
| `<prod-project-ref>` | `ohcaaioabjvzewfysqgh` |
| `<dev-webhook>` | `https://imkgazlrxtlhkfptkzjc.supabase.co/functions/v1/cas-webhook-resend` |
| `<prod-webhook>` | `https://ohcaaioabjvzewfysqgh.supabase.co/functions/v1/cas-webhook-resend` |
| `<inbound-domain>` | `foliolens.in` |
| `<resend-svix-secret>` | Resend webhook signing secret for `email.received` |
| `<resend-api-key>` | Resend API key with send + receiving read access |
| `<dev-import-template-id>` | Published Resend Template id / alias for DEV CAS import status emails |
| `<prod-import-template-id>` | Published Resend Template id / alias for PROD CAS import status emails |
| `<owner-gmail>` | Personal Gmail destination for public aliases |
| `<your-dev-uuid>` | your `auth.users.id` in DEV Supabase |
| `<your-prod-uuid>` | your `auth.users.id` in PROD Supabase |

Dashboards needed:

- Cloudflare DNS for `foliolens.in`
- Resend Dashboard
- Vercel Dashboard (`foliolens` production project)
- Supabase Dashboard for DEV and PROD
- Expo Dashboard / EAS env vars

---

## Section 0 — Router-first setup

Do this before testing PR #93. The router must be live in production because Resend can only call one webhook endpoint on the current plan.

### Step 0.1 — Resend receiving + webhook

Resend Dashboard:

- Enable Receiving on existing domain `foliolens.in`.
- Create one webhook:
  - URL: `https://app.foliolens.in/api/resend-inbound-router`
  - Event: `email.received`
- Copy the webhook signing secret as `<resend-svix-secret>`.
- Create or reuse a Resend API key as `<resend-api-key>`.
- Create and publish two Resend Templates from `supabase/templates/resend_cas_import_status.html`:
  - DEV template: alias or id `<dev-import-template-id>`, default From `FolioLens Dev <noreply-dev@foliolens.in>`.
  - PROD template: alias or id `<prod-import-template-id>`, default From `FolioLens <noreply@foliolens.in>`.
  - Both templates use these variables: `STATUS_LABEL`, `STATUS_BG`, `STATUS_TEXT_COLOR`, `TITLE`, `INTRO`, `FUNDS_UPDATED`, `TRANSACTIONS_IMPORTED`, `DETAIL_LABEL`, `DETAIL_TEXT`, `NEXT_STEP_LABEL`, `NEXT_STEP_TEXT`, `APP_URL`, `CTA_LABEL`, `FOOTER_TEXT`.
  - Send a Resend test email for each template before wiring it into Supabase.

Cloudflare DNS:

- Remove Cloudflare Email Routing MX records for the apex.
- Add the Resend inbound MX record(s) for `foliolens.in`.
- Keep Resend outbound TXT / DKIM / SPF records intact.
- Keep Vercel records (`app.foliolens.in`) intact.

### Step 0.2 — Vercel production env vars

Vercel Dashboard -> `foliolens` -> Settings -> Environment Variables -> Production:

| Key | Value |
|---|---|
| `RESEND_API_KEY` | `<resend-api-key>` |
| `RESEND_INBOUND_ROUTER_SECRET` | `<resend-svix-secret>` |
| `MAIL_FORWARD_TO` | `<owner-gmail>` |
| `MAIL_FORWARD_FROM` | `FolioLens Mail <noreply@foliolens.in>` |
| `SUPABASE_DEV_FUNCTION_URL` | `<dev-webhook>` |
| `SUPABASE_PROD_FUNCTION_URL` | `<prod-webhook>` |

Deploy the router by merging the router PR to `main` and cutting a production release tag. The PROD Vercel project is disconnected from GitHub auto-deploy, so a main merge alone is not enough.

### Step 0.3 — Router smoke tests

After the production release finishes:

```bash
curl -i https://app.foliolens.in/api/resend-inbound-router
```

Expect `200` with `{"ok": true, "service": "resend-inbound-router"}`.

Then send real emails:

- `hello@foliolens.in` -> should arrive at `<owner-gmail>`.
- `support@foliolens.in` -> should arrive at `<owner-gmail>`.
- `privacy@foliolens.in` -> should arrive at `<owner-gmail>`.
- `security@foliolens.in` -> should arrive at `<owner-gmail>`.
- `random@foliolens.in` -> should be accepted by the router and dropped.

Resend Dashboard -> Webhooks should show `200` for each event.

---

## Section 1 — Test M1 (wizard, no Resend setup needed)

Once PR #92 is green, the wizard can be tested independently of M2 backend.

### Web (Vercel `foliolens-dev`)

- Open the Vercel preview URL from the PR comment.
- Sign in. If `user_profile.pan` is already saved, clear first-run state via DEV SQL:

  ```sql
  update user_profile
     set pan = null, dob = null, kfintech_email = null
   where user_id = '<your-dev-uuid>';

  delete from cas_import where user_id = '<your-dev-uuid>';
  ```

- Test mobile width (`<1024 px`) and desktop width (`>=1024 px`).
- Settings -> Preferences -> Appearance -> toggle Light / Dark / Follow system.
- Sign out / back in after PAN + DOB are saved. Returning users should restart at Step 3.

### Native (EAS `preview-pr` build)

- Install the PR preview build from Expo.
- Force-quit + reopen at each wizard step to confirm draft persistence.
- Verify "Get a fresh CAS" cards launch the in-app browser and show the AppState return banner.

---

## Section 2 — PR #93 backend setup

Run this once PR #93 is ready to test.

### Step 2.1 — Apply migrations

PR #93 adds:

- `20260504020000_user_profile_cas_inbox_token.sql`
- `20260505000000_user_profile_cas_inbox_confirmation_url.sql`
- `20260506000000_user_profile_auto_forward_setup.sql`

DEV:

- Either wait for PR #93 to merge to `main`, or run **Supabase Deploy (dev)** manually on branch `feat/cas-resend-inbound-m2`.

PROD:

- After PR #93 merges, run **Supabase Deploy (prod)** manually on `main`.
- Take a Supabase backup first if this is going to production.

Verify in both projects:

```sql
select user_id, cas_inbox_token, cas_inbox_confirmation_url
  from user_profile
 order by created_at;

select count(*) total,
       count(distinct cas_inbox_token) unique_tokens
  from user_profile
 where cas_inbox_token is not null;
-- expect total == unique_tokens
```

### Step 2.2 — Supabase Edge secrets

Set on **both** Supabase projects:

| Key | DEV value | PROD value |
|---|---|---|
| `FOLIOLENS_INBOUND_ROUTER_SECRET` | `<shared-foliolens-secret>` | `<shared-foliolens-secret>` |
| `INBOUND_DOMAIN` | `foliolens.in` | `foliolens.in` |
| `NOTIFY_ENVIRONMENT` | `dev` | `prod` |
| `ROUTER_NOTIFY_URL` | (optional, defaults to `https://app.foliolens.in/api/cas-import-notify`) | same |

Issue #107 moved every Resend touchpoint to the Vercel router, so Supabase no longer needs `RESEND_INBOUND_SECRET`, `RESEND_API_KEY`, `RESEND_IMPORT_NOTIFICATION_TEMPLATE_ID`, or `RESEND_NOTIFICATION_FROM`. After this PR deploys, **delete those four secrets from both DEV and PROD Supabase project dashboards**. The router fetches Resend Receiving content + signs a normalized payload with `FOLIOLENS_INBOUND_ROUTER_SECRET` (HMAC-SHA256). Supabase verifies the FolioLens signature, downloads attachments via Resend's presigned URLs, and POSTs status emails to the router's `/api/cas-import-notify` endpoint with the same shared secret.

The Vercel router needs the corresponding secrets — see the "Inbound router env" table in [docs/INFRASTRUCTURE.md](../../INFRASTRUCTURE.md) (`RESEND_INBOUND_ROUTER_SECRET`, `RESEND_API_KEY`, `FOLIOLENS_INBOUND_ROUTER_SECRET`, plus `RESEND_NOTIFICATION_FROM_DEV/_PROD` and `RESEND_IMPORT_NOTIFICATION_TEMPLATE_ID_DEV/_PROD`).

Verify deployment config:

- Supabase Dashboard -> Edge Functions -> `cas-webhook-resend`
- JWT Verification: off / skip JWT enabled
- Last deployed timestamp matches the PR #93 deploy

### Step 2.3 — Client env vars

The client should render the same domain in every environment, but a different local-part prefix:

| Target | Value |
|---|---|
| EAS `preview-pr` / `preview-main` | `EXPO_PUBLIC_INBOUND_DOMAIN=foliolens.in` |
| EAS `production` | `EXPO_PUBLIC_INBOUND_DOMAIN=foliolens.in` |
| Vercel `foliolens-dev` | `EXPO_PUBLIC_INBOUND_DOMAIN=foliolens.in` |
| Vercel `foliolens` | `EXPO_PUBLIC_INBOUND_DOMAIN=foliolens.in` |

The app normally infers dev/prod from `APP_VARIANT` or the Supabase URL baked into the bundle. If a preview build ever renders `cas-<token>@foliolens.in` instead of `cas-dev-<token>@foliolens.in`, set `EXPO_PUBLIC_INBOUND_ENV=dev` on that target and republish.

After changing Expo / Vercel env vars, republish OTA or redeploy the relevant app.

---

## Section 3 — Validation tests

### Test 1 — Router + Supabase unknown-token smoke

Send an email with a small PDF attached:

- DEV smoke: `cas-dev-ZZZZZZZZ@foliolens.in`
- PROD smoke: `cas-ZZZZZZZZ@foliolens.in`

Expected:

- Resend webhook log: `200` from `https://app.foliolens.in/api/resend-inbound-router`.
- Router response body route is `cas_dev` or `cas_prod`.
- Matching Supabase `cas-webhook-resend` logs show signature OK and unknown token.
- No `cas_import` row is inserted.

### Test 2 — Real CAS import

Find real tokens:

```sql
-- DEV
select cas_inbox_token from user_profile where user_id = '<your-dev-uuid>';

-- PROD
select cas_inbox_token from user_profile where user_id = '<your-prod-uuid>';
```

Forward a real CAMS / KFintech CAS PDF:

- DEV: `cas-dev-<dev-token>@foliolens.in`
- PROD: `cas-<prod-token>@foliolens.in`

Verify:

```sql
select id, import_status, import_source, funds_updated, transactions_added, created_at
  from cas_import
 where user_id = '<your-uuid>'
 order by created_at desc
 limit 1;
-- expect import_source = 'email' and import_status = 'success'
```

Also verify that the user's auth email receives a Resend Template message:

- DEV imports must come from `FolioLens Dev <noreply-dev@foliolens.in>`.
- PROD imports must come from `FolioLens <noreply@foliolens.in>`.
- Success copy should show funds / transactions imported.
- A holdings-only or non-detailed CAS should fail the import and send a "Detailed CAS required" next-step email.

### Test 3 — Gmail forwarding confirmation

- In Gmail, add the matching CAS address as a forwarding destination.
- Gmail sends a verification email to FolioLens.
- Router dispatches it to the matching Supabase project.
- `user_profile.cas_inbox_confirmation_url` should populate.
- Settings -> Auto-refresh should show a confirm button.
- The next real CAS import should clear `cas_inbox_confirmation_url`.

### Test 4 — Negative checks

- POST directly to `/api/resend-inbound-router` without Svix headers -> expect `401`.
- Send to `cas-dev-<prod-token>@foliolens.in` -> dev project should not find the token.
- Send to `cas-<dev-token>@foliolens.in` -> prod project should not find the token.
- Send a non-PDF attachment to a CAS address -> no import row.

---

## Section 4 — Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Human aliases do not forward | Router not released to PROD Vercel, wrong `MAIL_FORWARD_TO`, or Resend API key missing | Check Vercel env vars, production deployment timestamp, and Resend webhook log body |
| Router returns 401 | `RESEND_INBOUND_ROUTER_SECRET` does not match the Resend webhook signing secret | Re-copy the Svix secret into Vercel and redeploy |
| Router returns 5xx on human aliases | `RESEND_API_KEY` cannot retrieve received email or send mail | Check API key permissions and Resend error body in webhook log |
| Router route is `drop` for a CAS address | Address local-part does not match `cas-dev-<8-char-token>` or `cas-<8-char-token>` | Re-copy the exact in-app address |
| Supabase function returns 401 | `FOLIOLENS_INBOUND_ROUTER_SECRET` mismatch between Vercel router and Supabase, or stale clock skewing the 5-minute timestamp window | Re-copy the same FolioLens secret to Vercel + both Supabase projects, redeploy each, retry |
| Supabase function returns unknown token for a real user | Wrong env prefix or token typo | Compare address to `select cas_inbox_token from user_profile where user_id = ...` in that environment |
| App shows old address format | PR #93 bundle / OTA not republished after env or code change | Republish the relevant EAS update or redeploy Vercel |
| CAS import succeeds/fails but no user email arrives | Missing `RESEND_IMPORT_NOTIFICATION_TEMPLATE_ID_DEV/_PROD` on Vercel, unpublished template, wrong From-domain permission, or the cas-import-notify endpoint rejected the FolioLens signature | Check Supabase logs for `DROPPED notification_failed`, then check Vercel function logs for `cas-import-notify`. Confirm both template ids are published in Resend |
| User receives prod-looking email from a dev import | `NOTIFY_ENVIRONMENT` on the DEV Supabase project is `prod` (or unset, which defaults to `dev` — but a `prod` typo is the failure mode) | Set DEV Supabase `NOTIFY_ENVIRONMENT=dev` and replay the webhook |
