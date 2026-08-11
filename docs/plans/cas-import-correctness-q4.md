# Q4 CAS Catalog Isolation and Atomic Recovery

## Goal

Make a CAS import incapable of rewriting shared scheme metadata or leaving a partially created holding when a later transaction write fails. Existing catalog rows must remain unchanged, missing scheme identities must be visibly provisional until an existing authoritative metadata writer hydrates them, and catalog, holding, activation, reversal, and transaction changes must commit or roll back together.

## User Value

One person's statement can no longer rename or recategorize a fund for every FolioLens user. A failed import cannot leave an active empty holding behind, and retrying the same valid statement after a transient failure converges to the same result as one successful import. Newly encountered AMFI codes remain usable immediately while FolioLens obtains their authoritative identity and metadata in the background.

## Context

Q1, Q2, and Q3 are already merged into `main`. Q1 established a fail-closed financial contract, Q2 made depository extraction header-owned, and Q3 made transaction reconciliation provider-neutral and atomic for transaction deletes plus inserts. Q3 deliberately left three writes outside its database transaction: `scheme_master`, `user_fund`, and holding activation. The current importer also upserts CAS-provided name, category, and benchmark fields into the shared `scheme_master` row on every import. Because the table is global, one user's statement can change what every other user sees.

The shared importer is `supabase/functions/_shared/import-cas.ts`. Direct uploads enter through `supabase/functions/parse-cas-pdf/index.ts`, and inbound email enters through `supabase/functions/cas-webhook-resend/index.ts`. The existing authoritative metadata route is `supabase/functions/sync-fund-meta/index.ts`, which prefers OpenFolio metadata and fills unresolved fields from mfdata and mfapi. The database migration `supabase/migrations/20260810000000_cas_event_ordinal.sql` currently owns Q3's service-role-only transaction-plan function.

The supplied private statements may be used only as independent, transient, aggregate pass/fail evidence. Their files, passwords, filenames, holder data, extracted content, exact counts, and financial values must never be committed, logged, posted, or retained. The two statements belong to different people and must never be combined.

## Assumptions

- The branch is `program/Q4-cas-catalog-isolation` from Q3's exact merge on current `origin/main`.
- The deployment workflows intentionally deploy Edge Functions before migrations. New Edge code must therefore probe a Q4 capability function and fail before domain access while the migration is absent.
- `scheme_master.scheme_name` is non-null, so a missing scheme needs one provisional display name from the validated CAS payload before a `user_fund` foreign key can be created.
- `scheme_master.scheme_category` is nullable. A provisional row does not need a CAS category, benchmark, ISIN, or performance field.
- The service-role Edge importer is the only caller of the new database function. No client receives a new RPC or table permission.
- Q5 owns shared-dev data repair. Q4 changes prevention and future recovery behavior only.
- Production deployment and production data changes are out of scope.

## Definitions

- **Shared catalog:** `scheme_master`, whose row for one AMFI scheme code is visible to every authenticated user.
- **Provisional identity:** The minimum row needed to satisfy the holding foreign key when an AMFI code is absent: validated scheme code, a temporary CAS display name, and explicit timestamps recording CAS creation and later authoritative identity hydration. It contains no CAS category or benchmark claim.
- **Authoritative hydration:** Updating the provisional row through the existing `sync-fund-meta` provider route. The authoritative scheme name comes from mfapi's AMFI identity response; OpenFolio remains primary for its metadata fields, and mfdata remains the documented fallback.
- **Catalog digest:** A deterministic representation of all catalog fields whose equality before and after an import proves that an existing row was not changed.
- **Atomic import plan:** One PostgreSQL function call that inserts only missing provisional identities, creates or reuses user holdings, revalidates the Q3 transaction snapshot, applies exact reversal deletes and transaction inserts, and derives final `is_active` state in one database transaction.
- **Active holding:** A user-owned `user_fund` row whose validated closing balance is positive, or, when the statement does not provide a complete closing balance, whose committed transaction history remains non-empty after the plan.

## Scope

- Stop CAS imports from updating any column of an existing `scheme_master` row.
- Insert only a minimal provisional identity for a previously unknown AMFI scheme code.
- Add explicit, nullable CAS identity creation and authoritative hydration timestamps.
- Extend `sync-fund-meta` so pending provisional identities are included even if no active holding references them, and so a successful mfapi identity fetch replaces the provisional name and records hydration.
- Trigger `sync-fund-meta` in the background after an import creates at least one provisional identity, using only an aggregate result flag/count outside the importer.
- Replace the Q3 transaction-only mutation with a Q4 service-role-only atomic import-plan function.
- Derive `user_fund.is_active` from the complete validated closing balance when present; otherwise derive it from the committed post-plan transaction history.
- Revalidate the expected fund identity and immutable transaction-ID snapshot under deterministic locks before any mutation.
- Preserve Q3 economic reconciliation, exact reversal targeting, event ordinals, and retry idempotency.
- Add multi-user catalog immutability, missing-scheme hydration, injected-failure rollback, and retry-convergence tests.
- Update technical, infrastructure, cache, exit-readiness, and plan documentation.

## Out of Scope

- Repairing existing dev or production catalog, holding, or transaction rows.
- Deploying production functions, migrations, application updates, or tags.
- Adding Realtime, Vault, a client-side RPC, a new client data-access bypass, or a `SECURITY DEFINER` function.
- Trusting a CAS category, benchmark, ISIN, or other shared metadata field.
- Changing client query keys, public transaction/fund payloads, React Query persistence, Zustand, AsyncStorage, or native SQLite shape.
- Combining the two supplied statements or retaining any private validation artifact.

## Approach

Add nullable `cas_identity_created_at` and `cas_identity_hydrated_at` columns to `scheme_master`. Existing rows remain byte-for-byte unchanged with both columns null. The atomic function may insert a missing row with only `scheme_code`, validated `scheme_name`, and `cas_identity_created_at`; `scheme_category`, benchmarks, and all provider metadata remain null. It uses `ON CONFLICT DO NOTHING`, so a CAS can never update an existing catalog row, including a provisional row created by a different user.

Replace the Q3 capability and transaction-plan call in the importer with a Q4 capability and `apply_cas_import_plans_v2` call. The Edge function still performs preflight, reads the current fund/transaction snapshot, and builds the complete provider-neutral reconciliation plan before any write. Each database plan includes scheme code, provisional name, expected existing fund ID, expected transaction IDs, closing units or null, exact delete IDs, and canonical inserts.

The database function validates the JSON shape and acquires deterministic advisory transaction locks for every user-and-scheme pair. After all locks are held, it inserts missing provisional catalog rows, resolves or creates each `user_fund`, and rejects a changed expected fund identity. It then revalidates every immutable transaction-ID snapshot before applying any delete or insert. A validation failure or injected database error aborts the whole PostgreSQL transaction, including catalog and holding inserts.

Activation is calculated only after transaction mutation. A complete numeric closing balance greater than zero sets the holding active; a complete zero balance sets it inactive. When closing balance is unavailable, the final presence of at least one persisted economic transaction sets it active, otherwise inactive. This makes full redemptions inactive, preserves transaction-backed holdings from incomplete statements, and prevents active empty phantoms.

The function returns exact inserted/deleted transaction counts, processed holding count, and count of newly created provisional catalog rows. `importCASData` reports zero funds and zero transactions on any function failure. A snapshot conflict retains the Q3 conflict result; other failures use the existing privacy-safe write reason. A successful retry rereads the committed state, produces duplicates rather than inserts, and returns no new provisional identities.

`sync-fund-meta` will load the union of active held scheme codes and catalog rows whose CAS identity has not yet been authoritatively hydrated. Its mfapi helper will return both the canonical scheme name and ISIN. When a canonical name is available, the same provider-owned update writes `scheme_name` and `cas_identity_hydrated_at`; other metadata keeps the existing OpenFolio-first, mfdata-fallback precedence. Both CAS entry points trigger this existing function after the atomic result reports a newly created provisional identity. Logs and telemetry carry only aggregate counts and status, never scheme codes or statement-derived content.

No client cache contract changes. Existing imports already cause normal fund/transaction synchronization and invalidation; the two new provenance columns are absent from client selects and the provisional-to-authoritative metadata refresh remains a server-side catalog update. Therefore no React Query `__BUSTER__`, SQLite schema version, Zustand version, or AsyncStorage key change is required. The cache inventory will record this reasoning and the background hydration behavior.

## Alternatives Considered

- **Keep separate scheme, holding, and transaction writes with compensating deletes.** Rejected because compensation can fail, can race a retry, and cannot prove that another request did not observe the partial state.
- **Let CAS update only null catalog fields.** Rejected because a statement is not authoritative shared metadata, and first-writer-wins would still let one user influence all later users.
- **Reject every previously unknown scheme code.** Rejected because valid new or uncommon AMFI codes would become unimportable even though the catalog can safely create a marked provisional identity and hydrate it.
- **Store CAS category and fix it later.** Rejected because even temporary broad categories such as `Other` can misclassify index, debt, or hybrid funds for other users.
- **Mark every imported fund active.** Rejected because reversal-only, zero-balance, and failed transaction plans create phantom holdings.
- **Add a client-accessible RPC.** Rejected because the mutation belongs behind the existing server import boundary and would expand Supabase coupling and authorization surface.
- **Target `sync-fund-meta` with raw scheme-code payloads.** Rejected because the existing provider route can safely select pending provisional rows itself, avoiding identifier-bearing logs and a new externally controllable targeting contract.

## Milestones

### 1. Plan, schema contract, and focused failing tests

Create this ExecPlan, add focused importer and migration tests that describe existing-catalog immutability, minimal missing identity, multi-user behavior, activation rules, rollback, and retry convergence, then define the Q4 capability and plan payload.

Acceptance: the tests fail for the current separate-write importer for the intended reasons, and no private fixture or shared database is used.

### 2. Atomic catalog, holding, and transaction mutation

Add the provenance columns and service-role-only Q4 PostgreSQL functions. Refactor `import-cas.ts` to remove benchmark mapping and direct catalog/fund writes, send one complete plan, and interpret exact result counts.

Acceptance: an existing catalog digest is identical after imports by two different users; a missing code creates only the permitted fields; an injected insert failure leaves no catalog row, holding, activation change, delete, or transaction; a retry commits exactly once and then becomes a duplicate.

### 3. Authoritative hydration and entry-point triggering

Teach `sync-fund-meta` to include pending provisional identities, obtain canonical mfapi identity, and record authoritative hydration. Trigger it from direct-upload and inbound-email paths only when the atomic result created provisional identities.

Acceptance: a missing scheme becomes immediately importable, its provisional state is explicit, the provider route replaces its temporary name when authoritative identity is available, and an existing authoritative catalog row never receives CAS metadata.

### 4. Documentation and isolated database proof

Update `docs/TECH-DISCOVERY.md`, `docs/INFRASTRUCTURE.md`, `docs/EXIT-RUNBOOK.md`, and `docs/architecture/cache-surfaces.md`. Apply the actual migration to a local or ephemeral PostgreSQL/Supabase database, verify grants, capability, catalog digest, rollback, activation, concurrency, and retry behavior, then destroy the database and scratch files.

Acceptance: only `service_role` can execute the functions; no `SECURITY DEFINER` or client grant exists; the actual SQL demonstrates all-or-nothing behavior; no dev or production database is contacted.

### 5. Full validation, private independent proof, and review handoff

Run focused importer/sync tests, full Jest in-band, typecheck, zero-warning lint, and diff checks. Independently revalidate each supplied statement against the exact Q4 head using a local helper that reads the password file without emitting credentials or private content, discards one statement before opening the other, reports only pass/fail, and deletes every temporary artifact. Open/finalize the implementation PR and freeze its exact SHA for Codex and Claude review.

Acceptance: all checks pass, both independent private proofs pass without retained content, the exact head has green required checks, and the review round begins with no further pushes until both reviewers respond.

## Validation

    npm test -- --runInBand supabase/functions/_shared/__tests__/import-cas.test.ts
    npm test -- --runInBand supabase/functions/sync-fund-meta/__tests__
    npm test -- --runInBand
    npm run typecheck
    npm run lint
    git diff --check

The isolated database proof must use the repository migration itself, not a rewritten SQL copy. It must verify function ownership and grants, reject anon/authenticated execution, prove an existing catalog digest is unchanged across users, prove a missing identity is minimal, inject a transaction error after catalog/fund work and observe a full rollback, and retry the same plan to convergence. If the local Supabase stack is unavailable, use a disposable local PostgreSQL database with equivalent roles and delete it immediately afterward. No shared dev or production resource is an acceptable substitute.

## Risks And Mitigations

- **A CAS still changes shared metadata.** The database function uses insert-on-conflict-do-nothing and accepts no category, benchmark, or provider metadata fields. Multi-user digest tests cover the boundary.
- **A missing identity stays provisional.** Pending provisional rows join the daily metadata work even when inactive, and each new provisional insert triggers the same provider route immediately. Hydration remains visibly incomplete until canonical identity succeeds, so retries are safe.
- **A write fails after a catalog or holding insert.** All domain mutation happens in one PostgreSQL transaction. Any exception rolls back every preceding statement.
- **Two imports race for a new holding.** Deterministically ordered user-and-scheme advisory locks plus expected-fund and transaction-snapshot checks make one request win and the other retry from current state.
- **Activation hides legitimate history.** Complete closing balance is the strongest statement evidence; when absent, committed transaction existence is the conservative fallback. Tests cover positive, zero, missing, reversal-only, duplicate-only, and failed plans.
- **Deployment ordering creates a mixed version window.** The Q4 Edge function probes the new capability before its first domain read/write and fails closed until the migration is present. Existing function-first workflow ordering remains unchanged.
- **Provider hydration downgrades catalog data.** The importer never updates existing rows. `sync-fund-meta` keeps OpenFolio-first field precedence and updates provisional identity only from mfapi's canonical scheme identity.
- **Cache or telemetry leaks new data.** New provenance fields remain server-only; no client payload or persisted key changes; hydration telemetry is aggregate-only.
- **Private validation leaks statement material.** The helper reads credentials locally without output, validates the statements separately, emits only pass/fail, and is deleted with all scratch immediately.

## Decision Log

- 2026-08-11: Use one service-role-only, security-invoker PostgreSQL transaction for catalog, holding, activation, reversal, and transaction writes; compensating application writes are not sufficient recovery.
- 2026-08-11: Existing `scheme_master` rows are immutable to CAS. Missing rows contain only code, provisional name, and explicit CAS identity provenance.
- 2026-08-11: Preserve origin and completion separately with `cas_identity_created_at` and `cas_identity_hydrated_at` rather than overwriting one source marker.
- 2026-08-11: Authoritative identity hydration stays in `sync-fund-meta`; mfapi supplies canonical AMFI name/ISIN while OpenFolio and mfdata retain their existing metadata precedence.
- 2026-08-11: Trigger the existing hydration job by aggregate provisional-creation result and let the job select pending rows; do not pass raw scheme-code targets through the external function contract.
- 2026-08-11: A complete zero closing balance means inactive even when historical transactions remain. Without a complete balance, post-plan transaction existence is the activation fallback.
- 2026-08-11: No client cache version changes because the new columns and atomic result details do not enter client query payloads or persisted keys.

## Progress

- [x] Read `VISION.md`, the program playbook, accepted research findings 4 and 7, the Q4 standalone prompt, Q3 plan/migration, current importer, metadata writer, deployment ordering, cache inventory, and exit-readiness constraints.
- [x] Create the Q4 branch from exact Q3 main and record the intended catalog, atomicity, activation, hydration, cache, privacy, and deployment contracts in this ExecPlan.
- [ ] Open the draft Q4 implementation PR, post the allowed control comment, and link the tracking row.
- [ ] Add failing focused tests and the Q4 migration contract.
- [ ] Refactor the importer to one atomic plan and remove CAS catalog authority.
- [ ] Add authoritative provisional-identity hydration and safe entry-point triggers.
- [ ] Update architecture, infrastructure, cache, exit-readiness, and plan evidence.
- [ ] Complete focused, full, isolated-database, and independent private validations.
- [ ] Freeze the exact SHA and begin dual independent review.
