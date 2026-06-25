# FolioLens

Track your Indian mutual fund portfolio against benchmarks. Import from CAS, see XIRR, inspect composition, and model future outcomes.

For the why-and-what, read [VISION.md](./VISION.md).
For the how-it-runs, read [docs/INFRASTRUCTURE.md](./docs/INFRASTRUCTURE.md).

---

## What works now

- **Auth** — magic-link sign-in (via Resend on `foliolens.in`) and Google OAuth. Existing magic-link accounts can connect Google from Settings → Connected Accounts.
- **Import portfolio** — drop-zone-first onboarding wizard. Welcome shows a single drag-and-drop hero for the portfolio statement PDF; users without one on hand follow a one-question app-family tile (Zerodha / Angel / ICICI Direct vs Groww / Kuvera / fund-house apps vs both) that quietly routes them to the right CDSL / NSDL or CAMS / KFintech portal — no acronyms surface to the user. After a PDF is picked, an unlock step asks for PAN (the default PDF password) plus an optional DOB and a "My PDF uses a different password" reveal for users who set a custom one when requesting the statement; PAN format is validated including the 4th-character entity code (P / C / H / F / A / T / B / L / J / G), DOB takes DD-MM-YYYY (Indian convention), and both fields are write-once after save with a Settings → Account "Request correction" link as the support escape hatch. The success screen surfaces real fund names and per-fund XIRR from the live import. Upload pipeline supports CAMS / KFintech / MFCentral with PAN password (or a custom override) and CDSL / NSDL with PAN + DOB, requires Detailed statements with transaction history, and keeps second uploads additive (duplicate transactions skipped, only new ones inserted). Auto-refresh uses Resend Inbound (`cas-<token>@foliolens.in` in prod, `cas-dev-<token>@foliolens.in` in dev) with Gmail / Outlook setup guidance, a completion checklist, and transactional success / failure emails after inbound PDF processing.
- **Portfolio / Home screen** — Clear Lens design: hero value, NAV staleness context, XIRR vs configurable benchmark, investment-vs-benchmark chart with `1M / 3M / 6M / 1Y / 3Y / All` ranges, top movers, allocation preview, Portfolio Insights entry, Your Funds entry, Wealth Journey, Money Trail preview.
- **Money Trail** — every transaction with a hero summary, by-financial-year mini chart (tap a bar to see invested / withdrawn for that year), simplified type filter chips (Investment / Withdrawal / Switch / Dividend / Failed / Other), search, sort, CSV export, scroll-to-top FAB. Hero respects only date-range / fund scope; drill-down filters never empty out summary tiles.
- **Fund detail** — current value, gain/loss, SIP-adjusted XIRR, composition cards, Performance tab with crosshair-synced fund-vs-benchmark return, NAV history. NAV sourced from OpenFolio (mfapi.in backup). Fund metadata — AUM, 1/3/5yr returns, expense ratio, fund manager, benchmark, risk label, exit load, min investment/SIP — sourced from OpenFolio `/v1/metadata` via daily `sync-fund-meta` (mfdata.in backup per `b1_field_meta.status`; `officially_absent`/`not_applicable` statuses surface as honest "unavailable" rather than falling back to mfdata). Star ratings removed; replaced by OpenFolio-computed returns and official risk label. Display guards in `src/utils/mfdataGuards.ts` (`readRiskLabel` / `readBenchmarkName` / `readFundManager`) filter junk stored in `scheme_master` — OCR shrapnel, suitability paragraphs, and holdings-bleed — before any value reaches the screen; junk renders as "—" or hides the row via the existing null paths. **Payout plan metrics** — Compare Funds and Fund Detail bypass locally-computed NAV metrics for IDCW/payout/dividend schemes (which would otherwise show distorted CAGR/drawdown due to NAV drops on each distribution); instead they use the `period_returns` / `risk_ratios` as-reported blob, which OpenFolio #65 populated with the Growth-twin's correct numbers for ~82% of payout schemes. Detection is via `isPayoutPlan(schemeName, optionType)` in `src/utils/computedFundMetrics.ts`; "Dividend Yield Fund" is correctly treated as a strategy (not payout) unless an IDCW marker is also present. **Compare Funds fund identity** — fund chips now show `family_name` (the canonical portfolio name from OpenFolio, e.g. "HDFC Flexi Cap Fund") as the title instead of the full AMFI scheme name, with a secondary `Direct · Growth` chip sourced from `plan_type` / `option_type` — both written by `universe-backfill` + `sync-fund-meta` from OF `/v1/metadata`; `shortSchemeName()` regex trimming is retained as a fallback only for inactive registry shells OF doesn't index. **Compare Funds cross-category banner** — the "Different categories" warning now uses `fundComparisonKey` / `categoriesInSameGroup` (`src/utils/schemeName.ts`) so legacy dirty `sebi_category` spellings and a null/broad-Equity fallback (fund not yet backfilled) never falsely trigger the banner. 35 active Large & Mid Cap Fund schemes had wrong `sebi_category` values due to 'large midcap' / 'large & midcap' spelling variants missing from `deriveSchemeCategoryFromName` — corrected on dev with a targeted UPDATE and the resolver extended to prevent recurrence.
- **Leaderboard** — benchmark-aware leaders / laggards.
- **Wealth Journey** — corpus-first planning: detected SIP pace, future-SIP targeting, top-ups, withdrawal scenarios, inflation-adjusted side-by-side projections.
- **Tools Hub / Goal Planner** — saved goals with conservative growth defaults; M2/M3/M4 stacked behind feature flags.
- **Settings** — account, portfolio import and auto-forward setup status, Connected Accounts, Preferences (default benchmark, light / dark / system theme picker), in-app Help & FAQs (opens `foliolens.in/faq.html` in an in-app browser), native Request a feature / Report an issue forms with optional screenshot attachment.
- **Dark mode** — full Clear Lens dark palette with a Settings → Preferences picker (light, dark, follow system). Theme-aware app icons (iOS `light` / `dark` / `tinted`, Android adaptive monochrome themed icon, web SVG favicons swapped via `prefers-color-scheme` and overridden at runtime by the in-app picker).
- **Portfolio Insights** — asset mix, market cap, sector exposure, debt / cash mix, top holdings, fund allocation. Source ladder, highest precedence first: **`official`** — parsed AMC monthly disclosures from our own [OpenFolio-Data](https://github.com/himanshu4141/OpenFolio-Data) service (real ISIN-bearing equity **and** debt holdings, sectors, asset mix, and cap split; refreshed monthly by `openfolio-sync` on the 15th and on-demand by `fetch-fund-snapshot`); **`category_fallback`** — mfdata.in holdings (real sectors / holdings / asset mix, SEBI-default cap, refreshed by `sync-fund-portfolios`); **`category_rules`** — SEBI category approximations. The best-row selector (`src/utils/compositionSource.ts`) always renders the highest-precedence source per fund. The market-cap mix on Compare Funds, Portfolio Insights, and Fund Details surfaces a "Showing category averages" disclaimer if a fund doesn't have an `official` row with a real cap split. The full AMFI universe (~10-14k active schemes, not just held funds) is seeded monthly by the `universe-backfill` Edge Function (composition + metadata for all schemes on the 16th, clearing NULL fields when upstream retracts values per the P4 correction pipeline) and kept current by monthly `openfolio-sync` (composition) and daily `sync-fund-meta` (held-fund metadata), so Compare reads composition and metadata locally with no on-demand hydration latency for any scheme in the catalog.
- **Shared scheme catalog** — scheme metadata cached once per `scheme_code` so future users reuse known fund data.
- **Desktop web shell** — at viewports ≥ 1024 px the app renders a Clear Lens left sidebar (logo, primary nav, quick actions, account row → Settings) instead of the bottom tab bar. Portfolio is a 2-column dashboard (chart + entry rows on the left, allocation + Money Trail preview + insights teaser on the right); Funds shows a fund-level summary card (allocation strip, holdings count, top-3 concentration, largest holding, today's best/worst movers) above a hierarchical per-fund card grid; Wealth Journey / Fund Detail / Money Trail / Portfolio Insights / Tools / Settings render as a centered Clear Lens column inside the sidebar shell. Auth (sign in + magic-link confirm) ships as a side-by-side hero + form card on a navy background; onboarding renders inside the sidebar shell. The single `<Tabs>` navigator stays mounted across the breakpoint so resizing preserves the active route. Mobile web and the iOS / Android binaries are unchanged.
- **Persistent local cache** — React Query persists to `localStorage` (web) / AsyncStorage (native) so a page reload paints Portfolio + chart from disk before the network resolves. Per-user raw inputs (`['user-funds', userId]`, `['user-transactions', userId]`) and per-scheme metadata (`['scheme-master', code]`, `['fund-nav-history', code]`) are shared across screens via `qc.fetchQuery` — once Portfolio has loaded the user's funds and transactions, Fund Detail and Compare resolve those in zero network round-trips. Field-measured Fund Detail second-open: **397ms vs 1282ms on first open** (~3.2× speedup). A `useIsRestoring` gate on Portfolio + Fund Detail collapses the rehydrate window so the screen never flashes "Import CAS" before the cached data arrives. Bump `__BUSTER__` in `src/lib/queryClient.ts` to invalidate after a query-shape migration.
- **Three-flavour mobile** — `production`, `preview-main`, `preview-pr` Android builds, each on its own EAS channel, scheme, and bundle ID.
- **Preview mode (beta channels only)** — auth screen offers a "Try with sample data" entry that drops a first-time visitor into a fixture-backed walkthrough (Home, Funds, Fund Detail, Money Trail, Asset Mix, Tools Hub) without sign-in. Gated by an email-capture sheet that opt-in-adds the address to an early-access list. Behind the build-time `EXPO_PUBLIC_FEATURE_PREVIEW_MODE` flag — `true` on `preview-main` / `preview-pr` / development, `false` in production until there's demand. Graduation path to PostHog runtime override is documented in [docs/INFRASTRUCTURE.md](./docs/INFRASTRUCTURE.md#feature-flags).
- **Production gating** — `main` only ever updates DEV; production releases require an explicit `v*` git tag. See [docs/INFRASTRUCTURE.md](./docs/INFRASTRUCTURE.md#branching-merging-releasing) for the full release flow.

---

## Prerequisites

| Tool | Install |
|---|---|
| Node.js 20+ | [nodejs.org](https://nodejs.org) |
| Expo CLI | `npm install -g expo-cli` |
| EAS CLI | `npm install -g eas-cli` |
| Supabase CLI | `brew install supabase/tap/supabase` |

---

## Local setup

### 1. Clone and install

```bash
git clone https://github.com/himanshu4141/FolioLens.git
cd FolioLens
npm install
```

### 2. Environment variables

Copy `.env.example` to `.env.local` and fill in values:

```bash
cp .env.example .env.local
```

```env
# Pick the values for whichever Supabase project you want to develop against.
# DEV is the default; PROD secrets only belong in CI.
EXPO_PUBLIC_SUPABASE_URL=https://imkgazlrxtlhkfptkzjc.supabase.co
EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY=sb_publishable_...
EXPO_PUBLIC_APP_BASE_URL=https://foliolens-dev.vercel.app
```

### 3. Start the app

```bash
npm start         # Expo dev server → scan QR with Expo Go
npm run web       # localhost:8081
npm run android   # connected device / emulator
```

### 3a. Optional: dev auth shortcut + demo portfolio

If you want to test end-to-end without waiting for magic-link emails:

1. Set in `.env.local`:

   ```env
   EXPO_PUBLIC_ENABLE_DEV_AUTH_BYPASS=true
   EXPO_PUBLIC_DEV_AUTH_EMAIL=demo@foliolens.local
   EXPO_PUBLIC_DEV_AUTH_PASSWORD=change-me-local-only
   SUPABASE_SERVICE_ROLE_KEY=<dev service role key>
   ```

2. Seed the demo user and portfolio:

   ```bash
   npm run seed:demo
   ```

3. On the sign-in screen, a `Continue as demo user` shortcut appears on localhost / dev builds. Real CAS files for testing can be kept under `fixtures/private/` (git-ignored).

### 4. Supabase schema

Migrations live under `supabase/migrations/`. To target the DEV project from a fork:

```bash
supabase link --project-ref imkgazlrxtlhkfptkzjc
supabase db push
```

Regenerate TypeScript types after schema changes:

```bash
npm run gen:types
```

---

## Android APKs (install on your phone)

Three flavours, one project. Each has its own scheme, bundle ID, and EAS Update channel:

```bash
eas build --profile preview-pr   --platform android  # rolling PR review build (foliolens-pr)
eas build --profile preview-main --platform android  # stable beta build      (foliolens-main)
eas build --profile production   --platform android  # tagged release build   (foliolens-production)
```

EAS prints a download link; install the APK directly. JS-only changes flow as OTA updates — no rebuild needed unless native modules changed.

---

## Auth: magic link + Google

Magic-link flows through Resend SMTP on `foliolens.in`. Google OAuth uses two Google Cloud Web Client IDs (one per Supabase project). The exact redirect-URL list and dashboard config lives in [docs/INFRASTRUCTURE.md](./docs/INFRASTRUCTURE.md#google-oauth) — re-read that file when adding a new build variant.

The native scheme depends on which APK is installed:

| Variant | Scheme |
|---------|--------|
| `production` | `foliolens://` |
| `preview-main` | `foliolens-main://` |
| `preview-pr` | `foliolens-pr://` |

---

## CI/CD

| Trigger | Workflow | What it does |
|---|---|---|
| PR open / commit | `pr-preview.yml` | typecheck + lint + tests + EAS update to `foliolens-pr` (DEV Supabase) |
| PR commit on `supabase/**` | `supabase-validate.yml` | local migration replay + `db lint` |
| Push to `main` | `main-deploy.yml` | typecheck + lint + tests + EAS update to `foliolens-main` (DEV Supabase) |
| Push to `main` on `supabase/**` | `supabase-deploy-dev.yml` | deploy Edge Functions + push migrations to DEV |
| Manual dispatch | `supabase-deploy-prod.yml` | deploy Edge Functions + push migrations to PROD |
| Tag `v*` push | `production-release.yml` | EAS update to `foliolens-production` + Vercel prod deploy |

For the full secret matrix and per-environment service map, see [docs/INFRASTRUCTURE.md](./docs/INFRASTRUCTURE.md).

---

## Project structure

```
app/                          Expo Router screens
  _layout.tsx                 Root layout (providers + auth gate)
  auth/                       Sign in, confirm, OAuth callback
  (tabs)/                     Portfolio, Leaderboard, Wealth Journey, hidden Settings / Compare
  funds.tsx                   Your Funds list
  fund/[id].tsx               Fund detail
  money-trail/                Money Trail list + transaction detail
  onboarding/                 Drop-zone import wizard (welcome / identity / import / done) + standalone PDF upload
  portfolio-insights.tsx      Portfolio composition detail
  tools/                      Tools Hub + Goal Planner
src/
  components/                 Shared UI (FeedbackSheet, AppOverflowMenu, ClearLens primitives, …)
  hooks/                      useSession, usePortfolio, useFundDetail, usePortfolioInsights, …
  lib/                        supabase.ts, queryClient.ts
  types/                      database.types.ts (generated), app.ts
  utils/                      xirr.ts, formatCurrency.ts, moneyTrail.ts, onboardingDraft.ts, casPdfUpload.ts, casInboxToken.ts, …
supabase/
  functions/                  Edge Functions: parse-cas-pdf, cas-webhook-resend, sync-nav, sync-index, sync-fund-portfolios, sync-fund-meta, …
  migrations/                 SQL migrations (single source of truth for schema)
  templates/                  Email templates (Supabase Auth + Resend transactional templates)
docs/
  INFRASTRUCTURE.md           ← canonical reference for services, environments, workflows
  TECH-DISCOVERY.md           ← data model + integration deep dive
  SCREENS.md                  ← UX surface area
  ROADMAP.md                  ← what's shipped / what's next
  plans/                      ExecPlans (active under per-phase folders, shipped under archive/)
.github/workflows/            CI/CD
```

---

## Phase status

| Phase | Status |
|-------|--------|
| 1 Foundation | Shipped (auth, schema, base CI) |
| 2 Data pipeline + portfolio (M1–M9 + M11) | Shipped |
| 3 Clear Lens design system | Shipped |
| 4 Tools Hub | M0 + M1 (Goal Planner) shipped; M2–M4 stacked |
| 5 CAS onboarding redesign | M1 wizard in flight (PR #92); M2 Resend Inbound backend in flight (PR #93) |
| 6 (planned) | MFCentral OAuth — partner agreement track |

Active ExecPlans live under `docs/plans/<phase>/`. Shipped plans move to `docs/plans/archive/`.
