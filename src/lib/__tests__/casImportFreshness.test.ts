import type { QueryClient } from '@tanstack/react-query';
import { refreshAfterDirectCasImport } from '../casImportFreshness';

jest.mock('react-native', () => ({ Platform: { OS: 'ios' } }), { virtual: true });
jest.mock('@/src/lib/db/sync', () => ({
  syncDeltaForUser: jest.fn(),
}));

const queryClient = {} as QueryClient;
const changedOutcome = {
  transactionsAdded: 1,
  transactionsAlreadyPresent: 2,
  transactionsRejected: 0,
  transactionsRemoved: 0,
};

describe('refreshAfterDirectCasImport', () => {
  it.each([
    {
      transactionsAdded: 0,
      transactionsAlreadyPresent: 4,
      transactionsRejected: 0,
      transactionsRemoved: 0,
    },
    {
      transactionsAdded: 0,
      transactionsAlreadyPresent: 1,
      transactionsRejected: 2,
      transactionsRemoved: 0,
    },
  ])('does no cache or SQLite work for a no-op/conflict outcome', async (outcome) => {
    const syncNative = jest.fn();
    const invalidate = jest.fn();

    await expect(refreshAfterDirectCasImport(
      queryClient,
      'user-id',
      outcome,
      'unknown',
      { platform: 'ios', syncNative, invalidate },
    )).resolves.toEqual({ serverChanged: false, localChanged: false, errors: [] });

    expect(syncNative).not.toHaveBeenCalled();
    expect(invalidate).not.toHaveBeenCalled();
  });

  it.each([
    changedOutcome,
    { ...changedOutcome, transactionsAdded: 0, transactionsRemoved: 1 },
  ])('marks the web transaction fan-out stale for an add or removal', async (outcome) => {
    const invalidate = jest.fn(async () => undefined);

    const result = await refreshAfterDirectCasImport(
      queryClient,
      'user-id',
      outcome,
      'unknown',
      { platform: 'web', invalidate },
    );

    expect(result).toEqual({ serverChanged: true, localChanged: true, errors: [] });
    expect(invalidate).toHaveBeenCalledWith(
      queryClient,
      { txInserted: 1, navInserted: 0, idxInserted: 0, errors: [] },
      'unknown',
    );
  });

  it('synchronizes native SQLite before invalidating derived queries', async () => {
    const syncResult = {
      txInserted: 0,
      navInserted: 0,
      idxInserted: 0,
      txRebuiltFromDrift: true,
      errors: [],
    };
    const order: string[] = [];
    const syncNative = jest.fn(async () => {
      order.push('sync');
      return syncResult;
    });
    const invalidate = jest.fn(async () => {
      order.push('invalidate');
    });

    const result = await refreshAfterDirectCasImport(
      queryClient,
      'user-id',
      changedOutcome,
      'unknown',
      { platform: 'android', syncNative, invalidate },
    );

    expect(order).toEqual(['sync', 'invalidate']);
    expect(syncNative).toHaveBeenCalledWith('user-id');
    expect(invalidate).toHaveBeenCalledWith(queryClient, syncResult, 'unknown');
    expect(result).toEqual({ serverChanged: true, localChanged: true, errors: [] });
  });

  it('reports a native refresh problem without pretending local data changed', async () => {
    const syncResult = {
      txInserted: 0,
      navInserted: 0,
      idxInserted: 0,
      errors: ['transaction sync failed'],
    };
    const invalidate = jest.fn(async () => undefined);

    await expect(refreshAfterDirectCasImport(
      queryClient,
      'user-id',
      changedOutcome,
      'unknown',
      {
        platform: 'ios',
        syncNative: jest.fn(async () => syncResult),
        invalidate,
      },
    )).resolves.toEqual({
      serverChanged: true,
      localChanged: false,
      errors: ['transaction sync failed'],
    });
    expect(invalidate).toHaveBeenCalledWith(queryClient, syncResult, 'unknown');
  });

  it('does not reinterpret a committed import as failed when refresh throws', async () => {
    await expect(refreshAfterDirectCasImport(
      queryClient,
      'user-id',
      changedOutcome,
      'unknown',
      {
        platform: 'ios',
        syncNative: jest.fn(async () => {
          throw new Error('private upstream detail');
        }),
        invalidate: jest.fn(),
      },
    )).resolves.toEqual({
      serverChanged: true,
      localChanged: false,
      errors: ['cas_post_import_refresh_failed'],
    });
  });
});
