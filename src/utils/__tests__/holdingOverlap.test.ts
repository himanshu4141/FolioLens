import { computeHoldingOverlap, holdingsKey, type HoldingItem } from '../holdingOverlap';

describe('holdingsKey', () => {
  it('uses ISIN as primary key when present', () => {
    expect(holdingsKey({ isin: 'INE001A01036', name: 'HDFC Bank Ltd' })).toBe('isin:INE001A01036');
  });

  it('falls back to normalised name when ISIN is missing/empty', () => {
    expect(holdingsKey({ isin: null, name: 'HDFC Bank Ltd' })).toBe('name:hdfc bank ltd');
    expect(holdingsKey({ isin: '', name: 'HDFC Bank Ltd' })).toBe('name:hdfc bank ltd');
    expect(holdingsKey({ isin: undefined, name: '  HDFC   Bank   Ltd  ' })).toBe('name:hdfc bank ltd');
  });

  it('uppercases ISIN', () => {
    expect(holdingsKey({ isin: 'ine001a01036', name: 'HDFC' })).toBe('isin:INE001A01036');
  });
});

describe('computeHoldingOverlap', () => {
  const a: HoldingItem[] = [
    { isin: 'INE001A01036', name: 'HDFC Bank' },
    { isin: 'INE002A01018', name: 'Reliance' },
    { isin: null, name: 'TCS' },
  ];

  it('returns 100% for identical sets', () => {
    const result = computeHoldingOverlap(a, a);
    expect(result.intersectionCount).toBe(3);
    expect(result.unionCount).toBe(3);
    expect(result.overlapPct).toBeCloseTo(100, 6);
  });

  it('returns 0% for disjoint sets', () => {
    const b: HoldingItem[] = [
      { isin: 'INE003A01024', name: 'ICICI Bank' },
      { isin: 'INE004A01022', name: 'Infosys' },
    ];
    const result = computeHoldingOverlap(a, b);
    expect(result.intersectionCount).toBe(0);
    expect(result.overlapPct).toBe(0);
  });

  it('matches by ISIN even when name differs', () => {
    const b: HoldingItem[] = [
      { isin: 'INE001A01036', name: 'HDFC Bank Limited' }, // same ISIN, different name
      { isin: 'INE099A01099', name: 'Other' },
    ];
    const result = computeHoldingOverlap(a, b);
    expect(result.intersectionCount).toBe(1);
  });

  it('falls back to normalised-name match when ISIN absent on both sides', () => {
    const b: HoldingItem[] = [
      { isin: null, name: 'TCS' }, // matches a[2]
      { isin: 'INE099A01099', name: 'Other' },
    ];
    const result = computeHoldingOverlap(a, b);
    expect(result.intersectionCount).toBe(1);
  });

  it('returns 0% for empty sides', () => {
    expect(computeHoldingOverlap(null, a).overlapPct).toBe(0);
    expect(computeHoldingOverlap(a, null).overlapPct).toBe(0);
    expect(computeHoldingOverlap([], a).overlapPct).toBe(0);
    expect(computeHoldingOverlap(undefined, undefined).overlapPct).toBe(0);
  });

  it('computes Jaccard correctly for partial overlap', () => {
    const b: HoldingItem[] = [
      { isin: 'INE001A01036', name: 'HDFC Bank' },
      { isin: 'INE003A01024', name: 'ICICI Bank' },
    ];
    // a has 3, b has 2, intersection = 1 (HDFC Bank), union = 4 → 25%
    const result = computeHoldingOverlap(a, b);
    expect(result.intersectionCount).toBe(1);
    expect(result.unionCount).toBe(4);
    expect(result.overlapPct).toBeCloseTo(25, 4);
  });
});
