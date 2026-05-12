# Phase 5 — Desktop Web Shell

## Goal

Give FundLens a purpose-built desktop web experience so that opening the app on a laptop or
external monitor no longer renders a stretched mobile column. Desktop renders a Clear Lens
sidebar shell with a multi-column dashboard area; phones, tablets in portrait, and the iOS /
Android apps continue to render exactly what they render today on `main`.

The observable result is:

- On a viewport ≥ 1024 px wide on web, the bottom tab bar disappears, replaced by a
  Clear Lens left sidebar containing primary navigation, account label, and quick actions.
- The Portfolio and Funds screens render in a max-width centered grid with desktop-
  appropriate two- or multi-column layouts where the data warrants it.
- Wealth Journey, Fund Detail, Money Trail, Portfolio Insights, Tools, and Settings render
  inside a centered Clear Lens column with the desktop sidebar present.
- Auth (sign in, magic-link confirm) and the CAS onboarding flow render as a centered
  Clear Lens card on a navy background instead of a stretched mobile sheet.
- Resizing the browser below 1024 px reverts to the existing mobile layout instantly.
- iOS and Android binaries are byte-identical to `main` for everything outside the new
  responsive primitives — no native flag, no new native dependency.


## User Value

The launch audience will discover FundLens on Twitter / WhatsApp / blog links, and a
non-trivial fraction will open the link on a laptop. Today they see a 360 px column adrift
in 1440 px of whitespace with a thumb-sized bottom tab bar, which signals "abandoned
prototype". Phase 5 makes desktop look like a deliberate product so the user keeps
exploring instead of bouncing to the App Store landing page.


## Context

FundLens is an Expo Router app on Expo SDK 55, React Native 0.83.2, React 19.2, and
React Native Web 0.21. Today every platform — iOS, Android, mobile web, desktop web —
renders the same component tree:

- `app/_layout.tsx` mounts a `<Stack>` with `auth`, `(tabs)`, `fund/[id]`, `money-trail`,
  `portfolio-insights`, `onboarding`, `tools`.
- `app/(tabs)/_layout.tsx` mounts an Expo Router `<Tabs>` with three visible tabs
  (Portfolio, Funds, Wealth Journey) and a hidden Settings + deprecated Compare.
- Each tab screen branches internally on `useAppDesignMode().isClearLens`. Only the Clear
  Lens branch needs desktop work; the legacy Classic branch is left untouched.
- Clear Lens primitives live in `src/components/clearLens/ClearLensPrimitives.tsx`
  (`ClearLensScreen`, `ClearLensCard`, `ClearLensHeader`, `ClearLensPill`,
  `ClearLensSegmentedControl`, `ClearLensMetricCard`).
- Tokens live in `src/constants/clearLensTheme.ts` (colors, spacing, radii, typography,
  shadow). Phase 5 must reuse these tokens — no new design system.
- Data hooks (`usePortfolio`, `usePortfolioInsights`, `useInvestmentVsBenchmarkTimeline`,
  `useMoneyTrail`, etc.) are platform-agnostic and unchanged.

The existing `AppOverflowMenu` is a bottom sheet used by both header overflow buttons. The
Clear Lens header (`ClearLensHeader`) puts a circular account-initial button in the top
right that opens that sheet. On desktop the same actions live on the sidebar with a
dropdown anchored above the account button — same handlers, different surface.


## Assumptions

1. The breakpoint `≥ 1024 px viewport width` is "desktop". Below that is "mobile". This
   matches Tailwind's `lg`, Material's `large`, and the iPad-landscape pivot. iPad in
   landscape sits exactly on the line — for v1 we accept the desktop layout there.
2. We branch in JS at render time using `useWindowDimensions()`, not via CSS media queries.
   React Native Web's `useWindowDimensions` is reactive and re-renders on resize.
3. Native platforms are hard-locked to mobile via `Platform.OS !== 'web'`. There is zero
   risk of a native build accidentally rendering the desktop shell.
4. We render only one of mobile or desktop layout at a time. We do not render both and
   hide one with CSS — that wastes work and bloats the component tree.
5. Each desktop screen variant reuses the same data hooks as its mobile counterpart, so
   data correctness is already proven.
6. Per-screen desktop variants live beside their mobile siblings under
   `src/components/clearLens/screens/desktop/` so the diff is reviewable as one cohesive
   layer.


## Definitions

**Mobile**

A web viewport `< 1024 px` wide, OR any iOS / Android binary. Renders the existing tab
shell and per-screen mobile layouts unchanged.

**Desktop**

A web viewport `≥ 1024 px` wide. Renders the new sidebar shell and per-screen desktop
layouts.

**Sidebar**

A vertical navigation rail on the left, 240 px wide. Contains the FolioLens logo + word
mark, primary nav items (Portfolio, Funds, Wealth Journey), Quick Actions (Sync, Import
CAS, Money Trail, Tools), and a Settings + Sign-out account row at the bottom.

**Content area**

The 760 px – 1200 px wide centered region to the right of the sidebar. All screen content
is constrained by `MaxContentWidth = 1200 px`. The content area arranges its inner column
count per screen — typically `2fr 1fr` (main column + a side panel) on the Portfolio
screen; a multi-column grid on Funds; a single centered column on every other screen.

**`useResponsiveLayout()`**

A new hook returning `{ layout: 'mobile' | 'desktop', width: number }`. On native platforms
`layout` is always `'mobile'`. On web, `layout = width >= 1024 ? 'desktop' : 'mobile'`.

**`<DesktopShell />`**

A new top-level layout component (renders the sidebar + content frame). Replaces the
`(tabs)` `<Tabs>` navigator on desktop web only.

**`<ResponsiveRouteFrame />`**

A wrapper that renders `<DesktopShell framed={false}>` around its children on desktop and
returns children unchanged on mobile. Used by every out-of-tabs route (Fund Detail, Money
Trail, Portfolio Insights, Tools) so they get the sidebar without each screen re-
implementing it.

**`<DesktopFormFrame />`**

A wrapper used by onboarding screens that pairs `<ResponsiveRouteFrame>` with a centered
720 px column. Mobile path returns children unchanged.


## Scope

### In scope

1. Responsive primitives: `useResponsiveLayout`, `<DesktopShell>`, `<DesktopContainer>`,
   `<DesktopSidebar>`, `<DesktopAccountMenu>` (dropdown replacement for the bottom-sheet
   `AppOverflowMenu` on desktop), `<ResponsiveRouteFrame>`, `<DesktopFormFrame>`.
2. Routing branch in `app/(tabs)/_layout.tsx` so desktop web renders `<DesktopShell>`
   while mobile keeps `<Tabs>`.
3. Desktop-purpose-built variants for the two screens with the most divergent layouts:
   - Portfolio (home) — two-column dashboard: hero/journey on left, movers/allocation/
     entry rows on right.
   - Funds (leaderboard) — table-style alpha summary header + 2-column responsive grid of
     fund cards (so the leaderboard reads as a leaderboard, not a column).
4. Centered max-width column for the rest of the in-tabs and out-of-tabs Clear Lens
   screens (Wealth Journey, Fund Detail, Money Trail, Money Trail detail, Portfolio
   Insights, Tools, Tools/goal-planner, Settings) so they don't stretch. Wealth Journey
   uses 760 px, Fund Detail uses 920 px (chart-heavy), the rest default to 760 px.
5. Auth + Onboarding desktop layout: centered Clear Lens card on a navy / soft background.

### Out of Scope

- Removing the Classic (non-Clear Lens) design branch. That deletion is a separate cleanup
  PR; for now Classic continues to render on mobile and we explicitly do not build desktop
  variants for it. Desktop is Clear Lens only.
- A dedicated tablet layout. Tablet portrait renders mobile, tablet landscape renders
  desktop, and that is acceptable for v1.
- Hover states, keyboard shortcuts, and right-click menus beyond what `TouchableOpacity`
  already gives us on web. Polish PR after launch.
- Server-side rendering, static export changes, SEO meta. Out of scope.
- A multi-column desktop variant for the Wealth Journey, Fund Detail, Money Trail, and
  Portfolio Insights screens. v1 uses a centered single-column with the sidebar — they
  read as polished desktop pages without needing per-screen layout work that would push
  the launch. Tracked as a follow-up.
- Unit tests for the layout primitives. Coverage of `src/utils/` is enforced at ≥ 95 %;
  layout primitives sit in `src/components/` (no coverage floor). We rely on visual
  validation in the PR test plan.


## Approach

The work breaks into five layers, applied in order.

### Layer 1 — Responsive primitives (`src/components/responsive/`)

New module:

    src/components/responsive/
      desktopBreakpoints.ts        // DESKTOP_MIN_WIDTH, MaxContentWidth, SidebarWidth
      useResponsiveLayout.ts       // hook
      DesktopShell.tsx             // sidebar + 1fr content area
      DesktopSidebar.tsx           // logo + nav + quick actions + account row
      DesktopAccountMenu.tsx       // dropdown variant of AppOverflowMenu
      DesktopContainer.tsx         // optional max-width centered child
      ResponsiveRouteFrame.tsx     // mobile passthrough / desktop sidebar wrapper
      DesktopFormFrame.tsx         // onboarding-style 720 px column wrapper
      index.ts

`useResponsiveLayout()`:

    import { Platform, useWindowDimensions } from 'react-native';
    import { DESKTOP_MIN_WIDTH } from './desktopBreakpoints';

    export function useResponsiveLayout(): { layout: 'mobile' | 'desktop'; width: number } {
      const { width } = useWindowDimensions();
      if (Platform.OS !== 'web') return { layout: 'mobile', width };
      return { layout: width >= DESKTOP_MIN_WIDTH ? 'desktop' : 'mobile', width };
    }

`<DesktopShell>` renders a `flexDirection: row` frame: 240 px sidebar on the left, 1fr
content area on the right. Children render inside an optional centered max-width frame
(`framed` prop, default true).

`<DesktopSidebar>` reads the current segments from `useSegments()` to highlight the active
nav item, owns its own sync state, opens `<DesktopAccountMenu>` from the account row.

### Layer 2 — Layout branching

`app/(tabs)/_layout.tsx`:

- Branch on `useResponsiveLayout()`:
  - mobile → existing `<Tabs>` block exactly as today
  - desktop → render the active tab screen via `<Slot />` inside `<DesktopShell framed={false}>`

`<Slot />` lets the active tab child mount without the tab navigator, while keeping URL
sync via Expo Router's segment routing.

For routes outside `(tabs)` (`fund/[id]`, `money-trail/index`, `money-trail/[id]`,
`portfolio-insights`, `tools/index`, `tools/goal-planner`), each screen wraps its return
with `<ResponsiveRouteFrame>` so the sidebar shows on desktop and disappears on mobile.

### Layer 3 — Desktop-purpose-built variants for Portfolio + Funds

For each of `Portfolio` and `Funds (leaderboard)` we introduce a desktop variant component
sibling. The mobile component is unchanged. The top-level Clear Lens screen file picks one
based on layout:

    src/components/clearLens/screens/
      ClearLensPortfolioScreen.tsx                 // mobile, unchanged + new branch shim
      ClearLensFundsScreen.tsx                     // mobile, unchanged + new branch shim
      desktop/
        ClearLensPortfolioScreenDesktop.tsx        // new
        ClearLensFundsScreenDesktop.tsx            // new

The pre-existing presentational subcomponents in `ClearLensPortfolioScreen.tsx`
(`PortfolioHero`, `BenchmarkComparisonCard`, `InvestmentVsBenchmarkChart`, `MoversRow`,
`AssetAllocationPreview`, `EntryRows`, `PortfolioEmptyState`) are exported from the
mobile file so the desktop variant can compose them in a 2-column grid.

The Funds desktop variant builds its own compact `FundDesktopCard` so the grid cells are
uniform height — the existing mobile `FundListItem` is too tall (expanded) and too dense
(collapsed) for a multi-column grid.

### Layer 4 — Centered column for remaining Clear Lens screens

`ClearLensScreen` gains a `desktopMaxWidth?: number` prop (default 760). On desktop it
constrains its children to that width, centered. On mobile it renders the existing
SafeAreaView unchanged.

Wealth Journey: chart's `screenWidth` is `Math.min(rawViewport, 760)` so the gifted-charts
canvas doesn't overflow the centered column. Fund Detail: module-scoped `CHART_WIDTH` is
`Math.min(rawViewport, 920) - 32` for the same reason; the screen passes
`desktopMaxWidth={920}` to `<ClearLensScreen>`. Money Trail, Portfolio Insights, Tools,
Settings all rely on the default 760 px.

### Layer 5 — Auth + Onboarding desktop card

`app/auth/index.tsx` Clear Lens branch: on desktop, the existing hero+form-panel stack
renders inside a 460 px wide rounded card centered on a navy background.

`app/auth/confirm.tsx`: same centered 460 px column on the inner ScrollView.

`app/onboarding/index.tsx`, `app/onboarding/pdf.tsx`: wrapped with `<DesktopFormFrame>`,
which adds the sidebar (user is signed in) and a 720 px centered column.


## Alternatives Considered

### A. Single responsive component per screen

Make each screen's component internally responsive via `flexDirection: 'row' / 'column'`
and conditional widths. Cheaper to wire (no new component files) but the desktop layouts
differ from mobile in *more* than column count: Funds becomes a multi-column grid not a
stack, Fund Detail flips chart vs metrics horizontally. Forcing one component to do both
produces a soup of conditional styles that's painful to evolve. Rejected — per-screen
variants make the desktop diff readable and the mobile diff zero.

### B. CSS-only desktop styles via Platform.OS

Use `Platform.OS === 'web'` style overrides and CSS media queries via `react-native-web`'s
StyleSheet. This works for trivial spacing tweaks but does not let us swap component trees
(sidebar vs tab bar). Rejected.

### C. Replace Expo Router's `<Tabs>` everywhere with `<Stack>` + custom mobile bottom bar

This would unify mobile and desktop on the same router primitive. Tempting long-term, but
the Expo Router `<Tabs>` already gives us mobile-correct Stack-per-tab semantics, web URL
sync, and tab persistence. Rebuilding that is a multi-day cleanup that must not block the
launch. Rejected for v1.

### D. Web-only top navbar (instead of left sidebar)

A horizontal nav bar across the top of the page is the other common desktop pattern. We
chose left sidebar because (a) FundLens has a fixed primary-nav set of three items and
sidebars handle that better than a sparse top bar, (b) Quick Actions (Sync, Import) need
a persistent surface and a sidebar fits them naturally, (c) at 1024 px+ a top navbar
wastes vertical real estate the dashboard needs.

### E. Full multi-column desktop variants for all six secondary screens

Rejected for v1 in favour of the centered-column approach (Layer 4). Multi-column would
double the desktop work for those screens with no critical UX gain — they read fine in a
single column on desktop because their natural composition is dense vertical content.
Tracked as a follow-up after launch.


## Milestones

### M1 — Responsive primitives + shell branch

- New `src/components/responsive/` module per Layer 1.
- `app/(tabs)/_layout.tsx` branched.
- Sidebar nav highlights active route, account dropdown invokes the same handlers as
  `AppOverflowMenu`.

Validation: `npm run typecheck` and `npm run lint` pass; bottom tab bar gone on a 1440 px
viewport, sidebar visible; resize below 1024 px reverts to mobile.

### M2 — Desktop variants for Portfolio + Funds

- New `ClearLensPortfolioScreenDesktop` and `ClearLensFundsScreenDesktop`.
- Each switches at the top of the existing Clear Lens screen file based on
  `useResponsiveLayout()`.

Layouts:

- Portfolio:
  - Row 1: title block (eyebrow + h1 + subtitle)
  - Row 2: `PortfolioHero` (full width)
  - Row 3: `BenchmarkComparisonCard` (full width)
  - Row 4: `InvestmentVsBenchmarkChart` + `MoversRow` + `EntryRows` (left, 2/3) | side
    panel (right, 1/3) with `AssetAllocationPreview` + Money Trail preview + Insights
    entry card
- Funds:
  - Title block + 5-cell summary card (holdings / value / your XIRR / benchmark XIRR /
    ahead-vs-behind)
  - Search box + sort chips
  - Responsive 2-column grid of `FundDesktopCard`s

Validation: `npm run typecheck`, `npm run lint`, `npm run test` pass; data values match
mobile pixel-by-pixel for the same logged-in user; resize snaps cleanly.

### M3 — Centered-column wrapping for remaining Clear Lens screens + Fund Detail width

- `ClearLensScreen.desktopMaxWidth` prop.
- Wealth Journey: cap `screenWidth` to 760.
- Fund Detail: cap `CHART_WIDTH` to 920, set `<ClearLensScreen desktopMaxWidth={920}>`,
  wrap default export with `<ResponsiveRouteFrame>`.
- Money Trail, Money Trail detail, Portfolio Insights, Tools, Tools/goal-planner: wrap
  with `<ResponsiveRouteFrame>`.

Validation: each wrapped screen at 1440 px renders centered with sidebar visible and no
horizontal scrollbars.

### M4 — Auth + Onboarding desktop

- Auth screens: centered 460 px card, navy background.
- Onboarding screens: `<DesktopFormFrame>` wrapper.

Validation: sign in flow works end-to-end on desktop; onboarding wizard is centered;
mobile sign-in unchanged.

### M5 — Final pass

- Update README "What works now".
- Squash-merged via PR with manual test plan.

Validation: `npm run typecheck`, `npm run lint`, `npx jest --coverage` pass; coverage for
`src/utils/` ≥ 95 %.


## Validation

Cross-cutting checks before raising the PR:

- `npm run typecheck` — zero errors.
- `npm run lint` — zero warnings (`--max-warnings 0`).
- `npx jest --coverage` — passes; thresholds for `src/utils/` and
  `supabase/functions/_shared/` unchanged.
- Manual visual at 360 px / 768 px / 1024 px / 1440 px / 1920 px viewport widths on web.
- Manual smoke on iOS and Android (Expo Go) confirming the bottom tab bar and per-screen
  layout are byte-identical to `main`.


## Risks And Mitigations

1. **Risk**: Branching layout based on `useWindowDimensions` causes a flash of mobile
   layout on first paint of desktop web.
   **Mitigation**: `useWindowDimensions` is synchronous; the first render reads the actual
   viewport. The flash only happens if we lazy-load. We do not lazy-load.

2. **Risk**: Resize between mobile and desktop unmounts and remounts the active screen,
   resetting React Query in-flight requests and local state.
   **Mitigation**: React Query retains cache across remounts (data hooks are keyed by
   user / fund id), so refetch is automatic. Local state (e.g. selected time window) does
   reset; this is acceptable since resize across the breakpoint is rare in practice.

3. **Risk**: Existing Clear Lens screens use `Dimensions.get('window').width` at module
   scope to size charts. Those values are captured at load time and don't update on
   resize.
   **Mitigation**: Pre-existing pattern, not introduced by this work. We capped the
   module-scoped widths used by Wealth Journey and Fund Detail charts to the desktop
   max width (760 / 920), so they fit in their centered column on desktop without
   overflow. Mobile widths are unchanged.

4. **Risk**: The mobile Auth / Onboarding screens use `KeyboardAvoidingView`. Wrapping
   those in a desktop card breaks keyboard-avoidance behaviour on mobile.
   **Mitigation**: The added card-style is a desktop-only style override applied via
   `isDesktop` flag inline. Mobile JSX shape is unchanged.

5. **Risk**: Calling `useResponsiveLayout()` then conditionally returning a desktop
   variant component before the rest of the screen's hooks runs would violate the rules
   of hooks.
   **Mitigation**: Each screen's mobile body is extracted into a private
   `ScreenNameMobile` function. The public `ScreenName` component only calls
   `useResponsiveLayout()` and then returns either the mobile or desktop variant. No
   hook-ordering issues.


## Decision Log

- 2026-05-04 — Picked `1024 px` as the desktop breakpoint. Rationale in Definitions.
- 2026-05-04 — Picked left sidebar over top navbar. Rationale in Alternatives D.
- 2026-05-04 — Picked per-screen desktop variants over single responsive components for
  Portfolio + Funds; centered-column wrapping for the rest. Rationale in Alternatives A
  and E.
- 2026-05-04 — Did not extend desktop support to the legacy Classic design. Desktop is
  Clear Lens only; Classic remains mobile-only and is slated for removal in a separate
  PR.
- 2026-05-04 — Multi-column desktop variants for Wealth Journey, Fund Detail, Money
  Trail, and Portfolio Insights deferred to a post-launch follow-up. Centered-column +
  sidebar reads as a deliberate desktop page in v1.


## Progress

- [x] M1 — Responsive primitives + shell branch
- [x] M2 — Desktop variants for Portfolio + Funds
- [x] M3 — Centered-column wrapping for Wealth Journey, Fund Detail, Money Trail,
      Portfolio Insights, Tools, Settings
- [x] M4 — Auth + Onboarding desktop
- [x] M5 — Final pass (README + PR)


## Amendments

Captured during implementation; the original plan covers the architectural shape but
several details were adjusted in response to live audits and user feedback.

### Tab navigator preserves active route across resize

The first cut of `(tabs)/_layout.tsx` returned two completely different navigator trees —
`<Tabs>` on mobile and `<DesktopShell><Slot /></DesktopShell>` on desktop. Crossing the
1024 px breakpoint then unmounted the navigator and reset the active tab (open Wealth
Journey, drag the window wider → land on Portfolio). The fix keeps a single `<Tabs>`
mounted in both modes; on desktop the bottom tab bar is hidden via
`tabBarStyle: { display: 'none' }` and the sidebar renders as a row sibling. The
navigator instance is preserved so the active route survives.

### Title placement unified — body owns the h1, header is chrome only

The original plan had `ClearLensHeader` rendering the title centered between the back
button and the menu button. After auditing every screen with Playwright on both layouts
we found duplicate-title patterns ("Money Trail" header above an h1 "Money Trail" in
the body). Resolved by making `ClearLensHeader.title` a no-op everywhere and letting
each screen body render its own eyebrow + h1 + subtitle block. Money Trail [id], Tools,
and Create-Goal gained body title blocks. The header is now a slim 44 px chrome strip
whose only job is the back chip (when navigating from a non-sidebar route).

### Eyebrow + h1 + subtitle pattern standardised

To stop the title styling from drifting, every primary screen now uses the same green
ALL-CAPS eyebrow + bold navy h1 + grey subtitle pattern: Portfolio, Funds, Wealth
Journey, Money Trail, Money Trail [id], Portfolio Insights, Tools, Settings. Fund
Detail keeps the fund name as its own hero (the name is inherently contextual).

### Desktop sidebar account row links straight to Settings

The first version had the account row open a `<DesktopAccountMenu>` dropdown that
duplicated everything the sidebar already exposed (Sync, Import, Money Trail, Tools)
and added only Settings + Sign Out. The dropdown was deleted entirely; the account row
is now a direct link to `/(tabs)/settings`, with Sign Out reachable via Settings →
About & support exactly like mobile.

### `AppOverflowMenu` props made required

The mobile Quick Actions menu rendered different items per screen (Funds dropped Money
Trail and Tools; Wealth Journey dropped Tools). Root cause: the optional
`onMoneyTrail` / `onTools` props were silently omitted at three of the six call sites.
Both props are now required and the conditional spread inside the component is gone, so
the same menu appears on every screen.

### Funds desktop is fund-level insight, not portfolio metrics

The original Funds desktop summary card showed Portfolio value / Your XIRR / vs Nifty /
Ahead-Behind — all of which are portfolio-level numbers already on the home screen. It
was redesigned to show fund-level insight instead: allocation strip, holdings count,
top-3 concentration, largest holding, today's best/worst movers within the user's
funds. The "ahead/behind" terminology was unclear and was dropped.

### Charts on Fund Detail derive width from `useWindowDimensions`

The first cut left Performance, NAV, and Growth Consistency charts using the
module-scope `CHART_WIDTH = Math.min(SCREEN_WIDTH, FUND_DETAIL_DESKTOP_MAX) - 32`
constant. That constant captures the viewport once at JS load time, so resizing the
browser left charts at the original width. Each chart now reads
`useWindowDimensions().width` inside its own component so they grow with the window.
The Growth Consistency chart additionally uses an equal-slot bar layout
(`plotWidth / bars.length` per slot) so bars span the full plot rather than
clustering at the left edge on wide viewports.

### Desktop width tiers — 760 list default bumped to 960; `DesktopShell` + `DesktopContainer` retired

The plan called for a single `ClearLensScreen.desktopMaxWidth` (default 760) for every non-dashboard screen, with Portfolio + Funds desktop variants capping at `MaxContentWidth = 1200`. In practice the 760 column felt cramped on a 1440+ display and Settings sub-pages had no cap at all — they stretched edge-to-edge of the sidebar shell's content slot. The 920 override on Fund Detail and the 760 default created a step-function of three visible widths (760 / 920 / 1200) plus an unbounded fourth (Settings sub-pages), which read as jarring when navigating between screens.

This was reconciled into an explicit two-tier system:

- **List tier (960 px)** — `ClearLensScreen.desktopMaxWidth` default. Used by Settings hub + sub-pages, Wealth Journey, Money Trail, Tools, Compare Funds, Past SIP Check, Goal Planner, Direct vs Regular. Settings sub-pages now wrap their ScrollView body in a centered `frame` view to apply the cap (matching Settings hub's pattern). Past SIP + Wealth Journey chart-width clamps bumped from `min(viewport, 760)` to `min(viewport, 960)` so SVGs fill the new container.
- **Dashboard tier (1200 px)** — `MaxContentWidth`. Used by Portfolio + Funds desktop variants. Unchanged.

`DesktopShell` and `DesktopContainer` had been dead code since the PR #112 resize-bug fix retired the `<DesktopShell framed={false}>` wrapper from `ResponsiveRouteFrame` — zero call sites for ~weeks. Both files are now deleted along with their re-exports in `src/components/responsive/index.ts`. The stale comment in `ResponsiveRouteFrame` that referenced the historical `<DesktopShell>` wrapper was refreshed so the topology-invariant rationale is still legible without naming a component that no longer exists.

Multi-fund / multi-column content uses the flex-stretch pattern `flex: 1, minWidth: N` (Funds dashboard grid, Settings rows, Money Trail rows). Compare Funds was the only outlier left — fund-column cells were fixed at `width: 130` and left ~540 px of dead space at 2-fund comparisons in the 960 frame. Cells now use `flex: 1, minWidth: 130, maxWidth: 220` so the table fills the card. The `maxWidth` cap prevents 2-fund comparisons from stretching each cell to ~400 px (where the single number per cell would feel lost).

Fund Detail's historical `FUND_DETAIL_DESKTOP_MAX = 920` override was dropped in the same PR. Pre-bump it was 160 px *wider* than the 760 default (chart-heavy intent); post-bump it would have been 40 px *narrower* than the list tier — backward inconsistency. The screen now uses the 960 default (no `desktopMaxWidth` prop), and the chart-width calcs centralise on a `FUND_DETAIL_CHART_MAX = 960` constant that matches.

### `FundDesktopCard` and `FundListItem` deliberately stay separate

We attempted to consolidate the two — exporting `FundListItem` and using it on desktop —
but reverted. The mobile expanded card with sparkline + "View transactions" CTA + 30-day
sparkline panel reads as cramped on the desktop card grid. The desktop card uses a
hierarchical layout (primary current value big, XIRR + Today as smaller stats, footer
with Invested ▏ Gain split) that suits the wider canvas. Documented in the audit log
section so future readers know the divergence is intentional.

### Auth + Onboarding desktop simpler than originally planned

Plan called for a "side-by-side hero + form" card. Auth ships with that layout
(920 px wide card, hero left, form right, both vertically centered). Onboarding ships
with `<DesktopFormFrame>` — a centered 720 px column inside the desktop sidebar shell —
rather than a separate centered-card layout, because once the user is signed in the
sidebar is more useful than another card chrome.

### Other UX refinements made along the way

- Bottom tab bar grew (68→78 px Clear Lens; 76→86 Classic) and labels shrank
  (12/16 → 11/14, centered) so "Wealth Journey" wraps cleanly on narrow widths.
- Portfolio side panel: replaced the duplicate Portfolio Insights link with a Wealth
  Journey teaser.
- Mobile fund card Gain row: stripped the duplicate ▲ arrow from the percentage
  subvalue; hide Redeemed / Booked P&L rows when the fund has no realized activity;
  add "NAV · last 30 days" label above the sparkline; right-align Today + XIRR via
  the same MetricRow pattern as the breakdown rows.
- Settings hub caps content at 760 px on desktop so cards don't stretch edge-to-edge.
- Fund Detail Portfolio Weight donut card caps at 460 px so the donut + info pair
  doesn't drift in a sea of whitespace.
- Fund Detail Technical Details card gains a 16 px horizontal indent on Clear Lens to
  line up with the NAV chart card above it (which sits inside an extra-padded tab
  container).
- Feedback modals (Request a feature / Report an issue) move the submit button into a
  sticky footer outside the ScrollView so it's always visible.
- ClearLensHeader back chip now matches `UtilityHeader.clearBackBtn` exactly (38 px
  circle, white surface, 1 px border, 22 px chevron) so the back affordance reads the
  same on every screen across both ClearLensHeader-driven and UtilityHeader-driven
  pages (Settings sub-pages use the latter).
- `app/money-trail/_layout.tsx` added so Expo Router stops warning about the
  `<Stack.Screen name="money-trail">` declaration having no nested children layout.

### Component duplication audit (carried for follow-up)

- **Fund-card-like components**: `FundCard` (legacy classic, only `categoryColor`
  helper is imported elsewhere — the component itself is dead), `FundListItem` (mobile
  expanded), `FundDesktopCard` (desktop hierarchical), `RankCard` (classic
  leaderboard), `MoverCard` / `MoverChip` / `GainerCard`. Per-card divergence is
  intentional; promote `FundCard.categoryColor` and the alpha-pp / sign helpers to a
  shared module in a follow-up.
- **Header components**: `ClearLensHeader`, `UtilityHeader`, `PrimaryShellHeader`.
  Visual back-button styling is now aligned. Future: collapse to one component.
- **Allocation strip + summary card**: mobile `AllocationOverview` vs desktop summary
  card share the same idea but ship as two implementations. Consolidation deferred.
