/**
 * React Query client + persistence configuration.
 *
 * The Portfolio screen derives its bounded rendered output from much larger
 * NAV/index histories. Native SQLite and the index CDN own those raw inputs;
 * React Query persistence stores only bounded outputs and small lookups.
 *
 * Two levers fix the symptom users feel:
 *
 *   1. `gcTime: 24h` keeps cached data alive in memory across tab
 *      switches — moving away from Portfolio and back paints from cache
 *      instead of restarting the fetch.
 *
 *   2. `PersistQueryClientProvider` (mounted in `app/_layout.tsx`)
 *      serialises the bounded allowlist to AsyncStorage, which is
 *      `window.localStorage` on web. Reloaded rendered output is then instant
 *      without duplicating raw daily histories in a second database.
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
import { Platform } from 'react-native';
import { MutationCache, QueryCache, QueryClient, type QueryKey } from '@tanstack/react-query';
import { createAsyncStoragePersister } from '@tanstack/query-async-storage-persister';
import type { PersistedClient, Persister } from '@tanstack/react-query-persist-client';
import { STALE_TIMES } from '@/src/lib/queryStaleTimes';
import { authClient } from '@/src/lib/auth';
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
//
// v4 (2026-05-13): preview-mode fixtures got materially richer.
// `PREVIEW_RAW_TRANSACTIONS` now includes IDCW reinvestments +
// switch_in/out pair + an extra redemption + per-fund composition
// fixtures + Fund Detail builder. Cached preview entries from v3 still
// hold the thinner SIP+one-redemption shape, so existing devices that
// opened preview before this OTA would keep showing the old Money
// Trail. Bump forces a clean re-read on next launch.
//
// v5 (2026-05-28): `FundCardData` gained `currentNavDate` so the Fund
// list / Portfolio fund cards can render per-AMC NAV freshness ("as
// of …" reflects each AMC's own EOD cadence rather than the
// portfolio-wide latest). Cached v4 entries lack the field — call
// sites already fall back to the portfolio-wide `latestNavDate` via
// `??`, but bumping here gets every user the correct per-fund stamp
// on the very next launch instead of waiting for the persisted cache
// to expire (~24h).
//
// v6 (2026-05-29): the `scheme_master` SELECT (useSchemeMaster +
// schemeMasterRepo) gained the `sebi_category` column for the
// two-field category model. Persisted v5 entries lack the field, so
// the Compare screen's like-for-like sub-category check would read
// `undefined` and silently fall back to the name parser until the
// cache expired. Bump discards the old shape on next launch.
// v7: scheme_master payload shape change — morningstar_rating dropped from
// useSchemeMaster select (Phase 3 of deprecate-post-openfolio plan).
// v8: fund view now exposes scheme_active; useUserFunds/useFundDetail/usePortfolio
// payloads include schemeActive + navUnavailableCount fields.
// v9: discard historical NAV-derived results computed from unproven recent-only
// SQLite slices. The payload shape is stable, but retaining financially wrong
// `investmentVsBenchmarkTimeline` / `fund-nav-history` entries until their TTL
// would defeat the C1 correctness repair on first launch.
// v10: move the buster out of the AsyncStorage key. The old key included the
// version, so every bump orphaned the previous (potentially multi-megabyte)
// cache instead of replacing it. Also stop persisting raw daily histories that
// already live in native SQLite and can exceed Android AsyncStorage's 6 MB DB.
// v11: stop persisting `user-transactions` on native. SQLite owns the durable
// native transaction copy; React Query can rebuild the in-memory input from it,
// while web still persists the query because it has no SQLite read-through.
// v12: public Portfolio payloads include a transaction freshness marker used by
// web to detect server-side CAS imports before the old one-hour Portfolio
// staleTime can keep a pre-import value alive across reloads.
export const __BUSTER__ = 'v12';

export const PERSIST_MAX_AGE_MS = 48 * 60 * 60 * 1000;

let inFlightSignOut: Promise<void> | null = null;

function handleAuthError(error: unknown): void {
  if (!isAuthSessionInvalidError(error)) return;

  if (inFlightSignOut) return;
  inFlightSignOut = (async () => {
    try {
      analytics.track('auth_session_invalidated');
      await authClient.signOut();
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

/**
 * Public so the in-app cache-debug surface can read the raw blob
 * from AsyncStorage to surface its byte length + parsed contents.
 * Treat as read-only — the persister owns writes.
 */
export const PERSIST_KEY = 'foliolens.react-query-cache';
const LEGACY_PERSIST_KEY_PREFIX = `${PERSIST_KEY}.v`;

// Android's AsyncStorage SQLite database defaults to 6 MB and also contains
// auth, Zustand, and onboarding state. Keep the React Query blob comfortably
// below that shared ceiling. This is a serialized-character guard; JSON data
// here is overwhelmingly ASCII, and the 2 MB margin also covers UTF-8 growth.
export const PERSIST_SAFE_MAX_CHARS = 4 * 1024 * 1024;

let legacyCleanup: Promise<void> | null = null;

async function removeLegacyPersistedQueryCaches(): Promise<void> {
  if (legacyCleanup) return legacyCleanup;

  legacyCleanup = (async () => {
    try {
      const keys = await AsyncStorage.getAllKeys();
      const legacyKeys = keys.filter((key) => key.startsWith(LEGACY_PERSIST_KEY_PREFIX));
      if (legacyKeys.length === 0) return;

      await AsyncStorage.multiRemove(legacyKeys);
      analytics.track('persister_legacy_keys_removed', {
        key_count: legacyKeys.length,
      });
    } catch (err) {
      // Cleanup is best-effort. Persistence still proceeds through the stable
      // key and its bounded retry path below. Clear the single-flight promise
      // so a later restore/write can retry a transient cleanup failure.
      analytics.track('persister_legacy_cleanup_failed', {
        error_message: err instanceof Error ? err.message : String(err),
        error_name: err instanceof Error ? err.name : 'unknown',
      });
      legacyCleanup = null;
    }
  })();

  return legacyCleanup;
}

class PersistedClientTooLargeError extends Error {
  constructor(readonly serializedChars: number) {
    super(`Persisted React Query cache is ${serializedChars} chars`);
    this.name = 'PersistedClientTooLargeError';
  }
}

export interface PersistedQueryPrefixSummary {
  prefix: string;
  count: number;
  serializedChars: number;
}

export interface PersistedClientMetrics {
  serializedChars: number;
  queryCount: number;
  byKeyPrefix: PersistedQueryPrefixSummary[];
}

export function summarizePersistedClient(client: PersistedClient): PersistedClientMetrics {
  const serialized = JSON.stringify(client);
  const byPrefix = new Map<string, { count: number; serializedChars: number }>();

  for (const query of client.clientState.queries) {
    const head = Array.isArray(query.queryKey) ? query.queryKey[0] : null;
    const prefix = typeof head === 'string' ? head : '<non-string>';
    const current = byPrefix.get(prefix) ?? { count: 0, serializedChars: 0 };
    current.count += 1;
    current.serializedChars += JSON.stringify(query).length;
    byPrefix.set(prefix, current);
  }

  return {
    serializedChars: serialized.length,
    queryCount: client.clientState.queries.length,
    byKeyPrefix: [...byPrefix.entries()]
      .map(([prefix, stats]) => ({ prefix, ...stats }))
      .sort((a, b) => b.serializedChars - a.serializedChars || b.count - a.count),
  };
}

function prefixSummaryForAnalytics(metrics: PersistedClientMetrics): Record<string, number> {
  return Object.fromEntries(metrics.byKeyPrefix.map((entry) => [entry.prefix, entry.serializedChars]));
}

function serializePersistedClient(client: PersistedClient): string {
  const serialized = JSON.stringify(client);
  if (serialized.length > PERSIST_SAFE_MAX_CHARS) {
    throw new PersistedClientTooLargeError(serialized.length);
  }
  return serialized;
}

/**
 * Drop the largest dehydrated query after a failed write. Persistence is an
 * acceleration layer, never a source of truth, so retaining a smaller valid
 * cache is safer than silently keeping an old blob after SQLiteFullException.
 */
export function retryPersistedClient(
  client: PersistedClient,
  error: Error,
  errorCount: number,
): PersistedClient | undefined {
  const queries = client.clientState.queries;
  if (queries.length === 0) return undefined;

  let largestIndex = 0;
  let largestChars = -1;
  for (let index = 0; index < queries.length; index += 1) {
    const chars = JSON.stringify(queries[index]).length;
    if (chars > largestChars) {
      largestIndex = index;
      largestChars = chars;
    }
  }

  const removed = queries[largestIndex];
  const remainingQueries = queries.filter((_, index) => index !== largestIndex);
  const attemptedChars =
    error instanceof PersistedClientTooLargeError
      ? error.serializedChars
      : JSON.stringify(client).length;

  analytics.track('persister_write_retried', {
    buster: __BUSTER__,
    error_count: errorCount,
    error_message: error.message,
    error_name: error.name,
    attempted_chars: attemptedChars,
    removed_query_chars: largestChars,
    removed_query_family:
      Array.isArray(removed.queryKey) && typeof removed.queryKey[0] === 'string'
        ? removed.queryKey[0]
        : 'unknown',
    remaining_query_count: remainingQueries.length,
  });

  return {
    ...client,
    clientState: {
      ...client.clientState,
      queries: remainingQueries,
    },
  };
}

const basePersister = createAsyncStoragePersister({
  storage: AsyncStorage,
  key: PERSIST_KEY,
  throttleTime: 1000,
  serialize: serializePersistedClient,
  retry: ({ persistedClient, error, errorCount }) =>
    retryPersistedClient(persistedClient, error, errorCount),
});

/**
 * Best-effort blob-size reader for restore failures. Write errors are handled
 * inside the TanStack persister through `retryPersistedClient`, because its
 * public `persistClient` promise intentionally swallows storage exceptions.
 */
async function readBlobSize(): Promise<number | null> {
  try {
    const raw = await AsyncStorage.getItem(PERSIST_KEY);
    return raw == null ? null : raw.length;
  } catch {
    return null;
  }
}

/**
 * The wrapper removes version-suffixed legacy keys before the first restore or
 * write and retains detailed restore-failure telemetry. Write-failure
 * telemetry and bounded degradation live in the base persister retry callback.
 */
export const persister = {
  persistClient: async (client: PersistedClient) => {
    await removeLegacyPersistedQueryCaches();
    await basePersister.persistClient(client);
  },
  restoreClient: async () => {
    const startedAt = Date.now();
    try {
      await removeLegacyPersistedQueryCaches();
      const restored = await basePersister.restoreClient();
      const restoreDurationMs = Date.now() - startedAt;
      if (restored) {
        const metrics = summarizePersistedClient(restored);
        analytics.track('persister_restore_completed', {
          buster: restored.buster ?? __BUSTER__,
          restore_duration_ms: restoreDurationMs,
          blob_size_bytes: metrics.serializedChars,
          query_count: metrics.queryCount,
          query_prefix_bytes: prefixSummaryForAnalytics(metrics),
        });
      } else {
        analytics.track('persister_restore_completed', {
          buster: __BUSTER__,
          restore_duration_ms: restoreDurationMs,
          blob_size_bytes: 0,
          query_count: 0,
          query_prefix_bytes: {},
        });
      }
      return restored;
    } catch (err) {
      const restoreDurationMs = Date.now() - startedAt;
      const size = await readBlobSize();
      analytics.track('persister_restore_failed', {
        buster: __BUSTER__,
        error_message: err instanceof Error ? err.message : String(err),
        error_name: err instanceof Error ? err.name : 'unknown',
        blob_size_bytes: size,
        restore_duration_ms: restoreDurationMs,
      });
      throw err;
    }
  },
  removeClient: () => basePersister.removeClient(),
} satisfies Persister;

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
  'money-trail',
  // Auxiliary user-scoped lookups.
  'user-funds',
  // Per-scheme metadata — shared between Fund Detail and Compare via
  // a single producer / single cache key (`['scheme-master', code]`).
  'scheme-master',
];
const WEB_ONLY_PERSIST_ALLOWLIST: readonly string[] = [
  // Native has the durable SQLite tx table; web does not. Keep this persisted
  // only on web so Money Trail / Wealth Journey still hydrate without a full
  // network pull after reload, while Android avoids duplicating the largest
  // raw user-scoped array inside AsyncStorage.
  'user-transactions',
];

export function shouldPersistQueryKey(queryKey: QueryKey): boolean {
  if (!Array.isArray(queryKey) || queryKey.length === 0) return false;
  const head = queryKey[0];
  if (typeof head !== 'string') return false;
  if (PERSIST_ALLOWLIST.includes(head)) return true;
  return Platform.OS === 'web' && WEB_ONLY_PERSIST_ALLOWLIST.includes(head);
}
