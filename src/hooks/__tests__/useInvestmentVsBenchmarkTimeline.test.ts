jest.mock('@tanstack/react-query', () => ({ useQuery: jest.fn() }));
jest.mock('@/src/hooks/usePerformanceTimeline', () => ({
  buildXAxisLabels: (dates: string[]) => dates.map((date) => date.slice(5)),
}));

// eslint-disable-next-line import/first -- mocks must register before module imports
import { computeInvestmentVsBenchmarkTimeline } from '../useInvestmentVsBenchmarkTimeline';

const FUND = { id: 'fund-1', schemeCode: 100 };

describe('computeInvestmentVsBenchmarkTimeline', () => {
  it('returns actual portfolio, invested value, and benchmark value series', () => {
    const navRows = [
      { scheme_code: 100, nav_date: '2025-01-01', nav: 10 },
      { scheme_code: 100, nav_date: '2025-02-01', nav: 12 },
      { scheme_code: 100, nav_date: '2025-03-01', nav: 15 },
    ];
    const txRows = [
      { fund_id: 'fund-1', transaction_date: '2025-01-01', transaction_type: 'purchase', units: 100, amount: 1000 },
      { fund_id: 'fund-1', transaction_date: '2025-02-01', transaction_type: 'purchase', units: 50, amount: 600 },
    ];
    const idxRows = [
      { index_date: '2025-01-01', close_value: 100 },
      { index_date: '2025-02-01', close_value: 120 },
      { index_date: '2025-03-01', close_value: 150 },
    ];

    const result = computeInvestmentVsBenchmarkTimeline(navRows, txRows, idxRows, [FUND], 'All');

    expect(result.points).toHaveLength(3);
    expect(result.points[0]).toMatchObject({
      date: '2025-01-01',
      investedValue: 1000,
      portfolioValue: 1000,
      benchmarkValue: 1000,
    });
    expect(result.points[2].investedValue).toBe(1600);
    expect(result.points[2].portfolioValue).toBe(2250);
    expect(result.points[2].benchmarkValue).toBeCloseTo(2250);
  });

  it('reduces invested value after redemptions using cost-basis semantics', () => {
    const navRows = [
      { scheme_code: 100, nav_date: '2025-01-01', nav: 10 },
      { scheme_code: 100, nav_date: '2025-02-01', nav: 10 },
      { scheme_code: 100, nav_date: '2025-03-01', nav: 10 },
    ];
    const txRows = [
      { fund_id: 'fund-1', transaction_date: '2025-01-01', transaction_type: 'purchase', units: 100, amount: 1000 },
      { fund_id: 'fund-1', transaction_date: '2025-02-01', transaction_type: 'redemption', units: 40, amount: 400 },
    ];
    const idxRows = [
      { index_date: '2025-01-01', close_value: 100 },
      { index_date: '2025-02-01', close_value: 100 },
      { index_date: '2025-03-01', close_value: 100 },
    ];

    const result = computeInvestmentVsBenchmarkTimeline(navRows, txRows, idxRows, [FUND], 'All');
    const last = result.points[result.points.length - 1];

    expect(last.investedValue).toBe(600);
    expect(last.portfolioValue).toBe(600);
    expect(last.benchmarkValue).toBe(600);
  });

  it('excludes failed-payment reversal pairs from invested and benchmark history', () => {
    const navRows = [
      { scheme_code: 100, nav_date: '2025-10-09', nav: 230 },
      { scheme_code: 100, nav_date: '2025-10-10', nav: 229 },
    ];
    const txRows = [
      { fund_id: 'fund-1', transaction_date: '2025-10-09', transaction_type: 'redemption', units: 0, amount: 25000 },
      { fund_id: 'fund-1', transaction_date: '2025-10-09', transaction_type: 'purchase', units: 101.12, amount: 25000 },
    ];
    const idxRows = [
      { index_date: '2025-10-09', close_value: 100 },
      { index_date: '2025-10-10', close_value: 101 },
    ];

    const result = computeInvestmentVsBenchmarkTimeline(navRows, txRows, idxRows, [FUND], 'All');

    expect(result.points).toHaveLength(0);
    expect(result.xAxisLabels).toHaveLength(0);
  });

  it('uses the latest available benchmark value when a transaction falls on a missing benchmark date', () => {
    const navRows = [
      { scheme_code: 100, nav_date: '2025-01-01', nav: 10 },
      { scheme_code: 100, nav_date: '2025-01-02', nav: 11 },
    ];
    const txRows = [
      { fund_id: 'fund-1', transaction_date: '2025-01-02', transaction_type: 'purchase', units: 100, amount: 1100 },
    ];
    const idxRows = [
      { index_date: '2025-01-01', close_value: 100 },
      { index_date: '2025-01-03', close_value: 120 },
    ];

    const result = computeInvestmentVsBenchmarkTimeline(navRows, txRows, idxRows, [FUND], 'All');

    expect(result.points[0].benchmarkValue).toBe(1100);
  });

  it('uses the latest available NAV when the chart date does not match a NAV date exactly', () => {
    const navRows = [
      { scheme_code: 100, nav_date: '2025-01-01', nav: 10 },
      { scheme_code: 100, nav_date: '2025-01-05', nav: 12 },
    ];
    const txRows = [
      { fund_id: 'fund-1', transaction_date: '2025-01-01', transaction_type: 'purchase', units: 100, amount: 1000 },
      { fund_id: 'fund-1', transaction_date: '2025-01-03', transaction_type: 'purchase', units: 50, amount: 500 },
    ];
    const idxRows = [
      { index_date: '2025-01-01', close_value: 100 },
      { index_date: '2025-01-03', close_value: 110 },
      { index_date: '2025-01-05', close_value: 120 },
    ];

    const result = computeInvestmentVsBenchmarkTimeline(navRows, txRows, idxRows, [FUND], 'All');

    expect(result.points.map((point) => point.date)).toContain('2025-01-03');
    expect(result.points.find((point) => point.date === '2025-01-03')?.portfolioValue).toBe(1500);
  });

  it('returns empty output when required series are missing', () => {
    expect(computeInvestmentVsBenchmarkTimeline([], [], [], [FUND], 'All')).toEqual({
      points: [],
      xAxisLabels: [],
    });
  });

  // Long histories must be sub-sampled — without this the chart blows past
  // its 90-point budget and either pegs the device or scrolls horizontally.
  it('downsamples long histories to fit the chart budget', () => {
    const navRows: { scheme_code: number; nav_date: string; nav: number }[] = [];
    const txRows: { fund_id: string; transaction_date: string; transaction_type: string; units: number; amount: number }[] = [];
    const idxRows: { index_date: string; close_value: number }[] = [];

    // 200 trading days of monotonically increasing NAV + index, with a buy
    // on every other day so we end up with ~100 timeline rows pre-sampling.
    const start = new Date('2024-01-01');
    for (let i = 0; i < 200; i++) {
      const day = new Date(start);
      day.setDate(start.getDate() + i);
      const date = day.toISOString().split('T')[0];
      navRows.push({ scheme_code: 100, nav_date: date, nav: 10 + i * 0.1 });
      idxRows.push({ index_date: date, close_value: 100 + i });
      if (i % 2 === 0) {
        txRows.push({
          fund_id: 'fund-1',
          transaction_date: date,
          transaction_type: 'purchase',
          units: 10,
          amount: 100,
        });
      }
    }

    const result = computeInvestmentVsBenchmarkTimeline(navRows, txRows, idxRows, [FUND], 'All');

    // Sampler caps output at ~90 points and must always retain the last point.
    expect(result.points.length).toBeLessThanOrEqual(91);
    expect(result.points.length).toBeGreaterThan(0);
    const last = result.points[result.points.length - 1];
    expect(last.date).toBe(navRows[navRows.length - 1].nav_date);
  });
});
