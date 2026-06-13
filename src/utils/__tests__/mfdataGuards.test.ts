import {
  isCompositionImplausible,
  isLaunchDateDirectPlanIntroduction,
  isRiskRatioCategoryBlocked,
  readBenchmarkName,
  readFundManager,
  readMfdataAsOfDate,
  readMfdataBeta,
  readMfdataRSquared,
  readMfdataStdDev,
  readOfMaxDrawdown,
  readReturnPct,
  readRiskLabel,
  SEBI_DIRECT_PLAN_INTRODUCTION_DATE,
} from '../mfdataGuards';

describe('isCompositionImplausible', () => {
  it('returns false for clean equity fund (95+0+5+0=100)', () => {
    expect(isCompositionImplausible(95, 0, 5, 0)).toBe(false);
  });

  it('returns false for hybrid fund summing to 100', () => {
    expect(isCompositionImplausible(70, 25, 5, 0)).toBe(false);
  });

  it('returns false at the 105 threshold', () => {
    expect(isCompositionImplausible(60, 30, 10, 5)).toBe(false);
  });

  it('returns true when sum > 105 (benchmark-row pollution)', () => {
    expect(isCompositionImplausible(70, 40, 5, 0)).toBe(true); // 115
  });

  it('treats nulls as zero', () => {
    expect(isCompositionImplausible(95, null, 5, undefined)).toBe(false);
    expect(isCompositionImplausible(95, undefined, 5, undefined)).toBe(false);
  });
});

describe('isRiskRatioCategoryBlocked', () => {
  it('blocks debt categories', () => {
    expect(isRiskRatioCategoryBlocked('Liquid Fund')).toBe(true);
    expect(isRiskRatioCategoryBlocked('Gilt Fund')).toBe(true);
    expect(isRiskRatioCategoryBlocked('Corporate Bond Fund')).toBe(true);
    expect(isRiskRatioCategoryBlocked('Overnight Fund')).toBe(true);
    expect(isRiskRatioCategoryBlocked('Money Market Fund')).toBe(true);
  });

  it('blocks arbitrage', () => {
    expect(isRiskRatioCategoryBlocked('Arbitrage Fund')).toBe(true);
  });

  it('blocks anything starting with "debt"', () => {
    expect(isRiskRatioCategoryBlocked('Debt: Banking and PSU')).toBe(true);
    expect(isRiskRatioCategoryBlocked('debt-something')).toBe(true);
  });

  it('does NOT block equity / hybrid / index', () => {
    expect(isRiskRatioCategoryBlocked('Large Cap Fund')).toBe(false);
    expect(isRiskRatioCategoryBlocked('Aggressive Hybrid Fund')).toBe(false);
    expect(isRiskRatioCategoryBlocked('Index Funds')).toBe(false);
    expect(isRiskRatioCategoryBlocked('ELSS')).toBe(false);
  });

  it('returns false for null / empty category', () => {
    expect(isRiskRatioCategoryBlocked(null)).toBe(false);
    expect(isRiskRatioCategoryBlocked(undefined)).toBe(false);
    expect(isRiskRatioCategoryBlocked('')).toBe(false);
  });

  it('case-insensitive', () => {
    expect(isRiskRatioCategoryBlocked('LIQUID FUND')).toBe(true);
    expect(isRiskRatioCategoryBlocked('Large CAP fund')).toBe(false);
  });
});

describe('isLaunchDateDirectPlanIntroduction', () => {
  it('flags the SEBI direct-plan introduction date', () => {
    expect(isLaunchDateDirectPlanIntroduction(SEBI_DIRECT_PLAN_INTRODUCTION_DATE)).toBe(true);
    expect(isLaunchDateDirectPlanIntroduction('2013-01-01')).toBe(true);
    expect(isLaunchDateDirectPlanIntroduction('2013-01-01T00:00:00Z')).toBe(true);
  });

  it('returns false for any other date', () => {
    expect(isLaunchDateDirectPlanIntroduction('2013-01-02')).toBe(false);
    expect(isLaunchDateDirectPlanIntroduction('2010-05-08')).toBe(false);
    expect(isLaunchDateDirectPlanIntroduction('2020-12-31')).toBe(false);
  });

  it('returns false for null / empty', () => {
    expect(isLaunchDateDirectPlanIntroduction(null)).toBe(false);
    expect(isLaunchDateDirectPlanIntroduction(undefined)).toBe(false);
    expect(isLaunchDateDirectPlanIntroduction('')).toBe(false);
  });
});

describe('readMfdataBeta', () => {
  const blob = { risk: { beta: 0.95, r_squared: 96.7, sortino_ratio: -0.8 } };

  it('returns the beta value for an unblocked category', () => {
    expect(readMfdataBeta(blob, 'Large Cap Fund')).toBe(0.95);
  });

  it('returns null for blocked categories', () => {
    expect(readMfdataBeta(blob, 'Liquid Fund')).toBeNull();
    expect(readMfdataBeta(blob, 'Gilt Fund')).toBeNull();
  });

  it('returns null when blob is missing/malformed', () => {
    expect(readMfdataBeta(null, 'Large Cap Fund')).toBeNull();
    expect(readMfdataBeta({}, 'Large Cap Fund')).toBeNull();
    expect(readMfdataBeta({ risk: null }, 'Large Cap Fund')).toBeNull();
    expect(readMfdataBeta({ risk: { beta: 'oops' } }, 'Large Cap Fund')).toBeNull();
    expect(readMfdataBeta({ risk: { beta: NaN } }, 'Large Cap Fund')).toBeNull();
  });
});

describe('readMfdataRSquared', () => {
  const blob = { risk: { r_squared: 96.7, beta: 0.95 } };

  it('returns r_squared for unblocked category', () => {
    expect(readMfdataRSquared(blob, 'Flexi Cap Fund')).toBe(96.7);
  });

  it('returns null for blocked category', () => {
    expect(readMfdataRSquared(blob, 'Corporate Bond Fund')).toBeNull();
  });
});

describe('readMfdataAsOfDate', () => {
  it('reads the as_of_date string', () => {
    expect(readMfdataAsOfDate({ as_of_date: '2026-05-01' })).toBe('2026-05-01');
  });

  it('returns null when missing or non-string', () => {
    expect(readMfdataAsOfDate({})).toBeNull();
    expect(readMfdataAsOfDate(null)).toBeNull();
    expect(readMfdataAsOfDate({ as_of_date: 123 })).toBeNull();
    expect(readMfdataAsOfDate({ as_of_date: '' })).toBeNull();
  });
});

describe('readReturnPct', () => {
  it('reads OF decimal ret_1y and converts to percentage', () => {
    expect(readReturnPct({ ret_1y: 0.125 }, '1y')).toBeCloseTo(12.5);
  });

  it('reads OF decimal ret_3y and converts to percentage', () => {
    expect(readReturnPct({ ret_3y: 0.15 }, '3y')).toBeCloseTo(15.0);
  });

  it('reads OF decimal ret_5y and converts to percentage', () => {
    expect(readReturnPct({ ret_5y: -0.05 }, '5y')).toBeCloseTo(-5.0);
  });

  it('reads mfdata percentage return_1y as-is', () => {
    expect(readReturnPct({ return_1y: 18.7 }, '1y')).toBeCloseTo(18.7);
  });

  it('reads mfdata return_3y and return_5y', () => {
    expect(readReturnPct({ return_3y: 12.0 }, '3y')).toBeCloseTo(12.0);
    expect(readReturnPct({ return_5y: 9.5 }, '5y')).toBeCloseTo(9.5);
  });

  it('prefers OF format when both keys present', () => {
    expect(readReturnPct({ ret_1y: 0.10, return_1y: 15.0 }, '1y')).toBeCloseTo(10.0);
  });

  it('returns null when key absent', () => {
    expect(readReturnPct({}, '1y')).toBeNull();
    expect(readReturnPct({ ret_3y: 0.12 }, '1y')).toBeNull();
  });

  it('returns null for non-finite values', () => {
    expect(readReturnPct({ ret_1y: NaN }, '1y')).toBeNull();
    expect(readReturnPct({ ret_1y: Infinity }, '1y')).toBeNull();
    expect(readReturnPct({ return_1y: NaN }, '1y')).toBeNull();
  });

  it('returns null for null/non-object inputs', () => {
    expect(readReturnPct(null, '1y')).toBeNull();
    expect(readReturnPct(undefined, '1y')).toBeNull();
    expect(readReturnPct('string', '1y')).toBeNull();
    expect(readReturnPct(42, '1y')).toBeNull();
  });

  it('handles zero return correctly', () => {
    expect(readReturnPct({ ret_1y: 0 }, '1y')).toBeCloseTo(0);
  });
});

describe('readMfdataStdDev', () => {
  const blob = { risk: { std_deviation: 18.5, beta: 0.95, r_squared: 96.7 } };

  it('returns std_deviation as a percentage (MFData convention)', () => {
    expect(readMfdataStdDev(blob)).toBeCloseTo(18.5);
  });

  it('returns null when risk blob is absent', () => {
    expect(readMfdataStdDev({})).toBeNull();
    expect(readMfdataStdDev({ risk: {} })).toBeNull();
  });

  it('returns null for null / non-object inputs', () => {
    expect(readMfdataStdDev(null)).toBeNull();
    expect(readMfdataStdDev(undefined)).toBeNull();
    expect(readMfdataStdDev('string')).toBeNull();
  });

  it('returns null for non-finite values', () => {
    expect(readMfdataStdDev({ risk: { std_deviation: NaN } })).toBeNull();
    expect(readMfdataStdDev({ risk: { std_deviation: Infinity } })).toBeNull();
  });

  it('returns null for negative std_deviation', () => {
    expect(readMfdataStdDev({ risk: { std_deviation: -5 } })).toBeNull();
  });

  it('returns zero std_deviation for constant-NAV funds (theoretical)', () => {
    expect(readMfdataStdDev({ risk: { std_deviation: 0 } })).toBe(0);
  });

  it('has no category gating — returns value for debt/liquid categories too', () => {
    // Unlike beta/r_squared, std_deviation is valid for any fund type
    expect(readMfdataStdDev({ risk: { std_deviation: 1.2 } })).toBeCloseTo(1.2);
  });
});

describe('readOfMaxDrawdown', () => {
  it('returns max_drawdown_5y as a negative decimal', () => {
    expect(readOfMaxDrawdown({ max_drawdown_5y: -0.26 })).toBeCloseTo(-0.26);
  });

  it('returns zero drawdown (theoretical constant NAV)', () => {
    expect(readOfMaxDrawdown({ max_drawdown_5y: 0 })).toBe(0);
  });

  it('returns null when max_drawdown_5y is absent', () => {
    expect(readOfMaxDrawdown({})).toBeNull();
    expect(readOfMaxDrawdown({ volatility: 0.18 })).toBeNull();
  });

  it('returns null for null / non-object inputs', () => {
    expect(readOfMaxDrawdown(null)).toBeNull();
    expect(readOfMaxDrawdown(undefined)).toBeNull();
    expect(readOfMaxDrawdown('string')).toBeNull();
  });

  it('returns null for non-finite values', () => {
    expect(readOfMaxDrawdown({ max_drawdown_5y: NaN })).toBeNull();
    expect(readOfMaxDrawdown({ max_drawdown_5y: Infinity })).toBeNull();
    expect(readOfMaxDrawdown({ max_drawdown_5y: -Infinity })).toBeNull();
  });

  it('returns null for drawdown > 0 (logically invalid)', () => {
    expect(readOfMaxDrawdown({ max_drawdown_5y: 0.1 })).toBeNull();
    expect(readOfMaxDrawdown({ max_drawdown_5y: 0.26 })).toBeNull();
  });

  it('returns null for drawdown ≤ -1 (logically invalid — worse than 100%)', () => {
    expect(readOfMaxDrawdown({ max_drawdown_5y: -1.0 })).toBeNull();
    expect(readOfMaxDrawdown({ max_drawdown_5y: -1.5 })).toBeNull();
  });

  it('has no category gating — valid for any fund type', () => {
    expect(readOfMaxDrawdown({ max_drawdown_5y: -0.15 })).toBeCloseTo(-0.15);
  });

  it('handles extreme but valid drawdowns', () => {
    expect(readOfMaxDrawdown({ max_drawdown_5y: -0.99 })).toBeCloseTo(-0.99);
  });

  it('handles small drawdowns', () => {
    expect(readOfMaxDrawdown({ max_drawdown_5y: -0.001 })).toBeCloseTo(-0.001);
  });
});

// ---------------------------------------------------------------------------
// readRiskLabel
// ---------------------------------------------------------------------------

describe('readRiskLabel', () => {
  // Canonical labels — exact case
  it('returns canonical label for "Low"', () => {
    expect(readRiskLabel('Low')).toBe('Low');
  });

  it('returns canonical label for "Low to Moderate"', () => {
    expect(readRiskLabel('Low to Moderate')).toBe('Low to Moderate');
  });

  it('returns canonical label for "Moderate"', () => {
    expect(readRiskLabel('Moderate')).toBe('Moderate');
  });

  it('returns canonical label for "Moderately High"', () => {
    expect(readRiskLabel('Moderately High')).toBe('Moderately High');
  });

  it('returns canonical label for "High"', () => {
    expect(readRiskLabel('High')).toBe('High');
  });

  it('returns canonical label for "Very High"', () => {
    expect(readRiskLabel('Very High')).toBe('Very High');
  });

  // Case-insensitive normalisation
  it('normalises "Low To Moderate" (48 live rows) → "Low to Moderate"', () => {
    expect(readRiskLabel('Low To Moderate')).toBe('Low to Moderate');
  });

  it('normalises "low to moderate" (all-lowercase) → "Low to Moderate"', () => {
    expect(readRiskLabel('low to moderate')).toBe('Low to Moderate');
  });

  it('normalises "VERY HIGH" → "Very High"', () => {
    expect(readRiskLabel('VERY HIGH')).toBe('Very High');
  });

  it('normalises "moderately high" → "Moderately High"', () => {
    expect(readRiskLabel('moderately high')).toBe('Moderately High');
  });

  // Whitespace trimming
  it('trims leading/trailing whitespace before matching', () => {
    expect(readRiskLabel('  High  ')).toBe('High');
    expect(readRiskLabel('\tModerate\n')).toBe('Moderate');
  });

  // Real junk from live dev DB (2026-06-13)
  it('returns null for OCR shrapnel ("Very High Risk L M o o w de t r o at e")', () => {
    expect(readRiskLabel('Very High Risk L M o o w de t r o at e')).toBeNull();
  });

  it('returns null for free-rate annotation ("free rate assumed to be 5.34%…")', () => {
    expect(readRiskLabel('free rate assumed to be 5.34% (FBIL Overnight MIBOR as on Apr 30, 2026)')).toBeNull();
  });

  it('returns null for suitability paragraph (6 live rows)', () => {
    expect(
      readRiskLabel(
        'This product is suitable for investors who are seeking long-term capital appreciation through investment in equity/equity related instruments in a concentrated portfolio of maximum 30 stocks across market capitalization.',
      ),
    ).toBeNull();
  });

  it('returns null for "and Relatively low Credit Risk" (6 live rows)', () => {
    expect(readRiskLabel('and Relatively low Credit Risk')).toBeNull();
  });

  // "Moderately Low" is not in SEBI's current 6-label set
  it('returns null for non-standard label "Moderately Low"', () => {
    expect(readRiskLabel('Moderately Low')).toBeNull();
  });

  // Null / empty
  it('returns null for null', () => {
    expect(readRiskLabel(null)).toBeNull();
  });

  it('returns null for undefined', () => {
    expect(readRiskLabel(undefined)).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(readRiskLabel('')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// readBenchmarkName
// ---------------------------------------------------------------------------

describe('readBenchmarkName', () => {
  // Clean values pass through
  it('returns a short clean benchmark name as-is', () => {
    expect(readBenchmarkName('Nifty 50 TRI')).toBe('Nifty 50 TRI');
  });

  it('returns benchmark at exactly 120 chars', () => {
    const s = 'A'.repeat(120);
    expect(readBenchmarkName(s)).toBe(s);
  });

  // Length guard
  it('returns null when benchmark exceeds 120 chars', () => {
    expect(readBenchmarkName('A'.repeat(121))).toBeNull();
  });

  it('returns null for 269-char holdings-bleed name from live dev DB', () => {
    const junk =
      'Nifty Large Mid Cap 250 TRI Schaeffler India Ltd 1.0 Devyani international limited 0.3 ZF Commercial Vehicle Control Systems Non - Ferrous Metals 2.4 Coforge Ltd 1.7 Persistent Systems Ltd 1.6 Sona BLW Precision Forgings Ltd 1.3 Equitas Small Finance Bank 1.1';
    expect(readBenchmarkName(junk)).toBeNull();
  });

  // Bleed-pattern guard — real live-DB fixtures
  it('returns null when "portfolio" appears (live: "Additional Benchmark** Annualized Portfolio YTM*")', () => {
    expect(readBenchmarkName('Additional Benchmark** Annualized Portfolio YTM*')).toBeNull();
  });

  it('returns null for portfolio-duration bleed (live junk)', () => {
    expect(
      readBenchmarkName(
        'Duration of the portfolio will be dynamically managed within the range of the 0-7 years.',
      ),
    ).toBeNull();
  });

  it('returns null when "holdings" appears (live: "Nitori Holdings Co Ltd 2.20 Bridgestone Corp 2.75")', () => {
    expect(readBenchmarkName('Nitori Holdings Co Ltd 2.20 Bridgestone Corp 2.75')).toBeNull();
  });

  it('returns null when "% of" appears (live: "65% of Nifty 500 TRI + 20% of…")', () => {
    expect(readBenchmarkName('65% of Nifty 500 TRI + 20% of NIFTY Composite Debt Index')).toBeNull();
  });

  it('returns null when "top 10" appears', () => {
    expect(readBenchmarkName('Top 10 holdings by weight')).toBeNull();
  });

  it('returns null when "aum" appears as a word', () => {
    expect(readBenchmarkName('Portfolio AUM breakdown')).toBeNull();
  });

  // Bleed pattern is case-insensitive
  it('bleed patterns are case-insensitive', () => {
    expect(readBenchmarkName('PORTFOLIO DETAIL')).toBeNull();
    expect(readBenchmarkName('HOLDINGS LIST')).toBeNull();
  });

  // Trimming
  it('trims leading/trailing whitespace before returning', () => {
    expect(readBenchmarkName('  Nifty 50 TRI  ')).toBe('Nifty 50 TRI');
  });

  it('returns null after trimming if result >120 chars', () => {
    const padded = '  ' + 'B'.repeat(121) + '  ';
    expect(readBenchmarkName(padded)).toBeNull();
  });

  // Null / empty
  it('returns null for null', () => {
    expect(readBenchmarkName(null)).toBeNull();
  });

  it('returns null for undefined', () => {
    expect(readBenchmarkName(undefined)).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(readBenchmarkName('')).toBeNull();
  });

  it('returns null for whitespace-only string', () => {
    expect(readBenchmarkName('   ')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// readFundManager
// ---------------------------------------------------------------------------

describe('readFundManager', () => {
  // Clean values pass through
  it('returns a short manager name as-is', () => {
    expect(readFundManager('Prashant Jain')).toBe('Prashant Jain');
  });

  it('returns manager name at exactly 160 chars', () => {
    const s = 'A'.repeat(160);
    expect(readFundManager(s)).toBe(s);
  });

  it('returns a multi-manager string under 160 chars', () => {
    const val = 'Abhishek Gupta (Equity), Mayank Chaturvedi (Overseas Investments)';
    expect(readFundManager(val)).toBe(val);
  });

  // Length guard
  it('returns null when value exceeds 160 chars', () => {
    expect(readFundManager('A'.repeat(161))).toBeNull();
  });

  // Real OCR bleed from live dev DB (2026-06-13)
  it('returns null for 2538-char OCR-bleed string (live: "Abhishek Gupta… Minimum Investment… Load Structure…")', () => {
    const junk =
      'Abhishek Gupta (Equity), Mayank Chaturvedi (Overseas Investments), Minimum Investment1, Lumpsum ₹ 5,000, SIP## Please refer page 85, Additional Purchase ₹ 1,000, Load Structure, Entry load: "NA", Exit load: In respect of each purchase/switch-in of Units within 18 months from the date of allotment...';
    expect(readFundManager(junk)).toBeNull();
  });

  it('returns null for 2358-char bleed string (live: "Neelotpal Sahai…")', () => {
    const junk =
      'Neelotpal Sahai (Equity), Mayank Chaturvedi (Overseas Investments), Minimum Investment1, Lumpsum ₹ 5,000, SIP## Please refer page 85, Additional Purchase ₹ 1,000, Load Structure, Entry load: "NA", Exit load: In respect of each purchase/switch-in';
    expect(readFundManager(junk)).toBeNull();
  });

  // Null / empty
  it('returns null for null', () => {
    expect(readFundManager(null)).toBeNull();
  });

  it('returns null for undefined', () => {
    expect(readFundManager(undefined)).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(readFundManager('')).toBeNull();
  });
});
