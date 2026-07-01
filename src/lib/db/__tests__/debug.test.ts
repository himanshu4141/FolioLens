/**
 * Tests for the cache-debug snapshot. Covers each `snapshot*` helper
 * end-to-end against the in-memory SQLite mock + a mocked
 * `transactionRepo` (for the server-side count query) + the auto-
 * mocked AsyncStorage (for the persister-blob inspector).
 *
 * The screen that *renders* this snapshot is .tsx and excluded from
 * Jest's `collectCoverageFrom`, so this file is the only thing
 * keeping the debug bundle inside the global coverage threshold.
 */
jest.mock('@/src/lib/data/transaction', () => ({
  transactionRepo: { from: jest.fn() },
}));

// eslint-disable-next-line import/first
import AsyncStorage from '@react-native-async-storage/async-storage';
// eslint-disable-next-line import/first
import { snapshotCache } from '@/src/lib/db/debug';
// eslint-disable-next-line import/first
import { transactionRepo } from '@/src/lib/data/transaction';
// eslint-disable-next-line import/first
import * as txRepo from '@/src/lib/db/tx';
// eslint-disable-next-line import/first
import * as navRepo from '@/src/lib/db/nav';
// eslint-disable-next-line import/first
import * as idxRepo from '@/src/lib/db/idx';
// eslint-disable-next-line import/first
import * as syncStateRepo from '@/src/lib/db/syncState';
// eslint-disable-next-line import/first
import { __setDbForTests } from '@/src/lib/db/db';
// eslint-disable-next-line import/first
import { PERSIST_KEY } from '@/src/lib/queryClient';

const { __resetAllForTests } = jest.requireMock('expo-sqlite') as {
  __resetAllForTests: () => void;
};

beforeEach(async () => {
  __resetAllForTests();
  await __setDbForTests(null);
  jest.clearAllMocks();
  // AsyncStorage's auto-mock keeps its in-memory map across tests, so
  // wipe the persister blob explicitly — otherwise an earlier test's
  // payload leaks into the next persister assertion.
  await AsyncStorage.removeItem(PERSIST_KEY);
});

// Server-count chain is a thenable that resolves to `{ data, error, count }`.
// Tests that don't care about server count return null so the helper
// falls through to "—" gracefully.
function mockServerCount(response: { count?: number | null; error?: unknown }) {
  const chain: any = {
    select: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    then: (resolve: (v: typeof response) => void) =>
      resolve({ count: response.count ?? null, error: response.error ?? null }),
  };
  (transactionRepo.from as jest.Mock).mockReturnValue(chain);
}

const FUNDS = [
  { scheme_code: 100, scheme_name: 'Alpha Equity Fund' },
  { scheme_code: 200, scheme_name: 'Beta Debt Fund' },
];

describe('snapshotCache — tx scope', () => {
  it('returns local + server counts and computes drift correctly', async () => {
    await txRepo.bulkInsert([
      {
        fund_id: 'f1', transaction_date: '2024-01-01', transaction_type: 'purchase',
        units: 100, amount: 10000, id: 't1',
        nav_at_transaction: 100, folio_number: null, cas_import_id: null,
        created_at: '2024-01-02T00:00:00Z',
      },
      {
        fund_id: 'f1', transaction_date: '2024-05-01', transaction_type: 'purchase',
        units: 50, amount: 6000, id: 't2',
        nav_at_transaction: 120, folio_number: null, cas_import_id: null,
        created_at: '2024-05-02T00:00:00Z',
      },
    ]);
    mockServerCount({ count: 5 });

    const snap = await snapshotCache('user-1', FUNDS);

    expect(snap.tx.localCount).toBe(2);
    expect(snap.tx.serverCount).toBe(5);
    expect(snap.tx.drift).toBe(3);
    expect(snap.tx.latestTransactionDate).toBe('2024-05-01');
    expect(snap.tx.watermarkCreatedAt).toBe('2024-05-02T00:00:00Z');
  });

  it('reports drift = null when the server count query errors', async () => {
    await txRepo.bulkInsert([
      {
        fund_id: 'f1', transaction_date: '2024-01-01', transaction_type: 'purchase',
        units: 100, amount: 10000, id: 't1',
        nav_at_transaction: 100, folio_number: null, cas_import_id: null,
        created_at: '2024-01-02T00:00:00Z',
      },
    ]);
    mockServerCount({ error: { message: 'network' } });

    const snap = await snapshotCache('user-1', FUNDS);

    expect(snap.tx.localCount).toBe(1);
    expect(snap.tx.serverCount).toBeNull();
    expect(snap.tx.drift).toBeNull();
  });
});

describe('snapshotCache — nav scope', () => {
  it('aggregates per-scheme row count + watermark, sorted heaviest first', async () => {
    await navRepo.bulkInsert([
      { scheme_code: 100, nav_date: '2024-01-01', nav: 10 },
      { scheme_code: 100, nav_date: '2024-06-01', nav: 12 },
      { scheme_code: 200, nav_date: '2024-03-01', nav: 20 },
    ]);
    mockServerCount({ count: 0 });

    const snap = await snapshotCache('user-1', FUNDS);

    expect(snap.nav.totalCount).toBe(3);
    expect(snap.nav.perScheme).toHaveLength(2);
    expect(snap.nav.perScheme[0].schemeCode).toBe(100); // heavier first
    expect(snap.nav.perScheme[0].schemeName).toBe('Alpha Equity Fund');
    expect(snap.nav.perScheme[0].rowCount).toBe(2);
    expect(snap.nav.perScheme[0].watermark).toBe('2024-06-01');
    expect(snap.nav.perScheme[1].rowCount).toBe(1);
  });

  it('returns empty perScheme when no funds are passed in', async () => {
    mockServerCount({ count: 0 });
    const snap = await snapshotCache('user-1', []);
    expect(snap.nav.perScheme).toEqual([]);
  });
});

describe('snapshotCache — idx scope', () => {
  it('reports per-symbol counts + watermarks for every benchmark', async () => {
    await idxRepo.bulkInsert([
      { index_symbol: '^NSEITRI', index_date: '2024-01-01', close_value: 17000 },
      { index_symbol: '^NSEITRI', index_date: '2024-06-01', close_value: 21000 },
    ]);
    mockServerCount({ count: 0 });

    const snap = await snapshotCache('user-1', FUNDS);

    const nseitri = snap.idx.perSymbol.find((s) => s.symbol === '^NSEITRI');
    expect(nseitri?.rowCount).toBe(2);
    expect(nseitri?.watermark).toBe('2024-06-01');
    // The other benchmarks in BENCHMARK_OPTIONS have no rows — they
    // should still appear, just with 0 / null.
    expect(snap.idx.perSymbol.length).toBeGreaterThan(1);
    const empty = snap.idx.perSymbol.find((s) => s.rowCount === 0);
    expect(empty?.watermark).toBeNull();
  });
});

describe('snapshotCache — sync_state scope', () => {
  it('reports every scope sorted newest first', async () => {
    await syncStateRepo.upsert('tx:user-1', '2024-06-01T00:00:00Z', '2024-05-30');
    await syncStateRepo.upsert('nav:100', '2024-08-01T00:00:00Z', '2024-07-30');
    mockServerCount({ count: 0 });

    const snap = await snapshotCache('user-1', FUNDS);

    expect(snap.syncState).toHaveLength(2);
    expect(snap.syncState[0].scope).toBe('nav:100');
    expect(snap.syncState[0].lastSyncedAt).toBe('2024-08-01T00:00:00Z');
    expect(snap.syncState[0].watermarkDate).toBe('2024-07-30');
    expect(snap.syncState[1].scope).toBe('tx:user-1');
  });
});

describe('snapshotCache — persister scope', () => {
  it('reports blob size + entry count + breakdown by key prefix', async () => {
    const blob = JSON.stringify({
      buster: 'v4',
      timestamp: 1717000000000,
      clientState: {
        queries: [
          { queryKey: ['portfolio', 'u'] },
          { queryKey: ['portfolio', 'u', '^NSEI'] },
          { queryKey: ['money-trail', 'u'] },
          { queryKey: ['user-transactions', 'u'] },
        ],
      },
    });
    await AsyncStorage.setItem(PERSIST_KEY, blob);
    mockServerCount({ count: 0 });

    const snap = await snapshotCache('user-1', FUNDS);

    expect(snap.persister.blobSizeBytes).toBe(blob.length);
    expect(snap.persister.buster).toBe('v4');
    expect(snap.persister.timestamp).toBe(1717000000000);
    expect(snap.persister.entryCount).toBe(4);
    expect(snap.persister.parseError).toBeNull();
    // sorted descending by count, so portfolio (2) is first
    const portfolio = snap.persister.byKeyPrefix.find((p) => p.prefix === 'portfolio');
    expect(portfolio?.count).toBe(2);
    expect(snap.persister.byKeyPrefix[0].prefix).toBe('portfolio');
  });

  it('reports parseError when the blob is not valid JSON', async () => {
    await AsyncStorage.setItem(PERSIST_KEY, 'not-json{');
    mockServerCount({ count: 0 });

    const snap = await snapshotCache('user-1', FUNDS);

    expect(snap.persister.blobSizeBytes).toBe('not-json{'.length);
    expect(snap.persister.parseError).not.toBeNull();
    expect(snap.persister.entryCount).toBeNull();
    expect(snap.persister.byKeyPrefix).toEqual([]);
  });

  it('reports entryCount=0 when AsyncStorage has no blob yet', async () => {
    mockServerCount({ count: 0 });
    const snap = await snapshotCache('user-1', FUNDS);
    expect(snap.persister.blobSizeBytes).toBeNull();
    expect(snap.persister.entryCount).toBe(0);
  });

  it('records `<non-string>` for queries whose first key is not a string', async () => {
    const blob = JSON.stringify({
      buster: 'v4',
      timestamp: 1,
      clientState: { queries: [{ queryKey: [42, 'extra'] }, { queryKey: ['portfolio'] }] },
    });
    await AsyncStorage.setItem(PERSIST_KEY, blob);
    mockServerCount({ count: 0 });

    const snap = await snapshotCache('user-1', FUNDS);
    const nonString = snap.persister.byKeyPrefix.find((p) => p.prefix === '<non-string>');
    expect(nonString?.count).toBe(1);
  });
});

describe('snapshotCache — top-level shape', () => {
  it('includes a generatedAt ISO timestamp for the screen toolbar', async () => {
    mockServerCount({ count: 0 });
    const snap = await snapshotCache('user-1', FUNDS);
    expect(snap.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });
});
