# Q3 Provider-Neutral CAS Economic Reconciliation

## Goal

Make repeated CAS imports idempotent by economic event rather than by provider row shape. Normalize source cash to a documented gross economic amount, reconcile aggregate cash and units with explicit tolerances, preserve genuine repeated events, and make every reversal target one uniquely identified purchase or fail without changing transactions.

## User Value

A user can import overlapping CAMS, KFintech, MFCentral, CDSL, and NSDL statements without seeing split provider rows duplicated, legitimate same-day transactions collapsed, or an ambiguous reversal erase unrelated history. If FolioLens cannot prove equivalence, it reports a safe conflict and leaves transaction history unchanged.

## Context

Q1 merged in PR #292 as `f7a54d647f29bdf38e74341156c5dc91d39ef3a6` and established the pure Python/TypeScript fail-closed transaction contract. Q2 merged in PR #293 as `80dced1a785640bff094a44fb60d287a7f7c1f79` and made depository extraction header-owned. Both merge SHAs are ancestors of the Q3 branch base.

The current importer in `supabase/functions/_shared/import-cas.ts` delegates idempotency to a unique key on fund, date, type, units, and amount. That key cannot recognize a provider that splits one event into several rows when another provider combines it. It also collapses two genuinely identical rows in one statement. Its reversal path is more dangerous: it issues an amount-only delete that can remove every same-day purchase with that cash amount.

The supplied NSDL statement now extracts all 16 rows under Q2 but intentionally stops at Q1 `accounting_mismatch` because some outflows expose net cash while Price times Units independently exposes gross value. Q3 owns that explicit gross/net model. Private statements remain transient evidence only; no private value, filename, credential, or derived fixture may be committed or logged.

## Assumptions

- The branch is `program/Q3-cas-economic-reconciliation` from Q2's merge on current `origin/main`.
- Q1 canonical Price, units, direction, charges, and source cash remain mandatory safety evidence.
- Application reconciliation is authoritative; the database uniqueness constraint is only the final race/idempotency backstop.
- Postgres numeric storage rounds transaction cash to two decimals and units to four decimals.
- Existing transaction rows have no provider-neutral ordinal and therefore receive ordinal zero during migration.
- Q4 owns shared catalog authority, full write recovery, and activation/retry policy. Q5 owns dev repair and private-account mutation.
- No dev-data repair, production deployment, or production rollout occurs in Q3.

## Definitions

- **Source cash:** The amount printed in the provider row. It may be gross, charge-inclusive, or net of withholding.
- **Economic gross cash:** The provider-neutral value used for persistence and reconciliation. For inflows it includes explicitly reported acquisition charges; for outflows it is the independently supported value before withholding or exit deductions.
- **Economic group:** Rows for one user fund, transaction date, normalized transaction type/direction, and compatible folio identity.
- **Row multiset:** A collection that preserves how many times an identical row occurs. Two identical rows are two events, not one set member.
- **Event ordinal:** A deterministic zero-based number assigned among rows with the same persisted identity inside one statement. It preserves within-statement multiplicity and is stable on byte-identical re-import.
- **Conflict:** A partial overlap, cash-only match, unit-only match, folio ambiguity, unmatched reversal, or multi-candidate reversal for which equivalence cannot be proved. A malformed or unreadable stored row is a separate fail-closed reconciliation-read error.

## Scope

- Normalize incoming persisted/reconciled cash from canonical Price, units, source cash, direction, and explicit charges.
- Represent parser-confirmed net-of-withholding outflows explicitly; never manufacture a tax/charge field from an unexplained residual.
- Reconcile incoming and existing economic groups many-to-many with both aggregate cash and aggregate units.
- Support exact row overlap, split-to-combined and combined-to-split equivalence, stamp-duty net/gross differences, incoming true supersets, same-statement independent rows, and repeated identical rows.
- Preserve an incoming subset as duplicates and insert only a provable exact unmatched suffix of an incoming superset.
- Treat partial overlap or one-dimensional equality as a conflict instead of inserting or deleting.
- Replace amount-only reversal deletion with a plan that selects at most one exact transaction ID after cash and units are considered. A cash-only reversal is allowed only when exactly one candidate remains.
- Complete reconciliation planning before transaction insert, delete, or inactive-holding updates.
- Add the minimum generic Postgres schema needed to preserve multiplicity.
- Add privacy-safe conflict reasons, exact result-count tests, documentation, and cache-shape analysis.

## Out Of Scope

- Repairing any existing dev transaction, fund, or catalog row.
- Changing CAS authority over `scheme_master`; Q4 owns that boundary.
- Making all scheme/fund/transaction writes one database transaction; Q4 owns full write recovery.
- Broad transaction deletion, fuzzy amount-only matching, or a fuzzy database unique index.
- Changing client transaction query payloads, React Query keys, or persistence allowlists.
- Deploying any migration or function to dev or production during this milestone.

## Approach

Add a pure `cas-reconciliation.ts` module beside the importer. It will round incoming cash and units to database precision, assign event ordinals, group rows by date/type and the documented folio policy, compute aggregate totals, and return one complete plan containing specific inserts, exact existing IDs for proven reversals, duplicate/matched counts, or privacy-safe conflict reasons.

Cash comparison uses the larger of one rupee or 0.2 percent of the compared economic total. Unit comparison uses the larger of 0.0001 units or one part per million of the compared total. Every equivalence decision requires both comparisons. Row-level matching is multiplicity-aware. If all incoming rows match stored rows, the group is a duplicate. If stored rows are an exact multiset subset of incoming rows, only the unmatched incoming rows are inserted. If there is no row overlap but aggregate cash and units both match, the representations are split/combined equivalents and nothing is inserted. If one aggregate dimension matches without the other, or both sides retain unmatched rows after a partial match, the complete import conflicts.

Folio matching is exact after trim and uppercase when both sides have a value. A null folio may bridge to a known folio only when that date/type group has at most one distinct known folio; otherwise reconciliation conflicts. Different known folios are independent groups.

For reversals, first search the same incoming statement for purchase candidates on the same date and compatible folio. Cash and units must both match when units are present; a missing-unit reversal may select only one cash candidate. A unique incoming match removes only that incoming purchase from the insertion plan. If no incoming candidate exists, search stored purchases under the same rules and plan deletion by exact transaction `id`. Zero or multiple candidates conflict. All reversal and ordinary-group plans complete before any transaction mutation.

The importer will persist economic gross cash instead of provider source cash. Depository parsing will mark a row as net-of-withholding only from explicit statement wording and will set gross cash from independent Price times Units evidence. The Python and TypeScript preflights will accept that form only for outflows, only when gross equals the independently calculated base within tolerance, only when source cash does not exceed gross, and only within a bounded withholding ratio. No residual is stored as a fabricated charge.

Application-only reconciliation cannot preserve two identical rows because the current database unique constraint rejects the second row. Add `cas_event_ordinal integer not null default 0` and replace the old key with a `UNIQUE NULLS NOT DISTINCT` constraint over fund, date, type, units, amount, folio, and ordinal. Existing rows remain ordinal zero. The migration is provider-neutral SQL, needs no new grant, policy, provider feature, or client payload. Rollback requires first consolidating ordinal-greater-than-zero duplicates, then restoring the old constraint; that destructive rollback is documented but not automated.

The new server column is deliberately absent from every client `select(...)`. Public `UserTransactionRow`, React Query payloads, and persisted web transaction payloads therefore do not change shape. Native SQLite already receives immutable server `id`, but its old economic composite primary key would collapse genuine identical rows; Q3 bumps `SCHEMA_VERSION` to 3 and keys `tx` by `id`. The version mismatch wipes and rehydrates the discardable native cache. Existing transaction insert/delete sync invalidation and server-count drift repair remain authoritative, so the React Query `__BUSTER__` does not change.

## Alternatives Considered

- **Fuzzy unique index over rounded cash and units.** Rejected because a database index cannot express split/combined many-to-many equality, partial-overlap conflicts, or reversal ambiguity.
- **Delete and replace every date/type group.** Rejected because it destroys provenance, risks manual transactions, and widens Q3 into repair behavior.
- **Keep the existing unique key and aggregate identical rows.** Rejected because the acceptance contract requires two genuine identical events to remain two events.
- **Store inferred withholding as a charge.** Rejected because a residual is not statement evidence. Q3 records only a low-cardinality net-cash basis and independently supported gross value.
- **Match reversals on cash alone.** Rejected because two unrelated same-day purchases can share an amount.

## Milestones

### 1. Pure gross normalization and reconciliation contract

Add provider-neutral row types, precision rounding, tolerances, event ordinals, folio compatibility, multiset matching, aggregate matching, and conflict summaries. Add focused tests for exact overlap, both split/combined directions, stamp-duty normalization, true supersets, partial overlaps, same-day independent rows, identical multiplicity, switches, redemptions, dividends, and one-dimensional mismatches.

Acceptance: every decision can be tested without Supabase I/O, no branch dedupes on cash alone, and conflict output contains only reason codes and count buckets.

### 2. Gross/net preflight and depository extraction

Add the explicit net-of-withholding basis to the shared canonical contract and depository parser. Keep Python and TypeScript behavior aligned. Normalize persisted economic cash from independent Price/units plus explicit charges.

Acceptance: synthetic net-withholding outflows pass only with explicit wording and independent gross evidence; unlabeled residuals still fail `accounting_mismatch`; existing all-provider golden/garbage fixtures remain green.

### 3. Import planning and exact reversal mutation

Page existing user-fund and transaction rows before writes, run complete reconciliation, then apply only planned inserts and exact-ID reversal deletes. Preserve exact database counts and do not attempt transaction mutations on conflict.

Acceptance: a unique reversal affects one event; an ambiguous cash-only reversal reports a conflict and performs zero deletes/upserts; null and zero database counts never over-report inserts.

### 4. Multiplicity migration and integration evidence

Add the event-ordinal migration, native SQLite v3 identity migration, and integration-style mock/local database coverage. Prove two identical rows receive ordinals zero and one, survive the native cache as separate server IDs, and insert zero on later re-import. Validate `UNIQUE NULLS NOT DISTINCT` and the new on-conflict target in an ephemeral database when available.

Acceptance: the database permits intentional multiplicity and rejects an ordinal-identical race; no dev or production database is mutated.

### 5. Documentation, private aggregate proof, and review handoff

Update technical discovery, upload/inbound architecture, cache inventory, and this plan. Run the supplied statements transiently after implementation and record only aggregate provider/count/outcome evidence. Run the required full validation, open the implementation PR, label it `program-milestone` plus `needs-review`, and freeze the exact SHA for Codex and Claude.

Acceptance: synthetic/isolated observed shapes produce 12 matched groups, zero conflicts, and zero inserts; private CDSL and NSDL aggregate outcomes meet the implemented contract; all scratch artifacts are deleted; no deployment occurred.

## Validation

    PYTHONPATH=. python -m pytest api/tests -q
    npm test -- --runInBand supabase/functions/_shared/__tests__/import-cas.test.ts
    npm test -- --runInBand
    npm run typecheck
    npm run lint
    git diff --check

Focused validation also covers the pure reconciler, Python/TypeScript net-cash twin behavior, Edge caller safe conflict outcomes, migration syntax, exact insert counts, and transient private aggregate proof. Run a local or ephemeral Postgres/Supabase integration only if it can be done without touching dev or production.

Current implementation evidence:

- Python: 353 tests and 3 subtests passed.
- Jest: 106 suites and 2,188 tests passed, including the reconciler, importer, caller contract, native SQLite identity, and cache-shape guard.
- `npm run typecheck` and zero-warning `npm run lint` passed.
- Ephemeral PostgreSQL 17 accepted the migration, preserved ordinals zero and one for two identical economic rows, rejected an ordinal-identical race through the exact `ON CONFLICT` target, and rejected a negative ordinal. The container and SQL scratch were deleted; no shared database was contacted.
- The official AMFI map endpoint returned HTTP 200. Both supplied private statements then passed the current parser/preflight independently: the unrelated NSDL statement produced 16 accepted rows, including four explicitly supported net-basis rows, and the unrelated CDSL statement produced five accepted rows. They were never combined into one account or reconciliation fixture. Passwords, filenames, holder data, folios, raw rows, and financial values were neither emitted nor persisted; the in-memory helper was deleted immediately.
- No dev/prod migration, function deployment, data mutation, or production rollout occurred.

## Risks And Mitigations

- **Independent same-day events are mistaken for overlap.** Preserve all rows when no stored group exists; allow only provable multiset supersets when a stored group does exist; otherwise fail closed.
- **Tolerance merges distinct events.** Require cash and units together, round to database precision first, and keep tolerances explicit and narrow.
- **Null folio bridges unrelated accounts.** Permit null bridging only when one known folio candidate exists; otherwise conflict.
- **A reversal mutates before a later conflict.** Build every plan before the first transaction mutation and delete only by exact ID.
- **Migration exposes a client cache identity mismatch.** Keep the new column out of explicit client selects, key native cached rows by their existing server UUID, bump SQLite to v3, and document why the stable React Query payload needs no buster bump.
- **Private validation leaks evidence.** Use secure hidden input, in-memory parsing, aggregate-only output, and immediate scratch deletion.
- **Q3 expands into catalog/write recovery.** Leave scheme metadata authority and all-domain atomic retry behavior to Q4.

## Decision Log

- 2026-08-10: Use row-based persistence plus a deterministic event ordinal; do not introduce canonical-group tables or reconciliation records in Q3.
- 2026-08-10: Reconciliation requires both cash and units. Cash tolerance is max(₹1, 0.2%); unit tolerance is max(0.0001, one part per million).
- 2026-08-10: Preserve same-statement multiplicity and only add a provable exact incoming superset over stored rows. Ambiguous new-vs-overlap cases fail closed.
- 2026-08-10: Null folio is a unique-candidate bridge, never a broad wildcard.
- 2026-08-10: Net withholding needs explicit statement wording plus independent gross evidence; inferred residuals never become stored charges.
- 2026-08-10: The migration is necessary because application logic cannot override the current unique constraint's collapse of identical events.
- 2026-08-10: Cache audit corrected the prior SQLite decision: payload shape remains stable and needs no `__BUSTER__`, but native `tx` must move from the economic composite key to immutable server `id`; `SCHEMA_VERSION` therefore advances to 3.
- 2026-08-10: Reconciliation history reads are deterministically ordered and paged at 1,000 rows so PostgREST response limits cannot silently truncate overlap evidence.
- 2026-08-10: A proven incoming purchase/reversal pair is consumed before historical candidates are considered; this prevents a re-imported historical twin from turning a safe in-payload pair into an ambiguous delete.
- 2026-08-10: A valid reversal-only statement is reconciliation-actionable even though reversals are not insertable transaction rows; tax/charge-only statements remain rejected.
- 2026-08-10: Scheme-level closing units are summed across every folio occurrence and can drive inactivation only when every occurrence supplies a numeric balance.
- 2026-08-10: Direct-upload reconciliation conflicts return HTTP 422, while history-read and write failures remain server errors.

## Amendments

- The initial plan said the server-only ordinal required no SQLite schema change. Implementation review disproved that: native SQLite's old five-column primary key would still collapse the second genuine identical event. Q3 now bumps native schema v3 and uses the already-selected immutable server transaction ID as the local key. This strengthens the original multiplicity requirement without changing client payloads or React Query persistence.
- Historical reconciliation was initially described as one complete query. It is now a stable ID-ordered paginated read, with a page-two regression fixture, because PostgREST otherwise caps results at 1,000 rows.
- The reversal algorithm now makes its intended source priority explicit: match the incoming statement first, then historical storage only when no incoming candidate exists. All historical deletes remain exact-ID plus fund scoped.
- Final contract audit added malformed non-string cash-basis parity, reversal-only actionability, multi-folio closing-balance aggregation, and a client-safe conflict HTTP status. These close fail-open/runtime and false-inactivation edges without changing the economic identity.

## Progress

- [x] Read product intent, program protocol, accepted finding 3/Q3 prompt, Q1/Q2 ledger, and current cache/schema/import contracts.
- [x] Verify Q1 and Q2 merge SHAs on current `origin/main`.
- [x] Revalidate both supplied statements transiently against the Q2 merge and delete every scratch artifact.
- [x] Define the Q3 reconciliation, reversal, migration, privacy, and cache decisions in this ExecPlan.
- [x] Implement and test the pure economic reconciliation contract.
- [x] Implement explicit gross/net canonical behavior in Python and TypeScript.
- [x] Refactor paged import planning and exact-ID reversal handling.
- [x] Add and validate the Postgres multiplicity migration plus native SQLite v3 identity.
- [x] Update technical, architecture, cache, and plan documentation.
- [x] Run focused and full validation plus transient supplied-file proof.
- [ ] Open the Q3 implementation PR and enter exact-SHA dual review.
