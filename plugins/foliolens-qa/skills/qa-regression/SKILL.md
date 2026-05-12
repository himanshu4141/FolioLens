---
name: qa-regression
description: Run the deepest FolioLens regression pass across every primary screen, state, theme, cache behavior, responsive breakpoint, and console signal. Use before major releases, after large refactors, or when the user asks to test everything, run deep QA, or perform full regression.
---

# FolioLens Full Regression

Run the most thorough web QA pass available for FolioLens. This covers every primary screen, shared financial data, loading and error states where practical, light and dark themes, cache behavior, responsive layout, and final console health.

Load `../references/app-reference.md` before starting.

## Inputs

- URL to test. It may be production, a Vercel preview, or both.
- Authenticated FolioLens session with realistic portfolio data.
- If testing both preview and production, keep them in separate browser contexts or tabs and label findings clearly.

## Workflow

1. Create a detailed task list for setup, route walkthrough, data consistency, theming, UX principles, state coverage, cache/performance, responsive layout, console audit, and report.
2. Open the target URL or URLs in Browser or Playwright. Start console monitoring before the first route load.
3. Visit every screen listed in `../references/app-reference.md`. Fund Detail must be checked for at least three funds, and every time window must render.
4. Exercise interactions: benchmark pills, fund navigation, filters, transaction detail, top holdings pagination, tool forms, theme toggle, and Data Sync when safe.
5. Verify cross-screen consistency for portfolio value, XIRR, overall gain, per-fund values, benchmark direction, and transaction totals.
6. Test light mode across all screens. Then switch to dark mode and repeat the full route walk. Finally check system theme behavior if the environment supports it.
7. Check UX principles while walking: lead with the answer, explain jargon, no color-only meaning, arrow/sign/color agreement, mobile touch targets, no text clipping, title block pattern, and tabular numeric stability.
8. Cover states where feasible: loading, empty data, network error/retry, syncing, stale composition, and `useIsRestoring` rehydrate behavior.
9. Run warm-cache checks, cold-start checks, mutation checks, and cache key integrity checks from the reference when applicable.
10. Test mobile and desktop breakpoints. Resize across the 1024px boundary and confirm the current route is preserved.
11. Perform final console audit and save the report to `/Users/hyadav/Desktop/FoliolensQA/regression-[YYYY-MM-DD]/regression_report.md`.

## Report Requirements

Use the full report template in `../references/app-reference.md`. Include:

- Target URL or URLs, auth state, date, viewport sizes, and browser/tool used.
- Area-by-area result table with clear `PASS`, `FAIL`, `OBSERVATION`, or `NOT TESTED` statuses.
- Bugs with severity, steps, expected behavior, actual behavior, and screenshots.
- Explicit native-only exclusions. Do not imply web QA covered CAS PDF parsing, push links, backgrounding, biometric auth, or OTA application.
