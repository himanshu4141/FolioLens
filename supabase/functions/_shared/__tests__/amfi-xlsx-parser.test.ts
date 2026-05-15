import {
  AMFI_SANITY_BOUNDS,
  countBuckets,
  isCachedMapStillValid,
  parseAmfiRows,
  validateBucketShape,
  type AmfiStockRow,
} from '../amfi-xlsx-parser';

// AMFI's actual sheet shape (Dec 2025 cycle, paraphrased from the workflow
// failure log): row 0 is the title, rows 1-2 are blank/subtitle, row 3 is
// the column headers, data starts row 4.
const titleRow = [
  'Average Market Capitalization of listed companies during the six months ended 31 December 2025',
  null, null, null, null, null, null, null,
];
const headerRow = [
  'Sr. No.',
  'Company Name',
  'ISIN',
  'BSE Symbol',
  'NSE Symbol',
  'Average Market Capitalization (in Rs Lakhs)',
  'Categorisation',
];

function dataRow(
  rank: number, company: string, isin: string, avgCap: number, category: string,
): unknown[] {
  return [rank, company, isin, '', '', avgCap, category];
}

describe('parseAmfiRows', () => {
  it('throws on empty input', () => {
    expect(() => parseAmfiRows([])).toThrow(/zero rows/);
  });

  it('throws with a useful preview when no header row contains ISIN', () => {
    expect(() => parseAmfiRows([titleRow, [null, null, null]])).toThrow(/header row with ISIN not found/);
  });

  it('skips the title row and parses data starting from after the header', () => {
    const rows = [
      titleRow,
      headerRow,
      dataRow(1, 'Reliance Industries Ltd', 'INE002A01018', 1850000000, 'Large Cap'),
      dataRow(2, 'TCS Ltd', 'INE467B01029', 1400000000, 'Large Cap'),
      dataRow(101, 'Cummins India', 'INE298A01020', 320000000, 'Mid Cap'),
      dataRow(251, 'Some Small Co', 'INE111A01010', 50000000, 'Small Cap'),
    ];
    const out = parseAmfiRows(rows);
    expect(out).toHaveLength(4);
    expect(out[0]).toEqual({
      isin: 'INE002A01018',
      company_name: 'Reliance Industries Ltd',
      market_cap_category: 'Large Cap',
      rank: 1,
      avg_market_cap_cr: 1850000000,
    });
    expect(out[2].market_cap_category).toBe('Mid Cap');
    expect(out[3].market_cap_category).toBe('Small Cap');
  });

  it('tolerates leading blank rows before the header', () => {
    const rows = [
      titleRow,
      [null, null],
      [null, null, null, null, null, null, null],
      headerRow,
      dataRow(1, 'HDFC Bank', 'INE040A01034', 1600000000, 'Large Cap'),
    ];
    expect(parseAmfiRows(rows)[0].isin).toBe('INE040A01034');
  });

  it('skips data rows whose ISIN is not in the AMFI format (footnotes, etc.)', () => {
    const rows = [
      titleRow,
      headerRow,
      dataRow(1, 'HDFC Bank', 'INE040A01034', 1600000000, 'Large Cap'),
      ['', 'Footnote: foo bar baz', '', null, null, null, null],
      [null, null, null, null, null, null, null],
      dataRow(2, 'Infosys', 'INE009A01021', 700000000, 'Large Cap'),
    ];
    const out = parseAmfiRows(rows);
    expect(out.map((r) => r.isin)).toEqual(['INE040A01034', 'INE009A01021']);
  });

  it('skips rows whose category cell does not match a known bucket', () => {
    const rows = [
      titleRow,
      headerRow,
      dataRow(1, 'HDFC Bank', 'INE040A01034', 1600000000, 'Large Cap'),
      dataRow(2, 'Weird', 'INE999X99999', 1, 'Special-situations'),
    ];
    expect(parseAmfiRows(rows).map((r) => r.isin)).toEqual(['INE040A01034']);
  });

  it('uppercases ISIN and trims whitespace', () => {
    const rows = [
      titleRow,
      headerRow,
      [1, 'HDFC Bank', '  ine040a01034  ', '', '', 1600000000, 'Large Cap'],
    ];
    expect(parseAmfiRows(rows)[0].isin).toBe('INE040A01034');
  });

  it('falls back to ISIN when company column is blank', () => {
    const rows = [
      titleRow,
      headerRow,
      [1, '', 'INE040A01034', '', '', 1600000000, 'Large Cap'],
    ];
    expect(parseAmfiRows(rows)[0].company_name).toBe('INE040A01034');
  });

  it('returns null rank / avgCap when those columns are missing from the header', () => {
    const rows = [
      ['ISIN', 'Company Name', 'Categorisation'],
      ['INE040A01034', 'HDFC Bank', 'Large Cap'],
    ];
    const out = parseAmfiRows(rows);
    expect(out[0]).toEqual({
      isin: 'INE040A01034',
      company_name: 'HDFC Bank',
      market_cap_category: 'Large Cap',
      rank: null,
      avg_market_cap_cr: null,
    });
  });

  it('handles American "Categorization" spelling', () => {
    const rows = [
      ['ISIN', 'Company Name', 'Categorization'],
      ['INE040A01034', 'HDFC Bank', 'Large Cap'],
    ];
    expect(parseAmfiRows(rows)[0].market_cap_category).toBe('Large Cap');
  });

  it('finds columns by partial match when an exact label is not present', () => {
    const rows = [
      // Real AMFI 2025-cycle headers use "Average Market Capitalization (in Rs Lakhs)"
      // — exact match on "average market capitalization" fails because of the suffix;
      // partial match should still pick the right column.
      ['Sr. No.', 'Company Name', 'ISIN', 'Average Market Capitalization (in Rs Lakhs)', 'Categorisation'],
      [1, 'HDFC Bank', 'INE040A01034', 16000.5, 'Large Cap'],
    ];
    const out = parseAmfiRows(rows);
    expect(out[0].avg_market_cap_cr).toBe(16000.5);
  });

  it('parses numeric strings with commas in the avg cap column', () => {
    const rows = [
      ['ISIN', 'Company Name', 'Categorisation', 'Average Market Capitalization'],
      ['INE040A01034', 'HDFC Bank', 'Large Cap', '16,000.50'],
    ];
    expect(parseAmfiRows(rows)[0].avg_market_cap_cr).toBe(16000.5);
  });

  it('parses a realistic ~5400-row shape (matches AMFI Dec 2025 cycle)', () => {
    // Real AMFI Dec 2025 cycle produced 5372 rows. SEBI rule fixes the
    // first two buckets (Top 100 = Large, ranks 101-250 = Mid); everything
    // else falls into Small (unbounded). This shape is what the seeder
    // must accept in prod.
    const rows: unknown[][] = [titleRow, headerRow];
    for (let i = 0; i < 100; i++) {
      rows.push(dataRow(i + 1, `Large ${i}`, `INE${String(i).padStart(3, '0')}L00000`, 1000000 - i, 'Large Cap'));
    }
    for (let i = 0; i < 150; i++) {
      rows.push(dataRow(101 + i, `Mid ${i}`, `INE${String(i).padStart(3, '0')}M00000`, 500000 - i, 'Mid Cap'));
    }
    for (let i = 0; i < 5122; i++) {
      rows.push(dataRow(251 + i, `Small ${i}`, `INE${String(i % 10000).padStart(4, '0')}S0000`, 100000 - i, 'Small Cap'));
    }
    const out = parseAmfiRows(rows);
    expect(out.filter((r) => r.market_cap_category === 'Large Cap')).toHaveLength(100);
    expect(out.filter((r) => r.market_cap_category === 'Mid Cap')).toHaveLength(150);
    expect(out.filter((r) => r.market_cap_category === 'Small Cap')).toHaveLength(5122);
    expect(out).toHaveLength(5372);
  });

  it('stops scanning after the first 10 rows', () => {
    const rows: unknown[][] = [];
    // 10 noise rows with no ISIN column
    for (let i = 0; i < 10; i++) rows.push([`Noise ${i}`, null, null]);
    rows.push(headerRow);
    rows.push(dataRow(1, 'HDFC Bank', 'INE040A01034', 1, 'Large Cap'));
    expect(() => parseAmfiRows(rows)).toThrow(/header row with ISIN not found/);
  });

  it('keeps scanning past an "ISIN" cell that is part of a broken header row', () => {
    // ISIN appears as a stray cell on row 1 but no company/category column —
    // parser should keep looking and find the real header on row 2.
    const rows = [
      titleRow,
      ['ISIN', null, null, null, null, null, null],
      headerRow,
      dataRow(1, 'HDFC Bank', 'INE040A01034', 1600000000, 'Large Cap'),
    ];
    expect(parseAmfiRows(rows)[0].isin).toBe('INE040A01034');
  });
});

// ---------------------------------------------------------------------------
// countBuckets
// ---------------------------------------------------------------------------

describe('countBuckets', () => {
  it('returns zeros for empty input', () => {
    expect(countBuckets([])).toEqual({ large: 0, mid: 0, small: 0, total: 0 });
  });

  it('counts each bucket independently', () => {
    const rows: AmfiStockRow[] = [
      { isin: 'INE040A01034', company_name: 'A', market_cap_category: 'Large Cap', rank: 1, avg_market_cap_cr: 1 },
      { isin: 'INE040A01035', company_name: 'B', market_cap_category: 'Large Cap', rank: 2, avg_market_cap_cr: 1 },
      { isin: 'INE040A01036', company_name: 'C', market_cap_category: 'Mid Cap', rank: 101, avg_market_cap_cr: 1 },
      { isin: 'INE040A01037', company_name: 'D', market_cap_category: 'Small Cap', rank: 251, avg_market_cap_cr: 1 },
      { isin: 'INE040A01038', company_name: 'E', market_cap_category: 'Small Cap', rank: 252, avg_market_cap_cr: 1 },
    ];
    expect(countBuckets(rows)).toEqual({ large: 2, mid: 1, small: 2, total: 5 });
  });
});

// ---------------------------------------------------------------------------
// validateBucketShape
// ---------------------------------------------------------------------------

describe('validateBucketShape', () => {
  // The shape that just failed in prod (Dec 2025 cycle): 100 + 150 + 5122 = 5372.
  // Previous bounds [500, 1500] rejected it; new bounds must accept it.
  it('accepts the AMFI Dec 2025 cycle shape (100 / 150 / 5122 = 5372)', () => {
    expect(validateBucketShape({ large: 100, mid: 150, small: 5122, total: 5372 }))
      .toBeNull();
  });

  it('accepts H1-2025 cycle shape (100 / 150 / ~4900)', () => {
    expect(validateBucketShape({ large: 100, mid: 150, small: 4900, total: 5150 }))
      .toBeNull();
  });

  it('accepts boundary case: Large = 100 + bucketSlack', () => {
    const slack = AMFI_SANITY_BOUNDS.bucketSlack;
    expect(validateBucketShape({ large: 100 + slack, mid: 150, small: 5000, total: 5000 + 100 + slack + 150 }))
      .toBeNull();
  });

  it('rejects when total row count is below minTotal', () => {
    const err = validateBucketShape({ large: 100, mid: 150, small: 50, total: 300 });
    expect(err).toMatch(/row count 300 outside/);
  });

  it('rejects when total row count is above maxTotal', () => {
    const err = validateBucketShape({ large: 100, mid: 150, small: 20000, total: 20250 });
    expect(err).toMatch(/row count 20250 outside/);
  });

  it('rejects when Large bucket is way off (parser column mapping likely broken)', () => {
    const err = validateBucketShape({ large: 5000, mid: 150, small: 222, total: 5372 });
    expect(err).toMatch(/large_count=5000 outside/);
  });

  it('rejects when Large bucket is below the slack window', () => {
    const slack = AMFI_SANITY_BOUNDS.bucketSlack;
    const err = validateBucketShape({ large: 100 - slack - 1, mid: 150, small: 5000, total: 5234 });
    expect(err).toMatch(/large_count=84 outside/);
  });

  it('rejects when Mid bucket is way off', () => {
    const err = validateBucketShape({ large: 100, mid: 0, small: 5272, total: 5372 });
    expect(err).toMatch(/mid_count=0 outside/);
  });

  it('rejects when Small bucket is empty (parser likely dropped most rows)', () => {
    const err = validateBucketShape({ large: 100, mid: 150, small: 0, total: 250 });
    // total=250 is below the minTotal=500 bound, so we get that error first —
    // the small-zero check is a safety net, not the primary signal.
    expect(err).toBeTruthy();
  });

  it('includes per-bucket counts in the error message for fast triage', () => {
    const err = validateBucketShape({ large: 5000, mid: 200, small: 172, total: 5372 });
    expect(err).toContain('mid=200');
    expect(err).toContain('small=172');
    expect(err).toContain('total=5372');
  });

  it('respects custom bounds', () => {
    expect(validateBucketShape(
      { large: 50, mid: 75, small: 200, total: 325 },
      { minTotal: 100, maxTotal: 1000, expectedLarge: 50, expectedMid: 75, bucketSlack: 5 },
    )).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// isCachedMapStillValid — guards against the bootstrap-race bug where an
// empty cached map survives the full TTL after the seeder later populates
// the table.
// ---------------------------------------------------------------------------

describe('isCachedMapStillValid', () => {
  const TTL = 60_000;

  it('returns false when nothing has been cached yet', () => {
    expect(isCachedMapStillValid(null, 0, 1000, TTL)).toBe(false);
  });

  it('returns false when the cached map is empty (the bootstrap-race fix)', () => {
    // Direct repro of the bug that produced the "Cap mix shown is the SEBI
    // category average" disclaimer on Compare Funds: fetch-fund-snapshot
    // was warm-started before sync-stock-market-cap ever wrote a row, so
    // the lookup map was cached as empty and stayed empty for 6 hours.
    expect(isCachedMapStillValid(new Map(), 0, 1000, TTL)).toBe(false);
  });

  it('returns true when the cached map has rows and the TTL has not expired', () => {
    const cached = new Map<string, string>([['INE040A01034', 'Large Cap']]);
    expect(isCachedMapStillValid(cached, 0, TTL - 1, TTL)).toBe(true);
  });

  it('returns false when the TTL has just expired (boundary: now - cachedAt === ttlMs)', () => {
    const cached = new Map<string, string>([['INE040A01034', 'Large Cap']]);
    expect(isCachedMapStillValid(cached, 0, TTL, TTL)).toBe(false);
  });

  it('returns false when the cached map is well past the TTL', () => {
    const cached = new Map<string, string>([['INE040A01034', 'Large Cap']]);
    expect(isCachedMapStillValid(cached, 0, TTL * 10, TTL)).toBe(false);
  });

  it('handles future-dated cachedAt sanely (now < cachedAt) by treating it as fresh', () => {
    // Edge case: clock skew between cache writer and reader. A negative
    // age is still under the TTL, so use the cache rather than retry.
    const cached = new Map<string, string>([['INE040A01034', 'Large Cap']]);
    expect(isCachedMapStillValid(cached, 1000, 500, TTL)).toBe(true);
  });
});
