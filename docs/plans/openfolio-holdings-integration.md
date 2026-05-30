# ExecPlan: OpenFolio-Data as the primary holdings source

Status: Proposed
Date: 2026-05-30
Related: `docs/research/2026-05-29-holdings-source-openfolio-data.md`, OpenFolio-Data repo
(`docs/DEPLOY-SPEC.md`), prior composition research (PRs #56/#67, M12/M13).

## Goal
Make **OpenFolio-Data** (our own MF holdings service, deployed on GCP `asia-south1` with an
authed REST API) the **primary** source for `fund_portfolio_composition`, demoting `mfdata.in`
to a backup/enrichment role and keeping `category_rules` as the final fallback. FolioLens stays
HTTP-only and reads its own Postgres at request time (no runtime dependency on the external API).

## User value
- Truthful, ISIN-bearing equity **and debt** holdings, real sector and large/mid/small splits
  for ~30 AMCs (~93% scheme match), instead of mfdata's null-ISIN / corrupted-debt data.
- Resilience: composition lives in our DB; the external API is touched only by a monthly sync.

## Context (current state)
- `fund_portfolio_composition` (migration `20260420000000`) has: `scheme_code`, `portfolio_date`,
  `equity/debt/cash/other_pct`, `large/mid/small/not_classified_pct`, `sector_allocation` JSONB,
  `top_holdings` JSONB, `raw_debt_holdings` JSONB (added `20260427000000`), `source`
  (`'category_rules'|'amfi'`), `synced_at`, `UNIQUE(scheme_code, portfolio_date, source)`.
- `sync-fund-portfolios` writes `source='amfi'` (mfdata holdings) / `'category_fallback'` /
  `'category_rules'`. The app reads the best available row.
- Both OpenFolio and FolioLens key on **AMFI `scheme_code`** → direct join. ISIN is the secondary.

## Approach

### 1. Schema (one small migration)
- Allow `source='official'` (the column is free-text — no enum change needed; update any code
  comments/validators that hardcode the source set).
- Add provenance columns: `source_url TEXT NULL`, `disclosure_date DATE NULL` (the OpenFolio
  snapshot's disclosure month; `portfolio_date` continues to carry the month-end date).
- `UNIQUE(scheme_code, portfolio_date, source)` already lets `official` rows coexist with
  `amfi`/`category_rules` — no change.
- Follow repo conventions: FK/user rules N/A (reference table), keep RLS (authenticated read,
  service-role write), add explicit GRANTs if any new object. Apply via `supabase db push` from
  a clean checkout (NOT MCP).

### 2. OpenFolio client wrapper (exit-runbook compliant)
- New `src/lib/data/composition.ts` (or `src/lib/openfolio/index.ts`) — the ONLY place that
  knows the OpenFolio base URL + `X-API-Key`. Exposes typed `getComposition(schemeCode)` and
  `listComposition({ updatedSince, page })`. Key + base URL from env / Supabase function secrets
  (`OPENFOLIO_API_BASE`, `OPENFOLIO_API_KEY`). Tests mock at THIS boundary.

### 3. Source precedence (update `sync-fund-portfolios`)
New ladder, highest wins: **`official` (OpenFolio) → `amfi` (mfdata, enrichment/backup) →
`category_fallback` → `category_rules`**. The read path / any "best row" selector must rank
`official` above `amfi`.

### 4. Monthly bulk sync (primary path)
- A cron (pg_cron → HTTP, per repo rule "cron calls an endpoint, no business logic in SQL")
  fires a few days after OpenFolio publishes (OpenFolio ingests on the 13th → schedule FolioLens
  sync ~15th).
- The invoked edge function calls OpenFolio's **bulk** endpoint
  (`GET /v1/composition?updated_since=&page=`) via the wrapper, maps each record to
  `fund_portfolio_composition` columns (asset mix, cap split, `sector_allocation`,
  `top_holdings`, `raw_debt_holdings`, `source='official'`, `portfolio_date`, `disclosure_date`,
  `source_url`), and **upserts** on `(scheme_code, portfolio_date, source)`.
- **Scheme mapping:** join on AMFI `scheme_code`; for OpenFolio rows whose code didn't match
  AMFI (~7%, synthetic), attempt an **ISIN** secondary match against `scheme_master.isin`; skip
  (log) if still unmatched — those schemes keep falling back to `amfi`/`category_rules`.
- Per-record failures logged and skipped; one bad record never aborts the sync. Structured
  `[openfolio-sync]` logs at invocation / fetched / per-page / upserted / completion.

### 5. On-demand path (new funds)
- When a user adds a fund not yet present with `source='official'`, `fetch-fund-snapshot` calls
  the wrapper's `getComposition(schemeCode)` and upserts an `official` row; falls back to the
  existing mfdata/category path if OpenFolio has nothing for it.

### 6. UI / trust
- Surface official debt holdings + real sectors where present. Keep the "trust the numbers" rule:
  rows still backed by `category_rules` must be labeled as category-derived; never present
  estimated splits as disclosed truth. Unknown cap buckets stay `not_classified`, not zero.

## Milestones
1. **Migration + wrapper** — schema additions, OpenFolio client wrapper, secrets wired.
2. **Precedence** — `official` ranked above `amfi` in write + read selection.
3. **Monthly bulk sync** — edge function + pg_cron schedule; one-time backfill for tracked schemes.
4. **On-demand** — `fetch-fund-snapshot` official-first with fallback.
5. **UI** — show official debt/sector detail; labeling for category-derived rows.

## Testing (per repo standards)
- Mock at the wrapper boundary (`@/src/lib/data/composition`), never the supabase module.
- Cover: scheme_code match, ISIN-secondary match, unmatched-skip, precedence (official beats
  amfi beats category), upsert idempotency, malformed/partial API payloads, decimals/rounding.
- >70% overall, >95% for any new util/data-mapping code.

## Validation checklist (before PR)
- `npm run typecheck` (0) · `npm run lint` (0) · `npx jest --coverage` (thresholds hold).
- Migration applied to dev via `supabase db push`; `cron.job` reflects the new schedule.
- Edge function deployed (MCP per repo note) with structured logs; `--no-verify-jwt` if cron-called.
- README "What works now" updated; this plan's Amendments section updated if implementation diverges.

## Risks
- **OpenFolio API/ingest down at sync time** → retry; app keeps last month's rows (monthly,
  non-fatal). Request-time UX unaffected (reads own Postgres).
- **~7% scheme-code gap** → ISIN secondary recovers some; rest stay on mfdata/category (no
  regression vs today).
- **ASN geoblock on OpenFolio's ingest** (their side) could reduce coverage for some AMCs →
  FolioLens simply has fewer `official` rows and falls back; no FolioLens code impact.

## Decision log
- Bulk-sync-into-Postgres over live-API-per-request: resilience + matches the NAV/index pattern
  (cron → own DB; app reads DB).
- Consume via the authed REST API (HTTP-only) rather than parsing the SQLite dump in CI: fits the
  Deno/edge stack and the exit-runbook wrapper model.
