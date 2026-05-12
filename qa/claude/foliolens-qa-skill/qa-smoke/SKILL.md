---
name: qa-smoke
description: >
  Run a post-release smoke test on FolioLens production (app.foliolens.in).
  A fast critical-path check to verify production is healthy after a deploy.
  Covers every screen, both themes, cross-screen consistency, console health.
  Use when: "smoke test production", "check the release", "is production good",
  "verify the deploy", "post-release check", or after any production deployment.
---

# FolioLens Post-Release Smoke Test

You are running a quick but thorough smoke test against production (`app.foliolens.in`) to verify a release didn't break anything. This is NOT a deep regression — it's a fast critical-path check.

Read `../references/app-reference.md` for the canonical app reference pointer.

## Process

### 1. Setup

1. Open `https://app.foliolens.in` in Chrome
2. Start console monitoring
3. Create a task list

### 2. Critical Path Walkthrough

Hit every screen, verify it loads and renders data. Move quickly — you're checking for crashes and obvious breakage, not pixel-perfection.

| Screen | Route | What to Check |
|--------|-------|---------------|
| Portfolio | `/` | Hero card (value, XIRR, gain, today). All 3 benchmark pills render charts. Fund cards below |
| Funds | `/funds` | Fund list renders. Tap one fund → |
| Fund Detail | `/fund/[code]` | Header renders. Time windows work (try 1Y and All). "All" extends to 2026 |
| Money Trail | `/money-trail` | Transaction list + FY charts render. Filters work |
| Wealth Journey | `/wealth-journey` | Loads. Values match Portfolio hero |
| Portfolio Insights | `/portfolio-insights` | Asset mix + market cap + sector breakdown render |
| Tools Hub | `/tools` | Tool cards load |
| Past SIP Check | `/tools/past-sip-check` | Form loads, can enter a fund |
| Compare Funds | `/tools/compare-funds` | Can select funds, cards render |
| Settings | `/settings` | Page loads, theme toggle visible |
| Data Sync | `/settings/data-sync` | Page loads, "Last sync" date renders (no React #418) |

### 3. Theming Quick Check

1. Switch to dark mode via Settings
2. Check Portfolio and Fund Detail — text readable, charts visible, hero card stable
3. Switch back to light mode — verify no flash, renders correctly

### 4. Cross-Screen Consistency

Quick check: does Portfolio value and XIRR match Wealth Journey? They share cache keys and must be identical.

### 5. Cache Health

1. Soft-reload the page
2. Verify `[persister] cache restored` fires in console
3. Navigate Fund Detail → back to Portfolio — should be instant

### 6. Console Health

Check console:
- FAIL: any red errors, unhandled rejections, React #418/#423, persister errors
- PASS: `[persister] cache restored` fires, zero errors

### 7. Report

Save to `~/Desktop/FoliolensQA/smoke-[YYYY-MM-DD]/smoke_report.md`.

Use a compact format:

```markdown
# Smoke Test — [DATE]

**URL:** app.foliolens.in
**Time:** [time]

## Verdict: [PASS / FAIL]

## Screen Check
| Screen | Status |
|--------|--------|
| Portfolio | |
| Funds | |
| Fund Detail | |
| Money Trail | |
| Wealth Journey | |
| Portfolio Insights | |
| Tools Hub | |
| Past SIP Check | |
| Compare Funds | |
| Settings | |
| Data Sync | |

## Theming: [PASS/FAIL]
## Cross-Screen Consistency: [PASS/FAIL]
## Cache Health: [PASS/FAIL]
## Console: [PASS/FAIL]

## Issues Found
[Any problems — or "None"]
```
