# ExecPlan: M3v3 — Compare Funds "What's Different" (Option C)

**Supersedes:** `M3v2-compare-funds-deep-redesign.md`  
**Status:** Implementation

## Goal
Replace the tabbed, winner-picking Compare screen with a single vertical scroll
of six neutral "finding" cards (Returns → Risk → Cost → What's inside →
Overlap → The basics). Each card leads with a data-built neutral headline,
shows a small in-card bar viz, and hides raw numbers behind a "See the
numbers" reveal.

## Files changed
| File | Action |
|---|---|
| `src/components/clearLens/screens/tools/ClearLensCompareFundsScreen.tsx` | **Complete rewrite** (Option C finding-card scroll) |
| `docs/plans/phase-4-tools-hub/M3v3-compare-funds-whats-different.md` | **New** (this file) |

## What's removed
- `TabKey` enum + `activeTab` state + 6-tab bar
- `deriveHero()` + hero prose banner + `buildHeroSummary()`
- `deriveKeyDifferences()` + `KeyDiffInsight[]` builder + `KeyDifferenceCard`
- `shortSchemeName` as column header (replaced by A/B/C badges)
- `TableScrollHost` horizontal scroll wrapper (Option C row-based vizzes eliminate the need)
- `ReturnsTab`, `RiskTab`, `AssetMixTab`, `SectorsTab`, `HoldingsTab`, `OtherTab` components
- `hasSeededRef` + auto-seed of held funds — the tool now opens to the empty state so the user picks funds intentionally

## What's kept
- All three data fetchers (`fetchSchemes`, `fetchCompositionsForCodes`, `fetchNavHistoryForCodes`)
- All TanStack Query keys + stale times
- Hydration `useQueries` (on-demand edge function calls)
- `handleToggle` + `UniversalFundPicker` wiring
- `previewMode` branch + `ToolsPreviewSampleCard`
- `PortfolioDisclaimer` footer
- `ClearLensScreen` + `ClearLensHeader` shell

## New additions
- `computeMaxDrawdown()` — trailing-5Y peak-to-trough, computed from nav series
- `BADGE_LETTERS/COLORS/SOFT` — stable A/B/C identity palette (local constants)
- `CompareFundData` — assembled per-fund type (scheme + metrics + composition + badge)
- `FundBadge`, `FundChip` — badge identity atoms
- `FindingCard` — poster frame (light / dark hero variant)
- `BarsViz` — in-card horizontal bar rows per fund
- `NumbersReveal` — "See the numbers" collapsible with chevron rotation
- `MarketCapStackBar` — stacked cap bar for What's inside
- `EmptyState`, `OneFundState` — 0/1-fund flow states
- `NoHistoryBanner`, `CrossCategoryBanner` — contextual banners
- `UndoSnackbar` — navy bottom snackbar with 4s auto-dismiss + UNDO
- `fundComparisonCategory()` (`schemeName.ts`) — resolves the SEBI sub-category
  (Large/Mid/Flexi/…) from the AMFI scheme name, since `scheme_category` is only
  the broad class (Equity/Debt/Hybrid) for CAS-imported holdings. Powers the
  cross-category banner + the Returns "same/different category" subline.

## Labels & identity
- Bars, chips, and per-fund rows are labelled with the **fund name**
  (`shortSchemeName(schemeName)`), not the category — every equity fund would
  otherwise read "Equity". The A/B/C badge carries colour identity.
- Category comparisons (cross-category banner, Returns subline) run on
  `fundComparisonCategory()` so Large Cap vs Mid Cap vs Flexi Cap is flagged.

## Card headlines (neutral, data-built)
- **Returns**: `Over 3Y, {hiCat} returned {hi}%; {loCat} returned {lo}%.`
- **Risk**: `Higher returns came with deeper drops.` (only when trade-off holds); else `The worst historical drop ranges from {lo}% to {hi}%.`
- **Cost**: `Costs differ by ₹{range} over 5 years on ₹1L.` / `Costs are close — under ₹200.`
- **What's inside**: `What each fund holds, in equity terms.`
- **Overlap**: `Some top holdings repeat across these funds.` / `Top holdings don't repeat.`
- **The basics**: label-row grid (AMC / Fund size / Benchmark / Exit load / Launched)

## Voice guardrail
Zero uses of: best/worst/winner/leader/top pick/recommended/you should/worth it/better choice.
No coaching card. Rupee math only in Cost card, framed as fee cost.

## States implemented
1. Preview / logged-out
2. Empty (0 funds) — eyebrow + slot diagram + suggestions
3. One fund — summary card + dashed CTA + suggestions
4. Comparing (2–MAX_FUNDS) — 6 finding cards
5. Add fund — UniversalFundPicker bottom sheet
6. Remove + undo — chip × → snackbar 4s
7. Cross-category — warning banner
8. No-history — banner + omit from Returns/Risk
9. Loading / error / stale-composition
