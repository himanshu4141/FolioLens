# C4 Exact-Target Digest Namespace Correctness

## Purpose

Unblock the Q5 shared-dev field proof without changing its selector, digest inputs, backup format, deletion predicate, approval gate, rollback, or hydration behavior. The C3 temporary session has the required table and resolver authority, but same-session role assumption does not apply role-specific startup settings. Shared dev installs the cryptographic digest dependency outside the default visible namespace, so the reviewed dry run fails before emitting a manifest.

## Scope

- Qualify every cryptographic digest call in the dry-run and apply SQL with the hosted extension namespace.
- Add a regression proving no unqualified digest call remains in either manifest-producing path.
- Document why the repair SQL cannot depend on session search-path inheritance.
- Keep the backup, rollback, hydration, CLI credential bridge, exact selector, digest algorithm, row serialization, ordering, and fresh immediate-approval gate unchanged.

## Safety boundary

This correction may be exercised only through the non-mutating dry run, direct-to-encryption backup, no-output artifact verification, and disposable recovery rehearsal before review convergence. Shared-dev mutation remains disabled until this exact correction is reviewed, merged, the aggregate manifest is presented, and the owner gives fresh immediate approval.

## Validation

Run the focused repair suites, full Jest, typecheck, zero-warning lint, SQL/diff/privacy checks, a disposable PostgreSQL digest-equivalence proof, and one exact-dev non-mutating dry run. After the dry run succeeds, create the encrypted backup and complete the disposable recovery rehearsal. No production surface is contacted.

## Progress

- [x] Reproduce the fail-closed dry-run result without mutation.
- [x] Prove through a target-free aggregate diagnostic that the dependency exists in the hosted extension namespace but is not visible in the temporary session.
- [x] Implement explicit dependency qualification and focused regression coverage.
- [x] Complete local validation and the exact-dev non-mutating proof.
- [ ] Open and converge a frozen exact-head correctness-hotfix PR.
- [ ] Present the aggregate manifest and obtain fresh immediate approval before mutation.

## Evidence

- The exact-dev target-free diagnostic proved the digest dependency is installed in the hosted extension namespace but is not visible through the temporary session's inherited search path.
- Focused repair validation passes 2 suites / 44 tests. Full Jest passes 114 suites / 2,294 tests; typecheck, zero-warning lint, and diff checks pass.
- The corrected exact-target dry run emitted only the approved aggregate manifest. The backup streamed directly to encryption, its digest was recorded, and no-output checks proved mode-0600, non-empty, outside-repository, decryptable artifacts with the exact reviewed header.
- A disposable PostgreSQL 17 rehearsal restored the exact approved count and target digest, restored every captured holding activation, and rejected a second restore through the primary-key conflict guard. Plaintext and the disposable container were destroyed automatically. Shared dev remained unchanged.
