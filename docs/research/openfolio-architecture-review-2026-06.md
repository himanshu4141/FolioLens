# FolioLens ↔ OpenFolio-Data Architecture Review — v2 (2026-06-10)

Research-only review of the **current development environment** on the
**current `main`** of both repos. Supersedes the v1 draft (which was produced
against a pre-#191 snapshot). No code, migrations, or PRs other than this doc.

**Scope decisions (per Himanshu):**
- Production drift is **intentional** (no prod deploy for ~1 month; dev-first
  stabilisation before a coordinated prod release). Prod is ignored below
  except where it constrains dev work.
- Baselines: FolioLens `main` @ `e34683a` (#191), OpenFolio-Data `main` @
  `0bc8842` (#52). Both fetched 2026-06-10.
- All merged PRs since 2026-05-01 reviewed (FolioLens #156–#195,
  OpenFolio-Data #32–#52). Live-DB evidence from dev
  (`imkgazlrxtlhkfptkzjc`), read-only queries, 2026-06-10.

---

## 1. Executive summary

Dev is in better architectural shape than the v1 report implied — #190–#195
landed the OpenFolio-first source ladder coherently, and #191 already deleted
most of the dead weight v1 flagged (stock_market_cap, ISIN→cap classifier,
morningstar_rating, related_variants). What's actually broken is small and
specific:

1. **(P0, broken)** The dev `sync-nav-hourly` pg_cron job has failed on every
   run since ~June 6 — the bimodal-schedule migration references a Postgres
   GUC that doesn't exist on dev. Held funds' NAV is frozen at **2026-06-05**.
   This alone explains "app doesn't show latest NAV".
2. **(P0, broken)** Even with a healthy cron, a cold app launch can paint
   stale NAV: the SQLite bootstrap inserts fresh rows *after* screens
   computed from stale rows, and never invalidates React Query.
3. **(P1, tech debt actively causing harm)** The pre-OpenFolio GitHub-Actions
   universe backfill still runs nightly against dev: it writes mfdata-shaped
   metadata, `source='amfi'` composition rows (a tag #191 just retired), and
   **full mfapi NAV history** for ~170 schemes/night. It is the author of the
   1.6 GB `nav_history` (8.8M rows, 98.8% for funds nobody holds) and the
   Supabase usage notice. Its runs have died at the 60-min timeout every
   night since June 2 — it is partially failing *and* still growing the table.
4. **(P1, broken-by-design)** The OpenFolio `universe-backfill` edge function
   cannot finish its job (fire-and-forget in a ~150 s isolate for a 2–5 min
   sweep; silent abort on one bad page). Result: only **675 of 37,595**
   scheme_master rows have OpenFolio metadata — which is most of why Compare
   still shows "—" for arbitrary funds. OpenFolio-Data itself now covers
   99.9 % metadata / 96.4 % holdings of the active universe, so this is
   entirely a FolioLens-side completion problem.
5. **(Intentional, keep)** Held-scoped NAV, the 37k scheme_master seed,
   SQLite-first reads, the duplicated Deno/app OpenFolio client, local
   computation of Compare metrics (mfdata's numbers were proven wrong), and
   prod drift are all deliberate and should not be "cleaned up" — they should
   be finished (universe metadata) or guarded (client freshness).

**Single most valuable sequence:** fix the cron (one migration), fix the
bootstrap invalidation (a few lines + tests), retire the GH backfill, ship a
chunked resumable OpenFolio backfill, then delete the orphan NAV rows. That
takes dev from "stale NAV + sparse Compare + runaway table" to launch-ready
on data correctness.

---

## 2. Previous report validation

| # | v1 finding | Verdict | Evidence (re-checked on main + live dev) | Confidence |
|---|---|---|---|---|
| 1 | Dev `sync-nav-hourly` fails every run (`current_setting('app.supabase_functions_base_url')` GUC missing) | **Confirmed** | `cron.job` command still uses `current_setting`; 18 failed runs in last 24 h; held max `nav_date` = 2026-06-05; all sibling jobs use `public.app_config_get`. Introduced by [20260528000000_sync_nav_bimodal_schedule.sql](../../supabase/migrations/20260528000000_sync_nav_bimodal_schedule.sql) (predates the OpenFolio PRs; not caused by them) | High (live-verified today) |
| 2 | Cold-launch bootstrap never invalidates React Query → stale NAV on first paint | **Confirmed** | `runBootstrap` ([app/_layout.tsx:198-227](../../app/_layout.tsx#L198-L227)) awaits `bootstrapForUser` with no `invalidateQueries`; the only invalidation paths are AppState-foreground ([_layout.tsx:314-327](../../app/_layout.tsx#L314-L327), never fires on process launch — acknowledged in [src/lib/db/sync.ts:246-260](../../src/lib/db/sync.ts#L246-L260)) and pull-to-refresh ([ClearLensPortfolioScreen.tsx:942-961](../../src/components/clearLens/screens/ClearLensPortfolioScreen.tsx#L942-L961)). NAV reads are SQLite-first with fallback only when local rows are *empty* ([usePortfolio.ts:157-184](../../src/hooks/usePortfolio.ts#L157-L184)) | High (code-level; runtime repro pending cron fix) |
| 3 | GH Actions backfill writes full-universe NAV nightly | **Confirmed — and worse than v1 said** | Workflow still scheduled (18:00 UTC daily, dev-targeted). Run history: success May 26–Jun 1, then **every run since Jun 2 killed by `timeout-minutes: 60`** (conclusion "cancelled") — but writes land progressively, so `scheme_master.last_backfill_attempted_at` shows ~165–185 schemes touched *every* night through Jun 9. Script still writes pre-#191 shapes: `source:'amfi'` (line 257), mfdata `returns`/`ratios` blobs, `morningstar` handling. [scripts/backfill-fund-universe.mjs](../../scripts/backfill-fund-universe.mjs), [.github/workflows/backfill-fund-universe.yml](../../.github/workflows/backfill-fund-universe.yml) | High (live run history + DB stamps) |
| 4 | `universe-backfill` edge function dies before completing | **Confirmed** | Code unchanged on main ([universe-backfill/index.ts:249-353](../../supabase/functions/universe-backfill/index.ts#L249-L353)): single `EdgeRuntime.waitUntil` background task, no resumability, `runMetadataBackfill` does `failed += PAGE_SIZE; break` on one page error. Dev coverage: 675/37,595 rows have `openfolio_meta_synced_at`; 1,413 schemes have `official` composition. Upstream is not the constraint (OpenFolio COVERAGE.md: 8,663/8,671 metadata = 99.9 %) | High on incompleteness; Medium on exact kill mechanism (isolate lifetime vs page error — logs would disambiguate) |
| 5 | Compare missing data | **Partially confirmed (re-scoped)** | Dev-side cause is #4's coverage gap: TER on 585 schemes, AUM on 70, `period_returns` on 688, sebi_category on 11,234 of 37,595. The v1 "prod 400s on missing columns" finding is **no longer applicable** (prod intentionally undeployed). Graceful-degradation code paths (NoHistoryBanner, hydration spinner, source-precedence pick) all verified present in [ClearLensCompareFundsScreen.tsx](../../src/components/clearLens/screens/tools/ClearLensCompareFundsScreen.tsx) | High |
| 6 | scheme_master is a junk drawer | **Partially superseded by #191** | `morningstar_rating` + `related_variants` columns dropped (migration `20260608000002`), `stock_market_cap` table dropped (`20260608000001`), classifier+parsers deleted. Remaining real issues: dual-shape `period_returns`, GH-backfill state columns, `amc_slug` (no reader), 95 % empty rows. See §5 | High |
| 7 | OpenFolio integration concerns (duplicate clients, contract drift) | **Confirmed benign** | [src/lib/data/composition.ts](../../src/lib/data/composition.ts) is a documented, intentional mirror of [_shared/openfolio.ts](../../supabase/functions/_shared/openfolio.ts) (exit-runbook boundary); field-for-field identical today; nothing runtime-calls OpenFolio from the client. Risk is silent future drift only | High |
| 8 | Prod a month behind; app SELECTs 400 on prod | **No longer applicable (intentional)** | Per Himanshu: dev-first stabilisation, coordinated prod release later. Carry-forward: the prod release checklist must include migrations → edge deploys → secrets → crons (§7 roadmap, R10) | n/a |
| 9 | v1 cleanup list (morningstar, stock_market_cap, amc_slug, unused mfdata readers) | **Mostly done by #191** | morningstar/related_variants/stock_market_cap/classifier: done. Still present: `amc_slug` column+writes, `readMfdataRank`/`readMfdataPeriodReturn` (unused, [mfdataGuards.ts:153-171](../../src/utils/mfdataGuards.ts#L153-L171)), backfill-state columns | High |

---

## 3. Architecture review (current main)

### 3.1 Component / flow diagram

```
AMFI (NAVAll.txt, history report)      AMC monthly disclosures (50 AMCs)
        │                                       │
        ▼                                       ▼
┌─────────────────────────────────────────────────────────────────┐
│ OpenFolio-Data (GCP Cloud Run, asia-south1, ~$0.5/mo)           │
│  nav.db (daily append, hourly job)  reference.db (monthly build)│
│  - nav_history                      - scheme registry (families)│
│  - per-plan AMFI codes              - holdings/composition      │
│                                     - B1 metadata + statuses    │
│                                     - fund_metrics: ret_1/3/5y, │
│                                       ret_incep, volatility, AUM│
│  REST /v1 (X-API-Key): /nav /nav?since= /schemes /metadata      │
│                        /composition (bulk, updated_since)       │
└───────────────┬─────────────────────────────────────────────────┘
                │ server-side only (edge functions; app never calls OF)
                ▼
┌─────────────────────────────────────────────────────────────────┐
│ FolioLens Supabase (dev) — edge functions                       │
│  CRON sync-nav (18×/day, ❌ failing since ~Jun 6)               │
│    OF /nav/{code}?since=cursor → mfapi fallback → nav_history   │
│  CRON sync-fund-meta (daily): OF metadata → per-B1-status       │
│    mfdata backup → scheme_master  [held funds, 7-day skip]      │
│  CRON sync-fund-portfolios (hourly): mfdata holdings →          │
│    'category_fallback' rows + 'category_rules' seed [held]      │
│  CRON openfolio-sync (monthly 15th): OF bulk composition →      │
│    'official' rows + registry write-back [held universe]        │
│  ON-DEMAND fetch-fund-snapshot (OF-first) /                     │
│    fetch-fund-nav (mfapi full history) [Compare/Past-SIP picks] │
│  MANUAL universe-backfill (❌ structurally cannot finish)       │
│  CRON sync-index, regenerate-index-snapshots                    │
└───────────────┬─────────────────────────────────────────────────┘
   PLUS, outside Supabase (⚠️ pre-OpenFolio fossil, still nightly):
   GH Actions backfill-fund-universe.yml → mfdata meta +
   'amfi' composition + FULL mfapi NAV → dev DB
                │
                ▼
   Postgres: scheme_master · nav_history · fund_portfolio_composition
             index_history · user_fund · transaction · app_config
                │ PostgREST via per-table repos (src/lib/data/*)
                ▼
   App: SQLite read-through cache (nav/tx/idx; per-scope watermarks;
        bootstrap on launch, delta on foreground/pull-to-refresh)
                ▼
   React Query (persisted, __BUSTER__ v7) → screens
```

### 3.2 Data-flow (read paths)

| Screen / feature | Read path |
|---|---|
| Portfolio (home) | SQLite `nav` (90-day window) → fallback Supabase `nav_history`; tx from SQLite-backed RQ caches; XIRR computed client-side |
| Fund detail header | SQLite 2 latest NAV rows → fallback Supabase; metadata from `['scheme-master', code]` |
| Fund detail charts | `fetchFundNavHistory`: SQLite full series → fallback paginated Supabase + write-back |
| Compare | `scheme_master` row + best `fund_portfolio_composition` row (source-precedence) + full NAV series per selected fund; on-pick hydration via `fetch-fund-snapshot` + `fetch-fund-nav`; metrics (1/3/5y CAGR, 3y σ/Sharpe-style, 5y max DD) computed client-side |
| Past SIP Check | same hydration + month-end NAV points |
| Insights | composition rows for held funds |
| Benchmarks | SQLite `idx` → CDN snapshot → paginated `index_history` |

### 3.3 Source-of-truth matrix

| Domain | Upstream source | OpenFolio owns | FolioLens stores | Sync mechanism | Consumers |
|---|---|---|---|---|---|
| Scheme registry | AMFI NAVAll | ✅ families + plans + ISINs + sebi_category (`/v1/schemes`) | `scheme_master` (37,595 codes; seeded from mfapi list, enriched by OF registry write-back) | `openfolio-sync`/`universe-backfill` write-back; `seed-scheme-master` (one-shot, historical) | picker search, Compare basics, `fund` view |
| NAV | AMFI | ✅ full history, `?since=` delta, bulk latest | `nav_history` — **policy: held + on-demand only**; reality: 8,141 schemes (GH fossil) | `sync-nav` cron (held); `fetch-fund-nav` on-demand (⚠️ mfapi-first) | Portfolio, Fund Detail, Compare, Past SIP, timelines |
| Fund metadata (TER, manager, exit load, minima, benchmark label, riskometer) | AMC factsheets/SIDs | ✅ B1 fields + per-field status | `scheme_master` columns | `sync-fund-meta` daily (held, OF-first, per-status mfdata backup); `fetch-fund-snapshot` on-demand; `universe-backfill` (broken) | Compare cost/basics, Fund Detail |
| Returns / volatility / AUM | OF-computed from its NAV + disclosures | ✅ `ret_1y/3y/5y/incep`, `volatility`, `aum_cr` | `scheme_master.period_returns` (jsonb, **dual shape**), `risk_ratios.volatility`, `aum_cr` | same as metadata | Compare fallback (`readReturnPct`), picker (future) |
| Composition / holdings | AMC monthly disclosures | ✅ asset/cap/sector mix + top + debt holdings, provenance | `fund_portfolio_composition` (`official` > `category_fallback` > `category_rules`) | `openfolio-sync` monthly (held); `fetch-fund-snapshot` on-demand; hourly `sync-fund-portfolios` (held, mfdata fallback + rules seed) | Compare holdings/overlap, Insights, Fund Detail |
| Risk ratios (beta/R²) | mfdata (category-gated) | ❌ (deliberately not computed) | `scheme_master.risk_ratios` (mfdata blob, OF volatility merged in) | `sync-fund-meta` mfdata leg | Compare risk (equity only) |
| Benchmarks (index series) | Yahoo/NSE via `sync-index` | ❌ | `index_history` + CDN snapshots | `sync-index` hourly cron | benchmark XIRR, charts |
| User holdings / txs | CAS imports | ❌ | `user_fund`, `transaction`, `cas_import` | upload / Resend inbound | everything user-scoped |

**Intentional duplications:** the Deno (`_shared/openfolio.ts`) and app
(`src/lib/data/composition.ts`) OpenFolio clients (exit-runbook boundary);
SQLite mirrors of `nav_history`/`transaction`/`index_history` (offline-first);
`scheme_master` mirroring OF metadata (runtime independence from OF).
None of these are drift today; only the client twins lack a lock-step guard.

---

## 4. Bug review (user-facing first)

### P0-1 — Dev NAV is frozen (cron job broken) — **what users see: stale values everywhere**
- **Root cause:** `sync-nav-hourly` job SQL uses
  `current_setting('app.supabase_functions_base_url')`; the GUC doesn't exist
  on dev. Every one of the 18 daily runs errors before invoking the function.
  Regression introduced by the bimodal-schedule migration (20260528), which
  predates the parameterisation convention switch to `app_config_get()`
  (20260513) — the migration was written against the old convention.
- **Evidence:** `cron.job_run_details`: 18 failures/24 h, message
  `unrecognized configuration parameter "app.supabase_functions_base_url"`;
  held funds' max `nav_date` = 2026-06-05; later `nav_date`s exist only for
  non-held schemes via on-demand `fetch-fund-nav` — which is exactly why the
  DB *looked* fresh while the app was stale.
- **Confidence:** High. **Fix complexity:** trivial (one idempotent migration
  re-creating the job with `app_config_get`). **Risk:** none beyond cron
  churn; function itself is verified healthy (manual invocations work).

### P0-2 — Cold launch paints stale NAV even when the DB is fresh
- **Root cause:** ordering + missing invalidation. `fetchPortfolioData` reads
  SQLite and uses Supabase only when SQLite is empty for the window; the
  launch-time `runBootstrap` pulls new rows into SQLite *after* screens
  rendered, and never calls `queryClient.invalidateQueries()`. The persisted
  RQ cache (PORTFOLIO staleTime 1 h) then pins the stale computation.
  Foreground delta sync *does* invalidate — but AppState `'active'` doesn't
  fire on process launch.
- **Files:** [app/_layout.tsx:198-227](../../app/_layout.tsx#L198-L227) (gap),
  [app/_layout.tsx:314-327](../../app/_layout.tsx#L314-L327) (the pattern to
  reuse), [src/hooks/usePortfolio.ts:157-184](../../src/hooks/usePortfolio.ts#L157-L184).
- **Confidence:** High (design-level; repro: cold-launch after an overnight
  NAV publish, first paint shows previous day until pull-to-refresh).
- **Fix complexity:** small (share the `changed → invalidate` predicate;
  unit-test it). **Risk:** low — one extra recompute per launch when data
  actually changed; guard against invalidating during active gestures is
  already implicit (it's the same thing pull-to-refresh does).

### P1-1 — Compare shows "—" for most non-held funds (metadata coverage 2 %)
- **Root cause:** `universe-backfill` cannot complete (isolate lifetime;
  silent abort on page error; no cursor/resume), so OF metadata reached only
  675 schemes and `official` composition 1,413. Upstream coverage is 99.9 %.
  On-pick hydration (`fetch-fund-snapshot`) papers over it one fund at a
  time, OF-first, so freshly picked funds *do* fill in — the gap shows in
  search/badges and any fund the user views before hydration completes.
- **Files:** [universe-backfill/index.ts](../../supabase/functions/universe-backfill/index.ts)
  (esp. lines 132-141 abort, 249-353 waitUntil), `_shared/openfolio.ts`
  (sync core is fine — it's the invocation model).
- **Confidence:** High. **Fix complexity:** medium (chunked, cursor-resumable
  invocations; loud truncation). **Risk:** low; write paths already idempotent.

### P1-2 — Nightly GH backfill: wrong source ladder + unbounded NAV growth
- **Root cause:** `backfill-fund-universe.mjs` predates OpenFolio (mfdata
  primary, mfapi NAV, `source:'amfi'` writes, mfdata-shape `period_returns`)
  and was never retired when #190–#195/#191 landed. Since Jun 2 every run
  also dies at the 60-min timeout (mfdata/mfapi latency), so it now covers
  only ~170 schemes/night — *partially failing and still writing*.
  Effects: (a) ~1.55 GB of NAV rows for unheld funds (Supabase notice);
  (b) it re-introduces shapes/tags the codebase just deprecated;
  (c) its metadata writes race `sync-fund-meta`'s OF-first writes.
- **Files:** [scripts/backfill-fund-universe.mjs](../../scripts/backfill-fund-universe.mjs),
  [.github/workflows/backfill-fund-universe.yml](../../.github/workflows/backfill-fund-universe.yml);
  state columns in `scheme_master`.
- **Confidence:** High (run history + nightly `last_backfill_attempted_at`
  stamps + line-level source tags). **Fix complexity:** trivial to stop;
  medium to replace (PR-3/PR-4). **Risk of stopping:** none — its only
  consumer-visible value (pre-hydration) is superseded by OF backfill +
  on-pick hydration.

### P2 — lower-priority defects
| Bug | Root cause | Files | Complexity |
|---|---|---|---|
| `category_rules` rows accrete daily (1,736 rows / 91 schemes) | `portfolio_date` = run date on the rules seed; unique key includes date | [sync-fund-portfolios/index.ts](../../supabase/functions/sync-fund-portfolios/index.ts) | S (write a fixed sentinel date or delete-then-insert per scheme) — no UI impact (source precedence wins), pure bloat |
| `fetch-fund-nav` is mfapi-first | predates M1; contradicts OF-primary policy; pulls 3–6k rows/scheme | [fetch-fund-nav/index.ts](../../supabase/functions/fetch-fund-nav/index.ts) | S (OF `getNavSeries` first, mfapi fallback) |
| Non-held NAV in SQLite can serve a stale tail | `fetchFundNavHistory` returns any local rows; delta sync scopes to held funds only; hydration freshness window is 3 days | [useFundDetail.ts:358-393](../../src/hooks/useFundDetail.ts#L358-L393) | S–M (compare local max date vs hydration `last_nav_date` and top-up) — cosmetic in Compare (returns shift by ≤3 days) |
| Compare egress: ~3–6k rows × 4 funds per fresh load | full-series fetch for metrics that need ≤5 y | Compare screen + `fetchFundNavHistory` | M (bound to 5 y via `since`; or OF metrics fallback) |
| `sync-nav` 45-day since-map | a scheme idle >45 d gets `since=null` → full re-fetch (heavy but self-healing) | [sync-nav/index.ts:31-89](../../supabase/functions/sync-nav/index.ts#L31-L89) | S (lookback → per-scheme MAX(nav_date) query) — only matters after long outages like the current one |

---

## 5. Data model review

### 5.1 Tables

| Table | Purpose | Current state (dev) | Concerns | Recommendation |
|---|---|---|---|---|
| `scheme_master` | global registry + metadata mirror | 37,595 rows, 21 MB; ~30 cols post-#191 | see 5.2 | finish metadata fill; drop GH-state cols with the fossil; normalise `period_returns` |
| `nav_history` | NAV series | 8.80 M rows, 1,588 MB, 8,141 schemes; held = 35 schemes / 101 k rows; frozen for held funds since 06-05 | GH fossil growth; orphan rows | stop writer → cleanup → retention rule (§6) |
| `fund_portfolio_composition` | composition snapshots | 3,236 rows: `official` 1,415 (latest 2026-05-26) · `category_rules` 1,736 (daily accretion) · `category_fallback` 85; `amfi` 0 | accretion; `official` coverage 1.4 k of ~8.7 k active | overwrite-per-scheme rules rows; coverage via fixed backfill |
| `index_history` | benchmark closes | 48 MB | none | leave alone |
| `app_config` | per-env config for cron URLs | healthy | the one job not using it is the broken one | PR-1 |
| `user_fund` / `transaction` / `cas_import` / profiles | user data | healthy, small | — | leave alone |
| `stock_market_cap` | — | **dropped** (#191, 20260608000001) | — | done |

### 5.2 `scheme_master` audit — problems vs ugliness vs intent

**A. Actual problems**

| Item | Why it's a problem | Evidence |
|---|---|---|
| `period_returns` dual shape | OF writers store `{ret_1y…}` decimals; mfdata leg stores `{return_1y…, rank_*}` percents. `readReturnPct` handles both, but OF writes *replace* the blob, silently discarding mfdata's rank/1m/3m/6m; any future reader that forgets the dual shape mis-renders by 100× | [sync-fund-meta/index.ts:309-336](../../supabase/functions/sync-fund-meta/index.ts#L309-L336) vs [mfdataGuards.ts:134-151](../../src/utils/mfdataGuards.ts#L134-L151); dev: 659 OF-shape vs 29 mfdata-shape rows |
| GH-backfill state columns (`last_backfill_attempted_at`, `backfill_outcome`, `backfill_failure_count`, `is_inactive`) | owned exclusively by the deprecated nightly script; no app reader; `is_inactive` is 0 for all rows (the escalation never fired) | migration 20260509000002; grep: only `backfill-fund-universe.mjs` touches them |
| Metadata emptiness (TER 1.6 %, AUM 0.2 %, returns 1.8 %) | not a schema flaw — the broken backfill — but it's the single biggest data-quality fact about the table | live counts §2 row 5 |
| OF `family_id` not persisted | the stable OpenFolio join key (family→plans) is resolved on every sync but thrown away; future features (variant linking, dedup) will re-derive it | `SchemeRegistryRow` in [_shared/openfolio.ts:741-748](../../supabase/functions/_shared/openfolio.ts#L741-L748) carries only category+amc |
| `amc_slug` | mfdata-specific, no reader anywhere in app or functions | grep |

**B. Looks ugly, actually fine**

- ~30 columns wide: each surviving column has a real reader post-#191.
- Three `*_synced_at` stamps: they gate three genuinely different freshness
  domains (any-meta, mfdata-leg, OF-leg) and `isSchemeMetaFresh` consumes
  them; collapsing them would re-couple the fallback ladder.
- `risk_ratios` jsonb with merged OF volatility: documented at the write
  site; readers are status-gated. Fine until a third writer appears.
- Two category columns (`scheme_category` broad / `sebi_category` granular):
  deliberate two-field model from migration 20260529 with comments; the bug
  it fixed (DSP "38/33/29") is documented.

**C. Intentional — do not "fix"**

- **37k-row seed** (full historical AMFI list): chosen so the universal
  picker can find anything a CAS might contain. The cost is 95 % naked rows.
  A future `active` flag from the OF registry would let search prefer live
  schemes — enhancement, not cleanup.
- **Honest nulls everywhere**: trust-the-numbers policy; never zero-fill.
- **`fund` as a view** over `user_fund × scheme_master`: compatibility layer,
  recreated correctly by #191's migration (DROP + CREATE + re-GRANT).
- **mfdata backup leg** in `sync-fund-meta`: per-B1-status fallback is the
  designed safety net while OF B1 coverage matures; the OF statuses
  (`officially_absent` etc.) exist precisely to gate it.

### 5.3 OpenFolio-related tables — nothing else to flag

`fund_portfolio_composition.source_url`/`disclosure_date` provenance columns
(20260531) are populated for `official` rows only, as designed. The
`COMPOSITION_SOURCE_RANK` still ranks the retired `'amfi'` tag (rank 2) —
harmless for legacy rows, keep until the tag is provably absent everywhere.

---

## 6. Storage review

Dev DB = 1,685 MB total; `nav_history` = 94 % of it.

| Class | Data | Verdict |
|---|---|---|
| **Genuinely needed** | held-fund NAV (101 k rows); `index_history`; `scheme_master` registry+metadata; `official` composition; all user tables | keep |
| **Cache (regenerable on demand)** | every `nav_history` row (OF `/v1/nav/{code}` or mfapi replays them); composition rows; all OF-sourced scheme_master fields | safe to delete + re-fetch; worst case = the 1–2 s first-pick spinner |
| **Duplicated** | universe NAV mirror duplicates OF's `nav.db` (the whole point of OF was to *not* do this); SQLite client cache duplicates Postgres (by design, keep) | delete the server-side duplicate |
| **Not needed by any read path** | NAV for the ~8,100 unheld, never-compared schemes (98.8 % of rows) | delete |

### Does Compare actually require full NAV history? — **No. Verified from code.**

- Compare computes exactly three things from the series:
  `computeTrailingReturns` (1/3/5-year anchors,
  [computedFundMetrics.ts:228+](../../src/utils/computedFundMetrics.ts#L228)),
  `computeRiskMetrics({windowYears: 3})` (monthly σ/Sharpe-window,
  [ClearLensCompareFundsScreen.tsx:2015](../../src/components/clearLens/screens/tools/ClearLensCompareFundsScreen.tsx#L2015)),
  and `computeMaxDrawdown` with an explicit **5-year cutoff**
  ([ClearLensCompareFundsScreen.tsx:245-262](../../src/components/clearLens/screens/tools/ClearLensCompareFundsScreen.tsx#L245-L262)).
  → **A 5-year window per *selected* fund satisfies every metric.**
- It fetches series only for `selectedCodes` (max 4), hydrated on-pick via
  `fetch-fund-nav`; nothing reads series for unselected funds.
- Local computation (vs trusting upstream blobs) is **intentional and
  evidence-based** — mfdata's returns/Sharpe were demonstrably wrong
  (docs/research/mfdata-accuracy-comparison.md). OF's `ret_*`/`volatility`
  (computed from AMFI NAV with provenance) are a trustworthy *fallback* for
  funds with no local series yet, but per-selected-fund series remains the
  right primary for charts + drawdown.

### Target policy (confidence: high · impact: high · urgency: P1)

1. Daily series for **held funds** (cron) + **on-demand funds** (hydration) —
   i.e. exactly what the edge functions already produce.
2. **Retention:** prune unheld series untouched for 90 days (stamp
   `scheme_master.nav_backfilled_at` from `fetch-fund-nav`; weekly cleanup).
3. **One-time cleanup** after the GH writer stops: delete unheld NAV
   (~8.6 M rows, ~1.5 GB reclaimed), then `VACUUM FULL nav_history` in a
   quiet window. Optional 1-week safety archive table; the data is fully
   regenerable either way.
4. **No** universe latest-NAV tier, no monthly sampling, no partitioning —
   no current consumer; revisit only when a feature demands it.

Post-cleanup steady state: `nav_history` ≈ 30–80 MB; total DB ≈ 150–250 MB —
comfortably inside any Supabase tier.

---

## 7. Recommended roadmap

| ID | Title | Rationale | Risk | Effort | Confidence / Impact / Urgency |
|----|---|---|---|---|---|
| R1 | Fix `sync-nav-hourly` cron (app_config_get + keep bimodal schedule) | unfreezes NAV for every dev user | minimal | S | High / High / **P0** |
| R2 | Bootstrap → `invalidateQueries` when sync inserted rows | first paint shows today's NAV | low | S | High / High / **P0** |
| R3 | Retire GH `backfill-fund-universe` (workflow + script + state columns) | stops wrong-ladder writes + storage growth | none (superseded) | S | High / High / **P0** |
| R4 | Chunked, resumable OpenFolio universe backfill (cursor in `app_config`; repeated short invocations; loud truncation) | Compare coverage 2 % → ~99 % of active universe | low (idempotent upserts) | M | High / High / P1 |
| R5 | One-time `nav_history` cleanup + retention rule (`nav_backfilled_at` + weekly prune) | reclaims ~1.5 GB; closes the usage notice permanently | low (regenerable; archive optional) | M | High / Med / P1 |
| R6 | `category_rules` overwrite-per-scheme; demote `sync-portfolio-composition-hourly` to daily | stops silent row accretion; hourly mfdata is pointless post-OF | low | S | High / Low / P2 |
| R7 | Normalise `period_returns` to canonical `ret_*` decimals at write; merge-don't-replace; stop `amc_slug` writes; delete unused mfdata readers | removes the 100×-mis-render trap | low | S | High / Med / P2 |
| R8 | `fetch-fund-nav` → OpenFolio-first (mfapi fallback) | single NAV ladder; smaller payloads (`since=`) | low | S | High / Med / P2 |
| R9 | OpenFolio-Data: `max_drawdown_5y` in fund_metrics; optional `?sample=month_end` on `/v1/nav`; `active` flag in registry | lets Compare/Past-SIP run off metadata + bounded windows; honest search filtering | low | M | Med / Med / P2 |
| R10 | Prod release checklist (migrations → functions → secrets → crons → backfill → verify) as a runbook doc | the intentional drift needs a scripted landing | n/a | S | High / High / before prod launch |
| R11 | Compare: OF-metrics fallback when local series absent + bound series fetch to 5 y | faster first paint, less egress | medium (UI behaviour) | M | Med / Med / P3 |
| R12 | Contract-drift guard for the OpenFolio client twins (shared fixture test or codegen check) | prevents silent divergence | low | S | Med / Low / P3 |

### Parallel vs sequential

```
PARALLEL NOW (independent):  R1   R2   R3   R6   R7   R8   R9   R12
SEQUENTIAL:
  R3 ──► R4 (new backfill replaces fossil) ──► R5 (cleanup once writer is dead
        and coverage achieved; R5 only hard-requires R3)
  R1 ──► (verifies R2's repro; R2 itself independent)
  R9 ──► R11 (drawdown upstream before Compare reads it; R11's 5y-bound part
              doesn't need R9)
  everything ──► R10 (prod release goes last)
```

Dependency graph:

```
R1 ─┐
R2 ─┤ (no deps)
R3 ─┼──► R4 ──► R5
R6 ─┤
R7 ─┤
R8 ─┤
R9 ─┼──► R11
R12─┘
            └──────► R10 (prod release, after dev soak)
```

---

## 8. PR sequence

Small, independently mergeable, dev-only. All follow the repo validation
checklist (typecheck 0 / lint 0 / jest + coverage / migrations pushed to dev
via `supabase db push` from a clean checkout / edge deploys via MCP / docs
updated). Stacking: none required — each lands on `main`.

### PR-A `fix(cron): sync-nav uses app_config_get like every other job`
- **Objective:** new migration `2026xxxx_fix_sync_nav_cron_url.sql`:
  unschedule by jobname, re-schedule with
  `public.app_config_get('supabase_functions_base_url')`, same bimodal
  schedule. Comment explains the 20260528 regression.
- **Files:** one migration; `docs/INFRASTRUCTURE.md` cron table.
- **Risks:** none (idempotent unschedule-first pattern already used in 20260531).
- **Validation:** after `db push` to dev — `cron.job` shows new command;
  next :30 run `succeeded`; held max(nav_date) advances same evening;
  `SELECT status FROM cron.job_run_details … LIMIT 3`.
- **Rollback:** re-run prior migration's schedule block (job is declaratively
  recreated either way).

### PR-B `fix(sync): invalidate React Query after launch bootstrap inserts rows`
- **Objective:** export a pure `didSyncChangeData(result: SyncResult): boolean`
  from `src/lib/db/sync.ts`; use it in both the foreground handler and
  `runBootstrap` (invalidate on true). Unit tests for the predicate + a
  layout-level test that bootstrap with `navInserted>0` invalidates.
- **Files:** `app/_layout.tsx`, `src/lib/db/sync.ts`, tests.
- **Risks:** one extra recompute per cold launch when data changed (that's
  the point); ensure no invalidation when bootstrap was a no-op so launch
  perf is unchanged.
- **Validation:** jest; manual: cold launch after NAV publish shows today's
  date in the "as of" label without pull-to-refresh.
- **Rollback:** revert commit (behavioural change is additive).

### PR-C `chore(backfill): retire the pre-OpenFolio universe backfill`
- **Objective:** delete `.github/workflows/backfill-fund-universe.yml` +
  `scripts/backfill-fund-universe.mjs`; migration dropping the four
  scheme_master state columns; update README/data-sync-pipeline/
  deprecate-post-openfolio docs (Phase 5 of the retirement plan).
- **Risks:** none functional. Note in PR body: nightly runs were already
  dying at the 60-min timeout; pre-hydration value is superseded by PR-D +
  on-pick hydration.
- **Validation:** grep proves no other reader of the dropped columns;
  `gh workflow list` no longer shows the cron; dev `db push` clean.
- **Rollback:** git revert (workflow restores; columns recreatable from the
  reverted migration — they carry no app-read state).

### PR-D `feat(backfill): chunked resumable OpenFolio universe backfill`
- **Objective:** rework `universe-backfill` to process N pages per invocation
  with a cursor (`app_config` keys `universe_backfill_meta_cursor` /
  `_comp_cursor`), return progress JSON, never `waitUntil` past one chunk;
  fail loudly (analytics `sync_failed` + non-2xx) instead of `break`-ing
  silently; add a temporary GH workflow or pg_cron schedule that re-invokes
  every 10 min until cursors report done, then disables itself.
- **Files:** `supabase/functions/universe-backfill/index.ts`,
  `_shared/openfolio.ts` (expose page-range args if needed), tests in
  `_shared/__tests__/`, docs.
- **Risks:** OpenFolio rate/load (keep page_size ≤ 300, concurrency 1);
  the documented `openfolio_meta_synced_at` 7-day-freshness interaction with
  `sync-fund-meta` (already a known tradeoff — note it).
- **Validation:** run to completion on dev; acceptance SQL:
  `count(openfolio_meta_synced_at)` ≥ ~8 k; TER/AUM/returns counts ≈ OF
  coverage; Compare picks of 5 random unheld funds render TER/AUM/returns
  without hydration spinner.
- **Rollback:** function is additive/idempotent; disable the re-invoke
  schedule.

### PR-E `chore(nav): one-time orphan cleanup + 90-day retention`
- **Objective:** (1) stamp `scheme_master.nav_backfilled_at` from
  `fetch-fund-nav`; (2) weekly cleanup cron (edge function, not SQL business
  logic) deleting series for schemes that are unheld AND
  (`nav_backfilled_at` is null or > 90 days); (3) runbook note for the
  one-time batched DELETE + VACUUM on dev (executed manually with approval,
  not in a migration).
- **Risks:** deleting a series a user is about to compare → next pick
  re-hydrates (1–2 s); acceptable.
- **Validation:** before/after table size; held rows untouched
  (`count(held)` invariant); Compare re-pick of a pruned fund works.
- **Rollback:** data regenerable from OF/mfapi; optional `nav_history_archive`
  table kept 1 week.
- **Sequencing:** after PR-C (writer dead). Run the one-time DELETE after
  PR-D finishes if you want max accuracy on "recently compared" stamps —
  not a hard dependency.

### PR-F `fix(composition): category_rules rows stop accreting daily`
- **Objective:** rules seed writes a per-scheme singleton (fixed sentinel
  `portfolio_date` or delete-then-upsert); migration dedupes existing rows
  (keep newest per scheme); demote `sync-portfolio-composition-hourly` cron
  to daily.
- **Risks:** read path picks by source-precedence then date — verify
  `pickBestCompositionRows` unaffected (tests).
- **Validation:** row count for `category_rules` ≤ distinct schemes; jest.
- **Rollback:** revert; accretion resumes (harmless).

### PR-G `chore(meta): canonical period_returns shape + drop amc_slug writes + delete dead readers`
- **Objective:** write-side normaliser in `_shared/` (mfdata percents →
  `ret_*` decimals; preserve `as_of_date`; merge horizons instead of
  replacing); stop writing `amc_slug`; delete `readMfdataRank` /
  `readMfdataPeriodReturn` (+tests); keep `readReturnPct` dual-shape reader
  until a data backfill normalises old rows.
- **Risks:** decimal/percent conversion bug → guard with unit tests pinning
  12.5 %↔0.125 both directions; no UI change (reader already dual-shape).
- **Validation:** jest; spot-check one mfdata-backed scheme's blob post-sync.
- **Rollback:** revert (reader still handles both shapes — that's the safety).

### PR-H `feat(nav): fetch-fund-nav goes OpenFolio-first`
- **Objective:** mirror `sync-nav`'s ladder: OF `getNavSeries(code, {since})`
  → mfapi full-history fallback; keep 3-day freshness gate; structured logs.
- **Risks:** OF cold-start latency (0.5–2 s) on first pick — same order as
  mfapi today.
- **Validation:** invoke on dev for a held + an unheld + an OF-404 scheme;
  verify rows + fallback path logs.
- **Rollback:** revert to mfapi-only (function is self-contained).

### PR-I (OpenFolio-Data) `feat(metrics): max_drawdown_5y + nav sampling + registry active flag`
- **Objective:** add `max_drawdown_5y` to `fund_metrics` (computed in the
  monthly build from nav.db); `?sample=month_end` on `/v1/nav/{code}`;
  `active` boolean on `/v1/schemes` (seen in NAVAll within 30 d); openapi +
  fixtures + tests.
- **Risks:** monthly-build runtime/memory (recent OOM history — reuse the
  chunked patterns from #46–#48/#52).
- **Validation:** pytest w/ nav_stub fixtures; spot-check one fund's DD
  against a hand calc.
- **Rollback:** additive fields; consumers feature-detect.

### PR-J `feat(compare): metadata-first metrics fallback + 5y-bounded series`
- **Objective:** when a selected fund has no local series, render
  returns/volatility from `period_returns`/`risk_ratios.volatility`
  (labelled "as of" + provenance) while hydration runs; bound
  `fetchFundNavHistory`'s Supabase fallback for Compare to a 5-year `since`.
- **Sequencing:** after PR-D (coverage makes the fallback useful); DD-from-
  metadata after PR-I.
- **Risks:** mixed-provenance display — keep the "computed locally" vs
  "as reported" label distinction (trust-the-numbers).
- **Validation:** jest for the fallback selector; UX check on a fresh pick.
- **Rollback:** flag-gate the fallback path.

**Merge order:** A, B, C in parallel → D → E; F, G, H any time; I parallel in
the other repo; J last. R10's prod-release runbook PR can be written any time
but executes after a dev soak.

---

## 9. Codex prompts

Shared preamble for every prompt below (paste first):

> You are working on himanshu4141/FolioLens (or OpenFolio-Data where stated),
> branch from latest `origin/main`. Follow CLAUDE.md: typecheck zero errors,
> lint `--max-warnings 0`, `npx jest --coverage` (≥95 % for `src/utils/`),
> tests mock at wrapper boundaries (`@/src/lib/...`), never
> `@/src/lib/supabase`. Migrations: `supabase db push` to dev
> (imkgazlrxtlhkfptkzjc) from a clean checkout — never MCP apply_migration;
> never touch prod (ohcaaioabjvzewfysqgh). Edge functions deploy via the
> Supabase MCP tool with `../_shared/` imports rewritten to `./_shared/`;
> cron-called functions need `--no-verify-jwt`. Before opening the PR:
> validate every test-plan item yourself and mark each "Validated by Claude"
> or "Requires manual verification" in the PR description, include
> evidence (command output, SQL results), explain tradeoffs you made, and
> update affected docs (README "What works now", docs/INFRASTRUCTURE.md,
> docs/architecture/data-sync-pipeline.md, cache-surfaces.md if cache shapes
> change — bump `__BUSTER__` or mark `[cache-shape-stable]`).

**PR-A prompt**

> The dev pg_cron job `sync-nav-hourly` fails every run with `unrecognized
> configuration parameter "app.supabase_functions_base_url"` because
> migration 20260528000000 re-created it using `current_setting(...)` while
> the project convention (20260513000000) is
> `public.app_config_get('supabase_functions_base_url')` — verify this
> yourself first with read-only SQL against dev (`cron.job` command,
> `cron.job_run_details` recent failures, held-fund `max(nav_date)`).
> Write ONE new migration that unschedules `sync-nav-hourly` by jobname
> (idempotent jobid-lookup pattern from 20260531000000) and re-schedules it
> with the same bimodal schedule
> (`30 0,2,4,6,8,10,12,13,14,15,16,17,18,19,20,21,22,23 * * *`) using
> app_config_get. Push to dev, then provide evidence: the new `cron.job`
> command, the first post-fix run's status, and held max(nav_date) advancing
> after the next evening run (mark that last one "Requires manual
> verification" if you open the PR before 18:00 IST). Update
> docs/INFRASTRUCTURE.md's cron table. Do not change the sync-nav function.

**PR-B prompt**

> Bug: on a cold app launch, `runBootstrap` in app/_layout.tsx pulls fresh
> NAV/tx rows into SQLite AFTER screens computed from stale rows and never
> invalidates React Query; only the AppState-foreground handler (which can't
> fire on process launch) and pull-to-refresh invalidate. Read
> app/_layout.tsx (runBootstrap + onAppStateChange), src/lib/db/sync.ts
> (SyncResult), src/hooks/usePortfolio.ts (SQLite-first read) and confirm.
> Fix: extract a pure exported predicate `didSyncChangeData(result)` into
> src/lib/db/sync.ts capturing the existing foreground condition
> (txInserted>0 || navInserted>0 || idxInserted>0 || txRebuiltFromDrift),
> use it in BOTH the foreground handler and runBootstrap (invalidate after
> bootstrap when true). Add unit tests for the predicate (all branches) and
> a test that runBootstrap invalidates when bootstrap reports inserts and
> does NOT when it reports zeros. Explain the perf tradeoff (one extra
> recompute only when data changed) in the PR. Full quality gate: typecheck,
> lint, jest --coverage.

**PR-C prompt**

> Retire the pre-OpenFolio universe backfill, which still runs nightly
> against dev and contradicts the post-#191 architecture. Evidence to
> reproduce and include: (1) `gh run list --workflow=backfill-fund-universe.yml`
> shows nightly schedule runs dying at timeout since 2026-06-02;
> (2) scripts/backfill-fund-universe.mjs writes `source:'amfi'`
> composition rows (retired by #191) and full mfapi NAV history (the 1.6 GB
> nav_history driver — 8.8 M rows, 98.8 % unheld); (3) only this script
> reads scheme_master's last_backfill_attempted_at / backfill_outcome /
> backfill_failure_count / is_inactive. Delete the workflow + script, write
> a migration dropping those four columns (and the
> idx_scheme_master_backfill_rotation index), push to dev, update
> docs/plans/deprecate-post-openfolio.md (new phase), data-sync-pipeline.md,
> README workflows table. Do NOT delete any nav_history rows in this PR —
> cleanup is a separate PR. State the tradeoff: universe pre-hydration is
> superseded by the OpenFolio chunked backfill (follow-up PR) + existing
> on-pick hydration.

**PR-D prompt**

> The `universe-backfill` edge function structurally cannot finish: it runs
> composition+metadata as one fire-and-forget EdgeRuntime.waitUntil task in
> a single isolate (~150 s) for a 2–5 min job, and runMetadataBackfill
> silently `break`s the whole sweep on one failed page. Live result on dev:
> only 675/37,595 scheme_master rows have openfolio_meta_synced_at while
> OpenFolio-Data covers 99.9 % of the active universe — verify both numbers
> yourself (read-only SQL + OpenFolio docs/COVERAGE.md). Rework it to be
> chunked and resumable: process at most N pages (default ~5×300 items) per
> invocation, persist cursors in app_config
> (universe_backfill_meta_cursor/_comp_cursor + a phase marker), respond
> 200 with progress JSON {phase, cursor, done}, log loudly and return an
> error status on page-fetch failure instead of breaking silently. Keep all
> mapping/matching in _shared/openfolio.ts pure and unit-tested (extend
> existing test suites; dependency-injected, no network). Add the structured
> [universe-backfill] logs per the project's edge-function logging standard.
> Add a re-invocation mechanism that calls the function every 10 minutes
> until done and then stops (prefer a GH Actions workflow with a
> repeat-until-done loop over pg_cron, so business logic stays out of SQL —
> justify your choice). Deploy to dev via MCP, drive it to completion, and
> include acceptance evidence: count(openfolio_meta_synced_at), TER/AUM/
> period_returns coverage counts before/after, and a Compare-screen check of
> 3 random unheld funds. Document the known 7-day
> openfolio_meta_synced_at/sync-fund-meta freshness interaction in the
> function header (it already exists — keep it accurate).

**PR-E prompt**

> Add NAV retention so nav_history stays held+recently-used only.
> (1) In fetch-fund-nav, stamp scheme_master.nav_backfilled_at = now() on
> every successful hydration (add the column via migration, comment its
> purpose). (2) New weekly cron + edge function nav-retention that deletes
> nav_history series for schemes that are NOT in any active user_fund AND
> (nav_backfilled_at IS NULL OR < now()-90d), batched deletes (≤100k rows
> per run), structured logs, analytics event with rows_deleted. Cron via
> app_config_get URL pattern; deploy --no-verify-jwt. (3) Write (in the PR
> description + a runbook section in docs/INFRASTRUCTURE.md) the one-time
> manual cleanup for the existing 8.6 M orphan rows: batched DELETE SQL +
> VACUUM FULL guidance + optional 1-week archive table + rollback note
> (data regenerable from OpenFolio/mfapi). Do NOT execute the one-time
> cleanup yourself — it needs explicit approval. Tests: unit-test the
> retention predicate SQL via a pure helper if any logic lives in TS; verify
> on dev that a dry-run SELECT count matches expectation (~8.1k schemes).
> Tradeoff to state: a pruned fund re-hydrates with a 1–2 s spinner on next
> pick.

**PR-F prompt**

> fund_portfolio_composition accretes one `category_rules` row per scheme
> per day (dev: 1,736 rows over 91 schemes) because the rules seed in
> sync-fund-portfolios uses the run date as portfolio_date and the unique
> key is (scheme_code, portfolio_date, source). Verify with read-only SQL.
> Change the rules seed to maintain exactly one row per scheme (pick:
> fixed sentinel portfolio_date '1900-01-01' with a comment, or
> delete-then-upsert — justify your pick re: the
> (scheme_code, portfolio_date, source) key and pickBestCompositionRows'
> precedence-then-date ordering; confirm precedence still ranks
> category_rules last so the sentinel date can't leak into UI labels — check
> what renders disclosure dates). Migration: dedupe existing category_rules
> rows keeping the newest per scheme. Also demote the
> sync-portfolio-composition-hourly cron to daily (migration, app_config_get
> pattern) — hourly mfdata polling is pointless when OpenFolio official rows
> update monthly; state this rationale. Update unit tests; deploy the
> function to dev; evidence: row counts before/after, one scheme's surviving
> row.

**PR-G prompt**

> scheme_master.period_returns holds two shapes: OpenFolio writers store
> {ret_1y: 0.125} (decimal CAGR) and the mfdata backup leg stores
> {return_1y: 12.5, rank_*, as_of_date} (percent). readReturnPct handles
> both at read time, but OF writes REPLACE the blob (dropping mfdata's
> extra horizons) and any future reader that forgets the duality mis-renders
> by 100×. Normalise at write: add a pure helper in _shared/ that converts
> mfdata returns to the canonical {ret_1y… (decimals), as_of_date} shape and
> MERGES new horizons into the existing blob instead of replacing; use it in
> sync-fund-meta and fetch-fund-snapshot. Pin conversion with unit tests
> (12.5 ↔ 0.125 both ways, null/absent fields, merge semantics). Keep
> readReturnPct dual-shape (29 legacy mfdata-shape rows exist on dev — cite
> the count). Also: stop writing amc_slug (no reader — prove with grep; do
> NOT drop the column in this PR), and delete the unused readMfdataRank /
> readMfdataPeriodReturn helpers + their tests. [cache-shape-stable] only if
> the client-visible scheme_master payload shape is unchanged — assess and
> bump __BUSTER__ if needed.

**PR-H prompt**

> fetch-fund-nav still fetches from mfapi only, contradicting the
> OpenFolio-first ladder used by sync-nav (see sync-nav/index.ts). Rework it
> to mirror that ladder: resolveOpenFolioCredentials → getNavSeries(code,
> {since: latest local nav_date or null}) → on 404/error/empty-first-sync
> fall back to mfapi full history. Keep the 3-day freshness short-circuit
> and the response contract {scheme_code, rows_upserted, last_nav_date,
> status} (Compare/Past-SIP depend on it — verify call sites). Structured
> logs at invocation/data-loaded/per-source/completion. Deploy to dev via
> MCP; evidence: invoke for (a) a scheme OF covers, (b) one it 404s, (c) a
> fresh-cache hit; show source used per case from logs. Note the tradeoff:
> OF cold start 0.5–2 s vs mfapi — same order, and `since=` makes warm
> re-hydrations far cheaper.

**PR-I prompt (OpenFolio-Data repo)**

> In himanshu4141/OpenFolio-Data: FolioLens's Compare computes max drawdown
> locally because fund_metrics lacks it, forcing full NAV-series pulls. Add
> to the monthly reference build: max_drawdown_5y (peak-to-trough on daily
> NAV over trailing 5y, decimal ≤ 0) in fund_metrics, exposed in
> /v1/schemes/{id}/metadata and /v1/metadata. Add `sample=month_end` query
> param to /v1/nav/{scheme_code} (last NAV per calendar month). Add
> `active` boolean to /v1/schemes registry items (scheme seen in NAVAll
> within 30 days). Update docs/openapi.yaml + README; extend
> tests/fixtures/nav_stub.db-based tests (offline, no network — repo
> convention); hand-verify one fund's drawdown in the PR description.
> Mind the recent OOM history on the monthly job (#46-#48, #52): compute
> per-scheme streaming, no full-table loads; state memory impact. Validation
> gate: ruff, pyright, pytest all green.

**PR-J prompt**

> Compare UX: a selected fund with no local NAV series shows empty
> Returns/Risk cards until hydration completes, and the series fetch is
> unbounded (~3–6k rows/fund) though metrics need ≤5y
> (computeMaxDrawdown's cutoff, computeRiskMetrics windowYears:3,
> computeTrailingReturns 1/3/5y anchors — verify in code). Two changes:
> (1) while a fund's series is absent/loading, render returns from
> period_returns via readReturnPct and volatility from
> risk_ratios.volatility, visually labelled with their as-of provenance
> (trust-the-numbers: never silently mix "computed locally" and
> "as reported" — keep the label distinction); local series wins once
> loaded. (2) Bound Compare's Supabase fallback fetch in fetchFundNavHistory
> usage to since=today-5y (do NOT change Fund Detail's full-history chart
> path — split the fetcher or add an options arg; beware the SQLite
> write-back poisoning trap documented in useFundDetail.ts lines 187-196:
> a 5y slice must not be written back as if it were full history). Unit
> tests for the fallback selector and the windowed fetch; UX evidence:
> before/after screen recordings or snapshots of a fresh unheld pick.

---

## Appendix — measurements (dev, 2026-06-10)

| Metric | Value |
|---|---|
| DB total | 1,685 MB |
| nav_history | 1,588 MB · 8,804,996 rows · 8,141 schemes |
| held schemes / rows | 35 / 101,419 (1.2 %) |
| held max(nav_date) | **2026-06-05** (frozen) |
| sync-nav-hourly | 18/18 runs failed last 24 h (`current_setting` GUC) |
| GH backfill | success ≤ Jun 1; timeout-cancelled nightly since Jun 2; still touching ~170 schemes/night |
| scheme_master | 37,595 rows; OF-synced 675; TER 585; AUM 70; period_returns 688 (659 OF-shape / 29 mfdata-shape); sebi_category 11,234 |
| fund_portfolio_composition | official 1,415 (latest 2026-05-26) · category_rules 1,736/91 schemes · category_fallback 85 · amfi 0 |
| migrations head (dev) | 20260608000002 (#191 fully applied) |
| OpenFolio-Data coverage | metadata 8,663/8,671 (99.9 %) · holdings 96.4 % · 50/50 AMC adapters |

**PRs reviewed:** FolioLens #156–#195 (notably #186, #188, #190, #191, #192,
#193, #194, #195); OpenFolio-Data #32–#52 (notably #34/#35 NAV ingest,
#45 B1 metadata, #46–#48/#51–#52 OOM/infra, #49–#50 metadata debt).

**Key files reviewed on current main:** see inline links throughout; the
diff between the v1 snapshot and today's main was exactly PR #191, so all
v1 file readings were re-validated as current except where #191 changed them
(noted in §2).
