# Postmortem — "The 38 / 33 / 29 strikes twice" (May 2026)

A second user-reported bug against the **same Compare-tab market-cap mix** that Phase 9 M6 was supposed to put to bed. The original M6 work (PRs #154 + follow-ups #157–#171) wired in a real per-fund classifier sourced from AMFI's half-yearly stock list. It correctly fixed every Flexi Cap fund. But two weeks after the dust settled the user pulled up DSP **Large Cap**, **Mid Cap**, **Small Cap**, and **Large & Mid Cap** funds on Compare — and every one of them still showed `38 / 33 / 29`.

The same magic numbers. A different code path. Worth a dedicated writeup because the fix is trivial (~100 lines) but the missed-it-in-QA story is the interesting part: M6's test plan exercised the classifier and the disclaimer surface, but never verified that the **fallback path itself** produced sensible per-bucket values.

## Symptom

Compare Funds → Asset mix → Market cap mix, four DSP equity funds picked side-by-side:

| Fund | Shown | Expected SEBI bucket |
|---|---|---|
| DSP Large Cap Fund | 38 / 33 / 29 | 80 / 12 / 8 |
| DSP Large & Mid Cap Fund | 38 / 33 / 29 | 50 / 40 / 10 |
| DSP Mid Cap Fund | 38 / 33 / 29 | 8 / 75 / 17 |
| DSP Small Cap Fund | 38 / 33 / 29 | 5 / 12 / 83 |

Every column identical. The exact pattern the M6 fix was supposed to eliminate.

## What we already knew (from M6)

The Phase 9 M6 plan ([`docs/plans/phase-9-pre-launch-readiness/M6-honest-portfolio-composition.md`](../plans/phase-9-pre-launch-readiness/M6-honest-portfolio-composition.md)) documented that `38 / 33 / 29` is the *exact value* in `CATEGORY_RULES['flexi cap fund']`. It also documented the `source` tagging system:

- `'amfi'` — real holdings, classified into L / M / S via the ISIN map. Per-fund.
- `'category_fallback'` — had holdings but classifier returned 0 coverage. Falls back to `catRules`.
- `'category_rules'` — no holdings disclosed at all. Falls back to `catRules`.

M6 added the new `'category_fallback'` source and rendered a "category averages" disclaimer for fallbacks. So if a fund landed on either fallback we'd at least *be honest about it*.

That's the surface area the test plan covered. What it didn't cover: **does `catRules` itself produce sensible values for the DSP-style "scheme_category is just the word Equity" case?**

## Root cause

Two layers of fallback meeting one stubborn input shape:

1. **mfdata.in / the AMFI seed file `scheme_category` for these funds as the bare word `"Equity"`** — not `"Mid Cap Fund"`, not `"Small Cap Fund"`, just `"Equity"`. Confirmed via Supabase query for `scheme_code IN (119071, 119212, 119218, 119250)`.

2. **`getCategoryRules('Equity')` maps that to `GENERIC_CATEGORY_MAP['equity']`** — a hardcoded flexi-cap *proxy* with `{ large: 38, mid: 33, small: 29 }`. That was always a misnomer (it wasn't a "generic equity" bucket, it was a flexi-cap fallback for unknown SEBI sub-buckets), but the lookup never noticed.

The bug propagated to **every** path that fell back to `catRules`:

- Every `'category_rules'` row written by the monthly cron (`scripts/sync-amfi-portfolios.mjs` writes `largeCapPct = catRules.large` directly — it doesn't even consult the ISIN classifier).
- The `catRules` *inside* a `'category_fallback'` row when the classifier produced 0% coverage despite having holdings. For DSP funds this happened intermittently — mfdata sometimes returns a top-50 holdings list whose ISINs don't match the AMFI seed (mfdata returns ISINs for foreign ADRs / preference shares / cash-equivalents that aren't in the half-yearly equity classification).

Both layers landed at the same wrong number, and the `amfi > category_fallback > category_rules` sort priority in [`usePortfolioInsights.fetchCompositions`](../../src/hooks/usePortfolioInsights.ts) made sure whichever row existed for the fund got picked — none of them were right.

The DSP funds appear roughly half as `'category_fallback'` and half as `'category_rules'` in the user's DB. Both render the same `38 / 33 / 29`.

## Why M6's test plan missed it

M6's `Verification` section lists:

> 7. **Spot-check Parag Parikh (122639) vs HDFC Flexi Cap (118989).** Splits should differ; Parag Parikh should have a non-trivial "Not classified" slice (foreign equity).

Both of those are *Flexi Cap* funds with `scheme_category = 'Flexi Cap'`. They hit `CATEGORY_RULES['flexi cap fund']` directly, never touch `GENERIC_CATEGORY_MAP`, and the classifier had decent ISIN coverage on the Indian-equity holdings — so the bug was invisible in the M6 acceptance test.

We **didn't include any spot-check for a fund whose `scheme_category` was the bare single word `"Equity"`**. The Indian fund universe has hundreds of such funds (most DSP equity products, a chunk of HDFC's lineup, all the older ICICI Prudential ones) — easy to overlook because the screen looks correct for *any one fund in isolation* (the values are plausible numbers for *some* flexi cap fund), and only obvious when you compare a Large Cap + Mid Cap + Small Cap fund side-by-side.

The other M6 gap: the *coverage* metrics PostHog event (`fund_snapshot_fetched` with `classifier_outcome` and `classifier_coverage_pct`) tracks how often we land on `'category_fallback'`, but doesn't track **what bucket the fallback was based on**. There's no metric that would have caught "every fallback row this week resolved to the same 38/33/29 proxy".

## The fix

PR #188 — single commit, 5 files, +489 / −29.

A new `deriveSchemeCategoryFromName()` helper in [`_shared/portfolio-utils.ts`](../../supabase/functions/_shared/portfolio-utils.ts) that scans the scheme name for SEBI bucket keywords (longest-first, so `"Large & Mid Cap"` beats `"Large Cap"`, `"balanced advantage"` beats `"balanced hybrid"`, `etf` beats `nifty/sensex`). When `scheme_category` is one of the generic single words `"Equity" / "Hybrid" / "Debt" / "Other"` — or blank, or unrecognised — `getCategoryRules()` consults the name-derived key before falling through to the proxy.

After the fix, the same DSP funds resolve to their SEBI sub-buckets:

```
DSP Large Cap Fund         →  large cap fund        →  80 / 12 / 8
DSP Large & Mid Cap Fund   →  large & mid cap fund  →  50 / 40 / 10
DSP Mid Cap Fund           →  mid cap fund          →  8 / 75 / 17
DSP Small Cap Fund         →  small cap fund        →  5 / 12 / 83
```

The fix lives in three places that all duplicate the same `getCategoryRules` body — `supabase/functions/sync-fund-portfolios/index.ts`, `supabase/functions/fetch-fund-snapshot/index.ts`, and `scripts/sync-amfi-portfolios.mjs` (the Node script run by the monthly GitHub Actions workflow). The duplication itself is a separate hygiene problem worth flagging; the pattern table is now duplicated four times if you count `_shared/portfolio-utils.ts`. A follow-up should hoist `CATEGORY_RULES` + `GENERIC_CATEGORY_MAP` + `getCategoryRules` into a shared module that the .mjs script can also import (would need a small build step or to convert it to .ts under `deno run`).

Unit tests in [`_shared/__tests__/portfolio-utils.test.ts`](../../supabase/functions/_shared/__tests__/portfolio-utils.test.ts) cover the four DSP smoking-gun cases plus ordering-safety checks (the `"Mid Cap"` substring inside `"Large & Mid Cap"` must not win first; `"long term equity"` is ELSS not long-duration debt; ETFs that mention Nifty in their name must not be misclassified as index funds).

## Recovery in production

After the fix deploys, the existing wrong rows can be repaired three ways:

1. **Manual trigger of the `Sync AMFI Portfolio Data` workflow.** Writes fresh `'amfi'` rows with `portfolio_date = last day of previous month`, which take sort-priority over the existing `'category_rules'` rows. Affects all users / all funds in one shot.
2. **User opening the Compare tab for an affected fund.** Fires `fetch-fund-snapshot`, which overwrites the existing `'category_fallback'` row in place (same `portfolio_date`, same `source`, upsert without `ignoreDuplicates`) with the corrected catRules values.
3. **Waiting for the next monthly cron** (`30 0 1 * *` IST). Same as #1 but unattended.

No backfill SQL was needed — the existing source-priority sort + same-date upsert semantics get the corrected values surfaced immediately.

## Lessons for future "honest data" plans

1. **Test plans for fallback paths must spot-check the fallback's own output, not just the disclaimer that wraps it.** The M6 verification asked "does the disclaimer appear?" but not "is the number under the disclaimer sensible?". When a fallback returns a hardcoded constant, *some* test must compare it against expected SEBI buckets per known fund.

2. **A naming smell is a real smell.** `GENERIC_CATEGORY_MAP['equity']` was always misleading — it's not a generic equity bucket, it's a flexi-cap *proxy* dressed up as one. The comment on line 96 of `sync-fund-portfolios/index.ts` even said `// flexi cap proxy` in plain English. We saw the smell and didn't act on it. Rename the constant or break it into per-bucket proxies the day you notice the dissonance.

3. **Add a "shape" alert to the coverage telemetry.** The existing `fund_snapshot_fetched` event tracks `classifier_outcome` and `classifier_coverage_pct`. It should also tag the bucket the fallback resolved to (e.g. `fallback_bucket_key: 'mid cap fund' | 'flexi cap fund' | ...`). Then a PostHog cohort `fallback_bucket_key = 'flexi cap fund'` over a 7-day window should be a small minority — if it's the *majority*, the proxy is masquerading as real data again.

4. **Always pull `scheme_name` when querying `fund` or `scheme_master` for classification work.** It's two extra bytes per row and it's the only disambiguator we have when AMFI returns ambiguous category strings. The same fix would have been a one-line change if `scheme_name` had been on the existing SELECT list.

## Suggested PostHog alert post-resolution

`event = 'fund_snapshot_fetched'` AND `classifier_outcome ∈ {'category_fallback', 'category_rules'}` aggregated by `fallback_bucket_key` (TODO: instrument). Alert when the share of any single key exceeds 60% of all fallbacks over a rolling 7-day window — that's the signature of a proxy taking over (`'flexi cap fund'` dominating used to be the bug; if `'large cap fund'` starts dominating it's the next variant).

Until that telemetry ships, a simpler proxy: alert when **>5 distinct schemes** show the literal triple `(large_cap_pct, mid_cap_pct, small_cap_pct) = (38, 33, 29)` in a single day's `fund_portfolio_composition` writes. SQL is one window function; the alert is the same shape we'd want for the next variant.
