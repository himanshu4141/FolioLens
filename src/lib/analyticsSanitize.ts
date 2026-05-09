/**
 * PostHog URL sanitizer — runs on every event the web SDK is about to send
 * via the `sanitize_properties` hook. Strips two classes of bleed:
 *
 *   1. The URL hash fragment in `$current_url` / `$referrer`. Supabase magic
 *      links land at `<scheme>://auth/confirm#access_token=...&refresh_token=...`
 *      and the React tree renders that screen long enough for PostHog's
 *      auto-attached `$current_url` to capture the full URL — JWT and all.
 *      Anyone who could read the PostHog event log could replay that token
 *      as the user. We strip the hash entirely; hash fragments are never
 *      useful for analytics anyway.
 *
 *   2. A short list of query parameters that carry secrets across redirects
 *      (Google OAuth `code`, generic `access_token` / `refresh_token` /
 *      `id_token`, `password`, etc.). We replace the value with `<redacted>`
 *      rather than dropping the key, so dashboards still see the *shape*
 *      of the URL ("user reached this OAuth callback") without the secret.
 *
 * Anything we don't recognise (UTMs, ordinary path / query) passes through.
 */

const SENSITIVE_QUERY_PARAMS = new Set([
  'access_token',
  'refresh_token',
  'id_token',
  'token_type',
  'expires_in',
  'token',
  'code',       // OAuth authorization code (single-use, but still sensitive in transit)
  'state',      // OAuth state — leaking it weakens CSRF protection
  'password',
  'secret',
]);

const URL_PROPERTY_KEYS = new Set(['$current_url', '$referrer', '$initial_referrer']);

export function sanitizeUrl(raw: string): string {
  // Try parsing as an absolute URL first; if that fails (relative path or
  // non-URL string), fall back to a manual hash + query split.
  try {
    const url = new URL(raw);
    url.hash = '';
    SENSITIVE_QUERY_PARAMS.forEach((key) => {
      if (url.searchParams.has(key)) {
        url.searchParams.set(key, '<redacted>');
      }
    });
    return url.toString();
  } catch {
    const hashIdx = raw.indexOf('#');
    const withoutHash = hashIdx === -1 ? raw : raw.slice(0, hashIdx);
    const qIdx = withoutHash.indexOf('?');
    if (qIdx === -1) return withoutHash;
    const path = withoutHash.slice(0, qIdx);
    const queryString = withoutHash.slice(qIdx + 1);
    const sanitizedQuery = queryString
      .split('&')
      .map((pair) => {
        const eq = pair.indexOf('=');
        const k = eq === -1 ? pair : pair.slice(0, eq);
        if (SENSITIVE_QUERY_PARAMS.has(decodeURIComponent(k))) {
          return `${k}=%3Credacted%3E`;
        }
        return pair;
      })
      .join('&');
    return sanitizedQuery ? `${path}?${sanitizedQuery}` : path;
  }
}

export function sanitizeProperties(
  properties: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!properties) return properties;
  let mutated = false;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(properties)) {
    if (URL_PROPERTY_KEYS.has(key) && typeof value === 'string') {
      const sanitized = sanitizeUrl(value);
      if (sanitized !== value) mutated = true;
      out[key] = sanitized;
    } else {
      out[key] = value;
    }
  }
  return mutated ? out : properties;
}
