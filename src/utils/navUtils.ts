/**
 * Pure nav-related utilities — no React Native or Supabase dependencies.
 * These are extracted here so they can be unit-tested in a Node environment.
 */

export type TimeWindow = '1M' | '3M' | '6M' | '1Y' | '3Y' | '5Y' | '10Y' | '15Y' | 'All';

export interface NavPoint {
  date: string;
  value: number;
}

/**
 * Filter any date-keyed series to a given time window.
 *
 * If the filtered result is empty (e.g. NAV data is older than the cutoff),
 * falls back to the full history so the chart always has something to render.
 */
export function filterToWindow<T extends { date: string }>(history: T[], window: TimeWindow): T[] {
  if (window === 'All' || history.length === 0) return history;

  const today = new Date();
  const cutoff = new Date(today);

  switch (window) {
    case '1M': cutoff.setMonth(today.getMonth() - 1); break;
    case '3M': cutoff.setMonth(today.getMonth() - 3); break;
    case '6M': cutoff.setMonth(today.getMonth() - 6); break;
    case '1Y': cutoff.setFullYear(today.getFullYear() - 1); break;
    case '3Y': cutoff.setFullYear(today.getFullYear() - 3); break;
    case '5Y': cutoff.setFullYear(today.getFullYear() - 5); break;
    case '10Y': cutoff.setFullYear(today.getFullYear() - 10); break;
    case '15Y': cutoff.setFullYear(today.getFullYear() - 15); break;
  }

  const cutoffStr = cutoff.toISOString().split('T')[0];
  const filtered = history.filter((p) => p.date >= cutoffStr);
  // Fallback: if no data within the requested window, show all available data
  return filtered.length > 0 ? filtered : history;
}

/**
 * Count business days (Mon–Fri) between two date strings (inclusive of start, exclusive of end).
 * Does not account for public holidays — weekends only.
 */
function businessDaysBetween(fromDateStr: string, toDateStr: string): number {
  const from = new Date(fromDateStr);
  const to = new Date(toDateStr);
  let count = 0;
  const cur = new Date(from);
  // Move one day past `from` so we count days elapsed, not including the NAV date itself
  cur.setDate(cur.getDate() + 1);
  while (cur <= to) {
    const dow = cur.getDay(); // 0=Sun, 6=Sat
    if (dow !== 0 && dow !== 6) count++;
    cur.setDate(cur.getDate() + 1);
  }
  return count;
}

/**
 * Compute NAV staleness relative to today.
 *
 * Uses business-day counting so weekend gaps don't trigger false stale warnings.
 * NAV from last Friday is still fresh on Saturday, Sunday, and Monday morning.
 *
 * stale:     >1 business day since last NAV (missed a trading day)
 * veryStale: >3 business days since last NAV
 * critical:  >60 business days since last NAV (~3 calendar months — almost
 *            certainly a broken NAV ingestion or a delisted scheme; warrants
 *            a loud red visual rather than the subtle gray "as of …" label)
 */
export function navStaleness(latestNavDate: string | null): {
  label: string;
  stale: boolean;
  veryStale: boolean;
  critical: boolean;
} {
  if (!latestNavDate) return { label: '', stale: false, veryStale: false, critical: false };
  const today = new Date().toISOString().split('T')[0];
  if (latestNavDate >= today) return { label: 'today', stale: false, veryStale: false, critical: false };
  const bizDays = businessDaysBetween(latestNavDate, today);
  const [, month, day] = latestNavDate.split('-');
  const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const label = `as of ${parseInt(day, 10)} ${MONTH_ABBR[parseInt(month, 10) - 1]}`;
  return { label, stale: bizDays > 1, veryStale: bizDays > 3, critical: bizDays > 60 };
}

/**
 * Returns true when a scheme should be rendered as "Matured / Closed".
 *
 * Two detection signals are ORed together:
 *   1. scheme_active === false — explicit OpenFolio / universe-backfill signal
 *      that the scheme is wound-up or merged.
 *   2. AMFI name contains a maturity-date pattern ("Mat Dt.DD-Mon-YYYY"),
 *      common for close-ended FMPs that predate OpenFolio's coverage.
 *
 * Treat null / undefined as "unknown" (not matured) so that schemes whose
 * scheme_active hasn't been synced yet don't get incorrectly badged.
 */
export function isMaturedScheme(
  schemeActive: boolean | null | undefined,
  schemeName: string,
): boolean {
  if (schemeActive === false) return true;
  if (schemeActive === true) return false; // explicit registry signal overrides name heuristic
  return /\bMat(?:urity)?\s*Dt[\.\s]/i.test(schemeName);
}

/** Index a series to 100 at its first point (for relative comparison charts) */
export function indexTo100(history: NavPoint[]): NavPoint[] {
  if (history.length === 0) return [];
  const base = history[0].value;
  if (base === 0) return history;
  return history.map((p) => ({ date: p.date, value: (p.value / base) * 100 }));
}
