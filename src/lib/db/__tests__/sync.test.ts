/**
 * Sync-orchestrator tests. The load-bearing assertion across these
 * cases is the bootstrap vs delta split for the transaction scope:
 *
 *  - **bootstrap** must do a FULL pull regardless of the local
 *    watermark. The watermark is monotonic-forward, so a SQLite
 *    table that drifted below the server (interrupted sync,
 *    earlier-bug residue, race during sign-in clear) can never
 *    self-repair via a watermark-gated delta — it would forever
 *    see "no new rows". Bootstrap is the recovery path.
 *  - **delta** must use the watermark — that's what makes
 *    foreground-resume cheap.
 *
 * NAV and index scopes stay watermark-gated in both modes; they're
 * orders of magnitude larger than tx and don't exhibit the same
 * per-user drift pattern (no client-side write path into them).
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

// Capture the `.gte` arguments each chain call sees so tests can
// assert "bootstrap didn't filter by watermark" vs "delta filtered
// by the local watermark". One chain instance per `from()` call,
// matching production's single-builder-per-query shape. The chain is
// also a thenable that resolves to `response`, which mirrors how
// PostgREST's builder works (every call returns a builder, awaiting
// it triggers the request) — important because tx fetch tacks `.gte`
// on *after* `.range`, so `.range` can't be the terminal mock.
function makeChain(response: { data: unknown; error: unknown }) {
  const calls = { gte: [] as [string, string][] };
  const chain: any = {
    select: jest.fn(),
    eq: jest.fn(),
    in: jest.fn(),
    order: jest.fn(),
    range: jest.fn(),
    gte: jest.fn((col: string, val: string) => {
      calls.gte.push([col, val]);
      return chain;
    }),
    then: (resolve: (v: typeof response) => void) => resolve(response),
  };
  ['select', 'eq', 'in', 'order', 'range'].forEach((m) => chain[m].mockReturnValue(chain));
  return { chain, calls };
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

describe('sync.runSync — transactions scope', () => {
  it('bootstrap pulls the FULL set (no watermark filter) even when SQLite has rows', async () => {
    // Pre-populate SQLite with two rows.
    await txRepo.bulkInsert([
      MOCK_TX_ROW({ fund_id: 'f1', date: '2026-04-01', created_at: '2026-04-01T00:00:00Z', amount: 1000, units: 10 }),
      MOCK_TX_ROW({ fund_id: 'f1', date: '2026-05-01', created_at: '2026-05-01T00:00:00Z', amount: 2000, units: 20 }),
    ]);
    expect(await txRepo.count()).toBe(2);

    // Server has those two PLUS an older row that's somehow missing
    // locally (the drift case the fix exists for).
    const serverRows = [
      MOCK_TX_ROW({ fund_id: 'f1', date: '2026-03-01', created_at: '2026-03-01T00:00:00Z', amount: 500, units: 5 }),
      MOCK_TX_ROW({ fund_id: 'f1', date: '2026-04-01', created_at: '2026-04-01T00:00:00Z', amount: 1000, units: 10 }),
      MOCK_TX_ROW({ fund_id: 'f1', date: '2026-05-01', created_at: '2026-05-01T00:00:00Z', amount: 2000, units: 20 }),
    ];
    const { chain, calls } = makeChain({ data: serverRows, error: null });
    (transactionRepo.from as jest.Mock).mockReturnValue(chain);
    // NAV / idx have no schemes/symbols configured so they no-op.
    (navHistoryRepo.from as jest.Mock).mockReturnValue(makeChain({ data: [], error: null }).chain);
    (indexHistoryRepo.from as jest.Mock).mockReturnValue(makeChain({ data: [], error: null }).chain);

    const result = await bootstrap('user-1', [], []);

    // No `.gte('created_at', …)` — that's the whole point.
    expect(calls.gte).toHaveLength(0);
    // The previously-missing row got backfilled.
    expect(await txRepo.count()).toBe(3);
    expect(result.txInserted).toBe(1);
    expect(result.errors).toEqual([]);
  });

  it('bootstrap on an empty SQLite still does a full pull', async () => {
    // Fresh install — nothing local, no watermark either.
    expect(await txRepo.count()).toBe(0);

    const serverRows = [
      MOCK_TX_ROW({ fund_id: 'f1', date: '2026-04-01', created_at: '2026-04-01T00:00:00Z', amount: 1000, units: 10 }),
    ];
    const { chain, calls } = makeChain({ data: serverRows, error: null });
    (transactionRepo.from as jest.Mock).mockReturnValue(chain);
    (navHistoryRepo.from as jest.Mock).mockReturnValue(makeChain({ data: [], error: null }).chain);
    (indexHistoryRepo.from as jest.Mock).mockReturnValue(makeChain({ data: [], error: null }).chain);

    const result = await bootstrap('user-1', [], []);
    expect(calls.gte).toHaveLength(0);
    expect(await txRepo.count()).toBe(1);
    expect(result.txInserted).toBe(1);
  });

  it('bootstrap is idempotent when SQLite is already in sync — INSERT OR IGNORE keeps writes at zero', async () => {
    const rows = [
      MOCK_TX_ROW({ fund_id: 'f1', date: '2026-04-01', created_at: '2026-04-01T00:00:00Z', amount: 1000, units: 10 }),
      MOCK_TX_ROW({ fund_id: 'f1', date: '2026-05-01', created_at: '2026-05-01T00:00:00Z', amount: 2000, units: 20 }),
    ];
    await txRepo.bulkInsert(rows);
    expect(await txRepo.count()).toBe(2);

    const { chain } = makeChain({ data: rows, error: null });
    (transactionRepo.from as jest.Mock).mockReturnValue(chain);
    (navHistoryRepo.from as jest.Mock).mockReturnValue(makeChain({ data: [], error: null }).chain);
    (indexHistoryRepo.from as jest.Mock).mockReturnValue(makeChain({ data: [], error: null }).chain);

    const result = await bootstrap('user-1', [], []);
    expect(await txRepo.count()).toBe(2);
    expect(result.txInserted).toBe(0);
  });

  it('delta uses the local watermark — `.gte("created_at", max)` is on the Supabase chain', async () => {
    await txRepo.bulkInsert([
      MOCK_TX_ROW({ fund_id: 'f1', date: '2026-04-01', created_at: '2026-04-01T00:00:00Z', amount: 1000, units: 10 }),
      MOCK_TX_ROW({ fund_id: 'f1', date: '2026-05-01', created_at: '2026-05-15T00:00:00Z', amount: 2000, units: 20 }),
    ]);

    const newer = MOCK_TX_ROW({
      fund_id: 'f1', date: '2026-05-16', created_at: '2026-05-16T00:00:00Z', amount: 3000, units: 30,
    });
    const { chain, calls } = makeChain({ data: [newer], error: null });
    (transactionRepo.from as jest.Mock).mockReturnValue(chain);
    (navHistoryRepo.from as jest.Mock).mockReturnValue(makeChain({ data: [], error: null }).chain);
    (indexHistoryRepo.from as jest.Mock).mockReturnValue(makeChain({ data: [], error: null }).chain);

    const result = await syncDelta('user-1', [], []);

    expect(calls.gte).toEqual([['created_at', '2026-05-15T00:00:00Z']]);
    expect(result.txInserted).toBe(1);
    expect(await txRepo.count()).toBe(3);
  });

  it('delta on empty SQLite skips the `.gte` filter and pulls everything', async () => {
    expect(await txRepo.count()).toBe(0);

    const serverRows = [
      MOCK_TX_ROW({ fund_id: 'f1', date: '2026-04-01', created_at: '2026-04-01T00:00:00Z', amount: 1000, units: 10 }),
    ];
    const { chain, calls } = makeChain({ data: serverRows, error: null });
    (transactionRepo.from as jest.Mock).mockReturnValue(chain);
    (navHistoryRepo.from as jest.Mock).mockReturnValue(makeChain({ data: [], error: null }).chain);
    (indexHistoryRepo.from as jest.Mock).mockReturnValue(makeChain({ data: [], error: null }).chain);

    await syncDelta('user-1', [], []);
    expect(calls.gte).toHaveLength(0);
    expect(await txRepo.count()).toBe(1);
  });

  it('bootstrap surfaces drift via analytics when it backfills missing rows', async () => {
    await txRepo.bulkInsert([
      MOCK_TX_ROW({ fund_id: 'f1', date: '2026-05-01', created_at: '2026-05-01T00:00:00Z', amount: 2000, units: 20 }),
    ]);

    const serverRows = [
      MOCK_TX_ROW({ fund_id: 'f1', date: '2026-03-01', created_at: '2026-03-01T00:00:00Z', amount: 500, units: 5 }),
      MOCK_TX_ROW({ fund_id: 'f1', date: '2026-04-01', created_at: '2026-04-01T00:00:00Z', amount: 1000, units: 10 }),
      MOCK_TX_ROW({ fund_id: 'f1', date: '2026-05-01', created_at: '2026-05-01T00:00:00Z', amount: 2000, units: 20 }),
    ];
    const { chain } = makeChain({ data: serverRows, error: null });
    (transactionRepo.from as jest.Mock).mockReturnValue(chain);
    (navHistoryRepo.from as jest.Mock).mockReturnValue(makeChain({ data: [], error: null }).chain);
    (indexHistoryRepo.from as jest.Mock).mockReturnValue(makeChain({ data: [], error: null }).chain);

    const { analytics } = jest.requireMock('@/src/lib/analytics') as {
      analytics: { track: jest.Mock };
    };

    await bootstrap('user-1', [], []);

    expect(analytics.track).toHaveBeenCalledWith(
      'db_sync_tx_drift_repaired',
      expect.objectContaining({ local_before: 1, server_total: 3, inserted: 2 }),
    );
  });
});
