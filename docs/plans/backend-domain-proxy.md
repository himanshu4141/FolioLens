# Backend Domain Proxy — route client backend calls through foliolens.in

## Goal

Route every client-originated backend request (native app + web) through first-party `foliolens.in` hosts instead of the raw Supabase project host, so a user inspecting network traffic sees `api.foliolens.in` / `api-dev.foliolens.in`, not `<project-ref>.supabase.co`.

## User Value

Today, opening DevTools on `app.foliolens.in` shows every backend request going to `https://ohcaaioabjvzewfysqgh.supabase.co/...` — a raw vendor host that exposes the Supabase project reference and the internal API layout. That is acceptable in dev, but on the production site a visitor who is technically curious should see a clean first-party request view, which is a basic trust signal for a financial app and also happens to improve exit-readiness (a first-party host we control, ahead of any eventual move off Supabase).

## Context

FolioLens is an Expo/React Native app (native + web) backed by Supabase (Postgres + PostgREST + GoTrue Auth + Storage + Edge Functions). Two fully isolated Supabase projects exist: DEV (`imkgazlrxtlhkfptkzjc`) and PROD (`ohcaaioabjvzewfysqgh`) — see `docs/INFRASTRUCTURE.md`. Every backend host the client talks to is derived from one build-time variable, `EXPO_PUBLIC_SUPABASE_URL` (read by `src/lib/supabase.ts`'s `createClient` call, and by two direct-`fetch` call sites: `src/hooks/useIndexSnapshot.ts` and `src/utils/casPdfUpload.ts`). That single choke point is what makes a proxy cutover a contained change rather than a rewrite.

A research report (`docs/research/prod-backend-proxy-foliolens-domain-2026-07-16.md`) analysed the codebase and produced an 11-finding report, a 5-milestone queue (D1–D5), and a program exit criterion. The program initially ran under `docs/process/AGENT-PROGRAM-PLAYBOOK.md` (a dual-review-convergence process, control PR #280) without its own ExecPlan. The human owner paused milestone D1's merge on 2026-07-16 despite a green dual-review gate, on the grounds that a change of this size warranted an ExecPlan from the start. This document is that plan, written after D1 and D2 were already implemented — it records what shipped and governs D3–D5 going forward.

## Assumptions

- The Cloudflare zone for `foliolens.in` already exists and is authoritative (confirmed via a DNS lookup of `foliolens.in`'s nameservers, which point at Cloudflare), so a new subdomain (`api.foliolens.in` / `api-dev.foliolens.in`) needs no registrar-side delegation.
- The Supabase Custom Domain add-on (which would remove the need for a proxy entirely) is explicitly declined for cost by the human owner; this plan is scoped to the free-tier reverse-proxy approach instead.
- Realtime is unused (confirmed in `docs/EXIT-RUNBOOK.md`) and stays that way, so the proxy never needs WebSocket support.
- Auth is bearer-token PKCE, not cookie-based (confirmed in `src/lib/supabase.ts`), so the proxy never needs to rewrite cookies or a cookie domain.
- Two residuals cannot be removed by a plain host proxy on the free tier and are accepted rather than fixed: the Google→GoTrue OAuth **provider callback leg** (registered with Google as `https://<project-ref>.supabase.co/auth/v1/callback`) and the JWT `iss` claim (`https://<project-ref>.supabase.co/auth/v1`) both stay on `*.supabase.co`.

## Definitions

- **Supabase**: the hosted backend platform this app uses — a Postgres database, an auto-generated REST layer over it (PostgREST), an auth service (GoTrue), file storage, and serverless functions (Edge Functions).
- **PostgREST**: Supabase's REST API over Postgres tables, reached at `/rest/v1/...`.
- **GoTrue**: Supabase's auth service (magic link, Google OAuth, session refresh), reached at `/auth/v1/...`.
- **Edge Function**: a small serverless handler Supabase runs on demand, reached at `/functions/v1/<name>`.
- **RLS (Row-Level Security)**: Postgres access-control rules that decide which rows a given request's JWT can see. This is the app's actual security boundary and is unaffected by this program.
- **Publishable/anon key**: a public, non-secret API key every client request sends as the `apikey` header, identifying the project rather than a specific user.
- **Reverse proxy**: a server that sits in front of another server (the "origin") and forwards requests to it, so callers talk to the proxy's hostname instead of the origin's.
- **Cloudflare Worker**: a small piece of JavaScript Cloudflare runs at its network edge, in front of a DNS zone, able to intercept and rewrite HTTP requests before (or instead of) they reach a real origin server.
- **Workers Route**: a Cloudflare Worker's binding to a URL pattern (e.g. `api-dev.foliolens.in/*`) within a zone. It only fires for requests already flowing through Cloudflare's proxy for that hostname, so the hostname needs an existing, Cloudflare-proxied DNS record before the route can do anything.
- **Origin pinning**: constructing the upstream request URL from a fixed, configured constant, never from anything in the inbound request. This is the property that stops a proxy from becoming an "open relay" that an attacker could redirect at an arbitrary host.
- **Cache key**: the identifier a cache uses to decide whether two requests are "the same" and may share one stored response. Here it is deliberately just the requested object's path — never headers or the query string.
- **`env.SUPABASE_ORIGIN`**: the one per-environment Worker binding (dev → DEV Supabase URL, prod → PROD Supabase URL) that origin-pins the proxy. Set in `wrangler.toml`, never derived from the inbound request.

## Scope

- Add a Cloudflare Worker reverse proxy (`workers/api-proxy/`) mapping exactly the four client-facing Supabase path prefixes (`/auth/v1`, `/rest/v1`, `/storage/v1`, `/functions/v1`) to a pinned Supabase origin, for both environments (dev parity: DEV-Supabase-backed builds get `api-dev.foliolens.in`, production gets `api.foliolens.in`).
- Harden the one client-side environment-inference function (`getInboxEnvironment()`, used to render the CAS forwarding-address local-part) so it no longer depends on the backend host containing a `supabase.co` project-ref substring, since a proxy host never contains one.
- Cut both environments over: point every DEV-Supabase-backed build (dev, `preview-pr`, `preview-main`, Vercel dev + PR previews) at `api-dev.foliolens.in` first, then production (`app.foliolens.in` + the prod native channel) at `api.foliolens.in`, each verified with real sign-in evidence before the next one proceeds.
- Update `docs/INFRASTRUCTURE.md`, `docs/EXIT-RUNBOOK.md`, and `.env.example` to reflect the new domain map and the two accepted residuals.

## Out of Scope

- Any change to RLS, API keys, the database schema, or anything that changes what data a request can access. This program only changes the hostname the app talks to; it is a presentation/trust change, not a new security control.
- Server-to-server backend calls: the Resend inbound router calling `cas-webhook-resend`, every pg_cron/pg_net job, and `universe-backfill.yml`. None of these ever appear in a user's browser or app, so re-routing them through the public proxy would add a hop with no user-facing benefit and would widen blast radius. They keep calling `*.supabase.co` directly.
- Removing the Google OAuth provider-callback leg or the JWT `iss` claim from `*.supabase.co`. Neither is achievable without Supabase's paid Custom Domain add-on, which is declined for cost. Both are documented as accepted residuals, not defects for this plan to fix later.
- Realtime / WebSocket support in the proxy — the app does not use Realtime.

## Approach

The proxy is a Cloudflare Worker (`workers/api-proxy/`) with every routing/header/CORS/cache decision written as a pure, unit-tested function (`src/router.ts`, `src/originUrl.ts`, `src/headers.ts`, `src/cache.ts`) and a thin runtime entry (`src/index.ts`) that wires them to the real Workers `fetch`/`caches.default`/`ExecutionContext` APIs — the same pattern this repo already uses for Supabase Edge Functions (`supabase/functions/`), and excluded from the root `tsconfig.json`/`eslint.config.js` for the same reason (runtime-specific globals that would otherwise conflict with the app's own types).

Key correctness decisions, each closing a specific failure mode:

- **Origin URL construction is plain string concatenation**, not `new URL(pathAndQuery, origin)` relative resolution. The latter is vulnerable to protocol-relative host smuggling: a request path starting with `//evil.com/...` makes `new URL('//evil.com/x', 'https://good.co').host` evaluate to `evil.com`. Plain string concatenation of a fully-qualified origin has no relative-resolution step, so the result's host is always the pinned origin regardless of what the path contains.
- **Anything outside the four mapped prefixes 404s** before the origin is ever contacted — no open relay to arbitrary Supabase paths, and no Realtime/WebSocket path exists to misuse.
- **The public storage GET path forwards nothing caller-supplied** — not `Authorization`, `apikey`, `Cookie`, `Range`, or conditional-request headers — because that response is cached under a path-only key. Forwarding any caller-specific header risks a credentialed or partial (`206`) response being cached and replayed to a different caller. Both reviewers found this independently during D1's review, and it is now enforced by a dedicated header-building function plus unit tests.
- **Only a plain `status === 200` response is ever cached**, never an error and never `206 Partial Content` (which `response.ok` alone does not exclude).
- **Auth redirects are relayed, not followed**: the origin fetch uses `redirect: 'manual'` so GoTrue's OAuth `authorize` 302 reaches the browser unchanged, letting the browser navigate to Google directly instead of the Worker silently swallowing the redirect and serving Google's HTML from the proxy host.
- **Environment inference for the CAS forwarding address** (`getInboxEnvironment()`) is reordered so explicit `EXPO_PUBLIC_INBOUND_ENV`, then app variant, then app base URL decide first, with the legacy `supabase.co` project-ref substring check demoted to a last-resort fallback that a proxy host will never reach.

Cutover is staged and reversible: D1 stands up and proves the DEV proxy in isolation (no client changes at all); D2 hardens the client code that would otherwise silently rely on a soon-to-be-absent ref substring; D3 flips every DEV-Supabase-backed build over and proves real sign-in through the proxy; D4 repeats exactly that configuration on production behind an explicit human-pressed release gate; D5 captures production field evidence and closes the documentation.

## Alternatives Considered

- **Supabase Custom Domain (paid add-on)** would remove the need for a proxy and both residuals entirely. Declined for cost by the human owner; this plan is the free-tier alternative.
- **Vercel-hosted proxy** (a rewrite/edge function on the existing SPA project) was the fallback substrate if the Cloudflare zone turned out not to control the `foliolens.in` subdomain. Not needed — a DNS lookup confirmed Cloudflare already controls the zone.
- **Scoping the proxy to production only** (leaving dev/preview builds talking to Supabase directly) was rejected: the human owner wants both environments behind the proxy so the exact production transport path is exercised continuously in dev/preview, rather than the production cutover being the first real use of the proxy.
- **Keeping the environment-inference fallback order as-is** (ref-substring checked before app-base-URL) was rejected because it would leave dev/prod detection for the CAS forwarding address dependent on a signal — the Supabase project ref — that stops existing the moment the backend host becomes a proxy host.

## Milestones

### D1 — Edge proxy Worker + DEV proxy host

Scope: build the Cloudflare Worker reverse proxy and its pure/unit-tested core; verify the Cloudflare zone controls `api-dev.foliolens.in`; deploy to DEV only (`api-dev.foliolens.in` → DEV Supabase). No client code or env var changes.

Expected outcome: all four mapped surfaces are reachable end-to-end through `api-dev.foliolens.in`; unmapped paths 404; the public storage GET is edge-cached correctly and safely (no credential or partial-content leakage).

Commands:

    npx jest workers/api-proxy --runInBand
    npm run typecheck && npm run lint
    npm test -- --runInBand

Acceptance criteria: unit suites for `router`, `originUrl`, `headers`, and `cache` all pass; live evidence against `api-dev.foliolens.in` shows a 404 for a non-mapped path, a `200` from `/auth/v1/settings`, a real Postgres response from `/rest/v1/scheme_master`, a real Edge Function response from `/functions/v1/fetch-fund-nav`, and MISS→HIT caching for a public storage object with the second hit byte-identical to the first.

Status: **implemented, code-complete, dual-review converged** (Codex + Claude, both at commit `dae503e`), but merge is held by explicit human-owner instruction pending this ExecPlan (2026-07-16) — see Decision Log. Full signed-in-session auth/REST verification (`getSession` plus a forced token refresh and an authenticated, row-returning REST read) was descoped from D1 to D3 by a recorded control-PR decision, because minting a real DEV session from the execution sandbox would have required either real test credentials or the discovered Supabase service-role key, and the executor correctly declined to self-authorize using the latter.

### D2 — Client base single-sourcing + dev/prod inference hardening

Scope: keep `EXPO_PUBLIC_SUPABASE_URL` as the single source of the backend host (add a repo-wide guard test asserting no source file hardcodes a `supabase.co` host); harden `getInboxEnvironment()` in `src/utils/casInboxToken.ts` so neither `api.foliolens.in` nor `api-dev.foliolens.in` needs a Supabase project-ref substring to resolve correctly; document the proxy hosts in `.env.example`.

Expected outcome: a production build whose backend base is `api.foliolens.in` still renders `cas-<TOKEN>@foliolens.in` (not a `-dev-` address), and a dev build whose backend base is `api-dev.foliolens.in` still renders `cas-dev-<TOKEN>@foliolens.in` — in both cases without relying on the now-absent project-ref substring.

Commands:

    npx jest src/utils/__tests__/casInboxToken.test.ts src/utils/__tests__/noHardcodedSupabaseHost.test.ts --runInBand
    npm run typecheck && npm run lint
    npm test -- --runInBand

Acceptance criteria: new tests prove correct resolution via explicit env, via app variant alone, and via app base URL alone, for both proxy hosts; the no-hardcoded-host guard passes.

Status: **merged** (PR #282, squash SHA `252e8c0072a69837bc326da132984ea64325be76`). Dual-review convergence: Codex + Claude both converged at `0f3790a1054bc0d548f78ed9e6640c7e4c12fecf`, no actionable threads.

### D3 — Dev cutover + auth/OAuth allowlist + end-to-end auth verification

Scope: add both proxy hosts (`api.foliolens.in/auth/v1/callback`, `api-dev.foliolens.in/auth/v1/callback`) to the Supabase Auth Redirect URLs allowlist and the matching Google OAuth client's Authorized redirect URIs; flip every DEV-Supabase-backed build's `EXPO_PUBLIC_SUPABASE_URL` to `api-dev.foliolens.in` (GitHub `_DEV` secret, EAS `preview`/`development` environments, Vercel dev project) plus `EXPO_PUBLIC_INBOUND_ENV=dev`; verify magic-link and Google sign-in complete end-to-end through the DEV proxy on dev web and a native preview build. This milestone also carries D1's deferred full-session verification: `getSession()` plus a forced token refresh and an authenticated, RLS-scoped REST read, all through `api-dev.foliolens.in`, using a real signed-in session.

Expected outcome: every DEV-Supabase-backed surface (dev web, PR previews, main preview, native preview builds) talks to `api-dev.foliolens.in`, and a real user can sign in, stay signed in across a token refresh, and read their own data — all through the proxy.

Commands:

    npm run typecheck && npm run lint
    npm test -- --runInBand

Acceptance criteria: magic-link and Google sign-in both succeed on dev web and a native preview build with the base pointed at the proxy (exact-SHA native evidence: device, channel, OTA/update ID); a Network capture shows auth/token/authorize plus REST/functions/storage calls landing on `api-dev.foliolens.in`, with the two residuals (the OAuth provider-callback leg, the JWT `iss`) noted as expected exceptions; a forced `/auth/v1/token?grant_type=refresh_token` and a row-returning `/rest/v1` read both succeed through the proxy with a real session.

Status: not started. Depends on D1 (merge) and D2 (merged).

### D4 — Production cutover

Scope: deploy the same Worker to `api.foliolens.in` → PROD Supabase; set the prod backend base and `EXPO_PUBLIC_INBOUND_ENV=prod` in every production surface (EAS `production` environment, GitHub `_PROD` secrets, the prod Vercel project); ship via the existing tag-release path (`production-release.yml`) so the change reaches users only through the repo's explicit human-pressed release gate.

Expected outcome: production web (`app.foliolens.in`) and the production native channel both talk to `api.foliolens.in`, using exactly the configuration already proven in D3.

Commands: confirm `production-release.yml` is green; smoke-test the production web app and a production-channel native build (boot, authenticate, load a portfolio).

Acceptance criteria: the production release workflow run succeeds; production web and a production-channel build authenticate and load a portfolio with no regression. Any user-facing regression (auth, imports, snapshots) stops this milestone and opens a correctness interrupt rather than proceeding.

Status: not started. Human-gated — the executor prepares and stages every step, then the human owner presses the actual production buttons (tag push / workflow dispatch), per this repo's existing prod-release gate.

### D5 — Field verification + docs + exit criterion

Scope: capture production-surface evidence (web plus a production-channel native build) that every app-originated backend request — REST, auth, functions including the CAS PDF upload, and the public index snapshot — targets a `*.foliolens.in` host; update `docs/INFRASTRUCTURE.md` (domain map, secrets, server-to-server scope note, "not a security boundary" framing), `docs/EXIT-RUNBOOK.md`, and `.env.example`.

Expected outcome: the originally reported symptom (a raw Supabase host visible in production DevTools) is closed, with the two residuals explicitly documented as accepted exceptions.

Commands: none beyond the repo validation checklist; this milestone is evidence capture and documentation.

Acceptance criteria: a DevTools Network capture on `app.foliolens.in` (production web) and an equivalent capture on a production-channel native build show every app-originated backend request targeting a `*.foliolens.in` host, re-checked once after a real production auth plus CAS import by an actual user session.

Status: not started. Depends on D4.

## Validation

Repo-wide checklist, run at every milestone's frozen head before requesting review:

    npm run typecheck
    npm run lint
    npm test -- --runInBand
    git diff --check

D1 evidence (commit `dae503e`, live against `api-dev.foliolens.in`): 99 suites / 2009 tests passed. Non-mapped paths (`/realtime/v1`, `/`, `/admin`) all returned `404`. CORS preflight on `/rest/v1/user_profile` returned `204` with the expected headers. `/auth/v1/settings` returned `200` with the DEV project's real GoTrue config. `/rest/v1/scheme_master` reached PostgREST and returned a real Postgres `42501 permission denied` (anon key, no session). `/functions/v1/fetch-fund-nav` returned the function's own `400` validation error, not the proxy's `404`. A public storage object showed MISS→HIT caching with an identical body; a `Range` request no longer returned `206`; non-existent objects (`400`) were never cached.

D2 evidence (commit `0f3790a1`, merged as `252e8c0`): 96 suites / 1983 tests passed. New `casInboxToken` tests covered both proxy hosts via explicit env, app variant alone, and app base URL alone. The no-hardcoded-host guard passed.

## Risks And Mitigations

- Risk: a proxy bug turns the Worker into an open relay to an attacker-chosen host. Mitigation: origin URL construction is plain string concatenation against a pinned constant, never from the request, unit-tested against protocol-relative and embedded-absolute-URL smuggling attempts.
- Risk: the public-storage cache serves one caller's credentialed or partial response to a different caller. Mitigation, found during D1 review: that path forwards nothing caller-supplied at all, and only a plain `status === 200` is ever cached.
- Risk: Cloudflare's zone-level HTTP cache serves cache hits directly, bypassing the Worker's own `caches.default` logic (confirmed live via `wrangler tail` showing zero Worker invocations on a reported cache HIT). Mitigation: the written acceptance criteria (MISS→HIT, no cross-symbol contamination, errors never cached) hold regardless of which layer serves them; the Worker's own cache logic remains correct and becomes the active layer if zone-level caching is ever bypassed for this route. Flagged for the human owner to decide whether a Cache Rule is worth adding later.
- Risk: the CAS forwarding-address environment inference silently renders a dev address to a prod user, or the reverse, once the ref substring disappears from the backend host. Mitigation: D2 reorders the fallback chain and adds tests proving neither proxy host needs the ref substring.
- Risk: the two accepted residuals (the OAuth provider-callback leg, the JWT `iss`) are mistaken for defects and someone attempts to "finish the job" by buying the Custom Domain add-on or otherwise routing around them. Mitigation: documented explicitly in this plan, the research report, and `docs/INFRASTRUCTURE.md`/`docs/EXIT-RUNBOOK.md` as accepted, not open.
- Risk: D4's production cutover ships a regression to real users. Mitigation: human-gated via the repo's existing tag-release process; D3 proves the exact same configuration on dev first; any regression stops the milestone and opens a correctness interrupt instead of proceeding.

## Decision Log

- 2026-07-16: Substrate confirmed as a Cloudflare Worker (the free tier already fronts the domain), not Vercel; the Supabase Custom Domain add-on declined for cost.
- 2026-07-16: Dev parity added — both environments go behind the proxy, not production only, so the proxy path is exercised continuously before production depends on it.
- 2026-07-16: Merge authority set to executor-merges-autonomously-on-a-green-dual-review-convergence-gate; closeout owner set to the Claude reviewer/coordinator session.
- 2026-07-16 (D1): created the `api-dev.foliolens.in` placeholder DNS record (a proxied `A` record → `192.0.2.1`, a documentation-range IP never actually dereferenced) via the Cloudflare API, after explicit human-owner confirmation, since a Workers Route needs an existing, Cloudflare-proxied DNS record for its hostname to be reachable at all.
- 2026-07-16 (D1): declined to use a discovered Supabase service-role-equivalent key to mint a throwaway signed-in test session. Narrowed D1's auth/REST evidence to reachability only as a result, and deferred the full signed-in-session round-trip to D3 by a recorded control-PR decision.
- 2026-07-16 (D1 review round 1): fixed a credential-leak-into-cache defect (found independently by both reviewers) and a `206`-cached-as-full-object defect (found by the Claude reviewer), and closed a `/functions/v1` live-evidence gap; both reviewers converged at the resulting head (`dae503e`).
- 2026-07-16: **Human owner blocked D1's merge despite a green dual-review gate**, on the grounds that a change of this size warranted its own ExecPlan from the start. This document is that plan, created after D1/D2 implementation, to govern review of the remaining work and stand as the durable record of what shipped and why.

## Progress

- [x] D1 — build the Worker, verify DNS/zone control, deploy to `api-dev.foliolens.in`, collect live evidence.
- [x] D1 — address review round 1 (credential-leak-into-cache, `206` cache-poisoning, `/functions/v1` evidence gap); both reviewers converged at `dae503e`.
- [ ] D1 — human-owner sign-off on this ExecPlan, then merge PR #281.
- [x] D2 — harden `getInboxEnvironment()`, add the no-hardcoded-host guard, document `.env.example`; merged as `252e8c0`.
- [ ] D3 — Supabase/Google OAuth allowlist updates; DEV cutover; end-to-end auth verification (including D1's deferred session round-trip).
- [ ] D4 — production cutover (human-gated).
- [ ] D5 — production field evidence; documentation closeout; program exit criterion evaluated.
