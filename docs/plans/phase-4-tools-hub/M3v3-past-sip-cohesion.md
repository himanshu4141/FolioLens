# M3v3 — Past SIP Check: Tools Hub cohesion redesign

**Branch:** `claude/past-sip-cohesion-redesign`
**Spec:** `project/design_handoff_past_sip/README.md`

---

## Goal

Bring Past SIP Check onto the shared Tools kit so it reads as one product family with Compare ("What's Different"), Direct vs Regular, and Goal Summary — without touching the simulation math, data flow, or state model.

---

## User Value

A user opening any Clear Lens tool should feel like they're inside one coherent product. Before this change, Past SIP Check had its own bespoke title block, banner card, and stat layout — visually diverged from the other tools despite sharing the same data patterns. After this change it uses the same `ToolTitleBlock`, `ToolResultHero`, `StatusChip`, `RevealSection`, and `ClearLensCard` that every other tool uses.

---

## Context

Phase 4 (Tools Hub) introduced a shared cohesion kit in PR #246 (Direct vs Regular redesign). That PR shipped:

- `src/components/clearLens/tools/kit/ToolTitleBlock.tsx` — eyebrow / h1 / subtitle
- `src/components/clearLens/tools/kit/ToolResultHero.tsx` — dark `heroSurface` answer card
- `src/components/clearLens/tools/kit/StatusChip.tsx` — mint / amber / neutral chip
- `src/components/clearLens/tools/kit/RevealSection.tsx` — animated "See the …" disclosure
- `src/components/clearLens/tools/kit/index.ts` — barrel export

This plan applies that kit to Past SIP Check. The target file is `src/components/clearLens/screens/tools/ClearLensPastSipCheckScreen.tsx`.

---

## Assumptions

1. The Tools kit is already merged to `main` (PR #246).
2. `ClearLensCard` from `ClearLensPrimitives.tsx` is used as the standard card primitive.
3. `tokens.semantic.chart.*` tokens exist for fund / benchmark / invested series.
4. `ToolResultHero`'s `subtitle` prop accepts only `string` (not `ReactNode`); colored gain text must go in `children`.
5. The window chip is `neutral` (never mint/amber) — this is a backtest, not a pass/fail verdict.

---

## Definitions

- **Tools kit** — the shared primitive set in `src/components/clearLens/tools/kit/`.
- **Window chip** — a neutral `StatusChip` in the hero's top-right corner showing the backtest duration and year range (e.g., "3Y · 2022–2025").
- **RevealSection** — collapsible "See the numbers" / "Hide the numbers" disclosure. XIRR rows and lead-over-benchmark live inside it; the headline rupee comparison stays visible outside.
- **Cohesion fix** — replacing a bespoke local pattern with the equivalent shared kit primitive.

---

## Scope

Five cohesion changes to `ClearLensPastSipCheckScreen.tsx`:

1. **Title block** — replace both `preview` and `live` bespoke title `View` groups with `ToolTitleBlock`. Standardize to single eyebrow / h1 / subtitle strings.
2. **Result hero** — replace `<View style={styles.banner}>` group with `ToolResultHero`. Add neutral window chip via `buildWindowChip()` helper.
3. **RevealSection** — in the vs-card, move XIRR rows + lead + `BENCHMARK_DISCLOSURE` behind `RevealSection label="See the numbers"`.
4. **Card primitive** — replace all local `<View style={styles.card}>` with `ClearLensCard`.
5. **Chart tokens** — color the three series from `tokens.semantic.chart.fund`, `.benchmark`, `.invested` instead of hand-picking token colors.

---

## Out of Scope

- `simulatePastSip`, `buildPastSipChartSeries`, `durationToMonths` (no math changes).
- `UniversalFundPicker`, `ClearLensSegmentedControl`, `CustomDurationPicker` (no behavioral changes).
- `PortfolioDisclaimer` and the local estimates footnote.
- The route file `app/tools/past-sip-check.tsx` (unchanged).
- Hub entry card in `ClearLensToolsScreen.tsx` (unchanged).
- Best/worst 3-month stretch stat rows (not computed cheaply; deferred).

---

## Files changed

| File | Change |
|------|--------|
| `src/components/clearLens/screens/tools/ClearLensPastSipCheckScreen.tsx` | Full internal rewrite per spec. Export name + data flow preserved. |
| `docs/plans/phase-4-tools-hub/M3v3-past-sip-cohesion.md` | This file. |

---

## Standard title strings

```ts
eyebrow:  "Past SIP Check"
h1:       "How would a past SIP have grown?"
subtitle: "See how a monthly SIP into any fund — yours or any in our catalog — would have grown, compared with a benchmark."
```

Used by both the `previewMode` branch and the live result branch.

---

## Window chip format

```ts
function buildWindowChip(duration, startDate, endDate): string
// "3Y · 2022–2025"  for a fixed window with known dates
// "2Y 6m · 2023–2025"  for a custom window
// "All · 2018–2025"  for All time
// Falls back gracefully when dates are null.
```

---

## Voice guardrail

FolioLens **does not** recommend or rank funds. Past SIP describes the backtest result and states math only. The existing "You're ₹X ahead" / "{benchmark} is ₹X ahead — N% extra per year" verdict line is **descriptive and stays**. Never use: *should / best / worth it / fair trade / we recommend / better choice*.

---

## Progress

- [x] Read design handoff spec (`project/design_handoff_past_sip/README.md`)
- [x] Rebase onto `main` (post PR #246 merge)
- [x] Rewrite `ClearLensPastSipCheckScreen.tsx` internals:
  - [x] Cohesion fix 1: `ToolTitleBlock` in both branches
  - [x] Cohesion fix 2: `ToolResultHero` + neutral window chip
  - [x] Cohesion fix 3: `RevealSection` ("See the numbers") in vs-card
  - [x] Cohesion fix 4: `ClearLensCard` for inputs card + vs-card + chart card
  - [x] Cohesion fix 5: `tokens.semantic.chart.*` series colors
- [x] TypeScript check — no new errors beyond pre-existing env-level issues
- [x] Write ExecPlan
- [ ] PR raised and merged
