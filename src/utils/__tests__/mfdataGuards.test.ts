import {
  isCompositionImplausible,
  isLaunchDateDirectPlanIntroduction,
  isRiskRatioCategoryBlocked,
  readMfdataAsOfDate,
  readMfdataBeta,
  readMfdataRSquared,
  readMfdataStdDev,
  readReturnPct,
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
