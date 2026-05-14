---
name: foliolens-qa-pr
description: Run a full Codex QA pass on a FolioLens pull request or Vercel preview. Verifies claimed PR changes, walks the main regression surfaces, compares preview with production, checks themes, cache health, responsive layout, and console errors. Use when the user asks to QA a PR, test a FolioLens preview, validate a deploy, or review a foliolens Vercel URL.
---

# FolioLens PR QA

Run a QA pass that answers two questions:

1. Does this PR do what it claims?
2. Did it break any important FolioLens screen, theme, cache flow, or layout?

Load `../../../../docs/qa/foliolens-app-reference.md` before starting. It is the canonical shared reference for both the Codex plugin and the Claude-style QA skill bundle.

## Inputs

Required inputs:

- PR number or preview URL.
- Production URL: `https://app.foliolens.in`.
- An authenticated FolioLens session with realistic portfolio data. If the browser is not signed in and no dev auth shortcut is available, ask the user for a test path rather than guessing.

Find missing PR context with the GitHub app or `gh pr view`. Find the Vercel preview URL from PR checks/comments when possible.

## Workflow

1. Create a task list for context gathering, PR-specific checks, regression walk, comparison, console audit, and report writing.
2. Read the PR title, description, changed files, and commits. Turn every claimed fix or feature into a concrete targeted test.
3. Open the Vercel preview and production in Browser or Playwright. Keep console monitoring active while testing.
4. Run the targeted PR tests first. Include edge cases implied by changed files, especially cache shape, hydration, chart bounds, theme tokens, sync invalidation, and responsive layout.
5. Walk the preview through these screens: Portfolio, Funds, two Fund Detail pages, Money Trail, Wealth Journey, Portfolio Insights, Tools Hub, Past SIP Check, Compare Funds, Settings, and Data Sync.
6. Compare preview and production for core numbers, route availability, visual parity, benchmark chart behavior, and a Fund Detail spot-check.
7. Test light and dark mode on at least Portfolio, Fund Detail, Money Trail, and Settings. Check that `heroSurface` stays brand-dark and chart labels remain readable.
8. Check cache and performance signals: `[persister] cache restored`, instant Fund Detail back-navigation, no three-state import flicker, and bounded NAV fetches if cache code changed.
9. Check desktop and mobile breakpoints. Desktop should show the 240px sidebar; mobile should show the bottom tab bar. No horizontal scroll.
10. Write the report to `/Users/hyadav/Desktop/FoliolensQA/PR [NUMBER]/QA_Report_PR[NUMBER].md`. Save screenshots of bugs in the same directory.

## Verdict Rules

- `FAIL`: any console error, unhandled rejection, React hydration error, broken primary route, incorrect cross-screen financial data, unusable theme, or PR claim that does not work.
- `PASS WITH OBSERVATIONS`: the PR works, but there are non-blocking UX, performance, or parity notes.
- `PASS`: targeted checks and regression checks pass with no material findings.

## Report Requirements

Use the PR QA template in `../../../../docs/qa/foliolens-app-reference.md`. Include:

- PR number, title, branch, preview URL, production URL, date, and viewport sizes tested.
- Targeted verification results for each PR claim.
- Regression summary table.
- Bugs with severity, steps to reproduce, expected behavior, actual behavior, and screenshot paths.
- Clear `Not Tested` section for native-only flows, auth-blocked flows, or unavailable data states.
