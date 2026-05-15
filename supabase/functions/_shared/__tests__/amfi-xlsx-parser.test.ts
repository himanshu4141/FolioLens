import { parseAmfiRows } from '../amfi-xlsx-parser';

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

  it('parses a realistic ~750-row shape end to end', () => {
    const rows: unknown[][] = [titleRow, headerRow];
    for (let i = 0; i < 100; i++) {
      rows.push(dataRow(i + 1, `Large ${i}`, `INE${String(i).padStart(3, '0')}L00000`, 1000000 - i, 'Large Cap'));
    }
    for (let i = 0; i < 150; i++) {
      rows.push(dataRow(101 + i, `Mid ${i}`, `INE${String(i).padStart(3, '0')}M00000`, 500000 - i, 'Mid Cap'));
    }
    for (let i = 0; i < 500; i++) {
      rows.push(dataRow(251 + i, `Small ${i}`, `INE${String(i).padStart(3, '0')}S00000`, 100000 - i, 'Small Cap'));
    }
    const out = parseAmfiRows(rows);
    expect(out.filter((r) => r.market_cap_category === 'Large Cap')).toHaveLength(100);
    expect(out.filter((r) => r.market_cap_category === 'Mid Cap')).toHaveLength(150);
    expect(out.filter((r) => r.market_cap_category === 'Small Cap')).toHaveLength(500);
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
