/**
 * Tests for filterToWindow — date-based windowing with stale-data fallback.
 *
 * Note: These tests freeze "today" by mocking Date so the cutoff calculations
 * are deterministic regardless of when the tests are run.
 */

import type { QueryClient } from '@tanstack/react-query';
import { filterToWindow, indexTo100, type TimeWindow } from '@/src/utils/navUtils';
import { fetchFundDetail } from '@/src/hooks/useFundDetail';
import { supabase } from '@/src/lib/supabase';
import { __setDbForTests } from '@/src/lib/db/db';
// Auto-mocked via `__mocks__/expo-sqlite.ts`; pull the test helper via
// a typed require since the real `.d.ts` doesn't declare it.
const { __resetAllForTests } = jest.requireMock('expo-sqlite') as {
  __resetAllForTests: () => void;
};

jest.mock('@tanstack/react-query', () => ({
  useQuery: jest.fn(),
  useQueryClient: jest.fn(),
}));
jest.mock('@/src/lib/supabase', () => ({ supabase: { from: jest.fn() } }));

// Per-test reset for the SQLite mock — same pattern as the portfolio
// hook tests. Each test runs against an empty `tx` / `nav` / `idx`
// repo, which forces the read-through fetchers to fall through to
// Supabase (where the existing makeChain fixtures already cover).
beforeEach(() => {
  __resetAllForTests();
  __setDbForTests(null);
});

// Stand-in QueryClient that bypasses caching and runs the queryFn —
// `fetchFundDetail` now reads `user-funds` / `user-transactions` via
// `qc.fetchQuery`; tests still want every fetch to land on the supabase
// mock so the fixture-driven SQL paths stay exercised.
const fakeQc = {
  fetchQuery: <T,>({ queryFn }: { queryFn: () => Promise<T> }) => queryFn(),
} as unknown as QueryClient;

// ─── helpers ──────────────────────────────────────────────────────────────────

function pt(date: string) {
  return { date, value: Math.random() * 100 };
}

// Freeze time to 2024-06-15 for all tests
const FAKE_TODAY = new Date('2024-06-15T00:00:00.000Z');

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(FAKE_TODAY);
});

afterEach(() => {
  jest.useRealTimers();
});

// ─── All window ───────────────────────────────────────────────────────────────

describe("window = 'All'", () => {
  test('returns full array unchanged', () => {
    const history = [pt('2020-01-01'), pt('2021-01-01'), pt('2022-01-01')];
    expect(filterToWindow(history, 'All')).toEqual(history);
  });

  test('returns empty array when input is empty', () => {
    expect(filterToWindow([], 'All')).toEqual([]);
  });
});

// ─── Empty input ──────────────────────────────────────────────────────────────

describe('empty input', () => {
  const windows: TimeWindow[] = ['1M', '3M', '6M', '1Y', '3Y', '5Y', '10Y', '15Y', 'All'];
  test.each(windows)('returns [] for window %s', (w) => {
    expect(filterToWindow([], w)).toEqual([]);
  });
});

// ─── 1M window (cutoff: 2024-05-15) ──────────────────────────────────────────

describe("window = '1M'", () => {
  test('keeps only points within the last 1 month', () => {
    const history = [
      pt('2024-04-01'), // older than 1M → excluded
      pt('2024-05-15'), // exactly on cutoff → included
      pt('2024-05-20'), // within window → included
      pt('2024-06-14'), // within window → included
    ];
    const result = filterToWindow(history, '1M');
    expect(result.map((p) => p.date)).toEqual(['2024-05-15', '2024-05-20', '2024-06-14']);
  });

  test('falls back to full history when all data is older than 1M', () => {
    const history = [pt('2020-01-01'), pt('2021-01-01'), pt('2022-06-01')];
    const result = filterToWindow(history, '1M');
    expect(result).toEqual(history);
  });
});

// ─── 3M window (cutoff: 2024-03-15) ──────────────────────────────────────────

describe("window = '3M'", () => {
  test('keeps only points within the last 3 months', () => {
    const history = [
      pt('2024-02-01'), // older → excluded
      pt('2024-03-15'), // exactly on cutoff → included
      pt('2024-04-01'), // within → included
      pt('2024-06-10'), // within → included
    ];
    const result = filterToWindow(history, '3M');
    expect(result.map((p) => p.date)).toEqual(['2024-03-15', '2024-04-01', '2024-06-10']);
  });

  test('fallback when no data within 3M', () => {
    const history = [pt('2015-01-01'), pt('2016-06-01')];
    expect(filterToWindow(history, '3M')).toEqual(history);
  });
});

// ─── 6M window (cutoff: 2023-12-15) ──────────────────────────────────────────

describe("window = '6M'", () => {
  test('keeps only points within the last 6 months', () => {
    const history = [
      pt('2023-11-01'), // older → excluded
      pt('2023-12-15'), // cutoff → included
      pt('2024-03-01'), // within → included
    ];
    const result = filterToWindow(history, '6M');
    expect(result.map((p) => p.date)).toEqual(['2023-12-15', '2024-03-01']);
  });
});

// ─── 1Y window (cutoff: 2023-06-15) ──────────────────────────────────────────

describe("window = '1Y'", () => {
  test('keeps points from last 1 year', () => {
    const history = [
      pt('2022-01-01'), // excluded
      pt('2023-06-15'), // exactly on cutoff → included
      pt('2023-12-01'), // within → included
      pt('2024-06-01'), // within → included
    ];
    const result = filterToWindow(history, '1Y');
    expect(result.map((p) => p.date)).toEqual(['2023-06-15', '2023-12-01', '2024-06-01']);
  });

  test('fallback: stale data (all before 2023) returns full history', () => {
    const history = [pt('2013-01-01'), pt('2014-06-01'), pt('2015-12-31')];
    const result = filterToWindow(history, '1Y');
    expect(result).toEqual(history); // fallback, not empty
  });

  test('single data point within range → returns that point, not empty', () => {
    const history = [pt('2022-01-01'), pt('2024-01-01')];
    const result = filterToWindow(history, '1Y');
    expect(result.map((p) => p.date)).toEqual(['2024-01-01']);
  });
});

// ─── 3Y window (cutoff: 2021-06-15) ──────────────────────────────────────────

describe("window = '3Y'", () => {
  test('keeps points from last 3 years', () => {
    const history = [
      pt('2020-01-01'), // excluded
      pt('2021-06-15'), // cutoff → included
      pt('2022-06-01'),
      pt('2024-01-01'),
    ];
    const result = filterToWindow(history, '3Y');
    expect(result.map((p) => p.date)).toEqual(['2021-06-15', '2022-06-01', '2024-01-01']);
  });

  test('fallback: all data older than 3Y returns full history', () => {
    const history = [pt('2013-01-01'), pt('2015-06-01')];
    expect(filterToWindow(history, '3Y')).toEqual(history);
  });
});

// ─── Boundary conditions ──────────────────────────────────────────────────────

describe('boundary conditions', () => {
  test('point exactly on cutoff date is included (>= comparison)', () => {
    // 1Y cutoff = 2023-06-15. Point on exactly that date should be included.
    const history = [pt('2023-06-14'), pt('2023-06-15'), pt('2024-01-01')];
    const result = filterToWindow(history, '1Y');
    const dates = result.map((p) => p.date);
    expect(dates).toContain('2023-06-15');
    expect(dates).not.toContain('2023-06-14');
  });

  test('single point in history with 1Y window — returns that point', () => {
    const history = [pt('2024-01-01')];
    const result = filterToWindow(history, '1Y');
    expect(result).toHaveLength(1);
  });

  test('all points are recent — no filtering needed', () => {
    const history = [pt('2024-05-01'), pt('2024-05-15'), pt('2024-06-01')];
    expect(filterToWindow(history, '3Y')).toEqual(history);
  });

  test('result preserves original point objects (reference equality)', () => {
    const p1 = pt('2024-01-01');
    const p2 = pt('2024-05-01');
    const history = [p1, p2];
    const result = filterToWindow(history, '1Y');
    expect(result[0]).toBe(p1);
    expect(result[1]).toBe(p2);
  });

  test('does not mutate the input array', () => {
    const history = [pt('2022-01-01'), pt('2023-01-01'), pt('2024-01-01')];
    const copy = [...history];
    filterToWindow(history, '1Y');
    expect(history).toEqual(copy);
  });
});

// ─── Works with any T extends { date: string } ───────────────────────────────

describe('generic type compatibility', () => {
  test('works with objects that have extra fields', () => {
    const history = [
      { date: '2022-01-01', value: 100, extra: 'foo' },
      { date: '2024-01-01', value: 200, extra: 'bar' },
    ];
    const result = filterToWindow(history, '1Y');
    expect(result).toHaveLength(1);
    expect(result[0].extra).toBe('bar');
  });
});

// ─── indexTo100 ───────────────────────────────────────────────────────────────

describe('indexTo100', () => {
  test('empty array → []', () => {
    expect(indexTo100([])).toEqual([]);
  });

  test('first point base = 0 → returns array unchanged (avoids division by zero)', () => {
    const history = [
      { date: '2020-01-01', value: 0 },
      { date: '2020-02-01', value: 50 },
    ];
    expect(indexTo100(history)).toEqual(history);
  });

  test('single point → value becomes 100', () => {
    const result = indexTo100([{ date: '2020-01-01', value: 250 }]);
    expect(result).toHaveLength(1);
    expect(result[0].value).toBeCloseTo(100, 6);
  });

  test('standard series: first point = 100, others proportional', () => {
    const history = [
      { date: '2020-01-01', value: 200 }, // base
      { date: '2020-04-01', value: 240 }, // +20%
      { date: '2020-07-01', value: 180 }, // -10%
      { date: '2020-10-01', value: 300 }, // +50%
    ];
    const result = indexTo100(history);
    expect(result[0].value).toBeCloseTo(100, 6);
    expect(result[1].value).toBeCloseTo(120, 4);
    expect(result[2].value).toBeCloseTo(90, 4);
    expect(result[3].value).toBeCloseTo(150, 4);
  });

  test('series already starting at 100 stays unchanged', () => {
    const history = [
      { date: '2020-01-01', value: 100 },
      { date: '2020-06-01', value: 110 },
      { date: '2021-01-01', value: 95 },
    ];
    const result = indexTo100(history);
    expect(result[0].value).toBeCloseTo(100, 6);
    expect(result[1].value).toBeCloseTo(110, 6);
    expect(result[2].value).toBeCloseTo(95, 6);
  });

  test('dates are preserved unchanged', () => {
    const history = [
      { date: '2021-03-15', value: 500 },
      { date: '2022-09-01', value: 750 },
    ];
    const result = indexTo100(history);
    expect(result[0].date).toBe('2021-03-15');
    expect(result[1].date).toBe('2022-09-01');
  });

  test('does not mutate the input array', () => {
    const history = [
      { date: '2020-01-01', value: 200 },
      { date: '2020-06-01', value: 400 },
    ];
    const original = history.map((p) => ({ ...p }));
    indexTo100(history);
    expect(history).toEqual(original);
  });

  test('very small base value (avoids divide-by-near-zero distortion)', () => {
    const history = [
      { date: '2020-01-01', value: 0.001 },
      { date: '2020-06-01', value: 0.002 },
    ];
    const result = indexTo100(history);
    expect(result[0].value).toBeCloseTo(100, 4);
    expect(result[1].value).toBeCloseTo(200, 4);
  });

  test('large NAV values (₹1000+)', () => {
    const history = [
      { date: '2020-01-01', value: 1250 },
      { date: '2021-01-01', value: 1500 },
    ];
    const result = indexTo100(history);
    expect(result[0].value).toBeCloseTo(100, 4);
    expect(result[1].value).toBeCloseTo(120, 4);
  });
});

// ─── fetchFundDetail() ─────────────────────────────────────────────────────

function makeChain(response: { data: unknown; error: unknown }): any {
  const chain = {
    data: response.data,
    error: response.error,
    select: jest.fn(),
    eq: jest.fn(),
    in: jest.fn(),
    gte: jest.fn(),
    order: jest.fn(),
    range: jest.fn(),
    limit: jest.fn(),
    single: jest.fn(),
    maybeSingle: jest.fn(),
  };
  ['select', 'eq', 'in', 'gte', 'order'].forEach((m) =>
    (chain as Record<string, jest.Mock>)[m].mockReturnValue(chain),
  );
  // .range() is the terminal call for paginated reads — return a Promise
  // that resolves to the same response. paginateRangeQuery sees a short page
  // (data.length < pageSize) and stops after one round-trip.
  chain.range.mockImplementation(() => Promise.resolve(response));
  // .limit() is the terminal call for the light NAV fetch in
  // `fetchFundDetail`. Awaiting the chain itself resolves to the
  // response object (chain carries `data` / `error`), so returning
  // chain here is enough.
  chain.limit.mockReturnValue(chain);
  chain.single.mockReturnValue(response);
  chain.maybeSingle.mockReturnValue(response);
  return chain;
}

const mockFrom = supabase.from as jest.Mock;

const MOCK_FUND = {
  id: 'fund-1',
  user_id: 'user-1',
  scheme_code: 12345,
  scheme_name: 'Test Equity Fund',
  scheme_category: 'Equity',
  benchmark_index: 'Nifty 50',
  benchmark_index_symbol: '^NSEI',
  isin: null,
  expense_ratio: null,
  aum_cr: null,
  min_sip_amount: null,
  fund_meta_synced_at: null,
  is_active: true,
};
const MOCK_TXS = [
  { fund_id: 'fund-1', transaction_date: '2023-01-01', transaction_type: 'purchase', units: 100, amount: 10000 },
  { fund_id: 'fund-1', transaction_date: '2023-06-01', transaction_type: 'purchase', units: 50, amount: 6000 },
];
// `fetchFundDetail` now only requests the two most-recent NAV rows
// (`.order(desc).limit(2)`) for the header card; the full history lives
// behind `fetchFundNavHistory`. Fixtures are descending to match what
// the SELECT would return from PostgREST.
const MOCK_NAV = [
  { nav_date: '2024-01-01', nav: 140 },
  { nav_date: '2023-06-01', nav: 120 },
];

describe('fetchFundDetail()', () => {
  beforeEach(() => jest.clearAllMocks());

  test('returns null when fund is not in the shared user-funds cache', async () => {
    // fetchUserFunds returns an empty roster — caller asked for a fundId that
    // doesn't belong to this user.
    mockFrom.mockImplementation(() => makeChain({ data: [], error: null }));
    expect(await fetchFundDetail(fakeQc, 'user-1', 'missing-id')).toBeNull();
  });

  test('returns null when fund query returns no data', async () => {
    mockFrom.mockImplementation(() => makeChain({ data: null, error: null }));
    expect(await fetchFundDetail(fakeQc, 'user-1', 'fund-1')).toBeNull();
  });

  test('returns structured fund detail for a valid fund', async () => {
    mockFrom.mockImplementation((table: string) => {
      if (table === 'fund') return makeChain({ data: [MOCK_FUND], error: null });
      if (table === 'transaction') return makeChain({ data: MOCK_TXS, error: null });
      if (table === 'nav_history') return makeChain({ data: MOCK_NAV, error: null });
      return makeChain({ data: [], error: null });
    });

    const result = await fetchFundDetail(fakeQc, 'user-1', 'fund-1');
    expect(result).not.toBeNull();
    expect(result!.id).toBe('fund-1');
    expect(result!.schemeName).toBe('Test Equity Fund');
    expect(result!.currentNav).toBe(140);
    expect(result!.currentUnits).toBe(150);
    expect(result!.investedAmount).toBe(16000);
    expect(result!.currentValue).toBeCloseTo(150 * 140, 5);
    // `navHistory` is now just the two most-recent rows; the full history
    // is served by `fetchFundNavHistory`.
    expect(result!.navHistory).toHaveLength(2);
    expect(isFinite(result!.fundXirr)).toBe(true);
  });

  test('handles empty transaction list (zero units, NaN XIRR)', async () => {
    mockFrom.mockImplementation((table: string) => {
      if (table === 'fund') return makeChain({ data: [MOCK_FUND], error: null });
      if (table === 'transaction') return makeChain({ data: [], error: null });
      if (table === 'nav_history') return makeChain({ data: MOCK_NAV, error: null });
      return makeChain({ data: [], error: null });
    });
    const result = await fetchFundDetail(fakeQc, 'user-1', 'fund-1');
    expect(result!.currentUnits).toBe(0);
    expect(result!.currentValue).toBe(0);
    expect(result!.fundXirr).toBeNaN();
  });

  // ── Fix 7: fundXirr is a finite, distinct annualised metric ─────────────────
  // Window-based period-return comparisons against the benchmark are now
  // driven by `useFundNavHistory`'s full history, not `data.navHistory`.
  // This test just guards that the header-card XIRR survives the split.
  test('fundXirr is a finite number', async () => {
    mockFrom.mockImplementation((table: string) => {
      if (table === 'fund') return makeChain({ data: [MOCK_FUND], error: null });
      if (table === 'transaction') return makeChain({ data: MOCK_TXS, error: null });
      if (table === 'nav_history') return makeChain({ data: MOCK_NAV, error: null });
      return makeChain({ data: [], error: null });
    });
    const result = await fetchFundDetail(fakeQc, 'user-1', 'fund-1');
    expect(isFinite(result!.fundXirr)).toBe(true);
  });

  // ── Fix 8: gain/loss must be derivable from currentValue and investedAmount ──
  test('currentValue and investedAmount allow computing gain/loss', async () => {
    mockFrom.mockImplementation((table: string) => {
      if (table === 'fund') return makeChain({ data: [MOCK_FUND], error: null });
      if (table === 'transaction') return makeChain({ data: MOCK_TXS, error: null });
      if (table === 'nav_history') return makeChain({ data: MOCK_NAV, error: null });
      return makeChain({ data: [], error: null });
    });
    const result = await fetchFundDetail(fakeQc, 'user-1', 'fund-1');
    expect(result!.currentValue).not.toBeNull();
    const gain = result!.currentValue! - result!.investedAmount;
    const gainPct = (gain / result!.investedAmount) * 100;
    // 150 units * 140 NAV = 21000; invested = 16000; gain = +5000 (+31.25%)
    expect(gain).toBeCloseTo(5000, 0);
    expect(gainPct).toBeCloseTo(31.25, 0);
  });

  test('gain/loss is not computable (null) when currentValue is null (NAV pending)', async () => {
    mockFrom.mockImplementation((table: string) => {
      if (table === 'fund') return makeChain({ data: [MOCK_FUND], error: null });
      if (table === 'transaction') return makeChain({ data: MOCK_TXS, error: null });
      if (table === 'nav_history') return makeChain({ data: [], error: null }); // no NAV
      if (table === 'index_history') return makeChain({ data: [], error: null });
      return makeChain({ data: [], error: null });
    });
    const result = await fetchFundDetail(fakeQc, 'user-1', 'fund-1');
    expect(result!.currentValue).toBeNull();
    // gain cannot be computed — UI must handle null
    const gain = result!.currentValue !== null ? result!.currentValue - result!.investedAmount : null;
    expect(gain).toBeNull();
  });
});
