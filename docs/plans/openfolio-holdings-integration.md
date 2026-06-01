# ExecPlan: OpenFolio-Data as the primary holdings source

Status: M1–M4 implemented (backend data path); M5 (UI) follow-up — see Amendments
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

## Amendments (implementation, 2026-05-31 — Milestones 1–4)

Shipped M1–M4 (backend data path) in one PR; M5 (UI) is a noted follow-up. Where the
implementation diverged from the plan above:

- **Two wrappers, not one.** The plan named a single `src/lib/data/composition.ts`. In reality
  OpenFolio is called **server-side only** — from the `openfolio-sync` and `fetch-fund-snapshot`
  edge functions; the app reads its own Postgres at request time. Supabase Edge runs Deno and
  **cannot import from `src/`** (it's excluded from `tsconfig`/`eslint`). So the runtime client +
  pure mapping/matching/precedence + the dependency-injected sync core live in the Deno twin
  `supabase/functions/_shared/openfolio.ts` (Jest-tested to the `_shared/` 100%/100%/80% bar),
  and `src/lib/data/composition.ts` is the app-side typed wrapper — the exit-runbook swap point
  and the documented mock boundary. Both read the same env-var names and mirror the same contract.
- **Contract pinned against the live API** (`openfolio-api-kjnyfwfola-el.a.run.app`, 2026-05-31),
  not assumptions: bulk `GET /v1/composition` returns `{count,page,page_size,items[]}`; auth is
  `X-API-Key` (401 without; `/health` open); `top` limits only sectors/top_holdings.
- **Env var name.** The live `.env.local` uses `OPENFOLIO_API_BASE_URL`; the plan/secret name is
  `OPENFOLIO_API_BASE`. Both wrappers accept either (prefer `OPENFOLIO_API_BASE`). The dev
  **function secret** is set as `OPENFOLIO_API_BASE`.
- **Asset-mix mapping.** OpenFolio breaks out `arbitrage_pct` and `derivatives_pct` separately.
  We fold `arbitrage_pct` into `equity_pct` (matches the existing category_rules convention where
  arbitrage funds are treated as equity) and drop the `derivatives_pct` memo, keeping
  equity+debt+cash+other ≈ 100.
- **Cap-split mapping.** OpenFolio's `cap_mix` (large/mid/small/unclassified) is already "% of
  NAV" — the same convention our mfdata classifier produces — so it maps 1:1, nulls preserved
  (never zero-filled). _(Resolved: an early build returned all-`unclassified` cap buckets;
  OpenFolio populated its ISIN→cap classification on 2026-06-01, so `official` equity rows now
  carry real Large/Mid/Small — verified on dev. The stale all-`unclassified` rows from that window
  were cleared and re-backfilled.)_
- **Write-path precedence.** `official` was added to the "already has holdings data" source sets in
  `sync-fund-portfolios` (both freshness checks) and `fetch-fund-snapshot` (cache check), and a
  35-day `synced_at` recency guard was added to the on-demand official path so it doesn't re-hit
  OpenFolio on every fund pick. mfdata still runs and writes `amfi` rows as backup; the read
  selector guarantees `official` wins.
- **Read-path precedence.** Replaced the fragile alphabetical `source` sort (`'amfi' <
  'category_rules'`, which silently breaks because `'official'` sorts last) with an explicit
  rank in `src/utils/compositionSource.ts` (`pickBestCompositionRows`), used by both
  `usePortfolioInsights.fetchCompositions` and `ClearLensCompareFundsScreen`.
- **Sync scope.** The bulk sync writes `official` rows only for the **active held funds** (the
  `fund` table — same scope as `sync-fund-portfolios`); families touching none of our schemes are
  logged+skipped. Funds nobody holds are hydrated on-demand by `fetch-fund-snapshot` (Compare).
  _(Initially scoped to `scheme_master`, the full ~37.6k AMFI catalog; narrowed to held funds
  during the v2 migration — see below — because matching the catalog against v2's full `plans[]`
  would write ~10k rows and blow the sync wall-clock.)_

### Post-launch hardening (2026-06-01)
Real full-coverage data (50 AMCs, ~2000 schemes) surfaced three issues, all fixed in this PR:
- **Disclosure-date guard.** OpenFolio leaked bond/FMP **maturity** dates into `disclosure_date`
  (`2055-08-18`, then a `2027-05-28`). `isPlausibleDisclosureDate` rejects anything outside
  `[2000-01-01, today]` (no future dates) — bad records are skipped (`skippedBadDate`) and fall
  back to amfi/category, never poisoning the most-recent-date tie-break. (OpenFolio's own
  parser fix is their PR #27.)
- **Pagination + no silent caps.** `PAGE_SIZE` 100→300, `maxPages` 500, plus a `truncated` stat +
  WARN so a coverage cap is never silent.
- **Batched upserts.** One array-upsert per page instead of one per row — a per-row sweep of
  hundreds/thousands of upserts blew the 60s synchronous-invocation gateway timeout (`HTTP 000`)
  and left coverage partial; the batched sweep completes in ~18s.

### v2.0.0 contract migration (2026-06-01) — OpenFolio PR #28
OpenFolio cut a breaking `v2.0.0`: top-level `scheme_code`/`isin` **removed**, replaced by
`family_id` (`OF-`+12hex) + `plans: [{plan_code, plan_name, isins[]}]` (every plan of the shared-
portfolio family). Validated against the live API (resolve by family_id / plan code / plan ISIN;
malformed → 404). Our changes (full plan: `docs/plans/openfolio-v2-contract-migration.md`):
- Types updated (both wrappers); `mapCompositionToRow` unchanged (already keyed by our `schemeCode`).
- `resolveSchemeCode` (one match) → **`resolveSchemeCodes`** (a list): one `official` row per held
  plan code a family covers — so Regular + Direct of the same fund both pre-seed from one bulk item
  (**closes the plan-variant pre-seed gap**, e.g. DSP ELSS Regular).
- **Coordination:** #190 now targets OpenFolio v2.0.0 (live in prod) and must merge in lockstep —
  merging to `main` auto-deploys the edge functions to dev.

### Dev validation (project `imkgazlrxtlhkfptkzjc`)
- Migration applied via `supabase db push` (CLI); `source_url`/`disclosure_date` columns present;
  `cron.job` shows `openfolio-composition-monthly` at `30 1 15 * *` calling `/openfolio-sync`.
- Function secrets `OPENFOLIO_API_BASE` + `OPENFOLIO_API_KEY` set; `openfolio-sync`,
  `fetch-fund-snapshot`, `sync-fund-portfolios` deployed (`--no-verify-jwt`).
- Final `mode:"backfill"` against the full v2 dataset (50 AMCs / ~2000 families): HTTP 200 in ~18s,
  2000/2000 swept, `truncated:false`, `skippedBadDate:0` (post OpenFolio PR #27), 0 failed.
  **34 / 35 held funds carry an `official` row** — the one miss is a *matured* fund OpenFolio
  correctly 404s (falls back to category). Spot checks: real Large/Mid/Small cap splits (a midcap
  index fund reads ~96% mid; Next-50 ~80% large), real debt instruments with provenance URLs,
  sectors + top holdings; both plan variants of a fund pre-seed from one family item;
  `future_dated_rows = 0`; `official` coexists with `category_*` rows (one `official` row per
  scheme — upsert idempotency holds).

### Prod rollout runbook (project `ohcaaioabjvzewfysqgh`) — NOT yet applied

Prod is **untouched**. The prod release tag (`v*`) hasn't been cut and more PRs land first, so the
steps below are deferred and each requires explicit per-change approval at release time. Run them
**in order, from a clean checkout of `main` after this PR merges**:

1. **Migration** — link to prod and push (CLI only, never MCP):
   ```bash
   supabase link --project-ref ohcaaioabjvzewfysqgh --password "$SUPABASE_PROD_DB_PASSWORD"
   supabase db push --linked --password "$SUPABASE_PROD_DB_PASSWORD"   # applies 20260531000000
   ```
   Prereq: prod `public.app_config` already has `supabase_functions_base_url` (every existing cron
   uses it — verify with a read). Verify after: `source_url`/`disclosure_date` columns exist and
   `cron.job` shows `openfolio-composition-monthly` at `30 1 15 * *`.
2. **Function secrets** — same OpenFolio API serves dev + prod, so reuse the same base + key:
   ```bash
   supabase secrets set --project-ref ohcaaioabjvzewfysqgh \
     OPENFOLIO_API_BASE="$OPENFOLIO_API_BASE_URL" OPENFOLIO_API_KEY="$OPENFOLIO_API_KEY"
   ```
3. **Deploy edge functions** (all `--no-verify-jwt`):
   ```bash
   supabase functions deploy openfolio-sync       --no-verify-jwt --project-ref ohcaaioabjvzewfysqgh
   supabase functions deploy fetch-fund-snapshot   --no-verify-jwt --project-ref ohcaaioabjvzewfysqgh
   supabase functions deploy sync-fund-portfolios  --no-verify-jwt --project-ref ohcaaioabjvzewfysqgh
   ```
4. **One-time backfill** — POST the prod function once:
   ```bash
   curl -X POST "$EXPO_PUBLIC_SUPABASE_PROD_URL/functions/v1/openfolio-sync" \
     -H "apikey: $EXPO_PUBLIC_SUPABASE_PROD_PUBLISHABLE_KEY" \
     -H "Authorization: Bearer $EXPO_PUBLIC_SUPABASE_PROD_PUBLISHABLE_KEY" \
     -H "Content-Type: application/json" -d '{"mode":"backfill"}'
   ```
   Verify via read-only MCP: `count(*) where source='official'` > 0, and a spot scheme has real
   debt/sector data. The monthly cron then maintains it (next natural fire: the 15th).

All five prod actions (migration, secrets, deploy, cron, backfill) are gated behind explicit
approval and must not be applied before the prod tag is cut.
