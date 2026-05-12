---
name: qa-pr
description: >
  Run a full QA pass on a FolioLens pull request. Tests the PR's claimed fixes AND
  runs a regression check across every screen, theming, UX, cache, and layout to
  catch unintended breakage. Compares the Vercel preview against production.
  Use when: "QA PR #X", "test this PR", "validate the preview", "check the deploy",
  or any mention of testing a FolioLens PR or Vercel preview URL (foliolens-*.vercel.app).
---

# FolioLens PR QA

You are running a full QA pass on a FolioLens pull request. You have two jobs:

1. **Verify the PR does what it claims** — targeted tests for each fix/feature in the PR description
2. **Catch regressions** — walk every major screen to ensure nothing else broke

Read `../../references/app-reference.md` for the canonical app reference pointer — routes, cache keys, theming, UX principles, bug classes.

## Inputs

You need:
- **PR number** — ask if not provided
- **Vercel preview URL** — find in PR's GitHub comments (Vercel bot), or ask
- **Production URL** — always `https://app.foliolens.in`

## Process

### 1. Context

1. Open the PR on GitHub and read the description. Understand what changed, which files, which screens affected
2. Open the Vercel preview in one Chrome tab, production in another
3. Start console monitoring — watch throughout the entire session
4. Create a task list tracking each phase

### 2. PR-Specific Verification

For each claimed fix/feature in the PR description, create a targeted test and verify it works. Cross-reference the modified files with affected screens. This is the "does the PR do what it says" part.

### 3. Screen-by-Screen Regression

Walk through every primary screen on the preview and verify it loads, renders data, and looks correct. Refer to `../../references/app-reference.md` for what to check on each screen.

**Must-visit screens:** Portfolio (`/`), Funds (`/funds`), at least 2 Fund Details (`/fund/[code]`), Money Trail (`/money-trail`), Wealth Journey (`/wealth-journey`), Portfolio Insights (`/portfolio-insights`), Tools Hub (`/tools`), Past SIP Check (`/tools/past-sip-check`), Compare Funds (`/tools/compare-funds`), Settings, Data Sync (`/settings/data-sync`).

### 4. Cross-Screen Consistency

Verify the same data matches everywhere it appears:
- Portfolio value: Portfolio hero ↔ Wealth Journey
- XIRR: Portfolio hero ↔ Wealth Journey
- Per-fund values: Portfolio card ↔ Fund Detail header
- Transaction totals: Money Trail ↔ Portfolio invested amount

### 5. Theming

Test BOTH light and dark mode. For each:
- Switch theme via Settings
- Walk through at least: Portfolio, Fund Detail, Money Trail, Settings
- Check: `heroSurface` stable (dark navy in both themes), text contrast, chart readability, no raw colour leaks, delta formatting (▲ green / ▼ red)
- System theme follows OS preference

### 6. UX Principles

As you walk through screens, verify:
- Lead with the answer (key metrics visible without scrolling)
- No unexplained jargon (XIRR labelled as "Your real return")
- Delta formatting correct (arrow + sign + colour agree)
- No colour-only meaning
- Touch targets ≥ 40px
- No text clipping on financial values

### 7. Cache & Performance

- Soft-reload: `[persister] cache restored` fires (<300ms)
- Back-navigation: Fund Detail → Portfolio paints instantly
- Previously-viewed Fund Detail opens <500ms
- If PR touches cache/persister: clear localStorage + hard refresh, verify bounded NAV fetch (~300 rows)
- If PR touches sync: test Data Sync flow, verify 8 keys invalidated

### 8. Responsive Layout

If possible, test at both breakpoints:
- Mobile (<1024px): bottom tab bar, full-width
- Desktop (≥1024px): 240px sidebar, content max 760px (920px for Fund Detail)
- No horizontal scroll on any screen

### 9. Preview vs Production Comparison

Compare preview against production:
- Core numbers must match (same backend): portfolio value, XIRR, gain, today's change
- All three benchmark charts render on both
- If benchmark percentages differ, assess whether the PR explains it. Flag if unexplained
- Visual parity: theme, layout, components
- No new 404s on preview
- Fund Detail spot-check: same fund on both

### 10. Console Health

Check console at end of session:
- FAIL: any red errors, `Unhandled Promise rejection`, React #418/#423, `[persister]` errors
- EXPECTED: `[persister] cache restored`
- INFO: `[perf]` marks

### 11. Report

Save to `~/Desktop/FoliolensQA/PR [NUMBER]/QA_Report_PR[NUMBER].md`. Use the report template from `../../references/app-reference.md`. Save screenshots of any bugs to the same folder.
