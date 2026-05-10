/**
 * Tests for navStaleness() — Fix 11 regression guard.
 *
 * navStaleness() drives the "as of [date]" / "today" label on fund cards
 * and the portfolio header stale banner. Tests verify correct label, stale,
 * and veryStale flags for boundary cases.
 */

import { navStaleness, filterToWindow, indexTo100, NavPoint } from '@/src/utils/navUtils';

// Freeze time to a known date for all tests
const FAKE_TODAY = new Date('2026-03-26T10:00:00.000Z');

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(FAKE_TODAY);
});

afterEach(() => {
  jest.useRealTimers();
});

describe('navStaleness()', () => {
  test('null latestNavDate → not stale, empty label', () => {
    const r = navStaleness(null);
    expect(r.stale).toBe(false);
    expect(r.veryStale).toBe(false);
    expect(r.critical).toBe(false);
    expect(r.label).toBe('');
  });

  test('latestNavDate = today → not stale, label = "today"', () => {
    const r = navStaleness('2026-03-26');
    expect(r.stale).toBe(false);
    expect(r.veryStale).toBe(false);
    expect(r.critical).toBe(false);
    expect(r.label).toBe('today');
  });

  test('latestNavDate 1 day ago → not stale (< 2 days threshold)', () => {
    const r = navStaleness('2026-03-25');
    expect(r.stale).toBe(false);
    expect(r.veryStale).toBe(false);
    expect(r.critical).toBe(false);
  });

  test('latestNavDate 2 days ago → stale but not veryStale or critical', () => {
    const r = navStaleness('2026-03-24');
    expect(r.stale).toBe(true);
    expect(r.veryStale).toBe(false);
    expect(r.critical).toBe(false);
    expect(r.label).toContain('as of');
    expect(r.label).toContain('24');
    expect(r.label).toContain('Mar');
  });

  test('latestNavDate 4 days ago → stale AND veryStale, but not critical', () => {
    const r = navStaleness('2026-03-22');
    expect(r.stale).toBe(true);
    expect(r.veryStale).toBe(true);
    expect(r.critical).toBe(false);
    expect(r.label).toContain('as of');
    expect(r.label).toContain('22');
  });

  test('latestNavDate 60 business days ago → stale and veryStale but NOT critical (boundary)', () => {
    // 60 business days ≈ 12 weeks back from 2026-03-26 (Thursday)
    // 2026-03-26 minus 12 weeks = 2026-01-01 (Thursday). businessDaysBetween counts
    // weekdays in (from, today] — 2026-01-01 to 2026-03-26 has exactly 60 weekdays.
    const r = navStaleness('2026-01-01');
    expect(r.stale).toBe(true);
    expect(r.veryStale).toBe(true);
    expect(r.critical).toBe(false);
  });

  test('latestNavDate 61 business days ago → critical (just past threshold)', () => {
    // 2025-12-31 (Wed) is 61 weekdays before 2026-03-26 (Thu).
    const r = navStaleness('2025-12-31');
    expect(r.stale).toBe(true);
    expect(r.veryStale).toBe(true);
    expect(r.critical).toBe(true);
    expect(r.label).toContain('Dec');
  });

  test('latestNavDate 6 months ago → critical (deep into broken-pipeline territory)', () => {
    const r = navStaleness('2025-09-26');
    expect(r.critical).toBe(true);
  });

  test('label uses correct month abbreviation', () => {
    const r = navStaleness('2026-01-15');
    expect(r.label).toContain('Jan');
    expect(r.label).toContain('15');
  });

  test('label strips leading zero from day', () => {
    const r = navStaleness('2026-03-05');
    expect(r.label).toContain('5 Mar');
    expect(r.label).not.toContain('05');
  });
});

// ── Weekend / business-day tests ─────────────────────────────────────────────
// Scenario: Friday NAV (2026-03-27) viewed on Sat/Sun/Mon should NOT be stale.
// Tuesday should be the first stale day.

describe('navStaleness() — weekend business-day handling', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  function freeze(dateStr: string) {
    jest.useFakeTimers();
    jest.setSystemTime(new Date(`${dateStr}T10:00:00.000Z`));
  }

  const FRIDAY_NAV = '2026-03-27'; // Friday

  test('Friday NAV viewed on Saturday → not stale (0 business days)', () => {
    freeze('2026-03-28'); // Saturday
    const r = navStaleness(FRIDAY_NAV);
    expect(r.stale).toBe(false);
    expect(r.veryStale).toBe(false);
    expect(r.critical).toBe(false);
  });

  test('Friday NAV viewed on Sunday → not stale (0 business days)', () => {
    freeze('2026-03-29'); // Sunday
    const r = navStaleness(FRIDAY_NAV);
    expect(r.stale).toBe(false);
    expect(r.veryStale).toBe(false);
    expect(r.critical).toBe(false);
  });

  test('Friday NAV viewed on Monday → not stale (1 business day)', () => {
    freeze('2026-03-30'); // Monday
    const r = navStaleness(FRIDAY_NAV);
    expect(r.stale).toBe(false);
    expect(r.veryStale).toBe(false);
    expect(r.critical).toBe(false);
  });

  test('Friday NAV viewed on Tuesday → stale (2 business days)', () => {
    freeze('2026-03-31'); // Tuesday
    const r = navStaleness(FRIDAY_NAV);
    expect(r.stale).toBe(true);
    expect(r.veryStale).toBe(false);
    expect(r.critical).toBe(false);
  });
});

// ── filterToWindow() ──────────────────────────────────────────────────────────

describe('filterToWindow()', () => {
  // Build a series with one point per month for the last 4 years
  const series: NavPoint[] = [];
  for (let y = 2022; y <= 2026; y++) {
    for (let m = 1; m <= 12; m++) {
      if (y === 2026 && m > 3) break;
      const mm = String(m).padStart(2, '0');
      series.push({ date: `${y}-${mm}-15`, value: 100 + series.length });
    }
  }

  test('returns full history for "All" window', () => {
    const result = filterToWindow(series, 'All');
    expect(result).toBe(series); // same reference
  });

  test('returns full history for empty input regardless of window', () => {
    const result = filterToWindow([], '1Y');
    expect(result).toEqual([]);
  });

  test('1M window returns only points within last month', () => {
    const result = filterToWindow(series, '1M');
    expect(result.length).toBeGreaterThan(0);
    result.forEach((p) => {
      expect(p.date >= '2026-02-26').toBe(true);
    });
  });

  test('3M window returns only points within last 3 months', () => {
    const result = filterToWindow(series, '3M');
    expect(result.length).toBeGreaterThan(0);
    result.forEach((p) => {
      expect(p.date >= '2025-12-26').toBe(true);
    });
  });

  test('6M window returns only points within last 6 months', () => {
    const result = filterToWindow(series, '6M');
    expect(result.length).toBeGreaterThan(0);
    result.forEach((p) => {
      expect(p.date >= '2025-09-26').toBe(true);
    });
  });

  test('1Y window returns only points within last year', () => {
    const result = filterToWindow(series, '1Y');
    expect(result.length).toBeGreaterThan(0);
    result.forEach((p) => {
      expect(p.date >= '2025-03-26').toBe(true);
    });
  });

  test('3Y window returns only points within last 3 years', () => {
    const result = filterToWindow(series, '3Y');
    expect(result.length).toBeGreaterThan(0);
    result.forEach((p) => {
      expect(p.date >= '2023-03-26').toBe(true);
    });
  });

  test('5Y window returns all available points when history starts inside 5 years', () => {
    const result = filterToWindow(series, '5Y');
    expect(result).toEqual(series);
  });

  test('10Y and 15Y windows keep long available history', () => {
    expect(filterToWindow(series, '10Y')).toEqual(series);
    expect(filterToWindow(series, '15Y')).toEqual(series);
  });

  test('falls back to full history when no points fit the window', () => {
    const old: NavPoint[] = [{ date: '2010-01-01', value: 50 }];
    // 1M window on data from 2010 → no points → fallback to full history
    const result = filterToWindow(old, '1M');
    expect(result).toEqual(old);
  });
});

// ── indexTo100() ──────────────────────────────────────────────────────────────

describe('indexTo100()', () => {
  test('returns empty array for empty input', () => {
    expect(indexTo100([])).toEqual([]);
  });

  test('first point value becomes 100', () => {
    const pts: NavPoint[] = [
      { date: '2025-01-01', value: 200 },
      { date: '2025-06-01', value: 300 },
    ];
    const result = indexTo100(pts);
    expect(result[0].value).toBe(100);
  });

  test('subsequent points are scaled relative to first', () => {
    const pts: NavPoint[] = [
      { date: '2025-01-01', value: 200 },
      { date: '2025-06-01', value: 300 },
      { date: '2025-12-01', value: 100 },
    ];
    const result = indexTo100(pts);
    expect(result[1].value).toBeCloseTo(150);
    expect(result[2].value).toBeCloseTo(50);
  });

  test('dates are preserved unchanged', () => {
    const pts: NavPoint[] = [
      { date: '2025-01-01', value: 50 },
      { date: '2025-07-01', value: 75 },
    ];
    const result = indexTo100(pts);
    expect(result[0].date).toBe('2025-01-01');
    expect(result[1].date).toBe('2025-07-01');
  });

  test('returns original series unchanged when base value is 0', () => {
    const pts: NavPoint[] = [{ date: '2025-01-01', value: 0 }];
    const result = indexTo100(pts);
    expect(result).toBe(pts); // same reference
  });
});
