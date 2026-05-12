# FolioLens Clear Lens Design

## Design Overview

Clear Lens is the only FolioLens interface. It is a calm mobile-first system for novice mutual fund investors: portfolio signal first, plain-language labels, restrained chrome, and consistent benchmark context.

The system is responsive: the same Clear Lens tokens, primitives, and screens render on phones, mobile web, iOS, Android, and a purpose-built desktop web shell at viewports ≥ 1024 px. Native binaries always render mobile.

It also ships in two colour schemes — **light** (the original palette) and **dark** (added during PR #97) — picked at Settings → Preferences → Appearance (light / dark / follow system). The legacy Classic mode has been retired.

## Principles

- Lead with the answer: value, movement, benchmark context, and XIRR must be visible quickly.
- Keep finance terms sparse and explain unavoidable terms in place.
- Use live portfolio data; prototype values are visual examples only.
- Prefer reusable Clear Lens primitives and semantic tokens over screen-local styling.
- Tokenise everything that can flip between light and dark: never reach for `ClearLensColors.X` (light-only) inside a component — pull values from `useClearLensTokens()` so the screen reacts to the active scheme.

## Tokens

The source of truth is `src/constants/clearLensTheme.ts`. The file exports two parallel palettes (`ClearLensLightColors`, `ClearLensDarkColors`) sharing the same shape, plus a `getClearLensTokens(scheme)` factory.

Components consume tokens through `useClearLensTokens()` from `src/context/ThemeContext`, which returns the resolved tokens for the active scheme. Module-level `StyleSheet.create` calls capture token values once and therefore can't react to a scheme flip — wrap them in `function makeStyles(tokens)` and call via `useMemo(() => makeStyles(tokens), [tokens])`. The route stack uses `key={resolvedScheme}` so any module-level styles still in flight remount on toggle.

Core colours (per-scheme values are documented in `clearLensTheme.ts`):

- Navy / Slate — primary ink. `navy` flips to near-white in dark, so anything that needs a stable brand-dark surface (hero cards, active pills) reaches for `heroSurface` instead.
- Emerald / EmeraldDeep / Mint — brand greens.
- Background / Surface / SurfaceSoft — page bg, card, and lifted card.
- HeroSurface — brand-dark surface, stable across schemes.
- Border / BorderLight — hairline outlines.
- Positive / Negative / Amber / Warning + their soft `*Bg` companions for badge surfaces.

## Semantic Color System

Use `tokens.semantic.*` for data and state colors. The factory rebuilds the semantic map per scheme, so colours that need to differ (e.g. `marketCap.mid`) can branch on `scheme`.

- Asset mix: equity, debt, cash, other
- Market cap: large = emerald, mid = emeraldDeep (light) / mint (dark), small = amber, other = lightGrey — all three slices read against light AND dark canvases
- Chart series: fund, portfolio, benchmark, invested (= heroSurface so the baseline never blends into the dark page bg), neutral
- Fund allocation: 6-hue palette (emerald, amber, negative, mint, slate, emeraldDeep) — dropped the original `navy` slot because it flipped to near-white in dark
- Sentiment: positive, negative, positive/negative text, positive/negative surface
- State: loading, success, warning, danger, empty icon
- Overlay: backdrop, dark divider, focus ring

## Typography

Clear Lens uses Inter via Expo font loading:

- Hero values: large bold tabular numeric text
- Headings: bold/semi-bold, compact mobile scale
- Body: regular Inter, short sentences
- Labels: small semi-bold uppercase only for compact metadata
- Numeric values should use stable width where supported and must not rely on viewport-scaled fonts

## Spacing, Radius, Shadow

- Spacing follows the Clear Lens 4/8 point scale.
- Cards use the shared Clear Lens radius and subtle shadow.
- Pills are fully rounded.
- Bottom sheets use large top radii and the Clear Lens backdrop overlay.

## Components

Shared Clear Lens primitives live under `src/components/clearLens/`:

- `ClearLensScreen`
- `ClearLensHeader`
- `ClearLensCard`
- `ClearLensPill`
- `ClearLensSegmentedControl`
- `FundLensLogo`

Primary screens should compose these primitives before adding screen-specific styles.

## Data Visualization

- Portfolio chart: show amount invested, real portfolio worth, and benchmark worth in rupees.
- Money Trail: show financial-year invested/withdrawn/net-invested summaries with compact bars; keep transaction rows minimal and place units, NAV, and calculation flags in detail.
- Fund detail performance: fund vs benchmark, with period controls.
- Composition: use semantic asset and market-cap colors.
- Portfolio Insights holdings: show up to 30 holdings, 10 per page, with icon chevrons for paging.
- Wealth Journey: show current vs adjusted growth and withdrawal drawdown paths.
- Tools / Goal Planner: use quiet card lists, segmented scenario controls, conservative default assumptions, and plain estimated-outcome copy.
- Positive and negative deltas should use arrowed signed formatting (`▲ +1.23%`, `▼ -1.23%`) in Clear Lens UI.

## Screen Patterns

- Primary tabs: logo/header, concise title copy where needed, stacked cards, overflow menu (mobile) / sidebar (desktop).
- Utility screens: back-chip chrome only on desktop (the body owns the title); back-title header on mobile.
- Modals and sort sheets: bottom sheet, icon/radio rows where relevant, explicit apply/save action. Long-form modals (feedback) use a sticky footer for the primary action.
- Empty states: one icon, one title, one plain next action.

### Title block (consistent across screens)

Every primary screen uses the same body-level title block:

- Eyebrow: `ClearLensTypography.label` in `ClearLensColors.emerald`, ALL CAPS — the screen name.
- H1: `ClearLensTypography.h1` in `ClearLensColors.navy` — the screen's purpose copy ("Your dashboard", "Plan today, with clarity", "Where every rupee went").
- Subtitle: `ClearLensTypography.body` in `ClearLensColors.textSecondary` — one short explanatory sentence.

`ClearLensHeader` accepts a `title` prop for backwards compatibility but never renders it — the body always owns the screen h1 so titles never duplicate.

### Back chip

The same back chip appears wherever back navigation is needed: 38 px circle, white surface, 1 px navy border, 22 px chevron-back glyph. `ClearLensHeader.backChip` and `UtilityHeader.clearBackBtn` are aligned. On desktop, screens that are reachable directly from the sidebar (Money Trail, Tools) suppress the back chip; screens with no sidebar entry (Fund Detail, Money Trail [id], Portfolio Insights, Goal Planner) keep it.

## Responsive layout

The breakpoint is **1024 px** (`DESKTOP_MIN_WIDTH`). Below that — and on every native binary regardless of width — the app renders mobile layouts. At and above, the desktop shell activates.

Desktop primitives live under `src/components/responsive/`:

- `useResponsiveLayout()` / `useIsDesktop()` — runtime branch using `useWindowDimensions` (reactive on resize) + `Platform.OS` (native always mobile).
- `DesktopSidebar` — 240 px left rail with logo, primary nav, Quick Actions, account row → Settings.
- `ResponsiveRouteFrame` — wraps an out-of-tabs route with the sidebar shell on desktop, returns children unchanged on mobile.
- `DesktopFormFrame` — onboarding-style 720 px column inside the sidebar shell.
- `ClearLensScreen.desktopMaxWidth` (default **960**) — caps body content width on desktop.
- `MaxContentWidth = 1200` — used by Portfolio + Funds desktop variants for the dashboard frame.

#### Two-tier desktop width system

Desktop screens fall into two tiers:

| Tier | Width | Used by |
|---|---|---|
| **List** | **960 px** | `ClearLensScreen`-wrapped screens — Settings hub + sub-pages, Wealth Journey, Money Trail, Tools, Fund Detail, Compare Funds, Past SIP Check, Goal Planner, Direct vs Regular |
| **Dashboard** | **1200 px** | Portfolio + Funds desktop variants — grid-heavy screens whose dedicated `*Desktop.tsx` components bypass `ClearLensScreen` and use `MaxContentWidth` directly |

Pick the tier by content density. Reading-style screens (single-column lists, charts, forms) go on the list tier; grid- or multi-column dashboards go on the dashboard tier. Settings sub-pages historically had no cap and stretched edge-to-edge of the content slot — they now apply the 960 cap via a wrapping `frame` View (see `app/(tabs)/settings/*.tsx`).

Layout rules:

- The single `<Tabs>` navigator stays mounted in both layouts. Desktop hides the bottom bar with `display: none` and the sidebar renders as a row sibling — resizing across the breakpoint preserves the active route.
- Charts that need a width should read `useWindowDimensions().width` and clamp to the screen's max-width (`960` for the list tier, the dashboard variants own their own value). Past SIP and Wealth Journey use `Math.min(windowWidth, 960)` for their growth-path SVGs; Fund Detail centralises the same value in `FUND_DETAIL_CHART_MAX = 960` and uses it in three chart-width calcs. The legacy module-scope `CHART_WIDTH` constant is captured once at JS load and breaks on resize — don't reintroduce it.
- Multi-column / multi-fund content (Compare Funds cells, Funds grid) uses the flex-stretch pattern `flex: 1, minWidth: N` so columns fill the available width. Add `maxWidth` only when the per-cell content is too sparse to scale gracefully (Compare Funds caps cells at 220 to keep a single number from feeling lost in 400 px of cell).
- Quick Actions menu (`AppOverflowMenu`) requires `onMoneyTrail` and `onTools` at the type level so all call sites surface the same items. The desktop sidebar exposes the same actions natively.

## States

Every Clear Lens screen should cover:

- loading
- empty/no-data
- error/retry
- syncing/requested
- stale or missing composition data where relevant

## Accessibility

- Avoid color-only meaning; pair positive/negative color with arrow/sign text.
- Keep touch targets at least 40px high.
- Keep text inside cards and pills from clipping on mobile widths.
- Use plain labels for financial terms and avoid unexplained acronyms.

## Known Divergences

Intentional divergences from the handoff prototype are tracked in `docs/design-audits/clear-lens-handoff-parity.md`.

The largest product-level divergence is that live portfolio data remains authoritative. Prototype values and fund names are not hardcoded.

## QA Checklist

- `npm run typecheck`
- `npm run lint`
- `npm test -- --runInBand`
- `EXPO_PUBLIC_SUPABASE_URL=https://example.supabase.co EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY=sb_publishable_dummy npm run export:web`
- Browser pass on local Expo web with the demo auth shortcut
- Screenshot pass for Portfolio, Portfolio Insights, Your Funds, Fund Detail, Money Trail, Leaderboard, Wealth Journey, Tools, Goal Planner, Settings, import, PDF upload, overflow menu, sort sheet, and modal states
