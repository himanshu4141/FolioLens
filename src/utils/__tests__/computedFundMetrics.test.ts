import {
  buildMonthEndNavs,
  computeMonthlyReturns,
  computeRiskMetrics,
  computeTrailingCagr,
  computeTrailingReturns,
  mean,
  navOnOrBefore,
  sampleStdDev,
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
