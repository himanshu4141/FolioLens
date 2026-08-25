# C6 Exact-Target Service-Role Authorization Correctness

## Purpose

Complete Q5 authoritative hydration after C5 corrected its SQL guard. The request now reaches the deployed dev function, but its exact raw-string comparison rejects an official project service credential that the gateway accepts. C6 authorizes the repair mode by executing an existing service-role-only, read-only schema capability with the caller credential instead of comparing credential bytes.

## Scope

- Parse one bearer credential without logging or persisting it.
- Create a caller-scoped Supabase client carrying that credential in both the API-key and authorization boundaries.
- Require the existing `cas_import_schema_version_v2()` RPC to return its exact version with no error; database grants already deny this function to public, anonymous, and authenticated roles and grant it only to service role.
- Fail closed on malformed credentials, denial, unexpected data, or exceptions.
- Preserve the exact-target repair scope, hydration writer, provider precedence, aggregate output, backup, rollback, deletion postconditions, and production boundary.

## Safety boundary

The Q5 deletion and C5 merge are complete. The exact target remains absent, unrelated data is unchanged, and the encrypted rollback is retained. C6 validation must not repeat deletion, run rollback, contact production, or retry hydration before merge and an authorized dev deployment. The live counterexample is limited to an allowlisted in-function authorization rejection.

## Validation

Run focused helper and repair suites, full Jest, typecheck, zero-warning lint, diff/privacy checks, and a synthetic capability matrix proving malformed, anonymous-shaped, denied, unexpected, and thrown results fail closed. After frozen exact-SHA dual convergence, deploy only the changed dev function, verify the exact deployed SHA, and retry only authoritative hydration.

## Progress

- [x] Merge C5 after exact-SHA dual convergence.
- [x] Prove hydration reaches the function and is rejected by its exact-key comparison rather than by the gateway.
- [x] Implement and validate service-role capability authorization.
- [ ] Open and converge a frozen exact-head correctness-hotfix PR.
- [ ] Deploy the merged function to dev only and retry authoritative hydration.

## Decision log

- 2026-08-25: Do not try alternate keys or weaken the authorization boundary. Replace credential-byte equality with an executable capability already restricted by database grants to service role.
- 2026-08-25: Reuse the read-only schema-version capability rather than add a new RPC, secret, migration, or dynamic authorization query.

## Evidence

- Focused validation passes 3 suites / 56 tests across capability authorization, exact-target guardrails, and CLI transport.
- Full validation passes 115 Jest suites / 2,306 tests, typecheck, zero-warning lint, and diff checks.
- The capability matrix proves missing or malformed bearer input, denied capability, unexpected version, returned error, and thrown probe all fail closed; only exact service-role schema capability succeeds.
