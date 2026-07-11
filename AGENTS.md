# AGENTS.md

## Purpose
This file defines how coding agents should plan and execute work in this repository.

## Project State

Phases 1–3 are fully shipped: foundation, the Phase 2 data pipeline (M1–M9 + M11), and the Clear Lens design system. Phase 4 (Tools Hub) has M0 + M1 (Goal Planner) shipped; M2–M4 are stacked PRs. Phase 5 (CAS onboarding redesign) is in flight — M1 wizard at PR #92, M2 Resend Inbound backend at PR #93. The app has magic-link + Google auth, the upload-first onboarding wizard, home screen with XIRR / benchmark / Money Trail preview, fund detail, leaderboard, wealth simulator, portfolio insights, native feedback form with screenshot attachments, and three EAS-channel build flavours (production / preview-main / preview-pr).

Active ExecPlans live under `docs/plans/<phase>/`. Shipped plans move to `docs/plans/archive/`. The brand was renamed FundLens → FolioLens; expect old names only inside archive material.

## Repository Anchors

Read `VISION.md` at the start of every session. Read the others on-demand. These root and `docs/`-level files describe the **current** state of the app — prefer them over walking the ExecPlan archive when you need to know what the code does today.

| Read this | When you are... |
|---|---|
| `VISION.md` | Always — read this first |
| `DESIGN.md` | Building or changing UI, picking colours, working with the Clear Lens token system, or anything theme-related (light / dark / system). The token source of truth is `src/constants/clearLensTheme.ts`; this doc explains how to consume it via `useClearLensTokens()`. |
| `docs/SCREENS.md` | Working out screen layout, navigation, or the desktop-vs-mobile rendering split (chrome / shells / responsive breakpoints) |
| `docs/INFRASTRUCTURE.md` | Anything that touches CI/CD, environments, secrets, Supabase / Vercel / Resend / Expo config, or domain routing |
| `docs/TECH-DISCOVERY.md` | Touching DB schema, third-party data sources, or the data pipeline |

## ExecPlans
When writing complex features, multi-day efforts, or significant refactors, use an ExecPlan as described in `docs/process/PLANS.md` from design through implementation.

An ExecPlan is required when:
- The work spans multiple files or systems.
- The change is risky, ambiguous, or has multiple steps.
- The work is expected to take more than a short session.

For small, contained changes (single file edits, small fixes), an ExecPlan is not required.

ExecPlans must follow the formatting and content requirements in `docs/process/PLANS.md`.

## Defaults
- Prefer explicit assumptions over implicit ones.
- Keep plans and progress up to date as work evolves.
- Validate with runnable checks where possible.

## Validation Checklist (required before closing any PR)

Do not raise or mark a PR ready-for-review until all of the following pass:

### TypeScript + Lint
```bash
npm run typecheck   # zero errors
npm run lint        # zero warnings (--max-warnings 0)
```

### React hooks
- All `useEffect`, `useCallback`, and `useMemo` hooks must include every variable they reference in their dependency array.
- `react-hooks/exhaustive-deps` is set to `'error'` — lint will catch this, but review manually too.

### Edge Functions
- Any Edge Function that uses Deno APIs (`Deno.serve`, `jsr:`, `npm:`) must be in `supabase/functions/` and excluded from the root `tsconfig.json` and `eslint.config.js`.
- After making changes to an Edge Function, verify it is deployed: check the function's last-deployed timestamp in the Supabase Dashboard or re-deploy explicitly.
- Edge Functions called by pg_cron must be deployed with `--no-verify-jwt`.

### Supabase migrations
- After writing a new migration, apply it to the production DB (`supabase db push` or via the Supabase MCP tool) and confirm it ran without errors.
- For cron schedule changes, verify the `cron.job` table reflects the new schedule.
- New user-owned tables FK their `user_id` column to `public.app_user(id)`, never to `auth.users(id)`. The schema is decoupled from Supabase Auth — keep it that way. See `supabase/migrations/20260514000000_app_user_decouple.sql`.
- Any new table in the `public` schema that the app reads/writes via supabase-js needs explicit `GRANT` statements — Supabase no longer auto-exposes `public` tables to the Data API (see `supabase/migrations/20260513000002_explicit_data_api_grants.sql` for the project-wide convention and the rationale).

### Reducing Supabase lock-in
The app uses Supabase but stays exit-ready. Full reasoning + the 90-day exit plan: `docs/EXIT-RUNBOOK.md`.

- All client access goes through wrappers, not `supabase` directly:
  - Auth: `src/lib/auth/index.ts` (`authClient`)
  - Edge Functions: `src/lib/functions/index.ts` (`functionsClient`)
  - Storage: `src/lib/storage/index.ts` (`storageClient`)
  - Data API: `src/lib/data/<table>.ts` (`<table>Repo`)
- Do not import `supabase` from `@/src/lib/supabase` outside these wrappers. New data access goes through (or extends) the per-table repo.
- Avoid net-new Supabase-specific surface area: no Realtime, no Supabase Vault, no `supabase.rpc()` from the client, no new `SECURITY DEFINER` functions unless absolutely necessary, no new pg_cron jobs with business logic in SQL (cron should call an HTTP endpoint).
- **Tests mock at the wrapper boundary**, not the supabase module. A new test for code that uses `functionsClient` should `jest.mock('@/src/lib/functions', () => ({ functionsClient: { invoke: jest.fn() } }))` — never `jest.mock('@/src/lib/supabase', ...)`. Same for `@/src/lib/auth`, `@/src/lib/storage`, and `@/src/lib/data/<table>`. Bootstrap stubs in `jest.env.ts` + `__mocks__/@react-native-async-storage/` keep the supabase client importable without leaking real I/O. If a wrapper's interface changes, only that wrapper's consumers' tests update; if the underlying provider changes, only the wrappers do.

### Caches
Every cache layer is inventoried in [`docs/architecture/cache-surfaces.md`](./docs/architecture/cache-surfaces.md). Read it before introducing a new cache or changing the shape, lifetime, owner, invalidation path, persistence policy, or sign-out behaviour of a cached payload. The doc holds the bug taxonomy (12 classes) we use for audits and the "when adding a new cache" checklist.

For cache-affecting work:
- Update `docs/architecture/cache-surfaces.md` in the same PR unless the change is provably unrelated to cache shape/lifetime/invalidation/persistence. State that reasoning in the PR when skipping the doc update.
- React Query changes must document the query key shape, owning hook/screen, `staleTime`/`gcTime`, persistence allowlist status, and all invalidation triggers. If the query reads transactions, NAV, index, fund metadata, auth/session, or server-imported data, wire it into the global sync/invalidation scheme (`SyncResult`/`invalidateQueriesForSync` or an explicit equivalent) for both native and web.
- Persisted React Query payload shape changes require a `__BUSTER__` bump and focused restore/invalidation tests.
- Zustand, AsyncStorage, and SQLite changes must document their version mechanism (`version`, `-vN` key suffix, or `SCHEMA_VERSION`), migration/repair path, sign-out cleanup, and lifecycle/restore invalidation behaviour.
- Avoid broad root invalidation as a default. Prefer granular invalidation derived from the rows or domains that actually changed. If broad invalidation is necessary, explain why it cannot cause hidden-screen work or stale visible data.
- Server-side imports/mutations must identify every client cache that can become stale across devices. Validate foreground return, initial session/bootstrap, persisted-cache restore, and web reload paths where applicable.
- Add focused tests for the cache invariant being changed: version bump/migration, sign-out cleanup, restore after persistence, cross-device freshness, hidden-screen non-refetch, or native SQLite read-through.

### PostHog and observability
Use explicit, privacy-safe analytics. Do not enable autocapture or session replay by default.

When adding or changing user-visible flows, cache/sync/auth/import paths, or performance-sensitive work:
- Decide whether a PostHog event or UX timing signal is needed. If not, state why in the PR.
- Use the `analytics` facade and existing helpers (`perfMark`, navigation performance, UX telemetry) rather than importing PostHog SDKs directly.
- Keep event names and properties stable, low-cardinality, and documented in `docs/INFRASTRUCTURE.md` when they are operationally meaningful or dashboard/alert-worthy.
- Never send tokens, callback URLs, emails, PANs, fund IDs, transaction IDs, route pathnames with identifiers, raw query keys, raw error payloads containing user data, or financial amounts. Bucket counts/sizes where exact values are not required.
- Include release/debug dimensions such as `platform`, `app_version`, and `eas_update_id` where they help isolate regressions.
- Add or update sanitizer/allowlist tests for any new analytics helper or event-family that could otherwise leak identifiers.

### Stacked PRs
- When a bug fix is committed, it must go on the earliest milestone branch where the faulty code was introduced — not on the tip of the stack.
- After adding commits to a lower branch, rebase all downstream branches and force-push.

### Documentation
- After implementation, add an "Amendments" section to the relevant ExecPlan(s) if the actual implementation diverged from the original plan.
- Update the README "What works now" section to reflect any new capabilities.
