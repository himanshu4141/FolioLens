import { STORAGE_EDGE_CACHE_TTL_SECONDS, STORAGE_STALE_WHILE_REVALIDATE_SECONDS } from './config';

// A stable, fake origin used only to build cache-key strings for
// Cloudflare's Cache API (`caches.default.match`/`.put` accept a URL
// string as the key). It is never dereferenced over the network.
const CACHE_KEY_ORIGIN = 'https://api-proxy-cache.internal';

/**
 * Cache key for a public storage object, keyed by the full object path
 * only — never by query string or headers. This is what guarantees
 * finding 6's cache-key correctness property: a request for symbol A's
 * snapshot can never be satisfied by symbol B's cached body, because
 * their paths differ; and re-fetching the same path with a different
 * (e.g. cache-busting) query string still hits the same entry rather than
 * multiplying cache entries for one logical object.
 */
export function cacheKeyFor(pathname: string): string {
  const normalizedPath = pathname.startsWith('/') ? pathname : `/${pathname}`;
  return `${CACHE_KEY_ORIGIN}${normalizedPath}`;
}

/** `Cache-Control` value set on cached public storage responses. */
export function storageCacheControlHeader(): string {
  return `public, max-age=${STORAGE_EDGE_CACHE_TTL_SECONDS}, stale-while-revalidate=${STORAGE_STALE_WHILE_REVALIDATE_SECONDS}`;
}

/**
 * Only cache a plain, full-object 200 — never an origin 404/error, and
 * never a 206 Partial Content. `response.ok` is true for both 200 and
 * 206, but a 206 body is a byte-range slice; caching it under the
 * full-object cache key (path-only, finding 6) would let a subsequent
 * full-object request be served a truncated body (review round 1).
 */
export function isCacheableResponse(response: Response): boolean {
  return response.status === 200;
}
