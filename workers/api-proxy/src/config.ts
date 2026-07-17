/**
 * Static routing/config constants for the reverse proxy. No secrets live
 * here — the per-environment Supabase origin is injected via the Worker's
 * `Env` bindings (see `wrangler.toml`), never read from the request.
 */

// Exactly the four client-facing Supabase surfaces the app uses. Anything
// outside this list 404s — the proxy is not an open relay to arbitrary
// Supabase paths, and there is deliberately no Realtime entry (unused,
// no WebSocket support).
export const ALLOWED_PREFIXES = ['/auth/v1', '/rest/v1', '/storage/v1', '/functions/v1'] as const;

export type AllowedPrefix = (typeof ALLOWED_PREFIXES)[number];

// Public (unauthenticated) index-history snapshots, edge-cached by object
// path. Every other path — including everything else under /storage/v1 —
// is forwarded straight through with no caching.
export const PUBLIC_STORAGE_PREFIX = '/storage/v1/object/public/';

// Matches the stale-while-revalidate window `useIndexSnapshot.ts` already
// designs around, so the proxy doesn't regress the CDN behaviour it fronts.
export const STORAGE_EDGE_CACHE_TTL_SECONDS = 300;
export const STORAGE_STALE_WHILE_REVALIDATE_SECONDS = 86400;

// Headers that identify the hop (this Worker, Cloudflare's edge) rather
// than the logical request. Stripped before forwarding upstream so the
// origin sees a clean request; everything else — including Authorization,
// apikey, Content-Type, Prefer, Range — passes through verbatim.
export const HOP_BY_HOP_REQUEST_HEADERS = new Set([
  'host',
  'connection',
  'content-length',
  'cf-connecting-ip',
  'cf-ipcountry',
  'cf-ray',
  'cf-visitor',
  'cf-worker',
  'cdn-loop',
  'x-forwarded-for',
  'x-forwarded-proto',
  'x-forwarded-host',
]);

export const CORS_DEFAULT_ALLOWED_HEADERS =
  'authorization, apikey, content-type, x-client-info, prefer, range, x-upsert';
export const CORS_ALLOWED_METHODS = 'GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS';
export const CORS_MAX_AGE_SECONDS = 86400;

// Response headers the Supabase origin (GoTrue/PostgREST/Storage/Edge
// Functions) sets on every response, that name the vendor and/or the exact
// project ref in plaintext (D5 field verification finding: visible in
// DevTools' default Headers view, no JWT decoding needed — unlike the three
// documented residuals, which only surface during a one-time auth flow).
// Stripped before the response reaches the client so the proxy actually
// delivers on the program's presentation/trust goal.
export const UPSTREAM_IDENTIFYING_RESPONSE_HEADERS = [
  'sb-project-ref',
  'sb-gateway-mode',
  'sb-gateway-version',
  'sb-request-id',
  'x-sb-edge-region',
  'x-served-by',
  'x-deno-execution-id',
];

// Auth is bearer-token PKCE, not cookie-based (see ExecPlan Assumptions), so
// the app never reads a cookie the proxy origin sets. The only Set-Cookie
// seen in practice is Cloudflare's own bot-management cookie for the
// origin's zone (`Domain=supabase.co`) — dropped entirely rather than
// rewritten, since there is no first-party replacement the client needs.
export const STRIP_SET_COOKIE = true;
