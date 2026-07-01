interface TargetedBenchmarkPrefetchOptions {
  enabled: boolean;
  prefetchPortfolio: (symbol: string) => void;
  prefetchTimeline: (symbol: string) => void;
}

/**
 * Returns an event handler with no timer or mount-time side effect. Alternate
 * benchmark work can start only when the caller invokes the handler from an
 * explicit press, hover, or keyboard-focus event.
 */
export function createTargetedBenchmarkPrefetch({
  enabled,
  prefetchPortfolio,
  prefetchTimeline,
}: TargetedBenchmarkPrefetchOptions): (symbol: string) => void {
  return (symbol) => {
    if (!enabled) return;
    prefetchPortfolio(symbol);
    prefetchTimeline(symbol);
  };
}
