import {
  CORS_ALLOWED_METHODS,
  CORS_DEFAULT_ALLOWED_HEADERS,
  CORS_MAX_AGE_SECONDS,
  HOP_BY_HOP_REQUEST_HEADERS,
  STRIP_SET_COOKIE,
  UPSTREAM_IDENTIFYING_RESPONSE_HEADERS,
} from './config';

/**
 * Forwards the inbound request headers verbatim to the origin, minus the
 * hop-identifying ones (Host, Cloudflare-injected, forwarding chain).
 * Authorization, apikey, Content-Type, Prefer, Range, cookies (there are
 * none — auth is bearer-token PKCE, not cookie-based) all pass through
 * unchanged: this proxy never synthesises or strips them.
 */
export function buildForwardedRequestHeaders(requestHeaders: Headers): Headers {
  const forwarded = new Headers();
  requestHeaders.forEach((value, key) => {
    if (!HOP_BY_HOP_REQUEST_HEADERS.has(key.toLowerCase())) {
      forwarded.set(key, value);
    }
  });
  return forwarded;
}

/**
 * Forwarded headers for the cacheable public-storage-GET path only. This
 * path is cached at the edge keyed by object path alone (finding 6) — the
 * cached response is later served to ANY caller, regardless of what
 * headers that caller sent. Forwarding a caller's Authorization/apikey/
 * Cookie (or a conditional-request header like If-None-Match, whose
 * response — e.g. a bodyless 304 — also depends on what that specific
 * caller already had cached) would let one request's header-dependent
 * response get cached and replayed to a completely different caller. This
 * object is public and needs no credentials, so nothing caller-supplied
 * is forwarded at all — matching the plain `Accept` header the client's
 * own direct fetch already sends (`useIndexSnapshot.ts`).
 */
export function buildPublicStorageForwardedHeaders(): Headers {
  return new Headers({ Accept: 'application/json' });
}

/**
 * CORS response headers for a preflight OPTIONS request. Echoes the
 * browser's requested headers when present (so any current or future
 * Supabase client header works without a proxy allowlist edit); falls
 * back to a fixed permissive default otherwise.
 */
export function buildPreflightHeaders(requestHeaders: Headers): Headers {
  const requested = requestHeaders.get('access-control-request-headers');
  const headers = new Headers({
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': CORS_ALLOWED_METHODS,
    'Access-Control-Allow-Headers': requested ?? CORS_DEFAULT_ALLOWED_HEADERS,
    'Access-Control-Max-Age': String(CORS_MAX_AGE_SECONDS),
  });
  return headers;
}

/**
 * Removes response headers that name the Supabase origin directly — the
 * exact project ref (`sb-project-ref`), gateway/runtime identifiers, and any
 * `Set-Cookie` (Cloudflare's own bot-management cookie for the origin's
 * zone, scoped to `Domain=supabase.co`; the app never reads a cookie from
 * the proxy host since auth is bearer-token PKCE). Every mapped surface
 * (auth/rest/storage/functions) sets these on every response, so without
 * this step a visitor never even needs to decode a JWT to see the raw
 * vendor + project ref — it's in DevTools' default Headers view.
 */
export function stripUpstreamIdentifyingHeaders(headers: Headers): Headers {
  const stripped = new Headers(headers);
  for (const name of UPSTREAM_IDENTIFYING_RESPONSE_HEADERS) {
    stripped.delete(name);
  }
  if (STRIP_SET_COOKIE) {
    stripped.delete('set-cookie');
  }
  return stripped;
}

/**
 * Ensures the actual (non-preflight) response carries a permissive
 * Access-Control-Allow-Origin regardless of what the origin returned, so
 * the web app can read the response cross-origin from `app.foliolens.in`.
 */
export function applyCorsHeaders(response: Response): Response {
  const headers = stripUpstreamIdentifyingHeaders(response.headers);
  headers.set('Access-Control-Allow-Origin', '*');
  // Marker proving this exact response was produced by this Worker (as
  // opposed to Cloudflare's zone-level HTTP cache serving a copy without
  // invoking the script at all) — useful for diagnosing cache behaviour
  // live, and harmless to leave in permanently.
  headers.set('X-FolioLens-Api-Proxy', '1');
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
