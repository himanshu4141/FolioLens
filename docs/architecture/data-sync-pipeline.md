# Data Sync Pipeline — pg_cron + Edge Functions + External APIs

Edge functions on independent schedules keep prices, scheme metadata, fund composition, and benchmark indices fresh. All are triggered by `pg_cron` via `pg_net.http_post`, all are deployed with `--no-verify-jwt`, and all are idempotent (re-running is safe).

The `sync-stock-market-cap` edge function + monthly cron were **removed in 2026-06-01 (Phase 1)** and the `stock_market_cap` table was **dropped in 2026-06-08 (Phase 2)**. OpenFolio-Data now supplies the per-fund cap split directly via `source='official'` rows. The full deprecation plan is in [`docs/plans/deprecate-post-openfolio.md`](../plans/deprecate-post-openfolio.md).

## Where things live

```mermaid
graph LR
  subgraph PgCron["pg_cron jobs<br/>(Postgres scheduler)"]
    cron_nav["sync-nav<br/>30 0,2,4,6,8,10,12-23 * * *"]
    cron_index["sync-index<br/>5 * * * 1-5"]
    cron_portfolios["sync-fund-portfolios<br/>10 * * * *"]
    cron_meta["sync-fund-meta<br/>0 2 * * *"]
  end

  subgraph EdgeFunctions["Supabase Edge Functions"]
    nav["sync-nav"]
    idx["sync-index"]
    port["sync-fund-portfolios"]
    meta["sync-fund-meta"]
  end

  subgraph External["External APIs"]
    mfapi[("api.mfapi.in<br/>(NAV per scheme — primary)")]
    nse[("niftyindices.com<br/>(NSE TRI)")]
    eodhd[("eodhd.com<br/>(historical fallback)")]
    yahoo[("Yahoo Finance<br/>(price-return symbols)")]
    mfdata[("mfdata.in<br/>(metadata + holdings backup)")]
    amfi[("amfiindia.com<br/>(NAVAll.txt — ISIN map)")]
  end

  subgraph Tables["Postgres tables"]
    t_nav[("nav_history")]
    t_index[("index_history")]
    t_port[("fund_portfolio_composition")]
    t_meta[("scheme_master")]
    t_funds[("fund / user_fund<br/>(read sources)")]
    t_bench[("benchmark_mapping<br/>(read source)")]
  end

  cron_nav -- "pg_net.http_post" --> nav
  cron_index -- "pg_net.http_post" --> idx
  cron_portfolios -- "pg_net.http_post" --> port
  cron_meta -- "pg_net.http_post" --> meta

  nav -- "for each fund.scheme_code" --> mfapi
  nav -- "upsert" --> t_nav

  idx -- "TRI symbols<br/>e.g. ^NSEITRI" --> nse
  idx -- "fallback / legacy" --> eodhd
  idx -- "price-return symbols" --> yahoo
  idx --> t_bench
  idx -- "upsert" --> t_index

  port -- "category rules<br/>(no external call)" --> t_port
  port -- "holdings backup if stale" --> mfdata
  port --> t_funds

  meta -- "metadata backup" --> mfdata
  meta -- "ISIN fallback" --> mfapi
  meta --> t_funds
  meta -- "upsert" --> t_meta
```

## Schedules + dependency timing

```mermaid
gantt
  title One business-day timeline (UTC)
  dateFormat HH:mm
  axisFormat %H:%M

  section sync-nav (bimodal, 7 days)
  EOD window — hourly (12:30→00:30)      :a1a, 12:30, 5m
  Daytime — every 2h (02:30, 04:30, …)   :a1b, 02:30, 5m

  section sync-index (weekday)
  sync-index (every hour at :05)         :a2, 00:05, 5m

  section Hourly (always)
  sync-fund-portfolios (00:10 mark)      :a3, 00:10, 5m

  section Daily
  sync-fund-meta (02:00 UTC)             :a4, 02:00, 5m
```

`sync-nav` runs on a bimodal schedule — hourly during the EOD publish window (6 PM → 6 AM IST, i.e. 12:30 → 00:30 UTC) when AMCs actually push NAVs to mfapi, and every 2 hours during the daytime (8 AM → 5 PM IST, i.e. 02:30 → 10:30 UTC at even hours) to catch late corrections without burning compute on idle hours. Runs every day (not weekday-only) so a Friday-EOD NAV that lands Saturday morning IST gets picked up instead of waiting until Monday. Different AMCs land their NAVs at very different times — HDFC / ICICI / DSP typically hit mfapi within an hour of EOD, while PPFAS and international FoFs can take 4–6 hours longer; the dense EOD window catches both extremes.

`sync-index` still runs hourly weekday-only at `:05`. It no longer co-runs with `sync-nav` (which is at `:30`), but the home-screen NAV stamp + benchmark badge tolerate independent freshness — each is shown with its own "as of …" timestamp.

## sync-nav

```mermaid
sequenceDiagram
  participant Cron as pg_cron
  participant Fn as sync-nav (edge function)
  participant DB as Postgres
  participant API as api.mfapi.in

  Cron->>Fn: POST (no JWT)
  Fn->>DB: SELECT scheme_code FROM fund WHERE is_active = true
  DB-->>Fn: schemes[]
  loop each scheme (parallel, 10s timeout each)
    Fn->>API: GET /mf/{scheme_code}
    API-->>Fn: { data: [{ date: "DD-MM-YYYY", nav: "..." }, ...] }
    Fn->>Fn: normalize date to ISO YYYY-MM-DD
    Fn->>DB: upsert nav_history(scheme_code, nav_date, nav)<br/>conflict on (scheme_code, nav_date)
  end
  Fn-->>Cron: { navRowsUpserted: N }
```

Per-scheme failures don't block siblings. Re-runs are safe because of the conflict key.

## sync-index

```mermaid
sequenceDiagram
  participant Cron as pg_cron
  participant Fn as sync-index (edge function)
  participant DB as Postgres
  participant NSE as NSE TRI
  participant E as EODHD
  participant Y as Yahoo Finance

  Cron->>Fn: POST
  Fn->>DB: SELECT * FROM benchmark_mapping
  DB-->>Fn: symbols[]
  loop each symbol (10s timeout each)
    alt TRI symbol e.g. ^NSEITRI
      Fn->>NSE: getTotalReturnIndexString
      NSE-->>Fn: TRI series
    else legacy or fallback
      Fn->>E: historical OHLC
      E-->>Fn: rows[]
    else price-return symbol
      Fn->>Y: chart endpoint
      Y-->>Fn: rows[]
    end
    Fn->>DB: upsert index_history(symbol, date, close, source)<br/>higher-priority source overwrites lower<br/>conflict on (symbol, date)
  end
  Fn-->>Cron: complete
```

Source priority enforces convergence: if NSE TRI succeeded for `(symbol, date)` later, a Yahoo run for the same row is skipped instead of clobbering it.

## sync-fund-portfolios

```mermaid
sequenceDiagram
  participant Cron as pg_cron
  participant Fn as sync-fund-portfolios
  participant DB as Postgres
  participant Mfd as mfdata.in

  Cron->>Fn: POST
  Fn->>DB: SELECT fund WHERE is_active = true
  DB-->>Fn: funds[]
  Fn->>Fn: layer 1 — apply SEBI category rules<br/>(zero external calls, instant)
  Fn->>DB: upsert fund_portfolio_composition (rules layer)
  loop each fund whose AMFI data is stale
    Fn->>Mfd: GET /api/v1/schemes/{scheme_code}<br/>(10s timeout, single retry on 5xx/429)
    Mfd-->>Fn: AMFI monthly holdings
    Fn->>DB: upsert fund_portfolio_composition (AMFI layer)
  end
  Fn-->>Cron: complete
```

Two-layer write order matters: category rules go in *first* so the Insights UI never renders empty, even if every mfdata fetch fails this hour.

> **Note on `getCategoryRules()` caller contract:** if `scheme_category` is the bare single word `"Equity"` (DSP funds, half the ICICI Prudential lineup, etc.) the lookup falls to `GENERIC_CATEGORY_MAP['equity']`, a flexi-cap proxy (38/33/29). PR #188 added `deriveSchemeCategoryFromName()` to rescue the sub-bucket from the scheme name. **Any call to `getCategoryRules()` MUST pass `scheme_name` as the second argument** — without it the proxy bug silently returns a wrong cap split for any fund whose category is generic. See the [post-flexicap-proxy postmortem](../postmortems/2026-05-flexicap-proxy-strikes-twice.md).

## sync-fund-meta

```mermaid
sequenceDiagram
  participant Cron as pg_cron
  participant Fn as sync-fund-meta
  participant DB as Postgres
  participant Mfd as mfdata.in
  participant Mf as api.mfapi.in

  Cron->>Fn: POST (daily at 02:00 UTC)
  Fn->>DB: SELECT scheme_code FROM user_fund<br/>JOIN scheme_master ON ...<br/>WHERE last_synced_at older than 7 days
  DB-->>Fn: stale schemes[]
  loop each stale scheme
    Fn->>Mfd: GET metadata
    alt mfdata has it
      Mfd-->>Fn: { expense_ratio, aum, isin, family_id, benchmark, rating }
    else fallback for ISIN only
      Fn->>Mf: GET /mf/{scheme_code}
      Mf-->>Fn: { isin }
    end
    Fn->>DB: upsert scheme_master + UPDATE last_synced_at
  end
  Fn-->>Cron: { updated: N }
```

`META_STALE_DAYS = 7` keeps mfdata.in calls cheap on most days — only schemes whose users joined recently or whose data aged out get re-pulled.

### period_returns blob — normalise at write, merge semantics

`scheme_master.period_returns` is written by two sources:

| Source | Keys written | Format |
|--------|-------------|--------|
| OpenFolio (sync-fund-meta OF path) | `ret_1y`, `ret_3y`, `ret_5y`, `ret_incep` | decimal CAGR (0.125) |
| mfdata backup (sync-fund-meta + fetch-fund-snapshot) | `ret_1m`, `ret_3m`, `ret_6m`, `ret_1y`, `ret_3y`, `ret_5y`, `ret_incep`, `rank_*`, `as_of_date` | decimal CAGR after normalisation (converted from mfdata's percent at write time) |

Both writers use helpers from `supabase/functions/_shared/period-returns.ts`:
- **`mergeMfdataReturns(mfdataBlob, existingBlob)`** — converts mfdata percent returns to decimal, then spreads the existing blob on top (existing values win). This preserves OF's precise values when mfdata runs after OF.
- **`mergeOfReturns(ofValues, existingBlob)`** — spreads existing blob first, then OF values on top (OF wins). This preserves mfdata's extra horizons (1m/3m/6m/ranks) when OF runs after mfdata.

**29 legacy mfdata-shape rows** (percent format, `return_1y` keys) exist on dev as of 2026-06-10. `readReturnPct` in `src/utils/mfdataGuards.ts` handles both shapes at read time and will continue to do so until all rows are refreshed by a cron run. This is `[cache-shape-stable]` — the client code returns identical percentage values regardless of which shape is stored.

## Why pg_cron + edge functions instead of GitHub Actions

- **Latency.** `pg_net.http_post` from inside Postgres to a Supabase Edge Function on the same project is ~10ms; a GH Actions cron + REST call would be 30-60s round trip.
- **Idempotency keys are tied to DB rows.** The `(scheme_code, nav_date)` conflict key is enforced inside the same transaction the read for `is_active = true` ran in. No skew window.
- **Auth.** Edge functions deployed with `--no-verify-jwt` don't need a service-role key in the cron job; the network boundary itself (Postgres → function over the Supabase internal network) is the auth boundary.

GitHub Actions cron is reserved for jobs that produce git artifacts ([.github/workflows/sync-amfi-portfolios.yml](../../.github/workflows/sync-amfi-portfolios.yml) — pulls AMFI's monthly disclosure CSVs into the repo for fund metadata regression-testing).

**Retired (2026-06-10):** `backfill-fund-universe.yml` + `scripts/backfill-fund-universe.mjs` — the pre-OpenFolio nightly workflow that pre-seeded the full ~37k AMFI universe with metadata, `source:'amfi'` composition rows, and full NAV history.  It was superseded by the `universe-backfill` Edge Function (OpenFolio composition + metadata for the full universe) and the on-pick `fetch-fund-nav` path (NAV history for non-held schemes).  The four workflow-state columns it tracked (`last_backfill_attempted_at`, `backfill_outcome`, `backfill_failure_count`, `is_inactive`) were dropped from `scheme_master` by migration `20260610000000`.  See [`docs/plans/deprecate-post-openfolio.md`](../plans/deprecate-post-openfolio.md) Phase 5 for the full rationale.
