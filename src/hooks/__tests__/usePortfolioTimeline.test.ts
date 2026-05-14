jest.mock('@tanstack/react-query', () => ({ useQuery: jest.fn() }));
jest.mock('@/src/lib/data/navHistory', () => ({
  navHistoryRepo: { from: jest.fn() },
}));
jest.mock('@/src/lib/data/transaction', () => ({
  transactionRepo: { from: jest.fn() },
}));
jest.mock('@/src/lib/data/indexHistory', () => ({
  indexHistoryRepo: { from: jest.fn() },
}));
jest.mock('@/src/hooks/usePerformanceTimeline', () => ({
  buildXAxisLabels: (dates: string[]) => dates.map(() => ''),
  formatDateShort: (d: string) => d,
}));

// eslint-disable-next-line import/first -- mocks must register before module imports
import { computePortfolioTimeline, fetchPortfolioTimeline } from '../usePortfolioTimeline';
// eslint-disable-next-line import/first
import { navHistoryRepo } from '@/src/lib/data/navHistory';
// eslint-disable-next-line import/first
import { transactionRepo } from '@/src/lib/data/transaction';
// eslint-disable-next-line import/first
import { indexHistoryRepo } from '@/src/lib/data/indexHistory';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeChain(response: { data: unknown; error: unknown }): any {
  const chain = {
    data: response.data,
    error: response.error,
    select: jest.fn(),
    eq: jest.fn(),
    in: jest.fn(),
    order: jest.fn(),
    limit: jest.fn(),
  };
  ['select', 'eq', 'in', 'order', 'limit'].forEach((m) =>
    (chain as Record<string, jest.Mock>)[m].mockReturnValue(chain),
  );
  return chain;
}

const navFrom = navHistoryRepo.from as jest.Mock;
const txFrom = transactionRepo.from as jest.Mock;
const idxFrom = indexHistoryRepo.from as jest.Mock;

// Build a sequence of NAV dates starting from a base date
function navDates(startDate: string, count: number): string[] {
  const dates: string[] = [];
  const d = new Date(startDate);
  for (let i = 0; i < count; i++) {
    dates.push(d.toISOString().split('T')[0]);
    d.setDate(d.getDate() + 1);
  }
  return dates;
}

// ---------------------------------------------------------------------------
// computePortfolioTimeline — pure function tests
// ---------------------------------------------------------------------------

describe('computePortfolioTimeline', () => {
  const FUND = { id: 'fund-1', schemeCode: 100 };

  it('returns empty when no funds', () => {
    const result = computePortfolioTimeline([], [], [], [], '1Y');
    expect(result.portfolioPoints).toHaveLength(0);
    expect(result.benchmarkPoints).toHaveLength(0);
  });

  it('returns empty when no nav data', () => {
    const result = computePortfolioTimeline([], [], [], [FUND], '1Y');
    expect(result.portfolioPoints).toHaveLength(0);
  });

  it('single fund: 100 units bought day 0, NAV doubles → portfolio value doubles, indexed to 200', () => {
    const dates = navDates('2024-01-01', 5);
    const navRows = dates.map((d, i) => ({ scheme_code: 100, nav_date: d, nav: 10 + i * 2 }));
    // NAVs: 10, 12, 14, 16, 18
    const txRows = [{ fund_id: 'fund-1', transaction_date: '2024-01-01', transaction_type: 'purchase', units: 100 }];
    const idxRows = dates.map((d, i) => ({ index_date: d, close_value: 1000 + i * 100 }));

    const result = computePortfolioTimeline(navRows, txRows, idxRows, [FUND], 'All');

    expect(result.portfolioPoints.length).toBeGreaterThan(0);
    // First point: 100 units × nav 10 = 1000, indexed to 100
    expect(result.portfolioPoints[0].value).toBeCloseTo(100);
    // Last point: 100 units × nav 18 = 1800, indexed to 180
    expect(result.portfolioPoints[result.portfolioPoints.length - 1].value).toBeCloseTo(180);
    // Benchmark: 1000 → 1400 over 5 days indexed to 100 → 140
    expect(result.benchmarkPoints[0].value).toBeCloseTo(100);
    expect(result.benchmarkPoints[result.benchmarkPoints.length - 1].value).toBeCloseTo(140);
  });

  it('partial sell reduces portfolio value correctly', () => {
    const dates = navDates('2024-01-01', 4);
    // NAV stays constant at 10 throughout for simplicity
    const navRows = dates.map((d) => ({ scheme_code: 100, nav_date: d, nav: 10 }));
    const txRows = [
      { fund_id: 'fund-1', transaction_date: '2024-01-01', transaction_type: 'purchase', units: 100 },
      { fund_id: 'fund-1', transaction_date: '2024-01-03', transaction_type: 'redemption', units: 50 },
    ];
    const idxRows = dates.map((d) => ({ index_date: d, close_value: 1000 }));

    const result = computePortfolioTimeline(navRows, txRows, idxRows, [FUND], 'All');

    // Before sell (day 1 and 2): 100 units × 10 = 1000, after sell (day 3 and 4): 50 × 10 = 500
    // Day 1 value: 1000, indexed to 100
    expect(result.portfolioPoints[0].value).toBeCloseTo(100);
    // Day 3 (after sell): 50 × 10 = 500, indexed to 50 (relative to start of 1000)
    const lastPt = result.portfolioPoints[result.portfolioPoints.length - 1];
    expect(lastPt.value).toBeCloseTo(50);
  });

  it('excludes failed-payment reversal pairs from portfolio value history', () => {
    const dates = navDates('2025-10-09', 3);
    const navRows = dates.map((d) => ({ scheme_code: 100, nav_date: d, nav: 230 }));
    const txRows = [
      {
        fund_id: 'fund-1',
        transaction_date: '2025-10-09',
        transaction_type: 'redemption',
        units: 0,
        amount: 25000,
      },
      {
        fund_id: 'fund-1',
        transaction_date: '2025-10-09',
        transaction_type: 'purchase',
        units: 101.12,
        amount: 25000,
      },
    ];
    const idxRows = dates.map((d) => ({ index_date: d, close_value: 1000 }));

    const result = computePortfolioTimeline(navRows, txRows, idxRows, [FUND], 'All');

    expect(result.portfolioPoints).toHaveLength(0);
    expect(result.benchmarkPoints).toHaveLength(0);
  });

  it('no portfolio value before first purchase', () => {
    const dates = navDates('2024-01-01', 5);
    const navRows = dates.map((d, i) => ({ scheme_code: 100, nav_date: d, nav: 10 + i }));
    // Purchase on day 3 only
    const txRows = [{ fund_id: 'fund-1', transaction_date: '2024-01-04', transaction_type: 'purchase', units: 100 }];
    const idxRows = dates.map((d) => ({ index_date: d, close_value: 1000 }));

    const result = computePortfolioTimeline(navRows, txRows, idxRows, [FUND], 'All');

    // Only dates from Jan 4 onwards should appear (units > 0 only after purchase)
    expect(result.portfolioPoints.length).toBeGreaterThan(0);
    expect(result.portfolioPoints[0].date >= '2024-01-04').toBe(true);
  });

  it('two funds: values from both are summed correctly', () => {
    const FUND2 = { id: 'fund-2', schemeCode: 200 };
    const dates = navDates('2024-01-01', 3);
    const navRows = [
      ...dates.map((d) => ({ scheme_code: 100, nav_date: d, nav: 10 })),
      ...dates.map((d) => ({ scheme_code: 200, nav_date: d, nav: 20 })),
    ];
    const txRows = [
      { fund_id: 'fund-1', transaction_date: '2024-01-01', transaction_type: 'purchase', units: 100 },
      { fund_id: 'fund-2', transaction_date: '2024-01-01', transaction_type: 'purchase', units: 50 },
    ];
    const idxRows = dates.map((d) => ({ index_date: d, close_value: 1000 }));

    const result = computePortfolioTimeline(navRows, txRows, idxRows, [FUND, FUND2], 'All');

    // Total value: 100×10 + 50×20 = 1000 + 1000 = 2000 on every date (navs constant)
    // Indexed: all points at 100
    expect(result.portfolioPoints.length).toBeGreaterThan(0);
    for (const pt of result.portfolioPoints) {
      expect(pt.value).toBeCloseTo(100);
    }
  });

  it('both series start at exactly 100', () => {
    const dates = navDates('2024-01-01', 10);
    const navRows = dates.map((d, i) => ({ scheme_code: 100, nav_date: d, nav: 10 + i }));
    const txRows = [{ fund_id: 'fund-1', transaction_date: '2024-01-01', transaction_type: 'purchase', units: 100 }];
    const idxRows = dates.map((d, i) => ({ index_date: d, close_value: 1000 + i * 50 }));

    const result = computePortfolioTimeline(navRows, txRows, idxRows, [FUND], 'All');

    expect(result.portfolioPoints[0].value).toBeCloseTo(100);
    expect(result.benchmarkPoints[0].value).toBeCloseTo(100);
  });

  it('empty schemeCodes → returns empty arrays', () => {
    const result = computePortfolioTimeline([], [], [], [], 'All');
    expect(result.portfolioPoints).toHaveLength(0);
    expect(result.benchmarkPoints).toHaveLength(0);
    expect(result.xAxisLabels).toHaveLength(0);
  });

  it('window filter: only data within the window is included', () => {
    // Create nav data spanning 3 years but only ask for 1Y
    const threeYearsAgo = new Date();
    threeYearsAgo.setFullYear(threeYearsAgo.getFullYear() - 3);
    const oneYearAgo = new Date();
    oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
    const oneYearAgoStr = oneYearAgo.toISOString().split('T')[0];

    // 5 quarterly NAV dates spanning 3 years
    const dates = [
      new Date(threeYearsAgo.getTime()),
      new Date(threeYearsAgo.getTime() + 365 * 24 * 3600 * 1000),
      new Date(threeYearsAgo.getTime() + 2 * 365 * 24 * 3600 * 1000),
      new Date(), // today
    ].map((d) => d.toISOString().split('T')[0]);

    const navRows = dates.map((d, i) => ({ scheme_code: 100, nav_date: d, nav: 10 + i }));
    const txRows = [{ fund_id: 'fund-1', transaction_date: dates[0], transaction_type: 'purchase', units: 100 }];
    const idxRows = dates.map((d, i) => ({ index_date: d, close_value: 1000 + i * 100 }));

    const result = computePortfolioTimeline(navRows, txRows, idxRows, [FUND], '1Y');

    // All portfolio points should be within the 1Y window
    for (const pt of result.portfolioPoints) {
      expect(pt.date >= oneYearAgoStr).toBe(true);
    }
  });

  it('ignores transactions for funds not in the funds list', () => {
    const dates = navDates('2024-01-01', 3);
    const navRows = dates.map((d) => ({ scheme_code: 100, nav_date: d, nav: 10 }));
    const txRows = [
      { fund_id: 'fund-1', transaction_date: '2024-01-01', transaction_type: 'purchase', units: 100 },
      // fund-99 is NOT in the funds list
      { fund_id: 'fund-99', transaction_date: '2024-01-01', transaction_type: 'purchase', units: 999 },
    ];
    const idxRows = dates.map((d) => ({ index_date: d, close_value: 1000 }));

    const result = computePortfolioTimeline(navRows, txRows, idxRows, [FUND], 'All');
    // Should use only fund-1's 100 units, not the 999 from fund-99
    // Portfolio value: 100 × 10 = 1000, indexed to 100
    expect(result.portfolioPoints[0].value).toBeCloseTo(100);
  });
});

// ---------------------------------------------------------------------------
// fetchPortfolioTimeline — integration with Supabase mock
// ---------------------------------------------------------------------------

describe('fetchPortfolioTimeline', () => {
  const FUNDS = [{ id: 'fund-1', schemeCode: 100 }];
  const dates = navDates('2024-01-01', 3);

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns computed result when all fetches succeed', async () => {
    const navChain = makeChain({
      data: dates.map((d, i) => ({ scheme_code: 100, nav_date: d, nav: 10 + i })),
      error: null,
    });
    const txChain = makeChain({
      data: [{ fund_id: 'fund-1', transaction_date: '2024-01-01', transaction_type: 'purchase', units: 100 }],
      error: null,
    });
    const idxChain = makeChain({
      data: dates.map((d, i) => ({ index_date: d, close_value: 1000 + i * 100 })),
      error: null,
    });

    navFrom.mockReturnValue(navChain);
    txFrom.mockReturnValue(txChain);
    idxFrom.mockReturnValue(idxChain);

    const result = await fetchPortfolioTimeline(FUNDS, 'user-1', '^NSEI', 'All');
    expect(result.portfolioPoints.length).toBeGreaterThan(0);
    expect(result.portfolioPoints[0].value).toBeCloseTo(100);
  });

  it('throws when nav_history fetch fails', async () => {
    const navChain = makeChain({ data: null, error: new Error('nav fetch failed') });
    const txChain = makeChain({ data: [], error: null });
    const idxChain = makeChain({ data: [], error: null });

    navFrom.mockReturnValue(navChain);
    txFrom.mockReturnValue(txChain);
    idxFrom.mockReturnValue(idxChain);

    await expect(fetchPortfolioTimeline(FUNDS, 'user-1', '^NSEI', 'All')).rejects.toThrow('nav fetch failed');
  });
});
