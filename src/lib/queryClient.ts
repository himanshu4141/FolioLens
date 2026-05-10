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
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { QueryClient, type QueryKey } from '@tanstack/react-query';
import { createAsyncStoragePersister } from '@tanstack/query-async-storage-persister';
import { STALE_TIMES } from '@/src/lib/queryStaleTimes';

// Bump this when a query's row shape changes or a migration backfills
// history rows. Persisted entries are discarded on next start.
export const __BUSTER__ = 'v1';

export const PERSIST_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: STALE_TIMES.DEFAULT,
      gcTime: PERSIST_MAX_AGE_MS,
      retry: 2,
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
  'portfolio',
  'portfolio-composition',
  'investmentVsBenchmarkTimeline',
  'portfolio-timeline',
  'performance-timeline',
  'fund-detail',
  'money-trail',
  'nav-history',
  'index-history',
  'user-funds',
  'user-transactions',
];

export function shouldPersistQueryKey(queryKey: QueryKey): boolean {
  if (!Array.isArray(queryKey) || queryKey.length === 0) return false;
  const head = queryKey[0];
  return typeof head === 'string' && PERSIST_ALLOWLIST.includes(head);
}
