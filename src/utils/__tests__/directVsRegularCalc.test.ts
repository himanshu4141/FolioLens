import {
  buildPlanBreakdown,
  computeCostImpact,
  detectPlanType,
  projectFutureValue,
  type FundPlanRow,
} from '../directVsRegularCalc';

describe('detectPlanType', () => {
  it('detects "Direct Plan" anywhere in the name', () => {
    expect(detectPlanType('DSP Large & Mid Cap Fund - Direct Plan - Growth')).toBe('direct');
  });

  it('detects "Regular Plan" anywhere in the name', () => {
    expect(detectPlanType('Axis Bluechip Fund - Regular Plan - Growth')).toBe('regular');
  });

  it('is case-insensitive', () => {
    expect(detectPlanType('AXIS BLUECHIP FUND - REGULAR PLAN - GROWTH')).toBe('regular');
    expect(detectPlanType('axis bluechip fund - direct plan - growth')).toBe('direct');
  });

  it('returns "unknown" when neither marker is present', () => {
    expect(detectPlanType('Mirae Asset Emerging Bluechip')).toBe('unknown');
  });

  it('returns "unknown" for null / empty input', () => {
    expect(detectPlanType(null)).toBe('unknown');
    expect(detectPlanType(undefined)).toBe('unknown');
    expect(detectPlanType('')).toBe('unknown');
  });

  it('does not false-match the word "direct" outside the "Direct Plan" phrase', () => {
    expect(detectPlanType('Direct Equity Fund - Regular Plan - Growth')).toBe('regular');
    expect(detectPlanType('Regular Income Fund - Direct Plan - Growth')).toBe('direct');
  });
});

describe('projectFutureValue', () => {
  it('returns the corpus when years = 0', () => {
    expect(projectFutureValue(1_00_000, 10_000, 0, 0.10)).toBe(1_00_000);
  });

  it('grows a one-time corpus over 10 years at 10% to ~2.59x', () => {
    // (1.10)^10 ≈ 2.5937
    const fv = projectFutureValue(1_00_000, 0, 10, 0.10);
    expect(fv).toBeCloseTo(1_00_000 * Math.pow(1.10, 10), 0);
  });

  it('grows a SIP-only stream over 10 years (no starting corpus)', () => {
    const fv = projectFutureValue(0, 10_000, 10, 0.10);
    // ~₹20.65L at 10% annual / 10y / ₹10K SIP
    expect(fv).toBeGreaterThan(15_00_000);
    expect(fv).toBeLessThan(25_00_000);
  });

  it('handles a 0% return (FV = corpus + total SIP)', () => {
    const fv = projectFutureValue(1_00_000, 10_000, 5, 0);
    expect(fv).toBeCloseTo(1_00_000 + 10_000 * 60, 0);
  });

  it('handles a negative starting corpus gracefully (clamped to 0)', () => {
    const fv = projectFutureValue(-5_00_000, 10_000, 5, 0.10);
    expect(fv).toBeGreaterThan(0);
    // Compare to the all-SIP case to make sure the corpus term didn't pull it negative
    const sipOnly = projectFutureValue(0, 10_000, 5, 0.10);
    expect(fv).toBeCloseTo(sipOnly, 0);
  });
});

describe('computeCostImpact', () => {
  it('regular FV is below direct FV when the delta is positive', () => {
    const r = computeCostImpact({
      currentCorpus: 5_00_000,
      monthlySip: 10_000,
      years: 10,
      directAnnualReturn: 0.10,
      expenseRatioDelta: 0.01,
    });
    expect(r.regularFutureValue).toBeLessThan(r.directFutureValue);
    expect(r.impact).toBeCloseTo(r.directFutureValue - r.regularFutureValue, 4);
    expect(r.impactPct).toBeGreaterThan(0);
  });

  it('zero delta = zero impact', () => {
    const r = computeCostImpact({
      currentCorpus: 5_00_000,
      monthlySip: 10_000,
      years: 10,
      directAnnualReturn: 0.10,
      expenseRatioDelta: 0,
    });
    expect(r.impact).toBeCloseTo(0, 2);
    expect(r.impactPct).toBeCloseTo(0, 2);
  });

  it('larger horizons compound the impact', () => {
    const small = computeCostImpact({
      currentCorpus: 5_00_000, monthlySip: 10_000, years: 5,
      directAnnualReturn: 0.10, expenseRatioDelta: 0.0075,
    });
    const big = computeCostImpact({
      currentCorpus: 5_00_000, monthlySip: 10_000, years: 20,
      directAnnualReturn: 0.10, expenseRatioDelta: 0.0075,
    });
    expect(big.impact).toBeGreaterThan(small.impact);
    expect(big.impactPct).toBeGreaterThan(small.impactPct);
  });

  it('a 70bps delta over 10y on ₹5L + ₹10K SIP is in the right order of magnitude', () => {
    const r = computeCostImpact({
      currentCorpus: 5_00_000,
      monthlySip: 10_000,
      years: 10,
      directAnnualReturn: 0.10,
      expenseRatioDelta: 0.007,
    });
    // Sanity: somewhere between ₹50K and ₹5L for these inputs
    expect(r.impact).toBeGreaterThan(50_000);
    expect(r.impact).toBeLessThan(5_00_000);
  });

  it('clamps regular return to no worse than -99% so projection is finite', () => {
    const r = computeCostImpact({
      currentCorpus: 5_00_000, monthlySip: 0, years: 5,
      directAnnualReturn: 0.10, expenseRatioDelta: 5,
    });
    expect(Number.isFinite(r.regularFutureValue)).toBe(true);
    expect(Number.isFinite(r.impact)).toBe(true);
  });
});

describe('buildPlanBreakdown', () => {
  function fund(id: string, name: string, value: number, er?: number, planType?: 'direct' | 'regular' | 'unknown'): FundPlanRow {
    return { id, schemeName: name, currentValue: value, expenseRatio: er, planType };
  }

  it('buckets funds correctly using scheme-name detection', () => {
    const result = buildPlanBreakdown([
      fund('a', 'DSP - Direct Plan - Growth', 1_00_000),
      fund('b', 'HDFC - Regular Plan - Growth', 50_000),
      fund('c', 'Mystery Scheme', 25_000),
    ]);
    expect(result.direct).toHaveLength(1);
    expect(result.regular).toHaveLength(1);
    expect(result.unknown).toHaveLength(1);
    expect(result.directValue).toBe(1_00_000);
    expect(result.regularValue).toBe(50_000);
    expect(result.unknownValue).toBe(25_000);
    expect(result.totalValue).toBe(1_75_000);
  });

  it('respects an explicit planType override on the row', () => {
    const result = buildPlanBreakdown([
      fund('a', 'Mystery Scheme', 1_00_000, 1.0, 'regular'),
    ]);
    expect(result.regular).toHaveLength(1);
    expect(result.unknown).toHaveLength(0);
  });

  it('computes weighted expense ratio across funds that have one', () => {
    const result = buildPlanBreakdown([
      fund('a', 'A - Direct Plan - Growth', 80_000, 0.5),
      fund('b', 'B - Regular Plan - Growth', 20_000, 1.5),
    ]);
    // (0.5 × 80K + 1.5 × 20K) / 100K = 0.7
    expect(result.weightedExpenseRatio).toBeCloseTo(0.7, 6);
  });

  it('returns null weighted expense ratio when no fund has one', () => {
    const result = buildPlanBreakdown([
      fund('a', 'A - Direct Plan - Growth', 80_000),
    ]);
    expect(result.weightedExpenseRatio).toBeNull();
  });

  it('handles an empty input', () => {
    const result = buildPlanBreakdown([]);
    expect(result.totalValue).toBe(0);
    expect(result.direct).toHaveLength(0);
    expect(result.regular).toHaveLength(0);
    expect(result.unknown).toHaveLength(0);
    expect(result.weightedExpenseRatio).toBeNull();
  });

  it('clamps negative currentValue to 0 in the totals', () => {
    const result = buildPlanBreakdown([
      fund('a', 'A - Direct Plan - Growth', -1_00_000),
    ]);
    expect(result.directValue).toBe(0);
  });
});
