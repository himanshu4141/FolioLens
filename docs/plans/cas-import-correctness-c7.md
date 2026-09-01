# C7 Bounded Exact-Target Hydration Transport

## Goal

Complete the already-approved Q5 authoritative metadata hydration without allowing the complete backup-derived scope to exceed one hosted function invocation lifetime.

## User Value

The known bad shared-dev import has already been removed safely. C7 finishes the provider-owned metadata repair while retaining rollback and preventing a long multi-scheme request from leaving the operation without an aggregate result.

## Context

Q1 through Q5 and correctness interrupts C1 through C6 are merged. The approved Q5 deletion committed with zero target rows remaining and an unchanged unrelated-data digest. The encrypted rollback remains retained. C6 corrected service-role authorization and its dev deployment is verified. A target-free invalid-scope request proves the official credential passes the deployed capability boundary without mutation.

Two later authoritative hydration attempts failed closed after long hosted invocations with a hosted 5xx class before aggregate counts returned. The current local runner derives the complete exact scope from the retained encrypted backup and sends it in one request. The hosted function processes each scheme serially and can spend up to roughly one provider deadline on each of three provider stages. Total hosted time therefore grows linearly with scope size.

Both independent C7 diagnostic reviewers confirmed this structural transport defect. Claude noted that the observed 5xx class alone cannot distinguish a platform lifetime cutoff from an abrupt per-scheme failure. C7 does not query shared-dev logs or assume that distinction: single-scheme requests bound hosted work, and strict immediate failure will preserve a per-request stop boundary if one scheme still fails.

## Assumptions

- The retained encrypted backup and its key are unchanged and remain outside the repository.
- The completed deletion is not repeated and rollback is not run during implementation or review.
- Repair mode continues to bypass ordinary metadata freshness, so retry after a partially completed sequence reprocesses the complete exact scope.
- Production is never contacted or deployed.

## Definitions

- **Authoritative scope:** the ordered unique scheme-code array resolved once from the verified encrypted backup and current shared-dev ownership records.
- **Batch:** exactly one scheme from that authoritative scope sent in one request.
- **Count conservation:** a successful one-scheme response must be exactly `success: true`, `updated: 1`, `failed: 0`, and `skipped: 0`, with no additional fields.
- **Partial completion:** earlier batches may have completed before a later batch fails. This is bounded and retry-safe, not atomic.

## Scope

- Strictly parse the complete authoritative scope once.
- Require one non-empty, ordered, unique array of positive safe integer scheme codes.
- Write a private mode-0600 single-scheme request plan without printing identifiers.
- Send exactly one request at a time with no concurrency and no retry.
- Add explicit connect and total request deadlines.
- Require exact HTTP 200 and exact one-scheme count conservation for every response.
- Stop immediately on timeout, non-200, malformed or extra response shape, contradictory counts, or unresolved result; never attempt a later batch after failure.
- Emit only final aggregate `updated`, `failed`, and `skipped` counts after complete success.
- Remove per-request payload, response, and credential configuration files immediately and retain trap cleanup for exit and signals.
- Document and test the load-bearing exact-repair freshness bypass.

## Out of Scope

- Any change to Q5 SQL, selector, backup, digest, ownership, approval, deletion, apply, rollback, or recovery contracts.
- Any change to provider precedence or metadata-writing behavior.
- Shared-dev hydration before C7 merges through frozen exact-SHA dual convergence.
- Repeating deletion, running rollback, querying private repair rows, production access, or production deployment.
- Automatic retry, concurrency, broader batches, or fallback credentials.

## Approach

Add a small local Node helper because the project and CLI wrapper already require Node. In `prepare` mode it reads the single PostgreSQL-produced JSON document, validates its exact shape and ordering, and creates a private newline-delimited plan whose every line is one single-scheme request. It prints only the plan length. In `validate-response` mode it accepts only the exact success object and prints nothing.

The shell runner keeps the original verified scope and normalized plan private. For each line it creates fresh mode-0600 payload, response, and curl-configuration files, supplies the credential only inside the configuration file, invokes curl with explicit deadlines, validates the response, removes the three files, and then advances. Any failure removes the current files and exits before reading the next plan line. Complete success requires the aggregate updated count to equal the validated plan length and prints only the three allowed aggregate counts.

The exact-target function retains its freshness bypass. A nearby comment and regression explain that retries must reprocess the complete backup-derived scope after partial completion.

## Alternatives Considered

- Increasing the hosted lifetime was rejected because it leaves runtime proportional to scope and does not bound individual work.
- Concurrent requests were rejected because they broaden provider load and complicate the stop boundary.
- Automatic retries were rejected because the reviewed program permits no unreviewed fallback and retries could hide persistent per-scheme failure.
- Reading shared-dev logs was not required for implementation because the structural defect is independently confirmed and strict single-scheme failure remains diagnostic without exposing private identifiers.

## Milestones

### Milestone 1: Local transport correction

Create the strict JSON helper, replace the single full-scope curl with a sequential single-scheme loop, add explicit deadlines and private cleanup, and document retry safety beside the exact-repair freshness bypass.

Acceptance: complete synthetic sequences aggregate correctly; any anomalous middle request exits before a later request; no credential or scheme code appears in argv or output.

### Milestone 2: Validation and review

Run focused repair, capability, and catalog tests; full Jest; typecheck; zero-warning lint; shell and Node syntax; diff/privacy checks; and an unchanged-Q5-SQL proof. Open one C7 correctness-hotfix PR from `program/C7-cas-repair-bounded-hydration` and freeze its head for independent Codex and Claude review.

Acceptance: both reviewers converge at the same exact full SHA, the Dual-review convergence gate and required checks are green, and every actionable reviewer thread is resolved by its reviewer.

### Milestone 3: Merge and field retry

Merge only after convergence, update the control-plane tracking and ledger, and retry only authoritative shared-dev hydration with the retained backup and key settings.

Acceptance: deletion is not repeated, rollback is not run, production is untouched, and hydration emits only aggregate `updated`, `failed`, and `skipped` counts.

## Validation

Run:

    npm test -- --runInBand scripts/__tests__/cas-repair-guardrails.test.ts scripts/__tests__/cas-repair-cli-transport.test.ts supabase/functions/_shared/service-role-capability.test.ts supabase/functions/_shared/__tests__/cas-catalog-atomicity.test.ts
    npm test -- --runInBand
    npm run typecheck
    npm run lint
    bash -n scripts/cas-repair/run-exact-target-repair.sh
    node --check scripts/cas-repair/hydration-batch-json.cjs
    git diff --check
    git diff --exit-code origin/main -- scripts/cas-repair/exact-target-dry-run.sql scripts/cas-repair/exact-target-backup.sql scripts/cas-repair/exact-target-apply.sql scripts/cas-repair/exact-target-rollback.sql scripts/cas-repair/exact-target-hydration-scope.sql

Expected: all commands exit zero. Focused stream tests prove ordered complete aggregation; strict response conservation; immediate stop after unresolved, non-200, malformed, extra-shape, or timeout responses; argv/output secrecy; per-iteration and signal cleanup; and unchanged mutation/rollback SQL.

## Risks And Mitigations

- A later batch can fail after earlier metadata updates. This already exists in the serial hosted loop. Immediate stop bounds the prefix, and exact-repair freshness bypass makes a complete retry reprocess every scheme.
- A client deadline can be too short for one worst-case scheme. The total request deadline exceeds the three documented provider deadlines plus inter-scheme delay while remaining below the hosted lifetime.
- A response could claim success with contradictory counts. Exact shape and count conservation reject it.
- Private scope or credentials could leak through arguments or temporary files. Only private file paths appear in argv; all sensitive files are mode 0600, per-request files are removed immediately, and trap cleanup covers exit and signals.

## Decision Log

- 2026-08-26: Use fixed single-scheme sequential requests with no concurrency or retry, incorporating all seven Codex diagnostic acceptance criteria.
- 2026-08-26: Add explicit connect and total curl deadlines because Claude verified the current client has neither.
- 2026-08-26: Treat no-later-request as a blast-radius boundary, not atomicity. Preserve and document the exact-repair freshness bypass as the retry-safety invariant.
- 2026-08-26: Do not query shared-dev logs during implementation. The precise prior 5xx cause remains an evidence caveat; C7 safely bounds hosted work and will still fail closed on a per-scheme crash.
- 2026-09-01: Round-one Claude review converged. Codex reported one evidence-only P2: the helper had a trailing blank line, so the recorded base-to-head diff check did not pass. Remove that blank line, rerun validation, and open one exact-head re-review without changing transport behavior.

## Progress

- [x] Obtain independent Codex and Claude confirmation of the diagnosis and correction boundary.
- [x] Implement strict scope preparation, sequential requests, deadlines, aggregation, and cleanup.
- [x] Add focused stream, privacy, cleanup, and retry-safety regressions.
- [x] Complete focused and full validation.
- [ ] Open and converge the frozen exact-head C7 correctness-hotfix PR.
- [ ] Merge, update the control plane, and retry only authoritative hydration.

## Evidence

- Focused validation passes 4 suites / 67 tests across exact-target guardrails, CLI transport, service-role capability, and catalog atomicity.
- Full validation passes 115 suites / 2,309 tests.
- Typecheck, zero-warning lint, shell syntax, helper syntax, diff checks, and unchanged Q5 SQL checks pass.
- Stream validation covers ordered complete aggregation; strict scope and response shapes; contradictory counts; unresolved, non-200, malformed extra-shape, and timeout stop boundaries; no later request; credential/identifier argv secrecy; per-request cleanup; and signal cleanup.
