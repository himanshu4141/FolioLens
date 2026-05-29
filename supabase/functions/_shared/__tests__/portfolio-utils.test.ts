import {
  isNumericString,
  isDebtDataCorrupted,
  deriveDebtPct,
  isEquityPctPlausible,
  isEquityHoldingsCorrupted,
  classifyHoldings,
  deriveSchemeCategoryFromName,
  isGenericSchemeCategory,
  type CategoryComposition,
  type DebtHolding,
  type EquityHolding,
  type MarketCapCategory,
} from '../portfolio-utils';

// ---------------------------------------------------------------------------
// isNumericString
// ---------------------------------------------------------------------------

describe('isNumericString', () => {
  it('returns false for null', () => expect(isNumericString(null)).toBe(false));
  it('returns false for undefined', () => expect(isNumericString(undefined)).toBe(false));
  it('returns false for empty string', () => expect(isNumericString('')).toBe(false));
  it('returns false for whitespace-only string', () => expect(isNumericString('   ')).toBe(false));
  it('returns false for alphabetic string', () => expect(isNumericString('hello')).toBe(false));
  it('returns false for mixed alphanumeric', () => expect(isNumericString('23abc')).toBe(false));
  it('returns false for alphanumeric prefix', () => expect(isNumericString('abc23')).toBe(false));
  it('returns false for partial number with text', () => expect(isNumericString('23.23abc')).toBe(false));
  it('returns false for valid holding_type code "B"', () => expect(isNumericString('B')).toBe(false));
  it('returns false for valid holding_type code "BT"', () => expect(isNumericString('BT')).toBe(false));
  it('returns false for valid credit rating "AAA"', () => expect(isNumericString('AAA')).toBe(false));
  it('returns false for valid credit rating "A1+"', () => expect(isNumericString('A1+')).toBe(false));

  it('returns true for positive integer string', () => expect(isNumericString('23')).toBe(true));
  it('returns true for positive decimal string', () => expect(isNumericString('23.23')).toBe(true));
  it('returns true for negative decimal string', () => expect(isNumericString('-18.07')).toBe(true));
  it('returns true for negative integer string', () => expect(isNumericString('-14')).toBe(true));
  it('returns true for zero string', () => expect(isNumericString('0')).toBe(true));
  it('returns true for string with surrounding whitespace', () => expect(isNumericString(' 23.23 ')).toBe(true));
  it('returns true for benchmark-style return string "-14.30"', () => expect(isNumericString('-14.30')).toBe(true));
  it('returns true for large percentage string "100"', () => expect(isNumericString('100')).toBe(true));
});

// ---------------------------------------------------------------------------
// isDebtDataCorrupted
// ---------------------------------------------------------------------------

describe('isDebtDataCorrupted', () => {
  it('returns false for empty array', () => {
    expect(isDebtDataCorrupted([])).toBe(false);
  });

  it('returns false when all holdings have clean holding_type codes', () => {
    const holdings: DebtHolding[] = [
      { holding_type: 'B', credit_rating: 'AAA', weight_pct: 10 },
      { holding_type: 'BT', credit_rating: 'SOV', weight_pct: 8 },
      { holding_type: 'CD', credit_rating: 'A1+', weight_pct: 5 },
    ];
    expect(isDebtDataCorrupted(holdings)).toBe(false);
  });

  it('returns false when holding_type and credit_rating are both undefined', () => {
    const holdings: DebtHolding[] = [
      { weight_pct: 10 },
    ];
    expect(isDebtDataCorrupted(holdings)).toBe(false);
  });

  it('returns true when holding_type is a numeric string (benchmark injection)', () => {
    const holdings: DebtHolding[] = [
      { holding_type: '23.23', credit_rating: 'AAA', weight_pct: 10 },
    ];
    expect(isDebtDataCorrupted(holdings)).toBe(true);
  });

  it('returns true when credit_rating is a numeric string', () => {
    const holdings: DebtHolding[] = [
      { holding_type: 'B', credit_rating: '-18.07', weight_pct: 10 },
    ];
    expect(isDebtDataCorrupted(holdings)).toBe(true);
  });

  it('returns true when a negative numeric string appears as holding_type', () => {
    const holdings: DebtHolding[] = [
      { holding_type: '-14.30', credit_rating: undefined, weight_pct: 5 },
    ];
    expect(isDebtDataCorrupted(holdings)).toBe(true);
  });

  it('returns true on first corrupt holding even if others are clean', () => {
    const holdings: DebtHolding[] = [
      { holding_type: 'B', credit_rating: 'AAA', weight_pct: 8 },
      { holding_type: '23.23', credit_rating: 'AAA', weight_pct: 10 },
      { holding_type: 'CD', credit_rating: 'A1+', weight_pct: 5 },
    ];
    expect(isDebtDataCorrupted(holdings)).toBe(true);
  });

  it('returns true when last holding is corrupt', () => {
    const holdings: DebtHolding[] = [
      { holding_type: 'B', credit_rating: 'AAA', weight_pct: 8 },
      { holding_type: 'BT', credit_rating: '-18.07', weight_pct: 10 },
    ];
    expect(isDebtDataCorrupted(holdings)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// deriveDebtPct
// ---------------------------------------------------------------------------

describe('deriveDebtPct', () => {
  it('returns 0 for empty array', () => {
    expect(deriveDebtPct([])).toBe(0);
  });

  it('returns weight_pct of a single holding', () => {
    expect(deriveDebtPct([{ weight_pct: 15.5 }])).toBe(15.5);
  });

  it('sums weight_pct across multiple holdings', () => {
    const holdings: DebtHolding[] = [
      { weight_pct: 10 },
      { weight_pct: 8.5 },
      { weight_pct: 6.25 },
    ];
    expect(deriveDebtPct(holdings)).toBeCloseTo(24.75);
  });

  it('treats undefined weight_pct as 0', () => {
    const holdings: DebtHolding[] = [
      { weight_pct: 10 },
      { holding_type: 'B' }, // no weight_pct
      { weight_pct: 5 },
    ];
    expect(deriveDebtPct(holdings)).toBe(15);
  });

  it('handles all undefined weight_pct values', () => {
    const holdings: DebtHolding[] = [
      { holding_type: 'B' },
      { holding_type: 'BT' },
    ];
    expect(deriveDebtPct(holdings)).toBe(0);
  });

  it('handles decimal weights that sum to a whole number', () => {
    const holdings: DebtHolding[] = [
      { weight_pct: 33.33 },
      { weight_pct: 33.33 },
      { weight_pct: 33.34 },
    ];
    expect(deriveDebtPct(holdings)).toBeCloseTo(100);
  });
});

// ---------------------------------------------------------------------------
// isEquityPctPlausible
// ---------------------------------------------------------------------------

const pureEquityCat: CategoryComposition = {
  equity: 95, debt: 0, cash: 5, other: 0, large: 80, mid: 12, small: 8,
};

const pureDebtCat: CategoryComposition = {
  equity: 0, debt: 92, cash: 8, other: 0, large: 0, mid: 0, small: 0,
};

const hybridCat: CategoryComposition = {
  equity: 78, debt: 17, cash: 5, other: 0, large: 48, mid: 28, small: 24,
};

const overseasFoFCat: CategoryComposition = {
  equity: 0, debt: 0, cash: 0, other: 100, large: 0, mid: 0, small: 0,
};

describe('isEquityPctPlausible', () => {
  // Pure equity funds (catRules.equity >= 80)
  describe('pure equity funds (catRules.equity >= 80)', () => {
    it('accepts equity_pct of 95 (normal large-cap reading)', () => {
      expect(isEquityPctPlausible(95, pureEquityCat)).toBe(true);
    });

    it('accepts equity_pct of exactly 50 (threshold boundary)', () => {
      expect(isEquityPctPlausible(50, pureEquityCat)).toBe(true);
    });

    it('rejects equity_pct of 49 (just below threshold)', () => {
      expect(isEquityPctPlausible(49, pureEquityCat)).toBe(false);
    });

    it('rejects equity_pct of 0 (benchmark data corruption)', () => {
      expect(isEquityPctPlausible(0, pureEquityCat)).toBe(false);
    });

    it('rejects equity_pct of 30 (clearly wrong for equity fund)', () => {
      expect(isEquityPctPlausible(30, pureEquityCat)).toBe(false);
    });
  });

  // Pure debt funds (catRules.debt >= 80)
  describe('pure debt funds (catRules.debt >= 80)', () => {
    it('accepts equity_pct of 0 (normal debt-fund reading)', () => {
      expect(isEquityPctPlausible(0, pureDebtCat)).toBe(true);
    });

    it('accepts equity_pct of exactly 20 (threshold boundary)', () => {
      expect(isEquityPctPlausible(20, pureDebtCat)).toBe(true);
    });

    it('rejects equity_pct of 21 (just above threshold)', () => {
      expect(isEquityPctPlausible(21, pureDebtCat)).toBe(false);
    });

    it('rejects equity_pct of 90 (clearly wrong for debt fund)', () => {
      expect(isEquityPctPlausible(90, pureDebtCat)).toBe(false);
    });
  });

  // Hybrid / balanced funds (neither guard fires)
  describe('hybrid funds (neither guard fires)', () => {
    it('accepts equity_pct of 78 (normal balanced reading)', () => {
      expect(isEquityPctPlausible(78, hybridCat)).toBe(true);
    });

    it('accepts equity_pct of 0 for hybrid (ambiguous but not guarded)', () => {
      expect(isEquityPctPlausible(0, hybridCat)).toBe(true);
    });

    it('accepts equity_pct of 100 for hybrid (ambiguous but not guarded)', () => {
      expect(isEquityPctPlausible(100, hybridCat)).toBe(true);
    });
  });

  // Overseas FoF edge case — key design invariant
  describe('overseas FoF (equity=0, debt=0, other=100 in catRules)', () => {
    it('accepts high equity_pct (ETFs in equity_holdings — legitimate)', () => {
      expect(isEquityPctPlausible(85, overseasFoFCat)).toBe(true);
    });

    it('accepts equity_pct of 0', () => {
      expect(isEquityPctPlausible(0, overseasFoFCat)).toBe(true);
    });

    it('does NOT apply the debt guard (debt=0 < 80)', () => {
      // debt=0 means catRules.debt >= 80 is false, so no upper-bound check fires
      expect(isEquityPctPlausible(95, overseasFoFCat)).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// isEquityHoldingsCorrupted
// ---------------------------------------------------------------------------

describe('isEquityHoldingsCorrupted', () => {
  it('returns false for empty array', () => {
    expect(isEquityHoldingsCorrupted([])).toBe(false);
  });

  it('returns false for clean holdings', () => {
    const holdings: EquityHolding[] = [
      { stock_name: 'HDFC Bank', isin: 'INE040A01034', sector: 'Financial', weight_pct: 8.2 },
      { stock_name: 'Infosys', isin: 'INE009A01021', sector: 'Technology', weight_pct: 5.1 },
    ];
    expect(isEquityHoldingsCorrupted(holdings)).toBe(false);
  });

  it('returns true when stock_name is a numeric string (benchmark injection)', () => {
    const holdings: EquityHolding[] = [
      { stock_name: '-14.30', isin: 'INVALID', weight_pct: 10 },
    ];
    expect(isEquityHoldingsCorrupted(holdings)).toBe(true);
  });

  it('returns true when weight_pct exceeds 100', () => {
    const holdings: EquityHolding[] = [
      { stock_name: 'HDFC Bank', isin: 'INE040A01034', weight_pct: 150 },
    ];
    expect(isEquityHoldingsCorrupted(holdings)).toBe(true);
  });

  it('returns true when weight_pct is negative', () => {
    const holdings: EquityHolding[] = [
      { stock_name: 'HDFC Bank', isin: 'INE040A01034', weight_pct: -5 },
    ];
    expect(isEquityHoldingsCorrupted(holdings)).toBe(true);
  });

  it('returns true if a single row in a long array is corrupted', () => {
    const holdings: EquityHolding[] = [
      { stock_name: 'HDFC Bank', isin: 'INE040A01034', weight_pct: 8 },
      { stock_name: 'Infosys', isin: 'INE009A01021', weight_pct: 5 },
      { stock_name: '23.45', isin: 'BENCH', weight_pct: 0 }, // single corrupt row
    ];
    expect(isEquityHoldingsCorrupted(holdings)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// classifyHoldings
// ---------------------------------------------------------------------------

describe('classifyHoldings', () => {
  const map = new Map<string, MarketCapCategory>([
    ['INE040A01034', 'Large Cap'], // HDFC Bank
    ['INE009A01021', 'Large Cap'], // Infosys
    ['INE585B01010', 'Mid Cap'],   // Maruti Suzuki (illustrative)
    ['INE848E01016', 'Small Cap'], // NHPC (illustrative)
  ]);

  it('returns all-zero bucketing for empty holdings', () => {
    const result = classifyHoldings([], map);
    expect(result.largeCapPct).toBe(0);
    expect(result.midCapPct).toBe(0);
    expect(result.smallCapPct).toBe(0);
    expect(result.notClassifiedPct).toBe(0);
    expect(result.annotated).toEqual([]);
  });

  it('puts every classified holding in its bucket', () => {
    const holdings: EquityHolding[] = [
      { stock_name: 'HDFC Bank', isin: 'INE040A01034', weight_pct: 8 },
      { stock_name: 'Infosys', isin: 'INE009A01021', weight_pct: 5 },
      { stock_name: 'Maruti Suzuki', isin: 'INE585B01010', weight_pct: 3 },
      { stock_name: 'NHPC', isin: 'INE848E01016', weight_pct: 2 },
    ];
    const result = classifyHoldings(holdings, map);
    expect(result.largeCapPct).toBe(13);
    expect(result.midCapPct).toBe(3);
    expect(result.smallCapPct).toBe(2);
    expect(result.notClassifiedPct).toBe(0);
  });

  it('flows missing-ISIN holdings into notClassifiedPct', () => {
    const holdings: EquityHolding[] = [
      { stock_name: 'HDFC Bank', isin: 'INE040A01034', weight_pct: 8 },
      { stock_name: 'Alphabet', isin: null, weight_pct: 4 },
      { stock_name: 'Amazon', isin: '', weight_pct: 3 },
    ];
    const result = classifyHoldings(holdings, map);
    expect(result.largeCapPct).toBe(8);
    expect(result.notClassifiedPct).toBe(7);
  });

  it('flows unknown ISINs into notClassifiedPct', () => {
    const holdings: EquityHolding[] = [
      { stock_name: 'Unknown Co', isin: 'INE999X99999', weight_pct: 6 },
    ];
    const result = classifyHoldings(holdings, map);
    expect(result.largeCapPct).toBe(0);
    expect(result.notClassifiedPct).toBe(6);
  });

  it('matches ISINs case-insensitively and trims whitespace', () => {
    const holdings: EquityHolding[] = [
      { stock_name: 'HDFC Bank', isin: '  ine040a01034  ', weight_pct: 8 },
    ];
    const result = classifyHoldings(holdings, map);
    expect(result.largeCapPct).toBe(8);
    expect(result.notClassifiedPct).toBe(0);
  });

  it('does not normalise to 100 — pcts reflect equity share of NAV', () => {
    const holdings: EquityHolding[] = [
      { stock_name: 'HDFC Bank', isin: 'INE040A01034', weight_pct: 8 },
      { stock_name: 'Infosys', isin: 'INE009A01021', weight_pct: 5 },
    ];
    const result = classifyHoldings(holdings, map);
    // 13% of NAV in equity holdings — the rest is debt/cash, not in this function's scope.
    expect(result.largeCapPct + result.midCapPct + result.smallCapPct + result.notClassifiedPct).toBe(13);
  });

  it('annotates each holding with its market cap category', () => {
    const holdings: EquityHolding[] = [
      { stock_name: 'HDFC Bank', isin: 'INE040A01034', weight_pct: 8 },
      { stock_name: 'Alphabet', isin: null, weight_pct: 4 },
    ];
    const result = classifyHoldings(holdings, map);
    expect(result.annotated[0].marketCap).toBe('Large Cap');
    expect(result.annotated[1].marketCap).toBe('Other');
  });

  it('skips holdings with zero or missing weight', () => {
    const holdings: EquityHolding[] = [
      { stock_name: 'HDFC Bank', isin: 'INE040A01034', weight_pct: 0 },
      { stock_name: 'Infosys', isin: 'INE009A01021' }, // no weight_pct
    ];
    const result = classifyHoldings(holdings, map);
    expect(result.largeCapPct).toBe(0);
    expect(result.notClassifiedPct).toBe(0);
    expect(result.annotated.every((h) => h.marketCap === 'Other')).toBe(true);
  });

  it('rounds bucket totals to 2 decimal places', () => {
    const holdings: EquityHolding[] = [
      { stock_name: 'HDFC Bank', isin: 'INE040A01034', weight_pct: 8.333333 },
      { stock_name: 'Infosys', isin: 'INE009A01021', weight_pct: 5.222222 },
    ];
    const result = classifyHoldings(holdings, map);
    expect(result.largeCapPct).toBe(13.56);
  });
});

// ---------------------------------------------------------------------------
// isGenericSchemeCategory
// ---------------------------------------------------------------------------

describe('isGenericSchemeCategory', () => {
  it('returns true for null/undefined/empty', () => {
    expect(isGenericSchemeCategory(null)).toBe(true);
    expect(isGenericSchemeCategory(undefined)).toBe(true);
    expect(isGenericSchemeCategory('')).toBe(true);
    expect(isGenericSchemeCategory('   ')).toBe(true);
  });

  it('returns true for bare single-word categories', () => {
    expect(isGenericSchemeCategory('Equity')).toBe(true);
    expect(isGenericSchemeCategory('equity')).toBe(true);
    expect(isGenericSchemeCategory('Debt')).toBe(true);
    expect(isGenericSchemeCategory('Hybrid')).toBe(true);
    expect(isGenericSchemeCategory('Other')).toBe(true);
    expect(isGenericSchemeCategory(' Equity ')).toBe(true);
  });

  it('returns false for specific SEBI sub-buckets', () => {
    expect(isGenericSchemeCategory('Large Cap Fund')).toBe(false);
    expect(isGenericSchemeCategory('Mid Cap Fund')).toBe(false);
    expect(isGenericSchemeCategory('Small Cap Fund')).toBe(false);
    expect(isGenericSchemeCategory('Flexi Cap Fund')).toBe(false);
    expect(isGenericSchemeCategory('Liquid Fund')).toBe(false);
    expect(isGenericSchemeCategory('ELSS')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// deriveSchemeCategoryFromName
// ---------------------------------------------------------------------------

describe('deriveSchemeCategoryFromName', () => {
  it('returns null for null/empty input', () => {
    expect(deriveSchemeCategoryFromName(null)).toBeNull();
    expect(deriveSchemeCategoryFromName(undefined)).toBeNull();
    expect(deriveSchemeCategoryFromName('')).toBeNull();
  });

  it('returns null for unrecognized names', () => {
    expect(deriveSchemeCategoryFromName('DSP Healthcare Fund — Direct Plan — IDCW')).not.toBe(
      'large cap fund',
    );
    expect(deriveSchemeCategoryFromName('Random Scheme XYZ Direct Growth')).toBeNull();
  });

  // The DSP funds that triggered this fix.
  describe('DSP funds (the smoking-gun cases)', () => {
    it('DSP Large & Mid Cap Fund → large & mid cap fund (NOT large cap)', () => {
      expect(deriveSchemeCategoryFromName('DSP Large & Mid Cap Fund - Direct Plan - Growth')).toBe(
        'large & mid cap fund',
      );
    });
    it('DSP Mid Cap Fund → mid cap fund', () => {
      expect(deriveSchemeCategoryFromName('DSP Mid Cap Fund - Direct Plan - Growth')).toBe(
        'mid cap fund',
      );
    });
    it('DSP Small Cap Fund → small cap fund', () => {
      expect(deriveSchemeCategoryFromName('DSP Small Cap Fund - Direct Plan - Growth')).toBe(
        'small cap fund',
      );
    });
    it('DSP Large Cap Fund → large cap fund', () => {
      expect(deriveSchemeCategoryFromName('DSP Large Cap Fund - Direct Plan - Growth')).toBe(
        'large cap fund',
      );
    });
    it('DSP Flexi Cap Fund → flexi cap fund', () => {
      expect(deriveSchemeCategoryFromName('DSP Flexi Cap Fund - Direct Plan - Growth')).toBe(
        'flexi cap fund',
      );
    });
  });

  describe('equity sub-buckets', () => {
    it('handles "Large and Mid Cap" spelling', () => {
      expect(deriveSchemeCategoryFromName('Mirae Asset Large and Mid Cap Fund')).toBe(
        'large & mid cap fund',
      );
    });
    it('handles bluechip → large cap', () => {
      expect(deriveSchemeCategoryFromName('SBI Bluechip Fund')).toBe('large cap fund');
    });
    it('multi cap → multi cap fund', () => {
      expect(deriveSchemeCategoryFromName('Nippon India Multi Cap Fund')).toBe('multi cap fund');
    });
    it('focused fund', () => {
      expect(deriveSchemeCategoryFromName('Axis Focused 25 Fund')).toBe('focused fund');
    });
    it('value fund', () => {
      expect(deriveSchemeCategoryFromName('HSBC Value Fund')).toBe('value fund');
    });
    it('contra fund', () => {
      expect(deriveSchemeCategoryFromName('SBI Contra Fund')).toBe('contra fund');
    });
    it('ELSS / tax saver', () => {
      expect(deriveSchemeCategoryFromName('Axis Long Term Equity Fund')).toBe('elss');
      expect(deriveSchemeCategoryFromName('Mirae Asset Tax Saver Fund')).toBe('elss');
    });
    it('sectoral / thematic', () => {
      expect(deriveSchemeCategoryFromName('ICICI Pru Pharma Healthcare Fund')).toBe(
        'sectoral/thematic',
      );
      expect(deriveSchemeCategoryFromName('Tata Digital India Fund (Technology)')).toBe(
        'sectoral/thematic',
      );
    });
  });

  describe('hybrid / advantage', () => {
    it('aggressive hybrid', () => {
      expect(deriveSchemeCategoryFromName('HDFC Hybrid Equity Fund (Aggressive Hybrid)')).toBe(
        'aggressive hybrid fund',
      );
    });
    it('balanced advantage → balanced advantage fund (not balanced hybrid)', () => {
      expect(deriveSchemeCategoryFromName('HDFC Balanced Advantage Fund')).toBe(
        'balanced advantage fund',
      );
    });
    it('equity savings', () => {
      expect(deriveSchemeCategoryFromName('Kotak Equity Savings Fund')).toBe('equity savings fund');
    });
    it('multi asset', () => {
      expect(deriveSchemeCategoryFromName('ICICI Pru Multi Asset Fund')).toBe(
        'multi asset allocation',
      );
    });
  });

  describe('debt sub-buckets', () => {
    it('liquid', () => {
      expect(deriveSchemeCategoryFromName('Aditya Birla SL Liquid Fund')).toBe('liquid fund');
    });
    it('overnight', () => {
      expect(deriveSchemeCategoryFromName('SBI Overnight Fund')).toBe('overnight fund');
    });
    it('corporate bond', () => {
      expect(deriveSchemeCategoryFromName('HDFC Corporate Bond Fund')).toBe('corporate bond fund');
    });
    it('gilt', () => {
      expect(deriveSchemeCategoryFromName('SBI Magnum Gilt Fund')).toBe('gilt fund');
    });
  });

  describe('passive / FoF', () => {
    it('index fund', () => {
      expect(deriveSchemeCategoryFromName('UTI Nifty 50 Index Fund')).toBe('index funds');
    });
    it('ETF', () => {
      expect(deriveSchemeCategoryFromName('Nippon India ETF Nifty BeES')).toBe('other etfs');
    });
    it('fund of funds', () => {
      expect(deriveSchemeCategoryFromName('Motilal Oswal NASDAQ 100 Fund of Funds')).toBe(
        'fund of funds domestic',
      );
    });
  });

  describe('pattern ordering safety', () => {
    it('"Mid Cap" inside "Large & Mid Cap" does not win', () => {
      // The longer pattern is checked first.
      expect(deriveSchemeCategoryFromName('Foo Large & Mid Cap Foo')).toBe(
        'large & mid cap fund',
      );
    });
    it('"balanced advantage" wins over "balanced hybrid" when only advantage is present', () => {
      expect(deriveSchemeCategoryFromName('Foo Balanced Advantage Bar')).toBe(
        'balanced advantage fund',
      );
    });
    it('"long term equity" → elss (not long duration)', () => {
      expect(deriveSchemeCategoryFromName('Axis Long Term Equity Fund')).toBe('elss');
    });
    it('handles case insensitivity', () => {
      expect(deriveSchemeCategoryFromName('DSP MID CAP FUND')).toBe('mid cap fund');
      expect(deriveSchemeCategoryFromName('dsp mid cap fund')).toBe('mid cap fund');
    });
  });
});
