import {
  checkWebPortfolioFreshness,
  type WebPortfolioFreshnessClient,
} from '@/src/lib/webPortfolioFreshness';
import {
  transactionFreshnessChanged,
  transactionFreshnessFromRows,
  type TransactionFreshnessMarker,
} from '@/src/lib/transactionFreshness';

interface CachedQuery {
  queryKey: readonly unknown[];
  state: {
    data: unknown;
  };
}

function createClient(entries: CachedQuery[]): WebPortfolioFreshnessClient {
  const keyId = (queryKey: readonly unknown[]) => JSON.stringify(queryKey);
  const dataByKey = new Map(entries.map((entry) => [keyId(entry.queryKey), entry.state.data]));
  return {
    getQueryData: <T,>(queryKey: readonly unknown[]) =>
      dataByKey.get(keyId(queryKey)) as T | undefined,
    getQueryCache: () => ({
      findAll: ({ queryKey }) => entries.filter((entry) =>
        queryKey.every((part, index) => entry.queryKey[index] === part),
      ),
    }),
  };
}

const OLD_MARKER: TransactionFreshnessMarker = {
  count: 1,
  latestCreatedAt: '2026-07-11T07:00:00.000Z',
};

const NEW_MARKER: TransactionFreshnessMarker = {
  count: 2,
  latestCreatedAt: '2026-07-11T08:00:00.000Z',
};

describe('transaction freshness markers', () => {
  it('uses transaction count plus max created_at as the freshness marker', () => {
    expect(transactionFreshnessFromRows([
      { created_at: '2026-07-11T07:00:00.000Z' },
      { created_at: null },
      { created_at: '2026-07-11T08:00:00.000Z' },
    ])).toEqual({
      count: 3,
      latestCreatedAt: '2026-07-11T08:00:00.000Z',
    });
  });

  it('treats a missing persisted Portfolio marker as stale when server transactions exist', () => {
    expect(transactionFreshnessChanged(null, NEW_MARKER)).toBe(true);
    expect(transactionFreshnessChanged(null, { count: 0, latestCreatedAt: null })).toBe(false);
  });
});

describe('checkWebPortfolioFreshness', () => {
  it('flags a fresh persisted pre-import Portfolio before the one-hour staleTime expires', async () => {
    const client = createClient([
      {
        queryKey: ['portfolio', 'user-1', '^NSEI'],
        state: {
          data: {
            fundCards: [],
            summary: { totalValue: 8_619_000 },
            transactionFreshness: OLD_MARKER,
          },
        },
      },
      {
        queryKey: ['user-transactions', 'user-1'],
        state: {
          data: [
            { created_at: OLD_MARKER.latestCreatedAt },
          ],
        },
      },
    ]);

    await expect(checkWebPortfolioFreshness(
      client,
      'user-1',
      async () => NEW_MARKER,
    )).resolves.toMatchObject({
      txInserted: 0,
      navInserted: 0,
      idxInserted: 0,
      txRebuiltFromDrift: true,
    });
  });

  it('flags stale Portfolio even when Money Trail already refreshed the shared transaction cache', async () => {
    const client = createClient([
      {
        queryKey: ['portfolio', 'user-1', '^NSEI'],
        state: {
          data: {
            fundCards: [],
            summary: { totalValue: 8_619_000 },
            transactionFreshness: OLD_MARKER,
          },
        },
      },
      {
        queryKey: ['user-transactions', 'user-1'],
        state: {
          data: [
            { created_at: OLD_MARKER.latestCreatedAt },
            { created_at: NEW_MARKER.latestCreatedAt },
          ],
        },
      },
    ]);

    await expect(checkWebPortfolioFreshness(
      client,
      'user-1',
      async () => NEW_MARKER,
    )).resolves.toMatchObject({
      txRebuiltFromDrift: true,
    });
  });

  it('does nothing when persisted transaction-dependent caches match the server marker', async () => {
    const client = createClient([
      {
        queryKey: ['portfolio', 'user-1', '^NSEI'],
        state: {
          data: {
            fundCards: [],
            summary: { totalValue: 8_759_000 },
            transactionFreshness: NEW_MARKER,
          },
        },
      },
      {
        queryKey: ['user-transactions', 'user-1'],
        state: {
          data: [
            { created_at: OLD_MARKER.latestCreatedAt },
            { created_at: NEW_MARKER.latestCreatedAt },
          ],
        },
      },
    ]);

    await expect(checkWebPortfolioFreshness(
      client,
      'user-1',
      async () => NEW_MARKER,
    )).resolves.toEqual({
      txInserted: 0,
      navInserted: 0,
      idxInserted: 0,
      errors: [],
    });
  });

  it('skips invalidation when the remote freshness marker cannot be read', async () => {
    const client = createClient([
      {
        queryKey: ['portfolio', 'user-1', '^NSEI'],
        state: {
          data: {
            fundCards: [],
            summary: { totalValue: 8_619_000 },
            transactionFreshness: OLD_MARKER,
          },
        },
      },
    ]);

    await expect(checkWebPortfolioFreshness(
      client,
      'user-1',
      async () => null,
    )).resolves.toEqual({
      txInserted: 0,
      navInserted: 0,
      idxInserted: 0,
      errors: [],
    });
  });
});
