/**
 * Sync-orchestrator tests for the transaction scope.
 *
 *   - **bootstrap** does a cheap server-side count check first. When
 *     local == server we stay on the watermark-gated delta (no extra
 *     bandwidth). When they diverge — the actual drift case — we
 *     drop the watermark and full-pull to reconcile. Bandwidth is
 *     paid only when we genuinely need to repair.
 *   - **delta** is pure watermark — no count check. Used by the
 *     short-idle foreground-resume path where the round-trip would
 *     add up.
 *
 * NAV / index scopes stay watermark-gated in both modes — they don't
 * have a per-user write path so the drift pattern doesn't apply.
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
import { bootstrap, syncDelta } from '@/src/lib/db/sync';
// eslint-disable-next-line import/first
import { transactionRepo } from '@/src/lib/data/transaction';
// eslint-disable-next-line import/first
import { navHistoryRepo } from '@/src/lib/data/navHistory';
// eslint-disable-next-line import/first
import { indexHistoryRepo } from '@/src/lib/data/indexHistory';
// eslint-disable-next-line import/first
import * as txRepo from '@/src/lib/db/tx';
// eslint-disable-next-line import/first
import { __setDbForTests } from '@/src/lib/db/db';

const { __resetAllForTests } = jest.requireMock('expo-sqlite') as {
  __resetAllForTests: () => void;
};

beforeEach(() => {
  __resetAllForTests();
  __setDbForTests(null);
  jest.clearAllMocks();
});

interface ChainResponse {
  data?: unknown;
  error?: unknown;
  count?: number | null;
}

// Each call to `from()` returns the next chain in the queue. The chain
// records which selects + gte filters were exercised, then resolves
// (when awaited) to the queued response. This lets a single test
// script both the count-check call (`select('id', { count: 'exact', head: true })`)
// and the row-data call (`select('id, fund_id, …')`) in sequence —
// PostgREST returns `{ data, error, count }` for both shapes, so the
// production code branches on which field it reads.
function makeChainQueue(responses: ChainResponse[]) {
  const calls = {
    selects: [] as unknown[][],
    gte: [] as [string, string][],
  };
  let i = 0;
  function next() {
    const response = responses[i] ?? { data: [], error: null, count: null };
    i += 1;
    const chain: any = {
      select: jest.fn((...args: unknown[]) => {
        calls.selects.push(args);
        return chain;
      }),
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

function MOCK_TX_ROW(opts: { fund_id: string; date: string; created_at: string; amount: number; units: number; id?: string }) {
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

describe('sync.runSync — transactions scope', () => {
  it('bootstrap (healthy SQLite, count matches server) takes the cheap delta path', async () => {
    // Pre-populate SQLite with two rows.
    await txRepo.bulkInsert([
      MOCK_TX_ROW({ fund_id: 'f1', date: '2026-04-01', created_at: '2026-04-01T00:00:00Z', amount: 1000, units: 10 }),
      MOCK_TX_ROW({ fund_id: 'f1', date: '2026-05-01', created_at: '2026-05-15T00:00:00Z', amount: 2000, units: 20 }),
    ]);
    expect(await txRepo.count()).toBe(2);

    // First Supabase call = count check, returns 2 (matches local).
    // Second call = the watermark delta, returns nothing new.
    const queue = makeChainQueue([
      { data: null, error: null, count: 2 },
      { data: [], error: null },
    ]);
    (transactionRepo.from as jest.Mock).mockImplementation(queue.next);
    emptyRepoMocks();

    const result = await bootstrap('user-1', [], []);

    // The delta query filtered by the local watermark — proof the
    // cheap path ran (not full-pull).
    expect(queue.calls.gte).toEqual([['created_at', '2026-05-15T00:00:00Z']]);
    expect(await txRepo.count()).toBe(2);
    expect(result.txInserted).toBe(0);
    expect(result.errors).toEqual([]);
  });

  it('bootstrap (count mismatch) drops the watermark and full-pulls to repair drift', async () => {
    // Local has 2 rows. Server has 3 — one is missing locally.
    await txRepo.bulkInsert([
      MOCK_TX_ROW({ fund_id: 'f1', date: '2026-04-01', created_at: '2026-04-01T00:00:00Z', amount: 1000, units: 10 }),
      MOCK_TX_ROW({ fund_id: 'f1', date: '2026-05-01', created_at: '2026-05-01T00:00:00Z', amount: 2000, units: 20 }),
    ]);
    expect(await txRepo.count()).toBe(2);

    const serverRows = [
      MOCK_TX_ROW({ fund_id: 'f1', date: '2026-03-01', created_at: '2026-03-01T00:00:00Z', amount: 500, units: 5 }),
      MOCK_TX_ROW({ fund_id: 'f1', date: '2026-04-01', created_at: '2026-04-01T00:00:00Z', amount: 1000, units: 10 }),
      MOCK_TX_ROW({ fund_id: 'f1', date: '2026-05-01', created_at: '2026-05-01T00:00:00Z', amount: 2000, units: 20 }),
    ];
    const queue = makeChainQueue([
      { data: null, error: null, count: 3 },
      { data: serverRows, error: null },
    ]);
    (transactionRepo.from as jest.Mock).mockImplementation(queue.next);
    emptyRepoMocks();

    const result = await bootstrap('user-1', [], []);

    // No `.gte` on the data query → full pull. That's the repair signal.
    expect(queue.calls.gte).toHaveLength(0);
    expect(await txRepo.count()).toBe(3);
    expect(result.txInserted).toBe(1);
  });

  it('bootstrap on an empty SQLite skips the count check (nothing to compare) and pulls everything', async () => {
    expect(await txRepo.count()).toBe(0);

    const serverRows = [
      MOCK_TX_ROW({ fund_id: 'f1', date: '2026-04-01', created_at: '2026-04-01T00:00:00Z', amount: 1000, units: 10 }),
    ];
    // Only one Supabase call expected — the data pull. No count check
    // when there's nothing local to compare against.
    const queue = makeChainQueue([{ data: serverRows, error: null }]);
    (transactionRepo.from as jest.Mock).mockImplementation(queue.next);
    emptyRepoMocks();

    const result = await bootstrap('user-1', [], []);
    expect(queue.calls.gte).toHaveLength(0);
    expect(await txRepo.count()).toBe(1);
    expect(result.txInserted).toBe(1);
  });

  it('bootstrap surfaces drift via analytics when the count check trips', async () => {
    await txRepo.bulkInsert([
      MOCK_TX_ROW({ fund_id: 'f1', date: '2026-05-01', created_at: '2026-05-01T00:00:00Z', amount: 2000, units: 20 }),
    ]);

    const serverRows = [
      MOCK_TX_ROW({ fund_id: 'f1', date: '2026-03-01', created_at: '2026-03-01T00:00:00Z', amount: 500, units: 5 }),
      MOCK_TX_ROW({ fund_id: 'f1', date: '2026-04-01', created_at: '2026-04-01T00:00:00Z', amount: 1000, units: 10 }),
      MOCK_TX_ROW({ fund_id: 'f1', date: '2026-05-01', created_at: '2026-05-01T00:00:00Z', amount: 2000, units: 20 }),
    ];
    const queue = makeChainQueue([
      { data: null, error: null, count: 3 },
      { data: serverRows, error: null },
    ]);
    (transactionRepo.from as jest.Mock).mockImplementation(queue.next);
    emptyRepoMocks();

    const { analytics } = jest.requireMock('@/src/lib/analytics') as {
      analytics: { track: jest.Mock };
    };

    await bootstrap('user-1', [], []);

    expect(analytics.track).toHaveBeenCalledWith(
      'db_sync_tx_drift_detected',
      expect.objectContaining({ local: 1, server: 3, delta: 2 }),
    );
    expect(analytics.track).toHaveBeenCalledWith(
      'db_sync_tx_drift_repaired',
      expect.objectContaining({ local_before: 1, server_total: 3, inserted: 2 }),
    );
  });

  it('bootstrap falls back to the cheap delta when the count check itself errors', async () => {
    // Local has 2 rows. The count check returns an error (transient
    // network blip, say). We must not turn that into a full pull —
    // that would punish the user for an upstream hiccup. Watermark
    // delta is the safe fallback.
    await txRepo.bulkInsert([
      MOCK_TX_ROW({ fund_id: 'f1', date: '2026-04-01', created_at: '2026-04-01T00:00:00Z', amount: 1000, units: 10 }),
      MOCK_TX_ROW({ fund_id: 'f1', date: '2026-05-01', created_at: '2026-05-15T00:00:00Z', amount: 2000, units: 20 }),
    ]);

    const queue = makeChainQueue([
      { data: null, error: { message: 'network' }, count: null },
      { data: [], error: null },
    ]);
    (transactionRepo.from as jest.Mock).mockImplementation(queue.next);
    emptyRepoMocks();

    await bootstrap('user-1', [], []);

    // Data query still went through, and it used the watermark.
    expect(queue.calls.gte).toEqual([['created_at', '2026-05-15T00:00:00Z']]);
    expect(await txRepo.count()).toBe(2);
  });

  it('delta uses the local watermark — no count check, no full pull', async () => {
    await txRepo.bulkInsert([
      MOCK_TX_ROW({ fund_id: 'f1', date: '2026-04-01', created_at: '2026-04-01T00:00:00Z', amount: 1000, units: 10 }),
      MOCK_TX_ROW({ fund_id: 'f1', date: '2026-05-01', created_at: '2026-05-15T00:00:00Z', amount: 2000, units: 20 }),
    ]);

    const newer = MOCK_TX_ROW({
      fund_id: 'f1', date: '2026-05-16', created_at: '2026-05-16T00:00:00Z', amount: 3000, units: 30,
    });
    const queue = makeChainQueue([{ data: [newer], error: null }]);
    (transactionRepo.from as jest.Mock).mockImplementation(queue.next);
    emptyRepoMocks();

    const result = await syncDelta('user-1', [], []);

    expect(queue.calls.gte).toEqual([['created_at', '2026-05-15T00:00:00Z']]);
    expect(result.txInserted).toBe(1);
    expect(await txRepo.count()).toBe(3);
  });

  it('delta on empty SQLite skips the `.gte` filter and pulls everything', async () => {
    expect(await txRepo.count()).toBe(0);

    const serverRows = [
      MOCK_TX_ROW({ fund_id: 'f1', date: '2026-04-01', created_at: '2026-04-01T00:00:00Z', amount: 1000, units: 10 }),
    ];
    const queue = makeChainQueue([{ data: serverRows, error: null }]);
    (transactionRepo.from as jest.Mock).mockImplementation(queue.next);
    emptyRepoMocks();

    await syncDelta('user-1', [], []);
    expect(queue.calls.gte).toHaveLength(0);
    expect(await txRepo.count()).toBe(1);
  });
});
