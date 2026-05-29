# Phase 9 M6 — Honest portfolio composition: real market caps + source-tagged fallbacks


## Goal


After this milestone, the **Market cap mix** rows on Compare Funds, Portfolio Insights, and Fund Details show numbers derived from each fund's actual disclosed holdings — not the SEBI category default for its type. Concretely:

- Two Flexi Cap funds in the Compare screen show different splits (Parag Parikh Flexi Cap is heavier on foreign equity → larger "Not classified"; HDFC Flexi Cap is heavier on Indian large caps).
- The Portfolio Insights market-cap donut reflects the *blended* exposure of the actual funds in the portfolio, not the blended category averages.
- When a fund hasn't disclosed enough holdings for us to classify (rare, but possible for new funds, FOFs, or solution-oriented schemes), the screen shows a small "Showing category averages" note instead of pretending the numbers are measured.

The fix lives in the data pipeline, so all three surfaces inherit it automatically. The seeder runs monthly so we stay resilient to AMFI changing its publication cadence.


## User Value


For the user: "comparing funds" finally compares them. A power user picking between Parag Parikh and HDFC Flexi Cap sees a meaningful difference instead of an identical 38/33/29 row that silently undermines trust in the whole screen. When data is genuinely thin, the UI says so instead of fabricating confidence.


For the founder: the most visible "the numbers feel made up" bug on the app goes away before launch. We also pick up two safety nets — a per-row `source` flag and a sector-corruption guard — that catch the next bad data dump silently rather than serving fabricated values to users.


## Context


Investigation on 2026-05-14 traced a user-reported bug: in Compare Funds → Asset mix → Market cap mix, two different funds (Parag Parikh Flexi Cap, HDFC Flexi Cap) showed identical values: 38% Large / 33% Mid / 29% Small.

The root cause is `supabase/functions/fetch-fund-snapshot/index.ts:485-487` and the identical block at `supabase/functions/sync-fund-portfolios/index.ts:282-284`:

    largeCapPct: catRules.large,
    midCapPct: catRules.mid,
    smallCapPct: catRules.small,

`catRules` comes from `getCategoryRules(schemeCategory)`, a hardcoded table of SEBI-category-level approximations. The row for `'flexi cap fund'` is literally `{ large: 38, mid: 33, small: 29 }` — the exact values in the bug screenshot. Every Flexi Cap fund gets stamped with this. Same for every Large Cap fund (80/12/8), every Mid Cap fund (8/75/17), etc.

The mfdata.in `/families/{id}/holdings` endpoint we already call does return per-stock equity holdings (`stock_name`, `isin`, `sector`, `weight_pct`) — we just throw the market-cap dimension away. Every `top_holdings[].marketCap` is also hardcoded to `'Other'` for the same reason. No UI currently renders that field, so it's a silent quality issue rather than a visible bug.

Three downstream surfaces read the bad columns:

| Surface | Read | Render |
| --- | --- | --- |
| Compare Funds | `ClearLensCompareFundsScreen.tsx:204` | `:1147-1200` |
| Portfolio Insights | `usePortfolioInsights.ts:59,164-167` | `ClearLensPortfolioInsightsScreen.tsx:410-418` + `MarketCapCard.tsx` |
| Fund Details | `useFundComposition` (reuses hook) | `app/fund/[id].tsx:1641-1677` |

A wider audit on the same day flagged five related "hardcoded-but-presented-as-real" issues — most are gated by `src/utils/mfdataGuards.ts` at read time, none are as visible as this one. They are explicitly out of scope here and listed at the bottom for follow-up.


## Assumptions


- AMFI publishes a stock-categorization list twice a year (typically Jan and Jul) at https://www.amfiindia.com/research-information/other-data/categorization-of-stocks. The list contains ~750 NSE/BSE ISINs ranked by 6-month average market cap. Top 100 = Large, 101–250 = Mid, 251+ = Small. The page links to the latest `.xlsx`; the URL changes each cycle.
- The same ISIN is used by every mfdata.in disclosed holding (verified spot-check: Parag Parikh's HDFC Bank holding carries `INE040A01034`, the same ISIN AMFI uses). Foreign equities (Alphabet, Amazon) carry blank/non-INE ISINs and are correctly absent from AMFI's list — they belong in "Not classified".
- `fund_portfolio_composition.top_holdings` JSONB already stores up to 50 holdings per fund with their ISIN and weight (`fetch-fund-snapshot/index.ts:469-478`). Backfilling cap percentages from that JSONB is sufficient — we don't need to re-fetch mfdata.
- The Supabase Storage / pg_cron infrastructure used by the other four sync functions (see `docs/architecture/data-sync-pipeline.md`) is available for a fifth function on the same pattern. `pg_net.http_post` works.
- A `source` column already exists on `fund_portfolio_composition` (`'amfi'` for real holdings rows, `'category_rules'` for "no holdings disclosed" rows). Adding a third value `'category_fallback'` for the "had holdings but couldn't classify" case is a content change, not a schema change.


## Definitions


- **AMFI categorization list** — a half-yearly Excel file published by the Association of Mutual Funds in India. Each row is one listed company with its ISIN, name, 6-month average market cap, and rank. Top 100 = Large, 101–250 = Mid, 251+ = Small.
- **ISIN** — International Securities Identification Number. 12-character code uniquely identifying a security. Indian listed equities start with `INE`.
- **Classifier** — pure function that takes a list of `{ isin, weight_pct }` holdings + an `isinToCap` lookup map, returns `{ largeCapPct, midCapPct, smallCapPct, notClassifiedPct }` and an annotated holdings array with each holding's `marketCap` filled in.
- **Category rules** — the existing `CATEGORY_RULES` constant in both portfolio-builder functions. Maps SEBI category (e.g. `'flexi cap fund'`) to a `CategoryComposition` with `equity / debt / cash / other / large / mid / small` defaults. We keep this as a *last-resort* fallback — it stays correct for funds with zero disclosed holdings — but stop using it when we *do* have holdings.
- **Source tagging** — the `fund_portfolio_composition.source` column. Today: `'amfi'` (real holdings from mfdata) or `'category_rules'` (no holdings disclosed). This plan adds `'category_fallback'` for the case where we had holdings but couldn't classify any (e.g. all foreign equity, or AMFI list out of date).
- **"Not classified" row** — UI row in the Market cap mix table, rendered conditionally when at least one column has `notClassifiedPct > 1%`. Surfaces coverage gaps honestly instead of squeezing them into one of Large/Mid/Small.
- **Equity-holdings corruption guard** — `isEquityHoldingsCorrupted(holdings)`, a parallel to the existing `isDebtDataCorrupted` from `_shared/portfolio-utils.ts`. Rejects benchmark-return rows that mfdata sometimes injects into the holdings array (recognizable by numeric `stock_name`, `isin` as a date, or weight > 100%).


## Scope


- New table `stock_market_cap` (ISIN PK, category, rank, classification_period, source, synced_at) + RLS following the `scheme_master` pattern (authenticated SELECT, service-role write).
- New edge function `sync-stock-market-cap` that scrapes the AMFI categorization listing page for the latest `.xlsx`, parses it, and upserts the table. Idempotent (re-runs against the same period are no-ops). Monthly cron `30 0 1 * *` UTC. Deployed with `--no-verify-jwt` to match the other pg_cron-triggered functions; on-demand runs go through the audited `.github/workflows/sync-stock-market-cap.yml` dispatch wrapper.
- New shared helpers in `supabase/functions/_shared/portfolio-utils.ts`:
    - `classifyHoldings(holdings, isinToCap)` — pure, unit-tested.
    - `isEquityHoldingsCorrupted(holdings)` — parallel to the existing debt guard.
    - Type `CapClassification`.
- Wire the classifier into both `buildPortfolio` (in `fetch-fund-snapshot/index.ts`) and `buildPortfolioFromHoldings` (in `sync-fund-portfolios/index.ts`). When the classifier returns zero coverage *and* we had holdings → write `source='category_fallback'`. When we had no holdings at all → keep `source='category_rules'` as today.
- Backfill script `scripts/backfill-stock-market-cap.mjs` that re-runs the classifier against the stored `top_holdings` JSONB for every `source='amfi'` row, updating `large_cap_pct / mid_cap_pct / small_cap_pct / not_classified_pct` and stamping each holding's `marketCap` inside the JSONB.
- Surface a "Not classified" row + fallback footnote on three UI surfaces (Compare, Portfolio Insights' MarketCapCard, Fund Details). The footnote reads roughly: "Showing category averages — fund hasn't disclosed enough holdings yet."
- Regenerate `scripts/seed-demo-user.mjs` so demo accounts don't reintroduce the 38/33/29 pattern.
- **PostHog events + alert thresholds** for every new/changed function — see the **Observability** section below.
- Update `docs/architecture/data-sync-pipeline.md` to add the new edge function to the mermaid diagrams and the function-by-function reference.
- Update `docs/plans/README.md` to list this plan in the active section.


## Observability


All new server-side telemetry uses the existing `trackServerEventAwait` helper at `supabase/functions/_shared/analytics.ts`. Convention from Phase 9 M2: snake_case event names, snake_case properties, `environment` auto-added, `distinct_id='system:<fn-name>'` for cron paths.

**New cron `sync-stock-market-cap` — every run emits exactly one terminal event:**

- Success: `sync_completed` with

        {
          job: 'sync-stock-market-cap',
          classification_period: 'H2-2025',         // parsed from the xlsx
          rows_seen: 752,                            // rows in the spreadsheet
          rows_upserted: 752,                        // rows actually changed
          was_noop: false,                           // true if period already current
          large_count: 100, mid_count: 150, small_count: 502,
          elapsed_ms: 4321,
        }

- Failure: `sync_failed` with

        {
          job: 'sync-stock-market-cap',
          failure_reason: 'fetch_listing_failed' | 'xlsx_link_not_found' | 'fetch_xlsx_failed'
                        | 'parse_failed' | 'sanity_check_failed' | 'upsert_failed',
          first_error: '<truncated to 240 chars>',
          elapsed_ms: 4321,
        }

**Existing cron `sync-fund-portfolios` — extend the wrap-up payload at `sync-fund-portfolios/index.ts:482-494` with classifier metrics:**

        classifier_hit_count: 8421,                  // schemes that resolved to source='amfi' with real cap data
        classifier_fallback_count: 318,              // had holdings but couldn't classify any → 'category_fallback'
        classifier_no_holdings_count: 1240,          // no holdings disclosed → 'category_rules' (unchanged behavior)
        classifier_coverage_pct_avg: 92.4,           // mean of (largeCapPct + midCapPct + smallCapPct) across hit schemes
        equity_corruption_guard_trips: 3,            // rows where isEquityHoldingsCorrupted fired

The event name (`sync_completed` vs `sync_failed`) is unchanged — these are just additional properties on the existing emission.

**On-demand `fetch-fund-snapshot` — new fire-and-forget event per invocation:**

`fund_snapshot_fetched` with

        {
          scheme_code: 122639,
          composition_status: 'fetched' | 'cache_hit' | 'category_rules' | 'failed',
          classifier_outcome: 'amfi' | 'category_fallback' | 'category_rules' | null,
          classifier_coverage_pct: 87.2 | null,
          equity_holdings_count: 42,
          elapsed_ms: 850,
        }

This is the first event ever emitted by `fetch-fund-snapshot`, so the addition is a new wire-up rather than a property tweak. Fire-and-forget (not `await`) so the client response isn't delayed by PostHog.

**PostHog alerts** (configured in the PostHog dashboard after the events land — captured here so the next person to log in knows what's wired):

1. `sync_failed` where `job = 'sync-stock-market-cap'` in the last 7 days → page on-call. The seeder runs monthly, so 7 days of failure means the next run is at risk.
2. `sync_completed` where `job = 'sync-stock-market-cap'` AND `large_count NOT BETWEEN 90 AND 110` → AMFI list almost always contains exactly 100 Large Caps; an outlier value means the parser is reading the wrong column or sheet.
3. `sync_completed` where `job = 'sync-fund-portfolios'` AND `classifier_hit_count / schemes_processed < 0.7` → coverage degraded; AMFI list likely stale or mfdata ISINs dropped.
4. Trailing-7-day rate of `fund_snapshot_fetched` events where `classifier_outcome = 'category_fallback'` exceeding the baseline by 3× → live coverage degradation visible to users.

Thresholds 1 and 2 are page-worthy. Thresholds 3 and 4 are review-on-monday signals.


## Out of Scope


Five related issues turned up in the wider audit. Each is its own PR; each is tracked here so we don't lose them.

| # | Issue | File | Severity | Suggested branch |
| - | --- | --- | --- | --- |
| 1 | CAS importer defaults missing fund-type to `'Flexi Cap Fund'`, wrong benchmark assigned to debt funds | `_shared/import-cas.ts:190-191` | HIGH (user-visible: wrong benchmark) | `fix/cas-benchmark-fallback` |
| 2 | mfdata period returns sign-flip + invalid Sharpe/Sortino/Alpha persisted to DB | `sync-fund-meta/index.ts:226` | MED (gated at read by `mfdataGuards`) | `data/normalise-mfdata-returns` |
| 3 | Beta/R² nonsense for debt funds stored unguarded | same | MED (gated at read) | folded into #2 |
| 4 | Direct-plan launch date stored as `2013-01-01` | mfdata path | LOW (gated at read) | `data/launch-date-derivation` |
| 5 | `raw_debt_holdings` persisted even when corruption guard fires | `sync-fund-portfolios/index.ts:233-244` | LOW (audit only) | folded into equity-guard work |

Per-holding rendering of `marketCap` on the Holdings card (e.g. a "Large Cap / Mid Cap" chip next to each stock) is also out of scope here. The field gets populated correctly by this plan; surfacing it in the UI is a separate design call.


## Approach


The bug is purely in the data pipeline, so the fix is too. The five-step narrative:

1. **Stand up reference data.** Add `stock_market_cap` and the seeder edge function. Run the seeder once locally to populate ~750 rows. This is independently demonstrable (M1) — the rest of the system can ignore the table until we wire it up.

2. **Wire the classifier into the two builders.** Both functions already load `equity_holdings` from mfdata and already write to `fund_portfolio_composition`; the change is a few lines each. Add the `source='category_fallback'` tag for the gap case, and add the equity-corruption guard alongside. M2.

3. **Backfill what's already in the DB.** Most production funds have a `source='amfi'` row already — re-running the classifier against the stored `top_holdings` JSONB is faster and gentler than re-syncing every fund through mfdata. M3.

4. **Surface the truth in the UI.** Two small UI touches: "Not classified" conditional row (the table already has the slot wired in `MarketCapCard.tsx:35`) and a fallback footnote. Three screens, similar text, ~10 lines each. M4.

5. **Document + cron.** Update the data-sync-pipeline doc, register the monthly cron, regenerate demo seed. M5.

The pieces are interlocked (UI assumes classifier exists; backfill assumes table exists), so the order matters — but each milestone leaves the app in a working state and is independently testable.


## Alternatives Considered


- **Skip the new table; use a hardcoded ISIN→category map in the function source.** Rejected: ~750 ISINs is too big for in-code, and the list changes twice a year — committing it forces a code release each cycle. A scheduled seeder is cleaner.
- **Use mfdata.in or another API for per-stock cap classification.** Rejected: mfdata's holdings endpoint doesn't expose cap data, and other providers (e.g. Tickertape) would add an external dependency for data AMFI publishes for free in a stable format. Equivalent quality, more moving parts.
- **Compute on read instead of on write.** Tempting (always reflects the latest list), but every screen reading the data would need the classifier in the client bundle plus a separate fetch for the `stock_market_cap` table. The write-side approach keeps the client simple and matches the existing `fund_portfolio_composition` design.
- **Run seeder twice yearly (matching AMFI's cadence).** Rejected per the user's Q3 — monthly costs nothing (upserts on an ISIN PK are no-ops when nothing changed), and it makes us resilient if AMFI shifts their publish window. The seeder logs `classification_period` so a no-op run is greppable.
- **Bundle the AMFI xlsx as a committed file.** Rejected for the same reason as the hardcoded map — adds release coupling for data we can fetch fresh.


## Milestones


### M1 — Reference data and classifier in place


**Scope.** New table + RLS, seeder edge function, monthly cron, shared classifier + equity-corruption guard, unit tests. No changes to existing portfolio builders yet — they keep writing category defaults.


**Files added.**

- `supabase/migrations/20260514100000_stock_market_cap.sql`

        CREATE TABLE stock_market_cap (
          isin TEXT PRIMARY KEY,
          company_name TEXT NOT NULL,
          market_cap_category TEXT NOT NULL CHECK (market_cap_category IN ('Large Cap','Mid Cap','Small Cap')),
          rank INT,
          avg_market_cap_cr NUMERIC(14,2),
          classification_period TEXT,
          source TEXT NOT NULL DEFAULT 'amfi',
          synced_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE INDEX idx_stock_market_cap_category ON stock_market_cap(market_cap_category);
        ALTER TABLE stock_market_cap ENABLE ROW LEVEL SECURITY;
        CREATE POLICY "stock_market_cap read" ON stock_market_cap FOR SELECT TO authenticated USING (true);
        CREATE POLICY "stock_market_cap write" ON stock_market_cap FOR ALL TO service_role USING (true) WITH CHECK (true);

- `supabase/functions/sync-stock-market-cap/index.ts` — fetches the AMFI listing page HTML, regexes the latest `.xlsx` href, downloads it (max 5 MB, 30 s timeout), parses with the `xlsx` npm package via esm.sh (Deno-compatible), upserts ~750 rows. Returns `{ classification_period, rows_seen, rows_upserted, was_noop }`. Emits `sync_completed` or `sync_failed` PostHog event with the metrics from the Observability section. Deployed with `--no-verify-jwt` so the pg_cron call works without an auth header (consistent with the other cron-triggered functions). Audited on-demand triggers go through `.github/workflows/sync-stock-market-cap.yml`.

- `.github/workflows/sync-stock-market-cap.yml` — workflow_dispatch wrapper that POSTs to the edge function and reports outcome to PostHog. Lets an operator refresh on demand without juggling the service-role key or constructing a curl.

- `.github/workflows/backfill-stock-market-cap.yml` — workflow_dispatch wrapper for `scripts/backfill-stock-market-cap.mjs`. Inputs include `dry_run`, `include_fallback`, `batch_size`, `start_offset` for the operator-knob cases (post-M6 lift, post-AMFI-refresh retry of `category_fallback` rows, resume after failure).
- `supabase/functions/_shared/__tests__/market-cap-classifier.test.ts` — Jest tests for `classifyHoldings` (all-large, mixed, partial-coverage, empty, weights summing <100, case-insensitive ISIN) and `isEquityHoldingsCorrupted` (numeric stock_name, date-like ISIN, weight >100, normal data passes).


**Files modified.**

- `supabase/functions/_shared/portfolio-utils.ts` — add `classifyHoldings` + `isEquityHoldingsCorrupted` + `CapClassification` type. Existing exports unchanged.
- Cron registration (location TBD during impl — likely a new SQL migration or `supabase/config.toml` entry, following whatever `sync-nav` uses): `30 0 1 * *` UTC = 06:00 IST on the 1st.


**Commands.**

    supabase db reset --linked  # apply migration in a local branch
    cd supabase/functions && deno test _shared/__tests__/market-cap-classifier.test.ts
    supabase functions serve sync-stock-market-cap --no-verify-jwt
    curl -X POST http://localhost:54321/functions/v1/sync-stock-market-cap
    psql $LOCAL_DB_URL -c "SELECT market_cap_category, COUNT(*) FROM stock_market_cap GROUP BY 1;"


**Acceptance.**

- Tests green.
- Local seed produces roughly 100 / 150 / 500+ rows by category (exact counts shift each AMFI cycle).
- Re-running the seeder against the same period returns `was_noop: true` and changes no rows.
- Production cron entry visible in `cron.job` table.
- A `sync_completed` PostHog event arrives with `job='sync-stock-market-cap'`, `large_count`, `mid_count`, `small_count`, `classification_period`. Forcing a parse error (e.g. point the fetch at a 404 URL locally) produces a `sync_failed` event with `failure_reason='fetch_listing_failed'`.


### M2 — Classifier wired into both portfolio builders


**Scope.** Both `buildPortfolio` (on-demand) and `buildPortfolioFromHoldings` (cron) load the classifier map once per invocation and use it to compute cap pcts + stamp each holding's `marketCap`. Source-tag `category_fallback` when the classifier returns zero coverage despite having holdings. Equity-corruption guard rejects benchmark rows.


**Files modified.**

- `supabase/functions/fetch-fund-snapshot/index.ts:429-492` — `buildPortfolio` rewritten:
    - Before building, load `SELECT isin, market_cap_category FROM stock_market_cap` once (module-scope cache, TTL 6h).
    - Run `isEquityHoldingsCorrupted` on `equity_holdings` first; if corrupted, fall back as today (`source='category_rules'`).
    - Pass clean holdings to `classifyHoldings`.
    - If `largeCapPct + midCapPct + smallCapPct === 0` (no coverage despite having holdings), tag `source='category_fallback'` and keep `catRules.large/mid/small` for display continuity.
    - Otherwise use classifier output. Stamp each top-holding's `marketCap` from the annotated array.
- `supabase/functions/sync-fund-portfolios/index.ts:211-289` — same change. Load classifier map once per cron run, pass it to `buildPortfolioFromHoldings`.


**Commands.**

    cd supabase/functions && deno test
    # Trigger on-demand snapshot for two flexi-cap funds:
    curl -X POST $LOCAL_FN_URL/fetch-fund-snapshot -d '{"scheme_code":122639}'  # Parag Parikh Flexi Cap
    curl -X POST $LOCAL_FN_URL/fetch-fund-snapshot -d '{"scheme_code":118989}'  # HDFC Flexi Cap
    psql $LOCAL_DB_URL -c "SELECT scheme_code, large_cap_pct, mid_cap_pct, small_cap_pct, not_classified_pct, source FROM fund_portfolio_composition WHERE scheme_code IN (122639, 118989) ORDER BY portfolio_date DESC LIMIT 2;"


**Acceptance.**

- The two Flexi Cap funds show **different** cap splits in the DB.
- Parag Parikh's `not_classified_pct` is non-trivial (>10% expected — foreign equity).
- A debt fund (e.g. `scheme_code=119551`, HDFC Liquid) refreshed via the on-demand path keeps `large_cap_pct/mid_cap_pct/small_cap_pct = 0` and `source='category_rules'` (no equity holdings to classify).
- Existing `portfolio-utils.test.ts` cases still pass — the change is additive.
- `fund_snapshot_fetched` PostHog events appear with `classifier_outcome ∈ {'amfi', 'category_fallback', 'category_rules', null}` and sensible `classifier_coverage_pct` values.
- After a `sync-fund-portfolios` cron run locally, the `sync_completed` event payload includes the four new classifier metric properties (`classifier_hit_count`, `classifier_fallback_count`, `classifier_no_holdings_count`, `classifier_coverage_pct_avg`).


### M3 — Backfill existing rows and demo seed


**Scope.** Backfill historical `source='amfi'` rows in `fund_portfolio_composition` against the stored `top_holdings`. Regenerate `scripts/seed-demo-user.mjs` so demo accounts produce real-looking data.


**Files added.**

- `scripts/backfill-stock-market-cap.mjs` — Node script. Loads `stock_market_cap` once into a Map. Pages `fund_portfolio_composition` rows where `source='amfi'` (batches of 500). For each row: parse `top_holdings` JSONB, run the same `classifyHoldings` logic (TypeScript copied verbatim to JS — small enough to duplicate, kept aligned by a sanity check at the top of the file). Update the four pct columns + write back the holdings array with `marketCap` filled in. Idempotent and resumable.


**Files modified.**

- `scripts/seed-demo-user.mjs:283-285` — drop the hardcoded `large_cap_pct: 38, mid_cap_pct: 33, small_cap_pct: 29` block. Either leave the columns null (next cron run fills them) or call into the classifier directly if the seed needs immediate values.


**Commands.**

    node scripts/backfill-stock-market-cap.mjs --dry-run    # logs intended updates, writes nothing
    node scripts/backfill-stock-market-cap.mjs              # actually writes
    psql $LOCAL_DB_URL -c "SELECT COUNT(*) FILTER (WHERE source='amfi'), COUNT(*) FILTER (WHERE source='category_fallback') FROM fund_portfolio_composition;"
    node scripts/seed-demo-user.mjs                          # regenerate demo user; expect non-flat cap data


**Acceptance.**

- Backfill processes all `source='amfi'` rows without crashing; dry-run + real-run idempotent (no diff on second real run).
- Spot check: Parag Parikh Flexi Cap and HDFC Flexi Cap have different splits in the DB even before any new mfdata sync runs.
- Demo user, when re-seeded, shows distinct cap percentages across its funds.


### M4 — UI surfacing


**Scope.** Three small UI changes — one shared concept (the "category-average" footnote) and one shared row addition (the "Not classified" row).


**Files modified.**

- `src/components/clearLens/screens/tools/ClearLensCompareFundsScreen.tsx`
    - Line 139–141: add `notClassifiedPct: number | null` and `source: string | null` to `CompositionRow`.
    - Line 204: extend the SELECT to include `not_classified_pct, source`.
    - Line 226–228: map both fields.
    - Line 1147: insert a 4th `capRows` entry for "Not classified", rendered only when `compositionsByCode.values().some(c => (c.notClassifiedPct ?? 0) > 1)`.
    - Below the table: render a "Showing category averages …" note when any compared fund's `source` is `'category_rules'` or `'category_fallback'`.
- `src/hooks/usePortfolioInsights.ts:59` — extend the SELECT to include `not_classified_pct, source`. Pass both into `InsightSchemeComposition` (type lives in same file).
- `src/components/insights/MarketCapCard.tsx` — the file already conditionally adds a "Not Classified" row at line 35 (`if (marketCapMix.notClassified > 0.5)`); add the fallback footnote when any contributing fund's `source` is a fallback. Reuses tokens.
- `app/fund/[id].tsx:1641-1677` — add the same conditional "Not classified" row + fallback footnote.


**Commands.**

    npm test       # type check + unit tests
    npm start      # web smoke test on app.foliolens.in


**Acceptance.**

- Compare Funds with Parag Parikh + HDFC Flexi Cap shows differing cap rows. "Not classified" row visible because Parag Parikh has foreign equity.
- Portfolio Insights with a multi-fund portfolio shows a donut that visibly differs from the pre-fix "category-average blend".
- Fund Details for a fund with `source='category_rules'` (e.g. a brand-new scheme with no holdings yet) renders the fallback footnote.
- Fund Details for an `amfi`-source fund renders no footnote and the new cap row only if the not-classified slice is meaningful.


### M5 — Docs, cron, and ship


**Scope.** Final documentation pass and production rollout.


**Files modified.**

- `docs/architecture/data-sync-pipeline.md`
    - Add `sync-stock-market-cap` to the "Where things live" mermaid diagram (new edge function, new external API node for AMFI categorization, new table node `stock_market_cap`).
    - Add a row to the schedule table (monthly, not on the daily/hourly tracks).
    - Add a sequence diagram / function reference at the end of the file in the same style as the other four functions.
- `docs/plans/README.md` — add this plan to the **Active plans** table, branch `claude/fix-market-cap-comparison-e1kWI`.
- This plan file — update the **Decision Log** + check off the **Progress** items as M1-M5 land.


**Commands.**

    # Final regression sweep:
    npm test
    cd supabase/functions && deno test
    # Confirm prod cron entry:
    psql $PROD_DB_URL -c "SELECT * FROM cron.job WHERE jobname = 'sync-stock-market-cap';"
    # Trigger the first prod run manually rather than waiting for the 1st:
    supabase functions invoke sync-stock-market-cap --no-verify-jwt
    # Backfill prod:
    node scripts/backfill-stock-market-cap.mjs --supabase-env=prod


**Acceptance.**

- `docs/architecture/data-sync-pipeline.md` mermaid diagrams render the new function correctly (check via the docs viewer).
- `docs/plans/README.md` lists this plan.
- Production seed + backfill complete; spot-check the two Flexi Cap funds in prod show distinct splits.
- The Compare Funds bug is no longer reproducible in prod.


## Validation


End-to-end demonstration that the bug is fixed:

1. On `app.foliolens.in`, open Tools → Compare Funds.
2. Add **Parag Parikh Flexi Cap — Direct Growth** and **HDFC Flexi Cap — Direct Growth**.
3. Tap the **Asset mix** tab.
4. Confirm the **Market cap mix** rows show different percentages per column.
5. Confirm the "Not classified" row is present and shows a non-trivial value for Parag Parikh (foreign equity).
6. No "Showing category averages" footnote should appear (both funds disclose enough holdings).
7. Open Portfolio Insights with a multi-fund portfolio; confirm the market-cap donut reflects actual holdings.
8. Open a fund with `source='category_rules'` in Fund Details (find one via `SELECT scheme_code FROM fund_portfolio_composition WHERE source='category_rules' LIMIT 1`); confirm the fallback footnote appears.

Backstop checks the user shouldn't have to do but a reviewer should:

- Existing `portfolio-utils.test.ts` cases still pass.
- New `market-cap-classifier.test.ts` cases pass.
- Database state after backfill: roughly 95%+ of `source='amfi'` rows should have `large_cap_pct + mid_cap_pct + small_cap_pct + not_classified_pct ≈ 100`. The remainder (where ISIN coverage is poor) is `source='category_fallback'`.
- Cron run on the 1st of next month: log shows `was_noop: true` if AMFI hasn't published a new period, `rows_upserted: ~750` if they have.


## Risks And Mitigations


- **AMFI changes the page layout or the xlsx schema.** The scraper makes two fragile assumptions: there's an `.xlsx` link somewhere on the listing page, and the spreadsheet has recognizable headers for ISIN / company / category. **Mitigation:** the seeder is "do nothing on parse failure" — it logs and exits non-zero rather than wiping the table. The existing table keeps serving classifications until a human fixes the parser. Add a basic structural assertion at parse time: refuse to upsert if the row count comes out <500 or >1500 (AMFI lists are consistently ~750).
- **mfdata holdings stop returning ISINs.** ISIN is the join key. **Mitigation:** the classifier already handles missing ISIN gracefully (flows into "Not classified"). If coverage drops below 20% on a given fund, the source flips to `category_fallback` and the UI shows the disclaimer. We're already honest about the gap.
- **Backfill is heavy.** Reading + re-writing every `source='amfi'` row is ~12k rows in prod. **Mitigation:** batches of 500, idempotent, resumable. Runs in <2 minutes against staging-shape data.
- **Demo seed regen changes demo behavior visibly.** A demo user opening Insights after this lands sees a different market-cap mix than yesterday. **Mitigation:** this is the desired outcome (the old data was fake). Note in the release log.
- **The "Not classified" row surprises users.** Some users may interpret it as a data quality problem on FolioLens's end rather than a fund-level disclosure gap. **Mitigation:** the row label + footnote together communicate "your fund didn't tell us about this slice", not "we don't know". Revisit copy if support feedback comes in.


## Decision Log


- **2026-05-14 — Monthly cron over twice-yearly.** Twice-yearly is the natural cadence of AMFI's actual publication, but a monthly run is idempotent, costs nothing, and removes "AMFI moved their release date" as a failure mode. The seeder logs `was_noop: true` on duplicate periods, so a noisy log is the only downside.
- **2026-05-14 — PostHog telemetry on every new/changed path.** Threshold-able events (`sync_completed`/`sync_failed` on the new seeder, classifier metrics folded into the existing `sync-fund-portfolios` payload, a new `fund_snapshot_fetched` event on the on-demand path) so AMFI parser regressions and coverage degradation are alertable rather than silent. Alert thresholds documented in **Observability** for the dashboard owner to wire up.
- **2026-05-14 — Source tagging `category_fallback` rather than nulling cap columns.** The columns are non-null in the existing schema, and the UI table renders any null as `—`, which would be a worse user experience than "category-average disclaimer + the old numbers". The tag lets the UI be honest without breaking layout.
- **2026-05-14 — Reuse `top_holdings` JSONB for backfill instead of re-syncing mfdata.** Faster, no external rate-limit risk, deterministic. The JSONB has every field the classifier needs.
- **2026-05-14 — Bundle the equity-corruption guard now, not as a follow-up.** Without it, the classifier is one bad mfdata response away from polluted cap data. The guard is cheap and parallel to the existing debt guard — natural to add alongside.
- **2026-05-14 — Split CAS-import benchmark bug, mfdata return-validation, launch-date fix into follow-up PRs.** They're real, but they live in different code paths and would make this PR unreviewable. Tracked in **Out of Scope** above.


## Progress

- [x] M1 — `stock_market_cap` table + RLS migration applied; `sync-stock-market-cap` edge function shipped; monthly cron registered via migration; classifier + equity-corruption guard unit-tested (18 new tests, 64 total in portfolio-utils passing).
- [x] M2 — `buildPortfolio` and `buildPortfolioFromHoldings` use the classifier; `source='category_fallback'` tagging in place; equity-corruption guard active; PostHog `fund_snapshot_fetched` event emitted on every on-demand snapshot; `sync-fund-portfolios` payload extended with classifier-coverage metrics. Type-check clean, 1037 tests pass.
- [x] M3 — Backfill script `scripts/backfill-stock-market-cap.mjs` ships with dry-run support, idempotent re-runs, and source-flip handling via delete+insert. Demo seed regenerated: hardcoded 38/33/29 dropped, cap pcts now computed from the seed's own top_holdings so demo data exercises the same UI codepath as production.
- [x] M4 — Compare Funds renders the "Not classified" row conditionally + names funds whose cap mix is category-derived. Portfolio Insights' `DonutMixCard` adds the Not Classified slice + uses the existing `disclosure` slot for the disclaimer. Fund Details shows an italic disclosure above the cap bar when `source != 'amfi'`. `CompositionSource` type widened to include `category_fallback`.
- [x] M5 — `docs/architecture/data-sync-pipeline.md` updated with the new function (header count 4→5, mermaid diagrams extended, sequence diagram + observability notes added). `docs/plans/README.md` lists this plan in Active. Production cron + backfill remain to be executed by the operator.


## Amendments


Tracks where the actual implementation diverged from the plan above. Recorded per the `AGENTS.md → Validation Checklist → Documentation` rule so a future reader sees the plan as it was *executed*, not just as it was *drafted*.


- **2026-05-15 — Migration timestamps bumped.** Original plan named `20260514000000_stock_market_cap.sql` and `20260514000001_sync_stock_market_cap_cron.sql`. PR #153 (exit-readiness) merged after this branch opened with a migration at the exact `20260514000000` slot. Renamed mine to `20260514100000` + `20260514100001` (10:00 UTC slot, same day, clearly later in `ls` order). Cron file references the renamed counterpart.
- **2026-05-15 — Deploy flag flipped to `--no-verify-jwt`.** Original plan said deploy `sync-stock-market-cap` with `--verify-jwt` (admin-only). But the `net.http_post` cron call in the registration migration sends no `Authorization` header — same shape as every other cron-triggered function in the project. Deploying with `--verify-jwt` would have broken the monthly cron with 401s. Switched to `--no-verify-jwt`, consistent with `sync-nav` / `sync-index` / `sync-fund-portfolios` / `sync-fund-meta` / `regenerate-index-snapshots`. The audited on-demand path is the new `.github/workflows/sync-stock-market-cap.yml` workflow_dispatch wrapper, not direct curl with the service-role key.
- **2026-05-15 — Two workflow_dispatch wrappers added in scope.** Not in the original plan. Operator setup steps 4 (seed) and 5 (backfill) were "curl with service-role key" / "run Node script with env vars" — both workable but unaudited and clunky. Added:
    - `.github/workflows/sync-stock-market-cap.yml` — POSTs the edge function with env input (dev / prod / both), emits a PostHog `stock_market_cap_dispatch_completed` event with `outcome` + `workflow_run_url`.
    - `.github/workflows/backfill-stock-market-cap.yml` — wraps `scripts/backfill-stock-market-cap.mjs` with env, dry_run, include_fallback, batch_size, start_offset inputs; emits `stock_market_cap_backfill_completed`.
  Mirrors the existing `sync-amfi-portfolios.yml` / `backfill-fund-universe.yml` shape. Both are workflow_dispatch only; pg_cron continues to drive the monthly sync.
- **2026-05-15 — Adapted to conventions introduced after branch open.** PR #151 (explicit Data API grants), PR #153 (data-repo wrappers + `app_user` decouple), PR #156 (test-mocks at wrapper boundary) all merged while this branch was in flight. Confirmed post-rebase that this PR follows each: the new `stock_market_cap` migration adds explicit `GRANT SELECT TO authenticated` + `GRANT ALL TO service_role`; the new `stock_market_cap` table is reference data (no `user_id`) so the `app_user` FK rule doesn't apply; all `supabase.from(...)` call sites in modified screens/hooks route through `fundPortfolioCompositionRepo` (no direct supabase imports added outside the wrappers); new tests are pure-function (no mocks needed). No changes from PR #133 (preview mode) needed — preview fixtures already include `notClassifiedPct` and `source: 'amfi'` per fund, so the new UI rows / disclaimers behave correctly in preview without false positives.

- **2026-05-29 — Post-ship: residual `38/33/29` bug for funds with `scheme_category = 'Equity'` (PR #188).** Two weeks after M6 shipped, a user reported the same magic numbers on DSP Large / Mid / Small / Large & Mid Cap funds. Root cause was *not* in the new classifier path — it was in `getCategoryRules('Equity')` falling through to `GENERIC_CATEGORY_MAP['equity']`, a misnamed flexi-cap proxy hardcoded to `38/33/29`. M6's verification spot-checked Flexi Cap funds (where `scheme_category` is already `'Flexi Cap'` and the proxy is never touched) but didn't cover funds filed under the bare single-word `"Equity"`. Fix added a `deriveSchemeCategoryFromName()` helper that resolves the SEBI sub-bucket from `scheme_name` (longest-pattern-first) before falling through to the proxy, with unit tests for all four DSP cases. See [postmortem](../../postmortems/2026-05-flexicap-proxy-strikes-twice.md) for the missed-it-in-QA story and recommended telemetry / naming follow-ups.
