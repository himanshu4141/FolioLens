/**
 * Pure helpers for the sync-nav since-map: building a per-scheme latest
 * nav_date map from paginated PostgREST rows.
 *
 * Extracted so they can be unit-tested without a live Supabase connection.
 * Callers must paginate using SINCE_MAP_PAGE_SIZE to avoid the 1,000-row
 * PostgREST default cap.
 */

/** PostgREST hard cap — use as the page size when ranging nav_history. */
export const SINCE_MAP_PAGE_SIZE = 1000;

/**
 * Build a per-scheme latest nav_date map from rows returned in descending
 * nav_date order.  The first occurrence of each scheme_code is the maximum
 * date (since descending); duplicates are ignored, preserving that invariant.
 */
export function buildSchemeLatestMap(
  rows: { scheme_code: number; nav_date: string }[],
): Map<number, string> {
  const map = new Map<number, string>();
  for (const row of rows) {
    if (!map.has(row.scheme_code)) {
      map.set(row.scheme_code, row.nav_date);
    }
  }
  return map;
}
