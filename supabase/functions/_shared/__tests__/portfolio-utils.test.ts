import {
  isNumericString,
  isDebtDataCorrupted,
  deriveDebtPct,
  isEquityPctPlausible,
  isEquityHoldingsCorrupted,
  deriveSchemeCategoryFromName,
  isGenericSchemeCategory,
  resolveSebiCategory,
  broadCategoryFromSebi,
  normaliseSchemeName,
  selectCategoryFromSiblings,
  type CategoryComposition,
  type DebtHolding,
  type EquityHolding,
  type SiblingCandidateRow,
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
    it('"banking and psu" wins over standalone "psu" (banking-and-psu fund)', () => {
      expect(deriveSchemeCategoryFromName('ICICI Prudential Banking and PSU Debt Fund')).toBe(
        'banking and psu fund',
      );
    });
    it('"gold fund" does not match when "etf" is also in the name', () => {
      // "Gold ETF" → 'other etfs' (etf pattern checked first)
      expect(deriveSchemeCategoryFromName('SBI Gold ETF')).toBe('other etfs');
    });
    it('"medium to long duration" wins over "medium term" and "medium duration"', () => {
      expect(deriveSchemeCategoryFromName('Kotak Medium to Long Duration Fund')).toBe(
        'medium to long duration',
      );
    });
    it('"tax savings" → elss (catches before savings-fund patterns)', () => {
      expect(deriveSchemeCategoryFromName('Mirae Asset Tax Savings Fund')).toBe('elss');
    });
  });

  describe('new patterns (PR: null-category backfill)', () => {
    it('multi-cap (hyphen) → multi cap fund', () => {
      expect(deriveSchemeCategoryFromName('Aditya Birla Sun Life Multi-Cap Fund')).toBe(
        'multi cap fund',
      );
    });
    it('equity hybrid → aggressive hybrid fund', () => {
      expect(deriveSchemeCategoryFromName("Aditya Birla Sun Life Equity Hybrid'95 Fund")).toBe(
        'aggressive hybrid fund',
      );
    });
    it('balanced hyrbrid (typo) → balanced hybrid fund', () => {
      expect(deriveSchemeCategoryFromName('360 ONE Balanced Hyrbrid Fund - Regular Plan - IDCW')).toBe(
        'balanced hybrid fund',
      );
    });
    it('momentum → sectoral/thematic', () => {
      expect(deriveSchemeCategoryFromName('Axis Momentum Fund - Direct Plan - Growth Option')).toBe(
        'sectoral/thematic',
      );
    });
    it('innovation → sectoral/thematic', () => {
      expect(deriveSchemeCategoryFromName('Axis Innovation Fund - Regular Plan - Growth Option')).toBe(
        'sectoral/thematic',
      );
    });
    it('psu (equity theme) → sectoral/thematic', () => {
      expect(deriveSchemeCategoryFromName('Aditya Birla Sun Life PSU Equity Fund')).toBe(
        'sectoral/thematic',
      );
    });
    it('esg → sectoral/thematic', () => {
      expect(deriveSchemeCategoryFromName('Aditya Birla Sun Life ESG Integration Strategy Fund')).toBe(
        'sectoral/thematic',
      );
    });
    it('ethical → sectoral/thematic', () => {
      expect(deriveSchemeCategoryFromName('Tata Ethical Fund - Regular Plan - Growth Option')).toBe(
        'sectoral/thematic',
      );
    });
    it('government securities → gilt fund', () => {
      expect(deriveSchemeCategoryFromName('Franklin India Government Securities Fund - Growth')).toBe(
        'gilt fund',
      );
    });
    it('govenment securities (AMFI typo) → gilt fund', () => {
      expect(
        deriveSchemeCategoryFromName('Aditya Birla Sun Life Govenment Securities Fund - Growth'),
      ).toBe('gilt fund');
    });
    it('money manager → money market fund', () => {
      expect(deriveSchemeCategoryFromName('Aditya Birla Sun Life Money Manager Fund')).toBe(
        'money market fund',
      );
    });
    it('medium term → medium duration fund', () => {
      expect(deriveSchemeCategoryFromName('Aditya Birla Sun Life Medium Term Plan')).toBe(
        'medium duration fund',
      );
    });
    it('strategic bond → dynamic bond fund', () => {
      expect(deriveSchemeCategoryFromName('Axis Strategic Bond Fund - Direct Plan - Growth Option')).toBe(
        'dynamic bond fund',
      );
    });
    it('long term bond → long duration fund', () => {
      expect(deriveSchemeCategoryFromName('ICICI Prudential Long Term Bond Fund - Growth')).toBe(
        'long duration fund',
      );
    });
    it('gold fund (no etf in name) → fund of funds domestic', () => {
      expect(deriveSchemeCategoryFromName('SBI Gold Fund - Regular Plan - Growth')).toBe(
        'fund of funds domestic',
      );
      expect(deriveSchemeCategoryFromName('Aditya Birla Sun Life Gold Fund-Growth')).toBe(
        'fund of funds domestic',
      );
    });
    it('bal bhavishya → solution oriented - childrens', () => {
      expect(deriveSchemeCategoryFromName('Aditya Birla Sun Life Bal Bhavishya Yojna - Direct')).toBe(
        'solution oriented - childrens',
      );
    });
    it('financial services → sectoral/thematic', () => {
      expect(deriveSchemeCategoryFromName('Bandhan Financial Services Fund - Direct Plan - Growth')).toBe(
        'sectoral/thematic',
      );
    });
  });
});

// ---------------------------------------------------------------------------
// resolveSebiCategory
// ---------------------------------------------------------------------------

describe('resolveSebiCategory', () => {
  it('prefers a specific scheme_category (lowercased) over the name', () => {
    // Even if the name says "Mid Cap", a specific category wins as-is.
    expect(resolveSebiCategory('Flexi Cap Fund', 'Foo Mid Cap Fund')).toBe('flexi cap fund');
    expect(resolveSebiCategory('Liquid Fund', null)).toBe('liquid fund');
  });

  it('derives from the name when scheme_category is the bare asset class', () => {
    expect(resolveSebiCategory('Equity', 'DSP Mid Cap Fund - Direct - Growth')).toBe('mid cap fund');
    expect(resolveSebiCategory('Equity', 'DSP Small Cap Fund')).toBe('small cap fund');
    expect(resolveSebiCategory('Debt', 'HDFC Corporate Bond Fund')).toBe('corporate bond fund');
  });

  it('derives from the name when scheme_category is blank/null', () => {
    expect(resolveSebiCategory(null, 'SBI Bluechip Fund')).toBe('large cap fund');
    expect(resolveSebiCategory('', 'Axis ELSS Tax Saver Fund')).toBe('elss');
  });

  it('returns null when neither source disambiguates', () => {
    expect(resolveSebiCategory('Equity', 'Random Scheme XYZ')).toBeNull();
    expect(resolveSebiCategory(null, null)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// broadCategoryFromSebi
// ---------------------------------------------------------------------------

describe('broadCategoryFromSebi', () => {
  it('maps equity sub-buckets to Equity', () => {
    expect(broadCategoryFromSebi('large cap fund')).toBe('Equity');
    expect(broadCategoryFromSebi('mid cap fund')).toBe('Equity');
    expect(broadCategoryFromSebi('elss')).toBe('Equity');
    expect(broadCategoryFromSebi('sectoral/thematic')).toBe('Equity');
    expect(broadCategoryFromSebi('index funds')).toBe('Equity');
  });

  it('maps debt sub-buckets to Debt', () => {
    expect(broadCategoryFromSebi('liquid fund')).toBe('Debt');
    expect(broadCategoryFromSebi('gilt fund')).toBe('Debt');
    expect(broadCategoryFromSebi('corporate bond fund')).toBe('Debt');
  });

  it('maps hybrid + solution-oriented + arbitrage + domestic FoF to Hybrid', () => {
    expect(broadCategoryFromSebi('aggressive hybrid fund')).toBe('Hybrid');
    expect(broadCategoryFromSebi('balanced advantage fund')).toBe('Hybrid');
    expect(broadCategoryFromSebi('arbitrage fund')).toBe('Hybrid');
    expect(broadCategoryFromSebi('equity savings fund')).toBe('Hybrid');
    expect(broadCategoryFromSebi('fund of funds domestic')).toBe('Hybrid');
    expect(broadCategoryFromSebi('solution oriented - retirement')).toBe('Hybrid');
  });

  it('maps overseas FoF to Other', () => {
    expect(broadCategoryFromSebi('fund of funds investing overseas')).toBe('Other');
  });

  it('is case-insensitive and returns null for unknown/blank keys', () => {
    expect(broadCategoryFromSebi('MID CAP FUND')).toBe('Equity');
    expect(broadCategoryFromSebi('not a real key')).toBeNull();
    expect(broadCategoryFromSebi(null)).toBeNull();
    expect(broadCategoryFromSebi('')).toBeNull();
  });

  it('covers every CATEGORY_RULES key the resolver can emit', () => {
    // Guards against a new sub-bucket being added to the name parser without a
    // broad mapping (which would silently leave scheme_category un-normalised).
    const keys = [
      'large cap fund', 'mid cap fund', 'small cap fund', 'multi cap fund',
      'flexi cap fund', 'large & mid cap fund', 'elss', 'value fund',
      'contra fund', 'focused fund', 'sectoral/thematic', 'dividend yield fund',
      'aggressive hybrid fund', 'balanced hybrid fund', 'conservative hybrid fund',
      'balanced advantage fund', 'dynamic asset allocation', 'multi asset allocation',
      'equity savings fund', 'arbitrage fund', 'overnight fund', 'liquid fund',
      'ultra short duration fund', 'low duration fund', 'money market fund',
      'short duration fund', 'medium duration fund', 'medium to long duration',
      'long duration fund', 'dynamic bond fund', 'corporate bond fund',
      'credit risk fund', 'banking and psu fund', 'gilt fund', 'floater fund',
      'index funds', 'other etfs', 'fund of funds investing overseas',
      'fund of funds domestic', 'solution oriented - retirement',
      'solution oriented - childrens',
    ];
    for (const k of keys) {
      expect(broadCategoryFromSebi(k)).not.toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// normaliseSchemeName
// ---------------------------------------------------------------------------

describe('normaliseSchemeName', () => {
  it('strips "- Direct Plan - Growth" suffix', () => {
    expect(normaliseSchemeName('DSP Bond Fund - Direct Plan - Growth')).toBe('dsp bond fund');
  });
  it('strips "- Regular Plan - IDCW" suffix', () => {
    expect(normaliseSchemeName('DSP Bond Fund - Regular Plan - IDCW')).toBe('dsp bond fund');
  });
  it('strips bare "- Growth" suffix (no plan keyword)', () => {
    expect(normaliseSchemeName('DSP Bond Fund - Growth')).toBe('dsp bond fund');
  });
  it('strips bare "- IDCW" suffix', () => {
    expect(normaliseSchemeName('DSP Bond Fund - IDCW')).toBe('dsp bond fund');
  });
  it('strips "- DIRECT - IDCW" (no Plan keyword, no space before dash)', () => {
    expect(normaliseSchemeName('Aditya Birla Sun Life MNC Fund - DIRECT - IDCW')).toBe(
      'aditya birla sun life mnc fund',
    );
  });
  it('strips "- Regular Plan Daily IDCW" (frequency before option)', () => {
    expect(
      normaliseSchemeName(
        'SBI Savings Fund - Regular Plan Daily Income Distribution cum Capital Withdrawal Option (IDCW)',
      ),
    ).toBe('sbi savings fund');
  });
  it('strips "- Growth - Direct Plan" (option before plan type at end)', () => {
    expect(
      normaliseSchemeName('Franklin India Government Securities Fund - Growth - Direct Plan'),
    ).toBe('franklin india government securities fund');
  });
  it('strips "- Direct Plan Growth" (option appended without second dash)', () => {
    expect(normaliseSchemeName('Parag Parikh Flexi Cap Fund - Direct Plan Growth')).toBe(
      'parag parikh flexi cap fund',
    );
  });
  it('handles no suffix at all (unrecognised name format)', () => {
    expect(normaliseSchemeName('SBI Bluechip Fund')).toBe('sbi bluechip fund');
  });
  it('trims leading/trailing whitespace and lower-cases', () => {
    expect(normaliseSchemeName('  HDFC Flexi Cap Fund - Regular Plan - Growth  ')).toBe(
      'hdfc flexi cap fund',
    );
  });
  it('handles Fixed Term Plan series names (strips only plan/option, keeps series)', () => {
    expect(
      normaliseSchemeName(
        'Aditya Birla Sun Life Fixed Term Plan - Series TI (1837 days) - Direct Plan - Growth Option',
      ),
    ).toBe('aditya birla sun life fixed term plan - series ti (1837 days)');
  });
  it('handles -DIRECT (no space before dash)', () => {
    expect(normaliseSchemeName('Aditya Birla Sun Life Digital India Fund -DIRECT - IDCW')).toBe(
      'aditya birla sun life digital india fund',
    );
  });
  it('DSP Savings Fund - Direct Plan - Growth → same base as regular', () => {
    const direct = normaliseSchemeName('DSP Savings Fund - Direct Plan - Growth');
    const regular = normaliseSchemeName('DSP Savings Fund - Regular Plan - Growth');
    expect(direct).toBe(regular);
  });
});

// ---------------------------------------------------------------------------
// selectCategoryFromSiblings
// ---------------------------------------------------------------------------

function makeRow(
  scheme_code: number,
  scheme_name: string,
  amc_name: string,
  sebi_category: string | null = null,
  scheme_category: string | null = null,
): SiblingCandidateRow {
  return { scheme_code, scheme_name, amc_name, sebi_category, scheme_category };
}

describe('selectCategoryFromSiblings', () => {
  const target = makeRow(1, 'DSP Bond Fund - Direct Plan - Growth', 'DSP Mutual Fund');

  it('returns null when target already has sebi_category (never overwrite)', () => {
    const withCat = { ...target, sebi_category: 'medium duration fund' };
    const sibling = makeRow(2, 'DSP Bond Fund - IDCW', 'DSP Mutual Fund', 'medium duration fund', 'Debt');
    expect(selectCategoryFromSiblings(withCat, [sibling])).toBeNull();
  });

  it('returns null when target already has scheme_category (never overwrite)', () => {
    const withCat = { ...target, scheme_category: 'Debt' };
    const sibling = makeRow(2, 'DSP Bond Fund - IDCW', 'DSP Mutual Fund', 'medium duration fund', 'Debt');
    expect(selectCategoryFromSiblings(withCat, [sibling])).toBeNull();
  });

  it('returns null when no candidates match the same base name', () => {
    const unrelated = makeRow(99, 'DSP Savings Fund - IDCW', 'DSP Mutual Fund', 'money market fund', 'Debt');
    expect(selectCategoryFromSiblings(target, [unrelated])).toBeNull();
  });

  it('returns null when candidates have different AMC', () => {
    const wrongAmc = makeRow(2, 'DSP Bond Fund - IDCW', 'ICICI Prudential Mutual Fund', 'medium duration fund', 'Debt');
    expect(selectCategoryFromSiblings(target, [wrongAmc])).toBeNull();
  });

  it('returns null when sibling has null sebi_category', () => {
    const nullCat = makeRow(2, 'DSP Bond Fund - IDCW', 'DSP Mutual Fund', null, 'Debt');
    expect(selectCategoryFromSiblings(target, [nullCat])).toBeNull();
  });

  it('returns null when sibling has null scheme_category', () => {
    const nullCat = makeRow(2, 'DSP Bond Fund - IDCW', 'DSP Mutual Fund', 'medium duration fund', null);
    expect(selectCategoryFromSiblings(target, [nullCat])).toBeNull();
  });

  it('returns category pair when exactly one sibling matches', () => {
    const sibling = makeRow(2, 'DSP Bond Fund - IDCW', 'DSP Mutual Fund', 'medium duration fund', 'Debt');
    expect(selectCategoryFromSiblings(target, [sibling])).toEqual({
      sebi_category: 'medium duration fund',
      scheme_category: 'Debt',
    });
  });

  it('returns category pair when multiple siblings all agree', () => {
    const s1 = makeRow(2, 'DSP Bond Fund - Growth', 'DSP Mutual Fund', 'medium duration fund', 'Debt');
    const s2 = makeRow(3, 'DSP Bond Fund - IDCW', 'DSP Mutual Fund', 'medium duration fund', 'Debt');
    const s3 = makeRow(4, 'DSP Bond Fund - Regular Plan - Growth', 'DSP Mutual Fund', 'medium duration fund', 'Debt');
    expect(selectCategoryFromSiblings(target, [s1, s2, s3])).toEqual({
      sebi_category: 'medium duration fund',
      scheme_category: 'Debt',
    });
  });

  it('returns null when siblings disagree on sebi_category (ambiguous family)', () => {
    const s1 = makeRow(2, 'DSP Bond Fund - Growth', 'DSP Mutual Fund', 'medium duration fund', 'Debt');
    const s2 = makeRow(3, 'DSP Bond Fund - IDCW', 'DSP Mutual Fund', 'dynamic bond fund', 'Debt');
    expect(selectCategoryFromSiblings(target, [s1, s2])).toBeNull();
  });

  it('returns null when siblings disagree on scheme_category (ambiguous family)', () => {
    const s1 = makeRow(2, 'DSP Bond Fund - Growth', 'DSP Mutual Fund', 'medium duration fund', 'Debt');
    const s2 = makeRow(3, 'DSP Bond Fund - IDCW', 'DSP Mutual Fund', 'medium duration fund', 'Hybrid');
    expect(selectCategoryFromSiblings(target, [s1, s2])).toBeNull();
  });

  it('ignores candidates with the same scheme_code as target', () => {
    // The target itself should never be its own sibling.
    const selfRef = makeRow(1, 'DSP Bond Fund - Direct Plan - Growth', 'DSP Mutual Fund', 'medium duration fund', 'Debt');
    expect(selectCategoryFromSiblings(target, [selfRef])).toBeNull();
  });

  it('works for real-world DSP Savings Fund sibling pair', () => {
    const directTarget = makeRow(10, 'DSP Savings Fund - Direct Plan - Growth', 'DSP Mutual Fund');
    const regularSibling = makeRow(11, 'DSP Savings Fund - Regular Plan - Growth', 'DSP Mutual Fund', 'money market fund', 'Debt');
    expect(selectCategoryFromSiblings(directTarget, [regularSibling])).toEqual({
      sebi_category: 'money market fund',
      scheme_category: 'Debt',
    });
  });

  it('returns null for empty candidates array', () => {
    expect(selectCategoryFromSiblings(target, [])).toBeNull();
  });

  it('handles null amc_name on target (treated as empty string AMC)', () => {
    const nullAmcTarget = makeRow(1, 'DSP Bond Fund - Growth', null as unknown as string);
    const sibling = makeRow(2, 'DSP Bond Fund - IDCW', 'DSP Mutual Fund', 'medium duration fund', 'Debt');
    // null AMC !== 'dsp mutual fund' → no match
    expect(selectCategoryFromSiblings(nullAmcTarget, [sibling])).toBeNull();
  });

  it('handles null amc_name on candidate (treated as empty string AMC)', () => {
    const nullAmcSibling = makeRow(
      2,
      'DSP Bond Fund - IDCW',
      null as unknown as string,
      'medium duration fund',
      'Debt',
    );
    // candidate AMC '' !== 'dsp mutual fund' → no match
    expect(selectCategoryFromSiblings(target, [nullAmcSibling])).toBeNull();
  });

  it('matches when both target and candidate have null amc_name', () => {
    const nullAmcTarget = makeRow(1, 'DSP Bond Fund - Growth', null as unknown as string);
    const nullAmcSibling = makeRow(
      2,
      'DSP Bond Fund - IDCW',
      null as unknown as string,
      'medium duration fund',
      'Debt',
    );
    expect(selectCategoryFromSiblings(nullAmcTarget, [nullAmcSibling])).toEqual({
      sebi_category: 'medium duration fund',
      scheme_category: 'Debt',
    });
  });
});
