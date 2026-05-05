import {
  computeHoldingOverlap,
  computeTrailingReturn,
  findNavNearDate,
  formatTrailingReturn,
  holdingsKey,
} from '../compareFunds';
import type { HoldingItem } from '@/src/types/app';
import type { NavPoint } from '../navUtils';

const TODAY = new Date('2026-04-15T00:00:00Z');

function holding(name: string, isin = '', pct = 5): HoldingItem {
  return {
    name,
    isin,
    sector: 'Financial Services',
    marketCap: 'Large Cap',
    pctOfNav: pct,
  };
}

describe('holdingsKey', () => {
  it('prefers ISIN when available, uppercased and trimmed', () => {
    expect(holdingsKey({ isin: '  ine123a01001  ', name: 'HDFC Bank' })).toBe('INE123A01001');
  });

  it('falls back to a normalised name when ISIN is missing', () => {
    expect(holdingsKey({ isin: '', name: 'HDFC Bank Ltd.' })).toBe('hdfcbankltd');
  });

  it('treats varied case + punctuation as the same fallback key', () => {
    expect(holdingsKey({ isin: '', name: 'HDFC-Bank Ltd' }))
      .toBe(holdingsKey({ isin: '', name: 'HDFC Bank Ltd.' }));
  });
});

describe('computeHoldingOverlap', () => {
  it('returns zero overlap when either list is empty', () => {
    const a = [holding('HDFC Bank', 'INE001A01001')];
    expect(computeHoldingOverlap(a, [])).toEqual({ overlapPct: 0, matchedCount: 0, unionCount: 0 });
    expect(computeHoldingOverlap([], a)).toEqual({ overlapPct: 0, matchedCount: 0, unionCount: 0 });
    expect(computeHoldingOverlap(null, null)).toEqual({ overlapPct: 0, matchedCount: 0, unionCount: 0 });
  });

  it('computes Jaccard overlap by ISIN', () => {
    const a = [holding('A', 'INE001'), holding('B', 'INE002'), holding('C', 'INE003')];
    const b = [holding('B', 'INE002'), holding('C', 'INE003'), holding('D', 'INE004')];
    const result = computeHoldingOverlap(a, b);
    expect(result.matchedCount).toBe(2);  // B, C
    expect(result.unionCount).toBe(4);    // A, B, C, D
    expect(result.overlapPct).toBeCloseTo(50, 6);
  });

  it('falls back to normalised name when ISIN is missing', () => {
    const a = [holding('HDFC Bank Ltd.'), holding('Reliance Industries')];
    const b = [holding('hdfc-bank ltd'), holding('TCS')];
    const result = computeHoldingOverlap(a, b);
    expect(result.matchedCount).toBe(1);
    expect(result.unionCount).toBe(3);
    expect(result.overlapPct).toBeCloseTo((1 / 3) * 100, 6);
  });

  it('returns 100% when the two lists are identical', () => {
    const list = [holding('HDFC Bank', 'INE001A01001'), holding('Reliance', 'INE002A01002')];
    const result = computeHoldingOverlap(list, list);
    expect(result.matchedCount).toBe(2);
    expect(result.overlapPct).toBeCloseTo(100, 6);
  });

  it('clamps each list to topN before comparing', () => {
    const longList: HoldingItem[] = Array.from({ length: 20 }, (_, i) => holding(`Stock${i}`, `INE${i}`));
    // First 10 in `a`, last 10 in `b` — with topN=10 there is no overlap.
    const result = computeHoldingOverlap(longList, longList.slice().reverse(), 10);
    // longList[0..9] vs longList.reversed()[0..9] = longList[19..10] — disjoint
    expect(result.matchedCount).toBe(0);
    expect(result.overlapPct).toBe(0);
  });

  it('ignores entries that produce empty keys (no ISIN AND no name)', () => {
    const a = [holding('A', 'INE001'), { name: '', isin: '', sector: '', marketCap: 'Other' as const, pctOfNav: 0 }];
    const b = [holding('A', 'INE001')];
    const result = computeHoldingOverlap(a, b);
    expect(result.matchedCount).toBe(1);
    expect(result.unionCount).toBe(1);
    expect(result.overlapPct).toBe(100);
  });
});

describe('findNavNearDate', () => {
  const series: NavPoint[] = [
    { date: '2024-01-15', value: 100 },
    { date: '2024-04-15', value: 110 },
    { date: '2024-07-15', value: 115 },
  ];

  it('returns the last NAV on or before the target', () => {
    expect(findNavNearDate(series, '2024-05-01')).toEqual({ date: '2024-04-15', value: 110 });
  });

  it('returns the earliest NAV when target predates all rows', () => {
    expect(findNavNearDate(series, '2023-01-01')).toEqual({ date: '2024-01-15', value: 100 });
  });

  it('returns the latest NAV when target is after all rows', () => {
    expect(findNavNearDate(series, '2025-01-01')).toEqual({ date: '2024-07-15', value: 115 });
  });

  it('returns null for an empty series', () => {
    expect(findNavNearDate([], '2024-01-01')).toBeNull();
  });
});

describe('computeTrailingReturn', () => {
  it('computes positive CAGR for a rising series', () => {
    // 2 years, NAV doubled → CAGR = √2 - 1 ≈ 0.4142
    const series: NavPoint[] = [
      { date: '2024-04-15', value: 100 },
      { date: '2026-04-15', value: 200 },
    ];
    const cagr = computeTrailingReturn(series, 2, TODAY);
    expect(cagr).not.toBeNull();
    expect(cagr!).toBeCloseTo(Math.sqrt(2) - 1, 4);
  });

  it('computes negative CAGR when NAV fell', () => {
    const series: NavPoint[] = [
      { date: '2025-04-15', value: 100 },
      { date: '2026-04-15', value: 90 },
    ];
    const cagr = computeTrailingReturn(series, 1, TODAY);
    expect(cagr).not.toBeNull();
    expect(cagr!).toBeCloseTo(-0.1, 4);
  });

  it('returns null when the series is shorter than the requested window', () => {
    const series: NavPoint[] = [
      { date: '2025-10-01', value: 100 },
      { date: '2026-04-15', value: 110 },
    ];
    expect(computeTrailingReturn(series, 5, TODAY)).toBeNull();
  });

  it('returns null for an empty series or non-positive years', () => {
    expect(computeTrailingReturn([], 1, TODAY)).toBeNull();
    expect(computeTrailingReturn([{ date: '2025-04-15', value: 100 }], 0, TODAY)).toBeNull();
    expect(computeTrailingReturn([{ date: '2025-04-15', value: 100 }], -1, TODAY)).toBeNull();
  });

  it('returns null when start NAV is non-positive', () => {
    const series: NavPoint[] = [
      { date: '2024-04-15', value: 0 },
      { date: '2026-04-15', value: 110 },
    ];
    expect(computeTrailingReturn(series, 2, TODAY)).toBeNull();
  });
});

describe('formatTrailingReturn', () => {
  it('renders positive values with a + sign and one decimal', () => {
    expect(formatTrailingReturn(0.1234)).toBe('+12.3%');
  });

  it('renders negative values with the minus baked in', () => {
    expect(formatTrailingReturn(-0.0567)).toBe('-5.7%');
  });

  it('renders zero with a + sign for visual symmetry', () => {
    expect(formatTrailingReturn(0)).toBe('+0.0%');
  });

  it('renders null as em-dash', () => {
    expect(formatTrailingReturn(null)).toBe('—');
  });
});
