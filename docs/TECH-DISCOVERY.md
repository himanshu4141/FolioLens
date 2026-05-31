# FundLens — Technical Discovery

This document captures the outcome of the technical discovery session. It records the decisions made, the reasoning behind them, and the key findings from research. No implementation has started yet.

---

## Tech Stack Decisions

| Layer | Decision | Reasoning |
|---|---|---|
| **Frontend** | Expo (React Native) + TypeScript | Familiar React ecosystem, native widgets on Android/iOS, single codebase covers Android + iOS + iPad + macOS + Web. New Architecture (stable 2024) closes performance gap with Flutter. |
| **Backend** | Supabase (Postgres + Edge Functions) | Lightweight, handles DB + auth + scheduled jobs. Fits a personal-scale app. No separate Python microservice needed. |
| **NAV data** | mfapi.in | Free, JSON, no auth, 9000+ schemes, historical NAV going back years. Sourced from AMFI. |
| **Index data** | `yfinance` (Python, server-side) | Free, sufficient for daily EOD fetch. Must be server-side — NSE direct calls fail in browser due to CORS. Fallback chain required (see below). |
| **Benchmark mapping** | SEBI category lookup table (hardcoded) | mfapi.in and AMFI flat file contain no benchmark data. Using `scheme_category` from mfapi.in + hardcoded SEBI category-to-benchmark table covers ~80% of funds deterministically. |
| **Holdings / composition** | OpenFolio-Data (primary, official) → mfdata.in (backup) → SEBI category rules (fallback) | Our own [OpenFolio-Data](https://github.com/himanshu4141/OpenFolio-Data) service parses AMCs' SEBI-mandated monthly portfolio disclosures into an authed REST API (`X-API-Key`). It gives truthful, ISIN-bearing equity **and** debt holdings, sectors, and asset mix — mfdata.in has null ISINs and corrupted debt data, so it's demoted to backup/enrichment. FolioLens stays HTTP-only and reads its own Postgres at request time; a monthly cron (`openfolio-sync`, 15th) syncs into `fund_portfolio_composition` as `source='official'`. |
| **CAS import** | CASParser.in — email forwarding (primary) | User forwards their CAMS CAS email to a dedicated CASParser.in inbox. User-initiated, no persistent access, no credential sharing. 0.2 credits per parse (50 refreshes/month on free tier). Lower friction than QR for ongoing refreshes. |
| **CAS parsing** | CASParser.in API | Supabase Edge Functions are Deno (TypeScript only) — no Python runtime. CASParser.in handles parsing and keeps the entire backend on Supabase. Gmail OAuth feature explicitly not used. |
| **XIRR calculation** | Client-side TypeScript | Standard algorithm, no external dependency needed. Accounts for every SIP instalment timing. |

---

## Architecture Overview

```
Expo App (React Native)
    │
    └── Supabase (Postgres + Edge Functions)
          ├── DB: funds, nav_history, index_history, transactions
          ├── Daily cron: fetch NAVs from mfapi.in
          ├── Daily cron: fetch index data via yfinance
          └── CAS webhook: receive parsed JSON from CASParser.in → store transactions
```

---

## Data Sources

### Mutual Fund NAVs — mfapi.in

- **Base URL**: `https://api.mfapi.in`
- **Key endpoints**:
  - `GET /mf/search?query={name}` — search schemes
  - `GET /mf/{scheme_code}` — full NAV history
  - `GET /mf/{scheme_code}/latest` — latest NAV only
- **Cost**: Free, no auth
- **Update frequency**: Daily after 9 PM IST
- **Coverage**: 9000+ schemes, 20M+ historical records
- **Caching strategy**: Daily cron on Supabase Edge Function stores NAVs in DB — app never calls mfapi.in directly

### Benchmark Index Data — yfinance

- **Symbols**:
  - Nifty 50: `^NSEI`
  - Nifty Midcap 150: `^NSEMDCP150`
  - Nifty Smallcap 250: `^NSEMDCP250` (verify symbol)
- **Library**: `yfinance` (Python) via Supabase Edge Function
- **CORS note**: All index data must be fetched server-side and cached in DB
- **Known issue**: `^NSEMDCP150` is less reliable than `^NSEI` on Yahoo Finance — can return stale or empty data
- **Cron timing**: Run after 10:30 UTC (4:00 PM IST) to ensure EOD bar is finalised
- **Fallback chain**:
  1. `yfinance` (primary)
  2. Stooq via pandas-datareader for Nifty 50 (`https://stooq.com/q/d/l/?s=^nsei&i=d`)
  3. EODHD free tier (20 calls/day) for Midcap/Smallcap indices where yfinance is unreliable
- **Validation required**: Check returned DataFrame is non-empty, date matches expected trading day, value is within sane range

### Benchmark Mapping — SEBI Category Lookup

Neither mfapi.in nor AMFI's flat NAV file contain benchmark data. The mapping is derived from:

1. **`scheme_category` field from mfapi.in** (e.g., `"Equity Scheme - Large Cap Fund"`)
2. **Hardcoded SEBI category-to-benchmark table** (from SEBI's 2017 Categorization circular, TRI mandated since Feb 2018)

Standard mappings:

| Category | Benchmark |
|---|---|
| Large Cap | Nifty 100 TRI |
| Mid Cap | Nifty Midcap 150 TRI |
| Small Cap | Nifty Smallcap 250 TRI |
| Large & Mid Cap | Nifty LargeMidcap 250 TRI |
| Flexi Cap | Nifty 500 TRI |
| Multi Cap | Nifty 500 Multicap 50:25:25 TRI |
| ELSS | Nifty 500 TRI (heterogeneous — may need per-fund override) |
| Index Fund (Nifty 50) | Nifty 50 TRI |
| Liquid | Nifty Liquid Index TRI |

**Stability**: Benchmarks rarely change — only during SEBI regulatory events (~2-3 times per decade industry-wide). Safe to treat as stable within a regulatory era. Store with a `valid_from` date.

**Edge cases**: ELSS and thematic/sectoral funds are heterogeneous — category default may not be accurate. Override with per-fund data scraped from Value Research Online as needed.

### Holdings / Composition — OpenFolio-Data (primary), mfdata.in (backup)

**Source**: [OpenFolio-Data](https://github.com/himanshu4141/OpenFolio-Data) — our own Python data product (separate repo, deployed on GCP `asia-south1`) that parses AMCs' SEBI-mandated monthly portfolio disclosures into a clean dataset + an authed REST API.

**Why we built it**: no reliable free holdings API exists. mfdata.in (the prior source) returns **null ISINs** on the free tier (so cap-split can never be real from it), holdings totals exceeding 100%, and corrupted `debt_holdings`. Official AMC disclosures are the only trustworthy, ISIN-bearing source. Decision record: `docs/research/2026-05-29-holdings-source-openfolio-data.md`. Integration: `docs/plans/openfolio-holdings-integration.md`.

**Contract** (pinned against the live API): `GET /v1/composition?page=&page_size=&updated_since=&amc=&top=` (bulk, paginated `{count,page,page_size,items[]}`) and `GET /v1/schemes/{scheme_code}/composition` (single). Auth via `X-API-Key` header (`/health` is open). Each composition carries asset mix (equity/arbitrage/debt/cash/other + derivatives memo), cap mix (large/mid/small/unclassified), sectors, top holdings, debt holdings (ISIN, rating, maturity, YTM), and provenance (`disclosure_date`, `source_url`).

**Integration**: FolioLens stays HTTP-only and reads its own Postgres at request time — no runtime dependency on the external API. The `openfolio-sync` edge function (monthly cron, 15th) pages the bulk endpoint, matches schemes to `scheme_master` (AMFI `scheme_code` primary, ISIN secondary), and upserts `source='official'` rows into `fund_portfolio_composition`. `fetch-fund-snapshot` hits it on-demand for newly-added funds. Precedence: `official` > `amfi` (mfdata) > `category_fallback` > `category_rules`. The single edge-side owner of the base URL + key is `supabase/functions/_shared/openfolio.ts` (secrets `OPENFOLIO_API_BASE` + `OPENFOLIO_API_KEY`); the app-side wrapper is `src/lib/data/composition.ts`.

**Mapping notes**: `arbitrage_pct` folds into `equity_pct`; `cap_mix` maps 1:1 (% of NAV), nulls preserved (never zero-filled). Current OpenFolio data returns `unclassified` for equity cap buckets — honest "unknown" until OpenFolio's ISIN→cap classification populates or we re-derive it via `stock_market_cap`.

### CAS Import — CASParser.in Email Forwarding

**Primary flow — email forwarding:**

CASParser.in provides a dedicated inbox per user. The user forwards their CAMS CAS email to that address. CASParser.in parses it and delivers structured JSON to a Supabase webhook.

1. User taps "Refresh transactions" in app
2. App shows their dedicated CASParser.in forwarding address
3. User finds their CAMS CAS email (auto-sent monthly by CAMS) and forwards it
4. CASParser.in parses and POSTs to our Supabase webhook
5. Supabase stores updated transaction history

**Why email forwarding over alternatives:**

| Option | Privacy | Friction | Credits |
|---|---|---|---|
| Gmail OAuth | ❌ Persistent inbox access | Low | 0.2/parse |
| ~~MFcentral QR~~ | ~~✅ User-controlled~~ | ~~High (redirect → OTP → QR → upload)~~ | ~~1/parse~~ |
| PDF upload | ✅ User-controlled | Medium (download + upload) | 1/parse |
| **Email forwarding** | ✅ **User-initiated, no persistent access** | **Low (one forward)** | **0.2/parse** |

**Fallback flow — PDF upload:**
For first import (before a CAMS monthly email arrives), or if email forwarding fails:
- Manual PDF: download CAS from camsonline.com → upload in-app → sent to CASParser.in

> MFcentral QR flow removed (March 2026) — high friction (OTP + redirect + QR scan) with no meaningful advantage over PDF upload. Email sync + PDF covers all practical cases.

**CASParser.in pricing**: Free tier — 10 credits/month. Email parsing costs 0.2 credits (50 refreshes/month). PDF parsing costs 1 credit (10 parses/month).

---

## What CAS Contains

Each CAS includes:
- All folios across CAMS + KFintech RTAs
- Full transaction history (SIP instalments, lump sums, STPs, redemptions, switches)
- Current units and NAV per scheme
- Cost of investment

This gives us everything needed to compute XIRR accurately for SIP investors.

---

## Key Constraints & Decisions Not To Revisit

- **No Gmail OAuth** — rejected on privacy grounds. CASParser.in's Gmail feature explicitly not used.
- **No direct MFcentral integration** — requires AMFI partner registration, not feasible for a personal app.
- **No MFcentral QR flow** — removed March 2026. High friction (OTP → redirect → QR scan) relative to PDF upload, which achieves the same outcome with less ceremony.
- **No Account Aggregator** — requires SEBI RIA license, ₹5-25L cost, 5-10 month implementation. Not viable.
- **No self-hosted casparser** — Supabase Edge Functions are Deno (TypeScript only), no Python runtime. CASParser.in avoids needing a separate microservice.
- **Index data must be server-side** — CORS blocks browser-side NSE API calls.

---

## Open Questions

All open questions from initial discovery have been resolved. None remain.
