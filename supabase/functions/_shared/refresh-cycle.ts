/**
 * Pure decision logic for the universe-backfill monthly refresh cycle.
 *
 * Bug history (the reason this module exists):
 * The original handler reset the backfill cursors (and done markers) on EVERY
 * `force=false`, `phase=both` invocation whenever a `refresh_due` marker was
 * present. Because each invocation only processes one page
 * (`PAGES_PER_INVOCATION = 1`), it never reached `done`, so the `refresh_due`
 * marker was never cleared — and the next resume run reset the cursor again.
 * The result was an infinite reset loop that pinned the backfill at page 1→2
 * for days while still reporting HTTP 200 `success: true`.
 *
 * The fix keys the cycle by month: the reset happens exactly once per monthly
 * refresh (the first `force=true` kickoff, or the first run that observes a new
 * month), after which every resume run continues from the persisted cursor.
 */
export interface FreshCycleInput {
  /** Explicit `force` flag from the request body. */
  force: boolean;
  /** Month ("YYYY-MM") of the active `refresh_due` marker, or `null` if none. */
  refreshDueMonth: string | null;
  /** Month ("YYYY-MM") of the cycle already started, or `null` if none. */
  cycleStartedMonth: string | null;
}

/**
 * Returns `true` when a `phase=both` invocation should START A FRESH cycle —
 * i.e. clear the done markers + cursors and begin the backfill from page 1.
 * Returns `false` when it should RESUME the in-progress cursor.
 */
export function shouldStartFreshCycle({
  force,
  refreshDueMonth,
  cycleStartedMonth,
}: FreshCycleInput): boolean {
  // No refresh is due → never auto-reset (ad-hoc / single-phase resume).
  if (refreshDueMonth == null) return false;
  // An explicit force always (re)starts the cycle for the due month.
  if (force) return true;
  // Otherwise reset only when this month's cycle has not been started yet.
  return cycleStartedMonth !== refreshDueMonth;
}
