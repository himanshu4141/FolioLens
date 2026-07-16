# Route all production backend calls through `foliolens.in` (2026-07-16)

**Reported symptom:** on the production web app at `app.foliolens.in`, the browser
DevTools Network panel shows backend requests going straight to
`https://ohcaaioabjvzewfysqgh.supabase.co/...` (e.g. the public index snapshot
`storage/v1/object/public/static-snapshots/index/nifty500tri.json`). Calling
Supabase directly exposes the raw project host — and therefore the project ref,
the vendor, and the internal API layout (`rest/v1`, `auth/v1`, `storage/v1`,
`functions/v1`) — to anyone who opens the app. This is acceptable in dev, but in
production we want every backend call the app makes to originate from a
`foliolens.in` host.

**Conclusion.** The primary fix is a **thin reverse proxy on first-party hosts —
`api.foliolens.in` for production and `api-dev.foliolens.in` for the DEV-Supabase-backed
builds — that forwards the four client-facing Supabase path prefixes to the matching
Supabase origin**, plus repointing each build's single backend base URL at the host
for its environment. It is **not** a rewrite of the app's data/auth/storage layers,
**not** a migration off Supabase, and **not** a new security control. The app already
funnels every backend hostname through one build-time variable
(`EXPO_PUBLIC_SUPABASE_URL`), auth is bearer-token rather than cookie-based, and
Realtime is unused — so the client-side change is small and the real work is
standing up and verifying the edge proxy. Two residuals cannot be removed by a
plain proxy and are accepted, documented, and out of the app's own request path:
the Google→GoTrue OAuth **provider callback leg** and the JWT `iss` claim, both of
which stay on `*.supabase.co` on the hosted plan without Supabase's paid Custom
Domain feature (explicitly declined for cost).

**Motivation.** The driver is **user trust in the website**, not security: a visitor
who opens DevTools on `app.foliolens.in` should see backend calls to a first-party
`foliolens.in` host, not a raw vendor host. Both environments are put behind the proxy
so this holds everywhere the app runs and so the proxy path is exercised continuously
in dev before prod depends on it. Auth is a **one-time** flow per sign-in, so the
transient `supabase.co` OAuth callback leg is an acceptable residual.

This is a presentation / trust / exit-readiness change. Row-Level Security and the
public publishable key remain the only security boundary; the Supabase project stays
reachable at its `*.supabase.co` host and the proxy adds no authentication.

---

## Baseline and scope

| | |
|---|---|
| Repository | `himanshu4141/FolioLens` |
| Commit analysed | `50384afe184ad408f0a8a41cec927253ac89d5a5` |
| Commit date | 2026-07-16 |
| Analysis date | 2026-07-16 |
| Chosen approach | Reverse proxy on a first-party host, **Cloudflare Worker** substrate (human-owner decisions: stay on the Supabase free tier — the paid Custom Domain add-on was declined; Cloudflare confirmed as the proxy substrate) |
| Surfaces covered | Client backend transport: PostgREST (`rest/v1`), Auth/GoTrue (`auth/v1`), Edge Functions (`functions/v1`), Storage (`storage/v1`); auth redirect/OAuth config; build-time env wiring; dev/prod inference |
| Environments in scope | **Both** — production builds → `api.foliolens.in` → PROD Supabase; all DEV-Supabase-backed builds (dev, `preview-pr`, `preview-main`, Vercel dev project + PR previews) → `api-dev.foliolens.in` → DEV Supabase (dev parity, human-owner decision) |
| Static checks | `npm run typecheck` and `npm run lint` are green on the analysed commit (docs-only research PR adds no code) |
| Out of scope | Server-to-server backend calls (Resend router → Edge Functions, `notify-feedback`, freshness alerts, pg_cron/pg_net, universe-backfill) — not user-visible, stay direct; any change to RLS, keys, or the data model |

### Evidence standard

- **Confirmed** — directly demonstrated by current code in this repo (with
  `file:line`) or by documented, checked-in infrastructure facts.
- **Strong** — a complete causal path from current code + platform behaviour, but
  the exact production outcome must be observed on the real proxy before it is
  treated as closed.
- **Candidate** — a credible risk or prerequisite to verify early; not yet
  demonstrated.

No development-server timing is used as evidence for production behaviour. The
program exit criterion (§9) is field evidence captured on the production web and
native builds, not a local run.

---

## Executive summary

| Order | Finding | Severity | Confidence | Explains / why it matters |
|---:|---|---|---|---|
| 1 | Every backend hostname is funneled through one build-time var `EXPO_PUBLIC_SUPABASE_URL` | P0 enabler | Confirmed | Makes the cutover a one-variable repoint; low code risk |
| 2 | Exactly four client-facing surfaces are in scope; Realtime is unused (no WebSocket proxy needed) | P0 | Confirmed | Bounds the proxy's path map precisely |
| 3 | Dev/prod inference and the CAS inbox address key off the `*.supabase.co` project-ref substring | P0 correctness | Confirmed | Silently mislabels prod as dev once the base host changes |
| 4 | Auth is bearer-token PKCE, not cookie-based — no cookie-domain proxy problem | P0 simplifier | Confirmed | Removes the hardest class of reverse-proxy bug up front |
| 5 | The Google OAuth provider-callback leg and JWT `iss` stay on `supabase.co` with a plain proxy | P1 residual | Strong | Sets honest expectations; defines the accepted residual |
| 6 | The public storage snapshot depends on CDN stale-while-revalidate; the proxy must preserve edge caching | P1 | Confirmed | Prevents a latency regression on a hot read |
| 7 | Server-to-server backend calls are out of scope and must stay direct | P1 scope | Confirmed | Avoids re-routing non-user-visible traffic through a public hop |
| 8 | The origin routes by hostname; the proxy must rewrite to `<ref>.supabase.co`, not forward the public Host | P0 | Strong | The single most likely way to break routing |
| 9 | This is presentation / exit-readiness, not a security boundary | P2 | Confirmed | Docs must not overstate what the proxy protects |
| 10 | DNS prerequisite: confirm the Cloudflare zone controls `api.foliolens.in` and bind the Worker route | P2 prerequisite | Candidate | Substrate is Cloudflare (confirmed); verify zone control in D1 |
| 11 | Free-tier edge capacity/limits | P2 | Candidate | Beta volume is low; monitor after cutover |

---

## 1. Every backend hostname is funneled through one build-time variable — P0 (enabler)

**Status: Confirmed. This is why the cutover is a small, low-risk client change.**

Every place the app talks to a backend host derives that host from the single
build-time variable `EXPO_PUBLIC_SUPABASE_URL`:

- The supabase-js client base — `src/lib/supabase.ts:6` (`createClient(supabaseUrl, ...)`).
  supabase-js appends `/auth/v1`, `/rest/v1`, `/storage/v1`, and `/functions/v1`
  to this base, so **all** wrapper traffic (`authClient`, the `src/lib/data/*`
  repos, `functionsClient`, `storageClient`) inherits the base.
- The public snapshot fetch — `src/hooks/useIndexSnapshot.ts:46-48` builds
  `${EXPO_PUBLIC_SUPABASE_URL}/storage/v1/object/public/<bucket>/<path>` directly.
- The CAS PDF upload — `src/utils/casPdfUpload.ts:39-44` builds
  `${EXPO_PUBLIC_SUPABASE_URL}/functions/v1/parse-cas-pdf` directly.
- Dev/prod inference reads it — `src/utils/casInboxToken.ts:41-43` (see finding 3).

Because both non-supabase-js fetch sites already read the same variable, pointing
`EXPO_PUBLIC_SUPABASE_URL` at the proxy host repoints them for free — no call-site
edits are required for transport.

### Required fix

1. Keep the base URL single-sourced. Do not introduce a second hostname source; if
   a distinct name is wanted for clarity (e.g. `EXPO_PUBLIC_BACKEND_BASE_URL`), it
   must resolve to the same value and be the only source.
2. Add a guard/test asserting no module hardcodes a `*.supabase.co` host for a
   client request path (the two direct-fetch sites and the client base).

### Acceptance criteria

- Grep of `src/` and `app/` shows no client-request URL built from a literal
  `supabase.co` host; all derive from the single base var.
- With the prod base set to `https://api.foliolens.in`, supabase-js issues requests
  to `https://api.foliolens.in/{auth,rest,storage,functions}/v1/...` and the two
  direct-fetch sites target the same host.

---

## 2. Four client-facing surfaces are in scope; Realtime is unused — P0

**Status: Confirmed. The proxy path map is exactly these four prefixes.**

Client-originated backend traffic reaches Supabase through four path prefixes:

| Prefix | Reached via | Evidence |
|---|---|---|
| `/rest/v1` | `src/lib/data/*` repos (`.from()`) | `src/lib/data/README.md`; e.g. `src/lib/data/indexHistory.ts` |
| `/auth/v1` | `authClient` (magic link, Google OAuth, PKCE exchange, token refresh, signOut) | `src/lib/auth/index.ts:49-73`; `src/lib/supabase.ts:13-21` |
| `/functions/v1` | `functionsClient.invoke` + direct fetch in CAS upload | `src/lib/functions/index.ts:17-26`; `src/utils/casPdfUpload.ts:44` |
| `/storage/v1` | `storageClient.from()` (feedback attachments) + direct public snapshot GET | `src/lib/storage/index.ts:17-24`; `src/hooks/useIndexSnapshot.ts:48` |

Realtime is **not used** and must stay that way (`docs/EXIT-RUNBOOK.md` "Realtime /
Vault / RPC → None"). This is important: it means the proxy needs **no WebSocket
support**, eliminating the hardest reverse-proxy case. The proxy is request/response
HTTP only.

### Required fix

- The proxy maps exactly `/{auth,rest,storage,functions}/v1/*` to the Supabase
  origin and passes methods, query strings, request/response bodies, and headers
  through. Any path outside those prefixes returns 404 from the proxy (do not build
  an open relay to arbitrary Supabase paths).

### Acceptance criteria

- Each of the four surfaces is exercised end-to-end through the proxy against DEV
  Supabase (D1 evidence): a REST select returns rows; `getSession`/token refresh
  succeeds; a `functionsClient.invoke` returns; a public storage GET returns JSON.
- A request to a non-mapped path (e.g. `/realtime/v1`) is rejected by the proxy.

---

## 3. Dev/prod inference keys off the `*.supabase.co` project ref — P0 (correctness)

**Status: Confirmed. This breaks the CAS inbox address the moment the prod base
host changes, and must be fixed before the cutover.**

`getInboxEnvironment()` decides `dev` vs `prod` — which selects the user-visible CAS
forwarding address (`cas-dev-<token>@` vs `cas-<token>@`) — partly by substring-matching
the Supabase URL against the hardcoded project refs:

```
src/utils/casInboxToken.ts:24  const DEV_SUPABASE_PROJECT_REF = 'imkgazlrxtlhkfptkzjc';
src/utils/casInboxToken.ts:25  const PROD_SUPABASE_PROJECT_REF = 'ohcaaioabjvzewfysqgh';
src/utils/casInboxToken.ts:41-43  const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL ?? '';
                                  if (supabaseUrl.includes(DEV_SUPABASE_PROJECT_REF)) return 'dev';
                                  if (supabaseUrl.includes(PROD_SUPABASE_PROJECT_REF)) return 'prod';
```

Once the prod base is `https://api.foliolens.in`, the `PROD_SUPABASE_PROJECT_REF`
branch never matches. The function currently *happens* to still return `prod` via
the downstream `appBaseUrl` fallback (`app.foliolens.in` → not dev → `prod`), but
that is incidental, undocumented, and fragile: any reordering, or a prod build with
a non-default `EXPO_PUBLIC_APP_BASE_URL`, could silently render a **dev** inbox
address to a prod user, routing their CAS email to the wrong Supabase project.
Tests pin the ref-substring behaviour directly (`src/utils/__tests__/casInboxToken.test.ts:100-103`).

### Required fix

1. Make the prod environment explicit rather than inferred from the backend host:
   set `EXPO_PUBLIC_INBOUND_ENV=prod` in the production build config (and `dev` in
   dev), which `getInboxEnvironment()` already honours first
   (`casInboxToken.ts:35-36`).
2. Demote the `*.supabase.co` project-ref substring check to a last-resort fallback,
   and add `appVariant === 'production'` as a positive prod signal.
3. Update `casInboxToken.test.ts` to cover a prod base of `https://api.foliolens.in`
   with `EXPO_PUBLIC_INBOUND_ENV=prod`, asserting a `cas-<token>@foliolens.in`
   address (no `-dev-`).

### Acceptance criteria

- A production build with `EXPO_PUBLIC_SUPABASE_URL=https://api.foliolens.in`
  renders `cas-<TOKEN>@foliolens.in`.
- A dev build with the dev base still renders `cas-dev-<TOKEN>@foliolens.in`.
- No test depends on the prod base containing the string `supabase.co`.

---

## 4. Auth is bearer-token PKCE, not cookie-based — P0 (simplifier)

**Status: Confirmed. The proxy does not have to rewrite cookies or domains.**

The client persists the session client-side and authenticates with an
`Authorization: Bearer <jwt>` header + the `apikey` header, using the PKCE flow:

```
src/lib/supabase.ts:13-21
  auth: { storage (AsyncStorage on native / localStorage on web),
          autoRefreshToken: true, persistSession: true,
          detectSessionInUrl: web only, flowType: 'pkce' }
```

There are no Supabase auth **cookies** to rewrite across the `api.foliolens.in`
origin, which removes the single most common reverse-proxy auth failure. The proxy's
only job for auth is to forward `Authorization` and `apikey` headers unchanged and
return GoTrue's JSON responses. The PKCE code verifier is client-held and the code
exchange (`/auth/v1/token?grant_type=pkce`) is a client-originated call that flows
through the proxy like any other.

### Required fix

- The proxy forwards `Authorization`, `apikey`, and `Content-Type` verbatim and
  does not strip or synthesise cookies.
- Preserve CORS for the web origin: forward GoTrue/PostgREST/Storage CORS response
  headers and answer `OPTIONS` preflight (native has no CORS; web is cross-origin
  between `app.foliolens.in` and `api.foliolens.in`).

### Acceptance criteria

- Through the proxy: `authClient.getSession()` + a forced token refresh succeed,
  and an authenticated REST read returns the user's rows (RLS enforced as today).
- On the web build, a cross-origin preflight to `api.foliolens.in` succeeds and the
  subsequent request carries the expected CORS headers.

---

## 5. The Google OAuth callback leg and JWT `iss` stay on `supabase.co` — P1 (accepted residual)

**Status: Strong. This is the honest limit of a plain proxy; document and accept it.**

Two things a plain host proxy **cannot** move to `foliolens.in` on the hosted plan:

1. **The Google→GoTrue provider callback.** GoTrue's external URL — the
   `redirect_uri` it hands Google, registered in Google Cloud Console as
   `https://<ref>.supabase.co/auth/v1/callback` (`.env.example:31-32`) — is fixed to
   the `*.supabase.co` host without Supabase's Custom Domain feature. When the app
   opens the (now proxied) `…/auth/v1/authorize?provider=google…` URL, GoTrue still
   302-redirects the browser to Google with the `supabase.co` callback, so the
   browser's Google→GoTrue hop lands on `supabase.co` before returning to the app.
2. **The JWT `iss` claim.** Access tokens are issued with
   `iss = https://<ref>.supabase.co/auth/v1`. The client never *requests* the `iss`
   URL, and neither RLS/`auth.uid()` nor supabase-js validate `iss` against the base
   URL, so proxying works — but a decoded bearer token still names the project.

Neither is an *app-originated request URL* visible in the normal Network panel of
day-to-day use, so both are compatible with the stated goal ("backend calls the app
makes originate from `foliolens.in`"). They are the price of declining the paid
Custom Domain add-on and must be recorded as known residuals.

**Why this is acceptable (human-owner rationale).** The program's driver is user
trust in the clean, everyday first-party request view, not hiding the vendor. Auth is
a **one-time flow per sign-in**: the `supabase.co` callback leg appears only during
that transient hop, not in the steady-state traffic a curious visitor sees, and the
`iss` claim surfaces only if someone deliberately decodes a bearer token. Both are
accepted as residuals rather than reasons to buy the Custom Domain add-on.

### Required fix

1. Add `https://api.foliolens.in/auth/v1/callback` to the Supabase Auth **Redirect
   URLs** allowlist and to the Google Cloud OAuth client's Authorized redirect URIs,
   so the proxied `authorize` URL and any redirect back through the proxy are
   accepted. (The app's own post-auth redirect targets — `app.foliolens.in/auth/*`
   and the native `foliolens://` schemes — are unchanged: they point at the app, not
   the API. See `src/utils/appScheme.ts:20-24`, `app/auth/index.tsx:153-160`.)
2. Verify magic-link sign-in and Google sign-in complete end-to-end with the base
   pointed at the proxy, on both web and a native preview build.
3. Document both residuals in `docs/INFRASTRUCTURE.md` and this report.

### Acceptance criteria

- Magic-link and Google sign-in both succeed with `EXPO_PUBLIC_SUPABASE_URL` set to
  the proxy host (D3 evidence, native at an exact SHA).
- The two residuals (provider callback leg; `iss`) are written down as accepted, not
  silently shipped.

---

## 6. The public storage snapshot depends on CDN stale-while-revalidate — P1

**Status: Confirmed. The proxy must preserve (or improve) edge caching for the
public bucket, or a hot read regresses.**

`useIndexSnapshot` deliberately trades 2–8 paginated PostgREST round-trips for a
single CDN fetch with `stale-while-revalidate=86400`:

```
src/hooks/useIndexSnapshot.ts:1-18 (design note), 45-49 (URL), 55-77 (raw fetch)
```

If the proxy forwards this GET without caching, every client pays a full origin
round-trip and loses the ~30–80 ms edge behaviour the design relies on. The path is
public (no auth), so it is safe and cheap to cache at the proxy edge.

### Required fix

1. The proxy caches `GET /storage/v1/object/public/*` at the edge, keyed by the full
   object path, honouring/setting a `stale-while-revalidate` TTL comparable to
   today's. No auth header is required or forwarded on this path.
2. Cache-key correctness test: a request for symbol A's snapshot never returns
   symbol B's cached body (distinct object paths → distinct cache entries).
3. The `fetchIndexSnapshot` → paginated-fallback path
   (`useIndexSnapshot.ts:117-128`) must still work on a proxy miss/404.

### Acceptance criteria

- Two sequential proxied GETs for the same snapshot show the second served from the
  edge cache (cache-status header / timing), returning correct JSON.
- A request for a different symbol returns that symbol's data, never a stale
  cross-symbol body.
- Deleting/blocking the snapshot object still yields a working screen via the
  PostgREST fallback.

---

## 7. Server-to-server backend calls are out of scope — P1 (scope boundary)

**Status: Confirmed. These are not user-visible and must stay direct.**

Several backend calls never touch a user's browser/app and therefore do not expose
anything in the app's Network panel:

- Resend inbound router (Vercel) → `cas-webhook-resend` Edge Function
  (`SUPABASE_PROD_FUNCTION_URL=…supabase.co/functions/v1/cas-webhook-resend`,
  `.env.example:84-85`).
- `notify-feedback`, freshness alerts, and every pg_cron/pg_net caller, all of which
  target the Edge Function base via `public.app_config_get(...)`
  (`docs/INFRASTRUCTURE.md` "app_config").
- `universe-backfill.yml` (GitHub Actions → Edge Function).

Re-routing these through the public proxy adds a hop and a dependency with **no**
user-facing benefit (they are already invisible to end users) and would widen blast
radius. Leave them on the direct `*.supabase.co` host.

### Required fix

- Explicitly scope the program to client-originated traffic (the app bundle: native
  + web). Note the server-to-server exclusion in `docs/INFRASTRUCTURE.md` so a future
  reader does not "finish the job" by proxying cron.

### Acceptance criteria

- After cutover, the Resend router, cron jobs, and universe-backfill continue to
  call Supabase directly and are unaffected.

---

## 8. The origin routes by hostname — the proxy must rewrite to `<ref>.supabase.co` — P0

**Status: Strong. This is the most likely single point of breakage.**

Supabase's edge routes requests to a project by the request **hostname**
(`<ref>.supabase.co`). A naive proxy that forwards the inbound `Host: api.foliolens.in`
to the origin will mis-route or 404. The proxy must construct the origin request
against `https://<ref>.supabase.co` (so `fetch` sets the correct `Host`/SNI) and must
**pin** that origin — it must not proxy to a host taken from the request, which would
create an open relay.

### Required fix

1. Build the origin URL as `new URL(pathAndQuery, SUPABASE_ORIGIN)` where
   `SUPABASE_ORIGIN` is a configured constant/secret (the project's `*.supabase.co`
   base), never derived from request headers.
2. Unit-test the URL/host mapping and origin pinning (a spoofed `Host` or an attempt
   to smuggle an absolute URL cannot change the origin).

### Acceptance criteria

- A proxied request reaches the intended project (D1 evidence against DEV).
- A request attempting to change the target host does not reach any other origin.

---

## 9. This is presentation / exit-readiness, not a security boundary — P2

**Status: Confirmed. Docs must state this plainly.**

The proxy changes the hostname the app talks to; it does not add authentication and
does not hide the project (the `*.supabase.co` host remains reachable and is still
named in the JWT `iss` and the OAuth callback leg). Security continues to rest on RLS
+ the publishable key, exactly as today (`docs/EXIT-RUNBOOK.md` posture). The benefit
is **user trust and presentation** — a visitor inspecting the site sees first-party
`foliolens.in` backend calls rather than a raw vendor host — plus a cleaner
exit-readiness seam (a first-party host we control the DNS for), consistent with the
wrapper-boundary strategy the repo already maintains. Putting **both** environments
behind the proxy also means dev/preview builds exercise the exact production transport
path continuously, so the prod cutover is not the first real use.

### Required fix / Acceptance criteria

- `docs/INFRASTRUCTURE.md` and `docs/EXIT-RUNBOOK.md` describe the proxy as a
  transport/presentation layer, explicitly *not* a security control, and record the
  two residuals from finding 5.

---

## 10. DNS zone prerequisite for the Cloudflare Worker — P2 (verify in D1)

**Status: Candidate. Confirm the zone controls the subdomain before D1 binds the
Worker route.**

`docs/INFRASTRUCTURE.md` states DNS for `foliolens.in` "lives at the registrar",
Cloudflare "proxies the apex", and `app.foliolens.in` passes through **unproxied** to
Vercel. To host `api.foliolens.in` as a Cloudflare Worker we need the Cloudflare zone
to control that subdomain and a Worker route bound to it. If zone control is
partial/registrar-bound, the fallback substrate is a proxy on Vercel (a rewrite/edge
function on a dedicated host) — at the cost of Vercel execution budget and mixing the
API proxy into the SPA project.

**Substrate: Cloudflare Worker (confirmed by the human owner).** Cloudflare already
fronts the domain, the Workers free tier ≈ 100k req/day, and it keeps the proxy off
Vercel's budget and out of the disconnected prod SPA project. D1 still verifies that
the Cloudflare zone controls `api.foliolens.in` (and `api-dev.foliolens.in`) and binds
the Worker route; if zone control turns out to be blocked at the registrar, that is a
human-owner escalation, not a silent switch to another substrate.

### Acceptance criteria

- `api.foliolens.in` resolves to the chosen proxy substrate and serves the four
  mapped prefixes; the substrate decision is recorded in the control PR.

---

## 11. Free-tier edge capacity and limits — P2 (Candidate)

Cloudflare Workers free tier is ≈100k requests/day with a per-request CPU budget;
proxying is I/O-bound subrequests, well within budget for closed-beta volume. Note as
a post-cutover monitoring item, not a blocker. If volume grows, the Worker paid tier
or Vercel is a straightforward upgrade.

---

## Recommended implementation order

Sequenced per the program's rule: prove/instrument the reversible edge first,
land the client correctness fix, cut **dev** over to the proxy while verifying auth
end-to-end, then cut **prod** over under a human gate, then verify in the field and
document. Dev goes first (parity) so the exact production transport path runs
continuously in dev/preview before prod depends on it.

| Queue | Milestone | Scope | Why this position |
|---:|---|---|---|
| 1 | **D1 — Edge proxy Worker + DEV proxy host** | Commit the reverse-proxy (pure, unit-tested mapping + thin runtime entry) and its config; deploy the Cloudflare Worker to `api-dev.foliolens.in` → DEV Supabase; prove all four surfaces + caching + origin pinning. | Reversible, ships nothing to prod, de-risks everything downstream. The "instrument first" analog. |
| 2 | **D2 — Client base single-sourcing + dev/prod inference hardening** | Single-source the backend base; make **each** env explicit (`EXPO_PUBLIC_INBOUND_ENV` for dev and prod); demote the `*.supabase.co` ref check; add the no-hardcoded-host guard; update `.env.example` + tests. | Correctness fix that must land before any URL flip so inbox/env stay correct in both environments. Independent of D1. |
| 3 | **D3 — Dev cutover + auth/OAuth allowlist + end-to-end auth verification** | Add both proxy hosts to Supabase Redirect URLs + Google Authorized redirect URIs; flip the DEV-Supabase-backed build envs (GitHub `_DEV` secret, EAS `preview`/`development` env, Vercel dev project) to `api-dev.foliolens.in` + `EXPO_PUBLIC_INBOUND_ENV=dev`; verify magic-link + Google sign-in on dev web (`foliolens-dev.vercel.app`) and a native preview build; document residuals. | Depends on D1 (host exists) + D2 (robust inference). Dev cutover is the low-risk full rehearsal of D4 and turns on continuous parity. |
| 4 | **D4 — Production cutover** | Deploy the Worker to `api.foliolens.in` → PROD Supabase; flip prod `EXPO_PUBLIC_SUPABASE_URL` (+ `EXPO_PUBLIC_INBOUND_ENV=prod`) in EAS `production` env, GitHub `_PROD` secrets, and the prod Vercel project; ship via the tag release path. | The prod switch, now a repeat of the proven D3 dev cutover. Human-gated (matches the repo's explicit prod-release gate). Depends on D3 green. |
| 5 | **D5 — Field verification + docs + exit criterion** | Capture prod web + native network evidence that all app-originated backend calls target `*.foliolens.in`; update `INFRASTRUCTURE.md` (domain map, secrets), `EXIT-RUNBOOK.md`, `.env.example`; record residuals. | Closes the program against the reported symptom. |

**Independent tracks:** D1 (infra/edge) and D2 (client code) touch disjoint files and
may be built in parallel if two executors are available; D3 requires both. D3→D4→D5
are strictly sequential. The default single-executor program runs them in queue order.

---

## Per-milestone task prompts

Each block is standalone. Fill the program constants (control PR number, research
branch) from the control plane before dispatch.

### D1 — Edge proxy Worker + DEV proxy host

```
You are the Execution owner implementing milestone D1 of the "Backend Domain
Proxy" program. Read the program protocol in
docs/process/AGENT-PROGRAM-PLAYBOOK.md (§5.3 cycle) and the control-plane PR
DESCRIPTION for the tracking table + ledger before starting. Read this report's
findings 2, 6, 8, 10, 11 and §"Recommended implementation order" via:
  git show origin/<RESEARCH_BRANCH>:docs/research/prod-backend-proxy-foliolens-domain-2026-07-16.md

Read before coding: docs/INFRASTRUCTURE.md ("Domain map", "Vercel projects",
"The two Supabase projects"), docs/EXIT-RUNBOOK.md, src/lib/supabase.ts,
src/hooks/useIndexSnapshot.ts.

Scope: add a thin reverse proxy that maps exactly the client-facing prefixes
/auth/v1, /rest/v1, /storage/v1, /functions/v1 to a CONFIGURED Supabase origin
(a pinned constant/secret, never from request headers — finding 8). Requirements:
  - Forward method, query, body, and headers verbatim (Authorization, apikey,
    Content-Type). Do not synthesise or strip cookies (finding 4).
  - Answer CORS preflight (OPTIONS) and pass through CORS response headers so the
    web origin app.foliolens.in can call the proxy cross-origin (finding 4).
  - Edge-cache GET /storage/v1/object/public/* keyed by full object path with a
    stale-while-revalidate TTL comparable to today's; no auth on that path
    (finding 6).
  - Return 404 for any non-mapped path (no open relay; no WebSocket — Realtime is
    unused, finding 2).
  - Structure the code so the routing/mapping/caching decisions are PURE functions
    unit-tested with the repo's existing Jest, with a thin runtime entry
    (Cloudflare Worker — the confirmed substrate; wrangler config included). Put the proxy under
    a new top-level dir (e.g. workers/api-proxy/) excluded from the app tsconfig if
    it needs runtime-specific types, per the AGENTS.md Edge-Function-style rule.
Non-goals: no change to any src/ app code; no prod deploy; no client env change;
no server-to-server re-routing (finding 7).

Infra: the substrate is a Cloudflare Worker (confirmed). FIRST verify the DNS/zone
question in finding 10 (does the Cloudflare zone control api-dev.foliolens.in?); if
zone control is blocked at the registrar, escalate to the human owner rather than
switching substrate. Deploy the proxy to api-dev.foliolens.in → DEV Supabase
(imkgazlrxtlhkfptkzjc).

Validation: npm run typecheck; npm run lint; npm test -- --runInBand; git diff
--check; plus the proxy's own unit tests (path mapping, header/CORS handling,
origin pinning, cache-key correctness). Evidence (record exact commit SHA):
against api-dev.foliolens.in show a REST select returning rows, getSession + a
forced token refresh, a functionsClient.invoke response, a public storage GET that
is edge-cached on the second hit, and a rejected non-mapped path.
```

### D2 — Client base single-sourcing + dev/prod inference hardening

```
You are the Execution owner implementing milestone D2 of the "Backend Domain
Proxy" program. Read docs/process/AGENT-PROGRAM-PLAYBOOK.md (§5.3), the control PR
DESCRIPTION, and this report's findings 1 and 3 via
  git show origin/<RESEARCH_BRANCH>:docs/research/prod-backend-proxy-foliolens-domain-2026-07-16.md

Read before coding: src/utils/casInboxToken.ts,
src/utils/__tests__/casInboxToken.test.ts, src/lib/supabase.ts,
src/hooks/useIndexSnapshot.ts, src/utils/casPdfUpload.ts, .env.example,
docs/INFRASTRUCTURE.md ("Feature flags", "Secrets matrix").

Scope:
  1. Keep the backend base URL single-sourced (finding 1). Add a test/guard that no
     client request URL is built from a literal supabase.co host.
  2. Make the environment explicit rather than inferred from the backend host
     (finding 3), for BOTH environments (dev parity): honour EXPO_PUBLIC_INBOUND_ENV
     first (already supported), add appVariant === 'production' as a positive prod
     signal, and demote the *.supabase.co project-ref substring check to a
     last-resort fallback. After this, neither a prod base of api.foliolens.in nor a
     dev base of api-dev.foliolens.in relies on the host containing a supabase.co ref.
  3. Update casInboxToken.test.ts to cover a prod base of https://api.foliolens.in
     with EXPO_PUBLIC_INBOUND_ENV=prod asserting cas-<TOKEN>@foliolens.in, AND a dev
     base of https://api-dev.foliolens.in with EXPO_PUBLIC_INBOUND_ENV=dev asserting
     cas-dev-<TOKEN>@foliolens.in.
  4. Update .env.example to document EXPO_PUBLIC_SUPABASE_URL pointing at the proxy
     host per environment (api.foliolens.in / api-dev.foliolens.in) and the explicit
     EXPO_PUBLIC_INBOUND_ENV.
Non-goals: no infra; no EAS/Vercel/GitHub env values changed here (only .env.example
docs; the real console flips are D3 for dev and D4 for prod); no transport code
changes to the direct-fetch sites (they already read the base var).

Validation: npm run typecheck; npm run lint; npm test -- --runInBand (run the full
suite — this touches shared utils); git diff --check. Evidence: the new/updated
casInboxToken tests passing for prod-via-proxy AND dev-via-proxy; the no-hardcoded-host
guard passing.
```

### D3 — Dev cutover + auth/OAuth allowlist + end-to-end auth verification

```
You are the Execution owner implementing milestone D3 of the "Backend Domain
Proxy" program. Read docs/process/AGENT-PROGRAM-PLAYBOOK.md (§5.3), the control PR
DESCRIPTION, and this report's findings 4 and 5 via
  git show origin/<RESEARCH_BRANCH>:docs/research/prod-backend-proxy-foliolens-domain-2026-07-16.md

Depends on: D1 (api-dev.foliolens.in live) and D2 (merged). Read before starting:
src/lib/auth/index.ts, src/lib/oauthCompletion.ts, app/auth/index.tsx,
app/auth/callback.tsx, app/auth/confirm.tsx, src/utils/appScheme.ts, eas.json,
docs/INFRASTRUCTURE.md ("Google OAuth", "Vercel projects", "Expo / EAS",
"Secrets matrix", "Manual prerequisites"), .env.example.

This milestone is the DEV cutover (dev parity) plus the auth verification that
de-risks the prod cutover in D4. It is mostly console/config + verification + docs,
with minimal or no src changes.

Scope:
  1. Human-owner console steps, captured as a runbook edit: add BOTH
     https://api.foliolens.in/auth/v1/callback and
     https://api-dev.foliolens.in/auth/v1/callback to the Supabase Auth Redirect
     URLs allowlist (dev + prod projects respectively) and to the matching Google
     Cloud OAuth client's Authorized redirect URIs (finding 5).
  2. Dev cutover — flip every DEV-Supabase-backed build to the dev proxy:
     GitHub secret EXPO_PUBLIC_SUPABASE_URL_DEV → https://api-dev.foliolens.in;
     EAS `preview` and `development` environment vars → same, plus
     EXPO_PUBLIC_INBOUND_ENV=dev; Vercel DEV project (foliolens-dev)
     EXPO_PUBLIC_SUPABASE_URL → same. Do NOT touch any production/_PROD surface
     (that is D4).
  3. Verify magic-link sign-in and Google sign-in complete end-to-end on the DEV
     proxy: on dev web (foliolens-dev.vercel.app) AND a native preview build
     (foliolens-pr channel) — capture exact-SHA native evidence per
     docs/INFRASTRUCTURE.md "Daily flow". Also spot-check a REST read, a functions
     invoke, the CAS upload path, and a public snapshot GET all landing on
     api-dev.foliolens.in.
  4. Document the two accepted residuals (Google→GoTrue callback leg on
     supabase.co; JWT iss) in docs/INFRASTRUCTURE.md.
Non-goals: no prod cutover or any _PROD/production env change (D4); no change to
redirect *targets* (app.foliolens.in / foliolens-dev.vercel.app / foliolens*://
schemes are unchanged — they point at the app, not the API).

Validation: npm run typecheck; npm run lint; npm test -- --runInBand; git diff
--check. Evidence (exact SHA): magic-link and Google sign-in succeeding against the
dev proxy on dev web and on the foliolens-pr Android build (device, channel, update
ID, SHA); a Network capture showing the app's auth/token/authorize + REST/functions/
storage calls on api-dev.foliolens.in, with the residual callback leg noted.
```

### D4 — Production cutover

```
You are the Execution owner implementing milestone D4 of the "Backend Domain
Proxy" program. Read docs/process/AGENT-PROGRAM-PLAYBOOK.md (§5.3 + §5.4 in case a
correctness interrupt is needed), the control PR DESCRIPTION, and this report's
§"Recommended implementation order" and finding 8 via
  git show origin/<RESEARCH_BRANCH>:docs/research/prod-backend-proxy-foliolens-domain-2026-07-16.md

Depends on: D1, D2, D3 all merged and green. Read before starting:
docs/INFRASTRUCTURE.md ("Secrets matrix", "Vercel projects", "Expo / EAS",
"Branching, merging, releasing", "What does not trigger automatically"), eas.json,
app.config.js.

By this point dev is already on api-dev.foliolens.in (D3) and the prod
api.foliolens.in redirect URIs are already allowlisted in Supabase + Google (D3),
so D4 is the proven dev cutover repeated on the production surfaces.

Scope (human-gated production change — the executor prepares and documents; the
human owner presses the production buttons per the repo's explicit prod gate):
  1. Deploy the proxy Worker to api.foliolens.in → PROD Supabase
     (ohcaaioabjvzewfysqgh).
  2. Set the prod backend base + inbound env in every production surface:
     EAS production environment (EXPO_PUBLIC_SUPABASE_URL, EXPO_PUBLIC_INBOUND_ENV),
     GitHub _PROD secrets used by production-release.yml, and the prod Vercel
     project env vars.
  3. Ship via the tag-release path (production-release.yml) so the production EAS
     channel and app.foliolens.in Vercel deploy pick up the new base.
Non-goals: do not change the already-cut-over dev transport; do not re-route
server-to-server calls; do not change RLS/keys.

Validation: confirm the release workflow is green; confirm the prod web app and a
production-channel native build boot, authenticate, and load a portfolio.
Evidence: the production-release run link; a prod web Network capture (see D5 for
the full exit-criterion capture). If anything user-facing regresses (auth, imports,
snapshots), STOP and raise a §5.4 correctness interrupt rather than pushing forward.
```

### D5 — Field verification + docs + exit criterion

```
You are the Execution owner (or the named closeout owner) completing milestone D5
of the "Backend Domain Proxy" program. Read docs/process/AGENT-PROGRAM-PLAYBOOK.md
(§5.5 program exit), the control PR DESCRIPTION, and this report's §9 (program exit
criterion) via
  git show origin/<RESEARCH_BRANCH>:docs/research/prod-backend-proxy-foliolens-domain-2026-07-16.md

Depends on: D4 merged/shipped. Read before starting: docs/INFRASTRUCTURE.md,
docs/EXIT-RUNBOOK.md, .env.example, src/hooks/useIndexSnapshot.ts,
src/utils/casPdfUpload.ts.

Scope:
  1. Capture the program exit evidence (§9): on the PRODUCTION web app
     (app.foliolens.in) and a production-channel native build, record that every
     app-originated backend request — REST, auth, functions (incl. CAS upload), and
     the public index snapshot — targets a *.foliolens.in host, with the two
     documented residuals (OAuth provider callback leg; JWT iss) explicitly listed
     as expected exceptions.
  2. Update docs: INFRASTRUCTURE.md "Domain map" (add BOTH api.foliolens.in and
     api-dev.foliolens.in and the Cloudflare Worker substrate), the
     secrets/manual-prereqs sections, the server-to-server scope note (finding 7),
     and the "not a security boundary / user-trust" framing (finding 9);
     EXIT-RUNBOOK.md (the proxy seam); .env.example.
Non-goals: no new transport code; no re-routing of server-to-server calls. (Dev is
already cut over and verified in D3; the exit criterion here is the PRODUCTION
capture.)

Validation: npm run typecheck; npm run lint; npm test -- --runInBand; git diff
--check. Evidence: the production Network captures (web + native, exact build/SHA)
proving the exit criterion, attached to the milestone PR.
```

---

## What not to do

- **Do not purchase or assume the Supabase Custom Domain add-on.** The human owner
  declined it. The plan is a proxy on the free tier; the two residuals in finding 5
  are the accepted cost of that decision, not defects to "fix" by upgrading.
- **Do not proxy Realtime or add WebSocket support.** Realtime is unused and must
  stay that way (`docs/EXIT-RUNBOOK.md`). The proxy is HTTP request/response only.
- **Do not build an open relay.** The origin is a pinned constant; never derive the
  target host from request headers (finding 8).
- **Do not re-route server-to-server calls** (Resend router, cron/pg_net,
  universe-backfill) through the public proxy — no user benefit, wider blast radius
  (finding 7).
- **Do not present the proxy as a security control.** RLS + publishable key remain
  the boundary; the project stays reachable at `*.supabase.co` (finding 9).
- **Do not introduce a second hostname source.** Keep the base single-sourced
  (finding 1) so there is exactly one thing to flip at cutover.
- **Do not skip the DEV proving ground.** Prove every surface on `api-dev.foliolens.in`
  (D1/D3) before any production change (D4).
- **Do not flip prod without the release gate.** Production ships only via the tag
  workflow and human-pressed buttons (`docs/INFRASTRUCTURE.md`).

---

## Program exit criterion

Per-milestone acceptance is not program success. The program is complete only when,
on the **production** surfaces, field evidence closes the reported symptom:

- **Metric/observation:** a DevTools Network capture on `app.foliolens.in` (prod web)
  and an equivalent request log on a production-channel native build show that
  **every app-originated backend request** — PostgREST reads/writes, auth
  (otp/token/authorize), Edge Function invokes including the CAS PDF upload, and the
  public index snapshot GET — targets a `*.foliolens.in` host.
- **Accepted exceptions, listed explicitly:** the Google→GoTrue OAuth **provider
  callback leg** and the JWT `iss` claim remain on `*.supabase.co` (finding 5); these
  are documented residuals of the free-tier proxy approach, not failures.
- **Channel/period:** captured on the live production web + native builds after D4
  ships; re-checked once after the first production auth + CAS import by a real
  session to confirm no user-facing regression.

The control PR merges (report + final tracking table) only after this criterion is
evaluated and its outcome — met, or explicitly accepted as partially met with the
listed residuals — is recorded in this report.

---

## Rules

- The research PR contains **no application code changes** — only this report.
- This report lives at
  `docs/research/prod-backend-proxy-foliolens-domain-2026-07-16.md`.
- **Garbage-in fixtures rule (item 10):** no milestone in this program adds caching
  or derived storage over financial data — the proxy changes *transport*, not
  computation. The one caching change (D1, public index snapshots) caches an opaque
  object by path and does not derive or recompute financial values; its required
  test is cache-key correctness (symbol A never serves symbol B — finding 6), which
  is the appropriate analog to a garbage-in fixture for a transport cache. If any
  milestone later grows to derive/store financial values at the edge, it must add
  golden-equivalence **and** garbage-in fixtures before merge.

---

## Amendments (research/review phase)

Decisions taken by the human owner while reviewing this report, before program start:

- **2026-07-16 — Substrate: Cloudflare Worker (confirmed).** The reverse proxy runs
  as a Cloudflare Worker (Cloudflare already fronts the domain; free Workers tier;
  off Vercel's budget). D1 verifies the Cloudflare zone controls `api(-dev).foliolens.in`
  and escalates to the human owner if the registrar blocks it, rather than switching
  substrate.
- **2026-07-16 — Dev parity added.** Dev is no longer out of scope: both environments
  go behind the proxy — production → `api.foliolens.in`, all DEV-Supabase-backed builds
  → `api-dev.foliolens.in`. Rationale (human owner): the driver is user trust in a
  clean first-party request view, not security, and auth is a one-time flow so the
  `supabase.co` OAuth callback leg is an accepted residual. This makes D3 a full DEV
  cutover (not just a proving-ground verification), so D4's prod cutover repeats an
  already-proven path, and D2's explicit-env fix covers both environments.
