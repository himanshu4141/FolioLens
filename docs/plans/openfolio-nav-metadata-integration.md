# ExecPlan: consume OpenFolio-Data for NAV (A) + fund metadata (B1)

Status: Shipped (M1 #193, M2 #194, M3/M5/M6 #195)
Date: 2026-06-01
Related: `docs/plans/openfolio-holdings-integration.md` (B2, shipped), OpenFolio-Data
`docs/SPEC-PHASE-4-*` (NAV + AUM + returns) and `docs/SPEC-PHASE-5-*` (TER/manager/etc).

## Goal
Extend the OpenFolio-as-primary model from holdings (B2, done) to **NAV + scheme registry (Domain A)**
and **fund metadata (B1)**. mfapi.in (NAV) and mfdata.in (metadata) **demote to backup**. As with B2,
FolioLens reads its **own Postgres** at request time — OpenFolio is touched only by sync jobs, so the
app never depends on OpenFolio uptime.

## Phasing (mirrors OpenFolio's)
- **FL-P4** (after OpenFolio Phase 4): consume **NAV + AUM + computed returns/risk** + scheme registry.
- **FL-P5** (after OpenFolio Phase 5): consume **TER, fund manager, exit load, mins, benchmark, riskometer**.
- **Star ratings: dropped.** Remove/relabel `morningstar_rating` in UI; show our own risk/return instead.

## Approach

### Source precedence (per field)
| Field | Primary | Backup |
|---|---|---|
| NAV (`nav_history`) | **OpenFolio** (AMFI-sourced) | mfapi.in (`sync-nav`) |
| Scheme registry / `sebi_category`, AMC, ISINs | **OpenFolio** registry | mfapi list + existing parser |
| AUM, returns (1/3/5y), volatility | **OpenFolio** (computed) | mfdata.in |
| TER, fund manager, exit load, mins, benchmark, riskometer | **OpenFolio** (official) | mfdata.in |
| Star rating | — (dropped) | — |

> Rows 3–4 are **one `FundMetadata` object** from **one endpoint** (`/v1/metadata`): metrics
> (AUM/returns/volatility) are nested under `metrics`, B1 fields sit alongside. One wrapper, one sweep.

### As-built contract notes (verified against OpenFolio `docs/openapi.yaml` v2.0.0 on main, 2026-06-07)
These firm up the plan against the shipped API; they supersede looser wording below.

- **Endpoints**: NAV — `GET /v1/nav/{scheme_id}` (series, `since`/`until`), `/v1/nav/{scheme_id}/latest`,
  `/v1/nav?date=|since=` (bulk paginated `NavBulkPage`). Metadata — `GET /v1/schemes/{scheme_id}/metadata`
  (single `FundMetadata`) and `GET /v1/metadata?updated_since=` (bulk paginated `MetadataPage`).
  Registry — `GET /v1/schemes?amc=&category=&q=` (family-keyed `SchemeListResponse`).
- **Identity is split** — the key correction to "Scheme mapping" below:
  - **NAV and metadata are plan-keyed by integer `scheme_code`** (the AMFI plan code) → **direct join**
    to FolioLens `scheme_master.scheme_code` (`NavBulkItem.scheme_code`, `FundMetadata.scheme_code`).
  - **Composition/registry are family-keyed** (`family_id` + `plans[]`) → expand `plans[]` to a row per
    held plan code. **Reuse B2's `resolveSchemeCodes`** (in `_shared/openfolio.ts`); do not re-derive.
- **One metadata object, one endpoint**: AUM + returns + volatility live under `FundMetadata.metrics`
  **in the same object** as B1 fields. FL-P4 (metrics) and FL-P5 (B1) consume **one `/v1/metadata`
  wrapper + one `sync-fund-meta` sweep**, sequenced only by which columns each phase writes.
- **`b1_field_meta[field].status` drives the per-field backup decision**:
  - `value` → write OpenFolio's value (primary wins).
  - `officially_absent` / `not_applicable` → genuine null → show "unavailable" (honest null); do **not**
    silently overwrite an absence with mfdata.
  - `unresolved` / `parse_failed` / `source_failed` → OpenFolio tried and couldn't → **fall back to
    mfdata** (transient/extraction gap). This is the precise mfdata trigger, replacing "honor nulls".
- **Units**: `metrics.returns.ret_*` are **decimals** (CAGR; `0.125` = 12.5%); `volatility` is annualised
  σ. Convert on write to FolioLens's stored convention — do not ×100 blindly.
- **Fields**: `min_investment` and `min_sip` are **separate**; `exit_load` is free-text; also
  `portfolio_turnover` (number), `riskometer` (string), `ter`+`ter_date`, `inception_date`, `benchmark`.
- **`updated_since` typing**: `/v1/metadata` takes an **ISO-8601 datetime**; `/v1/composition` takes a
  **date**. Type the two wrapper params accordingly.
- **Auth + config**: X-API-Key on all but `/health`; **reuse the existing `OPENFOLIO_API_BASE` /
  `OPENFOLIO_API_KEY` secrets and the existing wrapper** (already set for B2). **No new secrets or infra.**
- **Coverage ceiling** (OpenFolio, 2026-06-03): holdings 96.4%, metadata 99.9%, both 97.7% adjusted.
  Size the mfdata-backup + "unavailable" paths to ~0.1–4% of the universe, not 0.

### FL-P4 changes
1. **`sync-nav`**: source NAV for held schemes from OpenFolio's NAV API
   (`GET /v1/nav?since=` delta, or per-held-scheme `GET /v1/nav/{scheme_code}` — `scheme_code` joins
   directly), upsert `nav_history`; **mfapi.in becomes the fallback** if OpenFolio returns nothing for a
   scheme. Keep the existing hourly cron cadence.
2. **`sync-fund-meta`** (single sweep over `/v1/metadata`): pull `metrics` (AUM + returns/volatility)
   into `scheme_master` (`aum_cr`, period_returns, risk_ratios); mfdata.in → backup per the
   `b1_field_meta.status` rule above.
3. **Scheme registry**: optionally enrich `scheme_master` (category/AMC/ISIN) from OpenFolio's registry;
   the existing `sebi_category` work stays, with OpenFolio as an authoritative source/backstop.
4. **Wrapper**: extend the existing `_shared/openfolio.ts` + `src/lib/data/composition.ts` pattern with
   `nav`/`metadata` clients (sole owners of base URL + key, reusing the existing creds). Mock at this
   boundary.

### FL-P5 changes
5. **`sync-fund-meta`**: in the same sweep, add TER, fund_manager, exit_load, min_investment, min_sip,
   benchmark, riskometer, portfolio_turnover from the `FundMetadata` B1 fields; mfdata.in → backup per
   the `status` rule (honest nulls for `officially_absent`/`not_applicable`).
6. **UI**: drop/relabel star rating; surface official TER/manager/benchmark + our computed returns/risk.

### Scheme mapping
**NAV + metadata**: OpenFolio's integer `scheme_code` **is** the AMFI plan code → direct join to
`scheme_master.scheme_code`. **Composition + registry**: family-keyed → expand `plans[]` (plan_code,
then ISIN vs `scheme_master.isin`) via the existing `resolveSchemeCodes`; unmatched families are skipped
(logged) and fall back to mfapi/mfdata.

### Cron
Reuse the cron→edge-fn→Postgres pattern. NAV stays on the existing hourly `sync-nav`. Metadata/AUM/returns
fold into the existing daily `sync-fund-meta` (or a monthly pass aligned to OpenFolio's monthly rebuild).

## Milestones
1. NAV wrapper + `sync-nav` OpenFolio-first (mfapi backup) + verify held-fund NAV parity on dev.
2. `sync-fund-meta` AUM + returns/risk from OpenFolio; mfdata backup.
3. Registry enrichment (optional) for category/AMC/ISIN.
4. (FL-P5) TER + manager + exit load + mins + benchmark + riskometer; mfdata backup.
5. (FL-P5) UI: drop ratings, surface official metadata + computed metrics.
6. **(FL-P6, final step) Full AMFI-universe backfill — for performance.** Once held-fund sync is proven,
   backfill **composition + metadata + computed returns + scheme registry for *every active scheme in the
   AMFI universe*** (not just held funds) from OpenFolio's bulk endpoints (`/v1/composition`,
   `/v1/metadata`, `/v1/schemes`) into FolioLens Postgres — so tools like **Compare** read everything
   locally with **no on-demand `fetch-fund-snapshot` hydration latency**. One-time bulk job, then kept
   current by the monthly sync. **NAV history stays held-scoped + on-demand** (the heavy 20M-row series;
   Compare needs composition + returns + metadata, not NAV history — all of which this backfills). Holding
   the extra reference rows is a small, accepted price for tool performance. **Skip `code_source:
   synthetic`** rows — those are placeholder codes (not real AMFI codes) and can't be joined to held
   funds; only `amfi_navall` / `hardcoded` codes backfill. Expect ~96% composition / ~99.9% metadata
   coverage of the active universe (OpenFolio's ceiling); the remainder stays "unavailable" until covered.

## Testing (per repo standards)
- Mock at the wrapper boundary (`@/src/lib/data/*`), never supabase/network.
- Cover: OpenFolio-hit vs mfapi/mfdata-fallback, scheme_code vs ISIN match vs unmatched-skip, precedence,
  NAV upsert idempotency, decimals/rounding, honest-null handling (no zero-fill).
- ≥70% overall, ≥95% on new util/mapping code.

## Validation checklist (before PR)
- `npm run typecheck` (0), `npm run lint` (0), `npx jest --coverage` (thresholds hold).
- Migrations (if any new columns) applied to **dev** via `supabase db push` (never MCP DDL, never prod
  without per-change approval); `cron.job` reflects any schedule change.
- Edge functions deployed to dev (MCP, `../_shared`→`./_shared`); structured `[openfolio-nav]` /
  `[openfolio-meta]` logs; `--no-verify-jwt` for cron-called.
- README "What works now" updated; Amendments added if implementation diverges.

## Risks
- **Universe backfill volume (FL-P6)**: mirroring **composition + metadata + returns** for the full active
  AMFI universe (~10–14k schemes) is modest and *intended* — it's what removes Compare's on-demand
  latency. **NAV history is the exception** — keep it held-scoped + on-demand (a full 20M-row NAV mirror is
  unnecessary and heavy; Compare doesn't use NAV history).
- **OpenFolio down at sync time** → fall back to mfapi/mfdata; app unaffected (reads own Postgres).
- **TER name-match gaps** on OpenFolio's side → some funds lack TER → backup to mfdata or show "unavailable".
- **Dropping ratings** is a visible UI change → confirm product is OK replacing star rating with our metrics.

## Decision log
- A and B1 routed through OpenFolio for the same reasons as B2 (resilience, ISIN-keyed authoritative data,
  decoupled at runtime). mfapi/mfdata retained as backups, not removed.
- Ratings dropped — no free authoritative source; our computed risk/return replaces them.
- **Full AMFI-universe backfill (FL-P6)** chosen over held-only sync: Compare/tools must read locally to
  avoid `fetch-fund-snapshot` hydration latency on unheld funds. Extra reference rows are an accepted cost.
  (Supersedes the earlier "don't mirror the full universe" stance — that applied to NAV history, which is
  still scoped; composition/metadata/returns are now mirrored universe-wide.)

## Amendments

### M3 — Registry enrichment (PR #195)

Implemented without an additional API call: `upsertSchemeRegistry` extracts `sebi_category` and `amc` from the composition page already being fetched in `runOpenFolioSync`, using a new optional dep. The separate `/v1/schemes` registry endpoint (originally planned as the source) was not needed.

`upsertSchemeRegistry` implementation extracted to `_shared/registry-upsert.ts` (shared between `openfolio-sync` and `universe-backfill`) rather than duplicated per function.

### M4 — Absorbed into M2

All B1 fields (TER, fund_manager, inception_date, exit_load, min_investment, min_sip, benchmark, riskometer, portfolio_turnover) were implemented in M2's `sync-fund-meta` sweep, so M4 had no separate deliverable. The plan's "one sweep" design was already followed.

### M5 — UI (PR #195)

`declared_benchmark_name` display falls back to `benchmark_index` (existing mfdata column) for the transition window before `sync-fund-meta` re-populates OF values. The fallback chain is: `declaredBenchmarkName ?? benchmarkIndex ?? '—'`.

`periodReturns` prop kept as `unknown` in both `FundDetailData` and `TechnicalDetailsCard` (Supabase's `Json` type doesn't carry a string index signature, so narrowing at the data layer cascades cast errors). Narrowing is handled inside `readReturnPct` which guards all non-object/non-finite inputs.

`fmtReturn` moved to module level (outside the component) per review feedback.

### M6 — Universe backfill (PR #195)

No separate `pg_cron` schedule added — this is a one-time manual trigger, then monthly `openfolio-sync` (composition) and daily `sync-fund-meta` (held-fund metadata) keep it current.

Known tradeoff documented in function header: the metadata phase stamps `openfolio_meta_synced_at` on every matched row, which causes `sync-fund-meta`'s `isSchemeMetaFresh` check to defer mfdata fallback for newly-held funds up to 7 days after the backfill. Manual `sync-fund-meta` trigger resolves this if immediate mfdata coverage is needed.

`resolveB1` local function intentionally diverges from `resolveB1Field` (`null` vs `undefined` sentinel) — no mfdata fallback path in the backfill; divergence documented in-code.
