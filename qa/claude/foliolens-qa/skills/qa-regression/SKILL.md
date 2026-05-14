---
name: qa-regression
description: >
  Run a full regression test suite on FolioLens. The most thorough QA mode — tests
  every screen, every state (loading/empty/error/syncing), both themes in depth,
  all UX principles, cache architecture (cold start, warm cache, mutations, key
  integrity), responsive layout at both breakpoints, and full console audit.
  Use when: "full regression", "test everything", "deep QA", "thorough test",
  or before a major release / after a large refactor.
---

# FolioLens Full Regression

You are running the most thorough QA pass possible on FolioLens. This tests the entire app surface — every screen, every state, both themes, all UX principles, full cache architecture, and responsive layout.

Read `../../references/app-reference.md` for the canonical app reference pointer — routes, cache keys, theming, UX principles, bug classes.

## Input

- **URL to test** — ask the user. Could be production (`app.foliolens.in`), a Vercel preview, or both
- If testing both, open each in a separate Chrome tab

## Process

### 1. Setup

1. Open the target URL(s)
2. Start console monitoring — leave it running throughout
3. Create a detailed task list tracking all 10 phases

### 2. Screen-by-Screen Walkthrough

Visit EVERY screen and verify it loads, renders data, and handles interactions. Refer to `../../references/app-reference.md` for what to check on each.

**Full screen list:**
1. Portfolio (`/`) — hero card, benchmark pills (all 3), chart, fund cards
2. Funds (`/funds`) — fund list, sort/filter, tap navigation
3. Fund Detail (`/fund/[code]`) — test at least 3 different funds. Header, all 7 time windows, "All" extends to 2026, composition, back chip
4. Money Trail (`/money-trail`) — transactions, FY charts, filters, CSV export, detail view
5. Wealth Journey (`/wealth-journey`) — values match Portfolio, growth chart
6. Portfolio Insights (`/portfolio-insights`) — asset mix, market cap, sector, top holdings pagination
7. Leaderboard — loads, sortable
8. Tools Hub (`/tools`) — tool cards
9. Past SIP Check (`/tools/past-sip-check`) — valid fund calculation + zero-NAV empty state
10. Compare Funds (`/tools/compare-funds`) — 2-3 fund comparison with charts
11. Goal Planner — card lists, calculations
12. Settings — all sections, theme toggle
13. Data Sync (`/settings/data-sync`) — loads, no #418, "Sync now" works, date updates within ~6s

### 3. Cross-Screen Consistency

Verify every shared data point matches across screens:
- Portfolio value: Portfolio ↔ Wealth Journey
- XIRR: Portfolio ↔ Wealth Journey
- Overall gain: Portfolio ↔ Wealth Journey
- Per-fund NAV/gain/XIRR: Portfolio card ↔ Fund Detail ↔ Compare
- Benchmark %: Portfolio banner ↔ chart direction
- Transaction totals: Money Trail ↔ Portfolio invested amount

### 4. Theming — Full Check

#### Light Mode
Walk through ALL screens. Check:
- Background/surface: clean light tones (not pure white)
- Text: navy/slate primary, clearly readable
- Hero card: `heroSurface` (dark navy, brand stable)
- Positive/negative: emerald vs red with soft `*Bg` badge surfaces
- Cards: consistent radius + shadow
- Pills: fully rounded, selected state clear

#### Dark Mode
Switch via Settings. Walk through ALL screens again. Check:
- Text flips to near-white
- `heroSurface` remains identical (brand-dark, unchanged)
- Charts readable — lines, labels, axes visible
- No raw `ClearLensColors.X` leaking through (must be semantic tokens)
- Borders/dividers visible but subtle
- Overlays/modals use correct backdrop
- No flash of light content between navigations

#### System Theme
- "System" follows OS preference
- Toggle OS theme mid-session — app updates (if supported)

### 5. UX Principles

Check across every screen:
- **Lead with the answer:** Key metrics visible without scrolling
- **No jargon:** XIRR labelled "Your real return" or similar
- **Delta formatting:** All ▲/▼ with sign and colour. Arrow, sign, colour must agree
- **No colour-only meaning:** Positive/negative always has text indicator too
- **Touch targets ≥ 40px** on mobile
- **No text clipping:** Financial values, fund names, pills fully visible
- **Title block pattern:** Eyebrow (ALL CAPS, emerald) + H1 + subtitle
- **Numeric stability:** Tabular font, no layout shift on value update

### 6. State Coverage

Verify multiple screens handle all states:
- **Loading:** Clean spinner or skeleton. No blank screen. No "Import CAS" flash (useIsRestoring gate)
- **Empty/No data:** If no funds imported → empty state with CTA
- **Error:** Network failure → error message with retry, not crash
- **Syncing:** During Data Sync → syncing indicator
- **Stale composition:** Missing data → graceful fallback

### 7. Cache & Performance

#### Warm Cache
- Soft-reload: `[persister] cache restored` in console, timing <300ms
- Back-navigation (Fund Detail → Portfolio): instant paint, no spinner
- Previously-viewed Fund Detail: opens <500ms
- Cross-tab: same data in two tabs, no corruption

#### Cold Start
- Clear localStorage → hard refresh
- Portfolio cards appear within ~3s
- NAV fetch is bounded: ~300 rows (90 days), NOT ~12,500
- `useIsRestoring` prevents three-state flicker

#### Mutation Flows
- Data Sync: "Sync now" → "Last sync" updates within ~6s
- Post-sync: navigate to Portfolio + Fund Detail — both show updated data
- 8 cache keys invalidated: `portfolio`, `fund-detail`, `fund-nav-history`, `fund-detail-index`, `investmentVsBenchmarkTimeline`, `performance-timeline`, `portfolio-timeline`, `money-trail`

#### Key Integrity
- No collision between `['fund-detail-index', symbol]` and `['index-history', symbol]`
- `__BUSTER__` version is current (`v2`)
- localStorage: `Object.keys(localStorage).filter(k => k.includes('REACT_QUERY'))` → valid JSON

### 8. Responsive Layout

Test at BOTH breakpoints:

#### Mobile (<1024px)
- Bottom tab bar visible
- Full-width content
- No sidebar
- Touch targets adequate

#### Desktop (≥1024px)
- 240px sidebar: logo, nav items, quick actions, account row
- Content max 760px (920px Fund Detail)
- Back chip suppressed for sidebar-reachable screens

#### Both
- Resize across breakpoint → preserves current route
- Charts clamp width — no overflow
- No horizontal scrollbar on any screen

### 9. Console Health

Final check — should have been monitoring throughout:
- FAIL: red errors, unhandled rejections, React #418/#423, `[persister]` errors
- EXPECTED: `[persister] cache restored`
- INFO: `[perf]` timing marks

### 10. Report

Save to `~/Desktop/FoliolensQA/regression-[YYYY-MM-DD]/regression_report.md`. Use the full report template from `../../references/app-reference.md`. Include screenshots of any issues.
