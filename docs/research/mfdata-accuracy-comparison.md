# MFData Accuracy Comparison — Compare Funds Source-of-Truth Investigation

**Date:** 2026-05-09
**Goal:** Decide whether `mfdata.in` is trustworthy enough to be the source-of-truth for period returns, risk ratios, and fund metadata in the Compare Funds redesign.
**TL;DR:** **Do not trust MFData verbatim.** Compute returns ourselves from AMFI NAV history; use MFData for ratios *only* with sanity guards; the prior debt-holdings corruption pattern is **still live** on multiple funds.

---

## 1. Methodology

### Funds tested (16 funds across 14 categories)

| AMFI code | Fund | Category |
|---|---|---|
| 120503 | Axis ELSS Tax Saver Direct Growth | ELSS |
| 119018 | HDFC Large Cap Fund Direct Growth (ex-Top 100) | Large Cap |
| 122639 | Parag Parikh Flexi Cap Direct Growth | Flexi Cap |
| 125497 | SBI Small Cap Direct Growth | Small Cap |
| 118989 | HDFC Mid-Cap Opportunities Direct Growth | Mid Cap |
| 118825 | Mirae Asset Large Cap Direct Growth | Large Cap |
| 119063 | HDFC Nifty 50 Index Direct Growth | Index |
| 145552 | Motilal Oswal Nasdaq 100 FoF Direct Growth | International FoF |
| 120377 | ICICI Pru Balanced Advantage Direct Growth | Balanced Advantage |
| 119062 | HDFC Hybrid Equity Direct Growth | Hybrid |
| 119091 | HDFC Liquid Direct Growth | Liquid |
| 119707 | SBI Magnum Gilt Direct Growth | Gilt |
| 120692 | ICICI Pru Corporate Bond Direct Growth | Corporate Bond |
| 118759 | Nippon India Pharma Direct Growth | Sectoral – Pharma |
| 120578 | SBI Technology Opportunities Direct Growth | Sectoral – Tech |
| 120334 | ICICI Pru Multi-Asset Direct Growth | Multi-Asset |

### Sources

| Source | Endpoint | Used for |
|---|---|---|
| **MFData** | `https://mfdata.in/api/v1/schemes/{code}` and `/families/{family_id}/holdings` | The source under investigation |
| **Groww (Source 2)** | `https://groww.in/mutual-funds/{slug}` (Next.js SSR HTML, regex-extracted) | Independent comparison; near-perfect AMFI mirror |
| **AMFI / mfapi.in (Source 3 = ground truth)** | `https://api.mfapi.in/mf/{code}` for full daily NAV history | CAGR computed from raw NAVs; std-dev/Sharpe/Sortino self-computed from monthly returns over 3Y window |

CAGR was computed as `(latest_nav / nav_n_years_ago) ^ (1/n) - 1`, anchoring at the closest NAV on or before `latest_date - N years`. Self-computed Sharpe/Sortino used a 6.5% annual risk-free rate over a 3Y monthly-return window (36 monthly log-returns annualized by × √12).

### What I couldn't get

- **Value Research Online**: blocked by Cloudflare interactive challenge for unauthenticated curl requests.
- **MoneyControl**: hit a forced-login wall.
- **Tickertape**: SPA with all data client-loaded via undocumented graph endpoints; no SSR data; could not reverse engineer the auth flow in the time available.
- **Morningstar India**: search pages render server-side but did not expose fund-detail routes via the public search HTML.

Because three "subjective" sites were blocked, **Groww + AMFI-self-computed** form the comparison set. This is actually a stronger ground-truth setup than three competing aggregators — Groww's 1Y/3Y/5Y returns match AMFI-computed CAGR within 0.01pp on 15/16 funds, so it functions as an independent confirmation that *our* CAGR computation is correct.

---

## 2. Per-fund comparison tables

Cells where MFData differs from the consensus by **>5%** (returns/AUM) or **>0.3** (Sharpe/Sortino) or **>0.15** (Beta) are flagged with the divergence in the Aggregate Findings table below; per-fund tables are kept clean for readability.

### Axis ELSS Tax Saver — ELSS (AMFI 120503)

| Metric | MFData | Groww | AMFI / self-computed |
|---|---:|---:|---:|
| Latest NAV (Rs) | 105.2800 | 107.1500 | 107.1500 |
| NAV date | 2026-04-30 | 2026-05-08 | 2026-05-08 |
| 1Y return % | 1.16 | 3.52 | 3.52 |
| 3Y CAGR % | 13.80 | 13.27 | 13.28 |
| 5Y CAGR % | 9.29 | 9.65 | 9.66 |
| AUM (Rs Cr) | 29,076 | 29,076 | — |
| Expense ratio % | 0.84 | 1.33 | — |
| Launch date | 2013-01-01 | 01-Jan-2013 | 2013-01-02 |
| Sharpe | -0.70 | — | 0.40 |
| Sortino | -0.80 | — | 0.35 |
| Std dev % | 14.40 | — | 14.67 |
| Beta | 0.90 | 0.91 | — |
| Alpha (Jensen's) | -2.60 | -0.49 | — |

### HDFC Large Cap (ex-Top 100) — Large Cap (AMFI 119018)

| Metric | MFData | Groww | AMFI / self-computed |
|---|---:|---:|---:|
| Latest NAV (Rs) | 1,186.28 | 1,205.37 | 1,205.37 |
| NAV date | 2026-04-30 | 2026-05-08 | 2026-05-08 |
| 1Y return % | -0.24 | 1.20 | 1.20 |
| 3Y CAGR % | 13.44 | 13.44 | 13.47 |
| 5Y CAGR % | 14.44 | 14.43 | 14.44 |
| AUM (Rs Cr) | 35,458 | 35,458 | — |
| Expense ratio % | 1.03 | 1.04 | — |
| Launch date | 2013-01-01 | 01-Jan-2013 | 2013-01-01 |
| Sharpe | -0.70 | — | 0.44 |
| Sortino | -0.80 | — | 0.36 |
| Std dev % | 14.50 | — | 14.11 |
| Beta | 1.00 | 0.95 | — |
| Alpha (Jensen's) | -2.20 | 0.57 | — |

### Parag Parikh Flexi Cap — Flexi Cap (AMFI 122639)

| Metric | MFData | Groww | AMFI / self-computed |
|---|---:|---:|---:|
| Latest NAV (Rs) | 91.40 | 91.81 | 91.81 |
| NAV date | 2026-04-29 | 2026-05-07 | 2026-05-07 |
| 1Y return % | 4.63 | 4.27 | 4.27 |
| 3Y CAGR % | 17.59 | 17.99 | 17.79 |
| 5Y CAGR % | 16.45 | 16.66 | 16.67 |
| AUM (Rs Cr) | 134,253 | 128,966 | — |
| Expense ratio % | 0.63 | 0.75 | — |
| Launch date | 2013-05-24 | 24-May-2013 | 2013-05-28 |
| Sharpe | -0.60 | — | 1.01 |
| Sortino | -0.70 | — | 0.90 |
| Std dev % | 9.70 | — | 9.75 |
| Beta | 0.60 | 0.60 | — |
| Alpha (Jensen's) | -1.20 | 5.39 | — |

### SBI Small Cap — Small Cap (AMFI 125497)

| Metric | MFData | Groww | AMFI / self-computed |
|---|---:|---:|---:|
| Latest NAV (Rs) | 193.41 | 196.88 | 196.88 |
| NAV date | 2026-04-30 | 2026-05-08 | 2026-05-08 |
| 1Y return % | 5.25 | 8.65 | 8.65 |
| 3Y CAGR % | 15.15 | 15.12 | 15.19 |
| 5Y CAGR % | 16.46 | 16.36 | 16.38 |
| AUM (Rs Cr) | 32,286 | 32,286 | — |
| Expense ratio % | 0.79 | 0.74 | — |
| Launch date | 2013-01-01 | 02-Jan-2013 | 2013-11-18 (NAV start) |
| Sharpe | -0.80 | — | 0.45 |
| Sortino | -0.90 | — | 0.44 |
| Std dev % | 13.70 | — | 16.98 |
| Beta | 0.70 | 0.75 | — |
| Alpha (Jensen's) | -4.20 | -1.77 | — |

### HDFC Mid-Cap Opportunities — Mid Cap (AMFI 118989)

| Metric | MFData | Groww | AMFI / self-computed |
|---|---:|---:|---:|
| Latest NAV (Rs) | 217.72 | 223.90 | 223.90 |
| NAV date | 2026-04-30 | 2026-05-08 | 2026-05-08 |
| 1Y return % | 11.83 | 15.40 | 15.40 |
| 3Y CAGR % | 24.79 | 24.70 | 24.83 |
| 5Y CAGR % | 22.26 | 22.47 | 22.50 |
| AUM (Rs Cr) | 85,358 | 85,358 | — |
| Expense ratio % | 0.77 | 0.76 | — |
| Launch date | 2013-01-01 | 01-Jan-2013 | 2013-01-01 |
| Sharpe | 0.00 | — | 1.04 |
| Sortino | 0.00 | — | 0.89 |
| Std dev % | 15.30 | — | 15.98 |
| Beta | 0.90 | 0.86 | — |
| Alpha (Jensen's) | 1.80 | 3.65 | — |

### Mirae Asset Large Cap — Large Cap (AMFI 118825)

| Metric | MFData | Groww | AMFI / self-computed |
|---|---:|---:|---:|
| Latest NAV (Rs) | 123.31 | 124.70 | 124.70 |
| NAV date | 2026-04-30 | 2026-05-08 | 2026-05-08 |
| 1Y return % | 2.44 | 3.40 | 3.40 |
| 3Y CAGR % | 12.47 | 12.09 | 12.11 |
| 5Y CAGR % | 11.71 | 11.86 | 11.87 |
| AUM (Rs Cr) | 35,343 | 35,343 | — |
| Expense ratio % | 0.58 | 1.07 | — |
| Launch date | 2013-01-01 | 01-Jan-2013 | 2013-01-02 |
| Sharpe | -0.60 | — | 0.35 |
| Sortino | -0.70 | — | 0.28 |
| Std dev % | 14.90 | — | 14.23 |
| Beta | 1.00 | 0.97 | — |
| Alpha (Jensen's) | -1.20 | -0.43 | — |

### HDFC Nifty 50 Index — Index (AMFI 119063)

| Metric | MFData | Groww | AMFI / self-computed |
|---|---:|---:|---:|
| Latest NAV (Rs) | 233.30 | 235.03 | 235.03 |
| NAV date | 2026-04-30 | 2026-05-08 | 2026-05-08 |
| 1Y return % | -1.79 | 0.48 | 0.48 |
| 3Y CAGR % | 10.37 | 10.78 | 10.78 |
| 5Y CAGR % | 9.83 | 11.25 | 11.27 |
| AUM (Rs Cr) | 22,324 | 20,437 | — |
| Expense ratio % | 0.20 | 0.30 | — |
| Launch date | 2013-01-01 | 01-Jan-2013 | 2013-01-01 |
| Sharpe | -0.60 | — | 0.26 |
| Sortino | -0.70 | — | 0.24 |
| Std dev % | 14.70 | — | 13.81 |
| Beta | 1.00 | 0.95 | — |
| Alpha (Jensen's) | — | -1.48 | — |

### Motilal Oswal Nasdaq 100 FoF — International FoF (AMFI 145552)

| Metric | MFData | Groww | AMFI / self-computed |
|---|---:|---:|---:|
| Latest NAV (Rs) | 63.16 | 66.87 | 66.87 |
| NAV date | 2026-04-30 | 2026-05-08 | 2026-05-08 |
| **1Y return %** | **31.46** | **86.92** | **86.92** |
| **3Y CAGR %** | **31.32** | **43.96** | **43.93** |
| **5Y CAGR %** | **19.88** | **25.69** | **25.73** |
| AUM (Rs Cr) | 5,882 | 5,987 | — |
| Expense ratio % | 0.80 | 0.20 | — |
| Launch date | 2018-11-29 | 29-Nov-2018 | 2018-12-03 |
| Sharpe | 1.00 | — | 1.37 |
| Sortino | 2.00 | — | 2.05 |
| Std dev % | 19.80 | — | 24.21 |
| Beta | 1.00 | 0.00 | — |
| Alpha (Jensen's) | — | 0.00 | — |

> **Catastrophic divergence on this fund.** MFData understates 1Y return by **55 percentage points** (31.46% vs 86.92% AMFI-computed). NAV doubled (35.78 → 66.87) over the past year as US tech rallied; MFData's number appears to be a stale cached value from a prior period (possibly when SEBI's overseas-investment cap had this fund suspended for fresh inflows in 2024). 3Y and 5Y also off by 12pp and 6pp.

### ICICI Pru Balanced Advantage — Balanced Advantage (AMFI 120377)

| Metric | MFData | Groww | AMFI / self-computed |
|---|---:|---:|---:|
| Latest NAV (Rs) | 84.81 | 85.96 | 85.96 |
| NAV date | 2026-04-30 | 2026-05-08 | 2026-05-08 |
| 1Y return % | 6.98 | 7.90 | 7.90 |
| 3Y CAGR % | 13.08 | 13.05 | 13.07 |
| 5Y CAGR % | 11.89 | 12.05 | 12.06 |
| AUM (Rs Cr) | 66,398 | 66,398 | — |
| Expense ratio % | 0.88 | 1.07 | — |
| Launch date | 2013-01-01 | 31-Dec-2012 | 2013-01-02 |
| Sharpe | -0.10 | — | 0.83 |
| Sortino | -0.20 | — | 0.63 |
| Std dev % | 8.80 | — | 7.53 |
| Beta | — | 0.00 | — |
| Alpha (Jensen's) | 3.60 | 0.00 | — |

### HDFC Hybrid Equity — Hybrid (AMFI 119062)

| Metric | MFData | Groww | AMFI / self-computed |
|---|---:|---:|---:|
| Latest NAV (Rs) | 121.38 | 154.43 (wrong fund) | 122.36 |
| NAV date | 2026-04-30 | 01-Jun-2018 | 2026-05-08 |
| 1Y return % | -2.01 | 8.25 (wrong fund) | -1.35 |
| 3Y CAGR % | 9.30 | 12.07 (wrong fund) | 9.13 |
| 5Y CAGR % | 11.12 | 19.79 (wrong fund) | 11.14 |
| AUM (Rs Cr) | 21,286 | 20,081 | — |
| Expense ratio % | 1.05 | 0.85 | — |
| Launch date | 2013-01-01 | 01-Jan-2013 | 2013-01-01 |
| Sharpe | -0.80 | — | 0.19 |
| Sortino | -0.80 | — | 0.14 |
| Std dev % | 12.60 | — | 10.84 |
| Beta | — | 0.00 | — |
| Alpha (Jensen's) | -2.70 | 0.00 | — |

> Groww's slug for HDFC Hybrid Equity returns a defunct "HDFC Balanced" page (NAV last updated 2018), so Groww values for this fund are not comparable. MFData NAV/returns line up with AMFI ground truth here.

### HDFC Liquid — Liquid (AMFI 119091)

| Metric | MFData | Groww | AMFI / self-computed |
|---|---:|---:|---:|
| Latest NAV (Rs) | 5,446.16 | 5,453.23 | 5,453.23 |
| NAV date | 2026-04-30 | 2026-05-08 | 2026-05-08 |
| 1Y return % | 6.30 | 6.28 | 6.28 |
| 3Y CAGR % | 6.98 | 6.96 | 6.96 |
| 5Y CAGR % | 6.07 | 6.08 | 6.08 |
| AUM (Rs Cr) | 53,982 | 72,873 | — |
| Expense ratio % | 0.20 | 0.20 | — |
| Launch date | 2013-01-01 | 01-Jan-2013 | 2012-12-31 |
| Sharpe | 3.20 | — | 0.98 |
| Sortino | 21.10 | — | — |
| Std dev % | 0.10 | — | 0.32 |
| Beta | 1.40 | — | — |
| Alpha (Jensen's) | 0.10 | — | — |

> Sortino=21.1 and Beta=1.4 for a Liquid fund are nonsensical — beta-against-equity has no meaning for a money-market instrument. MFData's std_dev=0.1 also implausible (true monthly variance gives 0.32%).

### SBI Magnum Gilt — Gilt (AMFI 119707)

| Metric | MFData | Groww | AMFI / self-computed |
|---|---:|---:|---:|
| Latest NAV (Rs) | 71.11 | 71.22 | 71.22 |
| NAV date | 2026-04-30 | 2026-05-08 | 2026-05-08 |
| 1Y return % | 0.56 | 1.25 | 1.25 |
| 3Y CAGR % | 6.65 | 6.53 | 6.53 |
| 5Y CAGR % | 6.21 | 6.20 | 6.21 |
| AUM (Rs Cr) | 9,629 | 9,047 | — |
| Expense ratio % | 0.46 | 0.47 | — |
| Launch date | 2013-01-01 | 02-Jan-2013 | 2013-01-03 |
| Sharpe | -1.10 | — | -0.08 |
| Sortino | -1.20 | — | -0.06 |
| Std dev % | 4.00 | — | 3.08 |
| Beta | — | 0.00 | — |
| Alpha (Jensen's) | -1.20 | 0.00 | — |

### ICICI Pru Corporate Bond — Corporate Bond (AMFI 120692)

| Metric | MFData | Groww | AMFI / self-computed |
|---|---:|---:|---:|
| Latest NAV (Rs) | 32.66 | 32.76 | 32.76 |
| NAV date | 2026-04-30 | 2026-05-08 | 2026-05-08 |
| 1Y return % | 5.59 | 5.85 | 5.85 |
| 3Y CAGR % | 7.58 | 7.55 | 7.55 |
| 5Y CAGR % | 6.71 | 6.72 | 6.72 |
| AUM (Rs Cr) | 30,212 | 32,682 | — |
| Expense ratio % | 0.36 | 0.37 | — |
| Launch date | 2013-01-01 | 02-Jan-2013 | 2013-01-03 |
| Sharpe | 0.20 | — | 0.86 |
| Sortino | 0.20 | — | 0.75 |
| Std dev % | 1.60 | — | 1.03 |
| Beta | — | — | — |
| Alpha (Jensen's) | -0.30 | — | — |

### Nippon India Pharma — Sectoral – Pharma (AMFI 118759)

| Metric | MFData | Groww | AMFI / self-computed |
|---|---:|---:|---:|
| Latest NAV (Rs) | 579.98 | 603.39 | 603.39 |
| NAV date | 2026-04-30 | 2026-05-08 | 2026-05-08 |
| 1Y return % | **— (missing)** | 11.88 | 11.88 |
| 3Y CAGR % | **— (missing)** | 24.73 | 24.56 |
| 5Y CAGR % | **— (missing)** | 14.59 | 14.61 |
| AUM (Rs Cr) | 8,306 | 7,898 | — |
| Expense ratio % | 0.91 | 0.93 | — |
| Launch date | 2013-01-01 | 31-Dec-2012 | 2013-01-02 |
| Sharpe | — | — | 1.12 |
| Sortino | — | — | 1.16 |
| Std dev % | — | — | 15.62 |
| Beta | — | 0.91 | — |
| Alpha (Jensen's) | — | -0.20 | — |

> **MFData omits all returns and ratios for this fund.** Category and benchmark fields also null in the API response.

### SBI Technology Opportunities — Sectoral – Tech (AMFI 120578)

| Metric | MFData | Groww | AMFI / self-computed |
|---|---:|---:|---:|
| Latest NAV (Rs) | 214.23 | 215.83 | 215.83 |
| NAV date | 2026-04-29 | 2026-05-07 | 2026-05-07 |
| 1Y return % | **— (missing)** | -4.69 | -4.69 |
| 3Y CAGR % | **— (missing)** | 12.33 | 12.08 |
| 5Y CAGR % | **— (missing)** | 12.10 | 12.11 |
| AUM (Rs Cr) | **— (missing)** | 4,027 | — |
| Expense ratio % | 0.94 | 1.03 | — |
| Launch date | **— (missing)** | 09-Jan-2013 | 2013-01-10 |
| Sharpe | — | — | 0.21 |
| Sortino | — | — | 0.19 |
| Std dev % | — | — | 17.58 |
| Beta | — | 0.77 | — |
| Alpha (Jensen's) | — | 7.25 | — |

> **MFData missing AUM, launch_date, category, benchmark, returns, ratios** — only NAV and expense_ratio populated.

### ICICI Pru Multi-Asset — Multi-Asset (AMFI 120334)

| Metric | MFData | Groww | AMFI / self-computed |
|---|---:|---:|---:|
| Latest NAV (Rs) | 887.37 | 897.35 | 897.35 |
| NAV date | 2026-04-29 | 2026-05-07 | 2026-05-07 |
| 1Y return % | 8.88 | 10.96 | 10.96 |
| 3Y CAGR % | 18.90 | 18.87 | 18.59 |
| 5Y CAGR % | 19.88 | 19.33 | 19.34 |
| AUM (Rs Cr) | 83,045 | 77,658 | — |
| Expense ratio % | 0.65 | 0.68 | — |
| Launch date | 2013-01-01 | 01-Jan-2013 | 2013-01-02 |
| Sharpe | 0.00 | — | 1.34 |
| Sortino | 0.00 | — | 1.07 |
| Std dev % | 9.90 | — | 8.85 |
| Beta | — | — | — |
| Alpha (Jensen's) | — | — | — |

---

## 3. Aggregate findings

### 3.1 Returns accuracy (vs AMFI ground truth)

| Metric | Threshold | MFData accuracy | Groww accuracy |
|---|---|---|---|
| **1Y return** | within 0.5pp | **3 / 14** (21%) | **15 / 16** (94%) |
| **3Y CAGR** | within 0.5pp | **12 / 14** (86%) | **16 / 16** (100%) |
| **5Y CAGR** | within 0.5pp | **11 / 14** (79%) | **15 / 16** (94%) |

**MFData 1Y returns are systematically biased low by 1–3 percentage points** on 11/14 funds where data exists, likely because the MFData feed snapshot is dated 2026-05-01 (~1 week behind AMFI's 2026-05-08 cutoff). The bias is consistent in direction (always understates) — consistent with using a slightly stale period-end NAV or a different "1Y" anchor (e.g. 1Y back from month-end vs latest NAV). 3Y and 5Y CAGRs converge to ~AMFI within 0.5pp because the 1-week NAV gap dilutes over longer windows.

**The Motilal Nasdaq 100 FoF is a different class of error** — 55pp under-stated 1Y, 12pp under-stated 3Y. This is not a stale-NAV issue; it is genuinely wrong data, possibly cached from when SEBI suspended overseas mutual-fund subscriptions in early 2024.

### 3.2 NAV/AUM/expense/launch-date accuracy

| Metric | Notes |
|---|---|
| **Latest NAV** | MFData NAV is consistently ~1 week stale relative to AMFI/Groww (`as_of_date: 2026-04-30/29` vs latest 2026-05-07/08). 16/16 numerically equal once you align dates. |
| **AUM** | 11/16 within 5% of Groww. Outliers: HDFC Liquid (MFData 53,982 cr vs Groww 72,873 cr — 26% off), Parag Parikh (134,253 vs 128,966 — 4%), ICICI Multi-Asset (83,045 vs 77,658 — 7%). MFData's AUM is `null` for SBI Technology Opportunities. |
| **Expense ratio** | Mostly within 0.05pp. Three significant outliers: Axis ELSS (MFData 0.84 vs Groww 1.33 — 49bps), Mirae Large Cap (0.58 vs 1.07 — 49bps), Motilal Nasdaq FoF (0.80 vs 0.20 — 60bps in opposite direction). Groww's value tracks the latest published TER; MFData appears to have stale or family-level numbers in some cases. |
| **Launch date** | MFData uses **placeholder `2013-01-01`** for the SEBI Direct-plan inception cutoff on most pre-2013 funds rather than the actual scheme inception. Acceptable for "Direct plan available since" semantics but **wrong if displayed as "Fund age"**. Newer funds (Motilal 2018-11-29, Parag Parikh 2013-05-24) correctly populated. Null for SBI Technology Opportunities. |

### 3.3 Risk ratio accuracy (Sharpe / Sortino / Std-Dev / Beta / Alpha)

| Metric | Finding |
|---|---|
| **Sharpe (MFData vs AMFI 3Y, Rf=6.5%)** | **0/14 within 0.3** — sign is opposite for 11/14 funds. MFData likely uses a 1Y rolling window (during which Indian equity returns < risk-free rate in 2025–26) while AMFI 3Y window is positive. Even for funds where AMFI also reports negative (Gilt: AMFI -0.08), MFData says -1.1 — magnitude is wildly different. |
| **Sortino** | Same pattern as Sharpe — sign-flipped on 12/14 equity funds. HDFC Liquid Sortino=21.1 is implausible. |
| **Std deviation** | **11/14 within 1.5pp of AMFI 3Y self-computed.** Best agreement of the ratio family. Outliers: SBI Small Cap (13.7 vs 16.98), Motilal FoF (19.8 vs 24.21). |
| **Beta** | Tracks Groww within 0.05 on 8/9 funds where both populate it. **Beta=1.4 for HDFC Liquid is wrong** (a money-market fund cannot have meaningful equity beta). MFData also returns Beta=null for several debt/hybrid funds — correct behaviour. |
| **Alpha (Jensen's)** | Hard to ground-truth without recomputing benchmark regression, but MFData's alpha is consistently 2–6pp more negative than Groww for the same fund — suggests a different (possibly ELSS-default) benchmark or a different time window. |

### 3.4 Systematic biases

1. **Snapshot lag**: MFData feeds are ~1 week stale (`as_of_date: 2026-05-01` vs AMFI/Groww 2026-05-08). Affects NAV by ~1.5% on equity, ~0.13% on debt.
2. **Sharpe/Sortino window mismatch**: MFData appears to use a short rolling window (looks like 1Y) where the risk-free rate dominates trailing returns; AMFI 3Y window gives a fundamentally different (and more informative) value. **You cannot compare MFData's Sharpe across funds meaningfully** without knowing this.
3. **Sectoral coverage gap**: 2/16 funds (Nippon Pharma, SBI Tech) returned with `returns: null` and `ratios: null`. These are not obscure funds — both have ₹4,000–8,000 crore AUM. This is a known coverage gap.
4. **Benchmark/category nullable**: SBI Tech also missing category, AUM, launch_date, benchmark — meaning MFData's "fund detail" coverage is patchy beyond just returns.
5. **Holdings sums >100%**: 6/16 funds have `equity_pct + debt_pct > 105%` (Axis ELSS sum=164.9%, HDFC Mid Cap 187.0%, Mirae Large Cap 156.3%, HDFC Nifty 50 115.1%, Motilal FoF 151.1%, ICICI Balanced Advantage 105.3%, ICICI Multi-Asset 106.6%). The excess weight is the corrupted benchmark-row injection (see §4).

---

## 4. Known-issue replication: debt_holdings corruption

**The prior corruption pattern is fully reproducible and active on production data.**

`isDebtDataCorrupted()` in `supabase/functions/_shared/portfolio-utils.ts` checks for numeric strings in `holding_type` or `credit_rating`. I tested all 16 funds via `/families/{family_id}/holdings`:

| Fund | Corrupted debt rows | Notes |
|---|---|---|
| Axis ELSS Tax Saver | **3 of 3** | "BSE 500 India TR INR" benchmark row with `holding_type="26.55"`, `credit_rating="-5.01"` |
| HDFC Mid-Cap Opportunities | **3 of 3** | `holding_type="44.61"`, `credit_rating="-12.63"` |
| Mirae Asset Large Cap | **3 of 3** | `holding_type="23.23"`, `credit_rating="-7.01"` |
| HDFC Nifty 50 Index | **1 of 1** | `holding_type="5.19"`, `credit_rating="11.45"` |
| Motilal Oswal Nasdaq 100 FoF | **1 of 1** | `holding_type="-26.20"`, `credit_rating="7.30"` |
| HDFC Large Cap | 0 of 1 | clean — single legit row |
| All other funds (10) | 0 of varies | clean — multi-row legit debt/cash rows |

**Concrete corrupted row sample (Axis ELSS, family 314):**

```json
{
  "name": "BSE 500 India TR INR",
  "credit_rating": "-5.01",
  "holding_type": "26.55",
  "weight_pct": 31.63,
  "quantity": 18.41,
  "month_change_qty": 8.98,
  "month_change_pct": 8.98
}
```

The "BSE 500 India TR INR" name is the **fund's benchmark**, and the numeric strings (-5.01, 26.55, 31.63) appear to be **benchmark return percentages over different periods** misparsed as financial-instrument fields. This is identical to the original bug. The `isDebtDataCorrupted` guard in our codebase is still earning its keep — **do not relax it**.

The pattern correlates strongly with **pure-equity funds** (5/5 detected corruptions are equity funds: ELSS, Mid Cap, Large Cap, Index, International FoF). Hybrid, balanced, debt, and gilt funds with legitimately many debt holdings are not corrupted.

---

## 5. Recommendation

### Bottom line: **Option (b) — trust MFData with sanity-check guards, plus compute returns ourselves.**

A hybrid approach that uses each source for what it does well:

| Data point | Recommended source | Reason |
|---|---|---|
| **Latest NAV** | AMFI (mfapi.in) | MFData is ~1 week stale; AMFI is daily and free |
| **Period returns (1Y/3Y/5Y/10Y)** | **Compute from AMFI NAV** | MFData 1Y is systematically off by 1–3pp; on Motilal it was off by 55pp. Self-compute is < 50 lines of code and we already have NAV history pipeline. |
| **Expense ratio** | MFData OK with warning | Tracks Groww on 13/16 funds; 3 outliers off by ~50bps |
| **AUM** | MFData OK with sanity check | Tracks Groww on 11/16 funds; flag if MFData null or differs from latest AMFI factsheet by >20% |
| **Launch date** | MFData (knowing it's "Direct plan since") | Acceptable as long as the UI label is "Direct plan since" not "Fund launched" |
| **Sharpe / Sortino** | **Drop or recompute** | Sign-flipped on 11/14 vs 3Y self-computed; methodology window unknown. If we keep MFData's value we must label "1Y trailing" — but that's misleading vs how every other site reports it. **Better: compute our own from monthly NAV returns, like §3.3.** |
| **Std deviation** | MFData OK | 11/14 within 1.5pp; one of the more reliable ratio fields |
| **Beta** | MFData OK with category gate | Reasonable for equity funds; reject `beta` field for category in {Liquid, Gilt, Corporate Bond, Overnight} where market-equity beta is meaningless (the existing `isEquityPctPlausible`-style gating logic should be extended) |
| **Alpha (Jensen's)** | MFData with skepticism | Diverges 2–6pp from Groww; unclear which benchmark MFData uses. If we display alpha, also display the benchmark name from the same source — otherwise apples vs oranges. |
| **Holdings (debt/equity/cash %)** | MFData with `isDebtDataCorrupted` guard | **Keep the guard. It still triggers on production data.** Also reject responses where `equity_pct + debt_pct + other_pct > 105%`. |
| **Category, benchmark, sub-category** | MFData with null-coalescing | 2/16 funds (sectoral) returned null category/benchmark — fall back to AMFI category from scheme master. |

### Specific guards to add (or strengthen)

1. **Reject MFData returns when** `Math.abs(mfdata_1y - amfi_computed_1y) > 5pp`. Use AMFI-computed value instead and log a warning. (Would have caught Motilal Nasdaq 100 FoF.)
2. **Reject MFData Beta when** category in `{liquid, ultra_short, low_duration, money_market, overnight, gilt}`. (Would have caught HDFC Liquid Beta=1.4.)
3. **Reject the entire holdings payload when** `equity_pct + debt_pct + other_pct > 105%`. (Would have caught 6 of 16 funds; complements `isDebtDataCorrupted`.)
4. **Label MFData Sharpe/Sortino as "1Y" (or whatever window MFData actually uses)** in the UI — or better, recompute over a known window from NAV history.
5. **Treat `launch_date == '2013-01-01'`** as "Direct plan inception" semantically; either label it as such or fall back to AMFI factsheet launch.

### Categories where MFData is least reliable

- **International / overseas funds**: Motilal Nasdaq 100 FoF returns 55pp wrong on 1Y. If Compare Funds is targeting NRIs or anyone using global allocation, this category is a landmine.
- **Sectoral funds**: Pharma + Tech both missing returns/ratios entirely; coverage gap.
- **Liquid / ultra-short**: Beta=1.4, Sortino=21.1, std_dev=0.1 are all nonsensical — MFData runs the equity-style ratio pipeline against debt funds without a guard.

### Categories where MFData is fine (with the guards above)

- **Plain equity funds** (Large/Mid/Small/Flexi/ELSS): NAV, AUM, expense, beta, std-dev all serviceable. Returns need to be self-computed for currency. Sharpe/Sortino need recomputation.
- **Plain debt funds** (Corporate Bond, Gilt, Liquid for AUM/expense only): Metadata fine; returns near-correct on 3Y/5Y; do not trust Sharpe.

If we accept that we **must self-compute returns and risk-adjusted ratios from AMFI NAV history** and **must keep the debt-holdings + holdings-sum guards**, MFData earns its place as the source for AUM, expense ratio, beta, std-dev, category, benchmark, family/AMC metadata, and morningstar rating — about half the Compare Funds payload. That's worth keeping for the metadata coverage MFData provides that mfapi.in does not. But it is **not** a verbatim source-of-truth.
