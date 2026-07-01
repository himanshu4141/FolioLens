import * as SQLite from 'expo-sqlite';
import {
  __setDbForTests,
  captureDatabaseWriteScope,
  dropAndRecreate,
  getDb,
  runSerializedDatabaseWrite,
  StaleDatabaseWriteError,
} from '@/src/lib/db/db';
import * as txRepo from '@/src/lib/db/tx';
import * as navRepo from '@/src/lib/db/nav';
import * as idxRepo from '@/src/lib/db/idx';
import { repairTimelineNavCache } from '@/src/hooks/useInvestmentVsBenchmarkTimeline';

jest.mock('@tanstack/react-query', () => ({ useQuery: jest.fn() }));
jest.mock('@/src/hooks/usePerformanceTimeline', () => ({
  buildXAxisLabels: (dates: string[]) => dates,
}));

const TX_ROW = {
  fund_id: 'fund-1',
  transaction_date: '2026-01-01',
  transaction_type: 'purchase',
  units: 10,
  amount: 100,
  id: 'tx-1',
  nav_at_transaction: 10,
  folio_number: null,
  cas_import_id: null,
  created_at: '2026-01-01T00:00:00Z',
};

beforeEach(async () => {
  await __setDbForTests(null);
});

describe('shared SQLite write serializer', () => {
  it('overlaps bootstrap, foreground, timeline repair, and index work without overlapping transactions', async () => {
    const db = await getDb();
    const originalTransaction = db.withTransactionAsync.bind(db);
    let activeTransactions = 0;
    let maxActiveTransactions = 0;

    db.withTransactionAsync = async (task) => {
      activeTransactions += 1;
      maxActiveTransactions = Math.max(maxActiveTransactions, activeTransactions);
      if (activeTransactions > 1) {
        throw new Error('cannot start a transaction within a transaction');
      }
      try {
        // Force all four callers to be concurrently pending. Without one
        // connection-level queue their transaction windows would overlap.
        await Promise.resolve();
        await originalTransaction(task);
      } finally {
        activeTransactions -= 1;
      }
    };

    await Promise.all([
      txRepo.bulkInsert([TX_ROW], { operation: 'bootstrap_tx_write' }),
      navRepo.bulkInsert(
        [{ scheme_code: 100, nav_date: '2026-01-01', nav: 10 }],
        { operation: 'foreground_nav_write' },
      ),
      repairTimelineNavCache([
        { scheme_code: 200, nav_date: '2026-01-01', nav: 20 },
      ]),
      idxRepo.bulkInsert(
        [{ index_symbol: '^NSEI', index_date: '2026-01-01', close_value: 100 }],
        { operation: 'portfolio_index_write_back' },
      ),
    ]);

    expect(maxActiveTransactions).toBe(1);
    expect(await txRepo.count()).toBe(1);
    expect(await navRepo.count()).toBe(2);
    expect(await idxRepo.count()).toBe(1);
  });

  it('does not poison the queue when one transaction rejects', async () => {
    const db = await getDb();
    const originalTransaction = db.withTransactionAsync.bind(db);
    let transactionAttempt = 0;
    db.withTransactionAsync = async (task) => {
      transactionAttempt += 1;
      if (transactionAttempt === 1) throw new Error('injected write failure');
      await originalTransaction(task);
    };

    const failed = navRepo.bulkInsert([
      { scheme_code: 100, nav_date: '2026-01-01', nav: 10 },
    ]);
    const next = idxRepo.bulkInsert([
      { index_symbol: '^NSEI', index_date: '2026-01-01', close_value: 100 },
    ]);

    await expect(failed).rejects.toThrow('injected write failure');
    await expect(next).resolves.toBeUndefined();
    expect(await idxRepo.count()).toBe(1);
  });

  it('invalidates queued old-scope writes before cleanup and orders new writes afterward', async () => {
    let releaseBlocker!: () => void;
    let markStarted!: () => void;
    const blockerStarted = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const blockerGate = new Promise<void>((resolve) => {
      releaseBlocker = resolve;
    });

    const blocker = runSerializedDatabaseWrite('test_blocker', async () => {
      markStarted();
      await blockerGate;
    });
    await blockerStarted;

    const oldScope = captureDatabaseWriteScope();
    const staleWrite = navRepo.bulkInsert(
      [{ scheme_code: 100, nav_date: '2026-01-01', nav: 10 }],
      { scope: oldScope, operation: 'old_user_nav_write' },
    );
    const cleanup = dropAndRecreate();
    const newWrite = navRepo.bulkInsert(
      [{ scheme_code: 200, nav_date: '2026-01-01', nav: 20 }],
      { operation: 'new_user_nav_write' },
    );

    releaseBlocker();
    await blocker;
    await expect(staleWrite).rejects.toBeInstanceOf(StaleDatabaseWriteError);
    await cleanup;
    await newWrite;

    expect(await navRepo.readBySchemeCode(100)).toEqual([]);
    expect(await navRepo.readBySchemeCode(200)).toHaveLength(1);
  });

  it('waits for queued work before replacing the test connection', async () => {
    const oldDb = await getDb();
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const didStart = new Promise<void>((resolve) => {
      started = resolve;
    });
    const activeWrite = runSerializedDatabaseWrite('test_connection_hold', async () => {
      started();
      await gate;
    });
    await didStart;

    const replacement = await SQLite.openDatabaseAsync(':replacement:');
    let resetFinished = false;
    const reset = __setDbForTests(Promise.resolve(replacement)).then(() => {
      resetFinished = true;
    });
    await Promise.resolve();
    expect(resetFinished).toBe(false);

    release();
    await activeWrite;
    await reset;
    expect(await getDb()).toBe(replacement);
    expect(await getDb()).not.toBe(oldDb);
  });
});
