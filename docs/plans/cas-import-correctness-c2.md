# C2 CLI-Authenticated CAS Repair Transport

## Goal

Remove the need for a human to copy a shared-dev database password into a local file or shell variable while preserving the already reviewed Q5 exact-target repair, encrypted backup, rollback, and immediate-approval controls.

## User Value

The owner can run the Q5 field-repair procedure using the Supabase CLI login already stored in the macOS Keychain. The transport creates a five-minute Supabase CLI database role only in process memory, runs the unchanged psql repair scripts through Docker, and then lets the role expire. No permanent database-password file is created.

## Context

Q1 through Q5 and the C1 activation-policy interrupt are merged. Q5 merged at `9134df62f248ed97d867f0b0a79eb579b4615912`; the authorized Supabase dev and `foliolens-main` deployments are green. The Q5 repair SQL deliberately uses psql commands such as `\getenv` and `\copy`. Supabase CLI 2.114.0 can authenticate to the linked database without a database password, but `supabase db query` sends SQL directly and rejects those psql commands.

The installed CLI's own connection resolver obtains the primary IPv4 pooler address, creates a temporary `cli_login_postgres` role through the Management API, waits for the pooler to accept it, and uses the session-mode pooler port. C2 exposes the same bounded transport to the Q5 runner without changing the repair SQL or its data-safety contract.

## Assumptions

- The implementation branch is `program/C2-cas-repair-cli-transport` from exact Q5 main.
- Supabase CLI 2.114.0 or later is installed and logged in under a local profile stored in the macOS Keychain.
- Docker is running and the local `postgres:17-alpine` image can provide psql.
- Only the exact authorized shared-dev project reference is accepted.
- C2 implementation and review use only mocked or synthetic tests plus a harmless `select 1` connection probe. Repair-domain data remains untouched until the existing Q5 field-proof gates are satisfied.

## Definitions

- **CLI access token:** the Supabase personal token already stored by `supabase login` in the macOS Keychain. C2 reads it into process memory and never prints, writes, or forwards it in command arguments.
- **Temporary login:** a Management API role and password with a reported 300-second lifetime. C2 accepts only the exact `cli_login_postgres` role and stops the child process before expiry.
- **Session pooler:** the official Supabase IPv4 pooler on port 5432. It preserves one PostgreSQL session for psql commands and matches the CLI's own fallback behavior.
- **Low-level runner:** `scripts/cas-repair/run-exact-target-repair.sh`, which retains all Q5 target, backup, digest, approval, and rollback guardrails.
- **CLI transport:** `scripts/cas-repair/run-exact-target-repair-with-cli.cjs`, which supplies only short-lived connection values to the low-level runner.

## Scope

- Read the current Supabase CLI profile credential from the macOS Keychain without displaying it.
- Fetch and validate the exact dev project's official primary pooler configuration.
- Create and validate one short-lived writable CLI login role.
- Wait for a harmless `select 1` probe before running any Q5 mode.
- Run psql through an ephemeral `--rm` Docker container, passing secrets only through the child environment and mounting only committed SQL plus an optional decrypted backup file.
- Preserve every Q5 dry-run, encrypted-backup, apply, hydration, rollback, digest, path, and immediate-approval check.
- Enforce a timeout safely below the server-provided role lifetime and fail closed on any mismatch.
- Update the repair runbook and Q5 plan so the CLI transport is the owner-facing path.

## Out of Scope

- Production access or deployment.
- Shared-dev repair-domain queries during implementation or review.
- Any shared-dev delete, apply, hydrate, or rollback before the existing Q5 dry run, backup, recovery rehearsal, and fresh immediate approval.
- Persisting a database password, temporary login, CLI token, private identifier, statement material, or financial value.
- Rewriting the reviewed psql SQL into a different query language or weakening a Q5 guardrail.
- Supporting non-macOS credential stores in this milestone.

## Approach

Add a Node CommonJS transport with injectable dependencies for tests. It verifies the installed CLI version, refuses inherited database-password and connection overrides, reads only the selected `Supabase CLI` Keychain account, normalizes the CLI's documented keyring encoding, and validates the token format without logging it. It then calls only the pooler-config and login-role Management API endpoints for the hard-coded dev project.

The pooler response must contain exactly one primary PostgreSQL connection whose host ends in `.pooler.supabase.com`, database is `postgres`, and username is `postgres.<exact-project-ref>`. The login response must contain role `cli_login_postgres`, a non-empty control-character-free password, and a lifetime between one and ten minutes. The transport derives `cli_login_postgres.<exact-project-ref>`, uses session port 5432 like the Supabase CLI, and sets an expiry epoch for the low-level runner to verify.

The Docker psql adapter copies allowlisted environment variable names, never values, on its command line. `--rm` removes the container record after each psql invocation. It mounts the committed repair directory read-only and mounts a generated plaintext backup file read-only only when apply, hydrate, or rollback needs it. CLI mode rejects an inherited psql adapter override and always selects this reviewed adapter. The Node parent anchors expiry to the start of the bounded login request, caps the complete child runtime below that conservative deadline, and terminates the detached runner process group so foreground psql or Docker work cannot outlive the cap. It scrubs its child-environment references in a `finally` block.

## Alternatives Considered

- **Ask the owner for a database password.** Rejected because the owner explicitly selected CLI authentication and does not want password copying or local password files.
- **Use `supabase db query` directly.** Rejected because it treats `\getenv` and `\copy` as SQL syntax and cannot preserve the reviewed direct-to-encryption backup contract.
- **Rewrite the repair into CLI-native SQL.** Rejected because it would duplicate and materially re-review backup, rollback, and secret-passing logic.
- **Save the temporary login in a `.pgpass` or environment file.** Rejected because the credential is short-lived and can stay in memory and child environment only.
- **Use the direct database hostname.** Rejected because the local network cannot reach the project's IPv6-only direct endpoint; the official session pooler is the CLI's own IPv4 fallback.

## Milestones

### 1. Transport contract and feasibility

Record C2 on control PR #291, branch from exact Q5 main, verify CLI 2.114.0, and prove with non-secret booleans that the Management API returns an official primary pooler plus a 300-second `cli_login_postgres` role.

Acceptance: no token, password, private selector, or repair-domain data is printed; no mutation occurs.

### 2. Implementation and guardrails

Add the CLI transport, Docker psql adapter, temporary-role target validation in the low-level runner, and owner-facing documentation.

Acceptance: the password is absent from argv and files; only the exact dev pooler and role pass; expiry, profile, version, target, and response mismatches stop before the runner.

### 3. Synthetic and harmless validation

Run focused Jest tests with mocked Keychain/API/psql dependencies, shell syntax, a harmless live connection probe, full Jest, typecheck, zero-warning lint, and diff checks.

Acceptance: failure paths do not leak synthetic secrets, the live probe emits only a readiness object, and shared-dev repair-domain data is not queried or mutated.

### 4. Draft PR and frozen-head review

Commit and push one C2 head, open a draft implementation PR, post the allowed C2 control comment, and freeze the exact SHA for independent Codex and Claude review.

Acceptance: both reviewers converge on the same exact SHA, the convergence gate and required checks are green, and reviewer-owned threads contain no actionable finding before merge.

### 5. Resume Q5 field proof

After C2 merges, use the CLI transport for the exact-target non-mutating dry run and encrypted backup. Complete the disposable recovery rehearsal, present only the approved aggregate manifest, and stop for fresh immediate human approval before any mutation.

Acceptance: no permanent database password exists; all original Q5 field-proof gates remain intact.

## Validation

    npm test -- --runInBand scripts/__tests__/cas-repair-cli-transport.test.ts
    npm test -- --runInBand scripts/__tests__/cas-repair-guardrails.test.ts
    bash -n scripts/cas-repair/run-exact-target-repair.sh
    bash -n scripts/cas-repair/docker-psql.sh
    node --check scripts/cas-repair/run-exact-target-repair-with-cli.cjs
    scripts/cas-repair/run-exact-target-repair-with-cli.cjs probe
    npm test -- --runInBand
    npm run typecheck
    npm run lint
    git diff --check

The live probe may execute only `select 1` against the exact dev project and may print only `{"cli_transport":"ready"}`. It must not accept a target identifier and must not invoke a repair SQL file.

## Risks And Mitigations

- **A credential appears in argv or a file.** Keychain output, API responses, and temporary login values remain inside the Node process; child argv contains only hosts, usernames, flags, and environment variable names. Tests scan every spawned argument.
- **The pooler points to another project.** Hard-coded project, hostname suffix, database, and project-scoped username validation fail closed.
- **The temporary role expires mid-operation.** C2 validates the reported lifetime, anchors it conservatively before the bounded login request, and terminates the complete detached process group with a safety margin. Exact-target scope is deliberately small; expiry still causes a transaction rollback or an unpublished backup.
- **The pooler has not refreshed the new role.** A bounded, silent `select 1` retry runs before the repair runner.
- **Docker retains the credential.** Every psql invocation uses `--rm`, no named container, no volume, and no credential file. The password is copied only to the ephemeral container environment.
- **A future CLI changes credential storage or API shape.** The minimum CLI version, token normalization, exact response validation, and focused tests stop with generic errors instead of falling back to a password.
- **C2 weakens Q5.** The low-level runner remains the sole owner of exact target, encrypted backup, manifest, immediate approval, hydration, and rollback behavior.

## Decision Log

- 2026-08-15: The owner selected the CLI-authenticated adaptation instead of supplying or storing a database password.
- 2026-08-15: Preserve the reviewed psql scripts and bridge only authentication, because `supabase db query` does not implement psql metacommands.
- 2026-08-15: Match Supabase CLI's session-pooler fallback and exact temporary-role format rather than inventing a long-lived credential.
- 2026-08-15: Keep the direct-password low-level runner for backward compatibility and testing, but make the CLI wrapper the documented owner-facing entry point.
- 2026-08-20: Round-one review required the CLI wrapper to pin the reviewed Docker adapter, anchor expiry before login-role issuance, and terminate the complete runner process group rather than relying on `spawnSync` child-only signalling.

## Amendments

- 2026-08-20: The initial implementation used a synchronous child-only timeout and allowed an inherited `Q5_PSQL_BIN`. Round-one review proved that the timeout could report a completed mutation as stopped and could leave foreground database work running. C2 now rejects the inherited adapter, derives expiry from the start of the bounded login request, runs the low-level runner in a detached process group, signals the complete group at the cap, and escalates to a group kill after a bounded grace period. Synthetic tests prove both the conservative deadline and that post-timeout work does not complete.

## Evidence

- Supabase CLI was upgraded to 2.114.0. A Management API shape probe read the existing `supabase` profile from the macOS Keychain in process memory, normalized the CLI's keyring encoding, and confirmed one official primary pooler, exact project-scoped user, exact `cli_login_postgres` role, and 300-second lifetime using only non-secret booleans and the lifetime value.
- Focused Jest passes 2 suites / 24 tests for both the new transport and all existing Q5 repair guardrails. The tests cover keyring normalization, wrong-project rejection, exact role and lifetime validation, argv containment, readiness-only behavior, inherited-password and adapter refusal, bounded login timing, process-group termination, readiness exhaustion, Docker auto-removal, allowlisted environment names, and low-level expiry validation.
- Shell syntax and Node syntax checks pass. The live C2 `probe` used the exact dev project, ran only `select 1` through the temporary role and Docker psql, and emitted only `{"cli_transport":"ready"}`. No repair-domain data or shared-dev mutation was involved.
- Full round-one correction validation passes 114 Jest suites / 2,274 tests, typecheck, zero-warning lint, shell and Node syntax checks, and `git diff --check`.

## Progress

- [x] Record C2 on control PR #291 and branch from exact Q5 main.
- [x] Verify the upgraded CLI's pooler and temporary-role contract without printing secrets.
- [x] Implement the CLI transport and Docker psql adapter.
- [x] Add focused secret-containment, target, expiry, retry, and failure-path tests.
- [x] Update the Q5 plan and repair runbook.
- [x] Complete full local validation; the harmless live probe is green.
- [x] Open the draft C2 PR and freeze an exact review head.
- [x] Batch and validate all round-one review corrections.
- [ ] Freeze one exact re-review head.
- [ ] Obtain exact-SHA Codex and Claude convergence and merge only on the green gate.
- [ ] Resume Q5 field proof without a permanent database password.
