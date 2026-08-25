# C5 Exact-Target Hydration Guard Correctness

## Purpose

Complete the Q5 shared-dev field repair after its guarded deletion committed with every approved aggregate invariant intact. The subsequent authoritative hydration stopped before contacting the provider function because psql variables embedded inside a dollar-quoted PL/pgSQL guard were not substituted. C5 transports those already required inputs through a one-row temporary table before entering the guard block.

## Scope

- Materialize the runtime target and approved target count into a transaction-local temporary table using psql substitution in ordinary SQL.
- Read that single row strictly inside the existing hydration guard and preserve every count, scope, ownership, backup, function-target, credential, and cleanup check.
- Add regression coverage that forbids psql variable tokens inside the dollar-quoted guard.
- Keep the encrypted backup, exact selector, delete/apply SQL, rollback SQL, hydration payload, downstream function mode, and production surfaces unchanged.

## Safety boundary

The approved shared-dev deletion has already completed: the expected target rows are absent and the unrelated aggregate digest is unchanged. The encrypted rollback remains verified and retained. C5 must not repeat the deletion or run rollback. Until C5 merges through frozen exact-head dual convergence, validation is limited to focused tests, a disposable PostgreSQL hydration-scope proof, and target-free readiness. After merge, retry only authoritative hydration with the retained approved backup and then report aggregate results.

## Validation

Run the focused repair suites, full Jest, typecheck, zero-warning lint, SQL/shell/diff/privacy checks, a disposable PostgreSQL 17 hydration-scope pass/fail proof, and the target-free exact-dev readiness probe. Do not contact production or repeat the shared-dev delete.

## Progress

- [x] Complete the owner-approved exact-target delete and prove the unrelated digest unchanged.
- [x] Reproduce the hydration stop before downstream function contact.
- [x] Identify the dollar-quoted psql substitution boundary as the cause.
- [x] Implement and validate the minimal temporary-table transport correction.
- [ ] Open and converge a frozen exact-head correctness-hotfix PR.
- [ ] Merge, retry authoritative hydration, and update the control plane.

## Evidence

- The immediate pre-apply manifest matched the approved aggregate manifest.
- Apply deleted the approved target count, reported zero holding activation changes, and proved unrelated data unchanged.
- The immediate post-apply dry run reported zero target rows and the approved unrelated aggregate unchanged.
- Hydration failed at the existing PL/pgSQL guard terminator before the downstream function was contacted; raw database output was suppressed and the encrypted rollback remained intact.
- Focused repair validation passes 2 suites / 44 tests. A disposable PostgreSQL 17 proof emitted the exact synthetic hydration payload on the approved count and failed closed on a count mismatch; the disposable container and plaintext fixture were destroyed.
- Full validation passes 114 Jest suites / 2,294 tests, typecheck, zero-warning lint, shell and Node syntax, and diff checks.

## Decision log

- 2026-08-25: Preserve the successful delete rather than rolling it back because all mutation postconditions passed and hydration is a separately retryable authoritative metadata step.
- 2026-08-25: Use the same one-row temporary-table input boundary already proven by the apply path; do not introduce dynamic SQL, session settings, an alternate role, or an automatic fallback.
