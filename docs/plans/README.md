# FundLens — ExecPlan Index

---

## Active plans

| Plan | Branch | What it covers |
|---|---|---|
| `phase-3-clear-lens-design-mode/M2-money-trail.md` | `feature/money-trail` | Money Trail transaction history on Clear Lens; portfolio preview, entry points, transaction browsing, detail, filters, sorting, CSV export, and calculation alignment |
| `phase-3-clear-lens-design-mode/M3-dark-mode.md` | `claude/add-dark-theme-selection-hZil0` (PR #97) | Clear Lens dark scheme; Settings appearance picker (light / dark / system); Classic mode retired; live-token migration; theme-aware app icons (iOS dark/tinted, Android monochrome) and web favicon swap |
| `phase-6-cas-onboarding/00-onboarding-redesign.md` | `docs/cas-onboarding-execplans` (PR #88) | Phase 6 overview — friendly 4-step CAS onboarding wizard, theme + desktop reality |
| `phase-6-cas-onboarding/M1-friendly-upload-onboarding.md` | `feat/onboarding-wizard-m1` (PR #92) | M1 — wizard rewrite (Welcome / Identity / Import / Done), upload-first import, in-app browser portal flow |
| `phase-6-cas-onboarding/M2-resend-inbound-auto-refresh.md` | `feat/cas-resend-inbound-m2` (PR #93) | M2 — per-user inbox token, Resend Inbound webhook, auto-refresh card, Settings row, retire CASParser |
| `phase-8-total-return-benchmarks/M1-tri-data-and-app-cutover.md` | `feat/total-return-benchmarks` | Phase 8 M1 — NSE TRI primary + EODHD backup ingestion, source-tagged rows, backfill 25y, app-wide cutover, drop BSE Sensex (migrate users to Nifty 50 TRI), Fund Detail benchmark dropdown showing the fund's SEBI-mandated benchmark; prerequisite for the Tools Hub stack. Product reasoning lives at `docs/product/total-return-benchmarks-prd.md`. |

---

## Archived plans

All shipped work is in `docs/plans/archive/`. These are read-only historical records — agents should not read them unless debugging a specific decision from that feature.

**Phase 1 — Foundation Build** (`archive/phase-1-foundation/`)

| Plan | What it covers |
|---|---|
| `01-foundation.md` | Project scaffold, Supabase schema, auth |
| `02-data-pipeline.md` | NAV sync edge function, index history |
| `03-onboarding.md` | PAN entry, CAS registrar selection, import address |
| `04-home-screen.md` | Portfolio header, fund cards, benchmark comparison |
| `05-fund-detail.md` | Performance tab, NAV history tab, crosshair chart |
| `06-compare.md` | Multi-fund comparison screen |
| `07-cas-inbound-flow.md` | Email-forwarding inbound CAS pipeline |
| `07-settings-improvements.md` | Settings preferences, benchmark picker |
| `08-improvements.md` | UX polish, test session 1 fixes |
| `milestone-8-ux-polish.md` | Additional UX polish pass |
| `09-local-cas-pdf-parser.md` | Local PDF parsing (replaces CAS upload) |
| `10-dev-auth-bypass.md` | Demo account / local dev auth shortcut |
| `10-supabase-migration-drift-repair.md` | Migration drift repair and parity CI |
| `11-shared-scheme-catalog.md` | Shared scheme metadata catalog + slimmer user holdings storage |

**Phase 2 — Design Integration & Feature Completion** (`archive/phase-2-design-integration/`)

| Plan | What it covers |
|---|---|
| `M1-nav-restructure.md` | Settings→header icon; 3-tab layout |
| `M2-home-enhancements.md` | Portfolio vs Market chart; Top Gainers/Losers |
| `M3-leaderboard.md` | Performance Leaderboard screen |
| `M4-fund-tech-details.md` | Fund metadata sync (expense ratio, AUM, min SIP) |
| `M5-fund-detail-enhancements.md` | Growth consistency chart; Portfolio health donut |
| `M6-wealth-simulator.md` | Interactive SIP/lumpsum wealth projection tool |
| `M7-ab-theme-toggle.md` | V2 "Editorial Wealth" theme; settings toggle; new logo |
| `M8-google-login.md` | Google OAuth sign-in; account linking; existing-account detection |
| `M9-portfolio-insights.md` | Asset mix, market-cap mix, sector exposure, top holdings |
| `M10-screen-family-consistency.md` | Unified navigation chrome, single back affordance in Fund Detail, sortable Your Funds list |
| `M11-wealth-journey-redesign.md` | Wealth Journey — portfolio-anchored planning with drawdown view |

**Phase 3 — Clear Lens Design Mode** (`archive/phase-3-clear-lens-design-mode/`)

| Plan | What it covers |
|---|---|
| `M1-clear-lens-design-mode.md` | Clear Lens default design mode; tokens and logo; redesigned Portfolio, Insights, Your Funds, Fund Detail, Leaderboard, Wealth Journey, and supporting screens |

**Phase 4 — Tools Hub** (`archive/phase4-tools-hub/`)

| Plan | What it covers |
|---|---|
| `M0-tools-foundation.md` | Tools Hub shell, feature flags, and Portfolio / Wealth Journey entry points |
| `M1-goal-planner-mvp.md` | Goal Planner MVP with Clear Lens calculator screens, projection chart, and tool route structure |

**Bug Fixes** (`archive/bug-fixes/`)

| Plan | What it covers |
|---|---|
| `1-portfolio-value-bug-fix.md` | CAS import REVERSAL/tax fix; Android PDF XHR; auth host guard; CI db push |

---

## Notes for agents reading archived plans

Some past plans describe an architecture that has since been retired. Don't act on these references — they are historical context, not the current shape of the code:

- **"Classic" design mode** is gone. Many phase-3 / phase-5 plans (M1-clear-lens-design-mode, M1-desktop-shell, M3-dark-mode) still mention "Classic" screens, an `appDesignMode` setting, or "the design switch in Settings". The Settings switch was removed when dark mode shipped (PR #97); Clear Lens is now the only design. The `appDesignMode` field exists only in `migratePersistedAppState` (`src/store/appStore.ts`) so legacy persisted state is dropped on load — it is not read at runtime.
- **`src/constants/theme.ts`** is deleted. The legacy `Spacing`, `Radii`, `Typography`, and `AppColors` exports moved to `src/constants/clearLensTheme.ts` as `ClearLensSpacing`, `ClearLensRadii`, `ClearLensTypography`, and `ClearLensCompatibleTokens`. Anything in an archive plan that says `from '@/src/constants/theme'` is wrong now.
- **`useTheme().colors`** is gone. The hook returns `{ colorScheme, resolvedScheme, setColorScheme, clearLens }` — no back-compat `colors` field. Read tokens via `useClearLensTokens()` (returns `{ colors, semantic, compatible, scheme }`).
- **`useAppDesignMode`** hook is gone. Older plans reference `src/hooks/useAppDesignMode.ts` for the classic↔Clear-Lens switch. The hook and the screens it gated have been removed.

If a current task seems to depend on any of the above, escalate before implementing — it is much more likely the plan is stale than that the architecture needs to revert.
