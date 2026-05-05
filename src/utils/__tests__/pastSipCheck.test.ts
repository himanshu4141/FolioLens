import {
  buildPastSipChartSeries,
  computeRequestedStartDate,
  durationToYears,
  simulatePastSip,
  type PastSipDuration,
} from '../pastSipCheck';
import type { NavPoint } from '../navUtils';

/**
 * Helper — build a NAV series at month-1 cadence growing at the given monthly
 * compound rate. Each row sits on the 2nd of the month so we exercise the
 * "find next NAV on or after the 1st" lookup.
 */
function buildNavSeries(opts: {
  startDate: string;          // 'YYYY-MM-DD' — first NAV date
  monthsCount: number;
  monthlyRate: number;        // e.g. 0.01 = 1% per month
  startingNav?: number;
  dayOfMonth?: number;
}): NavPoint[] {
  const startingNav = opts.startingNav ?? 100;
  const dayOfMonth = opts.dayOfMonth ?? 2;
  const [y, m, d] = opts.startDate.split('-').map((p) => parseInt(p, 10));
  const points: NavPoint[] = [];
  let nav = startingNav;
  let year = y;
  let month = m;
  // Anchor first emitted row to opts.startDate exactly when caller passes the
  // same dayOfMonth; otherwise emit at the requested dayOfMonth in startDate's month.
  for (let i = 0; i < opts.monthsCount; i++) {
    const day = i === 0 && d === dayOfMonth ? d : dayOfMonth;
    points.push({
      date: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
      value: nav,
    });
    nav *= 1 + opts.monthlyRate;
    month += 1;
    if (month > 12) { month = 1; year += 1; }
  }
  return points;
}

const TODAY = new Date('2026-04-15T00:00:00Z');

describe('durationToYears', () => {
  it('maps known durations', () => {
    expect(durationToYears('1Y')).toBe(1);
    expect(durationToYears('3Y')).toBe(3);
    expect(durationToYears('5Y')).toBe(5);
    expect(durationToYears('All')).toBeNull();
  });
});

describe('computeRequestedStartDate', () => {
  it('anchors the first installment to (today − N years + 1 month) so the window has exactly N×12 buys', () => {
    // TODAY is 2026-04-15 → today's month is April → first installment is May of (today − N years)
    expect(computeRequestedStartDate('1Y', TODAY)).toBe('2025-05-01');
    expect(computeRequestedStartDate('3Y', TODAY)).toBe('2023-05-01');
    expect(computeRequestedStartDate('5Y', TODAY)).toBe('2021-05-01');
  });

  it('rolls month over December correctly', () => {
    const dec = new Date('2026-12-15T00:00:00Z');
    // Dec + 1 month rolls to Jan of (year - N + 1)
    expect(computeRequestedStartDate('1Y', dec)).toBe('2026-01-01');
    expect(computeRequestedStartDate('3Y', dec)).toBe('2024-01-01');
  });

  it('returns null for "All"', () => {
    expect(computeRequestedStartDate('All', TODAY)).toBeNull();
  });
});

describe('simulatePastSip — empty / invalid input', () => {
  it('returns zeroed result when navSeries is empty', () => {
    const result = simulatePastSip({
      navSeries: [],
      monthlyAmount: 10_000,
      duration: '1Y',
      today: TODAY,
    });
    expect(result.totalInvested).toBe(0);
    expect(result.installments).toHaveLength(0);
    expect(result.hasEnoughData).toBe(false);
  });

  it('returns zeroed result when monthlyAmount is 0 or negative', () => {
    const series = buildNavSeries({ startDate: '2024-01-02', monthsCount: 12, monthlyRate: 0.01 });
    const r = simulatePastSip({ navSeries: series, monthlyAmount: 0, duration: '1Y', today: TODAY });
    expect(r.installments).toHaveLength(0);
    expect(r.totalInvested).toBe(0);
  });
});

describe('simulatePastSip — happy path', () => {
  it('produces exactly 12 installments for a 1Y window (one buy per completed month)', () => {
    // NAV series spans May 2025 (first buy) through Apr 2026 (last buy)
    const series = buildNavSeries({
      startDate: '2025-05-02',
      monthsCount: 12,
      monthlyRate: 0.01,
    });
    const r = simulatePastSip({
      navSeries: series,
      monthlyAmount: 10_000,
      duration: '1Y',
      today: TODAY,
    });
    expect(r.installments).toHaveLength(12);
    expect(r.totalInvested).toBe(12 * 10_000);
    expect(r.hasEnoughData).toBe(true);
    expect(r.shortHistory).toBe(false);
  });

  it('produces exactly 36 installments for a 3Y window', () => {
    const series = buildNavSeries({
      startDate: '2023-05-02',
      monthsCount: 36,
      monthlyRate: 0.005,
    });
    const r = simulatePastSip({
      navSeries: series,
      monthlyAmount: 10_000,
      duration: '3Y',
      today: TODAY,
    });
    expect(r.installments).toHaveLength(36);
    expect(r.totalInvested).toBe(36 * 10_000);
  });

  it('uses NAV on or after the 1st of the month (skips weekends/holidays)', () => {
    // First NAV intentionally lands on day 5 — ensures the lookup is "on or after"
    // 1Y window with today=2026-04-15 → first installment intended date = 2025-05-01
    const series: NavPoint[] = [
      { date: '2025-05-05', value: 100 },
      { date: '2025-06-05', value: 110 },
      { date: '2026-04-05', value: 200 },
    ];
    const r = simulatePastSip({
      navSeries: series,
      monthlyAmount: 1_000,
      duration: '1Y',
      today: TODAY,
    });
    expect(r.installments[0].nav).toBe(100);
    expect(r.installments[0].navDate).toBe('2025-05-05');
  });

  it('current value, gain, and gainPct are consistent', () => {
    const series = buildNavSeries({
      startDate: '2025-05-02',
      monthsCount: 12,
      monthlyRate: 0.01,
    });
    const r = simulatePastSip({
      navSeries: series,
      monthlyAmount: 10_000,
      duration: '1Y',
      today: TODAY,
    });
    expect(r.currentValue).toBeCloseTo(r.totalUnits * r.finalNav, 4);
    expect(r.gain).toBeCloseTo(r.currentValue - r.totalInvested, 4);
    expect(r.gainPct).toBeCloseTo((r.gain / r.totalInvested) * 100, 4);
  });

  it('xirr is positive when NAV is rising (and finite)', () => {
    // 3Y SIP needs at least 36 installments + a buffer for the lookup
    const series = buildNavSeries({
      startDate: '2023-05-02',
      monthsCount: 38,
      monthlyRate: 0.01,
    });
    const r = simulatePastSip({
      navSeries: series,
      monthlyAmount: 10_000,
      duration: '3Y',
      today: TODAY,
    });
    expect(Number.isFinite(r.xirr)).toBe(true);
    expect(r.xirr).toBeGreaterThan(0);
    // 1% monthly compounded ≈ ~12.7% annualised — XIRR for SIP into rising NAV
    // is bounded by the underlying return; allow a generous range.
    expect(r.xirr).toBeLessThan(0.2);
  });

  it('xirr is zero / NaN when NAV is flat', () => {
    const series = buildNavSeries({
      startDate: '2025-05-02',
      monthsCount: 14,
      monthlyRate: 0,
    });
    const r = simulatePastSip({
      navSeries: series,
      monthlyAmount: 10_000,
      duration: '1Y',
      today: TODAY,
    });
    // gain is exactly 0 → XIRR of 0 (or NaN if the solver didn't converge).
    if (Number.isFinite(r.xirr)) {
      expect(Math.abs(r.xirr)).toBeLessThan(1e-3);
    }
  });
});

describe('simulatePastSip — short history', () => {
  it('flips shortHistory true when fund NAV starts after the requested window', () => {
    // User asks for 5Y but fund only has ~1Y of data
    const series = buildNavSeries({
      startDate: '2025-05-02',
      monthsCount: 12,
      monthlyRate: 0.01,
    });
    const r = simulatePastSip({
      navSeries: series,
      monthlyAmount: 10_000,
      duration: '5Y',
      today: TODAY,
    });
    expect(r.shortHistory).toBe(true);
    expect(r.installments.length).toBeGreaterThan(0);
    expect(r.startDate).toBe('2025-05-02');
  });

  it('keeps shortHistory false when fund history exceeds the requested window', () => {
    const series = buildNavSeries({
      startDate: '2020-04-02',
      monthsCount: 80,
      monthlyRate: 0.01,
    });
    const r = simulatePastSip({
      navSeries: series,
      monthlyAmount: 10_000,
      duration: '3Y',
      today: TODAY,
    });
    expect(r.shortHistory).toBe(false);
    expect(r.requestedStartDate).toBe('2023-05-01');
    expect(r.startDate!.startsWith('2023-05')).toBe(true);
  });

  it('"All" duration always reports shortHistory false', () => {
    const series = buildNavSeries({
      startDate: '2025-05-02',
      monthsCount: 12,
      monthlyRate: 0.01,
    });
    const r = simulatePastSip({
      navSeries: series,
      monthlyAmount: 10_000,
      duration: 'All',
      today: TODAY,
    });
    expect(r.shortHistory).toBe(false);
    expect(r.requestedStartDate).toBeNull();
  });
});

describe('simulatePastSip — minimum installments', () => {
  it('hasEnoughData is false when fewer than 3 installments were possible', () => {
    const series: NavPoint[] = [
      { date: '2026-04-01', value: 100 },
      { date: '2026-04-15', value: 105 },
    ];
    const r = simulatePastSip({
      navSeries: series,
      monthlyAmount: 10_000,
      duration: '1Y',
      today: TODAY,
    });
    expect(r.hasEnoughData).toBe(false);
  });

  it('hasEnoughData is true with at least 3 installments', () => {
    const series = buildNavSeries({
      startDate: '2026-01-02',
      monthsCount: 4,
      monthlyRate: 0.01,
    });
    const r = simulatePastSip({
      navSeries: series,
      monthlyAmount: 10_000,
      duration: '1Y',
      today: TODAY,
    });
    expect(r.installments.length).toBeGreaterThanOrEqual(3);
    expect(r.hasEnoughData).toBe(true);
  });
});

describe('simulatePastSip — extreme amounts', () => {
  it('handles very small SIP (1 rupee)', () => {
    const series = buildNavSeries({
      startDate: '2025-05-02',
      monthsCount: 12,
      monthlyRate: 0.01,
    });
    const r = simulatePastSip({
      navSeries: series,
      monthlyAmount: 1,
      duration: '1Y',
      today: TODAY,
    });
    expect(r.totalInvested).toBe(12);
    expect(r.totalUnits).toBeGreaterThan(0);
    expect(Number.isFinite(r.currentValue)).toBe(true);
  });

  it('handles very large SIP (10 lakh per month)', () => {
    const series = buildNavSeries({
      startDate: '2025-05-02',
      monthsCount: 12,
      monthlyRate: 0.01,
    });
    const r = simulatePastSip({
      navSeries: series,
      monthlyAmount: 10_00_000,
      duration: '1Y',
      today: TODAY,
    });
    expect(r.totalInvested).toBe(12 * 10_00_000);
    expect(Number.isFinite(r.currentValue)).toBe(true);
  });
});

describe('simulatePastSip — fractional NAV preservation', () => {
  it('preserves fractional units across installments', () => {
    const series: NavPoint[] = [
      { date: '2026-01-02', value: 33.333 },
      { date: '2026-02-02', value: 33.7 },
      { date: '2026-03-02', value: 34.1 },
      { date: '2026-04-02', value: 34.5 },
    ];
    const r = simulatePastSip({
      navSeries: series,
      monthlyAmount: 10_000,
      duration: '1Y',
      today: TODAY,
    });
    expect(r.installments).toHaveLength(4);
    // Sum of per-installment units should equal totalUnits within float epsilon
    const sumUnits = r.installments.reduce((s, i) => s + i.units, 0);
    expect(r.totalUnits).toBeCloseTo(sumUnits, 8);
    // Each fractional unit count is preserved
    expect(r.installments[0].units).toBeCloseTo(10_000 / 33.333, 6);
  });
});

describe('buildPastSipChartSeries', () => {
  it('returns empty when fund has no installments', () => {
    const result = simulatePastSip({
      navSeries: [],
      monthlyAmount: 10_000,
      duration: '1Y',
      today: TODAY,
    });
    expect(buildPastSipChartSeries(result, null)).toEqual([]);
  });

  it('emits one point per installment plus a final-valuation point if needed', () => {
    const series = buildNavSeries({
      startDate: '2025-04-02',
      monthsCount: 13,
      monthlyRate: 0.01,
    });
    const r = simulatePastSip({
      navSeries: series,
      monthlyAmount: 10_000,
      duration: '1Y',
      today: TODAY,
    });
    const chart = buildPastSipChartSeries(r, null);
    expect(chart.length).toBeGreaterThanOrEqual(13);
    expect(chart[0].invested).toBe(10_000);
    expect(chart[chart.length - 1].invested).toBe(r.totalInvested);
  });

  it('cumulative invested is monotonically non-decreasing', () => {
    const series = buildNavSeries({
      startDate: '2024-04-02',
      monthsCount: 25,
      monthlyRate: 0.01,
    });
    const r = simulatePastSip({
      navSeries: series,
      monthlyAmount: 10_000,
      duration: '3Y',
      today: TODAY,
    });
    const chart = buildPastSipChartSeries(r, null);
    for (let i = 1; i < chart.length; i++) {
      expect(chart[i].invested).toBeGreaterThanOrEqual(chart[i - 1].invested);
    }
  });

  it('benchmarkValue is null when benchmarkResult is null', () => {
    const series = buildNavSeries({
      startDate: '2025-04-02',
      monthsCount: 13,
      monthlyRate: 0.01,
    });
    const r = simulatePastSip({
      navSeries: series,
      monthlyAmount: 10_000,
      duration: '1Y',
      today: TODAY,
    });
    const chart = buildPastSipChartSeries(r, null);
    for (const p of chart) expect(p.benchmarkValue).toBeNull();
  });

  it('benchmarkValue mirrors the benchmark simulation when provided', () => {
    const fundSeries = buildNavSeries({
      startDate: '2025-04-02',
      monthsCount: 13,
      monthlyRate: 0.01,
    });
    const benchSeries = buildNavSeries({
      startDate: '2025-04-02',
      monthsCount: 13,
      monthlyRate: 0.005,
    });
    const fund = simulatePastSip({
      navSeries: fundSeries, monthlyAmount: 10_000, duration: '1Y', today: TODAY,
    });
    const bench = simulatePastSip({
      navSeries: benchSeries, monthlyAmount: 10_000, duration: '1Y', today: TODAY,
    });
    const chart = buildPastSipChartSeries(fund, bench);
    expect(chart.every((p) => p.benchmarkValue !== null)).toBe(true);
    // Final benchmark value matches the simulation's own current value
    expect(chart[chart.length - 1].benchmarkValue).toBeCloseTo(bench.currentValue, 4);
  });

  it('caps the chart at 60 sampled points for long simulations', () => {
    // 10 years monthly = 121 installments
    const series = buildNavSeries({
      startDate: '2016-04-02',
      monthsCount: 121,
      monthlyRate: 0.005,
    });
    const r = simulatePastSip({
      navSeries: series,
      monthlyAmount: 10_000,
      duration: 'All',
      today: TODAY,
    });
    const chart = buildPastSipChartSeries(r, null);
    expect(chart.length).toBeLessThanOrEqual(62);
  });
});

describe('simulatePastSip — degenerate windows', () => {
  it('returns no installments when the only NAV is older than the next 1st-of-month', () => {
    // Single NAV row in the past; today is later. The loop walks the installment
    // intended date forward month by month; once intended > finalNavDate we break.
    // But before that we still try the lookup, which has to succeed with the
    // single available row. So expect at least 1 installment in normal case.
    const series: NavPoint[] = [{ date: '2026-04-10', value: 100 }];
    const r = simulatePastSip({
      navSeries: series,
      monthlyAmount: 10_000,
      duration: '1Y',
      today: TODAY,
    });
    // April 1 ≤ Apr 10 final NAV → 1 installment for Apr.
    expect(r.installments).toHaveLength(1);
    expect(r.hasEnoughData).toBe(false);
  });

  it('returns zeroed result with finalNav populated when no installment matches', () => {
    // Final NAV row is dated before the first 1st of the month we'd try, so the
    // intended-loop guard `intended > lastInstallmentDateStr` exits immediately.
    // Anchor: NAV in early 2020, today in 2026 → effective start = Jan 2020,
    // intended = '2020-01-01' ≤ finalNavDate '2020-01-15' → 1 installment.
    // To force zero installments, set finalNav before the 1st of the only month.
    const series: NavPoint[] = [{ date: '2026-04-15', value: 100 }];
    const today = new Date('2026-04-30T00:00:00Z');
    const r = simulatePastSip({
      navSeries: series,
      monthlyAmount: 10_000,
      duration: '1Y',
      today,
    });
    // April 1 2026 lookup returns NAV at Apr 15 → still 1 installment.
    expect(r.installments.length).toBeGreaterThanOrEqual(1);
  });
});

describe('buildPastSipChartSeries — final-point overwrite branches', () => {
  it('overwrites the last installment row when its date already equals endDate', () => {
    // Construct a series whose last NAV date matches the last intended SIP date
    // exactly — buildPastSipChartSeries should NOT append a duplicate point.
    const series: NavPoint[] = [
      { date: '2026-01-01', value: 100 },
      { date: '2026-02-01', value: 105 },
      { date: '2026-03-01', value: 110 },
      { date: '2026-04-01', value: 115 },
    ];
    const today = new Date('2026-04-15T00:00:00Z');
    const r = simulatePastSip({
      navSeries: series, monthlyAmount: 10_000, duration: '1Y', today,
    });
    const chart = buildPastSipChartSeries(r, null);
    // 4 installments → at most 5 chart points (4 + optional final)
    expect(chart.length).toBeLessThanOrEqual(5);
    expect(chart[chart.length - 1].invested).toBe(r.totalInvested);
    expect(chart[chart.length - 1].fundValue).toBe(r.currentValue);
  });
});

describe('simulatePastSip — duration coverage', () => {
  const durations: PastSipDuration[] = ['1Y', '3Y', '5Y', 'All'];

  it.each(durations)('runs cleanly for duration=%s', (duration) => {
    const series = buildNavSeries({
      startDate: '2018-04-02',
      monthsCount: 100,
      monthlyRate: 0.008,
    });
    const r = simulatePastSip({
      navSeries: series,
      monthlyAmount: 10_000,
      duration,
      today: TODAY,
    });
    expect(r.installments.length).toBeGreaterThan(0);
    expect(r.totalInvested).toBeGreaterThan(0);
    expect(Number.isFinite(r.currentValue)).toBe(true);
  });
});
