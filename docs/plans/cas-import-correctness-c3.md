# C3 CLI Temporary-Role Assumption Correctness

## Goal

Make the merged C2 Supabase CLI transport usable by the already reviewed Q5 exact-target repair without weakening any repair safeguard. The temporary Management API login authenticates successfully but receives the `postgres` grant with inheritance disabled. C3 must therefore assume exactly `postgres` for every CLI-transport psql session and prove the resulting authority before the low-level runner starts.

## User Value

The owner can continue using the Supabase CLI login stored in macOS Keychain without a permanent database-password file. A readiness result now means the short-lived session can actually execute the protected-table Q5 procedure, rather than merely proving that `select 1` authenticates.

## Context

Q1 through Q5, C1, and C2 are merged. C2 merged as `9e6452d10711ad3161e6b8356b30ea3f35bfb29f` after exact-SHA dual convergence at `79fb68399d23d46bd303b4c5c00140c163692cd0`. Its harmless exact-dev validation used only `select 1`. During field-proof preparation, the same temporary login failed a read-only protected-table aggregate with `permission denied`; a session-only `set role postgres` diagnosis proved the intended membership path. No dry run, backup, rehearsal, hydration, rollback, apply, or shared-dev mutation occurred.

The correctness interrupt is recorded on control PR #291. Claude and Codex independently confirmed the root cause against the exact C2 merge. An initial fixed `PGOPTIONS` design passed disposable PostgreSQL validation but the authorized exact-dev probe failed closed. Both reviewers then independently confirmed a same-session psql command boundary with command-line `ON_ERROR_STOP`, fixed `SET ROLE postgres`, exact CLI-temporary conditioning, password-mode compatibility, marker-based failure proof, and complete permission-sensitive readiness. That revised candidate passed focused and disposable PostgreSQL validation but its authorized exact-dev probe also failed closed. Because the combined probe suppressed all database output, the reviewers accepted a staged six-code diagnostic. After fresh owner authorization, its single exact-dev result was `ready`, proving that membership, same-session role application, all three table authorities, and resolver execute/runtime authority were complete. C3 therefore replaces only the faulty combined readiness statement with the already proven staged authority script. The corrected target-free exact-dev probe is green. No candidate has been pushed or opened for PR review.

## Assumptions

- The implementation branch is `program/C3-cas-repair-cli-role-assumption` from exact current `origin/main`.
- The exact C2 merge is the branch base.
- Supabase CLI 2.114.0 or later, its macOS Keychain profile, Docker, the exact dev pooler, and the five-minute temporary login remain the C2 transport boundary.
- The Q5 field proof stays paused until C3 merges through the standard correctness-hotfix gate.
- The owner-confirmed target, backup path, and key path remain runtime-only and are not needed for C3 implementation or review.

## Definitions

- **Caller startup option:** libpq's `PGOPTIONS` environment variable. CLI mode rejects any inherited value before credential access and does not forward it.
- **Effective role:** PostgreSQL `current_role` after the fixed same-session psql command. C3 accepts only exact `postgres`.
- **Fail-before-file:** command-line `ON_ERROR_STOP=1` makes a failed role command terminate psql before any later readiness command or repair SQL file executes.
- **Permission-sensitive readiness:** a silent, staged, non-mutating psql script that verifies the effective role, checks catalog authority in dependency order, then performs zero-row permission analysis for `public.transaction`, `public.cas_import`, and `public.user_fund` plus one immutable synthetic call to `public.resolve_user_fund_activation_v1(boolean,boolean,jsonb,boolean,boolean)`.
- **Direct-password compatibility path:** the pre-C2 low-level `run-exact-target-repair.sh` invocation. C3 does not change how caller-supplied libpq environment is handled in that path.
- **Diagnostic mode:** a CLI-wrapper-only, target-free mode that never calls the low-level runner. It uses the same temporary login and one fixed, non-fatal same-session role attempt, then emits exactly one allowlisted aggregate reason code or maps the run to `readiness_statement_failed`.
- **Phase A:** catalog-only checks in fixed dependency order. It distinguishes absent membership, membership present but role not applied, incomplete table authority, and missing resolver execute authority without referencing a protected table or invoking the resolver.
- **Phase B:** the success-only path reached after Phase A reports catalog readiness. It suppresses query output internally, executes the existing zero-row authority checks for all three protected tables plus one synthetic immutable resolver call, and emits `ready` only on a clean result.

## Scope

- Reject inherited `PGOPTIONS` in CLI mode before Keychain access.
- Do not forward `PGOPTIONS` into the container.
- In exact `cli-temporary` mode only, inject fixed `-v ON_ERROR_STOP=1` and then fixed `-c 'SET ROLE postgres'` before the existing reviewed psql arguments.
- Preserve prior psql argv for unset, password, or any other adapter auth-mode value.
- Replace `select 1` readiness with the permission-sensitive staged script, using the same child environment as every repair mode.
- Add tests for pre-credential override rejection, exact conditional adapter injection, effective-role readiness contract, all protected objects, every low-level mode, password-mode compatibility, argv containment, and fail-before-command/file behavior.
- Add a disposable PostgreSQL proof for `NOINHERIT`, same-session persistence, failed-role non-execution, later-command ordering, `\\copy PROGRAM` compatibility, effective role, zero-row table authority, and resolver execute authority.
- Run one exact-dev live proof limited to the silent readiness statement. It must not accept a target and must not start the low-level runner.
- After the second counterexample, make no further exact-dev contact until independent reviewers accept the diagnostic boundary and the owner gives fresh explicit authorization.
- Add one diagnostic-only adapter state: fixed `-q -c 'SET ROLE postgres'` without command-line `-v ON_ERROR_STOP=1`. Repair modes retain the fatal role injection; password mode retains the prior argv unchanged.
- In diagnostic mode, set `\\set ON_ERROR_STOP on` inside the staged script before every check after the non-fatal role attempt.
- Implement the diagnostic as staged catalog and success phases. Phase A must use only static catalog-helper strings and psql conditionals; it must quit before any protected reference unless all catalog predicates pass. Phase B may then run only the reviewed zero-row checks and synthetic immutable resolver call.
- Accept exactly one of six fixed codes in this dependency order: `role_assumption_missing`, `role_assumption_not_applied`, `table_authority_missing`, `resolver_authority_missing`, `ready`, or `readiness_statement_failed`. Any missing, duplicate, malformed, or non-allowlisted stdout; any connection, catalog, object, signature, permission, or Phase-B error; or any non-clean exit maps to `readiness_statement_failed` with raw stdout and stderr discarded.
- Keep every role, object, and exact function signature static inside the reviewed command or script. Diagnostic mode accepts no caller-selected SQL, role, object, option, target, or repair-mode fallback.
- Update the C2/Q5 repair documentation with the explicit role and readiness contract.

## Out of Scope

- Any change to `exact-target-dry-run.sql`, `exact-target-backup.sql`, `exact-target-apply.sql`, `exact-target-hydration-scope.sql`, or `exact-target-rollback.sql`.
- Any change to Q5 target, digest, encrypted backup, recovery rehearsal, hydration, rollback, immediate-approval, TTL, or process-group safeguards.
- Changing the direct-password compatibility path.
- An automatic weaker fallback when same-session role assumption fails.
- Repair-domain row reads, dry run, backup, private-statement processing, shared-dev mutation, deployment, or production access.
- Any diagnostic that emits roles, objects, SQL errors, connection details, credentials, identifiers, rows, counts, or financial values.

## Approach

Include `PGOPTIONS` in the existing forbidden inherited override list so even an empty caller value stops before version, Keychain, or Management API access. Do not forward it into Docker. The reviewed Docker adapter reads `Q5_REPAIR_AUTH_MODE` only from its host process environment and, only for exact `cli-temporary`, prepends fixed `-v ON_ERROR_STOP=1` and fixed `-c 'SET ROLE postgres'` to psql. Unset, password, and unexpected values receive the adapter's prior argv unchanged. A caller cannot obtain CLI target handling merely by spoofing the mode because the low-level runner independently requires the exact project-scoped login shape and an unexpired server lifetime.

Replace the constant readiness query with `check-cli-authority.psql`. The adapter's fixed role command and this script execute in the same psql process. The script enables `ON_ERROR_STOP`, redirects output internally, verifies exact effective role, then checks the three exact table privileges and exact resolver signature through catalog helpers in fixed dependency order. Only complete catalog authority reaches the success phase, which analyzes all three protected tables through `where false` aggregates and calls the immutable resolver with fixed synthetic evidence. Any false predicate or SQL/runtime error exits nonzero without reading a repair-domain row. Readiness continues to discard stdout and stderr and retains C2's bounded retry behavior only for connection readiness and timeout cases.

Command-line `ON_ERROR_STOP` is essential because the SQL files' own line-one `\\set ON_ERROR_STOP on` occurs after the injected role command. A non-zero psql status alone is not proof: the disposable regression must use a later command and file-side marker and demonstrate neither executes when role assumption fails. The fixed role is last-wins only relative to current reviewed later argv and SQL. Static guards therefore reject any role/session-authorization or reconnect command in the five unchanged SQL files, while hash comparison protects their complete contents.

The exact-dev proof uses only normal `probe` mode. It must not accept a target or run a low-level repair mode.

The second exact-dev counterexample requires a one-run diagnostic before choosing the final transport correction. The diagnostic is deliberately distinct from both repair and password paths. Its adapter invocation is quiet and includes the fixed role command, but omits command-line `ON_ERROR_STOP` so a failed role attempt remains observable as catalog state rather than aborting psql before the script. The script immediately enables `ON_ERROR_STOP` for every later diagnostic check. Quiet mode is required because a successful role command otherwise adds a command tag to stdout and violates the exactly-one-token contract.

The diagnostic cannot be one SQL `CASE`. PostgreSQL can perform permission checks for protected table or function references before a non-constant branch is selected, which can suppress an earlier role or authority code. Phase A therefore performs only staged catalog-helper calls with static string arguments. It first tests membership, then effective role, then all three exact table privileges, then execute privilege for the exact five-argument resolver signature. A psql conditional emits the first failing dependency code and quits before any protected reference. Only catalog `ready` reaches Phase B, which redirects query output internally, executes the reviewed zero-row protected-table checks and one synthetic immutable resolver call, then emits `ready`.

The CLI wrapper captures diagnostic stdout and stderr privately, accepts only one exact allowlisted token, and emits only the mapped aggregate code. It discards raw streams in every case. Missing roles, objects, or signatures can make catalog helpers raise and disclose names; malformed output, duplicate output, a non-clean exit, connection failure, catalog error, or Phase-B failure must therefore collapse to `readiness_statement_failed`. The diagnostic result selects a separately reviewed correction only; it never triggers an automatic fallback or a repair operation.

## Alternatives Considered

- **Keep `select 1`.** Rejected because it reproduced the merged defect: authentication can succeed while every protected table remains inaccessible.
- **Keep the combined permission statement.** Rejected because the reviewed diagnostic returned `ready` while that statement still failed closed. A staged script avoids early permission analysis and separately proves the success-only protected references.
- **Use fixed `PGOPTIONS`.** Rejected after it passed disposable PostgreSQL but the exact-dev session-pooler probe failed closed without the required authority.
- **Forward caller `PGOPTIONS` and rely on documentation.** Rejected because it would turn a currently inert caller value into a live role override.
- **Inject `SET ROLE` without command-line `ON_ERROR_STOP`.** Rejected because psql continues to the later command or SQL file after role failure; the files' own setting is too late.
- **Inject for every adapter caller.** Rejected because the low-level direct-password path may deliberately select the Docker adapter and must retain its existing argv behavior.
- **Modify each Q5 SQL file to set the role.** Rejected because those files are already reviewed and shared by the unchanged direct-password path.

## Milestones

### 1. Fixed role and permission-sensitive readiness

Implement atomic rejection, overwrite, Docker name-only forwarding, and the full readiness statement.

Acceptance: CLI mode cannot accept caller startup options; every CLI psql process receives the two fixed arguments in order; failed role assumption runs no later command or file; password-mode adapter argv is unchanged; and the low-level runner cannot start unless effective role and all protected-object permissions are ready.

### 2. Synthetic and disposable validation

Extend focused Jest assertions and run a disposable PostgreSQL 17 proof with synthetic roles, tables, and function.

Acceptance: the proof reproduces `NOINHERIT` authentication-without-authority, shows same-session role persistence, proves failed role assumption executes no later command/file, preserves `\\copy PROGRAM`, observes exact `current_role = postgres`, accesses no domain row, and fails for incomplete table/function authority.

### 3. Exact-dev harmless proof

Before another proof, implement the independently accepted diagnostic mode without committing or pushing it. Validate all six outcomes on disposable PostgreSQL, including a non-constant staging regression, the quiet healthy-output path, parser/error mapping, zero repair-domain scans, no target acceptance, no low-level-runner call, and unchanged password-mode argv. Then stop for fresh explicit owner authorization.

After authorization, run exactly one target-free diagnostic against exact dev. Report only its single allowlisted aggregate reason code. Use that result solely to choose a separately reviewed transport correction; do not fall back, run the repair probe, or touch repair-domain rows.

Acceptance: the accepted diagnostic boundary is implemented exactly; raw database streams are never exposed; the run is row-free and non-mutating; and the executor stops after the single code without changing transport behavior automatically.

### 4. Corrected exact-dev harmless proof

Run only CLI `probe` against the exact dev pooler.

Acceptance: output is only `{"cli_transport":"ready"}`; the low-level runner does not start; no target, row, private identifier, or mutation is involved.

### 5. Draft correctness-hotfix PR and frozen review

Commit and push one implementation head, open a draft PR, label it `program-milestone` and `correctness-hotfix`, post the allowed C3 implementation comment, complete validation, then add `needs-review` and freeze the exact head.

Acceptance: independent Codex and Claude convergence pins the same full SHA, the Dual-review convergence gate and all required checks are green, and every reviewer-owned thread is clean before merge.

### 6. Resume the gated Q5 field proof

After C3 merges, run the exact-target dry run, direct-to-encryption backup, no-output artifact verification, and disposable recovery rehearsal. Present only the approved aggregate manifest and stop for fresh immediate human approval.

Acceptance: no repair mutation occurs before that fresh approval.

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

Also compare SHA-256 hashes for all five `exact-target-*.sql` files against C2 merge `9e6452d10711ad3161e6b8356b30ea3f35bfb29f`. The hashes must remain identical.

Before the owner-authorized diagnostic, focused tests must additionally prove:

- all six allowlisted outcomes and their fixed dependency order;
- diagnostic `-q` plus the non-fatal fixed role attempt, including exactly one stdout token on the healthy `ready` path;
- repair-mode fatal injection and password/default/unexpected-mode argv preservation;
- a non-constant unstaged-`CASE` permission regression, so the staging test cannot pass through constant folding;
- catalog exceptions, parse-time permission failures, malformed/absent/duplicate output, non-clean exits, and Phase-B failures all map to `readiness_statement_failed` without raw-stream disclosure;
- Phase A never references protected objects directly, Phase B is reachable only after catalog readiness, and successful execution leaves all three synthetic table scan counters unchanged;
- diagnostic mode accepts no target, never invokes the low-level runner, accepts no dynamic SQL/role/object/option input, and has no repair fallback.

## Risks And Mitigations

- **Caller startup options become live.** CLI mode rejects inherited `PGOPTIONS` before credentials and the adapter never forwards it.
- **Failed role assumption still runs repair SQL.** The adapter injects command-line `ON_ERROR_STOP` before the fixed role command; a marker-based regression proves no later command or file executes.
- **A later role change defeats the pin.** Static guards plus unchanged hashes prohibit later role/session-authorization and reconnect commands; reviewed runner argv remains fixed.
- **Password-mode behavior changes.** Adapter injection is default-deny and occurs only for exact `cli-temporary`; tests execute the adapter in both CLI and password/default modes.
- **Readiness checks only one table.** The statement analyzes all three protected tables and checks the exact resolver signature.
- **Permission readiness remains underpowered.** The role injection and readiness query are separate changes; readiness still covers all three tables and the exact resolver signature.
- **Fatal role injection blinds the diagnostic.** Diagnostic mode retains the fixed role attempt but omits command-line `ON_ERROR_STOP`; the script enables it before every subsequent check. Repair modes remain fatal.
- **A successful role command corrupts the one-token output.** Diagnostic invocation uses quiet mode and the healthy `ready` regression asserts exactly one allowlisted stdout token.
- **A single SQL branch leaks or masks the first failure.** Phase A is staged and catalog-only; a non-constant regression proves protected references cannot be placed in an untaken branch.
- **Catalog helpers disclose missing names through errors.** The wrapper discards raw stdout/stderr and maps every non-clean or malformed result to `readiness_statement_failed`.
- **The diagnostic becomes a fallback transport.** It has no target, no low-level-runner call, no repair mode, and its result only selects a separately reviewed correction.
- **The role value leaks operationally.** Docker receives only the environment-variable name; no generated credential/config file or dynamic argv value is used.
- **C3 changes reviewed repair behavior.** The five Q5 SQL files, low-level direct-password behavior, and all existing repair guardrail tests remain unchanged.

## Decision Log

- 2026-08-23: Treat missing role assumption as C3 correctness interrupt and pause Q5 field proof.
- 2026-08-23: Both independent issue reviews confirmed the root cause at the exact C2 merge and required effective-role plus complete protected-object readiness evidence.
- 2026-08-23: The fixed CLI-only `PGOPTIONS` candidate passed disposable PostgreSQL but failed the exact-dev probe and was not pushed.
- 2026-08-23: Both independent re-reviews accepted fixed same-session `SET ROLE` with command-line `ON_ERROR_STOP`, conditional exact CLI-temporary adapter injection, password-mode compatibility, complete permission readiness, and marker-based failure-before-file proof.
- 2026-08-24: The revised candidate passed 2 focused suites / 36 tests, unchanged SQL hashes, privacy checks, and a disposable PostgreSQL 17 same-session proof, but the authorized exact-dev probe failed closed before the low-level runner. The executor did not infer the failed predicate, did not commit or push, updated the single investigation comment in place, and requested independent review of a target-free allowlisted-reason diagnostic.
- 2026-08-24: Codex and Claude independently accepted a staged target-free diagnostic. Codex corrected the design to retain a non-fatal fixed role attempt and separate catalog-only Phase A from success-only Phase B. Claude accepted both corrections and added quiet invocation plus a healthy-path one-token regression. Both require six fixed codes, deterministic dependency order, raw-stream suppression, wrapper-side failure mapping, zero repair-domain scans, no target/runner/fallback, and fresh owner authorization before one exact-dev run.
- 2026-08-24: The owner authorized diagnosis, dev access, code, dry run, backup, rehearsal, and repair work while preserving the fresh post-manifest approval gate before mutation. The disposable diagnostic proof passed, the one exact-dev diagnostic emitted only `ready`, and no target or low-level runner was involved.
- 2026-08-24: The `ready` result ruled out transport membership, role application, table ACL, and resolver ACL/runtime defects. The selected correction replaces the combined readiness query with a silent staged authority script while retaining fatal role assumption for repair/probe modes. Focused validation passes 2 suites / 41 tests, the disposable PostgreSQL proof passes all six diagnostic outcomes plus zero scans and fatal staged readiness, and the corrected exact-dev probe emits only the expected readiness object.
- 2026-08-24: Final pre-PR validation passes 2 focused suites / 41 tests, 114 full Jest suites / 2,291 tests, typecheck, zero-warning lint, shell and Node syntax, diff/privacy guards, unchanged reviewed Q5 SQL, the disposable PostgreSQL proof, and the single target-free exact-dev probe. No repair-domain row or shared-dev mutation was involved.
- 2026-08-23: Preserve the direct-password compatibility path unchanged, including its pre-existing handling of caller libpq environment.

## Progress

- [x] Record C3 on control PR #291 and pause Q5 field proof.
- [x] Obtain independent Claude and Codex issue-review confirmation.
- [x] Create the exact-main C3 branch and self-contained ExecPlan.
- [x] Obtain independent Codex and Claude re-review convergence on the same-session correction.
- [x] Implement and locally validate the conditional same-session candidate without committing or pushing it.
- [x] Record its exact-dev fail-closed counterexample without domain access or mutation.
- [x] Obtain independent Codex and Claude confirmation of the staged aggregate-only diagnostic boundary.
- [x] Obtain fresh explicit owner authorization and run at most the accepted target-free diagnostic.
- [x] Replace or confirm the local candidate based only on the reviewed diagnostic result.
- [x] Run focused, full, syntax, typecheck, lint, diff, privacy, SQL-hash, and exact-dev probe validation.
- [ ] Open the draft correctness-hotfix PR and freeze one exact review head.
- [ ] Obtain exact-SHA Codex and Claude convergence and merge only on the green gate.
- [ ] Resume the Q5 dry-run, encrypted-backup, recovery-rehearsal, and fresh-approval sequence.
