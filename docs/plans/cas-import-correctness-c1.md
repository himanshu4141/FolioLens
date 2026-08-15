# CAS C1 — Authoritative Holding Activation

## Goal

Prevent an older CAS statement from reactivating a holding that the user has already exited, while preserving correct activation for current statements and first imports.

## User Value

An exited mutual-fund holding must not reappear in FolioLens merely because the user imports an older statement. After this change, only current statement evidence may activate or deactivate an existing holding; stale statement evidence preserves the already-committed activation state.

## Context

The CAS importer builds one plan per scheme in `supabase/functions/_shared/import-cas.ts` and sends the plans to the service-role-only PostgreSQL function `public.apply_cas_import_plans_v2`. Migration `supabase/migrations/20260811000000_cas_catalog_atomic_import.sql` introduced that function and made catalog, holding, transaction, and activation changes atomic.

The Edge importer already computes `closing_balance_is_current`. For an existing holding, it is false when committed transaction history is as new as or newer than the latest transaction in the incoming statement. For a new holding or a holding with no committed history, it is true so the first valid import remains possible.

The deployed Q4 function consults this recency flag only when closing units are numeric zero. A stale positive balance therefore forces `is_active = true`, and a stale missing balance falls back to historical transaction existence, which can also force `is_active = true`. Both paths can make an exited holding visible again. The control-plane investigation and independent Codex and Claude confirmations are recorded on PR #291 under playbook §5.4.

`user_fund.is_active` is a persisted, user-visible derived state. Portfolio and fund roster reads filter on this flag. This plan defines its owner as the database transaction that changes the holding's transaction state. Application code supplies evidence; it does not update activation separately.

## Assumptions

- C1 starts from exact `origin/main` SHA `43159a3d9e9abb8dde62bbad574fe4048e84e32a`, the merged and deployed Q4 tree.
- Q5 PR #296 remains paused and its repair SQL does not land before C1.
- No production deployment is authorized.
- Shared dev is used only after merge through the existing authorized main deployment workflow; no shared-dev data mutation is part of C1.

## Definitions

- **Existing holding:** A `user_fund` row that existed before the atomic CAS plan began.
- **Current balance evidence:** A complete closing balance whose statement activity is newer than committed history, or balance evidence for a new holding or a holding without committed history.
- **Stale balance evidence:** A plan with `closing_balance_is_current = false`.
- **Activation owner:** The service-role-only PostgreSQL transaction that mutates transactions and persists the resulting `user_fund.is_active` value.
- **Golden fixture:** A valid case whose expected financial-state result must remain stable.
- **Garbage-in fixture:** Invalid or non-authoritative input that must fail closed or preserve committed state.

## Scope

- Add one forward-only migration that replaces the deployed v2 atomic function without rewriting Q4 migration history.
- Gate activation recency before interpreting positive, zero, or missing closing units.
- Preserve prior activation for an existing holding when balance evidence is stale and the committed post-plan ledger remains non-empty.
- Keep current positive activation, current zero deactivation, stale-zero preservation, and first-import behavior unchanged.
- Keep missing-balance fallback to committed post-plan transaction existence when the evidence is current.
- Define one reusable database activation resolver so Q5 repair can deliberately recompute through the same owner instead of duplicating policy.
- Add import-plan-to-RPC golden and garbage-in fixtures for stale positive, stale missing, current positive, current zero, stale zero, and new-holding cases.
- Add an isolated PostgreSQL proof using the real Q4 and C1 migrations.
- Update technical, infrastructure, and cache documentation without changing client payload or cache shape.

## Out of Scope

- Merging or mutating Q5 repair targets.
- Repairing any existing shared-dev or production row.
- Changing CAS parsing, financial reconciliation, transaction identity, catalog hydration, or client query keys.
- Adding a client-accessible RPC, `SECURITY DEFINER`, Supabase Realtime, Vault, or a new direct data-access path.
- Deploying production functions, migrations, application updates, or tags.
- Using either private supplied statement as hotfix evidence; all C1 fixtures are synthetic.

## Approach

Create a pure, service-role-only, security-invoker SQL function that resolves final activation from five inputs: whether the holding existed before the plan, its prior activation, closing units as JSON, whether the balance is current, and whether committed post-plan transactions exist.

The resolver applies rules in this order:

1. If the holding existed and balance evidence is stale, preserve prior activation without interpreting closing units, subject to a non-empty committed post-plan ledger.
2. Otherwise, if closing units are numeric, return whether they are positive.
3. Otherwise, return whether committed post-plan transactions exist.

Replace `apply_cas_import_plans_v2` in a new migration so it captures the pre-plan holding existence and activation before creating a missing row, performs the existing locked transaction mutation unchanged, and delegates the final activation decision to the resolver. The RPC signature and Edge payload stay unchanged, so no function-first capability version bump is needed.

The resolver is the policy owner rather than a convenience duplicated only in test code. C1 tests call it through the real migration in a disposable PostgreSQL database. Q5 must invoke the same resolver when its exact-target repair recomputes activation after deleting or restoring transaction history.

No client cache key, persisted payload, SQLite schema, Zustand state, or AsyncStorage shape changes. The existing direct-import and server-sync invalidation paths already include `user-funds` and Portfolio; C1 changes only which persisted boolean the server returns.

## Alternatives Considered

- **Guard only stale positive balances.** Rejected because stale missing balances take a separate branch and can reactivate the same exited holding.
- **Move recency handling into TypeScript only.** Rejected because the database function is the atomic write authority and another caller could bypass an application-only rule.
- **Always derive activation from transaction existence.** Rejected because a complete current zero balance is stronger evidence than historical transaction presence and must deactivate a fully redeemed holding.
- **Always preserve missing-balance activation.** Rejected because a current valid transaction-only import, especially a first import, must still be able to establish an active holding.
- **Edit the already-deployed Q4 migration.** Rejected because deployed migration history is immutable; C1 needs a new forward migration.
- **Let Q5 duplicate an `exists(transaction)` update.** Rejected because duplicated policy is the drift that the two independent reviewers identified.

## Milestones

### 1. Plan and failing fixtures

Add this ExecPlan and synthetic tests that describe the six activation cases. Update the TypeScript RPC mock to reproduce the intended database policy so importer fixtures exercise the real plan inputs.

Acceptance: the stale-positive and stale-missing fixtures fail against the deployed Q4 behavior, while current-positive, current-zero, stale-zero, and new-holding fixtures describe unchanged behavior.

### 2. Forward migration and single owner

Add the activation resolver and replace `apply_cas_import_plans_v2` in a new migration. Preserve its signature, grants, security-invoker status, locking, snapshot checks, catalog authority, transaction mutation, and exact count contract.

Acceptance: anon/authenticated roles cannot execute either function; service role can; stale positive and stale missing preserve prior activation; every unchanged golden case remains stable.

### 3. Documentation and isolated database proof

Update `docs/TECH-DISCOVERY.md`, `docs/INFRASTRUCTURE.md`, and `docs/architecture/cache-surfaces.md`. Apply the repository migrations to disposable PostgreSQL 17 roles/tables and run the real resolver/RPC cases. Destroy the database and scratch files afterward.

Acceptance: the actual SQL passes all golden and garbage-in cases, proves the helper grant boundary, and no shared environment or private data is contacted.

### 4. Full validation and review handoff

Run focused Jest, full Jest, typecheck, zero-warning lint, migration-version checks, and diff checks. Open the C1 draft PR, link it in control PR #291, freeze one exact head, and request both independent reviews.

Acceptance: required checks are green at the frozen SHA, both reviewers review the same full SHA, and the executor makes no push while a review label is active.

## Validation

Run:

    npm test -- --runInBand supabase/functions/_shared/__tests__/import-cas.test.ts
    npm test -- --runInBand supabase/functions/_shared/__tests__/cas-holding-activation.test.ts
    npm test -- --runInBand
    npm run typecheck
    npm run lint
    node scripts/check-migration-versions.mjs --check-branch
    git diff --check

The isolated database proof must load the real Q4 migration followed by the real C1 migration. It must verify service-role-only execution, stale positive and stale missing preservation for an inactive existing holding, stale zero preservation for an active existing holding, current positive activation, current zero deactivation, current missing fallback, and a new holding that remains importable. It must use only synthetic identifiers and values and must delete every disposable container, database, and scratch file afterward.

After merge, use the existing authorized main workflows to deploy C1 to Supabase dev and the `foliolens-main` app surface. Verify persisted activation and cache-visible behavior with synthetic data. Production remains untouched.

## Risks And Mitigations

- **New holdings remain inactive.** The recency-preserve branch requires a pre-existing holding. A first import follows numeric balance or post-plan transaction evidence; fixtures pin both paths.
- **Current redemptions stop deactivating holdings.** Current numeric zero still resolves to false; stale evidence preserves state only while the post-plan ledger remains non-empty.
- **A stale statement changes activation through a missing-balance branch.** Recency is checked before JSON type, so positive, zero, and missing stale values preserve prior state without interpreting the balance; the post-plan ledger still prevents an active empty holding.
- **The hotfix weakens Q4 atomicity or grants.** The new migration copies the deployed RPC signature and transactional body, changes only activation resolution, and has static plus live grant/rollback checks.
- **Q5 drifts from C1.** The resolver is a database policy function and the Q5 ExecPlan/repair must call it rather than duplicate an activation expression.
- **A server value changes but the app stays stale.** Existing user-fund/portfolio invalidation is retained and exact-SHA dev/main evidence must include a cache-visible assertion.
- **Sensitive statement data leaks into proof.** C1 uses synthetic fixtures only and never reads the supplied PDFs or password file.

## Decision Log

- 2026-08-14: Follow the default playbook §5.4 sequence: pause Q5, merge C1 first, then rebase/resume Q5. No owner re-sequencing override was recorded.
- 2026-08-14: Apply balance recency before balance interpretation. This closes both stale-positive and stale-missing reactivation without changing current-balance or first-import behavior.
- 2026-08-14: Keep activation ownership in the database transaction. Introduce a reusable resolver so Q5 repair can recompute through the same policy owner.
- 2026-08-14: Keep the public RPC signature and capability at v2 because the Edge payload and result contract do not change; deploy ordering remains safe with old Edge code plus the forward migration.
- 2026-08-14: No new analytics event is needed. The user-visible behavior becomes correct without a new flow, and existing aggregate import telemetry remains sufficient.
- 2026-08-14: Round-one review found that unconditional stale-state preservation could leave `is_active = true` after the same plan removed every transaction. Keep recency ahead of balance interpretation, but make committed post-plan transaction presence a floor for preserving `true`. Add executable pgTAP coverage for all 36 valid resolver configurations plus invalid evidence instead of relying on SQL source-text assertions for policy behavior.

## Amendments

- Round one tightened the stale-evidence rule from unconditional prior-state preservation to `prior activation AND committed post-plan transaction presence`. This does not change the three intended stale exited-holding fixes, current balance behavior, or first imports; it prevents the atomic writer and the later delete-only Q5 repair from leaving an active holding with an empty ledger.
- The initial Jest contract file remains responsible only for structural boundaries such as grants, RPC signature, and delegation order. Executable policy coverage now lives in `supabase/tests/cas_holding_activation_test.sql` and runs through `supabase test db` after a full local migration replay in CI.

## Evidence

- Focused importer plus C1 contract validation: 2 suites / 117 tests passed.
- Full Jest regression: 111 suites / 2,235 tests passed.
- TypeScript typecheck and zero-warning lint passed.
- Migration integrity found 60 repository migrations, no duplicate versions, and the one new version newer than main's `20260811000000` maximum.
- A structural diff of the deployed Q4 atomic function against C1 showed only the activation-state capture, resolver delegation, and resolver grants changed; locking, catalog authority, snapshot validation, transaction mutation, and result counts stayed identical.
- The real Q4 migration followed by the real C1 migration ran in disposable PostgreSQL 17. Live service-role execution proved stale positive and stale missing preserve an inactive existing holding, stale zero preserves an active holding, current positive activates, current zero deactivates, current missing uses committed transactions, and a first missing-balance import creates one active holding. Anon/authenticated execute grants were absent. The container and both scratch files were deleted; no shared database or private data was used.
- Round-one correction validation passed the focused C1 suites with 118 tests, including an end-to-end stale missing-balance reversal that removes the final transaction; the full regression passed 111 suites / 2,236 tests; typecheck, zero-warning lint, migration integrity, and diff checks passed.
- The actual corrected migration and committed pgTAP file ran in an isolated no-port Supabase PostgreSQL 17 container. All 41 assertions passed: the complete 24-case existing-holding table, complete 12-case new-holding table, and five invalid-evidence cases. The disposable container was removed immediately afterward; no shared database or private data was used.

## Progress

- [x] Read `VISION.md`, the program playbook §5.4, control PR investigation/confirmations, Q4 migration/importer/tests, technical architecture, infrastructure deployment rules, and cache inventory.
- [x] Pause Q5, remove its active re-review label, insert C1 in the control tracking table, and branch from exact Q4 `origin/main`.
- [x] Create the C1 ExecPlan and record the activation ownership decision.
- [x] Add golden and garbage-in activation fixtures that reproduce the plan evidence and pin every unchanged case.
- [x] Add the forward migration and single activation resolver.
- [x] Update architecture and infrastructure documentation.
- [x] Complete focused, full, migration, isolated-database, typecheck, lint, and diff validation.
- [x] Open draft C1 PR #297 and post the allowed control START comment.
- [x] Freeze an exact round-one head and receive both independent results without pushing during review.
- [x] Batch both round-one P2 findings and validate one correction without touching reviewer-owned threads.
- [ ] Push the single correction, post evidence without resolving threads, and start an exact-SHA re-review.
