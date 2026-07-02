/**
 * Unit tests for the windowed NAV fetch option in fetchFundNavHistory.
 *
 * Verifies:
 *  1. When sinceDate is set, the Supabase query includes a .gte() filter.
 *  2. When sinceDate is set, results are NOT written back to SQLite (poisoning
 *     prevention — a partial slice must not be mistaken for full history).
 *  3. When sinceDate is omitted, results ARE written back to SQLite (existing
 *     behaviour must be preserved).
 */

jest.mock('@tanstack/react-query', () => ({
  useQuery: jest.fn(),
  useQueryClient: jest.fn(),
}));
jest.mock('@/src/lib/data/userFund', () => ({
  fundViewRepo: { from: jest.fn() },
}));
jest.mock('@/src/lib/data/transaction', () => ({
  transactionRepo: { from: jest.fn() },
}));
jest.mock('@/src/lib/data/navHistory', () => ({
  navHistoryRepo: { from: jest.fn() },
}));
jest.mock('@/src/lib/data/schemeMaster', () => ({
  schemeMasterRepo: { from: jest.fn() },
}));

// eslint-disable-next-line import/first
import { appendNavTailIfStale, fetchFundNavHistory } from '@/src/hooks/useFundDetail';
// eslint-disable-next-line import/first
import { navHistoryRepo } from '@/src/lib/data/navHistory';
// eslint-disable-next-line import/first
import { __setDbForTests } from '@/src/lib/db/db';
// eslint-disable-next-line import/first
import * as navRepo from '@/src/lib/db/nav';

const { __resetAllForTests } = jest.requireMock('expo-sqlite') as {
  __resetAllForTests: () => void;
};

// ─── Mock helpers ─────────────────────────────────────────────────────────────

const SCHEME_CODE = 120503;
const SAMPLE_ROWS = [
  { nav_date: '2022-06-01', nav: 50.0 },
  { nav_date: '2023-06-01', nav: 60.0 },
  { nav_date: '2024-06-01', nav: 70.0 },
  { nav_date: '2025-06-01', nav: 80.0 },
];

/**
 * Build a chainable Supabase-style query mock that records which filter methods
 * were called and resolves with the provided rows.
 */
function makeNavQueryChain(rows: typeof SAMPLE_ROWS) {
  const calls: Record<string, unknown[]> = {};
  const chain: Record<string, jest.Mock> = {};
  const methods = ['select', 'eq', 'order', 'gte', 'range'];
  for (const m of methods) {
    chain[m] = jest.fn((...args: unknown[]) => {
      calls[m] = args;
      return chain;
    });
  }
  // range() is the terminal call that returns the page result
  chain['range'] = jest.fn(() => Promise.resolve({ data: rows, error: null }));
  return { chain, calls };
}

beforeEach(async () => {
  __resetAllForTests();
  await __setDbForTests(null); // force empty SQLite so reads fall through to Supabase
});

afterEach(() => {
  jest.clearAllMocks();
});

// ─── Windowed fetch (sinceDate set) ───────────────────────────────────────────

describe('fetchFundNavHistory with sinceDate', () => {
  it('applies a gte filter on nav_date when sinceDate is provided', async () => {
    const { chain } = makeNavQueryChain(SAMPLE_ROWS);
    (navHistoryRepo.from as jest.Mock).mockReturnValue(chain);

    const since = '2021-06-11';
    await fetchFundNavHistory(SCHEME_CODE, { sinceDate: since });

    expect(chain.gte).toHaveBeenCalledWith('nav_date', since);
  });

  it('does NOT apply a gte filter when sinceDate is omitted', async () => {
    const { chain } = makeNavQueryChain(SAMPLE_ROWS);
    (navHistoryRepo.from as jest.Mock).mockReturnValue(chain);

    await fetchFundNavHistory(SCHEME_CODE);

    expect(chain.gte).not.toHaveBeenCalled();
  });

  it('maps Supabase rows to NavPoint[] correctly', async () => {
    const { chain } = makeNavQueryChain(SAMPLE_ROWS);
    (navHistoryRepo.from as jest.Mock).mockReturnValue(chain);

    const result = await fetchFundNavHistory(SCHEME_CODE, { sinceDate: '2021-06-11' });

    expect(result).toHaveLength(SAMPLE_ROWS.length);
    expect(result[0]).toEqual({ date: '2022-06-01', value: 50 });
    expect(result[3]).toEqual({ date: '2025-06-01', value: 80 });
  });

  it('returns empty array when Supabase returns no rows', async () => {
    const { chain } = makeNavQueryChain([]);
    (navHistoryRepo.from as jest.Mock).mockReturnValue(chain);

    const result = await fetchFundNavHistory(SCHEME_CODE, { sinceDate: '2021-06-11' });
    expect(result).toEqual([]);
  });
});

// ─── SQLite write-back behaviour ──────────────────────────────────────────────

describe('fetchFundNavHistory write-back behaviour', () => {
  it('does NOT write to SQLite when sinceDate is set (poisoning prevention)', async () => {
    const { chain } = makeNavQueryChain(SAMPLE_ROWS);
    (navHistoryRepo.from as jest.Mock).mockReturnValue(chain);

    await fetchFundNavHistory(SCHEME_CODE, { sinceDate: '2021-06-11' });

    // The in-memory SQLite nav table must remain empty: a windowed slice must
    // never be written back or it would poison useFundNavHistory into thinking
    // full history is already cached (rows.length > 0 short-circuits the
    // Supabase fallback), silently breaking Fund Detail charts.
    const localRows = await navRepo.readBySchemeCode(SCHEME_CODE);
    expect(localRows).toHaveLength(0);
  });

  it('DOES write to SQLite for a full-history fetch (no sinceDate)', async () => {
    const { chain } = makeNavQueryChain(SAMPLE_ROWS);
    (navHistoryRepo.from as jest.Mock).mockReturnValue(chain);

    await fetchFundNavHistory(SCHEME_CODE);

    const localRows = await navRepo.readBySchemeCode(SCHEME_CODE);
    expect(localRows).toHaveLength(SAMPLE_ROWS.length);
    expect(localRows[0]).toMatchObject({ scheme_code: SCHEME_CODE, nav_date: '2022-06-01', nav: 50 });
  });
});

// ─── appendNavTailIfStale ─────────────────────────────────────────────────────

const SEED_ROWS = [
  { scheme_code: SCHEME_CODE, nav_date: '2022-06-01', nav: 50 },
  { scheme_code: SCHEME_CODE, nav_date: '2023-06-01', nav: 60 },
  { scheme_code: SCHEME_CODE, nav_date: '2024-06-01', nav: 70 },
];

describe('appendNavTailIfStale', () => {
  it('returns topped_up=false when there are no local rows (watermark is null)', async () => {
    // DB is fresh with empty nav table — watermark returns null
    const result = await appendNavTailIfStale(SCHEME_CODE, '2025-06-01');
    expect(result).toEqual({ topped_up: false, rows_appended: 0 });
  });

  it('returns topped_up=false when local series is already at the hydrated date', async () => {
    await navRepo.bulkInsert(SEED_ROWS); // localMax = '2024-06-01'
    const result = await appendNavTailIfStale(SCHEME_CODE, '2024-06-01');
    expect(result).toEqual({ topped_up: false, rows_appended: 0 });
  });

  it('fetches and appends the tail when local series is older than the hydration date', async () => {
    await navRepo.bulkInsert(SEED_ROWS); // localMax = '2024-06-01'

    const TAIL = [
      { nav_date: '2024-06-01', nav: 70.0 }, // safe duplicate via INSERT OR IGNORE
      { nav_date: '2025-06-01', nav: 80.0 },
    ];
    const { chain } = makeNavQueryChain(TAIL);
    (navHistoryRepo.from as jest.Mock).mockReturnValue(chain);

    const result = await appendNavTailIfStale(SCHEME_CODE, '2025-06-01');

    expect(result.topped_up).toBe(true);
    expect(result.rows_appended).toBe(TAIL.length);

    // Verify the new tail row is now in the in-memory SQLite store
    const localRows = await navRepo.readBySchemeCode(SCHEME_CODE);
    expect(localRows.map((r) => r.nav_date)).toContain('2025-06-01');
  });

  it('applies a gte(localMax) filter on the Supabase tail fetch', async () => {
    await navRepo.bulkInsert([{ scheme_code: SCHEME_CODE, nav_date: '2024-06-01', nav: 70 }]);

    const { chain } = makeNavQueryChain([{ nav_date: '2025-06-01', nav: 80 }]);
    (navHistoryRepo.from as jest.Mock).mockReturnValue(chain);

    await appendNavTailIfStale(SCHEME_CODE, '2025-06-01');

    expect(chain.gte).toHaveBeenCalledWith('nav_date', '2024-06-01');
  });
});
