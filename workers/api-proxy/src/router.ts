import { ALLOWED_PREFIXES, PUBLIC_STORAGE_PREFIX, type AllowedPrefix } from './config';

export interface MatchedRoute {
  prefix: AllowedPrefix;
}

/**
 * Decides whether an inbound pathname is one of the four mapped Supabase
 * surfaces. A prefix matches only at a path boundary (`/rest/v1` or
 * `/rest/v1/...`), not as a bare string prefix (`/rest/v1extra` does not
 * match) — so this cannot be tricked into matching a look-alike path.
 */
export function matchRoute(pathname: string): MatchedRoute | null {
  for (const prefix of ALLOWED_PREFIXES) {
    if (pathname === prefix || pathname.startsWith(`${prefix}/`)) {
      return { prefix };
    }
  }
  return null;
}

/** True for a GET on the public, unauthenticated storage object path. */
export function isPublicStorageGet(method: string, pathname: string): boolean {
  return method.toUpperCase() === 'GET' && pathname.startsWith(PUBLIC_STORAGE_PREFIX);
}
