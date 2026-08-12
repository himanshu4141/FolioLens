/** Exact immutable-ID reconciliation covers both inserts and deletes. */
jest.mock('@/src/lib/data/userFund', () => ({
  fundViewRepo: { from: jest.fn() },
}));
jest.mock('@/src/lib/data/transaction', () => ({
  transactionRepo: { from: jest.fn() },
}));
jest.mock('@/src/lib/data/navHistory', () => ({
  navHistoryRepo: { from: jest.fn() },
}));
jest.mock('@/src/lib/data/indexHistory', () => ({
  indexHistoryRepo: { from: jest.fn() },
}));
jest.mock('@/src/lib/analytics', () => ({
  analytics: { isEnabled: false, track: jest.fn(), identify: jest.fn(), reset: jest.fn() },
}));

// eslint-disable-next-line import/first
import {
  bootstrap,
  bootstrapForUser,
  clearAll,
  didSyncChangeData,
  syncDelta,
  syncDeltaForUser,
  transactionIdSetsDiffer,
} from '../sync';
// eslint-disable-next-line import/first
import type { SyncResult } from '../sync';
// eslint-disable-next-line import/first
import { transactionRepo } from '@/src/lib/data/transaction';
// eslint-disable-next-line import/first
import { navHistoryRepo } from '@/src/lib/data/navHistory';
// eslint-disable-next-line import/first
import { indexHistoryRepo } from '@/src/lib/data/indexHistory';
// eslint-disable-next-line import/first
import { fundViewRepo } from '@/src/lib/data/userFund';
// eslint-disable-next-line import/first
import * as txRepo from '../tx';
// eslint-disable-next-line import/first
import * as navRepo from '../nav';
// eslint-disable-next-line import/first
import * as idxRepo from '../idx';
// eslint-disable-next-line import/first
import { __setDbForTests, getDb } from '../db';
// eslint-disable-next-line import/first
import { repairTimelineNavCache } from '@/src/hooks/useInvestmentVsBenchmarkTimeline';

const { __resetAllForTests } = jest.requireMock('expo-sqlite') as {
  __resetAllForTests: () => void;
};

describe('transactionIdSetsDiffer', () => {
  it('accepts the same sorted immutable-ID snapshot', () => {
    expect(transactionIdSetsDiffer(['a', 'b'], ['a', 'b'])).toBe(false);
  });

  it('detects a single server-side delete', () => {
    expect(transactionIdSetsDiffer(['a', 'b'], ['a'])).toBe(true);
  });

  it('detects equal counts with different immutable IDs', () => {
    expect(transactionIdSetsDiffer(['a', 'b'], ['a', 'c'])).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Orchestration-level cases
// ─────────────────────────────────────────────────────────────────────

interface ChainResponse {
  data?: unknown;
  error?: unknown;
  count?: number | null;
}

// Each call to `from()` returns the next chain in the queue. PostgREST's
// builder is method-chainable and Promise-like — `.gte(...)` mutates the
// query, awaiting it triggers the fetch — so we model both: every chain
// method returns the chain, and the chain itself has `.then` resolving
// to a queued response. Two `from()` invocations per sync mode in the
// reconciliation path: delta data, authoritative IDs, then a full pull only
// when those IDs differ.
function makeChainQueue(responses: ChainResponse[]) {
  const calls = {
    gte: [] as [string, string][],
  };
  let i = 0;
  function next() {
    const response = responses[i] ?? { data: [], error: null, count: null };
    i += 1;
    const chain: any = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      in: jest.fn().mockReturnThis(),
      order: jest.fn().mockReturnThis(),
      range: jest.fn().mockReturnThis(),
      gte: jest.fn((col: string, val: string) => {
        calls.gte.push([col, val]);
        return chain;
      }),
      then: (resolve: (v: ChainResponse) => void) => resolve(response),
    };
    return chain;
  }
  return { next, calls };
}

function MOCK_TX_ROW(opts: {
  fund_id: string;
  date: string;
  created_at: string;
  amount: number;
  units: number;
  id?: string;
}) {
  return {
    fund_id: opts.fund_id,
    transaction_date: opts.date,
    transaction_type: 'purchase',
    units: opts.units,
    amount: opts.amount,
    id: opts.id ?? `tx-${opts.fund_id}-${opts.date}`,
    nav_at_transaction: 100,
    folio_number: null,
    cas_import_id: null,
    created_at: opts.created_at,
  };
}

function emptyRepoMocks() {
  (navHistoryRepo.from as jest.Mock).mockImplementation(() =>
    makeChainQueue([{ data: [], error: null }]).next(),
  );
  (indexHistoryRepo.from as jest.Mock).mockImplementation(() =>
    makeChainQueue([{ data: [], error: null }]).next(),
  );
}

describe('sync.reconcileTransactionSnapshot — orchestration', () => {
  beforeEach(async () => {
    __resetAllForTests();
    await __setDbForTests(null);
    jest.clearAllMocks();
  });

  it('atomically replaces a drifted cache from the authoritative full snapshot', async () => {
    const existingRow = MOCK_TX_ROW({
      fund_id: 'f1', date: '2026-05-01', created_at: '2026-05-01T00:00:00Z', amount: 2000, units: 20,
    });
    await txRepo.bulkInsert([existingRow]);
    expect(await txRepo.count()).toBe(1);

    // Three Supabase calls for the bootstrap path:
    //   1. tx delta (returns 0 new — watermark is at the local row's created_at)
    //   2. immutable server IDs (10 IDs → drift detected)
    //   3. tx full pull for the rebuild
    const serverRows = [
      MOCK_TX_ROW({ fund_id: 'f1', date: '2026-03-01', created_at: '2026-03-01T00:00:00Z', amount: 100, units: 1 }),
      MOCK_TX_ROW({ fund_id: 'f1', date: '2026-03-02', created_at: '2026-03-02T00:00:00Z', amount: 100, units: 1 }),
      MOCK_TX_ROW({ fund_id: 'f1', date: '2026-03-03', created_at: '2026-03-03T00:00:00Z', amount: 100, units: 1 }),
      MOCK_TX_ROW({ fund_id: 'f1', date: '2026-03-04', created_at: '2026-03-04T00:00:00Z', amount: 100, units: 1 }),
      MOCK_TX_ROW({ fund_id: 'f1', date: '2026-03-05', created_at: '2026-03-05T00:00:00Z', amount: 100, units: 1 }),
      MOCK_TX_ROW({ fund_id: 'f1', date: '2026-03-06', created_at: '2026-03-06T00:00:00Z', amount: 100, units: 1 }),
      MOCK_TX_ROW({ fund_id: 'f1', date: '2026-03-07', created_at: '2026-03-07T00:00:00Z', amount: 100, units: 1 }),
      MOCK_TX_ROW({ fund_id: 'f1', date: '2026-03-08', created_at: '2026-03-08T00:00:00Z', amount: 100, units: 1 }),
      MOCK_TX_ROW({ fund_id: 'f1', date: '2026-03-09', created_at: '2026-03-09T00:00:00Z', amount: 100, units: 1 }),
      existingRow,
    ];
    const queue = makeChainQueue([
      { data: [], error: null }, // delta
      { data: serverRows.map((row) => ({ id: row.id })), error: null },
      { data: serverRows, error: null }, // full pull
    ]);
    (transactionRepo.from as jest.Mock).mockImplementation(queue.next);
    emptyRepoMocks();

    const result = await bootstrap('user-1', [], []);

    expect(result.txRebuiltFromDrift).toBe(true);
    expect(await txRepo.count()).toBe(10);
  });

  it('removes a single locally cached row deleted by a server-side reversal', async () => {
    const kept = MOCK_TX_ROW({
      fund_id: 'f1', date: '2026-04-01', created_at: '2026-04-01T00:00:00Z',
      amount: 1000, units: 10, id: 'kept',
    });
    const reversed = MOCK_TX_ROW({
      fund_id: 'f1', date: '2026-05-01', created_at: '2026-05-01T00:00:00Z',
      amount: 2000, units: 20, id: 'reversed',
    });
    await txRepo.bulkInsert([kept, reversed]);

    const queue = makeChainQueue([
      { data: [], error: null }, // delta — nothing new
      { data: [{ id: kept.id }], error: null }, // exact ID snapshot omits reversal
      { data: [kept], error: null }, // authoritative full replacement
    ]);
    (transactionRepo.from as jest.Mock).mockImplementation(queue.next);
    emptyRepoMocks();

    const { analytics } = jest.requireMock('@/src/lib/analytics') as {
      analytics: { track: jest.Mock };
    };

    const result = await bootstrap('user-1', [], []);

    expect(result.txRebuiltFromDrift).toBe(true);
    expect((await txRepo.readAll()).map((row) => row.id)).toEqual(['kept']);

    // But the event fires regardless — that's the visibility lever.
    expect(analytics.track).toHaveBeenCalledWith(
      'tx_cache_reconciled',
      expect.objectContaining({
        local_count_bucket: '1-10',
        server_count_bucket: '1-10',
        drift_bucket: '1-10',
        drift_direction: 'server_lower',
        rebuilt: true,
      }),
    );
    expect(analytics.track).not.toHaveBeenCalledWith(
      'tx_cache_reconciled',
      expect.objectContaining({ local_count: expect.anything() }),
    );
    expect(analytics.track).not.toHaveBeenCalledWith(
      'perf_mark',
      expect.objectContaining({ user_id_hint: expect.anything() }),
    );
    expect(analytics.track).toHaveBeenCalledWith(
      'db_sync_complete',
      expect.objectContaining({
        tx_inserted_bucket: '0',
        error_count_bucket: '0',
      }),
    );
    expect(analytics.track).not.toHaveBeenCalledWith(
      'db_sync_complete',
      expect.objectContaining({ tx_inserted: expect.anything() }),
    );
  });

  it('analytics is silent when counts match exactly — no noise on the healthy path', async () => {
    await txRepo.bulkInsert([
      MOCK_TX_ROW({ fund_id: 'f1', date: '2026-04-01', created_at: '2026-04-01T00:00:00Z', amount: 1000, units: 10 }),
    ]);

    const queue = makeChainQueue([
      { data: [], error: null }, // delta
      { data: [{ id: 'tx-f1-2026-04-01' }], error: null },
    ]);
    (transactionRepo.from as jest.Mock).mockImplementation(queue.next);
    emptyRepoMocks();

    const { analytics } = jest.requireMock('@/src/lib/analytics') as {
      analytics: { track: jest.Mock };
    };

    await bootstrap('user-1', [], []);

    // The only thing we care about: no `tx_cache_reconciled` event
    // when there's nothing to reconcile. (Other unrelated `track`
    // calls — perf marks etc. — are fine.)
    const reconciledCalls = analytics.track.mock.calls.filter(
      (call: unknown[]) => call[0] === 'tx_cache_reconciled',
    );
    expect(reconciledCalls).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────
// didSyncChangeData — pure predicate
// ─────────────────────────────────────────────────────────────────────

describe('didSyncChangeData', () => {
  const base: SyncResult = { txInserted: 0, navInserted: 0, idxInserted: 0, errors: [] };

  it('returns false when all counts are zero and txRebuiltFromDrift is absent', () => {
    expect(didSyncChangeData(base)).toBe(false);
  });

  it('returns false when txRebuiltFromDrift is explicitly false', () => {
    expect(didSyncChangeData({ ...base, txRebuiltFromDrift: false })).toBe(false);
  });

  it('returns false when txRebuiltFromDrift is undefined', () => {
    expect(didSyncChangeData({ ...base, txRebuiltFromDrift: undefined })).toBe(false);
  });

  it('returns true when txInserted > 0', () => {
    expect(didSyncChangeData({ ...base, txInserted: 1 })).toBe(true);
  });

  it('returns true when navInserted > 0', () => {
    expect(didSyncChangeData({ ...base, navInserted: 5 })).toBe(true);
  });

  it('returns true when idxInserted > 0', () => {
    expect(didSyncChangeData({ ...base, idxInserted: 2 })).toBe(true);
  });

  it('returns true when txRebuiltFromDrift is true (even with zero insert counts)', () => {
    expect(didSyncChangeData({ ...base, txRebuiltFromDrift: true })).toBe(true);
  });

  it('returns true when multiple fields are positive', () => {
    expect(didSyncChangeData({ ...base, txInserted: 3, navInserted: 10, idxInserted: 1 })).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────
// didSyncChangeData — bootstrap integration
// Verifies the contract that runBootstrap relies on: the predicate
// returns true when bootstrap actually wrote new rows (so the layout
// should call queryClient.invalidateQueries) and false when SQLite was
// already up to date (so no unnecessary recompute fires).
// ─────────────────────────────────────────────────────────────────────

describe('didSyncChangeData — bootstrap integration', () => {
  beforeEach(async () => {
    __resetAllForTests();
    await __setDbForTests(null);
    jest.clearAllMocks();
  });

  it('result indicates invalidation needed when bootstrap inserts new rows', async () => {
    const txRow = MOCK_TX_ROW({
      fund_id: 'f1',
      date: '2026-01-15',
      created_at: '2026-01-15T00:00:00Z',
      amount: 1000,
      units: 10,
    });
    const queue = makeChainQueue([
      { data: [txRow], error: null },       // delta: one new row
      { data: [{ id: txRow.id }], error: null },
    ]);
    (transactionRepo.from as jest.Mock).mockImplementation(queue.next);
    emptyRepoMocks();

    const result = await bootstrap('user-1', [], []);

    expect(result.txInserted).toBe(1);
    expect(didSyncChangeData(result)).toBe(true);
  });

  it('result indicates no invalidation needed when bootstrap finds nothing new', async () => {
    // Pre-populate SQLite so the watermark is non-null and the delta
    // returns nothing new.
    const existing = MOCK_TX_ROW({
      fund_id: 'f1',
      date: '2026-01-15',
      created_at: '2026-01-15T00:00:00Z',
      amount: 1000,
      units: 10,
    });
    await txRepo.bulkInsert([existing]);

    const queue = makeChainQueue([
      { data: [], error: null },             // delta: nothing new
      { data: [{ id: existing.id }], error: null },
    ]);
    (transactionRepo.from as jest.Mock).mockImplementation(queue.next);
    emptyRepoMocks();

    const result = await bootstrap('user-1', [], []);

    expect(result.txInserted).toBe(0);
    expect(result.navInserted).toBe(0);
    expect(result.idxInserted).toBe(0);
    expect(result.txRebuiltFromDrift).toBeFalsy();
    expect(didSyncChangeData(result)).toBe(false);
  });
});

describe('C1 NAV history completeness bootstrap', () => {
  beforeEach(async () => {
    __resetAllForTests();
    await __setDbForTests(null);
    jest.clearAllMocks();
  });

  it('backfills a recent-only scheme once, marks full history, then resumes delta sync', async () => {
    await navRepo.bulkInsert([
      { scheme_code: 100, nav_date: '2026-01-01', nav: 20 },
    ]);

    (transactionRepo.from as jest.Mock).mockImplementation(() => {
      let countOnly = false;
      const chain: any = {
        select: jest.fn((_columns: string, options?: { head?: boolean }) => {
          countOnly = options?.head === true;
          return chain;
        }),
        eq: jest.fn().mockReturnThis(),
        order: jest.fn().mockReturnThis(),
        range: jest.fn().mockReturnThis(),
        gte: jest.fn().mockReturnThis(),
        then: (resolve: (value: ChainResponse) => void) => resolve(
          countOnly
            ? { data: null, error: null, count: 0 }
            : { data: [], error: null },
        ),
      };
      return chain;
    });

    const navGte = jest.fn().mockReturnThis();
    const navOrder = jest.fn().mockReturnThis();
    (navHistoryRepo.from as jest.Mock).mockImplementation(() => ({
      select: jest.fn().mockReturnThis(),
      in: jest.fn().mockReturnThis(),
      order: navOrder,
      range: jest.fn().mockReturnThis(),
      gte: navGte,
      then: (resolve: (value: ChainResponse) => void) => resolve({
        data: [
          { scheme_code: 100, nav_date: '2020-01-01', nav: 10 },
          { scheme_code: 100, nav_date: '2026-01-01', nav: 20 },
        ],
        error: null,
      }),
    }));
    (indexHistoryRepo.from as jest.Mock).mockImplementation(() =>
      makeChainQueue([{ data: [], error: null }]).next(),
    );

    const first = await bootstrap('user-1', [100], []);
    expect(first.errors).toEqual([]);
    expect(await navRepo.countBySchemeCode(100)).toBe(2);
    expect(await navRepo.getHistoryCoverage(100)).toEqual({ known: true, startDate: null });
    expect(navGte).not.toHaveBeenCalled();
    expect(navOrder.mock.calls.slice(0, 2)).toEqual([
      ['nav_date', { ascending: true }],
      ['scheme_code', { ascending: true }],
    ]);

    const second = await bootstrap('user-1', [100], []);
    expect(second.errors).toEqual([]);
    expect(navGte).toHaveBeenCalledWith('nav_date', '2026-01-01');
  });
});

describe('N2D shared-connection sync overlap', () => {
  beforeEach(async () => {
    __resetAllForTests();
    await __setDbForTests(null);
    jest.clearAllMocks();
  });

  it('serializes bootstrap, foreground sync, timeline repair, and index write-back', async () => {
    (transactionRepo.from as jest.Mock).mockImplementation(() =>
      makeChainQueue([{ data: [], error: null, count: 0 }]).next(),
    );
    (navHistoryRepo.from as jest.Mock).mockImplementation(() =>
      makeChainQueue([{
        data: [{ scheme_code: 100, nav_date: '2026-01-01', nav: 10 }],
        error: null,
      }]).next(),
    );
    (indexHistoryRepo.from as jest.Mock).mockImplementation(() =>
      makeChainQueue([{
        data: [{ index_date: '2026-01-01', close_value: 100 }],
        error: null,
      }]).next(),
    );

    const db = await getDb();
    const originalTransaction = db.withTransactionAsync.bind(db);
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    let activeTransactions = 0;
    let maxActiveTransactions = 0;
    const sqliteErrors: string[] = [];
    db.withTransactionAsync = async (task) => {
      activeTransactions += 1;
      maxActiveTransactions = Math.max(maxActiveTransactions, activeTransactions);
      if (activeTransactions > 1) {
        const message = 'cannot start a transaction within a transaction';
        sqliteErrors.push(message);
        activeTransactions -= 1;
        throw new Error(message);
      }
      try {
        await Promise.resolve();
        await originalTransaction(task);
      } finally {
        activeTransactions -= 1;
      }
    };

    const [bootstrapResult, foregroundResult] = await Promise.all([
      bootstrap('user-1', [100], ['^NSEI']),
      syncDelta('user-1', [100], ['^NSEI']),
      repairTimelineNavCache([
        { scheme_code: 200, nav_date: '2026-01-01', nav: 20 },
      ]),
      idxRepo.bulkInsert(
        [{ index_symbol: '^NIFTY500TRI', index_date: '2026-01-01', close_value: 200 }],
        { operation: 'portfolio_index_write_back' },
      ),
    ]);

    expect(bootstrapResult.errors).toEqual([]);
    expect(foregroundResult.errors).toEqual([]);
    expect(maxActiveTransactions).toBe(1);
    expect(sqliteErrors).toEqual([]);
    expect(warn.mock.calls.flat().join(' ')).not.toMatch(
      /cannot start a transaction within a transaction|cannot rollback - no transaction is active/,
    );
    expect(await navRepo.count()).toBe(2);
    expect(await idxRepo.count()).toBe(2);
    warn.mockRestore();
  });
});

describe('N2D high-level sync lifecycle fencing', () => {
  beforeEach(async () => {
    __resetAllForTests();
    await __setDbForTests(null);
    jest.clearAllMocks();
    emptyRepoMocks();
  });

  it.each([
    ['bootstrap', bootstrapForUser],
    ['foreground delta', syncDeltaForUser],
  ] as const)(
    'captures %s scope before a blocked roster fetch and isolates user/generation single-flight',
    async (_label, runForUser) => {
      let releaseOldRoster!: (value: ChainResponse) => void;
      const oldRoster = new Promise<ChainResponse>((resolve) => {
        releaseOldRoster = resolve;
      });

      (fundViewRepo.from as jest.Mock).mockImplementation(() => {
        const chain: any = {
          select: jest.fn().mockReturnThis(),
          eq: jest.fn((_column: string, userId: string) => (
            userId === 'user-a'
              ? oldRoster
              : Promise.resolve({ data: [], error: null })
          )),
        };
        return chain;
      });

      (transactionRepo.from as jest.Mock).mockImplementation(() => {
        let userId = '';
        let countOnly = false;
        const chain: any = {
          select: jest.fn((_columns: string, options?: { head?: boolean }) => {
            countOnly = options?.head === true;
            return chain;
          }),
          eq: jest.fn((_column: string, value: string) => {
            userId = value;
            return chain;
          }),
          order: jest.fn().mockReturnThis(),
          range: jest.fn().mockReturnThis(),
          gte: jest.fn().mockReturnThis(),
          then: (resolve: (value: ChainResponse) => void) => {
            if (countOnly) {
              resolve({ data: null, error: null, count: 1 });
              return;
            }
            resolve({
              data: [MOCK_TX_ROW({
                fund_id: `fund-${userId}`,
                date: '2026-01-01',
                created_at: '2026-01-01T00:00:00Z',
                amount: userId === 'user-a' ? 100 : 200,
                units: userId === 'user-a' ? 1 : 2,
                id: `tx-${userId}`,
              })],
              error: null,
            });
          },
        };
        return chain;
      });

      const oldUserPromise = runForUser('user-a');
      expect(runForUser('user-a')).toBe(oldUserPromise);
      await Promise.resolve();

      await clearAll();
      const newUserPromise = runForUser('user-b');
      expect(newUserPromise).not.toBe(oldUserPromise);
      const newUserResult = await newUserPromise;
      expect(newUserResult.errors).toEqual([]);

      releaseOldRoster({ data: [], error: null });
      const oldUserResult = await oldUserPromise;
      expect(oldUserResult.errors.some((error) =>
        error.includes('invalidated cache lifecycle'))).toBe(true);

      const localRows = await txRepo.readAll();
      expect(localRows).toHaveLength(1);
      expect(localRows[0].fund_id).toBe('fund-user-b');
      expect(localRows[0].id).toBe('tx-user-b');
    },
  );
});
