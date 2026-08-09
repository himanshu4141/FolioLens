# Q1 Fail-Closed CAS Import Contract

## Goal

Prevent malformed Consolidated Account Statement (CAS) transactions from changing any financial or shared-domain data. Both the Vercel Python parser and the shared TypeScript importer must reject an unsafe payload before the first write, using the same small set of privacy-safe reason codes.


## User Value

A user can upload or email a detailed mutual-fund CAS without a parser mistake silently changing units, portfolio value, gain, or XIRR. If FolioLens cannot prove that the parsed financial rows are coherent, the import fails clearly and the portfolio remains unchanged.


## Context

The direct-upload Edge Function at `supabase/functions/parse-cas-pdf/index.ts` and the inbound-email Edge Function at `supabase/functions/cas-webhook-resend/index.ts` both call the Vercel parser at `api/parse-cas-pdf.py`, then converge on `supabase/functions/_shared/import-cas.ts`. The current depository parser in `api/_cdsl_nsdl_parser.py` assumes one CDSL-style numeric column order. An NSDL statement with Stamp Duty before NAV and Price can therefore produce plausible-looking but financially impossible rows. The current importer begins shared catalog and holding writes before proving the complete parsed payload is safe.

This plan implements only Q1 of the CAS Import Correctness program tracked by GitHub PR #291. Q2 will replace positional CDSL/NSDL extraction with header-aware extraction. Q3 will redesign provider-neutral reconciliation. Q4 will isolate shared catalog authority and settle write recovery. Q5 will perform approved dev repair and field proof.


## Assumptions

- `origin/main` at Q1 start is `5bfd33a972084793980f5428bd348b88aaac182b`.
- The accepted research branch is read-only input and is never merged or cherry-picked.
- The existing database transaction table remains unchanged in Q1.
- The initial pending `cas_import` audit insert is allowed. On rejection, only its allowlisted transition to `failed` may persist.
- Real supplied PDFs remain transient parser evidence and never become repository fixtures or logs.
- No production or dev deployment is part of this milestone.


## Definitions

- **Canonical transaction**: the parser-neutral representation that retains source cash amount, gross cash amount, stamp duty and other charges, statement NAV, transaction Price, units, date, normalized type and direction, and source dialect until validation and later reconciliation finish.
- **Preflight**: a pure, all-payload validation pass performed before any scheme, holding, transaction, deletion, or benchmark query.
- **Reason code**: a fixed low-cardinality string such as `accounting_mismatch`; unlike a raw exception it contains no filename, user identity, folio, date, or financial value.
- **Domain write**: a read or write that can affect financial data or shared catalog behavior. The audit row's pending-to-failed transition is excluded by the explicit program decision above.
- **Accounting tolerance**: the documented allowance for currency rounding and explicit charges when comparing cash with Price multiplied by units.


## Scope

- Add a canonical transaction contract and matching Python and TypeScript preflight behavior.
- Preserve NAV and Price independently, including fixtures where they differ.
- Preserve source amount, gross amount, stamp duty, taxes/loads when present, and source dialect.
- Reject invalid dates, placeholder folios, missing scheme identity, unsupported types, non-positive required values, NAV/Price contradictions, and impossible cash/Price/units equations.
- Make the complete payload fail as one unit before the first financial/domain operation.
- Keep a TypeScript defense even when Python has already validated the response.
- Replace CAS-path raw operational logs, analytics properties, and persisted audit errors with allowlisted reason codes and bucketed counts.
- Report exact inserted counts only when Supabase returns an exact non-null count; null and zero both report zero.
- Cover CDSL, NSDL, CAMS, KFintech, and MFCentral with synthetic golden and garbage fixtures, including direct-upload and inbound-email outcome contracts.
- Update current CAS architecture and observability documentation.


## Out of Scope

- Header-aware CDSL/NSDL extraction or the NSDL column-map repair.
- Provider-neutral deduplication, split/combined-row reconciliation, or reversal redesign.
- Shared scheme catalog ownership changes or a new transaction/RPC/staging mechanism.
- Dev data cleanup, migrations, deployment, production rollout, or cache changes.
- Persisting or committing either private PDF or any personal or exact private financial data.


## Approach

Create `api/_cas_preflight.py` as the Python canonicalizer and validator. The standard CAS adapter and the depository adapter will retain the expanded transaction fields and dialect, then every successful parser response will pass through this preflight. A typed validation exception will carry only a reason code and count summary to the HTTP handler.

Create `supabase/functions/_shared/cas-import-contract.ts` as the provider-neutral TypeScript contract. It will canonicalize older parser-compatible shapes defensively, validate the full payload without I/O, bucket counts, build audit/telemetry outcome data, and expose a typed preflight error. `importCASData()` will call it before the first Supabase operation and operate on the canonical result.

Both caller functions will use the same safe failure helpers. Direct upload will turn a preflight failure into HTTP 422 plus a failed audit row. Inbound email will validate every parsed attachment before importing any attachment, finalize the audit with a reason code, and send a generic actionable notification. Success and failure telemetry will contain only allowlisted dimensions and buckets.

Synthetic Python table fixtures will preserve the observed CDSL and NSDL header orders. The current CDSL order must pass; the current NSDL positional misread must fail safely until Q2. TypeScript fixtures will cover the five provider dialects, Price-versus-NAV behavior, mixed valid/corrupt schemes, malformed dates, placeholder folios, truncated financial fields, and exact-count null/zero behavior.


## Alternatives Considered

- **Fix only the NSDL indexes now.** Rejected because it would combine Q1 and Q2, would leave other malformed provider outputs writable, and could break the supplied CDSL order.
- **Trust Python validation only.** Rejected because parser and Edge deployments can drift and every all-provider caller converges at the TypeScript importer boundary.
- **Validate one scheme immediately before writing it.** Rejected because a later corrupt scheme would leave a partial payload written.
- **Persist raw exceptions for debugging.** Rejected because CAS exceptions and upstream bodies can contain personal or financial details; stable reason codes and bucketed counts are sufficient operationally.
- **Add a database transaction or staging table in Q1.** Rejected because preflight can stop parser-driven partial writes without adding provider-specific database surface; write recovery belongs to Q4.


## Milestones

### 1. Establish the canonical contract and fixtures

Add the Python and TypeScript contract types, reason-code allowlists, count buckets, direction/type rules, and synthetic provider fixtures. Expected outcome: the same provider-neutral financial fields and failure vocabulary exist on both runtime boundaries.

Run:

    PYTHONPATH=. python -m pytest api/tests/test_cas_preflight.py -q
    npm test -- --runInBand supabase/functions/_shared/__tests__/cas-import-contract.test.ts

Acceptance: every provider golden fixture passes; garbage fixtures fail with only an allowlisted reason; a Price different from NAV uses Price for the transaction equation while still enforcing a sane NAV/Price relationship.


### 2. Enforce Python fail-closed parsing

Retain dialect and expanded financial fields in both Python adapters. Validate before the Vercel route returns HTTP 200. Replace raw exception analytics and user responses with safe categorized outcomes.

Run:

    PYTHONPATH=. python -m pytest api/tests -q

Acceptance: synthetic CDSL table extraction passes; the observed NSDL header order is rejected before parser success; missing/truncated financial data and malformed dates fail with HTTP-safe reason codes; no test output contains fixture values categorized as prohibited private fields.


### 3. Enforce TypeScript zero-write preflight and exact counts

Call preflight at the top of `importCASData()` before even benchmark lookup. Convert import errors to allowlisted codes and make null or zero exact upsert counts report zero. Replace row-level raw-value logs with aggregate safe summaries.

Run:

    npm test -- --runInBand supabase/functions/_shared/__tests__/import-cas.test.ts

Acceptance: an NSDL-shift payload and a valid-plus-corrupt mixed payload cause no Supabase financial/domain call; duplicate upserts returning null or zero report zero; existing valid reversal and inactive-fund behavior remains covered without expanding Q1 into reconciliation redesign.


### 4. Integrate both callers and document the contract

Use shared safe outcome builders in direct upload and inbound email. Ensure inbound attachments all pass preflight before any import. Store reason codes rather than raw payloads/errors, send safe user messages, and emit only allowlisted/bucketed telemetry. Update `docs/TECH-DISCOVERY.md`, `docs/INFRASTRUCTURE.md`, `docs/architecture/cas-upload-flow.md`, and `docs/architecture/cas-inbound-flow.md`.

Run:

    npm test -- --runInBand
    npm run typecheck
    npm run lint
    git diff --check

Acceptance: pure caller-contract tests cover `pdf` and `email`; direct rejection is HTTP 422 with a failed audit transition; inbound rejection produces a failed audit and failure notification contract; both preserve successful provider outcomes and exact inserted counts.


### 5. Final exact-head evidence and PR handoff

Run all required validation after the implementation commit, record the exact 40-character SHA and results in the draft PR, then make the PR ready, add `program-milestone` and `needs-review`, update PR #291 to `In review`, and freeze the head.

Run:

    PYTHONPATH=. python -m pytest api/tests -q
    npm test -- --runInBand supabase/functions/_shared/__tests__/import-cas.test.ts
    npm test -- --runInBand
    npm run typecheck
    npm run lint
    git diff --check

Acceptance: every command is green at the PR head, the cache statement says `[cache-shape-stable]` because no cache key/payload/lifetime/invalidation/persistence changed, the Edge Functions are explicitly recorded as not deployed, and the frozen-head review round starts only after evidence is complete.


## Validation

Focused validation proves canonical equations, provider fixtures, all-or-nothing preflight, caller outcomes, privacy allowlists, and exact-count behavior. Full Python tests guard every parser family. Full Jest guards shared import and app behavior. Typecheck and lint guard the root TypeScript project; Edge Function modules remain excluded according to repository rules, so their pure shared modules are exercised through strict `ts-jest`. `git diff --check` guards patch integrity.

No production, dev, or local persistent database mutation is required for Q1. Mocked Supabase tests verify the zero-domain-write property. If implementation unexpectedly needs a migration or durable local DB check, pause and amend this plan before proceeding.


## Risks And Mitigations

- **False rejection of a valid registrar transaction.** Use provider golden fixtures, explicit type rules, Price fallback, and a documented tolerance; fail closed is intentional, but all existing parser-family contracts must remain green.
- **Python and TypeScript rule drift.** Keep reason codes, equations, and fixtures parallel and compare canonical outputs in tests where practical.
- **Partial inbound import across attachments.** Parse and preflight all attachments before importing any of them.
- **Deployment skew.** Retain TypeScript canonicalization of the prior parser-compatible shape; do not depend solely on new Python fields.
- **Privacy regression through diagnostics.** Build logs, audit fields, telemetry, and notification errors from allowlisted codes and buckets rather than trying to redact arbitrary strings after the fact.
- **Scope creep into Q2-Q4.** Keep the current positional extractor and database write sequence; only place the preflight gate in front of them.


## Decision Log

- 2026-08-09: Use the transaction Price for the accounting equation when present; NAV is an explicit fallback. When both exist, require them to be within a bounded percentage so the known NSDL shift cannot hide behind a plausible Price.
- 2026-08-09: Purchases/switch-ins use `Price × units` or that value plus explicit charges; redemptions/switch-outs use `Price × units` or that value minus explicit charges. Rounding tolerance is the greater of ₹1 and 0.2% of gross cash, because including the full charge as tolerance would blur the two directions.
- 2026-08-09: Outflows accept either unsigned magnitudes or a negative signed amount/units pair for adapter compatibility. Inflows reject negative signed pairs, and all unit-changing rows reject mismatched amount/unit signs.
- 2026-08-09: Missing folio is allowed as `null`, but known sentinels such as `No`, `CDSL`, and `NSDL` are invalid.
- 2026-08-09: Exact Supabase count `null` is treated as unknown and therefore zero inserted, never as attempted-row count.
- 2026-08-09: Q1 changes no cache key, payload, lifetime, invalidation, persistence, or restore behavior; the React Query persistence buster remains unchanged.


## Progress

- [x] Read product intent, program protocol, accepted Q1 research sections, and live PR #291 state.
- [x] Mark Q1 `In progress` and create `program/Q1-cas-preflight` from current `origin/main`.
- [x] Add canonical Python and TypeScript contracts plus provider fixtures.
- [x] Enforce Python fail-closed behavior and safe parser outcomes.
- [x] Enforce importer zero-write preflight, safe codes, and exact counts.
- [x] Integrate direct-upload and inbound-email caller outcomes.
- [x] Update current CAS architecture and observability docs.
- [ ] Run focused and full validation at the exact implementation head.
- [ ] Open the draft implementation PR and start the frozen dual-review round.
