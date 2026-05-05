# M2 — Past SIP Check (Phase 4 Tools Hub)

> Originally drafted on the stacked branch `feat/tools-hub-m2` (atop M1). M1 has shipped on main; M2 now stacks on `main` directly. This plan was moved from `docs/plans/phase4-tools-hub/` into the active `docs/plans/phase-4-tools-hub/` location.

## Goal

Allow users to simulate how a monthly SIP would have performed in a fund they already hold, comparing it to a benchmark over a user-selected past period.


## User Value

A user wonders: "What if I had put ₹10,000 per month into Axis Bluechip for the last 5 years — how much would I have now, and did it beat Nifty 50?" Past SIP Check answers this with real NAV data from their portfolio holdings, producing total invested, current value, XIRR, and a growth chart.


## Context

**Stacked on:** `feat/tools-hub-m1` → this branch is `feat/tools-hub-m2`.

**Depends on existing data:**
- NAV history for user-held funds (already available in Supabase via the `daily_nav` table or similar — confirm with `docs/TECH-DISCOVERY.md`)
- Benchmark NAV history for Nifty 50 / Nifty 100 / BSE Sensex (already used in Portfolio screen)
- XIRR calculation utility already in `src/utils/xirr.ts`

**New files:**

```
app/tools/
  past-sip-check.tsx                     — Expo Router route
src/components/clearLens/screens/tools/
  ClearLensPastSipCheckScreen.tsx        — full screen component
src/utils/
  pastSipCheck.ts                        — simulation logic (pure functions)
src/utils/__tests__/
  pastSipCheck.test.ts                   — unit tests
docs/plans/phase4-tools-hub/
  M2-past-sip-check.md                   — this file
```


## Assumptions

1. Fund selector shows only user-held funds (not all funds — M6 expands scope).
2. SIP investment date is the 1st of each month (or closest NAV date available).
3. "Current value" = units accumulated × latest NAV.
4. XIRR is calculated using the existing `src/utils/xirr.ts` utility.
5. If selected duration is longer than available fund NAV history, simulation starts from the earliest available NAV date and the screen clearly states this.
6. Benchmark simulation runs in parallel using the same monthly investment dates.
7. Benchmarks available: Nifty 50 (`^NSEI`), Nifty 100 (`^NIFTY100`), BSE Sensex (`^BSESN`).
8. No tax-adjusted returns.
9. No fund recommendations.
10. `toolsFlags.pastSipCheck` is flipped to `true` in this milestone.


## Definitions

**SIP simulation** — A monthly purchase of a fixed amount on a set date using historical NAV prices. Units purchased = amount / NAV on that date.

**XIRR** — Extended Internal Rate of Return. Accounts for the timing of each SIP instalment. Already implemented in `src/utils/xirr.ts`.

**Short-history truncation** — When the user selects 5 years but the fund only has 3 years of NAV data, the simulation runs from the earliest available NAV and displays a notice.


## Calculation Logic

```
For each month in [startDate, today]:
  1. Find the NAV on (or after) the 1st of the month.
  2. units_purchased = sipAmount / nav
  3. Accumulate: totalUnits += units_purchased, totalInvested += sipAmount

currentValue = totalUnits × latestNAV
gain = currentValue - totalInvested
gainPct = gain / totalInvested × 100
xirr = computeXirr(cashFlows)  // negative for each SIP, +currentValue at end
```

Same logic runs on the benchmark NAV series for comparison.


## Scope

- `pastSipCheck.ts` — `simulateSip(navSeries, sipAmount, startDate, endDate)` → result object
- `ClearLensPastSipCheckScreen` — inputs, loading state, results, chart
- Input fields:
  - Fund selector — picker from user portfolio funds
  - SIP amount (₹)
  - Duration — 1Y / 3Y / 5Y / Since inception
  - Benchmark — Nifty 50 / Nifty 100 / BSE Sensex (default: user's default benchmark)
- Result section:
  - Total invested
  - Current value
  - Gain / loss (₹ and %)
  - XIRR
  - Fund vs benchmark XIRR comparison
  - Growth chart — fund line vs benchmark line vs invested line
- Short-history notice if applicable
- `toolsFlags.pastSipCheck` set to `true`
- Route `app/tools/past-sip-check.tsx`


## Out of Scope

- All mutual funds (M6 expands this)
- Lumpsum mode
- Multiple SIP dates per month
- Tax-adjusted returns
- Fund recommendations


## Approach

The screen fetches NAV history for the selected fund from Supabase. It uses a similar query pattern to `usePerformanceTimeline`. The simulation is a pure function in `pastSipCheck.ts` — easy to test.

The benchmark series uses the same approach as `useInvestmentVsBenchmarkTimeline`.

Data requirements to confirm before implementing:
1. What table/view holds NAV history? (`daily_nav`? Check `docs/TECH-DISCOVERY.md`)
2. How far back does NAV history go for user-held funds?
3. Does the benchmark table align dates with the fund NAV table?


## Validation

1. `npx jest src/utils/__tests__/pastSipCheck.test.ts` — all pass
2. `npm run typecheck && npm run lint` — zero errors/warnings
3. `npx jest --coverage` — overall ≥70%, src/utils ≥95%
4. Open app → Tools Hub → Past SIP Check card is now tappable
5. Select a fund → enter ₹10,000 SIP → 3Y → Nifty 50 → results appear
6. Select "Since inception" for a fund with limited history → short-history notice shown
7. Chart renders with 3 lines (fund, benchmark, invested)
8. XIRR matches manual spot check (±0.5%)


## Risks And Mitigations

| Risk | Mitigation |
|---|---|
| NAV table structure unknown | Read `docs/TECH-DISCOVERY.md` before writing the query; mirror pattern from `usePerformanceTimeline` |
| Benchmark dates may not align with fund NAV dates | Use nearest-date lookup (already done in timeline hooks) |
| XIRR may fail to converge for very short simulations | Guard with try/catch; show "—" if convergence fails |
| Fund with 1 month of history | Minimum 3 months required; show "Not enough history" state |


## Decision Log

- **2026-05-01**: User-held funds only in M2 — M6 adds all-fund support.
- **2026-05-01**: 1st of month SIP date — simplest implementation, clearly disclosed.
- **2026-05-01**: XIRR via existing utility — avoids duplicating calculation logic.


## Progress

- [x] Branch `feat/tools-hub-m2-fresh` created off `main` (M1 has merged)
- [x] M2 ExecPlan written and re-homed to `phase-4-tools-hub/`
- [x] Confirmed NAV path: `nav_history` (via `fund.scheme_code`) and `index_history`; reuses `fetchPerformanceTimeline`
- [x] `pastSipCheck.ts` simulation + 31 unit tests (96% statements, 97% lines, 89% branches; uncovered branches are unreachable defensive paths)
- [x] `ClearLensPastSipCheckScreen` implemented
- [x] `app/tools/past-sip-check.tsx` route created
- [x] `toolsFlags.pastSipCheck` set to `true`
- [x] typecheck + lint + tests green (585 tests pass)
- [ ] PR raised against `main`
- [ ] Local QA pass
