---
name: qa-smoke
description: Run a fast post-release smoke test on FolioLens production. Covers critical screens, theme toggle, cross-screen data consistency, cache restoration, and console health. Use when the user asks to smoke test production, verify a release, check the deploy, or confirm app.foliolens.in is healthy.
---

# FolioLens Production Smoke Test

Run a fast critical-path check against `https://app.foliolens.in`. This is not pixel-perfect QA; it is a production health pass that catches crashes, blank screens, broken routes, data mismatches, and console errors.

Load `../references/app-reference.md` before starting.

## Inputs

- Target URL defaults to `https://app.foliolens.in`.
- An authenticated FolioLens session with portfolio data. If blocked by auth, report the blocker and ask for a test path.

## Workflow

1. Open production in Browser or Playwright and start console monitoring.
2. Visit each critical route: Portfolio, Funds, one Fund Detail, Money Trail, Wealth Journey, Portfolio Insights, Tools Hub, Past SIP Check, Compare Funds, Settings, and Data Sync.
3. Verify each route loads with real data or a deliberate empty state. No blank screens, route errors, or hydration errors.
4. On Portfolio, verify hero value, today's movement, overall gain, XIRR, all three benchmark pills, chart, and fund cards.
5. On Fund Detail, verify header, at least `1Y` and `All` chart windows, and that `All` extends to the current year.
6. Compare Portfolio value and XIRR against Wealth Journey. They must match exactly.
7. Switch to dark mode from Settings, check Portfolio and Fund Detail, then switch back to light or system. Text and charts must remain readable.
8. Soft reload production and verify `[persister] cache restored` appears. Navigate Fund Detail back to Portfolio and check that the screen paints quickly.
9. Check final console health. Any red error, unhandled rejection, React hydration code, or persister error fails the smoke test.
10. Save the report to `/Users/hyadav/Desktop/FoliolensQA/smoke-[YYYY-MM-DD]/smoke_report.md`.

## Report Format

Use the compact smoke template in `../references/app-reference.md`. Include:

- URL and time tested.
- Verdict: `PASS`, `FAIL`, or `PASS WITH OBSERVATIONS`.
- One row per screen.
- Separate status lines for theming, cross-screen consistency, cache health, and console health.
- Issues found, or `None`.
