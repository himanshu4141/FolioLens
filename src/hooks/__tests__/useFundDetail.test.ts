/**
 * Tests for filterToWindow — date-based windowing with stale-data fallback.
 *
 * Note: These tests freeze "today" by mocking Date so the cutoff calculations
 * are deterministic regardless of when the tests are run.
 */

import { filterToWindow, indexTo100, type TimeWindow } from '@/src/utils/navUtils';
import { fetchFundDetail } from '@/src/hooks/useFundDetail';
import { supabase } from '@/src/lib/supabase';
import { fetchCachedIndexRows, fetchCachedNavRows } from '@/src/lib/referenceDataCache';

jest.mock('@tanstack/react-query', () => ({ useQuery: jest.fn() }));
jest.mock('@/src/lib/supabase', () => ({ supabase: { from: jest.fn() } }));
jest.mock('@/src/lib/referenceDataCache', () => ({
  REFERENCE_HISTORY_START_DATE: '1900-01-01',
  REFERENCE_QUERY_GC_TIME_MS: 86_400_000,
  REFERENCE_QUERY_STALE_TIME_MS: 1_800_000,
  fetchCachedIndexRows: jest.fn(),
  fetchCachedNavRows: jest.fn(),
}));

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
  chain.single.mockReturnValue(response);
  chain.maybeSingle.mockReturnValue(response);
  return chain;
}

const mockFrom = supabase.from as jest.Mock;
const mockFetchCachedIndexRows = fetchCachedIndexRows as jest.MockedFunction<typeof fetchCachedIndexRows>;
const mockFetchCachedNavRows = fetchCachedNavRows as jest.MockedFunction<typeof fetchCachedNavRows>;

const MOCK_FUND = {
  id: 'fund-1', scheme_code: 12345, scheme_name: 'Test Equity Fund',
  scheme_category: 'Equity', benchmark_index: 'Nifty 50', benchmark_index_symbol: '^NSEI',
};
const MOCK_TXS = [
  { transaction_date: '2023-01-01', transaction_type: 'purchase', units: 100, amount: 10000 },
  { transaction_date: '2023-06-01', transaction_type: 'purchase', units: 50, amount: 6000 },
];
const MOCK_NAV = [
  { nav_date: '2023-01-01', nav: 100 },
  { nav_date: '2023-06-01', nav: 120 },
  { nav_date: '2024-01-01', nav: 140 },
];
const MOCK_INDEX = [
  { index_date: '2023-01-01', close_value: 17000 },
  { index_date: '2024-01-01', close_value: 21000 },
];

describe('fetchFundDetail()', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFetchCachedNavRows.mockImplementation(async () => {
      const response = mockFrom('nav_history') as { data?: unknown };
      return ((response.data ?? []) as { nav_date: string; nav: number }[]).map((row) => ({
        scheme_code: MOCK_FUND.scheme_code,
        nav_date: row.nav_date,
        nav: row.nav,
      }));
    });
    mockFetchCachedIndexRows.mockImplementation(async () => {
      const response = mockFrom('index_history') as { data?: unknown };
      return (response.data ?? []) as Awaited<ReturnType<typeof fetchCachedIndexRows>>;
    });
  });

  test('returns null when fund is not found', async () => {
    mockFrom.mockImplementation(() => makeChain({ data: null, error: { message: 'not found' } }));
    expect(await fetchFundDetail('missing-id')).toBeNull();
  });

  test('returns null when fund query returns no data', async () => {
    mockFrom.mockImplementation(() => makeChain({ data: null, error: null }));
    expect(await fetchFundDetail('fund-1')).toBeNull();
  });

  test('returns structured fund detail for a valid fund', async () => {
    mockFrom.mockImplementation((table: string) => {
      if (table === 'fund') return makeChain({ data: MOCK_FUND, error: null });
      if (table === 'transaction') return makeChain({ data: MOCK_TXS, error: null });
      if (table === 'nav_history') return makeChain({ data: MOCK_NAV, error: null });
      if (table === 'index_history') return makeChain({ data: MOCK_INDEX, error: null });
      return makeChain({ data: [], error: null });
    });

    const result = await fetchFundDetail('fund-1');
    expect(result).not.toBeNull();
    expect(result!.id).toBe('fund-1');
    expect(result!.schemeName).toBe('Test Equity Fund');
    expect(result!.currentNav).toBe(140);
    expect(result!.currentUnits).toBe(150);
    expect(result!.investedAmount).toBe(16000);
    expect(result!.currentValue).toBeCloseTo(150 * 140, 5);
    expect(result!.navHistory).toHaveLength(3);
    expect(result!.indexHistory).toHaveLength(2);
    expect(isFinite(result!.fundXirr)).toBe(true);
  });

  test('returns empty indexHistory when fund has no benchmark symbol', async () => {
    const fundWithoutBenchmark = { ...MOCK_FUND, benchmark_index_symbol: null };
    mockFrom.mockImplementation((table: string) => {
      if (table === 'fund') return makeChain({ data: fundWithoutBenchmark, error: null });
      if (table === 'transaction') return makeChain({ data: MOCK_TXS, error: null });
      if (table === 'nav_history') return makeChain({ data: MOCK_NAV, error: null });
      return makeChain({ data: [], error: null });
    });
    const result = await fetchFundDetail('fund-1');
    expect(result!.indexHistory).toHaveLength(0);
  });

  test('handles empty transaction list (zero units, NaN XIRR)', async () => {
    mockFrom.mockImplementation((table: string) => {
      if (table === 'fund') return makeChain({ data: MOCK_FUND, error: null });
      if (table === 'transaction') return makeChain({ data: [], error: null });
      if (table === 'nav_history') return makeChain({ data: MOCK_NAV, error: null });
      if (table === 'index_history') return makeChain({ data: MOCK_INDEX, error: null });
      return makeChain({ data: [], error: null });
    });
    const result = await fetchFundDetail('fund-1');
    expect(result!.currentUnits).toBe(0);
    expect(result!.currentValue).toBe(0);
    expect(result!.fundXirr).toBeNaN();
  });

  // ── Fix 7: period return comparison must use navHistory, not XIRR ────────────
  // PerformanceTab now shows navReturn / benchmarkReturn (window-scoped NAV returns)
  // rather than XIRR. These tests verify the hook provides the raw data needed for
  // that comparison and that fundXirr is separate from the window-based returns.
  test('fundXirr is a finite number separate from window-based NAV return', async () => {
    mockFrom.mockImplementation((table: string) => {
      if (table === 'fund') return makeChain({ data: MOCK_FUND, error: null });
      if (table === 'transaction') return makeChain({ data: MOCK_TXS, error: null });
      if (table === 'nav_history') return makeChain({ data: MOCK_NAV, error: null });
      if (table === 'index_history') return makeChain({ data: MOCK_INDEX, error: null });
      return makeChain({ data: [], error: null });
    });
    const result = await fetchFundDetail('fund-1');
    // fundXirr: SIP-adjusted annualised — will be a finite number for valid cashflows
    expect(isFinite(result!.fundXirr)).toBe(true);
    // navHistory provides the raw data for window-based period returns
    // Start: 100, End: 140 → period return = +40% for the 'All' window
    const start = result!.navHistory[0].value;
    const end = result!.navHistory[result!.navHistory.length - 1].value;
    const periodReturn = ((end - start) / start) * 100;
    expect(periodReturn).toBeCloseTo(40, 0); // +40% period NAV return
    // They are different metrics — XIRR ≠ simple period return
    expect(result!.fundXirr * 100).not.toBeCloseTo(periodReturn, 0);
  });

  // ── Fix 8: gain/loss must be derivable from currentValue and investedAmount ──
  test('currentValue and investedAmount allow computing gain/loss', async () => {
    mockFrom.mockImplementation((table: string) => {
      if (table === 'fund') return makeChain({ data: MOCK_FUND, error: null });
      if (table === 'transaction') return makeChain({ data: MOCK_TXS, error: null });
      if (table === 'nav_history') return makeChain({ data: MOCK_NAV, error: null });
      if (table === 'index_history') return makeChain({ data: MOCK_INDEX, error: null });
      return makeChain({ data: [], error: null });
    });
    const result = await fetchFundDetail('fund-1');
    expect(result!.currentValue).not.toBeNull();
    const gain = result!.currentValue! - result!.investedAmount;
    const gainPct = (gain / result!.investedAmount) * 100;
    // 150 units * 140 NAV = 21000; invested = 16000; gain = +5000 (+31.25%)
    expect(gain).toBeCloseTo(5000, 0);
    expect(gainPct).toBeCloseTo(31.25, 0);
  });

  test('gain/loss is not computable (null) when currentValue is null (NAV pending)', async () => {
    mockFrom.mockImplementation((table: string) => {
      if (table === 'fund') return makeChain({ data: MOCK_FUND, error: null });
      if (table === 'transaction') return makeChain({ data: MOCK_TXS, error: null });
      if (table === 'nav_history') return makeChain({ data: [], error: null }); // no NAV
      if (table === 'index_history') return makeChain({ data: [], error: null });
      return makeChain({ data: [], error: null });
    });
    const result = await fetchFundDetail('fund-1');
    expect(result!.currentValue).toBeNull();
    // gain cannot be computed — UI must handle null
    const gain = result!.currentValue !== null ? result!.currentValue - result!.investedAmount : null;
    expect(gain).toBeNull();
  });
});
