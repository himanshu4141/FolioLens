# M3 — Compare Funds MVP (Phase 4 Tools Hub)

> Originally drafted on the stacked branch `feat/tools-hub-m3` (atop M2). The branch was rebased onto the M2 fresh stack as `feat/tools-hub-m3-fresh` once M2 was raised against `main`.

## Goal

Allow users to objectively compare up to 3 funds they already hold, side by side, using the data already available in FundLens — without recommendations, ratings, or advisory language.


## User Value

A user holding 5 funds wonders: "How does my Axis Bluechip fund compare to my HDFC Flexicap? Which one has lower costs and better historical consistency?" Compare Funds shows key metrics side by side so the user can form their own view, with FundLens providing only objective data — not conclusions.


## Context

**Stacked on:** `feat/tools-hub-m2` → this branch is `feat/tools-hub-m3`.

**Depends on existing data:**
- Fund metadata (category, AUM, expense ratio, benchmark, fund age) from `fund_meta` / scheme master table — check `docs/TECH-DISCOVERY.md`
- Portfolio composition (asset allocation, market-cap mix, sector exposure, top holdings) from existing `usePortfolioInsights` / `useFundComposition` hooks
- Holding overlap calculation (can be derived from top-holdings lists if available)
- Trailing returns — computed from NAV history already available

**New files:**

```
app/tools/
  compare-funds.tsx                        — Expo Router route
src/components/clearLens/screens/tools/
  ClearLensCompareFundsScreen.tsx          — full screen component
src/utils/
  compareFunds.ts                          — overlap and derived metric helpers
src/utils/__tests__/
  compareFunds.test.ts                     — unit tests
docs/plans/phase4-tools-hub/
  M3-compare-funds-mvp.md                  — this file
```


## Assumptions

1. Fund selector is limited to user-held funds (M6 expands to all funds).
2. Minimum 2 funds, maximum 3 funds selected.
3. Missing data is handled gracefully: sections with no data are hidden or show "—".
4. No Morningstar ratings or star ratings — ever.
5. No "Fund A is better" or "You should switch" copy.
6. Holding overlap = intersection of top-10 holdings (by name) / union, expressed as a percentage.
7. Trailing returns are computed from NAV history for 1Y, 3Y, 5Y periods.
8. `toolsFlags.compareFunds` is flipped to `true` in this milestone.


## Definitions

**Holding overlap** — The percentage of a fund's top holdings that appear in another fund's top holdings. Computed as: `|intersection of top N holdings| / |union of top N holdings| × 100`.

**Trailing return** — Annualised return over a fixed period (1Y, 3Y, 5Y) computed from end NAV / start NAV. CAGR formula: `((endNAV / startNAV) ^ (1 / years)) - 1`.

**Comparison column** — One column per selected fund in the side-by-side layout. On narrow screens, use horizontal scroll within a section.


## Scope

- `compareFunds.ts` — `computeOverlap(holdingsA, holdingsB)` + trailing return helpers
- `ClearLensCompareFundsScreen` — fund picker + comparison sections
- Fund picker UX:
  - Multi-select from user portfolio (tap to select/deselect)
  - Show selected count (2 or 3)
  - "Compare" button enabled when ≥2 selected
- Comparison sections (each section rendered only if data exists):
  1. Basic details — name, category, fund age
  2. Costs — expense ratio
  3. Benchmark
  4. Trailing returns — 1Y, 3Y, 5Y annualised
  5. Asset allocation — equity/debt/cash %
  6. Market-cap mix — large/mid/small %
  7. Sector exposure — top 3 sectors
  8. Top holdings — top 5 holdings per fund
  9. Holding overlap — % between each pair
- Objective insight card at bottom (safe copy only):
  - "These funds share X% of their top holdings."
  - "Fund A has a lower expense ratio."
  - No "Fund A is better" or recommendations
- `toolsFlags.compareFunds` set to `true`
- Route `app/tools/compare-funds.tsx`


## Out of Scope

- Comparing funds outside user portfolio
- Morningstar ratings
- Buy/sell/hold recommendations
- "Best fund" labels
- Category averages (unless already in data)
- Risk ratios (Sharpe, Sortino) — include only if data is already available


## Approach

The fund picker renders the user's current holdings list. The comparison screen layout uses a section-per-row approach with columns for each fund. Because 3-column layouts can be tight on small phones, the comparison table within each section should support horizontal scroll if needed.

Data for each section comes from existing hooks:
- Trailing returns: compute on the fly from NAV history (reuse pattern from Past SIP Check)
- Composition: `useFundComposition` per fund
- Fund meta: existing `useFundDetail` hook or direct Supabase query on `fund_meta`

The holding-overlap calculation is a pure function tested independently.


## Validation

1. `npx jest src/utils/__tests__/compareFunds.test.ts` — all pass
2. `npm run typecheck && npm run lint` — zero errors/warnings
3. `npx jest --coverage` — overall ≥70%, src/utils ≥95%
4. Open app → Tools Hub → Compare Funds card is now tappable
5. Select 2 funds → Compare → all sections render (or gracefully absent)
6. Select 3 funds → all 3 columns render
7. Holding overlap shows a sensible % between two known-similar funds
8. No Morningstar/advisory copy anywhere in the screen
9. Missing expense ratio → expense ratio row shows "—" not crash


## Risks And Mitigations

| Risk | Mitigation |
|---|---|
| 3-column layout too wide on 375px phones | Wrap each section in a horizontal ScrollView |
| Fund composition data may be null | Guard every section with `if (!data)` — omit section rather than crash |
| Trailing return calculation may lack 5Y NAV | Show only available periods; hide missing period column |
| Holding overlap requires aligned holding names | Use case-insensitive name match; surface count of matched vs total |


## Decision Log

- **2026-05-01**: User-held funds only — consistent with M2; M6 expands scope.
- **2026-05-01**: Max 3 funds — matches PRD; more than 3 makes the layout unreadable on mobile.
- **2026-05-01**: Top-10 holdings for overlap — common industry practice; clearly disclosed.
- **2026-05-01**: No risk ratios (Sharpe etc.) in M3 — data availability unknown; add in M6 if data exists.


## Progress

- [x] Branch `feat/tools-hub-m3-fresh` created off `feat/tools-hub-m2-fresh`
- [x] M3 ExecPlan written and re-homed to `phase-4-tools-hub/`
- [x] Confirmed data availability: `fund` (expense_ratio, aum_cr, isin, benchmark_index, scheme_category) + `fund_portfolio_composition` via `fetchCompositions` + `nav_history` via `fetchPerformanceTimeline`
- [x] `compareFunds.ts` overlap (Jaccard with ISIN-first key) + trailing return (CAGR) + 22 unit tests
- [x] `ClearLensCompareFundsScreen` implemented (chips + bottom sheet picker + 8 horizontally-scrollable comparison sections + overlap card)
- [x] `app/tools/compare-funds.tsx` route created
- [x] `toolsFlags.compareFunds` set to `true`
- [x] typecheck + lint + tests green (610 pass)
- [ ] PR raised against `main` (stacked on M2 PR #99)
- [ ] Local QA pass
