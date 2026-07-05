jest.mock('@tanstack/react-query', () => ({ useQuery: jest.fn() }));
jest.mock('@/src/hooks/usePerformanceTimeline', () => ({
  buildXAxisLabels: (dates: string[]) => dates.map((date) => date.slice(5)),
}));
jest.mock('@/src/lib/data/transaction', () => ({
  transactionRepo: { from: jest.fn() },
}));
jest.mock('@/src/lib/data/navHistory', () => ({
  navHistoryRepo: { from: jest.fn() },
}));
jest.mock('@/src/hooks/useIndexSnapshot', () => ({
  fetchIndexHistory: jest.fn(),
  fetchIndexSnapshot: jest.fn(),
}));

// eslint-disable-next-line import/first -- mocks must register before module imports
import type { QueryClient } from '@tanstack/react-query';
// eslint-disable-next-line import/first -- mocks must register before module imports
import {
  buildInvestmentTimelineInputs,
  buildRequiredNavStartByScheme,
  computeInvestmentVsBenchmarkTimeline,
  computeInvestmentVsBenchmarkTimelineFromInputs,
  evictTimelineSiblingsAfterNavRepair,
  fetchInvestmentTimelineInputs,
  fetchInvestmentVsBenchmarkTimeline,
  investmentTimelineInputQueryKey,
  prefetchInvestmentVsBenchmarkTimeline,
  stableInvestmentTimelineFundKey,
} from '../useInvestmentVsBenchmarkTimeline';
// eslint-disable-next-line import/first -- mocks must register before module imports
import { navHistoryRepo } from '@/src/lib/data/navHistory';
// eslint-disable-next-line import/first -- mocks must register before module imports
import { fetchIndexHistory, fetchIndexSnapshot } from '@/src/hooks/useIndexSnapshot';
// eslint-disable-next-line import/first -- mocks must register before module imports
import { __setDbForTests, getDb } from '@/src/lib/db/db';
// eslint-disable-next-line import/first -- mocks must register before module imports
import * as txRepo from '@/src/lib/db/tx';
// eslint-disable-next-line import/first -- mocks must register before module imports
import * as navRepo from '@/src/lib/db/nav';
// eslint-disable-next-line import/first -- mocks must register before module imports
import {
  computeLegacyInvestmentTimeline,
  INVESTMENT_TIMELINE_GOLDEN_FIXTURES,
} from './fixtures/investmentTimelineLegacy';
// eslint-disable-next-line import/first -- mocks must register before module imports
import type { TimeWindow } from '@/src/utils/navUtils';

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

  // Close-ended NFOs that have matured are fully redeemed (netUnits=0), so
  // the portfolio screen previously dropped them from the funds array — and
  // the chart lost their entire historical contribution. Now that the
  // screen passes every transacted fund regardless of current units, the
  // hook must correctly include them and show the full lifecycle.
  it('includes the full lifecycle of a fully-redeemed fund', () => {
    const navRows = [
      { scheme_code: 100, nav_date: '2025-01-01', nav: 10 },
      { scheme_code: 100, nav_date: '2025-02-01', nav: 12 },
      { scheme_code: 100, nav_date: '2025-03-01', nav: 14 },
    ];
    // Buy 100 units at 10, fund matures and AMC redeems all 100 units at 14.
    const txRows = [
      { fund_id: 'fund-1', transaction_date: '2025-01-01', transaction_type: 'purchase', units: 100, amount: 1000 },
      { fund_id: 'fund-1', transaction_date: '2025-03-01', transaction_type: 'redemption', units: 100, amount: 1400 },
    ];
    const idxRows = [
      { index_date: '2025-01-01', close_value: 100 },
      { index_date: '2025-02-01', close_value: 110 },
      { index_date: '2025-03-01', close_value: 120 },
    ];

    const result = computeInvestmentVsBenchmarkTimeline(navRows, txRows, idxRows, [FUND], 'All');

    const subscription = result.points.find((point) => point.date === '2025-01-01');
    expect(subscription?.investedValue).toBe(1000);
    expect(subscription?.portfolioValue).toBe(1000);

    const midway = result.points.find((point) => point.date === '2025-02-01');
    expect(midway?.investedValue).toBe(1000);
    expect(midway?.portfolioValue).toBe(1200);
  });

  // Close-ended NFOs record the subscription transaction on the application
  // date but NAV history only starts at allotment. Without the cost-basis
  // fallback the chart drops the entire subscription period, so the user sees
  // the chart begin weeks after they actually committed money.
  it('marks pre-NAV NFO subscriptions to cost so early commitments still appear', () => {
    const navRows = [
      { scheme_code: 100, nav_date: '2018-04-09', nav: 10 },
      { scheme_code: 100, nav_date: '2018-05-09', nav: 11 },
    ];
    const txRows = [
      { fund_id: 'fund-1', transaction_date: '2018-03-08', transaction_type: 'purchase', units: 2500, amount: 25000 },
    ];
    const idxRows = [
      { index_date: '2018-03-08', close_value: 100 },
      { index_date: '2018-04-09', close_value: 105 },
      { index_date: '2018-05-09', close_value: 110 },
    ];

    const result = computeInvestmentVsBenchmarkTimeline(navRows, txRows, idxRows, [FUND], 'All');

    const subscription = result.points.find((point) => point.date === '2018-03-08');
    expect(subscription).toBeDefined();
    expect(subscription?.investedValue).toBe(25000);
    expect(subscription?.portfolioValue).toBe(25000);
    expect(subscription?.benchmarkValue).toBe(25000);

    const allotment = result.points.find((point) => point.date === '2018-04-09');
    expect(allotment?.portfolioValue).toBe(25000);
  });
});

describe('N2T pre-change financial equivalence', () => {
  const windows: TimeWindow[] = ['1M', '3M', '6M', '1Y', '3Y', 'All'];

  beforeAll(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-06-30T12:00:00Z'));
  });

  afterAll(() => {
    jest.useRealTimers();
  });

  it.each(INVESTMENT_TIMELINE_GOLDEN_FIXTURES)(
    'matches every legacy date and value for $name across all windows',
    (fixture) => {
      for (const window of windows) {
        const legacy = computeLegacyInvestmentTimeline(
          fixture.navRows,
          fixture.txRows,
          fixture.idxRows,
          fixture.funds,
          window,
        );
        const next = computeInvestmentVsBenchmarkTimeline(
          fixture.navRows,
          fixture.txRows,
          fixture.idxRows,
          fixture.funds,
          window,
        );

        expect(next.points.map((point) => point.date)).toEqual(
          legacy.points.map((point) => point.date),
        );
        expect(next.xAxisLabels).toEqual(legacy.xAxisLabels);
        expect(next.points).toHaveLength(legacy.points.length);
        next.points.forEach((point, index) => {
          const expected = legacy.points[index];
          expect(point.investedValue).toBeCloseTo(expected.investedValue, 10);
          expect(point.portfolioValue).toBeCloseTo(expected.portfolioValue, 10);
          expect(point.benchmarkValue).toBeCloseTo(expected.benchmarkValue, 10);
        });
      }
    },
  );

  it('samples before portfolio valuation and retains the terminal date', () => {
    const navRows = Array.from({ length: 400 }, (_, index) => {
      const date = new Date('2025-01-01T00:00:00Z');
      date.setUTCDate(date.getUTCDate() + index);
      return { scheme_code: 100, nav_date: date.toISOString().slice(0, 10), nav: 10 + index / 100 };
    });
    const txRows = [{
      fund_id: 'fund-1',
      transaction_date: '2025-01-01',
      transaction_type: 'purchase',
      units: 100,
      amount: 1000,
    }];
    const idxRows = navRows.map((row, index) => ({
      index_date: row.nav_date,
      close_value: 100 + index,
    }));
    const inputs = buildInvestmentTimelineInputs(navRows, txRows, [FUND], 'All');

    const result = computeInvestmentVsBenchmarkTimelineFromInputs(inputs, idxRows);

    expect(inputs.candidateDates).toHaveLength(400);
    expect(result.evaluationDateCount).toBeLessThanOrEqual(91);
    expect(inputs.valuationByDate.size).toBe(result.evaluationDateCount);
    expect(result.points.at(-1)?.date).toBe(navRows.at(-1)?.nav_date);
  });
});

describe('N2T prepared input cache', () => {
  it('requires NAV only for schemes with positive-unit exposure in the window', () => {
    const funds = [
      { id: 'closed', schemeCode: 100 },
      { id: 'carried', schemeCode: 200 },
      { id: 'new', schemeCode: 300 },
    ];
    const txRows = [
      { fund_id: 'closed', transaction_date: '2020-01-01', transaction_type: 'purchase', units: 10, amount: 100 },
      { fund_id: 'closed', transaction_date: '2021-01-01', transaction_type: 'redemption', units: 10, amount: 120 },
      { fund_id: 'carried', transaction_date: '2020-01-01', transaction_type: 'purchase', units: 10, amount: 100 },
      { fund_id: 'new', transaction_date: '2025-06-01', transaction_type: 'purchase', units: 10, amount: 100 },
    ];

    expect([...buildRequiredNavStartByScheme(funds, txRows, '2024-01-01')]).toEqual([
      [200, '2024-01-01'],
      [300, '2025-06-01'],
    ]);
  });

  it('keys the same fund set deterministically and includes scheme identity', () => {
    const funds = [
      { id: 'fund-b', schemeCode: 200 },
      { id: 'fund-a', schemeCode: 100 },
    ];

    expect(stableInvestmentTimelineFundKey(funds)).toBe('fund-a:100,fund-b:200');
    expect(stableInvestmentTimelineFundKey([...funds].reverse())).toBe(
      stableInvestmentTimelineFundKey(funds),
    );
    expect(investmentTimelineInputQueryKey(funds, 'user-1', '3Y')).toEqual([
      'investmentTimelineInputs',
      'user-1',
      'fund-a:100,fund-b:200',
      '3Y',
    ]);
  });
});

describe('N2 targeted timeline prefetch', () => {
  it('warms only the requested benchmark and window key', async () => {
    const prefetchQuery = jest.fn().mockResolvedValue(undefined);
    const queryClient = { prefetchQuery } as unknown as QueryClient;

    await prefetchInvestmentVsBenchmarkTimeline(
      queryClient,
      [FUND],
      'user-1',
      '^NIFTY100TRI',
      '3Y',
    );

    expect(prefetchQuery).toHaveBeenCalledTimes(1);
    expect(prefetchQuery.mock.calls[0][0]).toMatchObject({
      queryKey: [
        'investmentVsBenchmarkTimeline',
        'user-1',
        'fund-1',
        '^NIFTY100TRI',
        '3Y',
      ],
    });
  });
});

describe('N2D timeline NAV cache repair', () => {
  const remoteNavRows = [
    { scheme_code: 100, nav_date: '2025-01-01', nav: 10 },
    { scheme_code: 100, nav_date: '2025-02-01', nav: 12 },
  ];

  beforeEach(async () => {
    await __setDbForTests(null);
    jest.clearAllMocks();
    await txRepo.bulkInsert([
      {
        fund_id: 'fund-1',
        transaction_date: '2025-01-01',
        transaction_type: 'purchase',
        units: 100,
        amount: 1000,
        id: 'tx-1',
        nav_at_transaction: 10,
        folio_number: null,
        cas_import_id: null,
        created_at: '2025-01-01T00:00:00Z',
      },
    ]);
    (fetchIndexHistory as jest.Mock).mockResolvedValue([
      { date: '2025-01-01', value: 100 },
      { date: '2025-02-01', value: 120 },
    ]);
    (fetchIndexSnapshot as jest.Mock).mockImplementation((symbol: string) => Promise.resolve({
      symbol,
      generated_at: '2026-07-02T00:00:00Z',
      points: [
        { date: '2025-01-01', value: 100 },
        { date: '2025-02-01', value: 120 },
      ],
    }));
    (navHistoryRepo.from as jest.Mock).mockImplementation(() => {
      const chain: any = {
        select: jest.fn().mockReturnThis(),
        in: jest.fn().mockReturnThis(),
        gte: jest.fn().mockReturnThis(),
        order: jest.fn().mockReturnThis(),
        range: jest.fn().mockResolvedValue({ data: remoteNavRows, error: null }),
      };
      return chain;
    });
  });

  it('reuses prepared transaction, NAV, history, and valuation input across benchmarks', async () => {
    const cache = new Map<string, unknown>();
    let inputBuilds = 0;
    const inputQueryClient = {
      getQueryData: jest.fn((key: readonly unknown[]) => cache.get(JSON.stringify(key))),
      getQueryState: jest.fn((key: readonly unknown[]) => {
        const data = cache.get(JSON.stringify(key));
        return data === undefined ? undefined : { data, dataUpdatedAt: Date.now() };
      }),
      fetchQuery: jest.fn(async ({ queryKey, queryFn }: {
        queryKey: readonly unknown[];
        queryFn: () => Promise<unknown>;
      }) => {
        const key = JSON.stringify(queryKey);
        if (cache.has(key)) return cache.get(key);
        if (queryKey[0] === 'investmentTimelineInputs') inputBuilds += 1;
        const value = await queryFn();
        cache.set(key, value);
        return value;
      }),
      removeQueries: jest.fn(),
    } as unknown as QueryClient;
    const txRead = jest.spyOn(txRepo, 'readByFundIds');

    const first = await fetchInvestmentVsBenchmarkTimeline(
      [FUND],
      'user-1',
      '^NSEI',
      'All',
      inputQueryClient,
    );
    const inputKey = investmentTimelineInputQueryKey([FUND], 'user-1', 'All');
    const prepared = cache.get(JSON.stringify(inputKey)) as ReturnType<
      typeof buildInvestmentTimelineInputs
    >;
    const valuationsAfterFirst = prepared.valuationByDate.size;
    const second = await fetchInvestmentVsBenchmarkTimeline(
      [FUND],
      'user-1',
      '^BSESN',
      'All',
      inputQueryClient,
    );

    expect(first.points).toHaveLength(2);
    expect(second.points).toHaveLength(2);
    expect(inputBuilds).toBe(1);
    expect(txRead).toHaveBeenCalledTimes(1);
    expect(navHistoryRepo.from).toHaveBeenCalledTimes(1);
    expect(fetchIndexSnapshot).toHaveBeenCalledTimes(2);
    expect(fetchIndexHistory).not.toHaveBeenCalled();
    expect(prepared.valuationByDate.size).toBe(valuationsAfterFirst);
    expect(valuationsAfterFirst).toBeGreaterThan(0);

    txRead.mockRestore();
  });

  it('retries retained rows after a failed write and makes the next identical read local', async () => {
    const db = await getDb();
    const originalTransaction = db.withTransactionAsync.bind(db);
    let navWriteAttempt = 0;
    db.withTransactionAsync = async (task) => {
      navWriteAttempt += 1;
      if (navWriteAttempt === 1) throw new Error('injected timeline repair failure');
      await originalTransaction(task);
    };
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const first = await fetchInvestmentVsBenchmarkTimeline(
      [FUND],
      'user-1',
      '^NSEI',
      'All',
    );
    const second = await fetchInvestmentVsBenchmarkTimeline(
      [FUND],
      'user-1',
      '^NSEI',
      'All',
    );

    expect(first.points).toHaveLength(2);
    expect(second).toEqual(first);
    // Two NAV write attempts (first injected failure + retained-row retry),
    // followed by one authoritative coverage-marker transaction.
    expect(navWriteAttempt).toBe(3);
    expect(navHistoryRepo.from).toHaveBeenCalledTimes(1);
    expect(await navRepo.readBySchemeCode(100)).toHaveLength(2);
    expect(warn).toHaveBeenCalledWith(
      '[timeline] sqlite nav repair retrying',
      { error: 'injected timeline repair failure' },
    );
    expect(warn.mock.calls.flat().join(' ')).not.toMatch(
      /cannot start a transaction within a transaction|cannot rollback - no transaction is active/,
    );
    warn.mockRestore();
  });

  it('propagates the final repair failure instead of reporting an unrepaired query', async () => {
    const db = await getDb();
    let navWriteAttempt = 0;
    db.withTransactionAsync = async () => {
      navWriteAttempt += 1;
      throw new Error(`injected timeline repair failure ${navWriteAttempt}`);
    };
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(fetchInvestmentVsBenchmarkTimeline(
      [FUND],
      'user-1',
      '^NSEI',
      'All',
    )).rejects.toThrow('injected timeline repair failure 2');

    expect(navWriteAttempt).toBe(2);
    expect(navHistoryRepo.from).toHaveBeenCalledTimes(1);
    expect(await navRepo.readBySchemeCode(100)).toEqual([]);
    warn.mockRestore();
  });
});

describe('C1 authoritative NAV coverage', () => {
  beforeEach(async () => {
    await __setDbForTests(null);
    jest.clearAllMocks();
  });

  it('rejects a mixed recent-only cache, repairs it, and keeps the second read local', async () => {
    const funds = [
      { id: 'closed', schemeCode: 100 },
      { id: 'live', schemeCode: 200 },
    ];
    await txRepo.bulkInsert([
      {
        fund_id: 'closed', transaction_date: '2018-01-01', transaction_type: 'purchase',
        units: 100, amount: 1000, id: 'c-buy', nav_at_transaction: 10,
        folio_number: null, cas_import_id: null, created_at: '2018-01-01T00:00:00Z',
      },
      {
        fund_id: 'live', transaction_date: '2020-01-01', transaction_type: 'purchase',
        units: 100, amount: 1000, id: 'l-buy', nav_at_transaction: 10,
        folio_number: null, cas_import_id: null, created_at: '2020-01-01T00:00:00Z',
      },
      {
        fund_id: 'closed', transaction_date: '2021-01-01', transaction_type: 'redemption',
        units: 100, amount: 2000, id: 'c-sell', nav_at_transaction: 20,
        folio_number: null, cas_import_id: null, created_at: '2021-01-01T00:00:00Z',
      },
    ]);
    // Signature from the Android incident: one old closed scheme makes the
    // global earliest row look healthy while the live scheme has only recent NAV.
    await navRepo.bulkInsert([
      { scheme_code: 100, nav_date: '2018-01-01', nav: 10 },
      { scheme_code: 100, nav_date: '2021-01-01', nav: 20 },
      { scheme_code: 200, nav_date: '2026-01-01', nav: 40 },
    ]);

    const remoteRows = [
      { scheme_code: 100, nav_date: '2018-01-01', nav: 10 },
      { scheme_code: 100, nav_date: '2021-01-01', nav: 20 },
      { scheme_code: 200, nav_date: '2020-01-01', nav: 10 },
      { scheme_code: 200, nav_date: '2023-01-01', nav: 30 },
      { scheme_code: 200, nav_date: '2026-01-01', nav: 40 },
    ];
    const order = jest.fn().mockReturnThis();
    (navHistoryRepo.from as jest.Mock).mockImplementation(() => ({
      select: jest.fn().mockReturnThis(),
      in: jest.fn().mockReturnThis(),
      gte: jest.fn().mockReturnThis(),
      order,
      range: jest.fn().mockResolvedValue({ data: remoteRows, error: null }),
    }));
    const firstInputs = await fetchInvestmentTimelineInputs(funds, 'user-1', 'All');
    const secondInputs = await fetchInvestmentTimelineInputs(funds, 'user-1', 'All');
    const first = computeInvestmentVsBenchmarkTimelineFromInputs(firstInputs, [
      { index_date: '2018-01-01', close_value: 100 },
      { index_date: '2020-01-01', close_value: 120 },
      { index_date: '2021-01-01', close_value: 130 },
      { index_date: '2023-01-01', close_value: 150 },
      { index_date: '2026-01-01', close_value: 180 },
    ]);
    const point2023 = first.points.find((point) => point.date === '2023-01-01');

    expect(point2023?.investedValue).toBe(1000);
    expect(point2023?.portfolioValue).toBe(3000);
    expect(point2023?.portfolioValue).not.toBe(point2023?.investedValue);
    expect(firstInputs.navCacheRepaired).toBe(true);
    expect(secondInputs.navCacheRepaired).toBe(false);
    expect(navHistoryRepo.from).toHaveBeenCalledTimes(1);
    expect(order.mock.calls).toEqual([
      ['nav_date', { ascending: true }],
      ['scheme_code', { ascending: true }],
    ]);
    expect(await navRepo.hasHistoryCoverage(100, '2018-01-01')).toBe(true);
    expect(await navRepo.hasHistoryCoverage(200, '2020-01-01')).toBe(true);
  });

  it('treats an authoritative NFO pre-allotment gap as known and does not refetch', async () => {
    const funds = [
      { id: 'regular', schemeCode: 100 },
      { id: 'nfo', schemeCode: 200 },
    ];
    const txRows = [
      { fund_id: 'regular', transaction_date: '2025-01-01', transaction_type: 'purchase', units: 100, amount: 1000 },
      { fund_id: 'nfo', transaction_date: '2025-01-01', transaction_type: 'purchase', units: 100, amount: 1000 },
    ];
    await txRepo.bulkInsert(txRows.map((tx, index) => ({
      ...tx,
      id: `tx-${index}`,
      nav_at_transaction: 10,
      folio_number: null,
      cas_import_id: null,
      created_at: `${tx.transaction_date}T00:00:00Z`,
    })));
    const remoteRows = [
      { scheme_code: 100, nav_date: '2025-01-01', nav: 10 },
      { scheme_code: 100, nav_date: '2025-02-01', nav: 11 },
      // NFO has no upstream NAV on the subscription date.
      { scheme_code: 200, nav_date: '2025-02-01', nav: 10 },
    ];
    (navHistoryRepo.from as jest.Mock).mockImplementation(() => ({
      select: jest.fn().mockReturnThis(),
      in: jest.fn().mockReturnThis(),
      gte: jest.fn().mockReturnThis(),
      order: jest.fn().mockReturnThis(),
      range: jest.fn().mockResolvedValue({ data: remoteRows, error: null }),
    }));

    const firstInputs = await fetchInvestmentTimelineInputs(funds, 'user-1', 'All');
    const secondInputs = await fetchInvestmentTimelineInputs(funds, 'user-1', 'All');
    const computed = computeInvestmentVsBenchmarkTimelineFromInputs(firstInputs, [
      { index_date: '2025-01-01', close_value: 100 },
      { index_date: '2025-02-01', close_value: 110 },
    ]);

    expect(firstInputs.navCacheRepaired).toBe(true);
    expect(secondInputs.navCacheRepaired).toBe(false);
    expect(navHistoryRepo.from).toHaveBeenCalledTimes(1);
    expect(computed.knownCostFallbacks).toBeGreaterThan(0);
    expect(computed.unexpectedCostFallbacks).toBe(0);
  });

  it.each([
    {
      label: 'single-fund repair removes an all-funds timeline',
      funds: [FUND],
      preservedInput: ['investmentTimelineInputs', 'user-1', 'fund-1:100', 'All'],
      preservedOutput: ['investmentVsBenchmarkTimeline', 'user-1', 'fund-1', '^NSEI', 'All'],
    },
    {
      label: 'all-funds repair removes a single-fund timeline',
      funds: [FUND, { id: 'fund-2', schemeCode: 200 }],
      preservedInput: ['investmentTimelineInputs', 'user-1', 'fund-1:100,fund-2:200', 'All'],
      preservedOutput: ['investmentVsBenchmarkTimeline', 'user-1', 'fund-1,fund-2', '^NSEI', 'All'],
    },
  ])('$label while preserving only the rebuilt key', ({ funds, preservedInput, preservedOutput }) => {
    const keys: readonly unknown[][] = [
      ['investmentTimelineInputs', 'user-1', 'fund-1:100', 'All'],
      ['investmentTimelineInputs', 'user-1', 'fund-1:100', '3Y'],
      ['investmentTimelineInputs', 'user-1', 'fund-1:100,fund-2:200', 'All'],
      ['investmentVsBenchmarkTimeline', 'user-1', 'fund-1', '^NSEI', 'All'],
      ['investmentVsBenchmarkTimeline', 'user-1', 'fund-1', '^BSESN', 'All'],
      ['investmentVsBenchmarkTimeline', 'user-1', 'fund-1', '^NSEI', '3Y'],
      ['investmentVsBenchmarkTimeline', 'user-1', 'fund-1,fund-2', '^NSEI', 'All'],
      ['investmentTimelineInputs', 'user-2', 'fund-1:100', 'All'],
      ['investmentVsBenchmarkTimeline', 'user-2', 'fund-1', '^NSEI', 'All'],
    ];
    const removed: readonly unknown[][] = [];
    const client = {
      removeQueries: jest.fn(({ predicate }: { predicate: (query: { queryKey: readonly unknown[] }) => boolean }) => {
        for (const queryKey of keys) if (predicate({ queryKey })) (removed as unknown[][]).push([...queryKey]);
      }),
    } as unknown as QueryClient;

    evictTimelineSiblingsAfterNavRepair(client, funds, 'user-1', '^NSEI', 'All');

    expect(removed).not.toContainEqual(preservedInput);
    expect(removed).not.toContainEqual(preservedOutput);
    expect(removed).not.toContainEqual(['investmentTimelineInputs', 'user-2', 'fund-1:100', 'All']);
    expect(removed).not.toContainEqual(['investmentVsBenchmarkTimeline', 'user-2', 'fund-1', '^NSEI', 'All']);
    expect(removed).toHaveLength(5);
  });
});
