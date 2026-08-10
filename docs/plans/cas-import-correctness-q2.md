# Q2 Header-Aware Depository CAS Parsing

## Goal

Make CDSL and NSDL transaction extraction depend on each table's normalized headers rather than fixed numeric positions, while preserving the Q1 fail-closed contract and correcting adjacent folio, category, password-help, and diagnostic assumptions.

## User Value

A user can import a detailed CDSL or NSDL CAS without FolioLens mistaking Stamp Duty, NAV, Price, or Units for one another. Missing or ambiguous layouts fail with an actionable, privacy-safe error instead of producing plausible but wrong portfolio data.

## Context

Q1 merged in PR #292 at `f7a54d647f29bdf38e74341156c5dc91d39ef3a6`. It rejects financially incoherent parser output before domain writes. The current adapter in `api/_cdsl_nsdl_parser.py` still assumes CDSL's numeric order (`Amount, NAV, Price, Units, Stamp Duty`) even though the observed NSDL order is (`Amount, Stamp Duty, NAV, Price, Units`). It also detects issuer from the first page only, parses folios with a permissive expression, and presents PAN plus date of birth as a universal depository password requirement.

This plan implements only Q2 from control PR #291. Q3 owns economic reconciliation, Q4 owns shared catalog authority and write recovery, and Q5 owns approved dev repair and field proof.

## Assumptions

- The branch starts from current `origin/main` at the Q1 merge.
- The accepted research branch is read-only input and will not be merged or cherry-picked.
- Observed private PDFs may be used only for transient aggregate proof; no filename, folio, identifier, date, amount, raw text, or fixture derived from them may be committed or logged.
- No deployment or persistent data mutation is part of Q2.
- Existing Q1 canonical transaction and preflight contracts remain authoritative.

## Scope

- Normalize per-table header cells and map required financial fields by aliases.
- Support observed CDSL and NSDL column orders, repeated headers, blank rows, page breaks, and optional trailing columns.
- Reject missing, duplicate, or ambiguous required headers with a typed `unsupported_layout` HTTP 422 path.
- Treat issuer text as a deterministic diagnostic; use the parsed table schema as extraction authority and use the same multi-page diagnostic input at router and parser boundaries.
- Parse valid colon, hyphen, Unicode-dash, and missing folios; normalize absence to `null`; reject placeholder values through Q1 preflight.
- Order AMFI category matches from specific to generic.
- Preserve the existing password attempt order: custom override exclusively when supplied, otherwise PAN first and PAN plus DOB only as an optional second attempt.
- Update onboarding/help copy so DOB is suggested only after the first password attempt fails when the profile lacks DOB.
- Remove raw filename and response-body diagnostics from client upload logs.
- Update current CAS architecture and discovery documentation.

## Out Of Scope

- Fuzzy or economic deduplication, split/combined-row matching, reversal redesign, or transaction backfill.
- Changing shared `scheme_master` ownership or repairing category/catalog data.
- Dev or production deployment, private-account mutation, or production rollout.
- Cache key, payload, lifetime, invalidation, persistence, or restore changes.

## Approach

Introduce a small header-schema layer in the depository parser. Each candidate header row is normalized, aliases are resolved to canonical fields, duplicate canonical fields are rejected, and a valid schema must include Date, Description, Amount, Units, and at least one of Price or NAV. Transaction rows are then read only through that schema. Stamp Duty and optional trailing charge columns default safely when absent. Repeated headers refresh the active table map. A leading page-header table may bind sibling transaction tables on that page, while a scheme-local header cannot cross into a new scheme table. A dated row without an established schema fails closed.

The parser will collect the observed depository layout while extracting. Full issuer phrases and acronyms across the first three pages remain useful diagnostics, but token ordering will never choose financial column positions. The top-level router will pass the same diagnostic text into the adapter so page-two/page-three markers cannot make routing and parser diagnostics disagree.

Add `unsupported_layout` to the shared safe failure vocabulary and surface a generic user message. Keep the existing Edge Function password headers unchanged. In the upload screen, explain PAN-first behavior and reveal the DOB fallback callout only after a password rejection when DOB is absent. Client logs retain only low-cardinality platform/status/bucket diagnostics.

## Milestones

### 1. Header schema and parser fixtures

Add synthetic CDSL and NSDL positive fixtures plus repeated-header, page-break, optional-column, missing-header, and ambiguous-header cases. Replace positional extraction with canonical field lookups and typed unsupported-layout failures.

Acceptance: CDSL behavior is unchanged, NSDL produces the correct canonical row, and malformed schemas fail without parser success.

### 2. Diagnostics, folios, categories, and password behavior

Make multi-page issuer diagnostics consistent, harden folio parsing and placeholder tests, reorder category matching, preserve PAN-first/PAN+DOB-second/custom-exclusive behavior, and correct UI/help copy.

Acceptance: router and parser agree when the marker is on page two or three; folio variants normalize correctly; category headers choose the most specific mapping; missing DOB is not presented as a universal blocker.

### 3. Privacy and documentation

Remove raw client filename/body logging and update `docs/TECH-DISCOVERY.md`, `docs/architecture/cas-upload-flow.md`, and `docs/architecture/cas-inbound-flow.md`.

Acceptance: no application telemetry or diagnostic log contains statement-derived private data, and current docs describe header authority and password fallback accurately.

### 4. Exact-head validation and review handoff

Run all Python and Jest tests, typecheck, lint, diff checks, and any available Deno checks. Run the private supplied-file proof transiently and record aggregate outcomes only. Open the implementation PR, attach exact-head evidence, label it `program-milestone` and `needs-review`, and freeze the SHA for dual review.

Acceptance: synthetic suites are green; private aggregate proof is CDSL 5/5 and NSDL 16/16 at the exact head; no deployment occurred; cache statement is `[cache-shape-stable]`.

## Validation

    PYTHONPATH=. python -m pytest api/tests -q
    npm test -- --runInBand
    npm run typecheck
    npm run lint
    git diff --check

Focused tests will additionally exercise the parser route's typed 422 response, both password attempts, the custom override path, and upload-screen copy state. The private supplied-file run is transient and reports only provider totals and pass/fail counts.

## Risks And Mitigations

- **Valid layout rejected.** Use normalized aliases and optional trailing columns, but require a minimal unambiguous financial schema and fail closed for unknown variants.
- **Issuer wording changes.** Treat issuer detection as diagnostics only; extraction follows headers.
- **Page continuation loses schema.** Carry the last validated schema across page boundaries and refresh it on repeated headers.
- **Privacy leak in troubleshooting.** Log only allowlisted reason codes and bucketed dimensions; never print cells, filenames, parser bodies, or financial values.
- **Q2 expands into reconciliation or catalog repair.** Preserve Q1 canonical behavior and defer economic grouping, shared writes, and repair to Q3-Q5.

## Decision Log

- 2026-08-09: Require Date, Description, Amount, Units, and at least one of Price or NAV; Stamp Duty and trailing charge columns are optional and default to zero.
- 2026-08-09: A date-like row without a validated active header is an unsupported layout, not a positional fallback opportunity.
- 2026-08-09: Table schema is financial extraction authority. Issuer text is a source-dialect diagnostic and routing hint only.
- 2026-08-09: Q2 changes no cache surface; the React Query persistence buster remains unchanged.

## Progress

- [x] Read product intent, program protocol, accepted Q2 research sections, and current control state.
- [x] Merge Q1 after exact-SHA Codex and Claude convergence and start Q2 from current main.
- [x] Inspect current parser, password path, UI copy, safe failure contract, telemetry, and architecture docs.
- [x] Implement header-aware extraction and typed unsupported-layout failures.
- [x] Implement diagnostic, folio, category, password-copy, and privacy corrections.
- [x] Update current documentation.
- [x] Run focused and full validation.
- [x] Run transient supplied-file aggregate proof.
- [x] Open draft implementation PR #293.
- [x] Freeze `da73b323b06431a5a9c1bf5dd5c8be159c78e7e9` and complete exact-SHA dual review round 1.
- [x] Address all six round-1 findings in one batch and rerun full validation plus transient proof.
- [x] Freeze `ee7b3e8e1e68a2511e883de3f86e1d6c86ab975f` and complete exact-SHA dual review round 2.
- [x] End round 2 and batch its three fail-open findings: merged/split folio cells and truncated transaction rows.
- [x] Freeze `a3558b4ebb04c1c84adbf529c7276fad15d8de2f` and complete exact-SHA dual review round 3.
- [x] End round 3 and address its shared adjacent-cell folio/header discriminator finding.
- [x] Freeze `af173c31d89c9b7cd66e6ea2d461604690790415` and complete exact-SHA dual review round 4.
- [x] End round 4 and address its shared delimiter-terminated split-cell regression.
- [x] Freeze `dacba08aee56d8ba27737ab2f710e6e187e90e18` and complete exact-SHA dual review round 5.
- [x] End round 5 and address its shared three-cell delimiter-split folio finding.
- [x] Freeze `ee3aef5512c4ce37f39a3e25cd8e088af8a8f97b` and complete exact-SHA dual review round 6.
- [x] End round 6 and address the scan-ahead folio invention finding.
- [x] Freeze `7cec07e179739c51e3839ad08b4bdeb6f25c7e5b` and complete exact-SHA dual review round 7.
- [x] End round 7 and reject ISIN-shaped inline and adjacent folio values.
- [x] Freeze `52488a69f8afab604ef5d9a4398b47f1f83213b5` and complete exact-SHA dual review round 8.
- [x] End round 8 and unify inline, delimited-adjacent, and bare-adjacent folio predicates.
- [x] Freeze `53fbce267ebe1ce90067f4cc93333f598e41dc1e` and complete exact-SHA dual review round 9.
- [x] End round 9 and remove slash punctuation as independent folio identity evidence.
- [x] Freeze `ec7005dd64baef7bcdd614b2c118482301f1e0a2` and complete exact-SHA dual review round 10.
- [x] End round 10 and reject normalized date-like folio values across all shapes.
- [x] Freeze `017b2dcb66c539357fc07885e023166f00a1d08f` and complete exact-SHA dual review round 11.
- [x] End round 11 and add parser-supported year-first numeric dates to the folio guard.
- [x] Prepare the next exact validated head for dual re-review.

## Amendments

- **Explicit NSDL net-of-tax switch-outs remain fail-closed.** Review showed
  that deriving a charge from the unexplained Price-times-Units versus Amount
  residual makes the Q1 equation self-fulfilling. Q2 therefore records only
  charges present in mapped statement columns. Rows that need a gross/net cash
  model remain `accounting_mismatch` until Q3 implements that reconciliation.
- **Private supplied-file proof completed transiently.** Runtime-supplied
  credentials and in-memory parsing produced CDSL 5/5 and NSDL 16/16 with the
  correct dialects. Q1 remains intentionally fail-closed for rows that require
  Q3 gross/net modeling. Only aggregate extraction outcomes are recorded.
  Temporary page renders and the temporary public AMFI map were deleted; no
  private artifact, credential, filename, or statement content was copied into
  the repository, logs, fixtures, commits, or PR text.
- **Multiple folios sharing one scheme ISIN remain deferred.** Round-2 review
  observed that the pre-existing scheme map is keyed by ISIN. Q2 does not change
  that ownership model; Q3/Q4 will decide the reconciliation and persistence
  contract before altering it.
- **Split-cell folios use structural discrimination.** Round-3 review showed
  that a vocabulary allowlist could both invent a folio from an unfamiliar
  single-word header and reject an otherwise valid summary table. Adjacent-cell
  recovery is therefore limited to a bare label/value pair whose value carries
  folio-like identity, while unknown multi-column summary headers are ignored.
  A delimiter attached to an otherwise empty label may use the same bounded
  recovery when the immediate following non-empty cell is folio-like, even if
  trailing extracted field cells remain. It may not scan past a non-folio cell;
  all paths share one value predicate that rejects dates, bare words, and every
  value containing a parser-recognized ISIN. A candidate must contain a digit
  unless it is an exact sentinel that Q1 rejects; slash punctuation alone is
  never identity evidence. Date-like values are rejected after allowing
  day-first or parser-supported year-first order, single-digit components,
  textual months, alternate separators, and trailing folio punctuation. Lone
  labels and invalid explicit labels still fail closed.

## Validation Evidence

- 2026-08-10: `PYTHONPATH=. .venv/bin/python -m pytest api/tests -q` passed
  348 tests plus 3 subtests.
- 2026-08-10: `npm test -- --coverage --ci --runInBand` passed 105 suites
  and 2,135 tests with the coverage gate satisfied.
- 2026-08-10: `npm run typecheck`, `npm run lint`, and `git diff --check`
  passed.
- 2026-08-09: No Edge Function, Vercel function, database migration, dev data,
  or production surface was deployed or mutated.
- 2026-08-10: Transient supplied-file extraction selected CDSL 5/5 and NSDL
  16/16 with the correct dialects. CDSL passed Q1 preflight; NSDL intentionally
  stopped at `accounting_mismatch` for rows that require Q3 gross/net cash
  modeling. The helper and temporary public AMFI map were deleted immediately.
- Cache statement: `[cache-shape-stable]`; no cache key, payload, lifetime,
  invalidation, persistence, restore, or sign-out behavior changed.
