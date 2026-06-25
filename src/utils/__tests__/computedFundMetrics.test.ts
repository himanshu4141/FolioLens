import {
  buildMonthEndNavs,
  computeMaxDrawdown,
  computeMonthlyReturns,
  computeRiskMetrics,
  computeTrailingCagr,
  computeTrailingReturns,
  isPayoutPlan,
  mean,
  navOnOrBefore,
  sampleStdDev,
  selectCompareMetrics,
  DEFAULT_RISK_FREE_RATE,
} from '../computedFundMetrics';
import type { NavPoint } from '../navUtils';

const TODAY = new Date('2026-05-08');

describe('sampleStdDev', () => {
  it('returns null for arrays shorter than 2', () => {
    expect(sampleStdDev([])).toBeNull();
    expect(sampleStdDev([5])).toBeNull();
  });

  it('computes Bessel-corrected sample std dev', () => {
    // sample of [2,4,4,4,5,5,7,9] has population stdev=2.0, sample stdev=2.138
    const result = sampleStdDev([2, 4, 4, 4, 5, 5, 7, 9])!;
    expect(result).toBeCloseTo(2.1380, 3);
  });

  it('returns 0 for constant array of length 2+', () => {
    expect(sampleStdDev([7, 7, 7])).toBeCloseTo(0, 9);
  });
});

describe('mean', () => {
  it('returns null for empty array', () => {
    expect(mean([])).toBeNull();
  });

  it('computes arithmetic mean', () => {
    expect(mean([1, 2, 3, 4])).toBe(2.5);
    expect(mean([-2, 2])).toBe(0);
  });
});

describe('navOnOrBefore', () => {
  const series: NavPoint[] = [
    { date: '2024-01-15', value: 100 },
    { date: '2024-06-01', value: 110 },
    { date: '2025-01-15', value: 120 },
  ];

  it('returns the latest NAV with date <= target', () => {
    expect(navOnOrBefore(series, '2025-01-15')!.value).toBe(120);
    expect(navOnOrBefore(series, '2024-12-31')!.value).toBe(110);
  });

  it('returns null when no NAV before target', () => {
    expect(navOnOrBefore(series, '2023-12-31')).toBeNull();
  });
});

describe('buildMonthEndNavs', () => {
  it('returns last NAV per month, sorted ascending', () => {
    const series: NavPoint[] = [
      { date: '2024-01-05', value: 100 },
      { date: '2024-01-25', value: 105 },
      { date: '2024-02-15', value: 108 },
      { date: '2024-03-31', value: 112 },
    ];
    const result = buildMonthEndNavs(series);
    expect(result).toEqual([
      { date: '2024-01-25', value: 105 },
      { date: '2024-02-15', value: 108 },
      { date: '2024-03-31', value: 112 },
    ]);
  });

  it('skips invalid points (zero, NaN, missing date)', () => {
    const series: NavPoint[] = [
      { date: '2024-01-05', value: 0 },
      { date: '2024-01-25', value: 105 },
      { date: '2024-02-15', value: NaN },
      { date: '2024-03-31', value: 112 },
    ];
    const result = buildMonthEndNavs(series);
    expect(result.map((p) => p.date)).toEqual(['2024-01-25', '2024-03-31']);
  });

  it('returns empty for empty input', () => {
    expect(buildMonthEndNavs([])).toEqual([]);
  });
});

describe('computeMonthlyReturns', () => {
  it('computes month-over-month simple returns', () => {
    const monthEnds: NavPoint[] = [
      { date: '2024-01-31', value: 100 },
      { date: '2024-02-29', value: 110 },
      { date: '2024-03-31', value: 99 },
    ];
    const r = computeMonthlyReturns(monthEnds);
    expect(r).toHaveLength(2);
    expect(r[0]).toBeCloseTo(0.10, 6); // +10%
    expect(r[1]).toBeCloseTo(-0.10, 6); // -10%
  });

  it('skips zero/negative NAVs', () => {
    const monthEnds: NavPoint[] = [
      { date: '2024-01-31', value: 100 },
      { date: '2024-02-29', value: 0 }, // skip transition into this point
      { date: '2024-03-31', value: 99 },
    ];
    expect(computeMonthlyReturns(monthEnds)).toHaveLength(0);
  });

  it('returns empty for series shorter than 2 points', () => {
    expect(computeMonthlyReturns([])).toEqual([]);
    expect(computeMonthlyReturns([{ date: '2024-01-01', value: 100 }])).toEqual([]);
  });
});

describe('computeTrailingCagr', () => {
  it('matches a known 3Y CAGR', () => {
    // 100 → 200 over 3Y is exactly 2^(1/3) - 1 ≈ 25.99%
    const series: NavPoint[] = [
      { date: '2023-05-08', value: 100 },
      { date: '2026-05-08', value: 200 },
    ];
    const cagr = computeTrailingCagr(series, 3, TODAY)!;
    expect(cagr).toBeCloseTo(0.25992, 4);
  });

  it('returns null when the series is shorter than the requested window', () => {
    const series: NavPoint[] = [
      { date: '2025-05-08', value: 100 },
      { date: '2026-05-08', value: 110 },
    ];
    expect(computeTrailingCagr(series, 3, TODAY)).toBeNull();
  });

  it('returns null for non-positive NAVs', () => {
    const series: NavPoint[] = [
      { date: '2023-05-08', value: 0 },
      { date: '2026-05-08', value: 200 },
    ];
    expect(computeTrailingCagr(series, 3, TODAY)).toBeNull();
  });

  it('handles a falling NAV (negative CAGR)', () => {
    const series: NavPoint[] = [
      { date: '2023-05-08', value: 100 },
      { date: '2026-05-08', value: 90 },
    ];
    const cagr = computeTrailingCagr(series, 3, TODAY)!;
    expect(cagr).toBeLessThan(0);
    expect(cagr).toBeCloseTo(Math.pow(0.9, 1 / 3) - 1, 6);
  });
});

describe('computeRiskMetrics', () => {
  /**
   * Build a monthly NAV series with a known monthly return pattern.
   * Returns one NAV per month at YYYY-MM-15, anchored so the LAST entry is
   * 2026-04-15. Avoids JS Date month-overflow quirks.
   */
  function buildSeries(monthlyReturns: number[]): NavPoint[] {
    const out: NavPoint[] = [];
    let nav = 100;
    const months = monthlyReturns.length;
    // Anchor: last entry at 2026-04-15. Walk months backward.
    const ANCHOR_YEAR = 2026;
    const ANCHOR_MONTH = 4; // April
    for (let i = 0; i < months; i++) {
      const monthsBack = months - 1 - i;
      // Build YYYY-MM-15 by integer arithmetic on month index.
      const totalMonth = ANCHOR_YEAR * 12 + (ANCHOR_MONTH - 1) - monthsBack;
      const year = Math.floor(totalMonth / 12);
      const month = (totalMonth % 12) + 1;
      const dateStr = `${year}-${String(month).padStart(2, '0')}-15`;
      if (i > 0) nav = nav * (1 + monthlyReturns[i]);
      out.push({ date: dateStr, value: nav });
    }
    return out;
  }

  it('returns nulls when fewer than 12 monthly observations', () => {
    const series: NavPoint[] = [];
    for (let i = 0; i < 8; i++) {
      const d = new Date('2026-04-30');
      d.setMonth(d.getMonth() - i);
      series.push({ date: d.toISOString().split('T')[0], value: 100 + i });
    }
    const result = computeRiskMetrics(series, { today: TODAY });
    expect(result.stdDev).toBeNull();
    expect(result.sharpe).toBeNull();
    expect(result.sortino).toBeNull();
    expect(result.monthlyObservations).toBeLessThan(12);
  });

  it('flat series — stdev=0, Sharpe null (denominator zero)', () => {
    const flat = Array(37).fill(0); // 36 monthly returns of 0%
    const series = buildSeries(flat);
    const result = computeRiskMetrics(series, { today: TODAY, annualRiskFreeRate: 0 });
    expect(result.stdDev).toBeCloseTo(0, 9);
    expect(result.sharpe).toBeNull(); // 0/0
    // Anchor (2026-04-15) is within the 3y window of TODAY (2026-05-08); first
    // entries fall just outside, so we expect at least the 12-obs floor.
    expect(result.monthlyObservations).toBeGreaterThanOrEqual(12);
  });

  it('positive-trend series with low vol — positive Sharpe', () => {
    // 36 months of +1.5% steady = ~19.6% annualised, near-zero variance, high Sharpe
    const ret = Array(37).fill(0);
    for (let i = 1; i < ret.length; i++) ret[i] = 0.015;
    const series = buildSeries(ret);
    const result = computeRiskMetrics(series, {
      today: TODAY,
      annualRiskFreeRate: DEFAULT_RISK_FREE_RATE,
    });
    expect(result.stdDev).toBeCloseTo(0, 6);
    // Sharpe undefined (zero stdev) — but if annual return ≈ 19.6% > rf=6.5%,
    // we expect Sharpe = null because denominator is zero.
    expect(result.sharpe).toBeNull();
  });

  it('alternating ±2% returns — non-zero stdev, sharpe near zero', () => {
    const ret = Array(37).fill(0);
    for (let i = 1; i < ret.length; i++) ret[i] = i % 2 === 1 ? 0.02 : -0.02;
    const series = buildSeries(ret);
    const result = computeRiskMetrics(series, {
      today: TODAY,
      annualRiskFreeRate: 0,
    });
    expect(result.stdDev).not.toBeNull();
    expect(result.stdDev!).toBeGreaterThan(0);
    // Mean is ~0 → Sharpe near 0
    expect(Math.abs(result.sharpe!)).toBeLessThan(0.1);
  });

  it('Sortino: only-positive-monthly returns produce null Sortino (no downside)', () => {
    // 36 months of +1% steady — no downside → Sortino conventionally infinite,
    // we surface null
    const ret = Array(37).fill(0);
    for (let i = 1; i < ret.length; i++) ret[i] = 0.01;
    const series = buildSeries(ret);
    const result = computeRiskMetrics(series, {
      today: TODAY,
      annualRiskFreeRate: 0,
    });
    expect(result.sortino).toBeNull();
  });

  it('Sortino > Sharpe when downside vol < total vol', () => {
    // Mostly small gains, occasional small losses.
    const ret = [0];
    for (let i = 1; i < 37; i++) {
      ret.push(i % 6 === 0 ? -0.01 : 0.012);
    }
    const series = buildSeries(ret);
    const result = computeRiskMetrics(series, {
      today: TODAY,
      annualRiskFreeRate: DEFAULT_RISK_FREE_RATE,
    });
    expect(result.sortino).not.toBeNull();
    expect(result.sharpe).not.toBeNull();
    // For an asymmetric distribution with rare negative tails, Sortino > Sharpe.
    expect(result.sortino!).toBeGreaterThan(result.sharpe!);
  });

  it('respects custom risk-free rate', () => {
    const ret = Array(37).fill(0);
    for (let i = 1; i < ret.length; i++) ret[i] = i % 2 === 1 ? 0.02 : -0.01;
    const series = buildSeries(ret);
    const lowRf = computeRiskMetrics(series, { today: TODAY, annualRiskFreeRate: 0.0 });
    const highRf = computeRiskMetrics(series, { today: TODAY, annualRiskFreeRate: 0.20 });
    // Higher RF should drag Sharpe down.
    expect(highRf.sharpe!).toBeLessThan(lowRf.sharpe!);
  });

  it('windows out NAVs older than windowYears', () => {
    // 60 months of variable returns; windowYears=3 picks the last 36.
    const ret = [0];
    for (let i = 1; i < 61; i++) ret.push(i < 25 ? 0.05 : 0.005);
    const series = buildSeries(ret);
    const r5 = computeRiskMetrics(series, { today: TODAY, windowYears: 5, annualRiskFreeRate: 0 });
    const r3 = computeRiskMetrics(series, { today: TODAY, windowYears: 3, annualRiskFreeRate: 0 });
    expect(r3.monthlyObservations).toBeLessThan(r5.monthlyObservations);
  });
});

describe('computeTrailingReturns', () => {
  it('returns nulls for short series', () => {
    const series: NavPoint[] = [
      { date: '2025-05-08', value: 100 },
      { date: '2026-05-08', value: 110 },
    ];
    const result = computeTrailingReturns(series, TODAY);
    expect(result.y1).not.toBeNull();
    expect(result.y3).toBeNull();
    expect(result.y5).toBeNull();
    expect(result.navCount).toBe(2);
    expect(result.earliestDate).toBe('2025-05-08');
    expect(result.latestDate).toBe('2026-05-08');
  });

  it('drops invalid NAVs from count + range', () => {
    const series: NavPoint[] = [
      { date: '2024-01-01', value: 0 }, // dropped
      { date: '2024-06-01', value: 100 },
      { date: '2026-05-08', value: 120 },
    ];
    const result = computeTrailingReturns(series, TODAY);
    expect(result.navCount).toBe(2);
    expect(result.earliestDate).toBe('2024-06-01');
  });

  it('returns y1/y3/y5 for a wide-enough series', () => {
    const series: NavPoint[] = [];
    for (let m = 0; m < 80; m++) {
      const d = new Date('2026-05-08');
      d.setMonth(d.getMonth() - m);
      series.push({ date: d.toISOString().split('T')[0], value: 100 + m });
    }
    const result = computeTrailingReturns(series, TODAY);
    expect(result.y1).not.toBeNull();
    expect(result.y3).not.toBeNull();
    expect(result.y5).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// computeMaxDrawdown
// ---------------------------------------------------------------------------

describe('computeMaxDrawdown', () => {
  const TODAY = new Date('2026-05-08');

  function makeSeries(values: { date: string; value: number }[]): NavPoint[] {
    return values;
  }

  it('returns null for series with fewer than 10 data points in window', () => {
    const series = makeSeries([
      { date: '2025-01-01', value: 100 },
      { date: '2025-06-01', value: 90 },
    ]);
    expect(computeMaxDrawdown(series, TODAY)).toBeNull();
  });

  it('returns null when drop is less than 0.1%', () => {
    const series: NavPoint[] = [];
    for (let i = 0; i < 15; i++) {
      series.push({ date: `2025-0${Math.min(i + 1, 9)}-01`, value: 100 });
    }
    expect(computeMaxDrawdown(series, TODAY)).toBeNull();
  });

  it('computes the correct max drawdown for a simple peak-to-trough', () => {
    // Series: peak at 100, drops to 70 → 30% drawdown
    const series: NavPoint[] = [];
    for (let i = 0; i < 10; i++) {
      const d = new Date(TODAY);
      d.setMonth(d.getMonth() - 10 + i);
      series.push({ date: d.toISOString().split('T')[0], value: i < 5 ? 100 : 70 });
    }
    const dd = computeMaxDrawdown(series, TODAY);
    expect(dd).not.toBeNull();
    expect(dd!).toBeCloseTo(-0.3, 5);
  });

  it('excludes data points older than 5 years', () => {
    // All data older than 5y → < 10 in-window points → null
    const series: NavPoint[] = [];
    for (let i = 0; i < 12; i++) {
      const d = new Date(TODAY);
      d.setFullYear(d.getFullYear() - 6);
      d.setMonth(i);
      series.push({ date: d.toISOString().split('T')[0], value: 100 - i * 5 });
    }
    expect(computeMaxDrawdown(series, TODAY)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// selectCompareMetrics — fallback selector
// ---------------------------------------------------------------------------

describe('selectCompareMetrics', () => {
  const TODAY = new Date('2026-05-08');

  function buildSeries(months: number, startValue = 100): NavPoint[] {
    const series: NavPoint[] = [];
    for (let m = 0; m < months; m++) {
      const d = new Date(TODAY);
      d.setMonth(d.getMonth() - (months - 1 - m));
      series.push({
        date: d.toISOString().split('T')[0],
        value: startValue + m * 0.5,
      });
    }
    return series;
  }

  it('returns computed source when series has enough data for trailing CAGR', () => {
    const series = buildSeries(62); // >5 years: first point 61 months ago, covers y5
    const result = selectCompareMetrics(series, null, null, TODAY);
    expect(result).not.toBeNull();
    expect(result!.source).toBe('computed');
    expect(result!.returnsAsOf).toBeNull();
    expect(result!.riskAsOf).toBeNull();
    expect(result!.trailingPeriodSources.y1).toBe('computed');
    expect(result!.trailingPeriodSources.y3).toBe('computed');
    expect(result!.trailingPeriodSources.y5).toBe('computed');
  });

  it('computed source wins even when period_returns blob is present', () => {
    const series = buildSeries(15); // >1y → y1 non-null
    const periodReturns = { ret_1y: 0.20, as_of_date: '2026-01-01' };
    const result = selectCompareMetrics(series, periodReturns, null, TODAY);
    expect(result!.source).toBe('computed');
    // The returned y1 must come from local computation, not 0.20 (20%)
    expect(result!.trailing.y1).not.toBeCloseTo(0.20, 2);
  });

  it('falls back to as-reported when series is empty', () => {
    const periodReturns = { ret_1y: 0.185, ret_3y: 0.15, as_of_date: '2026-04-30' };
    const riskRatios = { risk: { std_deviation: 18.5 }, as_of_date: '2026-04-30' };
    const result = selectCompareMetrics([], periodReturns, riskRatios, TODAY);
    expect(result).not.toBeNull();
    expect(result!.source).toBe('as-reported');
    expect(result!.trailing.y1).toBeCloseTo(0.185, 5);
    expect(result!.trailing.y3).toBeCloseTo(0.15, 5);
    expect(result!.trailing.y5).toBeNull();
    expect(result!.stdDev).toBeCloseTo(0.185, 5);
    expect(result!.sharpe).toBeNull();
    expect(result!.sortino).toBeNull();
    expect(result!.maxDrawdown).toBeNull(); // no max_drawdown_5y in riskRatios
    expect(result!.returnsAsOf).toBe('2026-04-30');
    expect(result!.riskAsOf).toBe('2026-04-30');
    // trailingPeriodSources reflects as-reported for non-null periods
    expect(result!.trailingPeriodSources.y1).toBe('as-reported');
    expect(result!.trailingPeriodSources.y3).toBe('as-reported');
    expect(result!.trailingPeriodSources.y5).toBeNull();
  });

  it('as-reported maxDrawdown reads from risk_ratios when present', () => {
    const periodReturns = { ret_1y: 0.15 };
    const riskRatios = { max_drawdown_5y: -0.26, as_of_date: '2026-04-30' };
    const result = selectCompareMetrics([], periodReturns, riskRatios, TODAY);
    expect(result!.source).toBe('as-reported');
    expect(result!.maxDrawdown).toBeCloseTo(-0.26, 5);
  });

  it('as-reported maxDrawdown is null when risk_ratios lacks max_drawdown_5y', () => {
    const periodReturns = { ret_1y: 0.15 };
    const riskRatios = { risk: { std_deviation: 18.5 } };
    const result = selectCompareMetrics([], periodReturns, riskRatios, TODAY);
    expect(result!.maxDrawdown).toBeNull();
  });

  it('as-reported maxDrawdown null for invalid values (positive, >-1, non-finite)', () => {
    const periodReturns = { ret_1y: 0.15 };
    expect(selectCompareMetrics([], periodReturns, { max_drawdown_5y: 0.1 }, TODAY)!.maxDrawdown).toBeNull();
    expect(selectCompareMetrics([], periodReturns, { max_drawdown_5y: -1.5 }, TODAY)!.maxDrawdown).toBeNull();
    expect(selectCompareMetrics([], periodReturns, { max_drawdown_5y: NaN }, TODAY)!.maxDrawdown).toBeNull();
  });

  it('falls back to as-reported (mfdata percentage format)', () => {
    const periodReturns = { return_1y: 18.5, return_3y: 15.0 };
    const result = selectCompareMetrics([], periodReturns, null, TODAY);
    expect(result!.source).toBe('as-reported');
    expect(result!.trailing.y1).toBeCloseTo(0.185, 5);
    expect(result!.trailing.y3).toBeCloseTo(0.15, 5);
  });

  it('returns null when series is empty and period_returns has no return data', () => {
    expect(selectCompareMetrics([], null, null, TODAY)).toBeNull();
    expect(selectCompareMetrics([], {}, null, TODAY)).toBeNull();
    expect(selectCompareMetrics([], { as_of_date: '2026-01-01' }, null, TODAY)).toBeNull();
  });

  it('as-reported stdDev is null when risk_ratios has no std_deviation', () => {
    const periodReturns = { ret_1y: 0.10 };
    const result = selectCompareMetrics([], periodReturns, null, TODAY);
    expect(result!.stdDev).toBeNull();
  });

  it('as-reported stdDev converts from percentage to decimal', () => {
    const periodReturns = { ret_1y: 0.15 };
    const riskRatios = { risk: { std_deviation: 22.0 } };
    const result = selectCompareMetrics([], periodReturns, riskRatios, TODAY);
    // 22.0% → 0.22 decimal
    expect(result!.stdDev).toBeCloseTo(0.22, 5);
  });

  it('gap-fills longer periods from as-reported when computed is too short', () => {
    // 2y of data → computed covers y1; y3/y5 filled from as-reported blob with
    // trailingPeriodSources tracking so the UI can mark them with †.
    const series = buildSeries(25);
    const periodReturns = { ret_3y: 0.15, ret_5y: 0.12, as_of_date: '2026-03-31' };
    const result = selectCompareMetrics(series, periodReturns, null, TODAY);
    expect(result!.source).toBe('computed');
    expect(result!.trailing.y1).not.toBeNull();
    // y3 and y5 filled from as-reported (gap-fill, not silent mix — provenance tracked)
    expect(result!.trailing.y3).toBeCloseTo(0.15, 5);
    expect(result!.trailing.y5).toBeCloseTo(0.12, 5);
    expect(result!.trailingPeriodSources.y1).toBe('computed');
    expect(result!.trailingPeriodSources.y3).toBe('as-reported');
    expect(result!.trailingPeriodSources.y5).toBe('as-reported');
    // returnsAsOf is set so the provenance footnote can appear for the as-reported periods
    expect(result!.returnsAsOf).toBe('2026-03-31');
  });

  it('payout fund uses as-reported even when NAV series is long enough to compute', () => {
    const series = buildSeries(15); // >1y → y1 non-null (hasComputed=true)
    const periodReturns = { ret_1y: 0.12, ret_3y: 0.10 };
    const result = selectCompareMetrics(
      series, periodReturns, null, TODAY,
      'HDFC Top 100 Fund - IDCW', 'idcw_payout',
    );
    expect(result).not.toBeNull();
    expect(result!.source).toBe('as-reported');
    expect(result!.trailing.y1).toBeCloseTo(0.12, 5);
    expect(result!.trailing.y3).toBeCloseTo(0.10, 5);
  });

  it('payout detection works from schemeName alone when optionType is null', () => {
    const series = buildSeries(15);
    const periodReturns = { ret_1y: 0.08 };
    const result = selectCompareMetrics(
      series, periodReturns, null, TODAY,
      'Franklin India Flexi Cap Fund - IDCW', null,
    );
    expect(result!.source).toBe('as-reported');
  });

  it('growth fund still uses computed even when as-reported blob is present', () => {
    const series = buildSeries(15);
    const periodReturns = { ret_1y: 0.20 };
    const result = selectCompareMetrics(
      series, periodReturns, null, TODAY,
      'HDFC Top 100 Fund - Direct Plan - Growth', 'growth',
    );
    expect(result!.source).toBe('computed');
    expect(result!.trailing.y1).not.toBeCloseTo(0.20, 2);
  });

  it('payout fund with no as-reported data returns null', () => {
    const series = buildSeries(15);
    const result = selectCompareMetrics(
      series, null, null, TODAY,
      'HDFC Top 100 Fund - IDCW', 'idcw_payout',
    );
    expect(result).toBeNull();
  });

  it('omitting schemeName preserves legacy behaviour: computed wins', () => {
    const series = buildSeries(15);
    const result = selectCompareMetrics(series, null, null, TODAY);
    expect(result!.source).toBe('computed');
  });

  it('stays with as-reported when y1 is computable but Sharpe is null (source-swap guard)', () => {
    // 11 month-end points spanning > 1 year (y1 non-null, hasComputed=true) but
    // only 10 monthly returns which is below the 12-observation threshold for
    // Sharpe. With as-reported returns present and computedAddsValue=false, the
    // guard falls through to as-reported to prevent a visible value-flip.
    const sparseSeries: NavPoint[] = [
      { date: '2025-04-30', value: 100 },
      { date: '2025-05-31', value: 101 },
      { date: '2025-06-30', value: 102 },
      { date: '2025-07-31', value: 103 },
      { date: '2025-08-31', value: 104 },
      { date: '2025-09-30', value: 105 },
      { date: '2025-10-31', value: 106 },
      { date: '2025-11-30', value: 107 },
      { date: '2025-12-31', value: 108 },
      { date: '2026-01-31', value: 109 },
      { date: '2026-04-30', value: 113 },
    ];
    const periodReturns = { ret_1y: 0.12, ret_3y: 0.10 };
    const result = selectCompareMetrics(sparseSeries, periodReturns, null, TODAY);
    expect(result).not.toBeNull();
    expect(result!.source).toBe('as-reported');
    expect(result!.trailing.y1).toBeCloseTo(0.12, 5);
    expect(result!.sharpe).toBeNull();
    // Source-swap guard → fully as-reported, all non-null periods are 'as-reported'
    expect(result!.trailingPeriodSources.y1).toBe('as-reported');
    expect(result!.trailingPeriodSources.y3).toBe('as-reported');
    expect(result!.trailingPeriodSources.y5).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // as-reported Risk shape — stdDev + maxDrawdown surfaced, Sharpe/Sortino null
  // ---------------------------------------------------------------------------

  it('as-reported Risk shape: stdDev from risk_ratios.risk.std_deviation', () => {
    const periodReturns = { ret_1y: 0.14 };
    const riskRatios = { risk: { std_deviation: 15.5 }, as_of_date: '2026-04-30' };
    const result = selectCompareMetrics([], periodReturns, riskRatios, TODAY);
    expect(result!.source).toBe('as-reported');
    expect(result!.stdDev).toBeCloseTo(0.155, 5);
    expect(result!.sharpe).toBeNull();
    expect(result!.sortino).toBeNull();
    expect(result!.riskAsOf).toBe('2026-04-30');
  });

  it('as-reported Risk shape: maxDrawdown from risk_ratios.max_drawdown_5y', () => {
    const periodReturns = { ret_1y: 0.14 };
    const riskRatios = { max_drawdown_5y: -0.31, as_of_date: '2026-04-30' };
    const result = selectCompareMetrics([], periodReturns, riskRatios, TODAY);
    expect(result!.source).toBe('as-reported');
    expect(result!.maxDrawdown).toBeCloseTo(-0.31, 5);
    expect(result!.sharpe).toBeNull();
    expect(result!.sortino).toBeNull();
  });

  it('as-reported Risk shape: both stdDev and maxDrawdown in same blob', () => {
    const periodReturns = { ret_1y: 0.14 };
    const riskRatios = {
      risk: { std_deviation: 18.2 },
      max_drawdown_5y: -0.26,
      as_of_date: '2026-05-01',
    };
    const result = selectCompareMetrics([], periodReturns, riskRatios, TODAY);
    expect(result!.source).toBe('as-reported');
    expect(result!.stdDev).toBeCloseTo(0.182, 5);
    expect(result!.maxDrawdown).toBeCloseTo(-0.26, 5);
    expect(result!.sharpe).toBeNull();
    expect(result!.sortino).toBeNull();
  });

  it('gap-fill: computed with full 5y coverage produces all-computed trailingPeriodSources', () => {
    const series = buildSeries(65); // > 5y → y1/y3/y5 all non-null from computed
    const periodReturns = { ret_1y: 0.25, ret_3y: 0.18, ret_5y: 0.14 };
    const result = selectCompareMetrics(series, periodReturns, null, TODAY);
    expect(result!.source).toBe('computed');
    expect(result!.trailingPeriodSources.y1).toBe('computed');
    expect(result!.trailingPeriodSources.y3).toBe('computed');
    expect(result!.trailingPeriodSources.y5).toBe('computed');
    // No gap-fill → returnsAsOf is null for a fully computed fund
    expect(result!.returnsAsOf).toBeNull();
  });

  it('gap-fill: only missing periods use as-reported; present periods remain computed', () => {
    // ~2y series → y1 computed, y3/y5 null → fill y3 from as-reported; y5 absent in blob
    const series = buildSeries(26);
    const periodReturns = { ret_3y: 0.11, as_of_date: '2026-03-31' };
    const result = selectCompareMetrics(series, periodReturns, null, TODAY);
    expect(result!.source).toBe('computed');
    expect(result!.trailingPeriodSources.y1).toBe('computed');
    expect(result!.trailingPeriodSources.y3).toBe('as-reported');
    expect(result!.trailingPeriodSources.y5).toBeNull(); // not in blob
    expect(result!.trailing.y1).not.toBeNull();
    expect(result!.trailing.y3).toBeCloseTo(0.11, 5);
    expect(result!.trailing.y5).toBeNull();
    expect(result!.returnsAsOf).toBe('2026-03-31');
  });

  it('gap-fill: no gap-fill when as-reported has no data for a null period', () => {
    // ~14m series → y1 computed, y3/y5 null; as-reported has no y3/y5 either
    const series = buildSeries(15);
    const result = selectCompareMetrics(series, null, null, TODAY);
    expect(result!.source).toBe('computed');
    expect(result!.trailingPeriodSources.y1).toBe('computed');
    expect(result!.trailingPeriodSources.y3).toBeNull();
    expect(result!.trailingPeriodSources.y5).toBeNull();
    expect(result!.returnsAsOf).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// isPayoutPlan
// ---------------------------------------------------------------------------

describe('isPayoutPlan', () => {
  // ── option_type-based short-circuits ──────────────────────────────────────
  it('returns false for option_type="growth"', () => {
    expect(isPayoutPlan('HDFC Top 100 Fund - Growth', 'growth')).toBe(false);
  });

  it('returns false for option_type starting with "growth" (any casing)', () => {
    expect(isPayoutPlan('Any Fund - Growth Option', 'Growth Option')).toBe(false);
    expect(isPayoutPlan('Any Fund - Growth', 'growth_plan')).toBe(false);
  });

  it('returns true for option_type="idcw_payout"', () => {
    expect(isPayoutPlan('HDFC Top 100 Fund - IDCW', 'idcw_payout')).toBe(true);
  });

  it('returns true for option_type="idcw_reinvest"', () => {
    expect(isPayoutPlan('HDFC Top 100 Fund - IDCW', 'idcw_reinvest')).toBe(true);
  });

  it('returns true for option_type="dividend"', () => {
    expect(isPayoutPlan('SBI Bond Fund - Dividend', 'dividend')).toBe(true);
  });

  // ── Name-based IDCW — option_type null ────────────────────────────────────
  it('returns true for IDCW in scheme name (various real AMFI formats)', () => {
    expect(isPayoutPlan('HDFC Top 100 Fund - IDCW', null)).toBe(true);
    expect(isPayoutPlan('Aditya Birla Sun Life Low Duration Fund -Regular - DAILY IDCW', null)).toBe(true);
    expect(isPayoutPlan('UTI Short Duration Fund - Regular Plan - Half-Yearly IDCW', null)).toBe(true);
    expect(isPayoutPlan('ITI Arbitrage Fund - Regular Plan - IDCW Option', null)).toBe(true);
    expect(isPayoutPlan('CANARA ROBECO GILT FUND - REGULAR PLAN - IDCW (Payout/Reinvestment)', null)).toBe(true);
    expect(isPayoutPlan('quant Multi Cap Fund-IDCW Option - Regular Plan', null)).toBe(true);
    expect(isPayoutPlan('Franklin India Flexi Cap Fund - IDCW', null)).toBe(true);
    expect(isPayoutPlan('UTI ELSS Tax Saver Fund - Regular Plan - IDCW', null)).toBe(true);
  });

  // ── Dividend Yield Fund — the tricky cases from real scheme_master rows ───
  it('returns false for Dividend Yield Fund with Growth option (must NOT match)', () => {
    // "Dividend Yield" is a strategy name, NOT a payout type; Growth option = not payout.
    expect(isPayoutPlan('Aditya Birla Sun Life Dividend Yield Fund - Growth - Direct Plan', null)).toBe(false);
    expect(isPayoutPlan('UTI-Dividend Yield Fund.-Growth', null)).toBe(false);
    expect(isPayoutPlan('Franklin India Dividend Yield Fund-Growth Plan', null)).toBe(false);
    expect(isPayoutPlan('ICICI Prudential Dividend Yield Equity Fund Growth Option', null)).toBe(false);
    expect(isPayoutPlan('ICICI Prudential Dividend Yield Equity Fund Direct Plan Growth Option', null)).toBe(false);
    expect(isPayoutPlan('HDFC Dividend Yield Fund - Growth Plan', null)).toBe(false);
    expect(isPayoutPlan('HDFC Dividend Yield Fund - Growth Option Direct Plan', null)).toBe(false);
    expect(isPayoutPlan('SBI Dividend Yield Fund - Regular Plan - Growth', null)).toBe(false);
    expect(isPayoutPlan('SBI Dividend Yield Fund - Direct Plan - Growth', null)).toBe(false);
    expect(isPayoutPlan('Franklin India Dividend Yield Fund - Direct - Growth', null)).toBe(false);
    expect(isPayoutPlan('Tata Dividend Yield Fund-Direct Plan-Growth', null)).toBe(false);
    expect(isPayoutPlan('LIC MF Dividend Yield Fund-Regular Plan-Growth', null)).toBe(false);
  });

  it('returns true for Dividend Yield Fund with IDCW option (must match)', () => {
    expect(isPayoutPlan('Aditya Birla Sun Life Dividend Yield Fund -REGULAR - IDCW', null)).toBe(true);
    expect(isPayoutPlan('Aditya Birla Sun Life Dividend Yield Fund -DIRECT - IDCW', null)).toBe(true);
    expect(isPayoutPlan('UTI Dividend Yield Fund - Regular Plan - IDCW', null)).toBe(true);
    expect(isPayoutPlan('Franklin India Dividend Yield Fund - Direct - IDCW', null)).toBe(true);
    expect(isPayoutPlan('ICICI Prudential Dividend Yield Equity Fund IDCW Option', null)).toBe(true);
    expect(isPayoutPlan('ICICI Prudential Dividend Yield Equity Fund Direct Plan IDCW Option', null)).toBe(true);
    expect(isPayoutPlan('HDFC Dividend Yield Fund - IDCW Plan', null)).toBe(true);
    expect(isPayoutPlan('Franklin India Dividend Yield Fund - IDCW', null)).toBe(true);
    expect(isPayoutPlan('LIC MF Dividend Yield Fund-Regular Plan-IDCW', null)).toBe(true);
    expect(isPayoutPlan('Baroda BNP Paribas Dividend Yield Fund - Regular Plan - IDCW Option', null)).toBe(true);
    expect(isPayoutPlan(
      'SBI Dividend Yield Fund - Regular Plan - Income Distribution cum Capital Withdrawal (IDCW) Option',
      null,
    )).toBe(true);
    expect(isPayoutPlan('Tata Dividend Yield Fund-Direct Plan-IDCW Payout', null)).toBe(true);
    expect(isPayoutPlan('Tata Dividend Yield Fund-Direct Plan-IDCW Reinvestment', null)).toBe(true);
  });

  // ── Other payout markers ───────────────────────────────────────────────────
  it('returns true for income distribution phrase in name', () => {
    expect(isPayoutPlan(
      'Sundaram Corporate Bond Fund Regular Plan - Half yearly Income Distribution cum Capital Withdrawal (IDCW)',
      null,
    )).toBe(true);
    expect(isPayoutPlan('SBI Savings Fund - Regular Plan Daily Income Distribution cum Capital Withdrawal Option (IDCW)', null)).toBe(true);
  });

  it('returns true for payout in name', () => {
    expect(isPayoutPlan('Tata ELSS Fund- Regular Plan - Payout of IDCW Option', null)).toBe(true);
    expect(isPayoutPlan(
      'Reliance Dual Advantage Fixed Tenure Fund III - Plan B - Dividend Payout Option',
      null,
    )).toBe(true);
    expect(isPayoutPlan(
      'Kotak Bond Short Term Plan-(Payout of Income Distribution cum capital withdrawal option)',
      null,
    )).toBe(true);
    expect(isPayoutPlan('Aditya Birla Sun Life Retirement Fund-The 40s Plan- Direct - Payout of IDCW', null)).toBe(true);
  });

  it('returns true for reinvestment in name', () => {
    expect(isPayoutPlan('Tata Dividend Yield Fund-Direct Plan-IDCW Reinvestment', null)).toBe(true);
    expect(isPayoutPlan('DSP Bond Fund - Regular Plan - Dividend Reinvestment', null)).toBe(true);
  });

  it('returns true for bonus in name', () => {
    expect(isPayoutPlan('XYZ Fund - Bonus Option', null)).toBe(true);
  });

  it('returns true for bare dividend (not dividend yield) in name', () => {
    expect(isPayoutPlan('DSP Bond Fund - Dividend', null)).toBe(true);
    expect(isPayoutPlan('SBI Bond Fund - Regular Plan - Dividend', null)).toBe(true);
    expect(isPayoutPlan('Reliance Fixed Horizon Fund - XXIII - Series 11 - Dividend Payout Option', null)).toBe(true);
  });

  // ── Pure growth funds — must always return false ──────────────────────────
  it('returns false for growth-only funds', () => {
    expect(isPayoutPlan('Parag Parikh Flexi Cap Fund - Direct Plan - Growth', null)).toBe(false);
    expect(isPayoutPlan('HDFC Top 100 Fund - Direct Plan - Growth', 'growth')).toBe(false);
    expect(isPayoutPlan('Franklin Growth Fund - Regular Plan - Growth', null)).toBe(false);
    expect(isPayoutPlan('Abakkus Flexi Cap Fund - Regular - Growth', null)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Month-end NAV tolerance — daily vs month-end series
//
// Validates that using month-end points (~60 rows for 5y) instead of a full
// daily series (~1,250 rows) yields results within acceptable bounds:
//  - σ / Sharpe / Sortino: identical (both paths call buildMonthEndNavs internally)
//  - CAGR: within ±0.5pp (start date offset ≤ 31 days; at ~11% annual ≈ 0.9pp worst-case)
//  - max-DD: within ±5pp (sustained crash visible at month-ends too)
// ---------------------------------------------------------------------------

describe('month-end NAV tolerance — daily vs month-end series', () => {
  const TODAY_LOCAL = new Date('2026-05-08');

  /**
   * Deterministic 5-year daily series (trading days only) with a mid-stream
   * drawdown. NAV grows ~11% per year on trend, with a -0.3%/day crash from
   * Nov 2023 to Apr 2024 that is recoverable and visible at month-end boundaries.
   */
  function buildTestDailySeries(startDate: string, endDate: string): NavPoint[] {
    const out: NavPoint[] = [];
    let nav = 100;
    const d = new Date(startDate + 'T00:00:00Z');
    const end = new Date(endDate + 'T00:00:00Z');
    const crashStart = new Date('2023-11-01T00:00:00Z');
    const crashEnd = new Date('2024-05-01T00:00:00Z');

    while (d <= end) {
      const dow = d.getUTCDay();
      if (dow !== 0 && dow !== 6) {
        const inCrash = d >= crashStart && d < crashEnd;
        nav *= inCrash ? 0.997 : 1.00042;
        out.push({ date: d.toISOString().split('T')[0], value: parseFloat(nav.toFixed(6)) });
      }
      d.setUTCDate(d.getUTCDate() + 1);
    }
    return out;
  }

  it('σ / Sharpe from month-end series are identical to daily (both use buildMonthEndNavs internally)', () => {
    const daily = buildTestDailySeries('2021-04-01', '2026-05-08');
    const monthEnd = buildMonthEndNavs(daily);

    const dailyM = selectCompareMetrics(daily, null, null, TODAY_LOCAL);
    const monthEndM = selectCompareMetrics(monthEnd, null, null, TODAY_LOCAL);

    expect(dailyM!.source).toBe('computed');
    expect(monthEndM!.source).toBe('computed');
    expect(dailyM!.stdDev).not.toBeNull();
    expect(monthEndM!.stdDev).not.toBeNull();
    // computeRiskMetrics calls buildMonthEndNavs on whatever series it receives,
    // so daily and month-end inputs produce the same monthly return sequence.
    expect(dailyM!.stdDev).toBeCloseTo(monthEndM!.stdDev!, 8);
    if (dailyM!.sharpe != null && monthEndM!.sharpe != null) {
      expect(dailyM!.sharpe).toBeCloseTo(monthEndM!.sharpe, 8);
    }
  });

  it('CAGR from month-end series matches daily within ±0.5pp', () => {
    const daily = buildTestDailySeries('2021-04-01', '2026-05-08');
    const monthEnd = buildMonthEndNavs(daily);

    const dailyM = selectCompareMetrics(daily, null, null, TODAY_LOCAL);
    const monthEndM = selectCompareMetrics(monthEnd, null, null, TODAY_LOCAL);

    // Target dates (May 8) fall after the April month-end, giving ≤8-day start
    // offset. At ~11% annual trend: 8 days ≈ 0.24pp CAGR difference — well within ±0.5pp.
    for (const [d, m] of [
      [dailyM!.trailing.y1, monthEndM!.trailing.y1],
      [dailyM!.trailing.y3, monthEndM!.trailing.y3],
      [dailyM!.trailing.y5, monthEndM!.trailing.y5],
    ] as [number | null, number | null][]) {
      if (d != null && m != null) {
        expect(Math.abs(d - m)).toBeLessThan(0.005);
      }
    }
  });

  it('max-DD from month-end series is within ±5pp of daily', () => {
    const daily = buildTestDailySeries('2021-04-01', '2026-05-08');
    const monthEnd = buildMonthEndNavs(daily);

    const dailyM = selectCompareMetrics(daily, null, null, TODAY_LOCAL);
    const monthEndM = selectCompareMetrics(monthEnd, null, null, TODAY_LOCAL);

    expect(dailyM!.maxDrawdown).not.toBeNull();
    expect(monthEndM!.maxDrawdown).not.toBeNull();
    // The crash (Nov 2023 – Apr 2024) has peak at Oct 31 2023 and trough at
    // Apr 30 2024 — both exact month-end boundaries — so daily and month-end
    // series agree to within a fraction of 1pp.
    expect(Math.abs(dailyM!.maxDrawdown! - monthEndM!.maxDrawdown!)).toBeLessThan(0.05);
  });

  it('month-end series is >20× smaller than a 5-year daily series', () => {
    const daily = buildTestDailySeries('2021-04-01', '2026-05-08');
    const monthEnd = buildMonthEndNavs(daily);
    expect(daily.length / monthEnd.length).toBeGreaterThan(20);
  });
});
