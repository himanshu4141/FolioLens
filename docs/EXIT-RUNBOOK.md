# Leaving Supabase — 90-day runbook

This is the forcing function for the exit-readiness work documented in
the plan file `/root/.claude/plans/i-didnt-realise-we-ticklish-rabin.md`.
**It is not a current project.** It exists so that if we ever decide to
leave Supabase (cost, vendor risk, control, breaking changes like the
auto-exposure removal in PR #151), we have a candid map of what that
costs and in what order to attack it.

Update this file every time someone adds a new Supabase-specific
feature, removes one, or changes the shape of one of the wrapper layers
listed below.

## Today's posture (insurance, not migration)

| Surface | Lock-in today | Where the coupling lives |
|---|---|---|
| **Database** | Low | Plain Postgres 17 + `uuid-ossp` + RLS. The only `auth.*` references are (a) `auth.uid()` inside RLS policies and (b) the two sync triggers between `auth.users` and `public.app_user`. All user-owned FKs point at `public.app_user(id)`, not `auth.users(id)`. |
| **Data API** | Medium | All `.from(...)` reads/writes go through `src/lib/data/<table>.ts`. No other module imports `supabase` for data access. |
| **Auth** | High | All `supabase.auth.*` calls go through `authClient` (`src/lib/auth/index.ts`). OAuth redirect URLs live in the Supabase dashboard. JWT shape comes from supabase-auth and is baked into RLS via `auth.uid()`. |
| **Edge Functions** | Medium | 11 functions in `supabase/functions/` (Deno runtime). All client invocations go through `functionsClient` (`src/lib/functions/index.ts`). |
| **Storage** | Low | One private bucket (`user-feedback-attachments`) + one public bucket (`static-snapshots`). All client access goes through `storageClient` (`src/lib/storage/index.ts`). |
| **pg_cron + pg_net** | Medium | 5 scheduled jobs. Target URLs read from `public.app_config` table, so they're already parameterised. |
| **Realtime / Vault / RPC** | None | Not used. Keep it that way. |

## Order of operations (least → most coupled)

The reverse of how tightly coupled each surface is. Peel off the easy
stuff first so each subsequent step has fewer dependencies to chase.

### 1. Storage (~1 day)

1. Stand up a destination bucket (S3 / R2 / Vercel Blob).
2. `aws s3 sync` (or equivalent) from Supabase Storage. Both buckets are small.
3. Rewrite `src/lib/storage/index.ts` to point at the new client.
4. Rewrite the `static-snapshots` upload path in
   `supabase/functions/regenerate-index-snapshots/index.ts` (becomes
   a Vercel/Cloudflare handler in step 4).
5. Public CDN URLs change — `src/hooks/useIndexSnapshot.ts`
   `snapshotUrlFor()` reads `EXPO_PUBLIC_SUPABASE_URL`. Either repoint
   or introduce a new `EXPO_PUBLIC_STATIC_BUCKET_BASE_URL`.

### 2. Cron jobs (~1 day)

Replace pg_cron with GitHub Actions cron (we already use it for
`sync-amfi-portfolios.yml`) or Vercel/Cloudflare cron.

For each of the 5 scheduled jobs in
`supabase/migrations/20260513000001_app_config_table.sql`:

- Take the URL the job hits via `app_config_get('supabase_functions_base_url')`.
- Set up an equivalent scheduled trigger pointing at the
  new function URL (post step 4).
- Drop the corresponding `cron.schedule` entry.

Schedules to preserve:
- `sync-nav-hourly` — `0 * * * 1-5`
- `sync-index-hourly` — `5 * * * 1-5`
- `sync-portfolio-composition-hourly` — `10 * * * *`
- `sync-fund-meta-daily` — `0 2 * * *`
- `regenerate-index-snapshots-daily` — `0 14 * * 1-5`

### 3. Database (~3 days)

The portable part. Most of the work is operational, not code.

1. `pg_dump` the schema + data from Supabase prod.
2. Provision a managed Postgres 17 instance (Neon / Render / Fly / RDS).
   Match the major version.
3. `pg_restore` the dump. Re-enable extensions: `uuid-ossp`. (We don't
   need `pg_cron` or `pg_net` post-migration — see steps 2 and 4.)
4. Point the new backend (step 5) at the new connection string.
5. Drop the two `auth.users` sync triggers from migration
   `20260514000000_app_user_decouple.sql` — they're meaningless without
   Supabase Auth. Replace with whatever the new auth provider gives us
   for "user created" / "user deleted" webhooks (step 6).
6. Rewrite RLS policies that use `auth.uid()` and `auth.role()`. If the
   replacement auth provider issues JWTs Postgres can read, replace
   with a custom `app.current_user_id()` function that pulls the claim
   off the JWT. If not, drop RLS and move enforcement to the application
   layer (step 4).

### 4. Edge Functions → portable handlers (~1–2 weeks)

11 functions to port. Vercel handlers are the obvious target — the team
already runs the CAS router, parse-cas-pdf, and feedback-notify there
(see `app.foliolens.in/api/...`). Deno-specific imports become npm
imports; `Deno.serve` becomes a Vercel handler.

The functions, roughly ordered by simplicity:

1. `notify-feedback` — already a thin HMAC-signed relay to the Vercel router.
2. `delete-account` — calls auth admin API. Replace the admin call with
   the new provider's equivalent.
3. `fetch-fund-nav` — calls mfapi.in, writes nav_history.
4. `fetch-fund-snapshot` — calls mfdata.in, writes scheme_master + composition.
5. `sync-nav` — paginated mfapi.in for held schemes.
6. `sync-index` — three index sources (NSE / EODHD / Yahoo).
7. `sync-fund-meta` — mfdata.in with 7-day staleness window.
8. `sync-fund-portfolios` — SEBI rules + mfdata.in.
9. `regenerate-index-snapshots` — writes to the new bucket from step 1.
10. `cas-webhook-resend` — HMAC-signed inbound webhook from the Vercel router.
11. `parse-cas-pdf` — relay to the Vercel Python parser; already mostly
    just forwarding.

Update `src/lib/functions/index.ts` to point at the new endpoints. All
8 call sites are inside that module's `invoke()` — no other code change.

### 5. Data API ⇆ DB (~1 week if step 6 done first)

Two options:

- **Self-host PostgREST** against the new Postgres. Same client shape
  (URL + `Authorization: Bearer <JWT>`), same JSON envelopes. `src/lib/
  data/<table>.ts` files keep working with minor URL changes once
  supabase-js is replaced with a PostgREST-compatible fetch wrapper.
- **Write a typed backend** (tRPC / Hono / Fastify). More work, but
  every read/write becomes a deliberate endpoint with input validation.

Either way, the surface to rewrite is the 9 files in `src/lib/data/`
plus `src/lib/supabase.ts`. No hook, screen, or component file changes.

### 6. Auth (~6 weeks — the long pole)

The most invasive change. Three concerns:

1. **Pick a provider.** Clerk, WorkOS, Better Auth (self-host), Lucia,
   custom JWT. Each has different OAuth/magic-link/native bridge
   ergonomics. The native bridge at `app.foliolens.in/auth/confirm` is
   ours and provider-agnostic, so that part stays.
2. **Migrate users.** Supabase auth.users → new provider's user table.
   If UUIDs match (most providers let you import), the existing
   `public.app_user.id` keeps working and no FKs change. If not, do
   a one-shot translation in a migration before the cutover.
3. **Cutover.** All active sessions become invalid the moment we
   switch. Plan a forced re-login window. Communicate via in-app
   banner and email at least 7 days before. OAuth provider consoles
   (Google) need updated redirect URLs.

Source-side changes:
- Rewrite `src/lib/auth/index.ts` to wrap the new SDK.
- Tests in `src/hooks/__tests__/useDeleteAccount.test.ts`,
  `src/lib/__tests__/queryClient.test.ts`,
  `src/utils/__tests__/casPdfUpload.test.ts` mock the supabase module —
  swap their mocks for the new shape.
- Drop `app/auth/callback.tsx`'s `exchangeCodeForSession` path if the
  new provider doesn't use PKCE; replace with the equivalent flow.

### 7. Decommission

1. Remove the `supabase/` directory.
2. Delete the four wrapper files (`src/lib/{auth,functions,storage,
   supabase}.ts`) and replace their imports with the new provider's
   client where still needed.
3. Strip `EXPO_PUBLIC_SUPABASE_*` env vars from `app.config.js`,
   `eas.json`, EAS environment variables, and GitHub Actions secrets.
4. Cancel the Supabase project. Keep a manual `pg_dump` snapshot for
   N months in cold storage just in case.

## Verification checks we can do today (without leaving)

Two reversible spikes that prove the runbook is honest:

1. **Port the simplest Edge Function to Vercel.** `notify-feedback` is
   a thin relay. Spike a Vercel handler in a throwaway branch; confirm
   no Deno-specific shims are needed. Time-box: half a day. Output:
   "all 11 functions are portable in N days" or "here are the blockers".

2. **Replay a `supabase db dump` against a fresh Postgres 17 container.**
   Spin up Docker Postgres, restore the dump, replay all migrations
   in order. Document anything that errors on `auth.uid()` /
   `auth.users` references. Output: a concrete list of policy/trigger
   rewrites we'd need on cutover day.

Neither check touches production. Both produce evidence that
beats a hand-wavy estimate.
