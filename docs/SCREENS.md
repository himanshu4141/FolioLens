# FolioLens — Screens & Navigation

Clear Lens is the only app design. It ships in two colour schemes — **light** (default) and **dark** — picked at Settings → Preferences → Appearance (light / dark / follow system). The legacy Classic mode has been retired.

## Layout modes

The same Clear Lens screens render in two layout modes, gated on viewport width by the `useResponsiveLayout()` hook (`src/components/responsive/`):

- **Mobile** — viewport width < 1024 px, OR any iOS / Android binary regardless of width. Top FolioLens header, bottom tabs, and a stacked single-column body. Title sits in a body-level eyebrow + h1 + subtitle block.
- **Desktop** — viewport width ≥ 1024 px on web. The bottom tab bar is hidden and a 240 px Clear Lens sidebar renders to the left with logo, primary nav, Quick Actions, and an account row that links to Settings. The same `<Tabs>` navigator stays mounted across the breakpoint so resizing preserves the active route. The body retains the same eyebrow + h1 + subtitle title block.

Native binaries (iOS, Android) are hard-locked to mobile.

## Navigation Structure

Primary navigation (mobile bottom tabs, desktop sidebar "Navigate"):

- `Portfolio`
- `Funds`
- `Wealth Journey`

Quick Actions (mobile overflow sheet, desktop sidebar "Quick actions"):

- `Import portfolio`
- `Money Trail`
- `Tools`

Account / Settings:

- Mobile — `Settings` is hidden from the tab bar and opened from the overflow sheet's middle group; sign-out lives in the destructive group of the same sheet.
- Desktop — the sidebar account row links directly to `/(tabs)/settings`. Sign-out lives at Settings → About & support, mirroring mobile.

Stack routes (rendered inside the desktop sidebar shell via `ResponsiveRouteFrame`, full-screen on mobile):

- `Portfolio Insights`, `Your Funds`, and `Fund Detail` are reached from Portfolio and fund rows.
- `Tools Hub` is reached from the sidebar Quick Action, the Portfolio entry rows, and the Wealth Journey "Explore more tools" link.
- `Money Trail` is reached from the sidebar Quick Action, Portfolio preview, Your Funds expanded rows, and Fund Detail.
- `Onboarding / Import CAS` and `PDF Upload` are utility flows used for first-run import and later portfolio maintenance. Onboarding renders inside the sidebar shell on desktop via `DesktopFormFrame`.

Screen families:

- Clear Lens primary tabs use the FolioLens focus-ring header (mobile), the sidebar shell (desktop), restrained bottom tabs (mobile), Inter typography, and tokenized card surfaces.
- Utility / out-of-tabs screens use a back-chip-only chrome header (the body always owns the title) and Clear Lens cards.

## Screen Map

### 1. Portfolio

The Portfolio tab is the default landing screen.

Clear Lens includes:

- dark value hero with total value, today's move, overall gain/loss, and SIP-aware XIRR
- benchmark comparison chip and benchmark selector
- `How your money grew` chart with invested, portfolio, and benchmark worth
- range controls: `1M`, `3M`, `6M`, `1Y`, `3Y`, `All`
- today's best and worst movers with arrowed signed deltas
- Money Trail preview with Indian-financial-year invested, withdrawn, and net-invested summary
- allocation preview when composition data is available
- entries for `Portfolio Insights`, `Your Funds`, and the Wealth Journey teaser path
- loading, empty, import-needed, and pull-to-refresh states

Desktop variant (`ClearLensPortfolioScreenDesktop`) composes the same presentational subcomponents into a 2-column dashboard: the chart, movers, and entry rows on the left (2/3); the asset allocation card, Money Trail preview, and a Wealth Journey teaser on the right (1/3). The mobile single-column remains unchanged.

### 2. Portfolio Insights

Accessible from Portfolio.

Shows portfolio-level composition derived from shared scheme composition data:

- asset allocation donut card
- debt and cash details when relevant
- market-cap donut card
- sector exposure
- top holdings, paginated 10 per page up to the top 30 names
- AMFI disclosure date, stale state, bootstrap sync, and missing-data states

Category-rule fallback renders immediately. AMFI-backed data upgrades the screen when available.

### 3. Your Funds

Primary Clear Lens tab. Also accessible from Portfolio entry rows.

Includes:

- allocation overview with active fund count, top-three share, and largest position
- search
- sort bottom sheet with current value, invested amount, XIRR, benchmark lead, 1-day change, and alphabetical options
- compact fund rows with value and portfolio share
- expandable fund cards with Today and XIRR (right-aligned MetricRow), invested, gain/loss, redeemed, booked P&L (only when realized activity exists), NAV staleness, "NAV · last 30 days" labelled sparkline, and `View transactions`

Desktop variant (`ClearLensFundsScreenDesktop`) replaces the mobile allocation overview with a fund-level summary card: allocation strip, holdings count, top-3 concentration, largest holding (name + % of portfolio), and today's best/worst movers among the user's funds — explicitly *not* portfolio-level metrics like Portfolio value or Your XIRR (those live on Portfolio). The per-fund cards use a hierarchical desktop layout (`FundDesktopCard`): title row + alpha-pp badge ("vs benchmark"), big primary current value with smaller XIRR + Today stats, and a footer with explicit Invested ▏ Gain split. The mobile expanded card and the desktop card stay deliberately separate.

### 4. Fund Detail

Clear Lens Fund Detail includes:

- hero card with fund name, category, current value, invested amount, units, gain/loss, and XIRR
- `View fund transactions` entry to Money Trail pre-filtered for the fund
- tabs: `Performance`, `NAV History`, `Composition`
- Performance chart and growth consistency
- NAV History chart and period stats
- Composition asset mix, market-cap mix, sectors, top holdings, and disclosure footer
- Portfolio Weight card (caps at 460 px wide on desktop so the donut + info pair doesn't drift in whitespace)

On desktop the screen renders inside the sidebar shell with `desktopMaxWidth={920}` — a historical override that pre-dates the 760 → 960 list-tier bump. It's now narrower than the list tier by 40 px; flagged as a known orphan in `DESIGN.md` to drop or align on the next touch. All charts (Performance, NAV, Growth Consistency) read width from `useWindowDimensions` and clamp to `FUND_DETAIL_DESKTOP_MAX` so they grow as the window does. The Growth Consistency bars use equal-slot positioning (`plotWidth / bars.length` per slot) so they span the full plot rather than clustering at the left edge.

### 5. Money Trail

Accessible from Portfolio preview, Quick Actions, expanded fund rows, and Fund Detail.

Shows CAS-derived transaction history:

- header summary for total invested, withdrawn, net invested, and transaction count
- annual summaries by Indian financial year
- search by fund, type, amount, AMC, folio, and reference
- sort bottom sheet for date, amount, and fund-name ordering
- filter bottom sheet for date preset/custom range, transaction type, direction, AMC, fund, amount range, and hidden/reversed inclusion
- active filter chips and clear-filters action
- clean transaction rows with type, fund, date, amount, and status
- full-screen transaction detail with folio, units, NAV, optional details, and how FundLens uses the transaction
- CSV export for the currently visible filtered and sorted list
- empty/no-results/error states

Failed, reversed, stale zero-unit reversal rows, and confidently matched reversal pairs are hidden by default. Switches and reinvested dividends are shown as internal movement so they do not inflate Money Trail net invested.
When Money Trail is opened for a specific fund, summary cards and yearly bars use the same fund-level cost-basis semantics as Fund Detail and Your Funds: switch-ins count as money moving into that fund, switch-outs count as money moving out, and the net figure is the remaining cost basis.

### 6. Wealth Journey

The Wealth Journey tab models future wealth and withdrawal-income scenarios from the real portfolio.

Clear Lens includes:

- home screen with `Your portfolio today`, detected SIP review/edit, and `Your plan at a glance`
- segmented home preview for `Wealth growth` and `Withdrawal income`
- `Adjust your plan` step for future SIP, top-up, saving period, return preset/custom return, withdrawal rate, and post-withdrawal return
- results screen with growth chart, current-vs-adjusted path, milestones, present-value context, withdrawal snapshot, and drawdown view
- edit-SIP modal with detected and manual SIP paths
- persisted Zustand `wealthJourney` state

### 7. Settings

Settings is hidden from the bottom tabs on mobile (opened from the overflow menu) and reached on desktop by clicking the sidebar account row.

Includes:

- account details
- connected accounts and Google linking
- default benchmark preference
- appearance picker: light / dark / system (Settings → Preferences). The choice is persisted in the Zustand `appColorScheme` slot; the picker honours both the active OS scheme and the user override.
- return assumption inputs (Cautious / Balanced / Growth) used by Goal Planner and Wealth Journey
- sync controls
- import tools, auto-forward inbox status, CAS address, PAN management, PDF upload fallback
- sign out (under About & support)

On desktop the hub and all its sub-pages (Account, Preferences, Data sync, Portfolio import, About) cap content at **960 px** — the list tier defined in `DESIGN.md`. Each sub-page wraps its ScrollView body in a centered `frame` view so the cards don't stretch edge-to-edge of the sidebar shell's content area, mirroring the hub's own pattern.

### 8. Tools Hub

Stack route (`/tools`). Clear Lens only — not a bottom tab in this phase.

Entry points:

- Portfolio screen → entry rows → "Tools"
- Wealth Journey screen → "Explore more tools" link (home mode only)

Includes:

- Featured section — Wealth Journey card (always available, navigates to `/(tabs)/wealth-journey`)
- Plan section — Goal Planner card (coming soon, behind `toolsFlags.goalPlanner`)
- Compare section — Compare Funds card (coming soon, behind `toolsFlags.compareFunds`)
- Explore section — Past SIP Check card (coming soon, behind `toolsFlags.pastSipCheck`)
- Cost & Fees section — Direct vs Regular Impact card (coming soon, behind `toolsFlags.directVsRegular`)
- Coming-soon cards are visually muted and non-tappable
- Available tool cards navigate to their respective routes (routes added per milestone)
- Disclaimer footer — "All results are estimates…"

Feature flags live in `appStore.toolsFlags`. All flags default to `false`. Each is flipped to `true` when the corresponding tool milestone ships.

### 9. Onboarding / Import CAS

Reusable for first-run onboarding and later imports.

Main import paths:

- dedicated CAS forwarding address
- CAS request via CAMS / KFintech portal
- direct PDF upload flow

Clear Lens mode uses the same behavior with Clear Lens header, cards, status chips, shadows, radii, and button treatment.

Desktop renders the wizard inside the sidebar shell using `DesktopFormFrame` (centered 720 px column) and suppresses the Stack header that would otherwise duplicate the body's hero ("Import your portfolio" / "Upload a CAS PDF").

### 10. Auth (sign in + magic-link confirm)

Pre-login screens (no sidebar). On mobile, hero gradient strip on top of the form panel inside a single column. On desktop, a 920 px wide rounded card centered on the navy background, hero on the left half (logo + headline + value props), form on the right half (email + magic link + Google + dev shortcut + security note), both vertically centered. Magic-link confirm renders the same envelope illustration centered in a ~460 px column on desktop.
