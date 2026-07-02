/**
 * `shouldRebuildTxOnDrift` is the pure decision helper — the cases
 * below lock the dual-threshold contract (drift ≥ 5 AND > 5% relative)
 * so it can't drift silently in a future refactor.
 *
 * The orchestration-level cases at the bottom (`reconcileTransactionCount`
 * via `bootstrap`) cover the two behaviours that distinguish this PR's
 * recovery story from a naive "clear + refetch":
 *
 *   1. Rebuild is **additive** — we don't `clear()` the local table
 *      before refilling, because that opens an empty-cache window if
 *      the rebuild's refetch fails mid-flight. `INSERT OR IGNORE`
 *      lands at the same end state for the dominant drift case
 *      ("local missing rows server has") with no failure window.
 *   2. Analytics fires on **any non-zero drift**, not just on
 *      rebuild. The rebuild threshold protects against sync-race
 *      thrash; the analytics threshold has to be more sensitive so
 *      below-rebuild drifts stay visible in PostHog — that's the
 *      signal we'd watch to find caching bugs the auto-rebuild would
 *      otherwise mask.
 */
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
  shouldRebuildTxOnDrift,
  syncDelta,
  syncDeltaForUser,
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

describe('shouldRebuildTxOnDrift', () => {
  describe('does NOT rebuild on small drifts (sync race window)', () => {
    it('returns false when counts match exactly', () => {
      expect(shouldRebuildTxOnDrift(100, 100)).toBe(false);
    });

    it('returns false when drift is 1 row (typical race: row arrived between local + server count)', () => {
      expect(shouldRebuildTxOnDrift(100, 101)).toBe(false);
      expect(shouldRebuildTxOnDrift(101, 100)).toBe(false);
    });

    it('returns false at the absolute boundary (drift = 4, just under threshold)', () => {
      expect(shouldRebuildTxOnDrift(100, 104)).toBe(false);
    });

    it('returns false when relative drift is exactly 5% (not strictly above)', () => {
      // 100 local, 105 server → drift 5, drift_pct = 5/105 ≈ 4.76% → false
      expect(shouldRebuildTxOnDrift(100, 105)).toBe(false);
    });

    it('returns false for a 100-row portfolio missing 1 row (1% drift)', () => {
      expect(shouldRebuildTxOnDrift(99, 100)).toBe(false);
    });
  });

  describe('rebuilds on meaningful drift (the load-bearing case)', () => {
    it('returns true on the May 2026 user scenario: ~25% portfolio rows missing', () => {
      // User had ~800 local rows but server had ~1100 — Portfolio
      // showed ₹23L instead of ₹31L. Reconciliation should fire here.
      expect(shouldRebuildTxOnDrift(800, 1100)).toBe(true);
    });

    it('returns true when local cache has zero but server has many (post-clear edge)', () => {
      // Shouldn't happen in normal flow (a zero local would be a
      // fresh bootstrap that fetches all), but if it does, rebuild.
      expect(shouldRebuildTxOnDrift(0, 1000)).toBe(true);
    });

    it('returns true when server has fewer (server-side cleanup like account deletion)', () => {
      expect(shouldRebuildTxOnDrift(1100, 800)).toBe(true);
    });

    it('rebuilds on a 30-row portfolio missing 6 rows (20%)', () => {
      expect(shouldRebuildTxOnDrift(24, 30)).toBe(true);
    });
  });

  describe('boundary tests at the dual-threshold corners', () => {
    it('drift=5 exactly + relative > 5% → rebuild fires', () => {
      // 4 local, 9 server → drift 5, drift_pct ≈ 55.5% → rebuild
      expect(shouldRebuildTxOnDrift(4, 9)).toBe(true);
    });

    it('drift=5 exactly + relative just under 5% → no rebuild', () => {
      // 100 local, 105 server → drift 5, drift_pct ≈ 4.76% → no rebuild
      expect(shouldRebuildTxOnDrift(100, 105)).toBe(false);
    });

    it('drift=4 + relative very high → no rebuild (absolute floor protects against tiny portfolios)', () => {
      // 1 local, 5 server → drift 4, drift_pct = 80% but still no rebuild
      // (single-digit portfolios are noisy; force user to do something
      // explicit if a manual import didn't land)
      expect(shouldRebuildTxOnDrift(1, 5)).toBe(false);
    });
  });

  describe('zero server count', () => {
    it('returns false when both are zero', () => {
      expect(shouldRebuildTxOnDrift(0, 0)).toBe(false);
    });

    it('returns false when server is zero but local has fewer than 5 rows (orphan but small)', () => {
      // 4 local, 0 server → drift 4, below absolute threshold → no rebuild
      expect(shouldRebuildTxOnDrift(4, 0)).toBe(false);
    });

    it('returns false when server is zero — drift_pct is 0 because the denominator is 0', () => {
      // Without this guard, dividing by zero would produce NaN; the
      // function should return false (we have nothing to reconcile against).
      expect(shouldRebuildTxOnDrift(1000, 0)).toBe(false);
    });
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
// reconciliation path: the delta data pull, then the count check.
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

describe('sync.reconcileTransactionCount — orchestration', () => {
  beforeEach(async () => {
    __resetAllForTests();
    await __setDbForTests(null);
    jest.clearAllMocks();
  });

  it('rebuild is additive — no `clear()` between detection and refill, so a mid-rebuild error never empties SQLite', async () => {
    // Local has 1 row (drifted far below server). The local row is
    // the load-bearing assertion: if reconcile cleared first, a
    // failure between `clear()` and `bulkInsert` would lose it. With
    // INSERT OR IGNORE only, it must still be present even if the
    // rebuild succeeds.
    const existingRow = MOCK_TX_ROW({
      fund_id: 'f1', date: '2026-05-01', created_at: '2026-05-01T00:00:00Z', amount: 2000, units: 20,
    });
    await txRepo.bulkInsert([existingRow]);
    expect(await txRepo.count()).toBe(1);

    // Three Supabase calls for the bootstrap path:
    //   1. tx delta (returns 0 new — watermark is at the local row's created_at)
    //   2. count check (server says 10 → drift = 9, fires rebuild)
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
      { data: null, error: null, count: 10 }, // count check
      { data: serverRows, error: null }, // full pull
    ]);
    (transactionRepo.from as jest.Mock).mockImplementation(queue.next);
    emptyRepoMocks();

    const result = await bootstrap('user-1', [], []);

    expect(result.txRebuiltFromDrift).toBe(true);
    // Original local row is still there + the 9 missing rows now
    // landed. Total = 10. The dedup PK (INSERT OR IGNORE) means the
    // existing row wasn't double-inserted.
    expect(await txRepo.count()).toBe(10);
  });

  it('analytics fires on any non-zero drift, not just on rebuild — below-threshold drift stays visible in PostHog', async () => {
    // Drift of 2 is below the rebuild threshold (need ≥5 absolute).
    // But we want it visible in PostHog so a chronic small-drift
    // pattern doesn't go undetected — that's the early signal for a
    // bug the auto-rebuild would otherwise mask once it crosses the
    // rebuild line.
    await txRepo.bulkInsert([
      MOCK_TX_ROW({ fund_id: 'f1', date: '2026-04-01', created_at: '2026-04-01T00:00:00Z', amount: 1000, units: 10 }),
      MOCK_TX_ROW({ fund_id: 'f1', date: '2026-05-01', created_at: '2026-05-01T00:00:00Z', amount: 2000, units: 20 }),
    ]);

    const queue = makeChainQueue([
      { data: [], error: null }, // delta — nothing new
      { data: null, error: null, count: 4 }, // count check: server has 4, local has 2 → drift 2
    ]);
    (transactionRepo.from as jest.Mock).mockImplementation(queue.next);
    emptyRepoMocks();

    const { analytics } = jest.requireMock('@/src/lib/analytics') as {
      analytics: { track: jest.Mock };
    };

    const result = await bootstrap('user-1', [], []);

    // No rebuild — drift is below threshold.
    expect(result.txRebuiltFromDrift).toBeFalsy();
    expect(await txRepo.count()).toBe(2);

    // But the event fires regardless — that's the visibility lever.
    expect(analytics.track).toHaveBeenCalledWith(
      'tx_cache_reconciled',
      expect.objectContaining({
        local_count: 2,
        server_count: 4,
        drift: 2,
        rebuilt: false,
      }),
    );
  });

  it('analytics is silent when counts match exactly — no noise on the healthy path', async () => {
    await txRepo.bulkInsert([
      MOCK_TX_ROW({ fund_id: 'f1', date: '2026-04-01', created_at: '2026-04-01T00:00:00Z', amount: 1000, units: 10 }),
    ]);

    const queue = makeChainQueue([
      { data: [], error: null }, // delta
      { data: null, error: null, count: 1 }, // count check: matches
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
      { data: null, error: null, count: 1 }, // count check: server=1 local=1, no drift
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
      { data: null, error: null, count: 1 }, // count check: server=1 local=1, no drift
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
