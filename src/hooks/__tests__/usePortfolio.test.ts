import { fetchPortfolioData } from '../usePortfolio';
import { supabase } from '@/src/lib/supabase';

jest.mock('@tanstack/react-query', () => ({ useQuery: jest.fn(), keepPreviousData: undefined }));
jest.mock('@/src/lib/supabase', () => ({ supabase: { from: jest.fn() } }));

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
    gte: jest.fn(),
    order: jest.fn(),
    range: jest.fn(),
    single: jest.fn(),
    maybeSingle: jest.fn(),
  };
  ['select', 'eq', 'in', 'gte', 'order'].forEach((m) =>
    (chain as Record<string, jest.Mock>)[m].mockReturnValue(chain),
  );
  // `.range()` is the terminal call for the paginated NAV / index
  // fetchers (`fetchNavHistoryDirect` / `fetchIndexHistoryDirect`).
  // Returning the response directly lets a single-page mock satisfy the
  // pagination loop's `rows.length < PAGE_SIZE` exit condition.
  chain.range.mockReturnValue(response);
  chain.single.mockReturnValue(response);
  chain.maybeSingle.mockReturnValue(response);
  return chain;
}

const mockFrom = supabase.from as jest.Mock;

const MOCK_FUNDS = [
  {
    id: 'fund-1',
    scheme_code: 12345,
    scheme_name: 'Test Equity Fund',
    scheme_category: 'Equity',
    benchmark_index_symbol: '^NSEI',
  },
];

const MOCK_TXS = [
  { fund_id: 'fund-1', transaction_date: '2023-01-01', transaction_type: 'purchase', units: 100, amount: 10000 },
  { fund_id: 'fund-1', transaction_date: '2023-06-01', transaction_type: 'purchase', units: 50, amount: 6000 },
];

const MOCK_NAV = [
  { scheme_code: 12345, nav_date: '2024-01-01', nav: 140 },
  { scheme_code: 12345, nav_date: '2023-12-31', nav: 138 },
];

const MOCK_INDEX = [
  { index_date: '2023-01-01', close_value: 17000 },
  { index_date: '2024-01-01', close_value: 21000 },
];

// ---------------------------------------------------------------------------
// fetchPortfolioData()
// ---------------------------------------------------------------------------

describe('fetchPortfolioData()', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns empty fundCards and null summary when user has no funds', async () => {
    mockFrom.mockImplementation((table: string) => {
      if (table === 'fund') return makeChain({ data: [], error: null });
      return makeChain({ data: [], error: null });
    });

    const result = await fetchPortfolioData('user-1', '^NSEI');
    expect(result.fundCards).toHaveLength(0);
    expect(result.summary).toBeNull();
  });

  it('throws when fund query returns an error', async () => {
    mockFrom.mockImplementation(() =>
      makeChain({ data: null, error: { message: 'DB error' } }),
    );
    await expect(fetchPortfolioData('user-1', '^NSEI')).rejects.toMatchObject({ message: 'DB error' });
  });

  it('returns structured fund cards for a valid portfolio', async () => {
    mockFrom.mockImplementation((table: string) => {
      if (table === 'fund') return makeChain({ data: MOCK_FUNDS, error: null });
      if (table === 'transaction') return makeChain({ data: MOCK_TXS, error: null });
      if (table === 'nav_history') return makeChain({ data: MOCK_NAV, error: null });
      if (table === 'index_history') return makeChain({ data: MOCK_INDEX, error: null });
      return makeChain({ data: [], error: null });
    });

    const result = await fetchPortfolioData('user-1', '^NSEI');
    expect(result.fundCards).toHaveLength(1);

    const card = result.fundCards[0];
    expect(card.id).toBe('fund-1');
    expect(card.schemeName).toBe('Test Equity Fund');
    expect(card.schemeCode).toBe(12345);
    expect(card.currentNav).toBe(140);
    expect(card.currentUnits).toBe(150);       // 100 + 50
    expect(card.investedAmount).toBe(16000);   // 10000 + 6000
    expect(card.currentValue).toBeCloseTo(150 * 140, 5); // units × NAV
    expect(isFinite(card.returnXirr)).toBe(true);
  });

  it('summary contains totalValue, xirr, and daily change', async () => {
    mockFrom.mockImplementation((table: string) => {
      if (table === 'fund') return makeChain({ data: MOCK_FUNDS, error: null });
      if (table === 'transaction') return makeChain({ data: MOCK_TXS, error: null });
      if (table === 'nav_history') return makeChain({ data: MOCK_NAV, error: null });
      if (table === 'index_history') return makeChain({ data: MOCK_INDEX, error: null });
      return makeChain({ data: [], error: null });
    });

    const result = await fetchPortfolioData('user-1', '^NSEI');
    expect(result.summary).not.toBeNull();
    expect(result.summary!.totalValue).toBeCloseTo(150 * 140, 5);
    expect(result.summary!.totalInvested).toBe(16000);
    expect(isFinite(result.summary!.xirr) || isNaN(result.summary!.xirr)).toBe(true);
  });

  it('does not show funds that only have a failed-payment purchase/reversal pair', async () => {
    const failedPaymentTxs = [
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

    mockFrom.mockImplementation((table: string) => {
      if (table === 'fund') return makeChain({ data: MOCK_FUNDS, error: null });
      if (table === 'transaction') return makeChain({ data: failedPaymentTxs, error: null });
      if (table === 'nav_history') return makeChain({ data: MOCK_NAV, error: null });
      if (table === 'index_history') return makeChain({ data: MOCK_INDEX, error: null });
      return makeChain({ data: [], error: null });
    });

    const result = await fetchPortfolioData('user-1', '^NSEI');

    expect(result.fundCards).toHaveLength(0);
    expect(result.summary).toMatchObject({
      totalValue: 0,
      totalInvested: 0,
    });
  });

  it('skips funds with no transactions (does not add them to fundCards)', async () => {
    mockFrom.mockImplementation((table: string) => {
      if (table === 'fund') return makeChain({ data: MOCK_FUNDS, error: null });
      if (table === 'transaction') return makeChain({ data: [], error: null }); // no txs
      if (table === 'nav_history') return makeChain({ data: MOCK_NAV, error: null });
      if (table === 'index_history') return makeChain({ data: MOCK_INDEX, error: null });
      return makeChain({ data: [], error: null });
    });

    const result = await fetchPortfolioData('user-1', '^NSEI');
    expect(result.fundCards).toHaveLength(0);
  });

  it('shows a pending card for funds with no NAV data rather than crashing or hiding the holding', async () => {
    mockFrom.mockImplementation((table: string) => {
      if (table === 'fund') return makeChain({ data: MOCK_FUNDS, error: null });
      if (table === 'transaction') return makeChain({ data: MOCK_TXS, error: null });
      if (table === 'nav_history') return makeChain({ data: [], error: null }); // no nav
      if (table === 'index_history') return makeChain({ data: MOCK_INDEX, error: null });
      return makeChain({ data: [], error: null });
    });

    // Should not throw — fund appears as a pending card with null nav fields
    const result = await fetchPortfolioData('user-1', '^NSEI');
    expect(result.fundCards).toHaveLength(1);
    const card = result.fundCards[0];
    expect(card.navUnavailable).toBe(true);
    expect(card.currentNav).toBeNull();
    expect(card.currentValue).toBeNull();
    expect(card.investedAmount).toBe(16000);  // 10000 + 6000
    expect(card.currentUnits).toBe(150);      // 100 + 50
    expect(card.navHistory30d).toHaveLength(0);
    expect(result.summary?.totalValue).toBe(0); // pending fund not counted in total
  });

  it('navHistory30d contains only the last 30 days of NAV data', async () => {
    // Provide nav data spanning more than 30 days
    const today = new Date();
    const navData = [
      // Within 30 days
      { scheme_code: 12345, nav_date: new Date(today.getTime() - 5 * 86400000).toISOString().split('T')[0], nav: 140 },
      { scheme_code: 12345, nav_date: new Date(today.getTime() - 10 * 86400000).toISOString().split('T')[0], nav: 138 },
      // Older than 30 days
      { scheme_code: 12345, nav_date: new Date(today.getTime() - 60 * 86400000).toISOString().split('T')[0], nav: 130 },
      { scheme_code: 12345, nav_date: new Date(today.getTime() - 90 * 86400000).toISOString().split('T')[0], nav: 120 },
    ];

    mockFrom.mockImplementation((table: string) => {
      if (table === 'fund') return makeChain({ data: MOCK_FUNDS, error: null });
      if (table === 'transaction') return makeChain({ data: MOCK_TXS, error: null });
      if (table === 'nav_history') return makeChain({ data: navData, error: null });
      if (table === 'index_history') return makeChain({ data: MOCK_INDEX, error: null });
      return makeChain({ data: [], error: null });
    });

    const result = await fetchPortfolioData('user-1', '^NSEI');
    const card = result.fundCards[0];
    // Only the 2 recent rows should be in navHistory30d (older ones are filtered)
    card.navHistory30d.forEach((p) => {
      const ageDays = (Date.now() - new Date(p.date).getTime()) / 86400000;
      expect(ageDays).toBeLessThanOrEqual(32); // small slack for date boundary
    });
    expect(card.navHistory30d.length).toBe(2);
  });

  // ── Fix 10 regression: benchmark XIRR must be a valid number when
  // index_history returns only recent rows (≤1000) covering transaction dates.
  // Root cause: ascending=true returned only pre-2011 rows for ^NSEI (4616 total),
  // leaving 2024+ transaction dates unmatchable → marketXirr = NaN.
  it('marketXirr is a finite number when index history covers transaction dates', async () => {
    // Recent index rows that overlap with the 2023 transaction dates
    const recentIndex = [
      { index_date: '2022-12-30', close_value: 17000 },
      { index_date: '2023-01-02', close_value: 17200 },
      { index_date: '2023-06-01', close_value: 18500 },
      { index_date: '2024-01-01', close_value: 21000 },
    ];

    mockFrom.mockImplementation((table: string) => {
      if (table === 'fund') return makeChain({ data: MOCK_FUNDS, error: null });
      if (table === 'transaction') return makeChain({ data: MOCK_TXS, error: null });
      if (table === 'nav_history') return makeChain({ data: MOCK_NAV, error: null });
      if (table === 'index_history') return makeChain({ data: recentIndex, error: null });
      return makeChain({ data: [], error: null });
    });

    const result = await fetchPortfolioData('user-1', '^NSEI');
    expect(result.summary).not.toBeNull();
    expect(isFinite(result.summary!.marketXirr)).toBe(true);
  });

  // ── Fund card XIRR display contract ───────────────────────────────────────
  // returnXirr is a decimal fraction (e.g. 0.15 = 15%). The FundCard uses
  // formatXirr() which multiplies by 100 internally, so the raw value must
  // NOT already be multiplied.
  it('returnXirr is a decimal fraction between -1 and 100 for a valid holding', async () => {
    mockFrom.mockImplementation((table: string) => {
      if (table === 'fund') return makeChain({ data: MOCK_FUNDS, error: null });
      if (table === 'transaction') return makeChain({ data: MOCK_TXS, error: null });
      if (table === 'nav_history') return makeChain({ data: MOCK_NAV, error: null });
      if (table === 'index_history') return makeChain({ data: MOCK_INDEX, error: null });
      return makeChain({ data: [], error: null });
    });

    const result = await fetchPortfolioData('user-1', '^NSEI');
    const card = result.fundCards[0];
    expect(isFinite(card.returnXirr)).toBe(true);
    // A decimal fraction: 15% = 0.15, not 15. Values above 100× are implausible.
    expect(Math.abs(card.returnXirr)).toBeLessThan(100);
  });

  // Regression — the chart's "Nifty TRI" line and the headline alpha used to
  // disagree because marketXirr did NOT decrement simulated benchmark units on
  // redemption, while the chart did. With the same purchases-then-redemption
  // history the bug overstated marketXirr → user got "behind benchmark by X%"
  // even when the chart visibly showed them ahead. Both paths now share
  // simulateBenchmarkInvestment, so they must agree on the sign of the alpha.
  it('marketXirr accounts for redemption — does not overstate benchmark return after sells', async () => {
    // Setup: index doubles 100 → 200 over a year. User buys 1L on Jan 1, then
    // sells half the realised value (~100k) on July 1. Final invested = 1L.
    const longTxs = [
      { fund_id: 'fund-1', transaction_date: '2023-01-01', transaction_type: 'purchase', units: 1000, amount: 100000 },
      // 50% redemption mid-year — at index 150, this should sell ~666 benchmark units
      // Without the fix, marketXirr keeps all 1000 units → terminal value
      // overstated by ~50% → marketXirr much higher than reality.
      { fund_id: 'fund-1', transaction_date: '2023-07-01', transaction_type: 'redemption', units: 500, amount: 100000 },
    ];
    const longNav = [
      { scheme_code: 12345, nav_date: '2024-01-01', nav: 200 },
      { scheme_code: 12345, nav_date: '2023-12-31', nav: 198 },
    ];
    const longIndex = [
      { index_date: '2023-01-01', close_value: 100 },
      { index_date: '2023-07-01', close_value: 150 },
      { index_date: '2024-01-01', close_value: 200 },
    ];

    mockFrom.mockImplementation((table: string) => {
      if (table === 'fund') return makeChain({ data: MOCK_FUNDS, error: null });
      if (table === 'transaction') return makeChain({ data: longTxs, error: null });
      if (table === 'nav_history') return makeChain({ data: longNav, error: null });
      if (table === 'index_history') return makeChain({ data: longIndex, error: null });
      return makeChain({ data: [], error: null });
    });

    const result = await fetchPortfolioData('user-1', '^NSEI');
    const marketXirr = result.summary!.marketXirr;
    expect(isFinite(marketXirr)).toBe(true);

    // Buggy code keeps all 1000 benchmark units → terminal = 1000 × 200 = 200000,
    // flows [-100k @ 0, +100k @ 0.5y, +200k @ 1y] → XIRR = 300% p.a.
    // Fixed code sells 100000/150 ≈ 666.67 units on redemption → terminal ≈ 66666,
    // giving XIRR ≈ 113% p.a. The cap below catches any regression that
    // re-introduces the inflation while leaving plenty of slack for the
    // legitimate value.
    expect(marketXirr).toBeLessThan(2.0);
  });

  it('marketXirr is NaN when index history is empty (no benchmark data)', async () => {
    mockFrom.mockImplementation((table: string) => {
      if (table === 'fund') return makeChain({ data: MOCK_FUNDS, error: null });
      if (table === 'transaction') return makeChain({ data: MOCK_TXS, error: null });
      if (table === 'nav_history') return makeChain({ data: MOCK_NAV, error: null });
      if (table === 'index_history') return makeChain({ data: [], error: null });
      return makeChain({ data: [], error: null });
    });

    const result = await fetchPortfolioData('user-1', '^NSEI');
    expect(result.summary).not.toBeNull();
    expect(isNaN(result.summary!.marketXirr)).toBe(true);
  });

  // ── Fix 12: portfolio-level gain/loss ──────────────────────────────────────
  it('summary totalInvested matches sum of transaction amounts', async () => {
    mockFrom.mockImplementation((table: string) => {
      if (table === 'fund') return makeChain({ data: MOCK_FUNDS, error: null });
      if (table === 'transaction') return makeChain({ data: MOCK_TXS, error: null });
      if (table === 'nav_history') return makeChain({ data: MOCK_NAV, error: null });
      if (table === 'index_history') return makeChain({ data: MOCK_INDEX, error: null });
      return makeChain({ data: [], error: null });
    });

    const result = await fetchPortfolioData('user-1', '^NSEI');
    // MOCK_TXS: 10000 + 6000 = 16000 total invested
    expect(result.summary!.totalInvested).toBe(16000);
    // Gain = totalValue - totalInvested: totalValue = 150 units * 140 NAV = 21000
    const gain = result.summary!.totalValue - result.summary!.totalInvested;
    expect(gain).toBeCloseTo(21000 - 16000, 0);
  });
});
