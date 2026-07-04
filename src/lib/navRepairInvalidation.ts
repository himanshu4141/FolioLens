import type { QueryClient } from '@tanstack/react-query';

export interface PreservedTimelineQuery {
  inputFundKey: string;
  outputFundKey: string;
  benchmarkSymbol: string;
  window: string;
}

/**
 * NAV history is shared SQLite state. A successful repair can therefore make
 * any cached timeline for the same user stale, regardless of which fund set
 * triggered the repair. Preserve only the exact input/output tuple currently
 * being rebuilt; repair paths outside the timeline hook preserve nothing.
 */
export function evictUserTimelinesAfterNavRepair(
  queryClient: QueryClient,
  userId: string,
  preserve?: PreservedTimelineQuery,
): void {
  queryClient.removeQueries({
    predicate: (query) => {
      const key = query.queryKey;
      if (key[0] !== 'investmentTimelineInputs' || key[1] !== userId) return false;
      return !(
        preserve &&
        key[2] === preserve.inputFundKey &&
        key[3] === preserve.window
      );
    },
  });
  queryClient.removeQueries({
    predicate: (query) => {
      const key = query.queryKey;
      if (key[0] !== 'investmentVsBenchmarkTimeline' || key[1] !== userId) return false;
      return !(
        preserve &&
        key[2] === preserve.outputFundKey &&
        key[3] === preserve.benchmarkSymbol &&
        key[4] === preserve.window
      );
    },
  });
}
