# Data Sync Pipeline — pg_cron + Edge Functions + External APIs

Five edge functions on independent schedules keep prices, scheme metadata, fund composition, benchmark indices, and the AMFI stock market-cap classification list fresh. All are triggered by `pg_cron` via `pg_net.http_post`, all are idempotent (re-running is safe), and most are deployed with `--no-verify-jwt`. `sync-stock-market-cap` is the exception — it's admin-only (`--verify-jwt`) since it changes a reference table that drives downstream classifications across every fund.

## Where things live

```mermaid
graph LR
  subgraph PgCron["pg_cron jobs<br/>(Postgres scheduler)"]
    cron_nav["sync-nav<br/>0 * * * 1-5"]
    cron_index["sync-index<br/>5 * * * 1-5"]
    cron_portfolios["sync-fund-portfolios<br/>10 * * * *"]
    cron_meta["sync-fund-meta<br/>0 2 * * *"]
    cron_caps["sync-stock-market-cap<br/>30 0 1 * *"]
  end

  subgraph EdgeFunctions["Supabase Edge Functions"]
    nav["sync-nav"]
    idx["sync-index"]
    port["sync-fund-portfolios"]
    meta["sync-fund-meta"]
    caps["sync-stock-market-cap"]
  end

  subgraph External["External APIs"]
    mfapi[("api.mfapi.in<br/>(NAV per scheme)")]
    nse[("niftyindices.com<br/>(NSE TRI)")]
    eodhd[("eodhd.com<br/>(historical fallback)")]
    yahoo[("Yahoo Finance<br/>(price-return symbols)")]
    mfdata[("mfdata.in<br/>(fund metadata + AMFI holdings)")]
    amfi[("amfiindia.com<br/>(NAVAll.txt — ISIN map +<br/>stock-categorization xlsx)")]
  end

  subgraph Tables["Postgres tables"]
    t_nav[("nav_history")]
    t_index[("index_history")]
    t_port[("fund_portfolio_composition")]
    t_meta[("scheme_master")]
    t_caps[("stock_market_cap")]
    t_funds[("fund / user_fund<br/>(read sources)")]
    t_bench[("benchmark_mapping<br/>(read source)")]
  end

  cron_nav -- "pg_net.http_post" --> nav
  cron_index -- "pg_net.http_post" --> idx
  cron_portfolios -- "pg_net.http_post" --> port
  cron_meta -- "pg_net.http_post" --> meta
  cron_caps -- "pg_net.http_post" --> caps

  nav -- "for each fund.scheme_code" --> mfapi
  nav -- "upsert" --> t_nav

  idx -- "TRI symbols<br/>e.g. ^NSEITRI" --> nse
  idx -- "fallback / legacy" --> eodhd
  idx -- "price-return symbols" --> yahoo
  idx --> t_bench
  idx -- "upsert" --> t_index

  port -- "category rules<br/>(no external call)" --> t_port
  port -- "AMFI holdings if stale" --> mfdata
  port -- "read for ISIN → cap" --> t_caps
  port --> t_funds

  meta -- "primary metadata" --> mfdata
  meta -- "ISIN fallback" --> mfapi
  meta --> t_funds
  meta -- "upsert" --> t_meta

  caps -- "scrape latest xlsx" --> amfi
  caps -- "upsert" --> t_caps
```

## Schedules + dependency timing

```mermaid
gantt
  title One business-day timeline (UTC)
  dateFormat HH:mm
  axisFormat %H:%M

  section Hourly (weekday)
  sync-nav (00:00 mark)                  :a1, 00:00, 5m
  sync-index (00:05 mark)                :a2, 00:05, 5m

  section Hourly (always)
  sync-fund-portfolios (00:10 mark)      :a3, 00:10, 5m

  section Daily
  sync-fund-meta (02:00 UTC)             :a4, 02:00, 5m
```

There's no explicit fan-out or wait — `sync-index` is scheduled 5 minutes after `sync-nav` so the home-screen "Live" badge has both fresh NAVs and fresh benchmark closes by the time it renders, but neither blocks the other.

`sync-stock-market-cap` runs on its own monthly track at 00:30 UTC on the 1st (not shown — its cadence is monthly, not daily). AMFI publishes the categorization list twice a year, so ~10 of 12 runs are no-ops; the monthly cadence keeps us resilient to AMFI shifting its publication window.

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

Two-layer write order matters: category rules go in *first* so the Insights UI never renders empty, even if every AMFI fetch fails this hour.

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

## sync-stock-market-cap

```mermaid
sequenceDiagram
  participant Cron as pg_cron
  participant Fn as sync-stock-market-cap
  participant DB as Postgres
  participant Amfi as amfiindia.com

  Cron->>Fn: POST (monthly at 00:30 UTC on the 1st)
  Fn->>Amfi: GET /research-information/.../categorization-of-stocks
  Amfi-->>Fn: HTML listing page
  Fn->>Fn: scrape latest .xlsx href + parse classification_period (e.g. H2-2025)
  Fn->>DB: SELECT 1 FROM stock_market_cap WHERE classification_period = :period LIMIT 1
  alt period already loaded
    DB-->>Fn: row exists
    Fn-->>Cron: { was_noop: true, large/mid/small_count, classification_period }
  else new period
    Fn->>Amfi: GET <latest>.xlsx (5 MB cap, 30s timeout)
    Amfi-->>Fn: workbook bytes
    Fn->>Fn: parse with SheetJS — header-aware match (isin / company / category / rank / avg)
    Fn->>Fn: sanity check — 500 ≤ row count ≤ 1500, large_count in [90, 110]
    Fn->>DB: UPSERT stock_market_cap ON CONFLICT (isin) DO UPDATE in chunks of 500
    DB-->>Fn: rows_upserted = ~750
    Fn-->>Cron: { was_noop: false, classification_period, large/mid/small_count, rows_upserted }
  end
```

The `stock_market_cap` table is the source of truth for the ISIN → market-cap lookup that `sync-fund-portfolios` and `fetch-fund-snapshot` join against. Without it, both portfolio builders fall back to SEBI category defaults (the `category_rules` source) — that fallback is correct behaviour (no real-holdings classification possible), but every Flexi Cap fund would carry the same 38/33/29 split, which is the bug Phase 9 M6 fixed.

The seeder is **idempotent** (precheck short-circuits before download when the period is already current) and **strictly additive** — it only ever upserts; rows are never deleted. A failed parse logs a typed `failure_reason` and the table keeps serving the previous period's data until a human fixes the parser.

Observability: every run emits `sync_completed` or `sync_failed` to PostHog with `large_count`, `mid_count`, `small_count`, and `was_noop`. Alert thresholds for the dashboard owner:

- `sync_failed` where `job = 'sync-stock-market-cap'` in last 7 days → page on-call (the seeder runs monthly).
- `large_count NOT BETWEEN 90 AND 110` → parser is reading the wrong column or sheet (Large bucket is consistently exactly 100 in AMFI lists).
- See `docs/plans/phase-9-pre-launch-readiness/M6-honest-portfolio-composition.md` Observability section for the full list including downstream classifier-coverage alerts on `sync-fund-portfolios` and `fund_snapshot_fetched`.

## Why pg_cron + edge functions instead of GitHub Actions

- **Latency.** `pg_net.http_post` from inside Postgres to a Supabase Edge Function on the same project is ~10ms; a GH Actions cron + REST call would be 30-60s round trip.
- **Idempotency keys are tied to DB rows.** The `(scheme_code, nav_date)` conflict key is enforced inside the same transaction the read for `is_active = true` ran in. No skew window.
- **Auth.** Edge functions deployed with `--no-verify-jwt` don't need a service-role key in the cron job; the network boundary itself (Postgres → function over the Supabase internal network) is the auth boundary.

GitHub Actions cron is reserved for jobs that produce git artifacts ([.github/workflows/sync-amfi-portfolios.yml](../../.github/workflows/sync-amfi-portfolios.yml) — pulls AMFI's monthly disclosure CSVs into the repo for fund metadata regression-testing).
