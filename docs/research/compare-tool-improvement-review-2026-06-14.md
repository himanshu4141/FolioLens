# Compare Funds — Quality & Performance Review (2026-06-14)

Triggered by hands-on testing of the Compare tool with **three Large & Mid Cap Direct plans**.
Reported symptoms: (1) some names show "Direct", some don't; (2) same-category funds flagged as
different categories; (3) the chart renders but some numbers are missing; (4) a few seconds of
"crunching" after selection before results appear. This review reproduces each against the
current code (`origin/main` `06185fd`) and live dev data (`imkgazlrxtlhkfptkzjc`), root-causes
them, and adds issues found along the way, with a prioritised plan and implementation prompts.

> Note: the screenshots referenced in the request did not reach this analysis (text only), so
> every finding below is reproduced independently from code + dev data. Confirm against the
> screenshots; the symptoms match exactly.

---

## 1. Executive summary

All four symptoms reproduce and have clear, mostly-cheap fixes. None are deep architecture
problems — they're a too-narrow name normaliser, dirty `sebi_category` data, an as-reported
tier that's missing two risk metrics, and an eager hydrate-then-recompute flow.

| # | Symptom | Root cause | Class | Fix size |
|---|---|---|---|---|
| 1 | "Direct" shows on some names, not others | `shortSchemeName` regex only matches the canonical `" - Direct Plan - Growth"` shape; AMFI's many variants (no spaced dashes, no "Plan", glued option, caps) slip through | Client display | S |
| 2 | Same-category funds flagged "different category" | `fundCategory` reads `sebi_category`, which is **dirty** for some schemes (a Large-Midcap index fund is tagged `mid cap fund`); the cross-category banner then fires on a false difference | Upstream data + client | S–M |
| 3 | Graph shows, numbers missing | The as-reported fallback returns `sharpe:null, sortino:null` (only computable from NAV), and `fund_manager` is genuinely null for some funds; "computed wins" can also blank periods longer than the loaded series | Client + data gaps | S–M |
| 4 | "Few seconds" after selection | On every pick, two cold edge-function hydrations fire (`fetch-fund-snapshot` + `fetch-fund-nav`) **even when `scheme_master` already has the data**, then a 5y **daily** NAV series (~1,250 pts/fund) is fetched and the metrics recomputed on the JS thread | Perf / over-fetch | M |

Plus four issues found while reproducing (§7): unreliable `plan_type`/`option_type` parsing,
Growth-vs-IDCW plan twins looking like distinct funds (with wildly different AUM), full-daily
NAV used where month-end suffices, and hydration firing unconditionally.

**Bottom line:** Compare is functionally good but feels rough on exactly the kind of
side-by-side a user actually does (plan twins / same category). Items 1, 2, and 3 are trust
papercuts; item 4 is the felt-latency. All are addressable in a focused sprint.

---

## 2. Issue 1 — inconsistent "Direct" / plan label in names

**Where:** `fundDisplayName` → `shortSchemeName` ([src/utils/schemeName.ts:11-16](../../src/utils/schemeName.ts#L11-L16)).

```ts
return name
  .replace(/\s+-\s+(Direct|Regular)\s+Plan(\s+-\s+(Growth|IDCW)(\s+(Option|Reinvest|Payout))?)?$/i, '')
  .replace(/\s+-\s+(Growth|IDCW)(\s+(Option|Reinvest|Payout))?$/i, '')
```

It requires a **spaced dash** (`\s+-\s+`) and the literal word **"Plan"**. AMFI names don't
honour that. Reproduced against the live Large & Mid Cap Direct rows:

| scheme_code | raw `scheme_name` | `shortSchemeName` output | OK? |
|---|---|---|---|
| 145110 | `Axis Large & Mid Cap Fund - Direct Plan - Growth` | `Axis Large & Mid Cap Fund` | ✅ |
| 119436 | `Aditya Birla Sun Life Large & Mid Cap Fund - Growth - Direct Plan` | `Aditya Birla Sun Life Large & Mid Cap Fund` | ✅ |
| **119350** | `BANK OF INDIA Large & Mid Cap Fund Direct Plan-Growth` | `BANK OF INDIA Large & Mid Cap Fund Direct Plan-Growth` | ❌ **"Direct Plan-Growth" kept** |
| **119433** | `Aditya Birla Sun Life Large & Mid Cap Fund -Direct - IDCW` | `…Fund -Direct - IDCW` (no space before `-Direct`) | ❌ |
| 140175 | `Edelweiss Large & Mid Cap Fund - Direct Plan - Growth Option` | `Edelweiss Large & Mid Cap Fund` | ✅ |

So names like BANK OF INDIA's `Fund Direct Plan-Growth` (no dashes, glued option) and ABSL's
`-Direct` (no leading space) keep the plan/option text — exactly "some show Direct, some don't".

**Compounding:** `plan_type`/`option_type` are also unreliable (119433 `plan_type=null`,
`option_type=null` despite "Direct/IDCW" in the name; most rows have `option_type=null`), so the
UI can't fall back to structured fields to render a clean, consistent plan chip.

**Fix:** replace the regex with a robust base-name extractor (port OpenFolio's
`base_scheme_name` logic: strip trailing plan/option/series tails tolerant of glued tokens,
missing "Plan", caps, and no-space dashes) **and** render plan (Direct/Regular) + option
(Growth/IDCW) as a separate, consistent chip derived from the name when the column is null. The
display should never show the plan inline in the title for one fund and not another.

---

## 3. Issue 2 — same category flagged as "different category"

**Where:** `fundCategory` → `fundComparisonCategory(sebiCategory, schemeCategory)`
([…CompareFundsScreen.tsx:275-277](../../src/components/clearLens/screens/tools/ClearLensCompareFundsScreen.tsx#L275-L277)),
and the banner at [line 2245](../../src/components/clearLens/screens/tools/ClearLensCompareFundsScreen.tsx#L2245):
`uniqueCategories = [...new Set(fundData.map(f => fundCategory(f.scheme)))]`. If the set has >1
entry, the "comparing across categories" banner fires.

The label is read straight from `sebi_category` (correct design — no client name-parsing). But
`sebi_category` is **dirty for some schemes**. Reproduced live:

| scheme_code | name | `sebi_category` | `scheme_category` | label shown |
|---|---|---|---|---|
| 145110 | Axis Large & Mid Cap | `large & mid cap fund` | `Large & Mid Cap Fund` | Large & Mid Cap |
| 119218 | DSP Large & Mid Cap | `large & mid cap fund` | **`Equity`** (broad) | Large & Mid Cap (sebi wins) |
| **149343** | Edelweiss NIFTY Large Midcap 250 **Index** Fund | **`mid cap fund`** ❌ | `Large & Mid Cap Fund` | **Mid Cap** |

If a user lines up Axis + DSP + the Edelweiss Large-Midcap **index** fund (all "large & mid
cap" to a human), the index fund reports `mid cap fund` → label "Mid Cap" → the cross-category
banner fires on a **false** difference. (An index fund tracking NIFTY LargeMidcap 250 is
arguably an Index Fund or Large & Mid Cap — `mid cap fund` is simply wrong.)

**Two fixes, layered:**
1. **Data**: tighten upstream/`scheme_master` category resolution so index funds and
   large-mid-cap funds aren't mis-tagged (the P8 sibling-inheritance + name heuristics already
   exist; extend them to catch "Large Midcap"/"Large & Mid"/"…250 Index" → the right SEBI key,
   and don't let an index-tracking name resolve to a bare cap bucket).
2. **Client**: make the cross-category banner tolerant — treat a small set of
   near-equivalent SEBI keys (e.g. large-&-mid vs the corresponding index, or broad fallback
   `Equity`) as "same family" before warning, and never warn purely because one fund's
   `sebi_category` is null/broad while a sibling's is specific.

---

## 4. Issue 3 — graph renders, some numbers missing

Two distinct causes:

**(a) Risk card: Sharpe/Sortino are NAV-only.** In the as-reported branch of
`selectCompareMetrics` ([computedFundMetrics.ts:405-409](../../src/utils/computedFundMetrics.ts#L405-L409))
`sharpe` and `sortino` are hard-`null` (and `stdDev` comes from mfdata only when present).
So in the window between paint and NAV-hydration-complete — or whenever NAV hydration is slow
or fails for a cold fund — the Risk card shows "—" for Sharpe/Sortino while the **chart
(which only needs the NAV series for its own fetch) renders**. This is the most likely "graph
shows, numbers missing" the tester saw.

**(b) Genuine null fields + "computed wins" with a short series.** `fund_manager` is null for
several live funds (Bandhan 118419, BANK OF INDIA 119350 — `has_mgr=false`), and newer funds
have null 5y (Edelweiss index 149343 `r5y=null`). Separately, once the NAV series loads,
`hasComputed` is true if *any* trailing return computes; if the loaded series is younger than a
window, that period shows "—" even though the as-reported blob had a value — because computed
wins wholesale (no per-field mixing, by design).

**Fixes:**
- Compute **Sharpe/Sortino as-reported too** where the inputs exist (OpenFolio `risk_ratios`
  already carries volatility + max_drawdown_5y; if Sharpe/Sortino aren't upstream, show stdDev
  + maxDrawdown in as-reported state and label Sharpe/Sortino "needs full history" rather than a
  bare "—"), so the Risk card isn't half-blank before hydration.
- Make missing fields **explicitly labelled** ("Not disclosed" for null manager, "Too new" for
  a fund younger than the period) per `feedback_trust_numbers`, not a bare "—".
- Reconsider strict computed-wins: when computed yields a period but as-reported has a longer
  one the series can't cover, prefer showing the as-reported longer period with a provenance
  marker rather than "—" (carefully — don't mix within a single period).

---

## 5. Issue 4 — "few seconds" after selection

**The flow on each pick** (non-held fund):

1. `hydrationQueries` (useQueries) fires **two cold edge-function invokes per fund** —
   `fetch-fund-snapshot` (composition/metadata, official-first → can hit OpenFolio) and
   `fetch-fund-nav` (NAV into Supabase + SQLite top-up)
   ([…CompareFundsScreen.tsx:2008-2055](../../src/components/clearLens/screens/tools/ClearLensCompareFundsScreen.tsx#L2008-L2055)).
   These are the dominant latency (~0.5–2 s each, network).
2. On success they invalidate `scheme-master`, `compositions`, `compare:navhistory` → refetch.
3. `navHistoryQuery` fetches a **5-year daily** NAV window per fund (`compareSinceDate()` = −5y),
   in parallel ([line 209-249](../../src/components/clearLens/screens/tools/ClearLensCompareFundsScreen.tsx#L209-L249)).
4. `metricsByCode` recomputes `selectCompareMetrics` over **~1,250 daily points × N funds** on
   the JS thread (trailing CAGRs + month-end build + monthly σ + Sharpe/Sortino + max-DD).

The as-reported fallback already lets numbers paint before step 4 — but the user still feels
(a) the hydration round-trips and (b) the visible as-reported→computed "recompute" flip.

**Key over-fetch:** post-resync, **most active funds already have `period_returns`,
`risk_ratios`, `composition`, and `aum_cr` in `scheme_master`** — yet hydration fires
unconditionally on every pick. And the chart only needs the NAV series; the **metrics don't
need daily granularity** — month-end points (~60 vs ~1,250) compute near-identical trailing
returns and monthly σ at ~20× less data and CPU.

**Fixes (highest-leverage first):**
1. **Gate hydration on missing data** — skip `fetch-fund-snapshot` when `scheme_master` +
   composition are already present/fresh for the code (they are, for active funds post-resync);
   skip `fetch-fund-nav` when a recent local NAV series exists. Turns the common case from
   "2 network calls × N funds" into "0".
2. **Compute metrics from month-end NAV** — reuse the `month_end_nav` RPC (shipped for Past-SIP,
   P14) or sample the series to month-end before `selectCompareMetrics`. ~20× less data to
   fetch and crunch; trailing CAGR/σ unchanged.
3. **Don't block the chart on metrics / don't re-jank** — keep as-reported numbers stable and
   only swap to computed when it's a *material* improvement (e.g. adds Sharpe/Sortino), to avoid
   a visible flip for identical values.
4. **(If still janky) move compute off the main thread** or memoise per (code, since) so
   re-selecting funds doesn't recompute. The existing `perfStart/perfEnd` marks
   (`query:compare:navHistory`, etc.) already let you measure each stage — use them to confirm
   the win.

---

## 6. Additional issues found (not in the original report)

| # | Issue | Evidence | Why it matters |
|---|---|---|---|
| A | **`plan_type`/`option_type` unreliable** | 119433 `plan_type=null,option_type=null` for a "-Direct - IDCW" fund; most rows `option_type=null` | Weakens P6 `isPayoutPlan` (forced to name fallback), the plan chip, and any plan-aware UI |
| B | **Growth vs IDCW plan twins look like separate funds** | 119436 (Growth, AUM ₹726 Cr) vs 119433 (IDCW, AUM ₹20 Cr) — same fund, same returns, wildly different AUM | A user can unknowingly compare two plans of the *same* fund; AUM differs ~36×, making the AUM row misleading. The picker should de-dupe/label plan twins, or Compare should warn |
| C | **Full daily NAV where month-end suffices** | `compareSinceDate()` = −5y daily (~1,250 pts) feeding metric compute | Egress + CPU; see §5.2 |
| D | **Hydration fires unconditionally** | `hydrationQueries` always invokes both edge fns on selection | Wasted round-trips for the now-common case where data already exists |

---

## 7. Plan (prioritised)

| ID | Title | Addresses | Effort | Risk | Priority |
|---|---|---|---|---|---|
| C1 | Robust scheme-name normaliser + consistent plan/option chip | #1, A | S–M | Low | **Must** |
| C2 | Compare perf: gate hydration + month-end compute + stable as-reported | #4, C, D | M | Med | **Must** |
| C3 | Category data hardening + tolerant cross-category banner | #2 | S–M | Low | **Should** |
| C4 | Risk-card as-reported completeness + honest missing-field labels | #3 | S–M | Low | **Should** |
| C5 | Picker: de-dupe / label Growth-vs-IDCW plan twins | B | S–M | Low | **Should** |

C1 + C2 are the felt issues (names + latency) → do first. C3/C4 are trust polish. C5 prevents
the confusing same-fund comparison.

---

## 8. Implementation prompts

Standard FolioLens preamble applies (branch from `origin/main`; `npm run typecheck` zero,
`npm run lint --max-warnings 0`, `npx jest --coverage` ≥95% for `src/utils/`; mock at wrapper
boundaries; migrations via `supabase db push` to dev only; verify live claims yourself; update
docs + `__BUSTER__`/`[cache-shape-stable]` as needed; validate every test-plan item before PR).

### C1 (FL) `fix(compare): robust scheme-name normaliser + consistent plan/option chip`

> `shortSchemeName` (src/utils/schemeName.ts:11-16) only strips the canonical
> `" - Direct Plan - Growth"` shape, so AMFI variants keep the plan/option text — verify live:
> `BANK OF INDIA Large & Mid Cap Fund Direct Plan-Growth` (no spaced dashes) and
> `Aditya Birla Sun Life Large & Mid Cap Fund -Direct - IDCW` (no leading space) both fail to
> strip, while `Axis … - Direct Plan - Growth` works — "some show Direct, some don't". Replace
> the two regexes with a robust base-name extractor that ports OpenFolio's `base_scheme_name`
> behaviour (src/mfholdings/scheme_master/normalize.py in OpenFolio-Data — read it): split on
> dashes that may or may not have surrounding spaces, drop trailing segments that are purely
> plan/option tokens (direct, regular, plan, growth, idcw, dividend, payout, reinvest(ment),
> bonus, option — case-insensitive, tolerant of glued tokens like `Plan-Growth` and `-Direct`),
> and keep the scheme name up to its type word (Fund/ETF/FoF). Add a separate pure
> `planOptionLabel(schemeName, planType, optionType)` that returns a consistent chip string
> (e.g. "Direct · Growth") derived from the structured columns when present and from the name
> otherwise — so the Compare card shows the base name + a uniform plan chip for ALL funds, never
> inline plan text for some and not others. Unit-test against the real names above plus the
> tricky set (Series funds, "Growth Option", caps, no-Plan). Wire into Compare
> (`fundDisplayName`) and any other `shortSchemeName` callers (grep). `[cache-shape-stable]`
> (display only). Evidence: before/after rendered names for the 5 funds in §2.

### C2 (FL) `perf(compare): gate hydration + compute metrics from month-end NAV`

> Compare feels slow for a few seconds after each pick. Trace (verify with the existing
> `perfStart/perfEnd` marks): on selection, `hydrationQueries`
> (…CompareFundsScreen.tsx:2008-2055) fires TWO cold edge-function invokes per fund
> (`fetch-fund-snapshot` + `fetch-fund-nav`) unconditionally, then `navHistoryQuery` pulls a 5y
> **daily** series (~1,250 pts/fund) and `metricsByCode` recomputes `selectCompareMetrics` over
> it on the JS thread. Two wins: (1) **Gate hydration on missing data** — before invoking
> `fetch-fund-snapshot`, check whether `scheme_master` (period_returns/risk_ratios/aum) AND an
> `official` composition row already exist and are fresh for the code (post-resync most active
> funds do); before `fetch-fund-nav`, check for a recent local SQLite series. Skip the invoke
> when present (both edge fns are already idempotent no-ops, but the round-trip itself is the
> cost). (2) **Compute from month-end NAV** — fetch/sample month-end points (reuse the
> `month_end_nav` RPC shipped for Past-SIP, or sample the windowed series to month-end before
> `selectCompareMetrics`); assert trailing CAGR / σ / max-DD are within tolerance of the
> daily-series result in a unit test, and that the chart still uses whatever series it needs.
> Keep the as-reported→computed swap from visibly flipping identical values (only recompute-swap
> when computed adds a field, e.g. Sharpe/Sortino). Measure before/after with the perf marks and
> paste the numbers. Mock at wrapper boundaries; `[cache-shape-stable]` unless the cached series
> shape changes (then bump `__BUSTER__`). Validation: pick 3 cold Large & Mid Cap Direct funds,
> show wall-time to numbers + chart before/after.

### C3 (FL + OD) `fix(category): harden sebi_category resolution + tolerant cross-category banner`

> Comparing same-category funds can falsely trigger the "different category" banner because
> `sebi_category` is dirty for some schemes — verify live: `Edelweiss NIFTY Large Midcap 250
> Index Fund` (scheme 149343) has `sebi_category='mid cap fund'` (wrong) while real large-mid
> funds have `large & mid cap fund`; `uniqueCategories`
> (…CompareFundsScreen.tsx:2245) then sees >1 category. Two parts: (1) **Data** — extend the
> category resolver (`_shared/portfolio-utils.ts` `resolveSebiCategory`/`deriveSchemeCategoryFromName`
> and the OpenFolio side if it's the source) so an index-tracking name ("…Large Midcap 250
> Index", "Large & Mid", "LargeMidcap") resolves to the correct SEBI key and never to a bare
> `mid cap fund`; re-run the relevant backfill path for affected actives and cite the corrected
> count. (2) **Client** — make the banner tolerant: define a small equivalence set so
> near-identical SEBI buckets (and a null/broad `Equity` fallback vs a specific sibling) don't
> trip the warning; only warn on genuinely different fund families. Unit-test the equivalence
> logic with the §3 rows. `[cache-shape-stable]`.

### C4 (FL) `fix(compare): complete the as-reported Risk card + honest missing-field labels`

> In the as-reported branch of `selectCompareMetrics` (computedFundMetrics.ts:405-409)
> `sharpe`/`sortino` are hard-null, so the Risk card is half-blank ("—") until the NAV series
> hydrates — which reads as "graph shows, numbers missing". Also `fund_manager` is genuinely
> null for some funds (verify: Bandhan 118419, BANK OF INDIA 119350) and newer funds lack 5y.
> Changes: (1) in as-reported state, surface every metric OpenFolio already provides (stdDev +
> max-drawdown from `risk_ratios`) and, where Sharpe/Sortino can't be shown, render an explicit
> "needs full history" affordance instead of a bare "—"; (2) replace bare "—" for genuinely
> null fields with honest labels per `feedback_trust_numbers` ("Not disclosed" for null manager,
> "Too new" for a period the fund hasn't existed through); (3) avoid the computed-wins blanking
> of a longer period the loaded series can't cover — prefer the as-reported longer period with a
> provenance marker (never mixing sources within one period). Unit-test the as-reported Risk
> shape and the labels. `[cache-shape-stable]`.

### C5 (FL) `feat(compare/picker): de-dupe and label Growth-vs-IDCW plan twins`

> The picker lets a user compare two plans of the *same* fund unknowingly — e.g. 119436
> (Growth, AUM ₹726 Cr) and 119433 (IDCW, AUM ₹20 Cr): same scheme, same returns, AUM differs
> ~36×, so the AUM row is misleading. In the Compare picker, detect plan twins (same base name +
> AMC via the C1 normaliser) and either collapse them to one entry with a plan selector, or show
> a clear "Direct · Growth / IDCW" chip + a one-line note when two selected funds are the same
> scheme in different plans (and suppress/caveat the AUM-comparison row in that case). Reuse the
> C1 base-name + `planOptionLabel` helpers. Unit-test twin detection. `[cache-shape-stable]`.

---

## 9. Final recommendation

Ship **C1** (names) and **C2** (perf) first — they're the felt issues and both are
contained. **C3/C4** remove the false-category and half-blank-Risk papercuts. **C5** stops the
confusing same-fund comparison. None require schema changes beyond the category data fix, and
all are independently shippable. Suggested order: C1 → C2 → C4 → C3 → C5.
