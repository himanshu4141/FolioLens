/**
 * Pure helper for summarising the per-symbol results of a CDN snapshot
 * regeneration run.
 *
 * `regenerate-index-snapshots` writes one snapshot file per benchmark
 * symbol; per-symbol failures don't block siblings (the previous file
 * stays in place, served via Supabase Storage's CDN with a SWR
 * window). The PostHog `snapshot_regenerated` event then needs a
 * single property the dashboard can alert on for the catastrophic
 * case where *every* symbol failed in the same run — that's a clear
 * "snapshots are flat-stale across the board until someone fixes it"
 * signal.
 *
 * Returns:
 *   - `outcome: 'success'`  → every symbol OK.
 *   - `outcome: 'partial'`  → at least one failed but not all.
 *   - `outcome: 'failure'`  → every symbol failed.
 *   - `failedSymbols`       → list of failed symbols (always present;
 *                              empty array on full success).
 *
 * Suggested alert: `event = 'snapshot_regenerated' AND
 * properties.outcome = 'failure'` for ANY single run pages on-call;
 * `outcome = 'partial'` is review-on-Monday severity (the SWR window
 * keeps the previous good blob serving).
 */

export interface SnapshotResultLike {
  symbol: string;
  ok: boolean;
}

export interface SnapshotOutcome {
  outcome: 'success' | 'partial' | 'failure';
  failedSymbols: string[];
}

export function summariseSnapshotOutcome(results: SnapshotResultLike[]): SnapshotOutcome {
  const failedSymbols = results.filter((r) => !r.ok).map((r) => r.symbol);
  if (failedSymbols.length === 0) return { outcome: 'success', failedSymbols };
  if (failedSymbols.length === results.length) return { outcome: 'failure', failedSymbols };
  return { outcome: 'partial', failedSymbols };
}
