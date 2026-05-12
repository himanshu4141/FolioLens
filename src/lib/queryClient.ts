/**
 * React Query client + persistence configuration.
 *
 * The Portfolio screen pulls ~28k rows on a cold mount (NAV history +
 * index history dominate). Without persistence, every page reload and
 * every navigation past `gcTime` (default 5 min) re-fetches the lot.
 *
 * Two levers fix the symptom users feel:
 *
 *   1. `gcTime: 24h` keeps cached data alive in memory across tab
 *      switches — moving away from Portfolio and back paints from cache
 *      instead of restarting the fetch.
 *
 *   2. `PersistQueryClientProvider` (mounted in `app/_layout.tsx`)
 *      serialises the cache to AsyncStorage, which is `window.localStorage`
 *      on web. Reload-from-disk is then ~instant.
 *
 * The `__BUSTER__` constant is the manual escape hatch: bump it whenever
 * a query's row shape changes or a migration backfills history rows, so
 * persisted entries are discarded on next start.
 *
 * Auth-error handler: a global QueryCache + MutationCache `onError` runs
 * `isAuthSessionInvalidError` on every rejection. When a query / mutation
 * fails because the session is dead (revoked Google token, expired JWT,
 * 401 from PostgREST, etc.) we sign the user out and AuthGate's
 * null-session redirect drops them to /auth — instead of leaving them
 * looking at error toasts on every screen. Single-flight via
 * `inFlightSignOut` so 50 in-flight 401s only sign out once.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { MutationCache, QueryCache, QueryClient, type QueryKey } from '@tanstack/react-query';
import { createAsyncStoragePersister } from '@tanstack/query-async-storage-persister';
import { STALE_TIMES } from '@/src/lib/queryStaleTimes';
import { supabase } from '@/src/lib/supabase';
import { analytics } from '@/src/lib/analytics';
import { isAuthSessionInvalidError } from '@/src/lib/authError';

// Bump this when a query's row shape changes or a migration backfills
// history rows. Persisted entries are discarded on next start.
//
// v2 (2026-05-11): clears the malformed `['index-history', symbol]` payload
// that `app/fund/[id].tsx` wrote in v1 under the same key the shared cache
// layer uses but with `{ date, value }` rows instead of `{ index_date,
// close_value }`. The mismatch made the Nifty 500 TRI chart vanish on
// Portfolio. Bumping the buster guarantees existing devices start clean.
//
// v3 (2026-05-12): `useUserTransactions` now selects five extra columns
// (`id`, `nav_at_transaction`, `folio_number`, `cas_import_id`,
// `created_at`) so Money Trail + Wealth Journey can read the user's
// transactions from the same shared cache as Portfolio + Fund Detail.
// The existing v2 cache rows lack those columns; on an OTA, screens
// that depend on them would see `undefined` until staleTime expiry.
// Bumping the buster forces a fresh fetch on first launch post-OTA.
export const __BUSTER__ = 'v3';

export const PERSIST_MAX_AGE_MS = 24 * 60 * 60 * 1000;

let inFlightSignOut: Promise<void> | null = null;

function handleAuthError(error: unknown): void {
  if (!isAuthSessionInvalidError(error)) return;

  if (inFlightSignOut) return;
  inFlightSignOut = (async () => {
    try {
      analytics.track('auth_session_invalidated');
      await supabase.auth.signOut();
    } catch {
      // signOut errors are non-fatal — AuthGate watches session state.
    } finally {
      // Reset after a small delay so a fresh re-login can also trigger a
      // future invalidation (otherwise this session-bound flag would block
      // the next handler for the lifetime of the JS context).
      setTimeout(() => {
        inFlightSignOut = null;
      }, 5000);
    }
  })();
}

export const queryClient = new QueryClient({
  queryCache: new QueryCache({
    onError: (error) => handleAuthError(error),
  }),
  mutationCache: new MutationCache({
    onError: (error) => handleAuthError(error),
  }),
  defaultOptions: {
    queries: {
      staleTime: STALE_TIMES.DEFAULT,
      gcTime: PERSIST_MAX_AGE_MS,
      // Don't burn retries on auth-dead errors — fail-fast so the global
      // handler can sign the user out promptly.
      retry: (failureCount, error) => {
        if (isAuthSessionInvalidError(error)) return false;
        return failureCount < 2;
      },
    },
  },
});

export const persister = createAsyncStoragePersister({
  storage: AsyncStorage,
  key: `foliolens.react-query-cache.${__BUSTER__}`,
  throttleTime: 1000,
});

// Keys allowed to land in persistent storage. Everything else stays in
// memory only. Auth + user_profile are intentionally excluded so a
// signed-out user never reads cached PII from disk; the wizard's hook
// (`useUserProfile`) handles its own refetch-on-mount.
const PERSIST_ALLOWLIST: readonly string[] = [
  // Computed query results — these are what the user actually sees after
  // hydration, so persisting them is the lever that makes "page reload"
  // paint instantly.
  'portfolio',
  'portfolio-composition',
  'investmentVsBenchmarkTimeline',
  'portfolio-timeline',
  'performance-timeline',
  'fund-detail',
  'fund-detail-index',
  'fund-nav-history',
  'money-trail',
  // Auxiliary user-scoped lookups.
  'user-funds',
  'user-transactions',
  // Per-scheme metadata — shared between Fund Detail and Compare via
  // a single producer / single cache key (`['scheme-master', code]`).
  'scheme-master',
  // CDN-served daily snapshot of `index_history` for tracked benchmarks
  // (Phase 9 M5). The HTTP cache fronts most reads; persisting here is
  // the in-app belt-and-braces so a navigation past the React Query
  // gcTime doesn't trigger an unnecessary CDN GET.
  'index-snapshot',
];

export function shouldPersistQueryKey(queryKey: QueryKey): boolean {
  if (!Array.isArray(queryKey) || queryKey.length === 0) return false;
  const head = queryKey[0];
  return typeof head === 'string' && PERSIST_ALLOWLIST.includes(head);
}
