import {
  BENCHMARK_OPTIONS,
  type AppStore,
  mergePersistedAppState,
  migratePersistedAppState,
} from '../appStore';

const DEFAULT_RETURN_ASSUMPTIONS = { cautious: 8, balanced: 12, growth: 12 };

const DEFAULT_WEALTH_JOURNEY = {
  hasOpened: false,
  hasSavedPlan: false,
  currentSipOverride: null,
  futureSipTarget: null,
  monthlySipIncrease: 0,
  additionalTopUp: 0,
  yearsToRetirement: 15,
  expectedReturn: null,
  expectedReturnPreset: null,
  retirementDurationYears: 25,
  withdrawalRate: 4,
  postRetirementReturn: null,
};

// Defaults seeded by the migration for screen UI preferences (PR #112). Spread
// into each expected migration shape so `toEqual` remains strict.
const SCREEN_UI_DEFAULTS = {
  fundsSortBy: 'currentValue' as const,
  portfolioChartWindow: '1Y' as const,
  moneyTrailSortBy: 'newest' as const,
};

describe('BENCHMARK_OPTIONS', () => {
  it('contains exactly 3 TRI entries — Nifty 50, Nifty 100, Nifty 500', () => {
    expect(BENCHMARK_OPTIONS).toHaveLength(3);
    const symbols = BENCHMARK_OPTIONS.map((b) => b.symbol);
    expect(symbols).toEqual(['^NSEITRI', '^NIFTY100TRI', '^NIFTY500TRI']);
  });

  it('every option is a TRI symbol (Phase 8 — fund NAVs are total-return)', () => {
    for (const opt of BENCHMARK_OPTIONS) {
      expect(opt.symbol).toMatch(/TRI$/);
      expect(opt.label).toMatch(/TRI$/);
    }
  });

  it('drops BSE Sensex and the short-history benchmarks', () => {
    const symbols = BENCHMARK_OPTIONS.map((b) => b.symbol);
    for (const removed of ['^BSESN', '^BSE100', '^BSE500', '^NSEBANK', '^CNXIT', '^NSEI', '^NIFTY100']) {
      expect(symbols).not.toContain(removed);
    }
  });

  it('each option has a non-empty label', () => {
    for (const opt of BENCHMARK_OPTIONS) {
      expect(opt.label.trim().length).toBeGreaterThan(0);
    }
  });
});

describe('Phase 8 benchmark migration (^BSESN → ^NSEITRI, PR → TRI)', () => {
  it('migrates BSE Sensex preference to Nifty 50 TRI', () => {
    const result = migratePersistedAppState({ defaultBenchmarkSymbol: '^BSESN' });
    expect(result.defaultBenchmarkSymbol).toBe('^NSEITRI');
  });

  it('migrates Nifty 50 PR preference to Nifty 50 TRI', () => {
    const result = migratePersistedAppState({ defaultBenchmarkSymbol: '^NSEI' });
    expect(result.defaultBenchmarkSymbol).toBe('^NSEITRI');
  });

  it('migrates Nifty 100 PR preference to Nifty 100 TRI', () => {
    const result = migratePersistedAppState({ defaultBenchmarkSymbol: '^NIFTY100' });
    expect(result.defaultBenchmarkSymbol).toBe('^NIFTY100TRI');
  });

  it('passes TRI preferences through unchanged (idempotent)', () => {
    expect(migratePersistedAppState({ defaultBenchmarkSymbol: '^NSEITRI' }).defaultBenchmarkSymbol)
      .toBe('^NSEITRI');
    expect(migratePersistedAppState({ defaultBenchmarkSymbol: '^NIFTY500TRI' }).defaultBenchmarkSymbol)
      .toBe('^NIFTY500TRI');
  });

  it('falls back to ^NSEITRI for missing / non-string preference', () => {
    expect(migratePersistedAppState({ defaultBenchmarkSymbol: undefined as unknown as string })
      .defaultBenchmarkSymbol).toBe('^NSEITRI');
    expect(migratePersistedAppState({ defaultBenchmarkSymbol: null as unknown as string })
      .defaultBenchmarkSymbol).toBe('^NSEITRI');
    expect(migratePersistedAppState({ defaultBenchmarkSymbol: 42 as unknown as string })
      .defaultBenchmarkSymbol).toBe('^NSEITRI');
  });
});

describe('appColorScheme persistence migration', () => {
  it('defaults missing persisted state to system colour scheme and initializes Wealth Journey state', () => {
    expect(migratePersistedAppState(null)).toEqual({
      appColorScheme: 'system',
      wealthJourney: DEFAULT_WEALTH_JOURNEY,
      returnAssumptions: DEFAULT_RETURN_ASSUMPTIONS,
      goals: [],
      ...SCREEN_UI_DEFAULTS,
    });
  });

  it('preserves a stored light scheme', () => {
    expect(migratePersistedAppState({ appColorScheme: 'light' })).toEqual({
      defaultBenchmarkSymbol: '^NSEITRI',
      appColorScheme: 'light',
      wealthJourney: DEFAULT_WEALTH_JOURNEY,
      returnAssumptions: DEFAULT_RETURN_ASSUMPTIONS,
      goals: [],
      ...SCREEN_UI_DEFAULTS,
    });
  });

  it('preserves a stored dark scheme', () => {
    expect(migratePersistedAppState({ appColorScheme: 'dark' })).toEqual({
      defaultBenchmarkSymbol: '^NSEITRI',
      appColorScheme: 'dark',
      wealthJourney: DEFAULT_WEALTH_JOURNEY,
      returnAssumptions: DEFAULT_RETURN_ASSUMPTIONS,
      goals: [],
      ...SCREEN_UI_DEFAULTS,
    });
  });

  it('falls back to system for unknown scheme values', () => {
    expect(migratePersistedAppState({ appColorScheme: 'sepia' })).toEqual({
      defaultBenchmarkSymbol: '^NSEITRI',
      appColorScheme: 'system',
      wealthJourney: DEFAULT_WEALTH_JOURNEY,
      returnAssumptions: DEFAULT_RETURN_ASSUMPTIONS,
      goals: [],
      ...SCREEN_UI_DEFAULTS,
    });
  });

  it('drops the legacy appDesignMode field and resets to system colour scheme', () => {
    expect(migratePersistedAppState({ appDesignMode: 'clearLens' })).toEqual({
      defaultBenchmarkSymbol: '^NSEITRI',
      appColorScheme: 'system',
      wealthJourney: DEFAULT_WEALTH_JOURNEY,
      returnAssumptions: DEFAULT_RETURN_ASSUMPTIONS,
      goals: [],
      ...SCREEN_UI_DEFAULTS,
    });
    expect(migratePersistedAppState({ appDesignMode: 'classic' })).toEqual({
      defaultBenchmarkSymbol: '^NSEITRI',
      appColorScheme: 'system',
      wealthJourney: DEFAULT_WEALTH_JOURNEY,
      returnAssumptions: DEFAULT_RETURN_ASSUMPTIONS,
      goals: [],
      ...SCREEN_UI_DEFAULTS,
    });
  });

  it('migrates old Editorial v1/v2 designVariant values to system colour scheme', () => {
    expect(migratePersistedAppState({ designVariant: 'v1' })).toEqual({
      defaultBenchmarkSymbol: '^NSEITRI',
      appColorScheme: 'system',
      wealthJourney: DEFAULT_WEALTH_JOURNEY,
      returnAssumptions: DEFAULT_RETURN_ASSUMPTIONS,
      goals: [],
      ...SCREEN_UI_DEFAULTS,
    });
    expect(migratePersistedAppState({ designVariant: 'v2' })).toEqual({
      defaultBenchmarkSymbol: '^NSEITRI',
      appColorScheme: 'system',
      wealthJourney: DEFAULT_WEALTH_JOURNEY,
      returnAssumptions: DEFAULT_RETURN_ASSUMPTIONS,
      goals: [],
      ...SCREEN_UI_DEFAULTS,
    });
  });

  it('routes legacy BSE Sensex preference to Nifty 50 TRI during migration', () => {
    expect(migratePersistedAppState({ defaultBenchmarkSymbol: '^BSESN', designVariant: 'v2' })).toEqual({
      defaultBenchmarkSymbol: '^NSEITRI',
      appColorScheme: 'system',
      wealthJourney: DEFAULT_WEALTH_JOURNEY,
      returnAssumptions: DEFAULT_RETURN_ASSUMPTIONS,
      goals: [],
      ...SCREEN_UI_DEFAULTS,
    });
  });

  it('preserves existing Wealth Journey state during migration', () => {
    expect(migratePersistedAppState({
      appColorScheme: 'light',
      wealthJourney: {
        hasOpened: true,
        hasSavedPlan: true,
        currentSipOverride: 75000,
        futureSipTarget: 125000,
        yearsToRetirement: 20,
      },
    })).toEqual({
      defaultBenchmarkSymbol: '^NSEITRI',
      appColorScheme: 'light',
      wealthJourney: {
        ...DEFAULT_WEALTH_JOURNEY,
        hasOpened: true,
        hasSavedPlan: true,
        currentSipOverride: 75000,
        futureSipTarget: 125000,
        yearsToRetirement: 20,
      },
      returnAssumptions: DEFAULT_RETURN_ASSUMPTIONS,
      goals: [],
      ...SCREEN_UI_DEFAULTS,
    });
  });

  it('sanitizes out-of-range Wealth Journey values during migration', () => {
    expect(migratePersistedAppState({
      appColorScheme: 'dark',
      wealthJourney: {
        hasOpened: true,
        hasSavedPlan: true,
        currentSipOverride: 99_00_00_000,
        futureSipTarget: -100,
        monthlySipIncrease: -99_00_00_000,
        additionalTopUp: 99_00_00_000,
        yearsToRetirement: 1000,
        expectedReturn: 100,
        expectedReturnPreset: 'balanced',
        retirementDurationYears: 1000,
        withdrawalRate: 100,
        postRetirementReturn: 100,
      },
    })).toEqual({
      defaultBenchmarkSymbol: '^NSEITRI',
      appColorScheme: 'dark',
      wealthJourney: {
        ...DEFAULT_WEALTH_JOURNEY,
        hasOpened: true,
        hasSavedPlan: true,
        currentSipOverride: 25_00_000,
        futureSipTarget: 0,
        monthlySipIncrease: -25_00_000,
        additionalTopUp: 10_00_00_000,
        yearsToRetirement: 40,
        expectedReturn: 30,
        expectedReturnPreset: 'balanced',
        retirementDurationYears: 40,
        withdrawalRate: 12,
        postRetirementReturn: 20,
      },
      returnAssumptions: DEFAULT_RETURN_ASSUMPTIONS,
      goals: [],
      ...SCREEN_UI_DEFAULTS,
    });
  });

  it('preserves valid returnAssumptions from persisted state', () => {
    const result = migratePersistedAppState({
      returnAssumptions: { cautious: 7, balanced: 11, growth: 14 },
    });
    expect(result.returnAssumptions).toEqual({ cautious: 7, balanced: 11, growth: 14 });
  });

  it('falls back to defaults for invalid returnAssumptions', () => {
    expect(migratePersistedAppState({ returnAssumptions: null }).returnAssumptions)
      .toEqual(DEFAULT_RETURN_ASSUMPTIONS);
    expect(migratePersistedAppState({ returnAssumptions: 'bad' }).returnAssumptions)
      .toEqual(DEFAULT_RETURN_ASSUMPTIONS);
  });

  it('clamps out-of-range returnAssumptions values', () => {
    const result = migratePersistedAppState({
      returnAssumptions: { cautious: 0, balanced: 50, growth: -5 },
    });
    expect(result.returnAssumptions!.cautious).toBe(1);
    expect(result.returnAssumptions!.balanced).toBe(30);
    expect(result.returnAssumptions!.growth).toBe(1);
  });

  it('migrates persisted goals, preserving valid ones and dropping corrupt ones', () => {
    const result = migratePersistedAppState({
      goals: [
        {
          id: 'g-1',
          name: 'Retirement',
          targetAmount: 1_00_00_000,
          targetDate: '2040-01-01',
          lumpSum: 5_00_000,
          currentMonthly: 25_000,
          returnPreset: 'growth',
          createdAt: '2025-01-01T00:00:00Z',
        },
        null,
        { id: '', name: 'Bad' },
      ],
    });
    expect(result.goals).toHaveLength(1);
    expect(result.goals![0].name).toBe('Retirement');
    expect(result.goals![0].returnPreset).toBe('growth');
  });

  it('defaults invalid returnPreset in goal to balanced', () => {
    const result = migratePersistedAppState({
      goals: [{ id: 'g-1', name: 'Test', returnPreset: 'aggressive' }],
    });
    expect(result.goals![0].returnPreset).toBe('balanced');
  });
});

/**
 * Headline delta formula contract
 *
 * portfolioXirr and marketXirr are DECIMAL fractions (e.g. 0.128 = 12.8%).
 * The PortfolioHeader displays "X.X% ahead/behind" by computing:
 *   delta = Math.abs((xirrRate - marketXirr) * 100)
 *
 * Without the * 100, a 2.84% lead would show as "0.0% ahead" because
 * 0.0284.toFixed(1) === "0.0".
 */
describe('headline delta formula', () => {
  function computeHeadlineDelta(xirrRate: number, marketXirr: number): number {
    return Math.abs((xirrRate - marketXirr) * 100);
  }

  it('renders the correct percentage point difference for realistic XIRRs', () => {
    // Portfolio XIRR 12.80%, Nifty 50 XIRR 9.96% → 2.84% ahead
    const delta = computeHeadlineDelta(0.128, 0.0996);
    expect(delta.toFixed(1)).toBe('2.8');
  });

  it('shows the correct percentage when lagging', () => {
    // Portfolio XIRR 10%, Nifty 100 XIRR 51% → 41.0% behind
    const delta = computeHeadlineDelta(0.10, 0.51);
    expect(delta.toFixed(1)).toBe('41.0');
  });

  it('without * 100 the old bug returns 0.0 for typical XIRR differences', () => {
    // Demonstrates why * 100 is required
    const buggyDelta = Math.abs(0.128 - 0.0996);
    expect(buggyDelta.toFixed(1)).toBe('0.0'); // the old broken behaviour
  });

  it('delta is 0.0 when portfolio exactly matches the benchmark', () => {
    expect(computeHeadlineDelta(0.15, 0.15)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Screen UI preferences (Funds sort/search, Portfolio chart window, Money
// Trail sort) — added in PR #112 to survive desktop ↔ mobile resize where
// the screen component itself swaps wholesale.
// ---------------------------------------------------------------------------

describe('screen UI preferences migration', () => {
  it('preserves a stored fundsSortBy value when valid', () => {
    const result = migratePersistedAppState({ fundsSortBy: 'xirr' });
    expect(result.fundsSortBy).toBe('xirr');
  });

  it('falls back to currentValue for an unknown fundsSortBy value', () => {
    expect(migratePersistedAppState({ fundsSortBy: 'bogus' }).fundsSortBy)
      .toBe('currentValue');
  });

  it('preserves a stored portfolioChartWindow value when valid', () => {
    expect(migratePersistedAppState({ portfolioChartWindow: '5Y' }).portfolioChartWindow)
      .toBe('5Y');
  });

  it('falls back to 1Y for an unknown portfolioChartWindow', () => {
    expect(migratePersistedAppState({ portfolioChartWindow: '7Y' }).portfolioChartWindow)
      .toBe('1Y');
  });

  it('preserves a stored moneyTrailSortBy value when valid', () => {
    expect(migratePersistedAppState({ moneyTrailSortBy: 'amount_desc' }).moneyTrailSortBy)
      .toBe('amount_desc');
  });

  it('falls back to newest for an unknown moneyTrailSortBy', () => {
    expect(migratePersistedAppState({ moneyTrailSortBy: 'random' }).moneyTrailSortBy)
      .toBe('newest');
  });

  it('seeds defaults when fields are missing from persisted state', () => {
    const result = migratePersistedAppState({});
    expect(result.fundsSortBy).toBe('currentValue');
    expect(result.portfolioChartWindow).toBe('1Y');
    expect(result.moneyTrailSortBy).toBe('newest');
  });

  it('does not migrate fundsSearchQuery — it is intentionally session-only', () => {
    const result = migratePersistedAppState({ fundsSearchQuery: 'leftover' });
    expect((result as { fundsSearchQuery?: string }).fundsSearchQuery).toBeUndefined();
  });
});

describe('mergePersistedAppState', () => {
  // Build a runtime store baseline matching the create() defaults — only the
  // fields merge() actually reads/writes need to be realistic.
  const baseRuntime = {
    defaultBenchmarkSymbol: '^NSEITRI',
    appColorScheme: 'system' as const,
    wealthJourney: DEFAULT_WEALTH_JOURNEY,
    returnAssumptions: DEFAULT_RETURN_ASSUMPTIONS,
    goals: [],
    fundsSortBy: 'currentValue' as const,
    fundsSearchQuery: '',
    portfolioChartWindow: '1Y' as const,
    moneyTrailSortBy: 'newest' as const,
  } as unknown as AppStore;

  it('returns runtime defaults when persisted state is null', () => {
    const merged = mergePersistedAppState(null, baseRuntime);
    expect(merged.defaultBenchmarkSymbol).toBe('^NSEITRI');
    expect(merged.appColorScheme).toBe('system');
    expect(merged.fundsSortBy).toBe('currentValue');
    expect(merged.portfolioChartWindow).toBe('1Y');
  });

  it('returns runtime defaults when persisted state is a non-object', () => {
    const merged = mergePersistedAppState('garbage', baseRuntime);
    expect(merged.defaultBenchmarkSymbol).toBe('^NSEITRI');
    expect(merged.appColorScheme).toBe('system');
  });

  it('overlays valid persisted fields onto the runtime baseline', () => {
    const merged = mergePersistedAppState(
      {
        defaultBenchmarkSymbol: '^NIFTY100TRI',
        appColorScheme: 'dark',
        fundsSortBy: 'xirr',
        portfolioChartWindow: '5Y',
        moneyTrailSortBy: 'amount_desc',
      },
      baseRuntime,
    );
    expect(merged.defaultBenchmarkSymbol).toBe('^NIFTY100TRI');
    expect(merged.appColorScheme).toBe('dark');
    expect(merged.fundsSortBy).toBe('xirr');
    expect(merged.portfolioChartWindow).toBe('5Y');
    expect(merged.moneyTrailSortBy).toBe('amount_desc');
  });

  it('routes a legacy ^BSESN persisted benchmark to ^NSEITRI on merge', () => {
    const merged = mergePersistedAppState(
      { defaultBenchmarkSymbol: '^BSESN' },
      baseRuntime,
    );
    expect(merged.defaultBenchmarkSymbol).toBe('^NSEITRI');
  });

  it('falls back to runtime values when persisted fields are missing', () => {
    const customRuntime = {
      ...baseRuntime,
      fundsSortBy: 'invested' as const,
      portfolioChartWindow: '3Y' as const,
      moneyTrailSortBy: 'oldest' as const,
    };
    const merged = mergePersistedAppState({}, customRuntime as unknown as AppStore);
    expect(merged.fundsSortBy).toBe('invested');
    expect(merged.portfolioChartWindow).toBe('3Y');
    expect(merged.moneyTrailSortBy).toBe('oldest');
  });

  it('sanitizes invalid persisted enum values back to safe defaults', () => {
    const merged = mergePersistedAppState(
      {
        fundsSortBy: 'totally-invalid',
        portfolioChartWindow: 'bogus',
        moneyTrailSortBy: 'random',
      },
      baseRuntime,
    );
    expect(merged.fundsSortBy).toBe('currentValue');
    expect(merged.portfolioChartWindow).toBe('1Y');
    expect(merged.moneyTrailSortBy).toBe('newest');
  });

  it('drops fundsSearchQuery on merge — search input never crosses sessions', () => {
    const merged = mergePersistedAppState(
      { fundsSearchQuery: 'leftover query' } as Partial<AppStore>,
      baseRuntime,
    );
    expect(merged.fundsSearchQuery).toBe('');
  });

  it('preserves a partial persisted wealthJourney patch over the default', () => {
    const merged = mergePersistedAppState(
      {
        wealthJourney: {
          ...DEFAULT_WEALTH_JOURNEY,
          yearsToRetirement: 20,
          withdrawalRate: 5,
        },
      },
      baseRuntime,
    );
    expect(merged.wealthJourney.yearsToRetirement).toBe(20);
    expect(merged.wealthJourney.withdrawalRate).toBe(5);
  });
});
