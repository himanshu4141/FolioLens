# M4 — Direct vs Regular Impact (Phase 4 Tools Hub)

> Originally drafted on the stacked branch `feat/tools-hub-m4` (atop M3). Stacked here as `feat/tools-hub-m4-fresh` on top of M3-fresh once the M2/M3 PRs were raised against `main`.
>
> **Scope amendment.** The original plan envisaged 4 cross-app additions (Portfolio cost insight card, Portfolio Insights Cost & Fees section, Your Funds plan-type chip, Fund Detail Plan Cost card). Without a `direct_expense_ratio` mapping in the database, those entries either fall back to a flat 70 bps assumption or have to surface "limited data" everywhere. The tool screen already exposes the 70 bps assumption transparently and lets the user dial it. We've **deferred the 4 cross-app additions to a follow-up milestone (M4b)** — they belong with a real direct/regular mapping rather than a heuristic quietly hardcoded into five places. The tool screen alone gives users the punchline.

## Goal

Show users the estimated long-term cost difference between direct and regular mutual fund plans in their portfolio. This is cost transparency, not advice — no "switch now" language.


## User Value

A user holding regular-plan funds is unknowingly paying a higher expense ratio than necessary. Over 10 years this can compound into a significant drag. FundLens should surface this objectively: "Based on your current value and SIP, this could reduce your future value by around ₹2.4L over 10 years." No recommendations. No shaming. Just the number.


## Context

**Stacked on:** `feat/tools-hub-m3` → this branch is `feat/tools-hub-m4`.

**Depends on:**
- `fund_meta` table — must have `expense_ratio` and ideally a `plan_type` field (`direct` / `regular` / unknown)
- Direct/regular mapping — whether the scheme master can identify the direct counterpart and its expense ratio
- Existing portfolio data (`usePortfolio`) for current value and detected SIP
- Check `docs/TECH-DISCOVERY.md` before implementing — the feasibility of direct/regular detection determines which path to take

**New files:**

```
app/tools/
  direct-vs-regular.tsx                    — Expo Router route
src/components/clearLens/screens/tools/
  ClearLensDirectVsRegularScreen.tsx       — tool screen
src/utils/
  directVsRegularCalc.ts                   — cost-impact calculation (pure functions)
src/utils/__tests__/
  directVsRegularCalc.test.ts              — unit tests
docs/plans/phase4-tools-hub/
  M4-direct-vs-regular-impact.md           — this file
```

**Cross-app additions (also in this milestone):**
- Portfolio screen — cost insight card (if regular funds detected)
- Portfolio Insights screen — Cost & Fees section
- Your Funds screen — plan-type chip on fund rows
- Fund Detail screen — Plan Cost card


## Assumptions

1. "Plan type" detection uses `fund_meta.plan_type` if available; otherwise falls back to scheme name parsing (look for "Direct" in fund name — common AMFI convention).
2. If plan type is unknown, the fund is excluded from cost impact calculations and shown as "Unknown plan type".
3. Expense ratio for the direct counterpart is taken from `fund_meta` if the mapping exists; otherwise this fund's impact is not computed.
4. Cost impact formula: uses future-value projection comparing two growth rates (regular expense ratio vs direct expense ratio) over a horizon.
5. SIP assumption: detected SIP from `usePortfolio` if available; manual override allowed.
6. Return assumption: fixed at 10% p.a. (Balanced) for cost comparison. The comparison is differential — the absolute return assumption cancels out in the comparison.
7. No "switch now" advisory language anywhere.
8. No red shaming treatment for regular plans — neutral, informational tone.
9. `toolsFlags.directVsRegular` set to `true` in this milestone.


## Definitions

**Direct plan** — A mutual fund plan sold directly by the AMC without a distributor. Lower expense ratio.

**Regular plan** — A mutual fund plan sold through a distributor. Higher expense ratio by the amount of distribution commission.

**Expense ratio delta** — The difference in annual expense ratio between regular and direct variants of the same scheme.

**Cost impact** — The estimated reduction in future corpus due to the higher expense ratio, computed as:
```
costImpact = FV(currentValue + SIP × months, regularReturn) 
           - FV(currentValue + SIP × months, directReturn)
```
where `regularReturn = baseReturn - expenseRatioDelta` and `directReturn = baseReturn`.

Simplified delta formula (approximate, sufficient for display):
```
costImpact ≈ corpus × ((1 + directReturn)^years - (1 + regularReturn)^years)
```


## Scope

### Tool screen

- `directVsRegularCalc.ts` — pure functions for cost impact, weighted expense ratio
- `ClearLensDirectVsRegularScreen`:
  - Portfolio-level estimated cost impact
  - Fund-level breakdown table (fund name, plan type, expense ratio, estimated impact)
  - Horizon selector: 5Y / 10Y / 15Y / 20Y (default 10Y)
  - SIP assumption: detected or manual override
  - Assumption disclosure
  - "You may want to review this with your advisor or platform." (safe CTA)
- `toolsFlags.directVsRegular` set to `true`

### Cross-app (same PR)

**Portfolio screen** — show `CostInsightCard` between allocation preview and entry rows, only if ≥1 regular fund detected:
```
Cost insight
You hold 3 regular-plan funds.
Estimated long-term impact: ₹2.4L over 10 years.
Review impact →
```
If all direct:
```
Cost insight
All detected funds are direct plans. No regular-plan cost drag found.
```
If unknown: no card shown.

**Portfolio Insights screen** — add "Cost & Fees" section (after top holdings):
- Direct vs regular split (count and %)
- Weighted expense ratio across portfolio
- Estimated 10Y cost impact

**Your Funds screen** — add plan-type chip to each fund row:
- `Direct` chip in mint/emerald
- `Regular` chip in amber
- No chip if unknown

**Fund Detail screen** — add Plan Cost card in Performance tab:
- Direct: "You hold the direct plan. Expense ratio: X%."
- Regular: "You hold the regular plan. Expense ratio: X%. Direct variant: Y%. Estimated impact: ₹Z over 10 years."
- Unknown: "Plan type not detected."


## Out of Scope

- Advising user to switch
- Executing any transaction
- Tax impact of switching
- Exit load calculation
- All-fund direct/regular mapping (M6)


## Approach

The detection logic is a prerequisite. Before writing UI code, confirm:
1. Does `fund_meta` have `plan_type` and `direct_expense_ratio` columns?
2. If not, can plan type be detected from scheme name?
3. If not detectable for most funds, show a "limited data" state gracefully.

The calculation is a pure function — easy to test. The cross-app additions are additive (no existing behaviour changed).


## Validation

1. `npx jest src/utils/__tests__/directVsRegularCalc.test.ts` — all pass
2. `npm run typecheck && npm run lint` — zero errors/warnings
3. `npx jest --coverage` — overall ≥70%, src/utils ≥95%
4. Open app → Tools Hub → Direct vs Regular card is now tappable
5. Tool screen shows portfolio-level impact (or "limited data" if detection fails)
6. Change horizon from 10Y → 20Y → impact value updates
7. Portfolio screen shows cost insight card if any regular fund detected
8. Portfolio Insights → scroll to Cost & Fees section
9. Your Funds → each fund row shows plan-type chip
10. Fund Detail → Plan Cost card shows for a known regular/direct fund
11. No "switch now", "recommend", or advisory language anywhere


## Risks And Mitigations

| Risk | Mitigation |
|---|---|
| `fund_meta` lacks plan type or direct expense ratio | Fall back to scheme name parsing; if still unknown, show "plan type not detected" gracefully |
| Cross-app changes touch 4 screens — regression risk | Run full test suite; manual smoke test on Portfolio, Portfolio Insights, Your Funds, Fund Detail |
| Direct expense ratio unavailable for most funds | Show "limited data" banner; compute only for funds where ratio is known |
| PR diff is large (tool + 4 cross-app screens) | Keep cross-app additions additive only — no existing behaviour modified |


## Decision Log

- **2026-05-01**: 10% p.a. base return for comparison — differential is what matters; absolute return assumption cancels in the subtraction.
- **2026-05-01**: Neutral tone ("You may want to review...") — PRD advisory boundary, no "switch now".
- **2026-05-01**: Cross-app additions in same PR as tool screen — they are small, self-contained additions and shipping them together keeps the feature coherent.
- **2026-05-01**: Plan type detection via name parsing if `fund_meta` lacks column — AMFI naming convention is consistent ("Direct Plan" in scheme name).


## Progress

- [x] Branch `feat/tools-hub-m4-fresh` created off `feat/tools-hub-m3-fresh`
- [x] M4 ExecPlan written and re-homed to `phase-4-tools-hub/`
- [x] `directVsRegularCalc.ts` (plan-type detection from scheme name + future-value differential + plan breakdown) + 22 tests
- [x] `ClearLensDirectVsRegularScreen` implemented (portfolio split + horizon + SIP + delta inputs + cost-drag banner + detail rows + info card)
- [x] `app/tools/direct-vs-regular.tsx` route created
- [x] `toolsFlags.directVsRegular` set to `true`
- [ ] Portfolio screen — cost insight card added (deferred to M4b)
- [ ] Portfolio Insights screen — Cost & Fees section added (deferred to M4b)
- [ ] Your Funds screen — plan-type chips added (deferred to M4b)
- [ ] Fund Detail screen — Plan Cost card added (deferred to M4b)
- [x] typecheck + lint + tests green (632 pass)
- [ ] PR raised against `main` (stacked on M3 PR #100)
- [ ] Local QA pass
