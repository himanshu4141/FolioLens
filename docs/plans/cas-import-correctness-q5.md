# Q5 CAS Dev Repair, Freshness, and Field Proof

## Goal

Close the CAS Import Correctness implementation program by making every import outcome honest and cache-correct, then repair only the known bad shared-dev import after an exact-target dry run, recoverable backup, and fresh human approval. Record reproducible field evidence at one exact deployed `main` SHA without deploying production or retaining private statement material.

## User Value

After this milestone, FolioLens tells a user how many transactions were added, were already present, were removed by an exact reversal, or were rejected as conflicts. A successful direct upload becomes visible on web and native without stale portfolio, Money Trail, Funds, or timeline data. A harmless re-import does not pretend to add rows or wake unrelated screens. The known shared-dev incident is repaired without deleting unrelated data, and every touched shared scheme is refreshed only through the authoritative metadata writer.

## Context

Q1 through Q4 and the C1 activation-policy interrupt are merged into `main`. Q1 rejects malformed financial rows before domain writes. Q2 extracts CDSL and NSDL tables by their own headers. Q3 reconciles provider-neutral economic groups, preserves genuine multiplicity, applies exact reversals, and repairs native SQLite by immutable server transaction IDs. Q4 prevents a CAS from updating existing shared `scheme_master` rows and moves provisional catalog identity, holdings, activation, reversals, and transaction writes into one database transaction. C1 centralizes holding activation in a service-role-only resolver that checks balance recency before value and floors stale-state preservation on the committed post-plan ledger.

Q4 merged at `43159a3d9e9abb8dde62bbad574fe4048e84e32a`. The exact merge completed both the Supabase dev deployment and the `foliolens-main` application update in GitHub Actions run `31636923994`. C1 merged at `aa378035d6aab79e04ee2cfef9b710cdb04b04b2`; the authorized Supabase dev run `31862070191` and `foliolens-main` run `31862070197` both completed successfully at that exact main SHA. Production remains a separate release surface and is not authorized.

The importer already computes exact `transactionsAdded`, `transactionsDuplicate`, `reconciliationConflicts`, and database reversal-delete counts. The entry points currently discard all but the inserted count. Direct onboarding then broadly invalidates every React Query cache on both web and native, while the standalone upload screen performs no refresh. That combination over-reports no-op imports, wakes hidden work, and leaves native SQLite stale until a later lifecycle sync.

The known bad shared-dev rows are attributable to one `cas_import` record through `transaction.cas_import_id`. The exact import identifier, account identifier, statement files, credentials, extracted rows, scheme identities, and financial values are private and must remain outside committed source, pull requests, CI, logs, analytics, and retained scratch. The two supplied statements belong to different people and must never be combined. The private CDSL statement is parser-only evidence and must never be written to the database.

## Assumptions

- The branch is `program/Q5-cas-repair-field-proof` from exact current `origin/main`.
- All Q1-Q4 merge SHAs are ancestors of current `origin/main`.
- The Q4 exact-main Supabase dev and `foliolens-main` deployments succeeded before any Q5 repair approval is presented.
- The Q5 Edge Function is deployed before its migration by the existing workflow. A new schema capability must therefore reject before domain reads or writes during that mixed-version window.
- `transaction.cas_import_id` is the only permitted cleanup selector. Date, amount, scheme, folio, user, or inferred-layout heuristics are forbidden.
- A direct-upload server mutation is complete before the HTTP response. On web, transaction-derived React Query prefixes can be marked stale immediately. On native, SQLite must first synchronize from the server, then only the changed input families are invalidated.
- Inbound-email mutations remain external to the open app. Existing bootstrap, foreground, and web persisted-cache freshness probes own their eventual refresh.
- The shared-dev repair and private NSDL re-import require a fresh, explicit human approval immediately before mutation. Approval of the plan, pull request, or Q4 merge is not mutation approval.
- The seven-day observation clock begins only after Q5 is merged and the exact Q5 main build is deployed to the authorized dev/main surfaces.

## Definitions

- **Added:** a transaction row newly committed by the atomic import plan.
- **Already present:** a valid incoming economic row matched to an existing committed event and therefore not inserted.
- **Removed:** an existing transaction deleted by one uniquely matched reversal in the same atomic import plan.
- **Rejected:** a reconciliation conflict. The complete import plan remains non-mutating when this count is positive.
- **No-op import:** a successful import with zero added and zero removed rows, normally because every economic event is already present.
- **Transaction freshness fan-out:** the granular list in `src/lib/syncInvalidation.ts` that marks every transaction-derived query stale without refetching hidden screens.
- **Exact target:** the one private `cas_import.id` supplied only at runtime and used as `transaction.cas_import_id = target` for dry run, backup, deletion, rollback, and verification.
- **Unrelated digest:** a deterministic aggregate hash over every transaction outside the exact target. Equality before and after proves that cleanup did not rewrite unrelated rows.
- **Recoverable backup:** a mode-0600, locally encrypted export of every exact-target row plus the prior activation of every touched holding, with a non-secret manifest containing only row count and cryptographic digests. It is never committed or uploaded and is retained only until repair verification and rollback risk are closed.
- **Authoritative scheme:** a touched shared catalog row successfully refreshed through `sync-fund-meta`; an unresolved row is reported only as an aggregate count and remains explicitly provisional rather than being filled from CAS data.

## Scope

- Add exact non-negative audit columns for already-present, rejected/conflict, and removed transaction counts.
- Add a Q5 schema capability so function-first deployment fails before any domain read/write until those columns exist.
- Preserve exact added, already-present, removed, and rejected counts through direct upload, inbound email, audit history, notifications, operational logs, and privacy-safe bucketed telemetry.
- Keep the legacy `transactions` response field as the added count for compatibility while making the named fields authoritative.
- Show the four named outcomes honestly in standalone upload, onboarding completion/recovery copy, import history, and inbound email detail text.
- Replace broad onboarding invalidation with an explicit direct-import freshness helper. Web marks the transaction/holding fan-out stale; native runs the server-to-SQLite delta/ID-set repair first, then invalidates only families that actually changed. Added/removed rows or holding activation changes trigger refresh; only a zero-transaction, zero-holding-change result is a no-op.
- Document the additive audit and onboarding-draft shapes, query ownership, persistence behavior, lifecycle behavior, telemetry, and buster rationale.
- Create a generic, exact-target repair procedure whose committed source contains no target. The private runtime helper must perform read-only identity/ownership checks, exact-target count, unrelated digest, encrypted backup, rollback validation, and guarded mutation.
- Prove the deployed Q1-Q4 prevention rejects the known malformed layout before financial/domain writes using only synthetic or transient private aggregate evidence.
- After fresh approval, delete exactly the attributable shared-dev rows, verify the unrelated digest is unchanged, refresh the touched shared schemes through `sync-fund-meta`, and independently perform the authorized field proofs.
- Record exact Q5 release, build, and OTA identifiers and start the seven-day direct-upload plus inbound-email observation window.

## Out of Scope

- Any production function, migration, application update, data read, or data mutation.
- Deleting by date, value, scheme, folio, user, or inferred statement structure.
- Editing a transaction attributable to another import, another user, or no import.
- Persisting either private PDF, either filename, credentials, password-file contents, holder data, extracted rows, exact private financial values, or exact scheme identities.
- Combining the two supplied statements in memory, fixtures, validation, repair, or reporting.
- Inserting the private CDSL statement into any database.
- Replacing lifecycle freshness with Realtime, broad polling, root invalidation, or a client-accessible repair RPC.
- Production rollout or closing the control PR before the full observation window is recorded.

## Approach

Add `transactions_duplicate`, `reconciliation_conflicts`, and `transactions_removed` to `cas_import`, each non-null with a zero default and a non-negative check. Add `cas_import_schema_version_v3()` with service-role-only execution. The shared importer probes v3 before reading user funds or transactions. During the workflow's function-first window, a valid import therefore returns a privacy-safe failure with zero domain writes until the migration is present.

Carry the database function's exact `deleted_count` into `CASImportResult`. Extend `buildImportOutcome` so audit rows, API responses, email notifications, and telemetry agree on all four transaction outcomes. Keep `transactions` as an additive compatibility alias for `transactions_added`. Conflict responses include named aggregate counts even though the HTTP status remains a failure; client code wraps such failures in a typed `CasUploadError` so screens can display the counts without exposing internal error bodies.

Introduce a direct-import freshness helper with injected sync and query-client dependencies for focused tests. It treats added/removed rows or an atomic holding creation/activation change as a server change. On web it calls the existing granular transaction/holding fan-out directly. On native it calls `syncDeltaForUser`, whose immutable ID comparison observes inserts and deletes and repairs SQLite atomically, then passes the real `SyncResult` plus the server holding-change signal to `invalidateQueriesForSync`. A failed rebuild remains an error. Only a true zero-transaction, zero-holding-change result returns without sync, invalidation, or refetch. Call both upload screens with the signed-in user and an `unknown` visible route so affected caches are stale but hidden screens do not wake; the Done screen's normal Portfolio query then fetches the fresh inputs when it mounts.

Extend the persisted onboarding result additively. Existing v1 drafts remain readable because the original `funds` and `transactions` fields retain their meaning and missing named fields default to zero. No AsyncStorage key bump is needed: no field is removed or reinterpreted, and the loader repairs old payloads into the complete in-memory shape. React Query server payloads and SQLite schema do not change, so the persisted React Query `__BUSTER__` and native SQLite schema version remain unchanged.

The live repair is deliberately split from the merged application code. A generic committed runbook defines the invariants and accepts the exact import identifier only through a non-echoed runtime channel. The local wrapper connects only to the authorized shared-dev database, passes database credentials and private selectors through the child environment rather than process arguments, proves every target row belongs to the audit owner, computes target and unrelated digests, and streams the target rows plus prior touched-holding activation into locally encrypted mode-0600 backup storage. It emits only aggregate counts and digests. Mutation is disabled unless the fresh approval phrase is supplied after the human reviews the dry-run manifest. The mutation executes one serializable database transaction that locks holdings and transactions, proves the decrypted backup's count, owner, import scope, complete-row digest, and prior activation match the approved target, rechecks current target and unrelated digests, deletes only `cas_import_id = target`, and calls the C1 resolver with stale/missing balance evidence so deletion can only preserve or deactivate prior state. Any mismatch rolls back. Apply and rollback delete their mode-0600 plaintext on every exit. Rollback first proves the holdings still match the resolver's expected post-apply state, restores only absent backed-up primary keys, then restores the captured prior activation exactly.

After deletion, invoke the existing `sync-fund-meta` authoritative writer for pending or explicitly runtime-selected repair targets without putting scheme identifiers in logs or source. The helper reports only total touched, hydrated, and unresolved counts. The private NSDL statement is then processed alone against the repaired account only after the same fresh approval; the private CDSL statement is processed alone in parser-only transient memory. A sanitized synthetic CDSL fixture supplies the isolated database insert/re-import proof.

## Alternatives Considered

- **Keep reporting only inserted rows.** Rejected because a no-op looks like success without explaining what happened, a conflict loses its exact rejected count, and reversal-only mutations cannot trigger freshness.
- **Invalidate the entire React Query cache after upload.** Rejected because it wakes unrelated hidden work and still cannot refresh native SQLite before derived hooks read it.
- **Always run native sync, including no-op/conflict.** Rejected because the outcome already proves no transaction mutation and unnecessary foreground work would hide regressions in count semantics.
- **Use a committed migration containing the bad import ID.** Rejected because it would persist a private target, could later reach production, and cannot provide immediate approval semantics.
- **Delete by the affected account or date range.** Rejected because it cannot prove attribution and risks unrelated user transactions.
- **Back up only aggregate counts.** Rejected because aggregates cannot restore deleted rows. The encrypted row backup is necessary for recovery but is never exposed to the model, Git, CI, or GitHub.
- **Let CAS data repair the shared catalog.** Rejected because Q4 removed CAS authority. Only the provider-owned metadata writer may correct shared catalog fields.
- **Start the seven-day clock from Q4.** Rejected because honest outcome telemetry and direct-upload cache behavior are Q5 changes; the observation window must exercise the completed program.

## Milestones

### 1. Exact-main prevention deployment and plan

Verify every Q1-Q4 merge is on current `origin/main`, record exact Q4 Supabase dev and `foliolens-main` deployment evidence, and create this ExecPlan. Exercise the deployed malformed-layout safety boundary with a synthetic fixture or a transient private helper that emits only pass/fail and zero-write evidence.

Acceptance: exact Q4 SHA `43159a3d9e9abb8dde62bbad574fe4048e84e32a` is deployed on both authorized surfaces, production is untouched, and malformed input reaches only the allowlisted failed-audit transition.

### 2. Honest outcomes and direct-upload freshness

Add the migration/capability, propagate exact outcome counts, update user-visible surfaces and telemetry, replace broad invalidation, and add focused tests for insert, no-op, reversal, conflict, web, native, old onboarding drafts, audit, notification, and sanitizer behavior.

Acceptance: API, audit, notification, telemetry, settings history, and both upload UIs agree; web and native refresh on added/removed rows; no-op/conflict cause no cache or SQLite work; hidden screens do not refetch; the function-first mixed-version window has zero domain reads/writes.

### 3. Generic repair guardrails and documentation

Write the target-free repair runbook and test its planner/verifier against synthetic isolated rows. Update `docs/TECH-DISCOVERY.md`, `docs/INFRASTRUCTURE.md`, `docs/architecture/cas-upload-flow.md`, the inbound CAS flow, cache inventory, exit runbook, and this plan.

Acceptance: synthetic dry run resolves only exact provenance, encrypted backup/rollback is demonstrably recoverable, any count/digest drift aborts, no private identifier appears in source or test output, and all docs describe the same contract.

### 4. Full validation, draft PR, and frozen-head review

Run all focused Q1-Q4 parser/import/reconciliation/cache/analytics tests, full Jest, Python, typecheck, zero-warning lint, migration replay, and diff/privacy checks. Open the draft Q5 PR, update the control row and ledger, finish evidence, and freeze one exact head for Codex and Claude.

Acceptance: all local and required CI checks are green at one full SHA; both reviewers converge at that SHA with no actionable thread before merge.

### 5. Approved shared-dev repair and field proof

Run the non-mutating dry run and create the encrypted backup. Present only exact aggregate targets and digests to the human owner. Stop and obtain fresh explicit approval. After approval, execute the guarded deletion, authoritative hydration, independent private validations, synthetic integration, and web/native portfolio consistency proof.

Acceptance: exactly the approved target rows are removed, unrelated digest is unchanged, all touched schemes are authoritative or aggregate-reported unresolved, the private statements stay separate and transient, and every required portfolio/cache surface agrees.

### 6. Merge and observation window

Merge only after exact-SHA convergence and green required checks. Record the exact Q5 main deployment and identifiers. Exercise both direct-upload and inbound-email success/control families with explicit denominators for at least seven days, keeping intentional rejection tests separate.

Acceptance: no success event contains a validation failure or reconciliation conflict; both paths have an exercised success or controlled test; the control PR records every exit criterion and remains draft if any unmet condition lacks explicit owner acceptance.

## Validation

    PYTHONPATH=. python -m pytest api/tests -q
    npm test -- --runInBand supabase/functions/_shared/__tests__/cas-import-contract.test.ts
    npm test -- --runInBand supabase/functions/_shared/__tests__/import-cas.test.ts
    npm test -- --runInBand src/utils/__tests__/casPdfUpload.test.ts
    npm test -- --runInBand src/lib/__tests__/syncInvalidation.test.ts
    npm test -- --runInBand
    npm run typecheck
    npm run lint
    git diff --check

Apply the actual Q5 migration to a disposable local Supabase/PostgreSQL stack. Verify non-negative constraints, defaults, v3 capability ownership/grants, function-first rejection without v3, and the existing Q4 atomic plan after v3. Destroy the stack and scratch afterward.

Before shared-dev mutation, the dry run must report only approved aggregate target count, target digest, unrelated count/digest, backup digest, and touched-scheme count. The mutation must recheck every value inside one transaction. A mismatch, missing backup, absent approval token, wrong environment, or non-dev project reference must abort without mutation.

Field validation must record only aggregate pass/fail evidence. The private CDSL statement is parser-only. The private NSDL statement may reach the repaired account only after immediate mutation-time approval. Each private statement is opened, processed, and discarded independently. The local password file is consumed only through a no-output helper. Every temporary helper, decrypted buffer, public catalog copy, and scratch artifact is deleted when its utility ends; the encrypted rollback artifact remains local only until the owner closes the rollback window.

## Risks And Mitigations

- **Mixed Edge/migration deployment writes incomplete audit data.** The v3 capability is checked before the first domain read/write and is service-role-only.
- **Counts disagree across callers.** One shared outcome builder owns audit, response, notification, and telemetry; focused tests assert exact equality for insert, no-op, conflict, reversal, and write failure.
- **Native upload displays stale data.** Direct upload synchronizes immutable server IDs into SQLite before invalidating derived queries.
- **A no-op wakes hidden work.** Zero added/removed returns before sync or invalidation, and tests assert no dependency calls.
- **A reversal deletion is invisible.** Removed count is first-class and is considered a transaction change even when added is zero.
- **Additive onboarding persistence breaks old drafts.** The v1 loader repairs missing named fields to zero while preserving the existing `transactions` meaning; tests load both shapes.
- **Repair deletes unrelated data.** The only predicate is exact `cas_import_id`; ownership, count, target digest, unrelated digest, and environment are rechecked under lock before commit.
- **Backup is missing, stale, partial, or unrelated.** Backup publication is atomic. Apply verifies the encrypted digest/key first, then proves exact backup count, owner, import scope, and complete-row digest inside the deletion transaction.
- **Backup leaks personal data.** Rows stream directly into local encryption, mode 0600, and never appear in stdout, prompts, source, CI, GitHub, or model-visible files. Database credentials and private selectors do not appear in process arguments.
- **Rollback duplicates rows.** Restore first proves all backed-up primary keys are absent and runs transactionally; any conflict aborts.
- **Catalog repair repeats the original cross-user harm.** Only `sync-fund-meta` writes metadata; CAS content never supplies repair values.
- **Private statements become coupled.** Every proof uses a fresh isolated process and deletes scratch before opening the other statement.
- **Observation data leaks identities.** Telemetry uses allowlisted dialect/status and bucketed counts only; no identifiers, values, dates, filenames, or raw errors are emitted.

## Decision Log

- 2026-08-12: Treat reversal deletes as a first-class outcome because freshness cannot be derived from inserted count alone.
- 2026-08-12: Preserve the legacy `transactions` API field as an added-count alias while adding explicit authoritative fields, avoiding an unnecessary caller cutover window.
- 2026-08-12: Use a v3 capability rather than tolerating missing audit columns during function-first deployment; correctness takes precedence over temporary import availability.
- 2026-08-12: On web, invalidate the granular transaction fan-out directly. On native, synchronize SQLite first and invalidate from the observed sync result.
- 2026-08-12: Keep the onboarding draft v1 key because the persisted change is additive and the loader repairs old drafts. Record this as an explicit backward-compatible migration rather than bumping and abandoning the prior key.
- 2026-08-12: Keep the exact repair target and row backup outside committed source. The committed artifact is a generic guardrail and runbook only.
- 2026-08-12: The owner-authorized Q4 merge deviation does not authorize Q5 mutation. Q5 still stops for a fresh approval after dry-run and backup evidence.
- 2026-08-12: Require the encrypted backup itself to match the approved target count, owner, import scope, and full-row digest inside the serializable deletion transaction; a valid-looking or merely decryptable file is insufficient.
- 2026-08-12: Keep database passwords, the exact import ID, approved digests, and the approval phrase out of process arguments. The runner uses `PGPASSWORD` and psql `\getenv` values, and accepts only the exact dev direct-host/user pair or project-scoped Supabase pooler user.
- 2026-08-12: Bucket native sync/fund-roster analytics and remove the user-ID hint because direct post-import native refresh exercises that path; exact values remain only in the signed-in result UI.
- 2026-08-14: Round-one dual review found seven actionable gaps. Preserve exact rejected-row count separately from conflict groups; report holding creation/activation from the atomic database plan; propagate immutable-ID rebuild failures; suppress reconciliation tallies for failures that never reconciled; recompute touched holding activation during apply/rollback; verify the complete decrypted backup header; and derive authoritative catalog hydration only from the encrypted exact-target backup through a service-role-only, identifier-silent mode.
- 2026-08-15: C1 merged and deployed to the authorized dev/main surfaces. Q5 repair now calls the shared activation resolver for delete-only apply, captures prior touched-holding activation in the encrypted backup, and restores that value exactly on rollback. This replaces the unsafe `exists(transaction)` recomputation and makes the crossed-axis inactive/partially-target case reversible.

## Evidence

- Exact Q4 main deployment: GitHub Actions run `31636923994` completed successfully at `43159a3d9e9abb8dde62bbad574fe4048e84e32a`; Typecheck/Lint/Test and the `foliolens-main` EAS update both passed. The exact-head Supabase dev deployment also passed. No production workflow was invoked.
- Deployed Q4 prevention proof: a generated in-memory malformed depository table was submitted under a self-deleting ephemeral dev account. The exact deployed function returned HTTP 422 with allowlisted `unsupported_layout`, wrote zero financial-domain rows, and created only the failed audit transition. The deployed account-delete function returned success and invalidated the token; the schema's auth-user cascade owns removal of the ephemeral audit/account rows. The public dev client key was derived transiently from the public dev bundle; no service credential or supplied statement was used. The helper and aggregate result file were deleted immediately.
- Initial Q5 focused validation: six Jest suites / 264 tests passed for shared import contracts, atomic import behavior, upload parsing, onboarding-draft migration, direct-import freshness, and repair guardrails; the Python inbound-router suite passed 37 tests plus 3 subtests; typecheck, zero-warning lint, deployment-order tests, cache-shape tests, shell syntax, and diff checks passed.
- Current focused validation: seven Jest suites / 289 tests passed after repair-runner, native-sync privacy, and UI outcome hardening. Full Jest passed 112 suites / 2,245 tests; the complete Python API suite passed 360 tests plus 3 subtests; typecheck and zero-warning lint passed.
- The actual migration replayed with every repository migration in a disposable database-only Supabase stack. Live SQL confirmed v3, zero defaults, non-negative constraints, service-role execution, and anon denial.
- Synthetic exact-target proof in PostgreSQL 17 produced one target plus one unrelated row, created a complete backup, deleted exactly one target with the unrelated digest unchanged, and restored the identical target and unrelated digests through rollback. A mismatched backup aborted with `q5_backup_manifest_mismatch`, unrelated drift aborted with `q5_approved_manifest_changed`, and a cross-owner target aborted before emitting a dry-run manifest; each retained the target. The disposable databases, backup fixtures, copied scripts, and temporary files were destroyed immediately afterward.
- Round-one review correction evidence: nine focused suites / 337 tests pass for exact-row conflict, holding-only freshness, failed native rebuild, preflight-versus-reconciliation notification, wrong-backup-header, and secret-safe exact-target hydration. Full Jest passes 112 suites / 2,251 tests; the complete Python API suite passes 362 tests plus 3 subtests; typecheck, zero-warning lint, shell syntax, and diff checks pass. A disposable PostgreSQL 17 database applied the real Q5 migration, proved holding-only v3 change/no-change outcomes, deleted the sole synthetic target transaction while deactivating only its touched holding, and restored that transaction plus holding activation through the real rollback SQL; the container, plaintext backup, and proof helper were destroyed immediately.
- C1/Q5 integration evidence: Q5 was rebased onto exact C1 main and the unpublished Q5 migration was moved forward to `20260815000000` so it remains ordered after C1. Full Jest passes 113 suites / 2,261 tests; the complete Python API suite passes 362 tests plus 3 subtests; typecheck, zero-warning lint, shell syntax, migration ordering, and diff checks pass. A disposable Supabase stack replayed every migration through Q5 and passed both pgTAP files (46 assertions); schema lint reported only a pre-existing warning outside this change. A separate disposable PostgreSQL 17 crossed-axis proof preserved an inactive holding with surviving legitimate transactions, deactivated an active holding whose ledger became empty, preserved active partial and untouched holdings, restored every exact prior activation on rollback, and rejected rollback after activation drift without partially restoring rows. All containers, decrypted material, encrypted synthetic backup, keys, shims, and scratch directories were destroyed immediately. No shared database or private statement was touched.

## Progress

- [x] Read `VISION.md`, the program playbook, control description, complete exit criteria, findings 4 and 6, Q5 standalone prompt, every prior ledger entry, Q4 plan, current importer, upload clients, cache lifecycle, audit schema, and notification router.
- [x] Verify every Q1-Q4 merge is on current main and create `program/Q5-cas-repair-field-proof` from exact Q4 main.
- [x] Verify exact Q4 Supabase dev and `foliolens-main` deployments succeeded at `43159a3d9e9abb8dde62bbad574fe4048e84e32a`; no production deployment occurred.
- [x] Create this Q5 ExecPlan with explicit mutation, privacy, cache, deployment, and observation gates.
- [x] Add exact outcome persistence, contracts, telemetry, notifications, and user-visible copy.
- [x] Add direct-upload web/native freshness behavior and focused tests.
- [x] Add target-free repair guardrails, synthetic rollback proof, and required documentation.
- [x] Prove deployed malformed-layout rejection before any repair approval.
- [x] Open Q5 draft PR #296, post the allowed implementation comment, and update the control tracking row.
- [x] Complete final local implementation evidence for one consolidated head.
- [x] Push the initial consolidated implementation head and require all exact-head CI before review.
- [x] Complete frozen-head Codex and Claude round one at the same exact SHA; preserve all seven reviewer-owned threads unresolved.
- [x] Validate and push one batched correction for every round-one finding; pause re-review when C1 exposed the remaining activation-policy coupling.
- [ ] Rebase onto exact C1 main, integrate the shared resolver and exact activation rollback, validate, and start one exact-SHA re-review.
- [ ] Complete exact-SHA Codex and Claude convergence.
- [ ] Run the non-mutating shared-dev dry run and encrypted backup, then stop for immediate human approval.
- [ ] After approval, execute shared-dev repair, authoritative hydration, private/synthetic proofs, and cache/portfolio field validation.
- [ ] Merge Q5, record exact main deployment, and complete the seven-day observation window.
