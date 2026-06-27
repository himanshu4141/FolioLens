# M4 — Direct vs Regular: Cohesion Redesign

**Branch:** `claude/direct-vs-regular-redesign-jte67z`  
**Spec:** `design_handoff_direct_vs_regular/README.md`

---

## Scope

Redesign the Direct vs Regular Impact tool to match the Phase-4 design handoff. Builds a shared kit that all other Clear Lens tool screens reuse, replaces the old prescriptive "What to do" card with a descriptive "What this means" card, and upgrades the cost-drag math to per-fund personalization (sibling ER lookup via `family_name` in `scheme_master`).

---

## Decisions

| # | Question | Decision |
|---|----------|----------|
| 1 | Direct-counterpart ER source | Real sibling lookup via `family_name` + category-constant fallback (`CATEGORY_COMMISSION_PCT`) + 0.70% flat last resort |
| 2 | SIP in drag | Holdings-only (`monthlySip: 0`) — honest number for what the user already holds |
| 3 | Unknown-plan funds | Count-only in the hero subtitle; excluded from drag totals |

---

## Files changed

### New — kit primitives

| File | Purpose |
|------|---------|
| `src/components/clearLens/tools/kit/ToolTitleBlock.tsx` | Eyebrow + h1 title + optional subtitle, shared across all tool screens |
| `src/components/clearLens/tools/kit/ToolResultHero.tsx` | Dark heroSurface answer card: label / value / subtitle / chip slot |
| `src/components/clearLens/tools/kit/StatusChip.tsx` | Mint / amber / neutral chip with dot indicator; `onDark` variant |
| `src/components/clearLens/tools/kit/RevealSection.tsx` | Animated "See the …" disclosure; `dark` prop for hero-surface use |
| `src/components/clearLens/tools/kit/index.ts` | Barrel export |

### Modified

| File | Change |
|------|--------|
| `src/utils/directVsRegularCalc.ts` | Added `DirectErSource`, `FundDragInput`, `FundDragResult`, `computeFundDrags`, `weightedFeeGapPct` |
| `src/components/clearLens/screens/tools/ClearLensDirectVsRegularScreen.tsx` | Full rewrite per spec |

### New — tests

| File | Coverage |
|------|---------|
| `src/utils/__tests__/directVsRegularCalc.test.ts` | `detectPlanType`, `projectFutureValue`, `computeCostImpact`, `buildPlanBreakdown` |

---

## Screen flow

```
ToolTitleBlock
  └─ "How much do plan fees add up to?"

InputsCard                  ← horizon segmented control
  ├─ personalized: detected fee gap (read-only)
  └─ illustrative: SIP text input + 0.70% label

ToolResultHero              ← dark heroSurface card
  ├─ label: "Cost drag on your regular-plan holdings · {H}"
  │         or "Illustrative cost drag over {H}"
  ├─ value: −₹X.XX L
  ├─ chip: StatusChip mint "Detected from your funds"
  │         or mint "All direct — no drag"
  └─ RevealSection "See the assumptions"
       └─ AssumptionRows (base return, ER gap, horizon)

ClearLensCard "What this means"
  └─ descriptive prose only; no recommendations

ClearLensCard "Your portfolio"
  └─ PerFundRow × N  (name + Regular badge + value·ER·direct ER + drag)

PortfolioDisclaimer
```

---

## Branch states

| State | Trigger | Renders |
|-------|---------|---------|
| Preview | `previewMode === true` | `ToolsPreviewSampleCard` with frozen sample data |
| No user | `!userId` | Sign-in prompt |
| Loading | `fundsQuery.isLoading` | Spinner card |
| Error | `fundsQuery.isError` | Error card with retry button |
| No funds | `allFunds.length === 0` | Illustrative content with empty-state message |
| Personalized | regular funds detected + drags computed | Full personalized flow |
| All-direct | all funds are direct | Illustrative content with "All direct" hero |

---

## Math

Per-fund drag (holdings-only basis):

```
deltaDecimal = max(0, (regularEr − directEr) / 100)
drag         = projectFV(currentValue, 0, years, 0.10)
             − projectFV(currentValue, 0, years, 0.10 − deltaDecimal)
totalDrag    = Σ drag_i
wGapPct      = Σ(deltaDecimal_i × 100 × value_i) / Σ value_i
```

---

## Voice rules (banned copy)

`fair trade` · `worth it` · `you should` · `better` · `best` · `we recommend` · `consider switching` · `your advisor can help`

Footer: *"FolioLens does not recommend funds or plans."*
