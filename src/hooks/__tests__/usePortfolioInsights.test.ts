jest.mock('@tanstack/react-query', () => ({
  useQuery: jest.fn(),
  useMutation: jest.fn(),
  useQueryClient: jest.fn(),
  // QueryClient / QueryCache / MutationCache are constructed inside
  // `src/lib/queryClient.ts`, which is imported transitively by
  // `usePortfolioInsights` (for `PERSIST_MAX_AGE_MS` and the global
  // auth-error handler wired in PR #132).
  QueryClient: jest.fn().mockImplementation(() => ({})),
  QueryCache: jest.fn().mockImplementation(() => ({})),
  MutationCache: jest.fn().mockImplementation(() => ({})),
}));
jest.mock('@tanstack/query-async-storage-persister', () => ({
  createAsyncStoragePersister: jest.fn(() => ({})),
}));
jest.mock('@/src/utils/fundName', () => ({
  parseFundName: (name: string) => ({ base: name.split(' ')[0], planBadge: null }),
}));

// eslint-disable-next-line import/first -- mocks must register before module imports
import { computeInsights } from '../usePortfolioInsights';
// eslint-disable-next-line import/first
import type { FundPortfolioComposition } from '@/src/types/app';
// eslint-disable-next-line import/first
import type { FundCardData } from '../usePortfolio';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeFundCard(overrides: Partial<FundCardData> = {}): FundCardData {
  return {
    id: 'fund-1',
    schemeCode: 100001,
    schemeName: 'HDFC Large Cap Fund Direct Growth',
    schemeCategory: 'Large Cap Fund',
    currentNav: 100,
    previousNav: 99,
    currentNavDate: '2024-12-01',
    currentUnits: 1000,
    currentValue: 100_000,
    investedAmount: 80_000,
    dailyChangeAmount: 1000,
    dailyChangePct: 1,
    returnXirr: 0.15,
    realizedGain: 0,
    realizedAmount: 0,
    redeemedUnits: 0,
    navHistory30d: [],
    ...overrides,
  } as FundCardData;
}

function makeComposition(overrides: Partial<FundPortfolioComposition> = {}): FundPortfolioComposition {
  return {
    schemeCode: 100001,
    portfolioDate: '2024-11-30',
    equityPct: 95,
    debtPct: 0,
    cashPct: 5,
    otherPct: 0,
    largeCapPct: 80,
    midCapPct: 12,
    smallCapPct: 8,
    notClassifiedPct: 0,
    sectorAllocation: { Financial: 35, Technology: 15, Healthcare: 10 },
    topHoldings: [
      { name: 'HDFC Bank', isin: 'INE040A01034', sector: 'Financial', marketCap: 'Large Cap', pctOfNav: 8 },
      { name: 'Infosys', isin: 'INE009A01021', sector: 'Technology', marketCap: 'Large Cap', pctOfNav: 5 },
    ],
    source: 'amfi',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('computeInsights', () => {
  describe('single fund — full data', () => {
    const fund = makeFundCard();
    const comp = makeComposition();
    const result = computeInsights([fund], [comp]);

    it('sets totalValue to fund currentValue', () => {
      expect(result.totalValue).toBe(100_000);
    });

    it('computes asset mix weighted by fund value', () => {
      expect(result.assetMix.equity).toBeCloseTo(95, 1);
      expect(result.assetMix.debt).toBeCloseTo(0, 1);
      expect(result.assetMix.cash).toBeCloseTo(5, 1);
      expect(result.assetMix.other).toBeCloseTo(0, 1);
    });

    it('normalises market cap mix to sum to ~100%', () => {
      const { large, mid, small, notClassified } = result.marketCapMix;
      const total = large + mid + small + notClassified;
      expect(total).toBeCloseTo(100, 0);
    });

    it('market cap mix reflects composition percentages', () => {
      // 80/12/8 normalised to 100
      expect(result.marketCapMix.large).toBeCloseTo(80, 0);
      expect(result.marketCapMix.mid).toBeCloseTo(12, 0);
      expect(result.marketCapMix.small).toBeCloseTo(8, 0);
    });

    it('returns sector breakdown sorted descending', () => {
      const sectors = result.sectorBreakdown!;
      expect(sectors[0].sector).toBe('Financial');
      expect(sectors[1].sector).toBe('Technology');
      expect(sectors[2].sector).toBe('Healthcare');
    });

    it('attaches ₹ value to each sector', () => {
      const financial = result.sectorBreakdown!.find((s) => s.sector === 'Financial')!;
      // 35% of NAV × 100% fund weight × totalValue
      expect(financial.value).toBeGreaterThan(0);
    });

    it('returns top holdings', () => {
      expect(result.topHoldings).toHaveLength(2);
      expect(result.topHoldings![0].name).toBe('HDFC Bank');
    });

    it('converts holding pctOfNav to portfolio weight %', () => {
      const hdfc = result.topHoldings![0];
      // 8% of NAV × 100% fund weight = 8% portfolio weight
      expect(hdfc.portfolioWeight).toBeCloseTo(8, 1);
    });

    it('uses amfi as dataSource when all compositions are amfi', () => {
      expect(result.dataSource).toBe('amfi');
    });

    it('has no missing data funds', () => {
      expect(result.missingDataFunds).toHaveLength(0);
    });

    it('builds fund allocation with correct pct', () => {
      expect(result.fundAllocation).toHaveLength(1);
      expect(result.fundAllocation[0].pct).toBeCloseTo(100, 1);
      expect(result.fundAllocation[0].value).toBe(100_000);
    });
  });

  describe('two funds — weighted averaging', () => {
    const fundA = makeFundCard({ id: 'a', schemeCode: 100001, schemeName: 'Equity Fund', currentValue: 60_000 });
    const fundB = makeFundCard({ id: 'b', schemeCode: 100002, schemeName: 'Debt Fund', currentValue: 40_000 });

    const compA = makeComposition({
      schemeCode: 100001,
      equityPct: 95, debtPct: 0, cashPct: 5, otherPct: 0,
      sectorAllocation: { Financial: 30, Technology: 20 },
      topHoldings: [
        { name: 'HDFC Bank', isin: 'INE040A01034', sector: 'Financial', marketCap: 'Large Cap', pctOfNav: 10 },
      ],
    });
    const compB = makeComposition({
      schemeCode: 100002,
      equityPct: 0, debtPct: 90, cashPct: 10, otherPct: 0,
      largeCapPct: null, midCapPct: null, smallCapPct: null, notClassifiedPct: null,
      sectorAllocation: null,
      topHoldings: null,
      source: 'category_rules',
    });

    const result = computeInsights([fundA, fundB], [compA, compB]);

    it('totalValue is sum of both funds', () => {
      expect(result.totalValue).toBe(100_000);
    });

    it('weights equity pct: 60% × 95% + 40% × 0% = 57%', () => {
      expect(result.assetMix.equity).toBeCloseTo(57, 1);
    });

    it('weights debt pct: 60% × 0% + 40% × 90% = 36%', () => {
      expect(result.assetMix.debt).toBeCloseTo(36, 1);
    });

    it('weights cash pct: 60% × 5% + 40% × 10% = 7%', () => {
      expect(result.assetMix.cash).toBeCloseTo(7, 1);
    });

    it('uses category_rules as dataSource when any fund has category_rules', () => {
      expect(result.dataSource).toBe('category_rules');
    });

    it('sectors come only from fund with sectorAllocation', () => {
      const sectors = result.sectorBreakdown!;
      expect(sectors.some((s) => s.sector === 'Financial')).toBe(true);
    });

    it('sorts fund allocation by value descending', () => {
      expect(result.fundAllocation[0].value).toBe(60_000);
      expect(result.fundAllocation[1].value).toBe(40_000);
    });
  });

  describe('holding deduplication across funds', () => {
    const fundA = makeFundCard({ id: 'a', schemeCode: 100001, currentValue: 50_000 });
    const fundB = makeFundCard({ id: 'b', schemeCode: 100002, currentValue: 50_000 });

    const sharedHolding = { name: 'HDFC Bank', isin: 'INE040A01034', sector: 'Financial', marketCap: 'Large Cap' as const, pctOfNav: 10 };
    const compA = makeComposition({ schemeCode: 100001, topHoldings: [sharedHolding] });
    const compB = makeComposition({ schemeCode: 100002, topHoldings: [sharedHolding, { name: 'Infosys', isin: 'INE009A01021', sector: 'Technology', marketCap: 'Large Cap' as const, pctOfNav: 8 }] });

    const result = computeInsights([fundA, fundB], [compA, compB]);

    it('deduplicates HDFC Bank from both funds into one holding', () => {
      const hdfcEntries = result.topHoldings!.filter((h) => h.isin === 'INE040A01034');
      expect(hdfcEntries).toHaveLength(1);
    });

    it('aggregates weight of shared holding across both funds', () => {
      const hdfc = result.topHoldings!.find((h) => h.isin === 'INE040A01034')!;
      // 10% pctOfNav × 50% weight from each fund = 5% + 5% = 10% portfolio weight
      expect(hdfc.portfolioWeight).toBeCloseTo(10, 1);
    });

    it('sorts holdings by portfolio weight descending', () => {
      const [first, second] = result.topHoldings!;
      expect(first.portfolioWeight).toBeGreaterThanOrEqual(second.portfolioWeight);
    });
  });

  describe('missing composition data', () => {
    const fund = makeFundCard();
    const result = computeInsights([fund], []); // no compositions

    it('lists funds with no composition data in missingDataFunds', () => {
      expect(result.missingDataFunds).toContain('HDFC Large Cap Fund Direct Growth');
    });

    it('returns null sectorBreakdown when no sector data is present', () => {
      expect(result.sectorBreakdown).toBeNull();
    });

    it('returns null topHoldings when no holdings data is present', () => {
      expect(result.topHoldings).toBeNull();
    });

    it('still computes fund allocation (no composition needed)', () => {
      expect(result.fundAllocation).toHaveLength(1);
      expect(result.fundAllocation[0].pct).toBeCloseTo(100, 1);
    });
  });

  describe('empty portfolio', () => {
    const result = computeInsights([], []);

    it('totalValue is 0', () => {
      expect(result.totalValue).toBe(0);
    });

    it('fund allocation is empty', () => {
      expect(result.fundAllocation).toHaveLength(0);
    });

    it('sector breakdown is null', () => {
      expect(result.sectorBreakdown).toBeNull();
    });
  });

  describe('category_rules sentinel date does not corrupt dataAsOf', () => {
    // category_rules rows use portfolio_date='1900-01-01' (sentinel) to prevent
    // per-day accretion. computeInsights must exclude them from worstDate so the
    // "data as of" label stays anchored to real disclosure dates.
    it('dataAsOf reflects amfi date, not 1900-01-01 sentinel from category_rules fund', () => {
      const fundA = makeFundCard({ id: 'a', schemeCode: 100001, schemeName: 'Equity Fund', currentValue: 91_000 });
      const fundB = makeFundCard({ id: 'b', schemeCode: 100002, schemeName: 'Debt Fund', currentValue: 9_000 });

      const compA = makeComposition({ schemeCode: 100001, portfolioDate: '2026-04-30', source: 'amfi' });
      // Fund B has only category_rules with sentinel date — weight = 9%
      const compB = makeComposition({
        schemeCode: 100002,
        portfolioDate: '1900-01-01',
        source: 'category_rules',
        equityPct: 0, debtPct: 90, cashPct: 10, otherPct: 0,
        largeCapPct: null, midCapPct: null, smallCapPct: null, notClassifiedPct: null,
        sectorAllocation: null, topHoldings: null,
      });

      const result = computeInsights([fundA, fundB], [compA, compB]);
      // dataSource: fund B weight=9% < 10% threshold → 'amfi' (dataAsOf IS shown)
      expect(result.dataSource).toBe('amfi');
      // dataAsOf must come from the amfi row, not the sentinel date
      expect(result.dataAsOf).toBe('2026-04-30');
    });

    it('dataAsOf is not the sentinel 1900-01-01 when all funds have only category_rules', () => {
      const fund = makeFundCard({ currentValue: 100_000 });
      const comp = makeComposition({
        portfolioDate: '1900-01-01',
        source: 'category_rules',
        sectorAllocation: null,
        topHoldings: null,
      });

      const result = computeInsights([fund], [comp]);

      // dataSource = 'category_rules' (100% estimated), so dataAsOf is not
      // rendered by the UI. Confirm worstDate did NOT pick up the sentinel.
      expect(result.dataSource).toBe('category_rules');
      expect(result.dataAsOf).not.toBe('1900-01-01');
      // worstDate falls back to new Date() (today) — just confirm it's
      // in a recognisable year range, not a century ago.
      expect(result.dataAsOf).toMatch(/^20[2-9]\d-/);
    });
  });

  describe('fund with zero currentValue', () => {
    const fund = makeFundCard({ currentValue: 0 });
    const comp = makeComposition();
    const result = computeInsights([fund], [comp]);

    it('excludes zero-value fund from allocation', () => {
      expect(result.fundAllocation).toHaveLength(0);
    });

    it('totalValue is 0', () => {
      expect(result.totalValue).toBe(0);
    });
  });

  describe('market cap normalisation with null caps', () => {
    const fund = makeFundCard({ currentValue: 100_000 });
    const comp = makeComposition({
      largeCapPct: null,
      midCapPct: null,
      smallCapPct: null,
      notClassifiedPct: null,
    });
    const result = computeInsights([fund], [comp]);

    it('market cap mix stays at zero when caps are null', () => {
      const { large, mid, small, notClassified } = result.marketCapMix;
      expect(large + mid + small + notClassified).toBe(0);
    });
  });

  describe('sector breakdown values', () => {
    const fund = makeFundCard({ currentValue: 100_000 });
    const comp = makeComposition({ sectorAllocation: { Financial: 40, Healthcare: 20 } });
    const result = computeInsights([fund], [comp]);

    it('computes ₹ value for each sector correctly', () => {
      const fin = result.sectorBreakdown!.find((s) => s.sector === 'Financial')!;
      // 40% × 1.0 fund weight × 100,000 total → 40,000
      expect(fin.value).toBe(40_000);
    });
  });

  describe('debtFunds', () => {
    it('includes fund with meaningful debt (>=1%) in debtFunds', () => {
      const fund = makeFundCard({ id: 'hybrid', schemeCode: 100001, schemeName: 'DSP Aggressive Hybrid Fund' });
      const comp = makeComposition({ debtPct: 17, cashPct: 16, equityPct: 67 });
      const result = computeInsights([fund], [comp]);
      expect(result.debtFunds).toHaveLength(1);
      expect(result.debtFunds[0].debtPct).toBeCloseTo(17, 1);
      expect(result.debtFunds[0].cashPct).toBeCloseTo(16, 1);
      expect(result.debtFunds[0].portfolioPct).toBeCloseTo(100, 1);
    });

    it('includes fund with cash >= 5% even if debt is 0', () => {
      const fund = makeFundCard();
      const comp = makeComposition({ debtPct: 0, cashPct: 5, equityPct: 95 });
      const result = computeInsights([fund], [comp]);
      expect(result.debtFunds).toHaveLength(1);
    });

    it('excludes pure equity fund with trivial cash (<5%)', () => {
      const fund = makeFundCard();
      const comp = makeComposition({ debtPct: 0, cashPct: 3, equityPct: 97 });
      const result = computeInsights([fund], [comp]);
      expect(result.debtFunds).toHaveLength(0);
    });

    it('sorts debtFunds by portfolio weight descending', () => {
      const fundA = makeFundCard({ id: 'a', schemeCode: 100001, schemeName: 'Hybrid Fund', currentValue: 60_000 });
      const fundB = makeFundCard({ id: 'b', schemeCode: 100002, schemeName: 'Debt Fund', currentValue: 40_000 });
      const compA = makeComposition({ schemeCode: 100001, debtPct: 20, cashPct: 5, equityPct: 75 });
      const compB = makeComposition({ schemeCode: 100002, debtPct: 90, cashPct: 10, equityPct: 0 });
      const result = computeInsights([fundA, fundB], [compA, compB]);
      expect(result.debtFunds[0].portfolioPct).toBeGreaterThan(result.debtFunds[1].portfolioPct);
    });

    it('returns empty debtFunds for pure equity portfolio', () => {
      const fund = makeFundCard();
      const comp = makeComposition({ debtPct: 0, cashPct: 3, equityPct: 97 });
      const result = computeInsights([fund], [comp]);
      expect(result.debtFunds).toHaveLength(0);
    });
  });
});
