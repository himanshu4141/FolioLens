/**
 * Builds the upstream Supabase request URL from a PINNED origin constant —
 * never from anything on the inbound request (see AGENTS-adjacent finding 8
 * in the backend-proxy research report: Supabase routes by hostname, and a
 * proxy that lets the request influence the target host is an open relay).
 *
 * This deliberately does NOT use `new URL(pathAndQuery, origin)` (relative
 * URL resolution). A pathname that starts with `//` — trivially reachable
 * by requesting `https://api-dev.foliolens.in//evil.com/rest/v1/x` — is
 * treated by the WHATWG URL algorithm as protocol-relative and silently
 * repoints the resulting URL's host to `evil.com`:
 *
 *   new URL('//evil.com/rest/v1/x', 'https://good.co').host === 'evil.com'
 *
 * Plain string concatenation of a fully-qualified origin has no such
 * relative-resolution step, so the parsed result's host is always the
 * pinned origin regardless of what the path contains.
 */
export function buildOriginUrl(origin: string, pathname: string, search: string): URL {
  const normalizedOrigin = origin.replace(/\/+$/, '');
  const normalizedPath = pathname.startsWith('/') ? pathname : `/${pathname}`;
  return new URL(`${normalizedOrigin}${normalizedPath}${search}`);
}
