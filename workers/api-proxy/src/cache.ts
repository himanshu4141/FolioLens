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

/** Only cache successful responses — an origin 404/error is never stored. */
export function isCacheableResponse(response: Response): boolean {
  return response.ok;
}
