# FolioLens — Technical Discovery

This is the current technical map for FolioLens data sources, ingestion, and
financial-data constraints. It is a living reference, not a pre-build discovery
snapshot. Prefer this doc over archived plans when deciding how the app obtains or
stores fund data today.

For cache ownership and invalidation rules, read
[docs/architecture/cache-surfaces.md](./architecture/cache-surfaces.md). For
deployment/runtime wiring, read [docs/INFRASTRUCTURE.md](./INFRASTRUCTURE.md).

---

## Current stack decisions

| Layer | Decision | Current rationale |
|---|---|---|
| Frontend | Expo React Native + TypeScript + Expo Router | One codebase covers Android, iOS, mobile web, and desktop web. Desktop is a responsive shell over the same route tree. |
| Backend | Supabase Postgres + Edge Functions | Fits the current app size and keeps auth, data, cron, storage, and functions in one operational surface. Provider boundaries are explicit in `src/lib/{auth,functions,storage,data}/`. |
| Web/API router | Vercel | Hosts the Expo web app, CAS PDF parser relay, Resend inbound router, feedback notifier, and freshness alerts. |
| Product/ops telemetry | PostHog | Privacy-safe product, import, cache, sync, and UX timing events. No autocapture or session replay by default. |
| NAV data | OpenFolio first, mfapi.in fallback | Held-fund sync uses OpenFolio `/v1/nav/delta` in ≤500-scheme batches with per-scheme watermarks. Per-scheme OpenFolio remains the rollout/error fallback; mfapi.in remains the data-gap fallback. App clients never call mfapi directly. |
| Index data | Server-side index sync | `sync-index` fetches benchmark closes into `index_history` using NSE TRI first, EODHD fallback, and Yahoo Finance for legacy price-return symbols. Browser-side index fetches remain out of scope. |
| Fund metadata | OpenFolio metadata first, mfdata fallback | `sync-fund-meta` and `universe-backfill` populate `scheme_master`; mfdata only fills unresolved fields where OpenFolio does not provide a value. |
| Holdings/composition | OpenFolio official rows first, mfdata/category fallback | Official AMC-disclosure-derived rows use `source='official'`. New mfdata backup rows use `source='category_fallback'`; legacy `source='amfi'` rows can still exist and are ranked between official and category fallback. |
| CAS import | Detailed CAS PDF + Resend inbound forwarding | Users upload a detailed CAS PDF or forward CAS emails to their per-user `cas-...@foliolens.in` inbox. No Gmail OAuth or broker credential access. |
| XIRR/financial calculations | Client-side TypeScript | Calculations run in deterministic utility modules with tests; persisted results are cache outputs, not sources of truth. |

---

## Architecture overview

```text
Expo app (native + web)
  ├─ Supabase Auth
  ├─ Supabase Data API through src/lib/data/* repos
  ├─ Supabase Edge Functions through src/lib/functions
  ├─ React Query + Zustand + AsyncStorage/localStorage + native SQLite
  └─ PostHog telemetry facade

Supabase
  ├─ Postgres: user data, transactions, NAV/index history, scheme metadata, composition
  ├─ Edge Functions: sync, import, freshness, feedback, on-demand hydration
  ├─ Storage: feedback attachments + static snapshots
  └─ pg_cron/pg_net: scheduled sync/audit jobs

Vercel
  ├─ Expo web app
  ├─ Resend inbound router
  ├─ CAS parser relay
  ├─ feedback/freshness email endpoints
  └─ production deploy gate
```

---

## Data sources

### Mutual-fund NAVs

- **Primary:** OpenFolio `/v1/nav/delta` for held-fund sync, batched at ≤500 schemes with per-scheme incremental `since` watermarks.
- **Fallback:** per-scheme OpenFolio `/v1/nav/{scheme_code}` for failed delta batches during rollout/outages, then mfapi.in `/mf/{scheme_code}` for gaps.
- **Writers:** `sync-nav` for held funds and `fetch-fund-nav` for non-held funds selected in Compare/Past SIP/Fund Detail flows.
- **Client ownership:** native SQLite is the durable raw-history cache; React Query persists only bounded rendered outputs and small supporting lookups.
- **Coverage proof:** native reads must not treat a recent slice as full history unless the SQLite `sync_state` coverage row proves the lower bound. See the C1 notes in the cache inventory.

### Benchmark/index history

- **Table:** `index_history`.
- **Writer:** `sync-index`.
- **Source priority:** NSE direct TRI endpoint > EODHD > Yahoo Finance > unknown.
- **Snapshots:** `regenerate-index-snapshots` writes public JSON snapshots for fast client reads; hooks fall back to paginated PostgREST when the snapshot is absent or malformed.
- **Constraint:** all index data is fetched server-side. Do not add browser-side NSE/Yahoo fetches.

### Scheme metadata

- **Table:** `scheme_master`.
- **Writers:** `sync-fund-meta`, `universe-backfill`, and `fetch-fund-snapshot`.
- **Primary fields:** OpenFolio `/v1/metadata` writes family identity, plan/option type, AUM, period returns, risk ratios, risk label, benchmark, manager, and related B1 fields.
- **Fallback:** mfdata fills unresolved fields only. Guard utilities such as `src/utils/mfdataGuards.ts` prevent junk text from reaching the UI.
- **Catalog scope:** `universe-backfill` walks the active AMFI universe so Compare/Past SIP can search funds that no current user holds.

### Holdings and portfolio composition

- **Table:** `fund_portfolio_composition`.
- **Source precedence:** `official > amfi > category_fallback > category_rules`.
- **Primary:** OpenFolio official AMC disclosures (`source='official'`) synced monthly and hydrated on demand for selected funds.
- **Backup:** mfdata holdings (`source='category_fallback'`) with guards for corrupted debt/equity payloads.
- **Last resort:** SEBI-category rules (`source='category_rules'`) for broad asset/cap approximations. UI must disclose category-derived data.
- **Selector:** `src/utils/compositionSource.ts` is the app-side source-of-truth for ranking rows; Deno functions mirror that ranking.

### CAS import

FolioLens supports two practical CAS paths:

1. **PDF upload** — user uploads a detailed CAMS/KFintech/MFCentral/CDSL/NSDL statement. The app sends it to `parse-cas-pdf`, which relays to the Vercel parser and imports through `_shared/import-cas.ts`.
2. **Email forwarding** — user forwards the CAS email to a per-user Resend inbound address. The Vercel inbound router verifies the Resend event, resolves the target inbox, fetches the full email/attachments when needed, then calls `cas-webhook-resend`.

Both paths enforce the same fail-closed import contract. Python retains the
provider dialect plus source amount, explicit cash basis, gross amount, charges,
statement NAV, transaction Price, units, date, type, and direction, then validates the complete
payload before returning parser success. TypeScript repeats that preflight before
the first financial or shared-domain operation. A rejected direct upload changes
only its audit row to `failed`; inbound email parses and preflights every PDF before
importing any attachment, so a mixed-validity message cannot partially import.
Failure records and telemetry use allowlisted reason codes and bucketed counts,
never raw CAS payloads, filenames, identifiers, financial values, or exception text.

Depository statements use a header-aware adapter. Every CDSL/NSDL transaction
table must be covered by an unambiguous normalized map for Date, Description,
Amount, Units, and NAV or Price before a dated row is accepted. A leading
page-header table may cover sibling transaction tables on that page; a
scheme-local header cannot leak into a new scheme table. Stamp Duty and
trailing charge columns are optional. Repeated headers refresh the map across
page breaks; a missing or ambiguous schema returns the privacy-safe
`unsupported_layout` reason. Issuer wording from the first three pages is only
a routing/diagnostic hint—the validated header schema is the authority for
financial column extraction.

The adapter never invents a charge from the residual between Amount and Price
times Units. An outflow is marked `net_of_withholding` only when mapped provider
wording explicitly says tax/TDS/withholding was deducted; its provider-neutral
gross cash must then be independently supported by Price times Units and remain
within the bounded withholding rule. An unlabeled residual remains fail-closed as
`accounting_mismatch`.

Direct uploads use a fixed password order. A custom password is exclusive when
present. Otherwise the Edge Function tries the saved PAN first and, only when a
valid saved DOB exists, PAN plus DOB second. Missing DOB does not block the
first attempt; the UI suggests adding it only after a password rejection.
The primary onboarding wizard follows the same rule: a returning user whose
PAN-only attempt fails is routed to the Identity step to add DOB, while a
custom-password attempt remains exclusive. Client diagnostics log only
low-cardinality platform, status, reason, and size/timing buckets—never a
filename, exact statement count, raw response, or exception message.

Before any transaction mutation, the shared importer pages the complete existing
history for every affected user fund and builds one provider-neutral reconciliation
plan. Economic groups use fund, date, normalized type, compatible folio, gross cash,
and units. Cash tolerance is the larger of one rupee or 0.2%; unit tolerance is the
larger of 0.0001 units or one part per million. Exact rows, provider split/combined
representations, stored supersets, and provable exact incoming supersets are
idempotent; partial overlap, one-dimensional equality, and ambiguous same-day events
fail closed before catalog, holding, insert, delete, or inactive-state writes.

Reversals first consume one uniquely matching purchase in the incoming statement.
Only when none matches may they select one historical purchase using folio, date,
gross cash, and units when available; deletion is then scoped by exact transaction ID
and fund ID. Cash-only multi-candidate reversals fail closed and never issue a delete.

Postgres preserves genuine identical events with `cas_event_ordinal` and a
`UNIQUE NULLS NOT DISTINCT` race backstop over the full persisted identity. Native
SQLite keys its transaction cache by the already-selected immutable server UUID, so
identical economic rows survive locally while overlapping sync remains idempotent.
The server-only ordinal is absent from client query payloads and React Query keys;
normal transaction insert/delete sync invalidation remains unchanged.

CAS is not an authority for the shared scheme catalog. An import never updates an
existing `scheme_master` row, even when its name, category, or benchmark differs
from the statement. If an AMFI code is missing, the importer may insert only the
validated code, a provisional display name, and `cas_identity_created_at`; category,
benchmark, ISIN, and provider metadata stay null. `sync-fund-meta` includes every
CAS-created row whose `cas_identity_created_at` is set and
`cas_identity_hydrated_at` is still null, obtains canonical AMFI identity
from mfapi, keeps OpenFolio-first/mfdata-fallback metadata precedence, and records
successful identity hydration. The same provider-owned update derives category only
from canonical identity and fills the benchmark pair from `benchmark_mapping`.
Failed identity attempts are timestamped and backed off for 24 hours. Both import
entry points trigger that provider route after creating a provisional identity.

Catalog insertion, user-holding creation, transaction snapshot revalidation, exact
reversal deletes, transaction inserts, and holding activation run in one
service-role-only PostgreSQL transaction. A complete positive closing balance marks
the holding active; a zero balance deactivates only when its latest statement row is
newer than committed history (or no history exists), so an out-of-order statement cannot hide a current
holding. Without a complete balance, committed post-plan transaction history decides.
Any error rolls the whole plan back, so retry begins from either the old state or the
complete new state. Inbound email rejects cross-attachment scheme overlap rather than
merging independent statement multiplicity or closing balances.

Rejected approaches remain rejected:

- **No Gmail OAuth** — persistent inbox access is unnecessary and privacy-hostile.
- **No broker/demat credential integration** — outside current trust and support scope.
- **No direct MFcentral partner API** — requires partner registration and operational commitments.
- **No self-hosted Python parser in Supabase Edge Functions** — Edge Functions are Deno; Python parsing belongs at the Vercel parser boundary.

---

## Financial-data constraints

- **Wrong numbers are worse than slow screens.** Cache, sync, and refactor work over financial inputs needs golden-equivalence fixtures plus garbage-in fixtures for incomplete/corrupt upstream data.
- **Do not make caches authoritative.** Durable source ownership is explicit: Supabase tables, native SQLite raw inputs, and static snapshots each own different layers. React Query output caches are accelerators.
- **Do not add unbounded client persistence.** Raw daily histories and large transaction arrays must stay out of React Query persistence unless the cache inventory is updated with a size and invalidation argument.
- **Keep provider boundaries.** Client code uses `authClient`, `functionsClient`, `storageClient`, and table repos under `src/lib/data/`; direct `supabase` imports outside those wrappers are not allowed.
- **Use server-side observability for silent failures.** Sync/import/freshness functions should emit low-cardinality PostHog events or logs that allow failures to be found without user reports.
