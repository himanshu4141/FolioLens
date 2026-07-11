import { fetchUserTransactionFreshnessRemote } from '@/src/hooks/useUserTransactions';
import {
  transactionFreshnessChanged,
  transactionFreshnessFromRows,
  type TransactionFreshnessMarker,
  type TransactionFreshnessRow,
} from '@/src/lib/transactionFreshness';
import type { SyncResult } from '@/src/lib/db/sync';

interface CachedPortfolioWithFreshness {
  transactionFreshness?: TransactionFreshnessMarker;
}

interface QueryState {
  state: {
    data: unknown;
  };
}

export interface WebPortfolioFreshnessClient {
  getQueryData<T = unknown>(queryKey: readonly unknown[]): T | undefined;
  getQueryCache(): {
    findAll(filters: { queryKey: readonly unknown[] }): QueryState[];
  };
}

export type FetchTransactionFreshnessMarker = (
  userId: string,
) => Promise<TransactionFreshnessMarker | null>;

const NO_WEB_TRANSACTION_CHANGE: SyncResult = {
  txInserted: 0,
  navInserted: 0,
  idxInserted: 0,
  errors: [],
};

function changedWebTransactionResult(): SyncResult {
  return {
    ...NO_WEB_TRANSACTION_CHANGE,
    txRebuiltFromDrift: true,
  };
}

function cachedPortfolioMarkers(
  client: WebPortfolioFreshnessClient,
  userId: string,
): (TransactionFreshnessMarker | null)[] {
  return client
    .getQueryCache()
    .findAll({ queryKey: ['portfolio', userId] })
    .map((query) => {
      const data = query.state.data as CachedPortfolioWithFreshness | undefined;
      return data?.transactionFreshness ?? null;
    });
}

export async function checkWebPortfolioFreshness(
  client: WebPortfolioFreshnessClient,
  userId: string,
  fetchRemote: FetchTransactionFreshnessMarker = fetchUserTransactionFreshnessRemote,
): Promise<SyncResult> {
  const remote = await fetchRemote(userId);
  if (remote === null) return NO_WEB_TRANSACTION_CHANGE;

  const cachedTransactions = client.getQueryData<readonly TransactionFreshnessRow[]>([
    'user-transactions',
    userId,
  ]);
  const localTransactionMarker = transactionFreshnessFromRows(cachedTransactions);
  const transactionCacheChanged =
    cachedTransactions !== undefined && transactionFreshnessChanged(localTransactionMarker, remote);
  const portfolioCacheChanged = cachedPortfolioMarkers(client, userId)
    .some((marker) => transactionFreshnessChanged(marker, remote));

  if (!transactionCacheChanged && !portfolioCacheChanged) {
    return NO_WEB_TRANSACTION_CHANGE;
  }

  return changedWebTransactionResult();
}
