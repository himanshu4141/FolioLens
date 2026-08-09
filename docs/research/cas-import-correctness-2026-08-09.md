# FolioLens CDSL/NSDL CAS Import Correctness Research (2026-08-09)

**Reported symptom:** “I imported my July NSDL CAS in dev after all transactions
through July were already present. I expected no change, but the portfolio suddenly
showed a lot of growth. Compare dev with production, find any other bugs exposed by
the import, and make sure the eventual fix works for both NSDL- and CDSL-issued CAS.”

**Conclusion:** this is a confirmed ingestion correctness failure, not market growth,
a stale chart, or a display-only cache problem. The depository parser applies one
CDSL-style positional column map to both issuers. That map is valid for the supplied
CDSL layout but wrong for the supplied NSDL layout, where Stamp Duty precedes NAV,
Price, and Units. The NSDL import therefore persisted NAV/units from the wrong columns.
The importer had no financial invariant gate to stop those rows, exact row-level
deduplication could not recognize provider-specific split/combined representations,
and the import reported success after writing the corrupt rows. The same import path
also wrote CAS-derived names, categories, and benchmark defaults into the shared
scheme catalog.

This report is the research and control-plane specification for a sequential agent
program. It contains no application code changes and no private CAS fixture, password,
PAN, holder name, email, folio, raw payload, user ID, fund ID, or transaction ID.

---

## Baseline and scope

| | |
|---|---|
| Repository | `FolioLens` |
| Commit analysed | `5bfd33a972084793980f5428bd348b88aaac182b` |
| Commit date | 2026-07-25 |
| Analysis date | 2026-08-09 |
| Primary surfaces | Vercel Python CAS dispatch/parser; Supabase `parse-cas-pdf`; shared CAS importer; transaction uniqueness/reconciliation; shared `scheme_master`; upload password/help copy; web/native freshness after server imports |
| Real-format evidence | One supplied NSDL detailed CAS and one supplied CDSL transaction CAS, inspected transiently outside the repository; only aggregate and structural evidence is recorded here |
| Environment evidence | Read-only comparison of signed-in production and dev UI; read-only aggregate SQL against the dev Supabase project; prior parser invocation logs; no DB writes or cleanup |
| Static checks | `111` Python tests + `3` subtests passed; `101` Jest suites / `2,049` tests passed; `npm run typecheck` passed; `npm run lint` passed; positive CDSL and negative NSDL parser diagnostics; `git diff --check` before commit |
| Out of scope for research PR | Parser changes, migrations, data cleanup, deployments, production writes, and any committed copy or derivative containing personal data |

### Privacy boundary

The supplied PDFs are diagnostic sources, not repository fixtures. Passwords were used
only in a transient process environment and were removed after inspection. Rendered
pages and temporary inspection scripts were deleted. Implementation tests must use
synthetic, non-identifying table fixtures that preserve only column/header geometry,
transaction-type shapes, and accounting relationships.

### Evidence standard

- **Confirmed** — directly reproduced from the supplied statements, current code,
  signed-in UI, or sanitized aggregate database queries.
- **Strong** — the current code establishes a complete causal path, but historical
  before/after state or broader statement coverage is unavailable.
- **Candidate** — credible risk that must be measured or challenged during the named
  milestone; it is not presented as an established cause.

Development UI and one-off parser runs are used for correctness, not performance or
release-channel timing claims.

---

## Sanitized reproduction evidence

### UI comparison

| Metric | Sanitized comparison | Interpretation |
|---|---:|---|
| Portfolio value | Dev is about **2.1×** production | The dev value nearly doubled after the import |
| Overall gain | Dev is about **3.9×** production | The apparent gain is driven by phantom units |
| XIRR | Dev is about **22.6 percentage points** above production | A downstream consequence of incorrect transactions |
| Transaction count | Dev is 17 rows above production; the latest import owns 16 of them | One pre-existing environment row also differs; repair targets only the 16 import-owned rows |

The dev chart jumps discontinuously at the import boundary while invested amount moves
only modestly. That shape is consistent with units being inflated while cash amounts
remain near their real values.

### Issuer-layout comparison

| Source | Observed transaction columns after description | Current parser assumption | Result |
|---|---|---|---|
| Supplied CDSL | `Amount, NAV, Price, Units, Stamp Duty, …` | `Amount, NAV, Price, Units, Stamp Duty, …` | 5/5 extracted positive-value rows passed `amount ≈ NAV × units`; real folios were recovered |
| Supplied NSDL | `Amount, Stamp Duty, NAV, Price, Units` | `Amount, NAV, Price, Units, Stamp Duty, …` | 16 rows extracted with shifted NAV/units; the local parser diagnostic rejected every row as inconsistent with the visible header geometry |

The fix cannot be a global index shift: that would repair the supplied NSDL statement
and break the supplied CDSL statement.

### Dev database aggregates for the latest import

The queries intentionally returned aggregates only:

- the import is recorded as `success`, with 13 fund updates and 16 transaction rows;
- all 16 persisted rows have literal folio value `No`;
- 12 persisted rows fail a positive-value accounting check using
  `abs(amount - NAV × units) > max(₹1, 0.2% of amount)`; the other rows are not evidence
  of correctness because the malformed mapping can leave a required term non-positive;
- parsed `NAV × units` is only about **2.4%** of the rows' cash amount, an impossible
  relationship for these purchases/switches;
- the 16 rows collapse into 12 `(fund, date, transaction type)` economic groups;
- all 12 groups have older rows with the same fund/date/type and cash amount within
  ₹1, while zero groups have matching units within 0.001;
- zero groups lack an older same-day/type match. For this dev state, the correct
  re-import result is therefore **0 new transactions**;
- the import touched 11 distinct shared schemes. Three are currently categorized
  `Other`, and one other dev user holds at least one of the touched schemes.

These facts explain both the sudden portfolio jump and why the existing uniqueness
constraint failed: cash identity survived, but the parser-produced units changed the
row key.

---

## Executive summary

| Order | Finding | Severity | Confidence | Explains |
|---:|---|---|---|---|
| 1 | One CDSL positional map is applied to structurally different NSDL tables | **P0** | Confirmed | Phantom units, doubled portfolio value, inflated gain/XIRR |
| 2 | No pre-write financial/structural validation gate; malformed rows can still produce a successful import | **P0** | Confirmed | Corrupt rows reached Postgres and the user saw “Import complete” |
| 3 | Exact row-key dedupe cannot reconcile split/combined rows or stamp-duty normalization across CAS providers | **P0** | Confirmed | A historical re-import added 16 rows instead of zero |
| 4 | CAS import overwrites the shared scheme catalog with lower-authority metadata | **P1** | Confirmed path; Strong observed harm | Category/benchmark/name changes can affect other users |
| 5 | Issuer, folio, category, and password assumptions are brittle | **P1** | Confirmed | Literal `No` folios, misclassification, inaccurate DOB guidance |
| 6 | Tests and telemetry prove helpers, not real extraction/accounting invariants | **P1** | Confirmed | The regression shipped without a positive NSDL/CDSL table contract |
| 7 | Partial-write behavior and unconditional `is_active=true` can leave additional inconsistent state after later failures | **P1** | Candidate | Potential secondary damage beyond the 16 transactions |

---

## 1. The shared positional parser misreads NSDL rows — P0

**Status: Confirmed. Primary root cause.**

### Evidence

- `api/_cdsl_nsdl_parser.py:441-450` documents and hard-codes the numeric sequence
  as amount, NAV, price, units, stamp duty for every depository statement.
- The supplied CDSL statement uses that sequence, and the current parser produced five
  positive-value purchase rows with zero accounting-invariant failures.
- The supplied NSDL statement places Stamp Duty between Amount and NAV. The same code
  therefore reads stamp duty as NAV and NAV/price as units.
- A representative NSDL row visibly has a normal cash amount, a small stamp duty,
  equal NAV and Price, and small units. The imported row instead has NAV equal to the
  stamp-duty-sized value and units equal to the NAV-sized value.
- `api/_cdsl_nsdl_parser.py:130-141` chooses CDSL whenever both acronyms occur in the
  first 3,000 characters. Consolidated statements legitimately mention both
  depositories, so token presence is not a reliable dialect schema.
- `api/_cas_parser.py:90-99` expands detection to the first three pages because some
  statements have an unmarked cover page, but the inner parser re-detects page one only
  at `api/_cdsl_nsdl_parser.py:500-509`. A valid statement whose issuer marker first
  appears on page two or three therefore routes to the depository parser and then hard-
  fails with a misleading “not CDSL or NSDL” error; this is not merely diagnostic drift.

### Required fix

1. Parse table headers into a normalized column map per table or scheme block. Do not
   use document-wide fixed numeric indexes.
2. Define explicit CDSL and NSDL header aliases for Date, Description, Amount, Stamp
   Duty, NAV, Price, Units, and optional trailing tax/distribution columns.
3. Require the minimum financial columns for a transaction table. Unknown or ambiguous
   layouts must fail closed with a useful 422 error before import.
4. Keep issuer detection for diagnostics and password/help behavior, but make extraction
   depend on the observed table schema rather than acronym order.
5. Add synthetic positive fixtures for both observed column orders, including repeated
   headers, page breaks, blank cells, and merged folio/ISIN rows.

### Acceptance criteria

- A synthetic CDSL row with the observed CDSL headers parses the expected amount, NAV,
  units, stamp duty, type, date, ISIN, and folio.
- A synthetic NSDL row with the observed NSDL headers parses the expected fields without
  changing the CDSL result.
- Swapping/removing required headers makes parsing return a typed unsupported-layout
  failure; it never silently falls back to positional values.
- Synthetic cover-page fixtures whose issuer marker first appears on page two and on the
  page-three scan boundary both parse successfully, and router/parser diagnostics agree.
- Every applicable positive-value row satisfies its documented transaction-type equation,
  using transaction Price when present and NAV only under an explicit fallback, with
  tolerances that account for rounding, stamp duty, taxes, and exit loads.
- Transient validation of both supplied private PDFs at the exact preview SHA reports:
  CDSL 5/5 checked rows valid; NSDL 16/16 checked rows valid; no private values are
  copied into CI output or the repository.

---

## 2. The import path has no fail-closed pre-write contract — P0

**Status: Confirmed. The root cause became user-visible because this guard is absent.**

### Evidence

- `supabase/functions/parse-cas-pdf/index.ts:264-301` rejects only “no folios” and
  “no transactions.” Any non-empty transaction list proceeds to database mutation.
- `supabase/functions/_shared/import-cas.ts:261-298` filters unknown types, non-positive
  units, and zero amounts, but never checks NAV positivity, cash/unit/NAV consistency,
  date validity after normalization, placeholder folios, or closing-balance
  reconciliation.
- `supabase/functions/parse-cas-pdf/index.ts:303-366` records success whenever any fund
  was updated, even if rows are malformed or some scheme writes failed.
- The latest dev audit row is `success` despite the impossible aggregate relationship
  and 16 placeholder folios.
- The implementation already contains a narrow historical phantom-row guard and tests
  at `supabase/functions/_shared/__tests__/import-cas.test.ts:666-754`; the current
  incident demonstrates why zero amount alone is not an adequate safety invariant.

### Required fix

1. Introduce a pure canonicalization and validation stage that runs across the complete
   parsed payload before the first `scheme_master`, `user_fund`, or transaction write.
2. Represent gross cash amount explicitly. Preserve source amount and stamp duty in the
   parser boundary long enough to validate and reconcile them; do not discard the charge
   column before identity is computed.
3. Validate dates, types, ISIN/scheme mapping, real folios when present, amount, units,
   NAV, signed direction semantics, accounting tolerances, and optional opening/closing
   unit reconciliation.
4. Return a typed, privacy-safe failure reason and mark the audit row failed with zero
   financial/domain writes; only the allowlisted audit transition is permitted. Replace
   raw log/error interpolation with allowlisted reason codes and bucketed counts; do not
   log or persist raw descriptions, filenames, identifiers, dates, amounts, units, folios,
   parser payloads, or upstream error bodies.
5. Keep a TypeScript defense-in-depth validator at the importer boundary even if Python
   already validated the parser output.
6. Preserve both statement NAV and transaction Price. Define type/direction-specific
   accounting equations for purchases, redemptions, switches, dividends, stamp duty,
   taxes, exit loads, and rounding; do not assume Price always equals NAV.

### Acceptance criteria

- Injecting the exact NSDL column-shift shape returns 422, records a failed audit, and
  leaves `scheme_master`, `user_fund`, and `transaction` unchanged.
- A mixed payload containing one valid scheme and one corrupt scheme writes neither;
  partial parser acceptance is forbidden.
- Canonical CDSL/NSDL payload fixtures pass both Python and TypeScript validation. Until
  Q2 fixes extraction, the known NSDL table-layout fixture must fail closed end to end.
- CAMS, KFintech, and MFCentral golden/garbage fixtures still pass or fail according to
  their existing contracts through both direct upload and inbound-email callers,
  including audit status and notification behavior.
- Garbage-in fixtures cover missing headers, zero/negative required values, impossible
  amount/NAV/units relationships, placeholder folios, malformed dates, duplicated page
  headers, and truncated tables.
- Success telemetry contains only issuer/dialect, status, bucketed row counts, validation
  reason codes, platform/release dimensions, and duration; it contains no financial
  amount or personal identifier.

---

## 3. Row-level uniqueness is not provider-neutral idempotency — P0

**Status: Confirmed. Secondary root cause of the 16 inserted duplicates.**

### Evidence

- `supabase/functions/_shared/import-cas.ts:312-324` relies on
  `(fund_id, transaction_date, transaction_type, units, amount)` plus
  `ignoreDuplicates` as the additive merge guarantee.
- The supplied NSDL statement can split one economic switch/purchase across multiple
  lines while an existing source stores the same event as one combined row.
- Stamp duty is a separate CDSL/NSDL column. Existing sources may store gross cash while
  the current parser stores the pre-stamp amount.
- Sanitized dev SQL found 12 incoming economic groups; all 12 matched older groups on
  fund/date/type and cash amount within ₹1, but none matched units because of the parser
  defect. Exact row identity therefore missed every group.
- Even after column extraction is corrected, split/combined row shapes and gross/net
  cash conventions can still evade the current unique key.
- `supabase/functions/_shared/import-cas.ts:246-256` has a more destructive cash-only
  reversal path: it deletes every same-fund/date purchase with the reversal amount,
  without units, folio, source/import provenance, or a one-row limit. An ambiguous
  reversal can therefore remove unrelated prior or manual transactions.
- The current unique key also collapses two genuine same-day, same-type transactions
  with identical units and amount. Row multiplicity within one statement is evidence of
  two events; the same multiplicity arriving from a later overlapping statement is not.

### Required fix

1. Define a provider-neutral **economic group** contract, initially keyed by user fund,
   transaction date, normalized type/direction, and a documented folio policy.
2. Normalize cash to a gross amount that includes stamp duty where the statement exposes
   it. Keep the source row count and provider/dialect only as non-authoritative provenance.
3. Reconcile incoming and existing groups many-to-many using both aggregate cash and
   aggregate units within explicit tolerances. Never dedupe on cash alone.
4. Specify behavior for exact equality, provider split/combined equality, true superset,
   partial overlap, same-day independent transactions, reversals, switches, dividends,
   and ambiguous conflicts. Ambiguity must be reported, not guessed.
5. Bring reversal handling under the same unit-and-cash economic identity. Remove the
   unscoped cash-only delete; an ambiguous reversal must fail closed as a conflict.
6. Preserve within-statement multiplicity for genuinely identical events while using
   statement/import overlap and provenance to make later re-imports idempotent.
7. Decide through an ADR/test-backed implementation whether canonical groups replace
   provider rows, coexist via an event identity, or remain row-based with a reconciliation
   record. Do not add a fuzzy unique index without proving collision behavior.

### Acceptance criteria

- Re-importing a byte-identical source adds zero rows.
- Importing an NSDL split representation over an existing combined representation adds
  zero rows when aggregate gross cash and units agree.
- Importing a CDSL/CAMS row whose amount differs only by separately reported stamp duty
  adds zero rows after gross normalization.
- Two genuine same-day same-type purchases with different economic totals both remain.
- Two identical same-day rows in one statement remain two economic events, while a later
  re-import of that statement adds zero; provenance/multiplicity tests make the distinction
  explicit rather than relying on the current unique key.
- A reversal with one unit-and-cash match removes/excludes only that economic event. A
  same-day cash-only match spanning multiple purchases produces a conflict and never a
  multi-row delete.
- A partial-overlap or cash-match/unit-mismatch fixture fails closed with a conflict; it
  does not silently insert or delete.
- Against a sanitized synthetic/isolated snapshot of the observed dev group shapes, the
  NSDL fixture produces 12 matched economic groups, 0 conflicts, and 0 inserted
  transactions. Live repaired-account proof is reserved for Q5.

---

## 4. CAS import can clobber the shared scheme catalog — P1

**Status: Confirmed write path; Strong evidence of current collateral impact.**

### Evidence

- Current architecture assigns `scheme_master` authority to OpenFolio/mfdata sync, as
  documented in `docs/TECH-DISCOVERY.md` under “Scheme metadata.”
- `supabase/functions/_shared/import-cas.ts:189-204` nevertheless upserts CAS/AMFI-derived
  `scheme_name`, broad `scheme_category`, and benchmark fields on every user import.
- Those rows are shared by all users. The latest dev import touched 11 distinct schemes,
  and at least one other user holds a touched scheme.
- Three touched schemes currently have broad category `Other`.
- `_CATEGORY_MAP` in `api/_cdsl_nsdl_parser.py:43-52` tests `other` before
  `index fund`, so an AMFI section such as “Other Scheme - Index Funds” resolves to
  `Other` before the more specific category can match.
- No historical snapshot proves which exact shared fields changed during this import;
  that part of observed harm remains Strong rather than Confirmed.

### Required fix

1. Remove shared metadata ownership from `importCASData`. CAS may resolve an existing
   scheme by trusted ISIN/AMFI code and create/activate a user-owned holding; it must not
   downgrade populated catalog fields.
2. For a genuinely absent scheme, write only the minimum identity needed for referential
   integrity, with explicit source/provenance, then invoke the authoritative metadata
   hydration path.
3. Fix category specificity ordering and test all AMFI section headers independently of
   import behavior.
4. Add a before/after digest test proving a user import cannot alter existing shared
   catalog fields.
5. Rehydrate the affected dev schemes from authoritative sources after the unsafe writer
   is removed; record aggregate before/after results without names or user identifiers.

### Acceptance criteria

- Importing a CAS for an existing scheme changes zero `scheme_master` fields.
- Missing-identity behavior is explicit, minimal, source-stamped, and followed by
  authoritative hydration; no fallback benchmark is presented as source truth.
- “Other Scheme - Index Funds” maps to Equity, while true “Other” and fund-of-fund
  sections retain their intended categories.
- A test with two users holding the same scheme proves one user's import cannot change
  the other user's displayed name, category, or benchmark.
- After dev repair, all 11 touched schemes are rehydrated or explicitly reported as
  unresolved; the three current `Other` rows are reviewed against authoritative data.

---

## 5. Issuer, folio, and password assumptions are brittle — P1

**Status: Confirmed. Some are correctness defects; some are inaccurate guidance.**

### Evidence

- `detect_cdsl_nsdl()` returns CDSL first when both acronyms occur
  (`api/_cdsl_nsdl_parser.py:130-141`). Both supplied consolidated statements contain
  references to both depositories in legitimate sections.
- `_FOLIO_RE` at `api/_cdsl_nsdl_parser.py:284-289` accepts optional “No” followed by
  whitespace/colon. On the supplied NSDL form `Folio No - …`, the engine can skip the
  optional group and capture literal `No`; all 16 imported rows show that placeholder.
- When no folio is captured, `api/_cdsl_nsdl_parser.py:470-471` groups the scheme under
  literal `CDSL`, which the shared importer can persist as a folio number.
- The supplied CDSL statement opens with the primary PAN-only password. The server already
  tries PAN first, then PAN+DOB (`api/_cas_parser.py:120-135`), so the backend can handle
  this variant.
- UI/error copy states that all CDSL/NSDL statements require PAN+DOB
  (`app/onboarding/pdf.tsx:100-108`, `app/onboarding/pdf.tsx:135-167`,
  `api/_cas_parser.py:137-143`). That statement is too absolute.
- The CDSL fixture recovered real folios; this must remain true after the NSDL fix.

### Required fix

1. Make issuer detection evidence-based and diagnostic; table-header dialect remains the
   extraction authority.
2. Parse folio labels with explicit delimiters (`:`, `-`, Unicode dash variants), require
   a value after the delimiter, and reject reserved placeholders such as `No`/issuer
   names.
3. Describe depository passwords as issuer/version-dependent: try saved PAN first and
   PAN+DOB second; keep custom password override available.
4. Do not make DOB a client-side hard prerequisite when a PAN-only CDSL/NSDL file may
   succeed. Prompt for DOB after a first password failure if it is absent.

### Acceptance criteria

- Mixed CDSL/NSDL cover-page vocabulary does not select a wrong table schema.
- `Folio No : X`, `Folio No - X`, and known dash variants return `X`. A missing folio is
  represented canonically as `null`; `Folio No` with no value is rejected, and literal
  `No`, `CDSL`, or `NSDL` is impossible as a stored folio.
- A PAN-only depository fixture reaches parsing without DOB; a PAN+DOB fixture still
  succeeds through fallback; a custom password remains exclusive as documented.
- Help/error copy describes both supported attempts without revealing saved identity data.

---

## 6. Test and observability coverage missed the unsafe boundary — P1

**Status: Confirmed.**

### Evidence

- Existing Python tests cover date parsing, type normalization, token detection, and
  holdings-only rejection, but no positive `extract_mf_folios()` transaction table for
  either issuer.
- The detection tests assert that CDSL wins when text contains both tokens, preserving
  the brittle behavior rather than exercising issuer ambiguity.
- Import tests validate zero-amount phantom filtering and mocked upserts, but not
  amount/NAV/units coherence, provider-neutral group reconciliation, zero-write preflight,
  or protection of pre-existing shared scheme metadata.
- Current success telemetry records row/fund counts but no privacy-safe validation or
  reconciliation outcome (`supabase/functions/parse-cas-pdf/index.ts:354-364`).
- The import audit's `success` status did not distinguish “parsed and reconciled,”
  “no-op duplicate,” or “accepted malformed rows.”
- `supabase/functions/_shared/import-cas.ts:330` falls back from a null exact count to
  `txRows.length`; a fully duplicate upsert can therefore over-report skipped rows as
  inserted in the audit and `cas_parse_success` telemetry.

### Required fix

1. Build a sanitized table-fixture matrix for CDSL and NSDL; do not commit the real PDFs.
2. Add golden and garbage-in cases at parser, canonicalizer, importer, and DB integration
   boundaries.
3. Add privacy-safe validation/reconciliation reason codes and bucketed counts to server
   telemetry, operational logs, and import audit state. Replace current raw
   filename/user/import/folio/scheme/date/amount/unit logging and arbitrary persisted
   error text with explicit allowlists.
4. Make user-visible results distinguish inserted, already present, and rejected/conflict
   counts without exposing internals.
5. Document the new import/caching/observability contract in
   `docs/TECH-DISCOVERY.md`, `docs/INFRASTRUCTURE.md`, both CAS flow diagrams, and—if any
   cache behavior changes—`docs/architecture/cache-surfaces.md` with buster reasoning.

### Acceptance criteria

- CI fails when either issuer's header order is interpreted using the other issuer's map.
- CI fails when a malformed row can reach a mocked transaction upsert.
- CI proves a no-op re-import reports zero inserted and does not mutate catalog data.
- A duplicate upsert returning null or zero count reports zero inserted; it never falls
  back to attempted-row count. Audit, API result, notification, and telemetry agree.
- Privacy tests reject PAN, DOB, filenames, folios, fund/transaction/user/import IDs, raw
  descriptions, raw query keys, dates, amounts, units, and upstream error bodies from
  analytics, logs, and persisted audit errors.
- Operational logs can answer: dialect, parsed count bucket, valid/rejected count bucket,
  duplicate/conflict count bucket, and failure reason—without private data.

---

## 7. Partial writes and holding activation need an explicit policy — P1

**Status: Candidate. Not required to explain the reported jump, but exposed by the same path.**

### Evidence

- `importCASData()` writes shared scheme data, then `user_fund`, then transactions one
  scheme at a time (`supabase/functions/_shared/import-cas.ts:176-325`). There is no
  database transaction spanning the payload.
- Every encountered user fund is upserted with `is_active: true` before closing-balance
  handling (`supabase/functions/_shared/import-cas.ts:211-220`).
- A transaction failure after fund creation is an expected/tested partial result
  (`supabase/functions/_shared/__tests__/import-cas.test.ts:635-650`).
- The latest incident proves malformed data can traverse the entire sequence, but the
  research did not find evidence that this import newly created or wrongly reactivated a
  fund. That specific harm is therefore Candidate.

### Required fix

1. Let the pre-write validator eliminate parser-driven partial writes first.
2. During implementation, inventory failure points after validation and decide whether
   compensation, staging, or a database transaction boundary is warranted without
   violating the repository's Supabase exit-readiness rules.
3. Derive active/inactive state from validated closing balance and economic transactions;
   do not blindly reactivate an existing holding.
4. Add failure-injection tests at each write phase and specify the recoverable state.

### Acceptance criteria

- A scheme or transaction write failure cannot leave a newly active phantom holding.
- Retry after an injected partial failure converges without duplicated rows or catalog
  downgrade.
- Any new transaction/RPC/staging mechanism has explicit grants, ownership, cleanup,
  migration, and provider-exit rationale.

---

## Interim production exposure decision

The faulty depository parser is present in production tags `v0.0.8` through `v0.0.10`:
the introducing commit is an ancestor of all three tags. Production exposes both direct
upload and inbound-email CAS paths (`docs/INFRASTRUCTURE.md:18-35,130-131,490-496`).

**Owner decision, 2026-08-09:** accept this temporary production risk for the duration of
the program because production adoption is currently small and the owner reports no known
production user of CDSL/NSDL CAS. Do not create or deploy an interim production hotfix;
prioritize the planned Q1-Q5 correction. This is an explicit risk acceptance, not a claim
that the parser is safe and not an independently measured usage fact.

If a production depository import is observed, reported, or attempted before the program's
production rollout, treat it as a correctness interrupt under
`docs/process/AGENT-PROGRAM-PLAYBOOK.md` §5.4: pause the queue, investigate, obtain both
independent confirmations, and re-evaluate immediate fail-closed containment with the
human owner.

---

## Recommended implementation order

The milestones are sequential because Q1–Q4 touch the same parser/import boundaries and
because every financial change must be reviewed at a frozen SHA. Q4's catalog tests can be
researched in parallel, but its PR should land after Q1 so it inherits the pre-write
contract. Q5 is intentionally last because data repair before prevention would recreate
the incident.

| Queue | Milestone | One-PR scope | Why this position |
|---:|---|---|---|
| 1 | **Q1 — Fail-closed import contract** | Sanitized all-provider fixtures, pure canonical transaction shape, Python + TypeScript type-specific accounting validation, zero-write rejection, privacy-safe log/audit reason codes | Stops corrupt writes before changing extraction; creates the safety harness for every later PR without regressing other providers/callers |
| 2 | **Q2 — Header-aware CDSL/NSDL extraction** | Per-table header maps, issuer diagnostics, folio parser, category specificity, password/help behavior | Repairs the primary parser cause while Q1 prevents unsafe fallback |
| 3 | **Q3 — Provider-neutral reconciliation** | Gross cash/stamp normalization, split/combined economic-group matching, conflict semantics, idempotency tests | Correct parsing is required before dedupe can compare units reliably |
| 4 | **Q4 — Catalog isolation and write recovery** | Remove CAS authority over shared metadata, safe identity hydration, activation/partial-write policy, multi-user tests | Prevents cross-user collateral damage before real-data replay |
| 5 | **Q5 — Dev repair, freshness, and field proof** | Guarded repair procedure for the bad import/catalog, import-result UX, cache/invalidation proof, telemetry/docs, real private-PDF validation in dev | Repairs only after prevention; produces the program exit evidence |

No implementation milestone may deploy to production. Dev/main validation is required;
production remains a separate explicit human-owner approval after the program exits.

---

## Per-milestone executor prompts

### Q1 — Fail-closed import contract

```text
You are the execution owner for milestone Q1 of the FolioLens CAS Import Correctness
program. The setup owner must replace {{CONTROL_PR}} with the control-plane PR URL and
{{RESEARCH_BRANCH}} with its branch name before dispatch. Read {{CONTROL_PR}}, then run:
  git fetch origin {{RESEARCH_BRANCH}}
  git show origin/{{RESEARCH_BRANCH}}:docs/research/cas-import-correctness-2026-08-09.md
Read ONLY “Sanitized reproduction evidence,” finding 2, finding 6, finding 7, and the Q1
row/prompt from that output. Follow docs/process/AGENT-PROGRAM-PLAYBOOK.md. Branch
program/Q1-cas-preflight from current origin/main; never merge or cherry-pick the research
branch.

Scope:
- Add synthetic, non-identifying CDSL and NSDL table fixtures preserving the two observed
  header orders, plus golden/garbage canonical fixtures for CAMS, KFintech, and MFCentral.
  Exercise both direct-upload and inbound-email callers. Do not add either supplied PDF,
  a screenshot, password, PAN, folio, holder/email, or raw parser output.
- Define a canonical parsed-transaction contract that retains source amount, stamp duty,
  gross amount, NAV, Price, units, date, normalized type/direction, charges, and source
  dialect long enough for validation/reconciliation. Define type/direction-specific
  equations and fixtures where Price differs from NAV.
- Add fail-closed Python validation before parser success and a TypeScript defense at the
  import boundary before any financial/domain write. Only the allowlisted failed-audit
  transition may persist after rejection.
- Use typed, allowlisted, privacy-safe reason codes across analytics, operational logs,
  persisted audit errors, and caller responses. Make malformed mixed payloads all-or-
  nothing at the preflight boundary.

Non-goals:
- Do not repair NSDL column mapping yet.
- Do not redesign dedupe, alter scheme catalog ownership, clean dev data, deploy, or change
  production.

Validation:
- PYTHONPATH=. python -m pytest api/tests -q
- npm test -- --runInBand supabase/functions/_shared/__tests__/import-cas.test.ts
- npm test -- --runInBand
- npm run typecheck
- npm run lint
- git diff --check

Required evidence at the exact PR head SHA:
- Correct canonical payload fixtures for every provider pass preflight. The observed CDSL
  table passes end to end; the known NSDL table layout is safely rejected until Q2.
- The NSDL column-shift garbage fixture and one-corrupt-scheme mixed fixture fail before the
  first mocked financial/domain write; only the allowlisted failed-audit transition occurs.
- Direct upload and inbound email preserve their audit/notification behavior for CAMS,
  KFintech, MFCentral, CDSL, and rejected NSDL fixtures.
- A duplicate upsert whose exact count is null or zero reports zero inserted across the
  API result, audit, notification, and telemetry; attempted rows are never used as a
  successful-insert fallback.
- Analytics/log/audit sanitizer tests prove prohibited identifiers, dates, amounts, units,
  filenames, and raw upstream errors cannot be emitted or persisted.
- State explicitly whether cache payloads/keys changed; if not, include the exact
  [cache-shape-stable] rationale and do not bump the buster.
```

### Q2 — Header-aware CDSL/NSDL extraction

```text
You are the execution owner for milestone Q2 of the FolioLens CAS Import Correctness
program. The setup owner must replace {{CONTROL_PR}} with the control-plane PR URL and
{{RESEARCH_BRANCH}} with its branch name before dispatch. Read {{CONTROL_PR}}, then run:
  git fetch origin {{RESEARCH_BRANCH}}
  git show origin/{{RESEARCH_BRANCH}}:docs/research/cas-import-correctness-2026-08-09.md
Read ONLY finding 1, finding 5, finding 6, and the Q2 row/prompt from that output. Read the
Q1 ledger entry and verify its merge SHA is on origin/main. Follow
docs/process/AGENT-PROGRAM-PLAYBOOK.md. Branch program/Q2-depository-header-parser from
current origin/main.

Scope:
- Replace fixed transaction indexes with normalized per-table header maps supporting the
  observed CDSL and NSDL dialects, optional trailing columns, repeated page headers, blanks,
  and page breaks.
- Make issuer detection diagnostic and deterministic without using acronym order as the
  schema authority.
- Fix folio delimiter parsing, represent a genuinely missing folio as null, and reject
  `No`, `CDSL`, `NSDL`, and other placeholders.
- Fix category specificity ordering.
- Preserve PAN-first, PAN+DOB-second, custom-override password behavior and correct the UI
  and error copy so DOB is not presented as universally required.

Non-goals:
- Do not implement fuzzy/economic dedupe, change scheme catalog ownership, clean dev data,
  or deploy to production.

Validation:
- PYTHONPATH=. python -m pytest api/tests -q
- npm test -- --runInBand
- npm run typecheck
- npm run lint
- git diff --check

Required evidence at the exact PR head SHA:
- Synthetic CDSL and NSDL expected-field assertions, including negative/ambiguous headers.
- CDSL output remains unchanged while NSDL output becomes correct.
- Synthetic fixtures with issuer markers first appearing on page two and on the page-three
  scan boundary parse, and the router/parser issuer diagnostics agree.
- In a transient local/preview run with secrets supplied only at runtime, the private CDSL
  file reports 5/5 valid checked rows and the private NSDL file reports 16/16; publish only
  aggregate outcomes, never fixtures or raw values.
- Demonstrate `Folio No :`, `Folio No -`, Unicode dash, missing-value/null, and issuer-
  sentinel rejection cases; literal `No`, `CDSL`, and `NSDL` never persist as folios.
- Confirm no application telemetry contains private statement data.
```

### Q3 — Provider-neutral reconciliation

```text
You are the execution owner for milestone Q3 of the FolioLens CAS Import Correctness
program. The setup owner must replace {{CONTROL_PR}} with the control-plane PR URL and
{{RESEARCH_BRANCH}} with its branch name before dispatch. Read {{CONTROL_PR}}, then run:
  git fetch origin {{RESEARCH_BRANCH}}
  git show origin/{{RESEARCH_BRANCH}}:docs/research/cas-import-correctness-2026-08-09.md
Read ONLY finding 3 and the Q3 row/prompt from that output. Read the Q1/Q2 ledger entries
and verify both merge SHAs are on origin/main. Follow
docs/process/AGENT-PROGRAM-PLAYBOOK.md. Branch program/Q3-cas-economic-reconciliation from
current origin/main.

Scope:
- Define and implement provider-neutral gross cash normalization and economic-group
  reconciliation using both amount and units with explicit tolerances.
- Cover exact rows, split-to-combined and combined-to-split equality, stamp-duty net/gross
  differences, same-day independent events, identical within-statement multiplicity,
  switches, redemptions, dividends, reversals, true supersets, partial overlaps, and
  conflicts.
- Remove the unscoped cash-only reversal delete. Reversal matching must use the same unit-
  and-cash identity, preserve provenance, and fail closed when more than one event matches.
- Fail closed on ambiguity. Preserve provenance without making provider row shape the
  economic identity.
- Add any migration only after documenting why application-only reconciliation is
  insufficient; include grants, rollback, and exit-readiness implications.

Non-goals:
- Do not clean dev data, change shared catalog authority, add broad transaction deletion,
  or deploy to production.

Validation:
- PYTHONPATH=. python -m pytest api/tests -q
- npm test -- --runInBand supabase/functions/_shared/__tests__/import-cas.test.ts
- npm test -- --runInBand
- npm run typecheck
- npm run lint
- git diff --check
- Run local/ephemeral DB integration tests if schema behavior changes.

Required evidence at the exact PR head SHA:
- All acceptance cases in finding 3 against synthetic/isolated snapshots, including
  garbage-in partial overlap. Do not require the live dev repair, which belongs to Q5.
- Reimport fixtures report exact inserted/duplicate/conflict counts.
- Two identical rows in one statement remain two events, while later re-import adds zero;
  a null/zero database count never over-reports attempted rows as inserted.
- A uniquely matched reversal affects one event; an ambiguous same-day cash-only reversal
  produces a conflict without deleting any transaction.
- No algorithm dedupes on amount alone; reviewers can trace the unit comparison and
  tolerances directly.
- Document transaction query keys, cache persistence status, and invalidation triggers if
  any persisted/server shape changes; bump __BUSTER__ only when required.
```

### Q4 — Catalog isolation and write recovery

```text
You are the execution owner for milestone Q4 of the FolioLens CAS Import Correctness
program. The setup owner must replace {{CONTROL_PR}} with the control-plane PR URL and
{{RESEARCH_BRANCH}} with its branch name before dispatch. Read {{CONTROL_PR}}, then run:
  git fetch origin {{RESEARCH_BRANCH}}
  git show origin/{{RESEARCH_BRANCH}}:docs/research/cas-import-correctness-2026-08-09.md
Read ONLY finding 4, finding 7, and the Q4 row/prompt from that output. Read the prior
ledger entries and verify their merge SHAs on origin/main. Follow
docs/process/AGENT-PROGRAM-PLAYBOOK.md. Branch program/Q4-cas-catalog-isolation from
current origin/main.

Scope:
- Remove CAS authority to overwrite populated scheme_master metadata.
- Define minimal missing-scheme identity behavior and route authoritative hydration through
  existing metadata writers/provider boundaries.
- Make holding activation derive from validated state rather than unconditional true.
- Decide and implement the smallest safe recovery policy for post-preflight write failures;
  include failure injection and retry convergence.
- Add a multi-user test proving catalog immutability across a user's import.

Non-goals:
- Do not clean the live dev rows in this PR before the prevention is merged/deployed.
- Do not introduce Realtime, client-side RPC, Vault, or an unnecessary SECURITY DEFINER
  function. Do not deploy to production.

Validation:
- npm test -- --runInBand supabase/functions/_shared/__tests__/import-cas.test.ts
- npm test -- --runInBand
- npm run typecheck
- npm run lint
- git diff --check
- Apply/test migrations against the intended local/ephemeral DB if any are added.

Required evidence at the exact PR head SHA:
- Existing scheme metadata before/after digest is byte-identical.
- Missing-scheme hydration and failure/retry cases have deterministic outcomes.
- A transaction failure cannot leave a newly active phantom holding.
- Any migration has explicit grants, rollback, deployment target, and verified schema state.
- State whether PostHog/cache docs require change and update them in the same PR when they do.
```

### Q5 — Dev repair, freshness, and field proof

```text
You are the execution owner for milestone Q5 of the FolioLens CAS Import Correctness
program. The setup owner must replace {{CONTROL_PR}} with the control-plane PR URL and
{{RESEARCH_BRANCH}} with its branch name before dispatch. Read {{CONTROL_PR}}, then run:
  git fetch origin {{RESEARCH_BRANCH}}
  git show origin/{{RESEARCH_BRANCH}}:docs/research/cas-import-correctness-2026-08-09.md
Read the complete Program exit criterion, finding 4 acceptance criteria, finding 6, and
the Q5 row/prompt from that output. Read every ledger entry and verify every prior merge
SHA is on origin/main. Follow docs/process/AGENT-PROGRAM-PLAYBOOK.md. Branch
program/Q5-cas-repair-field-proof from current origin/main.

Scope:
- Before presenting any cleanup approval, deploy the merged Q1-Q4 prevention code to the
  authorized dev/main validation surface, record its exact deployed SHA, and prove the
  deployed build rejects the known malformed layout before financial/domain writes.
- Produce a dry-run-first, exact-target dev repair procedure keyed by the bad audit/import
  record outside committed source. It may remove only rows attributable to that import and
  must report aggregate counts before mutation. Create a recoverable backup/rollback
  artifact, present the exact resolved targets to the human owner, and obtain explicit
  approval immediately before deletion.
- Rehydrate the 11 touched shared schemes through authoritative metadata writers after the
  unsafe writer is gone.
- Ensure successful/no-op/conflict import results trigger the correct native/web transaction
  freshness behavior and show inserted/already-present/rejected counts honestly.
- Add privacy-safe operational telemetry and update TECH-DISCOVERY, INFRASTRUCTURE, CAS
  architecture flows, and cache inventory/buster rationale where applicable.
- Deploy only to the dev/main validation surfaces authorized by the human owner. Do not
  deploy to production.

Non-goals:
- Do not delete by date/amount/fund heuristics, copy private PDFs into tooling, rewrite
  unrelated transactions, or touch production data.

Validation:
- npm test -- --runInBand
- npm run typecheck
- npm run lint
- git diff --check
- All focused Python/import/reconciliation/cache/analytics tests from Q1-Q4.
- Dry-run SQL counts and the recoverable backup/rollback artifact must be reviewed, and the
  human owner must explicitly approve the exact one-time dev mutation immediately before it
  runs.

Required evidence at the exact PR head SHA and deployed dev/main build:
- Before/after aggregate repair counts and a rollback/recovery record, with no identifiers.
- The 16 bad-import rows are removed; unrelated transaction count/digest is unchanged.
- All 11 touched schemes are authoritative or explicitly unresolved; no other user's data
  was edited except shared catalog correction from the authoritative source.
- The private CDSL file is validated only through a transient parser run and is never
  persisted; a sanitized synthetic CDSL integration fixture inserts once in an isolated
  dev test account and adds zero on reimport. With explicit owner approval at mutation
  time, the private NSDL reimport in the repaired account yields 12 matched economic
  groups, zero conflicts, and zero inserted rows.
- Dev portfolio value, gain, XIRR, transaction count, money trail, funds, and timeline agree
  with the repaired transaction source after web reload, foreground return, persisted-cache
  restore, and native SQLite sync.
- Record the release/build/OTA identifier and exact SHA. Production remains blocked pending
  explicit owner approval after main-app validation.
```

---

## What not to do

1. **Do not shift the numeric indexes globally.** The supplied CDSL statement currently
   parses correctly; a universal NSDL offset would trade one corruption for another.
2. **Do not trust issuer acronym order as a table schema.** Consolidated statements contain
   both CDSL and NSDL vocabulary.
3. **Do not keep “amount > 0” as the only corruption gate.** The incident's bad rows had
   plausible positive amounts and units.
4. **Do not dedupe on amount alone.** Same-day independent events can share amounts; require
   units and explicit grouping/conflict behavior.
5. **Do not add fuzzy tolerances without garbage-in collision tests.** A permissive match can
   silently erase a real transaction, which is worse than an explicit conflict.
6. **Do not delete/reinsert the user's history to make the latest CAS authoritative.** Imports
   are additive and may coexist with manually sourced or differently scoped history.
7. **Do not let user imports own shared catalog metadata.** Resolve identity, then hydrate
   through the authoritative writers.
8. **Do not repair dev before prevention is merged and deployed.** Otherwise the same file can
   recreate the damage.
9. **Do not commit, upload, log, or paste the supplied PDFs, passwords, PANs, folios, holder
   details, exact personal financial figures, raw payloads, or exact private rows into
   GitHub/CI.** Synthetic fixtures only.
10. **Do not merge a milestone without both SHA-pinned Codex and Claude convergence markers.**
    Review rounds use a frozen head and the mechanical `Dual-review convergence` gate.
11. **Do not roll out to production during this program without a new, explicit human-owner
    approval after main-app validation.**

---

## Program control-plane protocol

- The research PR remains draft and is labeled `program-control-plane`.
- The research report itself receives independent Codex and Claude review before Q1 starts.
- Every implementation branch uses `program/<milestone-id>-<slug>` so the convergence gate
  applies mechanically.
- Every implementation PR gets both independent reviewers in frozen-head rounds. The gate
  accepts only current-head standalone markers:
  - `[Codex review <ID>] CONVERGED at <full 40-character SHA>`
  - `[Claude review <ID>] CONVERGED at <full 40-character SHA>`
- Status and the ledger live in the control PR description; the research branch changes only
  for genuine scope amendments and final outcomes.
- Merge authority: **human owner presses merge** for every implementation PR after the green
  dual-review gate and all required checks. This conservative choice is appropriate for the
  first correctness milestones and can be amended only by an explicit owner decision.
- Closeout owner: execution owner, with the human owner approving any accepted unmet exit
  condition and the eventual production rollout separately.
- Wake model: exactly three persistent sessions (executor, Codex reviewer, Claude reviewer)
  after research acceptance. Use the playbook bootstrap prompts and low-frequency polling or
  supported event wakes; do not create per-milestone ad hoc reviewer identities.

---

## Program exit criterion

The program is complete only when all Q1–Q5 PRs are merged with SHA-pinned Codex and
Claude convergence, every merge SHA is on `origin/main`, and the following field evidence
is recorded:

1. **Parser proof:** at the exact deployed dev/main SHA, transient runs of the two supplied
   private statements report the expected aggregate scheme/transaction counts and 100% of
   applicable positive-value rows within the documented accounting tolerance. No private
   source is stored in GitHub, CI, logs, analytics, or artifacts.
2. **Idempotency proof:** after dev repair and explicit owner approval for the validation
   mutation, the supplied NSDL reimport resolves all 12 economic groups as already present,
   with zero conflicts and zero inserts. A sanitized synthetic CDSL integration fixture
   inserts once in an isolated dev test account and adds zero on a second import. The
   friend's private CDSL statement is parser-only evidence and is never persisted.
3. **Repair proof:** exactly the 16 transactions attributable to the known bad dev import are
   removed; unrelated transaction aggregates/digests are unchanged; the 11 touched shared
   schemes are authoritatively rehydrated or explicitly documented as unresolved.
4. **Portfolio proof:** dev no longer has the import-boundary value jump. Portfolio value,
   overall gain, XIRR, transaction count, Money Trail, Funds, and timeline are internally
   consistent with the repaired transactions after web reload, persisted-cache restore,
   native foreground return, and native SQLite sync.
5. **Safety proof:** malformed/ambiguous issuer fixtures produce a privacy-safe failure and
   zero financial/domain writes; only the allowlisted failed-audit transition is permitted.
   A catalog digest and multi-user test prove CAS import cannot alter existing shared scheme
   metadata.
6. **Observation window:** during at least seven days of dev/main dogfooding, both direct-
   upload and inbound-email event families have an explicit denominator and at least one
   exercised success or controlled test in each path. Across that sample, the rate of a
   success event with any validation failure or reconciliation conflict is zero. Intentional
   rejection tests are separately tagged, counted, and excluded from the success numerator.
7. **Production gate:** the human owner explicitly approves production only after reviewing
   the main-app evidence. If approval is withheld, that is not an unmet program criterion;
   production rollout is a separate release decision.

If any criterion cannot be met, the control PR stays draft until the human owner explicitly
accepts the named unmet condition and rationale. Per-milestone unit tests are necessary but
do not substitute for this end-to-end evidence.

---

## Alternatives considered

### Keep fixed maps selected by issuer

Rejected as the sole design. Explicit issuer maps are useful, but issuer detection itself is
ambiguous in consolidated statements and layouts can evolve. Header-derived mapping with
issuer-specific aliases fails closed more safely.

### Change only the database unique constraint

Rejected. No simple fuzzy unique index can safely express split/combined events, stamp-duty
grossing, and genuine same-day independent transactions. Reconciliation needs an explicit,
tested economic contract before any schema optimization.

### Delete all rows for matching dates and reimport the latest CAS

Rejected. The latest CAS may cover a narrower period or provider representation and can
coexist with other legitimate sources. Deleting by date/fund/type risks silent data loss.

### Store the real PDFs as encrypted regression fixtures

Rejected. Encryption keys, access, CI handling, and personal-data retention are unnecessary
when sanitized structural table fixtures can reproduce the parser contract. Real PDFs remain
transient field validation sources only.

---

## Decision log

- **2026-08-09 — Use the agent-program playbook.** Financial correctness spans parser,
  importer, schema semantics, shared metadata, caches, and repair; five sequential PRs with
  independent Codex + Claude review are proportionate.
- **2026-08-09 — Header schema, not issuer token, owns extraction.** One fixed CDSL map is
  correct for the supplied CDSL statement and incorrect for the supplied NSDL statement.
- **2026-08-09 — Defense in depth.** Parser validation and importer preflight both remain;
  a parser regression must not become a database corruption event.
- **2026-08-09 — Repair last.** Prevent, parse, reconcile, and isolate catalog ownership
  before mutating the dev dataset.
- **2026-08-09 — Human merge authority and no production rollout.** Every milestone needs
  the mechanical dual-review gate plus a human merge; production requires separate approval.
- **2026-08-09 — Owner accepts temporary production exposure.** Production adoption is
  currently small and the owner reports no known production CDSL/NSDL CAS users, so the
  owner explicitly prefers the planned Q1-Q5 fix over an interim production hotfix. Any
  observed production depository import reopens containment as a correctness interrupt.

---

## Progress

- [x] Reproduced the dev/prod portfolio divergence.
- [x] Identified the NSDL/CDSL header-order difference.
- [x] Validated the supplied CDSL statement against the current parser using aggregate-only
  evidence.
- [x] Queried the dev import and cross-source overlap using sanitized aggregates.
- [x] Identified shared catalog, folio, detection, category, password-copy, test, and
  partial-write risks.
- [x] Addressed an independent pre-publication Codex review pass; formal frozen-head
  research convergence remains pending.
- [x] Addressed Claude research review round 1 and recorded the owner's explicit temporary
  production-risk acceptance; frozen-head re-review remains pending.
- [ ] Independent Codex research review converged.
- [ ] Independent Claude research review converged.
- [ ] Q1 — Fail-closed import contract.
- [ ] Q2 — Header-aware CDSL/NSDL extraction.
- [ ] Q3 — Provider-neutral reconciliation.
- [ ] Q4 — Catalog isolation and write recovery.
- [ ] Q5 — Dev repair, freshness, and field proof.
- [ ] Program exit criterion evaluated.

---

## Final outcomes

Not yet evaluated. This section is completed by the closeout owner after every milestone
merges and the field observation window is satisfied or explicitly accepted as unmet.
