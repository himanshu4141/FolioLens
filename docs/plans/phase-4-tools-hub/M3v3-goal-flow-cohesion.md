# M3v3 — Goal Flow: Tools Hub cohesion redesign

**Branch:** `claude/goal-flow-cohesion-redesign`

---

## Goal

Bring the Goal Planner flow (List → Summary → Create/Edit) onto the shared Tools kit so it reads as one product family with Compare, Direct vs Regular, and Past SIP Check — without touching the goal calculation math, data flow, or state model.

---

## User Value

A user opening any Clear Lens tool should feel like they're inside one coherent product. Before this change, the Goal flow had bespoke title blocks, a tab-based summary with a green/amber banner, and local card styles that diverged from other tools. After this change it uses the same `ToolTitleBlock`, `ToolResultHero`, `StatusChip`, `RevealSection`, and `ClearLensCard` that every other tool uses.

---

## Context

Phase 4 (Tools Hub) introduced a shared cohesion kit in PR #246 (Direct vs Regular redesign), further applied in PR #249 (Past SIP Check). This plan applies that kit to the three Goal flow screens.

**Tools kit location:** `src/components/clearLens/tools/kit/`
- `ToolTitleBlock` — eyebrow / h1 / subtitle
- `ToolResultHero` — dark `heroSurface` answer card
- `StatusChip` — mint / amber / neutral chip
- `RevealSection` — animated "See the …" disclosure
- `index.ts` — barrel export

---

## Assumptions

1. The Tools kit is already merged to `main` (PR #246).
2. `ClearLensCard` from `ClearLensPrimitives.tsx` is the standard card primitive.
3. `ToolResultHero`'s `subtitle` prop accepts only `string` (not `ReactNode`).
4. Voice guardrail: no imperative "Invest ₹X/mo" copy — replaced with descriptive hero subtitle.
5. Scenarios (previously a tab) are re-homed to an "Other scenarios" `ClearLensCard` in the summary scroll.

---

## Scope

### `ClearLensGoalPlannerScreen.tsx`
1. Add `ToolTitleBlock` (eyebrow "Goal Planner", title "Your financial goals") to both empty and list states.
2. Replace bespoke green/amber tag chips with `StatusChip tone="mint"/"amber"`.
3. Wrap `GoalCard`'s `TouchableOpacity` in `ClearLensCard` (padding 0, overflow hidden).
4. Add `PortfolioDisclaimer` to both states.
5. Remove unused `ClearLensShadow`, `card`, `tag*` styles.

### `ClearLensGoalSummaryScreen.tsx`
1. Drop `TabKey`, `TAB_OPTIONS`, `tab` state, `ClearLensSegmentedControl` — single-scroll layout.
2. Add `ToolTitleBlock` (eyebrow "Goal Planner", title = goal name, subtitle = "X-year goal · target by YYYY").
3. Replace bespoke green/amber banner with `ToolResultHero` + mint/amber `StatusChip onDark`.
4. Move return assumption behind `RevealSection("See the assumptions")` inside the key numbers card.
5. Re-home scenarios to an "Other scenarios" `ClearLensCard`.
6. Replace all local `card` styles with `ClearLensCard style={cardNoPad}`.
7. Voice fix: remove imperative "Invest ₹X/mo" — hero subtitle is descriptive.
8. Remove unused `ClearLensShadow`, `banner*`, `tabRow` styles.

### `ClearLensCreateGoalScreen.tsx`
1. Replace bespoke `titleBlock`/`eyebrow`/`title` View group with `ToolTitleBlock`.
2. Replace local `card` View with `ClearLensCard style={formCard}` (padding 0, overflow hidden).
3. Remove unused `ClearLensShadow`, `titleBlock`, `eyebrow`, `title` styles.

---

## Out of Scope

- `computeGoalPlan`, `buildGoalProjectionSeries`, `yearsFromNow`, `assumptionsToRates` (no math changes).
- `app/tools/goal-planner/` route files (unchanged).
- Hub entry card in `ClearLensToolsScreen.tsx` (unchanged).
- `appStore` goal state shape (unchanged).

---

## Files changed

| File | Change |
|------|--------|
| `src/components/clearLens/screens/tools/ClearLensGoalPlannerScreen.tsx` | Cohesion fixes 1–5 |
| `src/components/clearLens/screens/tools/ClearLensGoalSummaryScreen.tsx` | Cohesion fixes 1–8 |
| `src/components/clearLens/screens/tools/ClearLensCreateGoalScreen.tsx` | Cohesion fixes 1–3 |
| `docs/plans/phase-4-tools-hub/M3v3-goal-flow-cohesion.md` | This file |

---

## Standard title strings

```ts
// GoalPlannerScreen (list/empty)
eyebrow:  "Goal Planner"
title:    "Your financial goals"

// GoalSummaryScreen
eyebrow:  "Goal Planner"
title:    goal.name
subtitle: "{N}-year goal · target by {YYYY}"  // or "Goal overdue"

// CreateGoalScreen
eyebrow:  "Goal Planner"
title:    isEditing ? "Edit goal" : "New goal"
```

---

## Voice guardrail

FolioLens does NOT recommend or instruct. The removed banner said `"Invest ₹X/mo to reach your goal"` (imperative). Replacement hero subtitle is descriptive only:
- On track: `"Your ₹X/mo covers this"` or `"On track to reach this goal"`
- Off track: `"₹X/mo gap vs your current ₹Y/mo"`

---

## Progress

- [x] Read current file state (GoalPlannerScreen, GoalSummaryScreen, CreateGoalScreen)
- [x] Read kit primitives (ToolTitleBlock, ToolResultHero, StatusChip, RevealSection, ClearLensCard)
- [x] Rewrite `ClearLensGoalPlannerScreen.tsx`
- [x] Rewrite `ClearLensGoalSummaryScreen.tsx`
- [x] Rewrite `ClearLensCreateGoalScreen.tsx`
- [x] Write ExecPlan
- [ ] TypeScript + lint check
- [ ] PR raised and merged
