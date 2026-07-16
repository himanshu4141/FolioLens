import {
  CORS_ALLOWED_METHODS,
  CORS_DEFAULT_ALLOWED_HEADERS,
  CORS_MAX_AGE_SECONDS,
  HOP_BY_HOP_REQUEST_HEADERS,
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
 * Ensures the actual (non-preflight) response carries a permissive
 * Access-Control-Allow-Origin regardless of what the origin returned, so
 * the web app can read the response cross-origin from `app.foliolens.in`.
 */
export function applyCorsHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set('Access-Control-Allow-Origin', '*');
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
