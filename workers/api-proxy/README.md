# FolioLens API proxy (Cloudflare Worker)

Thin reverse proxy that maps exactly the four client-facing Supabase surfaces
(`/auth/v1`, `/rest/v1`, `/storage/v1`, `/functions/v1`) from a first-party
`foliolens.in` host to the matching Supabase project. Background and the
full acceptance criteria live in
[`docs/research/prod-backend-proxy-foliolens-domain-2026-07-16.md`](../../docs/research/prod-backend-proxy-foliolens-domain-2026-07-16.md)
(findings 2, 4, 6, 8, 10, 11).

Not a security boundary — RLS + the publishable key remain the only
enforcement point (finding 9). This proxy only changes the hostname the app
talks to.

## Layout

- `src/router.ts`, `src/originUrl.ts`, `src/headers.ts`, `src/cache.ts` —
  pure functions covering every routing/mapping/caching decision. Unit
  tested under `__tests__/` via the repo's root Jest config.
- `src/index.ts` — thin Cloudflare Worker `fetch` handler that wires those
  pure functions to the real runtime (`fetch`, `caches.default`,
  `ExecutionContext`).
- `wrangler.toml` — declares both `env.dev` (routes `api-dev.foliolens.in/*`
  to the DEV Supabase project) and `env.production` (routes
  `api.foliolens.in/*` to PROD). **Only `env.dev` is deployed by D1** — the
  production route is config only until D4's human-gated cutover.

## Prerequisites (one-time, human owner)

1. Confirm the Cloudflare zone controls `foliolens.in` (it does — the
   domain's NS records already point at Cloudflare's nameservers, which
   was verified via DNS lookup as part of D1; see the control PR). No
   registrar-side delegation is needed for a new subdomain under an
   existing Cloudflare-managed zone.
2. A Cloudflare account with API access to that zone, and either:
   - `wrangler login` (interactive OAuth) run once on a machine with
     access, or
   - a scoped Cloudflare API Token (Workers Scripts: Edit, Workers Routes:
     Edit for the `foliolens.in` zone) exported as `CLOUDFLARE_API_TOKEN`,
     plus `CLOUDFLARE_ACCOUNT_ID`.

## Deploying DEV

```bash
cd workers/api-proxy
npm install
npm run deploy:dev   # wrangler deploy --env dev
```

This binds the Worker to the `api-dev.foliolens.in/*` route and sets
`SUPABASE_ORIGIN` to the DEV project from `wrangler.toml`. No app client env
var changes here — D3 flips the DEV-Supabase-backed builds over to this
host.

## Local dev loop

```bash
npm run dev   # wrangler dev --env dev
```

## Typecheck

This directory is excluded from the root `tsconfig.json` / `eslint.config.js`
(Workers-specific globals — `caches`, `ExecutionContext`, `Request`/
`Response`/`Headers` typed via `@cloudflare/workers-types` — would otherwise
conflict with the app's DOM/RN types), the same pattern used for
`supabase/functions/`. Typecheck it directly:

```bash
npm run typecheck
```

The pure modules' unit tests run as part of the repo's normal `npm test`
(they're plain TS using standard `URL`/`Headers`/`Request`/`Response`, all
global in the Node 18+ test environment — no Workers-specific APIs, so no
special Jest environment is needed).

## What this proxy deliberately does not do

- No WebSocket / Realtime support — the app doesn't use Realtime.
- No open relay — any path outside the four mapped prefixes 404s.
- No cookie synthesis or stripping — auth is bearer-token PKCE, not
  cookie-based, so there's nothing to rewrite.
- No caching of anything except public storage `GET` responses, and only
  successful (`res.ok`) ones — a miss/404 is never cached, so the
  paginated-fallback client path always sees a live origin response.
