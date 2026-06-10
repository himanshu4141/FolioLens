/**
 * Shared constants and pure helpers for the nav-retention edge function.
 *
 * Extracted here so they can be unit-tested in Jest (Node environment)
 * without requiring the Deno runtime.
 */

/** Maximum nav_history rows to delete in a single function invocation. */
export const MAX_ROWS_PER_RUN = 100_000;

/**
 * Number of scheme codes to include in each batched DELETE statement.
 * Each scheme typically has 1 000–5 000 NAV rows; 50 schemes per batch
 * keeps individual DELETE transactions comfortably under 250 k rows.
 */
export const SCHEME_DELETE_BATCH_SIZE = 50;

/** Days of retention for a demand-hydrated (non-held) scheme's NAV series. */
export const NAV_RETENTION_DAYS = 90;

/**
 * Returns the ISO-8601 cutoff timestamp: nav_backfilled_at values strictly
 * before this date are considered stale and eligible for pruning.
 *
 * @param now   Reference clock (injectable for testability).
 * @param days  Retention window in days (defaults to NAV_RETENTION_DAYS).
 */
export function retentionCutoffDate(now: Date, days: number = NAV_RETENTION_DAYS): string {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
}

/**
 * Returns true when a scheme is a candidate for NAV history pruning.
 *
 * Pruning criteria (both must hold):
 *   (a) The scheme is NOT held by any active user_fund.
 *   (b) nav_backfilled_at IS NULL (never demand-fetched) OR is strictly
 *       before cutoffDate (stale demand-fetch, outside the retention window).
 *
 * @param isHeld           Whether the scheme appears in any active user_fund.
 * @param navBackfilledAt  The scheme_master.nav_backfilled_at value (ISO-8601 string) or null.
 * @param cutoffDate       ISO-8601 boundary; backfilled_at < this value is stale.
 */
export function isPruneable(
  isHeld: boolean,
  navBackfilledAt: string | null,
  cutoffDate: string,
): boolean {
  if (isHeld) return false;
  if (navBackfilledAt === null) return true;
  return navBackfilledAt < cutoffDate;
}
