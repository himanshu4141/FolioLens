import { Platform } from 'react-native';
import type { QueryClient } from '@tanstack/react-query';
import { syncDeltaForUser, type SyncResult } from '@/src/lib/db/sync';
import {
  invalidateQueriesForSync,
  type SyncInvalidationClient,
  type SyncVisibleRoute,
} from '@/src/lib/syncInvalidation';

export interface CasTransactionOutcome {
  transactionsAdded: number;
  transactionsAlreadyPresent: number;
  transactionsRejected: number;
  transactionsRemoved: number;
}

export interface CasImportFreshnessResult {
  serverChanged: boolean;
  localChanged: boolean;
  errors: string[];
}

interface CasImportFreshnessDependencies {
  platform?: string;
  syncNative?: (userId: string) => Promise<SyncResult>;
  invalidate?: (
    client: SyncInvalidationClient,
    result: SyncResult,
    visibleRoute: SyncVisibleRoute,
  ) => Promise<void>;
}

const EMPTY_REFRESH: CasImportFreshnessResult = {
  serverChanged: false,
  localChanged: false,
  errors: [],
};

/**
 * Refresh transaction-derived caches after a direct CAS upload.
 *
 * Web queries read the server directly, so marking the transaction fan-out
 * stale is sufficient. Native queries read SQLite first, so the immutable-ID
 * delta/repair must complete before those same query families are invalidated.
 * A no-op or conflict never changed server transactions and does no work.
 */
export async function refreshAfterDirectCasImport(
  queryClient: QueryClient,
  userId: string,
  outcome: CasTransactionOutcome,
  visibleRoute: SyncVisibleRoute = 'unknown',
  dependencies: CasImportFreshnessDependencies = {},
): Promise<CasImportFreshnessResult> {
  const serverChanged = outcome.transactionsAdded > 0 || outcome.transactionsRemoved > 0;
  if (!serverChanged) return EMPTY_REFRESH;

  const invalidate = dependencies.invalidate ?? invalidateQueriesForSync;
  try {
    if ((dependencies.platform ?? Platform.OS) === 'web') {
      await invalidate(
        queryClient,
        { txInserted: 1, navInserted: 0, idxInserted: 0, errors: [] },
        visibleRoute,
      );
      return { serverChanged: true, localChanged: true, errors: [] };
    }

    const syncResult = await (dependencies.syncNative ?? syncDeltaForUser)(userId);
    await invalidate(queryClient, syncResult, visibleRoute);
    return {
      serverChanged: true,
      localChanged: syncResult.txInserted > 0 || syncResult.txRebuiltFromDrift === true,
      errors: syncResult.errors,
    };
  } catch {
    // The import is already committed. A refresh failure must never turn that
    // successful mutation into a misleading upload failure; lifecycle sync and
    // web freshness probes remain the safe retry path.
    return {
      serverChanged: true,
      localChanged: false,
      errors: ['cas_post_import_refresh_failed'],
    };
  }
}
