# C8 CLI Hydration Lifetime Separation

## Goal

Complete the already-approved Q5 metadata hydration without coupling the complete finite hydration plan to the short-lived database credential used only to derive that plan.

## User Value

The known bad shared-dev import is already removed and protected by an encrypted rollback. C8 makes the remaining metadata repair reliably executable even when several valid provider requests each approach their reviewed deadline, while keeping private statement data, database credentials, and exact scheme identifiers out of output.

## Context

Q1 through Q5 and correctness interrupts C1 through C7 are merged. C7 replaced one long hosted request with an ordered sequence of one-scheme requests. Every request now has a ten-second connect limit, a ninety-second total limit, strict HTTP and JSON validation, no concurrency, and no automatic retry.

The Supabase CLI bridge still runs backup verification, plaintext decryption, database scope derivation, plan creation, and the complete request sequence inside one detached child. That child is stopped at the smaller of 240 seconds or the temporary database role lifetime minus elapsed setup time and a forty-five-second safety margin. Three allowed request ceilings alone total 270 seconds. An owner-authorized aggregate diagnostic confirmed the approved scope is large enough to reach this outer deadline. The first post-C7 field attempt failed closed before aggregate counts returned, but expired hosted logs and overwritten catalog timestamps mean that historical failure cannot be attributed definitively to this deadline.

Independent Codex and Claude diagnostic reviews confirmed the structural defect and required a two-phase handoff. Claude's addendum reproduced a second live defect: the C7 loop lazily rereads a mutable plan file, so a line appended after validation can reach the network before the final aggregate check fails. C8 must execute an in-memory snapshot of the exact validated plan.

## Assumptions

- The retained encrypted backup and key remain unchanged outside the repository.
- The completed deletion is never repeated and rollback is not run during implementation or review.
- The exact-target function continues to bypass ordinary metadata freshness, so a later explicitly authorized retry reprocesses the complete scope after partial completion.
- The owner has authorized all dev-only actions needed to complete the program. Review and exact-head convergence gates still apply before the next hydration attempt.
- Production is never contacted or deployed.

## Definitions

- **Phase one:** the short-lived database phase that verifies the encrypted backup, derives the exact scope once, and publishes a private canonical plan only after complete validation.
- **Phase two:** the network-only phase that receives no database or backup credentials, validates and snapshots the published plan once, then executes that snapshot sequentially.
- **Published plan:** a mode-0600, non-symlink, caller-non-overwritable temporary file with fixed path grammar, exact count, and SHA-256 digest.
- **Positive environment allowlist:** a newly constructed phase-two environment containing only fixed minimal system variables and the exact function, service credential, approval, plan, count, and digest inputs required for execution.
- **Count conservation:** every one-scheme response must have exactly `success: true`, `updated: 1`, `failed: 0`, and `skipped: 0`, with no extra fields.

## Scope

- Preserve every Q5 SQL file byte-for-byte.
- Add explicit phase-one and phase-two hydration runner modes used only by the CLI wrapper; keep direct-password hydration behavior compatible or fail closed with an explicit reviewed path.
- Have phase one verify the backup and digest, decrypt privately, derive the scope once, create the canonical plan, produce its count and digest, publish it atomically, then immediately remove plaintext backup and raw scope before returning.
- Require fixed private plan path grammar, mode 0600, non-symlink status, exclusive ownership, no pre-existing caller-controlled destination, and atomic publication.
- Prove phase one and its complete detached process group have ended before phase two begins.
- Blank temporary database credentials in the parent, construct phase two from a positive environment allowlist, and make psql or any database/backup input unavailable there.
- In phase two, verify plan path, mode, exact shape, order, count, and phase-one digest; read it once into an in-memory snapshot before the first request; never reread the file while executing.
- Run exactly one positive scheme code per request in snapshot order, with no concurrency or retry and the existing connect/total request deadlines.
- Compute and enforce a safe overall phase-two process-group deadline from validated plan length, the ninety-second per-request maximum, and fixed bounded orchestration slack. Reject unsafe or overflowing calculations before network work.
- Preserve exact HTTP/JSON response conservation, immediate stop before later work, final aggregate-only output, signal forwarding, confirmed process-group shutdown, and complete parent-owned cleanup.
- Add privacy-safe retained classification before the field retry so a future fail-closed result distinguishes phase-one failure, overall deadline, request transport, HTTP, response contract, aggregate, signal, and cleanup without retaining private values or raw errors.

## Out of Scope

- Any change to target selection, ownership proof, approval phrase, backup format, digest contract, deletion, apply, rollback, recovery, provider precedence, hosted writer behavior, or production deployment.
- Concurrency, automatic retry, broader request batches, fallback credentials, or a simple increase/removal of the temporary-login child deadline.
- Printing or retaining scheme codes, credentials, statement rows, private paths, raw provider/database errors, or exact financial values.
- Shared-dev hydration before the C8 PR merges through frozen exact-SHA dual convergence.

## Approach

Extend the existing strict Node helper with plan metadata and snapshot operations. Phase one writes an unpublished plan to a private temporary path, validates it, computes its exact count and SHA-256 digest, removes the plaintext backup and raw database scope, and atomically renames the plan to the wrapper-owned handoff path. The phase-one process then exits, allowing the wrapper's existing process-group supervisor to prove complete shutdown.

The wrapper clears every database password field and creates phase two from a literal allowlist rather than copying the phase-one environment. Phase two validates the handoff metadata, opens and reads the complete file once, checks exact count/digest/shape/order, and unlinks the plan before the first request. Its loop consumes only the in-memory snapshot. The parent retains cleanup ownership as a backstop.

The wrapper calculates the phase-two deadline with checked integer arithmetic: plan count multiplied by the ninety-second request ceiling, plus fixed per-request and phase overhead. It runs phase two through the same detached process-group supervisor, so overall timeout and operator signals terminate the whole group and wait for confirmed shutdown. The phase-two stop message is distinct from temporary-login expiry but remains privacy-safe.

## Alternatives Considered

- Raising `MAX_CHILD_RUNTIME_MS` is rejected because server-issued temporary-role expiry remains a smaller independent ceiling.
- Removing the outer supervisor is rejected because it would regress C3 process-group and signal safety.
- Keeping the plaintext backup until phase-two exit is rejected because the network phase does not need it and may be much longer.
- Checking a plan digest once and then lazily rereading the file is rejected because append, replace, and truncate can alter network work after validation.
- Re-deriving the scope per request is rejected because it broadens the authority boundary and permits drift.

## Milestones

### Milestone 1: Two-phase private handoff

Implement strict plan publication, metadata production, immediate phase-one private cleanup, complete phase-one shutdown, parent credential blanking, and phase-two positive environment isolation.

Acceptance: phase two cannot observe a database credential, adapter, backup path, key path, plaintext path, or target import identifier; phase one publishes nothing on failure; plaintext and raw scope are absent before the first request.

### Milestone 2: Immutable bounded execution

Implement exact plan digest/count/shape verification, a one-time in-memory snapshot, pre-request plan unlinking, and a checked plan-derived phase-two process-group deadline while retaining the C7 request/response contract.

Acceptance: append, replace, and truncate after snapshot cannot alter requested work; impossible deadlines fail before network access; timeout and signals stop the whole group; any request anomaly prevents later work.

### Milestone 3: Validation and frozen-head review

Run focused repair, CLI transport, service-role capability, and catalog tests; full Jest; typecheck; zero-warning lint; shell and Node syntax; exact diff/privacy checks; and the unchanged-Q5-SQL proof. Open one C8 correctness-hotfix PR and freeze its head for independent Codex and Claude review.

Acceptance: both reviewers converge at the same full SHA, the Dual-review convergence gate and all required checks are green, and every actionable reviewer thread is resolved by its reviewer.

### Milestone 4: Merge and field completion

Merge after convergence, update control PR #291, run only the authoritative dev hydration using the retained backup and key settings, and record only aggregate field evidence. Complete remaining observation and exit checks.

Acceptance: hydration returns conserved aggregate counts; deletion is not repeated; rollback is not run; production is untouched; private temporary cleanup is complete; the program exits cleanly and its heartbeat is stopped.

## Validation

Run:

    npm test -- --runInBand scripts/__tests__/cas-repair-guardrails.test.ts scripts/__tests__/cas-repair-cli-transport.test.ts supabase/functions/_shared/service-role-capability.test.ts supabase/functions/_shared/__tests__/cas-catalog-atomicity.test.ts
    npm test -- --runInBand
    npm run typecheck
    npm run lint
    bash -n scripts/cas-repair/run-exact-target-repair.sh
    node --check scripts/cas-repair/run-exact-target-repair-with-cli.cjs
    node --check scripts/cas-repair/hydration-batch-json.cjs
    git diff --check
    git diff --exit-code origin/main -- scripts/cas-repair/exact-target-dry-run.sql scripts/cas-repair/exact-target-backup.sql scripts/cas-repair/exact-target-apply.sql scripts/cas-repair/exact-target-rollback.sql scripts/cas-repair/exact-target-hydration-scope.sql

Expected: every command exits zero. Focused tests prove phase ordering; no phase two after phase-one failure; immediate plaintext/raw-scope removal; positive environment isolation; no psql access; atomic publication; digest/count/shape drift rejection; append/replace/truncate resistance; checked independent overall deadline; no-later-request behavior; exact response conservation; argv/output secrecy; process-group signal handling; privacy-safe failure classification; and cleanup across every boundary.

## Risks And Mitigations

- A plan handoff could become a new authority surface. Fixed private grammar, exclusive creation, atomic publication, digest/count verification, single read, and pre-request unlinking keep it bounded.
- A phase-two process could inherit database authority accidentally. A literal environment allowlist and execution test prove absence rather than relying on deletion from a copied environment.
- A long finite plan could overflow deadline arithmetic. Checked safe-integer multiplication and a fixed maximum plan length reject impossible bounds before spawning phase two.
- Earlier requests can succeed before a later one fails. This remains bounded partial completion rather than atomicity; immediate stop and exact-repair freshness bypass preserve explicit retry safety.
- Cleanup could fail while private artifacts remain. Parent and child both own idempotent cleanup, cleanup failure is nonzero, and phase two cannot begin if phase-one cleanup did not complete.

## Decision Log

- 2026-09-04: Treat C8 as a structural correctness interrupt even though retained evidence cannot definitively attribute the prior post-C7 failure.
- 2026-09-04: Adopt all nine Codex diagnostic criteria and Claude's refinements: immediate plaintext removal, immutable snapshot execution, an independent derived overall deadline, and preserved process-group semantics.
- 2026-09-04: Treat the Codex snapshot requirement as superseding a one-time digest-only check because Claude reproduced an appended out-of-scope request reaching the stub writer under merged C7.
- 2026-09-04: Add privacy-safe phase failure classification before the next field attempt because hosted log retention made the previous failure unclassifiable.

## Progress

- [x] Confirm the structural boundary with independent Codex and Claude diagnostic reviews.
- [x] Consolidate every accepted requirement into this ExecPlan.
- [x] Implement the two-phase private plan handoff and positive environment separation.
- [x] Implement immutable snapshot execution and the independent plan-derived deadline.
- [x] Add focused phase, drift, timeout, signal, privacy, and cleanup regressions.
- [x] Complete focused and full validation: four suites / 72 tests; full 115 suites / 2,314 tests; typecheck; zero-warning lint; shell and Node syntax; diff checks; and unchanged Q5 SQL.
- [ ] Open and converge the frozen exact-head C8 correctness-hotfix PR.
- [ ] Merge, retry only authoritative dev hydration, and complete the field-proof exit checklist.
