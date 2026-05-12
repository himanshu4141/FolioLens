# FolioLens QA Reference

Use this reference from the `qa-pr`, `qa-smoke`, and `qa-regression` skills when you need route details, expected behavior, cache keys, theme rules, common bug classes, or report templates.

## Product Context

FolioLens is an Indian mutual fund portfolio tracker for novice investors. Users import CAS files and should immediately understand daily portfolio movement, portfolio versus benchmark performance, fund versus benchmark performance, fund versus fund comparison, and SIP-aware XIRR.

Core product principles:

- Lead with the answer. The most important portfolio state should be visible without hunting.
- Dejargonify finance terms. If XIRR appears, nearby copy should explain it as the user's real return.
- Minimize noise. Screens should emphasize signal and avoid expert-only clutter.
- Never express gain or loss by color alone. Pair color with arrows, signs, and labels.

## Web Routes

| Route | Screen | Desktop sidebar |
|---|---|---|
| `/` | Portfolio | Yes |
| `/funds` | Funds list | Yes |
| `/fund/[schemeCode]` | Fund Detail | No |
| `/wealth-journey` | Wealth Journey | Yes |
| `/money-trail` | Money Trail | Yes |
| `/portfolio-insights` | Portfolio Insights | Yes |
| `/tools` | Tools Hub | Yes |
| `/tools/past-sip-check` | Past SIP Check | No |
| `/tools/compare-funds` | Compare Funds | No |
| `/settings` | Settings | Yes |
| `/settings/data-sync` | Data Sync | No |
| `/onboarding` | Onboarding | No |

Important: `/compare` is native-only. On web, Compare Funds is `/tools/compare-funds`.

## Screen Expectations

### Portfolio

- Hero card shows portfolio value, today's change, overall gain, and XIRR.
- Benchmark banner states ahead or behind against the selected benchmark.
- Three benchmark pills render and switch the chart and banner: Nifty 50 TRI, Nifty 100 TRI, Nifty 500 TRI.
- "How your money grew" chart shows invested amount, portfolio value, and benchmark.
- Fund cards show name, current value, gain or loss, and correct delta formatting.
- Desktop: 240px sidebar and constrained dashboard layout. Mobile: bottom tab bar and no sidebar.

### Funds

- All held funds render with name, current value, and gain or loss.
- Sort or filter controls work if present.
- Tapping a fund opens Fund Detail.

### Fund Detail

- Header shows fund name, NAV, total value, gain, and XIRR.
- Time windows render: 1M, 3M, 6M, 1Y, 3Y, 5Y, All.
- `All` extends to the current year and is not clipped.
- Composition data renders when available. Missing or stale composition must show a graceful fallback.
- Back chip works and desktop content is capped around 920px.

### Money Trail

- Transaction list renders with hero summary.
- Financial year mini-charts render.
- Financial year and fund filters work.
- CSV export works when available on web.
- Tapping a transaction shows detail.

### Wealth Journey

- Total value, XIRR, and growth chart render.
- Total value and XIRR must exactly match Portfolio.
- Current versus inflation-adjusted growth renders when present.

### Portfolio Insights

- Asset mix shows Equity, Debt, Cash, and Other with semantic colors.
- Market cap breakdown shows Large, Mid, and Small cap segments.
- Sector allocation renders.
- Top holdings paginate in groups of 10, up to 30.
- SEBI or AMFI disclosure text is present.

### Tools

- Tools Hub loads tool cards.
- Past SIP Check accepts a fund and date, calculates results, and shows an empty state for zero-NAV funds.
- Compare Funds allows 2 or 3 funds and renders cards plus charts.
- Goal Planner shows quiet card lists, conservative defaults, and calculated outputs.

### Settings And Data Sync

- Settings sections render, including account and preferences.
- Theme picker supports light, dark, and system.
- Data Sync loads with Last sync date gated on `useIsRestoring`.
- Sync now shows progress and updates Last sync within roughly 6 seconds when the backend is available.

### Onboarding

- Four-step wizard: Welcome, Identity, Import, Done.
- CAS PDF upload form accepts PDFs on supported platforms.
- Identity is write-once after submission.

## Cross-Screen Consistency

The same financial values must render identically wherever they appear:

- Portfolio value: Portfolio hero and Wealth Journey header.
- XIRR: Portfolio hero and Wealth Journey.
- Overall gain: Portfolio and Wealth Journey.
- Per-fund values: Portfolio card, Fund Detail header, and Compare Funds when applicable.
- Benchmark percentage: Portfolio banner and chart direction.
- Transaction totals: Money Trail and Portfolio invested amount.

## Clear Lens Theme Rules

Source of truth: `src/constants/clearLensTheme.ts`, consumed through `useClearLensTokens()`.

- Components should use semantic tokens, not raw `ClearLensColors.X`.
- `heroSurface` is stable brand-dark navy in both light and dark mode.
- Positive values use emerald or green plus soft positive background.
- Negative values use red plus soft negative background.
- Cards use shared radius and subtle shadow.
- Pills are fully rounded and selected state is obvious.
- Dark mode flips text to near-white, keeps charts readable, and uses subtle visible dividers.
- Overlays and modals use the Clear Lens backdrop token.

## UX Checks

- Lead with the answer on the main screen.
- XIRR has plain-English explanation nearby.
- Positive and negative deltas use arrow, sign, and matching color.
- No color-only meaning.
- Mobile touch targets are at least 40px.
- Financial values, fund names, pills, and labels do not clip.
- Primary title block pattern is eyebrow, H1, subtitle.
- Financial numbers use tabular numeric styling and do not cause layout shift.

## Cache And Performance

Persisted cache keys:

- `portfolio`
- `portfolio-composition`
- `investmentVsBenchmarkTimeline`
- `portfolio-timeline`
- `performance-timeline`
- `fund-detail`
- `fund-detail-index`
- `fund-nav-history`
- `money-trail`
- `user-funds`
- `user-transactions`
- `scheme-master`

Important query-key expectations:

- `['user-funds', userId]` is shared by Portfolio and Fund Detail.
- `['user-transactions', userId]` is shared by Portfolio and Fund Detail.
- `['fund-detail-index', symbol]` is distinct from `['index-history', symbol]`.
- `['latest-nav-date']` is used by Data Sync and is not persisted.

Post-sync invalidation should cover:

- `portfolio`
- `fund-detail`
- `fund-nav-history`
- `fund-detail-index`
- `investmentVsBenchmarkTimeline`
- `performance-timeline`
- `portfolio-timeline`
- `money-trail`

Signals to check:

- Soft reload logs `[persister] cache restored`.
- Restore timing should generally be under 300ms.
- Fund Detail back-navigation should paint without a fresh spinner.
- Previously viewed Fund Detail should open quickly.
- Cold start should avoid an Import CAS flash during rehydration.
- NAV fetches should stay bounded when only recent data is needed.

## Responsive Layout

- Mobile below the 1024px breakpoint uses bottom tabs, full-width content, and no sidebar.
- Desktop at or above the 1024px breakpoint uses a 240px sidebar.
- Fund Detail desktop content is wider than the main Portfolio column, around 920px max.
- Resizing across the breakpoint should preserve the current route.
- Charts clamp to viewport width and never create horizontal scroll.

## Console Health

Fail the run for:

- Red console errors.
- Unhandled promise rejections.
- React hydration errors such as React 418 or React 423.
- `[persister]` errors.
- Broken chunks or route load failures.

Expected or informational:

- `[persister] cache restored`.
- `[perf]` timing marks.
- Non-blocking deprecation warnings, unless they break a flow.

## Known Bug Classes

1. Cache-shape collision: two screens write different data shapes to the same key.
2. Hydration mismatch: server and client disagree during rehydrate.
3. Three-state flicker: paused rehydration briefly shows Import CAS or empty fallback.
4. Unbounded fetch: a screen fetches full history when only recent data is needed.
5. Stale post-mutation: sync or import does not invalidate dependent caches.
6. Chart clipping: chart bounds calculations push lines or labels past the canvas.
7. Theme token leak: raw colors bypass semantic Clear Lens tokens.
8. Breakpoint glitch: layout breaks at the 1024px boundary.

## Native-Only Items

Do not mark these as tested from web QA unless explicitly exercised on native:

- Full CAS PDF parsing flow.
- Sign out then sign in as a different account to check data leakage.
- Push notification deep links.
- App backgrounding and foregrounding cache behavior.
- Expo OTA update application.
- Biometric auth.

## PR QA Report Template

```markdown
# QA Report - PR #[NUMBER]

**PR:** [title]
**Branch:** [branch-name]
**Date:** [absolute date]
**Preview URL:** [url]
**Production URL:** https://app.foliolens.in
**Mode:** PR QA
**Viewports:** [desktop/mobile sizes]

## Verdict: [PASS / FAIL / PASS WITH OBSERVATIONS]

[Short summary]

## PR-Specific Verification

| Claim | Status | Notes |
|---|---|---|
| | | |

## Regression Check

| Area | Status | Notes |
|---|---|---|
| Screen walkthrough | | |
| Cross-screen consistency | | |
| Theming | | |
| UX principles | | |
| State coverage | | |
| Cache and performance | | |
| Responsive layout | | |
| Console health | | |
| Preview vs production | | |

## Bugs Found

[Severity, steps, expected, actual, screenshot path]

## Observations

[Non-blocking notes]

## Not Tested

[What was skipped and why]
```

## Smoke Report Template

```markdown
# Smoke Test - [absolute date]

**URL:** https://app.foliolens.in
**Time:** [local time]

## Verdict: [PASS / FAIL / PASS WITH OBSERVATIONS]

## Screen Check

| Screen | Status | Notes |
|---|---|---|
| Portfolio | | |
| Funds | | |
| Fund Detail | | |
| Money Trail | | |
| Wealth Journey | | |
| Portfolio Insights | | |
| Tools Hub | | |
| Past SIP Check | | |
| Compare Funds | | |
| Settings | | |
| Data Sync | | |

## Theming: [PASS/FAIL]
## Cross-Screen Consistency: [PASS/FAIL]
## Cache Health: [PASS/FAIL]
## Console: [PASS/FAIL]

## Issues Found

[Problems, or None]
```

## Regression Report Template

```markdown
# Regression Report - [absolute date]

**URL(s):** [urls]
**Mode:** Full Regression
**Viewports:** [desktop/mobile sizes]
**Browser/tool:** [tool used]

## Verdict: [PASS / FAIL / PASS WITH OBSERVATIONS]

[Short summary]

## Results

| Area | Status | Notes |
|---|---|---|
| Screen walkthrough | | |
| Cross-screen consistency | | |
| Theming | | |
| UX principles | | |
| State coverage | | |
| Cache and performance | | |
| Responsive layout | | |
| Console health | | |

## Bugs Found

[Severity, steps, expected, actual, screenshot path]

## Observations

[Non-blocking notes]

## Not Tested

[Native-only or blocked coverage]
```
