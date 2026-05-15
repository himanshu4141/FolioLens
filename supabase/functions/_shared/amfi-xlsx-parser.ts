/**
 * Pure parser for AMFI's "Average Market Capitalization" xlsx sheet.
 *
 * Each cycle the file shape is *almost* the same:
 *
 *     Row 0   Title merged across columns ("Average Market Capitalization
 *             of listed companies during the six months ended 31 December 2025")
 *     Row 1   Sometimes a date or subtitle, sometimes blank
 *     Row 2-3 Column headers: Sr. No. | Company Name | ISIN | … |
 *             Average Market Capitalization | Categorisation
 *     Row 4+  Data rows. ~750 of them.
 *
 * The previous version of the parser passed `sheet_to_json` without
 * `header: 1`, so SheetJS treated row 0 as the header. The "headers" came
 * back as `["…the six months ended 31 December 2025", "__EMPTY", "__EMPTY_1",
 * …]` and `buildHeaderMap` failed to find any of the columns it wanted.
 *
 * The fix lives in this module so it can be tested in Jest without pulling
 * the xlsx library into the test runtime. The edge function calls
 * `XLSX.utils.sheet_to_json(sheet, { header: 1 })` to get rows-as-arrays
 * and passes them to `parseAmfiRows` below.
 */

export interface AmfiStockRow {
  isin: string;
  company_name: string;
  market_cap_category: 'Large Cap' | 'Mid Cap' | 'Small Cap';
  rank: number | null;
  avg_market_cap_cr: number | null;
}

export interface BucketCounts {
  large: number;
  mid: number;
  small: number;
  total: number;
}

export interface SanityBounds {
  /** Inclusive lower bound on total row count. Coarse outer net. */
  minTotal: number;
  /** Inclusive upper bound on total row count. Coarse outer net. */
  maxTotal: number;
  /** Expected size of the Large Cap bucket — SEBI rule pins it at 100. */
  expectedLarge: number;
  /** Expected size of the Mid Cap bucket — SEBI rule pins it at 150. */
  expectedMid: number;
  /** Absolute slack applied to both `expectedLarge` and `expectedMid`. */
  bucketSlack: number;
}

export const AMFI_SANITY_BOUNDS: SanityBounds = {
  minTotal: 500,
  maxTotal: 10_000,
  expectedLarge: 100,
  expectedMid: 150,
  bucketSlack: 15,
};

/**
 * Counts rows per market-cap category. Pure helper used by the seeder
 * before sanity-checking and by the validator below for the load-bearing
 * shape assertion.
 */
export function countBuckets(rows: AmfiStockRow[]): BucketCounts {
  let large = 0;
  let mid = 0;
  let small = 0;
  for (const r of rows) {
    if (r.market_cap_category === 'Large Cap') large += 1;
    else if (r.market_cap_category === 'Mid Cap') mid += 1;
    else if (r.market_cap_category === 'Small Cap') small += 1;
  }
  return { large, mid, small, total: rows.length };
}

/**
 * Validates the parsed AMFI output before the seeder commits any writes.
 * Returns `null` on success or a human-readable error string on failure —
 * the caller assigns this to `first_error` so the workflow log surfaces it
 * verbatim. Throwing is the caller's choice (it lets the seeder tag
 * `failure_reason='sanity_check_failed'` consistently with its other
 * error paths).
 */
export function validateBucketShape(counts: BucketCounts, bounds: SanityBounds = AMFI_SANITY_BOUNDS): string | null {
  const { minTotal, maxTotal, expectedLarge, expectedMid, bucketSlack } = bounds;
  const largeLow = expectedLarge - bucketSlack;
  const largeHigh = expectedLarge + bucketSlack;
  const midLow = expectedMid - bucketSlack;
  const midHigh = expectedMid + bucketSlack;

  if (counts.total < minTotal || counts.total > maxTotal) {
    return `row count ${counts.total} outside [${minTotal}, ${maxTotal}]; buckets L=${counts.large} M=${counts.mid} S=${counts.small}`;
  }
  if (counts.large < largeLow || counts.large > largeHigh) {
    return `large_count=${counts.large} outside [${largeLow}, ${largeHigh}] (mid=${counts.mid} small=${counts.small} total=${counts.total})`;
  }
  if (counts.mid < midLow || counts.mid > midHigh) {
    return `mid_count=${counts.mid} outside [${midLow}, ${midHigh}] (large=${counts.large} small=${counts.small} total=${counts.total})`;
  }
  if (counts.small < 1) {
    return `small_count=${counts.small} suspiciously low (large=${counts.large} mid=${counts.mid} total=${counts.total})`;
  }
  return null;
}

interface ColumnMap {
  isin: number;
  company: number;
  category: number;
  rank: number | null;
  avgCap: number | null;
}

const MAX_HEADER_SCAN_ROWS = 10;
const ISIN_RE = /^IN[A-Z0-9]{10}$/;

/**
 * Parses AMFI rows (as a 2D array from SheetJS's `header: 1` option) into
 * typed stock rows. Scans the first few rows for the header row (one
 * containing "ISIN"), then position-maps every data row by header column
 * index. Skips rows whose ISIN cell doesn't match the AMFI ISIN regex
 * (handles trailing blank rows, footnotes, accidental category sub-headers).
 *
 * Throws if no header row is found within the first MAX_HEADER_SCAN_ROWS,
 * or if the header row lacks any of the three required columns
 * (ISIN, company, category).
 */
export function parseAmfiRows(rows: unknown[][]): AmfiStockRow[] {
  if (rows.length === 0) throw new Error('sheet produced zero rows');

  const { headerRowIndex, columns } = findHeaderRow(rows);
  const out: AmfiStockRow[] = [];

  for (let i = headerRowIndex + 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r) continue;
    const isin = stringCell(r[columns.isin]).toUpperCase();
    if (!ISIN_RE.test(isin)) continue;

    const categoryRaw = stringCell(r[columns.category]).toLowerCase();
    let category: AmfiStockRow['market_cap_category'];
    if (categoryRaw.includes('large')) category = 'Large Cap';
    else if (categoryRaw.includes('mid')) category = 'Mid Cap';
    else if (categoryRaw.includes('small')) category = 'Small Cap';
    else continue;

    const company = stringCell(r[columns.company]);
    const rank = columns.rank != null ? numCell(r[columns.rank]) : null;
    const avgCap = columns.avgCap != null ? numCell(r[columns.avgCap]) : null;

    out.push({
      isin,
      company_name: company || isin,
      market_cap_category: category,
      rank,
      avg_market_cap_cr: avgCap,
    });
  }

  return out;
}

/**
 * Scans the first MAX_HEADER_SCAN_ROWS rows for one that has an "ISIN"
 * cell. Returns the row index plus a column map. Throws with a useful
 * error if no row matches (the `first_error` text on `parse_failed` —
 * surfaced to the workflow log so we don't have to re-run with extra
 * logging).
 */
function findHeaderRow(rows: unknown[][]): { headerRowIndex: number; columns: ColumnMap } {
  const scanLimit = Math.min(rows.length, MAX_HEADER_SCAN_ROWS);
  for (let i = 0; i < scanLimit; i++) {
    const r = rows[i];
    if (!r) continue;
    const labels = r.map((c) => stringCell(c).toLowerCase());
    const isinCol = labels.findIndex((l) => l === 'isin');
    if (isinCol < 0) continue;

    // Found ISIN — try to map the other columns from the same row.
    const companyCol = findColumn(labels, [
      'name of the company',
      'company name',
      'company',
      'name',
    ]);
    const categoryCol = findColumn(labels, [
      'categorisation',
      'categorization',
      'category',
      'classification',
    ]);

    if (companyCol < 0 || categoryCol < 0) {
      // ISIN found but the row isn't a proper header — keep scanning in
      // case there's a later row that is.
      continue;
    }

    return {
      headerRowIndex: i,
      columns: {
        isin: isinCol,
        company: companyCol,
        category: categoryCol,
        rank: firstColumn(labels, ['sr. no.', 'sr no', 'sl. no.', 'sl no', 'rank', 'no.']),
        avgCap: firstColumn(labels, [
          'average market capitalization',
          'average market capitalisation',
          'avg market capitalization',
          'avg market capitalisation',
          'avg market cap',
          'market capitalization',
          'market capitalisation',
        ]),
      },
    };
  }
  const previewRows = rows.slice(0, scanLimit).map((r) =>
    (r ?? []).slice(0, 4).map((c) => stringCell(c)).join(' | '),
  );
  throw new Error(
    `header row with ISIN not found in first ${scanLimit} rows; preview=[${previewRows.join(' || ')}]`.slice(0, 240),
  );
}

function findColumn(labels: string[], candidates: string[]): number {
  for (const want of candidates) {
    const exact = labels.indexOf(want);
    if (exact >= 0) return exact;
  }
  for (const want of candidates) {
    const partial = labels.findIndex((l) => l.includes(want));
    if (partial >= 0) return partial;
  }
  return -1;
}

function firstColumn(labels: string[], candidates: string[]): number | null {
  const i = findColumn(labels, candidates);
  return i < 0 ? null : i;
}

function stringCell(value: unknown): string {
  if (value == null) return '';
  return String(value).trim();
}

function numCell(value: unknown): number | null {
  if (value == null || value === '') return null;
  const n = typeof value === 'number' ? value : Number(String(value).replace(/[,\s]/g, ''));
  return Number.isFinite(n) ? n : null;
}
