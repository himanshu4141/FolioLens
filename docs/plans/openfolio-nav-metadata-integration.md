# ExecPlan: consume OpenFolio-Data for NAV (A) + fund metadata (B1)

Status: Proposed
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

### FL-P4 changes
1. **`sync-nav`**: source NAV for held schemes from OpenFolio's NAV API
   (`GET /v1/nav?since=` delta, or per-held-scheme), upsert `nav_history`; **mfapi.in becomes the
   fallback** if OpenFolio returns nothing for a scheme. Keep the existing hourly cron cadence.
2. **`sync-fund-meta`**: pull AUM + returns/volatility from OpenFolio into `scheme_master`
   (`aum_cr`, period_returns, risk_ratios); mfdata.in → backup.
3. **Scheme registry**: optionally enrich `scheme_master` (category/AMC/ISIN) from OpenFolio's registry;
   the existing `sebi_category` work stays, with OpenFolio as an authoritative source/backstop.
4. **Wrapper**: extend the existing `_shared/openfolio.ts` + `src/lib/data/composition.ts` pattern with
   `nav`/`metadata` clients (sole owners of base URL + key). Tests mock at this boundary.

### FL-P5 changes
5. **`sync-fund-meta`**: add TER, fund_manager, exit_load, min_*, declared_benchmark, riskometer from
   OpenFolio's bulk metadata endpoint; mfdata.in → backup. Honor honest nulls (don't backfill zeros).
6. **UI**: drop/relabel star rating; surface official TER/manager/benchmark + our computed returns/risk.

### Scheme mapping
AMFI `scheme_code` is the shared key (both sides) → direct join. For OpenFolio rows unmatched by code,
try **ISIN** vs `scheme_master.isin`; otherwise skip (log) and fall back to mfapi/mfdata.

### Cron
Reuse the cron→edge-fn→Postgres pattern. NAV stays on the existing hourly `sync-nav`. Metadata/AUM/returns
fold into the existing daily `sync-fund-meta` (or a monthly pass aligned to OpenFolio's monthly rebuild).

## Milestones
1. NAV wrapper + `sync-nav` OpenFolio-first (mfapi backup) + verify held-fund NAV parity on dev.
2. `sync-fund-meta` AUM + returns/risk from OpenFolio; mfdata backup.
3. Registry enrichment (optional) for category/AMC/ISIN.
4. (FL-P5) TER + manager + exit load + mins + benchmark + riskometer; mfdata backup.
5. (FL-P5) UI: drop ratings, surface official metadata + computed metrics.

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
- **NAV volume**: per-held-scheme pulls are fine; a full-universe NAV mirror in FolioLens is unnecessary —
  keep FolioLens NAV scoped to held + on-demand-compared schemes.
- **OpenFolio down at sync time** → fall back to mfapi/mfdata; app unaffected (reads own Postgres).
- **TER name-match gaps** on OpenFolio's side → some funds lack TER → backup to mfdata or show "unavailable".
- **Dropping ratings** is a visible UI change → confirm product is OK replacing star rating with our metrics.

## Decision log
- A and B1 routed through OpenFolio for the same reasons as B2 (resilience, ISIN-keyed authoritative data,
  decoupled at runtime). mfapi/mfdata retained as backups, not removed.
- Ratings dropped — no free authoritative source; our computed risk/return replaces them.
