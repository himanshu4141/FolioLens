# C11 Standard CAS Withholding Normalization

## Goal

Allow valid KFintech standard CAS statements containing explicitly narrated tax-deducted-at-source switch-out rows to pass the existing fail-closed accounting preflight, without weakening any validation or accepting unexplained cash differences.

## User Value

A user who uploads a valid password-protected KFintech statement should receive the normal import result instead of a generic invalid-amount rejection when the statement reports net switch-out proceeds after withholding. Invalid, ambiguous, or financially inconsistent rows must continue to fail before any portfolio mutation.

## Context

The Vercel parser route uses `api/_cas_parser.py` for CAMS, KFintech, and MFCentral statements. The third-party `casparser` library preserves signed source values. For an outflow, the source amount and units can both be negative. The adapter previously copied the signed source amount into `gross_amount` whenever the library supplied no separate gross field. The preflight correctly requires gross cash to be positive, so those rows failed with the privacy-safe `invalid_amount` reason before the importer ran.

Some KFintech switch-out narrations explicitly state that tax was deducted at source. In those rows the reported source amount is net proceeds, while Price multiplied by Units independently supports the gross transaction value. The depository parser and the shared Python and TypeScript contracts already implement this exact net-withholding accounting model.

A local, read-only reproduction against the owner-supplied statement confirmed this boundary using only count buckets and allowlisted reason codes. Applying the proposed adapter transformation in memory made the complete statement pass the unchanged preflight with no rejected rows. No document, password, filename, holder data, identifier, extracted row, or financial value is retained in the repository or review evidence.

## Assumptions

- C11 changes parser normalization and strengthens the matching Python and TypeScript preflight equations without changing their tolerances or privacy-safe reason codes.
- The signed provider values remain available as `source_amount` and `source_units` for direction validation and transaction identity.
- A net-withholding basis is valid only for a redemption or switch-out with explicit, non-negated TDS, tax-deducted-at-source, or withholding wording, a positive reported tax amount, and a residual that matches that amount within normal accounting tolerance.
- Price multiplied by Units is the only independent gross evidence used for these rows.
- No production deployment is authorized by this implementation milestone.

## Definitions

- **Source cash:** the signed cash amount reported by the statement. Outflows may be negative.
- **Gross cash:** the positive economic value used for reconciliation.
- **Net of withholding:** source cash is lower than gross cash because the provider explicitly reports tax deducted at source.
- **Standard CAS:** a CAMS, KFintech, or MFCentral statement parsed by the third-party `casparser` library.
- **Fail closed:** reject the complete statement before portfolio writes when a required invariant is not proven.

## Scope

- Normalize an explicitly supplied gross amount to a positive magnitude at the standard-provider adapter boundary.
- When gross is absent, derive ordinary gross cash from the positive magnitude of source cash.
- For an explicitly narrated, non-negated TDS/withholding redemption or switch-out with a corroborated tax amount, derive gross cash from the positive magnitude of Price multiplied by signed Units and set `cash_basis` to `net_of_withholding` only when gross minus source cash matches the reported tax.
- Accept a reported tax only from a structured tax field or a currency amount explicitly attached to the withholding term; never infer it from the residual or treat a percentage as an amount.
- Share the narration, transaction-type, negation, and residual gate across standard and depository parser families.
- Preserve signed source cash and source units.
- Add synthetic regression tests for the accepted KFintech shape, ordinary signed outflows, inflow counterexamples, and excessive-withholding rejection.
- Document the standard-provider boundary in the CAS upload architecture.
- Complete a privacy-safe local statement proof after all automated checks pass.

## Out Of Scope

- Weakening Python or TypeScript preflight tolerances, privacy-safe reason codes, or mutation behavior.
- Accepting generic tax wording as withholding evidence.
- Changes to CDSL/NSDL extraction, header mapping, financial fields, or preflight. C11 may route both parser families through the same narration classifier so the safety rule cannot drift.
- Client password behavior, inbound email behavior, database repair, deletion, rollback, hydration, NAV work, or production deployment.
- Committing or posting any private statement material or exact personal values.

## Approach

Add a shared classifier in `api/_cas_withholding.py` and call it from both parser families. The classifier requires a supported outflow type, explicit positive withholding narration, no nil/zero/not-applicable negation, independently supported gross cash, and a separately reported withholding amount that reconciles to gross minus source cash. A strict extractor recognizes only a currency amount explicitly attached to the withholding term; structured tax fields take precedence, and bare wording or rates are not accepted as amounts.

The standard transaction-normalization helper in `api/_cas_parser.py` reads source amount, source units, NAV, Price, type, and description once. It preserves the source signs, converts explicit gross to a magnitude, and otherwise selects one of two fixed gross derivations:

1. For an explicitly narrated withholding outflow, use the magnitude of Price multiplied by Units and mark `cash_basis` as `net_of_withholding`.
2. For every other transaction, use the magnitude of source cash and keep `cash_basis` as `source`.

The helper does not decide whether the row is valid. It passes the normalized row into `validate_and_canonicalize_cas()`, which independently requires `charges.taxes` to match the gross-versus-source residual in addition to positive amounts, direction, Price and NAV, Price multiplied by Units, and the existing withholding anomaly ceiling. The Supabase Edge Function repeats the same reported-tax equation in TypeScript before any shared-domain I/O.

## Alternatives Considered

- Ignore or drop the tax rows. Rejected because switch-out rows carry economic units and cash and cannot be silently omitted.
- Convert every cash residual into withholding. Rejected because an unexplained difference is not evidence and would weaken fail-closed accounting.
- Raise the invalid-amount tolerance. Rejected because the failure comes from a signed field assigned to the wrong semantic role, not rounding.
- Patch the third-party `casparser` dependency. Rejected because provider-neutral gross and cash-basis semantics belong at the FolioLens adapter boundary and must remain pinned by local tests.

## Milestones

### Milestone 1: Correct the adapter boundary

Edit `api/_cas_parser.py` to preserve signed source fields, emit positive gross, and use the existing explicit-withholding model only for supported outflow types.

Expected outcome: a synthetic KFintech TDS switch-out with an explicitly reported amount reaches preflight with independent gross evidence, while bare narration and ordinary outflows remain on the source-cash basis.

Acceptance criteria: focused adapter and twin-preflight tests pass, and both preflights require the reported tax to reconcile to the residual.

### Milestone 2: Pin accepted and rejected shapes

Add synthetic tests to `api/tests/test_cas_preflight.py` for explicit TDS switch-out acceptance, ordinary signed redemption acceptance, TDS wording on an inflow remaining source-based, and an excessive withholding residual failing with `accounting_mismatch`.

Expected outcome: the original semantic error is reproducible in tests and safety counterexamples remain rejected.

Acceptance criteria: tests contain no real document values or identifiers and assert both canonical fields and terminal preflight behavior.

### Milestone 3: Validate and review

Run the focused Python suite, the complete Python API suite, focused shared TypeScript contract tests, full Jest, typecheck, zero-warning lint, and diff/privacy checks. Then run one read-only local proof with the supplied statement and retain only provider/count buckets and the terminal accepted-or-safe-reason result.

Expected outcome: automated checks and the private field proof pass without any deployment or mutation.

Acceptance criteria: every command exits zero, the local proof reports zero rejected rows, no private artifact is created, and the base-to-head diff contains only synthetic evidence.

### Milestone 4: Frozen-head review and dev field proof

Open a C11 correctness-hotfix PR and require Claude convergence on the exact full SHA, all required implementation checks, and no actionable Claude-owned reviewer thread before merge. On 2026-10-01 the owner explicitly removed Codex review from this and subsequent CAS program rounds. The existing mechanical Dual-review convergence check will therefore remain red and requires a recorded owner-authorized administrative override; no Codex convergence marker may be fabricated. After merge, deploy only the authorized dev surface and let the owner retry the manual upload. Record only privacy-safe aggregate outcome evidence.

Expected outcome: the reviewed fix reaches dev and the direct-upload path completes or returns an allowlisted safe failure without leaking statement data.

Acceptance criteria: exact-SHA Claude convergence precedes merge, the owner-only review-policy override is recorded, production is untouched, and the dev observation contains no document, password, filename, identifier, row, or exact personal value.

## Validation

Run from the repository root:

    python -m pytest api/tests/test_cas_preflight.py -q
    python -m pytest api/tests -q
    npm test -- --runInBand supabase/functions/_shared/__tests__/cas-import-contract.test.ts
    npm test -- --runInBand
    npm run typecheck
    npm run lint
    git diff --check

Expected: all commands exit zero. The focused Python tests prove the standard adapter emits positive gross cash, preserves signed source fields, and applies net-withholding only when explicit narration, independent gross, and a matching reported tax are all present. The TypeScript contract test proves the same corroboration and anomaly ceiling remain aligned at the shared-domain boundary.

Review the diff for any literal password, document name, holder data, PAN, folio, account identifier, private path, raw parser response, extracted row, or exact personal financial value. None may be present.

## Risks And Mitigations

- Explicit tax wording could be too broad. Narration is only a permission signal; the reported amount must be structured or explicitly currency-valued and must reconcile to the residual in both preflights.
- Signed outflows could lose direction evidence. The helper retains the original signs in `source_amount` and `source_units`; only gross is a positive magnitude.
- A suspicious residual could be accepted as withholding. Both preflights require Price multiplied by Units to match gross, the reported tax to match the residual, and withholding to remain below the existing anomaly ceiling.
- Standard-provider behavior could drift from depository behavior. The matcher and accounting semantics mirror the reviewed depository boundary, and the common preflight enforces the same canonical contract.
- Private evidence could leak into review. All committed fixtures are synthetic, local proof emits only buckets and safe status, and the final diff receives a privacy scan.

## Decision Log

- 2026-09-30: Name the correctness interrupt C11 because C9 was transferred to the separate NAV program and C10 covered manual password access.
- 2026-09-30: Fix the provider adapter rather than preflight because the adapter was assigning a signed source value to a positive gross field.
- 2026-09-30: Reuse the exact explicit-withholding vocabulary and anomaly model already reviewed for depository statements.
- 2026-09-30: Keep production deployment outside this milestone.
- 2026-09-30: Focused validation passed 76 Python tests and 88 shared-contract tests. Full validation passed 401 Python tests plus 3 subtests, 123 Jest suites / 2,405 tests, typecheck, zero-warning lint, syntax, and diff checks. The read-only private proof passed the complete KFintech preflight with zero rejected rows using bucketed output only.
- 2026-10-01: Accept Claude round-one P1 and P2. Centralize the net-withholding gate, reject negated narration, require a positive residual beyond tolerance, and add standard plus depository counterexamples in one correction.
- 2026-10-01: The owner explicitly ended Codex review for this and subsequent CAS program rounds. Claude is the sole independent reviewer; the legacy Dual-review convergence check is an acknowledged administrative override rather than a gate to satisfy artificially.
- 2026-10-01: Correction validation passed 263 focused Python tests, 417 complete API Python tests plus 3 subtests, 88 shared-contract tests, 123 Jest suites / 2,405 tests, typecheck, zero-warning lint, syntax, and diff checks. The read-only private proof still passed complete KFintech preflight with zero rejected rows using bucketed output only.
- 2026-10-03: Accept Claude round-two P1. Narration is no longer sufficient to select the wider equation. Require a positive reported tax amount, reconcile it to gross minus source cash in the shared classifier and both preflights, reject bare or zero/negated wording, and retain the existing anomaly ceiling as a secondary guard.
- 2026-10-03: Round-two correction validation passed 284 focused Python tests, 438 complete API Python tests plus 3 subtests, 90 focused shared-contract tests, 123 Jest suites / 2,407 tests, typecheck, zero-warning lint, syntax, and diff checks. One unrelated timing-sensitive repair-transport assertion passed its exact rerun and the subsequent complete Jest run. No new PostHog event is needed because the existing privacy-safe preflight outcome and reason telemetry already covers this fail-closed boundary without adding identifiers or financial values.
- 2026-10-03: Do not substitute the earlier private proof for the strengthened corroboration rule. The final owner-supplied statement proof remains a post-merge dev direct-upload task so it exercises the exact reviewed and deployed revision; until then, only synthetic aggregate evidence is claimed.

## Progress

- [x] Reproduce the failure locally with privacy-safe output.
- [x] Prove the proposed transformation against the unchanged preflight in memory.
- [x] Implement standard-provider gross and cash-basis normalization.
- [x] Add synthetic accepted and fail-closed regression tests.
- [x] Update the CAS upload architecture documentation.
- [x] Complete focused and full validation.
- [x] Complete the privacy-safe local statement proof.
- [x] Open the C11 PR for frozen-head review.
- [x] Receive and triage Claude round-one review.
- [x] Implement one batched correction for all accepted round-one findings.
- [x] Complete correction validation.
- [x] Push the single correction and open exact-SHA Claude re-review.
- [x] Receive and triage Claude round-two review.
- [x] Implement the round-two corroboration correction in both parser and preflight families.
- [x] Complete round-two correction validation and final privacy scan.
- [ ] Push the round-two correction and open exact-SHA Claude re-review.
- [ ] Complete exact-SHA Claude convergence before merge.
- [ ] Merge, deploy to dev only, and complete the privacy-safe direct-upload field proof.
