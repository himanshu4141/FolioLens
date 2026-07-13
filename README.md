# FolioLens

Track an Indian mutual-fund portfolio against benchmarks. Import from CAS, see
SIP-aware returns, inspect fund composition, compare funds, and model future
outcomes.

Start with [VISION.md](./VISION.md) for product intent. Load deeper docs only
when needed:

- [docs/SCREENS.md](./docs/SCREENS.md) — current screen map, navigation, and responsive shell.
- [DESIGN.md](./DESIGN.md) — Clear Lens design system and tokens.
- [docs/INFRASTRUCTURE.md](./docs/INFRASTRUCTURE.md) — environments, CI/CD, Supabase, Vercel, Resend, PostHog, release flow.
- [docs/TECH-DISCOVERY.md](./docs/TECH-DISCOVERY.md) — data sources and ingestion choices.
- [docs/architecture/cache-surfaces.md](./docs/architecture/cache-surfaces.md) — cache layers, persistence, invalidation, and bug taxonomy.

---

## What works now

### Product surfaces

- **Auth** — magic-link sign-in through Resend and Google OAuth through Supabase PKCE. Settings includes connected-account management and account deletion.
- **Portfolio import** — onboarding and later refresh support detailed CAS PDF upload plus Resend inbound auto-forwarding (`cas-<token>@foliolens.in` / `cas-dev-<token>@foliolens.in`). Imports are additive and skip duplicate transactions.
- **Portfolio** — value hero, NAV freshness, SIP-aware XIRR, benchmark comparison, invested-vs-portfolio-vs-benchmark chart, top movers, allocation preview, Money Trail preview, and entry points into detailed screens.
- **Funds and Fund Detail** — allocation overview, searchable/sortable holdings, fund-level XIRR/benchmark context, NAV history, performance, composition, and fund-specific transaction drill-down.
- **Money Trail** — transaction history with Indian-financial-year summaries, filters, search, sorting, CSV export, and transaction detail.
- **Portfolio Insights** — asset mix, market-cap mix, sectors, debt/cash detail, top holdings, source/disclosure context, and fallbacks when official composition data is absent.
- **Tools** — Goal Planner, Compare Funds, Past SIP Check, and Direct vs Regular Impact are implemented behind the in-app `toolsFlags` kill-switches, which default to enabled.
- **Wealth Journey** — corpus and withdrawal scenario planning using current portfolio state plus persisted return assumptions.
- **Settings and support** — benchmark and theme preferences, import/auto-forward setup, data sync/cache-debug tooling, help/FAQ, feature requests, bug reports, and screenshot attachment upload.
- **Desktop web shell** — web viewports ≥ 1024 px use a Clear Lens sidebar; mobile web and native binaries use the mobile bottom-tab layout.

### Data, cache, and observability

- **Primary fund data** — OpenFolio supplies official NAV, metadata, and composition where available. mfapi.in and mfdata.in remain fallbacks for gaps.
- **Local performance cache** — React Query persists bounded rendered results, native SQLite owns durable raw NAV/index/transaction inputs, and Zustand/AsyncStorage hold preferences and small drafts. See the cache inventory before changing any of these surfaces.
- **Freshness and sync** — background sync invalidates only affected query families. Web has explicit transaction-freshness probes so server-side CAS imports do not leave Portfolio stale across reloads.
- **PostHog** — privacy-safe operational/product events cover onboarding/import outcomes, navigation timing, screen readiness, slow events, JS stalls, cache health, persister restore health, and server-side sync/import outcomes.

### Delivery

- **Mobile flavours** — `production`, `preview-main`, `preview-pr`, and local `development` each have their own scheme, bundle ID, and EAS channel.
- **Preview mode** — non-production builds can show a sample-data walkthrough before sign-in.
- **Production gating** — `main` updates DEV only. Production requires an explicit `v*` tag and, when Supabase changed, a manual production Supabase deploy first.

---

## Prerequisites

| Tool | Install |
|---|---|
| Node.js 20+ | [nodejs.org](https://nodejs.org) |
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
npm start         # Expo dev server
npm run web       # localhost Expo web
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

3. On localhost/dev builds, the sign-in screen shows `Continue as demo user`.
   Real CAS files for testing can be kept under `fixtures/private/`
   (git-ignored).

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

## Android builds

Three review/release flavours share one Expo project:

```bash
npm ci
eas build --profile preview-pr   --platform android  # rolling PR review build
eas build --profile preview-main --platform android  # stable beta build
eas build --profile production   --platform android  # tagged release build
eas build --profile production-store --platform android  # Play Store AAB
eas submit --profile production-store --platform android --id <eas-build-id>
```

The `production` profile remains an internal-distribution APK for direct
install testing. The `production-store` profile builds an Android App Bundle
for Google Play, submits to the internal track as a draft, and uses
`in.foliolens.app`.
Every upload in a native train keeps the same Android `versionName`
(`0.0.7` for this train) while EAS auto-increments Play's required
`versionCode` for `production-store` AABs.

JS-only changes flow as OTA updates. Native module/config changes require a rebuild.

Runtime compatibility is managed by Expo fingerprinting. Do not bump
`app.config.js`'s `version` for a JS-only release tag; that value is part of the
native train and changing it changes the fingerprint. `0.0.7` is the first
Play Store / `in.foliolens.*` native train; later JS-only tags can publish an
OTA to installed `0.0.7` binaries only if the app config/native fingerprint is
unchanged.

Pre-`0.0.7` sideloaded Android builds used a different package namespace.
Users on those builds should uninstall before installing the Play Store build.

Run native builds from a clean dependency install (`npm ci`). EAS compares the
runtime fingerprint generated locally with the fingerprint generated on the
remote builder; stale `node_modules` can make the build fail before compilation.
Local Play Store submits read an ignored `play-store-key.json`; the GitHub
workflow writes that file from the `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON` secret.

---

## Auth: magic link + Google

Magic-link flows through Resend SMTP on `foliolens.in`. Google OAuth uses one
Google Cloud Web Client ID per Supabase project. The exact redirect list and
dashboard config live in [docs/INFRASTRUCTURE.md](./docs/INFRASTRUCTURE.md#google-oauth).

| Variant | Scheme |
|---|---|
| `production` | `foliolens://` |
| `preview-main` | `foliolens-main://` |
| `preview-pr` | `foliolens-pr://` |
| `development` | `foliolens-dev://` |

---

## CI/CD

| Trigger | Workflow | What it does |
|---|---|---|
| PR open / commit | `pr-preview.yml` | typecheck + lint + tests + EAS update to `foliolens-pr`; docs-only changes skip the expensive OTA path |
| PR touching tracked cache-shape files | `cache-shape-check.yml` | requires a React Query buster bump or `[cache-shape-stable]` assertion |
| PR touching `supabase/**` | `supabase-validate.yml` | local migration replay + schema lint |
| Program PR events | `program-convergence-gate.yml` | dual-review convergence gate for `program/` branches |
| Push to `main` | `main-deploy.yml` | typecheck + lint + tests + EAS update to `foliolens-main` |
| Push to `main` touching Supabase files | `supabase-deploy-dev.yml` | deploy Edge Functions + push migrations to DEV |
| Manual dispatch | `supabase-deploy-prod.yml` | deploy Edge Functions + push migrations to PROD |
| Manual dispatch | `play-store-submit.yml` | build/submit the Android `production-store` AAB to Play internal testing as a draft |
| Monthly/manual | `universe-backfill.yml` | backfill OpenFolio composition/metadata for the active AMFI universe |
| Tag `v*` push | `production-release.yml` | EAS update to `foliolens-production` + Vercel production deploy |

For the full secret matrix and service map, see
[docs/INFRASTRUCTURE.md](./docs/INFRASTRUCTURE.md).

---

## Project structure

```text
app/                          Expo Router screens
  _layout.tsx                 Root providers, auth gate, lifecycle controllers
  auth/                       Sign in, magic-link confirm, OAuth callback
  (tabs)/                     Portfolio, Funds, Wealth Journey, hidden Settings
  fund/[id].tsx               Fund detail
  money-trail/                Money Trail list + transaction detail
  onboarding/                 CAS import wizard + PDF upload
  portfolio-insights.tsx      Portfolio composition detail
  tools/                      Tools Hub, Goal Planner, Compare, Past SIP, Direct vs Regular
src/
  components/                 Shared UI, Clear Lens screens/primitives, responsive shell
  constants/                  Clear Lens tokens and shared constants
  context/                    Session and theme providers
  hooks/                      Screen/data hooks
  lib/                        Auth/functions/storage/data wrappers, query client, db, analytics
  store/                      Zustand app store
  types/                      Generated DB and app types
  utils/                      Financial math, formatting, CAS/import helpers, tool calculators
supabase/
  functions/                  Edge Functions and shared Deno modules
  migrations/                 SQL migrations, schema source of truth
  templates/                  Auth/Resend email templates
docs/
  architecture/               Cache and architecture inventories
  performance/                Navigation/performance evidence
  plans/                      Active ExecPlans; archive is historical
  process/                    Agent/program protocols
.github/workflows/            CI/CD and program-gate workflows
```
