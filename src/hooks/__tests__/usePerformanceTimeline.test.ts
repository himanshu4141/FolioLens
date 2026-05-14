jest.mock('@tanstack/react-query', () => ({ useQuery: jest.fn() }));
jest.mock('@/src/lib/data/userFund', () => ({
  fundViewRepo: { from: jest.fn() },
}));
jest.mock('@/src/lib/data/navHistory', () => ({
  navHistoryRepo: { from: jest.fn() },
}));
jest.mock('@/src/lib/data/indexHistory', () => ({
  indexHistoryRepo: { from: jest.fn() },
}));

// eslint-disable-next-line import/first -- mocks must register before module imports
import {
  buildTimelineSeries,
  buildXAxisLabels,
  formatDateShort,
  fetchPerformanceTimeline,
  type TimelineEntry,
} from '../usePerformanceTimeline';
// eslint-disable-next-line import/first
import { fundViewRepo } from '@/src/lib/data/userFund';
// eslint-disable-next-line import/first
import { navHistoryRepo } from '@/src/lib/data/navHistory';
// eslint-disable-next-line import/first
import { indexHistoryRepo } from '@/src/lib/data/indexHistory';

// ---------------------------------------------------------------------------
// formatDateShort()
// ---------------------------------------------------------------------------

describe('formatDateShort()', () => {
  it('formats January', () => expect(formatDateShort('2024-01-15')).toBe("Jan '24"));
  it('formats December', () => expect(formatDateShort('2023-12-01')).toBe("Dec '23"));
  it('formats mid-year month', () => expect(formatDateShort('2022-07-04')).toBe("Jul '22"));
  it('trims year to last 2 digits', () => expect(formatDateShort('2000-06-01')).toBe("Jun '00"));
  it('single-digit month is padded in input', () => expect(formatDateShort('2024-03-31')).toBe("Mar '24"));
});

// ---------------------------------------------------------------------------
// buildXAxisLabels()
// ---------------------------------------------------------------------------

describe('buildXAxisLabels()', () => {
  it('returns empty array for empty dates', () => {
    expect(buildXAxisLabels([])).toHaveLength(0);
  });

  it('returns full formatted array when dates <= count', () => {
    const dates = ['2024-01-01', '2024-02-01', '2024-03-01'];
    const result = buildXAxisLabels(dates, 5);
    expect(result).toHaveLength(3);
    expect(result).toEqual(["Jan '24", "Feb '24", "Mar '24"]);
  });

  // Regression: previously returned only 5 strings for 60-point arrays,
  // causing gifted-charts to bunch all labels at the left.
  it('returns full-length array (one entry per date) when dates > count', () => {
    const dates = Array.from({ length: 60 }, (_, i) => {
      const d = new Date(2024, 0, i + 1);
      return d.toISOString().split('T')[0];
    });
    const result = buildXAxisLabels(dates, 5);
    expect(result).toHaveLength(60);
  });

  it('labels are evenly distributed — deduplicates same-month labels, no duplicates placed', () => {
    // 60 dates spanning Jan–Feb 2024. 5 evenly-spaced positions all land in Jan or Feb,
    // so deduplication correctly produces fewer than 5 labels (no point repeating "Jan '24").
    const dates = Array.from({ length: 60 }, (_, i) => {
      const d = new Date(2024, 0, i + 1);
      return d.toISOString().split('T')[0];
    });
    const result = buildXAxisLabels(dates, 5);
    expect(result).toHaveLength(60);
    const nonEmpty = result.filter((l) => l !== '');
    // Fewer labels than count because same-month positions are deduplicated
    expect(nonEmpty.length).toBeLessThan(5);
    // At least one label placed
    expect(nonEmpty.length).toBeGreaterThanOrEqual(1);
    // Last position must always be labeled
    expect(result[result.length - 1]).not.toBe('');
  });

  it('always labels the last position', () => {
    const dates = ['2024-01-01', '2024-03-01', '2024-05-01', '2024-07-01', '2024-09-01',
                   '2024-11-01', '2024-12-31'];
    const result = buildXAxisLabels(dates, 3);
    expect(result[result.length - 1]).toBe("Dec '24");
  });

  it('single date returns that date as a label', () => {
    const result = buildXAxisLabels(['2023-06-15'], 5);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe("Jun '23");
  });
});

// ---------------------------------------------------------------------------
// buildTimelineSeries()
// ---------------------------------------------------------------------------

function makeEntry(id: string, points: { date: string; value: number }[]): TimelineEntry {
  return { type: 'fund', id, name: id, history: points };
}

describe('buildTimelineSeries()', () => {
  it('returns empty when ids is empty', () => {
    const entries = [makeEntry('a', [{ date: '2023-01-01', value: 100 }])];
    const result = buildTimelineSeries(entries, [], 'All');
    expect(result.points).toHaveLength(0);
    expect(result.dates).toHaveLength(0);
  });

  it('returns empty when entries is empty', () => {
    const result = buildTimelineSeries([], ['a'], 'All');
    expect(result.points).toHaveLength(0);
  });

  it('single series — first point is always 0% return', () => {
    const history = [
      { date: '2023-01-01', value: 100 },
      { date: '2023-06-01', value: 120 },
      { date: '2024-01-01', value: 150 },
    ];
    const { points } = buildTimelineSeries([makeEntry('a', history)], ['a'], 'All');
    expect(points).toHaveLength(1);
    expect(points[0][0].value).toBeCloseTo(0, 5);     // 100/100 - 1 = 0%
    expect(points[0][1].value).toBeCloseTo(20, 5);    // 120/100 - 1 = 20%
    expect(points[0][2].value).toBeCloseTo(50, 5);    // 150/100 - 1 = 50%
  });

  it('two series share the same date array and are both indexed to 0 at start', () => {
    const historyA = [
      { date: '2023-01-01', value: 200 },
      { date: '2023-06-01', value: 240 },
    ];
    const historyB = [
      { date: '2023-01-01', value: 50 },
      { date: '2023-06-01', value: 60 },
    ];
    const entries = [makeEntry('a', historyA), makeEntry('b', historyB)];
    const { points, dates } = buildTimelineSeries(entries, ['a', 'b'], 'All');
    expect(points).toHaveLength(2);
    expect(dates).toHaveLength(2);
    expect(points[0][0].value).toBeCloseTo(0, 5);
    expect(points[1][0].value).toBeCloseTo(0, 5);
    expect(points[0][1].value).toBeCloseTo(20, 5);    // a: +20%
    expect(points[1][1].value).toBeCloseTo(20, 5);    // b: +20%
  });

  it('only includes dates where ALL series have data', () => {
    const historyA = [
      { date: '2023-01-01', value: 100 },
      { date: '2023-03-01', value: 110 }, // only A has this date
      { date: '2023-06-01', value: 120 },
    ];
    const historyB = [
      { date: '2023-01-01', value: 50 },
      { date: '2023-06-01', value: 60 },
    ];
    const { dates } = buildTimelineSeries(
      [makeEntry('a', historyA), makeEntry('b', historyB)],
      ['a', 'b'],
      'All',
    );
    // 2023-03-01 only in A — excluded
    expect(dates.includes('2023-03-01')).toBe(false);
    expect(dates.includes('2023-01-01')).toBe(true);
    expect(dates.includes('2023-06-01')).toBe(true);
  });

  it('samples to ≤61 points for long series', () => {
    // The sampler always includes the last point even when not on a step boundary,
    // so output length is ≤61 (step * 60 indices + possible last index).
    const history = Array.from({ length: 300 }, (_, i) => {
      const d = new Date(2020, 0, i + 1);
      return { date: d.toISOString().split('T')[0], value: 100 + i };
    });
    const { points, dates } = buildTimelineSeries([makeEntry('a', history)], ['a'], 'All');
    expect(dates.length).toBeLessThanOrEqual(61);
    expect(points[0].length).toBeLessThanOrEqual(61);
  });

  it('falls back to full history when time window excludes all data (stale data)', () => {
    // filterToWindow falls back to full history when the filtered result is empty —
    // this prevents blank charts on stale NAV data.
    const oldHistory = [
      { date: '2010-01-01', value: 100 },
      { date: '2010-06-01', value: 110 },
    ];
    const { points, dates } = buildTimelineSeries([makeEntry('a', oldHistory)], ['a'], '1M');
    // No data within 1M window → fallback returns full history → chart has data
    expect(dates.length).toBeGreaterThan(0);
    expect(points.length).toBeGreaterThan(0);
  });

  it('ids order controls series order in output', () => {
    const historyA = [{ date: '2023-01-01', value: 100 }, { date: '2023-06-01', value: 200 }];
    const historyB = [{ date: '2023-01-01', value: 50 }, { date: '2023-06-01', value: 55 }];
    const entries = [makeEntry('a', historyA), makeEntry('b', historyB)];

    const { points: pointsAB } = buildTimelineSeries(entries, ['a', 'b'], 'All');
    const { points: pointsBA } = buildTimelineSeries(entries, ['b', 'a'], 'All');

    // A: +100% at end; B: +10% at end
    expect(pointsAB[0][1].value).toBeCloseTo(100, 5);
    expect(pointsAB[1][1].value).toBeCloseTo(10, 5);

    // Reversed order
    expect(pointsBA[0][1].value).toBeCloseTo(10, 5);
    expect(pointsBA[1][1].value).toBeCloseTo(100, 5);
  });
});

// ---------------------------------------------------------------------------
// fetchPerformanceTimeline()
// ---------------------------------------------------------------------------

function makeChain(response: { data: unknown; error: unknown }): any {
  const chain: Record<string, unknown> = {
    data: response.data,
    error: response.error,
    select: jest.fn(),
    eq: jest.fn(),
    in: jest.fn(),
    order: jest.fn(),
    limit: jest.fn(),
    single: jest.fn(),
    maybeSingle: jest.fn(),
  };
  ['select', 'eq', 'in', 'order', 'limit'].forEach((m) =>
    (chain[m] as jest.Mock).mockReturnValue(chain),
  );
  (chain.single as jest.Mock).mockReturnValue(response);
  (chain.maybeSingle as jest.Mock).mockReturnValue(response);
  return chain;
}

const fundFrom = fundViewRepo.from as jest.Mock;
const navFrom = navHistoryRepo.from as jest.Mock;
const idxFrom = indexHistoryRepo.from as jest.Mock;

// All-repos mock — `mockFrom` (kept under its old name to minimise diff)
// still receives the most-recent mock when callers do
// `mockFrom.mockImplementation((table) => ...)`.
const mockFrom = {
  // Lets tests still call `expect(mockFrom).not.toHaveBeenCalled()` — true
  // when none of the three repo `from()` mocks have been invoked.
  toHaveBeenCalled: undefined,
  mockImplementation(fn: (table: string) => unknown) {
    fundFrom.mockImplementation(() => fn('fund'));
    navFrom.mockImplementation(() => fn('nav_history'));
    idxFrom.mockImplementation(() => fn('index_history'));
  },
};

function repoCallCount() {
  return fundFrom.mock.calls.length + navFrom.mock.calls.length + idxFrom.mock.calls.length;
}

const FUND_ROWS = [{ id: 'f1', scheme_code: 100, scheme_name: 'Fund A' }];
const NAV_ROWS = [
  { scheme_code: 100, nav_date: '2023-01-01', nav: 10 },
  { scheme_code: 100, nav_date: '2023-06-01', nav: 12 },
];
const IDX_ROWS = [
  { index_symbol: '^NSEI', index_date: '2023-01-01', close_value: 17000 },
  { index_symbol: '^NSEI', index_date: '2023-06-01', close_value: 18000 },
];

describe('fetchPerformanceTimeline()', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns empty entries when both fundItems and indexItems are empty', async () => {
    const result = await fetchPerformanceTimeline([], []);
    expect(result.entries).toHaveLength(0);
    expect(repoCallCount()).toBe(0);
  });

  it('fetches fund NAV history and returns timeline entries', async () => {
    mockFrom.mockImplementation((table: string) => {
      if (table === 'fund') return makeChain({ data: FUND_ROWS, error: null });
      if (table === 'nav_history') return makeChain({ data: NAV_ROWS, error: null });
      return makeChain({ data: [], error: null });
    });
    const result = await fetchPerformanceTimeline(
      [{ id: 'f1', name: 'Fund A' }], [],
    );
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].type).toBe('fund');
    expect(result.entries[0].id).toBe('f1');
    expect(result.entries[0].history).toHaveLength(2);
  });

  it('throws when fund query errors', async () => {
    mockFrom.mockImplementation(() =>
      makeChain({ data: null, error: { message: 'db error' } }),
    );
    await expect(
      fetchPerformanceTimeline([{ id: 'f1', name: 'Fund A' }], []),
    ).rejects.toEqual({ message: 'db error' });
  });

  it('throws when nav_history query errors', async () => {
    mockFrom.mockImplementation((table: string) => {
      if (table === 'fund') return makeChain({ data: FUND_ROWS, error: null });
      return makeChain({ data: null, error: { message: 'nav error' } });
    });
    await expect(
      fetchPerformanceTimeline([{ id: 'f1', name: 'Fund A' }], []),
    ).rejects.toEqual({ message: 'nav error' });
  });

  it('skips fund entry when scheme_code not found in NAV results', async () => {
    const fundsWithDifferentCode = [{ id: 'f1', scheme_code: 999, scheme_name: 'Fund A' }];
    mockFrom.mockImplementation((table: string) => {
      if (table === 'fund') return makeChain({ data: fundsWithDifferentCode, error: null });
      if (table === 'nav_history') return makeChain({ data: NAV_ROWS, error: null });
      return makeChain({ data: [], error: null });
    });
    const result = await fetchPerformanceTimeline(
      [{ id: 'f1', name: 'Fund A' }], [],
    );
    // fund f1's scheme_code (999) has no NAV rows → history is empty array
    expect(result.entries[0].history).toHaveLength(0);
  });

  it('skips fund item when fund is not found in DB results', async () => {
    mockFrom.mockImplementation((table: string) => {
      if (table === 'fund') return makeChain({ data: FUND_ROWS, error: null });
      if (table === 'nav_history') return makeChain({ data: NAV_ROWS, error: null });
      return makeChain({ data: [], error: null });
    });
    // Request fund 'f-missing' which is not in FUND_ROWS
    const result = await fetchPerformanceTimeline(
      [{ id: 'f-missing', name: 'Ghost Fund' }], [],
    );
    expect(result.entries).toHaveLength(0);
  });

  it('handles funds returning null/empty gracefully', async () => {
    mockFrom.mockImplementation((table: string) => {
      if (table === 'fund') return makeChain({ data: null, error: null });
      return makeChain({ data: null, error: null });
    });
    const result = await fetchPerformanceTimeline(
      [{ id: 'f1', name: 'Fund A' }], [],
    );
    expect(result.entries).toHaveLength(0);
  });

  it('fetches index history and returns index entries', async () => {
    mockFrom.mockImplementation((table: string) => {
      if (table === 'index_history') return makeChain({ data: IDX_ROWS, error: null });
      return makeChain({ data: [], error: null });
    });
    const result = await fetchPerformanceTimeline(
      [], [{ symbol: '^NSEI', name: 'Nifty 50' }],
    );
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].type).toBe('index');
    expect(result.entries[0].id).toBe('^NSEI');
    expect(result.entries[0].history).toHaveLength(2);
  });

  it('throws when index_history query errors', async () => {
    mockFrom.mockImplementation(() =>
      makeChain({ data: null, error: { message: 'idx error' } }),
    );
    await expect(
      fetchPerformanceTimeline([], [{ symbol: '^NSEI', name: 'Nifty 50' }]),
    ).rejects.toEqual({ message: 'idx error' });
  });

  it('returns empty history for index with no matching rows', async () => {
    mockFrom.mockImplementation(() =>
      makeChain({ data: IDX_ROWS, error: null }),
    );
    const result = await fetchPerformanceTimeline(
      [], [{ symbol: '^BSE500', name: 'BSE 500' }],
    );
    expect(result.entries[0].history).toHaveLength(0);
  });

  it('combines fund and index entries in one call', async () => {
    mockFrom.mockImplementation((table: string) => {
      if (table === 'fund') return makeChain({ data: FUND_ROWS, error: null });
      if (table === 'nav_history') return makeChain({ data: NAV_ROWS, error: null });
      if (table === 'index_history') return makeChain({ data: IDX_ROWS, error: null });
      return makeChain({ data: [], error: null });
    });
    const result = await fetchPerformanceTimeline(
      [{ id: 'f1', name: 'Fund A' }],
      [{ symbol: '^NSEI', name: 'Nifty 50' }],
    );
    expect(result.entries).toHaveLength(2);
    expect(result.entries[0].type).toBe('fund');
    expect(result.entries[1].type).toBe('index');
  });
});
