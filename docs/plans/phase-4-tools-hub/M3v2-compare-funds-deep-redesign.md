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

1. **Fund universe** — `scheme_master` is the catalog. The picker queries `scheme_master` directly, not `user_fund`. User's funds are surfaced via a "Your funds" section pinned at the top.
2. **Up to 3 funds** — same cap as PR #100; 4+ columns are unreadable on a 390 px phone even in tabs.
3. **Picker UX** — typeahead search by `scheme_name` (case-insensitive prefix + token match) plus filter chips for AMC and category. Debounced 250 ms. Returns first 25 matches; refines as user types.
4. **MFData persistence** — we store what MFData returns *unchanged*. We don't re-derive Sharpe locally; we trust their numbers and surface them with a "source: MFData, as of YYYY-MM-DD" note.
5. **Computed fallback for held funds without MFData** — when `period_returns` is null but we have NAV history, we compute trailing CAGR from `nav_history` (existing `computeTrailingReturn`). We do NOT compute Sharpe / Sortino / Beta locally — those are MFData-only. If MFData has nothing, the Risk tab shows a "data unavailable for this fund" state.
6. **Plain-language metric labels** — every Sharpe / Sortino / Beta / Alpha gets a one-sentence "what this means" caption right under the value. Per the brand vision: dejargonify everything.
7. **Tab persistence within a session** — the active tab persists when the user changes the fund selection; reset on screen unmount.
8. **`toolsFlags.compareFunds`** — already true on PR #100. This branch flips it to true if PR #100 doesn't merge first.
9. **Schema additions are additive** — every new column is nullable; no backfill block. The first daily cron after deploy populates the new columns for active schemes.

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
| **Returns** | Period table: 1M, 3M, 6M, 1Y, 3Y, 5Y, Inception. Each cell shows the absolute return; the leader's row is bolded. Below the table: category rank for each period (e.g. "DSP Nifty Next 50: rank 12 / 215 over 3Y"). | `period_returns` JSONB on `scheme_master` (NEW). Fallback: computed from `nav_history` for periods MFData lacks. |
| **Risk** | Six metrics per fund: Sharpe, Sortino, Alpha, Beta, R², Std dev. Each metric has a 1-line plain-language caption and a category-average chip ("Cat avg 0.94") so the user sees relative position. Treynor + Information ratio hidden behind a "Show more metrics" toggle for the curious. | `risk_ratios` JSONB on `scheme_master` (NEW). MFData provides everything plus `category_averages`. |
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

## Out of Scope (deferred)

- **Past SIP Check picker swap.** Uses the new shared `<UniversalFundPicker>` — separate PR after this lands.
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
- [ ] Plan reviewed by user; sign-off obtained
- [ ] Migration written + applied to dev
- [ ] `sync-fund-meta` extended + tests
- [ ] `scheme_master` broader backfill seeded
- [ ] `<UniversalFundPicker>` + `fundSearch.ts` + tests
- [ ] `ClearLensCompareFundsScreen` rewrite + tests
- [ ] PR raised against `main`
- [ ] Local QA pass
- [ ] PR #100 closed (after this lands)
- [ ] Past SIP Check picker swap raised as a separate PR
