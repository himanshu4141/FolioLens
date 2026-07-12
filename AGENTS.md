# AGENTS.md

## Purpose

This file is the stable entry point for coding agents in this repository. Keep it
short and durable: it should tell agents how to load context, how to avoid common
repo-specific mistakes, and which checks must pass before closing work.

Do not use this file as a product-status snapshot. Current capabilities belong in
`README.md`, screen/navigation details in `docs/SCREENS.md`, infrastructure state in
`docs/INFRASTRUCTURE.md`, and active plans in `docs/plans/`.

## Progressive context loading

Load only the context needed for the task.

1. Always read `VISION.md` first. It defines the product goal and what must remain
   true from a user perspective.
2. Read `README.md` only when you need the current shipped capability set, local
   setup, project structure, or release workflow.
3. Read the task-specific docs below only when the change touches that area.
4. Read active ExecPlans under `docs/plans/` only for the feature/refactor you are
   working on. Archive docs are historical; use them for background only.
5. Prefer current root/docs material over old plan/archive material when deciding
   what the app does today.

| Read this | When you are... |
|---|---|
| `VISION.md` | Starting any session or checking product intent |
| `README.md` | Checking current capabilities, setup, structure, or release flow |
| `DESIGN.md` | Building/changing UI, colours, typography, theme, Clear Lens tokens |
| `docs/SCREENS.md` | Working on layout, navigation, responsive shells, desktop/mobile split |
| `docs/INFRASTRUCTURE.md` | Touching CI/CD, EAS/Vercel/Supabase/Resend/PostHog, env vars, releases |
| `docs/TECH-DISCOVERY.md` | Touching DB schema, data sources, ingestion, OpenFolio/mfdata pipeline |
| `docs/architecture/cache-surfaces.md` | Touching React Query, Zustand, AsyncStorage, SQLite, invalidation, persistence |
| `docs/EXIT-RUNBOOK.md` | Touching Supabase abstraction, lock-in boundaries, provider swap points |
| `docs/process/PLANS.md` | Creating or maintaining an ExecPlan |
| `docs/process/AGENT-PROGRAM-PLAYBOOK.md` | Running a multi-agent/milestone program |

Stable repository facts:
- The product is FolioLens. Older archived material may still say FundLens.
- The app is Expo/React Native with web support, Supabase-backed data, EAS update
  channels, Vercel web hosting, and PostHog observability.
- The source of truth for what is currently shipped is not this file.

## Planning defaults

- Prefer explicit assumptions over implicit ones.
- Keep plans and progress updated when work spans multiple steps.
- Validate with runnable checks in proportion to risk.
- For small, contained changes, an ExecPlan is not required.
- For work that spans multiple files/systems, is risky, or will take more than a
  short session, create or update an ExecPlan following `docs/process/PLANS.md`.

## Validation checklist before closing any PR

Do not raise or mark a PR ready-for-review until the relevant checks pass.

### TypeScript + lint

```bash
npm run typecheck   # zero errors
npm run lint        # zero warnings (--max-warnings 0)
```

Run focused tests for the changed area. Run full Jest when touching shared hooks,
cache, auth, data access, navigation, analytics, or cross-cutting utilities.

```bash
npm test -- --runInBand
```

### React hooks

- All `useEffect`, `useCallback`, and `useMemo` hooks must include every variable
  they reference in their dependency array.
- `react-hooks/exhaustive-deps` is set to `error`; lint catches most issues, but
  review manually too.

### Edge Functions

- Any Edge Function using Deno APIs (`Deno.serve`, `jsr:`, `npm:`) must live in
  `supabase/functions/` and be excluded from root `tsconfig.json` and
  `eslint.config.js`.
- After changing an Edge Function, verify deployment or explicitly state that it
  was not deployed.
- Edge Functions called by pg_cron must be deployed with `--no-verify-jwt`.

### Supabase migrations

- After writing a migration, apply it to the intended DB (`supabase db push` or
  equivalent) and confirm it ran.
- For cron schedule changes, verify `cron.job`.
- New user-owned tables FK `user_id` to `public.app_user(id)`, not `auth.users(id)`.
- New public tables read/written by supabase-js need explicit `GRANT` statements.
  See `supabase/migrations/20260513000002_explicit_data_api_grants.sql`.

## Supabase exit-readiness rules

The app uses Supabase but keeps provider boundaries explicit.

- Client access goes through wrappers:
  - Auth: `src/lib/auth/index.ts` (`authClient`)
  - Edge Functions: `src/lib/functions/index.ts` (`functionsClient`)
  - Storage: `src/lib/storage/index.ts` (`storageClient`)
  - Data API: `src/lib/data/<table>.ts` (`<table>Repo`)
- Do not import `supabase` from `@/src/lib/supabase` outside wrappers.
- New data access goes through, or extends, a per-table repo.
- Avoid net-new Supabase-specific surface area: no Realtime, no Supabase Vault,
  no client-side `supabase.rpc()`, no new `SECURITY DEFINER` functions unless
  unavoidable, and no business logic embedded in pg_cron SQL. Cron should call an
  HTTP endpoint.
- Tests mock at the wrapper boundary, not the Supabase module. For example,
  mock `@/src/lib/functions` when testing `functionsClient` consumers.

## Cache correctness rules

Every cache layer is inventoried in `docs/architecture/cache-surfaces.md`. Read it
before introducing a cache or changing cache shape, lifetime, owner, invalidation,
persistence, restore, or sign-out behaviour.

For cache-affecting work:
- Update `docs/architecture/cache-surfaces.md` in the same PR unless the change is
  provably unrelated to cache shape/lifetime/invalidation/persistence. State that
  reasoning in the PR when skipping the doc update.
- React Query changes must document query key shape, owning hook/screen,
  `staleTime`/`gcTime`, persistence allowlist status, and invalidation triggers.
- If a query reads transactions, NAV, index, fund metadata, auth/session, or
  server-imported data, wire it into the global sync/invalidation scheme
  (`SyncResult`/`invalidateQueriesForSync` or an explicit equivalent) for native
  and web.
- Persisted React Query payload shape changes require a `__BUSTER__` bump and
  focused restore/invalidation tests.
- Zustand, AsyncStorage, and SQLite changes must document their version mechanism
  (`version`, `-vN` key suffix, or `SCHEMA_VERSION`), migration/repair path,
  sign-out cleanup, and lifecycle/restore invalidation behaviour.
- Avoid broad root invalidation as a default. Prefer granular invalidation derived
  from the rows/domains that changed. If broad invalidation is necessary, explain
  why it cannot cause hidden-screen work or stale visible data.
- Server-side imports/mutations must identify every client cache that can become
  stale across devices. Validate foreground return, initial session/bootstrap,
  persisted-cache restore, and web reload paths where applicable.
- Add focused tests for changed cache invariants: version bump/migration, sign-out
  cleanup, restore after persistence, cross-device freshness, hidden-screen
  non-refetch, or native SQLite read-through.

## PostHog and observability rules

Use explicit, privacy-safe analytics. Do not enable autocapture or session replay
by default.

When adding or changing user-visible flows, cache/sync/auth/import paths, or
performance-sensitive work:
- Decide whether a PostHog event or UX timing signal is needed. If not, state why
  in the PR.
- Use the `analytics` facade and existing helpers (`perfMark`, navigation
  performance, UX telemetry) rather than importing PostHog SDKs directly.
- Keep event names/properties stable, low-cardinality, and documented in
  `docs/INFRASTRUCTURE.md` when operationally meaningful or dashboard/alert-worthy.
- Never send tokens, callback URLs, emails, PANs, fund IDs, transaction IDs, route
  pathnames with identifiers, raw query keys, raw user-data error payloads, or
  financial amounts.
- Bucket counts/sizes unless exact values are operationally required and safe.
- Include release/debug dimensions such as `platform`, `app_version`, and
  `eas_update_id` where they help isolate regressions.
- Add or update sanitizer/allowlist tests for any new analytics helper or event
  family that could otherwise leak identifiers.

## Stacked PRs

- Bug fixes must go on the earliest milestone branch where the faulty code was
  introduced, not on the tip of the stack.
- After adding commits to a lower branch, rebase downstream branches and
  force-push intentionally.

## Documentation updates

- Update docs in the same PR when behaviour, architecture, cache surfaces,
  observability, infrastructure, or developer workflow changes.
- Add an "Amendments" section to relevant ExecPlans if implementation diverges
  from the plan.
- Update README "What works now" only when user-visible capabilities change.
