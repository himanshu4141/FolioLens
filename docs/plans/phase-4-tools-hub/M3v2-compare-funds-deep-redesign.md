# M3v2 — Compare Funds, Deep Redesign (Phase 4 Tools Hub)

> Replaces the prose-only layout that ships in PR #100 with a hero + tabbed-detail architecture, switches the picker scope from user-held to the entire fund universe, and persists a chunk of MFData's response that we currently throw away. Branch: `feat/compare-funds-deep-redesign`. PR #100 stays open for reference; this PR replaces it once approved.

## Goal

Give an interested user the depth of a Value Research-style comparison without the spreadsheet feel. The novice gets a hero ("DSP Nifty Next 50 leads on 3-year returns by 6.4 pp") and walks away. The advanced user pulls down to a tab and sees the underlying period-by-period table with a one-line plain-language explanation of every metric.

## User Value

A user wonders: "I'm thinking of moving from DSP Aggressive Hybrid to DSP Nifty Next 50 — how do they really compare across returns, risk, and what they actually hold?" Compare Funds answers in three layers:

1. **Hero** — single-shot answer: who leads on returns, by how much, over what window.
2. **Prose summary** — the same brand-faithful one-line insight cards we have today (Returns, Cost, Holding overlap, Risk profile, Asset mix), but each is a header for a detail tab.
3. **Tabs** — the rich data: trailing returns across 7 periods, risk ratios with plain-language tooltips, sector + credit-rating breakdown, top equity AND debt holdings, fund metadata.

Picker change: any fund in our database, not just user-held. The user's own funds are pinned at the top of the picker for one-tap access.

## Context

**Branched from:** `main` (after #99 merged). PR #100 stays open as the prose-only reference; this PR supersedes it.

**Related:**
- PR #100 (M3 prose-only Compare Funds) — to be closed after this lands.
- PR #101 (M4 Direct vs Regular) — currently stacked on #100; will retarget to `main` after #100 closes.
- Follow-up PR — Past SIP Check picker swap to use the same universal picker. Out of scope here.

## Current state in the repo (what changes)

```
src/components/clearLens/screens/tools/
  ClearLensCompareFundsScreen.tsx        REWRITE — hero + tabs
src/components/clearLens/                  NEW
  UniversalFundPicker.tsx                  shared component, used by Compare + Past SIP Check
src/utils/
  compareFunds.ts                          KEEP (overlap + trailing CAGR primitives)
  fundSearch.ts                            NEW — debounced search query, "your funds" surfacing
  riskMetrics.ts                           NEW — risk-ratio fetch + computed-fallback wrappers
src/types/app.ts                           EXTEND — SchemeMetadata gains period_returns, risk_ratios, fund_meta
supabase/functions/sync-fund-meta/          UPDATE — capture launch_date, exit_load, min_lumpsum,
  index.ts                                  min_additional, plan_type, period_returns, risk_ratios
supabase/migrations/                       NEW — additive columns on scheme_master
docs/plans/phase-4-tools-hub/
  M3v2-compare-funds-deep-redesign.md      this file
```

## Assumptions

1. **Fund universe** — `scheme_master` is the catalog. The picker queries `scheme_master` directly, not `user_fund`. User's funds are surfaced via a "Your funds" section pinned at the top. We seed `scheme_master` with the broader AMFI scheme list (~12k schemes) as part of this PR so the picker has results.
2. **Up to 3 funds** — same cap as PR #100; 4+ columns are unreadable on a 390 px phone even in tabs.
3. **Picker UX** — typeahead search by `scheme_name` (case-insensitive prefix + token match) plus filter chips for AMC and category. Debounced 250 ms. Returns first 25 matches; refines as user types.
4. **MFData persistence with guards (revised 2026-05-09)** — see "MFData accuracy decision" below. We store the raw `period_returns` and `risk_ratios` blocks but **do not surface them verbatim**. The screen prefers locally-computed numbers from `nav_history` and applies category-aware gating before surfacing risk ratios.
5. **Computed-from-NAV is primary; MFData is fallback** — for any fund where we have NAV history, we compute 1Y / 3Y / 5Y CAGR locally (existing `computeTrailingReturn`) **and** compute Sharpe + Sortino + Std dev locally from monthly returns. MFData's `period_returns` is used only when local NAV history is too short or absent; MFData's Sharpe / Sortino / Alpha are never surfaced (they're sign-flipped on equity funds — see accuracy report). MFData's `beta`, `r_squared`, `std_deviation` are surfaced for **equity-only categories** with guards.
6. **Plain-language metric labels** — every Sharpe / Sortino / Beta / Alpha gets a one-sentence "what this means" caption right under the value. Per the brand vision: dejargonify everything.
7. **Tab persistence within a session** — the active tab persists when the user changes the fund selection; reset on screen unmount.
8. **`toolsFlags.compareFunds`** — already true on PR #100. This branch flips it to true if PR #100 doesn't merge first.
9. **Schema additions are additive** — every new column is nullable; no backfill block.
10. **NAV history coverage** — for held funds we already have NAV history. For non-held funds picked in Compare, we fetch NAV history on-demand from mfapi.in and persist to `nav_history`. First-time pick of an obscure fund has a 1–2 s loading state; subsequent picks are instant.

## MFData accuracy decision (2026-05-09)

A 16-fund comparison study (see `docs/research/mfdata-accuracy-comparison.md`) found:

- **MFData 1Y returns** matched AMFI-computed within 0.5pp on only 3 of 14 funds. Systematic ~1-week stale snapshot biases them low by 1–3pp; one catastrophic outlier (Motilal Nasdaq 100 FoF: 31.46% reported vs 86.92% AMFI-computed).
- **MFData Sharpe / Sortino** are sign-flipped on 11 of 14 equity funds (they appear to use a 1Y window where Indian equities trail the risk-free rate). Surfacing those numbers verbatim would be actively misleading.
- **MFData beta on liquid / debt funds**: HDFC Liquid comes back with Beta = 1.4, Sortino = 21.1 — equity-style ratios applied blindly to a money-market fund. Need category gating.
- **Prior debt-holdings corruption is fully active**: 6 of 16 funds inject benchmark-return rows as numeric strings in `holding_type` / `credit_rating`; 6 of 16 have `equity_pct + debt_pct > 105`. Existing `isDebtDataCorrupted` and `isEquityPctPlausible` guards earn their keep; we add a third (`equity + debt + other > 105` → reject).
- **Reliable**: AUM, expense ratio, std-dev within 1.5pp (equity funds), beta on equity, category, benchmark, AMC metadata, Morningstar rating, launch_date, exit_load, plan_type.

**Implications baked into this plan:**

- The Returns tab uses **locally-computed CAGR** from `nav_history` for 1Y / 3Y / 5Y. MFData's `period_returns` is a fallback for when local NAV history is short.
- The Risk tab shows **locally-computed** Sharpe + Sortino + Std dev for equity / hybrid funds. MFData's `risk_ratios.risk.beta` and `risk_ratios.risk.r_squared` are surfaced *only* for equity / hybrid categories — never for liquid / ultra_short / gilt / money_market / overnight / corporate_bond / credit_risk.
- MFData's Alpha (Jensen's, Treynor) is **never surfaced**. Their methodology is opaque; we can't validate.
- When in doubt the Risk tab shows "—" with an explainer. Better silent than wrong.
- We add `isCompositionImplausible` (equity + debt + other > 105) alongside the existing two guards.

The 4th recommended guard from the accuracy report ("label `launch_date == '2013-01-01'` as 'Direct plan since' not 'Fund inception'") is also implemented in the Other tab.

## Definitions

| Term | Plain-language explanation we'll show |
|---|---|
| Sharpe ratio | "Return per unit of risk. Higher = more reward for the bumps you took." |
| Sortino ratio | "Like Sharpe, but only counts downside swings as risk. Higher = better at avoiding losses." |
| Alpha (Jensen's) | "How much the fund beat the market after adjusting for risk. Positive = manager added value." |
| Beta | "How much the fund moves with the market. 1 = moves in step. Below 1 = steadier than the market." |
| R² | "How closely the fund tracks its benchmark. 100% = identical movement." |
| Std deviation | "How wildly returns swing month to month. Lower = smoother ride." |
| Treynor ratio | (omit for novice; show as a bonus only if the user expands a "more metrics" section) |
| Information ratio | (omit for novice) |

## Design

### Information architecture (locked)

```
┌─────────────────────────────┐
│ Header: Compare Funds       │
│ Subtitle                    │
│                             │
│ Selected funds chips        │
│ + Add fund (opens picker)   │
└─────────────────────────────┘
┌─────────────────────────────┐
│ HERO                        │
│ "3 YEARS · BEST PERFORMER"  │
│ DSP Nifty Next 50           │
│ +21.5%/yr — 6.7 pp ahead    │
│ of DSP Nifty 50 · DSP Hybrid│
└─────────────────────────────┘
Prose summary — current insights (5 cards, brand voice)
  Returns · Cost · Holding overlap · Risk profile · Asset mix

┌─────────────────────────────┐
│ Returns│Risk│Mix│Sectors│…  │   ← horizontal tab strip
└─────────────────────────────┘
┌─────────────────────────────┐
│ Active tab content           │
│ (sticky tab strip on scroll) │
└─────────────────────────────┘
```

### Tab inventory (what each tab shows + the data source)

| Tab | Content | Source |
|---|---|---|
| **Returns** | Period table: 1Y, 3Y, 5Y CAGR (Inception only when MFData has it). Each cell shows the absolute return; the leader's row is bolded. Source labelled per-cell — "computed from NAV" or "from MFData". Category rank shown only when MFData provides it. | **Primary: `nav_history` + `computeTrailingReturn` (existing).** Fallback: `period_returns` JSONB on `scheme_master` (NEW). |
| **Risk** | Three metrics per fund: Sharpe, Sortino, Std dev — locally computed from monthly returns over 3 years. Beta + R² shown only for equity / hybrid categories using MFData's values. Alpha and Treynor never surfaced (MFData methodology opaque + sign-flipped Sharpe shows their assumptions are off). Each metric has a 1-line plain-language caption. | **Primary: locally-computed from `nav_history`.** Beta + R² only: `risk_ratios.risk.beta` / `risk_ratios.risk.r_squared` from MFData, with category gating. |
| **Asset mix** | Three rows: Equity / Debt / Cash split per fund (already stored). Below: Market-cap mix (Large / Mid / Small) per fund. | Existing `fund_portfolio_composition` columns. |
| **Sectors** | Sector allocation table (top 10 sectors by weight, sorted by leader fund). Each cell shows the sector's weight in that fund. Includes a "Credit rating" sub-section for funds with debt — derived from `raw_debt_holdings[].credit_rating` aggregated by weight. | `sector_allocation`, `raw_debt_holdings` (already stored). |
| **Holdings** | Two sub-tables: **Top equity holdings** (up to 25 names, weight per fund — empty cell if a fund doesn't hold the name) and **Top debt holdings** (when at least one fund is a debt / hybrid fund). | `top_holdings`, `raw_debt_holdings` (already stored). |
| **Other details** | Fund age (derived from `launch_date`), expense ratio, exit load, min SIP / min lumpsum / min additional, AMC name, plan type (direct / regular), riskometer label, Morningstar rating. | `scheme_master` columns — half of which are NEW from this PR. |

### Tab interaction details

- Horizontal scroll for the tab strip on narrow phones; tabs are pills, not underlines (matches the existing `ClearLensSegmentedControl` pattern but without the segment background — just a chip strip).
- Sticky tab strip — when the user scrolls past the hero + prose summary, the tab strip docks to the top so the user can flip tabs without scrolling back up.
- Each tab's table can scroll horizontally on phones (3 columns × narrow width = needs the same treatment we already had in the original plan for `ComparisonSection`).

### Universal fund picker (shared infra)

Component: `<UniversalFundPicker>`. API:

```ts
interface UniversalFundPickerProps {
  visible: boolean;
  selectedIds: string[];
  maxFunds?: number;             // optional cap; Compare uses 3, Past SIP uses 1
  onToggle: (schemeCode: number, schemeName: string, isin: string | null) => void;
  onClose: () => void;
}
```

Layout (bottom sheet, same chrome as the current Compare picker):

```
┌─────────────────────────────┐
│ Pick a fund                  │
│ [search input]               │
│                              │
│ [AMC ▾] [Category ▾]         │   filter chips (optional, expandable)
│                              │
│ Your funds                   │
│   ⚪ HDFC Mid-Cap Fund - Dir │
│   ⚪ Axis Bluechip - Dir     │
│                              │
│ All funds (12,847)           │
│   ⚪ Aditya Birla SL Frontline│
│   ⚪ Axis Long Term Equity    │
│   …                          │
└─────────────────────────────┘
```

- Search query: `ilike '%term%'` against `scheme_name` over `scheme_master`. Case-insensitive. Token-match falls out naturally for short queries.
- Debounced 250 ms.
- Pagination: 25 results at a time; "Load more" button at the end of the list.
- "Your funds" section: rendered first, queried separately from `user_fund` joined to `scheme_master`. Appears regardless of search term until the user types ≥3 chars (then we collapse it to keep the result set focused on what they're searching).
- Filter chips for AMC and category — open dropdowns rather than typeahead. Optional; user can skip them.
- Same `<Modal>` + `<Pressable backdrop>` chrome as the existing Compare picker, so visual consistency is automatic.
- **Used by** Compare in this PR (multi-select, max 3) and Past SIP Check in the follow-up PR (single-select). The component supports both modes via `maxFunds` and the `selectedIds` prop.

## Calculation Logic

### Period returns (Returns tab)

```
For each (fund, period) cell:
  if scheme_master.period_returns[period] is not null:
    use it directly (it's MFData-canonical)
  else if period is one of {1Y, 3Y, 5Y} and we have NAV history:
    compute trailing CAGR (existing computeTrailingReturn)
  else:
    show "—" (data unavailable)
```

For the hero: prefer the longest period where every selected fund has a value, mirroring the current PR #100 logic.

### Risk ratios (Risk tab)

```
For each (fund, ratio) cell:
  if scheme_master.risk_ratios[ratio] is not null:
    use it
  else:
    show "—" (data unavailable). We do NOT compute Sharpe / Sortino / Beta /
    Alpha locally — these depend on a reference rate and a benchmark series we
    haven't curated, and getting them subtly wrong is worse than showing "—".
```

### Top holdings union (Holdings tab)

```
union = unique set of top holding names (or ISINs) across the selected funds
for each holding in union, sorted by max weight across funds:
  for each fund: weight (or "—" if absent)
limit to top 25 (or top 50 with "Show more" toggle for the curious)
```

### Credit rating breakdown (Sectors tab)

```
For each fund's raw_debt_holdings:
  group by credit_rating
  sum weight_pct per rating
  sort by weight desc
```

Common buckets: SOV, AAA, AA, A, Below A, Cash equivalent, Unrated.

## Schema changes (additive, on `scheme_master`)

```sql
ALTER TABLE scheme_master
  ADD COLUMN launch_date date,
  ADD COLUMN exit_load text,                    -- raw label from MFData ("-", "1.00%", etc.)
  ADD COLUMN min_lumpsum integer,
  ADD COLUMN min_additional integer,
  ADD COLUMN plan_type text,                    -- 'direct' | 'regular' | null
  ADD COLUMN option_type text,                  -- 'growth' | 'idcw_payout' | etc.
  ADD COLUMN family_name text,
  ADD COLUMN amc_name text,
  ADD COLUMN amc_slug text,
  ADD COLUMN period_returns jsonb,              -- { return_1m, return_3m, ..., rank_1m, ... }
  ADD COLUMN risk_ratios jsonb;                 -- { sharpe, sortino, alpha, beta, ..., category_averages }
```

All nullable. No backfill required — the daily `sync-fund-meta` cron will populate the new columns for active schemes on its next pass.

We deliberately do NOT add a separate `risk_ratio_*` column-per-metric layout because (a) the metric set could grow, (b) MFData's `category_averages` lives alongside the values and shouldn't be split, (c) JSONB lets us store the whole `ratios` block from MFData verbatim and surface it as-is.

We also don't store a `raw_mfdata_payload` JSONB. Reasoning: we already pluck what we need; storing the whole payload doubles storage and the rest is unused. If a future tool needs more, we add the column then.

## Importer changes (`sync-fund-meta`)

Update the `MFDataSchemePayload` interface and the writer block to map:

```ts
interface MFDataSchemePayload {
  // ... existing
  launch_date?: string | null;
  exit_load?: string | null;
  min_lumpsum?: number | null;
  min_additional?: number | null;
  plan_type?: 'direct' | 'regular' | null;
  option_type?: string | null;
  family_name?: string | null;
  amc_name?: string | null;
  amc_slug?: string | null;
  returns?: PeriodReturnsPayload | null;       // store as period_returns jsonb
  ratios?: RiskRatiosPayload | null;            // store as risk_ratios jsonb
}
```

The writer block grows by 9 keys. No new failure modes — null payloads continue to map to null columns, which the UI gracefully falls back on. Tests added for each new key.

## Picker query

```ts
// Server-side search via supabase-js (RLS allows reading scheme_master to all auth users)
async function searchSchemes(term: string, limit = 25, offset = 0) {
  const q = supabase
    .from('scheme_master')
    .select('scheme_code, scheme_name, scheme_category, amc_name, plan_type, isin')
    .order('scheme_name', { ascending: true })
    .range(offset, offset + limit - 1);
  if (term.length >= 2) {
    q.ilike('scheme_name', `%${term}%`);
  }
  return q;
}
```

Confirm RLS on `scheme_master` is read-all-auth before relying on this.

## Out of Scope (deferred to follow-up PRs)

- **PR B — Past SIP Check picker swap.** Replaces the held-funds-only picker with `<UniversalFundPicker>` and adds on-demand NAV fetch from mfapi.in for non-held funds. Branched off this PR.
- **PR C — FundDetail screen enrichment.** Surfaces the new `scheme_master` fields (fund age, exit load, min lumpsum / additional / SIP, plan type, AMC, family, Morningstar rating) and the locally-computed period returns + risk ratios on the existing FundDetail screen. Branched off PR B for stack linearity.
- **M4 cross-app additions.** Already deferred to M4b.
- **Universal NAV history fetch on demand.** If a user picks a fund nobody else holds, we don't have NAV history for it locally. Mitigation: the Returns tab uses `period_returns` from `scheme_master` (covers 1M / 3M / 6M / 1Y / 3Y / 5Y / Inception via MFData even without local NAV). Risk ratios same source. Asset mix / sectors / holdings come from `fund_portfolio_composition`, which is keyed by scheme_code and exists for any scheme our backfill has touched. For schemes with no composition row, the relevant tabs render an "Insufficient data — sync hasn't covered this scheme yet" empty state.
- **Per-day NAV chart in the Compare screen.** Out of scope for V1 — Past SIP Check covers SIP-aware growth comparison; Compare is for static metric comparison.
- **Custom benchmarks for the Returns tab.** Each fund's returns are absolute (vs cash), not benchmark-relative. Vs-benchmark is what Past SIP Check is for.

## Risks And Mitigations

| Risk | Mitigation |
|---|---|
| `scheme_master` doesn't have a row for every scheme MFData knows about (only 40 rows in dev — likely seeded from active user funds). Picking an arbitrary fund could 404. | Phase 0: backfill `scheme_master` with the wider AMFI scheme list before exposing the universal picker. Verify row count > 5,000 before merge. The existing `sync-fund-meta` only populates rows that already exist; we need a one-shot AMFI master loader (script or migration) to seed unknown schemes. |
| MFData's `returns` and `ratios` are null for some less-tracked schemes | Returns tab has a NAV-history fallback (1Y / 3Y / 5Y from `nav_history`). Risk tab shows "—" with a tooltip explaining "this fund's data isn't on MFData". |
| RLS on `scheme_master` may block read-all access | Verify before merge. If RLS is per-user-only, add a permissive read policy migration in this PR. |
| Picker query at scale (5K+ schemes, ilike + paginate) | Add a `gin (scheme_name gin_trgm_ops)` index in the migration. Confirm pg_trgm is enabled (it usually is on Supabase). Without this, ilike against 5K rows is fine; against 50K it's slow. |
| Picker UX feels heavy for "I just want my own funds" use case | "Your funds" section is pinned at the top until the user types — preserves the original UX for the common case. |
| Sticky tab strip + horizontal-scroll tables interact poorly | Build the tab strip on top of the existing `ScrollView` (don't introduce a new gesture handler). Do a manual pass on iOS + Android + web. |
| Hero leader is slightly ahead in 1Y but slightly behind in 3Y — which window wins? | Use the longest common window; the prose summary discloses the window. If user wants a different window, they read the Returns tab. |
| Migration touches `scheme_master` which is read by lots of code | All new columns are nullable + additive; no existing query needs updating. Verified by typecheck + tests. |

## Decision Log

- **2026-05-09**: Hero + tabs (not progressive disclosure, not pure prose). User pick after we showed three IA mockups. Reason: needs to give VR-level depth without surrendering the brand voice; tabs hide depth, hero + prose preserves the brand.
- **2026-05-09**: Universal picker is shared infra. User pick. Compare uses it now; Past SIP Check uses it in the follow-up PR.
- **2026-05-09**: Trust MFData's risk ratios verbatim — don't re-derive locally. Reason: re-deriving Sharpe / Sortino / Beta / Alpha needs a curated risk-free rate and benchmark series we don't have, and getting them slightly different from MFData would confuse users who cross-check against VR.
- **2026-05-09**: JSONB for `period_returns` and `risk_ratios`, not column-per-metric. Reason: future-proof against MFData adding new ratios; keeps `category_averages` alongside the values; one row update vs many.
- **2026-05-09**: Show plain-language captions under every Sharpe / Sortino / Alpha / Beta / R² / Std dev value. Reason: VISION.md "dejargonify everything — if a term like XIRR must appear, explain it in one plain sentence right there".
- **2026-05-09**: Up to 3 funds, same as PR #100. 4-fund layout breaks on phones even with horizontal tab scrolling.
- **2026-05-09**: PR #100 stays open as reference; this PR replaces it. Reason per user: don't throw away the PR, but the prose-only approach is being superseded.
- **2026-05-09**: No raw_mfdata_payload column. Pluck what we need; revisit if a third tool needs more.

## Validation

1. `npx jest` — green; new tests for `sync-fund-meta` payload mapping, `fundSearch.ts`, `riskMetrics.ts` fallback behaviour, and any new util in `compareFunds.ts`.
2. `npx jest --coverage` — `src/utils/` line coverage stays >95%.
3. `npm run typecheck` — zero errors.
4. `npm run lint` — zero warnings.
5. Migration applied to dev; verify `scheme_master` row count is sufficient for universal picker (≥ 5,000 — phase 0 backfill is part of this PR).
6. `sync-fund-meta` deployed; cron run captures the new fields for active schemes.
7. Manual: Compare picker shows "Your funds" + 5K+ search results; tap a non-held fund; all 6 tabs render.
8. Manual: Each Risk-tab metric shows its plain-language caption.
9. Manual: Holdings tab top-25 union; Sectors tab credit-rating chips for hybrid / debt funds.
10. Manual: Light + dark + desktop sidebar shell.

## Phasing (commit / branch slicing within this PR)

Single PR, but commits sequenced so reviewers can read it linearly:

1. **Migration** — `scheme_master` ALTERs + (if needed) RLS policy + (if needed) trigram index.
2. **Backfill scheme_master** — one-shot script/edge-function that seeds the broader AMFI scheme universe so the universal picker has results. Lives under `scripts/` or `supabase/functions/seed-scheme-master/`.
3. **Importer update** — `sync-fund-meta` writes the new columns; tests for the mapping.
4. **Shared `<UniversalFundPicker>`** + `fundSearch.ts` + tests.
5. **`riskMetrics.ts` + `compareFunds.ts` extensions** + tests.
6. **`ClearLensCompareFundsScreen` rewrite** — hero + prose summary + tabs.
7. **Tests for the screen logic** (insight derivation, hero-window selection, tab hide/show rules).
8. **Docs** — README "What works now" update, ExecPlan Amendments if anything diverges in implementation.

After the screen lands and the day-after cron has populated the new columns, the same shared picker drops into Past SIP Check via a separate small PR.

## Progress

- [x] Branch `feat/compare-funds-deep-redesign` created off `main`
- [x] Schema discovery — confirmed which fields MFData returns vs which we drop; identified `scheme_master` row-count gap (40 rows → needs broader backfill)
- [x] M3v2 ExecPlan written (this file)
- [x] Plan reviewed by user; sign-off obtained
- [x] Migration written + applied to dev
- [x] `sync-fund-meta` extended + deployed
- [x] `scheme_master` broader backfill seeded (37,595 rows on dev via `seed-scheme-master` edge function)
- [x] `<UniversalFundPicker>` + `fundSearch.ts` + tests
- [x] `ClearLensCompareFundsScreen` rewrite + tests
- [x] PR raised against `main` (#123, merged 2026-05-09)
- [ ] Local QA pass
- [ ] PR #100 closed (after this lands)
- [x] Past SIP Check picker swap raised as a separate PR (#124, merged 2026-05-09)


## Amendments

The original plan called for an on-demand fetch only as a fallback for held funds without MFData. After PR #123 was reviewed in dev preview, two gaps surfaced that drove a meaningful expansion of scope before merge.

### A1 — Two-layer hydration architecture (added on the same PR before merge)

**Problem.** The original "on-demand fetch held funds without local NAV" only covered NAV history. For non-held picks the user got "—" across most tabs because:

- `scheme_master` only had scheme_code + scheme_name from the AMFI seed (no metadata, no period_returns, no risk_ratios).
- `fund_portfolio_composition` had no row at all.
- `nav_history` had no rows.

Even with the universal picker working, the screen reads of those Postgres tables returned empty. On-demand fetch at pick time would have meant a 1-2s spinner for every long-tail pick — bad first impression for the most ambitious scenario the redesign was supposed to enable.

**Decision.** Layer the hydration:

1. **Proactive backfill (primary).** A daily cron walks `scheme_master` oldest-first and hydrates metadata + composition + NAV for every scheme in the AMFI universe. Once seeded, all reads are sub-50ms cache hits in Postgres.
2. **On-demand snapshot (safety net).** A new edge function fetches the same data for ONE scheme at pick time. Idempotent + cache-aware. Only un-seeded long-tail picks pay the 1-2s; everything the cron has touched is instant.

**What shipped beyond the original plan:**

- Migration `20260509000002_scheme_master_backfill_tracking.sql` adds `last_backfill_attempted_at`, `backfill_outcome`, `backfill_failure_count`, `is_inactive` columns + a partial index on the rotation read.
- New edge function `supabase/functions/fetch-fund-snapshot/` — mirrors `syncMeta + syncComposition` for ONE scheme. Cache hits skip upstream fetches; full hydration falls back to category rules when `family_id` is missing.
- New script `scripts/backfill-fund-universe.mjs` and workflow `.github/workflows/backfill-fund-universe.yml` — daily cron at 18:00 UTC against dev + prod, with `workflow_dispatch` for manual runs (configurable `batch_size`, `offset`, `skip_nav`). Default 600 schemes/run, ~30-50 min wall-time, mfdata-throttled. Full universe coverage in ~60 days at default cadence.
- Marks dead AMFI codes as `is_inactive` after 5 consecutive failures so the cron stops attempting them.
- Compare Funds screen invokes both `fetch-fund-snapshot` and `fetch-fund-nav` (PR #124) in parallel via `useQueries` on each scheme selection. On success the hydration mutation invalidates `['compare:schemes']`, `['compare:compositions']`, `['compare:navhistory']` so the screen rerenders with fresh rows.

### A2 — NAV history is part of the universe cron (originally on-demand only)

Original plan said "NAV history coverage is on-demand only." Reality: leaving NAV out of the cron meant the Returns + Risk tabs would still be empty for non-held picks (since the on-demand `fetch-fund-nav` is per-pick and slow). NAV is now a third stage in the universe cron alongside metadata + composition. Optional `BACKFILL_SKIP_NAV=1` env var for fast metadata-only runs when NAV isn't needed.

### A3 — Plain-text minor changes during implementation

- Default risk-free rate for Sharpe / Sortino set to `6.5%` (current Indian 1Y T-bill ballpark) — locked in `src/utils/computedFundMetrics.ts:DEFAULT_RISK_FREE_RATE`. Plan said "configurable"; shipped value matches the comment in the code.
- The `fund` Postgres view was NOT updated to expose the new `scheme_master` columns. PR #125 (FundDetail enrichment) does a parallel `maybeSingle()` query against `scheme_master` for the new fields instead. Cheaper than a `DROP VIEW … CREATE VIEW` migration. If a future surface needs the same fields more broadly, the view should grow then.

### A4 — Adjacent fix captured separately (PR #126, merged)

The PostHog observability env vars (`EXPO_PUBLIC_POSTHOG_KEY`, `EXPO_PUBLIC_POSTHOG_HOST`) were missing from the production-release and main-deploy EAS Update steps, so all mobile events were silently no-oping since the original PostHog rollout (#119). Surfaced during M3v2 testing; fixed via #126 on a separate hotfix branch. Out of scope for M3v2 itself but called out here so future readers don't go looking for the fix in the M3v2 commit history.
